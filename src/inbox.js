import { row, rows, isDuplicateKey } from './db.js';
import { ensureAssigned, assignConversation, distributeUnassigned } from './assignment.js';
import { messagingWindow, sendText, fetchProfileName, INVALID_TOKEN } from './platforms/meta.js';
import { decryptSecret } from './secrets.js';

export class InboxError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function preview(text, attachments) {
  if (text) return text.slice(0, 120);
  return attachments.length ? `[${attachments[0].type}]` : '';
}

// Adds the customer, channel and assignee details the dashboard shows next to
// each conversation, with one query per collection rather than per row.
async function hydrateConversations(db, docs) {
  if (!docs.length) return [];
  const unique = (key) => [...new Set(docs.map((d) => d[key]).filter((v) => v != null))];
  const [contacts, channels, users] = await Promise.all([
    db.contacts.find({ _id: { $in: unique('contact_id') } }, { name: 1, external_id: 1 }).lean(),
    db.channels.find({ _id: { $in: unique('channel_id') } }, { platform: 1, name: 1 }).lean(),
    db.users.find({ _id: { $in: unique('assigned_user_id') } }, { name: 1 }).lean(),
  ]);
  const byId = (list) => new Map(list.map((d) => [d._id, d]));
  const [ct, ch, us] = [byId(contacts), byId(channels), byId(users)];
  return docs.map((c) => ({
    id: c._id,
    workspace_id: c.workspace_id,
    status: c.status,
    unread_count: c.unread_count,
    last_message_at: c.last_message_at,
    last_message_preview: c.last_message_preview,
    last_inbound_at: c.last_inbound_at,
    assigned_user_id: c.assigned_user_id,
    assigned_user_name: us.get(c.assigned_user_id)?.name ?? null,
    contact_id: c.contact_id,
    contact_name: ct.get(c.contact_id)?.name ?? null,
    contact_external_id: ct.get(c.contact_id)?.external_id ?? null,
    channel_id: c.channel_id,
    platform: ch.get(c.channel_id)?.platform ?? null,
    channel_name: ch.get(c.channel_id)?.name ?? null,
  }));
}

export function createInbox(db, config, { emit = () => {}, fetchImpl } = {}) {
  async function getConversation(id) {
    const doc = await db.conversations.findById(id).lean();
    return doc ? (await hydrateConversations(db, [doc]))[0] : null;
  }
  const getMessage = async (id) => row(await db.messages.findById(id).lean());

  async function publish(conversationId, messageId) {
    const conversation = await getConversation(conversationId);
    if (messageId) emit(conversation.workspace_id, 'message', { conversationId, message: await getMessage(messageId) });
    emit(conversation.workspace_id, 'conversation', conversation);
    return conversation;
  }

  function canAccess(user, conversation) {
    if (!conversation || conversation.workspace_id !== user.workspace_id) return false;
    if (user.role === 'owner') return true;
    return conversation.assigned_user_id === null || conversation.assigned_user_id === user.id;
  }

  async function requireConversation(user, id) {
    const conversation = Number.isInteger(id) ? await getConversation(id) : null;
    if (!canAccess(user, conversation)) throw new InboxError(404, 'Conversation not found');
    return conversation;
  }

  // contactId -> time of the last failed lookup, so a broken token or a
  // private profile is not asked about on every message.
  const failedLookups = new Map();
  const RETRY_MS = 60 * 60_000;

  async function lookupName(contactId) {
    const contact = await db.contacts.findById(contactId).lean();
    if (!contact || contact.name) return null;
    const channel = await db.channels.findById(contact.channel_id, { platform: 1, access_token: 1 }).lean();
    if (!channel || !['messenger', 'instagram'].includes(channel.platform)) return null;
    if (!channel.access_token || config.dryRun) return null;
    if (Date.now() - (failedLookups.get(contactId) ?? 0) < RETRY_MS) return null;
    try {
      const name = await fetchProfileName({
        platform: channel.platform,
        userId: contact.external_id,
        accessToken: decryptSecret(channel.access_token, config.tokenKey),
        graphVersion: config.meta.graphVersion,
        fetchImpl,
      });
      if (!name) throw new Error('profile has no name');
      await db.contacts.updateOne({ _id: contactId, name: null }, { $set: { name } });
      failedLookups.delete(contactId);
      const conversation = await db.conversations.findOne({ contact_id: contactId }, { _id: 1 }).lean();
      if (conversation) await publish(conversation._id);
      return name;
    } catch (err) {
      failedLookups.set(contactId, Date.now());
      console.warn(`could not read ${channel.platform} profile name for contact ${contactId}: ${err.message}`);
      return null;
    }
  }

  // Inserts a message unless one with the same Meta ID is already stored.
  // Returns the new row, or null for a duplicate.
  async function insertMessage(fields) {
    try {
      return await db.insert(db.messages, fields);
    } catch (err) {
      if (isDuplicateKey(err)) return null;
      throw err;
    }
  }

  // How recent an unanswered customer message must be for an imported chat to
  // stay open; older history is filed under Closed so it doesn't flood the queue.
  const IMPORT_OPEN_DAYS = 7;

  // Stores past conversations (from Meta's Conversations API or WhatsApp
  // history sync). Safe to repeat: messages are matched on their Meta ID.
  async function importHistory(channelId, threads, { now = Date.now() } = {}) {
    const channel = await db.channels.findById(channelId).lean();
    if (!channel) return { conversations: 0, messages: 0 };
    let messageCount = 0;
    const touched = new Set();
    for (const thread of threads) {
      if (!thread.messages.length) continue;
      const { doc: contact } = await db.findOrCreate(db.contacts,
        { channel_id: channel._id, external_id: thread.contactExternalId },
        { workspace_id: channel.workspace_id, name: thread.contactName ?? null });
      // Keep a name we already have (e.g. from the business's phone contacts).
      if (!contact.name && thread.contactName) {
        await db.contacts.updateOne({ _id: contact.id, name: null }, { $set: { name: thread.contactName } });
      }
      const { doc: conversation, created } = await db.findOrCreate(db.conversations,
        { contact_id: contact.id },
        { workspace_id: channel.workspace_id, channel_id: channel._id, status: 'closed' });

      for (const m of thread.messages) {
        const stored = await insertMessage({
          conversation_id: conversation.id, direction: m.direction, text: m.text ?? '', attachments: m.attachments ?? [],
          external_id: m.messageId, status: m.direction === 'in' ? 'received' : 'sent', created_at: m.timestamp,
        });
        if (stored) messageCount += 1;
      }

      // Recompute the summary from everything stored, so imports and live messages agree.
      const [last] = await db.messages.find({ conversation_id: conversation.id }).sort({ created_at: -1, _id: -1 }).limit(1).lean();
      const [lastIn] = await db.messages.find({ conversation_id: conversation.id, direction: 'in' }, { created_at: 1 })
        .sort({ created_at: -1 }).limit(1).lean();
      const update = {
        last_message_at: last.created_at,
        last_message_preview: preview(last.text, last.attachments),
        last_inbound_at: lastIn?.created_at ?? null,
      };
      const waiting = last.direction === 'in' && now - last.created_at.getTime() < IMPORT_OPEN_DAYS * 86_400_000;
      if (created && waiting) Object.assign(update, { status: 'open', unread_count: 1 });
      await db.conversations.updateOne({ _id: conversation.id }, { $set: update });
      if (created && waiting) await ensureAssigned(db, { ...conversation, status: 'open' });
      touched.add(conversation.id);
    }
    if (touched.size) emit(channel.workspace_id, 'imported', { channelId, conversations: touched.size });
    return { conversations: touched.size, messages: messageCount };
  }

  // Names saved in the business's phone contacts beat anything else we know.
  async function setContactName(channelId, contactExternalId, name) {
    const { matchedCount } = await db.contacts.updateOne(
      { channel_id: channelId, external_id: contactExternalId }, { $set: { name } });
    if (!matchedCount) {
      const channel = await db.channels.findById(channelId, { workspace_id: 1 }).lean();
      if (channel) {
        await db.findOrCreate(db.contacts, { channel_id: channelId, external_id: contactExternalId },
          { workspace_id: channel.workspace_id, name });
      }
      return;
    }
    const contact = await db.contacts.findOne({ channel_id: channelId, external_id: contactExternalId }, { _id: 1 }).lean();
    const conversation = await db.conversations.findOne({ contact_id: contact._id }, { _id: 1 }).lean();
    if (conversation) await publish(conversation._id);
  }

  return {
    getConversation,
    canAccess,
    importHistory,
    setContactName,

    // Stores one normalized webhook message. Safe to call twice for the same
    // message because Meta retries deliveries.
    async ingestMessage(evt) {
      const channel = await db.channels.findOne({ platform: evt.platform, external_id: evt.channelExternalId }).lean();
      if (!channel) return { ignored: 'unknown_channel' };
      if (await db.messages.exists({ external_id: evt.messageId })) return { ignored: 'duplicate' };

      const { doc: contact } = await db.findOrCreate(db.contacts,
        { channel_id: channel._id, external_id: evt.contactExternalId },
        { workspace_id: channel.workspace_id, name: evt.contactName ?? null });
      // A name sent with the message is the freshest one.
      if (evt.contactName && contact.name !== evt.contactName) {
        await db.contacts.updateOne({ _id: contact.id }, { $set: { name: evt.contactName } });
      }
      const { doc: conversation } = await db.findOrCreate(db.conversations,
        { contact_id: contact.id }, { workspace_id: channel.workspace_id, channel_id: channel._id });

      const inbound = evt.direction === 'in';
      const message = await insertMessage({
        conversation_id: conversation.id, direction: evt.direction, text: evt.text, attachments: evt.attachments,
        external_id: evt.messageId, status: inbound ? 'received' : 'sent', created_at: evt.timestamp,
      });
      // Another delivery of the same message got here first.
      if (!message) return { ignored: 'duplicate' };

      const at = new Date(evt.timestamp);
      if (inbound) {
        await db.conversations.updateOne({ _id: conversation.id }, {
          $set: { status: 'open', last_message_at: at, last_inbound_at: at, last_message_preview: preview(evt.text, evt.attachments) },
          $inc: { unread_count: 1 },
        });
        await ensureAssigned(db, conversation);
      } else {
        await db.conversations.updateOne({ _id: conversation.id },
          { $set: { last_message_at: at, last_message_preview: preview(evt.text, evt.attachments) } });
      }

      const published = await publish(conversation.id, message.id);
      // Look the name up in the background so the webhook is answered quickly.
      const nameLookup = published.contact_name ? Promise.resolve(null) : lookupName(contact.id);
      return { conversation: published, message: await getMessage(message.id), nameLookup };
    },

    lookupName,

    // Fills in names for customers saved before names were looked up.
    async fillMissingNames() {
      const channels = await db.channels.find(
        { platform: { $in: ['messenger', 'instagram'] }, access_token: { $ne: '' } }, { _id: 1 }).lean();
      const contacts = await db.contacts.find({ name: null, channel_id: { $in: channels.map((c) => c._id) } }, { _id: 1 })
        .sort({ _id: -1 }).limit(500).lean();
      for (const { _id: id } of contacts) await lookupName(id);
    },

    async applyStatus({ messageId, status, error }) {
      if (!['sent', 'delivered', 'read', 'failed'].includes(status)) return;
      const message = await db.messages.findOne({ external_id: messageId }, { conversation_id: 1, status: 1 }).lean();
      // Statuses can arrive out of order; never move "read" back to "delivered".
      const rank = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 4 };
      if (!message || rank[status] <= rank[message.status]) return;
      await db.messages.updateOne({ _id: message._id }, { $set: { status, error: error ?? null } });
      await publish(message.conversation_id, message._id);
    },

    // status 'all' lists every chat; 'open'/'closed' only matter internally
    // (closed chats are old ones that are not waiting for a reply).
    async listConversations(user, { filter = 'mine', status = 'all' } = {}) {
      const where = { workspace_id: user.workspace_id };
      if (status === 'open' || status === 'closed') where.status = status;
      if (filter === 'unassigned') where.assigned_user_id = null;
      else if (filter === 'all' && user.role === 'owner') { /* everything */ }
      else where.assigned_user_id = user.id;
      const docs = await db.conversations.find(where).sort({ last_message_at: -1, _id: -1 }).limit(200).lean();
      return hydrateConversations(db, docs);
    },

    async listMessages(user, conversationId) {
      await requireConversation(user, conversationId);
      return rows(await db.messages.find({ conversation_id: conversationId }).sort({ _id: 1 }).lean());
    },

    async markRead(user, conversationId) {
      const conversation = await requireConversation(user, conversationId);
      if (conversation.assigned_user_id !== user.id && user.role !== 'owner') return conversation;
      await db.conversations.updateOne({ _id: conversationId }, { $set: { unread_count: 0 } });
      return publish(conversationId);
    },

    async sendReply(user, conversationId, text) {
      text = String(text ?? '').trim();
      if (!text) throw new InboxError(400, 'Message is empty');
      const conversation = await requireConversation(user, conversationId);
      if (conversation.assigned_user_id && conversation.assigned_user_id !== user.id && user.role !== 'owner') {
        throw new InboxError(403, `This customer is handled by ${conversation.assigned_user_name}`);
      }
      const window = messagingWindow(conversation.platform, conversation.last_inbound_at);
      if (!window.ok) throw new InboxError(422, window.reason);

      const channel = await db.channels.findById(conversation.channel_id).lean();
      const contact = row(await db.contacts.findById(conversation.contact_id).lean());

      // Whoever answers an unassigned customer keeps them from now on.
      if (!conversation.assigned_user_id) await assignConversation(db, conversationId, user.id);
      const now = new Date();
      const message = await db.insert(db.messages, {
        conversation_id: conversationId, direction: 'out', sender_user_id: user.id, text, status: 'pending', created_at: now,
      });
      await db.conversations.updateOne({ _id: conversationId },
        { $set: { last_message_at: now, last_message_preview: preview(text, []), unread_count: 0 } });
      await publish(conversationId, message.id);

      try {
        const { externalId } = await sendText({
          channel: { ...row(channel), access_token: decryptSecret(channel.access_token, config.tokenKey) },
          contact, text, tag: window.tag,
          graphVersion: config.meta.graphVersion, dryRun: config.dryRun, fetchImpl,
        });
        await db.messages.updateOne({ _id: message.id }, { $set: { status: 'sent', external_id: externalId } });
      } catch (err) {
        await db.messages.updateOne({ _id: message.id }, { $set: { status: 'failed', error: err.message } });
        if (err.code === INVALID_TOKEN) {
          await db.channels.updateOne({ _id: channel._id }, { $set: { needs_reconnect: true } });
          emit(conversation.workspace_id, 'channels', null);
        }
      }
      await publish(conversationId, message.id);
      return getMessage(message.id);
    },

    async reassign(user, conversationId, assigneeId) {
      await requireConversation(user, conversationId);
      if (assigneeId !== null) {
        const assignee = Number.isInteger(assigneeId)
          && await db.users.exists({ _id: assigneeId, workspace_id: user.workspace_id, is_active: true });
        if (!assignee) throw new InboxError(400, 'Unknown team member');
      }
      await assignConversation(db, conversationId, assigneeId);
      return publish(conversationId);
    },

    async setStatus(user, conversationId, status) {
      if (!['open', 'closed'].includes(status)) throw new InboxError(400, 'Invalid status');
      const conversation = await requireConversation(user, conversationId);
      if (user.role !== 'owner' && conversation.assigned_user_id !== user.id) {
        throw new InboxError(403, 'Only the assigned moderator can change this conversation');
      }
      await db.conversations.updateOne({ _id: conversationId }, { $set: { status } });
      return publish(conversationId);
    },

    async setOnDuty(user, online) {
      await db.users.updateOne({ _id: user.id }, { $set: { is_online: Boolean(online) } });
      const assigned = online ? await distributeUnassigned(db, user.workspace_id) : [];
      for (const id of assigned) await publish(id);
      return assigned.length;
    },
  };
}

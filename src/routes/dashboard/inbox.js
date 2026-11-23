import { Router } from 'express';
import { offersFor, offerText } from '../../dashboard/offers.js';
import { InboxError } from '../../inbox.js';
import { productCards } from '../../platforms/rich.js';
import { can, need } from '../../dashboard/permissions.js';
import { audit, escapeRegex, clampInt } from '../../dashboard/util.js';
import { setting } from '../../dashboard/settings.js';
import { stageOf } from './overview.js';
import { teamId } from '../../dashboard/brands.js';
import { pageLinker } from '../../dashboard/productPage.js';

const TABS = ['waiting', 'unread', 'open', 'done', 'spam', 'snoozed'];
const CHANNELS = ['messenger', 'instagram', 'whatsapp', 'web'];
// How long the AI stays quiet after a person takes over, unless the shop changed it (AI agent → settings).
const DEFAULT_RETURN_MIN = 30;

// Combines filters with $and, so two $or conditions (scope and snooze) never overwrite each other.
const all = (...parts) => ({ $and: parts.filter((p) => p && Object.keys(p).length) });

const idOf = (req) => {
  const n = Number(req.params.id);
  if (!Number.isSafeInteger(n)) throw new InboxError(404, 'Conversation not found');
  return n;
};

// The filter for one inbox tab. Snoozed chats leave every list until their time comes (INB-04).
export function tabFilter(tab, now = new Date()) {
  const awake = { $or: [{ snooze_until: null }, { snooze_until: { $lte: now } }] };
  switch (tab) {
    case 'waiting': return { status: 'open', spam: { $ne: true }, ai_handoff: true, ...awake };
    case 'unread': return { status: 'open', spam: { $ne: true }, unread_count: { $gt: 0 }, ...awake };
    case 'done': return { status: 'closed', spam: { $ne: true } };
    case 'spam': return { spam: true };
    case 'snoozed': return { status: 'open', spam: { $ne: true }, snooze_until: { $gt: now } };
    default: return { status: 'open', spam: { $ne: true }, ...awake };
  }
}

// AI-07: a short view of the message a customer replied to.
function quoteView(q) {
  if (!q) return null;
  const cards = q.payload?.cards ?? [];
  const audio = (q.attachments ?? []).find((a) => a.type === 'audio');
  const image = (q.attachments ?? []).some((a) => a.type === 'image');
  const text = cards.length ? cards.map((c) => c.title).join(', ') : q.kind === 'order_summary' ? 'order_summary' : audio ? (audio.transcript || 'voice') : (q.text || (image ? 'photo' : ''));
  return { id: q._id, mine: q.direction === 'out', kind: cards.length ? 'cards' : audio ? 'voice' : image && !q.text ? 'photo' : q.kind === 'order_summary' ? 'order' : 'text', text: String(text).slice(0, 160) };
}

export function mentionsIn(text, team) {
  const found = [];
  let rest = String(text);
  for (const u of [...team].sort((a, b) => b.name.length - a.name.length)) {
    const re = new RegExp(`@${escapeRegex(u.name)}(?![\\p{L}\\p{M}\\p{N}])`, 'iu');
    if (re.test(rest)) { found.push(u._id); rest = rest.replace(new RegExp(re.source, 'giu'), ' '); }
  }
  return found;
}

export function inboxRoutes(db, config, { auth, inbox, agent, emit, notify }) {
  const router = Router();

  const scopeFilter = (user, workspace, scope) => {
    if (scope === 'mine') return { assigned_user_id: user.id };
    if (!can(user, 'see_all_chats', workspace)) return { $or: [{ assigned_user_id: user.id }, { assigned_user_id: null }] };
    return {};
  };

  async function load(req, id) {
    const conv = await db.conversations.findById(id).lean();
    if (!conv || conv.workspace_id !== req.user.workspace_id) throw new InboxError(404, 'Conversation not found');
    req.workspace ??= await db.workspaces.findById(req.user.workspace_id).lean();
    if (!can(req.user, 'see_all_chats', req.workspace) && conv.assigned_user_id !== null && conv.assigned_user_id !== req.user.id) {
      throw new InboxError(404, 'Conversation not found');
    }
    return conv;
  }

  // Rows for the list: who the customer is, where they wrote, and the signals the designs show.
  async function hydrate(docs) {
    if (!docs.length) return [];
    const uniq = (k) => [...new Set(docs.map((d) => d[k]).filter((v) => v != null))];
    const [contacts, channels, users, customers] = await Promise.all([
      db.contacts.find({ _id: { $in: uniq('contact_id') } }, { name: 1, external_id: 1 }).lean(),
      db.channels.find({ _id: { $in: uniq('channel_id') } }, { platform: 1, name: 1 }).lean(),
      db.users.find({ _id: { $in: [...uniq('assigned_user_id'), ...uniq('taken_over_by')] } }, { name: 1 }).lean(),
      db.customers.find({ _id: { $in: uniq('customer_id') } }, { tags: 1, vip: 1, ai_off: 1, name: 1 }).lean(),
    ]);
    const by = (list) => new Map(list.map((d) => [d._id, d]));
    const [ct, ch, us, cu] = [by(contacts), by(channels), by(users), by(customers)];
    return docs.map((c) => {
      const channel = ch.get(c.channel_id);
      const contact = ct.get(c.contact_id);
      const customer = cu.get(c.customer_id);
      return {
        id: c._id,
        name: contact?.name || customer?.name || (channel?.platform === 'whatsapp' ? `+${contact?.external_id}` : 'Customer'),
        platform: channel?.platform ?? null,
        channelName: channel?.name ?? '',
        preview: c.last_message_preview,
        lastAt: c.last_message_at,
        lastInboundAt: c.last_inbound_at,
        unread: c.unread_count,
        status: c.status === 'closed' ? 'done' : 'open',
        needsPerson: Boolean(c.ai_handoff),
        handoffReason: c.ai_handoff_reason || '',
        waitingSince: c.ai_handoff ? c.ai_handoff_at : null,
        actNow: Boolean(c.act_now),
        aiState: c.ai_handoff ? 'human' : 'ai',
        humanUntil: c.human_until,
        takenOverBy: us.get(c.taken_over_by)?.name ?? null,
        assignedTo: c.assigned_user_id ? { id: c.assigned_user_id, name: us.get(c.assigned_user_id)?.name ?? '' } : null,
        lastReplier: c.last_replier || '',
        tags: [...new Set([...(c.tags ?? []), ...(customer?.tags ?? [])])],
        vip: Boolean(customer?.vip),
        customerId: c.customer_id,
        aiOff: Boolean(customer?.ai_off),
        spam: Boolean(c.spam), spamReason: c.spam_reason || '',
        snoozeUntil: c.snooze_until, snoozeNote: c.snooze_note || '',
        reopenedAt: c.reopened_at, doneAt: c.done_at, doneBy: c.done_by || '',
        draft: c.ai_draft ? { text: c.ai_draft.text } : null,
      };
    });
  }

  const publish = async (id) => {
    const [row] = await hydrate([await db.conversations.findById(id).lean()]);
    emit(row && (await db.conversations.findById(id, { workspace_id: 1 }).lean()).workspace_id, 'conversation', row);
    return row;
  };

  router.get('/inbox', auth, async (req, res) => {
    const ws = req.user.workspace_id;
    req.workspace = await db.workspaces.findById(ws).lean();
    const tab = TABS.includes(req.query.tab) ? req.query.tab : 'open';
    const scope = req.query.scope === 'mine' ? 'mine' : 'everyone';
    const base = { workspace_id: ws, ...scopeFilter(req.user, req.workspace, scope) };
    const channelIds = CHANNELS.includes(req.query.channel)
      ? await db.channels.distinct('_id', { workspace_id: ws, platform: req.query.channel }) : null;
    const where = all(base, tabFilter(tab), channelIds ? { channel_id: { $in: channelIds } } : null);
    if (req.query.q) {
      const re = new RegExp(escapeRegex(String(req.query.q).slice(0, 60)), 'i');
      const contactIds = await db.contacts.distinct('_id', { workspace_id: ws, name: re });
      where.$and.push({ $or: [{ contact_id: { $in: contactIds } }, { last_message_preview: re }] });
    }
    const limit = clampInt(req.query.limit, 1, 100, 50);
    const before = req.query.before ? new Date(req.query.before) : null;
    if (before && !Number.isNaN(before.getTime())) where.$and.push({ last_message_at: { $lt: before } });
    const docs = await db.conversations.find(where).sort({ act_now: -1, last_message_at: -1, _id: -1 }).limit(limit + 1).lean();

    // Counts for the tabs and channel chips use the same scope.
    const counts = {};
    await Promise.all(['waiting', 'unread', 'open', 'done', 'spam'].map(async (t) => {
      counts[t] = await db.conversations.countDocuments(all(base, tabFilter(t), channelIds ? { channel_id: { $in: channelIds } } : null));
    }));
    const channels = await db.channels.find({ workspace_id: ws }, { platform: 1 }).lean();
    const byPlatform = {};
    for (const c of channels) {
      byPlatform[c.platform] = (byPlatform[c.platform] ?? 0) + await db.conversations.countDocuments(all(base, tabFilter(tab), { channel_id: c._id }));
    }
    const commentsWaiting = await db.comments.countDocuments({ workspace_id: ws, status: 'needs_you' });
    res.json({ items: await hydrate(docs.slice(0, limit)), more: docs.length > limit, counts, channels: { ...byPlatform, comments: commentsWaiting } });
  });

  // One chat: messages, the customer side panel and suggested saved replies.
  router.get('/inbox/:id', auth, async (req, res) => {
    const conv = await load(req, idOf(req));
    const [row] = await hydrate([conv]);
    const messages = await db.messages.find({ conversation_id: conv._id }).sort({ _id: -1 }).limit(200).lean();
    const userIds = [...new Set(messages.map((m) => m.sender_user_id).filter(Boolean))];
    const quotedIds = [...new Set(messages.map((m) => m.quoted_id).filter(Boolean))];
    const quotedDocs = new Map((quotedIds.length ? await db.messages.find({ _id: { $in: quotedIds } }, { direction: 1, text: 1, kind: 1, payload: 1, attachments: 1 }).lean() : []).map((q) => [q._id, q]));
    const senders = new Map((await db.users.find({ _id: { $in: userIds } }, { name: 1 }).lean()).map((u) => [u._id, u.name]));
    const workspace = req.workspace;
    const showPhones = can(req.user, 'see_phones', workspace);

    const customer = conv.customer_id ? await db.customers.findById(conv.customer_id).lean() : null;
    const orders = customer ? await db.orders.find({ workspace_id: conv.workspace_id, customer_id: customer._id, draft: { $ne: true } }).sort({ created_at: -1 }).limit(5).lean() : [];
    const noteWhere = { $or: [{ conversation_id: conv._id }, ...(customer ? [{ customer_id: customer._id }] : [])] };
    const [notes, noteCount] = await Promise.all([db.notes.find(noteWhere).sort({ created_at: -1 }).limit(10).lean(), db.notes.countDocuments(noteWhere)]);
    const noteAuthors = new Map((await db.users.find({ _id: { $in: notes.flatMap((n) => [n.author_user_id, ...(n.mentions ?? [])]) } }, { name: 1 }).lean()).map((u) => [u._id, u.name]));
    const lastIn = messages.find((m) => m.direction === 'in');
    const saved = await db.savedReplies.find({ workspace_id: conv.workspace_id }).lean();
    const words = String(lastIn?.text ?? '').toLowerCase();
    const suggested = saved
      .map((r) => ({ r, score: [r.shortcut, ...(r.phrases ?? [])].filter((p) => p && words.includes(String(p).replace('/', '').toLowerCase())).length }))
      .sort((a, b) => b.score - a.score || (b.r.uses ?? 0) - (a.r.uses ?? 0)).slice(0, 2)
      .map(({ r }) => ({ id: r._id, shortcut: r.shortcut, text: r.text }));
    const delivered = customer?.stats?.delivered ?? 0;
    const returned = customer?.stats?.returned ?? 0;

    res.json({
      conversation: row,
      messages: messages.reverse().map((m) => ({
        id: m._id, direction: m.direction, text: m.text, attachments: m.attachments, at: m.created_at, status: m.status, error: m.error,
        byAi: Boolean(m.sent_by_ai), by: m.sender_user_id ? senders.get(m.sender_user_id) ?? '' : null, kind: m.kind || 'text', payload: m.payload,
        quoted: quoteView(quotedDocs.get(m.quoted_id)), storyReply: Boolean(m.payload?.story_reply),
      })),
      customer: customer && {
        id: customer._id, name: customer.name, phones: showPhones ? customer.phones : customer.phones.map((p) => `${p.slice(0, 3)}••••${p.slice(-3)}`),
        tags: customer.tags, vip: customer.vip, aiOff: customer.ai_off, aiOffReason: customer.ai_off_reason,
        stats: customer.stats, courierCheck: customer.courier_check, risk: customer.risk,
        summary: conv.summary || autoSummary(customer, orders),
        offers: await (async () => { const o = await offersFor(db, customer._id); return [...o.active, ...o.ended].map((x) => ({ id: x._id, text: offerText(x), code: x.code, source: x.source, endsAt: x.ends_at, used: Boolean(x.used_at), live: !x.used_at && x.ends_at > new Date() })); })(),
        record: { orders: customer.stats?.orders ?? 0, delivered, returned, rate: delivered + returned ? Math.round((delivered / (delivered + returned)) * 100) : null },
      },
      orders: orders.map((o) => ({ id: o._id, number: o.number ?? o._id, item: o.product_items?.[0]?.name ?? o.items?.[0]?.name ?? '', status: stageOf(o.status), total: o.subtotal + o.delivery_charge - (o.discount ?? 0) })),
      notes: notes.map((n) => ({ id: n._id, text: n.text, by: noteAuthors.get(n.author_user_id) ?? '', at: n.created_at, mentions: (n.mentions ?? []).filter((id) => noteAuthors.has(id)).map((id) => ({ id, name: noteAuthors.get(id) })) })),
      noteCount,
      suggested,
      aiAvailable: Boolean(agent?.status().available),
      autoReturnMin: setting(workspace, 'auto_return_min', DEFAULT_RETURN_MIN),
    });
  });

  router.post('/inbox/:id/read', auth, async (req, res) => {
    const conv = await load(req, idOf(req));
    await db.conversations.updateOne({ _id: conv._id }, { $set: { unread_count: 0 } });
    res.json(await publish(conv._id));
  });

  // Take over: the AI stays quiet in this chat until "Back to AI" or the auto-return time (HND-02/03).
  router.post('/inbox/:id/takeover', auth, need(db, 'reply'), async (req, res) => {
    const conv = await load(req, idOf(req));
    const minutes = setting(req.workspace, 'auto_return_min', DEFAULT_RETURN_MIN);
    await db.conversations.updateOne({ _id: conv._id }, { $set: {
      ai_handoff: true, ai_handoff_reason: conv.ai_handoff_reason || `${req.user.name} took over`, ai_handoff_at: conv.ai_handoff_at ?? new Date(),
      human_until: minutes ? new Date(Date.now() + minutes * 60_000) : null, taken_over_by: req.user.id, assigned_user_id: req.user.id, ai_draft: null, act_now: false,
    } });
    res.json(await publish(conv._id));
  });

  router.post('/inbox/:id/release', auth, need(db, 'reply'), async (req, res) => {
    const conv = await load(req, idOf(req));
    await db.conversations.updateOne({ _id: conv._id }, { $set: { ai_handoff: false, ai_handoff_reason: '', ai_handoff_at: null, human_until: null, taken_over_by: null, act_now: false } });
    res.json(await publish(conv._id));
  });

  router.post('/inbox/:id/messages', auth, need(db, 'reply'), async (req, res) => {
    const conv = await load(req, idOf(req));
    const text = String(req.body?.text ?? '').trim();
    if (!text) throw new InboxError(400, 'Write a message first');
    if (text.length > 2000) throw new InboxError(400, 'Messages can be 2,000 characters at most');
    if (conv.assigned_user_id && conv.assigned_user_id !== req.user.id && req.user.role !== 'owner') {
      const other = await db.users.findById(conv.assigned_user_id, { name: 1 }).lean();
      throw new InboxError(409, `${other?.name ?? 'A teammate'} is handling this chat. Take over first so the customer doesn't get two answers.`);
    }
    const message = await inbox.sendReply(req.user, conv._id, text);
    // Replying is taking over: the AI waits, then comes back by itself.
    const minutes = setting(req.workspace, 'auto_return_min', DEFAULT_RETURN_MIN);
    await db.conversations.updateOne({ _id: conv._id }, { $set: { human_until: minutes ? new Date(Date.now() + minutes * 60_000) : null, taken_over_by: req.user.id, unread_count: 0, act_now: false } });
    if (req.body?.savedReplyId) await db.savedReplies.updateOne({ _id: Number(req.body.savedReplyId), workspace_id: req.user.workspace_id }, { $inc: { uses: 1 } });
    await publish(conv._id);
    res.status(201).json(message);
  });

  // Product cards (screen 24, CAT-03/04): up to 10 products as a carousel the customer can order from.
  router.post('/inbox/:id/products', auth, need(db, 'reply'), async (req, res) => {
    const conv = await load(req, idOf(req));
    const ids = [...new Set((Array.isArray(req.body?.productIds) ? req.body.productIds : []).map(Number).filter(Boolean))].slice(0, 10);
    if (!ids.length) throw new InboxError(400, 'Pick at least one product');
    if (conv.assigned_user_id && conv.assigned_user_id !== req.user.id && req.user.role !== 'owner') {
      const other = await db.users.findById(conv.assigned_user_id, { name: 1 }).lean();
      throw new InboxError(409, `${other?.name ?? 'A teammate'} is handling this chat. Take over first so the customer doesn't get two answers.`);
    }
    const found = await db.products.find({ _id: { $in: ids }, workspace_id: req.user.workspace_id }).lean();
    const byId = new Map(found.map((p) => [p._id, p]));
    const base = config.publicUrl || `${req.protocol}://${req.get('host')}`;
    const rich = productCards(ids.map((id) => byId.get(id)).filter(Boolean), { publicUrl: base, pageUrl: await pageLinker(db, req.user.workspace_id, base, conv._id) });
    if (!rich.payload.cards.length) throw new InboxError(400, 'Those products are hidden or archived');
    const message = await inbox.sendRich(req.user, conv._id, rich);
    const minutes = setting(req.workspace, 'auto_return_min', DEFAULT_RETURN_MIN);
    await db.conversations.updateOne({ _id: conv._id }, { $set: { human_until: minutes ? new Date(Date.now() + minutes * 60_000) : null, taken_over_by: req.user.id, unread_count: 0, act_now: false, ai_handoff: true, ai_handoff_at: new Date(), ai_handoff_reason: 'A team member replied' } });
    await publish(conv._id);
    res.status(201).json(message);
  });

  // Assign popup (TEAM-03): the new owner gets a notification; the AI can keep replying until they take over.
  router.post('/inbox/:id/assign', auth, need(db, 'reply'), async (req, res) => {
    const conv = await load(req, idOf(req));
    const userId = req.body?.userId === null ? null : Number(req.body?.userId);
    let assignee = null;
    if (userId !== null) {
      assignee = await db.users.findOne({ _id: userId, workspace_id: req.user.team_id, is_active: true }).lean();
      if (!assignee) throw new InboxError(400, 'Pick a teammate');
    }
    const set = { assigned_user_id: userId };
    if (req.body?.keepAi === false) Object.assign(set, { ai_handoff: true, ai_handoff_at: new Date(), ai_handoff_reason: `Assigned to ${assignee?.name}`, human_until: null });
    await db.conversations.updateOne({ _id: conv._id }, { $set: set });
    const note = String(req.body?.note ?? '').trim().slice(0, 500);
    if (note) await db.insert(db.notes, { workspace_id: conv.workspace_id, conversation_id: conv._id, author_user_id: req.user.id, text: note });
    const [row] = await hydrate([await db.conversations.findById(conv._id).lean()]);
    if (assignee && assignee._id !== req.user.id) {
      await notify({ workspaceId: conv.workspace_id, userIds: [assignee._id], event: 'handoff',
        title: `${req.user.name} assigned ${row.name} to you`, body: note || row.preview, link: `/inbox/${conv._id}` });
    }
    await audit(db, req.user, `Assigned ${row.name} to ${assignee?.name ?? 'nobody'}`, { where: 'Inbox' });
    res.json(await publish(conv._id));
  });

  router.post('/inbox/:id/done', auth, need(db, 'reply'), async (req, res) => {
    const conv = await load(req, idOf(req));
    await db.conversations.updateOne({ _id: conv._id }, { $set: { status: 'closed', done_at: new Date(), done_by: req.user.name, unread_count: 0, act_now: false, reopened_at: null },
      $pull: { tags: 'Back from Done' } });
    res.json(await publish(conv._id));
  });

  router.post('/inbox/:id/reopen', auth, need(db, 'reply'), async (req, res) => {
    const conv = await load(req, idOf(req));
    await db.conversations.updateOne({ _id: conv._id }, { $set: { status: 'open', done_at: null } });
    res.json(await publish(conv._id));
  });

  router.post('/inbox/:id/snooze', auth, need(db, 'reply'), async (req, res) => {
    const conv = await load(req, idOf(req));
    const until = req.body?.until === null ? null : new Date(req.body?.until);
    if (until && (Number.isNaN(until.getTime()) || until <= new Date())) throw new InboxError(400, 'Pick a time in the future');
    await db.conversations.updateOne({ _id: conv._id }, { $set: { snooze_until: until, snooze_note: String(req.body?.note ?? '').slice(0, 300), snoozed_by: req.user.id } });
    res.json(await publish(conv._id));
  });

  // Spam folder: the AI never replies there, so it costs nothing (TKT-03).
  router.post('/inbox/:id/spam', auth, need(db, 'reply'), async (req, res) => {
    const conv = await load(req, idOf(req));
    const spam = req.body?.spam !== false;
    await db.conversations.updateOne({ _id: conv._id }, { $set: { spam, spam_reason: spam ? String(req.body?.reason || `Marked by ${req.user.name}`) : '' } });
    res.json(await publish(conv._id));
  });

  router.post('/inbox/:id/block', auth, need(db, 'reply'), async (req, res) => {
    const conv = await load(req, idOf(req));
    if (conv.customer_id) await db.customers.updateOne({ _id: conv.customer_id }, { $set: { blocked: true, ai_off: true, ai_off_reason: 'Blocked' } });
    await db.conversations.updateOne({ _id: conv._id }, { $set: { spam: true, spam_reason: spamReasonOr(conv, `Blocked by ${req.user.name}`), status: 'closed' } });
    await audit(db, req.user, 'Blocked a customer', { where: 'Inbox' });
    res.json(await publish(conv._id));
  });

  // "AI for this customer" switch, with a note why (TKT-03).
  router.post('/inbox/:id/ai', auth, need(db, 'reply'), async (req, res) => {
    const conv = await load(req, idOf(req));
    if (!conv.customer_id) throw new InboxError(400, 'This chat has no customer yet');
    const off = req.body?.on === false;
    await db.customers.updateOne({ _id: conv.customer_id }, { $set: { ai_off: off, ai_off_reason: off ? String(req.body?.reason ?? '').slice(0, 200) : '' } });
    res.json(await publish(conv._id));
  });

  router.post('/inbox/:id/tags', auth, need(db, 'reply'), async (req, res) => {
    const conv = await load(req, idOf(req));
    const tag = String(req.body?.tag ?? '').trim().slice(0, 30);
    if (!tag) throw new InboxError(400, 'Write a tag');
    const target = conv.customer_id ? db.customers : db.conversations;
    const id = conv.customer_id ?? conv._id;
    await target.updateOne({ _id: id }, req.body?.remove ? { $pull: { tags: tag } } : { $addToSet: { tags: tag } });
    if (req.body?.remove) await db.conversations.updateOne({ _id: conv._id }, { $pull: { tags: tag } });
    res.json(await publish(conv._id));
  });

  // Team notes & @mentions (INB-09, frame "Team notes & @mentions"): the whole thread for the chat and
  // the customer, oldest first, with who can be mentioned and whether they are on duty.
  const teamOf = async (conv) => db.users.find({ workspace_id: await teamId(db, conv.workspace_id), is_active: true, invite_pending: { $ne: true } }, { name: 1, role: 1, on_duty: 1, is_online: 1, avatar: 1 }).sort({ name: 1 }).lean();
  const noteRow = (n, authors, team, me) => ({
    id: n._id, text: n.text, by: authors.get(n.author_user_id) ?? '', byId: n.author_user_id ?? null, at: n.created_at, mine: n.author_user_id === me,
    mentions: (n.mentions ?? []).map((id) => team.find((u) => u._id === id)).filter(Boolean).map((u) => ({ id: u._id, name: u.name })),
  });

  router.get('/inbox/:id/notes', auth, async (req, res) => {
    const conv = await load(req, idOf(req));
    const [notes, team, [row]] = await Promise.all([
      db.notes.find({ $or: [{ conversation_id: conv._id }, ...(conv.customer_id ? [{ customer_id: conv.customer_id }] : [])] }).sort({ created_at: 1, _id: 1 }).limit(200).lean(),
      teamOf(conv), hydrate([conv]),
    ]);
    const missing = notes.map((n) => n.author_user_id).filter((id) => id && !team.some((u) => u._id === id));
    const gone = missing.length ? await db.users.find({ _id: { $in: missing } }, { name: 1 }).lean() : [];
    const authors = new Map([...team, ...gone].map((u) => [u._id, u.name]));
    res.json({
      customer: row.name, notes: notes.map((n) => noteRow(n, authors, team, req.user.id)),
      team: team.map((u) => ({ id: u._id, name: u.name, role: u.role, onDuty: u.on_duty !== false, online: Boolean(u.is_online), avatar: u.avatar || '', me: u._id === req.user.id })),
    });
  });

  router.post('/inbox/:id/notes', auth, need(db, 'reply'), async (req, res) => {
    const conv = await load(req, idOf(req));
    const text = String(req.body?.text ?? '').trim().slice(0, 1000);
    if (!text) throw new InboxError(400, 'Write a note');
    const team = await teamOf(conv);
    const mentions = mentionsIn(text, team);
    const note = await db.insert(db.notes, { workspace_id: conv.workspace_id, conversation_id: conv._id, customer_id: conv.customer_id, author_user_id: req.user.id, text, mentions });
    const [row] = await hydrate([conv]);
    for (const userId of mentions.filter((id) => id !== req.user.id)) {
      await notify({ workspaceId: conv.workspace_id, userIds: [userId], event: 'mention', title: `${req.user.name} mentioned you`, body: `in ${row.name}: "${text.slice(0, 80)}"`, link: `/inbox/${conv._id}` });
    }
    const saved = await db.notes.findById(note.id).lean();
    res.status(201).json(noteRow(saved, new Map([[req.user.id, req.user.name]]), team, req.user.id));
  });

  // Take back your own note (owners may remove any).
  router.delete('/inbox/:id/notes/:noteId', auth, async (req, res) => {
    const conv = await load(req, idOf(req));
    const note = await db.notes.findOne({ _id: Number(req.params.noteId), workspace_id: conv.workspace_id, $or: [{ conversation_id: conv._id }, { customer_id: conv.customer_id ?? -1 }] }).lean();
    if (!note) throw new InboxError(404, 'Note not found');
    if (note.author_user_id !== req.user.id && req.user.role !== 'owner') throw new InboxError(403, 'Only the person who wrote a note can delete it');
    await db.notes.deleteOne({ _id: note._id });
    res.status(204).end();
  });

  // AI copilot: ask about this customer (HND-04).
  router.post('/inbox/:id/ask', auth, async (req, res) => {
    const conv = await load(req, idOf(req));
    const question = String(req.body?.question ?? '').trim().slice(0, 300);
    if (!question) throw new InboxError(400, 'Ask a question');
    if (!agent?.status().available) throw new InboxError(503, 'The AI is not set up on this server yet');
    res.json({ answer: await agent.ask(req.user, conv._id, question) });
  });

  router.post('/inbox/:id/draft', auth, need(db, 'reply'), async (req, res) => {
    const conv = await load(req, idOf(req));
    const draft = await agent.suggest(req.user, conv._id);
    res.json({ text: draft?.text ?? '' });
  });

  // Bulk actions on selected chats (INB-06).
  router.post('/inbox/bulk', auth, need(db, 'reply'), async (req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isSafeInteger).slice(0, 200);
    if (!ids.length) throw new InboxError(400, 'Select chats first');
    req.workspace = await db.workspaces.findById(req.user.workspace_id).lean();
    const where = all({ _id: { $in: ids }, workspace_id: req.user.workspace_id }, scopeFilter(req.user, req.workspace, 'everyone'));
    const action = req.body?.action;
    const updates = {
      done: { $set: { status: 'closed', done_at: new Date(), done_by: req.user.name, unread_count: 0 } },
      reopen: { $set: { status: 'open', done_at: null } },
      read: { $set: { unread_count: 0 } },
      spam: { $set: { spam: true, spam_reason: `Marked by ${req.user.name}` } },
      not_spam: { $set: { spam: false, spam_reason: '' } },
    };
    let result;
    if (action === 'assign') {
      const userId = Number(req.body?.userId);
      if (!(await db.users.exists({ _id: userId, workspace_id: req.user.team_id, is_active: true }))) throw new InboxError(400, 'Pick a teammate');
      result = await db.conversations.updateMany(where, { $set: { assigned_user_id: userId } });
    } else if (action === 'tag') {
      const tag = String(req.body?.tag ?? '').trim().slice(0, 30);
      if (!tag) throw new InboxError(400, 'Write a tag');
      result = await db.conversations.updateMany(where, { $addToSet: { tags: tag } });
    } else if (updates[action]) {
      result = await db.conversations.updateMany(where, updates[action]);
    } else {
      throw new InboxError(400, 'Unknown action');
    }
    for (const id of ids) await publish(id).catch(() => {});
    res.json({ changed: result.modifiedCount });
  });

  router.post('/inbox/mark-all-read', auth, async (req, res) => {
    req.workspace = await db.workspaces.findById(req.user.workspace_id).lean();
    const tab = TABS.includes(req.body?.tab) ? req.body.tab : 'open';
    const r = await db.conversations.updateMany(all({ workspace_id: req.user.workspace_id, unread_count: { $gt: 0 } }, scopeFilter(req.user, req.workspace, 'everyone'), tabFilter(tab)), { $set: { unread_count: 0 } });
    emit(req.user.workspace_id, 'conversation', {});
    res.json({ changed: r.modifiedCount });
  });

  // Tidy up: marks Done the chats the AI finished more than a day ago with nothing waiting.
  router.post('/inbox/tidy', auth, need(db, 'reply'), async (req, res) => {
    const dayAgo = new Date(Date.now() - 86_400_000);
    const where = req.body?.tab === 'spam'
      ? { workspace_id: req.user.workspace_id, spam: true, status: 'open', last_message_at: { $lt: dayAgo } }
      : { workspace_id: req.user.workspace_id, status: 'open', spam: { $ne: true }, ai_handoff: { $ne: true }, last_replier: 'ai', last_message_at: { $lt: dayAgo } };
    const r = await db.conversations.updateMany(where, { $set: { status: 'closed', done_at: new Date(), done_by: 'Tidy up', unread_count: 0 } });
    emit(req.user.workspace_id, 'conversation', {});
    res.json({ changed: r.modifiedCount });
  });

  router.get('/saved-replies', auth, async (req, res) => {
    const list = await db.savedReplies.find({ workspace_id: req.user.workspace_id, $or: [{ scope: { $ne: 'private' } }, { owner_user_id: req.user.id }] }).sort({ pinned: -1, uses: -1, shortcut: 1 }).lean();
    res.json(list.map((r) => ({ id: r._id, shortcut: r.shortcut.startsWith('/') ? r.shortcut : `/${r.shortcut}`, name: r.name ?? '', text: r.text, uses: r.uses ?? 0 })));
  });

  router.get('/team/members', auth, async (req, res) => {
    const users = await db.users.find({ workspace_id: req.user.team_id, is_active: true }, { name: 1, role: 1, on_duty: 1, is_online: 1, invite_pending: 1 }).lean();
    const open = await db.conversations.aggregate([
      { $match: { workspace_id: req.user.workspace_id, status: 'open', spam: { $ne: true }, assigned_user_id: { $ne: null } } },
      { $group: { _id: '$assigned_user_id', n: { $sum: 1 } } }]);
    const counts = new Map(open.map((o) => [o._id, o.n]));
    res.json(users.filter((u) => !u.invite_pending).map((u) => ({ id: u._id, name: u.name, role: u.role, onDuty: u.on_duty !== false && u.is_online !== false, openChats: counts.get(u._id) ?? 0, you: u._id === req.user.id })));
  });

  return router;
}

function spamReasonOr(conv, fallback) {
  return conv.spam_reason || fallback;
}

// A short summary from what we know, used until the AI writes one (HND-04).
function autoSummary(customer, orders) {
  const parts = [];
  const n = customer.stats?.orders ?? orders.length;
  if (n) parts.push(`${n > 2 ? 'Regular buyer' : 'Buyer'} (${n} order${n === 1 ? '' : 's'}).`);
  else parts.push('New customer, no orders yet.');
  const last = orders[0];
  if (last) parts.push(`Order #${last.number ?? last._id} is ${stageOf(last.status).replace(/_/g, ' ')}.`);
  if (customer.vip) parts.push('VIP.');
  return parts.join(' ');
}

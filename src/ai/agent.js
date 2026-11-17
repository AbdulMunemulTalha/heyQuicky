import { tryAutoAnswer, hasAutoAnswers } from '../dashboard/autoAnswer.js';
import { INTENTS, REPLY_SCHEMA, buildSystemPrompt, toModelMessages } from './prompt.js';
import { InboxError } from '../inbox.js';

// After a person replies (or the AI hands off), the AI stays out of that
// conversation in auto mode for this long, then may answer again.
const HANDOFF_LAPSE_MS = 12 * 3_600_000;
// Stops a runaway back-and-forth: after this many AI messages in a day, a person takes over.
const MAX_AI_REPLIES_PER_DAY = 20;

const modeOf = (workspace) => workspace?.ai_mode ?? 'suggest';

function handoffActive(conversation, now = Date.now()) {
  if (!conversation.ai_handoff) return false;
  // A person took over from the dashboard: the AI stays quiet until the chosen time (HND-02).
  if (conversation.human_until) return now < new Date(conversation.human_until).getTime();
  const at = conversation.ai_handoff_at ? new Date(conversation.ai_handoff_at).getTime() : 0;
  return now - at < HANDOFF_LAPSE_MS;
}

function normalize(data) {
  return {
    reply: String(data?.reply ?? '').trim(),
    handoff: Boolean(data?.handoff),
    handoff_reason: String(data?.handoff_reason ?? '').trim(),
    intent: INTENTS.includes(data?.intent) ? data.intent : 'other',
  };
}

// The Bangla/Banglish chat agent. In "suggest" mode it drafts a reply for the
// moderator; in "auto" mode it answers the customer itself and hands anything it
// shouldn't handle to a person. `provider` is null when AI isn't configured.
export function createAgent(db, inbox, provider, { replyDelayMs = 4000, log = console } = {}) {
  // conversationId -> { timer, resolve } for the reply waiting to be written.
  const pending = new Map();
  let lastError = null;

  async function loadContext(conversationId) {
    const conversation = await db.conversations.findById(conversationId).lean();
    if (!conversation) return null;
    const [workspace, channel, products, savedReplies, recent] = await Promise.all([
      db.workspaces.findById(conversation.workspace_id).lean(),
      db.channels.findById(conversation.channel_id, { ai_enabled: 1 }).lean(),
      db.products.find({ workspace_id: conversation.workspace_id }).sort({ name: 1 }).limit(300).lean(),
      db.savedReplies.find({ workspace_id: conversation.workspace_id }).sort({ shortcut: 1 }).lean(),
      db.messages.find({ conversation_id: conversationId }).sort({ _id: -1 }).limit(30).lean(),
    ]);
    const messages = recent.reverse();
    const lastInbound = messages.findLast((m) => m.direction === 'in') ?? null;
    return { conversation, workspace, channel, products, savedReplies, messages, lastInbound };
  }

  async function generate(ctx) {
    const turns = toModelMessages(ctx.messages);
    if (!turns) return null;
    const system = buildSystemPrompt(ctx);
    try {
      const { data } = await provider.generateJson({ system, messages: turns, schema: REPLY_SCHEMA });
      lastError = null;
      return normalize(data);
    } catch (err) {
      lastError = { message: err.message, at: new Date() };
      throw err;
    }
  }

  async function setHandoff(conversationId, reason) {
    await db.conversations.updateOne({ _id: conversationId },
      { $set: { ai_handoff: true, ai_handoff_reason: reason, ai_handoff_at: new Date() } });
  }

  async function saveDraft(conversationId, answer, forMessageId) {
    const draft = {
      text: answer.reply,
      intent: answer.intent,
      handoff: answer.handoff,
      handoff_reason: answer.handoff_reason,
      for_message_id: forMessageId,
      created_at: new Date(),
    };
    await db.conversations.updateOne({ _id: conversationId }, { $set: { ai_draft: draft } });
    return draft;
  }

  async function repliesToday(conversationId) {
    return db.messages.countDocuments({
      conversation_id: conversationId, sent_by_ai: true, created_at: { $gte: new Date(Date.now() - 86_400_000) },
    });
  }

  // Answers the customer message `messageId`, unless something newer arrived.
  // Returns what happened, for logs and tests.
  async function respond(conversationId, messageId) {
    // Saved replies set to answer automatically go first: no AI call, no cost, and no credit needed (SR-02/10).
    if (await tryAutoAnswer(db, inbox, conversationId, messageId)) return 'saved_reply';
    if (!provider) return 'not_configured';
    const ctx = await loadContext(conversationId);
    if (!ctx) return 'gone';
    const mode = modeOf(ctx.workspace);
    if (mode === 'off') return 'off';
    // The owner switched the AI off for this channel (moderators can still ask for a suggestion).
    if (ctx.channel?.ai_enabled === false) return 'channel_off';
    // Spam and customers the team switched the AI off for get no AI reply, so they cost nothing (TKT-03).
    if (ctx.conversation.spam) return 'spam';
    if (ctx.conversation.customer_id && await db.customers.exists({ _id: ctx.conversation.customer_id, ai_off: true })) return 'customer_off';
    if (ctx.lastInbound?._id !== messageId) return 'stale';

    let auto = mode === 'auto' && !handoffActive(ctx.conversation);
    if (auto && (await repliesToday(conversationId)) >= MAX_AI_REPLIES_PER_DAY) {
      await setHandoff(conversationId, 'The AI has sent many replies today; please take over this customer');
      auto = false;
    }

    const answer = await generate(ctx);
    if (!answer) return 'nothing_to_answer';

    // The customer may have written again, or a person replied, while the model was working.
    const [latest] = await db.messages.find({ conversation_id: conversationId }).sort({ _id: -1 }).limit(1).lean();
    if (latest?._id !== messageId) return 'stale';

    if (!auto) {
      await saveDraft(conversationId, answer, messageId);
      await inbox.refresh(conversationId);
      return 'drafted';
    }

    if (answer.handoff) await setHandoff(conversationId, answer.handoff_reason || 'The AI asked for a person to take over');
    if (answer.reply) {
      const sent = await inbox.sendAiReply(conversationId, answer.reply);
      if (!sent) {
        await setHandoff(conversationId, "Meta's reply window has closed, so the AI couldn't answer. Please follow up.");
        await saveDraft(conversationId, answer, messageId);
      }
    }
    await inbox.refresh(conversationId);
    return answer.handoff ? 'handed_off' : 'sent';
  }

  // Waits a moment before answering, because customers often send several
  // short messages in a row; only the last one gets a reply.
  async function onInbound(conversationId, messageId) {
    if (!provider && !(await hasAutoAnswers(db, conversationId))) return 'not_configured';
    const previous = pending.get(conversationId);
    if (previous) {
      clearTimeout(previous.timer);
      previous.resolve('superseded');
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(conversationId);
        respond(conversationId, messageId).then(resolve, (err) => {
          log.warn(`AI reply for conversation ${conversationId} failed: ${err.message}`);
          resolve('error');
        });
      }, replyDelayMs);
      pending.set(conversationId, { timer, resolve });
    });
  }

  async function accessible(user, conversationId) {
    const conversation = Number.isInteger(conversationId) ? await inbox.getConversation(conversationId) : null;
    if (!inbox.canAccess(user, conversation)) throw new InboxError(404, 'Conversation not found');
    return conversation;
  }

  return {
    onInbound,
    respond,

    // Practice chat during onboarding: the owner plays a customer. Nothing is stored or sent to Meta.
    async practice(user, turns) {
      if (!provider) throw new InboxError(503, 'AI replies are not set up on this server yet');
      if (!Array.isArray(turns) || !turns.length || turns.length > 30) throw new InboxError(400, 'Send the practice conversation');
      const messages = turns.map((t) => ({
        role: t?.role === 'assistant' ? 'assistant' : 'user',
        content: String(t?.content ?? '').trim().slice(0, 1000),
      })).filter((t) => t.content);
      if (!messages.length || messages.at(-1).role !== 'user') throw new InboxError(400, 'Write a customer message first');
      const [workspace, products, savedReplies] = await Promise.all([
        db.workspaces.findById(user.workspace_id).lean(),
        db.products.find({ workspace_id: user.workspace_id }).sort({ name: 1 }).limit(300).lean(),
        db.savedReplies.find({ workspace_id: user.workspace_id }).sort({ shortcut: 1 }).lean(),
      ]);
      const turnsForModel = toModelMessages(messages.map((m) => ({ direction: m.role === 'user' ? 'in' : 'out', text: m.content })));
      if (!turnsForModel) throw new InboxError(400, 'Write a customer message first');
      try {
        const { data } = await provider.generateJson({
          system: buildSystemPrompt({ workspace, products, savedReplies }), messages: turnsForModel, schema: REPLY_SCHEMA,
        });
        lastError = null;
        return normalize(data);
      } catch (err) {
        lastError = { message: err.message, at: new Date() };
        throw new InboxError(502, `The AI couldn't answer: ${err.message}`);
      }
    },

    status: () => ({
      available: Boolean(provider),
      provider: provider?.name ?? null,
      model: provider?.model ?? null,
      lastError,
    }),

    // "Suggest a reply" button: drafts an answer to the latest customer message now.
    async suggest(user, conversationId) {
      if (!provider) throw new InboxError(503, 'AI replies are not set up on this server');
      await accessible(user, conversationId);
      const ctx = await loadContext(conversationId);
      if (modeOf(ctx.workspace) === 'off') throw new InboxError(409, 'The AI agent is turned off in Settings');
      let answer;
      try {
        answer = await generate(ctx);
      } catch (err) {
        throw new InboxError(502, `The AI couldn't write a reply: ${err.message}`);
      }
      if (!answer) throw new InboxError(409, 'There is no customer message waiting for a reply');
      const draft = await saveDraft(conversationId, answer, ctx.lastInbound._id);
      await inbox.refresh(conversationId);
      return draft;
    },

    async dismissDraft(user, conversationId) {
      await accessible(user, conversationId);
      await db.conversations.updateOne({ _id: conversationId }, { $set: { ai_draft: null } });
      return inbox.refresh(conversationId);
    },

    // Copilot: answers a teammate's question about one customer from their chat and orders (HND-04).
    async ask(user, conversationId, question) {
      if (!provider) throw new InboxError(503, 'AI replies are not set up on this server');
      const conversation = await db.conversations.findById(conversationId).lean();
      if (!conversation || conversation.workspace_id !== user.workspace_id) throw new InboxError(404, 'Conversation not found');
      const [messages, orders] = await Promise.all([
        db.messages.find({ conversation_id: conversationId }).sort({ _id: -1 }).limit(40).lean(),
        conversation.customer_id ? db.orders.find({ customer_id: conversation.customer_id }).sort({ _id: -1 }).limit(10).lean() : [],
      ]);
      const transcript = messages.reverse().map((m) => `${m.direction === 'in' ? 'Customer' : m.sent_by_ai ? 'AI' : 'Team'}: ${m.text}`).join('\n');
      const orderLines = orders.map((o) => `#${o.number ?? o._id} ${o.status} ৳${o.subtotal + o.delivery_charge - (o.discount ?? 0)} ${o.items.map((i) => i.name).join(', ')}`).join('\n');
      try {
        const { data } = await provider.generateJson({
          system: 'You help a shop team understand one customer. Answer briefly (1-3 sentences) from the chat and orders only. If the answer is not there, say so. Reply in the language of the question.',
          messages: [{ role: 'user', content: `Chat:\n${transcript || '(none)'}\n\nOrders:\n${orderLines || '(none)'}\n\nQuestion: ${question}` }],
          schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
          maxTokens: 600,
        });
        return String(data.answer ?? '').trim();
      } catch (err) {
        throw new InboxError(502, `The AI couldn't answer: ${err.message}`);
      }
    },

    // Lets the AI answer this customer again after a handoff.
    async resume(user, conversationId) {
      await accessible(user, conversationId);
      await db.conversations.updateOne({ _id: conversationId },
        { $set: { ai_handoff: false, ai_handoff_reason: '', ai_handoff_at: null } });
      return inbox.refresh(conversationId);
    },
  };
}

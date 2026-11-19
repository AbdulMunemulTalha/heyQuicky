import { tryAutoAnswer, hasAutoAnswers } from '../dashboard/autoAnswer.js';
import { withTraining, recordUnanswered } from '../dashboard/training.js';
import { INTENTS, REPLY_SCHEMA, COMMENT_SCHEMA, POST_MATCH_SCHEMA, buildSystemPrompt, buildCommentPrompt, buildPostMatchPrompt, buildCustomerContext, toModelMessages } from './prompt.js';
import { priceRange } from '../dashboard/posts.js';
import { toPlatform } from '../platforms/rich.js';
import { commentAction } from '../dashboard/comments.js';
import { openTicket } from '../dashboard/tickets.js';
import { productCards, quickReplies } from '../platforms/rich.js';
import { placeAiOrder } from '../dashboard/aiOrder.js';
import { sendSizeChart } from '../dashboard/postbacks.js';
import { InboxError } from '../inbox.js';
import { canSpend, meter } from './metering.js';
import { fetchAttachment, IMAGE_TYPES, MAX_IMAGE_BYTES } from './media.js';
import { MAX_AUDIO_BYTES } from './transcribe.js';
import { decryptSecret } from '../secrets.js';

// After a person replies (or the AI hands off), the AI stays out of that
// conversation in auto mode for this long, then may answer again.
const HANDOFF_LAPSE_MS = 12 * 3_600_000;
// Stops a runaway back-and-forth: after this many AI messages in a day, a person takes over.
const MAX_AI_REPLIES_PER_DAY = 20;

const modeOf = (workspace) => workspace?.ai_mode ?? 'suggest';
// The shop's "Reply delay" (AI-02), in ms. It also lets a burst of short messages arrive first (AI-06),
// so "instant" still waits a moment.
const DELAY_RANGES = { instant: [800, 800], '1-3': [1000, 3000], '3-6': [3000, 6000], '6-10': [6000, 10000] };
export function delayFor(setting, random = Math.random) {
  const [lo, hi] = DELAY_RANGES[setting] ?? DELAY_RANGES['3-6'];
  return Math.round(lo + (hi - lo) * random());
}
// At most this many customer photos go with one model call.
const MAX_IMAGES = 3;

// The real image type from the file's first bytes (CDNs don't always say).
function sniffImage(b) {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

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
    products: (Array.isArray(data?.products) ? data.products : []).map(Number).filter(Number.isInteger).slice(0, 10),
    quick_replies: (Array.isArray(data?.quick_replies) ? data.quick_replies : []).map((q) => String(q).trim().slice(0, 20)).filter(Boolean).slice(0, 5),
    size_chart_product: Number(data?.size_chart_product) || 0,
    order: data?.order?.ready ? data.order : null,
    act_now: Boolean(data?.act_now),
    act_now_reason: String(data?.act_now_reason ?? '').trim(),
  };
}

// The Bangla/Banglish chat agent. In "suggest" mode it drafts a reply for the
// moderator; in "auto" mode it answers the customer itself and hands anything it
// shouldn't handle to a person. `provider` is null when AI isn't configured.
export function createAgent(db, inbox, provider, { replyDelayMs = null, log = console, notify = null, config = {}, transcriber = null, fetchMedia = fetchAttachment, emit = () => {}, fetchImpl } = {}) {
  const PAUSED = { credit: 'AI credit finished — top up so the AI answers again', cap: "This month's AI spend limit is reached — raise it in Settings → Billing" };

  // Every model call goes through here: checked against credit and the monthly cap, then priced and charged.
  async function callModel(workspaceId, request, meta = {}) {
    const spend = await canSpend(db, workspaceId, new Date(), { enforced: Boolean(config.ai?.creditEnforced) });
    if (!spend.ok) {
      const err = new InboxError(402, PAUSED[spend.reason]);
      err.paused = spend.reason;
      throw err;
    }
    const out = await provider.generateJson(request);
    await meter(db, config, { workspaceId, model: provider.model, usage: out.usage, notify, ...meta }).catch((e) => log.warn(`metering failed: ${e.message}`));
    return out;
  }
  // conversationId -> { timer, resolve } for the reply waiting to be written.
  const pending = new Map();
  let lastError = null;

  async function loadContext(conversationId) {
    const conversation = await db.conversations.findById(conversationId).lean();
    if (!conversation) return null;
    const [workspace, channel, products, savedReplies, recent] = await Promise.all([
      db.workspaces.findById(conversation.workspace_id).lean(),
      db.channels.findById(conversation.channel_id, { ai_enabled: 1 }).lean(),
      db.products.find({ workspace_id: conversation.workspace_id, archived: { $ne: true }, visibility: { $ne: 'hidden' } }).sort({ name: 1 }).limit(300).lean(),
      db.savedReplies.find({ workspace_id: conversation.workspace_id }).sort({ shortcut: 1 }).lean(),
      db.messages.find({ conversation_id: conversationId }).sort({ _id: -1 }).limit(30).lean(),
    ]);
    const messages = recent.reverse();
    const lastInbound = messages.findLast((m) => m.direction === 'in') ?? null;
    const now = new Date();
    const [coupons, customer, orders, notes] = await Promise.all([
      db.coupons.find({ workspace_id: conversation.workspace_id, active: { $ne: false }, $and: [{ $or: [{ ends_at: null }, { ends_at: { $gt: now } }] }, { $or: [{ starts_at: null }, { starts_at: { $lte: now } }] }] }).limit(10).lean(),
      conversation.customer_id ? db.customers.findById(conversation.customer_id).lean() : null,
      conversation.customer_id ? db.orders.find({ customer_id: conversation.customer_id, draft: { $ne: true } }).sort({ created_at: -1 }).limit(3).lean() : [],
      conversation.customer_id ? db.notes.find({ customer_id: conversation.customer_id }).sort({ created_at: -1 }).limit(3).lean() : [],
    ]);
    // The knowledge book, taught answers and rules ride along with the shop information.
    return { conversation, workspace: workspace && await withTraining(db, workspace), channel, products, savedReplies, coupons, messages, lastInbound,
      context: buildCustomerContext({ customer, orders, notes, now }) };
  }

  // What the customer sent since the shop last replied: voice notes are transcribed once and the
  // text kept on the message (AI-04); photos are shown to the model for this reply only (AI-05).
  async function seeMedia(ctx) {
    const lastOut = ctx.messages.findLastIndex((m) => m.direction === 'out');
    const fresh = ctx.messages.slice(lastOut + 1).filter((m) => m.direction === 'in' && m.attachments?.length).slice(-5);
    if (!fresh.some((m) => m.attachments.some((a) => a.type === 'image' || (a.type === 'audio' && transcriber && !a.transcript && !a.transcript_failed)))) return;
    const raw = await db.channels.findById(ctx.conversation.channel_id, { platform: 1, access_token: 1 }).lean();
    const channel = raw && { platform: raw.platform, access_token: raw.access_token ? decryptSecret(raw.access_token, config.tokenKey) : '' };
    const graphVersion = config.meta?.graphVersion;
    let imagesLeft = MAX_IMAGES;
    for (const m of fresh) {
      let changed = false;
      const images = [];
      const attachments = [];
      for (const a of m.attachments) {
        const next = { ...a };
        if (a.type === 'audio' && transcriber && !a.transcript && !a.transcript_failed) {
          changed = true;
          try {
            const file = await fetchMedia({ channel, attachment: a, graphVersion, maxBytes: MAX_AUDIO_BYTES });
            const out = await transcriber.transcribe(file);
            next.transcript = out.text.slice(0, 2000) || '(no words)';
            await meter(db, config, { workspaceId: ctx.conversation.workspace_id, model: transcriber.model, usage: out.usage, kind: 'voice', conversationId: ctx.conversation._id,
              messageId: m._id, summary: 'Listened to a voice note', notify }).catch((e) => log.warn(`metering failed: ${e.message}`));
          } catch (err) {
            next.transcript_failed = true;
            log.warn(`voice note ${m._id} not transcribed: ${err.message}`);
          }
        } else if (a.type === 'image' && imagesLeft > 0 && !a.seen_failed) {
          try {
            const file = await fetchMedia({ channel, attachment: a, graphVersion, maxBytes: MAX_IMAGE_BYTES });
            const mediaType = sniffImage(file.bytes) ?? (IMAGE_TYPES.includes(file.mime) ? file.mime : null);
            if (!mediaType) throw new Error('not a photo the AI can read');
            images.push({ media_type: mediaType, data: file.bytes.toString('base64') });
            imagesLeft -= 1;
          } catch (err) {
            next.seen_failed = true;
            changed = true;
            log.warn(`photo in message ${m._id} not opened: ${err.message}`);
          }
        }
        attachments.push(next);
      }
      m.attachments = attachments;
      m.images = images;
      if (changed) await db.messages.updateOne({ _id: m._id }, { $set: { attachments } });
    }
  }

  async function generate(ctx, kind = 'reply') {
    await seeMedia(ctx).catch((err) => log.warn(`could not open the customer's files: ${err.message}`));
    const turns = toModelMessages(ctx.messages);
    if (!turns) return null;
    const system = buildSystemPrompt(ctx);
    try {
      const contactName = ctx.conversation.contact_id ? (await db.contacts.findById(ctx.conversation.contact_id, { name: 1 }).lean())?.name ?? '' : '';
      const { data } = await callModel(ctx.conversation.workspace_id, { system, context: ctx.context, messages: turns, schema: REPLY_SCHEMA },
        { kind, conversationId: ctx.conversation._id, customerName: contactName, summary: kind === 'draft' ? 'Drafted a reply' : 'Answered the customer' });
      lastError = null;
      const answer = normalize(data);
      return answer;
    } catch (err) {
      if (!err.paused) lastError = { message: err.message, at: new Date() };
      throw err;
    }
  }

  async function setHandoff(conversationId, reason) {
    const conv = await db.conversations.findOneAndUpdate({ _id: conversationId },
      { $set: { ai_handoff: true, ai_handoff_reason: reason, ai_handoff_at: new Date() } }, { new: true, lean: true });
    if (!notify || !conv) return;
    const contact = await db.contacts.findById(conv.contact_id, { name: 1 }).lean();
    await notify({ workspaceId: conv.workspace_id, event: 'handoff', title: `${contact?.name || 'A customer'} needs a person.`, body: String(reason ?? '').replace(/^Unanswered:\s*/i, 'The AI could not answer: ').slice(0, 200),
      link: `/inbox/${conv._id}`, ref: `handoff:${conv._id}`, userIds: conv.assigned_user_id ? [conv.assigned_user_id] : null });
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

    const spend = await canSpend(db, ctx.conversation.workspace_id, new Date(), { enforced: Boolean(config.ai?.creditEnforced) });
    if (!spend.ok) {
      if (auto && !ctx.conversation.ai_handoff) await setHandoff(conversationId, PAUSED[spend.reason]);
      return spend.reason === 'cap' ? 'cap_reached' : 'no_credit';
    }
    // The customer sees "seen" and "typing…" while the answer is written (AI-02).
    if (auto && inbox.showTyping) inbox.showTyping(conversationId).catch(() => {});
    const answer = await generate(ctx, auto ? 'reply' : 'draft');
    if (!answer) return 'nothing_to_answer';

    // The customer may have written again, or a person replied, while the model was working.
    const [latest] = await db.messages.find({ conversation_id: conversationId }).sort({ _id: -1 }).limit(1).lean();
    if (latest?._id !== messageId) return 'stale';

    if (!auto) {
      await saveDraft(conversationId, answer, messageId);
      await inbox.refresh(conversationId);
      return 'drafted';
    }

    // ACT NOW (TKT-02): urgent chats jump to the top for the team.
    if (answer.act_now) {
      await db.conversations.updateOne({ _id: conversationId }, { $set: { act_now: true } });
      answer.handoff = true;
      answer.handoff_reason = answer.act_now_reason || answer.handoff_reason || 'Urgent — the customer needs a person now';
      // ...and a ticket so it is tracked to a resolution (TKT-02).
      await openTicket(db, { workspaceId: ctx.conversation.workspace_id, conversationId, customerId: ctx.conversation.customer_id ?? null,
        title: answer.handoff_reason, reason: answer.handoff_reason, actNow: true, by: 'AI', ownerId: ctx.conversation.assigned_user_id ?? null, notify })
        .catch((err) => log.warn(`ticket for conversation ${conversationId} failed: ${err.message}`));
    }
    // ORD-01: the AI places the order; if anything doesn't fit the catalog, a person finishes it instead.
    let placed = null;
    if (answer.order) {
      try {
        placed = await placeAiOrder(db, { conversation: ctx.conversation, input: answer.order, notify, publicUrl: config.publicUrl || '' });
      } catch (err) {
        await setHandoff(conversationId, `The AI couldn't place the order: ${err.message}. Please finish it.`);
        await saveDraft(conversationId, answer, messageId);
        await inbox.refresh(conversationId);
        return 'order_failed';
      }
    }
    if (answer.handoff) await setHandoff(conversationId, answer.handoff_reason || 'The AI asked for a person to take over');
    // A question the shop information didn't cover goes to "Questions it couldn't answer" (TRN-04).
    if (answer.handoff && /^unanswered:/i.test(answer.handoff_reason ?? '')) await recordUnanswered(db, ctx.workspace._id, ctx.lastInbound?.text);
    if (answer.reply) {
      const sent = answer.quick_replies.length && !placed
        ? await inbox.sendAiRich(conversationId, quickReplies(answer.reply, answer.quick_replies))
        : await inbox.sendAiReply(conversationId, answer.reply);
      if (!sent) {
        await setHandoff(conversationId, "Meta's reply window has closed, so the AI couldn't answer. Please follow up.");
        await saveDraft(conversationId, answer, messageId);
        await inbox.refresh(conversationId);
        return 'handed_off';
      }
    }
    // Cards after the text: products (CAT-03 / AI-05), a size chart (AI-14), the order summary (ORD-02).
    if (answer.products.length) {
      const list = await db.products.find({ _id: { $in: answer.products }, workspace_id: ctx.conversation.workspace_id }).lean();
      const byId = new Map(list.map((p) => [p._id, p]));
      const rich = productCards(answer.products.map((id) => byId.get(id)).filter(Boolean), { publicUrl: config.publicUrl || '' });
      if (rich.payload.cards.length) await inbox.sendAiRich(conversationId, rich);
    }
    if (answer.size_chart_product) await sendSizeChart(db, inbox, conversationId, ctx.conversation.workspace_id, answer.size_chart_product);
    if (placed) await inbox.sendAiRich(conversationId, placed.rich);
    await inbox.refresh(conversationId);
    return placed ? 'order_placed' : answer.handoff ? 'handed_off' : 'sent';
  }

  // Waits a moment before answering, because customers often send several
  // short messages in a row; only the last one gets a reply.
  async function shopDelay(conversationId) {
    const conv = await db.conversations.findById(conversationId, { workspace_id: 1 }).lean();
    const ws = conv && await db.workspaces.findById(conv.workspace_id, { 'settings.persona.delay': 1 }).lean();
    return delayFor(ws?.settings?.persona?.delay);
  }

  async function onInbound(conversationId, messageId) {
    if (!provider && !(await hasAutoAnswers(db, conversationId))) return 'not_configured';
    const wait = replyDelayMs ?? await shopDelay(conversationId).catch(() => 4000);
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
      }, wait);
      pending.set(conversationId, { timer, resolve });
    });
  }

  async function accessible(user, conversationId) {
    const conversation = Number.isInteger(conversationId) ? await inbox.getConversation(conversationId) : null;
    if (!inbox.canAccess(user, conversation)) throw new InboxError(404, 'Conversation not found');
    return conversation;
  }

  // Public comments on the shop's posts (CMT-01 / AI-08), in auto mode, when the post's
  // "AI replies" switch is on. Returns what happened, for logs and tests.
  async function replyToComment(commentId) {
    if (!provider) return 'not_configured';
    const comment = await db.comments.findById(commentId).lean();
    if (!comment || comment.status !== 'needs_you') return 'not_needed';
    const [workspace, channel, post] = await Promise.all([
      db.workspaces.findById(comment.workspace_id).lean(),
      db.channels.findById(comment.channel_id).lean(),
      db.posts.findById(comment.post_id).lean(),
    ]);
    if (!workspace || !channel || !post) return 'gone';
    if (modeOf(workspace) !== 'auto') return 'off';
    if (channel.ai_enabled === false || post.rules?.ai_reply === false) return 'post_off';
    // Claim it: two webhook deliveries of the same comment must not both be answered.
    const claimed = await db.comments.findOneAndUpdate({ _id: commentId, ai_tried_at: null, status: 'needs_you' }, { $set: { ai_tried_at: new Date() } });
    if (!claimed) return 'not_needed';
    const spend = await canSpend(db, workspace._id, new Date(), { enforced: Boolean(config.ai?.creditEnforced) });
    if (!spend.ok) return spend.reason === 'cap' ? 'cap_reached' : 'no_credit';

    const visible = { workspace_id: workspace._id, archived: { $ne: true }, visibility: { $ne: 'hidden' } };
    let products = post.product_ids?.length ? await db.products.find({ ...visible, _id: { $in: post.product_ids } }).lean() : [];
    if (!products.length) products = await db.products.find(visible).sort({ name: 1 }).limit(100).lean();
    const leave = async (reason) => {
      await db.comments.updateOne({ _id: commentId }, { $set: { ai_reason: reason.slice(0, 200) } });
      emit(workspace._id, 'comment', { id: commentId, postId: post._id, status: 'needs_you' });
    };
    let data;
    try {
      ({ data } = await callModel(workspace._id, {
        system: buildCommentPrompt({ workspace: await withTraining(db, workspace), post, products, range: priceRange(products) }),
        messages: [{ role: 'user', content: `Comment from ${comment.author_name || 'a customer'}: ${comment.text || '(no text)'}` }],
        schema: COMMENT_SCHEMA, maxTokens: 1500,
      }, { kind: 'comment', customerName: comment.author_name, summary: 'Answered a comment' }));
    } catch (err) {
      log.warn(`AI comment reply ${commentId} failed: ${err.message}`);
      await leave(`The AI couldn't answer: ${err.message}`);
      return 'error';
    }
    const aiPublic = String(data?.public_reply ?? '').trim().slice(0, 1000);
    const dm = String(data?.dm ?? '').trim().slice(0, 1000);
    if (data?.needs_person || (!aiPublic && !dm)) {
      await leave(String(data?.reason ?? '').trim() || 'The AI left this comment for the team');
      return 'left_for_team';
    }
    // The shop's own public reply for this post, if it set one (Posts → What the AI sends).
    const custom = String(post.rules?.public_reply ?? '').trim();
    const publicReply = aiPublic && custom ? custom.slice(0, 1000) : aiPublic;
    // CMT-02: on Facebook the one private reply is the carousel of the post's products.
    const linked = (post.product_ids ?? []).length ? products : [];
    const cards = dm && linked.length && channel.platform === 'messenger' && post.rules?.dm_cards !== false
      ? toPlatform('messenger', productCards(linked, { publicUrl: config.publicUrl || '' })) : null;
    try {
      if (publicReply) await commentAction(config, channel, 'reply', { commentId: comment.external_id, text: publicReply }, fetchImpl);
      if (dm && !comment.dm_sent) await commentAction(config, channel, 'dm', { commentId: comment.external_id, text: dm, ...(cards ? { message: cards } : {}) }, fetchImpl);
    } catch (err) {
      await leave(`Facebook didn't accept the AI's reply: ${err.message}`);
      return 'send_failed';
    }
    await db.comments.updateOne({ _id: commentId }, { $set: { status: 'replied', replied_by: 'AI', public_reply: publicReply, ...(dm ? { dm_sent: true } : {}) } });
    emit(workspace._id, 'comment', { id: commentId, postId: post._id, status: 'replied' });
    return 'replied';
  }

  // CAT-06: which products a post shows, from its picture and caption. Saved as a suggestion
  // for the shop to confirm. Returns the suggested ids, or null when AI isn't set up.
  async function matchPost(postId) {
    if (!provider) return null;
    const post = await db.posts.findById(postId).lean();
    if (!post) return null;
    const products = await db.products.find({ workspace_id: post.workspace_id, archived: { $ne: true } }).sort({ name: 1 }).limit(200).lean();
    if (!products.length) return [];
    const ask = (withImage) => callModel(post.workspace_id, {
      system: buildPostMatchPrompt(products), schema: POST_MATCH_SCHEMA, maxTokens: 800,
      messages: [{ role: 'user', content: [
        { type: 'text', text: `Caption: ${post.caption?.trim() || '(no caption)'}` },
        ...(withImage && /^https:\/\//.test(post.image ?? '') ? [{ type: 'image', source: { type: 'url', url: post.image } }] : []),
      ] }],
    }, { kind: 'match', summary: 'Matched a post to products' });
    let data;
    try {
      ({ data } = await ask(true));
    } catch (err) {
      if (err.paused) throw err;
      log.warn(`post ${postId} match with picture failed (${err.message}); trying the caption only`);
      ({ data } = await ask(false));
    }
    const valid = new Set(products.map((p) => p._id));
    const ids = [...new Set((data?.product_ids ?? []).map(Number).filter((id) => valid.has(id)))].slice(0, 10);
    await db.posts.updateOne({ _id: post._id }, { $set: ids.length
      ? { suggested_ids: ids, match: (post.product_ids ?? []).length ? post.match : 'ai_match', match_source: 'ai', match_confidence: data?.confidence ?? '' }
      : { suggested_ids: [], match_source: 'ai', match_confidence: 'none' } });
    return ids;
  }

  return {
    onInbound,
    respond,
    replyToComment,
    matchPost,

    // Practice chat during onboarding: the owner plays a customer. Nothing is stored or sent to Meta.
    async practice(user, turns, { extraNotes = '', withActions = false } = {}) {
      if (!provider) throw new InboxError(503, 'AI replies are not set up on this server yet');
      if (!Array.isArray(turns) || !turns.length || turns.length > 30) throw new InboxError(400, 'Send the practice conversation');
      const messages = turns.map((t) => ({
        role: t?.role === 'assistant' ? 'assistant' : 'user',
        content: String(t?.content ?? '').trim().slice(0, 1000),
      })).filter((t) => t.content);
      if (!messages.length || messages.at(-1).role !== 'user') throw new InboxError(400, 'Write a customer message first');
      const [rawWorkspace, products, savedReplies, coupons] = await Promise.all([
        db.workspaces.findById(user.workspace_id).lean(),
        db.products.find({ workspace_id: user.workspace_id, archived: { $ne: true }, visibility: { $ne: 'hidden' } }).sort({ name: 1 }).limit(300).lean(),
        db.savedReplies.find({ workspace_id: user.workspace_id }).sort({ shortcut: 1 }).lean(),
        db.coupons.find({ workspace_id: user.workspace_id, active: { $ne: false } }).limit(10).lean(),
      ]);
      const trained = await withTraining(db, rawWorkspace);
      // A draft answer being previewed in "Teach the answer" is added on top, without saving it.
      const workspace = extraNotes ? { ...trained, shop_notes: `${trained.shop_notes ?? ''}

${extraNotes}` } : trained;
      const turnsForModel = toModelMessages(messages.map((m) => ({ direction: m.role === 'user' ? 'in' : 'out', text: m.content })));
      if (!turnsForModel) throw new InboxError(400, 'Write a customer message first');
      try {
        const { data } = await callModel(user.workspace_id, {
          system: buildSystemPrompt({ workspace, products, savedReplies, coupons }), messages: turnsForModel, schema: REPLY_SCHEMA,
        }, { kind: 'practice', summary: 'Test chat', customerName: 'Test chat' });
        lastError = null;
        const answer = normalize(data);
        // Onboarding's practice chat keeps its original answer shape (reply, handoff, reason, intent).
        if (!withActions) return { reply: answer.reply, handoff: answer.handoff, handoff_reason: answer.handoff_reason, intent: answer.intent };
        // The dashboard test chat shows the cards the customer would get (nothing is saved or sent).
        const byId = new Map(products.map((p) => [p._id, p]));
        let rich = null;
        if (answer.products.length) rich = productCards(answer.products.map((id) => byId.get(id)).filter(Boolean));
        else if (answer.quick_replies.length) rich = quickReplies(answer.reply, answer.quick_replies);
        return { ...answer, rich };
      } catch (err) {
        if (err.paused) throw err;
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
        answer = await generate(ctx, 'draft');
      } catch (err) {
        if (err.paused) throw err;
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
        const { data } = await callModel(user.workspace_id, {
          system: 'You help a shop team understand one customer. Answer briefly (1-3 sentences) from the chat and orders only. If the answer is not there, say so. Reply in the language of the question.',
          messages: [{ role: 'user', content: `Chat:\n${transcript || '(none)'}\n\nOrders:\n${orderLines || '(none)'}\n\nQuestion: ${question}` }],
          schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
          maxTokens: 600,
        }, { kind: 'copilot', conversationId, summary: 'Answered a teammate' });
        return String(data.answer ?? '').trim();
      } catch (err) {
        if (err.paused) throw err;
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

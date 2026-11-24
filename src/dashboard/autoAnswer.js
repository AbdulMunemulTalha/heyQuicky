import { aiModeOf } from './aiMode.js';
// Saved replies that answer by themselves (SR-02, SR-06, SR-07, SR-10): no AI call, no cost,
// and they keep working when the AI credit runs out.

const SALAM = /(assalamu?\s*alaikum|assalamualaikum|asalamualaikum|salam|সালাম|আসসালামু\s*আলাইকুম|আস্সালামু\s*আলাইকুম)/gi;
const ADDRESS = /\b(bhai|vai|bhaiya|vaiya|apu|apa|sir|madam|mam|dada|didi)\b|(ভাই|ভাইয়া|আপু|আপা|স্যার|ম্যাডাম)/gi;
const BN = '০১২৩৪৫৬৭৮৯';

// Ignores emoji, extra ??? and !!!, salam, bhai/apu and Bangla vs English digits.
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[০-৯]/g, (d) => String(BN.indexOf(d)))
    .replace(SALAM, ' ')
    .replace(ADDRESS, ' ')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, ' ')
    .replace(/[?!.,;:'"()\-–—।]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const words = (s) => new Set(normalize(s).split(' ').filter((w) => w.length > 1));

// How well a customer message fits one phrase: 1 = contains it, otherwise word overlap.
export function similarity(message, phrase) {
  const m = normalize(message);
  const p = normalize(phrase);
  if (!m || !p) return 0;
  if (m.includes(p)) return 1;
  const a = words(m);
  const b = words(p);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const w of b) if (a.has(w)) common += 1;
  return common / Math.max(b.size, Math.min(a.size, b.size + 2));
}

export function matchReply(message, replies, { threshold = 0.75 } = {}) {
  let best = null;
  for (const r of replies) {
    for (const phrase of r.phrases ?? []) {
      const score = similarity(message, phrase);
      if (score >= threshold && (!best || score > best.score)) best = { reply: r, phrase, score };
    }
  }
  return best;
}

// Personal blanks: {name}, {order_number}, {order_total}, {cod}, {delivery_charge}, {tracking}.
// Returns null when a blank can't be filled — the reply is then never sent on its own (SR-07: never guess).
export function fillBlanks(text, ctx) {
  let missing = false;
  const out = String(text).replace(/\{(\w+)\}/g, (_m, key) => {
    const v = ctx[key];
    if (v === undefined || v === null || v === '') { missing = true; return ''; }
    return String(v);
  });
  return missing ? null : out;
}

// Turns the reply's blocks into what is sent. Product prices come from the live catalog;
// a hidden, archived or sold-out product stops the reply from going out by itself (SR-06).
export function renderReply(reply, products) {
  const parts = [reply.text];
  for (const b of reply.blocks ?? []) {
    if (b.type === 'message' && b.text) parts.push(b.text);
    if (b.type === 'product') {
      const p = products.get(Number(b.productId));
      if (!p || p.archived || p.visibility === 'hidden' || p.in_stock === false) return null;
      parts.push(`${p.name} — ৳${Number(p.price).toLocaleString('en-IN')}${p.compare_at ? ` (আগে ৳${Number(p.compare_at).toLocaleString('en-IN')})` : ''}`);
    }
    if ((b.type === 'photo' || b.type === 'voice') && b.url) parts.push(b.url);
  }
  return parts.filter(Boolean).join('\n\n');
}

// Digits that look like a phone or bKash number but have the wrong length (SR-09).
export function numberMistakes(text) {
  const found = [];
  const ascii = String(text ?? '').replace(/[০-৯]/g, (d) => String(BN.indexOf(d)));
  for (const m of ascii.matchAll(/(?:\+?88)?0?1[\d\s-]{6,14}\d/g)) {
    const digits = m[0].replace(/\D/g, '').replace(/^88/, '');
    if (digits.startsWith('01') && digits.length !== 11) found.push({ value: m[0].trim(), digits: digits.length });
  }
  return found;
}

// Answers the newest customer message with a saved reply if one fits. Returns true when it did.
export async function tryAutoAnswer(db, inbox, conversationId, messageId) {
  const conv = await db.conversations.findById(conversationId).lean();
  if (!conv || conv.spam || conv.status === 'closed') return false;
  if (conv.ai_handoff && (!conv.human_until || new Date(conv.human_until) > new Date())) return false; // a teammate has it
  const ws = await db.workspaces.findById(conv.workspace_id, { ai_mode: 1, settings: 1 }).lean();
  if (aiModeOf(ws) !== 'auto') return false;
  const channel = await db.channels.findById(conv.channel_id, { ai_enabled: 1 }).lean();
  if (channel?.ai_enabled === false) return false;
  const customer = conv.customer_id ? await db.customers.findById(conv.customer_id).lean() : null;
  if (customer?.ai_off || customer?.blocked) return false;
  const last = await db.messages.findOne({ conversation_id: conversationId }).sort({ _id: -1 }).lean();
  if (!last || last._id !== messageId || last.direction !== 'in' || !last.text) return false;
  const replies = await db.savedReplies.find({ workspace_id: conv.workspace_id, auto_answer: true, scope: { $ne: 'private' } }).lean();
  const hit = matchReply(last.text, replies);
  if (!hit) return false;
  const productIds = (hit.reply.blocks ?? []).filter((b) => b.type === 'product').map((b) => Number(b.productId));
  const products = new Map((await db.products.find({ _id: { $in: productIds } }).lean()).map((p) => [p._id, p]));
  const order = customer ? await db.orders.findOne({ customer_id: customer._id, draft: { $ne: true } }).sort({ created_at: -1 }).lean() : null;
  const body = renderReply(hit.reply, products);
  const text = body && fillBlanks(body, {
    name: customer?.name?.split(' ')[0], order_number: order?.number, order_total: order && order.subtotal + order.delivery_charge - (order.discount ?? 0),
    cod: order?.cod_amount, delivery_charge: order?.delivery_charge, tracking: order?.consignment_id,
  });
  if (!text) return false;
  const message = await inbox.sendAiReply(conversationId, text);
  if (!message) return false;
  await db.messages.updateOne({ _id: message.id }, { $set: { kind: 'saved', payload: { savedReplyId: hit.reply._id, phrase: hit.phrase } } });
  await db.savedReplies.updateOne({ _id: hit.reply._id }, { $inc: { uses: 1, answered_count: 1 } });
  await db.insert(db.aiReplies, { workspace_id: conv.workspace_id, conversation_id: conversationId, message_id: message.id, kind: 'saved', cost: 0,
    summary: `Saved reply "${hit.reply.name || hit.reply.shortcut}"`, customer_name: customer?.name ?? '' });
  await inbox.refresh(conversationId);
  return true;
}

export async function hasAutoAnswers(db, conversationId) {
  const conv = await db.conversations.findById(conversationId, { workspace_id: 1 }).lean();
  return Boolean(conv && await db.savedReplies.exists({ workspace_id: conv.workspace_id, auto_answer: true }));
}

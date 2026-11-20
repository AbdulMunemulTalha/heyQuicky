import express, { Router } from 'express';
import { InboxError } from '../../inbox.js';
import { need } from '../../dashboard/permissions.js';
import { audit } from '../../dashboard/util.js';
import { publish, rollback } from '../../dashboard/training.js';
import { readiness } from '../../dashboard/readiness.js';

export const RULE_CATEGORIES = ['tone', 'selling', 'never', 'handoff', 'other'];
// The six reasons in the Teach popup (older ones still accepted).
export const TEACH_REASONS = ['wrong_info', 'misunderstood', 'should_hand_off', 'tone', 'made_up', 'too_long', 'missing_info', 'other'];

// "Use this answer when…" choices, worked out from the question and the products in the chat.
const TOPIC_WORDS = {
  size: /size|সাইজ|মাপ|\b(3[0-9]|4[0-9]|5[0-2])\b|xl|xxl|\bs\b|\bm\b|\bl\b/i,
  price: /price|dam|দাম|koto|কত|taka|টাকা/i,
  delivery: /deliver|ডেলিভারি|kobe|কবে|pabo|পাব|courier|কুরিয়ার/i,
  exchange: /exchange|bodol|বদল|return|ferot|ফেরত|refund/i,
};
export function teachSuggestions(question, product) {
  const q = String(question ?? '');
  const out = [];
  if (TOPIC_WORDS.size.test(q)) {
    if (/\b(3[0-9]|4[0-9]|5[0-2])\b|[৩৪৫][০-৯]/.test(q)) out.push('Someone asks for a size by number (40, 42, 44)');
    if (product) out.push(`Only for ${product.category || product.name}`);
    out.push('Any size question');
  } else if (TOPIC_WORDS.exchange.test(q)) {
    out.push('Someone asks about exchange or return');
    if (product) out.push(`Only for ${product.category || product.name}`);
  } else if (TOPIC_WORDS.delivery.test(q)) {
    out.push('Someone asks when the parcel will arrive', 'Any delivery question');
  } else if (TOPIC_WORDS.price.test(q)) {
    out.push('Someone asks the price');
    if (product) out.push(`Only for ${product.name}`);
  } else {
    out.push('Someone asks this in other words');
    if (product) out.push(`Only for ${product.category || product.name}`);
  }
  return [...new Set(out)].slice(0, 3);
}

const clean = (v, max) => String(v ?? '').trim().slice(0, max);

// Phase 2 · Training (TRN-02/03/04/05/07): readiness and gaps, unanswered questions,
// the rules the AI always follows (with a preview), versions with rollback, and
// teaching the AI from a reply in a chat.
export function trainingRoutes(db, _config, { auth, agent, emit }) {
  const router = Router();
  const teach = need(db, 'teach_ai');
  const aiReady = () => Boolean(agent?.status().available);

  router.get('/training', auth, async (req, res) => {
    const ws = req.user.workspace_id;
    const days = [7, 14, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 14;
    const since = new Date(Date.now() - days * 86_400_000);
    const [score, unanswered, rules, versions] = await Promise.all([
      readiness(db, ws),
      db.unanswered.find({ workspace_id: ws, status: 'open', last_asked_at: { $gte: since } }).sort({ count: -1, last_asked_at: -1 }).limit(50).lean(),
      db.aiRules.find({ workspace_id: ws }).sort({ created_at: 1 }).lean(),
      db.aiVersions.find({ workspace_id: ws }).sort({ number: -1 }).limit(30).lean(),
    ]);
    res.json({
      readiness: score, days, aiReady: aiReady(),
      unanswered: unanswered.map((u) => ({ id: u._id, question: u.question, count: u.count, lastAt: u.last_asked_at })),
      rules: rules.map((r) => ({ id: r._id, text: r.text, category: r.category, enabled: r.enabled, author: r.author, at: r.created_at })),
      versions: versions.map((v, i) => ({ id: v._id, number: v.number, summary: v.summary, by: v.by_name, source: v.source, at: v.created_at, live: i === 0 })),
    });
  });

  // "How the customer sees it": the AI answers a sample question with the new instruction added. Nothing saved.
  router.post('/training/rules/preview', auth, teach, async (req, res) => {
    const text = clean(req.body?.text, 500);
    const question = clean(req.body?.question, 300) || 'Apu, eta ache? dam koto?';
    if (!text) throw new InboxError(400, 'Write the instruction first');
    if (!aiReady()) return res.json({ reply: null, ai: false });
    const out = await agent.practice(req.user, [{ role: 'user', content: question }], { extraNotes: `Rule the shop always wants followed:\n- ${text}` });
    res.json({ reply: out.reply, ai: true, question });
  });

  router.post('/training/rules', auth, teach, async (req, res) => {
    const text = clean(req.body?.text, 500);
    if (!text) throw new InboxError(400, 'Write the instruction');
    const category = RULE_CATEGORIES.includes(req.body?.category) ? req.body.category : 'other';
    if (await db.aiRules.countDocuments({ workspace_id: req.user.workspace_id }) >= 50) throw new InboxError(409, 'You have 50 rules — remove one before adding another');
    const rule = await db.insert(db.aiRules, { workspace_id: req.user.workspace_id, text, category, enabled: true, author: req.user.name });
    const v = await publish(db, req.user, `New rule: ${text.slice(0, 60)}`, 'rule');
    await audit(db, req.user, `Published AI version ${v.number} (new rule)`, { where: 'AI training' });
    res.status(201).json({ id: rule.id, version: v.number });
  });

  router.patch('/training/rules/:id', auth, teach, async (req, res) => {
    const rule = await db.aiRules.findOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id }).lean();
    if (!rule) throw new InboxError(404, 'Rule not found');
    const set = {};
    if (typeof req.body?.enabled === 'boolean') set.enabled = req.body.enabled;
    if (req.body?.text !== undefined) { set.text = clean(req.body.text, 500); if (!set.text) throw new InboxError(400, 'Write the instruction'); }
    if (RULE_CATEGORIES.includes(req.body?.category)) set.category = req.body.category;
    if (!Object.keys(set).length) throw new InboxError(400, 'Nothing to change');
    await db.aiRules.updateOne({ _id: rule._id }, { $set: set });
    const what = set.enabled === false ? 'Rule paused' : set.enabled === true && Object.keys(set).length === 1 ? 'Rule turned on' : 'Rule changed';
    const v = await publish(db, req.user, `${what}: ${(set.text ?? rule.text).slice(0, 60)}`, 'rule');
    res.json({ version: v.number });
  });

  router.delete('/training/rules/:id', auth, teach, async (req, res) => {
    const rule = await db.aiRules.findOneAndDelete({ _id: Number(req.params.id), workspace_id: req.user.workspace_id }).lean();
    if (!rule) throw new InboxError(404, 'Rule not found');
    const v = await publish(db, req.user, `Rule removed: ${rule.text.slice(0, 60)}`, 'rule');
    res.json({ version: v.number });
  });

  // "Roll back to this" (TRN-05): restores that version exactly, recorded as a new version.
  router.post('/training/versions/:number/rollback', auth, teach, async (req, res) => {
    const number = Number(req.params.number);
    const latest = await db.aiVersions.findOne({ workspace_id: req.user.workspace_id }).sort({ number: -1 }).lean();
    if (latest?.number === number) throw new InboxError(409, 'That version is already live');
    const v = await rollback(db, req.user, number);
    if (!v) throw new InboxError(404, 'Version not found');
    await audit(db, req.user, `Rolled the AI back to version ${number}`, { where: 'AI training' });
    res.json({ version: v.number, restored: number });
  });

  // Teach popup (TRN-02): the reply the AI gave in a chat and what the customer asked.
  async function aiMessage(req) {
    const m = await db.messages.findById(Number(req.params.messageId)).lean();
    const conv = m && await db.conversations.findOne({ _id: m.conversation_id, workspace_id: req.user.workspace_id }, { _id: 1 }).lean();
    if (!m || !conv || !m.sent_by_ai) throw new InboxError(404, 'AI reply not found');
    const asked = await db.messages.findOne({ conversation_id: m.conversation_id, direction: 'in', _id: { $lt: m._id } }).sort({ _id: -1 }).lean();
    const question = asked ? [asked.text, ...(asked.attachments ?? []).map((a) => a.transcript).filter(Boolean)].filter(Boolean).join(' ').trim() : '';
    return { m, question };
  }

  // The product the chat is about: the last product card the AI sent, or a product named in the chat.
  async function chatProduct(m) {
    const recent = await db.messages.find({ conversation_id: m.conversation_id, _id: { $lte: m._id } }).sort({ _id: -1 }).limit(20).lean();
    const conv = await db.conversations.findById(m.conversation_id, { workspace_id: 1 }).lean();
    const ids = recent.flatMap((x) => (x.payload?.cards ?? []).map((c) => c.productId)).filter(Boolean);
    if (ids.length) return db.products.findOne({ _id: ids[0], workspace_id: conv.workspace_id }).lean();
    const products = await db.products.find({ workspace_id: conv.workspace_id, archived: { $ne: true } }, { name: 1, category: 1, size_chart_id: 1 }).limit(300).lean();
    const text = recent.map((x) => x.text ?? '').join(' ').toLowerCase();
    return products.find((p) => p.name && text.includes(p.name.toLowerCase())) ?? null;
  }

  router.get('/training/teach/:messageId', auth, teach, async (req, res) => {
    const { m, question } = await aiMessage(req);
    const product = await chatProduct(m);
    const sizeQuestion = TOPIC_WORDS.size.test(question);
    res.json({ messageId: m._id, asked: question, replied: m.text, aiReady: aiReady(), voice: Boolean(agent?.transcribe),
      suggestions: teachSuggestions(question, product),
      sizeChart: sizeQuestion && product?.size_chart_id ? { productId: product._id, name: product.name } : null });
  });

  router.post('/training/teach/:messageId', auth, teach, async (req, res) => {
    const { m, question: asked } = await aiMessage(req);
    const reason = TEACH_REASONS.includes(req.body?.reason) ? req.body.reason : 'other';
    const answer = clean(req.body?.answer, 2000);
    const question = clean(req.body?.question, 300) || asked;
    if (!answer) throw new InboxError(400, 'Write the right answer');
    if (!question) throw new InboxError(400, 'Write what the customer asked');
    const when = (Array.isArray(req.body?.when) ? req.body.when : []).map((w) => clean(w, 80)).filter(Boolean).slice(0, 5);
    // "Also send the size chart image": only for a product of this shop that has a chart.
    let attach = [];
    if (req.body?.sizeChartProductId) {
      const p = await db.products.findOne({ _id: Number(req.body.sizeChartProductId), workspace_id: req.user.workspace_id, size_chart_id: { $ne: null } }, { _id: 1 }).lean();
      if (p) attach = [`size_chart:${p._id}`];
    }
    const taught = await db.insert(db.taughtAnswers, { workspace_id: req.user.workspace_id, question, answer, when, attach, from_message_id: m._id, reason });
    // "Should have handed off" also becomes a rule, so the AI hands similar chats to the team.
    if (reason === 'should_hand_off') await db.insert(db.aiRules, { workspace_id: req.user.workspace_id, text: `Hand off to the team when a customer asks: "${question.slice(0, 160)}"`, category: 'handoff', author: req.user.name });
    const v = await publish(db, req.user, `Taught from a chat: ${question.slice(0, 60)}`, 'teach');
    await db.taughtAnswers.updateOne({ _id: taught.id }, { $set: { version: v.number } });
    await audit(db, req.user, `Published AI version ${v.number} (taught from a chat)`, { where: 'AI training' });
    // "Tested": the AI answers the same question again with the new answer in place.
    let tested = null;
    if (aiReady()) tested = (await agent.practice(req.user, [{ role: 'user', content: question }]).catch(() => null))?.reply ?? null;
    emit(req.user.workspace_id, 'unanswered', {});
    res.status(201).json({ version: v.number, tested });
  });

  // "Hold to speak" in the Teach popup: a voice recording becomes the answer's text (needs OPENAI_API_KEY).
  router.post('/training/transcribe', auth, teach, express.raw({ type: ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav'], limit: '10mb' }), async (req, res) => {
    if (!agent?.transcribe) throw new InboxError(503, 'Voice input needs OPENAI_API_KEY on this server');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new InboxError(400, 'Record your answer first');
    const out = await agent.transcribe(req.user.workspace_id, { bytes: req.body, mime: req.get('content-type') });
    res.json({ text: out.text });
  });

  return router;
}

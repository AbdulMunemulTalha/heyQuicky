import { Router } from 'express';
import { InboxError } from '../../inbox.js';
import { need } from '../../dashboard/permissions.js';
import { audit, dhakaDayStart } from '../../dashboard/util.js';
import { publish, rollback } from '../../dashboard/training.js';
import { AI_STYLES, AI_ADDRESS, AI_SALES } from '../../db.js';

const DELAYS = ['instant', '1-3', '3-6', '6-10'];
const KINDS = ['policy', 'delivery', 'exchange', 'hours', 'faq', 'payment', 'other'];

// Screen 07: the AI's persona, channel switches, knowledge book, unanswered questions, versions and test chat.
export function agentRoutes(db, _config, { auth, agent, emit }) {
  const router = Router();

  router.get('/agent', auth, async (req, res) => {
    const ws = await db.workspaces.findById(req.user.workspace_id).lean();
    const weekAgo = dhakaDayStart(new Date(), -6);
    const [channels, unanswered, knowledge, version, replies, saved, handed] = await Promise.all([
      db.channels.find({ workspace_id: ws._id }, { platform: 1, name: 1, ai_enabled: 1 }).lean(),
      db.unanswered.find({ workspace_id: ws._id, status: 'open' }).sort({ count: -1, last_asked_at: -1 }).limit(20).lean(),
      db.knowledge.find({ workspace_id: ws._id }).sort({ created_at: 1 }).lean(),
      db.aiVersions.findOne({ workspace_id: ws._id }).sort({ number: -1 }).lean(),
      db.aiReplies.aggregate([{ $match: { workspace_id: ws._id, kind: 'reply', created_at: { $gte: weekAgo } } }, { $group: { _id: null, n: { $sum: 1 }, cost: { $sum: '$cost' } } }]),
      db.aiReplies.countDocuments({ workspace_id: ws._id, kind: 'saved', created_at: { $gte: weekAgo } }),
      db.conversations.countDocuments({ workspace_id: ws._id, ai_handoff_at: { $gte: weekAgo } }),
    ]);
    const persona = ws.settings?.persona ?? {};
    res.json({
      persona: { name: ws.ai_name || '', role: persona.role || '', style: ws.ai_style, sales: ws.ai_sales, address: ws.ai_address, delay: DELAYS.includes(persona.delay) ? persona.delay : '3-6', autoReturnMin: ws.settings?.auto_return_min ?? 30 },
      aiMode: ws.ai_mode, available: Boolean(agent?.status().available),
      channels: [
        ...channels.map((c) => ({ id: c._id, platform: c.platform, name: c.name, on: c.ai_enabled !== false })),
        { id: 'comments', platform: 'comments', name: 'Comments', on: ws.settings?.comments_ai !== false },
      ],
      version: version ? { number: version.number, by: version.by_name, at: version.created_at, summary: version.summary, canUndo: version.number > 1 } : null,
      unanswered: unanswered.map((u) => ({ id: u._id, question: u.question, count: u.count, lastAskedAt: u.last_asked_at, topic: u.topic })),
      knowledge: knowledge.map((k) => ({ id: k._id, kind: k.kind, title: k.title, text: k.text, source: k.source })),
      week: { replies: replies[0]?.n ?? 0, cost: replies[0]?.cost ?? 0, saved, handed },
    });
  });

  router.patch('/agent/persona', auth, need(db, 'teach_ai'), async (req, res) => {
    const b = req.body ?? {};
    const set = {};
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name || name.length > 30) throw new InboxError(400, 'Give the assistant a name (up to 30 letters)');
      set.ai_name = name;
    }
    if (b.role !== undefined) set['settings.persona.role'] = String(b.role).trim().slice(0, 40);
    if (b.style !== undefined) { if (!AI_STYLES.includes(b.style)) throw new InboxError(400, 'Unknown tone'); set.ai_style = b.style; }
    if (b.sales !== undefined) { if (!AI_SALES.includes(b.sales)) throw new InboxError(400, 'Unknown sales style'); set.ai_sales = b.sales; }
    if (b.address !== undefined) { if (!AI_ADDRESS.includes(b.address)) throw new InboxError(400, 'Unknown way to address customers'); set.ai_address = b.address; }
    if (b.delay !== undefined) { if (!DELAYS.includes(b.delay)) throw new InboxError(400, 'Unknown reply delay'); set['settings.persona.delay'] = b.delay; }
    if (b.autoReturnMin !== undefined) {
      const m = Number(b.autoReturnMin);
      if (![0, 15, 30, 60, 120, 720].includes(m)) throw new InboxError(400, 'Pick when the AI comes back after a takeover');
      set['settings.auto_return_min'] = m;
    }
    if (!Object.keys(set).length) throw new InboxError(400, 'Nothing to change');
    await db.workspaces.updateOne({ _id: req.user.workspace_id }, { $set: set });
    const v = await publish(db, req.user, 'Persona updated', 'persona');
    await audit(db, req.user, `Published AI version ${v.number} (persona)`, { where: 'AI agent' });
    res.json({ version: v.number });
  });

  // Per-channel AI switches (INB-11). Comments have their own switch.
  router.patch('/agent/channels/:id', auth, need(db, 'teach_ai'), async (req, res) => {
    const on = Boolean(req.body?.on);
    if (req.params.id === 'comments') {
      await db.workspaces.updateOne({ _id: req.user.workspace_id }, { $set: { 'settings.comments_ai': on } });
    } else {
      const r = await db.channels.updateOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id }, { $set: { ai_enabled: on } });
      if (!r.matchedCount) throw new InboxError(404, 'Channel not found');
    }
    await audit(db, req.user, `Turned ${on ? 'on' : 'off'} AI for ${req.params.id === 'comments' ? 'comments' : `channel ${req.params.id}`}`, { where: 'AI agent' });
    res.json({ on });
  });

  // Knowledge book (TRN-01): policies, delivery, exchange, hours, FAQs in plain language.
  router.post('/agent/knowledge', auth, need(db, 'teach_ai'), async (req, res) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text || text.length > 2000) throw new InboxError(400, 'Write what the AI should know (up to 2,000 characters)');
    const kind = KINDS.includes(req.body?.kind) ? req.body.kind : 'faq';
    const k = await db.insert(db.knowledge, { workspace_id: req.user.workspace_id, kind, title: String(req.body?.title ?? '').trim().slice(0, 80), text, source: req.body?.source === 'voice' ? 'voice' : 'owner' });
    const v = await publish(db, req.user, `Knowledge: ${(k.title || text).slice(0, 50)}`, 'knowledge');
    res.status(201).json({ id: k.id, version: v.number });
  });

  router.patch('/agent/knowledge/:id', auth, need(db, 'teach_ai'), async (req, res) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text || text.length > 2000) throw new InboxError(400, 'Write what the AI should know');
    const r = await db.knowledge.updateOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id }, { $set: { text, title: String(req.body?.title ?? '').trim().slice(0, 80) } });
    if (!r.matchedCount) throw new InboxError(404, 'Not found');
    const v = await publish(db, req.user, `Knowledge edited: ${text.slice(0, 50)}`, 'knowledge');
    res.json({ version: v.number });
  });

  router.delete('/agent/knowledge/:id', auth, need(db, 'teach_ai'), async (req, res) => {
    const r = await db.knowledge.deleteOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id });
    if (!r.deletedCount) throw new InboxError(404, 'Not found');
    await publish(db, req.user, 'Knowledge removed', 'knowledge');
    res.sendStatus(204);
  });

  // "Preview — exactly what the customer sees": the AI answers the question with the draft answer added, nothing saved.
  router.post('/agent/preview', auth, need(db, 'teach_ai'), async (req, res) => {
    const question = String(req.body?.question ?? '').trim().slice(0, 500);
    const answer = String(req.body?.answer ?? '').trim().slice(0, 2000);
    if (!question || !answer) throw new InboxError(400, 'Write the answer first');
    if (!agent?.status().available) return res.json({ reply: answer, ai: false });
    const out = await agent.practice(req.user, [{ role: 'user', content: question }], { extraNotes: `Answer the shop just taught:\n- Q: ${question}\n  A: ${answer}` });
    res.json({ reply: out.reply || answer, ai: true });
  });

  // "Teach the answer" / "Turn on for customers" (TRN-02/04): saved as a taught answer and published as a new version.
  router.post('/agent/unanswered/:id/teach', auth, need(db, 'teach_ai'), async (req, res) => {
    const u = await db.unanswered.findOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id }).lean();
    if (!u) throw new InboxError(404, 'Question not found');
    const answer = String(req.body?.answer ?? '').trim();
    if (!answer || answer.length > 2000) throw new InboxError(400, 'Write the right answer');
    const taught = await db.insert(db.taughtAnswers, { workspace_id: u.workspace_id, question: u.question, answer, when: (req.body?.when ?? []).map(String).slice(0, 5) });
    const v = await publish(db, req.user, `Taught: ${u.question.slice(0, 60)}`, 'teach');
    await db.taughtAnswers.updateOne({ _id: taught.id }, { $set: { version: v.number } });
    await db.unanswered.updateOne({ _id: u._id }, { $set: { status: 'taught' } });
    await audit(db, req.user, `Published AI version ${v.number} (taught "${u.question.slice(0, 40)}")`, { where: 'AI training' });
    emit(u.workspace_id, 'unanswered', { id: u._id });
    res.json({ version: v.number });
  });

  router.post('/agent/unanswered/:id/hide', auth, need(db, 'teach_ai'), async (req, res) => {
    const r = await db.unanswered.updateOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id }, { $set: { status: 'ignored' } });
    if (!r.matchedCount) throw new InboxError(404, 'Question not found');
    emit(req.user.workspace_id, 'unanswered', { id: Number(req.params.id) });
    res.json({ ok: true });
  });

  // "Undo last publish" (TRN-05).
  router.post('/agent/undo', auth, need(db, 'teach_ai'), async (req, res) => {
    const versions = await db.aiVersions.find({ workspace_id: req.user.workspace_id }).sort({ number: -1 }).limit(2).lean();
    if (versions.length < 2) throw new InboxError(409, 'There is no earlier version to go back to');
    const v = await rollback(db, req.user, versions[1].number);
    await audit(db, req.user, `Undid AI version ${versions[0].number}`, { where: 'AI agent' });
    res.json({ version: v.number, restored: versions[1].number });
  });

  // Test chat (TRN-08): chat as a customer; nothing is stored or sent.
  router.post('/agent/test', auth, async (req, res) => {
    if (!agent?.status().available) throw new InboxError(503, 'The AI is not set up on this server yet. Add ANTHROPIC_API_KEY to try the test chat.');
    const out = await agent.practice(req.user, req.body?.turns ?? []);
    res.json(out);
  });

  return router;
}

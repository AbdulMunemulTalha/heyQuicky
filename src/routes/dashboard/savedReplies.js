import { Router } from 'express';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { InboxError } from '../../inbox.js';
import { need } from '../../dashboard/permissions.js';
import { audit, dhakaDayStart } from '../../dashboard/util.js';
import { isDuplicateKey } from '../../db.js';
import { normalize, similarity, matchReply, numberMistakes } from '../../dashboard/autoAnswer.js';

const BLOCKS = ['message', 'photo', 'product', 'voice', 'blank'];
const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/webm', 'audio/aac'];

// Screen 06: saved replies, auto-answers, phrase discovery and impact preview (SR-01…SR-10).
export function savedReplyRoutes(db, _config, { auth }) {
  const router = Router();

  const publicReply = (r) => ({
    id: r._id, name: r.name || r.shortcut.replace(/^\//, ''), shortcut: r.shortcut.startsWith('/') ? r.shortcut : `/${r.shortcut}`, text: r.text,
    folder: r.folder || '', pinned: Boolean(r.pinned), scope: r.scope ?? 'team', mine: true, blocks: r.blocks ?? [], phrases: r.phrases ?? [],
    autoAnswer: Boolean(r.auto_answer), uses: r.uses ?? 0, answered: r.answered_count ?? 0,
  });

  router.get('/saved-replies/library', auth, async (req, res) => {
    const ws = req.user.workspace_id;
    const list = await db.savedReplies.find({ workspace_id: ws, $or: [{ scope: { $ne: 'private' } }, { owner_user_id: req.user.id }] }).sort({ pinned: -1, uses: -1, shortcut: 1 }).lean();
    const weekAgo = dhakaDayStart(new Date(), -6);
    const answeredWeek = await db.aiReplies.countDocuments({ workspace_id: ws, kind: 'saved', created_at: { $gte: weekAgo } });
    const folders = [...new Set(list.map((r) => r.folder).filter(Boolean))].sort();
    res.json({ items: list.map(publicReply), folders, answeredWeek });
  });

  function clean(body, existing) {
    const name = String(body?.name ?? existing?.name ?? '').trim();
    let shortcut = String(body?.shortcut ?? existing?.shortcut ?? '').trim().toLowerCase().replace(/\s+/g, '-');
    if (!shortcut.startsWith('/')) shortcut = `/${shortcut}`;
    const text = String(body?.text ?? existing?.text ?? '').trim();
    if (!name || name.length > 60) throw new InboxError(400, 'Give the reply a name');
    if (!/^\/[\p{L}\p{N}_-]{1,30}$/u.test(shortcut)) throw new InboxError(400, 'The shortcut is a / and up to 30 letters or numbers, like /delivery');
    if (!text || text.length > 2000) throw new InboxError(400, 'Write the reply (up to 2,000 characters)');
    const blocks = (Array.isArray(body?.blocks) ? body.blocks : existing?.blocks ?? []).slice(0, 10).map((b) => {
      if (!BLOCKS.includes(b?.type)) throw new InboxError(400, 'Unknown block in the reply');
      return { type: b.type, text: String(b.text ?? '').slice(0, 1000), url: String(b.url ?? '').slice(0, 500), productId: b.productId ? Number(b.productId) : null, label: String(b.label ?? '').slice(0, 60) };
    });
    const phrases = [...new Set((Array.isArray(body?.phrases) ? body.phrases : existing?.phrases ?? []).map((p) => String(p).trim()).filter(Boolean))].slice(0, 30);
    if (phrases.some((p) => p.length > 120)) throw new InboxError(400, 'Keep each customer phrase short');
    return {
      name, shortcut, text, blocks, phrases,
      folder: String(body?.folder ?? existing?.folder ?? '').trim().slice(0, 30),
      scope: (body?.scope ?? existing?.scope) === 'private' ? 'private' : 'team',
      pinned: Boolean(body?.pinned ?? existing?.pinned),
      auto_answer: Boolean(body?.autoAnswer ?? existing?.auto_answer) && phrases.length > 0,
    };
  }

  router.post('/saved-replies/library', auth, need(db, 'reply'), async (req, res) => {
    const fields = clean(req.body);
    try {
      const r = await db.insert(db.savedReplies, { workspace_id: req.user.workspace_id, owner_user_id: req.user.id, ...fields });
      await audit(db, req.user, `Created saved reply ${fields.shortcut}`, { where: 'Saved replies' });
      res.status(201).json({ ...publicReply({ ...r, _id: r.id }), warnings: numberMistakes(fields.text) });
    } catch (err) {
      if (isDuplicateKey(err)) throw new InboxError(409, `${fields.shortcut} is already used by another saved reply`);
      throw err;
    }
  });

  async function load(req) {
    const r = await db.savedReplies.findOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id }).lean();
    if (!r || (r.scope === 'private' && r.owner_user_id !== req.user.id)) throw new InboxError(404, 'Saved reply not found');
    return r;
  }

  router.patch('/saved-replies/library/:id', auth, need(db, 'reply'), async (req, res) => {
    const r = await load(req);
    const fields = clean(req.body, r);
    try {
      await db.savedReplies.updateOne({ _id: r._id }, { $set: fields });
    } catch (err) {
      if (isDuplicateKey(err)) throw new InboxError(409, `${fields.shortcut} is already used by another saved reply`);
      throw err;
    }
    await audit(db, req.user, `Edited saved reply ${fields.shortcut}`, { where: 'Saved replies' });
    res.json({ ...publicReply({ ...r, ...fields }), warnings: numberMistakes(fields.text) });
  });

  router.delete('/saved-replies/library/:id', auth, need(db, 'reply'), async (req, res) => {
    const r = await load(req);
    await db.savedReplies.deleteOne({ _id: r._id });
    await audit(db, req.user, `Deleted saved reply ${r.shortcut}`, { where: 'Saved replies' });
    res.sendStatus(204);
  });

  // "Would have answered 214 messages from 160 customers in 14 days" (SR-04).
  router.post('/saved-replies/impact', auth, async (req, res) => {
    const phrases = (req.body?.phrases ?? []).map(String).filter(Boolean).slice(0, 30);
    if (!phrases.length) return res.json({ messages: 0, customers: 0, days: 14 });
    const ws = req.user.workspace_id;
    const convs = await db.conversations.find({ workspace_id: ws }, { _id: 1, customer_id: 1 }).lean();
    const custOf = new Map(convs.map((c) => [c._id, c.customer_id ?? c._id]));
    const since = new Date(Date.now() - 14 * 86_400_000);
    const msgs = await db.messages.find({ conversation_id: { $in: convs.map((c) => c._id) }, direction: 'in', created_at: { $gte: since }, text: { $ne: '' } }, { text: 1, conversation_id: 1 }).limit(20_000).lean();
    const fake = [{ phrases }];
    const hits = msgs.filter((m) => matchReply(m.text, fake));
    res.json({ messages: hits.length, customers: new Set(hits.map((m) => custOf.get(m.conversation_id))).size, days: 14 });
  });

  // Phrase discovery (SR-03): how customers actually asked, from real chats, that the phrases don't cover yet.
  router.post('/saved-replies/discover', auth, async (req, res) => {
    const phrases = (req.body?.phrases ?? []).map(String).filter(Boolean);
    const seed = [...phrases, String(req.body?.name ?? '')].filter(Boolean);
    if (!seed.length) return res.json([]);
    const convIds = await db.conversations.distinct('_id', { workspace_id: req.user.workspace_id });
    const msgs = await db.messages.find({ conversation_id: { $in: convIds }, direction: 'in', text: { $ne: '' }, created_at: { $gte: new Date(Date.now() - 60 * 86_400_000) } }, { text: 1 })
      .sort({ _id: -1 }).limit(5000).lean();
    const counts = new Map();
    for (const m of msgs) {
      const n = normalize(m.text);
      if (!n || n.length > 60) continue;
      const related = seed.some((p) => similarity(m.text, p) >= 0.34);
      const covered = phrases.some((p) => similarity(m.text, p) >= 0.75);
      if (!related || covered) continue;
      const entry = counts.get(n) ?? { text: m.text.trim(), count: 0 };
      entry.count += 1;
      counts.set(n, entry);
    }
    res.json([...counts.values()].sort((a, b) => b.count - a.count).slice(0, 6));
  });

  router.post('/saved-replies/check', auth, (req, res) => res.json({ warnings: numberMistakes(req.body?.text) }));

  // Photos and voice notes for saved replies (SR-05). Stored in MongoDB so they survive redeploys.
  router.post('/uploads', auth, express.raw({ type: UPLOAD_TYPES, limit: '5mb' }), async (req, res) => {
    const type = req.get('content-type');
    if (!UPLOAD_TYPES.includes(type) || !Buffer.isBuffer(req.body) || !req.body.length) throw new InboxError(400, 'Upload a photo (JPG, PNG, WebP) or a voice note under 5 MB');
    const id = randomBytes(12).toString('hex');
    await db.files.create({ _id: id, workspace_id: req.user.workspace_id, type, size: req.body.length, data: req.body, name: String(req.get('x-file-name') ?? '').slice(0, 100) });
    res.status(201).json({ url: `/files/${id}`, type, size: req.body.length });
  });

  return router;
}

// Serves uploaded files publicly (the link is unguessable), so Messenger can fetch them.
export function fileRoute(db) {
  return async (req, res, next) => {
    try {
      const f = await db.files.findById(String(req.params.id)).lean();
      if (!f) return res.sendStatus(404);
      res.set('Cache-Control', 'public, max-age=31536000, immutable').type(f.type).send(f.data.buffer ? Buffer.from(f.data.buffer) : f.data);
    } catch (err) {
      next(err);
    }
  };
}

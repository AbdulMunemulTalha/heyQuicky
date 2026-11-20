import { Router } from 'express';
import { InboxError } from '../../inbox.js';
import { need } from '../../dashboard/permissions.js';
import { audit } from '../../dashboard/util.js';
import { AUTO_TAGS, AI_TAGS, FIELDS, autoTagCounts, cleanConditions, riskOf, segmentMembers, deliveryRate, suggestedAction } from '../../dashboard/segments.js';
import { advanceSettings } from '../../dashboard/payments.js';

const COLOURS = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'purple'];
const TAG = /^[\p{L}\p{N}][\p{L}\p{N} &'-]{0,29}$/u;
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Phase 2 · Tags & segments (CRM-03 / CRM-04).
export function segmentRoutes(db, _config, { auth }) {
  const router = Router();
  const edit = need(db, 'reply');
  const conditions = (list) => { try { return cleanConditions(list); } catch (err) { throw new InboxError(400, err.message); } };

  router.get('/segments', auth, async (req, res) => {
    const ws = req.user.workspace_id;
    const [segments, used, aiUsed, tagDocs, autoCounts] = await Promise.all([
      db.segments.find({ workspace_id: ws }).sort({ created_at: 1 }).lean(),
      db.customers.aggregate([{ $match: { workspace_id: ws, blocked: { $ne: true } } }, { $unwind: '$tags' }, { $group: { _id: '$tags', n: { $sum: 1 } } }]),
      db.customers.aggregate([{ $match: { workspace_id: ws, blocked: { $ne: true } } }, { $unwind: '$ai_tags' }, { $group: { _id: '$ai_tags', n: { $sum: 1 } } }]),
      db.tags.find({ workspace_id: ws }).lean(),
      autoTagCounts(db, ws),
    ]);
    const colours = new Map(tagDocs.map((t) => [t.name.toLowerCase(), t.colour]));
    const counts = new Map(used.map((x) => [x._id.toLowerCase(), { name: x._id, n: x.n }]));
    for (const t of tagDocs) if (!counts.has(t.name.toLowerCase())) counts.set(t.name.toLowerCase(), { name: t.name, n: 0 });
    const withCounts = [];
    for (const s of segments) withCounts.push({ id: s._id, name: s.name, conditions: s.conditions, count: (await segmentMembers(db, ws, s.conditions)).count });
    res.json({
      segments: withCounts,
      autoTags: Object.entries(AUTO_TAGS).map(([key, t]) => ({ key, label: t.label, count: autoCounts[key] ?? 0 })),
      aiTags: Object.entries(AI_TAGS).map(([key, label]) => ({ key, label, count: aiUsed.find((x) => x._id === label)?.n ?? 0 })),
      tags: [...counts.values()].filter((t) => t.name !== 'VIP').sort((a, b) => b.n - a.n).map((t) => ({ name: t.name, count: t.n, colour: colours.get(t.name.toLowerCase()) ?? 'gray' })),
      fields: Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, { ops: f.ops, type: f.type }])),
    });
  });

  // Live count while the conditions are being built (+ Condition).
  router.post('/segments/preview', auth, async (req, res) => {
    const list = conditions(req.body?.conditions);
    const { ids, count } = await segmentMembers(db, req.user.workspace_id, list);
    const sample = await db.customers.find({ _id: { $in: ids.slice(0, 5) } }, { name: 1 }).lean();
    res.json({ count, sample: sample.map((c) => c.name || '—') });
  });

  async function load(req) {
    const s = await db.segments.findOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id }).lean();
    if (!s) throw new InboxError(404, 'Segment not found');
    return s;
  }
  const name = (v) => { const n = String(v ?? '').trim().slice(0, 60); if (!n) throw new InboxError(400, 'Name the segment'); return n; };

  router.post('/segments', auth, edit, async (req, res) => {
    const ws = req.user.workspace_id;
    if (await db.segments.countDocuments({ workspace_id: ws }) >= 50) throw new InboxError(409, 'Up to 50 segments');
    const s = await db.insert(db.segments, { workspace_id: ws, name: name(req.body?.name), conditions: conditions(req.body?.conditions) });
    await audit(db, req.user, `Created segment "${req.body.name}"`, { where: 'Tags & segments' });
    res.status(201).json({ id: s.id });
  });

  router.patch('/segments/:id', auth, edit, async (req, res) => {
    const s = await load(req);
    const set = {};
    if (req.body?.name !== undefined) set.name = name(req.body.name);
    if (req.body?.conditions !== undefined) set.conditions = conditions(req.body.conditions);
    await db.segments.updateOne({ _id: s._id }, { $set: set });
    res.json({ ok: true });
  });

  router.delete('/segments/:id', auth, edit, async (req, res) => {
    const s = await load(req);
    if (await db.coupons.exists({ workspace_id: s.workspace_id, audience: 'segment', segment_id: s._id, active: { $ne: false } })) {
      throw new InboxError(409, 'A live coupon is for this segment — pause it first');
    }
    await db.segments.deleteOne({ _id: s._id });
    res.sendStatus(204);
  });

  router.get('/segments/:id/customers', auth, async (req, res) => {
    const s = await load(req);
    const { ids, count } = await segmentMembers(db, s.workspace_id, s.conditions);
    const list = await db.customers.find({ _id: { $in: ids.slice(0, 100) } }).sort({ 'stats.spent': -1 }).lean();
    // Suggested action: the segment's own coupon if it has a live one, and the high-risk advance from Payments.
    const ws = await db.workspaces.findById(s.workspace_id, { settings: 1 }).lean();
    const coupon = await db.coupons.findOne({ workspace_id: s.workspace_id, audience: 'segment', segment_id: s._id, active: { $ne: false } }, { code: 1 }).lean();
    const advance = advanceSettings(ws).rules.courier_risk;
    const advanceAmount = advance.kind === 'fixed' ? advance.value : null;
    res.json({ count, customers: list.map((c) => ({ id: c._id, name: c.name, phone: c.phones?.[0] ?? '', orders: c.stats?.orders ?? 0, spent: c.stats?.spent ?? 0,
      returned: c.stats?.returned ?? 0, deliveryRate: deliveryRate(c), risk: riskOf(c).level, vip: Boolean(c.vip), tags: [...(c.tags ?? []), ...(c.ai_tags ?? [])], lastActive: c.last_active_at,
      suggested: suggestedAction(c, { advance: advanceAmount, coupon: coupon?.code ?? null }) })) });
  });

  // "Tag everyone" in a segment.
  router.post('/segments/:id/tag', auth, edit, async (req, res) => {
    const s = await load(req);
    const tag = String(req.body?.tag ?? '').trim();
    if (!TAG.test(tag)) throw new InboxError(400, 'Tags are up to 30 letters or numbers');
    const { ids } = await segmentMembers(db, s.workspace_id, s.conditions);
    const r = await db.customers.updateMany({ _id: { $in: ids } }, { $addToSet: { tags: tag } });
    await db.findOrCreate(db.tags, { workspace_id: s.workspace_id, name: tag }, {});
    await audit(db, req.user, `Tagged ${r.modifiedCount} customers in "${s.name}" with ${tag}`, { where: 'Tags & segments' });
    res.json({ tagged: r.modifiedCount });
  });

  // Manual tags: create, colour, rename (on every customer), delete (from every customer).
  router.post('/tags', auth, edit, async (req, res) => {
    const tag = String(req.body?.name ?? '').trim();
    if (!TAG.test(tag)) throw new InboxError(400, 'Tags are up to 30 letters or numbers');
    if (Object.values(AUTO_TAGS).some((t) => t.label.toLowerCase() === tag.toLowerCase())) throw new InboxError(409, `"${tag}" is an automatic tag`);
    const colour = COLOURS.includes(req.body?.colour) ? req.body.colour : 'gray';
    const { created } = await db.findOrCreate(db.tags, { workspace_id: req.user.workspace_id, name: tag }, { colour });
    if (!created) throw new InboxError(409, `${tag} already exists`);
    res.status(201).json({ name: tag });
  });

  router.patch('/tags/:name', auth, edit, async (req, res) => {
    const ws = req.user.workspace_id;
    const from = String(req.params.name);
    const doc = await db.tags.findOne({ workspace_id: ws, name: new RegExp(`^${esc(from)}$`, 'i') }).lean();
    const inUse = await db.customers.exists({ workspace_id: ws, tags: from });
    if (!doc && !inUse) throw new InboxError(404, 'Tag not found');
    const set = {};
    if (req.body?.colour !== undefined) { if (!COLOURS.includes(req.body.colour)) throw new InboxError(400, 'Pick a colour'); set.colour = req.body.colour; }
    let to = from;
    if (req.body?.name !== undefined) {
      to = String(req.body.name).trim();
      if (!TAG.test(to)) throw new InboxError(400, 'Tags are up to 30 letters or numbers');
      if (to.toLowerCase() !== from.toLowerCase() && await db.tags.exists({ workspace_id: ws, name: new RegExp(`^${esc(to)}$`, 'i') })) throw new InboxError(409, `${to} already exists`);
      set.name = to;
    }
    if (doc) await db.tags.updateOne({ _id: doc._id }, { $set: set });
    else await db.insert(db.tags, { workspace_id: ws, name: to, colour: set.colour ?? 'gray' });
    if (to !== from) {
      await db.customers.updateMany({ workspace_id: ws, tags: from }, { $addToSet: { tags: to } });
      await db.customers.updateMany({ workspace_id: ws, tags: from }, { $pull: { tags: from } });
      await audit(db, req.user, `Renamed tag ${from} → ${to}`, { where: 'Tags & segments' });
    }
    res.json({ name: to });
  });

  router.delete('/tags/:name', auth, edit, async (req, res) => {
    const ws = req.user.workspace_id;
    const tag = String(req.params.name);
    const r = await db.customers.updateMany({ workspace_id: ws, tags: tag }, { $pull: { tags: tag } });
    await db.tags.deleteOne({ workspace_id: ws, name: tag });
    await audit(db, req.user, `Deleted tag ${tag} (${r.modifiedCount} customers)`, { where: 'Tags & segments' });
    res.json({ removed: r.modifiedCount });
  });

  return router;
}

import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { InboxError } from '../../inbox.js';
import { need } from '../../dashboard/permissions.js';
import { audit } from '../../dashboard/util.js';
import { AUDIENCES } from '../../dashboard/orderBuild.js';

const TYPES = ['percent', 'amount', 'free_delivery'];
const CODE = /^[A-Z0-9][A-Z0-9-]{2,19}$/;

export function couponStatus(c, now = new Date()) {
  if (c.active === false) return 'paused';
  if (c.ends_at && c.ends_at < now) return 'expired';
  if (c.max_uses != null && (c.used ?? 0) >= c.max_uses) return 'used_up';
  if (c.starts_at && c.starts_at > now) return 'scheduled';
  return 'live';
}

// A readable code nobody will guess, e.g. EID-7K3Q.
export function generateCode(prefix = '') {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const tail = [...randomBytes(4)].map((b) => alphabet[b % alphabet.length]).join('');
  const head = String(prefix).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return head ? `${head}-${tail}` : `SAVE-${tail}`;
}

function money(v, what, { min = 0, max = 1_000_000 } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new InboxError(400, `Enter a valid ${what}`);
  return Math.round(n);
}
function date(v, what) {
  if (v === null || v === '' || v === undefined) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new InboxError(400, `Pick a valid ${what} date`);
  return d;
}

// Phase 2 · Coupons (ORD-05): list with uses and sales, create / edit drawer, pause, delete unused.
export function couponRoutes(db, _config, { auth }) {
  const router = Router();
  const edit = need(db, 'edit_products');

  function clean(b, current = null) {
    const set = {};
    if (b.code !== undefined || !current) {
      const code = String(b.code ?? '').trim().toUpperCase();
      if (!CODE.test(code)) throw new InboxError(400, 'Codes are 3–20 letters, numbers or dashes, e.g. EID10');
      set.code = code;
    }
    if (b.type !== undefined || !current) { if (!TYPES.includes(b.type)) throw new InboxError(400, 'Pick the kind of discount'); set.type = b.type; }
    const type = set.type ?? current?.type;
    if (b.value !== undefined || (!current && type !== 'free_delivery')) {
      set.value = type === 'free_delivery' ? 0 : type === 'percent' ? money(b.value, 'percentage (1–90)', { min: 1, max: 90 }) : money(b.value, 'amount', { min: 1, max: 100_000 });
    }
    if (type === 'free_delivery') set.value = 0;
    if (b.minOrder !== undefined) set.min_order = money(b.minOrder || 0, 'minimum order');
    if (b.maxUses !== undefined) set.max_uses = b.maxUses === null || b.maxUses === '' ? null : money(b.maxUses, 'number of uses', { min: 1, max: 1_000_000 });
    if (b.startsAt !== undefined) set.starts_at = date(b.startsAt, 'start');
    if (b.endsAt !== undefined) set.ends_at = date(b.endsAt, 'end');
    const starts = set.starts_at !== undefined ? set.starts_at : current?.starts_at;
    const ends = set.ends_at !== undefined ? set.ends_at : current?.ends_at;
    if (starts && ends && ends <= starts) throw new InboxError(400, 'The end date must be after the start date');
    if (b.audience !== undefined) { if (!AUDIENCES.includes(b.audience)) throw new InboxError(400, 'Pick who can use it'); set.audience = b.audience; }
    if (typeof b.aiMayMention === 'boolean') set.ai_may_mention = b.aiMayMention;
    if (typeof b.active === 'boolean') set.active = b.active;
    return set;
  }

  router.get('/coupons', auth, async (req, res) => {
    const ws = req.user.workspace_id;
    const [coupons, sales] = await Promise.all([
      db.coupons.find({ workspace_id: ws }).sort({ created_at: -1 }).lean(),
      db.orders.aggregate([
        { $match: { workspace_id: ws, coupon_code: { $nin: ['', null] }, draft: { $ne: true }, status: { $nin: ['cancelled', 'returned'] } } },
        { $group: { _id: '$coupon_code', orders: { $sum: 1 }, revenue: { $sum: { $subtract: [{ $add: ['$subtotal', '$delivery_charge'] }, '$discount'] } }, discount: { $sum: '$discount' } } },
      ]),
    ]);
    const by = new Map(sales.map((x) => [x._id, x]));
    const now = new Date();
    const rows = coupons.map((c) => ({
      id: c._id, code: c.code, type: c.type, value: c.value, minOrder: c.min_order ?? 0, maxUses: c.max_uses ?? null, used: c.used ?? 0,
      startsAt: c.starts_at, endsAt: c.ends_at, audience: c.audience ?? 'everyone', aiMayMention: c.ai_may_mention !== false, active: c.active !== false,
      status: couponStatus(c, now), orders: by.get(c.code)?.orders ?? 0, revenue: by.get(c.code)?.revenue ?? 0, given: by.get(c.code)?.discount ?? 0,
    }));
    const counts = { all: rows.length };
    for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
    res.json({ coupons: rows, counts, totals: { orders: rows.reduce((s, r) => s + r.orders, 0), revenue: rows.reduce((s, r) => s + r.revenue, 0), given: rows.reduce((s, r) => s + r.given, 0) } });
  });

  router.get('/coupons/generate', auth, (req, res) => res.json({ code: generateCode(req.query.prefix) }));

  router.post('/coupons', auth, edit, async (req, res) => {
    const ws = req.user.workspace_id;
    const set = clean(req.body ?? {});
    if (await db.coupons.exists({ workspace_id: ws, code: set.code })) throw new InboxError(409, `${set.code} already exists`);
    const c = await db.insert(db.coupons, { workspace_id: ws, audience: 'everyone', ...set });
    await audit(db, req.user, `Created coupon ${set.code}`, { where: 'Coupons' });
    res.status(201).json({ id: c.id, code: set.code });
  });

  router.patch('/coupons/:id', auth, edit, async (req, res) => {
    const c = await db.coupons.findOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id }).lean();
    if (!c) throw new InboxError(404, 'Coupon not found');
    const set = clean(req.body ?? {}, c);
    if (set.code && set.code !== c.code) {
      if ((c.used ?? 0) > 0) throw new InboxError(409, `${c.code} has been used, so its code can't change — create a new coupon instead`);
      if (await db.coupons.exists({ workspace_id: c.workspace_id, code: set.code })) throw new InboxError(409, `${set.code} already exists`);
    }
    if (!Object.keys(set).length) throw new InboxError(400, 'Nothing to change');
    await db.coupons.updateOne({ _id: c._id }, { $set: set });
    if (set.active !== undefined) await audit(db, req.user, `${set.active ? 'Resumed' : 'Paused'} coupon ${c.code}`, { where: 'Coupons' });
    res.json({ ok: true });
  });

  router.delete('/coupons/:id', auth, edit, async (req, res) => {
    const c = await db.coupons.findOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id }).lean();
    if (!c) throw new InboxError(404, 'Coupon not found');
    if ((c.used ?? 0) > 0) throw new InboxError(409, `${c.code} has been used on orders — pause it instead, so the history stays`);
    await db.coupons.deleteOne({ _id: c._id });
    await audit(db, req.user, `Deleted coupon ${c.code}`, { where: 'Coupons' });
    res.sendStatus(204);
  });

  return router;
}

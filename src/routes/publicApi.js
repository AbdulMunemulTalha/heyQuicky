import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { InboxError } from '../inbox.js';
import { cleanCustomer } from '../dashboard/orderBuild.js';
import { saveOrder } from '../dashboard/aiOrder.js';
import { orderData } from '../dashboard/webhooks.js';

// INT-04 · The shop's own API, for its other systems (stock sheets, ERP, Zapier):
//   Authorization: Bearer hq_live_…   (Settings → Integrations → Webhooks & API)
//   GET  /api/v1/products            GET /api/v1/orders?status=&since=&limit=&before=
//   GET  /api/v1/orders/:number      POST /api/v1/orders
export const hashKey = (key) => createHash('sha256').update(String(key)).digest('hex');
export function newApiKey() {
  const key = `hq_live_${randomBytes(24).toString('base64url')}`;
  return { key, prefix: key.slice(0, 12), hash: hashKey(key) };
}

const ZONES = ['inside_dhaka', 'dhaka_suburbs', 'outside_dhaka'];
const STATUSES = ['pending', 'on_hold', 'approved', 'processing', 'ready_to_ship', 'in_transit', 'delivered', 'cancelled', 'returned'];

function limiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10_000) hits.clear();
    return recent.length <= max;
  };
}

export function publicApiRoutes(db, config, { notify } = {}) {
  const router = Router();
  const limit = limiter(120, 60_000);
  const fail = (res, status, error) => res.status(status).json({ error });

  // Who is calling: an API key that hasn't been revoked.
  router.use(async (req, res, next) => {
    const m = /^Bearer\s+(hq_live_[A-Za-z0-9_-]{20,})$/.exec(req.get('authorization') ?? '');
    if (!m) return fail(res, 401, 'Send your API key as: Authorization: Bearer hq_live_…');
    const key = await db.apiKeys.findOne({ hash: hashKey(m[1]), revoked_at: null }).lean();
    if (!key) return fail(res, 401, 'This API key is not valid or was revoked');
    if (!limit(String(key._id))) return fail(res, 429, 'Too many requests — at most 120 a minute');
    if (!key.last_used_at || Date.now() - key.last_used_at > 60_000) await db.apiKeys.updateOne({ _id: key._id }, { $set: { last_used_at: new Date() } });
    req.workspaceId = key.workspace_id;
    next();
  });

  router.get('/products', async (req, res) => {
    const list = await db.products.find({ workspace_id: req.workspaceId, archived: { $ne: true } }).sort({ name: 1 }).limit(1000).lean();
    res.json({ data: list.map((p) => ({
      id: p._id, name: p.name, code: p.code || null, price: p.price, compare_at: p.compare_at ?? null, category: p.category || null, in_stock: p.in_stock !== false,
      visibility: p.visibility ?? 'everywhere', photos: p.photos ?? [],
      variants: (p.variant_list ?? []).map((v) => ({ sku: v.sku, options: v.options ?? {}, price: v.price ?? p.price, stock: v.stock ?? null })),
    })) });
  });

  router.get('/orders', async (req, res) => {
    const where = { workspace_id: req.workspaceId, draft: { $ne: true } };
    if (req.query.status) {
      if (!STATUSES.includes(req.query.status)) return fail(res, 400, `status must be one of ${STATUSES.join(', ')}`);
      where.status = req.query.status;
    }
    if (req.query.since) {
      const since = new Date(req.query.since);
      if (Number.isNaN(since.getTime())) return fail(res, 400, 'since must be a date, e.g. 2026-11-01T00:00:00Z');
      where.updated_at = { $gte: since };
    }
    if (req.query.before) where.number = { $lt: Number(req.query.before) || 0 };
    const n = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
    const list = await db.orders.find(where).sort({ number: -1 }).limit(n + 1).lean();
    const page = list.slice(0, n);
    res.json({ data: page.map((o) => orderData(o, { publicUrl: config.publicUrl })), next_before: list.length > n ? page.at(-1).number : null });
  });

  router.get('/orders/:number', async (req, res) => {
    const o = await db.orders.findOne({ workspace_id: req.workspaceId, number: Number(req.params.number), draft: { $ne: true } }).lean();
    if (!o) return fail(res, 404, 'No order with that number');
    res.json({ data: orderData(o, { publicUrl: config.publicUrl }) });
  });

  // A new order from the shop's other system, priced from the catalog like every other order.
  // external_ref (or the Idempotency-Key header) makes retries safe: the same ref returns the same order.
  router.post('/orders', async (req, res) => {
    const b = req.body ?? {};
    const ref = String(req.get('idempotency-key') ?? b.external_ref ?? '').trim().slice(0, 80);
    if (ref) {
      const same = await db.orders.findOne({ workspace_id: req.workspaceId, external_ref: ref }).lean();
      if (same) return res.status(200).json({ data: orderData(same, { publicUrl: config.publicUrl }), duplicate: true });
    }
    const ws = await db.workspaces.findById(req.workspaceId).lean();
    try {
      const who = cleanCustomer({ name: b.customer?.name, phone: b.customer?.phone, address: b.address });
      const zone = String(b.zone ?? 'inside_dhaka');
      if (!ZONES.includes(zone)) throw new InboxError(400, `zone must be one of ${ZONES.join(', ')}`);
      if (!Array.isArray(b.items) || !b.items.length || b.items.length > 20) throw new InboxError(400, 'items must list 1 to 20 products');
      const products = await db.products.find({ workspace_id: ws._id, archived: { $ne: true } }).lean();
      const items = b.items.map((i, n) => {
        const sku = String(i?.sku ?? '').trim();
        const p = i?.product_id ? products.find((x) => x._id === Number(i.product_id))
          : products.find((x) => (x.variant_list ?? []).some((v) => v.sku === sku)) ?? products.find((x) => x.code && x.code === sku);
        if (!p) throw new InboxError(400, `items[${n}]: no product with ${i?.product_id ? `id ${i.product_id}` : `sku "${sku}"`}`);
        const variant = (p.variant_list ?? []).find((v) => v.sku === sku);
        if ((p.variant_list ?? []).length && !variant) throw new InboxError(400, `items[${n}]: ${p.name} needs the sku of a size/colour`);
        return { productId: p._id, sku: variant?.sku, qty: Number(i?.qty) || 1 };
      });
      const { order } = await saveOrder(db, ws, { who, items, zone, coupon: String(b.coupon ?? '').trim().slice(0, 30), note: String(b.note ?? '').slice(0, 300), source: 'api', notify });
      if (ref) await db.orders.updateOne({ _id: order._id }, { $set: { external_ref: ref } });
      res.status(201).json({ data: orderData(order, { publicUrl: config.publicUrl }) });
    } catch (err) {
      if (err instanceof InboxError) return fail(res, err.status, err.message);
      throw err;
    }
  });

  router.use((_req, res) => fail(res, 404, 'Unknown API path'));
  return router;
}

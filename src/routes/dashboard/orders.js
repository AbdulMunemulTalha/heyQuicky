import { Router } from 'express';
import { InboxError } from '../../inbox.js';
import { can, need } from '../../dashboard/permissions.js';
import { clampInt, csv, dhakaDayStart, escapeRegex } from '../../dashboard/util.js';
import { riskFor } from '../../dashboard/risk.js';
import { STAGES, NEXT, stage, orderTotal, changeStatus, bookCourier } from '../../dashboard/orderOps.js';

const SOURCES = ['ai', 'team', 'product_page', 'website'];
const ZONES = ['inside_dhaka', 'outside_dhaka'];
const RANGES = { today: 0, '7d': 6, '30d': 29, all: null };
// Database values for one pipeline stage (older orders use 'confirmed' / 'shipped').
const statusIn = (s) => (s === 'pending' ? ['pending', 'confirmed'] : s === 'in_transit' ? ['in_transit', 'shipped'] : [s]);

export function orderRoutes(db, config, { auth, emit, fetchImpl }) {
  const router = Router();

  function filterFrom(req) {
    const where = { workspace_id: req.user.workspace_id, draft: { $ne: true } };
    const and = [];
    if (SOURCES.includes(req.query.source)) where.source = req.query.source;
    if (ZONES.includes(req.query.zone)) where.area = req.query.zone;
    const range = req.query.range in RANGES ? req.query.range : '7d';
    if (RANGES[range] !== null) where.created_at = { $gte: dhakaDayStart(new Date(), -RANGES[range]) };
    if (req.query.q) {
      const q = String(req.query.q).trim().slice(0, 60);
      const digits = q.replace(/[০-৯]/g, (d) => '০১২৩৪৫৬৭৮৯'.indexOf(d)).replace(/\D/g, '');
      const re = new RegExp(escapeRegex(q), 'i');
      const or = [{ customer_name: re }];
      if (digits.length >= 3) or.push({ phone: new RegExp(escapeRegex(digits)) });
      if (/^#?\d+$/.test(q)) or.push({ number: Number(q.replace('#', '')) });
      and.push({ $or: or });
    }
    return { where, and, range };
  }

  async function rowsFor(orders, user, workspace) {
    const showPhones = can(user, 'see_phones', workspace);
    const customers = new Map((await db.customers.find({ _id: { $in: orders.map((o) => o.customer_id).filter(Boolean) } }, { stats: 1, vip: 1, tags: 1, courier_check: 1 }).lean()).map((c) => [c._id, c]));
    return orders.map((o) => {
      const cu = customers.get(o.customer_id);
      const risk = o.risk ?? riskFor({ delivered: cu?.stats?.delivered, returned: cu?.stats?.returned, cancelled: cu?.stats?.cancelled,
        courierRate: cu?.courier_check?.rate ?? null, courierTotal: cu?.courier_check?.total ?? 0, codAmount: o.cod_amount, outsideDhaka: o.area === 'outside_dhaka' });
      const s = stage(o.status);
      return {
        id: o._id, number: o.number ?? o._id, at: o.created_at, name: o.customer_name,
        phone: showPhones ? o.phone : `${o.phone.slice(0, 3)}••••${o.phone.slice(-3)}`,
        orders: cu?.stats?.orders ?? 1, vip: Boolean(cu?.vip), detailsChanged: Boolean(o.details_changed || o.change_request?.status === 'open'),
        items: (o.product_items?.length ? o.product_items.map((i) => `${i.name} (${i.variant})${i.qty > 1 ? ` ×${i.qty}` : ''}`) : o.items.map((i) => `${i.name}${i.qty > 1 ? ` ×${i.qty}` : ''}`)).join(', '),
        total: orderTotal(o), cod: o.cod_amount, paid: Boolean(o.paid_in_full || o.payment_method === 'paid'), advance: o.advance?.amount ?? o.advance_paid ?? 0,
        coupon: o.coupon_code || '', source: o.source || 'team', zone: o.area, district: o.district, risk: risk.level, status: s, next: NEXT[s] ?? [],
        courier: o.courier || '', consignment: o.consignment_id || '',
      };
    });
  }

  router.get('/orders', auth, async (req, res) => {
    const ws = req.user.workspace_id;
    req.workspace ??= await db.workspaces.findById(ws).lean();
    const { where, and } = filterFrom(req);
    const status = STAGES.includes(req.query.status) ? req.query.status : 'all';
    const base = and.length ? { ...where, $and: and } : where;
    const list = status === 'all' ? base : { ...base, status: { $in: statusIn(status) } };
    const page = clampInt(req.query.page, 1, 1000, 1);
    const perPage = clampInt(req.query.perPage, 10, 100, 25);
    const [orders, total, byStatus] = await Promise.all([
      db.orders.find(list).sort({ created_at: -1, _id: -1 }).skip((page - 1) * perPage).limit(perPage).lean(),
      db.orders.countDocuments(list),
      db.orders.aggregate([{ $match: base }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    ]);
    const counts = Object.fromEntries(STAGES.map((s) => [s, 0]));
    let all = 0;
    for (const b of byStatus) { counts[stage(b._id)] = (counts[stage(b._id)] ?? 0) + b.n; all += b.n; }

    // KPI tiles are about the whole shop, not the current filter.
    const today = dhakaDayStart(new Date());
    const weekAgo = dhakaDayStart(new Date(), -6);
    const allWs = { workspace_id: ws, draft: { $ne: true } };
    const [todayOrders, toConfirm, ready, cod, returns7, delivered7] = await Promise.all([
      db.orders.find({ ...allWs, created_at: { $gte: today }, status: { $ne: 'cancelled' } }, { subtotal: 1, delivery_charge: 1, discount: 1 }).lean(),
      db.orders.countDocuments({ ...allWs, status: { $in: ['pending', 'confirmed', 'on_hold'] } }),
      db.orders.countDocuments({ ...allWs, status: 'ready_to_ship' }),
      db.orders.aggregate([{ $match: { ...allWs, status: { $in: ['approved', 'processing', 'ready_to_ship', 'in_transit', 'shipped'] } } }, { $group: { _id: null, sum: { $sum: '$cod_amount' } } }]),
      db.orders.countDocuments({ ...allWs, status: 'returned', updated_at: { $gte: weekAgo } }),
      db.orders.countDocuments({ ...allWs, status: 'delivered', updated_at: { $gte: weekAgo } }),
    ]);
    res.json({
      items: await rowsFor(orders, req.user, req.workspace),
      page, perPage, total, counts: { all, ...counts },
      kpis: {
        today: todayOrders.length, todayRevenue: todayOrders.reduce((s, o) => s + orderTotal(o), 0), toConfirm, ready,
        cod: cod[0]?.sum ?? 0, returns7, returnRate: returns7 + delivered7 ? Math.round((returns7 / (returns7 + delivered7)) * 1000) / 10 : 0,
      },
      couriers: (await db.courierAccounts.find({ workspace_id: ws, connected: true }, { courier: 1 }).lean()).map((c) => c.courier),
    });
  });

  // Inline status change from the list (and order detail).
  router.post('/orders/:id/status', auth, need(db, 'edit_orders'), async (req, res) => {
    const order = await db.orders.findOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id }).lean();
    if (!order) throw new InboxError(404, 'Order not found');
    const to = String(req.body?.status ?? '');
    if (to === 'cancelled' && !can(req.user, 'cancel_orders', await db.workspaces.findById(req.user.workspace_id, { settings: 1 }).lean())) {
      throw new InboxError(403, "Your role can't cancel orders. Ask the owner for access.");
    }
    const updated = await changeStatus(db, req.user, order, to, { reason: req.body?.reason, restock: req.body?.restock !== false, emit });
    res.json({ id: updated._id, status: stage(updated.status), next: NEXT[stage(updated.status)] });
  });

  // Book one or several orders with a courier ("Book with Steadfast").
  router.post('/orders/book', auth, need(db, 'book_couriers'), async (req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isSafeInteger).slice(0, 100);
    if (!ids.length) throw new InboxError(400, 'Select orders to book');
    const orders = await db.orders.find({ _id: { $in: ids }, workspace_id: req.user.workspace_id }).lean();
    const results = [];
    for (const o of orders) {
      try {
        const r = await bookCourier(db, config, req.user, o, String(req.body?.courier ?? 'steadfast'), { emit, fetchImpl });
        results.push({ id: o._id, number: o.number, ok: true, consignment: r.consignment_id, testMode: r.testMode });
      } catch (err) {
        results.push({ id: o._id, number: o.number, ok: false, error: err.message });
      }
    }
    res.json({ booked: results.filter((r) => r.ok).length, results });
  });

  router.get('/orders.csv', auth, async (req, res) => {
    const { where, and } = filterFrom(req);
    const status = STAGES.includes(req.query.status) ? req.query.status : null;
    const filter = { ...where, ...(and.length ? { $and: and } : {}), ...(status ? { status: { $in: statusIn(status) } } : {}) };
    const orders = await db.orders.find(filter).sort({ created_at: -1 }).limit(20_000).lean();
    const workspace = await db.workspaces.findById(req.user.workspace_id).lean();
    const showPhones = can(req.user, 'see_phones', workspace);
    const head = ['order', 'date', 'status', 'customer', 'phone', 'address', 'district', 'zone', 'items', 'subtotal', 'delivery', 'discount', 'coupon', 'advance', 'cod', 'source', 'courier', 'consignment', 'cancel_reason'];
    const rows = orders.map((o) => [o.number ?? o._id, o.created_at, stage(o.status), o.customer_name, showPhones ? o.phone : '', o.address, o.district, o.area,
      o.items.map((i) => `${i.name} x${i.qty}`).join('; '), o.subtotal, o.delivery_charge, o.discount, o.coupon_code, o.advance?.amount ?? o.advance_paid ?? 0,
      o.cod_amount, o.source, o.courier, o.consignment_id, o.cancel_reason]);
    res.type('text/csv').set('Content-Disposition', 'attachment; filename="heyquicky-orders.csv"').send(`﻿${csv([head, ...rows])}`);
  });

  // A printable sheet of parcel labels (the browser prints it; no PDF library needed).
  router.post('/orders/labels', auth, async (req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isSafeInteger).slice(0, 200);
    const filter = ids.length ? { _id: { $in: ids } } : { status: 'ready_to_ship' };
    const orders = await db.orders.find({ workspace_id: req.user.workspace_id, ...filter }).sort({ number: 1 }).lean();
    if (!orders.length) throw new InboxError(400, 'No orders to print. Select orders or mark some Ready to ship.');
    const ws = await db.workspaces.findById(req.user.workspace_id, { name: 1, phone: 1, address: 1 }).lean();
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const labels = orders.map((o) => `<section class="label"><header><b>${esc(ws.name)}</b><span>#${o.number ?? o._id}</span></header>
      <p class="to"><b>${esc(o.customer_name)}</b><br>${esc(o.phone)}<br>${esc([o.address, o.thana, o.district].filter(Boolean).join(', '))}</p>
      <p class="items">${esc(o.items.map((i) => `${i.name} ×${i.qty}`).join(', '))}</p>
      <footer><span>${o.cod_amount > 0 ? `COD ৳${o.cod_amount.toLocaleString('en-IN')}` : 'PAID'}</span><span>${esc(o.courier || '')} ${esc(o.consignment_id || '')}</span></footer></section>`).join('');
    res.type('text/html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Labels</title><style>
      body{font:13px/1.4 "Hind Siliguri",Arial,sans-serif;margin:0;display:grid;grid-template-columns:repeat(2,1fr);gap:8mm;padding:8mm}
      .label{border:1.5px dashed #444;border-radius:6px;padding:4mm;break-inside:avoid;height:62mm;display:flex;flex-direction:column}
      header,footer{display:flex;justify-content:space-between}.to{font-size:15px;margin:3mm 0}.items{color:#444;flex:1;margin:0}footer{font-weight:700;font-size:15px}
      @page{size:A4;margin:0}</style></head><body>${labels}<script>window.onload=()=>window.print()</script></body></html>`);
  });

  return router;
}

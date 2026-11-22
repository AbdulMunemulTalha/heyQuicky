import { Router } from 'express';
import { InboxError } from '../../inbox.js';
import { need } from '../../dashboard/permissions.js';
import { audit, csv } from '../../dashboard/util.js';
import { COURIERS } from '../../adapters/couriers.js';
import { cashRows, chaseResult, logTry, markPayoutReceived, startChase, updateReturn } from '../../dashboard/money.js';

// Phase 2 · Money & follow-up (OMS-05 / OMS-07), frames "Cash from couriers", "Returns & exchanges", "To-chase list".
export function moneyRoutes(db, _config, { auth, emit }) {
  const router = Router();
  const edit = need(db, 'edit_orders');
  const loadOrder = async (req, id) => {
    const o = await db.orders.findOne({ _id: Number(id), workspace_id: req.user.workspace_id, draft: { $ne: true } }).lean();
    if (!o) throw new InboxError(404, 'Order not found');
    return o;
  };

  async function overview(ws) {
    const now = new Date();
    const since = new Date(now - 30 * 86_400_000);
    const [cash, payouts, returns, chasing, done30] = await Promise.all([
      cashRows(db, ws, now),
      db.payouts.find({ workspace_id: ws, received_at: { $gte: since } }).sort({ received_at: -1 }).limit(30).lean(),
      db.returns.find({ workspace_id: ws, $or: [{ done_at: null }, { created_at: { $gte: since } }] }).sort({ done_at: 1, created_at: -1 }).limit(100).lean(),
      db.orders.find({ workspace_id: ws, 'chase.active': true }).sort({ 'chase.next_at': 1 }).limit(100).lean(),
      db.orders.aggregate([{ $match: { workspace_id: ws, status: { $in: ['delivered', 'returned'] }, updated_at: { $gte: since } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    ]);
    const orderIds = [...new Set(returns.map((r) => r.order_id))];
    const orders = new Map((await db.orders.find({ _id: { $in: orderIds } }, { number: 1, customer_name: 1 }).lean()).map((o) => [o._id, o]));
    const owners = new Map((await db.users.find({ _id: { $in: chasing.map((o) => o.chase.owner_user_id).filter(Boolean) } }, { name: 1 }).lean()).map((u) => [u._id, u.name]));
    const dueToday = cash.filter((r) => r.status === 'due_today');
    const late = cash.filter((r) => r.status === 'late');
    const recent = returns.filter((r) => r.created_at >= since);
    const delivered = done30.find((x) => x._id === 'delivered')?.n ?? 0;
    const returned = done30.find((x) => x._id === 'returned')?.n ?? 0;
    return {
      cash: {
        rows: [
          ...cash.map((r) => ({ key: r.key, courier: r.courier, name: r.name, from: r.from, to: r.to, parcels: r.parcels, collected: r.collected, fees: r.fees, amount: r.amount, status: r.status, lateDays: r.lateDays, dueAt: r.dueAt })),
          ...payouts.map((p) => ({ key: `p${p._id}`, courier: p.courier, name: COURIERS[p.courier]?.name ?? p.courier, from: p.from, to: p.to, parcels: p.parcels, collected: p.collected, fees: p.fees, amount: p.amount, status: 'received', receivedAt: p.received_at })),
        ],
        kpis: {
          withCouriers: cash.reduce((s, r) => s + r.amount, 0), unpaidParcels: cash.reduce((s, r) => s + r.parcels, 0),
          dueToday: dueToday.reduce((s, r) => s + r.amount, 0), dueTodayCouriers: [...new Set(dueToday.map((r) => r.name))],
          late: late.reduce((s, r) => s + r.amount, 0), lateNote: late[0] ? { name: late[0].name, days: Math.max(...late.map((r) => r.lateDays)) } : null,
          received30: payouts.reduce((s, p) => s + p.amount, 0), received30Parcels: payouts.reduce((s, p) => s + p.parcels, 0),
        },
      },
      returns: {
        rows: returns.map((r) => ({ id: r._id, orderId: r.order_id, number: orders.get(r.order_id)?.number ?? r.order_id, customer: orders.get(r.order_id)?.customer_name ?? '',
          type: r.type, reason: r.reason, parcel: r.parcel, stock: r.stock, loss: r.loss, claimed: Boolean(r.claim), done: Boolean(r.done_at), at: r.created_at })),
        kpis: {
          rate: delivered + returned ? Math.round((returned / (delivered + returned)) * 1000) / 10 : 0,
          returns: recent.filter((r) => r.type !== 'exchange').length, exchanges: recent.filter((r) => r.type === 'exchange').length,
          lost: recent.reduce((s, r) => s + r.loss, 0),
        },
      },
      chase: {
        rows: chasing.map((o) => {
          const tries = o.chase.tries ?? [];
          return { orderId: o._id, number: o.number, customer: o.customer_name, phone: o.phone, total: (o.subtotal ?? 0) + (o.delivery_charge ?? 0) - (o.discount ?? 0),
            reason: o.chase.reason, calls: tries.filter((x) => x.kind === 'call').length, whatsapps: tries.filter((x) => x.kind === 'whatsapp').length,
            nextAt: o.chase.next_at, overdue: Boolean(o.chase.next_at && new Date(o.chase.next_at) < new Date(now - 15 * 60_000)),
            owner: owners.get(o.chase.owner_user_id) ?? '', status: o.status };
        }),
      },
    };
  }

  router.get('/money', auth, async (req, res) => {
    res.json({ ...(await overview(req.user.workspace_id)), canEdit: true });
  });

  router.get('/money.csv', auth, async (req, res) => {
    const d = await overview(req.user.workspace_id);
    const tab = ['cash', 'returns', 'chase'].includes(req.query.tab) ? req.query.tab : 'cash';
    const day = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '');
    const rows = tab === 'cash'
      ? [['Courier', 'From', 'To', 'Parcels', 'Cash collected', 'Delivery fees', 'You get', 'Status'], ...d.cash.rows.map((r) => [r.name, day(r.from), day(r.to), r.parcels, r.collected, r.fees, r.amount, r.status])]
      : tab === 'returns'
        ? [['Order', 'Customer', 'Type', 'Reason', 'Parcel', 'Stock', 'Loss', 'Claimed', 'Done'], ...d.returns.rows.map((r) => [r.number, r.customer, r.type, r.reason, r.parcel, r.stock, r.loss, r.claimed ? 'yes' : '', r.done ? 'yes' : ''])]
        : [['Order', 'Customer', 'Phone', 'Total', 'Calls', 'WhatsApps', 'Next try', 'Owner'], ...d.chase.rows.map((r) => [r.number, r.customer, r.phone, r.total, r.calls, r.whatsapps, r.nextAt ? new Date(r.nextAt).toISOString() : '', r.owner])];
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="money-${tab}.csv"`);
    res.send(`﻿${csv(rows)}`);
  });

  router.post('/money/payouts', auth, edit, async (req, res) => {
    const out = await markPayoutReceived(db, req.user, String(req.body?.key ?? ''));
    await audit(db, req.user, `Marked a courier payout of ৳${out.amount} received (${out.parcels} parcels)`, { where: 'Money' });
    emit(req.user.workspace_id, 'money', {});
    res.status(201).json(out);
  });

  router.patch('/money/returns/:id', auth, edit, async (req, res) => {
    const r = await updateReturn(db, req.user, req.params.id, String(req.body?.action ?? ''));
    emit(req.user.workspace_id, 'money', {});
    res.json({ id: r._id, parcel: r.parcel, stock: r.stock, loss: r.loss, claimed: Boolean(r.claim), done: Boolean(r.done_at) });
  });

  // "Couldn't reach" on an order → the To chase list (the order is paused until someone reaches them).
  router.post('/orders/:id/chase', auth, edit, async (req, res) => {
    const order = await loadOrder(req, req.params.id);
    const chase = await startChase(db, req.user, order, { reason: String(req.body?.reason ?? '').trim().slice(0, 120), emit });
    emit(req.user.workspace_id, 'money', {});
    res.status(201).json({ active: chase.active });
  });

  router.post('/money/chase/:orderId/try', auth, edit, async (req, res) => {
    const chase = await logTry(db, req.user, await loadOrder(req, req.params.orderId), String(req.body?.kind ?? ''));
    res.json({ tries: chase.tries.length, nextAt: chase.next_at });
  });

  router.post('/money/chase/:orderId/result', auth, edit, async (req, res) => {
    const out = await chaseResult(db, req.user, await loadOrder(req, req.params.orderId), String(req.body?.result ?? ''), { emit });
    emit(req.user.workspace_id, 'money', {});
    res.json({ active: out.chase.active, result: out.chase.result ?? null });
  });

  return router;
}

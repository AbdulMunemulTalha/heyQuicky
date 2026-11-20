import { Router } from 'express';
import { InboxError } from '../../inbox.js';
import { need } from '../../dashboard/permissions.js';
import { audit, bdPhone, dhakaDayStart } from '../../dashboard/util.js';
import { orderTotal } from '../../dashboard/orderOps.js';
import { advanceSettings, approvePayment, rejectPayment, recordPayment, DEFAULT_ADVANCE_MESSAGE, ADVANCE_RULES } from '../../dashboard/payments.js';

const STATUSES = ['waiting', 'approved', 'rejected'];

// Phase 2 · Payments (PAY-01 / PAY-03): approve or reject the bKash / Nagad advances customers
// send (from the bill page or in chat), and the rules for when to ask for one.
export function paymentRoutes(db, _config, { auth, inbox, emit, notify }) {
  const router = Router();
  const edit = need(db, 'edit_orders');
  const owner = async (req, res, next) => (['owner', 'admin'].includes(req.user.role) ? next() : res.status(403).json({ error: 'Only the owner or an admin can change payment rules' }));

  router.get('/payments', auth, async (req, res) => {
    const ws = req.user.workspace_id;
    const status = STATUSES.includes(req.query.status) ? req.query.status : 'waiting';
    const list = await db.payments.find({ workspace_id: ws, status }).sort(status === 'waiting' ? { created_at: 1 } : { decided_at: -1 }).limit(100).lean();
    const orders = new Map((await db.orders.find({ _id: { $in: list.map((p) => p.order_id).filter(Boolean) } }).lean()).map((o) => [o._id, o]));
    const users = new Map((await db.users.find({ _id: { $in: list.map((p) => p.decided_by).filter(Boolean) } }, { name: 1 }).lean()).map((u) => [u._id, u.name]));
    // The same TrxID or payer number used on another order is worth a second look.
    const sameNumber = await db.payments.aggregate([{ $match: { workspace_id: ws, from_number: { $in: list.map((p) => p.from_number).filter(Boolean) } } }, { $group: { _id: '$from_number', orders: { $addToSet: '$order_id' } } }]);
    const numberOrders = new Map(sameNumber.map((x) => [x._id, x.orders.filter(Boolean).length]));
    const dayStart = dhakaDayStart(new Date());
    const [counts, waitingSum, today, rejectedToday, speed] = await Promise.all([
      db.payments.aggregate([{ $match: { workspace_id: ws } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      db.payments.aggregate([{ $match: { workspace_id: ws, status: 'waiting' } }, { $group: { _id: null, sum: { $sum: '$amount' } } }]),
      db.payments.aggregate([{ $match: { workspace_id: ws, status: 'approved', decided_at: { $gte: dayStart } } }, { $group: { _id: null, sum: { $sum: '$amount' }, n: { $sum: 1 } } }]),
      db.payments.countDocuments({ workspace_id: ws, status: 'rejected', decided_at: { $gte: dayStart } }),
      // "Avg time to approve" over the last 7 days.
      db.payments.aggregate([{ $match: { workspace_id: ws, status: 'approved', decided_at: { $gte: new Date(Date.now() - 7 * 86_400_000) } } }, { $group: { _id: null, avg: { $avg: { $subtract: ['$decided_at', '$created_at'] } } } }]),
    ]);
    const c = Object.fromEntries(counts.map((x) => [x._id, x.n]));
    res.json({
      status,
      payments: list.map((p) => {
        const o = orders.get(p.order_id);
        const expected = p.expected ?? o?.advance?.amount ?? null;
        const checks = [];
        if (expected != null && p.amount === expected) checks.push('matches');
        if (expected != null && p.amount < expected) checks.push('short');
        if (expected != null && p.amount > expected) checks.push('more');
        if (o && p.from_number && bdPhone(p.from_number) && bdPhone(p.from_number) !== o.phone) checks.push('other_number');
        if ((numberOrders.get(p.from_number) ?? 0) > 1) checks.push('number_reused');
        if (!o) checks.push('no_order');
        return {
          id: p._id, method: p.method, amount: p.amount, expected, trxId: p.trx_id, from: p.from_number, screenshot: p.screenshot, source: p.source ?? 'bill', at: p.created_at,
          status: p.status, decidedAt: p.decided_at, decidedBy: users.get(p.decided_by) ?? '', reason: p.reject_reason ?? '', checks,
          order: o ? { id: o._id, number: o.number, customer: o.customer_name, phone: o.phone, total: orderTotal(o), cod: o.cod_amount, status: o.status, conversationId: o.conversation_id } : null,
        };
      }),
      counts: { waiting: c.waiting ?? 0, approved: c.approved ?? 0, rejected: c.rejected ?? 0 },
      waitingAmount: waitingSum[0]?.sum ?? 0, approvedToday: { amount: today[0]?.sum ?? 0, count: today[0]?.n ?? 0 }, rejectedToday,
      avgApproveMin: speed[0]?.avg != null ? Math.round(speed[0].avg / 60_000) : null,
    });
  });

  async function load(req) {
    const p = await db.payments.findOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id }).lean();
    if (!p) throw new InboxError(404, 'Payment not found');
    return p;
  }

  router.post('/payments/:id/approve', auth, edit, async (req, res) => {
    const p = await load(req);
    let orderId = null;
    if (req.body?.orderNumber) {
      const o = await db.orders.findOne({ workspace_id: req.user.workspace_id, number: Number(req.body.orderNumber) }, { _id: 1 }).lean();
      if (!o) throw new InboxError(404, `Order #${req.body.orderNumber} not found`);
      orderId = o._id;
    }
    const { order } = await approvePayment(db, req.user, p, { orderId, inbox: req.body?.tellCustomer === false ? null : inbox });
    await audit(db, req.user, `Approved ${p.method} ৳${p.amount} (TrxID ${p.trx_id}) for order #${order.number}`, { where: 'Payments' });
    emit(req.user.workspace_id, 'order', { id: order._id });
    emit(req.user.workspace_id, 'payment', { id: p._id });
    res.json({ ok: true, order: order.number, cod: order.cod_amount });
  });

  router.post('/payments/:id/reject', auth, edit, async (req, res) => {
    const p = await load(req);
    await rejectPayment(db, req.user, p, { reason: String(req.body?.reason ?? '').trim(), inbox: req.body?.tellCustomer === false ? null : inbox });
    await audit(db, req.user, `Rejected ${p.method} ৳${p.amount} (TrxID ${p.trx_id})`, { where: 'Payments' });
    emit(req.user.workspace_id, 'payment', { id: p._id });
    res.json({ ok: true });
  });

  // A payment the customer told the team about (call, chat): added by hand, then approved like any other.
  router.post('/payments', auth, edit, async (req, res) => {
    const ws = req.user.workspace_id;
    const o = req.body?.orderNumber ? await db.orders.findOne({ workspace_id: ws, number: Number(req.body.orderNumber) }).lean() : null;
    if (req.body?.orderNumber && !o) throw new InboxError(404, `Order #${req.body.orderNumber} not found`);
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) throw new InboxError(400, 'Enter the amount');
    const out = await recordPayment(db, { workspaceId: ws, orderId: o?._id ?? null, method: req.body?.method, amount, trxId: req.body?.trxId, from: bdPhone(req.body?.from ?? '') ?? '', source: 'team' });
    if (out.duplicate) throw new InboxError(409, 'This TrxID is already in Payments');
    emit(ws, 'payment', {});
    res.status(201).json({ id: out.payment.id });
  });

  // Advance rules tab: payment numbers, when to ask for an advance, and what the AI says.
  router.get('/payments/rules', auth, async (req, res) => {
    const ws = await db.workspaces.findById(req.user.workspace_id).lean();
    res.json({ bkash: ws.bkash_number ?? '', bkashType: ws.settings?.bkash_type ?? 'personal', nagad: ws.nagad_number ?? '', cod: ws.cash_on_delivery !== false,
      advance: advanceSettings(ws), defaultMessage: DEFAULT_ADVANCE_MESSAGE });
  });

  router.patch('/payments/rules', auth, owner, async (req, res) => {
    const b = req.body ?? {};
    const set = {};
    const money = (v, what, max = 1_000_000) => {
      if (v === null || v === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 1 || n > max) throw new InboxError(400, `Enter a valid ${what}`);
      return Math.round(n);
    };
    for (const [key, field] of [['bkash', 'bkash_number'], ['nagad', 'nagad_number']]) {
      if (b[key] === undefined) continue;
      if (!String(b[key]).trim()) { set[field] = ''; continue; }
      const phone = bdPhone(b[key]);
      if (!phone) throw new InboxError(400, `The ${key === 'bkash' ? 'bKash' : 'Nagad'} number should be 11 digits starting 01`);
      set[field] = phone;
    }
    if (['personal', 'merchant', 'agent'].includes(b.bkashType)) set['settings.bkash_type'] = b.bkashType;
    const a = b.advance ?? {};
    // Each rule: on / off, its own advance (৳ or % of the order) and its threshold (PAY-03).
    if (a.rules !== undefined) {
      const current = advanceSettings(await db.workspaces.findById(req.user.workspace_id, { settings: 1 }).lean()).rules;
      const rules = {};
      for (const k of ADVANCE_RULES) {
        const r = { ...current[k], ...(a.rules?.[k] ?? {}) };
        const kind = r.kind === 'percent' ? 'percent' : 'fixed';
        const value = Number(r.value);
        if (!Number.isFinite(value) || value < 1 || (kind === 'percent' ? value > 100 : value > 100_000)) throw new InboxError(400, kind === 'percent' ? 'An advance in % must be 1 to 100' : 'Enter the advance amount (৳1 to ৳1,00,000)');
        rules[k] = { on: Boolean(r.on), kind, value: Math.round(value) };
        if (k === 'courier_risk') { const below = Number(r.below); if (!Number.isFinite(below) || below < 1 || below > 100) throw new InboxError(400, 'Delivery success must be 1 to 100%'); rules[k].below = Math.round(below); }
        if (k === 'order_over') { const over = money(r.over, 'order amount'); if (over == null) throw new InboxError(400, 'Enter the order amount'); rules[k].over = over; }
      }
      set['settings.advance.rules'] = rules;
    }
    if (a.message !== undefined) {
      const m = String(a.message).trim().slice(0, 400);
      if (m && !m.includes('{amount}')) throw new InboxError(400, 'Keep {amount} in the message so the customer knows how much to send');
      set['settings.advance.message'] = m;
    }
    if (!Object.keys(set).length) throw new InboxError(400, 'Nothing to change');
    await db.workspaces.updateOne({ _id: req.user.workspace_id }, { $set: set });
    await audit(db, req.user, 'Changed payment numbers or advance rules', { where: 'Payments' });
    const ws = await db.workspaces.findById(req.user.workspace_id).lean();
    res.json({ advance: advanceSettings(ws), bkash: ws.bkash_number ?? '', nagad: ws.nagad_number ?? '' });
  });

  return router;
}

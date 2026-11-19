import { InboxError } from '../inbox.js';
import { orderTotal } from './orderOps.js';

// bKash / Nagad advances (PAY-01) and the rules for when to ask for one (PAY-03).

export const TRX = /^[A-Z0-9]{8,12}$/;
export const DEFAULT_ADVANCE_MESSAGE = 'অর্ডারটি কনফার্ম করতে {amount} অগ্রিম {method} ({number}) নম্বরে Send Money করে TrxID টি এখানে দিন। বাকি টাকা ডেলিভারির সময় দিবেন।';

export function advanceSettings(ws) {
  const a = ws?.settings?.advance ?? {};
  return {
    highRisk: a.high_risk !== false,
    outsideOver: a.outside_over ?? null,
    orderOver: a.order_over ?? null,
    firstOrder: Boolean(a.first_order),
    amount: a.amount ?? 300,
    message: a.message || DEFAULT_ADVANCE_MESSAGE,
  };
}

// Whether this order needs an advance, and why. Returns { amount, reason } or null.
export function advanceFor(ws, { riskLevel = 'low', zone = 'inside_dhaka', total = 0, previousOrders = 0 }) {
  if (!ws?.bkash_number && !ws?.nagad_number) return null; // nowhere to pay
  const r = advanceSettings(ws);
  const amount = Math.min(r.amount, total);
  if (amount <= 0) return null;
  if (r.highRisk && riskLevel === 'high') return { amount, reason: 'high_risk' };
  if (r.outsideOver != null && zone === 'outside_dhaka' && total > r.outsideOver) return { amount, reason: 'outside_dhaka' };
  if (r.orderOver != null && total > r.orderOver) return { amount, reason: 'order_over' };
  if (r.firstOrder && previousOrders === 0) return { amount, reason: 'first_order' };
  return null;
}

// What the AI tells the customer when an advance is needed ("What the AI says").
export function advanceMessage(ws, amount) {
  const method = ws.bkash_number ? 'বিকাশ' : 'নগদ';
  const number = ws.bkash_number || ws.nagad_number || '';
  return advanceSettings(ws).message.replace(/\{amount\}/g, `৳${Number(amount).toLocaleString('en-IN')}`).replace(/\{method\}/g, method).replace(/\{number\}/g, number);
}

// A TrxID the customer sent in chat (or read from their screenshot): waits in Payments like one from the bill page.
export async function recordPayment(db, { workspaceId, orderId = null, method, amount, trxId, from = '', screenshot = '', source = 'chat', notify = null }) {
  const trx = String(trxId ?? '').trim().toUpperCase();
  if (!TRX.test(trx)) throw new InboxError(400, 'The TrxID should be 8–12 letters and numbers');
  if (await db.payments.exists({ workspace_id: workspaceId, trx_id: trx })) return { duplicate: true };
  const order = orderId ? await db.orders.findOne({ _id: orderId, workspace_id: workspaceId }).lean() : null;
  const p = await db.insert(db.payments, {
    workspace_id: workspaceId, order_id: order?._id ?? null, method: method === 'nagad' ? 'nagad' : 'bkash', amount: Math.max(0, Math.round(Number(amount) || 0)),
    expected: order?.advance?.amount ?? null, trx_id: trx, from_number: String(from).slice(0, 20), screenshot, source,
  });
  await notify?.({ workspaceId, event: 'order', title: `Payment to check: ৳${Number(amount || 0).toLocaleString('en-IN')} by ${method === 'nagad' ? 'Nagad' : 'bKash'}`,
    body: `TrxID ${trx}${order ? ` · order #${order.number}` : ''} — approve it in Payments`, link: '/payments', ref: `pay:${trx}` }).catch(() => {});
  return { payment: p };
}

// Approve: the money is counted on the order (cash to collect goes down) and an order held for its advance goes ahead.
export async function approvePayment(db, user, payment, { orderId = null, inbox = null } = {}) {
  if (payment.status !== 'waiting') throw new InboxError(409, 'This payment was already decided');
  const order = await db.orders.findOne({ _id: orderId ?? payment.order_id, workspace_id: payment.workspace_id }).lean();
  if (!order) throw new InboxError(400, 'Pick the order this payment is for');
  const claimed = await db.payments.findOneAndUpdate({ _id: payment._id, status: 'waiting' },
    { $set: { status: 'approved', order_id: order._id, decided_by: user?.id ?? null, decided_at: new Date() } }, { new: true, lean: true });
  if (!claimed) throw new InboxError(409, 'This payment was already decided');
  const paid = (order.advance_paid ?? 0) + payment.amount;
  const total = orderTotal(order);
  const set = {
    advance_paid: paid, cod_amount: Math.max(0, total - paid), paid_in_full: paid >= total,
    payment_method: paid >= total ? 'paid' : payment.method,
    advance: { ...(order.advance ?? {}), amount: order.advance?.amount ?? payment.amount, method: payment.method, trx_id: payment.trx_id, verified: true },
    updated_at: new Date(),
  };
  // Held only for the advance → it goes ahead now.
  if (order.status === 'on_hold' && /advance/i.test(order.hold_reason ?? '')) { set.status = 'approved'; set.hold_reason = ''; }
  await db.orders.updateOne({ _id: order._id }, { $set: set });
  await db.insert(db.orderEvents, { workspace_id: order.workspace_id, order_id: order._id, type: 'payment', by: user ? 'user' : 'ai', user_id: user?.id ?? null,
    text: `${payment.method === 'nagad' ? 'Nagad' : 'bKash'} ৳${payment.amount} approved (TrxID ${payment.trx_id})${set.status ? ' — order approved' : ''}` });
  if (inbox && order.conversation_id) {
    await inbox.sendAiReply(order.conversation_id, `আপনার ৳${payment.amount.toLocaleString('en-IN')} পেমেন্ট পেয়েছি ✅ অর্ডার #${order.number}${set.cod_amount ? ` — বাকি ৳${set.cod_amount.toLocaleString('en-IN')} ডেলিভারির সময় দিবেন।` : ' পুরো পরিশোধ হয়েছে।'}`).catch(() => null);
  }
  return { order: { ...order, ...set }, payment: claimed };
}

export async function rejectPayment(db, user, payment, { reason = '', inbox = null } = {}) {
  if (payment.status !== 'waiting') throw new InboxError(409, 'This payment was already decided');
  await db.payments.updateOne({ _id: payment._id, status: 'waiting' }, { $set: { status: 'rejected', reject_reason: String(reason).slice(0, 200), decided_by: user?.id ?? null, decided_at: new Date() } });
  const order = payment.order_id ? await db.orders.findById(payment.order_id).lean() : null;
  if (order) {
    await db.insert(db.orderEvents, { workspace_id: order.workspace_id, order_id: order._id, type: 'payment', by: 'user', user_id: user?.id ?? null,
      text: `Payment TrxID ${payment.trx_id} rejected${reason ? ` — ${reason}` : ''}` });
    if (inbox && order.conversation_id) {
      await inbox.sendAiReply(order.conversation_id, `দুঃখিত, TrxID ${payment.trx_id} দিয়ে কোনো পেমেন্ট পাইনি। নম্বর আর TrxID একবার মিলিয়ে আবার পাঠাবেন?`).catch(() => null);
    }
  }
  return { ok: true };
}

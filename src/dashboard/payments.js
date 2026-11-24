import { InboxError } from '../inbox.js';
import { orderTotal } from './orderOps.js';
import { onlineFor } from './gateway.js';

// bKash / Nagad advances (PAY-01) and the rules for when to ask for one (PAY-03).

export const TRX = /^[A-Z0-9]{8,12}$/;
export const DEFAULT_ADVANCE_MESSAGE = 'অর্ডারটি কনফার্ম করতে {amount} অগ্রিম {method} ({number}) নম্বরে Send Money করে TrxID টি এখানে দিন। বাকি টাকা ডেলিভারির সময় দিবেন।';

// The four advance rules (PAY-03), each with its own amount — taka or a % of the order.
export const ADVANCE_RULES = ['outside_dhaka', 'courier_risk', 'order_over', 'first_order'];
const DEFAULT_RULES = {
  outside_dhaka: { on: false, kind: 'fixed', value: 300 },
  courier_risk: { on: true, kind: 'fixed', value: 500, below: 70 },
  order_over: { on: false, kind: 'percent', value: 20, over: 5000 },
  first_order: { on: false, kind: 'fixed', value: 200 },
};

export function advanceSettings(ws) {
  const a = ws?.settings?.advance ?? {};
  let rules;
  if (a.rules) {
    rules = Object.fromEntries(ADVANCE_RULES.map((k) => [k, { ...DEFAULT_RULES[k], ...(a.rules[k] ?? {}) }]));
  } else {
    // Settings saved before rules had their own amounts: one amount for every rule.
    const amount = a.amount ?? 300;
    rules = {
      outside_dhaka: { ...DEFAULT_RULES.outside_dhaka, on: a.outside_over != null, value: amount },
      courier_risk: { ...DEFAULT_RULES.courier_risk, on: a.high_risk !== false, value: amount },
      order_over: { ...DEFAULT_RULES.order_over, on: a.order_over != null, kind: 'fixed', value: amount, over: a.order_over ?? 5000 },
      first_order: { ...DEFAULT_RULES.first_order, on: Boolean(a.first_order), value: amount },
    };
  }
  return { rules, message: a.message || DEFAULT_ADVANCE_MESSAGE };
}

const ruleAmount = (r, total) => Math.min(total, r.kind === 'percent' ? Math.round((total * r.value) / 100) : r.value);

// Whether this order needs an advance, and why. When several rules match, the largest advance wins.
// courierRate: the customer's delivery success % from the courier check (null when unknown).
export function advanceFor(ws, { riskLevel = 'low', courierRate = null, zone = 'inside_dhaka', total = 0, previousOrders = 0 }) {
  if (!ws?.bkash_number && !ws?.nagad_number && !onlineFor(ws, 'advance')) return null; // nowhere to pay
  const { rules } = advanceSettings(ws);
  const hits = [];
  if (rules.outside_dhaka.on && zone === 'outside_dhaka') hits.push('outside_dhaka');
  // The courier check stores a 0–1 fraction (0.85 = 85%); the rule is in %.
  const pct = courierRate != null && courierRate <= 1 ? courierRate * 100 : courierRate;
  if (rules.courier_risk.on && (pct != null ? pct < rules.courier_risk.below : riskLevel === 'high')) hits.push('courier_risk');
  if (rules.order_over.on && total > rules.order_over.over) hits.push('order_over');
  if (rules.first_order.on && previousOrders === 0) hits.push('first_order');
  let best = null;
  for (const reason of hits) {
    const amount = ruleAmount(rules[reason], total);
    if (amount > 0 && (!best || amount > best.amount)) best = { amount, reason };
  }
  return best;
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
    text: payment.gateway ? `Paid ৳${payment.amount} online with ${({ sslcommerz: 'SSLCommerz', bkash: 'bKash', nagad: 'Nagad' })[payment.gateway] ?? payment.gateway} — checked with the gateway (${payment.trx_id})${set.status ? ' — order approved' : ''}` : `${payment.method === 'nagad' ? 'Nagad' : 'bKash'} ৳${payment.amount} approved (TrxID ${payment.trx_id})${set.status ? ' — order approved' : ''}` });
  if (inbox && order.conversation_id) {
    await inbox.purchaseUpdate(order.conversation_id, `আপনার ৳${payment.amount.toLocaleString('en-IN')} পেমেন্ট পেয়েছি ✅ অর্ডার #${order.number}${set.cod_amount ? ` — বাকি ৳${set.cod_amount.toLocaleString('en-IN')} ডেলিভারির সময় দিবেন।` : ' পুরো পরিশোধ হয়েছে।'}`).catch(() => null);
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
      await inbox.purchaseUpdate(order.conversation_id, `দুঃখিত, TrxID ${payment.trx_id} দিয়ে কোনো পেমেন্ট পাইনি। নম্বর আর TrxID একবার মিলিয়ে আবার পাঠাবেন?`).catch(() => null);
    }
  }
  return { ok: true };
}

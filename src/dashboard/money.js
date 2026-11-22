import { InboxError } from '../inbox.js';
import { COURIERS } from '../adapters/couriers.js';
import { adjustStock, changeStatus, stage } from './orderOps.js';
import { dhakaDayStart } from './util.js';

// Phase 2 · Money & follow-up (OMS-05 / OMS-07): cash the couriers owe, parcels that came back,
// and customers nobody could reach.

// Days after delivery until a courier usually pays out (Steadfast next day, Pathao about two).
export const SETTLE_DAYS = { steadfast: 1, pathao: 2, redx: 3, paperfly: 3, ecourier: 3 };
const courierKey = (name) => Object.entries(COURIERS).find(([k, c]) => k === name || c.name === name)?.[0] ?? String(name ?? '').toLowerCase();
const DAY = 86_400_000;
const dayKey = (d) => new Date(new Date(d).getTime() + 6 * 3_600_000).toISOString().slice(0, 10);

// ---- Cash from couriers ----
// Delivered parcels booked through Quicky and not paid out yet, one row per courier and delivery day.
export async function cashRows(db, workspaceId, now = new Date()) {
  const unpaid = await db.consignments.find({ workspace_id: workspaceId, payout_id: null }).lean();
  const orders = new Map((await db.orders.find({ _id: { $in: unpaid.map((c) => c.order_id) }, status: 'delivered' },
    { number: 1, cod_amount: 1, delivered_at: 1, updated_at: 1 }).lean()).map((o) => [o._id, o]));
  const groups = new Map();
  for (const c of unpaid) {
    const o = orders.get(c.order_id);
    if (!o) continue;
    const key = courierKey(c.courier);
    const delivered = o.delivered_at ?? o.updated_at ?? c.created_at;
    const day = dayKey(delivered);
    const g = groups.get(`${key}:${day}`) ?? { key: `${key}:${day}`, courier: key, name: COURIERS[key]?.name ?? c.courier, from: day, to: day, parcels: 0, collected: 0, fees: 0, ids: [] };
    g.parcels += 1;
    g.collected += c.cod_collected || o.cod_amount || 0;
    g.fees += c.fee || 0;
    g.ids.push(c._id);
    groups.set(g.key, g);
  }
  const today = dhakaDayStart(now);
  return [...groups.values()].map((g) => {
    const due = new Date(dhakaDayStart(new Date(`${g.from}T12:00:00+06:00`)).getTime() + (SETTLE_DAYS[g.courier] ?? 3) * DAY);
    const daysLeft = Math.round((due - today) / DAY);
    return { ...g, amount: g.collected - g.fees, dueAt: due, status: daysLeft < 0 ? 'late' : daysLeft === 0 ? 'due_today' : daysLeft === 1 ? 'due_tomorrow' : 'upcoming', lateDays: Math.max(0, -daysLeft) };
  }).sort((a, b) => a.dueAt - b.dueAt);
}

export async function markPayoutReceived(db, user, key) {
  const rows = await cashRows(db, user.workspace_id);
  const row = rows.find((r) => r.key === key);
  if (!row) throw new InboxError(404, 'That payout is already marked or has no parcels');
  const payout = await db.insert(db.payouts, {
    workspace_id: user.workspace_id, courier: row.courier, from: new Date(`${row.from}T00:00:00+06:00`), to: new Date(`${row.to}T23:59:59+06:00`),
    parcels: row.parcels, collected: row.collected, fees: row.fees, amount: row.amount, by_user_id: user.id,
  });
  await db.consignments.updateMany({ _id: { $in: row.ids }, payout_id: null }, { $set: { payout_id: payout.id } });
  return { id: payout.id, amount: row.amount, parcels: row.parcels };
}

// ---- Returns & exchanges ----
const itemsValue = (o) => (o.subtotal ?? 0) - (o.discount ?? 0);

// A parcel the courier brought back (order → returned): the delivery and return fees are lost.
export async function recordReturn(db, order, { reason = '' } = {}) {
  if (await db.returns.exists({ order_id: order._id, type: 'return' })) return null;
  const c = await db.consignments.findOne({ order_id: order._id }).sort({ created_at: -1 }).lean();
  const fee = c?.fee || order.delivery_charge || 0;
  return db.insert(db.returns, {
    workspace_id: order.workspace_id, order_id: order._id, type: 'return', reason: reason || (c?.status ? `Courier: ${c.status.replace(/_/g, ' ')}` : 'Came back from the courier'),
    parcel: 'coming', loss: fee + Math.round(fee / 2),
  });
}

// A solved ticket that sent a replacement (exchange) or was about a damaged item.
export async function recordReturnFromTicket(db, ticket, kind) {
  if (!ticket.order_id || !['exchanged', 'replaced', 'right_item'].includes(kind)) return null;
  if (await db.returns.exists({ ticket_id: ticket._id })) return null;
  const order = await db.orders.findById(ticket.order_id).lean();
  if (!order) return null;
  const damaged = ticket.type === 'damaged';
  return db.insert(db.returns, {
    workspace_id: ticket.workspace_id, order_id: order._id, ticket_id: ticket._id, type: damaged ? 'damaged' : 'exchange',
    reason: (ticket.title || '').slice(0, 120), parcel: 'coming', loss: damaged ? itemsValue(order) + (order.delivery_charge ?? 0) : order.delivery_charge ?? 0,
  });
}

export const RETURN_ACTIONS = ['picked', 'back', 'restock', 'cant_sell', 'claim', 'done'];
export async function updateReturn(db, user, id, action) {
  const r = await db.returns.findOne({ _id: Number(id), workspace_id: user.workspace_id }).lean();
  if (!r) throw new InboxError(404, 'Return not found');
  if (!RETURN_ACTIONS.includes(action)) throw new InboxError(400, 'Unknown action');
  const order = await db.orders.findById(r.order_id).lean();
  const set = {};
  if (action === 'picked') set.parcel = 'picked';
  if (action === 'back') set.parcel = 'back';
  if (action === 'restock') {
    if (r.stock === 'restocked') throw new InboxError(409, 'Already back in stock');
    if (order) await adjustStock(db, order, +1);
    Object.assign(set, { stock: 'restocked', parcel: 'back', ...(r.type === 'damaged' ? { loss: Math.max(0, r.loss - itemsValue(order ?? {})) } : {}) });
  }
  if (action === 'cant_sell') {
    if (r.stock !== 'waiting') throw new InboxError(409, 'The stock is already sorted');
    Object.assign(set, { stock: 'cant_sell', parcel: 'back', ...(r.type !== 'damaged' && order ? { loss: r.loss + itemsValue(order) } : {}) });
  }
  if (action === 'claim') {
    if (r.claim) throw new InboxError(409, 'Already claimed from the courier');
    set.claim = { at: new Date(), by: user.name };
  }
  if (action === 'done') set.done_at = new Date();
  await db.returns.updateOne({ _id: r._id }, { $set: set });
  if (order) {
    const what = { picked: 'Return picked up', back: 'Return back in the shop', restock: 'Returned items put back in stock', cant_sell: "Returned items can't be sold", claim: 'Claimed the damage from the courier', done: 'Return closed' }[action];
    await db.insert(db.orderEvents, { workspace_id: user.workspace_id, order_id: order._id, type: 'note', by: 'user', user_id: user.id, text: `${user.name}: ${what}` });
  }
  return { ...r, ...set };
}

// ---- To chase ----
// The next try: two hours later, or tomorrow 11 AM after three tries.
export function nextTry(tries, now = new Date()) {
  if (tries < 3) return new Date(now.getTime() + 2 * 3_600_000);
  return new Date(dhakaDayStart(now, 1).getTime() + 11 * 3_600_000);
}

export async function startChase(db, user, order, { reason = '', emit = () => {} } = {}) {
  if (['delivered', 'cancelled', 'returned'].includes(stage(order.status))) throw new InboxError(409, `Order #${order.number} is ${stage(order.status)} — nothing to chase`);
  if (order.chase?.active) return order.chase;
  const conv = order.conversation_id ? await db.conversations.findById(order.conversation_id, { assigned_user_id: 1 }).lean() : null;
  const chase = { active: true, reason: reason || "Couldn't reach the customer", tries: [], next_at: new Date(), owner_user_id: user?.id ?? conv?.assigned_user_id ?? null, added_at: new Date(), result: null };
  await db.orders.updateOne({ _id: order._id }, { $set: { chase } });
  // "Their orders are paused until someone reaches them."
  if (['pending', 'approved'].includes(stage(order.status))) {
    await db.orders.updateOne({ _id: order._id }, { $set: { hold_reason: "Couldn't reach the customer" } });
    await changeStatus(db, user, order, 'on_hold', { emit, by: user ? 'user' : 'system', text: "Paused — couldn't reach the customer" }).catch(() => null);
  }
  await db.insert(db.orderEvents, { workspace_id: order.workspace_id, order_id: order._id, type: 'note', by: user ? 'user' : 'system', user_id: user?.id ?? null, text: `Added to To chase: ${chase.reason}` });
  return chase;
}

export async function logTry(db, user, order, kind) {
  if (!order.chase?.active) throw new InboxError(409, 'This order is not on the To chase list');
  if (!['call', 'whatsapp'].includes(kind)) throw new InboxError(400, 'A try is a call or a WhatsApp');
  const tries = [...(order.chase.tries ?? []), { kind, at: new Date(), by: user.name }];
  const chase = { ...order.chase, tries, next_at: nextTry(tries.length) };
  await db.orders.updateOne({ _id: order._id }, { $set: { chase } });
  return chase;
}

export const CHASE_RESULTS = ['confirmed', 'no_answer', 'cancel'];
export async function chaseResult(db, user, order, result, { emit = () => {} } = {}) {
  if (!order.chase?.active) throw new InboxError(409, 'This order is not on the To chase list');
  if (!CHASE_RESULTS.includes(result)) throw new InboxError(400, 'Pick Confirmed, No answer or Cancel');
  if (result === 'no_answer') {
    const chase = await logTry(db, user, order, 'call');
    await db.insert(db.orderEvents, { workspace_id: order.workspace_id, order_id: order._id, type: 'note', by: 'user', user_id: user.id, text: `${user.name} called — no answer (try ${chase.tries.length})` });
    return { chase };
  }
  const chase = { ...order.chase, active: false, result, closed_at: new Date() };
  await db.orders.updateOne({ _id: order._id }, { $set: { chase, ...(result === 'confirmed' ? { hold_reason: '' } : {}) } });
  if (result === 'confirmed') {
    if (stage(order.status) === 'on_hold') await changeStatus(db, user, order, 'approved', { emit, text: `${user.name} reached the customer — confirmed` });
    else await db.insert(db.orderEvents, { workspace_id: order.workspace_id, order_id: order._id, type: 'note', by: 'user', user_id: user.id, text: `${user.name} reached the customer — confirmed` });
  } else {
    await changeStatus(db, user, order, 'cancelled', { emit, reason: 'other', text: "Cancelled — couldn't reach the customer" });
  }
  return { chase };
}

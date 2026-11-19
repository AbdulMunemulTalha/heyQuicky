import { InboxError } from '../inbox.js';
import { decryptSecret } from '../secrets.js';
import { COURIERS, courierClient } from '../adapters/couriers.js';
import { audit } from './util.js';

// The order pipeline (OMS-02) and which moves are allowed from each stage.
export const STAGES = ['pending', 'on_hold', 'approved', 'processing', 'ready_to_ship', 'in_transit', 'delivered', 'cancelled', 'returned'];
const LEGACY = { confirmed: 'pending', shipped: 'in_transit' };
export const stage = (status) => LEGACY[status] ?? status;
export const NEXT = {
  pending: ['approved', 'on_hold', 'cancelled'],
  on_hold: ['pending', 'approved', 'cancelled'],
  approved: ['processing', 'ready_to_ship', 'on_hold', 'cancelled'],
  processing: ['ready_to_ship', 'on_hold', 'cancelled'],
  ready_to_ship: ['in_transit', 'processing', 'cancelled'],
  in_transit: ['delivered', 'returned', 'cancelled'],
  delivered: ['returned'],
  cancelled: ['pending'],
  returned: [],
};
export const CANCEL_REASONS = ['customer_cancelled', 'fake_order', 'out_of_stock', 'duplicate', 'other'];

export const orderTotal = (o) => (o.subtotal ?? 0) + (o.delivery_charge ?? 0) - (o.discount ?? 0);

// Puts an order's items back in stock (cancel with "Put the items back") or takes them out.
export async function adjustStock(db, order, sign, { notify = null } = {}) {
  for (const item of order.product_items ?? []) {
    if (!item.product_id) continue;
    const product = await db.products.findById(item.product_id).lean();
    if (!product) continue;
    const list = (product.variant_list ?? []).map((v) => (v.sku === item.sku && v.stock !== null && v.stock !== undefined
      ? { ...v, stock: Math.max(0, v.stock + sign * (item.qty ?? 1)) } : v));
    await db.products.updateOne({ _id: product._id }, { $set: { variant_list: list, in_stock: list.some((v) => v.stock === null || v.stock === undefined || v.stock > 0) } });
    const before = (product.variant_list ?? []).find((v) => v.sku === item.sku);
    const after = list.find((v) => v.sku === item.sku);
    if (notify && sign < 0 && before?.stock > 0 && after?.stock === 0) {
      const label = Object.values(after.options ?? {}).join(' / ') || item.variant || '';
      await notify({ workspaceId: product.workspace_id, event: 'stock', title: `Low stock: ${product.name}${label ? ` ${label}` : ''}`,
        body: 'is sold out. The AI stopped offering it.', link: `/catalog/${product._id}`, ref: `stock:${product._id}:${item.sku}` });
    }
  }
}

// Something to run after every status change (CRR-04 delivery updates), one per database.
const statusListeners = new WeakMap();
export function onStatusChange(db, fn) { statusListeners.set(db, fn); }

// Moves an order to another stage, writing the history and keeping the customer's numbers right.
export async function changeStatus(db, user, order, to, { reason = '', restock = true, emit = () => {}, by = 'user', text = '' } = {}) {
  const from = stage(order.status);
  if (from === to) return order;
  if (!STAGES.includes(to)) throw new InboxError(400, 'Unknown order status');
  if (!NEXT[from]?.includes(to)) throw new InboxError(409, `An order that is ${from.replace(/_/g, ' ')} can't move to ${to.replace(/_/g, ' ')}`);
  const set = { status: to, updated_at: new Date() };
  if (to === 'cancelled') {
    if (!CANCEL_REASONS.includes(reason)) throw new InboxError(400, 'Pick a reason for cancelling');
    set.cancel_reason = reason;
  }
  await db.orders.updateOne({ _id: order._id }, { $set: set });
  if (to === 'cancelled' && restock) await adjustStock(db, order, +1);
  if (from === 'cancelled' && to === 'pending') await adjustStock(db, order, -1);
  if (order.customer_id) {
    const inc = {};
    if (to === 'delivered') Object.assign(inc, { 'stats.delivered': 1, 'stats.spent': orderTotal(order) });
    if (to === 'returned') Object.assign(inc, { 'stats.returned': 1, ...(from === 'delivered' ? { 'stats.delivered': -1, 'stats.spent': -orderTotal(order) } : {}) });
    if (to === 'cancelled') inc['stats.cancelled'] = 1;
    if (Object.keys(inc).length) await db.customers.updateOne({ _id: order.customer_id }, { $inc: inc });
  }
  await db.insert(db.orderEvents, {
    workspace_id: order.workspace_id, order_id: order._id, type: 'status', from, to, by, user_id: user?.id ?? null,
    text: text || (to === 'cancelled' ? `Cancelled — ${reason.replace(/_/g, ' ')}` : ''),
  });
  if (user) await audit(db, user, `Changed order #${order.number ?? order._id} status ${from.replace(/_/g, ' ')} → ${to.replace(/_/g, ' ')}`, { where: 'Orders' });
  emit(order.workspace_id, 'order', { id: order._id, number: order.number, status: to });
  const listener = statusListeners.get(db);
  if (listener) Promise.resolve(listener({ ...order, ...set }, from, to)).catch((err) => console.warn(`after status change of order ${order._id}: ${err.message}`));
  return { ...order, ...set };
}

// Books a parcel with a courier (CRR-01). The shop's keys come from Settings → Couriers.
export async function bookCourier(db, config, user, order, courier, { emit = () => {}, fetchImpl } = {}) {
  if (!COURIERS[courier]) throw new InboxError(400, 'Unknown courier');
  const s = stage(order.status);
  if (!['approved', 'processing', 'ready_to_ship'].includes(s)) throw new InboxError(409, `Order #${order.number} is ${s.replace(/_/g, ' ')} — approve it before booking a courier`);
  if (order.consignment_id) throw new InboxError(409, `Order #${order.number} is already booked with ${order.courier}`);
  const account = await db.courierAccounts.findOne({ workspace_id: order.workspace_id, courier }).lean();
  if (!account?.connected && !config.dryRun) throw new InboxError(409, `Connect ${COURIERS[courier].name} in Settings → Couriers first`);
  let creds = null;
  if (account?.credentials) {
    try { creds = JSON.parse(decryptSecret(account.credentials, config.tokenKey)); } catch { creds = null; }
  }
  const client = courierClient(courier, creds, { dryRun: config.dryRun, fetchImpl });
  let result;
  try {
    result = await client.book(order);
  } catch (err) {
    throw new InboxError(502, `${COURIERS[courier].name} didn't accept order #${order.number}: ${err.message}`);
  }
  await db.insert(db.consignments, {
    workspace_id: order.workspace_id, order_id: order._id, courier, consignment_id: result.consignmentId, tracking_code: result.trackingCode,
    status: result.status, fee: result.fee ?? 0, events: [{ status: 'booked', at: new Date(), text: `Booked with ${COURIERS[courier].name}` }],
  });
  await db.orders.updateOne({ _id: order._id }, { $set: { courier: COURIERS[courier].name, consignment_id: result.consignmentId } });
  await db.insert(db.orderEvents, { workspace_id: order.workspace_id, order_id: order._id, type: 'courier', by: 'user', user_id: user.id,
    text: `Booked ${COURIERS[courier].name} · ${result.consignmentId}${client.mode === 'fake' ? ' (test mode)' : ''}` });
  const moved = await changeStatus(db, user, { ...order, status: 'ready_to_ship' }, 'in_transit', { emit, text: `Handed to ${COURIERS[courier].name}` })
    .catch(() => order);
  return { ...moved, courier: COURIERS[courier].name, consignment_id: result.consignmentId, testMode: client.mode === 'fake' };
}

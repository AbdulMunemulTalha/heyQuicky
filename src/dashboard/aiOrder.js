import { randomBytes } from 'node:crypto';
import { InboxError } from '../inbox.js';
import { advanceFor } from './payments.js';
import { priceOrder, cleanCustomer } from './orderBuild.js';
import { riskFor } from './risk.js';
import { adjustStock, aiOrderPlaced, changeStatus } from './orderOps.js';
import { orderSummary } from '../platforms/rich.js';
import { personalOffer } from './offers.js';
import { markLeadWon } from './leads.js';
import { fireEvent, orderData } from './webhooks.js';

const ZONES = ['inside_dhaka', 'dhaka_suburbs', 'outside_dhaka'];
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9ঀ-৿]+/g, ' ').trim();

// "M", "teal m", "Teal / M", "xl size" → the product's variant SKU, or null when it doesn't match one.
export function matchVariant(product, said) {
  const list = product.variant_list ?? [];
  if (!list.length) return { sku: undefined };
  const words = norm(said).split(' ').filter(Boolean);
  const scored = list.map((v) => {
    const values = Object.values(v.options ?? {}).map(norm);
    // Whole words only ("S" must not match inside "small"); multi-word values like "free size" match as a phrase.
    const hits = values.filter((val) => words.includes(val) || (val.includes(' ') && ` ${norm(said)} `.includes(` ${val} `))).length;
    return { v, hits, all: hits === values.length };
  }).filter((x) => x.all).sort((a, b) => b.hits - a.hits);
  return scored.length === 1 || (scored.length > 1 && scored[0].hits > scored[1].hits) ? { sku: scored[0].v.sku } : null;
}

// The AI's items ({ product_id, variant, qty }) → priceOrder items, checked against the catalog.
async function itemsFrom(db, ws, list) {
  const products = new Map((await db.products.find({ _id: { $in: (list ?? []).map((i) => Number(i.product_id)) }, workspace_id: ws._id }).lean()).map((p) => [p._id, p]));
  return (list ?? []).slice(0, 10).map((i) => {
    const p = products.get(Number(i.product_id));
    if (!p || p.archived || p.visibility === 'hidden') throw new InboxError(400, 'The AI picked a product that is not in the catalog');
    const v = matchVariant(p, i.variant);
    if (!v) throw new InboxError(400, `The size or colour "${i.variant}" for ${p.name} didn't match the catalog`);
    return { productId: p._id, sku: v.sku, qty: Math.max(1, Math.min(99, Number(i.qty) || 1)) };
  });
}

// The offers this order used are marked used, so the customer can't use them twice (FUP-07).
async function markOffers(db, { workspaceId, customerId, orderId, offerId, code }) {
  const now = new Date();
  if (offerId) await db.offers.updateOne({ _id: offerId, used_at: null }, { $set: { used_at: now, order_id: orderId } });
  if (code) await db.offers.updateOne({ workspace_id: workspaceId, customer_id: customerId, code, used_at: null }, { $set: { used_at: now, order_id: orderId } });
}

// ORD-06: the order in this chat that still waits for the customer's "Yes, confirm" — the one they may
// change or cancel in chat. Orders the customer confirmed, the team approved, or paid an advance on are not.
export async function openAiOrder(db, conversationId) {
  return db.orders.findOne({
    conversation_id: conversationId, source: 'ai', draft: { $ne: true }, status: { $in: ['pending', 'on_hold'] },
    'advance.verified': { $ne: true }, created_at: { $gte: new Date(Date.now() - 7 * 86_400_000) },
  }).sort({ created_at: -1 }).lean();
}

const FIELD_NAMES = { name: 'name', phone: 'phone', address: 'address', zone: 'delivery area', items: 'items', note: 'note', coupon: 'coupon' };

// ORD-06: the customer changes or cancels that order in chat before confirming. Edits are priced again
// from the live catalog, stock is swapped, the shop's advance rules are checked again, and the customer
// gets a new summary card. Returns { kind: 'changed' | 'same' | 'cancelled', order, changes, rich }.
export async function changeAiOrder(db, { conversation, order, change, notify = null, publicUrl = '' }) {
  const ws = await db.workspaces.findById(order.workspace_id).lean();
  const ref = `#${order.number ?? order._id}`;
  if (change.action === 'cancel') {
    const done = await changeStatus(db, null, order, 'cancelled', { reason: 'customer_cancelled', by: 'customer', text: 'Customer cancelled in chat before confirming' });
    if (order.coupon_code) await db.coupons.updateOne({ workspace_id: ws._id, code: order.coupon_code, used: { $gt: 0 } }, { $inc: { used: -1 } });
    // An offer used on it can be used again until it ends.
    await db.offers.updateMany({ order_id: order._id }, { $set: { used_at: null, order_id: null } });
    // Never confirmed, so it doesn't count against the customer's record (risk score, delivery rate).
    if (order.customer_id) await db.customers.updateOne({ _id: order.customer_id }, { $inc: { 'stats.cancelled': -1, 'stats.orders': -1 } });
    await notify?.({ workspaceId: ws._id, event: 'order', title: `${order.customer_name} cancelled order ${ref}`, body: 'Cancelled in chat before confirming. The stock is back.', link: `/orders/${order.number ?? order._id}`, ref: `cancel:${order._id}` });
    return { kind: 'cancelled', order: done, changes: ['cancelled'], rich: null };
  }

  const who = cleanCustomer({ name: change.name, phone: change.phone, address: change.address });
  const zone = ZONES.includes(change.zone) ? change.zone : order.zone ?? order.area ?? 'inside_dhaka';
  const items = await itemsFrom(db, ws, change.items);
  const customer = order.customer_id ? await db.customers.findById(order.customer_id).lean() : null;
  const priced = await priceOrder(db, ws, { items, zone, coupon: String(change.coupon ?? '').trim().slice(0, 30), existing: order, customer });

  const sameItems = JSON.stringify(priced.lines.map((l) => [l.product_id, l.sku, l.qty])) === JSON.stringify((order.product_items ?? []).map((l) => [l.product_id, l.sku, l.qty]));
  const note = String(change.note ?? '').slice(0, 300);
  const changes = Object.entries({
    name: who.name !== order.customer_name, phone: who.phone !== order.phone, address: who.address !== order.address, zone: zone !== (order.zone ?? order.area),
    items: !sameItems, note: note !== (order.note ?? ''), coupon: priced.couponCode !== (order.coupon_code ?? ''),
  }).filter(([, changed]) => changed).map(([k]) => k);
  if (!changes.length) return { kind: 'same', order, changes, rich: null };

  // Stock: give back what the old order held, then take what the new one needs.
  await adjustStock(db, order, +1);
  await adjustStock(db, { product_items: priced.lines }, -1, { notify });
  if (priced.couponCode !== (order.coupon_code ?? '')) {
    if (order.coupon_code) await db.coupons.updateOne({ workspace_id: ws._id, code: order.coupon_code, used: { $gt: 0 } }, { $inc: { used: -1 } });
    if (priced.couponCode) await db.coupons.updateOne({ workspace_id: ws._id, code: priced.couponCode }, { $inc: { used: 1 } });
  }
  // A new area or total may change whether the shop wants an advance (PAY-03).
  const risk = riskFor({ delivered: customer?.stats?.delivered, returned: customer?.stats?.returned, cancelled: customer?.stats?.cancelled, codAmount: priced.cod, outsideDhaka: zone === 'outside_dhaka' });
  const advance = advanceFor(ws, { riskLevel: risk.level, courierRate: customer?.courier_check?.rate ?? null, zone, total: priced.total, previousOrders: Math.max(0, (customer?.stats?.orders ?? 1) - 1) });
  const status = advance || risk.level === 'high' ? 'on_hold' : 'pending';
  const holdReason = advance ? `Waiting for ৳${advance.amount} advance (${advance.reason.replace(/_/g, ' ')})` : status === 'on_hold' ? `High return risk (${risk.score}%)` : '';
  await db.orders.updateOne({ _id: order._id }, { $set: {
    customer_name: who.name, phone: who.phone, address: who.address, area: zone, zone,
    items: priced.lines.map((l) => ({ name: `${l.name}${l.variant ? ` (${l.variant})` : ''}`, qty: l.qty, price: l.price })), product_items: priced.lines,
    subtotal: priced.subtotal, delivery_charge: priced.delivery, discount: priced.discount, coupon_code: priced.couponCode, offer: priced.offer, cod_amount: priced.cod,
    note, status, hold_reason: holdReason, risk,
    advance: advance ? { amount: advance.amount, method: order.advance?.method ?? (ws.bkash_number ? 'bkash' : 'nagad'), verified: false, requested: true, reason: advance.reason } : null,
    updated_at: new Date(),
  } });
  if (order.customer_id) await db.customers.updateOne({ _id: order.customer_id }, { $addToSet: { phones: who.phone }, $set: { address: who.address } });
  const said = changes.map((k) => FIELD_NAMES[k]).join(', ');
  const before = `৳${(order.subtotal + order.delivery_charge - order.discount).toLocaleString('en-IN')}`;
  const after = `৳${priced.total.toLocaleString('en-IN')}`;
  await db.insert(db.orderEvents, { workspace_id: ws._id, order_id: order._id, type: 'edit', by: 'customer',
    text: `Customer changed the ${said} in chat before confirming${before !== after ? ` (${before} → ${after})` : ''}${status !== order.status ? ` · now ${status.replace('_', ' ')}` : ''}` });
  await notify?.({ workspaceId: ws._id, event: 'order', title: `${who.name} changed order ${ref}`, body: `${said[0].toUpperCase()}${said.slice(1)} changed in chat · ${after}. Still waiting for them to confirm.`, link: `/orders/${order.number ?? order._id}`, ref: `edit:${order._id}:${Date.now()}`, amount: priced.total });
  const fresh = await db.orders.findById(order._id).lean();
  return { kind: 'changed', order: fresh, changes, advance, rich: orderSummary(fresh, { billUrl: publicUrl && fresh.bill_token ? `${publicUrl}/b/${fresh.bill_token}` : '' }) };
}

// ORD-01: the AI turns a chat into an order. It is saved as pending (or on hold when the customer is
// high risk) and the customer gets the summary card with "Yes, confirm" (ORD-02). Throws InboxError with
// a short reason when something is missing, so the AI can hand the chat to the team instead.
export async function placeAiOrder(db, { conversation, input, notify = null, publicUrl = '' }) {
  const ws = await db.workspaces.findById(conversation.workspace_id).lean();
  const who = cleanCustomer({ name: input.name, phone: input.phone, address: input.address });
  const zone = ZONES.includes(input.zone) ? input.zone : 'inside_dhaka';
  const items = await itemsFrom(db, ws, input.items);
  const { order, advance, billToken } = await saveOrder(db, ws, { who, items, zone, coupon: String(input.coupon ?? '').trim().slice(0, 30), conversation, note: input.note, source: 'ai', notify });
  aiOrderPlaced(db, order);
  return { order, advance, rich: orderSummary(order, { billUrl: publicUrl ? `${publicUrl}/b/${billToken}` : '' }) };
}

// Prices and saves an order for a customer from the chat (AI) or the product page (ORD-04).
// The customer record is found from the chat or the phone and updated; risk and the shop's advance
// rules decide whether it waits on hold. Stock is taken, the coupon counted and the team notified.
export async function saveOrder(db, ws, { who, items, zone, coupon = '', conversation = null, note = '', source, notify = null }) {
  let customer = conversation?.customer_id ? await db.customers.findById(conversation.customer_id).lean() : null;
  customer ??= await db.customers.findOne({ workspace_id: ws._id, phones: who.phone }).lean();
  const priced = await priceOrder(db, ws, { items, zone, coupon, customer, offer: coupon ? null : await personalOffer(db, customer?._id) });
  if (!customer) customer = { _id: (await db.insert(db.customers, { workspace_id: ws._id, name: who.name, phones: [who.phone] })).id };
  await db.customers.updateOne({ _id: customer._id }, { $addToSet: { phones: who.phone }, $set: { address: who.address, ...(customer.name ? {} : { name: who.name }) } });
  if (conversation && !conversation.customer_id) await db.conversations.updateOne({ _id: conversation._id }, { $set: { customer_id: customer._id } });
  customer = await db.customers.findById(customer._id).lean();

  const risk = riskFor({ delivered: customer.stats?.delivered, returned: customer.stats?.returned, cancelled: customer.stats?.cancelled, codAmount: priced.cod, outsideDhaka: zone === 'outside_dhaka' });
  // PAY-03: the shop's rules may ask for an advance first (high risk, outside Dhaka over ৳X, …).
  const advance = advanceFor(ws, { riskLevel: risk.level, courierRate: customer.courier_check?.rate ?? null, zone, total: priced.total, previousOrders: customer.stats?.orders ?? 0 });
  const status = advance || risk.level === 'high' ? 'on_hold' : 'pending';
  const holdReason = advance ? `Waiting for ৳${advance.amount} advance (${advance.reason.replace(/_/g, ' ')})` : status === 'on_hold' ? `High return risk (${risk.score}%)` : '';
  const { order_seq: number } = await db.workspaces.findOneAndUpdate({ _id: ws._id }, { $inc: { order_seq: 1 } }, { new: true, lean: true });
  const billToken = randomBytes(9).toString('base64url');
  const byAi = source === 'ai';
  const created = await db.insert(db.orders, {
    workspace_id: ws._id, number, customer_id: customer._id, conversation_id: conversation?._id ?? null,
    customer_name: who.name, phone: who.phone, address: who.address, area: zone, zone,
    items: priced.lines.map((l) => ({ name: `${l.name}${l.variant ? ` (${l.variant})` : ''}`, qty: l.qty, price: l.price })), product_items: priced.lines,
    subtotal: priced.subtotal, delivery_charge: priced.delivery, discount: priced.discount, coupon_code: priced.couponCode, offer: priced.offer, advance_paid: 0, cod_amount: priced.cod, payment_method: 'cod',
    note: String(note ?? '').slice(0, 300), status, hold_reason: holdReason, risk,
    advance: advance ? { amount: advance.amount, method: ws.bkash_number ? 'bkash' : 'nagad', verified: false, requested: true, reason: advance.reason } : null,
    source, ...(byAi ? { taken_by: 'ai' } : {}), bill_token: billToken,
  });
  await adjustStock(db, { product_items: priced.lines }, -1, { notify });
  if (priced.couponCode) await db.coupons.updateOne({ workspace_id: ws._id, code: priced.couponCode }, { $inc: { used: 1 } });
  await markOffers(db, { workspaceId: ws._id, customerId: customer._id, orderId: created.id, offerId: priced.offer?.id, code: priced.couponCode });
  await db.customers.updateOne({ _id: customer._id }, { $inc: { 'stats.orders': 1 } });
  const how = { ai: 'The AI took the order in chat', product_page: 'The customer ordered on the product page', api: 'Created through the API' }[source] ?? 'Order created';
  await db.insert(db.orderEvents, { workspace_id: ws._id, order_id: created.id, type: 'status', to: status, by: byAi ? 'ai' : 'customer', text: `${how}${status === 'on_hold' ? (advance ? ' (on hold: advance needed)' : ' (on hold: high return risk)') : ''}` });
  const total = priced.subtotal + priced.delivery - priced.discount;
  await notify?.({ workspaceId: ws._id, event: 'order', title: `New order #${number}`, body: `${who.name} · ৳${total.toLocaleString('en-IN')} · ${{ ai: 'taken by AI, waiting for the customer to confirm', product_page: 'from the product page', api: 'from your API' }[source] ?? 'new order'}`, link: `/orders/${number}`, ref: `order:${created.id}`, amount: total });
  if (status === 'on_hold' && !advance) {
    await notify?.({ workspaceId: ws._id, event: 'escalation', title: `Order #${number} needs a look.`, body: `High return risk (${risk.score}%). ${risk.action}.`, link: `/orders/${number}`, ref: `risk:${created.id}` });
  }
  const order = await db.orders.findById(created.id).lean();
  await markLeadWon(db, order).catch(() => {});
  fireEvent(db, ws._id, 'order.created', orderData(order)).catch(() => {});
  return { order, advance, billToken };
}

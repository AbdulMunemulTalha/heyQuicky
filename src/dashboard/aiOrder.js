import { randomBytes } from 'node:crypto';
import { InboxError } from '../inbox.js';
import { priceOrder, cleanCustomer } from './orderBuild.js';
import { riskFor } from './risk.js';
import { adjustStock } from './orderOps.js';
import { orderSummary } from '../platforms/rich.js';

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

// ORD-01: the AI turns a chat into an order. It is saved as pending (or on hold when the customer is
// high risk) and the customer gets the summary card with "Yes, confirm" (ORD-02). Throws InboxError with
// a short reason when something is missing, so the AI can hand the chat to the team instead.
export async function placeAiOrder(db, { conversation, input, notify = null, publicUrl = '' }) {
  const ws = await db.workspaces.findById(conversation.workspace_id).lean();
  const who = cleanCustomer({ name: input.name, phone: input.phone, address: input.address });
  const zone = ZONES.includes(input.zone) ? input.zone : 'inside_dhaka';
  const products = new Map((await db.products.find({ _id: { $in: (input.items ?? []).map((i) => Number(i.product_id)) }, workspace_id: ws._id }).lean()).map((p) => [p._id, p]));
  const items = (input.items ?? []).slice(0, 10).map((i) => {
    const p = products.get(Number(i.product_id));
    if (!p || p.archived || p.visibility === 'hidden') throw new InboxError(400, 'The AI picked a product that is not in the catalog');
    const v = matchVariant(p, i.variant);
    if (!v) throw new InboxError(400, `The size or colour "${i.variant}" for ${p.name} didn't match the catalog`);
    return { productId: p._id, sku: v.sku, qty: Math.max(1, Math.min(99, Number(i.qty) || 1)) };
  });
  const priced = await priceOrder(db, ws, { items, zone });

  // The chat's customer record (or the one with this phone), updated with the new details.
  let customer = conversation.customer_id ? await db.customers.findById(conversation.customer_id).lean() : null;
  customer ??= await db.customers.findOne({ workspace_id: ws._id, phones: who.phone }).lean();
  if (!customer) customer = { _id: (await db.insert(db.customers, { workspace_id: ws._id, name: who.name, phones: [who.phone] })).id };
  await db.customers.updateOne({ _id: customer._id }, { $addToSet: { phones: who.phone }, $set: { address: who.address, ...(customer.name ? {} : { name: who.name }) } });
  if (!conversation.customer_id) await db.conversations.updateOne({ _id: conversation._id }, { $set: { customer_id: customer._id } });
  customer = await db.customers.findById(customer._id).lean();

  const risk = riskFor({ delivered: customer.stats?.delivered, returned: customer.stats?.returned, cancelled: customer.stats?.cancelled, codAmount: priced.cod, outsideDhaka: zone === 'outside_dhaka' });
  const status = risk.level === 'high' ? 'on_hold' : 'pending';
  const { order_seq: number } = await db.workspaces.findOneAndUpdate({ _id: ws._id }, { $inc: { order_seq: 1 } }, { new: true, lean: true });
  const billToken = randomBytes(9).toString('base64url');
  const created = await db.insert(db.orders, {
    workspace_id: ws._id, number, customer_id: customer._id, conversation_id: conversation._id,
    customer_name: who.name, phone: who.phone, address: who.address, area: zone, zone,
    items: priced.lines.map((l) => ({ name: `${l.name}${l.variant ? ` (${l.variant})` : ''}`, qty: l.qty, price: l.price })), product_items: priced.lines,
    subtotal: priced.subtotal, delivery_charge: priced.delivery, discount: priced.discount, advance_paid: 0, cod_amount: priced.cod, payment_method: 'cod',
    note: String(input.note ?? '').slice(0, 300), status, hold_reason: status === 'on_hold' ? `High return risk (${risk.score}%)` : '', risk,
    source: 'ai', taken_by: 'ai', bill_token: billToken,
  });
  await adjustStock(db, { product_items: priced.lines }, -1, { notify });
  await db.customers.updateOne({ _id: customer._id }, { $inc: { 'stats.orders': 1 } });
  await db.insert(db.orderEvents, { workspace_id: ws._id, order_id: created.id, type: 'status', to: status, by: 'ai', text: `The AI took the order in chat${status === 'on_hold' ? ' (on hold: high return risk)' : ''}` });
  const total = priced.subtotal + priced.delivery - priced.discount;
  await notify?.({ workspaceId: ws._id, event: 'order', title: `New order #${number}`, body: `${who.name} · ৳${total.toLocaleString('en-IN')} · taken by AI, waiting for the customer to confirm`, link: `/orders/${number}`, ref: `order:${created.id}`, amount: total });
  if (status === 'on_hold') {
    await notify?.({ workspaceId: ws._id, event: 'escalation', title: `Order #${number} needs a look.`, body: `High return risk (${risk.score}%). ${risk.action}.`, link: `/orders/${number}`, ref: `risk:${created.id}` });
  }
  const order = await db.orders.findById(created.id).lean();
  return { order, rich: orderSummary(order, { billUrl: publicUrl ? `${publicUrl}/b/${billToken}` : '' }) };
}

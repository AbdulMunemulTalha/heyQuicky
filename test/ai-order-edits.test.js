import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInbox } from '../src/inbox.js';
import { createAgent } from '../src/ai/agent.js';
import { REPLY_SCHEMA } from '../src/ai/prompt.js';
import { changeStatus } from '../src/dashboard/orderOps.js';
import { setup, inbound } from './helpers.js';

const NONE = { action: 'none', items: [], name: '', phone: '', address: '', zone: 'inside_dhaka', note: '', coupon: '' };
const BASE = { reply: 'জি আপু', handoff: false, handoff_reason: '', intent: 'order', products: [], quick_replies: [], size_chart_product: 0,
  order: { ready: false, items: [], name: '', phone: '', address: '', zone: 'inside_dhaka', note: '', coupon: '' }, order_change: NONE,
  payment: { trx_id: '', method: 'bkash', amount: 0 }, customer_tags: [], act_now: false, act_now_reason: '' };
const WHO = { name: 'Sadia Rahman', phone: '01712345678', address: 'House 7, Road 3, Dhanmondi, Dhaka', zone: 'inside_dhaka', note: '', coupon: '' };

// The fake model answers each customer message with the next scripted answer.
async function shop() {
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { ai_mode: 'auto', delivery_inside_dhaka: 70, delivery_outside_dhaka: 130, order_seq: 1000 } });
  const kurti = (await ctx.db.insert(ctx.db.products, { workspace_id: ctx.ws, name: 'Jamdani Kurti', price: 1450, options: [{ name: 'Size', values: ['M', 'L', 'XL'] }],
    variant_list: [{ sku: 'K-M', options: { Size: 'M' }, price: 1450, stock: 3 }, { sku: 'K-L', options: { Size: 'L' }, price: 1450, stock: 0 }, { sku: 'K-XL', options: { Size: 'XL' }, price: 1550, stock: 2 }] })).id;
  const script = [];
  const calls = [];
  const provider = { name: 'fake', model: 'fake-1', async generateJson(req) { calls.push(req); return { data: { ...BASE, ...script.shift() }, usage: {} }; } };
  const notes = [];
  const inbox = createInbox(ctx.db, ctx.config);
  const agent = createAgent(ctx.db, inbox, provider, { replyDelayMs: 0, log: { warn() {} }, config: ctx.config, notify: async (n) => { notes.push(n); return []; } });
  const say = async (text, answer) => {
    script.push(answer);
    const { conversation, message } = await inbox.ingestMessage(inbound({ contactExternalId: 'sadia', text }));
    return { result: await agent.respond(conversation.id, message.id), id: conversation.id };
  };
  const stock = async () => Object.fromEntries((await ctx.db.products.findById(kurti).lean()).variant_list.map((v) => [v.sku, v.stock]));
  const out = (id) => ctx.db.messages.find({ conversation_id: id, direction: 'out' }).sort({ _id: 1 }).lean();
  return { ...ctx, kurti, calls, notes, say, stock, out };
}

const placeOrder = (s) => s.say('M size ta nibo', { reply: 'অর্ডার সামারি দেখে কনফার্ম করুন', order: { ready: true, items: [{ product_id: s.kurti, variant: 'M', qty: 1 }], ...WHO } });

test('the answer has order_change, and the prompt explains editing before confirm', async () => {
  assert.ok(REPLY_SCHEMA.required.includes('order_change'));
  assert.deepEqual(REPLY_SCHEMA.properties.order_change.properties.action.enum, ['none', 'edit', 'cancel']);
});

test('before confirming, the customer changes size, quantity and address in chat; the AI updates the same order and sends a new bill', async () => {
  const s = await shop();
  await placeOrder(s);
  let order = await s.db.orders.findOne({ workspace_id: s.ws }).lean();
  assert.deepEqual([order.status, order.number, (await s.stock())['K-M']], ['pending', 1001, 2]);

  // Size and quantity.
  const { id } = await s.say('XL dao, 2 ta', { reply: 'XL সাইজ ২টা করে দিলাম, নতুন সামারি দেখুন', order_change: { action: 'edit', items: [{ product_id: s.kurti, variant: 'XL', qty: 2 }], ...WHO } });
  assert.match(s.calls[1].context, /Order waiting for this customer's confirmation \(#1001\)/);
  assert.match(s.calls[1].context, new RegExp(`Jamdani Kurti \\(product id #${s.kurti}\\), variant "M", qty 1`));
  order = await s.db.orders.findById(order._id).lean();
  assert.deepEqual(order.product_items.map((l) => [l.sku, l.qty, l.price]), [['K-XL', 2, 1550]]);
  assert.deepEqual([order.subtotal, order.cod_amount, order.status], [3100, 3170, 'pending']);
  assert.deepEqual(await s.stock(), { 'K-M': 3, 'K-L': 0, 'K-XL': 0 }, 'M given back, XL taken');
  const event = await s.db.orderEvents.findOne({ order_id: order._id, type: 'edit' }).lean();
  assert.match(event.text, /Customer changed the items in chat before confirming \(৳1,520 → ৳3,170\)/);
  assert.ok(s.notes.some((n) => /changed order #1001/.test(n.title)));
  const msgs = await s.out(id);
  assert.deepEqual(msgs.slice(-2).map((m) => m.kind), ['text', 'order_summary'], 'reply, then the new bill');
  assert.match(JSON.stringify(msgs.at(-1).payload), /3,?170/, 'the new bill shows the new total');

  // The model "places" the order again with a new address: read as a change, never a second order.
  await s.say('address ta Mirpur 10, Dhaka koren', { reply: 'ঠিকানা বদলে দিলাম', order: { ready: true, items: [{ product_id: s.kurti, variant: 'XL', qty: 2 }], ...WHO, address: 'House 12, Road 5, Mirpur 10, Dhaka' } });
  assert.equal(await s.db.orders.countDocuments({ workspace_id: s.ws }), 1);
  order = await s.db.orders.findById(order._id).lean();
  assert.equal(order.address, 'House 12, Road 5, Mirpur 10, Dhaka');
  assert.equal((await s.db.customers.findById(order.customer_id).lean()).address, 'House 12, Road 5, Mirpur 10, Dhaka');

  // Nothing actually changed: no new bill.
  const before = (await s.out(id)).length;
  await s.say('thik ache', { reply: 'জি, সব ঠিক আছে', order_change: { action: 'edit', items: [{ product_id: s.kurti, variant: 'XL', qty: 2 }], ...WHO, address: 'House 12, Road 5, Mirpur 10, Dhaka' } });
  assert.deepEqual((await s.out(id)).slice(before).map((m) => m.kind), ['text']);

  // A sold-out size can't be put in: the team takes over and the order stays as it was.
  const r = await s.say('L size e dao', { reply: 'L করে দিলাম', order_change: { action: 'edit', items: [{ product_id: s.kurti, variant: 'L', qty: 1 }], ...WHO } });
  assert.equal(r.result, 'order_failed');
  assert.equal((await s.db.orders.findById(order._id).lean()).product_items[0].sku, 'K-XL');
  assert.match((await s.db.conversations.findById(id).lean()).ai_handoff_reason, /couldn't change order #1001/);
});

test('moving the order outside Dhaka re-checks the advance rule; cancelling before confirming gives the stock back and leaves no mark on the customer', async () => {
  const s = await shop();
  await s.db.workspaces.updateOne({ _id: s.ws }, { $set: { bkash_number: '01711000000', 'settings.advance': { rules: { outside_dhaka: { on: true, kind: 'fixed', value: 200 } } } } });
  await placeOrder(s);
  let order = await s.db.orders.findOne({ workspace_id: s.ws }).lean();
  assert.equal(order.status, 'pending', 'inside Dhaka: no advance needed');
  await s.say('ami chittagong e thaki', { reply: 'ঢাকার বাইরে করে দিলাম', order_change: { action: 'edit', items: [{ product_id: s.kurti, variant: 'M', qty: 1 }], ...WHO, address: 'Agrabad, Chattogram', zone: 'outside_dhaka' } });
  order = await s.db.orders.findById(order._id).lean();
  assert.deepEqual([order.zone, order.delivery_charge], ['outside_dhaka', 130]);
  assert.deepEqual([order.status, order.advance?.amount, order.advance?.reason], ['on_hold', 200, 'outside_dhaka'], 'the shop\'s advance rule now applies');
  assert.match((await s.db.orderEvents.findOne({ order_id: order._id, type: 'edit' }).lean()).text, /address, delivery area .*now on hold/);

  const { id } = await s.say('order ta cancel korben', { reply: 'অর্ডারটি বাতিল করা হয়েছে', order_change: { ...NONE, action: 'cancel' } });
  order = await s.db.orders.findById(order._id).lean();
  assert.deepEqual([order.status, order.cancel_reason], ['cancelled', 'customer_cancelled']);
  assert.equal((await s.stock())['K-M'], 3, 'stock back');
  const customer = await s.db.customers.findById(order.customer_id).lean();
  assert.deepEqual([customer.stats?.orders ?? 0, customer.stats?.cancelled ?? 0], [0, 0]);
  assert.ok(s.notes.some((n) => /cancelled order #1001/.test(n.title)));
  assert.equal((await s.out(id)).at(-1).kind, 'text', 'no bill for a cancelled order');
});

test('once the order is confirmed, changes go to the team instead', async () => {
  const s = await shop();
  await placeOrder(s);
  const order = await s.db.orders.findOne({ workspace_id: s.ws }).lean();
  await changeStatus(s.db, null, order, 'approved', { by: 'customer' });
  const { id } = await s.say('size ta XL kore den', { reply: 'আমাদের টিম এখনই দেখছে', order_change: { action: 'edit', items: [{ product_id: s.kurti, variant: 'XL', qty: 1 }], ...WHO } });
  assert.doesNotMatch(s.calls[1].context ?? '', /Order waiting for this customer's confirmation/);
  assert.equal((await s.db.orders.findById(order._id).lean()).product_items[0].sku, 'K-M', 'not changed');
  const conv = await s.db.conversations.findById(id).lean();
  assert.equal(conv.ai_handoff, true);
  assert.match(conv.ai_handoff_reason, /already confirmed/);
});

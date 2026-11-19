import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInbox } from '../src/inbox.js';
import { createAgent } from '../src/ai/agent.js';
import { matchVariant } from '../src/dashboard/aiOrder.js';
import { buildSystemPrompt, REPLY_SCHEMA } from '../src/ai/prompt.js';
import { setup, inbound } from './helpers.js';

const BASE = { reply: 'জি আপু', handoff: false, handoff_reason: '', intent: 'product_info', products: [], quick_replies: [], size_chart_product: 0,
  order: { ready: false, items: [], name: '', phone: '', address: '', zone: 'inside_dhaka', note: '' }, act_now: false, act_now_reason: '' };

async function shop(answer) {
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { ai_mode: 'auto', delivery_inside_dhaka: 70, order_seq: 1000 } });
  const kurti = await ctx.db.insert(ctx.db.products, { workspace_id: ctx.ws, name: 'Jamdani Kurti', price: 1450, in_stock: true, options: [{ name: 'Size', values: ['M', 'L'] }],
    variant_list: [{ sku: 'K-M', options: { Size: 'M' }, price: 1450, stock: 3 }, { sku: 'K-L', options: { Size: 'L' }, price: 1450, stock: 0 }] });
  const hidden = await ctx.db.insert(ctx.db.products, { workspace_id: ctx.ws, name: 'Draft', price: 1, visibility: 'hidden' });
  const calls = [];
  const provider = { name: 'fake', model: 'fake-1', async generateJson(req) { calls.push(req); return { data: { ...BASE, ...(await answer({ kurti, hidden })) }, usage: {} }; } };
  const notes = [];
  const inbox = createInbox(ctx.db, ctx.config);
  const agent = createAgent(ctx.db, inbox, provider, { replyDelayMs: 0, log: { warn() {} }, config: ctx.config, notify: async (n) => { notes.push(n); return []; } });
  const say = async (text, who = 'buyer') => {
    const { conversation, message } = await inbox.ingestMessage(inbound({ contactExternalId: who, text }));
    return { result: await agent.respond(conversation.id, message.id), id: conversation.id };
  };
  const out = (id) => ctx.db.messages.find({ conversation_id: id, direction: 'out' }).sort({ _id: 1 }).lean();
  return { ...ctx, kurti, hidden, calls, notes, say, out };
}

test('the schema asks for actions and the prompt lists product ids and coupons', async () => {
  for (const k of ['products', 'quick_replies', 'size_chart_product', 'order', 'act_now']) assert.ok(REPLY_SCHEMA.required.includes(k));
  const prompt = buildSystemPrompt({ workspace: { name: 'Shop', delivery_inside_dhaka: 70, delivery_outside_dhaka: 130 }, savedReplies: [],
    products: [{ _id: 7, name: 'Kurti', price: 1450, in_stock: true, size_chart_id: 2, upsell_ids: [8] }, { _id: 8, name: 'Orna', price: 450, in_stock: true }],
    coupons: [{ code: 'EID10', type: 'percent', value: 10, min_order: 1500 }] });
  assert.match(prompt, /- Kurti: ৳1,450; in stock; has size chart; suggest with: Orna \(id #8\); id #7/);
  assert.match(prompt, /EID10: 10% off on orders over ৳1500/);
  assert.match(prompt, /Never offer a discount or free item yourself/);
  assert.match(prompt, /set order\.ready = true/);
});

test('matching the customer\'s size words to a variant', () => {
  const p = { variant_list: [{ sku: 'S', options: { Size: 'S' } }, { sku: 'M', options: { Size: 'M' } }, { sku: 'TM', options: { Colour: 'Teal', Size: 'M' } }] };
  assert.deepEqual(matchVariant({ variant_list: [p.variant_list[0], p.variant_list[1]] }, 'm'), { sku: 'M' });
  assert.equal(matchVariant({ variant_list: [p.variant_list[0], p.variant_list[1]] }, 'small please'), null, '"S" does not match inside "small"');
  assert.deepEqual(matchVariant({ variant_list: [{ sku: 'TM', options: { Colour: 'Teal', Size: 'M' } }, { sku: 'TL', options: { Colour: 'Teal', Size: 'L' } }] }, 'Teal / M'), { sku: 'TM' });
  assert.deepEqual(matchVariant({ variant_list: [{ sku: 'F', options: { Size: 'Free size' } }] }, 'free size'), { sku: 'F' });
  assert.deepEqual(matchVariant({ variant_list: [] }, ''), { sku: undefined }, 'no options, nothing to match');
});

test('the AI sends product cards and size chips; hidden products never go out', async () => {
  const s = await shop(({ kurti, hidden }) => ({ reply: 'এই কুর্তিটা আছে, কোন সাইজ লাগবে?', products: [kurti.id, hidden.id], quick_replies: ['M'] }));
  const { result, id } = await s.say('kurti ache?');
  assert.equal(result, 'sent');
  const msgs = await s.out(id);
  assert.deepEqual(msgs.map((m) => m.kind), ['quick_replies', 'carousel']);
  assert.deepEqual(msgs[0].payload.options.map((o) => o.title), ['M']);
  assert.deepEqual(msgs[1].payload.cards.map((c) => c.title), ['Jamdani Kurti']);
  assert.deepEqual(msgs[1].payload.cards[0].sizes, ['M'], 'sold-out L is not offered');
});

test('the AI takes the order: pending, stock held, summary card with Yes, confirm', async () => {
  const s = await shop(({ kurti }) => ({ reply: 'অর্ডারের সারাংশ পাঠালাম, দেখে "হ্যাঁ, কনফার্ম" চাপুন।', intent: 'order',
    order: { ready: true, items: [{ product_id: kurti.id, variant: 'M', qty: 1 }], name: 'Sadia Rahman', phone: '০১৭১২-৩৪৫৬৭৮', address: 'House 7, Road 3, Dhanmondi, Dhaka', zone: 'inside_dhaka', note: '' } }));
  const { result, id } = await s.say('Sadia Rahman, 01712345678, House 7 Road 3 Dhanmondi');
  assert.equal(result, 'order_placed');
  const order = await s.db.orders.findOne({ conversation_id: id }).lean();
  assert.deepEqual([order.status, order.source, order.number, order.phone, order.subtotal + order.delivery_charge], ['pending', 'ai', 1001, '01712345678', 1520]);
  assert.equal((await s.db.products.findById(s.kurti.id).lean()).variant_list[0].stock, 2, 'one M held for this order');
  const msgs = await s.out(id);
  assert.deepEqual(msgs.map((m) => m.kind ?? 'text'), ['text', 'order_summary']);
  assert.equal(msgs[1].payload.buttons[0].title, 'হ্যাঁ, কনফার্ম');
  assert.ok(s.notes.some((n) => n.event === 'order' && /taken by AI/.test(n.body)));
  const conv = await s.db.conversations.findById(id).lean();
  assert.ok(conv.customer_id, 'the chat is linked to the customer');
});

test('an order the catalog can\'t fill goes to the team instead, with nothing misleading sent', async () => {
  const s = await shop(({ kurti }) => ({ reply: 'অর্ডার কনফার্ম করতে চাপুন', order: { ready: true, items: [{ product_id: kurti.id, variant: 'XXL', qty: 1 }], name: 'Rafi', phone: '01712345678', address: 'House 1, Road 2, Mirpur', zone: 'inside_dhaka', note: '' } }));
  const { result, id } = await s.say('XXL dao');
  assert.equal(result, 'order_failed');
  assert.equal(await s.db.orders.countDocuments({ conversation_id: id }), 0);
  assert.equal((await s.out(id)).length, 0);
  const conv = await s.db.conversations.findById(id).lean();
  assert.equal(conv.ai_handoff, true);
  assert.match(conv.ai_handoff_reason, /couldn't place the order: The size or colour "XXL"/);
  assert.ok(conv.ai_draft, 'the reply is kept as a draft for the team');
});

test('urgent chats are flagged ACT NOW and handed to the team; the AI sees the customer\'s history', async () => {
  let n = 0;
  const s = await shop(() => (++n === 1 ? {} : { reply: 'দুঃখিত আপু, আমাদের টিম এখনই দেখছে।', intent: 'complaint', act_now: true, act_now_reason: 'Customer says the parcel was damaged and wants a refund' }));
  const first = await s.say('hello', 'repeat');
  const conv0 = await s.db.conversations.findById(first.id).lean();
  await s.db.customers.updateOne({ _id: conv0.customer_id }, { $set: { name: 'Mitu', vip: true, stats: { orders: 2, delivered: 2, returned: 0, cancelled: 0 } } });
  await s.db.insert(s.db.orders, { workspace_id: s.ws, number: 990, customer_id: conv0.customer_id, customer_name: 'Mitu', phone: '01712345678', address: 'x', area: 'inside_dhaka', cod_amount: 1, subtotal: 1, delivery_charge: 0, discount: 0, status: 'delivered', items: [{ name: 'Silk Saree' }] });
  const { result, id } = await s.say('parcel ta chera ashche!! refund chai', 'repeat');
  assert.equal(result, 'handed_off');
  const conv = await s.db.conversations.findById(id).lean();
  assert.equal(conv.act_now, true);
  assert.match(conv.ai_handoff_reason, /damaged/);
  const ctx = s.calls.at(-1).context;
  assert.match(ctx, /Name: Mitu \(VIP/);
  assert.match(ctx, /Order #990, .* Silk Saree — delivered/);
});

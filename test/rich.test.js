import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, inbound } from './helpers.js';
import { createApp } from '../src/app.js';
import { createInbox } from '../src/inbox.js';
import { createAdapters } from '../src/adapters/index.js';
import { parseWebhook } from '../src/platforms/meta.js';
import { productCards, orderSummary, reviewRequest, toPlatform, parsePostback, postback } from '../src/platforms/rich.js';

const product = (over = {}) => ({ _id: 1, name: 'Nokshi Three-Piece', price: 2150, compare_at: 2450, code: 'NT-104', photos: ['/files/abc'], in_stock: true,
  variant_list: [{ options: { Size: 'M' }, stock: 2 }, { options: { Size: 'XL' }, stock: 0 }], size_chart_id: 3, ...over });

test('product cards only show what may be sold, with live price and sizes left', () => {
  const r = productCards([product(), product({ _id: 2, visibility: 'hidden' }), product({ _id: 3, name: 'Silk Panjabi', variant_list: [{ options: { Size: 'L' }, stock: 0 }] })], { publicUrl: 'https://shop.test' });
  assert.equal(r.kind, 'carousel');
  assert.deepEqual(r.payload.cards.map((c) => c.productId), [1, 3], 'hidden products are never sent');
  const [first, sold] = r.payload.cards;
  assert.deepEqual(first.sizes, ['M']);
  assert.equal(first.image, 'https://shop.test/files/abc');
  assert.deepEqual(first.buttons.map((b) => parsePostback(b.value).action), ['ORDER', 'SIZE']);
  assert.equal(sold.inStock, false);
  assert.deepEqual(sold.buttons.map((b) => parsePostback(b.value).action), ['NOTIFY']);
  assert.match(r.text, /Nokshi Three-Piece — ৳2,150 \(আগে ৳2,450\) · M/);
  assert.equal(productCards(Array.from({ length: 14 }, (_, i) => product({ _id: i + 1 }))).payload.cards.length, 10, 'Messenger allows 10 cards');

  const fb = toPlatform('messenger', r);
  assert.equal(fb.attachment.payload.template_type, 'generic');
  assert.equal(fb.attachment.payload.elements[0].buttons[0].type, 'postback');
  assert.equal(fb.attachment.payload.elements[0].buttons[0].payload, postback('ORDER', 1));
  assert.equal(toPlatform('whatsapp', r), null, 'WhatsApp gets the text list instead');
});

test('the order summary has Yes, confirm while pending and the bill link after', () => {
  const order = { _id: 9, number: 1054, status: 'pending', customer_name: 'Sadia', phone: '01712345678', address: 'House 7', subtotal: 2150, delivery_charge: 70, discount: 0,
    product_items: [{ name: 'নকশি থ্রি-পিস', variant: 'M', qty: 1, price: 2150 }] };
  const pending = orderSummary(order, { billUrl: 'https://heyquicky.com/b/tok' });
  assert.equal(pending.payload.total, 2220);
  assert.equal(pending.payload.cod, 2220);
  assert.deepEqual(pending.payload.buttons.map((b) => b.title), ['হ্যাঁ, কনফার্ম', 'পরিবর্তন করুন']);
  const wa = toPlatform('whatsapp', pending);
  assert.equal(wa.type, 'interactive');
  assert.equal(wa.interactive.action.buttons[0].reply.id, postback('CONFIRM', 9));
  const done = orderSummary({ ...order, status: 'approved' }, { billUrl: 'https://heyquicky.com/b/tok' });
  assert.deepEqual(done.payload.buttons.map((b) => b.type), ['url']);
  assert.match(done.text, /কনফার্ম হয়েছে[\s\S]*বিল ও ট্র্যাকিং: https:\/\/heyquicky\.com\/b\/tok/);
  const review = toPlatform('messenger', reviewRequest(order));
  assert.equal(review.quick_replies.length, 4);
  assert.equal(parsePostback(review.quick_replies[0].payload).action, 'RATE');
});

test('button taps and quick replies come in from Meta with their payload', () => {
  const body = { object: 'page', entry: [{ id: 'PAGE1', messaging: [
    { sender: { id: 'cust-1' }, recipient: { id: 'PAGE1' }, timestamp: 1763500000000, postback: { title: 'হ্যাঁ, কনফার্ম', payload: 'HQ:CONFIRM:9', mid: 'pb1' } },
    { sender: { id: 'cust-1' }, recipient: { id: 'PAGE1' }, timestamp: 1763500001000, message: { mid: 'm2', text: 'M', quick_reply: { payload: 'size-M' } } },
  ] }] };
  const list = parseWebhook(body).messages;
  assert.equal(list[0].postback, 'HQ:CONFIRM:9');
  assert.equal(list[0].text, 'হ্যাঁ, কনফার্ম');
  assert.equal(list[1].postback, 'size-M');
});

test('rich messages go to Messenger as templates and are stored with their card', async () => {
  const { db, config, user } = await setup();
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ message_id: 'mid.rich' }) }; };
  const inbox = createInbox(db, config, { fetchImpl });
  const c = (await inbox.ingestMessage(inbound())).conversation;
  const msg = await inbox.sendRich(await user(c.assigned_user_id), c.id, productCards([product()]));
  assert.equal(calls[0].body.message.attachment.payload.template_type, 'generic');
  assert.equal(msg.external_id, 'mid.rich');
  const stored = await db.messages.findById(msg.id).lean();
  assert.equal(stored.kind, 'carousel');
  assert.equal(stored.payload.cards[0].title, 'Nokshi Three-Piece');
  assert.match(stored.text, /৳2,150/);
});

test('tapping Yes, confirm approves the order; a low rating calls the team; the AI stays out of it', async () => {
  const s = await setup({ env: { DRY_RUN: '1' } });
  const app = createApp(s.db, s.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  try {
    const c = (await app.inbox.ingestMessage(inbound({ contactExternalId: 'buyer' }))).conversation;
    const order = await s.db.insert(s.db.orders, { workspace_id: s.ws, number: 1054, conversation_id: c.id, customer_name: 'Sadia', phone: '01712345678', address: 'x', area: 'inside_dhaka',
      subtotal: 2150, delivery_charge: 70, discount: 0, cod_amount: 2220, status: 'pending', product_items: [] });
    await app.inbox.ingestMessage(inbound({ contactExternalId: 'buyer', text: 'হ্যাঁ, কনফার্ম', postback: `HQ:CONFIRM:${order.id}` }));
    const until = async (fn) => { for (let i = 0; i < 60; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } return null; };
    assert.ok(await until(async () => (await s.db.orders.findById(order.id).lean()).status === 'approved'), 'order approved');
    assert.ok(await s.db.orderEvents.exists({ order_id: order.id, by: 'customer', to: 'approved' }));
    assert.ok(await until(() => s.db.messages.findOne({ conversation_id: c.id, direction: 'out', text: /কনফার্ম হয়েছে/ }).lean()), 'thanks the customer');
    const tap = await s.db.messages.findOne({ conversation_id: c.id, kind: 'postback' }).lean();
    assert.equal(tap.payload.postback, `HQ:CONFIRM:${order.id}`);

    await s.db.orders.updateOne({ _id: order.id }, { $set: { status: 'delivered' } });
    await app.inbox.ingestMessage(inbound({ contactExternalId: 'buyer', text: '😞 ভালো না', postback: `HQ:RATE:${order.id}-1` }));
    assert.ok(await until(async () => (await s.db.orders.findById(order.id).lean()).review?.rating === 1));
    assert.ok(await until(() => s.db.notifications.exists({ type: 'handoff', title: /wasn't happy/ })));

    // Someone else's order can't be confirmed from this chat.
    const other = await s.db.insert(s.db.orders, { workspace_id: s.ws, number: 1060, customer_name: 'X', phone: '01700000000', address: 'x', area: 'inside_dhaka', subtotal: 1, delivery_charge: 0, discount: 0, cod_amount: 1, status: 'pending' });
    await app.inbox.ingestMessage(inbound({ contactExternalId: 'buyer', text: 'confirm', postback: `HQ:CONFIRM:${other.id}` }));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await s.db.orders.findById(other.id).lean()).status, 'pending');
  } finally { await new Promise((r) => { app.io.close(); app.server.close(r); }); }
});

test('the team sends product cards from a chat and order cards from an order', async () => {
  const s = await setup({ env: { DRY_RUN: '1' } });
  const app = createApp(s.db, s.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const root = `http://127.0.0.1:${app.server.address().port}/api/dash`;
  try {
    const token = (await (await fetch(`${root}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'owner@shop.test', password: 'password123' }) })).json()).token;
    const call = async (path, body) => { const r = await fetch(`${root}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const c = (await app.inbox.ingestMessage(inbound({ contactExternalId: 'buyer2' }))).conversation;
    const p = await s.db.insert(s.db.products, { workspace_id: s.ws, name: 'Jamdani Kurti', price: 1450 });
    const hidden = await s.db.insert(s.db.products, { workspace_id: s.ws, name: 'Draft', price: 1, visibility: 'hidden' });
    assert.equal((await call(`/inbox/${c.id}/products`, { productIds: [] })).status, 400);
    assert.equal((await call(`/inbox/${c.id}/products`, { productIds: [hidden.id] })).status, 400);
    const sent = await call(`/inbox/${c.id}/products`, { productIds: [p.id, hidden.id] });
    assert.equal(sent.status, 201);
    const card = await s.db.messages.findOne({ conversation_id: c.id, kind: 'carousel' }).lean();
    assert.deepEqual(card.payload.cards.map((x) => x.title), ['Jamdani Kurti']);

    const order = await s.db.insert(s.db.orders, { workspace_id: s.ws, number: 1070, conversation_id: c.id, customer_name: 'B', phone: '01712345678', address: 'x', area: 'inside_dhaka',
      subtotal: 1450, delivery_charge: 70, discount: 0, cod_amount: 1520, status: 'in_transit', courier: 'Steadfast', consignment_id: 'SF-1', bill_token: 'tokenABC123' });
    assert.equal((await call(`/orders/${order.id}/message`, { type: 'review' })).status, 409, 'only after delivery');
    assert.equal((await call(`/orders/${order.id}/message`, { type: 'update' })).status, 201);
    const update = await s.db.messages.findOne({ conversation_id: c.id, kind: 'delivery_card' }).lean();
    assert.match(update.payload.title, /রাস্তায়/);
    assert.ok(update.payload.buttons.some((b) => /steadfast\.com\.bd\/t\/SF-1/.test(b.value)));
    assert.ok(update.payload.buttons.some((b) => /\/b\/tokenABC123$/.test(b.value)));
  } finally { await new Promise((r) => { app.io.close(); app.server.close(r); }); }
});

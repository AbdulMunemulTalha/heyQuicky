import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';

async function start() {
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { bkash_number: '01711000000', name: 'Nokshi Threads' } });
  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const order = (over = {}) => ctx.db.insert(ctx.db.orders, { workspace_id: ctx.ws, number: 1052, customer_name: 'Tanvir Ahmed', phone: '01819224410', address: 'House 12, Road 8, Banani',
    area: 'inside_dhaka', zone: 'inside_dhaka', subtotal: 1450, delivery_charge: 70, discount: 0, cod_amount: 1520, status: 'approved', bill_token: 'billTok3n123',
    product_items: [{ name: 'Jamdani Kurti', variant: 'M', qty: 1, price: 1450 }], ...over });
  const post = (path, fields) => fetch(`${base}${path}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  return { ...ctx, base, order, post, close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

test('the bill shows the order in Bangla by default and in English on request', async () => {
  const s = await start();
  try {
    await s.order({ customer_name: '<script>alert(1)</script>' });
    const bn = await fetch(`${s.base}/b/billTok3n123`);
    assert.equal(bn.status, 200);
    assert.equal(bn.headers.get('x-robots-tag'), 'noindex');
    const html = await bn.text();
    assert.match(html, /আপনার অর্ডার কনফার্ম হয়েছে/);
    assert.match(html, /৳১,৫২০/, 'Bangla digits with Indian grouping');
    assert.match(html, /ক্যাশ অন ডেলিভারি/);
    assert.match(html, /bKash দিয়ে/);
    assert.ok(!html.includes('<script>alert(1)</script>'), 'customer text is escaped');
    const en = await (await fetch(`${s.base}/b/billTok3n123?lang=en`)).text();
    assert.match(en, /Your order is confirmed/);
    assert.match(en, /৳1,520/);
    assert.equal((await fetch(`${s.base}/b/nope-nope-nope`)).status, 404);
    assert.equal((await fetch(`${s.base}/b/x`)).status, 404, 'short or odd tokens are rejected');
  } finally { await s.close(); }
});

test('a shipped order shows the courier and tracking link', async () => {
  const s = await start();
  try {
    await s.order({ status: 'in_transit', courier: 'Steadfast', consignment_id: 'SF-29402' });
    const html = await (await fetch(`${s.base}/b/billTok3n123?lang=en`)).text();
    assert.match(html, /on the way/);
    assert.match(html, /SF-29402/);
    assert.match(html, /steadfast\.com\.bd\/t\/SF-29402/);
    assert.ok(!html.includes('action="/b/billTok3n123/change"'), 'no address change once it has shipped');
  } finally { await s.close(); }
});

test('the customer can ask for an address change, send an advance and ask to cancel', async () => {
  const s = await start();
  try {
    const o = await s.order();
    let r = await s.post('/b/billTok3n123/change', { address: 'Flat 3B, Road 2, Dhanmondi' });
    assert.equal(r.status, 303);
    let order = await s.db.orders.findById(o.id).lean();
    assert.equal(order.change_request.status, 'open');
    assert.equal(order.change_request.new, 'Flat 3B, Road 2, Dhanmondi');
    assert.equal(order.change_request.old, 'House 12, Road 8, Banani');
    assert.ok(await s.db.notifications.exists({ user_id: s.owner, type: 'escalation' }), 'the shop hears about it');
    assert.match((await s.post('/b/billTok3n123/change', { phone: '0121' })).headers.get('location'), /err-address|err-phone/);

    assert.match((await s.post('/b/billTok3n123/pay', { method: 'bkash', amount: '300', trx: 'x' })).headers.get('location'), /done=err-trx/);
    r = await s.post('/b/billTok3n123/pay', { method: 'bkash', amount: '৩০০', trx: 'bkh8x2k9qp', from: '01819-224410' });
    assert.match(r.headers.get('location'), /done=pay/);
    const pay = await s.db.payments.findOne({ order_id: o.id }).lean();
    assert.deepEqual([pay.method, pay.amount, pay.trx_id, pay.status, pay.from_number], ['bkash', 300, 'BKH8X2K9QP', 'waiting', '01819224410']);
    assert.match((await s.post('/b/billTok3n123/pay', { method: 'bkash', amount: '300', trx: 'BKH8X2K9QP' })).headers.get('location'), /done=err-dup/);
    assert.match(await (await fetch(`${s.base}/b/billTok3n123`)).text(), /যাচাই হচ্ছে/, 'the bill shows the payment is being checked');

    await s.post('/b/billTok3n123/cancel', {});
    await s.post('/b/billTok3n123/cancel', {});
    order = await s.db.orders.findById(o.id).lean();
    assert.ok(order.cancel_requested_at);
    assert.equal(order.status, 'approved', 'nothing is cancelled automatically');
    assert.equal(await s.db.orderEvents.countDocuments({ order_id: o.id, text: /asked to cancel/ }), 1, 'asked once');
  } finally { await s.close(); }
});

test('delivered orders take no more requests from the bill', async () => {
  const s = await start();
  try {
    const o = await s.order({ status: 'delivered' });
    await s.post('/b/billTok3n123/change', { address: 'Somewhere else' });
    await s.post('/b/billTok3n123/cancel', {});
    await s.post('/b/billTok3n123/pay', { method: 'bkash', amount: '300', trx: 'ABCDEFGH12' });
    const order = await s.db.orders.findById(o.id).lean();
    assert.equal(order.change_request ?? null, null);
    assert.equal(order.cancel_requested_at, null);
    assert.equal(await s.db.payments.countDocuments({ order_id: o.id }), 0);
  } finally { await s.close(); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { loadConfig } from '../src/config.js';
import { runMigrations } from '../src/dashboard/migrations.js';
import { seedNokshi } from '../src/dashboard/demoSeed.js';

async function start() {
  const db = await freshDb();
  await runMigrations(db);
  const { workspaceId } = await seedNokshi(db);
  const app = createApp(db, loadConfig({ DRY_RUN: '1' }), { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}/api/dash`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const token = (await call('/auth/login', { method: 'POST', body: { login: 'talha@nokshithreads.com', password: 'password123' } })).body.token;
  return { db, workspaceId, call, token, close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

const stockOf = async (db, sku) => {
  const p = await db.products.findOne({ 'variant_list.sku': sku }).lean();
  return p.variant_list.find((v) => v.sku === sku).stock;
};

test('order detail shows items, customer check, change request and history', async () => {
  const s = await start();
  try {
    const d = await s.call('/orders/1051', { token: s.token });
    assert.equal(d.status, 200);
    assert.equal(d.body.status, 'on_hold');
    assert.equal(d.body.items[0].sku, 'NT-131-L');
    assert.equal(d.body.total, 6030);
    assert.equal(d.body.changeRequest.field, 'address');
    assert.ok(d.body.check, 'courier check is attached');
    assert.ok(['low', 'medium', 'high'].includes(d.body.risk.level));
    assert.ok(d.body.events.length >= 1);
    assert.equal((await s.call('/orders/99999', { token: s.token })).status, 404);

    const accept = await s.call(`/orders/${d.body.id}/change`, { method: 'POST', token: s.token, body: { action: 'accept' } });
    assert.equal(accept.status, 200);
    const after = await s.call('/orders/1051', { token: s.token });
    assert.equal(after.body.address.full, 'Flat 3B, Lalkhan Bazar, Chattogram');
    assert.equal(after.body.changeRequest, null);
    assert.equal((await s.call(`/orders/${d.body.id}/change`, { method: 'POST', token: s.token, body: { action: 'keep' } })).status, 409);

    const note = await s.call(`/orders/${d.body.id}/notes`, { method: 'POST', token: s.token, body: { text: '@Rafi call her before shipping' } });
    assert.equal(note.status, 201);
    assert.ok(await s.db.notifications.exists({ type: 'mention', title: /Talha mentioned you/ }));
    const adv = await s.call(`/orders/${d.body.id}/advance-request`, { method: 'POST', token: s.token, body: { amount: 300 } });
    assert.match(adv.body.text, /৳300.*01712345678/);
    assert.equal((await s.db.orders.findById(d.body.id).lean()).advance.requested, 300);
  } finally {
    await s.close();
  }
});

test('new orders are priced from the catalog, validate the phone, reserve stock and apply coupons', async () => {
  const s = await start();
  try {
    const product = await s.db.products.findOne({ code: 'NT-104' }).lean();
    const sku = 'NT-104-L';
    const before = await stockOf(s.db, sku);
    const base = { phone: '01755-123456', name: 'Nusrat Jahan', address: 'House 9, Road 2, Mirpur 10', district: 'Dhaka', thana: 'Mirpur', zone: 'inside_dhaka', items: [{ productId: product._id, sku, qty: 2, price: 1 }], payment: { method: 'cod' } };

    const bad = await s.call('/orders', { method: 'POST', token: s.token, body: { ...base, phone: '0175512345' } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /11 digits/);
    const tooMany = await s.call('/orders', { method: 'POST', token: s.token, body: { ...base, items: [{ productId: product._id, sku, qty: 50 }] } });
    assert.equal(tooMany.status, 409, 'cannot order more than in stock');

    const quote = await s.call('/orders/quote', { method: 'POST', token: s.token, body: { items: base.items, zone: 'inside_dhaka', coupon: 'EID10' } });
    assert.deepEqual([quote.body.subtotal, quote.body.discount, quote.body.delivery, quote.body.total], [4300, 430, 70, 3940], 'the browser price is ignored');
    const badCoupon = await s.call('/orders/quote', { method: 'POST', token: s.token, body: { items: base.items, zone: 'inside_dhaka', coupon: 'NOPE' } });
    assert.equal(badCoupon.status, 400);
    const free = await s.call('/orders/quote', { method: 'POST', token: s.token, body: { items: base.items, zone: 'outside_dhaka', coupon: 'FREEDEL' } });
    assert.equal(free.body.delivery, 0);

    const created = await s.call('/orders', { method: 'POST', token: s.token, body: { ...base, phone: '০১৭৫৫-১২৩৪৫৬', coupon: 'EID10', payment: { method: 'bkash_advance', advance: 500, trxId: 'bkh1' }, bookNow: true, courier: 'steadfast' } });
    assert.equal(created.status, 201);
    assert.equal(created.body.number, 1053);
    assert.ok(created.body.booked?.consignment_id, 'booked right away');
    const order = await s.db.orders.findById(created.body.id).lean();
    assert.deepEqual([order.phone, order.subtotal, order.discount, order.cod_amount, order.advance.amount, order.status], ['01755123456', 4300, 430, 3440, 500, 'in_transit']);
    assert.equal(await stockOf(s.db, sku), before - 2, 'stock is reserved');
    assert.equal((await s.db.coupons.findOne({ code: 'EID10' }).lean()).used, 113);
    const customer = await s.db.customers.findById(order.customer_id).lean();
    assert.ok(customer.phones.includes('01755123456'));

    // A draft doesn't hold stock; editing it into a real order does.
    const draft = await s.call('/orders', { method: 'POST', token: s.token, body: { ...base, items: [{ productId: product._id, sku, qty: 1 }], draft: true } });
    assert.equal(await stockOf(s.db, sku), before - 2);
    const edited = await s.call(`/orders/${draft.body.id}`, { method: 'PATCH', token: s.token, body: { ...base, items: [{ productId: product._id, sku, qty: 1 }], zone: 'dhaka_suburbs' } });
    assert.equal(edited.status, 200);
    const e = await s.db.orders.findById(draft.body.id).lean();
    assert.deepEqual([e.draft, e.status, e.delivery_charge], [false, 'approved', 100]);
    assert.equal(await stockOf(s.db, sku), before - 3);
  } finally {
    await s.close();
  }
});

test('the phone lookup returns the last address and a risk level', async () => {
  const s = await start();
  try {
    const r = await s.call(`/orders/lookup?phone=${encodeURIComponent('01934556120')}`, { token: s.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.known, true);
    assert.equal(r.body.name, 'Shirin Akter');
    assert.equal(r.body.lastAddress.zone, 'outside_dhaka');
    assert.ok(r.body.risk.level);
    assert.equal((await s.call('/orders/lookup?phone=123', { token: s.token })).status, 400);
    const products = await s.call('/orders/products?q=NT-1', { token: s.token });
    assert.ok(products.body.length >= 5);
    assert.ok(products.body[0].variants.length);
  } finally {
    await s.close();
  }
});

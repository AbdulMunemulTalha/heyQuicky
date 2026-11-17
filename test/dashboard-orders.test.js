import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { loadConfig } from '../src/config.js';
import { runMigrations } from '../src/dashboard/migrations.js';
import { seedNokshi } from '../src/dashboard/demoSeed.js';
import { riskFor } from '../src/dashboard/risk.js';
import { courierClient, toPipeline } from '../src/adapters/couriers.js';
import { hashPassword } from '../src/auth.js';

async function start() {
  const db = await freshDb();
  await runMigrations(db);
  const { workspaceId } = await seedNokshi(db);
  const config = loadConfig({ DRY_RUN: '1' });
  const app = createApp(db, config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}/api/dash`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* CSV / HTML */ }
    return { status: res.status, body: json, text };
  };
  const login = async (email) => (await call('/auth/login', { method: 'POST', body: { login: email, password: 'password123' } })).body.token;
  return { db, workspaceId, call, login, close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

test('COD risk rises with returns and a weak courier record', () => {
  assert.equal(riskFor({ delivered: 5, returned: 0 }).level, 'low');
  assert.equal(riskFor({ delivered: 2, returned: 3 }).level, 'high');
  assert.equal(riskFor({ courierRate: 0.62, courierTotal: 10 }).level, 'medium');
  assert.match(riskFor({ delivered: 1, returned: 4 }).action, /advance/);
});

test('couriers without keys run in test mode; courier statuses map onto the pipeline', async () => {
  const c = courierClient('steadfast', null);
  assert.equal(c.mode, 'fake');
  assert.match((await c.book({ number: 1 })).consignmentId, /^SF-\d{5}$/);
  assert.equal(courierClient('steadfast', { api_key: 'a', secret_key: 'b' }).mode, 'real');
  assert.equal(toPipeline('delivered'), 'delivered');
  assert.equal(toPipeline('cancelled'), 'returned');
});

test('orders list with filters, counts and KPIs', async () => {
  const s = await start();
  try {
    const token = await s.login('talha@nokshithreads.com');
    const all = await s.call('/orders?range=all', { token });
    assert.equal(all.status, 200);
    assert.equal(all.body.counts.all, 9);
    assert.equal(all.body.counts.ready_to_ship, 2);
    assert.equal(all.body.kpis.toConfirm, 2);
    const ai = await s.call('/orders?range=all&source=ai', { token });
    assert.ok(ai.body.items.every((o) => o.source === 'ai'));
    const byPhone = await s.call(`/orders?range=all&q=${encodeURIComponent('০১৯৩৪')}`, { token });
    assert.deepEqual(byPhone.body.items.map((o) => o.number), [1051], 'search works with Bangla digits');
    const byNumber = await s.call('/orders?range=all&q=%231050', { token });
    assert.deepEqual(byNumber.body.items.map((o) => o.number), [1050]);
    const changed = all.body.items.find((o) => o.number === 1051);
    assert.equal(changed.detailsChanged, true);
    const csv = await s.call('/orders.csv?range=all', { token });
    assert.match(csv.text, /order,date,status/);
    assert.equal(csv.text.trim().split('\n').length, 10);
    const labels = await s.call('/orders/labels', { method: 'POST', token, body: { ids: [] } });
    assert.match(labels.text, /class="label"/);
  } finally {
    await s.close();
  }
});

test('status moves follow the pipeline, write history, and cancelling needs a reason and restocks', async () => {
  const s = await start();
  try {
    const token = await s.login('talha@nokshithreads.com');
    const order = await s.db.orders.findOne({ number: 1052 }).lean();
    const bad = await s.call(`/orders/${order._id}/status`, { method: 'POST', token, body: { status: 'delivered' } });
    assert.equal(bad.status, 409, 'pending cannot jump to delivered');
    const ok = await s.call(`/orders/${order._id}/status`, { method: 'POST', token, body: { status: 'approved' } });
    assert.equal(ok.body.status, 'approved');
    assert.ok(ok.body.next.includes('ready_to_ship'));
    assert.ok(await s.db.orderEvents.exists({ order_id: order._id, to: 'approved' }));

    const product = await s.db.products.findOne({ code: 'NT-118' }).lean();
    const before = product.variant_list.find((v) => v.sku === 'NT-118-M').stock;
    const noReason = await s.call(`/orders/${order._id}/status`, { method: 'POST', token, body: { status: 'cancelled' } });
    assert.equal(noReason.status, 400);
    const cancelled = await s.call(`/orders/${order._id}/status`, { method: 'POST', token, body: { status: 'cancelled', reason: 'fake_order', restock: true } });
    assert.equal(cancelled.body.status, 'cancelled');
    const after = (await s.db.products.findOne({ code: 'NT-118' }).lean()).variant_list.find((v) => v.sku === 'NT-118-M').stock;
    assert.equal(after, before + 1, 'the item went back in stock');
    assert.equal((await s.db.orders.findById(order._id).lean()).cancel_reason, 'fake_order');
  } finally {
    await s.close();
  }
});

test('booking a courier moves orders to in transit; agents cannot book or cancel', async () => {
  const s = await start();
  try {
    const owner = await s.login('talha@nokshithreads.com');
    const ready = await s.db.orders.find({ workspace_id: s.workspaceId, status: 'ready_to_ship' }).lean();
    const r = await s.call('/orders/book', { method: 'POST', token: owner, body: { ids: ready.map((o) => o._id), courier: 'steadfast' } });
    assert.equal(r.body.booked, 2);
    assert.ok(r.body.results.every((x) => x.testMode));
    const after = await s.db.orders.find({ _id: { $in: ready.map((o) => o._id) } }).lean();
    assert.ok(after.every((o) => o.status === 'in_transit' && o.courier === 'Steadfast' && o.consignment_id));
    assert.equal(await s.db.consignments.countDocuments({ order_id: { $in: ready.map((o) => o._id) } }), 2);
    const again = await s.call('/orders/book', { method: 'POST', token: owner, body: { ids: [ready[0]._id] } });
    assert.match(again.body.results[0].error, /already booked|in transit/);

    await s.db.users.updateOne({ email: 'mim@nokshithreads.com' }, { $set: { password_hash: hashPassword('password123') } });
    const agent = await s.login('mim@nokshithreads.com');
    const pending = await s.db.orders.findOne({ number: 1052 }).lean();
    assert.equal((await s.call('/orders/book', { method: 'POST', token: agent, body: { ids: [pending._id] } })).status, 403);
    assert.equal((await s.call(`/orders/${pending._id}/status`, { method: 'POST', token: agent, body: { status: 'cancelled', reason: 'other' } })).status, 403);
    assert.equal((await s.call(`/orders/${pending._id}/status`, { method: 'POST', token: agent, body: { status: 'approved' } })).status, 200, 'agents can still edit orders');
  } finally {
    await s.close();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { nextTry } from '../src/dashboard/money.js';
import { changeStatus } from '../src/dashboard/orderOps.js';

async function start() {
  const ctx = await setup({ env: { DRY_RUN: '1', AI_REPLY_DELAY_MS: '0' } });
  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const root = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${root}/api/dash${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = res.status === 204 ? '' : await res.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
    return { status: res.status, body: parsed, text: raw };
  };
  const login = async (email) => (await call('/auth/login', { method: 'POST', body: { login: email, password: 'password123' } })).body.token;
  const order = (extra = {}) => ctx.db.insert(ctx.db.orders, { workspace_id: ctx.ws, customer_name: 'Sadia Rahman', phone: '01712345678', address: 'Mirpur', area: 'inside_dhaka',
    items: [{ name: 'Kurti', qty: 1, price: 1500 }], subtotal: 1500, delivery_charge: 70, cod_amount: 1570, status: 'pending', ...extra });
  return { ...ctx, app, call, order, owner: await login('owner@shop.test'), close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000);

test('cash: delivered parcels group by courier and day, with due / late status; mark received records the payout', async () => {
  const s = await start();
  try {
    for (const [n, courier, ago, fee] of [[1, 'steadfast', 0, 60], [2, 'steadfast', 0, 60], [3, 'pathao', 6, 70]]) {
      const o = await s.order({ number: n, status: 'delivered', delivered_at: daysAgo(ago), courier: courier === 'pathao' ? 'Pathao' : 'Steadfast', consignment_id: `C${n}` });
      await s.db.insert(s.db.consignments, { workspace_id: s.ws, order_id: o.id, courier, consignment_id: `C${n}`, fee });
    }
    // Not delivered yet: not owed.
    const moving = await s.order({ number: 4, status: 'in_transit' });
    await s.db.insert(s.db.consignments, { workspace_id: s.ws, order_id: moving.id, courier: 'steadfast', consignment_id: 'C4', fee: 60 });

    const d = (await s.call('/money', { token: s.owner })).body;
    assert.equal(d.cash.rows.length, 2);
    const sf = d.cash.rows.find((r) => r.courier === 'steadfast');
    const pt = d.cash.rows.find((r) => r.courier === 'pathao');
    assert.deepEqual([sf.parcels, sf.collected, sf.fees, sf.amount, sf.status], [2, 3140, 120, 3020, 'due_tomorrow']);
    assert.deepEqual([pt.amount, pt.status, pt.lateDays], [1500, 'late', 4]);
    assert.deepEqual([d.cash.kpis.withCouriers, d.cash.kpis.unpaidParcels, d.cash.kpis.late], [4520, 3, 1500]);

    const paid = await s.call('/money/payouts', { method: 'POST', token: s.owner, body: { key: pt.key } });
    assert.deepEqual([paid.status, paid.body.amount, paid.body.parcels], [201, 1500, 1]);
    assert.equal((await s.call('/money/payouts', { method: 'POST', token: s.owner, body: { key: pt.key } })).status, 404, 'not twice');
    const after = (await s.call('/money', { token: s.owner })).body;
    assert.equal(after.cash.kpis.received30, 1500);
    assert.equal(after.cash.rows.find((r) => r.courier === 'pathao').status, 'received');
    const file = await s.call('/money.csv?tab=cash', { token: s.owner });
    assert.match(file.text, /Courier,From,To,Parcels/);
  } finally { await s.close(); }
});

test('returns: a returned order is recorded with its loss; restock puts stock back; exchanges come from solved tickets', async () => {
  const s = await start();
  try {
    const product = await s.db.insert(s.db.products, { workspace_id: s.ws, name: 'Kurti', price: 1500, stock: 3, track_stock: true });
    const o = await s.order({ number: 9, status: 'in_transit', courier: 'Steadfast', consignment_id: 'R1', product_items: [{ product_id: product.id, name: 'Kurti', qty: 1, price: 1500 }] });
    await s.db.insert(s.db.consignments, { workspace_id: s.ws, order_id: o.id, courier: 'steadfast', consignment_id: 'R1', fee: 60, status: 'cancelled' });
    await changeStatus(s.db, null, await s.db.orders.findById(o.id).lean(), 'returned', { by: 'courier' });
    await new Promise((r) => setTimeout(r, 100)); // the status listener runs after the change
    let d = (await s.call('/money', { token: s.owner })).body;
    assert.equal(d.returns.rows.length, 1);
    const r = d.returns.rows[0];
    assert.deepEqual([r.type, r.parcel, r.stock, r.loss], ['return', 'coming', 'waiting', 90]);

    const stockBefore = (await s.db.products.findById(product.id).lean()).stock;
    assert.equal((await s.call(`/money/returns/${r.id}`, { method: 'PATCH', token: s.owner, body: { action: 'restock' } })).status, 200);
    assert.equal((await s.call(`/money/returns/${r.id}`, { method: 'PATCH', token: s.owner, body: { action: 'restock' } })).status, 409);
    const p = await s.db.products.findById(product.id).lean();
    if (typeof stockBefore === 'number') assert.equal(p.stock, stockBefore + 1);
    assert.equal((await s.call(`/money/returns/${r.id}`, { method: 'PATCH', token: s.owner, body: { action: 'done' } })).body.done, true);

    // A complaint solved with an exchange.
    const o2 = await s.order({ number: 10, status: 'delivered' });
    await s.db.insert(s.db.tickets, { workspace_id: s.ws, number: 501, title: 'Wrong colour sent', type: 'exchange', status: 'open', order_id: o2.id, timeline: [] });
    const solved = await s.call('/tickets/501', { method: 'PATCH', token: s.owner, body: { status: 'solved', resolutionKind: 'exchanged', resolution: 'Exchanged' } });
    assert.equal(solved.status, 200);
    d = (await s.call('/money', { token: s.owner })).body;
    const ex = d.returns.rows.find((x) => x.type === 'exchange');
    assert.deepEqual([ex.number, ex.reason, ex.loss], [10, 'Wrong colour sent', 70]);
    assert.equal(d.returns.kpis.exchanges, 1);
  } finally { await s.close(); }
});

test('to chase: "couldn\'t reach" pauses the order; no answer sets the next try; confirmed puts it back; cancel cancels', async () => {
  assert.equal(nextTry(1, new Date('2026-11-20T06:00:00Z')).toISOString(), '2026-11-20T08:00:00.000Z');
  assert.equal(nextTry(3, new Date('2026-11-20T06:00:00Z')).toISOString(), '2026-11-21T05:00:00.000Z', 'next day 11 AM Dhaka');
  const s = await start();
  try {
    const o = await s.order({ number: 20 });
    assert.equal((await s.call(`/orders/${o.id}/chase`, { method: 'POST', token: s.owner, body: {} })).status, 201);
    let fresh = await s.db.orders.findById(o.id).lean();
    assert.deepEqual([fresh.status, fresh.hold_reason, fresh.chase.active], ['on_hold', "Couldn't reach the customer", true]);

    assert.equal((await s.call(`/money/chase/${o.id}/try`, { method: 'POST', token: s.owner, body: { kind: 'whatsapp' } })).body.tries, 1);
    assert.equal((await s.call(`/money/chase/${o.id}/result`, { method: 'POST', token: s.owner, body: { result: 'no_answer' } })).body.active, true);
    let row = (await s.call('/money', { token: s.owner })).body.chase.rows[0];
    assert.deepEqual([row.number, row.calls, row.whatsapps, row.overdue], [20, 1, 1, false]);

    await s.call(`/money/chase/${o.id}/result`, { method: 'POST', token: s.owner, body: { result: 'confirmed' } });
    fresh = await s.db.orders.findById(o.id).lean();
    assert.deepEqual([fresh.status, fresh.chase.active, fresh.chase.result], ['approved', false, 'confirmed']);

    const o2 = await s.order({ number: 21 });
    await s.call(`/orders/${o2.id}/chase`, { method: 'POST', token: s.owner, body: {} });
    await s.call(`/money/chase/${o2.id}/result`, { method: 'POST', token: s.owner, body: { result: 'cancel' } });
    fresh = await s.db.orders.findById(o2.id).lean();
    assert.deepEqual([fresh.status, fresh.cancel_reason], ['cancelled', 'other']);
    assert.equal((await s.call('/money', { token: s.owner })).body.chase.rows.length, 0);
    const delivered = await s.order({ number: 22, status: 'delivered' });
    assert.equal((await s.call(`/orders/${delivered.id}/chase`, { method: 'POST', token: s.owner, body: {} })).status, 409);
  } finally { await s.close(); }
});

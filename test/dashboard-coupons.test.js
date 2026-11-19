import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { aiCoupons, audienceProblem } from '../src/dashboard/orderBuild.js';
import { couponStatus, generateCode } from '../src/routes/dashboard/coupons.js';
import { placeAiOrder } from '../src/dashboard/aiOrder.js';

async function start() {
  const ctx = await setup({ env: { DRY_RUN: '1', AI_REPLY_DELAY_MS: '0' } });
  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const root = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${root}/api/dash${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
  };
  const login = async (email) => (await call('/auth/login', { method: 'POST', body: { login: email, password: 'password123' } })).body.token;
  return { ...ctx, app, call, owner: await login('owner@shop.test'), mod: await login('nadia@shop.test'), close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

test('status, generated codes, audiences and the coupons the AI may mention', () => {
  const now = new Date('2026-11-20T10:00:00Z');
  assert.equal(couponStatus({ active: false }, now), 'paused');
  assert.equal(couponStatus({ ends_at: new Date('2026-11-01') }, now), 'expired');
  assert.equal(couponStatus({ max_uses: 5, used: 5 }, now), 'used_up');
  assert.equal(couponStatus({ starts_at: new Date('2026-12-01') }, now), 'scheduled');
  assert.equal(couponStatus({}, now), 'live');
  assert.match(generateCode('eid'), /^EID-[A-Z2-9]{4}$/);
  assert.match(generateCode(), /^SAVE-[A-Z2-9]{4}$/);

  assert.equal(audienceProblem({ code: 'NEW1', audience: 'new' }, null), null, 'an unknown phone is a new customer');
  assert.match(audienceProblem({ code: 'NEW1', audience: 'new' }, { stats: { orders: 2 } }), /first order/);
  assert.match(audienceProblem({ code: 'BACK', audience: 'returning' }, null), /ordered before/);
  assert.match(audienceProblem({ code: 'VIP', audience: 'vip' }, { vip: false }), /VIP/);
  assert.equal(audienceProblem({ code: 'VIP', audience: 'vip' }, { vip: true }), null);
  assert.equal(audienceProblem({ code: 'BC', audience: 'broadcast' }, null), null, 'campaign codes work for whoever has them');

  const list = [
    { code: 'LIVE', audience: 'everyone' }, { code: 'QUIET', audience: 'everyone', ai_may_mention: false }, { code: 'VIP', audience: 'vip' },
    { code: 'OFF', audience: 'everyone', active: false }, { code: 'GONE', audience: 'everyone', max_uses: 1, used: 1 }, { code: 'LATER', audience: 'everyone', starts_at: new Date('2027-01-01') },
  ];
  assert.deepEqual(aiCoupons(list, now).map((c) => c.code), ['LIVE']);
});

test('coupons: create with validation, list with sales, edit, pause, delete only unused', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('/coupons', { method: 'POST', token: s.mod, body: { code: 'EID10', type: 'percent', value: 10 } })).status, 403);
    for (const body of [{ code: 'x', type: 'percent', value: 10 }, { code: 'EID10', type: 'percent', value: 95 }, { code: 'EID10', type: 'gift' }, { code: 'EID10', type: 'amount', value: 100, startsAt: '2026-12-10', endsAt: '2026-12-01' }]) {
      assert.equal((await s.call('/coupons', { method: 'POST', token: s.owner, body })).status, 400, JSON.stringify(body));
    }
    const a = await s.call('/coupons', { method: 'POST', token: s.owner, body: { code: 'eid10', type: 'percent', value: 10, minOrder: 1500, maxUses: 100, audience: 'everyone' } });
    assert.deepEqual([a.status, a.body.code], [201, 'EID10']);
    assert.equal((await s.call('/coupons', { method: 'POST', token: s.owner, body: { code: 'EID10', type: 'amount', value: 50 } })).status, 409);
    const fd = await s.call('/coupons', { method: 'POST', token: s.owner, body: { code: 'FREEDEL', type: 'free_delivery', value: 999 } });
    assert.equal((await s.db.coupons.findById(fd.body.id).lean()).value, 0);
    assert.match((await s.call('/coupons/generate?prefix=Eid', { token: s.owner })).body.code, /^EID-/);

    await s.db.coupons.updateOne({ _id: a.body.id }, { $set: { used: 2 } });
    await s.db.insert(s.db.orders, { workspace_id: s.ws, number: 1, customer_name: 'A', phone: '01712345678', address: 'x', area: 'inside_dhaka', cod_amount: 1, subtotal: 2000, delivery_charge: 70, discount: 200, coupon_code: 'EID10', status: 'delivered', items: [] });
    await s.db.insert(s.db.orders, { workspace_id: s.ws, number: 2, customer_name: 'B', phone: '01712345679', address: 'x', area: 'inside_dhaka', cod_amount: 1, subtotal: 3000, delivery_charge: 70, discount: 300, coupon_code: 'EID10', status: 'cancelled', items: [] });
    const list = await s.call('/coupons', { token: s.owner });
    const eid = list.body.coupons.find((c) => c.code === 'EID10');
    assert.deepEqual([eid.status, eid.used, eid.orders, eid.revenue, eid.given], ['live', 2, 1, 1870, 200], 'cancelled orders don\'t count');
    assert.deepEqual(list.body.totals, { orders: 1, revenue: 1870, given: 200 });

    assert.equal((await s.call(`/coupons/${a.body.id}`, { method: 'PATCH', token: s.owner, body: { code: 'EID20' } })).status, 409, 'a used code can\'t be renamed');
    assert.equal((await s.call(`/coupons/${a.body.id}`, { method: 'PATCH', token: s.owner, body: { value: 15, active: false } })).status, 200);
    assert.equal((await s.call('/coupons', { token: s.owner })).body.coupons.find((c) => c.code === 'EID10').status, 'paused');
    assert.equal((await s.call(`/coupons/${a.body.id}`, { method: 'DELETE', token: s.owner })).status, 409, 'used coupons are paused, not deleted');
    assert.equal((await s.call(`/coupons/${fd.body.id}`, { method: 'DELETE', token: s.owner })).status, 204);
  } finally { await s.close(); }
});

test('the order form checks who can use a coupon', async () => {
  const s = await start();
  try {
    const p = await s.db.insert(s.db.products, { workspace_id: s.ws, name: 'Kurti', price: 1500, in_stock: true });
    await s.db.insert(s.db.coupons, { workspace_id: s.ws, code: 'FIRST', type: 'amount', value: 200, audience: 'new' });
    await s.db.insert(s.db.coupons, { workspace_id: s.ws, code: 'VIP300', type: 'amount', value: 300, audience: 'vip' });
    await s.db.insert(s.db.customers, { workspace_id: s.ws, name: 'Mitu', phones: ['01712345678'], stats: { orders: 3 }, vip: true });
    const quote = (coupon, phone) => s.call('/orders/quote', { method: 'POST', token: s.owner, body: { items: [{ productId: p.id, qty: 1 }], zone: 'inside_dhaka', coupon, phone } });
    assert.equal((await quote('FIRST', '01999999999')).body.discount, 200, 'a new phone gets the first-order code');
    const repeat = await quote('FIRST', '01712345678');
    assert.deepEqual([repeat.status, repeat.body.error], [400, "FIRST is only for a customer's first order"]);
    assert.equal((await quote('VIP300', '01712345678')).body.discount, 300);
    assert.equal((await quote('VIP300', '01999999999')).status, 400);
  } finally { await s.close(); }
});

test('the AI applies a coupon the customer gives, and the use is counted', async () => {
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  const p = await ctx.db.insert(ctx.db.products, { workspace_id: ctx.ws, name: 'Kurti', price: 2000, in_stock: true });
  await ctx.db.insert(ctx.db.coupons, { workspace_id: ctx.ws, code: 'EID10', type: 'percent', value: 10, min_order: 1500 });
  const conv = await ctx.db.insert(ctx.db.conversations, { workspace_id: ctx.ws, channel_id: 1, contact_id: 1, status: 'open' });
  const input = { items: [{ product_id: p.id, variant: '', qty: 1 }], name: 'Sadia', phone: '01712345678', address: 'House 1, Road 2, Dhanmondi', zone: 'inside_dhaka', coupon: 'eid10' };
  const { order } = await placeAiOrder(ctx.db, { conversation: { ...conv, _id: conv.id }, input });
  assert.deepEqual([order.coupon_code, order.discount, order.subtotal], ['EID10', 200, 2000]);
  assert.equal((await ctx.db.coupons.findOne({ code: 'EID10' }).lean()).used, 1);
  await assert.rejects(placeAiOrder(ctx.db, { conversation: { ...conv, _id: conv.id }, input: { ...input, coupon: 'FAKE50' } }), /no coupon "FAKE50"/);
});

test('ordering a product without sizes doesn\'t mark it sold out', async () => {
  const { adjustStock } = await import('../src/dashboard/orderOps.js');
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  const plain = await ctx.db.insert(ctx.db.products, { workspace_id: ctx.ws, name: 'Gift box', price: 500, in_stock: true });
  const sized = await ctx.db.insert(ctx.db.products, { workspace_id: ctx.ws, name: 'Kurti', price: 1500, in_stock: true, variant_list: [{ sku: 'K-M', options: { Size: 'M' }, stock: 1 }] });
  await adjustStock(ctx.db, { product_items: [{ product_id: plain.id, sku: '', qty: 1 }, { product_id: sized.id, sku: 'K-M', qty: 1 }] }, -1);
  assert.equal((await ctx.db.products.findById(plain.id).lean()).in_stock, true);
  assert.equal((await ctx.db.products.findById(sized.id).lean()).in_stock, false, 'the last counted size sold out');
});

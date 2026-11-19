import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, inbound } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { cleanConditions, segmentMembers, autoTagCounts } from '../src/dashboard/segments.js';

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
  return { ...ctx, app, call, owner: await login('owner@shop.test'), close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

async function people(db, ws) {
  const days = (n) => new Date(Date.now() - n * 86_400_000);
  const add = (name, extra) => db.insert(db.customers, { workspace_id: ws, name, phones: [`017${String(Math.random()).slice(2, 10)}`], ...extra });
  return {
    mitu: await add('Mitu', { vip: true, tags: ['Wholesale'], area: 'Dhanmondi, Dhaka', stats: { orders: 6, delivered: 6, returned: 0, cancelled: 0, spent: 18000 }, last_active_at: days(3) }),
    rafi: await add('Rafi', { stats: { orders: 2, delivered: 1, returned: 1, cancelled: 0, spent: 2600 }, last_active_at: days(90), area: 'Rajshahi' }),
    nila: await add('Nila', { stats: { orders: 1, delivered: 1, returned: 0, cancelled: 0, spent: 1450 }, last_active_at: days(10) }),
    bad: await add('Badhon', { stats: { orders: 4, delivered: 0, returned: 3, cancelled: 1, spent: 0 }, last_active_at: days(5) }),
    gone: await add('Blocked', { blocked: true, stats: { orders: 9, spent: 50000 } }),
  };
}

test('conditions are checked, combined with AND, and blocked customers are never in a segment', async () => {
  assert.throws(() => cleanConditions([]), /at least one/);
  assert.throws(() => cleanConditions([{ field: 'orders', op: 'has', value: 1 }]), /doesn't work/);
  assert.throws(() => cleanConditions([{ field: 'spent', op: 'gte', value: 'lots' }]), /number/);
  const ctx = await setup({ env: {} });
  const p = await people(ctx.db, ctx.ws);
  const ids = async (conds) => (await segmentMembers(ctx.db, ctx.ws, cleanConditions(conds))).ids.sort();
  assert.deepEqual(await ids([{ field: 'orders', op: 'gte', value: 2 }]), [p.mitu.id, p.rafi.id, p.bad.id].sort());
  assert.deepEqual(await ids([{ field: 'orders', op: 'gte', value: 2 }, { field: 'active_days', op: 'gte', value: 60 }]), [p.rafi.id], 'repeat buyers gone quiet');
  assert.deepEqual(await ids([{ field: 'tag', op: 'has', value: 'wholesale' }]), [p.mitu.id], 'tags match without case');
  assert.deepEqual(await ids([{ field: 'tag', op: 'has', value: 'Repeat buyer' }]), [p.mitu.id, p.rafi.id, p.bad.id].sort(), 'automatic tags work as conditions');
  assert.deepEqual(await ids([{ field: 'risk', op: 'is', value: 'high' }]), [p.rafi.id, p.bad.id].sort(), 'COD risk from their history (Rafi returned 1 of 2)');
  assert.deepEqual(await ids([{ field: 'vip', op: 'is', value: true }, { field: 'area', op: 'has', value: 'dhaka' }]), [p.mitu.id]);
  assert.deepEqual(await ids([{ field: 'spent', op: 'gte', value: 10000 }]), [p.mitu.id], 'the blocked big spender is left out');
  const auto = await autoTagCounts(ctx.db, ctx.ws);
  assert.deepEqual([auto.vip, auto.repeat, auto.first, auto.big_spender, auto.returned, auto.high_risk], [1, 3, 1, 1, 2, 2]);
});

test('segments screen: preview, create, members, tag everyone, rename and delete tags', async () => {
  const s = await start();
  try {
    const p = await people(s.db, s.ws);
    const pv = await s.call('/segments/preview', { method: 'POST', token: s.owner, body: { conditions: [{ field: 'orders', op: 'gte', value: 2 }] } });
    assert.equal(pv.body.count, 3);
    assert.equal((await s.call('/segments/preview', { method: 'POST', token: s.owner, body: { conditions: [{ field: 'nope', op: 'gte', value: 1 }] } })).status, 400);
    const c = await s.call('/segments', { method: 'POST', token: s.owner, body: { name: 'Repeat buyers', conditions: [{ field: 'orders', op: 'gte', value: 2 }] } });
    assert.equal(c.status, 201);
    const list = await s.call('/segments', { token: s.owner });
    assert.deepEqual(list.body.segments.map((x) => [x.name, x.count]), [['Repeat buyers', 3]]);
    assert.equal(list.body.autoTags.find((a) => a.key === 'high_risk').count, 2);
    assert.deepEqual(list.body.tags.map((x) => [x.name, x.count]), [['Wholesale', 1]]);

    const members = await s.call(`/segments/${c.body.id}/customers`, { token: s.owner });
    assert.deepEqual(members.body.customers.map((x) => x.name), ['Mitu', 'Rafi', 'Badhon'], 'top spenders first');
    assert.equal(members.body.customers[2].risk, 'high');

    assert.equal((await s.call(`/segments/${c.body.id}/tag`, { method: 'POST', token: s.owner, body: { tag: 'Eid 2026' } })).body.tagged, 3);
    assert.ok((await s.db.customers.findById(p.rafi.id).lean()).tags.includes('Eid 2026'));
    assert.equal((await s.call('/tags', { method: 'POST', token: s.owner, body: { name: 'Repeat buyer' } })).status, 409, 'automatic tag names are taken');
    assert.equal((await s.call('/tags/Eid%202026', { method: 'PATCH', token: s.owner, body: { name: 'Eid buyers', colour: 'green' } })).status, 200);
    assert.deepEqual((await s.db.customers.findById(p.mitu.id).lean()).tags.sort(), ['Eid buyers', 'Wholesale']);
    assert.equal((await s.call('/segments', { token: s.owner })).body.tags.find((x) => x.name === 'Eid buyers').colour, 'green');
    assert.equal((await s.call('/tags/Eid%20buyers', { method: 'DELETE', token: s.owner })).body.removed, 3);
    assert.equal(await s.db.customers.countDocuments({ tags: 'Eid buyers' }), 0);
  } finally { await s.close(); }
});

test('a segment\'s coupon only works for its members, and broadcasts can go to a segment', async () => {
  const s = await start();
  try {
    const p = await people(s.db, s.ws);
    const seg = await s.call('/segments', { method: 'POST', token: s.owner, body: { name: 'VIPs', conditions: [{ field: 'vip', op: 'is', value: true }] } });
    assert.equal((await s.call('/coupons', { method: 'POST', token: s.owner, body: { code: 'VIPONLY', type: 'amount', value: 200, audience: 'segment' } })).status, 400, 'needs the segment');
    assert.equal((await s.call('/coupons', { method: 'POST', token: s.owner, body: { code: 'VIPONLY', type: 'amount', value: 200, audience: 'segment', segmentId: seg.body.id } })).status, 201);
    assert.equal((await s.call('/coupons', { token: s.owner })).body.coupons[0].segmentName, 'VIPs');
    const product = await s.db.insert(s.db.products, { workspace_id: s.ws, name: 'Kurti', price: 1500, in_stock: true });
    const quote = (phone) => s.call('/orders/quote', { method: 'POST', token: s.owner, body: { items: [{ productId: product.id, qty: 1 }], zone: 'inside_dhaka', coupon: 'VIPONLY', phone } });
    const mituPhone = (await s.db.customers.findById(p.mitu.id).lean()).phones[0];
    const nilaPhone = (await s.db.customers.findById(p.nila.id).lean()).phones[0];
    assert.equal((await quote(mituPhone)).body.discount, 200);
    const no = await quote(nilaPhone);
    assert.deepEqual([no.status, no.body.error], [400, 'VIPONLY is only for customers in "VIPs"']);
    assert.equal((await s.call(`/segments/${seg.body.id}`, { method: 'DELETE', token: s.owner })).status, 409, 'a live coupon uses it');

    // Broadcast to the segment: only members who messaged in the last 24 hours.
    const { conversation } = await s.app.inbox.ingestMessage(inbound({ contactExternalId: 'mitu-psid', text: 'hi' }));
    await s.db.conversations.updateOne({ _id: conversation.id }, { $set: { customer_id: p.mitu.id } });
    const other = await s.app.inbox.ingestMessage(inbound({ contactExternalId: 'nila-psid', text: 'hi' }));
    await s.db.conversations.updateOne({ _id: other.conversation.id }, { $set: { customer_id: p.nila.id } });
    const pv = await s.call('/growth/broadcasts/preview', { method: 'POST', token: s.owner, body: { audience: `segment:${seg.body.id}` } });
    assert.equal(pv.body.recipients, 1);
    assert.equal((await s.call('/growth/broadcasts/preview', { method: 'POST', token: s.owner, body: { audience: 'last_24h' } })).body.recipients, 2);
  } finally { await s.close(); }
});

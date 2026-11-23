import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { setup, inbound } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { sign, orderData, fireEvent } from '../src/dashboard/webhooks.js';
import { publicHttpsUrl } from '../src/dashboard/safeUrl.js';

const HOOK = 'https://93.184.216.34/heyquicky'; // a public address, so no DNS lookup in tests

test('signing, the order shape, and only public https addresses', async () => {
  assert.equal(sign('whsec_x', '{"a":1}'), `sha256=${createHmac('sha256', 'whsec_x').update('{"a":1}').digest('hex')}`);
  const o = orderData({ number: 1043, status: 'pending', source: 'api', customer_name: 'Sadia', phone: '01712345678', address: 'x', zone: 'inside_dhaka', product_items: [{ name: 'Kurti', variant: 'M', sku: 'K-M', qty: 2, price: 1450 }],
    subtotal: 2900, delivery_charge: 70, discount: 100, cod_amount: 2870, bill_token: 'abc' }, { publicUrl: 'https://shop.test/' });
  assert.deepEqual([o.total, o.cash_to_collect, o.items[0].sku, o.bill_url, o.customer.phone], [2870, 2870, 'K-M', 'https://shop.test/b/abc', '01712345678']);
  await assert.rejects(publicHttpsUrl('http://93.184.216.34/x'), /https/);
  await assert.rejects(publicHttpsUrl('https://192.168.0.5/x'), /public/);
  await assert.rejects(publicHttpsUrl('https://localhost/x'), /public/);
  assert.equal(await publicHttpsUrl(HOOK), HOOK);
});

async function start() {
  const ctx = await setup({ env: { DRY_RUN: '1', TOKEN_ENCRYPTION_KEY: 'a'.repeat(64) } });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { delivery_inside_dhaka: 70, order_seq: 1000 } });
  const posted = [];
  let answer = 200;
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).startsWith(HOOK)) { posted.push({ url, headers: opts.headers, body: opts.body }); return { status: answer, ok: answer < 300 }; }
    return fetch(url, opts);
  };
  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent', fetchImpl });
  await new Promise((r) => app.server.listen(0, r));
  const root = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
    const res = await fetch(`${root}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const login = async (email) => (await call('/api/dash/auth/login', { method: 'POST', body: { login: email, password: 'password123' } })).body.token;
  const product = (await ctx.db.insert(ctx.db.products, { workspace_id: ctx.ws, name: 'Jamdani Kurti', code: 'JK', price: 1450, variant_list: [{ sku: 'JK-M', options: { Size: 'M' }, price: 1450, stock: 5 }] })).id;
  return { ...ctx, app, call, posted, setAnswer: (c) => { answer = c; }, product, owner: await login('owner@shop.test'), mod: await login('nadia@shop.test'), close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

test('webhooks: owners add an endpoint, events arrive signed, failures are retried then given up, paused endpoints get nothing', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('/api/dash/integrations/webhooks', { method: 'POST', token: s.mod, body: { url: HOOK, events: ['order.created'] } })).status, 403);
    assert.equal((await s.call('/api/dash/integrations/webhooks', { method: 'POST', token: s.owner, body: { url: 'http://93.184.216.34/x', events: ['order.created'] } })).status, 400);
    const made = await s.call('/api/dash/integrations/webhooks', { method: 'POST', token: s.owner, body: { url: HOOK, events: ['order.created', 'message.received'] } });
    assert.equal(made.status, 201);
    assert.match(made.body.secret, /^whsec_/);
    const ws = await s.db.workspaces.findById(s.ws).lean();
    assert.equal(JSON.stringify(ws.settings.webhooks).includes(made.body.secret), false, 'secret stored encrypted');
    const view = await s.call('/api/dash/integrations', { token: s.owner });
    assert.equal(JSON.stringify(view.body.webhooks).includes('whsec_'), false, 'never shown again');

    // A customer message arrives → message.received, signed.
    await s.app.inbox.ingestMessage(inbound({ contactExternalId: 'mitu', contactName: 'Mitu', text: 'dam koto?' }));
    let msg = null;
    for (let i = 0; i < 60 && !msg; i++) { await s.app.webhooks.run(); msg = s.posted.find((p) => p.headers['x-heyquicky-event'] === 'message.received'); if (!msg) await new Promise((r) => setTimeout(r, 50)); }
    assert.ok(msg, 'delivered');
    assert.equal(msg.headers['x-heyquicky-signature'], sign(made.body.secret, msg.body), 'signed with the secret');
    assert.equal(JSON.parse(msg.body).data.text, 'dam koto?');

    // order.status_changed isn't subscribed, so it isn't sent.
    assert.equal(await fireEvent(s.db, s.ws, 'order.status_changed', { number: 1 }), 0);

    // The endpoint fails: tried again after 1 minute, then 5, then 30, then given up.
    s.setAnswer(500);
    await fireEvent(s.db, s.ws, 'order.created', { number: 5 });
    await s.app.webhooks.run();
    let d = await s.db.webhookDeliveries.findOne({ event: 'order.created' }).lean();
    assert.deepEqual([d.status, d.attempts, d.last_code, d.last_error], ['pending', 1, 500, 'Answered 500']);
    assert.ok(d.next_at > new Date(Date.now() + 50_000));
    for (let i = 0; i < 3; i++) { await s.db.webhookDeliveries.updateOne({ _id: d._id }, { $set: { next_at: new Date() } }); await s.app.webhooks.run(); }
    d = await s.db.webhookDeliveries.findById(d._id).lean();
    assert.deepEqual([d.status, d.attempts], ['failed', 4]);

    // "Send test" reports the result straight away; paused endpoints get nothing.
    s.setAnswer(204);
    const t = await s.call(`/api/dash/integrations/webhooks/${made.body.id}/test`, { method: 'POST', token: s.owner });
    assert.deepEqual(t.body, { ok: true, code: 204, error: '' });
    await s.call(`/api/dash/integrations/webhooks/${made.body.id}`, { method: 'PATCH', token: s.owner, body: { active: false } });
    assert.equal(await fireEvent(s.db, s.ws, 'order.created', { number: 6 }), 0);
    const log = await s.call(`/api/dash/integrations/webhooks/${made.body.id}/deliveries`, { token: s.owner });
    assert.ok(log.body.length >= 3);
  } finally {
    await s.close();
  }
});

test('API: keys shown once, products and orders read, orders created from the catalog, safe retries, revoked keys refused', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('/api/v1/products')).status, 401);
    const k = await s.call('/api/dash/integrations/api-keys', { method: 'POST', token: s.owner, body: { name: 'Stock sheet' } });
    assert.equal(k.status, 201);
    const key = k.body.key;
    assert.match(key, /^hq_live_/);
    assert.equal(JSON.stringify(await s.db.apiKeys.find().lean()).includes(key), false, 'only a hash is stored');

    const prods = await s.call('/api/v1/products', { token: key });
    assert.deepEqual(prods.body.data.map((p) => [p.name, p.variants[0].sku, p.variants[0].stock]), [['Jamdani Kurti', 'JK-M', 5]]);

    const body = { customer: { name: 'Sadia', phone: '01712345678' }, address: 'House 7, Road 3, Dhanmondi, Dhaka', zone: 'inside_dhaka', items: [{ sku: 'JK-M', qty: 2, price: 1 }], external_ref: 'erp-77' };
    const made = await s.call('/api/v1/orders', { method: 'POST', token: key, body });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual([made.body.data.source, made.body.data.subtotal, made.body.data.total, made.body.data.items[0].price], ['api', 2900, 2970, 1450], 'priced from the catalog, not from the request');
    assert.equal((await s.db.products.findById(s.product).lean()).variant_list[0].stock, 3, 'stock taken');
    const again = await s.call('/api/v1/orders', { method: 'POST', token: key, body });
    assert.deepEqual([again.status, again.body.duplicate, again.body.data.number], [200, true, made.body.data.number], 'the same external_ref never makes a second order');
    assert.equal((await s.call('/api/v1/orders', { method: 'POST', token: key, body: { ...body, external_ref: 'erp-78', items: [{ sku: 'NOPE', qty: 1 }] } })).status, 400);
    assert.equal((await s.call('/api/v1/orders', { method: 'POST', token: key, body: { ...body, external_ref: 'erp-79', customer: { name: 'X', phone: '0171' } } })).status, 400);

    const one = await s.call(`/api/v1/orders/${made.body.data.number}`, { token: key });
    assert.equal(one.body.data.customer.name, 'Sadia');
    const list = await s.call('/api/v1/orders?status=pending&limit=1', { token: key });
    assert.equal(list.body.data.length, 1);
    assert.equal((await s.call('/api/v1/orders?status=bogus', { token: key })).status, 400);
    assert.equal((await s.call('/api/v1/nope', { token: key })).status, 404);
    assert.ok((await s.db.apiKeys.findOne().lean()).last_used_at, 'last used is kept');

    // Moderators can't make keys; revoking stops the key at once.
    assert.equal((await s.call('/api/dash/integrations/api-keys', { method: 'POST', token: s.mod, body: { name: 'x' } })).status, 403);
    const id = (await s.db.apiKeys.findOne().lean())._id;
    await s.call(`/api/dash/integrations/api-keys/${id}`, { method: 'DELETE', token: s.owner });
    assert.equal((await s.call('/api/v1/products', { token: key })).status, 401);
  } finally {
    await s.close();
  }
});

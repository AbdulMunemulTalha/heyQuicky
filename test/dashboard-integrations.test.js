import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { buildEvent, createCapi, normPhone } from '../src/dashboard/capi.js';
import { changeStatus } from '../src/dashboard/orderOps.js';
import { encryptSecret } from '../src/secrets.js';

const sha = (v) => createHash('sha256').update(v).digest('hex');

async function start(env = {}) {
  const ctx = await setup({ env: { DRY_RUN: '1', AI_REPLY_DELAY_MS: '0', ...env } });
  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const root = `http://127.0.0.1:${app.server.address().port}`;
  const raw = (path, opts = {}) => fetch(`${root}${path}`, opts);
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await raw(`/api/dash${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
  };
  const login = async (email) => (await call('/auth/login', { method: 'POST', body: { login: email, password: 'password123' } })).body.token;
  return { ...ctx, app, raw, call, owner: await login('owner@shop.test'), mod: await login('nadia@shop.test'), close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

const ORDER = { _id: 7, number: 1042, workspace_id: 1, customer_id: 9, customer_name: 'Sadia Rahman', phone: '01712345678', district: 'Dhaka', subtotal: 2150, delivery_charge: 70, discount: 0, items: [{ name: 'Kurti', qty: 2 }] };

test('Conversions API events: hashed customer data, BDT value, one event id per order and kind', () => {
  assert.equal(normPhone('০১৭'.replace(/[০-৯]/g, '') || '01712345678'), '8801712345678');
  const e = buildEvent('purchase', ORDER, { now: new Date('2026-11-23T06:00:00Z') });
  assert.equal(e.event_name, 'Purchase');
  assert.equal(e.event_id, 'purchase-7');
  assert.equal(e.action_source, 'chat');
  assert.deepEqual(e.user_data.ph, [sha('8801712345678')]);
  assert.deepEqual(e.user_data.fn, [sha('sadia')]);
  assert.deepEqual(e.user_data.ln, [sha('rahman')]);
  assert.deepEqual(e.user_data.country, [sha('bd')]);
  assert.deepEqual([e.custom_data.currency, e.custom_data.value, e.custom_data.num_items], ['BDT', 2220, 2]);
  assert.equal(JSON.stringify(e).includes('01712345678'), false, 'no raw phone');
});

test('Conversions API: sent once per order to the shop pixel; confirmed orders send Purchase; switched-off kinds and failures are handled', async () => {
  const ctx = await setup({ env: { DRY_RUN: '0' } });
  const calls = [];
  let fail = false;
  const fetchImpl = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: !fail, status: fail ? 400 : 200, json: async () => (fail ? { error: { message: 'Invalid token' } } : { events_received: 1 }) }; };
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { settings: { capi: { pixel_id: '881200451193', token: encryptSecret('EAAGtesttoken1234567890', ctx.config.tokenKey), events: { add_to_cart: false } } } } });
  const capi = createCapi(ctx.db, { ...ctx.config, dryRun: false }, { fetchImpl, log: {} });
  const order = await ctx.db.insert(ctx.db.orders, { workspace_id: ctx.ws, number: 501, customer_name: 'Rafi', phone: '01811111111', address: 'x', area: 'inside_dhaka', items: [{ name: 'Panjabi', qty: 1, price: 1800 }], subtotal: 1800, delivery_charge: 70, cod_amount: 1870, status: 'pending' });
  const doc = await ctx.db.orders.findById(order.id).lean();
  assert.equal(await capi.onStatus(doc, 'pending', 'approved'), 'sent');
  assert.equal(await capi.onStatus(doc, 'pending', 'approved'), 'already');
  assert.match(calls[0].url, /\/881200451193\/events\?access_token=EAAGtesttoken1234567890/);
  assert.equal(calls[0].body.data[0].event_name, 'Purchase');
  assert.equal(await capi.send('add_to_cart', doc), 'off');
  fail = true;
  assert.equal(await capi.send('lead', doc), 'failed');
  const bad = await ctx.db.capiEvents.findOne({ key: 'lead' }).lean();
  assert.equal(bad.error, 'Invalid token');
});

test('integrations: owners connect the Conversions API (token stored encrypted) and turn on the website widget', async () => {
  const s = await start({ TOKEN_ENCRYPTION_KEY: 'a'.repeat(64) });
  try {
    let d = await s.call('/integrations', { token: s.owner });
    assert.equal(d.status, 200);
    assert.deepEqual([d.body.capi.connected, d.body.widget.on], [false, false]);
    assert.equal((await s.call('/integrations/capi', { method: 'PUT', token: s.mod, body: { pixelId: '881200451193', token: 'EAAGtesttoken1234567890' } })).status, 403);
    assert.equal((await s.call('/integrations/capi', { method: 'PUT', token: s.owner, body: { pixelId: 'abc', token: 'EAAGtesttoken1234567890' } })).status, 400);
    assert.equal((await s.call('/integrations/capi', { method: 'PUT', token: s.owner, body: { pixelId: '881200451193' } })).status, 400, 'needs a token');
    d = await s.call('/integrations/capi', { method: 'PUT', token: s.owner, body: { pixelId: '881200451193', token: 'EAAGtesttoken1234567890' } });
    assert.deepEqual([d.body.capi.connected, d.body.capi.pixelId, d.body.capi.testMode], [true, '881200451193', true]);
    const ws = await s.db.workspaces.findById(s.ws).lean();
    assert.equal(ws.settings.capi.token.includes('EAAGtesttoken'), false, 'stored encrypted');
    assert.equal(JSON.stringify(d.body).includes('EAAGtesttoken'), false, 'never sent back');

    // A confirmed order is recorded (test mode on this server, so nothing goes to Meta).
    const order = await s.db.insert(s.db.orders, { workspace_id: s.ws, number: 900, customer_name: 'Mitu', phone: '01712345678', address: 'x', area: 'inside_dhaka', items: [{ name: 'Kurti', qty: 1, price: 1450 }], subtotal: 1450, delivery_charge: 70, cod_amount: 1520, status: 'pending' });
    await changeStatus(s.db, null, await s.db.orders.findById(order.id).lean(), 'approved', { by: 'customer' });
    await new Promise((r) => setTimeout(r, 150));
    d = await s.call('/integrations', { token: s.owner });
    assert.equal(d.body.capi.sent.purchase, 1);
    assert.equal(d.body.capi.lastStatus, 'test');

    const w = await s.call('/integrations/widget', { method: 'PUT', token: s.owner, body: { on: true } });
    assert.equal(w.body.widget.on, true);
    assert.match(w.body.widget.snippet, /<script src=".*\/w\/[A-Za-z0-9_-]+\.js" async><\/script>/);
    assert.equal(await s.db.channels.countDocuments({ workspace_id: s.ws, platform: 'web' }), 1);
    assert.equal((await s.call('/integrations/widget', { method: 'PUT', token: s.owner, body: { colour: 'red' } })).status, 400);
  } finally { await s.close(); }
});

test('website widget: the script and chat page load; a visitor\'s message lands in the Inbox and they read replies to their own chat only', async () => {
  const s = await start();
  try {
    const w = await s.call('/integrations/widget', { method: 'PUT', token: s.owner, body: { on: true, greeting: 'Hello from Nokshi!' } });
    const token = w.body.widget.snippet.match(/\/w\/([A-Za-z0-9_-]+)\.js/)[1];
    const js = await (await s.raw(`/w/${token}.js`)).text();
    assert.match(js, new RegExp(`/w/${token}`));
    const page = await (await s.raw(`/w/${token}`)).text();
    assert.match(page, /Hello from Nokshi!/);
    assert.equal((await s.raw('/w/notarealtoken123')).status, 404);

    const sent = await s.raw(`/api/widget/${token}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'dam koto?' }) });
    assert.equal(sent.status, 201);
    assert.equal(sent.headers.get('access-control-allow-origin'), '*');
    const { visitor } = await sent.json();
    assert.match(visitor, /^v_/);
    const conv = await s.db.conversations.findOne({ workspace_id: s.ws }).sort({ _id: -1 }).lean();
    const channel = await s.db.channels.findById(conv.channel_id).lean();
    assert.equal(channel.platform, 'web');

    await s.app.inbox.sendReply({ id: 1, workspace_id: s.ws, team_id: s.ws, name: 'Talha', role: 'owner' }, conv._id, 'Ji, 1,450 taka').catch(() => null);
    const mine = await (await s.raw(`/api/widget/${token}/messages?visitor=${visitor}`)).json();
    assert.deepEqual(mine.messages.map((m) => m.direction).slice(0, 1), ['in']);
    assert.equal(mine.messages[0].text, 'dam koto?');
    const other = await (await s.raw(`/api/widget/${token}/messages?visitor=v_someoneelse12345678`)).json();
    assert.deepEqual(other.messages, [], 'another visitor sees nothing');

    // Turned off: the script stops loading and messages are refused.
    await s.call('/integrations/widget', { method: 'PUT', token: s.owner, body: { on: false } });
    assert.match(await (await s.raw(`/w/${token}.js`)).text(), /turned off/);
    assert.equal((await s.raw(`/api/widget/${token}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi', visitor }) })).status, 403);
  } finally { await s.close(); }
});

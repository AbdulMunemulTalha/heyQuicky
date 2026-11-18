import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { decryptSecret } from '../src/secrets.js';

async function start(env = {}) {
  const ctx = await setup({ env: { DRY_RUN: '1', ADMIN_TOKEN: 'admin-secret', TOPUP_BKASH_NUMBER: '01711000000', TOKEN_ENCRYPTION_KEY: 'a'.repeat(64), ...env } });
  const adapters = createAdapters({ ADAPTERS: 'fake' });
  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters, clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
    const res = await fetch(`${base}${path.startsWith('/admin') ? '' : '/api/dash'}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null), headers: res.headers };
  };
  const login = async (email, password = 'password123') => (await call('/auth/login', { method: 'POST', body: { login: email, password } })).body?.token;
  return { ...ctx, adapters, call, login, token: await login('owner@shop.test'), modToken: await login('nadia@shop.test'), close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}
const admin = { authorization: `Basic ${Buffer.from('x:admin-secret').toString('base64')}` };

test('top-ups wait for admin approval before any credit is added', async () => {
  const s = await start();
  try {
    let b = (await s.call('/settings/billing', { token: s.token })).body;
    assert.equal(b.balance, 0);
    assert.deepEqual(b.topup.methods, { bkash: '01711000000', nagad: null, card: false });
    assert.equal((await s.call('/settings/billing', { token: s.modToken })).status, 403, 'billing is owner-only');

    assert.equal((await s.call('/settings/billing/topup', { method: 'POST', token: s.token, body: { method: 'nagad', amount: 500, trxId: 'ABCD1234' } })).status, 400, 'nagad has no number set');
    assert.equal((await s.call('/settings/billing/topup', { method: 'POST', token: s.token, body: { method: 'bkash', amount: 50, trxId: 'ABCD1234' } })).status, 400, 'below the minimum');
    assert.equal((await s.call('/settings/billing/topup', { method: 'POST', token: s.token, body: { method: 'bkash', amount: 500, trxId: 'x' } })).status, 400, 'bad TrxID');
    const r = await s.call('/settings/billing/topup', { method: 'POST', token: s.token, body: { method: 'bkash', amount: '৫০০', trxId: 'bkh8x2k9qp' } });
    assert.equal(r.status, 201);
    assert.equal((await s.call('/settings/billing/topup', { method: 'POST', token: s.token, body: { method: 'bkash', amount: 500, trxId: 'BKH8X2K9QP' } })).status, 409, 'same TrxID twice');

    b = (await s.call('/settings/billing', { token: s.token })).body;
    assert.equal(b.balance, 0, 'nothing is credited yet');
    assert.deepEqual(b.pending.map((p) => [p.amount, p.trxId]), [[500, 'BKH8X2K9QP']]);

    assert.equal((await s.call('/admin/topups')).status, 401);
    const list = (await s.call('/admin/topups', { headers: admin })).body;
    assert.equal(list.length, 1);
    assert.equal(list[0].shop, 'Shop');
    const ok = await s.call(`/admin/topups/${list[0].id}/approve`, { method: 'POST', headers: admin });
    assert.equal(ok.body.balance, 500);
    assert.equal((await s.call(`/admin/topups/${list[0].id}/approve`, { method: 'POST', headers: admin })).status, 404, 'approving twice does nothing');
    b = (await s.call('/settings/billing', { token: s.token })).body;
    assert.equal(b.balance, 500);
    assert.equal(b.pending.length, 0);
  } finally { await s.close(); }
});

test('admin endpoints are off without ADMIN_TOKEN', async () => {
  const s = await start({ ADMIN_TOKEN: '' });
  try { assert.equal((await s.call('/admin/topups', { headers: admin })).status, 404); } finally { await s.close(); }
});

test('spend caps, delivery zones and payment settings save with checks', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('/settings/billing/caps', { method: 'PATCH', token: s.token, body: { monthly: '২০০০', alertBelow: 100 } })).status, 200);
    assert.deepEqual((await s.call('/settings/billing', { token: s.token })).body.caps, { monthly: 2000, alertBelow: 100 });

    assert.equal((await s.call('/settings/delivery/zones', { method: 'PATCH', token: s.modToken, body: { inside_dhaka: { charge: 60, days: '1' } } })).status, 403);
    const z = await s.call('/settings/delivery/zones', { method: 'PATCH', token: s.token, body: { inside_dhaka: { charge: 60, days: '1-2 days' }, dhaka_suburbs: { charge: 90, days: '2 days' } } });
    assert.deepEqual(z.body.zones.map((x) => [x.key, x.charge]), [['inside_dhaka', 60], ['dhaka_suburbs', 90], ['outside_dhaka', 130]]);
    const ws = await s.db.workspaces.findById(s.ws).lean();
    assert.equal(ws.delivery_inside_dhaka, 60, 'orders and the AI read the same field');

    assert.equal((await s.call('/settings/payments', { method: 'PATCH', token: s.token, body: { bkash: '01212345678' } })).status, 400, 'not a BD mobile number');
    assert.equal((await s.call('/settings/payments', { method: 'PATCH', token: s.token, body: { bkash: '০১৭১২-৩৪৫৬৭৮', screenshotsToWhatsapp: true, advance: { highRisk: false, outsideOver: 3000, amount: 500 } } })).status, 200);
    const p = (await s.call('/settings/payments', { token: s.token })).body;
    assert.equal(p.bkash, '01712345678');
    assert.deepEqual(p.advance, { highRisk: false, outsideOver: 3000, amount: 500 });
    assert.equal(p.screenshotsToWhatsapp, true);
  } finally { await s.close(); }
});

test('courier keys are stored encrypted and never sent back', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('/settings/couriers/steadfast', { method: 'PUT', token: s.token, body: { credentials: { api_key: 'k1' } } })).status, 400, 'secret key missing');
    assert.equal((await s.call('/settings/couriers/nope', { method: 'PUT', token: s.token, body: { credentials: {} } })).status, 404);
    assert.equal((await s.call('/settings/couriers/steadfast', { method: 'PUT', token: s.token, body: { credentials: { api_key: 'k1', secret_key: 'SECRET-xyz-123' }, autoBook: true } })).status, 200);
    assert.equal((await s.call('/settings/couriers/pathao', { method: 'PUT', token: s.token, body: { credentials: { client_id: 'a', client_secret: 'b', username: 'c', password: 'd', store_id: '1' } } })).status, 200);
    assert.equal((await s.call('/settings/couriers/pathao', { method: 'PATCH', token: s.token, body: { autoBook: true } })).status, 200);

    const d = (await s.call('/settings/delivery', { token: s.token })).body;
    const sf = d.couriers.find((c) => c.key === 'steadfast');
    assert.equal(sf.connected, true);
    assert.equal(sf.autoBook, false, 'only one courier auto-books');
    assert.equal(d.couriers.find((c) => c.key === 'pathao').autoBook, true);
    assert.ok(!JSON.stringify(d).includes('SECRET-xyz-123'), 'keys never leave the server');
    const acct = await s.db.courierAccounts.findOne({ workspace_id: s.ws, courier: 'steadfast' }).lean();
    assert.ok(!acct.credentials.includes('SECRET-xyz-123'));
    assert.deepEqual(JSON.parse(decryptSecret(acct.credentials, s.config.tokenKey)), { api_key: 'k1', secret_key: 'SECRET-xyz-123' });

    assert.equal((await s.call('/settings/couriers/steadfast', { method: 'DELETE', token: s.token })).status, 204);
    assert.equal((await s.call('/settings/delivery', { token: s.token })).body.couriers.find((c) => c.key === 'steadfast').connected, false);
  } finally { await s.close(); }
});

test('the owner invites, changes and removes teammates', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('/settings/team', { method: 'POST', token: s.modToken, body: { name: 'X', email: 'x@shop.test' } })).status, 403);
    const r = await s.call('/settings/team', { method: 'POST', token: s.token, body: { name: 'Mim', email: 'Mim@Shop.test', role: 'agent' } });
    assert.equal(r.status, 201);
    assert.equal(s.adapters.email.sent.at(-1).to, 'mim@shop.test');
    assert.match(s.adapters.email.sent.at(-1).text, new RegExp(r.body.password));
    assert.equal((await s.call('/settings/team', { method: 'POST', token: s.token, body: { name: 'Mim', email: 'mim@shop.test' } })).status, 409);
    const mimToken = await s.login('mim@shop.test', r.body.password);
    assert.ok(mimToken, 'the temporary password works');

    const team = (await s.call('/settings/team', { token: s.token })).body;
    assert.deepEqual(team.members.map((m) => m.role), ['owner', 'moderator', 'moderator', 'agent']);
    const mim = team.members.find((m) => m.email === 'mim@shop.test');
    const owner = team.members.find((m) => m.role === 'owner');
    assert.equal((await s.call(`/settings/team/${owner.id}`, { method: 'PATCH', token: s.token, body: { role: 'agent' } })).status, 403);
    assert.equal((await s.call(`/settings/team/${mim.id}`, { method: 'PATCH', token: s.token, body: { role: 'moderator' } })).status, 200);

    const conv = await s.db.insert(s.db.conversations, { workspace_id: s.ws, channel_id: 1, contact_id: 99, assigned_user_id: mim.id, status: 'open' });
    assert.equal((await s.call(`/settings/team/${mim.id}`, { method: 'PATCH', token: s.token, body: { active: false } })).status, 200);
    assert.equal((await s.db.conversations.findById(conv.id).lean()).assigned_user_id, null, 'their chats go back to the queue');
    assert.equal((await s.call('/settings/team', { token: mimToken })).status, 401, 'their session ends');
  } finally { await s.close(); }
});

test('production refuses to store courier keys without an encryption key', async () => {
  const s = await start({ NODE_ENV: 'production', TOKEN_ENCRYPTION_KEY: '' });
  try {
    const r = await s.call('/settings/couriers/steadfast', { method: 'PUT', token: s.token, body: { credentials: { api_key: 'k', secret_key: 's' } } });
    assert.equal(r.status, 503);
    assert.equal(await s.db.courierAccounts.countDocuments({ workspace_id: s.ws }), 0);
  } finally { await s.close(); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { plansFrom, PLAN_KEYS } from '../src/dashboard/plans.js';

const admin = { authorization: `Basic ${Buffer.from('x:admin-secret').toString('base64')}` };

async function start(env = {}) {
  const ctx = await setup({ env: { DRY_RUN: '1', AI_REPLY_DELAY_MS: '0', ADMIN_TOKEN: 'admin-secret', TOPUP_BKASH_NUMBER: '01711000000', ...env } });
  const adapters = createAdapters({ ADAPTERS: 'fake' });
  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters, clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
    const res = await fetch(`${base}${path.startsWith('/admin') ? '' : '/api/dash'}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const login = async (email) => (await call('/auth/login', { method: 'POST', body: { login: email, password: 'password123' } })).body.token;
  return { ...ctx, adapters, call, owner: await login('owner@shop.test'), mod: await login('nadia@shop.test'), close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

test('plans: prices and included replies come from env; unset means "coming soon"; yearly is 10 months', () => {
  const none = plansFrom({});
  assert.deepEqual(none.map((p) => p.key), PLAN_KEYS);
  assert.ok(none.every((p) => p.monthly === null && p.yearly === null && p.replies === null));
  assert.equal(none.find((p) => p.popular).key, 'growth');
  const set = plansFrom({ PLAN_PRICES: 'starter:999, growth:2499,pro:bad', PLAN_REPLIES: 'starter:1000,growth:4000' });
  const by = Object.fromEntries(set.map((p) => [p.key, p]));
  assert.deepEqual([by.starter.monthly, by.starter.yearly, by.starter.replies], [999, 9990, 1000]);
  assert.deepEqual([by.growth.monthly, by.growth.replies], [2499, 4000]);
  assert.deepEqual([by.pro.monthly, by.pro.replies], [null, null], 'bad values are ignored');
  assert.ok(by.pro.features.includes('brands'));
});

test('plan screen: owners see plan, usage and top-up; upgrade asks the team once a day; HeyQuicky admin sets the plan', async () => {
  const before = { p: process.env.PLAN_PRICES, r: process.env.PLAN_REPLIES };
  process.env.PLAN_PRICES = 'starter:999,growth:2499,pro:5999';
  process.env.PLAN_REPLIES = 'starter:1000,growth:4000,pro:12000';
  const s = await start();
  try {
    assert.equal((await s.call('/settings/plan', { token: s.mod })).status, 403, 'needs billing permission');
    await s.db.insert(s.db.aiReplies, { workspace_id: s.ws, kind: 'reply', cost: 0.5, created_at: new Date() });
    let d = await s.call('/settings/plan', { token: s.owner });
    assert.equal(d.status, 200);
    assert.equal(d.body.current, 'starter');
    assert.deepEqual(d.body.usage, { used: 1, included: 1000 });
    assert.equal(d.body.plans.find((p) => p.key === 'growth').monthly, 2499);
    assert.deepEqual(d.body.topup.amounts.map((a) => a.amount), [500, 1000, 2500, 5000]);
    assert.equal(d.body.topup.methods.bkash, '01711000000');
    assert.equal(d.body.topup.methods.card, false);
    assert.equal(d.body.pays.cost, 0.5);

    assert.equal((await s.call('/settings/plan/request', { method: 'POST', token: s.owner, body: { plan: 'gold' } })).status, 400);
    assert.equal((await s.call('/settings/plan/request', { method: 'POST', token: s.owner, body: { plan: 'starter' } })).status, 409, 'already on it');
    assert.equal((await s.call('/settings/plan/request', { method: 'POST', token: s.mod, body: { plan: 'growth' } })).status, 403);
    const r = await s.call('/settings/plan/request', { method: 'POST', token: s.owner, body: { plan: 'growth', period: 'yearly' } });
    assert.equal(r.status, 200);
    const mail = s.adapters.email.sent.at(-1);
    assert.match(mail.subject, /Plan request: .* → growth \(yearly\)/);
    assert.equal((await s.call('/settings/plan/request', { method: 'POST', token: s.owner, body: { plan: 'growth' } })).status, 429, 'once a day');
    d = await s.call('/settings/plan', { token: s.owner });
    assert.deepEqual([d.body.request.plan, d.body.request.period], ['growth', 'yearly']);

    const list = await s.call('/admin/plan-requests', { headers: admin });
    assert.equal(list.status, 200);
    assert.equal(list.body[0].request.plan, 'growth');
    assert.equal((await s.call(`/admin/workspaces/${s.ws}/plan`, { method: 'POST', body: { plan: 'growth' } })).status, 401);
    assert.equal((await s.call(`/admin/workspaces/${s.ws}/plan`, { method: 'POST', headers: admin, body: { plan: 'gold' } })).status, 400);
    assert.equal((await s.call('/admin/workspaces/9999/plan', { method: 'POST', headers: admin, body: { plan: 'growth' } })).status, 404);
    const set = await s.call(`/admin/workspaces/${s.ws}/plan`, { method: 'POST', headers: admin, body: { plan: 'growth', period: 'yearly' } });
    assert.equal(set.status, 200);
    d = await s.call('/settings/plan', { token: s.owner });
    assert.deepEqual([d.body.current, d.body.period, d.body.request, d.body.usage.included], ['growth', 'yearly', null, 4000]);
    assert.ok(new Date(d.body.renewsAt) > new Date(Date.now() + 300 * 86_400_000), 'yearly renews in a year');
  } finally {
    await s.close();
    for (const [k, v] of [['PLAN_PRICES', before.p], ['PLAN_REPLIES', before.r]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

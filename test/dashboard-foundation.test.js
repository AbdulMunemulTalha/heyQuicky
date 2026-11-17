import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { bdPhone, phoneProblem, taka, dhakaDayStart } from '../src/dashboard/util.js';
import { can, permissionsFor } from '../src/dashboard/permissions.js';
import { runMigrations } from '../src/dashboard/migrations.js';
import { seedNokshi } from '../src/dashboard/demoSeed.js';
import en from '../client/src/dashboard/strings/en.js';
import bn from '../client/src/dashboard/strings/bn.js';

async function start(db, config) {
  const adapters = createAdapters({ ADAPTERS: 'fake' });
  const { server } = createApp(db, config, { aiProvider: null, adapters, clientDir: '/nonexistent' });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${base}/api/dash${path}`, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
  };
  return { server, adapters, call, close: () => new Promise((r) => server.close(r)) };
}

test('Bangladeshi phones are accepted in English or Bangla digits and with +880', () => {
  assert.equal(bdPhone('01712-345678'), '01712345678');
  assert.equal(bdPhone('০১৭১২-৩৪৫৬৭৮'), '01712345678');
  assert.equal(bdPhone('+880 1712 345678'), '01712345678');
  assert.equal(bdPhone('8801712345678'), '01712345678');
  assert.equal(bdPhone('01212345678'), null); // 012 is not a mobile prefix
  assert.equal(bdPhone('0171234567'), null); // 10 digits
  assert.match(phoneProblem('01712-34567'), /11 digits — this one has 10/);
  assert.match(phoneProblem('01112345678'), /013 to 019/);
  assert.equal(phoneProblem('০১৮১৯২২৪৪১০'), null);
});

test('money uses Indian grouping and Dhaka days start at 6 PM UTC', () => {
  assert.equal(taka(145000), '৳1,45,000');
  assert.equal(taka(2222640), '৳22,22,640');
  assert.equal(taka(450), '৳450');
  const start = dhakaDayStart(new Date('2026-11-17T02:00:00Z'));
  assert.equal(start.toISOString(), '2026-11-16T18:00:00.000Z');
});

test('roles follow the Team → Permissions defaults and owner overrides', () => {
  const ws = { settings: {} };
  assert.equal(can({ role: 'owner' }, 'billing', ws), true);
  assert.equal(can({ role: 'admin' }, 'billing', ws), false);
  assert.equal(can({ role: 'admin' }, 'teach_ai', ws), true);
  assert.equal(can({ role: 'moderator' }, 'teach_ai', ws), false);
  assert.equal(can({ role: 'agent' }, 'see_all_chats', ws), false);
  assert.equal(can({ role: 'agent' }, 'cancel_orders', ws), false);
  const custom = { settings: { permissions: { agent: { cancel_orders: true } } } };
  assert.equal(can({ role: 'agent' }, 'cancel_orders', custom), true);
  assert.equal(permissionsFor(custom).agent.reply, true);
});

test('every English dashboard string has a Bangla translation', () => {
  const missing = Object.keys(en).filter((k) => !(k in bn));
  assert.deepEqual(missing, []);
  const placeholders = (s) => (s.match(/\{\w+\}/g) ?? []).sort().join();
  const wrong = Object.keys(en).filter((k) => placeholders(en[k]) !== placeholders(bn[k]));
  assert.deepEqual(wrong, [], 'Bangla strings keep the same {placeholders}');
});

test('log in by email or Bangla-digit phone; wrong passwords are told apart', async () => {
  const { db, config, owner } = await setup();
  await db.users.updateOne({ _id: owner }, { $set: { phone: '01712345678' } });
  const app = await start(db, config);
  try {
    const byEmail = await app.call('/auth/login', { method: 'POST', body: { login: 'OWNER@shop.test', password: 'password123' } });
    assert.equal(byEmail.status, 200);
    assert.ok(byEmail.body.token);
    const byPhone = await app.call('/auth/login', { method: 'POST', body: { login: '০১৭১২-৩৪৫৬৭৮', password: 'password123', remember: false } });
    assert.equal(byPhone.status, 200);
    const session = await db.sessions.findById(byPhone.body.token).lean();
    assert.ok(session.expires_at - Date.now() < 2 * 86_400_000, 'without "keep me logged in" the session lasts a day');
    const wrong = await app.call('/auth/login', { method: 'POST', body: { login: 'owner@shop.test', password: 'nope-nope' } });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.code, 'wrong_password');
    const none = await app.call('/auth/login', { method: 'POST', body: { login: 'who@shop.test', password: 'nope-nope' } });
    assert.equal(none.body.code, 'no_account');
  } finally {
    await app.close();
  }
});

test('forgot password: code by email, verify, set a new password, other devices logged out', async () => {
  const { db, config } = await setup();
  const app = await start(db, config);
  try {
    const old = (await app.call('/auth/login', { method: 'POST', body: { login: 'owner@shop.test', password: 'password123' } })).body.token;
    const forgot = await app.call('/auth/forgot', { method: 'POST', body: { login: 'owner@shop.test' } });
    assert.equal(forgot.status, 200);
    assert.equal(forgot.body.channel, 'email');
    assert.match(forgot.body.sentTo, /^o.*•.*@shop\.test$/);
    const code = app.adapters.email.sent.at(-1).text.match(/\d{6}/)[0];
    const bad = await app.call('/auth/verify-code', { method: 'POST', body: { resetId: forgot.body.resetId, code: '000000' === code ? '111111' : '000000' } });
    assert.equal(bad.status, 400);
    assert.equal((await app.call('/auth/verify-code', { method: 'POST', body: { resetId: forgot.body.resetId, code } })).status, 200);
    const short = await app.call('/auth/reset', { method: 'POST', body: { resetId: forgot.body.resetId, code, password: 'short' } });
    assert.equal(short.status, 400);
    const reset = await app.call('/auth/reset', { method: 'POST', body: { resetId: forgot.body.resetId, code, password: 'new-password-1' } });
    assert.equal(reset.status, 200);
    assert.equal((await app.call('/me', { token: old })).status, 401, 'the old session was logged out');
    assert.equal((await app.call('/me', { token: reset.body.token })).status, 200);
    assert.equal((await app.call('/auth/login', { method: 'POST', body: { login: 'owner@shop.test', password: 'new-password-1' } })).status, 200);
    // Unknown accounts get the same answer, so the form can't be used to find accounts.
    const unknown = await app.call('/auth/forgot', { method: 'POST', body: { login: 'ghost@shop.test' } });
    assert.equal(unknown.status, 200);
    assert.equal(app.adapters.email.sent.length, 1);
  } finally {
    await app.close();
  }
});

test('the shell gets badges and permissions; only owners and admins switch the AI live', async () => {
  const { db, config, mods } = await setup();
  await db.users.updateOne({ _id: mods[0] }, { $set: { role: 'agent' } });
  const app = await start(db, config);
  try {
    const owner = (await app.call('/auth/login', { method: 'POST', body: { login: 'owner@shop.test', password: 'password123' } })).body.token;
    const agent = (await app.call('/auth/login', { method: 'POST', body: { login: 'nadia@shop.test', password: 'password123' } })).body.token;
    const me = await app.call('/me', { token: owner });
    assert.equal(me.status, 200);
    assert.ok(me.body.can.includes('billing'));
    assert.deepEqual(Object.keys(me.body.badges).sort(), ['agent', 'alerts', 'inbox', 'orders']);
    const agentMe = await app.call('/me', { token: agent });
    assert.equal(agentMe.body.can.includes('billing'), false);
    assert.equal((await app.call('/ai-mode', { method: 'POST', token: agent, body: { mode: 'auto' } })).status, 403);
    const live = await app.call('/ai-mode', { method: 'POST', token: owner, body: { mode: 'auto' } });
    assert.equal(live.body.aiMode, 'auto');
    const ws = await db.workspaces.findOne({}).lean();
    assert.ok(ws.went_live_at, 'going live starts the trial clock');
    assert.ok(await db.audit.exists({ action: 'Switched the AI live' }));
    const prefs = await app.call('/prefs', { method: 'PATCH', token: agent, body: { language: 'bn', theme: 'dark' } });
    assert.deepEqual(prefs.body, { language: 'bn', theme: 'dark' });
  } finally {
    await app.close();
  }
});

test('the overview adds up the seeded Nokshi Threads shop', async () => {
  const db = await freshDb();
  await runMigrations(db);
  await runMigrations(db); // runs once only
  assert.equal(await db.migrations.countDocuments(), 3);
  const { workspaceId } = await seedNokshi(db);
  const config = (await import('../src/config.js')).loadConfig({});
  const app = await start(db, config);
  try {
    const token = (await app.call('/auth/login', { method: 'POST', body: { login: 'talha@nokshithreads.com', password: 'password123' } })).body.token;
    const { status, body } = await app.call('/overview', { token });
    assert.equal(status, 200);
    assert.equal(body.kpis.needsPerson, 3);
    assert.equal(body.week.length, 7);
    assert.ok(body.attention.some((a) => a.kind === 'act_now'));
    assert.ok(body.attention.some((a) => a.kind === 'payment' && a.count === 3));
    assert.equal(body.pipeline.pending + body.pipeline.on_hold, 2);
    assert.equal(body.checklist.find((c) => c.key === 'products').count, 9);
    const me = await app.call('/me', { token });
    assert.equal(me.body.workspace.credit, 412.5);
    assert.equal(me.body.workspace.id, workspaceId);
    assert.equal(me.body.badges.inbox, 3);
  } finally {
    await app.close();
  }
});

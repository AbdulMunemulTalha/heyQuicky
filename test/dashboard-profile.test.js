import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';

async function start() {
  const ctx = await setup({ env: { DRY_RUN: '1', AI_REPLY_DELAY_MS: '0' } });
  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const root = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token, ua } = {}) => {
    const res = await fetch(`${root}/api/dash${path}`, { method, headers: { 'content-type': 'application/json', ...(ua ? { 'user-agent': ua } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
  };
  const login = async (email, password = 'password123', ua) => (await call('/auth/login', { method: 'POST', ua, body: { login: email, password } })).body?.token;
  return { ...ctx, app, call, login, close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

test('profile: edit your own details; changing the login email needs your password; phone must be Bangladeshi', async () => {
  const s = await start();
  try {
    const token = await s.login('owner@shop.test');
    const p = await s.call('/profile', { token });
    assert.equal(p.status, 200);
    assert.equal(p.body.email, 'owner@shop.test');
    assert.equal(p.body.sessions.filter((x) => x.current).length, 1);
    assert.ok(p.body.sessions.every((x) => x.id.length === 16), 'sessions are listed by a hash, never the token');
    assert.ok(p.body.notifications.order);

    assert.equal((await s.call('/profile', { method: 'PATCH', token, body: { name: 'Talha', displayName: 'Talha from Nokshi', phone: '০১৭১২৩৪৫৬৭৮' } })).status, 200);
    let me = await s.db.users.findOne({ email: 'owner@shop.test' }).lean();
    assert.deepEqual([me.name, me.display_name, me.phone], ['Talha', 'Talha from Nokshi', '01712345678']);
    assert.equal((await s.call('/profile', { method: 'PATCH', token, body: { phone: '12345' } })).status, 400);
    assert.equal((await s.call('/profile', { method: 'PATCH', token, body: { name: '  ' } })).status, 400);

    const noPw = await s.call('/profile', { method: 'PATCH', token, body: { email: 'talha@shop.test' } });
    assert.deepEqual([noPw.status, noPw.body.code], [403, 'password_needed']);
    assert.equal((await s.call('/profile', { method: 'PATCH', token, body: { email: 'nadia@shop.test', password: 'password123' } })).status, 409, 'an email someone else uses');
    assert.equal((await s.call('/profile', { method: 'PATCH', token, body: { email: 'Talha@Shop.test', password: 'password123' } })).status, 200);
    me = await s.db.users.findById(me._id).lean();
    assert.equal(me.email, 'talha@shop.test');
    assert.equal((await s.call('/profile', { method: 'PATCH', token, body: { avatar: 'javascript:alert(1)' } })).status, 400);
  } finally { await s.close(); }
});

test('password change and devices: other devices are logged out; one device can be logged out by its id', async () => {
  const s = await start();
  try {
    const here = await s.login('owner@shop.test', 'password123', 'Mozilla/5.0 (Windows NT 10.0) Chrome/120');
    const phone = await s.login('owner@shop.test', 'password123', 'Mozilla/5.0 (Linux; Android 14) Chrome/120');
    const mac = await s.login('owner@shop.test', 'password123', 'Mozilla/5.0 (Macintosh; Mac OS X 14) Safari/605');
    let p = (await s.call('/profile', { token: here })).body;
    assert.deepEqual(p.sessions.map((x) => x.device).sort(), ['Chrome on Android', 'Chrome on Windows', 'Safari on Mac']);

    const macRow = p.sessions.find((x) => x.device === 'Safari on Mac');
    assert.equal((await s.call(`/profile/sessions/${macRow.id}`, { method: 'DELETE', token: here })).status, 200);
    assert.equal((await s.call('/me', { token: mac })).status, 401, 'that device is logged out');
    const self = p.sessions.find((x) => x.current);
    assert.equal((await s.call(`/profile/sessions/${self.id}`, { method: 'DELETE', token: here })).status, 400);

    assert.equal((await s.call('/profile/password', { method: 'POST', token: here, body: { current: 'wrong', next: 'newpass123' } })).status, 403);
    assert.equal((await s.call('/profile/password', { method: 'POST', token: here, body: { current: 'password123', next: 'short' } })).status, 400);
    const changed = await s.call('/profile/password', { method: 'POST', token: here, body: { current: 'password123', next: 'newpass123' } });
    assert.deepEqual([changed.status, changed.body.loggedOut], [200, 1]);
    assert.equal((await s.call('/me', { token: phone })).status, 401);
    assert.equal((await s.call('/me', { token: here })).status, 200, 'this device stays logged in');
    assert.ok(await s.login('owner@shop.test', 'newpass123'));
    p = (await s.call('/profile', { token: here })).body;
    assert.ok(new Date(p.passwordChangedAt) > new Date(Date.now() - 60_000));

    await s.login('owner@shop.test', 'newpass123');
    assert.equal((await s.call('/profile/sessions/logout-others', { method: 'POST', token: here })).body.loggedOut, 2);
  } finally { await s.close(); }
});

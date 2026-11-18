import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';

async function start(env = { DRY_RUN: '1' }) {
  const ctx = await setup({ env });
  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const root = `http://127.0.0.1:${app.server.address().port}/api/dash`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${root}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const login = async (email) => (await call('/auth/login', { method: 'POST', body: { login: email, password: 'password123' } })).body.token;
  return { ...ctx, call, token: await login('owner@shop.test'), modToken: await login('nadia@shop.test'), close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

test('/me tells the shell which problems to show on every page', async () => {
  const s = await start({});
  try {
    await s.db.channels.updateOne({ workspace_id: s.ws, platform: 'messenger' }, { $set: { needs_reconnect: true } });
    await s.db.insert(s.db.courierAccounts, { workspace_id: s.ws, courier: 'steadfast', connected: true, credentials: '' });
    const me = (await s.call('/me', { token: s.token })).body;
    assert.equal(me.workspace.channels.find((c) => c.platform === 'messenger').needsReconnect, true);
    assert.deepEqual(me.workspace.couriersNeedKeys, ['steadfast']);
    assert.equal(me.workspace.creditEnforced, false, 'no "AI paused" banner until per-reply charging exists');
  } finally { await s.close(); }
});

test('test mode does not nag about courier keys', async () => {
  const s = await start({ DRY_RUN: '1' });
  try {
    await s.db.insert(s.db.courierAccounts, { workspace_id: s.ws, courier: 'pathao', connected: true, credentials: '' });
    assert.deepEqual((await s.call('/me', { token: s.token })).body.workspace.couriersNeedKeys, []);
  } finally { await s.close(); }
});

test('"Ask for access" notifies the owner once an hour', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('/settings/billing', { token: s.modToken })).status, 403);
    const r = await s.call('/access-requests', { method: 'POST', token: s.modToken, body: { what: 'billing', path: '/settings' } });
    assert.equal(r.status, 200);
    await s.call('/access-requests', { method: 'POST', token: s.modToken, body: { what: 'billing', path: '/settings' } });
    const notes = await s.db.notifications.find({ user_id: s.owner, type: 'access' }).lean();
    assert.equal(notes.length, 1);
    assert.match(notes[0].title, /Nadia asked for access/);
    assert.equal(notes[0].link, '/settings/team');
    assert.equal(await s.db.notifications.countDocuments({ user_id: s.mods[0] }), 0);
  } finally { await s.close(); }
});

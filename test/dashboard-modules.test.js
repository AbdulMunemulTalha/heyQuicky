import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { openTicket } from '../src/dashboard/tickets.js';
import { recommendedFor } from '../src/dashboard/settings.js';

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

test('modules: switch sections on and off, business type and "use recommended"; always-on and not-built ones stay put', async () => {
  assert.deepEqual(recommendedFor('salon'), ['bookings', 'payments', 'growth', 'tickets']);
  assert.ok(recommendedFor('fashion').includes('courier'), 'older names map onto the new ones');
  const s = await start();
  try {
    const page = await s.call('/settings/modules', { token: s.owner });
    assert.equal(page.status, 200);
    assert.equal(page.body.modules.length, 12);
    assert.equal(page.body.modules.find((m) => m.key === 'inbox').always, true);
    assert.ok(!page.body.modules.find((m) => m.key === 'content').notBuilt, 'the content studio is built now');
    assert.ok(!page.body.modules.find((m) => m.key === 'bookings').notBuilt, 'bookings is built now');

    assert.equal((await s.call('/settings/modules', { method: 'PATCH', token: s.mod, body: { modules: { coupons: false } } })).status, 403);
    assert.equal((await s.call('/settings/modules', { method: 'PATCH', token: s.owner, body: { modules: { inbox: false } } })).status, 400);
    assert.equal((await s.call('/settings/modules', { method: 'PATCH', token: s.owner, body: { modules: { content: false } } })).status, 200);
    const off = await s.call('/settings/modules', { method: 'PATCH', token: s.owner, body: { modules: { coupons: false, tickets: false } } });
    assert.equal(off.body.modules.find((m) => m.key === 'coupons').on, false);
    assert.equal(off.body.matchesRecommended, false);
    const me = await s.call('/me', { token: s.owner });
    assert.deepEqual([me.body.workspace.modules.coupons, me.body.workspace.modules.tickets], [false, false]);

    // Tickets off: the AI doesn't open one; the team still can.
    const r = await openTicket(s.db, { workspaceId: s.ws, title: 'Damaged', by: 'AI' });
    assert.equal(r.ticket, null);
    assert.ok((await openTicket(s.db, { workspaceId: s.ws, title: 'By hand', by: 'Talha' })).ticket);

    const salon = await s.call('/settings/modules', { method: 'PATCH', token: s.owner, body: { businessType: 'salon', useRecommended: true } });
    assert.equal(salon.body.businessType, 'salon');
    const on = Object.fromEntries(salon.body.modules.map((m) => [m.key, m.on]));
    assert.deepEqual([on.courier, on.catalog, on.coupons, on.payments, on.tickets, on.bookings], [false, false, false, true, true, true], 'salons get bookings');
    assert.equal(salon.body.matchesRecommended, true);
    assert.equal((await s.call('/settings/modules', { method: 'PATCH', token: s.owner, body: { businessType: 'spaceship' } })).status, 400);
  } finally { await s.close(); }
});

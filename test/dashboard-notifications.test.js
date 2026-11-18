import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { notify, prefsFor, inQuietHours } from '../src/dashboard/notify.js';

async function start() {
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  const adapters = createAdapters({ ADAPTERS: 'fake', VAPID_PUBLIC_KEY: 'BPublicKeyForTests' });
  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters, clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const root = `http://127.0.0.1:${app.server.address().port}/api/dash`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${root}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
  };
  const login = async (email) => (await call('/auth/login', { method: 'POST', body: { login: email, password: 'password123' } })).body.token;
  return { ...ctx, app, adapters, call, token: await login('owner@shop.test'), modToken: await login('nadia@shop.test'), close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}
const daytime = new Date('2026-11-18T06:00:00Z'); // 12 PM in Dhaka
const night = new Date('2026-11-18T20:00:00Z'); // 2 AM in Dhaka

test('quiet hours and default preferences follow the design', () => {
  assert.equal(inQuietHours(night), true);
  assert.equal(inQuietHours(daytime), false);
  const p = prefsFor(null);
  assert.deepEqual(p.events.order, { app: true, phone: true, whatsapp: true });
  assert.deepEqual(p.events.mention, { app: true, phone: false, whatsapp: false });
  assert.equal(p.quiet, true);
  assert.equal(prefsFor({ notify_prefs: { events: { order: { phone: false } } } }).events.order.phone, false);
});

test('events reach the right people, in the app and on their phones, without repeats', async () => {
  const s = await start();
  try {
    const emits = [];
    const emit = (...a) => emits.push(a);
    await s.db.insert(s.db.pushSubscriptions, { user_id: s.owner, workspace_id: s.ws, endpoint: 'https://push.example/owner', keys: { p256dh: 'p', auth: 'a' } });

    // A new order goes to owner/admins only — not moderators.
    await notify(s.db, emit, s.adapters, { workspaceId: s.ws, event: 'order', title: 'New order #1', ref: 'order:1', now: daytime });
    assert.equal(await s.db.notifications.countDocuments({ user_id: s.owner, type: 'order' }), 1);
    assert.equal(await s.db.notifications.countDocuments({ user_id: s.mods[0] }), 0);
    assert.equal(s.adapters.push.sent.length, 1, 'phone alert sent');
    assert.equal(emits[0][1], 'notification');

    await notify(s.db, emit, s.adapters, { workspaceId: s.ws, event: 'order', title: 'New order #1', ref: 'order:1', now: daytime });
    assert.equal(await s.db.notifications.countDocuments({ user_id: s.owner, type: 'order' }), 1, 'same ref is not repeated');

    // Quiet hours: no phone alert at 2 AM, except a big order.
    await notify(s.db, emit, s.adapters, { workspaceId: s.ws, event: 'order', title: 'Small', ref: 'order:2', amount: 900, now: night });
    assert.equal(s.adapters.push.sent.length, 1);
    await notify(s.db, emit, s.adapters, { workspaceId: s.ws, event: 'order', title: 'Big', ref: 'order:3', amount: 15000, now: night });
    assert.equal(s.adapters.push.sent.length, 2);

    // Handoffs reach moderators too; a person who switched the app off for it gets nothing in the app.
    await s.db.users.updateOne({ _id: s.mods[1] }, { $set: { notify_prefs: { events: { handoff: { app: false } } } } });
    await notify(s.db, emit, s.adapters, { workspaceId: s.ws, event: 'handoff', title: 'Rakib needs a person.', link: '/inbox/1', now: daytime });
    assert.equal(await s.db.notifications.countDocuments({ type: 'handoff' }), 2, 'owner + one moderator');
    assert.equal(await s.db.notifications.countDocuments({ user_id: s.mods[1], type: 'handoff' }), 0);
  } finally { await s.close(); }
});

test('the panel lists, filters, reads and dismisses; preferences and phone devices save', async () => {
  const s = await start();
  try {
    const emit = () => {};
    await notify(s.db, emit, s.adapters, { workspaceId: s.ws, event: 'order', title: 'New order #7', link: '/orders/7', now: daytime });
    await notify(s.db, emit, s.adapters, { workspaceId: s.ws, event: 'stock', title: 'Low stock: Kurti L', link: '/catalog/1', now: daytime });
    let d = (await s.call('/notifications', { token: s.token })).body;
    assert.equal(d.unread, 2);
    assert.deepEqual(d.byCategory, { orders: 1, system: 1 });
    assert.deepEqual((await s.call('/notifications?category=system', { token: s.token })).body.items.map((n) => n.title), ['Low stock: Kurti L']);
    assert.equal((await s.call('/badges', { token: s.token })).body.alerts, 2);

    const order = d.items.find((n) => n.type === 'order');
    assert.equal((await s.call(`/notifications/${order.id}/dismiss`, { method: 'POST', token: s.modToken })).status, 404, 'not theirs');
    assert.equal((await s.call(`/notifications/${order.id}/dismiss`, { method: 'POST', token: s.token })).status, 200);
    assert.equal((await s.call('/notifications/read-all', { method: 'POST', token: s.token })).body.updated, 1);
    d = (await s.call('/notifications', { token: s.token })).body;
    assert.equal(d.unread, 0);
    assert.equal(d.items.length, 1);

    assert.equal((await s.call('/notifications/prefs', { method: 'PATCH', token: s.token, body: { events: { nope: { app: true } } } })).status, 400);
    assert.equal((await s.call('/notifications/prefs', { method: 'PATCH', token: s.token, body: { events: { stock: { phone: false } }, quiet: false } })).status, 200);
    const p = (await s.call('/notifications/prefs', { token: s.token })).body;
    assert.equal(p.events.find((e) => e.key === 'stock').phone, false);
    assert.equal(p.events.find((e) => e.key === 'stock').app, true, 'other channels keep their defaults');
    assert.equal(p.quiet, false);
    assert.equal(p.push.publicKey, 'BPublicKeyForTests');

    assert.equal((await s.call('/notifications/push', { method: 'POST', token: s.token, body: { endpoint: 'http://insecure', keys: { p256dh: 'p', auth: 'a' } } })).status, 400);
    const sub = await s.call('/notifications/push', { method: 'POST', token: s.token, body: { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } } });
    assert.equal(sub.body.devices, 1);
    assert.equal((await s.call('/notifications/push/test', { method: 'POST', token: s.token })).body.sent, 1);
    assert.equal((await s.call('/notifications/push', { method: 'DELETE', token: s.token, body: { endpoint: 'https://push.example/abc' } })).body.devices, 0);
  } finally { await s.close(); }
});

test('real events: a new order and a sold-out size notify the owner, not the person who made it', async () => {
  const s = await start();
  try {
    const product = await s.db.insert(s.db.products, { workspace_id: s.ws, name: 'Kurti', price: 1000, options: [{ name: 'Size', values: ['L'] }],
      variant_list: [{ sku: 'K-L', options: { Size: 'L' }, price: 1000, stock: 1 }] });
    const body = { phone: '01755-123456', name: 'Nusrat Jahan', address: 'House 9, Road 2', district: 'Dhaka', thana: 'Mirpur', zone: 'inside_dhaka',
      items: [{ productId: product.id, sku: 'K-L', qty: 1 }], payment: { method: 'cod' } };
    const r = await s.call('/orders', { method: 'POST', token: s.modToken, body });
    assert.equal(r.status, 201);
    const owner = await s.db.notifications.find({ user_id: s.owner }).lean();
    assert.ok(owner.some((n) => n.type === 'order' && /New order #/.test(n.title)), 'owner hears about the order');
    assert.ok(owner.some((n) => n.type === 'stock' && /Kurti L/.test(n.title)), 'owner hears the size sold out');
    assert.equal(await s.db.notifications.countDocuments({ user_id: s.mods[0], type: 'order' }), 0, 'not the moderator who made it');
  } finally { await s.close(); }
});

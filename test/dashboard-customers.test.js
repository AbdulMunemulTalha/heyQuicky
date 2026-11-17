import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { loadConfig } from '../src/config.js';
import { runMigrations } from '../src/dashboard/migrations.js';
import { seedNokshi } from '../src/dashboard/demoSeed.js';
import { hashPassword } from '../src/auth.js';

async function start() {
  const db = await freshDb();
  await runMigrations(db);
  await seedNokshi(db);
  const app = createApp(db, loadConfig({ DRY_RUN: '1' }), { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}/api/dash`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* csv */ }
    return { status: res.status, body: json, text };
  };
  const login = async (email) => (await call('/auth/login', { method: 'POST', body: { login: email, password: 'password123' } })).body.token;
  return { db, call, login, close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

test('customers list filters by repeat, VIP, high risk and search', async () => {
  const s = await start();
  try {
    const token = await s.login('talha@nokshithreads.com');
    const all = await s.call('/customers', { token });
    assert.equal(all.status, 200);
    assert.ok(!all.body.items.some((c) => c.name === 'Earn Money BD'), 'blocked spam is not listed');
    const sadia = all.body.items.find((c) => c.name === 'Sadia Rahman');
    assert.deepEqual([sadia.orders, sadia.delivered], [4, 100]);
    assert.ok(sadia.tags.includes('VIP'));
    const repeat = await s.call('/customers?filter=repeat', { token });
    assert.ok(repeat.body.items.every((c) => c.orders >= 2));
    const vip = await s.call('/customers?filter=vip', { token });
    assert.deepEqual(vip.body.items.map((c) => c.name).sort(), ['Rafiq Uddin', 'Sadia Rahman']);
    const risky = await s.call('/customers?filter=high_risk', { token });
    assert.ok(risky.body.items.some((c) => c.name === 'Shirin Akter'));
    const byPhone = await s.call(`/customers?q=${encodeURIComponent('০১৯৩৪')}`, { token });
    assert.deepEqual(byPhone.body.items.map((c) => c.name), ['Shirin Akter']);
    const csv = await s.call('/customers.csv', { token });
    assert.match(csv.text, /name,phones,orders/);
  } finally {
    await s.close();
  }
});

test('a customer profile merges chats, comments and orders; notes and tags save', async () => {
  const s = await start();
  try {
    const token = await s.login('talha@nokshithreads.com');
    const sadia = await s.db.customers.findOne({ name: 'Sadia Rahman' }).lean();
    const p = await s.call(`/customers/${sadia._id}`, { token });
    assert.equal(p.status, 200);
    const kinds = new Set(p.body.timeline.map((e) => e.kind));
    assert.ok(kinds.has('message') && kinds.has('order') && kinds.has('comment'), 'timeline covers every channel');
    assert.ok(p.body.check, 'courier record is attached');
    assert.equal(p.body.notes[0].text, 'VIP — call before 6 pm. Prefers bKash.');
    assert.ok(p.body.conversationId);
    assert.equal((await s.call(`/customers/${sadia._id}/tags`, { method: 'POST', token, body: { tag: 'Wholesale' } })).body.tags.includes('Wholesale'), true);
    assert.equal((await s.call(`/customers/${sadia._id}/notes`, { method: 'POST', token, body: { text: 'Prefers evening delivery' } })).status, 201);
    assert.equal((await s.call(`/customers/${sadia._id}`, { method: 'PATCH', token, body: { addPhone: '০১৮১৯-০০০১২৩' } })).status, 200);
    assert.ok((await s.db.customers.findById(sadia._id).lean()).phones.includes('01819000123'));
    assert.equal((await s.call('/customers/999999', { token })).status, 404);
  } finally {
    await s.close();
  }
});

test('phone numbers are masked for roles that may not see them', async () => {
  const s = await start();
  try {
    const ws = await s.db.workspaces.findOne({}).lean();
    await s.db.workspaces.updateOne({ _id: ws._id }, { $set: { 'settings.permissions.agent.see_phones': false } });
    await s.db.users.updateOne({ email: 'mim@nokshithreads.com' }, { $set: { password_hash: hashPassword('password123') } });
    const agent = await s.login('mim@nokshithreads.com');
    const list = await s.call('/customers', { token: agent });
    const withPhone = list.body.items.find((c) => c.phone);
    assert.match(withPhone.phone, /•/);
  } finally {
    await s.close();
  }
});

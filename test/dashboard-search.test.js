import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';

async function start() {
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const root = `http://127.0.0.1:${app.server.address().port}/api/dash`;
  const login = async (email) => (await (await fetch(`${root}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: email, password: 'password123' }) })).json()).token;
  const search = async (token, q, type) => {
    const res = await fetch(`${root}/search?q=${encodeURIComponent(q)}${type ? `&type=${type}` : ''}`, { headers: { authorization: `Bearer ${token}` } });
    return res.json();
  };
  return { ...ctx, search, login, close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

async function seed(s) {
  const { db, ws } = s;
  const channel = await db.channels.findOne({ workspace_id: ws, platform: 'messenger' }).lean();
  const chat = async (name, text, extra = {}) => {
    const contact = await db.insert(db.contacts, { workspace_id: ws, channel_id: channel._id, external_id: name, name });
    const conv = await db.insert(db.conversations, { workspace_id: ws, channel_id: channel._id, contact_id: contact.id, last_message_preview: text, last_message_at: new Date(), ...extra });
    await db.insert(db.messages, { conversation_id: conv.id, direction: 'in', text, created_at: new Date() });
    return conv;
  };
  const sadia = await chat('Sadia Rahman', 'আমার ঠিকানা মিরপুর ১০');
  const other = await chat('Karim', 'apu Sadia er moto same design ta chai');
  const hidden = await chat('Rumana', 'secret sadia order', { assigned_user_id: s.mods[1] });
  await chat('Spammer', 'sadia sadia', { spam: true });
  await db.insert(db.orders, { workspace_id: ws, number: 1051, customer_name: 'Sadia Rahman', phone: '01712345678', address: 'x', area: 'inside_dhaka', cod_amount: 2220,
    subtotal: 2150, delivery_charge: 70, discount: 0, status: 'delivered', product_items: [{ name: 'Nokshi Three-Piece', variant: 'L', qty: 1, price: 2150 }] });
  await db.insert(db.orders, { workspace_id: ws, number: 1052, customer_name: 'Draft person', phone: '01800000000', address: 'x', area: 'inside_dhaka', cod_amount: 0, subtotal: 0, delivery_charge: 0, discount: 0, draft: true });
  await db.insert(db.customers, { workspace_id: ws, name: 'Sadia Rahman', phones: ['01712345678'], vip: true, area: 'Dhanmondi', stats: { orders: 4, delivered: 4, returned: 0 } });
  await db.insert(db.products, { workspace_id: ws, name: 'Nokshi Three-Piece', code: 'NT-104', price: 2150 });
  await db.insert(db.products, { workspace_id: ws, name: 'Old Nokshi', price: 100, archived: true });
  return { sadia, other, hidden };
}

test('search finds chats by name and by words inside messages, plus orders, customers and products', async () => {
  const s = await start();
  try {
    const { sadia, other } = await seed(s);
    const token = await s.login('owner@shop.test');
    const r = await s.search(token, 'sadia');
    assert.deepEqual(r.chats.map((c) => c.id).sort(), [sadia.id, other.id, r.chats.find((c) => c.name === 'Rumana').id].sort(), 'owner sees every chat, never spam');
    const byText = r.chats.find((c) => c.id === other.id);
    assert.equal(byText.matchedText, true);
    assert.match(byText.text, /Sadia er moto/);
    assert.deepEqual(r.orders.map((o) => o.number), [1051]);
    assert.equal(r.orders[0].total, 2220);
    assert.match(r.orders[0].items, /Nokshi Three-Piece \(L\)/);
    assert.equal(r.customers[0].deliveredPct, 100);
    assert.equal(r.customers[0].phone, '01712345678');

    assert.deepEqual((await s.search(token, '#1051')).orders.map((o) => o.number), [1051]);
    assert.deepEqual((await s.search(token, '০১৭১২-৩৪৫')).orders.map((o) => o.number), [1051], 'Bangla digits and dashes match the phone');
    assert.deepEqual((await s.search(token, '+8801712345678')).customers.map((c) => c.name), ['Sadia Rahman']);
    assert.deepEqual((await s.search(token, 'Draft')).orders, [], 'drafts are not listed');
    assert.deepEqual((await s.search(token, 'nokshi', 'products')).products.map((p) => p.code), ['NT-104'], 'archived products are left out');
    const onlyOrders = await s.search(token, 'sadia', 'orders');
    assert.equal(onlyOrders.chats.length, 0);
    assert.equal(onlyOrders.orders.length, 1);
    assert.deepEqual((await s.search(token, 's')).chats, [], 'one letter is too short');
  } finally { await s.close(); }
});

test('search respects who can see chats and phone numbers', async () => {
  const s = await start();
  try {
    const { hidden } = await seed(s);
    const agentId = (await s.db.insert(s.db.users, { workspace_id: s.ws, name: 'Mim', email: 'mim@shop.test', password_hash: (await s.db.users.findById(s.owner).lean()).password_hash, role: 'agent' })).id;
    assert.ok(agentId);
    const token = await s.login('mim@shop.test');
    const r = await s.search(token, 'sadia');
    assert.ok(!r.chats.some((c) => c.id === hidden.id), "an agent doesn't see a teammate's chat");
    const ws = await s.db.workspaces.findById(s.ws).lean();
    await s.db.workspaces.updateOne({ _id: ws._id }, { $set: { 'settings.permissions.agent.see_phones': false } });
    const masked = await s.search(token, 'sadia', 'customers');
    assert.equal(masked.customers[0].phone, '017••••678');
  } finally { await s.close(); }
});

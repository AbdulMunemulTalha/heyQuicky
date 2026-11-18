import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, freshDb } from './helpers.js';
import { seedNokshi } from '../src/dashboard/demoSeed.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { analytics } from '../src/routes/dashboard/analytics.js';

const daysAgo = (n, hourUtc = 6) => { const d = new Date(Date.now() - n * 86_400_000); d.setUTCHours(hourUtc, 0, 0, 0); return d; };

async function seed(s) {
  const { db, ws } = s;
  const owner = await db.users.findById(s.owner).lean();
  const order = (over) => db.insert(db.orders, { workspace_id: ws, customer_name: 'C', phone: '01712345678', address: 'x', area: 'inside_dhaka', cod_amount: 1100, subtotal: 1000, delivery_charge: 100, discount: 0, items: [], ...over });
  const item = (name, qty = 1) => ({ product_id: name === 'Kurti' ? 1 : 2, name, qty, price: 1000 });
  // This period: 3 AI orders (2 delivered, 1 returned), 1 owner order, 1 product-page order, 2 cancelled.
  await order({ source: 'ai', status: 'delivered', courier: 'Steadfast', product_items: [item('Kurti', 2)], created_at: daysAgo(2) });
  await order({ source: 'ai', status: 'delivered', courier: 'Steadfast', advance: { amount: 200, verified: true }, product_items: [item('Kurti')], created_at: daysAgo(3) });
  await order({ source: 'ai', status: 'returned', courier: 'Pathao', product_items: [item('Saree')], created_at: daysAgo(4) });
  await order({ source: 'team', created_by_user_id: owner._id, status: 'pending', product_items: [item('Saree')], created_at: daysAgo(1) });
  await order({ source: 'product_page', status: 'approved', created_at: daysAgo(1) });
  await order({ source: 'ai', status: 'cancelled', cancel_reason: 'fake_order', created_at: daysAgo(2) });
  await order({ source: 'ai', status: 'cancelled', cancel_reason: 'customer_cancelled', created_at: daysAgo(2) });
  await order({ source: 'ai', status: 'delivered', draft: true, created_at: daysAgo(2) }); // drafts never count
  // Previous 7 days: one order worth ৳2,200.
  await order({ source: 'ai', status: 'delivered', subtotal: 2100, created_at: daysAgo(10) });
  await db.insert(db.aiReplies, { workspace_id: ws, kind: 'reply', cost: 2, created_at: daysAgo(1) });

  // Messages: 15:30 UTC Friday-ish → 21:30 Dhaka (late night), plus one at 04:00 UTC → 10:00 Dhaka.
  const channel = await db.channels.findOne({ workspace_id: ws }).lean();
  const contact = await db.insert(db.contacts, { workspace_id: ws, channel_id: channel._id, external_id: 'c1', name: 'C' });
  const conv = await db.insert(db.conversations, { workspace_id: ws, channel_id: channel._id, contact_id: contact.id });
  const at = (d, h, m = 0) => { const x = daysAgo(d, h); x.setUTCMinutes(m); return x; };
  await db.insert(db.messages, { conversation_id: conv.id, direction: 'in', text: 'hi', created_at: at(1, 15, 30) });
  await db.insert(db.messages, { conversation_id: conv.id, direction: 'out', text: 'hello', sent_by_ai: true, created_at: at(1, 15, 31) });
  const contact2 = await db.insert(db.contacts, { workspace_id: ws, channel_id: channel._id, external_id: 'c2', name: 'D' });
  const other = await db.insert(db.conversations, { workspace_id: ws, channel_id: channel._id, contact_id: contact2.id });
  await db.insert(db.messages, { conversation_id: other.id, direction: 'in', text: 'price?', created_at: at(1, 4) });
  await db.insert(db.prospects, { workspace_id: ws, name: 'L', stage: 'new' });
  await db.insert(db.prospects, { workspace_id: ws, name: 'W', stage: 'won' });
  return { owner, at };
}

test('analytics adds up orders, sources, cancels, couriers, sellers and message hours', async () => {
  const s = await setup();
  const { at } = await seed(s);
  const a = await analytics(s.db, s.ws, 7);
  const k = a.kpis;
  assert.equal(k.orders, 5, 'cancelled and drafts are left out');
  assert.equal(k.ordersByAi, 3);
  assert.equal(k.revenue, 5 * 1100);
  assert.equal(k.revenueChange, 150, '৳5,500 vs ৳2,200 the week before');
  assert.equal(k.revenuePerTaka, Math.round(3300 / 2), 'AI revenue per ৳ of AI spend');
  assert.equal(k.deliveredPct, 66.7, '2 delivered of 3 that finished');
  assert.equal(k.returnsPct, 20);
  assert.equal(k.aiOnly, 1);
  assert.equal(k.firstReplySec, 60);

  assert.deepEqual(a.who.map((w) => [w.key, w.name, w.orders]), [['ai', '', 3], ['product_page', '', 1], ['user', 'Owner', 1]]);
  assert.equal(a.who[0].deliveredRate, 66.7);
  assert.deepEqual(a.cancelled.reasons.map((r) => [r.reason, r.pct]), [['customer_cancelled', 50], ['fake_order', 50]]);
  assert.deepEqual(a.couriers.map((c) => [c.courier, c.booked, c.deliveredRate, c.cod]), [['steadfast', 2, 100, 2200 - 200], ['pathao', 1, 0, 0]]);
  assert.deepEqual(a.bestSellers.map((b) => [b.name, b.units]), [['Kurti', 3], ['Saree', 2]]);
  assert.equal(a.interested, 1);

  // Heatmap rows start on Saturday; 15:30 UTC is 21:30 in Dhaka.
  const late = at(1, 15, 30);
  const dhakaDow = new Date(late.getTime() + 6 * 3_600_000).getUTCDay(); // 0 = Sunday
  const row = (dhakaDow + 1) % 7;
  assert.equal(a.heat.grid[row][21], 1);
  assert.equal(a.heat.total, 2);
  assert.equal(a.heat.lateNightPct, 50);
});

test('the analytics API checks the range and exports a CSV', async () => {
  const s = await setup({ env: { DRY_RUN: '1' } });
  await seed(s);
  const app = createApp(s.db, s.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const root = `http://127.0.0.1:${app.server.address().port}/api/dash`;
  try {
    const token = (await (await fetch(`${root}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'owner@shop.test', password: 'password123' }) })).json()).token;
    const get = (p) => fetch(`${root}${p}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await fetch(`${root}/analytics`)).status, 401);
    assert.equal((await (await get('/analytics?range=7')).json()).range, 7);
    assert.equal((await (await get('/analytics?range=999')).json()).range, 30, 'unknown ranges fall back to 30 days');
    const res = await get('/analytics.csv?range=7');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /heyquicky-analytics-7d\.csv/);
    const text = await res.text();
    assert.match(text, /summary,orders,5,3 by AI/);
    assert.match(text, /cancel reasons,fake_order,1,50%/);
    assert.equal(text.split('\n').filter((l) => l.startsWith('messages by hour')).length, 7 * 24);
  } finally { await new Promise((r) => { app.io.close(); app.server.close(r); }); }
});

test('the demo history fills Analytics without touching the open Inbox', async () => {
  const plain = await freshDb();
  const a = await seedNokshi(plain);
  const withHistory = await freshDb();
  const b = await seedNokshi(withHistory, { history: true });
  const open = (db, ws) => db.conversations.countDocuments({ workspace_id: ws, status: 'open' });
  assert.equal(await open(withHistory, b.workspaceId), await open(plain, a.workspaceId), 'history chats are all closed');
  const month = await analytics(withHistory, b.workspaceId, 30);
  assert.ok(month.kpis.orders >= 30, `a month of orders (${month.kpis.orders})`);
  assert.ok(month.heat.total > 100);
  assert.ok(month.who.length >= 3);
  assert.equal(new Set(month.who.map((w) => w.key + w.name)).size, month.who.length, 'each teammate appears once');
});

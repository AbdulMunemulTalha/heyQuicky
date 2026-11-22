import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, inbound } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { createInbox } from '../src/inbox.js';
import { createPostbackHandler } from '../src/dashboard/postbacks.js';
import { createDeliveryUpdater, deliverySettings, fillMessage, stepCard } from '../src/dashboard/deliveryUpdates.js';
import { toPlatform } from '../src/platforms/rich.js';

async function start() {
  const ctx = await setup({ env: { DRY_RUN: '1', AI_REPLY_DELAY_MS: '0', PUBLIC_URL: 'https://shop.example' } });
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

const ORDER = { number: 1042, customer_name: 'Sadia Rahman', consignment_id: 'SF-9', cod_amount: 2220, area: 'outside_dhaka', status: 'in_transit', courier: 'Steadfast' };

test('messages fill in the customer, order, tracking, delivery time and cash; the card keeps one button', () => {
  const ws = { delivery_outside_days: '3-5 days', settings: {} };
  assert.equal(fillMessage('{name} · #{order} · {tracking} · {eta} · {cod} · {nope}', ORDER, ws), 'Sadia · #1042 · SF-9 · 3-5 days · ৳2,220 · {nope}');
  const card = stepCard('out_for_delivery', { _id: 1, ...ORDER }, ws, { trackUrl: 'https://steadfast.com.bd/t/SF-9', riderPhone: '+8801711111111' });
  assert.deepEqual(card.payload.buttons, [{ type: 'phone', title: 'রাইডারকে কল করুন', value: '+8801711111111' }]);
  const fb = toPlatform('messenger', card);
  assert.deepEqual(fb.attachment.payload.elements[0].buttons[0], { type: 'phone_number', title: 'রাইডারকে কল করুন', payload: '+8801711111111' });
  // An older "delivery updates off" switch keeps every step off until the shop sets them here.
  assert.equal(Object.values(deliverySettings({ settings: { delivery_updates: false } }).steps).some((s) => s.on), false);
  assert.equal(deliverySettings({}).steps.failed.on, false, 'delivery failed is off by default, as in the design');
});

test('settings: owners and admins edit steps, alerts and the review coupon; moderators only read', async () => {
  const s = await start();
  try {
    const page = await s.call('/settings/delivery-updates', { token: s.owner });
    assert.equal(page.status, 200);
    assert.deepEqual(Object.keys(page.body.steps), ['booked', 'picked', 'out_for_delivery', 'delivered', 'returned', 'failed']);
    assert.equal(page.body.alerts.cancel_after_ship, true);
    assert.equal(page.body.couriers.length, 5);

    const steps = { ...page.body.steps, picked: { on: false, title: 'Rider has it', message: '{name}, on the way', button: 'track' } };
    assert.equal((await s.call('/settings/delivery-updates', { method: 'PUT', token: s.mod, body: { steps } })).status, 403);
    assert.equal((await s.call('/settings/delivery-updates', { method: 'PUT', token: s.owner, body: { steps: { ...steps, booked: { ...steps.booked, button: 'dance' } } } })).status, 400);
    assert.equal((await s.call('/settings/delivery-updates', { method: 'PUT', token: s.owner, body: { review: { on: true, coupon: 'NOPE' } } })).status, 404, 'the coupon must exist');

    await s.call('/coupons', { method: 'POST', token: s.owner, body: { code: 'THANKS10', type: 'percent', value: 10 } });
    const saved = await s.call('/settings/delivery-updates', { method: 'PUT', token: s.owner, body: { steps, alerts: { cancel_after_ship: false, handoff_failed: true }, review: { on: true, coupon: 'thanks10' } } });
    assert.equal(saved.status, 200);
    assert.deepEqual([saved.body.steps.picked.on, saved.body.steps.picked.title, saved.body.alerts.cancel_after_ship, saved.body.review.coupon], [false, 'Rider has it', false, 'THANKS10']);
    assert.equal((await s.call('/settings/delivery-updates', { token: s.mod })).body.canEdit, false);
  } finally { await s.close(); }
});

test('a day after delivery the customer is asked for a rating once; 4–5 stars get the shop\'s coupon', async () => {
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  const inbox = createInbox(ctx.db, ctx.config);
  const updater = createDeliveryUpdater(ctx.db, inbox, ctx.config, { log: {} });
  const { conversation } = await inbox.ingestMessage(inbound({ text: 'thanks' }));
  const order = await ctx.db.insert(ctx.db.orders, { workspace_id: ctx.ws, conversation_id: conversation.id, number: 77, customer_name: 'Rafi', phone: '01712345678', address: 'x', area: 'inside_dhaka',
    cod_amount: 1000, subtotal: 930, delivery_charge: 70, status: 'delivered', items: [{ name: 'Panjabi' }] });
  await ctx.db.insert(ctx.db.orderEvents, { workspace_id: ctx.ws, order_id: order.id, type: 'status', to: 'delivered', created_at: new Date(Date.now() - 26 * 3_600_000) });
  assert.equal(await updater.sendDueReviews(), 1);
  assert.equal(await updater.sendDueReviews(), 0, 'only once');
  assert.equal(await ctx.db.messages.countDocuments({ conversation_id: conversation.id, kind: 'review_request' }), 1);

  await ctx.db.insert(ctx.db.coupons, { workspace_id: ctx.ws, code: 'THANKS10', type: 'percent', value: 10 });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { 'settings.delivery_review': { on: true, coupon: 'THANKS10' } } });
  const handle = createPostbackHandler(ctx.db, inbox, {});
  assert.equal(await handle(conversation.id, null, { action: 'RATE', id: `${order.id}-5` }), true);
  const last = await ctx.db.messages.findOne({ conversation_id: conversation.id, direction: 'out' }).sort({ _id: -1 }).lean();
  assert.match(last.text, /THANKS10/);
  assert.equal((await ctx.db.orders.findById(order.id).lean()).review.rating, 5);

  // Switched off: no rating request.
  const other = await ctx.db.insert(ctx.db.orders, { workspace_id: ctx.ws, conversation_id: conversation.id, number: 78, customer_name: 'Rafi', phone: '01712345678', address: 'x', area: 'inside_dhaka',
    cod_amount: 1000, subtotal: 930, delivery_charge: 70, status: 'delivered', items: [{ name: 'Panjabi' }] });
  await ctx.db.insert(ctx.db.orderEvents, { workspace_id: ctx.ws, order_id: other.id, type: 'status', to: 'delivered', created_at: new Date(Date.now() - 30 * 3_600_000) });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { 'settings.delivery_review': { on: false, coupon: '' } } });
  assert.equal(await updater.sendDueReviews(), 0);
});

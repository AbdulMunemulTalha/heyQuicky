import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, inbound } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { createInbox } from '../src/inbox.js';
import { createAgent } from '../src/ai/agent.js';
import { createPostbackHandler } from '../src/dashboard/postbacks.js';
import { dhakaTime, dhakaParts, freeSlots, cleanBookingSettings, bookingSettings, availabilityContext, whenBn, sendBookingReminders, createBooking } from '../src/dashboard/bookings.js';

const DAY = 86_400_000;
const inDays = (n) => dhakaParts(new Date(Date.now() + n * DAY)).date;
const SETTINGS = { slot_min: 30, open: '11:00', close: '20:00', closed_days: [], capacity: 1, reminder: true,
  services: [{ id: 'measure', name: 'Custom three-piece measurement', minutes: 60, price: 800, advance: 500 }, { id: 'fit', name: 'Fitting', minutes: 30, price: 0, advance: 0 }] };

test('Dhaka time, free slots, settings and what the AI is told', () => {
  const at = dhakaTime('2026-11-17', '15:00');
  assert.equal(at.toISOString(), '2026-11-17T09:00:00.000Z');
  assert.deepEqual(dhakaParts(at), { date: '2026-11-17', time: '15:00', day: 2, mins: 900 });
  assert.match(whenBn(at), /মঙ্গলবার 17\/11, দুপুর 3টায়/);

  const s = bookingSettings({ settings: { bookings: { ...SETTINGS, closed_days: [5] } } });
  const now = new Date('2026-11-16T00:00:00Z');
  assert.equal(freeSlots(s, '2026-11-20', 60, [], now).length, 0, 'Friday closed');
  const tue = freeSlots(s, '2026-11-17', 60, [], now);
  assert.deepEqual([tue[0], tue.at(-1), tue.length], ['11:00', '19:00', 17], 'last 60-minute slot ends at closing');
  const taken = [{ status: 'confirmed', starts_at: dhakaTime('2026-11-17', '15:00'), ends_at: dhakaTime('2026-11-17', '16:00') }];
  const after = freeSlots(s, '2026-11-17', 60, taken, now);
  assert.ok(!after.includes('14:30') && !after.includes('15:00') && !after.includes('15:30') && after.includes('16:00') && after.includes('14:00'), 'overlaps are not offered');
  assert.ok(freeSlots({ ...s, capacity: 2 }, '2026-11-17', 60, taken, now).includes('15:00'), 'two chairs: still one free');
  assert.ok(!freeSlots(s, '2026-11-17', 60, [], dhakaTime('2026-11-17', '14:50')).includes('15:00'), 'not within the next half hour');

  assert.throws(() => cleanBookingSettings({ open: '20:00', close: '11:00' }), /Closing time/);
  assert.throws(() => cleanBookingSettings({ services: [{ name: 'X', price: 100, advance: 200 }] }), /can't be more than its price/);
  const ctx = availabilityContext({ settings: s, list: [{ service: s.services[0], days: [{ date: '2026-11-17', times: ['11:00', '15:00'] }, { date: '2026-11-20', times: [] }] }] });
  assert.match(ctx, /Custom three-piece measurement \(service id "measure", 60 min, ৳800, ৳500 bKash advance needed to confirm\)/);
  assert.match(ctx, /Tue 2026-11-17: 11:00, 15:00\n {2}Fri 2026-11-20: full or closed/);
});

async function start() {
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { ai_mode: 'auto', bkash_number: '01711000000', 'settings.modules': { bookings: true, quotes: true }, 'settings.bookings': SETTINGS } });
  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}/api/dash`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const login = async (email) => (await call('/auth/login', { method: 'POST', body: { login: email, password: 'password123' } })).body.token;
  return { ...ctx, app, call, owner: await login('owner@shop.test'), mod: await login('nadia@shop.test'), close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

test('Bookings screen: settings, booking a free slot, double-booking refused, advance, reschedule, cancel', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('/settings/bookings', { method: 'PUT', token: s.mod, body: SETTINGS })).status, 403, 'moderators can\'t change services');
    const saved = await s.call('/settings/bookings', { method: 'PUT', token: s.owner, body: { slotMin: 30, open: '11:00', close: '20:00', closedDays: [], capacity: 1, services: [{ id: 'measure', name: 'Custom three-piece measurement', minutes: 60, price: 800, advance: 500 }, { id: 'fit', name: 'Fitting', minutes: 30, price: 0, advance: 0 }] } });
    assert.deepEqual(saved.body.services.map((x) => x.id), ['measure', 'fit']);

    const date = inDays(3);
    const slots = await s.call(`/bookings/slots?serviceId=measure&date=${date}`, { token: s.owner });
    assert.ok(slots.body.times.includes('15:00'));
    const made = await s.call('/bookings', { method: 'POST', token: s.mod, body: { serviceId: 'measure', date, time: '15:00', name: 'Sadia Rahman', phone: '01712345678' } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual([made.body.status, made.body.advance.amount, made.body.time, made.body.endTime], ['pending', 500, '15:00', '16:00']);
    assert.equal((await s.call('/bookings', { method: 'POST', token: s.mod, body: { serviceId: 'fit', date, time: '15:30', name: 'Rina', phone: '01812345678' } })).status, 409, 'overlap refused');
    assert.ok(!(await s.call(`/bookings/slots?serviceId=fit&date=${date}`, { token: s.owner })).body.times.includes('15:30'));
    assert.equal((await s.call('/bookings', { method: 'POST', token: s.mod, body: { serviceId: 'fit', date, time: '16:00', name: 'Rina', phone: '0181' } })).status, 400, 'phone checked');

    const week = await s.call(`/bookings?week=${date}`, { token: s.owner });
    assert.equal(week.body.week.length, 7);
    assert.equal(dhakaParts(dhakaTime(week.body.week[0], '12:00')).day, 1, 'weeks start on Monday');
    assert.deepEqual(week.body.bookings.map((b) => b.name), ['Sadia Rahman']);

    let r = await s.call(`/bookings/${made.body.id}/status`, { method: 'POST', token: s.mod, body: { status: 'confirmed' } });
    assert.deepEqual([r.body.status, r.body.advance.verified], ['confirmed', true]);
    r = await s.call(`/bookings/${made.body.id}/reschedule`, { method: 'POST', token: s.mod, body: { date, time: '15:30' } });
    assert.equal(r.body.time, '15:30', 'moving within its own slot is fine');
    assert.equal((await s.call(`/bookings/${made.body.id}/reschedule`, { method: 'POST', token: s.mod, body: { date, time: '10:00' } })).status, 409, 'before opening');
    r = await s.call(`/bookings/${made.body.id}/status`, { method: 'POST', token: s.mod, body: { status: 'cancelled' } });
    assert.equal(r.body.status, 'cancelled');
    assert.ok((await s.call(`/bookings/slots?serviceId=measure&date=${date}`, { token: s.owner })).body.times.includes('15:30'), 'the slot is free again');
    assert.equal((await s.call(`/bookings/${made.body.id}/status`, { method: 'POST', token: s.mod, body: { status: 'arrived' } })).status, 409);
  } finally {
    await s.close();
  }
});

test('the AI books a slot from chat, takes the TrxID for the advance, and collects a quote request; the customer accepts the quote card', async () => {
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { ai_mode: 'auto', bkash_number: '01711000000', 'settings.modules': { bookings: true, quotes: true }, 'settings.bookings': SETTINGS } });
  const script = [];
  const calls = [];
  const notes = [];
  const NONE = { ready: false, service_id: '', date: '', time: '', name: '', phone: '', note: '' };
  const BASE = { reply: 'জি আপু', handoff: false, handoff_reason: '', intent: 'other', products: [], quick_replies: [], size_chart_product: 0,
    order: { ready: false, items: [], name: '', phone: '', address: '', zone: 'inside_dhaka', note: '', coupon: '' },
    order_change: { action: 'none', items: [], name: '', phone: '', address: '', zone: 'inside_dhaka', note: '', coupon: '' },
    booking: NONE, quote_request: { ready: false, title: '', details: '' }, payment: { trx_id: '', method: 'bkash', amount: 0 }, customer_tags: [], act_now: false, act_now_reason: '' };
  const provider = { name: 'fake', model: 'fake-1', async generateJson(req) { calls.push(req); return { data: { ...BASE, ...script.shift() }, usage: {} }; } };
  const inbox = createInbox(ctx.db, ctx.config);
  const notify = async (n) => { notes.push(n); return []; };
  const agent = createAgent(ctx.db, inbox, provider, { replyDelayMs: 0, log: { warn() {} }, config: ctx.config, notify });
  inbox.setPostbackHandler(createPostbackHandler(ctx.db, inbox, { notify }));
  const say = async (text, answer, extra = {}) => {
    if (answer) script.push(answer);
    const r = await inbox.ingestMessage(inbound({ contactExternalId: 'sadia', text, ...extra }));
    if (answer) await agent.respond(r.conversation.id, r.message.id);
    return r.conversation.id;
  };
  const date = inDays(2);

  const conv = await say('kal measurement dite chai', { reply: 'কোন সময় সুবিধা?' });
  assert.match(calls[0].context, /## Bookings \(appointments\)/);
  assert.match(calls[0].context, new RegExp(`${date}: 11:00, 11:30`));

  await say('3 tay, Sadia 01712345678', { reply: 'বুক করে দিলাম', booking: { ready: true, service_id: 'measure', date, time: '15:00', name: 'Sadia', phone: '01712345678', note: 'Brings own fabric' } });
  const b = await ctx.db.bookings.findOne({ workspace_id: ctx.ws }).lean();
  assert.deepEqual([b.source, b.status, b.service, b.note, b.conversation_id], ['ai', 'pending', 'Custom three-piece measurement', 'Brings own fabric', conv]);
  assert.ok(b.confirmation_sent_at, 'confirmation sent right after booking');
  const lastOut = await ctx.db.messages.findOne({ conversation_id: conv, direction: 'out' }).sort({ _id: -1 }).lean();
  assert.match(lastOut.text, /সময়টা আপনার জন্য রাখা হলো। কনফার্ম করতে ৳500 অগ্রিম বিকাশ 01711000000/);
  assert.ok(notes.some((n) => /New booking: Sadia/.test(n.title)));

  // The TrxID goes on the booking, not into order payments.
  await say('pathiyechi, TrxID BKH8X2K9QP', { reply: 'ধন্যবাদ, দেখে কনফার্ম করছি', payment: { trx_id: 'BKH8X2K9QP', method: 'bkash', amount: 500 } });
  assert.equal((await ctx.db.bookings.findById(b._id).lean()).advance.trx_id, 'BKH8X2K9QP');
  assert.equal(await ctx.db.payments.countDocuments(), 0);
  assert.match(calls.at(-1).context, /upcoming bookings\n- Custom three-piece measurement on .* waiting for the ৳500 advance TrxID/);

  // A slot that was taken meanwhile: the team takes over.
  await createBooking(ctx.db, await ctx.db.workspaces.findById(ctx.ws).lean(), { serviceId: 'fit', date, time: '17:00', name: 'Rina', phone: '01812345678' });
  await say('arekta fitting 5 tay', { reply: 'বুক করলাম', booking: { ready: true, service_id: 'fit', date, time: '17:00', name: 'Sadia', phone: '01712345678', note: '' } });
  assert.match((await ctx.db.conversations.findById(conv).lean()).ai_handoff_reason, /couldn't make the booking: 17:00 .* isn't free/);
  await ctx.db.conversations.updateOne({ _id: conv }, { $set: { ai_handoff: false, ai_handoff_reason: '' } });

  // Custom work: a quote request for the shop to price.
  await say('25 ta office kurti lagbe, logo embroidery', { reply: 'দাম জানিয়ে দিচ্ছি', quote_request: { ready: true, title: 'Office uniform kurti ×25', details: 'Logo on pocket, navy, mixed sizes' } });
  const q = await ctx.db.quotes.findOne({ workspace_id: ctx.ws }).lean();
  assert.deepEqual([q.number, q.status, q.title, q.conversation_id], [1, 'waiting', 'Office uniform kurti ×25', conv]);
  assert.ok(notes.some((n) => /Quote request: Office uniform kurti/.test(n.title)));

  // The shop prices it and sends the card; the customer taps Accept.
  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}/api/dash`;
  try {
    const token = (await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'owner@shop.test', password: 'password123' }) })).json()).token;
    const post = async (path, body) => { const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
    assert.equal((await post(`/quotes/${q._id}/send`, { price: 0 })).status, 400);
    assert.equal((await post(`/quotes/${q._id}/send`, { price: 1000, advance: 2000 })).status, 400);
    const sent = await post(`/quotes/${q._id}/send`, { price: 31250, advance: 5000, validDays: 5 });
    assert.equal(sent.body.status, 'sent');
    const card = await ctx.db.messages.findOne({ conversation_id: conv, kind: 'quote' }).lean();
    assert.match(card.text, /কোটেশন Q-1: Office uniform kurti ×25\nদাম: ৳31,250\nঅগ্রিম: ৳5,000 \(বিকাশ 01711000000\)/);
    assert.deepEqual(card.payload.buttons.map((x) => x.value), [`HQ:QACCEPT:${q._id}`, `HQ:QDECLINE:${q._id}`]);
  } finally {
    await new Promise((r) => { app.io.close(); app.server.close(r); });
  }
  await say('রাজি, এগোন', null, { postback: `HQ:QACCEPT:${q._id}` });
  const until = async (fn) => { for (let i = 0; i < 60; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } return null; };
  assert.ok(await until(async () => (await ctx.db.quotes.findById(q._id).lean()).status === 'accepted'));
  assert.ok(await until(() => ctx.db.messages.findOne({ conversation_id: conv, direction: 'out', text: /Q-1 গ্রহণ করেছেন। কাজ শুরু করতে ৳5,000 অগ্রিম/ }).lean()));
  assert.ok(await until(() => notes.some((n) => /accepted quote Q-1/.test(n.title))), 'the shop is told');
});

test('day-before reminders: once, only for tomorrow, and a note when the chat window is closed', async () => {
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { 'settings.bookings': SETTINGS } });
  const inbox = createInbox(ctx.db, ctx.config);
  const { conversation } = await inbox.ingestMessage(inbound({ contactExternalId: 'mitu', text: 'booking dibo' }));
  const now = dhakaTime(inDays(0), '15:00');
  const tomorrow = new Date(now.getTime() + 24 * 3_600_000);
  const mk = (fields) => ctx.db.insert(ctx.db.bookings, { workspace_id: ctx.ws, service_id: 'fit', service: 'Fitting', name: 'Mitu', phone: '01712345678', status: 'confirmed', starts_at: tomorrow, ends_at: new Date(tomorrow.getTime() + 30 * 60_000), ...fields });
  const withChat = (await mk({ conversation_id: conversation.id })).id;
  const noChat = (await mk({ conversation_id: null, name: 'Walk-in' })).id;
  const later = (await mk({ conversation_id: conversation.id, starts_at: new Date(now.getTime() + 3 * DAY), ends_at: new Date(now.getTime() + 3 * DAY + 1_800_000) })).id;
  let r = await sendBookingReminders(ctx.db, inbox, { now });
  assert.deepEqual(r, { sent: 1, failed: 1 });
  const msg = await ctx.db.messages.findOne({ conversation_id: conversation.id, direction: 'out' }).lean();
  assert.match(msg.text, /আগামীকাল .* আপনার Fitting বুকিং আছে/);
  assert.ok((await ctx.db.bookings.findById(withChat).lean()).reminder_sent_at);
  assert.match((await ctx.db.bookings.findById(noChat).lean()).reminder_failed, /No chat/);
  assert.equal((await ctx.db.bookings.findById(later).lean()).reminder_sent_at, null, 'not yet');
  r = await sendBookingReminders(ctx.db, inbox, { now: new Date(now.getTime() + 600_000) });
  assert.deepEqual(r, { sent: 0, failed: 0 }, 'never twice');
});

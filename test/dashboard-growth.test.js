import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, inbound } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { temperature, schedule, runFollowups } from '../src/dashboard/followups.js';

async function start() {
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { ai_mode: 'auto' } });
  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}/api/dash`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const token = (await call('/auth/login', { method: 'POST', body: { login: 'owner@shop.test', password: 'password123' } })).body.token;
  return { ...ctx, app, call, token, close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

// A customer asks, the AI answers, then nobody writes.
async function quietChat(s, { id, text, minutesAgo }) {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  await s.app.inbox.ingestMessage(inbound({ contactExternalId: id, contactName: id, text, timestamp: at.toISOString() }));
  const conv = await s.db.conversations.findOne({ contact_id: (await s.db.contacts.findOne({ external_id: id }).lean())._id }).lean();
  await s.db.messages.create({ _id: await s.db.nextId('messages'), conversation_id: conv._id, direction: 'out', sent_by_ai: true, text: 'জি আপু, আছে। দাম ৳২,১৫০।', created_at: new Date(at.getTime() + 60_000) });
  await s.db.conversations.updateOne({ _id: conv._id }, { $set: { last_replier: 'ai', assigned_user_id: null, ai_handoff: false } });
  return conv;
}

test('interest is read from what the customer asked', () => {
  assert.equal(temperature(['ঢাকার বাইরে ডেলিভারি চার্জ কত?']), 'hot');
  assert.equal(temperature(['price koto apu?']), 'warm');
  assert.equal(temperature(['price koto?', 'ok thanks']), 'skip');
  assert.equal(temperature(['hello']), 'skip');
  const t = new Date('2026-11-17T10:00:00Z');
  assert.deepEqual(schedule('hot', t).map((d) => d.toISOString()), ['2026-11-17T13:00:00.000Z', '2026-11-18T06:00:00.000Z']);
  assert.equal(schedule('warm', t).length, 1);
});

test('hot chats get a reminder at 3 h; replies and orders stop them; leads are captured', async () => {
  const s = await start();
  try {
    const hot = await quietChat(s, { id: 'hot-1', text: 'ঢাকার বাইরে ডেলিভারি চার্জ কত?', minutesAgo: 200 });
    const warm = await quietChat(s, { id: 'warm-1', text: 'price koto apu?', minutesAgo: 200 });
    const first = await runFollowups(s.db, s.app.inbox);
    assert.equal(first.watched, 2);
    assert.equal(first.sent, 0, 'the first pass only starts watching');
    const second = await runFollowups(s.db, s.app.inbox);
    assert.equal(second.sent, 1, 'only the hot chat is due at 3 hours');
    const reminder = await s.db.messages.findOne({ conversation_id: hot._id, kind: 'followup' }).lean();
    assert.ok(reminder, 'the reminder was sent in the hot chat');
    assert.equal(await s.db.messages.countDocuments({ conversation_id: warm._id, kind: 'followup' }), 0);
    assert.equal((await runFollowups(s.db, s.app.inbox)).sent, 0, 'never sent twice for the same step');

    // The customer replies: the follow-up stops.
    await s.app.inbox.ingestMessage(inbound({ contactExternalId: 'hot-1', text: 'ok দিন একটা' }));
    await runFollowups(s.db, s.app.inbox);
    assert.equal((await s.db.followups.findOne({ conversation_id: hot._id }).lean()).status, 'replied');

    const leads = await s.call('/growth/leads', { token: s.token });
    assert.equal(leads.body.counts.to_chase, 2);
    const lead = leads.body.items.find((l) => l.temp === 'hot');
    const logged = await s.call(`/growth/leads/${lead.id}/log`, { method: 'POST', token: s.token, body: { outcome: 'call_later' } });
    assert.equal(logged.body.stage, 'call_scheduled');
    assert.equal((await s.call('/growth/leads?tab=contacted', { token: s.token })).body.items.length, 1);

    const view = await s.call('/growth/followups', { token: s.token });
    assert.equal(view.status, 200);
    assert.ok(view.body.kpis.watching >= 1);
    assert.equal((await s.call('/growth/followups/settings', { method: 'PATCH', token: s.token, body: { enabled: false } })).status, 200);
    assert.equal((await runFollowups(s.db, s.app.inbox)).watched, 0, 'switching follow-ups off stops them');
  } finally {
    await s.close();
  }
});

test('chats a teammate owns are skipped', async () => {
  const s = await start();
  try {
    const conv = await quietChat(s, { id: 'owned', text: 'ডেলিভারি কবে?', minutesAgo: 200 });
    await s.db.conversations.updateOne({ _id: conv._id }, { $set: { ai_handoff: true } });
    await runFollowups(s.db, s.app.inbox);
    const f = await s.db.followups.findOne({ conversation_id: conv._id }).lean();
    assert.deepEqual([f.status, f.skip_reason], ['skipped', 'A teammate is handling it']);
  } finally {
    await s.close();
  }
});

test('broadcasts only reach people inside the 24-hour window', async () => {
  const s = await start();
  try {
    await s.app.inbox.ingestMessage(inbound({ contactExternalId: 'recent', text: 'hi' }));
    await s.app.inbox.ingestMessage(inbound({ contactExternalId: 'old', text: 'hi', timestamp: new Date(Date.now() - 3 * 86_400_000).toISOString() }));
    const preview = await s.call('/growth/broadcasts/preview', { method: 'POST', token: s.token, body: { audience: 'last_24h' } });
    assert.deepEqual([preview.body.recipients, preview.body.outsideWindow], [1, 1]);
    const empty = await s.call('/growth/broadcasts', { method: 'POST', token: s.token, body: { audience: 'last_24h', format: 'text', content: { text: '' } } });
    assert.equal(empty.status, 400);
    const sent = await s.call('/growth/broadcasts', { method: 'POST', token: s.token, body: { audience: 'last_24h', format: 'buttons', content: { text: 'নতুন কালেকশন!', buttons: ['অর্ডার করব'] } } });
    assert.deepEqual([sent.status, sent.body.sent], [201, 1]);
    const msg = await s.db.messages.findOne({ kind: 'broadcast' }).lean();
    assert.match(msg.text, /নতুন কালেকশন![\s\S]*অর্ডার করব/);
    const later = await s.call('/growth/broadcasts', { method: 'POST', token: s.token, body: { audience: 'last_24h', format: 'text', content: { text: 'Eid sale' }, scheduledAt: new Date(Date.now() + 3_600_000).toISOString() } });
    assert.equal(later.body.scheduled, true);
    const list = await s.call('/growth/broadcasts', { token: s.token });
    assert.deepEqual(list.body.map((b) => b.status).sort(), ['scheduled', 'sent']);
  } finally {
    await s.close();
  }
});

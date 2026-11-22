import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, inbound } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { callbackFromMessages, parseCallback, remindCallbacks } from '../src/dashboard/callbacks.js';

// Monday 23 Nov 2026, 12:00 in Dhaka.
const NOW = new Date('2026-11-23T06:00:00Z');
const at = (s) => parseCallback(s, NOW)?.at?.toISOString() ?? null;

test('callback times are read from Bangla, Banglish and English, in Bangladesh time', () => {
  assert.equal(at('শুক্রবার বিকাল ৫টায় কল দিবেন'), '2026-11-27T11:00:00.000Z', 'Friday 5 PM, and বিকাল is not কাল');
  assert.equal(at('কাল বিকেলে কল দিয়েন'), '2026-11-24T10:00:00.000Z', 'tomorrow afternoon → 4 PM');
  assert.equal(at('আগামীকাল সকাল ১০টায় ফোন'), '2026-11-24T04:00:00.000Z');
  assert.equal(at('kal sokal 11 tay call diben'), '2026-11-24T05:00:00.000Z');
  assert.equal(at('call me friday 5pm'), '2026-11-27T11:00:00.000Z');
  assert.equal(at('আজ রাত ৮টায় ফোন দিয়েন'), '2026-11-23T14:00:00.000Z');
  assert.equal(at('porshu 3:30 e call'), '2026-11-25T09:30:00.000Z');
  assert.equal(at('call diben 5ta'), '2026-11-23T11:00:00.000Z', '"5ta" means 5 PM');
  assert.equal(at('amar number 01712345678'), null);
  assert.equal(at('dam koto?'), null);
  // The newest message that names a time wins; past times are skipped.
  const found = callbackFromMessages([{ text: 'ok thanks' }, { text: 'শুক্রবার বিকাল ৫টায় কল দিবেন' }, { text: 'kal sokal 11 tay call diben' }], NOW);
  assert.equal(found.at.toISOString(), '2026-11-27T11:00:00.000Z');
  assert.match(found.quote, /শুক্রবার/);
});

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
  return { ...ctx, app, call, owner: await login('owner@shop.test'), close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

test('schedule a call: the chat\'s time is suggested; saving sets the owner and a reminder goes out once when it\'s due', async () => {
  const s = await start();
  try {
    const { conversation } = await s.app.inbox.ingestMessage(inbound({ text: 'Friday 5pm e call diben please' }));
    const lead = await s.db.insert(s.db.prospects, { workspace_id: s.ws, conversation_id: conversation.id, name: 'Mahfuz Alam', product: 'Silk Panjabi', amount: 2350, phone: '01733111118' });
    const pop = await s.call(`/growth/leads/${lead.id}/callback`, { token: s.owner });
    assert.equal(pop.status, 200);
    assert.ok(pop.body.fromChat, 'the time is read from the chat');
    assert.match(pop.body.fromChat.quote, /Friday 5pm/);
    assert.ok(pop.body.team.length >= 1);

    const nadia = await s.db.users.findOne({ email: 'nadia@shop.test' }).lean();
    assert.equal((await s.call(`/growth/leads/${lead.id}/callback`, { method: 'POST', token: s.owner, body: { at: '2020-01-01T00:00:00Z', ownerId: nadia._id } })).status, 400, 'not in the past');
    const soon = new Date(Date.now() + 2 * 60_000).toISOString();
    const saved = await s.call(`/growth/leads/${lead.id}/callback`, { method: 'POST', token: s.owner, body: { at: soon, ownerId: nadia._id } });
    assert.deepEqual([saved.status, saved.body.owner], [200, 'Nadia']);
    const p = await s.db.prospects.findById(lead.id).lean();
    assert.deepEqual([p.stage, p.owner_user_id, p.outcome], ['call_scheduled', nadia._id, 'call_later']);

    const sent = [];
    assert.equal(await remindCallbacks(s.db, async (n) => { sent.push(n); }), 1);
    assert.equal(await remindCallbacks(s.db, async (n) => { sent.push(n); }), 0, 'only once');
    assert.deepEqual(sent[0].userIds, [nadia._id]);
    assert.match(sent[0].title, /Call Mahfuz Alam now/);

    // Logging what happened in one tap still works from the popup.
    assert.equal((await s.call(`/growth/leads/${lead.id}/log`, { method: 'POST', token: s.owner, body: { outcome: 'ordered' } })).body.stage, 'won');
  } finally { await s.close(); }
});

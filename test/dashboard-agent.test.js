import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { recordUnanswered, trainedNotes } from '../src/dashboard/training.js';

async function start() {
  const ctx = await setup({ env: { DRY_RUN: '1', AI_REPLY_DELAY_MS: '0' } });
  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const root = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${root}/api/dash${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
  };
  const token = (await call('/auth/login', { method: 'POST', body: { login: 'owner@shop.test', password: 'password123' } })).body.token;
  return { ...ctx, app, call, token, close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

test('the same unanswered question is counted once, however it is written', async () => {
  const s = await start();
  try {
    await recordUnanswered(s.db, s.ws, 'Apu showroom kothay???');
    await recordUnanswered(s.db, s.ws, 'apu showroom kothay');
    const rows = await s.db.unanswered.find({ workspace_id: s.ws }).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 2);
    assert.equal(rows[0].status, 'open');
  } finally { await s.close(); }
});

test('persona edits publish versions and undo puts the old persona back', async () => {
  const s = await start();
  try {
    const a = await s.call('/agent/persona', { method: 'PATCH', token: s.token, body: { name: 'Nusrat', style: 'banglish', delay: '1-3' } });
    assert.equal(a.status, 200);
    const b = await s.call('/agent/persona', { method: 'PATCH', token: s.token, body: { name: 'Mim' } });
    assert.equal(b.body.version, a.body.version + 1);
    assert.equal((await s.call('/agent/persona', { method: 'PATCH', token: s.token, body: { style: 'shouty' } })).status, 400);
    assert.equal((await s.call('/agent/persona', { method: 'PATCH', token: s.token, body: { delay: '3-6 seconds' } })).status, 400);

    let d = (await s.call('/agent', { token: s.token })).body;
    assert.equal(d.persona.name, 'Mim');
    assert.equal(d.persona.delay, '1-3');
    assert.equal(d.version.number, b.body.version);
    assert.equal(d.version.canUndo, true);
    assert.equal(d.available, false);

    const u = await s.call('/agent/undo', { method: 'POST', token: s.token });
    assert.equal(u.status, 200);
    assert.equal(u.body.restored, a.body.version);
    d = (await s.call('/agent', { token: s.token })).body;
    assert.equal(d.persona.name, 'Nusrat');
    assert.equal(d.version.number, b.body.version + 1, 'the rollback is itself a new version');
  } finally { await s.close(); }
});

test('teaching an answer publishes it to the AI and clears the question', async () => {
  const s = await start();
  try {
    await recordUnanswered(s.db, s.ws, '42 size ache?');
    let d = (await s.call('/agent', { token: s.token })).body;
    assert.equal(d.unanswered.length, 1);
    const q = d.unanswered[0];

    const p = await s.call('/agent/preview', { method: 'POST', token: s.token, body: { question: q.question, answer: '42 mane XL, apu.' } });
    assert.deepEqual(p.body, { reply: '42 mane XL, apu.', ai: false }, 'without an AI the preview is the answer as written');

    assert.equal((await s.call(`/agent/unanswered/${q.id}/teach`, { method: 'POST', token: s.token, body: { answer: '' } })).status, 400);
    const t = await s.call(`/agent/unanswered/${q.id}/teach`, { method: 'POST', token: s.token, body: { answer: '42 mane XL, apu.' } });
    assert.equal(t.status, 200);
    d = (await s.call('/agent', { token: s.token })).body;
    assert.equal(d.unanswered.length, 0);
    assert.equal(d.version.number, t.body.version);
    assert.match(await trainedNotes(s.db, s.ws), /42 mane XL/);

    await recordUnanswered(s.db, s.ws, 'showroom kothay');
    const id = (await s.call('/agent', { token: s.token })).body.unanswered[0].id;
    assert.equal((await s.call(`/agent/unanswered/${id}/hide`, { method: 'POST', token: s.token })).status, 200);
    assert.equal((await s.call('/agent', { token: s.token })).body.unanswered.length, 0);
  } finally { await s.close(); }
});

test('knowledge and channel switches save, and the test chat needs an AI', async () => {
  const s = await start();
  try {
    const k = await s.call('/agent/knowledge', { method: 'POST', token: s.token, body: { title: 'Exchange', text: 'Exchange within 3 days with the tag.' } });
    assert.equal(k.status, 201);
    assert.match(await trainedNotes(s.db, s.ws), /Exchange within 3 days/);
    assert.equal((await s.call('/agent/knowledge', { method: 'POST', token: s.token, body: { text: '' } })).status, 400);
    assert.equal((await s.call(`/agent/knowledge/${k.body.id}`, { method: 'DELETE', token: s.token })).status, 204);
    assert.doesNotMatch(await trainedNotes(s.db, s.ws), /Exchange within 3 days/);

    let d = (await s.call('/agent', { token: s.token })).body;
    const ch = d.channels.find((c) => c.id !== 'comments');
    assert.equal((await s.call(`/agent/channels/${ch.id}`, { method: 'PATCH', token: s.token, body: { on: false } })).status, 200);
    assert.equal((await s.call('/agent/channels/comments', { method: 'PATCH', token: s.token, body: { on: false } })).status, 200);
    d = (await s.call('/agent', { token: s.token })).body;
    assert.equal(d.channels.find((c) => c.id === ch.id).on, false);
    assert.equal(d.channels.find((c) => c.id === 'comments').on, false);
    assert.equal((await s.call('/agent/channels/99999', { method: 'PATCH', token: s.token, body: { on: true } })).status, 404);

    assert.equal((await s.call('/agent/test', { method: 'POST', token: s.token, body: { turns: [{ role: 'user', content: 'hi' }] } })).status, 503);
  } finally { await s.close(); }
});

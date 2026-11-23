import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, inbound } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { mentionsIn } from '../src/routes/dashboard/inbox.js';

async function start() {
  const ctx = await setup({ moderators: ['Nadia', 'Rafi', 'Rafi Ahmed', 'জুবায়ের'] });
  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}/api/dash`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
  };
  const login = async (email) => (await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: email, password: 'password123' }) })).json()).token;
  return { ...ctx, app, call, owner: await login('owner@shop.test'), nadia: await login('nadia@shop.test'), close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

test('mentions: whole names only, longest first, Bangla names too', () => {
  const team = [{ _id: 1, name: 'Rafi' }, { _id: 2, name: 'Rafi Ahmed' }, { _id: 3, name: 'জুবায়ের' }, { _id: 4, name: 'Jamal (courier)' }];
  assert.deepEqual(mentionsIn('@Rafi Ahmed please check', team), [2]);
  assert.deepEqual(mentionsIn('@rafi and @Rafi Ahmed', team).sort(), [1, 2]);
  assert.deepEqual(mentionsIn('@Rafiq is not Rafi', team), []);
  assert.deepEqual(mentionsIn('@জুবায়ের প্যাক করো', team), [3]);
  assert.deepEqual(mentionsIn('ask @Jamal (courier) to pick up', team), [4]);
});

test('team notes popup: full thread with mentions, who is on duty, notifications, and deleting your own notes', async () => {
  const s = await start();
  try {
    const { conversation } = await s.app.inbox.ingestMessage(inbound({ contactExternalId: 'cust-notes', contactName: 'Shirin Akter', text: 'advance lagbe?' }));
    const id = conversation.id ?? conversation._id;
    await s.db.users.updateOne({ email: 'rafi@shop.test' }, { $set: { on_duty: false } });

    let d = await s.call(`/inbox/${id}/notes`, { token: s.owner });
    assert.equal(d.status, 200);
    assert.deepEqual(d.body.notes, []);
    const rafi = d.body.team.find((u) => u.name === 'Rafi');
    assert.equal(rafi.onDuty, false);
    assert.ok(d.body.team.find((u) => u.name === 'Owner').me);

    assert.equal((await s.call(`/inbox/${id}/notes`, { method: 'POST', token: s.owner, body: { text: '   ' } })).status, 400);
    const r = await s.call(`/inbox/${id}/notes`, { method: 'POST', token: s.owner, body: { text: 'Paid? Please pack it tonight @Nadia and @Rafi' } });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.mentions.map((m) => m.name).sort(), ['Nadia', 'Rafi']);
    assert.equal(r.body.mine, true);
    await s.call(`/inbox/${id}/notes`, { method: 'POST', token: s.nadia, body: { text: 'Asked in chat. Waiting for her TrxID.' } });

    // Mentioned teammates are notified (not the writer).
    const nadiaId = (await s.db.users.findOne({ email: 'nadia@shop.test' }).lean())._id;
    const ownerId = (await s.db.users.findOne({ email: 'owner@shop.test' }).lean())._id;
    const alerted = (await s.db.notifications.find({ type: 'mention' }).lean()).map((n) => n.user_id);
    assert.ok(alerted.includes(nadiaId), 'Nadia was notified');
    assert.ok(!alerted.includes(ownerId), 'the writer is not');

    d = await s.call(`/inbox/${id}/notes`, { token: s.nadia });
    assert.deepEqual(d.body.notes.map((n) => [n.by, n.mine]), [['Owner', false], ['Nadia', true]], 'oldest first, mine marked');

    // The side panel gets the count and mentions too.
    const panel = await s.call(`/inbox/${id}`, { token: s.owner });
    assert.equal(panel.body.noteCount, 2);
    assert.ok(panel.body.notes.some((n) => n.mentions.some((m) => m.name === 'Nadia')));

    // Only the writer (or the owner) can delete a note.
    const ownerNote = d.body.notes[0].id;
    const nadiaNote = d.body.notes[1].id;
    assert.equal((await s.call(`/inbox/${id}/notes/${ownerNote}`, { method: 'DELETE', token: s.nadia })).status, 403);
    assert.equal((await s.call(`/inbox/${id}/notes/${nadiaNote}`, { method: 'DELETE', token: s.nadia })).status, 204);
    assert.equal((await s.call(`/inbox/${id}/notes/99999`, { method: 'DELETE', token: s.owner })).status, 404);
    d = await s.call(`/inbox/${id}/notes`, { token: s.owner });
    assert.equal(d.body.notes.length, 1);
  } finally {
    await s.close();
  }
});

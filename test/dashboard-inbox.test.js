import { test } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { setup, inbound } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { looksLikeSpam } from '../src/dashboard/spam.js';
import { parseCommentChanges } from '../src/dashboard/comments.js';

async function start() {
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  const { db, config } = ctx;
  const app = createApp(db, config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${base}/api/dash${path}`, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
  };
  const login = async (email) => (await call('/auth/login', { method: 'POST', body: { login: email, password: 'password123' } })).body.token;
  return { ...ctx, app, base, call, login, close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

test('obvious spam is spotted from the first message', () => {
  assert.equal(looksLikeSpam('ঘরে বসে দিনে ৫০০০ টাকা ইনকাম করুন লিংকে ক্লিক করুন'), 'Money-making link');
  assert.equal(looksLikeSpam('Congratulations! You won an iPhone 15'), 'Prize scam');
  assert.equal(looksLikeSpam('apu L size ache?'), null);
});

test('comment webhooks are read for Facebook pages and Instagram', () => {
  const fb = parseCommentChanges({ object: 'page', entry: [{ id: 'P1', changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', post_id: 'P1_9', comment_id: 'C1', parent_id: 'P1_9', from: { id: 'U1', name: 'Rakib' }, message: '42 size?' } }] }] });
  assert.deepEqual([fb[0].platform, fb[0].postId, fb[0].commentId, fb[0].parentId, fb[0].authorName], ['messenger', 'P1_9', 'C1', null, 'Rakib']);
  const ig = parseCommentChanges({ object: 'instagram', entry: [{ id: 'IG1', changes: [{ field: 'comments', value: { id: 'C2', text: 'price?', from: { id: 'U2', username: 'mitu' }, media: { id: 'M1' } } }] }] });
  assert.equal(ig[0].platform, 'instagram');
});

test('inbox tabs, takeover, back to AI, done with auto-reopen and spam', async () => {
  const s = await start();
  try {
    const token = await s.login('owner@shop.test');
    await s.app.inbox.ingestMessage(inbound({ contactExternalId: 'cust-a', contactName: 'Sadia', text: 'apu L size ache?' }));
    await s.app.inbox.ingestMessage(inbound({ contactExternalId: 'cust-spam', contactName: 'Earn Money', text: 'ঘরে বসে দিনে ৫০০০ টাকা ইনকাম করুন লিংকে ক্লিক করুন' }));
    let list = await s.call('/inbox', { token });
    assert.equal(list.status, 200);
    assert.equal(list.body.counts.open, 1, 'spam is not in Open');
    assert.equal(list.body.counts.spam, 1);
    const id = list.body.items[0].id;
    assert.equal(list.body.items[0].name, 'Sadia');
    assert.ok(list.body.items[0].customerId, 'new chats get a customer');

    const take = await s.call(`/inbox/${id}/takeover`, { method: 'POST', token });
    assert.equal(take.body.aiState, 'human');
    assert.equal(take.body.takenOverBy, 'Owner');
    assert.ok(new Date(take.body.humanUntil) > new Date(), 'the AI comes back by itself later');
    assert.equal((await s.call('/inbox?tab=waiting', { token })).body.counts.waiting, 1);
    const sent = await s.call(`/inbox/${id}/messages`, { method: 'POST', token, body: { text: 'জি আপু, আছে' } });
    assert.equal(sent.status, 201);
    const back = await s.call(`/inbox/${id}/release`, { method: 'POST', token });
    assert.equal(back.body.aiState, 'ai');

    const done = await s.call(`/inbox/${id}/done`, { method: 'POST', token });
    assert.equal(done.body.status, 'done');
    await s.app.inbox.ingestMessage(inbound({ contactExternalId: 'cust-a', text: 'আর একটা প্রশ্ন' }));
    const detail = await s.call(`/inbox/${id}`, { token });
    assert.equal(detail.body.conversation.status, 'open', 'a Done chat reopens when the customer writes');
    assert.ok(detail.body.conversation.reopenedAt);
    assert.ok(detail.body.conversation.tags.includes('Back from Done'));
    assert.equal(detail.body.messages.at(-1).text, 'আর একটা প্রশ্ন');

    // Spam: no AI, and "Not spam" brings it back.
    list = await s.call('/inbox?tab=spam', { token });
    const spamId = list.body.items[0].id;
    assert.equal(list.body.items[0].spamReason, 'Money-making link');
    const notSpam = await s.call(`/inbox/${spamId}/spam`, { method: 'POST', token, body: { spam: false } });
    assert.equal(notSpam.body.spam, false);

    // Bulk actions and tags.
    const bulk = await s.call('/inbox/bulk', { method: 'POST', token, body: { ids: [id, spamId], action: 'done' } });
    assert.equal(bulk.body.changed, 2);
    const tagged = await s.call(`/inbox/${id}/tags`, { method: 'POST', token, body: { tag: 'VIP' } });
    assert.ok(tagged.body.tags.includes('VIP'));
  } finally {
    await s.close();
  }
});

test('typing "." in Messenger pauses the AI, and "." again hands back', async () => {
  const s = await start();
  try {
    await s.app.inbox.ingestMessage(inbound({ contactExternalId: 'cust-d', text: 'hello' }));
    const conv = await s.db.conversations.findOne({}).lean();
    const r1 = await s.app.inbox.ingestMessage(inbound({ contactExternalId: 'cust-d', direction: 'out', text: '.' }));
    assert.equal(r1.ignored, 'dot_takeover');
    assert.equal((await s.db.conversations.findById(conv._id).lean()).ai_handoff, true);
    const r2 = await s.app.inbox.ingestMessage(inbound({ contactExternalId: 'cust-d', direction: 'out', text: ' . ' }));
    assert.equal(r2.ignored, 'dot_handback');
    assert.equal((await s.db.conversations.findById(conv._id).lean()).ai_handoff, false);
    assert.equal(await s.db.messages.countDocuments({ text: '.' }), 0, 'the dot itself is not stored as a message');
  } finally {
    await s.close();
  }
});

test('assigning notifies the teammate; agents only see their own and unassigned chats', async () => {
  const s = await start();
  try {
    await s.db.users.updateOne({ _id: s.mods[1] }, { $set: { role: 'agent' } });
    const owner = await s.login('owner@shop.test');
    const agent = await s.login('karim@shop.test');
    await s.app.inbox.ingestMessage(inbound({ contactExternalId: 'cust-x', contactName: 'Rakib', text: '42 size?' }));
    const conv = await s.db.conversations.findOne({}).lean();
    const r = await s.call(`/inbox/${conv._id}/assign`, { method: 'POST', token: owner, body: { userId: s.mods[0], keepAi: false, note: 'he wants size 42' } });
    assert.equal(r.body.assignedTo.id, s.mods[0]);
    assert.equal(r.body.needsPerson, true, 'not keeping the AI hands the chat to a person');
    const n = await s.db.notifications.findOne({ user_id: s.mods[0] }).lean();
    assert.match(n.title, /assigned Rakib to you/);
    assert.ok(await s.db.notes.exists({ conversation_id: conv._id, text: 'he wants size 42' }));
    assert.equal((await s.call(`/inbox/${conv._id}`, { token: agent })).status, 404, 'an agent cannot open a chat assigned to someone else');
    assert.equal((await s.call('/inbox', { token: agent })).body.items.length, 0);
    const blocked = await s.call(`/inbox/${conv._id}/messages`, { method: 'POST', token: owner, body: { text: 'hi' } });
    assert.equal(blocked.status, 201, 'the owner can always reply');
  } finally {
    await s.close();
  }
});

test('teammates see who is typing in the same chat', async () => {
  const s = await start();
  try {
    const a = await s.login('owner@shop.test');
    const b = await s.login('nadia@shop.test');
    const sa = ioClient(s.base, { auth: { token: a }, transports: ['websocket'] });
    const sb = ioClient(s.base, { auth: { token: b }, transports: ['websocket'] });
    await Promise.all([new Promise((r) => sa.on('connect', r)), new Promise((r) => sb.on('connect', r))]);
    const seen = new Promise((r) => sb.on('presence', r));
    sa.emit('presence', { conversationId: 7, state: 'typing' });
    const p = await seen;
    assert.deepEqual([p.conversationId, p.name, p.state], [7, 'Owner', 'typing']);
    sa.close();
    sb.close();
  } finally {
    await s.close();
  }
});

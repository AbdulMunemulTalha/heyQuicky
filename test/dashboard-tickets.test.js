import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, inbound } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { guessType, openTicket } from '../src/dashboard/tickets.js';

async function start({ answer } = {}) {
  const ctx = await setup({ env: { DRY_RUN: '1', AI_REPLY_DELAY_MS: '0' } });
  const provider = answer ? { name: 'fake', model: 'fake-1', async generateJson() { return { data: answer, usage: {} }; } } : null;
  const app = createApp(ctx.db, ctx.config, { aiProvider: provider, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const root = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${root}/api/dash${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
  };
  const login = async (email) => (await call('/auth/login', { method: 'POST', body: { login: email, password: 'password123' } })).body.token;
  return { ...ctx, app, call, owner: await login('owner@shop.test'), mod: await login('nadia@shop.test'), close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

test('the ticket type is read from the reason', () => {
  assert.equal(guessType('Customer wants a refund'), 'refund');
  assert.equal(guessType('Parcel arrived damaged'), 'damaged');
  assert.equal(guessType('Got the wrong size'), 'exchange');
  assert.equal(guessType('Order not delivered yet after 6 days'), 'late');
  assert.equal(guessType('Threatens a bad review'), 'complaint');
  assert.equal(guessType('Asked something odd'), 'other');
});

test('an ACT NOW chat opens one ticket, and a second flag adds to it instead of opening another', async () => {
  const s = await start({ answer: { reply: 'দুঃখিত আপু, টিম এখনই দেখছে', handoff: false, handoff_reason: '', intent: 'complaint', act_now: true, act_now_reason: 'Parcel arrived damaged, customer wants a refund' } });
  try {
    await s.db.workspaces.updateOne({ _id: s.ws }, { $set: { ai_mode: 'auto' } });
    const { conversation, message } = await s.app.inbox.ingestMessage(inbound({ text: 'parcel chera!! refund chai' }));
    assert.equal(await s.app.agent.respond(conversation.id, message.id), 'handed_off');
    const t = await s.db.tickets.findOne({ workspace_id: s.ws }).lean();
    assert.deepEqual([t.number, t.act_now, t.type, t.status, t.conversation_id, t.timeline[0].by], [101, true, 'refund', 'open', conversation.id, 'AI']);
    assert.ok(await s.db.notifications.exists({ workspace_id: s.ws, title: /ACT NOW · Ticket #101/ }), 'the team is alerted');
    const before = t.timeline.length;
    await openTicket(s.db, { workspaceId: s.ws, conversationId: conversation.id, title: 'Still angry', reason: 'Customer messaged again', actNow: true });
    assert.equal(await s.db.tickets.countDocuments({ workspace_id: s.ws }), 1);
    const after = (await s.db.tickets.findOne({ workspace_id: s.ws }).lean()).timeline;
    assert.equal(after.length, before + 1);
    assert.equal(after.at(-1).text, 'Customer messaged again');
    const badges = await s.call('/badges', { token: s.owner });
    assert.equal(badges.body.tickets, 1);
  } finally { await s.close(); }
});

test('tickets: create by hand for an order, assign, wait, note, solve with a resolution, reopen', async () => {
  const s = await start();
  try {
    const order = await s.db.insert(s.db.orders, { workspace_id: s.ws, number: 1201, customer_name: 'Mitu', phone: '01712345678', address: 'x', area: 'inside_dhaka', cod_amount: 1520, subtotal: 1450, delivery_charge: 70, discount: 0, status: 'delivered', items: [{ name: 'Kurti' }] });
    assert.equal((await s.call('/tickets', { method: 'POST', token: s.owner, body: { title: '' } })).status, 400);
    assert.equal((await s.call('/tickets', { method: 'POST', token: s.owner, body: { title: 'x', orderNumber: 9999 } })).status, 404);
    const c = await s.call('/tickets', { method: 'POST', token: s.owner, body: { title: 'Wrong colour delivered', type: 'exchange', orderNumber: 1201, note: 'Wants teal instead' } });
    assert.deepEqual([c.status, c.body.number], [201, 101]);

    const nadia = (await s.db.users.findOne({ name: 'Nadia' }).lean())._id;
    assert.equal((await s.call('/tickets/101', { method: 'PATCH', token: s.owner, body: { ownerId: nadia, status: 'waiting' } })).status, 200);
    assert.equal((await s.call('/tickets/101/notes', { method: 'POST', token: s.mod, body: { text: 'Courier pickup booked' } })).status, 201);
    assert.equal((await s.call('/tickets/101', { method: 'PATCH', token: s.owner, body: { status: 'solved' } })).status, 400, 'a resolution is required');
    assert.equal((await s.call('/tickets/101', { method: 'PATCH', token: s.owner, body: { status: 'solved', resolutionKind: 'exchanged', resolution: 'Teal sent, old one collected' } })).status, 200);

    const d = await s.call('/tickets/101', { token: s.owner });
    assert.deepEqual([d.body.ticket.status, d.body.ticket.owner.name, d.body.ticket.order.number, d.body.ticket.resolutionKind], ['solved', 'Nadia', 1201, 'exchanged']);
    assert.deepEqual(d.body.ticket.timeline.map((e) => e.type), ['opened', 'owner', 'status', 'note', 'solved']);
    assert.equal(d.body.ticket.timeline[3].by, 'Nadia');

    let list = await s.call('/tickets', { token: s.owner });
    assert.deepEqual([list.body.tickets.length, list.body.counts.solved], [0, 1]);
    list = await s.call('/tickets?status=solved', { token: s.owner });
    assert.equal(list.body.tickets[0].number, 101);
    assert.equal((await s.call('/tickets?status=all&q=teal', { token: s.owner })).body.tickets.length, 1, 'search looks at the reason too');
    assert.equal((await s.call('/tickets?status=all&q=sofa', { token: s.owner })).body.tickets.length, 0);
    assert.equal((await s.call('/tickets?status=all&q=colour', { token: s.owner })).body.tickets.length, 1);

    await s.call('/tickets/101', { method: 'PATCH', token: s.owner, body: { status: 'open' } });
    const again = await s.call('/tickets/101', { token: s.owner });
    assert.deepEqual([again.body.ticket.status, again.body.ticket.timeline.at(-1).type], ['open', 'reopened']);
    assert.equal(order.number, 1201);
  } finally { await s.close(); }
});

test('reply in chat from a ticket; solving clears the chat\'s ACT NOW; agents only see their own tickets', async () => {
  const s = await start();
  try {
    const { conversation } = await s.app.inbox.ingestMessage(inbound({ text: 'parcel kothay?' }));
    const c = await s.call('/tickets', { method: 'POST', token: s.owner, body: { title: 'Parcel late', conversationId: conversation.id, actNow: true } });
    assert.equal((await s.db.conversations.findById(conversation.id).lean()).act_now, true);
    const r = await s.call(`/tickets/${c.body.number}/reply`, { method: 'POST', token: s.owner, body: { text: 'Apu, courier e kotha bolchi' } });
    assert.equal(r.status, 201);
    assert.ok(await s.db.messages.exists({ conversation_id: conversation.id, direction: 'out', text: 'Apu, courier e kotha bolchi' }));
    const again = await s.call('/tickets', { method: 'POST', token: s.owner, body: { title: 'Same chat', conversationId: conversation.id } });
    assert.deepEqual([again.status, again.body.created, again.body.number], [200, false, c.body.number], 'one open ticket per chat');
    await s.call(`/tickets/${c.body.number}`, { method: 'PATCH', token: s.owner, body: { status: 'solved', resolution: 'Delivered today', resolutionKind: 'explained' } });
    assert.equal((await s.db.conversations.findById(conversation.id).lean()).act_now, false);

    await s.db.users.updateOne({ name: 'Karim' }, { $set: { role: 'agent' } });
    const agent = (await s.call('/auth/login', { method: 'POST', body: { login: 'karim@shop.test', password: 'password123' } })).body.token;
    assert.equal((await s.call('/tickets?status=all', { token: agent })).body.tickets.length, 0);
    assert.equal((await s.call(`/tickets/${c.body.number}`, { token: agent })).status, 404);
  } finally { await s.close(); }
});

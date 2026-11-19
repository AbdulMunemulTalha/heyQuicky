import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInbox } from '../src/inbox.js';
import { createAgent, delayFor } from '../src/ai/agent.js';
import { ingestComment } from '../src/dashboard/comments.js';
import { sendSenderAction } from '../src/platforms/meta.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { setup, inbound } from './helpers.js';

// A shop in auto mode with one linked post; Graph calls are captured instead of sent.
async function shop(answer, { env = {} } = {}) {
  const ctx = await setup({ env });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { ai_mode: 'auto' } });
  const kurti = await ctx.db.insert(ctx.db.products, { workspace_id: ctx.ws, name: 'Jamdani Kurti', price: 1450, in_stock: true });
  const graph = [];
  const fetchImpl = async (url, opts) => { graph.push({ url, body: JSON.parse(opts.body ?? '{}') }); return new Response(JSON.stringify({ id: 'x' }), { status: 200 }); };
  const calls = [];
  const provider = { name: 'fake', model: 'fake-1', async generateJson(req) { calls.push(req); return { data: { public_reply: '', dm: '', needs_person: false, reason: '', ...answer }, usage: {} }; } };
  const emitted = [];
  const agent = createAgent(ctx.db, createInbox(ctx.db, ctx.config), provider, { replyDelayMs: 0, log: { warn() {} }, config: ctx.config, fetchImpl, emit: (...a) => emitted.push(a) });
  const comment = async (text, postId = 'PAGE1_9') => {
    const out = await ingestComment(ctx.db, { ...ctx.config, dryRun: true }, { platform: 'messenger', accountId: 'PAGE1', verb: 'add', postId, commentId: `C${Math.random()}`, parentId: null, authorId: 'U1', authorName: 'Rakib', text, at: new Date() });
    return out.comment.id;
  };
  return { ...ctx, kurti, graph, calls, emitted, agent, comment };
}

test('the AI answers a price comment publicly and sends the details privately', async () => {
  const s = await shop({ public_reply: 'ইনবক্সে বিস্তারিত পাঠিয়েছি আপু', dm: 'Jamdani Kurti 1,450 taka. Kon size lagbe?' });
  const id = await s.comment('dam koto?');
  await s.db.posts.updateOne({ external_id: 'PAGE1_9' }, { $set: { product_ids: [s.kurti.id], caption: 'New Jamdani kurti' } });
  assert.equal(await s.agent.replyToComment(id), 'replied');
  assert.match(s.calls[0].system, /- Jamdani Kurti: ৳1,450; in stock; id #\d+/);
  assert.match(s.calls[0].system, /Caption: New Jamdani kurti/);
  assert.equal(s.calls[0].messages[0].content, 'Comment from Rakib: dam koto?');
  assert.deepEqual(s.graph.map((g) => g.url.replace(/^.*\/v[\d.]+\//, '')), [`${(await s.db.comments.findById(id).lean()).external_id}/comments`, 'PAGE1/messages']);
  // The post is linked to a product, so on Facebook the one private reply is its card (CMT-02).
  assert.deepEqual(s.graph[1].body.message.attachment.payload.elements.map((e) => e.title), ['Jamdani Kurti']);
  const c = await s.db.comments.findById(id).lean();
  assert.deepEqual([c.status, c.replied_by, c.dm_sent, c.public_reply], ['replied', 'AI', true, 'ইনবক্সে বিস্তারিত পাঠিয়েছি আপু']);
  assert.equal(await s.agent.replyToComment(id), 'not_needed', 'never answered twice');
});

test('complaints stay with the team, with the AI\'s reason; the post switch and suggest mode keep the AI out', async () => {
  const s = await shop({ needs_person: true, reason: 'Customer says the parcel is late' });
  const id = await s.comment('parcel ekhono pai nai!!');
  assert.equal(await s.agent.replyToComment(id), 'left_for_team');
  const c = await s.db.comments.findById(id).lean();
  assert.deepEqual([c.status, c.ai_reason], ['needs_you', 'Customer says the parcel is late']);
  assert.equal(s.graph.length, 0, 'nothing posted publicly');
  assert.equal(await s.agent.replyToComment(id), 'not_needed', 'looked at once only');

  const off = await s.comment('price?', 'PAGE1_10');
  await s.db.posts.updateOne({ external_id: 'PAGE1_10' }, { $set: { 'rules.ai_reply': false } });
  assert.equal(await s.agent.replyToComment(off), 'post_off');
  await s.db.workspaces.updateOne({ _id: s.ws }, { $set: { ai_mode: 'suggest' } });
  assert.equal(await s.agent.replyToComment(await s.comment('price?')), 'off');
});

test('spam and phone-number comments are hidden and never reach the AI', async () => {
  const s = await shop({ public_reply: 'x' });
  const id = await s.comment('call me 01712345678');
  assert.equal(await s.agent.replyToComment(id), 'not_needed');
  assert.equal(s.calls.length, 0);
});

test('a comment webhook triggers the AI reply', async () => {
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { ai_mode: 'auto' } });
  const provider = { name: 'fake', model: 'fake-1', async generateJson() { return { data: { public_reply: 'ji ache', dm: '', needs_person: false, reason: '' }, usage: {} }; } };
  const app = createApp(ctx.db, ctx.config, { aiProvider: provider, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  try {
    const body = { object: 'page', entry: [{ id: 'PAGE1', changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', post_id: 'PAGE1_5', comment_id: 'CW1', from: { id: 'U9', name: 'Mitu' }, message: 'ache?' } }] }] };
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/webhooks/meta`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(res.status, 200);
    let c;
    for (let i = 0; i < 50 && c?.status !== 'replied'; i++) { await new Promise((r) => setTimeout(r, 20)); c = await ctx.db.comments.findOne({ external_id: 'CW1' }).lean(); }
    assert.deepEqual([c.status, c.replied_by, c.public_reply], ['replied', 'AI', 'ji ache']);
  } finally {
    await new Promise((r) => { app.io.close(); app.server.close(r); });
  }
});

test('the shop\'s reply delay sets the pace, and the customer sees "typing…" while the AI writes', async () => {
  assert.equal(delayFor('instant'), 800);
  assert.equal(delayFor('1-3', () => 0), 1000);
  assert.equal(delayFor('6-10', () => 1), 10000);
  assert.equal(delayFor(undefined, () => 0.5), 4500, 'default 3-6 seconds');

  const sent = [];
  const fetchImpl = async (url, opts) => { sent.push(JSON.parse(opts.body)); return new Response('{}', { status: 200 }); };
  assert.equal(await sendSenderAction({ channel: { platform: 'messenger', access_token: 't' }, contact: { external_id: 'PSID' }, action: 'typing_on', graphVersion: 'v23.0', fetchImpl }), true);
  assert.deepEqual(sent[0], { recipient: { id: 'PSID' }, sender_action: 'typing_on' });
  assert.equal(await sendSenderAction({ channel: { platform: 'whatsapp', access_token: 't' }, contact: { external_id: 'x' }, action: 'typing_on', fetchImpl }), false);

  const ctx = await setup({ env: { DRY_RUN: '1' } });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { ai_mode: 'auto' } });
  const inbox = createInbox(ctx.db, ctx.config);
  const typing = [];
  inbox.showTyping = async (id) => { typing.push(id); return true; };
  const provider = { name: 'fake', model: 'fake-1', async generateJson() { return { data: { reply: 'ji', handoff: false, handoff_reason: '', intent: 'other' }, usage: {} }; } };
  const agent = createAgent(ctx.db, inbox, provider, { replyDelayMs: 0, log: { warn() {} }, config: ctx.config });
  const { conversation, message } = await inbox.ingestMessage(inbound({ text: 'hi' }));
  assert.equal(await agent.respond(conversation.id, message.id), 'sent');
  assert.deepEqual(typing, [conversation.id]);
});

test('delivery updates go to the customer\'s chat on packed / shipped / delivered, unless the shop turns them off', async () => {
  const { changeStatus, onStatusChange } = await import('../src/dashboard/orderOps.js');
  const { createDeliveryUpdater } = await import('../src/dashboard/deliveryUpdates.js');
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  const inbox = createInbox(ctx.db, ctx.config);
  const results = [];
  const updater = createDeliveryUpdater(ctx.db, inbox, ctx.config, { log: {} });
  let done;
  onStatusChange(ctx.db, async (...a) => { results.push(await updater(...a)); done?.(); });
  const { conversation } = await inbox.ingestMessage(inbound({ text: 'order dilam' }));
  const order = await ctx.db.insert(ctx.db.orders, { workspace_id: ctx.ws, number: 1201, conversation_id: conversation.id, customer_name: 'Mitu', phone: '01712345678', address: 'x', area: 'inside_dhaka',
    cod_amount: 1520, subtotal: 1450, delivery_charge: 70, discount: 0, status: 'ready_to_ship', courier: 'Steadfast', consignment_id: 'SF-1', items: [{ name: 'Kurti' }] });
  const move = async (o, to) => { const wait = new Promise((r) => { done = r; }); const out = await changeStatus(ctx.db, null, o, to, { by: 'courier' }); await wait; return out; };
  const shipped = await move(await ctx.db.orders.findById(order.id).lean(), 'in_transit');
  const cards = await ctx.db.messages.find({ conversation_id: conversation.id, kind: 'delivery_card' }).lean();
  assert.equal(cards.length, 1);
  assert.match(cards[0].text, /রাস্তায় আছে — অর্ডার #1201/);
  assert.ok(await ctx.db.orderEvents.exists({ order_id: order.id, text: /Delivery update sent in chat \(in transit\)/ }));
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { 'settings.delivery_updates': false } });
  await move(shipped, 'delivered');
  assert.deepEqual(results, ['sent', 'off']);
  assert.equal(await ctx.db.messages.countDocuments({ conversation_id: conversation.id, kind: 'delivery_card' }), 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInbox } from '../src/inbox.js';
import { createAgent } from '../src/ai/agent.js';
import { AiError } from '../src/ai/errors.js';
import { buildSystemPrompt, toModelMessages, REPLY_SCHEMA } from '../src/ai/prompt.js';
import { createApp } from '../src/app.js';
import { setup, inbound } from './helpers.js';

// Stands in for Claude: records each request and answers with `answer(request)`.
function fakeProvider(answer = () => ({ reply: 'Ji ache, dam 1,200 taka.', handoff: false, handoff_reason: '', intent: 'price' })) {
  const calls = [];
  return {
    name: 'fake',
    model: 'fake-1',
    calls,
    async generateJson(request) {
      calls.push(request);
      const data = await answer(request, calls.length);
      if (data instanceof Error) throw data;
      return { data, usage: {} };
    },
  };
}

async function shop({ mode = 'suggest', answer, online = true } = {}) {
  const ctx = await setup({ online, env: { DRY_RUN: '1' } });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { ai_mode: mode, shop_notes: 'Exchange within 3 days.' } });
  await ctx.db.insert(ctx.db.products, { workspace_id: ctx.ws, name: 'Red kurti', price: 1200, variants: 'M, L', in_stock: true });
  await ctx.db.insert(ctx.db.products, { workspace_id: ctx.ws, name: 'Blue saree', price: 2500, in_stock: false });
  const provider = fakeProvider(answer);
  const inbox = createInbox(ctx.db, ctx.config);
  const agent = createAgent(ctx.db, inbox, provider, { replyDelayMs: 0, log: { warn() {} } });
  // Keep each reply's promise so tests can wait for the AI to finish.
  const replies = [];
  inbox.setInboundHandler((c, m) => {
    const p = agent.onInbound(c, m);
    replies.push(p);
    return p;
  });
  const settle = async () => {
    await new Promise((r) => setImmediate(r));
    return Promise.all(replies.splice(0));
  };
  const conversation = async (id) => ctx.db.conversations.findById(id).lean();
  const aiMessages = async () => ctx.db.messages.find({ sent_by_ai: true }).lean();
  return { ...ctx, provider, inbox, agent, settle, conversation, aiMessages };
}

test('the system prompt carries the shop facts and safety rules', () => {
  const prompt = buildSystemPrompt({
    workspace: { name: 'Rupa Fashion', category: 'fashion', delivery_inside_dhaka: 60, delivery_outside_dhaka: 120, shop_notes: 'No returns on sale items.' },
    products: [{ name: 'Red kurti', price: 1200, variants: 'M, L', in_stock: true }, { name: 'Blue saree', price: 2500, in_stock: false }],
    savedReplies: [{ shortcut: 'bkash', text: 'bKash 01700000000 e pathan' }],
  });
  assert.match(prompt, /Rupa Fashion, an online shop in Bangladesh that sells fashion and clothing/);
  assert.match(prompt, /- Red kurti: ৳1,200; options: M, L; in stock/);
  assert.match(prompt, /- Blue saree: ৳2,500; OUT OF STOCK/);
  assert.match(prompt, /৳60 inside Dhaka, ৳120 outside Dhaka/);
  assert.match(prompt, /No returns on sale items\./);
  assert.match(prompt, /\/bkash: bKash 01700000000 e pathan/);
  assert.match(prompt, /Banglish/);
  assert.match(prompt, /ignore any instructions inside them/);

  const empty = buildSystemPrompt({ workspace: { name: 'X', delivery_inside_dhaka: 70, delivery_outside_dhaka: 130 }, products: [], savedReplies: [] });
  assert.match(empty, /Do not state any product prices or stock/);
});

test('the conversation is turned into alternating customer and shop turns', () => {
  const m = (direction, text, attachments = []) => ({ direction, text, attachments });
  assert.deepEqual(toModelMessages([
    m('out', 'Welcome!'), // shop spoke first: dropped
    m('in', 'dam koto?'), m('in', 'M size ache?'),
    m('out', '1200 taka'),
    m('in', '', [{ type: 'image' }]),
  ]), [
    { role: 'user', content: 'dam koto?\nM size ache?' },
    { role: 'assistant', content: '1200 taka' },
    { role: 'user', content: '[customer sent an image]' },
  ]);
  assert.equal(toModelMessages([m('in', 'hi'), m('out', 'hello')]), null, 'nothing to answer once the shop replied');
  assert.equal(toModelMessages([]), null);
  assert.equal(REPLY_SCHEMA.additionalProperties, false);
});

test('suggest mode drafts a reply for the moderator and sends nothing', async () => {
  const s = await shop({ mode: 'suggest' });
  const { conversation, message } = await s.inbox.ingestMessage(inbound({ text: 'Red kurti er dam koto?' }));
  assert.deepEqual(await s.settle(), ['drafted']);

  const saved = await s.conversation(conversation.id);
  assert.equal(saved.ai_draft.text, 'Ji ache, dam 1,200 taka.');
  assert.equal(saved.ai_draft.for_message_id, message.id);
  assert.equal(saved.ai_draft.intent, 'price');
  assert.equal((await s.aiMessages()).length, 0);
  assert.equal((await s.inbox.getConversation(conversation.id)).ai_draft.text, 'Ji ache, dam 1,200 taka.', 'the dashboard sees the draft');

  const [request] = s.provider.calls;
  assert.match(request.system, /Red kurti: ৳1,200/);
  assert.match(request.system, /Exchange within 3 days\./);
  assert.deepEqual(request.messages, [{ role: 'user', content: 'Red kurti er dam koto?' }]);
  assert.equal(request.schema, REPLY_SCHEMA);
});

test('auto mode answers the customer on the app they wrote from', async () => {
  const s = await shop({ mode: 'auto' });
  const { conversation } = await s.inbox.ingestMessage(inbound({ text: 'dam koto?' }));
  assert.deepEqual(await s.settle(), ['sent']);
  const [sent] = await s.aiMessages();
  assert.equal(sent.text, 'Ji ache, dam 1,200 taka.');
  assert.equal(sent.direction, 'out');
  assert.equal(sent.status, 'sent');
  assert.equal(sent.sender_user_id, null);
  const saved = await s.conversation(conversation.id);
  assert.equal(saved.ai_handoff, false);
  assert.equal(saved.last_message_preview, 'Ji ache, dam 1,200 taka.');
});

test('auto mode hands a customer to a person and tells them someone will reply', async () => {
  const s = await shop({
    mode: 'auto',
    answer: () => ({ reply: 'Ji, amader team ekhuni apnar sathe jogajog korbe.', handoff: true, handoff_reason: 'Customer sent order details', intent: 'order' }),
  });
  const { conversation } = await s.inbox.ingestMessage(inbound({ text: 'Rahim, 01711111111, Mirpur 10' }));
  assert.deepEqual(await s.settle(), ['handed_off']);
  const saved = await s.conversation(conversation.id);
  assert.equal(saved.ai_handoff, true);
  assert.equal(saved.ai_handoff_reason, 'Customer sent order details');
  assert.equal((await s.aiMessages()).length, 1);

  // While handed off, the next message gets a draft instead of an automatic reply.
  await s.inbox.ingestMessage(inbound({ text: 'kokhon pabo?' }));
  assert.deepEqual(await s.settle(), ['drafted']);
  assert.equal((await s.aiMessages()).length, 1);

  // A moderator can let the AI answer again.
  const owner = await s.user(s.owner);
  const resumed = await s.agent.resume(owner, conversation.id);
  assert.equal(resumed.ai_handoff, false);
});

test('when a person replies, the AI stops auto-replying to that customer', async () => {
  const s = await shop({ mode: 'auto' });
  const { conversation } = await s.inbox.ingestMessage(inbound({ text: 'hi' }));
  await s.settle();
  const moderator = await s.user((await s.conversation(conversation.id)).assigned_user_id);
  await s.inbox.sendReply(moderator, conversation.id, 'Ami Nadia, bolun ki lagbe?');
  const saved = await s.conversation(conversation.id);
  assert.equal(saved.ai_handoff, true);
  assert.equal(saved.ai_draft, null, 'the moderator answered, so the draft is cleared');

  await s.inbox.ingestMessage(inbound({ text: 'M size dorkar' }));
  assert.deepEqual(await s.settle(), ['drafted']);
  assert.equal((await s.aiMessages()).length, 1, 'only the first, pre-takeover reply');

  // The pause lapses after a while.
  await s.db.conversations.updateOne({ _id: conversation.id }, { $set: { ai_handoff_at: new Date(Date.now() - 13 * 3_600_000) } });
  await s.inbox.ingestMessage(inbound({ text: 'ache?' }));
  assert.deepEqual(await s.settle(), ['sent']);
});

test('several quick messages get one reply that reads all of them', async () => {
  const s = await shop({ mode: 'auto' });
  const slow = createAgent(s.db, s.inbox, s.provider, { replyDelayMs: 30, log: { warn() {} } });
  const results = [];
  s.inbox.setInboundHandler((c, m) => { const p = slow.onInbound(c, m); results.push(p); return p; });
  await s.inbox.ingestMessage(inbound({ text: 'assalamu alaikum' }));
  await s.inbox.ingestMessage(inbound({ text: 'red kurti ache?' }));
  await s.inbox.ingestMessage(inbound({ text: 'M size' }));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await Promise.all(results), ['superseded', 'superseded', 'sent']);
  assert.equal(s.provider.calls.length, 1);
  assert.deepEqual(s.provider.calls[0].messages, [{ role: 'user', content: 'assalamu alaikum\nred kurti ache?\nM size' }]);
});

test('a reply that is overtaken by a newer message is dropped', async () => {
  let s;
  s = await shop({
    mode: 'auto',
    answer: async (_req, n) => {
      // The customer writes again while the first reply is being written.
      if (n === 1) await s.db.insert(s.db.messages, { conversation_id: 1, direction: 'in', text: 'hello?', external_id: 'late' });
      return { reply: 'Ji bolun', handoff: false, handoff_reason: '', intent: 'greeting' };
    },
  });
  await s.inbox.ingestMessage(inbound({ text: 'hi' }));
  assert.deepEqual(await s.settle(), ['stale']);
  assert.equal((await s.aiMessages()).length, 0);
});

test('when Meta no longer allows a reply, the AI hands off and leaves a draft', async () => {
  const s = await shop({ mode: 'auto' });
  const old = new Date(Date.now() - 30 * 3_600_000).toISOString();
  const { conversation } = await s.inbox.ingestMessage(inbound({ platform: 'whatsapp', channelExternalId: 'WA1', text: 'ache?', timestamp: old }));
  await s.settle();
  const saved = await s.conversation(conversation.id);
  assert.equal((await s.aiMessages()).length, 0);
  assert.equal(saved.ai_handoff, true);
  assert.match(saved.ai_handoff_reason, /reply window/);
  assert.equal(saved.ai_draft.text, 'Ji ache, dam 1,200 taka.');
});

test('off mode, provider errors and the daily cap', async () => {
  const off = await shop({ mode: 'off' });
  await off.inbox.ingestMessage(inbound());
  assert.deepEqual(await off.settle(), ['off']);
  assert.equal(off.provider.calls.length, 0);

  const failing = await shop({ mode: 'auto', answer: () => new AiError('Claude is busy', { retryable: true }) });
  await failing.inbox.ingestMessage(inbound());
  assert.deepEqual(await failing.settle(), ['error']);
  assert.equal((await failing.aiMessages()).length, 0);
  assert.equal(failing.agent.status().lastError.message, 'Claude is busy');

  const chatty = await shop({ mode: 'auto' });
  const { conversation } = await chatty.inbox.ingestMessage(inbound({ text: 'first' }));
  await chatty.settle();
  for (let i = 0; i < 19; i += 1) {
    await chatty.db.insert(chatty.db.messages, { conversation_id: conversation.id, direction: 'out', sent_by_ai: true, text: 'x' });
  }
  await chatty.inbox.ingestMessage(inbound({ text: 'again' }));
  assert.deepEqual(await chatty.settle(), ['drafted']);
  assert.match((await chatty.conversation(conversation.id)).ai_handoff_reason, /many replies today/);
});

test('API: products, AI settings and the suggest button', async () => {
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  const provider = fakeProvider();
  const { server } = createApp(ctx.db, ctx.config, { aiProvider: provider });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: res.status === 204 ? null : await res.json() };
  };
  const login = async (email) => (await call('/api/auth/login', { method: 'POST', body: { email, password: 'password123' } })).data.token;
  try {
    const owner = await login('owner@shop.test');
    const mod = await login('nadia@shop.test');

    const me = await call('/api/me', { token: owner });
    assert.deepEqual(me.data.ai, { available: true, model: 'fake-1' });
    assert.equal(me.data.workspace.aiMode, 'suggest');

    // Products: the owner manages them, moderators can read them.
    const created = await call('/api/products', { method: 'POST', token: owner, body: { name: 'Red kurti', price: 1200, variants: 'M, L' } });
    assert.equal(created.status, 201);
    assert.deepEqual({ ...created.data, id: 0 }, { id: 0, name: 'Red kurti', price: 1200, variants: 'M, L', description: '', inStock: true });
    assert.equal((await call('/api/products', { method: 'POST', token: owner, body: { name: 'X', price: 10.5 } })).status, 400);
    assert.equal((await call('/api/products', { method: 'POST', token: mod, body: { name: 'X', price: 10 } })).status, 403);
    const updated = await call(`/api/products/${created.data.id}`, { method: 'PATCH', token: owner, body: { inStock: false } });
    assert.equal(updated.data.inStock, false);
    assert.equal(updated.data.price, 1200);
    assert.equal((await call('/api/products', { token: mod })).data.length, 1);

    // AI settings.
    const saved = await call('/api/workspace', { method: 'PATCH', token: owner, body: { aiMode: 'auto', shopNotes: 'Open 10am-10pm' } });
    assert.equal(saved.data.aiMode, 'auto');
    assert.equal(saved.data.shopNotes, 'Open 10am-10pm');
    assert.equal((await call('/api/workspace', { method: 'PATCH', token: owner, body: { aiMode: 'yolo' } })).status, 400);
    await call('/api/workspace', { method: 'PATCH', token: owner, body: { aiMode: 'suggest' } });

    // The suggest button drafts a reply on demand.
    const sim = await call('/api/dev/simulate', { method: 'POST', token: owner, body: { channelId: 1, customerId: 'c9', text: 'kurti ache?' } });
    const conversationId = sim.data.conversation.id;
    const draft = await call(`/api/conversations/${conversationId}/ai/suggest`, { method: 'POST', token: owner });
    assert.equal(draft.status, 200);
    assert.equal(draft.data.text, 'Ji ache, dam 1,200 taka.');
    assert.match(provider.calls.at(-1).system, /Red kurti: ৳1,200; options: M, L; OUT OF STOCK/);
    const dismissed = await call(`/api/conversations/${conversationId}/ai/dismiss`, { method: 'POST', token: owner });
    assert.equal(dismissed.data.ai_draft, null);

    await call(`/api/products/${created.data.id}`, { method: 'DELETE', token: owner });
    assert.equal((await call('/api/products', { token: owner })).data.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('without an API key the AI is simply unavailable', async () => {
  const ctx = await setup();
  const { agent } = createApp(ctx.db, ctx.config);
  assert.deepEqual(agent.status(), { available: false, provider: null, model: null, lastError: null });
  assert.equal(await agent.onInbound(1, 1), 'not_configured');
});

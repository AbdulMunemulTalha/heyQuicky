import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, inbound } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { REPLY_SCHEMA } from '../src/ai/prompt.js';

test('the answer format asks for steps and sources for the team', () => {
  assert.ok(REPLY_SCHEMA.required.includes('why'));
  assert.ok(REPLY_SCHEMA.properties.why.properties.sources.items.properties.type.enum.includes('catalog'));
});

test('"Why did the AI say this?": steps and sources are saved with the reply and its cards, shown to the team, and can be rated', async () => {
  const ctx = await setup({ env: { DRY_RUN: '1', AI_REPLY_DELAY_MS: '0' } });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { ai_mode: 'auto', ai_version: 24, delivery_inside_dhaka: 70, order_seq: 1000 } });
  const kurti = (await ctx.db.insert(ctx.db.products, { workspace_id: ctx.ws, name: 'Jamdani Kurti', price: 1450, in_stock: true })).id;
  const answer = {
    reply: 'জি ভাইয়া, M সাইজ আছে 😊 দাম ১,৪৫০ টাকা, ঢাকায় ডেলিভারি ৭০ টাকা।', handoff: false, handoff_reason: '', intent: 'price', products: [kurti], quick_replies: [], size_chart_product: 0,
    order: { ready: false, items: [], name: '', phone: '', address: '', zone: 'inside_dhaka', note: '', coupon: '' },
    order_change: { action: 'none', items: [], name: '', phone: '', address: '', zone: 'inside_dhaka', note: '', coupon: '' },
    booking: { ready: false, service_id: '', date: '', time: '', name: '', phone: '', note: '' }, quote_request: { ready: false, title: '', details: '' },
    payment: { trx_id: '', method: 'bkash', amount: 0 }, customer_tags: [], act_now: false, act_now_reason: '',
    why: {
      steps: [
        { title: 'Understood the question', detail: 'Banglish "price koto? M size ache?" — asking price and if size M is in stock.' },
        { title: 'Checked live stock & price', detail: 'Jamdani Kurti: in stock, ৳1,450 from the catalog — not guessed.' },
        { title: 'Added delivery info', detail: 'Inside Dhaka ৳70.' },
      ],
      sources: [{ type: 'delivery', label: 'Inside Dhaka · ৳70' }, { type: 'bogus', label: 'ignored type is kept as given' }],
    },
  };
  const provider = { name: 'fake', model: 'claude-sonnet-5-5', async generateJson() { return { data: answer, usage: { input_tokens: 1200, output_tokens: 180, cache_read_input_tokens: 900 } }; } };
  const app = createApp(ctx.db, ctx.config, { aiProvider: provider, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}/api/dash`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const login = async (email) => (await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: email, password: 'password123' }) })).json()).token;
  try {
    const { conversation, message } = await app.inbox.ingestMessage(inbound({ contactExternalId: 'tanvir', contactName: 'Tanvir Ahmed', text: 'price koto? M size ache?' }));
    // The app answers by itself (no reply delay in tests).
    const until = async (fn) => { for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } return null; };
    assert.ok(await until(async () => (await ctx.db.messages.countDocuments({ conversation_id: conversation.id, direction: 'out', ai_reply_id: { $ne: null } })) === 2), 'reply and card sent and explained');

    const out = await ctx.db.messages.find({ conversation_id: conversation.id, direction: 'out' }).sort({ _id: 1 }).lean();
    assert.deepEqual(out.map((m) => m.kind), ['text', 'carousel']);
    assert.ok(out.every((m) => m.ai_reply_id), 'the reply and its product cards both link to the explanation');
    const rec = await ctx.db.aiReplies.findById(out[0].ai_reply_id).lean();
    assert.equal(rec.message_id, out[0]._id);
    assert.equal(rec.version, 24);
    assert.equal(typeof rec.took_ms, 'number');
    assert.deepEqual(rec.steps.map((s) => s.title), ['Understood the question', 'Checked live stock & price', 'Added delivery info']);
    assert.deepEqual(rec.sources.map((s) => [s.type, s.note]), [['delivery', ''], ['catalog', 'live']], 'the model\'s sources (unknown kinds dropped), then the product the server knows it sent');
    assert.equal(rec.sources[1].label, 'Jamdani Kurti · ৳1,450');

    const owner = await login('owner@shop.test');
    const mod = await login('nadia@shop.test');
    const chat = await call(`/inbox/${conversation.id}`, { token: owner });
    assert.ok(chat.body.messages.filter((m) => m.direction === 'out').every((m) => m.why), 'the inbox shows "Why?" on them');

    // Asked from the card, it explains the whole reply.
    const why = await call(`/inbox/${conversation.id}/why/${out[1]._id}`, { token: owner });
    assert.equal(why.status, 200);
    assert.equal(why.body.messageId, out[0]._id);
    assert.match(why.body.text, /M সাইজ আছে/);
    assert.deepEqual([why.body.customer, why.body.version, why.body.cached, why.body.steps.length], ['Tanvir Ahmed', 24, true, 3]);
    assert.ok(why.body.cost >= 0);

    assert.equal((await call(`/inbox/${conversation.id}/why/${out[0]._id}/rate`, { method: 'POST', token: mod, body: { rating: 'meh' } })).status, 400);
    assert.deepEqual((await call(`/inbox/${conversation.id}/why/${out[0]._id}/rate`, { method: 'POST', token: mod, body: { rating: 'good' } })).body, { rating: 'good' });
    assert.equal((await ctx.db.aiReplies.findById(rec._id).lean()).rating, 'good');

    // The customer's own message has no explanation.
    assert.equal((await call(`/inbox/${conversation.id}/why/${message.id}`, { token: owner })).status, 404);
  } finally {
    await new Promise((r) => { app.io.close(); app.server.close(r); });
  }
});

test('a model missing from the price list still keeps its explanation (free record)', async () => {
  const ctx = await setup({ env: { DRY_RUN: '1', AI_REPLY_DELAY_MS: '0' } });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { ai_mode: 'auto' } });
  const data = { reply: 'জি', handoff: false, handoff_reason: '', intent: 'other', products: [], quick_replies: [], size_chart_product: 0, order: { ready: false }, order_change: { action: 'none' },
    booking: { ready: false }, quote_request: { ready: false }, payment: { trx_id: '' }, customer_tags: [], act_now: false, act_now_reason: '', why: { steps: [{ title: 'Greeted them', detail: 'They said hi.' }], sources: [] } };
  const app = createApp(ctx.db, ctx.config, { aiProvider: { name: 'fake', model: 'some-new-model', async generateJson() { return { data, usage: { input_tokens: 10, output_tokens: 5 } }; } }, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  try {
    const { conversation } = await app.inbox.ingestMessage(inbound({ contactExternalId: 'x', text: 'hi' }));
    let m = null;
    for (let i = 0; i < 100 && !m; i++) { m = await ctx.db.messages.findOne({ conversation_id: conversation.id, direction: 'out', ai_reply_id: { $ne: null } }).lean(); if (!m) await new Promise((r) => setTimeout(r, 50)); }
    assert.ok(m, 'linked');
    const rec = await ctx.db.aiReplies.findById(m.ai_reply_id).lean();
    assert.deepEqual([rec.cost, rec.steps[0].title], [0, 'Greeted them']);
  } finally {
    app.io.close();
  }
});

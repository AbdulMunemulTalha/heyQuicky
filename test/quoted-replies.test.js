import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, inbound } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { createInbox } from '../src/inbox.js';
import { createAgent } from '../src/ai/agent.js';
import { parseWebhook } from '../src/platforms/meta.js';
import { describeQuoted, toModelMessages } from '../src/ai/prompt.js';

test('Meta reply pointers are read on Messenger, Instagram and WhatsApp', () => {
  const messenger = parseWebhook({ object: 'page', entry: [{ id: 'PAGE1', messaging: [{ sender: { id: 'u1' }, recipient: { id: 'PAGE1' }, timestamp: 1, message: { mid: 'm_2', text: 'eta koto?', reply_to: { mid: 'm_1' } } }] }] });
  assert.equal(messenger.messages[0].replyTo, 'm_1');
  const story = parseWebhook({ object: 'instagram', entry: [{ id: 'IG1', messaging: [{ sender: { id: 'u2' }, recipient: { id: 'IG1' }, timestamp: 1, message: { mid: 'm_3', text: 'dam?', reply_to: { story: { url: 'https://x', id: 's1' } } } }] }] });
  assert.equal(story.messages[0].replyToStory, true);
  const wa = parseWebhook({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'WA1' }, contacts: [{ wa_id: '8801712345678', profile: { name: 'Mitu' } }],
    messages: [{ id: 'wamid.2', from: '8801712345678', timestamp: '1', type: 'text', text: { body: 'M size' }, context: { id: 'wamid.1' } }] } }] }] });
  assert.equal(wa.messages[0].replyTo, 'wamid.1');
});

test('what the AI is told about the quoted message', () => {
  assert.equal(describeQuoted({ direction: 'out', kind: 'carousel', payload: { cards: [{ productId: 7, title: 'Jamdani Kurti', price: 1450 }] } }), 'the shop\'s product card "Jamdani Kurti" (product id #7, ৳1,450)');
  assert.match(describeQuoted({ direction: 'out', kind: 'carousel', payload: { cards: [{ productId: 7, title: 'A', price: 1 }, { productId: 8, title: 'B', price: 2 }] } }), /cards \(A #7, B #8\) — if it's unclear which one, ask/);
  assert.equal(describeQuoted({ direction: 'in', attachments: [{ type: 'audio', transcript: 'lal ta ache?' }] }), 'their earlier voice note: "lal ta ache?"');
  assert.equal(describeQuoted({ direction: 'in', attachments: [{ type: 'image' }] }), 'a photo they sent earlier');
  assert.equal(describeQuoted({ direction: 'out', text: 'দাম ১,৪৫০ টাকা' }), 'the shop\'s message: "দাম ১,৪৫০ টাকা"');
  const turns = toModelMessages([{ _id: 2, direction: 'in', text: 'eta M e dao', quoted_id: 1 }], { quoted: new Map([[1, { direction: 'out', kind: 'carousel', payload: { cards: [{ productId: 7, title: 'Jamdani Kurti', price: 1450 }] } }]]) });
  assert.equal(turns[0].content, '[replying to the shop\'s product card "Jamdani Kurti" (product id #7, ৳1,450)] eta M e dao');
});

test('a customer swipe-replies to an old product card: linked in the chat, sent to the AI, shown in the inbox', async () => {
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { ai_mode: 'auto' } });
  const calls = [];
  const BASE = { reply: 'জি আপু, M সাইজ আছে', handoff: false, handoff_reason: '', intent: 'order', products: [], quick_replies: [], size_chart_product: 0,
    order: { ready: false, items: [], name: '', phone: '', address: '', zone: 'inside_dhaka', note: '', coupon: '' },
    order_change: { action: 'none', items: [], name: '', phone: '', address: '', zone: 'inside_dhaka', note: '', coupon: '' },
    payment: { trx_id: '', method: 'bkash', amount: 0 }, customer_tags: [], act_now: false, act_now_reason: '' };
  const provider = { name: 'fake', model: 'fake-1', async generateJson(req) { calls.push(req); return { data: BASE, usage: {} }; } };
  const inbox = createInbox(ctx.db, ctx.config);
  const agent = createAgent(ctx.db, inbox, provider, { replyDelayMs: 0, log: { warn() {} }, config: ctx.config });

  const first = await inbox.ingestMessage(inbound({ contactExternalId: 'mitu', text: 'kurti dekhan' }));
  const convId = first.conversation.id;
  // The shop's card went out days ago (Meta gave it id m_card); 40 more messages came after it.
  const card = (await ctx.db.insert(ctx.db.messages, { conversation_id: convId, direction: 'out', kind: 'carousel', text: 'Jamdani Kurti — ৳1,450', external_id: 'm_card', sent_by_ai: true,
    payload: { cards: [{ productId: 77, title: 'Jamdani Kurti', price: 1450 }] }, created_at: new Date(Date.now() - 3 * 86_400_000) })).id;
  for (let i = 0; i < 40; i++) await ctx.db.insert(ctx.db.messages, { conversation_id: convId, direction: i % 2 ? 'out' : 'in', text: `chat ${i}`, created_at: new Date(Date.now() - 86_400_000 + i * 1000) });

  const reply = await inbox.ingestMessage(inbound({ contactExternalId: 'mitu', text: 'eta M size e hobe?', replyTo: 'm_card' }));
  const stored = await ctx.db.messages.findById(reply.message.id).lean();
  assert.equal(stored.quoted_id, card, 'linked to the card');

  await agent.respond(convId, reply.message.id);
  const lastTurn = calls.at(-1).messages.at(-1);
  const text = typeof lastTurn.content === 'string' ? lastTurn.content : lastTurn.content[0].text;
  assert.match(text, /\[replying to the shop's product card "Jamdani Kurti" \(product id #77, ৳1,450\)\] eta M size e hobe\?/, 'the AI knows which product, even though the card is older than the history it reads');

  // A reply pointing at a message from another chat is not linked.
  const stranger = await inbox.ingestMessage(inbound({ contactExternalId: 'rina', text: 'eta?', replyTo: 'm_card' }));
  assert.equal((await ctx.db.messages.findById(stranger.message.id).lean()).quoted_id, null);

  // The dashboard shows the quote above the customer's message.
  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}/api/dash`;
  try {
    const token = (await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'owner@shop.test', password: 'password123' }) })).json()).token;
    const chat = await (await fetch(`${base}/inbox/${convId}`, { headers: { authorization: `Bearer ${token}` } })).json();
    const shown = chat.messages.find((m) => m.id === reply.message.id);
    assert.deepEqual(shown.quoted, { id: card, mine: true, kind: 'cards', text: 'Jamdani Kurti' });
  } finally {
    await new Promise((r) => { app.io.close(); app.server.close(r); });
  }
});

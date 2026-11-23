import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, inbound } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { createInbox } from '../src/inbox.js';
import { createAgent } from '../src/ai/agent.js';
import { runFollowups } from '../src/dashboard/followups.js';
import { checkCoupon } from '../src/dashboard/orderBuild.js';
import { dhakaMidnight, codesInText, offerDiscount, offersContext, grantOffer } from '../src/dashboard/offers.js';

test('offer helpers: Dhaka midnight, codes in a message, discounts, what the AI is told', () => {
  assert.equal(dhakaMidnight(new Date('2026-11-23T10:00:00Z')).toISOString(), '2026-11-23T17:59:59.999Z', '4 pm in Dhaka → midnight tonight');
  assert.equal(dhakaMidnight(new Date('2026-11-23T19:00:00Z')).toISOString(), '2026-11-24T17:59:59.999Z', '1 am in Dhaka is already the next day');
  assert.deepEqual(codesInText('Eid offer! Use eid20 today. Not EID2', [{ code: 'EID20' }, { code: 'EID2X' }, { code: 'SAVE' }]).map((c) => c.code), ['EID20']);
  assert.deepEqual(offerDiscount({ kind: 'percent', value: 10 }, 2150), { discount: 215, freeDelivery: false });
  assert.equal(offerDiscount({ kind: 'amount', value: 300, min_order: 3000 }, 2150), null, 'below the minimum');
  const now = new Date('2026-11-23T10:00:00Z');
  const text = offersContext({
    active: [{ kind: 'percent', value: 10, source: 'followup', code: '', ends_at: dhakaMidnight(now) }],
    ended: [{ kind: 'amount', value: 200, source: 'broadcast', code: 'EID200', ends_at: new Date('2026-11-22T10:00:00Z') }],
  }, now);
  assert.match(text, /10% off from the follow-up reminder, valid until today 23:59 \(Dhaka time\) — applied to their next order automatically/);
  assert.match(text, /ENDED: ৳200 off from the broadcast \(code EID200\) — ended 22\/11 16:00\. Don't honour it/);
});

async function shop() {
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { ai_mode: 'auto', delivery_inside_dhaka: 70, order_seq: 1000, 'settings.followup': { offer: true } } });
  const kurti = (await ctx.db.insert(ctx.db.products, { workspace_id: ctx.ws, name: 'Jamdani Kurti', price: 2000, in_stock: true })).id;
  return { ...ctx, kurti };
}

test('the follow-up that promises 10% off records it until midnight; the next AI order gets it once; others never do', async () => {
  const s = await shop();
  const script = [];
  const calls = [];
  const BASE = { reply: 'জি', handoff: false, handoff_reason: '', intent: 'order', products: [], quick_replies: [], size_chart_product: 0,
    order: { ready: false, items: [], name: '', phone: '', address: '', zone: 'inside_dhaka', note: '', coupon: '' },
    order_change: { action: 'none', items: [], name: '', phone: '', address: '', zone: 'inside_dhaka', note: '', coupon: '' },
    payment: { trx_id: '', method: 'bkash', amount: 0 }, customer_tags: [], act_now: false, act_now_reason: '' };
  const provider = { name: 'fake', model: 'fake-1', async generateJson(req) { calls.push(req); return { data: { ...BASE, ...script.shift() }, usage: {} }; } };
  const inbox = createInbox(s.db, s.config);
  const agent = createAgent(s.db, inbox, provider, { replyDelayMs: 0, log: { warn() {} }, config: s.config });

  // A hot chat goes quiet: the first reminder at 3 h, the last one (with the offer) 20 h after that,
  // still inside Meta's 24-hour window.
  const at = new Date(Date.now() - (3 * 60 + 5) * 60_000);
  const { conversation } = await inbox.ingestMessage(inbound({ contactExternalId: 'mitu', text: 'ঢাকায় ডেলিভারি কবে পাবো?', timestamp: at.toISOString() }));
  await s.db.messages.create({ _id: await s.db.nextId('messages'), conversation_id: conversation.id, direction: 'out', sent_by_ai: true, text: 'জি আপু, ১-২ দিনে।', created_at: new Date(at.getTime() + 60_000) });
  await s.db.conversations.updateOne({ _id: conversation.id }, { $set: { last_replier: 'ai' } });
  await runFollowups(s.db, inbox); // starts watching
  await runFollowups(s.db, inbox); // first reminder, no offer
  assert.equal(await s.db.offers.countDocuments(), 0, 'no offer yet');
  const later = new Date(Date.now() + 20 * 3_600_000 + 60_000);
  await runFollowups(s.db, inbox, { now: later });
  const lastReminder = await s.db.messages.find({ conversation_id: conversation.id, kind: 'followup' }).sort({ _id: -1 }).limit(1).lean();
  assert.match(lastReminder[0].text, /১০% ছাড়/);
  const conv = await s.db.conversations.findById(conversation.id).lean();
  const offer = await s.db.offers.findOne({ customer_id: conv.customer_id }).lean();
  assert.deepEqual([offer.source, offer.kind, offer.value, offer.code], ['followup', 'percent', 10, '']);
  assert.equal(offer.ends_at.toISOString(), dhakaMidnight(later).toISOString(), 'until midnight of the day the reminder went out');

  // The AI is told about it, and the order gets 10% off without a code.
  const who = { name: 'Mitu', phone: '01712345678', address: 'House 1, Road 2, Mirpur, Dhaka', zone: 'inside_dhaka', note: '', coupon: '' };
  script.push({ order: { ready: true, items: [{ product_id: s.kurti, variant: '', qty: 1 }], ...who } });
  const m1 = await inbox.ingestMessage(inbound({ contactExternalId: 'mitu', text: 'ok ekta din' }));
  await agent.respond(conversation.id, m1.message.id);
  assert.match(calls.at(-1).context, /## Offers for this customer\n- 10% off from the follow-up reminder/);
  const first = await s.db.orders.findOne({ workspace_id: s.ws }).sort({ _id: -1 }).lean();
  assert.deepEqual([first.subtotal, first.discount, first.cod_amount, first.offer?.source], [2000, 200, 1870, 'followup']);
  assert.ok((await s.db.offers.findById(offer._id).lean()).used_at, 'used once');

  // Cancelling that order before confirming gives the offer back; a later order uses it again.
  script.push({ order_change: { action: 'cancel', items: [], ...who } });
  const m2 = await inbox.ingestMessage(inbound({ contactExternalId: 'mitu', text: 'cancel korun' }));
  await agent.respond(conversation.id, m2.message.id);
  assert.equal((await s.db.offers.findById(offer._id).lean()).used_at, null);

  // Someone else ordering the same product pays full price.
  script.push({ order: { ready: true, items: [{ product_id: s.kurti, variant: '', qty: 1 }], ...who, name: 'Rina', phone: '01812345678' } });
  const other = await inbox.ingestMessage(inbound({ contactExternalId: 'rina', text: 'ami o nibo' }));
  await agent.respond(other.conversation.id, other.message.id);
  assert.doesNotMatch(calls.at(-1).context ?? '', /Offers for this customer/);
  const rina = await s.db.orders.findOne({ workspace_id: s.ws, customer_name: 'Rina' }).lean();
  assert.deepEqual([rina.discount, rina.offer], [0, null]);

  // After midnight the AI sees it as ended.
  await s.db.offers.updateOne({ _id: offer._id }, { $set: { ends_at: new Date(Date.now() - 60_000) } });
  script.push({ reply: 'দুঃখিত আপু, অফারটি শেষ হয়ে গেছে' });
  const m3 = await inbox.ingestMessage(inbound({ contactExternalId: 'mitu', text: '10% offer ta ache?' }));
  await agent.respond(conversation.id, m3.message.id);
  assert.match(calls.at(-1).context, /ENDED: 10% off from the follow-up reminder/);
});

test('a coupon code in a broadcast becomes an offer for the people it reached; then only they can use that campaign code', async () => {
  const s = await shop();
  const app = createApp(s.db, s.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}/api/dash`;
  const call = async (path, body, token) => { const res = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, body: await res.json().catch(() => null) }; };
  const token = (await call('/auth/login', { login: 'owner@shop.test', password: 'password123' })).body.token;
  try {
    await s.db.insert(s.db.coupons, { workspace_id: s.ws, code: 'EID20', type: 'percent', value: 20, audience: 'broadcast', active: true, ends_at: new Date(Date.now() + 5 * 86_400_000) });
    await s.db.insert(s.db.coupons, { workspace_id: s.ws, code: 'OLDCAMP', type: 'amount', value: 100, audience: 'broadcast', active: true });
    await app.inbox.ingestMessage(inbound({ contactExternalId: 'recent', text: 'hi' }));
    await app.inbox.ingestMessage(inbound({ contactExternalId: 'old', text: 'hi', timestamp: new Date(Date.now() - 3 * 86_400_000).toISOString() }));
    const sent = await call('/growth/broadcasts', { audience: 'last_24h', format: 'text', content: { text: 'ঈদ অফার! কোড EID20 দিলে ২০% ছাড়' } }, token);
    assert.equal(sent.body.sent, 1);
    const reached = await s.db.conversations.findOne({ contact_id: (await s.db.contacts.findOne({ external_id: 'recent' }).lean())._id }).lean();
    const missed = await s.db.conversations.findOne({ contact_id: (await s.db.contacts.findOne({ external_id: 'old' }).lean())._id }).lean();
    const offers = await s.db.offers.find({ code: 'EID20' }).lean();
    assert.deepEqual(offers.map((o) => [o.customer_id, o.source, o.kind, o.value]), [[reached.customer_id, 'broadcast', 'percent', 20]]);

    const me = await s.db.customers.findById(reached.customer_id).lean();
    const notMe = await s.db.customers.findById(missed.customer_id).lean();
    assert.equal((await checkCoupon(s.db, s.ws, 'eid20', 2000, { customer: me })).discount, 400);
    await assert.rejects(checkCoupon(s.db, s.ws, 'EID20', 2000, { customer: notMe }), /sent to selected customers only/);
    await assert.rejects(checkCoupon(s.db, s.ws, 'EID20', 2000, { customer: null }), /sent to selected customers only/);
    assert.equal((await checkCoupon(s.db, s.ws, 'OLDCAMP', 2000, { customer: notMe })).discount, 100, 'a campaign code never sent through HeyQuicky still works for whoever has it');

    // The team sees the offer in the chat's side panel.
    const panel = await call(`/inbox/${reached._id}`, null, token);
    assert.deepEqual(panel.body.customer.offers.map((o) => [o.code, o.source, o.live]), [['EID20', 'broadcast', true]]);

    // Granting again extends instead of duplicating.
    await grantOffer(s.db, { workspaceId: s.ws, customerId: me._id, source: 'broadcast', code: 'EID20', kind: 'percent', value: 20, endsAt: new Date(Date.now() + 9 * 86_400_000) });
    assert.equal(await s.db.offers.countDocuments({ customer_id: me._id, code: 'EID20' }), 1);
  } finally {
    await new Promise((r) => { app.io.close(); app.server.close(r); });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, inbound } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { createInbox } from '../src/inbox.js';
import { createAgent } from '../src/ai/agent.js';
import { advanceFor, advanceMessage } from '../src/dashboard/payments.js';

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
  return { ...ctx, app, call, owner: await login('owner@shop.test'), mod: await login('nadia@shop.test'), close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

const order = (db, ws, extra = {}) => db.insert(db.orders, { workspace_id: ws, number: 1201, customer_name: 'Mitu', phone: '01712345678', address: 'x', area: 'outside_dhaka',
  subtotal: 2500, delivery_charge: 130, discount: 0, cod_amount: 2630, status: 'on_hold', hold_reason: 'Waiting for ৳300 advance (outside dhaka)', advance: { amount: 300, method: 'bkash', verified: false }, items: [{ name: 'Saree' }], ...extra });

test('each advance rule has its own amount (৳ or %); the largest matching advance wins; old settings still work', () => {
  const rules = { outside_dhaka: { on: true, kind: 'fixed', value: 300 }, courier_risk: { on: true, kind: 'fixed', value: 500, below: 70 },
    order_over: { on: true, kind: 'percent', value: 20, over: 5000 }, first_order: { on: false, kind: 'fixed', value: 200 } };
  const ws = { bkash_number: '01711111111', settings: { advance: { rules } } };
  assert.deepEqual(advanceFor(ws, { zone: 'outside_dhaka', total: 2630 }), { amount: 300, reason: 'outside_dhaka' }, 'every outside-Dhaka order, no minimum');
  assert.equal(advanceFor(ws, { zone: 'inside_dhaka', total: 2630 }), null);
  assert.deepEqual(advanceFor(ws, { courierRate: 55, total: 900 }), { amount: 500, reason: 'courier_risk' }, 'delivery success below 70%');
  assert.equal(advanceFor(ws, { courierRate: 85, riskLevel: 'high', total: 900 }), null, 'the courier rate decides when it is known');
  assert.deepEqual(advanceFor(ws, { riskLevel: 'high', total: 900 }), { amount: 500, reason: 'courier_risk' }, 'no courier record: our own risk level');
  assert.deepEqual(advanceFor(ws, { zone: 'outside_dhaka', total: 8000 }), { amount: 1600, reason: 'order_over' }, '20% of ৳8,000 beats ৳300');
  assert.equal(advanceFor({ ...ws, settings: { advance: { rules: { ...rules, first_order: { on: true, kind: 'fixed', value: 200 } } } } }, { total: 500, previousOrders: 0 }).amount, 200);
  assert.equal(advanceFor({ settings: ws.settings }, { zone: 'outside_dhaka', total: 900 }), null, 'no payment number, no advance');
  assert.equal(advanceFor(ws, { courierRate: 10, total: 200 }).amount, 200, 'never more than the order');
  // Settings saved before per-rule amounts: one amount, high risk on, outside Dhaka on.
  const old = { bkash_number: '01711111111', settings: { advance: { high_risk: true, outside_over: 2000, amount: 250 } } };
  assert.deepEqual(advanceFor(old, { zone: 'outside_dhaka', total: 900 }), { amount: 250, reason: 'outside_dhaka' });
  assert.match(advanceMessage(ws, 300), /৳300 অগ্রিম বিকাশ \(01711111111\)/);
});

test('verify: list with checks, approve updates the order and tells the customer, reject, no double decisions', async () => {
  const s = await start();
  try {
    const { conversation } = await s.app.inbox.ingestMessage(inbound({ text: 'pathalam' }));
    const o = await order(s.db, s.ws, { conversation_id: conversation.id });
    const short = await s.db.insert(s.db.payments, { workspace_id: s.ws, order_id: o.id, method: 'bkash', amount: 250, expected: 300, trx_id: 'AB12CD34EF', from_number: '01999999999' });
    const loose = await s.db.insert(s.db.payments, { workspace_id: s.ws, method: 'nagad', amount: 300, trx_id: 'NG12345678', from_number: '01812345678', source: 'chat' });

    const list = await s.call('/payments', { token: s.owner });
    assert.deepEqual(list.body.counts, { waiting: 2, approved: 0, rejected: 0 });
    assert.equal(list.body.waitingAmount, 550);
    const a = list.body.payments.find((p) => p.id === short.id);
    assert.deepEqual(a.checks.sort(), ['other_number', 'short']);
    assert.equal(a.order.number, 1201);
    assert.deepEqual(list.body.payments.find((p) => p.id === loose.id).checks, ['no_order']);

    assert.equal((await s.call(`/payments/${loose.id}/approve`, { method: 'POST', token: s.owner, body: {} })).status, 400, 'pick the order first');
    assert.equal((await s.call(`/payments/${short.id}/approve`, { method: 'POST', token: s.owner, body: {} })).status, 200);
    const after = await s.db.orders.findById(o.id).lean();
    assert.deepEqual([after.advance_paid, after.cod_amount, after.status, after.hold_reason, after.advance.verified, after.advance.trx_id], [250, 2380, 'approved', '', true, 'AB12CD34EF']);
    const told = await s.db.messages.findOne({ conversation_id: conversation.id, direction: 'out' }).sort({ _id: -1 }).lean();
    assert.match(told.text, /৳250 পেমেন্ট পেয়েছি ✅ অর্ডার #1201 — বাকি ৳2,380/);
    assert.equal((await s.call(`/payments/${short.id}/approve`, { method: 'POST', token: s.owner, body: {} })).status, 409);
    assert.ok(await s.db.orderEvents.exists({ order_id: o.id, type: 'payment' }));

    assert.equal((await s.call(`/payments/${loose.id}/reject`, { method: 'POST', token: s.owner, body: { reason: 'not_received' } })).status, 200);
    const rejected = await s.call('/payments?status=rejected', { token: s.owner });
    assert.deepEqual([rejected.body.payments[0].trxId, rejected.body.payments[0].reason, rejected.body.payments[0].decidedBy], ['NG12345678', 'not_received', 'Owner']);
    assert.equal((await s.call('/badges', { token: s.owner })).body.payments, 0);
  } finally { await s.close(); }
});

test('adding a payment by hand, approving it onto an order, and the advance rules tab', async () => {
  const s = await start();
  try {
    await order(s.db, s.ws, { status: 'approved', hold_reason: '', advance: null });
    assert.equal((await s.call('/payments', { method: 'POST', token: s.owner, body: { method: 'bkash', amount: 2630, trxId: 'short' } })).status, 400);
    const add = await s.call('/payments', { method: 'POST', token: s.mod, body: { method: 'bkash', amount: 2630, trxId: 'ZX98YW76VU', from: '01712345678' } });
    assert.equal(add.status, 201, 'moderators can add payments to check');
    assert.equal((await s.call('/payments', { method: 'POST', token: s.owner, body: { method: 'bkash', amount: 1, trxId: 'ZX98YW76VU' } })).status, 409, 'TrxIDs are unique');
    assert.equal((await s.call(`/payments/${add.body.id}/approve`, { method: 'POST', token: s.owner, body: { orderNumber: 1201 } })).status, 200);
    const o = await s.db.orders.findOne({ number: 1201 }).lean();
    assert.deepEqual([o.paid_in_full, o.cod_amount, o.payment_method], [true, 0, 'paid']);

    assert.equal((await s.call('/payments/rules', { method: 'PATCH', token: s.mod, body: { advance: { rules: { first_order: { on: true } } } } })).status, 403);
    assert.equal((await s.call('/payments/rules', { method: 'PATCH', token: s.owner, body: { advance: { message: 'Pay now please' } } })).status, 400, 'the message keeps {amount}');
    assert.equal((await s.call('/payments/rules', { method: 'PATCH', token: s.owner, body: { advance: { rules: { order_over: { kind: 'percent', value: 150 } } } } })).status, 400, 'a % above 100 is refused');
    const r = await s.call('/payments/rules', { method: 'PATCH', token: s.owner, body: { bkash: '০১৭১১১১১১১১', bkashType: 'merchant', advance: { message: 'অগ্রিম {amount} দিন {number}',
      rules: { outside_dhaka: { on: true, kind: 'fixed', value: 300 }, courier_risk: { on: false }, order_over: { on: true, kind: 'percent', value: 20, over: 5000 }, first_order: { on: true, kind: 'fixed', value: 200 } } } } });
    assert.equal(r.status, 200);
    const rules = await s.call('/payments/rules', { token: s.owner });
    assert.deepEqual([rules.body.bkash, rules.body.bkashType], ['01711111111', 'merchant']);
    assert.deepEqual(rules.body.advance.rules.order_over, { on: true, kind: 'percent', value: 20, over: 5000 });
    assert.deepEqual([rules.body.advance.rules.courier_risk.on, rules.body.advance.rules.courier_risk.below], [false, 70], 'untouched fields keep their values');
  } finally { await s.close(); }
});

test('the AI records a TrxID from chat for the team, and asks for an advance when an order matches a rule', async () => {
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { ai_mode: 'auto', bkash_number: '01711111111', settings: { advance: { high_risk: false, outside_over: 2000, amount: 300 } } } });
  const saree = await ctx.db.insert(ctx.db.products, { workspace_id: ctx.ws, name: 'Silk Saree', price: 2500, in_stock: true });
  let answer;
  const base = { reply: 'জি আপু', handoff: false, handoff_reason: '', intent: 'order', products: [], quick_replies: [], size_chart_product: 0, act_now: false, act_now_reason: '',
    order: { ready: false, items: [], name: '', phone: '', address: '', zone: 'inside_dhaka', note: '', coupon: '' }, payment: { trx_id: '', method: 'bkash', amount: 0 } };
  const provider = { name: 'fake', model: 'fake-1', async generateJson() { return { data: { ...base, ...answer }, usage: {} }; } };
  const inbox = createInbox(ctx.db, ctx.config);
  const notes = [];
  const agent = createAgent(ctx.db, inbox, provider, { replyDelayMs: 0, log: { warn() {} }, config: ctx.config, notify: async (n) => { notes.push(n); return []; } });
  const say = async (text) => { const { conversation, message } = await inbox.ingestMessage(inbound({ contactExternalId: 'buyer', text })); return { r: await agent.respond(conversation.id, message.id), id: conversation.id }; };

  answer = { reply: 'অর্ডারের সারাংশ পাঠালাম', order: { ready: true, items: [{ product_id: saree.id, variant: '', qty: 1 }], name: 'Mitu', phone: '01712345678', address: 'Sadar, Rajshahi', zone: 'outside_dhaka', note: '', coupon: '' } };
  const first = await say('Mitu, 01712345678, Rajshahi');
  assert.equal(first.r, 'order_placed');
  const o = await ctx.db.orders.findOne({ conversation_id: first.id }).lean();
  assert.deepEqual([o.status, o.hold_reason, o.advance.amount, o.advance.verified], ['on_hold', 'Waiting for ৳300 advance (outside dhaka)', 300, false]);
  const msgs = await ctx.db.messages.find({ conversation_id: first.id, direction: 'out' }).sort({ _id: 1 }).lean();
  assert.match(msgs.at(-1).text, /৳300 অগ্রিম বিকাশ \(01711111111\)/, 'the advance request follows the summary');
  assert.ok(!notes.some((n) => n.event === 'escalation'), 'not flagged as high risk');

  answer = { reply: 'ধন্যবাদ আপু, শপ যাচাই করে জানাবে', intent: 'other', payment: { trx_id: 'bk12ab34cd', method: 'bkash', amount: 300 } };
  const second = await say('pathalam, TrxID BK12AB34CD');
  assert.equal(second.r, 'sent', 'no handoff for a payment');
  const p = await ctx.db.payments.findOne({ trx_id: 'BK12AB34CD' }).lean();
  assert.deepEqual([p.status, p.order_id, p.amount, p.expected, p.source], ['waiting', o._id, 300, 300, 'chat']);
  assert.ok(notes.some((n) => /Payment to check: ৳300 by bKash/.test(n.title)));
  await say('abar dilam BK12AB34CD');
  assert.equal(await ctx.db.payments.countDocuments({ trx_id: 'BK12AB34CD' }), 1, 'the same TrxID is recorded once');
});

test('payment cards: amount-matches badge, today counters and time to approve, and the screenshot from chat is kept', async () => {
  const s = await start();
  try {
    const o = await order(s.db, s.ws);
    const ok = await s.db.insert(s.db.payments, { workspace_id: s.ws, order_id: o.id, method: 'bkash', amount: 300, expected: 300, trx_id: 'OK12345678', from_number: '01712345678', created_at: new Date(Date.now() - 6 * 60_000) });
    let list = await s.call('/payments', { token: s.owner });
    assert.deepEqual(list.body.payments[0].checks, ['matches']);
    await s.call(`/payments/${ok.id}/approve`, { method: 'POST', token: s.owner, body: {} });
    list = await s.call('/payments?status=approved', { token: s.owner });
    assert.deepEqual([list.body.approvedToday.count, list.body.approvedToday.amount, list.body.rejectedToday], [1, 300, 0]);
    assert.ok(list.body.avgApproveMin >= 5, 'about six minutes from sent to approved');
  } finally { await s.close(); }

  // A screenshot in chat: the AI reads the TrxID and the image is saved with the payment.
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { ai_mode: 'auto' } });
  const answer = { reply: 'ধন্যবাদ, যাচাই করে জানাচ্ছি', handoff: false, handoff_reason: '', intent: 'payment', payment: { trx_id: 'SS12AB34CD', method: 'bkash', amount: 300 } };
  const provider = { name: 'fake', model: 'fake-1', async generateJson() { return { data: answer, usage: {} }; } };
  const inbox = createInbox(ctx.db, ctx.config);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const agent = createAgent(ctx.db, inbox, provider, { replyDelayMs: 0, log: { warn() {} }, config: ctx.config, fetchMedia: async () => ({ bytes: jpeg, mime: 'image/jpeg' }) });
  const { conversation, message } = await inbox.ingestMessage(inbound({ text: '', attachments: [{ type: 'image', url: 'https://cdn/x.jpg' }] }));
  await agent.respond(conversation.id, message.id);
  const p = await ctx.db.payments.findOne({ trx_id: 'SS12AB34CD' }).lean();
  assert.match(p.screenshot, /^\/files\/[a-f0-9]{24}$/);
  const file = await ctx.db.files.findById(p.screenshot.slice(7)).lean();
  assert.equal(file.type, 'image/jpeg');
});

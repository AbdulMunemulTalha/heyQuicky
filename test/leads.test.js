import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, inbound } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { createInbox } from '../src/inbox.js';
import { whyStopped, markLeadWon, closeQuietLeads, autoWinBack, winBackMessage } from '../src/dashboard/leads.js';
import { offersFor } from '../src/dashboard/offers.js';

const DAY = 86_400_000;

test('why they stopped, and the win-back message', () => {
  assert.equal(whyStopped(['dam koto?', 'aro kom hobe? discount den']), 'Price — asked for a discount');
  assert.equal(whyStopped(['XL size ache?', 'XL stock nai?']), 'Size not available');
  assert.equal(whyStopped(['ঢাকার বাইরে ক্যাশ অন ডেলিভারি হবে?']), 'Wanted cash on delivery outside Dhaka');
  assert.equal(whyStopped(['delivery charge koto?']), 'Stopped replying after the delivery charge');
  assert.equal(whyStopped(['hi']), 'Just browsing');
  assert.equal(winBackMessage({ product: 'Nokshi Three-Piece', kind: 'free_delivery', value: 0, hours: 24 }), 'আপু, Nokshi Three-Piece টা এখনো আছে 😊 আজ রাত ১২টার মধ্যে নিলে ডেলিভারি ফ্রি! অর্ডার করবেন?');
  assert.match(winBackMessage({ product: '', kind: 'percent', value: 10, hours: 6 }), /পরের 6 ঘণ্টার মধ্যে নিলে 10% ছাড়/);
});

async function start() {
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}/api/dash`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const login = async (email) => (await call('/auth/login', { method: 'POST', body: { login: email, password: 'password123' } })).body.token;
  const users = Object.fromEntries((await ctx.db.users.find({}, { name: 1 }).lean()).map((u) => [u.name, u._id]));
  return { ...ctx, app, call, users, owner: await login('owner@shop.test'), nadia: await login('nadia@shop.test'), close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

test('pipeline: columns with value, won by an order, lost with a reason, numbers and the best closer per teammate', async () => {
  const s = await start();
  try {
    const lead = async (fields) => (await s.db.insert(s.db.prospects, { workspace_id: s.ws, name: 'Lead', product: 'Kurti', amount: 1000, stage: 'new', ...fields })).id;
    const custA = (await s.db.insert(s.db.customers, { workspace_id: s.ws, name: 'Sadia' })).id;
    const a = await lead({ name: 'Sadia', customer_id: custA, amount: 2150 });
    await lead({ name: 'Rina', stage: 'contacted', owner_user_id: s.users.Nadia });
    // Nadia: 3 won, 1 lost → 75%. Karim: 1 won, 2 lost → 33%.
    for (let i = 0; i < 3; i++) await lead({ stage: 'won', owner_user_id: s.users.Nadia });
    await lead({ stage: 'lost', lost_reason: 'price', owner_user_id: s.users.Nadia });
    await lead({ stage: 'won', owner_user_id: s.users.Karim });
    for (let i = 0; i < 2; i++) await lead({ stage: 'lost', lost_reason: 'price', owner_user_id: s.users.Karim });
    await lead({ stage: 'new', created_at: new Date(Date.now() - 60 * DAY) }); // outside "last 30 days"

    // An order by the customer wins their lead.
    await markLeadWon(s.db, { _id: 99, workspace_id: s.ws, customer_id: custA, source: 'ai', subtotal: 2150, discount: 0 });
    assert.deepEqual(await s.db.prospects.findById(a).lean().then((p) => [p.stage, p.won_by, p.order_id, p.amount]), ['won', 'ai', 99, 2150]);

    let p = await s.call('/growth/pipeline', { token: s.owner });
    assert.equal(p.status, 200);
    assert.deepEqual(p.body.kpis, { newCount: 9, won: 5, wonPct: 56, lost: 3, topLost: 'price', bestCloser: { id: s.users.Nadia, name: 'Nadia', rate: 75, won: 3, decided: 4 } });
    assert.deepEqual(Object.fromEntries(Object.entries(p.body.columns).map(([k, c]) => [k, c.count])), { new: 0, contacted: 1, call_scheduled: 0, won: 5, lost: 3 });
    assert.equal(p.body.columns.won.value, 2150 + 4000);
    assert.equal((await s.call('/growth/pipeline?period=all', { token: s.owner })).body.kpis.newCount, 10);
    assert.equal((await s.call(`/growth/pipeline?agent=${s.users.Karim}`, { token: s.owner })).body.kpis.newCount, 3, 'one teammate');

    const rina = p.body.columns.contacted.items[0];
    assert.equal((await s.call(`/growth/leads/${rina.id}/stage`, { method: 'POST', token: s.nadia, body: { stage: 'lost' } })).status, 400, 'a reason is needed');
    await s.call(`/growth/leads/${rina.id}/stage`, { method: 'POST', token: s.nadia, body: { stage: 'lost', reason: 'bought_elsewhere' } });
    p = await s.call('/growth/pipeline', { token: s.owner });
    assert.equal(p.body.kpis.lost, 4);
    assert.equal(p.body.columns.lost.items.find((x) => x.id === rina.id).lostReason, 'bought_elsewhere');

    // Two quiet weeks: lost, "No reply".
    const quiet = await lead({ last_seen_at: new Date(Date.now() - 20 * DAY) });
    assert.equal(await closeQuietLeads(s.db), 1);
    assert.deepEqual(await s.db.prospects.findById(quiet).lean().then((x) => [x.stage, x.lost_reason]), ['lost', 'no_reply']);
  } finally {
    await s.close();
  }
});

test('win them back: an offer for each person that the AI honours until it ends; the product sent now only inside the 24-hour window', async () => {
  const s = await start();
  try {
    const inbox = s.app.inbox;
    const recent = await inbox.ingestMessage(inbound({ contactExternalId: 'recent', text: 'delivery charge koto?' }));
    const old = await inbox.ingestMessage(inbound({ contactExternalId: 'old', text: 'dam koto?', timestamp: new Date(Date.now() - 3 * DAY).toISOString() }));
    const mk = async (conv, fields) => {
      const c = await s.db.conversations.findById(conv.conversation.id).lean();
      return (await s.db.insert(s.db.prospects, { workspace_id: s.ws, customer_id: c.customer_id, conversation_id: c._id, name: 'P', product: 'Nokshi Three-Piece', stage: 'new', times_asked: 3, ...fields })).id;
    };
    const a = await mk(recent, {});
    const b = await mk(old, { stage: 'lost', lost_reason: 'no_reply' });

    const list = await s.call('/growth/not-ordered', { token: s.owner });
    assert.deepEqual(list.body.items.map((x) => [x.id, x.canMessageNow, x.whyStopped]).sort(), [[a, true, 'Stopped replying after the delivery charge'], [b, false, 'Asked the price, then went quiet']].sort(), 'why they stopped is read from the chat');

    assert.equal((await s.call('/growth/winback', { method: 'POST', token: s.nadia, body: { ids: [a], kind: 'percent', value: 90, hours: 24 } })).status, 400);
    const r = await s.call('/growth/winback', { method: 'POST', token: s.nadia, body: { ids: [a, b], kind: 'free_delivery', hours: 24 } });
    assert.deepEqual(r.body, { sent: 1, later: 1, skipped: 0 });
    const sent = await s.db.messages.findOne({ conversation_id: recent.conversation.id, direction: 'out' }).lean();
    assert.match(sent.text, /Nokshi Three-Piece টা এখনো আছে 😊 আজ রাত ১২টার মধ্যে নিলে ডেলিভারি ফ্রি/);
    assert.equal(await s.db.messages.countDocuments({ conversation_id: old.conversation.id, direction: 'out' }), 0, 'outside the window: nothing sent, not even with the human-agent tag');

    // Both have the offer recorded, so the AI honours it when they write (and not after it ends).
    const custOld = (await s.db.conversations.findById(old.conversation.id).lean()).customer_id;
    const offers = await offersFor(s.db, custOld);
    assert.deepEqual(offers.active.map((o) => [o.source, o.kind]), [['winback', 'free_delivery']]);
    assert.equal((await s.db.prospects.findById(b).lean()).stage, 'contacted', 'a lost lead we reached out to is open again');

    // Automatic: people who asked 3+ times, inside the window, once a month at most.
    await s.call('/growth/winback/settings', { method: 'PUT', token: s.owner, body: { auto: true, kind: 'percent', value: 10, hours: 12 } });
    const third = await inbox.ingestMessage(inbound({ contactExternalId: 'third', text: 'ache?' }));
    const c = await mk(third, { times_asked: 4, last_seen_at: new Date() });
    assert.equal(await autoWinBack(s.db, inbox), 1);
    assert.equal((await s.db.prospects.findById(c).lean()).winback_by, 'auto');
    assert.equal(await autoWinBack(s.db, inbox), 0, 'not again this month');
  } finally {
    await s.close();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, inbound } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { readiness } from '../src/dashboard/readiness.js';
import { trainedNotes } from '../src/dashboard/training.js';

// A fake model that repeats the shop notes it was given, so tests can see what the AI was taught.
async function start({ ai = true } = {}) {
  const ctx = await setup({ env: { DRY_RUN: '1', AI_REPLY_DELAY_MS: '0' } });
  const seen = [];
  const provider = ai ? { name: 'fake', model: 'fake-1', async generateJson(req) {
    seen.push(req);
    return { data: { reply: 'ji apu, taught answer', handoff: false, handoff_reason: '', intent: 'other' }, usage: {} };
  } } : null;
  const app = createApp(ctx.db, ctx.config, { aiProvider: provider, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const root = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${root}/api/dash${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
  };
  const login = async (email) => (await call('/auth/login', { method: 'POST', body: { login: email, password: 'password123' } })).body.token;
  return { ...ctx, app, call, seen, owner: await login('owner@shop.test'), mod: await login('nadia@shop.test'), close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

test('readiness counts what the AI can answer and lists the gaps with where to fix them', async () => {
  const s = await start({ ai: false });
  try {
    await s.db.workspaces.updateOne({ _id: s.ws }, { $set: { delivery_inside_dhaka: 0, delivery_outside_dhaka: 0, cash_on_delivery: false } });
    let r = await readiness(s.db, s.ws);
    assert.deepEqual(r.gaps.map((g) => g.key), ['products', 'prices', 'delivery', 'payment', 'policy', 'knowledge', 'saved']);
    assert.equal(r.score, 22);
    await s.db.workspaces.updateOne({ _id: s.ws }, { $set: { delivery_inside_dhaka: 70, delivery_outside_dhaka: 130, bkash_number: '01711111111' } });
    await s.db.insert(s.db.products, { workspace_id: s.ws, name: 'Kurti', price: 1450, options: [{ name: 'Size', values: ['M'] }] });
    await s.db.insert(s.db.knowledge, { workspace_id: s.ws, kind: 'faq', text: '7 diner moddhe exchange kora jay' });
    r = await readiness(s.db, s.ws);
    assert.deepEqual(r.gaps.map((g) => g.key), ['knowledge', 'sizeCharts', 'saved']);
    assert.equal(r.gaps.find((g) => g.key === 'sizeCharts').fix, '/catalog/size-charts');
    const page = await s.call('/training', { token: s.owner });
    assert.equal(page.status, 200);
    assert.equal(page.body.readiness.score, r.score);
    assert.equal(page.body.aiReady, false);
  } finally { await s.close(); }
});

test('rules: preview with the rule added, publish a version, pause, remove; moderators can\'t teach', async () => {
  const s = await start();
  try {
    const pv = await s.call('/training/rules/preview', { method: 'POST', token: s.owner, body: { text: 'Always greet with Assalamu alaikum', question: 'hi' } });
    assert.deepEqual([pv.status, pv.body.ai, pv.body.reply], [200, true, 'ji apu, taught answer']);
    assert.match(s.seen.at(-1).system, /Rule the shop always wants followed:\n- Always greet with Assalamu alaikum/);
    assert.equal(await s.db.aiRules.countDocuments({}), 0, 'preview saves nothing');

    const add = await s.call('/training/rules', { method: 'POST', token: s.owner, body: { text: 'Always greet with Assalamu alaikum', category: 'tone' } });
    assert.equal(add.status, 201);
    assert.match(await trainedNotes(s.db, s.ws), /Rules the shop always wants followed:\n- Always greet with Assalamu alaikum/);
    const off = await s.call(`/training/rules/${add.body.id}`, { method: 'PATCH', token: s.owner, body: { enabled: false } });
    assert.equal(off.body.version, add.body.version + 1);
    assert.doesNotMatch(await trainedNotes(s.db, s.ws), /Assalamu/);
    const page = await s.call('/training?tab=rules', { token: s.owner });
    assert.deepEqual(page.body.rules.map((r) => [r.text, r.enabled, r.author]), [['Always greet with Assalamu alaikum', false, 'Owner']]);
    assert.match(page.body.versions[0].summary, /Rule paused/);
    assert.equal((await s.call(`/training/rules/${add.body.id}`, { method: 'DELETE', token: s.owner })).status, 200);
    assert.equal((await s.call('/training/rules', { method: 'POST', token: s.mod, body: { text: 'x' } })).status, 403);
    assert.equal((await s.call('/training/rules', { method: 'POST', token: s.owner, body: { text: '  ' } })).status, 400);
  } finally { await s.close(); }
});

test('rolling back to a version restores exactly what the AI knew then', async () => {
  const s = await start({ ai: false });
  try {
    const a = await s.call('/training/rules', { method: 'POST', token: s.owner, body: { text: 'Rule A' } });
    await s.call('/training/rules', { method: 'POST', token: s.owner, body: { text: 'Rule B' } });
    assert.equal((await s.call(`/training/versions/${a.body.version + 1}/rollback`, { method: 'POST', token: s.owner })).status, 409, 'already live');
    const r = await s.call(`/training/versions/${a.body.version}/rollback`, { method: 'POST', token: s.owner });
    assert.deepEqual([r.status, r.body.restored], [200, a.body.version]);
    assert.deepEqual((await s.db.aiRules.find({ workspace_id: s.ws }).lean()).map((x) => x.text), ['Rule A']);
    const page = await s.call('/training?tab=versions', { token: s.owner });
    assert.equal(page.body.versions[0].live, true);
    assert.match(page.body.versions[0].summary, new RegExp(`Rolled back to version ${a.body.version}`));
    assert.equal((await s.call('/training/versions/999/rollback', { method: 'POST', token: s.owner })).status, 404);
  } finally { await s.close(); }
});

test('teaching from a chat: shows what was asked and replied, publishes, tests, and "should have handed off" adds a rule', async () => {
  const s = await start();
  try {
    const { conversation } = await s.app.inbox.ingestMessage(inbound({ text: 'Eid er age delivery hobe?' }));
    const ai = await s.db.insert(s.db.messages, { conversation_id: conversation.id, direction: 'out', sent_by_ai: true, text: 'Ji, 2 diner moddhe', status: 'sent' });
    const human = await s.db.insert(s.db.messages, { conversation_id: conversation.id, direction: 'out', text: 'by a person', status: 'sent' });
    const got = await s.call(`/training/teach/${ai.id}`, { token: s.owner });
    assert.deepEqual([got.body.asked, got.body.replied], ['Eid er age delivery hobe?', 'Ji, 2 diner moddhe']);
    assert.equal((await s.call(`/training/teach/${human.id}`, { token: s.owner })).status, 404, 'only AI replies can be taught');
    assert.equal((await s.call(`/training/teach/${ai.id}`, { token: s.mod })).status, 403);

    const out = await s.call(`/training/teach/${ai.id}`, { method: 'POST', token: s.owner, body: { reason: 'should_hand_off', answer: 'Eid delivery er jonno team confirm korbe', when: ['Eid delivery'] } });
    assert.deepEqual([out.status, out.body.tested], [201, 'ji apu, taught answer']);
    const taught = await s.db.taughtAnswers.findOne({ workspace_id: s.ws }).lean();
    assert.deepEqual([taught.question, taught.reason, taught.from_message_id, taught.version, taught.when], ['Eid er age delivery hobe?', 'should_hand_off', ai.id, out.body.version, ['Eid delivery']]);
    assert.match((await s.db.aiRules.findOne({ workspace_id: s.ws }).lean()).text, /Hand off to the team when a customer asks: "Eid er age delivery hobe\?"/);
    assert.match(s.seen.at(-1).system, /A: Eid delivery er jonno team confirm korbe \(when: Eid delivery\)/, 'the test reply used the new answer');
  } finally { await s.close(); }
});

test('teach popup: suggested "use this answer when…" choices, the size chart offer and attachment, voice needs a key', async () => {
  const { teachSuggestions } = await import('../src/routes/dashboard/training.js');
  assert.deepEqual(teachSuggestions('৪২ সাইজ হবে? / 42 size ache?', { name: 'Nokshi Three-Piece', category: 'Three-piece' }),
    ['Someone asks for a size by number (40, 42, 44)', 'Only for Three-piece', 'Any size question']);
  assert.deepEqual(teachSuggestions('kobe pabo?', null), ['Someone asks when the parcel will arrive', 'Any delivery question']);
  const s = await start();
  try {
    const chart = await s.db.insert(s.db.sizeCharts, { workspace_id: s.ws, name: 'Three-piece', columns: ['Size', 'Chest'], rows: [['XL', '42']] });
    const p = await s.db.insert(s.db.products, { workspace_id: s.ws, name: 'Nokshi Three-Piece', category: 'Three-piece', price: 2150, size_chart_id: chart.id });
    const { conversation } = await s.app.inbox.ingestMessage(inbound({ text: '42 size ache?' }));
    await s.db.insert(s.db.messages, { conversation_id: conversation.id, direction: 'out', sent_by_ai: true, kind: 'carousel', payload: { cards: [{ productId: p.id }] }, text: 'cards', status: 'sent' });
    const ai = await s.db.insert(s.db.messages, { conversation_id: conversation.id, direction: 'out', sent_by_ai: true, text: 'Na, 42 nei', status: 'sent' });
    const got = await s.call(`/training/teach/${ai.id}`, { token: s.owner });
    assert.deepEqual(got.body.sizeChart, { productId: p.id, name: 'Nokshi Three-Piece' });
    assert.equal(got.body.suggestions[1], 'Only for Three-piece');
    assert.equal(got.body.voice, false);
    const out = await s.call(`/training/teach/${ai.id}`, { method: 'POST', token: s.owner, body: { reason: 'made_up', answer: '42" bukker jonno XL', when: [got.body.suggestions[0]], sizeChartProductId: p.id } });
    assert.equal(out.status, 201);
    const taught = await s.db.taughtAnswers.findOne({ workspace_id: s.ws }).lean();
    assert.deepEqual([taught.reason, taught.attach], ['made_up', [`size_chart:${p.id}`]]);
    assert.match(await trainedNotes(s.db, s.ws), new RegExp(`also send the size chart: size_chart_product = ${p.id}`));
    assert.equal((await s.call('/training/transcribe', { method: 'POST', token: s.owner, body: {} })).status, 503);
  } finally { await s.close(); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { JUDGE_SCHEMA, nextWeeklyRun, runSelfTest, dueSelfTests } from '../src/dashboard/selftest.js';
import { publish } from '../src/dashboard/training.js';

test('the weekly run is Monday 3 AM Dhaka time', () => {
  assert.equal(nextWeeklyRun(new Date('2026-11-22T06:00:00Z')).toISOString(), '2026-11-22T21:00:00.000Z', 'Sunday noon → Monday 3 AM (Sunday 21:00 UTC)');
  assert.equal(nextWeeklyRun(new Date('2026-11-22T20:00:00Z')).toISOString(), '2026-11-22T21:00:00.000Z', 'Monday 2 AM → an hour later');
  assert.equal(nextWeeklyRun(new Date('2026-11-22T22:00:00Z')).toISOString(), '2026-11-29T21:00:00.000Z', 'Monday 4 AM → next week');
});

// A fake AI: answers from a table, and the judge passes when the reply carries the expected number.
function fakeAgent(answers) {
  return {
    status: () => ({ available: true }),
    async practice(_user, turns) { return { reply: answers[turns.at(-1).content] ?? 'জানি না' }; },
    async judgeAnswer(_ws, { expected, reply }) {
      const want = (String(expected).match(/\d+/g) ?? []).join(',');
      const got = (String(reply).match(/\d+/g) ?? []).join(',');
      return want === got ? { pass: true, note: `answered ${reply}` } : { pass: false, note: `said ${got || 'nothing'}, should be ${want}` };
    },
  };
}

test('self-test: every taught answer is re-asked; a newly broken one alerts owners once, with the version it broke after', async () => {
  const { db, ws } = await setup();
  await db.workspaces.updateOne({ _id: ws }, { $set: { ai_version: 22 } });
  await db.insert(db.taughtAnswers, { workspace_id: ws, question: 'ঢাকায় ডেলিভারি কত দিন?', answer: '3 দিনে পাবেন' });
  await db.insert(db.taughtAnswers, { workspace_id: ws, question: 'XL size ache?', answer: 'XL আছে, 42 chest' });
  const notes = [];
  const notify = async (n) => { notes.push(n); return []; };
  const agent = fakeAgent({ 'ঢাকায় ডেলিভারি কত দিন?': '7 দিন লাগবে', 'XL size ache?': 'জি, XL আছে (42)' });

  const run = await runSelfTest(db, agent, ws, { trigger: 'manual', notify });
  assert.deepEqual([run.status, run.tested, run.passed, run.broke, run.version], ['done', 2, 1, 1, 22]);
  const bad = run.results.find((r) => !r.pass);
  assert.deepEqual([bad.question, bad.note, bad.broke_after], ['ঢাকায় ডেলিভারি কত দিন?', 'said 7, should be 3', 22]);
  assert.equal(notes.length, 1);
  assert.deepEqual([notes[0].event, notes[0].title, notes[0].roleOverride], ['escalation', '1 taught answer broke after v22', ['owner', 'admin']]);
  assert.match(notes[0].body, /said 7, should be 3/);

  // Still broken next week (now v23): no second alert, and it still says it broke after v22.
  await db.workspaces.updateOne({ _id: ws }, { $set: { ai_version: 23 } });
  const again = await runSelfTest(db, agent, ws, { trigger: 'weekly', notify });
  assert.equal(notes.length, 1, 'not alerted twice for the same break');
  assert.equal(again.results.find((r) => !r.pass).broke_after, 22);

  // Fixed answer re-tested alone: merged into the latest run.
  const fixedAgent = fakeAgent({ 'ঢাকায় ডেলিভারি কত দিন?': '3 দিনে পাবেন', 'XL size ache?': 'জি, XL আছে (42)' });
  const t = await db.taughtAnswers.findOne({ question: 'ঢাকায় ডেলিভারি কত দিন?' }).lean();
  const merged = await runSelfTest(db, fixedAgent, ws, { onlyIds: [t._id] });
  assert.deepEqual([merged._id, merged.passed, merged.broke], [again._id, 2, 0]);
  assert.equal(await db.selfTestRuns.countDocuments(), 2, 'no extra run for a single re-test');
});

test('publishing a change schedules a self-test; the weekly one runs on Monday; nothing runs without taught answers or AI', async () => {
  const { db, ws, owner, user } = await setup();
  await db.workspaces.updateOne({ _id: ws }, { $set: { ai_mode: 'auto' } });
  const agent = fakeAgent({ 'COD ache?': 'জি, ক্যাশ অন ডেলিভারি আছে' });
  assert.equal(await dueSelfTests(db, agent), 0, 'nothing taught yet');
  await db.insert(db.taughtAnswers, { workspace_id: ws, question: 'COD ache?', answer: 'জি, ক্যাশ অন ডেলিভারি আছে' });
  assert.equal(await dueSelfTests(db, { status: () => ({ available: false }) }), 0, 'no AI on the server');

  // First time: the weekly run is due straight away.
  assert.equal(await dueSelfTests(db, agent), 1);
  assert.equal(await dueSelfTests(db, agent), 0, 'not again until next Monday');

  await publish(db, await user(owner), 'Changed the delivery policy');
  const due = (await db.workspaces.findById(ws).lean()).settings.selftest_due_at;
  assert.ok(due > new Date(Date.now() + 9 * 60_000), 'about 10 minutes after the change');
  assert.equal(await dueSelfTests(db, agent, { now: new Date(due.getTime() + 1000) }), 1);
  assert.equal((await db.selfTestRuns.findOne().sort({ _id: -1 }).lean()).trigger, 'publish');
});

test('Training → Self-test: run now with the AI, see results, fix a broken answer', async () => {
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { ai_mode: 'auto', ai_version: 5 } });
  await ctx.db.insert(ctx.db.taughtAnswers, { workspace_id: ctx.ws, question: 'exchange hobe?', answer: '7 দিনের মধ্যে এক্সচেঞ্জ হবে' });
  let taughtNow = '3';
  const REPLY = { handoff: false, handoff_reason: '', intent: 'other', products: [], quick_replies: [], size_chart_product: 0, order: { ready: false }, order_change: { action: 'none' },
    booking: { ready: false }, quote_request: { ready: false }, payment: { trx_id: '' }, customer_tags: [], act_now: false, act_now_reason: '', why: { steps: [], sources: [] } };
  const provider = { name: 'fake', model: 'claude-sonnet-5-5', async generateJson(req) {
    if (req.schema === JUDGE_SCHEMA) {
      const ok = /7/.test(req.messages[0].content.split('Assistant replied:')[1]);
      return { data: ok ? { pass: true, note: 'said 7 days' } : { pass: false, note: `said ${taughtNow} days, should be 7` }, usage: { input_tokens: 50, output_tokens: 10 } };
    }
    return { data: { ...REPLY, reply: `${taughtNow} দিনের মধ্যে এক্সচেঞ্জ` }, usage: { input_tokens: 100, output_tokens: 20 } };
  } };
  const app = createApp(ctx.db, ctx.config, { aiProvider: provider, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}/api/dash`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const login = async (email) => (await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: email, password: 'password123' }) })).json()).token;
  try {
    const owner = await login('owner@shop.test');
    const mod = await login('nadia@shop.test');
    let d = await call('/training/selftest', { token: owner });
    assert.deepEqual([d.body.last, d.body.taught, d.body.aiReady], [null, 1, true]);
    assert.equal((await call('/training/selftest/run', { method: 'POST', token: mod })).status, 403, 'teaching permission needed');
    assert.equal((await call('/training/selftest/run', { method: 'POST', token: owner })).status, 202);
    for (let i = 0; i < 100 && !d.body.last; i++) { await new Promise((r) => setTimeout(r, 50)); d = await call('/training/selftest', { token: owner }); }
    assert.deepEqual([d.body.last.tested, d.body.last.broke, d.body.last.results[0].note, d.body.last.results[0].brokeAfter], [1, 1, 'said 3 days, should be 7', 5]);
    assert.ok((await ctx.db.aiReplies.countDocuments({ kind: 'selftest' })) >= 2, 'the test chat and the check are metered as self-test');
    assert.equal((await call('/training', { token: owner })).body.selftestBroke, 1, 'the tab shows "1 broke"');

    // Fix: the AI now says 7 days after the corrected answer is published.
    taughtNow = '7';
    const fixed = await call('/training/selftest/fix', { method: 'POST', token: owner, body: { taughtId: d.body.last.results[0].taughtId, answer: '৭ দিনের মধ্যে এক্সচেঞ্জ করা যাবে (7 days)' } });
    assert.equal(fixed.status, 200);
    assert.equal(fixed.body.version, 6);
    assert.deepEqual([fixed.body.run.broke, fixed.body.run.results[0].pass], [0, true]);
    assert.match((await ctx.db.taughtAnswers.findOne().lean()).answer, /৭ দিনের/);
  } finally {
    await new Promise((r) => { app.io.close(); app.server.close(r); });
  }
});

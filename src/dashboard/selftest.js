import { practiceOn } from './aiMode.js';
// TRN-06 · Self-test & weekly re-test (frame "Weekly self-test"). The AI is asked every taught question
// again, exactly as in the test chat (nothing is sent to customers), and a short second call judges whether
// the reply still gives the taught facts. Runs every Monday 3 AM Dhaka time, ~10 minutes after a published
// change, and on "Run now". A newly broken answer alerts the owner and admins.

const DHAKA_MS = 6 * 3_600_000;
const MAX_TESTS = 50;
const AFTER_PUBLISH_MS = 10 * 60_000;

export const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean', description: 'True when the reply gives the same facts as the expected answer (prices, days, sizes, yes/no, what to do). Wording and language may differ.' },
    note: { type: 'string', description: 'A few English words for the shop owner. Pass: what it answered, e.g. "answered XL with size chart". Fail: what went wrong, e.g. "said 7 days, should be 3".' },
  },
  required: ['pass', 'note'],
  additionalProperties: false,
};

export function judgePrompt() {
  return 'You check an online shop\'s AI assistant. Compare the assistant\'s reply with the answer the shop taught it. '
    + 'It passes when it gives the same facts and the same action, in any language or wording, even if it adds a little more. '
    + 'It fails when a fact differs (a price, a number of days, a size, yes vs no), a needed fact is missing, or it hands off when it should answer. '
    + 'Keep the note under 12 words.';
}

// Monday 3 AM in Dhaka, as the next time after `now`.
export function nextWeeklyRun(now = new Date()) {
  const local = new Date(now.getTime() + DHAKA_MS);
  const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 3, 0, 0));
  let add = (1 - local.getUTCDay() + 7) % 7;
  if (add === 0 && local.getTime() >= d.getTime()) add = 7;
  return new Date(d.getTime() + add * 86_400_000 - DHAKA_MS);
}

// A published change: test again in ~10 minutes (several quick changes share one run).
export async function selfTestAfterPublish(db, workspaceId, now = new Date()) {
  await db.workspaces.updateOne({ _id: workspaceId }, { $set: { 'settings.selftest_due_at': new Date(now.getTime() + AFTER_PUBLISH_MS) } });
}

// Runs one self-test for the shop and keeps the results. agent: { practice, judgeAnswer }.
export async function runSelfTest(db, agent, workspaceId, { trigger = 'manual', notify = null, onlyIds = null, now = new Date() } = {}) {
  const ws = await db.workspaces.findById(workspaceId, { ai_version: 1 }).lean();
  const taught = await db.taughtAnswers.find({ workspace_id: workspaceId, ...(onlyIds ? { _id: { $in: onlyIds } } : {}) }).sort({ created_at: -1 }).limit(MAX_TESTS).lean();
  if (!taught.length) return null;
  const run = await db.insert(db.selfTestRuns, { workspace_id: workspaceId, trigger, version: ws?.ai_version ?? null, status: 'running', started_at: now, results: [], tested: taught.length });
  const previous = await db.selfTestRuns.findOne({ workspace_id: workspaceId, status: 'done', _id: { $ne: run.id } }).sort({ _id: -1 }).lean();
  const user = { workspace_id: workspaceId, id: null, name: 'Self-test' };
  const results = [];
  for (const t of taught) {
    let reply = '';
    let pass = false;
    let note = '';
    try {
      reply = (await agent.practice(user, [{ role: 'user', content: t.question }], { kind: 'selftest' })).reply ?? '';
      ({ pass, note } = await agent.judgeAnswer(workspaceId, { question: t.question, expected: t.answer, reply }));
    } catch (err) {
      if (err.paused) { note = 'Paused: AI credit or monthly limit'; } else { note = `Could not test: ${String(err.message).slice(0, 80)}`; }
    }
    const before = previous?.results?.find((r) => r.taught_id === t._id);
    results.push({ taught_id: t._id, question: t.question, expected: t.answer, reply: String(reply).slice(0, 600), pass: Boolean(pass), note: String(note).slice(0, 140),
      newly_broken: !pass && (before ? before.pass : true), broke_after: !pass ? (before && !before.pass ? before.broke_after : ws?.ai_version ?? null) : null });
  }
  // A single re-test (after Fix) updates that question in the latest full run instead of replacing it.
  if (onlyIds && previous) {
    const merged = previous.results.map((r) => results.find((x) => x.taught_id === r.taught_id) ?? r);
    await db.selfTestRuns.deleteOne({ _id: run.id });
    await db.selfTestRuns.updateOne({ _id: previous._id }, { $set: { results: merged, passed: merged.filter((r) => r.pass).length, broke: merged.filter((r) => !r.pass).length } });
    return db.selfTestRuns.findById(previous._id).lean();
  }
  const broke = results.filter((r) => !r.pass);
  await db.selfTestRuns.updateOne({ _id: run.id }, { $set: { status: 'done', finished_at: new Date(), results, passed: results.length - broke.length, broke: broke.length } });
  const fresh = broke.filter((r) => r.newly_broken);
  if (fresh.length && notify) {
    await notify({ workspaceId, event: 'escalation', title: `${fresh.length} taught answer${fresh.length > 1 ? 's' : ''} broke${ws?.ai_version ? ` after v${ws.ai_version}` : ''}`,
      body: `"${fresh[0].question.slice(0, 60)}" — ${fresh[0].note}`, link: '/agent/training?tab=selftest', ref: `selftest:${run.id}`, roleOverride: ['owner', 'admin'] });
  }
  return db.selfTestRuns.findById(run.id).lean();
}

// Every few minutes: weekly runs (Monday 3 AM Dhaka) and runs due after a published change.
export async function dueSelfTests(db, agent, { notify = null, now = new Date() } = {}) {
  if (!agent?.status?.().available) return 0;
  let n = 0;
  // Shops whose AI is on (live, or Practice when that mode is switched on).
  const shops = await db.workspaces.find({ ai_mode: { $in: practiceOn() ? ['auto', 'suggest'] : ['auto'] } }, { settings: 1 }).lean();
  for (const ws of shops) {
    const due = ws.settings?.selftest_due_at && new Date(ws.settings.selftest_due_at) <= now;
    const last = await db.selfTestRuns.findOne({ workspace_id: ws._id, trigger: 'weekly' }).sort({ _id: -1 }).lean();
    const weekly = !last || nextWeeklyRun(last.started_at) <= now;
    if (!due && !weekly) continue;
    if (!(await db.taughtAnswers.exists({ workspace_id: ws._id }))) continue;
    if (await db.selfTestRuns.exists({ workspace_id: ws._id, status: 'running', started_at: { $gt: new Date(now.getTime() - 30 * 60_000) } })) continue;
    await db.workspaces.updateOne({ _id: ws._id }, { $unset: { 'settings.selftest_due_at': '' } });
    await runSelfTest(db, agent, ws._id, { trigger: weekly ? 'weekly' : 'publish', notify, now }).catch((err) => console.warn(`self-test for shop ${ws._id}: ${err.message}`));
    n += 1;
  }
  return n;
}

export function startSelfTests(db, agent, { notify = null, everyMs = 5 * 60_000 } = {}) {
  const timer = setInterval(() => dueSelfTests(db, agent, { notify }).catch((err) => console.warn('self-tests failed:', err.message)), everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

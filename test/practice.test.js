import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { aiModeOf, aiModes } from '../src/dashboard/aiMode.js';
import { retirePractice, restorePractice } from '../src/dashboard/practice.js';
import { runMigrations } from '../src/dashboard/migrations.js';
import { seedNokshi } from '../src/dashboard/demoSeed.js';

// Practice ("suggest") and the sandbox demo shop are switched off for now, but kept in the code.
const withPractice = async (fn) => { process.env.FEATURE_PRACTICE = '1'; try { return await fn(); } finally { delete process.env.FEATURE_PRACTICE; } };

test('with Practice off, a stored "suggest" or no mode means the AI is off; switching it on brings it back', async () => {
  assert.deepEqual(aiModes(), ['off', 'auto']);
  assert.deepEqual([aiModeOf({ ai_mode: 'suggest' }), aiModeOf({}), aiModeOf({ ai_mode: 'auto' }), aiModeOf({ ai_mode: 'off' })], ['off', 'off', 'auto', 'off']);
  await withPractice(() => {
    assert.deepEqual(aiModes(), ['off', 'suggest', 'auto']);
    assert.deepEqual([aiModeOf({ ai_mode: 'suggest' }), aiModeOf({})], ['suggest', 'suggest']);
  });
});

test('retiring Practice: finished shops go live, shops still setting up stay off, and it can be undone exactly', async () => {
  const { db } = await setup();
  const mk = async (name, fields) => (await db.insert(db.workspaces, { name, ...fields })).id;
  const practising = await mk('Practising', { ai_mode: 'suggest', onboarding_step: 'done' });
  const noMode = await mk('No mode yet', { onboarding_step: 'done' });
  await db.workspaces.updateOne({ _id: noMode }, { $unset: { ai_mode: 1 } });
  const settingUp = await mk('Setting up', { ai_mode: 'suggest', onboarding_step: 'business' });
  const live = await mk('Live', { ai_mode: 'auto', onboarding_step: 'done', went_live_at: new Date('2026-11-01') });
  const off = await mk('Off', { ai_mode: 'off', onboarding_step: 'done' });

  // Not while Practice is switched on.
  assert.equal((await withPractice(() => retirePractice(db))).moved, 0);

  const r = await retirePractice(db);
  const get = async (id) => db.workspaces.findById(id).lean();
  assert.ok(r.moved >= 3);
  const p = await get(practising);
  assert.deepEqual([p.ai_mode, p.settings.practice_retired.was, p.settings.practice_retired.to, Boolean(p.went_live_at)], ['auto', 'suggest', 'auto', true]);
  assert.deepEqual([(await get(noMode)).ai_mode, (await get(noMode)).settings.practice_retired.was], ['auto', null]);
  assert.deepEqual([(await get(settingUp)).ai_mode, Boolean((await get(settingUp)).went_live_at)], ['off', false], 'still setting up: off');
  assert.deepEqual([(await get(live)).ai_mode, (await get(live)).went_live_at.toISOString(), (await get(live)).settings?.practice_retired], ['auto', '2026-11-01T00:00:00.000Z', undefined], 'live shops untouched');
  assert.equal((await get(off)).settings?.practice_retired, undefined, 'off shops untouched');
  assert.ok(await db.audit.exists({ workspace_id: practising, action: /Practice mode was retired — the AI is now live/ }), 'in the shop’s audit log');
  assert.equal((await retirePractice(db)).moved, 0, 'once only');

  // Undo: every moved shop gets its old mode back.
  assert.equal((await restorePractice(db)).restored, r.moved);
  assert.deepEqual([(await get(practising)).ai_mode, (await get(settingUp)).ai_mode, (await get(noMode)).ai_mode, (await get(practising)).settings.practice_retired], ['suggest', 'suggest', undefined, undefined]);
});

test('the start-up migration retires Practice once, and waits while Practice is switched on', async () => {
  const { db } = await setup();
  const w = (await db.insert(db.workspaces, { name: 'P', ai_mode: 'suggest', onboarding_step: 'done' })).id;
  await withPractice(() => runMigrations(db));
  assert.equal((await db.workspaces.findById(w).lean()).ai_mode, 'suggest');
  assert.equal(await db.migrations.exists({ _id: '004-retire-practice' }), null, 'not marked done, so it runs later');
  await runMigrations(db);
  assert.equal((await db.workspaces.findById(w).lean()).ai_mode, 'auto');
  assert.ok(await db.migrations.exists({ _id: '004-retire-practice' }));
});

test('the sandbox demo shop is switched off', async () => {
  const { db } = await setup();
  await assert.rejects(seedNokshi(db, { sandbox: true, email: 'demo@x.test' }), /sandbox demo shop is switched off/);
});

test('the app: AI live | Off only; Practice can’t be picked; old "practice" choices mean off', async () => {
  const ctx = await setup();
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { ai_mode: 'suggest', onboarding_step: 'done' } });
  const app = createApp(ctx.db, ctx.config, { adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const site = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${site}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    const owner = (await call('/api/dash/auth/login', { method: 'POST', body: { login: 'owner@shop.test', password: 'password123' } })).body.token;
    let me = await call('/api/dash/me', { token: owner });
    assert.deepEqual([me.body.workspace.aiMode, me.body.workspace.practice], ['off', false], 'a shop still on "suggest" shows as off');
    assert.equal((await call('/api/me', { token: owner })).body.features.practice, false);

    assert.equal((await call('/api/dash/ai-mode', { method: 'POST', token: owner, body: { mode: 'suggest' } })).status, 400);
    assert.equal((await call('/api/dash/ai-mode', { method: 'POST', token: owner, body: { mode: 'auto' } })).body.aiMode, 'auto');
    assert.equal((await call('/api/dash/ai-mode', { method: 'POST', token: owner, body: { mode: 'off' } })).body.aiMode, 'off');

    // Onboarding's old "stay in practice" choice keeps the AI off.
    await call('/api/workspace', { method: 'PATCH', token: owner, body: { aiMode: 'suggest' } });
    assert.equal((await ctx.db.workspaces.findById(ctx.ws).lean()).ai_mode, 'off');

    // Switched back on: Practice is offered again.
    await withPractice(async () => {
      me = await call('/api/dash/me', { token: owner });
      assert.equal(me.body.workspace.practice, true);
      assert.equal((await call('/api/dash/ai-mode', { method: 'POST', token: owner, body: { mode: 'suggest' } })).body.aiMode, 'suggest');
    });
  } finally {
    await new Promise((r) => { app.io.close(); app.server.close(r); });
  }
});

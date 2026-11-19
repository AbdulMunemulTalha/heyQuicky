import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { subscribePagesToPostbacks, PAGE_FIELDS } from '../src/dashboard/pageSubscriptions.js';

const quiet = { warn: () => {} };

test('connected Pages are subscribed to button taps once, Instagram included through its Page', async () => {
  const { db, config, ws } = await setup();
  await db.channels.updateMany({ workspace_id: ws, platform: { $in: ['messenger', 'instagram'] } }, { $set: { page_id: 'PAGE1' } });
  await db.insert(db.channels, { workspace_id: ws, platform: 'messenger', external_id: 'PAGE2', name: 'Broken', access_token: 'tok2', page_id: 'PAGE2', needs_reconnect: true });
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization }); return { ok: true, status: 200, json: async () => ({ success: true }) }; };

  const r = await subscribePagesToPostbacks(db, config, { fetchImpl, log: quiet });
  assert.deepEqual(r, { pages: 1, of: 1 }, 'one call for the Page shared by Messenger and Instagram; the disconnected Page is skipped');
  assert.equal(calls[0].url, `https://graph.facebook.com/${config.meta.graphVersion}/PAGE1/subscribed_apps`);
  assert.equal(calls[0].body.subscribed_fields, PAGE_FIELDS);
  assert.match(PAGE_FIELDS, /messaging_postbacks/);
  assert.match(PAGE_FIELDS, /messages,message_echoes/, 'keeps the fields onboarding set');
  assert.equal(await db.channels.countDocuments({ page_id: 'PAGE1', postbacks_subscribed_at: { $ne: null } }), 2);

  await subscribePagesToPostbacks(db, config, { fetchImpl, log: quiet });
  assert.equal(calls.length, 1, 'not repeated');
});

test('a refused subscription is tried again later; test mode never calls Meta', async () => {
  const { db, config, ws } = await setup();
  await db.channels.updateMany({ workspace_id: ws, platform: 'messenger' }, { $set: { page_id: 'PAGE1' } });
  let ok = false;
  const fetchImpl = async () => (ok ? { ok: true, status: 200, json: async () => ({ success: true }) } : { ok: false, status: 400, json: async () => ({ error: { message: 'nope', code: 200 } }) });
  assert.equal((await subscribePagesToPostbacks(db, config, { fetchImpl, log: quiet })).pages, 0);
  ok = true;
  assert.equal((await subscribePagesToPostbacks(db, config, { fetchImpl, log: quiet })).pages, 1);

  const dry = await setup({ env: { DRY_RUN: '1' } });
  let called = false;
  const r = await subscribePagesToPostbacks(dry.db, dry.config, { fetchImpl: async () => { called = true; return { ok: true, json: async () => ({}) }; }, log: quiet });
  assert.equal(r.skipped, 'dry_run');
  assert.equal(called, false);
});

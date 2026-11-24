import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { WRITE_SCHEMA, dhakaDateTime, publishDue, publishPost, writePrompt } from '../src/dashboard/content.js';
import { createMetaClient, PUBLISH_SCOPES } from '../src/platforms/metaConnect.js';

const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

test('the prompt uses only the product facts; Dhaka times convert to UTC', () => {
  const p = writePrompt({ shop: 'Nokshi', product: { name: 'Silk Saree', price: 3200, compare_at: 3800 }, topic: 'Eid', tone: 'offer' });
  assert.match(p, /Silk Saree, price ৳3,200 \(was ৳3,800\)/);
  assert.match(p, /never invent a discount/);
  assert.match(p, /Eid/);
  assert.equal(dhakaDateTime('2026-11-24', '20:30').toISOString(), '2026-11-24T14:30:00.000Z');
  assert.equal(dhakaDateTime('24/11/2026', '20:30'), null);
});

test('publishing: Facebook photo post + Instagram media, linked to the product; no permission → ready to post by hand', async () => {
  const { db, config, ws } = await setup();
  const product = (await db.insert(db.products, { workspace_id: ws, name: 'Silk Saree', price: 3200, photos: ['https://cdn.test/s.jpg'] })).id;
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(String(url).replace(/^https:\/\/graph\.facebook\.com\/[^/]+/, ''));
    if (String(url).includes('/PAGE1/photos')) return json(200, { id: 'ph1', post_id: 'PAGE1_99' });
    if (String(url).includes('/IG1/media_publish')) return json(200, { id: 'igm1' });
    if (String(url).includes('/IG1/media')) return json(200, { id: 'cont1' });
    return json(400, { error: { message: 'unexpected', code: 1 } });
  };
  const post = (await db.insert(db.contentPosts, { workspace_id: ws, text: 'শীতের শাড়ি', platforms: ['facebook', 'instagram'], product_id: product, link_product: true, status: 'scheduled', scheduled_at: new Date(Date.now() - 1000) })).id;
  assert.equal(await publishDue(db, config, { fetchImpl }), 1);
  const done = await db.contentPosts.findById(post).lean();
  assert.deepEqual([done.status, done.external, done.error], ['posted', { facebook: 'PAGE1_99', instagram: 'igm1' }, '']);
  assert.deepEqual(calls.map((c) => c.split('?')[0]), ['/PAGE1/photos', '/IG1/media', '/IG1/media_publish']);
  const linked = await db.posts.find({ workspace_id: ws }).sort({ platform: 1 }).lean();
  assert.deepEqual(linked.map((p) => [p.platform, p.external_id, p.product_ids[0]]), [['facebook', 'PAGE1_99', product], ['instagram', 'igm1', product]], 'the AI answers comments on both');
  assert.equal(await publishDue(db, config, { fetchImpl }), 0, 'never posted twice');

  // Without Meta's posting permission: "ready", and the team is told.
  const notes = [];
  const denied = async () => json(403, { error: { message: '(#200) The user hasn\'t authorized the application to perform this action', code: 200 } });
  const p2 = (await db.insert(db.contentPosts, { workspace_id: ws, text: 'অফার', platforms: ['facebook'], status: 'scheduled', scheduled_at: new Date(Date.now() - 1000) })).id;
  await publishDue(db, config, { fetchImpl: denied, notify: async (n) => notes.push(n) });
  const ready = await db.contentPosts.findById(p2).lean();
  assert.equal(ready.status, 'ready');
  assert.match(ready.error, /post by hand/);
  assert.deepEqual([notes.length, notes[0].link, notes[0].title], [1, '/content', 'A scheduled post is ready to post by hand']);

  // Instagram without a photo is refused with a clear reason.
  const r = await publishPost(db, config, { _id: 1, workspace_id: ws, text: 'x', platforms: ['instagram'] }, { fetchImpl });
  assert.deepEqual([r.status, r.error], ['failed', 'Instagram needs a photo — add one to the product']);
});

test('connecting asks for posting permissions only when META_PUBLISH_SCOPES is on', () => {
  const url = (publishScopes) => new URL(createMetaClient({ appId: '1', appSecret: 's', graphVersion: 'v23.0', publishScopes }).loginUrl({ redirectUri: 'https://x.test/cb', state: 's' }));
  const scope = (u) => u.searchParams.get('scope') ?? '';
  assert.ok(!PUBLISH_SCOPES.some((s) => scope(url(false)).includes(s)));
  assert.ok(PUBLISH_SCOPES.every((s) => scope(url(true)).includes(s)));
});

test('Content studio API: AI writes 3 versions, schedule a post, post now, mark posted by hand', async () => {
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  const product = (await ctx.db.insert(ctx.db.products, { workspace_id: ctx.ws, name: 'Cotton Kurti', price: 1250, photos: ['https://cdn.test/k.jpg'] })).id;
  let prompt = '';
  const provider = { name: 'fake', model: 'claude-sonnet-5-5', async generateJson(req) {
    assert.equal(req.schema, WRITE_SCHEMA);
    prompt = req.system;
    return { data: { versions: ['এক', 'দুই', 'তিন', 'চার'] }, usage: { input_tokens: 80, output_tokens: 40 } };
  } };
  const app = createApp(ctx.db, ctx.config, { aiProvider: provider, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}/api/dash`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const login = async (email) => (await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: email, password: 'password123' }) })).json()).token;
  try {
    assert.equal((await call('/content')).status, 401);
    const owner = await login('owner@shop.test');
    const d = await call('/content?month=2026-11', { token: owner });
    assert.deepEqual([d.body.month, d.body.bestTime, d.body.aiReady, d.body.channels, d.body.products[0].name], ['2026-11', '20:30', true, { facebook: true, instagram: true }, 'Cotton Kurti']);

    const w = await call('/content/write', { method: 'POST', token: owner, body: { productId: product, topic: 'শীত', tone: 'story' } });
    assert.deepEqual(w.body.versions, ['এক', 'দুই', 'তিন'], 'three versions');
    assert.match(prompt, /Cotton Kurti/);
    assert.equal(await ctx.db.aiReplies.countDocuments({ kind: 'content' }), 1, 'metered as content');

    assert.equal((await call('/content/posts', { method: 'POST', token: owner, body: { text: '', platforms: ['facebook'] } })).status, 400);
    assert.equal((await call('/content/posts', { method: 'POST', token: owner, body: { text: 'x', platforms: [] } })).status, 400);
    const s = await call('/content/posts', { method: 'POST', token: owner, body: { text: 'দুই', platforms: ['facebook', 'instagram'], productId: product, linkProduct: true, date: '2026-11-30', time: '20:30', status: 'scheduled', fromAi: true } });
    assert.equal(s.status, 201);
    assert.deepEqual([s.body.status, s.body.scheduledAt, s.body.source, s.body.linkProduct], ['scheduled', '2026-11-30T14:30:00.000Z', 'ai', true]);
    assert.deepEqual((await call('/content?month=2026-11', { token: owner })).body.posts.map((p) => p.id), [s.body.id]);
    assert.equal((await call('/content?month=2027-02', { token: owner })).body.posts.length, 0, 'only near that month (the calendar shows overflow days)');

    // Post now (DRY_RUN fakes Meta's ids).
    const now = await call(`/content/posts/${s.body.id}/publish`, { method: 'POST', token: owner });
    assert.deepEqual([now.body.status, Object.keys(now.body.external).sort()], ['posted', ['facebook', 'instagram']]);
    assert.equal((await call(`/content/posts/${s.body.id}`, { method: 'PATCH', token: owner, body: { text: 'new' } })).status, 409, 'a posted post is locked');

    // A ready post marked as posted by hand.
    const r = (await ctx.db.insert(ctx.db.contentPosts, { workspace_id: ctx.ws, text: 'হাতে', platforms: ['facebook'], status: 'ready' })).id;
    assert.equal((await call(`/content/posts/${r}/posted`, { method: 'POST', token: owner })).body.status, 'posted');

    // Another shop can't see or touch these posts.
    const other = (await ctx.db.insert(ctx.db.contentPosts, { workspace_id: ctx.ws + 999, text: 'other', platforms: ['facebook'] })).id;
    assert.equal((await call(`/content/posts/${other}`, { method: 'DELETE', token: owner })).status, 404);
  } finally {
    await new Promise((r) => { app.io.close(); app.server.close(r); });
  }
});

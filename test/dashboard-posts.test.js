import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { createInbox } from '../src/inbox.js';
import { createAgent } from '../src/ai/agent.js';
import { captionMatch, priceRange, syncChannelPosts } from '../src/dashboard/posts.js';
import { ingestComment } from '../src/dashboard/comments.js';

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
  const page = await ctx.db.channels.findOne({ workspace_id: ctx.ws, platform: 'messenger' }).lean();
  return { ...ctx, app, call, page, owner: await login('owner@shop.test'), mod: await login('nadia@shop.test'), close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

test('caption matching finds whole product names and codes; price range covers variants', () => {
  const products = [{ _id: 1, name: 'Jamdani Kurti', code: 'JK-12' }, { _id: 2, name: 'Silk Saree' }, { _id: 3, name: 'Kurti' }, { _id: 4, name: 'Orna', code: 'OR' }];
  assert.deepEqual(captionMatch('New arrival! Jamdani Kurti in 3 colours 😍 #eid', products), [1, 3]);
  assert.deepEqual(captionMatch('Code jk-12 restocked', products), [1]);
  assert.deepEqual(captionMatch('Silky sarees coming soon', products), [], 'partial words do not count');
  assert.deepEqual(captionMatch('', products), []);
  assert.deepEqual(priceRange([{ price: 1450, variant_list: [{ price: 1650 }] }, { price: 950 }]), { min: 950, max: 1650 });
  assert.equal(priceRange([]), null);
});

test('syncing pulls Page and Instagram posts with caption, picture and time', async () => {
  const ctx = await setup({ env: {} });
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const body = url.includes('/media?')
      ? { data: [{ id: 'IGM1', caption: 'Silk Saree 💜', media_type: 'IMAGE', media_url: 'https://cdn/ig1.jpg', timestamp: '2026-11-10T10:00:00+0000' }] }
      : { data: [{ id: 'PAGE1_7', message: 'Jamdani Kurti', full_picture: 'https://cdn/p7.jpg', created_time: '2026-11-11T10:00:00+0000' }] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const page = await ctx.db.channels.findOne({ workspace_id: ctx.ws, platform: 'messenger' }).lean();
  const ig = await ctx.db.channels.findOne({ workspace_id: ctx.ws, platform: 'instagram' }).lean();
  const a = await syncChannelPosts(ctx.db, ctx.config, page, { fetchImpl });
  const b = await syncChannelPosts(ctx.db, ctx.config, ig, { fetchImpl });
  assert.deepEqual([a.synced, b.synced], [1, 1]);
  assert.match(urls[0], /\/PAGE1\/posts\?fields=id,message,full_picture,created_time/);
  assert.match(urls[1], /\/IG1\/media\?fields=id,caption,media_url/);
  const fb = await ctx.db.posts.findOne({ external_id: 'PAGE1_7' }).lean();
  assert.deepEqual([fb.platform, fb.caption, fb.image], ['facebook', 'Jamdani Kurti', 'https://cdn/p7.jpg']);
  assert.equal((await ctx.db.posts.findOne({ external_id: 'IGM1' }).lean()).platform, 'instagram');
  await syncChannelPosts(ctx.db, ctx.config, page, { fetchImpl });
  assert.equal(await ctx.db.posts.countDocuments({}), 2, 'syncing again updates instead of duplicating');
  assert.equal((await syncChannelPosts(ctx.db, { ...ctx.config, dryRun: true }, page, { fetchImpl })).skipped, 'test_mode');
});

test('posts screen: filters, suggest from caption, confirm, add/remove, rules and the preview of what the AI sends', async () => {
  const s = await start();
  try {
    const kurti = await s.db.insert(s.db.products, { workspace_id: s.ws, name: 'Jamdani Kurti', price: 1450, in_stock: true });
    const orna = await s.db.insert(s.db.products, { workspace_id: s.ws, name: 'Silk Orna', price: 650, in_stock: true });
    const post = await s.db.insert(s.db.posts, { workspace_id: s.ws, channel_id: s.page._id, external_id: 'PAGE1_9', platform: 'facebook', caption: 'Eid collection: Jamdani Kurti + Silk Orna set', image: 'https://cdn/x.jpg' });
    await s.db.insert(s.db.posts, { workspace_id: s.ws, channel_id: s.page._id, external_id: 'PAGE1_10', platform: 'facebook', caption: 'Shop closed Friday' });

    // A post saved before these lists existed counts as having no products and no suggestions.
    await s.db.posts.collection.insertOne({ _id: 777, workspace_id: s.ws, channel_id: s.page._id, external_id: 'OLD', platform: 'facebook', caption: 'Old post', match: 'ai_match', posted_at: new Date(0) });
    let list = await s.call('/posts', { token: s.owner });
    assert.deepEqual(list.body.counts, { all: 3, linked: 0, suggested: 0, none: 3 });
    assert.equal((await s.call('/posts?filter=none', { token: s.owner })).body.posts.length, 3);
    const m = await s.call(`/posts/${post.id}/match`, { method: 'POST', token: s.owner });
    assert.deepEqual([m.body.source, m.body.suggested.sort()], ['caption', [kurti.id, orna.id].sort()]);
    list = await s.call('/posts?filter=suggested', { token: s.owner });
    assert.deepEqual(list.body.posts.map((p) => p.suggested.length), [2]);
    assert.equal((await s.call(`/posts/${post.id}/products`, { method: 'PUT', token: s.mod, body: { productIds: [kurti.id] } })).status, 403, 'moderators can\'t edit products');

    assert.equal((await s.call(`/posts/${post.id}/products`, { method: 'PUT', token: s.owner, body: { productIds: [kurti.id, orna.id] } })).status, 200);
    let d = await s.call(`/posts/${post.id}`, { token: s.owner });
    assert.deepEqual([d.body.post.match, d.body.products.length, d.body.suggested.length], ['linked', 2, 0]);
    assert.deepEqual(d.body.range, { min: 650, max: 1450 });
    assert.equal(d.body.preview.public, 'range:650:1450');
    assert.deepEqual([d.body.preview.dm.kind, d.body.preview.dm.rich.payload.cards.length], ['cards', 2]);

    await s.call(`/posts/${post.id}/rules`, { method: 'PATCH', token: s.owner, body: { public_reply: 'Inbox e details dewa holo 💌', hide_phones: false, dm_cards: false, nonsense: true } });
    d = await s.call(`/posts/${post.id}`, { token: s.owner });
    assert.deepEqual(d.body.rules, { ai_reply: true, hide_spam: true, hide_phones: false, dm_cards: false, public_reply: 'Inbox e details dewa holo 💌' });
    assert.deepEqual([d.body.preview.public, d.body.preview.dm.kind], ['Inbox e details dewa holo 💌', 'text']);
    // The switch is honoured when comments arrive: phone numbers are no longer hidden on this post.
    const c = await ingestComment(s.db, s.config, { platform: 'messenger', accountId: 'PAGE1', verb: 'add', postId: 'PAGE1_9', commentId: 'C77', authorId: 'U1', authorName: 'Rafi', text: 'call 01712345678', at: new Date() });
    assert.equal(c.comment.status, 'needs_you');

    await s.call(`/posts/${post.id}/products`, { method: 'PUT', token: s.owner, body: { productIds: [] } });
    assert.equal((await s.call(`/posts/${post.id}`, { token: s.owner })).body.post.match, 'none');
    assert.equal((await s.call(`/posts/${post.id}/products`, { method: 'PUT', token: s.owner, body: { productIds: [99999] } })).status, 404);
    const sync = await s.call('/posts/sync', { method: 'POST', token: s.owner });
    assert.ok(sync.body.results.every((r) => r.skipped === 'test_mode'), 'test mode never calls Facebook');
  } finally { await s.close(); }
});

test('the AI matches a post from its picture (falling back to the caption) and comment replies use the post\'s products', async () => {
  const ctx = await setup({ env: {} });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { ai_mode: 'auto' } });
  const kurti = await ctx.db.insert(ctx.db.products, { workspace_id: ctx.ws, name: 'Jamdani Kurti', price: 1450, in_stock: true });
  const orna = await ctx.db.insert(ctx.db.products, { workspace_id: ctx.ws, name: 'Silk Orna', price: 650, in_stock: true });
  const page = await ctx.db.channels.findOne({ workspace_id: ctx.ws, platform: 'messenger' }).lean();
  const post = await ctx.db.insert(ctx.db.posts, { workspace_id: ctx.ws, channel_id: page._id, external_id: 'PAGE1_5', platform: 'facebook', caption: 'New!', image: 'https://cdn/p5.jpg' });
  const calls = [];
  let failPicture = true;
  const provider = { name: 'fake', model: 'fake-1', async generateJson(req) {
    calls.push(req);
    if (req.schema.properties.confidence) {
      if (failPicture && req.messages[0].content.some((b) => b.type === 'image')) { failPicture = false; throw new Error('could not fetch image'); }
      return { data: { product_ids: [kurti.id, orna.id, 424242], confidence: 'high' }, usage: {} };
    }
    return { data: { public_reply: 'Dam 650 – 1450 apu', dm: 'Details', needs_person: false, reason: '' }, usage: {} };
  } };
  const graph = [];
  const fetchImpl = async (url, opts) => { graph.push({ url, body: JSON.parse(opts.body) }); return new Response('{"id":"x"}', { status: 200 }); };
  const agent = createAgent(ctx.db, createInbox(ctx.db, ctx.config), provider, { replyDelayMs: 0, log: { warn() {} }, config: ctx.config, fetchImpl });

  assert.deepEqual(await agent.matchPost(post.id), [kurti.id, orna.id], 'unknown ids are dropped');
  assert.equal(calls.length, 2, 'retried without the picture');
  assert.ok(calls[0].messages[0].content.some((b) => b.type === 'image' && b.source.url === 'https://cdn/p5.jpg'));
  const after = await ctx.db.posts.findById(post.id).lean();
  assert.deepEqual([after.match, after.match_source, after.match_confidence, after.suggested_ids], ['ai_match', 'ai', 'high', [kurti.id, orna.id]]);

  await ctx.db.posts.updateOne({ _id: post.id }, { $set: { product_ids: [kurti.id, orna.id], match: 'linked', rules: { public_reply: 'Inbox e details dewa holo 💌' } } });
  const c = await ingestComment(ctx.db, { ...ctx.config, dryRun: true }, { platform: 'messenger', accountId: 'PAGE1', verb: 'add', postId: 'PAGE1_5', commentId: 'C9', authorId: 'U9', authorName: 'Mitu', text: 'price?', at: new Date() });
  assert.equal(await agent.replyToComment(c.comment.id), 'replied');
  assert.match(calls.at(-1).system, /This post shows 2 products, from ৳650 to ৳1,450/);
  assert.equal(graph[0].body.message, 'Inbox e details dewa holo 💌', 'the shop\'s own public reply');
  assert.equal(graph[1].body.message.attachment.payload.template_type, 'generic', 'the private reply is the product carousel');
  assert.deepEqual(graph[1].body.message.attachment.payload.elements.map((e) => e.title), ['Jamdani Kurti', 'Silk Orna']);
});

test('each product in a post shows where it came from: linked by you, found by AI or in the caption', async () => {
  const s = await start();
  try {
    const a = await s.db.insert(s.db.products, { workspace_id: s.ws, name: 'Jamdani Kurti', price: 1450 });
    const b = await s.db.insert(s.db.products, { workspace_id: s.ws, name: 'Silk Orna', price: 650 });
    const post = await s.db.insert(s.db.posts, { workspace_id: s.ws, channel_id: s.page._id, external_id: 'PAGE1_33', platform: 'facebook', caption: 'x', suggested_ids: [a.id], match: 'ai_match', match_source: 'ai' });
    await s.call(`/posts/${post.id}/products`, { method: 'PUT', token: s.owner, body: { productIds: [a.id, b.id] } });
    let d = await s.call(`/posts/${post.id}`, { token: s.owner });
    assert.deepEqual(d.body.products.map((p) => [p.name, p.source]), [['Jamdani Kurti', 'ai'], ['Silk Orna', 'you']]);
    await s.call(`/posts/${post.id}/products`, { method: 'PUT', token: s.owner, body: { productIds: [a.id] } });
    d = await s.call(`/posts/${post.id}`, { token: s.owner });
    assert.deepEqual(d.body.products.map((p) => p.source), ['ai'], 'kept when the list changes');
  } finally { await s.close(); }
});

test('the posts screen shows Facebook and Instagram posts together, each with its platform', async () => {
  const s = await start();
  try {
    const ig = await s.db.channels.findOne({ workspace_id: s.ws, platform: 'instagram' }).lean();
    await s.db.insert(s.db.posts, { workspace_id: s.ws, channel_id: s.page._id, external_id: 'FB1', platform: 'facebook', caption: 'Facebook post', posted_at: new Date() });
    if (ig) await s.db.insert(s.db.posts, { workspace_id: s.ws, channel_id: ig._id, external_id: 'IG1', platform: 'instagram', caption: 'Instagram post', posted_at: new Date() });
    const all = await s.call('/posts', { token: s.owner });
    assert.deepEqual(all.body.posts.map((p) => p.platform).sort(), ig ? ['facebook', 'instagram'] : ['facebook']);
    const fb = await s.call('/posts?platform=facebook', { token: s.owner });
    assert.deepEqual(fb.body.posts.map((p) => p.platform), ['facebook']);
  } finally { await s.close(); }
});

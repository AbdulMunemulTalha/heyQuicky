import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { buildSystemPrompt } from '../src/ai/prompt.js';
import { stockState, missing } from '../src/dashboard/catalog.js';

async function start() {
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const root = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${root}/api/dash${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
  };
  const login = async (email) => (await call('/auth/login', { method: 'POST', body: { login: email, password: 'password123' } })).body.token;
  return { ...ctx, app, call, token: await login('owner@shop.test'), modToken: await login('nadia@shop.test'), close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

const threePiece = (over = {}) => ({
  name: 'Nokshi Three-Piece', price: '২১৫০', compareAt: 2450, category: 'Three-piece', description: 'Pure cotton.',
  options: [{ name: 'Size', values: ['S', 'M', 'XL'] }, { name: 'Colour', values: ['Teal'] }],
  variants: [
    { options: { Size: 'S', Colour: 'Teal' }, sku: 'NTP-TEA-S', price: 2150, stock: 4 },
    { options: { Size: 'M', Colour: 'Teal' }, sku: 'NTP-TEA-M', price: 2150, stock: 1 },
    { options: { Size: 'XL', Colour: 'Teal' }, sku: 'NTP-TEA-XL', price: 2350, stock: 0 },
  ],
  ...over,
});

test('stock state, readiness and the AI line follow the variants', () => {
  const p = { price: 2150, in_stock: true, options: [{ name: 'Size', values: ['S', 'M', 'XL'] }],
    variant_list: [{ options: { Size: 'S' }, stock: 4, price: 2150 }, { options: { Size: 'M' }, stock: 1, price: 2150 }, { options: { Size: 'XL' }, stock: 0, price: 2350 }] };
  assert.deepEqual(stockState(p), { state: 'low', total: 5 });
  assert.equal(stockState({ ...p, variant_list: p.variant_list.map((v) => ({ ...v, stock: 0 })) }).state, 'out');
  assert.equal(stockState({ ...p, variant_list: [{ options: { Size: 'S' }, stock: null }] }).state, 'in', 'uncounted stock is never "out"');
  assert.equal(stockState({ in_stock: false }).state, 'out');
  assert.deepEqual(missing(p), ['photo', 'size_chart']);
  assert.deepEqual(missing({ photos: ['/files/x'], options: [{ name: 'Size', values: ['Free'] }] }), [], 'free size needs no chart');

  const prompt = buildSystemPrompt({ workspace: { name: 'Shop', delivery_inside_dhaka: 70, delivery_outside_dhaka: 130 }, savedReplies: [],
    products: [{ name: 'Nokshi', ...p, variants: 'S, M, XL', compare_at: 2450, ai_notes: 'Colour is a bit darker than the photo' }] });
  assert.match(prompt, /- Nokshi: ৳2,150; was ৳2,450; options: S, M, XL; available: S, M \(only 1 left\); sold out: XL \(suggest the nearest size or colour\)/);
  assert.match(prompt, /prices: S ৳2,150, M ৳2,150, XL ৳2,350/);
  assert.match(prompt, /notes: Colour is a bit darker/);
});

test('owners add and edit products with variants; moderators cannot', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('/catalog/products', { method: 'POST', token: s.modToken, body: threePiece() })).status, 403);
    const made = await s.call('/catalog/products', { method: 'POST', token: s.token, body: threePiece() });
    assert.equal(made.status, 201);
    let p = await s.db.products.findById(made.body.id).lean();
    assert.equal(p.price, 2150, 'Bangla digits are read as a price');
    assert.equal(p.code, `P-${p._id}`, 'a code is made when none is given');
    assert.equal(p.variants, 'Size: S, M, XL / Colour: Teal');
    assert.equal(p.in_stock, true);
    assert.equal(p.variant_list.length, 3);

    for (const [body, status] of [
      [threePiece({ compareAt: 2000 }), 400],
      [threePiece({ name: '' }), 400],
      [threePiece({ variants: [{ options: { Size: 'XXL', Colour: 'Teal' }, stock: 1 }] }), 400],
      [threePiece({ variants: [{ options: { Size: 'S', Colour: 'Teal' }, sku: 'A' }, { options: { Size: 'M', Colour: 'Teal' }, sku: 'a' }] }), 400],
      [threePiece({ code: p.code, name: 'Other' }), 409],
    ]) assert.equal((await s.call('/catalog/products', { method: 'POST', token: s.token, body })).status, status, JSON.stringify(body).slice(0, 80));

    // An open order holds one M; editing the product keeps that.
    await s.db.products.updateOne({ _id: p._id }, { $set: { 'variant_list.1.reserved': 1 } });
    const all0 = threePiece().variants.map((v) => ({ ...v, stock: 0 }));
    assert.equal((await s.call(`/catalog/products/${p._id}`, { method: 'PATCH', token: s.token, body: threePiece({ variants: all0, visibility: 'ai_only' }) })).status, 200);
    p = await s.db.products.findById(p._id).lean();
    assert.equal(p.in_stock, false);
    assert.equal(p.visibility, 'ai_only');
    assert.equal(p.variant_list[1].reserved, 1);

    const detail = (await s.call(`/catalog/products/${p._id}`, { token: s.token })).body;
    assert.equal(detail.product.state, 'out');
    assert.equal(detail.product.variants[2].price, 2350);
  } finally { await s.close(); }
});

test('the catalog list counts stock, filters, archives and duplicates', async () => {
  const s = await start();
  try {
    const a = (await s.call('/catalog/products', { method: 'POST', token: s.token, body: threePiece() })).body.id; // 5 left → low
    const b = (await s.call('/catalog/products', { method: 'POST', token: s.token, body: { name: 'Orna', price: 450, photos: ['/files/abc'] } })).body.id; // untracked → in
    const c = (await s.call('/catalog/products', { method: 'POST', token: s.token, body: { name: 'Shawl', price: 1850, inStock: false } })).body.id;

    let d = (await s.call('/catalog', { token: s.token })).body;
    assert.deepEqual(d.counts, { products: 3, in: 1, low: 1, out: 1, archived: 0 });
    assert.equal(d.readiness.count, 2, 'the three-piece needs a photo and chart, the shawl a photo');
    assert.deepEqual((await s.call('/catalog?filter=low', { token: s.token })).body.products.map((p) => p.id), [a]);
    assert.deepEqual((await s.call('/catalog?q=orn', { token: s.token })).body.products.map((p) => p.id), [b]);
    const card = d.products.find((p) => p.id === a);
    assert.deepEqual(card.sizes.map((x) => `${x.label} ${x.stock}`), ['S / Teal 4', 'M / Teal 1', 'XL / Teal 0']);

    assert.equal((await s.call(`/catalog/products/${c}/archive`, { method: 'POST', token: s.token, body: { archived: true } })).status, 200);
    d = (await s.call('/catalog', { token: s.token })).body;
    assert.equal(d.counts.products, 2);
    assert.equal(d.counts.archived, 1);
    assert.deepEqual((await s.call('/catalog?filter=archived', { token: s.token })).body.products.map((p) => p.id), [c]);

    const copy = await s.call(`/catalog/products/${a}/duplicate`, { method: 'POST', token: s.token });
    assert.equal(copy.status, 201);
    const dup = await s.db.products.findById(copy.body.id).lean();
    assert.equal(dup.visibility, 'hidden');
    assert.equal(dup.name, 'Nokshi Three-Piece (copy)');
    assert.equal(dup.sold_count, 0);
  } finally { await s.close(); }
});

test('posts link to products, and CSV import skips names that already exist', async () => {
  const s = await start();
  try {
    const id = (await s.call('/catalog/products', { method: 'POST', token: s.token, body: { name: 'Jamdani Kurti', price: 1450 } })).body.id;
    const channel = await s.db.channels.findOne({ workspace_id: s.ws, platform: 'messenger' }).lean();
    const post = await s.db.insert(s.db.posts, { workspace_id: s.ws, channel_id: channel._id, external_id: 'p1', caption: 'Eid collection', comment_count: 12 });
    assert.equal((await s.call(`/catalog/products/${id}/posts/${post.id}`, { method: 'PUT', token: s.token })).status, 200);
    let d = (await s.call(`/catalog/products/${id}`, { token: s.token })).body;
    assert.deepEqual(d.posts.map((p) => p.caption), ['Eid collection']);
    assert.equal((await s.call('/catalog', { token: s.token })).body.products[0].posts, 1);
    assert.equal((await s.call(`/catalog/products/${id}/posts/${post.id}`, { method: 'DELETE', token: s.token })).status, 204);
    d = (await s.call(`/catalog/products/${id}`, { token: s.token })).body;
    assert.equal(d.posts.length, 0);
    assert.equal((await s.call(`/catalog/products/${id}/posts/99999`, { method: 'PUT', token: s.token })).status, 404);

    const csv = 'name,price,sizes\nJamdani Kurti,1450,"M, L"\nCotton Kurti,1250,"S, M"\n';
    const r = await s.call('/catalog/import', { method: 'POST', token: s.token, body: { csv } });
    assert.equal(r.status, 201);
    assert.equal(r.body.added, 1);
    assert.equal(r.body.duplicates, 1);
    assert.equal(await s.db.products.countDocuments({ workspace_id: s.ws }), 2);
  } finally { await s.close(); }
});

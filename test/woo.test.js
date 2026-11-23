import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { plainText, productFromWoo, wooStoreUrl } from '../src/dashboard/woo.js';

const STORE = 'https://93.184.216.34'; // a public address, so no DNS lookup is needed in tests
const KEY = `ck_${'1'.repeat(40)}`;
const SECRET = `cs_${'2'.repeat(40)}`;

const KURTI = { id: 11, type: 'simple', name: 'Cotton Kurti &amp; Dupatta', sku: 'CK-1', price: '1250', regular_price: '1450', stock_status: 'instock', manage_stock: true, stock_quantity: 7,
  description: '<p>Soft <strong>cotton</strong>.</p><ul><li>Machine wash</li></ul>', images: [{ src: 'https://93.184.216.34/k.jpg' }, { src: 'http://insecure/x.jpg' }], categories: [{ name: 'Kurti' }] };
const PANJABI = { id: 12, type: 'variable', name: 'Eid Panjabi', sku: '', price: '1800', description: '', short_description: 'Festive', images: [], categories: [],
  attributes: [{ id: 1, name: 'Size', variation: true, options: ['M', 'L', 'XL'] }, { id: 0, name: 'Colour', variation: false, options: ['White'] }] };
const PANJABI_VARS = [
  { id: 121, sku: 'EP-M', price: '1800', regular_price: '2000', manage_stock: true, stock_quantity: 3, attributes: [{ id: 1, name: 'Size', option: 'M' }] },
  { id: 122, sku: '', price: '1900', regular_price: '1900', manage_stock: false, stock_status: 'outofstock', attributes: [{ id: 1, name: 'Size', option: 'L' }] },
  { id: 123, sku: 'EP-ANY', price: '1800', attributes: [{ id: 1, name: 'Size', option: '' }] }, // "any size": left out
];
const GIFT = { id: 13, type: 'external', name: 'Gift card', price: '500' };

test('WooCommerce products map to catalog products', () => {
  assert.equal(plainText('<p>A &amp; B&#8217;s <b>best</b></p>'), 'A & B’s best');
  const k = productFromWoo(KURTI);
  assert.deepEqual([k.name, k.price, k.compare_at, k.code, k.category, k.in_stock], ['Cotton Kurti & Dupatta', 1250, 1450, 'CK-1', 'Kurti', true]);
  assert.deepEqual(k.photos, ['https://93.184.216.34/k.jpg'], 'only https photos');
  assert.match(k.description, /Soft cotton\.\n• Machine wash/);

  const p = productFromWoo(PANJABI, PANJABI_VARS);
  assert.deepEqual(p.options, [{ name: 'Size', values: ['M', 'L', 'XL'] }], 'only attributes used for variations');
  assert.deepEqual(p.variant_list.map((v) => [v.sku, v.options.Size, v.price, v.stock]), [['EP-M', 'M', 1800, 3], ['W122', 'L', 1900, 0]]);
  assert.deepEqual([p.price, p.compare_at, p.description, p.in_stock], [1800, 2000, 'Festive', true]);
  assert.equal(productFromWoo({ ...PANJABI }, []), null, 'a variable product with no sellable sizes is skipped');
  assert.equal(productFromWoo({ ...KURTI, price: '', regular_price: '' }), null);
});

test('store addresses: https, public, tidied', async () => {
  const resolve = async (host) => (host === 'myshop.com' ? [{ address: '93.184.216.34' }] : host === 'evil.test' ? [{ address: '10.0.0.5' }] : []);
  assert.equal(await wooStoreUrl('myshop.com/shop/', { resolve }), 'https://myshop.com/shop');
  assert.equal(await wooStoreUrl('https://myshop.com/wp-json/wc/v3', { resolve }), 'https://myshop.com');
  await assert.rejects(wooStoreUrl('http://myshop.com', { resolve }), /https/);
  await assert.rejects(wooStoreUrl('https://evil.test', { resolve }), /public/);
  await assert.rejects(wooStoreUrl('https://127.0.0.1', { resolve }), /public/);
  await assert.rejects(wooStoreUrl('https://localhost', { resolve }), /public/);
  await assert.rejects(wooStoreUrl('https://nowhere.test', { resolve }), /couldn't find/);
});

function fakeStore() {
  const state = { calls: [], kurtiPrice: '1250', status: 200, auth: null };
  const json = (body, headers = {}) => ({ ok: true, status: 200, headers: { get: (h) => headers[h.toLowerCase()] ?? null }, json: async () => body });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    if (!u.pathname.startsWith('/wp-json/wc/v3/')) return fetch(url, opts); // the test's own API calls
    state.calls.push(u.pathname + u.search);
    state.auth = opts.headers?.authorization;
    if (state.status !== 200) return { ok: false, status: state.status, headers: { get: () => null }, json: async () => ({}) };
    if (u.pathname === '/wp-json/wc/v3/products') return json(u.searchParams.get('page') === '1' ? [{ ...KURTI, price: state.kurtiPrice }, PANJABI, GIFT] : [], { 'x-wp-totalpages': '1' });
    if (u.pathname === '/wp-json/wc/v3/products/12/variations') return json(PANJABI_VARS);
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
  };
  return { state, fetchImpl };
}

test('Catalog → Import from WooCommerce: connect, import, sync again, disconnect', async () => {
  const store = fakeStore();
  const ctx = await setup({ env: { DRY_RUN: '1', TOKEN_ENCRYPTION_KEY: 'a'.repeat(64) } });
  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent', fetchImpl: store.fetchImpl });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}/api/dash`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const login = async (email) => (await call('/auth/login', { method: 'POST', body: { login: email, password: 'password123' } })).body.token;
  const owner = await login('owner@shop.test');
  try {
    assert.deepEqual((await call('/catalog/woo', { token: owner })).body, { connected: false });
    assert.equal((await call('/catalog/woo', { method: 'POST', token: owner, body: { url: STORE, key: 'nope', secret: SECRET } })).status, 400);

    // A wrong key: nothing is saved.
    store.state.status = 401;
    let r = await call('/catalog/woo', { method: 'POST', token: owner, body: { url: STORE, key: KEY, secret: SECRET } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /refused the key/);
    assert.equal((await call('/catalog/woo', { token: owner })).body.connected, false);

    store.state.status = 200;
    // A product the shop already typed in by hand, with its own AI notes, is matched by name and updated.
    await ctx.db.insert(ctx.db.products, { workspace_id: ctx.ws, name: 'Eid Panjabi', price: 1, ai_notes: 'Runs small', visibility: 'ai_only' });
    r = await call('/catalog/woo', { method: 'POST', token: owner, body: { url: `${STORE}/`, key: KEY, secret: SECRET } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.last, { added: 1, updated: 1, skipped: 1, more: false });
    assert.deepEqual([r.body.connected, r.body.url, r.body.keyEnd], [true, STORE, '1111']);
    assert.equal(store.state.auth, `Basic ${Buffer.from(`${KEY}:${SECRET}`).toString('base64')}`);
    const ws = await ctx.db.workspaces.findById(ctx.ws).lean();
    assert.equal(JSON.stringify(ws.settings.woo).includes(KEY), false, 'keys stored encrypted');
    assert.equal(JSON.stringify(r.body).includes(SECRET), false, 'never sent back');

    const panjabi = await ctx.db.products.findOne({ workspace_id: ctx.ws, name: 'Eid Panjabi' }).lean();
    assert.deepEqual([panjabi.woo_id, panjabi.price, panjabi.ai_notes, panjabi.visibility, panjabi.variant_list.length], [12, 1800, 'Runs small', 'ai_only', 2]);
    const kurti = await ctx.db.products.findOne({ workspace_id: ctx.ws, woo_id: 11 }).lean();
    assert.deepEqual([kurti.name, kurti.price, kurti.code], ['Cotton Kurti & Dupatta', 1250, 'CK-1']);

    // Sync again: the price changed in the store; nothing is duplicated.
    store.state.kurtiPrice = '1150';
    r = await call('/catalog/woo/sync', { method: 'POST', token: owner });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.last, { added: 0, updated: 2, skipped: 1, more: false });
    assert.equal((await ctx.db.products.findOne({ woo_id: 11 }).lean()).price, 1150);
    assert.equal(await ctx.db.products.countDocuments({ workspace_id: ctx.ws, name: 'Eid Panjabi' }), 1);

    // Moderators can't connect stores; disconnect forgets the keys but keeps the products.
    const mod = await login('nadia@shop.test');
    assert.equal((await call('/catalog/woo/sync', { method: 'POST', token: mod })).status, 403);
    assert.deepEqual((await call('/catalog/woo', { method: 'DELETE', token: owner })).body, { connected: false });
    assert.equal((await ctx.db.workspaces.findById(ctx.ws).lean()).settings.woo, undefined);
    assert.equal((await call('/catalog/woo/sync', { method: 'POST', token: owner })).status, 400);
    assert.equal(await ctx.db.products.countDocuments({ workspace_id: ctx.ws, woo_id: { $ne: null } }), 2);
  } finally {
    await new Promise((r) => { app.io.close(); app.server.close(r); });
  }
});

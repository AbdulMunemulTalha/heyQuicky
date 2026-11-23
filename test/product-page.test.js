import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, inbound } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { slugify, ensureShopSlug, pageLinker } from '../src/dashboard/productPage.js';
import { productCards } from '../src/platforms/rich.js';
import { customerError } from '../src/routes/productPage.js';

async function start() {
  const ctx = await setup({ env: { DRY_RUN: '1', AI_REPLY_DELAY_MS: '0' } });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { name: 'Nokshi Threads' } });
  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (path, body) => { const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => null) }; };
  const get = async (path) => { const res = await fetch(`${base}${path}`); return { status: res.status, text: await res.text() }; };
  const call = async (path, token) => { const res = await fetch(`${base}/api/dash${path}`, { headers: { authorization: `Bearer ${token}` } }); return res.json(); };
  const login = async (email) => (await post('/api/dash/auth/login', { login: email, password: 'password123' })).body.token;
  const product = (await ctx.db.insert(ctx.db.products, {
    workspace_id: ctx.ws, name: 'Nokshi Cotton Three-Piece', price: 2150, compare_at: 2500, description: 'Soft cotton',
    options: [{ name: 'Size', values: ['M', 'L'] }],
    variant_list: [{ sku: 'NT-M', options: { Size: 'M' }, price: 2150, stock: 3 }, { sku: 'NT-L', options: { Size: 'L' }, price: 2150, stock: 0 }],
  })).id;
  return { ...ctx, app, base, post, get, call, product, owner: await login('owner@shop.test'), close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

const FORM = { sku: 'NT-M', qty: 1, zone: 'inside_dhaka', name: 'Sadia Rahman', phone: '01712345678', address: 'House 7, Road 3, Dhanmondi, Dhaka' };

test('shop slugs: readable, unique, kept once made', async () => {
  assert.equal(slugify('Nokshi Threads!'), 'nokshi-threads');
  assert.equal(slugify('নকশি'), '');
  const { db, ws } = await setup();
  const other = (await db.insert(db.workspaces, { name: 'Shop' })).id;
  const a = await ensureShopSlug(db, await db.workspaces.findById(ws).lean());
  const b = await ensureShopSlug(db, await db.workspaces.findById(other).lean());
  assert.deepEqual([a, b], ['shop', 'shop-2']);
  await db.workspaces.updateOne({ _id: ws }, { $set: { name: 'Renamed' } });
  assert.equal(await ensureShopSlug(db, await db.workspaces.findById(ws).lean()), 'shop', 'links already sent keep working');
});

test('customers read order problems in Bangla, with the field to fix', () => {
  assert.deepEqual(customerError('Bangladeshi numbers have 11 digits — this one has 9'), { error: 'নম্বরটি ১১ সংখ্যার হতে হবে (যেমন 01712345678)', field: 'phone' });
  assert.equal(customerError('Only 2 left of Kurti (M)').error, 'দুঃখিত, মাত্র ২টি বাকি আছে');
  assert.equal(customerError('SAVE10 needs an order of at least ৳3000').field, 'coupon');
});

test('product page: public page for products live everywhere; checkout makes an approved order priced from the catalog', async () => {
  const s = await start();
  try {
    const slug = await ensureShopSlug(s.db, await s.db.workspaces.findById(s.ws).lean());
    assert.equal(slug, 'nokshi-threads');
    const page = await s.get(`/p/${slug}/${s.product}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Nokshi Cotton Three-Piece/);
    assert.match(page.text, /এখনই কিনুন/);
    assert.match(page.text, /m\.me\/PAGE1/, 'Message button opens the shop page on Messenger');
    assert.equal((await s.get(`/p/${slug}/99999`)).status, 404);
    assert.equal((await s.get(`/p/no-such-shop/${s.product}`)).status, 404);
    assert.equal((await s.get('/p-assets/checkout.js')).status, 200);

    // Checks, in Bangla, before anything is saved.
    let r = await s.post(`/api/p/${slug}/${s.product}/order`, { ...FORM, phone: '0171234' });
    assert.deepEqual([r.status, r.body.field], [400, 'phone']);
    r = await s.post(`/api/p/${slug}/${s.product}/order`, { ...FORM, sku: '' });
    assert.equal(r.body.field, 'options');
    r = await s.post(`/api/p/${slug}/${s.product}/order`, { ...FORM, sku: 'NT-L' });
    assert.equal(r.body.field, 'qty', 'L is sold out');
    r = await s.post(`/api/p/${slug}/${s.product}/order`, { ...FORM, zone: 'moon' });
    assert.equal(r.body.field, 'zone');
    assert.equal((await s.post(`/api/p/${slug}/${s.product}/order`, { ...FORM, website: 'spam.example' })).status, 400, 'bots fill the hidden field');
    assert.equal(await s.db.orders.countDocuments(), 0);

    // The live total, from the server.
    r = await s.post(`/api/p/${slug}/${s.product}/quote`, { sku: 'NT-M', qty: 2, zone: 'outside_dhaka' });
    assert.deepEqual(r.body, { subtotal: 4300, delivery: 130, discount: 0, total: 4430, coupon: '' });
    r = await s.post(`/api/p/${slug}/${s.product}/quote`, { sku: 'NT-M', qty: 1, zone: 'inside_dhaka', coupon: 'NOPE' });
    assert.deepEqual([r.status, r.body.field], [400, 'coupon']);

    // A link from a chat: the order joins the chat and the bill goes back into it.
    const { conversation } = await s.app.inbox.ingestMessage(inbound({ contactExternalId: 'cust-pp', text: 'dam koto?' }));
    const linker = await pageLinker(s.db, s.ws, 'https://shop.test', conversation.id ?? conversation._id);
    const p = await s.db.products.findById(s.product).lean();
    const url = linker(p);
    assert.match(url, new RegExp(`^https://shop\\.test/p/${slug}/${s.product}\\?c=[\\w-]+$`));
    const token = new URL(url).searchParams.get('c');
    const cards = productCards([p], { pageUrl: linker });
    assert.ok(cards.payload.cards[0].buttons.some((b) => b.type === 'url' && b.title === 'এখনই কিনুন' && b.value === url));

    r = await s.post(`/api/p/${slug}/${s.product}/order`, { ...FORM, qty: 2, c: token, phone: '+880 1712-345678' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.total, 4370);
    assert.equal(r.body.inChat, true);
    assert.match(r.body.billUrl, /\/b\/[\w-]+$/);
    const order = await s.db.orders.findOne({ number: r.body.number }).lean();
    assert.deepEqual([order.source, order.status, order.phone, order.conversation_id], ['product_page', 'approved', '01712345678', conversation.id ?? conversation._id]);
    assert.deepEqual(order.product_items.map((l) => [l.sku, l.qty, l.price]), [['NT-M', 2, 2150]]);
    assert.equal((await s.db.products.findById(s.product).lean()).variant_list.find((v) => v.sku === 'NT-M').stock, 1, 'stock taken');
    const sent = await s.db.messages.find({ conversation_id: conversation.id ?? conversation._id, direction: 'out' }).lean();
    assert.ok(sent.some((m) => /১০|bill|বিল|#/.test(JSON.stringify(m.rich ?? m.text ?? ''))), 'bill card sent into the chat');

    // Without a chat token (or with someone else's), it's a plain page order.
    r = await s.post(`/api/p/${slug}/${s.product}/order`, { ...FORM, c: 'not-a-real-token' });
    assert.equal(r.status, 201);
    assert.equal(r.body.inChat, false);

    // Hidden, AI-only and archived products have no page; the dashboard shows the link only for live ones.
    let d = await s.call(`/catalog/products/${s.product}`, s.owner);
    assert.match(d.product.pageUrl, new RegExp(`/p/${slug}/${s.product}$`));
    await s.db.products.updateOne({ _id: s.product }, { $set: { visibility: 'ai_only' } });
    assert.equal((await s.get(`/p/${slug}/${s.product}`)).status, 404);
    d = await s.call(`/catalog/products/${s.product}`, s.owner);
    assert.equal(d.product.pageUrl, '');
  } finally {
    await s.close();
  }
});

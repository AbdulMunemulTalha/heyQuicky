import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';

test('shop link: every product live everywhere, the current offer, categories, search, and links into checkout', async () => {
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { name: 'Nokshi Threads' } });
  const add = async (fields) => (await ctx.db.insert(ctx.db.products, { workspace_id: ctx.ws, ...fields })).id;
  const kurti = await add({ name: 'Cotton Kurti', price: 1250, category: 'Kurti', sold_count: 9 });
  const saree = await add({ name: 'Block Print Saree', price: 3200, compare_at: 3600, category: 'Saree' });
  const shawl = await add({ name: 'Winter Shawl', price: 1850, category: 'Shawl', variant_list: [{ sku: 'W', options: { Size: 'Free' }, price: 1850, stock: 0 }] });
  await add({ name: 'Secret Draft', price: 1, visibility: 'hidden' });
  await add({ name: 'Chat Only Deal', price: 2, visibility: 'ai_only' });
  await add({ name: 'Old Stock', price: 3, archived: true });
  await ctx.db.insert(ctx.db.coupons, { workspace_id: ctx.ws, code: 'VIPONLY', type: 'percent', value: 30, audience: 'vip', active: true });
  await ctx.db.insert(ctx.db.coupons, { workspace_id: ctx.ws, code: 'FREEDEL', type: 'free_delivery', value: 0, min_order: 2000, active: true, ends_at: new Date('2099-12-31T00:00:00Z') });

  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = async (path) => { const res = await fetch(`${base}${path}`); return { status: res.status, text: await res.text() }; };
  const login = (await (await fetch(`${base}/api/dash/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'owner@shop.test', password: 'password123' }) })).json()).token;
  const dash = async (path) => (await fetch(`${base}/api/dash${path}`, { headers: { authorization: `Bearer ${login}` } })).json();
  try {
    assert.equal((await get('/s/nokshi-threads')).status, 404, 'no link until the shop has one');
    // Opening the catalog makes the shop's link.
    const cat = await dash('/catalog');
    assert.match(cat.shopUrl, /\/s\/nokshi-threads$/);
    const integrations = await dash('/integrations');
    assert.deepEqual([integrations.shopLink.url.endsWith('/s/nokshi-threads'), integrations.shopLink.products], [true, 3]);

    const page = await get('/s/nokshi-threads');
    assert.equal(page.status, 200);
    for (const name of ['Cotton Kurti', 'Block Print Saree', 'Winter Shawl']) assert.ok(page.text.includes(name), name);
    for (const name of ['Secret Draft', 'Chat Only Deal', 'Old Stock']) assert.ok(!page.text.includes(name), `${name} is not on the shop`);
    assert.match(page.text, /৳2,000-এর বেশি কিনলে ডেলিভারি ফ্রি/);
    assert.match(page.text, /কোড: FREEDEL/);
    assert.ok(!page.text.includes('VIPONLY'), 'coupons for some customers only are not advertised');
    assert.match(page.text, /-১১%/, 'discount badge');
    assert.match(page.text, /স্টক শেষ/, 'sold out shows');
    assert.ok(page.text.indexOf('Winter Shawl') > page.text.indexOf('Block Print Saree'), 'sold-out products come last');
    assert.match(page.text, new RegExp(`href="/p/nokshi-threads/${kurti}"`));
    assert.match(page.text, /m\.me\/PAGE1/, 'order by message');

    const filtered = await get('/s/nokshi-threads?cat=Saree');
    assert.ok(filtered.text.includes('Block Print Saree') && !filtered.text.includes('Cotton Kurti'));
    assert.match(filtered.text, /class="cat on" href="[^"]*cat=Saree"/);
    assert.ok((await get('/s/nokshi-threads?q=saree')).text.includes(`/p/nokshi-threads/${saree}`));
    assert.match((await get('/s/nokshi-threads?q=nothing-like-this')).text, /কোনো পণ্য পাওয়া যায়নি/);

    // A link sent in chat keeps the chat token, so the order comes back to that chat.
    const fromChat = await get('/s/nokshi-threads?c=abcDEF123456');
    assert.match(fromChat.text, new RegExp(`href="/p/nokshi-threads/${shawl}\\?c=abcDEF123456"`));
    const product = await get(`/p/nokshi-threads/${kurti}?c=abcDEF123456`);
    assert.ok(product.text.includes('href="/s/nokshi-threads"'), 'product page links back to the shop (the token is only kept when it matches a chat)');
  } finally {
    await new Promise((r) => { app.io.close(); app.server.close(r); });
  }
});

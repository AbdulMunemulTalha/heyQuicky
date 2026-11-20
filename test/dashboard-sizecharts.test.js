import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, inbound } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { sizeChartMessage, toPlatform } from '../src/platforms/rich.js';
import { sendSizeChart } from '../src/dashboard/postbacks.js';

async function start() {
  const ctx = await setup({ env: { DRY_RUN: '1', AI_REPLY_DELAY_MS: '0', PUBLIC_URL: 'https://shop.example' } });
  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const root = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${root}/api/dash${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
  };
  const login = async (email) => (await call('/auth/login', { method: 'POST', body: { login: email, password: 'password123' } })).body.token;
  return { ...ctx, app, root, call, owner: await login('owner@shop.test'), mod: await login('nadia@shop.test'), close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

const CHART = { name: 'Kurti', unit: 'inch', columns: ['Size', 'Chest', 'Length'], rows: [['M', '38', '41'], ['L', '40', '42']], howTo: 'Measure the chest at the widest point.' };

test('the chart message: the table as text with the page link, or the shop\'s picture, with sizes to tap on every platform', () => {
  const chart = { name: 'Kurti', unit: 'inch', columns: ['Size', 'Chest'], rows: [['M', '38'], ['L', '40']], how_to: 'Measure loosely', token: 'tok12345' };
  const text = sizeChartMessage(chart, { productName: 'Jamdani Kurti', publicUrl: 'https://shop.example' });
  assert.match(text.text, /Jamdani Kurti — সাইজ চার্ট \(ইঞ্চি\)\n\nSize \| Chest\nM \| 38\nL \| 40\n\nমাপ নেওয়ার নিয়ম: Measure loosely\n\nপুরো চার্ট: https:\/\/shop\.example\/size\/tok12345/);
  const fb = toPlatform('messenger', text);
  assert.deepEqual(fb.quick_replies.map((q) => q.title), ['M', 'L']);
  assert.ok(fb.text.startsWith('Jamdani Kurti'));

  const pic = sizeChartMessage({ ...chart, image: '/files/abc' }, { publicUrl: 'https://shop.example' });
  assert.doesNotMatch(pic.text, /M \| 38/, 'with a picture the table isn\'t repeated as text');
  const fbPic = toPlatform('messenger', pic);
  assert.deepEqual(fbPic.attachment, { type: 'image', payload: { url: 'https://shop.example/files/abc', is_reusable: true } });
  assert.equal(fbPic.quick_replies.length, 2, 'the sizes ride along with the picture');
  assert.deepEqual(toPlatform('whatsapp', pic).image.link, 'https://shop.example/files/abc');
  assert.equal(toPlatform('whatsapp', text).interactive.type, 'button');
});

test('size charts: create with a category, edit the table, pick products, the public page, delete', async () => {
  const s = await start();
  try {
    const kurti = await s.db.insert(s.db.products, { workspace_id: s.ws, name: 'Jamdani Kurti', price: 1450, category: 'Kurti', options: [{ name: 'Size', values: ['M', 'L'] }] });
    const kurti2 = await s.db.insert(s.db.products, { workspace_id: s.ws, name: 'Cotton Kurti', price: 950, category: 'Kurti' });
    const saree = await s.db.insert(s.db.products, { workspace_id: s.ws, name: 'Silk Saree', price: 4500, category: 'Saree' });

    assert.equal((await s.call('/size-charts', { method: 'POST', token: s.mod, body: CHART })).status, 403);
    assert.equal((await s.call('/size-charts', { method: 'POST', token: s.owner, body: { ...CHART, columns: ['Size'] } })).status, 400, 'needs a measurement');
    assert.equal((await s.call('/size-charts', { method: 'POST', token: s.owner, body: { ...CHART, rows: [['M', '1', '2'], ['m', '3', '4']] } })).status, 400, 'sizes are unique');
    assert.equal((await s.call('/size-charts', { method: 'POST', token: s.owner, body: { ...CHART, image: 'http://insecure/x.png' } })).status, 400);
    let list = await s.call('/size-charts', { token: s.owner });
    assert.equal(list.body.withoutChart, 1, 'one product with sizes has no chart');
    const old = await s.db.insert(s.db.sizeCharts, { workspace_id: s.ws, name: 'Old', columns: ['Size', 'X'], rows: [['S', '1']] });
    await s.call('/size-charts', { token: s.owner });
    assert.ok((await s.db.sizeCharts.findById(old.id).lean()).token, 'old charts get a page link');
    await s.db.sizeCharts.deleteOne({ _id: old.id });

    const c = await s.call('/size-charts', { method: 'POST', token: s.owner, body: { ...CHART, categories: ['Kurti'] } });
    assert.deepEqual([c.status, c.body.assigned], [201, 2], 'both kurtis got the chart from their category');
    assert.equal((await s.db.products.findById(saree.id).lean()).size_chart_id, null);
    list = await s.call('/size-charts', { token: s.owner });
    assert.deepEqual([list.body.charts[0].used, list.body.withoutChart, list.body.categories], [2, 0, ['Kurti', 'Saree']]);

    await s.call(`/size-charts/${c.body.id}`, { method: 'PATCH', token: s.owner, body: { columns: ['Size', 'Chest', 'Length', 'Hip'], rows: [['M', '38', '41', '40'], ['L', '40', '42', '42'], ['XL', '42', '43', '44']], unit: 'cm' } });
    let d = await s.call(`/size-charts/${c.body.id}`, { token: s.owner });
    assert.deepEqual([d.body.chart.unit, d.body.chart.rows.length, d.body.chart.columns.at(-1)], ['cm', 3, 'Hip']);
    assert.equal(d.body.preview.kind, 'size_chart');
    assert.deepEqual(d.body.preview.payload.options.map((o) => o.title), ['M', 'L', 'XL']);
    assert.match(d.body.pageUrl, /^https:\/\/shop\.example\/size\/[\w-]+$/);

    assert.equal((await s.call(`/size-charts/${c.body.id}/products`, { method: 'PUT', token: s.owner, body: { productIds: [kurti.id, saree.id] } })).body.used, 2);
    d = await s.call(`/size-charts/${c.body.id}`, { token: s.owner });
    assert.deepEqual(d.body.products.map((p) => p.name), ['Jamdani Kurti', 'Silk Saree']);
    assert.equal((await s.db.products.findById(kurti2.id).lean()).size_chart_id, null, 'taken off when not picked');

    // A new product in the category picks the chart up.
    const np = await s.call('/catalog/products', { method: 'POST', token: s.owner, body: { name: 'Linen Kurti', price: 1200, category: 'Kurti' } });
    assert.equal((await s.db.products.findById(np.body.id).lean()).size_chart_id, c.body.id);

    const token = d.body.pageUrl.split('/').at(-1);
    const html = await (await fetch(`${s.root}/size/${token}`)).text();
    assert.match(html, /Kurti/);
    assert.match(html, /<th scope="row">XL<\/th><td>42<\/td><td>43<\/td><td>44<\/td>/);
    assert.match(html, /মাপ নেওয়ার নিয়ম/);
    assert.equal((await fetch(`${s.root}/size/nope-nope-nope`)).status, 404);

    const del = await s.call(`/size-charts/${c.body.id}`, { method: 'DELETE', token: s.owner });
    assert.equal(del.body.unlinked, 3);
    assert.equal(await s.db.products.countDocuments({ workspace_id: s.ws, size_chart_id: c.body.id }), 0);
  } finally { await s.close(); }
});

test('the AI and the "সাইজ চার্ট" button send the chart; another shop\'s chart is never sent', async () => {
  const s = await start();
  try {
    const chart = await s.db.insert(s.db.sizeCharts, { workspace_id: s.ws, name: 'Kurti', unit: 'inch', columns: ['Size', 'Chest'], rows: [['M', '38']], token: 'tok12345abc', image: '/files/pic1' });
    const kurti = await s.db.insert(s.db.products, { workspace_id: s.ws, name: 'Jamdani Kurti', price: 1450, size_chart_id: chart.id });
    const { conversation } = await s.app.inbox.ingestMessage(inbound({ text: 'kon size?' }));
    assert.equal(await sendSizeChart(s.db, s.app.inbox, conversation.id, s.ws, kurti.id, { publicUrl: 'https://shop.example' }), true);
    const msg = await s.db.messages.findOne({ conversation_id: conversation.id, kind: 'size_chart' }).lean();
    assert.deepEqual([msg.payload.image, msg.payload.options[0].title], ['https://shop.example/files/pic1', 'M']);

    const other = await s.db.insert(s.db.sizeCharts, { workspace_id: 999, name: 'Theirs', columns: ['Size', 'X'], rows: [['S', '1']] });
    await s.db.products.updateOne({ _id: kurti.id }, { $set: { size_chart_id: other.id } });
    assert.equal(await sendSizeChart(s.db, s.app.inbox, conversation.id, s.ws, kurti.id), false);
  } finally { await s.close(); }
});

test('a chart shows how often it was sent this month and how many products each category has', async () => {
  const s = await start();
  try {
    const made = await s.call('/size-charts', { method: 'POST', token: s.owner, body: { ...CHART, categories: ['Kurti'] } });
    await s.db.insert(s.db.products, { workspace_id: s.ws, name: 'Cotton Kurti', category: 'Kurti', price: 1250 });
    await s.db.insert(s.db.products, { workspace_id: s.ws, name: 'Silk Kurti', category: 'Kurti', price: 1850 });
    const channel = await s.db.channels.findOne({ workspace_id: s.ws }).lean();
    const contact = await s.db.insert(s.db.contacts, { workspace_id: s.ws, channel_id: channel._id, external_id: 'sc1', name: 'C' });
    const conv = await s.db.insert(s.db.conversations, { workspace_id: s.ws, channel_id: channel._id, contact_id: contact.id });
    await s.db.insert(s.db.messages, { conversation_id: conv.id, direction: 'out', kind: 'size_chart', payload: { name: 'Kurti' }, text: 'chart' });
    await s.db.insert(s.db.messages, { conversation_id: conv.id, direction: 'out', kind: 'size_chart', payload: { name: 'Kurti' }, text: 'old', created_at: new Date(Date.now() - 45 * 86_400_000) });
    const d = await s.call(`/size-charts/${made.body.id}`, { token: s.owner });
    assert.equal(d.body.usage.month, 1);
    assert.ok(d.body.usage.lastAt);
    assert.deepEqual(d.body.categoryCounts, { Kurti: 2 });
  } finally { await s.close(); }
});

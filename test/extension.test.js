import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { setup, inbound } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { chatStatus, zip } from '../src/dashboard/extension.js';

// Reads back a store-only zip: { name: Buffer }.
function unzip(buf) {
  const out = {};
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extra = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString();
    const data = buf.subarray(p + 30 + nameLen + extra, p + 30 + nameLen + extra + size);
    out[name] = method === 8 ? inflateRawSync(data) : data;
    p += 30 + nameLen + extra + size;
  }
  return out;
}

test('chat status for the badges and the panel', () => {
  assert.equal(chatStatus({ ai_handoff: true, taken_over_by: 3 }, { userId: 3 }), 'you');
  assert.equal(chatStatus({ ai_handoff: true, taken_over_by: 4 }, { userId: 3 }), 'teammate');
  assert.equal(chatStatus({ ai_handoff: true }, { userId: 3 }), 'needs_you');
  assert.equal(chatStatus({}, { userId: 3, aiMode: 'off' }), 'off');
  assert.equal(chatStatus({}, { userId: 3, orderToday: true }), 'order');
  assert.equal(chatStatus({}, { userId: 3 }), 'ai');
  const z = unzip(zip([{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'b/c.txt', data: Buffer.from('world') }]));
  assert.deepEqual(Object.fromEntries(Object.entries(z).map(([k, v]) => [k, v.toString()])), { 'a.txt': 'hello', 'b/c.txt': 'world' });
});

test('Business Suite extension: connect with a code, find the open chat, take over, shorter, size chart, disconnect', async () => {
  const ctx = await setup({ env: { DRY_RUN: '1', PUBLIC_URL: 'https://shop.test' } });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { ai_mode: 'auto' } }); // AI live
  const provider = { name: 'fake', model: 'claude-sonnet-5-5', async generateJson() { return { data: { text: 'XL আছে, ৳১২৫০।' }, usage: { input_tokens: 40, output_tokens: 10 } }; } };
  const app = createApp(ctx.db, ctx.config, { aiProvider: provider, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const site = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${site}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const login = async (email) => (await call('/api/dash/auth/login', { method: 'POST', body: { login: email, password: 'password123' } })).body.token;
  try {
    // Two customers message the Page.
    await app.inbox.ingestMessage(inbound({ contactExternalId: 'psid-rakib', contactName: 'Rakib Hasan', text: 'XL size ache?' }));
    await app.inbox.ingestMessage(inbound({ contactExternalId: 'psid-mitu', contactName: 'Mitu Akter', text: 'price koto?' }));
    const rakib = await ctx.db.conversations.findOne({ contact_id: (await ctx.db.contacts.findOne({ external_id: 'psid-rakib' }).lean())._id }).lean();
    await ctx.db.insert(ctx.db.savedReplies, { workspace_id: ctx.ws, shortcut: '/xl', phrases: ['xl'], text: 'জি, XL আছে।' });
    await ctx.db.customers.updateOne({ _id: rakib.customer_id }, { $set: { courier_check: { rate: 0.95, total: 20, delivered: 19 } } });

    const owner = await login('owner@shop.test');
    const ownerId = (await ctx.db.users.findOne({ email: 'owner@shop.test' }).lean())._id;

    // Connect: a one-time code from Integrations becomes the extension's own session.
    const { body: code } = await call('/api/dash/extension/code', { method: 'POST', token: owner });
    assert.match(code.code, /^[A-Z2-9]{8}$/);
    assert.equal((await call('/api/ext/connect', { method: 'POST', body: { code: 'WRONG123' } })).status, 400);
    const conn = await call('/api/ext/connect', { method: 'POST', body: { code: `${code.code.slice(0, 4)}-${code.code.slice(4).toLowerCase()}` } });
    assert.equal(conn.status, 200, 'dashes and lower case are fine');
    assert.equal(conn.body.name, 'Owner');
    const ext = conn.body.token;
    assert.equal((await call('/api/ext/connect', { method: 'POST', body: { code: code.code } })).status, 400, 'a code works once');
    assert.equal((await call('/api/dash/ext/me', { token: ext })).body.name, 'Owner');
    const listed = await call('/api/dash/extension', { token: owner });
    assert.equal(listed.body.connected.length, 1);

    // Which chat is open in Business Suite: by Page + thread, by name, or pick from the list.
    let f = await call('/api/dash/ext/find?page=PAGE1&thread=psid-rakib', { token: ext });
    assert.equal(f.body.conversationId, rakib._id);
    f = await call(`/api/dash/ext/find?page=PAGE1&thread=unknown&name=${encodeURIComponent('rakib hasan')}`, { token: ext });
    assert.equal(f.body.conversationId, rakib._id, 'by the name in the header');
    f = await call('/api/dash/ext/find?page=PAGE1&thread=unknown&q=mitu', { token: ext });
    assert.deepEqual([f.body.conversationId, f.body.candidates.map((c) => c.name)], [null, ['Mitu Akter']]);
    await ctx.db.insert(ctx.db.channels, { workspace_id: ctx.ws + 99, platform: 'messenger', external_id: 'OTHERPAGE', name: 'Other' });
    assert.equal((await call('/api/dash/ext/find?page=OTHERPAGE&thread=x', { token: ext })).body.otherPage, true);

    // The panel.
    let chat = await call(`/api/dash/ext/chat/${rakib._id}`, { token: ext });
    assert.deepEqual([chat.body.name, chat.body.status, chat.body.suggestion, chat.body.suggestionFrom, chat.body.courier, chat.body.open],
      ['Rakib Hasan', 'ai', 'জি, XL আছে।', 'saved', { rate: 95, safe: true }, `https://shop.test/app/inbox/${rakib._id}`]);
    // Take over with the normal inbox route, using the extension's session.
    assert.equal((await call(`/api/dash/inbox/${rakib._id}/takeover`, { method: 'POST', token: ext })).status, 200);
    chat = await call(`/api/dash/ext/chat/${rakib._id}`, { token: ext });
    assert.equal(chat.body.status, 'you');
    const st = await call('/api/dash/ext/statuses?page=PAGE1', { token: ext });
    assert.deepEqual(Object.fromEntries(st.body.chats.map((c) => [c.name, c.status])), { 'Rakib Hasan': 'you', 'Mitu Akter': 'ai' });
    assert.equal((await ctx.db.conversations.findById(rakib._id).lean()).taken_over_by, ownerId);

    // Shorter (metered like a suggestion).
    const short = await call(`/api/dash/ext/chat/${rakib._id}/shorter`, { method: 'POST', token: ext, body: { text: 'জি ভাইয়া, আমাদের কাছে XL সাইজ আছে, দাম ১২৫০ টাকা।' } });
    assert.equal(short.body.text, 'XL আছে, ৳১২৫০।');
    assert.equal(await ctx.db.aiReplies.countDocuments({ kind: 'suggest' }), 1);

    // Size chart: asks which product when it can't tell, then sends it to the customer.
    assert.equal((await call(`/api/dash/ext/chat/${rakib._id}/size-chart`, { method: 'POST', token: ext })).status, 409, 'no size charts yet');
    const chart = await ctx.db.insert(ctx.db.sizeCharts, { workspace_id: ctx.ws, name: 'Kurti', columns: ['Size', 'Chest'], rows: [['XL', '42']], token: 'chart1' });
    const kurti = await ctx.db.insert(ctx.db.products, { workspace_id: ctx.ws, name: 'Cotton Kurti', price: 1250, size_chart_id: chart.id });
    const which = await call(`/api/dash/ext/chat/${rakib._id}/size-chart`, { method: 'POST', token: ext });
    assert.deepEqual([which.status, which.body.choices], [409, [{ id: kurti.id, name: 'Cotton Kurti' }]]);
    const sent = await call(`/api/dash/ext/chat/${rakib._id}/size-chart`, { method: 'POST', token: ext, body: { productId: kurti.id } });
    assert.equal(sent.status, 200);
    assert.ok(await ctx.db.messages.exists({ conversation_id: rakib._id, direction: 'out', kind: { $ne: 'text' } }), 'the size chart went to the customer');

    // Another shop's chat is out of reach.
    const other = await ctx.db.insert(ctx.db.conversations, { workspace_id: ctx.ws + 99, channel_id: 1, contact_id: 999999 });
    assert.equal((await call(`/api/dash/ext/chat/${other.id}`, { token: ext })).status, 404);

    // Disconnect from Integrations: the extension is signed out.
    assert.equal((await call(`/api/dash/profile/sessions/${listed.body.connected[0].id}`, { method: 'DELETE', token: owner })).status, 200);
    assert.equal((await call('/api/dash/ext/me', { token: ext })).status, 401);

    // The download has this server's address inside.
    const res = await fetch(`${site}/extension/heyquicky-extension.zip`);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    const files = unzip(Buffer.from(await res.arrayBuffer()));
    assert.match(files['heyquicky-extension/config.js'].toString(), /self\.HQ_SERVER = "https:\/\/shop\.test";/);
    const manifest = JSON.parse(files['heyquicky-extension/manifest.json'].toString());
    assert.deepEqual([manifest.manifest_version, manifest.content_scripts[0].matches[0]], [3, 'https://business.facebook.com/latest/inbox*']);
    assert.ok(files['heyquicky-extension/content.js'] && files['heyquicky-extension/icons/icon128.png'] && files['heyquicky-extension/_locales/bn/messages.json']);
  } finally {
    await new Promise((r) => { app.io.close(); app.server.close(r); });
  }
});

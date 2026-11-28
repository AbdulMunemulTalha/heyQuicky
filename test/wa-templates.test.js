import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { buildTemplate, templateRow } from '../src/routes/dashboard/waTemplates.js';

const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

test('templates are checked like Meta does before they are sent', () => {
  const t = buildTemplate({ name: 'Order Update', category: 'utility', language: 'bn', header: 'অর্ডার আপডেট', body: 'হ্যালো {{1}}, আপনার অর্ডার {{2}} রওনা দিয়েছে।', footer: 'Quicky', buttons: ['ধন্যবাদ', ''], examples: ['রুপা', '#1042'] });
  assert.deepEqual(t, {
    name: 'order_update', category: 'UTILITY', language: 'bn',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'অর্ডার আপডেট' },
      { type: 'BODY', text: 'হ্যালো {{1}}, আপনার অর্ডার {{2}} রওনা দিয়েছে।', example: { body_text: [['রুপা', '#1042']] } },
      { type: 'FOOTER', text: 'Quicky' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'ধন্যবাদ' }] },
    ],
  });
  const bad = (input, re) => assert.throws(() => buildTemplate({ name: 'x', category: 'UTILITY', language: 'en', body: 'Hi there', ...input }), re);
  bad({ name: 'অর্ডার' }, /small English letters/);
  bad({ category: 'AUTHENTICATION' }, /category/);
  bad({ language: 'fr' }, /language/);
  bad({ body: '' }, /Write the message/);
  bad({ body: 'Hi {{2}} there' }, /in order/);
  bad({ body: '{{1}} is here' }, /start or end/);
  bad({ body: 'Hi {{1}} there', examples: [] }, /sample for every blank/);
  bad({ header: 'Hi {{1}}' }, /only in the message/);

  const row = templateRow({ id: 9, name: 'order_update', category: 'UTILITY', language: 'bn', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT', components: [{ type: 'BODY', text: 'Hi {{1}}' }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'OK' }] }] });
  assert.deepEqual(row, { id: '9', name: 'order_update', category: 'UTILITY', language: 'bn', status: 'REJECTED', header: '', body: 'Hi {{1}}', footer: '', buttons: ['OK'], reason: 'INVALID_FORMAT' });
});

test('WhatsApp templates API: owner lists, creates and deletes on Meta; moderators cannot', async () => {
  const ctx = await setup();
  await ctx.db.channels.updateOne({ workspace_id: ctx.ws, platform: 'whatsapp' }, { $set: { waba_id: 'WABA9' } });
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method ?? 'GET', path: u.pathname.replace(/^\/v[\d.]+/, ''), search: u.search, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.authorization });
    if (u.pathname.endsWith('/WABA9/message_templates') && (init.method ?? 'GET') === 'GET') {
      return json(200, { data: [{ id: '1', name: 'hello_world', category: 'UTILITY', language: 'en_US', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hello' }] }] });
    }
    if (u.pathname.endsWith('/WABA9/message_templates') && init.method === 'POST') return json(200, { id: '2', status: 'PENDING', category: 'UTILITY' });
    if (u.pathname.endsWith('/WABA9/message_templates') && init.method === 'DELETE') return json(200, { success: true });
    return json(400, { error: { message: 'unexpected', code: 1 } });
  };
  const app = createApp(ctx.db, ctx.config, { fetchImpl, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}/api/dash`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const login = async (email) => (await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: email, password: 'password123' }) })).json()).token;
  try {
    assert.equal((await call('/whatsapp/templates')).status, 401);
    const mod = await login('nadia@shop.test');
    assert.equal((await call('/whatsapp/templates', { token: mod })).status, 403);

    const owner = await login('owner@shop.test');
    const list = await call('/whatsapp/templates', { token: owner });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual([list.body.channels.length, list.body.channels[0].ready, list.body.templates[0].name, list.body.templates[0].status], [1, true, 'hello_world', 'APPROVED']);
    assert.equal(calls[0].auth, 'Bearer tok', 'uses the WhatsApp number\'s token');

    const created = await call('/whatsapp/templates', { method: 'POST', token: owner, body: { name: 'order_update', category: 'UTILITY', language: 'bn', body: 'হ্যালো {{1}}, অর্ডার রওনা দিয়েছে।', examples: ['রুপা'] } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual([created.body.name, created.body.status], ['order_update', 'PENDING']);
    const sent = calls.find((c) => c.method === 'POST');
    assert.deepEqual([sent.body.name, sent.body.language, sent.body.components[0].example.body_text], ['order_update', 'bn', [['রুপা']]]);

    const refused = await call('/whatsapp/templates', { method: 'POST', token: owner, body: { name: 'x', category: 'UTILITY', language: 'bn', body: '' } });
    assert.equal(refused.status, 400);

    const del = await call('/whatsapp/templates/order_update', { method: 'DELETE', token: owner });
    assert.equal(del.status, 200);
    assert.equal(calls.at(-1).search, '?name=order_update');
    const logged = await ctx.db.audit.find({ workspace_id: ctx.ws, where: 'Settings · WhatsApp templates' }).lean();
    assert.deepEqual(logged.map((l) => [l.action, l.target]), [['Sent a WhatsApp template for review', 'order_update'], ['Deleted a WhatsApp template', 'order_update']]);

    // No WhatsApp account ID yet → told to reconnect; no number → an empty list.
    await ctx.db.channels.updateOne({ workspace_id: ctx.ws, platform: 'whatsapp' }, { $set: { waba_id: null } });
    const noWaba = await call('/whatsapp/templates', { token: owner });
    assert.deepEqual([noWaba.status, noWaba.body.reconnect, noWaba.body.channels[0].ready], [200, true, false]);
    const noWabaCreate = await call('/whatsapp/templates', { method: 'POST', token: owner, body: { name: 'x', category: 'UTILITY', language: 'bn', body: 'Hi there' } });
    assert.match(noWabaCreate.body.error, /Reconnect/);
    await ctx.db.channels.deleteMany({ workspace_id: ctx.ws, platform: 'whatsapp' });
    const none = await call('/whatsapp/templates', { token: owner });
    assert.deepEqual([none.status, none.body.channels, none.body.templates], [200, [], []]);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

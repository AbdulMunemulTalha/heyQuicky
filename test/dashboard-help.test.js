import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { ARTICLES, searchArticles } from '../src/dashboard/helpArticles.js';
import { pageOf } from '../src/routes/dashboard/help.js';

async function start({ ai = false } = {}) {
  const ctx = await setup({ env: { DRY_RUN: '1', AI_REPLY_DELAY_MS: '0' } });
  const seen = [];
  const provider = ai ? { name: 'fake', model: 'fake-1', async generateJson(req) { seen.push(req); return { data: { answer: 'Go to Settings → Payments.', link: '/payments?tab=rules' }, usage: {} }; } } : null;
  const adapters = createAdapters({ ADAPTERS: 'fake' });
  const app = createApp(ctx.db, ctx.config, { aiProvider: provider, adapters, clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const root = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${root}/api/dash${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
  };
  const login = async (email) => (await call('/auth/login', { method: 'POST', body: { login: email, password: 'password123' } })).body.token;
  return { ...ctx, app, call, adapters, seen, owner: await login('owner@shop.test'), close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

test('help articles: every one has English and Bangla and a page link; search finds the right one', () => {
  for (const a of ARTICLES) {
    assert.equal(a.en.length, 2, a.id);
    assert.equal(a.bn.length, 2, a.id);
    assert.match(a.link, /^\//, a.id);
  }
  assert.equal(searchArticles('How do I ask for advance outside Dhaka?')[0].id, 'advance');
  assert.equal(searchArticles('ঢাকার বাইরে অগ্রিম', 'bn')[0].id, 'advance');
  assert.deepEqual([pageOf('/orders/1052'), pageOf('/agent/training'), pageOf('/saved-replies'), pageOf('/')], ['orders', 'training', 'saved', 'overview']);
});

test('help panel: popular articles for the page; answers from the articles without AI; a call request emails support once an hour', async () => {
  const s = await start();
  try {
    const h = await s.call('/help?path=/orders&lang=bn', { token: s.owner });
    assert.equal(h.status, 200);
    assert.equal(h.body.page, 'orders');
    assert.ok(h.body.popular.some((a) => a.id === 'pipeline'));
    assert.match(h.body.popular[0].title, /[ঀ-৿]/, 'Bangla titles');
    assert.equal(h.body.aiReady, false);

    const ans = await s.call('/help/ask', { method: 'POST', token: s.owner, body: { question: 'how to connect steadfast courier' } });
    assert.deepEqual([ans.body.link, ans.body.ai], ['/settings/courier', false]);
    assert.equal((await s.call('/help/ask', { method: 'POST', token: s.owner, body: { question: 'zzz qqq' } })).body.none, true);

    assert.equal((await s.call('/help/callback', { method: 'POST', token: s.owner, body: { phone: '123' } })).status, 400);
    assert.equal((await s.call('/help/callback', { method: 'POST', token: s.owner, body: { phone: '01712345678', note: 'Stuck on courier keys' } })).status, 200);
    const mail = s.adapters.email.sent.at(-1);
    assert.match(mail.subject, /Call request/);
    assert.match(mail.text, /01712345678[\s\S]*Stuck on courier keys/);
    assert.equal((await s.call('/help/callback', { method: 'POST', token: s.owner, body: { phone: '01712345678' } })).status, 429);
  } finally { await s.close(); }
});

test('with AI set up, the help bot answers from the articles and links to the page; the shop is not charged', async () => {
  const s = await start({ ai: true });
  try {
    const before = (await s.db.workspaces.findById(s.ws).lean()).credit_balance ?? 0;
    const ans = await s.call('/help/ask', { method: 'POST', token: s.owner, body: { question: 'advance outside Dhaka?', lang: 'en' } });
    assert.deepEqual([ans.body.answer, ans.body.link, ans.body.ai], ['Go to Settings → Payments.', '/payments?tab=rules', true]);
    assert.match(s.seen.at(-1).messages[0].content, /\[\/payments\?tab=rules\]/, 'the articles are given to the model');
    assert.equal(await s.db.aiReplies.countDocuments({ workspace_id: s.ws }), 0, 'not metered');
    assert.equal((await s.db.workspaces.findById(s.ws).lean()).credit_balance ?? 0, before);
  } finally { await s.close(); }
});

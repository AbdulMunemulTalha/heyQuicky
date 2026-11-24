import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { titleFrom, words } from '../src/dashboard/requests.js';
import { hashPassword } from '../src/auth.js';

test('titles and words for matching similar requests', () => {
  assert.equal(titleFrom('Print 4 labels on one A4 page. It would save paper.'), 'Print 4 labels on one A4 page.');
  assert.ok(titleFrom('a '.repeat(80) + 'end').length <= 80);
  assert.deepEqual(words('Please add Pathao auto-booking for my shop'), ['pathao', 'auto', 'booking', 'shop']);
});

test('Help → Requests: ask, vote instead of asking twice, voice, and HeyQuicky answers', async () => {
  const ctx = await setup({ env: { ADMIN_TOKEN: 'admin-secret-2' } });
  // A second shop.
  const other = (await ctx.db.insert(ctx.db.workspaces, { name: 'Other shop' })).id;
  await ctx.db.insert(ctx.db.users, { workspace_id: other, name: 'Rumi', email: 'rumi@other.test', password_hash: hashPassword('password123'), role: 'owner', is_online: true });
  const app = createApp(ctx.db, ctx.config, { adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const site = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token, basic, raw, type } = {}) => {
    const headers = { 'content-type': type ?? 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(basic ? { authorization: `Basic ${Buffer.from(`x:${basic}`).toString('base64')}` } : {}) };
    const res = await fetch(`${site}${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const login = async (email) => (await call('/api/dash/auth/login', { method: 'POST', body: { login: email, password: 'password123' } })).body.token;
  try {
    const owner = await login('owner@shop.test');
    const mod = await login('nadia@shop.test');
    const rumi = await login('rumi@other.test');

    assert.deepEqual((await call('/api/dash/requests', { token: owner })).body.requests, []);
    assert.equal((await call('/api/dash/requests', { method: 'POST', token: owner, body: { text: '  ' } })).status, 400);

    // The other shop asks first.
    const pathao = await call('/api/dash/requests', { method: 'POST', token: rumi, body: { text: 'Pathao auto-booking like Steadfast, so parcels book themselves.' } });
    assert.equal(pathao.status, 201);
    assert.deepEqual([pathao.body.title, pathao.body.status, pathao.body.votes, pathao.body.mine, pathao.body.note], ['Pathao auto-booking like Steadfast, so parcels book themselves.', 'reviewing', 1, true, "We're looking into it"]);

    // This shop starts typing the same thing: it is offered to vote instead.
    const sim = await call(`/api/dash/requests/similar?q=${encodeURIComponent('can you add pathao booking automatically')}`, { token: owner });
    assert.deepEqual(sim.body.similar.map((r) => r.id), [pathao.body.id]);
    assert.equal((await call(`/api/dash/requests/similar?q=${encodeURIComponent('dark theme please')}`, { token: owner })).body.similar.length, 0);
    const voted = await call(`/api/dash/requests/${pathao.body.id}/vote`, { method: 'POST', token: mod });
    assert.deepEqual([voted.body.votes, voted.body.voted], [2, true], 'a teammate votes for the shop');
    assert.equal((await call(`/api/dash/requests/${pathao.body.id}/vote`, { method: 'POST', token: owner })).body.votes, 2, 'one vote per shop');
    assert.equal((await call(`/api/dash/requests/similar?q=${encodeURIComponent('pathao booking automatically')}`, { token: owner })).body.similar.length, 0, 'already voted: not offered again');
    assert.equal((await call(`/api/dash/requests/${pathao.body.id}/vote`, { method: 'DELETE', token: rumi })).status, 409, 'the shop that asked keeps its vote');

    // Its own request, by voice (kept with the request; no transcription on this server).
    const v = await call('/api/dash/requests/voice', { method: 'POST', token: owner, type: 'audio/webm', raw: Buffer.alloc(3000, 1) });
    assert.equal(v.status, 201);
    assert.match(v.body.voice, /^\/files\/[a-f0-9]{24}$/);
    assert.equal(v.body.text, '');
    const labels = await call('/api/dash/requests', { method: 'POST', token: owner, body: { text: '', voice: v.body.voice } });
    assert.deepEqual([labels.body.title, labels.body.voice], ['Voice request', v.body.voice]);
    assert.equal((await call('/api/dash/requests', { method: 'POST', token: owner, body: { voice: '/files/../../etc' } })).status, 400, 'only our own voice files');

    let mine = (await call('/api/dash/requests', { token: owner })).body.requests;
    assert.deepEqual(mine.map((r) => [r.title.slice(0, 6), r.votes]), [['Pathao', 2], ['Voice ', 1]], 'most wanted first');

    // HeyQuicky's team plans it, then merges a duplicate, then releases it with an announcement.
    const notes = await ctx.db.notifications.countDocuments();
    assert.equal((await call(`/admin/requests/${pathao.body.id}`, { method: 'PATCH', basic: 'admin-secret-2', body: { status: 'shipped' } })).status, 400);
    await call(`/admin/requests/${pathao.body.id}`, { method: 'PATCH', basic: 'admin-secret-2', body: { status: 'planned', noteEn: 'Planned for December', noteBn: 'ডিসেম্বরে আসছে' } });
    assert.ok(await ctx.db.notifications.countDocuments() > notes, 'the shops that asked are told');
    const n = await ctx.db.notifications.findOne({ workspace_id: ctx.ws }).sort({ _id: -1 }).lean();
    assert.match(n.title, /Your request "Pathao auto-booking.*" is planned/);
    mine = (await call('/api/dash/requests?lang=bn', { token: owner })).body.requests;
    assert.deepEqual([mine[0].status, mine[0].note], ['planned', 'ডিসেম্বরে আসছে']);

    const dup = await call('/api/dash/requests', { method: 'POST', token: rumi, body: { text: 'Automatic Pathao parcel booking' } });
    const third = (await ctx.db.insert(ctx.db.workspaces, { name: 'Third' })).id;
    await ctx.db.featureRequests.updateOne({ _id: dup.body.id }, { $addToSet: { voters: third } });
    const merged = await call(`/admin/requests/${dup.body.id}/merge`, { method: 'POST', basic: 'admin-secret-2', body: { into: pathao.body.id } });
    assert.equal(merged.body.voters.length, 3, 'the duplicate’s votes move over');

    const ann = await call('/admin/announcements', { method: 'POST', basic: 'admin-secret-2', body: { titleEn: 'Pathao books itself', link: '/orders' } });
    await call(`/admin/requests/${pathao.body.id}`, { method: 'PATCH', basic: 'admin-secret-2', body: { status: 'done', link: '/settings/courier', announcementId: ann.body._id } });
    mine = (await call('/api/dash/requests', { token: owner })).body.requests;
    assert.equal(mine.find((r) => r.id === pathao.body.id).status, 'done');
    assert.match(mine.find((r) => r.id === pathao.body.id).note, /^Released \w+ \d+ — Planned for December$/);
    assert.equal(mine.find((r) => r.id === pathao.body.id).link, '/settings/courier');
    const news = (await call('/api/dash/whats-new', { token: owner })).body.items.find((i) => i.title === 'Pathao books itself');
    assert.equal(news.asked, true, '"You asked for this" in What\'s new');

    const list = await call('/admin/requests', { basic: 'admin-secret-2' });
    assert.deepEqual(list.body.requests.map((r) => [r.votes, r.shops.includes('Other shop')]), [[3, true], [1, false]], 'merged ones are left out; most wanted first');
    // The other shop sees its merged duplicate as the request it became.
    const rumiList = (await call('/api/dash/requests', { token: rumi })).body.requests;
    assert.ok(rumiList.some((r) => r.id === pathao.body.id) && !rumiList.some((r) => r.id === dup.body.id));
  } finally {
    await new Promise((r) => { app.io.close(); app.server.close(r); });
  }
});

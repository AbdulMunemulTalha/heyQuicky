import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { RELEASES, announcementsFor, cleanAnnouncement } from '../src/dashboard/announcements.js';

test('release notes are complete, newest first, in both languages', () => {
  const ids = new Set();
  for (const r of RELEASES) {
    assert.ok(r.title.en && r.title.bn && r.body.en && r.body.bn, `${r.id} has English and Bangla`);
    assert.ok(['new', 'improved', 'fixed'].includes(r.kind));
    assert.ok(!ids.has(r.id), `${r.id} is unique`);
    ids.add(r.id);
  }
  assert.deepEqual(RELEASES.map((r) => r.date), [...RELEASES.map((r) => r.date)].sort().reverse(), 'newest first');
  assert.throws(() => cleanAnnouncement({ kind: 'new' }), /title/);
  const a = cleanAnnouncement({ titleEn: 'X', link: 'javascript:alert(1)', video: 'http://insecure', askedBy: ['3', 'x'] });
  assert.deepEqual([a.link, a.video, a.asked_by], ['', '', [3]], 'only app links, https videos, numeric shops');
});

test('only things from a week before someone joined are unread; modules that are off are hidden', async () => {
  const { db, ws, owner, user } = await setup();
  const me = await user(owner);
  const newest = new Date(`${RELEASES[0].date}T06:00:00Z`);
  await db.users.updateOne({ _id: owner }, { $set: { created_at: new Date(newest.getTime() + 30 * 86_400_000) } });
  let r = await announcementsFor(db, me, {});
  assert.deepEqual([r.items.length, r.unread, r.bar], [RELEASES.length, 0, null], 'joined a month later: all listed, none unread');
  await db.users.updateOne({ _id: owner }, { $set: { created_at: new Date(newest.getTime() + 86_400_000) } });
  r = await announcementsFor(db, me, { lang: 'bn' });
  assert.ok(r.unread > 0);
  assert.equal(r.items[0].title, RELEASES[0].title.bn, 'in Bangla');
  r = await announcementsFor(db, me, { modules: { content: false } });
  assert.ok(!r.items.some((i) => i.id === 'r-2026-11-24-content'), 'Content studio is off: its news is hidden');
  assert.equal((await announcementsFor(db, { ...me, workspace_id: ws }, {})).items.length, RELEASES.length);
});

test("What's new: unread dot, bar, dismiss, seen; HeyQuicky's team adds one with 'You asked for this'", async () => {
  const ctx = await setup({ env: { ADMIN_TOKEN: 'admin-secret-1' } });
  await ctx.db.users.updateMany({}, { $set: { created_at: new Date(`${RELEASES[0].date}T08:00:00Z`) } });
  const app = createApp(ctx.db, ctx.config, { adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const site = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token, basic } = {}) => {
    const res = await fetch(`${site}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(basic ? { authorization: `Basic ${Buffer.from(`x:${basic}`).toString('base64')}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const login = async (email) => (await call('/api/dash/auth/login', { method: 'POST', body: { login: email, password: 'password123' } })).body.token;
  try {
    const owner = await login('owner@shop.test');
    const mod = await login('nadia@shop.test');

    // HeyQuicky's team adds an announcement this shop asked for.
    assert.equal((await call('/admin/announcements', { method: 'POST', body: { titleEn: 'x' } })).status, 401);
    assert.equal((await call('/admin/announcements', { method: 'POST', basic: 'admin-secret-1', body: { bodyEn: 'no title' } })).status, 400);
    const added = await call('/admin/announcements', { method: 'POST', basic: 'admin-secret-1', body: {
      kind: 'improved', titleEn: 'Photo search is 2x better', titleBn: 'ছবি দিয়ে খোঁজা ২ গুণ ভালো', bodyEn: 'Blurry screenshots work now.', link: '/catalog', video: 'https://youtu.be/abcdefghijk', seconds: 40, bar: true, askedBy: [ctx.ws],
    } });
    assert.equal(added.status, 201);

    let w = await call('/api/dash/whats-new', { token: owner });
    assert.deepEqual([w.body.items[0].title, w.body.items[0].kind, w.body.items[0].asked, w.body.items[0].seconds], ['Photo search is 2x better', 'improved', true, 40], 'newest first, asked for by this shop');
    const unread = w.body.unread;
    const total = w.body.items.length;
    assert.ok(unread > 1);
    assert.equal(w.body.bar.title, 'Photo search is 2x better');
    assert.equal((await call('/api/dash/badges', { token: owner })).body.whatsNew, unread, 'the dot on Help');
    assert.equal((await call('/api/dash/me', { token: owner })).body.badges.whatsNew, unread, 'from the first load too');
    assert.equal((await call('/api/dash/whats-new', { token: mod })).body.items[0].asked, true, 'the whole shop asked');

    // × on the bar hides that one for good; the next one with a bar shows.
    w = await call(`/api/dash/whats-new/a-${added.body._id ?? added.body.id}/dismiss`, { method: 'POST', token: owner });
    assert.equal(w.body.bar.id, RELEASES.find((r) => r.bar).id);
    assert.equal(w.body.unread, unread, 'closing the bar is not reading the list');
    assert.equal((await call('/api/dash/whats-new/<script>/dismiss', { method: 'POST', token: owner })).status, 400);

    // Opening What's new reads it all (only for that person).
    w = await call('/api/dash/whats-new/seen', { method: 'POST', token: owner });
    assert.deepEqual([w.body.unread, w.body.bar], [0, null]);
    assert.ok(w.body.items.every((i) => !i.unread));
    assert.equal((await call('/api/dash/whats-new', { token: mod })).body.unread, unread, 'a teammate still has theirs');
    assert.equal((await call('/api/dash/whats-new?lang=bn', { token: mod })).body.items[0].title, 'ছবি দিয়ে খোঁজা ২ গুণ ভালো');

    const list = await call('/admin/announcements', { basic: 'admin-secret-1' });
    assert.equal(list.body.added.length, 1);
    assert.equal(list.body.releases.length, RELEASES.length);
    assert.equal((await call(`/admin/announcements/${list.body.added[0]._id}`, { method: 'DELETE', basic: 'admin-secret-1' })).status, 200);
    assert.equal((await call('/api/dash/whats-new', { token: owner })).body.items.length, total - 1, 'removed');
  } finally {
    await new Promise((r) => { app.io.close(); app.server.close(r); });
  }
});

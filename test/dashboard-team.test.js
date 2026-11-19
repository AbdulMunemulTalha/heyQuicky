import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, inbound } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { inHours, checkSla, hoursLine } from '../src/dashboard/team.js';
import { notify } from '../src/dashboard/notify.js';

async function start() {
  const ctx = await setup({ env: { DRY_RUN: '1', AI_REPLY_DELAY_MS: '0' } });
  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const root = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token, raw } = {}) => {
    const res = await fetch(`${root}/api/dash${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (raw) return { status: res.status, text: await res.text() };
    return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
  };
  const login = async (email) => (await call('/auth/login', { method: 'POST', body: { login: email, password: 'password123' } })).body.token;
  return { ...ctx, app, root, call, owner: await login('owner@shop.test'), nadia: await login('nadia@shop.test'), close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

test('working hours in Bangladesh time, including hours past midnight', () => {
  const ws = (hours) => ({ settings: { team: { hours: { on: true, ...hours } } } });
  const at = (iso) => new Date(iso);
  // 2026-11-21 is a Saturday. 10:00–22:00 Dhaka = 04:00–16:00 UTC.
  assert.equal(inHours(ws({ days: [6], start: '10:00', end: '22:00' }), at('2026-11-21T05:00:00Z')), true);
  assert.equal(inHours(ws({ days: [6], start: '10:00', end: '22:00' }), at('2026-11-21T17:00:00Z')), false, '23:00 Dhaka');
  assert.equal(inHours(ws({ days: [0], start: '10:00', end: '22:00' }), at('2026-11-21T05:00:00Z')), false, 'Saturday is not a working day');
  assert.equal(inHours(ws({ days: [6], start: '18:00', end: '02:00' }), at('2026-11-21T19:30:00Z')), true, '01:30 Sunday counts for Saturday night');
  assert.equal(inHours({}, at('2026-11-21T20:00:00Z')), true, 'no hours set: always working');
  assert.match(hoursLine(ws({ days: [6, 0], start: '10:00', end: '22:00' })), /Saturday, Sunday, 10:00–22:00/);
});

test('members with workload, permissions grid that really changes access, owner only', async () => {
  const s = await start();
  try {
    const team = await s.call('/team', { token: s.owner });
    assert.deepEqual(team.body.members.map((m) => m.role).sort(), ['moderator', 'moderator', 'owner']);
    assert.ok('pastTarget' in team.body.sla);
    assert.equal(team.body.settings.share, 'balanced');

    assert.equal((await s.call('/training/rules', { method: 'POST', token: s.nadia, body: { text: 'Be kind' } })).status, 403, 'moderators can\'t teach by default');
    assert.equal((await s.call('/team/permissions', { method: 'PUT', token: s.nadia, body: { role: 'moderator', action: 'teach_ai', value: true } })).status, 403);
    const p = await s.call('/team/permissions', { method: 'PUT', token: s.owner, body: { role: 'moderator', action: 'teach_ai', value: true } });
    assert.equal(p.body.grid.moderator.teach_ai, true);
    assert.equal((await s.call('/training/rules', { method: 'POST', token: s.nadia, body: { text: 'Be kind' } })).status, 201, 'the new tick takes effect');
    await s.call('/team/permissions/reset', { method: 'POST', token: s.owner });
    assert.equal((await s.call('/team/permissions', { token: s.owner })).body.grid.moderator.teach_ai, false);
  } finally { await s.close(); }
});

test('routing rules first, then sharing among the chosen roles; queue mode assigns nobody', async () => {
  const s = await start();
  try {
    const karim = await s.db.users.findOne({ name: 'Karim' }).lean();
    const nadia = await s.db.users.findOne({ name: 'Nadia' }).lean();
    await s.db.users.updateOne({ _id: karim._id }, { $set: { role: 'agent' } });
    assert.equal((await s.call('/team/settings', { method: 'PATCH', token: s.nadia, body: { share: 'queue' } })).status, 403);
    assert.equal((await s.call('/team/settings', { method: 'PATCH', token: s.owner, body: { rules: [{ field: 'channel', value: 'telegram', userId: karim._id }] } })).status, 400);
    assert.equal((await s.call('/team/settings', { method: 'PATCH', token: s.owner, body: { rules: [{ field: 'channel', value: 'instagram', userId: karim._id }] } })).status, 200);

    const ig = await s.app.inbox.ingestMessage(inbound({ platform: 'instagram', channelExternalId: 'IG1', contactExternalId: 'ig-1', text: 'hi' }));
    assert.equal((await s.db.conversations.findById(ig.conversation.id).lean()).assigned_user_id, karim._id, 'the rule sends Instagram to Karim (an agent)');
    const fb = await s.app.inbox.ingestMessage(inbound({ contactExternalId: 'fb-1', text: 'hi' }));
    assert.equal((await s.db.conversations.findById(fb.conversation.id).lean()).assigned_user_id, nadia._id, 'other chats are shared among moderators');

    await s.db.users.updateOne({ _id: karim._id }, { $set: { on_duty: false, is_online: false } });
    const ig2 = await s.app.inbox.ingestMessage(inbound({ platform: 'instagram', channelExternalId: 'IG1', contactExternalId: 'ig-2', text: 'hi' }));
    assert.equal((await s.db.conversations.findById(ig2.conversation.id).lean()).assigned_user_id, nadia._id, 'off duty: shared out as usual');

    await s.call('/team/settings', { method: 'PATCH', token: s.owner, body: { share: 'queue', rules: [] } });
    const q = await s.app.inbox.ingestMessage(inbound({ contactExternalId: 'fb-2', text: 'hi' }));
    assert.equal((await s.db.conversations.findById(q.conversation.id).lean()).assigned_user_id, null);
    assert.equal((await s.call('/team/settings', { method: 'PATCH', token: s.owner, body: { shareRoles: [] } })).status, 400);
  } finally { await s.close(); }
});

test('team alerts skip people off duty; the owner is warned once when a chat waits past the target', async () => {
  const ctx = await setup({ env: { DRY_RUN: '1' } });
  const nadia = await ctx.db.users.findOne({ name: 'Nadia' }).lean();
  await ctx.db.users.updateOne({ _id: nadia._id }, { $set: { on_duty: false } });
  const sent = await notify(ctx.db, () => {}, null, { workspaceId: ctx.ws, event: 'handoff', title: 'A customer needs a person' });
  const who = (await ctx.db.notifications.find({ _id: { $in: sent } }).lean()).map((n) => n.user_id);
  assert.ok(!who.includes(nadia._id), 'Nadia is off duty');
  assert.ok(who.includes(ctx.owner));

  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { 'settings.team.warn_min': 30 } });
  const contact = await ctx.db.insert(ctx.db.contacts, { workspace_id: ctx.ws, channel_id: 1, external_id: 'x', name: 'Mitu' });
  await ctx.db.insert(ctx.db.conversations, { workspace_id: ctx.ws, channel_id: 1, contact_id: contact.id, status: 'open', ai_handoff: true, last_replier: 'customer', last_inbound_at: new Date(Date.now() - 45 * 60_000) });
  const notifier = (args) => notify(ctx.db, () => {}, null, args);
  assert.equal(await checkSla(ctx.db, notifier), 1);
  const n = await ctx.db.notifications.findOne({ type: 'escalation', user_id: ctx.owner }).lean();
  assert.match(n.title, /Mitu has waited 45 min/);
  assert.equal(await checkSla(ctx.db, notifier), 0, 'not repeated');
});

test('audit log: filter by person, area and period, export CSV; owners and admins only', async () => {
  const s = await start();
  try {
    await s.call('/team/permissions', { method: 'PUT', token: s.owner, body: { role: 'agent', action: 'cancel_orders', value: true } });
    await s.call('/team/settings', { method: 'PATCH', token: s.owner, body: { replyMin: 10 } });
    const a = await s.call('/team/audit', { token: s.owner });
    assert.ok(a.body.entries.some((e) => /Allowed "Cancel orders" for agents/.test(e.action)));
    assert.ok(a.body.areas.includes('Team'));
    const perms = await s.call('/team/audit?area=Team%20%C2%B7%20Permissions', { token: s.owner });
    assert.ok(perms.body.entries.length >= 1 && perms.body.entries.every((e) => e.where.startsWith('Team · Permissions')));
    const nobody = await s.call(`/team/audit?user=${999}`, { token: s.owner });
    assert.equal(nobody.body.entries.length, 0);
    const csv = await s.call('/team/audit.csv', { token: s.owner, raw: true });
    assert.match(csv.text, /time,who,what,where/);
    assert.match(csv.text, /Owner,"Allowed ""Cancel orders"" for agents",Team · Permissions/);
    assert.equal((await s.call('/team/audit', { token: s.nadia })).status, 403);
  } finally { await s.close(); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { notify } from '../src/dashboard/notify.js';
import { canSpend } from '../src/ai/metering.js';

async function start() {
  const ctx = await setup({ env: { DRY_RUN: '1', AI_REPLY_DELAY_MS: '0' } });
  const app = createApp(ctx.db, ctx.config, { aiProvider: null, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const root = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${root}/api/dash${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
  };
  const login = async (email) => (await call('/auth/login', { method: 'POST', body: { login: email, password: 'password123' } })).body.token;
  return { ...ctx, app, call, owner: await login('owner@shop.test'), mod: await login('nadia@shop.test'), close: () => new Promise((r) => { app.io.close(); app.server.close(r); }) };
}

test('brands: the owner adds a brand (blank or a copy), switches, and each brand keeps its own data; team and credit are shared', async () => {
  const s = await start();
  try {
    await s.db.insert(s.db.aiRules, { workspace_id: s.ws, text: 'Always greet with salam', category: 'tone', enabled: true });
    await s.db.insert(s.db.savedReplies, { workspace_id: s.ws, shortcut: 'dam', text: 'Dam 1200 taka' });
    await s.db.workspaces.updateOne({ _id: s.ws }, { $set: { ai_name: 'Nusrat', credit_balance: 300 } });
    await s.db.insert(s.db.products, { workspace_id: s.ws, name: 'Kurti', price: 1200 });

    let list = await s.call('/brands', { token: s.owner });
    assert.equal(list.body.brands.length, 1);
    assert.equal(list.body.canAdd, true);
    assert.equal((await s.call('/brands', { token: s.mod })).body.canAdd, false);
    assert.equal((await s.call('/brands', { method: 'POST', token: s.mod, body: { name: 'Kids' } })).status, 403);
    assert.equal((await s.call('/brands', { method: 'POST', token: s.owner, body: { name: ' ' } })).status, 400);

    const made = await s.call('/brands', { method: 'POST', token: s.owner, body: { name: 'Nokshi Kids', copy: true } });
    assert.equal(made.status, 201);
    const kids = await s.db.workspaces.findById(made.body.id).lean();
    assert.deepEqual([kids.brand_group, kids.ai_name, kids.onboarding_step], [s.ws, 'Nusrat', 'channels'], 'copied persona, starts at connect a page');
    assert.equal(await s.db.aiRules.countDocuments({ workspace_id: kids._id }), 1);
    assert.equal(await s.db.savedReplies.countDocuments({ workspace_id: kids._id }), 1);
    assert.equal(await s.db.products.countDocuments({ workspace_id: kids._id }), 0, 'products are not copied');

    // The owner is now in the new brand; their screens show its data only.
    let me = await s.call('/me', { token: s.owner });
    assert.equal(me.body.workspace.name, 'Nokshi Kids');
    assert.equal(me.body.workspace.credit, 300, 'credit is shared with the main shop');
    assert.equal(me.body.brands.length, 2);
    const products = await s.call('/catalog', { token: s.owner });
    assert.equal(products.status, 200);
    assert.equal(JSON.stringify(products.body).includes('Kurti'), false, 'the main shop\'s products stay there');
    // The moderator is still in the main shop.
    assert.equal((await s.call('/me', { token: s.mod })).body.workspace.id, s.ws);

    // The team is shared: the new brand sees the same people, and its alerts reach them.
    const team = await s.call('/team', { token: s.owner });
    assert.deepEqual(team.body.members.map((m) => m.role).sort(), ['moderator', 'moderator', 'owner']);
    const sent = await notify(s.db, () => {}, { push: null }, { workspaceId: kids._id, event: 'handoff', title: 'Kids chat needs a person' }).catch((err) => err);
    assert.ok(!(sent instanceof Error));
    assert.ok(await s.db.notifications.countDocuments({ workspace_id: kids._id }) >= 1, 'the shared team gets the new brand\'s alerts');
    assert.equal((await canSpend(s.db, kids._id)).ok, true, 'the brand spends the shared credit');

    list = await s.call('/brands', { token: s.owner });
    assert.deepEqual(list.body.brands.map((b) => [b.current, b.main]), [[false, true], [true, false]], 'main shop first, the new brand is current');

    // Switch back; a workspace outside the group can't be switched to.
    const other = await s.db.insert(s.db.workspaces, { name: 'Someone else' });
    assert.equal((await s.call(`/brands/${other.id}/switch`, { method: 'POST', token: s.owner })).status, 404);
    assert.equal((await s.call(`/brands/${s.ws}/switch`, { method: 'POST', token: s.owner })).status, 200);
    me = await s.call('/me', { token: s.owner });
    assert.equal(me.body.workspace.id, s.ws);

    const blank = await s.call('/brands', { method: 'POST', token: s.owner, body: { name: 'Kurti Corner' } });
    assert.equal((await s.db.workspaces.findById(blank.body.id).lean()).ai_name, '', 'a blank brand starts empty');
  } finally { await s.close(); }
});

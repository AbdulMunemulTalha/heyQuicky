import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInbox } from '../src/inbox.js';
import { setup, inbound } from './helpers.js';

test('new customers are spread across on-duty moderators', async () => {
  const { db, config, mods } = await setup();
  const inbox = createInbox(db, config);
  const a = (await inbox.ingestMessage(inbound({ contactExternalId: 'c1' }))).conversation;
  const b = (await inbox.ingestMessage(inbound({ contactExternalId: 'c2' }))).conversation;
  const c = (await inbox.ingestMessage(inbound({ contactExternalId: 'c3', platform: 'whatsapp', channelExternalId: 'WA1' }))).conversation;
  assert.deepEqual([a.assigned_user_id, b.assigned_user_id].sort(), [...mods].sort());
  assert.ok(mods.includes(c.assigned_user_id));
});

test('a returning customer always goes back to the same moderator', async () => {
  const { db, config, owner, user } = await setup();
  const inbox = createInbox(db, config);
  const first = (await inbox.ingestMessage(inbound({ contactExternalId: 'rahim' }))).conversation;
  // Lots of other customers arrive in the meantime.
  for (let i = 0; i < 5; i += 1) await inbox.ingestMessage(inbound({ contactExternalId: `other-${i}` }));
  const again = (await inbox.ingestMessage(inbound({ contactExternalId: 'rahim', text: 'size M please' }))).conversation;
  assert.equal(again.id, first.id);
  assert.equal(again.assigned_user_id, first.assigned_user_id);

  // Even after the order is marked done, a new message reopens it with the same moderator.
  await inbox.setStatus(await user(owner), first.id, 'closed');
  const reopened = (await inbox.ingestMessage(inbound({ contactExternalId: 'rahim', text: 'payment done' }))).conversation;
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.assigned_user_id, first.assigned_user_id);
});

test('nobody on duty leaves customers waiting until someone clocks in', async () => {
  const { db, config, mods, user } = await setup({ online: false });
  const inbox = createInbox(db, config);
  const c1 = (await inbox.ingestMessage(inbound({ contactExternalId: 'c1' }))).conversation;
  const c2 = (await inbox.ingestMessage(inbound({ contactExternalId: 'c2' }))).conversation;
  assert.equal(c1.assigned_user_id, null);
  assert.equal(c2.assigned_user_id, null);

  assert.equal(await inbox.setOnDuty(await user(mods[0]), true), 2);
  assert.equal((await inbox.getConversation(c1.id)).assigned_user_id, mods[0]);
  assert.equal((await inbox.getConversation(c2.id)).assigned_user_id, mods[0]);
});

test('webhook retries and unknown pages are ignored', async () => {
  const { db, config } = await setup();
  const inbox = createInbox(db, config);
  const evt = inbound();
  await inbox.ingestMessage(evt);
  assert.deepEqual(await inbox.ingestMessage(evt), { ignored: 'duplicate' });
  assert.deepEqual(await inbox.ingestMessage(inbound({ channelExternalId: 'OTHER' })), { ignored: 'unknown_channel' });
  assert.equal(await db.messages.countDocuments(), 1);
});

test('moderators only see their own and unassigned customers', async () => {
  const { db, config, mods, owner, user } = await setup();
  const inbox = createInbox(db, config);
  await inbox.ingestMessage(inbound({ contactExternalId: 'c1' }));
  await inbox.ingestMessage(inbound({ contactExternalId: 'c2' }));
  const [m1, m2] = await Promise.all(mods.map(user));
  assert.equal((await inbox.listConversations(m1, { filter: 'mine' })).length, 1);
  assert.equal((await inbox.listConversations(m1, { filter: 'all' })).length, 1, 'moderators cannot list everything');
  assert.equal((await inbox.listConversations(await user(owner), { filter: 'all' })).length, 2);
  const theirs = (await inbox.listConversations(m2, { filter: 'mine' }))[0];
  await assert.rejects(inbox.listMessages(m1, theirs.id), /not found/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';

test('numeric IDs count up per collection', async () => {
  const db = await freshDb();
  const a = await db.insert(db.workspaces, { name: 'A' });
  const b = await db.insert(db.workspaces, { name: 'B' });
  const u = await db.insert(db.savedReplies, { workspace_id: a.id, shortcut: 'x', text: 'y' });
  assert.deepEqual([a.id, b.id, u.id], [1, 2, 1]);
});

test('findOrCreate returns the existing document instead of a duplicate', async () => {
  const db = await freshDb();
  const filter = { channel_id: 1, external_id: 'cust' };
  const first = await db.findOrCreate(db.contacts, filter, { workspace_id: 1 });
  const racing = await Promise.all([1, 2, 3].map(() => db.findOrCreate(db.contacts, filter, { workspace_id: 1 })));
  assert.equal(first.created, true);
  assert.ok(racing.every((r) => !r.created && r.doc.id === first.doc.id));
  assert.equal(await db.contacts.countDocuments(), 1);
});

test('the same Meta message ID can only be stored once', async () => {
  const db = await freshDb();
  await db.insert(db.messages, { conversation_id: 1, direction: 'in', external_id: 'mid.1' });
  await assert.rejects(db.insert(db.messages, { conversation_id: 1, direction: 'in', external_id: 'mid.1' }), (err) => err.code === 11000);
  // Messages without a Meta ID yet (pending replies) don't clash with each other.
  await db.insert(db.messages, { conversation_id: 1, direction: 'out' });
  await db.insert(db.messages, { conversation_id: 1, direction: 'out' });
  assert.equal(await db.messages.countDocuments(), 3);
});

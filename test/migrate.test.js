import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb as openLegacy } from './fixtures/legacySqlite.js';
import { migrateSqlite } from '../src/migrateSqlite.js';
import { createInbox } from '../src/inbox.js';
import { createOrders } from '../src/orders.js';
import { userForToken } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { freshDb } from './helpers.js';

function legacyShop(path) {
  const old = openLegacy(path);
  old.exec(`
    INSERT INTO workspaces (id, name, delivery_inside_dhaka) VALUES (3, 'Rupa Fashion', 60);
    INSERT INTO users (id, workspace_id, name, email, password_hash, role, is_online) VALUES
      (5, 3, 'Owner', 'Owner@Rupa.test', 'scrypt$x$y', 'owner', 1),
      (6, 3, 'Nadia', 'nadia@rupa.test', 'scrypt$x$y', 'moderator', 1);
    INSERT INTO sessions (token, user_id, expires_at) VALUES ('live', 5, '2999-01-01T00:00:00.000Z'), ('old', 5, '2001-01-01T00:00:00.000Z');
    INSERT INTO channels (id, workspace_id, platform, external_id, name, access_token, needs_reconnect) VALUES (9, 3, 'messenger', 'PAGE', 'Rupa', 'enc:v1:abc', 1);
    INSERT INTO contacts (id, workspace_id, channel_id, external_id, name) VALUES (11, 3, 9, 'PSID', 'Sumi');
    INSERT INTO conversations (id, workspace_id, channel_id, contact_id, assigned_user_id, unread_count, last_message_at, last_inbound_at, last_message_preview)
      VALUES (20, 3, 9, 11, 6, 1, '2026-10-05T10:00:00.000Z', '2026-10-05T10:00:00.000Z', 'dam koto?');
    INSERT INTO messages (id, conversation_id, direction, text, attachments, external_id, status, created_at)
      VALUES (40, 20, 'in', 'dam koto?', '[{"type":"image","url":"https://cdn/a.jpg"}]', 'mid.1', 'received', '2026-10-05T10:00:00.000Z');
    INSERT INTO orders (id, workspace_id, conversation_id, created_by_user_id, customer_name, phone, address, area, items,
      subtotal, delivery_charge, cod_amount) VALUES (12, 3, 20, 6, 'Sumi', '01711111111', 'Mirpur', 'inside_dhaka',
      '[{"name":"Saree","qty":1,"price":1200}]', 1200, 60, 1260);
    INSERT INTO saved_replies (id, workspace_id, shortcut, text) VALUES (2, 3, 'bkash', 'Send to 017...');
  `);
  old.close();
}

test('moves a SQLite shop into MongoDB with the same IDs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quicky-'));
  try {
    const path = join(dir, 'quicky.db');
    legacyShop(path);
    const db = await freshDb();
    const counts = await migrateSqlite(path, db);
    assert.deepEqual(counts, {
      workspaces: 1, users: 2, sessions: 1, channels: 1, contacts: 1, conversations: 1, messages: 1, orders: 1, saved_replies: 1,
    });

    // Signed-in owners stay signed in; emails are matched without case.
    const owner = await userForToken(db, 'live');
    assert.equal(owner.id, 5);
    assert.equal(owner.email, 'owner@rupa.test');
    assert.equal(await userForToken(db, 'old'), null);

    const channel = await db.channels.findById(9).lean();
    assert.equal(channel.needs_reconnect, true);
    assert.equal(channel.access_token, 'enc:v1:abc', 'encrypted tokens are copied as they are');

    const inbox = createInbox(db, loadConfig({ DRY_RUN: '1' }));
    const [conversation] = await inbox.listConversations(owner, { filter: 'all' });
    assert.equal(conversation.id, 20);
    assert.equal(conversation.contact_name, 'Sumi');
    assert.equal(conversation.assigned_user_name, 'Nadia');
    const [message] = await inbox.listMessages(owner, 20);
    assert.deepEqual(message.attachments, [{ type: 'image', url: 'https://cdn/a.jpg' }]);
    assert.ok(message.created_at instanceof Date);

    // New records continue after the migrated ones, and old order numbers still work.
    const orders = createOrders(db, inbox);
    assert.equal((await orders.list(owner, { q: '#12' }))[0].items[0].name, 'Saree');
    const nadia = { id: 6, workspace_id: 3, role: 'moderator', name: 'Nadia' };
    const { order } = await orders.create(nadia, 20, {
      customerName: 'Sumi', phone: '01711111111', address: 'Mirpur', area: 'inside_dhaka', items: [{ name: 'Scarf', qty: 1, price: 300 }],
    });
    assert.equal(order.id, 13);
    assert.equal(order.delivery_charge, 60, "the shop's own delivery charge carries over");

    // A second run would mix data, so it is refused.
    await assert.rejects(migrateSqlite(path, db), /already has data/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a copy that fails halfway leaves MongoDB empty so it can be retried', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quicky-'));
  try {
    const path = join(dir, 'quicky.db');
    legacyShop(path);
    const db = await freshDb();
    // Messages are copied after workspaces, users, channels and conversations.
    const failing = Object.create(db.messages, {
      collection: { value: { collectionName: 'messages', insertMany: async () => { throw new Error('disk full'); } } },
    });
    await assert.rejects(migrateSqlite(path, { ...db, messages: failing }), /disk full/);
    for (const key of ['workspaces', 'users', 'channels', 'conversations', 'counters']) {
      assert.equal(await db[key].countDocuments(), 0, `${key} is emptied`);
    }
    assert.equal((await migrateSqlite(path, db)).messages, 1, 'the retry copies everything');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

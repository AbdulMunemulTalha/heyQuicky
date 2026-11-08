import { DatabaseSync } from 'node:sqlite';

// Copies a Quicky SQLite database (the format used before MongoDB) into
// MongoDB, keeping every ID so links, order numbers and sessions stay valid.
// Refuses to run into a database that already has data, so it can't mix two shops' records.

const toBool = (v) => Boolean(Number(v));
const toDate = (v) => (v ? new Date(v) : null);
const json = (v, fallback) => {
  try { return JSON.parse(v); } catch { return fallback; }
};

// SQLite table -> [model key, row converter]. Order matters only for readability;
// there are no foreign key checks in MongoDB.
const TABLES = [
  ['workspaces', 'workspaces', (r) => ({
    _id: r.id, name: r.name, phone: r.phone ?? '', category: r.category ?? '',
    onboarding_step: r.onboarding_step ?? 'done',
    delivery_inside_dhaka: r.delivery_inside_dhaka ?? 70, delivery_outside_dhaka: r.delivery_outside_dhaka ?? 130,
    created_at: toDate(r.created_at),
  })],
  ['users', 'users', (r) => ({
    _id: r.id, workspace_id: r.workspace_id, name: r.name, email: String(r.email).trim().toLowerCase(),
    password_hash: r.password_hash, role: r.role, is_active: toBool(r.is_active), is_online: toBool(r.is_online),
    last_assigned_at: toDate(r.last_assigned_at), created_at: toDate(r.created_at),
  })],
  ['sessions', 'sessions', (r) => ({ _id: r.token, user_id: r.user_id, expires_at: toDate(r.expires_at) })],
  ['channels', 'channels', (r) => ({
    _id: r.id, workspace_id: r.workspace_id, platform: r.platform, external_id: r.external_id, name: r.name,
    access_token: r.access_token ?? '', needs_reconnect: toBool(r.needs_reconnect), waba_id: r.waba_id ?? null,
    page_id: r.page_id ?? null, import_status: r.import_status ?? '', import_count: r.import_count ?? 0,
    import_error: r.import_error ?? null, created_at: toDate(r.created_at),
  })],
  ['contacts', 'contacts', (r) => ({
    _id: r.id, workspace_id: r.workspace_id, channel_id: r.channel_id, external_id: r.external_id,
    name: r.name ?? null, created_at: toDate(r.created_at),
  })],
  ['conversations', 'conversations', (r) => ({
    _id: r.id, workspace_id: r.workspace_id, channel_id: r.channel_id, contact_id: r.contact_id,
    assigned_user_id: r.assigned_user_id ?? null, status: r.status, unread_count: r.unread_count,
    last_message_at: toDate(r.last_message_at), last_message_preview: r.last_message_preview ?? '',
    last_inbound_at: toDate(r.last_inbound_at), created_at: toDate(r.created_at),
  })],
  ['messages', 'messages', (r) => ({
    _id: r.id, conversation_id: r.conversation_id, direction: r.direction, sender_user_id: r.sender_user_id ?? null,
    text: r.text ?? '', attachments: json(r.attachments, []), external_id: r.external_id ?? null,
    status: r.status, error: r.error ?? null, created_at: toDate(r.created_at),
  })],
  ['orders', 'orders', (r) => ({
    _id: r.id, workspace_id: r.workspace_id, conversation_id: r.conversation_id ?? null,
    created_by_user_id: r.created_by_user_id ?? null, customer_name: r.customer_name, phone: r.phone,
    address: r.address, area: r.area, items: json(r.items, []), subtotal: r.subtotal, delivery_charge: r.delivery_charge,
    discount: r.discount, advance_paid: r.advance_paid, cod_amount: r.cod_amount, payment_method: r.payment_method,
    status: r.status, note: r.note ?? '', created_at: toDate(r.created_at), updated_at: toDate(r.updated_at),
  })],
  ['saved_replies', 'savedReplies', (r) => ({ _id: r.id, workspace_id: r.workspace_id, shortcut: r.shortcut, text: r.text })],
  // oauth_states and pending_connections live for minutes; they are not worth copying.
];

export async function migrateSqlite(sqlitePath, db, { batchSize = 1000, log = () => {} } = {}) {
  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    for (const [, key] of TABLES) {
      if (await db[key].estimatedDocumentCount()) {
        throw new Error(`MongoDB collection ${db[key].collection.collectionName} already has data; migrate into an empty database`);
      }
    }
    const tables = new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
    const counts = {};
    const now = new Date();
    try {
      for (const [table, key, convert] of TABLES) {
        if (!tables.has(table)) { counts[table] = 0; continue; }
        let docs = sqlite.prepare(`SELECT * FROM ${table}`).all().map((r) => convert({ ...r }));
        if (table === 'sessions') docs = docs.filter((d) => d.expires_at > now);
        for (let i = 0; i < docs.length; i += batchSize) {
          // Raw driver insert: the documents are already in their final shape.
          await db[key].collection.insertMany(docs.slice(i, i + batchSize), { ordered: true });
        }
        counts[table] = docs.length;
        // New records continue numbering after the highest migrated ID.
        if (table !== 'sessions' && docs.length) {
          const max = docs.reduce((m, d) => Math.max(m, d._id), 0);
          await db.counters.updateOne({ _id: db[key].collection.collectionName }, { $max: { seq: max } }, { upsert: true });
        }
        log(`${table}: ${docs.length}`);
      }
    } catch (err) {
      // The collections were empty before, so emptying them undoes a half-finished
      // copy and the next attempt starts clean.
      await Promise.all([...TABLES.map(([, key]) => db[key].deleteMany({})), db.counters.deleteMany({})]);
      throw err;
    }
    return counts;
  } finally {
    sqlite.close();
  }
}

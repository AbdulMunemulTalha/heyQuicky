// Numbered, run-once data migrations. Each id is recorded in the `migrations` collection,
// so starting the server again never repeats one. Add new ones at the end; never edit old ones.
export const MIGRATIONS = [
  {
    id: '001-order-numbers',
    // Orders get a per-shop number (#1001…) that customers and the team see.
    async up(db) {
      const workspaces = await db.workspaces.find({}, { _id: 1 }).lean();
      for (const w of workspaces) {
        const orders = await db.orders.find({ workspace_id: w._id, number: null }, { _id: 1 }).sort({ _id: 1 }).lean();
        const ws = await db.workspaces.findById(w._id, { order_seq: 1 }).lean();
        let seq = ws.order_seq ?? 1000;
        for (const o of orders) {
          seq += 1;
          await db.orders.updateOne({ _id: o._id }, { $set: { number: seq } });
        }
        await db.workspaces.updateOne({ _id: w._id }, { $set: { order_seq: seq } });
      }
    },
  },
  {
    id: '002-customers-from-contacts',
    // One customer per existing contact, linked from its conversation, so the Customers screen isn't empty.
    async up(db) {
      const contacts = await db.contacts.find({}).lean();
      for (const c of contacts) {
        const exists = await db.customers.exists({ workspace_id: c.workspace_id, contact_ids: c._id });
        if (exists) continue;
        const customer = await db.insert(db.customers, { workspace_id: c.workspace_id, name: c.name ?? '', contact_ids: [c._id] });
        await db.conversations.updateMany({ contact_id: c._id }, { $set: { customer_id: customer.id } });
      }
    },
  },
  {
    id: '003-indexes',
    async up(db) {
      await db.orders.collection.createIndex({ workspace_id: 1, number: -1 });
      await db.messages.collection.createIndex({ text: 'text' }, { default_language: 'none' });
    },
  },
];

export async function runMigrations(db, { log = () => {} } = {}) {
  const done = new Set((await db.migrations.find({}, { _id: 1 }).lean()).map((m) => m._id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    log(`migration ${m.id}`);
    await m.up(db);
    await db.migrations.create({ _id: m.id });
  }
}

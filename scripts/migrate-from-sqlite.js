// One-time move of an existing Quicky SQLite database into MongoDB.
//   node scripts/migrate-from-sqlite.js /data/quicky.db
// MONGODB_URI picks the target database. It must be empty.
import { existsSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { migrateSqlite } from '../src/migrateSqlite.js';

const path = process.argv[2];
if (!path || !existsSync(path)) {
  console.error('Usage: node scripts/migrate-from-sqlite.js <path to quicky.db>');
  process.exit(1);
}

const config = loadConfig();
const db = await openDb(config.mongoUrl);
try {
  const counts = await migrateSqlite(path, db, { log: (line) => console.log(`  ${line}`) });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`Copied ${total} records from ${path} into MongoDB.`);
} catch (err) {
  console.error(`Migration failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}

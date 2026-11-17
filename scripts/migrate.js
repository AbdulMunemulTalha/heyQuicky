// Runs any data migrations that haven't run yet (the server also does this at start).
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { runMigrations } from '../src/dashboard/migrations.js';

const db = await openDb(loadConfig().mongoUrl);
await runMigrations(db, { log: (line) => console.log(line) });
console.log('Migrations done.');
await db.close();

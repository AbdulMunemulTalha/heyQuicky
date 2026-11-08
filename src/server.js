import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { existsSync } from 'node:fs';
import { createApp } from './app.js';
import { migrateSqlite } from './migrateSqlite.js';

const config = loadConfig();

if (config.isProduction && !config.meta.appSecret) {
  console.warn('Warning: META_APP_SECRET is not set, webhooks will be rejected.');
}
if (config.isProduction && !config.tokenKey) {
  console.error('TOKEN_ENCRYPTION_KEY must be set in production so access tokens are stored encrypted.');
  process.exit(1);
}

const db = await openDb(config.mongoUrl);

if (config.sqliteImportPath && existsSync(config.sqliteImportPath) && !(await db.workspaces.estimatedDocumentCount())) {
  console.log(`Copying the old SQLite database ${config.sqliteImportPath} into MongoDB…`);
  const counts = await migrateSqlite(config.sqliteImportPath, db, { log: (line) => console.log(`  ${line}`) });
  console.log(`Done: ${Object.values(counts).reduce((a, b) => a + b, 0)} records copied.`);
}
const { server, inbox } = createApp(db, config);

server.listen(config.port, () => {
  inbox.fillMissingNames().catch((err) => console.warn('name backfill failed:', err.message));
  console.log(`Quicky running on http://localhost:${config.port}${config.dryRun ? ' (dry run: replies are not sent to Meta)' : ''}`);
});

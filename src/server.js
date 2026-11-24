import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { existsSync } from 'node:fs';
import { createApp } from './app.js';
import { migrateSqlite } from './migrateSqlite.js';
import { runMigrations } from './dashboard/migrations.js';
import { startCourierSync } from './routes/dashboard/orderDetail.js';
import { startFollowups } from './dashboard/followups.js';
import { startBookingReminders } from './dashboard/bookings.js';
import { startSelfTests } from './dashboard/selftest.js';
import { startPageSubscriptions } from './dashboard/pageSubscriptions.js';
import { startSlaWatch } from './dashboard/team.js';
import { remindCallbacks } from './dashboard/callbacks.js';

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
await runMigrations(db, { log: (line) => console.log(line) });
const { server, inbox, io, notify, deliveryUpdates, agent } = createApp(db, config);
// Parcels on the way are checked with their courier every 30 minutes (CRR-02).
// Follow-up reminders for customers who went quiet are checked every 5 minutes (FUP-01).
startFollowups(db, inbox);
startBookingReminders(db, inbox);
startSelfTests(db, agent, { notify });
// Connected Pages also get button taps from cards (screen 24).
startPageSubscriptions(db, config);
startSlaWatch(db, notify);
startCourierSync(db, config, { emit: (ws, event, payload) => io.to(`workspace:${ws}`).emit(event, payload), notify });
// Scheduled callbacks remind their owner when it's time to call (FUP-04).
setInterval(() => remindCallbacks(db, notify).catch((err) => console.warn('callback reminders:', err.message)), 60_000).unref();
// A day after delivery the customer is asked for a rating (CRR-06), checked every 30 minutes.
setInterval(() => deliveryUpdates.sendDueReviews().catch((err) => console.warn('review requests:', err.message)), 30 * 60_000).unref();

server.listen(config.port, () => {
  inbox.fillMissingNames().catch((err) => console.warn('name backfill failed:', err.message));
  console.log(`Quicky running on http://localhost:${config.port}${config.dryRun ? ' (dry run: replies are not sent to Meta)' : ''}`);
});

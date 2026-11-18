// Development only: creates the "Nokshi Threads" shop from the designs, with its team, chats,
// products, orders and AI history, so every dashboard screen has realistic data to show.
//   npm run seed:demo            (login: talha@nokshithreads.com / password123)
//   npm run seed:demo -- --reset (deletes the demo shop first)
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { runMigrations } from '../src/dashboard/migrations.js';
import { seedNokshi } from '../src/dashboard/demoSeed.js';

const config = loadConfig();
if (config.isProduction) {
  console.error('seed:demo is for development only and refuses to run with NODE_ENV=production.');
  process.exit(1);
}
const db = await openDb(config.mongoUrl);
await runMigrations(db);
const result = await seedNokshi(db, { reset: process.argv.includes('--reset'), history: !process.argv.includes('--no-history') });
console.log(result.created ? `Created Nokshi Threads (workspace ${result.workspaceId}). Log in as talha@nokshithreads.com / password123` : 'Nokshi Threads already exists (use --reset to recreate it).');
await db.close();

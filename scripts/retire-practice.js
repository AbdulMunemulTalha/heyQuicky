// Practice mode is switched off for now (src/dashboard/aiMode.js). The server moves shops off Practice once
// at start (migration 004-retire-practice); this script does the same by hand, or undoes it:
//   node scripts/retire-practice.js            move shops off Practice
//   node scripts/retire-practice.js --restore  put every moved shop back to the mode it had
// Before restoring, set FEATURE_PRACTICE=1 so the server shows Practice again.
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { restorePractice, retirePractice } from '../src/dashboard/practice.js';

const db = await openDb(loadConfig().mongoUrl);
const log = (line) => console.log(line);
const r = process.argv.includes('--restore') ? await restorePractice(db, { log }) : await retirePractice(db, { log });
console.log(r);
await db.close();

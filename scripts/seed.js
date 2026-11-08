// Creates a demo business with an owner, two moderators and three test channels.
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

const config = loadConfig();
const db = await openDb(config.mongoUrl);

if (await db.users.exists({ email: 'owner@demo.test' })) {
  console.log('Demo data already exists.');
  await db.close();
  process.exit(0);
}

const PASSWORD = 'password123';

const ws = (await db.insert(db.workspaces, { name: 'Demo Fashion House' })).id;
const addUser = (name, email, role) =>
  db.insert(db.users, { workspace_id: ws, name, email, password_hash: hashPassword(PASSWORD), role, is_online: true });
await addUser('Owner', 'owner@demo.test', 'owner');
await addUser('Nadia', 'nadia@demo.test', 'moderator');
await addUser('Karim', 'karim@demo.test', 'moderator');

const addChannel = (platform, externalId, name) =>
  db.insert(db.channels, { workspace_id: ws, platform, external_id: externalId, name });
await addChannel('messenger', 'demo-page', 'Demo Fashion House Page');
await addChannel('instagram', 'demo-ig', '@demofashionhouse');
await addChannel('whatsapp', 'demo-wa', '+880 1700-000000');

const addReply = (shortcut, text) => db.insert(db.savedReplies, { workspace_id: ws, shortcut, text });
await addReply('price', 'Ei product er dam 1,200 taka. Order korte apnar naam, phone number ar full address din please.');
await addReply('delivery', 'Dhakar moddhe delivery charge 70 taka, Dhakar baire 130 taka. 2-3 diner moddhe delivery hobe.');
await addReply('bkash', 'Advance payment bKash e pathan: 01700-000000 (Personal). Send Money korar por last 4 digit janan.');

console.log(`Demo data created. Sign in as owner@demo.test, nadia@demo.test or karim@demo.test with "${PASSWORD}".`);
await db.close();

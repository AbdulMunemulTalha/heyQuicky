import { after } from 'node:test';
import { randomBytes } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import { openDb, row } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

// One in-memory MongoDB per test file; every setup() gets its own database in it.
let mongo;
const open = [];

export async function mongoUri() {
  mongo ??= await MongoMemoryServer.create();
  return mongo.getUri();
}

after(async () => {
  await Promise.all(open.map((db) => db.close()));
  await mongo?.stop();
});

export async function freshDb() {
  const db = await openDb(await mongoUri(), { dbName: `t_${randomBytes(6).toString('hex')}` });
  open.push(db);
  return db;
}

export async function setup({ moderators = ['Nadia', 'Karim'], online = true, env = {} } = {}) {
  const db = await freshDb();
  const config = loadConfig(env);
  const ws = (await db.insert(db.workspaces, { name: 'Shop' })).id;
  const hash = hashPassword('password123');
  const addUser = async (name, email, role, isOnline) =>
    (await db.insert(db.users, { workspace_id: ws, name, email, password_hash: hash, role, is_online: isOnline })).id;
  const owner = await addUser('Owner', 'owner@shop.test', 'owner', true);
  const mods = [];
  for (const name of moderators) mods.push(await addUser(name, `${name.toLowerCase()}@shop.test`, 'moderator', online));
  for (const [platform, externalId, name] of [['messenger', 'PAGE1', 'Page'], ['instagram', 'IG1', 'Insta'], ['whatsapp', 'WA1', 'WhatsApp']]) {
    await db.insert(db.channels, { workspace_id: ws, platform, external_id: externalId, name, access_token: 'tok' });
  }
  const user = async (id) => {
    const u = row(await db.users.findById(id, { workspace_id: 1, name: 1, email: 1, role: 1 }).lean());
    return u;
  };
  return { db, config, ws, owner, mods, user };
}

let n = 0;
export function inbound(overrides = {}) {
  n += 1;
  return {
    platform: 'messenger',
    channelExternalId: 'PAGE1',
    contactExternalId: 'cust-1',
    contactName: null,
    direction: 'in',
    messageId: `m_${n}`,
    text: 'hello',
    attachments: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

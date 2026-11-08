// Starts a local MongoDB for development on mongodb://127.0.0.1:27017, with
// data kept in data/mongo between runs. Uses the same MongoDB binary as the
// tests, so nothing else needs installing. Stop it with Ctrl+C.
import { mkdirSync } from 'node:fs';
import { MongoMemoryServer } from 'mongodb-memory-server-core';

const dbPath = 'data/mongo';
mkdirSync(dbPath, { recursive: true });

const server = await MongoMemoryServer.create({
  instance: { port: Number(process.env.MONGO_PORT || 27017), dbPath, storageEngine: 'wiredTiger' },
});
console.log(`MongoDB running at ${server.getUri()} (data in ${dbPath})`);

const stop = async () => {
  await server.stop({ doCleanup: false });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

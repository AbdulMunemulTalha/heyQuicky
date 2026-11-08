import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { userForToken } from './auth.js';
import { createInbox } from './inbox.js';
import { createOrders } from './orders.js';
import { createImporter } from './importer.js';
import { apiRoutes } from './routes/api.js';
import { webhookRoutes } from './routes/webhooks.js';
import { connectRoutes } from './routes/connect.js';
import { legalRoutes } from './routes/legal.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
// The React dashboard, built by `npm run build`.
const CLIENT_DIR = fileURLToPath(new URL('../client/dist', import.meta.url));

export function createApp(db, config, { fetchImpl, clientDir = CLIENT_DIR } = {}) {
  const app = express();
  const server = createServer(app);
  const io = new Server(server);

  const emit = (workspaceId, event, payload) => io.to(`workspace:${workspaceId}`).emit(event, payload);
  const inbox = createInbox(db, config, { emit, fetchImpl });
  const orders = createOrders(db, inbox, { emit });
  const importer = createImporter(db, config, inbox, { fetchImpl, emit });

  io.use(async (socket, next) => {
    try {
      const user = await userForToken(db, socket.handshake.auth?.token);
      if (!user) return next(new Error('unauthorized'));
      socket.join(`workspace:${user.workspace_id}`);
      next();
    } catch (err) {
      next(err);
    }
  });

  app.disable('x-powered-by');
  // Keep the raw body so webhook signatures can be checked against the exact bytes.
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use(webhookRoutes(config, inbox, { db, emit }));
  app.use(connectRoutes(db, config, { fetchImpl, emit, importer }));
  app.use(legalRoutes(config));
  app.use('/api', apiRoutes(db, config, inbox, orders, importer));
  // The dashboard is a single page; its assets live under /app/assets.
  app.use('/app', express.static(clientDir, { index: false }));
  app.get(['/app', '/app/'], (_req, res) => {
    if (!existsSync(join(clientDir, 'index.html'))) {
      return res.status(503).type('text/plain').send('The dashboard has not been built yet. Run: npm run build');
    }
    res.sendFile('index.html', { root: clientDir });
  });
  app.get('/bn', (_req, res) => res.sendFile('bn.html', { root: PUBLIC_DIR }));
  app.use(express.static(PUBLIC_DIR));

  return { app, server, io, inbox, orders, importer };
}

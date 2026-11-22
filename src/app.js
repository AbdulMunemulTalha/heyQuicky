import { timingSafeEqual } from 'node:crypto';
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
import { createAiProvider } from './ai/provider.js';
import { createAgent } from './ai/agent.js';
import { createTranscriber } from './ai/transcribe.js';
import { onStatusChange, onCourierStatus } from './dashboard/orderOps.js';
import { createDeliveryUpdater } from './dashboard/deliveryUpdates.js';
import { recordReturn } from './dashboard/money.js';
import { apiRoutes } from './routes/api.js';
import { webhookRoutes } from './routes/webhooks.js';
import { connectRoutes } from './routes/connect.js';
import { legalRoutes } from './routes/legal.js';
import { dashboardRoutes } from './routes/dashboard/index.js';
import { dashboardMounts } from './routes/dashboard/mounts.js';
import { createAdapters } from './adapters/index.js';
import { attachPresence } from './dashboard/presence.js';
import { fileRoute } from './routes/dashboard/savedReplies.js';
import { adminRoutes } from './routes/admin.js';
import { createNotifier } from './dashboard/notify.js';
import { billRoutes } from './routes/bill.js';
import { sizePageRoutes } from './routes/sizePage.js';
import { createPostbackHandler } from './dashboard/postbacks.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
// The React dashboard, built by `npm run build`.
const CLIENT_DIR = fileURLToPath(new URL('../client/dist', import.meta.url));

// aiProvider: optional stand-in for the model provider (tests); by default it comes from config.
// Sign-up leads for following up, as a spreadsheet. Off unless ADMIN_TOKEN is set.
function leadsCsvRoute(db, config) {
  const cell = (v) => {
    const s = v instanceof Date ? v.toISOString() : String(v ?? '');
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s; // stops spreadsheet formulas
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return async (req, res, next) => {
    try {
      if (!config.adminToken) return res.sendStatus(404);
      const [scheme, encoded] = String(req.get('authorization') ?? '').split(' ');
      const [, password = ''] = scheme === 'Basic' ? Buffer.from(encoded ?? '', 'base64').toString().split(/:(.*)/s) : [];
      const a = Buffer.from(password);
      const b = Buffer.from(config.adminToken);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return res.set('WWW-Authenticate', 'Basic realm="HeyQuicky leads"').sendStatus(401);
      }
      const leads = await db.leads.find().sort({ updated_at: -1 }).limit(20_000).lean();
      const head = ['signed_up', 'name', 'shop', 'email', 'mobile', 'messages_per_day', 'team_size', 'ad_spend', 'workspace_id', 'first_seen', 'last_updated'];
      const rows = leads.map((l) => [l.converted_at ? 'yes' : 'no', l.name, l.business_name, l.email, l.phone,
        l.survey?.messages_per_day, l.survey?.team_size, l.survey?.ad_spend, l.workspace_id, l.created_at, l.updated_at]);
      res.type('text/csv').set('Content-Disposition', 'attachment; filename="heyquicky-leads.csv"')
        .send([head, ...rows].map((r) => r.map(cell).join(',')).join('\n'));
    } catch (err) {
      next(err);
    }
  };
}

export function createApp(db, config, { fetchImpl, clientDir = CLIENT_DIR, aiProvider, adapters = createAdapters(process.env, { fetchImpl }) } = {}) {
  const app = express();
  const server = createServer(app);
  const io = new Server(server);

  const emit = (workspaceId, event, payload) => io.to(`workspace:${workspaceId}`).emit(event, payload);
  const notify = createNotifier(db, emit, adapters);
  const inbox = createInbox(db, config, { emit, fetchImpl });
  const orders = createOrders(db, inbox, { emit, notify });
  const importer = createImporter(db, config, inbox, { fetchImpl, emit });
  const provider = aiProvider === undefined ? createAiProvider(config.ai) : aiProvider;
  const agent = createAgent(db, inbox, provider, { replyDelayMs: config.ai.replyDelayMs, notify, config, emit, fetchImpl,
    transcriber: createTranscriber({ apiKey: config.ai.openaiKey, model: config.ai.transcribeModel }) });
  inbox.setInboundHandler(agent.onInbound);
  const deliveryUpdates = createDeliveryUpdater(db, inbox, config, { notify });
  onStatusChange(db, async (order, from, to) => {
    if (to === 'returned') await recordReturn(db, order).catch((err) => console.warn(`return record for order ${order._id}: ${err.message}`));
    return deliveryUpdates.onStatus(order, from, to);
  });
  onCourierStatus(db, deliveryUpdates.onCourier);
  inbox.setPostbackHandler(createPostbackHandler(db, inbox, { notify, emit, publicUrl: config.publicUrl }));

  io.use(async (socket, next) => {
    try {
      const user = await userForToken(db, socket.handshake.auth?.token);
      if (!user) return next(new Error('unauthorized'));
      socket.data.user = user;
      socket.join(`workspace:${user.workspace_id}`);
      next();
    } catch (err) {
      next(err);
    }
  });

  attachPresence(io);

  app.disable('x-powered-by');
  // Keep the raw body so webhook signatures can be checked against the exact bytes.
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/admin/leads.csv', leadsCsvRoute(db, config));
  app.use(adminRoutes(db, config, { notify }));
  app.get('/files/:id', fileRoute(db));
  app.use(webhookRoutes(config, inbox, { db, emit, onComment: agent.replyToComment }));
  app.use(connectRoutes(db, config, { fetchImpl, emit, importer }));
  app.use(legalRoutes(config));
  // Customer bill pages (screen 20): public, behind each order's unguessable link.
  app.use(billRoutes(db, config, { notify }));
  app.use(sizePageRoutes(db));
  app.use('/api/dash', dashboardRoutes(db, config, { adapters, inbox, orders, agent, importer, emit, notify, io, fetchImpl, mounts: dashboardMounts }));
  app.use('/api', apiRoutes(db, config, inbox, orders, importer, agent, { fetchImpl }));
  // The dashboard is a single page; its assets live under /app/assets.
  app.use('/app', express.static(clientDir, { index: false }));
  app.get(['/app', '/app/'], (_req, res) => {
    if (!existsSync(join(clientDir, 'index.html'))) {
      return res.status(503).type('text/plain').send('The dashboard has not been built yet. Run: npm run build');
    }
    res.sendFile('index.html', { root: clientDir });
  });
  // Dashboard deep links (/app/orders/1051 …) load the same single page.
  app.get('/app/{*rest}', (_req, res, next) => {
    if (!existsSync(join(clientDir, 'index.html'))) return next();
    res.sendFile('index.html', { root: clientDir });
  });
  app.get('/bn', (_req, res) => res.sendFile('bn.html', { root: PUBLIC_DIR }));
  app.use(express.static(PUBLIC_DIR));

  return { app, server, io, inbox, orders, importer, agent, adapters, notify, deliveryUpdates };
}

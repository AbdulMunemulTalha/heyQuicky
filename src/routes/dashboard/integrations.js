import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { InboxError } from '../../inbox.js';
import { audit } from '../../dashboard/util.js';
import { encryptSecret } from '../../secrets.js';
import { CAPI_EVENTS, capiSettings } from '../../dashboard/capi.js';
import { widgetSettings } from '../widget.js';
import { ensureShopSlug } from '../../dashboard/productPage.js';
import { EVENTS, endpointsOf, addEndpoint, fireEvent } from '../../dashboard/webhooks.js';
import { newApiKey } from '../publicApi.js';

// Phase 2 · Integrations (ANL-09 Meta Conversions API, INT-02 website chat widget), frame "Integrations".
export function integrationRoutes(db, config, { auth, emit, webhooks }) {
  const router = Router();
  const ownerOrAdmin = (req, res, next) => (['owner', 'admin'].includes(req.user.role) ? next() : res.status(403).json({ error: 'Only the owner or an admin can change integrations' }));
  const base = (req) => (config.publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

  async function view(req) {
    const ws = await db.workspaces.findById(req.user.workspace_id, { settings: 1, name: 1, shop_slug: 1 }).lean();
    const shopSlug = await ensureShopSlug(db, ws);
    const since = new Date(Date.now() - 7 * 86_400_000);
    const [counts, last, failed, widget] = await Promise.all([
      db.capiEvents.aggregate([{ $match: { workspace_id: ws._id, created_at: { $gte: since }, status: { $ne: 'failed' } } }, { $group: { _id: '$key', n: { $sum: 1 } } }]),
      db.capiEvents.findOne({ workspace_id: ws._id }).sort({ _id: -1 }).lean(),
      db.capiEvents.findOne({ workspace_id: ws._id, status: 'failed', created_at: { $gte: since } }).sort({ _id: -1 }).lean(),
      db.channels.findOne({ workspace_id: ws._id, platform: 'web' }).lean(),
    ]);
    const capi = capiSettings(ws);
    const w = widgetSettings(ws);
    const chats = widget ? await db.conversations.countDocuments({ channel_id: widget._id, created_at: { $gte: since } }) : 0;
    return {
      capi: { ...capi, sent: Object.fromEntries(Object.keys(CAPI_EVENTS).map((k) => [k, counts.find((c) => c._id === k)?.n ?? 0])), names: Object.fromEntries(Object.entries(CAPI_EVENTS).map(([k, e]) => [k, e.name])),
        lastAt: last?.created_at ?? null, lastStatus: last?.status ?? null, lastError: failed?.error ?? '', testMode: Boolean(config.dryRun) },
      widget: { on: Boolean(widget) && !ws.settings?.widget?.off, setUp: Boolean(widget), ...w, chats7d: chats,
        snippet: widget ? `<script src="${base(req)}/w/${widget.external_id}.js" async></script>` : '', previewUrl: widget ? `${base(req)}/w/${widget.external_id}` : '' },
      woo: { connected: Boolean(ws.settings?.woo?.url), url: ws.settings?.woo?.url ?? '' },
      // HND-05: browsers where this person connected the Business Suite extension.
      extension: { connected: await db.sessions.countDocuments({ user_id: req.user.id, device: 'Chrome extension · Business Suite', expires_at: { $gt: new Date() } }) },
      webhooks: await webhooksView(ws, req),
      shopLink: { url: `${base(req)}/s/${shopSlug}`, products: await db.products.countDocuments({ workspace_id: ws._id, archived: { $ne: true }, visibility: 'everywhere' }) },
      canEdit: ['owner', 'admin'].includes(req.user.role),
    };
  }

  // INT-04 · Webhooks & API: endpoints with their last delivery, and the shop's API keys.
  async function webhooksView(ws, req) {
    const eps = endpointsOf(ws);
    const last = eps.length ? await db.webhookDeliveries.aggregate([{ $match: { workspace_id: ws._id } }, { $sort: { _id: -1 } }, { $group: { _id: '$endpoint_id', status: { $first: '$status' }, code: { $first: '$last_code' }, error: { $first: '$last_error' }, at: { $first: '$created_at' } } }]) : [];
    const keys = await db.apiKeys.find({ workspace_id: ws._id, revoked_at: null }).sort({ created_at: -1 }).lean();
    return {
      events: EVENTS,
      endpoints: eps.map((e) => ({ id: e.id, url: e.url, events: e.events, active: e.active !== false, last: last.find((l) => l._id === e.id) ?? null })),
      keys: keys.map((k) => ({ id: k._id, name: k.name, prefix: k.prefix, createdAt: k.created_at, lastUsedAt: k.last_used_at })),
      apiBase: `${base(req)}/api/v1`,
    };
  }
  const owner = (req) => { if (!['owner', 'admin'].includes(req.user.role)) throw new InboxError(403, 'Only the owner or an admin can change webhooks and API keys'); };
  const shop = (req) => db.workspaces.findById(req.user.workspace_id).lean();

  router.post('/integrations/webhooks', auth, async (req, res) => {
    owner(req);
    const ep = await addEndpoint(db, config, await shop(req), { url: req.body?.url, events: req.body?.events });
    await audit(db, req.user, `Added a webhook to ${new URL(ep.url).host}`, { where: 'Integrations' });
    res.status(201).json({ id: ep.id, url: ep.url, events: ep.events, secret: ep.secret });
  });
  router.patch('/integrations/webhooks/:id', auth, async (req, res) => {
    owner(req);
    const ws = await shop(req);
    const ep = endpointsOf(ws).find((e) => e.id === req.params.id);
    if (!ep) throw new InboxError(404, 'Webhook not found');
    const set = {};
    if (typeof req.body?.active === 'boolean') set['settings.webhooks.$.active'] = req.body.active;
    if (Array.isArray(req.body?.events)) {
      const picked = req.body.events.filter((e) => EVENTS.includes(e));
      if (!picked.length) throw new InboxError(400, 'Pick at least one event');
      set['settings.webhooks.$.events'] = picked;
    }
    await db.workspaces.updateOne({ _id: ws._id, 'settings.webhooks.id': ep.id }, { $set: set });
    res.json(await webhooksView(await shop(req), req));
  });
  router.delete('/integrations/webhooks/:id', auth, async (req, res) => {
    owner(req);
    await db.workspaces.updateOne({ _id: req.user.workspace_id }, { $pull: { 'settings.webhooks': { id: req.params.id } } });
    await db.webhookDeliveries.updateMany({ workspace_id: req.user.workspace_id, endpoint_id: req.params.id, status: 'pending' }, { $set: { status: 'failed', last_error: 'Webhook removed', next_at: null } });
    await audit(db, req.user, 'Removed a webhook', { where: 'Integrations' });
    res.json(await webhooksView(await shop(req), req));
  });
  // "Send test": a sample order.created goes to this endpoint only.
  router.post('/integrations/webhooks/:id/test', auth, async (req, res) => {
    owner(req);
    const ws = await shop(req);
    const ep = endpointsOf(ws).find((e) => e.id === req.params.id);
    if (!ep) throw new InboxError(404, 'Webhook not found');
    const sample = { test: true, number: 1001, status: 'pending', source: 'ai', customer: { name: 'Test Customer', phone: '01700000000' }, address: 'House 1, Road 1, Dhanmondi, Dhaka', zone: 'inside_dhaka', items: [{ name: 'Sample product', variant: 'M', sku: 'SAMPLE-M', qty: 1, price: 1000 }], subtotal: 1000, delivery_charge: 70, discount: 0, total: 1070, cash_to_collect: 1070 };
    const d = await db.insert(db.webhookDeliveries, { workspace_id: ws._id, endpoint_id: ep.id, event: 'order.created', event_id: `test-${Date.now()}`, payload: { id: `test-${Date.now()}`, event: 'order.created', created_at: new Date().toISOString(), data: sample }, status: 'pending', attempts: 0, next_at: new Date() });
    await webhooks?.run();
    const done = await db.webhookDeliveries.findById(d.id).lean();
    // A test that failed isn't tried again later.
    if (done.status === 'pending') await db.webhookDeliveries.updateOne({ _id: done._id }, { $set: { status: 'failed', next_at: null } });
    res.json({ ok: done.status === 'ok', code: done.last_code, error: done.last_error });
  });
  router.get('/integrations/webhooks/:id/deliveries', auth, async (req, res) => {
    owner(req);
    const list = await db.webhookDeliveries.find({ workspace_id: req.user.workspace_id, endpoint_id: req.params.id }).sort({ _id: -1 }).limit(20).lean();
    res.json(list.map((d) => ({ id: d._id, event: d.event, status: d.status, attempts: d.attempts, code: d.last_code, error: d.last_error, at: d.created_at, deliveredAt: d.delivered_at })));
  });

  router.post('/integrations/api-keys', auth, async (req, res) => {
    owner(req);
    const name = String(req.body?.name ?? '').trim().slice(0, 60);
    if (!name) throw new InboxError(400, 'Give the key a name, e.g. "Stock sheet"');
    if (await db.apiKeys.countDocuments({ workspace_id: req.user.workspace_id, revoked_at: null }) >= 10) throw new InboxError(400, 'A shop can have up to 10 API keys');
    const k = newApiKey();
    await db.insert(db.apiKeys, { workspace_id: req.user.workspace_id, name, prefix: k.prefix, hash: k.hash, created_by: req.user.id });
    await audit(db, req.user, `Created API key "${name}"`, { where: 'Integrations' });
    res.status(201).json({ name, key: k.key, prefix: k.prefix });
  });
  router.delete('/integrations/api-keys/:id', auth, async (req, res) => {
    owner(req);
    const r = await db.apiKeys.updateOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id, revoked_at: null }, { $set: { revoked_at: new Date() } });
    if (!r.matchedCount) throw new InboxError(404, 'API key not found');
    await audit(db, req.user, 'Revoked an API key', { where: 'Integrations' });
    res.json(await webhooksView(await shop(req), req));
  });

  router.get('/integrations', auth, async (req, res) => res.json(await view(req)));

  // Meta Conversions API: the shop's own pixel id and an access token from Events Manager.
  router.put('/integrations/capi', auth, ownerOrAdmin, async (req, res) => {
    const b = req.body ?? {};
    const ws = await db.workspaces.findById(req.user.workspace_id, { settings: 1 }).lean();
    const cur = ws.settings?.capi ?? {};
    const set = {};
    if (b.pixelId !== undefined) {
      const id = String(b.pixelId).trim();
      if (!/^\d{10,20}$/.test(id)) throw new InboxError(400, 'The pixel (dataset) ID is 10–20 digits — find it in Meta Events Manager');
      set['settings.capi.pixel_id'] = id;
    }
    if (b.token !== undefined && String(b.token).trim() && config.isProduction && !config.tokenKey) throw new InboxError(503, "The server is missing TOKEN_ENCRYPTION_KEY, so the access token can't be stored safely yet");
    if (b.token !== undefined && String(b.token).trim()) {
      const token = String(b.token).trim();
      if (token.length < 20) throw new InboxError(400, 'Paste the full access token from Events Manager → Settings → Conversions API');
      set['settings.capi.token'] = encryptSecret(token, config.tokenKey);
    }
    if (!cur.token && !set['settings.capi.token'] && b.pixelId !== undefined) throw new InboxError(400, 'Paste the access token too');
    if (b.events && typeof b.events === 'object') for (const k of Object.keys(CAPI_EVENTS)) if (typeof b.events[k] === 'boolean') set[`settings.capi.events.${k}`] = b.events[k];
    if (b.testCode !== undefined) set['settings.capi.test_code'] = String(b.testCode).trim().slice(0, 20);
    if (!Object.keys(set).length) throw new InboxError(400, 'Nothing to change');
    await db.workspaces.updateOne({ _id: req.user.workspace_id }, { $set: set });
    if (set['settings.capi.pixel_id']) await audit(db, req.user, 'Connected the Meta Conversions API', { where: 'Integrations' });
    res.json(await view(req));
  });

  router.delete('/integrations/capi', auth, ownerOrAdmin, async (req, res) => {
    await db.workspaces.updateOne({ _id: req.user.workspace_id }, { $unset: { 'settings.capi': '' } });
    await audit(db, req.user, 'Disconnected the Meta Conversions API', { where: 'Integrations' });
    res.json(await view(req));
  });

  // Website chat widget: turning it on makes the shop's web channel and its embed code.
  router.put('/integrations/widget', auth, ownerOrAdmin, async (req, res) => {
    const b = req.body ?? {};
    const set = {};
    if (typeof b.on === 'boolean') {
      set['settings.widget.off'] = !b.on;
      if (b.on && !(await db.channels.exists({ workspace_id: req.user.workspace_id, platform: 'web' }))) {
        await db.insert(db.channels, { workspace_id: req.user.workspace_id, platform: 'web', external_id: randomBytes(12).toString('base64url'), name: 'Website chat' });
        emit(req.user.workspace_id, 'channels', null);
      }
    }
    if (b.colour !== undefined) { if (!/^#[0-9a-f]{6}$/i.test(b.colour)) throw new InboxError(400, 'Pick a colour'); set['settings.widget.colour'] = b.colour; }
    if (b.greeting !== undefined) set['settings.widget.greeting'] = String(b.greeting).trim().slice(0, 200);
    if (b.position !== undefined) set['settings.widget.position'] = b.position === 'left' ? 'left' : 'right';
    if (!Object.keys(set).length) throw new InboxError(400, 'Nothing to change');
    await db.workspaces.updateOne({ _id: req.user.workspace_id }, { $set: set });
    if (typeof b.on === 'boolean') await audit(db, req.user, `Turned the website chat widget ${b.on ? 'on' : 'off'}`, { where: 'Integrations' });
    res.json(await view(req));
  });

  return router;
}

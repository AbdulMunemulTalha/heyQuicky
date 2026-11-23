import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { InboxError } from '../../inbox.js';
import { audit } from '../../dashboard/util.js';
import { encryptSecret } from '../../secrets.js';
import { CAPI_EVENTS, capiSettings } from '../../dashboard/capi.js';
import { widgetSettings } from '../widget.js';

// Phase 2 · Integrations (ANL-09 Meta Conversions API, INT-02 website chat widget), frame "Integrations".
export function integrationRoutes(db, config, { auth, emit }) {
  const router = Router();
  const ownerOrAdmin = (req, res, next) => (['owner', 'admin'].includes(req.user.role) ? next() : res.status(403).json({ error: 'Only the owner or an admin can change integrations' }));
  const base = (req) => (config.publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

  async function view(req) {
    const ws = await db.workspaces.findById(req.user.workspace_id, { settings: 1, name: 1 }).lean();
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
      canEdit: ['owner', 'admin'].includes(req.user.role),
    };
  }

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

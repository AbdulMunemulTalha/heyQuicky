import { Router } from 'express';
import { InboxError } from '../../inbox.js';
import { graphRequest } from '../../platforms/meta.js';
import { decryptSecret } from '../../secrets.js';
import { audit } from '../../dashboard/util.js';

// WhatsApp message templates (Settings → WhatsApp templates): the pre-approved messages WhatsApp requires for
// anything sent outside the 24-hour customer window (follow-ups, order updates, team alerts). They live on Meta,
// in the shop's WhatsApp account; this lists them with Meta's review status, creates new ones and deletes them.
// Owner and admins only.

export const CATEGORIES = ['MARKETING', 'UTILITY'];
export const LANGUAGES = ['bn', 'en', 'en_US'];
const NAME = /^[a-z0-9_]{1,512}$/;
const VARS = /\{\{(\d+)\}\}/g;

const clean = (v, max) => String(v ?? '').trim().slice(0, max);

// Checks a template the way Meta does and builds the components Meta expects.
export function buildTemplate(input) {
  const name = clean(input?.name, 512).toLowerCase().replace(/[\s-]+/g, '_');
  if (!NAME.test(name)) throw new InboxError(400, 'Use only small English letters, numbers and _ in the name (for example order_update)');
  const category = String(input?.category ?? '').toUpperCase();
  if (!CATEGORIES.includes(category)) throw new InboxError(400, 'Pick a category: Marketing or Utility');
  const language = String(input?.language ?? '');
  if (!LANGUAGES.includes(language)) throw new InboxError(400, 'Pick a language');
  const header = clean(input?.header, 60);
  const body = clean(input?.body, 1024);
  const footer = clean(input?.footer, 60);
  if (!body) throw new InboxError(400, 'Write the message');
  if (/\{\{/.test(header) || /\{\{/.test(footer)) throw new InboxError(400, 'Put {{1}}-style blanks only in the message, not the header or footer');

  // Blanks must be {{1}}, {{2}}… in order, each with a sample value for Meta's reviewers.
  const used = [...new Set([...body.matchAll(VARS)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  if (used.some((n, i) => n !== i + 1)) throw new InboxError(400, 'Number the blanks {{1}}, {{2}}, {{3}} in order');
  if (/\{\{(?!\d+\}\})/.test(body)) throw new InboxError(400, 'Write blanks as {{1}}, {{2}}…');
  if (/^\s*\{\{\d+\}\}|\{\{\d+\}\}\s*$/.test(body)) throw new InboxError(400, "The message can't start or end with a blank");
  const examples = (Array.isArray(input?.examples) ? input.examples : []).map((e) => clean(e, 200));
  if (used.length && (examples.length < used.length || examples.slice(0, used.length).some((e) => !e))) {
    throw new InboxError(400, 'Give a sample for every blank, for example a customer name');
  }
  const buttons = (Array.isArray(input?.buttons) ? input.buttons : []).map((b) => clean(b, 25)).filter(Boolean).slice(0, 3);

  const components = [];
  if (header) components.push({ type: 'HEADER', format: 'TEXT', text: header });
  components.push({ type: 'BODY', text: body, ...(used.length ? { example: { body_text: [examples.slice(0, used.length)] } } : {}) });
  if (footer) components.push({ type: 'FOOTER', text: footer });
  if (buttons.length) components.push({ type: 'BUTTONS', buttons: buttons.map((text) => ({ type: 'QUICK_REPLY', text })) });
  return { name, category, language, components };
}

// Meta's template → what the screen shows.
export function templateRow(t) {
  const part = (type) => (t.components ?? []).find((c) => c.type === type);
  return {
    id: String(t.id ?? ''), name: t.name, category: t.category, language: t.language, status: t.status,
    header: part('HEADER')?.format === 'TEXT' ? part('HEADER').text ?? '' : '', body: part('BODY')?.text ?? '',
    footer: part('FOOTER')?.text ?? '', buttons: (part('BUTTONS')?.buttons ?? []).map((b) => b.text),
    reason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : '',
  };
}

export function waTemplateRoutes(db, config, { auth, fetchImpl = globalThis.fetch }) {
  const router = Router();
  const ownerOrAdmin = (req, res, next) => (['owner', 'admin'].includes(req.user.role)
    ? next() : res.status(403).json({ error: 'Only the owner or an admin can manage WhatsApp templates', code: 'forbidden' }));
  const base = () => `https://graph.facebook.com/${config.meta.graphVersion}`;

  async function channelsOf(ws) {
    return db.channels.find({ workspace_id: ws, platform: 'whatsapp' }, { name: 1, waba_id: 1, access_token: 1, needs_reconnect: 1 }).sort({ _id: 1 }).lean();
  }
  // The WhatsApp number the request is about (the first one unless channelId says otherwise).
  async function pick(req, channelId) {
    const list = await channelsOf(req.user.workspace_id);
    const c = channelId ? list.find((x) => x._id === Number(channelId)) : list[0];
    if (!c) throw new InboxError(404, 'Connect a WhatsApp number first');
    if (!c.waba_id) throw new InboxError(400, 'Reconnect this WhatsApp number from Settings → Channels so Quicky can see its account');
    return { channel: c, list };
  }
  const meta = async (c, path, opts = {}) => {
    if (config.dryRun) throw new InboxError(400, 'Meta calls are switched off on this server (test mode)');
    try {
      return await graphRequest(`${base()}/${path}`, { ...opts, accessToken: decryptSecret(c.access_token, config.tokenKey), fetchImpl });
    } catch (err) {
      throw new InboxError(502, `WhatsApp said: ${err.message}`);
    }
  };

  router.get('/whatsapp/templates', auth, ownerOrAdmin, async (req, res) => {
    const list = await channelsOf(req.user.workspace_id);
    const channels = list.map((c) => ({ id: c._id, name: c.name, ready: Boolean(c.waba_id) && !c.needs_reconnect }));
    if (!list.length) return res.json({ channels, channelId: null, templates: [], categories: CATEGORIES, languages: LANGUAGES });
    const chosen = req.query.channelId ? list.find((x) => x._id === Number(req.query.channelId)) : list[0];
    if (!chosen) throw new InboxError(404, 'WhatsApp number not found');
    // A number connected before Quicky kept its account ID: the screen asks for a reconnect.
    if (!chosen.waba_id) return res.json({ channels, channelId: chosen._id, templates: [], categories: CATEGORIES, languages: LANGUAGES, reconnect: true });
    const { channel } = await pick(req, chosen._id);
    // Test mode never calls Meta: an empty list, so the screen still works.
    if (config.dryRun) return res.json({ channels, channelId: channel._id, templates: [], categories: CATEGORIES, languages: LANGUAGES, offline: true });
    const data = await meta(channel, `${channel.waba_id}/message_templates?fields=id,name,category,language,status,components,rejected_reason&limit=100`);
    res.json({ channels, channelId: channel._id, templates: (data.data ?? []).map(templateRow), categories: CATEGORIES, languages: LANGUAGES });
  });

  router.post('/whatsapp/templates', auth, ownerOrAdmin, async (req, res) => {
    const tpl = buildTemplate(req.body);
    const { channel } = await pick(req, req.body?.channelId);
    const out = await meta(channel, `${channel.waba_id}/message_templates`, { method: 'POST', body: tpl });
    await audit(db, req.user, 'Sent a WhatsApp template for review', { target: tpl.name, where: 'Settings · WhatsApp templates' });
    res.status(201).json({ id: String(out.id ?? ''), status: out.status ?? 'PENDING', category: out.category ?? tpl.category, name: tpl.name });
  });

  router.delete('/whatsapp/templates/:name', auth, ownerOrAdmin, async (req, res) => {
    const name = String(req.params.name);
    if (!NAME.test(name)) throw new InboxError(400, 'Unknown template');
    const { channel } = await pick(req, req.query.channelId);
    await meta(channel, `${channel.waba_id}/message_templates?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    await audit(db, req.user, 'Deleted a WhatsApp template', { target: name, where: 'Settings · WhatsApp templates' });
    res.json({ ok: true });
  });

  return router;
}

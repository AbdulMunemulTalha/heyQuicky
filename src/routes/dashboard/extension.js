import { Router } from 'express';
import { InboxError } from '../../inbox.js';
import { need } from '../../dashboard/permissions.js';
import { audit } from '../../dashboard/util.js';
import { sendSizeChart } from '../../dashboard/postbacks.js';
import { EXT_DEVICE, findChat, newConnectCode, pageStatuses } from '../../dashboard/extension.js';
import { createHash } from 'node:crypto';
import { autoSummary } from './inbox.js';
import { chatStatus } from '../../dashboard/extension.js';

const sid = (token) => createHash('sha256').update(String(token)).digest('hex').slice(0, 16);

// HND-05: the dashboard side of the Business Suite extension. The extension signs in with its own session,
// so it also uses the normal inbox routes (chat, take over, back to AI, draft, ask).
export function extensionRoutes(db, config, { auth, agent, inbox }) {
  const router = Router();
  const reply = need(db, 'reply');

  // Integrations → Chrome extension: download, a connect code, and the browsers connected.
  router.get('/extension', auth, async (req, res) => {
    const sessions = await db.sessions.find({ user_id: req.user.id, device: EXT_DEVICE, expires_at: { $gt: new Date() } }).sort({ last_seen: -1 }).lean();
    res.json({ download: '/extension/heyquicky-extension.zip', server: config.publicUrl || '', connected: sessions.map((s) => ({ id: sid(s._id), lastSeen: s.last_seen ?? s.created_at, since: s.created_at })) });
  });

  router.post('/extension/code', auth, async (req, res) => {
    const r = await newConnectCode(db, req.user);
    await audit(db, req.user, 'Made a Chrome extension connect code', { where: 'Integrations' });
    res.json(r);
  });

  // ---- Called by the extension ----
  router.get('/ext/me', auth, async (req, res) => {
    const ws = await db.workspaces.findById(req.user.workspace_id, { name: 1, ai_mode: 1 }).lean();
    res.json({ name: req.user.name, shop: ws?.name ?? '', role: req.user.role, aiMode: ws?.ai_mode ?? 'suggest', app: (config.publicUrl || '').replace(/\/+$/, '') });
  });

  router.get('/ext/find', auth, async (req, res) => {
    res.json(await findChat(db, req.user, { page: req.query.page, thread: req.query.thread, name: String(req.query.name ?? '').slice(0, 80), q: String(req.query.q ?? '').slice(0, 80) }));
  });

  router.get('/ext/statuses', auth, async (req, res) => {
    const ws = await db.workspaces.findById(req.user.workspace_id, { ai_mode: 1 }).lean();
    res.json({ chats: await pageStatuses(db, req.user, ws, { page: req.query.page }) });
  });

  const load = async (req) => {
    const conv = await db.conversations.findOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id }).lean();
    if (!conv) throw new InboxError(404, 'Conversation not found');
    return conv;
  };

  // Everything the panel shows for one chat.
  router.get('/ext/chat/:id', auth, async (req, res) => {
    const conv = await load(req);
    const [contact, customer, ws, takenBy] = await Promise.all([
      db.contacts.findById(conv.contact_id, { name: 1 }).lean(),
      conv.customer_id ? db.customers.findById(conv.customer_id).lean() : null,
      db.workspaces.findById(conv.workspace_id, { ai_mode: 1 }).lean(),
      conv.taken_over_by ? db.users.findById(conv.taken_over_by, { name: 1 }).lean() : null,
    ]);
    const orders = customer ? await db.orders.find({ workspace_id: conv.workspace_id, customer_id: customer._id, draft: { $ne: true } }).sort({ created_at: -1 }).limit(5).lean() : [];
    const orderToday = orders.some((o) => o.taken_by === 'ai' && o.conversation_id === conv._id && o.created_at > new Date(Date.now() - 86_400_000));
    const lastIn = await db.messages.findOne({ conversation_id: conv._id, direction: 'in' }).sort({ _id: -1 }).lean();
    const words = String(lastIn?.text ?? '').toLowerCase();
    const saved = (await db.savedReplies.find({ workspace_id: conv.workspace_id }).lean())
      .find((r) => [r.shortcut, ...(r.phrases ?? [])].some((p) => p && words.includes(String(p).replace('/', '').toLowerCase())));
    const cc = customer?.courier_check;
    res.json({
      id: conv._id, name: contact?.name || customer?.name || 'Customer',
      status: chatStatus(conv, { userId: req.user.id, aiMode: ws?.ai_mode, orderToday }), takenBy: takenBy?.name ?? '', reason: conv.ai_handoff_reason || '',
      summary: conv.summary || (customer ? autoSummary(customer, orders) : ''),
      suggestion: conv.ai_draft?.text || saved?.text || '', suggestionFrom: conv.ai_draft?.text ? 'ai' : saved ? 'saved' : '',
      lastMessage: lastIn?.text ?? '',
      courier: cc && cc.rate != null ? (() => { const rate = Math.round(cc.rate <= 1 ? cc.rate * 100 : cc.rate); return { rate, safe: rate >= 70 }; })() : null,
      orders: customer?.stats?.orders ?? orders.length,
      aiReady: Boolean(agent?.status().available),
      open: `${(config.publicUrl || '').replace(/\/+$/, '')}/app/inbox/${conv._id}`,
    });
  });

  // "Shorter": the same reply in fewer words, keeping every number and promise.
  router.post('/ext/chat/:id/shorter', auth, reply, async (req, res) => {
    await load(req);
    const text = String(req.body?.text ?? '').trim().slice(0, 1000);
    if (!text) throw new InboxError(400, 'There is no reply to shorten');
    if (!agent?.status().available) throw new InboxError(503, 'The AI is not set up on this server yet');
    res.json({ text: await agent.shorten(req.user, text) });
  });

  // "Send size chart": for the product the customer asked about (the last one shown in the chat), else pick one.
  router.post('/ext/chat/:id/size-chart', auth, reply, async (req, res) => {
    const conv = await load(req);
    let productId = Number(req.body?.productId) || null;
    if (!productId) {
      const recent = await db.messages.find({ conversation_id: conv._id, kind: { $in: ['products', 'product', 'rich'] } }).sort({ _id: -1 }).limit(10).lean();
      const ids = recent.flatMap((m) => (m.payload?.cards ?? m.payload?.products ?? []).map((c) => Number(c.product_id ?? c.id))).filter(Boolean);
      const withChart = ids.length ? await db.products.findOne({ _id: { $in: ids }, workspace_id: conv.workspace_id, size_chart_id: { $ne: null } }, { _id: 1 }).lean() : null;
      productId = withChart?._id ?? null;
    }
    if (!productId) {
      const choices = await db.products.find({ workspace_id: conv.workspace_id, size_chart_id: { $ne: null }, archived: { $ne: true } }, { name: 1 }).sort({ name: 1 }).limit(30).lean();
      if (!choices.length) throw new InboxError(409, 'No product has a size chart yet — add one in Catalog → Size charts');
      return res.status(409).json({ error: 'Which product?', choices: choices.map((p) => ({ id: p._id, name: p.name })) });
    }
    const sent = await sendSizeChart(db, inbox, conv._id, conv.workspace_id, productId, { publicUrl: config.publicUrl || '' });
    if (!sent) throw new InboxError(409, "That product doesn't have a size chart");
    res.json({ ok: true });
  });

  return router;
}

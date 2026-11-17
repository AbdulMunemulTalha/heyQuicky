import { Router } from 'express';
import { InboxError } from '../../inbox.js';
import { can, need } from '../../dashboard/permissions.js';
import { audit, clampInt, dhakaDayStart } from '../../dashboard/util.js';
import { WINDOW_MS, runFollowups } from '../../dashboard/followups.js';

const AUDIENCES = ['hot', 'warm', 'last_24h', 'customers_24h'];
const FORMATS = ['text', 'buttons', 'product', 'carousel', 'photo'];
const RANK = { hot: 0, warm: 1 };
const rank = (f) => (f.status === 'watching' ? RANK[f.temp] ?? 2 : { sent: 2, replied: 3, ordered: 3, skipped: 4 }[f.status] ?? 5);
const OUTCOMES = { ordered: 'won', call_later: 'call_scheduled', no_answer: 'contacted', not_interested: 'lost' };

// Screen 05: follow-ups, leads and broadcasts (FUP-01/03/06).
export function growthRoutes(db, _config, { auth, inbox, emit }) {
  const router = Router();

  router.get('/growth/followups', auth, async (req, res) => {
    const ws = await db.workspaces.findById(req.user.workspace_id).lean();
    const today = dhakaDayStart(new Date());
    const list = await db.followups.find({ workspace_id: ws._id }).sort({ created_at: -1 }).limit(60).lean();
    const convs = new Map((await db.conversations.find({ _id: { $in: list.map((f) => f.conversation_id) } }, { contact_id: 1, last_message_preview: 1, assigned_user_id: 1 }).lean()).map((c) => [c._id, c]));
    const contacts = new Map((await db.contacts.find({ _id: { $in: [...convs.values()].map((c) => c.contact_id) } }, { name: 1 }).lean()).map((c) => [c._id, c.name]));
    const lastIn = new Map();
    for (const f of list) {
      const m = await db.messages.findOne({ conversation_id: f.conversation_id, direction: 'in' }).sort({ _id: -1 }).lean();
      lastIn.set(f.conversation_id, m?.text ?? '');
    }
    const sentToday = await db.followups.countDocuments({ workspace_id: ws._id, sent_at: { $gte: today } });
    const sentAll = await db.followups.find({ workspace_id: ws._id, status: { $in: ['sent', 'replied', 'ordered'] }, sent_at: { $ne: null } }, { status: 1, conversation_id: 1 }).lean();
    const replied = sentAll.filter((f) => f.status === 'replied' || f.status === 'ordered').length;
    const orderedIds = sentAll.filter((f) => f.status === 'ordered').map((f) => f.conversation_id);
    const orderedOrders = await db.orders.find({ conversation_id: { $in: orderedIds } }, { subtotal: 1, delivery_charge: 1, discount: 1 }).lean();
    res.json({
      settings: { enabled: ws.settings?.followup?.enabled !== false, offer: Boolean(ws.settings?.followup?.offer) },
      kpis: {
        watching: await db.followups.countDocuments({ workspace_id: ws._id, status: { $in: ['watching', 'sent'] } }),
        sentToday, replied, repliedPct: sentAll.length ? Math.round((replied / sentAll.length) * 100) : 0,
        ordered: orderedOrders.length, orderedValue: orderedOrders.reduce((s, o) => s + o.subtotal + o.delivery_charge - (o.discount ?? 0), 0),
      },
      // Hot first, then warm, sent, finished and skipped — the order the team works in.
      items: list.sort((x, y) => rank(x) - rank(y)).map((f) => ({
        id: f._id, conversationId: f.conversation_id, name: contacts.get(convs.get(f.conversation_id)?.contact_id) ?? 'Customer',
        lastMessage: lastIn.get(f.conversation_id) ?? '', temp: f.temp, status: f.status, step: f.step, dueAt: f.due_at, sentAt: f.sent_at, withOffer: f.with_offer, skipReason: f.skip_reason,
      })),
    });
  });

  router.patch('/growth/followups/settings', auth, need(db, 'teach_ai'), async (req, res) => {
    const set = {};
    if (typeof req.body?.enabled === 'boolean') set['settings.followup.enabled'] = req.body.enabled;
    if (typeof req.body?.offer === 'boolean') set['settings.followup.offer'] = req.body.offer;
    await db.workspaces.updateOne({ _id: req.user.workspace_id }, { $set: set });
    await audit(db, req.user, `Changed follow-up settings (${Object.entries(req.body ?? {}).map(([k, v]) => `${k}: ${v}`).join(', ')})`, { where: 'Follow-ups' });
    res.json({ ok: true });
  });

  // Runs the follow-up check now (the server also does it every 5 minutes).
  router.post('/growth/followups/run', auth, need(db, 'teach_ai'), async (req, res) => {
    res.json(await runFollowups(db, inbox));
  });

  router.post('/growth/followups/:id/skip', auth, need(db, 'reply'), async (req, res) => {
    const r = await db.followups.updateOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id }, { $set: { status: 'skipped', skip_reason: `Skipped by ${req.user.name}` } });
    if (!r.matchedCount) throw new InboxError(404, 'Follow-up not found');
    res.json({ ok: true });
  });

  // Leads: people who showed interest (FUP-03).
  router.get('/growth/leads', auth, async (req, res) => {
    const ws = await db.workspaces.findById(req.user.workspace_id).lean();
    const showPhones = can(req.user, 'see_phones', ws);
    const tab = req.query.tab === 'contacted' ? 'contacted' : 'to_chase';
    const where = { workspace_id: ws._id, stage: tab === 'contacted' ? { $in: ['contacted', 'call_scheduled'] } : 'new' };
    const [items, toChase, contacted] = await Promise.all([
      db.prospects.find(where).sort({ temp: 1, last_seen_at: -1 }).limit(clampInt(req.query.limit, 1, 200, 100)).lean(),
      db.prospects.countDocuments({ workspace_id: ws._id, stage: 'new' }),
      db.prospects.countDocuments({ workspace_id: ws._id, stage: { $in: ['contacted', 'call_scheduled'] } }),
    ]);
    const owners = new Map((await db.users.find({ _id: { $in: items.map((p) => p.owner_user_id).filter(Boolean) } }, { name: 1 }).lean()).map((u) => [u._id, u.name]));
    res.json({
      counts: { to_chase: toChase, contacted },
      items: items.map((p) => ({
        id: p._id, name: p.name || 'Customer', phone: p.phone ? (showPhones ? p.phone : `${p.phone.slice(0, 3)}••••${p.phone.slice(-3)}`) : '', canCall: Boolean(p.phone && showPhones),
        product: p.product, amount: p.amount, temp: p.temp, stage: p.stage, timesAsked: p.times_asked, followUpAt: p.callback_at ?? p.follow_up_at,
        lastSeenAt: p.last_seen_at, conversationId: p.conversation_id, outcome: p.outcome, owner: owners.get(p.owner_user_id) ?? '',
      })),
    });
  });

  // "Log call": one tap for what happened (FUP-04 adds the full callback popup in Phase 2).
  router.post('/growth/leads/:id/log', auth, need(db, 'reply'), async (req, res) => {
    const outcome = String(req.body?.outcome ?? '');
    if (!(outcome in OUTCOMES)) throw new InboxError(400, 'Pick what happened on the call');
    const set = { stage: OUTCOMES[outcome], outcome, owner_user_id: req.user.id };
    if (outcome === 'call_later') {
      const at = new Date(req.body?.at ?? Date.now() + 86_400_000);
      if (Number.isNaN(at.getTime())) throw new InboxError(400, 'Pick a time for the call');
      set.callback_at = at;
    }
    if (outcome === 'not_interested') set.lost_reason = String(req.body?.reason ?? 'Not interested').slice(0, 100);
    const r = await db.prospects.updateOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id }, { $set: set });
    if (!r.matchedCount) throw new InboxError(404, 'Lead not found');
    res.json({ ok: true, stage: set.stage });
  });

  // Broadcasts (FUP-06). Messenger and Instagram only allow promotional messages inside 24 hours of the
  // customer's last message, so the audience is limited to them; WhatsApp needs approved templates.
  async function audience(ws, aud) {
    const since = new Date(Date.now() - WINDOW_MS);
    const channels = await db.channels.find({ workspace_id: ws, platform: { $in: ['messenger', 'instagram'] } }, { _id: 1 }).lean();
    const base = { workspace_id: ws, spam: { $ne: true }, last_inbound_at: { $gte: since }, channel_id: { $in: channels.map((c) => c._id) } };
    let convs = await db.conversations.find(base, { _id: 1, customer_id: 1 }).lean();
    if (aud === 'hot' || aud === 'warm') {
      const temps = new Set((await db.followups.find({ workspace_id: ws, temp: aud, status: { $in: ['watching', 'sent'] } }, { conversation_id: 1 }).lean()).map((f) => f.conversation_id));
      convs = convs.filter((c) => temps.has(c._id));
    }
    if (aud === 'customers_24h') {
      const buyers = new Set((await db.customers.find({ workspace_id: ws, 'stats.orders': { $gte: 1 } }, { _id: 1 }).lean()).map((c) => c._id));
      convs = convs.filter((c) => buyers.has(c.customer_id));
    }
    const blockedOrOff = new Set((await db.customers.find({ workspace_id: ws, $or: [{ blocked: true }, { ai_off: true }] }, { _id: 1 }).lean()).map((c) => c._id));
    const ok = convs.filter((c) => !blockedOrOff.has(c.customer_id));
    const outside = await db.conversations.countDocuments({ workspace_id: ws, spam: { $ne: true }, last_inbound_at: { $lt: since, $gte: new Date(Date.now() - 30 * 86_400_000) } });
    return { ids: ok.map((c) => c._id), outside };
  }

  router.post('/growth/broadcasts/preview', auth, async (req, res) => {
    const aud = AUDIENCES.includes(req.body?.audience) ? req.body.audience : 'last_24h';
    const { ids, outside } = await audience(req.user.workspace_id, aud);
    res.json({ recipients: ids.length, outsideWindow: outside });
  });

  function render(format, content, products) {
    const text = String(content?.text ?? '').trim();
    if (format === 'buttons') return `${text}\n\n${(content.buttons ?? []).filter(Boolean).map((b) => `▸ ${b}`).join('\n')}`;
    if (format === 'product' || format === 'carousel') {
      return `${text}\n\n${products.map((p) => `• ${p.name} — ৳${p.price.toLocaleString('en-IN')}${p.compare_at ? ` (আগে ৳${p.compare_at.toLocaleString('en-IN')})` : ''}`).join('\n')}`;
    }
    if (format === 'photo') return `${text}${content.image ? `\n${content.image}` : ''}`;
    return text;
  }

  router.get('/growth/broadcasts', auth, async (req, res) => {
    const list = await db.broadcasts.find({ workspace_id: req.user.workspace_id }).sort({ created_at: -1 }).limit(30).lean();
    const sinceOf = (b) => b.sent_at ?? b.scheduled_at ?? b.created_at;
    const out = [];
    for (const b of list) {
      // Replies and orders that came after the broadcast, from the people it reached.
      const ids = b.recipients ?? [];
      const replied = ids.length ? (await db.conversations.countDocuments({ _id: { $in: ids }, last_inbound_at: { $gt: sinceOf(b) } })) : 0;
      const ordered = ids.length ? (await db.orders.countDocuments({ conversation_id: { $in: ids }, created_at: { $gt: sinceOf(b) } })) : 0;
      out.push({ id: b._id, audience: b.audience?.key, format: b.format, text: b.content?.text ?? '', status: b.status, scheduledAt: b.scheduled_at, sentAt: b.sent_at,
        stats: { recipients: b.stats?.recipients ?? 0, sent: b.stats?.sent ?? 0, replied, ordered } });
    }
    res.json(out);
  });

  router.post('/growth/broadcasts', auth, need(db, 'reply'), async (req, res) => {
    const ws = req.user.workspace_id;
    const aud = AUDIENCES.includes(req.body?.audience) ? req.body.audience : null;
    const format = FORMATS.includes(req.body?.format) ? req.body.format : null;
    if (!aud) throw new InboxError(400, 'Pick who gets it');
    if (!format) throw new InboxError(400, 'Pick a format');
    const text = String(req.body?.content?.text ?? '').trim();
    if (!text) throw new InboxError(400, 'Write the message');
    if (text.length > 1000) throw new InboxError(400, 'Keep the message under 1,000 characters');
    const productIds = (req.body?.content?.productIds ?? []).map(Number).filter(Number.isSafeInteger).slice(0, format === 'carousel' ? 10 : 1);
    if ((format === 'product' || format === 'carousel') && !productIds.length) throw new InboxError(400, 'Pick the products to show');
    const products = await db.products.find({ _id: { $in: productIds }, workspace_id: ws, archived: { $ne: true }, visibility: { $ne: 'hidden' } }).lean();
    const scheduledAt = req.body?.scheduledAt ? new Date(req.body.scheduledAt) : null;
    if (scheduledAt && (Number.isNaN(scheduledAt.getTime()) || scheduledAt < new Date())) throw new InboxError(400, 'Pick a time in the future');
    const content = { text, buttons: (req.body?.content?.buttons ?? []).map((b) => String(b).slice(0, 20)).slice(0, 3), productIds, image: String(req.body?.content?.image ?? '').slice(0, 500) };
    const b = await db.insert(db.broadcasts, { workspace_id: ws, audience: { key: aud }, format, content, scheduled_at: scheduledAt, status: scheduledAt ? 'scheduled' : 'sending', created_by: req.user.id });
    await audit(db, req.user, `${scheduledAt ? 'Scheduled' : 'Sent'} a broadcast to ${aud.replace(/_/g, ' ')}`, { where: 'Broadcasts' });
    if (!scheduledAt) {
      const result = await sendBroadcast(db, inbox, b.id, render(format, content, products));
      return res.status(201).json({ id: b.id, ...result });
    }
    res.status(201).json({ id: b.id, scheduled: true });
  });

  async function sendBroadcast(dbx, inboxx, id, body) {
    const b = await dbx.broadcasts.findById(id).lean();
    const { ids } = await audience(b.workspace_id, b.audience.key);
    let sent = 0;
    for (const convId of ids) {
      const m = await inboxx.sendAiReply(convId, body).catch(() => null);
      if (m) {
        sent += 1;
        await dbx.messages.updateOne({ _id: m.id }, { $set: { kind: 'broadcast', payload: { broadcastId: id } } });
      }
    }
    await dbx.broadcasts.updateOne({ _id: id }, { $set: { status: 'sent', sent_at: new Date(), recipients: ids, stats: { recipients: ids.length, sent } } });
    emit(b.workspace_id, 'broadcast', { id, sent });
    return { recipients: ids.length, sent };
  }

  // Scheduled broadcasts go out when their time comes (checked every minute by the server).
  router.sendDue = async () => {
    const due = await db.broadcasts.find({ status: 'scheduled', scheduled_at: { $lte: new Date() } }).lean();
    for (const b of due) {
      await db.broadcasts.updateOne({ _id: b._id }, { $set: { status: 'sending' } });
      const products = await db.products.find({ _id: { $in: b.content?.productIds ?? [] } }).lean();
      await sendBroadcast(db, inbox, b._id, render(b.format, b.content, products));
    }
  };
  const timer = setInterval(() => router.sendDue().catch((err) => console.warn('broadcasts failed:', err.message)), 60_000);
  timer.unref();

  return router;
}

import { Router } from 'express';
import { InboxError } from '../../inbox.js';
import { can, need } from '../../dashboard/permissions.js';
import { audit, clampInt, csv, escapeRegex, bdPhone } from '../../dashboard/util.js';
import { riskFor } from '../../dashboard/risk.js';
import { stage, orderTotal } from '../../dashboard/orderOps.js';

const FILTERS = ['all', 'repeat', 'vip', 'high_risk'];

// Screen 04: everyone who messaged, commented or ordered, with their record across channels (CRM-01/02).
export function customerRoutes(db, _config, { auth, adapters }) {
  const router = Router();

  const mask = (p) => `${p.slice(0, 3)}••••${p.slice(-3)}`;
  const deliveredRate = (s) => {
    const done = (s?.delivered ?? 0) + (s?.returned ?? 0);
    return done ? Math.round(((s?.delivered ?? 0) / done) * 100) : null;
  };
  const riskOf = (c) => riskFor({ delivered: c.stats?.delivered, returned: c.stats?.returned, cancelled: c.stats?.cancelled,
    courierRate: c.courier_check?.rate ?? null, courierTotal: c.courier_check?.total ?? 0 });

  function filterFor(req) {
    const where = { workspace_id: req.user.workspace_id, blocked: { $ne: true } };
    const f = FILTERS.includes(req.query.filter) ? req.query.filter : 'all';
    if (f === 'repeat') where['stats.orders'] = { $gte: 2 };
    if (f === 'vip') where.$or = [{ vip: true }, { tags: 'VIP' }];
    if (f === 'high_risk') where.$expr = { $gte: [{ $add: ['$stats.returned', '$stats.cancelled'] }, 2] };
    if (req.query.q) {
      const q = String(req.query.q).trim().slice(0, 60);
      const digits = q.replace(/[০-৯]/g, (d) => '০১২৩৪৫৬৭৮৯'.indexOf(d)).replace(/\D/g, '');
      const or = [{ name: new RegExp(escapeRegex(q), 'i') }, { tags: new RegExp(`^${escapeRegex(q)}`, 'i') }];
      if (digits.length >= 3) or.push({ phones: new RegExp(escapeRegex(digits)) });
      where.$and = [{ $or: or }];
    }
    return { where, f };
  }

  router.get('/customers', auth, async (req, res) => {
    const ws = await db.workspaces.findById(req.user.workspace_id).lean();
    const showPhones = can(req.user, 'see_phones', ws);
    const { where } = filterFor(req);
    const page = clampInt(req.query.page, 1, 1000, 1);
    const perPage = clampInt(req.query.perPage, 10, 100, 30);
    const [items, total, everyone] = await Promise.all([
      db.customers.find(where).sort({ last_active_at: -1, _id: -1 }).skip((page - 1) * perPage).limit(perPage).lean(),
      db.customers.countDocuments(where),
      db.customers.countDocuments({ workspace_id: ws._id, blocked: { $ne: true } }),
    ]);
    res.json({
      everyone, total, page, perPage,
      items: items.map((c) => ({
        id: c._id, name: c.name || 'Customer', phone: c.phones[0] ? (showPhones ? c.phones[0] : mask(c.phones[0])) : '',
        orders: c.stats?.orders ?? 0, spent: c.stats?.spent ?? 0, delivered: deliveredRate(c.stats), lastActive: c.last_active_at,
        tags: [...new Set([...(c.vip ? ['VIP'] : []), ...(c.tags ?? [])])], risk: riskOf(c).level,
      })),
    });
  });

  router.get('/customers.csv', auth, async (req, res) => {
    const ws = await db.workspaces.findById(req.user.workspace_id).lean();
    const showPhones = can(req.user, 'see_phones', ws);
    const { where } = filterFor(req);
    const list = await db.customers.find(where).sort({ last_active_at: -1 }).limit(50_000).lean();
    const rows = list.map((c) => [c.name, showPhones ? c.phones.join(' ') : '', c.stats?.orders ?? 0, c.stats?.spent ?? 0, c.stats?.delivered ?? 0, c.stats?.returned ?? 0,
      c.stats?.cancelled ?? 0, (c.tags ?? []).join(' '), c.last_active_at]);
    res.type('text/csv').set('Content-Disposition', 'attachment; filename="heyquicky-customers.csv"')
      .send(`﻿${csv([['name', 'phones', 'orders', 'spent', 'delivered', 'returned', 'cancelled', 'tags', 'last_active'], ...rows])}`);
  });

  async function load(req) {
    const c = await db.customers.findOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id }).lean();
    if (!c) throw new InboxError(404, 'Customer not found');
    return c;
  }

  router.get('/customers/:id', auth, async (req, res) => {
    let c = await load(req);
    const ws = await db.workspaces.findById(req.user.workspace_id).lean();
    const showPhones = can(req.user, 'see_phones', ws);
    // Courier record across shops, refreshed once a day (CRM-02).
    if (c.phones[0] && (!c.courier_check?.checked_at || Date.now() - new Date(c.courier_check.checked_at) > 86_400_000)) {
      try {
        const check = { ...(await adapters.fraud.check(c.phones[0])), checked_at: new Date() };
        await db.customers.updateOne({ _id: c._id }, { $set: { courier_check: check } });
        c = { ...c, courier_check: check };
      } catch { /* keep the old record */ }
    }
    const contacts = await db.contacts.find({ _id: { $in: c.contact_ids } }, { channel_id: 1, external_id: 1 }).lean();
    const channels = new Map((await db.channels.find({ workspace_id: ws._id }, { platform: 1 }).lean()).map((ch) => [ch._id, ch.platform]));
    const conversations = await db.conversations.find({ customer_id: c._id }, { channel_id: 1, last_message_at: 1 }).lean();
    const convPlatform = new Map(conversations.map((cv) => [cv._id, channels.get(cv.channel_id)]));
    const [messages, orders, comments, notes] = await Promise.all([
      db.messages.find({ conversation_id: { $in: conversations.map((cv) => cv._id) }, direction: 'in' }).sort({ _id: -1 }).limit(15).lean(),
      db.orders.find({ customer_id: c._id, draft: { $ne: true } }).sort({ created_at: -1 }).limit(15).lean(),
      db.comments.find({ workspace_id: ws._id, author_external_id: { $in: contacts.map((ct) => ct.external_id) } }).sort({ created_at: -1 }).limit(10).lean(),
      db.notes.find({ customer_id: c._id }).sort({ created_at: -1 }).limit(10).lean(),
    ]);
    const posts = new Map((await db.posts.find({ _id: { $in: comments.map((x) => x.post_id) } }, { caption: 1 }).lean()).map((p) => [p._id, p.caption]));
    const authors = new Map((await db.users.find({ _id: { $in: notes.map((n) => n.author_user_id) } }, { name: 1 }).lean()).map((u) => [u._id, u.name]));
    // One merged timeline across Messenger, Instagram, WhatsApp, comments and orders.
    const timeline = [
      ...messages.map((m) => ({ kind: 'message', platform: convPlatform.get(m.conversation_id), text: m.text || '[attachment]', at: m.created_at, link: `/inbox/${m.conversation_id}` })),
      ...orders.map((o) => ({ kind: 'order', number: o.number ?? o._id, status: stage(o.status), total: orderTotal(o), source: o.source, at: o.created_at, link: `/orders/${o.number ?? o._id}` })),
      ...comments.map((x) => ({ kind: 'comment', text: x.text, post: posts.get(x.post_id) ?? '', at: x.created_at, link: `/comments/${x.post_id}` })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 20);
    const risk = riskOf(c);
    res.json({
      id: c._id, name: c.name || 'Customer', phones: showPhones ? c.phones : c.phones.map(mask), rawPhone: showPhones ? c.phones[0] ?? null : null,
      area: c.area || '', address: c.address || '', tags: c.tags ?? [], vip: Boolean(c.vip), aiOff: Boolean(c.ai_off), blocked: Boolean(c.blocked),
      stats: { orders: c.stats?.orders ?? 0, delivered: c.stats?.delivered ?? 0, returned: c.stats?.returned ?? 0, cancelled: c.stats?.cancelled ?? 0, spent: c.stats?.spent ?? 0 },
      deliveredRate: deliveredRate(c.stats),
      check: c.courier_check && { delivered: c.courier_check.delivered, total: c.courier_check.total, rate: c.courier_check.rate, sample: c.courier_check.source === 'sample' },
      risk, channels: [...new Set(conversations.map((cv) => channels.get(cv.channel_id)).filter(Boolean))],
      conversationId: conversations.sort((a, b) => new Date(b.last_message_at ?? 0) - new Date(a.last_message_at ?? 0))[0]?._id ?? null,
      timeline, notes: notes.map((n) => ({ id: n._id, text: n.text, by: authors.get(n.author_user_id) ?? '', at: n.created_at })),
      firstSeen: c.created_at, lastActive: c.last_active_at,
    });
  });

  router.patch('/customers/:id', auth, need(db, 'reply'), async (req, res) => {
    const c = await load(req);
    const set = {};
    if (typeof req.body?.name === 'string') {
      const name = req.body.name.trim();
      if (!name || name.length > 80) throw new InboxError(400, 'Name is required');
      set.name = name;
    }
    if (typeof req.body?.vip === 'boolean') set.vip = req.body.vip;
    if (typeof req.body?.aiOff === 'boolean') Object.assign(set, { ai_off: req.body.aiOff, ai_off_reason: req.body.aiOff ? String(req.body.reason ?? '').slice(0, 200) : '' });
    if (req.body?.addPhone !== undefined) {
      const phone = bdPhone(req.body.addPhone);
      if (!phone) throw new InboxError(400, 'Enter an 11-digit Bangladeshi mobile number');
      await db.customers.updateOne({ _id: c._id }, { $addToSet: { phones: phone } });
    }
    if (Object.keys(set).length) await db.customers.updateOne({ _id: c._id }, { $set: set });
    await audit(db, req.user, `Updated customer ${set.name ?? c.name}`, { where: 'Customers' });
    res.json({ ok: true });
  });

  router.post('/customers/:id/tags', auth, need(db, 'reply'), async (req, res) => {
    const c = await load(req);
    const tag = String(req.body?.tag ?? '').trim().slice(0, 30);
    if (!tag) throw new InboxError(400, 'Write a tag');
    await db.customers.updateOne({ _id: c._id }, req.body?.remove ? { $pull: { tags: tag } } : { $addToSet: { tags: tag } });
    res.json({ tags: (await db.customers.findById(c._id, { tags: 1 }).lean()).tags });
  });

  router.post('/customers/:id/notes', auth, need(db, 'reply'), async (req, res) => {
    const c = await load(req);
    const text = String(req.body?.text ?? '').trim().slice(0, 1000);
    if (!text) throw new InboxError(400, 'Write a note');
    const n = await db.insert(db.notes, { workspace_id: c.workspace_id, customer_id: c._id, author_user_id: req.user.id, text });
    res.status(201).json({ id: n.id, text, by: req.user.name, at: n.created_at });
  });

  return router;
}

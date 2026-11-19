import { Router } from 'express';
import { InboxError } from '../../inbox.js';
import { need, allowedActions } from '../../dashboard/permissions.js';
import { audit } from '../../dashboard/util.js';
import { TICKET_TYPES, TICKET_STATUSES, RESOLUTIONS, openTicket, dueAt, timelineEntry } from '../../dashboard/tickets.js';

const clean = (v, max) => String(v ?? '').trim().slice(0, max);

// Phase 2 · Support tickets (TKT-01/02): list (ACT NOW first), detail with owner, status,
// resolution and timeline, notes, reply in chat, and new tickets from a chat or by hand.
export function ticketRoutes(db, _config, { auth, inbox, emit, notify }) {
  const router = Router();
  const reply = need(db, 'reply');

  // Agents (no "see all chats") see tickets they own or whose chat is theirs.
  async function scope(req) {
    const ws = await db.workspaces.findById(req.user.workspace_id, { settings: 1 }).lean();
    if (req.user.role === 'owner' || allowedActions(req.user, ws).includes('see_all_chats')) return {};
    const convs = await db.conversations.find({ workspace_id: req.user.workspace_id, assigned_user_id: req.user.id }, { _id: 1 }).lean();
    return { $or: [{ owner_user_id: req.user.id }, { conversation_id: { $in: convs.map((c) => c._id) } }] };
  }

  async function names(tickets) {
    const ids = (k) => [...new Set(tickets.map((t) => t[k]).filter(Boolean))];
    const [users, customers, orders, convs] = await Promise.all([
      db.users.find({ _id: { $in: ids('owner_user_id') } }, { name: 1 }).lean(),
      db.customers.find({ _id: { $in: ids('customer_id') } }, { name: 1, phones: 1, vip: 1 }).lean(),
      db.orders.find({ _id: { $in: ids('order_id') } }, { number: 1 }).lean(),
      db.conversations.find({ _id: { $in: ids('conversation_id') } }, { contact_id: 1, channel_id: 1 }).lean(),
    ]);
    const contacts = new Map((await db.contacts.find({ _id: { $in: convs.map((c) => c.contact_id) } }, { name: 1 }).lean()).map((c) => [c._id, c.name]));
    const channels = new Map((await db.channels.find({ _id: { $in: convs.map((c) => c.channel_id) } }, { platform: 1 }).lean()).map((c) => [c._id, c.platform]));
    const m = (list) => new Map(list.map((x) => [x._id, x]));
    return { users: m(users), customers: m(customers), orders: m(orders), convs: new Map(convs.map((c) => [c._id, { name: contacts.get(c.contact_id), platform: channels.get(c.channel_id) }])) };
  }

  function row(t, n, now = new Date()) {
    const due = dueAt(t);
    const conv = n.convs.get(t.conversation_id);
    const customer = n.customers.get(t.customer_id);
    return {
      id: t._id, number: t.number, title: t.title, type: t.type, actNow: t.act_now, status: t.status, reason: t.reason,
      owner: t.owner_user_id ? { id: t.owner_user_id, name: n.users.get(t.owner_user_id)?.name ?? '' } : null,
      customer: customer?.name || conv?.name || '', vip: Boolean(customer?.vip), customerId: t.customer_id, platform: conv?.platform ?? null,
      conversationId: t.conversation_id, order: t.order_id ? { id: t.order_id, number: n.orders.get(t.order_id)?.number ?? null } : null,
      at: t.created_at, due, overdue: t.status !== 'solved' && due < now, solvedAt: t.solved_at, resolution: t.resolution, resolutionKind: t.resolution_kind ?? '',
    };
  }

  router.get('/tickets', auth, async (req, res) => {
    const ws = req.user.workspace_id;
    const status = [...TICKET_STATUSES, 'all'].includes(req.query.status) ? req.query.status : 'open';
    const base = { workspace_id: ws, ...(await scope(req)) };
    if (req.query.mine === '1') base.owner_user_id = req.user.id;
    const where = { ...base, ...(status === 'all' ? {} : { status }) };
    const q = clean(req.query.q, 60);
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      where.$and = [{ $or: [{ title: rx }, { reason: rx }, ...(/^\d+$/.test(q) ? [{ number: Number(q) }] : [])] }];
    }
    const [list, counts] = await Promise.all([
      db.tickets.find(where).sort({ status: 1, act_now: -1, created_at: 1 }).limit(200).lean(),
      db.tickets.aggregate([{ $match: base }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    ]);
    // Open and waiting: ACT NOW first, then the oldest (closest to overdue). Solved: newest first.
    if (status === 'solved') list.sort((a, b) => (b.solved_at ?? 0) - (a.solved_at ?? 0));
    const n = await names(list);
    const c = Object.fromEntries(counts.map((x) => [x._id, x.n]));
    const team = await db.users.find({ workspace_id: ws }, { name: 1, role: 1 }).sort({ name: 1 }).lean();
    res.json({
      tickets: list.map((t) => row(t, n)), status,
      counts: { open: c.open ?? 0, waiting: c.waiting ?? 0, solved: c.solved ?? 0, actNow: await db.tickets.countDocuments({ ...base, act_now: true, status: { $ne: 'solved' } }) },
      team: team.map((u) => ({ id: u._id, name: u.name })),
    });
  });

  async function load(req) {
    const t = await db.tickets.findOne({ workspace_id: req.user.workspace_id, number: Number(req.params.n), ...(await scope(req)) }).lean();
    if (!t) throw new InboxError(404, 'Ticket not found');
    return t;
  }

  router.get('/tickets/:n', auth, async (req, res) => {
    const t = await load(req);
    const n = await names([t]);
    const chat = t.conversation_id ? (await db.messages.find({ conversation_id: t.conversation_id }).sort({ _id: -1 }).limit(12).lean()).reverse() : [];
    const orders = t.customer_id ? await db.orders.find({ customer_id: t.customer_id, draft: { $ne: true } }, { number: 1, status: 1, created_at: 1, subtotal: 1, delivery_charge: 1, discount: 1 }).sort({ created_at: -1 }).limit(5).lean() : [];
    const team = await db.users.find({ workspace_id: req.user.workspace_id }, { name: 1 }).sort({ name: 1 }).lean();
    res.json({
      ticket: { ...row(t, n), timeline: (t.timeline ?? []).map((e) => ({ type: e.type, text: e.text, by: e.by, at: e.at })) },
      chat: chat.map((m) => ({ id: m._id, direction: m.direction, text: m.text || (m.attachments?.length ? `[${m.attachments[0].type}]` : ''), byAi: Boolean(m.sent_by_ai), at: m.created_at })),
      orders: orders.map((o) => ({ id: o._id, number: o.number, status: o.status, total: (o.subtotal ?? 0) + (o.delivery_charge ?? 0) - (o.discount ?? 0), at: o.created_at })),
      team: team.map((u) => ({ id: u._id, name: u.name })),
    });
  });

  // "+ New ticket": from a chat (conversationId) or by hand, optionally for an order.
  router.post('/tickets', auth, reply, async (req, res) => {
    const ws = req.user.workspace_id;
    const title = clean(req.body?.title, 160);
    if (!title) throw new InboxError(400, 'Say what the problem is');
    let conversationId = null;
    let customerId = null;
    let orderId = null;
    if (req.body?.conversationId) {
      const conv = await db.conversations.findOne({ _id: Number(req.body.conversationId), workspace_id: ws }).lean();
      if (!conv) throw new InboxError(404, 'Chat not found');
      conversationId = conv._id; customerId = conv.customer_id ?? null;
    }
    if (req.body?.orderNumber) {
      const order = await db.orders.findOne({ workspace_id: ws, number: Number(req.body.orderNumber) }).lean();
      if (!order) throw new InboxError(404, `Order #${req.body.orderNumber} not found`);
      orderId = order._id; customerId ??= order.customer_id ?? null; conversationId ??= order.conversation_id ?? null;
    }
    const owner = req.body?.ownerId ? await db.users.findOne({ _id: Number(req.body.ownerId), workspace_id: ws }, { _id: 1 }).lean() : null;
    const { ticket, created } = await openTicket(db, {
      workspaceId: ws, conversationId, customerId, orderId, title, type: req.body?.type, actNow: Boolean(req.body?.actNow),
      reason: clean(req.body?.note, 300), by: req.user.name, ownerId: owner?._id ?? req.user.id, notify: req.body?.actNow ? notify : null,
    });
    if (req.body?.actNow && conversationId) await db.conversations.updateOne({ _id: conversationId }, { $set: { act_now: true } });
    emit(ws, 'ticket', { number: ticket.number });
    res.status(created ? 201 : 200).json({ number: ticket.number, created });
  });

  // Owner, status (open / waiting on the customer / solved with a resolution), ACT NOW, type.
  router.patch('/tickets/:n', auth, reply, async (req, res) => {
    const t = await load(req);
    const b = req.body ?? {};
    const set = {};
    const events = [];
    if (b.ownerId !== undefined) {
      const owner = b.ownerId ? await db.users.findOne({ _id: Number(b.ownerId), workspace_id: req.user.workspace_id }, { name: 1 }).lean() : null;
      if (b.ownerId && !owner) throw new InboxError(404, 'Teammate not found');
      set.owner_user_id = owner?._id ?? null;
      events.push(timelineEntry('owner', owner ? `Assigned to ${owner.name}` : 'Unassigned', req.user.name));
    }
    if (b.type !== undefined) {
      if (!TICKET_TYPES.includes(b.type)) throw new InboxError(400, 'Unknown ticket type');
      set.type = b.type;
    }
    if (typeof b.actNow === 'boolean' && b.actNow !== t.act_now) {
      set.act_now = b.actNow;
      events.push(timelineEntry('flag', b.actNow ? 'Marked ACT NOW' : 'ACT NOW cleared', req.user.name));
    }
    if (b.status !== undefined && b.status !== t.status) {
      if (!TICKET_STATUSES.includes(b.status)) throw new InboxError(400, 'Unknown status');
      if (b.status === 'solved') {
        const resolution = clean(b.resolution, 500);
        if (!resolution) throw new InboxError(400, 'Write how it was solved');
        set.resolution = resolution;
        set.resolution_kind = RESOLUTIONS.includes(b.resolutionKind) ? b.resolutionKind : 'other';
        set.solved_at = new Date();
        set.act_now = false;
        events.push(timelineEntry('solved', resolution, req.user.name, { kind: set.resolution_kind }));
      } else {
        if (t.status === 'solved') { set.solved_at = null; events.push(timelineEntry('reopened', 'Reopened', req.user.name)); }
        if (b.status === 'waiting') events.push(timelineEntry('status', 'Waiting on the customer', req.user.name));
        if (b.status === 'open' && t.status === 'waiting') events.push(timelineEntry('status', 'Back to open', req.user.name));
      }
      set.status = b.status;
    }
    if (!Object.keys(set).length) throw new InboxError(400, 'Nothing to change');
    await db.tickets.updateOne({ _id: t._id }, { $set: set, ...(events.length ? { $push: { timeline: { $each: events } } } : {}) });
    // Solving the ticket clears the chat's ACT NOW flag too.
    if (set.act_now === false && t.conversation_id) await db.conversations.updateOne({ _id: t.conversation_id }, { $set: { act_now: false } });
    if (set.status === 'solved') await audit(db, req.user, `Solved ticket #${t.number}`, { where: 'Tickets' });
    emit(req.user.workspace_id, 'ticket', { number: t.number });
    res.json({ ok: true });
  });

  router.post('/tickets/:n/notes', auth, reply, async (req, res) => {
    const t = await load(req);
    const text = clean(req.body?.text, 1000);
    if (!text) throw new InboxError(400, 'Write a note');
    await db.tickets.updateOne({ _id: t._id }, { $push: { timeline: timelineEntry('note', text, req.user.name) } });
    emit(req.user.workspace_id, 'ticket', { number: t.number });
    res.status(201).json({ ok: true });
  });

  // "Reply in chat": sends to the customer from the ticket and records it on the timeline.
  router.post('/tickets/:n/reply', auth, reply, async (req, res) => {
    const t = await load(req);
    if (!t.conversation_id) throw new InboxError(409, 'This ticket has no chat to reply in');
    const text = clean(req.body?.text, 2000);
    const message = await inbox.sendReply(req.user, t.conversation_id, text);
    await db.tickets.updateOne({ _id: t._id }, { $push: { timeline: timelineEntry('reply', text, req.user.name) } });
    emit(req.user.workspace_id, 'ticket', { number: t.number });
    res.status(201).json({ id: message.id, status: message.status });
  });

  return router;
}

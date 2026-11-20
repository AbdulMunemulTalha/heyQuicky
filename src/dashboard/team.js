// Team settings (TEAM-04/05/07): who shares handed-over chats, working hours, reply targets with
// a warning to the owner, and IF → THEN routing rules. Stored in workspace.settings.team.

const TZ_OFFSET_MIN = 6 * 60; // Bangladesh, no daylight saving
// Round-robin: next on-duty member in turn · balanced (least busy): fewest open chats · queue (manual only).
export const SHARE_MODES = ['round_robin', 'balanced', 'queue'];
// When each kind of rule is checked: a chat arriving, the AI handing it over, a comment that needs a person.
export const RULE_FIELDS = ['channel', 'tag', 'new_customer', 'topic', 'order_over', 'comment'];
export const RULE_ACTIONS = ['assign', 'assign_ticket', 'notify'];
export const TOPICS = { complaint: ['complaint'], order_status: ['order_status'], payment: ['payment'], delivery: ['delivery'], new_order: ['order'], price: ['price', 'stock', 'product_info'] };
const STAGE_FIELDS = { inbound: ['channel', 'tag', 'new_customer'], handoff: ['topic', 'order_over'], comment: ['comment'] };
export const DEFAULT_OFF_DUTY = 'আমাদের টিম এখন অফলাইনে আছে। কাজের সময় শুরু হলেই আপনাকে উত্তর দেবে 🙏';

export function teamSettings(ws) {
  const t = ws?.settings?.team ?? {};
  return {
    share: SHARE_MODES.includes(t.share) ? t.share : 'balanced',
    shareRoles: Array.isArray(t.share_roles) && t.share_roles.length ? t.share_roles : ['moderator'],
    replyMin: t.reply_min ?? 15,
    warnMin: t.warn_min ?? 30,
    hours: { on: Boolean(t.hours?.on), days: t.hours?.days ?? [0, 1, 2, 3, 4, 6], start: t.hours?.start ?? '10:00', end: t.hours?.end ?? '22:00' },
    rules: (Array.isArray(t.rules) ? t.rules : []).map((r) => ({ ...r, action: RULE_ACTIONS.includes(r.action) ? r.action : 'assign' })),
    // TEAM-04: only on-duty people get team alerts (can be turned off), and what the AI says when nobody is on duty.
    dutyOnly: t.duty_only !== false,
    offDuty: { on: t.off_duty?.on !== false, message: t.off_duty?.message || DEFAULT_OFF_DUTY },
  };
}

// Is the team working right now (Dhaka time)? With working hours off, always.
export function inHours(ws, now = new Date()) {
  const h = teamSettings(ws).hours;
  if (!h.on) return true;
  const local = new Date(now.getTime() + TZ_OFFSET_MIN * 60_000);
  const day = local.getUTCDay();
  const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
  const toMin = (s) => { const [a, b] = String(s).split(':').map(Number); return a * 60 + (b || 0); };
  const start = toMin(h.start);
  const end = toMin(h.end);
  // Hours past midnight (e.g. 18:00–02:00) count for the day they start.
  if (end <= start) return (h.days.includes(day) && mins >= start) || (h.days.includes((day + 6) % 7) && mins < end);
  return h.days.includes(day) && mins >= start && mins < end;
}

export function hoursLine(ws) {
  const h = teamSettings(ws).hours;
  if (!h.on) return '';
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return `The team answers ${h.days.map((d) => names[d]).join(', ')}, ${h.start}–${h.end} (Bangladesh time).`;
}

const onDutyUser = (db, workspaceId, userId) => db.users.findOne({ _id: userId, workspace_id: workspaceId, is_active: { $ne: false }, on_duty: { $ne: false }, is_online: { $ne: false } }, { _id: 1, name: 1 }).lean();

// The first rule for this moment that matches. ctx: { conversation, intent, comment }.
export async function matchRule(db, ws, stage, ctx = {}) {
  const rules = teamSettings(ws).rules.filter((r) => STAGE_FIELDS[stage].includes(r.field));
  if (!rules.length) return null;
  const conv = ctx.conversation;
  const [channel, customer, order] = conv ? await Promise.all([
    db.channels.findById(conv.channel_id, { platform: 1 }).lean(),
    conv.customer_id ? db.customers.findById(conv.customer_id, { tags: 1, vip: 1, stats: 1 }).lean() : null,
    db.orders.findOne({ conversation_id: conv._id ?? conv.id, draft: { $ne: true }, status: { $nin: ['cancelled', 'returned', 'delivered'] } }).sort({ created_at: -1 }).lean(),
  ]) : [null, null, null];
  for (const r of rules) {
    let hit = false;
    if (r.field === 'channel') hit = channel?.platform === r.value;
    if (r.field === 'tag') hit = Boolean(customer && ((r.value === 'VIP' && customer.vip) || (customer.tags ?? []).some((x) => x.toLowerCase() === String(r.value).toLowerCase())));
    if (r.field === 'new_customer') hit = !customer || (customer.stats?.orders ?? 0) === 0;
    if (r.field === 'topic') hit = (TOPICS[r.value] ?? []).includes(ctx.intent);
    if (r.field === 'order_over') hit = Boolean(order && (order.subtotal ?? 0) + (order.delivery_charge ?? 0) - (order.discount ?? 0) > Number(r.value));
    if (r.field === 'comment') hit = true;
    if (hit) return r;
  }
  return null;
}

// Kept for inbound routing: the teammate a rule assigns, if they're on duty.
export async function ruleAssignee(db, conversation, ws) {
  const r = await matchRule(db, ws, 'inbound', { conversation });
  if (!r || r.action === 'notify') return null;
  return (await onDutyUser(db, conversation.workspace_id, r.user_id))?._id ?? null;
}

// Runs a matching rule's action: assign (+ open a ticket) or keep with the AI and notify someone.
// Returns what happened, for logs and tests.
export async function applyRule(db, rule, { conversation = null, reason = '', notify = null, openTicket = null, title = '' }) {
  const wsId = conversation?.workspace_id ?? rule.workspace_id;
  const user = await onDutyUser(db, wsId ?? rule.workspace_id, rule.user_id);
  if (rule.action === 'notify' || !conversation) {
    if (notify) await notify({ workspaceId: wsId, event: 'handoff', title: title || 'A routing rule wants you to look', body: String(reason).slice(0, 200), link: conversation ? `/inbox/${conversation._id ?? conversation.id}` : '/comments', userIds: [rule.user_id] }).catch(() => {});
    return 'notified';
  }
  if (!user) return 'off_duty';
  const id = conversation._id ?? conversation.id;
  await db.conversations.updateOne({ _id: id }, { $set: { assigned_user_id: user._id } });
  await db.users.updateOne({ _id: user._id }, { $set: { last_assigned_at: new Date() } });
  if (rule.action === 'assign_ticket' && openTicket) {
    await openTicket(db, { workspaceId: wsId, conversationId: id, customerId: conversation.customer_id ?? null, title: reason || 'Routed by a rule', reason, by: 'Routing rule', ownerId: user._id }).catch(() => {});
  }
  return rule.action === 'assign_ticket' ? 'assigned_ticket' : 'assigned';
}

// Is anyone who can reply on duty right now?
export async function anyoneOnDuty(db, workspaceId) {
  return Boolean(await db.users.exists({ workspace_id: workspaceId, is_active: { $ne: false }, on_duty: { $ne: false }, is_online: { $ne: false }, invite_pending: { $ne: true } }));
}

// TEAM-05 counters: chats waiting for a person, past the reply target, and never answered.
export async function slaCounts(db, ws, now = new Date()) {
  const s = teamSettings(ws);
  const base = { workspace_id: ws._id, status: 'open', spam: { $ne: true }, last_replier: 'customer' };
  const waiting = await db.conversations.find({ ...base, ai_handoff: true }, { last_inbound_at: 1, assigned_user_id: 1, contact_id: 1 }).sort({ last_inbound_at: 1 }).limit(500).lean();
  const past = waiting.filter((c) => now - new Date(c.last_inbound_at) > s.replyMin * 60_000);
  // "Never answered · 7 days": chats from the last week nobody ever replied to, past the reply target.
  const never = await db.conversations.countDocuments({ ...base, first_reply_at: null, created_at: { $gte: new Date(now.getTime() - 7 * 86_400_000), $lt: new Date(now.getTime() - s.replyMin * 60_000) } });
  return { waiting: waiting.length, pastTarget: past.length, past, neverAnswered: never, oldest: waiting.slice(0, 5), inHours: inHours(ws, now) };
}

// Warns the owner once per chat when a handed-over chat waits past "Warn the owner after" (working hours only).
export async function checkSla(db, notify, now = new Date()) {
  const shops = await db.workspaces.find({}, { name: 1, settings: 1 }).lean();
  let warned = 0;
  for (const ws of shops) {
    if (!inHours(ws, now)) continue;
    const s = teamSettings(ws);
    const late = await db.conversations.find({ workspace_id: ws._id, status: 'open', spam: { $ne: true }, last_replier: 'customer', ai_handoff: true,
      last_inbound_at: { $lt: new Date(now.getTime() - s.warnMin * 60_000), $gt: new Date(now.getTime() - 24 * 3_600_000) } }, { contact_id: 1, last_inbound_at: 1 }).limit(20).lean();
    for (const c of late) {
      const contact = await db.contacts.findById(c.contact_id, { name: 1 }).lean();
      const mins = Math.round((now - new Date(c.last_inbound_at)) / 60_000);
      const out = await notify({ workspaceId: ws._id, event: 'escalation', title: `${contact?.name || 'A customer'} has waited ${mins} min for a reply`,
        body: `Past your ${s.warnMin}-minute warning. Open the chat or assign it.`, link: `/inbox/${c._id}`, ref: `sla:${c._id}:${new Date(c.last_inbound_at).getTime()}`, roleOverride: ['owner'] }).catch(() => []);
      if (out?.length) warned += 1;
    }
  }
  return warned;
}

export function startSlaWatch(db, notify, { everyMs = 60_000 } = {}) {
  if (process.env.NODE_ENV === 'test') return null;
  const timer = setInterval(() => checkSla(db, notify).catch((err) => console.warn('reply-target check failed:', err.message)), everyMs);
  timer.unref?.();
  return timer;
}

// Team settings (TEAM-04/05/07): who shares handed-over chats, working hours, reply targets with
// a warning to the owner, and IF → THEN routing rules. Stored in workspace.settings.team.

const TZ_OFFSET_MIN = 6 * 60; // Bangladesh, no daylight saving
export const SHARE_MODES = ['balanced', 'queue'];
export const RULE_FIELDS = ['channel', 'tag', 'new_customer'];

export function teamSettings(ws) {
  const t = ws?.settings?.team ?? {};
  return {
    share: SHARE_MODES.includes(t.share) ? t.share : 'balanced',
    shareRoles: Array.isArray(t.share_roles) && t.share_roles.length ? t.share_roles : ['moderator'],
    replyMin: t.reply_min ?? 15,
    warnMin: t.warn_min ?? 30,
    hours: { on: Boolean(t.hours?.on), days: t.hours?.days ?? [0, 1, 2, 3, 4, 6], start: t.hours?.start ?? '10:00', end: t.hours?.end ?? '22:00' },
    rules: Array.isArray(t.rules) ? t.rules : [],
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

// The first matching rule's teammate, if they're active and on duty (otherwise the usual sharing applies).
export async function ruleAssignee(db, conversation, ws) {
  const rules = teamSettings(ws).rules;
  if (!rules.length) return null;
  const [channel, customer] = await Promise.all([
    db.channels.findById(conversation.channel_id, { platform: 1 }).lean(),
    conversation.customer_id ? db.customers.findById(conversation.customer_id, { tags: 1, vip: 1, stats: 1 }).lean() : null,
  ]);
  for (const r of rules) {
    let hit = false;
    if (r.field === 'channel') hit = channel?.platform === r.value;
    if (r.field === 'tag') hit = Boolean(customer && ((r.value === 'VIP' && customer.vip) || (customer.tags ?? []).some((x) => x.toLowerCase() === String(r.value).toLowerCase())));
    if (r.field === 'new_customer') hit = !customer || (customer.stats?.orders ?? 0) === 0;
    if (!hit) continue;
    const user = await db.users.findOne({ _id: r.user_id, workspace_id: conversation.workspace_id, is_active: { $ne: false }, on_duty: { $ne: false }, is_online: { $ne: false } }, { _id: 1 }).lean();
    if (user) return user._id;
  }
  return null;
}

// TEAM-05 counters: chats waiting for a person, past the reply target, and never answered.
export async function slaCounts(db, ws, now = new Date()) {
  const s = teamSettings(ws);
  const base = { workspace_id: ws._id, status: 'open', spam: { $ne: true }, last_replier: 'customer' };
  const waiting = await db.conversations.find({ ...base, ai_handoff: true }, { last_inbound_at: 1, assigned_user_id: 1, contact_id: 1 }).sort({ last_inbound_at: 1 }).limit(500).lean();
  const past = waiting.filter((c) => now - new Date(c.last_inbound_at) > s.replyMin * 60_000);
  const never = await db.conversations.countDocuments({ ...base, first_reply_at: null, created_at: { $lt: new Date(now.getTime() - s.replyMin * 60_000) } });
  return { waiting: waiting.length, pastTarget: past.length, neverAnswered: never, oldest: waiting.slice(0, 5), inHours: inHours(ws, now) };
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

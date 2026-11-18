// Notifications (UX-09, HND-06): one place decides who hears about an event and how —
// in the app (bell + live socket), on their phone (web push) — following each person's
// "Notify me about" settings and quiet hours.

// Event → panel tab, who gets it by default, and the default channels (frame 16b).
export const EVENTS = {
  order: { category: 'orders', roles: ['owner', 'admin'], app: true, phone: true, whatsapp: true },
  handoff: { category: 'chats', roles: ['owner', 'admin', 'moderator'], app: true, phone: true, whatsapp: false },
  escalation: { category: 'orders', roles: ['owner', 'admin', 'moderator'], app: true, phone: true, whatsapp: true },
  mention: { category: 'chats', roles: [], app: true, phone: false, whatsapp: false },
  stock: { category: 'system', roles: ['owner', 'admin'], app: true, phone: true, whatsapp: false },
  credit: { category: 'system', roles: ['owner'], app: true, phone: false, whatsapp: true },
  courier: { category: 'orders', roles: ['owner', 'admin', 'moderator'], app: true, phone: false, whatsapp: false },
};
export const EVENT_KEYS = Object.keys(EVENTS);
export const BIG_ORDER = 10_000; // new orders at least this big still reach the phone in quiet hours

export function prefsFor(user) {
  const saved = user?.notify_prefs ?? {};
  const events = {};
  for (const [key, e] of Object.entries(EVENTS)) {
    const s = saved.events?.[key] ?? {};
    events[key] = { app: s.app ?? e.app, phone: s.phone ?? e.phone, whatsapp: s.whatsapp ?? e.whatsapp };
  }
  return { events, quiet: saved.quiet ?? true };
}

// Quiet hours: 12 AM – 8 AM in Dhaka.
export function inQuietHours(now = new Date()) {
  const hour = (now.getUTCHours() + 6) % 24;
  return hour < 8;
}

// notify(db, emit, adapters, { workspaceId, event, title, body, link, ref, userIds?, amount? })
// userIds: exact people (mentions, an assignee); otherwise everyone active whose role gets this event.
// ref: de-duplicates (the same ref is not repeated to a person within an hour).
export async function notify(db, emit, adapters, { workspaceId, event, title, body = '', link = '', ref = '', userIds = null, exceptUserId = null, amount = 0, now = new Date() }) {
  const def = EVENTS[event];
  if (!def) throw new Error(`Unknown notification event ${event}`);
  const where = { workspace_id: workspaceId, is_active: { $ne: false } };
  if (userIds) where._id = { $in: userIds };
  else where.role = { $in: def.roles };
  if (exceptUserId) where._id = { ...(where._id ?? {}), $ne: exceptUserId };
  const users = await db.users.find(where, { notify_prefs: 1, role: 1 }).lean();
  const sent = [];
  for (const user of users) {
    const p = prefsFor(user).events[event];
    if (ref && await db.notifications.exists({ user_id: user._id, ref, created_at: { $gte: new Date(now.getTime() - 3_600_000) } })) continue;
    if (p.app) {
      const n = await db.insert(db.notifications, { workspace_id: workspaceId, user_id: user._id, type: event, category: def.category, title, body, link, ref });
      emit(workspaceId, 'notification', { id: n.id, userId: user._id, type: event, category: def.category, title, body, link, at: n.created_at });
      sent.push(n.id);
    }
    const quiet = prefsFor(user).quiet && inQuietHours(now) && !(event === 'order' && amount >= BIG_ORDER);
    if (p.phone && !quiet) await pushTo(db, adapters, user._id, { title, body, link: link ? `/app${link}` : '/app' });
  }
  return sent;
}

// Sends a web push to every device the person turned phone alerts on for. Dead subscriptions are removed.
export async function pushTo(db, adapters, userId, payload) {
  if (!adapters?.push) return;
  const subs = await db.pushSubscriptions.find({ user_id: userId }).lean();
  for (const s of subs) {
    try {
      await adapters.push.send({ endpoint: s.endpoint, keys: s.keys }, payload);
    } catch (err) {
      if (err?.statusCode === 404 || err?.statusCode === 410) await db.pushSubscriptions.deleteOne({ _id: s._id });
    }
  }
}

// Kept for the callers that notify one person directly (assigned a chat, mentioned).
export async function addNotification(db, emit, { workspaceId, userId, type, title, body = '', link = '', adapters = null }) {
  const event = EVENTS[type] ? type : 'mention';
  const [id] = await notify(db, emit, adapters, { workspaceId, event, title, body, link, userIds: [userId] });
  return { id };
}

// Builds the notifier the routes and services share.
export const createNotifier = (db, emit, adapters) => (args) => notify(db, emit, adapters, args).catch((err) => {
  if (process.env.NODE_ENV !== 'test') console.error('notify failed', err);
  return [];
});

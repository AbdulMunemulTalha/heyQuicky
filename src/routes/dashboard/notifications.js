import { Router } from 'express';
import { InboxError } from '../../inbox.js';
import { EVENTS, EVENT_KEYS, prefsFor } from '../../dashboard/notify.js';

const CATEGORIES = ['orders', 'chats', 'system'];

// Screen 16 Notifications panel and 16b "Notify me about" (UX-09, HND-06).
export function notificationRoutes(db, _config, { auth, adapters }) {
  const router = Router();

  router.get('/notifications', auth, async (req, res) => {
    const where = { user_id: req.user.id, dismissed: false };
    if (CATEGORIES.includes(req.query.category)) where.category = req.query.category;
    const [items, unread, byCategory] = await Promise.all([
      db.notifications.find(where).sort({ created_at: -1 }).limit(60).lean(),
      db.notifications.countDocuments({ user_id: req.user.id, dismissed: false, read_at: null }),
      db.notifications.aggregate([{ $match: { user_id: req.user.id, dismissed: false, read_at: null } }, { $group: { _id: '$category', n: { $sum: 1 } } }]),
    ]);
    res.json({
      unread, byCategory: Object.fromEntries(byCategory.map((c) => [c._id, c.n])),
      items: items.map((n) => ({ id: n._id, type: n.type, category: n.category, title: n.title, body: n.body, link: n.link, at: n.created_at, read: Boolean(n.read_at) })),
    });
  });

  router.post('/notifications/read-all', auth, async (req, res) => {
    const r = await db.notifications.updateMany({ user_id: req.user.id, read_at: null }, { $set: { read_at: new Date() } });
    res.json({ updated: r.modifiedCount });
  });

  router.post('/notifications/:id/read', auth, async (req, res) => {
    await db.notifications.updateOne({ _id: Number(req.params.id), user_id: req.user.id, read_at: null }, { $set: { read_at: new Date() } });
    res.json({ ok: true });
  });

  router.post('/notifications/:id/dismiss', auth, async (req, res) => {
    const r = await db.notifications.updateOne({ _id: Number(req.params.id), user_id: req.user.id }, { $set: { dismissed: true, read_at: new Date() } });
    if (!r.matchedCount) throw new InboxError(404, 'Notification not found');
    res.json({ ok: true });
  });

  // "Notify me about": which events reach this person, where, and quiet hours.
  router.get('/notifications/prefs', auth, async (req, res) => {
    const user = await db.users.findById(req.user.id, { notify_prefs: 1 }).lean();
    const p = prefsFor(user);
    res.json({
      events: EVENT_KEYS.map((key) => ({ key, ...p.events[key] })), quiet: p.quiet,
      push: { publicKey: adapters?.push?.publicKey || null, devices: await db.pushSubscriptions.countDocuments({ user_id: req.user.id }) },
      whatsapp: false, // WhatsApp alerts to teammates need an approved message template; saved now, sent once that's set up
    });
  });

  router.patch('/notifications/prefs', auth, async (req, res) => {
    const set = {};
    for (const [key, v] of Object.entries(req.body?.events ?? {})) {
      if (!EVENTS[key]) throw new InboxError(400, `Unknown event ${key}`);
      for (const ch of ['app', 'phone', 'whatsapp']) if (typeof v?.[ch] === 'boolean') set[`notify_prefs.events.${key}.${ch}`] = v[ch];
    }
    if (typeof req.body?.quiet === 'boolean') set['notify_prefs.quiet'] = req.body.quiet;
    if (!Object.keys(set).length) throw new InboxError(400, 'Nothing to change');
    // notify_prefs may be null on older accounts; start from an empty object so dotted paths work.
    await db.users.updateOne({ _id: req.user.id, notify_prefs: null }, { $set: { notify_prefs: {} } });
    await db.users.updateOne({ _id: req.user.id }, { $set: set });
    res.json({ ok: true });
  });

  // Phone alerts: this browser's push subscription (from the service worker).
  router.post('/notifications/push', auth, async (req, res) => {
    const { endpoint, keys } = req.body ?? {};
    if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !keys?.p256dh || !keys?.auth) throw new InboxError(400, 'This browser did not give a valid push subscription');
    await db.pushSubscriptions.updateOne({ endpoint }, { $set: { user_id: req.user.id, workspace_id: req.user.workspace_id, keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) } },
      $setOnInsert: { _id: await db.nextId(db.pushSubscriptions.collection.collectionName), created_at: new Date() } }, { upsert: true });
    res.status(201).json({ devices: await db.pushSubscriptions.countDocuments({ user_id: req.user.id }) });
  });

  router.delete('/notifications/push', auth, async (req, res) => {
    await db.pushSubscriptions.deleteOne({ endpoint: String(req.body?.endpoint ?? ''), user_id: req.user.id });
    res.json({ devices: await db.pushSubscriptions.countDocuments({ user_id: req.user.id }) });
  });

  router.post('/notifications/push/test', auth, async (req, res) => {
    const subs = await db.pushSubscriptions.find({ user_id: req.user.id }).lean();
    if (!subs.length) throw new InboxError(409, 'Turn on phone alerts on a device first');
    for (const s of subs) await adapters.push.send({ endpoint: s.endpoint, keys: s.keys }, { title: 'HeyQuicky', body: 'Phone alerts are on ✓', link: '/app' }).catch(() => {});
    res.json({ sent: subs.length });
  });

  return router;
}

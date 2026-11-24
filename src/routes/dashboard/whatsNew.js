import { Router } from 'express';
import { InboxError } from '../../inbox.js';
import { modulesFor } from '../../dashboard/settings.js';
import { announcementsFor } from '../../dashboard/announcements.js';

// UX-04 · Help → What's new and the announcement bar.
export function whatsNewRoutes(db, _config, { auth }) {
  const router = Router();
  const load = async (req) => {
    const ws = await db.workspaces.findById(req.user.workspace_id).lean();
    const u = await db.users.findById(req.user.id, { language: 1 }).lean();
    const lang = req.query.lang === 'bn' || req.query.lang === 'en' ? req.query.lang : u?.language ?? 'en';
    return announcementsFor(db, req.user, { lang, modules: modulesFor(ws) });
  };

  router.get('/whats-new', auth, async (req, res) => res.json(await load(req)));

  // Opening the tab reads everything.
  router.post('/whats-new/seen', auth, async (req, res) => {
    await db.users.updateOne({ _id: req.user.id }, { $set: { whats_new_seen_at: new Date() } });
    res.json(await load(req));
  });

  router.post('/whats-new/:id/dismiss', auth, async (req, res) => {
    const id = String(req.params.id).slice(0, 80);
    if (!/^[a-z0-9-]+$/i.test(id)) throw new InboxError(400, 'Unknown announcement');
    await db.users.updateOne({ _id: req.user.id }, { $addToSet: { dismissed_bars: id } });
    res.json(await load(req));
  });

  return router;
}

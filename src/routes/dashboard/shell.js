import { Router } from 'express';
import { InboxError } from '../../inbox.js';
import { audit } from '../../dashboard/util.js';
import { addCredit } from '../../dashboard/credit.js';

// Top bar and sidebar actions: AI live / practice, on duty, language and theme.
export function shellRoutes(db, config, { auth, emit }) {
  const router = Router();

  // "AI live" = the AI replies to customers by itself; "Practice" = it only drafts and answers testers.
  router.post('/ai-mode', auth, async (req, res) => {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') throw new InboxError(403, 'Only the owner or an admin can switch the AI live');
    const mode = req.body?.mode;
    if (!['auto', 'suggest', 'off'].includes(mode)) throw new InboxError(400, 'Unknown AI mode');
    const ws = await db.workspaces.findById(req.user.workspace_id).lean();
    const set = { ai_mode: mode };
    // The free trial starts when the shop first goes live, not at sign-up (ONB-08, BIL-04).
    if (mode === 'auto' && !ws.went_live_at) {
      Object.assign(set, { went_live_at: new Date(), trial_started_at: new Date() });
      const trial = Number(process.env.TRIAL_CREDIT || 0);
      if (trial > 0) await addCredit(db, ws._id, trial, { type: 'trial', ref: 'Free starter credit' });
    }
    await db.workspaces.updateOne({ _id: ws._id }, { $set: set });
    await audit(db, req.user, mode === 'auto' ? 'Switched the AI live' : mode === 'suggest' ? 'Switched the AI to practice' : 'Turned the AI off', { where: 'AI agent' });
    emit(ws._id, 'workspace', { aiMode: mode });
    res.json({ aiMode: mode });
  });

  router.post('/duty', auth, async (req, res) => {
    const onDuty = Boolean(req.body?.onDuty);
    await db.users.updateOne({ _id: req.user.id }, { $set: { on_duty: onDuty, is_online: onDuty } });
    emit(req.user.workspace_id, 'team', { userId: req.user.id, onDuty });
    res.json({ onDuty });
  });

  router.patch('/prefs', auth, async (req, res) => {
    const set = {};
    if (req.body?.language !== undefined) {
      if (!['en', 'bn'].includes(req.body.language)) throw new InboxError(400, 'Unknown language');
      set.language = req.body.language;
    }
    if (req.body?.theme !== undefined) {
      if (!['light', 'dark', 'system'].includes(req.body.theme)) throw new InboxError(400, 'Unknown theme');
      set.theme = req.body.theme;
    }
    await db.users.updateOne({ _id: req.user.id }, { $set: set });
    res.json(set);
  });

  return router;
}

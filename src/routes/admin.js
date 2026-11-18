import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { approveTopup, rejectTopup } from '../dashboard/credit.js';

// HeyQuicky's own admin endpoints, behind ADMIN_TOKEN (HTTP Basic, any user name). Off when it isn't set.
export function adminAuth(config, realm = 'HeyQuicky admin') {
  return (req, res, next) => {
    if (!config.adminToken) return res.sendStatus(404);
    const [scheme, encoded] = String(req.get('authorization') ?? '').split(' ');
    const [, password = ''] = scheme === 'Basic' ? Buffer.from(encoded ?? '', 'base64').toString().split(/:(.*)/s) : [];
    const a = Buffer.from(password);
    const b = Buffer.from(config.adminToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return res.set('WWW-Authenticate', `Basic realm="${realm}"`).sendStatus(401);
    return next();
  };
}

// Manual AI-credit top-ups (BIL-05): check the TrxID in HeyQuicky's bKash / Nagad account, then approve or reject.
export function adminRoutes(db, config) {
  const router = Router();
  const guard = adminAuth(config);

  router.get('/admin/topups', guard, async (_req, res) => {
    const pending = await db.credit.find({ type: 'top_up', status: 'pending' }).sort({ created_at: 1 }).limit(500).lean();
    const names = new Map((await db.workspaces.find({ _id: { $in: pending.map((p) => p.workspace_id) } }, { name: 1 }).lean()).map((w) => [w._id, w.name]));
    res.json(pending.map((p) => ({ id: p._id, shop: names.get(p.workspace_id) ?? '', workspaceId: p.workspace_id, amount: p.amount, method: p.method, trxId: p.ref, at: p.created_at })));
  });

  router.post('/admin/topups/:id/approve', guard, async (req, res) => {
    const entry = await approveTopup(db, Number(req.params.id));
    if (!entry) return res.status(404).json({ error: 'No pending top-up with that id' });
    res.json({ id: entry._id, balance: entry.balance_after });
  });

  router.post('/admin/topups/:id/reject', guard, async (req, res) => {
    const entry = await rejectTopup(db, Number(req.params.id));
    if (!entry) return res.status(404).json({ error: 'No pending top-up with that id' });
    res.json({ id: entry._id, status: 'rejected' });
  });

  return router;
}

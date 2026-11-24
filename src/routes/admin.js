import { timingSafeEqual } from 'node:crypto';
import { Router, json } from 'express';
import { approveTopup, rejectTopup } from '../dashboard/credit.js';
import { cleanAnnouncement, RELEASES } from '../dashboard/announcements.js';
import { mergeRequests, updateRequest } from '../dashboard/requests.js';

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
export function adminRoutes(db, config, { notify = null } = {}) {
  const router = Router();
  const guard = adminAuth(config);

  // UX-04: announcements shown in What's new (and as a bar when bar is true).
  router.get('/admin/announcements', guard, async (_req, res) => {
    res.json({ added: await db.announcements.find().sort({ date: -1 }).limit(100).lean(), releases: RELEASES.map((r) => ({ id: r.id, date: r.date, title: r.title.en })) });
  });
  router.post('/admin/announcements', guard, json(), async (req, res) => {
    let a;
    try { a = cleanAnnouncement(req.body); } catch (err) { return res.status(400).json({ error: err.message }); }
    const added = await db.insert(db.announcements, a);
    res.status(201).json(await db.announcements.findById(added.id).lean());
  });
  router.delete('/admin/announcements/:id', guard, async (req, res) => {
    await db.announcements.deleteOne({ _id: Number(req.params.id) });
    res.json({ ok: true });
  });

  // UX-05: feature requests from shops, the most wanted first.
  router.get('/admin/requests', guard, async (req, res) => {
    const where = { merged_into: null, ...(req.query.status ? { status: String(req.query.status) } : {}) };
    const rows = await db.featureRequests.find(where).lean();
    const shops = new Map((await db.workspaces.find({ _id: { $in: [...new Set(rows.flatMap((r) => r.voters ?? []))] } }, { name: 1 }).lean()).map((w) => [w._id, w.name]));
    res.json({ requests: rows.sort((a, b) => (b.voters?.length ?? 0) - (a.voters?.length ?? 0)).map((r) => ({ ...r, votes: r.voters?.length ?? 0, shops: (r.voters ?? []).map((v) => shops.get(v) ?? v) })) });
  });
  router.patch('/admin/requests/:id', guard, json(), async (req, res) => {
    try { res.json(await updateRequest(db, req.params.id, req.body ?? {}, { notify })); } catch (err) { res.status(err.status ?? 500).json({ error: err.message }); }
  });
  router.post('/admin/requests/:id/merge', guard, json(), async (req, res) => {
    try { res.json(await mergeRequests(db, req.params.id, req.body?.into)); } catch (err) { res.status(err.status ?? 500).json({ error: err.message }); }
  });

  router.get('/admin/topups', guard, async (_req, res) => {
    const pending = await db.credit.find({ type: 'top_up', status: 'pending' }).sort({ created_at: 1 }).limit(500).lean();
    const names = new Map((await db.workspaces.find({ _id: { $in: pending.map((p) => p.workspace_id) } }, { name: 1 }).lean()).map((w) => [w._id, w.name]));
    res.json(pending.map((p) => ({ id: p._id, shop: names.get(p.workspace_id) ?? '', workspaceId: p.workspace_id, amount: p.amount, method: p.method, trxId: p.ref, at: p.created_at })));
  });

  router.post('/admin/topups/:id/approve', guard, async (req, res) => {
    const entry = await approveTopup(db, Number(req.params.id));
    if (!entry) return res.status(404).json({ error: 'No pending top-up with that id' });
    await notify?.({ workspaceId: entry.workspace_id, event: 'credit', title: `AI credit added: ৳${entry.amount.toLocaleString('en-IN')}`, body: `Your ${entry.method} top-up (TrxID ${entry.ref}) was approved.`, link: '/settings', ref: `topup:${entry._id}` });
    res.json({ id: entry._id, balance: entry.balance_after });
  });

  router.post('/admin/topups/:id/reject', guard, async (req, res) => {
    const entry = await rejectTopup(db, Number(req.params.id));
    if (!entry) return res.status(404).json({ error: 'No pending top-up with that id' });
    await notify?.({ workspaceId: entry.workspace_id, event: 'credit', title: 'Top-up not approved', body: `We couldn't find the ${entry.method} payment with TrxID ${entry.ref}. Check it and send it again.`, link: '/settings', ref: `topup:${entry._id}` });
    res.json({ id: entry._id, status: 'rejected' });
  });

  router.get('/admin/plan-requests', guard, async (_req, res) => {
    const list = await db.workspaces.find({ 'settings.plan_request': { $ne: null } }, { name: 1, plan: 1, 'settings.plan_request': 1 }).lean();
    res.json(list.filter((w) => w.settings?.plan_request).map((w) => ({ workspaceId: w._id, shop: w.name, plan: w.plan ?? 'starter', request: w.settings.plan_request })));
  });

  router.post('/admin/workspaces/:id/plan', guard, async (req, res) => {
    const plan = String(req.body?.plan ?? '');
    if (!['starter', 'growth', 'pro'].includes(plan)) return res.status(400).json({ error: 'plan must be starter, growth or pro' });
    const period = req.body?.period === 'yearly' ? 'yearly' : 'monthly';
    const renews = req.body?.renewsAt ? new Date(req.body.renewsAt) : new Date(Date.now() + (period === 'yearly' ? 365 : 30) * 86_400_000);
    if (Number.isNaN(renews.getTime())) return res.status(400).json({ error: 'renewsAt must be a date' });
    const r = await db.workspaces.updateOne({ _id: Number(req.params.id) }, { $set: { plan, plan_renews_at: renews, 'settings.plan_period': period }, $unset: { 'settings.plan_request': '' } });
    if (!r.matchedCount) return res.status(404).json({ error: 'No such workspace' });
    await notify?.({ workspaceId: Number(req.params.id), event: 'credit', title: `You're on ${plan[0].toUpperCase()}${plan.slice(1)} now`, body: `Billed ${period}. Renews ${renews.toISOString().slice(0, 10)}.`, link: '/settings/plan', ref: `plan:${req.params.id}:${plan}:${renews.getTime()}` });
    res.json({ plan, period, renewsAt: renews });
  });

  return router;
}

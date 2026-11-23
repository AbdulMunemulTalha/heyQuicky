import { Router } from 'express';
import { InboxError } from '../../inbox.js';
import { need } from '../../dashboard/permissions.js';
import { audit, dhakaMonthStart } from '../../dashboard/util.js';
import { averageReplyCost, TOPUP_MIN, TOPUP_MAX } from '../../dashboard/credit.js';
import { teamId } from '../../dashboard/brands.js';
import { PLAN_KEYS, plansFrom } from '../../dashboard/plans.js';

const TOPUP_AMOUNTS = [500, 1000, 2500, 5000];

// Phase 2 · Plan & upgrade, top up (BIL-01/04/05), frame "Plan & upgrade, top up".
export function planRoutes(db, config, { auth, adapters }) {
  const router = Router();
  const billing = need(db, 'billing');

  router.get('/settings/plan', auth, billing, async (req, res) => {
    // Plans, credit and usage belong to the main shop and cover every brand.
    const root = req.user.team_id ?? await teamId(db, req.user.workspace_id);
    const ws = await db.workspaces.findById(root).lean();
    const ids = (await db.workspaces.find({ $or: [{ _id: root }, { brand_group: root }] }, { _id: 1 }).lean()).map((w) => w._id);
    const month = dhakaMonthStart();
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [used, spend, aiSales, avg] = await Promise.all([
      db.aiReplies.countDocuments({ workspace_id: { $in: ids }, kind: { $in: ['reply', 'comment', 'followup'] }, created_at: { $gte: month } }),
      db.aiReplies.aggregate([{ $match: { workspace_id: { $in: ids }, created_at: { $gte: since } } }, { $group: { _id: null, cost: { $sum: '$cost' }, saved: { $sum: '$saved' } } }]),
      db.orders.aggregate([{ $match: { workspace_id: { $in: ids }, source: 'ai', draft: { $ne: true }, status: { $nin: ['cancelled', 'returned'] }, created_at: { $gte: since } } },
        { $group: { _id: null, sales: { $sum: { $subtract: [{ $add: ['$subtotal', '$delivery_charge'] }, '$discount'] } } } }]),
      averageReplyCost(db, req.user.workspace_id),
    ]);
    const plans = plansFrom();
    const current = PLAN_KEYS.includes(ws.plan) ? ws.plan : 'starter';
    const cost = spend[0]?.cost ?? 0;
    const sales = aiSales[0]?.sales ?? 0;
    res.json({
      current, renewsAt: ws.plan_renews_at, period: ws.settings?.plan_period ?? 'monthly',
      usage: { used, included: plans.find((p) => p.key === current)?.replies ?? null },
      plans, request: ws.settings?.plan_request ?? null,
      credit: ws.credit_balance ?? 0,
      topup: { amounts: TOPUP_AMOUNTS.map((a) => ({ amount: a, replies: avg > 0 ? Math.floor(a / avg) : null })), min: TOPUP_MIN, max: TOPUP_MAX,
        methods: { bkash: config.topup?.bkash || null, nagad: config.topup?.nagad || null, card: false } },
      pays: { sales, cost: Math.round(cost * 100) / 100, perTaka: cost > 0 ? Math.round(sales / cost) : null, cacheSaved: Math.round((spend[0]?.saved ?? 0) * 100) / 100 },
    });
  });

  // "Upgrade to …": until there's an online subscription payment, the HeyQuicky team is asked by email and sets the plan.
  router.post('/settings/plan/request', auth, billing, async (req, res) => {
    const plan = String(req.body?.plan ?? '');
    const period = req.body?.period === 'yearly' ? 'yearly' : 'monthly';
    if (!PLAN_KEYS.includes(plan)) throw new InboxError(400, 'Pick a plan');
    const root = req.user.team_id ?? await teamId(db, req.user.workspace_id);
    const ws = await db.workspaces.findById(root, { name: 1, plan: 1, settings: 1 }).lean();
    if ((ws.plan ?? 'starter') === plan) throw new InboxError(409, 'You are already on this plan');
    const prev = ws.settings?.plan_request;
    if (prev?.plan === plan && Date.now() - new Date(prev.at) < 24 * 3_600_000) throw new InboxError(429, 'We already have this request — we\'ll contact you soon');
    await db.workspaces.updateOne({ _id: root }, { $set: { 'settings.plan_request': { plan, period, at: new Date(), by: req.user.name } } });
    const to = config.legal?.supportEmail;
    if (to && adapters?.email) await adapters.email.send({ to, subject: `Plan request: ${ws.name} → ${plan} (${period})`, text: `${req.user.name} (${req.user.email}) asked to move ${ws.name} (workspace ${root}) from ${ws.plan ?? 'starter'} to ${plan}, billed ${period}.` });
    await audit(db, req.user, `Asked to upgrade to ${plan} (${period})`, { where: 'Plan' });
    res.json({ ok: true });
  });

  return router;
}

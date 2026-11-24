import { Router } from 'express';
import { requireAuth } from '../../auth.js';
import { InboxError } from '../../inbox.js';
import { allowedActions } from '../../dashboard/permissions.js';
import { modulesFor } from '../../dashboard/settings.js';
import { dashboardAuthRoutes } from './auth.js';
import { averageReplyCost } from '../../dashboard/credit.js';
import { announcementsFor } from '../../dashboard/announcements.js';

// Everything the dashboard needs, under /api/dash. Onboarding's routes in routes/api.js are untouched.
export function dashboardRoutes(db, config, ctx) {
  const router = Router();
  const auth = requireAuth(db);
  const { adapters } = ctx;

  router.use(dashboardAuthRoutes(db, adapters));

  // What the shell needs on load: who you are, the shop, your brands, what you may do, and badge counts.
  router.get('/me', auth, async (req, res) => {
    const [user, workspace] = await Promise.all([
      db.users.findById(req.user.id).lean(),
      db.workspaces.findById(req.user.workspace_id).lean(),
    ]);
    const group = workspace.brand_group ?? workspace._id;
    // AI credit is shared by every brand, kept on the main shop.
    const credit = group === workspace._id ? workspace.credit_balance ?? 0 : (await db.workspaces.findById(group, { credit_balance: 1 }).lean())?.credit_balance ?? 0;
    const [brands, channels] = await Promise.all([
      db.workspaces.find({ $or: [{ _id: group }, { brand_group: group }] }, { name: 1, onboarding_step: 1 }).lean(),
      db.channels.find({ workspace_id: workspace._id }, { platform: 1, name: 1, needs_reconnect: 1 }).lean(),
    ]);
    res.json({
      user: {
        id: user._id, name: user.name, displayName: user.display_name || '', email: user.email, phone: user.phone ?? '',
        role: user.role, avatar: user.avatar || '', language: user.language ?? 'en', theme: user.theme ?? 'light',
        onDuty: user.on_duty !== false && user.is_online !== false,
      },
      workspace: {
        id: workspace._id, name: workspace.name, category: workspace.category, aiMode: workspace.ai_mode ?? 'suggest',
        onboardingStep: workspace.onboarding_step, credit,
        repliesLeft: Math.floor(credit / await averageReplyCost(db, workspace._id)), plan: workspace.plan ?? 'starter',
        wentLiveAt: workspace.went_live_at, modules: modulesFor(workspace),
        channels: channels.map((c) => ({ id: c._id, platform: c.platform, name: c.name, needsReconnect: Boolean(c.needs_reconnect) })),
        // AI replies pause at zero credit only when AI_CREDIT_ENFORCED is on (src/ai/metering.js).
        creditEnforced: Boolean(config.ai?.creditEnforced),
        // Couriers marked connected but without keys can't book for real (outside test mode).
        couriersNeedKeys: config.dryRun ? [] : (await db.courierAccounts.find({ workspace_id: workspace._id, connected: true, credentials: { $in: ['', null] } }, { courier: 1 }).lean()).map((c) => c.courier),
      },
      brands: brands.map((b) => ({ id: b._id, name: b.name, current: b._id === workspace._id })),
      can: allowedActions(req.user, workspace),
      badges: await badges(db, req.user, workspace),
      support: { email: config.legal?.supportEmail || 'info@heyquicky.com', whatsapp: process.env.SUPPORT_WHATSAPP || '' },
    });
  });

  // "Ask for access" (frame 17, no permission): the owner gets a notification; repeats within an hour are dropped.
  router.post('/access-requests', auth, async (req, res) => {
    const what = String(req.body?.what ?? '').trim().slice(0, 60) || 'a page';
    const path = String(req.body?.path ?? '').trim();
    const link = /^\/[a-z0-9/_-]*$/i.test(path) ? path : '';
    await ctx.notify?.({ workspaceId: req.user.workspace_id, event: 'access', title: `${req.user.name} asked for access`, body: `to ${what}. Change their role in Settings → Team.`,
      link: '/settings/team', ref: `access:${req.user.id}:${link || what}` });
    res.json({ ok: true });
  });

  router.get('/badges', auth, async (req, res) => {
    const workspace = await db.workspaces.findById(req.user.workspace_id, { settings: 1 }).lean();
    res.json(await badges(db, req.user, workspace));
  });

  for (const mount of ctx.mounts ?? []) router.use(mount(db, config, { ...ctx, auth }));

  router.use((err, _req, res, _next) => {
    if (err instanceof InboxError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err?.name === 'ValidationError') return res.status(400).json({ error: Object.values(err.errors)[0]?.message ?? 'Invalid input' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our side. Your data is safe — try again.' });
  });

  return router;
}

// Sidebar badge counts: chats waiting for a person, orders to confirm, questions the AI couldn't answer, unread alerts.
export async function badges(db, user, workspace) {
  const ws = user.workspace_id;
  const seeAll = allowedActions(user, workspace).includes('see_all_chats');
  const mine = seeAll ? {} : { $or: [{ assigned_user_id: user.id }, { assigned_user_id: null }] };
  const [inbox, orders, agent, alerts, tickets, payments, news] = await Promise.all([
    db.conversations.countDocuments({ workspace_id: ws, status: 'open', spam: { $ne: true }, ai_handoff: true, ...mine }),
    db.orders.countDocuments({ workspace_id: ws, status: { $in: ['pending', 'confirmed', 'on_hold'] }, draft: { $ne: true } }),
    db.unanswered.countDocuments({ workspace_id: ws, status: 'open' }),
    db.notifications.countDocuments({ user_id: user.id, read_at: null, dismissed: false }),
    db.tickets.countDocuments({ workspace_id: ws, status: { $ne: 'solved' } }),
    db.payments.countDocuments({ workspace_id: ws, status: 'waiting' }),
    announcementsFor(db, user, { modules: modulesFor(workspace) }), // UX-04: the dot on Help
  ]);
  return { inbox, orders, agent, alerts, tickets, payments, whatsNew: news.unread };
}

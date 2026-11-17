import { Router } from 'express';
import { dhakaDayStart } from '../../dashboard/util.js';
import { setting, DEFAULT_SLA } from '../../dashboard/settings.js';

const total = (o) => (o.subtotal ?? 0) + (o.delivery_charge ?? 0) - (o.discount ?? 0);
// The order pipeline as the dashboard names it; older 'confirmed'/'shipped' map onto it.
export const STAGE = { confirmed: 'pending', shipped: 'in_transit' };
export const stageOf = (status) => STAGE[status] ?? status;

// Per-conversation reply stats for a time range: who answered (AI, team or both) and how fast.
async function replyStats(db, ws, from, to) {
  const convIds = await db.conversations.distinct('_id', { workspace_id: ws });
  if (!convIds.length) return [];
  return db.messages.aggregate([
    { $match: { conversation_id: { $in: convIds }, created_at: { $gte: from, $lt: to } } },
    { $sort: { _id: 1 } },
    { $group: {
      _id: '$conversation_id',
      firstIn: { $min: { $cond: [{ $eq: ['$direction', 'in'] }, '$created_at', null] } },
      firstOut: { $min: { $cond: [{ $eq: ['$direction', 'out'] }, '$created_at', null] } },
      firstAiOut: { $min: { $cond: [{ $and: [{ $eq: ['$direction', 'out'] }, '$sent_by_ai'] }, '$created_at', null] } },
      inbound: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, 1, 0] } },
      ai: { $sum: { $cond: [{ $and: [{ $eq: ['$direction', 'out'] }, '$sent_by_ai'] }, 1, 0] } },
      team: { $sum: { $cond: [{ $and: [{ $eq: ['$direction', 'out'] }, { $not: ['$sent_by_ai'] }] }, 1, 0] } },
    } },
    { $match: { inbound: { $gt: 0 } } },
  ]);
}

function summarize(stats) {
  const conversations = stats.length;
  const aiOnly = stats.filter((s) => s.ai > 0 && s.team === 0).length;
  const answered = stats.filter((s) => s.ai > 0 || s.team > 0).length;
  const gaps = stats.filter((s) => s.firstIn && s.firstOut && s.firstOut >= s.firstIn).map((s) => (s.firstOut - s.firstIn) / 1000);
  const teamGaps = stats.filter((s) => s.firstIn && s.firstOut && !s.firstAiOut && s.firstOut >= s.firstIn).map((s) => (s.firstOut - s.firstIn) / 1000);
  const median = (xs) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  return { conversations, aiOnly, answered, firstReplySec: median(gaps), teamFirstReplySec: median(teamGaps) };
}

export function overviewRoutes(db, _config, { auth }) {
  const router = Router();

  router.get('/overview', auth, async (req, res) => {
    const ws = req.user.workspace_id;
    const now = new Date();
    const today = dhakaDayStart(now);
    const yesterday = dhakaDayStart(now, -1);
    const weekAgo = dhakaDayStart(now, -6);
    const workspace = await db.workspaces.findById(ws).lean();
    const sla = { ...DEFAULT_SLA, ...setting(workspace, 'sla', {}) };

    const [statsToday, statsYesterday, statsWeek, ordersToday, waiting, pipelineAgg, delivered7, channels, productCount, users,
      courierCount, unansweredTop, payments, riskyOrders, aiToday, savedToday, recentOrders, recentAudit] = await Promise.all([
      replyStats(db, ws, today, now),
      replyStats(db, ws, yesterday, today),
      replyStats(db, ws, dhakaDayStart(now, -13), weekAgo), // the week before, for "+4 pts this week"
      db.orders.find({ workspace_id: ws, created_at: { $gte: today }, draft: { $ne: true }, status: { $ne: 'cancelled' } }, { subtotal: 1, delivery_charge: 1, discount: 1, source: 1, created_by_user_id: 1 }).lean(),
      db.conversations.find({ workspace_id: ws, status: 'open', spam: { $ne: true }, ai_handoff: true }, { ai_handoff_at: 1 }).lean(),
      db.orders.aggregate([{ $match: { workspace_id: ws, draft: { $ne: true } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      db.orders.countDocuments({ workspace_id: ws, status: 'delivered', updated_at: { $gte: dhakaDayStart(now, -6) } }),
      db.channels.find({ workspace_id: ws }, { platform: 1 }).lean(),
      db.products.countDocuments({ workspace_id: ws, archived: { $ne: true } }),
      db.users.countDocuments({ workspace_id: ws, is_active: true }),
      db.courierAccounts.countDocuments({ workspace_id: ws, connected: true }),
      db.unanswered.find({ workspace_id: ws, status: 'open' }).sort({ count: -1 }).limit(1).lean(),
      db.payments.find({ workspace_id: ws, status: 'waiting' }).sort({ created_at: 1 }).lean(),
      db.orders.find({ workspace_id: ws, status: 'on_hold' }).sort({ created_at: -1 }).limit(2).lean(),
      db.aiReplies.aggregate([{ $match: { workspace_id: ws, created_at: { $gte: today }, kind: { $in: ['reply', 'followup'] } } }, { $group: { _id: null, n: { $sum: 1 }, cost: { $sum: '$cost' } } }]),
      db.aiReplies.countDocuments({ workspace_id: ws, created_at: { $gte: today }, kind: 'saved' }),
      db.orders.find({ workspace_id: ws, draft: { $ne: true } }).sort({ created_at: -1 }).limit(6).lean(),
      db.audit.find({ workspace_id: ws }).sort({ created_at: -1 }).limit(8).lean(),
    ]);

    const t = summarize(statsToday);
    const y = summarize(statsYesterday);
    const lastWeek = summarize(statsWeek);
    const aiPct = t.answered ? Math.round((t.aiOnly / t.answered) * 100) : 0;
    const lastWeekPct = lastWeek.answered ? Math.round((lastWeek.aiOnly / lastWeek.answered) * 100) : null;
    const revenueToday = ordersToday.reduce((s, o) => s + total(o), 0);
    const byAi = ordersToday.filter((o) => o.source === 'ai' || (!o.created_by_user_id && o.source !== 'team')).length;
    const pastTarget = waiting.filter((c) => c.ai_handoff_at && now - c.ai_handoff_at > sla.reply_min * 60_000).length;

    // Messages this week: conversations answered per day, by the AI alone or with the team.
    const week = [];
    for (let i = 6; i >= 0; i -= 1) {
      const from = dhakaDayStart(now, -i);
      const to = i === 0 ? now : dhakaDayStart(now, -i + 1);
      const s = i === 0 ? statsToday : await replyStats(db, ws, from, to);
      week.push({ day: from, ai: s.filter((x) => x.ai > 0 && x.team === 0).length, team: s.filter((x) => x.team > 0).length });
    }

    // Needs attention: the few things a person should look at now.
    const attention = [];
    const actNow = await db.conversations.find({ workspace_id: ws, status: 'open', act_now: true, spam: { $ne: true } }).sort({ ai_handoff_at: 1 }).limit(2).lean();
    const handoffs = await db.conversations.find({ workspace_id: ws, status: 'open', ai_handoff: true, act_now: { $ne: true }, spam: { $ne: true } }).sort({ ai_handoff_at: 1 }).limit(2).lean();
    const contacts = new Map((await db.contacts.find({ _id: { $in: [...actNow, ...handoffs].map((c) => c.contact_id) } }, { name: 1 }).lean()).map((c) => [c._id, c.name]));
    const channelName = new Map((await db.channels.find({ workspace_id: ws }, { platform: 1 }).lean()).map((c) => [c._id, c.platform]));
    for (const c of actNow) {
      attention.push({ kind: 'act_now', id: c._id, title: contacts.get(c.contact_id) ?? 'Customer', reason: c.ai_handoff_reason, platform: channelName.get(c.channel_id), since: c.ai_handoff_at, link: `/inbox/${c._id}` });
    }
    for (const c of handoffs) {
      attention.push({ kind: 'handoff', id: c._id, title: contacts.get(c.contact_id) ?? 'Customer', reason: c.ai_handoff_reason, platform: channelName.get(c.channel_id), since: c.ai_handoff_at, link: `/inbox/${c._id}` });
    }
    if (payments.length) {
      attention.push({ kind: 'payment', count: payments.length, trx: payments.slice(0, 2).map((p) => `${p.trx_id} · ৳${p.amount}`), link: '/payments' });
    }
    for (const o of riskyOrders) {
      attention.push({ kind: 'risk', id: o._id, number: o.number, name: o.customer_name, reason: o.hold_reason, cod: o.cod_amount, area: o.district || '', link: `/orders/${o.number ?? o._id}` });
    }
    if (unansweredTop[0]) attention.push({ kind: 'unanswered', id: unansweredTop[0]._id, question: unansweredTop[0].question, count: unansweredTop[0].count, link: '/agent' });

    const pipeline = { pending: 0, on_hold: 0, approved: 0, processing: 0, ready_to_ship: 0, in_transit: 0 };
    for (const p of pipelineAgg) {
      const s = stageOf(p._id);
      if (s in pipeline) pipeline[s] += p.n;
    }

    const has = (platform) => channels.some((c) => c.platform === platform);
    const checklist = [
      { key: 'channels', done: channels.length > 0, platforms: ['messenger', 'instagram', 'whatsapp'].filter(has) },
      { key: 'business', done: Boolean(workspace.category) },
      { key: 'products', done: productCount > 0, count: productCount },
      { key: 'assistant', done: Boolean(workspace.ai_name) },
      { key: 'payments', done: Boolean(workspace.bkash_number || workspace.nagad_number) },
      { key: 'team', done: users > 1 },
      { key: 'courier', done: courierCount > 0, optional: true },
    ];

    const activity = [
      ...recentOrders.map((o) => ({ at: o.created_at, kind: 'order', tone: o.source === 'ai' ? 'blue' : 'green', number: o.number ?? o._id, name: o.customer_name, amount: total(o), byAi: o.source === 'ai' })),
      ...recentAudit.map((a) => ({ at: a.created_at, kind: 'audit', tone: a.user_id ? 'yellow' : 'green', text: a.actor ? `${a.actor}: ${a.action}` : a.action })),
    ].sort((a, b) => b.at - a.at).slice(0, 7);

    const ai = aiToday[0] ?? { n: 0, cost: 0 };
    const aiRevenue = ordersToday.filter((o) => o.source === 'ai').reduce((s, o) => s + total(o), 0);

    res.json({
      kpis: {
        conversations: t.conversations,
        conversationsChange: y.conversations ? Math.round(((t.conversations - y.conversations) / y.conversations) * 100) : null,
        aiHandled: t.aiOnly,
        ordersToday: ordersToday.length, revenueToday, ordersByAi: byAi,
        aiPct, aiPctChange: lastWeekPct === null ? null : aiPct - lastWeekPct,
        firstReplySec: t.firstReplySec, teamFirstReplySec: t.teamFirstReplySec,
        needsPerson: waiting.length, pastTarget, slaMinutes: sla.reply_min,
      },
      attention: attention.slice(0, 5),
      week,
      pipeline: { ...pipeline, delivered7 },
      checklist,
      activity,
      spend: { aiReplies: ai.n, aiCost: ai.cost, savedReplies: savedToday, revenuePerTaka: ai.cost > 0 ? Math.round(aiRevenue / ai.cost) : null },
    });
  });

  return router;
}

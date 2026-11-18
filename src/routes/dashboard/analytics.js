import { Router } from 'express';
import { dhakaDayStart, csv } from '../../dashboard/util.js';
import { orderTotal } from '../../dashboard/orderOps.js';
import { replyStats, summarize } from './overview.js';

const RANGES = [7, 30, 90];
const DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri']; // the Bangladeshi week starts on Saturday
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

// Screen 09: what the AI handled, what it earned, and where orders slip away (ANL-02..08).
export async function analytics(db, wsId, range, now = new Date()) {
  const from = dhakaDayStart(now, -(range - 1));
  const prevFrom = dhakaDayStart(now, -(2 * range - 1));
  const base = { workspace_id: wsId, draft: { $ne: true } };
  const fields = { subtotal: 1, delivery_charge: 1, discount: 1, source: 1, created_by_user_id: 1, taken_by: 1, status: 1, cancel_reason: 1, courier: 1, advance: 1, product_items: 1 };

  const [orders, prevOrders, users, aiSpend, stats, heat, interested] = await Promise.all([
    db.orders.find({ ...base, created_at: { $gte: from } }, fields).lean(),
    db.orders.find({ ...base, created_at: { $gte: prevFrom, $lt: from }, status: { $ne: 'cancelled' } }, { subtotal: 1, delivery_charge: 1, discount: 1 }).lean(),
    db.users.find({ workspace_id: wsId }, { name: 1 }).lean(),
    db.aiReplies.aggregate([{ $match: { workspace_id: wsId, created_at: { $gte: from }, kind: { $in: ['reply', 'followup'] } } }, { $group: { _id: null, cost: { $sum: '$cost' } } }]),
    replyStats(db, wsId, from, now),
    messageHeat(db, wsId, from),
    db.prospects.countDocuments({ workspace_id: wsId, stage: { $ne: 'won' }, created_at: { $gte: from } }),
  ]);

  const live = orders.filter((o) => o.status !== 'cancelled');
  const revenue = live.reduce((s, o) => s + orderTotal(o), 0);
  const prevRevenue = prevOrders.reduce((s, o) => s + orderTotal(o), 0);
  const isAi = (o) => o.source === 'ai';
  const aiRevenue = live.filter(isAi).reduce((s, o) => s + orderTotal(o), 0);
  const spend = aiSpend[0]?.cost ?? 0;
  const s = summarize(stats);
  const finished = (list) => list.filter((o) => o.status === 'delivered' || o.status === 'returned');
  const deliveredRate = (list) => pct(list.filter((o) => o.status === 'delivered').length, finished(list).length);

  // Who took the orders: the AI, the product page / website, then each teammate.
  const names = new Map(users.map((u) => [u._id, u.name]));
  const groups = new Map();
  for (const o of live) {
    let key;
    let label;
    if (isAi(o)) { key = 'ai'; label = ''; } else if (o.source === 'product_page' || o.source === 'website') { key = o.source; label = ''; } else {
      // Older orders only carry the teammate's name, newer ones their id; group by the resolved name.
      label = names.get(o.created_by_user_id) ?? (o.taken_by && o.taken_by !== 'team' ? o.taken_by : '');
      key = `u${label.toLowerCase()}`;
    }
    const g = groups.get(key) ?? { key: key.startsWith('u') ? 'user' : key, name: label, list: [] };
    g.list.push(o);
    groups.set(key, g);
  }
  const who = [...groups.values()].map((g) => ({ key: g.key, name: g.name, orders: g.list.length, revenue: g.list.reduce((a, o) => a + orderTotal(o), 0), deliveredRate: deliveredRate(g.list) }))
    .sort((a, b) => b.orders - a.orders || b.revenue - a.revenue || `${a.key}${a.name}`.localeCompare(`${b.key}${b.name}`));

  const cancelled = orders.filter((o) => o.status === 'cancelled');
  const reasons = new Map();
  for (const o of cancelled) reasons.set(o.cancel_reason || 'other', (reasons.get(o.cancel_reason || 'other') ?? 0) + 1);

  const couriers = new Map();
  for (const o of live.filter((x) => x.courier)) {
    const key = o.courier.toLowerCase();
    const c = couriers.get(key) ?? { courier: key, list: [] };
    c.list.push(o);
    couriers.set(key, c);
  }

  const sellers = new Map();
  for (const o of live) {
    for (const item of o.product_items ?? []) {
      const key = item.product_id ?? item.name;
      const x = sellers.get(key) ?? { name: item.name, units: 0, revenue: 0 };
      x.units += item.qty ?? 1;
      x.revenue += (item.price ?? 0) * (item.qty ?? 1);
      sellers.set(key, x);
    }
  }

  const totalIn = heat.reduce((a, c) => a + c.n, 0);
  const lateNight = heat.filter((c) => c.hour >= 21 || c.hour < 1).reduce((a, c) => a + c.n, 0);
  const grid = DAYS.map(() => Array(24).fill(0));
  for (const c of heat) grid[(c.dow % 7)][c.hour] += c.n; // Mongo: 1 = Sunday … 7 = Saturday → Sat row 0

  return {
    range, from,
    kpis: {
      revenue, revenueChange: prevRevenue > 0 ? pct(revenue - prevRevenue, prevRevenue) : null,
      orders: live.length, ordersByAi: live.filter(isAi).length,
      aiOnly: s.aiOnly, conversations: s.conversations, aiOnlyPct: pct(s.aiOnly, s.conversations),
      revenuePerTaka: spend > 0 ? Math.round(aiRevenue / spend) : null, aiSpend: Math.round(spend * 100) / 100,
      firstReplySec: s.firstReplySec, teamFirstReplySec: s.teamFirstReplySec,
      deliveredPct: deliveredRate(live), returnsPct: pct(live.filter((o) => o.status === 'returned').length, live.length),
    },
    who,
    cancelled: { total: cancelled.length, reasons: [...reasons].map(([reason, n]) => ({ reason, n, pct: pct(n, cancelled.length) })).sort((a, b) => b.n - a.n || a.reason.localeCompare(b.reason)) },
    heat: { grid, max: Math.max(0, ...grid.flat()), total: totalIn, lateNightPct: pct(lateNight, totalIn) },
    couriers: [...couriers.values()].map((c) => ({
      courier: c.courier, booked: c.list.length, deliveredRate: deliveredRate(c.list),
      cod: c.list.filter((o) => o.status === 'delivered').reduce((a, o) => a + Math.max(0, orderTotal(o) - (o.advance?.verified ? o.advance.amount ?? 0 : 0)), 0),
    })).sort((a, b) => b.booked - a.booked),
    bestSellers: [...sellers.values()].sort((a, b) => b.units - a.units).slice(0, 5),
    interested,
  };
}

// Customer messages by Dhaka weekday and hour (ANL-04).
async function messageHeat(db, wsId, from) {
  const convIds = await db.conversations.distinct('_id', { workspace_id: wsId });
  if (!convIds.length) return [];
  const rows = await db.messages.aggregate([
    { $match: { conversation_id: { $in: convIds }, direction: 'in', created_at: { $gte: from } } },
    { $group: { _id: { dow: { $dayOfWeek: { date: '$created_at', timezone: 'Asia/Dhaka' } }, hour: { $hour: { date: '$created_at', timezone: 'Asia/Dhaka' } } }, n: { $sum: 1 } } },
  ]);
  return rows.map((r) => ({ dow: r._id.dow, hour: r._id.hour, n: r.n }));
}

export function analyticsRoutes(db, _config, { auth }) {
  const router = Router();
  const rangeOf = (req) => (RANGES.includes(Number(req.query.range)) ? Number(req.query.range) : 30);

  router.get('/analytics', auth, async (req, res) => {
    res.json(await analytics(db, req.user.workspace_id, rangeOf(req)));
  });

  router.get('/analytics.csv', auth, async (req, res) => {
    const a = await analytics(db, req.user.workspace_id, rangeOf(req));
    const k = a.kpis;
    const rows = [
      ['section', 'item', 'value', 'extra'],
      ['summary', 'revenue', k.revenue, k.revenueChange === null ? '' : `${k.revenueChange}% vs previous ${a.range} days`],
      ['summary', 'orders', k.orders, `${k.ordersByAi} by AI`],
      ['summary', 'handled by AI alone', k.aiOnlyPct ?? '', `${k.aiOnly} of ${k.conversations} chats`],
      ['summary', 'revenue per 1 taka of AI', k.revenuePerTaka ?? '', `AI spend ${k.aiSpend}`],
      ['summary', 'first reply (seconds)', k.firstReplySec === null ? '' : Math.round(k.firstReplySec), k.teamFirstReplySec === null ? '' : `team ${Math.round(k.teamFirstReplySec)}`],
      ['summary', 'delivered %', k.deliveredPct ?? '', `returns ${k.returnsPct ?? ''}%`],
      ...a.who.map((w) => ['who took the orders', w.key === 'user' ? w.name : w.key, w.orders, `revenue ${w.revenue}; delivered ${w.deliveredRate ?? ''}%`]),
      ...a.cancelled.reasons.map((r) => ['cancel reasons', r.reason, r.n, `${r.pct}%`]),
      ...a.couriers.map((c) => ['couriers', c.courier, c.booked, `delivered ${c.deliveredRate ?? ''}%; COD ${c.cod}`]),
      ...a.bestSellers.map((b) => ['best sellers', b.name, b.units, `revenue ${b.revenue}`]),
      ...a.heat.grid.flatMap((row, d) => row.map((n, h) => ['messages by hour', `${DAYS[d]} ${String(h).padStart(2, '0')}:00`, n, ''])),
    ];
    res.type('text/csv').set('Content-Disposition', `attachment; filename="heyquicky-analytics-${a.range}d.csv"`).send(`﻿${csv(rows)}`);
  });

  return router;
}

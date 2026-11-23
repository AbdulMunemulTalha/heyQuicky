import { InboxError } from '../inbox.js';
import { grantOffer } from './offers.js';
import { fireEvent } from './webhooks.js';

// FUP-05 · Lead pipeline (won / lost with reasons, per teammate) and FUP-08 · "Win them back" for people
// who keep asking but don't buy (frames "Lead pipeline" and "Asked but didn't order").

export const STAGES = ['new', 'contacted', 'call_scheduled', 'won', 'lost'];
export const LOST_REASONS = ['price', 'bought_elsewhere', 'no_reply', 'size', 'delivery_charge', 'cod', 'changed_mind', 'other'];
const DAY = 86_400_000;
const LOST_AFTER_DAYS = 14;

// Why a customer stopped, read from what they said last (newest last). Short English for the team.
export function whyStopped(texts) {
  const all = texts.join(' \n ').toLowerCase();
  const last = (texts.at(-1) ?? '').toLowerCase();
  if (/(discount|ছাড়|offer|অফার|kom|কম|beshi dam|বেশি দাম|expensive|dam beshi)/.test(all)) return 'Price — asked for a discount';
  if (/(sold out|stock nai|স্টক নাই|শেষ|nai\b|নাই)/.test(all) && /(size|সাইজ|xl|xxl|\bl\b|\bm\b)/.test(all)) return 'Size not available';
  if (/(cash on delivery|cod|ক্যাশ অন)/.test(all) && /(outside|বাইরে|chittagong|চট্টগ্রাম|sylhet|সিলেট)/.test(all)) return 'Wanted cash on delivery outside Dhaka';
  if (/(delivery charge|ডেলিভারি চার্জ|delivery koto|ডেলিভারি কত)/.test(all)) return 'Stopped replying after the delivery charge';
  if (/(colou?r|রং|রঙ)/.test(last)) return 'Asked about colour, no reply';
  if (/(dam koto|দাম কত|price|koto)/.test(all)) return 'Asked the price, then went quiet';
  return 'Just browsing';
}

// When a customer orders, their open lead is won (by whoever took the order: the AI, the page or a teammate).
export async function markLeadWon(db, order) {
  if (!order?.customer_id) return;
  const ownerId = typeof order.taken_by === 'number' ? order.taken_by : order.created_by_user_id ?? null;
  const where = { workspace_id: order.workspace_id, customer_id: order.customer_id, stage: { $in: ['new', 'contacted', 'call_scheduled', 'lost'] } };
  const open = await db.prospects.find(where, { name: 1, product: 1 }).lean();
  if (!open.length) return;
  const wonBy = order.source === 'ai' ? 'ai' : order.source === 'product_page' ? 'page' : 'team';
  const amount = (order.subtotal ?? 0) - (order.discount ?? 0);
  await db.prospects.updateMany(where, {
    $set: { stage: 'won', order_id: order._id, outcome: 'ordered', won_at: new Date(), won_by: wonBy, amount, ...(ownerId ? { owner_user_id: ownerId } : {}) },
  });
  // INT-04: tell the shop's webhooks.
  for (const p of open) fireEvent(db, order.workspace_id, 'lead.won', { name: p.name, product: p.product, amount, order_number: order.number ?? null, won_by: wonBy }).catch(() => {});
}

// Leads that went quiet for two weeks are lost ("No reply"), unless someone is due to call them.
export async function closeQuietLeads(db, now = new Date()) {
  const r = await db.prospects.updateMany({ stage: { $in: ['new', 'contacted'] }, last_seen_at: { $lt: new Date(now.getTime() - LOST_AFTER_DAYS * DAY) } }, { $set: { stage: 'lost', lost_reason: 'no_reply', lost_at: now } });
  return r.modifiedCount ?? 0;
}

const since = (period, now = new Date()) => {
  if (period === 'week') return new Date(now.getTime() - 7 * DAY);
  if (period === 'all') return new Date(0);
  return new Date(now.getTime() - 30 * DAY);
};

// The board: five columns with counts and value, the numbers on top, and the best closer.
export async function pipeline(db, wsId, { period = 'month', agentId = null, now = new Date() } = {}) {
  const from = since(period, now);
  const where = { workspace_id: wsId, created_at: { $gte: from }, ...(agentId ? { owner_user_id: agentId } : {}) };
  const all = await db.prospects.find(where).sort({ last_seen_at: -1 }).limit(2000).lean();
  const users = new Map((await db.users.find({ _id: { $in: [...new Set(all.map((p) => p.owner_user_id).filter(Boolean))] } }, { name: 1 }).lean()).map((u) => [u._id, u.name]));
  const columns = Object.fromEntries(STAGES.map((s) => [s, { count: 0, value: 0, items: [] }]));
  for (const p of all) {
    const c = columns[p.stage] ?? columns.new;
    c.count += 1;
    c.value += p.amount ?? 0;
    if (c.items.length < 40) c.items.push(p);
  }
  const won = columns.won.count;
  const lost = columns.lost.count;
  const reasons = {};
  for (const p of all.filter((x) => x.stage === 'lost')) reasons[p.lost_reason || 'other'] = (reasons[p.lost_reason || 'other'] ?? 0) + 1;
  const topLost = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  // Best closer: highest win rate among teammates with at least 3 decided leads.
  const per = new Map();
  for (const p of all.filter((x) => (x.stage === 'won' || x.stage === 'lost') && x.owner_user_id)) {
    const r = per.get(p.owner_user_id) ?? { won: 0, decided: 0 };
    r.decided += 1;
    if (p.stage === 'won') r.won += 1;
    per.set(p.owner_user_id, r);
  }
  const closers = [...per.entries()].filter(([, r]) => r.decided >= 3).map(([id, r]) => ({ id, name: users.get(id) ?? '', rate: Math.round((r.won / r.decided) * 100), won: r.won, decided: r.decided })).sort((a, b) => b.rate - a.rate || b.won - a.won);
  return {
    kpis: { newCount: all.length, won, wonPct: all.length ? Math.round((won / all.length) * 100) : 0, lost, topLost, bestCloser: closers[0] ?? null },
    closers, users, columns,
  };
}

const OFFER_TEXT = {
  free_delivery: () => 'ডেলিভারি ফ্রি',
  percent: (v) => `${v}% ছাড়`,
  amount: (v) => `৳${Number(v).toLocaleString('en-IN')} ছাড়`,
};
export function winBackMessage({ product = '', kind, value, hours }) {
  const until = hours <= 24 ? (hours <= 12 ? `পরের ${hours} ঘণ্টার মধ্যে` : 'আজ রাত ১২টার মধ্যে') : `পরের ${Math.round(hours / 24)} দিনের মধ্যে`;
  return `আপু, ${product ? `${product} টা` : 'যেটা দেখছিলেন সেটা'} এখনো আছে 😊 ${until} নিলে ${OFFER_TEXT[kind](value)}! অর্ডার করবেন?`;
}

// FUP-08 · Win them back: a time-limited offer recorded for each person (the AI honours it until it ends),
// and the product sent again now to those inside Meta's 24-hour window. Others get it when they write next.
export async function winBack(db, inbox, wsId, { ids, kind = 'free_delivery', value = 0, hours = 24, by = 'team', now = new Date() }) {
  if (!['free_delivery', 'percent', 'amount'].includes(kind)) throw new InboxError(400, 'Pick an offer');
  if (kind === 'percent' && !(value >= 1 && value <= 50)) throw new InboxError(400, 'A percent offer is 1 to 50%');
  if (kind === 'amount' && !(value >= 10 && value <= 5000)) throw new InboxError(400, 'A taka offer is ৳10 to ৳5,000');
  if (![6, 12, 24, 48, 72].includes(hours)) throw new InboxError(400, 'Pick how long the offer lasts');
  const list = await db.prospects.find({ _id: { $in: (ids ?? []).map(Number) }, workspace_id: wsId, stage: { $ne: 'won' } }).lean();
  if (!list.length) throw new InboxError(400, 'Select people first');
  const endsAt = new Date(now.getTime() + hours * 3_600_000);
  const out = { sent: 0, later: 0, skipped: 0 };
  for (const p of list) {
    if (!p.customer_id) { out.skipped += 1; continue; }
    await grantOffer(db, { workspaceId: wsId, customerId: p.customer_id, conversationId: p.conversation_id, source: 'winback', sourceId: p._id, kind, value: kind === 'free_delivery' ? 0 : value, endsAt });
    // Promotional, so only inside Meta's 24-hour window (never with the human-agent tag).
    const conv = p.conversation_id ? await db.conversations.findById(p.conversation_id, { last_inbound_at: 1 }).lean() : null;
    const inWindow = conv?.last_inbound_at && now - new Date(conv.last_inbound_at) < 24 * 3_600_000 - 5 * 60_000;
    const message = inWindow ? await inbox.sendAiReply(p.conversation_id, winBackMessage({ product: p.product, kind, value, hours })).catch(() => null) : null;
    if (message) {
      await db.messages.updateOne({ _id: message.id }, { $set: { kind: 'followup' } });
      out.sent += 1;
    } else out.later += 1;
    await db.prospects.updateOne({ _id: p._id }, { $set: { winback_at: now, winback_by: by, ...(p.stage === 'lost' ? { stage: 'contacted' } : {}) } });
  }
  return out;
}

export function winBackSettings(ws) {
  const w = ws?.settings?.winback ?? {};
  return { auto: Boolean(w.auto), kind: ['free_delivery', 'percent', 'amount'].includes(w.kind) ? w.kind : 'free_delivery', value: Number(w.value) || 0, hours: [6, 12, 24, 48, 72].includes(w.hours) ? w.hours : 24, minAsked: 3 };
}

// Automatic win-back: people who asked 3+ times without buying, once a month at most, inside the window.
export async function autoWinBack(db, inbox, now = new Date()) {
  let sent = 0;
  const shops = await db.workspaces.find({ 'settings.winback.auto': true }, { settings: 1 }).lean();
  for (const ws of shops) {
    const s = winBackSettings(ws);
    const due = await db.prospects.find({ workspace_id: ws._id, stage: { $in: ['new', 'contacted', 'lost'] }, times_asked: { $gte: s.minAsked }, last_seen_at: { $gte: new Date(now.getTime() - 22 * 3_600_000) },
      $or: [{ winback_at: null }, { winback_at: { $exists: false } }, { winback_at: { $lt: new Date(now.getTime() - 30 * DAY) } }] }, { _id: 1 }).limit(50).lean();
    if (!due.length) continue;
    sent += (await winBack(db, inbox, ws._id, { ids: due.map((p) => p._id), kind: s.kind, value: s.value, hours: s.hours, by: 'auto', now })).sent;
  }
  return sent;
}

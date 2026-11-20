import { riskFor } from './risk.js';

// Tags & segments (CRM-03/04): automatic tags worked out from each customer's history, and saved
// segments — groups of customers matching every condition — for broadcasts, coupons and tagging.

export const BIG_SPENDER = 10_000;

// Tags the AI adds from what customers say in chat (stored on customer.ai_tags).
export const AI_TAGS = { asked_discount: 'Asked for discount', gift_buyer: 'Gift buyer', wholesale: 'Wholesale enquiry' };

// Delivery success: delivered ÷ (delivered + returned). Null with no finished orders.
export const deliveryRate = (c) => {
  const d = c.stats?.delivered ?? 0; const r = c.stats?.returned ?? 0;
  return d + r ? Math.round((d / (d + r)) * 100) : null;
};

// Automatic tags: never stored, always up to date.
export const AUTO_TAGS = {
  vip: { label: 'VIP', where: { vip: true } },
  repeat: { label: 'Repeat buyer', where: { 'stats.orders': { $gte: 2 } } },
  first: { label: 'First order', where: { 'stats.orders': 1 } },
  big_spender: { label: 'Big spender', where: { 'stats.spent': { $gte: BIG_SPENDER } } },
  returned: { label: 'Returned before', where: { 'stats.returned': { $gte: 1 } } },
  high_risk: { label: 'High COD risk', risk: 'high' },
};

// The fields a segment condition can use, and the operators each allows.
export const FIELDS = {
  orders: { ops: ['gte', 'lte', 'eq'], type: 'number', path: 'stats.orders' },
  spent: { ops: ['gte', 'lte'], type: 'number', path: 'stats.spent' },
  returned: { ops: ['gte', 'lte', 'eq'], type: 'number', path: 'stats.returned' },
  active_days: { ops: ['lte', 'gte'], type: 'number' }, // last active within / more than N days ago
  tag: { ops: ['has', 'not'], type: 'text' },
  vip: { ops: ['is'], type: 'bool' },
  risk: { ops: ['is', 'not'], type: 'risk' },
  area: { ops: ['has'], type: 'text' },
  delivery_rate: { ops: ['gte', 'lte'], type: 'number' },
};

export const riskOf = (c) => c.risk?.level ? c.risk : riskFor({ delivered: c.stats?.delivered, returned: c.stats?.returned, cancelled: c.stats?.cancelled,
  courierRate: c.courier_check?.rate ?? null, courierTotal: c.courier_check?.total ?? 0 });

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Validates conditions from the client. Throws a message for the first bad one.
export function cleanConditions(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('Add at least one condition');
  if (list.length > 8) throw new Error('Up to 8 conditions');
  return list.map((c) => {
    const f = FIELDS[c?.field];
    if (!f) throw new Error('Unknown condition');
    if (!f.ops.includes(c.op)) throw new Error(`"${c.op}" doesn't work with ${c.field}`);
    let value = c.value;
    if (f.type === 'number') { value = Number(value); if (!Number.isFinite(value) || value < 0 || value > 10_000_000 || (c.field === 'delivery_rate' && value > 100)) throw new Error(`Enter a number for ${c.field}`); }
    if (f.type === 'text') { value = String(value ?? '').trim().slice(0, 60); if (!value) throw new Error(`Enter a value for ${c.field}`); }
    if (f.type === 'bool') value = value === true || value === 'true';
    if (f.type === 'risk' && !['low', 'medium', 'high'].includes(value)) throw new Error('Pick a risk level');
    return { field: c.field, op: c.op, value };
  });
}

// A MongoDB filter for everything except COD risk (worked out in code afterwards).
function toQuery(workspaceId, conditions, now = new Date()) {
  const and = [{ workspace_id: workspaceId }, { blocked: { $ne: true } }];
  for (const c of conditions) {
    const f = FIELDS[c.field];
    if (f.path) and.push({ [f.path]: c.op === 'gte' ? { $gte: c.value } : c.op === 'lte' ? { $lte: c.value } : c.value });
    if (c.field === 'active_days') {
      const at = new Date(now.getTime() - c.value * 86_400_000);
      and.push(c.op === 'lte' ? { last_active_at: { $gte: at } } : { $or: [{ last_active_at: { $lt: at } }, { last_active_at: null }] });
    }
    if (c.field === 'tag') {
      const rx = new RegExp(`^${esc(c.value)}$`, 'i');
      const auto = Object.entries(AUTO_TAGS).find(([k, t]) => k === c.value || t.label.toLowerCase() === c.value.toLowerCase());
      if (auto && auto[1].where) and.push(c.op === 'has' ? auto[1].where : { $nor: [auto[1].where] });
      else if (!auto) and.push(c.op === 'has' ? { $or: [{ tags: rx }, { ai_tags: rx }] } : { tags: { $not: rx }, ai_tags: { $not: rx } });
    }
    if (c.field === 'vip') and.push(c.value ? { $or: [{ vip: true }, { tags: 'VIP' }] } : { vip: { $ne: true }, tags: { $ne: 'VIP' } });
    if (c.field === 'area') and.push({ $or: [{ area: new RegExp(esc(c.value), 'i') }, { address: new RegExp(esc(c.value), 'i') }] });
  }
  return { $and: and };
}

function riskPass(conditions) {
  const rules = conditions.filter((c) => c.field === 'risk' || c.field === 'delivery_rate' || (c.field === 'tag' && (c.value === 'high_risk' || /^high cod risk$/i.test(c.value))));
  if (!rules.length) return null;
  return (cust) => rules.every((c) => {
    if (c.field === 'delivery_rate') {
      const rate = deliveryRate(cust);
      return rate != null && (c.op === 'gte' ? rate >= c.value : rate <= c.value);
    }
    const level = riskOf(cust).level;
    if (c.field === 'risk') return c.op === 'is' ? level === c.value : level !== c.value;
    return c.op === 'has' ? level === 'high' : level !== 'high';
  });
}

// Customers in a segment: { ids, count }. Risk is checked per customer, so those are loaded.
export async function segmentMembers(db, workspaceId, conditions, { limit = 20_000 } = {}) {
  const q = toQuery(workspaceId, conditions);
  const pass = riskPass(conditions);
  const docs = await db.customers.find(q, pass ? { stats: 1, courier_check: 1, risk: 1 } : { _id: 1 }).limit(limit).lean();
  // (delivery success and COD risk are worked out per customer)
  const ids = (pass ? docs.filter(pass) : docs).map((c) => c._id);
  return { ids, count: ids.length };
}

export async function inSegment(db, segment, customerId) {
  if (!segment || !customerId) return false;
  const q = toQuery(segment.workspace_id, segment.conditions);
  q.$and.push({ _id: customerId });
  const c = await db.customers.findOne(q, { stats: 1, courier_check: 1, risk: 1 }).lean();
  const pass = riskPass(segment.conditions);
  return Boolean(c && (!pass || pass(c)));
}

// What to do with a customer, shown beside them in a segment (frame CRM-03/04 "Suggested").
export function suggestedAction(c, { advance = null, coupon = null } = {}) {
  const risk = riskOf(c).level;
  if (risk === 'high') return { key: 'ask_advance', amount: advance };
  if (risk === 'medium') return { key: 'call_first' };
  if (c.vip || (c.stats?.spent ?? 0) >= BIG_SPENDER) return coupon ? { key: 'send_coupon', code: coupon } : { key: 'early_access' };
  if ((c.stats?.orders ?? 0) >= 2 && (c.last_active_at && Date.now() - new Date(c.last_active_at) > 60 * 86_400_000)) return { key: 'win_back' };
  return null;
}

// Counts for every automatic tag.
export async function autoTagCounts(db, workspaceId) {
  const base = { workspace_id: workspaceId, blocked: { $ne: true } };
  const out = {};
  for (const [key, t] of Object.entries(AUTO_TAGS)) {
    if (t.where) out[key] = await db.customers.countDocuments({ ...base, ...t.where });
  }
  const all = await db.customers.find(base, { stats: 1, courier_check: 1, risk: 1 }).limit(20_000).lean();
  out.high_risk = all.filter((c) => riskOf(c).level === 'high').length;
  return out;
}

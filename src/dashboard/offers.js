// FUP-07 · Offer-aware AI. Every offer a customer receives — the follow-up discount, a coupon code in a
// broadcast, the thank-you coupon after a good review — is recorded for that customer with its end time.
// The AI is told which offers this customer has (and which ended), personal discounts are applied to their
// next order automatically, and campaign codes work only for the people they were sent to.

const DHAKA_MS = 6 * 3_600_000;
const DAY = 86_400_000;
const taka = (n) => `৳${Number(n).toLocaleString('en-IN')}`;

// The end of today in Dhaka (23:59:59.999 Asia/Dhaka), as a UTC Date.
export function dhakaMidnight(now = new Date()) {
  const local = new Date(now.getTime() + DHAKA_MS);
  const end = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1) - 1;
  return new Date(end - DHAKA_MS);
}

export function offerText(o) {
  const what = o.kind === 'percent' ? `${o.value}% off` : o.kind === 'amount' ? `${taka(o.value)} off` : 'free delivery';
  return `${what}${o.min_order ? ` on orders over ${taka(o.min_order)}` : ''}`;
}

const SOURCE = { followup: 'follow-up reminder', broadcast: 'broadcast', review: 'thank-you after a review', winback: 'win-back message' };

// Gives (or extends) an offer. One live offer per customer, source and code.
export async function grantOffer(db, { workspaceId, customerId, conversationId = null, source, sourceId = null, code = '', kind, value = 0, minOrder = 0, endsAt }) {
  if (!customerId || !endsAt) return null;
  const now = new Date();
  const same = await db.offers.findOne({ workspace_id: workspaceId, customer_id: customerId, source, code, used_at: null, ends_at: { $gt: now } }).lean();
  if (same) {
    if (endsAt > same.ends_at) await db.offers.updateOne({ _id: same._id }, { $set: { ends_at: endsAt, kind, value, min_order: minOrder } });
    return same._id;
  }
  return (await db.insert(db.offers, { workspace_id: workspaceId, customer_id: customerId, conversation_id: conversationId, source, source_id: sourceId, code, kind, value, min_order: minOrder, ends_at: endsAt })).id;
}

// Coupon codes written in a message (whole words, any case).
export function codesInText(text, coupons) {
  const words = new Set(String(text ?? '').toUpperCase().split(/[^A-Z0-9_-]+/).filter(Boolean));
  return coupons.filter((c) => c.code && words.has(String(c.code).toUpperCase()));
}

export const couponOffer = (c) => ({ code: c.code, kind: c.type === 'percent' ? 'percent' : c.type === 'free_delivery' ? 'free_delivery' : 'amount', value: c.value ?? 0, minOrder: c.min_order ?? 0 });

// What this customer has now, and what ended or was used in the last few days (so the AI can explain).
export async function offersFor(db, customerId, now = new Date()) {
  if (!customerId) return { active: [], ended: [] };
  const list = await db.offers.find({ customer_id: customerId, ends_at: { $gt: new Date(now - 3 * DAY) } }).sort({ ends_at: 1 }).limit(20).lean();
  return {
    active: list.filter((o) => !o.used_at && o.ends_at > now),
    ended: list.filter((o) => o.used_at || o.ends_at <= now),
  };
}

// The personal discount (no code) to put on this customer's next order, if any.
export async function personalOffer(db, customerId, now = new Date()) {
  if (!customerId) return null;
  return db.offers.findOne({ customer_id: customerId, code: '', used_at: null, ends_at: { $gt: now } }).sort({ value: -1 }).lean();
}

// How much an offer takes off. Returns { discount, freeDelivery } or null when the order is too small.
export function offerDiscount(o, subtotal) {
  if (!o || subtotal < (o.min_order ?? 0)) return null;
  if (o.kind === 'free_delivery') return { discount: 0, freeDelivery: true };
  const discount = o.kind === 'percent' ? Math.round((subtotal * o.value) / 100) : Math.min(o.value, subtotal);
  return { discount, freeDelivery: false };
}

// Campaign codes (sent in a broadcast or after a review) work only for people they were sent to — once the
// shop has sent them through HeyQuicky. Codes never sent that way keep working for whoever has them.
export async function campaignProblem(db, workspaceId, coupon, customer, now = new Date()) {
  if (!['broadcast', 'after_review'].includes(coupon.audience)) return null;
  if (!(await db.offers.exists({ workspace_id: workspaceId, code: coupon.code }))) return null;
  const mine = customer?._id ? await db.offers.findOne({ workspace_id: workspaceId, customer_id: customer._id, code: coupon.code }).lean() : null;
  if (!mine) return `${coupon.code} was sent to selected customers only`;
  if (mine.ends_at <= now && !mine.used_at) return `${coupon.code} has expired for this customer`;
  return null;
}

// Lines for the AI (FUP-07): what to honour, and what not to.
export function offersContext({ active = [], ended = [] }, now = new Date()) {
  if (!active.length && !ended.length) return '';
  const when = (d) => {
    const local = new Date(d.getTime() + DHAKA_MS);
    const hh = String(local.getUTCHours()).padStart(2, '0');
    const mm = String(local.getUTCMinutes()).padStart(2, '0');
    const sameDay = dhakaMidnight(now).getTime() === dhakaMidnight(d).getTime();
    return sameDay ? `today ${hh}:${mm}` : `${local.getUTCDate()}/${local.getUTCMonth() + 1} ${hh}:${mm}`;
  };
  const lines = ['## Offers for this customer'];
  for (const o of active) {
    lines.push(`- ${offerText(o)} from the ${SOURCE[o.source]}, valid until ${when(o.ends_at)} (Dhaka time)${o.code ? ` — code ${o.code}: put it in order.coupon when they order` : ' — applied to their next order automatically, no code needed'}.`);
  }
  for (const o of ended) {
    lines.push(`- ENDED: ${offerText(o)} from the ${SOURCE[o.source]}${o.code ? ` (code ${o.code})` : ''} — ${o.used_at ? 'already used on an order' : `ended ${when(o.ends_at)}`}. Don't honour it; politely say it has ended.`);
  }
  lines.push('Only these offers apply to this customer. Never give an offer that is not listed here or under "Coupons".');
  return lines.join('\n');
}

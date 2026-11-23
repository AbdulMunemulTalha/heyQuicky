import { randomBytes } from 'node:crypto';
import { InboxError } from '../inbox.js';
import { cleanCustomer, zonesFor } from './orderBuild.js';
import { saveOrder } from './aiOrder.js';
import { changeStatus } from './orderOps.js';

// ORD-04 · Product page checkout: every product the shop sells everywhere gets an instant page,
// /p/<shop>/<product>, with Buy now → form → confirm. No website needed. When the link was sent in a
// chat it carries that chat's token (?c=…), so the order joins the chat and the bill goes back there.

export function slugify(name) {
  return String(name ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
}

// The shop's name in links, made once and kept (links already sent must keep working).
export async function ensureShopSlug(db, ws) {
  if (ws.shop_slug) return ws.shop_slug;
  const base = slugify(ws.name) || 'shop';
  for (let i = 1; i <= 30; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    if (await db.workspaces.exists({ shop_slug: slug })) continue;
    try {
      const r = await db.workspaces.updateOne({ _id: ws._id, shop_slug: null }, { $set: { shop_slug: slug } });
      if (r.modifiedCount) return slug;
      return (await db.workspaces.findById(ws._id, { shop_slug: 1 }).lean()).shop_slug;
    } catch (err) {
      if (err.code !== 11000) throw err; // someone took it a moment ago; try the next one
    }
  }
  const slug = `shop-${ws._id}`;
  await db.workspaces.updateOne({ _id: ws._id, shop_slug: null }, { $set: { shop_slug: slug } });
  return slug;
}

export async function chatPageToken(db, conversationId) {
  const conv = await db.conversations.findById(conversationId, { page_token: 1 }).lean();
  if (!conv) return null;
  if (conv.page_token) return conv.page_token;
  const token = randomBytes(9).toString('base64url');
  await db.conversations.updateOne({ _id: conversationId, page_token: null }, { $set: { page_token: token } });
  return (await db.conversations.findById(conversationId, { page_token: 1 }).lean()).page_token;
}

export const onPage = (p) => Boolean(p) && !p.archived && (p.visibility ?? 'everywhere') === 'everywhere';

export function productPageUrl(base, slug, productId, chatToken = null) {
  if (!base || !slug) return '';
  return `${base.replace(/\/+$/, '')}/p/${slug}/${productId}${chatToken ? `?c=${encodeURIComponent(chatToken)}` : ''}`;
}

// A function product cards use to add "Buy now" links (for one chat, or none).
export async function pageLinker(db, workspaceId, base, conversationId = null) {
  if (!base) return null;
  const ws = await db.workspaces.findById(workspaceId, { name: 1, shop_slug: 1 }).lean();
  if (!ws) return null;
  const slug = await ensureShopSlug(db, ws);
  const token = conversationId ? await chatPageToken(db, conversationId) : null;
  return (p) => (onPage(p) ? productPageUrl(base, slug, p._id, token) : '');
}

const ZONES = ['inside_dhaka', 'dhaka_suburbs', 'outside_dhaka'];

// The order from the checkout form. The form is the customer's confirmation, so the order is approved
// straight away unless risk or the shop's advance rules put it on hold.
export async function placePageOrder(db, { ws, product, body, conversation = null, notify = null }) {
  const who = cleanCustomer(body);
  const zone = String(body?.zone ?? '');
  if (!ZONES.includes(zone) || !zonesFor(ws).some((z) => z.key === zone)) throw new InboxError(400, 'Pick where to deliver');
  const qty = Number.parseInt(body?.qty, 10) || 1;
  const sku = (product.variant_list ?? []).length ? String(body?.sku ?? '') : undefined;
  const { order, advance, billToken } = await saveOrder(db, ws, {
    who, items: [{ productId: product._id, sku, qty }], zone, coupon: String(body?.coupon ?? '').trim().slice(0, 30),
    conversation, note: String(body?.note ?? '').slice(0, 300), source: 'product_page', notify,
  });
  let final = order;
  if (order.status === 'pending') {
    await changeStatus(db, null, order, 'approved', { by: 'customer', text: 'Confirmed on the product page' });
    final = await db.orders.findById(order._id).lean();
  }
  return { order: final, advance, billToken };
}

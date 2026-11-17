import { InboxError } from '../inbox.js';
import { bdPhone, phoneProblem } from './util.js';

// Delivery zones with their charge and time (ONB-06, ORD-08). Suburbs fall between the two onboarding zones.
export function zonesFor(ws) {
  const s = ws.settings ?? {};
  return [
    { key: 'inside_dhaka', charge: ws.delivery_inside_dhaka ?? 70, days: ws.delivery_inside_days || '1-2 days' },
    { key: 'dhaka_suburbs', charge: s.suburbs_charge ?? 100, days: s.suburbs_days || '2-3 days' },
    { key: 'outside_dhaka', charge: ws.delivery_outside_dhaka ?? 130, days: ws.delivery_outside_days || '3-5 days' },
  ];
}

// Checks a coupon code against the order (ORD-05). Returns { coupon, discount, freeDelivery } or throws a friendly error.
export async function checkCoupon(db, workspaceId, code, subtotal) {
  const c = await db.coupons.findOne({ workspace_id: workspaceId, code: String(code).trim().toUpperCase() }).lean();
  const now = new Date();
  if (!c || !c.active) throw new InboxError(400, `There's no coupon "${code}"`);
  if (c.starts_at && c.starts_at > now) throw new InboxError(400, `${c.code} starts on ${c.starts_at.toISOString().slice(0, 10)}`);
  if (c.ends_at && c.ends_at < now) throw new InboxError(400, `${c.code} has expired`);
  if (c.max_uses !== null && c.used >= c.max_uses) throw new InboxError(400, `${c.code} has been used up`);
  if (subtotal < (c.min_order ?? 0)) throw new InboxError(400, `${c.code} needs an order of at least ৳${c.min_order}`);
  const discount = c.type === 'percent' ? Math.round((subtotal * c.value) / 100) : c.type === 'amount' ? Math.min(c.value, subtotal) : 0;
  return { coupon: c, discount, freeDelivery: c.type === 'free_delivery' };
}

// Prices an order from the live catalog — never from what the browser sends (AI-10, SR-06).
// items: [{ productId, sku, qty }]
export async function priceOrder(db, ws, { items = [], zone = 'inside_dhaka', coupon = '', advance = 0, paidInFull = false, existing = null }) {
  if (!Array.isArray(items) || !items.length) throw new InboxError(400, 'Add at least one product');
  const zones = zonesFor(ws);
  const z = zones.find((x) => x.key === zone);
  if (!z) throw new InboxError(400, 'Pick a delivery zone');
  const products = new Map((await db.products.find({ _id: { $in: items.map((i) => Number(i.productId)) }, workspace_id: ws._id }).lean()).map((p) => [p._id, p]));
  // Stock already held by this order (when editing) doesn't count against it.
  const held = new Map((existing?.product_items ?? []).map((i) => [i.sku, i.qty]));
  const lines = [];
  for (const raw of items) {
    const product = products.get(Number(raw.productId));
    const qty = Number.parseInt(raw.qty, 10);
    if (!product || product.archived) throw new InboxError(400, 'One of the products no longer exists');
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw new InboxError(400, `Quantity for ${product.name} must be 1 to 99`);
    const variants = product.variant_list ?? [];
    const variant = variants.length ? variants.find((v) => v.sku === raw.sku) : null;
    if (variants.length && !variant) throw new InboxError(400, `Pick a size for ${product.name}`);
    const stock = variant ? variant.stock : null;
    if (stock !== null && stock !== undefined && stock + (held.get(variant.sku) ?? 0) < qty) {
      throw new InboxError(409, `Only ${stock} left of ${product.name}${variant ? ` (${Object.values(variant.options ?? {}).join(' / ')})` : ''}`);
    }
    if (!variants.length && product.in_stock === false) throw new InboxError(409, `${product.name} is out of stock`);
    const price = variant?.price ?? product.price;
    lines.push({ product_id: product._id, name: product.name, variant: variant ? Object.values(variant.options ?? {}).join(' / ') : '', sku: variant?.sku ?? product.code ?? '', qty, price });
  }
  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  let discount = 0;
  let delivery = ws.free_delivery_over && subtotal >= ws.free_delivery_over ? 0 : z.charge;
  let couponCode = '';
  if (coupon) {
    const c = await checkCoupon(db, ws._id, coupon, subtotal);
    discount = c.discount;
    if (c.freeDelivery) delivery = 0;
    couponCode = c.coupon.code;
  }
  const total = subtotal + delivery - discount;
  const adv = paidInFull ? total : Math.max(0, Math.min(Number(advance) || 0, total));
  return { lines, subtotal, delivery, discount, couponCode, total, advance: adv, cod: total - adv, zone: z };
}

export function cleanCustomer(body) {
  const problem = phoneProblem(body?.phone);
  if (problem) throw new InboxError(400, problem);
  const name = String(body?.name ?? '').trim();
  if (!name || name.length > 80) throw new InboxError(400, "Customer's name is required");
  const address = String(body?.address ?? '').trim();
  if (address.length < 6 || address.length > 300) throw new InboxError(400, 'Write the full address so the courier can find it');
  return {
    phone: bdPhone(body.phone), name, address,
    district: String(body?.district ?? '').trim().slice(0, 40), thana: String(body?.thana ?? '').trim().slice(0, 40), areaName: String(body?.area ?? '').trim().slice(0, 60),
  };
}

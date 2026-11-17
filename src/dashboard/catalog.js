import { InboxError } from '../inbox.js';

// Catalog helpers shared by the catalog routes, the AI prompt and the demo seed (CAT-01/02).

export const LOW_STOCK_AT = 5;
export const VISIBILITY = ['everywhere', 'ai_only', 'hidden'];
const counted = (v) => v.stock !== null && v.stock !== undefined;

// "in" | "low" | "out", plus the total counted stock (null when nothing is counted).
export function stockState(p, lowAt = LOW_STOCK_AT) {
  const list = p.variant_list ?? [];
  if (!list.length) return { state: p.in_stock === false ? 'out' : 'in', total: null };
  const nums = list.filter(counted);
  const total = nums.reduce((s, v) => s + Math.max(0, v.stock), 0);
  const untracked = nums.length < list.length;
  if (!untracked && total === 0) return { state: 'out', total: 0 };
  if (p.in_stock === false) return { state: 'out', total };
  if (!untracked && total <= lowAt) return { state: 'low', total };
  return { state: 'in', total: nums.length ? total : null };
}

export const variantLabel = (v, options = []) => {
  const names = options.length ? options.map((o) => o.name) : Object.keys(v.options ?? {});
  return names.map((n) => v.options?.[n]).filter(Boolean).join(' / ');
};

// What the product still needs before the AI can sell it well (AI readiness).
export function missing(p) {
  const out = [];
  if (!p.photos?.length) out.push('photo');
  const sized = (p.options ?? []).some((o) => /^(size|সাইজ)$/i.test(o.name) && o.values.some((v) => !/^(free|one size|ফ্রি)$/i.test(v)));
  if (sized && !p.size_chart_id) out.push('size_chart');
  return out;
}

// Free-text options line the AI reads, e.g. "Size: S, M, L / Colour: Teal, Rose".
export const optionsText = (options) => options.map((o) => (options.length > 1 ? `${o.name}: ${o.values.join(', ')}` : o.values.join(', '))).join(' / ');

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const money = (v, what) => {
  const n = Number(String(v ?? '').replace(/[,৳\s]/g, '').replace(/[০-৯]/g, (d) => '০১২৩৪৫৬৭৮৯'.indexOf(d)));
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw new InboxError(400, `Enter a valid ${what}`);
  return Math.round(n);
};
const okUrl = (u) => typeof u === 'string' && (u.startsWith('/files/') || /^https:\/\/[^\s]+$/.test(u)) && u.length < 500;

// Checks and tidies a product sent from the product form. `existing` keeps reserved stock and counters.
export async function cleanProduct(db, workspaceId, b, existing = null) {
  const name = str(b.name, 120);
  if (!name) throw new InboxError(400, 'Give the product a name');
  const price = money(b.price, 'price');
  const compareAt = b.compareAt === null || b.compareAt === undefined || b.compareAt === '' ? null : money(b.compareAt, 'compare-at price');
  if (compareAt !== null && compareAt <= price) throw new InboxError(400, 'The compare-at price should be higher than the price (it shows as the old price)');

  const options = [];
  for (const o of (Array.isArray(b.options) ? b.options : []).slice(0, 3)) {
    const oname = str(o?.name, 20);
    const values = [...new Set((Array.isArray(o?.values) ? o.values : []).map((v) => str(v, 30)).filter(Boolean))].slice(0, 20);
    if (!oname || !values.length) continue;
    if (options.some((x) => x.name.toLowerCase() === oname.toLowerCase())) throw new InboxError(400, `"${oname}" is listed twice`);
    options.push({ name: oname, values });
  }

  const before = new Map((existing?.variant_list ?? []).map((v) => [JSON.stringify(v.options ?? {}), v]));
  const variants = [];
  const skus = new Set();
  for (const v of (Array.isArray(b.variants) ? b.variants : []).slice(0, 200)) {
    const opts = {};
    for (const o of options) {
      const val = str(v?.options?.[o.name], 30);
      if (!o.values.includes(val)) throw new InboxError(400, `A variant has a ${o.name.toLowerCase()} that isn't in the list`);
      opts[o.name] = val;
    }
    const key = JSON.stringify(opts);
    if (variants.some((x) => JSON.stringify(x.options) === key)) continue;
    const sku = str(v?.sku, 40);
    if (sku) {
      if (skus.has(sku.toLowerCase())) throw new InboxError(400, `SKU ${sku} is used twice`);
      skus.add(sku.toLowerCase());
    }
    const stock = v?.stock === null || v?.stock === '' || v?.stock === undefined ? null : Number(v.stock);
    if (stock !== null && (!Number.isInteger(stock) || stock < 0 || stock > 100_000)) throw new InboxError(400, 'Stock must be a whole number');
    variants.push({ sku, options: opts, price: v?.price === undefined || v?.price === '' ? price : money(v.price, 'variant price'), stock, reserved: before.get(key)?.reserved ?? 0 });
  }
  if (!options.length) variants.length = 0;

  const photos = (Array.isArray(b.photos) ? b.photos : []).filter(okUrl).slice(0, 10);
  const visibility = VISIBILITY.includes(b.visibility) ? b.visibility : 'everywhere';
  let sizeChartId = null;
  if (b.sizeChartId) {
    const chart = await db.sizeCharts.findOne({ _id: Number(b.sizeChartId), workspace_id: workspaceId }).lean();
    if (!chart) throw new InboxError(400, 'That size chart no longer exists');
    sizeChartId = chart._id;
  }
  const upsellIds = [...new Set((Array.isArray(b.upsellIds) ? b.upsellIds : []).map(Number).filter((id) => id && id !== existing?._id))].slice(0, 3);
  if (upsellIds.length && await db.products.countDocuments({ _id: { $in: upsellIds }, workspace_id: workspaceId }) !== upsellIds.length) {
    throw new InboxError(400, 'One of the add-on products no longer exists');
  }
  const code = str(b.code, 20);
  if (code && await db.products.exists({ workspace_id: workspaceId, code, _id: { $ne: existing?._id ?? -1 } })) {
    throw new InboxError(409, `Another product already uses the code ${code}`);
  }

  return {
    name, price, compare_at: compareAt, code, category: str(b.category, 40), description: str(b.description, 4000),
    photos, video: okUrl(b.video) ? b.video : '', colour: /^#[0-9a-f]{6}$/i.test(b.colour ?? '') ? b.colour : (existing?.colour ?? ''),
    options, variant_list: variants, variants: optionsText(options),
    in_stock: variants.length ? variants.some((v) => v.stock === null || v.stock > 0) : b.inStock !== false,
    ai_notes: str(b.aiNotes, 1000), visibility, size_chart_id: sizeChartId, upsell_ids: upsellIds, updated_at: new Date(),
  };
}

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { InboxError } from '../inbox.js';

// ONB-12 · Catalog import from WooCommerce. The shop gives its store address and a read-only REST API key
// (WooCommerce → Settings → Advanced → REST API). Products, prices, sizes/colours and stock come in;
// running it again updates what changed. Only HTTPS stores on the public internet are ever called.

const MAX_PAGES = 5; // 100 per page → 500 products at most
const TIMEOUT = 20_000;

function privateAddress(ip) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return privateAddress(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

// "myshop.com", "https://myshop.com/shop/" → "https://myshop.com/shop". Throws a friendly error otherwise.
export async function wooStoreUrl(input, { resolve = lookup } = {}) {
  let raw = String(input ?? '').trim();
  if (!raw) throw new InboxError(400, "Enter your store's address, e.g. https://myshop.com");
  if (!/^[a-z]+:\/\//i.test(raw)) raw = `https://${raw}`;
  let url;
  try { url = new URL(raw); } catch { throw new InboxError(400, "That doesn't look like a web address"); }
  if (url.protocol !== 'https:') throw new InboxError(400, 'Your store must use https:// so the keys travel safely');
  if (url.username || url.password || url.port && url.port !== '443') throw new InboxError(400, 'Use the plain store address, without a port or login');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) throw new InboxError(400, 'Use your public store address');
  const ips = isIP(host) ? [{ address: host }] : await resolve(host, { all: true }).catch(() => []);
  if (!ips.length) throw new InboxError(400, `We couldn't find ${host}. Check the address`);
  if (ips.some((x) => privateAddress(x.address))) throw new InboxError(400, 'Use your public store address');
  return `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\/wp-json.*$/, '')}`;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
export function plainText(html) {
  return String(html ?? '')
    .replace(/<\s*(br|\/p|\/li|\/h\d)\s*\/?>/gi, '\n').replace(/<li[^>]*>/gi, '• ').replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

const taka = (v) => { const n = Number.parseFloat(v); return Number.isFinite(n) && n >= 0 ? Math.round(n) : null; };
const stockOf = (x) => (x.manage_stock && Number.isFinite(x.stock_quantity) ? Math.max(0, x.stock_quantity) : x.stock_status === 'outofstock' ? 0 : null);

// One WooCommerce product (and its variations) → a HeyQuicky catalog product. Returns null when it can't be sold.
export function productFromWoo(p, variations = []) {
  const name = plainText(p.name).slice(0, 120);
  if (!name) return null;
  const regular = taka(p.regular_price);
  const price = taka(p.price) ?? regular;
  const photos = (p.images ?? []).map((i) => i?.src).filter((s) => /^https:\/\//.test(s ?? '')).slice(0, 8);
  const description = (plainText(p.description) || plainText(p.short_description)).slice(0, 1000);
  const base = {
    woo_id: p.id, name, code: String(p.sku ?? '').slice(0, 40), description, photos,
    category: plainText(p.categories?.[0]?.name ?? '').slice(0, 60),
  };
  if (p.type === 'variable') {
    const attrs = (p.attributes ?? []).filter((a) => a.variation && a.options?.length);
    const options = attrs.map((a) => ({ name: plainText(a.name).slice(0, 30), values: a.options.map((o) => plainText(o).slice(0, 30)) }));
    const variant_list = [];
    for (const v of variations) {
      const picked = {};
      for (const a of attrs) {
        // Global attributes match by id, custom ones (id 0) by name.
        const hit = (v.attributes ?? []).find((x) => (a.id ? x.id === a.id : x.name === a.name));
        if (!hit?.option) break; // "Any size" variations can't be priced per size, so they are left out
        picked[plainText(a.name).slice(0, 30)] = plainText(hit.option).slice(0, 30);
      }
      if (Object.keys(picked).length !== attrs.length) continue;
      const vp = taka(v.price) ?? taka(v.regular_price);
      if (vp === null || v.status === 'private') continue;
      variant_list.push({ sku: String(v.sku || `W${v.id}`).slice(0, 40), options: picked, price: vp, stock: stockOf(v), reserved: 0, woo_id: v.id });
    }
    if (!variant_list.length) return null;
    const cheapest = Math.min(...variant_list.map((v) => v.price));
    const regulars = variations.map((v) => taka(v.regular_price)).filter((n) => n !== null);
    const compare = regulars.length ? Math.max(...regulars) : null;
    return {
      ...base, price: cheapest, compare_at: compare && compare > cheapest ? compare : null, options, variant_list,
      in_stock: variant_list.some((v) => v.stock === null || v.stock > 0),
      variants: options.map((o) => o.values.join(', ')).join(' / ').slice(0, 300),
    };
  }
  if (price === null) return null;
  return { ...base, price, compare_at: regular && regular > price ? regular : null, options: [], variant_list: [], in_stock: p.stock_status !== 'outofstock' && stockOf(p) !== 0, variants: '' };
}

async function wooGet(store, path, { key, secret, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(`${store}/wp-json/wc/v3${path}`, {
      headers: { authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`, accept: 'application/json' },
      redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch {
    throw new InboxError(502, "We couldn't reach your store. Check the address and that the site is up");
  }
  // Redirects aren't followed (they could point anywhere); the shop uses the final address instead.
  if (res.status >= 300 && res.status < 400) {
    let to = '';
    try { to = new URL(res.headers.get('location') ?? '', store).origin; } catch { /* no usable address */ }
    throw new InboxError(400, to && to !== new URL(store).origin ? `Your store moved to ${to}. Use that address` : 'Your store redirected the request. Use the exact address your shop opens on');
  }
  if (res.status === 401 || res.status === 403) throw new InboxError(400, 'WooCommerce refused the key. Check the Consumer key and secret, and that the key has Read access');
  if (res.status === 404) throw new InboxError(400, "We couldn't find WooCommerce at that address. Check the address and that permalinks are turned on");
  if (!res.ok) throw new InboxError(502, `Your store answered with an error (${res.status}). Try again in a moment`);
  const body = await res.json().catch(() => null);
  if (!Array.isArray(body)) throw new InboxError(400, "That address didn't answer like a WooCommerce store");
  return { body, pages: Number(res.headers.get('x-wp-totalpages')) || 1 };
}

// All published products with their variations, mapped to catalog products.
export async function fetchWooProducts({ store, key, secret, fetchImpl = fetch }) {
  const raw = [];
  let pages = 1;
  for (let page = 1; page <= Math.min(pages, MAX_PAGES); page++) {
    const r = await wooGet(store, `/products?per_page=100&page=${page}&status=publish`, { key, secret, fetchImpl });
    raw.push(...r.body);
    pages = r.pages;
  }
  const products = [];
  let skipped = 0;
  for (const p of raw) {
    const variations = p.type === 'variable' ? (await wooGet(store, `/products/${p.id}/variations?per_page=100`, { key, secret, fetchImpl })).body : [];
    const mapped = ['simple', 'variable'].includes(p.type) ? productFromWoo(p, variations) : null;
    if (mapped) products.push(mapped); else skipped += 1;
  }
  return { products, skipped, more: pages > MAX_PAGES };
}

// Adds new products and updates ones already imported (by WooCommerce id, else by the same name).
// The shop's own AI notes, visibility, size charts and upsells are never touched.
export async function syncWooProducts(db, workspaceId, products, { pickColour = () => '' } = {}) {
  const have = await db.products.find({ workspace_id: workspaceId }, { name: 1, woo_id: 1, variant_list: 1 }).lean();
  const byWoo = new Map(have.filter((p) => p.woo_id).map((p) => [p.woo_id, p]));
  const byName = new Map(have.map((p) => [p.name.trim().toLowerCase(), p]));
  let added = 0;
  let updated = 0;
  for (const p of products) {
    const match = byWoo.get(p.woo_id) ?? byName.get(p.name.toLowerCase());
    if (match) {
      // Keep units held by open orders against the same SKU.
      const held = new Map((match.variant_list ?? []).map((v) => [v.sku, v.reserved ?? 0]));
      const variant_list = p.variant_list.map((v) => ({ ...v, reserved: held.get(v.sku) ?? 0 }));
      await db.products.updateOne({ _id: match._id }, { $set: { ...p, variant_list, archived: false, updated_at: new Date() } });
      updated += 1;
    } else {
      const created = await db.insert(db.products, { workspace_id: workspaceId, ...p, colour: pickColour(p.name) });
      if (!p.code) await db.products.updateOne({ _id: created.id }, { $set: { code: `P-${created.id}` } });
      added += 1;
    }
  }
  return { added, updated };
}

import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { InboxError } from '../inbox.js';
import { priceOrder, zonesFor } from '../dashboard/orderBuild.js';
import { onPage, placePageOrder } from '../dashboard/productPage.js';
import { orderSummary } from '../platforms/rich.js';

// ORD-04 · Product page (frame "Product page (customer)") and checkout form (frame "Product page
// checkout form", ORD-10 phone check). Public, Bangla, light: server-rendered with one small script.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
const BN = '০১২৩৪৫৬৭৮৯';
export const bnDigits = (s) => String(s).replace(/\d/g, (d) => BN[d]);
const bnDays = (s) => bnDigits(String(s || '').replace(/\s*days?\b/i, ' দিন'));
const SCRIPT = readFileSync(new URL('./productPage.client.js', import.meta.url), 'utf8');

// The order checks speak English for the team; customers read them in Bangla, with the field to fix.
const BN_ERRORS = [
  [/Phone number is required/, 'মোবাইল নম্বর দিন', 'phone'],
  [/11 digits/, 'নম্বরটি ১১ সংখ্যার হতে হবে (যেমন 01712345678)', 'phone'],
  [/start with 013/, 'মোবাইল নম্বর ০১৩ থেকে ০১৯ দিয়ে শুরু হয়', 'phone'],
  [/name is required/, 'আপনার নাম লিখুন', 'name'],
  [/full address/, 'পুরো ঠিকানা লিখুন, যাতে কুরিয়ার খুঁজে পায়', 'address'],
  [/Pick where to deliver|delivery zone/, 'ডেলিভারি এলাকা বেছে নিন', 'zone'],
  [/Pick a size/, 'সাইজ / রং বেছে নিন', 'options'],
  [/Only (\d+) left/, (m) => `দুঃখিত, মাত্র ${bnDigits(m[1])}টি বাকি আছে`, 'qty'],
  [/out of stock|no longer exists/, 'দুঃখিত, পণ্যটি এখন স্টকে নেই', null],
  [/Quantity/, 'পরিমাণ ১ থেকে ৯৯-এর মধ্যে দিন', 'qty'],
  [/There's no coupon/, 'এই কুপন কোডটি নেই', 'coupon'],
  [/has expired/, 'কুপনের মেয়াদ শেষ হয়ে গেছে', 'coupon'],
  [/used up/, 'কুপনটি আর ব্যবহার করা যাবে না', 'coupon'],
  [/starts on/, 'কুপনটি এখনো চালু হয়নি', 'coupon'],
  [/needs an order of at least ৳(\d+)/, (m) => `এই কুপনে কমপক্ষে ৳${bnDigits(m[1])}-এর অর্ডার লাগবে`, 'coupon'],
  [/only for|is for customers/, 'এই কুপনটি আপনার জন্য নয়', 'coupon'],
];
export function customerError(message) {
  for (const [re, text, field] of BN_ERRORS) {
    const m = re.exec(message);
    if (m) return { error: typeof text === 'function' ? text(m) : text, field };
  }
  return { error: 'কিছু একটা সমস্যা হয়েছে — আবার চেষ্টা করুন', field: null };
}

// limit(key) records a hit and says whether it is within max; limit.peek(key) only checks.
function limiter(max, windowMs) {
  const hits = new Map();
  const recentOf = (key) => (hits.get(key) ?? []).filter((t) => Date.now() - t < windowMs);
  const limit = (key) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 50_000) hits.clear();
    return recent.length <= max;
  };
  limit.peek = (key) => recentOf(key).length < max;
  return limit;
}

const STYLE = `*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,"Noto Sans Bengali","Hind Siliguri",sans-serif;background:#f6f5f1;color:#15171c}
main{max-width:480px;margin:0 auto;background:#fff;min-height:100vh;padding-bottom:96px;position:relative}
.top{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid #eee;position:sticky;top:0;background:#fff;z-index:2}
.av{width:30px;height:30px;border-radius:50%;background:#f3e3d3;display:grid;place-items:center;font-size:12px;font-weight:700;color:#7a4b25}
.top strong{font-size:15px}.back{all:unset;cursor:pointer;width:28px;height:28px;border:1px solid #e5e5e5;border-radius:8px;display:grid;place-items:center}
.gal{position:relative}.slides{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none}.slides::-webkit-scrollbar{display:none}
.slides>*{flex:0 0 100%;scroll-snap-align:start;aspect-ratio:1/1;object-fit:cover;width:100%;display:block}
.badge{position:absolute;top:12px;left:12px;background:#f5c518;color:#111;font-size:12px;font-weight:700;padding:3px 9px;border-radius:999px}
.dots{position:absolute;bottom:10px;left:0;right:0;display:flex;justify-content:center;gap:5px}.dots i{width:6px;height:6px;border-radius:3px;background:rgba(255,255,255,.6)}.dots i.on{width:16px;background:#fff}
.pad{padding:14px 16px}h1{font-size:21px;margin:0 0 4px}h2{font-size:19px;margin:0 0 12px}
.price{display:flex;align-items:baseline;gap:8px}.price strong{font-size:22px}.price s{color:#8a8f98}
.ok{color:#12733f;font-size:13px;font-weight:600}.out{color:#b42318;font-size:13px;font-weight:600}
.opt{margin-top:14px}.opt .lab{display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px}.opt a{color:#2b4bff}
.chips{display:flex;flex-wrap:wrap;gap:8px}.chip{all:unset;cursor:pointer;min-width:40px;height:40px;padding:0 12px;border:1px solid #d9d9de;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;gap:6px;font-weight:600;font-size:14px}
.chip.on{background:#15171c;color:#fff;border-color:#15171c}.chip:disabled{color:#c2c4ca;border-style:dashed;cursor:default;text-decoration:line-through}
.chip:focus-visible,.btn:focus-visible,.zone:focus-visible{outline:2px solid #2b4bff;outline-offset:2px}
.sw{width:16px;height:16px;border-radius:50%;border:1px solid rgba(0,0,0,.15)}
.desc{white-space:pre-wrap;color:#3c4049;font-size:14px;margin-top:14px}
.bar{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:480px;background:#fff;border-top:1px solid #eee;padding:10px 16px calc(10px + env(safe-area-inset-bottom));display:flex;gap:10px;z-index:3}
.btn{all:unset;box-sizing:border-box;cursor:pointer;flex:1;text-align:center;padding:13px 10px;border-radius:12px;font-weight:700;font-size:15px;border:1px solid #d9d9de}
.btn.primary{background:#2b4bff;color:#fff;border-color:#2b4bff;flex:1.4}.btn[aria-disabled=true]{opacity:.5;cursor:default}
.bar small{display:block;text-align:center;color:#6b6f78;font-size:12px;margin-top:6px}.bar.col{flex-direction:column;gap:0}
.row{display:flex;gap:12px;align-items:center;border:1px solid #eee;border-radius:12px;padding:10px}.row .th{width:52px;height:52px;border-radius:10px;object-fit:cover;flex:none}
.row .nm{flex:1;min-width:0}.row .nm small{display:block;color:#6b6f78}.qty{display:flex;align-items:center;gap:8px}.qty button{all:unset;cursor:pointer;width:28px;height:28px;border:1px solid #d9d9de;border-radius:8px;text-align:center;font-weight:700}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}input,textarea{width:100%;font:inherit;padding:11px 12px;border:1px solid #d9d9de;border-radius:10px;background:#fff}textarea{min-height:70px;resize:vertical}
input[aria-invalid=true]{border-color:#d92d20;background:#fff8f7}.err{color:#d92d20;font-size:12.5px;margin-top:4px}
.zones{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}.zone{all:unset;box-sizing:border-box;cursor:pointer;border:1px solid #d9d9de;border-radius:12px;padding:10px 12px}.zone small{display:block;color:#6b6f78;font-size:12px}.zone.on{border-color:#2b4bff;background:#eef1ff;box-shadow:0 0 0 1px #2b4bff}
.sum{background:#f7f7f5;border-radius:12px;padding:12px;margin-top:16px;font-size:14px}.sum div{display:flex;justify-content:space-between;padding:2px 0}.sum .tot{font-weight:700;border-top:1px solid #e3e3e0;margin-top:6px;padding-top:8px}
.coupon{margin-top:12px;font-size:13px}.coupon summary{cursor:pointer;color:#2b4bff}.coupon .in{display:flex;gap:8px;margin-top:8px}.coupon .in button{all:unset;cursor:pointer;padding:0 14px;border-radius:10px;background:#15171c;color:#fff;font-weight:600}
.done{text-align:center;padding:40px 20px}.tick{width:64px;height:64px;border-radius:50%;background:#e7f6ec;color:#12733f;display:grid;place-items:center;font-size:32px;margin:0 auto 12px}
.steps{text-align:left;background:#f7f7f5;border-radius:12px;padding:14px 16px;margin:18px 0;font-size:14px}.steps li{margin:6px 0}
.hp{position:absolute;left:-9999px}footer{text-align:center;color:#9a9ea6;font-size:12px;padding:20px 0}
[hidden]{display:none!important}`;

export function page(title, body, { image = '' } = {}) {
  return `<!doctype html><html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title><meta property="og:title" content="${esc(title)}">${image ? `<meta property="og:image" content="${esc(image)}">` : ''}
<style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

const notFound = () => page('পণ্যটি পাওয়া যায়নি', '<div class="done"><div class="tick" style="background:#fdecea;color:#b42318">!</div><h2>পণ্যটি পাওয়া যায়নি</h2><p>লিংকটি পুরনো বা ভুল হতে পারে। শপকে মেসেজ করে আবার চান।</p></div>');

export function productPageRoutes(db, config, { inbox, notify }) {
  const router = Router();
  const attemptLimit = limiter(30, 10 * 60_000); // tries, including ones with a typo
  const orderLimit = limiter(5, 10 * 60_000); // orders actually placed
  const quoteLimit = limiter(60, 60_000);
  const base = (req) => config.publicUrl || `${req.protocol}://${req.get('host')}`;

  async function load(shop, productId) {
    if (!/^[a-z0-9-]{1,40}$/.test(shop) || !/^\d{1,12}$/.test(productId)) return null;
    const ws = await db.workspaces.findOne({ shop_slug: shop }).lean();
    if (!ws) return null;
    const product = await db.products.findOne({ _id: Number(productId), workspace_id: ws._id }).lean();
    return onPage(product) ? { ws, product } : null;
  }
  // The chat this link was sent in, if the token is real and belongs to this shop.
  async function chatFor(ws, token) {
    if (!token || !/^[\w-]{8,40}$/.test(String(token))) return null;
    return db.conversations.findOne({ page_token: String(token), workspace_id: ws._id }).lean();
  }

  router.get('/p-assets/checkout.js', (_req, res) => { res.set('Cache-Control', 'public, max-age=300'); res.type('js').send(SCRIPT); });

  router.get('/p/:shop/:product', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const found = await load(req.params.shop, req.params.product);
    if (!found) return res.status(404).type('html').send(notFound());
    const { ws, product: p } = found;
    const chat = await chatFor(ws, req.query.c);
    const messenger = await db.channels.findOne({ workspace_id: ws._id, platform: 'messenger', status: { $ne: 'disconnected' } }, { external_id: 1, page_id: 1 }).lean();
    const chart = p.size_chart_id ? await db.sizeCharts.findOne({ _id: p.size_chart_id, workspace_id: ws._id }, { token: 1 }).lean() : null;
    const zones = zonesFor(ws).map((z) => ({ key: z.key, charge: z.charge, days: bnDays(z.days) }));
    const variants = (p.variant_list ?? []).map((v) => ({ sku: v.sku, options: v.options ?? {}, price: v.price ?? p.price, left: v.stock === null || v.stock === undefined || v.stock > 0 }));
    const inStock = p.in_stock !== false && (!variants.length || variants.some((v) => v.left));
    const photos = (p.photos ?? []).slice(0, 8);
    const data = {
      shop: req.params.shop, id: p._id, name: p.name, price: p.price, compareAt: p.compare_at > p.price ? p.compare_at : null,
      photos, colour: p.colour || '#2f7d78', options: (p.options ?? []).filter((o) => o?.name && o.values?.length), variants, inStock,
      zones, freeOver: ws.free_delivery_over || null, chat: chat ? String(req.query.c) : null,
      messageUrl: messenger ? `https://m.me/${encodeURIComponent(messenger.page_id || messenger.external_id)}` : '',
    };
    const initials = String(ws.name).trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    const off = data.compareAt ? Math.round(((data.compareAt - p.price) / data.compareAt) * 100) : 0;
    const inside = zones.find((z) => z.key === 'inside_dhaka');
    const taka = (n) => `৳${Number(n).toLocaleString('en-IN')}`;
    const gallery = photos.length ? photos.map((src, i) => `<img src="${esc(src)}" alt="${esc(p.name)}${photos.length > 1 ? ` — ছবি ${bnDigits(i + 1)}` : ''}"${i ? ' loading="lazy"' : ''}>`).join('') : `<div style="background:${esc(data.colour)}" role="img" aria-label="${esc(p.name)}"></div>`;
    const top = `<header class="top"><button type="button" class="back" id="back" aria-label="ফিরে যান" hidden>‹</button><a href="/s/${esc(req.params.shop)}${chat ? `?c=${encodeURIComponent(String(req.query.c))}` : ''}" style="display:flex;align-items:center;gap:10px;color:inherit;text-decoration:none" aria-label="${esc(ws.name)} — সব পণ্য"><span class="av" aria-hidden="true">${esc(initials)}</span><strong>${esc(ws.name)}</strong></a></header>`;
    res.type('html').send(page(`${p.name} — ${ws.name}`, `${top}
<section id="view-product">
  <div class="gal"><div class="slides" id="slides">${gallery}</div>${off > 0 ? `<span class="badge">-${bnDigits(off)}% ছাড়</span>` : ''}${photos.length > 1 ? `<div class="dots" id="dots" aria-hidden="true">${photos.map((_, i) => `<i${i ? '' : ' class="on"'}></i>`).join('')}</div>` : ''}</div>
  <div class="pad">
    <h1>${esc(p.name)}</h1>
    <div class="price"><strong id="price">${taka(p.price)}</strong>${data.compareAt ? `<s>${taka(data.compareAt)}</s>` : ''}</div>
    ${inStock ? `<div class="ok">স্টক আছে${inside ? ` · ${esc(inside.days)}ে ঢাকায় ডেলিভারি` : ''}</div>` : '<div class="out">স্টক শেষ</div>'}
    <div id="opts"></div>
    ${chart?.token ? `<p style="margin:8px 0 0;font-size:13px"><a href="/size/${esc(chart.token)}" style="color:#2b4bff">সাইজ চার্ট দেখুন</a></p>` : ''}
    ${p.description ? `<div class="desc">${esc(p.description)}</div>` : ''}
  </div>
  <div class="bar">${data.messageUrl ? `<a class="btn" href="${esc(data.messageUrl)}">মেসেজ করুন</a>` : ''}<button type="button" class="btn primary" id="buy"${inStock ? '' : ' aria-disabled="true"'}>${inStock ? 'এখনই কিনুন' : 'স্টক শেষ'}</button></div>
</section>
<section id="view-form" hidden>
  <form class="pad" id="form" novalidate>
    <h2>অর্ডার করুন</h2>
    <div class="row">${photos[0] ? `<img class="th" src="${esc(photos[0])}" alt="">` : `<span class="th" style="background:${esc(data.colour)}"></span>`}
      <div class="nm"><strong>${esc(p.name)}</strong><small id="pick"></small></div>
      <div class="qty"><button type="button" id="minus" aria-label="একটি কম">−</button><span id="qty" aria-live="polite">১</span><button type="button" id="plus" aria-label="একটি বেশি">+</button></div></div>
    <label for="f-name">আপনার নাম</label><input id="f-name" name="name" autocomplete="name" maxlength="80" required>
    <label for="f-phone">মোবাইল নম্বর</label><input id="f-phone" name="phone" inputmode="tel" autocomplete="tel" placeholder="01XXXXXXXXX" required aria-describedby="e-phone"><div class="err" id="e-phone" hidden></div>
    <label for="f-address">পুরো ঠিকানা</label><textarea id="f-address" name="address" autocomplete="street-address" maxlength="300" placeholder="বাসা, রোড, এলাকা, জেলা" required></textarea>
    <label id="zl">ডেলিভারি এলাকা</label><div class="zones" role="radiogroup" aria-labelledby="zl" id="zones"></div>
    <details class="coupon"><summary>কুপন কোড আছে?</summary><div class="in"><input id="f-coupon" maxlength="30" aria-label="কুপন কোড"><button type="button" id="apply">লাগান</button></div><div class="err" id="e-coupon" hidden></div></details>
    <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
    <div class="sum" id="sum"></div>
    <div class="err" id="e-form" role="alert" hidden></div>
  </form>
  <div class="bar col"><button type="button" class="btn primary" id="confirm">অর্ডার কনফার্ম করুন</button><small>${chat ? 'অর্ডারের বিল আপনার মেসেঞ্জারে চলে যাবে' : 'অর্ডারের পর বিলের লিংক এখানেই পাবেন'}</small></div>
</section>
<section id="view-done" hidden><div class="done" id="done"></div></section>
<footer>Powered by HeyQuicky</footer>
<script>window.HQ_PRODUCT=${json(data)}</script><script src="/p-assets/checkout.js" defer></script>`, { image: photos[0] ? (photos[0].startsWith('http') ? photos[0] : `${base(req)}${photos[0]}`) : '' }));
  });

  // Live total for the form: priced on the server from the catalog (coupon, free delivery).
  router.post('/api/p/:shop/:product/quote', async (req, res) => {
    if (!quoteLimit(req.ip)) return res.status(429).json({ error: 'একটু পরে আবার চেষ্টা করুন' });
    const found = await load(req.params.shop, req.params.product);
    if (!found) return res.status(404).json({ error: 'পণ্যটি পাওয়া যায়নি' });
    const { ws, product } = found;
    try {
      const sku = (product.variant_list ?? []).length ? String(req.body?.sku ?? '') : undefined;
      const q = await priceOrder(db, ws, { items: [{ productId: product._id, sku, qty: Number.parseInt(req.body?.qty, 10) || 1 }], zone: String(req.body?.zone ?? 'inside_dhaka'), coupon: String(req.body?.coupon ?? '').trim().slice(0, 30) });
      res.json({ subtotal: q.subtotal, delivery: q.delivery, discount: q.discount, total: q.total, coupon: q.couponCode });
    } catch (err) {
      if (err instanceof InboxError) return res.status(err.status).json(customerError(err.message));
      throw err;
    }
  });

  router.post('/api/p/:shop/:product/order', async (req, res) => {
    if (req.body?.website) return res.status(400).json({ error: 'Something went wrong' }); // bots fill the hidden field
    if (!attemptLimit(req.ip) || !orderLimit.peek(req.ip)) return res.status(429).json({ error: 'অনেকবার চেষ্টা হয়েছে — কয়েক মিনিট পরে আবার চেষ্টা করুন' });
    const found = await load(req.params.shop, req.params.product);
    if (!found) return res.status(404).json({ error: 'পণ্যটি পাওয়া যায়নি' });
    const { ws, product } = found;
    const chat = await chatFor(ws, req.body?.c);
    try {
      const { order, advance, billToken } = await placePageOrder(db, { ws, product, body: req.body, conversation: chat, notify });
      orderLimit(req.ip);
      const billUrl = `${base(req)}/b/${billToken}`;
      let inChat = false;
      if (chat && inbox?.sendAiRich) {
        inChat = Boolean(await inbox.sendAiRich(chat._id, orderSummary(order, { billUrl })).catch(() => null));
      }
      res.status(201).json({ number: order.number, total: order.subtotal + order.delivery_charge - order.discount, cod: order.cod_amount, status: order.status, advance: advance?.amount ?? null, billUrl, inChat });
    } catch (err) {
      if (err instanceof InboxError) return res.status(err.status).json(customerError(err.message));
      throw err;
    }
  });

  return router;
}

import { Router } from 'express';
import { esc, bnDigits, page } from './productPage.js';
import { onPage } from '../dashboard/productPage.js';
import { aiCoupons } from '../dashboard/orderBuild.js';

// INT-03 · Shop link / storefront (frame "Shop link / storefront"): one link, /s/<shop>, with the shop's
// offer, categories and every product live everywhere, each opening its product page checkout (ORD-04).
// Server-rendered, works without JavaScript; the chat token (?c=…) is passed on so orders come back to the chat.

const STYLE = `<style>
.banner{margin:14px 16px 0;border-radius:16px;padding:18px;color:#fff;background:linear-gradient(135deg,#2f7d78,#1f5552)}
.banner small{display:block;font-size:12px;opacity:.85}.banner strong{display:block;font-size:22px;line-height:1.25;margin:2px 0 6px}.banner code{font:600 12px/1 ui-monospace,monospace;background:rgba(255,255,255,.18);padding:4px 8px;border-radius:6px;letter-spacing:.04em}
.cats{display:flex;gap:8px;overflow-x:auto;padding:14px 16px 4px;scrollbar-width:none}.cats::-webkit-scrollbar{display:none}
.cat{flex:none;padding:7px 14px;border:1px solid #d9d9de;border-radius:999px;font-size:13.5px;font-weight:600;color:#15171c;text-decoration:none;white-space:nowrap}
.cat.on{background:#15171c;color:#fff;border-color:#15171c}.cat:focus-visible,.tile:focus-visible{outline:2px solid #2b4bff;outline-offset:2px}
.search{padding:10px 16px 0}.search input{width:100%;font:inherit;padding:10px 12px;border:1px solid #d9d9de;border-radius:10px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 12px;padding:14px 16px 8px;list-style:none;margin:0}
.tile{display:block;color:inherit;text-decoration:none}.ph{display:block;position:relative;aspect-ratio:3/4;border-radius:14px;overflow:hidden;background:#eee}
.ph img,.ph span.fill{width:100%;height:100%;object-fit:cover;display:block}.ph .off{position:absolute;top:8px;left:8px;background:#f5c518;color:#111;font-size:11px;font-weight:700;padding:2px 7px;border-radius:999px}
.ph .sold{position:absolute;inset:auto 0 0 0;background:rgba(21,23,28,.72);color:#fff;font-size:12px;font-weight:600;text-align:center;padding:6px}
.tile .nm{display:block;font-size:14px;margin-top:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tile .pr{display:flex;gap:6px;align-items:baseline}.tile .pr strong{font-size:15px}.tile .pr s{color:#8a8f98;font-size:12.5px}
.empty{text-align:center;color:#6b6f78;padding:40px 20px}.msgbar{position:sticky;bottom:0;padding:10px 16px calc(10px + env(safe-area-inset-bottom));background:#fff;border-top:1px solid #eee}
</style>`;

const taka = (n) => `৳${Number(n).toLocaleString('en-IN')}`;
const BN_PCT = (n) => bnDigits(n);

// The offer banner: the newest coupon the shop lets the AI mention to everyone.
function offerOf(coupons) {
  const c = coupons[0];
  if (!c) return null;
  const what = c.type === 'percent' ? `${BN_PCT(c.value)}% ছাড়` : c.type === 'amount' ? `${taka(c.value)} ছাড়` : 'ডেলিভারি ফ্রি';
  const when = c.min_order ? `${taka(c.min_order)}-এর বেশি কিনলে ` : '';
  return { title: `${when}${what}`, code: c.code, until: c.ends_at ? new Date(c.ends_at) : null };
}

export function storefrontRoutes(db, config) {
  const router = Router();

  router.get('/s/:shop', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const slug = String(req.params.shop);
    const ws = /^[a-z0-9-]{1,40}$/.test(slug) ? await db.workspaces.findOne({ shop_slug: slug }).lean() : null;
    if (!ws) return res.status(404).type('html').send(page('শপটি পাওয়া যায়নি', '<div class="done"><div class="tick" style="background:#fdecea;color:#b42318">!</div><h2>শপটি পাওয়া যায়নি</h2><p>লিংকটি পুরনো বা ভুল হতে পারে।</p></div>'));
    const token = /^[\w-]{8,40}$/.test(String(req.query.c ?? '')) ? String(req.query.c) : '';
    const now = new Date();
    const [all, coupons, messenger] = await Promise.all([
      db.products.find({ workspace_id: ws._id, archived: { $ne: true }, visibility: 'everywhere' }).sort({ sold_count: -1, name: 1 }).limit(400).lean(),
      db.coupons.find({ workspace_id: ws._id, active: { $ne: false } }).sort({ created_at: -1 }).limit(20).lean(),
      db.channels.findOne({ workspace_id: ws._id, platform: 'messenger', status: { $ne: 'disconnected' } }, { external_id: 1, page_id: 1 }).lean(),
    ]);
    const live = all.filter(onPage);
    const inStock = (p) => p.in_stock !== false && (!(p.variant_list ?? []).length || p.variant_list.some((v) => v.stock == null || v.stock > 0));
    const cats = [...new Set(live.map((p) => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const cat = cats.includes(String(req.query.cat ?? '')) ? String(req.query.cat) : '';
    const q = String(req.query.q ?? '').trim().slice(0, 60);
    const ql = q.toLowerCase();
    const shown = live.filter((p) => (!cat || p.category === cat) && (!ql || `${p.name} ${p.code} ${p.category}`.toLowerCase().includes(ql)))
      .sort((a, b) => Number(inStock(b)) - Number(inStock(a)));
    const offer = offerOf(aiCoupons(coupons, now));
    const keep = (extra) => { const p = new URLSearchParams({ ...(token ? { c: token } : {}), ...extra }); const s = p.toString(); return s ? `?${s}` : ''; };
    const initials = String(ws.name).trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    const messageUrl = messenger ? `https://m.me/${encodeURIComponent(messenger.page_id || messenger.external_id)}` : '';

    const tiles = shown.map((p) => {
      const off = p.compare_at > p.price ? Math.round(((p.compare_at - p.price) / p.compare_at) * 100) : 0;
      const photo = p.photos?.[0];
      return `<li><a class="tile" href="/p/${esc(slug)}/${p._id}${token ? `?c=${encodeURIComponent(token)}` : ''}">
<span class="ph">${photo ? `<img src="${esc(photo)}" alt="" loading="lazy">` : `<span class="fill" style="background:${esc(p.colour || '#2f7d78')}"></span>`}${off > 0 ? `<span class="off">-${bnDigits(off)}%</span>` : ''}${inStock(p) ? '' : '<span class="sold">স্টক শেষ</span>'}</span>
<span class="nm">${esc(p.name)}</span><span class="pr"><strong>${taka(p.price)}</strong>${off > 0 ? `<s>${taka(p.compare_at)}</s>` : ''}</span></a></li>`;
    }).join('');

    res.type('html').send(page(`${ws.name} — অনলাইন শপ`, `${STYLE}
<header class="top"><span class="av" aria-hidden="true">${esc(initials)}</span><strong>${esc(ws.name)}</strong></header>
${offer ? `<div class="banner"><small>${offer.until ? `অফার চলবে ${bnDigits(offer.until.getUTCDate())}/${bnDigits(offer.until.getUTCMonth() + 1)} পর্যন্ত` : 'চলতি অফার'}</small><strong>${esc(offer.title)}</strong><code>কোড: ${esc(offer.code)}</code></div>` : ''}
${live.length > 12 ? `<form class="search" method="get" role="search">${token ? `<input type="hidden" name="c" value="${esc(token)}">` : ''}${cat ? `<input type="hidden" name="cat" value="${esc(cat)}">` : ''}<input name="q" value="${esc(q)}" placeholder="পণ্য খুঁজুন" aria-label="পণ্য খুঁজুন"></form>` : ''}
${cats.length ? `<nav class="cats" aria-label="ক্যাটাগরি"><a class="cat${cat ? '' : ' on'}" href="/s/${esc(slug)}${keep(q ? { q } : {})}"${cat ? '' : ' aria-current="page"'}>সব</a>${cats.map((c) => `<a class="cat${c === cat ? ' on' : ''}" href="/s/${esc(slug)}${keep({ cat: c, ...(q ? { q } : {}) })}"${c === cat ? ' aria-current="page"' : ''}>${esc(c)}</a>`).join('')}</nav>` : ''}
${shown.length ? `<ul class="grid">${tiles}</ul>` : `<p class="empty">${live.length ? 'এই খোঁজে কোনো পণ্য পাওয়া যায়নি।' : 'শিগগিরই নতুন পণ্য আসছে।'}</p>`}
${messageUrl ? `<div class="msgbar"><a class="btn primary" style="display:block" href="${esc(messageUrl)}">মেসেজে অর্ডার করুন</a></div>` : ''}
<footer><img src="/brand/favicon.svg" alt="" width="14" height="14" style="vertical-align:-2px;border-radius:3px;margin-right:4px">Powered by HeyQuicky</footer>`, { image: live.find((p) => p.photos?.[0])?.photos[0]?.startsWith('http') ? live.find((p) => p.photos?.[0]).photos[0] : '' }));
  });

  return router;
}

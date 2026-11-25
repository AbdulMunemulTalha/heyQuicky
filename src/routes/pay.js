import { Router, urlencoded } from 'express';
import { GATEWAYS, gatewaySettings, startCheckout, verifyWithGateway, completeCheckout } from '../dashboard/gateway.js';

// PAY-02: the customer's pay page (/pay/:token) — pick bKash, Nagad or card, pay on the gateway's own page,
// come back here. Every payment is checked with the gateway server-to-server before it counts.

const T = {
  bn: {
    lang: 'English', advance: 'অগ্রিম পেমেন্ট', full: 'পুরো পেমেন্ট', deposit: 'বুকিংয়ের অগ্রিম', order: (n) => `অর্ডার #${n}`, pay: 'পেমেন্ট করুন', with: 'যেভাবে দিতে চান',
    sslcommerz: 'কার্ড, বিকাশ, নগদ, রকেট', bkash: 'বিকাশ', nagad: 'নগদ', off: (n) => `${n} ছাড় সহ`,
    paid: 'পেমেন্ট হয়ে গেছে ✅', paidBody: 'ধন্যবাদ! শপ আপনাকে মেসেজে জানিয়ে দিয়েছে।', fail: 'পেমেন্ট হয়নি। আবার চেষ্টা করুন বা অন্যভাবে দিন।', cancel: 'পেমেন্ট বাতিল করেছেন। চাইলে আবার চেষ্টা করুন।',
    error: 'এই মুহূর্তে পেমেন্ট শুরু করা যাচ্ছে না। একটু পরে চেষ্টা করুন বা শপকে মেসেজ করুন।', none: 'এই লিংকটি আর চালু নেই', noneBody: 'শপকে মেসেজ করে নতুন লিংক চান।', bill: 'বিল দেখুন', secure: 'পেমেন্ট গেটওয়ের নিজের পেজে নিরাপদে পেমেন্ট হয়', powered: 'Powered by HeyQuicky',
  },
  en: {
    lang: 'বাংলা', advance: 'Advance payment', full: 'Full payment', deposit: 'Booking deposit', order: (n) => `Order #${n}`, pay: 'Pay', with: 'Pay with',
    sslcommerz: 'Card, bKash, Nagad, Rocket', bkash: 'bKash', nagad: 'Nagad', off: (n) => `includes ${n} off`,
    paid: 'Paid ✅', paidBody: 'Thank you! The shop has let you know in chat.', fail: "The payment didn't go through. Try again or pay another way.", cancel: 'You cancelled the payment. Try again whenever you like.',
    error: "The payment can't start right now. Try again in a bit or message the shop.", none: 'This link is no longer active', noneBody: 'Message the shop for a new one.', bill: 'See the bill', secure: "You pay safely on the gateway's own page", powered: 'Powered by HeyQuicky',
  },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, lang) => { const s = `৳${Number(n).toLocaleString('en-IN')}`; return lang === 'bn' ? s.replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[d]) : s; };

export function payRoutes(db, config, { inbox = null, notify = null, fetchImpl = fetch } = {}) {
  const router = Router();
  const form = urlencoded({ extended: false, limit: '16kb' });
  const load = (token) => (/^[a-f0-9]{16}$/.test(token) ? db.checkouts.findOne({ token }).lean() : null);

  router.get('/pay/:token', async (req, res, next) => {
    try {
      const lang = req.query.lang === 'en' ? 'en' : 'bn';
      const t = T[lang];
      const c = await load(req.params.token);
      res.set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').type('html');
      if (!c || c.status === 'expired') return res.status(404).send(page(lang, t.none, `<section class="card center"><h1>${t.none}</h1><p class="muted">${t.noneBody}</p></section>`));
      const [ws, order, booking] = await Promise.all([
        db.workspaces.findById(c.workspace_id).lean(),
        c.order_id ? db.orders.findById(c.order_id, { number: 1, bill_token: 1 }).lean() : null,
        c.booking_id ? db.bookings.findById(c.booking_id, { service: 1 }).lean() : null,
      ]);
      const { connected } = gatewaySettings(ws);
      const flash = { fail: t.fail, cancel: t.cancel, error: t.error }[req.query.done];
      const L = lang === 'en' ? '<input type="hidden" name="lang" value="en">' : '';
      const body = `
<header class="shop"><span class="logo">${esc((ws?.name ?? 'Shop').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase())}</span><strong class="grow">${esc(ws?.name ?? '')}</strong><a class="lang" href="?${lang === 'en' ? '' : 'lang=en'}">${t.lang}</a></header>
${flash && c.status !== 'paid' ? `<p class="flash err" role="status">${esc(flash)}</p>` : ''}
<section class="hero"><small>${esc(t[c.purpose])} · ${esc(order ? t.order(order.number) : booking?.service ?? '')}</small><h1>${money(c.amount, lang)}</h1>${c.discount ? `<p>${esc(t.off(money(c.discount, lang)))}</p>` : ''}</section>
${c.status === 'paid' ? `<section class="card center"><h2>${t.paid}</h2><p class="muted">${t.paidBody}</p>${order?.bill_token ? `<a class="btn ghost" href="/b/${esc(order.bill_token)}${lang === 'en' ? '?lang=en' : ''}">${t.bill}</a>` : ''}</section>`
    : `<section class="card"><h2>${t.with}</h2>${connected.map((k) => `<form method="post" action="/pay/${c.token}/go">${L}<input type="hidden" name="gateway" value="${k}"><button class="btn gw ${k}">${esc(t[k])}<small>${esc(GATEWAYS[k].name)}</small></button></form>`).join('')}
  <p class="muted small">🔒 ${t.secure}</p></section>`}
<p class="powered"><img src="/brand/favicon.svg" alt="" width="14" height="14" style="vertical-align:-2px;border-radius:3px;margin-right:4px">${t.powered}</p>`;
      res.send(page(lang, `${t.pay} ${money(c.amount, lang)} · ${ws?.name ?? ''}`, body));
    } catch (err) { next(err); }
  });

  router.post('/pay/:token/go', form, async (req, res) => {
    const lang = req.body?.lang === 'en' ? 'en' : 'bn';
    const back = (done) => `/pay/${encodeURIComponent(req.params.token)}?${new URLSearchParams({ ...(lang === 'en' ? { lang } : {}), ...(done ? { done } : {}) })}`;
    try {
      const c = await load(req.params.token);
      if (!c || c.status === 'paid' || !GATEWAYS[req.body?.gateway]) return res.redirect(303, back());
      res.redirect(303, await startCheckout(db, config, c, req.body.gateway, { fetchImpl }));
    } catch (err) {
      console.warn('payment gateway start failed:', err.message);
      await db.checkouts.updateOne({ token: req.params.token }, { $set: { error: String(err.message).slice(0, 200) } }).catch(() => {});
      res.redirect(303, back('error'));
    }
  });

  // The gateway sends the customer back here (SSLCommerz POSTs a form; bKash and Nagad use GET).
  const finish = async (req, res) => {
    const kind = req.params.kind;
    const back = (done) => `/pay/${encodeURIComponent(req.params.token)}${done ? `?done=${done}` : ''}`;
    try {
      const c = await load(req.params.token);
      if (!c || !GATEWAYS[kind]) return res.redirect(303, back());
      if (c.status === 'paid') return res.redirect(303, back());
      const params = { ...req.query, ...(req.body ?? {}) };
      const v = await verifyWithGateway(db, config, c, kind, params, { fetchImpl });
      if (!v.ok) {
        await db.checkouts.updateOne({ _id: c._id, status: { $ne: 'paid' } }, { $set: { status: 'failed', error: v.cancelled ? 'Cancelled by the customer' : 'Not paid' } });
        return res.redirect(303, back(v.cancelled ? 'cancel' : 'fail'));
      }
      const r = await completeCheckout(db, c, { kind, amount: v.amount, trx: v.trx }, { inbox, notify });
      res.redirect(303, back(r.ok ? '' : 'fail'));
    } catch (err) {
      console.warn('payment gateway check failed:', err.message);
      res.redirect(303, back('error'));
    }
  };
  router.get('/pay/:token/back/:kind', finish);
  router.post('/pay/:token/back/:kind', form, finish);

  // SSLCommerz IPN: the same check, in case the customer closed the page before coming back.
  router.post('/pay/ipn/sslcommerz', form, async (req, res) => {
    try {
      const c = await db.checkouts.findOne({ external_id: String(req.body?.tran_id ?? ''), gateway: 'sslcommerz' }).lean();
      if (c && c.status !== 'paid') {
        const v = await verifyWithGateway(db, config, c, 'sslcommerz', req.body ?? {}, { fetchImpl });
        if (v.ok) await completeCheckout(db, c, { kind: 'sslcommerz', amount: v.amount, trx: v.trx }, { inbox, notify });
      }
    } catch (err) { console.warn('SSLCommerz IPN failed:', err.message); }
    res.json({ ok: true });
  });

  return router;
}

function page(lang, title, body) {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><meta name="theme-color" content="#121417">
<style>
*{box-sizing:border-box}body{margin:0;background:#F6F6F2;color:#101217;font:15px/1.5 "Hind Siliguri","Noto Sans Bengali",system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:440px;margin:0 auto;padding:14px 14px 32px;display:flex;flex-direction:column;gap:12px}h1,h2{margin:0;line-height:1.3}h1{font-size:30px}h2{font-size:16px}p{margin:4px 0}small{display:block;font-size:12px}
.muted{color:#6b7280}.small{font-size:12.5px}.grow{flex:1}.center{text-align:center}.shop{display:flex;align-items:center;gap:10px}
.logo{width:38px;height:38px;border-radius:50%;background:#f3e1c8;display:grid;place-items:center;font-weight:700;font-size:13px}
.lang{border:1px solid #e3e3dc;border-radius:8px;padding:5px 10px;font-size:13px;color:#101217;text-decoration:none;background:#fff}
.hero{background:#121417;color:#fff;border-radius:16px;padding:18px}.hero small{color:#b8bcc4}.hero p{color:#d9dbe0;font-size:14px}
.card{background:#fff;border:1px solid #e8e8e1;border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:10px}form{margin:0}
.btn{display:flex;flex-direction:column;justify-content:center;align-items:center;width:100%;min-height:52px;padding:6px 16px;border-radius:12px;border:0;background:#2B4BFF;color:#fff;font:inherit;font-weight:700;text-decoration:none;cursor:pointer}
.btn small{font-weight:400;opacity:.85}.btn.ghost{background:#fff;color:#101217;border:1px solid #d9d9d2}.gw.bkash{background:#e2136e}.gw.nagad{background:#f6921e}.gw.sslcommerz{background:#1d4ed8}
.btn:focus-visible,.lang:focus-visible{outline:3px solid #101217;outline-offset:2px}
.flash{border-radius:10px;padding:10px 12px;margin:0;font-size:14px}.flash.err{background:#fdecec;color:#b42318}.powered{text-align:center;color:#9aa0aa;font-size:12px}
</style></head><body><main>${body}</main></body></html>`;
}

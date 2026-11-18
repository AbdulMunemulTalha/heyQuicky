import { Router, urlencoded } from 'express';
import { bdPhone, asciiDigits } from '../dashboard/util.js';
import { orderTotal } from '../dashboard/orderOps.js';
import { zonesFor } from '../dashboard/orderBuild.js';
import { trackingUrl } from '../platforms/rich.js';

// Screen 20 / ORD-03: the customer's bill — a public page behind an unguessable link (/b/:token),
// Bangla first, readable on any phone without JavaScript. Shows the live status, lets the customer
// ask for an address change, send a bKash / Nagad advance (TrxID), message or call the shop, or ask to cancel.

const STEPS = ['pending', 'approved', 'ready_to_ship', 'in_transit', 'delivered'];
const STAGE = { confirmed: 'pending', shipped: 'in_transit', processing: 'ready_to_ship', on_hold: 'pending' };
const OPEN = ['pending', 'confirmed', 'approved', 'on_hold', 'processing'];

const T = {
  bn: {
    lang: 'English', order: 'অর্ডার', hero: { pending: 'আপনার অর্ডার পাওয়া গেছে', approved: 'আপনার অর্ডার কনফার্ম হয়েছে 🎉', ready_to_ship: 'আপনার পার্সেল প্যাক হচ্ছে 📦', in_transit: 'পার্সেল রাস্তায় আছে 🚚', delivered: 'ডেলিভারি হয়ে গেছে ✅', cancelled: 'অর্ডারটি বাতিল হয়েছে', returned: 'পার্সেলটি ফেরত গেছে' },
    eta: 'আনুমানিক ডেলিভারি', steps: ['অর্ডার পাওয়া গেছে', 'কনফার্ম হয়েছে', 'প্যাক করা হচ্ছে', 'কুরিয়ারে পাঠানো হয়েছে', 'ডেলিভারি হয়েছে'],
    yours: 'আপনার অর্ডার', size: 'সাইজ', qty: 'পরিমাণ', subtotal: 'পণ্যের দাম', delivery: 'ডেলিভারি চার্জ', discount: 'ছাড়', total: 'মোট', advancePaid: 'অগ্রিম দেওয়া',
    cod: (n) => `ক্যাশ অন ডেলিভারি — পণ্য হাতে পেয়ে ${n} দিবেন`, paid: 'পুরো টাকা পরিশোধ হয়েছে',
    address: 'ডেলিভারি ঠিকানা', change: 'পরিবর্তন করুন', newAddress: 'নতুন ঠিকানা', newPhone: 'নতুন ফোন নম্বর (না বদলালে খালি রাখুন)', send: 'পাঠান', cancel: 'বাতিল',
    changeSent: 'অনুরোধ পাঠানো হয়েছে। শপ কনফার্ম করলে ঠিকানা বদলে যাবে।', changePending: 'আপনার পরিবর্তনের অনুরোধ শপ দেখছে।',
    payTitle: 'আগে পেমেন্ট করতে চান?', payBody: 'অগ্রিম দিলে অর্ডার দ্রুত কনফার্ম হয়। বাকি টাকা ডেলিভারির সময়।', bkash: (n) => `bKash দিয়ে ${n} অগ্রিম দিন`, nagad: 'Nagad দিয়ে পেমেন্ট',
    payHow: (m, num) => `${m} অ্যাপ থেকে ${num} নম্বরে Send Money করুন, তারপর TrxID দিন।`, amount: 'টাকার পরিমাণ', trx: 'TrxID', from: 'যে নম্বর থেকে পাঠিয়েছেন', paySent: 'ধন্যবাদ! শপ পেমেন্ট যাচাই করে অর্ডার কনফার্ম করবে।', payWaiting: (n) => `${n} পেমেন্ট যাচাই হচ্ছে`,
    courier: 'কুরিয়ার', tracking: 'ট্র্যাকিং নম্বর', track: 'পার্সেল ট্র্যাক করুন',
    message: 'মেসেজ করুন', call: 'কল করুন', cancelAsk: 'অর্ডার বাতিল করতে চাই', cancelConfirm: 'অর্ডার বাতিলের অনুরোধ পাঠাবেন? শপ আপনার সাথে যোগাযোগ করবে।', cancelSent: 'বাতিলের অনুরোধ পাঠানো হয়েছে। শপ শীঘ্রই যোগাযোগ করবে।',
    powered: 'Powered by HeyQuicky', notFound: 'এই বিলটি পাওয়া যায়নি', notFoundBody: 'লিংকটি ভুল হতে পারে। শপকে মেসেজ করে আবার লিংক চান।', badPhone: 'ফোন নম্বর ১১ সংখ্যার হতে হবে এবং ০১৩–০১৯ দিয়ে শুরু হবে', badTrx: 'TrxID ঠিকমতো লিখুন (৮–১২ অক্ষর)', badAddress: 'নতুন ঠিকানা লিখুন', dupTrx: 'এই TrxID আগেই পাঠানো হয়েছে',
  },
  en: {
    lang: 'বাংলা', order: 'Order', hero: { pending: 'We got your order', approved: 'Your order is confirmed 🎉', ready_to_ship: 'Your parcel is being packed 📦', in_transit: 'Your parcel is on the way 🚚', delivered: 'Delivered ✅', cancelled: 'This order was cancelled', returned: 'This parcel went back' },
    eta: 'Estimated delivery', steps: ['Order received', 'Confirmed', 'Being packed', 'Handed to courier', 'Delivered'],
    yours: 'Your order', size: 'Size', qty: 'Qty', subtotal: 'Items', delivery: 'Delivery charge', discount: 'Discount', total: 'Total', advancePaid: 'Advance paid',
    cod: (n) => `Cash on delivery — pay ${n} when you get the parcel`, paid: 'Paid in full',
    address: 'Delivery address', change: 'Change', newAddress: 'New address', newPhone: 'New phone number (leave empty to keep it)', send: 'Send', cancel: 'Cancel',
    changeSent: 'Request sent. The address changes once the shop confirms.', changePending: 'The shop is looking at your change request.',
    payTitle: 'Want to pay in advance?', payBody: 'Paying an advance confirms your order faster. The rest is paid on delivery.', bkash: (n) => `Pay ${n} advance with bKash`, nagad: 'Pay with Nagad',
    payHow: (m, num) => `Send Money from your ${m} app to ${num}, then enter the TrxID.`, amount: 'Amount', trx: 'TrxID', from: 'Number you sent from', paySent: 'Thank you! The shop will check the payment and confirm your order.', payWaiting: (n) => `${n} payment being checked`,
    courier: 'Courier', tracking: 'Tracking number', track: 'Track parcel',
    message: 'Message', call: 'Call', cancelAsk: 'I want to cancel this order', cancelConfirm: 'Send a cancel request? The shop will contact you.', cancelSent: 'Cancel request sent. The shop will contact you soon.',
    powered: 'Powered by HeyQuicky', notFound: "This bill wasn't found", notFoundBody: 'The link may be wrong. Message the shop for a new one.', badPhone: 'The phone number should be 11 digits and start with 013–019', badTrx: 'Enter the TrxID (8–12 letters and numbers)', badAddress: 'Write the new address', dupTrx: 'This TrxID was already sent',
  },
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const bnNum = (s) => String(s).replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[d]);
const group = (n) => {
  const [int, dec] = Math.abs(Math.round(n * 100) / 100).toFixed(Number.isInteger(n) ? 0 : 2).split('.');
  const g = int.length <= 3 ? int : `${int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${int.slice(-3)}`;
  return dec ? `${g}.${dec}` : g;
};

export function billRoutes(db, config, { notify = null } = {}) {
  const router = Router();
  const form = urlencoded({ extended: false, limit: '8kb' });

  async function load(token) {
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(token)) return null;
    return db.orders.findOne({ bill_token: token, draft: { $ne: true } }).lean();
  }

  router.get('/b/:token', async (req, res, next) => {
    try {
      const lang = req.query.lang === 'en' ? 'en' : 'bn';
      const order = await load(req.params.token);
      if (!order) return res.status(404).type('html').send(page(lang, T[lang].notFound, `<section class="card center"><h1>${esc(T[lang].notFound)}</h1><p class="muted">${esc(T[lang].notFoundBody)}</p></section>`));
      res.set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').type('html').send(await render(order, lang, req.query.done));
    } catch (err) { next(err); }
  });

  // Ask for a different address (or phone): becomes the order's change request (ORD-07) for the shop to accept.
  router.post('/b/:token/change', form, async (req, res, next) => {
    try {
      const lang = req.body.lang === 'en' ? 'en' : 'bn';
      const order = await load(req.params.token);
      if (!order || !OPEN.includes(order.status)) return res.redirect(303, back(req, lang));
      const address = String(req.body.address ?? '').trim().slice(0, 300);
      const phoneRaw = String(req.body.phone ?? '').trim();
      if (!address && !phoneRaw) return res.redirect(303, back(req, lang, 'err-address'));
      let field = 'address';
      let value = address;
      if (!address) {
        const phone = bdPhone(phoneRaw);
        if (!phone) return res.redirect(303, back(req, lang, 'err-phone'));
        field = 'phone';
        value = phone;
      }
      await db.orders.updateOne({ _id: order._id }, { $set: { change_request: { field, old: field === 'address' ? order.address : order.phone, new: value, at: new Date(), status: 'open', by: 'customer' }, details_changed: true } });
      await db.insert(db.orderEvents, { workspace_id: order.workspace_id, order_id: order._id, type: 'change', by: 'customer', text: `Customer asked to change the ${field} from the bill page` });
      await notify?.({ workspaceId: order.workspace_id, event: 'escalation', title: `${order.customer_name} wants to change the ${field}`, body: `on order #${order.number ?? order._id}: "${value.slice(0, 80)}"`, link: `/orders/${order.number ?? order._id}`, ref: `change:${order._id}:${value}` });
      res.redirect(303, back(req, lang, 'change'));
    } catch (err) { next(err); }
  });

  // An advance sent by bKash / Nagad: waits in Payments for the shop to approve (PAY-01).
  router.post('/b/:token/pay', form, async (req, res, next) => {
    try {
      const lang = req.body.lang === 'en' ? 'en' : 'bn';
      const order = await load(req.params.token);
      if (!order || !OPEN.includes(order.status) || order.paid_in_full) return res.redirect(303, back(req, lang));
      const method = req.body.method === 'nagad' ? 'nagad' : 'bkash';
      const trx = asciiDigits(String(req.body.trx ?? '')).trim().toUpperCase();
      if (!/^[A-Z0-9]{8,12}$/.test(trx)) return res.redirect(303, back(req, lang, 'err-trx'));
      if (await db.payments.exists({ workspace_id: order.workspace_id, trx_id: trx })) return res.redirect(303, back(req, lang, 'err-dup'));
      const amount = Math.max(1, Math.min(Number(asciiDigits(String(req.body.amount ?? '')).replace(/[^\d.]/g, '')) || 0, orderTotal(order)));
      const ws = await db.workspaces.findById(order.workspace_id, { settings: 1 }).lean();
      const expected = order.advance?.amount || ws?.settings?.advance?.amount || null;
      await db.insert(db.payments, { workspace_id: order.workspace_id, order_id: order._id, method, amount, expected, trx_id: trx, from_number: bdPhone(req.body.from) ?? String(req.body.from ?? '').slice(0, 20) });
      await notify?.({ workspaceId: order.workspace_id, event: 'order', title: `${order.customer_name} sent ৳${group(amount)} by ${method === 'bkash' ? 'bKash' : 'Nagad'}`, body: `for order #${order.number ?? order._id} · TrxID ${trx} — check and approve it`, link: `/orders/${order.number ?? order._id}`, ref: `pay:${trx}` });
      res.redirect(303, back(req, lang, 'pay'));
    } catch (err) { next(err); }
  });

  // "I want to cancel": the shop decides (and can call); nothing is cancelled automatically.
  router.post('/b/:token/cancel', form, async (req, res, next) => {
    try {
      const lang = req.body.lang === 'en' ? 'en' : 'bn';
      const order = await load(req.params.token);
      if (!order || !OPEN.includes(order.status)) return res.redirect(303, back(req, lang));
      if (!order.cancel_requested_at) {
        await db.orders.updateOne({ _id: order._id }, { $set: { cancel_requested_at: new Date() } });
        await db.insert(db.orderEvents, { workspace_id: order.workspace_id, order_id: order._id, type: 'note', by: 'customer', text: 'Customer asked to cancel from the bill page' });
        await notify?.({ workspaceId: order.workspace_id, event: 'escalation', title: `${order.customer_name} wants to cancel order #${order.number ?? order._id}`, body: 'Call them before it ships.', link: `/orders/${order.number ?? order._id}`, ref: `cancelreq:${order._id}` });
      }
      res.redirect(303, back(req, lang, 'cancel'));
    } catch (err) { next(err); }
  });

  const back = (req, lang, done) => `/b/${encodeURIComponent(req.params.token)}?${new URLSearchParams({ ...(lang === 'en' ? { lang } : {}), ...(done ? { done } : {}) })}`;

  async function render(order, lang, done) {
    const t = T[lang];
    const num = (n) => (lang === 'bn' ? bnNum(n) : String(n));
    const money = (n) => `৳${num(group(n))}`;
    const [ws, events, products, channel, pending] = await Promise.all([
      db.workspaces.findById(order.workspace_id).lean(),
      db.orderEvents.find({ order_id: order._id, type: 'status' }).sort({ created_at: 1 }).lean(),
      db.products.find({ _id: { $in: (order.product_items ?? []).map((i) => i.product_id).filter(Boolean) } }, { photos: 1, colour: 1 }).lean(),
      order.conversation_id ? db.conversations.findById(order.conversation_id, { channel_id: 1 }).lean().then((c) => (c ? db.channels.findById(c.channel_id).lean() : null)) : null,
      db.payments.findOne({ order_id: order._id, status: 'waiting' }).lean(),
    ]);
    const owner = await db.users.findOne({ workspace_id: order.workspace_id, role: 'owner' }, { phone: 1 }).lean();
    const page_ = channel ?? await db.channels.findOne({ workspace_id: order.workspace_id, platform: 'messenger' }).lean();
    const shopPhone = ws?.phone || owner?.phone || '';
    const stage = STAGE[order.status] ?? order.status;
    const stepIndex = STEPS.indexOf(stage);
    const at = (s) => events.find((e) => (STAGE[e.to] ?? e.to) === s)?.created_at ?? (s === 'pending' ? order.created_at : null);
    const time = (d) => new Date(d).toLocaleString(lang === 'bn' ? 'bn-BD' : 'en-US', { hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short', timeZone: 'Asia/Dhaka' });
    const day = (d) => new Date(d).toLocaleDateString(lang === 'bn' ? 'bn-BD' : 'en-GB', { day: 'numeric', month: 'long', timeZone: 'Asia/Dhaka' });
    const zone = zonesFor(ws ?? {}).find((z) => z.key === (order.zone || order.area)) ?? zonesFor(ws ?? {})[0];
    const [dMin, dMax] = String(zone?.days ?? '').match(/\d+/g)?.map(Number) ?? [];
    const eta = dMin ? `${day(new Date(order.created_at.getTime() + dMin * 86_400_000))}${dMax ? ` – ${day(new Date(order.created_at.getTime() + dMax * 86_400_000))}` : ''}` : '';
    const photo = new Map(products.map((p) => [p._id, p]));
    const total = orderTotal(order);
    const advance = order.advance_paid || (order.advance?.verified ? order.advance.amount : 0) || 0;
    const cod = order.paid_in_full ? 0 : Math.max(0, total - advance);
    const open = OPEN.includes(order.status);
    const hero = t.hero[order.status] ?? t.hero[stage] ?? t.hero.pending;
    const items = (order.product_items?.length ? order.product_items : order.items ?? []);
    const msgLink = page_?.platform === 'messenger' && /^\d+$/.test(page_.external_id ?? '') ? `https://m.me/${page_.external_id}`
      : page_?.platform === 'whatsapp' ? `https://wa.me/${String(page_.name ?? '').replace(/\D/g, '').replace(/^0/, '880')}` : '';
    const flash = { change: t.changeSent, pay: t.paySent, cancel: t.cancelSent, 'err-phone': t.badPhone, 'err-trx': t.badTrx, 'err-address': t.badAddress, 'err-dup': t.dupTrx }[done];
    const advanceAmount = order.advance?.amount || ws?.settings?.advance?.amount || 300;
    const courier = order.courier ? String(order.courier).toLowerCase() : '';
    const track = trackingUrl(courier, order.consignment_id);
    const L = lang === 'en' ? '<input type="hidden" name="lang" value="en">' : '';

    const body = `
<header class="shop">
  <span class="logo">${esc((ws?.name ?? 'Shop').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase())}</span>
  <div class="grow"><strong>${esc(ws?.name ?? '')}</strong>${ws?.tagline ? `<small>${esc(ws.tagline)}</small>` : ''}</div>
  <a class="lang" href="?${lang === 'en' ? '' : 'lang=en'}">${t.lang}</a>
</header>
${flash ? `<p class="flash${String(done).startsWith('err') ? ' err' : ''}" role="status">${esc(flash)}</p>` : ''}
<section class="hero${['cancelled', 'returned'].includes(order.status) ? ' gray' : ''}">
  <small>${t.order} #${num(order.number ?? order._id)} · ${esc(day(order.created_at))}</small>
  <h1>${esc(hero)}</h1>
  ${eta && open ? `<p>${t.eta}: ${esc(eta)}</p>` : ''}
</section>
${['cancelled', 'returned'].includes(order.status) ? '' : `<section class="card"><ol class="steps">${STEPS.map((s, i) => {
    const state = i < stepIndex || (i === stepIndex && stage === 'delivered') ? 'done' : i === stepIndex ? 'now' : '';
    const when = i <= stepIndex ? at(s) : null;
    return `<li class="${state}"><span class="dot">${state === 'done' ? '✓' : num(i + 1)}</span><span class="grow">${t.steps[i]}</span>${when ? `<time>${esc(time(when))}</time>` : ''}</li>`;
  }).join('')}</ol></section>`}
${courier && ['in_transit', 'delivered', 'shipped'].includes(order.status) ? `<section class="card"><div class="row"><span class="grow"><small class="muted">${t.courier}</small><strong>${esc(order.courier)}</strong></span>${order.consignment_id ? `<span><small class="muted">${t.tracking}</small><strong>${esc(order.consignment_id)}</strong></span>` : ''}</div>${track ? `<a class="btn ghost full" href="${esc(track)}" target="_blank" rel="noopener">${t.track}</a>` : ''}</section>` : ''}
<section class="card">
  <h2>${t.yours}</h2>
  ${items.map((i) => {
    const p = photo.get(i.product_id);
    const img = p?.photos?.[0] ? `<img src="${esc(p.photos[0])}" alt="">` : `<span class="sw" style="background:${esc(p?.colour || '#e8ddd0')}"></span>`;
    return `<div class="item">${img}<div class="grow"><strong>${esc(i.name)}</strong><small class="muted">${i.variant ? `${t.size} ${esc(i.variant)} · ` : ''}${t.qty} ${num(i.qty ?? 1)}</small></div><strong>${money((i.price ?? 0) * (i.qty ?? 1))}</strong></div>`;
  }).join('')}
  <dl class="sums">
    <div><dt>${t.subtotal}</dt><dd>${money(order.subtotal ?? 0)}</dd></div>
    <div><dt>${t.delivery}</dt><dd>${money(order.delivery_charge ?? 0)}</dd></div>
    ${order.discount ? `<div><dt>${t.discount}</dt><dd>−${money(order.discount)}</dd></div>` : ''}
    ${advance ? `<div><dt>${t.advancePaid}</dt><dd>−${money(advance)}</dd></div>` : ''}
    <div class="total"><dt>${t.total}</dt><dd>${money(total)}</dd></div>
  </dl>
  <p class="note">${order.paid_in_full || cod === 0 ? t.paid : esc(t.cod(money(cod)))}</p>
</section>
<section class="card">
  <div class="row"><h2 class="grow">${t.address}</h2>${open && order.change_request?.status !== 'open' ? `<a href="#change" class="link">${t.change}</a>` : ''}</div>
  <p><strong>${esc(order.customer_name)}</strong> · ${esc(num(order.phone ?? ''))}</p>
  <p class="muted">${esc(order.address)}</p>
  ${order.change_request?.status === 'open' ? `<p class="note">${t.changePending}</p>` : ''}
  ${open && order.change_request?.status !== 'open' ? `<form id="change" class="sheet" method="post" action="/b/${esc(order.bill_token)}/change">${L}
    <label>${t.newAddress}<textarea name="address" rows="2" maxlength="300"></textarea></label>
    <label>${t.newPhone}<input name="phone" inputmode="tel" maxlength="20"></label>
    <div class="row"><a class="btn ghost" href="#">${t.cancel}</a><button class="btn">${t.send}</button></div></form>` : ''}
</section>
${open && !order.paid_in_full && (ws?.bkash_number || ws?.nagad_number) ? `<section class="card">
  <h2>${t.payTitle}</h2><p class="muted">${t.payBody}</p>
  ${pending ? `<p class="note">${esc(t.payWaiting(money(pending.amount)))}</p>` : `
  ${ws.bkash_number ? `<a class="btn bkash full" href="#pay-bkash">${esc(t.bkash(money(advanceAmount)))}</a>` : ''}
  ${ws.nagad_number ? `<a class="btn nagad full" href="#pay-nagad">${t.nagad}</a>` : ''}
  ${['bkash', 'nagad'].filter((m) => ws[`${m}_number`]).map((m) => `<form id="pay-${m}" class="sheet" method="post" action="/b/${esc(order.bill_token)}/pay">${L}<input type="hidden" name="method" value="${m}">
    <p>${esc(t.payHow(m === 'bkash' ? 'bKash' : 'Nagad', num(ws[`${m}_number`])))}</p>
    <label>${t.amount}<input name="amount" inputmode="numeric" value="${advanceAmount}" required></label>
    <label>${t.trx}<input name="trx" required maxlength="12" autocapitalize="characters"></label>
    <label>${t.from}<input name="from" inputmode="tel" maxlength="20"></label>
    <div class="row"><a class="btn ghost" href="#">${t.cancel}</a><button class="btn">${t.send}</button></div></form>`).join('')}`}
</section>` : ''}
<div class="row actions">
  ${msgLink ? `<a class="btn" href="${esc(msgLink)}">${t.message}</a>` : ''}
  ${shopPhone ? `<a class="btn ghost" href="tel:${esc(shopPhone)}">${t.call}</a>` : ''}
</div>
${open && !order.cancel_requested_at ? `<form method="post" action="/b/${esc(order.bill_token)}/cancel" class="center" onsubmit="return confirm(${esc(JSON.stringify(t.cancelConfirm))})">${L}<button class="link danger">${t.cancelAsk}</button></form>` : ''}
<p class="powered">⚡ ${t.powered}</p>`;
    return page(lang, `${t.order} #${order.number ?? order._id} · ${ws?.name ?? ''}`, body);
  }

  return router;
}

function page(lang, title, body) {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><meta name="theme-color" content="#121417">
<style>
*{box-sizing:border-box}body{margin:0;background:#F6F6F2;color:#101217;font:15px/1.5 "Hind Siliguri","Noto Sans Bengali",system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:480px;margin:0 auto;padding:14px 14px 32px;display:flex;flex-direction:column;gap:12px}
h1,h2{margin:0;line-height:1.3}h1{font-size:21px}h2{font-size:16px}p{margin:4px 0}small{display:block;font-size:12px}
.muted{color:#6b7280}.grow{flex:1;min-width:0}.row{display:flex;align-items:center;gap:10px}.center{text-align:center}
.shop{display:flex;align-items:center;gap:10px}.shop strong{display:block}.logo{width:38px;height:38px;border-radius:50%;background:#f3e1c8;display:grid;place-items:center;font-weight:700;font-size:13px}
.lang{border:1px solid #e3e3dc;border-radius:8px;padding:5px 10px;font-size:13px;color:#101217;text-decoration:none;background:#fff}
.hero{background:#121417;color:#fff;border-radius:16px;padding:18px}.hero small{color:#b8bcc4}.hero p{color:#d9dbe0;font-size:14px}.hero.gray{background:#4b5160}
.card{background:#fff;border:1px solid #e8e8e1;border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:8px}
.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:14px;position:relative}
.steps li{display:flex;align-items:center;gap:10px;color:#9aa0aa;position:relative}.steps li:not(:last-child)::after{content:"";position:absolute;left:10px;top:24px;height:14px;border-left:2px solid #e3e3dc}
.steps li.done{color:#101217}.steps li.done::after{border-color:#1f9d55}.steps li.now{color:#101217;font-weight:700}
.dot{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-size:11px;background:#eceee8;color:#6b7280;flex:none}
.done .dot{background:#1f9d55;color:#fff}.now .dot{background:#2B4BFF;color:#fff}time{font-size:12px;color:#6b7280;font-weight:400}
.item{display:flex;align-items:center;gap:12px;padding:4px 0}.item img,.sw{width:52px;height:52px;border-radius:10px;object-fit:cover;flex:none;display:block}
.sums{margin:6px 0 0;border-top:1px solid #eee;padding-top:8px;display:flex;flex-direction:column;gap:6px}.sums div{display:flex;justify-content:space-between}.sums dd{margin:0}.sums .total{font-weight:700;font-size:16px}
.note{background:#fff6dc;border-radius:8px;padding:8px 10px;font-size:13px}
.btn{display:inline-flex;justify-content:center;align-items:center;gap:6px;height:46px;padding:0 16px;border-radius:12px;border:0;background:#2B4BFF;color:#fff;font:inherit;font-weight:600;text-decoration:none;cursor:pointer;flex:1}
.btn.ghost{background:#fff;color:#101217;border:1px solid #d9d9d2}.btn.full{width:100%;flex:none}.btn.bkash{background:#e2136e}.btn.nagad{background:#f6921e}
.link{background:none;border:0;color:#2B4BFF;font:inherit;font-size:14px;cursor:pointer;text-decoration:none;padding:6px}.link.danger{color:#b42318}
.sheet{display:none;flex-direction:column;gap:8px;border-top:1px dashed #ddd;padding-top:10px}.sheet:target{display:flex}
label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:#4b5160}input,textarea{font:inherit;padding:10px 12px;border:1px solid #d9d9d2;border-radius:10px;background:#fff}
.flash{background:#e7f6ee;color:#14532d;border-radius:10px;padding:10px 12px;margin:0;font-size:14px}.flash.err{background:#fdecec;color:#b42318}
.actions .btn{flex:1}.powered{text-align:center;color:#9aa0aa;font-size:12px}
</style></head><body><main>${body}</main></body></html>`;
}

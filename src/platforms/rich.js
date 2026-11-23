// Rich messages (screen 24): product cards, quick replies, the order summary, delivery updates and the
// review request. Each builder returns { kind, payload, text }:
//   payload — a neutral description the dashboard draws exactly like frame 24;
//   text    — a plain fallback (and the chat-list preview) used where a platform can't show the card.
// toPlatform() turns the payload into what Messenger, Instagram or WhatsApp accept.

// Public tracking pages per courier.
const TRACK = {
  steadfast: (c) => `https://steadfast.com.bd/t/${encodeURIComponent(c)}`,
  pathao: (c) => `https://merchant.pathao.com/tracking?consignment_id=${encodeURIComponent(c)}`,
  redx: (c) => `https://redx.com.bd/track-global-parcel/?trackingId=${encodeURIComponent(c)}`,
};
export const trackingUrl = (courier, code) => (courier && code ? TRACK[String(courier).toLowerCase()]?.(code) ?? '' : '');

const taka = (n) => `৳${Number(n ?? 0).toLocaleString('en-IN')}`;
const clip = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));

// Postback payloads coming back from button taps: "HQ:<action>:<id>".
export const postback = (action, id = '') => `HQ:${action}:${id}`;
export function parsePostback(value) {
  const m = /^HQ:([A-Z_]+):([\w-]*)$/.exec(String(value ?? ''));
  return m ? { action: m[1], id: m[2] } : null;
}

// CAT-03: up to 10 product cards (Messenger's limit). Only products the AI may sell, priced live.
// pageUrl(product) gives the product page link (ORD-04) for a "Buy now" button, or '' for none.
export function productCards(products, { publicUrl = '', pageUrl = null } = {}) {
  const sellable = products.filter((p) => p && !p.archived && p.visibility !== 'hidden').slice(0, 10);
  const cards = sellable.map((p) => {
    const left = (p.variant_list ?? []).filter((v) => v.stock === null || v.stock === undefined || v.stock > 0);
    const sizes = left.map((v) => Object.values(v.options ?? {}).join(' / ')).filter(Boolean);
    const inStock = p.in_stock !== false && (!(p.variant_list ?? []).length || left.length > 0);
    return {
      productId: p._id, title: p.name, price: p.price, compareAt: p.compare_at > p.price ? p.compare_at : null, inStock, sizes: sizes.slice(0, 8),
      image: p.photos?.[0] ? absolute(p.photos[0], publicUrl) : '', colour: p.colour || '',
      code: p.code || '',
      pageUrl: (inStock && pageUrl?.(p)) || '',
      buttons: inStock ? [{ type: 'postback', title: 'এটা চাই', value: postback('ORDER', p._id) }, ...(pageUrl?.(p) ? [{ type: 'url', title: 'এখনই কিনুন', value: pageUrl(p) }] : []), ...(p.size_chart_id ? [{ type: 'postback', title: 'সাইজ চার্ট', value: postback('SIZE', p._id) }] : [])]
        : [{ type: 'postback', title: 'স্টকে এলে জানান', value: postback('NOTIFY', p._id) }],
    };
  });
  const text = cards.map((c) => `${c.title} — ${taka(c.price)}${c.compareAt ? ` (আগে ${taka(c.compareAt)})` : ''}${c.inStock ? (c.sizes.length ? ` · ${c.sizes.join(', ')}` : '') : ' · স্টক শেষ'}`).join('\n');
  return { kind: 'carousel', payload: { cards }, text };
}

// Quick reply chips (≤ 13 on Messenger, 3 buttons on WhatsApp).
export function quickReplies(text, options) {
  const opts = options.slice(0, 13).map((o) => (typeof o === 'string' ? { title: o, value: o } : o));
  return { kind: 'quick_replies', payload: { text, options: opts }, text };
}

// CAT-05 / AI-14: a size chart — the shop's image if it uploaded one, otherwise the table as text with a
// link to the chart page — and the sizes as tap-to-answer choices.
export function sizeChartMessage(chart, { productName = '', publicUrl = '' } = {}) {
  const unit = chart.unit === 'cm' ? 'সেমি' : 'ইঞ্চি';
  const sizes = (chart.rows ?? []).map((r) => r[0]).filter(Boolean).slice(0, 10);
  const image = chart.image ? absolute(chart.image, publicUrl) : '';
  const url = chart.token && publicUrl ? `${publicUrl.replace(/\/+$/, '')}/size/${chart.token}` : '';
  const table = [(chart.columns ?? []).join(' | '), ...(chart.rows ?? []).map((r) => r.join(' | '))].join('\n');
  const text = [
    `${productName || chart.name} — সাইজ চার্ট (${unit})`,
    image ? '' : table,
    chart.how_to ? `মাপ নেওয়ার নিয়ম: ${chart.how_to}` : '',
    url ? `পুরো চার্ট: ${url}` : '',
    'আপনার কোন সাইজ লাগবে?',
  ].filter(Boolean).join('\n\n');
  return { kind: 'size_chart', payload: { name: chart.name, productName, unit: chart.unit, columns: chart.columns ?? [], rows: chart.rows ?? [], howTo: chart.how_to ?? '', image, url, options: sizes.map((s) => ({ title: s, value: s })) }, text };
}

// ORD-02 / ORD-11: the order summary the customer confirms in chat, with the bill link.
export function orderSummary(order, { billUrl = '' } = {}) {
  const items = (order.product_items?.length ? order.product_items : order.items ?? []).map((i) => ({ name: i.name, variant: i.variant ?? '', qty: i.qty ?? 1, price: i.price ?? 0 }));
  const total = (order.subtotal ?? 0) + (order.delivery_charge ?? 0) - (order.discount ?? 0);
  const advance = order.advance_paid || (order.advance?.verified ? order.advance.amount : 0) || 0;
  const cod = order.paid_in_full ? 0 : Math.max(0, total - advance);
  const confirmed = !['pending', 'confirmed', 'on_hold'].includes(order.status);
  const payload = {
    orderId: order._id, number: order.number ?? order._id, status: order.status, items, subtotal: order.subtotal ?? 0, delivery: order.delivery_charge ?? 0,
    discount: order.discount ?? 0, total, cod, name: order.customer_name, phone: order.phone, address: order.address, billUrl,
    buttons: [
      ...(!confirmed ? [{ type: 'postback', title: 'হ্যাঁ, কনফার্ম', value: postback('CONFIRM', order._id) }] : []),
      ...(billUrl ? [{ type: 'url', title: confirmed ? 'বিল ও ট্র্যাকিং' : 'পরিবর্তন করুন', value: billUrl }] : []),
    ],
  };
  const text = [
    `${confirmed ? '✅ অর্ডার' : '🧾 অর্ডার'} #${payload.number}${confirmed ? ' কনফার্ম হয়েছে' : ''}`,
    ...items.map((i) => `${i.name}${i.variant ? ` (${i.variant})` : ''} × ${i.qty} — ${taka(i.price * i.qty)}`),
    `ডেলিভারি: ${taka(payload.delivery)}`,
    cod ? `ক্যাশ অন ডেলিভারি: ${taka(cod)}` : 'পেমেন্ট সম্পূর্ণ',
    ...(billUrl ? [`বিল ও ট্র্যাকিং: ${billUrl}`] : []),
  ].join('\n');
  return { kind: 'order_summary', payload, text };
}

// CRR-03/04: a delivery update card — packed, on the way, delivered.
export function deliveryUpdate(order, { trackUrl = '', billUrl = '' } = {}) {
  const head = { ready_to_ship: '📦 আপনার পার্সেল প্যাক হয়েছে', in_transit: '🚚 আপনার পার্সেল রাস্তায় আছে', delivered: '✅ পার্সেল ডেলিভারি হয়েছে', returned: 'পার্সেলটি ফেরত এসেছে' }[order.status] ?? `অর্ডার #${order.number ?? order._id} আপডেট`;
  const sub = [order.courier && `${order.courier}${order.consignment_id ? ` · ${order.consignment_id}` : ''}`, order.status === 'in_transit' && order.cod_amount ? `হাতে পেয়ে ${taka(order.cod_amount)} দিবেন` : ''].filter(Boolean).join(' · ');
  const payload = {
    orderId: order._id, number: order.number ?? order._id, status: order.status, title: head, subtitle: sub, courier: order.courier ?? '', tracking: order.consignment_id ?? '',
    buttons: [...(trackUrl ? [{ type: 'url', title: 'ট্র্যাক করুন', value: trackUrl }] : []), ...(billUrl ? [{ type: 'url', title: 'বিল দেখুন', value: billUrl }] : [])],
  };
  return { kind: 'delivery_card', payload, text: [`${head} — অর্ডার #${payload.number}`, sub, trackUrl && `ট্র্যাক: ${trackUrl}`].filter(Boolean).join('\n') };
}

// CRR-06: after delivery, a one-tap rating.
export function reviewRequest(order) {
  const text = `অর্ডার #${order.number ?? order._id} কেমন লাগলো? এক ট্যাপে জানান 🙏`;
  const options = [['😍 দারুণ', 5], ['🙂 ভালো', 4], ['😐 ঠিক আছে', 3], ['😞 ভালো না', 1]].map(([title, n]) => ({ title, value: postback('RATE', `${order._id}-${n}`) }));
  return { kind: 'review_request', payload: { orderId: order._id, number: order.number ?? order._id, text, options }, text };
}

function absolute(url, base) {
  if (/^https:\/\//.test(url)) return url;
  return base ? `${base.replace(/\/+$/, '')}${url.startsWith('/') ? '' : '/'}${url}` : '';
}

// Neutral payload → the message object a platform accepts. Returns null when the platform needs the text fallback.
export function toPlatform(platform, { kind, payload, text }) {
  if (platform === 'whatsapp') return whatsapp(kind, payload, text);
  // Messenger and Instagram share the Send API shape for templates and quick replies.
  const btn = (b) => (b.type === 'url' ? { type: 'web_url', url: b.value, title: clip(b.title, 20) }
    : b.type === 'phone' ? { type: 'phone_number', title: clip(b.title, 20), payload: b.value } : { type: 'postback', title: clip(b.title, 20), payload: b.value });
  switch (kind) {
    case 'carousel':
      return { attachment: { type: 'template', payload: { template_type: 'generic', elements: payload.cards.map((c) => ({
        title: clip(c.title, 80),
        subtitle: clip(`${taka(c.price)}${c.compareAt ? ` (আগে ${taka(c.compareAt)})` : ''}${c.inStock ? (c.sizes.length ? ` · ${c.sizes.join(', ')}` : '') : ' · স্টক শেষ'}`, 80),
        ...(c.image ? { image_url: c.image } : {}),
        buttons: c.buttons.slice(0, 3).map(btn),
      })) } } };
    case 'quick_replies':
      return { text: clip(payload.text, 2000), quick_replies: payload.options.map((o) => ({ content_type: 'text', title: clip(o.title, 20), payload: o.value })) };
    case 'review_request':
      return { text: clip(payload.text, 2000), quick_replies: payload.options.map((o) => ({ content_type: 'text', title: clip(o.title, 20), payload: o.value })) };
    case 'size_chart': {
      const quick = payload.options.length ? { quick_replies: payload.options.map((o) => ({ content_type: 'text', title: clip(o.title, 20), payload: o.value })) } : {};
      // A photo can carry the size choices too; without one, the table goes as text.
      return payload.image ? { attachment: { type: 'image', payload: { url: payload.image, is_reusable: true } }, ...quick } : { text: clip(text, 2000), ...quick };
    }
    case 'quote':
      return { attachment: { type: 'template', payload: { template_type: 'button', text: clip(text, 640), buttons: payload.buttons.slice(0, 3).map(btn) } } };
    case 'order_summary':
    case 'delivery_card': {
      const title = kind === 'order_summary' ? `অর্ডার #${payload.number} · ${taka(payload.total)}` : payload.title;
      const subtitle = kind === 'order_summary' ? payload.items.map((i) => `${i.name}${i.variant ? ` (${i.variant})` : ''} ×${i.qty}`).join(', ') + (payload.cod ? ` · COD ${taka(payload.cod)}` : '') : payload.subtitle || `অর্ডার #${payload.number}`;
      if (!payload.buttons.length) return null;
      return { attachment: { type: 'template', payload: { template_type: 'generic', elements: [{ title: clip(title, 80), subtitle: clip(subtitle, 80), buttons: payload.buttons.slice(0, 3).map(btn) }] } } };
    }
    default:
      return null;
  }
}

function whatsapp(kind, payload, text) {
  // WhatsApp interactive messages: reply buttons (≤ 3, 20 chars) or a list. URLs stay in the body text.
  const buttons = (list) => list.filter((b) => b.type === 'postback').slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.value.slice(0, 256), title: clip(b.title, 20) } }));
  if ((kind === 'order_summary' || kind === 'quote') && payload.buttons.some((b) => b.type === 'postback')) {
    return { type: 'interactive', interactive: { type: 'button', body: { text: clip(text, 1024) }, action: { buttons: buttons(payload.buttons) } } };
  }
  if (kind === 'size_chart' && payload.image) return { type: 'image', image: { link: payload.image, caption: clip(text, 1024) } };
  if (kind === 'quick_replies' || kind === 'review_request' || kind === 'size_chart') {
    const opts = payload.options.map((o) => ({ type: 'postback', title: o.title, value: o.value }));
    if (!opts.length) return null;
    const bodyText = kind === 'size_chart' ? text : payload.text;
    if (opts.length <= 3) return { type: 'interactive', interactive: { type: 'button', body: { text: clip(bodyText, 1024) }, action: { buttons: buttons(opts) } } };
    return { type: 'interactive', interactive: { type: 'list', body: { text: clip(bodyText, 1024) }, action: { button: 'বেছে নিন', sections: [{ title: 'Options', rows: opts.slice(0, 10).map((o) => ({ id: o.value.slice(0, 200), title: clip(o.title, 24) })) }] } } };
  }
  return null; // carousels and delivery cards go as text with links on WhatsApp
}

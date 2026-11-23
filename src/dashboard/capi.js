import { createHash } from 'node:crypto';
import { decryptSecret } from '../secrets.js';

// ANL-09 · Meta Conversions API: confirmed sales (and leads) are reported to the shop's Meta pixel from
// the server, so ads optimise on real orders, not just messages. Settings → Integrations.
export const CAPI_EVENTS = {
  purchase: { name: 'Purchase', dflt: true },        // an order is confirmed
  lead: { name: 'Lead', dflt: true },                // a customer gives their phone (the AI prepares an order)
  add_to_cart: { name: 'AddToCart', dflt: false },   // the AI sends the order summary
  delivered: { name: 'Delivered', dflt: true },      // an order is delivered (custom event)
};

const sha = (v) => createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
// Bangladeshi mobile → E.164 digits without "+", as Meta wants before hashing: 01712345678 → 8801712345678.
export const normPhone = (p) => { const d = String(p ?? '').replace(/\D/g, ''); return d.startsWith('880') ? d : d.startsWith('0') ? `88${d}` : d; };

export function capiSettings(ws) {
  const c = ws?.settings?.capi ?? {};
  return {
    pixelId: c.pixel_id || '', connected: Boolean(c.pixel_id && c.token), testCode: c.test_code || '',
    events: Object.fromEntries(Object.entries(CAPI_EVENTS).map(([k, e]) => [k, typeof c.events?.[k] === 'boolean' ? c.events[k] : e.dflt])),
  };
}

// The event Meta receives. User data is hashed (phone, first and last name, city, country).
export function buildEvent(key, order, { now = new Date() } = {}) {
  const [fn, ...rest] = String(order.customer_name ?? '').trim().split(/\s+/);
  const total = (order.subtotal ?? 0) + (order.delivery_charge ?? 0) - (order.discount ?? 0);
  const user = { country: [sha('bd')] };
  if (order.phone) user.ph = [sha(normPhone(order.phone))];
  if (fn) user.fn = [sha(fn)];
  if (rest.length) user.ln = [sha(rest.join(' '))];
  if (order.district) user.ct = [sha(order.district.replace(/\s+/g, ''))];
  if (order.customer_id) user.external_id = [sha(`customer-${order.customer_id}`)];
  return {
    event_name: CAPI_EVENTS[key].name, event_time: Math.floor(now.getTime() / 1000), event_id: `${key}-${order._id}`, action_source: 'chat',
    user_data: user, custom_data: { currency: 'BDT', value: total, order_id: String(order.number ?? order._id), content_type: 'product', num_items: (order.items ?? []).reduce((s, i) => s + (i.qty ?? 1), 0) },
  };
}

export function createCapi(db, config, { fetchImpl = globalThis.fetch, log = console } = {}) {
  async function send(key, order) {
    const ws = await db.workspaces.findById(order.workspace_id, { settings: 1 }).lean();
    const s = capiSettings(ws);
    if (!s.connected || !s.events[key]) return 'off';
    // Each event goes once per order (Meta also de-duplicates on event_id).
    if (await db.capiEvents.exists({ workspace_id: order.workspace_id, key, order_id: order._id })) return 'already';
    const event = buildEvent(key, order);
    let status = 'sent';
    let error = '';
    if (config.dryRun) status = 'test';
    else {
      try {
        const token = decryptSecret(ws.settings.capi.token, config.tokenKey);
        const res = await fetchImpl(`https://graph.facebook.com/${config.meta?.graphVersion || 'v21.0'}/${encodeURIComponent(s.pixelId)}/events?access_token=${encodeURIComponent(token)}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: [event], ...(s.testCode ? { test_event_code: s.testCode } : {}) }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.error) { status = 'failed'; error = body.error?.message || `Meta returned ${res.status}`; }
      } catch (err) { status = 'failed'; error = err.message; }
    }
    await db.insert(db.capiEvents, { workspace_id: order.workspace_id, key, order_id: order._id, status, error: error.slice(0, 200) });
    if (status === 'failed') log.warn?.(`Conversions API ${key} for order ${order._id}: ${error}`);
    return status;
  }
  return {
    send,
    // Order pipeline: confirmed → Purchase, delivered → Delivered.
    onStatus: (order, _from, to) => (to === 'approved' ? send('purchase', order) : to === 'delivered' ? send('delivered', order) : 'skipped'),
    // The AI prepared an order in chat: the customer gave their phone, and the order summary went out.
    onAiOrder: async (order) => { await send('lead', order); return send('add_to_cart', order); },
  };
}

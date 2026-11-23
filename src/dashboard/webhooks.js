import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { InboxError } from '../inbox.js';
import { encryptSecret, decryptSecret } from '../secrets.js';
import { publicHttpsUrl } from './safeUrl.js';

// INT-04 · Webhooks: order, message, lead and booking events posted to the shop's own systems.
// Each delivery is JSON, signed with the endpoint's secret:
//   X-HeyQuicky-Signature: sha256=<hex HMAC-SHA256 of the raw body>
// Failed deliveries are tried again after 1, 5 and 30 minutes, then given up.

export const EVENTS = ['order.created', 'order.status_changed', 'message.received', 'lead.won', 'booking.created'];
const RETRY_MIN = [1, 5, 30];
const TIMEOUT = 10_000;
const kickers = new Map(); // db → () => void, set by createWebhooks

export function endpointsOf(ws) {
  return (ws?.settings?.webhooks ?? []).filter((e) => e?.id && e?.url);
}

export function sign(secret, body) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

// Shapes sent to the shop (no internal ids they don't need, money in taka).
export function orderData(o, { publicUrl = '' } = {}) {
  const total = (o.subtotal ?? 0) + (o.delivery_charge ?? 0) - (o.discount ?? 0);
  return {
    number: o.number, status: o.status, source: o.source, created_at: o.created_at,
    customer: { name: o.customer_name, phone: o.phone }, address: o.address, zone: o.zone ?? o.area, note: o.note ?? '',
    items: (o.product_items?.length ? o.product_items : o.items ?? []).map((i) => ({ name: i.name, variant: i.variant ?? '', sku: i.sku ?? '', qty: i.qty, price: i.price })),
    subtotal: o.subtotal ?? 0, delivery_charge: o.delivery_charge ?? 0, discount: o.discount ?? 0, coupon: o.coupon_code || null, total,
    cash_to_collect: o.cod_amount ?? total, advance: o.advance?.amount ?? 0,
    bill_url: o.bill_token && publicUrl ? `${publicUrl.replace(/\/+$/, '')}/b/${o.bill_token}` : null,
  };
}

// Queues an event for every endpoint of the shop that wants it, then nudges the sender.
export async function fireEvent(db, workspaceId, event, data) {
  if (!EVENTS.includes(event) || !workspaceId) return 0;
  const ws = await db.workspaces.findById(workspaceId, { settings: 1 }).lean();
  const targets = endpointsOf(ws).filter((e) => e.active !== false && e.events?.includes(event));
  if (!targets.length) return 0;
  const id = randomUUID();
  for (const e of targets) {
    await db.insert(db.webhookDeliveries, { workspace_id: workspaceId, endpoint_id: e.id, event, event_id: id, payload: { id, event, created_at: new Date().toISOString(), data }, status: 'pending', attempts: 0, next_at: new Date() });
  }
  kickers.get(db)?.();
  return targets.length;
}

export async function messageEvent(db, conversationId, messageId) {
  const [conv, m] = await Promise.all([db.conversations.findById(conversationId).lean(), db.messages.findById(messageId).lean()]);
  if (!conv || !m || m.direction !== 'in') return 0;
  const contact = conv.contact_id ? await db.contacts.findById(conv.contact_id, { name: 1 }).lean() : null;
  return fireEvent(db, conv.workspace_id, 'message.received', {
    conversation_id: conv._id, platform: conv.platform ?? null, customer_name: contact?.name ?? null, text: m.text ?? '',
    attachments: (m.attachments ?? []).map((a) => a.type), at: m.created_at,
  });
}

export function createWebhooks(db, config, { fetchImpl = fetch, resolve } = {}) {
  let running = false;
  async function deliverOne(d) {
    const ws = await db.workspaces.findById(d.workspace_id, { settings: 1 }).lean();
    const ep = endpointsOf(ws).find((e) => e.id === d.endpoint_id);
    if (!ep || ep.active === false) { await db.webhookDeliveries.updateOne({ _id: d._id }, { $set: { status: 'failed', last_error: 'Endpoint removed or paused', next_at: null } }); return; }
    const body = JSON.stringify(d.payload);
    let code = 0;
    let error = '';
    try {
      const url = await publicHttpsUrl(ep.url, { resolve, what: 'webhook address' });
      const res = await fetchImpl(url, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT),
        headers: { 'content-type': 'application/json', 'user-agent': 'HeyQuicky-Webhooks/1', 'x-heyquicky-event': d.event, 'x-heyquicky-delivery': String(d._id), 'x-heyquicky-signature': sign(decryptSecret(ep.secret, config.tokenKey), body) },
        body,
      });
      code = res.status;
      if (code < 200 || code >= 300) error = code >= 300 && code < 400 ? 'Redirects are not followed — use the final address' : `Answered ${code}`;
    } catch (err) {
      error = err.name === 'TimeoutError' ? 'No answer in 10 seconds' : err.message || 'Could not connect';
    }
    const attempts = d.attempts + 1;
    if (!error) {
      await db.webhookDeliveries.updateOne({ _id: d._id }, { $set: { status: 'ok', attempts, last_code: code, last_error: '', delivered_at: new Date(), next_at: null } });
    } else {
      const retry = RETRY_MIN[attempts - 1];
      await db.webhookDeliveries.updateOne({ _id: d._id }, { $set: { status: retry ? 'pending' : 'failed', attempts, last_code: code || null, last_error: error.slice(0, 200), next_at: retry ? new Date(Date.now() + retry * 60_000) : null } });
    }
  }
  // Sends everything that is due, oldest first. Safe to call often; one run at a time.
  async function run() {
    // Nothing to do while the database is down (or after it was closed, e.g. at shutdown).
    if (running || db.webhookDeliveries.db?.readyState !== 1) return 0;
    running = true;
    let n = 0;
    try {
      for (;;) {
        const due = await db.webhookDeliveries.find({ status: 'pending', next_at: { $lte: new Date() } }).sort({ _id: 1 }).limit(20).lean();
        if (!due.length) break;
        for (const d of due) { await deliverOne(d); n += 1; }
        if (due.length < 20) break;
      }
    } finally { running = false; }
    return n;
  }
  kickers.set(db, () => { setImmediate(() => run().catch((err) => console.warn('webhooks failed:', err.message))); });
  const timer = setInterval(() => run().catch((err) => console.warn('webhooks failed:', err.message)), 60_000);
  timer.unref();
  return { run, stop: () => clearInterval(timer) };
}

// Adds an endpoint. The secret is returned once (to put in the shop's system) and kept encrypted.
export async function addEndpoint(db, config, ws, { url, events, resolve }) {
  const list = endpointsOf(ws);
  if (list.length >= 10) throw new InboxError(400, 'A shop can have up to 10 webhooks');
  const clean = await publicHttpsUrl(url, { resolve, what: 'webhook address' });
  const picked = (Array.isArray(events) ? events : []).filter((e) => EVENTS.includes(e));
  if (!picked.length) throw new InboxError(400, 'Pick at least one event');
  if (config.isProduction && !config.tokenKey) throw new InboxError(503, "The server is missing TOKEN_ENCRYPTION_KEY, so webhook secrets can't be stored safely yet");
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  const ep = { id: randomBytes(6).toString('hex'), url: clean, events: picked, secret: encryptSecret(secret, config.tokenKey), active: true, created_at: new Date() };
  await db.workspaces.updateOne({ _id: ws._id }, { $push: { 'settings.webhooks': ep } });
  return { ...ep, secret };
}

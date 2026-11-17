import { randomBytes } from 'node:crypto';

// Courier booking and tracking (CRR-01/02/07). Each courier has the same shape:
//   book(order) → { consignmentId, trackingCode, status, fee }
//   track(consignmentId) → { status, events }
// Keys belong to the shop (Settings → Couriers) and are passed in decrypted; a courier with no keys,
// or any courier when DRY_RUN is on, runs in fake mode and returns made-up consignment numbers.

export const COURIERS = {
  steadfast: { name: 'Steadfast', prefix: 'SF', fields: ['api_key', 'secret_key'] },
  pathao: { name: 'Pathao', prefix: 'PT', fields: ['client_id', 'client_secret', 'username', 'password', 'store_id'] },
  redx: { name: 'RedX', prefix: 'RX', fields: ['api_token'] },
  paperfly: { name: 'Paperfly', prefix: 'PF', fields: ['username', 'password', 'api_key'] },
  ecourier: { name: 'eCourier', prefix: 'EC', fields: ['user_id', 'api_key', 'api_secret'] },
};

// What the courier calls a status → our order pipeline.
const STATUS_MAP = {
  pending: 'in_transit', in_review: 'in_transit', hold: 'in_transit', picked: 'in_transit', in_transit: 'in_transit',
  delivered: 'delivered', partial_delivered: 'delivered', delivered_approval_pending: 'delivered',
  cancelled: 'returned', cancelled_approval_pending: 'returned', returned: 'returned', unknown: 'in_transit',
};
export const toPipeline = (courierStatus) => STATUS_MAP[String(courierStatus ?? '').toLowerCase()] ?? 'in_transit';

function fakeCourier(key) {
  const { prefix } = COURIERS[key];
  return {
    key, mode: 'fake',
    async book() {
      const id = `${prefix}-${String(randomBytes(3).readUIntBE(0, 3) % 100000).padStart(5, '0')}`;
      return { consignmentId: id, trackingCode: id, status: 'pending', fee: key === 'pathao' ? 70 : 60 };
    },
    async track() { return { status: 'in_transit', events: [] }; },
  };
}

function steadfast({ api_key: apiKey, secret_key: secretKey }, fetchImpl) {
  const base = 'https://portal.packzy.com/api/v1';
  const headers = { 'Api-Key': apiKey, 'Secret-Key': secretKey, 'content-type': 'application/json' };
  return {
    key: 'steadfast', mode: 'real',
    async book(order) {
      const res = await fetchImpl(`${base}/create_order`, {
        method: 'POST', headers,
        body: JSON.stringify({
          invoice: `HQ-${order.number ?? order._id}`, recipient_name: order.customer_name, recipient_phone: order.phone,
          recipient_address: [order.address, order.thana, order.district].filter(Boolean).join(', '), cod_amount: order.cod_amount, note: order.note ?? '',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.status !== 200 || !data.consignment) throw new Error(data.message || `Steadfast returned ${res.status}`);
      return { consignmentId: String(data.consignment.consignment_id), trackingCode: data.consignment.tracking_code, status: data.consignment.status, fee: null };
    },
    async track(consignmentId) {
      const res = await fetchImpl(`${base}/status_by_cid/${encodeURIComponent(consignmentId)}`, { headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Steadfast returned ${res.status}`);
      return { status: data.delivery_status, events: [] };
    },
  };
}

function pathao(creds, fetchImpl) {
  const base = 'https://api-hermes.pathao.com';
  let token = null;
  async function auth() {
    if (token && token.expires > Date.now()) return token.value;
    const res = await fetchImpl(`${base}/aladdin/api/v1/issue-token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: creds.client_id, client_secret: creds.client_secret, username: creds.username, password: creds.password, grant_type: 'password' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new Error(data.message || 'Pathao login failed — check the keys in Settings → Couriers');
    token = { value: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 900 };
    return token.value;
  }
  return {
    key: 'pathao', mode: 'real',
    async book(order) {
      const res = await fetchImpl(`${base}/aladdin/api/v1/orders`, {
        method: 'POST', headers: { authorization: `Bearer ${await auth()}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          store_id: Number(creds.store_id), merchant_order_id: `HQ-${order.number ?? order._id}`, recipient_name: order.customer_name,
          recipient_phone: order.phone, recipient_address: [order.address, order.thana, order.district].filter(Boolean).join(', '),
          delivery_type: 48, item_type: 2, item_quantity: (order.items ?? []).reduce((n, i) => n + (i.qty ?? 1), 0) || 1,
          item_weight: 0.5, amount_to_collect: order.cod_amount, special_instruction: order.note ?? '',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.data?.consignment_id) throw new Error(data.message || `Pathao returned ${res.status}`);
      return { consignmentId: data.data.consignment_id, trackingCode: data.data.consignment_id, status: data.data.order_status ?? 'pending', fee: data.data.delivery_fee ?? null };
    },
    async track(consignmentId) {
      const res = await fetchImpl(`${base}/aladdin/api/v1/orders/${encodeURIComponent(consignmentId)}/info`, { headers: { authorization: `Bearer ${await auth()}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Pathao returned ${res.status}`);
      return { status: data.data?.order_status_slug ?? data.data?.order_status, events: [] };
    },
  };
}

// creds: the shop's decrypted keys for this courier (or null).
export function courierClient(key, creds, { dryRun = false, fetchImpl = fetch } = {}) {
  if (!COURIERS[key]) throw new Error(`Unknown courier ${key}`);
  const hasKeys = creds && COURIERS[key].fields.every((f) => creds[f]);
  if (dryRun || !hasKeys) return fakeCourier(key);
  if (key === 'steadfast') return steadfast(creds, fetchImpl);
  if (key === 'pathao') return pathao(creds, fetchImpl);
  return fakeCourier(key); // RedX, Paperfly and eCourier come in Phase 3 (CRR-07).
}

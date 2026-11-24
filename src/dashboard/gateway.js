import { randomBytes, constants, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, createSign } from 'node:crypto';
import { InboxError } from '../inbox.js';
import { encryptSecret, decryptSecret } from '../secrets.js';
import { orderTotal } from './orderOps.js';
import { approvePayment } from './payments.js';

// PAY-02 · Payment gateway (frame "PAY-02 · Payment gateway"): the shop connects SSLCommerz, the bKash
// Payment Gateway (tokenized checkout) or Nagad Merchant with its own keys. Customers pay advances, full
// payments (with an optional discount) and booking deposits online; HeyQuicky checks every payment with
// the gateway server-to-server before counting it, so nobody has to verify a TrxID by hand.

export const GATEWAYS = {
  sslcommerz: { name: 'SSLCommerz', fee: 'from 2.3%', fields: { store_id: { secret: false }, store_password: { secret: true } } },
  bkash: { name: 'bKash Payment Gateway', fee: '1.5%', fields: { app_key: { secret: false }, app_secret: { secret: true }, username: { secret: false }, password: { secret: true } } },
  nagad: { name: 'Nagad Merchant', fee: '1.4%', fields: { merchant_id: { secret: false }, merchant_number: { secret: false, optional: true }, merchant_private_key: { secret: true }, nagad_public_key: { secret: false } } },
};
export const USES = ['advance', 'full', 'deposit'];

const BASE = {
  sslcommerz: { sandbox: 'https://sandbox.sslcommerz.com', live: 'https://securepay.sslcommerz.com' },
  bkash: { sandbox: 'https://tokenized.sandbox.bka.sh/v1.2.0-beta', live: 'https://tokenized.pay.bka.sh/v1.2.0-beta' },
  nagad: { sandbox: 'http://sandbox.mynagad.com:10080/remote-payment-gateway-1.0', live: 'https://api.mynagad.com' },
};

// Stored at workspace.settings.gateway: { sslcommerz: { sandbox, connected_at, store_id, store_password(enc) }, …, use: { advance, full, full_discount, deposit } }.
export function gatewaySettings(ws) {
  const g = ws?.settings?.gateway ?? {};
  const use = { advance: true, full: false, full_discount: 5, deposit: true, ...(g.use ?? {}) };
  return { g, use, connected: Object.keys(GATEWAYS).filter((k) => g[k]?.connected_at) };
}

// Whether online payment is on for this purpose (and at least one gateway is connected).
export function onlineFor(ws, purpose) {
  const { use, connected } = gatewaySettings(ws);
  return connected.length > 0 && Boolean(use[purpose]);
}

export function gatewayView(ws) {
  const { g, use, connected } = gatewaySettings(ws);
  return {
    gateways: Object.entries(GATEWAYS).map(([key, def]) => ({
      key, name: def.name, fee: def.fee, connected: connected.includes(key), sandbox: Boolean(g[key]?.sandbox), connectedAt: g[key]?.connected_at ?? null,
      // Non-secret fields are shown back; secrets only as "saved".
      fields: Object.entries(def.fields).map(([f, spec]) => ({ key: f, secret: spec.secret, optional: Boolean(spec.optional), value: spec.secret ? '' : (g[key]?.[f] ?? ''), saved: Boolean(g[key]?.[f]) })),
    })),
    use,
  };
}

// Validate and encrypt the keys the shop typed. Secrets left blank keep the saved ones.
export function cleanCredentials(kind, body, current, config) {
  const def = GATEWAYS[kind];
  if (!def) throw new InboxError(404, 'Unknown payment gateway');
  if (config.isProduction && !config.tokenKey) throw new InboxError(503, 'TOKEN_ENCRYPTION_KEY must be set before connecting a payment gateway');
  const out = { sandbox: Boolean(body?.sandbox) };
  for (const [f, spec] of Object.entries(def.fields)) {
    const raw = String(body?.[f] ?? '').trim();
    if (!raw) {
      if (current?.[f]) { out[f] = current[f]; continue; }
      if (spec.optional) { out[f] = ''; continue; }
      throw new InboxError(400, `Enter the ${f.replace(/_/g, ' ')}`);
    }
    if (raw.length > 5000) throw new InboxError(400, `The ${f.replace(/_/g, ' ')} is too long`);
    out[f] = spec.secret ? encryptSecret(raw, config.tokenKey) : raw;
  }
  if (kind === 'nagad') {
    try { createPrivateKey(pem(decryptSecret(out.merchant_private_key, config.tokenKey), 'PRIVATE')); } catch { throw new InboxError(400, "The merchant private key doesn't look right — paste the whole key Nagad gave you"); }
    try { createPublicKey(pem(out.nagad_public_key, 'PUBLIC')); } catch { throw new InboxError(400, "Nagad's public key doesn't look right — paste the whole key"); }
  }
  return out;
}

const pem = (key, type) => {
  const k = String(key ?? '').trim();
  if (k.includes('-----BEGIN')) return k;
  return `-----BEGIN ${type} KEY-----\n${k.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END ${type} KEY-----`;
};
const secret = (creds, f, config) => decryptSecret(creds[f], config.tokenKey);
const base = (kind, creds) => BASE[kind][creds.sandbox ? 'sandbox' : 'live'];

async function http(fetchImpl, url, { method = 'POST', headers = {}, json, form } = {}) {
  const res = await fetchImpl(url, {
    method,
    headers: { accept: 'application/json', ...(json ? { 'content-type': 'application/json' } : form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers },
    body: json ? JSON.stringify(json) : form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new InboxError(502, data?.statusMessage || data?.message || data?.failedreason || `The payment gateway answered ${res.status}`);
  return data;
}

// ---- bKash tokenized checkout ----
async function bkashToken(creds, config, fetchImpl) {
  const r = await http(fetchImpl, `${base('bkash', creds)}/tokenized/checkout/token/grant`, {
    headers: { username: creds.username, password: secret(creds, 'password', config) },
    json: { app_key: creds.app_key, app_secret: secret(creds, 'app_secret', config) },
  });
  if (!r.id_token) throw new InboxError(400, r.statusMessage || 'bKash did not accept these keys');
  return r.id_token;
}
const bkashHeaders = (token, creds) => ({ authorization: token, 'x-app-key': creds.app_key });

// ---- Nagad (RSA: encrypt with Nagad's public key, sign with the merchant's private key) ----
const nagadTime = (d = new Date()) => new Date(d.getTime() + 6 * 3_600_000).toISOString().replace(/\D/g, '').slice(0, 14);
function nagadSeal(creds, config, data) {
  const json = JSON.stringify(data);
  const sensitiveData = publicEncrypt({ key: pem(creds.nagad_public_key, 'PUBLIC'), padding: constants.RSA_PKCS1_PADDING }, Buffer.from(json)).toString('base64');
  const signature = createSign('SHA256').update(json).sign(pem(secret(creds, 'merchant_private_key', config), 'PRIVATE'), 'base64');
  return { sensitiveData, signature };
}
function nagadOpen(creds, config, sensitiveData) {
  return JSON.parse(privateDecrypt({ key: pem(secret(creds, 'merchant_private_key', config), 'PRIVATE'), padding: constants.RSA_PKCS1_PADDING }, Buffer.from(sensitiveData, 'base64')).toString('utf8'));
}
const nagadHeaders = { 'x-km-api-version': 'v-0.2.0', 'x-km-ip-v4': '127.0.0.1', 'x-km-client-type': 'PC_WEB' };

// Check the keys when connecting (no money moves).
export async function testCredentials(kind, creds, config, { fetchImpl = fetch } = {}) {
  if (config.dryRun) return true;
  if (kind === 'bkash') { await bkashToken(creds, config, fetchImpl); return true; }
  if (kind === 'sslcommerz') {
    // A session that is never paid: SSLCommerz says FAILED with a reason when the store id / password are wrong.
    const r = await http(fetchImpl, `${base('sslcommerz', creds)}/gwprocess/v4/api.php`, { form: { store_id: creds.store_id, store_passwd: secret(creds, 'store_password', config), total_amount: '10', currency: 'BDT', tran_id: `test${randomBytes(6).toString('hex')}`, success_url: 'https://example.com', fail_url: 'https://example.com', cancel_url: 'https://example.com', cus_name: 'Test', cus_email: 'test@example.com', cus_add1: 'Dhaka', cus_city: 'Dhaka', cus_country: 'Bangladesh', cus_phone: '01700000000', shipping_method: 'NO', product_name: 'Test', product_category: 'test', product_profile: 'general' } });
    if (r.status !== 'SUCCESS') throw new InboxError(400, r.failedreason || 'SSLCommerz did not accept this store id and password');
    return true;
  }
  return true; // Nagad: the keys were parsed; the first payment proves them.
}

// ---- Checkouts: one link per order / booking and purpose ----
export async function checkoutAmount(db, ws, { order, booking, purpose }) {
  if (booking) return booking.advance?.amount ?? 0;
  const left = Math.max(0, orderTotal(order) - (order.advance_paid ?? 0));
  if (purpose === 'advance') return Math.min(left, order.advance?.amount ?? 0);
  const off = Math.round((left * (gatewaySettings(ws).use.full_discount || 0)) / 100);
  return Math.max(0, left - off);
}

export async function openCheckout(db, ws, { order = null, booking = null, purpose }) {
  if (!USES.includes(purpose)) throw new InboxError(400, 'Unknown payment purpose');
  if (!onlineFor(ws, purpose)) throw new InboxError(409, 'Online payment is off for this');
  const amount = await checkoutAmount(db, ws, { order, booking, purpose });
  if (amount < 10) throw new InboxError(400, 'Nothing left to pay online');
  const target = booking ? { booking_id: booking._id } : { order_id: order._id };
  const existing = await db.checkouts.findOne({ workspace_id: ws._id, ...target, purpose, status: { $in: ['open', 'failed'] }, amount }).lean();
  if (existing) return existing;
  const discount = purpose === 'full' ? Math.max(0, Math.max(0, orderTotal(order) - (order.advance_paid ?? 0)) - amount) : 0;
  const c = await db.insert(db.checkouts, { workspace_id: ws._id, ...target, purpose, amount, discount, token: randomBytes(8).toString('hex'), status: 'open' });
  return db.checkouts.findById(c.id).lean();
}

export const payUrl = (config, checkout) => `${(config.publicUrl || '').replace(/\/+$/, '')}/pay/${checkout.token}`;

// Start paying with one gateway: returns the URL to send the customer to.
export async function startCheckout(db, config, checkout, kind, { fetchImpl = fetch } = {}) {
  const ws = await db.workspaces.findById(checkout.workspace_id).lean();
  const creds = ws?.settings?.gateway?.[kind];
  if (!creds?.connected_at) throw new InboxError(409, 'This payment method is not connected');
  if (checkout.status === 'paid') throw new InboxError(409, 'Already paid');
  const site = (config.publicUrl || '').replace(/\/+$/, '');
  const back = `${site}/pay/${checkout.token}/back/${kind}`;
  const attempt = `${checkout.token}${(checkout.attempts ?? 0) + 1}`.slice(0, 20);
  await db.checkouts.updateOne({ _id: checkout._id }, { $set: { gateway: kind, status: 'open', error: '' }, $inc: { attempts: 1 } });
  if (config.dryRun) return `${back}?dry=1&ref=${attempt}`;
  const order = checkout.order_id ? await db.orders.findById(checkout.order_id).lean() : null;
  const booking = checkout.booking_id ? await db.bookings.findById(checkout.booking_id).lean() : null;
  const who = order ?? booking ?? {};
  const what = order ? `Order #${order.number}` : `Booking: ${booking?.service ?? ''}`;
  if (kind === 'sslcommerz') {
    const r = await http(fetchImpl, `${base(kind, creds)}/gwprocess/v4/api.php`, { form: {
      store_id: creds.store_id, store_passwd: secret(creds, 'store_password', config), total_amount: String(checkout.amount), currency: 'BDT', tran_id: attempt,
      success_url: back, fail_url: back, cancel_url: back, ipn_url: `${site}/pay/ipn/sslcommerz`,
      cus_name: who.customer_name || who.name || 'Customer', cus_email: 'customer@heyquicky.app', cus_add1: who.address || 'Bangladesh', cus_city: 'Dhaka', cus_country: 'Bangladesh', cus_phone: who.phone || '01700000000',
      shipping_method: 'NO', product_name: what, product_category: 'ecommerce', product_profile: 'general', value_a: checkout.token,
    } });
    if (r.status !== 'SUCCESS' || !r.GatewayPageURL) throw new InboxError(502, r.failedreason || 'SSLCommerz could not start the payment');
    await db.checkouts.updateOne({ _id: checkout._id }, { $set: { external_id: attempt } });
    return r.GatewayPageURL;
  }
  if (kind === 'bkash') {
    const token = await bkashToken(creds, config, fetchImpl);
    const r = await http(fetchImpl, `${base(kind, creds)}/tokenized/checkout/create`, { headers: bkashHeaders(token, creds), json: {
      mode: '0011', payerReference: who.phone || 'customer', callbackURL: back, amount: checkout.amount.toFixed(2), currency: 'BDT', intent: 'sale', merchantInvoiceNumber: attempt,
    } });
    if (!r.bkashURL || !r.paymentID) throw new InboxError(502, r.statusMessage || 'bKash could not start the payment');
    await db.checkouts.updateOne({ _id: checkout._id }, { $set: { external_id: r.paymentID } });
    return r.bkashURL;
  }
  // Nagad: initialize (get a challenge), then complete with the amount (get the payment page).
  const init = await http(fetchImpl, `${base(kind, creds)}/api/dpg/v1/check-out/initialize/${creds.merchant_id}/${attempt}`, { headers: nagadHeaders, json: {
    accountNumber: creds.merchant_number || undefined, dateTime: nagadTime(), ...nagadSeal(creds, config, { merchantId: creds.merchant_id, datetime: nagadTime(), orderId: attempt, challenge: randomBytes(20).toString('hex') }),
  } });
  if (!init.sensitiveData) throw new InboxError(502, init.message || 'Nagad could not start the payment');
  const { paymentReferenceId, challenge } = nagadOpen(creds, config, init.sensitiveData);
  const done = await http(fetchImpl, `${base(kind, creds)}/api/dpg/v1/check-out/complete/${paymentReferenceId}`, { headers: nagadHeaders, json: {
    ...nagadSeal(creds, config, { merchantId: creds.merchant_id, orderId: attempt, currencyCode: '050', amount: checkout.amount.toFixed(2), challenge }),
    merchantCallbackURL: back, additionalMerchantInfo: { for: what },
  } });
  if (done.status !== 'Success' || !done.callBackUrl) throw new InboxError(502, done.message || 'Nagad could not start the payment');
  await db.checkouts.updateOne({ _id: checkout._id }, { $set: { external_id: paymentReferenceId } });
  return done.callBackUrl;
}

// Ask the gateway whether the money really arrived. Returns { ok, amount, trx, cancelled }.
export async function verifyWithGateway(db, config, checkout, kind, params, { fetchImpl = fetch } = {}) {
  if (config.dryRun) return params.dry ? { ok: true, amount: checkout.amount, trx: `DRY${String(params.ref ?? checkout.token).slice(-9).toUpperCase()}` } : { ok: false };
  const ws = await db.workspaces.findById(checkout.workspace_id).lean();
  const creds = ws?.settings?.gateway?.[kind];
  if (!creds?.connected_at) return { ok: false };
  if (kind === 'sslcommerz') {
    if (!params.val_id) return { ok: false, cancelled: /cancel/i.test(params.status ?? '') };
    const q = new URLSearchParams({ val_id: params.val_id, store_id: creds.store_id, store_passwd: secret(creds, 'store_password', config), format: 'json' });
    const r = await http(fetchImpl, `${base(kind, creds)}/validator/api/validationserverAPI.php?${q}`, { method: 'GET' });
    const ok = ['VALID', 'VALIDATED'].includes(r.status) && r.tran_id === checkout.external_id && r.currency_type !== 'USD';
    return { ok, amount: Number(r.currency_amount ?? r.amount) || 0, trx: r.bank_tran_id || r.val_id || '' };
  }
  if (kind === 'bkash') {
    if (params.paymentID !== checkout.external_id) return { ok: false };
    if (params.status && params.status !== 'success') return { ok: false, cancelled: params.status === 'cancel' };
    const token = await bkashToken(creds, config, fetchImpl);
    let r = await http(fetchImpl, `${base(kind, creds)}/tokenized/checkout/execute`, { headers: bkashHeaders(token, creds), json: { paymentID: checkout.external_id } }).catch(() => null);
    // Execute can time out after bKash took the money: ask for the status instead.
    if (!r?.transactionStatus) r = await http(fetchImpl, `${base(kind, creds)}/tokenized/checkout/payment/status`, { headers: bkashHeaders(token, creds), json: { paymentID: checkout.external_id } });
    return { ok: r.transactionStatus === 'Completed', amount: Number(r.amount) || 0, trx: r.trxID || '' };
  }
  const ref = params.payment_ref_id;
  if (!ref || ref !== checkout.external_id) return { ok: false, cancelled: /cancel|abort/i.test(params.status ?? '') };
  const r = await http(fetchImpl, `${base(kind, creds)}/api/dpg/v1/verify/payment/${encodeURIComponent(ref)}`, { method: 'GET', headers: nagadHeaders });
  return { ok: r.status === 'Success', amount: Number(r.amount) || 0, trx: r.issuerPaymentRefNo || r.paymentRefId || '' };
}

// The money arrived: count it once (the return page and the IPN may both arrive).
export async function completeCheckout(db, checkout, { kind, amount, trx }, { inbox = null, notify = null } = {}) {
  if (amount + 0.5 < checkout.amount) {
    await db.checkouts.updateOne({ _id: checkout._id }, { $set: { status: 'failed', error: `Paid ৳${amount}, expected ৳${checkout.amount}` } });
    return { ok: false };
  }
  const claimed = await db.checkouts.findOneAndUpdate({ _id: checkout._id, status: { $ne: 'paid' } }, { $set: { status: 'paid', paid_at: new Date(), trx_id: trx, gateway: kind, error: '' } }, { new: true, lean: true });
  if (!claimed) return { ok: true, already: true };
  const label = GATEWAYS[kind].name;
  const payment = await db.insert(db.payments, { workspace_id: checkout.workspace_id, order_id: checkout.order_id, booking_id: checkout.booking_id, method: kind, gateway: kind, amount: checkout.amount, expected: checkout.amount, trx_id: String(trx || claimed.token).toUpperCase().slice(0, 40), source: 'gateway' });
  if (checkout.order_id) {
    // Full payment with a discount: the discount goes on the order first, so the payment covers it all.
    if (checkout.discount) await db.orders.updateOne({ _id: checkout.order_id }, { $inc: { discount: checkout.discount } });
    const p = await db.payments.findById(payment.id).lean();
    const { order } = await approvePayment(db, null, p, { inbox });
    await notify?.({ workspaceId: checkout.workspace_id, event: 'order', title: `Paid online: ৳${checkout.amount.toLocaleString('en-IN')} via ${label}`, body: `Order #${order.number} — checked with ${label}, nothing to verify`, link: `/orders/${order.number}`, ref: `gw:${checkout._id}` }).catch(() => {});
  } else if (checkout.booking_id) {
    await db.payments.updateOne({ _id: payment.id }, { $set: { status: 'approved', decided_at: new Date() } });
    const b = await db.bookings.findOneAndUpdate({ _id: checkout.booking_id }, { $set: { 'advance.verified': true, 'advance.trx_id': payment.trx_id ?? '', 'advance.method': kind, ...(checkout.purpose === 'deposit' ? { status: 'confirmed' } : {}) } }, { new: true, lean: true });
    if (inbox && b?.conversation_id) await inbox.eventUpdate(b.conversation_id, `আপনার ৳${checkout.amount.toLocaleString('en-IN')} অগ্রিম পেয়েছি ✅ ${b.service} বুকিং কনফার্ম হয়েছে।`).catch(() => null);
    await notify?.({ workspaceId: checkout.workspace_id, event: 'order', title: `Booking deposit paid online: ৳${checkout.amount.toLocaleString('en-IN')}`, body: `${b?.name ?? ''} · ${b?.service ?? ''} — confirmed`, link: '/bookings', ref: `gw:${checkout._id}` }).catch(() => {});
  }
  return { ok: true };
}

// What the AI sends when an advance is needed and online payment is on.
export function payLinkMessage(amount, url) {
  return `অর্ডারটি কনফার্ম করতে ৳${Number(amount).toLocaleString('en-IN')} অগ্রিম দিন — এই লিংকে বিকাশ, নগদ বা কার্ড দিয়ে পেমেন্ট করুন: ${url}\nপেমেন্ট হলেই অর্ডার কনফার্ম হয়ে যাবে, TrxID পাঠাতে হবে না। বাকি টাকা ডেলিভারির সময় দিবেন।`;
}

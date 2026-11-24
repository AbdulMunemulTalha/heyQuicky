import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, privateDecrypt, publicEncrypt, createVerify, constants } from 'node:crypto';
import { setup } from './helpers.js';
import { createApp } from '../src/app.js';
import { createAdapters } from '../src/adapters/index.js';
import { advanceFor } from '../src/dashboard/payments.js';
import { openCheckout, startCheckout, verifyWithGateway, completeCheckout, payLinkMessage } from '../src/dashboard/gateway.js';

const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

async function shop(gateway, extra = {}) {
  const ctx = await setup({ env: { PUBLIC_URL: 'https://shop.test', ...extra } });
  await ctx.db.workspaces.updateOne({ _id: ctx.ws }, { $set: { 'settings.gateway': { ...gateway, use: { advance: true, full: true, full_discount: 5, deposit: true } } } });
  const order = await ctx.db.insert(ctx.db.orders, { workspace_id: ctx.ws, number: 1001, customer_name: 'Sadia', phone: '01712345678', address: 'Dhaka', area: 'outside_dhaka', subtotal: 2000, delivery_charge: 120, discount: 0,
    status: 'on_hold', hold_reason: 'Waiting for ৳300 advance (outside dhaka)', advance: { amount: 300, method: 'bkash', verified: false, requested: true }, advance_paid: 0, cod_amount: 2120, bill_token: 'billtoken1001' });
  const ws = await ctx.db.workspaces.findById(ctx.ws).lean();
  return { ...ctx, ws, order: await ctx.db.orders.findById(order.id).lean() };
}

test('an advance can be asked with only a gateway; the AI sends a pay link', async () => {
  const ws = { settings: { gateway: { bkash: { connected_at: new Date() }, use: { advance: true } }, advance: { rules: { outside_dhaka: { on: true, kind: 'fixed', value: 300 } } } } };
  assert.deepEqual(advanceFor(ws, { zone: 'outside_dhaka', total: 2000 }), { amount: 300, reason: 'outside_dhaka' });
  assert.equal(advanceFor({ ...ws, settings: { ...ws.settings, gateway: {} } }, { zone: 'outside_dhaka', total: 2000 }), null, 'no number and no gateway: nowhere to pay');
  assert.match(payLinkMessage(300, 'https://shop.test/pay/abc'), /৳300 অগ্রিম.*https:\/\/shop\.test\/pay\/abc[\s\S]*TrxID পাঠাতে হবে না/);
});

test('bKash: start, come back, execute — the order is paid, released from hold, and counted once', async () => {
  const s = await shop({ bkash: { sandbox: true, app_key: 'ak', app_secret: 'as', username: 'u', password: 'p', connected_at: new Date() } });
  const calls = [];
  let status = 'Completed';
  const fetchImpl = async (url, opts) => {
    const path = new URL(url).pathname.replace('/v1.2.0-beta', '');
    const body = opts.body ? JSON.parse(opts.body) : {};
    calls.push(path);
    assert.ok(String(url).startsWith('https://tokenized.sandbox.bka.sh/'), 'sandbox keys use the sandbox');
    if (path.endsWith('/token/grant')) { assert.deepEqual([opts.headers.username, body.app_key], ['u', 'ak']); return json(200, { id_token: 'tok', statusCode: '0000' }); }
    if (path.endsWith('/create')) {
      assert.deepEqual([opts.headers.authorization, opts.headers['x-app-key'], body.amount, body.currency, body.intent], ['tok', 'ak', '300.00', 'BDT', 'sale']);
      assert.match(body.callbackURL, /^https:\/\/shop\.test\/pay\/[a-f0-9]{16}\/back\/bkash$/);
      return json(200, { paymentID: 'PID1', bkashURL: 'https://sandbox.bka.sh/pay/PID1', statusCode: '0000' });
    }
    if (path.endsWith('/execute')) return json(200, { paymentID: 'PID1', transactionStatus: status, trxID: 'BKX123ABC', amount: '300.00' });
    return json(404, {});
  };
  const c = await openCheckout(s.db, s.ws, { order: s.order, purpose: 'advance' });
  assert.equal(c.amount, 300);
  assert.equal((await openCheckout(s.db, s.ws, { order: s.order, purpose: 'advance' }))._id, c._id, 'the same link is reused');
  assert.equal(await startCheckout(s.db, s.config, c, 'bkash', { fetchImpl }), 'https://sandbox.bka.sh/pay/PID1');
  const fresh = await s.db.checkouts.findById(c._id).lean();

  assert.deepEqual(await verifyWithGateway(s.db, s.config, fresh, 'bkash', { paymentID: 'OTHER', status: 'success' }, { fetchImpl }), { ok: false }, 'another payment id is ignored');
  assert.deepEqual(await verifyWithGateway(s.db, s.config, fresh, 'bkash', { paymentID: 'PID1', status: 'cancel' }, { fetchImpl }), { ok: false, cancelled: true });
  const v = await verifyWithGateway(s.db, s.config, fresh, 'bkash', { paymentID: 'PID1', status: 'success' }, { fetchImpl });
  assert.deepEqual(v, { ok: true, amount: 300, trx: 'BKX123ABC' });
  const notes = [];
  await completeCheckout(s.db, fresh, { kind: 'bkash', ...v }, { notify: async (n) => notes.push(n) });
  assert.deepEqual((await completeCheckout(s.db, fresh, { kind: 'bkash', ...v })), { ok: true, already: true }, 'the return page and a retry count once');
  const o = await s.db.orders.findById(s.order._id).lean();
  assert.deepEqual([o.status, o.hold_reason, o.advance_paid, o.cod_amount, o.advance.verified], ['approved', '', 300, 1820, true]);
  const pays = await s.db.payments.find({ order_id: s.order._id }).lean();
  assert.deepEqual(pays.map((p) => [p.status, p.gateway, p.source, p.trx_id, p.amount]), [['approved', 'bkash', 'gateway', 'BKX123ABC', 300]]);
  assert.equal(notes[0].title, 'Paid online: ৳300 via bKash Payment Gateway');
  assert.match((await s.db.orderEvents.findOne({ order_id: s.order._id, type: 'payment' }).lean()).text, /Paid ৳300 online with bKash — checked with the gateway/);
});

test('SSLCommerz: the return form and the IPN are both checked with the validator; paid once; a short amount fails', async () => {
  const s = await shop({ sslcommerz: { sandbox: true, store_id: 'teststore', store_password: 'pw', connected_at: new Date() } });
  let tran = '';
  let amount = '2014.00';
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    if (u.pathname === '/gwprocess/v4/api.php') {
      const f = new URLSearchParams(opts.body);
      tran = f.get('tran_id');
      assert.deepEqual([f.get('store_id'), f.get('total_amount'), f.get('currency'), f.get('ipn_url')], ['teststore', '2014', 'BDT', 'https://shop.test/pay/ipn/sslcommerz']);
      return json(200, { status: 'SUCCESS', GatewayPageURL: 'https://sandbox.sslcommerz.com/EasyCheckOut/abc' });
    }
    if (u.pathname === '/validator/api/validationserverAPI.php') {
      assert.deepEqual([u.searchParams.get('val_id'), u.searchParams.get('store_id')], ['VAL1', 'teststore']);
      return json(200, { status: 'VALID', tran_id: tran, amount, currency_amount: amount, bank_tran_id: 'BANK77' });
    }
    return json(404, {});
  };
  // Full payment with 5% off: ৳2,120 → ৳2,014 (৳106 off).
  const c = await openCheckout(s.db, s.ws, { order: s.order, purpose: 'full' });
  assert.deepEqual([c.amount, c.discount], [2014, 106]);
  const app = createApp(s.db, s.config, { fetchImpl, adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const site = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, form) => fetch(`${site}${path}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  try {
    const page = await (await fetch(`${site}/pay/${c.token}?lang=en`)).text();
    assert.match(page, /Full payment · Order #1001/);
    assert.match(page, /includes ৳106 off/);
    const go = await post(`/pay/${c.token}/go`, { gateway: 'sslcommerz' });
    assert.deepEqual([go.status, go.headers.get('location')], [303, 'https://sandbox.sslcommerz.com/EasyCheckOut/abc']);
    assert.equal((await post(`/pay/${c.token}/go`, { gateway: 'nagad' })).headers.get('location'), `/pay/${c.token}?done=error`, 'a gateway that is not connected');

    const back = await post(`/pay/${c.token}/back/sslcommerz`, { val_id: 'VAL1', tran_id: tran, status: 'VALID' });
    assert.equal(back.headers.get('location'), `/pay/${c.token}`);
    await post('/pay/ipn/sslcommerz', { val_id: 'VAL1', tran_id: tran, status: 'VALID' });
    const o = await s.db.orders.findById(s.order._id).lean();
    assert.deepEqual([o.discount, o.advance_paid, o.cod_amount, o.paid_in_full, o.status], [106, 2014, 0, true, 'approved']);
    assert.equal(await s.db.payments.countDocuments({ order_id: s.order._id }), 1, 'IPN after the return page: still one payment');
    assert.match(await (await fetch(`${site}/pay/${c.token}?lang=en`)).text(), /Paid ✅/);

    // A different order paid short: refused.
    const o2 = await s.db.insert(s.db.orders, { workspace_id: s.ws._id, number: 1002, customer_name: 'Ana', phone: '01711111111', address: 'Dhaka', area: 'inside_dhaka', cod_amount: 1000, subtotal: 1000, delivery_charge: 0, status: 'pending', advance: { amount: 300 }, advance_paid: 0, bill_token: 'billtoken1002' });
    const c2 = await openCheckout(s.db, s.ws, { order: await s.db.orders.findById(o2.id).lean(), purpose: 'advance' });
    await post(`/pay/${c2.token}/go`, { gateway: 'sslcommerz' });
    amount = '100.00';
    assert.equal((await post(`/pay/${c2.token}/back/sslcommerz`, { val_id: 'VAL1', tran_id: tran })).headers.get('location'), `/pay/${c2.token}?done=fail`);
    assert.deepEqual([(await s.db.checkouts.findById(c2._id).lean()).status, await s.db.payments.countDocuments({ order_id: o2.id })], ['failed', 0]);
  } finally {
    await new Promise((r) => { app.io.close(); app.server.close(r); });
  }
});

test('Nagad: RSA-sealed initialize and complete, then verify', async () => {
  const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const nagad = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pemOf = (k, type) => k.export({ type: type === 'private' ? 'pkcs8' : 'spki', format: 'pem' });
  const s = await shop({ nagad: { sandbox: false, merchant_id: '683002007104225', merchant_private_key: pemOf(merchant.privateKey, 'private'), nagad_public_key: pemOf(nagad.publicKey, 'public').replace(/-----[A-Z ]+-----|\n/g, ''), connected_at: new Date() } });
  const open = (b) => {
    const data = privateDecrypt({ key: nagad.privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(b.sensitiveData, 'base64')).toString('utf8');
    assert.ok(createVerify('SHA256').update(data).verify(merchant.publicKey, b.signature, 'base64'), 'signed with the merchant key');
    return JSON.parse(data);
  };
  let challenge = '';
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    assert.equal(u.origin, 'https://api.mynagad.com');
    if (u.pathname.startsWith('/api/dpg/v1/check-out/initialize/683002007104225/')) {
      const d = open(JSON.parse(opts.body));
      assert.equal(d.merchantId, '683002007104225');
      challenge = 'srv-challenge';
      const sensitiveData = publicEncrypt({ key: merchant.publicKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(JSON.stringify({ paymentReferenceId: 'REF9', challenge }))).toString('base64');
      return json(200, { sensitiveData, signature: 'x' });
    }
    if (u.pathname === '/api/dpg/v1/check-out/complete/REF9') {
      const b = JSON.parse(opts.body);
      const d = open(b);
      assert.deepEqual([d.amount, d.currencyCode, d.challenge], ['300.00', '050', 'srv-challenge']);
      assert.match(b.merchantCallbackURL, /\/back\/nagad$/);
      return json(200, { status: 'Success', callBackUrl: 'https://api.mynagad.com/pay/REF9' });
    }
    if (u.pathname === '/api/dpg/v1/verify/payment/REF9') return json(200, { status: 'Success', amount: '300', issuerPaymentRefNo: 'NG55' });
    return json(404, {});
  };
  const c = await openCheckout(s.db, s.ws, { order: s.order, purpose: 'advance' });
  assert.equal(await startCheckout(s.db, s.config, c, 'nagad', { fetchImpl }), 'https://api.mynagad.com/pay/REF9');
  const fresh = await s.db.checkouts.findById(c._id).lean();
  assert.deepEqual(await verifyWithGateway(s.db, s.config, fresh, 'nagad', { payment_ref_id: 'REF9', status: 'Success' }, { fetchImpl }), { ok: true, amount: 300, trx: 'NG55' });
});

test('Gateway tab: owners connect (secrets never come back), use switches, bill page shows pay online; DRY_RUN pays end to end', async () => {
  const ctx = await setup({ env: { DRY_RUN: '1', PUBLIC_URL: 'https://shop.test' } });
  await ctx.db.insert(ctx.db.orders, { workspace_id: ctx.ws, number: 7, customer_name: 'Rafi', phone: '01722222222', address: 'Dhaka', area: 'inside_dhaka', cod_amount: 1100, subtotal: 1000, delivery_charge: 100, discount: 0, status: 'on_hold', hold_reason: 'Waiting for ৳200 advance', advance: { amount: 200, verified: false }, advance_paid: 0, bill_token: 'billtoken0007' });
  const app = createApp(ctx.db, ctx.config, { adapters: createAdapters({ ADAPTERS: 'fake' }), clientDir: '/nonexistent' });
  await new Promise((r) => app.server.listen(0, r));
  const site = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(`${site}/api/dash${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const login = async (email) => (await (await fetch(`${site}/api/dash/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: email, password: 'password123' }) })).json()).token;
  try {
    const owner = await login('owner@shop.test');
    const mod = await login('nadia@shop.test');
    let g = await call('/payments/gateway', { token: owner });
    assert.deepEqual([g.body.gateways.map((x) => x.key), g.body.gateways.every((x) => !x.connected), g.body.use.advance, g.body.canEdit], [['sslcommerz', 'bkash', 'nagad'], true, true, true]);
    assert.equal((await call('/payments/gateway/bkash', { method: 'PUT', token: mod, body: {} })).status, 403);
    assert.equal((await call('/payments/gateway/bkash', { method: 'PUT', token: owner, body: { app_key: 'k' } })).status, 400, 'every key is needed');
    assert.equal((await call('/payments/gateway/nagad', { method: 'PUT', token: owner, body: { merchant_id: '1', merchant_private_key: 'nope', nagad_public_key: 'nope' } })).status, 400, 'keys must parse');
    const put = await call('/payments/gateway/bkash', { method: 'PUT', token: owner, body: { app_key: 'k1', app_secret: 'secret-1', username: 'u1', password: 'pw-1', sandbox: true } });
    assert.equal(put.status, 200);
    const bk = put.body.gateways.find((x) => x.key === 'bkash');
    assert.deepEqual([bk.connected, bk.sandbox, bk.fields.find((f) => f.key === 'app_secret').value, bk.fields.find((f) => f.key === 'app_secret').saved, bk.fields.find((f) => f.key === 'app_key').value], [true, true, '', true, 'k1']);
    // Saving again without secrets keeps the saved ones.
    assert.equal((await call('/payments/gateway/bkash', { method: 'PUT', token: owner, body: { app_key: 'k2', username: 'u1' } })).status, 200);
    assert.equal((await ctx.db.workspaces.findById(ctx.ws).lean()).settings.gateway.bkash.app_secret, 'secret-1');
    assert.equal((await call('/payments/gateway/use', { method: 'PATCH', token: owner, body: { fullDiscount: 80 } })).status, 400);
    g = await call('/payments/gateway/use', { method: 'PATCH', token: owner, body: { full: true, fullDiscount: 10 } });
    assert.deepEqual([g.body.use.full, g.body.use.full_discount], [true, 10]);

    // The customer pays the advance from the bill page (DRY_RUN stands in for bKash).
    const bill = await (await fetch(`${site}/b/billtoken0007?lang=en`)).text();
    assert.match(bill, /Pay ৳200 advance online/);
    assert.match(bill, /Pay the full ৳990 online · 10% off/);
    const go = await fetch(`${site}/b/billtoken0007/online`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'purpose=advance' });
    const payPath = go.headers.get('location');
    assert.match(payPath, /^\/pay\/[a-f0-9]{16}$/);
    const start = await fetch(`${site}${payPath}/go`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'gateway=bkash' });
    const back = new URL(start.headers.get('location'));
    assert.equal(back.pathname, `${payPath}/back/bkash`);
    await fetch(`${site}${back.pathname}${back.search}`, { redirect: 'manual' });
    const o = await ctx.db.orders.findOne({ number: 7 }).lean();
    assert.deepEqual([o.status, o.advance_paid, o.cod_amount], ['approved', 200, 900]);
    const list = await call('/payments?status=approved', { token: owner });
    assert.equal(list.body.payments[0].gateway, 'bkash', 'shown as paid online in Payments');

    assert.equal((await call('/payments/gateway/bkash', { method: 'DELETE', token: owner })).body.gateways.find((x) => x.key === 'bkash').connected, false);
  } finally {
    await new Promise((r) => { app.io.close(); app.server.close(r); });
  }
});

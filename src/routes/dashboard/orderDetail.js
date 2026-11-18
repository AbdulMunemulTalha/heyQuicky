import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { InboxError } from '../../inbox.js';
import { orderSummary, deliveryUpdate, reviewRequest, trackingUrl } from '../../platforms/rich.js';
import { can, need } from '../../dashboard/permissions.js';
import { audit, bdPhone, escapeRegex } from '../../dashboard/util.js';
import { riskFor } from '../../dashboard/risk.js';
import { decryptSecret } from '../../secrets.js';
import { COURIERS, courierClient, toPipeline } from '../../adapters/couriers.js';
import { NEXT, stage, orderTotal, changeStatus, bookCourier, adjustStock } from '../../dashboard/orderOps.js';
import { zonesFor, priceOrder, cleanCustomer } from '../../dashboard/orderBuild.js';

const SOURCES = { phone: 'team', messenger: 'team', instagram: 'team', whatsapp: 'team', walk_in: 'team', website: 'website' };

// Screens 11 (order detail and its on-hold / in-transit / cancel states) and 12 (new / edit order).
export function orderDetailRoutes(db, config, { auth, emit, inbox, adapters, fetchImpl, notify }) {
  const router = Router();

  async function loadOrder(req, { byNumber = false } = {}) {
    const key = Number(req.params.id);
    if (!Number.isSafeInteger(key)) throw new InboxError(404, 'Order not found');
    const order = await db.orders.findOne({ workspace_id: req.user.workspace_id, ...(byNumber ? { $or: [{ number: key }, { _id: key, number: null }] } : { _id: key }) }).lean();
    if (!order) throw new InboxError(404, 'Order not found');
    return order;
  }

  // Cross-merchant delivery record for a phone, cached on the customer for a day (CRM-02).
  async function courierCheck(customer, phone) {
    if (customer?.courier_check?.checked_at && Date.now() - new Date(customer.courier_check.checked_at) < 86_400_000) return customer.courier_check;
    try {
      const r = await adapters.fraud.check(phone);
      const check = { ...r, checked_at: new Date() };
      if (customer) await db.customers.updateOne({ _id: customer._id }, { $set: { courier_check: check } });
      return check;
    } catch {
      return null;
    }
  }

  async function findOrCreateCustomer(ws, { phone, name, address, district }, conversationId) {
    let customer = await db.customers.findOne({ workspace_id: ws, phones: phone }).lean();
    if (!customer && conversationId) {
      const conv = await db.conversations.findOne({ _id: conversationId, workspace_id: ws }, { customer_id: 1 }).lean();
      if (conv?.customer_id) customer = await db.customers.findById(conv.customer_id).lean();
    }
    if (!customer) customer = { _id: (await db.insert(db.customers, { workspace_id: ws, name, phones: [phone] })).id };
    await db.customers.updateOne({ _id: customer._id }, { $addToSet: { phones: phone }, $set: { address, area: district, ...(customer.name ? {} : { name }) } });
    return db.customers.findById(customer._id).lean();
  }

  router.get('/orders/form', auth, async (req, res) => {
    const ws = await db.workspaces.findById(req.user.workspace_id).lean();
    const couriers = await db.courierAccounts.find({ workspace_id: ws._id, connected: true }, { courier: 1 }).lean();
    res.json({ zones: zonesFor(ws), couriers: couriers.map((c) => c.courier), bkash: ws.bkash_number, freeOver: ws.free_delivery_over });
  });

  // Product search in the order form (by name or code / SKU).
  router.get('/orders/products', auth, async (req, res) => {
    const q = String(req.query.q ?? '').trim().slice(0, 40);
    const where = { workspace_id: req.user.workspace_id, archived: { $ne: true }, visibility: { $ne: 'hidden' } };
    if (q) where.$or = [{ name: new RegExp(escapeRegex(q), 'i') }, { code: new RegExp(`^${escapeRegex(q)}`, 'i') }, { 'variant_list.sku': new RegExp(`^${escapeRegex(q)}`, 'i') }];
    const products = await db.products.find(where).sort({ sold_count: -1, name: 1 }).limit(12).lean();
    res.json(products.map((p) => ({
      id: p._id, name: p.name, code: p.code, price: p.price, colour: p.colour, photo: p.photos?.[0] ?? '',
      variants: (p.variant_list ?? []).map((v) => ({ sku: v.sku, label: Object.values(v.options ?? {}).join(' / '), price: v.price ?? p.price, stock: v.stock ?? null })),
      inStock: p.in_stock !== false,
    })));
  });

  // Live summary for the order form: prices, delivery, coupon and cash to collect, from the catalog.
  router.post('/orders/quote', auth, async (req, res) => {
    const ws = await db.workspaces.findById(req.user.workspace_id).lean();
    const pay = req.body?.payment ?? {};
    const existing = req.body?.orderId ? await db.orders.findOne({ _id: Number(req.body.orderId), workspace_id: ws._id }).lean() : null;
    const p = await priceOrder(db, ws, { items: req.body?.items, zone: req.body?.zone, coupon: req.body?.coupon, advance: pay.method === 'bkash_advance' ? pay.advance : 0, paidInFull: pay.method === 'paid', existing });
    res.json({ subtotal: p.subtotal, delivery: p.delivery, discount: p.discount, coupon: p.couponCode, total: p.total, advance: p.advance, cod: p.cod, days: p.zone.days, count: p.lines.reduce((n, l) => n + l.qty, 0) });
  });

  // "Check" next to the phone number: the customer's history and courier record, and their last address.
  router.get('/orders/lookup', auth, async (req, res) => {
    const phone = bdPhone(req.query.phone);
    if (!phone) throw new InboxError(400, 'Enter an 11-digit Bangladeshi mobile number');
    const customer = await db.customers.findOne({ workspace_id: req.user.workspace_id, phones: phone }).lean();
    const last = customer ? await db.orders.findOne({ customer_id: customer._id }).sort({ created_at: -1 }).lean() : null;
    const check = await courierCheck(customer, phone);
    const risk = riskFor({ delivered: customer?.stats?.delivered, returned: customer?.stats?.returned, cancelled: customer?.stats?.cancelled,
      courierRate: check?.rate ?? null, courierTotal: check?.total ?? 0 });
    res.json({
      phone, known: Boolean(customer), name: customer?.name ?? '', orders: customer?.stats?.orders ?? 0, lastOrderAt: last?.created_at ?? null,
      lastAddress: last ? { address: last.address, district: last.district, thana: last.thana, zone: last.area } : null,
      check: check && { delivered: check.delivered, total: check.total, rate: check.rate, couriers: check.couriers, sample: check.source === 'sample' }, risk,
    });
  });

  // Screen 12: create an order (team, phone call, walk-in…). Prices come from the catalog.
  router.post('/orders', auth, need(db, 'edit_orders'), async (req, res) => {
    const ws = await db.workspaces.findById(req.user.workspace_id).lean();
    const who = cleanCustomer(req.body);
    const zone = String(req.body?.zone ?? 'inside_dhaka');
    const pay = req.body?.payment ?? {};
    const priced = await priceOrder(db, ws, { items: req.body?.items, zone, coupon: req.body?.coupon, advance: pay.method === 'bkash_advance' ? pay.advance : 0, paidInFull: pay.method === 'paid' });
    if (pay.method === 'bkash_advance' && !priced.advance) throw new InboxError(400, 'Enter the advance amount');
    const conversationId = Number(req.body?.conversationId) || null;
    const customer = await findOrCreateCustomer(ws._id, { ...who, district: who.district }, conversationId);
    const check = await courierCheck(customer, who.phone);
    const risk = riskFor({ delivered: customer.stats?.delivered, returned: customer.stats?.returned, cancelled: customer.stats?.cancelled,
      courierRate: check?.rate ?? null, courierTotal: check?.total ?? 0, codAmount: priced.cod, outsideDhaka: zone === 'outside_dhaka' });
    const draft = Boolean(req.body?.draft);
    const { order_seq: number } = await db.workspaces.findOneAndUpdate({ _id: ws._id }, { $inc: { order_seq: 1 } }, { new: true, lean: true });
    const billToken = randomBytes(9).toString('base64url');
    const order = await db.insert(db.orders, {
      workspace_id: ws._id, number, customer_id: customer._id, conversation_id: conversationId, created_by_user_id: req.user.id,
      customer_name: who.name, phone: who.phone, address: [who.address, who.areaName].filter(Boolean).join(', '), district: who.district, thana: who.thana,
      area: zone, zone, items: priced.lines.map((l) => ({ name: `${l.name}${l.variant ? ` (${l.variant})` : ''}`, qty: l.qty, price: l.price })), product_items: priced.lines,
      subtotal: priced.subtotal, delivery_charge: priced.delivery, discount: priced.discount, coupon_code: priced.couponCode,
      advance_paid: priced.advance, cod_amount: priced.cod, paid_in_full: pay.method === 'paid',
      payment_method: pay.method === 'paid' ? 'paid' : pay.method === 'bkash_advance' ? 'bkash' : 'cod',
      advance: priced.advance ? { amount: priced.advance, method: 'bkash', trx_id: String(pay.trxId ?? '').trim().slice(0, 30), verified: Boolean(pay.trxId) } : null,
      note: String(req.body?.note ?? '').slice(0, 500), status: draft ? 'pending' : 'approved', draft, risk,
      source: SOURCES[req.body?.source] ?? 'team', taken_by: req.user.name, bill_token: billToken,
      send_confirmation: req.body?.sendConfirmation !== false,
    });
    if (!draft) await adjustStock(db, { product_items: priced.lines }, -1, { notify });
    if (priced.couponCode) await db.coupons.updateOne({ workspace_id: ws._id, code: priced.couponCode }, { $inc: { used: 1 } });
    await db.customers.updateOne({ _id: customer._id }, { $inc: { 'stats.orders': draft ? 0 : 1 } });
    await db.insert(db.orderEvents, { workspace_id: ws._id, order_id: order.id, type: 'status', to: draft ? 'pending' : 'approved', by: 'user', user_id: req.user.id,
      text: draft ? `${req.user.name} saved a draft` : `${req.user.name} created the order (${req.body?.source ?? 'team'})` });
    await audit(db, req.user, `Created order #${number}`, { where: 'Orders' });
    if (!draft) {
      const total = priced.subtotal + priced.delivery - priced.discount;
      await notify?.({ workspaceId: ws._id, event: 'order', title: `New order #${number}`, body: `${who.name} · ৳${total.toLocaleString('en-IN')} · taken by ${req.user.name}`,
        link: `/orders/${number}`, ref: `order:${order.id}`, amount: total, exceptUserId: req.user.id });
      if (risk?.level === 'high') {
        await notify?.({ workspaceId: ws._id, event: 'escalation', title: `Order #${number} needs a look.`, body: `High return risk (${risk.score}%). ${risk.action}.`,
          link: `/orders/${number}`, ref: `risk:${order.id}`, exceptUserId: req.user.id });
      }
    }

    // Confirmation in Messenger (ORD-11) when the order came from a chat.
    if (!draft && conversationId && req.body?.sendConfirmation !== false) {
      const saved = await db.orders.findById(order.id).lean();
      const rich = orderSummary(saved, { billUrl: `${config.publicUrl || `${req.protocol}://${req.get('host')}`}/b/${billToken}` });
      await inbox.sendRich(req.user, conversationId, rich).catch((err) => console.warn('confirmation not sent:', err.message));
    }
    let booked = null;
    if (!draft && req.body?.bookNow && can(req.user, 'book_couriers', ws)) {
      booked = await bookCourier(db, config, req.user, await db.orders.findById(order.id).lean(), String(req.body.courier || 'steadfast'), { emit, fetchImpl }).catch((err) => ({ error: err.message }));
    }
    emit(ws._id, 'order', { id: order.id, number });
    res.status(201).json({ id: order.id, number, booked });
  });

  // Edit an order that hasn't shipped (screen 12 in edit mode).
  router.patch('/orders/:id', auth, need(db, 'edit_orders'), async (req, res) => {
    const order = await loadOrder(req);
    if (!['pending', 'on_hold', 'approved', 'processing'].includes(stage(order.status))) throw new InboxError(409, 'Orders can be edited until they are ready to ship');
    const ws = await db.workspaces.findById(req.user.workspace_id).lean();
    const who = cleanCustomer(req.body);
    const zone = String(req.body?.zone ?? order.area);
    const pay = req.body?.payment ?? {};
    const priced = await priceOrder(db, ws, { items: req.body?.items, zone, coupon: req.body?.coupon, advance: pay.method === 'bkash_advance' ? pay.advance : 0, paidInFull: pay.method === 'paid', existing: order });
    if (!order.draft) await adjustStock(db, order, +1);
    const wasDraft = order.draft;
    const draft = Boolean(req.body?.draft) && order.draft;
    if (!draft) await adjustStock(db, { product_items: priced.lines }, -1, { notify });
    const changed = who.address !== order.address || who.phone !== order.phone;
    await db.orders.updateOne({ _id: order._id }, { $set: {
      customer_name: who.name, phone: who.phone, address: [who.address, who.areaName].filter(Boolean).join(', '), district: who.district, thana: who.thana, area: zone, zone,
      items: priced.lines.map((l) => ({ name: `${l.name}${l.variant ? ` (${l.variant})` : ''}`, qty: l.qty, price: l.price })), product_items: priced.lines,
      subtotal: priced.subtotal, delivery_charge: priced.delivery, discount: priced.discount, coupon_code: priced.couponCode, advance_paid: priced.advance, cod_amount: priced.cod,
      paid_in_full: pay.method === 'paid', payment_method: pay.method === 'paid' ? 'paid' : pay.method === 'bkash_advance' ? 'bkash' : 'cod',
      advance: priced.advance ? { amount: priced.advance, method: 'bkash', trx_id: String(pay.trxId ?? '').trim().slice(0, 30), verified: Boolean(pay.trxId) } : null,
      note: String(req.body?.note ?? '').slice(0, 500), draft, updated_at: new Date(),
      ...(wasDraft && !draft ? { status: 'approved' } : {}),
    } });
    await db.insert(db.orderEvents, { workspace_id: order.workspace_id, order_id: order._id, type: 'edit', by: 'user', user_id: req.user.id,
      text: `${req.user.name} edited the order${changed ? ' (address or phone changed)' : ''}` });
    emit(order.workspace_id, 'order', { id: order._id, number: order.number });
    res.json({ id: order._id, number: order.number });
  });

  // Screen 11: everything about one order.
  router.get('/orders/:id', auth, async (req, res) => {
    const order = await loadOrder(req, { byNumber: true });
    if (!order.bill_token) {
      order.bill_token = randomBytes(9).toString('base64url');
      await db.orders.updateOne({ _id: order._id, bill_token: null }, { $set: { bill_token: order.bill_token } });
    }
    const ws = await db.workspaces.findById(req.user.workspace_id).lean();
    const showPhones = can(req.user, 'see_phones', ws);
    const customer = order.customer_id ? await db.customers.findById(order.customer_id).lean() : null;
    const [events, consignment, couriers] = await Promise.all([
      db.orderEvents.find({ order_id: order._id }).sort({ created_at: 1 }).lean(),
      db.consignments.findOne({ order_id: order._id }).sort({ created_at: -1 }).lean(),
      db.courierAccounts.find({ workspace_id: ws._id, connected: true }).lean(),
    ]);
    const users = new Map((await db.users.find({ _id: { $in: events.map((e) => e.user_id).filter(Boolean) } }, { name: 1 }).lean()).map((u) => [u._id, u.name]));
    const check = customer ? await courierCheck(customer, order.phone) : null;
    const risk = order.risk ?? riskFor({ delivered: customer?.stats?.delivered, returned: customer?.stats?.returned, cancelled: customer?.stats?.cancelled, courierRate: check?.rate ?? null, courierTotal: check?.total ?? 0, codAmount: order.cod_amount, outsideDhaka: order.area === 'outside_dhaka' });
    const products = new Map((await db.products.find({ _id: { $in: (order.product_items ?? []).map((i) => i.product_id) } }, { colour: 1, photos: 1, variant_list: 1 }).lean()).map((p) => [p._id, p]));
    let chat = [];
    let conversationId = order.conversation_id;
    if (!conversationId && customer) conversationId = (await db.conversations.findOne({ customer_id: customer._id }, { _id: 1 }).sort({ last_message_at: -1 }).lean())?._id ?? null;
    if (conversationId) chat = (await db.messages.find({ conversation_id: conversationId }).sort({ _id: -1 }).limit(2).lean()).reverse();
    // Delivered rate per courier in this district, from this shop's own parcels.
    const courierStats = await db.consignments.aggregate([
      { $match: { workspace_id: ws._id } },
      { $lookup: { from: 'orders', localField: 'order_id', foreignField: '_id', as: 'o' } }, { $unwind: '$o' },
      { $match: { 'o.district': order.district || { $exists: true }, 'o.status': { $in: ['delivered', 'returned'] } } },
      { $group: { _id: '$courier', delivered: { $sum: { $cond: [{ $eq: ['$o.status', 'delivered'] }, 1, 0] } }, n: { $sum: 1 } } }]);
    const rate = new Map(courierStats.map((c) => [c._id, c.n ? Math.round((c.delivered / c.n) * 100) : null]));
    const s = stage(order.status);
    res.json({
      id: order._id, number: order.number ?? order._id, status: s, next: NEXT[s] ?? [], at: order.created_at, source: order.source, takenBy: order.taken_by,
      draft: Boolean(order.draft), holdReason: order.hold_reason, cancelReason: order.cancel_reason, cancelRequestedAt: order.cancel_requested_at ?? null,
      items: (order.product_items?.length ? order.product_items : order.items.map((i) => ({ name: i.name, qty: i.qty, price: i.price }))).map((i) => {
        const p = products.get(i.product_id);
        const v = p?.variant_list?.find((x) => x.sku === i.sku);
        return { ...i, colour: p?.colour ?? '#ccc', photo: p?.photos?.[0] ?? '', stock: v?.stock ?? null, productId: i.product_id };
      }),
      subtotal: order.subtotal, delivery: order.delivery_charge, discount: order.discount, coupon: order.coupon_code, total: orderTotal(order),
      advance: order.advance?.amount ?? order.advance_paid ?? 0, advanceInfo: order.advance, cod: order.cod_amount, paid: Boolean(order.paid_in_full || order.payment_method === 'paid'),
      paymentMethod: order.payment_method, note: order.note,
      zone: order.area, zoneDays: zonesFor(ws).find((z) => z.key === order.area)?.days ?? '',
      address: { full: order.address, district: order.district, thana: order.thana },
      customer: {
        id: customer?._id ?? null, name: order.customer_name, phone: showPhones ? order.phone : `${order.phone.slice(0, 3)}••••${order.phone.slice(-3)}`, rawPhone: showPhones ? order.phone : null,
        orders: customer?.stats?.orders ?? 1, spent: customer?.stats?.spent ?? 0, conversationId,
      },
      check: check && { delivered: check.delivered, returned: check.returned, total: check.total, rate: check.rate, sample: check.source === 'sample' }, risk,
      changeRequest: order.change_request?.status === 'open' ? order.change_request : null,
      courier: order.courier, consignmentId: order.consignment_id,
      tracking: consignment && { courier: String(consignment.courier).toLowerCase(), id: consignment.consignment_id, status: consignment.status, events: consignment.events ?? [], at: consignment.created_at },
      couriers: couriers.map((c) => ({ key: c.courier, name: COURIERS[c.courier]?.name ?? c.courier, rate: rate.get(c.courier) ?? rate.get(COURIERS[c.courier]?.name) ?? null, autoBook: c.auto_book })),
      events: events.map((e) => ({ id: e._id, type: e.type, text: e.text, from: e.from, to: e.to, by: e.by, who: e.user_id ? users.get(e.user_id) ?? '' : e.by === 'ai' ? 'AI' : e.by === 'courier' ? 'Courier' : '', at: e.created_at })),
      chat: chat.map((m) => ({ direction: m.direction, text: m.text, byAi: m.sent_by_ai, at: m.created_at })),
      bkash: ws.bkash_number, billToken: order.bill_token, hasChat: Boolean(order.conversation_id), review: order.review ?? null,
    });
  });

  // Screen 24: send the order summary again, a delivery update, or a review request to the customer's chat.
  router.post('/orders/:id/message', auth, need(db, 'reply'), async (req, res) => {
    const order = await loadOrder(req);
    if (!order.conversation_id) throw new InboxError(409, 'This order has no chat to send to');
    const base = config.publicUrl || `${req.protocol}://${req.get('host')}`;
    const billUrl = order.bill_token ? `${base}/b/${order.bill_token}` : '';
    const type = req.body?.type;
    let rich;
    if (type === 'summary') rich = orderSummary(order, { billUrl });
    else if (type === 'update') rich = deliveryUpdate(order, { trackUrl: trackingUrl(order.courier, order.consignment_id), billUrl });
    else if (type === 'review') {
      if (order.status !== 'delivered') throw new InboxError(409, 'Ask for a review once the order is delivered');
      rich = reviewRequest(order);
    } else throw new InboxError(400, 'Unknown message');
    const message = await inbox.sendRich(req.user, order.conversation_id, rich);
    await db.insert(db.orderEvents, { workspace_id: order.workspace_id, order_id: order._id, type: 'note', by: 'user', user_id: req.user.id,
      text: `${req.user.name} sent the ${{ summary: 'order summary', update: 'delivery update', review: 'review request' }[type]} in chat` });
    emit(order.workspace_id, 'order', { id: order._id });
    res.status(201).json({ id: message.id, status: message.status });
  });

  // ORD-07: the customer asked to change something after confirming. Accept applies it; keep closes the request.
  router.post('/orders/:id/change', auth, need(db, 'edit_orders'), async (req, res) => {
    const order = await loadOrder(req);
    const cr = order.change_request;
    if (cr?.status !== 'open') throw new InboxError(409, 'There is no open change request');
    const accept = req.body?.action === 'accept';
    const set = { change_request: { ...cr, status: accept ? 'accepted' : 'kept', decided_by: req.user.name, decided_at: new Date() }, details_changed: false };
    if (accept && cr.field === 'address') set.address = cr.new;
    if (accept && cr.field === 'phone') {
      const phone = bdPhone(cr.new);
      if (!phone) throw new InboxError(400, 'The new phone number is not a valid Bangladeshi mobile');
      set.phone = phone;
    }
    await db.orders.updateOne({ _id: order._id }, { $set: set });
    await db.insert(db.orderEvents, { workspace_id: order.workspace_id, order_id: order._id, type: 'change', by: 'user', user_id: req.user.id,
      text: accept ? `${req.user.name} accepted the new ${cr.field}` : `${req.user.name} kept the old ${cr.field}` });
    emit(order.workspace_id, 'order', { id: order._id });
    res.json({ ok: true });
  });

  router.post('/orders/:id/notes', auth, need(db, 'edit_orders'), async (req, res) => {
    const order = await loadOrder(req);
    const text = String(req.body?.text ?? '').trim().slice(0, 1000);
    if (!text) throw new InboxError(400, 'Write a note');
    const ev = await db.insert(db.orderEvents, { workspace_id: order.workspace_id, order_id: order._id, type: 'note', by: 'user', user_id: req.user.id, text });
    const team = await db.users.find({ workspace_id: order.workspace_id, is_active: true }, { name: 1 }).lean();
    for (const u of team.filter((x) => x._id !== req.user.id && new RegExp(`@${escapeRegex(x.name)}\\b`, 'i').test(text))) {
      await notify({ workspaceId: order.workspace_id, userIds: [u._id], event: 'mention', title: `${req.user.name} mentioned you`, body: `on order #${order.number}: "${text.slice(0, 80)}"`, link: `/orders/${order.number}` });
    }
    res.status(201).json({ id: ev.id, text, who: req.user.name, at: ev.created_at, type: 'note' });
  });

  // "Ask for ৳300 bKash advance": sends the bKash number in chat and remembers the request (PAY-03).
  router.post('/orders/:id/advance-request', auth, need(db, 'edit_orders'), async (req, res) => {
    const order = await loadOrder(req);
    const ws = await db.workspaces.findById(order.workspace_id, { bkash_number: 1 }).lean();
    const amount = Number.parseInt(req.body?.amount, 10);
    if (!Number.isInteger(amount) || amount < 50 || amount > orderTotal(order)) throw new InboxError(400, 'Enter an advance between ৳50 and the order total');
    if (!ws.bkash_number) throw new InboxError(409, 'Add your bKash number in Settings → Payment setup first');
    const conversationId = order.conversation_id ?? (order.customer_id ? (await db.conversations.findOne({ customer_id: order.customer_id }, { _id: 1 }).sort({ last_message_at: -1 }).lean())?._id : null);
    const text = `অর্ডার #${order.number} কনফার্ম করতে ৳${amount} অগ্রিম বিকাশ করুন: ${ws.bkash_number} (Send Money)। পাঠানোর পর TrxID টা দিন প্লিজ 🙏`;
    let sent = false;
    if (conversationId) sent = Boolean(await inbox.sendReply(req.user, conversationId, text).catch(() => null));
    await db.orders.updateOne({ _id: order._id }, { $set: { advance: { ...(order.advance ?? {}), requested: amount, method: 'bkash', requested_at: new Date() } } });
    await db.insert(db.orderEvents, { workspace_id: order.workspace_id, order_id: order._id, type: 'payment', by: 'user', user_id: req.user.id,
      text: `${req.user.name} asked for a ৳${amount} bKash advance${sent ? ' in chat' : ' (no chat to send it to — call the customer)'}` });
    res.json({ sent, text });
  });

  router.post('/orders/:id/book', auth, need(db, 'book_couriers'), async (req, res) => {
    const order = await loadOrder(req);
    res.json(await bookCourier(db, config, req.user, order, String(req.body?.courier ?? 'steadfast'), { emit, fetchImpl }));
  });

  // Asks the courier for the latest status now (CRR-02); a background job does this every 30 minutes too.
  router.post('/orders/:id/track', auth, async (req, res) => {
    const order = await loadOrder(req);
    res.json(await syncConsignment(db, config, order, { emit, fetchImpl, notify }));
  });

  router.post('/orders/:id/deliver', auth, need(db, 'edit_orders'), async (req, res) => {
    const order = await loadOrder(req);
    const updated = await changeStatus(db, req.user, order, 'delivered', { emit, text: `${req.user.name} marked it delivered` });
    res.json({ status: stage(updated.status) });
  });

  return router;
}

// Pulls one consignment's status from its courier and moves the order along if it changed.
export async function syncConsignment(db, config, order, { emit = () => {}, fetchImpl, notify = null } = {}) {
  const c = await db.consignments.findOne({ order_id: order._id }).sort({ created_at: -1 }).lean();
  if (!c) throw new InboxError(409, 'This order has no courier booking yet');
  const account = await db.courierAccounts.findOne({ workspace_id: order.workspace_id, courier: c.courier }).lean();
  let creds = null;
  if (account?.credentials) { try { creds = JSON.parse(decryptSecret(account.credentials, config.tokenKey)); } catch { creds = null; } }
  const client = courierClient(c.courier, creds, { dryRun: config.dryRun, fetchImpl });
  if (client.mode === 'fake') return { status: c.status, testMode: true };
  const { status } = await client.track(c.consignment_id);
  if (status && status !== c.status) {
    await db.consignments.updateOne({ _id: c._id }, { $set: { status }, $push: { events: { status, at: new Date(), text: status } } });
    const to = toPipeline(status);
    if (to !== stage(order.status) && NEXT[stage(order.status)]?.includes(to)) {
      await changeStatus(db, null, order, to, { emit, by: 'courier', text: `${COURIERS[c.courier]?.name}: ${status}`, reason: to === 'cancelled' ? 'other' : '' });
      if (to === 'returned') {
        await notify?.({ workspaceId: order.workspace_id, event: 'courier', title: `Order #${order.number ?? order._id} is coming back.`,
          body: `${COURIERS[c.courier]?.name ?? c.courier} marked it ${status.replace(/_/g, ' ')}. Call ${order.customer_name} or rebook it.`, link: `/orders/${order.number ?? order._id}`, ref: `courier:${order._id}:${status}` });
      }
    }
  }
  return { status };
}

// Background courier sync for every parcel on the way (started by the server, not in tests).
export function startCourierSync(db, config, { emit, fetchImpl, notify = null, everyMs = 30 * 60_000 } = {}) {
  const run = async () => {
    const orders = await db.orders.find({ status: { $in: ['in_transit', 'shipped'] }, consignment_id: { $ne: '' } }).limit(500).lean();
    for (const o of orders) await syncConsignment(db, config, o, { emit, fetchImpl, notify }).catch((err) => console.warn(`courier sync #${o.number}:`, err.message));
  };
  const timer = setInterval(() => run().catch(() => {}), everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

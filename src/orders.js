import { row } from './db.js';
import { InboxError } from './inbox.js';

export const ORDER_STATUSES = ['confirmed', 'shipped', 'delivered', 'cancelled', 'returned'];
export const PAYMENT_METHODS = ['cod', 'bkash', 'nagad', 'rocket', 'bank'];
const AREAS = ['inside_dhaka', 'outside_dhaka'];
const AREA_LABEL = { inside_dhaka: 'inside Dhaka', outside_dhaka: 'outside Dhaka' };

// Accepts 01711-111111, +8801711111111, 8801711111111 or 008801711111111 and
// returns the 11-digit local form couriers expect, or null if it isn't a BD mobile.
export function normalizeBdPhone(input) {
  let digits = String(input ?? '').replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('880')) digits = digits.slice(2);
  return /^01[3-9]\d{8}$/.test(digits) ? digits : null;
}

function wholeTaka(value, field) {
  const n = Number(value ?? 0);
  if (!Number.isInteger(n) || n < 0) throw new InboxError(400, `${field} must be a whole number of taka`);
  return n;
}

function text(value, field, { required = true, max = 500 } = {}) {
  const s = String(value ?? '').trim();
  if (required && !s) throw new InboxError(400, `${field} is required`);
  if (s.length > max) throw new InboxError(400, `${field} is too long`);
  return s;
}

// Validates form input and works out the money. deliveryCharge may be given to
// override the shop's default for the area (e.g. free delivery offers).
export function buildOrder(input, workspace) {
  const area = AREAS.includes(input?.area) ? input.area : null;
  if (!area) throw new InboxError(400, 'Choose inside or outside Dhaka');
  const phone = normalizeBdPhone(input.phone);
  if (!phone) throw new InboxError(400, 'Phone must be a Bangladeshi mobile number like 01711111111');
  const paymentMethod = input.paymentMethod ?? 'cod';
  if (!PAYMENT_METHODS.includes(paymentMethod)) throw new InboxError(400, 'Unknown payment method');

  if (!Array.isArray(input.items) || input.items.length === 0) throw new InboxError(400, 'Add at least one product');
  const items = input.items.map((item, i) => {
    const qty = wholeTaka(item?.qty ?? 1, `Quantity of item ${i + 1}`);
    if (qty < 1) throw new InboxError(400, `Quantity of item ${i + 1} must be at least 1`);
    return { name: text(item?.name, `Name of item ${i + 1}`, { max: 200 }), qty, price: wholeTaka(item?.price, `Price of item ${i + 1}`) };
  });

  const subtotal = items.reduce((sum, item) => sum + item.qty * item.price, 0);
  const deliveryCharge = input.deliveryCharge === undefined || input.deliveryCharge === null || input.deliveryCharge === ''
    ? workspace[area === 'inside_dhaka' ? 'delivery_inside_dhaka' : 'delivery_outside_dhaka']
    : wholeTaka(input.deliveryCharge, 'Delivery charge');
  const discount = wholeTaka(input.discount, 'Discount');
  const advancePaid = wholeTaka(input.advancePaid, 'Advance paid');
  const total = subtotal + deliveryCharge - discount;
  if (total < 0) throw new InboxError(400, 'Discount is larger than the order total');
  if (advancePaid > total) throw new InboxError(400, 'Advance paid is larger than the order total');

  return {
    customerName: text(input.customerName, 'Customer name', { max: 120 }),
    phone,
    address: text(input.address, 'Address'),
    area,
    items,
    subtotal,
    deliveryCharge,
    discount,
    advancePaid,
    codAmount: total - advancePaid,
    paymentMethod,
    note: text(input.note, 'Note', { required: false }),
  };
}

const taka = (n) => `৳${n.toLocaleString('en-IN')}`;

export function orderSummary(order) {
  const lines = [
    `Order #${order.id} confirmed ✅`,
    `${order.customer_name}, ${order.phone}`,
    order.address,
    '',
    ...order.items.map((item) => `${item.qty} × ${item.name} — ${taka(item.qty * item.price)}`),
    `Delivery (${AREA_LABEL[order.area]}): ${taka(order.delivery_charge)}`,
  ];
  if (order.discount) lines.push(`Discount: −${taka(order.discount)}`);
  if (order.advance_paid) lines.push(`Advance paid: −${taka(order.advance_paid)}`);
  lines.push(`Cash on delivery: ${taka(order.cod_amount)}`, '', 'Thank you for your order!');
  return lines.join('\n');
}

function csvCell(value) {
  if (typeof value === 'number') return String(value);
  let s = String(value ?? '');
  // Stop spreadsheet apps from running customer-typed text as a formula.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function ordersCsv(orders) {
  const header = ['order_id', 'created_at', 'status', 'customer_name', 'phone', 'address', 'area', 'items',
    'subtotal', 'delivery_charge', 'discount', 'advance_paid', 'cod_amount', 'payment_method', 'note'];
  const rows = orders.map((o) => [
    o.id, new Date(o.created_at).toISOString(), o.status, o.customer_name, o.phone, o.address, o.area,
    o.items.map((i) => `${i.qty} x ${i.name}`).join('; '),
    o.subtotal, o.delivery_charge, o.discount, o.advance_paid, o.cod_amount, o.payment_method, o.note,
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

// Adds the name of the team member who took each order.
async function withCreator(db, docs) {
  const ids = [...new Set(docs.map((d) => d.created_by_user_id).filter((v) => v != null))];
  const users = new Map((await db.users.find({ _id: { $in: ids } }, { name: 1 }).lean()).map((u) => [u._id, u.name]));
  return docs.map((d) => ({ ...row(d), created_by_name: users.get(d.created_by_user_id) ?? null }));
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createOrders(db, inbox, { emit = () => {} } = {}) {
  async function getOrder(id) {
    const doc = Number.isInteger(id) ? await db.orders.findById(id).lean() : null;
    return doc ? (await withCreator(db, [doc]))[0] : null;
  }

  // Owners see every order; moderators see the ones they took and the ones on
  // customers they handle.
  async function visibleTo(user, order) {
    if (!order || order.workspace_id !== user.workspace_id) return false;
    if (user.role === 'owner' || order.created_by_user_id === user.id) return true;
    const conversation = order.conversation_id && await inbox.getConversation(order.conversation_id);
    return Boolean(conversation && conversation.assigned_user_id === user.id);
  }

  async function accessibleConversation(user, conversationId) {
    const conversation = Number.isInteger(conversationId) ? await inbox.getConversation(conversationId) : null;
    if (!inbox.canAccess(user, conversation)) throw new InboxError(404, 'Conversation not found');
    return conversation;
  }

  function publish(order) {
    emit(order.workspace_id, 'order', order);
    return order;
  }

  return {
    // Fills the order form from what we already know about the customer.
    async draftFor(user, conversationId) {
      const conversation = await accessibleConversation(user, conversationId);
      const [last] = await db.orders.find({ conversation_id: conversationId }, { customer_name: 1, phone: 1, address: 1, area: 1 })
        .sort({ _id: -1 }).limit(1).lean();
      if (last) return { customerName: last.customer_name, phone: last.phone, address: last.address, area: last.area };
      return {
        customerName: conversation.contact_name ?? '',
        phone: conversation.platform === 'whatsapp' ? normalizeBdPhone(conversation.contact_external_id) ?? '' : '',
        address: '',
        area: 'inside_dhaka',
      };
    },

    async create(user, conversationId, input, { sendSummary = false } = {}) {
      const conversation = await accessibleConversation(user, conversationId);
      if (conversation.assigned_user_id && conversation.assigned_user_id !== user.id && user.role !== 'owner') {
        throw new InboxError(403, `This customer is handled by ${conversation.assigned_user_name}`);
      }
      const workspace = await db.workspaces.findById(user.workspace_id).lean();
      const o = buildOrder(input ?? {}, workspace);
      const inserted = await db.insert(db.orders, {
        workspace_id: user.workspace_id, conversation_id: conversationId, created_by_user_id: user.id,
        customer_name: o.customerName, phone: o.phone, address: o.address, area: o.area, items: o.items,
        subtotal: o.subtotal, delivery_charge: o.deliveryCharge, discount: o.discount, advance_paid: o.advancePaid,
        cod_amount: o.codAmount, payment_method: o.paymentMethod, note: o.note,
      });
      const order = publish(await getOrder(inserted.id));

      // The order is saved even if Meta won't take the message (e.g. outside the 24h window).
      let summaryError = null;
      if (sendSummary) {
        try {
          const message = await inbox.sendReply(user, conversationId, orderSummary(order));
          if (message.status === 'failed') summaryError = message.error;
        } catch (err) {
          summaryError = err.message;
        }
      }
      return { order, summaryError };
    },

    async list(user, { status, q } = {}) {
      const where = { workspace_id: user.workspace_id };
      if (ORDER_STATUSES.includes(status)) where.status = status;
      const and = [];
      const query = typeof q === 'string' ? q.trim() : '';
      if (query) {
        const like = new RegExp(escapeRegex(query), 'i');
        const or = [{ customer_name: like }, { phone: like }];
        const number = query.replace(/^#/, '');
        if (/^\d+$/.test(number)) or.push({ _id: Number(number) });
        and.push({ $or: or });
      }
      if (user.role !== 'owner') {
        const mine = await db.conversations.find({ assigned_user_id: user.id }, { _id: 1 }).lean();
        and.push({ $or: [{ created_by_user_id: user.id }, { conversation_id: { $in: mine.map((c) => c._id) } }] });
      }
      if (and.length) where.$and = and;
      return withCreator(db, await db.orders.find(where).sort({ _id: -1 }).limit(500).lean());
    },

    async forConversation(user, conversationId) {
      await accessibleConversation(user, conversationId);
      return withCreator(db, await db.orders.find({ conversation_id: conversationId }).sort({ _id: -1 }).lean());
    },

    async update(user, orderId, { status, note } = {}) {
      const order = await getOrder(orderId);
      if (!(await visibleTo(user, order))) throw new InboxError(404, 'Order not found');
      if (status !== undefined && !ORDER_STATUSES.includes(status)) throw new InboxError(400, 'Unknown order status');
      const set = { updated_at: new Date() };
      if (status !== undefined) set.status = status;
      if (note !== undefined) set.note = text(note, 'Note', { required: false });
      await db.orders.updateOne({ _id: orderId }, { $set: set });
      return publish(await getOrder(orderId));
    },
  };
}

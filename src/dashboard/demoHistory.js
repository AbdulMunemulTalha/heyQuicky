import { randomBytes } from 'node:crypto';
import { dhakaDayStart } from './util.js';

// A month of past chats and orders for the demo shop, so Analytics, the week chart and the
// heatmap have something real to show. Every chat is closed, so today's Inbox is unchanged.
// Deterministic: the same seed gives the same history.

const FIRST = ['Ayesha', 'Rumana', 'Tania', 'Nadia', 'Lima', 'Sumaiya', 'Rahim', 'Karim', 'Arif', 'Mahin', 'Sabrina', 'Mou', 'Popy', 'Shanta', 'Rakib', 'Habib', 'Jannat', 'Faria', 'Tasnim', 'Sakib'];
const LAST = ['Akter', 'Islam', 'Hossain', 'Rahman', 'Begum', 'Ahmed', 'Khatun', 'Chowdhury', 'Sarkar', 'Mia'];
// Customers message most in the evening and late at night (Dhaka time).
const HOUR_WEIGHT = [6, 3, 1, 1, 1, 1, 1, 2, 3, 4, 5, 6, 6, 6, 5, 5, 6, 7, 8, 9, 11, 13, 13, 10];
const ASK = ['আপু দাম কত?', 'L size ache?', 'ঢাকার বাইরে ডেলিভারি কত দিনে?', 'ছবির মতো কালার হবে?', 'COD hobe?', 'অর্ডার করতে চাই'];
const CANCEL = [['customer_cancelled', 5], ['fake_order', 2], ['duplicate', 2], ['out_of_stock', 1], ['other', 1]];

export async function seedHistory(db, { ws, products, PRODUCTS, channels, users, customerFor, count = 60, startNumber = 960 }) {
  let s = 7;
  const rnd = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const weighted = (pairs) => {
    let r = rnd() * pairs.reduce((a, [, w]) => a + w, 0);
    for (const [v, w] of pairs) { r -= w; if (r <= 0) return v; }
    return pairs[0][0];
  };
  const now = Date.now();
  let number = startNumber;

  for (let i = 0; i < count; i += 1) {
    const day = 1 + Math.floor(rnd() * 29);
    const hour = weighted(HOUR_WEIGHT.map((w, h) => [h, w]));
    let at = dhakaDayStart(new Date(now), -day).getTime() + hour * 3_600_000 + Math.floor(rnd() * 3_000_000);
    if (at > now - 3_600_000) at = now - 3_600_000 - i * 60_000;
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    const phone = `01${3 + Math.floor(rnd() * 7)}${String(Math.floor(rnd() * 1e8)).padStart(8, '0')}`;
    const platform = weighted([['messenger', 7], ['instagram', 2], ['whatsapp', 1]]);
    const ordered = rnd() < 0.72;
    const source = ordered ? weighted([['ai', 13], ['team', 4], ['product_page', 2], ['website', 1]]) : 'ai';
    const teammate = source === 'team' ? pick(['Rafi', 'Talha']) : null;

    const contact = await db.insert(db.contacts, { workspace_id: ws.id, channel_id: channels[platform], external_id: `hist-${ws.id}-${i}`, name });
    const customer = await customerFor(`${name} #${i}`, phone, { contact_ids: [contact.id] });
    await db.customers.updateOne({ _id: customer.id }, { $set: { name } });
    const turns = 2 + Math.floor(rnd() * 3);
    const conv = await db.insert(db.conversations, {
      workspace_id: ws.id, channel_id: channels[platform], contact_id: contact.id, customer_id: customer.id, status: 'closed',
      last_message_at: new Date(at + turns * 240_000), last_inbound_at: new Date(at + (turns - 1) * 240_000), last_message_preview: 'ধন্যবাদ 😊',
      done_at: new Date(at + turns * 240_000 + 600_000), done_by: teammate ?? 'AI', last_replier: teammate ? 'team' : 'ai',
      first_reply_at: new Date(at + 20_000), created_at: new Date(at),
    });
    for (let k = 0; k < turns; k += 1) {
      const t = at + k * 240_000;
      await db.insert(db.messages, { conversation_id: conv.id, direction: 'in', text: k === 0 ? pick(ASK) : 'ok', status: 'received', created_at: new Date(t) });
      if (teammate && k === turns - 1) {
        await db.insert(db.messages, { conversation_id: conv.id, direction: 'out', text: 'অর্ডার কনফার্ম করে দিচ্ছি।', status: 'sent', sender_user_id: users[teammate], created_at: new Date(t + 420_000) });
      } else {
        await db.insert(db.messages, { conversation_id: conv.id, direction: 'out', text: 'জি আপু 😊', status: 'sent', sent_by_ai: true, created_at: new Date(t + 6_000 + Math.floor(rnd() * 30_000)) });
        await db.insert(db.aiReplies, { workspace_id: ws.id, kind: 'reply', model: 'claude-opus-5-5', cost: Math.round((0.08 + rnd() * 0.22) * 100) / 100, saved: 0.05,
          summary: 'Answered a question', customer_name: name, created_at: new Date(t + 6_000) });
      }
    }
    if (!ordered) continue;

    const lines = [];
    for (let n = 0, m = rnd() < 0.25 ? 2 : 1; n < m; n += 1) {
      const p = pick(PRODUCTS);
      const size = pick(Object.keys(p.sizes));
      lines.push({ product_id: products[p.code].id, name: p.name, variant: size, qty: rnd() < 0.2 ? 2 : 1, price: p.price, sku: `${p.code}-${size}` });
    }
    const subtotal = lines.reduce((a, l) => a + l.price * l.qty, 0);
    const outside = rnd() < 0.4;
    const delivery = outside ? 130 : 70;
    const status = day <= 2 ? weighted([['in_transit', 3], ['delivered', 2], ['cancelled', 1]]) : weighted([['delivered', 78], ['returned', 9], ['cancelled', 11]]);
    const courier = status === 'cancelled' ? '' : weighted([['Steadfast', 7], ['Pathao', 3]]);
    const orderAt = new Date(at + turns * 240_000);
    number += 1;
    const order = await db.insert(db.orders, {
      workspace_id: ws.id, number, customer_id: customer.id, customer_name: name, phone, address: `House ${number % 40}, Road ${number % 9}`,
      area: outside ? 'outside_dhaka' : 'inside_dhaka', district: outside ? pick(['Chattogram', 'Sylhet', 'Rajshahi', 'Khulna']) : 'Dhaka',
      items: lines.map((l) => ({ name: `${l.name} (${l.variant})`, qty: l.qty, price: l.price })), product_items: lines,
      subtotal, delivery_charge: delivery, discount: 0, cod_amount: subtotal + delivery, payment_method: 'cod',
      status, source, taken_by: source === 'ai' ? 'ai' : teammate ?? source, created_by_user_id: teammate ? users[teammate] : null,
      cancel_reason: status === 'cancelled' ? weighted(CANCEL) : '', courier, consignment_id: courier ? `${courier.slice(0, 2).toUpperCase()}-${20000 + number}` : '',
      conversation_id: conv.id, bill_token: randomBytes(9).toString('base64url'), created_at: orderAt, updated_at: orderAt,
    });
    await db.insert(db.orderEvents, { workspace_id: ws.id, order_id: order.id, type: 'status', to: 'pending', by: source === 'ai' ? 'ai' : 'user', text: 'Order created', created_at: orderAt });
    await db.customers.updateOne({ _id: customer.id }, { $set: { last_active_at: orderAt }, $inc: {
      'stats.orders': 1, 'stats.spent': status === 'delivered' ? subtotal + delivery : 0, 'stats.delivered': status === 'delivered' ? 1 : 0,
      'stats.returned': status === 'returned' ? 1 : 0, 'stats.cancelled': status === 'cancelled' ? 1 : 0,
    } });
  }
}

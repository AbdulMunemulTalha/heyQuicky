import { Router } from 'express';
import { can } from '../../dashboard/permissions.js';
import { asciiDigits, escapeRegex } from '../../dashboard/util.js';
import { orderTotal } from '../../dashboard/orderOps.js';

const TYPES = ['chats', 'orders', 'customers', 'products'];
const mask = (p) => `${p.slice(0, 3)}••••${p.slice(-3)}`;

// Universal search, screen 23 (INB-05, UX-06): chats (names and words inside messages), orders, customers, products.
export function searchRoutes(db, _config, { auth }) {
  const router = Router();

  router.get('/search', auth, async (req, res) => {
    const raw = asciiDigits(String(req.query.q ?? '')).trim().slice(0, 80);
    const type = TYPES.includes(req.query.type) ? req.query.type : 'all';
    const empty = { q: raw, chats: [], orders: [], customers: [], products: [] };
    if (raw.length < 2) return res.json(empty);
    const wsId = req.user.workspace_id;
    const ws = await db.workspaces.findById(wsId, { settings: 1 }).lean();
    const limit = type === 'all' ? 5 : 20;
    const want = (t) => type === 'all' || type === t;
    const like = new RegExp(escapeRegex(raw), 'i');
    // Phone numbers match however they're typed: 01712-345678, +8801712345678, ০১৭১২…
    const digits = raw.replace(/\D/g, '').replace(/^880/, '0');
    const phoneLike = digits.length >= 4 ? new RegExp(escapeRegex(digits)) : null;
    const number = /^#?\d+$/.test(raw) ? Number(raw.replace('#', '')) : null;
    const showPhones = can(req.user, 'see_phones', ws);

    const [chats, orders, customers, products] = await Promise.all([
      want('chats') ? searchChats() : [],
      want('orders') ? db.orders.find({ workspace_id: wsId, draft: { $ne: true }, $or: [
        ...(number ? [{ number }] : []), { customer_name: like }, ...(phoneLike ? [{ phone: phoneLike }] : []),
      ] }).sort({ created_at: -1 }).limit(limit).lean() : [],
      want('customers') ? db.customers.find({ workspace_id: wsId, $or: [
        { name: like }, ...(phoneLike ? [{ phones: phoneLike }] : []), { tags: like },
      ] }).sort({ last_active_at: -1 }).limit(limit).lean() : [],
      want('products') ? db.products.find({ workspace_id: wsId, archived: { $ne: true }, $or: [{ name: like }, { code: like }, { category: like }] })
        .sort({ sold_count: -1 }).limit(limit).lean() : [],
    ]);

    res.json({
      q: raw,
      chats,
      orders: orders.map((o) => ({
        id: o._id, number: o.number ?? o._id, name: o.customer_name, status: o.status, total: orderTotal(o), at: o.created_at,
        items: (o.product_items ?? o.items ?? []).map((i) => `${i.name}${i.variant ? ` (${i.variant})` : ''}`).slice(0, 2).join(', '),
        more: Math.max(0, (o.product_items ?? o.items ?? []).length - 2),
      })),
      customers: customers.map((c) => {
        const s = c.stats ?? {};
        const done = (s.delivered ?? 0) + (s.returned ?? 0);
        return { id: c._id, name: c.name || 'Customer', phone: c.phones?.[0] ? (showPhones ? c.phones[0] : mask(c.phones[0])) : '', vip: Boolean(c.vip),
          orders: s.orders ?? 0, deliveredPct: done ? Math.round(((s.delivered ?? 0) / done) * 100) : null, area: c.area || '' };
      }),
      products: products.map((p) => ({ id: p._id, name: p.name, code: p.code, price: p.price, inStock: p.in_stock !== false, photo: p.photos?.[0] ?? '', colour: p.colour })),
    });

    // Chats: by the customer's name, or by words anywhere in the conversation ("searches inside every message too").
    async function searchChats() {
      const scope = can(req.user, 'see_all_chats', ws) ? {} : { $or: [{ assigned_user_id: req.user.id }, { assigned_user_id: null }] };
      const base = { workspace_id: wsId, spam: { $ne: true }, ...scope };
      const contacts = await db.contacts.find({ workspace_id: wsId, name: like }, { _id: 1 }).limit(50).lean();
      const byName = await db.conversations.find({ ...base, contact_id: { $in: contacts.map((c) => c._id) } }).sort({ last_message_at: -1 }).limit(limit).lean();
      const convIds = await db.conversations.distinct('_id', base);
      const hits = raw.length >= 3 ? await db.messages.find({ conversation_id: { $in: convIds }, text: like }, { conversation_id: 1, text: 1, created_at: 1 })
        .sort({ _id: -1 }).limit(60).lean() : [];
      const snippet = new Map();
      for (const m of hits) if (!snippet.has(m.conversation_id)) snippet.set(m.conversation_id, m);
      const extraIds = [...snippet.keys()].filter((id) => !byName.some((c) => c._id === id)).slice(0, limit);
      const byText = extraIds.length ? await db.conversations.find({ _id: { $in: extraIds } }).lean() : [];
      const list = [...byName, ...byText].slice(0, limit);
      const [names, channels] = await Promise.all([
        db.contacts.find({ _id: { $in: list.map((c) => c.contact_id) } }, { name: 1 }).lean(),
        db.channels.find({ workspace_id: wsId }, { platform: 1 }).lean(),
      ]);
      const name = new Map(names.map((c) => [c._id, c.name]));
      const platform = new Map(channels.map((c) => [c._id, c.platform]));
      return list.map((c) => {
        const m = snippet.get(c._id);
        return { id: c._id, name: name.get(c.contact_id) || 'Customer', platform: platform.get(c.channel_id) ?? '', at: m?.created_at ?? c.last_message_at,
          text: m ? around(m.text, raw) : c.last_message_preview ?? '', matchedText: Boolean(m) };
      });
    }
  });

  return router;
}

// "…sadia apu er moto same design ta chai" — the matched words with a little context.
function around(text, q) {
  const s = String(text ?? '').replace(/\s+/g, ' ');
  const i = s.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0 || s.length <= 80) return s.slice(0, 80);
  const start = Math.max(0, i - 25);
  return `${start ? '…' : ''}${s.slice(start, start + 80)}${start + 80 < s.length ? '…' : ''}`;
}

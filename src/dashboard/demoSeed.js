import { randomBytes } from 'node:crypto';
import { publish } from './training.js';
import { hashPassword } from '../auth.js';
import { addCredit } from './credit.js';

// The "Nokshi Threads" shop from the designs. Used by `npm run seed:demo` (development) and, with
// sandbox: true, for the demo shop new owners can explore (ONB-09). Never sends anything anywhere.
const min = (n) => new Date(Date.now() - n * 60_000);
const hrs = (n) => min(n * 60);
const days = (n) => min(n * 1440);

const PRODUCTS = [
  { code: 'NT-104', name: 'Nokshi Cotton Three-Piece', price: 2150, compare_at: 2500, category: 'Three-piece', colour: '#2F7D74', sizes: { S: 4, M: 2, L: 6, XL: 0 }, sold: 64, tags: ['sale'] },
  { code: 'NT-118', name: 'Jamdani Kurti', price: 1450, category: 'Kurti', colour: '#A9B6D8', sizes: { M: 8, L: 5 }, sold: 41 },
  { code: 'NT-131', name: 'Eid Silk Set', price: 2950, compare_at: 3300, category: 'Three-piece', colour: '#7A1F2B', sizes: { M: 1, L: 2, XL: 0 }, sold: 22, tags: ['sale'] },
  { code: 'NT-140', name: 'Silk Panjabi', price: 2550, category: 'Panjabi', colour: '#2B6A5F', sizes: { M: 0, L: 0, XL: 0 }, sold: 0, waiting: 12 },
  { code: 'NT-152', name: 'Cotton Kurti', price: 1250, category: 'Kurti', colour: '#9C7A4A', sizes: { S: 9, M: 12, L: 7 }, sold: 88 },
  { code: 'NT-160', name: 'Embroidered Orna', price: 450, category: 'Orna', colour: '#D9C6A5', sizes: { Free: 30 }, sold: 31 },
  { code: 'NT-171', name: 'Block Print Saree', price: 3200, compare_at: 3600, category: 'Saree', colour: '#C77B5A', sizes: { Free: 2 }, sold: 9, tags: ['sale'] },
  { code: 'NT-185', name: 'Kids Panjabi', price: 990, category: 'Kids', colour: '#B9C9A0', sizes: { '4Y': 5, '6Y': 3, '8Y': 1 }, sold: 19 },
  { code: 'WS-15', name: 'Winter Shawl', price: 1850, category: 'Shawl', colour: '#5B4B8A', sizes: { Free: 14 }, sold: 12 },
];

const TEAM = [
  ['Talha', 'talha@nokshithreads.com', 'owner', '01712345678', true],
  ['Rafi', 'rafi@nokshithreads.com', 'admin', '01819000120', true],
  ['Mim', 'mim@nokshithreads.com', 'agent', '01711000332', true],
  ['Jubayer', 'jubayer@nokshithreads.com', 'moderator', '01922000051', false],
  ['Sumi', 'sumi@gmail.com', 'agent', '', false],
];

// [name, platform, last text, minutes ago, state]
const CHATS = [
  ['Sadia Rahman', 'messenger', 'ছবির সাথে কালার একদম মেলেনি। আমি রিটার্ন করতে চাই', 4, { handoff: 'Refund request, colour mismatch', act: true, tags: ['VIP', 'Repeat buyer', 'Dhaka'] }],
  ['Rakib Hasan', 'messenger', 'ভাই ৪২ সাইজ আছে?', 9, { handoff: 'Asked for size 42 (not in catalog)', comment: true }],
  ['Tanvir Ahmed', 'instagram', 'আচ্ছা ঠিক আছে, ধন্যবাদ', 2, { ai: true }],
  ['Mitu Akter', 'whatsapp', 'আপু L সাইজ টা কবে আসবে?', 2, { reopened: true, tags: ['Discount'] }],
  ['Imran Kabir', 'messenger', 'thank you vai, peye gechi', 300, { done: true }],
  ['Farzana Haque', 'messenger', 'ok apu, order confirm', 180, { done: true }],
  ['Farhan Hossain', 'messenger', 'ডেলিভারি চার্জ কত ঢাকার বাইরে?', 18, { ai: true, tags: ['Hot lead'] }],
  ['Nusrat Islam', 'messenger', 'price koto apu?', 21, { ai: true }],
  ['Rafiq Uddin', 'messenger', 'ঠিক আছে ভাই, কাল পাঠিয়ে দিন', 60, { team: 'Rafi' }],
  ['Shirin Akter', 'messenger', 'ঠিকানা টা চেঞ্জ করে দেন প্লিজ', 14, { handoff: 'Address change after confirm' }],
  ['Earn Money BD', 'messenger', 'ঘরে বসে দিনে ৫০০০ টাকা ইনকাম করুন লিংকে ক্লিক করুন', 12, { spam: 'Money-making link' }],
];

const ORDERS = [
  // number, name, phone, items [[code, size, qty]], status, source, area, minutes ago, extra
  [1052, 'Tanvir Ahmed', '01819224410', [['NT-118', 'M', 1]], 'pending', 'ai', 'inside_dhaka', 2, { district: 'Dhaka', thana: 'Banani' }],
  [1051, 'Shirin Akter', '01934556120', [['NT-131', 'L', 2]], 'on_hold', 'ai', 'outside_dhaka', 14, { district: 'Chattogram', thana: 'Kotwali', hold: 'High return risk (60%)', changed: true }],
  [1050, 'Mitu Akter', '01711908823', [['NT-104', 'L', 1]], 'approved', 'product_page', 'inside_dhaka', 38, { coupon: 'EID10' }],
  [1049, 'Rafiq Uddin', '01552781190', [['NT-140', 'XL', 1], ['NT-160', 'Free', 1]], 'ready_to_ship', 'team', 'outside_dhaka', 60, { advance: 300 }],
  [1048, 'Nusrat Islam', '01611340987', [['NT-104', 'M', 1]], 'ready_to_ship', 'ai', 'inside_dhaka', 120, {}],
  [1046, 'Farzana Haque', '01799112233', [['NT-152', 'M', 3]], 'in_transit', 'ai', 'inside_dhaka', 300, { courier: 'Steadfast', cid: 'SF-29402' }],
  [1043, 'Imran Kabir', '01922450034', [['NT-140', 'L', 1]], 'in_transit', 'website', 'outside_dhaka', 1500, { courier: 'Pathao', cid: 'PT-88120', paid: true }],
  [1031, 'Sadia Rahman', '01712345678', [['NT-104', 'M', 1]], 'delivered', 'ai', 'inside_dhaka', 1700, { courier: 'Steadfast', cid: 'SF-29211' }],
  [1029, 'Jahid Hasan', '01866773310', [['NT-131', 'M', 1]], 'cancelled', 'ai', 'outside_dhaka', 2900, { cancel: 'Customer cancelled in chat' }],
];

export async function seedNokshi(db, { reset = false, sandbox = false, email = 'talha@nokshithreads.com', password = 'password123' } = {}) {
  const existing = await db.users.findOne({ email }).lean();
  if (existing && !reset) return { created: false, workspaceId: existing.workspace_id };
  if (existing && reset) await wipe(db, existing.workspace_id);

  const ws = await db.insert(db.workspaces, {
    name: 'Nokshi Threads', category: 'clothing', onboarding_step: 'done', ai_mode: 'auto', ai_name: 'Nusrat', ai_style: 'banglish',
    ai_address: 'auto', address: 'House 12, Road 4, Mirpur 10, Dhaka', bkash_number: '01712345678', nagad_number: '01712345678',
    delivery_inside_dhaka: 70, delivery_outside_dhaka: 130, delivery_inside_days: '1-2 days', delivery_outside_days: '3-5 days',
    went_live_at: days(20), trial_started_at: days(20), order_seq: 1052, ai_version: 24,
    settings: { sandbox, persona: { role: 'Page moderator', delay: '3-6' } },
  });
  const hash = hashPassword(password);
  const users = {};
  for (const [name, mail, role, phone, onDuty] of TEAM) {
    const u = await db.insert(db.users, {
      workspace_id: ws.id, name, email: sandbox ? `${name.toLowerCase()}.${ws.id}@demo.heyquicky.com` : mail, phone,
      password_hash: hash, role, is_online: onDuty, on_duty: onDuty, invite_pending: name === 'Sumi',
    });
    users[name] = u.id;
  }
  if (sandbox) await db.users.updateOne({ _id: users.Talha }, { $set: { email } });

  const channels = {};
  for (const [platform, ext, name] of [['messenger', `nokshi-page-${ws.id}`, 'Nokshi Threads'], ['instagram', `nokshi-ig-${ws.id}`, '@nokshithreads'], ['whatsapp', `nokshi-wa-${ws.id}`, '+880 1712-345678']]) {
    channels[platform] = (await db.insert(db.channels, { workspace_id: ws.id, platform, external_id: ext, name, access_token: '' })).id;
  }

  // Couriers are connected without keys, so booking runs in test mode in development.
  for (const courier of ['steadfast', 'pathao']) await db.insert(db.courierAccounts, { workspace_id: ws.id, courier, connected: true, auto_book: courier === 'steadfast' });

  for (const [code, type, value, min, audience, used] of [['EID10', 'percent', 10, 1500, 'everyone', 112], ['FREEDEL', 'free_delivery', 0, 2000, 'everyone', 64],
    ['THANKS10', 'percent', 10, 0, 'after_review', 38], ['VIP300', 'amount', 300, 1000, 'vip', 41], ['COMEBACK', 'amount', 150, 0, 'broadcast', 24]]) {
    await db.insert(db.coupons, { workspace_id: ws.id, code, type, value, min_order: min, audience, used, max_uses: code === 'EID10' ? 200 : null, ends_at: new Date('2026-12-31') });
  }

  const charts = {};
  for (const [key, name, columns, rows] of [
    ['three', 'Three-piece · women (inches)', ['Size', 'Chest', 'Length', 'Hip'], [['S', '36', '42', '38'], ['M', '38', '43', '40'], ['L', '40', '44', '42'], ['XL', '42', '45', '44']]],
    ['kurti', 'Kurti · women (inches)', ['Size', 'Chest', 'Length'], [['S', '36', '40'], ['M', '38', '41'], ['L', '40', '42']]],
    ['panjabi', 'Panjabi · men (inches)', ['Size', 'Chest', 'Length'], [['M', '40', '42'], ['L', '42', '43'], ['XL', '44', '44']]],
  ]) charts[key] = (await db.insert(db.sizeCharts, { workspace_id: ws.id, name, unit: 'inch', columns, rows })).id;
  const chartFor = { 'NT-104': 'three', 'NT-131': 'three', 'NT-152': 'kurti', 'NT-140': 'panjabi' };

  const products = {};
  for (const p of PRODUCTS) {
    const variants = Object.entries(p.sizes).map(([size, stock]) => ({ sku: `${p.code}-${size}`, options: { Size: size }, price: p.price, stock }));
    const doc = await db.insert(db.products, {
      workspace_id: ws.id, code: p.code, name: p.name, price: p.price, compare_at: p.compare_at ?? null, category: p.category, colour: p.colour,
      options: [{ name: 'Size', values: Object.keys(p.sizes) }], variant_list: variants, variants: Object.keys(p.sizes).join(', '),
      in_stock: variants.some((v) => v.stock > 0), sold_count: p.sold, restock_waiting: p.waiting ?? 0, ai_tags: p.tags ?? [],
      description: `${p.name} — soft fabric, made in Bangladesh.`, size_chart_id: charts[chartFor[p.code]] ?? null,
    });
    products[p.code] = doc;
  }

  const customers = {};
  const customerFor = async (name, phone, extra = {}) => {
    if (customers[name]) return customers[name];
    customers[name] = await db.insert(db.customers, { workspace_id: ws.id, name, phones: phone ? [phone] : [], last_active_at: min(10), ...extra });
    return customers[name];
  };

  const convs = {};
  for (const [name, platform, text, ago, state] of CHATS) {
    const contact = await db.insert(db.contacts, { workspace_id: ws.id, channel_id: channels[platform], external_id: `${name.replace(/\s/g, '').toLowerCase()}-${ws.id}`, name });
    const customer = await customerFor(name, '', { contact_ids: [contact.id], tags: state.tags ?? [], vip: (state.tags ?? []).includes('VIP') });
    await db.customers.updateOne({ _id: customer.id }, { $addToSet: { contact_ids: contact.id } });
    const conv = await db.insert(db.conversations, {
      workspace_id: ws.id, channel_id: channels[platform], contact_id: contact.id, customer_id: customer.id,
      assigned_user_id: state.team ? users[state.team] : state.handoff ? users.Rafi : null, unread_count: state.ai ? 0 : 1,
      last_message_at: min(ago), last_inbound_at: min(ago), last_message_preview: text,
      ai_handoff: Boolean(state.handoff), ai_handoff_reason: state.handoff ?? '', ai_handoff_at: state.handoff ? min(ago) : null,
      act_now: Boolean(state.act), spam: Boolean(state.spam), spam_reason: state.spam ?? '',
      tags: [...(state.tags ?? []), ...(state.reopened ? ['Back from Done'] : [])],
      status: state.done ? 'closed' : 'open', done_at: state.done || state.reopened ? min(ago + 60) : null, done_by: state.done || state.reopened ? 'Rafi' : '',
      reopened_at: state.reopened ? min(ago) : null,
      last_replier: state.ai ? 'ai' : state.team ? 'team' : 'customer',
    });
    convs[name] = conv.id;
    const say = (direction, body, at, extra = {}) => db.insert(db.messages, { conversation_id: conv.id, direction, text: body, created_at: at, status: direction === 'in' ? 'received' : 'sent', ...extra });
    await say('in', 'আপু এই থ্রি-পিস টা কি L সাইজে আছে?', min(ago + 1200));
    await say('out', 'জি আপু, Nokshi Cotton Three-Piece L সাইজে ৬টা আছে। দাম ৳২,১৫০, ঢাকার ভিতরে ডেলিভারি ৳৭০।', min(ago + 1199), { sent_by_ai: true });
    if (state.team) await say('out', 'ঠিক আছে ভাই, কাল সকালে পাঠিয়ে দেব।', min(ago + 5), { sender_user_id: users[state.team] });
    await say('in', text, min(ago));
    if (state.ai) await say('out', 'জি, অবশ্যই! আর কিছু জানতে চাইলে বলবেন 😊', min(Math.max(ago - 1, 0)), { sent_by_ai: true });
    if (name === 'Sadia Rahman') {
      await db.insert(db.notes, { workspace_id: ws.id, conversation_id: conv.id, customer_id: customer.id, author_user_id: users.Rafi, text: 'VIP — call before 6 pm. Prefers bKash.', created_at: days(3) });
    }
  }

  for (const [shortcut, name, text, phrases, uses] of [
    ['/delivery', 'Delivery charge', 'ঢাকার ভিতরে ডেলিভারি চার্জ ৳৭০, ঢাকার বাইরে ৳১৩০। ঢাকায় ১-২ দিন, বাইরে ৩-৫ দিন লাগে।', ['ডেলিভারি চার্জ কত?', 'delivery charge koto'], 412],
    ['/bkash', 'How to pay (bKash)', 'বিকাশে পাঠান 01712345678 (Personal)। পাঠানোর পর TrxID টা দিন প্লিজ।', ['bkash number', 'বিকাশ নম্বর'], 188],
    ['/size', 'Size chart', 'আমাদের সাইজ চার্টটা দেখে নিন। বুকের মাপ বললে সঠিক সাইজ বলে দেব।', ['size chart', 'সাইজ'], 146],
    ['/exchange', 'Exchange policy', 'ডেলিভারির ৩ দিনের মধ্যে, ব্যবহার না করা ও ট্যাগসহ থাকলে এক্সচেঞ্জ করা যাবে।', ['exchange', 'বদলানো যাবে'], 39],
    ['/refund', 'Refund', 'দুঃখিত আপু। ছবি পাঠালে আমরা দেখে রিফান্ড বা এক্সচেঞ্জ করে দেব।', ['refund', 'রিফান্ড', 'রিটার্ন'], 12],
    ['/new', 'New collection', 'নতুন কালেকশন এই শুক্রবার আসছে! আগে জানাতে চাইলে বলুন।', ['new collection', 'নতুন'], 71],
  ]) {
    await db.insert(db.savedReplies, { workspace_id: ws.id, shortcut, name, text, phrases, uses, auto_answer: shortcut !== '/refund', folder: shortcut === '/bkash' ? 'Payment' : shortcut === '/size' ? 'Size' : 'Delivery' });
  }

  const posts = [
    ['ঈদ কালেকশন — নকশি থ্রি-পিস 🌸 সব সাইজ পাওয়া যাচ্ছে', 2, ['NT-104'], 'linked', [
      ['Tanvir Ahmed', 'price koto? M size ache?', 6, 'replied', 'জি ভাইয়া, M সাইজ আছে 😊 দাম ৳২,১৫০। ডিটেইলস ইনবক্সে পাঠিয়েছি।', 'AI'],
      ['Rakib Hasan', 'ভাই ৪২ সাইজ আছে? আমার বউয়ের জন্য লাগবে', 9, 'needs_you'],
      ['Mitu Akter', 'Delivery charge koto outside Dhaka?', 22, 'replied', 'আপু, ঢাকার বাইরে ৳১৩০, ৩-৫ দিনে পৌঁছাবে। ইনবক্স চেক করুন 💌', 'AI'],
      ['Unknown profile', 'cheap copy, sobai fake 😡 017xx-xxxxxx call koren', 40, 'hidden'],
      ['Sadia Rahman', 'কালারটা কি ছবির মতোই?', 60, 'needs_you'],
    ]],
    ['New colour: Rose', 9, ['NT-104'], 'linked', []],
    ['Silk Panjabi restock', 11, ['NT-140'], 'linked', []],
    ['Live sale replay', 12, [], 'ai_match', []],
    ['Winter shawl preview', 14, ['WS-15'], 'linked', []],
  ];
  for (const [caption, daysAgo, codes, match, comments] of posts) {
    const post = await db.insert(db.posts, { workspace_id: ws.id, channel_id: channels.messenger, external_id: `post-${ws.id}-${daysAgo}`, platform: 'facebook', caption,
      product_ids: codes.map((c) => products[c].id), match, comment_count: comments.length ? 214 : 20 + daysAgo * 3, posted_at: days(daysAgo) });
    for (const [author, text, ago, status, reply, by] of comments) {
      await db.insert(db.comments, { workspace_id: ws.id, channel_id: channels.messenger, post_id: post.id, external_id: `c-${ws.id}-${daysAgo}-${ago}`,
        author_name: author, author_external_id: `${author.replace(/\s/g, '').toLowerCase()}-${ws.id}`, text, status, public_reply: reply ?? '', replied_by: by ?? '',
        dm_sent: Boolean(reply), hidden_reason: status === 'hidden' ? 'Phone number' : '', created_at: min(ago) });
    }
  }

  for (const [number, name, phone, items, status, source, area, ago, extra] of ORDERS) {
    const lines = items.map(([code, size, qty]) => ({ product_id: products[code].id, name: products[code].name, variant: size, qty, price: products[code].price, sku: `${code}-${size}` }));
    const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
    const delivery = area === 'inside_dhaka' ? 70 : 130;
    const discount = extra.coupon ? Math.round(subtotal * 0.1) : 0;
    const advance = extra.advance ?? 0;
    const customer = await customerFor(name, phone);
    await db.customers.updateOne({ _id: customer.id }, { $addToSet: { phones: phone } });
    const order = await db.insert(db.orders, {
      workspace_id: ws.id, number, customer_id: customer.id, customer_name: name, phone, address: `House ${number % 40}, Road ${number % 9}, ${extra.thana ?? 'Mirpur'}`,
      area, district: extra.district ?? (area === 'inside_dhaka' ? 'Dhaka' : 'Chattogram'), thana: extra.thana ?? '',
      items: lines.map((l) => ({ name: `${l.name} (${l.variant})`, qty: l.qty, price: l.price })), product_items: lines,
      subtotal, delivery_charge: delivery, discount, advance_paid: advance, cod_amount: extra.paid ? 0 : subtotal + delivery - discount - advance,
      payment_method: extra.paid ? 'paid' : advance ? 'bkash' : 'cod', advance: advance ? { amount: advance, method: 'bkash', trx_id: 'BKH8X2K9QP', verified: true } : null,
      paid_in_full: Boolean(extra.paid), status, source, taken_by: source === 'ai' ? 'ai' : source === 'team' ? 'Rafi' : source,
      coupon_code: extra.coupon ?? '', hold_reason: extra.hold ?? '', cancel_reason: extra.cancel ?? '', details_changed: Boolean(extra.changed),
      change_request: extra.changed ? { field: 'address', old: 'House 12, Road 4, Chawkbazar, Chattogram', new: 'Flat 3B, Lalkhan Bazar, Chattogram', at: min(ago - 2), status: 'open' } : null,
      courier: extra.courier ?? '', consignment_id: extra.cid ?? '', bill_token: randomBytes(9).toString('base64url'),
      created_at: min(ago), updated_at: min(Math.max(ago - 30, 0)),
    });
    await db.insert(db.orderEvents, { workspace_id: ws.id, order_id: order.id, type: 'status', to: 'pending', by: source === 'ai' ? 'ai' : 'user', text: source === 'ai' ? 'Nusrat (AI) took the order in Messenger' : 'Order created', created_at: min(ago) });
    if (extra.cid) await db.insert(db.consignments, { workspace_id: ws.id, order_id: order.id, courier: extra.courier.toLowerCase(), consignment_id: extra.cid, tracking_code: extra.cid, status, created_at: min(ago - 60) });
    await db.customers.updateOne({ _id: customer.id }, { $inc: { 'stats.orders': 1, 'stats.spent': status === 'delivered' ? subtotal : 0, 'stats.delivered': status === 'delivered' ? 1 : 0, 'stats.cancelled': status === 'cancelled' ? 1 : 0 } });
  }

  // Realistic histories for the customers the designs show (orders before the ones above).
  for (const [name, stats, tags, vip] of [
    ['Sadia Rahman', { orders: 4, delivered: 4, returned: 0, cancelled: 0, spent: 8640 }, ['VIP', 'Repeat buyer', 'Dhaka'], true],
    ['Shirin Akter', { orders: 7, delivered: 3, returned: 4, cancelled: 0, spent: 4210 }, ['High risk'], false],
    ['Rafiq Uddin', { orders: 7, delivered: 7, returned: 0, cancelled: 0, spent: 19380 }, ['VIP', 'Wholesale'], true],
    ['Farzana Haque', { orders: 3, delivered: 2, returned: 0, cancelled: 0, spent: 6020 }, ['Repeat buyer'], false],
    ['Nusrat Islam', { orders: 3, delivered: 2, returned: 1, cancelled: 0, spent: 4400 }, [], false],
    ['Imran Kabir', { orders: 2, delivered: 2, returned: 0, cancelled: 0, spent: 5100 }, [], false],
  ]) {
    if (customers[name]) await db.customers.updateOne({ _id: customers[name].id }, { $set: { stats, vip }, $addToSet: { tags: { $each: tags } } });
  }
  await db.customers.updateOne({ workspace_id: ws.id, name: 'Earn Money BD' }, { $set: { blocked: true, ai_off: true, ai_off_reason: 'Spam' } });

  // Follow-ups (FUP-01) and leads (FUP-03) as in frame 05.
  for (const [name, temp, status, dueMin, extra] of [
    ['Farhan Hossain', 'hot', 'watching', 40, {}], ['Nusrat Islam', 'warm', 'watching', 18 * 60, {}],
    ['Tanvir Ahmed', 'hot', 'sent', -30, { step: 2, sent_at: min(30) }], ['Mitu Akter', 'warm', 'sent', 9 * 60, { step: 1, sent_at: min(120), with_offer: true }],
    ['Rakib Hasan', 'skip', 'skipped', 0, { skip_reason: 'A teammate is handling it' }], ['Imran Kabir', 'skip', 'skipped', 0, { skip_reason: 'Said no, or only said thanks' }],
  ]) {
    if (!convs[name]) continue;
    await db.insert(db.followups, { workspace_id: ws.id, conversation_id: convs[name], temp, status, due_at: new Date(Date.now() + dueMin * 60_000), ...extra });
  }
  for (const [name, phone, product, amount, temp, stage, times, ago, outcome] of [
    ['Tanvir Ahmed', '01819224410', 'Jamdani Kurti', 1450, 'hot', 'new', 2, 9, ''], ['Nadia Islam', '01711552244', 'Eid Silk Set', 2950, 'hot', 'new', 1, 18, ''],
    ['Kamrul H.', '01822334455', 'Silk Panjabi', 2550, 'warm', 'new', 1, 60, ''], ['Farhan Hossain', '01611223344', 'Nokshi Cotton Three-Piece', 2150, 'hot', 'new', 3, 18, ''],
    ['Rina Begum', '01933112233', 'Nokshi Cotton Three-Piece', 2150, 'warm', 'contacted', 2, 300, 'no_answer'], ['Sabbir H.', '01744556677', 'Winter Shawl', 1850, 'warm', 'call_scheduled', 1, 400, 'call_later'],
  ]) {
    await db.insert(db.prospects, { workspace_id: ws.id, name, phone, product, amount, temp, stage, times_asked: times, last_seen_at: min(ago), outcome,
      conversation_id: convs[name] ?? null, customer_id: customers[name]?.id ?? null, owner_user_id: outcome ? users.Rafi : null,
      callback_at: outcome === 'call_later' ? new Date(Date.now() + 26 * 3_600_000) : null, follow_up_at: new Date(Date.now() + 3 * 3_600_000) });
  }
  await db.insert(db.broadcasts, { workspace_id: ws.id, audience: { key: 'last_24h' }, format: 'carousel', status: 'sent', sent_at: days(2),
    content: { text: 'নতুন শীতের কালেকশন এসেছে! আজ অর্ডার করলে ফ্রি ডেলিভারি 🎁', productIds: [] }, recipients: Object.values(convs).slice(0, 5),
    stats: { recipients: 214, sent: 214 } });

  for (const [question, count, topic] of [['৪২ সাইজ হবে? / 42 size ache?', 31, 'Sizes asked by chest number'], ['কবে নতুন কালেকশন আসবে?', 18, 'New stock dates'],
    ['ঢাকার বাইরে কন্ডিশনে চার্জ লাগবে?', 14, 'Courier condition charge'], ['শোরুম কোথায়?', 9, 'Physical shop / visit']]) {
    await db.insert(db.unanswered, { workspace_id: ws.id, question, key: question.toLowerCase(), topic, count, last_asked_at: min(count * 3) });
  }

  // What the AI knows, and its published versions (screen 07).
  for (const [kind, title, text] of [
    ['delivery', 'Delivery', 'ঢাকার ভেতরে ১-২ দিন, চার্জ ৳৮০। ঢাকার বাইরে ২-৪ দিন, চার্জ ৳১৩০। ক্যাশ অন ডেলিভারি আছে।'],
    ['exchange', 'Exchange', 'Exchange within 3 days if unused and with the tag. Size exchange is free inside Dhaka.'],
    ['hours', 'Hours', 'Replies 10am-11pm every day. Orders after 6pm ship the next day.'],
    ['payment', 'Advance', 'Outside Dhaka orders over ৳3,000 need ৳200 advance by bKash or Nagad.'],
  ]) await db.insert(db.knowledge, { workspace_id: ws.id, kind, title, text, source: 'owner' });
  await db.workspaces.updateOne({ _id: ws.id }, { $set: { ai_version: 22 } });
  await publish(db, { workspace_id: ws.id, name: 'Talha' }, 'Knowledge: Advance', 'knowledge');
  await publish(db, { workspace_id: ws.id, name: 'Talha' }, 'Persona updated', 'persona');

  for (const [method, amount, trx, from, ago] of [['bkash', 300, 'BKH8X2K9QP', '01819-22•••', 2], ['nagad', 500, '73KQ9P2M', '01934-55•••', 14], ['bkash', 250, 'BKH77QZ1LA', '01611-34•••', 38]]) {
    await db.insert(db.payments, { workspace_id: ws.id, method, amount, expected: method === 'bkash' && amount === 250 ? 300 : amount, trx_id: trx, from_number: from, created_at: min(ago) });
  }

  // AI history for billing and analytics: replies today with costs.
  for (let i = 0; i < 40; i += 1) {
    await db.insert(db.aiReplies, { workspace_id: ws.id, kind: i % 9 === 0 ? 'saved' : 'reply', model: 'claude-opus-5-5', cost: i % 9 === 0 ? 0 : 0.08 + (i % 5) * 0.06,
      saved: 0.05, summary: ['Took order #1052 (4 replies)', 'Found product from a photo', 'Apologised and handed to team', 'Follow-up reminder'][i % 4],
      customer_name: ['Tanvir Ahmed', 'Mitu Akter', 'Sadia Rahman', 'Farhan Hossain'][i % 4], created_at: min(i * 9) });
  }
  await addCredit(db, ws.id, 412.5, { type: 'top_up', method: 'bkash', ref: 'Demo credit' });

  for (const [actor, action, where, ago] of [['Talha', 'Published AI version 24 (size by chest number)', 'AI training', 120], ['Rafi', 'Changed order #1051 status On hold → Pending', 'Orders', 160],
    ['Rafi', 'Booked Steadfast for 4 orders', 'Orders', 200], ['System', 'Steadfast parcel SF-29391 booked automatically', 'Orders', 2]]) {
    await db.insert(db.audit, { workspace_id: ws.id, user_id: actor === 'System' ? null : users[actor], actor, action, where, created_at: min(ago) });
  }

  for (const [type, category, title, body, link, ago] of [
    ['handoff', 'chats', 'Rakib Hasan needs a person.', 'The AI could not answer about size 42 on a comment.', '/inbox', 2],
    ['order', 'orders', 'New order #1052', 'Tanvir Ahmed · ৳1,520 · taken by AI in Messenger', '/orders/1052', 2],
    ['escalation', 'orders', 'Order #1051 on hold.', 'High return risk (60%). Ask Shirin for an advance?', '/orders/1051', 14],
    ['mention', 'chats', 'Rafi mentioned you', 'in Shirin Akter: "@Talha ask for advance?"', '/inbox', 4],
    ['stock', 'system', 'Low stock: Nokshi Three-Piece Teal / L', 'is sold out. The AI stopped offering it.', '/catalog', 32],
  ]) {
    await db.insert(db.notifications, { workspace_id: ws.id, user_id: users.Talha, type, category, title, body, link, created_at: min(ago) });
  }

  return { created: true, workspaceId: ws.id, ownerId: users.Talha };
}

async function wipe(db, workspaceId) {
  const convIds = await db.conversations.distinct('_id', { workspace_id: workspaceId });
  await db.messages.deleteMany({ conversation_id: { $in: convIds } });
  const userIds = await db.users.distinct('_id', { workspace_id: workspaceId });
  await db.sessions.deleteMany({ user_id: { $in: userIds } });
  for (const model of Object.values(db)) {
    if (model?.schema?.path?.('workspace_id') && model.collection) await model.deleteMany({ workspace_id: workspaceId });
  }
  await db.workspaces.deleteOne({ _id: workspaceId });
}

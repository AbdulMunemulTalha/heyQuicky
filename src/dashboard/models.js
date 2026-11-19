import mongoose from 'mongoose';

const { Schema } = mongoose;
const Mixed = Schema.Types.Mixed;
const numericId = { type: Number };
const createdAt = { type: Date, default: () => new Date() };
const opts = { versionKey: false };
const ws = { type: Number, required: true, index: true };

// Collections added for the dashboard (see DASHBOARD_PLAN.md §4). Money is stored in whole taka
// (like the existing orders), times in UTC.
export function defineDashboardModels(conn) {
  const S = (fields, extra = {}) => new Schema({ _id: numericId, workspace_id: ws, ...fields, created_at: createdAt }, { ...opts, ...extra });

  // One person across channels: a Messenger contact, an Instagram contact and a WhatsApp number can all be one customer.
  const customer = S({
    name: { type: String, default: '' },
    phones: { type: [String], default: [] },
    emails: { type: [String], default: [] },
    contact_ids: { type: [Number], default: [] },
    tags: { type: [String], default: [] },
    vip: { type: Boolean, default: false },
    ai_off: { type: Boolean, default: false },
    ai_off_reason: { type: String, default: '' },
    blocked: { type: Boolean, default: false },
    address: { type: String, default: '' },
    area: { type: String, default: '' },
    stats: { orders: { type: Number, default: 0 }, delivered: { type: Number, default: 0 }, returned: { type: Number, default: 0 },
      cancelled: { type: Number, default: 0 }, spent: { type: Number, default: 0 } },
    courier_check: { type: Mixed, default: null }, // { delivered, total, rate, couriers, checked_at }
    risk: { type: Mixed, default: null }, // { score, level: low|medium|high, action }
    last_active_at: { type: Date, default: null },
  });
  customer.index({ workspace_id: 1, phones: 1 });
  customer.index({ workspace_id: 1, contact_ids: 1 });
  customer.index({ name: 'text', phones: 'text' });

  // Private notes on a chat or a customer, with @mentions.
  const note = S({
    conversation_id: { type: Number, default: null, index: true },
    customer_id: { type: Number, default: null, index: true },
    order_id: { type: Number, default: null, index: true },
    author_user_id: { type: Number, default: null },
    text: { type: String, required: true },
    mentions: { type: [Number], default: [] },
  });

  // Every change to an order: status moves, notes, change requests, courier and payment events.
  const orderEvent = S({
    order_id: { type: Number, required: true, index: true },
    type: { type: String, required: true },
    from: { type: String, default: null },
    to: { type: String, default: null },
    by: { type: String, default: 'system' }, // ai | user | courier | system | customer
    user_id: { type: Number, default: null },
    text: { type: String, default: '' },
  });

  const consignment = S({
    order_id: { type: Number, required: true, index: true },
    courier: { type: String, required: true },
    consignment_id: { type: String, default: '' },
    tracking_code: { type: String, default: '' },
    status: { type: String, default: 'booked' },
    events: { type: [Mixed], default: [] },
    cod_collected: { type: Number, default: 0 },
    fee: { type: Number, default: 0 },
    payout_id: { type: Number, default: null },
  });

  // A shop's courier account. Keys are encrypted with TOKEN_ENCRYPTION_KEY like channel tokens.
  const courierAccount = S({
    courier: { type: String, required: true },
    credentials: { type: String, default: '' },
    auto_book: { type: Boolean, default: false },
    connected: { type: Boolean, default: false },
    pickup: { type: String, default: '' },
  });
  courierAccount.index({ workspace_id: 1, courier: 1 }, { unique: true });

  // bKash / Nagad payments customers say they sent (TrxID or screenshot), waiting for approval.
  const payment = S({
    order_id: { type: Number, default: null },
    booking_id: { type: Number, default: null },
    method: { type: String, required: true },
    amount: { type: Number, required: true },
    expected: { type: Number, default: null },
    trx_id: { type: String, default: '' },
    from_number: { type: String, default: '' },
    screenshot: { type: String, default: '' },
    status: { type: String, enum: ['waiting', 'approved', 'rejected'], default: 'waiting' },
    decided_by: { type: Number, default: null },
    decided_at: { type: Date, default: null },
  });

  // Every AI reply with its cost, so billing can list them and "Why did the AI say this?" can explain them.
  const aiReply = S({
    conversation_id: { type: Number, default: null, index: true },
    message_id: { type: Number, default: null },
    kind: { type: String, default: 'reply' }, // reply | suggest | copilot | test | followup | teach | selftest | voice
    model: { type: String, default: '' },
    input_tokens: { type: Number, default: 0 },
    output_tokens: { type: Number, default: 0 },
    cache_read_tokens: { type: Number, default: 0 },
    cache_write_tokens: { type: Number, default: 0 },
    cost: { type: Number, default: 0 }, // taka charged (real cost × USD_TO_BDT × markup), fractional
    cost_usd: { type: Number, default: 0 }, // what the model call cost HeyQuicky
    saved: { type: Number, default: 0 }, // taka saved by the cache
    summary: { type: String, default: '' },
    customer_name: { type: String, default: '' },
    steps: { type: [Mixed], default: [] },
    sources: { type: [Mixed], default: [] },
    version: { type: Number, default: null },
    rating: { type: String, default: null },
  });
  aiReply.index({ workspace_id: 1, created_at: -1 });

  // AI credit: top-ups add, replies subtract. balance_after keeps a running total.
  const creditEntry = S({
    type: { type: String, enum: ['top_up', 'ai_reply', 'refund', 'trial', 'adjust'], required: true },
    amount: { type: Number, required: true },
    balance_after: { type: Number, required: true },
    method: { type: String, default: '' },
    ref: { type: String, default: '' },
    status: { type: String, default: 'done' }, // pending while a top-up payment is open
  });

  const notification = S({
    user_id: { type: Number, required: true, index: true },
    type: { type: String, required: true }, // order | handoff | escalation | mention | stock | credit | courier | system
    category: { type: String, default: 'system' }, // orders | chats | system (panel tabs)
    title: { type: String, required: true },
    body: { type: String, default: '' },
    link: { type: String, default: '' },
    actions: { type: [Mixed], default: [] },
    read_at: { type: Date, default: null },
    dismissed: { type: Boolean, default: false },
    ref: { type: String, default: '' }, // de-duplicates repeats of the same event
  });
  notification.index({ user_id: 1, created_at: -1 });

  const pushSubscription = S({
    user_id: { type: Number, required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    keys: { type: Mixed, required: true },
  });

  const audit = S({
    user_id: { type: Number, default: null },
    actor: { type: String, default: '' },
    action: { type: String, required: true },
    target: { type: String, default: '' },
    where: { type: String, default: '' },
  });
  audit.index({ workspace_id: 1, created_at: -1 });

  const passwordReset = new Schema({
    _id: String,
    user_id: { type: Number, required: true },
    code_hash: { type: String, required: true },
    channel: { type: String, default: 'email' },
    attempts: { type: Number, default: 0 },
    verified: { type: Boolean, default: false },
    expires_at: { type: Date, required: true, expires: 0 },
  }, opts);

  // People who showed interest (separate from sign-up leads, which belong to onboarding).
  const prospect = S({
    customer_id: { type: Number, default: null },
    conversation_id: { type: Number, default: null },
    name: { type: String, default: '' },
    phone: { type: String, default: '' },
    channel: { type: String, default: '' },
    product: { type: String, default: '' },
    amount: { type: Number, default: 0 },
    stage: { type: String, enum: ['new', 'contacted', 'call_scheduled', 'won', 'lost'], default: 'new' },
    temp: { type: String, enum: ['hot', 'warm', 'cold'], default: 'warm' },
    times_asked: { type: Number, default: 1 },
    why_stopped: { type: String, default: '' },
    lost_reason: { type: String, default: '' },
    owner_user_id: { type: Number, default: null },
    follow_up_at: { type: Date, default: null },
    callback_at: { type: Date, default: null },
    outcome: { type: String, default: '' },
    order_id: { type: Number, default: null },
    last_seen_at: { type: Date, default: () => new Date() },
  });

  // Reminders the AI sends to people who went quiet (3 h and 20 h, at most 2, inside Meta's 24 h window).
  const followup = S({
    conversation_id: { type: Number, required: true, index: true },
    temp: { type: String, default: 'warm' },
    step: { type: Number, default: 1 },
    due_at: { type: Date, required: true },
    status: { type: String, enum: ['watching', 'sent', 'replied', 'ordered', 'skipped'], default: 'watching' },
    skip_reason: { type: String, default: '' },
    with_offer: { type: Boolean, default: false },
    sent_at: { type: Date, default: null },
  });

  const broadcast = S({
    audience: { type: Mixed, default: {} },
    format: { type: String, default: 'text' },
    content: { type: Mixed, default: {} },
    scheduled_at: { type: Date, default: null },
    status: { type: String, default: 'draft' },
    stats: { type: Mixed, default: { recipients: 0, sent: 0, replied: 0, ordered: 0 } },
    recipients: { type: [Number], default: [] },
    sent_at: { type: Date, default: null },
    created_by: { type: Number, default: null },
  });

  // What the AI knows, written or spoken in plain language.
  const knowledge = S({
    kind: { type: String, default: 'faq' },
    title: { type: String, default: '' },
    text: { type: String, required: true },
    source: { type: String, default: 'owner' },
  });
  const aiRule = S({
    text: { type: String, required: true },
    category: { type: String, default: 'tone' },
    enabled: { type: Boolean, default: true },
    author: { type: String, default: '' },
  });
  const taughtAnswer = S({
    question: { type: String, required: true },
    answer: { type: String, required: true },
    when: { type: [String], default: [] },
    attach: { type: [String], default: [] },
    from_message_id: { type: Number, default: null },
    version: { type: Number, default: null },
  });
  const unanswered = S({
    question: { type: String, required: true },
    key: { type: String, required: true },
    topic: { type: String, default: '' },
    count: { type: Number, default: 1 },
    last_asked_at: { type: Date, default: () => new Date() },
    status: { type: String, enum: ['open', 'ignored', 'taught'], default: 'open' },
  });
  unanswered.index({ workspace_id: 1, key: 1 }, { unique: true });
  const aiVersion = S({
    number: { type: Number, required: true },
    summary: { type: String, required: true },
    by_name: { type: String, default: '' },
    source: { type: String, default: '' },
    snapshot: { type: Mixed, default: {} },
    tests: { type: Mixed, default: null },
  });

  const ticket = S({
    number: { type: Number, required: true },
    customer_id: { type: Number, default: null },
    conversation_id: { type: Number, default: null },
    order_id: { type: Number, default: null },
    title: { type: String, required: true },
    type: { type: String, default: 'complaint' },
    act_now: { type: Boolean, default: false },
    reason: { type: String, default: '' },
    owner_user_id: { type: Number, default: null },
    status: { type: String, default: 'open' },
    resolution: { type: String, default: '' },
    timeline: { type: [Mixed], default: [] },
    solved_at: { type: Date, default: null },
  });

  const comment = S({
    channel_id: { type: Number, required: true },
    post_id: { type: Number, required: true, index: true },
    external_id: { type: String, required: true },
    parent_external_id: { type: String, default: null },
    author_name: { type: String, default: '' },
    author_external_id: { type: String, default: '' },
    text: { type: String, default: '' },
    status: { type: String, default: 'needs_you' }, // needs_you | ai_replied | replied | hidden
    hidden_reason: { type: String, default: '' },
    public_reply: { type: String, default: '' },
    dm_sent: { type: Boolean, default: false },
    replied_by: { type: String, default: '' },
    ai_tried_at: { type: Date, default: null }, // the AI looked at it once (CMT-01), so it never answers twice
    ai_reason: { type: String, default: '' }, // why the AI left it for the team
  });
  comment.index({ external_id: 1 }, { unique: true });

  // Size charts the AI sends when someone asks "what size am I?" (CAT-05). The editor comes in Phase 2.
  const sizeChart = S({
    name: { type: String, required: true },
    unit: { type: String, default: 'inch' },
    columns: { type: [String], default: [] },
    rows: { type: [[String]], default: [] },
  });

  const post = S({
    channel_id: { type: Number, required: true },
    external_id: { type: String, required: true },
    platform: { type: String, default: 'facebook' },
    caption: { type: String, default: '' },
    image: { type: String, default: '' },
    product_ids: { type: [Number], default: [] },
    match: { type: String, default: 'none' }, // linked | ai_match | none
    rules: { type: Mixed, default: { hide_spam: true, hide_phones: true, remind_once: false, react_followup: false } },
    comment_count: { type: Number, default: 0 },
    posted_at: { type: Date, default: () => new Date() },
  });
  post.index({ channel_id: 1, external_id: 1 }, { unique: true });

  // Discount codes (ORD-05). The AI and the order form apply them; usage is counted here.
  const coupon = S({
    code: { type: String, required: true },
    type: { type: String, enum: ['percent', 'amount', 'free_delivery'], required: true },
    value: { type: Number, default: 0 },
    min_order: { type: Number, default: 0 },
    max_uses: { type: Number, default: null },
    used: { type: Number, default: 0 },
    starts_at: { type: Date, default: null },
    ends_at: { type: Date, default: null },
    audience: { type: String, default: 'everyone' },
    ai_may_mention: { type: Boolean, default: true },
    active: { type: Boolean, default: true },
  });
  coupon.index({ workspace_id: 1, code: 1 }, { unique: true });

  // Uploaded photos and voice notes (kept in MongoDB, the one store that survives redeploys).
  const file = new Schema({ _id: String, workspace_id: ws, type: String, size: Number, name: String, data: Buffer, created_at: createdAt }, opts);

  return {
    files: conn.model('File', file, 'files'),
    sizeCharts: conn.model('SizeChart', sizeChart, 'size_charts'),
    coupons: conn.model('Coupon', coupon, 'coupons'),
    customers: conn.model('Customer', customer, 'customers'),
    notes: conn.model('Note', note, 'notes'),
    orderEvents: conn.model('OrderEvent', orderEvent, 'order_events'),
    consignments: conn.model('Consignment', consignment, 'consignments'),
    courierAccounts: conn.model('CourierAccount', courierAccount, 'courier_accounts'),
    payments: conn.model('Payment', payment, 'payments'),
    aiReplies: conn.model('AiReply', aiReply, 'ai_replies'),
    credit: conn.model('CreditEntry', creditEntry, 'credit_ledger'),
    notifications: conn.model('Notification', notification, 'notifications'),
    pushSubscriptions: conn.model('PushSubscription', pushSubscription, 'push_subscriptions'),
    audit: conn.model('Audit', audit, 'audit_log'),
    passwordResets: conn.model('PasswordReset', passwordReset, 'password_resets'),
    prospects: conn.model('Prospect', prospect, 'prospects'),
    followups: conn.model('Followup', followup, 'followups'),
    broadcasts: conn.model('Broadcast', broadcast, 'broadcasts'),
    knowledge: conn.model('Knowledge', knowledge, 'knowledge'),
    aiRules: conn.model('AiRule', aiRule, 'ai_rules'),
    taughtAnswers: conn.model('TaughtAnswer', taughtAnswer, 'taught_answers'),
    unanswered: conn.model('Unanswered', unanswered, 'unanswered'),
    aiVersions: conn.model('AiVersion', aiVersion, 'ai_versions'),
    tickets: conn.model('Ticket', ticket, 'tickets'),
    comments: conn.model('Comment', comment, 'comments'),
    posts: conn.model('Post', post, 'posts'),
    migrations: conn.model('Migration', new Schema({ _id: String, ran_at: createdAt }, opts), 'migrations'),
  };
}

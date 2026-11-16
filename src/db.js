import mongoose from 'mongoose';

const { Schema } = mongoose;

// Records keep short numeric IDs (shown to shops as "Order #12" and used in
// URLs). They come from a per-collection counter instead of ObjectIds, which
// also lets data move over from the old SQLite database with the same IDs.
const numericId = { type: Number };
const createdAt = { type: Date, default: () => new Date() };
const opts = { versionKey: false };

const PLATFORMS = ['messenger', 'instagram', 'whatsapp'];

// Onboarding, in order. 'done' means the shop is set up.
// 'account' = editing the sign-up details again; 'shop', 'products', 'payments', 'team' and 'test'
// belong to the longer onboarding and stay valid for shops that were partway through it.
export const ONBOARDING_STEPS = ['account', 'channels', 'business', 'shop', 'assistant', 'products', 'payments', 'team', 'test', 'live', 'done'];
export const AI_STYLES = ['banglish', 'bangla', 'english', 'casual'];
export const AI_ADDRESS = ['auto', 'apu', 'bhaiya', 'sir_madam', 'bondhu'];
export const AI_SALES = ['consultative', 'direct'];

function defineModels(conn) {
  const counter = new Schema({ _id: String, seq: { type: Number, default: 0 } }, opts);

  const workspace = new Schema({
    _id: numericId,
    name: { type: String, required: true },
    phone: { type: String, default: '' },
    category: { type: String, default: '' },
    // Shops created before onboarding existed count as set up.
    onboarding_step: { type: String, enum: ONBOARDING_STEPS, default: 'done' },
    // Answers from the sign-up form, to size help and plans.
    signup_survey: {
      messages_per_day: { type: String, default: '' },
      team_size: { type: String, default: '' },
      ad_spend: { type: String, default: '' },
    },
    // What the AI asks for before an order is handed to the team, e.g. Size: S, M, L.
    order_fields: { type: [{ _id: false, label: String, hint: String }], default: undefined },
    // Shop & delivery.
    address: { type: String, default: '' },
    sells_offline: { type: Boolean, default: false },
    audience: { type: [String], default: undefined },
    delivery_inside_dhaka: { type: Number, default: 70 },
    delivery_outside_dhaka: { type: Number, default: 130 },
    delivery_inside_days: { type: String, default: '' },
    delivery_outside_days: { type: String, default: '' },
    cash_on_delivery: { type: Boolean, default: true },
    free_delivery_over: { type: Number, default: null },
    // Advance payments: numbers customers send money to.
    bkash_number: { type: String, default: '' },
    nagad_number: { type: String, default: '' },
    // How the AI assistant presents itself.
    ai_name: { type: String, default: '' },
    ai_style: { type: String, enum: AI_STYLES, default: 'banglish' },
    ai_address: { type: String, enum: AI_ADDRESS, default: 'auto' },
    ai_sales: { type: String, enum: AI_SALES, default: 'consultative' },
    // AI chat agent: off, suggest (drafts for moderators) or auto (replies itself).
    ai_mode: { type: String, enum: ['off', 'suggest', 'auto'], default: 'suggest' },
    // Policies, FAQs and anything else the owner wants the AI to know.
    shop_notes: { type: String, default: '' },
    created_at: createdAt,
  }, opts);

  const user = new Schema({
    _id: numericId,
    workspace_id: { type: Number, required: true, index: true },
    name: { type: String, required: true },
    // The owner's mobile, so the team can call if they get stuck during setup.
    phone: { type: String, default: '' },
    // Stored lowercased so sign-in ignores case; see normalizeEmail.
    email: { type: String, required: true, unique: true },
    password_hash: { type: String, required: true },
    role: { type: String, enum: ['owner', 'moderator'], required: true },
    is_active: { type: Boolean, default: true },
    is_online: { type: Boolean, default: false },
    last_assigned_at: { type: Date, default: null },
    created_at: createdAt,
  }, opts);

  const session = new Schema({
    _id: String, // the token
    user_id: { type: Number, required: true, index: true },
    // MongoDB deletes expired sessions on its own (TTL index).
    expires_at: { type: Date, required: true, expires: 0 },
  }, opts);

  // A connected Facebook Page, Instagram professional account or WhatsApp number.
  const channel = new Schema({
    _id: numericId,
    workspace_id: { type: Number, required: true, index: true },
    platform: { type: String, enum: PLATFORMS, required: true },
    external_id: { type: String, required: true },
    name: { type: String, required: true },
    access_token: { type: String, default: '' },
    // Set when Meta rejects the stored token, so the owner knows to reconnect.
    needs_reconnect: { type: Boolean, default: false },
    // The owner can keep the AI away from one channel (e.g. answer WhatsApp themselves).
    ai_enabled: { type: Boolean, default: true },
    waba_id: { type: String, default: null },
    // The Facebook Page an Instagram account is reached through (needed to read its history).
    page_id: { type: String, default: null },
    // Import of conversations that existed before the channel was connected.
    import_status: { type: String, default: '' },
    import_count: { type: Number, default: 0 },
    import_error: { type: String, default: null },
    created_at: createdAt,
  }, opts);
  channel.index({ platform: 1, external_id: 1 }, { unique: true });

  // A customer as seen by one channel (PSID, IGSID or WhatsApp wa_id).
  const contact = new Schema({
    _id: numericId,
    workspace_id: { type: Number, required: true },
    channel_id: { type: Number, required: true },
    external_id: { type: String, required: true },
    name: { type: String, default: null },
    created_at: createdAt,
  }, opts);
  contact.index({ channel_id: 1, external_id: 1 }, { unique: true });

  // One long-lived thread per contact. The assignee sticks across sessions.
  const conversation = new Schema({
    _id: numericId,
    workspace_id: { type: Number, required: true },
    channel_id: { type: Number, required: true, index: true },
    contact_id: { type: Number, required: true, unique: true },
    assigned_user_id: { type: Number, default: null },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    unread_count: { type: Number, default: 0 },
    last_message_at: { type: Date, default: null },
    last_message_preview: { type: String, default: '' },
    last_inbound_at: { type: Date, default: null },
    // Set when the AI hands the customer to a person, or a person replies.
    // In auto mode the AI stays quiet while this is set (it lapses after a while).
    ai_handoff: { type: Boolean, default: false },
    ai_handoff_reason: { type: String, default: '' },
    ai_handoff_at: { type: Date, default: null },
    // The AI's suggested reply to the latest customer message (suggest mode).
    ai_draft: {
      type: new Schema({
        text: String,
        intent: String,
        handoff: Boolean,
        handoff_reason: String,
        for_message_id: Number,
        created_at: Date,
      }, { _id: false }),
      default: null,
    },
    created_at: createdAt,
  }, opts);
  conversation.index({ workspace_id: 1, status: 1, last_message_at: -1 });
  conversation.index({ assigned_user_id: 1, status: 1 });

  const message = new Schema({
    _id: numericId,
    conversation_id: { type: Number, required: true },
    direction: { type: String, enum: ['in', 'out'], required: true },
    sender_user_id: { type: Number, default: null },
    // Written and sent by the AI chat agent rather than a person.
    sent_by_ai: { type: Boolean, default: false },
    text: { type: String, default: '' },
    attachments: { type: [Schema.Types.Mixed], default: [] },
    external_id: { type: String, default: null },
    status: { type: String, enum: ['pending', 'sent', 'delivered', 'read', 'failed', 'received'], default: 'sent' },
    error: { type: String, default: null },
    created_at: createdAt,
  }, opts);
  // Meta retries webhooks; the unique ID is what makes storing them idempotent.
  message.index({ external_id: 1 }, { unique: true, partialFilterExpression: { external_id: { $type: 'string' } } });
  message.index({ conversation_id: 1, _id: 1 });

  // Amounts are whole taka.
  const order = new Schema({
    _id: numericId,
    workspace_id: { type: Number, required: true },
    conversation_id: { type: Number, default: null, index: true },
    created_by_user_id: { type: Number, default: null },
    customer_name: { type: String, required: true },
    phone: { type: String, required: true },
    address: { type: String, required: true },
    area: { type: String, enum: ['inside_dhaka', 'outside_dhaka'], required: true },
    items: { type: [{ _id: false, name: String, qty: Number, price: Number }], required: true },
    subtotal: { type: Number, required: true },
    delivery_charge: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    advance_paid: { type: Number, default: 0 },
    cod_amount: { type: Number, required: true },
    payment_method: { type: String, enum: ['cod', 'bkash', 'nagad', 'rocket', 'bank'], default: 'cod' },
    status: { type: String, enum: ['confirmed', 'shipped', 'delivered', 'cancelled', 'returned'], default: 'confirmed' },
    note: { type: String, default: '' },
    created_at: createdAt,
    updated_at: createdAt,
  }, opts);
  order.index({ workspace_id: 1, status: 1, _id: -1 });

  // Ties a Facebook login redirect back to the owner who started it.
  const oauthState = new Schema({
    _id: String, // the state value
    workspace_id: { type: Number, required: true },
    user_id: { type: Number, required: true },
    redirect_uri: { type: String, required: true },
    // Login opened in a popup: the callback page reports back to the dashboard window instead of redirecting.
    popup: { type: Boolean, default: false },
    expires_at: { type: Date, required: true, expires: 0 },
  }, opts);

  // Pages found after a Facebook login, waiting for the owner to pick which to
  // connect. payload holds page tokens, so it is encrypted like channel tokens.
  const pendingConnection = new Schema({
    _id: String,
    workspace_id: { type: Number, required: true },
    payload: { type: String, required: true },
    expires_at: { type: Date, required: true, expires: 0 },
  }, opts);

  // The shop's products, which the AI quotes prices and stock from. Prices in whole taka.
  const product = new Schema({
    _id: numericId,
    workspace_id: { type: Number, required: true, index: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    // Free text, e.g. "S, M, L, XL / Red, Black".
    variants: { type: String, default: '' },
    description: { type: String, default: '' },
    in_stock: { type: Boolean, default: true },
    created_at: createdAt,
  }, opts);

  // Someone filling in the sign-up form, saved as they type so the team can follow up
  // even if they never press "Create account". Never holds a password.
  const lead = new Schema({
    _id: String, // random id the sign-up page keeps for this visitor
    name: { type: String, default: '' },
    business_name: { type: String, default: '' },
    email: { type: String, default: '', index: true },
    phone: { type: String, default: '' },
    survey: { type: Object, default: {} },
    // Set when the same visitor finishes signing up.
    workspace_id: { type: Number, default: null },
    converted_at: { type: Date, default: null },
    created_at: createdAt,
    updated_at: { type: Date, default: () => new Date() },
  }, opts);

  const savedReply = new Schema({
    _id: numericId,
    workspace_id: { type: Number, required: true },
    shortcut: { type: String, required: true },
    text: { type: String, required: true },
  }, opts);
  savedReply.index({ workspace_id: 1, shortcut: 1 }, { unique: true });

  return {
    counters: conn.model('Counter', counter, 'counters'),
    workspaces: conn.model('Workspace', workspace, 'workspaces'),
    users: conn.model('User', user, 'users'),
    sessions: conn.model('Session', session, 'sessions'),
    channels: conn.model('Channel', channel, 'channels'),
    contacts: conn.model('Contact', contact, 'contacts'),
    conversations: conn.model('Conversation', conversation, 'conversations'),
    messages: conn.model('Message', message, 'messages'),
    orders: conn.model('Order', order, 'orders'),
    oauthStates: conn.model('OAuthState', oauthState, 'oauth_states'),
    pendingConnections: conn.model('PendingConnection', pendingConnection, 'pending_connections'),
    savedReplies: conn.model('SavedReply', savedReply, 'saved_replies'),
    products: conn.model('Product', product, 'products'),
    leads: conn.model('Lead', lead, 'leads'),
  };
}

// Turns a lean MongoDB document into the shape the API returns: `id` instead of `_id`.
export function row(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

export const rows = (docs) => docs.map(row);

export const isDuplicateKey = (err) => err?.code === 11000;

export const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();

export async function openDb(uri, { dbName } = {}) {
  const conn = await mongoose.createConnection(uri, { dbName }).asPromise();
  const models = defineModels(conn);
  // Unique indexes must exist before the first write: duplicate checks rely on them.
  await Promise.all(Object.values(models).map((m) => m.init()));

  async function nextId(collection) {
    const { seq } = await models.counters.findOneAndUpdate(
      { _id: collection }, { $inc: { seq: 1 } }, { upsert: true, new: true, lean: true });
    return seq;
  }

  const db = {
    ...models,
    conn,
    nextId,
    // Inserts a document with the next numeric ID and returns it as a plain row.
    async insert(model, fields) {
      const doc = await model.create({ _id: await nextId(model.collection.collectionName), ...fields });
      return row(doc.toObject());
    },
    // Finds a document by filter, creating it when missing. Safe when two
    // requests race: the loser of the unique index reads the winner's document.
    async findOrCreate(model, filter, fields = {}) {
      const existing = await model.findOne(filter).lean();
      if (existing) return { doc: row(existing), created: false };
      try {
        return { doc: await db.insert(model, { ...filter, ...fields }), created: true };
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        return { doc: row(await model.findOne(filter).lean()), created: false };
      }
    },
    close: () => conn.close(),
  };
  return db;
}

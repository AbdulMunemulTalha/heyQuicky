import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { row, isDuplicateKey, normalizeEmail, ONBOARDING_STEPS, AI_STYLES, AI_ADDRESS, AI_SALES } from '../db.js';
import { parseCsv, productsFromRows, googleSheetCsvUrl } from '../productImport.js';
import { hashPassword, verifyPassword, createSession, deleteSession, bearerToken, requireAuth, requireOwner } from '../auth.js';
import { InboxError } from '../inbox.js';
import { ordersCsv, normalizeBdPhone } from '../orders.js';
import { encryptSecret } from '../secrets.js';

const PLATFORMS = ['messenger', 'instagram', 'whatsapp'];

const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role,
  isOnline: Boolean(u.is_online), isActive: u.is_active === undefined ? true : Boolean(u.is_active),
});

const publicChannel = (c) => ({
  id: c.id, platform: c.platform, externalId: c.external_id, name: c.name, connected: Boolean(c.access_token),
  needsReconnect: Boolean(c.needs_reconnect),
  aiEnabled: c.ai_enabled !== false,
  importStatus: c.import_status || null,
  importError: c.import_error || null,
  conversationCount: c.conversation_count ?? 0,
});

// The onboarding categories; the older ones are still accepted for shops set up before them.
const CATEGORIES = ['clothing', 'cosmetics', 'electronics', 'mobile_accessories', 'jewellery', 'shoes', 'grocery', 'food',
  'salon', 'clinic', 'coaching', 'other', 'fashion', 'beauty', 'home', 'kids'];
const AUDIENCES = ['women', 'girls', 'men', 'kids', 'everyone'];
const SURVEY = {
  messages_per_day: ['under_50', '50_200', '200_1000', '1000_plus'],
  team_size: ['just_me', '1_2', '3_plus'],
  ad_spend: ['none', 'under_20k', '20k_1lakh', '1lakh_plus'],
};

const publicWorkspace = (w) => ({
  id: w.id,
  name: w.name,
  phone: w.phone,
  category: w.category,
  onboardingStep: w.onboarding_step,
  deliveryInsideDhaka: w.delivery_inside_dhaka,
  deliveryOutsideDhaka: w.delivery_outside_dhaka,
  aiMode: w.ai_mode ?? 'suggest',
  shopNotes: w.shop_notes ?? '',
  orderFields: w.order_fields ?? null,
  address: w.address ?? '',
  sellsOffline: Boolean(w.sells_offline),
  audience: w.audience ?? [],
  deliveryInsideDays: w.delivery_inside_days ?? '',
  deliveryOutsideDays: w.delivery_outside_days ?? '',
  cashOnDelivery: w.cash_on_delivery !== false,
  freeDeliveryOver: w.free_delivery_over ?? null,
  bkashNumber: w.bkash_number ?? '',
  nagadNumber: w.nagad_number ?? '',
  aiName: w.ai_name ?? '',
  aiStyle: w.ai_style ?? 'banglish',
  aiAddress: w.ai_address ?? 'auto',
  aiSales: w.ai_sales ?? 'consultative',
});

const text = (value, max, label) => {
  const out = String(value ?? '').trim();
  if (out.length > max) throw new InboxError(400, `${label} is too long (${max} characters at most)`);
  return out;
};
const oneOf = (value, allowed, message) => {
  if (!allowed.includes(value)) throw new InboxError(400, message);
  return value;
};

const publicProduct = (p) => ({
  id: p._id ?? p.id, name: p.name, price: p.price, variants: p.variants ?? '', description: p.description ?? '', inStock: p.in_stock !== false,
});

const AI_MODES = ['off', 'suggest', 'auto'];

// Validates product form input; `partial` allows updating only some fields.
function productFields(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => body?.[k] !== undefined;
  if (!partial || has('name')) {
    const name = String(body?.name ?? '').trim();
    if (!name || name.length > 120) throw new InboxError(400, 'Product name is required');
    out.name = name;
  }
  if (!partial || has('price')) {
    const price = Number(body?.price);
    if (!Number.isInteger(price) || price < 0) throw new InboxError(400, 'Price must be a whole number of taka');
    out.price = price;
  }
  for (const [key, field, max] of [['variants', 'variants', 300], ['description', 'description', 1000]]) {
    if (!has(key)) continue;
    const value = String(body[key]).trim();
    if (value.length > max) throw new InboxError(400, `${key} is too long`);
    out[field] = value;
  }
  if (has('inStock')) out.in_stock = Boolean(body.inStock);
  return out;
}

const publicReply = (r) => ({ id: r._id, shortcut: r.shortcut, text: r.text });

function required(body, fields) {
  for (const f of fields) {
    if (typeof body?.[f] !== 'string' || !body[f].trim()) throw new InboxError(400, `${f} is required`);
  }
}

// IDs in URLs are whole numbers; anything else can't match a record.
function id(req) {
  const n = Number(req.params.id);
  if (!Number.isSafeInteger(n)) throw new InboxError(404, 'Not found');
  return n;
}

export function apiRoutes(db, config, inbox, orders, importer, agent, { fetchImpl = fetch } = {}) {
  const router = Router();
  const auth = requireAuth(db);
  const getWorkspace = async (wsId) => row(await db.workspaces.findById(wsId).lean());
  const getUser = async (userId) => row(await db.users.findById(userId).lean());

  async function openCounts(filter) {
    const counts = await db.conversations.aggregate([{ $match: filter }, { $group: { _id: '$assigned_user_id', n: { $sum: 1 } } }]);
    return new Map(counts.map((c) => [c._id, c.n]));
  }

  router.post('/auth/signup', async (req, res) => {
    required(req.body, ['businessName', 'name', 'email', 'password']);
    const { businessName, name, password } = req.body;
    const email = normalizeEmail(req.body.email);
    if (password.length < 8) throw new InboxError(400, 'Password must be at least 8 characters');
    if (await db.users.exists({ email })) throw new InboxError(409, 'Email already registered');
    if (businessName.trim().length > 100) throw new InboxError(400, 'Shop name is too long');
    const phone = String(req.body.phone ?? '').trim() ? normalizeBdPhone(req.body.phone) : '';
    if (phone === null) throw new InboxError(400, 'Mobile must be a Bangladeshi number like 01711111111');
    const survey = {};
    for (const [key, allowed] of Object.entries(SURVEY)) {
      const value = req.body.survey?.[key];
      if (value !== undefined && value !== '') survey[key] = oneOf(value, allowed, 'Unknown answer in the sign-up questions');
    }
    const ws = await db.insert(db.workspaces, { name: businessName.trim(), onboarding_step: 'channels', signup_survey: survey });
    let user;
    try {
      user = await db.insert(db.users, {
        workspace_id: ws.id, name: name.trim(), phone, email, password_hash: hashPassword(password), role: 'owner', is_online: true,
      });
    } catch (err) {
      // Someone signed up with the same email at the same moment.
      await db.workspaces.deleteOne({ _id: ws.id });
      if (isDuplicateKey(err)) throw new InboxError(409, 'Email already registered');
      throw err;
    }
    res.status(201).json({ token: await createSession(db, user.id), user: publicUser(user) });
  });

  router.post('/auth/login', async (req, res) => {
    required(req.body, ['email', 'password']);
    const user = row(await db.users.findOne({ email: normalizeEmail(req.body.email), is_active: true }).lean());
    if (!user || !verifyPassword(req.body.password, user.password_hash)) {
      throw new InboxError(401, 'Wrong email or password');
    }
    res.json({ token: await createSession(db, user.id), user: publicUser(user) });
  });

  router.post('/auth/logout', auth, async (req, res) => {
    await deleteSession(db, bearerToken(req));
    res.sendStatus(204);
  });

  router.get('/me', auth, async (req, res) => {
    res.json({
      user: publicUser(req.user),
      workspace: publicWorkspace(await getWorkspace(req.user.workspace_id)),
      devTools: !config.isProduction,
      support: { email: config.legal?.supportEmail || null },
      ai: agent ? { available: agent.status().available, model: agent.status().model } : { available: false, model: null },
      connect: {
        facebook: Boolean(config.meta.appId && config.meta.appSecret),
        whatsapp: Boolean(config.meta.appId && config.meta.appSecret && config.meta.whatsappConfigId),
        appId: config.meta.appId,
        whatsappConfigId: config.meta.whatsappConfigId,
        graphVersion: config.meta.graphVersion,
      },
    });
  });

  router.post('/me/duty', auth, async (req, res) => {
    const assigned = await inbox.setOnDuty(req.user, Boolean(req.body?.online));
    res.json({ online: Boolean(req.body?.online), assigned });
  });

  router.get('/conversations', auth, async (req, res) => {
    res.json(await inbox.listConversations(req.user, {
      filter: req.query.filter,
      status: ['open', 'closed'].includes(req.query.status) ? req.query.status : 'all',
    }));
  });

  router.get('/conversations/:id/messages', auth, async (req, res) => {
    res.json(await inbox.listMessages(req.user, id(req)));
  });

  // Express 5 forwards rejected promises to the error handler below.
  router.post('/conversations/:id/messages', auth, async (req, res) => {
    res.status(201).json(await inbox.sendReply(req.user, id(req), req.body?.text));
  });

  router.post('/conversations/:id/read', auth, async (req, res) => {
    res.json(await inbox.markRead(req.user, id(req)));
  });

  router.post('/conversations/:id/status', auth, async (req, res) => {
    res.json(await inbox.setStatus(req.user, id(req), req.body?.status));
  });

  router.post('/conversations/:id/assign', auth, requireOwner, async (req, res) => {
    const userId = req.body?.userId == null ? null : Number(req.body.userId);
    res.json(await inbox.reassign(req.user, id(req), userId));
  });

  router.patch('/workspace', auth, requireOwner, async (req, res) => {
    const body = req.body ?? {};
    const updates = {};
    for (const [key, field] of [['deliveryInsideDhaka', 'delivery_inside_dhaka'], ['deliveryOutsideDhaka', 'delivery_outside_dhaka']]) {
      if (body[key] === undefined) continue;
      const value = Number(body[key]);
      if (!Number.isInteger(value) || value < 0) throw new InboxError(400, 'Delivery charge must be a whole number of taka');
      updates[field] = value;
    }
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name || name.length > 100) throw new InboxError(400, 'Business name is required');
      updates.name = name;
    }
    if (body.phone !== undefined) {
      const phone = String(body.phone).trim() ? normalizeBdPhone(body.phone) : '';
      if (phone === null) throw new InboxError(400, 'Phone must be a Bangladeshi mobile number like 01711111111');
      updates.phone = phone;
    }
    if (body.category !== undefined) {
      if (!CATEGORIES.includes(body.category)) throw new InboxError(400, 'Choose what you sell');
      updates.category = body.category;
    }
    if (body.aiMode !== undefined) {
      if (!AI_MODES.includes(body.aiMode)) throw new InboxError(400, 'Unknown AI mode');
      updates.ai_mode = body.aiMode;
    }
    if (body.shopNotes !== undefined) {
      const notes = String(body.shopNotes);
      if (notes.length > 5000) throw new InboxError(400, 'Shop notes are too long (5,000 characters at most)');
      updates.shop_notes = notes;
    }
    if (body.onboardingStep !== undefined) {
      if (!ONBOARDING_STEPS.includes(body.onboardingStep)) throw new InboxError(400, 'Unknown onboarding step');
      updates.onboarding_step = body.onboardingStep;
    }
    if (body.orderFields !== undefined) {
      if (!Array.isArray(body.orderFields) || body.orderFields.length > 12) throw new InboxError(400, 'Order fields must be a list of up to 12');
      updates.order_fields = body.orderFields.map((field) => {
        const label = text(field?.label, 40, 'An order field name');
        if (!label) throw new InboxError(400, 'Every order field needs a name');
        return { label, hint: text(field?.hint, 120, 'An order field hint') };
      });
    }
    if (body.address !== undefined) updates.address = text(body.address, 200, 'Address');
    if (body.sellsOffline !== undefined) updates.sells_offline = Boolean(body.sellsOffline);
    if (body.audience !== undefined) {
      if (!Array.isArray(body.audience)) throw new InboxError(400, 'Choose who you sell to');
      updates.audience = [...new Set(body.audience.map((a) => oneOf(a, AUDIENCES, 'Choose who you sell to')))];
    }
    for (const [key, field] of [['deliveryInsideDays', 'delivery_inside_days'], ['deliveryOutsideDays', 'delivery_outside_days']]) {
      if (body[key] !== undefined) updates[field] = text(body[key], 20, 'Delivery days');
    }
    if (body.cashOnDelivery !== undefined) updates.cash_on_delivery = Boolean(body.cashOnDelivery);
    if (body.freeDeliveryOver !== undefined) {
      const value = body.freeDeliveryOver === null || body.freeDeliveryOver === '' ? null : Number(body.freeDeliveryOver);
      if (value !== null && (!Number.isInteger(value) || value <= 0)) throw new InboxError(400, 'Free delivery amount must be a whole number of taka');
      updates.free_delivery_over = value;
    }
    for (const [key, field, label] of [['bkashNumber', 'bkash_number', 'bKash'], ['nagadNumber', 'nagad_number', 'Nagad']]) {
      if (body[key] === undefined) continue;
      const number = String(body[key]).trim() ? normalizeBdPhone(body[key]) : '';
      if (number === null) throw new InboxError(400, `${label} number must be a Bangladeshi mobile number like 01711111111`);
      updates[field] = number;
    }
    if (body.aiName !== undefined) updates.ai_name = text(body.aiName, 30, 'Assistant name');
    if (body.aiStyle !== undefined) updates.ai_style = oneOf(body.aiStyle, AI_STYLES, 'Unknown writing style');
    if (body.aiAddress !== undefined) updates.ai_address = oneOf(body.aiAddress, AI_ADDRESS, 'Unknown way to address customers');
    if (body.aiSales !== undefined) updates.ai_sales = oneOf(body.aiSales, AI_SALES, 'Unknown sales style');
    // Field names come from the fixed lists above, never from the request.
    if (Object.keys(updates).length) await db.workspaces.updateOne({ _id: req.user.workspace_id }, { $set: updates });
    res.json(publicWorkspace(await getWorkspace(req.user.workspace_id)));
  });

  router.get('/conversations/:id/orders', auth, async (req, res) => {
    res.json({ draft: await orders.draftFor(req.user, id(req)), orders: await orders.forConversation(req.user, id(req)) });
  });

  router.post('/conversations/:id/orders', auth, async (req, res) => {
    const { sendSummary, ...input } = req.body ?? {};
    res.status(201).json(await orders.create(req.user, id(req), input, { sendSummary: Boolean(sendSummary) }));
  });

  router.get('/orders', auth, async (req, res) => {
    res.json(await orders.list(req.user, { status: req.query.status, q: req.query.q }));
  });

  router.get('/orders.csv', auth, async (req, res) => {
    const date = new Date().toISOString().slice(0, 10);
    const list = await orders.list(req.user, { status: req.query.status, q: req.query.q });
    res.type('text/csv; charset=utf-8')
      .attachment(`orders-${date}.csv`)
      // The BOM makes Excel read Bangla names correctly.
      .send(`\uFEFF${ordersCsv(list)}`);
  });

  router.patch('/orders/:id', auth, async (req, res) => {
    res.json(await orders.update(req.user, id(req), { status: req.body?.status, note: req.body?.note }));
  });

  // ---- AI chat agent ----

  router.get('/ai/status', auth, requireOwner, (req, res) => {
    res.json(agent?.status() ?? { available: false });
  });

  router.post('/ai/practice', auth, requireOwner, async (req, res) => {
    if (!agent) throw new InboxError(503, 'AI replies are not set up on this server yet');
    res.json(await agent.practice(req.user, req.body?.messages));
  });

  router.post('/conversations/:id/ai/suggest', auth, async (req, res) => {
    res.json(await agent.suggest(req.user, id(req)));
  });

  router.post('/conversations/:id/ai/dismiss', auth, async (req, res) => {
    res.json(await agent.dismissDraft(req.user, id(req)));
  });

  router.post('/conversations/:id/ai/resume', auth, async (req, res) => {
    res.json(await agent.resume(req.user, id(req)));
  });

  // ---- Products (what the AI quotes prices and stock from) ----

  router.get('/products', auth, async (req, res) => {
    const products = await db.products.find({ workspace_id: req.user.workspace_id }).sort({ name: 1 }).lean();
    res.json(products.map(publicProduct));
  });

  router.post('/products', auth, requireOwner, async (req, res) => {
    const product = await db.insert(db.products, { workspace_id: req.user.workspace_id, ...productFields(req.body) });
    res.status(201).json(publicProduct(product));
  });

  router.post('/products/import', auth, requireOwner, async (req, res) => {
    let csv = req.body?.csv;
    if (req.body?.sheetUrl !== undefined) {
      const url = googleSheetCsvUrl(req.body.sheetUrl);
      if (!url) throw new InboxError(400, 'Paste a Google Sheets link (docs.google.com/spreadsheets/…)');
      let response;
      try {
        response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
      } catch {
        throw new InboxError(502, "Couldn't reach Google Sheets. Try again in a moment.");
      }
      const type = response.headers.get('content-type') ?? '';
      if (!response.ok || type.includes('text/html')) {
        throw new InboxError(400, 'Google wouldn\'t share that sheet. In the sheet, click Share and set "Anyone with the link" to Viewer.');
      }
      csv = await response.text();
    }
    if (typeof csv !== 'string' || !csv.trim()) throw new InboxError(400, 'Choose a CSV file or paste a Google Sheets link');
    if (csv.length > 2_000_000) throw new InboxError(400, 'That file is too big (2 MB at most)');
    const { products, skipped, error } = productsFromRows(parseCsv(csv));
    if (error) throw new InboxError(400, error);
    for (const product of products) await db.insert(db.products, { workspace_id: req.user.workspace_id, ...product });
    res.status(201).json({ added: products.length, skipped });
  });

  router.patch('/products/:id', auth, requireOwner, async (req, res) => {
    const product = await db.products.findOneAndUpdate({ _id: id(req), workspace_id: req.user.workspace_id },
      { $set: productFields(req.body, { partial: true }) }, { new: true, lean: true });
    if (!product) throw new InboxError(404, 'Product not found');
    res.json(publicProduct(product));
  });

  router.delete('/products/:id', auth, requireOwner, async (req, res) => {
    await db.products.deleteOne({ _id: id(req), workspace_id: req.user.workspace_id });
    res.sendStatus(204);
  });

  router.get('/saved-replies', auth, async (req, res) => {
    const replies = await db.savedReplies.find({ workspace_id: req.user.workspace_id }).sort({ shortcut: 1 }).lean();
    res.json(replies.map(publicReply));
  });

  router.post('/saved-replies', auth, requireOwner, async (req, res) => {
    required(req.body, ['shortcut', 'text']);
    const shortcut = req.body.shortcut.trim().replace(/^\//, '').toLowerCase();
    if (!/^[a-z0-9_-]{1,30}$/.test(shortcut)) throw new InboxError(400, 'Shortcut can only use letters, numbers, - and _');
    const filter = { workspace_id: req.user.workspace_id, shortcut };
    const { doc } = await db.findOrCreate(db.savedReplies, filter, { text: req.body.text.trim() });
    await db.savedReplies.updateOne({ _id: doc.id }, { $set: { text: req.body.text.trim() } });
    res.status(201).json(publicReply(await db.savedReplies.findById(doc.id).lean()));
  });

  router.delete('/saved-replies/:id', auth, requireOwner, async (req, res) => {
    await db.savedReplies.deleteOne({ _id: id(req), workspace_id: req.user.workspace_id });
    res.sendStatus(204);
  });

  router.get('/team', auth, async (req, res) => {
    const users = await db.users.find({ workspace_id: req.user.workspace_id }).lean();
    const open = await openCounts({ workspace_id: req.user.workspace_id, status: 'open' });
    // Owner first, then by name.
    users.sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'owner' ? -1 : 1));
    res.json(users.map((u) => ({ ...publicUser(row(u)), openCount: open.get(u._id) ?? 0 })));
  });

  router.post('/team', auth, requireOwner, async (req, res) => {
    required(req.body, ['name', 'email']);
    const email = normalizeEmail(req.body.email);
    if (await db.users.exists({ email })) throw new InboxError(409, 'Email already registered');
    const password = req.body.password?.trim() || randomBytes(6).toString('base64url');
    let user;
    try {
      user = await db.insert(db.users, {
        workspace_id: req.user.workspace_id, name: req.body.name.trim(), email, password_hash: hashPassword(password), role: 'moderator',
      });
    } catch (err) {
      if (isDuplicateKey(err)) throw new InboxError(409, 'Email already registered');
      throw err;
    }
    res.status(201).json({ user: publicUser(user), password });
  });

  router.patch('/team/:id', auth, requireOwner, async (req, res) => {
    const member = await db.users.findOne({ _id: id(req), workspace_id: req.user.workspace_id, role: 'moderator' }).lean();
    if (!member) throw new InboxError(404, 'Moderator not found');
    if (typeof req.body?.isActive === 'boolean') {
      await db.users.updateOne({ _id: member._id }, { $set: { is_active: req.body.isActive, is_online: false } });
      if (!req.body.isActive) {
        // A removed moderator's customers go back to the queue for the rest of the team.
        await db.conversations.updateMany({ assigned_user_id: member._id, status: 'open' }, { $set: { assigned_user_id: null } });
        await db.sessions.deleteMany({ user_id: member._id });
      }
    }
    res.json(publicUser(await getUser(member._id)));
  });

  router.get('/channels', auth, async (req, res) => {
    const channels = await db.channels.find({ workspace_id: req.user.workspace_id }).sort({ _id: 1 }).lean();
    const counts = await db.conversations.aggregate([
      { $match: { channel_id: { $in: channels.map((c) => c._id) } } },
      { $group: { _id: '$channel_id', n: { $sum: 1 } } },
    ]);
    const byChannel = new Map(counts.map((c) => [c._id, c.n]));
    res.json(channels.map((c) => publicChannel({ ...row(c), conversation_count: byChannel.get(c._id) ?? 0 })));
  });

  router.post('/channels', auth, requireOwner, async (req, res) => {
    required(req.body, ['platform', 'externalId', 'name']);
    const { platform, externalId, name, accessToken = '' } = req.body;
    if (!PLATFORMS.includes(platform)) throw new InboxError(400, 'Unknown platform');
    try {
      const channel = await db.insert(db.channels, {
        workspace_id: req.user.workspace_id, platform, external_id: externalId.trim(), name: name.trim(),
        access_token: encryptSecret(String(accessToken).trim(), config.tokenKey),
      });
      res.status(201).json(publicChannel(channel));
    } catch (err) {
      if (isDuplicateKey(err)) throw new InboxError(409, 'This account is already connected');
      throw err;
    }
  });

  router.patch('/channels/:id', auth, requireOwner, async (req, res) => {
    if (typeof req.body?.aiEnabled !== 'boolean') throw new InboxError(400, 'Nothing to change');
    const channel = await db.channels.findOneAndUpdate({ _id: id(req), workspace_id: req.user.workspace_id },
      { $set: { ai_enabled: req.body.aiEnabled } }, { new: true, lean: true });
    if (!channel) throw new InboxError(404, 'Channel not found');
    res.json(publicChannel(row(channel)));
  });

  // Re-reads past Facebook/Instagram conversations (WhatsApp history can only be synced once, at connection).
  router.post('/channels/:id/import', auth, requireOwner, async (req, res) => {
    const channel = await db.channels.findOne({ _id: id(req), workspace_id: req.user.workspace_id }).lean();
    if (!channel) throw new InboxError(404, 'Channel not found');
    if (channel.platform === 'whatsapp') throw new InboxError(400, 'WhatsApp chat history can only be synced when the number is connected');
    if (!(await importer?.start(channel._id))) throw new InboxError(409, 'An import is already running, or this channel has no access token');
    res.status(202).json({ started: true });
  });

  // Removing a channel removes its customers and chats; orders are kept but
  // no longer linked to a chat.
  router.delete('/channels/:id', auth, requireOwner, async (req, res) => {
    const channel = await db.channels.findOneAndDelete({ _id: id(req), workspace_id: req.user.workspace_id }).lean();
    if (channel) {
      const conversations = (await db.conversations.find({ channel_id: channel._id }, { _id: 1 }).lean()).map((c) => c._id);
      await db.messages.deleteMany({ conversation_id: { $in: conversations } });
      await db.orders.updateMany({ conversation_id: { $in: conversations } }, { $set: { conversation_id: null } });
      await db.conversations.deleteMany({ channel_id: channel._id });
      await db.contacts.deleteMany({ channel_id: channel._id });
    }
    res.sendStatus(204);
  });

  // Lets you try the inbox without a Meta app: pretends a customer wrote in.
  if (!config.isProduction) {
    router.post('/dev/simulate', auth, async (req, res) => {
      const channelId = Number(req.body?.channelId);
      const channel = Number.isSafeInteger(channelId)
        && await db.channels.findOne({ _id: channelId, workspace_id: req.user.workspace_id }).lean();
      if (!channel) throw new InboxError(404, 'Channel not found');
      required(req.body, ['customerId', 'text']);
      const { nameLookup, ...result } = await inbox.ingestMessage({
        platform: channel.platform,
        channelExternalId: channel.external_id,
        contactExternalId: req.body.customerId.trim(),
        contactName: req.body.customerName?.trim() || null,
        direction: 'in',
        messageId: `sim_${randomBytes(8).toString('hex')}`,
        text: req.body.text,
        attachments: [],
        timestamp: new Date().toISOString(),
      });
      res.status(201).json(result);
    });
  }

  router.use((err, req, res, next) => {
    if (err instanceof InboxError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return router;
}

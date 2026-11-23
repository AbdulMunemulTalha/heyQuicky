import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { InboxError } from '../../inbox.js';
import { need } from '../../dashboard/permissions.js';
import { audit, bdPhone, csv, dhakaMonthStart } from '../../dashboard/util.js';
import { setting, DEFAULT_CAPS } from '../../dashboard/settings.js';
import { averageReplyCost, requestTopup, TOPUP_MIN, TOPUP_MAX } from '../../dashboard/credit.js';
import { zonesFor } from '../../dashboard/orderBuild.js';
import { COURIERS } from '../../adapters/couriers.js';
import { encryptSecret } from '../../secrets.js';
import { hashPassword } from '../../auth.js';
import { isDuplicateKey, normalizeEmail } from '../../db.js';
import { BUTTONS, DEFAULT_STEPS, STEPS, deliverySettings } from '../../dashboard/deliveryUpdates.js';

const ROLES = ['admin', 'moderator', 'agent'];
const monthStart = dhakaMonthStart;
const money = (v, what, { min = 0, max = 1_000_000 } = {}) => {
  const n = Number(String(v ?? '').replace(/[,৳\s]/g, '').replace(/[০-৯]/g, (d) => '০১২৩৪৫৬৭৮৯'.indexOf(d)));
  if (!Number.isFinite(n) || n < min || n > max) throw new InboxError(400, `Enter a valid ${what}`);
  return Math.round(n * 100) / 100;
};

// Screen 10 Settings & billing: Billing & AI credit, Channels, Delivery & courier, Payments, Team.
export function settingsRoutes(db, config, { auth, adapters }) {
  const router = Router();
  // Shop setup (delivery, couriers, payment numbers) is for the owner and admins.
  const ownerOrAdmin = (req, _res, next) => (['owner', 'admin'].includes(req.user.role) ? next() : next(new InboxError(403, 'Only the owner or an admin can change this')));
  const topupMethods = () => ({ bkash: config.topup?.bkash || null, nagad: config.topup?.nagad || null, card: false });

  // ---- Billing & AI credit (BIL-01/02/03/05/06) ----
  router.get('/settings/billing', auth, need(db, 'billing'), async (req, res) => {
    const wsId = req.user.workspace_id;
    // Credit, caps and top-ups belong to the main shop (shared by every brand).
    const ws = await db.workspaces.findById(req.user.team_id ?? wsId).lean();
    const since = monthStart();
    const [month, saved, replies, pending, avg] = await Promise.all([
      db.aiReplies.aggregate([{ $match: { workspace_id: wsId, kind: { $ne: 'saved' }, created_at: { $gte: since } } },
        { $group: { _id: null, n: { $sum: 1 }, cost: { $sum: '$cost' }, saved: { $sum: '$saved' } } }]),
      db.aiReplies.countDocuments({ workspace_id: wsId, kind: 'saved', created_at: { $gte: since } }),
      db.aiReplies.find({ workspace_id: wsId }).sort({ created_at: -1 }).limit(30).lean(),
      db.credit.find({ workspace_id: req.user.team_id ?? wsId, type: 'top_up', status: 'pending' }).sort({ created_at: -1 }).lean(),
      averageReplyCost(db, wsId),
    ]);
    const balance = ws.credit_balance ?? 0;
    const caps = { ...DEFAULT_CAPS, ...setting(ws, 'caps', {}) };
    res.json({
      balance, avgReplyCost: avg, repliesLeft: avg > 0 ? Math.floor(balance / avg) : null,
      month: { from: since, aiReplies: month[0]?.n ?? 0, aiCost: month[0]?.cost ?? 0, savedReplies: saved, cacheSavings: month[0]?.saved ?? 0 },
      caps: { monthly: caps.monthly, alertBelow: caps.alert_below },
      topup: { methods: topupMethods(), min: TOPUP_MIN, max: TOPUP_MAX, support: config.topup?.supportWhatsapp || null },
      pending: pending.map((p) => ({ id: p._id, amount: p.amount, method: p.method, trxId: p.ref, at: p.created_at })),
      replies: replies.map((r) => ({ id: r._id, at: r.created_at, customer: r.customer_name, summary: r.summary, cost: r.cost ?? 0, kind: r.kind })),
    });
  });

  router.patch('/settings/billing/caps', auth, need(db, 'billing'), async (req, res) => {
    const set = {};
    if (req.body?.monthly !== undefined) set['settings.caps.monthly'] = req.body.monthly === null || req.body.monthly === '' ? null : money(req.body.monthly, 'monthly spend cap', { max: 10_000_000 });
    if (req.body?.alertBelow !== undefined) set['settings.caps.alert_below'] = money(req.body.alertBelow, 'alert amount', { max: 1_000_000 });
    if (!Object.keys(set).length) throw new InboxError(400, 'Nothing to change');
    await db.workspaces.updateOne({ _id: req.user.team_id ?? req.user.workspace_id }, { $set: set });
    await audit(db, req.user, `Changed AI spend limits (${Object.entries(set).map(([k, v]) => `${k.split('.').pop()} ${v ?? 'none'}`).join(', ')})`, { where: 'Billing' });
    res.json({ ok: true });
  });

  router.get('/settings/billing/replies.csv', auth, need(db, 'billing'), async (req, res) => {
    const since = monthStart();
    const list = await db.aiReplies.find({ workspace_id: req.user.workspace_id, created_at: { $gte: since } }).sort({ created_at: -1 }).limit(100_000).lean();
    const rows = list.map((r) => [r.created_at, r.customer_name ?? '', r.summary ?? '', r.kind, r.model ?? '', r.cost ?? 0, r.saved ?? 0]);
    res.type('text/csv').set('Content-Disposition', 'attachment; filename="heyquicky-ai-replies.csv"')
      .send(`﻿${csv([['time', 'customer', 'what_the_ai_did', 'kind', 'model', 'cost_bdt', 'cache_saving_bdt'], ...rows])}`);
  });

  // A top-up request with the TrxID of a payment already sent. Credit is added only when an admin approves it.
  router.post('/settings/billing/topup', auth, need(db, 'billing'), async (req, res) => {
    const method = String(req.body?.method ?? '');
    if (!topupMethods()[method]) throw new InboxError(400, 'This payment method is not available for top-ups yet');
    const amount = money(req.body?.amount, 'amount', { min: TOPUP_MIN, max: TOPUP_MAX });
    const trxId = String(req.body?.trxId ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{8,12}$/.test(trxId)) throw new InboxError(400, 'Enter the TrxID from the payment SMS (8–12 letters and numbers)');
    if (await db.credit.exists({ type: 'top_up', ref: trxId, status: { $ne: 'rejected' } })) throw new InboxError(409, 'This TrxID has already been sent');
    const entry = await requestTopup(db, req.user.workspace_id, { amount, method, trxId });
    await audit(db, req.user, `Requested a ৳${amount} AI credit top-up by ${method} (TrxID ${trxId})`, { where: 'Billing' });
    res.status(201).json({ id: entry.id, status: 'pending' });
  });

  // ---- Channels (CH) ----
  router.get('/settings/channels', auth, async (req, res) => {
    const channels = await db.channels.find({ workspace_id: req.user.workspace_id }).sort({ _id: 1 }).lean();
    res.json({
      channels: channels.map((c) => ({ id: c._id, platform: c.platform, name: c.name, externalId: c.external_id, aiOn: c.ai_enabled !== false, hasToken: Boolean(c.access_token) })),
      canConnect: Boolean(config.meta?.appId) && req.user.role === 'owner',
    });
  });

  // ---- Delivery & courier ----
  router.get('/settings/delivery', auth, async (req, res) => {
    const ws = await db.workspaces.findById(req.user.workspace_id).lean();
    const accounts = new Map((await db.courierAccounts.find({ workspace_id: ws._id }).lean()).map((a) => [a.courier, a]));
    res.json({
      zones: zonesFor(ws),
      updates: ws.settings?.delivery_updates !== false,
      couriers: Object.entries(COURIERS).map(([key, c]) => {
        const a = accounts.get(key);
        return { key, name: c.name, fields: c.fields, connected: Boolean(a?.connected), hasKeys: Boolean(a?.credentials), autoBook: Boolean(a?.auto_book), testMode: config.dryRun || !a?.credentials };
      }),
    });
  });

  router.patch('/settings/delivery/zones', auth, ownerOrAdmin, async (req, res) => {
    const set = {};
    const days = (v) => String(v ?? '').trim().slice(0, 20);
    const z = req.body ?? {};
    if (z.inside_dhaka) { set.delivery_inside_dhaka = money(z.inside_dhaka.charge, 'charge inside Dhaka', { max: 5000 }); set.delivery_inside_days = days(z.inside_dhaka.days); }
    if (z.dhaka_suburbs) { set['settings.suburbs_charge'] = money(z.dhaka_suburbs.charge, 'charge for Dhaka suburbs', { max: 5000 }); set['settings.suburbs_days'] = days(z.dhaka_suburbs.days); }
    if (z.outside_dhaka) { set.delivery_outside_dhaka = money(z.outside_dhaka.charge, 'charge outside Dhaka', { max: 5000 }); set.delivery_outside_days = days(z.outside_dhaka.days); }
    if (!Object.keys(set).length) throw new InboxError(400, 'Nothing to change');
    await db.workspaces.updateOne({ _id: req.user.workspace_id }, { $set: set });
    await audit(db, req.user, 'Changed delivery charges', { where: 'Delivery & courier' });
    res.json({ zones: zonesFor(await db.workspaces.findById(req.user.workspace_id).lean()) });
  });

  // CRR-04: send the delivery update card automatically when an order is packed, shipped or delivered.
  router.patch('/settings/delivery/updates', auth, ownerOrAdmin, async (req, res) => {
    if (typeof req.body?.on !== 'boolean') throw new InboxError(400, 'Say on or off');
    await db.workspaces.updateOne({ _id: req.user.workspace_id }, { $set: { 'settings.delivery_updates': req.body.on } });
    await audit(db, req.user, `Turned automatic delivery updates ${req.body.on ? 'on' : 'off'}`, { where: 'Delivery & courier' });
    res.json({ updates: req.body.on });
  });

  // CRR-03 / CRR-05 / CRR-06: Settings → Delivery updates (frame "Delivery updates").
  router.get('/settings/delivery-updates', auth, async (req, res) => {
    const ws = await db.workspaces.findById(req.user.workspace_id).lean();
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [sent, accounts, rates, coupons] = await Promise.all([
      db.orderEvents.aggregate([{ $match: { workspace_id: ws._id, type: 'delivery_update', created_at: { $gte: since } } }, { $group: { _id: '$to', n: { $sum: 1 } } }]),
      db.courierAccounts.find({ workspace_id: ws._id }).lean(),
      // Delivered share per courier over the last 90 days ("96% delivered").
      db.orders.aggregate([{ $match: { workspace_id: ws._id, status: { $in: ['delivered', 'returned'] }, courier: { $nin: ['', null] }, created_at: { $gte: new Date(Date.now() - 90 * 86_400_000) } } },
        { $group: { _id: '$courier', done: { $sum: 1 }, delivered: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] } } } }]),
      db.coupons.find({ workspace_id: ws._id, active: { $ne: false } }, { code: 1 }).sort({ code: 1 }).lean(),
    ]);
    const byCourier = new Map(rates.map((r) => [r._id, r]));
    const acc = new Map(accounts.map((a) => [a.courier, a]));
    res.json({
      ...deliverySettings(ws),
      sent: Object.fromEntries(sent.map((x) => [x._id, x.n])),
      couriers: Object.entries(COURIERS).map(([key, c]) => {
        const a = acc.get(key);
        const r = byCourier.get(c.name);
        return { key, name: c.name, connected: Boolean(a?.connected), autoBook: Boolean(a?.auto_book), deliveredPct: r?.done ? Math.round((r.delivered / r.done) * 100) : null };
      }),
      coupons: coupons.map((c) => c.code),
      sample: { customer_name: 'Sadia Rahman', number: 1042, consignment_id: 'SF-82913', cod_amount: 2220, area: 'inside_dhaka', delivery_inside_days: ws.delivery_inside_days || '' },
      canEdit: ['owner', 'admin'].includes(req.user.role),
    });
  });

  router.put('/settings/delivery-updates', auth, ownerOrAdmin, async (req, res) => {
    const b = req.body ?? {};
    const set = {};
    const text = (v, max, what) => { const t = String(v ?? '').trim().slice(0, max); if (!t) throw new InboxError(400, `Write the ${what}`); return t; };
    if (b.steps !== undefined) {
      const steps = {};
      for (const k of STEPS) {
        const x = b.steps?.[k];
        if (!x) continue;
        if (x.button !== undefined && !BUTTONS.includes(x.button)) throw new InboxError(400, 'Pick a button: track parcel, call rider or see bill');
        steps[k] = { on: Boolean(x.on), title: text(x.title, 60, 'card title'), message: text(x.message, 400, 'message'), button: x.button ?? DEFAULT_STEPS[k].button };
      }
      set['settings.delivery_steps'] = steps;
      set['settings.delivery_updates'] = Object.values(steps).some((x) => x.on);
    }
    if (b.alerts !== undefined) set['settings.delivery_alerts'] = { cancel_after_ship: Boolean(b.alerts?.cancel_after_ship), handoff_failed: Boolean(b.alerts?.handoff_failed) };
    if (b.review !== undefined) {
      const code = String(b.review?.coupon ?? '').trim().toUpperCase();
      if (code && !(await db.coupons.exists({ workspace_id: req.user.workspace_id, code }))) throw new InboxError(404, `There is no coupon called ${code} — make it in Coupons first`);
      set['settings.delivery_review'] = { on: Boolean(b.review?.on), coupon: code };
    }
    if (!Object.keys(set).length) throw new InboxError(400, 'Nothing to change');
    await db.workspaces.updateOne({ _id: req.user.workspace_id }, { $set: set });
    await audit(db, req.user, 'Changed delivery updates', { where: 'Delivery updates' });
    res.json(deliverySettings(await db.workspaces.findById(req.user.workspace_id).lean()));
  });

  // Connect a courier with the shop's own merchant keys (stored encrypted, never sent back).
  router.put('/settings/couriers/:key', auth, ownerOrAdmin, async (req, res) => {
    const c = COURIERS[req.params.key];
    if (!c) throw new InboxError(404, 'Unknown courier');
    // Never keep merchant keys readable in a production database.
    if (config.isProduction && !config.tokenKey) throw new InboxError(503, 'The server is missing TOKEN_ENCRYPTION_KEY, so courier keys can\'t be stored safely yet');
    const creds = {};
    for (const f of c.fields) {
      const v = String(req.body?.credentials?.[f] ?? '').trim();
      if (!v) throw new InboxError(400, `Enter the ${f.replace(/_/g, ' ')}`);
      if (v.length > 300) throw new InboxError(400, `The ${f.replace(/_/g, ' ')} is too long`);
      creds[f] = v;
    }
    await db.courierAccounts.updateOne({ workspace_id: req.user.workspace_id, courier: req.params.key },
      { $set: { credentials: encryptSecret(JSON.stringify(creds), config.tokenKey), connected: true, auto_book: Boolean(req.body?.autoBook) }, $setOnInsert: { _id: await db.nextId(db.courierAccounts.collection.collectionName), created_at: new Date() } },
      { upsert: true });
    await audit(db, req.user, `Connected ${c.name}`, { where: 'Delivery & courier' });
    res.json({ connected: true, testMode: config.dryRun });
  });

  router.patch('/settings/couriers/:key', auth, ownerOrAdmin, async (req, res) => {
    if (typeof req.body?.autoBook !== 'boolean') throw new InboxError(400, 'Nothing to change');
    const r = await db.courierAccounts.updateOne({ workspace_id: req.user.workspace_id, courier: req.params.key, connected: true }, { $set: { auto_book: req.body.autoBook } });
    if (!r.matchedCount) throw new InboxError(404, 'Connect this courier first');
    if (req.body.autoBook) await db.courierAccounts.updateMany({ workspace_id: req.user.workspace_id, courier: { $ne: req.params.key } }, { $set: { auto_book: false } });
    res.json({ autoBook: req.body.autoBook });
  });

  router.delete('/settings/couriers/:key', auth, ownerOrAdmin, async (req, res) => {
    await db.courierAccounts.updateOne({ workspace_id: req.user.workspace_id, courier: req.params.key }, { $set: { credentials: '', connected: false, auto_book: false } });
    await audit(db, req.user, `Disconnected ${COURIERS[req.params.key]?.name ?? req.params.key}`, { where: 'Delivery & courier' });
    res.sendStatus(204);
  });

  // ---- Payments: how customers pay, advance rules ----
  router.get('/settings/payments', auth, async (req, res) => {
    const ws = await db.workspaces.findById(req.user.workspace_id).lean();
    const adv = setting(ws, 'advance', {});
    res.json({
      bkash: ws.bkash_number || '', nagad: ws.nagad_number || '', screenshotsToWhatsapp: Boolean(setting(ws, 'screenshots_to_whatsapp', false)),
      advance: { highRisk: adv.high_risk !== false, outsideOver: adv.outside_over ?? null, amount: adv.amount ?? 300 },
    });
  });

  router.patch('/settings/payments', auth, ownerOrAdmin, async (req, res) => {
    const b = req.body ?? {};
    const set = {};
    for (const [key, field, label] of [['bkash', 'bkash_number', 'bKash'], ['nagad', 'nagad_number', 'Nagad']]) {
      if (b[key] === undefined) continue;
      if (!String(b[key]).trim()) { set[field] = ''; continue; }
      const phone = bdPhone(b[key]);
      if (!phone) throw new InboxError(400, `The ${label} number should be 11 digits and start with 013–019`);
      set[field] = phone;
    }
    if (typeof b.screenshotsToWhatsapp === 'boolean') set['settings.screenshots_to_whatsapp'] = b.screenshotsToWhatsapp;
    if (b.advance) {
      if (typeof b.advance.highRisk === 'boolean') set['settings.advance.high_risk'] = b.advance.highRisk;
      if (b.advance.outsideOver !== undefined) set['settings.advance.outside_over'] = b.advance.outsideOver === null || b.advance.outsideOver === '' ? null : money(b.advance.outsideOver, 'order amount', { min: 1, max: 1_000_000 });
      if (b.advance.amount !== undefined) set['settings.advance.amount'] = money(b.advance.amount, 'advance amount', { min: 1, max: 100_000 });
    }
    if (!Object.keys(set).length) throw new InboxError(400, 'Nothing to change');
    await db.workspaces.updateOne({ _id: req.user.workspace_id }, { $set: set });
    await audit(db, req.user, 'Changed payment settings', { where: 'Payments' });
    res.json({ ok: true });
  });

  // ---- Team (TEAM-01, TEAM-04) ----
  router.get('/settings/team', auth, async (req, res) => {
    const users = await db.users.find({ workspace_id: req.user.team_id }).lean();
    const order = { owner: 0, admin: 1, moderator: 2, agent: 3 };
    users.sort((a, b) => (order[a.role] - order[b.role]) || a.name.localeCompare(b.name));
    res.json({
      members: users.map((u) => ({ id: u._id, name: u.name, email: u.email, role: u.role, onDuty: u.on_duty !== false && Boolean(u.is_online), active: u.is_active !== false, you: u._id === req.user.id })),
      canInvite: ['owner', 'admin'].includes(req.user.role),
    });
  });

  router.post('/settings/team', auth, need(db, 'invite'), async (req, res) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 60);
    const email = normalizeEmail(req.body?.email);
    const role = ROLES.includes(req.body?.role) ? req.body.role : 'moderator';
    if (!name) throw new InboxError(400, 'Enter their name');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InboxError(400, 'Enter a valid email address');
    if (role === 'admin' && req.user.role !== 'owner') throw new InboxError(403, 'Only the owner can add another admin');
    const password = randomBytes(6).toString('base64url');
    let user;
    try {
      user = await db.insert(db.users, { workspace_id: req.user.team_id, name, email, password_hash: hashPassword(password), role });
    } catch (err) {
      if (isDuplicateKey(err)) throw new InboxError(409, 'Someone already uses this email');
      throw err;
    }
    const ws = await db.workspaces.findById(req.user.workspace_id, { name: 1 }).lean();
    const link = `${config.publicUrl || `${req.protocol}://${req.get('host')}`}/app`;
    await adapters?.email?.send({ to: email, subject: `${req.user.name} added you to ${ws?.name ?? 'their shop'} on HeyQuicky`,
      text: `${req.user.name} added you to ${ws?.name ?? 'their shop'} on HeyQuicky as ${role}.\n\nLog in at ${link} with ${email} and this temporary password: ${password}\nChange it after you log in.` }).catch(() => {});
    await audit(db, req.user, `Invited ${name} (${email}) as ${role}`, { where: 'Team' });
    res.status(201).json({ id: user.id, password, emailed: adapters?.email?.mode === 'real' });
  });

  router.patch('/settings/team/:id', auth, need(db, 'invite'), async (req, res) => {
    const member = await db.users.findOne({ _id: Number(req.params.id), workspace_id: req.user.team_id }).lean();
    if (!member) throw new InboxError(404, 'Teammate not found');
    if (member.role === 'owner') throw new InboxError(403, "The owner's access can't be changed here");
    if (member._id === req.user.id) throw new InboxError(403, "You can't change your own access");
    const set = {};
    if (req.body?.role !== undefined) {
      if (!ROLES.includes(req.body.role)) throw new InboxError(400, 'Unknown role');
      if ((req.body.role === 'admin' || member.role === 'admin') && req.user.role !== 'owner') throw new InboxError(403, 'Only the owner can change admins');
      set.role = req.body.role;
    }
    if (typeof req.body?.active === 'boolean') {
      set.is_active = req.body.active;
      if (!req.body.active) set.is_online = false;
    }
    if (!Object.keys(set).length) throw new InboxError(400, 'Nothing to change');
    await db.users.updateOne({ _id: member._id }, { $set: set });
    if (set.is_active === false) {
      // A removed teammate's open chats go back to the queue and their sessions end.
      await db.conversations.updateMany({ assigned_user_id: member._id, status: 'open' }, { $set: { assigned_user_id: null } });
      await db.sessions.deleteMany({ user_id: member._id });
    }
    await audit(db, req.user, `${set.is_active === false ? 'Removed' : set.is_active ? 'Restored' : 'Changed'} ${member.name}${set.role ? ` → ${set.role}` : ''}`, { where: 'Team' });
    res.json({ ok: true });
  });

  return router;
}

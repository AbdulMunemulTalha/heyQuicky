import { Router } from 'express';
import { randomBytes, randomInt } from 'node:crypto';
import { requireAuth, requireOwner } from '../auth.js';
import { isDuplicateKey } from '../db.js';
import { InboxError } from '../inbox.js';
import { createMetaClient } from '../platforms/metaConnect.js';
import { encryptSecret, decryptSecret } from '../secrets.js';

const STATE_MINUTES = 15;
const PENDING_MINUTES = 30;

const minutesFromNow = (m) => new Date(Date.now() + m * 60_000);

// What the connect popup shows as allowed or not, from Facebook's permission list.
// With Facebook Login for Business the configuration decides the scopes, so a
// permission that was never asked for counts as allowed if nothing says otherwise.
const PERMISSION_GROUPS = [
  ['pages', 'See your Pages', ['pages_show_list']],
  ['messages', 'Page messages', ['pages_messaging', 'pages_manage_metadata']],
  ['instagram', 'Instagram messages', ['instagram_basic', 'instagram_manage_messages']],
  ['comments', 'Comments', ['pages_read_user_content', 'pages_manage_engagement', 'instagram_manage_comments']],
];
function summarizePermissions(granted) {
  if (!granted) return null;
  return PERMISSION_GROUPS.map(([key, label, needs]) => ({
    key, label, allowed: needs.every((p) => granted[p] !== 'declined'),
  }));
}

// The page Facebook's popup lands on: tells the dashboard window what happened, then closes.
// The message only goes to this site's own origin, so other sites can't read it.
function popupPage(origin, result) {
  const json = JSON.stringify({ type: 'quicky-facebook-connect', ...result }).replace(/</g, '\\u003c');
  const target = JSON.stringify(origin).replace(/</g, '\\u003c');
  const fallback = result.id ? `/app?connect=${encodeURIComponent(result.id)}` : `/app?connect_error=${encodeURIComponent(result.error)}`;
  return `<!doctype html><meta charset="utf-8"><title>Connecting…</title>
<p style="font:16px system-ui;padding:24px">Done. You can close this window and go back to HeyQuicky. <a href="${fallback}">Continue</a></p>
<script>
  try { if (window.opener) { window.opener.postMessage(${json}, ${target}); window.close(); } else { location.replace(${JSON.stringify(fallback)}); } }
  catch (e) { location.replace(${JSON.stringify(fallback)}); }
</script>`;
}

// Adds a channel, or refreshes its token if this workspace already has it.
async function upsertChannel(db, workspaceId, { platform, externalId, name, token, wabaId = null, pageId = null }) {
  const taken = () => new InboxError(409, `${name} is already connected to another Quicky account`);
  const existing = await db.channels.findOne({ platform, external_id: externalId }).lean();
  if (existing && existing.workspace_id !== workspaceId) throw taken();
  if (existing) {
    const set = { name, access_token: token, needs_reconnect: false };
    if (wabaId) set.waba_id = wabaId;
    if (pageId) set.page_id = pageId;
    await db.channels.updateOne({ _id: existing._id }, { $set: set });
    return existing._id;
  }
  try {
    return (await db.insert(db.channels, {
      workspace_id: workspaceId, platform, external_id: externalId, name, access_token: token, waba_id: wabaId, page_id: pageId,
    })).id;
  } catch (err) {
    // Connected by someone else at the same moment.
    if (isDuplicateKey(err)) throw taken();
    throw err;
  }
}

export function connectRoutes(db, config, { fetchImpl, emit = () => {}, importer = null } = {}) {
  const router = Router();
  const auth = requireAuth(db);
  const meta = createMetaClient({ ...config.meta, fetchImpl });

  function requireMetaApp(_req, _res, next) {
    if (!config.meta.appId || !config.meta.appSecret) {
      throw new InboxError(503, 'Facebook connection is not set up on this server (META_APP_ID and META_APP_SECRET)');
    }
    next();
  }

  // Expired rows are also removed by MongoDB's TTL index, but that runs only once a minute.
  async function loadPending(req) {
    const pending = await db.pendingConnections.findOne({
      _id: String(req.params.id), workspace_id: req.user.workspace_id, expires_at: { $gt: new Date() },
    }).lean();
    if (!pending) throw new InboxError(404, 'This connection has expired. Please connect again.');
    const payload = JSON.parse(decryptSecret(pending.payload, config.tokenKey));
    // Older pending rows hold just the list of pages.
    return Array.isArray(payload) ? { pending, pages: payload, permissions: null, userName: null } : { pending, ...payload };
  }

  router.get('/api/connect/facebook/start', auth, requireOwner, requireMetaApp, async (req, res) => {
    const redirectUri = `${config.publicUrl || `${req.protocol}://${req.get('host')}`}/auth/facebook/callback`;
    const state = randomBytes(24).toString('base64url');
    await db.oauthStates.create({
      _id: state, workspace_id: req.user.workspace_id, user_id: req.user.id, redirect_uri: redirectUri,
      popup: req.query.popup === '1', expires_at: minutesFromNow(STATE_MINUTES),
    });
    res.json({ url: meta.loginUrl({ redirectUri, state, configId: config.meta.loginConfigId, rerequest: req.query.rerequest === '1' }) });
  });

  // Facebook sends the browser here after login. The owner is not identified by
  // a token on this request, only by the one-time state created above.
  router.get('/auth/facebook/callback', async (req, res) => {
    // Deleted as it is read, so each login link works once.
    const state = await db.oauthStates.findOneAndDelete({ _id: String(req.query.state ?? ''), expires_at: { $gt: new Date() } }).lean();
    const origin = new URL(state?.redirect_uri ?? config.publicUrl ?? `${req.protocol}://${req.get('host')}`).origin;
    const finish = (result) => (state?.popup
      ? res.type('html').send(popupPage(origin, result))
      : res.redirect(result.id ? `/app?connect=${encodeURIComponent(result.id)}` : `/app?connect_error=${encodeURIComponent(result.error)}`));
    const fail = (error) => finish({ error });
    if (!state) return fail('This Facebook login link has expired. Please try again.');
    if (req.query.error || !req.query.code) {
      return fail(req.query.error_reason === 'user_denied'
        ? 'Facebook connection was cancelled.'
        : String(req.query.error_description || 'Facebook did not complete the login.'));
    }

    let pages;
    let permissions = null;
    let userName = null;
    try {
      const userToken = await meta.userTokenFromCode({ code: String(req.query.code), redirectUri: state.redirect_uri });
      pages = await meta.listPages(userToken);
      // Nice to have: without them the popup simply doesn't show the permission check or the name.
      [permissions, userName] = await Promise.all([
        meta.grantedPermissions(userToken).catch(() => null),
        meta.userName(userToken).catch(() => null),
      ]);
    } catch (err) {
      return fail(`Facebook error: ${err.message}`);
    }
    if (!pages.length) {
      return fail('No Facebook Pages were shared. Connect again and tick your business Page when Facebook asks.');
    }

    const id = randomBytes(18).toString('base64url');
    const payload = { pages, permissions: summarizePermissions(permissions), userName };
    await db.pendingConnections.create({
      _id: id, workspace_id: state.workspace_id, payload: encryptSecret(JSON.stringify(payload), config.tokenKey), expires_at: minutesFromNow(PENDING_MINUTES),
    });
    finish({ id });
  });

  router.get('/api/connect/facebook/:id', auth, requireOwner, async (req, res) => {
    const { pages, permissions, userName } = await loadPending(req);
    const channels = await db.channels.find({ workspace_id: req.user.workspace_id }, { platform: 1, external_id: 1 }).lean();
    const connected = new Set(channels.map((c) => `${c.platform}:${c.external_id}`));
    res.json({
      userName,
      permissions,
      pages: pages.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category ?? null,
        followers: p.followers ?? null,
        messengerConnected: connected.has(`messenger:${p.id}`),
        instagram: p.instagram && { ...p.instagram, connected: connected.has(`instagram:${p.instagram.id}`) },
      })),
    });
  });

  router.post('/api/connect/facebook/:id', auth, requireOwner, requireMetaApp, async (req, res) => {
    const { pending, pages } = await loadPending(req);
    const messenger = new Set((req.body?.messenger ?? []).map(String));
    const instagram = new Set((req.body?.instagram ?? []).map(String));
    const chosen = pages.filter((p) => messenger.has(p.id) || (p.instagram && instagram.has(p.instagram.id)));
    if (!chosen.length) throw new InboxError(400, 'Choose at least one Page or Instagram account');

    const connected = [];
    const problems = [];
    const channelIds = [];
    const steps = { messages: false, instagram: null };
    for (const page of chosen) {
      try {
        await meta.subscribePage(page.id, page.accessToken);
        steps.messages = true;
      } catch (err) {
        problems.push(`${page.name}: ${err.message}`);
        continue;
      }
      const token = encryptSecret(page.accessToken, config.tokenKey);
      try {
        {
          if (messenger.has(page.id)) {
            channelIds.push(await upsertChannel(db, req.user.workspace_id,
              { platform: 'messenger', externalId: page.id, name: page.name, token, pageId: page.id }));
            connected.push(page.name);
          }
          if (page.instagram && instagram.has(page.instagram.id)) {
            const name = page.instagram.username ? `@${page.instagram.username}` : `${page.name} (Instagram)`;
            channelIds.push(await upsertChannel(db, req.user.workspace_id,
              { platform: 'instagram', externalId: page.instagram.id, name, token, pageId: page.id }));
            connected.push(name);
            steps.instagram = true;
          }
        }
      } catch (err) {
        if (!(err instanceof InboxError)) throw err;
        problems.push(err.message);
      }
    }
    // Subscribing only counts if a channel was actually added for this shop.
    steps.messages = steps.messages && channelIds.length > 0;
    await db.pendingConnections.deleteOne({ _id: pending._id });
    // Bring in the conversations these accounts already have, in the background.
    const importingIds = [];
    for (const channelId of channelIds) if (await importer?.start(channelId)) importingIds.push(channelId);
    emit(req.user.workspace_id, 'channels', null);
    res.json({ connected, problems, importing: importingIds.length > 0, channelIds, importingIds, steps });
  });

  // Called by the dashboard after Meta's WhatsApp Embedded Signup popup finishes.
  // `coexistence` means the business connected the number it already uses in the
  // WhatsApp Business app: it stays registered there, and its contacts and chat
  // history can be synced (only once, within 24 hours of onboarding).
  router.post('/api/connect/whatsapp', auth, requireOwner, requireMetaApp, async (req, res) => {
    const { code, expectedNumber = '' } = req.body ?? {};
    let coexistence = Boolean(req.body?.coexistence);
    let wabaId = req.body?.wabaId ?? null;
    let phoneNumberId = req.body?.phoneNumberId ?? null;
    if (typeof code !== 'string' || !code.trim()) {
      throw new InboxError(400, 'WhatsApp signup did not finish. Please try again.');
    }
    if ((wabaId !== null && !/^\d+$/.test(String(wabaId))) || (phoneNumberId !== null && !/^\d+$/.test(String(phoneNumberId)))) {
      throw new InboxError(400, 'Unexpected WhatsApp account ID');
    }

    // Each step is logged (IDs only, never tokens) so a failed connect can be traced from the server logs.
    const wlog = (msg) => console.log(`whatsapp connect (workspace ${req.user.workspace_id}): ${msg}`);
    wlog(`started · account ${wabaId ?? 'not sent'} · number ${phoneNumberId ?? 'not sent'} · business app ${Boolean(coexistence)}`);
    let token;
    try {
      token = await meta.businessTokenFromCode(code);
      wlog('code exchanged for a token');
      // Meta's window tells the browser which account was shared, but that note can go missing:
      // then the account is the one the new token was granted.
      if (!wabaId) {
        const ids = await meta.wabaIdsFromToken(token);
        if (!ids.length) throw new InboxError(400, 'WhatsApp signup did not share a WhatsApp account. Please run it again and finish every step.');
        wabaId = ids[0];
        wlog(`account found from the token: ${wabaId} (of ${ids.length})`);
      }
      wabaId = String(wabaId);
      await meta.subscribeWaba(wabaId, token);
      wlog(`account ${wabaId} subscribed to webhooks`);
      // Newer sign-up flows (and Business app numbers) only report the account, not the number.
      if (!phoneNumberId) {
        const numbers = await meta.wabaPhoneNumbers(wabaId, token);
        if (!numbers.length) throw new InboxError(400, 'No phone number was added in WhatsApp signup. Please run it again and add your number.');
        phoneNumberId = String(numbers[0].id);
      }
    } catch (err) {
      wlog(`failed: ${err.message}`);
      if (err instanceof InboxError) throw err;
      throw new InboxError(502, `WhatsApp error: ${err.message}`);
    }
    wlog(`number ${phoneNumberId}`);

    const problems = [];
    let registeredPin = null;
    let name = `WhatsApp ${phoneNumberId}`;
    let displayNumber = null;
    let info = null;
    try {
      info = await meta.phoneNumber(phoneNumberId, token);
      displayNumber = info.display_phone_number ?? null;
      name = [info.verified_name, info.display_phone_number].filter(Boolean).join(' · ') || name;
    } catch { /* keep the fallback name */ }
    // "On the WhatsApp Business app" was picked, but Meta says the number isn't linked to the app: it is a
    // plain API number, which only receives messages once it is registered.
    if (coexistence && info && info.is_on_biz_app === false) {
      wlog('picked as a Business app number, but Meta says it is not one: registering it');
      coexistence = false;
    }
    if (!coexistence) {
      // A number that already uses the Cloud API is registered with its own PIN,
      // in which case this fails harmlessly.
      const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
      try {
        await meta.registerPhone(phoneNumberId, token, pin);
        registeredPin = pin;
      } catch (err) {
        wlog(`register failed: ${err.message}`);
        problems.push(/existing WhatsApp account/i.test(err.message)
          ? 'This number is still in use in a WhatsApp app (on a phone or WhatsApp Web), so WhatsApp won\'t deliver its messages to Quicky. Remove the number from that WhatsApp app, wait 3 minutes, then connect it again here.'
          : `Could not register the number for messaging: ${err.message}`);
      }
    }
    // Compare the last 10 digits so "+880 1712-345678" matches "01712345678".
    const tail = (n) => String(n ?? '').replace(/\D/g, '').slice(-10);
    if (expectedNumber && displayNumber && tail(expectedNumber) !== tail(displayNumber)) {
      problems.push(`Meta connected ${displayNumber}, not the number you typed. If that's wrong, disconnect it in Settings and connect again.`);
    }

    const channelId = await upsertChannel(db, req.user.workspace_id, {
      platform: 'whatsapp', externalId: phoneNumberId, name, token: encryptSecret(token, config.tokenKey), wabaId,
    });

    let importing = false;
    if (coexistence) {
      // Contacts first (they carry the names), then chat history. Both arrive as webhooks.
      try {
        await meta.requestAppDataSync(phoneNumberId, token, 'smb_app_state_sync');
      } catch (err) {
        problems.push(`Could not sync WhatsApp contacts: ${err.message}`);
      }
      try {
        await meta.requestAppDataSync(phoneNumberId, token, 'history');
        await db.channels.updateOne({ _id: channelId }, { $set: { import_status: 'running', import_count: 0, import_error: null } });
        importing = true;
      } catch (err) {
        problems.push(`Could not start chat history sync: ${err.message}`);
      }
    }
    emit(req.user.workspace_id, 'channels', null);
    wlog(`connected ${phoneNumberId} as channel ${channelId}${problems.length ? ` · problems: ${problems.join(' | ')}` : ''}`);
    res.json({ connected: [name], problems, pin: registeredPin, importing, channelId, displayNumber });
  });

  // How a WhatsApp sign-up ended in the browser (see client/src/connect.js). Only Meta's event names and its
  // reason text are logged, trimmed; never codes or tokens.
  router.post('/api/connect/whatsapp/trace', auth, (req, res) => {
    const clean = (v, n = 80) => String(v ?? '').replace(/[^\w .,:;'()/-]/g, '').slice(0, n);
    const b = req.body ?? {};
    console.log(`whatsapp connect (workspace ${req.user.workspace_id}): browser ${clean(b.stage, 30)} · event ${clean(b.event, 50) || 'none'} · step ${clean(b.step, 50) || 'none'} · status ${clean(b.status, 30) || 'none'}${b.error ? ` · Meta says: ${clean(b.error, 200)}` : ''}`);
    res.json({ ok: true });
  });

  router.use('/api/connect', (err, req, res, _next) => {
    if (err instanceof InboxError) {
      if (err.status >= 400) console.warn(`connect: ${req.method} ${req.path} → ${err.status} ${err.message}`);
      return res.status(err.status).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return router;
}

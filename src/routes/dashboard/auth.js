import { Router } from 'express';
import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { hashPassword, verifyPassword, bearerToken } from '../../auth.js';
import { normalizeEmail } from '../../db.js';
import { InboxError } from '../../inbox.js';
import { bdPhone } from '../../dashboard/util.js';

const DAY = 86_400_000;
const sha = (s) => createHash('sha256').update(s).digest('hex');

// "Chrome on Windows" from a user agent, for Profile → Where you're logged in.
export function deviceName(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  if (/HeyQuicky/.test(ua)) return `HeyQuicky app${os ? ` · ${os}` : ''}`;
  return os ? `${browser} on ${os}` : browser;
}

export async function startSession(db, userId, req, { remember = true } = {}) {
  const token = randomBytes(32).toString('base64url');
  await db.sessions.create({
    _id: token, user_id: userId,
    // "Keep me logged in on this device" = 30 days; otherwise a day.
    expires_at: new Date(Date.now() + (remember ? 30 : 1) * DAY),
    device: deviceName(req.get('user-agent') ?? ''),
    location: '', last_seen: new Date(), created_at: new Date(),
  });
  return token;
}

// Finds a user by email or Bangladeshi mobile (in English or Bangla digits).
async function findByLogin(db, login) {
  const text = String(login ?? '').trim();
  if (!text) return null;
  if (text.includes('@')) return db.users.findOne({ email: normalizeEmail(text), is_active: true }).lean();
  const phone = bdPhone(text);
  return phone ? db.users.findOne({ phone, is_active: true }).lean() : null;
}

const mask = (value, channel) => (channel === 'sms'
  ? `${value.slice(0, 3)}••••${value.slice(-3)}`
  : value.replace(/^(.)(.*)(.@.*)$/, (_m, a, b, c) => `${a}${'•'.repeat(Math.min(b.length, 6))}${c}`));

// Small in-memory limiter per key (login attempts, reset codes).
function limiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 20_000) hits.clear();
    return recent.length <= max;
  };
}

export function dashboardAuthRoutes(db, adapters) {
  const router = Router();
  const loginLimit = limiter(20, 10 * 60_000);
  const resetLimit = limiter(5, 15 * 60_000);

  router.get('/auth/config', (_req, res) => {
    res.json({ googleClientId: adapters.google.clientId || null });
  });

  router.post('/auth/login', async (req, res) => {
    const { login, password, remember = true } = req.body ?? {};
    if (!loginLimit(`${req.ip}|${String(login).toLowerCase()}`)) throw new InboxError(429, 'Too many tries. Wait a few minutes and try again.');
    if (!login || !password) throw new InboxError(400, 'Enter your email or phone and password');
    const user = await findByLogin(db, login);
    if (!user) throw Object.assign(new InboxError(401, "We couldn't find an account with that email or phone"), { code: 'no_account' });
    if (!verifyPassword(String(password), user.password_hash)) {
      throw Object.assign(new InboxError(401, "That password doesn't match. Try again or reset it."), { code: 'wrong_password' });
    }
    res.json({ token: await startSession(db, user._id, req, { remember: Boolean(remember) }) });
  });

  router.post('/auth/google', async (req, res) => {
    let profile;
    try {
      profile = await adapters.google.verify(String(req.body?.credential ?? ''));
    } catch (err) {
      throw new InboxError(400, err.message);
    }
    let user = await db.users.findOne({ google_sub: profile.sub, is_active: true }).lean()
      ?? await db.users.findOne({ email: profile.email, is_active: true }).lean();
    if (!user) throw new InboxError(404, 'No HeyQuicky account uses this Google email. Start free to create one.');
    if (!user.google_sub) await db.users.updateOne({ _id: user._id }, { $set: { google_sub: profile.sub } });
    res.json({ token: await startSession(db, user._id, req) });
  });

  // Step 1 of "Forgot your password?": send a 6-digit code by email or SMS.
  // Answers the same whether or not the account exists, so it can't be used to find accounts.
  router.post('/auth/forgot', async (req, res) => {
    const login = String(req.body?.login ?? '').trim();
    if (!login) throw new InboxError(400, 'Enter your email or phone');
    if (!resetLimit(`${req.ip}|${login.toLowerCase()}`)) throw new InboxError(429, 'Too many codes asked for. Try again in 15 minutes.');
    const channel = login.includes('@') ? 'email' : 'sms';
    if (channel === 'sms' && !bdPhone(login)) throw new InboxError(400, 'Enter a valid email or an 11-digit mobile number');
    const resetId = randomBytes(16).toString('base64url');
    const user = await findByLogin(db, login);
    const target = channel === 'email' ? normalizeEmail(login) : bdPhone(login);
    if (user) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await db.passwordResets.create({ _id: resetId, user_id: user._id, code_hash: sha(`${resetId}:${code}`), channel, expires_at: new Date(Date.now() + 15 * 60_000) });
      const text = `Your HeyQuicky code is ${code}. It expires in 15 minutes. If you didn't ask for it, ignore this.`;
      try {
        if (channel === 'email') await adapters.email.send({ to: target, subject: 'Your HeyQuicky password code', text });
        else await adapters.sms.send({ to: target, text });
      } catch (err) {
        console.warn('reset code not sent:', err.message);
        throw new InboxError(502, `We couldn't send the code by ${channel === 'email' ? 'email' : 'SMS'}. Try again shortly.`);
      }
    }
    res.json({ resetId, channel, sentTo: mask(target, channel) });
  });

  async function checkCode(resetId, code) {
    const reset = await db.passwordResets.findOne({ _id: String(resetId ?? ''), expires_at: { $gt: new Date() } }).lean();
    if (!reset) throw new InboxError(400, 'This code has expired. Ask for a new one.');
    if (reset.attempts >= 5) throw new InboxError(429, 'Too many wrong codes. Ask for a new one.');
    const a = Buffer.from(sha(`${reset._id}:${String(code ?? '').replace(/\D/g, '')}`));
    const b = Buffer.from(reset.code_hash);
    if (!timingSafeEqual(a, b)) {
      await db.passwordResets.updateOne({ _id: reset._id }, { $inc: { attempts: 1 } });
      throw new InboxError(400, "That code isn't right. Check the message and try again.");
    }
    return reset;
  }

  router.post('/auth/verify-code', async (req, res) => {
    const reset = await checkCode(req.body?.resetId, req.body?.code);
    await db.passwordResets.updateOne({ _id: reset._id }, { $set: { verified: true } });
    res.json({ ok: true });
  });

  router.post('/auth/reset', async (req, res) => {
    const { resetId, code, password } = req.body ?? {};
    if (typeof password !== 'string' || password.length < 8) throw new InboxError(400, 'Use at least 8 characters');
    const reset = await checkCode(resetId, code);
    await db.users.updateOne({ _id: reset.user_id }, { $set: { password_hash: hashPassword(password), password_changed_at: new Date() } });
    // A new password logs out every other device.
    await db.sessions.deleteMany({ user_id: reset.user_id });
    await db.passwordResets.deleteOne({ _id: reset._id });
    res.json({ token: await startSession(db, reset.user_id, req) });
  });

  // Keeps "last seen" on the session list fresh; called by the dashboard when it loads.
  router.post('/auth/ping', async (req, res) => {
    const token = bearerToken(req);
    if (token) await db.sessions.updateOne({ _id: token }, { $set: { last_seen: new Date() } });
    res.sendStatus(204);
  });

  return router;
}

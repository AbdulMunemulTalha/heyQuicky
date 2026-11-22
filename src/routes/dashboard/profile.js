import { Router } from 'express';
import { createHash } from 'node:crypto';
import { InboxError } from '../../inbox.js';
import { bearerToken, hashPassword, verifyPassword } from '../../auth.js';
import { isDuplicateKey, normalizeEmail } from '../../db.js';
import { bdPhone } from '../../dashboard/util.js';
import { prefsFor } from '../../dashboard/notify.js';

// A session's public id: never the token itself, so the list can't leak a way in.
const sid = (token) => createHash('sha256').update(String(token)).digest('hex').slice(0, 16);

// Phase 2 · Profile & account (UX-11), frame "Profile & account": only for the person signed in.
export function profileRoutes(db, _config, { auth }) {
  const router = Router();

  router.get('/profile', auth, async (req, res) => {
    const [user, sessions] = await Promise.all([
      db.users.findById(req.user.id).lean(),
      db.sessions.find({ user_id: req.user.id, expires_at: { $gt: new Date() } }).sort({ last_seen: -1 }).limit(20).lean(),
    ]);
    const current = bearerToken(req);
    const prefs = prefsFor(user);
    res.json({
      name: user.name, displayName: user.display_name || '', phone: user.phone || '', email: user.email, avatar: user.avatar || '',
      language: user.language ?? 'en', theme: user.theme ?? 'light', passwordChangedAt: user.password_changed_at ?? user.created_at ?? null,
      google: Boolean(user.google_sub),
      sessions: sessions.map((s) => ({ id: sid(s._id), device: s.device || 'Browser', location: s.location || '', lastSeen: s.last_seen ?? s.created_at, current: s._id === current })),
      notifications: { order: prefs.events.order, handoff: prefs.events.handoff, mention: prefs.events.mention, quiet: prefs.quiet },
    });
  });

  router.patch('/profile', auth, async (req, res) => {
    const b = req.body ?? {};
    const user = await db.users.findById(req.user.id).lean();
    const set = {};
    if (b.name !== undefined) { set.name = String(b.name).trim().slice(0, 60); if (!set.name) throw new InboxError(400, 'Write your name'); }
    if (b.displayName !== undefined) set.display_name = String(b.displayName).trim().slice(0, 60);
    if (b.phone !== undefined) {
      const raw = String(b.phone).trim();
      if (raw) {
        set.phone = bdPhone(raw);
        if (!set.phone) throw new InboxError(400, 'Enter an 11-digit Bangladeshi mobile number (01…)');
        if (await db.users.exists({ phone: set.phone, _id: { $ne: user._id }, is_active: true })) throw new InboxError(409, 'Another account already uses this phone number');
      } else set.phone = '';
    }
    if (b.email !== undefined && normalizeEmail(b.email) !== user.email) {
      const email = normalizeEmail(b.email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InboxError(400, 'Enter a valid email');
      // Changing the email you log in with needs your password.
      if (!verifyPassword(String(b.password ?? ''), user.password_hash)) throw Object.assign(new InboxError(403, 'Enter your current password to change your email'), { code: 'password_needed' });
      set.email = email;
    }
    if (b.avatar !== undefined) {
      const url = String(b.avatar ?? '');
      if (url && !/^(\/files\/|https:\/\/)/.test(url)) throw new InboxError(400, 'Upload a photo');
      set.avatar = url;
    }
    if (!Object.keys(set).length) throw new InboxError(400, 'Nothing to change');
    try {
      await db.users.updateOne({ _id: user._id }, { $set: set });
    } catch (err) {
      if (isDuplicateKey(err)) throw new InboxError(409, 'Another account already uses this email');
      throw err;
    }
    res.json({ ok: true });
  });

  // Change password; every other device is logged out.
  router.post('/profile/password', auth, async (req, res) => {
    const user = await db.users.findById(req.user.id).lean();
    const next = String(req.body?.next ?? '');
    if (!verifyPassword(String(req.body?.current ?? ''), user.password_hash)) throw new InboxError(403, "Your current password doesn't match");
    if (next.length < 8) throw new InboxError(400, 'Use at least 8 characters for the new password');
    if (verifyPassword(next, user.password_hash)) throw new InboxError(400, 'Pick a password different from the current one');
    await db.users.updateOne({ _id: user._id }, { $set: { password_hash: hashPassword(next), password_changed_at: new Date() } });
    const r = await db.sessions.deleteMany({ user_id: user._id, _id: { $ne: bearerToken(req) } });
    res.json({ ok: true, loggedOut: r.deletedCount });
  });

  router.delete('/profile/google', auth, async (req, res) => {
    await db.users.updateOne({ _id: req.user.id }, { $set: { google_sub: null } });
    res.json({ ok: true });
  });

  router.delete('/profile/sessions/:id', auth, async (req, res) => {
    const sessions = await db.sessions.find({ user_id: req.user.id }, { _id: 1 }).lean();
    const s = sessions.find((x) => sid(x._id) === req.params.id);
    if (!s) throw new InboxError(404, 'That device is already logged out');
    if (s._id === bearerToken(req)) throw new InboxError(400, 'Use Log out in the menu to log out of this device');
    await db.sessions.deleteOne({ _id: s._id });
    res.json({ ok: true });
  });

  router.post('/profile/sessions/logout-others', auth, async (req, res) => {
    const r = await db.sessions.deleteMany({ user_id: req.user.id, _id: { $ne: bearerToken(req) } });
    res.json({ loggedOut: r.deletedCount });
  });

  return router;
}

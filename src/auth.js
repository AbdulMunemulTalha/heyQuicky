import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_DAYS = 30;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

export async function createSession(db, userId) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db.sessions.create({ _id: token, user_id: userId, expires_at: expiresAt });
  return token;
}

export async function deleteSession(db, token) {
  await db.sessions.deleteOne({ _id: token });
}

export async function userForToken(db, token) {
  if (typeof token !== 'string' || !token) return null;
  const session = await db.sessions.findOne({ _id: token, expires_at: { $gt: new Date() } }).lean();
  if (!session) return null;
  const user = await db.users.findOne({ _id: session.user_id, is_active: true },
    { workspace_id: 1, name: 1, email: 1, role: 1, is_online: 1 }).lean();
  return user ? { id: user._id, workspace_id: user.workspace_id, name: user.name, email: user.email, role: user.role, is_online: user.is_online } : null;
}

export function bearerToken(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

export function requireAuth(db) {
  return async (req, res, next) => {
    const user = await userForToken(db, bearerToken(req));
    if (!user) return res.status(401).json({ error: 'Not signed in' });
    req.user = user;
    next();
  };
}

export function requireOwner(req, res, next) {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the business owner can do this' });
  next();
}

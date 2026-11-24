import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomInt } from 'node:crypto';
import { escapeRegex } from './util.js';
import { aiModeOf } from './aiMode.js';

// HND-05 · Business Suite Chrome extension (frame "HND-05 · Business Suite Chrome extension"): a HeyQuicky
// panel inside business.facebook.com's inbox — take over / give back to the AI, the summary, a suggested
// reply, ask about the customer, and the courier check. It signs in with a one-time connect code.

export const EXT_DIR = fileURLToPath(new URL('../../extension/', import.meta.url));
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_MINUTES = 10;
export const EXT_SESSION_DAYS = 90;
export const EXT_DEVICE = 'Chrome extension · Business Suite';

export async function newConnectCode(db, user) {
  const code = Array.from({ length: 8 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
  await db.extensionCodes.deleteMany({ user_id: user.id });
  await db.extensionCodes.create({ _id: code, user_id: user.id, expires_at: new Date(Date.now() + CODE_MINUTES * 60_000) });
  return { code, expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000) };
}

// One use: the code becomes a 90-day session the person can end from Profile or Integrations.
export async function redeemConnectCode(db, raw) {
  const code = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 8) return null;
  const row = await db.extensionCodes.findOneAndDelete({ _id: code, expires_at: { $gt: new Date() } }).lean();
  if (!row) return null;
  const user = await db.users.findOne({ _id: row.user_id, is_active: true }, { name: 1, workspace_id: 1 }).lean();
  if (!user) return null;
  const token = randomBytes(32).toString('base64url');
  await db.sessions.create({ _id: token, user_id: user._id, expires_at: new Date(Date.now() + EXT_SESSION_DAYS * 86_400_000), device: EXT_DEVICE, last_seen: new Date(), created_at: new Date() });
  return { token, user };
}

// The badge on a chat in the Business Suite list (and the pill in the panel).
export function chatStatus(conv, { userId, aiMode, orderToday }) {
  if (conv.ai_handoff && conv.taken_over_by) return conv.taken_over_by === userId ? 'you' : 'teammate';
  if (conv.ai_handoff) return 'needs_you';
  if (aiMode === 'off' || conv.ai_off) return 'off';
  if (orderToday) return 'order';
  return 'ai';
}

// Which HeyQuicky chat is open in Business Suite: by the Page + thread id, else by the customer's name on that Page.
export async function findChat(db, user, { page = '', thread = '', name = '', q = '' }) {
  const ws = user.workspace_id;
  const channel = page ? await db.channels.findOne({ workspace_id: ws, external_id: String(page), platform: { $in: ['messenger', 'instagram'] } }).lean() : null;
  const otherPage = Boolean(page) && !channel && Boolean(await db.channels.exists({ external_id: String(page) }));
  const base = { workspace_id: ws, ...(channel ? { channel_id: channel._id } : {}) };
  let conv = null;
  if (channel && thread) {
    const contact = await db.contacts.findOne({ channel_id: channel._id, external_id: String(thread) }, { _id: 1 }).lean();
    if (contact) conv = await db.conversations.findOne({ ...base, contact_id: contact._id }).lean();
  }
  if (!conv && name.trim() && channel) {
    const contacts = await db.contacts.find({ channel_id: channel._id, name: new RegExp(`^${escapeRegex(name.trim())}$`, 'i') }, { _id: 1 }).limit(5).lean();
    const found = contacts.length ? await db.conversations.find({ ...base, contact_id: { $in: contacts.map((c) => c._id) } }).sort({ last_message_at: -1 }).limit(2).lean() : [];
    if (found.length === 1) conv = found[0];
  }
  // Not sure which one: the latest chats on this Page (or matching a search) to pick from.
  let candidates = [];
  if (!conv) {
    const search = String(q || name).trim();
    const contactIds = search ? (await db.contacts.find({ ...(channel ? { channel_id: channel._id } : {}), name: new RegExp(escapeRegex(search), 'i') }, { _id: 1 }).limit(50).lean()).map((c) => c._id) : null;
    const rows = await db.conversations.find({ ...base, ...(contactIds ? { contact_id: { $in: contactIds } } : {}) }).sort({ last_message_at: -1 }).limit(8).lean();
    const names = new Map((await db.contacts.find({ _id: { $in: rows.map((r) => r.contact_id) } }, { name: 1 }).lean()).map((c) => [c._id, c.name]));
    candidates = rows.map((r) => ({ id: r._id, name: names.get(r.contact_id) || 'Customer', lastAt: r.last_message_at }));
  }
  return { conversationId: conv?._id ?? null, otherPage, pageKnown: Boolean(channel), candidates };
}

// Statuses of the latest chats on a Page, for the badges in the Business Suite chat list.
export async function pageStatuses(db, user, workspace, { page = '' }) {
  const channel = page ? await db.channels.findOne({ workspace_id: user.workspace_id, external_id: String(page) }).lean() : null;
  const convs = await db.conversations.find({ workspace_id: user.workspace_id, ...(channel ? { channel_id: channel._id } : {}) }).sort({ last_message_at: -1 }).limit(60).lean();
  const names = new Map((await db.contacts.find({ _id: { $in: convs.map((c) => c.contact_id) } }, { name: 1 }).lean()).map((c) => [c._id, c.name]));
  const dayAgo = new Date(Date.now() - 86_400_000);
  const ordered = new Set((await db.orders.find({ workspace_id: user.workspace_id, conversation_id: { $in: convs.map((c) => c._id) }, taken_by: 'ai', created_at: { $gte: dayAgo } }, { conversation_id: 1 }).lean()).map((o) => o.conversation_id));
  return convs.filter((c) => names.get(c.contact_id)).map((c) => ({ id: c._id, name: names.get(c.contact_id), status: chatStatus(c, { userId: user.id, aiMode: aiModeOf(workspace), orderToday: ordered.has(c._id) }) }));
}

// ---- The extension as a zip with this server's address filled in (store-only zip, no compression) ----
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const n = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
    c.writeUInt32LE(0, 12); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

export function extensionZip(publicUrl) {
  const files = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push({ name: `heyquicky-extension/${relative(EXT_DIR, p).split(sep).join('/')}`, data: readFileSync(p) });
    }
  };
  walk(EXT_DIR);
  const server = String(publicUrl || '').replace(/\/+$/, '');
  const at = files.findIndex((f) => f.name.endsWith('/config.js'));
  const config = Buffer.from(`// Filled in by the HeyQuicky server you downloaded this from.\nself.HQ_SERVER = ${JSON.stringify(server)};\n`);
  if (at >= 0) files[at].data = config; else files.push({ name: 'heyquicky-extension/config.js', data: config });
  return zip(files);
}

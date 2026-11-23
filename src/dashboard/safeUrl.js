import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { InboxError } from '../inbox.js';

// Addresses on the shop's own network or ours are never called (WooCommerce import, webhooks).
export function privateAddress(ip) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return privateAddress(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

// A public https:// URL, or a friendly error. Resolved again right before each call, so a name that later
// points somewhere private is still refused.
export async function publicHttpsUrl(input, { resolve = lookup, what = 'address' } = {}) {
  let url;
  try { url = new URL(String(input ?? '').trim()); } catch { throw new InboxError(400, `That doesn't look like a web ${what}`); }
  if (url.protocol !== 'https:') throw new InboxError(400, `The ${what} must start with https://`);
  if (url.username || url.password) throw new InboxError(400, `Use the plain ${what}, without a login in it`);
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || (!host.includes('.') && !isIP(host))) throw new InboxError(400, `Use a public ${what}`);
  const ips = isIP(host) ? [{ address: host }] : await resolve(host, { all: true }).catch(() => []);
  if (!ips.length) throw new InboxError(400, `We couldn't find ${host}`);
  if (ips.some((x) => privateAddress(x.address))) throw new InboxError(400, `Use a public ${what}`);
  return url.toString();
}

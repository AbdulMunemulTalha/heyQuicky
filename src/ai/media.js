// Downloads what a customer sent so the AI can see photos (AI-05) and hear voice notes (AI-04).
// Messenger and Instagram give a file URL; WhatsApp gives a media id that is looked up with the
// channel's token. Files are only held in memory for the one model call, never stored.
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Claude's per-image limit

async function readCapped(res, maxBytes) {
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  if (Number(res.headers.get('content-length') || 0) > maxBytes) throw new Error('file is too large');
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error('file is too large');
  return bytes;
}

// channel: { platform, access_token (decrypted) }. Returns { bytes, mime }.
export async function fetchAttachment({ channel, attachment, graphVersion = 'v23.0', maxBytes, fetchImpl = globalThis.fetch }) {
  const signal = () => AbortSignal.timeout(30_000);
  if (attachment.mediaId) {
    if (!channel?.access_token) throw new Error('no channel token');
    const auth = { Authorization: `Bearer ${channel.access_token}` };
    const metaRes = await fetchImpl(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(attachment.mediaId)}`, { headers: auth, signal: signal() });
    const info = await metaRes.json().catch(() => ({}));
    if (!metaRes.ok || !info.url) throw new Error(`media lookup failed (${metaRes.status})`);
    if (Number(info.file_size || 0) > maxBytes) throw new Error('file is too large');
    const res = await fetchImpl(info.url, { headers: auth, signal: signal() });
    return { bytes: await readCapped(res, maxBytes), mime: info.mime_type || res.headers.get('content-type') || '' };
  }
  if (!attachment.url) throw new Error('no file link');
  const res = await fetchImpl(attachment.url, { signal: signal() });
  return { bytes: await readCapped(res, maxBytes), mime: (res.headers.get('content-type') || '').split(';')[0].trim() };
}

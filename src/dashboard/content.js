import { InboxError } from '../inbox.js';
import { graphRequest, INVALID_TOKEN } from '../platforms/meta.js';
import { decryptSecret } from '../secrets.js';

// CMT-06 · Content studio (frame "AI post generator & content studio"): the AI writes Bangla posts from a
// product, the shop schedules them on a calendar, and at the time they go to the Facebook Page and
// Instagram. Publishing needs Meta's pages_manage_posts / instagram_content_publish permissions; without
// them a post becomes "Ready to post" so the team can copy it and post by hand.

const DHAKA_MS = 6 * 3_600_000;
export const TONES = ['warm', 'offer', 'story'];
export const PLATFORMS = ['facebook', 'instagram'];
const PERMISSION_CODES = new Set([3, 10, 200, 299]);

export const WRITE_SCHEMA = {
  type: 'object',
  properties: {
    versions: { type: 'array', items: { type: 'string' }, description: 'Exactly 3 different post texts.' },
  },
  required: ['versions'],
  additionalProperties: false,
};

const TONE_TEXT = {
  warm: 'warm and friendly, like a shop owner talking to regular customers',
  offer: 'an offer with gentle urgency (only if there is a real offer or a reason; never invent a discount)',
  story: 'a short story or moment that shows the product in use',
};

export function writePrompt({ shop, product, topic, tone }) {
  const price = product ? `৳${Number(product.price).toLocaleString('en-IN')}${product.compare_at > product.price ? ` (was ৳${Number(product.compare_at).toLocaleString('en-IN')})` : ''}` : '';
  return [
    `You write organic Facebook and Instagram posts for ${shop}, an online shop in Bangladesh.`,
    'Write in natural Bangla script (a few common English words are fine), 2–4 short lines, at most 2 emoji, and end with a clear way to order (message the page). No hashtags except at most 2 at the end.',
    `Tone: ${TONE_TEXT[tone] ?? TONE_TEXT.warm}.`,
    product ? `Product: ${product.name}, price ${price}${product.variants ? `, options ${product.variants}` : ''}${product.description ? `. About it: ${String(product.description).slice(0, 300)}` : ''}.` : '',
    topic ? `What the post is about: ${String(topic).slice(0, 300)}.` : '',
    'Use only these facts. Never invent prices, discounts, stock or delivery promises that are not given.',
    'Give 3 clearly different versions.',
  ].filter(Boolean).join('\n');
}

// "Best time": the hour customers message the shop most in the last 30 days (Dhaka), or 8:30 PM.
export async function bestTime(db, workspaceId, now = new Date()) {
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const convs = await db.conversations.find({ workspace_id: workspaceId }, { _id: 1 }).limit(5000).lean();
  const rows = await db.messages.aggregate([
    { $match: { conversation_id: { $in: convs.map((c) => c._id) }, direction: 'in', created_at: { $gte: since } } },
    { $group: { _id: { $hour: { date: '$created_at', timezone: 'Asia/Dhaka' } }, n: { $sum: 1 } } },
    { $sort: { n: -1 } }, { $limit: 1 },
  ]);
  if (!rows.length || rows[0].n < 20) return '20:30';
  return `${String(rows[0]._id).padStart(2, '0')}:00`;
}

export function dhakaDateTime(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !/^\d{1,2}:\d{2}$/.test(String(time))) return null;
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d, h, mi) - DHAKA_MS);
  return Number.isNaN(at.getTime()) ? null : at;
}

const absolute = (url, base) => (/^https:\/\//.test(url ?? '') ? url : url && base ? `${base.replace(/\/+$/, '')}${url.startsWith('/') ? '' : '/'}${url}` : '');

// Publishes one post to the shop's Page and/or Instagram account. Returns { status, external, error }.
export async function publishPost(db, config, post, { fetchImpl = fetch } = {}) {
  const channels = await db.channels.find({ workspace_id: post.workspace_id, platform: { $in: ['messenger', 'instagram'] }, needs_reconnect: { $ne: true } }).lean();
  const product = post.product_id ? await db.products.findById(post.product_id, { photos: 1, name: 1 }).lean() : null;
  const image = absolute(post.image || product?.photos?.[0] || '', config.publicUrl);
  const external = { ...(post.external ?? {}) };
  const errors = [];
  let permission = false;
  const base = `https://graph.facebook.com/${config.meta?.graphVersion ?? 'v23.0'}`;
  for (const platform of post.platforms ?? []) {
    if (external[platform]) continue; // already posted there
    const ch = channels.find((c) => (platform === 'facebook' ? c.platform === 'messenger' : c.platform === 'instagram'));
    if (!ch) { errors.push(`${platform === 'facebook' ? 'No Facebook Page' : 'No Instagram account'} is connected`); continue; }
    if (platform === 'instagram' && !image) { errors.push('Instagram needs a photo — add one to the product'); continue; }
    if (config.dryRun) { external[platform] = `dry_${platform}_${post._id}`; continue; }
    const token = ch.access_token ? decryptSecret(ch.access_token, config.tokenKey) : '';
    try {
      if (platform === 'facebook') {
        const r = image
          ? await graphRequest(`${base}/${ch.external_id}/photos`, { method: 'POST', accessToken: token, body: { url: image, caption: post.text }, fetchImpl })
          : await graphRequest(`${base}/${ch.external_id}/feed`, { method: 'POST', accessToken: token, body: { message: post.text }, fetchImpl });
        external.facebook = r.post_id || r.id;
      } else {
        const created = await graphRequest(`${base}/${ch.external_id}/media`, { method: 'POST', accessToken: token, body: { image_url: image, caption: post.text }, fetchImpl });
        const r = await graphRequest(`${base}/${ch.external_id}/media_publish`, { method: 'POST', accessToken: token, body: { creation_id: created.id }, fetchImpl });
        external.instagram = r.id;
      }
    } catch (err) {
      if (PERMISSION_CODES.has(err.code) || (err.code >= 200 && err.code <= 299)) permission = true;
      if (err.code === INVALID_TOKEN) await db.channels.updateOne({ _id: ch._id }, { $set: { needs_reconnect: true } });
      errors.push(`${platform}: ${err.message}`);
    }
  }
  const wanted = (post.platforms ?? []).length;
  const done = Object.keys(external).filter((k) => post.platforms.includes(k)).length;
  // Link the Facebook post to its product so the AI answers its comments (CMT-01 / CAT-06).
  if (post.link_product && post.product_id) {
    for (const platform of ['facebook', 'instagram']) {
      if (!external[platform] || post.external?.[platform]) continue;
      const ch = channels.find((c) => (platform === 'facebook' ? c.platform === 'messenger' : c.platform === 'instagram'));
      if (!ch || await db.posts.exists({ channel_id: ch._id, external_id: external[platform] })) continue;
      await db.insert(db.posts, { workspace_id: post.workspace_id, channel_id: ch._id, external_id: external[platform], platform, caption: post.text, image, product_ids: [post.product_id], match: 'linked', product_sources: { [post.product_id]: 'you' }, posted_at: new Date() });
    }
  }
  if (done === wanted) return { status: 'posted', external, error: '' };
  // Nothing allowed: the team posts it by hand. Some went out: keep what worked and say what didn't.
  return { status: done ? 'posted' : permission ? 'ready' : 'failed', external, error: permission ? "Facebook didn't allow HeyQuicky to post yet — copy it and post by hand, or reconnect after Meta approves posting" : errors.join(' · ') };
}

// Every minute: scheduled posts whose time has come.
export async function publishDue(db, config, { fetchImpl = fetch, notify = null, now = new Date() } = {}) {
  const due = await db.contentPosts.find({ status: 'scheduled', scheduled_at: { $lte: now } }).sort({ scheduled_at: 1 }).limit(20).lean();
  for (const post of due) {
    // Claim it so two runs never post twice.
    const claimed = await db.contentPosts.findOneAndUpdate({ _id: post._id, status: 'scheduled' }, { $set: { status: 'posting' } }, { new: true, lean: true });
    if (!claimed) continue;
    const r = await publishPost(db, config, claimed, { fetchImpl }).catch((err) => ({ status: 'failed', external: claimed.external ?? {}, error: err.message }));
    await db.contentPosts.updateOne({ _id: post._id }, { $set: { status: r.status, external: r.external, error: r.error, ...(r.status === 'posted' ? { posted_at: now } : {}) } });
    if (r.status !== 'posted' && notify) {
      await notify({ workspaceId: post.workspace_id, event: 'handoff', title: r.status === 'ready' ? 'A scheduled post is ready to post by hand' : "A scheduled post couldn't go out", body: `"${post.text.slice(0, 70)}…" — ${r.error}`, link: '/content', ref: `content:${post._id}` });
    }
  }
  return due.length;
}

export function startContentPublisher(db, config, { notify = null, fetchImpl = fetch, everyMs = 60_000 } = {}) {
  const timer = setInterval(() => publishDue(db, config, { notify, fetchImpl }).catch((err) => console.warn('content publisher failed:', err.message)), everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

export function cleanPost(body, { products }) {
  const text = String(body?.text ?? '').trim();
  if (!text) throw new InboxError(400, 'Write the post');
  if (text.length > 2200) throw new InboxError(400, 'Keep the post under 2,200 characters');
  const platforms = (Array.isArray(body?.platforms) ? body.platforms : []).filter((p) => PLATFORMS.includes(p));
  if (!platforms.length) throw new InboxError(400, 'Pick Facebook, Instagram or both');
  const productId = body?.productId ? Number(body.productId) : null;
  if (productId && !products.some((p) => p._id === productId)) throw new InboxError(400, 'That product is not in your catalog');
  return { text, platforms, product_id: productId, link_product: Boolean(body?.linkProduct) && Boolean(productId), topic: String(body?.topic ?? '').slice(0, 300), tone: TONES.includes(body?.tone) ? body.tone : 'warm' };
}

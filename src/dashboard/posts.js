import { graphRequest } from '../platforms/meta.js';
import { decryptSecret } from '../secrets.js';

// Posts (CAT-06 / CMT-02): syncing Page and Instagram posts, recognising which products a post
// shows, and the price range the AI quotes on multi-product posts.

const words = (s) => String(s ?? '').toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);

// Products whose whole name (or code) appears in the caption. Cheap, no AI.
export function captionMatch(caption, products) {
  const text = ` ${words(caption).join(' ')} `;
  if (text.trim() === '') return [];
  return products.filter((p) => {
    const name = words(p.name).join(' ');
    const code = words(p.code).join(' ');
    return (name && text.includes(` ${name} `)) || (code.replace(/ /g, '').length >= 3 && text.includes(` ${code} `));
  }).map((p) => p._id);
}

export function priceRange(products) {
  const prices = products.flatMap((p) => [p.price, ...(p.variant_list ?? []).map((v) => v.price)]).filter((x) => Number(x) > 0).map(Number);
  if (!prices.length) return null;
  return { min: Math.min(...prices), max: Math.max(...prices) };
}

// Pulls the latest posts (caption, picture, time) for one Facebook Page or Instagram account.
// Needs pages_read_engagement / instagram_basic on the channel's token.
export async function syncChannelPosts(db, config, channel, { fetchImpl = globalThis.fetch, limit = 25 } = {}) {
  if (config.dryRun || !channel.access_token) return { channel: channel._id, synced: 0, skipped: 'test_mode' };
  const token = decryptSecret(channel.access_token, config.tokenKey);
  const base = `https://graph.facebook.com/${config.meta.graphVersion}`;
  const ig = channel.platform === 'instagram';
  const url = ig
    ? `${base}/${encodeURIComponent(channel.external_id)}/media?fields=id,caption,media_url,thumbnail_url,timestamp,media_type&limit=${limit}`
    : `${base}/${encodeURIComponent(channel.external_id)}/posts?fields=id,message,full_picture,created_time&limit=${limit}`;
  const data = await graphRequest(url, { accessToken: token, fetchImpl });
  const created = [];
  for (const item of data.data ?? []) {
    const fields = {
      caption: String((ig ? item.caption : item.message) ?? '').slice(0, 2000),
      image: (ig ? (item.media_type === 'VIDEO' ? item.thumbnail_url : item.media_url) : item.full_picture) ?? '',
      posted_at: new Date((ig ? item.timestamp : item.created_time) ?? Date.now()),
    };
    const { doc, created: isNew } = await db.findOrCreate(db.posts, { channel_id: channel._id, external_id: String(item.id) },
      { workspace_id: channel.workspace_id, platform: ig ? 'instagram' : 'facebook', ...fields });
    if (!isNew) await db.posts.updateOne({ _id: doc.id ?? doc._id }, { $set: fields });
    if (isNew || !(doc.product_ids ?? []).length) created.push(doc.id ?? doc._id);
  }
  return { channel: channel._id, synced: (data.data ?? []).length, unmatched: created };
}

// Suggests products for a post from its caption; the shop confirms (match "ai_match" → "linked").
export async function suggestFromCaption(db, post) {
  if ((post.product_ids ?? []).length || !post.caption) return [];
  const products = await db.products.find({ workspace_id: post.workspace_id, archived: { $ne: true } }, { name: 1, code: 1 }).lean();
  const ids = captionMatch(post.caption, products).slice(0, 10);
  if (ids.length) await db.posts.updateOne({ _id: post._id }, { $set: { suggested_ids: ids, match: 'ai_match', match_source: 'caption' } });
  return ids;
}

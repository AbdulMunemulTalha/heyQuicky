import { Router } from 'express';
import { InboxError } from '../../inbox.js';
import { need } from '../../dashboard/permissions.js';
import { audit } from '../../dashboard/util.js';
import { priceRange, syncChannelPosts, suggestFromCaption } from '../../dashboard/posts.js';
import { productCards } from '../../platforms/rich.js';

const FILTERS = ['all', 'linked', 'suggested', 'none'];
// Older posts may not have these lists at all, so check for a first element instead of comparing with [].
const HAS_PRODUCTS = { 'product_ids.0': { $exists: true } };
const NO_PRODUCTS = { 'product_ids.0': { $exists: false } };
const SUGGESTED = { ...NO_PRODUCTS, 'suggested_ids.0': { $exists: true } };
const NOTHING = { ...NO_PRODUCTS, 'suggested_ids.0': { $exists: false } };
const SWITCHES = ['ai_reply', 'hide_spam', 'hide_phones', 'dm_cards'];

// Phase 2 · Posts (CAT-06 / CMT-02 / CMT-05): which products each post shows, what the AI
// sends under it (public reply + private message), and the comment automation switches.
export function postRoutes(db, config, { auth, agent, emit, fetchImpl }) {
  const router = Router();
  const edit = need(db, 'edit_products');
  const channelIds = async (ws) => (await db.channels.find({ workspace_id: ws, platform: { $in: ['messenger', 'instagram'] } }, { _id: 1 }).lean()).map((c) => c._id);
  const productMap = async (ids) => new Map((await db.products.find({ _id: { $in: ids } }).lean()).map((p) => [p._id, p]));
  const brief = (p) => ({ id: p._id, name: p.name, price: p.price, image: p.photos?.[0] ?? '', colour: p.colour || '', inStock: p.in_stock !== false });
  const rulesOf = (p) => ({ ai_reply: p.rules?.ai_reply !== false, hide_spam: p.rules?.hide_spam !== false, hide_phones: p.rules?.hide_phones !== false,
    dm_cards: p.rules?.dm_cards !== false, public_reply: p.rules?.public_reply ?? '' });

  async function load(req) {
    const post = await db.posts.findOne({ _id: Number(req.params.id), channel_id: { $in: await channelIds(req.user.workspace_id) } }).lean();
    if (!post) throw new InboxError(404, 'Post not found');
    return post;
  }

  router.get('/posts', auth, async (req, res) => {
    const ws = req.user.workspace_id;
    // Both platforms together unless one is asked for (frame "Posts" shows them in one grid).
    const platform = ['facebook', 'instagram'].includes(req.query.platform) ? req.query.platform : null;
    const filter = FILTERS.includes(req.query.filter) ? req.query.filter : 'all';
    const base = { channel_id: { $in: await channelIds(ws) }, ...(platform ? { platform } : {}) };
    const where = { ...base, ...(filter === 'linked' ? HAS_PRODUCTS : filter === 'suggested' ? SUGGESTED : filter === 'none' ? NOTHING : {}) };
    const [posts, counts, otherPlatform] = await Promise.all([
      db.posts.find(where).sort({ posted_at: -1 }).limit(60).lean(),
      Promise.all([
        db.posts.countDocuments(base),
        db.posts.countDocuments({ ...base, ...HAS_PRODUCTS }),
        db.posts.countDocuments({ ...base, ...SUGGESTED }),
        db.posts.countDocuments({ ...base, ...NOTHING }),
      ]),
      platform ? db.posts.countDocuments({ ...base, platform: platform === 'facebook' ? 'instagram' : 'facebook' }) : 0,
    ]);
    const products = await productMap(posts.flatMap((p) => [...(p.product_ids ?? []), ...(p.suggested_ids ?? [])]));
    const aiReplied = new Map((await db.comments.aggregate([{ $match: { post_id: { $in: posts.map((p) => p._id) }, replied_by: 'AI' } }, { $group: { _id: '$post_id', n: { $sum: 1 } } }])).map((x) => [x._id, x.n]));
    res.json({
      posts: posts.map((p) => ({
        id: p._id, platform: p.platform, caption: p.caption, image: p.image, postedAt: p.posted_at, comments: p.comment_count ?? 0, aiReplied: aiReplied.get(p._id) ?? 0,
        products: (p.product_ids ?? []).map((id) => products.get(id)).filter(Boolean).map(brief),
        suggested: (p.product_ids ?? []).length ? [] : (p.suggested_ids ?? []).map((id) => products.get(id)).filter(Boolean).map(brief),
        aiReply: p.rules?.ai_reply !== false,
      })),
      counts: { all: counts[0], linked: counts[1], suggested: counts[2], none: counts[3] },
      otherPlatform, aiReady: Boolean(agent?.status().available), canSync: !config.dryRun,
    });
  });

  router.get('/posts/:id', auth, async (req, res) => {
    const post = await load(req);
    const products = await productMap([...(post.product_ids ?? []), ...(post.suggested_ids ?? [])]);
    const linked = (post.product_ids ?? []).map((id) => products.get(id)).filter(Boolean);
    const range = priceRange(linked);
    const channel = await db.channels.findById(post.channel_id, { name: 1, platform: 1 }).lean();
    const recent = await db.comments.find({ post_id: post._id }).sort({ created_at: -1 }).limit(5).lean();
    // "What the AI sends": the public reply and the private message a price question gets.
    const preview = linked.length ? {
      public: rulesOf(post).public_reply || (linked.length > 1 && range ? `range:${range.min}:${range.max}` : `price:${linked[0].price}`),
      dm: channel?.platform === 'messenger' && rulesOf(post).dm_cards ? { kind: 'cards', rich: productCards(linked, { publicUrl: config.publicUrl || '' }) } : { kind: 'text' },
    } : null;
    res.json({
      post: { id: post._id, platform: post.platform, caption: post.caption, image: post.image, postedAt: post.posted_at, comments: post.comment_count ?? 0,
        channelName: channel?.name ?? '', channelPlatform: channel?.platform ?? '', match: post.match, matchSource: post.match_source ?? '', confidence: post.match_confidence ?? '' },
      products: linked.map((p) => ({ ...brief(p), source: post.product_sources?.[p._id] ?? 'you' })),
      suggested: (post.product_ids ?? []).length ? [] : (post.suggested_ids ?? []).map((id) => products.get(id)).filter(Boolean).map(brief),
      range, rules: rulesOf(post), preview,
      recent: recent.map((c) => ({ id: c._id, author: c.author_name, text: c.text, status: c.replied_by === 'AI' ? 'ai_replied' : c.status, reply: c.public_reply, at: c.created_at })),
      aiReady: Boolean(agent?.status().available),
    });
  });

  // Products in this post (CAT-06): set by hand, or by confirming the suggestion.
  router.put('/posts/:id/products', auth, edit, async (req, res) => {
    const post = await load(req);
    const ids = [...new Set((Array.isArray(req.body?.productIds) ? req.body.productIds : []).map(Number).filter(Number.isInteger))].slice(0, 10);
    const found = await db.products.find({ _id: { $in: ids }, workspace_id: req.user.workspace_id }, { _id: 1 }).lean();
    if (found.length !== ids.length) throw new InboxError(404, 'Product not found');
    const ordered = ids.filter((id) => found.some((f) => f._id === id));
    // Where each product came from: kept for ones already linked; a confirmed suggestion keeps its source (AI or caption).
    const before = post.product_sources ?? {};
    const sources = Object.fromEntries(ordered.map((id) => [id, before[id] ?? ((post.suggested_ids ?? []).includes(id) ? (post.match_source || 'ai') : 'you')]));
    await db.posts.updateOne({ _id: post._id }, { $set: { product_ids: ordered, suggested_ids: [], product_sources: sources, match: ordered.length ? 'linked' : 'none' } });
    emit(req.user.workspace_id, 'post', { id: post._id });
    res.json({ products: ordered.length });
  });

  router.post('/posts/:id/match', auth, edit, async (req, res) => {
    const post = await load(req);
    let ids;
    let source = 'ai';
    if (agent?.status().available) ids = await agent.matchPost(post._id);
    else { source = 'caption'; ids = await suggestFromCaption(db, { ...post, product_ids: [] }); }
    emit(req.user.workspace_id, 'post', { id: post._id });
    res.json({ suggested: ids ?? [], source });
  });

  router.patch('/posts/:id/rules', auth, edit, async (req, res) => {
    const post = await load(req);
    const rules = { ...(post.rules ?? {}) };
    let changed = false;
    for (const k of SWITCHES) if (typeof req.body?.[k] === 'boolean') { rules[k] = req.body[k]; changed = true; }
    if (req.body?.public_reply !== undefined) { rules.public_reply = String(req.body.public_reply).trim().slice(0, 300); changed = true; }
    if (!changed) throw new InboxError(400, 'Nothing to change');
    await db.posts.updateOne({ _id: post._id }, { $set: { rules } });
    res.json({ rules: rulesOf({ rules }) });
  });

  // "Sync posts": the latest posts from each connected Page and Instagram account, then a
  // caption match and (when AI is set up) a picture match for posts without products.
  router.post('/posts/sync', auth, edit, async (req, res) => {
    const ws = req.user.workspace_id;
    const channels = await db.channels.find({ workspace_id: ws, platform: { $in: ['messenger', 'instagram'] }, access_token: { $ne: '' } }).lean();
    const results = [];
    let matched = 0;
    for (const ch of channels) {
      try {
        const r = await syncChannelPosts(db, config, ch, { fetchImpl });
        results.push({ channel: ch.name, platform: ch.platform, synced: r.synced, skipped: r.skipped ?? null });
        for (const id of (r.unmatched ?? []).slice(0, 10)) {
          const post = await db.posts.findById(id).lean();
          if ((await suggestFromCaption(db, post)).length) matched += 1;
          else if (agent?.status().available && post.image) matched += ((await agent.matchPost(id).catch(() => null)) ?? []).length ? 1 : 0;
        }
        await db.posts.updateMany({ channel_id: ch._id }, { $set: { synced_at: new Date() } });
      } catch (err) {
        results.push({ channel: ch.name, platform: ch.platform, synced: 0, error: `Facebook didn't share the posts: ${err.message}` });
      }
    }
    await audit(db, req.user, 'Synced posts from Facebook and Instagram', { where: 'Posts' });
    emit(ws, 'post', {});
    res.json({ results, matched });
  });

  return router;
}

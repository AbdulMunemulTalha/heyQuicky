import { Router } from 'express';
import { InboxError } from '../../inbox.js';
import { need } from '../../dashboard/permissions.js';
import { audit } from '../../dashboard/util.js';
import { bestTime, cleanPost, dhakaDateTime, publishPost, TONES } from '../../dashboard/content.js';

// CMT-06 · Content studio: the calendar, the AI writer, and the posts.
export function contentRoutes(db, config, { auth, agent, fetchImpl = fetch }) {
  const router = Router();
  const edit = need(db, 'reply');
  const view = (p) => ({
    id: p._id, text: p.text, productId: p.product_id, topic: p.topic, tone: p.tone, platforms: p.platforms, linkProduct: p.link_product,
    status: p.status, scheduledAt: p.scheduled_at, postedAt: p.posted_at, error: p.error, external: p.external ?? {}, source: p.source, createdAt: p.created_at,
  });
  const products = (wsId) => db.products.find({ workspace_id: wsId, archived: { $ne: true } }, { name: 1, price: 1, compare_at: 1, variants: 1, description: 1, photos: 1, colour: 1, variant_list: 1, in_stock: 1 }).sort({ name: 1 }).limit(300).lean();

  router.get('/content', auth, async (req, res) => {
    const ws = req.user.workspace_id;
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month ?? '')) ? req.query.month : new Date(Date.now() + 6 * 3_600_000).toISOString().slice(0, 7);
    const [y, m] = month.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1) - 6 * 3_600_000 - 7 * 86_400_000);
    const to = new Date(Date.UTC(y, m, 1) - 6 * 3_600_000 + 7 * 86_400_000);
    const [posts, list, channels, time] = await Promise.all([
      db.contentPosts.find({ workspace_id: ws, $or: [{ scheduled_at: { $gte: from, $lt: to } }, { scheduled_at: null, status: { $in: ['draft', 'ready', 'failed'] } }] }).sort({ scheduled_at: 1 }).lean(),
      products(ws),
      db.channels.find({ workspace_id: ws, platform: { $in: ['messenger', 'instagram'] } }, { platform: 1, needs_reconnect: 1 }).lean(),
      bestTime(db, ws),
    ]);
    res.json({
      month, bestTime: time, aiReady: Boolean(agent?.status().available), tones: TONES,
      channels: { facebook: channels.some((c) => c.platform === 'messenger'), instagram: channels.some((c) => c.platform === 'instagram') },
      products: list.map((p) => ({ id: p._id, name: p.name, price: p.price, photo: p.photos?.[0] ?? '', colour: p.colour, stock: (p.variant_list ?? []).reduce((s, v) => s + (v.stock ?? 0), 0) || null })),
      posts: posts.map(view),
    });
  });

  // "AI wrote 3 versions" (metered like the test chat).
  router.post('/content/write', auth, edit, async (req, res) => {
    if (!agent?.status().available) throw new InboxError(503, 'The AI is not set up on this server yet');
    const ws = await db.workspaces.findById(req.user.workspace_id, { name: 1 }).lean();
    const product = req.body?.productId ? await db.products.findOne({ _id: Number(req.body.productId), workspace_id: ws._id }).lean() : null;
    const topic = String(req.body?.topic ?? '').trim().slice(0, 300);
    if (!product && !topic) throw new InboxError(400, 'Pick a product or say what the post is about');
    const tone = TONES.includes(req.body?.tone) ? req.body.tone : 'warm';
    const versions = await agent.writePosts(ws._id, { shop: ws.name, product, topic, tone });
    res.json({ versions });
  });

  router.post('/content/posts', auth, edit, async (req, res) => {
    const ws = req.user.workspace_id;
    const fields = cleanPost(req.body, { products: await products(ws) });
    const status = req.body?.status === 'scheduled' ? 'scheduled' : 'draft';
    let at = null;
    if (req.body?.date) {
      at = dhakaDateTime(req.body.date, req.body.time || '20:30');
      if (!at) throw new InboxError(400, 'Pick a day and time');
    }
    if (status === 'scheduled') {
      if (!at) throw new InboxError(400, 'Pick when to post it');
      if (at < new Date(Date.now() - 60_000)) throw new InboxError(400, 'Pick a time in the future');
    }
    const p = await db.insert(db.contentPosts, { workspace_id: ws, ...fields, status, scheduled_at: at, source: req.body?.fromAi ? 'ai' : 'team', created_by: req.user.id });
    await audit(db, req.user, status === 'scheduled' ? `Scheduled a post for ${at.toISOString().slice(0, 16)}` : 'Saved a post draft', { where: 'Content studio' });
    res.status(201).json(view(await db.contentPosts.findById(p.id).lean()));
  });

  const load = async (req) => {
    const p = await db.contentPosts.findOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id }).lean();
    if (!p) throw new InboxError(404, 'Post not found');
    return p;
  };

  router.patch('/content/posts/:id', auth, edit, async (req, res) => {
    const p = await load(req);
    if (['posted', 'posting'].includes(p.status)) throw new InboxError(409, 'This post has already gone out');
    const fields = cleanPost({ text: p.text, platforms: p.platforms, productId: p.product_id, linkProduct: p.link_product, topic: p.topic, tone: p.tone, ...req.body }, { products: await products(req.user.workspace_id) });
    const status = req.body?.status === 'scheduled' ? 'scheduled' : req.body?.status === 'draft' ? 'draft' : p.status === 'failed' || p.status === 'ready' ? 'draft' : p.status;
    let at = p.scheduled_at;
    if (req.body?.date) {
      at = dhakaDateTime(req.body.date, req.body.time || '20:30');
      if (!at) throw new InboxError(400, 'Pick a day and time');
    }
    if (status === 'scheduled' && (!at || at < new Date(Date.now() - 60_000))) throw new InboxError(400, 'Pick a time in the future');
    await db.contentPosts.updateOne({ _id: p._id }, { $set: { ...fields, status, scheduled_at: at, error: '' } });
    res.json(view(await db.contentPosts.findById(p._id).lean()));
  });

  router.delete('/content/posts/:id', auth, edit, async (req, res) => {
    const p = await load(req);
    if (p.status === 'posting') throw new InboxError(409, 'This post is going out right now');
    await db.contentPosts.deleteOne({ _id: p._id });
    res.json({ ok: true });
  });

  // "Post now".
  router.post('/content/posts/:id/publish', auth, edit, async (req, res) => {
    const p = await load(req);
    // Claim it atomically so a double click (or the scheduler) can't post it twice.
    const claimed = await db.contentPosts.findOneAndUpdate({ _id: p._id, status: { $nin: ['posted', 'posting'] } }, { $set: { status: 'posting' } });
    if (!claimed) throw new InboxError(409, 'This post has already gone out');
    const r = await publishPost(db, config, p, { fetchImpl }).catch((err) => ({ status: 'failed', external: p.external ?? {}, error: err.message }));
    await db.contentPosts.updateOne({ _id: p._id }, { $set: { status: r.status, external: r.external, error: r.error, ...(r.status === 'posted' ? { posted_at: new Date(), scheduled_at: p.scheduled_at ?? new Date() } : {}) } });
    await audit(db, req.user, r.status === 'posted' ? 'Published a post' : 'Tried to publish a post', { where: 'Content studio' });
    res.json(view(await db.contentPosts.findById(p._id).lean()));
  });

  // Posted by hand (after "Copy & open Facebook").
  router.post('/content/posts/:id/posted', auth, edit, async (req, res) => {
    const p = await load(req);
    await db.contentPosts.updateOne({ _id: p._id }, { $set: { status: 'posted', posted_at: new Date(), scheduled_at: p.scheduled_at ?? new Date(), error: '' } });
    res.json(view(await db.contentPosts.findById(p._id).lean()));
  });

  return router;
}

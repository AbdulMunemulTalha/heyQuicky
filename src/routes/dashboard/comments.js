import { Router } from 'express';
import { InboxError } from '../../inbox.js';
import { need } from '../../dashboard/permissions.js';
import { commentAction } from '../../dashboard/comments.js';

const STATUS = ['needs_you', 'ai_replied', 'replied', 'hidden'];

// Screen 14: posts with their comments, public replies, private DMs and hiding.
export function commentRoutes(db, config, { auth, emit, fetchImpl }) {
  const router = Router();

  const postRow = (p, counts, products) => ({
    id: p._id, platform: p.platform, caption: p.caption, image: p.image, postedAt: p.posted_at, total: p.comment_count,
    needsYou: counts.get(p._id) ?? 0, match: p.match, rules: p.rules,
    products: (p.product_ids ?? []).map((id) => products.get(id)).filter(Boolean).map((x) => ({ id: x._id, name: x.name, price: x.price })),
  });

  router.get('/comments/posts', auth, async (req, res) => {
    const ws = req.user.workspace_id;
    const platform = req.query.platform === 'instagram' ? 'instagram' : 'facebook';
    const posts = await db.posts.find({ workspace_id: ws, platform }).sort({ posted_at: -1 }).limit(60).lean();
    const needs = await db.comments.aggregate([{ $match: { workspace_id: ws, status: 'needs_you' } }, { $group: { _id: '$post_id', n: { $sum: 1 } } }]);
    const products = new Map((await db.products.find({ _id: { $in: posts.flatMap((p) => p.product_ids ?? []) } }, { name: 1, price: 1 }).lean()).map((p) => [p._id, p]));
    const counts = new Map(needs.map((n) => [n._id, n.n]));
    const otherPlatform = await db.posts.countDocuments({ workspace_id: ws, platform: platform === 'facebook' ? 'instagram' : 'facebook' });
    res.json({ posts: posts.map((p) => postRow(p, counts, products)), otherPlatform });
  });

  router.get('/comments/posts/:id', auth, async (req, res) => {
    const post = await db.posts.findOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id }).lean();
    if (!post) throw new InboxError(404, 'Post not found');
    const comments = await db.comments.find({ post_id: post._id }).sort({ created_at: -1 }).limit(300).lean();
    const channel = await db.channels.findById(post.channel_id, { name: 1, platform: 1 }).lean();
    const products = new Map((await db.products.find({ _id: { $in: post.product_ids ?? [] } }, { name: 1, price: 1 }).lean()).map((p) => [p._id, p]));
    const counts = { all: comments.length };
    const kind = (c) => (c.status === 'replied' && c.replied_by === 'AI' ? 'ai_replied' : c.status);
    for (const s of STATUS) counts[s] = comments.filter((c) => kind(c) === s).length;
    // Link each commenter to their private chat, if they have one.
    const contacts = await db.contacts.find({ channel_id: post.channel_id, external_id: { $in: comments.map((c) => c.author_external_id) } }, { external_id: 1 }).lean();
    const convs = new Map((await db.conversations.find({ contact_id: { $in: contacts.map((c) => c._id) } }, { contact_id: 1 }).lean()).map((c) => [c.contact_id, c._id]));
    const convByAuthor = new Map(contacts.map((c) => [c.external_id, convs.get(c._id)]));
    res.json({
      post: { ...postRow(post, new Map(), products), channelName: channel?.name ?? '', aiReplying: post.rules?.ai_reply !== false },
      counts,
      comments: comments.map((c) => ({
        id: c._id, author: c.author_name, text: c.text, at: c.created_at, status: kind(c), hiddenReason: c.hidden_reason,
        reply: c.public_reply, repliedBy: c.replied_by, dmSent: c.dm_sent, conversationId: convByAuthor.get(c.author_external_id) ?? null, parent: c.parent_external_id,
      })),
    });
  });

  async function loadComment(req) {
    const c = await db.comments.findOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id }).lean();
    if (!c) throw new InboxError(404, 'Comment not found');
    const channel = await db.channels.findById(c.channel_id).lean();
    return { c, channel };
  }

  // Public reply under the comment, optionally with a private DM (CMT-01).
  router.post('/comments/:id/reply', auth, need(db, 'reply'), async (req, res) => {
    const { c, channel } = await loadComment(req);
    const text = String(req.body?.text ?? '').trim().slice(0, 1000);
    const dm = String(req.body?.dm ?? '').trim().slice(0, 1000);
    if (!text && !dm) throw new InboxError(400, 'Write a reply');
    try {
      if (text) await commentAction(config, channel, 'reply', { commentId: c.external_id, text }, fetchImpl);
      if (dm) await commentAction(config, channel, 'dm', { commentId: c.external_id, text: dm }, fetchImpl);
    } catch (err) {
      throw new InboxError(502, `Facebook didn't accept the reply: ${err.message}`);
    }
    const set = { status: 'replied', replied_by: req.user.name };
    if (text) set.public_reply = text;
    if (dm) set.dm_sent = true;
    await db.comments.updateOne({ _id: c._id }, { $set: set });
    emit(req.user.workspace_id, 'comment', { id: c._id, postId: c.post_id, status: 'replied' });
    res.json({ ok: true });
  });

  router.post('/comments/:id/hide', auth, need(db, 'reply'), async (req, res) => {
    const { c, channel } = await loadComment(req);
    const hidden = req.body?.hidden !== false;
    try {
      await commentAction(config, channel, 'hide', { commentId: c.external_id, hidden }, fetchImpl);
    } catch (err) {
      throw new InboxError(502, `Facebook didn't hide the comment: ${err.message}`);
    }
    await db.comments.updateOne({ _id: c._id }, { $set: { status: hidden ? 'hidden' : 'needs_you', hidden_reason: hidden ? `Hidden by ${req.user.name}` : '' } });
    emit(req.user.workspace_id, 'comment', { id: c._id, postId: c.post_id });
    res.json({ ok: true });
  });

  // Post automation switches (also shown on the P1 Posts screen).
  router.patch('/comments/posts/:id/rules', auth, need(db, 'edit_products'), async (req, res) => {
    const post = await db.posts.findOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id }).lean();
    if (!post) throw new InboxError(404, 'Post not found');
    const rules = { ...post.rules };
    for (const k of ['ai_reply', 'hide_spam', 'hide_phones', 'remind_once', 'react_followup']) if (typeof req.body?.[k] === 'boolean') rules[k] = req.body[k];
    await db.posts.updateOne({ _id: post._id }, { $set: { rules } });
    res.json({ rules });
  });

  return router;
}

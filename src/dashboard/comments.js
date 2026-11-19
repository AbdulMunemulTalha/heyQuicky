import { graphRequest } from '../platforms/meta.js';
import { decryptSecret } from '../secrets.js';
import { looksLikeSpam } from './spam.js';

// Facebook Page and Instagram comments (CMT-01/05): reading them from webhooks and replying
// publicly, privately (Messenger "private reply") or hiding them through the Graph API.

// Comment events from a webhook body: Facebook "feed" changes and Instagram "comments" changes.
export function parseCommentChanges(body) {
  const out = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      if (body.object === 'page' && change.field === 'feed' && v.item === 'comment') {
        out.push({
          platform: 'messenger', accountId: String(entry.id), verb: v.verb, postId: String(v.post_id ?? ''), commentId: String(v.comment_id ?? ''),
          parentId: v.parent_id && v.parent_id !== v.post_id ? String(v.parent_id) : null,
          authorId: String(v.from?.id ?? ''), authorName: v.from?.name ?? '', text: v.message ?? '',
          at: v.created_time ? new Date(v.created_time * 1000) : new Date(),
        });
      }
      if (body.object === 'instagram' && change.field === 'comments') {
        out.push({
          platform: 'instagram', accountId: String(entry.id), verb: 'add', postId: String(v.media?.id ?? ''), commentId: String(v.id ?? ''),
          parentId: v.parent_id ? String(v.parent_id) : null, authorId: String(v.from?.id ?? ''), authorName: v.from?.username ?? '', text: v.text ?? '', at: new Date(),
        });
      }
    }
  }
  return out.filter((c) => c.commentId && c.postId);
}

const PHONE_IN_TEXT = /(?:\+?88)?0?1[3-9][\d\s-]{8,10}/;

// Stores one comment, applying the post's automation (hide spam, hide phone numbers).
export async function ingestComment(db, config, evt, { emit = () => {}, fetchImpl } = {}) {
  const channel = await db.channels.findOne({ platform: evt.platform, external_id: evt.accountId }).lean();
  if (!channel) return { ignored: 'unknown_channel' };
  if (evt.verb === 'remove') {
    await db.comments.deleteOne({ external_id: evt.commentId });
    return { removed: true };
  }
  if (evt.authorId && evt.authorId === channel.external_id) return { ignored: 'own_comment' };
  const { doc: post } = await db.findOrCreate(db.posts, { channel_id: channel._id, external_id: evt.postId },
    { workspace_id: channel.workspace_id, platform: evt.platform === 'instagram' ? 'instagram' : 'facebook', posted_at: evt.at });
  if (await db.comments.exists({ external_id: evt.commentId })) return { ignored: 'duplicate' };

  let status = 'needs_you';
  let hiddenReason = '';
  const rules = post.rules ?? {};
  if (rules.hide_spam !== false && looksLikeSpam(evt.text)) { status = 'hidden'; hiddenReason = 'Spam'; }
  else if (rules.hide_phones !== false && PHONE_IN_TEXT.test(evt.text)) { status = 'hidden'; hiddenReason = 'Phone number'; }
  const comment = await db.insert(db.comments, {
    workspace_id: channel.workspace_id, channel_id: channel._id, post_id: post.id, external_id: evt.commentId, parent_external_id: evt.parentId,
    author_name: evt.authorName, author_external_id: evt.authorId, text: evt.text, status, hidden_reason: hiddenReason, created_at: evt.at,
  });
  await db.posts.updateOne({ _id: post.id }, { $inc: { comment_count: 1 } });
  if (status === 'hidden') await commentAction(config, channel, 'hide', { commentId: evt.commentId, hidden: true }, fetchImpl).catch((err) => console.warn('auto-hide failed:', err.message));
  emit(channel.workspace_id, 'comment', { id: comment.id, postId: post.id, status });
  return { stored: true, comment };
}

// reply: public answer under the comment · dm: Messenger private reply · hide / unhide.
export async function commentAction(config, channel, action, { commentId, text, hidden, message }, fetchImpl = globalThis.fetch) {
  if (config.dryRun || !channel.access_token) return { dryRun: true };
  const token = decryptSecret(channel.access_token, config.tokenKey);
  const base = `https://graph.facebook.com/${config.meta.graphVersion}`;
  const ig = channel.platform === 'instagram';
  if (action === 'reply') {
    return graphRequest(`${base}/${encodeURIComponent(commentId)}/${ig ? 'replies' : 'comments'}`, { method: 'POST', accessToken: token, body: { message: text }, fetchImpl });
  }
  if (action === 'dm') {
    const pageId = ig ? channel.page_id || channel.external_id : channel.external_id;
    return graphRequest(`${base}/${encodeURIComponent(pageId)}/messages`, { method: 'POST', accessToken: token, body: { recipient: { comment_id: commentId }, message: message ?? { text } }, fetchImpl });
  }
  if (action === 'hide') {
    return graphRequest(`${base}/${encodeURIComponent(commentId)}`, { method: 'POST', accessToken: token, body: ig ? { hide: Boolean(hidden) } : { is_hidden: Boolean(hidden) }, fetchImpl });
  }
  throw new Error(`Unknown comment action ${action}`);
}

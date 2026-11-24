import { InboxError } from '../inbox.js';
import { escapeRegex } from './util.js';

// UX-05 · In-app feature requests (frame "UX-05 · In-app feature requests"): Help → Requests. A shop asks by
// text or voice, sees its requests with how many shops want the same, and what HeyQuicky did with each.
// Requests are shared: other shops vote for the same one instead of asking again.

export const STATUSES = ['reviewing', 'planned', 'in_progress', 'done', 'not_now'];
export const PER_DAY = 10;

const STOP = new Set(['the', 'a', 'an', 'to', 'and', 'or', 'for', 'of', 'in', 'on', 'with', 'my', 'i', 'we', 'it', 'is', 'be', 'can', 'please', 'want', 'need', 'like', 'would', 'should', 'add', 'make', 'have', 'from', 'that', 'this', 'when', 'আর', 'এবং', 'যদি', 'চাই', 'করে', 'করা', 'একটা', 'একটি', 'দিয়ে', 'থেকে']);
export const words = (s) => [...new Set(String(s ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w)))];

// A short title from what they wrote: the first sentence, at most 80 characters.
export function titleFrom(text) {
  const first = String(text).trim().split(/(?<=[.!?।])\s|\n/)[0].trim();
  return first.length > 80 ? `${first.slice(0, 77).replace(/\s+\S*$/, '')}…` : first;
}

const DEFAULT_NOTE = {
  reviewing: { en: "We're looking into it", bn: 'আমরা দেখছি' },
  planned: { en: 'Planned', bn: 'পরিকল্পনায় আছে' },
  in_progress: { en: 'Being built now', bn: 'এখন তৈরি হচ্ছে' },
  done: { en: 'Released', bn: 'চালু হয়েছে' },
  not_now: { en: 'Not possible yet', bn: 'এখনই সম্ভব নয়' },
};

export function requestView(r, { workspaceId, lang = 'en' }) {
  const custom = r.note?.[lang] || r.note?.en || r.note?.bn || '';
  const fallback = DEFAULT_NOTE[r.status]?.[lang] ?? '';
  const released = r.status === 'done' && r.released_at
    ? `${lang === 'bn' ? 'চালু হয়েছে' : 'Released'} ${new Date(r.released_at).toLocaleDateString(lang === 'bn' ? 'bn-BD' : 'en-US', { month: 'short', day: 'numeric', timeZone: 'Asia/Dhaka' })}` : '';
  return {
    id: r._id, title: r.title, text: r.text, voice: r.voice || '', status: r.status, votes: (r.voters ?? []).length,
    note: custom ? (released && !custom.startsWith(released.split(' ')[0]) ? `${released} — ${custom}` : custom) : released || fallback,
    voted: (r.voters ?? []).includes(workspaceId), mine: r.workspace_id === workspaceId, link: r.link || '', createdAt: r.created_at,
  };
}

// Open requests from other shops that sound like this one ("Others asked for this too").
export async function similarRequests(db, workspaceId, text, limit = 3) {
  const w = words(text);
  if (!w.length) return [];
  const rx = w.slice(0, 12).map((x) => new RegExp(escapeRegex(x), 'i'));
  const rows = await db.featureRequests.find({ merged_into: null, status: { $ne: 'not_now' }, voters: { $ne: workspaceId }, $or: [{ title: { $in: rx } }, { text: { $in: rx } }] }).limit(50).lean();
  const need = w.length <= 2 ? 1 : 2;
  return rows
    .map((r) => ({ r, hits: words(`${r.title} ${r.text}`).filter((x) => w.includes(x)).length }))
    .filter((x) => x.hits >= need)
    .sort((a, b) => b.hits - a.hits || (b.r.voters?.length ?? 0) - (a.r.voters?.length ?? 0))
    .slice(0, limit)
    .map((x) => x.r);
}

export async function createRequest(db, user, { text, voice = '' }) {
  const body = String(text ?? '').trim().slice(0, 1000);
  const v = /^\/files\/[a-f0-9]{24}$/.test(String(voice ?? '')) ? voice : '';
  if (!body && !v) throw new InboxError(400, 'Tell us what you need');
  const since = new Date(Date.now() - 86_400_000);
  if (await db.featureRequests.countDocuments({ workspace_id: user.workspace_id, created_at: { $gte: since } }) >= PER_DAY) throw new InboxError(429, 'That is a lot of requests for one day — add more tomorrow');
  const title = body ? titleFrom(body) : 'Voice request';
  return db.insert(db.featureRequests, { workspace_id: user.workspace_id, created_by: user.id, title, text: body, voice: v, status: 'reviewing', voters: [user.workspace_id] });
}

// HeyQuicky's team changes a request: the shops that asked hear about it.
export async function updateRequest(db, id, b, { notify = null } = {}) {
  const r = await db.featureRequests.findById(Number(id)).lean();
  if (!r) throw new InboxError(404, 'Request not found');
  const set = {};
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) throw new InboxError(400, `Status is one of ${STATUSES.join(', ')}`);
    set.status = b.status;
    if (b.status === 'done' && r.status !== 'done') set.released_at = new Date();
  }
  if (b.title !== undefined) { const t = String(b.title).trim().slice(0, 80); if (!t) throw new InboxError(400, 'Give it a title'); set.title = t; }
  if (b.noteEn !== undefined) set['note.en'] = String(b.noteEn).trim().slice(0, 200);
  if (b.noteBn !== undefined) set['note.bn'] = String(b.noteBn).trim().slice(0, 200);
  if (b.link !== undefined) set.link = /^\/[a-z0-9/?=&_.-]*$/i.test(String(b.link)) ? b.link : '';
  if (!Object.keys(set).length && b.announcementId === undefined) throw new InboxError(400, 'Nothing to change');
  const fresh = await db.featureRequests.findOneAndUpdate({ _id: r._id }, { $set: set }, { new: true, lean: true });
  // Released with an announcement: "You asked for this" in What's new for every shop that asked.
  if (b.announcementId) await db.announcements.updateOne({ _id: Number(b.announcementId) }, { $addToSet: { asked_by: { $each: fresh.voters ?? [] } } });
  if (set.status && set.status !== r.status && notify) {
    const label = { reviewing: 'is being reviewed', planned: 'is planned', in_progress: 'is being built', done: 'is ready to use', not_now: "can't be done yet" }[set.status];
    for (const ws of fresh.voters ?? []) {
      await notify({ workspaceId: ws, event: 'product', title: `Your request "${fresh.title}" ${label}`, body: fresh.note?.en || '', link: fresh.link || '/', ref: `req:${fresh._id}:${set.status}` }).catch(() => {});
    }
  }
  return fresh;
}

// Two requests are the same thing: votes move to the one that stays.
export async function mergeRequests(db, fromId, intoId) {
  const [from, into] = await Promise.all([db.featureRequests.findById(Number(fromId)).lean(), db.featureRequests.findById(Number(intoId)).lean()]);
  if (!from || !into || from._id === into._id) throw new InboxError(400, 'Pick two different requests');
  await db.featureRequests.updateOne({ _id: into._id }, { $addToSet: { voters: { $each: from.voters ?? [] } } });
  await db.featureRequests.updateOne({ _id: from._id }, { $set: { merged_into: into._id } });
  await db.featureRequests.updateMany({ merged_into: from._id }, { $set: { merged_into: into._id } });
  return db.featureRequests.findById(into._id).lean();
}

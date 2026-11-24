// UX-04 · Feature announcements (frame "UX-04 · Feature announcements"): Help → What's new, and a dismissible
// bar above the app for the newest one. Release notes ship with the code (RELEASES) so every deploy carries
// its own; HeyQuicky's team can add more from the admin API (stored in announcements, with "You asked for this").

export const KINDS = ['new', 'improved', 'fixed'];

// Newest first. seconds: the short video's length (shown when video is set).
export const RELEASES = [
  { id: 'r-2026-11-24-extension', kind: 'new', date: '2026-11-24', link: '/settings/integrations?open=extension', bar: true, module: null,
    title: { en: 'HeyQuicky inside Business Suite', bn: 'বিজনেস স্যুটের ভেতরেই HeyQuicky' },
    body: { en: 'A Chrome extension adds a HeyQuicky panel to the Business Suite inbox: take over, give back to the AI, suggested replies and the courier check.', bn: 'Chrome এক্সটেনশন বিজনেস স্যুটের ইনবক্সে HeyQuicky প্যানেল যোগ করে: নিজের হাতে নেওয়া, AI-কে ফেরত, প্রস্তাবিত উত্তর আর কুরিয়ার চেক।' } },
  { id: 'r-2026-11-24-gateway', kind: 'new', date: '2026-11-24', link: '/payments?tab=gateway', bar: true, module: null,
    title: { en: 'bKash gateway for advances', bn: 'অগ্রিমের জন্য বিকাশ গেটওয়ে' },
    body: { en: 'Customers pay inside the chat with bKash, Nagad or card. The order is approved when the money arrives — no TrxID to check.', bn: 'কাস্টমার চ্যাট থেকেই বিকাশ, নগদ বা কার্ডে পেমেন্ট করেন। টাকা এলেই অর্ডার কনফার্ম — TrxID মেলাতে হয় না।' } },
  { id: 'r-2026-11-24-advance-fix', kind: 'fixed', date: '2026-11-24', link: '/payments?tab=rules', bar: false, module: null,
    title: { en: 'Advance rule for courier risk', bn: 'কুরিয়ার ঝুঁকির অগ্রিম নিয়ম' },
    body: { en: 'Customers with a good courier record are no longer asked for an advance by the "delivery success below X%" rule.', bn: 'ভালো কুরিয়ার রেকর্ডের কাস্টমারদের আর "ডেলিভারি সফলতা X%-এর কম" নিয়মে অগ্রিম চাওয়া হয় না।' } },
  { id: 'r-2026-11-24-content', kind: 'new', date: '2026-11-24', link: '/content', bar: false, module: 'content',
    title: { en: 'AI writes your Facebook posts', bn: 'AI আপনার ফেসবুক পোস্ট লেখে' },
    body: { en: 'Content studio: pick a product, the AI writes 3 Bangla posts, schedule them on a calendar.', bn: 'কনটেন্ট স্টুডিও: একটি প্রোডাক্ট বাছুন, AI বাংলায় ৩টি পোস্ট লেখে, ক্যালেন্ডারে সময় ঠিক করুন।' } },
  { id: 'r-2026-11-24-selftest', kind: 'new', date: '2026-11-24', link: '/agent/training?tab=selftest', bar: false, module: null,
    title: { en: 'Weekly AI self-test', bn: 'সাপ্তাহিক AI সেলফ-টেস্ট' },
    body: { en: 'Every Monday the AI is asked everything you taught it again, and you hear if an answer broke.', bn: 'প্রতি সোমবার AI-কে আপনার শেখানো সব প্রশ্ন আবার করা হয়, কোনো উত্তর ভাঙলে জানানো হয়।' } },
  { id: 'r-2026-11-24-why', kind: 'new', date: '2026-11-24', link: '/inbox', bar: false, module: null,
    title: { en: '"Why did the AI say this?"', bn: '"AI এটা কেন বলল?"' },
    body: { en: 'Open any AI reply in the inbox to see the facts and settings it used.', bn: 'ইনবক্সে যেকোনো AI উত্তর খুলে দেখুন কোন তথ্য আর সেটিং দিয়ে বলেছে।' } },
  { id: 'r-2026-11-24-bookings', kind: 'new', date: '2026-11-24', link: '/bookings', bar: false, module: 'bookings',
    title: { en: 'Bookings & quotes', bn: 'বুকিং ও কোটেশন' },
    body: { en: 'The AI books appointments in chat and collects requests for custom work for you to price.', bn: 'AI চ্যাটে অ্যাপয়েন্টমেন্ট বুক করে আর কাস্টম কাজের অনুরোধ নিয়ে রাখে, দাম আপনি দেন।' } },
  { id: 'r-2026-11-23-quoted', kind: 'improved', date: '2026-11-23', link: '/inbox', bar: false, module: null,
    title: { en: 'AI understands replies to old messages', bn: 'পুরনো মেসেজের রিপ্লাই বোঝে AI' },
    body: { en: 'When a customer replies to an earlier message or product photo, the AI knows which one they mean.', bn: 'কাস্টমার আগের কোনো মেসেজ বা প্রোডাক্টের ছবিতে রিপ্লাই দিলে AI বোঝে কোনটার কথা বলছেন।' } },
  { id: 'r-2026-11-23-notes', kind: 'new', date: '2026-11-23', link: '/inbox', bar: false, module: null,
    title: { en: 'Team notes with @mentions', bn: '@মেনশনসহ টিম নোট' },
    body: { en: 'Leave private notes on any chat and mention a teammate.', bn: 'যেকোনো চ্যাটে গোপন নোট রাখুন আর সহকর্মীকে মেনশন করুন।' } },
  { id: 'r-2026-11-23-storefront', kind: 'new', date: '2026-11-23', link: '/settings/integrations?open=shoplink', bar: false, module: null,
    title: { en: 'Your shop link', bn: 'আপনার শপ লিংক' },
    body: { en: 'A free product page with checkout — share it in your bio or ads.', bn: 'চেকআউটসহ ফ্রি প্রোডাক্ট পেজ — বায়ো বা বিজ্ঞাপনে শেয়ার করুন।' } },
];

const dayOf = (d) => new Date(`${d}T06:00:00Z`);

export function cleanAnnouncement(b) {
  const kind = KINDS.includes(b?.kind) ? b.kind : 'new';
  const text = (v, max) => String(v ?? '').trim().slice(0, max);
  const title = { en: text(b?.title?.en ?? b?.titleEn, 80), bn: text(b?.title?.bn ?? b?.titleBn, 80) };
  const body = { en: text(b?.body?.en ?? b?.bodyEn, 300), bn: text(b?.body?.bn ?? b?.bodyBn, 300) };
  if (!title.en && !title.bn) throw Object.assign(new Error('Give it a title'), { status: 400 });
  const link = /^\/[a-z0-9/?=&_.-]*$/i.test(String(b?.link ?? '')) ? b.link : '';
  const video = /^https:\/\//.test(String(b?.video ?? '')) ? String(b.video).slice(0, 500) : '';
  return { kind, title, body, link, video, seconds: Math.max(0, Math.min(600, Math.round(Number(b?.seconds) || 0))), bar: Boolean(b?.bar),
    date: b?.date && !Number.isNaN(new Date(b.date).getTime()) ? new Date(b.date) : new Date(), asked_by: (Array.isArray(b?.askedBy) ? b.askedBy : []).map(Number).filter(Boolean) };
}

// Everything this person can see, newest first, in their language, with what's unread.
export async function announcementsFor(db, user, { lang = 'en', modules = {} } = {}) {
  const [u, extra, ws] = await Promise.all([
    db.users.findById(user.id, { whats_new_seen_at: 1, dismissed_bars: 1, created_at: 1 }).lean(),
    db.announcements.find({ published: { $ne: false } }).sort({ date: -1 }).limit(50).lean(),
    db.workspaces.findById(user.workspace_id, { created_at: 1 }).lean(),
  ]);
  const pick = (x) => x?.[lang] || x?.en || x?.bn || '';
  const all = [
    ...extra.map((a) => ({ id: `a-${a._id}`, kind: a.kind, date: a.date, title: a.title, body: a.body, link: a.link, video: a.video, seconds: a.seconds, bar: a.bar, module: null, asked: (a.asked_by ?? []).includes(user.workspace_id) })),
    ...RELEASES.map((r) => ({ ...r, date: dayOf(r.date), asked: false })),
  ].filter((a) => !a.module || modules[a.module] !== false).sort((a, b) => b.date - a.date);
  // A new person isn't greeted by a pile of "new": only things from the week before they joined count as unread.
  const joined = u?.created_at ?? ws?.created_at ?? new Date(0);
  const since = new Date(Math.max((u?.whats_new_seen_at ?? new Date(0)).getTime(), joined.getTime() - 7 * 86_400_000));
  const dismissed = new Set(u?.dismissed_bars ?? []);
  const items = all.map((a) => ({ id: a.id, kind: a.kind, date: a.date, title: pick(a.title), body: pick(a.body), link: a.link || '', video: a.video || '', seconds: a.seconds || 0, asked: a.asked, unread: a.date > since }));
  const bar = all.find((a) => a.bar && a.date > since && !dismissed.has(a.id));
  return { items, unread: items.filter((i) => i.unread).length, bar: bar ? items.find((i) => i.id === bar.id) : null };
}

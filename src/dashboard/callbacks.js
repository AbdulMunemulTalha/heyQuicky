import { dhakaDayStart } from './util.js';

// FUP-04 · Schedule a callback: "শুক্রবার বিকাল ৫টায় কল দিবেন" / "kal sokal 11 tay call diben" /
// "call me Friday 5pm" → a time in Bangladesh, with the words it came from.
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const toAscii = (s) => String(s ?? '').replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));

// 0 = Sunday … 6 = Saturday.
const WEEKDAYS = [
  [0, /রবিবার|রোববার|robibar|robi\s?bar|sunday/i], [1, /সোমবার|shombar|sombar|monday/i], [2, /মঙ্গলবার|mongolbar|tuesday/i],
  [3, /বুধবার|budhbar|budbar|wednesday/i], [4, /বৃহস্পতিবার|বিষ্যুদবার|brihospotibar|bisshudbar|thursday/i], [5, /শুক্রবার|shukrobar|sukrobar|friday/i],
  [6, /শনিবার|shonibar|sonibar|saturday/i],
];
const RELATIVE = [[0, /আজ|\baj\b|\baaj\b|today|tonight/i], [2, /পরশু|porshu|day after tomorrow/i], [1, /আগামীকাল|(?<!বি)কাল|\bkal\b|\bkaal\b|tomorrow/i]];
const PARTS = [
  ['morning', /সকাল|sokal|shokal|morning|\bam\b/i], ['noon', /দুপুর|dupur|noon/i], ['afternoon', /বিকাল|বিকেল|bikal|bikel|afternoon/i],
  ['evening', /সন্ধ্যা|সন্ধা|shondha|sondha|evening/i], ['night', /রাত|\braat\b|\brat\b|night|\bpm\b/i],
];
const CALL_WORDS = /কল|ফোন|call|phone|fon|kotha/i;

export function parseCallback(text, now = new Date()) {
  const raw = String(text ?? '');
  const s = toAscii(raw);
  let dayOffset = null;
  for (const [n, rx] of RELATIVE) if (rx.test(s)) { dayOffset = n; break; }
  if (dayOffset === null) {
    const wd = WEEKDAYS.find(([, rx]) => rx.test(s));
    if (wd) {
      const todayWd = new Date(now.getTime() + 6 * 3_600_000).getUTCDay();
      dayOffset = (wd[0] - todayWd + 7) % 7 || 7; // "Friday" said on a Friday means next week
    }
  }
  const part = PARTS.find(([, rx]) => rx.test(s))?.[0] ?? null;
  // "5ta", "৫টায়", "5:30", "5 pm", "11.30"
  const m = s.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(?:টা|টায়|ta|tay|ter|o'?clock|pm|am|baje|বাজে)?/i);
  const hasTime = m && Number(m[1]) >= 1 && Number(m[1]) <= 12 && /টা|টায়|ta\b|tay|pm|am|baje|বাজে|:|\./i.test(s.slice(m.index, m.index + m[0].length + 3));
  if (dayOffset === null && !hasTime) return null;
  if (dayOffset === null && !CALL_WORDS.test(s)) return null; // a bare time without a day needs "call"
  let hour = hasTime ? Number(m[1]) : { morning: 10, noon: 13, afternoon: 16, evening: 18, night: 20 }[part] ?? 11;
  const minute = hasTime && m[2] ? Number(m[2]) : 0;
  if (hasTime) {
    if (/pm/i.test(m[0]) || ['afternoon', 'evening', 'night'].includes(part)) { if (hour < 12) hour += 12; }
    else if (part === 'noon') { if (hour < 5) hour += 12; }
    else if (!/am/i.test(m[0]) && part !== 'morning' && hour >= 1 && hour <= 7) hour += 12; // "5ta" means 5 PM for a shop
  }
  const base = dhakaDayStart(now, dayOffset ?? 0);
  let at = new Date(base.getTime() + (hour * 60 + minute) * 60_000);
  if (at < now && dayOffset === null) at = new Date(at.getTime() + 86_400_000);
  return { at, quote: raw.trim().slice(0, 160) };
}

// The latest thing the customer said that names a callback time.
export function callbackFromMessages(messages, now = new Date()) {
  for (const msg of messages) {
    const found = msg.text && CALL_WORDS.test(toAscii(msg.text)) ? parseCallback(msg.text, now) : null;
    if (found && found.at > now) return found;
  }
  return null;
}

// Reminds each owner when a scheduled callback is due (checked every minute by the server).
export async function remindCallbacks(db, notify, now = new Date()) {
  const due = await db.prospects.find({ stage: 'call_scheduled', callback_at: { $lte: new Date(now.getTime() + 5 * 60_000) }, callback_reminded_at: null }).limit(200).lean();
  for (const p of due) {
    await db.prospects.updateOne({ _id: p._id, callback_reminded_at: null }, { $set: { callback_reminded_at: now } });
    await notify?.({ workspaceId: p.workspace_id, event: 'handoff', userIds: p.owner_user_id ? [p.owner_user_id] : undefined,
      title: `Call ${p.name || 'the customer'} now`, body: [p.product, p.phone].filter(Boolean).join(' · '), link: `/growth?tab=leads&leads=contacted`, ref: `callback:${p._id}:${new Date(p.callback_at).getTime()}` });
  }
  return due.length;
}

// Helpers shared by the dashboard routes: phones, money, time and audit logging.

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

// Bangla digits (০-৯) to ASCII, so ০১৭১২-৩৪৫৬৭৮ is read like 01712-345678.
export function asciiDigits(input) {
  return String(input ?? '').replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
}

// A Bangladeshi mobile: 11 digits starting 013–019, written with or without +880/880,
// spaces or dashes, in English or Bangla digits. Returns 01XXXXXXXXX or null.
export function bdPhone(input) {
  let digits = asciiDigits(input).replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (!/^\d+$/.test(digits)) return null;
  if (digits.startsWith('880')) digits = digits.slice(2);
  else if (digits.startsWith('88') && digits.length === 13) digits = digits.slice(2);
  return /^01[3-9]\d{8}$/.test(digits) ? digits : null;
}

// Why a phone isn't valid, in words the shop understands (ORD-10, SR-09).
export function phoneProblem(input) {
  const digits = asciiDigits(input).replace(/\D/g, '').replace(/^880/, '0').replace(/^88(?=01)/, '');
  if (!digits) return 'Phone number is required';
  if (digits.length !== 11) return `Bangladeshi numbers have 11 digits — this one has ${digits.length}`;
  if (!/^01[3-9]/.test(digits)) return 'Bangladeshi mobile numbers start with 013 to 019';
  return null;
}

// ৳1,45,000 — Indian grouping.
export function taka(amount) {
  const n = Math.round(Number(amount) || 0);
  const s = String(Math.abs(n));
  const grouped = s.length <= 3 ? s : `${s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${s.slice(-3)}`;
  return `${n < 0 ? '-' : ''}৳${grouped}`;
}

// Start of "today" in Asia/Dhaka (UTC+6, no daylight saving) as a UTC Date.
// First moment of the current month in Dhaka time.
export function dhakaMonthStart(now = new Date()) {
  const d = dhakaDayStart(now);
  const dhaka = new Date(d.getTime() + 6 * 3_600_000);
  return dhakaDayStart(now, -(dhaka.getUTCDate() - 1));
}

export function dhakaDayStart(date = new Date(), offsetDays = 0) {
  const shifted = new Date(date.getTime() + 6 * 3_600_000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - 6 * 3_600_000 + offsetDays * 86_400_000);
}

export const dhakaHour = (date) => (new Date(date).getUTCHours() + 6) % 24;
// 0 = Sunday … 6 = Saturday, in Dhaka.
export const dhakaWeekday = (date) => new Date(new Date(date).getTime() + 6 * 3_600_000).getUTCDay();

// Records a change for the audit log (TEAM-06). Never throws: logging must not break the action.
export async function audit(db, user, action, { target = '', where = '' } = {}) {
  try {
    await db.insert(db.audit, {
      workspace_id: user.workspace_id, user_id: user.id ?? null, actor: user.name ?? 'System', action, target, where,
    });
  } catch (err) {
    console.warn('audit log failed:', err.message);
  }
}

export const clampInt = (v, min, max, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function csv(rows) {
  const cell = (v) => {
    const s = v instanceof Date ? v.toISOString() : String(v ?? '');
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\n');
}

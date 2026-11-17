import { createContext, useContext } from 'react';
import en from '../strings/en.js';
import bn from '../strings/bn.js';

// Every dashboard string goes through t(). Bangla falls back to English for a key that has no translation yet
// (tests check that the Bangla file covers every English key).
export const DICTS = { en, bn };
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const TZ = 'Asia/Dhaka';

export const bnDigits = (s) => String(s).replace(/\d/g, (d) => BN_DIGITS[d]);

// 145000 → "1,45,000" (Indian grouping).
export function groupIndian(n, decimals = 0) {
  const neg = n < 0;
  const [int, frac] = Math.abs(Number(n) || 0).toFixed(decimals).split('.');
  const grouped = int.length <= 3 ? int : `${int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${int.slice(-3)}`;
  return `${neg ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

export function makeT(lang) {
  const dict = DICTS[lang] ?? en;
  const digits = (s) => (lang === 'bn' ? bnDigits(s) : String(s));
  const t = (key, vars) => {
    let s = dict[key] ?? en[key] ?? key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (_m, k) => (vars[k] === undefined ? `{${k}}` : (typeof vars[k] === 'number' ? digits(vars[k]) : vars[k])));
    return s;
  };
  t.lang = lang;
  t.digits = digits;
  t.num = (n, decimals = 0) => digits(groupIndian(n, decimals));
  // ৳1,45,000 — decimals only when the amount has paisa (or when asked).
  t.money = (n, decimals) => {
    const d = decimals ?? (Math.round(Number(n) * 100) % 100 ? 2 : 0);
    return `৳${digits(groupIndian(n, d))}`;
  };
  t.pct = (n) => `${digits(Math.round(n))}%`;
  const locale = lang === 'bn' ? 'bn-BD' : 'en-GB';
  t.time = (iso) => (iso ? new Date(iso).toLocaleTimeString(lang === 'bn' ? 'bn-BD' : 'en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ }) : '');
  t.date = (iso, opts = { day: 'numeric', month: 'short' }) => (iso ? new Date(iso).toLocaleDateString(locale, { ...opts, timeZone: TZ }) : '');
  t.dateTime = (iso) => (iso ? `${t.date(iso)}, ${t.time(iso)}` : '');
  t.longDate = (iso = new Date()) => new Date(iso).toLocaleDateString(lang === 'bn' ? 'bn-BD' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ });
  // "4m", "2h", "Yesterday", "Nov 12" — for lists.
  t.ago = (iso) => {
    if (!iso) return '';
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
    if (mins < 1) return t('time.now');
    if (mins < 60) return t('time.m', { n: mins });
    const hours = Math.round(mins / 60);
    if (hours < 24) return t('time.h', { n: hours });
    if (hours < 48) return t('time.yesterday');
    const days = Math.round(hours / 24);
    if (days < 7) return t('time.d', { n: days });
    return t.date(iso);
  };
  // "4 min ago" — for activity feeds.
  t.agoLong = (iso) => {
    if (!iso) return '';
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
    if (mins < 1) return t('time.justNow');
    if (mins < 60) return t('time.minAgo', { n: mins });
    const hours = Math.round(mins / 60);
    if (hours < 24) return t('time.hAgo', { n: hours });
    return t.dateTime(iso);
  };
  return t;
}

export const I18n = createContext(makeT('en'));
export const useT = () => useContext(I18n);

// Greeting by the hour in Dhaka.
export function greetingKey(date = new Date()) {
  const h = (date.getUTCHours() + 6) % 24;
  return h < 12 ? 'greet.morning' : h < 17 ? 'greet.afternoon' : 'greet.evening';
}

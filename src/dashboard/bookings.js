import { randomBytes } from 'node:crypto';
import { InboxError } from '../inbox.js';
import { bdPhone, phoneProblem } from './util.js';

// BKG-01..04 · Bookings (services) and quotes, frames "Bookings calendar" and "Quotes".
// Times are stored in UTC and worked out in Dhaka time (UTC+6, no daylight saving).

const DHAKA_MS = 6 * 3_600_000;
const MIN = 60_000;
const DAY_NAMES_BN = ['রবি', 'সোম', 'মঙ্গল', 'বুধ', 'বৃহঃ', 'শুক্র', 'শনি'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
const hhmm = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
const taka = (n) => `৳${Number(n).toLocaleString('en-IN')}`;
export const ACTIVE = ['pending', 'confirmed'];

export function bookingSettings(ws) {
  const s = ws?.settings?.bookings ?? {};
  return {
    slotMin: [15, 20, 30, 45, 60].includes(s.slot_min) ? s.slot_min : 30,
    open: /^\d{2}:\d{2}$/.test(s.open ?? '') ? s.open : '11:00',
    close: /^\d{2}:\d{2}$/.test(s.close ?? '') ? s.close : '20:00',
    closedDays: Array.isArray(s.closed_days) ? s.closed_days.filter((d) => d >= 0 && d <= 6) : [5],
    capacity: Math.max(1, Math.min(20, Number(s.capacity) || 1)),
    reminder: s.reminder !== false,
    services: (s.services ?? []).filter((x) => x?.id && x?.name).map((x) => ({ id: String(x.id), name: String(x.name), minutes: Math.max(10, Math.min(480, Number(x.minutes) || 30)), price: Math.max(0, Number(x.price) || 0), advance: Math.max(0, Number(x.advance) || 0) })),
  };
}

// Cleans what the owner saves in "Booking settings".
export function cleanBookingSettings(body, old = {}) {
  const b = body ?? {};
  if (b.open && b.close && toMin(b.close) <= toMin(b.open)) throw new InboxError(400, 'Closing time must be after opening time');
  const services = (Array.isArray(b.services) ? b.services : []).slice(0, 30).map((x) => {
    const name = String(x?.name ?? '').trim().slice(0, 60);
    if (!name) throw new InboxError(400, 'Every service needs a name');
    return { id: String(x.id || randomBytes(4).toString('hex')), name, minutes: Math.max(10, Math.min(480, Math.round(Number(x.minutes) || 30))), price: Math.max(0, Math.round(Number(x.price) || 0)), advance: Math.max(0, Math.round(Number(x.advance) || 0)) };
  });
  for (const s of services) if (s.advance > s.price && s.price > 0) throw new InboxError(400, `The advance for ${s.name} can't be more than its price`);
  return {
    ...old,
    slot_min: [15, 20, 30, 45, 60].includes(Number(b.slotMin)) ? Number(b.slotMin) : 30,
    open: /^\d{2}:\d{2}$/.test(b.open ?? '') ? b.open : '11:00',
    close: /^\d{2}:\d{2}$/.test(b.close ?? '') ? b.close : '20:00',
    closed_days: (Array.isArray(b.closedDays) ? b.closedDays : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
    capacity: Math.max(1, Math.min(20, Math.round(Number(b.capacity) || 1))),
    reminder: b.reminder !== false,
    services,
  };
}

// "2026-11-17" + "15:00" (Dhaka) → Date (UTC).
export function dhakaTime(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !/^\d{1,2}:\d{2}$/.test(String(time))) return null;
  const [y, m, d] = date.split('-').map(Number);
  const t = toMin(time);
  const at = new Date(Date.UTC(y, m - 1, d) + t * MIN - DHAKA_MS);
  return Number.isNaN(at.getTime()) ? null : at;
}
// Date → { date: "2026-11-17", time: "15:00", day: 0-6 } in Dhaka.
export function dhakaParts(at) {
  const l = new Date(new Date(at).getTime() + DHAKA_MS);
  return { date: l.toISOString().slice(0, 10), time: hhmm(l.getUTCHours() * 60 + l.getUTCMinutes()), day: l.getUTCDay(), mins: l.getUTCHours() * 60 + l.getUTCMinutes() };
}

// Free start times on one Dhaka day for a service, given the bookings already made.
export function freeSlots(settings, date, minutes, bookings, now = new Date()) {
  const dayStart = dhakaTime(date, '00:00');
  if (!dayStart) return [];
  if (settings.closedDays.includes(dhakaParts(dayStart).day)) return [];
  const out = [];
  const open = toMin(settings.open);
  const close = toMin(settings.close);
  for (let t = open; t + minutes <= close; t += settings.slotMin) {
    const start = new Date(dayStart.getTime() + t * MIN);
    if (start <= new Date(now.getTime() + 30 * MIN)) continue; // not in the past, and not in the next half hour
    const end = new Date(start.getTime() + minutes * MIN);
    const overlapping = bookings.filter((b) => ACTIVE.includes(b.status) && b.starts_at < end && b.ends_at > start).length;
    if (overlapping < settings.capacity) out.push(hhmm(t));
  }
  return out;
}

// The next `days` days of free slots per service, for the AI and the "+ Booking" dialog.
export async function availability(db, ws, { days = 7, now = new Date(), serviceId = null } = {}) {
  const settings = bookingSettings(ws);
  const from = dhakaTime(dhakaParts(now).date, '00:00');
  const to = new Date(from.getTime() + days * 86_400_000);
  const bookings = await db.bookings.find({ workspace_id: ws._id, status: { $in: ACTIVE }, starts_at: { $lt: to }, ends_at: { $gt: from } }, { starts_at: 1, ends_at: 1, status: 1 }).lean();
  const list = [];
  for (const s of settings.services.filter((x) => !serviceId || x.id === serviceId)) {
    const byDay = [];
    for (let i = 0; i < days; i++) {
      const date = dhakaParts(new Date(from.getTime() + i * 86_400_000 + 12 * 3_600_000)).date;
      byDay.push({ date, times: freeSlots(settings, date, s.minutes, bookings, now) });
    }
    list.push({ service: s, days: byDay });
  }
  return { settings, list };
}

export function availabilityContext({ settings, list }) {
  if (!list.length) return '';
  const day = (date) => { const p = dhakaParts(dhakaTime(date, '12:00')); return `${DAY_NAMES[p.day]} ${date}`; };
  const lines = ['## Bookings (appointments)', `Open ${settings.open}–${settings.close}${settings.closedDays.length ? `, closed on ${settings.closedDays.map((d) => DAY_NAMES[d]).join(', ')}` : ''}. Free start times (Dhaka time) for the next days:`];
  for (const { service: s, days } of list) {
    lines.push(`- ${s.name} (service id "${s.id}", ${s.minutes} min${s.price ? `, ${taka(s.price)}` : ''}${s.advance ? `, ${taka(s.advance)} bKash advance needed to confirm` : ''}):`);
    for (const d of days) lines.push(`  ${day(d.date)}: ${d.times.length ? d.times.join(', ') : 'full or closed'}`);
  }
  lines.push('Offer only these times. When the customer has picked a service, a day and a time and given their name and phone, fill "booking" with ready=true.');
  return lines.join('\n');
}

// BKG-01: makes a booking after checking the day, the hours and that the slot is still free.
export async function createBooking(db, ws, { serviceId, date, time, name, phone, note = '', source = 'team', userId = null, conversation = null, customerId = null, trxId = '', now = new Date() }) {
  const settings = bookingSettings(ws);
  const service = settings.services.find((s) => s.id === String(serviceId));
  if (!service) throw new InboxError(400, 'Pick a service');
  const problem = phoneProblem(phone);
  if (problem) throw new InboxError(400, problem);
  const cleanName = String(name ?? '').trim().slice(0, 80);
  if (!cleanName) throw new InboxError(400, "Write the customer's name");
  const start = dhakaTime(date, time);
  if (!start) throw new InboxError(400, 'Pick a day and a time');
  const free = await freeSlotsAt(db, ws, settings, date, service.minutes, now);
  if (!free.includes(dhakaParts(start).time)) throw new InboxError(409, `${time} on ${date} isn't free for ${service.name}. Pick another time`);
  let customer = customerId ? await db.customers.findById(customerId).lean() : null;
  const p = bdPhone(phone);
  customer ??= await db.customers.findOne({ workspace_id: ws._id, phones: p }).lean();
  if (!customer) customer = { _id: (await db.insert(db.customers, { workspace_id: ws._id, name: cleanName, phones: [p] })).id };
  else await db.customers.updateOne({ _id: customer._id }, { $addToSet: { phones: p } });
  const trx = String(trxId ?? '').trim().toUpperCase().slice(0, 20);
  const status = service.advance && !trx ? 'pending' : 'confirmed';
  const created = await db.insert(db.bookings, {
    workspace_id: ws._id, customer_id: customer._id, conversation_id: conversation?._id ?? conversation?.id ?? null, name: cleanName, phone: p,
    service_id: service.id, service: service.name, starts_at: start, ends_at: new Date(start.getTime() + service.minutes * MIN), status, price: service.price,
    advance: service.advance ? { amount: service.advance, trx_id: trx, method: 'bkash', verified: Boolean(trx) && source === 'team' } : null,
    note: String(note ?? '').slice(0, 500), source, by_user_id: userId,
  });
  return db.bookings.findById(created.id).lean();
}

async function freeSlotsAt(db, ws, settings, date, minutes, now, excludeId = null) {
  const from = dhakaTime(date, '00:00');
  const to = new Date(from.getTime() + 86_400_000);
  const bookings = await db.bookings.find({ workspace_id: ws._id, status: { $in: ACTIVE }, starts_at: { $lt: to }, ends_at: { $gt: from }, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }, { starts_at: 1, ends_at: 1, status: 1 }).lean();
  return freeSlots(settings, date, minutes, bookings, now);
}

// Moves a booking to another free time.
export async function rescheduleBooking(db, ws, booking, { date, time, now = new Date() }) {
  const settings = bookingSettings(ws);
  const minutes = Math.round((booking.ends_at - booking.starts_at) / MIN);
  const start = dhakaTime(date, time);
  if (!start) throw new InboxError(400, 'Pick a day and a time');
  // Its own slot doesn't count against it.
  const free = await freeSlotsAt(db, ws, settings, date, minutes, now, booking._id);
  if (!free.includes(dhakaParts(start).time)) throw new InboxError(409, `${time} on ${date} isn't free. Pick another time`);
  await db.bookings.updateOne({ _id: booking._id }, { $set: { starts_at: start, ends_at: new Date(start.getTime() + minutes * MIN), reminder_sent_at: null, reminder_failed: '' } });
  return db.bookings.findById(booking._id).lean();
}

// What the customer is told (Bangla).
export function whenBn(at) {
  const p = dhakaParts(at);
  const [h, m] = p.time.split(':').map(Number);
  const part = h < 12 ? 'সকাল' : h < 16 ? 'দুপুর' : h < 18 ? 'বিকাল' : 'সন্ধ্যা';
  const h12 = ((h + 11) % 12) + 1;
  return `${DAY_NAMES_BN[p.day]}বার ${Number(p.date.slice(8))}/${Number(p.date.slice(5, 7))}, ${part} ${h12}${m ? `:${String(m).padStart(2, '0')}` : ''}টায়`;
}

export function confirmationText(b, ws) {
  const pay = ws.bkash_number || ws.nagad_number;
  if (b.status === 'pending' && b.advance?.amount) {
    return `✅ ${b.service} — ${whenBn(b.starts_at)} সময়টা আপনার জন্য রাখা হলো। কনফার্ম করতে ${taka(b.advance.amount)} অগ্রিম ${pay ? `${ws.bkash_number ? 'বিকাশ' : 'নগদ'} ${pay} নম্বরে Send Money করে ` : ''}TrxID পাঠান।`;
  }
  return `✅ বুকিং কনফার্ম: ${b.service} — ${whenBn(b.starts_at)}। আগের দিন মনে করিয়ে দেব। আসতে না পারলে জানাবেন।`;
}

export const reminderText = (b) => `⏰ মনে করিয়ে দিচ্ছি: আগামীকাল ${whenBn(b.starts_at)} আপনার ${b.service} বুকিং আছে। আসতে না পারলে আগে জানাবেন 🙏`;

// BKG-03: the day-before reminder, sent once, 20–28 hours before the booking.
export async function sendBookingReminders(db, inbox, { now = new Date() } = {}) {
  const out = { sent: 0, failed: 0 };
  const due = await db.bookings.find({ status: { $in: ACTIVE }, reminder_sent_at: null, reminder_failed: '', starts_at: { $gt: new Date(now.getTime() + 2 * 3_600_000), $lte: new Date(now.getTime() + 28 * 3_600_000) } }).lean();
  const wsCache = new Map();
  for (const b of due) {
    if (!wsCache.has(b.workspace_id)) wsCache.set(b.workspace_id, bookingSettings(await db.workspaces.findById(b.workspace_id, { settings: 1 }).lean()));
    if (!wsCache.get(b.workspace_id).reminder) continue;
    // Only "tomorrow" in Dhaka time.
    if (dhakaParts(b.starts_at).date === dhakaParts(now).date) continue;
    const msg = b.conversation_id ? await inbox.eventUpdate(b.conversation_id, reminderText(b)).catch(() => null) : null;
    if (msg) {
      await db.bookings.updateOne({ _id: b._id }, { $set: { reminder_sent_at: now } });
      out.sent += 1;
    } else {
      await db.bookings.updateOne({ _id: b._id }, { $set: { reminder_failed: b.conversation_id ? "Meta's reply window had closed — call the customer" : 'No chat for this customer — call them' } });
      out.failed += 1;
    }
  }
  return out;
}

export function startBookingReminders(db, inbox, { everyMs = 10 * 60_000 } = {}) {
  const timer = setInterval(() => sendBookingReminders(db, inbox).catch((err) => console.warn('booking reminders failed:', err.message)), everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

// BKG-04: the quote card the customer accepts or declines in chat.
export function quoteCard(q, ws) {
  const pay = ws.bkash_number || ws.nagad_number;
  const lines = [
    `🧾 কোটেশন Q-${q.number}: ${q.title}`,
    `দাম: ${taka(q.price)}`,
    ...(q.advance ? [`অগ্রিম: ${taka(q.advance)}${pay ? ` (${ws.bkash_number ? 'বিকাশ' : 'নগদ'} ${pay})` : ''}`] : []),
    ...(q.valid_until ? [`${Number(dhakaParts(q.valid_until).date.slice(8))}/${Number(dhakaParts(q.valid_until).date.slice(5, 7))} পর্যন্ত বহাল`] : []),
  ];
  return {
    kind: 'quote',
    payload: { quoteId: q._id, number: q.number, title: q.title, price: q.price, advance: q.advance, status: q.status,
      buttons: [{ type: 'postback', title: 'রাজি, এগোন', value: `HQ:QACCEPT:${q._id}` }, { type: 'postback', title: 'না, ধন্যবাদ', value: `HQ:QDECLINE:${q._id}` }] },
    text: lines.join('\n'),
  };
}

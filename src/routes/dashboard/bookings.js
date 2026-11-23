import { Router } from 'express';
import { InboxError } from '../../inbox.js';
import { need } from '../../dashboard/permissions.js';
import { audit } from '../../dashboard/util.js';
import { modulesFor } from '../../dashboard/settings.js';
import { bookingSettings, cleanBookingSettings, availability, createBooking, rescheduleBooking, dhakaParts, dhakaTime, whenBn, quoteCard } from '../../dashboard/bookings.js';

const DAY = 86_400_000;

// BKG-01..04 · Bookings calendar and Quotes (frames "Bookings calendar" and "Quotes").
export function bookingRoutes(db, config, { auth, inbox, notify, emit = () => {} }) {
  const router = Router();
  const ws = async (req) => db.workspaces.findById(req.user.workspace_id).lean();
  const view = (b) => ({
    id: b._id, name: b.name, phone: b.phone, customerId: b.customer_id, conversationId: b.conversation_id, serviceId: b.service_id, service: b.service,
    start: b.starts_at, end: b.ends_at, date: dhakaParts(b.starts_at).date, time: dhakaParts(b.starts_at).time, endTime: dhakaParts(b.ends_at).time,
    status: b.status, price: b.price, advance: b.advance, note: b.note, source: b.source, platform: b.platform,
    confirmationSentAt: b.confirmation_sent_at, reminderSentAt: b.reminder_sent_at, reminderFailed: b.reminder_failed,
  });
  const quoteView = (q) => ({ id: q._id, number: q.number, title: q.title, details: q.details, photos: q.photos, name: q.name, customerId: q.customer_id, conversationId: q.conversation_id,
    price: q.price, advance: q.advance, validUntil: q.valid_until, status: q.status, sentAt: q.sent_at, answeredAt: q.answered_at, createdAt: q.created_at });
  const load = async (req) => {
    const b = await db.bookings.findOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id }).lean();
    if (!b) throw new InboxError(404, 'Booking not found');
    return b;
  };

  // The week (Monday first) with its bookings, the settings line and the counts on the tabs.
  router.get('/bookings', auth, async (req, res) => {
    const w = await ws(req);
    const today = dhakaParts(new Date()).date;
    const anchor = dhakaTime(/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.week ?? '')) ? req.query.week : today, '12:00');
    const back = (dhakaParts(anchor).day + 6) % 7; // days since Monday
    const monday = dhakaParts(new Date(anchor.getTime() - back * DAY)).date;
    const from = dhakaTime(monday, '00:00');
    const to = new Date(from.getTime() + 7 * DAY);
    const [list, waiting] = await Promise.all([
      db.bookings.find({ workspace_id: w._id, starts_at: { $gte: from, $lt: to }, status: { $ne: 'cancelled' } }).sort({ starts_at: 1 }).lean(),
      db.quotes.countDocuments({ workspace_id: w._id, status: 'waiting' }),
    ]);
    const m = modulesFor(w);
    res.json({
      settings: bookingSettings(w), today, week: Array.from({ length: 7 }, (_, i) => dhakaParts(new Date(from.getTime() + i * DAY + 12 * 3_600_000)).date),
      bookings: list.map(view), counts: { week: list.length, quotesWaiting: waiting }, modules: { bookings: m.bookings !== false, quotes: m.quotes !== false },
    });
  });

  router.get('/bookings/slots', auth, async (req, res) => {
    const w = await ws(req);
    const { list, settings } = await availability(db, w, { days: 14, serviceId: String(req.query.serviceId ?? '') });
    const day = list[0]?.days.find((d) => d.date === req.query.date);
    res.json({ times: day?.times ?? [], days: (list[0]?.days ?? []).map((d) => ({ date: d.date, free: d.times.length, closed: settings.closedDays.includes(dhakaParts(dhakaTime(d.date, '12:00')).day) })) });
  });

  router.post('/bookings', auth, need(db, 'reply'), async (req, res) => {
    const w = await ws(req);
    const b = req.body ?? {};
    const booking = await createBooking(db, w, { serviceId: b.serviceId, date: b.date, time: b.time, name: b.name, phone: b.phone, note: b.note, trxId: b.trxId, source: 'team', userId: req.user.id });
    await audit(db, req.user, `Booked ${booking.service} for ${booking.name} on ${booking.starts_at.toISOString().slice(0, 16)}`, { where: 'Bookings' });
    emit(w._id, 'booking', { id: booking._id });
    res.status(201).json(view(booking));
  });

  // Arrived, no-show, cancel, or "advance received" (pending → confirmed).
  router.post('/bookings/:id/status', auth, need(db, 'reply'), async (req, res) => {
    const b = await load(req);
    const to = String(req.body?.status ?? '');
    if (!['confirmed', 'arrived', 'no_show', 'cancelled'].includes(to)) throw new InboxError(400, 'Unknown status');
    if (['cancelled', 'no_show', 'arrived'].includes(b.status) && to !== 'confirmed') throw new InboxError(409, 'This booking is already closed');
    const set = { status: to };
    if (to === 'confirmed' && b.advance) set.advance = { ...b.advance, verified: true };
    await db.bookings.updateOne({ _id: b._id }, { $set: set });
    if (to === 'confirmed' && b.status === 'pending' && b.conversation_id) {
      await inbox.sendAiReply(b.conversation_id, `✅ অগ্রিম পেয়েছি, ধন্যবাদ! ${b.service} — ${whenBn(b.starts_at)} বুকিং কনফার্ম।`).catch(() => null);
    }
    if (to === 'cancelled' && b.conversation_id && req.body?.tell !== false) {
      await inbox.sendAiReply(b.conversation_id, `দুঃখিত, ${whenBn(b.starts_at)} আপনার ${b.service} বুকিংটি বাতিল করা হয়েছে। নতুন সময় চাইলে জানাবেন।`).catch(() => null);
    }
    await audit(db, req.user, `Booking #${b._id} (${b.name}) → ${to.replace('_', ' ')}`, { where: 'Bookings' });
    emit(b.workspace_id, 'booking', { id: b._id });
    res.json(view(await db.bookings.findById(b._id).lean()));
  });

  router.post('/bookings/:id/reschedule', auth, need(db, 'reply'), async (req, res) => {
    const b = await load(req);
    if (!['pending', 'confirmed'].includes(b.status)) throw new InboxError(409, 'Only upcoming bookings can be moved');
    const moved = await rescheduleBooking(db, await ws(req), b, { date: req.body?.date, time: req.body?.time });
    if (moved.conversation_id) await inbox.sendAiReply(moved.conversation_id, `🔁 আপনার ${moved.service} বুকিং নতুন সময়ে: ${whenBn(moved.starts_at)}। সমস্যা হলে জানাবেন।`).catch(() => null);
    await audit(db, req.user, `Moved booking #${b._id} (${b.name})`, { where: 'Bookings' });
    emit(b.workspace_id, 'booking', { id: b._id });
    res.json(view(moved));
  });

  router.get('/settings/bookings', auth, async (req, res) => res.json(bookingSettings(await ws(req))));
  router.put('/settings/bookings', auth, need(db, 'edit_products'), async (req, res) => {
    const w = await ws(req);
    const next = cleanBookingSettings(req.body, w.settings?.bookings ?? {});
    await db.workspaces.updateOne({ _id: w._id }, { $set: { 'settings.bookings': next } });
    await audit(db, req.user, 'Changed booking settings', { where: 'Bookings' });
    res.json(bookingSettings({ settings: { bookings: next } }));
  });

  // BKG-04 · Quotes: requests the AI collected; the shop sets the price and sends the card.
  router.get('/quotes', auth, async (req, res) => {
    const list = await db.quotes.find({ workspace_id: req.user.workspace_id }).sort({ status: 1, created_at: -1 }).limit(200).lean();
    const order = { waiting: 0, sent: 1, accepted: 2, declined: 3, expired: 4 };
    res.json(list.sort((a, b) => order[a.status] - order[b.status] || b.created_at - a.created_at).map(quoteView));
  });

  router.post('/quotes/:id/send', auth, need(db, 'reply'), async (req, res) => {
    const q = await db.quotes.findOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id }).lean();
    if (!q) throw new InboxError(404, 'Quote not found');
    if (['accepted', 'declined'].includes(q.status)) throw new InboxError(409, 'The customer already answered this quote');
    const price = Math.round(Number(req.body?.price));
    const advance = Math.max(0, Math.round(Number(req.body?.advance) || 0));
    if (!Number.isFinite(price) || price <= 0) throw new InboxError(400, 'Set the price');
    if (advance > price) throw new InboxError(400, "The advance can't be more than the price");
    const days = Math.max(1, Math.min(30, Math.round(Number(req.body?.validDays) || 7)));
    if (!q.conversation_id) throw new InboxError(400, 'This quote has no chat to send it to');
    const w = await ws(req);
    const next = { ...q, price, advance, valid_until: new Date(Date.now() + days * DAY), status: 'sent' };
    await inbox.sendRich(req.user, q.conversation_id, quoteCard(next, w));
    await db.quotes.updateOne({ _id: q._id }, { $set: { price, advance, valid_until: next.valid_until, status: 'sent', sent_at: new Date() } });
    await audit(db, req.user, `Sent quote Q-${q.number} (৳${price}) to ${q.name}`, { where: 'Quotes' });
    res.json(quoteView(await db.quotes.findById(q._id).lean()));
  });

  return router;
}

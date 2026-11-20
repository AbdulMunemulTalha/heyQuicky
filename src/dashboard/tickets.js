// Support tickets (TKT-01/02): complaints, refunds, damaged or late parcels, each with an owner,
// a status, a resolution and a timeline. ACT NOW chats open one automatically.
export const TICKET_TYPES = ['complaint', 'refund', 'exchange', 'damaged', 'late', 'other'];
export const TICKET_STATUSES = ['open', 'waiting', 'solved'];
export const RESOLUTIONS = ['refunded', 'refund_bkash', 'refund_nagad', 'store_credit', 'exchanged', 'replaced', 'right_item', 'resent', 'courier', 'explained', 'other'];
// The resolutions offered for each kind of ticket (frame TKT-01/02 "Resolution" chips).
export const RESOLUTIONS_FOR = {
  exchange: ['right_item', 'exchanged', 'refund_bkash', 'store_credit'],
  refund: ['refund_bkash', 'refund_nagad', 'store_credit', 'exchanged'],
  damaged: ['replaced', 'refund_bkash', 'store_credit'],
  late: ['resent', 'courier', 'refund_bkash'],
  complaint: ['explained', 'exchanged', 'refund_bkash', 'store_credit'],
  other: ['explained', 'refund_bkash', 'store_credit'],
};
// How long before an open ticket counts as overdue.
export const DUE_HOURS = { act_now: 1, normal: 24 };

// Picks the ticket type from the AI's (English) reason.
export function guessType(text = '') {
  const s = String(text).toLowerCase();
  if (/refund|money back|taka ferot|টাকা ফেরত/.test(s)) return 'refund';
  if (/damag|broken|torn|chera|ছেঁড়া|ভাঙা/.test(s)) return 'damaged';
  if (/exchange|wrong (item|size|colour|color|product)|bodol|বদল/.test(s)) return 'exchange';
  if (/late|not (yet )?(arrived|received|delivered)|where is|delay|pai nai|পাইনি/.test(s)) return 'late';
  if (/complain|angry|rude|bad review|scam|fraud/.test(s)) return 'complaint';
  return 'other';
}

export function dueAt(ticket) {
  const h = ticket.act_now ? DUE_HOURS.act_now : DUE_HOURS.normal;
  return new Date(new Date(ticket.created_at ?? Date.now()).getTime() + h * 3_600_000);
}

export const timelineEntry = (type, text, by = '', extra = {}) => ({ type, text, by, at: new Date(), ...extra });

// Opens a ticket for a chat, or adds to the one already open for it (one open ticket per chat).
// Calls for the same chat run one after another, so two flags at once can't open two tickets.
const chains = new Map();
export function openTicket(db, args) {
  if (!args.conversationId) return createOrAdd(db, args);
  const key = `${args.workspaceId}:${args.conversationId}`;
  const run = (chains.get(key) ?? Promise.resolve()).catch(() => {}).then(() => createOrAdd(db, args));
  chains.set(key, run);
  run.finally(() => { if (chains.get(key) === run) chains.delete(key); }).catch(() => {});
  return run;
}

async function createOrAdd(db, { workspaceId, conversationId = null, customerId = null, orderId = null, title, type, actNow = false, reason = '', by = 'AI', ownerId = null, notify = null }) {
  if (conversationId) {
    const existing = await db.tickets.findOne({ workspace_id: workspaceId, conversation_id: conversationId, status: { $ne: 'solved' } }).lean();
    if (existing) {
      await db.tickets.updateOne({ _id: existing._id }, {
        $set: actNow ? { act_now: true } : {},
        $push: { timeline: timelineEntry('flag', reason || title, by) },
      });
      return { ticket: { ...existing, act_now: existing.act_now || actNow }, created: false };
    }
  }
  const ws = await db.workspaces.findOneAndUpdate({ _id: workspaceId }, { $inc: { ticket_seq: 1 } }, { new: true, lean: true });
  const ticket = await db.insert(db.tickets, {
    workspace_id: workspaceId, number: ws.ticket_seq, conversation_id: conversationId, customer_id: customerId, order_id: orderId,
    title: String(title).slice(0, 160), type: TICKET_TYPES.includes(type) ? type : guessType(`${title} ${reason}`), act_now: Boolean(actNow),
    reason: String(reason).slice(0, 300), owner_user_id: ownerId, status: 'open',
    timeline: [timelineEntry('opened', reason || title, by)],
  });
  if (notify) {
    await notify({ workspaceId, event: 'escalation', title: `${actNow ? 'ACT NOW · ' : ''}Ticket #${ticket.number}: ${String(title).slice(0, 80)}`,
      body: String(reason || 'A customer needs help').slice(0, 200), link: `/tickets/${ticket.number}`, ref: `ticket:${ticket.id}` }).catch(() => {});
  }
  return { ticket: { ...ticket, _id: ticket.id }, created: true };
}

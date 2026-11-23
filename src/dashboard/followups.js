import { grantOffer, dhakaMidnight } from './offers.js';
// Smart follow-ups (FUP-01) and lead capture (FUP-03).
//
// A chat is watched when the shop answered (AI or team) and the customer went quiet. The AI reads
// what the customer asked: delivery, address, quantity or size → hot; only the price → warm;
// "no", "thanks" or similar → skip. Hot chats get reminders at 3 h and 20 h, warm chats one at 20 h,
// never more than 2, always inside Meta's 24-hour window, and never in chats a teammate owns.

const HOT = /(delivery|ডেলিভারি|deliver|address|ঠিকানা|কয়টা|koyta|pcs|পিস|order|অর্ডার|size|সাইজ|bkash|বিকাশ|kobe|কবে|cod)/i;
const WARM = /(price|dam|দাম|koto|কত|rate|কেমন|available|ache|আছে)/i;
const STOP = /(\bno\b|\bna\b|lagbe na|লাগবে না|nibo na|নিবো না|thanks|thank you|ধন্যবাদ|\bok\b|okay|পরে জানাব|pore janabo)\W*$/i;
const HOUR = 3_600_000;
export const FOLLOWUP_OFFER_PCT = 10;
export const WINDOW_MS = 24 * HOUR;

export function temperature(customerTexts) {
  const last = customerTexts.at(-1) ?? '';
  if (STOP.test(last.trim())) return 'skip';
  const all = customerTexts.join(' ');
  if (HOT.test(all)) return 'hot';
  if (WARM.test(all)) return 'warm';
  return 'skip';
}

// When each reminder is due, counted from the shop's last reply.
export function schedule(temp, lastReplyAt) {
  const t = new Date(lastReplyAt).getTime();
  if (temp === 'hot') return [new Date(t + 3 * HOUR), new Date(t + 20 * HOUR)];
  if (temp === 'warm') return [new Date(t + 20 * HOUR)];
  return [];
}

export function reminderText(step, { withOffer = false, product = '' } = {}) {
  if (step === 1) return `আপু, ${product ? `${product} টা` : 'প্রোডাক্টটা'} কি নেবেন? চাইলে এখনই অর্ডার কনফার্ম করে দিতে পারি 😊`;
  return withOffer
    ? `শেষবার মনে করিয়ে দিচ্ছি 🙂 আজ রাত ১২টার মধ্যে অর্ডার করলে ১০% ছাড় পাবেন! 🎁 অর্ডার করবেন?`
    : `আপু, ${product ? `${product}` : 'প্রোডাক্টটা'} এখনও স্টকে আছে। নিতে চাইলে জানাবেন, এখনই পাঠিয়ে দিতে পারি 😊`;
}

// Looks through open chats and keeps follow-ups and leads up to date; sends reminders that are due.
// Returns what it did, for logs and tests. inbox.sendAiReply respects Meta's window and DRY_RUN.
export async function runFollowups(db, inbox, { now = new Date(), send = true } = {}) {
  const out = { watched: 0, sent: 0, skipped: 0, replied: 0, ordered: 0 };
  const since = new Date(now.getTime() - WINDOW_MS);
  const workspaces = await db.workspaces.find({ ai_mode: 'auto' }, { settings: 1, went_live_at: 1 }).lean();
  for (const ws of workspaces) {
    if (ws.settings?.followup?.enabled === false) continue;
    const withOffer = Boolean(ws.settings?.followup?.offer);
    const convs = await db.conversations.find({ workspace_id: ws._id, status: 'open', spam: { $ne: true }, last_inbound_at: { $gte: since } }).lean();
    const products = await db.products.find({ workspace_id: ws._id, archived: { $ne: true } }, { name: 1, price: 1 }).lean();
    for (const conv of convs) {
      const last = await db.messages.find({ conversation_id: conv._id }).sort({ _id: -1 }).limit(12).lean();
      if (!last.length) continue;
      const existing = await db.followups.findOne({ conversation_id: conv._id, status: { $in: ['watching', 'sent'] } }).lean();
      // The customer wrote after we started watching: they replied.
      if (last[0].direction === 'in') {
        if (existing && existing.created_at < last[0].created_at) {
          await db.followups.updateOne({ _id: existing._id }, { $set: { status: 'replied' } });
          out.replied += 1;
        }
        continue;
      }
      const lastOut = last[0];
      const inTexts = last.filter((m) => m.direction === 'in').reverse().map((m) => m.text || '');
      const ordered = await db.orders.exists({ conversation_id: conv._id, created_at: { $gte: new Date(now.getTime() - WINDOW_MS) } });
      if (ordered) {
        if (existing) await db.followups.updateOne({ _id: existing._id }, { $set: { status: 'ordered' } });
        continue;
      }
      let temp = temperature(inTexts);
      let skip = '';
      if (temp === 'skip') skip = 'Said no, or only said thanks';
      if (conv.ai_handoff || conv.assigned_user_id && conv.last_replier === 'team') skip = 'A teammate is handling it';
      if (skip) temp = 'skip';
      const product = products.find((p) => last.some((m) => (m.text || '').toLowerCase().includes(p.name.toLowerCase())));
      // Leads: everyone who showed interest, with the product and when to follow up (FUP-03).
      if (temp !== 'skip' && conv.customer_id) {
        const customer = await db.customers.findById(conv.customer_id, { name: 1, phones: 1 }).lean();
        await db.prospects.updateOne({ workspace_id: ws._id, customer_id: conv.customer_id, stage: { $in: ['new', 'contacted', 'call_scheduled'] } }, {
          $set: { conversation_id: conv._id, name: customer?.name ?? '', phone: customer?.phones?.[0] ?? '', temp, last_seen_at: lastOut.created_at, ...(product ? { product: product.name, amount: product.price } : {}) },
          $setOnInsert: { workspace_id: ws._id, stage: 'new', created_at: now, _id: await db.nextId('prospects') },
          $inc: { times_asked: existing ? 0 : 1 },
        }, { upsert: true });
      }
      const due = schedule(temp, lastOut.created_at);
      if (!existing) {
        await db.insert(db.followups, {
          workspace_id: ws._id, conversation_id: conv._id, temp, step: 1, due_at: due[0] ?? lastOut.created_at,
          status: temp === 'skip' ? 'skipped' : 'watching', skip_reason: skip, with_offer: false,
        });
        if (temp === 'skip') out.skipped += 1; else out.watched += 1;
        continue;
      }
      out.watched += 1;
      if (temp === 'skip' || existing.status === 'skipped') continue;
      // Is the next reminder due, and still inside the 24-hour window?
      const sentCount = await db.messages.countDocuments({ conversation_id: conv._id, kind: 'followup', created_at: { $gte: existing.created_at } });
      const step = sentCount + 1;
      if (step > due.length) continue;
      if (now < due[step - 1]) continue;
      if (now - new Date(conv.last_inbound_at) >= WINDOW_MS - 10 * 60_000) continue;
      if (!send) continue;
      const isLast = step === due.length;
      // Only the second (last) reminder of a hot chat carries the offer; a single warm reminder never does.
      const offered = isLast && due.length > 1 && withOffer;
      const text = reminderText(isLast && due.length > 1 ? 2 : 1, { withOffer: offered, product: product?.name });
      const message = await inbox.sendAiReply(conv._id, text);
      if (message) {
        await db.messages.updateOne({ _id: message.id }, { $set: { kind: 'followup' } });
        await db.followups.updateOne({ _id: existing._id }, { $set: { status: 'sent', step, sent_at: now, with_offer: offered, due_at: due[step] ?? due[step - 1] } });
        if (offered && conv.customer_id) {
          await grantOffer(db, { workspaceId: ws._id, customerId: conv.customer_id, conversationId: conv._id, source: 'followup', sourceId: existing._id, kind: 'percent', value: FOLLOWUP_OFFER_PCT, endsAt: dhakaMidnight(now) });
        }
        await db.insert(db.aiReplies, { workspace_id: ws._id, conversation_id: conv._id, message_id: message.id, kind: 'followup', summary: 'Follow-up reminder', cost: 0 });
        out.sent += 1;
      }
    }
  }
  return out;
}

export function startFollowups(db, inbox, { everyMs = 5 * 60_000 } = {}) {
  const timer = setInterval(() => runFollowups(db, inbox).catch((err) => console.warn('follow-ups failed:', err.message)), everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

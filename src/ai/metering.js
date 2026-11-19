import { usageCost, toTaka } from './pricing.js';
import { dhakaMonthStart } from '../dashboard/util.js';
import { setting, DEFAULT_CAPS } from '../dashboard/settings.js';

// AI credit (BIL-01/02/03/06): every model call is priced from its real token usage, charged to the
// shop in taka (cost × USD_TO_BDT × (1 + AI_MARKUP_PCT%)), and recorded so Billing can list it.
// The AI pauses when credit runs out or this month's spend reaches the shop's cap.

// Whether the shop may spend on AI right now. Returns { ok } or { ok: false, reason: 'credit' | 'cap' }.
export async function canSpend(db, workspaceId, now = new Date(), { enforced = true } = {}) {
  if (!enforced) return { ok: true };
  const ws = await db.workspaces.findById(workspaceId, { credit_balance: 1, settings: 1 }).lean();
  if (!ws) return { ok: false, reason: 'credit' };
  if ((ws.credit_balance ?? 0) <= 0) return { ok: false, reason: 'credit' };
  const caps = { ...DEFAULT_CAPS, ...setting(ws, 'caps', {}) };
  if (caps.monthly) {
    const [m] = await db.aiReplies.aggregate([{ $match: { workspace_id: workspaceId, created_at: { $gte: dhakaMonthStart(now) } } }, { $group: { _id: null, cost: { $sum: '$cost' } } }]);
    if ((m?.cost ?? 0) >= caps.monthly) return { ok: false, reason: 'cap' };
  }
  return { ok: true };
}

// Records and charges one call. kind: reply | draft | practice | followup | comment.
// Charging may take the balance slightly below zero (one reply's worth); canSpend stops the next call.
export async function meter(db, config, { workspaceId, model, usage, kind = 'reply', conversationId = null, messageId = null, summary = '', customerName = '', notify = null }) {
  const priced = usageCost(model, usage);
  if (!priced) return null;
  const rate = { usdToBdt: config.ai?.usdToBdt ?? 122, markupPct: config.ai?.markupPct ?? 0 };
  const cost = toTaka(priced.usd, rate);
  const saved = toTaka(priced.savedUsd, { ...rate, markupPct: 0 });
  const entry = await db.insert(db.aiReplies, {
    workspace_id: workspaceId, conversation_id: conversationId, message_id: messageId, kind, model, cost, saved,
    cost_usd: priced.usd, input_tokens: priced.tokens.input, output_tokens: priced.tokens.output, cache_read_tokens: priced.tokens.cacheRead,
    cache_write_tokens: priced.tokens.cacheWrite, summary: summary.slice(0, 120), customer_name: customerName,
  });
  if (cost > 0 && config.ai?.creditEnforced) {
    const before = await db.workspaces.findOneAndUpdate({ _id: workspaceId }, { $inc: { credit_balance: -cost } }, { lean: true });
    const after = (before?.credit_balance ?? 0) - cost;
    await db.insert(db.credit, { workspace_id: workspaceId, type: 'ai_reply', amount: -cost, balance_after: after, ref: `ai_reply:${entry.id}` });
    // "Alert me below": tell the owner once when the balance crosses the line, and again at zero.
    const caps = { ...DEFAULT_CAPS, ...setting(before, 'caps', {}) };
    const was = before?.credit_balance ?? 0;
    if (notify && caps.alert_below && was > caps.alert_below && after <= caps.alert_below) {
      await notify({ workspaceId, event: 'credit', title: `AI credit is low: ৳${Math.max(0, after).toFixed(2)} left`, body: 'Top up so the AI keeps answering customers.', link: '/settings', ref: `lowcredit:${dhakaMonthStart().toISOString().slice(0, 7)}:${caps.alert_below}` });
    }
    if (notify && was > 0 && after <= 0) {
      await notify({ workspaceId, event: 'credit', title: 'AI credit finished — AI replies are paused', body: 'Your team can still reply. Top up and the AI starts again.', link: '/settings', ref: `nocredit:${Date.now()}` });
    }
  }
  return { cost, saved, usd: priced.usd };
}

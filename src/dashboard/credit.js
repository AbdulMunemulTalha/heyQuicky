// AI credit ledger. Every change goes through here so workspace.credit_balance and the ledger agree.

export async function addCredit(db, workspaceId, amount, { type = 'top_up', method = '', ref = '', status = 'done' } = {}) {
  const ws = await db.workspaces.findOneAndUpdate({ _id: workspaceId }, { $inc: { credit_balance: amount } }, { new: true, lean: true });
  return db.insert(db.credit, { workspace_id: workspaceId, type, amount, balance_after: ws.credit_balance, method, ref, status });
}

// Charges one AI reply. Returns false (and charges nothing) when there's no credit left,
// so the caller can stop the AI and fall back to saved replies (SR-10).
export async function chargeReply(db, workspaceId, cost, ref = '') {
  if (cost <= 0) return true;
  const ws = await db.workspaces.findOneAndUpdate(
    { _id: workspaceId, credit_balance: { $gte: cost } }, { $inc: { credit_balance: -cost } }, { new: true, lean: true });
  if (!ws) return false;
  await db.insert(db.credit, { workspace_id: workspaceId, type: 'ai_reply', amount: -cost, balance_after: ws.credit_balance, ref });
  return true;
}

// Average cost of an AI reply over the last 7 days, for "≈ 3,100 AI replies left".
export async function averageReplyCost(db, workspaceId) {
  const since = new Date(Date.now() - 7 * 86_400_000);
  const [agg] = await db.aiReplies.aggregate([
    { $match: { workspace_id: workspaceId, created_at: { $gte: since }, cost: { $gt: 0 } } },
    { $group: { _id: null, avg: { $avg: '$cost' }, n: { $sum: 1 } } },
  ]);
  return agg?.n ? agg.avg : Number(process.env.AI_REPLY_ESTIMATE || 0.133);
}

// Manual top-ups (BIL-05) until a payment gateway is connected: the owner sends bKash / Nagad to
// HeyQuicky's number and enters the TrxID; the entry stays pending (no credit yet) until an admin
// approves it with ADMIN_TOKEN. Nothing is ever credited without that approval.
export const TOPUP_MIN = 100;
export const TOPUP_MAX = 100_000;

export async function requestTopup(db, workspaceId, { amount, method, trxId }) {
  const ws = await db.workspaces.findById(workspaceId, { credit_balance: 1 }).lean();
  return db.insert(db.credit, { workspace_id: workspaceId, type: 'top_up', amount, balance_after: ws?.credit_balance ?? 0, method, ref: trxId, status: 'pending' });
}

export async function approveTopup(db, entryId) {
  const entry = await db.credit.findOneAndUpdate({ _id: entryId, type: 'top_up', status: 'pending' }, { $set: { status: 'approving' } }, { new: true, lean: true });
  if (!entry) return null;
  const ws = await db.workspaces.findOneAndUpdate({ _id: entry.workspace_id }, { $inc: { credit_balance: entry.amount } }, { new: true, lean: true });
  await db.credit.updateOne({ _id: entry._id }, { $set: { status: 'done', balance_after: ws.credit_balance } });
  return { ...entry, status: 'done', balance_after: ws.credit_balance };
}

export async function rejectTopup(db, entryId) {
  return db.credit.findOneAndUpdate({ _id: entryId, type: 'top_up', status: 'pending' }, { $set: { status: 'rejected' } }, { new: true, lean: true });
}

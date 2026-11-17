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

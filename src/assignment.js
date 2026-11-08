// Picks the on-duty moderator with the fewest open conversations. Ties go to
// whoever was assigned least recently (never-assigned first), so new customers
// rotate fairly.
export async function pickModerator(db, workspaceId) {
  const moderators = await db.users
    .find({ workspace_id: workspaceId, role: 'moderator', is_active: true, is_online: true }, { last_assigned_at: 1 })
    .lean();
  if (!moderators.length) return null;
  const counts = await db.conversations.aggregate([
    { $match: { assigned_user_id: { $in: moderators.map((m) => m._id) }, status: 'open' } },
    { $group: { _id: '$assigned_user_id', n: { $sum: 1 } } },
  ]);
  const open = new Map(counts.map((c) => [c._id, c.n]));
  const lastAssigned = (m) => (m.last_assigned_at ? m.last_assigned_at.getTime() : -Infinity);
  moderators.sort((a, b) => (open.get(a._id) ?? 0) - (open.get(b._id) ?? 0)
    || lastAssigned(a) - lastAssigned(b)
    || a._id - b._id);
  return moderators[0]._id;
}

export async function assignConversation(db, conversationId, userId) {
  await db.conversations.updateOne({ _id: conversationId }, { $set: { assigned_user_id: userId } });
  if (userId) await db.users.updateOne({ _id: userId }, { $set: { last_assigned_at: new Date() } });
}

async function hasActiveAssignee(db, conversation) {
  if (!conversation.assigned_user_id) return false;
  const user = await db.users.findById(conversation.assigned_user_id, { is_active: 1 }).lean();
  return Boolean(user?.is_active);
}

// Keeps an existing assignee (the sticky rule). Only conversations without an
// active owner are routed; if nobody is on duty they wait in "Unassigned".
export async function ensureAssigned(db, conversation) {
  if (await hasActiveAssignee(db, conversation)) return conversation.assigned_user_id;
  const userId = await pickModerator(db, conversation.workspace_id);
  await assignConversation(db, conversation.id, userId);
  return userId;
}

// Hands waiting conversations to on-duty moderators, oldest first. Called when
// someone goes on duty so nothing sits unanswered in the queue.
export async function distributeUnassigned(db, workspaceId) {
  const waiting = await db.conversations
    .find({ workspace_id: workspaceId, status: 'open', assigned_user_id: null }, { _id: 1 })
    .sort({ last_inbound_at: 1 })
    .lean();
  const assigned = [];
  for (const { _id: id } of waiting) {
    const userId = await pickModerator(db, workspaceId);
    if (!userId) break;
    await assignConversation(db, id, userId);
    assigned.push(id);
  }
  return assigned;
}

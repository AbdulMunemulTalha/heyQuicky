// Creates an in-app notification and pushes it to the person's open dashboards (and phone, once push is set up).
export async function addNotification(db, emit, { workspaceId, userId, type, category = 'system', title, body = '', link = '', actions = [] }) {
  const n = await db.insert(db.notifications, { workspace_id: workspaceId, user_id: userId, type, category, title, body, link, actions });
  emit(workspaceId, 'notification', { id: n.id, userId, type, category, title, body, link, at: n.created_at });
  return n;
}

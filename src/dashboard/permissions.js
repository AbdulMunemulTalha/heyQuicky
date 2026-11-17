// Who may do what, from the Team → Permissions screen. The owner can always do everything;
// the other ticks are the defaults and can be changed per shop (workspace.settings.permissions).
export const ROLES = ['owner', 'admin', 'moderator', 'agent'];

export const ACTIONS = {
  reply: 'Reply to chats',
  see_all_chats: 'See all chats (not just assigned)',
  edit_orders: 'Create & edit orders',
  cancel_orders: 'Cancel orders',
  book_couriers: 'Book couriers',
  teach_ai: 'Teach the AI & publish',
  edit_products: 'Edit products & prices',
  see_phones: 'See customer phone numbers',
  billing: 'Billing & top up',
  invite: 'Invite teammates',
};

export const DEFAULT_PERMISSIONS = {
  admin: { reply: true, see_all_chats: true, edit_orders: true, cancel_orders: true, book_couriers: true, teach_ai: true, edit_products: true, see_phones: true, billing: false, invite: true },
  moderator: { reply: true, see_all_chats: true, edit_orders: true, cancel_orders: true, book_couriers: true, teach_ai: false, edit_products: false, see_phones: true, billing: false, invite: false },
  agent: { reply: true, see_all_chats: false, edit_orders: true, cancel_orders: false, book_couriers: false, teach_ai: false, edit_products: false, see_phones: true, billing: false, invite: false },
};

export function permissionsFor(workspace) {
  const custom = workspace?.settings?.permissions ?? {};
  const out = {};
  for (const role of ['admin', 'moderator', 'agent']) out[role] = { ...DEFAULT_PERMISSIONS[role], ...(custom[role] ?? {}) };
  return out;
}

export function can(user, action, workspace) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  if (!(action in ACTIONS)) return false;
  return Boolean(permissionsFor(workspace)[user.role]?.[action]);
}

// The list the client uses to hide buttons a role can't use (the server still checks every request).
export function allowedActions(user, workspace) {
  return Object.keys(ACTIONS).filter((a) => can(user, a, workspace));
}

// Express middleware: 403 unless the signed-in user may do `action`.
export function need(db, action) {
  return async (req, res, next) => {
    try {
      if (req.user.role === 'owner') return next();
      req.workspace ??= await db.workspaces.findById(req.user.workspace_id, { settings: 1 }).lean();
      if (!can(req.user, action, req.workspace)) {
        return res.status(403).json({ error: `Your role can't do this (${ACTIONS[action]}). Ask the owner for access.`, code: 'forbidden' });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

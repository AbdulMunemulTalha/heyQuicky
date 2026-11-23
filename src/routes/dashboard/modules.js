import { Router } from 'express';
import { InboxError } from '../../inbox.js';
import { audit } from '../../dashboard/util.js';
import { MODULES, RECOMMENDED, NOT_BUILT, BUSINESS_TYPES, modulesFor, recommendedFor } from '../../dashboard/settings.js';

// Phase 2 · Modules by business type (UX-07), frame "Modules by business type".
export function moduleRoutes(db, _config, { auth, emit }) {
  const router = Router();
  const ownerOrAdmin = (req, res, next) => (['owner', 'admin'].includes(req.user.role) ? next() : res.status(403).json({ error: 'Only the owner or an admin can change modules' }));

  const view = (ws, user) => {
    const type = BUSINESS_TYPES.includes(ws.category) ? ws.category : 'other';
    const rec = recommendedFor(type);
    return {
      businessType: type, businessTypes: BUSINESS_TYPES,
      modules: Object.entries(MODULES).map(([key, m]) => ({ key, always: Boolean(m.always), on: modulesFor(ws)[key], recommended: rec.includes(key), notBuilt: NOT_BUILT.includes(key) })),
      recommended: rec, matchesRecommended: Object.entries(MODULES).every(([key, m]) => m.always || NOT_BUILT.includes(key) || modulesFor(ws)[key] === rec.includes(key)),
      canEdit: ['owner', 'admin'].includes(user.role),
    };
  };

  router.get('/settings/modules', auth, async (req, res) => {
    res.json(view(await db.workspaces.findById(req.user.workspace_id).lean(), req.user));
  });

  router.patch('/settings/modules', auth, ownerOrAdmin, async (req, res) => {
    const b = req.body ?? {};
    const set = {};
    if (b.businessType !== undefined) {
      if (!BUSINESS_TYPES.includes(b.businessType)) throw new InboxError(400, 'Pick a business type');
      set.category = b.businessType;
    }
    if (b.modules && typeof b.modules === 'object') {
      for (const [key, on] of Object.entries(b.modules)) {
        const m = MODULES[key];
        if (!m) throw new InboxError(400, `Unknown module: ${key}`);
        if (m.always) throw new InboxError(400, 'That part of HeyQuicky is always on');
        if (NOT_BUILT.includes(key) && on) throw new InboxError(409, 'That module is coming later');
        set[`settings.modules.${key}`] = Boolean(on);
      }
    }
    // "Use recommended": everything switchable follows the business type's list.
    if (b.useRecommended) {
      const ws = await db.workspaces.findById(req.user.workspace_id, { category: 1 }).lean();
      const rec = recommendedFor(set.category ?? ws.category);
      for (const [key, m] of Object.entries(MODULES)) if (!m.always) set[`settings.modules.${key}`] = !NOT_BUILT.includes(key) && rec.includes(key);
    }
    if (!Object.keys(set).length) throw new InboxError(400, 'Nothing to change');
    await db.workspaces.updateOne({ _id: req.user.workspace_id }, { $set: set });
    await audit(db, req.user, b.useRecommended ? 'Used the recommended modules' : b.businessType ? `Changed business type to ${b.businessType}` : 'Changed modules', { where: 'Modules' });
    emit(req.user.workspace_id, 'modules', {});
    res.json(view(await db.workspaces.findById(req.user.workspace_id).lean(), req.user));
  });

  return router;
}

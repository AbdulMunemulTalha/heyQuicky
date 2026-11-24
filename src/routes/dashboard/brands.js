import { Router } from 'express';
import { InboxError } from '../../inbox.js';
import { audit } from '../../dashboard/util.js';
import { brandsOf, createBrand, teamId } from '../../dashboard/brands.js';
import { aiModeOf } from '../../dashboard/aiMode.js';

// UX-10 · Brand / page switcher and Add a brand (frames "Brand / page switcher", "Add a brand").
export function brandRoutes(db, _config, { auth }) {
  const router = Router();

  router.get('/brands', auth, async (req, res) => {
    const list = await brandsOf(db, req.user.workspace_id);
    const ids = list.map((b) => b._id);
    const [channels, waiting] = await Promise.all([
      db.channels.find({ workspace_id: { $in: ids } }, { workspace_id: 1, platform: 1 }).lean(),
      // "Needs a person" per brand, like the badge in the frame.
      db.conversations.aggregate([{ $match: { workspace_id: { $in: ids }, status: 'open', ai_handoff: true, last_replier: 'customer', spam: { $ne: true } } }, { $group: { _id: '$workspace_id', n: { $sum: 1 } } }]),
    ]);
    const waitingBy = new Map(waiting.map((w) => [w._id, w.n]));
    res.json({
      brands: list.map((b) => {
        const ch = channels.filter((c) => c.workspace_id === b._id);
        return { id: b._id, name: b.name, aiMode: aiModeOf(b), channels: ch.length, platforms: [...new Set(ch.map((c) => c.platform))], waiting: waitingBy.get(b._id) ?? 0,
          current: b._id === req.user.workspace_id, main: !b.brand_group };
      }),
      canAdd: req.user.role === 'owner',
    });
  });

  router.post('/brands/:id/switch', auth, async (req, res) => {
    const id = Number(req.params.id);
    const root = req.user.team_id ?? await teamId(db, req.user.workspace_id);
    const target = await db.workspaces.findOne({ _id: id, $or: [{ _id: root }, { brand_group: root }] }, { name: 1 }).lean();
    if (!target) throw new InboxError(404, 'Brand not found');
    await db.users.updateOne({ _id: req.user.id }, { $set: { active_workspace_id: id === root ? null : id } });
    res.json({ id, name: target.name });
  });

  // Add a brand: blank, or a copy of the current brand's AI persona, rules, saved replies and couriers.
  router.post('/brands', auth, async (req, res) => {
    if (req.user.role !== 'owner') throw new InboxError(403, 'Only the business owner can add a brand');
    const name = String(req.body?.name ?? '').trim().slice(0, 60);
    if (!name) throw new InboxError(400, 'Give the brand a name');
    const root = req.user.team_id ?? await teamId(db, req.user.workspace_id);
    if (await db.workspaces.countDocuments({ $or: [{ _id: root }, { brand_group: root }] }) >= 10) throw new InboxError(409, 'You can have up to 10 brands');
    const brand = await createBrand(db, req.user, { name, copyFrom: req.body?.copy ? req.user.workspace_id : null });
    await db.users.updateOne({ _id: req.user.id }, { $set: { active_workspace_id: brand.id } });
    await audit(db, req.user, `Added the brand ${name}${req.body?.copy ? ' (copied settings)' : ''}`, { where: 'Brands' });
    res.status(201).json({ id: brand.id, name });
  });

  return router;
}

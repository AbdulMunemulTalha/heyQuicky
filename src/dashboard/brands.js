import { practiceOn } from './aiMode.js';
// UX-10 · Brands: an owner can run several shops (brands). Each brand is its own workspace with its
// own inbox, AI, catalog and orders; the team and the AI credit belong to the main shop, and every
// other brand points at it with brand_group. People are stored on the main shop.

const caches = new WeakMap();
// The main shop (team and billing) for any brand.
export async function teamId(db, workspaceId) {
  if (workspaceId == null) return workspaceId;
  let cache = caches.get(db);
  if (!cache) { cache = new Map(); caches.set(db, cache); }
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < 60_000) return hit.id;
  const ws = await db.workspaces.findById(workspaceId, { brand_group: 1 }).lean();
  const id = ws?.brand_group ?? workspaceId;
  cache.set(workspaceId, { id, at: Date.now() });
  return id;
}

// Every brand in the group, main shop first.
export async function brandsOf(db, workspaceId) {
  const root = await teamId(db, workspaceId);
  const list = await db.workspaces.find({ $or: [{ _id: root }, { brand_group: root }] }, { name: 1, ai_mode: 1, brand_group: 1, created_at: 1 }).lean();
  return list.sort((a, b) => (a._id === root ? -1 : b._id === root ? 1 : a._id - b._id));
}

// What a new brand copies from the current one ("Copy Nokshi Threads"): AI persona, rules, saved replies, couriers.
const COPY_FIELDS = ['category', 'ai_name', 'ai_style', 'ai_address', 'ai_sales', 'shop_notes', 'order_fields', 'sells_offline', 'audience', 'delivery_inside_dhaka',
  'delivery_outside_dhaka', 'delivery_inside_days', 'delivery_outside_days', 'cash_on_delivery', 'free_delivery_over', 'bkash_number', 'nagad_number'];
export async function createBrand(db, user, { name, copyFrom = null }) {
  const root = await teamId(db, user.workspace_id);
  const source = copyFrom ? await db.workspaces.findById(copyFrom).lean() : await db.workspaces.findById(root, { category: 1 }).lean();
  const base = { name, brand_group: root, ai_mode: practiceOn() ? 'suggest' : 'off', onboarding_step: 'channels' };
  if (copyFrom && source) {
    for (const k of COPY_FIELDS) if (source[k] !== undefined) base[k] = source[k];
    base.settings = { ...(source.settings ?? {}) };
    delete base.settings.readiness_history;
  } else if (source?.category) base.category = source.category;
  const brand = await db.insert(db.workspaces, base);
  if (copyFrom && source) {
    const copy = async (model, fields) => {
      const rows = await model.find({ workspace_id: source._id }).lean();
      for (const r of rows) {
        const doc = {};
        for (const f of fields) if (r[f] !== undefined) doc[f] = r[f];
        await db.insert(model, { ...doc, workspace_id: brand.id });
      }
      return rows.length;
    };
    await copy(db.aiRules, ['text', 'category', 'enabled', 'author']);
    await copy(db.savedReplies, ['shortcut', 'text', 'name', 'folder', 'pinned', 'scope', 'owner_user_id', 'blocks', 'phrases', 'auto_answer']);
    await copy(db.courierAccounts, ['courier', 'credentials', 'connected', 'auto_book']);
    await copy(db.knowledge, ['title', 'text', 'kind', 'source']);
  }
  return brand;
}

import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { InboxError } from '../../inbox.js';
import { need } from '../../dashboard/permissions.js';
import { audit } from '../../dashboard/util.js';
import { sizeChartMessage } from '../../platforms/rich.js';

const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const okImage = (u) => u === '' || (typeof u === 'string' && (u.startsWith('/files/') || /^https:\/\/\S+$/.test(u)) && u.length < 500);

// The table: first column is the size, the others are measurements. Up to 12 sizes × 8 measurements.
function cleanTable(columns, rows) {
  const cols = (Array.isArray(columns) ? columns : []).map((c) => clean(c, 24)).slice(0, 9);
  if (cols.length < 2 || cols.some((c) => !c)) throw new InboxError(400, 'Name every column — the size and at least one measurement');
  const body = (Array.isArray(rows) ? rows : []).slice(0, 12).map((r) => cols.map((_, i) => clean(Array.isArray(r) ? r[i] : '', 16)));
  if (!body.length) throw new InboxError(400, 'Add at least one size');
  if (body.some((r) => !r[0])) throw new InboxError(400, 'Every row needs a size name');
  const sizes = body.map((r) => r[0].toLowerCase());
  if (new Set(sizes).size !== sizes.length) throw new InboxError(400, 'Each size can appear only once');
  return { columns: cols, rows: body };
}

// Products in a chart's categories that have no chart yet get it (CAT-05 "+ Category").
// productIds limits it to those products (a new product, or one whose category changed).
export async function applyCategoryCharts(db, workspaceId, { productIds = null } = {}) {
  const charts = await db.sizeCharts.find({ workspace_id: workspaceId, 'categories.0': { $exists: true } }, { categories: 1 }).lean();
  let n = 0;
  for (const c of charts) {
    const r = await db.products.updateMany({ workspace_id: workspaceId, ...(productIds ? { _id: { $in: productIds } } : {}), category: { $in: c.categories }, $or: [{ size_chart_id: null }, { size_chart_id: { $exists: false } }] }, { $set: { size_chart_id: c._id } });
    n += r.modifiedCount;
  }
  return n;
}

// Phase 2 · Size charts (CAT-05): the charts the AI sends when someone asks "which size am I?".
export function sizeChartRoutes(db, config, { auth }) {
  const router = Router();
  const edit = need(db, 'edit_products');

  async function load(req) {
    const c = await db.sizeCharts.findOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id }).lean();
    if (!c) throw new InboxError(404, 'Size chart not found');
    return c;
  }
  const row = (c, used = 0) => ({ id: c._id, name: c.name, unit: c.unit, columns: c.columns, rows: c.rows, howTo: c.how_to ?? '', image: c.image ?? '', categories: c.categories ?? [], used });

  router.get('/size-charts', auth, async (req, res) => {
    const ws = req.user.workspace_id;
    const [charts, counts, categories, sized] = await Promise.all([
      db.sizeCharts.find({ workspace_id: ws }).sort({ name: 1 }).lean(),
      db.products.aggregate([{ $match: { workspace_id: ws, archived: { $ne: true }, size_chart_id: { $ne: null } } }, { $group: { _id: '$size_chart_id', n: { $sum: 1 } } }]),
      db.products.distinct('category', { workspace_id: ws, archived: { $ne: true }, category: { $nin: ['', null] } }),
      db.products.countDocuments({ workspace_id: ws, archived: { $ne: true }, 'options.name': /size|সাইজ/i, $or: [{ size_chart_id: null }, { size_chart_id: { $exists: false } }] }),
    ]);
    // Charts made before the chart page existed get their link now.
    for (const c of charts.filter((x) => !x.token)) {
      c.token = randomBytes(9).toString('base64url');
      await db.sizeCharts.updateOne({ _id: c._id, token: null }, { $set: { token: c.token } });
    }
    const used = new Map(counts.map((x) => [x._id, x.n]));
    res.json({ charts: charts.map((c) => row(c, used.get(c._id) ?? 0)), categories: categories.sort(), withoutChart: sized });
  });

  router.get('/size-charts/:id', auth, async (req, res) => {
    const c = await load(req);
    const products = await db.products.find({ workspace_id: req.user.workspace_id, size_chart_id: c._id, archived: { $ne: true } }, { name: 1, code: 1, category: 1, price: 1 }).sort({ name: 1 }).lean();
    // "Image the customer gets": exactly what goes out in Messenger.
    const preview = sizeChartMessage(c, { productName: products[0]?.name ?? '', publicUrl: config.publicUrl || '' });
    res.json({ chart: row(c, products.length), products: products.map((p) => ({ id: p._id, name: p.name, code: p.code, category: p.category })), preview,
      pageUrl: c.token && config.publicUrl ? `${config.publicUrl}/size/${c.token}` : c.token ? `/size/${c.token}` : '' });
  });

  async function fields(body, current = {}) {
    const set = {};
    if (body.name !== undefined || !current._id) { set.name = clean(body.name, 60); if (!set.name) throw new InboxError(400, 'Give the chart a name'); }
    if (body.unit !== undefined) { if (!['inch', 'cm'].includes(body.unit)) throw new InboxError(400, 'Unit must be inch or cm'); set.unit = body.unit; }
    if (body.columns !== undefined || body.rows !== undefined || !current._id) Object.assign(set, cleanTable(body.columns ?? current.columns, body.rows ?? current.rows));
    if (body.howTo !== undefined) set.how_to = clean(body.howTo, 500);
    if (body.image !== undefined) { const img = clean(body.image, 500); if (!okImage(img)) throw new InboxError(400, 'Upload a picture or paste an https link'); set.image = img; }
    if (body.categories !== undefined) set.categories = [...new Set((Array.isArray(body.categories) ? body.categories : []).map((x) => clean(x, 60)).filter(Boolean))].slice(0, 20);
    return set;
  }

  router.post('/size-charts', auth, edit, async (req, res) => {
    const ws = req.user.workspace_id;
    const set = await fields(req.body ?? {});
    const c = await db.insert(db.sizeCharts, { workspace_id: ws, unit: 'inch', ...set, token: randomBytes(9).toString('base64url') });
    const assigned = set.categories?.length ? await applyCategoryCharts(db, ws) : 0;
    await audit(db, req.user, `Added size chart "${set.name}"`, { where: 'Size charts' });
    res.status(201).json({ id: c.id, assigned });
  });

  router.patch('/size-charts/:id', auth, edit, async (req, res) => {
    const c = await load(req);
    const set = await fields(req.body ?? {}, c);
    if (!c.token) set.token = randomBytes(9).toString('base64url');
    await db.sizeCharts.updateOne({ _id: c._id }, { $set: set });
    const assigned = set.categories ? await applyCategoryCharts(db, req.user.workspace_id) : 0;
    res.json({ ok: true, assigned });
  });

  // "Used for": pick the products that send this chart.
  router.put('/size-charts/:id/products', auth, edit, async (req, res) => {
    const c = await load(req);
    const ws = req.user.workspace_id;
    const ids = [...new Set((Array.isArray(req.body?.productIds) ? req.body.productIds : []).map(Number).filter(Number.isInteger))].slice(0, 500);
    await db.products.updateMany({ workspace_id: ws, size_chart_id: c._id, _id: { $nin: ids } }, { $set: { size_chart_id: null } });
    const r = await db.products.updateMany({ workspace_id: ws, _id: { $in: ids } }, { $set: { size_chart_id: c._id } });
    res.json({ used: r.matchedCount });
  });

  router.delete('/size-charts/:id', auth, edit, async (req, res) => {
    const c = await load(req);
    const r = await db.products.updateMany({ workspace_id: req.user.workspace_id, size_chart_id: c._id }, { $set: { size_chart_id: null } });
    await db.sizeCharts.deleteOne({ _id: c._id });
    await audit(db, req.user, `Deleted size chart "${c.name}" (${r.modifiedCount} products had it)`, { where: 'Size charts' });
    res.json({ unlinked: r.modifiedCount });
  });

  return router;
}

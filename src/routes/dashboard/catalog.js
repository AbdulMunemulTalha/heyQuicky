import { Router } from 'express';
import { applyCategoryCharts } from './sizeCharts.js';
import { InboxError } from '../../inbox.js';
import { need } from '../../dashboard/permissions.js';
import { audit, escapeRegex } from '../../dashboard/util.js';
import { cleanProduct, missing, stockState, variantLabel, LOW_STOCK_AT } from '../../dashboard/catalog.js';
import { parseCsv, productsFromRows, googleSheetCsvUrl } from '../../productImport.js';

const FILTERS = ['all', 'in', 'low', 'out', 'needs', 'archived'];

// Screens 08 Catalog and 13 Add / edit product (CAT-01, CAT-02).
export function catalogRoutes(db, _config, { auth, fetchImpl = fetch }) {
  const router = Router();
  const channelIds = async (wsId) => (await db.channels.find({ workspace_id: wsId }, { _id: 1 }).lean()).map((c) => c._id);

  router.get('/catalog', auth, async (req, res) => {
    const wsId = req.user.workspace_id;
    const filter = FILTERS.includes(req.query.filter) ? req.query.filter : 'all';
    const q = String(req.query.q ?? '').trim().slice(0, 60);
    const [all, posts] = await Promise.all([
      db.products.find({ workspace_id: wsId }).sort({ sold_count: -1, name: 1 }).lean(),
      db.posts.find({ channel_id: { $in: await channelIds(wsId) }, product_ids: { $ne: [] } }, { product_ids: 1 }).lean(),
    ]);
    const postCount = new Map();
    for (const p of posts) for (const id of p.product_ids) postCount.set(id, (postCount.get(id) ?? 0) + 1);

    const live = all.filter((p) => !p.archived);
    const rows = all.map((p) => ({ p, s: stockState(p), miss: p.archived || p.visibility === 'hidden' ? [] : missing(p) }));
    const counts = { products: live.length, in: 0, low: 0, out: 0, archived: all.length - live.length };
    for (const r of rows) if (!r.p.archived) counts[r.s.state] += 1;
    const needs = rows.filter((r) => !r.p.archived && r.miss.length);

    const re = q && new RegExp(escapeRegex(q), 'i');
    const shown = rows.filter((r) => (filter === 'archived' ? r.p.archived : !r.p.archived)
      && (filter === 'all' || filter === 'archived' || (filter === 'needs' ? r.miss.length > 0 : r.s.state === filter))
      && (!re || re.test(r.p.name) || re.test(r.p.code) || re.test(r.p.category)));

    res.json({
      counts, lowAt: LOW_STOCK_AT,
      readiness: { count: needs.length, photo: needs.filter((r) => r.miss.includes('photo')).length, sizeChart: needs.filter((r) => r.miss.includes('size_chart')).length },
      categories: [...new Set(live.map((p) => p.category).filter(Boolean))].sort(),
      products: shown.slice(0, 300).map(({ p, s, miss }) => ({
        id: p._id, name: p.name, code: p.code, price: p.price, compareAt: p.compare_at, category: p.category, photo: p.photos?.[0] ?? '', colour: p.colour,
        visibility: p.visibility, archived: p.archived, state: s.state, total: s.total, missing: miss,
        sizes: (p.variant_list ?? []).slice(0, 6).map((v) => ({ label: variantLabel(v, p.options), stock: v.stock ?? null })),
        moreSizes: Math.max(0, (p.variant_list?.length ?? 0) - 6),
        posts: postCount.get(p._id) ?? 0, sold: p.sold_count ?? 0, waiting: p.restock_waiting ?? 0,
      })),
    });
  });

  router.get('/catalog/products/:id', auth, async (req, res) => {
    const wsId = req.user.workspace_id;
    const p = await db.products.findOne({ _id: Number(req.params.id), workspace_id: wsId }).lean();
    if (!p) throw new InboxError(404, 'Product not found');
    const [posts, charts, upsells, stats, categories] = await Promise.all([
      db.posts.find({ channel_id: { $in: await channelIds(wsId) }, product_ids: p._id }).sort({ posted_at: -1 }).lean(),
      db.sizeCharts.find({ workspace_id: wsId }, { name: 1 }).sort({ name: 1 }).lean(),
      db.products.find({ _id: { $in: p.upsell_ids ?? [] }, workspace_id: wsId }, { name: 1 }).lean(),
      db.orders.aggregate([
        { $match: { workspace_id: wsId, 'product_items.product_id': p._id } },
        { $group: { _id: null, orders: { $sum: 1 }, returns: { $sum: { $cond: [{ $eq: ['$status', 'returned'] }, 1, 0] } }, last: { $max: '$created_at' } } },
      ]),
      db.products.distinct('category', { workspace_id: wsId, archived: { $ne: true } }),
    ]);
    res.json({
      product: {
        id: p._id, name: p.name, code: p.code, price: p.price, compareAt: p.compare_at, category: p.category, description: p.description,
        photos: p.photos ?? [], video: p.video, colour: p.colour, options: p.options ?? [], inStock: p.in_stock !== false,
        variants: (p.variant_list ?? []).map((v) => ({ sku: v.sku, options: v.options ?? {}, price: v.price ?? p.price, stock: v.stock ?? null, reserved: v.reserved ?? 0 })),
        aiNotes: p.ai_notes, visibility: p.visibility, sizeChartId: p.size_chart_id, upsellIds: p.upsell_ids ?? [], archived: p.archived,
        state: stockState(p).state, missing: missing(p),
      },
      upsells: upsells.map((u) => ({ id: u._id, name: u.name })),
      posts: posts.map((x) => ({ id: x._id, caption: x.caption, image: x.image, comments: x.comment_count, postedAt: x.posted_at })),
      sizeCharts: charts.map((c) => ({ id: c._id, name: c.name })),
      categories: categories.filter(Boolean).sort(),
      stats: { sold: p.sold_count ?? 0, orders: stats[0]?.orders ?? 0, returns: stats[0]?.returns ?? 0, lastOrderAt: stats[0]?.last ?? null },
    });
  });

  // Small lists for pickers: add-on products and posts to link.
  router.get('/catalog/pick', auth, async (req, res) => {
    const wsId = req.user.workspace_id;
    const re = new RegExp(escapeRegex(String(req.query.q ?? '').trim().slice(0, 60)), 'i');
    if (req.query.type === 'posts') {
      const posts = await db.posts.find({ channel_id: { $in: await channelIds(wsId) }, caption: re }).sort({ posted_at: -1 }).limit(30).lean();
      return res.json(posts.map((x) => ({ id: x._id, caption: x.caption, image: x.image, comments: x.comment_count, postedAt: x.posted_at, linked: x.product_ids.map(Number) })));
    }
    const products = await db.products.find({ workspace_id: wsId, archived: { $ne: true }, $or: [{ name: re }, { code: re }] }, { name: 1, price: 1, code: 1 }).sort({ name: 1 }).limit(30).lean();
    res.json(products.map((x) => ({ id: x._id, name: x.name, price: x.price, code: x.code })));
  });

  router.post('/catalog/products', auth, need(db, 'edit_products'), async (req, res) => {
    const wsId = req.user.workspace_id;
    const fields = await cleanProduct(db, wsId, req.body ?? {});
    const p = await db.insert(db.products, { workspace_id: wsId, ...fields, colour: fields.colour || pickColour(fields.name) });
    if (!fields.code) await db.products.updateOne({ _id: p.id }, { $set: { code: `P-${p.id}` } });
    // A product in a category that has a size chart gets that chart (CAT-05).
    if (fields.category && !fields.size_chart_id) await applyCategoryCharts(db, wsId, { productIds: [p.id] });
    await audit(db, req.user, `Added product "${fields.name}"`, { where: 'Catalog' });
    res.status(201).json({ id: p.id });
  });

  router.patch('/catalog/products/:id', auth, need(db, 'edit_products'), async (req, res) => {
    const wsId = req.user.workspace_id;
    const existing = await db.products.findOne({ _id: Number(req.params.id), workspace_id: wsId }).lean();
    if (!existing) throw new InboxError(404, 'Product not found');
    const fields = await cleanProduct(db, wsId, req.body ?? {}, existing);
    await db.products.updateOne({ _id: existing._id }, { $set: fields });
    if (fields.category && fields.category !== existing.category && !fields.size_chart_id) await applyCategoryCharts(db, wsId, { productIds: [existing._id] });
    const changes = [];
    if (fields.price !== existing.price) changes.push(`price ৳${existing.price} → ৳${fields.price}`);
    if (fields.visibility !== existing.visibility) changes.push(`visibility ${existing.visibility} → ${fields.visibility}`);
    await audit(db, req.user, `Edited product "${fields.name}"${changes.length ? ` (${changes.join(', ')})` : ''}`, { where: 'Catalog' });
    res.json({ ok: true });
  });

  router.post('/catalog/products/:id/duplicate', auth, need(db, 'edit_products'), async (req, res) => {
    const p = await db.products.findOne({ _id: Number(req.params.id), workspace_id: req.user.workspace_id }).lean();
    if (!p) throw new InboxError(404, 'Product not found');
    const { _id, created_at: _c, sold_count: _s, restock_waiting: _r, ...rest } = p;
    const copy = await db.insert(db.products, {
      ...rest, name: `${p.name} (copy)`.slice(0, 120), code: '', visibility: 'hidden', archived: false, updated_at: new Date(),
      variant_list: (p.variant_list ?? []).map((v) => ({ ...v, sku: '', reserved: 0 })),
    });
    await db.products.updateOne({ _id: copy.id }, { $set: { code: `P-${copy.id}` } });
    await audit(db, req.user, `Duplicated product "${p.name}"`, { where: 'Catalog' });
    res.status(201).json({ id: copy.id });
  });

  router.post('/catalog/products/:id/archive', auth, need(db, 'edit_products'), async (req, res) => {
    const archived = req.body?.archived !== false;
    const p = await db.products.findOneAndUpdate({ _id: Number(req.params.id), workspace_id: req.user.workspace_id }, { $set: { archived, updated_at: new Date() } }, { new: true, lean: true });
    if (!p) throw new InboxError(404, 'Product not found');
    await audit(db, req.user, `${archived ? 'Archived' : 'Restored'} product "${p.name}"`, { where: 'Catalog' });
    res.json({ archived });
  });

  // Linked Facebook posts: comments and DMs from these posts are answered about this product.
  router.put('/catalog/products/:id/posts/:postId', auth, need(db, 'edit_products'), async (req, res) => {
    const [p, post] = await linkTargets(req);
    await db.posts.updateOne({ _id: post._id }, { $addToSet: { product_ids: p._id }, $set: { match: 'linked' } });
    res.json({ ok: true });
  });
  router.delete('/catalog/products/:id/posts/:postId', auth, need(db, 'edit_products'), async (req, res) => {
    const [p, post] = await linkTargets(req);
    const left = post.product_ids.filter((x) => x !== p._id);
    await db.posts.updateOne({ _id: post._id }, { $set: { product_ids: left, match: left.length ? post.match : 'none' } });
    res.sendStatus(204);
  });
  async function linkTargets(req) {
    const wsId = req.user.workspace_id;
    const [p, post] = await Promise.all([
      db.products.findOne({ _id: Number(req.params.id), workspace_id: wsId }).lean(),
      db.posts.findOne({ _id: Number(req.params.postId), channel_id: { $in: await channelIds(wsId) } }).lean(),
    ]);
    if (!p || !post) throw new InboxError(404, 'Product or post not found');
    return [p, post];
  }

  // Import CSV / Google Sheet. Products whose name already exists are skipped, so importing twice is safe.
  router.post('/catalog/import', auth, need(db, 'edit_products'), async (req, res) => {
    let csv = req.body?.csv;
    if (req.body?.sheetUrl !== undefined) {
      const url = googleSheetCsvUrl(req.body.sheetUrl);
      if (!url) throw new InboxError(400, 'Paste a Google Sheets link (docs.google.com/spreadsheets/…)');
      let response;
      try {
        response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
      } catch {
        throw new InboxError(502, "Couldn't reach Google Sheets. Try again in a moment.");
      }
      if (!response.ok || (response.headers.get('content-type') ?? '').includes('text/html')) {
        throw new InboxError(400, 'Google wouldn\'t share that sheet. In the sheet, click Share and set "Anyone with the link" to Viewer.');
      }
      csv = await response.text();
    }
    if (typeof csv !== 'string' || !csv.trim()) throw new InboxError(400, 'Choose a CSV file or paste a Google Sheets link');
    if (csv.length > 2_000_000) throw new InboxError(400, 'That file is too big (2 MB at most)');
    const { products, skipped, error } = productsFromRows(parseCsv(csv));
    if (error) throw new InboxError(400, error);
    const wsId = req.user.workspace_id;
    const have = new Set((await db.products.find({ workspace_id: wsId }, { name: 1 }).lean()).map((p) => p.name.trim().toLowerCase()));
    let added = 0;
    let duplicates = 0;
    for (const product of products) {
      const key = product.name.trim().toLowerCase();
      if (have.has(key)) { duplicates += 1; continue; }
      have.add(key);
      const p = await db.insert(db.products, { workspace_id: wsId, ...product, colour: pickColour(product.name) });
      await db.products.updateOne({ _id: p.id }, { $set: { code: `P-${p.id}` } });
      added += 1;
    }
    await audit(db, req.user, `Imported ${added} products`, { where: 'Catalog' });
    res.status(201).json({ added, skipped, duplicates });
  });

  return router;
}

// A soft swatch colour for products without a photo, stable per name.
const SWATCHES = ['#e8ddd0', '#d9e6dd', '#dcdcef', '#e6e1ee', '#f3e1c8', '#dbe6ef', '#f2d9cc', '#e0e9d2'];
function pickColour(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SWATCHES[h % SWATCHES.length];
}

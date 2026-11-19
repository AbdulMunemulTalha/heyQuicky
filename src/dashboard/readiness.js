// "Knowledge readiness" and "Gaps to fix" on the Training screen (TRN-07): how much of what
// customers usually ask the AI can answer from what the shop has filled in.
const POLICY = /return|exchange|refund|ফেরত|বদল|এক্সচেঞ্জ|রিটার্ন/i;

export async function readiness(db, workspaceId) {
  const visible = { workspace_id: workspaceId, archived: { $ne: true }, visibility: { $ne: 'hidden' } };
  const [ws, products, unpriced, sized, charts, knowledge, policyNotes, saved, open] = await Promise.all([
    db.workspaces.findById(workspaceId).lean(),
    db.products.countDocuments(visible),
    db.products.countDocuments({ ...visible, $or: [{ price: { $lte: 0 } }, { price: null }] }),
    db.products.countDocuments({ ...visible, 'options.name': /size|সাইজ/i }),
    db.products.countDocuments({ ...visible, 'options.name': /size|সাইজ/i, size_chart_id: { $ne: null } }),
    db.knowledge.countDocuments({ workspace_id: workspaceId }),
    db.knowledge.countDocuments({ workspace_id: workspaceId, $or: [{ kind: { $in: ['policy', 'exchange'] } }, { text: POLICY }, { title: POLICY }] }),
    db.savedReplies.countDocuments({ workspace_id: workspaceId }),
    db.unanswered.countDocuments({ workspace_id: workspaceId, status: 'open' }),
  ]);
  const checks = [
    { key: 'products', done: products > 0, fix: '/catalog/new' },
    { key: 'prices', done: products > 0 && unpriced === 0, fix: '/catalog', n: unpriced },
    { key: 'delivery', done: Boolean(ws?.delivery_inside_dhaka > 0 && ws?.delivery_outside_dhaka > 0), fix: '/settings/courier' },
    { key: 'payment', done: Boolean(ws?.bkash_number || ws?.nagad_number || ws?.cash_on_delivery !== false), fix: '/settings/payments' },
    { key: 'policy', done: policyNotes > 0 || POLICY.test(ws?.shop_notes ?? ''), fix: 'knowledge' },
    { key: 'knowledge', done: knowledge >= 3 || (ws?.shop_notes ?? '').length > 200, fix: 'knowledge', n: knowledge },
    { key: 'sizeCharts', done: sized === 0 || charts === sized, fix: '/catalog/size-charts', n: sized - charts },
    { key: 'saved', done: saved >= 3, fix: '/saved-replies', n: saved },
    { key: 'unanswered', done: open === 0, fix: 'unanswered', n: open },
  ];
  const done = checks.filter((c) => c.done).length;
  return { score: Math.round((done / checks.length) * 100), checks, gaps: checks.filter((c) => !c.done) };
}

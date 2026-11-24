import { normalize } from './autoAnswer.js';
import { selfTestAfterPublish } from './selftest.js';

// What the shop taught the AI (TRN-01/02/05/10), as text added to the shop information in the prompt.
export async function trainedNotes(db, workspaceId) {
  const [knowledge, taught, rules] = await Promise.all([
    db.knowledge.find({ workspace_id: workspaceId }).sort({ created_at: 1 }).limit(100).lean(),
    db.taughtAnswers.find({ workspace_id: workspaceId }).sort({ created_at: 1 }).limit(200).lean(),
    db.aiRules.find({ workspace_id: workspaceId, enabled: true }).sort({ created_at: 1 }).limit(50).lean(),
  ]);
  const parts = [];
  if (knowledge.length) parts.push(`Knowledge book:\n${knowledge.map((k) => `- ${k.title ? `${k.title}: ` : ''}${k.text}`).join('\n')}`);
  const chart = (t) => (t.attach ?? []).find((a) => a.startsWith('size_chart:'))?.split(':')[1];
  if (taught.length) parts.push(`Answers the shop taught (use them when a customer asks this):\n${taught.map((t) => `- Q: ${t.question}\n  A: ${t.answer}${t.when?.length ? ` (when: ${t.when.join('; ')})` : ''}${chart(t) ? ` (also send the size chart: size_chart_product = ${chart(t)})` : ''}`).join('\n')}`);
  if (rules.length) parts.push(`Rules the shop always wants followed:\n${rules.map((r) => `- ${r.text}`).join('\n')}`);
  return parts.join('\n\n');
}

export async function withTraining(db, workspace) {
  const extra = await trainedNotes(db, workspace._id);
  return extra ? { ...workspace, shop_notes: [workspace.shop_notes, extra].filter(Boolean).join('\n\n') } : workspace;
}

// A question the AI couldn't answer from the shop information (TRN-04). Similar questions add up.
export async function recordUnanswered(db, workspaceId, question) {
  const text = String(question ?? '').trim().slice(0, 300);
  const key = normalize(text).slice(0, 120);
  if (!key) return;
  await db.unanswered.updateOne(
    { workspace_id: workspaceId, key },
    { $inc: { count: 1 }, $set: { last_asked_at: new Date() }, $setOnInsert: { question: text, status: 'open', created_at: new Date(), _id: await db.nextId('unanswered') } },
    { upsert: true },
  ).catch(() => {});
}

// Everything that makes up the AI's behaviour, for versions and rollback (TRN-05).
export async function snapshot(db, workspaceId) {
  const [ws, knowledge, taught, rules] = await Promise.all([
    db.workspaces.findById(workspaceId).lean(),
    db.knowledge.find({ workspace_id: workspaceId }).lean(),
    db.taughtAnswers.find({ workspace_id: workspaceId }).lean(),
    db.aiRules.find({ workspace_id: workspaceId }).lean(),
  ]);
  return {
    persona: { ai_name: ws.ai_name, ai_style: ws.ai_style, ai_address: ws.ai_address, ai_sales: ws.ai_sales, shop_notes: ws.shop_notes, persona: ws.settings?.persona ?? {} },
    knowledge: knowledge.map(({ _id, kind, title, text, source }) => ({ _id, kind, title, text, source })),
    taught: taught.map(({ _id, question, answer, when, attach }) => ({ _id, question, answer, when, attach })),
    rules: rules.map(({ _id, text, category, enabled, author }) => ({ _id, text, category, enabled, author })),
  };
}

export async function publish(db, user, summary, source = '') {
  const ws = await db.workspaces.findOneAndUpdate({ _id: user.workspace_id }, { $inc: { ai_version: 1 } }, { new: true, lean: true });
  await selfTestAfterPublish(db, ws._id).catch(() => {});
  return db.insert(db.aiVersions, { workspace_id: ws._id, number: ws.ai_version, summary, by_name: user.name, source, snapshot: await snapshot(db, ws._id) });
}

// Puts the AI back exactly as it was in an earlier version, and records that as a new version.
export async function rollback(db, user, versionNumber) {
  const v = await db.aiVersions.findOne({ workspace_id: user.workspace_id, number: versionNumber }).lean();
  if (!v) return null;
  const s = v.snapshot;
  const wsId = user.workspace_id;
  await db.workspaces.updateOne({ _id: wsId }, { $set: { ai_name: s.persona.ai_name, ai_style: s.persona.ai_style, ai_address: s.persona.ai_address,
    ai_sales: s.persona.ai_sales, shop_notes: s.persona.shop_notes, 'settings.persona': s.persona.persona } });
  for (const [model, list] of [[db.knowledge, s.knowledge], [db.taughtAnswers, s.taught], [db.aiRules, s.rules]]) {
    await model.deleteMany({ workspace_id: wsId });
    if (list?.length) await model.insertMany(list.map((x) => ({ ...x, workspace_id: wsId })));
  }
  return publish(db, user, `Rolled back to version ${versionNumber}`, 'rollback');
}

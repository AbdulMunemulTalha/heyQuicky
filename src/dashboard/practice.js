import { practiceOn } from './aiMode.js';
import { audit } from './util.js';

// Practice mode ('suggest') is switched off on HeyQuicky for now (see aiMode.js). Shops that were in it are
// moved once — finished shops go live, shops still setting up stay off — and their old mode is kept in
// settings.practice_retired so it can be put back exactly (restorePractice).

export async function retirePractice(db, { now = new Date(), log = () => {} } = {}) {
  if (practiceOn()) return { moved: 0, skipped: 'Practice is switched on' };
  const shops = await db.workspaces.find({ $or: [{ ai_mode: 'suggest' }, { ai_mode: null }, { ai_mode: { $exists: false } }], 'settings.practice_retired': { $exists: false } },
    { name: 1, ai_mode: 1, onboarding_step: 1, went_live_at: 1 }).lean();
  let moved = 0;
  for (const w of shops) {
    // Finished setup: was practising, now live (the owner's call). Still setting up: off until they go live.
    const to = w.onboarding_step === 'done' ? 'auto' : 'off';
    const set = { ai_mode: to, 'settings.practice_retired': { was: w.ai_mode ?? null, to, at: now } };
    if (to === 'auto' && !w.went_live_at) Object.assign(set, { went_live_at: now, trial_started_at: now });
    await db.workspaces.updateOne({ _id: w._id }, { $set: set });
    await audit(db, { workspace_id: w._id, id: null, name: 'HeyQuicky' }, to === 'auto' ? 'Practice mode was retired — the AI is now live' : 'Practice mode was retired — the AI is off until you go live', { where: 'AI agent' });
    log(`shop ${w._id} (${w.name}): ${w.ai_mode ?? 'no mode'} → ${to}`);
    moved += 1;
  }
  return { moved };
}

// Puts every retired shop back to the mode it had (for when Practice comes back).
export async function restorePractice(db, { log = () => {} } = {}) {
  const shops = await db.workspaces.find({ 'settings.practice_retired': { $exists: true } }, { name: 1, settings: 1 }).lean();
  for (const w of shops) {
    const r = w.settings.practice_retired;
    const update = { $unset: { 'settings.practice_retired': 1 } };
    if (r.was) update.$set = { ai_mode: r.was }; else update.$unset.ai_mode = 1;
    await db.workspaces.updateOne({ _id: w._id }, update);
    log(`shop ${w._id} (${w.name}): back to ${r.was ?? 'no mode'}`);
  }
  return { restored: shops.length };
}

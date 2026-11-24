// What the AI does for a shop: 'auto' (AI live: replies by itself) or 'off'. A third mode, 'suggest'
// ("Practice": the AI only drafts replies for the team), is switched off on HeyQuicky for now.
//
// To bring Practice back: set FEATURE_PRACTICE=1. Nothing else is needed — the database still accepts
// 'suggest', shops keep the value they had, the switch shows "AI live | Practice" again, and onboarding's
// "Not yet" button can send 'suggest' (see client/src/components/Onboarding.jsx). Shops moved off Practice
// by scripts/retire-practice.js remember their old mode (settings.practice_retired) and can be put back
// with `node scripts/retire-practice.js --restore`.
//
// The Sandbox demo shop (ONB-09) is behind FEATURE_SANDBOX=1 the same way (src/dashboard/demoSeed.js).

export const practiceOn = (env = process.env) => env.FEATURE_PRACTICE === '1';
export const sandboxOn = (env = process.env) => env.FEATURE_SANDBOX === '1';

// The modes a shop may pick right now.
export const aiModes = (practice = practiceOn()) => (practice ? ['off', 'suggest', 'auto'] : ['off', 'auto']);

// The mode that actually applies. With Practice off, a stored 'suggest' (or no mode yet) means off:
// the AI sends nothing to customers.
export function aiModeOf(workspace, practice = practiceOn()) {
  const raw = workspace?.ai_mode ?? (practice ? 'suggest' : 'off');
  return raw === 'suggest' && !practice ? 'off' : raw;
}

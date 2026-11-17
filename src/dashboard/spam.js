// A light first check for obvious spam (TKT-03). It only looks at the first message of a new chat,
// and a person can always press "Not spam". Returns a short reason, or null.
const RULES = [
  [/(ইনকাম|income|earn|আয়\s*করুন).{0,40}(লিংক|link|ক্লিক|click|http)/i, 'Money-making link'],
  [/(ঘরে বসে|work from home).{0,40}(টাকা|taka|income|ইনকাম)/i, 'Money-making offer'],
  [/(you (have )?won|congratulations!? you|লটারি|lottery|জিতেছেন)/i, 'Prize scam'],
  [/(followers?|likes?|ফলোয়ার).{0,30}(cheap|boost|বাড়ান|increase|\d+k)/i, 'Promotion'],
  [/(bit\.ly|tinyurl|t\.me\/|wa\.me\/\d{10,}).{0,0}/i, 'Suspicious link'],
];

export function looksLikeSpam(text) {
  const s = String(text ?? '');
  if (!s.trim()) return null;
  for (const [re, reason] of RULES) if (re.test(s)) return reason;
  return null;
}

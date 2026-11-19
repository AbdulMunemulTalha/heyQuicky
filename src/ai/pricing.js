// What one model call cost, from the token usage Claude reports (BIL-01/02/03).
// Prices in USD per million tokens, from platform.claude.com/docs/en/about-claude/pricing
// (checked 2026-11-19). 5-minute cache writes are what the provider uses.
export const PRICES = {
  'claude-haiku-5-5': { input: 0.10, cacheWrite: 0.125, cacheRead: 0.01, output: 0.50, longOver: 100_000, long: { input: 0.50, cacheWrite: 0.625, cacheRead: 0.05, output: 2.50 } },
  'claude-sonnet-5-5': { input: 2, cacheWrite: 2.50, cacheRead: 0.10, output: 10 },
  'claude-opus-5-5': { input: 4, cacheWrite: 5, cacheRead: 0.20, output: 20 },
  'claude-opus-5': { input: 5, cacheWrite: 6.25, cacheRead: 0.50, output: 25 },
  'claude-sonnet-5': { input: 2, cacheWrite: 2.50, cacheRead: 0.20, output: 10 },
};

// usage: { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }
// Returns USD amounts: what it cost, and what caching saved compared with sending everything fresh.
export function usageCost(model, usage = {}) {
  const base = PRICES[model];
  if (!base) return null;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  // Haiku 5.5 bills the whole request at the higher rate when the prompt is over 100k tokens.
  const p = base.longOver && input + write + read > base.longOver ? base.long : base;
  const usd = (input * p.input + write * p.cacheWrite + read * p.cacheRead + output * p.output) / 1e6;
  const withoutCache = ((input + write + read) * p.input + output * p.output) / 1e6;
  return { usd, savedUsd: Math.max(0, withoutCache - usd), tokens: { input, output, cacheWrite: write, cacheRead: read } };
}

// The shop pays the real cost in taka plus the HeyQuicky markup (USD_TO_BDT, AI_MARKUP_PCT).
export function toTaka(usd, { usdToBdt, markupPct = 0 }) {
  return Math.round(usd * usdToBdt * (1 + markupPct / 100) * 10_000) / 10_000;
}

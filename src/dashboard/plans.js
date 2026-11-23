// BIL · Plans (frame "Plan & upgrade, top up"). What each plan includes comes from the design; the price
// and the AI replies included each month are set on the server, because pricing isn't decided yet:
//   PLAN_PRICES=starter:999,growth:2499,pro:4999        (taka per month)
//   PLAN_REPLIES=starter:1500,growth:5000,pro:15000     (AI replies included per month)
// Until a plan has a price the screen says "Price coming soon". Yearly = 10 months' price ("2 months free").
export const PLAN_KEYS = ['starter', 'growth', 'pro'];
export const POPULAR = 'growth';

export const FEATURES = {
  starter: ['inbox', 'ai_bangla', 'orders_courier', 'saved_auto', 'unlimited_team'],
  growth: ['everything_starter', 'followups', 'coupons_page', 'payments_rules', 'analytics', 'priority_whatsapp'],
  pro: ['everything_growth', 'brands', 'roles_sla', 'capi_webhooks', 'audit', 'setup_call'],
};

const parse = (raw) => Object.fromEntries(String(raw ?? '').split(',').map((p) => p.trim().split(':')).filter(([k, v]) => PLAN_KEYS.includes(k) && Number(v) > 0).map(([k, v]) => [k, Math.round(Number(v))]));

export function plansFrom(env = process.env) {
  const prices = parse(env.PLAN_PRICES);
  const replies = parse(env.PLAN_REPLIES);
  return PLAN_KEYS.map((key) => ({
    key, popular: key === POPULAR, features: FEATURES[key],
    monthly: prices[key] ?? null, yearly: prices[key] ? prices[key] * 10 : null, replies: replies[key] ?? null,
  }));
}

// Defaults for workspace.settings. Anything a shop hasn't changed falls back to these.
export const MODULES = {
  inbox: { always: true }, orders: { always: true }, analytics: { always: true },
  courier: { dflt: true }, catalog: { dflt: true }, growth: { dflt: true }, coupons: { dflt: true },
  payments: { dflt: true }, tickets: { dflt: true }, bookings: { dflt: false }, quotes: { dflt: false }, content: { dflt: false },
};

// Business types from onboarding (step 03); older names map onto these.
export const BUSINESS_TYPES = ['clothing', 'cosmetics', 'electronics', 'mobile_accessories', 'jewellery', 'shoes', 'grocery', 'food', 'salon', 'clinic', 'coaching', 'other'];
const OLD_TYPE = { fashion: 'clothing', beauty: 'cosmetics', home: 'other', kids: 'other' };
// Modules whose screens are not built yet (Phase 3): shown, but can't be switched on.
export const NOT_BUILT = [];

// Recommended modules per business type (UX-07).
const SHOP = ['courier', 'catalog', 'growth', 'coupons', 'payments', 'tickets'];
export const RECOMMENDED = {
  clothing: SHOP, cosmetics: SHOP, shoes: SHOP, jewellery: SHOP, other: SHOP,
  electronics: [...SHOP, 'quotes'], mobile_accessories: SHOP,
  grocery: ['courier', 'catalog', 'growth', 'coupons', 'payments'],
  food: ['courier', 'catalog', 'growth', 'coupons', 'payments'],
  salon: ['bookings', 'payments', 'growth', 'tickets'],
  clinic: ['bookings', 'payments', 'tickets'],
  coaching: ['bookings', 'payments', 'growth'],
};
export const recommendedFor = (type) => RECOMMENDED[OLD_TYPE[type] ?? type] ?? SHOP;

export function modulesFor(workspace) {
  const chosen = workspace?.settings?.modules ?? {};
  const out = {};
  for (const [key, m] of Object.entries(MODULES)) out[key] = m.always ? true : (chosen[key] ?? m.dflt);
  return out;
}

export const DEFAULT_SLA = { reply_min: 15, warn_min: 30, hours: '10:00 AM – 11:00 PM, every day', duty_only: true, nobody_message: true };
export const DEFAULT_CAPS = { monthly: 2000, alert_below: 100 };

export function setting(workspace, key, dflt) {
  const v = workspace?.settings?.[key];
  return v === undefined ? dflt : v;
}

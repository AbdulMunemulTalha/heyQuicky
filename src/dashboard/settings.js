// Defaults for workspace.settings. Anything a shop hasn't changed falls back to these.
export const MODULES = {
  inbox: { always: true }, orders: { always: true }, analytics: { always: true },
  courier: { dflt: true }, catalog: { dflt: true }, growth: { dflt: true }, coupons: { dflt: true },
  payments: { dflt: true }, tickets: { dflt: true }, bookings: { dflt: false }, quotes: { dflt: false }, content: { dflt: false },
};

// Recommended modules per business type (UX-07).
export const RECOMMENDED = {
  clothing: ['courier', 'catalog', 'growth', 'coupons', 'payments', 'tickets'],
  salon: ['bookings', 'payments', 'growth', 'tickets'],
  clinic: ['bookings', 'payments', 'tickets'],
  coaching: ['bookings', 'payments', 'growth'],
  food: ['courier', 'catalog', 'growth', 'coupons', 'payments'],
};

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

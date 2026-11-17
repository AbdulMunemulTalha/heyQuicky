// COD risk (CRM-03): a score from the customer's own history with the shop and, when known,
// their delivery record across couriers. Higher = more likely to refuse a cash-on-delivery parcel.
export function riskFor({ delivered = 0, returned = 0, cancelled = 0, courierRate = null, courierTotal = 0, codAmount = 0, outsideDhaka = false } = {}) {
  let score = 20;
  const own = delivered + returned;
  if (own >= 2) score = Math.round((returned / own) * 100);
  if (courierRate !== null && courierTotal >= 3) {
    const courierRisk = Math.round((1 - courierRate) * 100);
    score = own >= 2 ? Math.round(score * 0.5 + courierRisk * 0.5) : courierRisk;
  }
  if (cancelled >= 2) score += 10;
  if (codAmount >= 5000) score += 8;
  if (outsideDhaka) score += 5;
  score = Math.max(0, Math.min(100, score));
  const level = score >= 45 ? 'high' : score >= 25 ? 'medium' : 'low';
  const action = level === 'high' ? 'Ask for a bKash advance before shipping' : level === 'medium' ? 'Call before shipping' : 'Safe to ship COD';
  return { score, level, action };
}

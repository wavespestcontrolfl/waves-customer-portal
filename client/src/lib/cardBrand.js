// Display label for a saved-card brand. Stripe returns lowercase brands and
// savePaymentMethod stores them UPPERCASED, so the raw value renders as
// "VISA ending in 4242" / "mastercard ending in 1881" depending on the
// source — customers see proper names (owner ruling 2026-08-27).
const BRAND_LABELS = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'Amex',
  american_express: 'Amex',
  discover: 'Discover',
  diners: 'Diners Club',
  diners_club: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
  cartes_bancaires: 'Cartes Bancaires',
  eftpos_au: 'eftpos',
};

export function cardBrandLabel(brand, fallback = 'Card') {
  const raw = String(brand || '').trim();
  if (!raw) return fallback;
  const key = raw.toLowerCase().replace(/[\s-]+/g, '_');
  if (BRAND_LABELS[key]) return BRAND_LABELS[key];
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

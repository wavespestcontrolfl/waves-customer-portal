/**
 * Shared egress helpers for public (unauthenticated, tokenized) report routes.
 *
 * Extracted from routes/public-lawn-diagnostic.js so the lawn-assessment and
 * pest-identifier funnels apply the SAME allowlist discipline: derive/allowlist
 * at egress rather than trusting stored snapshots, because snapshots accept
 * arbitrary strings at capture time.
 */

// First name shown on an unauthenticated report. Derive a single name token
// (letters + hyphen/apostrophe) rather than trusting a scrub — anything else
// (digits, appended notes, extra words) is dropped, not published.
function safePublicFirstName(value) {
  if (typeof value !== 'string') return null;
  const token = value.trim().split(/\s+/)[0] || '';
  const cleaned = token.replace(/[^\p{L}'-]/gu, '').slice(0, 40);
  return cleaned && /\p{L}/u.test(cleaned) ? cleaned : null;
}

// SWFL service-area cities/communities (Manatee / Sarasota / Charlotte). Public
// reports greet a prospect with their city, so the field is allowlisted at
// egress: a stored value like "Venice gate code BLUE" is not in the set and is
// omitted entirely. Cosmetic-only — an unrecognized city simply doesn't render.
const PUBLIC_CITY_ALLOWLIST = new Set([
  // Manatee
  'bradenton', 'bradenton beach', 'west bradenton', 'anna maria', 'holmes beach',
  'palmetto', 'ellenton', 'parrish', 'lakewood ranch', 'myakka city', 'cortez',
  'longboat key', 'memphis', 'whitfield', 'bayshore gardens', 'samoset', 'oneco',
  'rubonia', 'terra ceia', 'duette',
  // Sarasota
  'sarasota', 'south sarasota', 'sarasota springs', 'gulf gate estates', 'gulf gate',
  'fruitville', 'bee ridge', 'vamo', 'southgate', 'kensington park', 'the meadows',
  'lake sarasota', 'venice', 'north venice', 'south venice', 'venice gardens',
  'nokomis', 'osprey', 'siesta key', 'laurel', 'englewood', 'north port', 'plantation',
  'warm mineral springs',
  // Charlotte
  'punta gorda', 'port charlotte', 'charlotte harbor', 'rotonda', 'rotonda west',
  'cleveland', 'harbour heights', 'solana', 'grove city', 'placida', 'cape haze',
  'manasota key',
]);

function safePublicCity(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!PUBLIC_CITY_ALLOWLIST.has(normalized)) return null;
  // Title-case the allowlisted value for display (the set is the only source of truth).
  return normalized.replace(/\b\p{L}/gu, (ch) => ch.toUpperCase());
}

function overallStatusLabel(score) {
  if (score == null || score === '') return 'Reviewed';
  const n = Number(score);
  if (!Number.isFinite(n)) return 'Reviewed';
  if (n >= 70) return 'Healthy';
  if (n >= 40) return 'Keep an eye on it';
  return 'Needs attention';
}

/**
 * Clamp a stored pricing_snapshot to the fixed public shape. Prices are
 * server-computed at claim time from the pricing engine; this re-clamps at
 * egress so a malformed/stale snapshot can't push arbitrary strings or extra
 * fields into the public payload.
 */
function sanitizePricingSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.tiers)) return null;
  // Number(null) === 0, so absent fields must be dropped BEFORE coercion —
  // otherwise a one-time-only tier would render "monthly: $0".
  const cleanNumber = (value) => (value != null && Number.isFinite(Number(value)) ? Number(value) : null);
  const tiers = snapshot.tiers.slice(0, 4).map((tier) => ({
    label: typeof tier.label === 'string' ? tier.label.slice(0, 60) : null,
    visits: cleanNumber(tier.visits),
    monthly: cleanNumber(tier.monthly),
    annual: cleanNumber(tier.annual),
    // One-time packages (flea, one-time lawn pest) price as a single amount.
    one_time: cleanNumber(tier.one_time),
    per_visit: cleanNumber(tier.per_visit),
    recommended: tier.recommended === true,
  })).filter((tier) => tier.label && (tier.monthly != null || tier.annual != null || tier.one_time != null));
  if (!tiers.length) return null;
  return {
    service_label: typeof snapshot.service_label === 'string' ? snapshot.service_label.slice(0, 80) : null,
    basis_note: typeof snapshot.basis_note === 'string' ? snapshot.basis_note.slice(0, 220) : null,
    tiers,
  };
}

function setPublicPrivacyHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

module.exports = {
  safePublicFirstName,
  safePublicCity,
  PUBLIC_CITY_ALLOWLIST,
  overallStatusLabel,
  sanitizePricingSnapshot,
  setPublicPrivacyHeaders,
};

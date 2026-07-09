// Canonical lead_source key → display name, shared by the ads routes and the
// dashboard's lead-funnel card. Extracted from admin-ads.js (Phase 6) for the
// same reason classifyServiceLine moved to services/service-line.js in Phase
// 5: a second copy WILL drift.
function titleCase(key) {
  if (!key) return 'Unknown';
  return String(key).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const SOURCE_NAMES = {
  google_ads: 'Google Ads',
  google_lsa: 'Google LSA',
  organic: 'Organic',
  referral: 'Referral',
  domain_website: 'Domain Sites',
  waves_website: 'Waves Website',
  google_business: 'Google Business',
  facebook: 'Facebook',
  facebook_organic: 'Facebook (organic)',
  nextdoor: 'Nextdoor',
  van_wrap: 'Van Wrap',
  // Fallback bucket from the lead webhook (lead-webhook.js) when a form URL
  // matches no known domain/UTM — includes UNMAPPED spoke domains. NOT the Waves
  // hub (that's always waves_website). Label it distinctly so it doesn't read as
  // a duplicate "Website" next to "Waves Website" and so unattributed volume is a
  // visible signal to map its source, not silently folded into the hub.
  website: 'Unattributed (web)',
  // Grouping bucket for manually-entered offline sources (see
  // LEAD_SOURCE_NORMALIZE) — real acquisition, but not a marketing channel the
  // ROI views can price, so they group visibly here instead of scattering as
  // one-off title-cased buckets.
  other_manual: 'Other (manual)',
};

// Manual-entry lead_source vocabulary → canonical grouping keys. The admin
// customer form (client/src/lib/customerFormOptions.js LEAD_SOURCE_OPTIONS)
// stores values like 'google' / 'phone_call' that the tracking pipeline never
// writes, so they fall out of channel-attribution ROI grouping entirely.
// Normalization is applied at the READ/grouping layer ONLY — stored rows are
// never mutated. The map is deliberately conservative:
//   • google     → organic ("found us on Google" = organic search; a real paid
//                  click carries gclid/UTMs and is stored as google_ads at
//                  capture time, so it never reaches this fallback)
//   • phone_call / door_knock / field_tech → other_manual (offline channels
//                  with no marketing-spend bucket — grouped visibly, not guessed
//                  into a priced channel)
// 'facebook' / 'referral' / 'nextdoor' / 'website' already ARE canonical keys
// and pass through untouched. Anything unknown also passes through unchanged
// (formatSourceName title-cases it) — a visible signal to extend this map, not
// a silent fold into 'other'.
const LEAD_SOURCE_NORMALIZE = {
  google: 'organic',
  phone_call: 'other_manual',
  door_knock: 'other_manual',
  field_tech: 'other_manual',
};

function normalizeLeadSource(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return 'unknown';
  if (SOURCE_NAMES[key]) return key; // already canonical
  return LEAD_SOURCE_NORMALIZE[key] || key;
}

function formatSourceName(key) {
  return SOURCE_NAMES[key] || titleCase(key);
}

module.exports = { formatSourceName, normalizeLeadSource, SOURCE_NAMES, LEAD_SOURCE_NORMALIZE };

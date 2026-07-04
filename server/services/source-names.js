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
};

function formatSourceName(key) {
  return SOURCE_NAMES[key] || titleCase(key);
}

module.exports = { formatSourceName, SOURCE_NAMES };

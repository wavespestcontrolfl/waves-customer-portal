/**
 * Lead-source classifier — the canonical URL/UTM/click-id → lead_source
 * mapping, extracted from routes/lead-webhook.js so non-webhook writers
 * (self-booking attribution in lead-estimate-link.js) classify with the exact
 * same semantics instead of growing a drifting copy. The webhook still
 * imports and re-exports it (including via its `_test` surface), so every
 * existing call site and test is unchanged.
 *
 * One deliberate fix over the webhook original: the paid/social UTM branches
 * compare the TRIMMED/LOWERCASED source+medium computed below (the original
 * computed the normalized values but compared the RAW strings, so common
 * ad-platform casing like `utm_source=Google&utm_medium=CPC` fell through to
 * the organic/unknown fallback and was excluded from paid ROAS). The fix
 * applies to the webhook path too; pinned by the casing tests in
 * lead-webhook-meta-attribution. Detail strings still render the raw values.
 */
const { findGbpLocationByUtmContent } = require('../config/locations');
const { SPOKE_SITES } = require('./content-astro/spoke-sites');
const { classifyAttributionSignals } = require('./lead-source-evidence');

// Single source of truth for the spoke fleet: the domains determineLeadSource()
// matches for organic domain_website attribution are derived from SPOKE_SITES (the
// same canonical list the Astro build + content filter use) — so adding a spoke
// there auto-attributes its inbound form leads here instead of dropping to the
// 'Unattributed (web)' fallback. The hub (group 'Hub') is excluded — it resolves
// to waves_website. `area` is optional display/location enrichment (used for
// location resolution + stored on the lead); a spoke absent from SPOKE_AREA still
// attributes correctly as domain_website, just with a null area.
const SPOKE_DOMAIN_KEYS = SPOKE_SITES.filter((s) => s.group !== 'Hub').map((s) => s.key);
const SPOKE_AREA = {
  'bradentonflexterminator.com': 'Bradenton', 'bradentonflpestcontrol.com': 'Bradenton', 'bradentonfllawncare.com': 'Bradenton',
  'palmettoexterminator.com': 'Palmetto', 'palmettoflpestcontrol.com': 'Palmetto',
  'parrishexterminator.com': 'Parrish', 'parrishpestcontrol.com': 'Parrish', 'parrishfllawncare.com': 'Parrish',
  'sarasotaflexterminator.com': 'Sarasota', 'sarasotaflpestcontrol.com': 'Sarasota', 'sarasotafllawncare.com': 'Sarasota',
  'veniceexterminator.com': 'Venice', 'veniceflpestcontrol.com': 'Venice', 'venicelawncare.com': 'Venice',
  'northportflpestcontrol.com': 'North Port',
  'waveslawncare.com': 'SW Florida',
};

// Hub city detection for a wavespestcontrol.com landing path — hoisted to
// module scope so both the hub branch below and the AI-assistant area lookup
// (areaForLandingUrl) read the exact same table. Anchor single-word cities to
// the "-fl" city/quote-page suffix so an incidental mention in a slug isn't
// read as a city — most importantly "palmetto-bug" (a FL cockroach) must NOT
// resolve to Palmetto and skew office routing. Compound names (north-port,
// lakewood-ranch) are unambiguous on their own and need no anchor.
const HUB_CITIES = [
  [/north[-_ ]?port/i, 'North Port'], [/lakewood[-_ ]?ranch/i, 'Lakewood Ranch'],
  [/bradenton-fl/i, 'Bradenton'], [/parrish-fl/i, 'Parrish'], [/sarasota-fl/i, 'Sarasota'],
  [/venice-fl/i, 'Venice'], [/palmetto-fl/i, 'Palmetto'], [/ellenton-fl/i, 'Ellenton'],
];

// Area for a landing URL using the SAME domain/hub detection the
// domain_website / waves_website branches use below — reused by the
// AI-assistant branch so an AI-referred visitor still gets office-routing
// area enrichment instead of a bare null. Read-only lookup; never classifies
// a source itself.
function areaForLandingUrl(url) {
  const spokeDomain = SPOKE_DOMAIN_KEYS.find((domain) => url.includes(domain));
  if (spokeDomain) return SPOKE_AREA[spokeDomain] || null;
  if (url.includes('wavespestcontrol.com')) {
    const path = String(url).replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0].replace(/\/+$/, '');
    const hit = HUB_CITIES.find(([re]) => re.test(path));
    return hit ? hit[1] : null;
  }
  return null;
}

// findAiAssistant/hostnameOf/AI_ASSISTANT_SOURCES now live in
// ./ai-referral-sources.js, SHARED with lead-source-resolver.js (the
// quote-wizard's property-lookup/quote-calculate path) so the two
// resolution paths can never judge the same AI referral differently
// (codex pre-push P1, AGENTS.md "extend the existing mechanism").

function determineLeadSource(pageUrl, landingUrl, utmSource, utmMedium, utmCampaign, utmContent, fbclid, fbc, gclid, wbraid, gbraid, referrer) {
  const url = landingUrl || pageUrl || '';
  const classified = classifyAttributionSignals({
    referrer, landing_url: landingUrl || pageUrl,
    utm: { source: utmSource, medium: utmMedium, campaign: utmCampaign, content: utmContent },
    fbclid, fbc, gclid, wbraid, gbraid,
  });

  if (classified.bucket === 'google_business' && classified.reason === 'gbp_tags') {
    const gbpLocation = findGbpLocationByUtmContent(utmContent);
    return {
      source: 'google_business',
      detail: gbpLocation ? `GBP ${gbpLocation.name}` : 'GBP unattributed',
      channel: 'organic',
      area: gbpLocation?.id || null,
    };
  }
  if (classified.bucket === 'google_business') {
    return { source: 'google_business', detail: 'Google Maps referral', channel: 'organic', area: areaForLandingUrl(url) };
  }
  if (classified.bucket === 'google_ads') {
    const clickLabel = classified.reason === 'paid_tags' ? 'Google paid campaign' : `Google Ads click (${classified.reason})`;
    return { source: 'google_ads', detail: utmCampaign ? `Campaign: ${utmCampaign}` : clickLabel, channel: 'paid', area: utmContent };
  }
  if (classified.bucket === 'meta_ads') {
    const detail = classified.reason === 'paid_tags' || utmCampaign
      ? `${utmMedium} — ${utmCampaign}`
      : `Meta click (${classified.reason === 'fbc' ? '_fbc' : 'fbclid'})`;
    return { source: 'facebook', detail, channel: 'paid' };
  }
  if (classified.bucket === 'organic_social') {
    if (classified.socialName === 'Nextdoor') return { source: 'nextdoor', detail: utmCampaign || '', channel: 'social' };
    if (['Facebook', 'Instagram'].includes(classified.socialName)) {
      return { source: 'facebook', detail: `${classified.socialName}${utmCampaign ? ` — ${utmCampaign}` : ''}`, channel: 'organic' };
    }
    return { source: 'website', detail: `${classified.socialName} organic social`, channel: 'social' };
  }
  if (classified.bucket === 'ai') {
    return { source: 'ai_assistant', detail: classified.ai.detail, channel: 'organic', area: areaForLandingUrl(url) };
  }
  if (classified.bucket === 'organic_search') {
    return { source: 'waves_website', detail: `${classified.searchName} organic search`, channel: 'organic', area: areaForLandingUrl(url) };
  }
  if (classified.bucket === 'referral') {
    return { source: 'website', detail: `Referral: ${classified.referrerHost}`, channel: 'referral', area: areaForLandingUrl(url) };
  }

  // Domain-based attribution. The spoke fleet is single-sourced from SPOKE_SITES
  // (see SPOKE_DOMAIN_KEYS / SPOKE_AREA above) so it can't drift from the Astro
  // build's domain list — a spoke added there attributes here automatically. A
  // domain not in the fleet falls through to the 'website' fallback below, which
  // the dashboard surfaces as "Unattributed (web)" — a visible signal to map it,
  // not a silent miss (the class of bug PR #264 fixed piecemeal).
  const spokeDomain = SPOKE_DOMAIN_KEYS.find((domain) => url.includes(domain));
  if (spokeDomain) return { source: 'domain_website', detail: spokeDomain, channel: 'organic', area: SPOKE_AREA[spokeDomain] || null };

  // Waves main site (hub) pages. Detect the CITY anywhere in the URL path — not just
  // a fixed /pest-control-<city> list — so quote pages (/pest-control-quote-parrish-fl/),
  // lawn/mosquito city pages, etc. get the right area instead of falling to a generic
  // "Main site". Channel is always waves_website (organic hub); the page slug is the
  // detail so it stays specific for any page type.
  if (url.includes('wavespestcontrol.com')) {
    const path = String(url).replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0].replace(/\/+$/, '');
    const seg = path.split('/').filter(Boolean).pop() || '';
    // HUB_CITIES (module scope, above) anchors single-word cities to the
    // "-fl" city/quote-page suffix so an incidental mention in a slug isn't
    // read as a city — most importantly "palmetto-bug" (a FL cockroach) must
    // NOT resolve to Palmetto and skew office routing. Compound names
    // (north-port, lakewood-ranch) are unambiguous on their own and need no anchor.
    const hit = HUB_CITIES.find(([re]) => re.test(path));
    return { source: 'waves_website', detail: seg ? `${seg} page` : 'Main site', channel: 'organic', area: hit ? hit[1] : undefined };
  }

  return { source: utmSource || 'website', detail: utmMedium || '', channel: 'unknown' };
}

module.exports = { determineLeadSource, SPOKE_DOMAIN_KEYS, SPOKE_AREA };

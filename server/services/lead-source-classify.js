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
const HUB_DOMAIN = 'wavespestcontrol.com';
const LANDING_DOMAINS = [HUB_DOMAIN, ...SPOKE_DOMAIN_KEYS];
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
// module scope so every acquisition channel uses the same table. Anchor single-word cities to
// the "-fl" city/quote-page suffix so an incidental mention in a slug isn't
// read as a city — most importantly "palmetto-bug" (a FL cockroach) must NOT
// resolve to Palmetto and skew office routing. Compound names (north-port,
// lakewood-ranch) are unambiguous on their own and need no anchor.
const HUB_CITIES = [
  [/north[-_ ]?port/i, 'North Port'], [/lakewood[-_ ]?ranch/i, 'Lakewood Ranch'],
  [/bradenton-fl/i, 'Bradenton'], [/parrish-fl/i, 'Parrish'], [/sarasota-fl/i, 'Sarasota'],
  [/venice-fl/i, 'Venice'], [/palmetto-fl/i, 'Palmetto'], [/ellenton-fl/i, 'Ellenton'],
];

// Older webforms may submit a bare domain. Only the hostname identifies a
// registered site: a link to the site inside another page's query does not.
function registeredLanding(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  let url = rawUrl.trim();
  if (url.startsWith('//')) url = `https:${url}`;
  else if (/^[\w-]+(?:\.[\w-]+)+(?=[:/?#]|$)/.test(url)) url = `https://${url}`;
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) return null;
    const domain = LANDING_DOMAINS.find((name) => parsed.hostname === name || parsed.hostname.endsWith(`.${name}`));
    if (!domain) return null;
    const path = parsed.pathname;
    const area = domain === HUB_DOMAIN
      ? HUB_CITIES.find(([pattern]) => pattern.test(path))?.[1]
      : SPOKE_AREA[domain];
    return { domain, path, area };
  } catch {
    return null;
  }
}

function determineLeadSource(pageUrl, landingUrl, utmSource, utmMedium, utmCampaign, utmContent, fbclid, fbc, gclid, wbraid, gbraid, referrer) {
  const landing = registeredLanding(landingUrl || pageUrl);
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
    return { source: 'google_business', detail: 'Google Maps referral', channel: 'organic', area: landing?.area || null };
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
    return { source: 'ai_assistant', detail: classified.ai.detail, channel: 'organic', area: landing?.area || null };
  }
  // CRM source rows identify the site that received the inquiry. The intake's
  // source_evidence independently records the search engine or referring site.
  if (landing && landing.domain !== HUB_DOMAIN) {
    return { source: 'domain_website', detail: landing.domain, channel: 'organic', area: landing.area || null };
  }
  if (landing) {
    const slug = landing.path.split('/').filter(Boolean).pop();
    return { source: 'waves_website', detail: slug ? `${slug} page` : 'Main site', channel: 'organic', area: landing.area };
  }
  if (classified.bucket === 'organic_search') {
    return { source: 'waves_website', detail: `${classified.searchName} organic search`, channel: 'organic', area: null };
  }
  if (classified.bucket === 'referral') {
    return { source: 'website', detail: `Referral: ${classified.referrerHost}`, channel: 'referral', area: null };
  }

  return { source: utmSource || 'website', detail: utmMedium || '', channel: 'unknown' };
}

module.exports = { determineLeadSource, SPOKE_DOMAIN_KEYS, SPOKE_AREA };

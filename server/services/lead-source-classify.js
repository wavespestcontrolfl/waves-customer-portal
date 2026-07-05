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

function determineLeadSource(pageUrl, landingUrl, utmSource, utmMedium, utmCampaign, utmContent, fbclid, fbc, gclid, wbraid, gbraid) {
  const url = landingUrl || pageUrl || '';
  const source = String(utmSource || '').trim().toLowerCase();
  const medium = String(utmMedium || '').trim().toLowerCase();
  const campaign = String(utmCampaign || '').trim().toLowerCase();

  // UTM-based attribution (most specific)
  if (source === 'gbp' || (source === 'google' && medium === 'organic' && campaign === 'gbp')) {
    const gbpLocation = findGbpLocationByUtmContent(utmContent);
    return {
      source: 'google_business',
      detail: gbpLocation ? `GBP ${gbpLocation.name}` : 'GBP unattributed',
      channel: 'organic',
      area: gbpLocation?.id || null,
    };
  }
  if (source === 'google' && medium === 'cpc') return { source: 'google_ads', detail: `Campaign: ${utmCampaign}`, channel: 'paid', area: utmContent };
  if (source === 'facebook' || source === 'fb') {
    // A deterministic Meta click id wins regardless of the medium label —
    // fbclid/_fbc only ride ad clicks (organic visits carry only _fbp), so
    // utm_medium=paid_social etc. with a click id is still a paid click.
    // Without one, only medium=cpc marks paid (unchanged).
    const isPaid = medium === 'cpc' || !!(fbclid || fbc);
    return { source: 'facebook', detail: `${utmMedium} — ${utmCampaign}`, channel: isPaid ? 'paid' : 'organic' };
  }
  if (source === 'nextdoor') return { source: 'nextdoor', detail: utmCampaign || '', channel: 'social' };
  // Google auto-tagging (the default) appends gclid — or wbraid/gbraid for
  // iOS/web-to-app — to ad-click landing URLs WITHOUT utm_source/medium, so an
  // auto-tagged paid click would otherwise fall through to the organic/referrer
  // default and never count as Google Ads. The Google analog of the Meta fbclid
  // branch below. (Explicit utm_source=google&cpc above still wins, with richer detail.)
  if (gclid || wbraid || gbraid) {
    return { source: 'google_ads', detail: utmCampaign ? `Campaign: ${utmCampaign}` : 'Google Ads click (gclid)', channel: 'paid', area: utmContent };
  }
  // Meta auto-appends fbclid to ad-click landing URLs even without explicit UTMs;
  // _fbc is its cookie form (survives navigation when the URL fbclid is lost). A
  // lead carrying either, with no clearer source above, is a paid Meta click.
  // (_fbp alone is NOT counted — Meta sets it on every visit, organic included.)
  if (fbclid || fbc) return { source: 'facebook', detail: fbclid ? 'Meta click (fbclid)' : 'Meta click (_fbc)', channel: 'paid' };

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
    // Anchor single-word cities to the "-fl" city/quote-page suffix so an incidental
    // mention in a slug isn't read as a city — most importantly "palmetto-bug" (a FL
    // cockroach) must NOT resolve to Palmetto and skew office routing. Compound names
    // (north-port, lakewood-ranch) are unambiguous on their own and need no anchor.
    const HUB_CITIES = [
      [/north[-_ ]?port/i, 'North Port'], [/lakewood[-_ ]?ranch/i, 'Lakewood Ranch'],
      [/bradenton-fl/i, 'Bradenton'], [/parrish-fl/i, 'Parrish'], [/sarasota-fl/i, 'Sarasota'],
      [/venice-fl/i, 'Venice'], [/palmetto-fl/i, 'Palmetto'], [/ellenton-fl/i, 'Ellenton'],
    ];
    const hit = HUB_CITIES.find(([re]) => re.test(path));
    return { source: 'waves_website', detail: seg ? `${seg} page` : 'Main site', channel: 'organic', area: hit ? hit[1] : undefined };
  }

  return { source: utmSource || 'website', detail: utmMedium || '', channel: 'unknown' };
}

module.exports = { determineLeadSource, SPOKE_DOMAIN_KEYS, SPOKE_AREA };

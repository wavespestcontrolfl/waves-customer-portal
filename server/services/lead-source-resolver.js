const db = require('../models/db');
const { findGbpLocationByUtmContent } = require('../config/locations');
const { AI_ASSISTANT_SOURCE_TYPE, AI_ASSISTANT_LEAD_SOURCE_NAME } = require('./ai-referral-sources');
const { classifyAttributionSignals } = require('./lead-source-evidence');

const MAIN_SITE_NAME = 'Main Site (wavespestcontrol.com)';
// Seeded by migration 20260827000001. Web-form paid-Google leads go here so
// form vs call conversions stay separable in source ROI. Matched by NAME:
// source_type='google_ads' is shared by the call-extension number AND the
// phone-less call-reporting bridge row, so neither source_type nor
// "phone-less" identifies the web-form row.
const GOOGLE_ADS_WEB_FORM_NAME = 'Google Ads — Web Form';

const SPOKE_DOMAIN_TO_SOURCE_NAME = {
  'parrishfllawncare.com': 'Spoke Lawn — parrishfllawncare.com',
  'bradentonfllawncare.com': 'Spoke Lawn — bradentonfllawncare.com',
  'sarasotafllawncare.com': 'Spoke Lawn — sarasotafllawncare.com',
  'venicelawncare.com': 'Spoke Lawn — venicelawncare.com',
  'waveslawncare.com': 'Spoke Lawn — waveslawncare.com',
  'parrishpestcontrol.com': 'Spoke Pest — parrishpestcontrol.com',
  'parrishexterminator.com': 'Spoke Pest — parrishexterminator.com',
  'palmettoflpestcontrol.com': 'Spoke Pest — palmettoflpestcontrol.com',
  'palmettoexterminator.com': 'Spoke Pest — palmettoexterminator.com',
  'bradentonflpestcontrol.com': 'Spoke Pest — bradentonflpestcontrol.com',
  'bradentonflexterminator.com': 'Spoke Pest — bradentonflexterminator.com',
  'sarasotaflpestcontrol.com': 'Spoke Pest — sarasotaflpestcontrol.com',
  'sarasotaflexterminator.com': 'Spoke Pest — sarasotaflexterminator.com',
  'veniceflpestcontrol.com': 'Spoke Pest — veniceflpestcontrol.com',
  'veniceexterminator.com': 'Spoke Pest — veniceexterminator.com',
  'northportflpestcontrol.com': 'Spoke Pest — northportflpestcontrol.com',
};

function extractHost(url) {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return null; }
}

// Resolve a referrer/landing pair to the right lead_sources row. Spoke domains
// take precedence — if a user clicks through from parrishfllawncare.com, that's
// the attribution, even though they fill the form on wavespestcontrol.com.
// Falls back to the Main Site row, which is the catch-all for organic traffic
// to the portal. is_active is intentionally NOT filtered: even paused-for-cost
// rows still represent the true acquisition channel.
// Tightest destination column wins: estimates.lead_source_detail is
// varchar(255), customers.lead_source_detail is varchar(200). Cap at 200 so
// the same value writes safely to both. UTM-heavy referrer URLs blow past
// that fast — a prefix label ("Spoke referrer: ") + URL must still fit.
const DETAIL_MAX_LEN = 200;
function clampDetail(s) {
  if (!s) return s;
  return s.length > DETAIL_MAX_LEN ? s.slice(0, DETAIL_MAX_LEN) : s;
}

async function resolveLeadSource(attribution) {
  const referrer = attribution?.referrer || null;
  const landing = attribution?.landing_url || null;
  const utm = attribution?.utm && typeof attribution.utm === 'object' ? attribution.utm : {};
  const referrerHost = extractHost(referrer);
  const landingHost = extractHost(landing);

  let targetName = MAIN_SITE_NAME;
  let detail = null;
  let metaPaid = false;
  let googlePaid = false;
  let aiReferral = false;
  let organicSocialSource = null;

  const classified = classifyAttributionSignals(attribution);

  if (classified.bucket === 'google_business' && classified.reason === 'gbp_tags') {
    const loc = findGbpLocationByUtmContent(utm.content);
    if (loc) {
      targetName = `GBP — ${loc.name}`;
      detail = `GBP website link: ${loc.gbpUtmContent}`;
    } else {
      detail = `GBP website link: ${utm.content || 'unknown profile'}`;
    }
  } else if (classified.bucket === 'google_business') {
    targetName = 'Google Business Profile';
    detail = 'Google Maps referral';
  } else if (classified.bucket === 'google_ads') {
    // Paid Google click — attribute to Google Ads, NOT the Main Site / spoke it
    // landed on. Resolved by source_type (a stable column) so it finds whatever
    // Google Ads lead_sources row exists (or leaves it null — never Main Site).
    googlePaid = true;
    targetName = 'Google Ads';
    detail = classified.reason === 'paid_tags'
      ? `Google paid campaign${utm.campaign ? `: ${String(utm.campaign).slice(0, 80)}` : ''}`
      : `Google Ads click (${classified.reason})`;
  } else if (classified.bucket === 'meta_ads') {
    // Meta paid click (fbclid/_fbc, or utm_source=facebook) — attribute to
    // Facebook, NOT the Main Site / spoke landing it happened to land on. Mirrors
    // the webhook's determineLeadSource. Resolves the FK by a LIKE lookup so it
    // finds whatever Facebook lead_sources row exists (or leaves it null — never
    // Main Site).
    metaPaid = true;
    targetName = 'Facebook';
    detail = classified.reason === 'paid_tags'
      ? `Meta paid campaign${utm.campaign ? `: ${String(utm.campaign).slice(0, 80)}` : ''}`
      : `Meta click (${classified.reason === 'fbc' ? '_fbc' : 'fbclid'})`;
  } else if (classified.bucket === 'ai') {
    // Organic, not paid — checked before the spoke/Main-Site fallback so an
    // AI-referred visit isn't silently folded into a spoke or "Main Site"
    // row. Resolved by source_type below (stable even if the office renames
    // the seeded row), mirroring the google/meta paid lookups above.
    aiReferral = true;
    targetName = AI_ASSISTANT_LEAD_SOURCE_NAME;
    detail = `AI assistant referral (${classified.ai.detail})`;
  } else if (classified.bucket === 'organic_social') {
    // An unpaid facebook/instagram campaign is organic social. Do not resolve
    // it to the paid Facebook call-extension row merely because the platform
    // name is shared. There is no dedicated organic lead_sources seed, so the
    // evidence stays in extracted_data and the FK deliberately remains null.
    organicSocialSource = classified.socialName;
    targetName = classified.socialName === 'Nextdoor' ? 'Nextdoor' : `${classified.socialName} (organic)`;
    detail = `Organic ${classified.socialName} referral`;
  } else if (referrerHost && SPOKE_DOMAIN_TO_SOURCE_NAME[referrerHost]) {
    targetName = SPOKE_DOMAIN_TO_SOURCE_NAME[referrerHost];
    detail = `Spoke referrer: ${referrer}`;
  } else if (landingHost && SPOKE_DOMAIN_TO_SOURCE_NAME[landingHost]) {
    targetName = SPOKE_DOMAIN_TO_SOURCE_NAME[landingHost];
    detail = `Spoke landing: ${landing}`;
  } else if (classified.bucket === 'organic_search') {
    detail = `${classified.searchName} organic search`;
  } else if (classified.bucket === 'referral') {
    detail = `Referral host: ${classified.referrerHost}`;
  } else if (referrer) {
    detail = 'Recorded website referrer';
  } else if (landing) {
    detail = 'Recorded website landing';
  }

  let row = null;
  try {
    if (metaPaid) {
      row = await db('lead_sources').whereRaw("LOWER(name) LIKE '%facebook%'").first();
    } else if (googlePaid) {
      // Several google_ads rows exist (call-extension number, call-reporting
      // bridge, web form). This is the web path: the web-form row by name,
      // and FAIL CLOSED if it is missing — any other google_ads row is a call
      // row, and a web conversion counted as a call is the exact ROI
      // contamination this exists to prevent. sourceType below still reports
      // 'google_ads' with leadSourceId null, and the dashboard's
      // leads_unattributed_7d alert surfaces the missing row.
      row = await db('lead_sources').where({ name: GOOGLE_ADS_WEB_FORM_NAME }).first();
    } else if (aiReferral) {
      // Matched by source_type (seed: migration
      // 20260928030000_ai_assistant_lead_source.js) rather than name — stable
      // even if the office renames the row, mirroring the google/meta paid
      // lookups above.
      row = await db('lead_sources').where({ source_type: AI_ASSISTANT_SOURCE_TYPE }).first();
    } else if (organicSocialSource === 'Nextdoor') {
      row = await db('lead_sources').where({ name: 'Nextdoor' }).first();
    } else if (!organicSocialSource) {
      row = await db('lead_sources').where({ name: targetName }).first();
    }
  } catch { /* swallow — caller still gets the classified strings even if FK lookup fails */ }

  // A PAID click needs paid evidence: a click id, or an explicit cpc medium.
  // metaPaid alone is NOT that — it classifies any utm_source=facebook (organic
  // social included) into the Facebook channel, and the funnel map marks that
  // channel paid. Mirrors the webhook's determineLeadSource, where facebook is
  // channel='paid' only for cpc/click-id traffic.
  const isPaidClick = googlePaid || metaPaid;

  return {
    leadSourceId: row?.id || null,
    leadSourceName: row?.name || targetName,
    leadSourceDetail: clampDetail(detail),
    // lead_sources.source_type — the key the ad-funnel channel map
    // (ads/call-attribution attributionForSourceType) is keyed on. Paid
    // classifications keep their type even when the FK row is missing;
    // anything else without a row stays null (no funnel row, fail-closed).
    // AI referrals mirror that same "keep the type even if the row lookup
    // ever misses" shape, though the seed migration means it normally won't.
    sourceType: row?.source_type || (googlePaid ? 'google_ads' : metaPaid ? 'facebook' : ['Facebook', 'Instagram'].includes(organicSocialSource) ? 'facebook_organic' : aiReferral ? AI_ASSISTANT_SOURCE_TYPE : null),
    isPaidClick,
  };
}

module.exports = { resolveLeadSource, MAIN_SITE_NAME, GOOGLE_ADS_WEB_FORM_NAME, SPOKE_DOMAIN_TO_SOURCE_NAME };

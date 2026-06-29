const db = require('../models/db');
const { findGbpLocationByUtmContent, isGbpUtmCampaign } = require('../config/locations');

const MAIN_SITE_NAME = 'Main Site (wavespestcontrol.com)';

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

  const utmSrc = String(utm.source || '').toLowerCase();
  const utmMed = String(utm.medium || '').toLowerCase();
  const isMetaClick = utmSrc === 'facebook' || utmSrc === 'fb'
    || !!attribution?.fbclid || !!attribution?.fbc;
  // Google auto-tagging appends gclid (or wbraid/gbraid for iOS/web-to-app) to
  // ad-click landing URLs WITHOUT utm_source/medium, so a click-only paid click
  // would otherwise fall through to Main Site and never count as Google Ads. The
  // Google analog of the Meta branch below — mirrors the webhook's
  // determineLeadSource. (Explicit utm_source=google&cpc also qualifies.)
  const isGoogleAdsClick = (utmSrc === 'google' && utmMed === 'cpc')
    || !!attribution?.gclid || !!attribution?.wbraid || !!attribution?.gbraid;

  if (isGbpUtmCampaign({ source: utm.source, medium: utm.medium, campaign: utm.campaign })) {
    const loc = findGbpLocationByUtmContent(utm.content);
    if (loc) {
      targetName = `GBP — ${loc.name}`;
      detail = `GBP website link: ${loc.gbpUtmContent}`;
    } else {
      detail = `GBP website link: ${utm.content || 'unknown profile'}`;
    }
  } else if (isGoogleAdsClick) {
    // Paid Google click — attribute to Google Ads, NOT the Main Site / spoke it
    // landed on. Resolved by source_type (a stable column) so it finds whatever
    // Google Ads lead_sources row exists (or leaves it null — never Main Site).
    googlePaid = true;
    targetName = 'Google Ads';
    detail = attribution?.gclid ? 'Google Ads click (gclid)'
      : attribution?.wbraid ? 'Google Ads click (wbraid)'
        : attribution?.gbraid ? 'Google Ads click (gbraid)'
          : `google ${utm.medium || ''} ${utm.campaign || ''}`.trim();
  } else if (isMetaClick) {
    // Meta paid click (fbclid/_fbc, or utm_source=facebook) — attribute to
    // Facebook, NOT the Main Site / spoke landing it happened to land on. Mirrors
    // the webhook's determineLeadSource. Resolves the FK by a LIKE lookup so it
    // finds whatever Facebook lead_sources row exists (or leaves it null — never
    // Main Site).
    metaPaid = true;
    targetName = 'Facebook';
    detail = attribution?.fbclid ? 'Meta click (fbclid)'
      : attribution?.fbc ? 'Meta click (_fbc)'
        : `facebook ${utm.medium || ''} ${utm.campaign || ''}`.trim();
  } else if (referrerHost && SPOKE_DOMAIN_TO_SOURCE_NAME[referrerHost]) {
    targetName = SPOKE_DOMAIN_TO_SOURCE_NAME[referrerHost];
    detail = `Spoke referrer: ${referrer}`;
  } else if (landingHost && SPOKE_DOMAIN_TO_SOURCE_NAME[landingHost]) {
    targetName = SPOKE_DOMAIN_TO_SOURCE_NAME[landingHost];
    detail = `Spoke landing: ${landing}`;
  } else if (referrer) {
    detail = `Referrer: ${referrer}`;
  } else if (landing) {
    detail = `Landing: ${landing}`;
  }

  let row = null;
  try {
    if (metaPaid) {
      row = await db('lead_sources').whereRaw("LOWER(name) LIKE '%facebook%'").first();
    } else if (googlePaid) {
      row = await db('lead_sources').where({ source_type: 'google_ads' }).first();
    } else {
      row = await db('lead_sources').where({ name: targetName }).first();
    }
  } catch { /* swallow — caller still gets the classified strings even if FK lookup fails */ }

  return {
    leadSourceId: row?.id || null,
    leadSourceName: row?.name || targetName,
    leadSourceDetail: clampDetail(detail),
  };
}

module.exports = { resolveLeadSource, MAIN_SITE_NAME, SPOKE_DOMAIN_TO_SOURCE_NAME };

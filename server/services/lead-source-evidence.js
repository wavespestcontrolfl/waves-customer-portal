/**
 * Operator-safe lead source evidence.
 *
 * Raw attribution remains available to the existing attribution pipeline. This
 * module deliberately emits only a small, display-safe explanation: no full
 * URL, query string, click id, or submitted contact value is returned.
 * `direct` is the one classification that requires the browser's explicit
 * `observed: true` marker. Missing attribution on an older row is unknown, not
 * direct.
 */
const { findAiAssistant, hostnameOf } = require('./ai-referral-sources');
const { SPOKE_SITES } = require('./content-astro/spoke-sites');
const { findGbpLocationByUtmContent } = require('../config/locations');

const EVIDENCE_KINDS = new Set([
  'google_ads', 'google_business', 'meta_ads', 'organic_search',
  'organic_social', 'direct', 'chatgpt', 'copilot', 'other_ai',
  'referral', 'website', 'email', 'offline', 'unknown',
]);

const SOURCE_EVIDENCE_KIND_LITERALS = [...EVIDENCE_KINDS].map((kind) => `'${kind}'`).join(', ');

// SQL fragments below accept only route-owned SQL expressions (never request
// text). They keep the definition of a persisted, displayable evidence object
// aligned with sourceEvidenceLabelSql: known kind plus nonblank label/basis.
function validSourceEvidenceJsonSql(evidenceSql) {
  return `jsonb_typeof(${evidenceSql}) = 'object'
    AND (${evidenceSql}->>'kind') IN (${SOURCE_EVIDENCE_KIND_LITERALS})
    AND NULLIF(BTRIM(${evidenceSql}->>'label'), '') IS NOT NULL
    AND NULLIF(BTRIM(${evidenceSql}->>'basis'), '') IS NOT NULL`;
}

function firstSourceEvidenceObjectSql({
  storedDataSql = "COALESCE(extracted_data, '{}'::jsonb)",
  incomingDataSql,
}) {
  if (!incomingDataSql) throw new Error('incomingDataSql is required');
  const stored = `(${storedDataSql})->'source_evidence'`;
  const incoming = `(${incomingDataSql})->'source_evidence'`;
  return `CASE
    WHEN ${validSourceEvidenceJsonSql(stored)}
      THEN jsonb_build_object('source_evidence', ${stored})
    WHEN ${validSourceEvidenceJsonSql(incoming)}
      THEN jsonb_build_object('source_evidence', ${incoming})
    ELSE '{}'::jsonb
  END`;
}

const PAID_MEDIA = new Set([
  'cpc', 'ppc', 'paid', 'paid_search', 'paidsearch',
  'paid_social', 'paidsocial',
]);

const CALL_ORIGIN_CHANNELS = new Set(['phone', 'call', 'inbound_call']);
const CALL_ORIGIN_LEAD_TYPES = new Set(['inbound_call', 'voicemail']);

const GOOGLE_SOURCES = new Set(['google', 'adwords', 'google_ads', 'googleads']);
const META_SOURCES = new Set(['facebook', 'fb', 'meta', 'instagram', 'ig']);
const PAID_PLACEMENTS = [
  { bucket: 'google_ads', sources: GOOGLE_SOURCES, clickIds: ['gclid', 'wbraid', 'gbraid'] },
  { bucket: 'meta_ads', sources: META_SOURCES, clickIds: ['fbclid', 'fbc'] },
];
const ORGANIC_SEARCH_MEDIA = new Set(['', 'organic', 'search', 'organic_search', 'organicsearch', 'seo']);
const ORGANIC_SOCIAL_MEDIA = new Set(['', 'organic', 'social', 'organic_social', 'organicsocial', 'referral']);
const SEARCH_TAGS = new Map([
  ...Array.from(GOOGLE_SOURCES, (source) => [source, 'Google']),
  ['bing', 'Bing'], ['duckduckgo', 'DuckDuckGo'],
]);
const SOCIAL_TAGS = new Map([
  ['facebook', 'Facebook'], ['fb', 'Facebook'], ['meta', 'Facebook'],
  ['instagram', 'Instagram'], ['ig', 'Instagram'], ['nextdoor', 'Nextdoor'],
  ['linkedin', 'LinkedIn'], ['twitter', 'X'], ['x', 'X'],
]);

const SEARCH_HOSTS = new Map([
  ['google.com', 'Google'], ['bing.com', 'Bing'],
  ['duckduckgo.com', 'DuckDuckGo'], ['search.yahoo.com', 'Yahoo'],
  ['search.brave.com', 'Brave Search'], ['ecosia.org', 'Ecosia'],
]);

const SOCIAL_HOSTS = new Map([
  ['facebook.com', 'Facebook'], ['m.facebook.com', 'Facebook'],
  ['l.facebook.com', 'Facebook'], ['lm.facebook.com', 'Facebook'],
  ['instagram.com', 'Instagram'], ['l.instagram.com', 'Instagram'],
  ['nextdoor.com', 'Nextdoor'], ['linkedin.com', 'LinkedIn'],
  ['t.co', 'X'], ['x.com', 'X'], ['twitter.com', 'X'],
]);

const OWN_HOSTS = new Set([
  'wavespestcontrol.com', 'portal.wavespestcontrol.com',
  'waveslawncare.com',
  ...SPOKE_SITES.map((site) => site.key),
]);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalized(value) {
  return text(value).toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * The call writers preserve first_contact_channel when a later browser form
 * attaches to the same row. Older call rows can lack that field, so their
 * call-only lead_type is the fallback. A CallSid alone is deliberately not
 * proof: a web-first lead can be linked to a later call without changing its
 * original acquisition channel.
 */
function isCallOriginLead(lead = {}) {
  const contact = text(lead.first_contact_channel).toLowerCase();
  if (CALL_ORIGIN_CHANNELS.has(contact)) return true;
  return !contact && CALL_ORIGIN_LEAD_TYPES.has(text(lead.lead_type).toLowerCase());
}

// `facebook` is a historically shared web/call source row. Positively calling
// it Meta Ads therefore needs the complete phone-placement proof, not merely
// the shared source_type: a call-only lead type, call-origin channel, its
// initiating CallSid, and the registry row's paid channel.
function hasMetaCallPlacementEvidence(lead = {}) {
  return CALL_ORIGIN_LEAD_TYPES.has(text(lead.lead_type).toLowerCase())
    && CALL_ORIGIN_CHANNELS.has(text(lead.first_contact_channel).toLowerCase())
    && !!text(lead.twilio_call_sid)
    && text(lead.source_type).toLowerCase() === 'facebook'
    && text(lead.source_channel).toLowerCase() === 'paid';
}

function attributionParts(attribution = {}) {
  const attr = attribution && typeof attribution === 'object' ? attribution : {};
  const utm = attr.utm && typeof attr.utm === 'object' ? attr.utm : {};
  return {
    observed: attr.observed === true,
    referrer: text(attr.referrer),
    landing: text(attr.landing_url || attr.landingUrl),
    source: normalized(utm.source || attr.utmSource || attr.utm_source),
    medium: normalized(utm.medium || attr.utmMedium || attr.utm_medium),
    campaign: normalized(utm.campaign || attr.utmCampaign || attr.utm_campaign),
    term: text(utm.term || attr.utmTerm || attr.utm_term),
    content: text(utm.content || attr.utmContent || attr.utm_content),
    gclid: text(attr.gclid),
    wbraid: text(attr.wbraid),
    gbraid: text(attr.gbraid),
    fbclid: text(attr.fbclid),
    fbc: text(attr.fbc),
  };
}

function rootHost(value) {
  const host = hostnameOf(value);
  if (!host) return null;
  // Search is exact-host only: docs.google.com and mail.google.com are Google
  // products, not evidence of a Google Search result.
  if (SEARCH_HOSTS.has(host)) return host;
  for (const candidate of [...SOCIAL_HOSTS.keys(), ...OWN_HOSTS]) {
    if (host === candidate || host.endsWith(`.${candidate}`)) return candidate;
  }
  return host;
}

function isGoogleMapsReferral(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    return (host === 'google.com' || host.endsWith('.google.com'))
      && (url.pathname === '/maps' || url.pathname.startsWith('/maps/'));
  } catch { return false; }
}

function evidence(kind, label, detail, basis) {
  return { kind, label, detail: detail || null, basis };
}

// The website uses this same placement order for its phone-number swap.
function classifyPlacement(p) {
  if (p.source === 'gbp' || (GOOGLE_SOURCES.has(p.source) && p.medium === 'organic' && p.campaign === 'gbp')) {
    return { bucket: 'google_business', reason: 'gbp_tags' };
  }
  if (isGoogleMapsReferral(p.referrer)) return { bucket: 'google_business', reason: 'google_maps' };
  for (const { bucket, sources, clickIds } of PAID_PLACEMENTS) {
    const clickId = clickIds.find((key) => p[key]);
    if (clickId) return { bucket, reason: clickId };
    if (sources.has(p.source) && PAID_MEDIA.has(p.medium)) return { bucket, reason: 'paid_tags' };
  }
  return null;
}

/**
 * One normalized precedence decision for every portal server consumer.
 * `reason` describes the machine signal; callers choose their own persisted or
 * operator-facing copy. GBP/Maps suppress stale ad cookies, then Google wins a
 * cross-platform click conflict, then Meta.
 */
function classifyAttributionSignals(attribution) {
  const p = attributionParts(attribution);
  const referrerHost = rootHost(p.referrer);
  const placement = classifyPlacement(p);
  if (placement) return { ...placement, p, referrerHost };

  const ai = findAiAssistant(p.source, hostnameOf(p.referrer));
  if (ai) return { bucket: 'ai', reason: 'ai_referral', ai, p, referrerHost };

  const socialName = ORGANIC_SOCIAL_MEDIA.has(p.medium) ? SOCIAL_TAGS.get(p.source) || SOCIAL_HOSTS.get(referrerHost) : null;
  if (socialName) return { bucket: 'organic_social', reason: 'social_referral', socialName, p, referrerHost };

  const taggedSearchName = ORGANIC_SEARCH_MEDIA.has(p.medium) ? SEARCH_TAGS.get(p.source) : null;
  const searchName = p.source ? taggedSearchName : SEARCH_HOSTS.get(referrerHost);
  if (searchName) return { bucket: 'organic_search', reason: 'search_referral', searchName, p, referrerHost };

  if (referrerHost) {
    return OWN_HOSTS.has(referrerHost)
      ? { bucket: 'website', reason: 'own_site_referrer', p, referrerHost }
      : { bucket: 'referral', reason: 'external_referrer', p, referrerHost };
  }
  const hasCampaignSignal = [p.source, p.medium, p.campaign, p.content, p.term].some(Boolean);
  if (p.observed && !p.referrer && !hasCampaignSignal) {
    return { bucket: 'direct', reason: 'observed_empty_referrer', p, referrerHost };
  }
  if (p.landing) return { bucket: 'website', reason: 'landing_only', p, referrerHost };
  return { bucket: 'unknown', reason: 'no_evidence', p, referrerHost };
}

function aiEvidence(ai) {
  if (!ai) return null;
  if (ai.detail === 'ChatGPT') {
    return evidence('chatgpt', 'ChatGPT', 'AI search · Referral', 'Observed a ChatGPT referral host or campaign tag.');
  }
  if (ai.detail === 'Copilot') {
    return evidence('copilot', 'Microsoft Copilot', 'AI search · Referral', 'Observed a Microsoft Copilot referral host or campaign tag.');
  }
  return evidence('other_ai', ai.detail || 'AI referral', 'AI search · Referral', `Observed a ${ai.detail || 'known AI assistant'} referral host or campaign tag.`);
}

/** Build evidence from one browser-captured first touch. */
function sourceEvidenceFromAttribution(attribution) {
  const classified = classifyAttributionSignals(attribution);
  const { p } = classified;

  if (classified.bucket === 'google_business' && classified.reason === 'gbp_tags') {
    const location = findGbpLocationByUtmContent(p.content);
    return evidence(
      'google_business',
      'Google Business Profile',
      location ? `GBP — ${location.name}` : 'Profile website visit',
      location
        ? `Observed Google Business Profile campaign tags for ${location.name}.`
        : 'Observed Google Business Profile campaign tags.',
    );
  }
  if (classified.bucket === 'google_business') {
    return evidence('google_business', 'Google Maps', 'Maps listing visit', 'Observed a Google Maps referral.');
  }
  if (classified.bucket === 'google_ads' && classified.reason !== 'paid_tags') {
    return evidence('google_ads', 'Google Ads', 'Paid search click', `Classified as Google Ads from the recorded ${classified.reason} click identifier.`);
  }
  if (classified.bucket === 'google_ads') {
    return evidence('google_ads', 'Google Ads', 'Paid search campaign', 'Observed Google paid-search campaign tags.');
  }
  if (classified.bucket === 'meta_ads' && classified.reason !== 'paid_tags') {
    return evidence('meta_ads', 'Meta Ads', 'Meta-routed click', `The landing link carried a ${classified.reason === 'fbc' ? 'Facebook click cookie' : 'Facebook click ID'}. Waves groups those links under Meta Ads.`);
  }
  if (classified.bucket === 'meta_ads') {
    return evidence('meta_ads', 'Meta Ads', 'Paid social campaign', 'Observed Meta paid-social campaign tags.');
  }
  if (classified.bucket === 'ai') return aiEvidence(classified.ai);
  if (classified.bucket === 'organic_social') {
    return evidence('organic_social', 'Organic social', classified.socialName, `Observed an unpaid ${classified.socialName} referral or campaign tag.`);
  }
  if (classified.bucket === 'organic_search') {
    return evidence('organic_search', 'Organic search', classified.searchName, `Observed an unpaid ${classified.searchName} search referral.`);
  }
  if (classified.bucket === 'referral') {
    return evidence('referral', 'Referral', classified.referrerHost, 'Observed an external referring website host.');
  }
  if (classified.bucket === 'website' && classified.reason === 'own_site_referrer') {
    return evidence('website', 'Website', 'Waves website', 'Observed navigation from a Waves website.');
  }
  if (classified.bucket === 'direct') {
    return evidence('direct', 'Direct', 'No referring site', 'The browser reported no referrer. A typed address, bookmark or app can all look this way.');
  }
  if (classified.bucket === 'website') {
    return evidence('website', 'Website', 'Website intake', 'A website landing page was recorded without a verifiable acquisition source.');
  }
  return null;
}

function parseExtracted(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function safePersistedEvidence(value) {
  if (!value || typeof value !== 'object' || !EVIDENCE_KINDS.has(value.kind)) return null;
  const label = text(value.label).slice(0, 80);
  const basis = text(value.basis).slice(0, 240);
  if (!label || !basis) return null;
  const detail = text(value.detail).slice(0, 120) || null;
  return { kind: value.kind, label, detail, basis };
}

const UNKNOWN = () => evidence('unknown', 'Source unknown', null, 'No verified source evidence was captured for this lead.');

/** Present persisted evidence, with conservative historical fallbacks. */
function sourceEvidenceForLead(lead = {}) {
  const extracted = parseExtracted(lead.extracted_data);
  const persisted = safePersistedEvidence(extracted.source_evidence);
  if (persisted) return persisted;

  // A later quote can attach to an open call lead and populate browser click
  // ids on that same row. Those ids describe the later browser visit, not the
  // original call acquisition. The original registry placement below wins for
  // call-origin rows; web-first rows continue to use their click ids.
  const callOrigin = isCallOriginLead(lead);
  if (!callOrigin && [lead.gclid, lead.wbraid, lead.gbraid].some((value) => text(value))) {
    return evidence('google_ads', 'Google Ads', 'Paid search click', 'A Google Ads click identifier is stored on this lead.');
  }
  if (!callOrigin && [lead.fbclid, lead.fbc].some((value) => text(value))) {
    return evidence('meta_ads', 'Meta Ads', 'Meta-routed click', 'Waves groups links that carry a Facebook click identifier under Meta Ads.');
  }

  const type = normalized(lead.source_type);
  const channel = normalized(lead.source_channel);
  const sourceName = text(lead.source_name);
  const contact = normalized(lead.first_contact_channel);
  if (type === 'google_ads') return evidence('google_ads', 'Google Ads', sourceName || 'Paid search', 'The recorded lead source is a Google Ads source.');
  if (type === 'gbp' || (type === 'website_organic' && /google business/i.test(sourceName))) {
    return evidence('google_business', 'Google Business Profile', sourceName || null, 'The recorded lead source is a Google Business Profile.');
  }
  if ((type === 'main_site' || type === 'spoke_site' || channel === 'website_organic')
    && callOrigin) {
    return evidence('unknown', 'Source unknown', 'Shared phone line', 'The historical source record names a shared website phone line and does not prove how the caller found Waves.');
  }
  if (type === 'main_site' || type === 'spoke_site' || channel === 'website_organic') {
    return evidence('website', 'Website', sourceName || 'Website intake', 'The recorded lead source is a Waves website.');
  }
  if (type === 'referral') return evidence('referral', 'Referral', sourceName || null, 'The recorded lead source is a customer referral.');
  if (type === 'email') return evidence('email', 'Email inquiry', sourceName || null, 'The lead was received through the recorded email inquiry source.');
  if (['vehicle', 'walk_in'].includes(type) || channel === 'offline') {
    return evidence('offline', sourceName || 'Offline', null, 'The recorded lead source is an offline channel.');
  }

  // Historical Facebook rows were written to one shared bucket by both paid
  // and organic paths. The shared AI row likewise cannot identify which
  // assistant sent the visit. Do not invent precision from either.
  if (type === 'ai_assistant') {
    return evidence('other_ai', 'AI assistant referral', 'Provider unverified', 'The recorded source proves an AI assistant referral, but the provider was not captured.');
  }
  if (hasMetaCallPlacementEvidence(lead)) {
    return evidence('meta_ads', 'Meta Ads', sourceName || 'Meta Ads call line', 'The originating call used the recorded paid Meta call placement.');
  }
  if (type === 'facebook') {
    return evidence('unknown', 'Source unknown', null, 'The historical source record is shared and does not prove the specific acquisition source.');
  }

  if (['form', 'website_quote'].includes(contact)) {
    return evidence('website', 'Website', 'Website intake', 'The lead was received through a website intake, but no referrer evidence was captured.');
  }
  if (contact === 'email') return evidence('email', 'Email inquiry', null, 'The lead was received through email.');
  if (['manual', 'phone', 'call', 'inbound_call'].includes(contact)) {
    return evidence('unknown', 'Source unknown', contact === 'manual' ? 'Manual intake' : 'Shared phone line', 'The intake channel does not prove the acquisition source.');
  }
  if (lead.heard_about) {
    return evidence('unknown', 'Source unknown', 'Self-reported only', 'A self-reported answer exists, but no technical source evidence was captured.');
  }
  return UNKNOWN();
}

function withSourceEvidence(rows) {
  return rows.map((row) => ({ ...row, source_evidence: sourceEvidenceForLead(row) }));
}

/**
 * SQL label expression matching sourceEvidenceForLead for list sorting before
 * LIMIT/OFFSET. The persisted server-owned label wins; historical fallbacks
 * intentionally stay conservative.
 */
function sourceEvidenceLabelSql(db) {
  // SQL twins of isCallOriginLead and hasMetaCallPlacementEvidence. Keep the
  // predicates and branch order aligned with sourceEvidenceForLead so source
  // sorting before LIMIT/OFFSET uses the same label the row later displays.
  const contactSql = "LOWER(BTRIM(COALESCE(leads.first_contact_channel, '')))";
  const typeSql = "LOWER(BTRIM(COALESCE(leads.lead_type, '')))";
  const callOriginSql = `((${contactSql}) IN ('phone', 'call', 'inbound_call')
    OR ((${contactSql}) = '' AND (${typeSql}) IN ('inbound_call', 'voicemail')))`;
  const metaCallPlacementSql = `((${typeSql}) IN ('inbound_call', 'voicemail')
    AND (${contactSql}) IN ('phone', 'call', 'inbound_call')
    AND NULLIF(BTRIM(leads.twilio_call_sid), '') IS NOT NULL
    AND LOWER(BTRIM(COALESCE(lead_sources.source_type, ''))) = 'facebook'
    AND LOWER(BTRIM(COALESCE(lead_sources.channel, ''))) = 'paid')`;
  return db.raw(`LOWER(CASE
    WHEN (leads.extracted_data->'source_evidence'->>'kind') IN (${[...EVIDENCE_KINDS].map(() => '?').join(', ')})
      AND NULLIF(BTRIM(leads.extracted_data->'source_evidence'->>'label'), '') IS NOT NULL
      AND NULLIF(BTRIM(leads.extracted_data->'source_evidence'->>'basis'), '') IS NOT NULL
      THEN LEFT(BTRIM(leads.extracted_data->'source_evidence'->>'label'), 80)
    WHEN NOT ${callOriginSql}
      AND COALESCE(NULLIF(BTRIM(leads.gclid), ''), NULLIF(BTRIM(leads.wbraid), ''), NULLIF(BTRIM(leads.gbraid), '')) IS NOT NULL THEN 'Google Ads'
    WHEN NOT ${callOriginSql}
      AND COALESCE(NULLIF(BTRIM(leads.fbclid), ''), NULLIF(BTRIM(leads.fbc), '')) IS NOT NULL THEN 'Meta Ads'
    WHEN lead_sources.source_type = 'google_ads' THEN 'Google Ads'
    WHEN lead_sources.source_type = 'gbp'
      OR (lead_sources.source_type = 'website_organic' AND lead_sources.name ILIKE '%Google Business%') THEN 'Google Business Profile'
    WHEN (lead_sources.source_type IN ('main_site', 'spoke_site') OR lead_sources.channel = 'website_organic')
      AND ${callOriginSql} THEN 'Source unknown'
    WHEN lead_sources.source_type IN ('main_site', 'spoke_site') OR lead_sources.channel = 'website_organic' THEN 'Website'
    WHEN lead_sources.source_type = 'referral' THEN 'Referral'
    WHEN lead_sources.source_type = 'email' THEN 'Email inquiry'
    WHEN lead_sources.source_type IN ('vehicle', 'walk_in') OR lead_sources.channel = 'offline' THEN COALESCE(NULLIF(lead_sources.name, ''), 'Offline')
    WHEN lead_sources.source_type = 'ai_assistant' THEN 'AI assistant referral'
    WHEN ${metaCallPlacementSql} THEN 'Meta Ads'
    WHEN lead_sources.source_type = 'facebook' THEN 'Source unknown'
    WHEN leads.first_contact_channel IN ('form', 'website_quote') THEN 'Website'
    WHEN leads.first_contact_channel = 'email' THEN 'Email inquiry'
    WHEN leads.first_contact_channel IN ('manual', 'phone', 'call', 'inbound_call') THEN 'Source unknown'
    ELSE 'Source unknown'
  END)`, [...EVIDENCE_KINDS]);
}

function attributionWithSourceEvidence(attribution) {
  if (!attribution || typeof attribution !== 'object') return attribution;
  const { source_evidence: _clientEvidence, ...safeAttribution } = attribution;
  const sourceEvidence = sourceEvidenceFromAttribution(attribution);
  if (!sourceEvidence) return safeAttribution;
  return { ...safeAttribution, source_evidence: sourceEvidence };
}

module.exports = {
  EVIDENCE_KINDS,
  SEARCH_HOSTS,
  SOCIAL_HOSTS,
  PAID_MEDIA,
  sourceEvidenceFromAttribution,
  sourceEvidenceForLead,
  sourceEvidenceLabelSql,
  withSourceEvidence,
  attributionWithSourceEvidence,
  isGoogleMapsReferral,
  classifyAttributionSignals,
  GOOGLE_SOURCES,
  META_SOURCES,
  validSourceEvidenceJsonSql,
  firstSourceEvidenceObjectSql,
};

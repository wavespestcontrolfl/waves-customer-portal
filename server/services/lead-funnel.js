/**
 * Lead funnel by source — per-channel stage progression from the
 * ad_service_attribution rows (Growth Command Center Phase 6).
 *
 * funnel_stage is a row's CURRENT state (lead → contacted → estimate_sent →
 * estimate_viewed → booked → completed, or terminal lost), so the funnel
 * counts "reached at least stage X" cumulatively: a row sitting at booked has
 * necessarily been contacted and estimated. `lost` rows collapse their
 * history — they count in the lead total and in `lost`, nothing between.
 *
 * DATA REALITY (why stagesPresent exists): today the attribution pipeline
 * only ever writes 'lead' at creation and patches 'completed' on sync — the
 * intermediate stages are schema, not live data. The card therefore renders
 * only the rungs that actually carry rows (stagesPresent), so it never
 * implies "0% contacted" for leads whose contact was simply never recorded.
 * The rungs light up automatically as stage tracking starts writing them.
 *
 * Paid semantics mirror channel-attribution's splitFacebookByPaid: a Meta
 * click id (fbclid/_fbc) OR the explicit is_paid flag marks a row paid — the
 * flag alone is NULL on most historical rows (prod-verified), and the paid
 * PLATFORM keys (google_ads / google_lsa) are paid by definition.
 *
 * Basis caveat (surfaced by the card): these are ATTRIBUTION rows, not the
 * raw leads table — totals will differ from Leads-by-Source (which counts
 * lead records), and call↔lead linkage is call-SID based. Pure / unit-testable.
 */

const { SPOKE_SITE_KEYS } = require('./content-astro/spoke-sites');
const { publicPortalUrl } = require('../utils/portal-url');
const { formatSourceName } = require('./source-names');

const pctOf = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

// Stages above (and including) each rung, for reached-at-least counting.
const REACHED = {
  contacted: new Set(['contacted', 'estimate_sent', 'estimate_viewed', 'booked', 'completed']),
  estimate: new Set(['estimate_sent', 'estimate_viewed', 'booked', 'completed']),
  booked: new Set(['booked', 'completed']),
  completed: new Set(['completed']),
};
const emptyGroup = () => ({ leads: 0, contacted: 0, estimate: 0, booked: 0, completed: 0, lost: 0, revenue: 0 });
// One current-state row's contribution: every rung it has reached, plus the
// completed revenue the attribution sync credited to it.
function tallyStage(g, stage, n, revenue) {
  g.leads += n;
  if (REACHED.contacted.has(stage)) g.contacted += n;
  if (REACHED.estimate.has(stage)) g.estimate += n;
  if (REACHED.booked.has(stage)) g.booked += n;
  if (REACHED.completed.has(stage)) g.completed += n;
  if (stage === 'lost') g.lost += n;
  g.revenue = Math.round((g.revenue + revenue) * 100) / 100;
}
const withRates = (g) => ({
  ...g,
  rates: {
    contactRate: pctOf(g.contacted, g.leads),
    estimateRate: pctOf(g.estimate, g.leads),
    bookRate: pctOf(g.booked, g.leads),
    completeRate: pctOf(g.completed, g.leads),
  },
});

/**
 * buildLeadFunnel(rows) — rows are GROUP BY (lead_source, funnel_stage,
 * paid-signal) counts: [{ lead_source, funnel_stage, is_paid, n }], where
 * is_paid is the EFFECTIVE paid signal (click id OR flag — the route computes
 * it in SQL so the flag's historical NULLs can't misfile paid Meta rows).
 */
function buildLeadFunnel(rows = []) {
  const bySource = new Map();
  const ensure = (key, isPaid) => {
    if (!bySource.has(key)) {
      bySource.set(key, { sourceKey: key, source: formatSourceName(key), isPaid: !!isPaid, ...emptyGroup() });
    }
    return bySource.get(key);
  };

  // Which intermediate rungs actually carry rows in this window — the card
  // renders only these (see DATA REALITY above).
  const present = { contacted: false, estimate: false, booked: false };

  for (const r of rows) {
    // Organic Facebook splits off the paid Meta bucket, mirroring
    // splitFacebookByPaid so the two panels can't disagree about what
    // "Facebook" means. r.is_paid here is the effective signal (click id OR
    // flag), so click-attributed paid Meta rows stay under Facebook.
    const rawKey = r.lead_source || 'unknown';
    const key = rawKey === 'facebook' && !r.is_paid ? 'facebook_organic' : rawKey;
    const n = parseInt(r.n, 10) || 0;
    // Paid = the paid PLATFORM keys plus effectively-flagged Meta rows.
    const isPaid = key === 'google_ads' || key === 'google_lsa' || (rawKey === 'facebook' && !!r.is_paid);
    const s = ensure(key, isPaid);
    s.isPaid = s.isPaid || isPaid;
    const stage = r.funnel_stage;
    if (n > 0) {
      if (stage === 'contacted') present.contacted = true;
      if (stage === 'estimate_sent' || stage === 'estimate_viewed') present.estimate = true;
      if (stage === 'booked') present.booked = true;
    }
    tallyStage(s, stage, n, Number(r.revenue) || 0);
  }

  const sources = [...bySource.values()]
    .map(withRates)
    .sort((a, b) => b.leads - a.leads || a.source.localeCompare(b.source));

  const totalOf = (filter) => {
    const t = emptyGroup();
    for (const s of sources) {
      if (filter && !filter(s)) continue;
      for (const k of Object.keys(t)) t[k] += s[k];
    }
    t.revenue = Math.round(t.revenue * 100) / 100;
    return { ...t, bookRate: pctOf(t.booked, t.leads), completeRate: pctOf(t.completed, t.leads) };
  };

  return {
    sources,
    stagesPresent: present,
    totals: totalOf(null),
    paid: totalOf((s) => s.isPaid),
    organic: totalOf((s) => !s.isPaid),
  };
}

// The same funnel along the other dimensions the AI-search plan asks for
// (landing page → lead → estimate → booked → revenue, by service and city),
// plus the visitor's own "How did you hear about us?" answer. That answer is
// self-reported, so it stays its own view and never re-labels a source; a
// missing value stays unknown rather than being guessed.
const UNKNOWN = '(unknown)';
const SERVICE_LABELS = {
  pest: 'Pest control', lawn: 'Lawn care', mosquito: 'Mosquito', termite: 'Termite',
  rodent: 'Rodent', tree_shrub: 'Tree & shrub', specialty: 'Specialty',
};
const HEARD_ABOUT_LABELS = {
  google_search: 'Google search', google_maps: 'Google Maps', chatgpt: 'ChatGPT',
  other_ai: 'Another AI assistant', facebook_instagram: 'Facebook / Instagram',
  nextdoor: 'Nextdoor', yelp: 'Yelp', friend_neighbor: 'Friend or neighbor',
  truck_yard_sign: 'Truck or yard sign', other: 'Other',
};
const BREAKDOWN_LABELS = {
  page: (k) => k,
  service: (k) => SERVICE_LABELS[k] || k,
  city: (k) => k,
  heard: (k) => HEARD_ABOUT_LABELS[k] || (k === UNKNOWN ? 'No answer (not asked or skipped)' : k),
};

// Group keys for the other views, as SQL over the route's aliases (asa =
// ad_service_attribution, l = leads, c = customers, sba =
// self_booked_appointments).
// Landing page: the lead's own captured page (lead webhook attribution.landingUrl
// / pageUrl, lawn assessment attribution.landing_url, quote wizard landing_url, a
// self-booking's attribution.landing_url), else (web leads only) the customer's
// first landing page; host + path, lower-cased, no scheme / www / query /
// fragment / trailing slash. Calls and tools that record no page stay
// '(unknown)'. heard: the visitor's self-reported answer, kept apart from
// observed attribution. chr(63) is '?', kept out of the SQL text because knex
// reads a bare ? as a binding.
// The customer's first landing page only stands in for a lead that itself came
// in on the web; a call, email or manual lead (or a row with no lead) keeps no
// page rather than inheriting one from an earlier, unrelated visit.
const WEB_FIRST_CONTACT_CHANNELS = [
  'form', 'web', 'website_quote', 'booking', 'lawn_assessment_funnel',
  'pest_identifier_funnel', 'lawn_diagnostic', 'lawn_diagnostic_report',
];
const WEB_CHANNELS_SQL = WEB_FIRST_CONTACT_CHANNELS.map((ch) => `'${ch}'`).join(', ');
// Only a page on a Waves site is a landing page. The webhook stores the
// visitor's referrer as pageUrl when the form sent no page (and the customer
// row copies it), so an off-site host (chatgpt.com, google.com) is a
// referrer, never a landing page. Hosts are the spoke registry (hub
// included), the canonical portal and the configured portal host, the same
// fleet cors-origins.js derives.
const OWNED_HOSTS = [...new Set([
  ...SPOKE_SITE_KEYS,
  'portal.wavespestcontrol.com', // canonical, whatever CLIENT_URL says (as in cors-origins.js)
  (() => { try { return new URL(publicPortalUrl()).hostname; } catch { return null; } })(),
].filter((h) => typeof h === 'string' && /^[a-z0-9.-]+$/.test(h)).map((h) => h.replace(/^www\./, '')))];
const OWNED_HOSTS_SQL = OWNED_HOSTS.map((h) => `'${h}'`).join(', ');
const normalizeUrlSql = (expr) => `NULLIF(regexp_replace(regexp_replace(regexp_replace(split_part(split_part(lower(trim(${expr})), chr(63), 1), '#', 1), '^[a-z][a-z0-9+.-]*://', ''), '^www\\.', ''), '(.)/$', '\\1'), '')`;
const ownedPageSql = (expr) => {
  const url = normalizeUrlSql(expr);
  return `CASE WHEN split_part(${url}, '/', 1) IN (${OWNED_HOSTS_SQL}) THEN ${url} END`;
};
const FUNNEL_URL_SQL = `COALESCE(
  ${ownedPageSql("l.extracted_data->'attribution'->>'landingUrl'")},
  ${ownedPageSql("l.extracted_data->'attribution'->>'pageUrl'")},
  ${ownedPageSql("l.extracted_data->'attribution'->>'landing_url'")},
  ${ownedPageSql("l.extracted_data->>'landing_url'")},
  ${ownedPageSql("sba.attribution->>'landing_url'")},
  CASE WHEN l.first_contact_channel IN (${WEB_CHANNELS_SQL}) THEN ${ownedPageSql('c.landing_page_url')} END)`;
const FUNNEL_BREAKDOWN_SQL = {
  page: `COALESCE(${FUNNEL_URL_SQL}, '${UNKNOWN}')`,
  service: `COALESCE(NULLIF(asa.service_line, ''), '${UNKNOWN}')`,
  city: `COALESCE(NULLIF(initcap(trim(COALESCE(NULLIF(l.city, ''), c.city, ''))), ''), '${UNKNOWN}')`,
  heard: `COALESCE(NULLIF(l.heard_about, ''), '${UNKNOWN}')`,
};

/**
 * buildFunnelBreakdown(rows, dimension) — rows are GROUP BY (group_key,
 * funnel_stage) counts: [{ group_key, funnel_stage, n, revenue }]. No paid
 * split: paid vs organic is a property of the source, shown on that view.
 */
function buildFunnelBreakdown(rows = [], dimension) {
  const labelOf = BREAKDOWN_LABELS[dimension] || ((k) => k);
  const groups = new Map();
  for (const r of rows) {
    const key = r.group_key || UNKNOWN;
    if (!groups.has(key)) groups.set(key, { key, label: labelOf(key), ...emptyGroup() });
    tallyStage(groups.get(key), r.funnel_stage, parseInt(r.n, 10) || 0, Number(r.revenue) || 0);
  }
  return [...groups.values()]
    .map(withRates)
    .sort((a, b) => b.leads - a.leads || a.label.localeCompare(b.label));
}

module.exports = { buildLeadFunnel, buildFunnelBreakdown, FUNNEL_BREAKDOWN_SQL, UNKNOWN };

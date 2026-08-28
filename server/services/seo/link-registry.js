/**
 * Backlink Manager v2 — registry primitives (plan v2 §3, step 1).
 *
 * The registry is `seo_link_domains` (one row per canonical host) + its
 * acquisition paths (`seo_link_acquisition_paths`, HOW a link is obtained) +
 * the normalized touch ledger (`seo_link_domain_sources`, EVERY feeder that
 * mentioned the host). Placements (`seo_link_prospects`) hang off both.
 *
 * This module owns the enums the migration CHECKs (a test pins the migration's
 * literal sets to these — drift = a new migration, never an edit in place), the
 * legacy→v2 mappings the step-1 backfills use, and `ensureDomain()`, the ONE
 * upsert every feeder goes through: first-touch `source` is never overwritten,
 * every touch adds an idempotent `seo_link_domain_sources` row, and a later
 * `owner_seed` touch raises `discovery_priority`.
 *
 * Nothing here fetches, enriches, or moves money.
 */

const { canonicalProspectDomain } = require('./prospect-domain-lock');
const { CLAIMABLE_LINK_TYPES } = require('./prospect-scorer');
const { SPOKE_SITE_KEYS } = require('../content-astro/spoke-sites');

// §3.5 — first-touch provenance. `legacy_unknown` = backfill fallback only.
const LINK_SOURCES = Object.freeze([
  'owner_seed', 'list_import', 'competitor_gap', 'competitor_clone', 'recursive',
  'x', 'google_search', 'dataforseo', 'strategy_agent', 'existing_backlink',
  'lost_recovery', 'local_opportunity', 'legacy_unknown',
]);

// §3.1 — aggregate over the domain's placements; step 1 only ever writes `new`
// (intake) and leaves the rest to the investigator / bridge (steps 3–4).
const AGENT_STATES = Object.freeze([
  'new', 'investigating', 'qualified', 'ready_to_acquire', 'acquiring', 'acquired',
  'watching', 'not_reproducible', 'rejected',
]);

const DISCOVERY_PRIORITIES = Object.freeze(['owner_seed', 'normal']);

// §3.2
const ACQUISITION_TYPES = Object.freeze([
  'self_service_free', 'self_service_account', 'paid_listing', 'membership', 'association',
  'sponsorship', 'vendor_registration', 'business_claim', 'resource_outreach',
  'editorial_outreach', 'partnership', 'content_submission', 'not_reproducible', 'unknown',
]);
const PAID_ACQUISITION_TYPES = Object.freeze(['paid_listing', 'membership', 'association', 'sponsorship']);
const OUTREACH_ACQUISITION_TYPES = Object.freeze(['resource_outreach', 'editorial_outreach', 'partnership', 'content_submission']);
const EXPECTED_REL = Object.freeze(['dofollow', 'nofollow', 'sponsored', 'unknown']);
const EXPECTED_INDEXABILITY = Object.freeze(['indexable', 'noindex', 'unknown']);
const EXPECTED_PERSISTENCE = Object.freeze(['durable', 'rotating', 'unknown']);
const RENEWAL_PERIODS = Object.freeze(['annual', 'monthly', 'none']);
// The path's board lane — CHECKed against the worker's claimable set so a path
// can never qualify with a lane nothing can lease.
const PATH_LINK_TYPES = Object.freeze([...CLAIMABLE_LINK_TYPES]);

// §3.4 — attempts. `human` = the owner did the step by hand (step 4+).
const ATTEMPT_PROVIDERS = Object.freeze(['deterministic_runner', 'openai_cua', 'claude_cu', 'stagehand', 'grok', 'human']);
const ATTEMPT_ACTIONS = Object.freeze(['investigate', 'create_account', 'complete_form', 'submit', 'resume', 'outreach_send']);
const ATTEMPT_OUTCOMES = Object.freeze([
  'slot_reserved', 'submitting', 'submit_ambiguous',
  'placed', 'pending', 'drafted', 'sent', 'failed', 'skipped', 'blocked', 'captcha',
  'needs_owner', 'human_step_done', 'ready_for_payment', 'ready_for_credentials',
  'no_payment_required', 'price_changed', 'instrument_unavailable', 'auto_renew_unavoidable',
  'payment_ambiguous', 'mint_not_started', 'terms_changed', 'send_error', 'sandbox_replay',
]);

// §3.3b / §6.1 — dimension levels. OWNER_OVERRIDE is deliberately absent: it is
// only ever the `authority` of a floor-waiver approval row, never a level.
const AUTHORITY_DIMENSIONS = Object.freeze(['execution', 'payment', 'communication']);
const AUTHORITY_LEVELS = Object.freeze([
  'AUTO_FREE', 'AUTO_ACCOUNT', 'AUTO_OUTREACH', 'AUTO_PAID_WITHIN_POLICY',
  'OWNER_FREE', 'OWNER_ACCOUNT', 'OWNER_OUTREACH', 'OWNER_PAYMENT', 'OWNER_MANUAL_PAYMENT',
  'OWNER_MEMBERSHIP', 'OWNER_LEGAL', 'OWNER_HUMAN_STEP', 'DENY', 'INVALID',
]);

// §4 step 1 — hosts that are references to opportunities or our own, never a
// target. Dropped by intake (not parked). Subdomains match too.
const NEVER_TARGET_HOSTS = Object.freeze([
  'x.com', 'twitter.com', 't.co', 'google.com',
  'bit.ly', 'tinyurl.com', 'goo.gl', 'ow.ly', 'buff.ly', 'lnkd.in', 'rebrand.ly', 'cutt.ly', 'is.gd', 'youtu.be',
  'wavespestcontrol.com', ...SPOKE_SITE_KEYS,
]);
function isNeverTargetHost(host) {
  const h = canonicalProspectDomain(host);
  if (!h) return true;
  return NEVER_TARGET_HOSTS.some((n) => h === n || h.endsWith(`.${n}`));
}

// ---------------------------------------------------------------------------
// Legacy → v2 mappings (§4 board backfill, §3.4 attempts backfill). Pure.
// ---------------------------------------------------------------------------

/**
 * mapLegacySource('deep_harvest_2026-07-01') → { source: 'competitor_gap', source_detail: 'legacy:deep_harvest_2026-07-01' }
 * Exhaustive over the CHECK enum via the `legacy_unknown` fallback. The verbatim
 * legacy value always survives in source_detail.
 */
function mapLegacySource(value) {
  const v = String(value == null ? '' : value).trim();
  let source = 'legacy_unknown';
  if (v === 'manual') source = 'owner_seed';
  else if (v === 'strategy_agent') source = 'strategy_agent';
  else if (v === 'lost_recovery') source = 'lost_recovery';
  else if (v === 'competitor_gap') source = 'competitor_gap';
  else if (/^local_opportunity(_|$)/.test(v)) source = 'local_opportunity';
  else if (/^deep_harvest(_|$)/.test(v)) source = 'competitor_gap';
  else if (v === 'signup_agent') source = 'x';
  else if (v === 'existing_backlink') source = 'existing_backlink';
  return { source, source_detail: `legacy:${v || '-'}` };
}

/** Legacy `seo_signup_attempts.outcome` → §3.4 CHECK enum. Anything unknown → failed. */
function mapLegacyOutcome(value) {
  const v = String(value == null ? '' : value).trim();
  switch (v) {
    case 'blocked_account':
    case 'blocked_payment':
    case 'blocked_phone':
    case 'blocked_phone_verification': return 'needs_owner'; // parked for the owner (browser-form-filler vocabulary)
    case 'blocked_price_changed': return 'price_changed';
    case 'blocked_captcha': return 'captcha';
    case 'submitted':
    case 'placed': return 'placed';
    case 'pending': return 'pending';
    case 'skipped': return 'skipped';
    default: return 'failed';
  }
}

/** Board lane → acquisition type for a legacy placement (§4). Non-claimable lanes → unknown/resource. */
function acquisitionTypeForLinkType(linkType) {
  switch (linkType) {
    case 'editorial':
    case 'guest_post':
    case 'haro': return 'editorial_outreach';
    case 'resource': return 'resource_outreach';
    case 'directory':
    case 'citation':
    case 'social': return 'self_service_account';
    default: return 'unknown';
  }
}

/** Lane the path row carries — must sit inside the CHECKed claimable set. */
function pathLinkTypeFor(linkType) {
  return CLAIMABLE_LINK_TYPES.has(linkType) ? linkType : 'resource';
}

/** Submission-URL normalization for path identity: lower host, no fragment, no trailing slash. */
function normalizeSubmissionUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    let s = u.toString();
    if (u.pathname === '/' && !u.search) s = s.replace(/\/$/, '');
    return s.replace(/\/+$/, '');
  } catch { return raw.toLowerCase().replace(/#.*$/, '').replace(/\/+$/, ''); }
}

function pathKey(acquisitionType, submissionUrl) {
  return `${acquisitionType}:${normalizeSubmissionUrl(submissionUrl) || '-'}`;
}

function expectedRelOf(v) {
  return EXPECTED_REL.includes(v) ? v : 'unknown';
}

/**
 * acquisitionPathFromLegacyRow(prospect) → the §3.2 row for a legacy board
 * placement. Every NOT NULL boolean is explicit (the classifier's answers when
 * it left any, lane defaults otherwise); confidence low; last_investigated_at
 * null so the investigator refreshes it; never a paid type (the classifier
 * never proved a price is the ONLY way in). `domain_id` is filled by the caller.
 */
function acquisitionPathFromLegacyRow(row) {
  const linkType = pathLinkTypeFor(row.link_type);
  const acquisitionType = acquisitionTypeForLinkType(row.link_type);
  const signup = acquisitionType === 'self_service_account';
  const priceUsd = Number(row.detected_price_usd);
  const bool = (v, dflt) => (typeof v === 'boolean' ? v : dflt);
  return {
    acquisition_type: acquisitionType,
    submission_url: row.target_url || null,
    estimated_cost_cents: Number.isFinite(priceUsd) && priceUsd > 0 ? Math.round(priceUsd * 100) : null,
    renewal_cost_cents: null,
    renewal_period: null,
    merchant_binding: null,
    account_required: signup ? bool(row.requires_account, true) : false,
    email_verification: signup ? bool(row.requires_email_verification, false) : false,
    payment_required: signup ? bool(row.requires_payment, false) : false,
    legal_attestation: false,
    legal_terms_hash: null,
    agent_completable: CLAIMABLE_LINK_TYPES.has(row.link_type), // the lane's worker exists
    baseline: false,
    expected_rel: expectedRelOf(row.offered_link_rel),
    expected_indexability: 'unknown',
    expected_persistence: 'unknown',
    link_type: linkType,
    confidence: 0.2,
    last_investigated_at: null,
    path_key: pathKey(acquisitionType, row.target_url),
  };
}

/**
 * Legacy `seo_signup_attempts` row (+ optional joined path_id) → §3.4 row.
 * The old filler recorded a successful submit as `placed` with live_url=NULL
 * while moderation was pending — the same rule the new writer applies
 * (placed without a live URL = `pending`) keeps historical state honest.
 */
function attemptFromLegacyRow(a, { pathId = null } = {}) {
  const cost = a.cost_usd == null || a.cost_usd === '' ? NaN : Number(a.cost_usd);
  const mapped = mapLegacyOutcome(a.outcome);
  return {
    prospect_id: a.prospect_id || null,
    path_id: pathId || null,
    provider: 'deterministic_runner',
    action: 'submit',
    outcome: mapped === 'placed' && !a.live_url ? 'pending' : mapped,
    cost_cents: Number.isFinite(cost) ? Math.round(cost * 100) : null,
    duration_ms: null,
    sandbox: false,
    evidence_url: a.evidence_url || null,
    detail: JSON.stringify({
      legacy_outcome: a.outcome == null ? null : String(a.outcome),
      mode: a.mode || null,
      live_url: a.live_url || null,
      link_rel: a.link_rel || null,
      indexed: typeof a.indexed === 'boolean' ? a.indexed : null,
      error_code: a.error_code || null,
      error_message: a.error_message || null,
      screenshot_url: a.screenshot_url || null,
    }),
    legacy_attempt_id: a.id,
    created_at: a.created_at || new Date(),
    updated_at: a.updated_at || a.created_at || new Date(),
  };
}

// ---------------------------------------------------------------------------
// ensureDomain — the one registry upsert (§4 step 2 "dedupe", §3.4b touches)
// ---------------------------------------------------------------------------

function touchKey(source, sourceRef, sourceDetail) {
  const detail = String(sourceDetail || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return `${source}:${sourceRef || detail || '-'}`;
}

/**
 * ensureDomain(q, { domain, source, sourceDetail, sourceRef, seenAt, createdAt })
 *   → { id, domain, created, touched }
 * Insert-or-find the canonical host, then record this touch. `q` = knex or trx.
 * Idempotent: a repeat of the same (source, ref/detail) is a no-op touch; the
 * first-touch `source` on the domain row is never rewritten; an `owner_seed`
 * touch on an existing normal-priority row raises the priority (§4 step 2).
 */
async function ensureDomain(q, { domain, source, sourceDetail = null, sourceRef = null, seenAt = null, createdAt = null }) {
  const key = canonicalProspectDomain(domain);
  if (!key) throw new Error('ensureDomain: empty domain');
  if (!LINK_SOURCES.includes(source)) throw new Error(`ensureDomain: unknown source '${source}'`);
  const priority = source === 'owner_seed' ? 'owner_seed' : 'normal';

  const inserted = await q('seo_link_domains')
    .insert({
      domain: key,
      source,
      source_detail: sourceDetail || null,
      source_ref: sourceRef || null,
      discovery_priority: priority,
      agent_state: 'new',
      ...(createdAt ? { created_at: createdAt, updated_at: createdAt } : {}),
    })
    .onConflict('domain').ignore().returning(['id']);
  let created = inserted && inserted.length > 0;
  let row = created ? inserted[0] : await q('seo_link_domains').where({ domain: key }).first('id', 'discovery_priority');
  if (!row) throw new Error(`ensureDomain: lost race on ${key}`);
  if (!created && priority === 'owner_seed' && row.discovery_priority !== 'owner_seed') {
    await q('seo_link_domains').where({ id: row.id }).update({ discovery_priority: 'owner_seed', updated_at: q.fn ? q.fn.now() : new Date() });
  }

  const touch = await q('seo_link_domain_sources')
    .insert({
      domain_id: row.id,
      source,
      source_detail: sourceDetail || null,
      source_ref: sourceRef || null,
      touch_key: touchKey(source, sourceRef, sourceDetail),
      ...(seenAt ? { seen_at: seenAt } : {}),
    })
    .onConflict(['domain_id', 'touch_key']).ignore().returning(['id']);

  return { id: row.id, domain: key, created, touched: !!(touch && touch.length) };
}

module.exports = {
  LINK_SOURCES, AGENT_STATES, DISCOVERY_PRIORITIES, ACQUISITION_TYPES, PAID_ACQUISITION_TYPES, OUTREACH_ACQUISITION_TYPES,
  EXPECTED_REL, EXPECTED_INDEXABILITY, EXPECTED_PERSISTENCE, RENEWAL_PERIODS, PATH_LINK_TYPES,
  ATTEMPT_PROVIDERS, ATTEMPT_ACTIONS, ATTEMPT_OUTCOMES, AUTHORITY_DIMENSIONS, AUTHORITY_LEVELS,
  NEVER_TARGET_HOSTS, isNeverTargetHost,
  mapLegacySource, mapLegacyOutcome, acquisitionTypeForLinkType, pathLinkTypeFor, normalizeSubmissionUrl, pathKey,
  acquisitionPathFromLegacyRow, attemptFromLegacyRow, touchKey, ensureDomain,
};

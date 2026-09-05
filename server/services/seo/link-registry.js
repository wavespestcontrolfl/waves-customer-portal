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

const crypto = require('crypto');
const { canonicalProspectDomain } = require('./prospect-domain-lock');
const { CLAIMABLE_LINK_TYPES } = require('./prospect-scorer');
const { SPOKE_SITE_KEYS } = require('../content-astro/spoke-sites');

// §3.5 — first-touch provenance. `legacy_unknown` = backfill fallback only.
const LINK_SOURCES = Object.freeze([
  'owner_seed', 'list_import', 'competitor_gap', 'competitor_clone', 'recursive',
  'x', 'google_search', 'dataforseo', 'strategy_agent', 'existing_backlink',
  'lost_recovery', 'local_opportunity', 'legacy_unknown',
]);

// §3.4d — intake items (step 2): raw references parked before resolution.
const INTAKE_ITEM_STATES = Object.freeze(['pending', 'unresolved', 'resolved', 'dropped']);
const INTAKE_DROP_REASONS = Object.freeze(['never_a_target', 'retry_exhausted', 'invalid_url', 'own_domain']);

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
// §3.2 — the currency an investigated fee is attested in: USD proven on the
// page, a declared foreign currency, or unknown (never a default).
const CURRENCIES = Object.freeze(['USD', 'unknown', 'foreign']);
// §3.2 — payment scope of a paid path's fee (required when payment_required).
const FEE_SCOPES = Object.freeze(['per_location', 'account_wide']);
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
  'slot_reserved', 'slot_released', 'submitting', 'submit_ambiguous',
  'placed', 'pending', 'drafted', 'sent', 'failed', 'skipped', 'blocked', 'captcha',
  'needs_owner', 'human_step_done', 'ready_for_payment', 'ready_for_credentials',
  'no_payment_required', 'price_changed', 'instrument_unavailable', 'auto_renew_unavoidable',
  'payment_ambiguous', 'mint_not_started', 'terms_changed', 'send_error', 'sandbox_replay',
]);

// §3.3b / §6.1 — dimension levels. OWNER_OVERRIDE is deliberately absent: it is
// only ever the `authority` of a floor-waiver approval row, never a level.
// Step 4a appended OWNER_INPUT_REQUIRED (payment dimension only: a valid path
// whose price is unparseable or whose currency is unknown parks for a
// price-entry card, §6.1); its migration swaps the CHECK — the step-1 literal
// stays a prefix of this list.
const AUTHORITY_DIMENSIONS = Object.freeze(['execution', 'payment', 'communication']);
const AUTHORITY_LEVELS = Object.freeze([
  'AUTO_FREE', 'AUTO_ACCOUNT', 'AUTO_OUTREACH', 'AUTO_PAID_WITHIN_POLICY',
  'OWNER_FREE', 'OWNER_ACCOUNT', 'OWNER_OUTREACH', 'OWNER_PAYMENT', 'OWNER_MANUAL_PAYMENT',
  'OWNER_MEMBERSHIP', 'OWNER_LEGAL', 'OWNER_HUMAN_STEP', 'DENY', 'INVALID',
  'OWNER_INPUT_REQUIRED',
]);
// §6.3 — most restrictive first. The placement's `authority` column is the
// most severe level across its OPEN rows (display only; claims read the rows).
const LEVEL_SEVERITY = Object.freeze([
  'INVALID', 'DENY', 'OWNER_INPUT_REQUIRED', 'OWNER_MANUAL_PAYMENT', 'OWNER_HUMAN_STEP', 'OWNER_LEGAL',
  'OWNER_MEMBERSHIP', 'OWNER_PAYMENT', 'OWNER_ACCOUNT', 'OWNER_OUTREACH', 'OWNER_FREE',
  'AUTO_PAID_WITHIN_POLICY', 'AUTO_OUTREACH', 'AUTO_ACCOUNT', 'AUTO_FREE',
]);
// §3.3b instance kinds persisted explicitly ('-' initial, 'terms' accept_terms,
// 'followup'); a renewal's kind is its renewal_period_key (YYYY or YYYY-MM).
const INSTANCE_KINDS = Object.freeze(['-', 'terms', 'followup']);
const RENEWAL_KIND_RE = /^[0-9]{4}(-[0-9]{2})?$/;
const SATISFIED_REASONS = Object.freeze(['sent', 'placed', 'charged', 'manual_charged', 'no_payment_required', 'human_step_done', 'group_purchase']);
const END_OUTCOMES = Object.freeze(['failed', 'skipped', 'not_sent', 'voided', 'superseded', 'terms_changed', 'lost', 'human_step_done', 'path_failed_after_charge', 'path_failed_after_free', 'free_checkout_failed', 'captcha']);
// §3.6b approvals
const APPROVAL_DECISIONS = Object.freeze(['approved', 'rejected', 'watch']);
const APPROVAL_ACTIONS = Object.freeze(['acquire', 'accept_terms', 'purchase', 'renewal', 'outreach_send', 'outreach_followup']);
const ACTIONS_BY_DIMENSION = Object.freeze({
  execution: Object.freeze(['acquire', 'accept_terms']),
  payment: Object.freeze(['purchase', 'renewal']),
  communication: Object.freeze(['outreach_send', 'outreach_followup']),
});
// the OWNER_* levels an approval row can grant — never OVERRIDE (a waiver is
// its own table), MANUAL_PAYMENT (paid outside the system) or INPUT_REQUIRED
// (a price entry is an input, not an approval)
const APPROVABLE_LEVELS = Object.freeze(['OWNER_FREE', 'OWNER_ACCOUNT', 'OWNER_OUTREACH', 'OWNER_PAYMENT', 'OWNER_MEMBERSHIP', 'OWNER_LEGAL', 'OWNER_HUMAN_STEP']);

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

/**
 * STANDING confidence — the ONE predicate every worker-facing check shares
 * (claim, send valve, release-time reconcile, lost-link relink): a path a
 * worker may act on has a POSITIVE, finite confidence. NULL (schema-permitted,
 * never assessed), 0 (disproven) and anything non-numeric are all refused,
 * fail closed. The SQL twin lives in worker.claim()'s candidate pre-filter.
 */
function isStandingConfidence(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
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

/**
 * §3.4d item identity: trim; lowercase scheme + host; strip fragment and the
 * trailing slash; keep path + query verbatim (case-significant); prefix
 * https:// when no scheme. Pure — no DNS, no fetch.
 */
function normalizeRawUrl(url) {
  const raw = String(url == null ? '' : url).trim();
  if (!raw) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    // Trailing slashes come off the PATH only; the query stays verbatim
    // (`?next=/` and `?next=` are different references).
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    const s = withScheme.replace(/#.*$/, '');
    return s.includes('?') ? s : s.replace(/\/+$/, '');
  }
}

/**
 * `${source}:${normalizeRawUrl(rawUrl)}` — the UNIQUE seo_link_intake_items.item_key.
 * A very long reference (multi-KB query strings) is keyed by its sha256 instead:
 * the B-tree UNIQUE index has a per-entry limit and raw_url keeps the full text.
 */
const ITEM_KEY_MAX = 512;
function intakeItemKey(source, rawUrl) {
  const n = normalizeRawUrl(rawUrl);
  if (n.length <= ITEM_KEY_MAX) return `${source}:${n}`;
  return `${source}:sha256:${crypto.createHash('sha256').update(n).digest('hex')}`;
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

// touch_key sits in the unique (domain_id, touch_key) btree: a long detail
// (a pasted URL with a query string) is replaced by a fixed-length digest so
// the index entry is bounded; short details stay readable.
const TOUCH_DETAIL_MAX = 120;
function touchKey(source, sourceRef, sourceDetail) {
  const detail = String(sourceDetail || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const ident = detail.length > TOUCH_DETAIL_MAX ? `sha256:${crypto.createHash('sha256').update(detail).digest('hex').slice(0, 32)}` : detail;
  return `${source}:${sourceRef || ident || '-'}`;
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
  const touched = !!(touch && touch.length);
  // The touch row this call landed on (new or already there): what a resolved
  // intake item records as source_row_id.
  const touchRow = touched ? touch[0] : await q('seo_link_domain_sources').where({ domain_id: row.id, touch_key: touchKey(source, sourceRef, sourceDetail) }).first('id');

  return { id: row.id, domain: key, created, touched, touchId: (touchRow && touchRow.id) || null };
}


/**
 * Placements follow path supersession (§3.2) — ONE mechanism, two callers:
 *
 *   settleRetiredPlacements(q, { pathIds, successor })   — the investigator,
 *     right after it superseded `pathIds` into `successor` ({ id, submission_url }).
 *   settleRetiredPlacements(q, { prospectIds })          — the worker, right
 *     after a lease is released (report / release / expired-claim sweep):
 *     each placement's linked path is followed along `superseded_by` to the
 *     live successor.
 *
 * Only UN-LEASED placements move (`claimed_at IS NULL`): a leased one is
 * mid-submission through the path it was claimed on and its attempt ledger
 * names that path — it is settled when its lease clears, which is why the
 * worker calls this at every lease release rather than waiting for a future
 * re-investigation. The placement's EXECUTION URL (`target_url`) moves with
 * it whenever the successor has one (the runner submits at target_url, and
 * the board catch-up keys legacy placements on it); a URL-less successor
 * (outreach) leaves target_url alone. Returns the number of rows moved.
 */
const SUCCESSOR_COLUMNS = ['id', 'superseded_by', 'submission_url', 'link_type', 'revision', 'confidence'];

/**
 * A moved placement takes the successor's LANE and is left UNCLASSIFIED:
 *   - `link_type` follows the successor's path lane (the worker claims by
 *     the placement's link_type — a directory placement superseded by an
 *     outreach path must leave the signup lane, or the runner would execute
 *     the retired route while the ledger names the outreach successor);
 *   - `automation_policy` / `last_classified_at` are cleared. The policy was
 *     classified for the OLD path; the successor's CAPTCHA / category /
 *     account gates are only known once the weekly classifier has fetched
 *     ITS page (a null last_classified_at puts it first in line), and until
 *     then no runner may lease it (claim() filters on the policy). Fail
 *     closed — never a synthesized policy from an incomplete signal.
 */
// Outreach state that is IN FLIGHT or AMBIGUOUS: a placement carrying it
// never moves (a send may still be executing, or needs human
// reconciliation) — it keeps the retired path, which nothing can claim.
const OUTREACH_LOCKED = new Set(['sending', 'sent', 'send_error']);
// a placement the mover REFUSES to move: a locked send state or a sent stamp —
// the conversation belongs to the path it was claimed on (exported so the
// bridge's selection can treat such a row as pinned in place)
const isOutreachLocked = (row) => OUTREACH_LOCKED.has(row.outreach_status) || Boolean(row.outreach_sent_at);
const PLACEMENT_MOVE_COLUMNS = ['id', 'path_id', 'link_type', 'outreach_status', 'outreach_sent_at', 'outreach_send_token', 'leased_path_revision'];

/**
 * The move UPDATE is OPTIMISTIC on everything the decision read: the path,
 * the lease, and the outreach state (status, sent stamp, send token). The
 * send path flips a draft to `sending` WITHOUT taking the lease, so a
 * snapshot taken just before it must miss — otherwise the stale
 * draft-clearing patch would erase the token the finalizer is about to
 * match, leaving a sent message with no sent marker (a later duplicate).
 */
function observedWhere(q, row) {
  let w = q('seo_link_prospects').where({ id: row.id }).whereNull('claimed_at');
  for (const col of ['path_id', 'outreach_status', 'outreach_sent_at', 'outreach_send_token']) {
    w = row[col] == null ? w.whereNull(col) : w.where(col, row[col]);
  }
  return w;
}

/**
 * The patch that moves ONE placement onto `target`, or null when the move
 * must be refused: a locked state (sending / sent / send_error, or a sent
 * stamp) refuses any move; an unsent draft (`drafted`) is cleared with its
 * token on every move, so the approval queue never sends a message composed
 * for a route that no longer exists; the lane follows the successor.
 */
function movePatch(row, target, now, { syncUrl = false } = {}) {
  // locked outreach never moves AT ALL — same lane, other outreach lane, or
  // signup lane: a send may be executing against the path it was claimed
  // on, or the row awaits human reconciliation; the retired path stays
  // (nothing can claim it) and the attempt/send stays attributed to it
  if (isOutreachLocked(row)) return null;
  // The transition CONSUMES the lease stamp: a same-path reconcile at release
  // fires once per lease, never again on every later release or operator
  // draft of the same (now settled) row.
  const patch = { path_id: target.id, outreach_draft_attempts: 0, updated_at: now, automation_policy: null, last_classified_at: null, leased_path_revision: null };
  // The execution URL follows the successor; a URL-less successor (outreach)
  // CLEARS it — the retired route must not survive as the page the outreach
  // drafter fetches and cites. A release-time reconcile of the SAME path
  // (syncUrl) syncs it to the path's own URL even when that is now null; an
  // investigator same-path refresh leaves an outreach row's pitch page alone.
  if (target.submission_url) patch.target_url = target.submission_url;
  else if (target.id !== row.path_id || syncUrl) patch.target_url = null;
  // an UNSENT draft was written for the path it is leaving — on EVERY move
  // (same lane included) it is cleared with its token, so the approval
  // endpoint can never send a message composed for a retired route
  if (row.outreach_status === 'drafted') {
    Object.assign(patch, { outreach_status: 'none', outreach_to_email: null, outreach_subject: null, outreach_body: null, outreach_send_token: null });
  }
  const nextLane = target.link_type && CLAIMABLE_LINK_TYPES.has(target.link_type) ? target.link_type : null;
  if (nextLane && nextLane !== row.link_type) patch.link_type = nextLane;
  return patch;
}

async function settleRetiredPlacements(q, { pathIds = null, successor = null, prospectIds = null, now = new Date() } = {}) {
  const movable = async (rows) => {
    if (!rows.length) return rows;
    // Every unleased settlement also settles its durable submission slot before path movement.
    await require('./link-execution-authority').releaseSlots(q, rows.map((r) => r.id), now);
    const held = await q('seo_link_attempts').whereIn('prospect_id', rows.map((r) => r.id)).where({ action: 'submit', outcome: 'submit_ambiguous' }).select('prospect_id');
    const pinned = new Set(held.map((a) => a.prospect_id));
    return rows.filter((r) => !pinned.has(r.id));
  };
  const moveRows = async (rows, target, opts) => {
    let moved = 0;
    for (const row of rows) {
      const patch = movePatch(row, target, now, opts);
      if (!patch) continue;
      moved += await observedWhere(q, row).update(patch);
    }
    return moved;
  };
  if (successor && successor.id && Array.isArray(pathIds)) {
    if (!pathIds.length) return 0;
    const rows = await q('seo_link_prospects').whereIn('path_id', pathIds).whereNull('claimed_at').forUpdate().select(...PLACEMENT_MOVE_COLUMNS);
    return moveRows(await movable(rows || []), successor);
  }
  if (successor && successor.id && Array.isArray(prospectIds)) {
    // exactly THESE unleased placements onto `successor` (the bridge's re-rank
    // to a still-live best path: only the rows inside the new lane's shape
    // follow; a sibling on the same old path stays put)
    if (!prospectIds.length) return 0;
    const rows = await q('seo_link_prospects').whereIn('id', prospectIds).whereNull('claimed_at').forUpdate().select(...PLACEMENT_MOVE_COLUMNS);
    return moveRows(await movable(rows || []), successor);
  }
  if (!Array.isArray(prospectIds) || !prospectIds.length) return 0;
  // Lock order everywhere is prospect → path: the placement rows are locked
  // FIRST (callers that already hold them re-lock harmlessly), then the
  // path rows below — a save holding a prospect and a send holding a path
  // can no longer wait on each other.
  const rows = await q('seo_link_prospects').whereIn('id', prospectIds).whereNull('claimed_at').whereNotNull('path_id').forUpdate().select(...PLACEMENT_MOVE_COLUMNS);
  const linked = await movable((rows || []).filter((r) => r.path_id)); // an un-backfilled legacy row has no path to follow
  if (!linked.length) return 0;
  // Pass 1 — resolve every chain WITHOUT locks, collecting the path ids
  // involved. Cycle-safe rather than hop-capped: a chain is followed to its
  // end however long it is, and a cycle (data corruption — supersession
  // requires an active predecessor) throws, so no caller can ever mistake
  // an unresolved chain for a clean no-op.
  const involved = new Set();
  const walk = async (startId, read) => {
    const seen = new Set();
    let id = startId;
    let last = null;
    while (id) {
      if (seen.has(id)) throw new Error(`link-registry: supersession cycle at path ${id}`);
      seen.add(id);
      const p = await read(id);
      if (!p) return null;
      last = p;
      id = p.superseded_by;
    }
    return last;
  };
  for (const r of linked) {
    await walk(r.path_id, async (id) => { involved.add(id); return q('seo_link_acquisition_paths').where({ id }).first('id', 'superseded_by'); });
  }
  // Pass 2 — lock the involved path rows in ONE deterministic order (sorted
  // ids), held until the caller's transaction commits: two parallel claims /
  // sweeps touching the same paths in opposite row order can no longer
  // deadlock each other. Every worker-mode caller runs inside a transaction.
  const locked = new Map();
  if (involved.size) {
    for (const p of await q('seo_link_acquisition_paths').whereIn('id', [...involved].sort()).orderBy('id').forUpdate().select(...SUCCESSOR_COLUMNS)) locked.set(p.id, p);
  }
  // Pass 3 — re-walk under the locks (a successor appended between passes is
  // fetched and locked on demand) and apply the moves.
  let moved = 0;
  for (const r of linked) {
    const cur = await walk(r.path_id, async (id) => {
      if (!locked.has(id)) { const p = await q('seo_link_acquisition_paths').where({ id }).forUpdate().first(...SUCCESSOR_COLUMNS); if (p) locked.set(id, p); }
      return locked.get(id) || null;
    });
    if (!cur || cur.superseded_by) continue; // the chain led nowhere (path deleted)
    if (cur.id === r.path_id) {
      // same path, still live — but did it CHANGE while this placement was
      // leased? The lease stamped the path revision it was taken on; a
      // higher revision now (a gate change, a working-origin move, a lane
      // shift) is a same-path transition the immediate write skipped
      // because the row was leased: apply it at release.
      // …and a DISPROOF during the lease (confidence dropped to 0) never
      // bumps the revision (plan §3.2: confidence is not an input), yet a
      // draft produced on a route just declared gone must not stay
      // sendable — the transition runs for that too.
      // …and a LANE that drifted from the path's while the row was UNLEASED
      // (an in-place `link_type` change lands on the path without touching
      // its placements, and an unleased row carries no revision stamp to
      // compare) is reconciled here regardless of the stamp: the placement
      // is claimed by ITS lane, so a directory row on a path that is now
      // editorial would hand the signup runner an outreach route.
      const leasedRev = r.leased_path_revision == null ? null : Number(r.leased_path_revision);
      const pathLane = cur.link_type && CLAIMABLE_LINK_TYPES.has(cur.link_type) ? cur.link_type : null;
      const laneDrift = !!pathLane && pathLane !== r.link_type;
      if (leasedRev == null && !laneDrift) continue; // not released from a lease on this path, lane intact — nothing to reconcile
      const revised = leasedRev != null && cur.revision != null && Number(cur.revision) > leasedRev;
      // a NULL confidence (unassessed) counts as a disproof exactly as the
      // claim and the send valve refuse it — a draft on such a path must not
      // stay sendable until a later positive confidence lets it through
      const disproven = leasedRev != null && !isStandingConfidence(cur.confidence);
      if (!revised && !disproven && !laneDrift) continue;
      moved += await moveRows([r], cur, { syncUrl: true }); // the path itself changed: its URL (even null) is the execution truth
      continue;
    }
    moved += await moveRows([r], cur);
  }
  return moved;
}

// ---------------------------------------------------------------------------
// Owner registry actions (plan §11 item 2): Watch / Reject / Reopen — the ONE
// writer for both the Registry table and the Owner-queue cards. Returns the
// UPDATE count: 0 = the domain is lane-owned (ready_to_acquire / acquiring /
// acquired — a placement holds stamped authority or is in flight) or gone; a
// domain-only flip there would contradict the placements behind it, so the
// guard rides the UPDATE and the caller reports the race as a 409.
// ---------------------------------------------------------------------------
const REGISTRY_ACTIONS = Object.freeze({ watch: 'watching', reject: 'rejected', reopen: 'investigating' });
const LANE_OWNED_STATES = Object.freeze(['ready_to_acquire', 'acquiring', 'acquired']);
const DEFERRED_TERMINAL_NOTE = /\s*·?\s*downgraded: terminal verdict deferred: unfetched candidate URLs remain/;
function registryActionPatch(action, domain, now = new Date()) {
  const nextState = REGISTRY_ACTIONS[action];
  if (!nextState) return null;
  const patch = { agent_state: nextState, updated_at: now };
  // who rejected: the authority bridge lifts only its OWN rejections once the
  // inputs improve; the owner's stands until Reopen / Watch clears the marker
  patch.rejected_by = action === 'reject' ? 'owner' : null;
  patch.watch_recheck_at = nextState === 'watching' ? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) : null;
  // A manual Watch starts a LONG-TERM watch generation exactly like the
  // investigator's own parks: the probe-coverage mask resets, so the
  // resumed pass a month later re-earns coverage instead of closing on
  // routes credited before the park.
  if (action === 'watch') patch.probe_coverage_mask = 0;
  // An explicit Reopen is a fresh mandate: clear the failure backoff so the
  // very next sweep picks the domain up instead of honoring a stale defer —
  // and the probe-tail deferral marker with it, so the reopened
  // investigation gets its own rotated tail pass before a terminal close.
  if (action === 'reopen') {
    patch.investigate_after = null;
    patch.investigate_failures = 0;
    patch.probe_coverage_mask = 0; // the reopened investigation re-earns probe coverage
    // …and a run claimed BEFORE this reopen must not finish on top of it:
    // its claim token no longer matches, so its write phase aborts stale
    patch.investigate_claim_token = null;
    const cleared = String(domain.score_reasons || '').replace(DEFERRED_TERMINAL_NOTE, '').trim();
    if (cleared !== String(domain.score_reasons || '').trim()) patch.score_reasons = cleared || null;
  }
  return patch;
}
// A new generation (Watch park, Reopen) is ONE atomic write: the domain
// state/mask and the provenance-hint coverage — BOTH halves, the stamp
// (covered_at) and the per-URL accrual (covered_urls), on every touch —
// reset together, exactly like the investigator's own generation resets.
// A partially covered touch carries no stamp but does carry covered_urls,
// and the resumed pass would credit those URLs as observed without
// re-fetching them; so a failure can never leave a reset mask beside
// stale hint coverage, and a fresh generation never inherits any.
async function applyRegistryAction(trx, domain, action, now = new Date()) {
  const patch = registryActionPatch(action, domain, now);
  if (!patch) throw new Error(`invalid registry action '${action}'`);
  const updated = await trx('seo_link_domains')
    .where({ id: domain.id }).whereNotIn('agent_state', [...LANE_OWNED_STATES])
    .update(patch);
  if (updated && patch.probe_coverage_mask === 0) {
    await trx('seo_link_domain_sources').where({ domain_id: domain.id }).update({ covered_at: null, covered_urls: null });
  }
  return { updated, nextState: patch.agent_state, watchRecheckAt: patch.watch_recheck_at };
}

module.exports = {
  LINK_SOURCES, AGENT_STATES, DISCOVERY_PRIORITIES, ACQUISITION_TYPES, PAID_ACQUISITION_TYPES, OUTREACH_ACQUISITION_TYPES,
  EXPECTED_REL, EXPECTED_INDEXABILITY, EXPECTED_PERSISTENCE, RENEWAL_PERIODS, PATH_LINK_TYPES, CURRENCIES, FEE_SCOPES,
  ATTEMPT_PROVIDERS, ATTEMPT_ACTIONS, ATTEMPT_OUTCOMES, AUTHORITY_DIMENSIONS, AUTHORITY_LEVELS,
  LEVEL_SEVERITY, INSTANCE_KINDS, RENEWAL_KIND_RE, SATISFIED_REASONS, END_OUTCOMES,
  APPROVAL_DECISIONS, APPROVAL_ACTIONS, ACTIONS_BY_DIMENSION, APPROVABLE_LEVELS,
  INTAKE_ITEM_STATES, INTAKE_DROP_REASONS, normalizeRawUrl, intakeItemKey,
  NEVER_TARGET_HOSTS, isNeverTargetHost,
  mapLegacySource, mapLegacyOutcome, acquisitionTypeForLinkType, pathLinkTypeFor, isStandingConfidence, normalizeSubmissionUrl, pathKey, movePatch, isOutreachLocked,
  acquisitionPathFromLegacyRow, attemptFromLegacyRow, touchKey, TOUCH_DETAIL_MAX, ensureDomain,
  settleRetiredPlacements,
  REGISTRY_ACTIONS, LANE_OWNED_STATES, registryActionPatch, applyRegistryAction,
};

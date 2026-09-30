/**
 * Newsletter send service — shared by the admin "Send now" route and the
 * scheduler tick that picks up scheduled sends. Segment filtering and A/B
 * subject assignment live here so both callers get identical behavior.
 *
 * Segment filter shape (stored in newsletter_sends.segment_filter jsonb):
 *   SQL-expressible (applied directly in buildSubscriberQuery):
 *     { sources?: string[], tags?: string[], customersOnly?: boolean,
 *       leadsOnly?: boolean, region_zone?: string[] }
 *   Service-line / membership (NOT a column — resolved to a customer_id set
 *   via newsletter-audience-profiles, then injected as a whereIn):
 *     { has_service?: string[], missing_service?: string[],
 *       waveguard_tier?: string[], min_line_count?: number, max_line_count?: number }
 *   null/undefined = all active subscribers (legacy behavior)
 *
 * Callers that may carry a service-line filter must pre-resolve the customer
 * id set and pass it as the 2nd arg:
 *   const ids = await resolveSegmentCustomerIds(seg);
 *   buildSubscriberQuery(seg, ids)
 */

const db = require('../models/db');

// A row version as a claim bound: `updated_at < stored + 1ms` (millisecond
// truncation on the way through the driver would otherwise miss an exact
// match). Used by every dispatch claim that validated a row first.
const noLaterThan = (value) => new Date(new Date(value).getTime() + 1);
const sendgrid = require('./sendgrid-mail');
const logger = require('./logger');
const crypto = require('crypto');
const { wrapNewsletter, ensureLegalTextFooter, bodyIsDarkAware } = require('./email-template');
const { recordTouchpoint } = require('./conversations');
const { GREETING_NAME_TOKEN, greetingNameValueFor, stripPersonalizationTokens, CITY_TOKEN, GRASS_TYPE_TOKEN, DEFAULT_CITY_LABEL, DEFAULT_GRASS_LABEL, decodeEscapedEntities } = require('./newsletter-draft');
const { selectAudience, SELLABLE_LINES } = require('./newsletter-audience-profiles');
const { grassTypeLabel, normalizeGrassType } = require('./lawn-grass-context');
const { hasQuizToken, buildQuizSubstitutions } = require('./newsletter-quiz');
const { hasFeedbackToken, ensureFeedbackToken, buildFeedbackSubstitutions } = require('./newsletter-feedback');
const { isFlagshipDeliveryWindow, isCurrentFlagshipTarget } = require('./event-freshness');
const { validateFlagshipEventSelection, parseLockedEventIds, isFlagshipSend } = require('./newsletter-event-selection');
const { reverifyEvents, reverifyEnabled } = require('./event-reverify');
const { pestInsiderProofLive } = require('../config/feature-gates');
const NewsletterSubscribers = require('./newsletter-subscribers');

// CITY_TOKEN / GRASS_TYPE_TOKEN + their neutral defaults are defined once in
// newsletter-draft.js (imported above) so the live-send substitution and every
// no-recipient render surface share one source of truth.

// SendGrid substitutions are a literal token→value replacement applied to both
// the HTML and text parts, so a raw DB value (e.g. customers.city) would inject
// markup straight into the email HTML. Sanitize to a safe charset before
// substitution — mirrors greetingNameValueFor (letters/marks/space/.,'-),
// which strips <, >, & and slashes so no HTML can survive.
function sanitizePersonalizationToken(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{M}'’ .,-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
}

function stripHtml(html) {
  if (!html) return '';
  // Decode the escapeHtml entities after tag-stripping so the recorded
  // touchpoint body reads "don't", not "don&#39;t".
  return decodeEscapedEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

// Suppression types that block delivery on EVERY send stream, mirroring
// activeSuppressionFor() in email-template-library.js. Bounces stay GLOBAL by
// design (email audit C4), so the newsletter blast must honor them too.
const GLOBAL_SUPPRESSION_TYPES = ['bounce', 'spam_complaint', 'do_not_email'];

// Exclude any address with an active GLOBAL suppression (bounce /
// spam_complaint / do_not_email) recorded via ANY stream — mirrors
// activeSuppressionFor() so the newsletter blast can't re-mail addresses every
// other send path already blocks. The correlated subquery references
// newsletter_subscribers.email, so this must be applied to a query that has
// that table in scope (segment build, recipient count, AND the resume/retry
// refetch — the resume path does NOT go through buildSubscriberQuery, so it
// must call this helper directly).
function excludeGloballySuppressed(query) {
  return query.whereNotExists(function () {
    this.select(db.raw('1'))
      .from('email_suppressions as es')
      .where('es.status', 'active')
      .whereRaw('LOWER(es.email) = LOWER(newsletter_subscribers.email)')
      .whereRaw('LOWER(es.suppression_type) IN (?, ?, ?)', GLOBAL_SUPPRESSION_TYPES);
  });
}

// Archived (soft-deleted) customers keep active=true and the archive route
// never touches newsletter_subscribers, so a linked row can sit at
// status='active' (earlier import-customers runs, pre-scope). Fail closed at
// send time: exclude any subscriber whose linked customer has deleted_at set.
// Unlinked rows (customer_id NULL) are untouched. Shared by buildSubscriberQuery
// AND the resume/retry refetch, like excludeGloballySuppressed.
//
// Re-booked households (archived and later re-booked as a NEW customers row —
// no creation entry point re-runs the twin picker) are handled by the relink
// SWEEP, not here: countSegmentRecipients and sendCampaign run
// relinkArchivedLinkedSubscribers before any audience read, so a stale
// archived link with a live same-email twin is repaired to the live row
// before this anti-join sees it. Deliberately NO read-side "live twin
// exists" exception in this predicate (codex #3472 r5): such a lift would
// make the row eligible while customer_id still points at the archived
// profile — segmentation, personalization, and touchpoints would then use
// the archived row. Only successfully RELINKED rows send.
function excludeArchivedCustomers(query) {
  return query.whereNotExists(function () {
    this.select(db.raw('1'))
      .from('customers as ac')
      .whereRaw('ac.id = newsletter_subscribers.customer_id')
      .whereNotNull('ac.deleted_at');
  });
}

// Owner ruling 2026-09-29 (#5165, option A): mailbox mailability is judged
// at SEND TIME by state, not fenced by per-writer locks (the writer-lock
// approach kept spreading into live paths and produced a genuine deadlock —
// see the git history on this predicate for the reverted attempt). This one
// predicate now carries BOTH rules for EVERY audience read:
//
//   1. Explicit marketing opt-out — owner ruling 2026-09-28: exclude an
//      active subscriber when its linked customer, or any live
//      (non-archived) profile holding the same MAILBOX, has marketing_offers
//      = false, email_enabled = false, or a marketing_channel that resolves
//      to 'sms' (email-division/eligibility.js channelFor — only a stored
//      'sms' resolves there; anything else reads as the 'email' default).
//      NULL / missing prefs are NOT an opt-out.
//   2. Non-mailable mailbox sibling — owner ruling 2026-09-29: exclude an
//      active subscriber when ANY OTHER newsletter_subscribers row for the
//      SAME MAILBOX has a status other than 'active'. newsletter_subscribers
//      .status carries no CHECK constraint (schema: a plain string,
//      defaultTo('active')), so this reads every value the code actually
//      writes there — 'unsubscribed' (the unsubscribe routes / SendGrid and
//      Resend complaint webhooks), 'pending' (double opt-in, not yet
//      confirmed), 'inactive' (newsletter-sunset.js, 90-day win-back
//      grace), 'waitlist' (inspection-public.js's out-of-area consultation
//      prompt — never itself a subscription) — plus, fail-closed, any
//      other/unrecognised value or NULL (IS DISTINCT FROM 'active', not
//      `<> 'active'`, so a NULL status blocks too, never silently passing).
//      A hard bounce/spam-complaint alone does NOT write this column —
//      admin-newsletter.js's own comment: "there's no status='bounced' in
//      the table"; bounces live on bounce_count/last_bounced_at and the
//      separate email_suppressions ledger (excludeGloballySuppressed).
//   3. Duplicate ACTIVE rows for the SAME mailbox — codex #5165 P2: rule 2
//      above only catches a sibling whose status is NOT 'active', so a
//      pending Google-alias row that races the import and is later
//      CONFIRMED — both rows now 'active' — passed rule 2 entirely on both
//      sides and both got sent, a duplicate delivery to one inbox. At send
//      time, only ONE active row per mailbox is sendable: the CANONICAL
//      one, deterministically the earliest `created_at` then `id`
//      (matches the tie-break every other canonical pick in this codebase
//      uses — customers' twin picker, the reconcile candidate order —
//      applied here directly on newsletter_subscribers itself, no join to
//      customers needed, since two active rows sharing a mailbox are
//      compared on their OWN rows). Every other active row on that mailbox
//      is excluded.
//
// Same mailbox = exact LOWER(TRIM), or Google's mailbox identity (dots and
// '+tag' ignored, googlemail.com = gmail.com) — the repo's one rule,
// customer-comms-lock.js GOOGLE_MAILBOX_SQL.
//
// Because the check runs on every audience read (buildSubscriberQuery, the
// resume refetch, the per-chunk re-check, the resume precheck, and the
// newsletter-sunset reads), an opt-out or a same-mailbox unsubscribe/pending/
// inactive row recorded after a subscriber joined stops the next campaign,
// and a resume ledger row for that recipient is terminalized through
// skipIneligibleDeliveries.
// Every call site wraps excludeArchivedCustomers with this helper (pinned
// by newsletter-sender-marketing-optout.test.js).
//
// Both the notification_prefs/customers join AND the mailbox-sibling scan
// are pre-filtered FIRST, each in its own `WITH ... AS MATERIALIZED` CTE
// (opted_out_profiles / blocked_mailbox_siblings) — EXPLAIN against the QA
// database (codex #5165) showed Postgres re-running the join/scan ONCE PER
// OUTER SUBSCRIBER ROW (a Nested Loop Anti Join re-executed
// `loops=<subscriber count>` times) whenever the match condition is an OR
// of several LOWER/TRIM/SPLIT_PART comparisons — that shape defeats
// Postgres's usual subquery flattening/decorrelation AND defeats a hash
// join (Postgres can't hash an OR of two different equality keys), so a
// plain (non-materialized) derived table, or a materialized one still
// matched by an OR condition, both get replanned right back into the same
// per-row rescan. opted_out_profiles stays small enough (an opt-out list)
// that this was already fast (measured: 497ms / ~284k buffer hits ->
// 153ms / ~560, same rows, on a 4,000-customer / 800-subscriber seed) —
// but blocked_mailbox_siblings is the WHOLE non-active tail (every
// unsubscribe/pending/inactive/waitlist row ever recorded), routinely much
// larger, so it ALSO needs to be a genuine equality: MAILBOX_KEY_SQL
// collapses "exact match OR Google-alias match" into ONE computed key
// (a Google address's stripped mailbox identity, or the address itself)
// so Postgres can plan the match as a real Hash Anti Join — one hash of
// the small deduped key set, one probe per outer row — instead of a
// nested loop that rescans the whole CTE per row. Measured on the same
// seed plus a 3,000-row non-active tail (40 of them Google-alias siblings
// of active rows): the OR-matched version (materialized, but still an OR)
// ran 1,927ms with `Rows Removed by Join Filter: 2,173,600` — the CTE
// rescanned per outer row despite being materialized; the single-key
// equi-join version ran 166ms as a genuine `Hash Anti Join`, same result
// rows either way.
const { GOOGLE_MAILBOX_SQL } = require('../utils/customer-comms-lock');
const OPTOUT_SAME_MAILBOX_SQL = (() => {
  const profile = 'TRIM(oo.email)';
  const subscriber = 'TRIM(newsletter_subscribers.email)';
  return `(LOWER(${profile}) = LOWER(${subscriber})
    OR (${GOOGLE_MAILBOX_SQL.isGoogle(profile)} AND ${GOOGLE_MAILBOX_SQL.isGoogle(subscriber)}
      AND ${GOOGLE_MAILBOX_SQL.mailbox(profile)} <> ''
      AND ${GOOGLE_MAILBOX_SQL.mailbox(subscriber)} <> ''
      AND ${GOOGLE_MAILBOX_SQL.mailbox(profile)} = ${GOOGLE_MAILBOX_SQL.mailbox(subscriber)}))`;
})();
// One computed key per address: a Google address's mailbox identity
// (dots/+"tag" stripped, always resolved to its @gmail.com spelling), or
// the address itself, LOWER(TRIM)'d, for every other domain. Two rows
// sharing a mailbox always compute the SAME key regardless of which alias
// spelling either one uses — collapsing the exact-match-OR-Google-alias-
// match rule into one equality Postgres can hash-join.
const MAILBOX_KEY_SQL = (fieldExpr) => {
  const trimmed = `TRIM(${fieldExpr})`;
  return `(CASE WHEN ${GOOGLE_MAILBOX_SQL.isGoogle(trimmed)} AND ${GOOGLE_MAILBOX_SQL.mailbox(trimmed)} <> ''
    THEN ${GOOGLE_MAILBOX_SQL.mailbox(trimmed)} || '@gmail.com'
    ELSE LOWER(${trimmed}) END)`;
};
// The ONE sendable row per mailbox among ACTIVE rows: DISTINCT ON collapses
// each mailbox_key to its single earliest (created_at, id) row — the SAME
// deterministic tie-break every other canonical pick in this codebase uses
// (customers' twin picker, the reconcile candidate order), applied here
// directly on newsletter_subscribers's own columns; genuinely one row per
// key, so it hash-joins as cheaply as opted_out_profiles.
//
// The pick runs only over rows that can actually be mailed on their own —
// active AND past the archived-customer and global-suppression predicates
// (codex #5165 :235). Otherwise an oldest alias linked to an archived
// customer (or carrying an exact-address bounce) wins the pick, is then
// dropped by that predicate, and the live sibling is dropped as
// non-canonical: the mailbox gets nothing. The CTE is built on the
// unaliased table so both shared helpers apply to it unchanged.
const CANONICAL_ACTIVE_MAILBOX_SQL = (qb) => {
  excludeArchivedCustomers(excludeGloballySuppressed(
    qb.distinctOn(db.raw(MAILBOX_KEY_SQL('newsletter_subscribers.email')))
      .select(db.raw(`${MAILBOX_KEY_SQL('newsletter_subscribers.email')} as mailbox_key`), 'newsletter_subscribers.id as canonical_id')
      .from('newsletter_subscribers')
      .where('newsletter_subscribers.status', 'active'),
  )).orderByRaw(`${MAILBOX_KEY_SQL('newsletter_subscribers.email')}, newsletter_subscribers.created_at ASC, newsletter_subscribers.id ASC`);
};
function excludeMailboxNotMailable(query) {
  return query
    .withMaterialized('opted_out_profiles', (qb) => {
      qb.select('moc.id as customer_id', 'moc.email as email')
        .from('notification_prefs as mop')
        .join('customers as moc', 'moc.id', 'mop.customer_id')
        .whereNull('moc.deleted_at')
        .whereRaw("(mop.marketing_offers = false OR mop.email_enabled = false OR LOWER(TRIM(mop.marketing_channel)) = 'sms')");
    })
    .withMaterialized('blocked_mailbox_siblings', (qb) => {
      qb.distinct()
        .select(db.raw(`${MAILBOX_KEY_SQL('email')} as mailbox_key`))
        .from('newsletter_subscribers')
        .whereRaw("status IS DISTINCT FROM 'active'");
    })
    .withMaterialized('canonical_active_mailbox', CANONICAL_ACTIVE_MAILBOX_SQL)
    .whereNotExists(function () {
      this.select(db.raw('1'))
        .from('opted_out_profiles as oo')
        .whereRaw(`(oo.customer_id = newsletter_subscribers.customer_id OR ${OPTOUT_SAME_MAILBOX_SQL})`);
    })
    .whereNotExists(function () {
      this.select(db.raw('1'))
        .from('blocked_mailbox_siblings as bm')
        .whereRaw(`bm.mailbox_key = ${MAILBOX_KEY_SQL('newsletter_subscribers.email')}`);
    })
    .whereNotExists(function () {
      this.select(db.raw('1'))
        .from('canonical_active_mailbox as cam')
        .whereRaw(`cam.mailbox_key = ${MAILBOX_KEY_SQL('newsletter_subscribers.email')}`)
        .whereRaw('cam.canonical_id <> newsletter_subscribers.id');
    });
}

// Keys that can't be expressed in SQL against newsletter_subscribers — they
// depend on classifying each customer's active recurring services, so they are
// resolved to a customer_id set by resolveSegmentCustomerIds() first.
const SERVICE_LINE_KEYS = ['has_service', 'missing_service', 'waveguard_tier', 'min_line_count', 'max_line_count'];

function hasServiceLineFilter(segmentFilter) {
  if (!segmentFilter) return false;
  return SERVICE_LINE_KEYS.some((k) => {
    const v = segmentFilter[k];
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    return true;
  });
}

// Coerce one service-line filter value to a clean string array:
//   absent / empty array      → []   (no constraint)
//   all-valid strings, or a single string → [trimmed strings]
//   present but ANY element invalid (non-string / blank), or an uncoercible
//   scalar (number/object)     → null (malformed → caller fails the whole
//                                      service-line filter closed)
// A mixed array like ['lawn', 123] returns null rather than the narrowed valid
// subset, so an ambiguous segment can't quietly broaden to that subset.
function toLineArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) {
    if (v.length === 0) return [];
    const cleaned = v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
    return cleaned.length === v.length ? cleaned : null;
  }
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return null;
}
// Coerce one filter value to a valid line-count: a non-negative INTEGER no
// larger than the sellable-line universe ('1' → 1, 0 allowed). Anything else
// (negative, fractional, out of range, non-numeric) → null = invalid, so a
// constraint like { min_line_count: -1 } can't quietly match every customer.
function toLineCount(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  if (!Number.isInteger(n) || n < 0 || n > SELLABLE_LINES.length) return null;
  return n;
}

/**
 * Coerce the service-line / membership portion of a segment filter into a clean
 * constraint object. Pure (no I/O) so it is unit-testable. Returns:
 *   null  — the filter carries NO service-line intent (legacy SQL-only path).
 *   {}    — intent was present but every key was malformed/uncoercible. Callers
 *           MUST treat {} as "match NOBODY" (fail closed) — never let an empty
 *           constraint fall through to selectAudience({}) = everyone.
 *   {...} — the usable, coerced constraint.
 */
function narrowServiceLineFilter(segmentFilter) {
  if (!hasServiceLineFilter(segmentFilter)) return null;
  const f = segmentFilter;
  const narrowed = {};
  const hasSvc = toLineArray(f.has_service);
  const missingSvc = toLineArray(f.missing_service);
  const tier = toLineArray(f.waveguard_tier);
  // null = present-but-malformed (e.g. ['lawn', 123]) → fail the WHOLE filter
  // closed rather than narrow to the valid subset.
  if (hasSvc === null || missingSvc === null || tier === null) return {};
  if (hasSvc.length) narrowed.has_service = hasSvc;
  if (missingSvc.length) narrowed.missing_service = missingSvc;
  if (tier.length) narrowed.waveguard_tier = tier;
  // Line-count keys: a PRESENT-but-invalid count (negative, fractional, out of
  // range, non-numeric) fails the WHOLE filter closed — never silently drop the
  // constraint and broaden the audience.
  for (const key of ['min_line_count', 'max_line_count']) {
    if (f[key] == null) continue;
    const n = toLineCount(f[key]);
    if (n === null) return {}; // malformed count intent → match nobody
    narrowed[key] = n;
  }
  return narrowed;
}

/**
 * Resolve the service-line / membership portion of a segment filter to the set
 * of matching customer ids. Returns null when the filter has no service-line
 * keys (so buildSubscriberQuery applies no whereIn and legacy behavior is
 * preserved exactly). Returns [] (matches nobody) when the service-line keys
 * are present but malformed — a 0-row query the empty-segment guards handle —
 * so a typo'd/mistyped filter can never silently broaden to all customers.
 */
async function resolveSegmentCustomerIds(segmentFilter) {
  const narrowed = narrowServiceLineFilter(segmentFilter);
  if (narrowed === null) return null;              // no service-line intent
  if (Object.keys(narrowed).length === 0) return []; // malformed intent → fail closed
  const profiles = await selectAudience(narrowed, { recurringOnly: true });
  return profiles.map((p) => p.customer_id).filter(Boolean);
}

/**
 * Batch-load per-recipient personalization (city + grass-type label) for the
 * linked customers in a send. Reuses the canonical grass source
 * (customer_turf_profiles.grass_type, fallback normalized customers.lawn_type)
 * and defaults grass to St. Augustine when unknown (owner directive). Returns
 * Map<customer_id, { city, grassLabel }>. Never throws — missing data falls
 * back to defaults at substitution time.
 */
async function loadPersonalizationContext(subscribers) {
  const customerIds = Array.from(new Set((subscribers || []).map((s) => s.customer_id).filter(Boolean)));
  const map = new Map();
  if (!customerIds.length) return map;
  try {
    const [customers, turf] = await Promise.all([
      db('customers').whereIn('id', customerIds).select('id', 'city', 'lawn_type'),
      db('customer_turf_profiles').whereIn('customer_id', customerIds).where({ active: true }).select('customer_id', 'grass_type'),
    ]);
    const grassByCustomer = new Map(turf.map((t) => [t.customer_id, t.grass_type]));
    for (const c of customers) {
      const key = grassByCustomer.get(c.id) || normalizeGrassType(c.lawn_type) || null;
      const grassLabel = key && key !== 'unknown' ? (grassTypeLabel(key) || DEFAULT_GRASS_LABEL) : DEFAULT_GRASS_LABEL;
      map.set(c.id, {
        city: sanitizePersonalizationToken(c.city) || DEFAULT_CITY_LABEL,
        grassLabel: sanitizePersonalizationToken(grassLabel) || DEFAULT_GRASS_LABEL,
      });
    }
  } catch (err) {
    logger.warn(`[newsletter] personalization context load failed: ${err.message}`);
  }
  return map;
}

/**
 * Shared 0-recipient preflight — EVERY audience count that gates a send
 * (manual-send route, proof approval, scheduler claim-validation,
 * sendCampaign's own guard) must count through here, never through a bare
 * subscriber-query count (codex #3472 r3). It runs the archived-link
 * relink sweep FIRST: a service-line segment whose only recipients are
 * re-booked households would otherwise count zero off stale archived links
 * the send itself is about to repair — the preflight and the real audience
 * query must observe the same links.
 */
async function countSegmentRecipients(segmentFilter) {
  await NewsletterSubscribers.relinkArchivedLinkedSubscribers(db);
  const row = await buildSubscriberQuery(segmentFilter, await resolveSegmentCustomerIds(segmentFilter))
    .count('* as c')
    .first();
  return Number(row?.c || 0);
}

/**
 * @param {object|null} segmentFilter
 * @param {string[]|null} [customerIds] pre-resolved set from
 *   resolveSegmentCustomerIds(); null = no service-line constraint.
 */
function buildSubscriberQuery(segmentFilter, customerIds = null) {
  let q = excludeMailboxNotMailable(excludeArchivedCustomers(excludeGloballySuppressed(db('newsletter_subscribers').where({ status: 'active' }))));

  // Service-line / membership constraint, pre-resolved to customer ids.
  if (Array.isArray(customerIds)) q = q.whereIn('customer_id', customerIds);

  if (!segmentFilter) return q;

  const f = segmentFilter;
  if (Array.isArray(f.sources) && f.sources.length) q = q.whereIn('source', f.sources);
  // `audience: 'customers'|'leads'` is the canonical shape used by
  // newsletter-audience-profiles + the preview script; legacy customersOnly /
  // leadsOnly stay supported. Admin routes persist req.body.segmentFilter
  // verbatim, so an UNKNOWN audience value (typo like 'customer') must fail
  // closed — match nobody, hit the EMPTY_SEGMENT guard — not fall through and
  // broadcast to ALL active subscribers (the send path runs buildSubscriberQuery,
  // not matchesFilter).
  if (f.customersOnly || f.audience === 'customers') q = q.whereNotNull('customer_id');
  if (f.leadsOnly || f.audience === 'leads') q = q.whereNull('customer_id');
  if (f.audience != null && f.audience !== 'customers' && f.audience !== 'leads') {
    q = q.whereRaw('1 = 0');
  }
  // region_zone: any-of array (a single string is coerced). A present-but-
  // unusable value — a non-string scalar, or an array carrying a malformed
  // element — fails closed instead of broadening to every region. An empty
  // array stays a no-op (no region intent), mirroring the service-line keys.
  if (f.region_zone != null && !(Array.isArray(f.region_zone) && f.region_zone.length === 0)) {
    const raw = Array.isArray(f.region_zone) ? f.region_zone : [f.region_zone];
    const zones = raw.filter((z) => typeof z === 'string' && z.trim()).map((z) => z.trim());
    if (zones.length && zones.length === raw.length) q = q.whereIn('region_zone', zones);
    else q = q.whereRaw('1 = 0'); // malformed region intent → match nobody
  }
  if (Array.isArray(f.tags) && f.tags.length) {
    q = q.whereRaw('tags \\?| array[' + f.tags.map(() => '?').join(',') + ']', f.tags);
  }
  return q;
}

function assignAbVariant() {
  return Math.random() < 0.5 ? 'a' : 'b';
}

// SendGrid event webhooks echo this set back verbatim per recipient. The
// newsletter handler in webhooks-sendgrid.js falls back to matching on
// custom_args.delivery_id when the X-Message-Id-based lookup fails, which
// covers the "we lost the SendGrid response but they actually queued the
// batch" case. Without this, those rows stay 'failed' forever and an
// operator-triggered resume would double-send.
const TERMINAL_SUCCESS_STATUSES = ['sent', 'delivered', 'opened', 'clicked'];
const RETRYABLE_DELIVERY_STATUSES = ['queued', 'failed', 'sending'];
// Terminal, never retried: recipient failed the eligibility re-check at
// dispatch (archived customer / no longer active). status is a plain string
// column (20260418000008), so no constraint change.
const SKIPPED_DELIVERY_STATUS = 'skipped';
const DEFAULT_SENDING_LEASE_MINUTES = 30;

function sendingLeaseMinutes() {
  const configured = Number(process.env.NEWSLETTER_SENDING_LEASE_MINUTES);
  return Number.isFinite(configured) && configured >= 5 && configured <= 1440
    ? configured
    : DEFAULT_SENDING_LEASE_MINUTES;
}

// updated_at doubles as the claim heartbeat: sendCampaign touches it after
// every chunk, so "stale" means no chunk progress for a full lease window —
// not merely a long-running send.
function sendingClaimIsStale(send, now = new Date()) {
  if (send?.status !== 'sending') return false;
  const claimedAt = new Date(send.updated_at || send.created_at || 0).getTime();
  if (!Number.isFinite(claimedAt) || claimedAt <= 0) return false;
  return claimedAt <= now.getTime() - sendingLeaseMinutes() * 60 * 1000;
}

function isRetryableDelivery(delivery) {
  if (!delivery) return false;
  const status = String(delivery.status || '').toLowerCase();
  if (!RETRYABLE_DELIVERY_STATUSES.includes(status)) return false;
  return !delivery.sent_at && !delivery.delivered_at && !delivery.opened_at && !delivery.clicked_at;
}

function hasDeliverySuccessSignal(delivery) {
  if (!delivery) return false;
  const status = String(delivery.status || '').toLowerCase();
  return TERMINAL_SUCCESS_STATUSES.includes(status)
    || !!delivery.sent_at
    || !!delivery.delivered_at
    || !!delivery.opened_at
    || !!delivery.clicked_at;
}

function applyDeliveryNoSuccessFilter(query, tableAlias = null) {
  const col = (name) => (tableAlias ? `${tableAlias}.${name}` : name);
  return query
    .whereNull(col('sent_at'))
    .whereNull(col('delivered_at'))
    .whereNull(col('opened_at'))
    .whereNull(col('clicked_at'));
}

function applyRetryableDeliveryFilter(query, tableAlias = null) {
  const col = (name) => (tableAlias ? `${tableAlias}.${name}` : name);
  return applyDeliveryNoSuccessFilter(query, tableAlias)
    .whereIn(col('status'), RETRYABLE_DELIVERY_STATUSES);
}

// The rows a Resume would actually mail: retryable ledger rows with no
// success signal whose subscriber is still active, not globally suppressed,
// not an archived customer, and whose mailbox is mailable — not explicitly
// opted out of marketing and no same-mailbox sibling row in a non-active
// state (excludeMailboxNotMailable) — the resume precheck's own predicate,
// in one place. `sendId` is a value, or (with `correlate`) a column reference
// such as `newsletter_sends.id` when the caller embeds this as an EXISTS
// subquery.
function outstandingEligibleDeliveries(sendId, { database = db, correlate = false } = {}) {
  const base = database('newsletter_send_deliveries')
    .join('newsletter_subscribers', 'newsletter_subscribers.id', 'newsletter_send_deliveries.subscriber_id')
    .where({ 'newsletter_subscribers.status': 'active' });
  // A correlated caller passes a column reference; whereColumn quotes it as
  // an identifier, so nothing is ever interpolated into SQL (pre-push audit).
  const scoped = correlate
    ? base.whereColumn('newsletter_send_deliveries.send_id', sendId)
    : base.where({ 'newsletter_send_deliveries.send_id': sendId });
  return excludeMailboxNotMailable(excludeArchivedCustomers(excludeGloballySuppressed(applyRetryableDeliveryFilter(scoped, 'newsletter_send_deliveries'))));
}

// Whether a campaign still has recipients a Resume would mail. THE predicate
// behind "correctable" (codex round 14 on #5187): a fully delivered campaign
// has a ledger too, and its archive must stay what its recipients received,
// so a ledger row alone never makes a campaign correctable — and neither do
// rows whose recipients Resume would exclude and terminalize anyway
// (unsubscribed, globally suppressed, archived, explicitly opted out;
// codex round 17 P2).
async function hasOutstandingDeliveries(sendId, database = db) {
  // Relinked first, like the resume precheck (codex round 18 P2): a row whose
  // archived link has a live twin is outstanding, not excluded.
  await NewsletterSubscribers.relinkArchivedLinkedSubscribers(database);
  const row = await outstandingEligibleDeliveries(sendId, { database }).first('newsletter_send_deliveries.id');
  return Boolean(row);
}

/**
 * THE terminal-skip write. A recipient that fails the eligibility predicate
 * (status active + not globally suppressed + no archived customer link +
 * no explicit marketing opt-out) after selection must never be mailed AND must never stay retryable — a
 * resume would otherwise re-queue it, and prepareResumeCampaign would keep
 * counting it as outstanding. Both eligibility gates land here: the
 * pre-dispatch resume sweep (rows still queued/failed) and the per-chunk
 * re-check right before SendGrid (resume rows already claimed to 'sending').
 * `claimed` selects the claimed-row variant (match by delivery id, filter on
 * 'sending' + no success signal); `allRetryable` sweeps every retryable row of
 * the send (used when the resume precheck has already proven NONE of them is
 * eligible); otherwise rows are matched by subscriber id or delivery id under
 * the retryable filter.
 *
 * RETURNS THE NUMBER OF ROWS THAT ACTUALLY TRANSITIONED — which can be lower
 * than the candidate count, because the filters are the concurrency guard: a
 * provider webhook may have moved a row to bounced/complained (or stamped a
 * success timestamp) in between. Callers MUST count with this return value,
 * never with candidates.length, and must still drop every candidate from the
 * SendGrid payload — failing eligibility is reason enough not to mail
 * someone, whether or not this write is the one that terminalized the row.
 */
async function skipIneligibleDeliveries(sendId, { deliveryIds = null, subscriberIds = null, claimed = false, allRetryable = false } = {}) {
  const q = db('newsletter_send_deliveries').where({ send_id: sendId });
  if (allRetryable) {
    // No id predicate on purpose — the caller proved the whole retryable set
    // is ineligible. Explicit flag so a missing/empty id list can never widen
    // into "skip everything".
  } else if (deliveryIds) {
    if (!deliveryIds.length) return 0;
    if (claimed) q.where({ status: 'sending' });
    q.whereIn('id', deliveryIds);
  } else {
    if (!subscriberIds || !subscriberIds.length) return 0;
    q.whereIn('subscriber_id', subscriberIds);
  }
  const updated = await (claimed ? applyDeliveryNoSuccessFilter(q) : applyRetryableDeliveryFilter(q))
    .update({
      status: SKIPPED_DELIVERY_STATUS,
      bounce_reason: 'ineligible_at_dispatch',
      send_attempt_token: null,
      updated_at: new Date(),
    });
  return Number(updated || 0);
}

async function claimRetryableDeliveriesForResume(sendId, subscriberIds) {
  if (!subscriberIds.length) return [];
  const attemptToken = crypto.randomUUID();
  const rows = await applyRetryableDeliveryFilter(
    db('newsletter_send_deliveries')
      .where({ send_id: sendId })
      .whereIn('subscriber_id', subscriberIds),
  )
    // A resume attempt gets a fresh SendGrid message id; keep delayed events
    // from the previous attempt out of the provider_message_id fast path.
    .update({
      status: 'sending',
      provider_message_id: null,
      send_attempt_token: attemptToken,
      updated_at: new Date(),
    })
    .returning(['id', 'subscriber_id', 'send_attempt_token']);
  return rows.map((row) => ({ ...row, send_attempt_token: row.send_attempt_token || attemptToken }));
}

/**
 * Send a campaign (now). Used by the immediate-send route and the
 * scheduler tick. Idempotent-ish: refuses to re-send non-draft/non-scheduled
 * rows, and flips status to 'sending' before doing any external work.
 *
 * Per-recipient idempotency: resume sends only retry explicitly transient
 * rows (queued / failed / abandoned sending with no success or engagement
 * timestamps). Provider terminal rows such as delivered, bounced, or
 * complained are skipped.
 *
 * opts.force — bypass the 0-recipient guard. The route layer also
 *   pre-validates so the operator gets a 400 with a force=true hint;
 *   this in-sender check covers the scheduler-tick path (which has no
 *   pre-flight) and the rare race where the segment empties between
 *   pre-flight and dispatch.
 *
 * opts.preclaimed — caller already atomically moved the row to 'sending'.
 *   Used by resume so it never reopens a send as generic 'scheduled'.
 *
 * Returns { recipients, accepted, failed }.
 */
async function sendCampaign(sendId, opts = {}) {
  if (!sendgrid.isConfigured()) throw new Error('SendGrid not configured (SENDGRID_API_KEY missing)');

  const send = await db('newsletter_sends').where({ id: sendId }).first();
  if (!send) throw new Error('not found');
  // A version-bound caller (the scheduler tick, the manual send) learns that
  // the row changed BEFORE any pre-claim gate reads it (codex round 18 P2): a
  // draft edited after the caller validated it (bodies cleared, segment
  // emptied) reports VERSION_CHANGED and stays an editable draft, instead of
  // failing a body or segment gate the caller records as a dispatch failure.
  // The atomic claim below re-checks the same version.
  if (opts.expect && !opts.preclaimed) {
    const changed = send.status !== (opts.expect.status || 'scheduled')
      || (opts.expect.updatedAt && !(new Date(send.updated_at) < noLaterThan(opts.expect.updatedAt)))
      || (opts.expect.proofApprovedAt
        && !(send.proof_approved_at && new Date(send.proof_approved_at) < noLaterThan(opts.expect.proofApprovedAt)));
    if (changed) {
      const claimedElsewhere = !['draft', 'scheduled'].includes(send.status);
      const err = new Error(claimedElsewhere ? 'already sent or in progress' : 'row changed since it was validated');
      err.code = claimedElsewhere ? 'ALREADY_CLAIMED' : 'VERSION_CHANGED';
      throw err;
    }
  }
  if (!send.html_body && !send.text_body) throw new Error('body required');

  // Editorial + cadence pre-flight applies to the ORIGINAL dispatch only.
  // A TRUE PARTIAL resume — preclaimed AND constrained to the existing
  // delivery ledger — re-mails a campaign that already passed these gates:
  // re-validating the lineup would reject it against itself (a partial
  // first pass finalizes 'sent' and markEventsFeatured advances
  // times_featured, so the same locked ids read as "no longer new"), and
  // the 6:00–6:14 delivery window would block stalled-send recovery at
  // 6:30. A ZERO-LEDGER resume (failed before any delivery rows were
  // seeded) reseeds the whole audience — that IS a first send, so it faces
  // the full gates: no resuming an entire issue outside the Tuesday window
  // or on a stale lineup.
  if (opts.preclaimed && opts.existingDeliveriesOnly) {
    // Partial resume: the freshness/cadence gates above are DELIBERATELY
    // bypassed (a partial send must be able to finish its own issue), but
    // the LIVE page recheck is not — retryable recipients must not receive
    // an event that died between the first pass and recovery. Gate-off or
    // fetch flake still passes (reverifyEvents fails open on infra).
    const lockedIds = [...new Set(parseLockedEventIds(send.event_ids).map(String))];
    if (lockedIds.length && reverifyEnabled()) {
      const lockedRows = await db('events_raw')
        .whereIn('id', lockedIds)
        .select('id', 'title', 'event_url');
      if (lockedRows.length !== lockedIds.length) {
        // A locked event deleted/merged since the first pass would simply
        // vanish from the recheck — retry recipients would receive stale
        // content for an event that no longer exists.
        const err = new Error(`live page recheck failed on resume: ${lockedIds.length - lockedRows.length} locked event(s) no longer exist`);
        err.code = 'EVENT_REVERIFY_FAILED';
        throw err;
      }
      const resumeRecheck = await reverifyEvents(lockedRows);
      if (!resumeRecheck.ok) {
        const err = new Error(`live page recheck failed on resume: ${resumeRecheck.failures.map((f) => `${f.title} — ${f.reason}`).join('; ')}`);
        err.code = 'EVENT_REVERIFY_FAILED';
        throw err;
      }
    }
  }
  if (!(opts.preclaimed && opts.existingDeliveriesOnly)) {
    const eventSelection = await validateFlagshipEventSelection(send);
    if (eventSelection.flagship) {
      if (!eventSelection.valid) {
        const err = new Error(`flagship event selection is no longer eligible: ${eventSelection.errors.join(' ')}`);
        err.code = 'EVENT_SELECTION_INVALID';
        throw err;
      }
      // Live official-page recheck (dark behind NEWSLETTER_LIVE_REVERIFY):
      // fail closed ONLY on confirmed dead-event evidence — a listed event
      // whose page is gone or explicitly cancelled must not reach inboxes.
      const recheck = await reverifyEvents(eventSelection.events);
      if (!recheck.ok) {
        const err = new Error(`live page recheck failed: ${recheck.failures.map((f) => `${f.title} — ${f.reason}`).join('; ')}`);
        err.code = 'EVENT_REVERIFY_FAILED';
        throw err;
      }
      const now = new Date();
      if (send.status === 'scheduled' && !isCurrentFlagshipTarget(send.scheduled_for, now)) {
        const err = new Error('scheduled flagship target is not the current issue Tuesday at 6:00 AM ET');
        err.code = 'FLAGSHIP_SCHEDULE_TARGET';
        throw err;
      }
      if (!isFlagshipDeliveryWindow(now)) {
        const err = new Error('flagship newsletters can only be delivered Tuesday at 6:00 AM ET');
        err.code = 'FLAGSHIP_CADENCE_WINDOW';
        throw err;
      }
    }
  }

  // Repair stale archived links BEFORE anything reads ns.customer_id —
  // including the 0-recipient guard just below (codex #3472 P1 round 2: a
  // service-line campaign whose only recipients are re-booked households
  // would otherwise throw EMPTY_SEGMENT before the sweep ran). The lift in
  // excludeArchivedCustomers decides DELIVERY, but segment resolution,
  // personalization, and touchpoint history all key on ns.customer_id —
  // left pointing at the archived profile, they would classify and record
  // against the wrong row. Set-based, idempotent, same picker as the
  // archive/restore relinks. Errors propagate (fail closed): sending with a
  // stale link is exactly the bug this prevents, and the send needs this
  // same DB anyway. Runs for fresh sends AND resumes — a resume's retryable
  // recipients re-read customer_id at dispatch time too.
  const { relinked: relinkedStaleLinks } = await NewsletterSubscribers.relinkArchivedLinkedSubscribers(db);
  if (relinkedStaleLinks) {
    logger.info(`[newsletter] send ${send.id}: relinked ${relinkedStaleLinks} subscriber(s) from archived profiles to their live twins`);
  }

  // 0-recipient guard — runs BEFORE the atomic claim so a no-op send
  // doesn't burn the row's status from draft/scheduled to sending only
  // to immediately land as 'sent' with recipient_count=0.
  if (!opts.force) {
    // countSegmentRecipients re-runs the (idempotent) relink sweep — that
    // redundancy with the sweep above is deliberate: this guard must stay
    // correct even if the calls around it are ever reordered.
    if (await countSegmentRecipients(send.segment_filter) === 0) {
      const err = new Error('segment matches 0 active subscribers');
      err.code = 'EMPTY_SEGMENT';
      throw err;
    }
  }

  // Owner token for this worker's 'sending' claim. Every claim path (first
  // send here, resume/stale-reclaim in prepareResumeCampaign) stamps its own
  // token; the per-chunk heartbeat doubles as an ownership check so a worker
  // whose stale claim was reclaimed by recovery stops before mailing another
  // chunk — instead of waking from a slow SendGrid call and racing the new
  // owner into duplicate emails. A preclaimed caller that didn't thread the
  // prepared token falls back to the token stored ON the row by its own
  // claim (the row can't have been reclaimed in between — it was claimed
  // moments ago, so it is neither stale nor claimable); minting a fresh one
  // there would fail our own first heartbeat and strand the campaign in
  // 'sending' until the lease expires.
  const claimToken = opts.claimToken
    || (opts.preclaimed ? send.sending_claim_token : null)
    || crypto.randomUUID();

  if (opts.preclaimed) {
    if (send.status !== 'sending') {
      const err = new Error('already sent or in progress');
      err.code = 'ALREADY_CLAIMED';
      throw err;
    }
  } else {
    // Atomic claim: only one caller can flip draft/scheduled -> sending.
    // Returning the rows lets us distinguish 'lost the race' (0 rows) from
    // 'won' (1 row). Without this guard, the immediate-send route + the
    // scheduler tick can both pick up the same row and double-send.
    // The race-loser is tagged so dispatch-side catch handlers can skip
    // the 'failed' flip because the row is actively sending under the winner.
    let claim = db('newsletter_sends').where({ id: send.id });
    if (opts.expect) {
      // Version-bound claim (the scheduler tick): the row must still be the
      // exact scheduled version the tick read and validated — same status,
      // no later edit (updated_at), no later approval. A PATCH landing
      // between the tick's read and this claim rewrites the content and
      // moves updated_at (and returns the row to draft), so the claim finds
      // nothing and edited, unapproved content is never broadcast. The +1ms
      // absorbs sub-millisecond precision the driver drops on read.
      claim = claim.where({ status: opts.expect.status || 'scheduled' });
      if (opts.expect.updatedAt) claim = claim.where('updated_at', '<', noLaterThan(opts.expect.updatedAt));
      if (opts.expect.proofApprovedAt) {
        claim = claim.whereNotNull('proof_approved_at').where('proof_approved_at', '<', noLaterThan(opts.expect.proofApprovedAt));
      }
    } else {
      claim = claim.whereIn('status', ['draft', 'scheduled']);
    }
    const claimed = await claim
      .update({ status: 'sending', sending_claim_token: claimToken, updated_at: new Date() })
      .returning('id');
    if (!claimed.length) {
      // A version-bound claim finds nothing for two different reasons: the
      // content was edited (the row is still draft/scheduled — nothing went
      // out, VERSION_CHANGED), or another claimant (a tick, a second click)
      // already took the row (sending/sent/failed — ALREADY_CLAIMED, the
      // winner owns the outcome). Re-read to tell them apart, so a caller
      // never reports "not sent" for a campaign the winner is sending
      // (pre-push audit P1). A failed re-read falls back to VERSION_CHANGED.
      let claimedElsewhere = !opts.expect;
      if (opts.expect) {
        try {
          const current = await db('newsletter_sends').where({ id: send.id }).first('status');
          claimedElsewhere = !!current?.status && !['draft', 'scheduled'].includes(current.status);
        } catch (readErr) {
          logger.warn(`[newsletter] claim re-read for ${send.id} failed: ${readErr.message}`);
        }
      }
      const err = new Error(claimedElsewhere ? 'already sent or in progress' : 'row changed since it was validated');
      err.code = claimedElsewhere ? 'ALREADY_CLAIMED' : 'VERSION_CHANGED';
      throw err;
    }
  }

  // The delivery ledger is the audience boundary: a campaign that already
  // has delivery rows is resumed, never re-seeded — on EVERY path. A
  // partially delivered campaign returned to draft (an invalid resume, codex
  // round 11) and sent again through the normal Send path must reach only
  // its outstanding ledger rows, never subscribers who joined the segment
  // since the first pass. Checked after the claim, so the row is ours.
  if (!opts.existingDeliveriesOnly) {
    const ledgerRow = await db('newsletter_send_deliveries').where({ send_id: send.id }).first('id');
    if (ledgerRow) {
      logger.info(`[newsletter] send ${send.id} already has a delivery ledger — sending to its outstanding rows only, not re-seeding the segment`);
      opts = { ...opts, existingDeliveriesOnly: true };
    }
  }

  let subscribers = [];
  // Recipients dropped for ineligibility: the pre-dispatch resume sweep plus
  // the per-chunk re-check. Subtracted from recipientCount before
  // finalization. skippedAtDispatch is the chunk-loop share only (those
  // recipients ARE inside subscribersToSend, so the all-failed maths needs
  // them separately).
  let skippedIneligible = 0;
  let skippedAtDispatch = 0;
  const useAb = !!send.subject_b;

  // Pre-seed per-recipient deliveries with A/B assignment. The onConflict
  // is the idempotency keystone for new sends — existing rows survive the
  // insert. Resume mode with existing rows skips this entirely so a changed
  // segment or new subscribers cannot expand an old campaign's audience.
  if (!opts.existingDeliveriesOnly) {
    subscribers = await buildSubscriberQuery(send.segment_filter, await resolveSegmentCustomerIds(send.segment_filter));
    logger.info(`[newsletter] send ${send.id} → ${subscribers.length} subscribers (segment=${send.segment_filter ? JSON.stringify(send.segment_filter) : 'all'})`);
    const deliveryRows = subscribers.map((s) => ({
      send_id: send.id,
      subscriber_id: s.id,
      email: s.email,
      status: 'queued',
      ab_variant: useAb ? assignAbVariant() : null,
    }));
    if (deliveryRows.length) {
      await db('newsletter_send_deliveries').insert(deliveryRows).onConflict(['send_id', 'subscriber_id']).ignore();
    }
  }
  const existingDeliveries = await db('newsletter_send_deliveries')
    .where({ send_id: send.id })
    .select('id', 'subscriber_id', 'status', 'ab_variant', 'sent_at', 'delivered_at', 'opened_at', 'clicked_at', 'send_attempt_token', 'engagement_token');

  if (opts.existingDeliveriesOnly) {
    const retryableSubscriberIds = Array.from(new Set(existingDeliveries
      .filter(isRetryableDelivery)
      .map((d) => d.subscriber_id)
      .filter((id) => id !== null && id !== undefined)));
    subscribers = retryableSubscriberIds.length
      ? await excludeMailboxNotMailable(excludeArchivedCustomers(excludeGloballySuppressed(
        db('newsletter_subscribers')
          .where({ status: 'active' })
          .whereIn('id', retryableSubscriberIds),
      ))).select('id', 'email', 'unsubscribe_token', 'customer_id', 'first_name')
      : [];
    logger.info(`[newsletter] send ${send.id} → ${subscribers.length} active retryable recipient(s) from original delivery ledger (globally-suppressed excluded)`);

    // The refetch above drops recipients that became ineligible since the
    // original send (unsubscribed, globally suppressed, customer archived
    // with no live twin) — but dropping them from the JS array alone leaves
    // their delivery rows queued/failed: retryable forever, still inside
    // recipient_count, re-mailed by the next resume (and prepareResume can
    // report NOTHING_TO_RESUME while those rows still sit in the ledger).
    // Terminalize them BEFORE subscribersToSend is built, through the same
    // skip write the per-chunk re-check uses.
    const eligibleIds = new Set(subscribers.map((s) => s.id));
    const ineligibleRows = existingDeliveries.filter((d) => isRetryableDelivery(d)
      && d.subscriber_id !== null && d.subscriber_id !== undefined
      && !eligibleIds.has(d.subscriber_id));
    if (ineligibleRows.length) {
      // Count the rows this write actually transitioned, not the candidates:
      // a webhook may have already terminalized one (bounced/complained), and
      // counting it here too would double-subtract from recipient_count.
      const swept = await skipIneligibleDeliveries(send.id, { deliveryIds: ineligibleRows.map((d) => d.id) });
      skippedIneligible += swept;
      logger.info(`[newsletter] send ${send.id} skipped ${swept}/${ineligibleRows.length} retryable ledger row(s) whose recipient is no longer eligible (archived customer / suppressed / not active)`);
    }
  }

  const deliveryBySub = new Map(existingDeliveries.map((d) => [d.subscriber_id, d]));
  const successfulDeliveryCount = existingDeliveries.filter(hasDeliverySuccessSignal).length;
  // Per-recipient idempotency: first sends target newly queued rows; resume
  // sends only retry explicitly transient rows. Provider terminal rows like
  // bounced/complained are not re-mailed.
  const subscribersToSend = subscribers.filter((s) => {
    const d = deliveryBySub.get(s.id);
    if (opts.existingDeliveriesOnly && !d) return false;
    return !d || isRetryableDelivery(d);
  });
  // Rows already terminal-'skipped' (an earlier sweep, here or in
  // prepareResumeCampaign) are not recipients of this campaign — never count
  // them. Rows this run skips are subtracted separately, after the loop.
  let recipientCount = opts.existingDeliveriesOnly
    ? existingDeliveries.filter((d) => d.status !== SKIPPED_DELIVERY_STATUS).length
    : subscribers.length;
  // Ledger rows already terminalized by the sweep above are not "already
  // sent" — they are ineligible, and counted as such.
  const skippedAlreadySent = recipientCount - skippedIneligible - subscribersToSend.length;
  if (skippedAlreadySent > 0) {
    logger.info(`[newsletter] send ${send.id} skipping ${skippedAlreadySent} recipient(s) already in non-retryable state (resume)`);
  }

  // Every edition ends with the reaction footer (owner directive
  // 2026-07-17). Assembled drafts already carry the token; hand-composed
  // campaigns get it appended so the ask is a system property — same
  // philosophy as ensureLegalTextFooter. The SAME helper runs in the
  // composer preview, test send, and owner proof, so review surfaces always
  // show the footer the broadcast will carry. Local copies only: the
  // persisted html_body stays the operator's content; deterministic, so
  // resumes rebuild identically.
  const { html: bodyHtml, text: bodyText } = ensureFeedbackToken({
    html: send.html_body || '',
    text: send.text_body,
  });

  // Wrap the operator-written body in branded chrome (header + footer
  // + Waves logo). The unsubscribe URL is the SendGrid substitution
  // token — sendBatch injects a real per-recipient URL in its place.
  const htmlWithFooter = wrapNewsletter({
    body: bodyHtml,
    unsubscribeUrl: '{{unsubscribe_url}}',
    preheader: send.preview_text || undefined,
    newsletterType: send.newsletter_type || undefined,
    preferredSourcesCta: true,
    // Web-version permalink — the Astro archive page for this issue.
    webVersionUrl: send.slug ? `https://www.wavespestcontrol.com/newsletter/archive/${send.slug}` : undefined,
    // Legacy bodies (persisted before the dark-mode layer) carry no dm-*
    // hooks and must stay on the light card.
    darkAwareBody: bodyIsDarkAware(bodyHtml),
  });

  let accepted = 0, failed = 0;
  let claimLost = false;

  // O(1) variant lookup per subscriber. The previous .filter().find() was
  // O(n²) — at 5k subscribers that's 25M comparisons before the first
  // SendGrid call. Reads the canonical ab_variant from the persisted row
  // so a resume picks up the same A/B split the first pass assigned.
  const variantBySub = new Map(existingDeliveries.map((d) => [d.subscriber_id, d.ab_variant]));

  // Body for customer touchpoints — pure function on the campaign body,
  // hoisted out of the loop. Same for every recipient.
  // Neutralize every merge tag: substitution happens inside SendGrid's payload,
  // so the raw body still carries {{greeting-name}}/{{city}}/{{grass-type}} —
  // touchpoints record the neutral form (matches a no-name/no-data subscriber).
  const touchpointBody = stripPersonalizationTokens(send.text_body || stripHtml(send.html_body));

  // Per-recipient city + grass-type for the {{city}} / {{grass-type}} tokens.
  // Batch-loaded once; resolved per recipient in the substitutions map below.
  const personalizationByCustomer = await loadPersonalizationContext(subscribersToSend);

  // Does this campaign carry an in-email quiz? Computed once. When true, each
  // recipient's quiz token(s) — {{quiz}} / {{quiz:id}} / {{quiz-text}} /
  // {{quiz-text:id}} — resolve to a block whose answer links carry THAT
  // recipient's engagement_token (newsletter-quiz.js). quizBody is scanned for
  // the tokens; html + text are joined so a token in either part is found.
  const quizBody = [bodyHtml, bodyText].filter(Boolean).join('\n');
  const quizEnabled = hasQuizToken(quizBody);
  // Reaction footer ({{feedback}} / {{feedback-text}}): same per-recipient
  // substitution mechanics as the quiz — links carry the recipient's
  // engagement_token so a tap lands on the right delivery row. Scanned on
  // the local copies so the send-time append above is always resolved.
  const feedbackEnabled = hasFeedbackToken(quizBody);
  // Event click-tracking tokens ({{evclick:<eventId>}}): substituted per
  // recipient with the tracking redirect carrying their engagement_token —
  // same substitution mechanics as the quiz/feedback tokens. The direct
  // event URLs are the fallback for recipients without a token.
  const {
    evclickIdsInBody, buildEvclickSubstitutions, eventUrlMapForSend,
  } = require('./newsletter-event-clicks');
  const evclickEnabled = evclickIdsInBody(quizBody).length > 0;
  const evclickUrlById = evclickEnabled ? await eventUrlMapForSend(send) : new Map();

  // Split by variant so each batch uses the right subject line. When A/B is
  // off every delivery gets variant=null and we just ship one group.
  const variants = useAb ? ['a', 'b'] : [null];
  for (const variant of variants) {
    const group = subscribersToSend.filter((s) => (variantBySub.get(s.id) ?? null) === variant);
    if (!group.length) continue;

    const subjectForGroup = variant === 'b' ? send.subject_b : send.subject;

    // SendGrid caps personalizations at 1000 per request. Chunk for safety.
    const chunks = [];
    for (let i = 0; i < group.length; i += 500) chunks.push(group.slice(i, i + 500));

    for (const chunk of chunks) {
      let chunkToSend = chunk;
      let claimedDeliveryIds = [];
      let attemptTokenBySub = new Map();
      let claimedBySub = new Map();
      if (opts.existingDeliveriesOnly) {
        const claimedRows = await claimRetryableDeliveriesForResume(send.id, chunk.map((s) => s.id));
        claimedBySub = new Map(claimedRows.map((d) => [d.subscriber_id, d]));
        chunkToSend = chunk.filter((s) => claimedBySub.has(s.id));
        claimedDeliveryIds = chunkToSend.map((s) => claimedBySub.get(s.id)?.id).filter(Boolean);
        attemptTokenBySub = new Map(chunkToSend.map((s) => [s.id, claimedBySub.get(s.id)?.send_attempt_token]).filter(([, token]) => token));
        if (!chunkToSend.length) continue;
      }

      // Eligibility can change between recipient selection and dispatch
      // (customer archived with no live twin, unsubscribe). Re-run the SAME
      // selection predicate (status='active' + global suppression + excludeArchivedCustomers) for
      // this chunk immediately before the SendGrid call — one query per
      // chunk — and terminally skip anyone no longer eligible: the delivery
      // row becomes 'skipped' (not in RETRYABLE_DELIVERY_STATUSES, so resume
      // never re-queues it) and recipient_count reflects the kept set.
      // customer_id comes back too, not just id: an archive transaction may
      // have RELINKED a subscriber to its live twin between selection and now
      // (relinkSubscribersFromArchivedCustomer). Such a recipient stays
      // eligible — but the row we selected still carries the OLD (archived)
      // customer_id, which would personalize the email and file the customer
      // touchpoint against the archived profile.
      const freshCustomerBySub = new Map((await excludeMailboxNotMailable(excludeArchivedCustomers(excludeGloballySuppressed(
        db('newsletter_subscribers').where({ status: 'active' }).whereIn('id', chunkToSend.map((s) => s.id)),
      ))).select('id', 'customer_id')).map((r) => [r.id, r.customer_id ?? null]));
      const stillEligible = freshCustomerBySub;
      const ineligible = chunkToSend.filter((s) => !stillEligible.has(s.id));
      if (ineligible.length) {
        const skippedNow = await skipIneligibleDeliveries(send.id, opts.existingDeliveriesOnly
          ? { deliveryIds: ineligible.map((s) => claimedBySub.get(s.id)?.id).filter(Boolean), claimed: true }
          : { subscriberIds: ineligible.map((s) => s.id) });
        // Two different questions, two different numbers. PAYLOAD: every
        // ineligible recipient leaves the chunk below, unconditionally —
        // eligibility failed, so we do not mail them. COUNTERS: only the rows
        // this write actually transitioned, so a row a webhook already
        // terminalized is not counted as skipped here as well.
        skippedIneligible += skippedNow;
        skippedAtDispatch += skippedNow;
        logger.info(`[newsletter] send ${send.id} skipped ${skippedNow}/${ineligible.length} recipient(s) no longer eligible at dispatch (archived customer / not active)`);
        chunkToSend = chunkToSend.filter((s) => stillEligible.has(s.id));
        claimedDeliveryIds = chunkToSend.map((s) => claimedBySub.get(s.id)?.id).filter(Boolean);
        if (!chunkToSend.length) continue;
      }

      // Adopt the re-check's customer_id for the kept recipients, and top up
      // the personalization map for the ids that actually changed — through
      // loadPersonalizationContext, the one loader, not a second query shape.
      // Copies rather than mutations so the selection snapshot stays intact.
      const relinkedSubs = chunkToSend.filter((s) => (freshCustomerBySub.get(s.id) ?? null) !== (s.customer_id ?? null));
      if (relinkedSubs.length) {
        chunkToSend = chunkToSend.map((s) => (relinkedSubs.includes(s)
          ? { ...s, customer_id: freshCustomerBySub.get(s.id) ?? null }
          : s));
        const needContext = chunkToSend.filter((s) => s.customer_id && !personalizationByCustomer.has(s.customer_id));
        if (needContext.length) {
          for (const [customerId, ctx] of await loadPersonalizationContext(needContext)) {
            personalizationByCustomer.set(customerId, ctx);
          }
        }
        logger.info(`[newsletter] send ${send.id} refreshed ${relinkedSubs.length} recipient link(s) relinked between selection and dispatch (archive relink)`);
      }

      const recipients = chunkToSend.map((s) => {
        const attemptToken = attemptTokenBySub.get(s.id);
        const pctx = s.customer_id ? personalizationByCustomer.get(s.customer_id) : null;
        return {
          email: s.email,
          unsubscribeUrl: sendgrid.unsubscribeUrl(s.unsubscribe_token),
          // Greeting personalization: the assembler put {{greeting-name}}
          // in the body; this resolves it to ", FirstName" (or "" when the
          // subscriber row has no first name). {{city}} / {{grass-type}}
          // resolve from the linked customer (grass defaults to St. Augustine
          // when no lawn source). Applies to both the HTML and plain-text
          // parts via SendGrid substitutions.
          substitutions: {
            [GREETING_NAME_TOKEN]: greetingNameValueFor(s.first_name),
            [CITY_TOKEN]: pctx?.city || DEFAULT_CITY_LABEL,
            [GRASS_TYPE_TOKEN]: pctx?.grassLabel || DEFAULT_GRASS_LABEL,
            // Per-recipient quiz block(s) — answer links carry this recipient's
            // engagement_token so a click tags the right subscriber. Resolves
            // every quiz token in the body (default or {{quiz:id}}). Missing
            // token (shouldn't happen post-migration) → neutral link-free render.
            ...(quizEnabled ? buildQuizSubstitutions(quizBody, { token: deliveryBySub.get(s.id)?.engagement_token }) : {}),
            ...(feedbackEnabled ? buildFeedbackSubstitutions(quizBody, { token: deliveryBySub.get(s.id)?.engagement_token }) : {}),
            ...(evclickEnabled ? buildEvclickSubstitutions(quizBody, { token: deliveryBySub.get(s.id)?.engagement_token, urlById: evclickUrlById }) : {}),
          },
          // delivery_id rides on every SendGrid event webhook for this
          // recipient, so the handler can resolve back to the right row
          // even when the X-Message-Id from this batch was never observed
          // (lost-response case). send_id is included so the handler can
          // shortcut to the right table without a join.
          customArgs: {
            delivery_id: String(deliveryBySub.get(s.id)?.id || ''),
            send_id: String(send.id),
            ...(attemptToken ? { send_attempt_token: String(attemptToken) } : {}),
          },
        };
      });
      const subscriberIds = chunkToSend.map((s) => s.id);

      // Ownership check + lease renewal BEFORE the external call: 0 rows
      // means recovery rotated sending_claim_token while we were stalled —
      // stop WITHOUT mailing this chunk. A successful renewal also resets
      // the stale lease, so recovery cannot legally reclaim while the
      // following SendGrid request is in flight (a reclaim requires a full
      // lease window of silence).
      const heartbeat = await db('newsletter_sends')
        .where({ id: send.id, status: 'sending', sending_claim_token: claimToken })
        .update({ updated_at: new Date() });
      if (!heartbeat) {
        claimLost = true;
        logger.error(`[newsletter] send ${send.id} claim lost (stale reclaim by another worker) — stopping before mailing this chunk; ${accepted} accepted so far; new owner resumes the rest`);
        break;
      }

      try {
        // sendBroadcast = sendBatch with the SENDGRID_ASM_GROUP_NEWSLETTER
        // group attached by default. Newsletter unsubs land in the
        // newsletter group only — service emails (invoices, reminders)
        // keep flowing.
        const result = await sendgrid.sendBroadcast({
          recipients,
          fromEmail: send.from_email,
          fromName: send.from_name,
          subject: subjectForGroup,
          html: htmlWithFooter,
          text: ensureLegalTextFooter(bodyText, { unsubscribeUrl: '{{unsubscribe_url}}' }) || undefined,
          replyTo: send.reply_to,
          categories: ['newsletter', `send_${send.id}`, variant ? `variant_${variant}` : 'variant_none'],
        });

        // Single bulk UPDATE per chunk instead of N per-row updates. Knex
        // returns the affected row count so the SendGrid-accepted tally
        // stays accurate. True delivery is counted only from provider
        // webhooks after mailbox acceptance.
        const deliveryUpdateQuery = db('newsletter_send_deliveries').where({ send_id: send.id });
        if (opts.existingDeliveriesOnly) {
          deliveryUpdateQuery.where({ status: 'sending' }).whereIn('id', claimedDeliveryIds);
        } else {
          deliveryUpdateQuery.whereIn('subscriber_id', subscriberIds);
        }
        const updated = await (opts.existingDeliveriesOnly
          ? applyDeliveryNoSuccessFilter(deliveryUpdateQuery)
          : applyRetryableDeliveryFilter(deliveryUpdateQuery))
        .update({
          status: 'sent',
          provider_message_id: result.messageId,
          send_attempt_token: null,
          sent_at: new Date(),
          updated_at: new Date(),
        });
        accepted += updated;

        // Customer touchpoints in parallel — one per linked customer in
        // the chunk. Promise.allSettled so a single touchpoint failure
        // doesn't fail the campaign (touchpoints are best-effort comms
        // history; SendGrid already accepted the actual mail).
        const customerSubs = chunkToSend.filter((s) => s.customer_id);
        if (customerSubs.length) {
          const tpResults = await Promise.allSettled(customerSubs.map((s) =>
            recordTouchpoint({
              customerId: s.customer_id,
              channel: 'newsletter',
              direction: 'outbound',
              authorType: 'admin',
              adminUserId: send.created_by,
              contactEmail: s.email,
              subject: subjectForGroup,
              body: touchpointBody,
              metadata: {
                send_id: send.id,
                sendgrid_message_id: result.messageId,
                campaign_subject: subjectForGroup,
                ab_variant: variant,
              },
            })));
          const tpFailed = tpResults.filter((r) => r.status === 'rejected').length;
          if (tpFailed) {
            logger.warn(`[newsletter] ${tpFailed}/${customerSubs.length} touchpoint records failed for send ${send.id} (chunk size ${chunk.length})`);
          }
        }
      } catch (err) {
        logger.error(`[newsletter] batch failed for send ${send.id} variant=${variant}: ${err.message}`);
        const failureQuery = db('newsletter_send_deliveries').where({ send_id: send.id });
        if (opts.existingDeliveriesOnly) {
          failureQuery.where({ status: 'sending' }).whereIn('id', claimedDeliveryIds);
        } else {
          failureQuery.whereIn('subscriber_id', subscriberIds);
        }
        const updated = await (opts.existingDeliveriesOnly
          ? applyDeliveryNoSuccessFilter(failureQuery)
          : applyRetryableDeliveryFilter(failureQuery))
        .update({ status: 'failed', bounce_reason: err.message.slice(0, 500), updated_at: new Date() });
        failed += updated;
      }

    }
    if (claimLost) break;
  }

  // A worker that lost its claim must not finalize, advance the calendar,
  // mark events featured, or fire the social share — the reclaiming owner
  // runs that lifecycle. Deliveries already updated stay updated (the new
  // owner's retryable filter skips them).
  recipientCount -= skippedIneligible;
  if (claimLost) {
    return { recipients: recipientCount, accepted, failed, skipped_already_sent: skippedAlreadySent, skipped_ineligible: skippedIneligible, lostClaim: true };
  }

  // Final state. If every recipient bounced into 'failed', the whole send
  // is 'failed' (operator can resume after fixing the cause). Otherwise we
  // call it 'sent' — partial failures live on as 'failed' deliveries that
  // resumeCampaign() can re-send without double-emailing the successes.
  const retryableRemaining = await applyRetryableDeliveryFilter(
    db('newsletter_send_deliveries').where({ send_id: send.id }),
  )
    .count('* as c')
    .first();
  const attemptedCount = subscribersToSend.length - skippedAtDispatch;
  const allFailed = Number(retryableRemaining?.c || 0) > 0
    && failed === attemptedCount
    && attemptedCount > 0
    && successfulDeliveryCount === 0;
  const finalSendUpdate = {
    status: allFailed ? 'failed' : 'sent',
    recipient_count: recipientCount,
    updated_at: new Date(),
  };
  if (!opts.preserveSentAt || !send.sent_at) {
    finalSendUpdate.sent_at = new Date();
  }
  // Only the worker that still owns the parent 'sending' claim may finalize.
  // A late completion must not overwrite a newer recovery lifecycle — and a
  // zero-row result means exactly that: the claim rotated after our last
  // batch. The loser must also skip ALL first-send side effects (calendar
  // advance, markEventsFeatured, social share) or both workers would run
  // them and double-count featured events.
  const finalized = await db('newsletter_sends')
    .where({ id: send.id, status: 'sending', sending_claim_token: claimToken })
    .update(finalSendUpdate);
  if (!finalized) {
    logger.error(`[newsletter] send ${send.id} claim lost at finalization — skipping lifecycle side effects; the reclaiming owner finalizes`);
    return { recipients: recipientCount, accepted, failed, skipped_already_sent: skippedAlreadySent, skipped_ineligible: skippedIneligible, lostClaim: true };
  }

  if (finalSendUpdate.status === 'sent' && recipientCount > 0) {
    // Advance the calendar lifecycle (idempotent) so a sent newsletter's
    // calendar row reflects reality instead of being stuck at 'drafted'.
    try {
      await db('newsletter_calendar').where({ send_id: send.id }).update({ status: 'sent', updated_at: new Date() });
    } catch (err) {
      logger.warn(`[newsletter] calendar status update failed for send ${send.id}: ${err.message}`);
    }

    // First-'sent' only: advance events_raw.times_featured + recompute
    // freshness for the events this newsletter actually shipped, so the
    // recurring-series anti-repeat gate decays. Gated on !send.sent_at (a
    // resume carries preserveSentAt + an existing sent_at) so resumes don't
    // double-count. Trade-off: a send that FAILED first then succeeded on
    // resume won't feature — acceptable (under-count beats double-count).
    if (!send.sent_at) {
      try {
        await markEventsFeatured(send);
      } catch (err) {
        logger.warn(`[newsletter] times_featured update failed for send ${send.id}: ${err.message}`);
      }
    }

    const { sharePublishedNewsletter } = require('./content-scheduler');
    db('newsletter_sends').where({ id: send.id }).first().then((freshSend) => {
      if (freshSend) {
        sharePublishedNewsletter(freshSend).catch((err) => {
          logger.warn(`[newsletter] social share failed for send ${send.id}: ${err.message}`);
        });
      }
    }).catch(() => {});
  }

  return { recipients: recipientCount, accepted, failed, skipped_already_sent: skippedAlreadySent, skipped_ineligible: skippedIneligible };
}

/**
 * Operator-triggered re-send of a campaign that previously failed or only
 * partially completed. Preclaims the row as 'sending' before handing it to
 * sendCampaign, then inherits sendCampaign's per-recipient idempotency filter:
 * only queued/failed/abandoned-sending rows with no success or engagement
 * timestamps get a fresh attempt.
 *
 * Refuses to resume rows that are still in 'sending' state (an active
 * sendCampaign call holds the work) or already 'sent' status with no
 * outstanding non-success deliveries.
 *
 * Returns { recipients, accepted, failed, skipped_already_sent }.
 */
async function prepareResumeCampaign(sendId) {
  if (!sendgrid.isConfigured()) throw new Error('SendGrid not configured (SENDGRID_API_KEY missing)');

  const send = await db('newsletter_sends').where({ id: sendId }).first();
  if (!send) throw new Error('not found');
  if (!send.html_body && !send.text_body) throw new Error('body required');
  if (send.status === 'draft' || send.status === 'scheduled') {
    const err = new Error('use sendCampaign, not resumeCampaign, for draft/scheduled sends');
    err.code = 'NOT_RESUMABLE';
    throw err;
  }
  const reclaimingStaleSend = send.status === 'sending' && sendingClaimIsStale(send);
  if (send.status === 'sending' && !reclaimingStaleSend) {
    // An active sendCampaign owns the work. A crash/deploy claim ages out
    // after a bounded lease, giving the operator recovery without prod SQL.
    const err = new Error('campaign is actively sending; refusing to resume');
    err.code = 'STILL_SENDING';
    throw err;
  }
  // A resume mails the rest of the list from what is stored NOW. A campaign
  // persisted before a stricter claim scan shipped, or one edited after its
  // first attempt failed, must pass the same validation the manual and
  // scheduled paths run — before anything is claimed (codex round 8 P1).
  // Read before validation: whether anyone has received this campaign decides
  // what an invalid copy may do to its state (below).
  const deliveryTotal = await db('newsletter_send_deliveries')
    .where({ send_id: send.id })
    .count('* as c')
    .first();
  const totalDeliveries = Number(deliveryTotal?.c || 0);
  const leaseCutoff = new Date(Date.now() - sendingLeaseMinutes() * 60 * 1000);

  const { requiresClaimValidation, FLAGSHIP_TYPE_KEY } = require('../config/newsletter-types');
  // A promoted legacy flagship has newsletter_type NULL; the manual and
  // scheduled paths classify it by its calendar link and validate it as the
  // flagship type — so does the resume path (codex round 12 P1): its
  // outstanding recipients must never receive stored copy the current scan
  // rejects.
  const typedSend = requiresClaimValidation(send.newsletter_type)
    ? send
    : ((send.newsletter_type === null && await isFlagshipSend(send)) ? { ...send, newsletter_type: FLAGSHIP_TYPE_KEY } : null);
  if (typedSend) {
    const { validateNewsletterDraft, lockedPricesForSend } = require('../services/newsletter-validator');
    const lockedPrices = await lockedPricesForSend(typedSend, db);
    const { errors } = validateNewsletterDraft(typedSend, { recipientCount: 1, lockedPrices });
    if (errors.length > 0) {
      // Nothing is claimed, and the campaign KEEPS its delivered state: a
      // 'failed' or 'sent' row stays publicly readable (newsletter-feed.js
      // serves sending/sent/failed — the web version the first batch
      // received stays up) and is corrected in place through PATCH's
      // correct-and-resume path; the next Resume re-validates the corrected
      // copy and, through sendCampaign's ledger guard (codex round 11),
      // reaches only the recipients still outstanding (codex round 12 P2 —
      // a return to 'draft' made that link a 404). A live 'sending' owner
      // was refused above; a STALE one moves to 'failed' with its claim
      // token revoked — readable and editable, and a stuck original worker
      // learns through its heartbeat ownership check that it no longer owns
      // the campaign — as a compare-and-set on the inspected state and lease
      // (pre-push audit P1).
      let outcome = 'correct the copy and resume again';
      if (totalDeliveries === 0 && (send.status === 'failed' || reclaimingStaleSend)) {
        // Nobody received a zero-ledger campaign (the first attempt failed
        // before any delivery row was seeded), so there is no web version
        // to keep and no ledger to resume: it goes back to an editable draft
        // with its approval cleared (codex round 13 P2) — compare-and-set on
        // the inspected state and lease, like every other transition here.
        const reset = db('newsletter_sends').where({ id: send.id, status: send.status });
        if (reclaimingStaleSend) reset.where('updated_at', '<=', leaseCutoff);
        const returned = (await reset.update({
          status: 'draft', scheduled_for: null, proof_token: null, proof_sent_at: null, proof_approved_at: null,
          sending_claim_token: null, updated_at: new Date(),
        })) > 0;
        outcome = returned ? 'returned to draft for editing (nobody received it)' : 'it changed state meanwhile and was left as is';
      } else if (reclaimingStaleSend) {
        const released = (await db('newsletter_sends')
          .where({ id: send.id, status: 'sending' })
          .where('updated_at', '<=', leaseCutoff)
          .update({ status: 'failed', sending_claim_token: null, updated_at: new Date() })) > 0;
        if (released) outcome = 'its stale send claim was released; correct the copy and resume again';
      }
      const err = new Error(`campaign no longer passes validation; ${outcome}: ${errors.join('; ')}`);
      err.code = 'VALIDATION_FAILED';
      err.errors = errors;
      throw err;
    }
  }

  // Are there outstanding non-success deliveries to resume? If delivery
  // rows exist and all of them are already terminal-success, bail early so
  // the operator knows. If no rows exist yet, the first attempt failed
  // before pre-seeding and sendCampaign should reseed from subscribers.
  if (totalDeliveries === 0 && send.status !== 'failed' && !reclaimingStaleSend) {
    const err = new Error('no outstanding deliveries to resume');
    err.code = 'NOTHING_TO_RESUME';
    throw err;
  }
  if (totalDeliveries > 0) {
    // Repair stale archived links first, as every audience read does: a
    // retryable row whose subscriber still points at an archived profile
    // with a live same-email twin is outstanding once relinked, and must not
    // be counted out (and terminalized below) before sendCampaign's own
    // sweep would have relinked it (codex round 18 P2).
    await NewsletterSubscribers.relinkArchivedLinkedSubscribers(db);
    // Mirror the retry refetch's suppression + archived-customer exclusions so
    // the "anything left to resume?" count matches what sendCampaign will
    // actually send — otherwise a campaign whose only outstanding rows are
    // suppressed/archived would falsely report work remaining (and repeatedly
    // claim a resume that then selects nobody).
    const outstanding = await outstandingEligibleDeliveries(send.id)
      .count('* as c')
      .first();
    if (Number(outstanding?.c || 0) === 0) {
      // Nothing is eligible — but the retryable rows are still sitting in the
      // ledger as queued/failed. Left alone, a later restore/unsuppress makes
      // those recipients eligible again and the NEXT resume would mail them
      // this stale campaign. Terminalize them here, through the same skip
      // write the sender's sweeps use, before reporting nothing to resume.
      const swept = await skipIneligibleDeliveries(send.id, { allRetryable: true });
      if (swept) {
        logger.info(`[newsletter] resume ${send.id}: no eligible recipients — terminalized ${swept} retryable ledger row(s) as skipped`);
      }
      // A STALE 'sending' parent must NOT be abandoned here: throwing before
      // the atomic reclaim below would leave it stuck in 'sending' with a
      // stale claim forever (recovery is exactly what this call is). Fall
      // through instead — the reclaim happens, sendCampaign processes a
      // zero-eligible ledger, and its ONE guarded final update lands the
      // terminal status + recipient_count. For any other status the parent is
      // already terminal and holds no claim, so the early report stands and
      // the send row is left untouched.
      if (!reclaimingStaleSend) {
        const err = new Error('no outstanding deliveries to resume');
        err.code = 'NOTHING_TO_RESUME';
        throw err;
      }
      logger.info(`[newsletter] resume ${send.id}: stale 'sending' claim with no eligible recipients — reclaiming to finalize the parent`);
    }
  }

  // Claim directly as 'sending' only if the row is still in the state we
  // inspected above. This avoids a generic 'scheduled' window where the normal
  // /send path or scheduler could claim the send without resume constraints.
  const claimQuery = db('newsletter_sends')
    .where({ id: send.id, status: send.status });
  if (reclaimingStaleSend) {
    claimQuery.where('updated_at', '<=', leaseCutoff);
  }
  // The claim is bound to the exact row version this function validated
  // (codex round 13 P1): a correction saved between the validation above
  // and this claim leaves the claim empty, so the corrected, not yet
  // validated copy is never mailed to the outstanding recipients — the
  // operator resumes again and the new copy is validated first. The same
  // bound the manual and scheduled dispatch paths carry.
  if (send.updated_at) claimQuery.where('updated_at', '<', noLaterThan(send.updated_at));
  // A fresh owner token every (re)claim: a stale-reclaim rotates the token,
  // which is exactly what tells the stuck original worker (via its next
  // heartbeat ownership check) that it no longer owns the campaign.
  const claimToken = crypto.randomUUID();
  const claimed = await claimQuery
    .update({ status: 'sending', scheduled_for: null, sending_claim_token: claimToken, updated_at: new Date() })
    .returning('id');
  if (!claimed.length) {
    // Edited (the row still holds the status we inspected) vs claimed by
    // another worker (it moved on) — a lost claim is never reported as an
    // edit or the other way round.
    let current = null;
    try { current = await db('newsletter_sends').where({ id: send.id }).first('status'); } catch (readErr) {
      logger.warn(`[newsletter] resume claim re-read for ${send.id} failed: ${readErr.message}`);
    }
    const edited = current?.status === send.status;
    const err = new Error(edited
      ? 'campaign changed after it was validated; resume again to validate the new copy'
      : 'campaign was claimed by another worker');
    err.code = edited ? 'VERSION_CHANGED' : 'ALREADY_CLAIMED';
    throw err;
  }

  return { sendId: send.id, existingDeliveriesOnly: totalDeliveries > 0, preclaimed: true, claimToken };
}

async function resumeCampaign(sendId) {
  const prepared = await prepareResumeCampaign(sendId);
  return sendCampaign(prepared.sendId, {
    force: true,
    preserveSentAt: true,
    existingDeliveriesOnly: prepared.existingDeliveriesOnly,
    preclaimed: prepared.preclaimed,
    claimToken: prepared.claimToken,
  });
}

/**
 * Process scheduled sends whose scheduled_for has passed. Called from the
 * global scheduler every minute. Processes sequentially so one slow send
 * can't stampede the others.
 */
async function processScheduledSends() {
  const { requiresClaimValidation, FLAGSHIP_TYPE_KEY } = require('../config/newsletter-types');
  const { validateNewsletterDraft, lockedPricesForSend } = require('../services/newsletter-validator');

  const due = await db('newsletter_sends')
    .where({ status: 'scheduled' })
    .where('scheduled_for', '<=', new Date())
    .orderBy('scheduled_for', 'asc')
    .limit(20);

  if (!due.length) return { processed: 0 };

  logger.info(`[newsletter-scheduler] ${due.length} scheduled send(s) due`);
  let processed = 0;
  for (const row of due) {
    try {
      // Proof-approved rows remain governed by the proof kill switch even
      // after approval. A manual future schedule has no proof_approved_at and
      // is unaffected; an approved autopilot send stays queued until the gate
      // is deliberately re-enabled.
      if (row.proof_approved_at && process.env.GATE_NEWSLETTER_PROOF_APPROVAL !== 'true') {
        logger.warn(`[newsletter-scheduler] send ${row.id} is proof-approved but the proof gate is off — leaving it scheduled`);
        continue;
      }
      // Same rule for the type-specific switch: a proof-approved Pest
      // Insider issue stays queued while GATE_PEST_INSIDER_PROOF is off. A
      // Pest Insider issue scheduled by hand has no proof_approved_at and is
      // unaffected.
      if (row.proof_approved_at && row.newsletter_type === 'pest-insider-monthly' && !pestInsiderProofLive()) {
        logger.warn(`[newsletter-scheduler] send ${row.id} is a proof-approved Pest Insider issue but GATE_PEST_INSIDER_PROOF is off — leaving it scheduled`);
        continue;
      }
      const eventSelection = await validateFlagshipEventSelection(row);
      if (eventSelection.flagship) {
        const now = new Date();
        const currentTarget = isCurrentFlagshipTarget(row.scheduled_for, now);
        // Live recheck failures take the SAME revert-to-editable-draft
        // exit as an invalid lineup: a generic 'failed' send can't be
        // edited (PATCH accepts draft/scheduled only) and Resume just
        // repeats the recheck — the week would strand with no way to
        // apply the suggested alternate.
        let recheckReason = null;
        if (eventSelection.valid && currentTarget && isFlagshipDeliveryWindow(now)) {
          const recheck = await reverifyEvents(eventSelection.events);
          if (!recheck.ok) {
            recheckReason = `live page recheck failed: ${recheck.failures.map((f) => `${f.title} — ${f.reason}`).join('; ')}`;
          }
        }
        if (!eventSelection.valid || !currentTarget || !isFlagshipDeliveryWindow(now) || recheckReason) {
          const reason = !eventSelection.valid
            ? eventSelection.errors.join(', ')
            : !currentTarget
              ? 'scheduled_for is not the current issue Tuesday at 6:00 AM ET'
              : (recheckReason || 'missed the Tuesday 6:00–6:14 AM ET delivery window');
          logger.error(`[newsletter-scheduler] flagship send ${row.id} blocked: ${reason}`);
          // Reverting an approved schedule INVALIDATES the approval: the
          // state the owner signed off (lineup, target Tuesday) no longer
          // holds. Clear the proof fields or the now-draft row would carry
          // stale approval metadata forever — the PATCH invalidation only
          // covers status='scheduled', so a draft must never hold one.
          const reverted = await db('newsletter_sends').where({ id: row.id, status: 'scheduled' }).update({
            status: 'draft',
            scheduled_for: null,
            proof_token: null,
            proof_sent_at: null,
            proof_approved_at: null,
            updated_at: new Date(),
          });
          if (reverted) {
            await db('newsletter_calendar').where({ send_id: row.id }).update({ status: 'drafted', updated_at: new Date() });
          }
          continue;
        }
      }
      // Validate AI-generated sends (flagship + Pest Insider) before
      // dispatching. Promoted legacy rows (newsletter_type NULL, flagship
      // via the calendar link) MUST validate too — keying off the raw type
      // alone let them ship customer-facing AI copy without the
      // hallucinated-claim hard block.
      if (requiresClaimValidation(row.newsletter_type) || eventSelection.flagship) {
        const typedRow = requiresClaimValidation(row.newsletter_type)
          ? row
          : { ...row, newsletter_type: FLAGSHIP_TYPE_KEY };
        const recipientCount = await countSegmentRecipients(row.segment_filter);
        const lockedPrices = await lockedPricesForSend(typedRow, db);
        const { errors } = validateNewsletterDraft(typedRow, { recipientCount, lockedPrices });
        if (errors.length > 0) {
          logger.error(`[newsletter-scheduler] send ${row.id} blocked by validation: ${errors.join(', ')}`);
          // Same approval invalidation as the flagship revert above.
          const reverted = await db('newsletter_sends').where({ id: row.id, status: 'scheduled' }).update({
            status: 'draft',
            scheduled_for: null,
            proof_token: null,
            proof_sent_at: null,
            proof_approved_at: null,
            updated_at: new Date(),
          });
          if (!reverted) continue;
          // Keep the calendar in lockstep: this send is no longer scheduled, so
          // roll its linked calendar row back to 'drafted'. Without this the
          // row would stay 'scheduled' forever (autopilot then skips the week)
          // and /cancel-schedule can't repair it — the send is already draft.
          await db('newsletter_calendar').where({ send_id: row.id }).update({ status: 'drafted', updated_at: new Date() });
          continue;
        }
      }
      // The claim is bound to the version this tick read and validated: an
      // edit (or re-approval) landing in between leaves the claim empty and
      // the row is picked up again, re-validated, on a later tick.
      await sendCampaign(row.id, {
        expect: { status: 'scheduled', updatedAt: row.updated_at, proofApprovedAt: row.proof_approved_at },
      });
      processed++;
    } catch (err) {
      // ALREADY_CLAIMED = another tick / manual send picked up this row
      // first. The other worker is actively sending — do NOT flip status
      // to failed or we'd overwrite an in-flight campaign.
      if (err.code === 'ALREADY_CLAIMED') {
        logger.info(`[newsletter-scheduler] send ${row.id} already claimed by another worker — skipping`);
        continue;
      }
      if (err.code === 'VERSION_CHANGED') {
        logger.info(`[newsletter-scheduler] send ${row.id} changed after this tick validated it — not dispatching this version`);
        continue;
      }
      if (err.code === 'EVENT_REVERIFY_FAILED' || err.code === 'EVENT_SELECTION_INVALID') {
        // sendCampaign's own pre-claim gates re-run the lineup checks and
        // can newly fail even though the tick's gate just passed (the
        // recheck fetches live pages). A generic 'failed' flip would
        // strand the week uneditable — take the same
        // revert-to-editable-draft exit as the tick's gate.
        logger.error(`[newsletter-scheduler] send ${row.id} blocked at dispatch: ${err.message}`);
        try {
          const reverted = await db('newsletter_sends').where({ id: row.id, status: 'scheduled' }).update({
            status: 'draft',
            scheduled_for: null,
            proof_token: null,
            proof_sent_at: null,
            proof_approved_at: null,
            updated_at: new Date(),
          });
          if (reverted) {
            await db('newsletter_calendar').where({ send_id: row.id }).update({ status: 'drafted', updated_at: new Date() });
          }
        } catch { /* swallow */ }
        continue;
      }
      logger.error(`[newsletter-scheduler] send ${row.id} failed: ${err.message}`);
      try {
        const flipped = await db('newsletter_sends').where({ id: row.id, status: 'sending' }).update({ status: 'failed' });
        if (!flipped) {
          // Pre-claim throw (e.g. SendGrid unconfigured): the row never
          // reached 'sending' and would otherwise stay 'scheduled' — due
          // forever, retried every tick, invisible as a failure. Same
          // status-guarded flip as the route's fire-and-forget catch.
          await db('newsletter_sends')
            .where({ id: row.id, status: 'scheduled' })
            .update({ status: 'failed', updated_at: new Date() });
        }
      } catch { /* swallow */ }
    }
  }
  return { processed };
}

/**
 * Advance events_raw.times_featured + last_featured_at and recompute freshness
 * for every event a sent newsletter shipped (the locked send.event_ids). This
 * preserves the feature-history signal used by editorial novelty scoring.
 */
async function markEventsFeatured(send) {
  let ids = [];
  try {
    ids = Array.isArray(send.event_ids) ? send.event_ids : JSON.parse(send.event_ids || '[]');
  } catch { ids = []; }
  if (!Array.isArray(ids) || ids.length === 0) return;

  const { classifyFreshness } = require('./event-freshness');
  let occurrences = send.event_occurrences || {};
  if (typeof occurrences === 'string') { try { occurrences = JSON.parse(occurrences); } catch { occurrences = {}; } }

  // Lock + read + write each event row inside a transaction (SELECT ... FOR
  // UPDATE) so two sends that ship the same event can't both read the same
  // times_featured and write back the same value — which would lose an
  // increment and decay the recurring-series gate too slowly. The row lock
  // serializes them and keeps the recomputed freshness consistent with the
  // final count. One row per transaction (≤12 events per send).
  for (const id of ids) {
    await db.transaction(async (trx) => {
      const row = await trx('events_raw').where({ id }).forUpdate()
        .first('id', 'title', 'description', 'event_type', 'recurrence_type', 'times_featured', 'start_at', 'end_at');
      if (!row) return;
      const nextFeatured = (row.times_featured || 0) + 1;
      const { freshness_status, freshness_score } = classifyFreshness({ ...row, times_featured: nextFeatured });
      await trx('events_raw').where({ id }).update({
        times_featured: nextFeatured,
        last_featured_at: new Date(),
        // The occurrence that shipped, so the calendar-year rule compares its
        // own year (the send time can fall in the prior December). Prefer the
        // occurrence locked into the draft: a feed may have advanced this row
        // in place since the email was rendered.
        last_featured_occurrence_at: occurrences[String(id)] || row.start_at || null,
        // The editorial star is consumed by shipping: drop featured back to
        // approved so the eligibility override can't re-admit the same
        // event in the next issue.
        admin_status: db.raw(`CASE WHEN admin_status = 'featured' THEN 'approved' ELSE admin_status END`),
        freshness_status,
        freshness_score,
        updated_at: new Date(),
      });
    });
  }
}

module.exports = {
  applyRetryableDeliveryFilter,
  outstandingEligibleDeliveries,
  hasOutstandingDeliveries, sendCampaign, prepareResumeCampaign, resumeCampaign, processScheduledSends, buildSubscriberQuery, resolveSegmentCustomerIds, countSegmentRecipients, narrowServiceLineFilter, loadPersonalizationContext, sanitizePersonalizationToken, excludeGloballySuppressed, excludeArchivedCustomers, excludeMailboxNotMailable, SKIPPED_DELIVERY_STATUS, markEventsFeatured, sendingClaimIsStale };

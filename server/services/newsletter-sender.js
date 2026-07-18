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
const sendgrid = require('./sendgrid-mail');
const logger = require('./logger');
const crypto = require('crypto');
const { wrapNewsletter, ensureLegalTextFooter } = require('./email-template');
const { recordTouchpoint } = require('./conversations');
const { GREETING_NAME_TOKEN, greetingNameValueFor, stripPersonalizationTokens, CITY_TOKEN, GRASS_TYPE_TOKEN, DEFAULT_CITY_LABEL, DEFAULT_GRASS_LABEL, decodeEscapedEntities } = require('./newsletter-draft');
const { selectAudience, SELLABLE_LINES } = require('./newsletter-audience-profiles');
const { grassTypeLabel, normalizeGrassType } = require('./lawn-grass-context');
const { hasQuizToken, buildQuizSubstitutions } = require('./newsletter-quiz');
const { hasFeedbackToken, ensureFeedbackToken, buildFeedbackSubstitutions } = require('./newsletter-feedback');
const { isFlagshipDeliveryWindow, isCurrentFlagshipTarget } = require('./event-freshness');
const { validateFlagshipEventSelection } = require('./newsletter-event-selection');

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
 * @param {object|null} segmentFilter
 * @param {string[]|null} [customerIds] pre-resolved set from
 *   resolveSegmentCustomerIds(); null = no service-line constraint.
 */
function buildSubscriberQuery(segmentFilter, customerIds = null) {
  let q = excludeGloballySuppressed(db('newsletter_subscribers').where({ status: 'active' }));

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
  if (!(opts.preclaimed && opts.existingDeliveriesOnly)) {
    const eventSelection = await validateFlagshipEventSelection(send);
    if (eventSelection.flagship) {
      if (!eventSelection.valid) {
        const err = new Error(`flagship event selection is no longer eligible: ${eventSelection.errors.join(' ')}`);
        err.code = 'EVENT_SELECTION_INVALID';
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

  // 0-recipient guard — runs BEFORE the atomic claim so a no-op send
  // doesn't burn the row's status from draft/scheduled to sending only
  // to immediately land as 'sent' with recipient_count=0.
  if (!opts.force) {
    const c = await buildSubscriberQuery(send.segment_filter, await resolveSegmentCustomerIds(send.segment_filter)).count('* as c').first();
    if (Number(c?.c || 0) === 0) {
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
  // owner into duplicate emails.
  const claimToken = opts.claimToken || crypto.randomUUID();

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
    const claimed = await db('newsletter_sends')
      .where({ id: send.id })
      .whereIn('status', ['draft', 'scheduled'])
      .update({ status: 'sending', sending_claim_token: claimToken, updated_at: new Date() })
      .returning('id');
    if (!claimed.length) {
      const err = new Error('already sent or in progress');
      err.code = 'ALREADY_CLAIMED';
      throw err;
    }
  }

  let subscribers = [];
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
      ? await excludeGloballySuppressed(
        db('newsletter_subscribers')
          .where({ status: 'active' })
          .whereIn('id', retryableSubscriberIds),
      ).select('id', 'email', 'unsubscribe_token', 'customer_id', 'first_name')
      : [];
    logger.info(`[newsletter] send ${send.id} → ${subscribers.length} active retryable recipient(s) from original delivery ledger (globally-suppressed excluded)`);
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
  const recipientCount = opts.existingDeliveriesOnly ? existingDeliveries.length : subscribers.length;
  const skippedAlreadySent = recipientCount - subscribersToSend.length;
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
      if (opts.existingDeliveriesOnly) {
        const claimedRows = await claimRetryableDeliveriesForResume(send.id, chunk.map((s) => s.id));
        const claimedBySub = new Map(claimedRows.map((d) => [d.subscriber_id, d]));
        chunkToSend = chunk.filter((s) => claimedBySub.has(s.id));
        claimedDeliveryIds = chunkToSend.map((s) => claimedBySub.get(s.id)?.id).filter(Boolean);
        attemptTokenBySub = new Map(chunkToSend.map((s) => [s.id, claimedBySub.get(s.id)?.send_attempt_token]).filter(([, token]) => token));
        if (!chunkToSend.length) continue;
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
  if (claimLost) {
    return { recipients: recipientCount, accepted, failed, skipped_already_sent: skippedAlreadySent, lostClaim: true };
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
  const allFailed = Number(retryableRemaining?.c || 0) > 0
    && failed === subscribersToSend.length
    && subscribersToSend.length > 0
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
    return { recipients: recipientCount, accepted, failed, skipped_already_sent: skippedAlreadySent, lostClaim: true };
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

  return { recipients: recipientCount, accepted, failed, skipped_already_sent: skippedAlreadySent };
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

  // Are there outstanding non-success deliveries to resume? If delivery
  // rows exist and all of them are already terminal-success, bail early so
  // the operator knows. If no rows exist yet, the first attempt failed
  // before pre-seeding and sendCampaign should reseed from subscribers.
  const deliveryTotal = await db('newsletter_send_deliveries')
    .where({ send_id: send.id })
    .count('* as c')
    .first();
  const totalDeliveries = Number(deliveryTotal?.c || 0);
  if (totalDeliveries === 0 && send.status !== 'failed' && !reclaimingStaleSend) {
    const err = new Error('no outstanding deliveries to resume');
    err.code = 'NOTHING_TO_RESUME';
    throw err;
  }
  if (totalDeliveries > 0) {
    // Mirror the retry refetch's suppression exclusion so the "anything left to
    // resume?" count matches what sendCampaign will actually send — otherwise a
    // campaign whose only outstanding rows are globally-suppressed would falsely
    // report work remaining (and previously would have re-mailed them).
    const outstanding = await excludeGloballySuppressed(applyRetryableDeliveryFilter(
      db('newsletter_send_deliveries')
        .join('newsletter_subscribers', 'newsletter_subscribers.id', 'newsletter_send_deliveries.subscriber_id')
        .where({ 'newsletter_send_deliveries.send_id': send.id, 'newsletter_subscribers.status': 'active' }),
      'newsletter_send_deliveries',
    ))
      .count('* as c')
      .first();
    if (Number(outstanding?.c || 0) === 0) {
      const err = new Error('no outstanding deliveries to resume');
      err.code = 'NOTHING_TO_RESUME';
      throw err;
    }
  }

  // Claim directly as 'sending' only if the row is still in the state we
  // inspected above. This avoids a generic 'scheduled' window where the normal
  // /send path or scheduler could claim the send without resume constraints.
  const claimQuery = db('newsletter_sends')
    .where({ id: send.id, status: send.status });
  if (reclaimingStaleSend) {
    claimQuery.where('updated_at', '<=', new Date(Date.now() - sendingLeaseMinutes() * 60 * 1000));
  }
  // A fresh owner token every (re)claim: a stale-reclaim rotates the token,
  // which is exactly what tells the stuck original worker (via its next
  // heartbeat ownership check) that it no longer owns the campaign.
  const claimToken = crypto.randomUUID();
  const claimed = await claimQuery
    .update({ status: 'sending', scheduled_for: null, sending_claim_token: claimToken, updated_at: new Date() })
    .returning('id');
  if (!claimed.length) {
    const err = new Error('campaign was claimed by another worker');
    err.code = 'ALREADY_CLAIMED';
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
  const { requiresClaimValidation } = require('../config/newsletter-types');
  const { validateNewsletterDraft } = require('../services/newsletter-validator');

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
      const eventSelection = await validateFlagshipEventSelection(row);
      if (eventSelection.flagship) {
        const now = new Date();
        const currentTarget = isCurrentFlagshipTarget(row.scheduled_for, now);
        if (!eventSelection.valid || !currentTarget || !isFlagshipDeliveryWindow(now)) {
          const reason = !eventSelection.valid
            ? eventSelection.errors.join(', ')
            : !currentTarget
              ? 'scheduled_for is not the current issue Tuesday at 6:00 AM ET'
              : 'missed the Tuesday 6:00–6:14 AM ET delivery window';
          logger.error(`[newsletter-scheduler] flagship send ${row.id} blocked: ${reason}`);
          const reverted = await db('newsletter_sends').where({ id: row.id, status: 'scheduled' }).update({
            status: 'draft',
            scheduled_for: null,
            updated_at: new Date(),
          });
          if (reverted) {
            await db('newsletter_calendar').where({ send_id: row.id }).update({ status: 'drafted', updated_at: new Date() });
          }
          continue;
        }
      }
      // Validate AI-generated sends (flagship + Pest Insider) before dispatching
      if (requiresClaimValidation(row.newsletter_type)) {
        const recipientCount = Number(
          (await buildSubscriberQuery(row.segment_filter, await resolveSegmentCustomerIds(row.segment_filter)).count('* as c').first())?.c || 0
        );
        const { errors } = validateNewsletterDraft(row, { recipientCount });
        if (errors.length > 0) {
          logger.error(`[newsletter-scheduler] send ${row.id} blocked by validation: ${errors.join(', ')}`);
          const reverted = await db('newsletter_sends').where({ id: row.id, status: 'scheduled' }).update({
            status: 'draft',
            scheduled_for: null,
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
      await sendCampaign(row.id);
      processed++;
    } catch (err) {
      // ALREADY_CLAIMED = another tick / manual send picked up this row
      // first. The other worker is actively sending — do NOT flip status
      // to failed or we'd overwrite an in-flight campaign.
      if (err.code === 'ALREADY_CLAIMED') {
        logger.info(`[newsletter-scheduler] send ${row.id} already claimed by another worker — skipping`);
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

module.exports = { sendCampaign, prepareResumeCampaign, resumeCampaign, processScheduledSends, buildSubscriberQuery, resolveSegmentCustomerIds, narrowServiceLineFilter, loadPersonalizationContext, sanitizePersonalizationToken, excludeGloballySuppressed, markEventsFeatured, sendingClaimIsStale };

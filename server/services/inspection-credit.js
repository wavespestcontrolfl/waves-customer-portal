/**
 * Inspection credit — "your inspection fee is credited toward any service
 * you book within N days" (owner-approved 2026-08-02).
 *
 * TWO legs, deliberately separated so a promise never moves money on its own:
 *
 *   recordInspectionCreditOffer()  at inspection CLOSEOUT — writes the
 *     durable promise (amount + expiry FROZEN) and nothing else. No ledger
 *     entry, no balance change. An offer that is never redeemed simply
 *     lapses; there is nothing to reverse and no sweep to run.
 *
 *   redeemInspectionCreditForBooking()  when the customer BOOKS — mints the
 *     credit into the existing customer-credit ledger, which the normal
 *     auto-apply machinery then puts against their invoice.
 *
 * Exactly-once is enforced by the DATABASE, not by flow control: the offers
 * table is unique on source_scheduled_service_id (one offer per inspection)
 * and on credit_ledger_id (one mint per offer). Redemption additionally
 * claims the row with a status-guarded UPDATE before it posts money, so two
 * concurrent bookings cannot both mint.
 *
 * DARK behind GATE_INSPECTION_CREDIT, checked on BOTH legs: flipping the
 * gate off stops new promises and pauses redemption without orphaning
 * offers already made.
 */
const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { postCreditMovement } = require('./customer-credit');
const { addETDays, etDateString, parseETDateTime } = require('../utils/datetime-et');

// A booking in one of these states never earns a redemption — a cancelled
// or no-showed visit is not the service the credit was promised toward.
// Mirrors estimate-conversion-guard's NON_LIVE_APPOINTMENT_STATUSES.
// Statuses that mean the customer's booking is GONE. 'rescheduled' is
// deliberately absent (Codex #3178 r3 P1): the customer reschedule
// endpoint stamps that status while the visit simply MOVES — treating it
// as gone would claw back a credit from someone who is still booked.
const NON_LIVE_APPOINTMENT_STATUSES = Object.freeze([
  'cancelled', 'canceled', 'skipped', 'no_show',
]);

// Owner ruling 2026-08-03. Per-service overrides come from pricing_config
// (rodent_inspection.creditable_within_days is the existing precedent at 14)
// — this is only the fallback when a service carries no window of its own.
const DEFAULT_CREDIT_WINDOW_DAYS = 30;

/**
 * The FLAT credit an inspection earns — owner ruling 2026-08-03: worth this
 * amount whatever the inspection was actually billed at, so a comped or
 * discounted inspection still earns the full credit. pricing_config is
 * authoritative (db-bridge overlays constants.INSPECTION_CREDIT); the
 * in-code default only covers a fresh env with no row.
 */
function configuredCreditAmount() {
  try {
    const { INSPECTION_CREDIT } = require('./pricing-engine/constants');
    const amount = Number(INSPECTION_CREDIT?.amount);
    if (Number.isFinite(amount) && amount > 0) return round2(amount);
  } catch { /* fall through */ }
  return 75;
}

/**
 * The credit amount for a specific service. Rodent inspections credit their
 * QUOTED fee, not the flat default (owner ruling 2026-08-04): the public
 * estimator has been promising "$125 inspection (creditable for 14 days
 * toward remediation work)" on tokenized estimates since before this
 * feature existed, and an in-flight estimate is a keep-working surface —
 * freezing the flat $75 onto a rodent offer would short a promise already
 * sent. pricing_config stays authoritative for both values via the
 * db-bridge overlay.
 */
function configuredCreditAmountForServiceKey(serviceKey) {
  try {
    if (String(serviceKey || '') === 'rodent_inspection') {
      const { RODENT } = require('./pricing-engine/constants');
      const fee = Number(RODENT?.inspection?.fee);
      if (Number.isFinite(fee) && fee > 0) return round2(fee);
    }
  } catch { /* fall through to the flat default */ }
  return configuredCreditAmount();
}

/**
 * Whether a completion profile describes an inspection visit that earns the
 * credit. The CATEGORY covers generic inspections, but typed family
 * profiles carry their family's category instead — `rodent_inspection` is
 * category 'rodent' since the rodent-family cutover (20260612000012) and
 * `termite_inspection` is category 'termite' since the termite cutover
 * (20260713100000) — so gating on the category alone silently excluded
 * eligible inspections (Codex #3178 r24 P0, r30 P2). Keyed on the STABLE
 * service keys, matching how the amount/window overrides key. An explicit
 * set, not an `_inspection` suffix match: `wdo_inspection` is a paid
 * formal-report product (special_project mode) that deliberately does not
 * ride this lane.
 */
const TYPED_INSPECTION_SERVICE_KEYS = new Set(['rodent_inspection', 'termite_inspection']);

function isCreditableInspectionProfile(profile) {
  if (!profile) return false;
  if (String(profile.category || '') === 'inspection') return true;
  return TYPED_INSPECTION_SERVICE_KEYS.has(String(profile.serviceKey || ''));
}

/**
 * Services whose credit promise exists INDEPENDENT of GATE_INSPECTION_CREDIT
 * (Codex #3178 r31 P0): the public estimator prints "$125 inspection
 * (creditable for 14 days toward remediation work)" on every rodent
 * tokenized estimate — a keep-working surface that predates this lane.
 * While the gate is dark these closeouts still write the durable marker
 * and freeze the offer, or a customer completing an in-flight estimate
 * before the flip loses a promise already sent. Redemption stays gated —
 * no money moves while dark; the offer just records what was promised.
 */
function carriesStandingCreditPromise(serviceKey) {
  return String(serviceKey || '') === 'rodent_inspection';
}

/**
 * A date-only value (YYYY-MM-DD) as an ET wall-clock instant.
 *
 * `new Date('2026-08-03')` anchors at UTC midnight, which in Eastern time is
 * the PREVIOUS calendar day — that would shift a credit window a day early
 * (Codex #3178 P1). Noon ET is chosen so neither DST edge can cross a day
 * boundary. Non-date-only values pass through unchanged.
 */
function etDateOnlyToDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // A DATE column parses to a MIDNIGHT-UTC Date (repo canon —
    // service-report/time-format.js), which America/New_York rolls back to
    // the PREVIOUS day: passing it through unchanged anchored an Aug 5
    // inspection's window on Aug 4 and expired the promise a day early
    // (Codex #3178 r30 P1). Re-anchor at 16:00Z from the UTC date parts —
    // inside the ET day year-round, same convention as the string branch.
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 16));
  }
  const str = String(value);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) {
    const parsed = new Date(str);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  // Noon ET ~= 16:00Z (EDT) / 17:00Z (EST) — 16:00Z is inside the ET day
  // year-round.
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T16:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The instant the ET calendar day `days` after `from` ends.
 *
 * The customer is given a DATE ("book by September 2"), so the deadline has
 * to be the end of that day in Eastern time — not a fixed multiple of 24
 * hours from whenever the inspection was stamped, which would expire a
 * promise mid-afternoon on the day the receipt named (Codex #3178 r2 P0).
 */
function etEndOfDayAfterDays(from, days) {
  const base = from instanceof Date ? from : new Date(from);
  // ET CALENDAR-day arithmetic (addETDays), never fixed 24-hour periods
  // (pre-push P1 r18): a late-evening `from` crossing a DST boundary
  // shifts the wall clock an hour, and a 24h-multiple then derives a
  // calendar date one day off the promised "N days" — an 11:30pm EST
  // closeout crossing spring-forward printed day N+1.
  const lastDay = addETDays(base, Number(days));
  const dayAfter = addETDays(lastDay, 1);
  // The exclusive end is ET midnight of the FOLLOWING day, DST-resolved
  // by the repo helper rather than by probing fixed offsets.
  return parseETDateTime(`${etDateString(dayAfter)}T00:00:00`);
}

function windowMs(days) {
  return Number(days || DEFAULT_CREDIT_WINDOW_DAYS) * 24 * 60 * 60 * 1000;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function gateOn() {
  try {
    return isEnabled('inspectionCredit');
  } catch (err) {
    logger.warn(`[inspection-credit] gate read failed — treating as off: ${err.message}`);
    return false;
  }
}

/**
 * The creditable window for a service, in days. pricing_config is
 * authoritative (db-bridge overlays it onto the constants), so a service
 * with its own creditable_within_days keeps it; everything else takes the
 * owner default. Read ONCE at closeout and frozen onto the offer — a later
 * config change must never move a promise already made.
 */
function creditWindowDaysForServiceKey(serviceKey) {
  try {
    const { RODENT, INSPECTION_CREDIT } = require('./pricing-engine/constants');
    // A service with its own creditable window keeps it (rodent's 14 days
    // is the existing live precedent).
    if (String(serviceKey || '') === 'rodent_inspection') {
      const days = Number(RODENT?.inspection?.creditableWithinDays);
      if (Number.isFinite(days) && days > 0) return Math.round(days);
    }
    const configured = Number(INSPECTION_CREDIT?.creditableWithinDays);
    if (Number.isFinite(configured) && configured > 0) return Math.round(configured);
  } catch { /* fall through to the default */ }
  return DEFAULT_CREDIT_WINDOW_DAYS;
}

/**
 * Record the promise at inspection closeout. Best-effort by contract: a
 * failure here must NEVER fail the completion — the visit is done and the
 * tech is standing in the driveway. Returns a result object, never throws.
 *
 * The credit is the FLAT configured amount (owner ruling 2026-08-03) — NOT
 * what the inspection was billed at, so a comped or discounted inspection
 * still earns the full credit. `amount` is an explicit override for callers
 * that need one; everything else takes the configured value. It is frozen
 * onto the row here, so a later config change never moves a promise that
 * has already been made to a customer.
 */
async function recordInspectionCreditOffer({
  customerId,
  scheduledServiceId,
  serviceRecordId = null,
  serviceKey = null,
  amount = null,
  // Explicit window override — recovery passes the days frozen at closeout
  // so a config change can't move a promise already made (r21 P2).
  windowDays: explicitWindowDays = null,
  createdBy = 'system:inspection_closeout',
  // The real moment the promise was made — the ordering boundary every
  // redemption guard compares against.
  now = new Date(),
  // The inspection's service date, used ONLY to compute the expiry window
  // (Codex #3178 r7 P0). Conflating the two put created_at at noon on the
  // service date, so a booking made that afternoon — but BEFORE the
  // closeout — could pass the ordering guard and mint a credit it preceded.
  windowAnchor = null,
  // TRUE only when a durable `inspectionCreditOptIn` marker already exists
  // for this visit — i.e. the promise was made while the lane was LIVE and
  // this call is recovery/resume, not a new opt-in (Codex #3178 r24 P2).
  // A gate turned off must stop NEW promises, not strand ones already
  // committed; redemption stays gated, so no money moves while dark.
  honorCommittedMarker = false,
}) {
  if (!gateOn() && !honorCommittedMarker) return { recorded: false, reason: 'feature_disabled' };
  if (!customerId || !scheduledServiceId) {
    return { recorded: false, reason: 'missing_identifiers' };
  }
  const frozenAmount = amount != null ? round2(amount) : configuredCreditAmountForServiceKey(serviceKey);
  if (!(frozenAmount > 0)) {
    // Only reachable if the configured amount is misconfigured to 0 — a
    // zero credit is not a promise worth recording.
    return { recorded: false, reason: 'no_credit_amount' };
  }

  const windowDays = Number(explicitWindowDays) > 0
    ? Math.round(Number(explicitWindowDays))
    : creditWindowDaysForServiceKey(serviceKey);
  // END OF THE ET DAY, not now + N×24h (Codex #3178 r2 P0): the receipt
  // prints a calendar deadline ("book by September 2"), so a booking made
  // that afternoon must still qualify. Fixed 24-hour periods from a
  // 16:00Z anchor would have rejected it.
  const expiresAt = etEndOfDayAfterDays(windowAnchor || now, windowDays);

  try {
    // onConflict().ignore() on the unique source visit — a completion
    // retry/replay re-runs this leg and must not create a second promise.
    const [row] = await db('inspection_credit_offers')
      .insert({
        customer_id: customerId,
        source_scheduled_service_id: scheduledServiceId,
        source_service_record_id: serviceRecordId,
        amount: frozenAmount,
        status: 'offered',
        // The actual promise moment. A recovered offer passes the original
        // closeout time here so it doesn't sort after the booking it should
        // credit; the expiry window is anchored separately.
        created_at: now,
        expires_at: expiresAt,
        created_by: createdBy,
        note: `Inspection fee credited toward any service booked within ${windowDays} days`,
      })
      .onConflict('source_scheduled_service_id')
      .ignore()
      .returning(['id', 'amount', 'expires_at']);

    if (!row) {
      // The offer already existed — report the EXISTING terms so the
      // receipt states what the customer was actually promised.
      const existing = await db('inspection_credit_offers')
        .where({ source_scheduled_service_id: scheduledServiceId })
        .first('id', 'amount', 'expires_at', 'status');
      return existing
        ? {
          recorded: false, reason: 'already_offered', offerId: existing.id,
          amount: round2(existing.amount), expiresAt: existing.expires_at, windowDays,
        }
        : { recorded: false, reason: 'insert_conflict_unresolved' };
    }

    logger.info(
      `[inspection-credit] offer ${row.id} recorded for customer ${customerId} `
      + `($${frozenAmount.toFixed(2)}, ${windowDays}d) — mints only on rebook`,
    );
    return {
      recorded: true, offerId: row.id, amount: frozenAmount, expiresAt, windowDays,
    };
  } catch (err) {
    // Best-effort: never fail a completion over the credit promise.
    logger.error(`[inspection-credit] offer record FAILED for visit ${scheduledServiceId}: ${err.message}`);
    return { recorded: false, reason: 'error', error: err.message };
  }
}

/**
 * Redeem any open, unexpired offer for this customer against a booking they
 * just made. Mints ONE credit movement per offer, inside the same
 * transaction that claims the offer row, so a crash between claim and mint
 * cannot strand a redeemed-but-uncredited promise.
 *
 * Best-effort by contract (a booking must never fail because crediting
 * failed) — returns a summary, never throws.
 */
/**
 * Record that a REAL customer booking happened, inside the caller's booking
 * transaction (Codex #3178 r4).
 *
 * Written to its own table rather than onto an offer row: marking offers was
 * circular — once an offer redeems it stops being markable, so a later
 * booking left no trace and reversal couldn't tell whether the customer
 * still had a qualifying booking.
 *
 * Runs in a SAVEPOINT (Codex #3178 r4 P1). Postgres aborts a transaction
 * after any failed statement, so catching the error and returning would NOT
 * leave the caller's transaction usable — a credit-marker hiccup would take
 * down the booking or estimate conversion that hosts it. The savepoint
 * confines a failure to this write.
 */
async function markBookingForInspectionCredit(trx, { customerId, scheduledServiceId, source = null }) {
  // Deliberately UNGATED (Codex #3178 r5 P0): the event is just a fact
  // ("this customer booked"), costs nothing, and grants no money on its
  // own. Skipping it while dark would mean an offer promised before a
  // kill-switch period could never prove its booking afterwards, and would
  // silently expire.
  if (!customerId || !scheduledServiceId || !trx) return 0;
  const eventRow = {
    customer_id: customerId,
    scheduled_service_id: scheduledServiceId,
    source: source ? String(source).slice(0, 40) : null,
    // The BOOKING moment, frozen at call time (Codex #3178 r26 P2): the
    // post-commit retry reuses this row, and letting the DB default stamp
    // the RETRY time would shift the ordering evidence — a booking made
    // just inside the offer deadline whose marker recovered after the
    // boundary would compare the wrong instant and lose its credit.
    created_at: new Date(),
  };
  try {
    await trx.transaction(async (sp) => {
      await sp('inspection_credit_booking_events')
        .insert(eventRow)
        .onConflict('scheduled_service_id')
        .ignore();
    });
    return 1;
  } catch (err) {
    // The savepoint rolled back; the caller's transaction is still healthy
    // and the booking MUST still commit (a booking never fails because
    // crediting failed). But this event is the ONLY proof redemption
    // accepts, so a swallowed failure is silent permanent credit loss
    // (pre-push P0). Recovery ladder: a DURABLE outbox row committed WITH
    // the booking (r31 P2 — the in-memory retry below dies with a restart,
    // and redemption is now evidence-required), then the fast in-memory
    // retry, then the hourly sweep replays any outbox row still missing
    // its event. The outbox rides the caller's trx, so it exists exactly
    // when the booking it proves does.
    logger.error(`[inspection-credit] booking event failed for ${scheduledServiceId} (post-commit retry queued): ${err.message}`);
    try {
      await require('./notification-service').notifyAdmin(
        'billing',
        'Inspection-credit booking evidence failed — auto-recovery queued',
        'A booking could not record its inspection-credit evidence in-transaction. The retry ladder and the hourly sweep will recover it automatically; no action needed unless this alert repeats for the same customer.',
        {
          link: `/admin/customers/${customerId}`,
          connection: trx,
          metadata: {
            reason: 'booking_evidence_outbox',
            customerId, scheduledServiceId,
            source: eventRow.source,
            bookedAt: eventRow.created_at.toISOString(),
          },
        },
      );
    } catch (outboxErr) {
      logger.error(`[inspection-credit] evidence outbox write failed for ${scheduledServiceId}: ${outboxErr.message}`);
    }
    const recoverEvidence = async (attempt) => {
      try {
        // setImmediate is NOT tied to the caller's commit (pre-push P1):
        // retrying while the booking row is still uncommitted fails the FK
        // and would drop the only proof redemption accepts. Wait until the
        // booking is VISIBLE on the global pool before inserting; if it
        // never appears, the transaction rolled back and there is no
        // booking to prove.
        const committed = await db('scheduled_services')
          .where({ id: scheduledServiceId })
          .first('id');
        if (!committed) {
          if (attempt < 6) {
            const timer = setTimeout(() => { void recoverEvidence(attempt + 1); }, 10000);
            if (typeof timer.unref === 'function') timer.unref();
            return;
          }
          logger.warn(`[inspection-credit] booking ${scheduledServiceId} never became visible — evidence retry dropped (booking likely rolled back)`);
          return;
        }
        await db('inspection_credit_booking_events')
          .insert(eventRow)
          .onConflict('scheduled_service_id')
          .ignore();
        logger.info(`[inspection-credit] booking event recovered post-commit for ${scheduledServiceId}`);
      } catch (retryErr) {
        // The durable outbox row (committed with the booking) already
        // alerted the office and the hourly sweep replays it — this fast
        // path is just the low-latency leg, so its failure is a log line,
        // not a second alert.
        logger.error(`[inspection-credit] booking event retry failed for ${scheduledServiceId} — sweep will replay the outbox: ${retryErr.message}`);
      }
    };
    setImmediate(() => { void recoverEvidence(0); });
    return 0;
  }
}

/**
 * The earliest PROVEN customer booking inside a window — the shared
 * evidence test for redemption, rebinding and late-offer adoption.
 */
async function provenBookingInWindow({ customerId, from, to, excludeIds = [] }) {
  const skip = excludeIds.filter(Boolean);
  const q = db('inspection_credit_booking_events as e')
    .join('scheduled_services as s', 's.id', 'e.scheduled_service_id')
    .where('e.customer_id', customerId)
    .whereNotIn('s.status', NON_LIVE_APPOINTMENT_STATUSES)
    // Free callbacks never count as the qualifying booking (r32 P2) —
    // COALESCE: the column defaults false, but a null must not exclude a
    // real booking under SQL three-valued logic.
    .whereRaw('COALESCE(s.is_callback, false) = false')
    .where('e.created_at', '>=', from)
    .where('e.created_at', '<=', to)
    .orderBy('e.created_at', 'asc');
  if (skip.length) q.whereNotIn('s.id', skip);
  return q.first('s.id as id', 'e.created_at as created_at');
}

/**
 * Claim and mint ONE specific offer against ONE booking. The claim is
 * status-guarded AND ordering-guarded inside the transaction: the booking
 * must have been created after the promise and before it lapsed, so no
 * caller can mint an offer that no booking followed (Codex #3175 P0), and a
 * concurrent redeemer finds nothing left to claim.
 *
 * Returns true only when money actually posted. Never throws.
 */
async function redeemSpecificOffer({ offerId, customerId, amount, bookingId, bookingCreatedAt, createdBy, now }) {
  try {
    await db.transaction(async (trx) => {
      const claimed = await trx('inspection_credit_offers')
        .where({ id: offerId })
        // 'expired' is provisional, never money-terminal (pre-push P0):
        // the sweep can expire an offer in a race with a booking whose
        // event commits between the evidence check and the expire UPDATE.
        // The ordering guard below is the real arbiter — a booking made
        // inside the window reclaims the offer. 'redeemed' plus the unique
        // ledger id remains the only money-terminal state.
        .whereIn('status', ['offered', 'expired'])
        // Ordering, re-validated under the claim: promise BEFORE booking,
        // booking BEFORE expiry. Redemption is judged by when the customer
        // booked, never by when this code happens to run.
        .where('created_at', '<=', bookingCreatedAt)
        .where('expires_at', '>=', bookingCreatedAt)
        .update({
          status: 'redeemed',
          redeemed_at: now,
          redeemed_scheduled_service_id: bookingId,
          updated_at: trx.fn.now(),
        });
      if (claimed !== 1) {
        const e = new Error('offer claim lost a race or failed its ordering guard');
        e.inspectionCreditSkip = 'claim_lost';
        throw e;
      }
      // Re-validate the BOOKING under lock, inside the same transaction
      // that mints (pre-push P0): every caller's liveness read happens
      // before this transaction starts, so a cancellation could commit in
      // between — its reversal would find no redeemed offer yet, then this
      // mint would land $75 against a cancelled booking, spendable until
      // the hourly sweep. Locking the row here serializes against the
      // cancel (which updates the same row); non-live or a foreign
      // customer rolls the claim back untouched.
      const bookingRow = await trx('scheduled_services')
        .where({ id: bookingId })
        .forUpdate()
        .first('status', 'customer_id', 'is_callback');
      if (!bookingRow
        || NON_LIVE_APPOINTMENT_STATUSES.includes(String(bookingRow.status || '').toLowerCase())
        || (bookingRow.customer_id != null && String(bookingRow.customer_id) !== String(customerId))) {
        const e = new Error('booking went non-live (or changed hands) before the mint');
        e.inspectionCreditSkip = 'booking_not_live';
        throw e;
      }
      // A FREE re-service callback is not a purchase (Codex #3178 r32
      // P2): the promise is a credit toward service the customer BOOKS,
      // and a courtesy callback carries no collectible work — minting on
      // it hands out fungible balance for nothing. `is_callback` is the
      // explicit stamp (createSelfBooking's internal re-service path);
      // deliberately NOT create_invoice_on_complete=false, which
      // member-covered and included-child bookings legitimately carry.
      if (bookingRow.is_callback === true) {
        const e = new Error('booking is a free callback — no credit to mint against');
        e.inspectionCreditSkip = 'booking_not_live';
        throw e;
      }
      const { entry } = await postCreditMovement({
        customerId,
        delta: round2(amount),
        source: 'inspection_credit',
        note: 'Inspection fee credited toward booked service',
        createdBy,
      }, trx);
      // UNIQUE credit_ledger_id — the durable exactly-once proof.
      await trx('inspection_credit_offers')
        .where({ id: offerId })
        .update({ credit_ledger_id: entry.id, updated_at: trx.fn.now() });
    });
    logger.info(`[inspection-credit] offer ${offerId} redeemed on booking ${bookingId}`);
    return true;
  } catch (err) {
    if (err?.inspectionCreditSkip === 'claim_lost') return false;
    if (err?.inspectionCreditSkip === 'booking_not_live') {
      // Not an error: the cancel won the race and the claim rolled back
      // untouched — the offer stays open for a real booking.
      logger.info(`[inspection-credit] offer ${offerId} not minted — booking ${bookingId} went non-live first`);
      return false;
    }
    // Left 'offered' on purpose — the sweep retries it.
    logger.error(`[inspection-credit] redemption FAILED for offer ${offerId}: ${err.message}`);
    return false;
  }
}

/**
 * Fast path: redeem against a booking the customer just made. Only offers
 * promised BEFORE this booking and still unexpired at booking time qualify
 * — an offer created later has no booking following it and must not mint.
 *
 * Best-effort by contract (a booking must never fail because crediting
 * failed) and NOT the guarantee — sweepInspectionCreditRedemptions is.
 * Never throws.
 */
async function redeemInspectionCreditForBooking({
  customerId,
  scheduledServiceId,
  bookingStatus = null,
  createdBy = 'system:inspection_credit_rebook',
  now = new Date(),
}) {
  if (!gateOn()) return { redeemed: 0, reason: 'feature_disabled' };
  if (!customerId || !scheduledServiceId) return { redeemed: 0, reason: 'missing_identifiers' };
  if (bookingStatus && NON_LIVE_APPOINTMENT_STATUSES.includes(String(bookingStatus).toLowerCase())) {
    return { redeemed: 0, reason: 'booking_not_live' };
  }
  // The booking's live status, read from the row (Codex #3178 r6 P0).
  try {
    const row = await db('scheduled_services')
      .where({ id: scheduledServiceId })
      .first('created_at', 'status');
    if (!row) return { redeemed: 0, reason: 'booking_not_found' };
    if (NON_LIVE_APPOINTMENT_STATUSES.includes(String(row.status || '').toLowerCase())) {
      return { redeemed: 0, reason: 'booking_not_live' };
    }
  } catch (err) {
    logger.warn(`[inspection-credit] booking lookup failed for ${scheduledServiceId}: ${err.message}`);
    return { redeemed: 0, reason: 'booking_lookup_failed' };
  }
  // The booking EVENT is the REQUIRED booking moment (r28 P2 — was the
  // authoritative one with a row-time fallback, pre-push P0): a graduated
  // hold's or adopted appointment's scheduled_services.created_at is the
  // RESERVATION/placeholder instant. Falling back to it when the savepoint
  // evidence write missed let a hold reserved inside the window but
  // accepted after expiry mint an unearned credit; requiring the event
  // instead defers those rare failures to the sweep, which judges by the
  // recovered event's frozen accept-time stamp. Fail CLOSED on a lookup
  // fault — never mint on an unknown moment.
  let bookedAt;
  try {
    const evt = await db('inspection_credit_booking_events')
      .where({ scheduled_service_id: scheduledServiceId })
      .first('created_at');
    if (!evt?.created_at) return { redeemed: 0, reason: 'no_booking_evidence' };
    bookedAt = new Date(evt.created_at);
  } catch (evtErr) {
    logger.warn(`[inspection-credit] booking event lookup failed for ${scheduledServiceId}: ${evtErr.message}`);
    return { redeemed: 0, reason: 'booking_event_lookup_failed' };
  }

  try {
    const open = await db('inspection_credit_offers')
      .where({ customer_id: customerId })
      // 'expired' included on purpose — provisional, and the time-window
      // guards below (re-validated under the claim) are the real arbiter.
      .whereIn('status', ['offered', 'expired'])
      // Promised before this booking, still live when it was made.
      .where('created_at', '<=', bookedAt)
      .where('expires_at', '>=', bookedAt)
      .whereNot({ source_scheduled_service_id: scheduledServiceId })
      .orderBy('expires_at', 'asc')
      .select('id', 'amount');
    if (!open.length) return { redeemed: 0, reason: 'no_open_offer' };

    let redeemed = 0;
    let total = 0;
    for (const offer of open) {
      const ok = await redeemSpecificOffer({
        offerId: offer.id,
        customerId,
        amount: offer.amount,
        bookingId: scheduledServiceId,
        bookingCreatedAt: bookedAt,
        createdBy,
        now,
      });
      if (ok) {
        redeemed += 1;
        total = round2(total + round2(offer.amount));
      }
    }
    return { redeemed, amount: total };
  } catch (err) {
    logger.error(`[inspection-credit] redemption sweep FAILED for customer ${customerId}: ${err.message}`);
    return { redeemed: 0, reason: 'error', error: err.message };
  }
}

/**
 * Recovery sweep — the DURABLE half of redemption (Codex #3175 P0 ×2).
 *
 * The at-booking call is only a fast path. It cannot be the guarantee,
 * because (a) scheduled_services is written from a dozen surfaces (public
 * self-booking, leads, estimate conversion, seeders) and wiring each one is
 * a standing invitation to miss the next one, and (b) a transient claim or
 * ledger failure there would otherwise lose a promise permanently.
 *
 * The offer row is the durable record: it stays 'offered' until a mint
 * succeeds. This sweep re-derives redemption from persisted state — any open
 * offer whose customer has a LIVE booking created after it — so a missed
 * surface or a failed attempt simply redeems on the next run. Idempotent by
 * construction: it reuses the same status-guarded claim, so a booking that
 * already redeemed is a no-op.
 *
 * Also closes out genuinely lapsed offers so the working set stays small.
 * Returns counts; never throws.
 */
async function sweepInspectionCreditRedemptions({ now = new Date(), limit = 500 } = {}) {
  // NOT an early return on the gate (Codex #3178 r5 P0): reversal cleanup
  // must keep running through a kill-switch period, or a credit whose
  // booking is cancelled while dark stays spendable forever. Only the
  // offer/redemption half below is gated.
  const creditingOn = gateOn();
  let redeemed = 0;
  let expired = 0;
  let reversed = 0;
  let recovered = 0;
  try {
    // Every still-open offer, INCLUDING lapsed ones: redemption is judged
    // by when the customer BOOKED, not by when this sweep runs (Codex
    // #3175 P0). A booking made inside the window still earns its credit
    // even if the fast path failed, cron was down, or the gate was off
    // until after the expiry date.
    // Reversals first, targeted by JOIN so the working set is only offers
    // whose booking is ALREADY non-live (Codex #3175 r4 P0). Scanning the
    // redeemed set blindly meant >500 still-live historical rows could
    // starve a later cancellation forever.
    // FRESH cancellations first (Codex #3178 r23 P2): a row that failed
    // reversal durably — credit already spent, invoice unresolved — stays
    // `redeemed` with `reversal_alerted_at` set until the office resolves
    // it, and enough of those would fill an unordered batch forever,
    // starving every newer cancellation. Never-alerted rows get first
    // claim on the batch; alerted rows are RETRIES (the office may have
    // resolved since) and only fill the remaining capacity, in random
    // order so no fixed subset of permanent failures can permanently
    // shadow the rest.
    const staleBase = () => db('inspection_credit_offers as o')
      .join('scheduled_services as s', 's.id', 'o.redeemed_scheduled_service_id')
      .where('o.status', 'redeemed')
      .whereIn('s.status', NON_LIVE_APPOINTMENT_STATUSES);
    const freshStale = await staleBase()
      .whereNull('o.reversal_alerted_at')
      .limit(limit)
      .select('o.id as id', 'o.redeemed_scheduled_service_id as booking_id');
    const retryCapacity = limit - freshStale.length;
    const stale = retryCapacity > 0
      ? freshStale.concat(await staleBase()
        .whereNotNull('o.reversal_alerted_at')
        .orderByRaw('random()')
        .limit(retryCapacity)
        .select('o.id as id', 'o.redeemed_scheduled_service_id as booking_id'))
      : freshStale;
    for (const row of stale) {
      try {
        const rev = await reverseInspectionCreditForBooking({
          scheduledServiceId: row.booking_id,
          createdBy: 'system:inspection_credit_sweep_reversal',
          now,
        });
        reversed += Number(rev?.reversed) || 0;
      } catch (err) {
        logger.error(`[inspection-credit] sweep reversal failed for offer ${row.id}: ${err.message}`);
      }
    }

    // Closeout recovery, driven ONLY by the durable opt-in marker the
    // completion transaction wrote (Codex #3175 r5 P0). Inferring a promise
    // from "an inspection was completed" could not distinguish a transient
    // offer-write failure from the tech clearing the box, and on first gate
    // enablement it would have swept up every historical inspection and
    // turned them into real account credit.
    // Runs even while DARK (Codex #3178 r24 P2): a marker is only ever
    // written while the lane is live, so recovering its offer row honors a
    // promise already made — the kill switch stops NEW opt-ins and all
    // redemption (below), never the record of an existing promise. Skipping
    // this while dark stranded a committed closeout whose offer insert
    // crashed until someone re-enabled the gate.
    try {
      const missing = await db('service_records as r')
        .join('scheduled_services as s', 's.id', 'r.scheduled_service_id')
        .leftJoin('inspection_credit_offers as o', 'o.source_scheduled_service_id', 's.id')
        .whereRaw("(r.service_data->>'inspectionCreditOptIn') = 'true'")
        .whereNull('o.id')
        .limit(limit)
        .select('s.id as id', 's.customer_id as customer_id', 's.service_id as service_id',
          'r.id as record_id', 'r.service_date as service_date',
          // The CLOSEOUT instant — the real moment the promise was made.
          'r.created_at as closed_out_at',
          // The TERMS frozen with the consent marker (Codex #3178 r21 P2).
          db.raw("r.service_data->'inspectionCreditTerms' as frozen_terms"));
      for (const visit of missing) {
        let serviceKey = null;
        try {
          const svcRow = await db('services').where({ id: visit.service_id }).first('service_key');
          serviceKey = svcRow?.service_key || null;
        } catch { serviceKey = null; }
        // The terms the CLOSEOUT froze with the marker (Codex #3178 r21
        // P2): pricing config can change between the failed insert and this
        // recovery, and the customer was promised the closeout's amount and
        // window — never the newly configured ones. Absent (pre-terms
        // markers), the configured values remain the only source.
        let frozenTerms = null;
        try {
          frozenTerms = typeof visit.frozen_terms === 'string'
            ? JSON.parse(visit.frozen_terms) : (visit.frozen_terms || null);
        } catch { frozenTerms = null; }
        // Frozen from the SERVICE DATE — the customer's window started when
        // the inspection happened, not when recovery ran.
        const created = await recordInspectionCreditOffer({
          customerId: visit.customer_id,
          scheduledServiceId: visit.id,
          serviceRecordId: visit.record_id,
          serviceKey,
          ...(Number(frozenTerms?.amount) > 0 ? { amount: Number(frozenTerms.amount) } : {}),
          ...(Number(frozenTerms?.windowDays) > 0 ? { windowDays: Number(frozenTerms.windowDays) } : {}),
          createdBy: 'system:inspection_credit_recovery',
          // The promise moment is the CLOSEOUT instant (Codex #3178 r8
          // P0). Passing the service date here backdated created_at to noon
          // on that day, so a booking made that afternoon but BEFORE the
          // closeout would qualify and mint money it preceded. The service
          // date anchors only the expiry window (ET wall-clock — a date-only
          // value parsed as UTC midnight lands on the previous ET day).
          now: visit.closed_out_at ? new Date(visit.closed_out_at) : now,
          windowAnchor: etDateOnlyToDate(visit.service_date) || now,
          // The working set IS the durable-marker query — every visit here
          // carries a committed opt-in, so recovery proceeds even while
          // the gate is dark (r24 P2).
          honorCommittedMarker: true,
        });
        if (created?.recorded) recovered += 1;
        // This recovery insert can be the FIRST successful creation of the
        // promise (the closeout-time insert failed), so the prepaid
        // receipt-resend must ride it too (PR #3178 r17 P2) — otherwise an
        // already-paid, non-payer inspection in exactly the transient-
        // failure case this recovery exists for never sees its deadline.
        // Keyed on offerId, not `recorded` (Codex #3178 r23 P2): a crash
        // between a prior insert and its resend leaves `already_offered`
        // with the memo still unsent; the resend itself is idempotent.
        if (created?.offerId) {
          queueCreditReceiptResend({ scheduledServiceId: visit.id, offerId: created.offerId });
        }
        // The offer arrived LATE, so a qualifying booking may already have
        // happened while it was missing (Codex #3178 r3 P1). Adopt the
        // earliest PROVEN booking inside the window — proven meaning
        // another offer's marker points at it, the same evidence standard
        // redemption uses; a bare scheduled_services row could be a seeder.
        if (created?.recorded && created.offerId) {
          try {
            const priorBooking = await provenBookingInWindow({
              customerId: visit.customer_id,
              from: new Date(created.expiresAt.getTime() - windowMs(created.windowDays)),
              to: created.expiresAt,
              excludeIds: [visit.id],
            });
            if (priorBooking) {
              await db('inspection_credit_offers')
                .where({ id: created.offerId, status: 'offered' })
                .whereNull('redeemed_scheduled_service_id')
                .update({ redeemed_scheduled_service_id: priorBooking.id, updated_at: db.fn.now() });
            }
          } catch (adoptErr) {
            logger.warn(`[inspection-credit] late-offer booking adoption failed for ${visit.id}: ${adoptErr.message}`);
          }
        }
      }
    } catch (err) {
      logger.error(`[inspection-credit] closeout recovery failed: ${err.message}`);
    }

    // Evidence-outbox replay (Codex #3178 r31 P2): a booking whose
    // savepointed event insert failed committed a durable outbox row in
    // the SAME transaction. The fast in-memory retry usually recovers it,
    // but a restart drops that — and redemption is evidence-required, so
    // a missing event is permanent credit loss. Replay any outbox row
    // still missing its event, stamping the FROZEN booking moment the
    // outbox carried. The outbox committed with the booking, so the FK
    // target always exists; the whereNotExists filter self-terminates the
    // replay once the event lands.
    try {
      const outbox = await db('notifications')
        .where({ recipient_type: 'admin' })
        .whereRaw("metadata->>'reason' = 'booking_evidence_outbox'")
        .whereRaw("NOT EXISTS (SELECT 1 FROM inspection_credit_booking_events e WHERE e.scheduled_service_id = (notifications.metadata->>'scheduledServiceId')::uuid)")
        .limit(limit)
        .select(
          db.raw("metadata->>'customerId' as customer_id"),
          db.raw("metadata->>'scheduledServiceId' as scheduled_service_id"),
          db.raw("metadata->>'bookedAt' as booked_at"),
          db.raw("metadata->>'source' as source"),
        );
      for (const row of outbox) {
        if (!row.customer_id || !row.scheduled_service_id) continue;
        try {
          await db('inspection_credit_booking_events')
            .insert({
              customer_id: row.customer_id,
              scheduled_service_id: row.scheduled_service_id,
              source: row.source || null,
              created_at: row.booked_at ? new Date(row.booked_at) : now,
            })
            .onConflict('scheduled_service_id')
            .ignore();
          logger.info(`[inspection-credit] booking evidence replayed from outbox for ${row.scheduled_service_id}`);
        } catch (replayErr) {
          logger.error(`[inspection-credit] outbox evidence replay failed for ${row.scheduled_service_id}: ${replayErr.message}`);
        }
      }
    } catch (outboxSweepErr) {
      logger.error(`[inspection-credit] evidence-outbox sweep failed: ${outboxSweepErr.message}`);
    }

    // Receipt-channel audit (Codex #3178 r30 P2): the closeout-time
    // no-channel recheck is an in-memory timer — a restart during its
    // 2-minute wait dropped it permanently, and marker recovery skips
    // visits whose offer already exists, so nobody ever alerted. This
    // durable pass revisits OPEN offers older than 10 minutes whose visit
    // has no PAID customer invoice (pre-filtered here so the resend
    // helper's paid path — PDF generation — never runs from the sweep) and
    // re-runs the channel decision: a live invoice appeared → silent; still
    // nothing → the once-per-offer office alert. attempt: 1 skips the
    // volatile defer. Runs while dark like the recovery resends — it
    // delivers/announces promises already made, never new ones.
    try {
      const auditCutoff = new Date(now.getTime() - 10 * 60 * 1000);
      const unchanneled = await db('inspection_credit_offers as o')
        .where('o.status', 'offered')
        .where('o.expires_at', '>=', now)
        .where('o.created_at', '<=', auditCutoff)
        .whereNotExists(function paidInvoiceExists() {
          this.select('*').from('invoices')
            .whereRaw('invoices.scheduled_service_id = o.source_scheduled_service_id')
            .where('invoices.status', 'paid')
            .whereNull('invoices.payer_id');
        })
        .limit(limit)
        .select('o.id as id', 'o.source_scheduled_service_id as visit_id');
      for (const row of unchanneled) {
        queueCreditReceiptResend({ scheduledServiceId: row.visit_id, offerId: row.id, attempt: 1 });
      }
      // PAID-invoice offers whose resend never landed (Codex #3178 r31
      // P2): a crash between the offer insert and the setImmediate resend
      // left the only deadline-carrying receipt unsent — marker recovery
      // skips the visit (offer exists) and the no-channel tier above skips
      // it (paid invoice exists). email_messages.idempotency_key is the
      // DURABLE send record, so an offer with a paid invoice but no
      // 'inspection-credit-offer-<id>' message row is exactly an undelivered
      // resend; re-queue it (idempotent — a concurrent send dedupes).
      // Pre-filtered in SQL so PDF generation only runs for the rare
      // genuinely-undelivered offer, never per-offer per-hour.
      const undelivered = await db('inspection_credit_offers as o')
        .where('o.status', 'offered')
        .where('o.expires_at', '>=', now)
        .where('o.created_at', '<=', auditCutoff)
        .whereRaw("EXISTS (SELECT 1 FROM invoices i WHERE i.scheduled_service_id = o.source_scheduled_service_id AND i.status = 'paid' AND i.payer_id IS NULL)")
        .whereRaw("NOT EXISTS (SELECT 1 FROM email_messages m WHERE m.idempotency_key = 'inspection-credit-offer-' || o.id::text)")
        .limit(limit)
        .select('o.id as id', 'o.source_scheduled_service_id as visit_id');
      for (const row of undelivered) {
        queueCreditReceiptResend({ scheduledServiceId: row.visit_id, offerId: row.id, attempt: 1 });
      }
    } catch (auditErr) {
      logger.error(`[inspection-credit] receipt-channel audit failed: ${auditErr.message}`);
    }

    // Everything below MOVES OR EXPIRES MONEY-BEARING STATE — that is what
    // the kill switch pauses.
    if (!creditingOn) {
      if (reversed || recovered) logger.info(`[inspection-credit] sweep (gate off): ${reversed} reversed, ${recovered} recovered`);
      return { redeemed: 0, expired: 0, reversed, recovered, reason: 'feature_disabled' };
    }

    // Redemption is EVIDENCE-FIRST (PR #3178 r17 P2): the working set is
    // the join of booking events to the offers they can prove — never a
    // plain oldest-N scan of open offers, which lets unbooked offers
    // sitting out their 14/30-day window monopolize every sweep and starve
    // a newer offer whose fast-path redemption failed. Judged by when the
    // customer BOOKED (e.created_at inside the offer's window), not when
    // this sweep runs. Includes 'expired' rows on purpose — expiry is
    // provisional, and this same join is the expiry-race rescue: a booking
    // event that commits between an evidence check and an expire UPDATE is
    // picked up here next run. The claim's ordering guard re-validates
    // everything under the lock; redeemed rows leave the working set, so
    // it cannot starve.
    try {
      const provable = await db('inspection_credit_booking_events as e')
        .join('inspection_credit_offers as o', 'o.customer_id', 'e.customer_id')
        .join('scheduled_services as s', 's.id', 'e.scheduled_service_id')
        .whereIn('o.status', ['offered', 'expired'])
        .whereNull('o.credit_ledger_id')
        .whereRaw('e.created_at >= o.created_at')
        .whereRaw('e.created_at <= o.expires_at')
        .whereRaw('e.scheduled_service_id IS DISTINCT FROM o.source_scheduled_service_id')
        .whereNotIn('s.status', NON_LIVE_APPOINTMENT_STATUSES)
        .orderBy('e.created_at', 'asc')
        .limit(limit)
        .select('o.id as offer_id', 'o.customer_id as customer_id', 'o.amount as amount',
          'e.scheduled_service_id as booking_id', 'e.created_at as booked_at');
      for (const row of provable) {
        if (!row.offer_id || !row.booking_id) continue;
        const ok = await redeemSpecificOffer({
          offerId: row.offer_id,
          customerId: row.customer_id,
          amount: row.amount,
          bookingId: row.booking_id,
          bookingCreatedAt: new Date(row.booked_at),
          createdBy: 'system:inspection_credit_sweep',
          now,
        });
        if (ok) redeemed += 1;
      }
    } catch (redeemErr) {
      logger.error(`[inspection-credit] evidence-first redemption failed: ${redeemErr.message}`);
    }

    // Expiry pass, equally starvation-proof: only offers whose window has
    // genuinely lapsed, oldest deadline first — each row processed once
    // transitions out of this working set. Status-guarded so it can't
    // stomp a concurrent redemption, and 'expired' stays provisional (the
    // evidence-first join above reclaims a raced one next run).
    try {
      const lapsed = await db('inspection_credit_offers')
        .where({ status: 'offered' })
        .where('expires_at', '<', now)
        .orderBy('expires_at', 'asc')
        .limit(limit)
        .select('id');
      for (const offer of lapsed) {
        try {
          const closed = await db('inspection_credit_offers')
            .where({ id: offer.id, status: 'offered' })
            .update({ status: 'expired', updated_at: db.fn.now() });
          expired += Number(closed) || 0;
        } catch (err) {
          logger.error(`[inspection-credit] expiry failed for offer ${offer.id}: ${err.message}`);
        }
      }
    } catch (expireErr) {
      logger.error(`[inspection-credit] expiry pass failed: ${expireErr.message}`);
    }

    if (redeemed || expired || reversed || recovered) {
      logger.info(`[inspection-credit] sweep: ${redeemed} redeemed, ${reversed} reversed, ${expired} expired, ${recovered} recovered`);
    }
    return { redeemed, expired, reversed, recovered };
  } catch (err) {
    logger.error(`[inspection-credit] sweep FAILED: ${err.message}`);
    return { redeemed, expired, reversed, recovered, reason: 'error', error: err.message };
  }
}

/**
 * Rebind a redeemed offer to a replacement booking, serialized against a
 * concurrent cancellation of that replacement (PR #3178 r18 P1).
 *
 * The unserialized version read the candidate's liveness on the pool and
 * then wrote the offer: cancelling A and B together could interleave so
 * B's reversal ran while the offer still pointed at A (a no-op), after
 * which A's rebind bound the offer to the now-cancelled B — $75 spendable
 * until the hourly stale sweep. Here the liveness check runs under the
 * candidate's row lock in the SAME transaction as the offer write, and the
 * offer row is locked FIRST — the same offer→booking order
 * redeemSpecificOffer's claim uses, so the two paths cannot deadlock.
 * A cancel that already committed makes the FOR UPDATE read see non-live
 * and the rebind refuses; a cancel in flight waits on our commit and then
 * sweeps the newly-bound offer normally.
 *
 * Returns true only when the offer actually rebound. Never throws.
 */
async function rebindRedeemedOffer(offerId, bookingId) {
  try {
    let rebound = false;
    await db.transaction(async (trx) => {
      const locked = await trx('inspection_credit_offers')
        .where({ id: offerId, status: 'redeemed' })
        .forUpdate()
        .first('id');
      if (!locked) return;
      const booking = await trx('scheduled_services')
        .where({ id: bookingId })
        .forUpdate()
        .first('status');
      if (!booking
        || NON_LIVE_APPOINTMENT_STATUSES.includes(String(booking.status || '').toLowerCase())) {
        return;
      }
      await trx('inspection_credit_offers')
        .where({ id: offerId, status: 'redeemed' })
        .update({
          redeemed_scheduled_service_id: bookingId,
          // A rebind starts a NEW booking lifecycle (Codex #3178 r24 P2):
          // a marker left by the OLD booking's failed reversal would
          // suppress the one alert the new booking's own failed reversal
          // is allowed to raise — same reset the successful-reversal claim
          // performs.
          reversal_alerted_at: null,
          updated_at: trx.fn.now(),
        });
      rebound = true;
    });
    return rebound;
  } catch (err) {
    logger.warn(`[inspection-credit] rebind failed for offer ${offerId} → booking ${bookingId}: ${err.message}`);
    return false;
  }
}

/**
 * Reverse a redemption when the booking that earned it goes non-live
 * (Codex #3175 r3 P0). NON_LIVE_APPOINTMENT_STATUSES says a cancelled or
 * no-showed visit never earns the credit — without this, minting on a
 * pending appointment let the customer keep $75 for a booking they
 * cancelled.
 *
 * Symmetric and idempotent: the ledger movement is reversed with a
 * negative delta and the offer REOPENS (clearing its mint binding) so it
 * can still be earned by a real booking inside its original window. The
 * claim is status-guarded, so concurrent cancellations reverse once.
 * Never throws — a cancellation must never fail over the credit.
 */
/**
 * Alert the office ONCE that a redeemed credit on a cancelled booking needs
 * a human, atomically with the reversal_alerted_at claim (Codex #3178 r9
 * P2): the claim — guarded on the marker being unset — row-locks the offer
 * so concurrent sweeps can't double-alert, and if the notification insert
 * doesn't land the rollback releases the claim for the next sweep. A later
 * successful reversal clears the marker when the offer reopens.
 */
async function alertReversalNeedsOffice(offer, scheduledServiceId, { reason, body }) {
  try {
    await db.transaction(async (trx) => {
      // The claim re-validates the STATE the alert describes, not just the
      // dedupe marker (pre-push P1 r19): between the failed/deferred
      // reversal and this transaction another worker can reverse or rebind
      // the offer, and a marker-only claim would then stamp the reopened
      // offer AND tell the office to collect credit that no longer needs
      // intervention — a false instruction nothing retracts. Still redeemed,
      // still bound to THIS cancelled booking, still unalerted, or no alert.
      const alertClaimed = await trx('inspection_credit_offers')
        .where({
          id: offer.id,
          status: 'redeemed',
          redeemed_scheduled_service_id: scheduledServiceId,
        })
        .whereNull('reversal_alerted_at')
        .update({ reversal_alerted_at: new Date(), updated_at: trx.fn.now() });
      if (alertClaimed !== 1) return; // already alerted, reversed, or rebound
      const notified = await require('./notification-service').notifyAdmin(
        'billing',
        'Inspection credit could not be reversed',
        body,
        {
          link: offer.customer_id ? `/admin/customers/${offer.customer_id}` : '/admin/invoices',
          metadata: { offerId: offer.id, scheduledServiceId, reason },
          connection: trx,
        },
      );
      if (!notified) {
        // notifyAdmin swallows its own insert failure and returns null;
        // throwing rolls the claim back so the next sweep retries.
        const e = new Error('reversal alert did not land');
        e.inspectionCreditSkip = 'alert_not_delivered';
        throw e;
      }
    });
  } catch (notifyErr) {
    if (notifyErr?.inspectionCreditSkip === 'alert_not_delivered') {
      logger.warn(`[inspection-credit] reversal alert not delivered for offer ${offer.id} — will retry next sweep`);
    } else {
      logger.error(`[inspection-credit] reversal alert failed for offer ${offer.id}: ${notifyErr.message}`);
    }
  }
}

async function reverseInspectionCreditForBooking({
  scheduledServiceId,
  createdBy = 'system:inspection_credit_reversal',
  now = new Date(),
}) {
  // Deliberately NOT gate-checked (Codex #3178 r3 P1): once an offer has
  // redeemed, its money is in the customer's general balance. Turning the
  // gate off must stop new promises, not strand credit for bookings that
  // were later cancelled — that would leave real money out with no path
  // back.
  if (!scheduledServiceId) return { reversed: 0, reason: 'missing_identifiers' };
  try {
    const redeemedOffers = await db('inspection_credit_offers')
      .where({ redeemed_scheduled_service_id: scheduledServiceId, status: 'redeemed' })
      .select('id', 'customer_id', 'amount', 'created_at', 'expires_at', 'credit_ledger_id', 'source_scheduled_service_id');
    if (!redeemedOffers.length) return { reversed: 0, reason: 'no_redeemed_offer' };

    let reversed = 0;
    for (const offer of redeemedOffers) {
      try {
        // FIRST (PR #3178 r17 P1): an invoice for this cancelled booking
        // still holding money — paid, processing, unverifiable PI,
        // anything outside the resolved set — may have the credit
        // EMBEDDED in it. Neither reversing NOR rebinding is safe then: a
        // blind negative movement would consume UNRELATED balance, and a
        // rebind would claim the credit belongs to another booking while
        // it sits in this one's invoice. Flag the office once and leave
        // the offer bound; when the office resolves the invoice, the
        // hourly sweep retries and rebind/reversal proceeds normally.
        // Fail CLOSED on a failed check — never move money blind.
        try {
          const { CANCELLED_SERVICE_RESOLVED_STATUSES } = require('./invoice');
          const unresolved = await db('invoices')
            .where({ scheduled_service_id: scheduledServiceId })
            .whereNotIn('status', CANCELLED_SERVICE_RESOLVED_STATUSES)
            .first('id');
          if (unresolved) {
            await alertReversalNeedsOffice(offer, scheduledServiceId, {
              reason: 'invoice_unresolved',
              body: `A $${round2(offer.amount).toFixed(2)} inspection credit is tied to a cancelled booking whose invoice still holds money. Reversing automatically could take unrelated balance — resolve the invoice, then collect or write off the credit.`,
            });
            continue;
          }
        } catch (checkErr) {
          logger.error(`[inspection-credit] invoice-state check failed for offer ${offer.id} — reversal deferred: ${checkErr.message}`);
          continue;
        }
        // The credit was earned by BOOKING inside the window. If another
        // live booking still stands in that window, the customer is still
        // entitled to it — rebind rather than claw it back (Codex #3178
        // P1): cancelling one of two bookings must not cost them the credit.
        // A PROVEN customer booking only — read from the booking-event
        // table so it stays true after this offer has redeemed (marking
        // offers was circular, Codex #3178 r4 P0).
        const alternate = await provenBookingInWindow({
          customerId: offer.customer_id,
          from: offer.created_at,
          to: offer.expires_at,
          excludeIds: [scheduledServiceId, offer.source_scheduled_service_id],
        });
        if (alternate && await rebindRedeemedOffer(offer.id, alternate.id)) {
          logger.info(`[inspection-credit] offer ${offer.id} rebound to live booking ${alternate.id} instead of reversing`);
          continue;
        }
        // A recurring anchor's seeded children carry no events of their own
        // — only the anchor was BOOKED, and the children were seeded inside
        // that same proven transaction. Cancelling just the anchor while
        // the series stays live must not claw the credit back (PR #3178
        // r17 P1): rebind to the earliest live child OF THE PROVEN ANCHOR.
        // Descendants of proven bookings only — an unrelated seeder row
        // still never qualifies.
        let seriesChild = null;
        try {
          // The proven anchor is either the cancelled booking itself, or —
          // when the cancelled booking is a seeded child the offer was
          // REBOUND to after its anchor cancelled (Codex #3178 r23 P1) —
          // the child's recurring parent. A seeded child carries no booking
          // event of its own, so judging provenance by the cancelled row
          // alone reversed the credit while live siblings kept the series
          // going.
          let provenAnchorId = null;
          const anchorProven = await db('inspection_credit_booking_events')
            .where({ scheduled_service_id: scheduledServiceId })
            .first('id');
          if (anchorProven) {
            provenAnchorId = scheduledServiceId;
          } else {
            const cancelledRow = await db('scheduled_services')
              .where({ id: scheduledServiceId })
              .first('recurring_parent_id');
            const parentId = cancelledRow?.recurring_parent_id;
            if (parentId) {
              const parentProven = await db('inspection_credit_booking_events')
                .where({ scheduled_service_id: parentId })
                .first('id');
              if (parentProven) provenAnchorId = parentId;
            }
          }
          if (provenAnchorId) {
            seriesChild = await db('scheduled_services')
              .where({ recurring_parent_id: provenAnchorId })
              .whereNot({ id: scheduledServiceId })
              .whereNotIn('status', NON_LIVE_APPOINTMENT_STATUSES)
              .orderBy('scheduled_date', 'asc')
              .first('id');
          }
          // OTHER proven series in the window (Codex #3178 r27 P2): the
          // alternate probe above only sees live rows carrying their own
          // event, and the chain probe only follows THIS cancellation's
          // lineage. An offer bound to standalone booking B still deserves
          // rebinding when a different proven anchor C in the window was
          // cancelled while its seeded child D lives on — C is non-live
          // and D has no event, so both probes miss the continuing series.
          // Descendants of proven in-window anchors only; seeder chains
          // still never qualify.
          if (!seriesChild) {
            const provenAnchors = await db('inspection_credit_booking_events')
              .where({ customer_id: offer.customer_id })
              .where('created_at', '>=', offer.created_at)
              .where('created_at', '<=', offer.expires_at)
              .whereNotIn('scheduled_service_id',
                [scheduledServiceId, offer.source_scheduled_service_id].filter(Boolean))
              .select('scheduled_service_id');
            const anchorIds = provenAnchors.map((r) => r.scheduled_service_id).filter(Boolean);
            if (anchorIds.length) {
              seriesChild = await db('scheduled_services')
                .whereIn('recurring_parent_id', anchorIds)
                .whereNot({ id: scheduledServiceId })
                .whereNotIn('status', NON_LIVE_APPOINTMENT_STATUSES)
                .orderBy('scheduled_date', 'asc')
                .first('id');
            }
          }
        } catch (childErr) {
          logger.warn(`[inspection-credit] series-child probe failed for ${scheduledServiceId}: ${childErr.message}`);
        }
        if (seriesChild && await rebindRedeemedOffer(offer.id, seriesChild.id)) {
          logger.info(`[inspection-credit] offer ${offer.id} rebound to live series child ${seriesChild.id} — anchor cancelled, series continues`);
          continue;
        }
        await db.transaction(async (trx) => {
          // Claim the reversal first: status-guarded so two cancellations
          // can't both give the money back — and bound to the LIFECYCLE this
          // sweep actually read (Codex #3178 r21 P1): a delayed attempt can
          // straddle a reverse-then-re-redeem by another worker, and an
          // id+status guard alone would then reverse the NEW booking's
          // credit while that booking is still live. The claim requires the
          // offer to still be bound to THIS cancelled booking and to the
          // ledger entry read at the top; any concurrent transition makes
          // it a silent claim_lost.
          const claimed = await trx('inspection_credit_offers')
            .where({
              id: offer.id,
              status: 'redeemed',
              redeemed_scheduled_service_id: scheduledServiceId,
              credit_ledger_id: offer.credit_ledger_id,
            })
            .update({
              // Reopens ONLY while the original window still stands; a
              // lapsed one closes out instead of dangling.
              status: new Date(offer.expires_at) >= now ? 'offered' : 'expired',
              redeemed_at: null,
              redeemed_scheduled_service_id: null,
              credit_ledger_id: null,
              // A successful reversal starts a fresh alert cycle (Codex
              // #3178 r9 P2): a stale marker from an earlier FAILED attempt
              // would suppress the one alert a future spent-credit failure
              // on the reopened offer is allowed to raise.
              reversal_alerted_at: null,
              updated_at: trx.fn.now(),
            });
          if (claimed !== 1) {
            const e = new Error('reversal claim lost a race');
            e.inspectionCreditSkip = 'claim_lost';
            throw e;
          }
          await postCreditMovement({
            customerId: offer.customer_id,
            delta: -round2(offer.amount),
            source: 'inspection_credit',
            note: 'Inspection credit returned — the booking it was applied to was cancelled',
            createdBy,
          }, trx);
        });
        reversed += 1;
        logger.info(`[inspection-credit] offer ${offer.id} reversed — booking ${scheduledServiceId} went non-live`);
      } catch (err) {
        if (err?.inspectionCreditSkip === 'claim_lost') continue;
        logger.error(`[inspection-credit] reversal FAILED for offer ${offer.id}: ${err.message}`);
        // The office alert is reserved for the one failure that is a
        // BILLING fact, not an operational one (PR #3178 r18 P2): the
        // typed insufficient-balance refusal from postCreditMovement —
        // the credit is fungible, so once spent the balance can't cover
        // the reversal, the money cannot be clawed back automatically,
        // and it becomes an OFFICE decision (collect or write off) rather
        // than a log line nobody reads (Codex #3175 r4 P0). A deadlock,
        // dropped connection or ledger fault is NOT that: the balance may
        // be fine, the hourly sweep retries it, and telling the office to
        // collect $75 that was never missing would be a false instruction
        // a later successful retry cannot retract.
        if (err?.code === 'INSUFFICIENT_CREDIT') {
          await alertReversalNeedsOffice(offer, scheduledServiceId, {
            reason: 'credit_already_spent',
            body: `A $${round2(offer.amount).toFixed(2)} inspection credit was applied to a booking that is now cancelled, but it has already been spent — the balance can't cover the reversal. Collect it on the next invoice or write it off.`,
          });
        }
      }
    }
    return { reversed };
  } catch (err) {
    logger.error(`[inspection-credit] reversal sweep FAILED for booking ${scheduledServiceId}: ${err.message}`);
    return { reversed: 0, reason: 'error', error: err.message };
  }
}

/**
 * Resend the paid receipt so it carries the frozen credit memo — for
 * inspections that settled BEFORE the offer existed: prepaid at booking
 * (closeout path) or the offer insert failed and recovery created it later
 * (PR #3178 r17 P2). First record only (callers gate on recorded:true);
 * already-paid, non-payer-billed invoices only; sendReceiptEmail's
 * idempotency key makes replays safe. Fire-and-forget by contract — a
 * completion or sweep never waits on an email.
 */
function queueCreditReceiptResend({ scheduledServiceId, offerId, attempt = 0 }) {
  if (!scheduledServiceId || !offerId) return;
  setImmediate(() => {
    void (async () => {
      // ONE office alert per offer, whatever undeliverable shape the visit
      // takes (no channel at all, or a paid-receipt resend that failed
      // deterministically). Dedupes on the durable notification row —
      // notifyAdmin has no dedupe of its own; a concurrent-replay race can
      // at worst double an office note, never touch money or a customer.
      const alertOfficeOnce = async (reason, body) => {
        const offer = await db('inspection_credit_offers')
          .where({ id: offerId })
          .first('customer_id', 'amount', 'expires_at');
        if (!offer) return;
        const alreadyAlerted = await db('notifications')
          .where({ recipient_type: 'admin' })
          .whereRaw("metadata->>'reason' IN ('no_receipt_channel', 'receipt_resend_failed')")
          .whereRaw("metadata->>'offerId' = ?", [String(offerId)])
          .first('id');
        if (alreadyAlerted) return;
        const memo = inspectionCreditReceiptMemo({
          amount: offer.amount, expiresAt: offer.expires_at,
        });
        await require('./notification-service').notifyAdmin(
          'billing',
          'Inspection credit terms were not delivered',
          `${memo || 'An inspection credit was recorded.'} ${body}`,
          {
            link: offer.customer_id ? `/admin/customers/${offer.customer_id}` : '/admin/invoices',
            metadata: { offerId, scheduledServiceId, reason },
          },
        );
      };
      try {
        const paidInvoice = await db('invoices')
          .where({ scheduled_service_id: scheduledServiceId, status: 'paid' })
          .whereNull('payer_id')
          .orderBy('created_at', 'desc')
          .first('id');
        if (!paidInvoice) {
          // A comped / no-invoice / payer-billed inspection has NO receipt
          // to carry the terms, and the repo has no customer-facing credit
          // surface — so this customer would hold a promise they were never
          // told about, and watch it lapse (Codex #3178 r22 P2). The credit
          // stands; the office is told once so a human can pass on the
          // deadline. Deliberately NOT an automated customer send: new
          // customer-facing comms are the owner's call, and which channel
          // should carry these terms is a copy decision (flagged on the PR).
          // A LIVE unpaid customer invoice will carry the memo on its own
          // receipt when it settles — the memo lookup reads the offer at
          // render time, on BOTH the email leg and the tokenized receipt
          // page the SMS leg links to (r28 P2: an email-less customer sees
          // the deadline on the page). Alerting here would page billing for
          // every ordinary pay-after-service inspection (Codex #3178 r24
          // P2). Only a visit with NO deliverable customer invoice at all
          // (comped / never-invoiced / payer-billed-only) has no written
          // channel and needs a human.
          const { CANCELLED_SERVICE_RESOLVED_STATUSES } = require('./invoice');
          // 'prepaid' can never settle into a receipt (Codex #3178 r29
          // P2): a completion invoice fully covered by account credit is
          // flipped to prepaid by sendViaSMSAndEmail's covered_by_credit
          // path with NO email or SMS receipt link, and sendReceiptEmail
          // refuses non-paid invoices — treating it as a deliverable
          // channel suppressed the alert while the customer got no written
          // deadline at all.
          const liveInvoice = await db('invoices')
            .where({ scheduled_service_id: scheduledServiceId })
            .whereNull('payer_id')
            .whereNotIn('status', [...CANCELLED_SERVICE_RESOLVED_STATUSES, 'prepaid'])
            .first('id');
          if (liveInvoice) return;
          // This helper is queued via setImmediate from the closeout path,
          // which can run BEFORE the completion handler mints the ordinary
          // pay-after-service invoice (Codex #3178 r27 P2) — deciding "no
          // channel" now would page billing for a normal visit whose
          // invoice lands moments later. Recheck once after the handler
          // has long finished; only a visit STILL without a deliverable
          // invoice escalates. unref'd so it never pins the process.
          if (attempt < 1) {
            const recheck = setTimeout(() => {
              queueCreditReceiptResend({ scheduledServiceId, offerId, attempt: attempt + 1 });
            }, 120000);
            if (typeof recheck.unref === 'function') recheck.unref();
            return;
          }
          await alertOfficeOnce('no_receipt_channel',
            'This visit has no paid customer invoice, so the terms were not delivered — tell the customer their deadline.');
          return;
        }
        const { sendReceiptEmail } = require('./invoice-email');
        const sent = await sendReceiptEmail(paidInvoice.id, {
          idempotencyKey: `inspection-credit-offer-${offerId}`,
        });
        // A deterministic miss — no receipt recipient email, suppressed
        // send, template + fallback both unavailable — returns { ok:false }
        // without throwing (Codex #3178 r25 P2). The original receipt went
        // out BEFORE the offer existed, so this resend carries the only
        // written deadline; a silent miss strands the promise. Idempotent
        // replays return ok:true (deduped), so this never false-alerts.
        if (!sent?.ok) {
          logger.warn(`[inspection-credit] credit receipt resend not delivered for ${scheduledServiceId}: ${sent?.error || 'unknown'}`);
          await alertOfficeOnce('receipt_resend_failed',
            `The paid receipt carrying these terms could not be re-sent (${sent?.error || 'send failed'}) — tell the customer their deadline.`);
        }
      } catch (resendErr) {
        logger.warn(`[inspection-credit] credit receipt resend failed for ${scheduledServiceId}: ${resendErr.message}`);
      }
    })();
  });
}

/**
 * Receipt copy for a recorded offer — the exact promise the customer is
 * being shown. Returns null when there is nothing to say, so callers can
 * spread it into an optional memo slot.
 */
function inspectionCreditReceiptMemo({ amount, expiresAt } = {}) {
  const amt = round2(amount);
  if (!(amt > 0)) return null;
  const when = expiresAt ? new Date(expiresAt) : null;
  if (!when || Number.isNaN(when.getTime())) return null;
  // The FROZEN expiry date, not a wall-clock day count — a resend must not
  // reword the promise, and the customer gets an unambiguous deadline.
  //
  // `expires_at` is the EXCLUSIVE boundary: ET midnight that OPENS the day
  // after the window (etEndOfDayAfterDays). Formatting it directly told the
  // customer to "book by September 3" when a September 3 booking fails the
  // redemption guard — the last bookable day is September 2 (Codex #3178
  // r22 P1). Step back one second to land inside the final valid day.
  const lastBookable = new Date(when.getTime() - 1000);
  const date = lastBookable.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York',
  });
  // "service credit", never "your inspection fee" (Codex #3175 r3 P1): the
  // credit is FLAT by ruling, so on a comped or $125 inspection calling it
  // the fee paid would misstate the transaction.
  return `You have a $${amt.toFixed(2)} service credit from your inspection — it applies to any service you book by ${date}.`;
}

module.exports = {
  etDateOnlyToDate,
  etEndOfDayAfterDays,
  markBookingForInspectionCredit,
  recordInspectionCreditOffer,
  reverseInspectionCreditForBooking,
  sweepInspectionCreditRedemptions,
  configuredCreditAmount,
  configuredCreditAmountForServiceKey,
  isCreditableInspectionProfile,
  carriesStandingCreditPromise,
  redeemInspectionCreditForBooking,
  inspectionCreditReceiptMemo,
  queueCreditReceiptResend,
  creditWindowDaysForServiceKey,
  DEFAULT_CREDIT_WINDOW_DAYS,
  NON_LIVE_APPOINTMENT_STATUSES,
};

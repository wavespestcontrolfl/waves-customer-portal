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
 * A date-only value (YYYY-MM-DD) as an ET wall-clock instant.
 *
 * `new Date('2026-08-03')` anchors at UTC midnight, which in Eastern time is
 * the PREVIOUS calendar day — that would shift a credit window a day early
 * (Codex #3178 P1). Noon ET is chosen so neither DST edge can cross a day
 * boundary. Non-date-only values pass through unchanged.
 */
function etDateOnlyToDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
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
  const target = new Date(base.getTime() + Number(days) * 24 * 60 * 60 * 1000);
  const etDate = target.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  // The exclusive end is ET midnight of the FOLLOWING day. ET is UTC-4 or
  // UTC-5 depending on DST, so try both and keep whichever actually reads
  // as 00:00 in New York — hardcoding either offset lands an hour early or
  // an hour late half the year.
  const dayAfter = new Date(`${etDate}T12:00:00Z`);
  dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
  const nextEtDate = dayAfter.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  // Identify midnight by DATE BOUNDARY, not by formatting the hour: with
  // hour12:false some ICU builds render midnight as "24:00", so a
  // string check for "00:00" silently fell through to the fallback on CI
  // and expired the promise an hour into the named day.
  const etDayOf = (d) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  for (const offset of ['04:00:00', '05:00:00']) {
    const candidate = new Date(`${nextEtDate}T${offset}Z`);
    // Midnight is the first instant of nextEtDate: the instant itself is
    // on that day, and one second earlier is still the previous day.
    if (etDayOf(candidate) === nextEtDate
      && etDayOf(new Date(candidate.getTime() - 1000)) === etDate) {
      return candidate;
    }
  }
  return new Date(`${nextEtDate}T05:00:00Z`);
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
  createdBy = 'system:inspection_closeout',
  now = new Date(),
}) {
  if (!gateOn()) return { recorded: false, reason: 'feature_disabled' };
  if (!customerId || !scheduledServiceId) {
    return { recorded: false, reason: 'missing_identifiers' };
  }
  const frozenAmount = amount != null ? round2(amount) : configuredCreditAmount();
  if (!(frozenAmount > 0)) {
    // Only reachable if the configured amount is misconfigured to 0 — a
    // zero credit is not a promise worth recording.
    return { recorded: false, reason: 'no_credit_amount' };
  }

  const windowDays = creditWindowDaysForServiceKey(serviceKey);
  // END OF THE ET DAY, not now + N×24h (Codex #3178 r2 P0): the receipt
  // prints a calendar deadline ("book by September 2"), so a booking made
  // that afternoon must still qualify. Fixed 24-hour periods from a
  // 16:00Z anchor would have rejected it.
  const expiresAt = etEndOfDayAfterDays(now, windowDays);

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
 * Mark open offers as "this booking is the qualifying one", INSIDE the
 * caller's booking transaction (Codex #3178 P1).
 *
 * Durability matters here: a post-commit marker write can be lost to a
 * crash between the booking commit and the write, leaving a real booking
 * that the sweep can never recover. Written in-transaction, the marker
 * commits with the booking or not at all — and the hourly sweep turns it
 * into money, so the mint itself never has to succeed inline.
 *
 * Safe to call from any booking surface; it only touches offers already
 * open and in-window, and never throws.
 */
async function markBookingForInspectionCredit(trx, { customerId, scheduledServiceId, bookingCreatedAt = new Date() }) {
  if (!gateOn()) return 0;
  if (!customerId || !scheduledServiceId || !trx) return 0;
  try {
    return await trx('inspection_credit_offers')
      .where({ customer_id: customerId, status: 'offered' })
      .whereNull('redeemed_scheduled_service_id')
      .where('created_at', '<=', bookingCreatedAt)
      .where('expires_at', '>=', bookingCreatedAt)
      .whereNot({ source_scheduled_service_id: scheduledServiceId })
      .update({ redeemed_scheduled_service_id: scheduledServiceId, updated_at: trx.fn.now() });
  } catch (err) {
    logger.warn(`[inspection-credit] booking marker failed for ${scheduledServiceId}: ${err.message}`);
    return 0;
  }
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
        .where({ id: offerId, status: 'offered' })
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
  bookingCreatedAt = null,
  createdBy = 'system:inspection_credit_rebook',
  now = new Date(),
}) {
  if (!gateOn()) return { redeemed: 0, reason: 'feature_disabled' };
  if (!customerId || !scheduledServiceId) return { redeemed: 0, reason: 'missing_identifiers' };
  if (bookingStatus && NON_LIVE_APPOINTMENT_STATUSES.includes(String(bookingStatus).toLowerCase())) {
    return { redeemed: 0, reason: 'booking_not_live' };
  }
  const bookedAt = bookingCreatedAt ? new Date(bookingCreatedAt) : now;

  try {
    const open = await db('inspection_credit_offers')
      .where({ customer_id: customerId, status: 'offered' })
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
      // Record the ATTEMPT before minting. The sweep retries only offers
      // carrying this marker (Codex #3175 r3 P0): a credit must follow a
      // real customer booking, and scheduled_services rows are also created
      // by seeders, bulk rebooks and imports that nobody "booked".
      try {
        await db('inspection_credit_offers')
          .where({ id: offer.id, status: 'offered' })
          .update({ redeemed_scheduled_service_id: scheduledServiceId, updated_at: db.fn.now() });
      } catch (markErr) {
        logger.warn(`[inspection-credit] attempt marker failed for offer ${offer.id}: ${markErr.message}`);
      }
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
  if (!gateOn()) return { redeemed: 0, expired: 0, reason: 'feature_disabled' };
  let redeemed = 0;
  let expired = 0;
  let reversed = 0;
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
    const stale = await db('inspection_credit_offers as o')
      .join('scheduled_services as s', 's.id', 'o.redeemed_scheduled_service_id')
      .where('o.status', 'redeemed')
      .whereIn('s.status', NON_LIVE_APPOINTMENT_STATUSES)
      .limit(limit)
      .select('o.id as id', 'o.redeemed_scheduled_service_id as booking_id');
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
    try {
      const missing = await db('service_records as r')
        .join('scheduled_services as s', 's.id', 'r.scheduled_service_id')
        .leftJoin('inspection_credit_offers as o', 'o.source_scheduled_service_id', 's.id')
        .whereRaw("(r.service_data->>'inspectionCreditOptIn') = 'true'")
        .whereNull('o.id')
        .limit(limit)
        .select('s.id as id', 's.customer_id as customer_id', 's.service_id as service_id',
          'r.id as record_id', 'r.service_date as service_date');
      for (const visit of missing) {
        let serviceKey = null;
        try {
          const svcRow = await db('services').where({ id: visit.service_id }).first('service_key');
          serviceKey = svcRow?.service_key || null;
        } catch { serviceKey = null; }
        // Frozen from the SERVICE DATE — the customer's window started when
        // the inspection happened, not when recovery ran.
        const created = await recordInspectionCreditOffer({
          customerId: visit.customer_id,
          scheduledServiceId: visit.id,
          serviceRecordId: visit.record_id,
          serviceKey,
          createdBy: 'system:inspection_credit_recovery',
          // ET wall-clock: a date-only service_date parsed as UTC midnight
          // lands on the previous ET day and shifts the window early.
          now: etDateOnlyToDate(visit.service_date) || now,
        });
        // The offer arrived LATE, so a qualifying booking may already have
        // happened while it was missing (Codex #3178 r3 P1). Adopt the
        // earliest PROVEN booking inside the window — proven meaning
        // another offer's marker points at it, the same evidence standard
        // redemption uses; a bare scheduled_services row could be a seeder.
        if (created?.recorded && created.offerId) {
          try {
            const priorBooking = await db('inspection_credit_offers as o2')
              .join('scheduled_services as s2', 's2.id', 'o2.redeemed_scheduled_service_id')
              .where('o2.customer_id', visit.customer_id)
              .whereNotIn('s2.status', NON_LIVE_APPOINTMENT_STATUSES)
              .where('s2.created_at', '>=', created.expiresAt ? new Date(created.expiresAt.getTime() - windowMs(created.windowDays)) : now)
              .where('s2.created_at', '<=', created.expiresAt || now)
              .whereNot('s2.id', visit.id)
              .orderBy('s2.created_at', 'asc')
              .first('s2.id as id');
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

    // ONLY offers where a real booking surface already attempted redemption
    // and the mint didn't land (Codex #3175 r3 P0). Inferring a booking from
    // "a scheduled_services row appeared" credited seeded series children,
    // bulk rebooks and imports — money for something nobody booked.
    const open = await db('inspection_credit_offers')
      .where({ status: 'offered' })
      .whereNotNull('redeemed_scheduled_service_id')
      .orderBy('created_at', 'asc')
      .limit(limit)
      .select('id', 'customer_id', 'amount', 'created_at', 'expires_at',
        'source_scheduled_service_id', 'redeemed_scheduled_service_id');

    for (const offer of open) {
      try {
        // A live booking made inside THIS offer's window, and not the
        // inspection itself. Re-derived from persisted state, so it holds
        // for every booking surface.
        // The booking that was actually attempted — still live, still
        // inside this offer's window.
        const booking = await db('scheduled_services')
          .where({ id: offer.redeemed_scheduled_service_id })
          .whereNotIn('status', NON_LIVE_APPOINTMENT_STATUSES)
          .where('created_at', '>=', offer.created_at)
          .where('created_at', '<=', offer.expires_at)
          .first('id', 'created_at');

        if (booking) {
          // Redeem THIS offer only — never a customer-wide sweep, which
          // would mint offers no booking followed.
          const ok = await redeemSpecificOffer({
            offerId: offer.id,
            customerId: offer.customer_id,
            amount: offer.amount,
            bookingId: booking.id,
            bookingCreatedAt: booking.created_at,
            createdBy: 'system:inspection_credit_sweep',
            now,
          });
          if (ok) redeemed += 1;
          continue;
        }

        // No qualifying booking: expire only once the window has genuinely
        // passed. Status-guarded so it can't stomp a concurrent redemption.
        if (new Date(offer.expires_at) < now) {
          const closed = await db('inspection_credit_offers')
            .where({ id: offer.id, status: 'offered' })
            .update({ status: 'expired', updated_at: db.fn.now() });
          expired += Number(closed) || 0;
        }
      } catch (err) {
        // One bad offer must not stop the sweep — it retries next run.
        logger.error(`[inspection-credit] sweep failed for offer ${offer.id}: ${err.message}`);
      }
    }
    if (redeemed || expired || reversed) {
      logger.info(`[inspection-credit] sweep: ${redeemed} redeemed, ${reversed} reversed, ${expired} expired`);
    }
    return { redeemed, expired, reversed };
  } catch (err) {
    logger.error(`[inspection-credit] sweep FAILED: ${err.message}`);
    return { redeemed, expired, reversed, reason: 'error', error: err.message };
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
        // The credit was earned by BOOKING inside the window. If another
        // live booking still stands in that window, the customer is still
        // entitled to it — rebind rather than claw it back (Codex #3178
        // P1): cancelling one of two bookings must not cost them the credit.
        // A PROVEN customer booking only (Codex #3178 r3 P1): another
        // offer for this customer whose marker points at a live visit is
        // evidence a booking surface ran. Any live scheduled_services row
        // would have counted seeded series children and bulk rebooks.
        const alternate = await db('inspection_credit_offers as o2')
          .join('scheduled_services as s2', 's2.id', 'o2.redeemed_scheduled_service_id')
          .where('o2.customer_id', offer.customer_id)
          .whereNotIn('s2.status', NON_LIVE_APPOINTMENT_STATUSES)
          .where('s2.created_at', '>=', offer.created_at)
          .where('s2.created_at', '<=', offer.expires_at)
          .whereNot('s2.id', scheduledServiceId)
          .whereNot('s2.id', offer.source_scheduled_service_id || '00000000-0000-0000-0000-000000000000')
          .orderBy('s2.created_at', 'asc')
          .first('s2.id as id');
        if (alternate) {
          await db('inspection_credit_offers')
            .where({ id: offer.id, status: 'redeemed' })
            .update({ redeemed_scheduled_service_id: alternate.id, updated_at: db.fn.now() });
          logger.info(`[inspection-credit] offer ${offer.id} rebound to live booking ${alternate.id} instead of reversing`);
          continue;
        }
        await db.transaction(async (trx) => {
          // Claim the reversal first: status-guarded so two cancellations
          // can't both give the money back.
          const claimed = await trx('inspection_credit_offers')
            .where({ id: offer.id, status: 'redeemed' })
            .update({
              // Reopens ONLY while the original window still stands; a
              // lapsed one closes out instead of dangling.
              status: new Date(offer.expires_at) >= now ? 'offered' : 'expired',
              redeemed_at: null,
              redeemed_scheduled_service_id: null,
              credit_ledger_id: null,
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
        // The credit is fungible: once spent on an invoice the balance can
        // be below the reversal amount, and postCreditMovement refuses to
        // go negative. That money cannot be clawed back automatically, so
        // it becomes an OFFICE decision (collect or write off) rather than
        // a log line nobody reads — the same posture as every other
        // unreversible money event in this codebase (Codex #3175 r4 P0).
        logger.error(`[inspection-credit] reversal FAILED for offer ${offer.id}: ${err.message}`);
        // Alert ONCE, but only once one actually LANDED (Codex #3178 r2
        // P1): notifyAdmin returns null rather than throwing when its
        // insert fails, so marking first would suppress the alert forever
        // on a transient failure. Marker follows confirmed delivery.
        try {
          const already = await db('inspection_credit_offers')
            .where({ id: offer.id })
            .whereNotNull('reversal_alerted_at')
            .first('id');
          if (already) continue;
          const notified = await require('./notification-service').notifyAdmin(
            'billing',
            'Inspection credit could not be reversed',
            `A $${round2(offer.amount).toFixed(2)} inspection credit was applied to a booking that is now cancelled, but it has already been spent — the balance can't cover the reversal. Collect it on the next invoice or write it off.`,
            {
              link: offer.customer_id ? `/admin/customers/${offer.customer_id}` : '/admin/invoices',
              metadata: { offerId: offer.id, scheduledServiceId, reason: 'credit_already_spent' },
            },
          );
          if (notified) {
            await db('inspection_credit_offers')
              .where({ id: offer.id })
              .update({ reversal_alerted_at: new Date(), updated_at: db.fn.now() });
          } else {
            logger.warn(`[inspection-credit] spent-credit alert not delivered for offer ${offer.id} — will retry next sweep`);
          }
        } catch (notifyErr) {
          logger.error(`[inspection-credit] reversal alert failed for offer ${offer.id}: ${notifyErr.message}`);
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
  const date = when.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York',
  });
  // "service credit", never "your inspection fee" (Codex #3175 r3 P1): the
  // credit is FLAT by ruling, so on a comped or $125 inspection calling it
  // the fee paid would misstate the transaction.
  return `You have a $${amt.toFixed(2)} service credit from your inspection — it applies to any service you book by ${date}.`;
}

module.exports = {
  etDateOnlyToDate,
  markBookingForInspectionCredit,
  recordInspectionCreditOffer,
  reverseInspectionCreditForBooking,
  sweepInspectionCreditRedemptions,
  configuredCreditAmount,
  redeemInspectionCreditForBooking,
  inspectionCreditReceiptMemo,
  creditWindowDaysForServiceKey,
  DEFAULT_CREDIT_WINDOW_DAYS,
  NON_LIVE_APPOINTMENT_STATUSES,
};

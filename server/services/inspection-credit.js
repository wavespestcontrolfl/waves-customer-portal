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
const NON_LIVE_APPOINTMENT_STATUSES = Object.freeze([
  'cancelled', 'canceled', 'rescheduled', 'skipped', 'no_show',
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
  const expiresAt = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);

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
async function redeemInspectionCreditForBooking({
  customerId,
  scheduledServiceId,
  bookingStatus = null,
  createdBy = 'system:inspection_credit_rebook',
  now = new Date(),
}) {
  if (!gateOn()) return { redeemed: 0, reason: 'feature_disabled' };
  if (!customerId || !scheduledServiceId) return { redeemed: 0, reason: 'missing_identifiers' };
  // A booking that is already cancelled/no-showed is not the service the
  // credit was promised toward.
  if (bookingStatus && NON_LIVE_APPOINTMENT_STATUSES.includes(String(bookingStatus).toLowerCase())) {
    return { redeemed: 0, reason: 'booking_not_live' };
  }

  try {
    const open = await db('inspection_credit_offers')
      .where({ customer_id: customerId, status: 'offered' })
      .where('expires_at', '>=', now)
      // The inspection itself must not redeem its own offer.
      .whereNot({ source_scheduled_service_id: scheduledServiceId })
      .orderBy('expires_at', 'asc')
      .select('id', 'amount', 'expires_at');
    if (!open.length) return { redeemed: 0, reason: 'no_open_offer' };

    let redeemed = 0;
    let total = 0;
    for (const offer of open) {
      try {
        await db.transaction(async (trx) => {
          // Status-guarded claim: the row moves out of 'offered' before any
          // money posts, so a concurrent booking finds nothing to claim.
          // Re-check expiry in the claim so a boundary-crossing race can't
          // redeem a just-lapsed offer.
          const claimed = await trx('inspection_credit_offers')
            .where({ id: offer.id, status: 'offered' })
            .where('expires_at', '>=', now)
            .update({
              status: 'redeemed',
              redeemed_at: now,
              redeemed_scheduled_service_id: scheduledServiceId,
              updated_at: trx.fn.now(),
            });
          if (claimed !== 1) {
            const e = new Error('offer claim lost a race');
            e.inspectionCreditSkip = 'claim_lost';
            throw e;
          }
          const { entry } = await postCreditMovement({
            customerId,
            delta: round2(offer.amount),
            source: 'inspection_credit',
            note: 'Inspection fee credited toward booked service',
            createdBy,
          }, trx);
          // Bind the mint to the offer — the UNIQUE credit_ledger_id is the
          // durable exactly-once proof.
          await trx('inspection_credit_offers')
            .where({ id: offer.id })
            .update({ credit_ledger_id: entry.id, updated_at: trx.fn.now() });
        });
        redeemed += 1;
        total = round2(total + round2(offer.amount));
        logger.info(`[inspection-credit] offer ${offer.id} redeemed on booking ${scheduledServiceId}`);
      } catch (err) {
        if (err?.inspectionCreditSkip === 'claim_lost') continue;
        logger.error(`[inspection-credit] redemption FAILED for offer ${offer.id}: ${err.message}`);
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
  try {
    // Lapsed offers: terminal, and never redeemable again.
    expired = await db('inspection_credit_offers')
      .where({ status: 'offered' })
      .where('expires_at', '<', now)
      .update({ status: 'expired', updated_at: db.fn.now() });

    const open = await db('inspection_credit_offers')
      .where({ status: 'offered' })
      .where('expires_at', '>=', now)
      .orderBy('created_at', 'asc')
      .limit(limit)
      .select('id', 'customer_id', 'created_at', 'source_scheduled_service_id');

    for (const offer of open) {
      try {
        // A live booking made AFTER the promise, and not the inspection
        // itself — the same test the at-booking path applies, re-derived
        // from persisted state so it holds for every booking surface.
        const booking = await db('scheduled_services')
          .where({ customer_id: offer.customer_id })
          .whereNotIn('status', NON_LIVE_APPOINTMENT_STATUSES)
          .where('created_at', '>=', offer.created_at)
          .whereNot({ id: offer.source_scheduled_service_id || '00000000-0000-0000-0000-000000000000' })
          .orderBy('created_at', 'asc')
          .first('id');
        if (!booking) continue;
        const res = await redeemInspectionCreditForBooking({
          customerId: offer.customer_id,
          scheduledServiceId: booking.id,
          createdBy: 'system:inspection_credit_sweep',
          now,
        });
        redeemed += Number(res?.redeemed) || 0;
      } catch (err) {
        // One bad offer must not stop the sweep — it retries next run.
        logger.error(`[inspection-credit] sweep failed for offer ${offer.id}: ${err.message}`);
      }
    }
    if (redeemed || expired) {
      logger.info(`[inspection-credit] sweep: ${redeemed} redeemed, ${expired} expired`);
    }
    return { redeemed, expired };
  } catch (err) {
    logger.error(`[inspection-credit] sweep FAILED: ${err.message}`);
    return { redeemed, expired, reason: 'error', error: err.message };
  }
}

/**
 * Receipt copy for a recorded offer — the exact promise the customer is
 * being shown. Returns null when there is nothing to say, so callers can
 * spread it into an optional memo slot.
 */
function inspectionCreditReceiptMemo({ amount, windowDays } = {}) {
  const amt = round2(amount);
  if (!(amt > 0)) return null;
  const days = Number(windowDays) > 0 ? Math.round(windowDays) : DEFAULT_CREDIT_WINDOW_DAYS;
  return `Your $${amt.toFixed(2)} inspection fee is credited toward any service you book within ${days} days.`;
}

module.exports = {
  recordInspectionCreditOffer,
  sweepInspectionCreditRedemptions,
  configuredCreditAmount,
  redeemInspectionCreditForBooking,
  inspectionCreditReceiptMemo,
  creditWindowDaysForServiceKey,
  DEFAULT_CREDIT_WINDOW_DAYS,
  NON_LIVE_APPOINTMENT_STATUSES,
};

/**
 * Booking-triggered estimate pre-drafts (GATE_ESTIMATOR_BOOKING_PREDRAFTS,
 * default OFF; also requires GATE_ESTIMATOR_ENGINE — one kill switch for the
 * whole engine family).
 *
 * When a Waves Assessment booking is created — the internal-only catch-all
 * consultation booked when the concrete service is still unknown — pre-draft
 * an estimate so the owner walks into the assessment with the context
 * already assembled: after the visit he prices an existing draft instead of
 * building one from scratch.
 *
 * THIS SERVICE NEVER SENDS ANYTHING. The draft is the terminal artifact,
 * sitting in the estimates queue. Two paths:
 *
 *  - Call-booked assessments (source_call_log_id set): delegate to the
 *    estimator engine's full call pipeline (maybeDraftEstimateForCall) —
 *    transcript + property signals + pricing lanes, INCLUDING the engine's
 *    standard call-lane bells (created/red/blocked). That is deliberate:
 *    per the owner's exception-based rule, an engine red lane on a call we
 *    now owe a quote for IS an exception and must surface; the engine's
 *    callSid bell dedupe absorbs re-bells for calls that already ran. The
 *    engine's per-call dedupe likewise absorbs re-entry when the
 *    quote-promised lane already drafted at call-processing time.
 *    quotePromised is asserted because an assessment booking IS a
 *    commitment to come back with a quote.
 *
 *  - Every other assessment booking (admin manual, leads-page): an unpriced
 *    shell draft, created QUIETLY (no bell — green work appears in the
 *    queue) — source 'booking_assessment', price fields untouched (NULL,
 *    never 0 — the $0-fallback trap), booking context stamped into
 *    estimate_data. estimates.notes is CUSTOMER-VISIBLE and stays NULL.
 *
 * Idempotent per booking (estimate_data recheck under the phone lock — the
 * admin regenerate-brief endpoint replays the tagger hook), deduped per
 * phone via the shared automated-estimate guards, and fail-soft everywhere:
 * a pre-draft failure must never break booking, tagging, or call
 * processing.
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');

// The catch-all assessment is the catalog services row service_key
// 'lawn_inspection' (renamed "Waves Assessment" by migration
// 20260619000002); bookings denormalize the name into service_type. Match
// either — legacy rows can carry the name without the FK.
const ASSESSMENT_NAME_RE = /^waves assessment$/i;
const ASSESSMENT_SERVICE_KEY = 'lawn_inspection';

// Terminal booking states — a booking already dead by the time the
// detached hook runs must not seed a draft.
const TERMINAL_BOOKING_STATUSES = new Set(['completed', 'cancelled', 'rescheduled', 'skipped', 'no_show']);

function bookingPreDraftsEnabled() {
  const flag = String(process.env.GATE_ESTIMATOR_BOOKING_PREDRAFTS || '').toLowerCase();
  if (!['1', 'true', 'on'].includes(flag)) return false;
  const { estimatorEngineEnabled } = require('./index');
  return estimatorEngineEnabled();
}

async function isAssessmentBooking(booking) {
  if (ASSESSMENT_NAME_RE.test(String(booking.service_type || '').trim())) return true;
  if (!booking.service_id) return false;
  const serviceRow = await db('services').where({ id: booking.service_id }).first();
  if (!serviceRow) return false;
  return serviceRow.service_key === ASSESSMENT_SERVICE_KEY
    || ASSESSMENT_NAME_RE.test(String(serviceRow.name || '').trim());
}

// Merge the booking linkage into an engine-created draft's estimate_data.
// ONE atomic jsonb_set guarded by a missing-key predicate: a
// read-modify-write of the whole blob could overwrite a concurrent admin
// revision's estimate_data with a stale snapshot (quote data loss). An
// existing linkage (the call pipeline stitches this key when one call
// produced both rows) wins via the predicate. Fail-soft.
async function linkEstimateToBooking(estimateId, scheduledServiceId) {
  try {
    await db('estimates')
      .where({ id: estimateId })
      .whereRaw("(estimate_data ->> 'scheduled_service_id') is null")
      .update({
        estimate_data: db.raw(
          "jsonb_set(coalesce(estimate_data, '{}'::jsonb), '{scheduled_service_id}', to_jsonb(?::text))",
          [String(scheduledServiceId)],
        ),
      });
  } catch (err) {
    logger.warn(`[booking-predraft] booking linkage merge failed for estimate ${estimateId}: ${err.message}`);
  }
}

async function maybePreDraftForBooking(scheduledServiceId) {
  try {
    if (!bookingPreDraftsEnabled()) return { drafted: false, skipped: 'gate_off' };
    if (!scheduledServiceId) return { drafted: false, skipped: 'no_booking_id' };

    const booking = await db('scheduled_services').where({ id: scheduledServiceId }).first();
    if (!booking) return { drafted: false, skipped: 'booking_not_found' };
    if (TERMINAL_BOOKING_STATUSES.has(String(booking.status || ''))) {
      return { drafted: false, skipped: 'booking_terminal' };
    }
    if (!(await isAssessmentBooking(booking))) return { drafted: false, skipped: 'not_assessment' };
    if (booking.source_estimate_id) {
      // Born FROM an estimate — the quote already exists.
      return { drafted: false, skipped: 'estimate_born' };
    }

    if (booking.source_call_log_id) {
      // Full engine context exists — transcript, extraction, property
      // pipeline. Its per-call/per-phone dedupe makes re-entry safe.
      // Authoritative re-read at the last moment before the (minutes-long)
      // composer run: this hook can start well after the initial status
      // read (the call processor sequences it behind the quote lane's
      // engine promise), and a booking that died meanwhile must not start
      // a delegation run at all.
      const freshBooking = await db('scheduled_services').where({ id: booking.id }).first();
      if (!freshBooking || TERMINAL_BOOKING_STATUSES.has(String(freshBooking.status || ''))) {
        return { drafted: false, skipped: 'booking_terminal' };
      }
      if (freshBooking.source_estimate_id) return { drafted: false, skipped: 'estimate_born' };

      const { maybeDraftEstimateForCall } = require('./index');
      const outcome = await maybeDraftEstimateForCall({
        callLogId: booking.source_call_log_id,
        quotePromised: true,
      });
      if (outcome?.estimateId) {
        // The engine stamps its call linkage but not the booking's — merge
        // scheduled_service_id so the draft gets the exact schedule badge
        // and the booking-link collision guard sees it (existing linkage,
        // e.g. call-pipeline stitching, is never clobbered). The visit can
        // also die DURING the composer run: re-check before stitching so a
        // dead visit is never linked. The draft itself deliberately stands
        // either way — the quote was promised on the CALL, and cancelling
        // the visit does not cancel the caller's pricing request; only the
        // booking linkage (schedule badge + per-booking idempotency key)
        // must not point at a dead row.
        const postRun = await db('scheduled_services').where({ id: booking.id }).first();
        const postRunDead = !postRun || TERMINAL_BOOKING_STATUSES.has(String(postRun.status || ''));
        if (!postRunDead) {
          await linkEstimateToBooking(outcome.estimateId, booking.id);
        } else {
          logger.info('[booking-predraft] booking went terminal during engine run — draft kept, linkage skipped', {
            scheduledServiceId: booking.id,
            estimateId: outcome.estimateId,
          });
        }
      }
      return {
        drafted: outcome?.created === true,
        delegated: 'call_engine',
        lane: outcome?.lane,
        estimateId: outcome?.estimateId,
      };
    }

    const customer = booking.customer_id
      ? await db('customers').where({ id: booking.customer_id }).first()
      : null;
    if (!customer) return { drafted: false, skipped: 'no_customer' };

    const {
      withAutomatedEstimatePhoneLock,
      blockIfAutomatedEstimateDuplicate,
    } = require('../estimate-automation-duplicates');

    const customerName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'Customer';
    const address = booking.service_address_line1
      ? [booking.service_address_line1, booking.service_address_city].filter(Boolean).join(', ')
      : (customer.address_line1 || '');
    // Assessments are often booked days out — the draft must outlive the
    // visit it exists to accelerate. scheduled_date is an ET business date;
    // a naive new Date('YYYY-MM-DD') reads as UTC midnight (prior ET
    // evening, drifting across DST), so derive the instant as ET noon via
    // the shared helper. Knex may hand the column back as a string or a
    // Date — normalize to the date string first.
    const { parseETDateTime } = require('../../utils/datetime-et');
    let expiryBase = new Date();
    if (booking.scheduled_date) {
      const dateStr = booking.scheduled_date instanceof Date
        ? booking.scheduled_date.toISOString().slice(0, 10)
        : String(booking.scheduled_date).slice(0, 10);
      const parsed = /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
        ? parseETDateTime(`${dateStr}T12:00`)
        : null;
      if (parsed && !Number.isNaN(parsed.getTime())) expiryBase = parsed;
    }
    const expiresAt = new Date(
      Math.max(expiryBase.getTime(), Date.now()) + 14 * 86400000,
    );

    // withAutomatedEstimatePhoneLock degrades to a bare (unserialized)
    // callback when the customer has no usable phone — concurrent hook
    // replays could then both pass the idempotency probe. Email-only
    // customers are real (the leads flow supports them), so fall back to a
    // per-booking advisory transaction lock, analogous to the engine's
    // call-id fallback.
    const hasUsablePhone = String(customer.phone || '').replace(/\D/g, '').length >= 10;
    const runUnderLock = hasUsablePhone
      ? (cb) => withAutomatedEstimatePhoneLock(customer.phone, cb)
      : (cb) => db.transaction(async (trx) => {
        await trx.raw(
          'select pg_advisory_xact_lock(hashtext(?), hashtext(?))',
          ['booking_predraft', String(booking.id)],
        );
        return cb(trx);
      });

    const result = await runUnderLock(async (trx) => {
      // The pre-lock status read is stale by now if the booking was
      // cancelled/rescheduled (or became estimate-born) while this detached
      // worker waited on the lock — a draft must never seed off a dead
      // visit. The in-lock re-read is authoritative.
      const freshBooking = await trx('scheduled_services').where({ id: booking.id }).first();
      if (!freshBooking) return { drafted: false, skipped: 'booking_not_found' };
      if (TERMINAL_BOOKING_STATUSES.has(String(freshBooking.status || ''))) {
        return { drafted: false, skipped: 'booking_terminal' };
      }
      if (freshBooking.source_estimate_id) return { drafted: false, skipped: 'estimate_born' };

      // Per-booking idempotency: the tagger hook replays (admin
      // regenerate-brief), and the duplicate guard alone stops covering us
      // once the first draft closes. Keyed on the top-level
      // estimate_data.scheduled_service_id linkage — the SAME key the call
      // pipeline stitches when one call produces both an estimate and a
      // booking (so a call-drafted estimate for this booking also counts),
      // and one of the two keys reviseAdminEstimate PRESERVES across
      // wholesale estimate_data rewrites. A nested marker would be erased
      // by the first admin revision.
      const already = await trx('estimates')
        .whereRaw("estimate_data #>> '{scheduled_service_id}' = ?", [String(booking.id)])
        .first();
      if (already) return { drafted: false, skipped: 'already_drafted', estimateId: already.id };

      const duplicateBlock = await blockIfAutomatedEstimateDuplicate(customer.phone, { database: trx });
      if (duplicateBlock) {
        return {
          drafted: false,
          skipped: 'duplicate_open_estimate',
          estimateId: duplicateBlock.existingEstimateId,
        };
      }

      const [estimate] = await trx('estimates').insert({
        customer_id: customer.id,
        customer_name: customerName,
        customer_phone: customer.phone || null,
        customer_email: customer.email || null,
        address,
        status: 'draft',
        source: 'booking_assessment',
        service_interest: 'Waves Assessment',
        lead_source: customer.lead_source || null,
        lead_source_detail: customer.lead_source_detail || null,
        // Customer-visible bearer token — full 128-bit entropy, same as
        // the other creation paths (a name-derived slug is guessable and
        // can overflow varchar(64)).
        token: crypto.randomBytes(16).toString('hex'),
        expires_at: expiresAt,
        // Price fields deliberately untouched: NULL, never 0 (the
        // $0-fallback trap). The owner prices after the visit.
        // notes deliberately NULL — estimates.notes is CUSTOMER-VISIBLE.
        estimate_data: JSON.stringify({
          // Durable booking linkage (revision-preserved; also lights the
          // admin UI's exact-match "already on the schedule" flag).
          scheduled_service_id: booking.id,
          bookingPreDraft: {
            scheduledServiceId: booking.id,
            scheduledDate: booking.scheduled_date || null,
            serviceType: booking.service_type || null,
            bookingSource: booking.booking_source || booking.source || null,
            sourceAction: booking.source_action || null,
          },
        }),
      }).returning('*');
      return { drafted: true, estimateId: estimate.id };
    });

    if (result.drafted) {
      logger.info('[booking-predraft] assessment pre-draft created', {
        scheduledServiceId: booking.id,
        estimateId: result.estimateId,
      });
    }
    return result;
  } catch (err) {
    logger.warn(`[booking-predraft] pre-draft failed for booking ${scheduledServiceId}: ${err.message}`);
    return { drafted: false, skipped: 'error' };
  }
}

module.exports = {
  bookingPreDraftsEnabled,
  maybePreDraftForBooking,
  _private: { isAssessmentBooking, TERMINAL_BOOKING_STATUSES },
};

/**
 * Slot reservation — the customer-facing inline-accept flow's write path.
 *
 * Two-step booking so the frontend can show a 15-min countdown on the
 * final review screen before the customer commits (reduces abandonment
 * on the last click, matches OpenTable/Resy pattern).
 *
 * Flow:
 *   1. Customer picks a slot on the estimate view → POST /:token/reserve
 *      → reserveSlot() inserts scheduled_services with
 *      reservation_expires_at = NOW() + 15min, customer_id still null.
 *   2. Customer taps Reserve + payment pref → PUT /:token/accept
 *      → commitReservation() sets customer_id, payment_method_preference,
 *      clears reservation_expires_at.
 *   3. Abandoned reservations get reclaimed by releaseExpiredReservations()
 *      (ships with this service; cron wiring lands separately).
 *
 * Race safety: reserveSlot runs conflict-check + insert in one transaction.
 * Two customers tapping the same slot in the same second: one succeeds,
 * the other throws SLOT_UNAVAILABLE and the caller re-fetches fresh slots.
 *
 * Does NOT do:
 *   - SMS / email / notifications — caller's responsibility
 *   - Coordinate lookup on the reservation row. Customer may not be
 *     linked yet. For the 15-minute reservation window this means
 *     find-time's detour calcs for OTHER slots on the same day won't
 *     account for the reserved spot's exact coords. Acceptable — the
 *     time window is still marked occupied, so conflict detection is
 *     correct; only the fleet-level detour score is approximate. Commit
 *     can copy coords from the linked customer row if needed later.
 */
const db = require('../models/db');
const logger = require('./logger');
const estimateSlotAvailability = require('./estimate-slot-availability');

const DEFAULT_HOLD_MINUTES = 15;
const DEFAULT_DURATION_MINUTES = 60;

// Slot IDs come from PR A's getAvailableSlots:
//   `${date}_${startTime.replace(':', '-')}_${techId || 'unassigned'}`
// e.g. "2026-04-29_10-00_7d34c5e6-..."
const SLOT_ID_RE = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})_(.+)$/;

function parseSlotId(slotId) {
  if (!slotId || typeof slotId !== 'string') return null;
  const m = slotId.match(SLOT_ID_RE);
  if (!m) return null;
  const [, date, hh, mm, techRaw] = m;
  const h = Number(hh);
  const min = Number(mm);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  return {
    date,
    windowStart: `${hh}:${mm}:00`,
    techId: techRaw === 'unassigned' ? null : techRaw,
  };
}

function addMinutesToTime(hhmmss, minutes) {
  const [h, m] = String(hhmmss).split(':').map(Number);
  const total = h * 60 + m + minutes;
  const newH = Math.floor(total / 60) % 24;
  const newM = total % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}:00`;
}

/**
 * Reserve a slot for an estimate. Atomic — if the slot is already taken
 * (by another committed visit, or by a live reservation that hasn't
 * expired), throws SLOT_UNAVAILABLE.
 *
 * opts: { estimateId, slotId, holdMinutes?, durationMinutes? }
 * returns: { scheduledServiceId, expiresAt }
 */
async function reserveSlot({ estimateId, slotId, holdMinutes = DEFAULT_HOLD_MINUTES, durationMinutes = DEFAULT_DURATION_MINUTES }) {
  const parsed = parseSlotId(slotId);
  if (!parsed) {
    const err = new Error('invalid slotId format');
    err.code = 'INVALID_SLOT_ID';
    throw err;
  }
  const { date, windowStart, techId } = parsed;
  const windowEnd = addMinutesToTime(windowStart, durationMinutes);

  // Numeric coerce + bound the hold window so we can safely interpolate it
  // into a Postgres INTERVAL string below.
  const holdMins = Math.max(1, Math.min(120, Number(holdMinutes) || DEFAULT_HOLD_MINUTES));

  try {
    return await db.transaction(async (trx) => {
      // SELECT … FOR UPDATE on the estimate row serializes concurrent
      // reserves/accepts/declines for this estimate. Without this lock,
      // status/expiry checks could be made against committed state that
      // changes by the time we INSERT below. The `_expired` derived flag
      // does the expiry comparison in Postgres so server clock skew across
      // app instances can't bypass the gate.
      const estimate = await trx('estimates')
        .where({ id: estimateId })
        .select('*', trx.raw('(expires_at IS NOT NULL AND expires_at < NOW()) AS _expired'))
        .forUpdate()
        .first();

      if (!estimate) {
        const err = new Error('estimate not found');
        err.code = 'ESTIMATE_NOT_FOUND';
        throw err;
      }
      if (estimate._expired) {
        const err = new Error('estimate expired');
        err.code = 'ESTIMATE_EXPIRED';
        throw err;
      }
      if (['accepted', 'declined', 'expired', 'void'].includes(estimate.status)) {
        const err = new Error(`estimate in terminal state '${estimate.status}'`);
        err.code = 'ESTIMATE_TERMINAL';
        throw err;
      }

      // Conflict check + insert in the same txn so a concurrent reserve on
      // the same (tech, date, windowStart) can't slip past us. Expired
      // reservations are harmless cruft — releaseExpiredReservations()
      // reclaims them, and the new reservation can overlap safely. Use
      // NOW() server-side instead of a JS-side `new Date()` to keep the
      // inequality consistent with the timestamp the INSERT will set.
      const conflict = await trx('scheduled_services')
        .where({ scheduled_date: date, window_start: windowStart })
        .modify((q) => { if (techId) q.where('technician_id', techId); })
        .whereNotIn('status', ['cancelled'])
        .andWhere((q) => {
          q.whereNull('reservation_expires_at')
            .orWhereRaw('reservation_expires_at > NOW()');
        })
        .first('id');

      if (conflict) {
        const err = new Error('slot no longer available');
        err.code = 'SLOT_UNAVAILABLE';
        err.slotId = slotId;
        throw err;
      }

      // service_type falls back to the estimate's service_interest. Admin
      // can always rename via the dispatch board; this is the initial
      // label that appears in scheduled_services + the tech app.
      const [row] = await trx('scheduled_services').insert({
        customer_id: null,
        technician_id: techId,
        scheduled_date: date,
        window_start: windowStart,
        window_end: windowEnd,
        service_type: estimate.service_interest || 'Estimate service',
        status: 'pending',
        source_estimate_id: estimateId,
        // DB-side expiry timestamp. holdMins is clamped above; safe to
        // splice into the INTERVAL string.
        reservation_expires_at: trx.raw(`NOW() + INTERVAL '${holdMins} minutes'`),
        payment_method_preference: null,
        estimated_duration_minutes: durationMinutes,
        // track_state uses its DB default ('scheduled'). track_view_token
        // stays null — reservation rows aren't yet customer-linked, so
        // there's nothing to track. commitReservation can mint a token
        // later if needed; Phase 1 track backfill only covered rows at
        // migration time.
      }).returning(['id', 'reservation_expires_at']);

      const scheduledServiceId = row.id || row;
      const expiresAt = row.reservation_expires_at || null;
      logger.info('[slot-reservation] reserved', {
        estimateId, slotId, scheduledServiceId,
        expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt,
      });

      return { scheduledServiceId, expiresAt };
    });
  } finally {
    // Invalidate the slot-availability wrapper cache for this estimate so
    // subsequent /available-slots calls reflect the new occupancy. Cheap
    // no-op if nothing cached.
    try { estimateSlotAvailability.invalidateEstimate(estimateId); } catch {}
  }
}

/**
 * Commit a reservation. Sets customer_id + payment_method_preference,
 * clears reservation_expires_at. Intended to run inside the accept
 * handler's existing transaction — pass trx explicitly when doing so.
 *
 * opts: { scheduledServiceId, customerId, paymentMethodPreference?, trx? }
 * returns: updated scheduled_services row
 */
async function commitReservation({ scheduledServiceId, customerId, paymentMethodPreference, trx }) {
  // Body is shared between the "caller already has a txn" path (use it) and
  // the "no caller txn" path (open our own). Either way the SELECT runs
  // FOR UPDATE so a concurrent commit/release/expiry-cleanup can't race
  // with us, and the expiry comparison runs in Postgres (NOW()) so server
  // clock skew can't let an expired reservation slip through.
  const run = async (client) => {
    const row = await client('scheduled_services')
      .where({ id: scheduledServiceId })
      .select('*', client.raw('(reservation_expires_at IS NOT NULL AND reservation_expires_at < NOW()) AS _expired'))
      .forUpdate()
      .first();
    if (!row) {
      const err = new Error('reservation not found');
      err.code = 'RESERVATION_NOT_FOUND';
      throw err;
    }
    if (!row.reservation_expires_at) {
      // Already committed. Idempotent — return the existing row rather
      // than throw; a double-click on accept shouldn't fail.
      return row;
    }
    if (row._expired) {
      const err = new Error('reservation expired');
      err.code = 'RESERVATION_EXPIRED';
      throw err;
    }

    const updates = {
      customer_id: customerId,
      reservation_expires_at: null,
      updated_at: new Date(),
    };
    if (paymentMethodPreference) {
      updates.payment_method_preference = paymentMethodPreference;
    }

    const [updated] = await client('scheduled_services')
      .where({ id: scheduledServiceId })
      .update(updates)
      .returning('*');

    logger.info('[slot-reservation] committed', {
      scheduledServiceId, customerId, paymentMethodPreference: paymentMethodPreference || null,
    });

    return updated;
  };

  return trx ? run(trx) : db.transaction(run);
}

/**
 * Release a live reservation that hasn't been committed yet. Called when
 * the customer taps "Change my pick" in the estimate view. Narrow match —
 * only deletes rows that are still in reservation state (no customer_id,
 * still within reservation_expires_at) — so we can't accidentally wipe a
 * committed booking if a client sends a stale id after accept.
 *
 * Returns: { released: boolean } (true if a row was actually deleted).
 */
async function releaseReservation({ scheduledServiceId, estimateId }) {
  if (!scheduledServiceId) return { released: false };
  const count = await db('scheduled_services')
    .where({ id: scheduledServiceId })
    .whereNull('customer_id')
    .whereNotNull('reservation_expires_at')
    .modify((q) => {
      if (estimateId) q.where({ estimate_id: estimateId });
    })
    .del();
  return { released: count > 0 };
}

/**
 * Reclaim scheduled_services rows where reservation_expires_at has passed.
 *
 * Abandoned reservations accumulate when:
 *   - Customer picks a slot but closes the tab before accepting
 *   - Network failure between POST /:token/reserve and PUT /:token/accept
 *   - Customer sits on the confirm screen past the 15-min window and
 *     re-picks, leaving the original reservation dangling
 *
 * Deletes the row outright (not a soft-delete) because reservations are
 * inherently ephemeral — no audit value in keeping them. The
 * idx_scheduled_services_reservation_cleanup partial index (only rows
 * where reservation_expires_at IS NOT NULL) makes this scan narrow.
 *
 * Function exported and callable today but NOT wired to a cron in
 * PR B.1. Callers that need it today (admin debug, tests) can invoke
 * directly; scheduled cleanup wiring lands in a later PR alongside the
 * other reservation-adjacent operational work.
 *
 * Returns: { released: number }
 */
async function releaseExpiredReservations() {
  const now = new Date();
  const released = await db('scheduled_services')
    .where('reservation_expires_at', '<', now)
    .del();
  if (released > 0) {
    logger.info(`[slot-reservation] released ${released} expired reservation(s)`);
  }
  return { released };
}

module.exports = {
  reserveSlot,
  commitReservation,
  releaseReservation,
  releaseExpiredReservations,
  _internals: { parseSlotId, addMinutesToTime },
};

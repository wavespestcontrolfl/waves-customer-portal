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

  const estimate = await db('estimates').where({ id: estimateId }).first();
  if (!estimate) {
    const err = new Error('estimate not found');
    err.code = 'ESTIMATE_NOT_FOUND';
    throw err;
  }
  if (estimate.expires_at && new Date(estimate.expires_at) < new Date()) {
    const err = new Error('estimate expired');
    err.code = 'ESTIMATE_EXPIRED';
    throw err;
  }
  if (['accepted', 'declined', 'expired'].includes(estimate.status)) {
    const err = new Error(`estimate in terminal state '${estimate.status}'`);
    err.code = 'ESTIMATE_TERMINAL';
    throw err;
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + holdMinutes * 60 * 1000);

  try {
    return await db.transaction(async (trx) => {
      // Conflict check: any non-cancelled row on this (tech, date, windowStart)
      // that isn't an expired reservation. Expired reservations are harmless
      // cruft — releaseExpiredReservations() reclaims them, and the new
      // reservation can overlap safely.
      const conflict = await trx('scheduled_services')
        .where({ scheduled_date: date, window_start: windowStart })
        .modify((q) => { if (techId) q.where('technician_id', techId); })
        .whereNotIn('status', ['cancelled'])
        .andWhere((q) => {
          q.whereNull('reservation_expires_at')
            .orWhere('reservation_expires_at', '>', now);
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
        reservation_expires_at: expiresAt,
        payment_method_preference: null,
        estimated_duration_minutes: durationMinutes,
        // track_state uses its DB default ('scheduled'). track_view_token
        // stays null — reservation rows aren't yet customer-linked, so
        // there's nothing to track. commitReservation can mint a token
        // later if needed; Phase 1 track backfill only covered rows at
        // migration time.
      }).returning('id');

      const scheduledServiceId = row.id || row;
      logger.info('[slot-reservation] reserved', {
        estimateId, slotId, scheduledServiceId, expiresAt: expiresAt.toISOString(),
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
  const client = trx || db;
  const row = await client('scheduled_services').where({ id: scheduledServiceId }).first();
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
  if (new Date(row.reservation_expires_at) < new Date()) {
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
}

module.exports = {
  reserveSlot,
  commitReservation,
  _internals: { parseSlotId, addMinutesToTime },
};

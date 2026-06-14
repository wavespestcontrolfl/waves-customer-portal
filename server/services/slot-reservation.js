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
 *      first-visit estimated_price, clears reservation_expires_at.
 *   3. Abandoned reservations get reclaimed by releaseExpiredReservations()
 *      Wired to a 15-min cron in services/scheduler.js.
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
const { etParts, etDateString } = require('../utils/datetime-et');

const DEFAULT_HOLD_MINUTES = 15;
const DEFAULT_DURATION_MINUTES = 60;
const MAX_SERVICE_TYPE_LENGTH = 100;

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

function applyWindowOverlapFilter(query, windowStart, windowEnd) {
  return query.andWhereRaw(
    "window_start < ?::time AND COALESCE(window_end, window_start + ((COALESCE(NULLIF(estimated_duration_minutes, 0), ?)::text || ' minutes')::interval)) > ?::time",
    [windowEnd, DEFAULT_DURATION_MINUTES, windowStart],
  );
}

function dateOnly(value) {
  if (!value) return value;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value;
}

function cappedServiceType(value, fallback = 'Estimate service') {
  const label = String(value || fallback).replace(/\s+/g, ' ').trim() || fallback;
  if (label.length <= MAX_SERVICE_TYPE_LENGTH) return label;
  return `${label.slice(0, MAX_SERVICE_TYPE_LENGTH - 3).trimEnd()}...`;
}

function serviceKeyForLabel(value = '') {
  const raw = String(value || '').toLowerCase();
  if (/pest|roach|ant|spider|perimeter|general/.test(raw)) return 'pest_control';
  if (/lawn|turf|fertili[sz]|weed|fungus|chinch/.test(raw)) return 'lawn_care';
  if (/mosquito/.test(raw)) return 'mosquito';
  if (/tree|shrub|ornamental/.test(raw)) return 'tree_shrub';
  if (/palm/.test(raw)) return 'palm_injection';
  if (/rodent.*trap|trap.*rodent/.test(raw)) return 'rodent_trapping';
  if (/rodent.*exclusion|exclusion.*rodent/.test(raw)) return 'rodent_exclusion';
  if (/rodent.*sanitation|sanitation.*rodent/.test(raw)) return 'rodent_sanitation';
  if (/rodent|rat|mouse|mice/.test(raw)) return 'rodent_bait';
  if (/termite/.test(raw)) return 'termite_bait';
  return '';
}

function pestServiceTypeFromVisits(visitsPerYear) {
  const visits = Number(visitsPerYear);
  if (Number.isFinite(visits) && visits >= 12) return 'Monthly Pest Control';
  if (Number.isFinite(visits) && visits >= 6) return 'Bi-Monthly Pest Control';
  return 'Quarterly Pest Control';
}

function canonicalServiceTypeForProfile(serviceProfile = {}, fallback = 'Estimate service') {
  const services = Array.isArray(serviceProfile?.services) ? serviceProfile.services : [];
  const primary = services.find((svc) => svc?.service === 'pest_control') || services[0] || null;
  const key = primary?.service || serviceKeyForLabel(fallback);

  if (serviceProfile?.serviceMode === 'one_time' && services.length === 0) {
    if (key === 'pest_control') return 'Pest Control';
    if (key === 'rodent_trapping') return 'Rodent Trapping Service';
    if (key === 'rodent_exclusion') return 'Rodent Exclusion Service';
    if (key === 'rodent_sanitation') return 'Rodent Sanitation Service';
    return cappedServiceType(fallback);
  }

  if (key === 'pest_control') return pestServiceTypeFromVisits(primary?.visitsPerYear);
  if (key === 'lawn_care') return 'Lawn Care';
  if (key === 'mosquito') return 'Mosquito Treatment';
  if (key === 'tree_shrub') return 'Tree & Shrub';
  if (key === 'termite_bait') return 'Termite Bait';
  if (key === 'palm_injection') return 'Palm Injection';
  if (key === 'rodent_trapping') return 'Rodent Trapping Service';
  if (key === 'rodent_exclusion') return 'Rodent Exclusion Service';
  if (key === 'rodent_sanitation') return 'Rodent Sanitation Service';
  if (key === 'rodent_bait') return 'Rodent Bait';
  return cappedServiceType(fallback);
}

function normalizedServiceMixLabel(serviceProfile = {}, fallback = '') {
  const label = String(serviceProfile?.serviceLabel || fallback || '')
    .replace(/\s+/g, ' ')
    .trim();
  return label || null;
}

function notesWithServiceMix(existingNotes, serviceProfile = {}, fallback = '') {
  const mixLabel = normalizedServiceMixLabel(serviceProfile, fallback);
  if (!mixLabel) return existingNotes || null;
  const line = `Accepted service mix: ${mixLabel}.`;
  const current = String(existingNotes || '').trim();
  if (!current) return line;
  if (current.includes(line)) return current;
  if (/^Accepted service mix:/m.test(current)) {
    return current.replace(/^Accepted service mix:.*$/m, line);
  }
  return `${current}\n${line}`;
}

async function resolveReservationServiceProfile(client, row, opts = {}) {
  if (!estimateSlotAvailability.resolveEstimateSlotProfile) return null;
  let estimate = opts.estimate || null;
  if (!estimate && row?.source_estimate_id) {
    estimate = await client('estimates').where({ id: row.source_estimate_id }).first();
  }
  if (!estimate) return null;
  return estimateSlotAvailability.resolveEstimateSlotProfile(estimate, {
    serviceMode: opts.serviceMode,
    selectedFrequency: opts.selectedFrequency,
    durationMinutes: opts.durationMinutes,
  });
}

/**
 * Reserve a slot for an estimate. Atomic — if the slot is already taken
 * (by another committed visit, or by a live reservation that hasn't
 * expired), throws SLOT_UNAVAILABLE.
 *
 * opts: { estimateId, slotId, holdMinutes?, durationMinutes?, serviceMode?, selectedFrequency? }
 * returns: { scheduledServiceId, expiresAt }
 */
async function reserveSlot({
  estimateId,
  slotId,
  holdMinutes = DEFAULT_HOLD_MINUTES,
  durationMinutes,
  serviceMode = 'recurring',
  selectedFrequency = '',
}) {
  const parsed = parseSlotId(slotId);
  if (!parsed) {
    const err = new Error('invalid slotId format');
    err.code = 'INVALID_SLOT_ID';
    throw err;
  }
  const { date, windowStart, techId } = parsed;

  // Past-slot guard: the slot list is generated minutes before the customer
  // taps it, and ASAP same-day slots can have already elapsed by confirm
  // time. A reservation for an elapsed window books a visit no tech will
  // ever make.
  const todayEt = etDateString();
  if (date < todayEt) {
    const err = new Error('slot date has already passed');
    err.code = 'SLOT_UNAVAILABLE';
    err.slotId = slotId;
    throw err;
  }
  if (date === todayEt) {
    const nowEt = etParts(new Date());
    const [sh, sm] = String(windowStart).split(':').map(Number);
    if (sh * 60 + sm <= nowEt.hour * 60 + nowEt.minute) {
      const err = new Error('slot time has already passed today');
      err.code = 'SLOT_UNAVAILABLE';
      err.slotId = slotId;
      throw err;
    }
  }

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

      // The FOR UPDATE above only serializes THIS estimate — two different
      // customers' estimates reserving the same tech/date can both pass the
      // conflict check below concurrently and both insert. Serialize all
      // reserves per tech+day (coarse but reserves are quick), released on
      // commit/rollback.
      await trx.raw(
        'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
        ['slot-reserve', `${techId || 'unassigned'}:${date}`],
      );
      // Also take the zone+day lock the self-booking writers
      // (availability.confirmBooking, /api/booking/confirm) use — without
      // it, a self-book confirm and an estimate hold for the same window
      // each miss the other's uncommitted row. Fixed order everywhere:
      // tech lock first, zone lock second.
      let reserveZone = null;
      try {
        const zones = await trx('service_zones').select('id', 'cities', 'zone_name');
        if (estimate.customer_id) {
          const holder = await trx('customers').where({ id: estimate.customer_id }).first('city');
          const holderCity = String(holder?.city || '').toLowerCase();
          if (holderCity) {
            reserveZone = zones.find((z) => (z.cities || []).some((c) => String(c).toLowerCase() === holderCity)) || null;
          }
        }
        if (!reserveZone && estimate.address) {
          // Unlinked/public estimates carry only a free-text address —
          // match any zone city appearing in it so these reserves take
          // the same zone lock the self-booking writers do instead of
          // falling through to zone:unknown.
          const addr = String(estimate.address).toLowerCase();
          reserveZone = zones.find((z) => (z.cities || []).some((c) => c && addr.includes(String(c).toLowerCase()))) || null;
        }
      } catch (zoneErr) {
        logger.warn(`[slot-reservation] zone resolution failed for estimate ${estimateId}: ${zoneErr.message}`);
      }
      await trx.raw(
        'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
        ['slot-reserve', `zone:${reserveZone?.id || 'unknown'}:${date}`],
      );

      const serviceProfile = estimateSlotAvailability.resolveEstimateSlotProfile
        ? estimateSlotAvailability.resolveEstimateSlotProfile(estimate, {
          serviceMode,
          selectedFrequency,
          durationMinutes,
        })
        : null;
      const effectiveDurationMinutes = Number(serviceProfile?.durationMinutes) > 0
        ? Number(serviceProfile.durationMinutes)
        : DEFAULT_DURATION_MINUTES;
      const windowEnd = addMinutesToTime(windowStart, effectiveDurationMinutes);
      const serviceType = canonicalServiceTypeForProfile(serviceProfile, estimate.service_interest);
      const displayServiceLabel = cappedServiceType(serviceProfile?.serviceLabel || estimate.service_interest);
      const notes = notesWithServiceMix(null, serviceProfile, estimate.service_interest);

      // Conflict check + insert in the same txn so a concurrent reserve that
      // overlaps this tech/date window can't slip past us. Expired
      // reservations are harmless cruft — releaseExpiredReservations()
      // reclaims them, and the new reservation can overlap safely. Use
      // NOW() server-side instead of a JS-side `new Date()` to keep the
      // inequality consistent with the timestamp the INSERT will set.
      const conflict = await trx('scheduled_services')
        .where({ scheduled_date: date })
        .modify((q) => { if (techId) q.where('technician_id', techId); })
        .whereNotIn('status', ['cancelled'])
        .andWhere((q) => {
          q.whereNull('reservation_expires_at')
            .orWhereRaw('reservation_expires_at > NOW()');
        })
        .modify((q) => applyWindowOverlapFilter(q, windowStart, windowEnd))
        .first('id');

      if (conflict) {
        const err = new Error('slot no longer available');
        err.code = 'SLOT_UNAVAILABLE';
        err.slotId = slotId;
        throw err;
      }

      // Zone-capacity check: the tech-scoped conflict above misses
      // unassigned self-bookings (technician_id NULL) that occupy the
      // same zone/time — availability treats the zone as one capacity
      // pool, so an estimate hold must not stack on top of one.
      if (reserveZone) {
        const zoneSlug = reserveZone.zone_name?.split('/')[0]?.trim()?.toLowerCase() || null;
        const zoneCities = reserveZone.cities || [];
        const zoneConflict = await trx('scheduled_services')
          .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
          .where('scheduled_services.scheduled_date', date)
          .whereNull('scheduled_services.technician_id')
          .whereNotIn('scheduled_services.status', ['cancelled'])
          .where((q) => {
            q.whereNull('scheduled_services.reservation_expires_at')
              .orWhereRaw('scheduled_services.reservation_expires_at > NOW()');
          })
          .where((q) => {
            if (zoneSlug) q.orWhere('scheduled_services.zone', zoneSlug);
            if (zoneCities.length) q.orWhereIn('customers.city', zoneCities);
          })
          .modify((q) => applyWindowOverlapFilter(q, windowStart, windowEnd))
          .first('scheduled_services.id');
        if (zoneConflict) {
          const err = new Error('slot no longer available');
          err.code = 'SLOT_UNAVAILABLE';
          err.slotId = slotId;
          throw err;
        }
      }

      // service_type stays canonical for protocol/default lookups; notes
      // carry the full accepted service mix for dispatch and tech execution.
      const [row] = await trx('scheduled_services').insert({
        customer_id: null,
        technician_id: techId,
        scheduled_date: date,
        window_start: windowStart,
        window_end: windowEnd,
        service_type: serviceType,
        status: 'pending',
        source_estimate_id: estimateId,
        // DB-side expiry timestamp. holdMins is clamped above; safe to
        // splice into the INTERVAL string.
        reservation_expires_at: trx.raw(`NOW() + INTERVAL '${holdMins} minutes'`),
        payment_method_preference: null,
        estimated_duration_minutes: effectiveDurationMinutes,
        notes,
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
        serviceType,
        displayServiceLabel,
        durationMinutes: effectiveDurationMinutes,
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
 * optionally stamps estimated_price, and clears reservation_expires_at.
 * Intended to run inside the accept
 * handler's existing transaction — pass trx explicitly when doing so.
 *
 * opts: { scheduledServiceId, customerId, paymentMethodPreference?, estimatedPrice?, trx? }
 * returns: updated scheduled_services row
 */
async function commitReservation({
  scheduledServiceId,
  customerId,
  paymentMethodPreference,
  estimatedPrice,
  estimate = null,
  serviceMode = 'recurring',
  selectedFrequency = '',
  durationMinutes,
  trx,
}) {
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

    const serviceProfile = await resolveReservationServiceProfile(client, row, {
      estimate,
      serviceMode,
      selectedFrequency,
      durationMinutes,
    });
    const effectiveDurationMinutes = Number(serviceProfile?.durationMinutes) > 0
      ? Number(serviceProfile.durationMinutes)
      : null;
    const scheduledDate = dateOnly(row.scheduled_date);
    const windowStart = row.window_start;
    const windowEnd = effectiveDurationMinutes && scheduledDate && windowStart
      ? addMinutesToTime(windowStart, effectiveDurationMinutes)
      : null;

    if (windowEnd) {
      const conflict = await client('scheduled_services')
        .where({ scheduled_date: scheduledDate })
        .modify((q) => { if (row.technician_id) q.where('technician_id', row.technician_id); })
        .whereNot('id', scheduledServiceId)
        .whereNotIn('status', ['cancelled'])
        .andWhere((q) => {
          q.whereNull('reservation_expires_at')
            .orWhereRaw('reservation_expires_at > NOW()');
        })
        .modify((q) => applyWindowOverlapFilter(q, windowStart, windowEnd))
        .first('id');

      if (conflict) {
        const err = new Error('slot no longer available');
        err.code = 'SLOT_UNAVAILABLE';
        err.slotId = `${scheduledDate}_${String(windowStart).slice(0, 5).replace(':', '-')}_${row.technician_id || 'unassigned'}`;
        throw err;
      }
    }

    const updates = {
      customer_id: customerId,
      reservation_expires_at: null,
      updated_at: new Date(),
    };
    if (paymentMethodPreference) {
      updates.payment_method_preference = paymentMethodPreference;
    }
    const price = Number(estimatedPrice);
    if (Number.isFinite(price) && price > 0) {
      updates.estimated_price = Math.round(price * 100) / 100;
    }
    if (windowEnd) {
      updates.window_end = windowEnd;
      updates.estimated_duration_minutes = effectiveDurationMinutes;
      updates.service_type = canonicalServiceTypeForProfile(serviceProfile, row.service_type);
      updates.notes = notesWithServiceMix(row.notes, serviceProfile, row.service_type);
    }

    const [updated] = await client('scheduled_services')
      .where({ id: scheduledServiceId })
      .update(updates)
      .returning('*');

    logger.info('[slot-reservation] committed', {
      scheduledServiceId,
      customerId,
      paymentMethodPreference: paymentMethodPreference || null,
      estimatedPrice: updates.estimated_price || null,
      durationMinutes: updates.estimated_duration_minutes || null,
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
      if (estimateId) q.where({ source_estimate_id: estimateId });
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
 * Wired to a 15-min cron in services/scheduler.js (matching the
 * reservation TTL so worst-case stale-hold lifetime is ~30 min).
 * Callers can also invoke directly for admin debug or tests.
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
  _internals: { parseSlotId, addMinutesToTime, cappedServiceType, canonicalServiceTypeForProfile, notesWithServiceMix },
};

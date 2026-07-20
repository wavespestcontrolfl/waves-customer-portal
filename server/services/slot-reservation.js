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
const { addETDays, etParts, etDateString } = require('../utils/datetime-et');
const { splitSignedSlotId, verifySlotOffer, isRealCalendarDate } = require('../utils/slot-offer-token');
const { resolveEstimateZone, zoneSlugOf } = require('./slot-zone');
// Rung 1 of the global scheduling lock order — see the ORDERING CONTRACT in
// scheduling/occupancy.js for why both write paths here take it first, and
// why each also runs the tech-blind global probe (findConflictingVisits)
// under it before committing.
const { acquireOccupancyLock, findConflictingVisits } = require('./scheduling/occupancy');

// Business bounds shared with the slot generators (see the exporting module
// for provenance): 8:00 day start (find-time DAY_START_HOUR), 17:00 day end,
// 90-day offer horizon.
const {
  SLOT_DAY_START_MINUTES,
  SLOT_DAY_END_MINUTES,
  MAX_SLOT_HORIZON_DAYS,
} = estimateSlotAvailability;

const DEFAULT_HOLD_MINUTES = 15;
const DEFAULT_DURATION_MINUTES = 60;
const MAX_SERVICE_TYPE_LENGTH = 100;
// classifySlot's roundUpToHour can push a proven-feasible route slot's
// DISPLAY window up to 59 minutes later than the gap find-time validated, so
// a legitimately offered slot can end up to 59 minutes past the 17:00 day
// close. Allow exactly that much on the end-of-day check and no more.
const ROUND_UP_GRACE_MINUTES = 59;

// Slot IDs come from PR A's getAvailableSlots:
//   `${date}_${startTime.replace(':', '-')}_${techId || 'unassigned'}`
// with the signed-offer segments appended by signCustomerFacingSlots:
//   `${base}.${exp}.${sig}`
// e.g. "2026-04-29_10-00_7d34c5e6-....1767216000000.dGhl..."
const SLOT_ID_RE = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})_(.+)$/;

function parseSlotId(slotId) {
  if (!slotId || typeof slotId !== 'string') return null;
  // Splitting is deliberately lenient here — ENFORCEMENT (presence, expiry,
  // HMAC) lives in reserveSlot. Accept-time callers (estimate-public.js)
  // re-parse the committed slotId only to locate the reservation row, and
  // must keep working after the offer's exp has passed.
  const signed = splitSignedSlotId(slotId);
  const base = signed ? signed.baseSlotId : slotId;
  const m = base.match(SLOT_ID_RE);
  if (!m) return null;
  const [, date, hh, mm, techRaw] = m;
  const h = Number(hh);
  const min = Number(mm);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  // Round-trip the calendar day: the regex alone admits 2026-09-31, which
  // survives every lexical bound check and only explodes inside Postgres.
  if (!isRealCalendarDate(date)) return null;
  return {
    date,
    windowStart: `${hh}:${mm}:00`,
    techId: techRaw === 'unassigned' ? null : techRaw,
    offerExp: signed ? signed.exp : null,
    offerSig: signed ? signed.sig : null,
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

function canonicalServiceTypeForProfile(serviceProfile = {}, fallback = 'Estimate service', opts = {}) {
  const services = Array.isArray(serviceProfile?.services) ? serviceProfile.services : [];
  const primary = services.find((svc) => svc?.service === 'pest_control') || services[0] || null;
  const key = primary?.service || serviceKeyForLabel(fallback);
  // A one-time accept is a single visit with no cadence. The one-time service
  // profile carries an empty `services` array, so visitsPerYear is unknown and
  // pestServiceTypeFromVisits would default to "Quarterly Pest Control" —
  // labeling a one-time booking as recurring. Honor an explicit serviceMode
  // (threaded from the reserve/commit callers) over the profile so a null
  // profile at commit can't re-derive the cadence prefix from a stale fallback.
  const isOneTime = opts.serviceMode === 'one_time' || serviceProfile?.serviceMode === 'one_time';

  if (key === 'pest_control') return isOneTime ? 'Pest Control' : pestServiceTypeFromVisits(primary?.visitsPerYear);
  if (key === 'lawn_care') return 'Lawn Care';
  if (key === 'mosquito') return 'Mosquito Treatment';
  if (key === 'tree_shrub') return 'Tree & Shrub';
  if (key === 'termite_bait') return 'Termite Bait';
  if (key === 'foam_recurring') return 'Recurring Foam Treatment';
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
  const { date, windowStart, techId, offerExp, offerSig } = parsed;

  // Signed-offer gate (booking-audit round 2): every slot the generator
  // returns carries `.exp.sig` inside its slotId — a bare/hand-crafted id
  // (including a crafted `_unassigned` one) was never offered. Presence and
  // expiry are checked here before any DB work; the HMAC itself is verified
  // in-txn once the effective duration is known. Rejected with the same
  // SLOT_UNAVAILABLE the client already recovers from by refreshing slots —
  // which is also exactly what a customer holding a pre-deploy (unsigned)
  // slot list needs: one 409, then the refreshed list is signed.
  if (!offerSig || !Number.isFinite(offerExp) || Date.now() > offerExp) {
    const err = new Error('slot offer is missing or expired');
    err.code = 'SLOT_UNAVAILABLE';
    err.slotId = slotId;
    throw err;
  }

  // Redemption re-check for owner blackout days: a signed offer minted
  // moments before the admin blacked the date out must not stay bookable.
  // Same SLOT_UNAVAILABLE the client already recovers from by refreshing —
  // and the estimate's 5-min wrapper cache is invalidated FIRST, so that
  // refresh recomputes instead of re-serving the stale pre-blackout list
  // (and re-throwing forever). Helper fails open.
  {
    const { isBlackoutDate } = require('./scheduling/blackout-dates');
    if (await isBlackoutDate(date)) {
      try { estimateSlotAvailability.invalidateEstimate(estimateId); } catch { /* best-effort */ }
      const err = new Error('that day is no longer available');
      err.code = 'SLOT_UNAVAILABLE';
      err.slotId = slotId;
      throw err;
    }
  }

  // Stale-slot guard: the slot list is generated minutes before the customer
  // taps it, and a page left open can hold windows the generator would no
  // longer offer. Enforce the same minimum booking lead the generator uses
  // (estimate-slot-availability's minimumLeadMinutes default) — a window
  // inside the lead can't be routed and dispatched, so reserving it books a
  // visit no tech can make on time. STRICTLY inside: the generator offers
  // starts AT the boundary (startMin >= earliest), so equality must pass
  // here too or a just-fetched boundary slot 409s on the first tap.
  const MINIMUM_LEAD_MINUTES = 120;
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
    if (sh * 60 + sm < nowEt.hour * 60 + nowEt.minute + MINIMUM_LEAD_MINUTES) {
      const err = new Error('slot start is inside the booking lead window');
      err.code = 'SLOT_UNAVAILABLE';
      err.slotId = slotId;
      throw err;
    }
  }

  // Server-authoritative slot policy: parseSlotId validates FORMAT only — the
  // date/time/tech in the slotId are client-supplied, so a crafted id could
  // otherwise book 3 AM, any-horizon, or inactive-tech visits. Route-derived
  // find-time slots are legitimately offered at minutes the day-grid generator
  // wouldn't emit, so grid MEMBERSHIP can't be re-checked here; instead
  // enforce the business bounds every legitimate offer satisfies: the 8a–5p
  // working window (end checked in-txn once the duration is known), the offer
  // horizon, and an active technician (checked in-txn). Lunch is deliberately
  // NOT enforced: PREFERRED_WINDOWS skipping noon is a soft display rotation
  // for synthetic ASAP slots only — route-derived slots keep their
  // proven-feasible start, which can fall over lunch.
  const [slotStartHour, slotStartMinute] = String(windowStart).split(':').map(Number);
  const slotStartMinutes = slotStartHour * 60 + slotStartMinute;
  if (slotStartMinutes < SLOT_DAY_START_MINUTES) {
    const err = new Error('slot starts before the working day');
    err.code = 'SLOT_UNAVAILABLE';
    err.slotId = slotId;
    throw err;
  }
  // No offer surface produces slots beyond MAX_SLOT_HORIZON_DAYS (the public
  // route clamps ?windowDays and the AI date search caps maxDaysOut there).
  if (date > etDateString(addETDays(new Date(), MAX_SLOT_HORIZON_DAYS))) {
    const err = new Error('slot date is beyond the booking horizon');
    err.code = 'SLOT_UNAVAILABLE';
    err.slotId = slotId;
    throw err;
  }

  // Numeric coerce + bound the hold window so we can safely interpolate it
  // into a Postgres INTERVAL string below.
  const holdMins = Math.max(1, Math.min(120, Number(holdMinutes) || DEFAULT_HOLD_MINUTES));

  try {
    const reserved = await db.transaction(async (trx) => {
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

      // Exact offer-membership proof: the HMAC binds surface, THIS estimate,
      // date, start, technician (null = unassigned), the profile-resolved
      // duration, and the expiry — signed by signCustomerFacingSlots on the
      // very slots getAvailableSlots returned. A token holder can no longer
      // reserve any tuple the generator never offered; a legitimately offered
      // `_unassigned` slot verifies like any other, while an UNSIGNED
      // unassigned id died at the presence gate above. Verified here (not
      // pre-txn) because the duration needs the estimate's profile — the
      // coarse policy checks below stay as defense-in-depth.
      if (!verifySlotOffer({
        surface: 'estimate',
        scopeId: String(estimateId),
        date,
        startMinutes: slotStartMinutes,
        technicianId: techId,
        durationMinutes: effectiveDurationMinutes,
        exp: offerExp,
      }, offerSig)) {
        const err = new Error('slot was not offered for this estimate');
        err.code = 'SLOT_UNAVAILABLE';
        err.slotId = slotId;
        throw err;
      }

      // Working-day end: every legitimate offer ends by SLOT_DAY_END_MINUTES
      // (find-time's dayClose / slotWindowFitsDay), plus the round-up grace —
      // see ROUND_UP_GRACE_MINUTES. Needs the profile-resolved duration, so
      // it lives in-txn with the signature check rather than with the pre-txn
      // policy guards.
      if (slotStartMinutes + effectiveDurationMinutes > SLOT_DAY_END_MINUTES + ROUND_UP_GRACE_MINUTES) {
        const err = new Error('slot runs past the end of the working day');
        err.code = 'SLOT_UNAVAILABLE';
        err.slotId = slotId;
        throw err;
      }
      const serviceType = canonicalServiceTypeForProfile(serviceProfile, estimate.service_interest, { serviceMode });
      const displayServiceLabel = cappedServiceType(serviceProfile?.serviceLabel || estimate.service_interest);
      const notes = notesWithServiceMix(null, serviceProfile, estimate.service_interest);

      // Active-technician check: find-time only generates slots for
      // technicians where({ active: true }), so a slotId naming an inactive
      // or unknown tech was never offered. A crafted non-uuid techId makes
      // the lookup itself throw (22P02) — treat that the same as unknown
      // (the txn rolls back on the throw below either way).
      if (techId) {
        let activeTech = null;
        try {
          activeTech = await trx('technicians').where({ id: techId, active: true }).first('id');
        } catch (techErr) {
          logger.warn(`[slot-reservation] technician lookup failed for slot ${slotId}: ${techErr.message}`);
        }
        if (!activeTech) {
          const err = new Error('slot technician is not available');
          err.code = 'SLOT_UNAVAILABLE';
          err.slotId = slotId;
          throw err;
        }
      }

      // RUNG 1 — date-wide occupancy lock, FIRST (see the ORDERING CONTRACT
      // in scheduling/occupancy.js). The hold row inserted below is
      // customer-NULL but findConflictingVisits COUNTS live holds, so this is
      // a real occupancy writer. The tech + zone locks taken next do NOT
      // cover it: the rebooker takes the date + tech rungs and NO zone lock,
      // so an estimate hold whose slot named a different tech (or none)
      // shared nothing with a concurrent rebooker move on the same date and
      // the two could interleave past each other's checks.
      await acquireOccupancyLock(trx, date);
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
      // date lock first, then tech, then zone.
      let reserveZone = null;
      try {
        // Shared with the slot generator's colliding-slot filter (slot-zone.js)
        // so the offer surface and this reserve gate resolve the SAME zone —
        // a generator/reserve zone mismatch shows customers slots that every
        // tap 409s. Unlinked/public estimates resolve via their free-text
        // address so these reserves take the same zone lock the self-booking
        // writers do instead of falling through to zone:unknown.
        reserveZone = await resolveEstimateZone(trx, estimate);
      } catch (zoneErr) {
        logger.warn(`[slot-reservation] zone resolution failed for estimate ${estimateId}: ${zoneErr.message}`);
      }
      await trx.raw(
        'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
        ['slot-reserve', `zone:${reserveZone?.id || 'unknown'}:${date}`],
      );

      // (service profile / duration / day-end / signature were all resolved
      // and verified ABOVE, right after the estimate row's state checks.)

      // Idempotent self-hold handling: the conflict checks below have no
      // self-exclusion, so this estimate's OWN live hold would 409 the
      // customer's retry (the client re-POSTs /reserve with the same slotId
      // after "go back"). Re-reserving the SAME slot refreshes the existing
      // hold's expiry and returns it — but only after the same committed-
      // visit probe the fresh path runs (see the refresh branch below); a
      // live hold for a DIFFERENT slot is superseded — released inside this
      // txn with the same narrow predicate releaseReservation uses
      // (still-uncommitted rows only), which also removes it from both the
      // tech- and zone-conflict queries below.
      const liveHolds = await trx('scheduled_services')
        .where({ source_estimate_id: estimateId })
        .whereNull('customer_id')
        .whereNotNull('reservation_expires_at')
        .whereRaw('reservation_expires_at > NOW()')
        .forUpdate()
        .select('*');
      const sameSlotHold = (liveHolds || []).find((hold) => dateOnly(hold.scheduled_date) === date
        && String(hold.window_start).slice(0, 5) === String(windowStart).slice(0, 5)
        && (hold.technician_id || null) === (techId || null)
        && Number(hold.estimated_duration_minutes) === effectiveDurationMinutes);
      if (sameSlotHold) {
        const staleIds = liveHolds.filter((hold) => hold.id !== sameSlotHold.id).map((hold) => hold.id);
        if (staleIds.length) {
          await trx('scheduled_services').whereIn('id', staleIds).del();
        }
        // Committed-visit probe BEFORE the expiry is extended — the same
        // rung-1 date lock the fresh path takes is already held (acquired
        // above, ahead of this branch), so the ordering contract covers
        // this leg too. The call-booking writer commits without blocking on
        // live holds, so a committed visit can occupy this window AFTER the
        // hold was created; refreshing then hands the customer a hold
        // commitReservation is guaranteed to reject — the offer→reserve→409
        // dead-end loop again, merely moved to the accept click.
        // includeHolds:false + excluding the held row itself: committed
        // visits only — hold-vs-hold semantics stay with the narrow checks,
        // and this idempotent retry keeps its designed no-409 behavior when
        // the window is still genuinely free.
        const refreshClash = await findConflictingVisits({
          db: trx,
          date,
          windowStart,
          windowEnd,
          excludeServiceIds: [sameSlotHold.id],
          includeHolds: false,
        });
        if (refreshClash.length) {
          // Do NOT refresh a doomed hold — supersede it (same narrow
          // still-uncommitted predicate releaseReservation uses) so the
          // window frees beyond the committed visit's own footprint. The
          // release must SURVIVE while the reserve itself fails, so the 409
          // is thrown after commit via the sentinel below — a plain throw
          // here would roll the delete back and leave the phantom hold
          // occupying route time until expiry.
          await trx('scheduled_services')
            .where({ id: sameSlotHold.id })
            .whereNull('customer_id')
            .whereNotNull('reservation_expires_at')
            .del();
          logger.warn('[slot-reservation] superseded hold over committed visit on same-slot refresh', {
            estimateId,
            slotId,
            scheduledServiceId: sameSlotHold.id,
            conflictIds: refreshClash.map((r) => r.id),
          });
          return { staleHoldSuperseded: true };
        }
        // Refresh expiry only — commitReservation recomputes service_type /
        // notes / window_end from the accept-time profile, so the hold's
        // stamped labels don't need to be rebuilt on a retry.
        const [refreshed] = await trx('scheduled_services')
          .where({ id: sameSlotHold.id })
          .update({ reservation_expires_at: trx.raw(`NOW() + INTERVAL '${holdMins} minutes'`) })
          .returning(['id', 'reservation_expires_at']);
        const refreshedExpiresAt = refreshed?.reservation_expires_at || null;
        logger.info('[slot-reservation] refreshed existing hold', {
          estimateId,
          slotId,
          scheduledServiceId: sameSlotHold.id,
          expiresAt: refreshedExpiresAt instanceof Date ? refreshedExpiresAt.toISOString() : refreshedExpiresAt,
        });
        return { scheduledServiceId: refreshed?.id || sameSlotHold.id, expiresAt: refreshedExpiresAt };
      }
      if ((liveHolds || []).length) {
        await trx('scheduled_services').whereIn('id', liveHolds.map((hold) => hold.id)).del();
      }

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
        const zoneSlug = zoneSlugOf(reserveZone);
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

      // Tech-blind occupancy backstop (ORDERING CONTRACT: every rung-1
      // holder runs the global predicate under the date lock before
      // committing). The two checks above stay as fast paths but are
      // NARROW: the first sees only THIS slot's tech, the second only
      // technician-NULL rows in a RESOLVED zone — a committed visit for a
      // different tech, or any visit at all when zone resolution failed,
      // matches neither, and a hold created over a committed visit is a
      // guaranteed dead end (the graduation 409s and the customer loops on
      // offer->reserve->409). includeHolds:false on purpose: COMMITTED
      // visits only. Hold-vs-hold coexistence stays governed by the
      // tech/zone checks above — of two live holds those checks permit,
      // whichever GRADUATES second is stopped by commitReservation's own
      // probe. This estimate's stale holds were refreshed or deleted
      // above, inside this txn, so no self-exclusion is needed.
      const committedClash = await findConflictingVisits({
        db: trx,
        date,
        windowStart,
        windowEnd,
        includeHolds: false,
      });
      if (committedClash.length) {
        const err = new Error('slot no longer available');
        err.code = 'SLOT_UNAVAILABLE';
        err.slotId = slotId;
        throw err;
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
        // One-time accepts are a single visit — pin is_recurring=false so
        // dispatch job-classification and recurring-only sweeps never treat
        // them as a series. Recurring reserves are left to the column default
        // (false) + the converter/seeder, which flips the parent to recurring.
        ...(serviceMode === 'one_time' ? { is_recurring: false } : {}),
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
    if (reserved && reserved.staleHoldSuperseded) {
      // Post-commit throw so the supersede above sticks (the finally still
      // invalidates the availability cache). Same error shape as the
      // fresh-reserve conflict path: the client re-fetches availability,
      // which now excludes the occupied window.
      const err = new Error('slot no longer available');
      err.code = 'SLOT_UNAVAILABLE';
      err.slotId = slotId;
      throw err;
    }
    return reserved;
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
    // RUNG 1 — date-wide occupancy lock, FIRST (see the ORDERING CONTRACT in
    // scheduling/occupancy.js). Committing a hold is a real occupancy write:
    // it graduates the row to a live booking and can WIDEN window_end, since
    // the commit-time duration is resolved from the accepted service profile
    // and may exceed the held one. The conflict check below is tech-scoped
    // ONLY when the row carries a technician — an unassigned hold makes it
    // date-wide/tech-blind outright — and this path takes no tech or zone
    // lock at all, so rung 1 is the only thing serializing it against the
    // rebooker and the self-booking confirms.
    //
    // Taken BEFORE the FOR UPDATE row lock on purpose: a writer already
    // holding the date lock may need this row, so grabbing the row first and
    // then waiting on the date lock would invert the order. scheduled_date is
    // read without a lock to key it; if the row moved dates in between, the
    // date lock we hold is the wrong one — fail into the same
    // RESERVATION_EXPIRED recovery the accept flow already handles (the
    // customer re-picks a time) rather than taking a second date lock and
    // opening a two-key inversion.
    const preRow = await client('scheduled_services')
      .where({ id: scheduledServiceId })
      .first('scheduled_date');
    if (!preRow) {
      const err = new Error('reservation not found');
      err.code = 'RESERVATION_NOT_FOUND';
      throw err;
    }
    const lockedDate = dateOnly(preRow.scheduled_date);
    if (lockedDate) await acquireOccupancyLock(client, lockedDate);

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
    if (dateOnly(row.scheduled_date) !== lockedDate) {
      const err = new Error('reservation moved to another date');
      err.code = 'RESERVATION_EXPIRED';
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

    // Owner blackout re-check at COMMIT: the admin may have blacked the day
    // out between the customer's reserve and their accept — the hold must
    // not graduate onto a day off. Same expired-reservation recovery path
    // the accept flow already handles (customer re-picks a time).
    {
      const { isBlackoutDate } = require('./scheduling/blackout-dates');
      if (await isBlackoutDate(row.scheduled_date)) {
        const err = new Error('that day is no longer available');
        err.code = 'RESERVATION_EXPIRED';
        throw err;
      }
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

    // Tech-blind occupancy backstop (ORDERING CONTRACT: every rung-1 holder
    // runs the global predicate under the date lock before committing).
    // Graduating the hold commits real occupancy, and the narrow check
    // above is tech-scoped when the row carries a technician — and SKIPPED
    // ENTIRELY when no accept-time duration resolved, though the row
    // occupies its held window either way (probe end falls back to the
    // held window_end, then to the module's duration-or-60 convention).
    // includeHolds:false + excluding this hold's own row: the probe
    // arbitrates against COMMITTED visits — of two overlapping live holds
    // the reserve-time checks permitted, first-to-graduate wins and this
    // stops the second. Same RESERVATION_EXPIRED-style recovery as every
    // other commit failure: the customer re-picks a time.
    const probeWindowEnd = windowEnd
      || row.window_end
      || (windowStart
        ? addMinutesToTime(windowStart, Number(row.estimated_duration_minutes) > 0
          ? Number(row.estimated_duration_minutes)
          : DEFAULT_DURATION_MINUTES)
        : null);
    if (scheduledDate && windowStart && probeWindowEnd) {
      const committedClash = await findConflictingVisits({
        db: client,
        date: scheduledDate,
        windowStart,
        windowEnd: probeWindowEnd,
        excludeServiceIds: [scheduledServiceId],
        includeHolds: false,
      });
      if (committedClash.length) {
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
      updates.service_type = canonicalServiceTypeForProfile(serviceProfile, row.service_type, { serviceMode });
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

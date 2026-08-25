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

// Cadence labels are EXACT catalog `services.name` values — the completion
// resolver's name fallback and the protocol-button alias table both match by
// string, and the old bare forms ("Quarterly Pest Control") matched nothing:
// 152 estimate-born visits in 90 days booked with no catalog identity at all
// (2026-08-25 audit). Every literal here must stay equal to its catalog row.
function pestServiceTypeFromVisits(visitsPerYear) {
  const visits = Number(visitsPerYear);
  if (Number.isFinite(visits) && visits >= 12) return 'Monthly Pest Control Service';
  if (Number.isFinite(visits) && visits >= 6) return 'Bi-Monthly Pest Control Service';
  // Semiannual (2/yr) had NO branch and mislabeled as quarterly — the one
  // cadence where the wrong prefix misstates the plan the customer bought.
  if (Number.isFinite(visits) && visits === 2) return 'Semiannual Pest Control Service';
  return 'Quarterly Pest Control Service';
}

function lawnServiceTypeFromVisits(visitsPerYear) {
  const visits = Number(visitsPerYear);
  if (Number.isFinite(visits) && visits >= 12) return 'Monthly Lawn Care Service';
  if (Number.isFinite(visits) && visits >= 9) return 'Every 6 Weeks Lawn Care Service';
  if (Number.isFinite(visits) && visits >= 6) return 'Bi-Monthly Lawn Care Service';
  // Unknown cadence: keep the legacy abbreviation — deliberately ambiguous,
  // so resolution fails closed instead of guessing a plan row.
  return 'Lawn Care';
}

function mosquitoServiceTypeFromVisits(visitsPerYear) {
  const visits = Number(visitsPerYear);
  if (Number.isFinite(visits) && visits >= 12) return 'Monthly Mosquito Control Service';
  if (Number.isFinite(visits) && visits >= 9) return 'Seasonal Mosquito Control Service';
  return 'Mosquito Treatment';
}

function treeShrubServiceTypeFromVisits(visitsPerYear) {
  const visits = Number(visitsPerYear);
  if (Number.isFinite(visits) && visits >= 9) return 'Every 6 Weeks Tree & Shrub Care Service';
  if (Number.isFinite(visits) && visits >= 6) return 'Bi-Monthly Tree & Shrub Care Service';
  if (Number.isFinite(visits) && visits >= 4) return 'Quarterly Tree & Shrub Care Service';
  return 'Tree & Shrub';
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

  // One-time branches deliberately keep the LEGACY ambiguous labels: the
  // category collapses every pest/lawn specialty into one key, so a
  // canonical one-time name here would resolve the generic one-time row
  // for work that is actually a specialty (a "Lawn Pest Knockdown" line
  // carries the shared one_time_lawn key — codex #3485 r1 P1). Canonical
  // one-time names come ONLY from the engine-key catalog link, which
  // resolves the specific row or nothing.
  if (key === 'pest_control') return isOneTime ? 'Pest Control' : pestServiceTypeFromVisits(primary?.visitsPerYear);
  if (key === 'lawn_care') return isOneTime ? 'Lawn Care' : lawnServiceTypeFromVisits(primary?.visitsPerYear);
  if (key === 'mosquito') return isOneTime ? 'Mosquito Treatment' : mosquitoServiceTypeFromVisits(primary?.visitsPerYear);
  if (key === 'tree_shrub') return treeShrubServiceTypeFromVisits(primary?.visitsPerYear);
  // Legacy short-name form: the catalog row's NAME is admin-editable (prod
  // already diverges from the migration-shipped value), so the fallback
  // keeps the unique "Termite Bait" short-name lookup that already worked;
  // the canonical name comes from the engine-key link (codex #3485 r1 P1).
  if (key === 'termite_bait') return 'Termite Bait';
  if (key === 'foam_recurring') return 'Recurring Termite Foam Service';
  if (key === 'foam_drill') return 'Termite Foam Service';
  if (key === 'palm_injection') return 'Palm Injection';
  if (key === 'rodent_trapping') return 'Rodent Trapping Service';
  if (key === 'rodent_exclusion') return 'Rodent Exclusion Service';
  if (key === 'rodent_sanitation') return 'Rodent Sanitation Service';
  if (key === 'rodent_bait') return 'Rodent Bait';
  return cappedServiceType(fallback);
}

// Catalog link for the accepted service — the ID, not the label.
//
// `service_type` above is a DISPLAY string, and its whitelist silently
// returns the estimate's `service_interest` verbatim for any engine key it
// doesn't list. Every one-time engine key observed on accepted estimates in
// prod falls through that way (`pre_slab_termiticide`, `german_roach`,
// `stinging_insect`), producing a label that matches no `services` row — so
// resolveCompletionProfileForScheduledService degrades to the GENERIC
// profile. That silently kills typed one-time billing (no invoice ⇒ the
// card-hold completion charge never fires, since it is gated on
// `if (invoice?.id)`) AND the compliance-project lane (a pre-slab visit could
// not produce its certificate of compliance).
//
// lookupServiceForScheduledService checks `service_id` FIRST, so stamping the
// id makes profile resolution label-independent — without changing a single
// customer-facing string. The primary service is chosen with the SAME rule
// the label uses, so the id and the label can never describe different
// services on one row.
//
// FAIL-OPEN by design: an unmapped engine key, a missing column (a deploy
// that lands before the migration), or any lookup error leaves service_id
// null and the accept books exactly as it does today.
//
// Runs in a SAVEPOINT (pre-push Codex P1; same failure mode and same fix as
// inspection-credit's booking marker, Codex #3178 r4 P1). Both callers hand
// us a TRANSACTION, and Postgres aborts the ENTIRE transaction after any
// failed statement — so a plain try/catch around this SELECT would NOT leave
// the caller's transaction usable. A deploy that lands before its migration
// (engine_key absent) would then fail the reservation insert with "current
// transaction is aborted" and take down estimate acceptance itself: the exact
// opposite of the fail-open contract this helper promises. The savepoint
// confines any failure to this read.
// Cadence families share ONE engine key across their per-cadence catalog
// rows, so containment can never resolve them — but the cadence rows have
// stable service_keys, and (category × visits/yr) names exactly one. Keyed
// resolution is environment-proof where the label whitelist is not: the
// rows' NAMES are admin-editable and already diverge between prod and
// migration-built databases (codex #3485 r3 P1, monthly mosquito). Only
// finite visit counts map; an unknown cadence stays unlinked (fail open).
function cadenceCatalogKeyForProfile(primary, isOneTime) {
  if (isOneTime || !primary) return null;
  const visits = Number(primary.visitsPerYear);
  if (!Number.isFinite(visits) || visits <= 0) return null;
  const key = String(primary.service || '');
  if (key === 'pest_control') {
    if (visits >= 12) return 'pest_general_monthly';
    if (visits >= 6) return 'pest_general_bimonthly';
    if (visits >= 4) return 'pest_general_quarterly';
    if (visits === 2) return 'pest_general_semiannual';
    return null;
  }
  if (key === 'lawn_care') {
    if (visits >= 12) return 'lawn_care_monthly';
    if (visits >= 9) return 'lawn_care_6week';
    if (visits >= 6) return 'lawn_care_recurring';
    // 4-application Basic tier: the PUBLIC accept path 409s this retired
    // cadence, but legacy/admin-carried 4-visit lawn profiles still reach
    // commit and the lawn_care_quarterly row is active (codex P1).
    if (visits >= 4) return 'lawn_care_quarterly';
    return null;
  }
  if (key === 'mosquito') {
    if (visits >= 12) return 'mosquito_monthly';
    if (visits >= 9) return 'mosquito_seasonal';
    return null;
  }
  if (key === 'tree_shrub') {
    if (visits >= 9) return 'tree_shrub_6week';
    if (visits >= 6) return 'tree_shrub_program';
    if (visits >= 4) return 'tree_shrub_quarterly';
    return null;
  }
  return null;
}

async function catalogLinkForProfile(conn, serviceProfile = {}) {
  const services = Array.isArray(serviceProfile?.services) ? serviceProfile.services : [];
  const primary = services.find((svc) => svc?.service === 'pest_control') || services[0] || null;
  // `service` is the DISPLAY CATEGORY — pest specialties (german_roach,
  // stinging_insect) all collapse to 'pest_control', which is keyed to nothing
  // in the catalog. `engineKey` is the row's RAW pricing-engine key, carried
  // through by oneTimeProfileServices for exactly this lookup (codex #3328 r1
  // P1); recurring rows have no engineKey, so their category IS their identity.
  // NO fallback from an unmapped engineKey to the category: stamping a
  // specialty visit with the generic category's catalog row would be a WRONG
  // identity (wrong billing, wrong completion profile), which is worse than
  // leaving it null and failing open.
  const engineKey = String(primary?.engineKey || primary?.service || '').trim();
  if (!conn || typeof conn.transaction !== 'function' || !engineKey) return null;
  const isOneTime = serviceProfile?.serviceMode === 'one_time';
  const cadenceKey = cadenceCatalogKeyForProfile(primary, isOneTime);
  let resolved = null;
  try {
    await conn.transaction(async (sp) => {
      // Containment, not equality: engine_keys is a jsonb ARRAY because the
      // engine emits versioned aliases for one catalog service
      // (stinging_insect + stinging_insect_v2 → bee_wasp_removal). Codex
      // #3328 r2 P1.
      //
      // FAIL CLOSED on ambiguity (codex #3328 r3 P1): a jsonb array column
      // cannot carry a scalar unique index, so nothing at the DB level stops an
      // admin edit or a future migration from giving the same engine key to two
      // ACTIVE rows. An unordered `.first()` would then pick NONDETERMINISTICALLY
      // and could stamp the wrong billing/completion lane — strictly worse than
      // no stamp, which merely reverts to today's behavior. Take two and resolve
      // only on exactly one. The DB-backed contract test catches drift at CI
      // time; this is the runtime guard that CI cannot provide.
      const rows = await sp('services')
        .whereRaw('engine_keys @> ?::jsonb', [JSON.stringify([engineKey])])
        .andWhere({ is_active: true })
        .limit(2)
        .select('id', 'name', 'service_key');
      if (rows.length === 1) {
        resolved = rows[0];
      } else if (rows.length > 1) {
        logger.error(`[slot-reservation] engine key "${engineKey}" is claimed by MULTIPLE active catalog rows — refusing to stamp service_id (fix the duplicate engine_keys)`);
        return;
      }
      // Cadence-keyed fallback (codex #3485 r3 P1): the shared family key
      // resolved nothing by containment, but the cadence names exactly one
      // service_key — resolve it directly, same fail-closed posture.
      if (!resolved && cadenceKey) {
        const cadenceRows = await sp('services')
          .where({ service_key: cadenceKey, is_active: true })
          .limit(2)
          .select('id', 'name', 'service_key');
        if (cadenceRows.length === 1) resolved = cadenceRows[0];
      }
    });
  } catch (err) {
    // The savepoint rolled back; the caller's transaction is still healthy and
    // the accept MUST still commit. An unresolved link is recoverable (the
    // visit books, completion falls back to the generic profile exactly as it
    // did before this change); a broken accept is not.
    logger.warn(`[slot-reservation] catalog lookup failed for engine key "${engineKey}": ${err.message}`);
    return null;
  }
  return resolved;
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
  serviceCadences = null,
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
  // route clamps ?windowDays and the AI date search caps maxDaysOut there) —
  // EXCEPT seasonal selections in the winter gap, whose window opens at the
  // next Feb 1 (codex r10 P2: on Nov 1–2 that is 91–92 days out). The widest
  // horizon ANY selection could have needs only today's date
  // (seasonalMaxHorizonDays === the standard 90 while in season), so slots
  // past it still reject PRE-txn with no db work; a date between the
  // standard and seasonal ceilings is noted and adjudicated against the
  // estimate's profile inside the transaction below.
  const outerHorizonDays = typeof estimateSlotAvailability.seasonalMaxHorizonDays === 'function'
    ? estimateSlotAvailability.seasonalMaxHorizonDays()
    : MAX_SLOT_HORIZON_DAYS;
  if (date > etDateString(addETDays(new Date(), outerHorizonDays))) {
    const err = new Error('slot date is beyond the booking horizon');
    err.code = 'SLOT_UNAVAILABLE';
    err.slotId = slotId;
    throw err;
  }
  const beyondStandardHorizon = date > etDateString(addETDays(new Date(), MAX_SLOT_HORIZON_DAYS));

  // Numeric coerce + bound the hold window so we can safely interpolate it
  // into a Postgres INTERVAL string below.
  const holdMins = Math.max(1, Math.min(120, Number(holdMinutes) || DEFAULT_HOLD_MINUTES));

  // Resolve the estimate's coordinates BEFORE the transaction (geocode is a
  // network call — 24h-cached and warm from the slots fetch, but never worth
  // holding the occupancy/row locks for). Stamped onto the hold row below so
  // find-time treats a live hold as a route anchor: without coords a hold is
  // silently zero drive time in the detour math, and a multi-property group's
  // second slot picker can't rank same-day/nearby windows around the first
  // property's fresh hold. Best-effort — a geocode miss books exactly as
  // before.
  let holdCoords = null;
  let holdCoordsAddress = null;
  try {
    const estimateForCoords = await db('estimates').where({ id: estimateId }).first('id', 'customer_id', 'address');
    if (estimateForCoords && typeof estimateSlotAvailability.resolveEstimateCoords === 'function') {
      const coords = await estimateSlotAvailability.resolveEstimateCoords(estimateForCoords);
      if (coords && Number.isFinite(Number(coords.lat)) && Number.isFinite(Number(coords.lng))) {
        holdCoords = { lat: Number(coords.lat), lng: Number(coords.lng) };
        // Snapshot the address these coords describe: the reservation txn
        // re-reads the estimate under lock and must drop the coords if a
        // concurrent revision changed the property (codex #3244 r7).
        holdCoordsAddress = String(estimateForCoords.address || '');
      }
    }
  } catch (geoErr) {
    logger.warn(`[slot-reservation] hold coords resolve skipped for estimate ${estimateId}: ${geoErr.message}`);
  }

  try {
    const reserved = await db.transaction(async (trx) => {
      // RUNG 1 — date-wide occupancy lock, FIRST, before ANY row lock this
      // txn takes (ORDERING CONTRACT, scheduling/occupancy.js — the
      // row-lock rule). The key is the requested slot's date, straight from
      // the slotId — available before any row is read, so nothing forces a
      // read-then-lock detour here. Taking the estimate FOR UPDATE first
      // (the old order) deadlocked against createSelfBooking: that writer
      // holds rung 1 while its insert's source_estimate_id FK takes KEY
      // SHARE on this same estimate row — blocked by our FOR UPDATE —
      // while this txn sat waiting on its rung 1. The hold row inserted
      // below is customer-NULL but findConflictingVisits COUNTS live
      // holds, so this path is a real occupancy writer and owes the date
      // lock regardless.
      await acquireOccupancyLock(trx, date);

      // SELECT … FOR UPDATE on the estimate row serializes concurrent
      // reserves/accepts/declines for this estimate. Without this lock,
      // status/expiry checks could be made against committed state that
      // changes by the time we INSERT below. The `_expired` derived flag
      // does the expiry comparison in Postgres so server clock skew across
      // app instances can't bypass the gate. Safe AFTER rung 1 (row locks
      // never precede it), and rungs 3+4 below are safe after this row
      // lock: same-date rungs are only ever taken while holding rung 1, so
      // no other txn can hold them while we do — they can't block.
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

      // Revalidated on the LOCKED row (pre-push P1, PR #3304): the route's
      // archive/marker/call-side guards ran before this transaction opened,
      // and an invalidation committing in between would still mint a
      // scheduled-service hold for a quarantined estimate. Scoped to engine
      // drafts; the same generic not-found the route's call-side guard
      // returns, so quarantined tokens stay indistinguishable from missing
      // ones.
      {
        const reservationData = (() => {
          try {
            const d = typeof estimate.estimate_data === 'string'
              ? JSON.parse(estimate.estimate_data) : (estimate.estimate_data || {});
            return d && typeof d === 'object' ? d : null;
          } catch { return null; }
        })();
        const eng = reservationData?.estimatorEngine;
        if (eng?.callLogId) {
          const { callSideBlockForEstimateData } = require('../utils/estimate-claim-sql');
          // Lock the call row and HOLD it through the reservation commit
          // (codex P1, PR #3304 — generation-rework GH round), mirroring
          // the deposit-confirm and manual-acceptance paths: with only an
          // awaited read, a linkage correction starting after the verdict
          // returned could repoint the call while its estimate
          // invalidation waited on our estimate row lock — the hold would
          // then commit for the just-invalidated estimate and consume real
          // capacity until expiry. Lock order holds: occupancy rung →
          // estimates → call_log; no leads lock is taken in this txn, so
          // no cycle with the processor's leads → call_log writers.
          await trx('call_log').where({ id: eng.callLogId }).forUpdate().first('id');
          const blocked = estimate.archived_at || eng.linkage_invalidated_at
            || eng.invalidation_pending_at
            || await callSideBlockForEstimateData(trx, reservationData);
          if (blocked) {
            const err = new Error('estimate is quarantined by a call-linkage correction');
            err.code = 'ESTIMATE_NOT_FOUND';
            throw err;
          }
        }
      }

      const serviceProfile = estimateSlotAvailability.resolveEstimateSlotProfile
        ? estimateSlotAvailability.resolveEstimateSlotProfile(estimate, {
          serviceMode,
          selectedFrequency,
          serviceCadences,
          durationMinutes,
        })
        : null;
      // Seasonal (Feb–Oct) redemption re-check (codex r8 P1): the slot LIST
      // is season-filtered for a seasonal mosquito selection, but the offer
      // HMAC does not bind the frequency — a list fetched under monthly12
      // (where winter dates are legitimately offered) could be redeemed with
      // selectedFrequency seasonal9, and the converter would then seed the
      // series from a Nov–Jan parent, counting a prohibited winter visit
      // toward the nine. Office/admin bookings don't come through this route.
      // Guarded like resolveEstimateSlotProfile above — suites mock the
      // availability module down to the functions they assert on.
      const seasonalSelection = !!serviceProfile
        && typeof estimateSlotAvailability.seasonalSelectionProfile === 'function'
        && estimateSlotAvailability.seasonalSelectionProfile(serviceProfile);
      if (seasonalSelection
        && typeof estimateSlotAvailability.inMosquitoSeason === 'function'
        && !estimateSlotAvailability.inMosquitoSeason(date)) {
        const err = new Error('This seasonal program runs February through October — pick an in-season date.');
        err.code = 'SLOT_UNAVAILABLE';
        err.slotId = slotId;
        throw err;
      }
      // Deferred horizon adjudication (see the pre-txn note): standard callers
      // keep the 90-day ceiling; a seasonal selection may reach the extended
      // winter-gap horizon its slot list was generated with.
      if (beyondStandardHorizon) {
        const allowedDays = seasonalSelection
          && typeof estimateSlotAvailability.seasonalMaxHorizonDays === 'function'
          ? estimateSlotAvailability.seasonalMaxHorizonDays()
          : MAX_SLOT_HORIZON_DAYS;
        if (date > etDateString(addETDays(new Date(), allowedDays))) {
          const err = new Error('slot date is beyond the booking horizon');
          err.code = 'SLOT_UNAVAILABLE';
          err.slotId = slotId;
          throw err;
        }
      }
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
      const displayServiceLabel = cappedServiceType(serviceProfile?.serviceLabel || estimate.service_interest);
      const notes = notesWithServiceMix(null, serviceProfile, estimate.service_interest);
      // Catalog link — see catalogLinkForProfile. Stamped on the HOLD so the
      // graduated visit carries it even if the profile can't be re-resolved
      // at commit; commitReservation backfills it when this returns null.
      // When the engine key resolves a unique catalog row, THAT row's name is
      // the visit label — one source of truth instead of a parallel
      // whitelist; the whitelist handles cadence families whose shared engine
      // key can't resolve a single row, and unmapped keys keep the legacy
      // service_interest fallback.
      const catalogLink = await catalogLinkForProfile(trx, serviceProfile);
      const catalogServiceId = catalogLink ? catalogLink.id : null;
      const serviceType = catalogLink?.name
        ? cappedServiceType(catalogLink.name)
        : canonicalServiceTypeForProfile(serviceProfile, estimate.service_interest, { serviceMode });

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

      // RUNGS 3 + 4 (tech, then zone) — rung 1 was taken at the top of this
      // txn. These stay REQUIRED even under the date lock: rung 1 alone only
      // serializes writers that take it, while the narrow tech/zone conflict
      // checks below also arbitrate hold-vs-hold coexistence, which the
      // global probe deliberately leaves to them (includeHolds:false). The
      // estimate FOR UPDATE above only serializes THIS estimate — two
      // different customers' estimates reserving the same tech/date meet
      // HERE. Serialize all reserves per tech+day (coarse but reserves are
      // quick), released on commit/rollback.
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
            if (zoneCities.length) {
              // Case-insensitive: customer rows carry free-text city casing
              // ("BRADENTON", "lakewood ranch") — the estimate generator
              // lowercases both sides, so an exact-case IN here would let a
              // conflicting row slip past the zone-capacity check.
              const lowered = zoneCities.map((city) => String(city || '').toLowerCase());
              q.orWhereRaw(
                `LOWER(customers.city) IN (${lowered.map(() => '?').join(', ')})`,
                lowered,
              );
            }
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
      // No customer-comms rung here (occupancy.js rung 6): this insert is a
      // customer_id-NULL hold, invisible to the merge-undo's winner-scoped
      // probes; graduation onto a customer happens in commitReservation's
      // caller, which locks.
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
        ...(catalogServiceId ? { service_id: catalogServiceId } : {}),
        // Durable identity evidence: the completion resolver checks
        // service_key_snapshot right after service_id, so the stamp
        // survives even a later admin repoint of the catalog row.
        ...(catalogLink?.service_key ? { service_key_snapshot: catalogLink.service_key } : {}),
        // Geo stamp (best-effort): coords make the hold a real route anchor
        // for find-time's detour math; the zone slug lets the zone-capacity
        // conflict check see holds directly instead of via the (absent)
        // customer city. Both were previously never written on holds.
        // Coords only when the locked row still quotes the address they were
        // geocoded from — a concurrent revision that moved the property must
        // not anchor routing at the old location (codex #3244 r7). Address
        // drift drops the geo stamp; the hold books exactly as before.
        ...(holdCoords && holdCoordsAddress === String(estimate.address || '')
          ? { lat: holdCoords.lat, lng: holdCoords.lng } : {}),
        ...(zoneSlugOf(reserveZone) ? { zone: zoneSlugOf(reserveZone) } : {}),
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
 * When the caller's transaction pre-acquired this hold's rung-1 date lock at
 * its own start (the estimate-accept txn does — see the ORDERING CONTRACT in
 * scheduling/occupancy.js), it passes the key it locked as `preLockedDate`.
 * The unlocked pre-read below is then RE-CHECKED against it: a hold that
 * moved dates in between fails into RESERVATION_EXPIRED instead of this
 * function acquiring the new date's key mid-txn (an unsorted second date
 * key — the exact inversion shape the contract bans). When the dates match,
 * the acquisition below is a reentrant no-op (pg advisory xact locks are
 * re-acquirable by the owning transaction).
 *
 * opts: { scheduledServiceId, customerId, paymentMethodPreference?, estimatedPrice?, preLockedDate?, trx? }
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
  preLockedDate = null,
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
    //
    // When handed the estimate-accept transaction, that txn ALREADY holds
    // this key: it pre-acquires rung 1 as its first statements — before its
    // estimates UPDATE / customers insert take row locks — and passes the
    // locked key down as preLockedDate (checked against the pre-read below).
    const preRow = await client('scheduled_services')
      .where({ id: scheduledServiceId })
      .first('scheduled_date');
    if (!preRow) {
      const err = new Error('reservation not found');
      err.code = 'RESERVATION_NOT_FOUND';
      throw err;
    }
    const lockedDate = dateOnly(preRow.scheduled_date);
    // Caller pre-locked rung 1 (the accept txn, at its start, before its
    // estimate/customer row locks): if the hold moved dates between the
    // caller's unlocked read and now, the caller holds the WRONG key —
    // and acquiring the moved-to date's key here, mid-txn and unsorted,
    // would open the two-key inversion the contract's read→lock→re-check
    // pattern exists to prevent. Fail into the same RESERVATION_EXPIRED
    // recovery the accept flow already handles (the customer re-picks a
    // time) WITHOUT taking any lock.
    if (preLockedDate && lockedDate !== dateOnly(preLockedDate)) {
      const err = new Error('reservation moved off the pre-locked date');
      err.code = 'RESERVATION_EXPIRED';
      throw err;
    }
    // Reentrant no-op when the caller pre-locked this same key; kept
    // unconditional so the standalone path still takes rung 1 first.
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
      updates.notes = notesWithServiceMix(row.notes, serviceProfile, row.service_type);
      // The catalog link is RESTAMPED from the accepted profile, in the same
      // block that recomputes the label — id and label must describe the same
      // service, and the accept is authoritative over the hold.
      //
      // This deliberately OVERWRITES the reserve-path stamp (codex #3328 r6
      // P1). The earlier "never overwrite" guard was meant to protect an admin
      // repoint, but on a graduating hold there is no repoint to protect: the
      // row is a 15-minute reservation with customer_id NULL, invisible as a
      // customer visit, so any id on it is reserve-DERIVED by construction.
      // Meanwhile the accept-side reservation lookup binds only
      // estimate/date/start/technician — NOT the reserved service mode — so a
      // hold reserved as a mapped one-time specialty can be accepted in
      // recurring mode. Preserving the hold's id there would commit recurring
      // pricing and scheduling carrying a german-roach / bee-wasp / pre-slab
      // catalog ID, and completion resolution trusts `service_id` BEFORE the
      // label — the wrong billing and compliance lane.
      //
      // Assigned unconditionally, including null: if the accepted profile
      // resolves to nothing, a stale specialty id must be CLEARED, not kept.
      // Same rule for the snapshot and the label: id, key, and label must
      // describe the same accepted service.
      const commitLink = await catalogLinkForProfile(client, serviceProfile);
      updates.service_id = commitLink ? commitLink.id : null;
      updates.service_key_snapshot = commitLink?.service_key || null;
      updates.service_type = commitLink?.name
        ? cappedServiceType(commitLink.name)
        : canonicalServiceTypeForProfile(serviceProfile, row.service_type, { serviceMode });
    }

    const [updated] = await client('scheduled_services')
      .where({ id: scheduledServiceId })
      .update(updates)
      .returning('*');

    // Inspection credit: graduating a held slot IS the customer's booking —
    // both estimate-accept branches (one-time and recurring) land here, and
    // the one-time path never reaches the converter's marker. Written on
    // the SAME client so the evidence commits with the graduation; the
    // sweep mints from it. Savepoint-isolated and never throws.
    await require('./inspection-credit').markBookingForInspectionCredit(client, {
      customerId,
      scheduledServiceId,
      source: 'estimate_accept',
    });

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
  // Canonical service_type normalization — appointment-reminders'
  // estimate-backed label recovery compares stored fall-through values
  // against this exact transform, so it must reuse it, never re-implement.
  cappedServiceType,
  // Catalog-identity authority for accepted-estimate stamps. The adopted-
  // appointment path (estimate-public adoptedAppointmentCatalogStamp) reuses
  // it so identity has exactly one resolver — never re-implement the
  // engine-key containment lookup.
  catalogLinkForProfile,
  _internals: {
    parseSlotId,
    addMinutesToTime,
    cappedServiceType,
    canonicalServiceTypeForProfile,
    notesWithServiceMix,
    catalogLinkForProfile,
  },
};

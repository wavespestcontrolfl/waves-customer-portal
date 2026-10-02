'use strict';

/**
 * Cancel-flow C2 — the two "away" mechanisms (ruling C-4). Pause is NOT a
 * product: these run ONLY from an accepted resolution card inside the
 * cancel flow.
 *
 * Away Mode (pest): exterior-only visits continue; nobody needs to be home;
 * reports still send; price and tier unchanged. Persisted as
 * property_preferences.away_mode_until — the dispatch/tech surfaces read it.
 *
 * Hold (lawn / mosquito / tree & shrub), owner rulings 2026-09-29:
 *  1. Visits that fall while the customer is away are SKIPPED; the next
 *     visit is simply the series' next regular one — nothing is pulled
 *     earlier or pushed later. A PREPAID visit inside the pause is never
 *     lost: it is moved to after the return date instead.
 *  2. The family's monthly component is suspended for the pause
 *     (held_monthly_rate restored on the return date). With no visit
 *     inside the away dates there is nothing to pause, and no hold (no
 *     free month).
 *  3. The restart text goes out 7 days before the first visit back and
 *     names that visit's real date — right away when it is under 7 days
 *     out. Nothing is ever shifted to make room for the notice.
 *  4. Once per family per 12 months; a hold that was undone (cancelled)
 *     does not count. ≤ 180 days.
 * The WaveGuard tier is protected (customers.tier_protected_until) through
 * the return date so the bundle price stays locked.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, dateOnlyString } = require('../../utils/datetime-et');
const { CANCELLABLE_STATUSES, LIVE_TRACK_STATES } = require('../cancellation-eligibility');
const { lockCustomerComms } = require('../../utils/customer-comms-lock');
const { resolveBillingLane } = require('../billing-lane');

const HOLDABLE_FAMILIES = ['lawn_care', 'mosquito', 'tree_shrub'];
const COUNTED_HOLD_STATUSES = ['active', 'resumed'];

function codedError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

// pg hydrates every DATE column here (scheduled_date, resume_on,
// tier_protected_until) as a Date, and String() of one reads "Mon Oct 05 …":
// read them through dateOnlyString, never String(…).slice(0, 10). ymd() is
// for the customer's typed dates, which arrive as strings.
function ymd(value) {
  const s = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

function displayDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// A real appointment: not a pending-rebook placeholder, and not a
// dispatch-owned booking still pending the office's confirmation (call
// follow-up, outbound review, voice agent — DISPATCH_OWNED_PENDING_SOURCE_
// ACTIONS, the rows a customer may not even see yet). Neither makes a hold
// needed, gets skipped, or is named as the first visit back.
function isBookedAppointment(visit) {
  if (visit.status === 'rescheduled') return false;
  const { DISPATCH_OWNED_PENDING_SOURCE_ACTIONS } = require('../call-booking-source-actions');
  const awaitingOffice = visit.status === 'pending' && !visit.customer_confirmed
    && DISPATCH_OWNED_PENDING_SOURCE_ACTIONS.includes(visit.source_action);
  return !awaitingOffice;
}

// A booked visit dated inside the pause. A 'rescheduled' row is a pending-
// rebook placeholder, not an appointment (firstVisitBack skips it too): it
// neither makes a hold needed nor gets skipped.
function inPauseVisit(visit, startsOn, resume) {
  if (!isBookedAppointment(visit)) return false;
  const date = dateOnlyString(visit.scheduled_date);
  return !!date && date >= startsOn && date < resume;
}

async function familyUpcomingVisits(customerId, familyKey, dbh = db) {
  const { familyOfServiceRow } = require('../cancellation-processor');
  const today = etDateString();
  const rows = await dbh('scheduled_services as s')
    .leftJoin('services as sv', 's.service_id', 'sv.id')
    .where('s.customer_id', customerId)
    .whereIn('s.status', CANCELLABLE_STATUSES)
    .where(function dateOrRescheduled() {
      this.where('s.scheduled_date', '>=', today).orWhere('s.status', 'rescheduled');
    })
    .whereRaw("(s.track_state IS NULL OR s.track_state NOT IN ('complete', 'en_route', 'on_property'))")
    .orderBy('s.scheduled_date', 'asc')
    .select('s.*', 'sv.service_key', 'sv.name as service_name');
  return rows.filter((row) => familyOfServiceRow(row) === familyKey);
}

// The date startAwayMode writes for a requested return date.
function ymdOrDefaultAwayUntil(until) {
  return ymd(until) || addDays(etDateString(), 180);
}

async function startAwayMode({ customerId, caseId, until = null, holdIds = [] }) {
  const today = etDateString();
  const untilYmd = ymdOrDefaultAwayUntil(until);
  if (untilYmd <= today) throw codedError('away_date_invalid', 'The return date must be in the future');
  // The prior value is read, the preference replaced and — for a paired
  // accept — the recovery record written on its holds, all under ONE row
  // lock: a failed accept's restore (synchronous or recovery) can never put
  // back a value another accept replaced in between.
  const previousUntil = await db.transaction(async (trx) => {
    // The first row is created conflict-safely (customer_id is unique), so
    // two accepts racing on a customer with no row both reach the lock below
    // instead of one failing its insert.
    await trx('property_preferences').insert({ customer_id: customerId, created_at: new Date(), updated_at: new Date() }).onConflict('customer_id').ignore();
    const row = await trx('property_preferences').where({ customer_id: customerId }).forUpdate().first('id', 'away_mode_until');
    let previous = row.away_mode_until ? dateOnlyString(row.away_mode_until) : null;
    // A retry of the same accept keeps the value recorded by its first
    // attempt: by now the preference may already hold `until` (that attempt
    // wrote it), and re-reading it would make an undo restore `until` over
    // itself — leaving Away Mode on after the accept failed.
    const recorded = [];
    for (const holdId of holdIds || []) {
      const hold = await trx('plan_holds').where({ id: holdId }).forUpdate().first('moved_visits');
      if (!hold) continue;
      const record = readRecord(hold.moved_visits);
      // A record written before this accept's first write had no prior date
      // stored its previousUntil as a missing key (no row then): still the
      // first attempt's value, never the live one.
      if (record.awayPairing) previous = record.awayPairing.previousUntil ?? null;
      recorded.push({ holdId, record });
    }
    await trx('property_preferences').where({ id: row.id }).update({ away_mode_until: untilYmd, updated_at: new Date() });
    for (const { holdId, record } of recorded) {
      await trx('plan_holds').where({ id: holdId }).update({
        moved_visits: JSON.stringify({ ...record, awayPairing: { previousUntil: previous, until: untilYmd } }),
        updated_at: new Date(),
      });
    }
    return previous;
  });
  // previousUntil lets a paired accept that fails afterwards put the
  // preference back (restoreAwayMode).
  return { until: untilYmd, untilDisplay: displayDate(untilYmd), previousUntil };
}

// The staff timeline note for an Away Mode change, written only once the
// accept that made it stands — a rolled-back accept leaves no note claiming
// Away Mode is on.
async function noteAwayMode({ customerId, caseId, until }) {
  try {
    await db('customer_interactions').insert({
      customer_id: customerId,
      interaction_type: 'note',
      subject: `Away Mode until ${until} (cancel flow)`,
      body: `Case ${caseId}. Exterior-only visits while away; reports continue; price and tier unchanged.`,
    });
  } catch (err) { logger.warn(`[holds] away-mode note failed for ${customerId}: ${err.message}`); }
}

// Undo startAwayMode for an accept that failed after it: the preference
// returns to what it was (a row this accept created keeps a NULL date) —
// only while it still holds the date this accept wrote, so another accept's
// later write is never overwritten.
async function restoreAwayMode(customerId, previousUntil, writtenUntil) {
  await db('property_preferences').where({ customer_id: customerId, away_mode_until: writtenUntil })
    .update({ away_mode_until: previousUntil || null, updated_at: new Date() });
}

async function revertMoves(customerId, moved) {
  if (!moved || !moved.length) return;
  const SmartRebooker = require('../rebooker');
  for (const done of [...moved].reverse()) {
    try {
      // A compensating move back is not a schedule change the tech should
      // hear about — the forward move it undoes was never announced either.
      // Fenced on the hold's own destination: a dispatch edit since the
      // forward move wins (the office is belled below instead).
      await SmartRebooker.reschedule(done.id, done.from, done.window, 'plan_hold_revert', 'customer', {
        suppressTechNotice: true, seriesPolicy: 'single', visitPolicy: 'single',
        expect: pinnedSchedule(done.to, done.window),
      });
    } catch (revertErr) {
      logger.error(`[holds] revert of visit ${done.id} failed: ${revertErr.message}`);
      const { notifyAdmin } = require('../notification-service');
      await notifyAdmin('service', 'Plan hold aborted: visit needs a manual move back', `Visit ${done.id} was moved to ${done.to} for a hold that then failed — move it back to ${done.from}.`, {
        bell: true, dedupeKey: `plan_hold_revert_failed:${done.id}`, metadata: { kind: 'plan_hold_revert_failed', customerId, visitId: done.id },
      }).catch(() => {});
    }
  }
}

function validateHoldDates(familyKey, resumeOn, maxDays) {
  if (!HOLDABLE_FAMILIES.includes(familyKey)) throw codedError('hold_family_invalid', 'That service cannot be held');
  const today = etDateString();
  const resume = ymd(resumeOn);
  if (!resume || resume <= today) throw codedError('hold_date_invalid', 'Pick the date you are back');
  if (daysBetween(today, resume) > maxDays) throw codedError('hold_too_long', `A hold can run at most ${maxDays} days`);
  return { today, resume };
}

// Once per family per 12 months (rule 4) — a hold that was undone (status
// 'cancelled': compensated, obsolete, or churned) does not count.
function countedPriorHold(q, customerId, familyKey) {
  return q.where({ customer_id: customerId, family_key: familyKey })
    .whereIn('status', COUNTED_HOLD_STATUSES).where('created_at', '>=', new Date(Date.now() - 365 * 86400000)).first('id');
}

/**
 * Rule 2: no visit inside the away dates means nothing to pause — no hold,
 * no suspended dues, no free month. Decided BEFORE the once-a-year limit and
 * the billing checks (an away pairing takes it as success), and re-read
 * under the writer lock the real hold path takes, so a visit booked into
 * the pause meanwhile is never answered with "nothing to pause".
 */
async function notNeededOutcome({ customerId, familyKey, visits, today, resume }) {
  if (visits.some((v) => inPauseVisit(v, today, resume))) return null;
  const live = await db.transaction(async (trx) => {
    await lockCustomerComms(trx, customerId);
    return familyUpcomingVisits(customerId, familyKey, trx);
  });
  if (live.some((v) => inPauseVisit(v, today, resume))) throw codedError('hold_visits_changed', 'Your schedule just changed — please try again');
  // The next visit named to the customer comes from the locked read too.
  const next = live
    .filter(isBookedAppointment)
    .map((v) => dateOnlyString(v.scheduled_date))
    .filter((date) => date && date >= resume)
    .sort()[0] || null;
  return { notNeeded: true, familyKey, nextVisitOn: next, nextVisitDisplay: next ? displayDate(next) : null };
}

// Money first (fail closed): a monthly-lane family we cannot attribute
// cannot promise "no charges". Lane via the canonical resolver (#3140) —
// the monthly dues charge the hold suspends only exists on the
// monthly_membership lane (Codex #3669 r3 P2). Re-read under the lock
// before anything is written.
async function assertHoldEligible(customerId, familyKey) {
  if (await countedPriorHold(db('plan_holds'), customerId, familyKey)) {
    throw codedError('hold_cooldown', 'This service was already held in the last 12 months');
  }
  const customer = await db('customers').where({ id: customerId }).first('monthly_rate', 'billing_mode', 'waveguard_tier', 'tier_protected_until');
  if (resolveBillingLane(customer).mode !== 'monthly_membership') return;
  const component = await db('customer_plan_rates').where({ customer_id: customerId, family_key: familyKey }).first('monthly_rate');
  if (!component) throw codedError('hold_unattributed', 'We could not suspend billing for that service — call our office');
}

// A visit's schedule as read, pinned in the rebooker's CAS (`expect`): a
// dispatch edit or grouping since the read makes the move miss instead of
// moving a changed row. visit_id null makes visitPolicy 'single' safe —
// the row is provably not part of a stop.
function pinnedSchedule(date, window, status) {
  return {
    scheduled_date: date, window_start: window.start, window_end: window.end, visit_id: null,
    ...(status ? { status } : {}),
  };
}

/**
 * Move the prepaid visits inside the pause to after the return date (rule
 * 1: never lost). First lands on the return date, the rest keep their
 * spacing. Moves go FIRST (codex r1 P1) because they are reversible: one
 * that will not move reverts the others and refuses the hold.
 */
async function movePrepaidVisits(customerId, familyKey, toMove, resume) {
  const moved = [];
  // Holder on each COMMITTED move, for the tech notices sent only once the
  // whole accept stands — kept off the persisted moved_visits shape.
  const movedTechIds = new Map();
  if (!toMove.length) return { moved, movedTechIds };
  // A prepaid visit sharing a stop cannot move alone ("just this service"
  // is the office's split action): refused before anything is written.
  if (toMove.some((v) => v.visit_id)) {
    throw codedError('hold_visits_unmovable', 'One of your prepaid visits shares a stop with another service — call our office and we will set the hold up by hand');
  }
  const SmartRebooker = require('../rebooker');
  const delta = daysBetween(dateOnlyString(toMove[0].scheduled_date), resume);
  for (const visit of toMove) {
    const from = dateOnlyString(visit.scheduled_date);
    const to = addDays(from, delta);
    const window = { start: visit.window_start || null, end: visit.window_end || null };
    try {
      // suppressTechNotice: a later move or the hold write can still fail
      // and revert this. seriesPolicy 'single': a series move would carry
      // the regular visits after the return date along.
      const moveResult = await SmartRebooker.reschedule(visit.id, to, window, 'plan_hold', 'customer', {
        suppressTechNotice: true, seriesPolicy: 'single', visitPolicy: 'single',
        expect: pinnedSchedule(from, window, visit.status),
      });
      moved.push({ id: visit.id, from, to, window });
      movedTechIds.set(String(visit.id), moveResult?.technicianId || null);
    } catch (err) {
      logger.error(`[holds] visit ${visit.id} did not move for a ${familyKey} hold: ${err.message}`);
      await revertMoves(customerId, moved);
      throw codedError('hold_visits_unmovable', 'One of your prepaid visits could not be moved — call our office and we will set the hold up by hand');
    }
  }
  return { moved, movedTechIds };
}

/**
 * The hold row, the billing suspension and tier protection, ATOMICALLY
 * (codex P0), under rung 6 (scheduling/occupancy.js ORDERING CONTRACT: the
 * lock the scoped wind-down takes for the same ledger writes). Every fact
 * is re-read under the lock: a concurrent hold, a visit booked into or
 * moved out of the pause, a moved visit gone, or a lost monthly component
 * refuses the hold. Returns { holdId, heldRate }.
 */
async function writeHold(trx, { customerId, caseId, familyKey, today, resume, toSkip, moved }) {
  await lockCustomerComms(trx, customerId);
  if (await countedPriorHold(trx('plan_holds'), customerId, familyKey)) throw new Error('a hold for this family was written concurrently');
  const liveVisits = await familyUpcomingVisits(customerId, familyKey, trx);
  const liveInPause = liveVisits.filter((v) => inPauseVisit(v, today, resume)).map((v) => String(v.id)).sort();
  const skipIds = toSkip.map((v) => String(v.id)).sort();
  if (liveInPause.length !== skipIds.length || liveInPause.some((id, i) => id !== skipIds[i])) {
    throw new Error(`${familyKey} visits inside the pause changed before the hold could be written (live ${liveInPause.join(',')} vs planned ${skipIds.join(',')})`);
  }
  const liveIds = new Set(liveVisits.map((v) => String(v.id)));
  const lostMove = moved.find((m) => !liveIds.has(String(m.id)));
  if (lostMove) throw new Error(`moved prepaid visit ${lostMove.id} is no longer live`);
  const live = await trx('customers').where({ id: customerId }).first('monthly_rate', 'billing_mode', 'waveguard_tier', 'tier_protected_until');
  if (!live) throw new Error('customer vanished before the hold could be written');
  let heldRate = null;
  if (resolveBillingLane(live).mode === 'monthly_membership') {
    const liveComponent = await trx('customer_plan_rates').where({ customer_id: customerId, family_key: familyKey }).first('monthly_rate');
    if (!liveComponent) throw new Error(`${familyKey} lost its monthly component before the hold could be written`);
    heldRate = Number(liveComponent.monthly_rate) || 0;
  }
  const [hold] = await trx('plan_holds').insert({
    customer_id: customerId,
    cancellation_case_id: caseId || null,
    family_key: familyKey,
    starts_on: today,
    resume_on: resume,
    held_monthly_rate: heldRate,
    moved_visits: JSON.stringify({ moved, toSkip: toSkip.map((v) => ({ id: v.id, status: v.status, from: dateOnlyString(v.scheduled_date) })), skipped: [], skipsFinal: false, acceptCommitted: false }),
    status: 'active',
  }).returning(['id']);
  if (heldRate != null) {
    await trx('customer_plan_rates').where({ customer_id: customerId, family_key: familyKey })
      .update({ monthly_rate: 0, source: 'plan_hold', effective_at: new Date(), updated_at: new Date() });
    const rows = await trx('customer_plan_rates').where({ customer_id: customerId }).select('monthly_rate');
    const scalar = Math.round(rows.reduce((sum, r) => sum + (Number(r.monthly_rate) || 0), 0) * 100) / 100;
    await trx('customers').where({ id: customerId }).update({ monthly_rate: scalar, updated_at: new Date() });
  }
  const protectedUntil = live.tier_protected_until && dateOnlyString(live.tier_protected_until) > resume
    ? live.tier_protected_until
    : resume;
  await trx('customers').where({ id: customerId }).update({ tier_protected_until: protectedUntil, updated_at: new Date() });
  return { holdId: hold?.id || hold, heldRate };
}

// The hold stands, but the ENCLOSING accept may not yet (a later family or
// the paired Away Mode can still undo it, silently): the per-visit notices
// are RETURNED for the action to emit once everything stands.
function moveTechNotices(moved, movedTechIds) {
  return moved
    .map((m) => ({
      visitId: m.id, technicianId: movedTechIds.get(String(m.id)) || null, actorId: 'customer',
      previous: { date: m.from, windowStart: m.window.start, windowEnd: m.window.end },
      snapshot: { date: m.to, windowStart: m.window.start, windowEnd: m.window.end },
    }))
    .filter((n) => n.technicianId);
}

/**
 * A retry of the SAME accept (same case) whose earlier attempt wrote this
 * family's hold and then stopped: that hold is picked up where it stands —
 * its prepaid moves are done and its skip plan is recorded — rather than
 * re-decided (its visits are no longer inside the pause, so a fresh
 * decision would read "nothing to pause" and leave it to be undone).
 */
async function resumeSameCaseHold({ customerId, caseId, familyKey }) {
  if (!caseId) return null;
  const existing = await db('plan_holds')
    .where({ customer_id: customerId, family_key: familyKey, cancellation_case_id: caseId, status: 'active' })
    .first('id', 'starts_on', 'resume_on', 'moved_visits');
  if (!existing) return null;
  const record = readRecord(existing.moved_visits);
  if (record.compensating) throw codedError('hold_setup_failed', 'We could not set the hold up — nothing changed. Call our office and we will do it by hand');
  const done = new Set((record.skipped || []).map(String));
  const resume = dateOnlyString(existing.resume_on);
  return {
    holdId: existing.id, customerId, familyKey, startsOn: dateOnlyString(existing.starts_on), resumeOn: resume, resumeDisplay: displayDate(resume),
    moved: (record.moved || []).length,
    pendingSkips: (record.toSkip || []).filter((v) => !done.has(String(v.id))),
    techNotices: [],
    // Not this execution's to undo: another run of the same accept may be
    // finishing it; if none does, the daily recovery undoes it.
    picked: true,
  };
}

async function startHold({ customerId, caseId, familyKey, resumeOn, maxDays = 180 }) {
  const { today, resume } = validateHoldDates(familyKey, resumeOn, maxDays);
  const picked = await resumeSameCaseHold({ customerId, caseId, familyKey });
  if (picked) return picked;
  // The visits the pause covers (rule 1): dated from today up to the day
  // before the return date, rebook placeholders aside.
  const visits = await familyUpcomingVisits(customerId, familyKey);
  const notNeeded = await notNeededOutcome({ customerId, familyKey, visits, today, resume });
  if (notNeeded) return notNeeded;
  await assertHoldEligible(customerId, familyKey);

  // Prepaid (canonical reader: annual prepay term, hand-collected prepay, a
  // paying invoice, a card fee rail) moves; everything else is skipped once
  // the whole accept stands (applyHoldSkips) — a skip is one-way.
  const inPause = visits.filter((v) => inPauseVisit(v, today, resume));
  const { findBillingCoveredVisits } = require('../../routes/admin-schedule');
  const covered = await findBillingCoveredVisits(db, inPause);
  const toSkip = inPause.filter((v) => !covered.has(v.id));
  const { moved, movedTechIds } = await movePrepaidVisits(customerId, familyKey, inPause.filter((v) => covered.has(v.id)), resume);

  let written;
  try {
    written = await db.transaction((trx) => writeHold(trx, { customerId, caseId, familyKey, today, resume, toSkip, moved }));
  } catch (err) {
    logger.error(`[holds] hold write failed for ${customerId}/${familyKey} — compensating moved visits: ${err.message}`);
    await revertMoves(customerId, moved);
    throw codedError('hold_setup_failed', 'We could not set the hold up — nothing changed. Call our office and we will do it by hand');
  }

  try {
    await db('customer_interactions').insert({
      customer_id: customerId,
      interaction_type: 'note',
      subject: `${familyKey} on hold until ${resume} (cancel flow)`,
      body: `Case ${caseId || '—'}. ${toSkip.length} visit(s) inside the pause to skip; ${moved.length} prepaid visit(s) moved to after ${resume}; monthly component ${written.heldRate == null ? 'n/a' : `$${written.heldRate} suspended`}; tier protected until ${resume}.`,
    });
  } catch (err) { logger.warn(`[holds] hold note failed for ${customerId}: ${err.message}`); }

  return {
    holdId: written.holdId, customerId, familyKey, startsOn: today, resumeOn: resume, resumeDisplay: displayDate(resume), moved: moved.length,
    pendingSkips: toSkip.map((v) => ({ id: v.id, status: v.status, from: dateOnlyString(v.scheduled_date) })),
    techNotices: moveTechNotices(moved, movedTechIds),
  };
}

const readRecord = (raw) => {
  try { return typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { return {}; }
};

/**
 * Mark every hold of an accept as standing — called once ALL of the
 * accept's writes (every family, and a paired Away Mode) committed, and
 * before any skip runs. The lifecycle's recovery pass carries out skips
 * only for an accept marked here; a hold left unmarked was part of an
 * accept that died midway and is compensated instead.
 */
async function markHoldsAccepted(holdIds) {
  // One transaction: recovery must never find an accept half-marked.
  await db.transaction(async (trx) => {
    for (const holdId of holdIds || []) {
      const row = await trx('plan_holds').where({ id: holdId }).forUpdate().first('moved_visits', 'status');
      // A hold the recovery pass (or anything else) undid in the meantime
      // fails the whole marking: the caller compensates, nothing is skipped.
      if (!row || row.status !== 'active' || readRecord(row.moved_visits).compensating) throw new Error(`plan hold ${holdId} is no longer active`);
      await trx('plan_holds').where({ id: holdId }).update({
        moved_visits: JSON.stringify({ ...readRecord(row.moved_visits), acceptCommitted: true }),
        updated_at: new Date(),
      });
    }
  });
}

/**
 * Skip the visits inside each hold's pause (rule 1) — only once every write
 * of the accept stands, because a skip is one-way (job-status.js
 * ONE_WAY_FROM_STATUSES) and could never be compensated. Each visit is
 * re-read under its row lock first: the plan was made before the hold
 * committed, and a visit moved out of the pause, gone live, or paid for in
 * the gap must not be skipped on the stale plan. The canonical transition
 * runs the usual follow-through (open invoice void, group detach); the
 * customer notice is off — the resolution confirmation already told them —
 * and the assigned tech hears the visit is gone after commit. A visit that
 * cannot be skipped leaves the hold standing and rings the office.
 */
async function applyHoldSkips(holdResults) {
  const { transitionJobStatus } = require('../job-status');
  const { findBillingCoveredVisits } = require('../../routes/admin-schedule');
  const bellOffice = async (hold, visit, why) => {
    const { notifyAdmin } = require('../notification-service');
    await notifyAdmin('service', 'Plan hold: a paused visit is still booked', `Visit ${visit.id} on ${visit.from} falls inside the ${hold.familyKey} pause (hold ${hold.holdId}, back ${hold.resumeOn}) but was not skipped (${why}) — check it by hand.`, {
      bell: true, dedupeKey: `plan_hold_skip_failed:${visit.id}`, metadata: { kind: 'plan_hold_skip_failed', holdId: hold.holdId, visitId: visit.id, reason: why },
    }).catch(() => {});
  };
  for (const hold of holdResults || []) {
    if (!hold?.holdId || !Array.isArray(hold.pendingSkips)) continue;
    const skipped = [];
    const unresolved = [];
    for (const visit of hold.pendingSkips) {
      let outcome;
      try {
        outcome = await db.transaction(async (trx) => {
          const row = await trx('scheduled_services').where({ id: visit.id }).forUpdate().first('*');
          // Still this customer's visit in this family: one reassigned to
          // another customer or service since the plan is not the pause's.
          if (row && hold.customerId && String(row.customer_id) !== String(hold.customerId)) return 'left_pause';
          // A legacy visit with no catalog service is judged on its own
          // service_type: an admin re-typing it to another family since the
          // plan leaves it out of the pause too.
          if (row) {
            const { familyOfServiceRow } = require('../cancellation-processor');
            const svc = row.service_id ? await trx('services').where({ id: row.service_id }).first('service_key', 'name') : null;
            if (familyOfServiceRow({ ...row, service_key: svc?.service_key, service_name: svc?.name }) !== hold.familyKey) return 'left_pause';
          }
          // Idempotent: a recovery pass re-offers visits a crashed accept
          // may already have skipped.
          if (row && row.status === 'skipped') return 'skipped';
          // Tracking says the work is done even where its best-effort status
          // sync has not caught up (status still scheduled, en_route or
          // on_site): ended, not live — nothing to retry, no office bell.
          if (row && row.track_state === 'complete') return 'gone';
          // Underway is not ended: the office hears, and the plan stays open.
          if (row && ['en_route', 'on_site'].includes(row.status)) return 'live';
          // A visit that has ended (completed, cancelled, …) or become a
          // rebook placeholder is no longer bookable: nothing to skip.
          if (!row || row.status === 'rescheduled' || !CANCELLABLE_STATUSES.includes(row.status)) return 'gone';
          const date = dateOnlyString(row.scheduled_date);
          // Moved out of the pause in the gap: nothing to skip. The pause
          // starts on the hold's own start date — a recovery pass a day
          // later still skips a paused visit whose date has gone by.
          if (!date || date < (hold.startsOn || etDateString()) || date >= hold.resumeOn) return 'left_pause';
          if (LIVE_TRACK_STATES.includes(row.track_state)) return 'live';
          const covered = await findBillingCoveredVisits(trx, [row]);
          if (covered.has(row.id)) return 'prepaid';
          await transitionJobStatus({
            jobId: visit.id,
            fromStatus: row.status,
            toStatus: 'skipped',
            transitionedBy: null,
            notes: `Skipped: ${hold.familyKey} paused until ${hold.resumeOn} (plan hold ${hold.holdId})`,
            notifyCustomer: false,
            trx,
          });
          if (row.technician_id) {
            require('../tech-visit-notifications').notifyVisitCancelled({
              visitId: visit.id, technicianId: row.technician_id, actorId: 'customer',
              snapshot: { date, windowStart: row.window_start || null, windowEnd: row.window_end || null },
              previousStatus: row.status, trx,
            });
          }
          return 'skipped';
        });
      } catch (err) {
        logger.error(`[holds] visit ${visit.id} did not skip for hold ${hold.holdId}: ${err.message}`);
        outcome = 'error';
      }
      if (outcome === 'skipped') skipped.push(visit.id);
      else if (outcome !== 'left_pause' && outcome !== 'gone') {
        unresolved.push(visit.id);
        await bellOffice(hold, visit, outcome);
      }
    }
    // skipsFinal only once every target was skipped, left the pause, or
    // ended: a visit still bookable inside the pause (paid for or live in
    // the gap, a transient failure) stays in the plan, and the daily
    // recovery pass retries it (its office bell is deduped per visit).
    // Read and written under the hold's row lock, so a concurrent run's
    // reminder claim (or skip record) is merged into, never overwritten.
    try {
      await db.transaction(async (trx) => {
        const row = await trx('plan_holds').where({ id: hold.holdId }).forUpdate().first('moved_visits');
        const record = readRecord(row?.moved_visits);
        await trx('plan_holds').where({ id: hold.holdId }).update({
          moved_visits: JSON.stringify({ ...record, skipped: [...new Set([...(record.skipped || []), ...skipped])], unresolved, skipsFinal: unresolved.length === 0 }),
          updated_at: new Date(),
        });
      });
    } catch (err) { logger.warn(`[holds] skip record failed for hold ${hold.holdId}: ${err.message}`); }
  }
}

/**
 * Tell each moved visit's holder, once nothing can revert the moves
 * (tech-visit-notifications.js: post-commit, best-effort, never awaited,
 * gate-dark; actor "the customer online"). A notice whose row has since
 * moved on is dropped at write time.
 */
function emitHoldTechNotices(techNotices) {
  const notices = require('../tech-visit-notifications');
  for (const n of techNotices || []) void notices.notifyVisitRescheduled(n);
}

/**
 * Compensating cancel: undo a hold this same flow just created — restore
 * the suspended component and scalar, release tier protection, move the
 * visits back. Used when a LATER family in a multi-family accept fails so
 * money and schedule never partially commit (codex P0).
 */
async function cancelHold(holdId, { compensateVisits = true } = {}) {
  const hold = await db('plan_holds').where({ id: holdId }).first('*');
  if (!hold || hold.status !== 'active') return false;
  const undone = await db.transaction(async (trx) => {
    await lockCustomerComms(trx, hold.customer_id); // rung 6 — see startHold
    // The saved rate is re-read under the lock: a scoped wind-down reprices
    // plan_holds.held_monthly_rate for a held family, and restoring the
    // pre-lock copy would resurrect the pre-demotion price. The row lock is
    // the one markHoldsAccepted takes: a hold an accept already marked
    // (another run of the same accept may have skipped its visits) is never
    // undone by a compensation — and a hold cancelled here can no longer be
    // marked.
    const live = await trx('plan_holds').where({ id: holdId }).forUpdate().first('status', 'held_monthly_rate', 'moved_visits');
    if (!live || live.status !== 'active') return false;
    if (readRecord(live.moved_visits).acceptCommitted === true) return false;
    const claimed = await trx('plan_holds').where({ id: holdId, status: 'active' }).update({ status: 'cancelled', updated_at: new Date() });
    if (!claimed) return false;
    if (live.held_monthly_rate != null) {
      const component = await trx('customer_plan_rates').where({ customer_id: hold.customer_id, family_key: hold.family_key }).first('source');
      if (component && component.source === 'plan_hold') {
        await trx('customer_plan_rates').where({ customer_id: hold.customer_id, family_key: hold.family_key })
          .update({ monthly_rate: Number(live.held_monthly_rate), source: 'plan_hold_revert', effective_at: new Date(), updated_at: new Date() });
        const rows = await trx('customer_plan_rates').where({ customer_id: hold.customer_id }).select('monthly_rate');
        const scalar = Math.round(rows.reduce((sum, r) => sum + (Number(r.monthly_rate) || 0), 0) * 100) / 100;
        await trx('customers').where({ id: hold.customer_id }).update({ monthly_rate: scalar, updated_at: new Date() });
      }
    }
    const others = await trx('plan_holds').where({ customer_id: hold.customer_id, status: 'active' }).whereNot({ id: holdId }).max('resume_on as max');
    await trx('customers').where({ id: hold.customer_id }).update({ tier_protected_until: others?.[0]?.max || null, updated_at: new Date() });
    return true;
  });
  if (!undone) return false;
  if (compensateVisits) {
    let movedVisits = [];
    try {
      const parsed = typeof hold.moved_visits === 'string' ? JSON.parse(hold.moved_visits) : hold.moved_visits;
      movedVisits = Array.isArray(parsed?.moved) ? parsed.moved : [];
    } catch { movedVisits = []; }
    await revertMoves(hold.customer_id, movedVisits);
  }
  return true;
}

/**
 * The first visit back (rule 3): the family's earliest visit dated on or
 * after the return date that was not cancelled or skipped. A completed one
 * counts — it means the moment for the restart text has passed.
 */
async function firstVisitBack(hold, dbh = db) {
  const { familyOfServiceRow } = require('../cancellation-processor');
  const rows = await dbh('scheduled_services as s')
    .leftJoin('services as sv', 's.service_id', 'sv.id')
    .where('s.customer_id', hold.customer_id)
    .where('s.scheduled_date', '>=', dateOnlyString(hold.resume_on))
    // A 'rescheduled' placeholder is rebooking intent, not an appointment.
    .whereNotIn('s.status', ['cancelled', 'skipped', 'no_show', 'rescheduled'])
    .orderBy('s.scheduled_date', 'asc')
    .select('s.*', 'sv.service_key', 'sv.name as service_name');
  return rows.find((row) => familyOfServiceRow(row) === hold.family_key && isBookedAppointment(row)) || null;
}

// An accept runs its skips within seconds of writing the hold; a hold
// older than this with an unfinished skip plan was interrupted.
const SKIP_RECOVERY_AFTER_MS = 15 * 60 * 1000;

/**
 * The restart text for one hold (rule 3): sent when the first visit back is
 * 7 days out or closer, naming its date. Called by the daily lifecycle and
 * right after a hold is accepted (a short pause accepted after the day's
 * run must not reach its first visit unannounced). A per-hold advisory lock
 * serializes the two callers; the stamp is re-read under it and written
 * only after the provider accepted the send (codex r1 P1).
 * Returns 'sent' | 'unsent' | 'not_due' (incl. a visit that changed under the lock) | 'already_sent' | 'no_visit' | 'cancelled'.
 */
// The text goes 7 days out or closer, and never once the visit is underway
// or done ("move it or cancel" no longer applies).
function restartTextWindowOpen(next, nextOn, today) {
  const underway = ['completed', 'en_route', 'on_site'].includes(next.status)
    || next.track_state === 'complete' || LIVE_TRACK_STATES.includes(next.track_state);
  return !underway && nextOn >= today && nextOn <= addDays(today, 7);
}

// Stop the daily scan asking about this hold's restart text: its moment
// has passed (or belongs to the office now).
async function retireRestartText(hold, reason) {
  await db('plan_holds').where({ id: hold.id }).update({
    moved_visits: JSON.stringify({ ...readRecord(hold.moved_visits), reminderRetired: reason }), updated_at: new Date(),
  });
}

async function sendRestartTextIfDue(hold, { today = etDateString() } = {}) {
  const customer = await db('customers').where({ id: hold.customer_id }).first('first_name', 'phone', 'active', 'pipeline_stage');
  if (!customer || customer.active === false || customer.pipeline_stage === 'churned') {
    if (hold.status === 'active') {
      await db('plan_holds').where({ id: hold.id, status: 'active' }).update({ status: 'cancelled', updated_at: new Date() });
    } else {
      // A resumed hold keeps its status (the pause did happen); its restart
      // text is retired, so a later reactivation's visit is never taken
      // for this pause's first visit back.
      await retireRestartText(hold, 'customer_inactive');
    }
    return 'cancelled';
  }
  const next = await firstVisitBack(hold);
  if (!next) {
    // Nothing booked after the pause: there is no date to name, so no
    // text — the office books the restart.
    if (dateOnlyString(hold.resume_on) <= today) {
      const { notifyAdmin } = require('../notification-service');
      await notifyAdmin('service', 'Plan hold: no visit booked after the pause', `Hold ${hold.id} (${hold.family_key}) reached its return date ${dateOnlyString(hold.resume_on)} with no visit booked after it — book the restart and let the customer know.`, {
        bell: true, dedupeKey: `plan_hold_no_visit_back:${hold.id}`, metadata: { kind: 'plan_hold_no_visit_back', holdId: hold.id, customerId: hold.customer_id },
      }).catch(() => {});
      // The office owns the restart now (the bell says to tell the
      // customer): the daily scan stops asking, and the bell rings once.
      await retireRestartText(hold, 'no_visit_back');
    }
    return 'no_visit';
  }
  const nextOn = dateOnlyString(next.scheduled_date);
  if (nextOn > addDays(today, 7)) return 'not_due';
  // Once the visit is underway, done, or gone by, the text's "move it or
  // cancel" no longer applies — for good.
  if (!restartTextWindowOpen(next, nextOn, today)) {
    await retireRestartText(hold, 'window_passed');
    return 'not_due';
  }
  if (!customer.phone) return unsentRestartText(hold, next, nextOn, today);
  // Claim in a SHORT transaction, send outside it: the renderer and the
  // sender query the pool themselves, and a transaction held across the
  // send would pin a second connection (DB_POOL_MAX can be 2). The claim
  // is the stamp itself (a CAS on reminder_sent_at), so two callers can
  // never both send; a send that does not go through gives it back.
  const claimAt = new Date();
  const claim = await db.transaction(async (trx) => {
    // Row-locked against cancelHold / the resume CAS: only a standing hold
    // of a finished accept is texted (a record without the marker predates
    // it and counts as finished).
    const live = await trx('plan_holds').where({ id: hold.id }).forUpdate().first('reminder_sent_at', 'status', 'moved_visits');
    if (!live || live.reminder_sent_at) return 'already';
    const record = readRecord(live.moved_visits);
    if (!['active', 'resumed'].includes(live.status) || record.acceptCommitted === false) return 'stale';
    // The first visit back is read again under the lock: a reschedule or
    // cancel since the read above means the date is stale (the next run
    // names the real one).
    const again = await firstVisitBack(hold, trx);
    if (!again || String(again.id) !== String(next.id) || again.status !== next.status || dateOnlyString(again.scheduled_date) !== nextOn) return 'stale';
    await trx('plan_holds').where({ id: hold.id }).whereNull('reminder_sent_at').update({
      reminder_sent_at: claimAt,
      moved_visits: JSON.stringify({ ...record, reminderClaim: { at: claimAt.toISOString(), visitId: next.id, delivered: false } }),
      updated_at: new Date(),
    });
    return 'claimed';
  });
  if (claim === 'already') return 'already_sent';
  if (claim === 'stale') return 'not_due';

  const sent = await deliverRestartText(hold, customer, next, nextOn);
  const row = await db('plan_holds').where({ id: hold.id }).first('moved_visits');
  const record = readRecord(row?.moved_visits);
  if (sent === true) {
    await db('plan_holds').where({ id: hold.id }).update({
      moved_visits: JSON.stringify({ ...record, reminderClaim: { ...(record.reminderClaim || {}), delivered: true } }),
      updated_at: new Date(),
    });
    return 'sent';
  }
  // Give the claim back so the next run retries (a visit that changed just
  // before the send is named afresh then — nothing failed).
  const { reminderClaim: _released, ...rest } = record;
  await db('plan_holds').where({ id: hold.id, reminder_sent_at: claimAt }).update({
    reminder_sent_at: null, moved_visits: JSON.stringify(rest), updated_at: new Date(),
  });
  if (sent === 'stale') return 'not_due';
  return unsentRestartText(hold, next, nextOn, today);
}

// Render and send the restart text; true only when the provider accepted it.
// The first visit back is resolved once more right before the provider call:
// a dispatch move or cancel since the claim — or an EARLIER visit scheduled
// since — makes this attempt give its claim back, and the next run names the
// real date.
async function deliverRestartText(hold, customer, next, nextOn) {
  try {
    const fresh = await firstVisitBack(hold);
    if (!fresh || String(fresh.id) !== String(next.id) || fresh.status !== next.status || dateOnlyString(fresh.scheduled_date) !== nextOn) return 'stale';
    const { renderRequiredSmsTemplate } = require('../sms-template-renderer');
    const { sendCustomerMessage } = require('../messaging/send-customer-message');
    const { gsmSafeName } = require('../messaging/gsm-normalize');
    const { familyLabel } = require('./templates');
    const visitDate = displayDate(nextOn);
    // Its own key (20260930030000): the old plan_hold_resume_reminder is
    // deactivated so a pre-#5354 sender can never text a skip-style pause
    // its return date.
    const body = await renderRequiredSmsTemplate('plan_hold_restart_first_visit', {
      first_name: gsmSafeName(customer.first_name),
      service: familyLabel(hold.family_key) || hold.family_key,
      visit_date: visitDate,
    }, { workflow: 'plan_hold_restart_first_visit', entity_type: 'plan_hold', entity_id: hold.id });
    const smsResult = await sendCustomerMessage({
      to: customer.phone, body, channel: 'sms', audience: 'customer', purpose: 'support_resolution',
      customerId: hold.customer_id, identityTrustLevel: 'system', entryPoint: 'plan_hold_reminder',
      metadata: { original_message_type: 'plan_hold_restart_first_visit', plan_hold_id: hold.id, visit_id: next.id },
    });
    return !!smsResult.sent;
  } catch (err) {
    logger.error(`[holds] restart text send threw for hold ${hold.id}: ${err.message}`);
    return false;
  }
}

// A restart text that did not go out: retried tomorrow; when the visit is
// about to run with no notice, the office calls.
async function unsentRestartText(hold, next, nextOn, today) {
  logger.error(`[holds] restart text not delivered for hold ${hold.id} — will retry tomorrow`);
  // The visit is about to run with no notice: the office calls.
  if (nextOn <= addDays(today, 1)) {
    const { notifyAdmin } = require('../notification-service');
    await notifyAdmin('service', 'Plan hold: restart text not delivered', `Hold ${hold.id} (${hold.family_key}): the first visit back is ${nextOn} and the restart text could not be delivered — call the customer before the visit.`, {
      bell: true, dedupeKey: `plan_hold_restart_text_undelivered:${hold.id}`, metadata: { kind: 'plan_hold_restart_text_undelivered', holdId: hold.id, customerId: hold.customer_id, visitId: next.id },
    }).catch(() => {});
  }
  return 'unsent';
}

/**
 * After an accept: send the restart text now for any hold whose first
 * visit back is already inside the 7-day window. Best-effort — the daily
 * lifecycle retries anything that did not go out.
 */
async function sendDueRestartTexts(holdIds) {
  for (const holdId of holdIds || []) {
    try {
      const hold = await db('plan_holds').where({ id: holdId }).first('*');
      if (hold && hold.status === 'active') await sendRestartTextIfDue(hold);
    } catch (err) { logger.warn(`[holds] accept-time restart text failed for hold ${holdId}: ${err.message}`); }
  }
}

// An accept that died before all its writes stood: undo this hold rather
// than skip visits for an accept the customer was never told succeeded.
async function undoInterruptedAccept(hold) {
  // Claim the undo under the row lock markHoldsAccepted takes: an
  // accept that marked the hold since the bulk read wins, and one
  // marking after this claim is refused (and compensates itself).
  const claimed = await db.transaction(async (trx) => {
    const live = await trx('plan_holds').where({ id: hold.id }).forUpdate().first('status', 'moved_visits');
    const liveRecord = readRecord(live?.moved_visits);
    if (!live || live.status !== 'active' || liveRecord.acceptCommitted !== false) return null;
    await trx('plan_holds').where({ id: hold.id }).update({
      moved_visits: JSON.stringify({ ...liveRecord, compensating: true }), updated_at: new Date(),
    });
    return liveRecord;
  });
  if (!claimed) return;
  // The Away Mode pairing is read from the locked row: a same-case retry
  // that recorded it after the bulk read is undone with its Away Mode.
  const lockedRecord = claimed;
  // The accept died before all its writes stood: undo this hold
  // (rate restored, prepaid moves reverted) rather than skip visits
  // for an accept the customer was never told succeeded.
  // A paired accept's Away Mode goes back too — only while the
  // preference still holds the date this accept wrote. Restored
  // BEFORE the hold is cancelled: a run stopped in between finds the
  // hold still active and retries (the restore is a no-op then).
  if (lockedRecord.awayPairing?.until) {
    await db('property_preferences').where({ customer_id: hold.customer_id, away_mode_until: lockedRecord.awayPairing.until })
      .update({ away_mode_until: lockedRecord.awayPairing.previousUntil || null, updated_at: new Date() });
  }
  await cancelHold(hold.id, { compensateVisits: true });
  // Nothing of the accept stands once its last hold is undone: release
  // its case so the pause card is offered again.
  if (hold.cancellation_case_id) {
    await require('./index').releaseUnappliedCase({ caseId: hold.cancellation_case_id, customerId: hold.customer_id, code: 'accept_interrupted' })
      .catch((err) => logger.warn(`[holds] case ${hold.cancellation_case_id} not released: ${err.message}`));
  }
  const { notifyAdmin } = require('../notification-service');
  await notifyAdmin('service', 'Plan hold undone: the accept did not finish', `Hold ${hold.id} (${hold.family_key}) was written by a cancel-flow accept that stopped before it finished — it has been undone. Check with the customer whether they still want the pause.`, {
    bell: true, dedupeKey: `plan_hold_accept_interrupted:${hold.id}`, metadata: { kind: 'plan_hold_accept_interrupted', holdId: hold.id, customerId: hold.customer_id },
  }).catch(() => {});
}

async function recoverUnfinishedSkips(out) {
  // Recovery: an accept that committed its hold but died before its skips
  // ran (restart, deploy) leaves visits booked inside the pause. Holds past
  // the in-flight window whose skip plan never finished are carried out
  // here; applyHoldSkips re-checks every visit under its lock.
  const recoverBefore = new Date(Date.now() - SKIP_RECOVERY_AFTER_MS);
  // Resumed holds too: a skip left unresolved on the return-date run keeps
  // being retried after dues restart. Undoing is for active holds only.
  const unfinished = await db('plan_holds').whereIn('status', ['active', 'resumed']).where('created_at', '<', recoverBefore).select('*');
  for (const hold of unfinished) {
    try {
      const record = readRecord(hold.moved_visits);
      if (record.skipsFinal !== false || !Array.isArray(record.toSkip)) continue;
      if (record.acceptCommitted !== true) {
        if (hold.status !== 'active') continue;
        await undoInterruptedAccept(hold);
        continue;
      }
      const done = new Set((record.skipped || []).map(String));
      await applyHoldSkips([{
        holdId: hold.id, customerId: hold.customer_id, familyKey: hold.family_key, resumeOn: dateOnlyString(hold.resume_on), startsOn: dateOnlyString(hold.starts_on),
        pendingSkips: record.toSkip.filter((v) => !done.has(String(v.id))),
      }]);
      out.skipsRecovered += 1;
    } catch (err) {
      out.errors.push(`skips:${hold.id}`);
      logger.error(`[holds] skip recovery failed for hold ${hold.id}: ${err.message}`);
    }
  }

}

async function flagUnconfirmedRestartTexts(out) {
  // A claim whose send never confirmed (the process stopped mid-send) is
  // ambiguous — the text may or may not have gone out, and re-sending
  // could double it. The office checks the thread instead; once.
  const stuck = await db('plan_holds').whereIn('status', ['active', 'resumed'])
    .where('reminder_sent_at', '<', new Date(Date.now() - 60 * 60 * 1000)).select('id', 'customer_id', 'family_key', 'moved_visits');
  for (const hold of stuck) {
    const record = readRecord(hold.moved_visits);
    if (record.reminderClaim?.delivered !== false) continue;
    try {
      const { notifyAdmin } = require('../notification-service');
      await notifyAdmin('service', 'Plan hold: restart text may not have gone out', `Hold ${hold.id} (${hold.family_key}): the restart text was being sent when the process stopped. Check the customer's messages and text them the first visit back if it is missing.`, {
        bell: true, dedupeKey: `plan_hold_restart_text_unconfirmed:${hold.id}`, metadata: { kind: 'plan_hold_restart_text_unconfirmed', holdId: hold.id, customerId: hold.customer_id },
      });
      await db('plan_holds').where({ id: hold.id }).update({
        moved_visits: JSON.stringify({ ...record, reminderClaim: { ...record.reminderClaim, delivered: 'unconfirmed' } }),
        updated_at: new Date(),
      });
    } catch (err) {
      out.errors.push(`remind_claim:${hold.id}`);
      logger.error(`[holds] unconfirmed restart text check failed for hold ${hold.id}: ${err.message}`);
    }
  }

}

async function remindDueHolds(out, today) {
  // A resumed hold still owes its text when the first visit back comes
  // after the return date.
  const toRemind = await db('plan_holds').whereIn('status', ['active', 'resumed']).whereNull('reminder_sent_at').select('*');
  for (const hold of toRemind) {
    if (readRecord(hold.moved_visits).reminderRetired) continue;
    try {
      const result = await sendRestartTextIfDue(hold, { today });
      if (result === 'sent') out.reminded += 1;
      if (result === 'unsent') out.errors.push(`remind_unsent:${hold.id}`);
    } catch (err) {
      out.errors.push(`remind:${hold.id}`);
      logger.error(`[holds] restart text failed for hold ${hold.id}: ${err.message}`);
    }
  }

}

async function resumeDueHolds(out, today, customerIds = null) {
  const query = db('plan_holds').where({ status: 'active' }).where('resume_on', '<=', today);
  if (customerIds) query.whereIn('customer_id', customerIds);
  const toResume = await query.select('*');
  for (const hold of toResume) {
    try {
      // A hold whose plan was cancelled or reconfigured in the meantime is
      // OBSOLETE (codex r1 P2): resuming would text a false restart and
      // overwrite the current component with the stale pre-hold rate.
      const owner = await db('customers').where({ id: hold.customer_id }).first('active', 'pipeline_stage');
      const component = await db('customer_plan_rates').where({ customer_id: hold.customer_id, family_key: hold.family_key }).first('source');
      const obsolete = !owner || owner.active === false || owner.pipeline_stage === 'churned'
        || (hold.held_monthly_rate != null && (!component || component.source !== 'plan_hold'));
      if (obsolete) {
        await db('plan_holds').where({ id: hold.id, status: 'active' }).update({ status: 'cancelled', updated_at: new Date() });
        continue;
      }
      const resumed = await db.transaction(async (trx) => {
        await lockCustomerComms(trx, hold.customer_id); // rung 6 — see startHold
        // Re-read under the lock (see cancelHold): the wind-down reprices a
        // held family's saved rate, and the component may have left
        // plan_hold ownership since the obsolete check above.
        const live = await trx('plan_holds').where({ id: hold.id }).forUpdate().first('status', 'held_monthly_rate', 'moved_visits');
        if (!live || live.status !== 'active') return false;
        // An accept that has not finished (or is being undone) stays active
        // for the recovery pass to finish or undo — resuming it would put
        // it out of that pass's reach.
        const record = readRecord(live.moved_visits);
        if (record.acceptCommitted === false || record.compensating) return false;
        if (live.held_monthly_rate != null) {
          const liveComponent = await trx('customer_plan_rates').where({ customer_id: hold.customer_id, family_key: hold.family_key }).first('source');
          if (!liveComponent || liveComponent.source !== 'plan_hold') {
            await trx('plan_holds').where({ id: hold.id, status: 'active' }).update({ status: 'cancelled', updated_at: new Date() });
            return false;
          }
        }
        const claimed = await trx('plan_holds').where({ id: hold.id, status: 'active' }).update({ status: 'resumed', resumed_at: new Date(), updated_at: new Date() });
        if (!claimed) return false;
        if (live.held_monthly_rate != null) {
          await trx('customer_plan_rates').where({ customer_id: hold.customer_id, family_key: hold.family_key })
            .update({ monthly_rate: Number(live.held_monthly_rate), source: 'plan_hold_resume', effective_at: new Date(), updated_at: new Date() });
          const rows = await trx('customer_plan_rates').where({ customer_id: hold.customer_id }).select('monthly_rate');
          const scalar = Math.round(rows.reduce((s, r) => s + (Number(r.monthly_rate) || 0), 0) * 100) / 100;
          await trx('customers').where({ id: hold.customer_id }).update({ monthly_rate: scalar, updated_at: new Date() });
        }
        const others = await trx('plan_holds').where({ customer_id: hold.customer_id, status: 'active' }).whereNot({ id: hold.id }).max('resume_on as max');
        const nextProtected = others?.[0]?.max || null;
        await trx('customers').where({ id: hold.customer_id }).update({ tier_protected_until: nextProtected, updated_at: new Date() });
        return true;
      });
      // Only a hold the CAS actually moved to 'resumed' is reported (and
      // noted) as resumed — an obsolete one cancelled under the lock is not.
      if (!resumed) continue;
      try {
        await db('customer_interactions').insert({
          customer_id: hold.customer_id,
          interaction_type: 'note',
          subject: `${hold.family_key} hold resumed`,
          body: `Hold ${hold.id} resumed on schedule (${dateOnlyString(hold.resume_on)}); billing component restored.`,
        });
      } catch (noteErr) { logger.warn(`[holds] resume note failed for hold ${hold.id}: ${noteErr.message}`); }
      out.resumed += 1;
    } catch (err) {
      out.errors.push(`resume:${hold.id}`);
      logger.error(`[holds] resume failed for hold ${hold.id}: ${err.message}`);
    }
  }
}

/**
 * Daily lifecycle (scheduler), four phases in order: finish or undo
 * interrupted accepts, flag restart texts whose send never confirmed, send
 * the restart texts that are due (rule 3), and restart dues on the return
 * date (rule 2). Each is idempotent.
 */
async function runPlanHoldLifecycle({ today = etDateString() } = {}) {
  const out = { reminded: 0, resumed: 0, skipsRecovered: 0, errors: [] };
  await recoverUnfinishedSkips(out);
  await flagUnconfirmedRestartTexts(out);
  await remindDueHolds(out, today);
  await resumeDueHolds(out, today);
  return out;
}

/**
 * The resume phase alone, for the given customers' holds due by `today` —
 * the annual rate review's nightly apply (03:10) runs it before applying, so
 * a rate whose effective date is a hold's return date lands that morning
 * instead of being restored over at 10:18 and deferred a day. Same CAS and
 * locks as the daily lifecycle; the 10:18 run finds these already resumed.
 */
async function resumeHoldsDueFor(customerIds, { today = etDateString() } = {}) {
  const out = { reminded: 0, resumed: 0, skipsRecovered: 0, errors: [] };
  if (Array.isArray(customerIds) && customerIds.length) await resumeDueHolds(out, today, customerIds);
  return out;
}

module.exports = { resumeHoldsDueFor, startAwayMode, noteAwayMode, restoreAwayMode, startHold, markHoldsAccepted, applyHoldSkips, sendDueRestartTexts, cancelHold, emitHoldTechNotices, runPlanHoldLifecycle, HOLDABLE_FAMILIES };

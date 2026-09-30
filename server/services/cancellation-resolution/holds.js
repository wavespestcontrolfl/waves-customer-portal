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

async function startAwayMode({ customerId, caseId, until = null }) {
  const today = etDateString();
  const untilYmd = ymdOrDefaultAwayUntil(until);
  if (untilYmd <= today) throw codedError('away_date_invalid', 'The return date must be in the future');
  const existing = await db('property_preferences').where({ customer_id: customerId }).first('id', 'away_mode_until');
  if (existing) {
    await db('property_preferences').where({ id: existing.id }).update({ away_mode_until: untilYmd, updated_at: new Date() });
  } else {
    await db('property_preferences').insert({ customer_id: customerId, away_mode_until: untilYmd, created_at: new Date(), updated_at: new Date() });
  }
  try {
    await db('customer_interactions').insert({
      customer_id: customerId,
      interaction_type: 'note',
      subject: `Away Mode until ${untilYmd} (cancel flow)`,
      body: `Case ${caseId}. Exterior-only visits while away; reports continue; price and tier unchanged.`,
    });
  } catch (err) { logger.warn(`[holds] away-mode note failed for ${customerId}: ${err.message}`); }
  // previousUntil (undefined = no preferences row before) lets a paired
  // accept that fails afterwards put the preference back (restoreAwayMode).
  return {
    until: untilYmd, untilDisplay: displayDate(untilYmd),
    previousUntil: existing ? (existing.away_mode_until ? dateOnlyString(existing.away_mode_until) : null) : undefined,
  };
}

// Undo startAwayMode for an accept that failed after it: the preference
// returns to what it was (a row this accept created keeps a NULL date).
async function restoreAwayMode(customerId, previousUntil) {
  await db('property_preferences').where({ customer_id: customerId })
    .update({ away_mode_until: previousUntil || null, updated_at: new Date() });
}

async function revertMoves(customerId, moved) {
  if (!moved || !moved.length) return;
  const SmartRebooker = require('../rebooker');
  for (const done of [...moved].reverse()) {
    try {
      // A compensating move back is not a schedule change the tech should
      // hear about — the forward move it undoes was never announced either.
      await SmartRebooker.reschedule(done.id, done.from, done.window, 'plan_hold_revert', 'customer', { suppressTechNotice: true, seriesPolicy: 'single' });
    } catch (revertErr) {
      logger.error(`[holds] revert of visit ${done.id} failed: ${revertErr.message}`);
      const { notifyAdmin } = require('../notification-service');
      await notifyAdmin('service', 'Plan hold aborted: visit needs a manual move back', `Visit ${done.id} was moved to ${done.to} for a hold that then failed — move it back to ${done.from}.`, {
        bell: true, dedupeKey: `plan_hold_revert_failed:${done.id}`, metadata: { kind: 'plan_hold_revert_failed', customerId, visitId: done.id },
      }).catch(() => {});
    }
  }
}

async function startHold({ customerId, caseId, familyKey, resumeOn, maxDays = 180 }) {
  if (!HOLDABLE_FAMILIES.includes(familyKey)) throw codedError('hold_family_invalid', 'That service cannot be held');
  const today = etDateString();
  const resume = ymd(resumeOn);
  if (!resume || resume <= today) throw codedError('hold_date_invalid', 'Pick the date you are back');
  if (daysBetween(today, resume) > maxDays) throw codedError('hold_too_long', `A hold can run at most ${maxDays} days`);

  // Once per family per 12 months (rule 4) — a hold that was undone
  // (status 'cancelled': compensated, obsolete, or churned) does not count.
  const floor = new Date(Date.now() - 365 * 86400000);
  const countedPrior = (q) => q.where({ customer_id: customerId, family_key: familyKey })
    .whereIn('status', COUNTED_HOLD_STATUSES).where('created_at', '>=', floor).first('id');
  const prior = await countedPrior(db('plan_holds'));
  if (prior) throw codedError('hold_cooldown', 'This service was already held in the last 12 months');

  // Money first (fail closed): a monthly-lane family we cannot attribute
  // cannot promise "no charges". Lane via the canonical resolver (#3140) —
  // the monthly dues charge the hold suspends only exists on the
  // monthly_membership lane; the old rate>0 shortcut demanded attribution
  // for prepay/per-visit rows the dues cron never bills (Codex #3669 r3 P2).
  const customer = await db('customers').where({ id: customerId }).first('monthly_rate', 'billing_mode', 'waveguard_tier', 'tier_protected_until');
  const monthlyLane = resolveBillingLane(customer).mode === 'monthly_membership';
  let heldRate = null;
  if (monthlyLane) {
    const component = await db('customer_plan_rates').where({ customer_id: customerId, family_key: familyKey }).first('monthly_rate');
    if (!component) throw codedError('hold_unattributed', 'We could not suspend billing for that service — call our office');
    heldRate = Number(component.monthly_rate) || 0;
  }

  // The visits the pause actually covers (rule 1): dated from today up to
  // the day before the return date. A stale past-dated 'rescheduled'
  // placeholder is not one of them — it anchors nothing and is left alone.
  const visits = await familyUpcomingVisits(customerId, familyKey);
  const inPause = visits.filter((v) => {
    const date = dateOnlyString(v.scheduled_date);
    return date && date >= today && date < resume;
  });
  // Rule 2: no visit inside the away dates means nothing to pause — no
  // hold, no suspended dues, no free month.
  if (!inPause.length) {
    const next = visits
      .map((v) => dateOnlyString(v.scheduled_date))
      .filter((date) => date && date >= resume)
      .sort()[0] || null;
    return { notNeeded: true, familyKey, nextVisitOn: next, nextVisitDisplay: next ? displayDate(next) : null };
  }

  // A prepaid visit is never lost to a pause (rule 1): money already held
  // for it (canonical reader — annual prepay term, hand-collected prepay,
  // a paying invoice, a card fee rail) moves it to after the return date.
  // Every other visit inside the pause is skipped once the hold stands.
  const { findBillingCoveredVisits } = require('../../routes/admin-schedule');
  const covered = await findBillingCoveredVisits(db, inPause);
  const toMove = inPause.filter((v) => covered.has(v.id));
  const toSkip = inPause.filter((v) => !covered.has(v.id));
  // A prepaid visit sharing a stop (visit group) cannot move alone: the
  // rebooker moves a grouped row as its whole stop, dragging the other
  // services with it, and "just this service" is the office's split
  // action. Refused before anything is written.
  if (toMove.some((v) => v.visit_id)) {
    throw codedError('hold_visits_unmovable', 'One of your prepaid visits shares a stop with another service — call our office and we will set the hold up by hand');
  }

  // Moves FIRST (codex r1 P1): if a prepaid visit will not move, revert the
  // ones that did and refuse the hold instead of suspending billing around
  // a visit that can still dispatch. Moves are reversible; skips are not,
  // so skips wait until every write of the accept stands (applyHoldSkips).
  const moved = [];
  // Holder on each COMMITTED move (rebooker result), for the tech notices
  // sent only once the whole hold stands — kept off the persisted
  // moved_visits shape.
  const movedTechIds = new Map();
  if (toMove.length) {
    const SmartRebooker = require('../rebooker');
    // The first prepaid visit lands on the return date and the rest keep
    // their spacing — always forward, never earlier than they were.
    const delta = daysBetween(dateOnlyString(toMove[0].scheduled_date), resume);
    for (const visit of toMove) {
      const from = dateOnlyString(visit.scheduled_date);
      const to = addDays(from, delta);
      try {
        // suppressTechNotice: a later visit in this loop, or the hold write
        // below, can still fail and revert every move made so far — the
        // tech must never act on a schedule change that gets rolled back.
        // seriesPolicy 'single': collective move is on, and a series move
        // would carry the regular visits after the return date along.
        const moveResult = await SmartRebooker.reschedule(visit.id, to, {
          start: visit.window_start || null, end: visit.window_end || null,
        }, 'plan_hold', 'customer', { suppressTechNotice: true, seriesPolicy: 'single' });
        moved.push({ id: visit.id, from, to, window: { start: visit.window_start || null, end: visit.window_end || null } });
        movedTechIds.set(String(visit.id), moveResult?.technicianId || null);
      } catch (err) {
        logger.error(`[holds] visit ${visit.id} did not move for a ${familyKey} hold: ${err.message}`);
        await revertMoves(customerId, moved);
        throw codedError('hold_visits_unmovable', 'One of your prepaid visits could not be moved — call our office and we will set the hold up by hand');
      }
    }
  }

  // Hold + billing suspension + tier protection land ATOMICALLY (codex
  // P0): if any write fails, the transaction rolls back and every moved
  // visit is compensated back to its original date before the error
  // reaches the customer.
  let holdId = null;
  try {
    await db.transaction(async (trx) => {
      // Rung 6 (scheduling/occupancy.js ORDERING CONTRACT): a hold rewrites
      // the plan ledger and the customer's rate — the writes the scoped
      // cancellation wind-down serializes on under the same key. The money
      // facts are RE-READ under the lock: the pre-lock reads above only
      // decided eligibility, and a wind-down or ledger writer committing
      // during the visit moves would otherwise leave the hold recording
      // (and later restoring) a stale rate. A family that lost its
      // component in the gap fails the hold (rolled back, visits
      // compensated) instead of suspending billing it can no longer prove.
      await lockCustomerComms(trx, customerId);
      // Eligibility is re-validated under the lock too: a concurrent hold
      // on the same family (both passed the cooldown read above) or a
      // scoped wind-down that cancelled the family's visits in the gap
      // must not leave an active hold — and tier protection — on a family
      // the customer no longer owns.
      const priorUnderLock = await countedPrior(trx('plan_holds'));
      if (priorUnderLock) throw new Error('a hold for this family was written concurrently');
      // The visits still inside the pause must be exactly the ones to skip,
      // by identity: a skip target cancelled or moved in the gap, or a
      // visit booked into the pause in the gap, refuses the hold. The
      // moved prepaid visits must all still be live.
      const liveVisits = await familyUpcomingVisits(customerId, familyKey, trx);
      const liveInPause = liveVisits.filter((v) => {
        const date = dateOnlyString(v.scheduled_date);
        return date && date >= today && date < resume;
      }).map((v) => String(v.id)).sort();
      const skipIds = toSkip.map((v) => String(v.id)).sort();
      if (liveInPause.length !== skipIds.length || liveInPause.some((id, i) => id !== skipIds[i])) {
        throw new Error(`${familyKey} visits inside the pause changed before the hold could be written (live ${liveInPause.join(',')} vs planned ${skipIds.join(',')})`);
      }
      const liveIds = new Set(liveVisits.map((v) => String(v.id)));
      const lostMove = moved.find((m) => !liveIds.has(String(m.id)));
      if (lostMove) throw new Error(`moved prepaid visit ${lostMove.id} is no longer live`);
      const live = await trx('customers').where({ id: customerId }).first('monthly_rate', 'billing_mode', 'waveguard_tier', 'tier_protected_until');
      if (!live) throw new Error('customer vanished before the hold could be written');
      if (resolveBillingLane(live).mode === 'monthly_membership') {
        const liveComponent = await trx('customer_plan_rates').where({ customer_id: customerId, family_key: familyKey }).first('monthly_rate');
        if (!liveComponent) throw new Error(`${familyKey} lost its monthly component before the hold could be written`);
        heldRate = Number(liveComponent.monthly_rate) || 0;
      } else {
        heldRate = null;
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
      holdId = hold?.id || hold;
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
    });
  } catch (err) {
    logger.error(`[holds] hold write failed for ${customerId}/${familyKey} — compensating moved visits: ${err.message}`);
    await revertMoves(customerId, moved);
    throw codedError('hold_setup_failed', 'We could not set the hold up — nothing changed. Call our office and we will do it by hand');
  }

  // The hold stands, but the ENCLOSING action may not yet: a later family
  // in a multi-family hold, or the Away Mode write paired with it, can
  // still fail and cancelHold(compensateVisits) every hold this accept
  // made — and those compensating moves are silent. So the per-visit
  // notices are RETURNED, not emitted; the action emits them
  // (emitHoldTechNotices) once every family and Away Mode succeeded.
  const techNotices = moved
    .map((m) => ({
      visitId: m.id, technicianId: movedTechIds.get(String(m.id)) || null, actorId: 'customer',
      previous: { date: m.from, windowStart: m.window.start, windowEnd: m.window.end },
      snapshot: { date: m.to, windowStart: m.window.start, windowEnd: m.window.end },
    }))
    .filter((n) => n.technicianId);

  try {
    await db('customer_interactions').insert({
      customer_id: customerId,
      interaction_type: 'note',
      subject: `${familyKey} on hold until ${resume} (cancel flow)`,
      body: `Case ${caseId || '—'}. ${toSkip.length} visit(s) inside the pause to skip; ${moved.length} prepaid visit(s) moved to after ${resume}; monthly component ${heldRate == null ? 'n/a' : `$${heldRate} suspended`}; tier protected until ${resume}.`,
    });
  } catch (err) { logger.warn(`[holds] hold note failed for ${customerId}: ${err.message}`); }

  return {
    holdId, familyKey, startsOn: today, resumeOn: resume, resumeDisplay: displayDate(resume), moved: moved.length,
    pendingSkips: toSkip.map((v) => ({ id: v.id, status: v.status, from: dateOnlyString(v.scheduled_date) })),
    techNotices,
  };
}

const readRecord = (raw) => {
  try { return typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { return {}; }
};

/**
 * A paired accept records the Away Mode change it is about to make on each
 * of its holds BEFORE making it, so the recovery pass can put the
 * preference back if the accept dies before it is marked.
 */
async function recordPendingAwayMode(holdIds, { customerId, until }) {
  if (!holdIds?.length) return;
  const prefs = await db('property_preferences').where({ customer_id: customerId }).first('away_mode_until');
  const previousUntil = prefs?.away_mode_until ? dateOnlyString(prefs.away_mode_until) : null;
  await db.transaction(async (trx) => {
    for (const holdId of holdIds) {
      const row = await trx('plan_holds').where({ id: holdId }).forUpdate().first('moved_visits');
      if (!row) continue;
      await trx('plan_holds').where({ id: holdId }).update({
        moved_visits: JSON.stringify({ ...readRecord(row.moved_visits), awayPairing: { previousUntil, until } }),
        updated_at: new Date(),
      });
    }
  });
}

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
      if (!row || row.status !== 'active') throw new Error(`plan hold ${holdId} is no longer active`);
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
    for (const visit of hold.pendingSkips) {
      let outcome;
      try {
        outcome = await db.transaction(async (trx) => {
          const row = await trx('scheduled_services').where({ id: visit.id }).forUpdate().first('*');
          // Idempotent: a recovery pass re-offers visits a crashed accept
          // may already have skipped.
          if (row && row.status === 'skipped') return 'skipped';
          if (!row || row.status !== visit.status) return 'changed';
          const date = dateOnlyString(row.scheduled_date);
          // Moved out of the pause in the gap: nothing to skip. The pause
          // starts on the hold's own start date — a recovery pass a day
          // later still skips a paused visit whose date has gone by.
          if (!date || date < (hold.startsOn || etDateString()) || date >= hold.resumeOn) return 'left_pause';
          if (row.track_state === 'complete' || LIVE_TRACK_STATES.includes(row.track_state)) return 'live';
          const covered = await findBillingCoveredVisits(trx, [row]);
          if (covered.has(row.id)) return 'prepaid';
          await transitionJobStatus({
            jobId: visit.id,
            fromStatus: visit.status,
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
              previousStatus: visit.status, trx,
            });
          }
          return 'skipped';
        });
      } catch (err) {
        logger.error(`[holds] visit ${visit.id} did not skip for hold ${hold.holdId}: ${err.message}`);
        outcome = 'error';
      }
      if (outcome === 'skipped') skipped.push(visit.id);
      else if (outcome !== 'left_pause') await bellOffice(hold, visit, outcome);
    }
    // skipsFinal marks the plan as carried out (bells rang for anything
    // left), so the lifecycle's recovery pass never re-runs it.
    try {
      const row = await db('plan_holds').where({ id: hold.holdId }).first('moved_visits');
      const record = readRecord(row?.moved_visits);
      await db('plan_holds').where({ id: hold.holdId }).update({
        moved_visits: JSON.stringify({ ...record, skipped: [...new Set([...(record.skipped || []), ...skipped])], skipsFinal: true }),
        updated_at: new Date(),
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
  await db.transaction(async (trx) => {
    await lockCustomerComms(trx, hold.customer_id); // rung 6 — see startHold
    // The saved rate is re-read under the lock: a scoped wind-down reprices
    // plan_holds.held_monthly_rate for a held family, and restoring the
    // pre-lock copy would resurrect the pre-demotion price.
    const live = await trx('plan_holds').where({ id: holdId }).first('status', 'held_monthly_rate');
    if (!live || live.status !== 'active') return;
    const claimed = await trx('plan_holds').where({ id: holdId, status: 'active' }).update({ status: 'cancelled', updated_at: new Date() });
    if (!claimed) return;
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
  });
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
  return rows.find((row) => familyOfServiceRow(row) === hold.family_key) || null;
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
async function sendRestartTextIfDue(hold, { today = etDateString() } = {}) {
  const customer = await db('customers').where({ id: hold.customer_id }).first('first_name', 'phone', 'active', 'pipeline_stage');
  if (!customer || customer.active === false || customer.pipeline_stage === 'churned') {
    if (hold.status === 'active') await db('plan_holds').where({ id: hold.id, status: 'active' }).update({ status: 'cancelled', updated_at: new Date() });
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
    }
    return 'no_visit';
  }
  const nextOn = dateOnlyString(next.scheduled_date);
  if (next.status === 'completed' || nextOn < today || nextOn > addDays(today, 7)) return 'not_due';
  const sent = await db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`plan-hold-reminder:${hold.id}`]);
    // Row-locked against cancelHold / the resume CAS: only a standing hold
    // of a finished accept is texted (a record without the marker predates
    // it and counts as finished).
    const live = await trx('plan_holds').where({ id: hold.id }).forUpdate().first('reminder_sent_at', 'status', 'moved_visits');
    if (!live || live.reminder_sent_at) return null;
    if (!['active', 'resumed'].includes(live.status) || readRecord(live.moved_visits).acceptCommitted === false) return 'stale';
    // The first visit back is read again, and its row held FOR SHARE for
    // the send: a reschedule or cancel that landed since the read above
    // means the date is stale (the next run names the real one), and one
    // arriving now waits until this text is out, so its own notice lands
    // after it.
    const again = await firstVisitBack(hold, trx);
    if (!again || String(again.id) !== String(next.id) || again.status !== next.status || dateOnlyString(again.scheduled_date) !== nextOn) return 'stale';
    const pinned = await trx('scheduled_services').where({ id: next.id }).forShare().first('status', 'scheduled_date');
    if (!pinned || pinned.status !== next.status || dateOnlyString(pinned.scheduled_date) !== nextOn) return 'stale';
    if (!customer.phone) return false;
    const { renderRequiredSmsTemplate } = require('../sms-template-renderer');
    const { sendCustomerMessage } = require('../messaging/send-customer-message');
    const { gsmSafeName } = require('../messaging/gsm-normalize');
    const { familyLabel } = require('./templates');
    const visitDate = displayDate(nextOn);
    const body = await renderRequiredSmsTemplate('plan_hold_resume_reminder', {
      first_name: gsmSafeName(customer.first_name),
      service: familyLabel(hold.family_key) || hold.family_key,
      visit_date: visitDate,
      // The pre-20260930 body names {resume_date}; the date it now
      // promises is the first visit back either way.
      resume_date: visitDate,
    }, { workflow: 'plan_hold_resume_reminder', entity_type: 'plan_hold', entity_id: hold.id });
    const smsResult = await sendCustomerMessage({
      to: customer.phone, body, channel: 'sms', audience: 'customer', purpose: 'support_resolution',
      customerId: hold.customer_id, identityTrustLevel: 'system', entryPoint: 'plan_hold_reminder',
      metadata: { original_message_type: 'plan_hold_resume_reminder', plan_hold_id: hold.id, visit_id: next.id },
    });
    if (!smsResult.sent) return false;
    await trx('plan_holds').where({ id: hold.id }).whereNull('reminder_sent_at').update({ reminder_sent_at: new Date(), updated_at: new Date() });
    return true;
  });
  if (sent === null) return 'already_sent';
  if (sent === 'stale') return 'not_due';
  if (sent) return 'sent';
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

/**
 * Daily lifecycle (scheduler). The restart text goes out 7 days before the
 * first visit back, naming its date — at once when it is closer (rule 3);
 * the dues restart on the return date (rule 2). Both idempotent — the
 * reminder stamps reminder_sent_at, the resume flips status under the
 * live-unique index. Nothing is ever moved to make room for the notice.
 */
async function runPlanHoldLifecycle({ today = etDateString() } = {}) {
  const out = { reminded: 0, resumed: 0, skipsRecovered: 0, errors: [] };

  // Recovery: an accept that committed its hold but died before its skips
  // ran (restart, deploy) leaves visits booked inside the pause. Holds past
  // the in-flight window whose skip plan never finished are carried out
  // here; applyHoldSkips re-checks every visit under its lock.
  const recoverBefore = new Date(Date.now() - SKIP_RECOVERY_AFTER_MS);
  const unfinished = await db('plan_holds').where({ status: 'active' }).where('created_at', '<', recoverBefore).select('*');
  for (const hold of unfinished) {
    try {
      const record = readRecord(hold.moved_visits);
      if (record.skipsFinal !== false || !Array.isArray(record.toSkip)) continue;
      if (record.acceptCommitted !== true) {
        // The accept died before all its writes stood: undo this hold
        // (rate restored, prepaid moves reverted) rather than skip visits
        // for an accept the customer was never told succeeded.
        // A paired accept's Away Mode goes back too — only while the
        // preference still holds the date this accept wrote. Restored
        // BEFORE the hold is cancelled: a run stopped in between finds the
        // hold still active and retries (the restore is a no-op then).
        if (record.awayPairing?.until) {
          await db('property_preferences').where({ customer_id: hold.customer_id, away_mode_until: record.awayPairing.until })
            .update({ away_mode_until: record.awayPairing.previousUntil || null, updated_at: new Date() });
        }
        await cancelHold(hold.id, { compensateVisits: true });
        const { notifyAdmin } = require('../notification-service');
        await notifyAdmin('service', 'Plan hold undone: the accept did not finish', `Hold ${hold.id} (${hold.family_key}) was written by a cancel-flow accept that stopped before it finished — it has been undone. Check with the customer whether they still want the pause.`, {
          bell: true, dedupeKey: `plan_hold_accept_interrupted:${hold.id}`, metadata: { kind: 'plan_hold_accept_interrupted', holdId: hold.id, customerId: hold.customer_id },
        }).catch(() => {});
        continue;
      }
      const done = new Set((record.skipped || []).map(String));
      await applyHoldSkips([{
        holdId: hold.id, familyKey: hold.family_key, resumeOn: dateOnlyString(hold.resume_on), startsOn: dateOnlyString(hold.starts_on),
        pendingSkips: record.toSkip.filter((v) => !done.has(String(v.id))),
      }]);
      out.skipsRecovered += 1;
    } catch (err) {
      out.errors.push(`skips:${hold.id}`);
      logger.error(`[holds] skip recovery failed for hold ${hold.id}: ${err.message}`);
    }
  }

  // A resumed hold still owes its text when the first visit back comes
  // after the return date.
  const toRemind = await db('plan_holds').whereIn('status', ['active', 'resumed']).whereNull('reminder_sent_at').select('*');
  for (const hold of toRemind) {
    try {
      const result = await sendRestartTextIfDue(hold, { today });
      if (result === 'sent') out.reminded += 1;
      if (result === 'unsent') out.errors.push(`remind_unsent:${hold.id}`);
    } catch (err) {
      out.errors.push(`remind:${hold.id}`);
      logger.error(`[holds] restart text failed for hold ${hold.id}: ${err.message}`);
    }
  }

  const toResume = await db('plan_holds').where({ status: 'active' }).where('resume_on', '<=', today).select('*');
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
        const live = await trx('plan_holds').where({ id: hold.id }).first('status', 'held_monthly_rate');
        if (!live || live.status !== 'active') return false;
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
  return out;
}

module.exports = { startAwayMode, ymdOrDefaultAwayUntil, restoreAwayMode, recordPendingAwayMode, startHold, markHoldsAccepted, applyHoldSkips, sendDueRestartTexts, cancelHold, emitHoldTechNotices, runPlanHoldLifecycle, HOLDABLE_FAMILIES };

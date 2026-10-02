/**
 * Accept-time rider seeding (GATE_PEST_RIDES_LAWN_AT_ACCEPT, owner rulings
 * 2026-10-01; plan ~/rider-one-appointment-plan-20261001.md step 3).
 *
 * When one accepted estimate sells a lawn series (every 6 weeks, or monthly)
 * and a quarterly rider series (pest, tree & shrub, termite bait) that start
 * the same day at the same property, the rider's follow-ups take their dates
 * from the lawn series' dates (planRiderDates, the 77/84/105 rule) instead of
 * walking quarterly months on their own. They land on lawn dates at the same
 * stop, so the canonical seeder's own maybeGroupRow call puts each pair in one
 * visit. The rider parent is linked to the lawn parent through
 * scheduled_services.rides_parent_id so later extensions
 * (admin-schedule.js#extendSeriesOnceLocked) keep riding. Which host may carry
 * which rider is the pairing table in rider-series-preview.js.
 *
 * Nothing here writes a visit row: it only hands the seeder `overrideDates`
 * and stamps the link. Every doubt (different first date or property, fewer
 * rider dates than the plan needs, a read failing) falls back to today's
 * quarterly walk — an accept never fails because of this.
 *
 * One context per accept (createContext). The converter seeds a lawn host
 * ahead of its riders wherever it can; the lawn is recorded as it seeds
 * (beforeSeed/afterSeed), and only a lawn that has ALREADY seeded in this
 * accept can host a rider.
 */
const logger = require('./logger');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const HORIZON_DAYS = 730;

function dateOnly(value) {
  return value ? String(value instanceof Date ? value.toISOString() : value).slice(0, 10) : null;
}

function addDays(dateStr, days) {
  return etDateString(addETDays(parseETDateTime(`${dateStr}T12:00`), days));
}

// A failed optional statement must not abort the caller's transaction (25P02).
const inSavepoint = (conn, fn) => (conn.isTransaction ? conn.transaction(fn) : fn(conn));

// null while the gate is off (read at call time). Optional call: suites that
// mock feature-gates partially never define this reader, which means off.
// Riding means ONE stop, so visit grouping must be on too (off = no context).
function createContext() {
  const fg = require('../config/feature-gates');
  return fg.pestRidesLawnAtAcceptLive?.() && fg.gates?.visitGroups ? { lawn: null } : null;
}

// A lawn host (6-week or monthly) before it is stamped recurring: only the
// converter's resolved family + pattern exist on the parent at this point.
// The family is already resolved as lawn (from the catalog identity when the
// row's own label is stale), so the host is classified from it, never from
// the row label.
function hostRow(parentRow, pattern) {
  const snapshot = String(parentRow.service_key_snapshot || '');
  return {
    ...parentRow,
    service_key_snapshot: snapshot.startsWith('lawn_care') ? snapshot : 'lawn_care',
    recurring_pattern: pattern,
  };
}

// The first rider visit and the first lawn visit must ACTUALLY be one stop:
// run the canonical grouping (visit-groups.maybeGroupRow — gate, property,
// placed window, family, status, autopay, technician and its apply-time
// guards; savepoint-wrapped and idempotent) and then require both rows to
// carry the same visit_id. A preview is not proof: apply can still refuse.
async function firstVisitsGroup(conn, riderId, lawnId) {
  const shared = async () => {
    const rows = await inSavepoint(conn, (sp) => sp('scheduled_services').whereIn('id', [riderId, lawnId]).select('id', 'visit_id'));
    const visitOf = (id) => rows.find((r) => String(r.id) === String(id))?.visit_id || null;
    return !!visitOf(riderId) && String(visitOf(riderId)) === String(visitOf(lawnId));
  };
  if (await shared()) return true;
  await require('./visit-groups').maybeGroupRow(riderId, { database: conn, createdBy: 'converter' });
  return shared();
}

// The converter's seeding of this lawn failed: later riders must not plan
// against it (they seed their own walk).
function forgetLawn(ctx, parentRow) {
  if (ctx?.lawn && String(ctx.lawn.parent.id) === String(parentRow?.id)) ctx.lawn = null;
}

function isHostPlan(family, pattern, parentRow = {}) {
  return family === 'lawn_care' && !!require('./rider-series-preview').riderHostKind(hostRow(parentRow, pattern));
}

// Records a lawn host as it is about to seed (beforeSeed).
function noteLawn(ctx, parentRow, { family, pattern }) {
  if (!ctx || !isHostPlan(family, pattern, parentRow)) return false;
  if (!ctx.lawn || String(ctx.lawn.parent.id) !== String(parentRow.id)) {
    ctx.lawn = {
      parent: parentRow, host: hostRow(parentRow, pattern), seededDates: null,
    };
  }
  return true;
}

// For a rider of the recorded lawn host returns { overrideDates, hostParentId };
// null otherwise (= seed the normal quarterly walk).
async function beforeSeed(ctx, conn, parentRow, plan) {
  if (!ctx || noteLawn(ctx, parentRow, plan)) return null;
  try {
    return await planRiderOverride(ctx, conn, parentRow, plan);
  } catch (err) {
    logger.warn(`[rider-accept] rider dates failed for customer ${parentRow.customer_id} (seeding the quarterly walk): ${err.message}`);
    return null;
  }
}

async function planRiderOverride(ctx, conn, rider, { family, pattern, seedOpts }) {
  const { planRiderDates, riderPairingEnabled } = require('./rider-series-preview');
  if (!ctx.lawn || !riderPairingEnabled(ctx.lawn.host, family, pattern)) return null;
  const lawn = ctx.lawn.parent;
  const firstDate = dateOnly(rider.scheduled_date);
  if (String(lawn.customer_id) !== String(rider.customer_id)
    || dateOnly(lawn.scheduled_date) !== firstDate
    || String(lawn.property_id || '') !== String(rider.property_id || '')) {
    logger.warn(`[rider-accept] lawn ${lawn.id} and rider ${rider.id} do not start at the same stop (seeding the quarterly walk)`);
    return null;
  }
  // Only a lawn that has ALREADY seeded in this accept can host: its real
  // dates are known and the two first visits can be checked as one stop.
  // (A reserved lawn that seeds after a promoted rider is not a host — the
  // rider walks its own cadence.)
  if (!ctx.lawn.seededDates) return null;
  if (!(await firstVisitsGroup(conn, rider.id, lawn.id))) {
    logger.warn(`[rider-accept] rider ${rider.id} would not group with lawn ${lawn.id} (seeding the quarterly walk)`);
    return null;
  }
  const Seeder = require('./recurring-appointment-seeder');
  const { getBlackoutLayers } = require('./scheduling/blackout-dates');
  const horizon = addDays(firstDate, HORIZON_DAYS);
  const wanted = Seeder.plannedVisitCountForPattern(pattern, seedOpts) - 1;
  const hostFollowUps = ctx.lawn.seededDates;
  let blackoutDates = null;
  try { blackoutDates = await getBlackoutLayers(firstDate, horizon, conn); } catch { /* fail open */ }
  const overrideDates = planRiderDates({
    hostDates: [firstDate, ...hostFollowUps],
    lastRiderDate: firstDate,
    horizonDate: horizon,
    skipWeekends: seedOpts.skipWeekends !== false,
    weekendShift: seedOpts.weekendShift,
    blackoutDates,
  }).slice(0, wanted);
  // Every rider date must BE a lawn date: the rule's own +84 fallback (no lawn
  // date near) is a valid cadence but not a ride, so it is not linked.
  const hostSet = new Set(hostFollowUps.map(dateOnly));
  if (wanted < 1 || overrideDates.length < wanted || !overrideDates.every((d) => hostSet.has(d))) {
    logger.warn(`[rider-accept] rider ${rider.id} has ${overrideDates.filter((d) => hostSet.has(d)).length}/${wanted} lawn dates to ride (seeding the quarterly walk)`);
    return null;
  }
  // A resumed accept may already have some rider follow-ups saved; the seeder
  // keeps them and fills the rest from these overrides. If any saved one is
  // not on the planned lawn dates, mixing the two would bunch visits (e.g. +84
  // beside a saved +91) — keep the normal walk instead.
  const planned = new Set(overrideDates);
  const saved = (await liveSeriesRows(conn, [rider.id]))
    .filter((r) => String(r.recurring_parent_id || '') === String(rider.id))
    .map((r) => dateOnly(r.scheduled_date));
  if (!saved.every((d) => planned.has(d))) {
    logger.warn(`[rider-accept] rider ${rider.id} already has saved dates off the lawn plan (seeding the quarterly walk)`);
    return null;
  }
  return { overrideDates, hostParentId: lawn.id };
}

// After the seeder ran: remember a seeded lawn's real dates for a later rider,
// and link a rider parent to its lawn parent.
async function afterSeed(ctx, conn, parentRow, rider, seedResult) {
  if (!ctx) return;
  if (ctx.lawn && String(ctx.lawn.parent.id) === String(parentRow.id)) {
    // The lawn series as SAVED (a resumed seed keeps existing follow-ups and
    // inserts only the missing ones), never just this call's inserts.
    try {
      const rows = await liveSeriesRows(conn, [parentRow.id]);
      ctx.lawn.seededDates = rows.filter((r) => r.recurring_parent_id).map((r) => dateOnly(r.scheduled_date)).filter(Boolean);
    } catch (err) {
      logger.warn(`[rider-accept] could not read lawn ${parentRow.id}'s series (hosts nothing): ${err.message}`);
      ctx.lawn = null;
    }
  }
  // seedWithRide already verified this rider inside its savepoint.
  if (!rider?.hostParentId) return;
  await linkRider(conn, parentRow.id, rider.hostParentId);
}

// Seeds a rider's follow-ups on the lawn dates INSIDE a savepoint and keeps
// them only when every saved follow-up is on a lawn date AND in that lawn
// row's visit (a seeded row whose grouping failed or was refused is a separate
// stop). Otherwise the savepoint rolls back and the normal walk is seeded.
// No rider = the normal seed, untouched. `seed(conn, overrideDates|null,
// commitScope|null)`. Inside the savepoint the seeder's post-commit work (tier
// sync, shortfall bell, coverage alerts) waits on rideCommitScope: it fires
// only when the ride is KEPT and the caller's transaction then commits. A
// rolled-back ride rejects it, so nothing is filed for rows that were thrown
// away — the fallback walk's own seed files its own.
async function seedWithRide(conn, parentRow, rider, seed) {
  if (!rider) return { seedResult: await seed(conn, null, null), rides: false };
  const scope = rideCommitScope(conn);
  try {
    const seedResult = await conn.transaction(async (sp) => {
      const result = await seed(sp, rider.overrideDates, scope);
      if (!(await persistedRiderOnHost(sp, parentRow.id, rider.hostParentId, rider.overrideDates))) {
        throw new Error('saved follow-ups are not all in the lawn visits');
      }
      return result;
    });
    scope.keep();
    return { seedResult, rides: true };
  } catch (err) {
    scope.drop(err);
    logger.warn(`[rider-accept] rider ${parentRow.id} does not ride (${err.message}) — seeding the quarterly walk`);
    return { seedResult: await seed(conn, null, null), rides: false };
  }
}

// A commit scope for work done inside the ride savepoint: its executionPromise
// resolves only after keep() AND the caller's transaction commits (a pool
// caller's ride transaction has already committed by keep()); drop() rejects
// it. Consumers only read isTransaction / executionPromise.
function rideCommitScope(conn) {
  let keep;
  let drop;
  const kept = new Promise((resolve, reject) => { keep = resolve; drop = reject; });
  const outerCommit = conn.isTransaction && conn.executionPromise ? conn.executionPromise : Promise.resolve();
  const executionPromise = kept.then(() => outerCommit);
  executionPromise.catch(() => {});
  return { isTransaction: true, executionPromise, keep: () => keep(), drop: (err) => drop(err) };
}

// Live plan rows of the given series — the one shared reader
// (rider-series-preview.livePlanSeriesRows), in a savepoint.
function liveSeriesRows(conn, parentIds) {
  return inSavepoint(conn, async (sp) => {
    const cols = await sp('scheduled_services').columnInfo();
    return require('./rider-series-preview').livePlanSeriesRows(sp, parentIds, cols, { extraColumns: ['visit_id'] });
  });
}

// Every saved rider follow-up sits on a saved lawn date AND is in that lawn
// row's visit (a seeded row whose grouping failed is a separate stop).
async function persistedRiderOnHost(conn, riderId, hostId, expectedDates = null) {
  const rows = await liveSeriesRows(conn, [riderId, hostId]);
  const seriesOf = (row) => String(row.recurring_parent_id || row.id);
  const hostVisitByDate = new Map(rows.filter((r) => seriesOf(r) === String(hostId))
    .map((r) => [dateOnly(r.scheduled_date), r.visit_id ? String(r.visit_id) : null]));
  const riderFollowUps = rows.filter((r) => String(r.recurring_parent_id || '') === String(riderId));
  // The saved plan follow-ups must be EXACTLY the planned lawn-date set: a
  // non-plan child (booster, callback) can make the seeder insert fewer, and
  // a partial series is not a ride.
  if (expectedDates) {
    const saved = riderFollowUps.map((r) => dateOnly(r.scheduled_date)).sort();
    const expected = [...new Set(expectedDates.map(dateOnly))].sort();
    if (saved.length !== expected.length || saved.some((d, k) => d !== expected[k])) return false;
  }
  return riderFollowUps.length > 0 && riderFollowUps.every((r) => {
    const hostVisit = hostVisitByDate.get(dateOnly(r.scheduled_date));
    return !!hostVisit && !!r.visit_id && String(r.visit_id) === hostVisit;
  });
}

async function linkRider(conn, riderId, hostParentId) {
  try {
    // One savepoint for the whole optional write: any failure (including a
    // schema without the column) rolls back to it and the accept continues.
    await inSavepoint(conn, (sp) => sp('scheduled_services').where({ id: riderId }).update({ rides_parent_id: hostParentId }));
  } catch (err) {
    logger.warn(`[rider-accept] could not link rider ${riderId} to lawn ${hostParentId}: ${err.message}`);
  }
}

module.exports = {
  createContext, isHostPlan, noteLawn, forgetLawn, beforeSeed, seedWithRide, afterSeed,
};

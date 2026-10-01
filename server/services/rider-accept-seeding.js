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
 * One context per accept (createContext). The converter seeds series in
 * whatever order the estimate lists them (lawn first when it can), so the lawn
 * is recorded either when it is about to seed (beforeSeed) or, for a reserved
 * lawn visit that seeds after the promoted riders, up front (noteLawn).
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
function createContext() {
  return require('../config/feature-gates').pestRidesLawnAtAcceptLive?.() ? { lawn: null } : null;
}

// A lawn host (6-week or monthly) before it is stamped recurring: only the
// converter's resolved family + pattern exist on the parent at this point.
function hostRow(parentRow, pattern) {
  return { ...parentRow, service_type: parentRow.service_type || 'Lawn Care', recurring_pattern: pattern };
}

function isHostPlan(family, pattern, parentRow = {}) {
  return family === 'lawn_care' && !!require('./rider-series-preview').riderHostKind(hostRow(parentRow, pattern));
}

// Records a lawn host (called ahead of the promoted programs for a
// reserved lawn visit, and by beforeSeed for every series about to seed).
function noteLawn(ctx, parentRow, { family, pattern, seedOpts }) {
  if (!ctx || !isHostPlan(family, pattern, parentRow)) return false;
  if (!ctx.lawn || String(ctx.lawn.parent.id) !== String(parentRow.id)) {
    ctx.lawn = {
      parent: parentRow, host: hostRow(parentRow, pattern), seedOpts, seededDates: null,
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
  const Seeder = require('./recurring-appointment-seeder');
  const { getBlackoutLayers } = require('./scheduling/blackout-dates');
  const horizon = addDays(firstDate, HORIZON_DAYS);
  const wanted = Seeder.plannedVisitCountForPattern(pattern, seedOpts) - 1;
  const hostFollowUps = ctx.lawn.seededDates || await inSavepoint(conn, (sp) => Seeder.planFollowUpSeedDates(sp, lawn, ctx.lawn.seedOpts));
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
  return { overrideDates, hostParentId: lawn.id, projected: !ctx.lawn.seededDates };
}

// After the seeder ran: remember a seeded lawn's real dates for a later rider,
// and link a rider parent to its lawn parent.
async function afterSeed(ctx, conn, parentRow, rider, seedResult) {
  if (!ctx) return;
  if (ctx.lawn && String(ctx.lawn.parent.id) === String(parentRow.id)) {
    ctx.lawn.seededDates = (seedResult?.insertedRows || []).map((r) => dateOnly(r.scheduled_date)).filter(Boolean);
    await settleProjectedRiders(ctx, conn);
  }
  if (!rider?.hostParentId) return;
  if (rider.projected) (ctx.lawn.projectedRiders = ctx.lawn.projectedRiders || []).push({ id: parentRow.id, dates: rider.overrideDates });
  try {
    // One savepoint for the whole optional write: any failure (including a
    // schema without the column) rolls back to it and the accept continues.
    await inSavepoint(conn, (sp) => sp('scheduled_services').where({ id: parentRow.id }).update({ rides_parent_id: rider.hostParentId }));
  } catch (err) {
    logger.warn(`[rider-accept] could not link rider ${parentRow.id} to lawn ${rider.hostParentId}: ${err.message}`);
  }
}

// Riders planned from the lawn's PROJECTED dates (a reserved lawn seeds after
// them): once the lawn has really seeded, any rider whose dates are not all
// real lawn dates is unlinked — its rows keep their valid 84-day dates, they
// just are not a ride. Also covers a lawn that seeded nothing.
async function settleProjectedRiders(ctx, conn) {
  const pending = ctx.lawn.projectedRiders || [];
  ctx.lawn.projectedRiders = [];
  const actual = new Set(ctx.lawn.seededDates);
  for (const r of pending) {
    if (r.dates.every((d) => actual.has(d))) continue;
    logger.warn(`[rider-accept] lawn ${ctx.lawn.parent.id} did not seed the dates rider ${r.id} planned on — unlinking it`);
    try {
      await inSavepoint(conn, (sp) => sp('scheduled_services').where({ id: r.id }).update({ rides_parent_id: null }));
    } catch (err) {
      logger.warn(`[rider-accept] could not unlink rider ${r.id}: ${err.message}`);
    }
  }
}

module.exports = {
  createContext, isHostPlan, noteLawn, beforeSeed, afterSeed,
};

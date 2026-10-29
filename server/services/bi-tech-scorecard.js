/**
 * Weekly scorecard per technician for the Monday BI briefing (GATE_BI_TECH_SCORECARD,
 * second technician build 7, owner GO 2026-10-29). Reads only; sends nothing.
 *
 * Window: the last full week, Monday to Sunday ET, before the Monday the briefing runs.
 * One row per technician with 1+ completed visit that week. Every number reuses the
 * source the repo already has for it; an unknown value is null with a reason in
 * `reasons`, never 0.
 *
 *   stops, days worked, on-site, drive  getDayScorecard (scheduling/day-scorecard.js) ACTUAL
 *                                       rows. Days worked = days with a completed stop. Stops
 *                                       are physical stops when the scorecard can prove them,
 *                                       else completed visits. On-site = recorded minutes over
 *                                       the visits that have recorded minutes. Drive = the
 *                                       Bouncie mileage_log day total, so it includes the legs
 *                                       to the first stop and home from the last.
 *   callbacks                           callbackCreditByTechnician (callback-credit.js): the
 *                                       technician whose visit the callback corrects, whatever
 *                                       GATE_CALLBACK_SOURCE_TECH says (that gate guards only
 *                                       the dashboard leaderboard).
 *   review asks                         review_requests of the technician's visits that week
 *                                       with a delivered text or email, counting asks only
 *                                       (ASK_TOUCH_SQL, review-outreach-templates.js).
 *   revenue per tech-day                the dashboard leaderboard's service_records revenue
 *                                       (computeCoreKpis) / days worked.
 *   cost per tech-day                   the technician's cost card in effect on each worked
 *                                       day (tech-cost-rates.js, GATE_TECH_COST_RATES): labor
 *                                       per worked hour x the card's paid hours per day.
 *                                       Labor only.
 */
const db = require('../models/db');
const { etWeekStart, etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const { getDayScorecard } = require('./scheduling/day-scorecard');
const { callbackCreditByTechnician } = require('./callback-credit');
const { ASK_TOUCH_SQL } = require('./review-outreach-templates');
const { cardInEffect, loadVisitRates } = require('./tech-cost-rates');
const { techCostRatesLive } = require('../config/feature-gates');

// No on-site target is stored anywhere in the repo (kpi_targets and DEFAULT_KPI_TARGETS
// have none), so the owner's 25 is the target.
const ON_SITE_TARGET_MINUTES = 25;
// Same small-sample threshold as the KPI rows' lowSample (bi-agent-tools.js
// MIN_CONFIDENT_ISSUED_INVOICES, KpiTile MIN_CONFIDENT_N): under 5 is noise.
const MIN_STOPS = 5;

const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;
const outcome = (settled) => (settled.status === 'fulfilled' && !settled.value?.error ? settled.value : null);

async function reviewAsksByTechnician(conn, from, to) {
  const rows = await conn('review_requests')
    .whereNotNull('technician_id')
    .whereBetween('service_date', [from, to])
    .where((q) => q.whereNotNull('sms_sent_at').orWhereNotNull('sent_at'))
    .whereRaw(ASK_TOUCH_SQL)
    .groupBy('technician_id')
    .select('technician_id', conn.raw('COUNT(*) AS asks'));
  return new Map(rows.map((row) => [String(row.technician_id), Number(row.asks)]));
}

// Per technician: days worked and the sums the per-stop figures divide.
function totalsByTechnician(days) {
  const byTech = new Map();
  for (const day of days) {
    for (const { technicianId, technician, actual } of day.byTech) {
      const stops = actual?.physicalStops ?? actual?.stops;
      if (!technicianId || !(stops > 0)) continue;
      const t = byTech.get(technicianId) || {
        technicianId, technician, dates: [], stops: 0,
        onSiteMinutes: 0, onSiteRecorded: 0, onSiteCompleted: 0, driveMinutes: 0, driveStops: 0, driveDays: 0,
      };
      t.dates.push(day.date);
      t.stops += stops;
      t.onSiteCompleted += actual.onSiteCoverage?.total ?? 0;
      if (actual.onSiteMinutes != null) {
        t.onSiteMinutes += actual.onSiteMinutes;
        t.onSiteRecorded += actual.onSiteCoverage.covered;
      }
      if (actual.driveMinutes != null) {
        t.driveMinutes += actual.driveMinutes;
        t.driveStops += stops;
        t.driveDays += 1;
      }
      byTech.set(technicianId, t);
    }
  }
  return byTech;
}

// Average cost of one worked day, or null: no day may lack a card with rates and paid hours.
async function costPerDay(conn, technicianId, dates) {
  if (!techCostRatesLive()) return null;
  let cents = 0;
  try {
    for (const date of dates) {
      const card = await cardInEffect(conn, 'technician_cost_cards', 'technician_id', technicianId, date);
      const rates = card && await loadVisitRates(conn, technicianId, date);
      const hours = Number(card?.paid_hours_per_day);
      if (!rates || !(hours > 0)) return null;
      cents += Math.round(rates.laborPerWorkedHourCents * hours);
    }
  } catch {
    return null; // a failed card read is "no cost", never a partial total
  }
  return round(cents / dates.length / 100, 2);
}

async function buildRow(conn, t, { callbacks, asks, leaderboard }) {
  const id = String(t.technicianId);
  const daysWorked = t.dates.length;
  const reasons = {};
  const known = (key, value, reason) => {
    if (value == null) reasons[key] = reason;
    return value;
  };

  const lead = leaderboard?.find((r) => r.techId != null && String(r.techId) === id);
  let revenue = null;
  if (!leaderboard) reasons.revenuePerDay = 'revenue unavailable';
  else if (!(lead?.revenue > 0)) reasons.revenuePerDay = 'no revenue on the week\'s service records';
  else revenue = lead.revenue;
  const cost = await costPerDay(conn, t.technicianId, t.dates);

  return {
    technicianId: t.technicianId,
    technician: t.technician,
    daysWorked,
    completedStops: t.stops,
    stopsPerDay: round(t.stops / daysWorked, 1),
    onSiteMinutesPerStop: known('onSiteMinutesPerStop',
      t.onSiteRecorded ? round(t.onSiteMinutes / t.onSiteRecorded, 1) : null, 'no recorded on-site minutes'),
    onSiteTargetMinutes: ON_SITE_TARGET_MINUTES,
    onSiteCoverage: { recorded: t.onSiteRecorded, completed: t.onSiteCompleted },
    driveMinutesPerStop: known('driveMinutesPerStop',
      t.driveStops ? round(t.driveMinutes / t.driveStops, 1) : null, 'no timed Bouncie trips'),
    driveCoverage: { days: t.driveDays, of: daysWorked },
    callbacks: known('callbacks', callbacks ? (callbacks.get(id) || 0) : null, 'callback query failed'),
    reviewAsks: known('reviewAsks', asks ? (asks.get(id) || 0) : null, 'review ask query failed'),
    revenuePerDay: revenue == null ? null : round(revenue / daysWorked, 2),
    costPerDay: known('costPerDay', cost, 'no cost card'),
    lowSample: t.stops < MIN_STOPS,
    reasons,
  };
}

async function buildTechScorecard(conn = db, now = new Date()) {
  const from = etWeekStart(addETDays(now, -7));
  const to = etDateString(addETDays(parseETDateTime(`${from}T00:00`), 6));
  const { computeCoreKpis } = require('../routes/admin-dashboard');
  const [scorecard, callbacks, asks, kpis] = (await Promise.allSettled([
    getDayScorecard({ date_from: from, date_to: to }, conn, now),
    callbackCreditByTechnician(conn, { start: from, endDate: to }),
    reviewAsksByTechnician(conn, from, to),
    computeCoreKpis('last_7', { from, to }),
  ]));
  const result = {
    week: { from, to }, onSiteTargetMinutes: ON_SITE_TARGET_MINUTES, rows: [],
    note: 'Last full week, Monday to Sunday ET. A null value has its reason in the row\'s reasons; it is unknown, not 0. '
      + 'Drive minutes are the Bouncie day total, so they include the legs to the first stop and home from the last.',
  };
  if (!outcome(scorecard)) return { ...result, unavailable: 'day scorecard unavailable' };

  // An empty leaderboard is the dashboard's own failure value, so it reads as unavailable.
  const leaderboard = outcome(kpis)?.leaderboard;
  const sources = { callbacks: outcome(callbacks), asks: outcome(asks), leaderboard: leaderboard?.length ? leaderboard : null };
  const totals = [...totalsByTechnician(scorecard.value.days).values()];
  const rows = await Promise.all(totals.map((t) => buildRow(conn, t, sources)));
  return { ...result, rows: rows.sort((a, b) => String(a.technician).localeCompare(String(b.technician))) };
}

module.exports = { buildTechScorecard, reviewAsksByTechnician, ON_SITE_TARGET_MINUTES };

/**
 * Tech Rewards scoreboard (Plan D5-4, owner ruling 2026-11-20). One technician's own numbers, read only:
 * the live season score and its five parts, the review rate, commission year to date, the season bonus
 * estimate and the next stay bonus date. It reuses the finished pieces: tech-rewards-scores.js (the score
 * parts and settings), tech-rewards-calc.js (band, multiplier, season bonus, stay bonus),
 * review-outreach-templates.js ASK_TOUCH_SQL (what counts as a review ask) and the payroll tables the pay runs
 * write. It writes nothing: no pay line, no pay run row, no message.
 *
 * Which season (the off-season choice). The season is Mar 1 - Aug 31. From Mar 1 to Dec 31 the board shows
 * THAT year's season: running until Aug 31 ('running', the numbers so far), then 'final' (the season is over;
 * the bonus is paid the last Friday of September). Jan 1 - Feb 28 shows LAST year's season as 'final', since
 * the new season has not begun. So there is never an empty board: after the season it keeps showing the
 * closed season's final figures until the next one starts.
 *
 * Every money figure other than commission is an ESTIMATE (the calculator run on the pay recorded so far;
 * the office finalizes the pay). Nothing here is a promise of pay: the pay lines come in D5-5.
 *
 * The level part of the multiplier has no source yet (the career ladder is not recorded anywhere): the
 * calculator runs at entry level 1 and the board says so (levelSource 'entry_default'). The multiplier
 * estimate is therefore the floor for a technician who holds a higher level.
 *
 * ONE read-only REPEATABLE READ snapshot covers the score parts, the settings, the review counts, the pay
 * sums and the technician row, so no figure disagrees with another.
 *
 * Privacy: the figures are the technician's own totals. No customer name, id or address is read or returned.
 */
const db = require('../models/db');
const calc = require('./tech-rewards-calc');
const scores = require('./tech-rewards-scores');
const { deliveredAskEventsForTechnician } = require('./review-ask-history');
const { PAYOUT_ELIGIBLE_SOURCES } = require('./review-incentives');
const { SOURCE_TYPE: COMMISSION_SOURCE_TYPE } = require('./payroll-commission');
const { SOURCE_TYPE: REVIEW_BONUS_SOURCE_TYPE } = require('./payroll-review-bonuses');
const { etDateString } = require('../utils/datetime-et');
const { STAFF_TIME_ZONE, addStaffWorkDays } = require('../utils/staff-time-work-date');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The level ladder has no source yet: the calculator's entry level.
const ENTRY_LEVEL = 1;
const PART_KEYS = Object.freeze(['onTime', 'audit', 'callbacks', 'truck', 'ownerRating']);

class ScoreboardError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ScoreboardError';
    this.status = status;
    this.code = code;
  }
}

const toCents = (value) => Number(value) || 0;

// 'YYYY-MM-DD' minus one year, for the stay bonus's prior 12 months (Feb 29 -> Feb 28).
function yearBefore(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const day = m === 2 && d === 29 ? 28 : d;
  return `${String(y - 1).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Which season the board shows on a date (see the header). Pure.
 * { year, start, end, status: 'running' | 'final', asOf, payDate }
 */
function pickSeason(today) {
  const [year, month] = today.split('-').map(Number);
  const seasonYear = month >= 3 ? year : year - 1;
  const { start, end } = calc.seasonWindow(seasonYear);
  const running = today >= start && today <= end;
  return {
    year: seasonYear, start, end,
    status: running ? 'running' : 'final',
    asOf: running ? today : end, // the calculator takes the season year from this date
    payDate: calc.seasonBonusPayDate(seasonYear),
  };
}

// Reviews / asks in basis points, 0..10000, or null when no ask went out (no rate to measure).
function reviewRateBps(reviews, asks) {
  if (!asks) return null;
  return Math.min(10000, Math.round((reviews * 10000) / asks));
}

// No score settings are in force for the season date: no score, no weights, no band, and no bonus; never a guess.
const UNAVAILABLE_SCORE = Object.freeze({ complete: false, value: null, missing: [], parts: {}, band: null, settingsVersion: null, unavailable: 'no_settings' });

function scoreBlock(seasonScore, settings) {
  if (!seasonScore) return { ...UNAVAILABLE_SCORE };
  const weights = (seasonScore.settings || settings).weights;
  const parts = Object.fromEntries(PART_KEYS.map((key) => [key, { value: seasonScore.parts[key], weight: weights[key] }]));
  if (!seasonScore.complete) {
    return { complete: false, value: null, missing: seasonScore.missing, parts, band: null, settingsVersion: (settings || {}).version ?? null };
  }
  return {
    complete: true, value: seasonScore.score, missing: [], parts,
    band: { rateBps: seasonScore.rateBps, cutLines: seasonScore.settings.cutLines },
    settingsVersion: seasonScore.settings.version,
  };
}

function multiplierBlock(hireDate, season, rateBps) {
  if (!hireDate) return { reason: 'no_hire_date' };
  if (hireDate > season.asOf) return { reason: 'hired_after_season' };
  const m = calc.seasonMultiplier({ hireDate, asOf: season.asOf, reviewRateBps: rateBps ?? 0, level: ENTRY_LEVEL });
  return { multiplierE4: m.multiplierE4, parts: m.parts, tenureYears: m.tenureYears, level: ENTRY_LEVEL, levelSource: 'entry_default' };
}

function seasonBonusBlock(score, multiplier, grossCents) {
  const base = { grossCents, estimate: true };
  if (score.unavailable) return { ...base, estimateCents: null, reason: score.unavailable };
  if (!score.complete) return { ...base, estimateCents: null, reason: 'score_incomplete' };
  if (multiplier.multiplierE4 == null) return { ...base, estimateCents: null, reason: multiplier.reason };
  const estimateCents = calc.seasonBonusCents({
    score: score.value, grossCentsMarToAug: grossCents, multiplierE4: multiplier.multiplierE4, cutLines: score.band.cutLines,
  });
  return { ...base, estimateCents, rateBps: score.band.rateBps, multiplierE4: multiplier.multiplierE4 };
}

function stayBonusBlock(hireDate, today, priorPayCents) {
  if (!hireDate || hireDate > today) return null;
  const next = calc.stayBonus({ hireDate, asOf: today, priorTwelveMonthsPayCents: priorPayCents });
  if (!next) return null;
  const years = next.rateBps === calc.STAY_BONUS_1_YEAR_BPS ? 1 : next.rateBps === calc.STAY_BONUS_3_YEAR_BPS ? 3 : 5;
  const earningsStart = yearBefore(next.dueDate);
  const base = { dueDate: next.dueDate, years, rateBps: next.rateBps, estimate: true, earningsStart };
  // the 12 months that earn this bonus have not begun: no amount to show yet (never $0.00), only the date
  if (earningsStart > today) return { ...base, estimateCents: null };
  // the estimate is the pay recorded so far in the 12 months before the due date; the due date's own pay run decides
  return { ...base, estimateCents: next.cents };
}

/**
 * The scoreboard from the already-read inputs. Pure: no database, no clock.
 * inputs: { technician: { id, name, hireDate }, today, season, seasonScore, settings, reviews, asks,
 *           grossSeasonCents, priorYearGrossCents, commission: { paidCents, unpaidCents },
 *           commissionRecordedThrough: { payDate, weekEnd } | null }
 */
function composeScoreboard(inputs) {
  const { technician, today, season, seasonScore, settings } = inputs;
  const rateBps = reviewRateBps(inputs.reviews, inputs.asks);
  const score = scoreBlock(seasonScore, settings);
  const multiplier = multiplierBlock(technician.hireDate, season, rateBps);
  return {
    technician: { id: technician.id, name: technician.name },
    asOf: today,
    season: { year: season.year, start: season.start, end: season.end, status: season.status, payDate: season.payDate },
    score,
    reviews: { count: inputs.reviews, asks: inputs.asks, rateBps, multiplierPartE4: multiplier.parts ? multiplier.parts.reviewRateE4 : null },
    commission: {
      year: Number(today.slice(0, 4)),
      yearToDateCents: inputs.commission.paidCents + inputs.commission.unpaidCents,
      paidCents: inputs.commission.paidCents,
      unpaidCents: inputs.commission.unpaidCents,
      // the commission ledger is written by the pay run sync (payroll-commission.js syncCommissionLines, at every
      // draft, recompute and finalize), so a payment after the last sync is not here yet: the board says how far
      // it is recorded and never projects
      recordedThrough: inputs.commissionRecordedThrough || null,
    },
    multiplier,
    seasonBonus: seasonBonusBlock(score, multiplier, inputs.grossSeasonCents),
    stayBonus: stayBonusBlock(technician.hireDate, today, inputs.priorYearGrossCents),
  };
}

// ---------------------------------------------------------------------------
// Reads (all on the one snapshot connection)

async function readTechnician(conn, technicianId) {
  const row = await conn('technicians').where({ id: technicianId })
    .first('id', 'name', conn.raw("to_char(hire_date, 'YYYY-MM-DD') AS hire_date"));
  if (!row) throw new ScoreboardError(404, 'NOT_FOUND', 'Technician not found.');
  return { id: row.id, name: row.name, hireDate: row.hire_date || null };
}

// ET date of a window bound, as the SQL the reads below share.
const ET_DATE_IN_WINDOW = (column) => `(${column} AT TIME ZONE '${STAFF_TIME_ZONE}')::date >= ?::date AND (${column} AT TIME ZONE '${STAFF_TIME_ZONE}')::date <= ?::date`;

// Google reviews credited to the technician from the season start to the board's as-of date (every credited
// review counts toward the rate, whether or not the monthly pay cap paid it).
async function readReviewCount(conn, technicianId, season) {
  const row = await conn('review_incentive_payouts')
    .where({ technician_id: technicianId })
    .whereIn('source', PAYOUT_ELIGIBLE_SOURCES)
    .whereRaw(ET_DATE_IN_WINDOW('earned_at'), [season.start, season.asOf])
    .count({ n: '*' })
    .first();
  return Number(row?.n) || 0;
}

// Review asks the technician's visits delivered in the window, by the ET day each went out (review-ask-history.js:
// the initial ask and a delivered follow-up each count on their own send day; the follow-up's stamp and its
// audit-log record are one ask). An ask sent after the season for a visit inside it belongs to the next one.
async function readAskCount(conn, technicianId, season) {
  const events = await deliveredAskEventsForTechnician(conn, technicianId);
  return events.filter(({ at }) => {
    const day = etDateString(at);
    return day >= season.start && day <= season.asOf;
  }).length;
}

const DAY_MS = 86400000;
const dayNumber = (dateStr) => Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / DAY_MS);
// half-up a x b / c for non-negative integers
const mulDivRound = (a, b, c) => Math.floor((2 * a * b + c) / (2 * c));

/**
 * The share of one pay week's gross that falls on [from, to]. `dayMinutes` are the week's paid minutes by
 * work date ({ workDate, minutes }). With worked time on record the gross splits by the paid minutes on
 * in-window dates over the week's paid minutes, so the dates the work was done decide it; a week with no
 * worked time on record falls back to in-window days / 7. Half up, once per week.
 */
function weekShareCents(week, fromDay, toDay) {
  const start = dayNumber(week.weekStart);
  const days = Math.min(start + 6, toDay) - Math.max(start, fromDay) + 1;
  if (days <= 0) return 0;
  if (days >= 7) return week.grossCents;
  const minutes = (week.dayMinutes || []).map((d) => ({ day: dayNumber(d.workDate), hundredths: Math.round(Number(d.minutes) * 100) || 0 }));
  const total = minutes.reduce((sum, d) => sum + d.hundredths, 0);
  if (total <= 0) return mulDivRound(week.grossCents, days, 7);
  const inside = minutes.filter((d) => d.day >= fromDay && d.day <= toDay).reduce((sum, d) => sum + d.hundredths, 0);
  return mulDivRound(week.grossCents, inside, total);
}

/**
 * Gross pay EARNED in [from, to]: the work-week basis, not the pay date (the ruling measures work done
 * Mar 1 - Aug 31, and weekly pay means August work is paid in September). `weeks` are finalized checks as
 * { weekStart, grossCents, dayMinutes? }, a pay week being weekStart .. weekStart + 6. A week that straddles a
 * window edge counts only the share earned on in-window dates (weekShareCents). D5-5 pay lines MUST use this
 * helper (with readGross for the weeks) for the season bonus base and the stay bonus's prior 12 months, so the
 * board and the pay line can never differ.
 */
function earnedGrossCents(weeks, from, to) {
  const fromDay = dayNumber(from);
  const toDay = dayNumber(to);
  return weeks.reduce((total, week) => total + weekShareCents(week, fromDay, toDay), 0);
}

// The paid minutes by work date of one technician's week, from the daily summaries the weekly pay is summed from
// (time-tracking.js computeWeeklySummaryInTransaction: shift minutes less the unpaid meal, never below 0).
async function readDayMinutes(conn, technicianId, weekStart) {
  const rows = await conn('time_entry_daily_summary')
    .where({ technician_id: technicianId })
    .where('work_date', '>=', weekStart)
    .where('work_date', '<=', addStaffWorkDays(weekStart, 6))
    .select(conn.raw("to_char(work_date, 'YYYY-MM-DD') AS work_date"),
      conn.raw('GREATEST(COALESCE(total_shift_minutes, 0) - COALESCE(unpaid_meal_minutes, 0), 0) AS minutes'));
  return rows.map((row) => ({ workDate: row.work_date, minutes: Number(row.minutes) || 0 }));
}

// The day a pay line was EARNED (the same dating the commission year to date uses): a commission ledger line on the day
// of the payment it pays (covers_to), a review bonus on the day the review was credited, any other line (a hand-made
// commission, a bonus) in its own pay week (earned_week_start). `l` is payroll_pay_lines.
const LINE_EARNED_ON_SQL = `COALESCE(CASE l.source_type
    WHEN ? THEN l.covers_to
    WHEN ? THEN (SELECT (p.earned_at AT TIME ZONE ?)::date FROM review_incentive_payouts p WHERE p.id::text = l.source_id)
  END, l.earned_week_start)`;
const lineEarnedOnBindings = () => [COMMISSION_SOURCE_TYPE, REVIEW_BONUS_SOURCE_TYPE, STAFF_TIME_ZONE];

/**
 * Gross pay earned in [from, to], in two parts. WAGES: each finalized check's gross less the pay lines paid on it
 * (commission, review bonus, other lines), by work week through earnedGrossCents (a catch-up line paid in a later
 * week must not move wages). LINES: each paid line counts in full on the day it was earned (LINE_EARNED_ON_SQL),
 * wherever it was paid. D5-5 pay lines use this function for the season bonus base and the stay bonus's prior 12
 * months.
 */
async function readGross(conn, technicianId, from, to) {
  const rows = await conn('payroll_checks as c')
    .join('payroll_runs as r', 'r.id', 'c.run_id')
    .where({ 'c.technician_id': technicianId, 'c.status': 'finalized', 'r.status': 'finalized' })
    .whereRaw('c.week_start + 6 >= ?::date AND c.week_start <= ?::date', [from, to])
    .select(conn.raw("to_char(c.week_start, 'YYYY-MM-DD') AS week_start"), 'c.gross_cents',
      conn.raw("COALESCE((SELECT SUM(l.amount_cents) FROM payroll_pay_lines l WHERE l.check_id = c.id AND l.status = 'paid'), 0) AS lines_cents"));
  const weeks = [];
  for (const row of rows) {
    const week = { weekStart: row.week_start, grossCents: Math.max(0, toCents(row.gross_cents) - toCents(row.lines_cents)) };
    if (week.weekStart < from || addStaffWorkDays(week.weekStart, 6) > to) week.dayMinutes = await readDayMinutes(conn, technicianId, week.weekStart);
    weeks.push(week);
  }
  const lines = await conn('payroll_pay_lines as l')
    .join('payroll_checks as c', 'c.id', 'l.check_id')
    .join('payroll_runs as r', 'r.id', 'c.run_id')
    .where({ 'l.technician_id': technicianId, 'l.status': 'paid', 'c.status': 'finalized', 'r.status': 'finalized' })
    .whereRaw(`${LINE_EARNED_ON_SQL} >= ?::date AND ${LINE_EARNED_ON_SQL} <= ?::date`,
      [...lineEarnedOnBindings(), from, ...lineEarnedOnBindings(), to])
    .sum({ cents: 'l.amount_cents' })
    .first();
  return earnedGrossCents(weeks, from, to) + toCents(lines?.cents);
}

// Commission pay lines earned from Jan 1 to today: 'paid' on a finalized check, 'open' on a run not finalized yet,
// dated by LINE_EARNED_ON_SQL.
async function readCommission(conn, technicianId, today) {
  const rows = await conn('payroll_pay_lines as l')
    .where({ 'l.technician_id': technicianId, 'l.kind': 'commission' })
    .whereIn('l.status', ['open', 'paid'])
    .whereRaw(`${LINE_EARNED_ON_SQL} >= ?::date AND ${LINE_EARNED_ON_SQL} <= ?::date`,
      [...lineEarnedOnBindings(), `${today.slice(0, 4)}-01-01`, ...lineEarnedOnBindings(), today])
    .groupBy('l.status')
    .select('l.status', conn.raw('SUM(l.amount_cents) AS cents'));
  const by = Object.fromEntries(rows.map((row) => [row.status, toCents(row.cents)]));
  return { paidCents: by.paid || 0, unpaidCents: by.open || 0 };
}

// Score settings that are not in force on the season date make the score and the bonus unavailable; nothing is guessed.
const isNoSettings = (err) => err instanceof scores.TechRewardsScoresError && err.code === 'NO_SETTINGS_IN_FORCE';

async function readScore(conn, technicianId, season) {
  try {
    const seasonScore = await scores.buildSeasonScore(technicianId, season.year, { start: season.start, end: season.asOf }, conn);
    // an incomplete score carries no settings: read the weights the parts would be weighed with
    const settings = seasonScore.complete ? null : await scores.getSettings(season.asOf, conn);
    return { seasonScore, settings };
  } catch (err) {
    if (isNoSettings(err)) return { seasonScore: null, settings: null };
    throw err;
  }
}

// The day before a date (ET calendar).
const dayBefore = (dateStr) => addStaffWorkDays(dateStr, -1);

// How far the commission ledger is recorded: the newest pay run that is not voided (every draft, recompute and
// finalize of a run syncs commission for all W-2 technicians, payroll-commission.js), as its pay date and the end of
// its pay week (the sync records payments up to that day). null when no pay run exists.
async function readCommissionRecordedThrough(conn) {
  const row = await conn('payroll_runs')
    .whereNot({ status: 'voided' })
    .orderBy('week_start', 'desc')
    .first(conn.raw("to_char(pay_date, 'YYYY-MM-DD') AS pay_date"), conn.raw("to_char(week_start + 6, 'YYYY-MM-DD') AS week_end"));
  return row ? { payDate: row.pay_date, weekEnd: row.week_end } : null;
}

async function readAll(conn, technicianId, today) {
  const technician = await readTechnician(conn, technicianId);
  const season = pickSeason(today);
  // the score and its settings are cut at the board's as-of date: a running season never reads a later change
  const { seasonScore, settings } = await readScore(conn, technicianId, season);
  // the stay bonus pays on the next anniversary from the 12 months before IT, up to the day before it or today,
  // whichever comes first: the pay recorded so far in that window
  const due = stayBonusBlock(technician.hireDate, today, 0);
  const stayEnd = due ? (due.dueDate <= today ? dayBefore(due.dueDate) : today) : null;
  return {
    technician, today, season, seasonScore, settings,
    asks: await readAskCount(conn, technicianId, season),
    reviews: await readReviewCount(conn, technicianId, season),
    grossSeasonCents: await readGross(conn, technicianId, season.start, season.asOf),
    priorYearGrossCents: due && due.estimateCents !== null ? await readGross(conn, technicianId, due.earningsStart, stayEnd) : 0,
    commission: await readCommission(conn, technicianId, today),
    commissionRecordedThrough: await readCommissionRecordedThrough(conn),
  };
}

/**
 * One technician's scoreboard. `technicianId` must be a uuid (ScoreboardError 400); an unknown technician is 404.
 * `now` is for tests (a Date). One REPEATABLE READ, read-only transaction.
 */
async function getScoreboard(technicianId, { now = new Date() } = {}) {
  if (typeof technicianId !== 'string' || !UUID_RE.test(technicianId)) throw new ScoreboardError(400, 'INVALID_TECHNICIAN', 'Technician id is not valid.');
  const id = technicianId.toLowerCase();
  const today = etDateString(now);
  const inputs = await db.transaction((trx) => readAll(trx, id, today), { isolationLevel: 'repeatable read', readOnly: true });
  return composeScoreboard(inputs);
}

/** Active technicians for the admin preview picker: id and name only. */
async function listTechnicians(conn = db) {
  const rows = await conn('technicians').where({ active: true }).orderBy('name').select('id', 'name');
  return rows.map((row) => ({ id: row.id, name: row.name }));
}

module.exports = { ScoreboardError, getScoreboard, listTechnicians, composeScoreboard, pickSeason, reviewRateBps, earnedGrossCents };

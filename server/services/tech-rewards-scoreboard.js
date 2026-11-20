/**
 * Tech Rewards scoreboard (Plan D5-4, owner ruling 2026-11-20). One technician's own numbers, read only:
 * the live season score and its five parts, the review rate, commission year to date, the season bonus
 * estimate and the next stay bonus date. It reuses the finished pieces: tech-rewards-scores.js (the score
 * parts and settings), tech-rewards-calc.js (band, multiplier, season bonus, stay bonus),
 * bi-tech-scorecard.js reviewAsksByTechnician (the review ask count) and the payroll tables the pay runs
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
const { reviewAsksByTechnician } = require('./bi-tech-scorecard');
const { PAYOUT_ELIGIBLE_SOURCES } = require('./review-incentives');
const { etDateString } = require('../utils/datetime-et');
const { STAFF_TIME_ZONE } = require('../utils/staff-time-work-date');

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

function scoreBlock(seasonScore, settings) {
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
  // the estimate is the pay recorded so far in the 12 months before the due date; the due date's own pay run decides
  return { dueDate: next.dueDate, years, rateBps: next.rateBps, estimateCents: next.cents, estimate: true };
}

/**
 * The scoreboard from the already-read inputs. Pure: no database, no clock.
 * inputs: { technician: { id, name, hireDate }, today, season, seasonScore, settings, reviews, asks,
 *           grossSeasonCents, priorYearGrossCents, commission: { paidCents, pendingCents } }
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
      yearToDateCents: inputs.commission.paidCents + inputs.commission.pendingCents,
      paidCents: inputs.commission.paidCents,
      pendingCents: inputs.commission.pendingCents,
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

// Google reviews credited to the technician in the season (every credited review counts toward the
// rate, whether or not the monthly pay cap paid it).
async function readReviewCount(conn, technicianId, season) {
  const row = await conn('review_incentive_payouts')
    .where({ technician_id: technicianId })
    .whereIn('source', PAYOUT_ELIGIBLE_SOURCES)
    .whereRaw('(earned_at AT TIME ZONE ?)::date >= ?::date AND (earned_at AT TIME ZONE ?)::date <= ?::date', [STAFF_TIME_ZONE, season.start, STAFF_TIME_ZONE, season.end])
    .count({ n: '*' })
    .first();
  return Number(row?.n) || 0;
}

// Gross pay of the technician's finalized checks whose pay week starts in [from, to].
async function readGross(conn, technicianId, from, to) {
  const row = await conn('payroll_checks as c')
    .join('payroll_runs as r', 'r.id', 'c.run_id')
    .where({ 'c.technician_id': technicianId, 'c.status': 'finalized', 'r.status': 'finalized' })
    .whereRaw('c.week_start >= ?::date AND c.week_start <= ?::date', [from, to])
    .sum({ gross: 'c.gross_cents' })
    .first();
  return toCents(row?.gross);
}

// Commission pay lines earned in the calendar year: 'paid' on a finalized check, 'open' waiting for the next run.
async function readCommission(conn, technicianId, year) {
  const rows = await conn('payroll_pay_lines')
    .where({ technician_id: technicianId, kind: 'commission' })
    .whereIn('status', ['open', 'paid'])
    .whereRaw('earned_week_start >= ?::date AND earned_week_start <= ?::date', [`${year}-01-01`, `${year}-12-31`])
    .groupBy('status')
    .select('status', conn.raw('SUM(amount_cents) AS cents'));
  const by = Object.fromEntries(rows.map((row) => [row.status, toCents(row.cents)]));
  return { paidCents: by.paid || 0, pendingCents: by.open || 0 };
}

async function readAll(conn, technicianId, today) {
  const technician = await readTechnician(conn, technicianId);
  const season = pickSeason(today);
  const seasonScore = await scores.buildSeasonScore(technicianId, season.year, { start: season.start, end: season.end }, conn);
  // an incomplete score carries no settings: read the weights the parts would be weighed with
  const settings = seasonScore.complete ? null : await scores.getSettings(season.end, conn);
  const asks = (await reviewAsksByTechnician(conn, season.start, season.end)).get(technicianId) || 0;
  return {
    technician, today, season, seasonScore, settings, asks,
    reviews: await readReviewCount(conn, technicianId, season),
    grossSeasonCents: await readGross(conn, technicianId, season.start, season.asOf),
    priorYearGrossCents: await readGross(conn, technicianId, yearBefore(today), today),
    commission: await readCommission(conn, technicianId, Number(today.slice(0, 4))),
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

module.exports = { ScoreboardError, getScoreboard, listTechnicians, composeScoreboard, pickSeason, reviewRateBps };

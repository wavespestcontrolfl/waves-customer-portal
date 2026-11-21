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
const { countDeliveredAsksForTechnician } = require('./review-ask-history');
const { weeksOfLine, lineOvertimePremium } = require('./payroll-regular-rate');
const { TECH_REWARD_KINDS } = require('./payroll-pay-lines');
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
  // the 12 months of pay end the day before the anniversary: that is the day the estimate is final
  const base = { dueDate: next.dueDate, years, rateBps: next.rateBps, estimate: true, earningsStart, earningsEnd: addStaffWorkDays(next.dueDate, -1) };
  // the 12 months that earn this bonus have not begun: no amount to show yet (never $0.00), only the date
  if (earningsStart > today) return { ...base, estimateCents: null };
  // the estimate is the pay recorded so far in the 12 months before the due date; the due date's own pay run decides
  return { ...base, estimateCents: next.cents };
}

/**
 * The scoreboard from the already-read inputs. Pure: no database, no clock.
 * inputs: { technician: { id, name, hireDate }, today, season, seasonScore, settings, reviews, asks,
 *           grossSeasonCents, priorYearGrossCents, commission: { paidCents, unpaidCents },
 *           commissionRecordedThrough: { weekEnd } | null }
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

// Review asks the technician's visits delivered from the season start to the board's date, by the ET day each went
// out (review-ask-history.js: the initial ask and a delivered follow-up each count on their own send time; the
// follow-up's stamp and its audit-log record are one ask), counted in PostgreSQL. An ask sent after the season for a
// visit inside it belongs to the next one.
const readAskCount = (conn, technicianId, season) => countDeliveredAsksForTechnician(conn, technicianId,
  { from: season.start, to: season.asOf, timeZone: STAFF_TIME_ZONE });

const DAY_MS = 86400000;
const dayNumber = (dateStr) => Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / DAY_MS);
// half-up a x b / c for non-negative integers
const mulDivRound = (a, b, c) => Math.floor((2 * a * b + c) / (2 * c));
// the same for a signed amount (a component can in principle be a negative adjustment)
const signedMulDivRound = (cents, b, c) => (cents < 0 ? -mulDivRound(-cents, b, c) : mulDivRound(cents, b, c));
const hundredths = (value) => Math.round(Number(value) * 100) || 0;

// A pay line's components. A line with an earning DAY takes that day. Any other line with a span (covers_from..covers_to:
// a hand-made commission or a monthly allowance) is split EQUALLY over the workweeks of the span, by the very helper the
// overtime premium uses (payroll-regular-rate.js weeksOfLine, 29 CFR 778.120); the cents that do not divide go one each to the
// earliest weeks. A week's share is then spread over the days of that week the span COVERS (the first and last weeks of a
// span cover fewer than 7), so it counts in a window by its covered days in the window / its covered days. A line with no
// span has only its earned pay week: that week's in-window days / 7.
function lineComponents(line) {
  if (line.earnedOn) return [{ cents: line.cents, spread: [{ date: line.earnedOn, weight: 1 }] }];
  if (!(line.coversFrom && line.coversTo)) return [{ cents: line.cents, week: line.weekStart }];
  const weeks = weeksOfLine({ coversFrom: line.coversFrom, coversTo: line.coversTo, weekStart: line.weekStart });
  const base = Math.trunc(line.cents / weeks.length);
  const extra = line.cents - base * weeks.length;
  return weeks.map((week, i) => {
    const first = week < line.coversFrom ? line.coversFrom : week;
    const weekEnd = addStaffWorkDays(week, 6);
    const last = weekEnd > line.coversTo ? line.coversTo : weekEnd;
    const spread = [];
    for (let day = first; day <= last; day = addStaffWorkDays(day, 1)) spread.push({ date: day, weight: 1 });
    return { cents: base + (i < extra ? 1 : 0), spread };
  });
}

/**
 * The gross of one finalized check, split into the components payroll-calc.js computePaycheck adds up
 * (gross = regularPay + overtimePay + ptoPay + holidayPay + reviewBonus + commission + healthAllowance +
 * lineOvertimePremium; the employer HSA is not in gross). Each component has ONE earning rule, from data the pay
 * run already stores. A component is { cents, spread: [{ date, weight }] } (earned on dated days, in proportion
 * to the weights) or { cents, week } (earned in a week only; counts its in-window days / 7).
 *
 *   component (payroll_checks column)      earning date rule                            data used
 *   regular + overtime pay                 shift work dates of the check's week,        time_entry_daily_summary paid minutes
 *   (regular_pay_cents + overtime_pay_      weighted by paid minutes; the week's        by work_date, overtime_minutes of the
 *   cents; the weekly OT premium is in      overtime minutes are the LAST minutes       check (hours past 40 are worked last)
 *   overtime_pay)                           worked, at 1.5x
 *   paid time off (pto_pay_cents)          the dated PTO records of the week,           payroll_time_off (kind pto)
 *                                           weighted by minutes
 *   holiday pay (holiday_pay_cents)        the dated holiday records of the week,       payroll_time_off (kind holiday)
 *                                           weighted by minutes
 *   commission lines (commission_cents)    the payment day for a ledger line            payroll_pay_lines of the check:
 *   review bonus lines (review_bonus_      (covers_to), the day the review was          LINE_DAY_SQL
 *   cents), health allowance lines         credited for a review bonus; a line with
 *   (health_allowance_cents)               no such day (hand-made, allowance) only
 *                                           has its earned pay week: in-window days / 7;
 *                                           a spanned line (covers_from..covers_to) is split
 *                                           equally over its workweeks (weeksOfLine), each
 *                                           week's share over that week's COVERED days
 *   catch-up overtime premium              the earned weeks of the line pay it          calc_snapshot.lineOvertimeWeeks
 *   (line_overtime_premium_cents)          comes from (each week's premiumCents)
 *   season bonus, stay bonus, December     NOT PAID BY WORK: left out of the base      payroll_checks.tech_rewards_cents
 *   gift (tech_rewards_cents)              (D5-5: a bonus never feeds a bonus)
 *   anything else (gross minus the above   NO DATE: the check's own week, in-window     (a check with no day records, a
 *   and minus tech_rewards_cents)          days / 7                                     sum that does not add up)
 *
 * A component with no dated data (a straddling week with no daily summaries or time off records) falls back
 * to its week's in-window days / 7. The components of a check always add up to its gross_cents.
 */
function checkComponents(check) {
  const wageCents = check.regularPayCents + check.overtimePayCents;
  // paid minutes by day, the check's overtime minutes counted at the end of the week (1.5x: weights in half minutes)
  const days = [...(check.dayMinutes || [])].sort((a, b) => (a.workDate < b.workDate ? -1 : 1))
    .map((d) => ({ date: d.workDate, minutes: hundredths(d.minutes) }));
  let overtimeLeft = hundredths(check.overtimeMinutes);
  const weights = [];
  for (let i = days.length - 1; i >= 0; i -= 1) {
    const overtime = Math.min(days[i].minutes, overtimeLeft);
    overtimeLeft -= overtime;
    weights.unshift({ date: days[i].date, weight: (days[i].minutes - overtime) * 2 + overtime * 3 });
  }
  const timeOff = (records) => (records || []).map((r) => ({ date: r.workDate, weight: hundredths(r.minutes) }));
  const components = [
    { cents: wageCents, spread: weights },
    { cents: check.ptoPayCents, spread: timeOff(check.ptoRecords) },
    { cents: check.holidayPayCents, spread: timeOff(check.holidayRecords) },
    ...(check.lines || []).flatMap(lineComponents),
    ...(check.lineOvertimeWeeks || []).map((w) => ({ cents: w.premiumCents, week: w.weekStart })),
  ];
  const known = components.reduce((sum, c) => sum + c.cents, 0);
  // Season bonus, stay bonus and December gift (D5-5) are rewards on top of the work, not pay earned by it, and neither is the
  // overtime they cause (techRewardsPremiumCents, already taken out of lineOvertimeWeeks): they are not part of a bonus base, so no
  // bonus feeds another and the board's base is the same before and after one is paid.
  components.push({ cents: check.grossCents - known - (check.techRewardsCents || 0) - (check.techRewardsPremiumCents || 0), week: check.weekStart });
  return components;
}

// The share of one component that falls on [fromDay, toDay] (day numbers), half up once.
function componentShareCents(component, checkWeekStart, fromDay, toDay) {
  const { cents } = component;
  if (!cents) return 0;
  const spread = component.spread || [];
  const total = spread.reduce((sum, d) => sum + d.weight, 0);
  if (total > 0) {
    const inside = spread.filter((d) => dayNumber(d.date) >= fromDay && dayNumber(d.date) <= toDay).reduce((sum, d) => sum + d.weight, 0);
    return signedMulDivRound(cents, inside, total);
  }
  const start = dayNumber(component.week || checkWeekStart);
  const days = Math.min(start + 6, toDay) - Math.max(start, fromDay) + 1;
  if (days <= 0) return 0;
  return days >= 7 ? cents : signedMulDivRound(cents, days, 7);
}

/**
 * Gross pay EARNED in [from, to] by work, not by pay date (the ruling measures work done Mar 1 - Aug 31, and
 * weekly pay means August work is paid in September; a catch-up line or premium paid later counts when it was
 * earned). It is the sum, over every finalized check, of the components (see checkComponents, which holds the
 * component table and each one's earning date rule) whose earning dates fall in the window; a component that
 * straddles an edge counts its in-window share. D5-5 pay lines MUST use this helper (with readGross) for the
 * season bonus base and the stay bonus's prior 12 months, so the board and the pay line can never differ.
 */
function earnedGrossCents(checks, from, to) {
  const fromDay = dayNumber(from);
  const toDay = dayNumber(to);
  return checks.reduce((total, check) => total
    + checkComponents(check).reduce((sum, c) => sum + componentShareCents(c, check.weekStart, fromDay, toDay), 0), 0);
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

// The dated paid time off and holiday records of one week (payroll_time_off).
async function readTimeOffRecords(conn, technicianId, weekStart) {
  const rows = await conn('payroll_time_off')
    .where({ technician_id: technicianId })
    .where('work_date', '>=', weekStart)
    .where('work_date', '<=', addStaffWorkDays(weekStart, 6))
    .select(conn.raw("to_char(work_date, 'YYYY-MM-DD') AS work_date"), 'kind', 'minutes');
  const records = (kind) => rows.filter((row) => row.kind === kind).map((row) => ({ workDate: row.work_date, minutes: Number(row.minutes) || 0 }));
  return { ptoRecords: records('pto'), holidayRecords: records('holiday') };
}

// The day a pay line was EARNED: a commission ledger line on the day of the payment it pays (covers_to), a review
// bonus on the day the review was credited; null for any other line (a hand-made commission, a bonus, an allowance),
// which has only its pay week (earned_week_start). `l` is payroll_pay_lines.
const LINE_DAY_SQL = `CASE l.source_type
    WHEN ? THEN l.covers_to
    WHEN ? THEN (SELECT (p.earned_at AT TIME ZONE ?)::date FROM review_incentive_payouts p WHERE p.id::text = l.source_id)
  END`;
// The commission year to date dates a line by its day, else by its pay week.
const LINE_EARNED_ON_SQL = `COALESCE(${LINE_DAY_SQL}, l.earned_week_start)`;
const lineEarnedOnBindings = () => [COMMISSION_SOURCE_TYPE, REVIEW_BONUS_SOURCE_TYPE, STAFF_TIME_ZONE];
// the pay line kinds that are in a check's gross (the employer HSA is not)
const GROSS_LINE_KINDS = ['review_bonus', 'commission', 'health_allowance'];

/**
 * The overtime a finalized check paid for ORDINARY pay lines, taken out of the check's stored premium (a bonus never feeds a
 * bonus): the Tech Rewards lines' part is left out of the base. `lines`: every pay line of the check { kind, cents, weekStart,
 * coversFrom, coversTo }; `storedWeeks`: the snapshot's [{ weekStart, workedMinutes, overtimeMinutes, premiumCents }].
 * Returns { weeks: [{ weekStart, premiumCents }], excludedCents }. Pure.
 * ONE RULE: the ordinary part is what the check would have paid WITHOUT its Tech Rewards lines. So a Tech Rewards line on a
 * check never moves the base, up or down.
 * - A check with no Tech Rewards line keeps its stored premium.
 * - A week no Tech Rewards line of the check covers keeps its stored premium too (those lines did nothing there), a make-up
 *   for an older check's shortfall included.
 * - A week one covers: the check's ordinary lines are priced again by the pay run's own rule (payroll-regular-rate.js
 *   lineOvertimePremium, the employer HSA included because it counts in the regular rate), from the hours the CHECK stored for
 *   the week, never from timesheets as they are now, so an edit after the check was paid cannot move the base. The rest is
 *   the Tech Rewards lines' part. Never over what the check stored for the week.
 * The pay run's rule reads what earlier checks paid for the week (a week can be paid on more than one check), so this one
 * does: `earlier` = { lines: every pay line the technician's EARLIER finalized checks paid, paid: Map of week -> the line
 * premium those checks stored }.
 */
function ordinaryPremium(lines, storedWeeks, earlier = {}) {
  const techKinds = new Set(TECH_REWARD_KINDS);
  const plain = storedWeeks.map((w) => ({ weekStart: w.weekStart, premiumCents: w.premiumCents }));
  const rewards = lines.filter((line) => techKinds.has(line.kind));
  if (!rewards.length || !storedWeeks.length) return { weeks: plain, excludedCents: 0 };
  const spanOf = (line) => ({ amountCents: line.cents, weekStart: line.weekStart, coversFrom: line.coversFrom || null, coversTo: line.coversTo || null });
  const rewardWeeks = new Set(rewards.flatMap((line) => weeksOfLine(spanOf(line))));
  const ordinary = lines.filter((line) => !techKinds.has(line.kind) && line.cents > 0).map(spanOf);
  const hours = storedWeeks.map((w) => ({
    weekStart: w.weekStart,
    regularMinutes: (Number(w.workedMinutes || 0) - Number(w.overtimeMinutes || 0)).toFixed(2),
    overtimeMinutes: Number(w.overtimeMinutes || 0).toFixed(2),
  }));
  const without = new Map((ordinary.length ? lineOvertimePremium({
    weeks: hours,
    lines: ordinary,
    earlierLines: (earlier.lines || []).filter((line) => line.cents > 0).map(spanOf),
    earlierPremiums: [...(earlier.paid || [])].map(([weekStart, premiumCents]) => ({ weekStart, premiumCents })),
  }).weeks : []).map((w) => [w.weekStart, w.premiumCents]));
  const weeks = [];
  for (const w of plain) {
    if (!rewardWeeks.has(w.weekStart)) weeks.push(w);
    else if (without.has(w.weekStart)) weeks.push({ weekStart: w.weekStart, premiumCents: Math.min(w.premiumCents, without.get(w.weekStart)) });
  }
  const sum = (list) => list.reduce((total, w) => total + w.premiumCents, 0);
  return { weeks, excludedCents: sum(plain) - sum(weeks) };
}

/**
 * The technician's finalized checks that can hold pay earned in [from, to] (every check whose pay week ends on or
 * after `from`: a catch-up line or premium can be paid long after it was earned), with their dated parts, then
 * earnedGrossCents. Day records are read only for a week that straddles a window edge.
 */
async function readGross(conn, technicianId, from, to) {
  const rows = await conn('payroll_checks as c')
    .join('payroll_runs as r', 'r.id', 'c.run_id')
    .where({ 'c.technician_id': technicianId, 'c.status': 'finalized', 'r.status': 'finalized' })
    .whereRaw('c.week_start + 6 >= ?::date', [from])
    .select('c.id', conn.raw("to_char(c.week_start, 'YYYY-MM-DD') AS week_start"), conn.raw("to_char(r.pay_date, 'YYYY-MM-DD') AS pay_date"), 'c.gross_cents', 'c.regular_pay_cents',
      'c.overtime_pay_cents', 'c.overtime_minutes', 'c.pto_pay_cents', 'c.holiday_pay_cents', 'c.tech_rewards_cents',
      conn.raw("COALESCE((c.calc_snapshot->'lineOvertimeWeeks')::jsonb, '[]'::jsonb) AS line_overtime_weeks"));
  if (!rows.length) return 0;
  const lineRows = await conn('payroll_pay_lines as l')
    .whereIn('l.check_id', rows.map((row) => row.id))
    .where('l.status', 'paid')
    .select('l.check_id', 'l.kind', 'l.amount_cents', conn.raw("to_char(l.earned_week_start, 'YYYY-MM-DD') AS week_start"),
      conn.raw("to_char(l.covers_from, 'YYYY-MM-DD') AS covers_from"), conn.raw("to_char(l.covers_to, 'YYYY-MM-DD') AS covers_to"),
      conn.raw(`to_char(${LINE_DAY_SQL}, 'YYYY-MM-DD') AS earned_on`, lineEarnedOnBindings()));
  const checks = [];
  // In pay order (pay date, then pay week: the order finalize keeps within a tax year), so each check is read with what the
  // checks before it paid (ordinaryPremium `earlier`), as the pay run priced it. Every check that paid a line for a week of
  // the window is in `rows`: a line is paid by its own week's run or a later one.
  rows.sort((a, b) => (a.pay_date || '').localeCompare(b.pay_date || '') || a.week_start.localeCompare(b.week_start));
  const earlier = { lines: [], paid: new Map() };
  for (const row of rows) {
    const ownLines = lineRows.filter((line) => line.check_id === row.id);
    const paidLines = ownLines.map((line) => ({ kind: line.kind, cents: toCents(line.amount_cents), weekStart: line.week_start, coversFrom: line.covers_from, coversTo: line.covers_to }));
    const storedWeeks = (Array.isArray(row.line_overtime_weeks) ? row.line_overtime_weeks : []).map((w) => ({
      weekStart: w.weekStart, workedMinutes: w.workedMinutes, overtimeMinutes: w.overtimeMinutes, premiumCents: toCents(w.premiumCents),
    }));
    const premium = ordinaryPremium(paidLines, storedWeeks, earlier);
    earlier.lines.push(...paidLines);
    for (const w of storedWeeks) earlier.paid.set(w.weekStart, (earlier.paid.get(w.weekStart) || 0) + w.premiumCents);
    const check = {
      weekStart: row.week_start,
      grossCents: toCents(row.gross_cents),
      regularPayCents: toCents(row.regular_pay_cents),
      overtimePayCents: toCents(row.overtime_pay_cents),
      overtimeMinutes: Number(row.overtime_minutes) || 0,
      ptoPayCents: toCents(row.pto_pay_cents),
      holidayPayCents: toCents(row.holiday_pay_cents),
      techRewardsCents: toCents(row.tech_rewards_cents),
      lines: ownLines.filter((line) => GROSS_LINE_KINDS.includes(line.kind))
        .map((line) => ({ cents: toCents(line.amount_cents), earnedOn: line.earned_on, weekStart: line.week_start, coversFrom: line.covers_from, coversTo: line.covers_to })),
      lineOvertimeWeeks: premium.weeks,
      techRewardsPremiumCents: premium.excludedCents,
    };
    const weekEnd = addStaffWorkDays(check.weekStart, 6);
    if (weekEnd >= from && check.weekStart <= to && (check.weekStart < from || weekEnd > to)) {
      check.dayMinutes = await readDayMinutes(conn, technicianId, check.weekStart);
      Object.assign(check, await readTimeOffRecords(conn, technicianId, check.weekStart));
    }
    checks.push(check);
  }
  return earnedGrossCents(checks, from, to);
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

// How far the commission ledger is proven recorded for this technician: the end of the pay week of their newest
// ledger line (payroll-commission.js writes a commission_payment line only in a sync whose week end is on or after the
// payment day, and a pay week ends on a Sunday, so a line paid in week W proves a sync through W + 6). A lower bound,
// never a guess: null when the technician has no ledger line, and the board then shows no date.
async function readCommissionRecordedThrough(conn, technicianId) {
  const row = await conn('payroll_pay_lines')
    .where({ technician_id: technicianId, kind: 'commission', source_type: COMMISSION_SOURCE_TYPE })
    .whereIn('status', ['open', 'paid'])
    .select(conn.raw("to_char(MAX(earned_week_start), 'YYYY-MM-DD') AS week"))
    .first();
  return row && row.week ? { weekEnd: addStaffWorkDays(row.week, 6) } : null;
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
    commissionRecordedThrough: await readCommissionRecordedThrough(conn, technicianId),
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

module.exports = {
  ScoreboardError, getScoreboard, listTechnicians, composeScoreboard, pickSeason, reviewRateBps, earnedGrossCents, checkComponents,
  ordinaryPremium,
};

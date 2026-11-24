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
const { HIRE_DATE_SQL, stayBonusStatus, seasonBonusPaidCents } = require('./tech-rewards-pay-lines');
const { PAYOUT_ELIGIBLE_SOURCES } = require('./review-incentives');
const { SOURCE_TYPE: COMMISSION_SOURCE_TYPE } = require('./payroll-commission');
const { SOURCE_TYPE: REVIEW_BONUS_SOURCE_TYPE } = require('./payroll-review-bonuses');
const { etDateString } = require('../utils/datetime-et');
const { STAFF_TIME_ZONE, addStaffWorkDays, staffWeekStartForWorkDate } = require('../utils/staff-time-work-date');

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
  const season = closedSeason(month >= 3 ? year : year - 1);
  const running = today >= season.start && today <= season.end;
  // asOf: the calculator takes the season year from this date
  return running ? { ...season, status: 'running', asOf: today } : season;
}

/**
 * A season that is over, read as of its last day: what the pay line asks (tech-rewards-pay-lines.js priceSeason), and what
 * pickSeason gives the board once the season has ended. Pure.
 */
function closedSeason(year) {
  const { start, end } = calc.seasonWindow(year);
  return { year, start, end, status: 'final', asOf: end, payDate: calc.seasonBonusPayDate(year) };
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

// paidCents: what payroll has paid for the season (tech-rewards-pay-lines.js seasonBonusPaidCents), or null. A paid bonus is
// shown as paid, with no estimate beside it: the paid line never changes, and the figures behind an estimate can.
function seasonBonusBlock(score, multiplier, grossCents, paidCents = null) {
  if (paidCents != null) return { grossCents, estimate: false, estimateCents: null, paidCents };
  const base = { grossCents, estimate: true };
  if (score.unavailable) return { ...base, estimateCents: null, reason: score.unavailable };
  if (!score.complete) return { ...base, estimateCents: null, reason: 'score_incomplete' };
  if (multiplier.multiplierE4 == null) return { ...base, estimateCents: null, reason: multiplier.reason };
  const estimateCents = calc.seasonBonusCents({
    score: score.value, grossCentsMarToAug: grossCents, multiplierE4: multiplier.multiplierE4, cutLines: score.band.cutLines,
  });
  return { ...base, estimateCents, rateBps: score.band.rateBps, multiplierE4: multiplier.multiplierE4 };
}

// The 12 months a stay bonus due on `dueDate` is worked out from: the same day a year before, to the day before the due date.
// The board's estimate and the pay line (tech-rewards-pay-lines.js) both take the period from here.
const stayWindow = (dueDate) => ({ earningsStart: yearBefore(dueDate), earningsEnd: addStaffWorkDays(dueDate, -1) });

// The stay bonus the board shows: the first milestone that no pay run has settled and that is still ahead, or that payroll
// can pay from today (the anniversary day is the first day a pay run can carry it, so that day is payroll's to answer, not
// "ahead"). Both lists are payroll's own answers, as years of service in text (tech-rewards-pay-lines.js stayBonusStatus):
//   settledKeys  the milestones a pay run has settled. Payroll never pays one again, so after a hire date correction that
//                moves a paid anniversary ahead of today the board shows the next milestone, not that one.
//   payableKeys  the milestones a pay run dated today could still write for this technician: from the anniversary to 60 days
//                after it, for a technician who gets Tech Rewards lines today. The bonus is not on a check the day after the
//                anniversary (the run of a later week writes it), so the board keeps it, with its 12 months ended, until its
//                line is paid or the 60 days are over. A milestone ahead is shown to everyone, as before: who gets it is
//                asked on the day its pay run is built.
function stayBonusBlock(hireDate, today, priorPayCents, { settledKeys = [], payableKeys = [] } = {}) {
  if (!hireDate || hireDate > today) return null;
  const next = calc.stayBonusSchedule(hireDate).find(({ years, dueDate }) => !settledKeys.includes(String(years))
    && (dueDate > today || payableKeys.includes(String(years))));
  if (!next) return null;
  const { years, rateBps, dueDate } = next;
  // the 12 months of pay end the day before the anniversary: that is the day the estimate is final
  const { earningsStart, earningsEnd } = stayWindow(dueDate);
  const base = { dueDate, years, rateBps, estimate: true, earningsStart, earningsEnd };
  // the 12 months that earn this bonus have not begun: no amount to show yet (never $0.00), only the date
  if (earningsStart > today) return { ...base, estimateCents: null };
  // the estimate is the pay recorded so far in the 12 months before the due date; the due date's own pay run decides
  return { ...base, estimateCents: calc.stayBonus({ hireDate, asOf: dueDate, priorTwelveMonthsPayCents: priorPayCents }).cents };
}

/**
 * A season's bonus from figures that are already read (readSeasonFigures): { rateBps, score, multiplier, seasonBonus }. Pure.
 * The board (composeScoreboard) and the pay line (tech-rewards-pay-lines.js priceSeason) both take it from here, so the line
 * payroll writes is the figure the board shows for the closed season.
 */
function seasonBonusOf(hireDate, season, figures) {
  const rateBps = reviewRateBps(figures.reviews, figures.asks);
  const score = scoreBlock(figures.seasonScore, figures.settings);
  const multiplier = multiplierBlock(hireDate, season, rateBps);
  return { rateBps, score, multiplier, seasonBonus: seasonBonusBlock(score, multiplier, figures.grossSeasonCents, figures.seasonBonusPaidCents) };
}

/**
 * The scoreboard from the already-read inputs. Pure: no database, no clock.
 * inputs: { technician: { id, name, hireDate }, today, season, seasonScore, settings, reviews, asks,
 *           grossSeasonCents, seasonBonusPaidCents, priorYearGrossCents, stay: { settledKeys, payableKeys },
 *           commission: { paidCents, unpaidCents }, commissionRecordedThrough: { weekEnd } | null }
 */
function composeScoreboard(inputs) {
  const { technician, today, season } = inputs;
  const { rateBps, score, multiplier, seasonBonus } = seasonBonusOf(technician.hireDate, season, inputs);
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
    seasonBonus,
    stayBonus: stayBonusBlock(technician.hireDate, today, inputs.priorYearGrossCents, inputs.stay),
  };
}

// ---------------------------------------------------------------------------
// Reads (all on the one snapshot connection)

// The hire date is read as payroll reads it (tech-rewards-pay-lines.js HIRE_DATE_SQL): one on file that the calendar code
// cannot read (a date BC, a year past 9999) is none here too, so the board never estimates a bonus payroll will not write.
async function readTechnician(conn, technicianId) {
  const row = await conn('technicians').where({ id: technicianId })
    .first('id', 'name', conn.raw(`${HIRE_DATE_SQL} AS hire_date`));
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
 *   paid time off (pto_pay_cents)          the dated PTO records of the week,           payroll_time_off (kind pto); for a
 *                                           weighted by minutes; for a check with a     check with a time-off bank,
 *                                           time-off bank, the minutes the bank PAID    calc_snapshot.ptoBank.paidDays
 *                                           on each date (it can pay one day of the
 *                                           week and not the next). The hours a check
 *                                           paid out at leaving (ptoBank.payoutMinutes)
 *                                           were taken on no day: their pay is in
 *                                           "anything else" below
 *   holiday pay (holiday_pay_cents)        the dated holiday records of the week,       payroll_time_off (kind holiday)
 *                                           weighted by minutes
 *   holiday work premium                   the holidays worked, weighted by the paid     calc_snapshot.holidayWorkDays (frozen
 *   (holiday_work_premium_cents)            minutes worked ON each (the part of a shift   with the check; payroll-holiday-work.js)
 *                                           inside the holiday's Eastern day)
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
 *   production share                       earned evenly over the SHIFT DAYS of its pay     payroll_checks.production_share_cents;
 *   (production_share_cents)               week (the work dates of the stops the share      calc_snapshot.productionShare.stops
 *                                           was worked out from: one equal part for each     (frozen with the check)
 *                                           day the technician ran a route). A bar and a
 *                                           rate sit on the whole week, so no one stop
 *                                           earned a part of it; the shift days are the
 *                                           days the work was done. No stop rows (a check
 *                                           from before the snapshot): its whole week, in-
 *                                           window days / 7. The overtime it causes is in
 *                                           the line overtime row below, dated by week
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
    // The extra half of the hours worked on a holiday is earned on the holidays worked, by the paid minutes worked on each.
    { cents: check.holidayWorkPremiumCents || 0, spread: timeOff(check.holidayWorkDays) },
    ...(check.lines || []).flatMap(lineComponents),
    // The production share is earned over the shift days of its week; with no day rows it falls on the week (see the table above).
    { cents: check.productionShareCents || 0, week: check.weekStart, spread: (check.productionShareDays || []).map((date) => ({ date, weight: 1 })) },
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
 * straddles an edge counts its in-window share. The D5-5 pay lines use this helper for the season bonus base and the stay
 * bonus's prior 12 months (both through readBonusPay, which also fixes which checks count), so the board and the pay line
 * can never differ.
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
 * coversFrom, coversTo }; `storedWeeks`: the snapshot's week rows [{ weekStart, workedMinutes, overtimeMinutes, premiumCents,
 * ordinaryPremiumCents, earlierAllocatedCents, earlierPremiumCents }].
 * Returns { weeks: [{ weekStart, premiumCents }], excludedCents, unsplitWeeks }. Pure.
 * ONE RULE: the ordinary part is what the check would have paid WITHOUT its Tech Rewards lines. So a Tech Rewards line on a
 * check never moves the base, up or down.
 * - A check with no Tech Rewards line keeps its stored premium.
 * - A week no Tech Rewards line of the check covers keeps its stored premium too (those lines did nothing there), a make-up
 *   for an older check's shortfall included.
 * - A week one covers: the figure the pay run stored for that week when it priced the check (ordinaryPremiumCents,
 *   payroll-pay-lines.js priceCheckLines: the check's other lines priced by the pay run's own rule, from the hours and the
 *   earlier checks that pricing read). The rest is the Tech Rewards lines' part. Never over what the check stored for the
 *   week.
 * The split is taken from the CHECK'S OWN ROWS only. What earlier checks had paid for a week when the check was priced is
 * not readable from today's rows, whatever order they are put in (a check with an earlier pay date can be finalized later,
 * across a tax year), so it is never rebuilt from other checks. A row with no stored figure (a check priced before the pay
 * run stored one) is read by what the row itself proves:
 * - Nothing to split: the week paid no premium, or no ordinary line of the check covers it (without its Tech Rewards lines
 *   the check would have paid nothing for that week, whatever it made up). The ordinary part is exactly nothing.
 * - The row shows no earlier pay (no earlierAllocatedCents, no earlierPremiumCents: the pay run writes them whenever a
 *   finalized check had paid line pay or premium for the week, and before it wrote them it priced every check from its own
 *   lines alone). The check priced its lines for the week alone, so its ordinary lines priced alone, from the hours the row
 *   holds, are exact.
 * - The row shows earlier pay. The ordinary part then depends on the exact earlier pay, and the row holds it rounded: the
 *   split is not proven. None of the week's premium counts, and the week is named in unsplitWeeks: a pay line that would be
 *   worked out from it waits for review (tech-rewards-pay-lines.js base_needs_review) and is never paid from a guess.
 */
function ordinaryPremium(lines, storedWeeks) {
  const techKinds = new Set(TECH_REWARD_KINDS);
  const spanOf = (line) => ({ amountCents: line.cents, weekStart: line.weekStart, coversFrom: line.coversFrom || null, coversTo: line.coversTo || null });
  const rewardWeeks = new Set(lines.filter((line) => techKinds.has(line.kind)).flatMap((line) => weeksOfLine(spanOf(line))));
  // a check with no Tech Rewards line keeps every week as it stored it: none of its lines is read any further
  if (!rewardWeeks.size) return { weeks: storedWeeks.map((w) => ({ weekStart: w.weekStart, premiumCents: w.premiumCents })), excludedCents: 0, unsplitWeeks: [] };
  const noFigure = (w) => rewardWeeks.has(w.weekStart) && w.ordinaryPremiumCents == null;
  // the check's other lines and the weeks they cover: read only for a row with no stored figure
  const ordinaryLines = storedWeeks.some(noFigure) ? lines.filter((line) => !techKinds.has(line.kind) && line.cents > 0).map(spanOf) : [];
  const ordinaryWeeks = new Set(ordinaryLines.flatMap((line) => weeksOfLine(line)));
  const nothingToSplit = (w) => w.premiumCents === 0 || !ordinaryWeeks.has(w.weekStart);
  const paidBefore = (w) => w.earlierAllocatedCents != null || w.earlierPremiumCents != null;
  // the rows with no stored figure that show no earlier pay: the check's ordinary lines, priced alone from the row's hours
  const alone = storedWeeks.filter((w) => noFigure(w) && !nothingToSplit(w) && !paidBefore(w));
  const pricedAlone = new Map((alone.length ? lineOvertimePremium({
    weeks: alone.map((w) => ({
      weekStart: w.weekStart,
      regularMinutes: (Number(w.workedMinutes || 0) - Number(w.overtimeMinutes || 0)).toFixed(2),
      overtimeMinutes: Number(w.overtimeMinutes || 0).toFixed(2),
    })),
    lines: ordinaryLines,
  }).weeks : []).map((w) => [w.weekStart, w.premiumCents]));
  const weeks = [];
  const unsplitWeeks = [];
  let excludedCents = 0;
  for (const w of storedWeeks) {
    const covered = rewardWeeks.has(w.weekStart);
    let ordinary = w.premiumCents;
    if (covered && !noFigure(w)) ordinary = Math.max(0, toCents(w.ordinaryPremiumCents));
    else if (covered && nothingToSplit(w)) ordinary = 0;
    else if (covered && !paidBefore(w)) ordinary = pricedAlone.get(w.weekStart) || 0;
    else if (covered) {
      ordinary = 0;
      unsplitWeeks.push(w.weekStart);
    }
    ordinary = Math.min(w.premiumCents, ordinary);
    excludedCents += w.premiumCents - ordinary;
    if (!covered || ordinary > 0) weeks.push({ weekStart: w.weekStart, premiumCents: ordinary });
  }
  return { weeks, excludedCents, unsplitWeeks };
}

// The part of a check's PTO pay that is a time-off bank payout at leaving (payroll-time-off-bank.js: those hours are
// in pto_minutes at the same rate). No day earned it, so it is not dated by the week's time-off days: taken out of
// ptoPayCents, it falls in the check's undated remainder (checkComponents).
function ptoPayoutCents(row) {
  const paidOut = hundredths(row.pto_payout_minutes);
  const all = hundredths(row.pto_minutes);
  return paidOut > 0 && all > 0 ? signedMulDivRound(toCents(row.pto_pay_cents), Math.min(paidOut, all), all) : 0;
}

/**
 * The technician's finalized checks that can hold pay earned in [from, to] (every check whose pay week ends on or
 * after `from`: a catch-up line or premium can be paid long after it was earned), with their dated parts, then
 * earnedGrossCents. Day records are read only for a week that straddles a window edge.
 * `throughWeek` (a Monday) leaves out every check for a later pay week (readBonusPay).
 * Returns { cents, checkIds, unsplitWeeks }: the figure, and the ids, sorted, of the checks that put pay into it. Each check
 * is read from its own rows only (its columns, its paid lines, its stored week rows, its week's day records), so the figure
 * is a plain sum over the checks and the order they are read in changes nothing. A check that adds nothing (one of an edge
 * week whose paid days all fall outside `from`..`to`) is not in checkIds: the figure is the same with and without it.
 * unsplitWeeks: the weeks with a day in `from`..`to` whose line overtime on an older check has no proven split
 * (ordinaryPremium), oldest first. None of that overtime is in the figure, so a figure with one is an estimate, not a base
 * to pay from.
 */
async function readGrossAndChecks(conn, technicianId, from, to, { throughWeek = null } = {}) {
  const query = conn('payroll_checks as c')
    .join('payroll_runs as r', 'r.id', 'c.run_id')
    .where({ 'c.technician_id': technicianId, 'c.status': 'finalized', 'r.status': 'finalized' })
    // A week before the window can still hold pay earned inside it: the holiday work premium is paid with the shift's own
    // week and dated by the holiday it overlapped, which can be days after that week (payroll-holiday-work.js). The check
    // names those dates itself (calc_snapshot.holidayWorkDays, frozen with it), so one that names a date on or after the
    // window's start is read, however far back its week is; no fixed look-back.
    .whereRaw(`(c.week_start + 6 >= ?::date OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.calc_snapshot->'holidayWorkDays') = 'array'
        THEN c.calc_snapshot->'holidayWorkDays' ELSE '[]'::jsonb END) AS d WHERE (d->>'workDate')::date >= ?::date))`, [from, from]);
  if (throughWeek) query.whereRaw('c.week_start <= ?::date', [throughWeek]);
  const rows = await query
    .select('c.id', conn.raw("to_char(c.week_start, 'YYYY-MM-DD') AS week_start"), 'c.gross_cents', 'c.regular_pay_cents',
      'c.overtime_pay_cents', 'c.overtime_minutes', 'c.pto_pay_cents', 'c.holiday_pay_cents', 'c.holiday_work_premium_cents', 'c.tech_rewards_cents',
      'c.production_share_cents', conn.raw("c.calc_snapshot->'productionShare'->'stops' AS production_share_stops"),
      conn.raw("c.calc_snapshot->'holidayWorkDays' AS holiday_work_days"),
      conn.raw("COALESCE((c.calc_snapshot->'lineOvertimeWeeks')::jsonb, '[]'::jsonb) AS line_overtime_weeks"),
      conn.raw("c.calc_snapshot->'ptoBank'->'paidDays' AS pto_paid_days"),
      'c.pto_minutes', conn.raw("c.calc_snapshot->'ptoBank'->'payoutMinutes' AS pto_payout_minutes"));
  if (!rows.length) return { cents: 0, checkIds: [], unsplitWeeks: [] };
  const lineRows = await conn('payroll_pay_lines as l')
    .whereIn('l.check_id', rows.map((row) => row.id))
    .where('l.status', 'paid')
    .select('l.check_id', 'l.kind', 'l.amount_cents', conn.raw("to_char(l.earned_week_start, 'YYYY-MM-DD') AS week_start"),
      conn.raw("to_char(l.covers_from, 'YYYY-MM-DD') AS covers_from"), conn.raw("to_char(l.covers_to, 'YYYY-MM-DD') AS covers_to"),
      conn.raw(`to_char(${LINE_DAY_SQL}, 'YYYY-MM-DD') AS earned_on`, lineEarnedOnBindings()));
  let cents = 0;
  const checkIds = [];
  const unsplit = new Set();
  for (const row of rows) {
    const ownLines = lineRows.filter((line) => line.check_id === row.id);
    const paidLines = ownLines.map((line) => ({ kind: line.kind, cents: toCents(line.amount_cents), weekStart: line.week_start, coversFrom: line.covers_from, coversTo: line.covers_to }));
    const storedWeeks = (Array.isArray(row.line_overtime_weeks) ? row.line_overtime_weeks : [])
      .map((w) => ({ ...w, premiumCents: toCents(w.premiumCents) }));
    const premium = ordinaryPremium(paidLines, storedWeeks);
    for (const week of premium.unsplitWeeks) if (addStaffWorkDays(week, 6) >= from && week <= to) unsplit.add(week);
    const check = {
      weekStart: row.week_start,
      grossCents: toCents(row.gross_cents),
      regularPayCents: toCents(row.regular_pay_cents),
      overtimePayCents: toCents(row.overtime_pay_cents),
      overtimeMinutes: Number(row.overtime_minutes) || 0,
      ptoPayCents: toCents(row.pto_pay_cents) - ptoPayoutCents(row),
      holidayPayCents: toCents(row.holiday_pay_cents),
      holidayWorkPremiumCents: toCents(row.holiday_work_premium_cents),
      holidayWorkDays: (Array.isArray(row.holiday_work_days) ? row.holiday_work_days : [])
        .map((d) => ({ workDate: d.workDate, minutes: Number(d.minutes) || 0 })),
      techRewardsCents: toCents(row.tech_rewards_cents),
      productionShareCents: toCents(row.production_share_cents),
      productionShareDays: [...new Set((Array.isArray(row.production_share_stops) ? row.production_share_stops : [])
        .map((stop) => stop && stop.workDate).filter(Boolean))].sort(),
      lines: ownLines.filter((line) => GROSS_LINE_KINDS.includes(line.kind))
        .map((line) => ({ cents: toCents(line.amount_cents), earnedOn: line.earned_on, weekStart: line.week_start, coversFrom: line.covers_from, coversTo: line.covers_to })),
      lineOvertimeWeeks: premium.weeks,
      techRewardsPremiumCents: premium.excludedCents,
    };
    const weekEnd = addStaffWorkDays(check.weekStart, 6);
    if (weekEnd >= from && check.weekStart <= to && (check.weekStart < from || weekEnd > to)) {
      check.dayMinutes = await readDayMinutes(conn, technicianId, check.weekStart);
      Object.assign(check, await readTimeOffRecords(conn, technicianId, check.weekStart));
      // A time-off bank pays the booked days in date order and can leave a later day unpaid (payroll-time-off-bank.js
      // settleWeek). The check stored what it paid on each date: its PTO pay was earned on those days, not on every booked one.
      if (Array.isArray(row.pto_paid_days)) {
        check.ptoRecords = row.pto_paid_days.map((day) => ({ workDate: day.workDate, minutes: Number(day.minutes) || 0 }));
      }
    }
    const earned = earnedGrossCents([check], from, to);
    cents += earned;
    if (earned !== 0) checkIds.push(row.id);
  }
  return { cents, checkIds: checkIds.sort(), unsplitWeeks: [...unsplit].sort() };
}

/**
 * The pay a bonus is worked out from, and the checks that hold it: { cents, checkIds, unsplitWeeks } (readGrossAndChecks;
 * with an unsplit week the pay line waits and the board shows the figure as its estimate). One read for both bonuses: the
 * 12 months of a stay bonus (stayWindow) and a season (its start to the board's as-of date: today while it runs, its last
 * day after). It is the pay earned from `from` to `to`, dated by the day it was earned (earnedGrossCents), on the finalized
 * checks for the pay weeks up to `throughWeek`: THE PAY WEEKS BEFORE THE FIRST ONE WHOSE RUN CAN CARRY THE BONUS.
 *   a stay bonus    the week `to` falls in, the last week of its 12 months (the default): the run of the next week can carry it
 *   a season bonus  seasonLastPayWeek: no run dated before the last Friday of September carries it
 * A check for a later pay week never counts, whatever it pays (a commission recorded late, the overtime a later commission
 * adds to an old week). The cut is fixed on purpose. A commission line reaches back to the week its sale was accepted and
 * keeps coming for 12 months (payroll-commission.js), so the overtime it adds to old weeks never stops arriving: a base that
 * waited for it would never be complete, and one that took whatever was paid so far would depend on the day the bonus was
 * worked out. With the cut the figure is the same on every pay run that works it out, and the board and the pay line
 * (tech-rewards-pay-lines.js) take it from here, so they never differ.
 */
const readBonusPay = (conn, technicianId, from, to, throughWeek = staffWeekStartForWorkDate(to)) => readGrossAndChecks(conn, technicianId, from, to, { throughWeek });

/**
 * The last pay week (a Monday) whose check can put pay into a season's bonus base: the week before the one that a pay run
 * dated the season's pay date pays. A run is dated the Friday after its week ends (payroll-runs.js defaultPayDate), so the run
 * dated the last Friday of September pays the week before that Friday's week, and the base ends one week earlier: for 2027,
 * pay date Sep 24, that run's week Sep 13, base through the week of Sep 6. So pay earned in the season that one of the first
 * September paychecks pays (August's monthly allowance, a review bonus brought in late) counts, and a paycheck for a later
 * week never does. Pure.
 */
const seasonLastPayWeek = (year) => addStaffWorkDays(staffWeekStartForWorkDate(calc.seasonBonusPayDate(year)), -14);

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

/**
 * The score figures of a season, read as of `season.asOf` on one connection: the score and its settings, the review asks and
 * the credited reviews. No pay.
 */
async function readSeasonScoreFigures(conn, technicianId, season) {
  const { seasonScore, settings } = await readScore(conn, technicianId, season);
  const asks = await readAskCount(conn, technicianId, season);
  const reviews = await readReviewCount(conn, technicianId, season);
  return { seasonScore, settings, asks, reviews };
}

/** The pay a season's bonus is worked out from, with the checks that hold it (readBonusPay, cut at seasonLastPayWeek). */
const readSeasonPay = (conn, technicianId, season) => readBonusPay(conn, technicianId, season.start, season.asOf, seasonLastPayWeek(season.year));

/**
 * Every figure a season's bonus is worked out from, on one connection: the score figures and the pay (seasonPay).
 * seasonBonusOf turns them into the bonus. The board reads them here, inside its own snapshot (getScoreboard). The pay line
 * reads the same two parts for a closed season (closedSeason): readSeasonScoreFigures in a snapshot taken before the pay
 * run's transaction opens (tech-rewards-pay-lines.js readSeasonScores), and readSeasonPay in that transaction.
 */
async function readSeasonFigures(conn, technicianId, season) {
  const scored = await readSeasonScoreFigures(conn, technicianId, season);
  const seasonPay = await readSeasonPay(conn, technicianId, season);
  return { ...scored, grossSeasonCents: seasonPay.cents, seasonPay };
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
  const figures = await readSeasonFigures(conn, technicianId, season);
  // the stay bonus the board shows (stayBonusBlock) is worked out from the 12 months before ITS anniversary, up to the day
  // before it or today, whichever comes first: the pay recorded so far in that window
  const stay = technician.hireDate ? await stayBonusStatus(conn, technicianId, technician.hireDate, today) : undefined;
  const due = stayBonusBlock(technician.hireDate, today, 0, stay);
  const stayEnd = due ? (due.dueDate <= today ? dayBefore(due.dueDate) : today) : null;
  return {
    technician, today, season, ...figures,
    // a closed season payroll has paid shows the paid amount (seasonBonusBlock)
    seasonBonusPaidCents: season.status === 'final' ? await seasonBonusPaidCents(conn, technicianId, season.year) : null,
    priorYearGrossCents: due && due.estimateCents !== null ? (await readBonusPay(conn, technicianId, due.earningsStart, stayEnd)).cents : 0,
    stay,
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

/**
 * The technicians of the admin preview picker: id and name only. The active ones, and anyone no longer active who has a
 * finalized paycheck of a finalized pay run, so the owner can still open a former technician's yearly pay statement
 * (tech-rewards-year-statement.js). Only such a one carries `active: false`; an active technician keeps exactly id and name.
 */
async function listTechnicians(conn = db) {
  const rows = await conn('technicians as t')
    .where('t.active', true)
    .orWhereExists(function hasFinalCheck() {
      this.select(conn.raw('1')).from('payroll_checks as c').join('payroll_runs as r', 'r.id', 'c.run_id')
        .whereRaw('c.technician_id = t.id').where({ 'c.status': 'finalized', 'r.status': 'finalized' });
    })
    .orderBy([{ column: 't.name' }, { column: 't.id' }])
    .select('t.id', 't.name', 't.active');
  return rows.map((row) => ({ id: row.id, name: row.name, ...(row.active ? {} : { active: false }) }));
}

module.exports = {
  ScoreboardError, getScoreboard, listTechnicians, composeScoreboard, pickSeason, reviewRateBps, earnedGrossCents, checkComponents,
  ordinaryPremium, stayWindow, readBonusPay, closedSeason, seasonLastPayWeek, seasonBonusOf, readSeasonFigures, readSeasonScoreFigures,
  readSeasonPay,
};

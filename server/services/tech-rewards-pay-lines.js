/**
 * Tech Rewards pay lines (Plan D5-5, owner rulings 2026-11-20): the pay run writes the December gift, the stay bonus and the
 * season bonus as open payroll pay lines (payroll-pay-lines.js). Each kind is dark behind its own gate, and all need
 * GATE_PAYROLL_PAY_LINES: GATE_TECH_REWARDS_PAY_LINES for the gift, GATE_TECH_REWARDS_STAY_BONUS for the stay bonus,
 * GATE_TECH_REWARDS_SEASON_BONUS for the season bonus (KIND_GATES). The text below describes the gift; THE STAY BONUS and THE
 * SEASON BONUS, at the end, say what differs. Nothing here invents a rule; each one lives in one place:
 *
 *   who is a technician                         recipients() here: W-2, the technician role, and technician-eligibility.js
 *                                               applyAssignable (active, field dispatchable). An admin account gets none.
 *   the stay bonus milestones, rates and math   tech-rewards-calc.js stayBonusSchedule, stayBonus
 *   the 12 months of a stay bonus, and the pay  tech-rewards-scoreboard.js stayWindow, readBonusPay (the board's own figures,
 *   a stay bonus is worked out from             so the board and the pay line never differ)
 *   the season, its pay date and the bonus math tech-rewards-calc.js seasonWindow, seasonBonusPayDate, seasonBonusCents
 *   the score, review rate, multiplier and pay  tech-rewards-scoreboard.js readSeasonScoreFigures, readSeasonPay,
 *   a season bonus is worked out from           seasonBonusOf (the board's own figures and its own arithmetic)
 *   which weeks hold recorded work              payroll-runs.js workedWeeks (the test the pay run itself uses)
 *   which covered week would hold a pay run     payroll-runs.js lineGuardWeek (the two guards a run applies to every pay line)
 *   whether a check can be worked out at all    payroll-runs.js lineOnlyCheckProblem (buildCheck, the pay run's own builder)
 *   whether a later check is already final      payroll-runs.js laterFinalCheckExists (the guard finalize applies to a run)
 *   pay lines, open -> paid on finalize         payroll-pay-lines.js; overtime on a line = payroll-regular-rate.js
 *
 * syncTechRewardLines runs where syncCommissionLines does (payroll-runs.js: draft, recompute and finalize, under the payroll
 * lock), after a due pay rate step is applied and before the run is worked out. The lines are derived data.
 *
 * WHICH RUN. By the run's PAY DATE (the date on its checks). The gift is due the last Friday on or before Dec 20, from the
 * 2026 gift on (FIRST_GIFT_YEAR: the plan was approved in November 2026, so no run writes a gift for 2025). The FIRST run
 * dated on or after that day, up to 60 days after it, that is ready for a technician writes their line; a run that is not ready
 * writes nothing for them and the next run tries again. The line is $300 (owner 2026-11-20), source_type 'tech_rewards', source
 * key 'december_gift:<technician id>:<year>' (the table's unique key stops a repeat in any status).
 *
 * WHAT IT COVERS. One period for each technician and year, the same whichever run pays it (spanOf): Jan 1 of the year (the
 * hire date, for a technician hired during the year) to the end of the GIFT WEEK, the pay week whose check is dated the gift
 * date (Sun Dec 13, 2026 for the gift of Fri Dec 18). The gift is for the work done up to the check that carries it; a week
 * after that cannot have earned it. payroll_pay_lines refuses a line that covers days after the week that pays it, so a run
 * carries the gift only when its pay week is the last covered week or a later one: a run for an earlier week (an old week paid
 * late, dated on or after the gift date) WAITS, and never shortens the period to fit. The period is spread over its workweeks
 * by payroll-regular-rate.js (29 CFR 778.209), so the gift adds overtime premium to the weeks it covers. It is included in
 * the regular rate on purpose, the conservative reading: whether the 29 CFR 778.212 gift exclusion applies is a question for
 * the employment lawyer / CPA, not decided here.
 *
 * WHICH DRAFT. An OPEN Tech Rewards line sits in ONE pay week, and only that week's run pays it (payroll-pay-lines.js
 * openLinesFor). There is no order between two draft runs: a sync that is dated for the line and ready for the technician takes
 * it, from whatever week it was in. Finalize syncs first, so the first ready run to be finalized pays the gift. The other draft
 * still shows it, and its own finalize sends the changed numbers back for review (the pay run's token check, as for any pay
 * line two drafts share). A run that is not ready leaves the line where it is. Two calls keep a line from being left behind:
 *   - voiding a run deletes its lines, open or reopened from paid (payroll-runs.js voidRun, dropRewardLinesOfWeek);
 *   - finalizing a run deletes any of its lines it did not pay (finalizeRun, the same call).
 * A recompute works an OPEN line out again; a PAID line is never read or changed. A kind's gate off: every open line of that
 * kind comes off at the next sync (the kill switch) and paid lines stay. Pay lines off: no pay line is read or written. With
 * pay lines off, or every kind's gate off, the run keeps no stored wait (clearWaits).
 *
 * READINESS. A sync NEVER blocks a check or holds a run. A technician who cannot get the gift at all is skipped with a reason
 * in the audit event and no note: hired after the gift date. A technician with no hire date on file WAITS until it is entered
 * (no money on a guess), and so does one whose hire date on file is not a calendar date (readTech, hire_date_invalid: the
 * rest of the run goes on), and so does one who has a December gift line this sync did not write (a row added by hand in the
 * database: the automatic gift is never paid beside it), and so does every technician on a run whose pay week is before the
 * last week the gift covers (priceCandidate). A technician who can get it but not on
 * this run WAITS (waitOf): a later check of theirs in the tax year is already final, so
 * finalize would refuse a run that holds a check of theirs (laterFinalCheckExists); or an earlier week of the year holds work (a
 * weekly timesheet with minutes, recorded work by workedWeeks, or paid time off) and has no FINALIZED check; or the pay run's own
 * line guards would hold a check for the span or for the run's own week (lineGuardWeek: a worked week with no approved
 * timesheet, an automatic clock-out nobody reviewed); or no check can be worked out for them on this run at all
 * (lineOnlyCheckProblem: no pay rate, a rate under the minimum wage). The technician rows are read FOR SHARE under the pay run's lock, so a change to a technician's status,
 * field work or hire date waits for the pay run's transaction and a finalize never pays a gift that change took away.
 * No line is written, the run row keeps what waits (payroll_runs.tech_rewards_waits, replaced by every sync), the run view lists
 * it (techRewardsNotes, waitNotes: with the reason on a draft, without it on a finalized run) until the gift is paid, and the
 * next run that is ready writes it.
 *
 * Every sync that examined a gift (a run dated for one, or one that holds an open line) writes one audit event
 * (payroll.tech_rewards_lines_synced), also when it changed nothing: technician ids, kinds, reason codes, weeks, line ids and
 * the count of lines left as they were, never an amount. Money is integer cents.
 *
 * THE STAY BONUS (owner 2026-11-20, plan D2): 2% of the pay of the 12 months before the 1 year hire anniversary, 4% at 3
 * years, 8% at 5 years, each once. It runs through the same sync, with the same recipients, ownership, drafts, waits, notes,
 * void and finalize rules, and the same 60 days. What differs:
 *   - WHICH RUN. Due from the anniversary (stayDueInRun, by the hire date on file; none on file, none due, and no note; one
 *     on file that is not a calendar date, no anniversary is known, so every run notes it until it is corrected). No
 *     anniversary before FIRST_STAY_DATE has one. The key is the YEARS OF SERVICE ('stay_bonus:<technician id>:1'), not the
 *     date: a hire date corrected while the line is open moves the line, and one corrected after it is paid never pays the
 *     milestone again.
 *   - WHAT IT COVERS. The 12 months (staySpanOf), spread over their workweeks like every line that has a span, so it adds
 *     overtime premium to the weeks it covers.
 *   - THE AMOUNT is the rate times the pay earned in the 12 months on the FINALIZED checks of those pay weeks, as the board
 *     reads it (readBonusPay). A check for a later pay week never counts. So it is written only when those checks are all
 *     final (priceStay): by a run for a week AFTER the last week of the 12 months, when every week of them that holds work
 *     has a finalized check. From then on every run works out the same amount. The line's note says the rate, the base and
 *     the period. An open line is worked out again at every sync; finalize pays what its own sync worked out, and a PAID
 *     line never changes.
 *   - A PAID stay bonus holds the pay runs it counted. The sync keeps the checks the amount was worked out from on the line
 *     (counted_check_ids), and a run that holds one of them cannot be voided before the run that paid the bonus
 *     (paidBonusCounting, in payroll-runs.js voidRun). A check of one of those pay weeks that is finalized AFTER the bonus
 *     was paid (an old week paid late) does not change the paid bonus: the office corrects that by voiding the run that paid
 *     it, which works it out again.
 *   - ONE GATE EACH. A kind's gate off takes that kind's open lines off and leaves the other kinds'.
 *
 * THE SEASON BONUS (owner 2026-11-20, plan D1): the band rate of the season score (4%, 2.5%, 1%, or none under the lowest cut
 * line) times the pay earned Mar 1 - Aug 31 times the season multiplier, paid the last Friday of September. It runs through
 * the same sync, with the same recipients, ownership, drafts, waits, notes, void and finalize rules, and the same 60 days. What
 * differs:
 *   - WHICH RUN. Due from the last Friday of September of the season's year (seasonDueInRun), for every technician, as the
 *     gift is due by its date. No season before FIRST_SEASON_YEAR has one. The key is the season's year
 *     ('season_bonus:<technician id>:2027'), and a key for an earlier year is not the sync's own (payroll-pay-lines.js
 *     TECH_REWARDS_KEYS): such a row is a hand-made line, never moved or removed here.
 *   - WHO. A technician hired after the season ended gets none (skipped, no note). One with no hire date on file, or one that
 *     is not a calendar date, waits: the multiplier counts years of service, and no money goes out on a guess.
 *   - WHAT IT COVERS. The season, from the hire date for a technician hired during it (seasonSpanOf), spread over its
 *     workweeks like every line that has a span.
 *   - THE AMOUNT is worked out by the board's own code from the board's own reads (readSeasonScores and priceSeason:
 *     readSeasonScoreFigures, readSeasonPay, seasonBonusOf), as of the season's last day: the score and its settings, the
 *     review rate, the multiplier (the level part is the entry level until the career ladder has a source, as on the board;
 *     these are read in one snapshot, as the board reads them, BEFORE the pay run's transaction opens, and read again
 *     under the payroll lock: readSeasonScores, seasonScoreOf), and the pay earned in the season on the
 *     FINALIZED checks for the pay weeks before the bonus's own (tech-rewards-scoreboard.js seasonLastPayWeek: through the
 *     week before the one a run dated the last Friday of September pays; a check for a later pay week never counts, as for
 *     the stay bonus). So it is written by a run for a week AFTER that week, when every week from the season's start that
 *     holds work has a finalized check. It waits while a score part has no data (score_incomplete) or no score settings are in force for the
 *     season (score_settings_missing), when the read itself fails (score_read_failed: the error is logged and the pay
 *     run goes on), for a technician the read before the run did not cover (score_not_read: the next sync reads them),
 *     and when the score changed between that read and the payroll lock (score_changed: a finalize then pays no bonus from
 *     the old score, and the office sees the run again). A complete score under the lowest cut line earns no bonus: no line and no note
 *     (score_below_bonus_line, in the audit event), whatever else is not ready: the band is asked before every wait. The line's note says the rate, the base, the multiplier and the score. An
 *     open line is worked out again at every sync (a score part corrected since moves it); a PAID line never changes.
 *   - A PAID season bonus holds the pay runs it counted, exactly as a paid stay bonus does (counted_check_ids).
 */
const { recordAuditEvent } = require('./audit-log');
const { isDeepStrictEqual } = require('node:util');
const logger = require('./logger');
const calc = require('./tech-rewards-calc');
const { applyAssignable } = require('./technician-eligibility');
const {
  KIND_WORDS, TECH_REWARDS_SOURCE, techRewardsSourceId, techRewardsOwnKey, techRewardsOwnedSql,
} = require('./payroll-pay-lines');
const {
  payrollPayLinesLive, techRewardsPayLinesLive, techRewardsStayBonusLive, techRewardsSeasonBonusLive, payrollTimeOffLive,
} = require('../config/feature-gates');
const { addStaffWorkDays, staffWeekStartForWorkDate } = require('../utils/staff-time-work-date');

// payroll-runs.js loads this file, so its helpers are read on first use.
const payrollRuns = () => require('./payroll-runs');
const timeOffBank = require('./payroll-time-off-bank');
const holidayWork = require('./payroll-holiday-work');
// The board is the one home of the pay a stay bonus is worked out from (readBonusPay) and of its 12 months (stayWindow), and of
// every figure of a season bonus (readSeasonScoreFigures, readSeasonPay, seasonBonusOf). It pulls in the score and review modules, so it loads on
// first use: a pay run that has no stay bonus and no season bonus to look at never reads it.
const scoreboard = () => require('./tech-rewards-scoreboard');
// The score module is the home of the score settings lock (lockSettingsForRead). Loaded on first use, as the board is.
const scoreSettings = () => require('./tech-rewards-scores');

// The one home of the value is payroll-pay-lines.js, which pays these lines in their own week only (openLinesFor).
const SOURCE_TYPE = TECH_REWARDS_SOURCE;
const GIFT = 'december_gift';
const STAY = 'stay_bonus';
const SEASON = 'season_bonus';
// The December gift: $300 per technician (owner 2026-11-20), due the last Friday on or before this day of December.
// A constant, not a tech_reward_settings value: that table is versioned score weights and cut lines only.
const DECEMBER_GIFT_CENTS = 30000;
const DECEMBER_GIFT_DAY = 20;
// The first year that has a gift: the plan was approved in November 2026. A pay run for an old week, dated early in 2026,
// never writes a gift for 2025.
const FIRST_GIFT_YEAR = 2026;
const FRIDAY = 5;
// The first hire anniversary that has a stay bonus: the day the owner approved the plan. A pay run for an old week, dated before
// it, never writes a bonus for an anniversary from before the plan.
const FIRST_STAY_DATE = '2026-11-20';
// The first season that has a bonus: the plan was approved in November 2026, after the 2026 season (Mar 1 - Aug 31) was over.
const FIRST_SEASON_YEAR = 2027;
// A line is looked for in a run dated up to this many days after its due date: the first ready run writes it, and a gate turned
// on later does not reach back further.
const LOOKBACK_DAYS = 60;
const AUDIT_ACTION = 'payroll.tech_rewards_lines_synced';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The typeof guards keep a test mock of feature-gates that lacks a reader working (off).
const payLinesOn = () => typeof payrollPayLinesLive === 'function' && payrollPayLinesLive();
const techRewardsOn = () => typeof techRewardsPayLinesLive === 'function' && techRewardsPayLinesLive();
const stayBonusOn = () => typeof techRewardsStayBonusLive === 'function' && techRewardsStayBonusLive();
const seasonBonusOn = () => typeof techRewardsSeasonBonusLive === 'function' && techRewardsSeasonBonusLive();
// Each kind has its own gate, and all need GATE_PAYROLL_PAY_LINES. A gate that is off takes only its own kind's open lines off.
const KIND_GATES = { [GIFT]: techRewardsOn, [STAY]: stayBonusOn, [SEASON]: seasonBonusOn };
const kindOn = (kind) => Boolean(KIND_GATES[kind]) && KIND_GATES[kind]();
// GATE_PAYROLL_TIME_OFF, as the pay run reads it: with it off a run pays no time off, so time off needs no check.
const timeOffOn = () => typeof payrollTimeOffLive === 'function' && payrollTimeOffLive();

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (year, month, day) => `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
const yearOf = (date) => Number(date.slice(0, 4));
const dayLabel = (date) => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}, ${date.slice(0, 4)}`;
const dollars = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---- Dates (pure)

/** The last Friday on or before Dec 20 of the year (ET calendar date). */
function decemberGiftDate(year) {
  const dow = new Date(Date.UTC(year, 11, DECEMBER_GIFT_DAY)).getUTCDay();
  return addStaffWorkDays(ymd(year, 12, DECEMBER_GIFT_DAY), -((dow - FRIDAY + 7) % 7));
}

/**
 * What the gift of `key` (the year, as text) covers for a technician hired on `hireDate`, as the pay line of the run of the
 * pay week starting `weekStart`. Pure. { earnedWeekStart, coversFrom, coversTo }. The period does NOT depend on the run:
 *   from  Jan 1 of the year, or the hire date for a technician hired during the year: the gift is spread over the weeks they
 *         were employed, so weeks before they started take no share of it from the weeks they worked (29 CFR 778.209)
 *   to    the end of the gift week: the Monday-Sunday week before the week of the gift date, the one a check dated the gift
 *         date pays (payroll-runs.js defaultPayDate). For a technician hired after that week ended (and by the gift date),
 *         the end of the week they were hired in.
 * A run whose pay week is before the week of coversTo cannot carry the line (payroll_pay_lines refuses a line that covers days
 * after the week that pays it): priceCandidate makes it wait. A run of that week or a later one carries the same period.
 */
function spanOf(key, weekStart, hireDate = null) {
  const year = Number(key);
  const jan1 = ymd(year, 1, 1);
  const giftWeekEnd = addStaffWorkDays(staffWeekStartForWorkDate(decemberGiftDate(year)), -1);
  const coversFrom = hireDate && hireDate > jan1 ? hireDate : jan1;
  const coversTo = coversFrom > giftWeekEnd ? addStaffWorkDays(staffWeekStartForWorkDate(coversFrom), 6) : giftWeekEnd;
  return { earnedWeekStart: weekStart, coversFrom, coversTo };
}

/**
 * The lines a run dated `payDate` may write for a technician: [{ kind, key }]. Pure. The gift is due from its date (the last
 * Friday on or before Dec 20) to LOOKBACK_DAYS after it, so a run early in January can still carry last year's. No year
 * before FIRST_GIFT_YEAR has a gift.
 */
function dueInRun(payDate) {
  const due = [];
  for (const year of [yearOf(payDate) - 1, yearOf(payDate)]) {
    if (year >= FIRST_GIFT_YEAR && decemberGiftDate(year) <= payDate && payDate <= lastPayDate(year)) {
      due.push({ kind: GIFT, key: String(year) });
    }
  }
  return due;
}

const sourceIdOf = techRewardsSourceId;

/**
 * { kind, key } when the sync owns the pay line, else null. The rule has one home, payroll-pay-lines.js techRewardsOwnKey
 * (and techRewardsOwnedSql for a query): the WHOLE source key, compared exactly. Every read, match, move and removal in this
 * file goes through one of the two, so a row somebody made by hand with the Tech Rewards source type is never the sync's.
 */
const ownKeyOf = techRewardsOwnKey;

/** The last pay date a run can carry the gift of `year` on: LOOKBACK_DAYS after the gift date. Pure. */
const lastPayDate = (year) => addStaffWorkDays(decemberGiftDate(year), LOOKBACK_DAYS);

// ---- The stay bonus (pure)

/**
 * The stay bonus a run dated `payDate` may write for a technician hired on `hireDate`: [{ kind, key }], at most one. Pure. A
 * milestone (tech-rewards-calc.js stayBonusSchedule: 1, 3 and 5 years of service) is due from its anniversary to LOOKBACK_DAYS
 * after it, and its key is its years of service. No anniversary before FIRST_STAY_DATE has a bonus. No hire date, no
 * anniversary: nothing is due.
 */
function stayDueInRun(payDate, hireDate) {
  if (!hireDate) return [];
  return calc.stayBonusSchedule(hireDate)
    .filter(({ dueDate }) => dueDate >= FIRST_STAY_DATE && dueDate <= payDate && payDate <= addStaffWorkDays(dueDate, LOOKBACK_DAYS))
    .map(({ years }) => ({ kind: STAY, key: String(years) }));
}

/** The milestone a stay bonus key names for a hire date: { years, rateBps, dueDate }, or null. Pure. */
const stayMilestone = (key, hireDate) => (hireDate && calc.stayBonusSchedule(hireDate).find(({ years }) => String(years) === key)) || null;

/**
 * What the stay bonus due on `dueDate` covers, as the pay line of the run of the pay week starting `weekStart`. Pure.
 * { earnedWeekStart, coversFrom, coversTo }: the 12 months the bonus is worked out from, which is the board's own period
 * (tech-rewards-scoreboard.js stayWindow). The same whichever run pays it.
 */
function staySpanOf(dueDate, weekStart) {
  const { earningsStart, earningsEnd } = scoreboard().stayWindow(dueDate);
  return { earnedWeekStart: weekStart, coversFrom: earningsStart, coversTo: earningsEnd };
}

// What a stay bonus line says it was worked out from: "2% of $52,300.00, the pay earned Jan 12, 2027 to Jan 11, 2028".
const stayNote = (milestone, span, baseCents) => `${milestone.rateBps / 100}% of ${dollars(baseCents)}, the pay earned ${dayLabel(span.coversFrom)} to ${dayLabel(span.coversTo)}`;

// ---- The season bonus (pure)

/** The last pay date a run can carry the season bonus of `year` on: LOOKBACK_DAYS after its pay date. Pure. */
const seasonLastPayDate = (year) => addStaffWorkDays(calc.seasonBonusPayDate(year), LOOKBACK_DAYS);

/**
 * The season bonus a run dated `payDate` may write: [{ kind, key }], at most one. Pure. The bonus of a season (Mar 1 - Aug 31)
 * is due from the last Friday of September of its year (tech-rewards-calc.js seasonBonusPayDate) to LOOKBACK_DAYS after it,
 * which is in the same year, and its key is that year. No season before FIRST_SEASON_YEAR has a bonus.
 */
function seasonDueInRun(payDate) {
  const year = yearOf(payDate);
  const due = year >= FIRST_SEASON_YEAR && calc.seasonBonusPayDate(year) <= payDate && payDate <= seasonLastPayDate(year);
  return due ? [{ kind: SEASON, key: String(year) }] : [];
}

/**
 * What the season bonus of `year` covers for a technician hired on `hireDate`, as the pay line of the run of the pay week
 * starting `weekStart`. Pure. { earnedWeekStart, coversFrom, coversTo }: the season, from the hire date for a technician hired
 * during it (the weeks before they started take no share of the bonus from the weeks they worked, 29 CFR 778.209). The same
 * whichever run pays it.
 */
function seasonSpanOf(year, weekStart, hireDate) {
  const { start, end } = calc.seasonWindow(year);
  return { earnedWeekStart: weekStart, coversFrom: hireDate > start ? hireDate : start, coversTo: end };
}

// What a season bonus line says it was worked out from: "4% of $31,200.00, the pay earned Mar 1, 2027 to Aug 31, 2027, times
// 1.75 (season score 92.5)". The dates are the season's: the base is the pay earned in the season, whatever the span.
const seasonNote = (season, bonus, score) => `${bonus.rateBps / 100}% of ${dollars(bonus.grossCents)}, the pay earned ${dayLabel(season.start)} to ${dayLabel(season.end)}, times ${bonus.multiplierE4 / 10000} (season score ${score.value})`;

/**
 * Who gets a Tech Rewards line, as a technicians query: a W-2 employee (pay lines are for W-2 employees) whose role is
 * technician (an admin account gets none, even one that takes field work) and who is active and takes field work
 * (technician-eligibility.js applyAssignable). A role that is not set is not a technician here: no money on a guess.
 */
const recipients = (trx) => applyAssignable(trx('technicians').where({ 'technicians.employment_type': 'w2', 'technicians.role': 'technician' }));

// ---- The technician rows

// The hire date as every Tech Rewards read takes it (the sync, the notes, the scoreboard): 'YYYY-MM-DD' text, and only for a
// date the calendar code can read, the years 0100 to 9999 AD (exactly the dates utils/datetime-et.js validCalendarDate
// accepts, which is what tech-rewards-calc.js asks of a date). PostgreSQL's date type holds more: a year past 9999 (one key
// too many in a date box), infinity, and a date BC, whose YYYY-MM-DD text drops the era and reads as a date AD. So the range
// is asked of the date itself, before it is text. Any other date on file reads as null.
const HIRE_DATE_SQL = "CASE WHEN technicians.hire_date BETWEEN DATE '0100-01-01' AND DATE '9999-12-31' THEN to_char(technicians.hire_date, 'YYYY-MM-DD') END";

// A technician row as the sync reads it. A hire date on file that is not readable (HIRE_DATE_SQL) is read as none
// (hire_date null) with hire_date_bad true. Nothing is worked out from it, the rest of the run goes on, and the run says so
// in a note (hire_date_invalid). routes/admin-timetracking.js hireDateError refuses such a date at save; this covers a row
// from before that check, and one changed in the database.
const techColumns = (conn) => ['technicians.id', conn.raw(`${HIRE_DATE_SQL} as hire_date`),
  conn.raw('technicians.hire_date IS NOT NULL as hire_on_file')];
const readTech = ({ hire_on_file: onFile, ...row }) => ({ ...row, hire_date: row.hire_date || null, hire_date_bad: Boolean(onFile) && !row.hire_date });

// ---- Readiness

/**
 * The oldest Monday-Sunday week in [coversFrom, coversTo] that a pay run still has to pay, or null. A week needs a check when it
 * has a weekly timesheet with minutes (what a check is worked out from), paid time off while the pay run pays time off
 * (GATE_PAYROLL_TIME_OFF; with it off a run ignores time off), or recorded work (the pay run's own test, payroll-runs.js
 * workedWeeks, which counts a shift that has no summary yet) that no approved timesheet settles. A week whose approved
 * timesheet has no minutes and that holds no payable time off gets no check from any run (evaluate), so it is settled: a gift
 * never waits for a check that cannot come. A week is paid when the technician has a FINALIZED check for it in a
 * finalized run. A week is settled too when its finalized run kept the technician's time off as not paid
 * (payroll_runs.unpaid_time_off: a time-off bank that paid none of it makes no check, and no later run pays that week);
 * a void of that run opens the week again. Whole weeks are asked, the weeks a line's overtime is priced from.
 */
// onlyWeeks: only these Mondays are asked, whatever else the range holds.
// skipClosed: a week whose pay run is final is not in the answer. No second live run can pay it, and no hours
// enter it (time-tracking.js), so a wait for it would never end (payroll-runs.js payoutWaits asks this way).
async function oldestUnpaidWeek(trx, technicianId, { coversFrom, coversTo, skipClosed = false, onlyWeeks = null }) {
  const from = staffWeekStartForWorkDate(coversFrom);
  const lastWeek = staffWeekStartForWorkDate(coversTo);
  const to = addStaffWorkDays(lastWeek, 6);
  const timesheets = await trx('time_weekly_summary')
    .where({ technician_id: technicianId }).where('week_start', '>=', from).where('week_start', '<=', lastWeek)
    .select('status', trx.raw("to_char(week_start, 'YYYY-MM-DD') AS week_start"),
      trx.raw('COALESCE(regular_minutes, 0) + COALESCE(overtime_minutes, 0) AS minutes'));
  const approved = new Set(timesheets.filter((row) => row.status === 'approved').map((row) => row.week_start));
  const withMinutes = timesheets.filter((row) => Number(row.minutes) > 0).map((row) => row.week_start);
  // weeks, not days, from PostgreSQL: a year of days is never converted one by one under the payroll lock
  const worked = (await payrollRuns().workedWeeks(trx, technicianId, from, to)).filter((week) => !approved.has(week));
  const off = timeOffOn()
    ? await trx('payroll_time_off')
      .where({ technician_id: technicianId }).where('work_date', '>=', from).where('work_date', '<=', to).where('minutes', '>', 0)
      .distinct(trx.raw(`to_char(${payrollRuns().weekStartSql('work_date')}, 'YYYY-MM-DD') AS week_start`))
    : [];
  const weeks = [...new Set([...withMinutes, ...worked, ...off.map((row) => row.week_start)])].filter((week) => !onlyWeeks || onlyWeeks.has(week));
  if (!weeks.length) return null;
  const paid = new Set((await trx('payroll_checks as c')
    .join('payroll_runs as r', 'r.id', 'c.run_id')
    .where({ 'c.technician_id': technicianId, 'c.status': 'finalized', 'r.status': 'finalized' })
    .whereIn('c.week_start', weeks)
    .select(trx.raw("to_char(c.week_start, 'YYYY-MM-DD') AS week_start"))).map((row) => row.week_start));
  let open = weeks.filter((week) => !paid.has(week));
  if (skipClosed && open.length) {
    const closed = new Set((await trx('payroll_runs').where({ status: 'finalized' }).whereIn('week_start', open)
      .select(trx.raw("to_char(week_start, 'YYYY-MM-DD') AS week_start"))).map((row) => row.week_start));
    open = open.filter((week) => !closed.has(week));
  }
  const decided = new Set(await timeOffBank.unpaidDecisionWeeks(trx, technicianId, open));
  return open.filter((week) => !decided.has(week)).sort()[0] || null;
}

// The oldest pay week before the run that holds a shift running into a holiday of the technician inside the span (from another
// pay week than the holiday's own) and still has no finalized check, or null. Asked as oldestUnpaidWeek asks a week.
// `span` is the line's own span (hire-clipped for a season bonus): its first pay week is where the caller's own earlier-weeks
// check starts. `earned` is the window the base is worked out from (the full season for a rehire in the middle of it: the base
// counts the premiums earned before the hire date too), where the holidays are read. Default: the span.
async function unpaidHolidayShiftWeek(trx, technicianId, span, beforeRun, earned = span) {
  const holidays = (await trx('payroll_time_off')
    .where({ technician_id: technicianId, kind: 'holiday' })
    .where('work_date', '>=', earned.coversFrom).where('work_date', '<=', earned.coversTo)
    .select(trx.raw("to_char(work_date, 'YYYY-MM-DD') AS work_date"))).map((row) => row.work_date);
  if (!holidays.length) return null;
  // ONE read of the shifts that start before the span's first pay week and overlap any of the holidays; the weeks
  // the span itself covers are asked by the caller. Then ONE read of those weeks together (onlyWeeks: no other week between
  // them is asked).
  const weeks = (await holidayWork.otherWeeksOfShiftsInto(trx, technicianId, holidays, { before: staffWeekStartForWorkDate(span.coversFrom) }))
    .filter((week) => week <= beforeRun);
  if (!weeks.length) return null;
  return oldestUnpaidWeek(trx, technicianId, { coversFrom: weeks[0], coversTo: weeks[weeks.length - 1], onlyWeeks: new Set(weeks) });
}

/**
 * Why the gift cannot go on this run for the technician, as { reason, week }, or null when it can:
 *   later_check_final   a later check of theirs in the tax year is already final: finalize refuses a run that holds a check
 *                       of theirs, so a gift here would hold the whole run (week is null)
 *   later_bank_use_final  they have a time-off bank, and a later final run already read it, left their time off unpaid from
 *                       it or paid their bank out, with or without a check, in any year: finalize refuses a run that holds a check of theirs for
 *                       that too (payroll-runs.js finalizeRun), so a gift here would hold the whole run (week is null)
 *   bank_payout_not_final  they have a time-off bank whose payout is set for an earlier pay week that has no final pay run:
 *                       the run holds every check of theirs until that payout is final or moved (payroll-time-off-bank.js
 *                       payoutsNotFinal), so a gift here would hold the whole run (week is the payout's week)
 *   week_not_paid       a week before the run's own, from the start of its span on, holds work and has no finalized check
 *   week_needs_review   the pay run's own line guards would hold a check for an earlier week of its span
 *   no_paycheck         no check can be worked out for the technician on this run (week is null)
 * (priceCandidate adds two before it asks: hire_date_missing, no hire date on file; pay_week_too_early, the run pays a week
 * before the last week the gift covers.)
 * The unpaid test asks the weeks before the run's own (the run's own week is the one this run pays), from the start of the span
 * to the day before the run's week. For a later run that carries the gift, that is past the end of the span: a check dated
 * after a worked week that has no check yet would make that week's own run refuse to finalize (laterFinalCheckExists), and a
 * gift never puts the office there. The line guards are
 * asked for the WHOLE span, exactly as the run asks them of the line (evaluate), and for the run's OWN week also when it lies
 * after the span (a later run that carries the gift, in January too): a gift goes on a run only when the technician's own
 * week there has no work waiting for approval and no automatic clock-out nobody reviewed. A line that passes never makes the
 * run wait, hold a check or block.
 */
async function spanWaitOf(trx, run, technicianId, span, amountCents, earned = span) {
  if (await payrollRuns().laterFinalCheckExists(trx, run, [technicianId])) return { reason: 'later_check_final', week: null };
  // The check the gift needs would hold the bank of a technician who has one (GATE_PAYROLL_TIME_OFF), also a check for the
  // gift alone. Finalize asks the bank's own order guards of every such check, so the gift waits for the same answer.
  const banks = timeOffOn() ? await timeOffBank.bankTechnicians(trx, [technicianId]) : new Map();
  // With no yearly hours now, a check of an earlier week after a payout is still a bank check (a catch-up check), and
  // finalize asks the same guards of it.
  const caughtUp = timeOffOn() && !banks.size
    && (await timeOffBank.paidOutInLaterWeek(trx, [technicianId], { weekStart: run.week_start, payDate: run.pay_date })).size > 0;
  const banked = caughtUp ? [technicianId] : [...banks.keys()];
  if (await timeOffBank.laterBankCheckExists(trx, run, banked) || await timeOffBank.laterUnpaidDecisionExists(trx, run, banked)
    // Asked also with no yearly hours now: finalizeRun asks it of every check (the hours can be cleared after a payout).
    || await timeOffBank.laterPayoutDecisionExists(trx, run, [technicianId])) {
    return { reason: 'later_bank_use_final', week: null };
  }
  const payoutWeek = (await timeOffBank.payoutsNotFinal(trx, banks, run.week_start)).get(technicianId);
  if (payoutWeek) return { reason: 'bank_payout_not_final', week: payoutWeek };
  const beforeRun = addStaffWorkDays(run.week_start, -1);
  const earlier = { coversFrom: span.coversFrom, coversTo: beforeRun };
  if (earlier.coversFrom <= earlier.coversTo) {
    const unpaid = await oldestUnpaidWeek(trx, technicianId, earlier);
    if (unpaid) return { reason: 'week_not_paid', week: unpaid };
  }
  // A holiday inside the span makes the base hold the premium of every shift that runs into it, and a shift that started the
  // night before is paid by the check of ITS week, which can be a week before the span (payroll-holiday-work.js). That week
  // must be paid too, or the base would be missing the premium.
  // Asked whenever time off is paid, also when the span starts on the run's own Monday (nothing of the span is before the run
  // then, but the shift of the Sunday night before it can still run into the span's first day): unpaidHolidayShiftWeek only
  // looks at weeks before the run.
  if (timeOffOn()) {
    const unpaid = await unpaidHolidayShiftWeek(trx, technicianId, span, beforeRun, earned);
    if (unpaid) return { reason: 'week_not_paid', week: unpaid };
  }
  const ownWeek = { coversFrom: run.week_start, coversTo: addStaffWorkDays(run.week_start, 6) };
  for (const asked of span.coversTo < run.week_start ? [span, ownWeek] : [span]) {
    const guarded = await payrollRuns().lineGuardWeek(trx, technicianId, {
      amountCents, earnedWeekStart: run.week_start, coversFrom: asked.coversFrom, coversTo: asked.coversTo,
    });
    if (guarded) return { reason: 'week_needs_review', week: guarded };
  }
  return null;
}

// no_paycheck: no check that holds only this line ({ kind, amountCents }) can be worked out for the technician on this run.
async function checkWaitOf(trx, run, technicianId, line) {
  const problem = await payrollRuns().lineOnlyCheckProblem(trx, run, technicianId, line);
  return problem ? { reason: 'no_paycheck', week: null } : null;
}

// The gift's waits: the span's (spanWaitOf), then no_paycheck.
const waitOf = async (trx, run, technicianId, span) => (await spanWaitOf(trx, run, technicianId, span, DECEMBER_GIFT_CENTS))
  || checkWaitOf(trx, run, technicianId, { kind: GIFT, amountCents: DECEMBER_GIFT_CENTS });

/** { amountCents, span }, { skip: reason } (no gift for them) or { wait: { reason, week } } (not on this run) for one candidate. */
async function priceGift(trx, cand, tech, run) {
  if (tech.hire_date && tech.hire_date > decemberGiftDate(Number(cand.key))) return { skip: 'hired_after_gift_date' };
  // No hire date on file, or one that is not a calendar date (readTech): the run cannot tell whether they were hired by the
  // gift date, and no money goes out on a guess. The gift waits, with a note, until the date is entered or corrected.
  if (!tech.hire_date) return { wait: { reason: tech.hire_date_bad ? 'hire_date_invalid' : 'hire_date_missing', week: null } };
  const span = spanOf(cand.key, run.week_start, tech.hire_date);
  // This run pays a week before the last week the gift covers (an old week paid late; or the gift week's own run, for a
  // technician hired after that week). A line cannot cover days after the week that pays it, and the period is never cut
  // short to fit: the overtime of the weeks left out would get no share of the gift. The run of that week or a later one
  // writes it.
  const lastWeek = staffWeekStartForWorkDate(span.coversTo);
  if (run.week_start < lastWeek) return { wait: { reason: 'pay_week_too_early', week: lastWeek } };
  const wait = await waitOf(trx, run, tech.id, span);
  return wait ? { wait } : { amountCents: DECEMBER_GIFT_CENTS, span };
}

/**
 * The stay bonus of one candidate: { amountCents, span, note } or { wait: { reason, week } } (not on this run). The amount is
 * the milestone's rate times the pay EARNED in its 12 months on the checks of those pay weeks, exactly as the board reads it
 * (tech-rewards-scoreboard.js readBonusPay: the finalized checks, by the day the pay was earned; no Tech Rewards line and none
 * of the overtime one caused; no check for a later pay week), worked out by tech-rewards-calc.js stayBonus. So the bonus is
 * worked out only when those checks are all final, and it is the same on every run after that:
 *   pay_week_too_early  this run pays the last week of the 12 months or an earlier one. Its own check is not final, so the
 *                       pay of that week is not in the base yet: the run of a later week writes the bonus (week = that last week)
 *   (spanWaitOf)        later_check_final, later_bank_use_final, bank_payout_not_final, week_not_paid, week_needs_review, as for the gift: every week from the start of
 *                       the 12 months to the day before the run's week that holds work has a finalized check
 *   base_needs_review   an older check of the 12 months paid a Tech Rewards line and other line pay for an overtime week and
 *                       kept no proven split of that overtime (tech-rewards-scoreboard.js ordinaryPremium, unsplitWeeks;
 *                       week = the oldest such week). The base is not known to the cent, so the bonus is never paid from
 *                       it: the office works it out by hand
 *   no_pay_on_file      no finalized check holds pay of theirs for the 12 months (pay made outside the pay runs): no bonus on
 *                       a base of nothing, and a note so the office sees it
 *   no_paycheck         as for the gift, asked with the bonus's own amount
 * An open pay line never holds the bonus: the run that pays it is for a later pay week, so it is no part of the base.
 * The line guards read the weeks a line covers, never its amount, so they are asked with 1 cent before the pay is read.
 */
async function priceStay(trx, cand, tech, run) {
  const milestone = stayMilestone(cand.key, tech.hire_date);
  const span = staySpanOf(milestone.dueDate, run.week_start);
  const lastWeek = staffWeekStartForWorkDate(span.coversTo);
  if (run.week_start <= lastWeek) return { wait: { reason: 'pay_week_too_early', week: lastWeek } };
  const wait = await spanWaitOf(trx, run, tech.id, span, 1);
  if (wait) return { wait };
  const { cents: baseCents, checkIds, unsplitWeeks } = await scoreboard().readBonusPay(trx, tech.id, span.coversFrom, span.coversTo);
  if (unsplitWeeks.length) return { wait: { reason: 'base_needs_review', week: unsplitWeeks[0] } };
  const amountCents = baseCents > 0
    ? calc.stayBonus({ hireDate: tech.hire_date, asOf: milestone.dueDate, priorTwelveMonthsPayCents: baseCents }).cents
    : 0;
  if (!amountCents) return { wait: { reason: 'no_pay_on_file', week: null } };
  const noCheck = await checkWaitOf(trx, run, tech.id, { kind: STAY, amountCents });
  return noCheck ? { wait: noCheck } : { amountCents, span, note: stayNote(milestone, span, baseCents), countedCheckIds: checkIds };
}

/**
 * One technician's score figures of a season (tech-rewards-scoreboard.js readSeasonScoreFigures: the score and its settings,
 * the review asks and reviews), or null when the read failed. The read runs in a savepoint of the snapshot: the readers read
 * field records that payroll does not own (reports, audits, callbacks, truck checks, ratings), and an error in one
 * technician's read must not end the snapshot the others are read in. The error is logged and that bonus waits
 * (score_read_failed).
 */
async function readSeasonScoreOrNull(snapshot, technicianId, season) {
  try {
    return await snapshot.transaction((savepoint) => scoreboard().readSeasonScoreFigures(savepoint, technicianId, season));
  } catch (err) {
    logger.error(`[tech-rewards-pay-lines] season ${season.year} score could not be read for technician ${technicianId}: ${err.message}`);
    return null;
  }
}

/**
 * The season score figures a pay run dated `payDate` may need, read BEFORE the pay run's transaction opens (payroll-runs.js
 * draftRun, recomputeRun, finalizeRun), or null when the run is dated for no season bonus or a gate is off (then nothing is
 * read). { figures: Map(source key -> the figures, or null for a read that failed), failed }.
 *   - ONE SNAPSHOT. A score has five parts, its settings and two review counts. They are read in one read-only REPEATABLE
 *     READ transaction, as the board reads them (tech-rewards-scoreboard.js getScoreboard), for every technician at once: a
 *     closeout that commits between two parts cannot count in one and not the other and move a score across a band. The pay
 *     run's own transaction is READ COMMITTED, so the read is not in it.
 *   - ONE CONNECTION AT A TIME. The snapshot is taken, and its connection given back, before the pay run asks for its own:
 *     a pay run never holds two connections. A read made from inside the pay run's transaction would hold the payroll lock
 *     and wait for a second connection, while the pay runs that wait for that lock hold the rest of a small pool.
 *   - WHO. Every technician who gets Tech Rewards lines now (recipients), less the ones whose season bonus is settled (a line
 *     that is no longer open, as loadState reads it). The sync reads its own list under the lock afterwards: a technician it
 *     finds who was not read here waits with a note (score_not_read), and the next sync reads them.
 *   - A BONUS NEVER HOLDS A PAY RUN. A read that fails is logged and that bonus waits (score_read_failed): one technician's
 *     (readSeasonScoreOrNull), or every one when the snapshot itself fails (`failed`).
 *   - NOT THE LAST WORD. The pay run takes the payroll lock after this read, and may wait for it. seasonScoreOf reads each
 *     score again under the lock and uses these figures only when nothing changed.
 */
async function readSeasonScores(conn, payDate) {
  const due = payLinesOn() && kindOn(SEASON) ? seasonDueInRun(payDate) : [];
  if (!due.length) return null;
  const figures = new Map();
  try {
    await conn.transaction(async (snapshot) => {
      const settled = new Set((await closedLines(snapshot, { kind: SEASON })).filter(ownKeyOf).map((line) => line.source_id));
      const ids = (await recipients(snapshot).orderBy('technicians.id').select('technicians.id')).map((row) => row.id);
      for (const { key } of due) {
        const season = scoreboard().closedSeason(Number(key));
        for (const id of ids) {
          const sourceId = sourceIdOf(SEASON, id, key);
          if (!settled.has(sourceId)) figures.set(sourceId, await readSeasonScoreOrNull(snapshot, id, season));
        }
      }
    }, { isolationLevel: 'repeatable read', readOnly: true });
  } catch (err) {
    logger.error(`[tech-rewards-pay-lines] season scores could not be read for a pay run dated ${payDate}: ${err.message}`);
    return { figures: new Map(), failed: true };
  }
  return { figures, failed: false };
}

/** readSeasonScores for a pay run that is on file (a recompute, a finalize): a run's pay date never changes. Null for no such run. */
async function readSeasonScoresOfRun(conn, runId) {
  if (!payLinesOn() || !kindOn(SEASON)) return null;
  const run = await conn('payroll_runs').where({ id: runId }).first(conn.raw("to_char(pay_date, 'YYYY-MM-DD') as pay_date"));
  return run ? readSeasonScores(conn, run.pay_date) : null;
}

/**
 * The score figures one season bonus is worked out from, or { wait }: the figures read before the pay run's transaction
 * opened (readSeasonScores), once the pay run has checked them UNDER THE PAYROLL LOCK. The pay run waits for that lock after
 * the first read, so a score part corrected in between (an owner rating, a closeout) would be paid from the old score, and
 * a finalize would pay it with the draft the office approved. So the figures are read a second time here, on the pay run's
 * own connection, in a savepoint (readSeasonScoreOrNull: no second connection, and an error does not end the pay run's
 * transaction), and compared with the first:
 *   the same      the snapshot's figures are one moment's data AND still the data under the lock: they are used
 *   not the same  the bonus waits (score_changed). Its open line comes off, so a finalize sees a run that differs from the
 *                 draft, pays nothing from the old score and gives the office the new numbers; the next sync reads again
 * The second read alone is not used: it is READ COMMITTED, and its parts can be from two moments. The sync holds the score
 * settings lock by now (syncTechRewardLines), so the settings read here are the settings until the pay run ends.
 */
async function seasonScoreOf(trx, technicianId, key, season, seasonScores) {
  const wait = (reason) => ({ wait: { reason, week: null } });
  const read = seasonScores ? seasonScores.figures.get(sourceIdOf(SEASON, technicianId, key)) : undefined;
  if (read === undefined && !(seasonScores && seasonScores.failed)) return wait('score_not_read');
  if (!read) return wait('score_read_failed');
  const underLock = await readSeasonScoreOrNull(trx, technicianId, season);
  if (!underLock) return wait('score_read_failed');
  return isDeepStrictEqual(underLock, read) ? read : wait('score_changed');
}

/**
 * The season bonus of one candidate: { amountCents, span, note, countedCheckIds }, { skip: reason } (no bonus for them) or
 * { wait: { reason, week } } (not on this run). Every figure is the board's own, read as of the season's last day
 * (tech-rewards-scoreboard.js readSeasonScoreFigures, readSeasonPay: the two reads the board's readSeasonFigures is made of)
 * and put together by the board's own code (seasonBonusOf), so the line is the figure the board shows for the closed season.
 * The score figures are the ones read before the pay run's transaction opened (`seasonScores`, readSeasonScores), checked
 * again under the payroll lock (seasonScoreOf). `conflict`: the wait for a season bonus line that the sync did not write
 * (applyCandidate), or null.
 * The pay is the pay EARNED in the season on the finalized checks for the pay weeks through seasonLastPayWeek (readBonusPay:
 * no check for a later pay week), read in the pay run's transaction under the payroll lock, so, as for the stay bonus, the
 * line is worked out only when those checks are all final. In this order:
 *   hired_after_season      (skip) hired after the season's last day: no bonus for that season
 *   score_not_read          the read before the run did not cover this technician (a recipient since that read, or a gate
 *                           turned on since): the next sync reads them
 *   score_read_failed       the score could not be read (readSeasonScores, seasonScoreOf): the error is logged and the run
 *                           goes on
 *   score_changed           the score is not what it was before the pay run took the payroll lock (seasonScoreOf)
 *                           (while the score is not known, a line the sync did not write comes first: `conflict`)
 *   score_below_bonus_line  (skip) the score is complete and under the lowest cut line: the season earns no bonus on any
 *                           run. Asked BEFORE every wait below, so no run says a bonus waits (for a hire date, for an unpaid
 *                           week, for a line somebody made by hand) that no run will pay
 *   other_season_line       a season bonus line that the sync did not write is on file (`conflict`): check that line first
 *   hire_date_missing,      no hire date on file, or one that is not a calendar date: the multiplier counts years of service,
 *   hire_date_invalid       so the bonus waits, with a note, until the date is entered or corrected
 *   pay_week_too_early      this run pays the last week the base counts or an earlier one: its own check is not final, so
 *                           its pay is not in the base yet (week = that last week)
 *   (spanWaitOf)            later_check_final, week_not_paid, week_needs_review, as for the gift
 *   base_needs_review       as for the stay bonus (week = the oldest week with no proven split)
 *   score_settings_missing  no score settings are in force for the season's last day (rows exist, and all start later)
 *   score_incomplete        a score part has no data for the season: a bonus is never worked out from a partial score
 *   no_pay_on_file, no_paycheck  as for the stay bonus
 * An open line is worked out again at every sync, so a score part or a setting corrected before the run is finalized moves it.
 */
async function priceSeason(trx, cand, tech, run, { seasonScores, conflict }) {
  const season = scoreboard().closedSeason(Number(cand.key));
  if (tech.hire_date && tech.hire_date > season.end) return { skip: 'hired_after_season' };
  const scored = await seasonScoreOf(trx, tech.id, cand.key, season, seasonScores);
  if (scored.wait) return conflict || scored;
  // the band is the score module's own (buildSeasonScore: scoreBand with the settings in force on the season's last day)
  if (scored.seasonScore && scored.seasonScore.complete && scored.seasonScore.rateBps === 0) return { skip: 'score_below_bonus_line' };
  if (conflict) return conflict;
  if (!tech.hire_date) return { wait: { reason: tech.hire_date_bad ? 'hire_date_invalid' : 'hire_date_missing', week: null } };
  const span = seasonSpanOf(season.year, run.week_start, tech.hire_date);
  const lastWeek = scoreboard().seasonLastPayWeek(season.year);
  if (run.week_start <= lastWeek) return { wait: { reason: 'pay_week_too_early', week: lastWeek } };
  // the holiday readiness looks at the FULL season (the base counts every premium earned in it, also before a hire date in the
  // middle of it); the hire-clipped span stays the line's own
  const wait = await spanWaitOf(trx, run, tech.id, span, 1, { coversFrom: season.start, coversTo: season.end });
  if (wait) return { wait };
  const seasonPay = await scoreboard().readSeasonPay(trx, tech.id, season);
  if (seasonPay.unsplitWeeks.length) return { wait: { reason: 'base_needs_review', week: seasonPay.unsplitWeeks[0] } };
  const { score, seasonBonus } = scoreboard().seasonBonusOf(tech.hire_date, season, { ...scored, grossSeasonCents: seasonPay.cents });
  if (score.unavailable) return { wait: { reason: 'score_settings_missing', week: null } };
  if (!score.complete) return { wait: { reason: 'score_incomplete', week: null } };
  const amountCents = seasonBonus.estimateCents;
  if (!amountCents) return { wait: { reason: 'no_pay_on_file', week: null } };
  const noCheck = await checkWaitOf(trx, run, tech.id, { kind: SEASON, amountCents });
  return noCheck ? { wait: noCheck } : { amountCents, span, note: seasonNote(season, seasonBonus, score), countedCheckIds: seasonPay.checkIds };
}

const PRICE = { [GIFT]: priceGift, [STAY]: priceStay, [SEASON]: priceSeason };
// A line of the kind that this sync did not write is on file for the technician: the reason the automatic line waits.
const OTHER_LINE = { [GIFT]: 'other_gift_line', [STAY]: 'other_stay_line', [SEASON]: 'other_season_line' };

// ---- Sync

// The Tech Rewards lines that are no longer open (paid or voided). One of them that the sync wrote (ownKeyOf) settles its key:
// no run reads or writes that line again. One read, for the sync (every technician), for the notes, and for the scoreboard
// (one technician's stay bonuses, stayBonusStatus).
const closedLines = (conn, where = {}) => conn('payroll_pay_lines').where({ source_type: SOURCE_TYPE, ...where }).whereNot({ status: 'open' })
  .select('technician_id', 'kind', 'source_type', 'source_id');

/**
 * What the scoreboard asks of payroll to show a technician's stay bonus (tech-rewards-scoreboard.js stayBonusBlock), for the
 * hire date as HIRE_DATE_SQL reads it. Stay bonus milestones as keys ('1', '3', '5'):
 *   settledKeys  the ones the technician is done with: a line the sync wrote that is no longer open. No pay run writes one of
 *                them again, whatever the hire date on file says now (loadState, settled).
 *   payableKeys  the ones a pay run built and dated `today` could still write for them: not settled, inside their dates
 *                (stayDueInRun: from the anniversary to LOOKBACK_DAYS after it, none before FIRST_STAY_DATE), and the
 *                technician gets Tech Rewards lines today (recipients, as the sync asks on the day a run is built).
 * The pay gate is not asked: the board shows the plan, as it does for a milestone that is still ahead.
 */
async function stayBonusStatus(conn, technicianId, hireDate, today) {
  const settledKeys = (await closedLines(conn, { technician_id: technicianId, kind: STAY })).map(ownKeyOf).filter(Boolean).map((own) => own.key);
  const dated = stayDueInRun(today, hireDate).map((due) => due.key).filter((key) => !settledKeys.includes(key));
  const recipient = dated.length ? await recipients(conn).where('technicians.id', technicianId).first('technicians.id') : null;
  return { settledKeys, payableKeys: recipient ? dated : [] };
}

/**
 * The season bonus payroll has PAID a technician for a season year, in cents, or null: the sync's own line for that year
 * (ownKeyOf: its whole source key, for a season that has a bonus) that is paid on a FINALIZED check of a FINALIZED pay run. A
 * row marked paid that is not the sync's own (a hand-made line, a key for a season before the first one) or that no finalized
 * check holds is not money payroll paid, and never shows as paid. The scoreboard shows the amount in place of its estimate
 * for a closed season (tech-rewards-scoreboard.js seasonBonusBlock): a paid line never changes, and the figures behind an
 * estimate can (a score part corrected later, an old week paid late). Not behind a gate: a paid line is a fact with the gate
 * off too.
 */
async function seasonBonusPaidCents(conn, technicianId, year) {
  const row = await conn('payroll_pay_lines as line')
    .join('payroll_checks as paid', 'paid.id', 'line.check_id')
    .join('payroll_runs as run', 'run.id', 'paid.run_id')
    .where({
      'line.technician_id': technicianId, 'line.kind': SEASON, 'line.status': 'paid', 'line.source_type': SOURCE_TYPE,
      'line.source_id': sourceIdOf(SEASON, technicianId, String(year)), 'paid.status': 'finalized', 'run.status': 'finalized',
    })
    .first('line.technician_id', 'line.kind', 'line.source_type', 'line.source_id', 'line.amount_cents');
  return row && ownKeyOf(row) ? Number(row.amount_cents) : null;
}

const lineColumns = (trx) => ['id', 'technician_id', 'kind', 'status', 'amount_cents', 'note', 'counted_check_ids', 'source_type', 'source_id',
  trx.raw("to_char(earned_week_start, 'YYYY-MM-DD') as earned_week_start"),
  trx.raw("to_char(covers_from, 'YYYY-MM-DD') as covers_from"),
  trx.raw("to_char(covers_to, 'YYYY-MM-DD') as covers_to")];

// ids, kinds, reason codes and weeks only, never an amount (the audit event and the run row)
const waitRow = (w) => ({ technician_id: w.technicianId, kind: w.kind, source_id: w.sourceId, reason: w.reason, week: w.week });

const WAIT_WORDS = {
  week_not_paid: (w) => `the week of ${dayLabel(w.week)} is not paid yet`,
  week_needs_review: (w) => `the week of ${dayLabel(w.week)} has a timesheet to approve or an automatic clock-out to review`,
  no_paycheck: () => 'no paycheck can be worked out for them on this pay run (check their pay rate, and the tax tables for the pay date)',
  later_check_final: () => 'a later paycheck of theirs is already final, so this pay run cannot hold one for them',
  later_bank_use_final: () => 'a later pay run that is already final used their time-off bank, so this pay run cannot hold a paycheck for them',
  bank_payout_not_final: (w) => `their time-off bank payout is set for the week of ${dayLabel(w.week)}, and that pay run is not final yet`,
  hire_date_missing: (w) => (w.kind === SEASON
    ? 'their hire date is not on file, so the pay run cannot count their years of service'
    : 'their hire date is not on file, so the pay run cannot tell whether they were hired by the gift date'),
  hire_date_invalid: () => 'their hire date on file is not a date the pay run can read, so correct it on their staff profile',
  pay_week_too_early: (w) => ({
    [STAY]: `the 12 months it is worked out from end in the week of ${dayLabel(w.week)}, and only a pay run for a later week can add it`,
    [SEASON]: `the pay it is worked out from is counted through the pay week of ${dayLabel(w.week)}, and only a pay run for a later week can add it`,
  }[w.kind] || `this pay run pays an earlier week than the week of ${dayLabel(w.week)}, the last week the gift covers`),
  other_gift_line: () => 'a December gift line that the pay run did not write is already on file for them, so check that line first',
  other_stay_line: () => 'a stay bonus line that the pay run did not write is already on file for them, so check that line first',
  other_season_line: () => 'a season bonus line that the pay run did not write is already on file for them, so check that line first',
  no_pay_on_file: (w) => `no finalized paycheck holds pay of theirs for the ${w.kind === SEASON ? 'season' : '12 months'} it is worked out from`,
  score_incomplete: () => 'a part of their season score has no data (their scoreboard names it), and a bonus is never worked out from a partial score',
  score_settings_missing: () => 'no score settings are in force for the last day of the season, so set them first',
  score_read_failed: () => 'the pay run could not read their season score because of an error, so report it',
  score_not_read: () => 'their season score was not read for this pay run, so recompute it',
  score_changed: () => 'their season score changed while this pay run was worked out, so recompute it',
  base_needs_review: (w) => `an older paycheck paid a bonus line and other line pay for the week of ${dayLabel(w.week)} and kept no split of that week's overtime between them, so work this bonus out by hand`,
};

/** What waits as of this sync, kept on the draft run's row and replaced by every sync with the gate on. */
async function saveWaits(trx, run, waits) {
  await trx('payroll_runs').where({ id: run.id, status: 'draft' })
    .update({ tech_rewards_waits: waits.length ? JSON.stringify(waits.map(waitRow)) : null });
}

/**
 * With either gate off the run keeps no stored wait: a wait saved while the gates were on would outlive its cause (a pay rate
 * corrected since) and show again, on a finalized run too, when the gates come back on. One UPDATE, and none when the run
 * holds no wait.
 */
const clearWaits = (trx, run) => trx('payroll_runs').where({ id: run.id, status: 'draft' }).whereNotNull('tech_rewards_waits')
  .update({ tech_rewards_waits: null });

async function audit(trx, actorId, run, metadata) {
  await recordAuditEvent({
    trx, critical: true, actor_type: 'admin', actor_id: actorId,
    action: AUDIT_ACTION, resource_type: 'payroll_pay_lines', resource_id: null,
    metadata: { run_id: run.id, week_start: run.week_start, ...metadata },
  });
}

/** A kind's gate off: every open line of that kind the sync owns comes off. Paid lines stay, and so does a hand-made row. Returns the ids removed. */
async function dropOpenLines(trx, lock, kinds) {
  const query = trx('payroll_pay_lines').where({ source_type: SOURCE_TYPE, status: 'open' }).whereIn('kind', kinds)
    .whereRaw(techRewardsOwnedSql()).select('id');
  if (lock) query.forUpdate();
  const ids = (await query).map((row) => row.id);
  if (ids.length) await trx('payroll_pay_lines').whereIn('id', ids).del();
  return ids;
}

/**
 * Deletes the OPEN Tech Rewards lines the sync owns in one pay week (never a hand-made row). A voided run takes its lines
 * with it (call it after payroll-pay-lines.js reopenLinesOfRun, so the paid ones are open again), and a finalized run keeps
 * none it did not pay (call it after markLinesPaid). The next run dated for a deleted line writes it again. Returns the ids removed, for the caller's audit event.
 */
async function dropRewardLinesOfWeek(trx, weekStart) {
  const rows = await trx('payroll_pay_lines').where({ source_type: SOURCE_TYPE, status: 'open', earned_week_start: weekStart })
    .whereRaw(techRewardsOwnedSql()).del().returning('id');
  return rows.map((row) => (row && row.id ? row.id : row));
}

// The technicians a run may write a line for (recipients), with their hire dates. A run dated for a gift or a season bonus
// (`dateDue`: due by the pay date alone, the same for every technician) reads all of them. Any
// other run reads only the ones a stay bonus is dated for and the ones whose stay bonus line is already open on it: most runs
// of the year read and lock no technician row. With lock the rows are read FOR SHARE, as payroll-family-employee.js
// familyExemptIds reads them: a change to one of these technicians waits for the pay run's transaction, so a finalize never
// pays a line the change took away. The stay bonus is looked for in a plain read first; only the locked rows are used after it.
// A technician whose hire date on file is not a calendar date is read too (readTech): the run notes it.
async function loadTechs(trx, run, lock, dateDue, openHere) {
  let ids = null;
  if (!dateDue.length) {
    const dated = kindOn(STAY)
      ? (await recipients(trx).whereNotNull('technicians.hire_date').select(techColumns(trx))).map(readTech)
        .filter((row) => row.hire_date_bad || stayDueInRun(run.pay_date, row.hire_date).length)
      : [];
    ids = [...new Set([...dated.map((row) => row.id), ...openHere.filter((line) => line.kind === STAY).map((line) => line.technician_id)])];
    if (!ids.length) return [];
  }
  const query = recipients(trx).orderBy('technicians.id').select(techColumns(trx));
  if (ids) query.whereIn('technicians.id', ids);
  if (lock) query.forShare();
  return (await query).map(readTech);
}

// Everything this run could write or change: the lines due by its pay date for every technician, plus the open Tech Rewards
// lines already written for this week (a recompute). An open line of another week is read so a ready run can take it.
async function loadState(trx, run, lock) {
  const openQuery = trx('payroll_pay_lines').where({ source_type: SOURCE_TYPE, status: 'open' }).select(lineColumns(trx));
  if (lock) openQuery.forUpdate();
  const allOpen = await openQuery;
  const closed = await closedLines(trx);
  // Only a line whose WHOLE source key is the sync's own (ownKeyOf) is treated as a line the sync wrote. A row with the Tech
  // Rewards source type and any other source id (another technician's key, no year) is a row somebody put in the database by
  // hand. The sync never matches it to a candidate, never changes it, and never writes the line whose key it holds: that
  // candidate waits (OTHER_LINE), so the unique source key cannot fail the pay run.
  const ownOpen = allOpen.filter((line) => ownKeyOf(line));
  const foreignKeys = new Set([...allOpen, ...closed].filter((line) => !ownKeyOf(line)).map((line) => line.source_id));
  const openHere = ownOpen.filter((line) => line.earned_week_start === run.week_start);
  // paid (or voided) lines are evidence: their keys are never read or written again
  const settled = new Set(closed.filter((line) => ownKeyOf(line)).map((line) => line.source_id));
  // What the run's pay date is for. The gift and the season bonus are the same for every technician; a stay bonus depends on
  // the hire date.
  const dateDue = [...(kindOn(GIFT) ? dueInRun(run.pay_date) : []), ...(kindOn(SEASON) ? seasonDueInRun(run.pay_date) : [])];
  const techs = await loadTechs(trx, run, lock, dateDue, openHere);
  const techById = new Map(techs.map((row) => [row.id, row]));
  const candidates = new Map();
  for (const tech of techs) {
    const due = [...dateDue, ...(kindOn(STAY) ? stayDueInRun(run.pay_date, tech.hire_date) : [])];
    for (const { kind, key } of due) {
      candidates.set(sourceIdOf(kind, tech.id, key), { kind, key, technicianId: tech.id, due: true });
    }
  }
  // An open line of this week whose technician is not a recipient now, or that the run is no longer dated for. `due` says
  // which of the two took the line off, for the audit event. A gift or a season bonus is due by the run's pay date alone,
  // whoever the technician is. A stay bonus is due by the hire date: a recipient who is read and has no candidate is not due
  // here, and one who is not read is no longer a recipient (applyCandidate, not_active).
  const dateKeys = new Set(dateDue.map((d) => `${d.kind}:${d.key}`));
  for (const line of openHere) {
    const own = ownKeyOf(line);
    if (own && !candidates.has(line.source_id)) {
      candidates.set(line.source_id, {
        kind: line.kind, key: own.key, technicianId: line.technician_id,
        due: line.kind === STAY ? !techById.has(line.technician_id) : dateKeys.has(`${line.kind}:${own.key}`),
      });
    }
  }
  // A line of a kind the run is dated for that this sync did not write: its whole source key is not the sync's own (ownKeyOf),
  // whatever its source type says. No code path makes one (the add form and its route offer the four manual kinds only, with
  // no source), so it is a row somebody put in the database by hand: that technician's automatic line of the kind is held for
  // review, and never paid beside it. Any key, open or paid; a voided row does not count. One small read: a technician has one
  // gift line and one season bonus line a year, and three stay bonus lines in all.
  const dueKinds = [...new Set([...candidates.values()].filter((cand) => cand.due).map((cand) => cand.kind))];
  const kindLines = dueKinds.length
    ? await trx('payroll_pay_lines').whereIn('kind', dueKinds).whereNot({ status: 'voided' })
      .select('technician_id', 'kind', 'source_type', 'source_id')
    : [];
  const handMade = new Set(kindLines.filter((line) => !ownKeyOf(line)).map((line) => `${line.kind}:${line.technician_id}`));
  return {
    candidates,
    techById,
    settled,
    handMade,
    foreignKeys,
    // A hire date on file that is not a calendar date: no anniversary is known, so no stay bonus can be looked for.
    unreadHire: kindOn(STAY) ? techs.filter((tech) => tech.hire_date_bad).map((tech) => tech.id) : [],
    openBySource: new Map(ownOpen.map((line) => [line.source_id, line])),
  };
}

// priced: { amountCents, span, note } (a gift has no note)
const changed = (open, { amountCents, span, note, countedCheckIds }) => Number(open.amount_cents) !== amountCents
  || open.covers_from !== span.coversFrom || open.covers_to !== span.coversTo || (open.note || null) !== (note || null)
  || String(open.counted_check_ids || []) !== String(countedCheckIds || []);

// The checks a line was worked out from (counted_check_ids), for a line that is worked out from pay; none for the gift.
const countedOf = ({ countedCheckIds }) => (countedCheckIds ? { counted_check_ids: countedCheckIds } : {});

// An open line gets the pay week, the span, the amount, the note and the counted checks of the run that pays it now.
const moveLine = (trx, id, priced) => trx('payroll_pay_lines').where({ id, status: 'open' }).update({
  amount_cents: priced.amountCents, earned_week_start: priced.span.earnedWeekStart, covers_from: priced.span.coversFrom, covers_to: priced.span.coversTo,
  ...(priced.note ? { note: priced.note } : {}),
  ...countedOf(priced),
  updated_at: trx.fn.now(),
});

/**
 * Writes one candidate's line: insert, work out again, take or remove. Returns { added, updated, removed, skip, wait } (ids /
 * reason / { reason, week }). A run that is dated for the line and ready takes a line that is open in another pay week (the
 * line moves here); a run that is not leaves it where it is. An open line of this week that the run is no longer dated for, or
 * no longer ready to pay, comes off.
 */
async function applyCandidate(trx, run, sourceId, cand, state) {
  const open = state.openBySource.get(sourceId);
  const here = Boolean(open) && open.earned_week_start === run.week_start;
  const tech = state.techById.get(cand.technicianId);
  // A line of the kind that the sync did not write (loadState, handMade and foreignKeys): the automatic line waits for it. A
  // season bonus asks first whether the season earns a bonus at all (priceSeason: hired after the season, a score under the
  // lowest cut line), so nobody is asked to check a hand-made line against an automatic bonus that no run will write.
  const conflict = state.handMade.has(`${cand.kind}:${cand.technicianId}`) || state.foreignKeys.has(sourceId)
    ? { wait: { reason: OTHER_LINE[cand.kind], week: null } } : null;
  let priced;
  if (!cand.due) priced = { skip: 'not_due_in_this_run' };
  else if (!tech) priced = { skip: 'not_active' };
  else if (conflict && cand.kind !== SEASON) priced = conflict;
  else priced = await PRICE[cand.kind](trx, cand, tech, run, { seasonScores: state.seasonScores, conflict });
  if (priced.skip || priced.wait) {
    if (here) await trx('payroll_pay_lines').where({ id: open.id }).del();
    return { skip: priced.skip, wait: priced.wait, removed: here ? open.id : null };
  }
  const { span } = priced;
  if (open) {
    if (here && !changed(open, priced)) return {};
    await moveLine(trx, open.id, priced);
    return { updated: open.id };
  }
  const [inserted] = await trx('payroll_pay_lines').insert({
    technician_id: cand.technicianId,
    kind: cand.kind,
    amount_cents: priced.amountCents,
    earned_week_start: span.earnedWeekStart,
    covers_from: span.coversFrom,
    covers_to: span.coversTo,
    ...(priced.note ? { note: priced.note } : {}),
    ...countedOf(priced),
    source_type: SOURCE_TYPE,
    source_id: sourceId,
  }).returning('id');
  return { added: inserted && inserted.id ? inserted.id : inserted };
}

/**
 * When this sync is about to work a season bonus out: from here to the end of the pay run's transaction no score settings
 * version can be saved (tech-rewards-scores.js lockSettingsForRead, the lock saveSettings takes). The settings move every
 * technician's band at once, so a save must not land between the check of a score under the payroll lock (seasonScoreOf) and
 * the bonus this run pays. Taken after the payroll lock, and a settings save takes no payroll lock: the two cannot lock
 * each other. A sync with no season bonus to work out takes nothing, and so does one that takes no locks (`lock` false).
 * The field records behind the score parts (reports, audits, callbacks, truck checks, ratings) are not locked: a pay run
 * never stops a technician closing a report. A record written after the check is after this pay run, and a paid bonus is the
 * one worked out from the records on file when payroll finalized.
 */
async function holdScoreSettings(trx, state, lock) {
  const pricesSeason = lock && [...state.candidates].some(([sourceId, cand]) => cand.kind === SEASON && cand.due && !state.settled.has(sourceId));
  if (pricesSeason) await scoreSettings().lockSettingsForRead(trx);
}

/**
 * Makes the open Tech Rewards pay lines match the plan, for the pay run `run` ({ id, week_start, pay_date } as
 * payroll-runs.js loadRun reads it). Take it inside the pay run's transaction, after the payroll lock and before the run is
 * worked out. Pay lines off: no pay line is read or written. A kind's gate off: its open lines are removed and none is written.
 * With pay lines off, or every kind's gate off, the run's stored waits are cleared. Never blocks a check.
 * `seasonScores`: what readSeasonScores read for this run before the transaction opened (null: nothing was read).
 * Returns { added, updated, removed, skipped: [{ technicianId, kind, reason }], waits: [{ technicianId, kind, sourceId, reason, week }] }.
 */
async function syncTechRewardLines(run, trx, { lock = true, actorId = null, seasonScores = null } = {}) {
  const result = { added: 0, updated: 0, removed: 0, skipped: [], waits: [] };
  if (!payLinesOn()) {
    await clearWaits(trx, run);
    return result;
  }
  // A kind whose gate is off: its open lines come off, whatever the other kind's gate says.
  const offKinds = Object.keys(KIND_GATES).filter((kind) => !kindOn(kind));
  const allOff = offKinds.length === Object.keys(KIND_GATES).length;
  if (allOff) await clearWaits(trx, run);
  const dropped = offKinds.length ? await dropOpenLines(trx, lock, offKinds) : [];
  if (dropped.length) await audit(trx, actorId, run, { gate: 'off', removed_count: dropped.length, removed_line_ids: dropped });
  if (allOff) return { ...result, removed: dropped.length };
  const state = { ...(await loadState(trx, run, lock)), seasonScores };
  await holdScoreSettings(trx, state, lock);
  const ids = { added: [], updated: [], removed: [] };
  let examined = 0;
  let unchanged = 0;
  for (const [sourceId, cand] of [...state.candidates].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (state.settled.has(sourceId)) continue;
    examined += 1;
    const done = await applyCandidate(trx, run, sourceId, cand, state);
    if (!Object.keys(done).length) unchanged += 1; // its open line is on this run and is still right
    for (const key of Object.keys(ids)) if (done[key]) ids[key].push(done[key]);
    if (done.skip) result.skipped.push({ technicianId: cand.technicianId, kind: cand.kind, reason: done.skip });
    if (done.wait) result.waits.push({ technicianId: cand.technicianId, kind: cand.kind, sourceId, ...done.wait });
  }
  // No stay bonus can be looked for from a hire date that is not a calendar date. It has no milestone, so no key: the run
  // notes it at every sync until the date is corrected (waitNotes).
  for (const technicianId of state.unreadHire) result.waits.push({ technicianId, kind: STAY, sourceId: null, reason: 'hire_date_invalid', week: null });
  await saveWaits(trx, run, result.waits);
  Object.assign(result, { added: ids.added.length, updated: ids.updated.length, removed: ids.removed.length + dropped.length });
  // One event for every sync that examined a gift, also when it changed nothing (a finalize that checked the lines again and
  // found them right): the trail then tells a sync that ran from one that did not. A run that is dated for no gift and holds no
  // open line examines nothing and writes none, and so does a run whose gifts are all paid. A hire date the run could not read
  // is in the event too.
  if (examined || state.unreadHire.length) {
    await audit(trx, actorId, run, {
      added_line_ids: ids.added, updated_line_ids: ids.updated, removed_line_ids: ids.removed, unchanged_count: unchanged,
      skipped: result.skipped.map((s) => ({ technician_id: s.technicianId, kind: s.kind, reason: s.reason })),
      waits: result.waits.map(waitRow),
    });
  }
  return result;
}

/**
 * Plain notes for a run's summary: what waited at the run's latest sync and is not paid since, with the last pay date that can
 * carry it. A DRAFT run says why, e.g. "December gift for Sample Alpha waits: the week of Nov 2, 2026 is not paid yet. Only a
 * pay run dated Feb 16, 2027 or earlier can add it": its reasons are worked out again at every sync. A FINALIZED run is never
 * worked out again, so its reason would go out of date (a hire date entered since, a week paid since): it says only "December
 * gift for Sample Alpha was not on this pay run. Only a pay run dated Feb 16, 2027 or earlier can add it". The limit is a PAY
 * date (dueInRun), not today's date: a run dated inside it can still be worked out and finalized later, so the note states
 * the limit and never says what today allows. Read from the run row (saveWaits). No note with either gate off, for a gift
 * that is paid, or for a technician who gets no gift from any run now (left, no longer a field technician, or a hire date on
 * file that is after the gift date): an old run never says a gift waits that is paid or that no run will pay.
 * A gift whose line is open on another draft still shows here: it is not paid, and on this run it waited.
 */
async function waitNotes(conn, runId) {
  if (!payLinesOn() || !Object.keys(KIND_GATES).some(kindOn)) return [];
  const row = await conn('payroll_runs').where({ id: runId })
    .first('status', 'tech_rewards_waits', conn.raw("to_char(pay_date, 'YYYY-MM-DD') as pay_date"));
  // a stored wait is read only when its kind's gate is on and its whole source key is the sync's own (ownKeyOf)
  const keyOf = (w) => ownKeyOf({ technician_id: w.technician_id, kind: w.kind, source_type: SOURCE_TYPE, source_id: w.source_id });
  // a stay bonus that could not be looked for (a hire date on file that is not a calendar date) has no milestone and no key
  const dateless = (w) => w.kind === STAY && w.reason === 'hire_date_invalid' && w.source_id == null;
  const waits = (row && Array.isArray(row.tech_rewards_waits) ? row.tech_rewards_waits : [])
    .filter((w) => kindOn(w.kind) && KIND_WORDS[w.kind] && WAIT_WORDS[w.reason] && (keyOf(w) || dateless(w)));
  if (!waits.length) return [];
  // paid: a line the sync wrote (its whole source key is its own) that is no longer open. A hand-made row that holds the key
  // is not the sync's line, so its technician's note stays.
  const paid = new Set((await closedLines(conn).whereIn('source_id', waits.map((w) => w.source_id).filter(Boolean)))
    .filter((line) => ownKeyOf(line)).map((line) => line.source_id));
  // only for a technician who still gets a line (recipients): one who left since gets none from any run, so nothing waits
  const techs = new Map((await recipients(conn).whereIn('technicians.id', waits.map((w) => w.technician_id))
    .select([...techColumns(conn), 'technicians.name']))
    .map((tech) => [tech.id, readTech(tech)]));
  // { what, limit }: the words for the line and the last pay date that can carry it, or null when no run pays it now (a hire
  // date on file after the gift date; a hire date taken off, so no anniversary is known). A stay bonus also only while THIS
  // run is still dated for the milestone by the hire date on file (stayDueInRun): the reason was saved at the run's latest
  // sync, and a hire date corrected since can move the anniversary out of this run's pay dates. The saved reason is then no
  // reason of this run any more, so it is not shown beside a deadline of the new date. A stay bonus that could not be looked
  // for has no last pay date: its note shows on a draft only, and only while the date on file is still not a calendar date.
  const told = (w, tech) => {
    if (dateless(w)) return row.status === 'draft' && tech.hire_date_bad ? { what: KIND_WORDS[STAY], limit: null } : null;
    const { key } = keyOf(w);
    if (w.kind === GIFT) {
      const year = Number(key);
      return tech.hire_date && tech.hire_date > decemberGiftDate(year) ? null : { what: KIND_WORDS[GIFT], limit: lastPayDate(year) };
    }
    // a season bonus: none for a technician hired after the season (priceSeason), so no run says one waits
    if (w.kind === SEASON) {
      const year = Number(key);
      return tech.hire_date && tech.hire_date > calc.seasonWindow(year).end ? null : { what: `${KIND_WORDS[SEASON]} (${key})`, limit: seasonLastPayDate(year) };
    }
    const milestone = stayDueInRun(row.pay_date, tech.hire_date).some((due) => due.key === key) && stayMilestone(key, tech.hire_date);
    return milestone
      ? { what: `${KIND_WORDS[STAY]} (${key} ${key === '1' ? 'year' : 'years'})`, limit: addStaffWorkDays(milestone.dueDate, LOOKBACK_DAYS) }
      : null;
  };
  const notes = [];
  for (const w of waits) {
    const tech = techs.get(w.technician_id);
    const line = tech && !paid.has(w.source_id) ? told(w, tech) : null;
    if (line) {
      const state = row.status === 'draft' ? `waits: ${WAIT_WORDS[w.reason](w)}` : 'was not on this pay run';
      notes.push(`${line.what} for ${tech.name} ${state}${line.limit ? `. Only a pay run dated ${dayLabel(line.limit)} or earlier can add it` : ''}`);
    }
  }
  return notes.sort();
}

/**
 * The kind of a PAID line on another pay run that was worked out from a check of this finalized run ('stay_bonus',
 * 'season_bonus'), or null (counted_check_ids: the checks that put pay into a bonus's base, each one for a pay week its base
 * counts, kept on the line by the sync that priced it.
 * A check that was read and added nothing is not one, so it is voided as before;
 * finalize syncs first, so they are the checks the paid amount came from). payroll-runs.js voidRun asks it and refuses the void: the bonus would stay on its check, worked
 * out from pay that is gone. Voiding the run that paid the bonus first takes the bonus line off (dropRewardLinesOfWeek), and
 * the next run dated for it works it out again. The pay dates of the two runs do not matter: within a tax year the pay run's
 * own order usually refuses such a void already (laterFinalCheckExists), and this holds it across the year line and for pay
 * dates that are out of week order. It cannot lock two runs against each other: a counted check was final before the bonus
 * was paid, so the run that was finalized last can always be voided first. Not behind a gate: a paid bonus is protected with
 * the gate off too. One read, and no row while no such line is paid.
 */
async function paidBonusCounting(trx, run) {
  const found = await trx('payroll_pay_lines as b')
    .join('payroll_checks as bc', 'bc.id', 'b.check_id')
    .where({ 'b.status': 'paid', 'bc.status': 'finalized' })
    .whereNot('bc.run_id', run.id)
    .whereRaw("b.counted_check_ids && ARRAY(SELECT c.id FROM payroll_checks AS c WHERE c.run_id = ? AND c.status = 'finalized')", [run.id])
    .first('b.kind');
  return found ? found.kind : null;
}

module.exports = {
  SOURCE_TYPE,
  DECEMBER_GIFT_CENTS,
  decemberGiftDate,
  dueInRun,
  lastPayDate,
  spanOf,
  FIRST_STAY_DATE,
  stayDueInRun,
  staySpanOf,
  FIRST_SEASON_YEAR,
  seasonDueInRun,
  seasonSpanOf,
  seasonBonusPaidCents,
  readSeasonScores,
  readSeasonScoresOfRun,
  sourceIdOf,
  syncTechRewardLines,
  dropRewardLinesOfWeek,
  paidBonusCounting,
  HIRE_DATE_SQL,
  stayBonusStatus,
  waitNotes,
  oldestUnpaidWeek,
  unpaidHolidayShiftWeek,
};

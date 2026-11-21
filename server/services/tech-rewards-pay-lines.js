/**
 * Tech Rewards pay lines (Plan D5-5, owner rulings 2026-11-20): the pay run writes the December gift and the stay bonus as
 * open payroll pay lines (payroll-pay-lines.js). Each kind is dark behind its own gate, and both need GATE_PAYROLL_PAY_LINES:
 * GATE_TECH_REWARDS_PAY_LINES for the gift, GATE_TECH_REWARDS_STAY_BONUS for the stay bonus (KIND_GATES). The season bonus is
 * not written here yet. The text below describes the gift; THE STAY BONUS, at the end, says what differs. Nothing here invents
 * a rule; each one lives in one place:
 *
 *   who is a technician                         recipients() here: W-2, the technician role, and technician-eligibility.js
 *                                               applyAssignable (active, field dispatchable). An admin account gets none.
 *   the stay bonus milestones, rates and math   tech-rewards-calc.js stayBonusSchedule, stayBonus
 *   the 12 months of a stay bonus, and the pay  tech-rewards-scoreboard.js stayWindow, readStayPay (the board's own figures,
 *   a stay bonus is worked out from             so the board and the pay line never differ)
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
 * (no money on a guess), and so does one who has a December gift line this sync did not write (a row added by hand in the
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
 *   - WHICH RUN. Due from the anniversary (stayDueInRun, by the hire date on file; none on file, none due, and no note). No
 *     anniversary before FIRST_STAY_DATE has one. The key is the YEARS OF SERVICE ('stay_bonus:<technician id>:1'), not the
 *     date: a hire date corrected while the line is open moves the line, and one corrected after it is paid never pays the
 *     milestone again.
 *   - WHAT IT COVERS. The 12 months (staySpanOf), spread over their workweeks like every line that has a span, so it adds
 *     overtime premium to the weeks it covers.
 *   - THE AMOUNT is the rate times the pay earned in the 12 months on the FINALIZED checks of those pay weeks, as the board
 *     reads it (readStayPay). A check for a later pay week never counts. So it is written only when those checks are all
 *     final (priceStay): by a run for a week AFTER the last week of the 12 months, when every week of them that holds work
 *     has a finalized check. From then on every run works out the same amount. The line's note says the rate, the base and
 *     the period. An open line is worked out again at every sync; finalize pays what its own sync worked out, and a PAID
 *     line never changes.
 *   - A PAID stay bonus holds the pay runs it counted. The sync keeps the checks the amount was worked out from on the line
 *     (counted_check_ids), and a run that holds one of them cannot be voided before the run that paid the bonus
 *     (paidBonusCounting, in payroll-runs.js voidRun). A check of one of those pay weeks that is finalized AFTER the bonus
 *     was paid (an old week paid late) does not change the paid bonus: the office corrects that by voiding the run that paid
 *     it, which works it out again.
 *   - ONE GATE EACH. A kind's gate off takes that kind's open lines off and leaves the other kind's.
 */
const { recordAuditEvent } = require('./audit-log');
const calc = require('./tech-rewards-calc');
const { applyAssignable } = require('./technician-eligibility');
const {
  KIND_WORDS, TECH_REWARDS_SOURCE, techRewardsSourceId, techRewardsOwnKey, techRewardsOwnedSql,
} = require('./payroll-pay-lines');
const {
  payrollPayLinesLive, techRewardsPayLinesLive, techRewardsStayBonusLive, payrollTimeOffLive,
} = require('../config/feature-gates');
const { addStaffWorkDays, staffWeekStartForWorkDate } = require('../utils/staff-time-work-date');

// payroll-runs.js loads this file, so its helpers are read on first use.
const payrollRuns = () => require('./payroll-runs');
// The board is the one home of the pay a stay bonus is worked out from (readStayPay) and of its 12 months (stayWindow).
// It pulls in the score and review modules, so it loads on first use: a pay run that has no stay bonus to look at never reads it.
const scoreboard = () => require('./tech-rewards-scoreboard');

// The one home of the value is payroll-pay-lines.js, which pays these lines in their own week only (openLinesFor).
const SOURCE_TYPE = TECH_REWARDS_SOURCE;
const GIFT = 'december_gift';
const STAY = 'stay_bonus';
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
// A line is looked for in a run dated up to this many days after its due date: the first ready run writes it, and a gate turned
// on later does not reach back further.
const LOOKBACK_DAYS = 60;
const AUDIT_ACTION = 'payroll.tech_rewards_lines_synced';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The typeof guards keep a test mock of feature-gates that lacks a reader working (off).
const payLinesOn = () => typeof payrollPayLinesLive === 'function' && payrollPayLinesLive();
const techRewardsOn = () => typeof techRewardsPayLinesLive === 'function' && techRewardsPayLinesLive();
const stayBonusOn = () => typeof techRewardsStayBonusLive === 'function' && techRewardsStayBonusLive();
// Each kind has its own gate, and both need GATE_PAYROLL_PAY_LINES. A gate that is off takes only its own kind's open lines off.
const KIND_GATES = { [GIFT]: techRewardsOn, [STAY]: stayBonusOn };
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

/**
 * Who gets a Tech Rewards line, as a technicians query: a W-2 employee (pay lines are for W-2 employees) whose role is
 * technician (an admin account gets none, even one that takes field work) and who is active and takes field work
 * (technician-eligibility.js applyAssignable). A role that is not set is not a technician here: no money on a guess.
 */
const recipients = (trx) => applyAssignable(trx('technicians').where({ 'technicians.employment_type': 'w2', 'technicians.role': 'technician' }));

// ---- Readiness

/**
 * The oldest Monday-Sunday week in [coversFrom, coversTo] that a pay run still has to pay, or null. A week needs a check when it
 * has a weekly timesheet with minutes (what a check is worked out from), paid time off while the pay run pays time off
 * (GATE_PAYROLL_TIME_OFF; with it off a run ignores time off), or recorded work (the pay run's own test, payroll-runs.js
 * workedWeeks, which counts a shift that has no summary yet) that no approved timesheet settles. A week whose approved
 * timesheet has no minutes and that holds no payable time off gets no check from any run (evaluate), so it is settled: a gift
 * never waits for a check that cannot come. A week is paid when the technician has a FINALIZED check for it in a
 * finalized run. Whole weeks are asked, the weeks a line's overtime is priced from.
 */
async function oldestUnpaidWeek(trx, technicianId, { coversFrom, coversTo }) {
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
  const weeks = [...new Set([...withMinutes, ...worked, ...off.map((row) => row.week_start)])];
  if (!weeks.length) return null;
  const paid = new Set((await trx('payroll_checks as c')
    .join('payroll_runs as r', 'r.id', 'c.run_id')
    .where({ 'c.technician_id': technicianId, 'c.status': 'finalized', 'r.status': 'finalized' })
    .whereIn('c.week_start', weeks)
    .select(trx.raw("to_char(c.week_start, 'YYYY-MM-DD') AS week_start"))).map((row) => row.week_start));
  return weeks.filter((week) => !paid.has(week)).sort()[0] || null;
}

/**
 * Why the gift cannot go on this run for the technician, as { reason, week }, or null when it can:
 *   later_check_final   a later check of theirs in the tax year is already final: finalize refuses a run that holds a check
 *                       of theirs, so a gift here would hold the whole run (week is null)
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
async function spanWaitOf(trx, run, technicianId, span, amountCents) {
  if (await payrollRuns().laterFinalCheckExists(trx, run, [technicianId])) return { reason: 'later_check_final', week: null };
  const beforeRun = addStaffWorkDays(run.week_start, -1);
  const earlier = { coversFrom: span.coversFrom, coversTo: beforeRun };
  if (earlier.coversFrom <= earlier.coversTo) {
    const unpaid = await oldestUnpaidWeek(trx, technicianId, earlier);
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
  // No hire date on file: the run cannot tell whether they were hired by the gift date, and no money goes out on a guess. The
  // gift waits, with a note, until the date is entered.
  if (!tech.hire_date) return { wait: { reason: 'hire_date_missing', week: null } };
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
 * (tech-rewards-scoreboard.js readStayPay: the finalized checks, by the day the pay was earned; no Tech Rewards line and none
 * of the overtime one caused; no check for a later pay week), worked out by tech-rewards-calc.js stayBonus. So the bonus is
 * worked out only when those checks are all final, and it is the same on every run after that:
 *   pay_week_too_early  this run pays the last week of the 12 months or an earlier one. Its own check is not final, so the
 *                       pay of that week is not in the base yet: the run of a later week writes the bonus (week = that last week)
 *   (spanWaitOf)        later_check_final, week_not_paid, week_needs_review, as for the gift: every week from the start of
 *                       the 12 months to the day before the run's week that holds work has a finalized check
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
  const { cents: baseCents, checkIds } = await scoreboard().readStayPay(trx, tech.id, span.coversFrom, span.coversTo);
  const amountCents = baseCents > 0
    ? calc.stayBonus({ hireDate: tech.hire_date, asOf: milestone.dueDate, priorTwelveMonthsPayCents: baseCents }).cents
    : 0;
  if (!amountCents) return { wait: { reason: 'no_pay_on_file', week: null } };
  const noCheck = await checkWaitOf(trx, run, tech.id, { kind: STAY, amountCents });
  return noCheck ? { wait: noCheck } : { amountCents, span, note: stayNote(milestone, span, baseCents), countedCheckIds: checkIds };
}

const PRICE = { [GIFT]: priceGift, [STAY]: priceStay };
// A line of the kind that this sync did not write is on file for the technician: the reason the automatic line waits.
const OTHER_LINE = { [GIFT]: 'other_gift_line', [STAY]: 'other_stay_line' };

// ---- Sync

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
  hire_date_missing: () => 'their hire date is not on file, so the pay run cannot tell whether they were hired by the gift date',
  pay_week_too_early: (w) => (w.kind === STAY
    ? `the 12 months it is worked out from end in the week of ${dayLabel(w.week)}, and only a pay run for a later week can add it`
    : `this pay run pays an earlier week than the week of ${dayLabel(w.week)}, the last week the gift covers`),
  other_gift_line: () => 'a December gift line that the pay run did not write is already on file for them, so check that line first',
  other_stay_line: () => 'a stay bonus line that the pay run did not write is already on file for them, so check that line first',
  no_pay_on_file: () => 'no finalized paycheck holds pay of theirs for the 12 months it is worked out from',
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

// The technicians a run may write a line for (recipients), with their hire dates. A run dated for a gift reads all of them. Any
// other run reads only the ones a stay bonus is dated for and the ones whose stay bonus line is already open on it: most runs
// of the year read and lock no technician row. With lock the rows are read FOR SHARE, as payroll-family-employee.js
// familyExemptIds reads them: a change to one of these technicians waits for the pay run's transaction, so a finalize never
// pays a line the change took away. The stay bonus is looked for in a plain read first; only the locked rows are used after it.
async function loadTechs(trx, run, lock, giftDue, openHere) {
  const columns = ['technicians.id', trx.raw("to_char(technicians.hire_date, 'YYYY-MM-DD') as hire_date")];
  let ids = null;
  if (!giftDue.length) {
    const dated = kindOn(STAY)
      ? (await recipients(trx).whereNotNull('technicians.hire_date').select(columns))
        .filter((row) => stayDueInRun(run.pay_date, row.hire_date).length)
      : [];
    ids = [...new Set([...dated.map((row) => row.id), ...openHere.filter((line) => line.kind === STAY).map((line) => line.technician_id)])];
    if (!ids.length) return [];
  }
  const query = recipients(trx).orderBy('technicians.id').select(columns);
  if (ids) query.whereIn('technicians.id', ids);
  if (lock) query.forShare();
  return query;
}

// Everything this run could write or change: the lines due by its pay date for every technician, plus the open Tech Rewards
// lines already written for this week (a recompute). An open line of another week is read so a ready run can take it.
async function loadState(trx, run, lock) {
  const openQuery = trx('payroll_pay_lines').where({ source_type: SOURCE_TYPE, status: 'open' }).select(lineColumns(trx));
  if (lock) openQuery.forUpdate();
  const allOpen = await openQuery;
  const closed = await trx('payroll_pay_lines').where({ source_type: SOURCE_TYPE }).whereNot({ status: 'open' })
    .select('technician_id', 'kind', 'source_type', 'source_id');
  // Only a line whose WHOLE source key is the sync's own (ownKeyOf) is treated as a line the sync wrote. A row with the Tech
  // Rewards source type and any other source id (another technician's key, no year) is a row somebody put in the database by
  // hand. The sync never matches it to a candidate, never changes it, and never writes the line whose key it holds: that
  // candidate waits (OTHER_LINE), so the unique source key cannot fail the pay run.
  const ownOpen = allOpen.filter((line) => ownKeyOf(line));
  const foreignKeys = new Set([...allOpen, ...closed].filter((line) => !ownKeyOf(line)).map((line) => line.source_id));
  const openHere = ownOpen.filter((line) => line.earned_week_start === run.week_start);
  // paid (or voided) lines are evidence: their keys are never read or written again
  const settled = new Set(closed.filter((line) => ownKeyOf(line)).map((line) => line.source_id));
  // What the run's pay date is for. The gift is the same for every technician; a stay bonus depends on the hire date.
  const giftDue = kindOn(GIFT) ? dueInRun(run.pay_date) : [];
  const techs = await loadTechs(trx, run, lock, giftDue, openHere);
  const techById = new Map(techs.map((row) => [row.id, row]));
  const candidates = new Map();
  for (const tech of techs) {
    const due = [...giftDue, ...(kindOn(STAY) ? stayDueInRun(run.pay_date, tech.hire_date) : [])];
    for (const { kind, key } of due) {
      candidates.set(sourceIdOf(kind, tech.id, key), { kind, key, technicianId: tech.id, due: true });
    }
  }
  // An open line of this week whose technician is not a recipient now, or that the run is no longer dated for. `due` says
  // which of the two took the line off, for the audit event. A gift is due by the run's pay date alone, whoever the
  // technician is. A stay bonus is due by the hire date: a recipient who is read and has no candidate is not due here, and
  // one who is not read is no longer a recipient (applyCandidate, not_active).
  const giftKeys = new Set(giftDue.map((d) => d.key));
  for (const line of openHere) {
    const own = ownKeyOf(line);
    if (own && !candidates.has(line.source_id)) {
      candidates.set(line.source_id, {
        kind: line.kind, key: own.key, technicianId: line.technician_id,
        due: line.kind === GIFT ? giftKeys.has(own.key) : !techById.has(line.technician_id),
      });
    }
  }
  // A line of a kind the run is dated for that this sync did not write: its whole source key is not the sync's own (ownKeyOf),
  // whatever its source type says. No code path makes one (the add form and its route offer the four manual kinds only, with
  // no source), so it is a row somebody put in the database by hand: that technician's automatic line of the kind is held for
  // review, and never paid beside it. Any key, open or paid; a voided row does not count. One small read: a technician has one
  // gift line a year and three stay bonus lines in all.
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
  let priced;
  if (!cand.due) priced = { skip: 'not_due_in_this_run' };
  else if (!tech) priced = { skip: 'not_active' };
  else if (state.handMade.has(`${cand.kind}:${cand.technicianId}`) || state.foreignKeys.has(sourceId)) priced = { wait: { reason: OTHER_LINE[cand.kind], week: null } };
  else priced = await PRICE[cand.kind](trx, cand, tech, run);
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
 * Makes the open Tech Rewards pay lines match the plan, for the pay run `run` ({ id, week_start, pay_date } as
 * payroll-runs.js loadRun reads it). Take it inside the pay run's transaction, after the payroll lock and before the run is
 * worked out. Pay lines off: no pay line is read or written. A kind's gate off: its open lines are removed and none is written.
 * With pay lines off, or every kind's gate off, the run's stored waits are cleared. Never blocks a check.
 * Returns { added, updated, removed, skipped: [{ technicianId, kind, reason }], waits: [{ technicianId, kind, sourceId, reason, week }] }.
 */
async function syncTechRewardLines(run, trx, { lock = true, actorId = null } = {}) {
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
  const state = await loadState(trx, run, lock);
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
  await saveWaits(trx, run, result.waits);
  Object.assign(result, { added: ids.added.length, updated: ids.updated.length, removed: ids.removed.length + dropped.length });
  // One event for every sync that examined a gift, also when it changed nothing (a finalize that checked the lines again and
  // found them right): the trail then tells a sync that ran from one that did not. A run that is dated for no gift and holds no
  // open line examines nothing and writes none, and so does a run whose gifts are all paid.
  if (examined) {
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
  const row = await conn('payroll_runs').where({ id: runId }).first('status', 'tech_rewards_waits');
  // a stored wait is read only when its kind's gate is on and its whole source key is the sync's own (ownKeyOf)
  const keyOf = (w) => ownKeyOf({ technician_id: w.technician_id, kind: w.kind, source_type: SOURCE_TYPE, source_id: w.source_id });
  const waits = (row && Array.isArray(row.tech_rewards_waits) ? row.tech_rewards_waits : [])
    .filter((w) => kindOn(w.kind) && KIND_WORDS[w.kind] && WAIT_WORDS[w.reason] && keyOf(w));
  if (!waits.length) return [];
  // paid: a line the sync wrote (its whole source key is its own) that is no longer open. A hand-made row that holds the key
  // is not the sync's line, so its technician's note stays.
  const paid = new Set((await conn('payroll_pay_lines').where({ source_type: SOURCE_TYPE }).whereNot({ status: 'open' })
    .whereIn('source_id', waits.map((w) => w.source_id)).select('technician_id', 'kind', 'source_type', 'source_id'))
    .filter((line) => ownKeyOf(line)).map((line) => line.source_id));
  // only for a technician who still gets a line (recipients): one who left since gets none from any run, so nothing waits
  const techs = new Map((await recipients(conn).whereIn('technicians.id', waits.map((w) => w.technician_id))
    .select('technicians.id', 'technicians.name', conn.raw("to_char(technicians.hire_date, 'YYYY-MM-DD') as hire_date")))
    .map((tech) => [tech.id, tech]));
  // { what, limit }: the words for the line and the last pay date that can carry it, or null when no run pays it now (a hire
  // date on file after the gift date; a hire date taken off, so no anniversary is known)
  const told = (w, tech) => {
    const { key } = keyOf(w);
    if (w.kind === GIFT) {
      const year = Number(key);
      return tech.hire_date && tech.hire_date > decemberGiftDate(year) ? null : { what: KIND_WORDS[GIFT], limit: lastPayDate(year) };
    }
    const milestone = stayMilestone(key, tech.hire_date);
    return milestone && milestone.dueDate >= FIRST_STAY_DATE
      ? { what: `${KIND_WORDS[STAY]} (${key} ${key === '1' ? 'year' : 'years'})`, limit: addStaffWorkDays(milestone.dueDate, LOOKBACK_DAYS) }
      : null;
  };
  const notes = [];
  for (const w of waits) {
    const tech = techs.get(w.technician_id);
    const line = tech && !paid.has(w.source_id) ? told(w, tech) : null;
    if (line) {
      const state = row.status === 'draft' ? `waits: ${WAIT_WORDS[w.reason](w)}` : 'was not on this pay run';
      notes.push(`${line.what} for ${tech.name} ${state}. Only a pay run dated ${dayLabel(line.limit)} or earlier can add it`);
    }
  }
  return notes.sort();
}

/**
 * True when a PAID line on another pay run was worked out from a check of this finalized run (counted_check_ids: the checks
 * priceStay read for a stay bonus, each one for a pay week of its 12 months, kept on the line by the sync that priced it;
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
    .first('b.id');
  return Boolean(found);
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
  sourceIdOf,
  syncTechRewardLines,
  dropRewardLinesOfWeek,
  paidBonusCounting,
  waitNotes,
};

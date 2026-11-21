/**
 * Tech Rewards pay lines (Plan D5-5, owner rulings 2026-11-20): the pay run writes the December gift as an open payroll pay
 * line (payroll-pay-lines.js), dark behind GATE_TECH_REWARDS_PAY_LINES (which needs GATE_PAYROLL_PAY_LINES). The season bonus
 * and the stay bonus are not written here yet. Nothing here invents a rule; each one lives in one place:
 *
 *   who is a technician                         recipients() here: W-2, the technician role, and technician-eligibility.js
 *                                               applyAssignable (active, field dispatchable). An admin account gets none.
 *   which days hold recorded work               payroll-runs.js workedDates (the test the pay run itself uses)
 *   which covered week would hold a pay run     payroll-runs.js lineGuardWeek (the two guards a run applies to every pay line)
 *   whether a check can be worked out at all    payroll-runs.js lineOnlyCheckProblem (buildCheck, the pay run's own builder)
 *   whether a later check is already final      payroll-runs.js laterFinalCheckExists (the guard finalize applies to a run)
 *   pay lines, open -> paid on finalize         payroll-pay-lines.js; overtime on a line = payroll-regular-rate.js
 *
 * syncTechRewardLines runs where syncCommissionLines does (payroll-runs.js: draft, recompute and finalize, under the payroll
 * lock), after a due pay rate step is applied and before the run is worked out. The lines are derived data.
 *
 * WHICH RUN. By the run's PAY DATE (the date on its checks). The gift is due the last Friday on or before Dec 20. The FIRST run
 * dated on or after that day, up to 60 days after it, that is ready for a technician writes their line; a run that is not ready
 * writes nothing for them and the next run tries again. The line is $300 (owner 2026-11-20), source_type 'tech_rewards', source
 * key 'december_gift:<technician id>:<year>' (the table's unique key stops a repeat in any status), and covers Jan 1 of the
 * year to the end of the run's pay week (Dec 31 at the latest): payroll_pay_lines refuses a line that covers days after the week
 * that pays it. The span is spread over its workweeks by payroll-regular-rate.js (29 CFR 778.209), so the gift adds overtime
 * premium to the weeks it covers. It is included in the regular rate on purpose, the conservative reading: whether the
 * 29 CFR 778.212 gift exclusion applies is a question for the employment lawyer / CPA, not decided here.
 *
 * OWNERSHIP. An OPEN Tech Rewards line always belongs to a DRAFT run: its earned week is that run's week, and only that run pays
 * it (payroll-pay-lines.js openLinesFor). Three things keep that true:
 *   - voiding a run deletes its lines, open or reopened from paid (payroll-runs.js voidRun, dropRewardLinesOfWeek);
 *   - finalizing a run deletes any of its lines it did not pay (finalizeRun, the same call);
 *   - a sync claims a line open in another week, unless that week has a draft run that pays first (the earlier pay date; the
 *     earlier week on the same date) and can still pay it (ownerKeeps asks that run's own readiness);
 *   - a run that is finalized BEFORE an earlier-dated draft takes that draft's lines for the technicians it pays
 *     (claimBeforeFinal): its checks close the earlier draft to those technicians for the tax year, so the line could never
 *     be paid there. The finalize then asks for a review of the changed numbers (the pay run's own token check).
 * So the gift is on the first check that can carry it and no line is stranded.
 * A recompute works an OPEN line out again; a PAID line is never read or changed. Gate off: every open Tech Rewards line comes
 * off at the next sync (the kill switch) and paid lines stay. Pay lines off: nothing is read or written.
 *
 * READINESS. A sync NEVER blocks a check or holds a run. A technician who cannot get the gift at all is skipped with a reason
 * in the audit event and no note: hired after the gift date, or the run's week ended before Jan 1 of the gift year. A
 * technician who can get it but not on this run WAITS (waitOf): a later check of theirs in the tax year is already final, so
 * finalize would refuse a run that holds a check of theirs (laterFinalCheckExists); or an earlier week of the year holds work (a
 * weekly timesheet with minutes, recorded work by workedDates, or paid time off) and has no FINALIZED check; or the pay run's own
 * line guards would hold a check for the span (lineGuardWeek: a worked week with no approved timesheet, an automatic clock-out
 * nobody reviewed); or no check can be worked out for them on this run at all (lineOnlyCheckProblem: no pay rate, a rate under
 * the minimum wage). The technician rows are read FOR SHARE under the pay run's lock, so a change to a technician's status,
 * field work or hire date waits for the pay run's transaction and a finalize never pays a gift that change took away.
 * No line is written, the run row keeps what waits (payroll_runs.tech_rewards_waits, replaced by every sync), the run view lists
 * it (techRewardsNotes, waitNotes), and the next run claims it.
 *
 * Every skip, wait and change is recorded in one audit event per sync (payroll.tech_rewards_lines_synced): technician ids, kinds,
 * reason codes, weeks and line ids, never an amount. Money is integer cents.
 */
const { recordAuditEvent } = require('./audit-log');
const { applyAssignable } = require('./technician-eligibility');
const { KIND_WORDS } = require('./payroll-pay-lines');
const { payrollPayLinesLive, techRewardsPayLinesLive } = require('../config/feature-gates');
const { addStaffWorkDays, staffWeekStartForWorkDate } = require('../utils/staff-time-work-date');
const { etDateString } = require('../utils/datetime-et');

// payroll-runs.js loads this file, so its helpers are read on first use.
const payrollRuns = () => require('./payroll-runs');

const SOURCE_TYPE = 'tech_rewards';
const GIFT = 'december_gift';
// The December gift: $300 per technician (owner 2026-11-20), due the last Friday on or before this day of December.
// A constant, not a tech_reward_settings value: that table is versioned score weights and cut lines only.
const DECEMBER_GIFT_CENTS = 30000;
const DECEMBER_GIFT_DAY = 20;
const FRIDAY = 5;
// A line is looked for in a run dated up to this many days after its due date: the first ready run writes it, and a gate turned
// on later does not reach back further.
const LOOKBACK_DAYS = 60;
const AUDIT_ACTION = 'payroll.tech_rewards_lines_synced';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SOURCE_ID_RE = new RegExp(`^(${GIFT}):(${UUID}):(\\d{4})$`, 'i');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The typeof guards keep a test mock of feature-gates that lacks a reader working (off).
const payLinesOn = () => typeof payrollPayLinesLive === 'function' && payrollPayLinesLive();
const techRewardsOn = () => typeof techRewardsPayLinesLive === 'function' && techRewardsPayLinesLive();

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (year, month, day) => `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
const yearOf = (date) => Number(date.slice(0, 4));
const dayLabel = (date) => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}, ${date.slice(0, 4)}`;

// ---- Dates (pure)

/** The last Friday on or before Dec 20 of the year (ET calendar date). */
function decemberGiftDate(year) {
  const dow = new Date(Date.UTC(year, 11, DECEMBER_GIFT_DAY)).getUTCDay();
  return addStaffWorkDays(ymd(year, 12, DECEMBER_GIFT_DAY), -((dow - FRIDAY + 7) % 7));
}

/**
 * What the gift of `key` (the year, as text) covers when the run of the pay week starting `weekStart` pays it. Pure.
 * { earnedWeekStart, coversFrom, coversTo } for the pay line: Jan 1 to the end of the pay week, Dec 31 at the latest.
 */
function spanOf(key, weekStart) {
  const weekEnd = addStaffWorkDays(weekStart, 6);
  const dec31 = ymd(Number(key), 12, 31);
  return { earnedWeekStart: weekStart, coversFrom: ymd(Number(key), 1, 1), coversTo: weekEnd < dec31 ? weekEnd : dec31 };
}

/**
 * The lines a run dated `payDate` may write for a technician: [{ kind, key }]. Pure. The gift is due from its date (the last
 * Friday on or before Dec 20) to LOOKBACK_DAYS after it, so a run early in January can still carry last year's.
 */
function dueInRun(payDate) {
  const due = [];
  for (const year of [yearOf(payDate) - 1, yearOf(payDate)]) {
    if (decemberGiftDate(year) <= payDate && payDate <= lastPayDate(year)) due.push({ kind: GIFT, key: String(year) });
  }
  return due;
}

const sourceIdOf = (kind, technicianId, key) => `${kind}:${technicianId}:${key}`;

/** The last pay date a run can carry the gift of `year` on: LOOKBACK_DAYS after the gift date. Pure. */
const lastPayDate = (year) => addStaffWorkDays(decemberGiftDate(year), LOOKBACK_DAYS);

/**
 * Who gets a Tech Rewards line, as a technicians query: a W-2 employee (pay lines are for W-2 employees) whose role is
 * technician (an admin account gets none, even one that takes field work) and who is active and takes field work
 * (technician-eligibility.js applyAssignable). A role that is not set is not a technician here: no money on a guess.
 */
const recipients = (trx) => applyAssignable(trx('technicians').where({ 'technicians.employment_type': 'w2', 'technicians.role': 'technician' }));

// ---- Readiness

/**
 * The oldest Monday-Sunday week in [coversFrom, coversTo] that a pay run still has to pay, or null. A week needs a check when it
 * has a weekly timesheet with minutes (what a check is worked out from), paid time off, or recorded work (the pay run's own
 * test, payroll-runs.js workedDates, which counts a shift that has no summary yet) that no approved timesheet settles. A week
 * whose approved timesheet has no minutes and that holds no time off gets no check from any run (evaluate), so it is settled:
 * a gift never waits for a check that cannot come. A week is paid when the technician has a FINALIZED check for it in a
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
  const worked = (await payrollRuns().workedDates(trx, technicianId, from, to)).map(staffWeekStartForWorkDate)
    .filter((week) => !approved.has(week));
  const off = await trx('payroll_time_off')
    .where({ technician_id: technicianId }).where('work_date', '>=', from).where('work_date', '<=', to).where('minutes', '>', 0)
    .select(trx.raw("to_char(work_date, 'YYYY-MM-DD') AS work_date"));
  const weeks = [...new Set([...withMinutes, ...worked, ...off.map((row) => staffWeekStartForWorkDate(row.work_date))])];
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
 *   week_not_paid       an earlier week of its span holds work and has no finalized check
 *   week_needs_review   the pay run's own line guards would hold a check for an earlier week of its span
 *   no_paycheck         no check can be worked out for the technician on this run (week is null)
 * The unpaid test asks only the weeks before the run's own: the span ends in the run's own week by design (spanOf), and that
 * week is the one this run pays. The line guards are asked for the WHOLE span, the run's own week too, exactly as the run asks
 * them of the line (evaluate): a technician who has no check on this run otherwise (an approved timesheet with no minutes) and
 * an automatic clock-out nobody reviewed in that week would get a check the run must hold. A line that passes never makes the
 * run wait, hold a check or block.
 */
async function waitOf(trx, run, technicianId, span) {
  if (await payrollRuns().laterFinalCheckExists(trx, run, [technicianId])) return { reason: 'later_check_final', week: null };
  const beforeRun = addStaffWorkDays(run.week_start, -1);
  const earlier = { coversFrom: span.coversFrom, coversTo: beforeRun < span.coversTo ? beforeRun : span.coversTo };
  if (earlier.coversFrom <= earlier.coversTo) {
    const unpaid = await oldestUnpaidWeek(trx, technicianId, earlier);
    if (unpaid) return { reason: 'week_not_paid', week: unpaid };
  }
  const guarded = await payrollRuns().lineGuardWeek(trx, technicianId, {
    amountCents: DECEMBER_GIFT_CENTS, earnedWeekStart: run.week_start, coversFrom: span.coversFrom, coversTo: span.coversTo,
  });
  if (guarded) return { reason: 'week_needs_review', week: guarded };
  const problem = await payrollRuns().lineOnlyCheckProblem(trx, run, technicianId, { kind: GIFT, amountCents: DECEMBER_GIFT_CENTS });
  return problem ? { reason: 'no_paycheck', week: null } : null;
}

/** { amountCents }, { skip: reason } (no gift for them) or { wait: { reason, week } } (not on this run) for one candidate. */
async function priceCandidate(trx, cand, tech, run) {
  const year = Number(cand.key);
  if (tech.hire_date && tech.hire_date > decemberGiftDate(year)) return { skip: 'hired_after_gift_date' };
  // a run for a week that ended before Jan 1 of the gift year (an old week paid late) has no day of the year to cover
  if (run.week_start < addStaffWorkDays(ymd(year, 1, 1), -6)) return { skip: 'pay_week_before_gift_year' };
  const wait = await waitOf(trx, run, tech.id, spanOf(cand.key, run.week_start));
  return wait ? { wait } : { amountCents: DECEMBER_GIFT_CENTS };
}

// ---- Sync

const lineColumns = (trx) => ['id', 'technician_id', 'kind', 'status', 'amount_cents', 'source_id',
  trx.raw("to_char(earned_week_start, 'YYYY-MM-DD') as earned_week_start"),
  trx.raw("to_char(covers_from, 'YYYY-MM-DD') as covers_from"),
  trx.raw("to_char(covers_to, 'YYYY-MM-DD') as covers_to")];

// ids, kinds, reason codes and weeks only, never an amount (the audit event and the run row)
const waitRow = (w) => ({ technician_id: w.technicianId, kind: w.kind, source_id: w.sourceId, reason: w.reason, week: w.week });

const WAIT_WORDS = {
  week_not_paid: (w) => `the week of ${dayLabel(w.week)} is not paid yet`,
  week_needs_review: (w) => `the week of ${dayLabel(w.week)} has a timesheet to approve or an automatic clock-out to review`,
  no_paycheck: () => 'no paycheck can be worked out for them on this pay run (check the pay rate)',
  later_check_final: () => 'a later paycheck of theirs is already final, so this pay run cannot hold one for them',
};

/** What waits as of this sync, kept on the draft run's row and replaced by every sync with the gate on. */
async function saveWaits(trx, run, waits) {
  await trx('payroll_runs').where({ id: run.id, status: 'draft' })
    .update({ tech_rewards_waits: waits.length ? JSON.stringify(waits.map(waitRow)) : null });
}

async function audit(trx, actorId, run, metadata) {
  await recordAuditEvent({
    trx, critical: true, actor_type: 'admin', actor_id: actorId,
    action: AUDIT_ACTION, resource_type: 'payroll_pay_lines', resource_id: null,
    metadata: { run_id: run.id, week_start: run.week_start, ...metadata },
  });
}

/** Gate off: every open Tech Rewards line comes off. Paid lines stay. Returns the ids removed. */
async function dropOpenLines(trx, lock) {
  const query = trx('payroll_pay_lines').where({ source_type: SOURCE_TYPE, status: 'open' }).select('id');
  if (lock) query.forUpdate();
  const ids = (await query).map((row) => row.id);
  if (ids.length) await trx('payroll_pay_lines').whereIn('id', ids).del();
  return ids;
}

/**
 * Deletes the OPEN Tech Rewards lines of one pay week. A voided run takes its lines with it (call it after payroll-pay-lines.js
 * reopenLinesOfRun, so the paid ones are open again), and a finalized run keeps none it did not pay (call it after
 * markLinesPaid). The next run dated for a deleted line writes it again. Returns the ids removed, for the caller's audit event.
 */
async function dropRewardLinesOfWeek(trx, weekStart) {
  const rows = await trx('payroll_pay_lines').where({ source_type: SOURCE_TYPE, status: 'open', earned_week_start: weekStart })
    .del().returning('id');
  return rows.map((row) => (row && row.id ? row.id : row));
}

// Everything this run could write or change: the lines due by its pay date for every technician, plus the open Tech Rewards
// lines already written for this week (a recompute). An open line of another week is read only to see who owns the key.
async function loadState(trx, run, lock) {
  const openQuery = trx('payroll_pay_lines').where({ source_type: SOURCE_TYPE, status: 'open' }).select(lineColumns(trx));
  if (lock) openQuery.forUpdate();
  const allOpen = await openQuery;
  const openHere = allOpen.filter((line) => line.earned_week_start === run.week_start);
  const otherWeeks = [...new Set(allOpen.map((line) => line.earned_week_start).filter((week) => week !== run.week_start))];
  // the DRAFT run of each of those weeks, as loadRun reads it: week -> { id, week_start, pay_date } (one live run a week:
  // payroll_runs_one_live_week)
  const draftRuns = new Map(otherWeeks.length
    ? (await trx('payroll_runs').whereIn('week_start', otherWeeks).where({ status: 'draft' })
      .select('id', trx.raw("to_char(week_start, 'YYYY-MM-DD') AS week_start"), trx.raw("to_char(pay_date, 'YYYY-MM-DD') AS pay_date")))
      .map((row) => [row.week_start, row])
    : []);
  // paid (or voided) lines are evidence: their keys are never read or written again
  const settled = new Set((await trx('payroll_pay_lines').where({ source_type: SOURCE_TYPE }).whereNot({ status: 'open' })
    .select('source_id')).map((row) => row.source_id));
  // The technicians who get a line (recipients). With lock the rows are read FOR SHARE, as payroll-family-employee.js
  // familyExemptIds reads them: a change to one of these technicians waits for the pay run's transaction, so a finalize never
  // pays a gift the change took away.
  const techQuery = recipients(trx)
    .orderBy('technicians.id')
    .select('technicians.id', trx.raw("to_char(technicians.hire_date, 'YYYY-MM-DD') as hire_date"));
  if (lock) techQuery.forShare();
  const techs = await techQuery;
  const candidates = new Map();
  for (const tech of techs) {
    for (const { kind, key } of dueInRun(run.pay_date)) {
      candidates.set(sourceIdOf(kind, tech.id, key), { kind, key, technicianId: tech.id, due: true });
    }
  }
  for (const line of openHere) {
    const match = SOURCE_ID_RE.exec(line.source_id || '');
    const own = match && match[1] === line.kind && match[2].toLowerCase() === line.technician_id.toLowerCase();
    if (own && !candidates.has(line.source_id)) {
      candidates.set(line.source_id, { kind: line.kind, key: match[3], technicianId: line.technician_id, due: false });
    }
  }
  return {
    candidates,
    techById: new Map(techs.map((row) => [row.id, row])),
    settled,
    openBySource: new Map(allOpen.map((line) => [line.source_id, line])),
    draftRuns,
  };
}

// True when the draft run `owner` puts its checks out before `run` does: the earlier pay date, or the earlier week on the same
// date.
const paysFirst = (owner, run) => owner.pay_date < run.pay_date
  || (owner.pay_date === run.pay_date && owner.week_start < run.week_start);

/**
 * True when a line open in another pay week stays there: that week has a DRAFT run that pays before `run` does and can still
 * pay the line (it is dated for it, and ready by the test it applies to itself: priceCandidate). A week with no draft run
 * (finalized, voided, never drafted) never keeps a line, and neither does a draft that could no longer pay it: a pay rate
 * corrected since, a later check that went final. So a line is never held back for a run that will not pay it.
 */
async function ownerKeeps(trx, run, open, cand, tech, state) {
  const owner = state.draftRuns.get(open.earned_week_start);
  if (!owner || !paysFirst(owner, run)) return false;
  if (!tech) return true; // the technician left: nobody claims it, and the owner's next sync takes it off
  if (!dueInRun(owner.pay_date).some((due) => due.kind === cand.kind && due.key === cand.key)) return false;
  return Boolean((await priceCandidate(trx, cand, tech, owner)).amountCents);
}

const changed = (open, span, amountCents) => Number(open.amount_cents) !== amountCents
  || open.covers_from !== span.coversFrom || open.covers_to !== span.coversTo;

// An open line gets the pay week, the span and the amount of the run that pays it now.
const moveLine = (trx, id, span, amountCents) => trx('payroll_pay_lines').where({ id, status: 'open' }).update({
  amount_cents: amountCents, earned_week_start: span.earnedWeekStart, covers_from: span.coversFrom, covers_to: span.coversTo,
  updated_at: trx.fn.now(),
});

/**
 * Writes one candidate's line: insert, work out again, claim or remove. Returns { added, updated, removed, skip, wait } (ids /
 * reason / { reason, week }). A line open in another pay week stays that week's while that week's DRAFT run pays first and
 * can still pay it (ownerKeeps); otherwise this run, when dated for it and ready, claims it. An open line of this week that the
 * run is no longer dated for, or no longer ready to pay, comes off.
 */
async function applyCandidate(trx, run, sourceId, cand, state) {
  const open = state.openBySource.get(sourceId);
  const here = Boolean(open) && open.earned_week_start === run.week_start;
  const tech = state.techById.get(cand.technicianId);
  if (open && !here && (!cand.due || await ownerKeeps(trx, run, open, cand, tech, state))) return {};
  let priced;
  if (!cand.due) priced = { skip: 'not_due_in_this_run' };
  else priced = tech ? await priceCandidate(trx, cand, tech, run) : { skip: 'not_active' };
  if (priced.skip || priced.wait) {
    if (here) await trx('payroll_pay_lines').where({ id: open.id }).del();
    return { skip: priced.skip, wait: priced.wait, removed: here ? open.id : null };
  }
  const span = spanOf(cand.key, run.week_start);
  if (open) {
    if (here && !changed(open, span, priced.amountCents)) return {};
    await moveLine(trx, open.id, span, priced.amountCents);
    return { updated: open.id };
  }
  const [inserted] = await trx('payroll_pay_lines').insert({
    technician_id: cand.technicianId,
    kind: cand.kind,
    amount_cents: priced.amountCents,
    earned_week_start: span.earnedWeekStart,
    covers_from: span.coversFrom,
    covers_to: span.coversTo,
    source_type: SOURCE_TYPE,
    source_id: sourceId,
  }).returning('id');
  return { added: inserted && inserted.id ? inserted.id : inserted };
}

/**
 * Makes the open Tech Rewards pay lines match the plan, for the pay run `run` ({ id, week_start, pay_date } as
 * payroll-runs.js loadRun reads it). Take it inside the pay run's transaction, after the payroll lock and before the run is
 * worked out. Pay lines off: nothing. Gate off: only removes open Tech Rewards lines. Never blocks a check.
 * Returns { added, updated, removed, skipped: [{ technicianId, kind, reason }], waits: [{ technicianId, kind, sourceId, reason, week }] }.
 */
async function syncTechRewardLines(run, trx, { lock = true, actorId = null } = {}) {
  const result = { added: 0, updated: 0, removed: 0, skipped: [], waits: [] };
  if (!payLinesOn()) return result;
  if (!techRewardsOn()) {
    const dropped = await dropOpenLines(trx, lock);
    if (dropped.length) await audit(trx, actorId, run, { gate: 'off', removed_count: dropped.length, removed_line_ids: dropped });
    return { ...result, removed: dropped.length };
  }
  const state = await loadState(trx, run, lock);
  const ids = { added: [], updated: [], removed: [] };
  for (const [sourceId, cand] of [...state.candidates].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (state.settled.has(sourceId)) continue;
    const done = await applyCandidate(trx, run, sourceId, cand, state);
    for (const key of Object.keys(ids)) if (done[key]) ids[key].push(done[key]);
    if (done.skip) result.skipped.push({ technicianId: cand.technicianId, kind: cand.kind, reason: done.skip });
    if (done.wait) result.waits.push({ technicianId: cand.technicianId, kind: cand.kind, sourceId, ...done.wait });
  }
  await saveWaits(trx, run, result.waits);
  Object.assign(result, { added: ids.added.length, updated: ids.updated.length, removed: ids.removed.length });
  if (ids.added.length || ids.updated.length || ids.removed.length || result.skipped.length || result.waits.length) {
    await audit(trx, actorId, run, {
      added_line_ids: ids.added, updated_line_ids: ids.updated, removed_line_ids: ids.removed,
      skipped: result.skipped.map((s) => ({ technician_id: s.technicianId, kind: s.kind, reason: s.reason })),
      waits: result.waits.map(waitRow),
    });
  }
  return result;
}

/**
 * Finalize only (payroll-runs.js finalizeRun, after the run is worked out and before its checks are stored). A check that goes
 * final closes every earlier-dated run of the same tax year to its technician (payroll-runs.js laterFinalCheckExists), so a
 * Tech Rewards line that an earlier-dated DRAFT still holds for one of `technicianIds` (the technicians this run pays) could
 * never be paid there once this run is final. Each such line that this run is dated for and ready to pay moves here. Returns
 * the ids moved: the caller works the run out again, and its token check sends the changed numbers back for review, so nothing
 * is paid that the office did not see. An owner dated in another tax year, or one that pays later, keeps its line.
 */
async function claimBeforeFinal(run, trx, technicianIds, { actorId = null } = {}) {
  if (!payLinesOn() || !techRewardsOn() || !technicianIds.length) return [];
  const lines = await trx('payroll_pay_lines').where({ source_type: SOURCE_TYPE, status: 'open' })
    .whereIn('technician_id', technicianIds).whereNot({ earned_week_start: run.week_start })
    .orderBy('source_id').forUpdate().select(lineColumns(trx));
  if (!lines.length) return [];
  const owners = new Map((await trx('payroll_runs').whereIn('week_start', lines.map((line) => line.earned_week_start)).where({ status: 'draft' })
    .select(trx.raw("to_char(week_start, 'YYYY-MM-DD') AS week_start"), trx.raw("to_char(pay_date, 'YYYY-MM-DD') AS pay_date")))
    .map((row) => [row.week_start, row]));
  const techs = new Map((await recipients(trx)
    .whereIn('technicians.id', lines.map((line) => line.technician_id)).forShare()
    .select('technicians.id', trx.raw("to_char(technicians.hire_date, 'YYYY-MM-DD') as hire_date"))).map((row) => [row.id, row]));
  const due = dueInRun(run.pay_date);
  const moved = [];
  for (const line of lines) {
    const owner = owners.get(line.earned_week_start);
    const match = SOURCE_ID_RE.exec(line.source_id || '');
    const tech = techs.get(line.technician_id);
    const closes = owner && paysFirst(owner, run) && yearOf(owner.pay_date) === yearOf(run.pay_date);
    if (!closes || !match || !tech || !due.some((d) => d.kind === line.kind && d.key === match[3])) continue;
    const cand = { kind: line.kind, key: match[3], technicianId: line.technician_id };
    const priced = await priceCandidate(trx, cand, tech, run);
    if (!priced.amountCents) continue;
    await moveLine(trx, line.id, spanOf(cand.key, run.week_start), priced.amountCents);
    moved.push(line.id);
  }
  if (moved.length) await audit(trx, actorId, run, { claimed_before_final_line_ids: moved });
  return moved;
}

/**
 * Plain notes for a run's summary: what waited at the run's latest sync and that no run has written since, with the last pay
 * date that can still carry it, e.g. "December gift for Sample Alpha waits: the week of Nov 2, 2026 is not paid yet. A pay run
 * dated Feb 16, 2027 or earlier can add it". After that day (`today`, the Eastern date) the note says the gift was not paid and
 * that no pay run adds it now, so the screen never promises a run that cannot come. Read from the run row (saveWaits). None with
 * either gate off, and none for a gift that has its line now (a later run claimed it), so an old run never says "waits" about a
 * paid gift.
 */
async function waitNotes(conn, runId, { today = etDateString() } = {}) {
  if (!payLinesOn() || !techRewardsOn()) return [];
  const row = await conn('payroll_runs').where({ id: runId }).first('tech_rewards_waits');
  const waits = (row && Array.isArray(row.tech_rewards_waits) ? row.tech_rewards_waits : [])
    .filter((w) => KIND_WORDS[w.kind] && WAIT_WORDS[w.reason] && SOURCE_ID_RE.test(w.source_id || ''));
  if (!waits.length) return [];
  const written = new Set((await conn('payroll_pay_lines').where({ source_type: SOURCE_TYPE })
    .whereIn('source_id', waits.map((w) => w.source_id)).select('source_id')).map((line) => line.source_id));
  const names = new Map((await conn('technicians').whereIn('id', waits.map((w) => w.technician_id)).select('id', 'name')).map((t) => [t.id, t.name]));
  return waits.filter((w) => !written.has(w.source_id) && names.has(w.technician_id))
    .map((w) => {
      const who = `${KIND_WORDS[w.kind]} for ${names.get(w.technician_id)}`;
      const last = lastPayDate(Number(SOURCE_ID_RE.exec(w.source_id)[3]));
      return today > last
        ? `${who} was not paid: ${WAIT_WORDS[w.reason](w)}, and no pay run dated ${dayLabel(last)} or earlier added it. No pay run adds it now`
        : `${who} waits: ${WAIT_WORDS[w.reason](w)}. A pay run dated ${dayLabel(last)} or earlier can add it`;
    })
    .sort();
}

module.exports = {
  SOURCE_TYPE,
  DECEMBER_GIFT_CENTS,
  decemberGiftDate,
  dueInRun,
  lastPayDate,
  spanOf,
  sourceIdOf,
  syncTechRewardLines,
  claimBeforeFinal,
  dropRewardLinesOfWeek,
  waitNotes,
};

/**
 * Basic payroll, layer 1b-2b (owner 2026-10-25, "can we start building basic
 * now, and add layers to it at later stages?"): weekly pay runs, the paycheck
 * the portal works out for each W-2 technician, and the pay stub. Dark behind
 * GATE_PAYROLL (the route checks it; these functions only run behind that
 * check).
 *
 * The portal prepares the numbers. The owner pays the technician (paper
 * check, or bank transfer with the employee's written OK) and makes every tax
 * deposit and filing himself. Nothing here moves money or sends a message.
 *
 * A run covers one staff week (Monday-Sunday). A draft takes every W-2
 * technician with an APPROVED weekly timesheet (time_weekly_summary, paid
 * minutes after auto lunch), the pay rate on the technician, and the W-4 in
 * force on the pay date, and runs computePaycheck(). A technician whose
 * paycheck cannot be worked out is listed as blocked with the reason, and a
 * W-2 technician with time but no approved week is listed as waiting. A run
 * cannot be finalized while anyone is blocked or waiting, so nobody is left
 * unpaid without being seen.
 *
 * Year-to-date gross is the sum of FINALIZED, non-voided checks of the same
 * calendar year that come before this one in (pay date, week start) order.
 * That ordering also drives the stub's year-to-date columns, so the two never
 * disagree. Because later checks depend on earlier ones, a run cannot be
 * finalized or voided while a later finalized check exists for the same
 * technician and year: void the later run first.
 *
 * GATE_PAYROLL_TIME_OFF (owner 2026-10-26): a draft also pays the paid time off
 * and holiday days recorded in payroll_time_off (services/payroll-time-off.js)
 * for the week. They are hours not worked: paid at the straight rate on the same
 * check, never counted toward overtime. A W-2 technician with time off and no
 * worked time that week gets a check for the time off alone. Time off never
 * bypasses the timesheet: a technician whose worked time is not approved stays
 * waiting. Gate off, every function here reads and returns what it did before.
 *
 * Time-off bank (owner 2026-11-21; no gate of its own, services/payroll-time-off-bank.js): for a
 * technician whose yearly time-off hours are set, the draft pays paid time off only from the bank,
 * and the check stores the hours it earned (pto_earned_minutes), the early illness minutes it paid
 * (pto_early_illness_minutes) and the bank figures (calc_snapshot.ptoBank). Time off that is not paid is
 * listed on the draft with its reason; the list is worked out on each view, so the review token takes it.
 * With no yearly hours set, every function here reads and returns what it did before.
 *
 * GATE_PAYROLL_PAY_LINES (owner 2026-10-29, D5 part 1): a draft also pays the open
 * pay lines of services/payroll-pay-lines.js (review bonus, commission, health
 * allowance, employer HSA money) and the extra overtime they cause in the federal
 * regular rate (payroll-regular-rate.js). A W-2 technician with lines and no hours,
 * one who has left too, gets a check for the lines alone. Finalize marks the lines
 * paid in its own transaction; void reopens them. Gate off, every function here
 * reads and returns what it did before.
 *
 * GATE_PAYROLL_FAMILY_EMPLOYEE (owner 2026-10-29, D5 part 2): a draft skips federal and Florida
 * unemployment tax on the pay of a technician whose family employee setting
 * (services/payroll-family-employee.js) starts on or before the pay date, and stores that on the
 * check (unemployment_exempt, unemployment_wages_cents). The year-to-date toward the $7,000 base
 * counts non-exempt pay only. Nothing else about the check changes. Gate off, every function here
 * reads and returns what it did before.
 *
 * SIMPLE IRA (owner 2026-11-04, B2 A; no gate): a draft reads the election in force on the pay date
 * (services/payroll-simple.js) and the year's deferral and participant pay already on finalized checks.
 * A participant's check stores the election, the employee's deferral and Waves' 2% figure; the deferral
 * comes out of net pay. With no election (or a non-participant one) every function here reads and
 * returns what it did before.
 *
 * GATE_PAYROLL_PRODUCTION_SHARE (owner 2026-11-24, production share PR 2; services/payroll-production-share.js): a draft also
 * pays a "Production share" earning to a W-2 technician with approved hours whose production share settings are in force for the
 * week: shareForWeek of the week's credited stops (services/production-share.js). The check stores production_share_cents and a
 * frozen snapshot of the credit (calc_snapshot.productionShare); the share counts in the federal regular rate for its own week
 * (the extra overtime rides on the same check, through payroll-regular-rate.js); a stop that needs review pays $0 and the draft
 * says so; the review token takes the share and its credit rows. Gate off, every function here reads and returns what it did before.
 *
 * Every write runs in one transaction with row locks. Audit events are
 * critical and carry ids only.
 */
const crypto = require('crypto');
const Joi = require('joi');
const db = require('../models/db');
const { recordAuditEvent } = require('./audit-log');
const { computePaycheck } = require('./payroll-calc');
const { currentW4For, PayrollError } = require('./payroll-w4');
const { simpleInputFor, simpleYtdBefore } = require('./payroll-simple');
const { csvRow } = require('./csv-generators');
const { syncPayrollFilingsSafe } = require('./payroll-tax-calendar');
const { etDateString, validCalendarDate } = require('../utils/datetime-et');
const {
  STAFF_WORK_DATE_SQL,
  STAFF_DAILY_WORK_SQL,
  addStaffWorkDays,
  staffWeekStartForWorkDate,
} = require('../utils/staff-time-work-date');
const { WAVES_BUSINESS_NAME, WAVES_ADDRESS_LINE } = require('../constants/business');
const { PAYROLL_LOCK_NS, PAYROLL_LOCK_KEY, lockPayrollMutations } = require('./payroll-lock');
const { applyDueSteps, hasDueSteps, withWeekRates } = require('./payroll-rate-steps');
const weekMinimum = require('./payroll-week-minimum');
const { shiftCloseReviewLive, payrollTimeOffLive, payrollBankMatchLive, payrollMercuryStatusLive } = require('../config/feature-gates');
const {
  payLinesOn, openLinesFor, priceLines, totalsOf, markLinesPaid, reopenLinesOfRun,
} = require('./payroll-pay-lines');
const { syncReviewBonusLines } = require('./payroll-review-bonuses');
const { syncCommissionLines } = require('./payroll-commission');
const {
  syncTechRewardLines, readSeasonScores, readSeasonScoresOfRun, dropRewardLinesOfWeek, paidBonusCounting, waitNotes,
  oldestUnpaidWeek,
} = require('./tech-rewards-pay-lines');
const { familyEmployeeOn, familyExemptIds } = require('./payroll-family-employee');
const timeOffBank = require('./payroll-time-off-bank');
const productionSharePay = require('./payroll-production-share');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON = 500;
const MAX_CHECK_NUMBER = 30;
const MAX_RUNS = 200;

// payroll_checks column -> computePaycheck output key.
const MONEY_COLUMNS = {
  gross_cents: 'grossPayCents',
  regular_pay_cents: 'regularPayCents',
  overtime_pay_cents: 'overtimePayCents',
  overtime_premium_cents: 'overtimePremiumCents',
  federal_income_tax_cents: 'federalIncomeTaxCents',
  social_security_cents: 'socialSecurityEmployeeCents',
  medicare_cents: 'medicareEmployeeCents',
  additional_medicare_cents: 'additionalMedicareCents',
  net_cents: 'netPayCents',
  employer_social_security_cents: 'socialSecurityEmployerCents',
  employer_medicare_cents: 'medicareEmployerCents',
  futa_cents: 'futaCents',
  fl_reemployment_cents: 'floridaReemploymentCents',
};
const MONEY_KEYS = Object.keys(MONEY_COLUMNS);
const EMPLOYEE_TAX_KEYS = ['federal_income_tax_cents', 'social_security_cents', 'medicare_cents', 'additional_medicare_cents'];
const EMPLOYER_TAX_KEYS = ['employer_social_security_cents', 'employer_medicare_cents', 'futa_cents', 'fl_reemployment_cents'];

// GATE_PAYROLL_TIME_OFF, read at call time. The typeof guard keeps a test mock of
// feature-gates that lacks the reader working (off).
const timeOffOn = () => typeof payrollTimeOffLive === 'function' && payrollTimeOffLive();

// GATE_PAYROLL_BANK_MATCH, read at call time, with the same guard. On, a finalized check carries
// its bank status; off, no response gains a key.
const bankMatchOn = () => typeof payrollBankMatchLive === 'function' && payrollBankMatchLive();

// GATE_PAYROLL_MERCURY_STATUS, read at call time, with the same guard. On, a finalized run carries each check's Mercury
// payment and a summary for the Send button; off, no response gains a key.
const mercuryStatusOn = () => typeof payrollMercuryStatusLive === 'function' && payrollMercuryStatusLive();

// payroll_checks time-off columns, read and written only with the gate on.
const TIME_OFF_MINUTE_COLUMNS = ['pto_minutes', 'holiday_minutes'];
const TIME_OFF_PAY_COLUMNS = ['pto_pay_cents', 'holiday_pay_cents'];
const TIME_OFF_COLUMNS = [...TIME_OFF_MINUTE_COLUMNS, ...TIME_OFF_PAY_COLUMNS];
// Time-off bank: a check of a technician with a bank stored the hours it earned (never null then) and its
// bank figures; any other check stored neither and shows neither.
const storedBank = (row) => row.pto_earned_minutes != null;
// What buildCheck stores for a technician with a bank (evaluate() sets tech.pto_bank, only behind the gate).
const bankSnapshot = (tech) => (tech.pto_bank ? { ptoBank: tech.pto_bank } : {});
const bankColumns = (tech) => (tech.pto_bank ? {
  pto_earned_minutes: tech.pto_bank.earnedMinutes, pto_early_illness_minutes: tech.pto_bank.earlyIllnessMinutes,
} : {});
// What a check with a bank shows; nothing for any other check, so that one keeps exactly its earlier keys.
function bankView(row) {
  if (!storedBank(row)) return {};
  const figures = row.pto_bank || {};
  // The hours the check paid out when the technician left. They are in pto_minutes and are not time off used.
  const paidOut = Number(figures.payoutMinutes || 0);
  return {
    timeOffBank: {
      earnedHours: hoursText(row.pto_earned_minutes),
      usedHours: hoursText(Number(row.pto_minutes) - paidOut),
      unpaidHours: hoursText(figures.unpaidMinutes),
      balanceHours: hoursText(figures.afterMinutes),
      ...(paidOut > 0 ? { paidOutHours: hoursText(paidOut) } : {}),
      // A check of a week before a payout, paid after it: the hours the week would have earned, not paid out.
      ...(Number(figures.notPaidOutMinutes) > 0 ? { notPaidOutHours: hoursText(figures.notPaidOutMinutes) } : {}),
    },
  };
}

// GATE_PAYROLL_PAY_LINES: payroll_checks column -> computePaycheck output key. Null on a
// check made with the gate off; read and written only with the gate on.
const PAY_LINE_COLUMNS = {
  review_bonus_cents: 'reviewBonusCents',
  commission_cents: 'commissionCents',
  health_allowance_cents: 'healthAllowanceCents',
  hsa_employer_cents: 'hsaEmployerCents',
  // Season bonus, stay bonus and December gift lines (Tech Rewards Plan, tech-rewards-pay-lines.js); null on a check with none of them.
  tech_rewards_cents: 'techRewardsCents',
  line_overtime_premium_cents: 'lineOvertimePremiumCents',
  qualified_overtime_cents: 'qualifiedOvertimeCents',
  simple_compensation_cents: 'simpleCompensationCents',
};
const PAY_LINE_KEYS = Object.keys(PAY_LINE_COLUMNS);
// A check drafted with the gate on stored its pay line figures (qualified_overtime_cents is
// never null then). It keeps showing them after the gate is turned off, so a paid stub, run
// and CSV still add up; a check drafted with the gate off stored none and shows none.
// A pay line figure the calculator left out (tech_rewards_cents on a check with none) is stored as null.
const nullWhenMissing = (value) => (value === undefined ? null : value);
const storedLines = (row) => row.qualified_overtime_cents != null;

// GATE_PAYROLL_FAMILY_EMPLOYEE: payroll_checks columns, null on a check drafted with the gate off;
// written with the gate on, read whatever the gate says. A check that stored them keeps counting
// them in its token after the gate is turned off, so a draft that still shows them goes stale.
const UNEMPLOYMENT_COLUMNS = ['unemployment_exempt', 'unemployment_wages_cents'];
const storedUnemployment = (row) => row.unemployment_exempt != null;

// SIMPLE IRA: payroll_checks columns, all null on a check with no participant election behind it.
const SIMPLE_COLUMNS = ['simple_election_id', 'simple_deferral_cents', 'simple_employer_cents'];
const storedSimple = (row) => row.simple_election_id != null;

const requireUuid = (id, what) => {
  if (!UUID_RE.test(String(id || ''))) throw new PayrollError(404, `${what} not found.`);
  return String(id);
};

function validate(schema, input) {
  const { value, error } = schema.validate(input || {}, { abortEarly: true, convert: true, allowUnknown: false });
  if (error) throw new PayrollError(400, error.details[0].message);
  return value;
}

const actorOf = (actor) => (actor && typeof actor === 'object' ? actor.id : actor) || null;

const createSchema = Joi.object({
  weekStart: Joi.string().trim().required()
    .messages({ 'any.required': 'Pick a week', 'string.empty': 'Pick a week', 'string.base': 'Pick a week' }),
  payDate: Joi.string().trim().allow('', null).optional()
    .messages({ 'string.base': 'Pay date must be a real date (YYYY-MM-DD)' }),
});
const finalizeSchema = Joi.object({
  token: Joi.string().trim().max(200).required()
    .messages({ 'any.required': 'Reload the pay run before you finalize it', 'string.empty': 'Reload the pay run before you finalize it', 'string.base': 'Reload the pay run before you finalize it' }),
});
const voidSchema = Joi.object({
  reason: Joi.string().trim().min(1).max(MAX_REASON).required()
    .messages({
      'any.required': 'Give a reason for the void', 'string.empty': 'Give a reason for the void', 'string.base': 'Give a reason for the void',
      'string.max': `Reason must be at most ${MAX_REASON} characters`,
    }),
});
const checkNumberSchema = Joi.object({
  checkNumber: Joi.string().trim().min(1).max(MAX_CHECK_NUMBER).pattern(/^[\x20-\x7E]+$/).required()
    .messages({
      'any.required': 'Enter the check number', 'string.empty': 'Enter the check number', 'string.base': 'Enter the check number',
      'string.max': `Check number must be at most ${MAX_CHECK_NUMBER} characters`,
      'string.pattern.base': 'Check number can use letters, numbers and common symbols only',
    }),
});

// ---- Weeks and dates (ET calendar dates as text; never local-time Date parsing)

// The Friday after the week ends: Monday + 11 days.
const defaultPayDate = (weekStart) => addStaffWorkDays(weekStart, 11);

function validateWeek(weekStart, today = etDateString()) {
  const day = validCalendarDate(weekStart);
  if (!day) throw new PayrollError(400, 'Week must be a real date (YYYY-MM-DD)');
  if (staffWeekStartForWorkDate(day) !== day) throw new PayrollError(400, 'The week must start on a Monday');
  const end = addStaffWorkDays(day, 6);
  if (end >= today) throw new PayrollError(409, 'That week is not finished yet. Pick a week that ended.');
  return { start: day, end };
}

function resolvePayDate(start, end, payDate) {
  if (payDate == null || payDate === '') return defaultPayDate(start);
  const day = validCalendarDate(payDate);
  if (!day) throw new PayrollError(400, 'Pay date must be a real date (YYYY-MM-DD)');
  if (day <= end) throw new PayrollError(400, 'Pay date must be after the week ends');
  return day;
}

// ---- Money text

// Integer cents -> '1234.50'. Integer math only.
function centsText(cents) {
  const n = Math.round(Number(cents) || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
const AUTO_CLOSE_BLOCK_REASON = 'An automatic clock-out needs a real time';
const hoursText = (minutes) => (Math.round((Number(minutes) || 0) / 60 * 100) / 100).toFixed(2);

// ---- One paycheck, no database

// IRS Tax Topic 753: an employee with no properly completed Form W-4 is withheld as single with no
// entries in step 2, 3 or 4. It has no id: no election row stands behind it, and the check stores
// w4_election_id null (the token changes to the real id once a W-4 is recorded).
const electionOrIrsDefault = (election, payDate) => election || {
  id: null, formYear: Number(String(payDate).slice(0, 4)), filingStatus: 'single', step2Checkbox: false, exempt: false,
};

/**
 * Works out one technician's check. Returns { check } (the row to insert, minus
 * run_id) or { blocked } with a plain reason. Never throws for a calculation
 * problem: the message of computePaycheck becomes the reason. A null w4 (none on
 * file, or a lapsed exemption) is withheld as the IRS default, not blocked.
 */
function buildCheck({
  tech, payDate, weekStart, w4: election, ytdGrossCents, ytdUnemploymentCents, unemploymentExempt, simple,
}) {
  const w4 = electionOrIrsDefault(election, payDate);
  const withTimeOff = timeOffOn();
  // GATE_PAYROLL_PRODUCTION_SHARE: evaluate() sets tech.production_share for a technician with settings in force that week. A
  // share above $0 puts the check in pay line mode (the share is a pay line figure and causes line overtime), whatever the
  // pay lines gate says; a share of $0 changes nothing but the stored figure and snapshot.
  const share = tech.production_share && !tech.production_share.error ? tech.production_share : null;
  const shareCents = share ? share.shareCents : 0;
  const withLines = payLinesOn() || shareCents > 0;
  const ptoMinutes = tech.pto_minutes || 0;
  const holidayMinutes = tech.holiday_minutes || 0;
  // The minimum paid week: set by evaluate() only for a technician who has one (payroll-week-minimum.js).
  const withMinimum = withTimeOff && tech.minimum_week_minutes !== undefined;
  // Open pay lines for this technician and the extra overtime they cause (evaluate()).
  const lines = (withLines && tech.pay_lines) || [];
  const linePremium = (withLines && tech.line_premium) || { extraPremiumCents: 0, weeks: [] };
  let pay;
  try {
    pay = computePaycheck({
      payDate,
      payFrequency: 'weekly',
      hourlyRate: tech.pay_rate,
      regularMinutes: tech.regular_minutes,
      overtimeMinutes: tech.overtime_minutes,
      ...(withTimeOff ? { ptoMinutes, holidayMinutes } : {}),
      ...(withMinimum ? {
        minimumWeekMinutes: tech.minimum_week_minutes,
        minimumWeekTargetMinutes: tech.minimum_week_target_minutes || 0,
        minimumWeekPayoutMinutes: (tech.pto_bank && tech.pto_bank.payoutMinutes) || 0,
      } : {}),
      ytdGrossWages: centsText(ytdGrossCents),
      w4,
      ...(withLines ? {
        payLines: {
          ...totalsOf(lines), ...(shareCents > 0 ? { productionShareCents: shareCents } : {}),
          lineOvertimePremiumCents: linePremium.extraPremiumCents,
        },
        flsaCovered: tech.flsa_overtime_covered === true,
      } : {}),
      // GATE_PAYROLL_FAMILY_EMPLOYEE: decided by evaluate() (undefined = not decided, today's math).
      ...(unemploymentExempt === undefined ? {} : { unemploymentExempt, ytdUnemploymentWages: centsText(ytdUnemploymentCents) }),
      // SIMPLE IRA: a participant's election and year-to-date figures (undefined = today's math).
      simple,
    });
  } catch (err) {
    return { blocked: (err && err.message) || 'The paycheck could not be worked out' };
  }
  const check = {
    technician_id: tech.technician_id,
    employee_name: tech.name,
    week_start: weekStart,
    pay_date: payDate,
    hourly_rate: tech.pay_rate,
    regular_minutes: tech.regular_minutes,
    overtime_minutes: tech.overtime_minutes,
    ytd_gross_before_cents: ytdGrossCents,
    w4_election_id: w4.id,
    calc_snapshot: JSON.stringify({
      ...(lines.length ? { ...pay, payLines: lines, lineOvertimeWeeks: linePremium.weeks }
        : shareCents > 0 ? { ...pay, lineOvertimeWeeks: linePremium.weeks } : pay),
      ...bankSnapshot(tech),
      ...(share ? { productionShare: share.snapshot } : {}),
    }),
    pay_method: tech.pay_method || 'check',
    status: 'draft',
    ...simpleColumns(simple, pay),
  };
  for (const [column, key] of Object.entries(MONEY_COLUMNS)) check[column] = pay[key];
  if (withLines) for (const [column, key] of Object.entries(PAY_LINE_COLUMNS)) check[column] = nullWhenMissing(pay[key]);
  if (unemploymentExempt !== undefined) {
    check.unemployment_exempt = pay.unemploymentExempt;
    check.unemployment_wages_cents = pay.taxableWages.futaCents;
  }
  if (withTimeOff) {
    check.pto_minutes = ptoMinutes;
    check.holiday_minutes = holidayMinutes;
    check.pto_pay_cents = pay.ptoPayCents;
    check.holiday_pay_cents = pay.holidayPayCents;
    Object.assign(check, bankColumns(tech));
  }
  if (withMinimum) {
    check.minimum_week_minutes = tech.minimum_week_minutes;
    check.minimum_week_pay_cents = pay.minimumWeekPayCents;
  }
  // Null on a check with no production share settings behind it (or drafted with the gate off), 0 on a week at or under the bar.
  if (share) check.production_share_cents = shareCents;
  return { check };
}

// payroll_checks SIMPLE IRA columns of a participant's check; none for any other (the columns stay null).
const simpleColumns = (simple, pay) => (simple ? {
  simple_election_id: simple.id,
  simple_deferral_cents: pay.simpleDeferralCents,
  simple_employer_cents: pay.simpleEmployerCents,
} : {});

// The pay lines a check holds: ids, kinds, amounts and spans, in id order. A stored row
// carries them as `pay_lines` (calc_snapshot->'payLines'); a row about to be stored
// carries them in its calc_snapshot text.
function payLinesSignature(row) {
  let lines = row.pay_lines;
  if (!('pay_lines' in row) && typeof row.calc_snapshot === 'string') {
    try { lines = JSON.parse(row.calc_snapshot).payLines; } catch { lines = null; }
  }
  return (Array.isArray(lines) ? lines : [])
    .map((l) => [l.id, l.kind, Number(l.amountCents), l.earnedWeekStart, l.coversFrom || null, l.coversTo || null])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// The time-off bank figures a check holds, normalized. A stored row carries them as `pto_bank`
// (calc_snapshot->'ptoBank'); a row about to be stored carries them in its calc_snapshot text.
function ptoBankSignature(row) {
  let bank = row.pto_bank;
  if (!('pto_bank' in row) && typeof row.calc_snapshot === 'string') {
    try { bank = JSON.parse(row.calc_snapshot).ptoBank; } catch { bank = null; }
  }
  const figures = ['earnedMinutes', 'earlyIllnessMinutes', 'unpaidMinutes', 'unpaidRuleMinutes', 'unpaidBeforeHireMinutes', 'beforeMinutes', 'afterMinutes']
    .map((key) => Number((bank || {})[key] || 0).toFixed(2));
  // What the bank paid on each date. A day off moved inside the week can keep every total and still change
  // these, and pay earned by date reads them (tech-rewards-scoreboard.js readGross).
  const paidDays = ((bank || {}).paidDays || []).map((day) => `${day.workDate}=${Number(day.minutes || 0).toFixed(2)}`).sort();
  // The hours a catch-up check shows as not paid out: the owner reads them to pay by hand. Only when there are some,
  // so every other check keeps its token.
  const notPaidOut = Number((bank || {}).notPaidOutMinutes || 0);
  return [...figures, paidDays.join(','), ...(notPaidOut > 0 ? [`notPaidOut=${notPaidOut.toFixed(2)}`] : [])];
}

// The unpaid time off list in the token (payroll-time-off-bank.js applyBank): who, how much and why.
const unpaidSignature = (unpaid) => unpaid.map((row) => [row.technicianId, row.hours, row.reason])
  .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
// The bank payouts in the token: who and how much. A payout of an empty bank changes no check, and finalize
// still keeps it as the run's decision, so the owner must have seen it.
const payoutSignature = (payouts) => ['bank payouts', ...payouts.map((row) => [row.technicianId, row.hours])
  .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))];

// What a run view shows of the time-off bank's two lists (time off not paid, bank payouts decided): each key is
// present only when its list has a row.
// What a run with no paycheck can still decide: time off a bank did not pay, or the payout of an empty bank.
const decidesWithNoCheck = (evaluation) => evaluation.unpaidTimeOff.length + evaluation.bankPayouts.length > 0;
// A payout row keeps the yearly hours it was worked out with (a catch-up check reads them, payroll-time-off-bank.js
// paidOutInLaterWeek); the view does not show them.
const bankLists = (unpaid, payouts) => ({
  ...(unpaid && unpaid.length ? { unpaidTimeOff: unpaid } : {}),
  ...(payouts && payouts.length ? { bankPayouts: payouts.map(({ hoursPerYear, ...shown }) => shown) } : {}),
});

// A token over everything that decides the numbers on a run. It is computed from
// rows as stored (strings from Postgres) and from rows about to be stored
// (numbers), so every value is normalized first.
// `unpaid` = the time off a time-off bank did not pay, as the view listed it. It is not stored (a technician it
// names can have no check), so the view and finalize pass it; with none, the token is the one it always was.
// `payouts` = the bank payouts the run decides (applyBank), passed the same way and for the same reason.
function tokenOf(run, rows, unpaid = [], payouts = []) {
  const withTimeOff = timeOffOn();
  const withLines = payLinesOn();
  const withFamily = familyEmployeeOn();
  const parts = rows.map((row) => [
    row.technician_id,
    Number(row.hourly_rate).toFixed(2),
    Number(row.regular_minutes).toFixed(2),
    Number(row.overtime_minutes).toFixed(2),
    row.pay_method,
    row.w4_election_id,
    Number(row.ytd_gross_before_cents),
    ...MONEY_KEYS.map((key) => Number(row[key])),
    // A time-off change after drafting changes the token, so finalize asks for a reload.
    ...(withTimeOff ? [
      ...TIME_OFF_MINUTE_COLUMNS.map((key) => Number(row[key] || 0).toFixed(2)),
      ...TIME_OFF_PAY_COLUMNS.map((key) => Number(row[key] || 0)),
    ] : []),
    // The time-off bank: a change of the yearly hours, the hire date, an illness mark or an earlier
    // check after drafting changes what the bank pays or earns, so the draft goes stale.
    ...(storedBank(row) ? [Number(row.pto_earned_minutes).toFixed(2), ptoBankSignature(row)] : []),
    // The minimum paid week: only on a check that has one, so every other check keeps its token.
    ...(row.minimum_week_minutes != null ? [`minimum=${Number(row.minimum_week_minutes).toFixed(2)}`, Number(row.minimum_week_pay_cents)] : []),
    // Adding, removing or changing a pay line after drafting changes the token too. A row that
    // stored pay line figures keeps them in the token after the gate is turned off, so a draft
    // that still shows them goes stale instead of finalizing without them.
    ...(withLines || storedLines(row) ? [...PAY_LINE_KEYS.map((key) => Number(row[key] || 0)), payLinesSignature(row)] : []),
    // The same rule for the family employee exemption: changing the setting after drafting makes the draft stale.
    ...(withFamily || storedUnemployment(row) ? [row.unemployment_exempt === true, Number(row.unemployment_wages_cents || 0)] : []),
    // And for SIMPLE IRA savings: a new, changed or ended election after drafting makes the draft stale.
    ...(storedSimple(row) ? [row.simple_election_id, Number(row.simple_deferral_cents), Number(row.simple_employer_cents)] : []),
    // The production share: its cents and every credit row it was worked out from, so a changed credit (a price, a stop
    // completed late, a callback judged again, new settings) makes the draft stale. Only on a check that has one.
    ...(row.production_share_cents != null ? [`share=${Number(row.production_share_cents)}`, productionSharePay.signature(row)] : []),
  ]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const signed = [run.week_start, run.pay_date, parts, ...(unpaid.length ? [unpaidSignature(unpaid)] : []),
    ...(payouts.length ? [payoutSignature(payouts)] : [])];
  return crypto.createHash('sha256').update(JSON.stringify(signed)).digest('hex').slice(0, 32);
}

function sumRows(rows) {
  const total = (keys) => rows.reduce((sum, row) => sum + keys.reduce((s, k) => s + Number(row[k] || 0), 0), 0);
  return {
    checkCount: rows.length,
    grossCents: total(['gross_cents']),
    employeeTaxesCents: total(EMPLOYEE_TAX_KEYS),
    netCents: total(['net_cents']),
    employerTaxesCents: total(EMPLOYER_TAX_KEYS),
    ...(timeOffOn() ? { ptoPayCents: total(['pto_pay_cents']), holidayPayCents: total(['holiday_pay_cents']) } : {}),
    // Present only when a check of the run has a minimum paid week, so every other run keeps its keys.
    ...(rows.some((row) => row.minimum_week_minutes != null) ? { minimumWeekPayCents: total(['minimum_week_pay_cents']) } : {}),
    // Present only when a check of the run paid a production share.
    ...(rows.some((row) => Number(row.production_share_cents) > 0) ? { productionShareCents: total(['production_share_cents']) } : {}),
  };
}

// ---- Reading

const runColumns = (conn) => [
  'id', 'status', 'void_reason', 'created_by', 'finalized_by', 'voided_by',
  conn.raw("to_char(week_start, 'YYYY-MM-DD') as week_start"),
  conn.raw("to_char(pay_date, 'YYYY-MM-DD') as pay_date"),
  'created_at', 'finalized_at', 'voided_at',
  // The time off a finalized run did not pay and the bank payouts it decided (time-off bank), kept with the
  // run; not read with the gate off.
  ...(timeOffOn() ? ['unpaid_time_off', 'bank_payouts'] : []),
];

const checkColumns = (conn) => [
  'id', 'run_id', 'technician_id', 'employee_name', 'hourly_rate', 'regular_minutes', 'overtime_minutes',
  ...MONEY_KEYS,
  ...(timeOffOn() ? [...TIME_OFF_COLUMNS, 'pto_earned_minutes', conn.raw("calc_snapshot->'ptoBank' as pto_bank")] : []),
  ...PAY_LINE_KEYS, ...UNEMPLOYMENT_COLUMNS, ...SIMPLE_COLUMNS, conn.raw("calc_snapshot->'payLines' as pay_lines"),
  // The minimum paid week, read whatever the gates are: a check that paid one shows it.
  'minimum_week_minutes', 'minimum_week_pay_cents',
  // The production share, read whatever the gates are: a check that stored one shows it.
  'production_share_cents', conn.raw("calc_snapshot->'productionShare' as production_share"),
  'ytd_gross_before_cents', 'w4_election_id', 'pay_method', 'check_number', 'status',
  conn.raw("to_char(week_start, 'YYYY-MM-DD') as week_start"),
  conn.raw("to_char(pay_date, 'YYYY-MM-DD') as pay_date"),
];

const iso = (value) => (value ? new Date(value).toISOString() : null);

function serializeCheck(row) {
  return {
    id: row.id,
    technicianId: row.technician_id,
    name: row.employee_name,
    status: row.status,
    hourlyRate: row.hourly_rate,
    regularMinutes: Number(row.regular_minutes),
    overtimeMinutes: Number(row.overtime_minutes),
    regularHours: hoursText(row.regular_minutes),
    overtimeHours: hoursText(row.overtime_minutes),
    payMethod: row.pay_method,
    checkNumber: row.check_number || null,
    grossCents: Number(row.gross_cents),
    regularPayCents: Number(row.regular_pay_cents),
    overtimePayCents: Number(row.overtime_pay_cents),
    federalIncomeTaxCents: Number(row.federal_income_tax_cents),
    socialSecurityCents: Number(row.social_security_cents),
    medicareCents: Number(row.medicare_cents),
    additionalMedicareCents: Number(row.additional_medicare_cents),
    netCents: Number(row.net_cents),
    employerSocialSecurityCents: Number(row.employer_social_security_cents),
    employerMedicareCents: Number(row.employer_medicare_cents),
    futaCents: Number(row.futa_cents),
    flReemploymentCents: Number(row.fl_reemployment_cents),
    ytdGrossBeforeCents: Number(row.ytd_gross_before_cents),
    // No W-4 election stood behind this check: withheld as single, no adjustments (the IRS default).
    // Present only then, so a check with a W-4 keeps exactly its earlier keys.
    ...(row.w4_election_id == null ? { w4Default: true } : {}),
    // SIMPLE IRA: present only on a participant's check, so any other check keeps exactly its earlier keys.
    ...(storedSimple(row) ? {
      simpleDeferralCents: Number(row.simple_deferral_cents),
      simpleEmployerCents: Number(row.simple_employer_cents),
    } : {}),
    ...(timeOffOn() ? {
      ptoMinutes: Number(row.pto_minutes || 0),
      holidayMinutes: Number(row.holiday_minutes || 0),
      ptoHours: hoursText(row.pto_minutes),
      holidayHours: hoursText(row.holiday_minutes),
      ptoPayCents: Number(row.pto_pay_cents || 0),
      holidayPayCents: Number(row.holiday_pay_cents || 0),
    } : {}),
    ...bankView(row),
    // The minimum paid week (payroll-week-minimum.js): only on a check of a technician who has one.
    ...(row.minimum_week_minutes != null ? {
      minimumWeekMinutes: Number(row.minimum_week_minutes),
      minimumWeekHours: hoursText(row.minimum_week_minutes),
      minimumWeekPayCents: Number(row.minimum_week_pay_cents),
    } : {}),
    // The production share (payroll-production-share.js): only on a check that stored one.
    ...productionSharePay.viewOf(row),
    ...(payLinesOn() || storedLines(row) ? {
      reviewBonusCents: Number(row.review_bonus_cents || 0),
      commissionCents: Number(row.commission_cents || 0),
      healthAllowanceCents: Number(row.health_allowance_cents || 0),
      hsaEmployerCents: Number(row.hsa_employer_cents || 0),
      ...(row.tech_rewards_cents != null ? { techRewardsCents: Number(row.tech_rewards_cents) } : {}),
      lineOvertimePremiumCents: Number(row.line_overtime_premium_cents || 0),
      payLines: Array.isArray(row.pay_lines) ? row.pay_lines : [],
    } : {}),
  };
}

async function loadRun(conn, id, { lock = false } = {}) {
  const query = conn('payroll_runs').where({ id });
  if (lock) query.forUpdate();
  const run = await query.first(runColumns(conn));
  if (!run) throw new PayrollError(404, 'Pay run not found.');
  return run;
}

const loadCheckRows = (conn, runId, { lock = false } = {}) => {
  const query = conn('payroll_checks').where({ run_id: runId }).orderBy([{ column: 'employee_name' }, { column: 'technician_id' }]);
  if (lock) query.forUpdate();
  return query.select(checkColumns(conn));
};

// "Paid by paper check instead" (payroll-mercury.js) is saved as a payment row, and the check row stays frozen. The
// stub, a technician's own list and the CSV say how the check was paid, so that paper check wins over bank transfer.
// Not behind a gate: a paper check recorded while the gate was on stays true after it is turned off.
async function withPaperPayments(conn, rows) {
  const bank = rows.filter((row) => row.pay_method === 'bank_transfer').map((row) => row.id);
  if (!bank.length) return rows;
  const latest = await require('./payroll-mercury').latestPayments(conn, bank);
  return rows.map((row) => {
    const payment = latest.get(row.id);
    return payment && payment.state === 'paper' ? { ...row, pay_method: 'check', check_number: payment.check_number } : row;
  });
}

// Technicians with worked time in the week, approved or not. Same test as the
// timesheet approval screen, so "waiting" matches what the office sees there.

async function workedTechnicianIds(conn, start, end) {
  const daily = await conn('time_entry_daily_summary')
    .where('work_date', '>=', start)
    .where('work_date', '<=', end)
    .whereRaw(STAFF_DAILY_WORK_SQL)
    .select('technician_id');
  const entries = await conn('time_entries')
    .whereRaw(`${STAFF_WORK_DATE_SQL} BETWEEN ?::date AND ?::date`, [start, end])
    .where('status', '!=', 'voided')
    .select('technician_id');
  return [...new Set([...daily, ...entries].map((row) => row.technician_id))];
}

// The Monday of a date's Monday-Sunday pay week, as a PostgreSQL date expression (staffWeekStartForWorkDate, in SQL).
const weekStartSql = (dateSql) => `(${dateSql} - (EXTRACT(ISODOW FROM ${dateSql})::int - 1))`;

// The same test by week, for the technicians in `ids`: Map of technician id -> Set of the pay weeks (their Mondays) in
// [start, end] that hold recorded work (a daily summary with worked time, or a time entry that is not voided). `start` is a
// Monday and `end` a Sunday. Two queries, whatever the span, and each returns at most one row per technician per week:
// PostgreSQL finds the week, so a year of days and time entries is never read or converted here (the callers hold the
// payroll lock).
async function workedWeeksByTechnician(conn, ids, start, end) {
  const byTech = new Map(ids.map((id) => [id, new Set()]));
  if (!ids.length) return byTech;
  const daily = await conn('time_entry_daily_summary')
    .whereIn('technician_id', ids).where('work_date', '>=', start).where('work_date', '<=', end)
    .whereRaw(STAFF_DAILY_WORK_SQL)
    .distinct('technician_id', conn.raw(`to_char(${weekStartSql('work_date')}, 'YYYY-MM-DD') AS week_start`));
  const entries = await conn('time_entries')
    .whereIn('technician_id', ids).where('status', '!=', 'voided')
    .whereRaw(`${STAFF_WORK_DATE_SQL} BETWEEN ?::date AND ?::date`, [start, end])
    .distinct('technician_id', conn.raw(`to_char(${weekStartSql(STAFF_WORK_DATE_SQL)}, 'YYYY-MM-DD') AS week_start`));
  for (const row of [...daily, ...entries]) byTech.get(row.technician_id).add(row.week_start);
  return byTech;
}

// One technician's pay weeks with recorded work in [start, end] (a Monday to a Sunday), oldest first. Tech Rewards asks it to
// see which weeks a line covers still need a finalized check (tech-rewards-pay-lines.js).
async function workedWeeks(conn, technicianId, start, end) {
  return [...(await workedWeeksByTechnician(conn, [technicianId], start, end)).get(technicianId)].sort();
}

// GATE_PAYROLL_PAY_LINES: a line's overtime is priced from the approved hours of every
// week it covers. A covered week that holds worked time but no approved timesheet would
// price as no hours, and the line would be paid without that week's overtime for good.
// Map of technician id -> the oldest such week; that technician waits until it is approved.
// The worked time of every missing week is read at once (workedWeeksByTechnician, the test workedTechnicianIds applies to
// one week), so a line that covers a year costs the same two queries as a line that covers a week.
async function lineWeeksWaiting(conn, priced) {
  const missing = [...priced].filter(([, { missingWeeks = [] }]) => missingWeeks.length)
    .map(([technicianId, { missingWeeks }]) => [technicianId, [...missingWeeks].sort()]);
  const waitingOn = new Map();
  if (!missing.length) return waitingOn;
  const weeks = missing.flatMap(([, own]) => own).sort();
  const worked = await workedWeeksByTechnician(conn, missing.map(([technicianId]) => technicianId),
    weeks[0], addStaffWorkDays(weeks[weeks.length - 1], 6));
  for (const [technicianId, own] of missing) {
    const week = own.find((candidate) => worked.get(technicianId).has(candidate));
    if (week) waitingOn.set(technicianId, week);
  }
  return waitingOn;
}

// GATE_SHIFT_CLOSE_REVIEW: a covered week that holds a shift the system closed (the 11 PM
// job or the 14-hour check) that no admin has edited or confirmed may hold wrong hours, so
// a line priced from it is held like the run's own week. Map of technician id -> the
// oldest such week.
async function lineWeeksUnreviewed(conn, priced) {
  const heldOn = new Map();
  for (const [technicianId, { coveredWeeks = [] }] of priced) {
    if (!coveredWeeks.length) continue;
    const covered = new Set(coveredWeeks);
    const rows = await conn('time_entries')
      .where({ technician_id: technicianId, entry_type: 'shift' })
      .whereNotNull('auto_closed_at')
      .whereNull('auto_close_reviewed_at')
      .whereNot({ status: 'voided' })
      .whereRaw(`${STAFF_WORK_DATE_SQL} BETWEEN ?::date AND ?::date`, [coveredWeeks[0], addStaffWorkDays(coveredWeeks[coveredWeeks.length - 1], 6)])
      .select(conn.raw(`to_char(${STAFF_WORK_DATE_SQL}, 'YYYY-MM-DD') as work_date`));
    const weeks = rows.map((row) => staffWeekStartForWorkDate(row.work_date)).filter((week) => covered.has(week)).sort();
    if (weeks.length) heldOn.set(technicianId, weeks[0]);
  }
  return heldOn;
}

// The oldest week for which the two guards above would make a run wait or hold a check, for ONE pay line of a technician
// ({ amountCents, earnedWeekStart, coversFrom, coversTo }), or null. Tech Rewards asks before it writes a line
// (tech-rewards-pay-lines.js waitOf), so a line it writes never holds a pay run.
async function lineGuardWeek(conn, technicianId, line) {
  // only the covered weeks are read here, never the premium, so what earlier checks paid is not read
  const priced = await priceLines(conn, new Map([[technicianId, { lines: [line] }]]), { history: false });
  const waitingOn = (await lineWeeksWaiting(conn, priced)).get(technicianId);
  const unreviewed = shiftCloseReviewLive() ? (await lineWeeksUnreviewed(conn, priced)).get(technicianId) : undefined;
  return [waitingOn, unreviewed].filter(Boolean).sort()[0] || null;
}

// GATE_PAYROLL_TIME_OFF: paid time off and holiday minutes of W-2 technicians
// dated inside the week, summed per technician. Map of id -> { pto, holiday }.
async function timeOffByTechnician(conn, start, end) {
  const rows = await conn('payroll_time_off as o')
    .join('technicians as t', 't.id', 'o.technician_id')
    .where('o.work_date', '>=', start)
    .where('o.work_date', '<=', end)
    .where('t.employment_type', 'w2')
    .groupBy('o.technician_id', 'o.kind')
    .select('o.technician_id', 'o.kind', conn.raw('SUM(o.minutes) AS minutes'));
  const byTech = new Map();
  for (const row of rows) {
    const entry = byTech.get(row.technician_id) || { pto: 0, holiday: 0 };
    entry[row.kind === 'holiday' ? 'holiday' : 'pto'] = Number(row.minutes);
    byTech.set(row.technician_id, entry);
  }
  return byTech;
}

// Year-to-date before a pay date, in cents: finalized, non-voided checks of the same calendar
// year that sort before (payDate, weekStart). Map of technician id -> { gross, unemployment },
// one entry per id. `unemployment` is the gross that used up the $7,000 FUTA and RT-6 base:
// a check that stored unemployment_exempt = true counts nothing (null, drafted with
// GATE_PAYROLL_FAMILY_EMPLOYEE off, counts as before).
async function ytdBefore(conn, technicianIds, payDate, weekStart) {
  const byTech = new Map(technicianIds.map((id) => [id, { gross: 0, unemployment: 0 }]));
  if (!technicianIds.length) return byTech;
  const year = payDate.slice(0, 4);
  const rows = await conn('payroll_checks')
    .where('status', 'finalized')
    .whereIn('technician_id', technicianIds)
    .where('pay_date', '>=', `${year}-01-01`)
    .where('pay_date', '<=', `${year}-12-31`)
    .where(function before() {
      this.where('pay_date', '<', payDate).orWhere(function sameDay() {
        this.where('pay_date', payDate).andWhere('week_start', '<', weekStart);
      });
    })
    .groupBy('technician_id')
    .select(
      'technician_id',
      conn.raw('SUM(gross_cents) AS ytd'),
      conn.raw('SUM(CASE WHEN unemployment_exempt IS TRUE THEN 0 ELSE gross_cents END) AS ytd_unemployment'),
    );
  for (const row of rows) byTech.set(row.technician_id, { gross: Number(row.ytd), unemployment: Number(row.ytd_unemployment) });
  return byTech;
}

// What every check on a run needs beside the technician's own row, for the technicians in `ids`: pay of the year before this
// check, SIMPLE IRA savings of the year, and who skips FUTA and RT-6 on the pay date.
async function checkInputs(conn, run, ids, { lock = false } = {}) {
  return {
    ytd: await ytdBefore(conn, ids, run.pay_date, run.week_start),
    simpleYtd: await simpleYtdBefore(conn, ids, run.pay_date, run.week_start),
    // GATE_PAYROLL_FAMILY_EMPLOYEE: technicians whose pay on the pay date skips FUTA and RT-6 (empty when off).
    familyLive: familyEmployeeOn(),
    familyExempt: await familyExemptIds(conn, ids, run.pay_date, { lock }),
  };
}

// One technician's check on the run from those figures: { check } or { blocked } (buildCheck).
async function buildFor(conn, run, tech, inputs) {
  const id = tech.technician_id;
  const yearToDate = inputs.ytd.get(id);
  return buildCheck({
    tech,
    payDate: run.pay_date,
    weekStart: run.week_start,
    w4: await currentW4For(id, run.pay_date, conn),
    ytdGrossCents: yearToDate.gross,
    ytdUnemploymentCents: yearToDate.unemployment,
    simple: await simpleInputFor(id, run.pay_date, inputs.simpleYtd.get(id), conn),
    // GATE_PAYROLL_FAMILY_EMPLOYEE: decided and stored with the gate on, and also after it is turned
    // off for anyone whose year already holds exempt pay, so that pay never uses up the $7,000 base.
    unemploymentExempt: inputs.familyLive || yearToDate.unemployment !== yearToDate.gross
      ? inputs.familyExempt.has(id) : undefined,
  });
}

// Why a check that holds only this pay line ({ kind, amountCents }) and no hours cannot be worked out for the technician on this
// run, in buildCheck's own words (no pay rate, a rate under the minimum wage, ...), or null when it can. It is the smallest check
// the technician can get: when it fails, any check of theirs on this run fails. Tech Rewards asks before it writes a line
// (tech-rewards-pay-lines.js waitOf), so a line it writes never makes a check that blocks the run.
async function lineOnlyCheckProblem(conn, run, technicianId, line) {
  const row = await conn('technicians').where({ id: technicianId, employment_type: 'w2' })
    .first('id', 'name', 'pay_rate', 'pay_method', 'flsa_overtime_covered');
  if (!row) return 'Not a W-2 employee';
  const [tech] = await withWeekRates(conn, [{
    technician_id: row.id, name: row.name, pay_rate: row.pay_rate, pay_method: row.pay_method,
    flsa_overtime_covered: row.flsa_overtime_covered, regular_minutes: 0, overtime_minutes: 0, pto_minutes: 0, holiday_minutes: 0,
  }], run.week_start);
  const built = await buildFor(conn, run, { ...tech, pay_lines: [line] }, await checkInputs(conn, run, [technicianId]));
  return built.blocked || null;
}

// A bank payout waits until every earlier week of the technician is paid: Map of technician id -> the reason, for
// each of `payouts` (applyBank) who has such a week. A payout pays what the bank holds after its week, and the bank
// is zero after it: a paycheck for an earlier week made final later would earn hours the payout missed. That week
// is then paid on a later pay date, by a catch-up check that pays those hours out itself (payroll-time-off-bank.js
// paidOutInLaterWeek), in another pay period. So the run holds the payout's row while such a week is on file, with
// the oldest one: the weeks are paid in order and one payout holds everything. The test is the one a Tech Rewards line
// waits on (oldestUnpaidWeek: a timesheet with minutes, recorded work or time off, and no final check or kept
// "not paid" decision), less a week whose pay run is final: nothing can pay that week any more, so it never holds a
// payout. The weeks are asked from the hire date or an earlier stay on (payoutAsksFrom).
const EVERY_WEEK_FROM = '2000-01-03';

// finalizeRun's refusal under a later final run that paid out the time-off bank of a technician on this run. That
// run cannot be voided once its payment is sent (payroll-mercury.js assertNoOpenPayments), so the way out is named.
const LATER_RUN_PAID_OUT = 'A later pay run is already final, and it paid out the time-off bank of an employee on this pay run. Void it first, then finalize this one. If its payment was sent, make this pay run again with a pay date after that pay run\'s.';
async function payoutWaits(conn, payouts, start) {
  const waits = new Map();
  if (!payouts.length) return waits;
  const coversTo = addStaffWorkDays(start, -1);
  const asksFrom = await payoutAsksFrom(conn, payouts.map((row) => row.technicianId));
  for (const row of payouts) {
    const coversFrom = asksFrom.get(row.technicianId);
    const week = coversFrom <= coversTo ? await oldestUnpaidWeek(conn, row.technicianId, { coversFrom, coversTo, skipClosed: true }) : null;
    if (week) waits.set(row.technicianId, timeOffBank.weekBeforePayoutReason(week));
  }
  return waits;
}

// The first day payoutWaits asks about, for each technician: Map of id -> 'YYYY-MM-DD'. It is the hire date, or
// the first fact on file that only a W-2 employee has when that is earlier (an earlier stay: a rehire moved the
// hire date forward): a check of theirs in a pay run that was final once (voided since or not) or in a draft that
// is open now, a decision such a final run kept for them with no check (time off left unpaid, a bank paid out),
// or a time-off entry. Work on file before that day is not asked: nothing tells an unpaid week there from work
// that was paid outside pay runs (contractor pay before the employee became W-2, or wages before pay runs
// started), and such a week would hold every payout for good. With no hire date on file, EVERY earlier week is
// asked. Such a fact only ever moves the first day back from the hire date, never forward: a draft or a paycheck
// of a later week hides no earlier week. A week this leaves out can still be paid after the payout, on a later
// pay date: its check is a catch-up check (payroll-time-off-bank.js paidOutInLaterWeek).
async function payoutAsksFrom(conn, ids) {
  const hired = await conn('technicians').whereIn('id', ids).select('id', conn.raw("to_char(hire_date, 'YYYY-MM-DD') as hire_date"));
  const paid = await conn('payroll_checks as c').join('payroll_runs as r', 'r.id', 'c.run_id')
    .whereIn('c.technician_id', ids)
    .where((runs) => runs.where('r.status', 'draft').orWhereNotNull('r.finalized_at'))
    .groupBy('c.technician_id')
    .select('c.technician_id', conn.raw("to_char(MIN(c.week_start), 'YYYY-MM-DD') as week_start"));
  const firstCheck = new Map(paid.map((row) => [row.technician_id, row.week_start]));
  const firstFact = await timeOffBank.firstBankFactDays(conn, ids);
  return new Map(hired.map((row) => {
    const first = [firstCheck.get(row.id), firstFact.get(row.id)].filter(Boolean).sort()[0];
    return [row.id, row.hire_date ? [row.hire_date, first].filter(Boolean).sort()[0] : EVERY_WEEK_FROM];
  }));
}

/**
 * Works out the whole run from current data: { checks, blocked, waiting }.
 * With lock, the approved weekly rows are locked FOR UPDATE, so an unlock of
 * that week waits for this transaction (unlockWeek then sees the finalized check).
 */
async function evaluate(conn, run, { lock = false } = {}) {
  const start = run.week_start;
  const end = addStaffWorkDays(start, 6);
  const approvedQuery = conn('time_weekly_summary as w')
    .join('technicians as t', 't.id', 'w.technician_id')
    .where('w.week_start', start)
    .where('w.status', 'approved')
    .where('t.employment_type', 'w2')
    .orderBy([{ column: 't.name' }, { column: 'w.technician_id' }])
    .select('w.technician_id', 'w.regular_minutes', 'w.overtime_minutes', 't.name', 't.pay_rate', 't.pay_method',
      't.flsa_overtime_covered');
  if (lock) approvedQuery.forUpdate('w');
  const approved = await approvedQuery;
  const approvedIds = new Set(approved.map((row) => row.technician_id));

  const worked = (await workedTechnicianIds(conn, start, end)).filter((id) => !approvedIds.has(id));
  // Technicians who get no check on this run because hours they worked are not approved yet.
  const waitingIds = new Set(worked);
  const waitingRows = worked.length
    ? await conn('technicians').whereIn('id', worked).where({ employment_type: 'w2' }).orderBy('name').select('id', 'name')
    : [];
  const waiting = waitingRows.map((row) => ({
    technicianId: row.id, name: row.name, reason: 'Timesheet for this week is not approved yet',
  }));

  const workedRows = approved.filter((row) => Number(row.regular_minutes || 0) + Number(row.overtime_minutes || 0) > 0);
  let withHours = workedRows;
  // Time off rides on the worked check, or makes a check of its own when nothing
  // was worked. A technician whose worked time waits for approval stays waiting.
  let timeOffOnlyRows = [];
  if (timeOffOn()) {
    const timeOff = await timeOffByTechnician(conn, start, end);
    withHours = workedRows.map((row) => {
      const off = timeOff.get(row.technician_id);
      return { ...row, pto_minutes: off ? off.pto : 0, holiday_minutes: off ? off.holiday : 0 };
    });
    const workedIds = new Set(workedRows.map((row) => row.technician_id));
    // A technician whose time-off bank this run pays out gets a row with no time off in the week too.
    const offOrPayoutIds = new Set([...timeOff.keys(), ...(await timeOffBank.payoutTechnicianIds(conn, start))]);
    const offOnlyIds = [...offOrPayoutIds].filter((id) => !workedIds.has(id) && !waitingIds.has(id));
    if (offOnlyIds.length) {
      const techs = await conn('technicians').whereIn('id', offOnlyIds).where({ employment_type: 'w2' })
        .orderBy([{ column: 'name' }, { column: 'id' }])
        .select('id', 'name', 'pay_rate', 'pay_method', 'flsa_overtime_covered');
      timeOffOnlyRows = techs.map((row) => {
        const off = timeOff.get(row.id) || { pto: 0, holiday: 0 };
        return {
          technician_id: row.id, name: row.name, pay_rate: row.pay_rate, pay_method: row.pay_method,
          flsa_overtime_covered: row.flsa_overtime_covered,
          regular_minutes: 0, overtime_minutes: 0,
          pto_minutes: off.pto, holiday_minutes: off.holiday,
        };
      });
    }
  }
  // GATE_PAYROLL_PAY_LINES: open pay lines ride on the technician's check. A technician
  // with lines and no hours (one who has left too) gets a check for the lines alone,
  // unless their worked time is still waiting for approval.
  const lineMap = payLinesOn() ? await openLinesFor(conn, end, { lock }) : new Map();
  const priced = await priceLines(conn, lineMap, { lock });
  const haveCheck = new Set([...withHours, ...timeOffOnlyRows].map((row) => row.technician_id));
  // A line that covers an earlier week whose worked time is not approved yet cannot be
  // priced: the technician waits, and gets no check on this run until that week is approved.
  for (const [technicianId, week] of await lineWeeksWaiting(conn, priced)) {
    if (waitingIds.has(technicianId)) continue;
    waitingIds.add(technicianId);
    waiting.push({
      technicianId,
      name: lineMap.get(technicianId).tech.name,
      reason: `Timesheet for the week of ${week} is not approved yet, and a pay line covers that week`,
    });
  }
  let linesOnlyRows = [...lineMap.values()]
    .filter(({ tech }) => !haveCheck.has(tech.technician_id))
    .map(({ tech }) => ({ ...tech, regular_minutes: 0, overtime_minutes: 0, pto_minutes: 0, holiday_minutes: 0 }));
  // Time-off bank, over every row that can become a check: the bank pays the week's paid time off, the check
  // earns hours, and a pay-line-only check carries the bank figures too. A week of time off alone that the
  // bank pays nothing of makes no check unless a pay line needs one. Time off not paid is listed with its reason.
  let bankHolds = new Map();
  let unpaidTimeOff = [];
  let payouts = [];
  if (timeOffOn()) {
    const banked = await timeOffBank.applyBank(conn, [...withHours, ...timeOffOnlyRows, ...linesOnlyRows], {
      start, end, payDate: run.pay_date, lock,
    });
    ({ holds: bankHolds, unpaid: unpaidTimeOff, payouts } = banked);
    // A payout whose technician has an earlier week still to pay is held, and the run decides nothing for them.
    const payoutHolds = await payoutWaits(conn, payouts, start);
    for (const [technicianId, reason] of payoutHolds) bankHolds.set(technicianId, reason);
    unpaidTimeOff = unpaidTimeOff.filter((row) => !payoutHolds.has(row.technicianId));
    // The minimum paid week of a technician who has one (payroll-week-minimum.js): a week of time off the bank
    // could not pay in full still gets a check when the minimum adds hours to it.
    const minimum = await weekMinimum.applyMinimum(conn, banked.rows, { start, end, lock });
    const settled = minimum.rows;
    for (const [technicianId, reason] of minimum.holds) if (!bankHolds.has(technicianId)) bankHolds.set(technicianId, reason);
    const needsCheck = (row) => bankHolds.has(row.technician_id) || lineMap.has(row.technician_id)
      || Number(row.pto_minutes) + Number(row.holiday_minutes) + Number(row.minimum_week_minutes || 0) > 0;
    const offEnd = withHours.length + timeOffOnlyRows.length;
    linesOnlyRows = settled.slice(offEnd);
    timeOffOnlyRows = settled.slice(withHours.length, offEnd).filter(needsCheck);
    withHours = settled.slice(0, withHours.length);
  }
  // Each check pays the rate of ITS week (payroll-rate-steps.js); with no pay rate step the rows are unchanged.
  const payable = await withWeekRates(conn,
    [...withHours, ...timeOffOnlyRows, ...linesOnlyRows].filter((row) => !waitingIds.has(row.technician_id)), start);
  const inputs = await checkInputs(conn, run, payable.map((row) => row.technician_id), { lock });
  // GATE_PAYROLL_PRODUCTION_SHARE: the share of the run's own week, for a technician with approved hours (a check that holds only
  // time off or old pay lines pays none). The share counts in the regular rate of its own week, so a technician with a share above
  // $0 is priced again with the share as one more line of the week (payroll-production-share.js says how).
  const workedIds = new Set(withHours.map((row) => row.technician_id));
  const shareRows = payable.filter((row) => workedIds.has(row.technician_id));
  const shares = await productionSharePay.sharesFor(conn, shareRows.map((row) => row.technician_id), start);
  const sharePriced = await priceLines(conn, new Map(shareRows
    .filter((row) => shares.get(row.technician_id) && shares.get(row.technician_id).shareCents > 0)
    .map((row) => [row.technician_id, {
      tech: row,
      lines: [...((lineMap.get(row.technician_id) || {}).lines || []), productionSharePay.priceableLine(start, shares.get(row.technician_id).shareCents)],
    }])), { lock });
  // GATE_SHIFT_CLOSE_REVIEW: a week holding a shift the system closed (the
  // 11 PM job or the 14-hour check) that no admin has edited or confirmed
  // cannot be paid yet. Minutes are not changed; the line is only held.
  const unreviewed = shiftCloseReviewLive() && withHours.length
    ? new Set((await conn('time_entries')
      .whereIn('technician_id', withHours.map((row) => row.technician_id))
      .where({ entry_type: 'shift' })
      .whereNotNull('auto_closed_at')
      .whereNull('auto_close_reviewed_at')
      .whereNot({ status: 'voided' })
      .whereRaw(`${STAFF_WORK_DATE_SQL} BETWEEN ?::date AND ?::date`, [start, end])
      .distinct('technician_id')).map((row) => row.technician_id))
    : new Set();
  // The same hold for every earlier week a pay line takes its overtime from. One reason
  // per technician; the run's own week comes last, so its reason wins.
  const lineUnreviewed = shiftCloseReviewLive() ? await lineWeeksUnreviewed(conn, priced) : new Map();
  const holds = new Map([
    ...bankHolds,
    ...[...lineUnreviewed].map(([id, week]) => [id, `${AUTO_CLOSE_BLOCK_REASON} in the week of ${week}, which a pay line covers`]),
    ...[...unreviewed].map((id) => [id, AUTO_CLOSE_BLOCK_REASON]),
  ]);
  const checks = [];
  const blocked = [];
  for (const row of payable) {
    const held = lineMap.get(row.technician_id);
    const share = shares.get(row.technician_id);
    // A share that pays brings its own pricing: the technician's lines and the share, over the run's week.
    const premium = share && share.shareCents > 0 ? sharePriced.get(row.technician_id) : priced.get(row.technician_id);
    const tech = {
      ...row,
      ...(held ? { pay_lines: held.lines } : {}),
      ...(held || (share && share.shareCents > 0) ? { line_premium: premium } : {}),
      ...(share ? { production_share: share } : {}),
    };
    const hold = holds.get(tech.technician_id);
    if (hold) {
      blocked.push({ technicianId: tech.technician_id, name: tech.name, reason: hold });
      continue;
    }
    if (share && share.error) {
      blocked.push({ technicianId: tech.technician_id, name: tech.name, reason: share.error });
      continue;
    }
    const built = await buildFor(conn, run, tech, inputs);
    if (built.blocked) blocked.push({ technicianId: tech.technician_id, name: tech.name, reason: built.blocked });
    else checks.push({ ...built.check, run_id: run.id });
  }
  // The bank payouts this run decides: not for a technician who waits or is blocked, whose paycheck no run has
  // worked out yet. One with an empty bank has no check and is still on the list.
  const undecided = new Set([...waitingIds, ...blocked.map((row) => row.technicianId)]);
  const bankPayouts = payouts.filter((row) => !undecided.has(row.technicianId));
  // Every payout set for this week ends as a payout the run keeps, or as a row the run shows (waiting or blocked).
  // Finalize refuses a run that shows one, so no payout disappears without a word, whatever took the bank away.
  // The rows on screen are asked, never `waitingIds`: that set also holds people the run shows no row for (a
  // contractor with a time entry).
  if (timeOffOn()) {
    const shown = [...bankPayouts, ...waiting, ...blocked].map((row) => row.technicianId);
    blocked.push(...await timeOffBank.payoutsNoRunRead(conn, start, new Set(shown)));
  }
  return { checks, blocked, waiting, lines: lineMap, unpaidTimeOff, bankPayouts };
}

// Bank status of each finalized check (GATE_PAYROLL_BANK_MATCH): matched with the date of the
// bank line, needs the owner's pick when a suggestion names the check, else not seen yet.
async function bankStatusByCheck(conn, rows) {
  const ids = rows.map((row) => row.id);
  // a link whose expense is gone is not a match (the next pass sends the line back to review)
  const matched = new Map((await conn('bank_transactions').whereIn('matched_payroll_check_id', ids).whereNotNull('matched_expense_id')
    .select('matched_payroll_check_id', conn.raw("to_char(txn_date, 'YYYY-MM-DD') as txn_date")))
    .map((line) => [line.matched_payroll_check_id, line.txn_date]));
  const parked = await conn('bank_transactions').where({ status: 'unmatched' })
    .whereRaw("jsonb_exists(suggestion, 'payrollCandidates')").select('suggestion');
  const pickable = new Set();
  for (const line of parked) for (const c of (line.suggestion.payrollCandidates || [])) if (c.kind === 'check') pickable.add(c.id);
  return new Map(ids.map((id) => [id, matched.has(id)
    ? { state: 'matched', date: matched.get(id) }
    : { state: pickable.has(id) ? 'needs_pick' : 'not_seen' }]));
}

async function runView(conn, runId, { evaluation = null } = {}) {
  const run = await loadRun(conn, runId);
  const rows = await loadCheckRows(conn, runId);
  const bank = bankMatchOn() && run.status === 'finalized' && rows.length ? await bankStatusByCheck(conn, rows) : null;
  const mercury = mercuryStatusOn() && run.status === 'finalized' && rows.length
    ? await require('./payroll-mercury').viewForChecks(conn, run, rows) : null;
  const view = {
    id: run.id,
    weekStart: run.week_start,
    weekEnd: addStaffWorkDays(run.week_start, 6),
    payDate: run.pay_date,
    status: run.status,
    createdAt: iso(run.created_at),
    finalizedAt: iso(run.finalized_at),
    voidedAt: iso(run.voided_at),
    voidReason: run.void_reason || null,
    checks: rows.map((row) => ({
      ...serializeCheck(row),
      ...(bank ? { bank: bank.get(row.id) } : {}),
      ...(mercury ? { payment: mercury.byCheck.get(row.id) } : {}),
    })),
    ...(mercury ? { mercury: mercury.summary } : {}),
    blocked: [],
    waiting: [],
    stale: false,
    totals: sumRows(rows),
    token: tokenOf(run, rows),
  };
  // A run that is no longer a draft shows the time off it did not pay, and the bank payouts it decided, as
  // finalize kept them; a draft lists them live below.
  if (run.status !== 'draft') Object.assign(view, bankLists(run.unpaid_time_off, run.bank_payouts));
  if (run.status === 'draft') {
    const live = evaluation || await evaluate(conn, run);
    view.blocked = live.blocked;
    view.waiting = live.waiting;
    view.stale = tokenOf(run, live.checks) !== view.token;
    // Time off a time-off bank did not pay, and the bank payouts this run decides (a technician leaves). The lists
    // are of now, so the token takes them: finalize refuses once when a list changed after this view. With
    // neither, the token is the one above.
    Object.assign(view, bankLists(live.unpaidTimeOff, live.bankPayouts));
    view.token = tokenOf(run, rows, live.unpaidTimeOff, live.bankPayouts);
  }
  // plain notes about a December gift, a stay bonus or a season bonus that waits (tech-rewards-pay-lines.js waitNotes); present only when there is one
  const notes = run.status === 'voided' ? [] : await waitNotes(conn, runId);
  if (notes.length) view.techRewardsNotes = notes;
  // Stops that need review in a draft's production shares: the owner reads this before he finalizes. Present only when there is one.
  if (run.status === 'draft') {
    const reviewNotes = view.checks.map((check) => productionSharePay.reviewNote(check.name, check.productionShare && check.productionShare.needsReviewCount)).filter(Boolean);
    if (reviewNotes.length) view.productionShareNotes = reviewNotes;
  }
  return view;
}

async function listRuns(conn = db) {
  const runs = await conn('payroll_runs')
    .orderBy([{ column: 'week_start', order: 'desc' }, { column: 'created_at', order: 'desc' }])
    .limit(MAX_RUNS)
    .select(runColumns(conn));
  if (!runs.length) return [];
  const rows = await conn('payroll_checks').whereIn('run_id', runs.map((run) => run.id))
    .select(['run_id', ...MONEY_KEYS, ...(timeOffOn() ? TIME_OFF_PAY_COLUMNS : []), 'minimum_week_minutes', 'minimum_week_pay_cents', 'production_share_cents']);
  const byRun = new Map();
  for (const row of rows) {
    if (!byRun.has(row.run_id)) byRun.set(row.run_id, []);
    byRun.get(row.run_id).push(row);
  }
  return runs.map((run) => ({
    id: run.id,
    weekStart: run.week_start,
    weekEnd: addStaffWorkDays(run.week_start, 6),
    payDate: run.pay_date,
    status: run.status,
    createdAt: iso(run.created_at),
    finalizedAt: iso(run.finalized_at),
    voidedAt: iso(run.voided_at),
    totals: sumRows(byRun.get(run.id) || []),
  }));
}

async function getRun(runId, conn = db) {
  requireUuid(runId, 'Pay run');
  return runView(conn, runId);
}

// ---- Writing

const audit = (trx, actorId, action, resourceType, resourceId, metadata) => recordAuditEvent({
  trx, critical: true, actor_type: 'admin', actor_id: actorId, action, resource_type: resourceType, resource_id: resourceId, metadata,
});

async function replaceDraftChecks(trx, runId, checks) {
  await trx('payroll_checks').where({ run_id: runId, status: 'draft' }).del();
  if (checks.length) await trx('payroll_checks').insert(checks);
}

function describeProblems({ blocked, waiting }) {
  const parts = [
    ...waiting.map((w) => `${w.name}: ${w.reason}`),
    ...blocked.map((b) => `${b.name}: ${b.reason}`),
  ];
  return `Fix these before you finalize. ${parts.join('. ')}.`;
}

// Review bonus lines follow the payouts (GATE_PAYROLL_REVIEW_BONUS_IMPORT). Called inside a pay run
// transaction after the payroll lock and before evaluate().
const syncReviewBonuses = (trx, weekStart, actorId) => syncReviewBonusLines(trx, {
  weekEnd: addStaffWorkDays(weekStart, 6), lock: true, actorId,
});

// Commission lines follow the commission ledger (GATE_PAYROLL_COMMISSION_LEDGER), at the same three points.
// Pay rate steps that are due are applied at those points too (applyDueSteps, payroll-rate-steps.js).
const syncCommission = (trx, weekStart, actorId) => syncCommissionLines(trx, {
  weekEnd: addStaffWorkDays(weekStart, 6), lock: true, actorId,
});

// Tech Rewards lines (GATE_TECH_REWARDS_PAY_LINES, GATE_TECH_REWARDS_STAY_BONUS, GATE_TECH_REWARDS_SEASON_BONUS), at the same three points. Takes the run row. It runs after applyDueSteps:
// it asks whether a check can be worked out for the technician, and a pay rate step that is due changes that answer.
// `seasonScores`: the season score figures a season bonus is worked out from (readSeasonScores, readSeasonScoresOfRun). Each
// run write reads them BEFORE its transaction opens, in one snapshot whose connection is given back first, so a pay run never
// holds the payroll lock while it waits for a second connection. The sync reads each score again under the lock and holds a
// bonus whose score changed in between. Null, and nothing read, on a run dated for no season bonus.
const syncTechRewards = (trx, run, actorId, seasonScores) => syncTechRewardLines(run, trx, { actorId, seasonScores });
// The Tech Rewards lines a void or a finalize took off (dropRewardLinesOfWeek), for that event's audit row: ids only. The key is
// absent when there were none, so every other run's event is unchanged.
const removedRewards = (ids) => (ids.length ? { tech_rewards_line_ids_removed: ids } : {});

// The payroll lock comes before the run row, the order finalizeRun uses. Pay lines need it, and so does a pay
// rate step that is due (applyDueSteps changes technicians.pay_rate). Time off needs it too: the evaluation
// locks the week's approved rows and then the rows of the technicians who have a time-off bank, and a manual
// shift entry takes this lock before it locks its technician row and reads the week. Without it the two can
// deadlock. `today` is read once per run write, so the answer here and in applyDueSteps is the same. With no
// step due and both gates off, no lock is taken.
async function lockRunWrite(trx, today) {
  if (payLinesOn() || timeOffOn() || productionSharePay.shareOn() || await hasDueSteps(trx, today)) await lockPayrollMutations(trx);
}

async function draftRun(input, actor, conn = db) {
  const v = validate(createSchema, input);
  const { start, end } = validateWeek(v.weekStart);
  const payDate = resolvePayDate(start, end, v.payDate);
  const actorId = actorOf(actor);
  const taken = new PayrollError(409, 'That week already has a pay run. Open it, or void it first.');
  const today = etDateString();
  const seasonScores = await readSeasonScores(conn, payDate);
  let runId;
  try {
    runId = await conn.transaction(async (trx) => {
      await lockRunWrite(trx, today);
      if (await trx('payroll_runs').where({ week_start: start }).whereNot({ status: 'voided' }).forUpdate().first('id')) throw taken;
      const [inserted] = await trx('payroll_runs').insert({ week_start: start, pay_date: payDate, created_by: actorId }).returning('id');
      const id = inserted && inserted.id ? inserted.id : inserted;
      const run = await loadRun(trx, id);
      await syncReviewBonuses(trx, start, actorId);
      await syncCommission(trx, start, actorId);
      await applyDueSteps(trx, { today });
      await syncTechRewards(trx, run, actorId, seasonScores);
      const evaluation = await evaluate(trx, run, { lock: true });
      // A week whose time off a time-off bank did not pay still gets a run, also with no paycheck: finalizing it
      // closes the week, so the unpaid decision is kept and those hours stop waiting for a pay run. The same for a
      // week whose only decision is the payout of an empty bank: finalizing it settles the owner's instruction.
      if (!evaluation.checks.length && !evaluation.blocked.length && !evaluation.waiting.length && !decidesWithNoCheck(evaluation)) {
        // No run is kept (this rolls back), so there is no screen to list a waiting Tech Rewards line on: the message says
        // each one, with its reason and the last pay date that can add it. Read before the rollback takes the run row.
        const waitingRewards = await waitNotes(trx, id);
        throw new PayrollError(409, ['No W-2 hours to pay for that week.', ...waitingRewards.map((note) => `${note}.`)].join(' '));
      }
      await replaceDraftChecks(trx, id, evaluation.checks);
      await audit(trx, actorId, 'payroll.run_drafted', 'payroll_runs', id, { run_id: id });
      return id;
    });
  } catch (err) {
    if (err && err.code === '23505') throw taken;
    throw err;
  }
  return runView(conn, runId);
}

async function recomputeRun(runId, actor, conn = db) {
  requireUuid(runId, 'Pay run');
  const actorId = actorOf(actor);
  const today = etDateString();
  const seasonScores = await readSeasonScoresOfRun(conn, runId);
  await conn.transaction(async (trx) => {
    await lockRunWrite(trx, today);
    const run = await loadRun(trx, runId, { lock: true });
    if (run.status !== 'draft') throw new PayrollError(409, 'Only a draft pay run can be recomputed.');
    await syncReviewBonuses(trx, run.week_start, actorId);
    await syncCommission(trx, run.week_start, actorId);
    await applyDueSteps(trx, { today });
    await syncTechRewards(trx, run, actorId, seasonScores);
    const evaluation = await evaluate(trx, run, { lock: true });
    await replaceDraftChecks(trx, runId, evaluation.checks);
    await audit(trx, actorId, 'payroll.run_recomputed', 'payroll_runs', runId, { run_id: runId });
  });
  return runView(conn, runId);
}

// One lock for every payroll mutation that reads or changes year-to-date
// figures: finalize and void. Each run locks only its own rows, so two runs for
// different weeks could otherwise both read the same YTD, or a void could pass
// while a later finalize counted the run it voids. Same idiom as
// payment-method-lock.js: pg_advisory_xact_lock(hashtext(ns), hashtext(key)),
// released when the transaction ends. Take it before the first read.
// Draft and recompute do not take it: they write draft rows only, never feed
// another run, and finalize re-evaluates under this lock and compares the
// review token, so a draft built on stale YTD cannot be finalized. With
// GATE_PAYROLL_PAY_LINES on they do take it: their evaluation locks pay lines
// and the weekly timesheets of earlier weeks, rows two runs for different weeks
// share, so without one lock two drafts could deadlock on them.
// The lock itself lives in payroll-lock.js (time-tracking.js takes it shared).

// A later finalized check for the same technician and year already counted this
// one's pay in its year-to-date figures.
async function laterFinalCheckExists(trx, run, technicianIds) {
  if (!technicianIds.length) return false;
  const year = run.pay_date.slice(0, 4);
  const found = await trx('payroll_checks')
    .where('status', 'finalized')
    .whereIn('technician_id', technicianIds)
    .where('pay_date', '>=', `${year}-01-01`)
    .where('pay_date', '<=', `${year}-12-31`)
    .where(function later() {
      this.where('pay_date', '>', run.pay_date).orWhere(function sameDay() {
        this.where('pay_date', run.pay_date).andWhere('week_start', '>', run.week_start);
      });
    })
    .whereNot({ run_id: run.id })
    .first('id');
  return Boolean(found);
}

async function finalizeRun(runId, input, actor, conn = db) {
  requireUuid(runId, 'Pay run');
  const v = validate(finalizeSchema, input);
  const actorId = actorOf(actor);
  let changed = false;
  const seasonScores = await readSeasonScoresOfRun(conn, runId);
  await conn.transaction(async (trx) => {
    await lockPayrollMutations(trx);
    const run = await loadRun(trx, runId, { lock: true });
    if (run.status !== 'draft') throw new PayrollError(409, `This pay run is already ${run.status}.`);
    await syncReviewBonuses(trx, run.week_start, actorId);
    await syncCommission(trx, run.week_start, actorId);
    await applyDueSteps(trx);
    await syncTechRewards(trx, run, actorId, seasonScores);
    const evaluation = await evaluate(trx, run, { lock: true });
    if (evaluation.blocked.length || evaluation.waiting.length) throw new PayrollError(409, describeProblems(evaluation));
    // A run with no paycheck can still close a week whose time off was not paid, or settle the payout of an empty
    // bank (see draftRun). The token check below then covers a draft whose checks are gone.
    if (!evaluation.checks.length && !decidesWithNoCheck(evaluation)) {
      // A draft can still show checks that are gone: its only checks rode on a pay line that another run has paid since. Keep
      // the fresh, empty numbers as the draft, as the token check below does, so the screen shows what changed.
      if (!(await loadCheckRows(trx, runId)).length) throw new PayrollError(409, 'There are no paychecks to finalize.');
      await replaceDraftChecks(trx, runId, []);
      changed = true;
      await audit(trx, actorId, 'payroll.run_recomputed', 'payroll_runs', runId, { run_id: runId });
      return;
    }
    // The time-off bank, in any year. "Later" is the bank's order, the pay date first.
    // A technician whose bank this run pays out is asked too, also with no check here: the run read an empty bank,
    // and a final check of theirs that is later in the bank's order (an earlier week on a later pay date) holds
    // hours this payout did not see. And a payout is for the hours through its own week: it waits when a final
    // run for a later week holds a bank check of theirs or paid their bank out, also on an earlier pay date.
    const paidOut = evaluation.bankPayouts.map((row) => row.technicianId);
    const banked = [...new Set([...evaluation.checks.filter(storedBank).map((check) => check.technician_id), ...paidOut])];
    if (await timeOffBank.laterWeekBankCheckExists(trx, run, paidOut)) {
      throw new PayrollError(409, 'A later pay run is already final. Void it first, then finalize this one.');
    }
    // A later final run paid out the technician's bank (also an empty one, with no check). Asked before the guard
    // of the tax year below, which refuses the same run with fewer words: this refusal names the way that needs no
    // void. On a pay date after that run's, this run comes after the payout, and a check for a week before the
    // payout week is a catch-up check (payroll-time-off-bank.js paidOutInLaterWeek).
    // Every technician with a check here is asked, also one with no yearly hours now: the hours can be cleared after
    // a payout, and a plain check before it on an earlier pay date would pay time off the payout never saw.
    const checked = evaluation.checks.map((check) => check.technician_id);
    if (await timeOffBank.laterPayoutDecisionExists(trx, run, [...new Set([...banked, ...checked])])) {
      throw new PayrollError(409, LATER_RUN_PAID_OUT);
    }
    if (await laterFinalCheckExists(trx, run, evaluation.checks.map((check) => check.technician_id))) {
      throw new PayrollError(409, 'A later pay run is already final. Void it first, then finalize this one.');
    }
    // A later check already read the bank without this run, or a later final run already left time off of the
    // technician unpaid from it (with or without a check).
    if (await timeOffBank.laterBankCheckExists(trx, run, banked) || await timeOffBank.laterUnpaidDecisionExists(trx, run, banked)) {
      throw new PayrollError(409, 'A later pay run is already final. Void it first, then finalize this one.');
    }
    await replaceDraftChecks(trx, runId, evaluation.checks);
    const rows = await loadCheckRows(trx, runId);
    if (tokenOf(run, rows, evaluation.unpaidTimeOff, evaluation.bankPayouts) !== v.token) {
      // Keep the fresh numbers as the draft, so the screen shows what changed.
      changed = true;
      await audit(trx, actorId, 'payroll.run_recomputed', 'payroll_runs', runId, { run_id: runId });
      return;
    }
    // The time off this run does not pay stays on the run: a technician it names can have no check to show it.
    // Written while the row is still a draft; the row is frozen once it is final.
    if (evaluation.unpaidTimeOff.length) {
      await trx('payroll_runs').where({ id: runId }).update({ unpaid_time_off: JSON.stringify(evaluation.unpaidTimeOff) });
    }
    // The bank payouts this run decides stay on the run too: the technician's payout week can move to another week
    // later, and a payout of an empty bank has no check.
    if (evaluation.bankPayouts.length) {
      await trx('payroll_runs').where({ id: runId }).update({ bank_payouts: JSON.stringify(evaluation.bankPayouts) });
    }
    const now = trx.fn.now();
    await trx('payroll_checks').where({ run_id: runId, status: 'draft' }).update({ status: 'finalized' });
    // The lines this run paid stay locked from the evaluation above; mark them paid with their check.
    if (payLinesOn()) await markLinesPaid(trx, runId, evaluation.lines, actorId);
    // A finalized run keeps no open Tech Rewards line: one this run did not pay (pay lines turned off since it was written)
    // comes off, so the next run dated for it writes it. Not behind the gate.
    const droppedRewards = await dropRewardLinesOfWeek(trx, run.week_start);
    await trx('payroll_runs').where({ id: runId }).update({ status: 'finalized', finalized_by: actorId, finalized_at: now });
    await audit(trx, actorId, 'payroll.run_finalized', 'payroll_runs', runId, { run_id: runId, ...removedRewards(droppedRewards) });
  });
  if (changed) throw new PayrollError(409, 'Hours or settings changed. Review the new numbers.');
  // Tax calendar rows follow the finalized checks. Never fails the finalize.
  await syncPayrollFilingsSafe({ conn });
  return runView(conn, runId);
}

// The technicians a FINAL run decided something for in the time-off bank, as voidRun asks the order guards:
// { banked, paidOut }, the two lists of finalizeRun, and keptPaidOut, the payouts on the run's row. Read from the
// run's checks and its row, never from today's settings, and not behind the gate.
async function bankDecisionsOfRun(trx, run) {
  const keptPaidOut = await timeOffBank.keptPayoutsOfRun(trx, run.id);
  const paidOut = [...new Set([...keptPaidOut, ...await timeOffBank.payoutTechnicianIds(trx, run.week_start)])];
  const banked = [...new Set([...await timeOffBank.bankTechniciansOfRun(trx, run.id), ...paidOut])];
  return { banked, paidOut, keptPaidOut };
}

async function voidRun(runId, input, actor, conn = db) {
  requireUuid(runId, 'Pay run');
  const v = validate(voidSchema, input);
  const actorId = actorOf(actor);
  await conn.transaction(async (trx) => {
    await lockPayrollMutations(trx);
    const run = await loadRun(trx, runId, { lock: true });
    if (run.status === 'voided') throw new PayrollError(409, 'This pay run is already voided.');
    const rows = await loadCheckRows(trx, runId, { lock: true });
    if (run.status === 'finalized' && await laterFinalCheckExists(trx, run, rows.map((row) => row.technician_id))) {
      throw new PayrollError(409, 'A later pay run is already final. Void it first.');
    }
    // The same for the time-off bank, in any year: a later check read the bank with this run in it, or a later final
    // run left time off unpaid that the hours this void gives back would have paid (the 16 early illness hours too),
    // or a later final run paid out the technician's bank (also an empty one, with no check).
    // Not behind the gate: a check that holds a bank counts in later checks either way.
    // The technicians are the ones finalizeRun asks, read from what the run kept: the checks that hold a bank and
    // the payouts on its row (also of an empty bank, with no check). A void also opens again every payout set for
    // this week (one the run kept, and one it missed), so those technicians are asked as paid out: under a later
    // final check of theirs that payout could never be made final again, and it would hold their next paychecks
    // (payoutsNotFinal). Time off the run kept as not paid, with no check, changed nothing in the bank: it is not asked.
    const { banked, paidOut, keptPaidOut } = run.status === 'finalized'
      ? await bankDecisionsOfRun(trx, run) : { banked: [], paidOut: [], keptPaidOut: [] };
    if (await timeOffBank.laterBankCheckExists(trx, run, banked) || await timeOffBank.laterUnpaidDecisionExists(trx, run, banked)
      // The payout guard asks every technician with a final check here, as finalizeRun does: the redo of a plain check
      // on its own pay date would be refused under that payout. A draft decided nothing.
      || await timeOffBank.laterPayoutDecisionExists(trx, run, run.status === 'finalized'
        ? [...new Set([...banked, ...rows.map((row) => row.technician_id)])] : banked)
      || await timeOffBank.laterWeekBankCheckExists(trx, run, paidOut)) {
      throw new PayrollError(409, 'A later pay run is already final. Void it first.');
    }
    // The void puts the payouts this run paid back on its week. It waits while one is set for another week now.
    const elsewhere = await timeOffBank.payoutsSetElsewhere(trx, run.week_start, keptPaidOut);
    if (elsewhere.length) throw new PayrollError(409, timeOffBank.payoutSetElsewhereReason(elsewhere[0]));
    // A paid stay bonus or season bonus on a later check was worked out from this run's pay (tech-rewards-pay-lines.js
    // paidBonusCounting): the run that paid the bonus goes first, in another tax year too. Not behind a gate.
    const countedBy = run.status === 'finalized' ? await paidBonusCounting(trx, run) : null;
    if (countedBy) {
      throw new PayrollError(409, `A ${countedBy === 'season_bonus' ? 'season' : 'stay'} bonus on another paycheck was worked out from this pay run. Void the pay run that paid the bonus first.`);
    }
    // Money may be on its way through Mercury: not behind a gate, so turning the gates off never lets a void through.
    await require('./payroll-mercury').assertNoOpenPayments(trx, rows.map((row) => row.id));
    await trx('payroll_checks').where({ run_id: runId }).whereIn('status', ['draft', 'finalized']).update({ status: 'voided' });
    // Not behind the gate: a line a finalized run paid must reopen even if the gate was turned off since.
    await reopenLinesOfRun(trx, runId);
    // A Tech Rewards line belongs to the run that wrote it: voiding the run takes it off (open, or reopened from paid), and the next
    // run dated for it writes it again. Not behind the gate: a voided run must never leave one waiting for another run.
    const droppedRewards = await dropRewardLinesOfWeek(trx, run.week_start);
    await trx('payroll_runs').where({ id: runId }).update({
      status: 'voided', voided_by: actorId, voided_at: trx.fn.now(), void_reason: v.reason,
    });
    // A payout this run had paid is the owner's decision for this week, so the void puts it back as "set for this
    // week" where the technician has no payout week now (the owner set another week later and took that one back;
    // while that other week is still set, the void is refused above). The run made again for this week then pays
    // the bank out, or the owner presses "Do not pay out": the wages are never paid again with the payout dropped
    // without a word. Not behind the gate.
    const reopened = await timeOffBank.reopenPayouts(trx, run.week_start, keptPaidOut);
    await audit(trx, actorId, 'payroll.run_voided', 'payroll_runs', runId, {
      run_id: runId, ...removedRewards(droppedRewards), ...(reopened.length ? { bank_payouts_reopened: reopened } : {}),
    });
  });
  await syncPayrollFilingsSafe({ conn });
  // Bank lines matched to this run's checks go back to review. Never fails the void.
  if (bankMatchOn()) {
    try {
      await require('./bank-import').releaseVoidedPayrollLinks();
    } catch (err) {
      require('./logger').warn(`[payroll-runs] bank lines of a voided run not released: ${err.code || err.name || 'error'}`);
    }
  }
  return runView(conn, runId);
}

async function setCheckNumber(checkId, input, actor, conn = db) {
  requireUuid(checkId, 'Paycheck');
  const v = validate(checkNumberSchema, input);
  const actorId = actorOf(actor);
  await conn.transaction(async (trx) => {
    const check = await trx('payroll_checks').where({ id: checkId }).forUpdate().first('id', 'run_id', 'status', 'pay_method');
    if (!check) throw new PayrollError(404, 'Paycheck not found.');
    if (check.status !== 'finalized') throw new PayrollError(409, 'A check number can be set once the pay run is final.');
    if (check.pay_method !== 'check') throw new PayrollError(409, 'Check numbers are for paper checks only.');
    await trx('payroll_checks').where({ id: checkId }).update({ check_number: v.checkNumber });
    await audit(trx, actorId, 'payroll.check_number_set', 'payroll_checks', checkId, { check_id: checkId, run_id: check.run_id });
  });
  const row = await conn('payroll_checks').where({ id: checkId }).first(checkColumns(conn));
  return serializeCheck(row);
}

// ---- Stub

// The breakdown a stub prints under its production share line: no stop rows, nothing about a customer.
const stubShare = (figures, shareCents) => ({
  creditedCents: figures.creditedCents, barCents: figures.barCents, aboveBarCents: figures.aboveBarCents,
  rateBps: figures.rateBps, barType: figures.barType, shifts: figures.shifts, shareCents,
});

async function getStub(checkId, conn = db) {
  requireUuid(checkId, 'Paycheck');
  const check = await conn('payroll_checks').where({ id: checkId }).first(checkColumns(conn));
  if (!check) throw new PayrollError(404, 'Paycheck not found.');
  if (check.status === 'draft') throw new PayrollError(409, 'Finalize the pay run to see the stub.');
  if (check.status === 'voided') throw new PayrollError(409, 'This paycheck was voided.');
  const tech = await conn('technicians').where({ id: check.technician_id }).first('ssn_last4');
  const ssnLast4 = tech && /^\d{4}$/.test(String(tech.ssn_last4 || '')) ? String(tech.ssn_last4) : null;
  const year = check.pay_date.slice(0, 4);
  const ytd = await conn('payroll_checks')
    .where({ technician_id: check.technician_id, status: 'finalized' })
    .where('pay_date', '>=', `${year}-01-01`)
    .where('pay_date', '<=', `${year}-12-31`)
    .where(function upToThis() {
      this.where('pay_date', '<', check.pay_date).orWhere(function sameDay() {
        this.where('pay_date', check.pay_date).andWhere('week_start', '<=', check.week_start);
      });
    })
    .first(
      conn.raw('COALESCE(SUM(gross_cents), 0) AS gross'),
      conn.raw('COALESCE(SUM(federal_income_tax_cents), 0) AS federal_income_tax'),
      conn.raw('COALESCE(SUM(social_security_cents), 0) AS social_security'),
      conn.raw('COALESCE(SUM(medicare_cents), 0) AS medicare'),
      conn.raw('COALESCE(SUM(additional_medicare_cents), 0) AS additional_medicare'),
      conn.raw('COALESCE(SUM(net_cents), 0) AS net'),
      conn.raw('COALESCE(SUM(simple_deferral_cents), 0) AS simple_ira'),
    );
  const [paid] = await withPaperPayments(conn, [check]);
  const c = serializeCheck(paid);
  // Gate on, or a check that stored pay line figures (drafted while it was on).
  const withLines = 'reviewBonusCents' in c;
  const withheld = c.federalIncomeTaxCents + c.socialSecurityCents + c.medicareCents + c.additionalMedicareCents;
  return {
    checkId: c.id,
    runId: check.run_id,
    employer: { name: WAVES_BUSINESS_NAME, addressLine: WAVES_ADDRESS_LINE },
    employee: { name: c.name, ssnLast4 },
    payPeriod: { start: check.week_start, end: addStaffWorkDays(check.week_start, 6) },
    payDate: check.pay_date,
    hours: {
      regular: c.regularHours,
      overtime: c.overtimeHours,
      ...(timeOffOn() ? { pto: c.ptoHours, holiday: c.holidayHours } : {}),
      ...(c.minimumWeekHours === undefined ? {} : { minimumWeek: c.minimumWeekHours }),
    },
    hourlyRate: c.hourlyRate,
    earnings: {
      regularPayCents: c.regularPayCents,
      overtimePayCents: c.overtimePayCents,
      ...(timeOffOn() ? { ptoPayCents: c.ptoPayCents, holidayPayCents: c.holidayPayCents } : {}),
      ...(c.minimumWeekPayCents === undefined ? {} : { minimumWeekPayCents: c.minimumWeekPayCents }),
      // The production share and how it was worked out (credited, bar, above the bar, rate); only on a check that paid one.
      ...(c.productionShareCents > 0 ? { productionShareCents: c.productionShareCents, productionShare: stubShare(c.productionShare, c.productionShareCents) } : {}),
      ...(withLines ? {
        reviewBonusCents: c.reviewBonusCents,
        commissionCents: c.commissionCents,
        healthAllowanceCents: c.healthAllowanceCents,
        ...(c.techRewardsCents === undefined ? {} : { techRewardsCents: c.techRewardsCents }),
        lineOvertimePremiumCents: c.lineOvertimePremiumCents,
      } : {}),
      grossCents: c.grossCents,
    },
    // The employer HSA money is not wages: it is not in gross pay, taxes or net pay.
    ...(withLines ? { employerContributions: { hsaCents: c.hsaEmployerCents } } : {}),
    taxes: {
      federalIncomeTaxCents: c.federalIncomeTaxCents,
      socialSecurityCents: c.socialSecurityCents,
      medicareCents: c.medicareCents,
      additionalMedicareCents: c.additionalMedicareCents,
      totalCents: withheld,
    },
    // SIMPLE IRA savings (before income tax) come out of pay after the taxes; only on a participant's check.
    ...(c.simpleDeferralCents === undefined ? {} : { preTaxDeductions: { simpleIraCents: c.simpleDeferralCents } }),
    netCents: c.netCents,
    payMethod: c.payMethod,
    checkNumber: c.checkNumber,
    ...(c.w4Default ? { w4Default: true } : {}),
    // Time-off bank after this check; only on a check of a technician with a bank.
    ...(c.timeOffBank ? { timeOffBank: c.timeOffBank } : {}),
    ytd: {
      grossCents: Number(ytd.gross),
      federalIncomeTaxCents: Number(ytd.federal_income_tax),
      socialSecurityCents: Number(ytd.social_security),
      medicareCents: Number(ytd.medicare),
      additionalMedicareCents: Number(ytd.additional_medicare),
      netCents: Number(ytd.net),
      // Also on a later check with no savings, once the year holds some: the year's column still adds up.
      ...(Number(ytd.simple_ira) > 0 || c.simpleDeferralCents !== undefined ? { simpleIraCents: Number(ytd.simple_ira) } : {}),
    },
  };
}

// ---- A technician's own stubs (GATE_TECH_PAY_STUBS, routes/tech-payroll.js)

const TECH_CHECK_LIMIT = 60;

// The caller's own checks from finalized, not-voided runs, newest pay date first. The technician id comes from the
// authenticated session; nothing here reads a client-sent id.
async function listOwnChecks(technicianId, conn = db) {
  const rows = await conn('payroll_checks as c')
    .join('payroll_runs as r', 'r.id', 'c.run_id')
    .where('c.technician_id', technicianId)
    .where('c.status', 'finalized')
    .where('r.status', 'finalized')
    .orderBy([{ column: 'c.pay_date', order: 'desc' }, { column: 'c.week_start', order: 'desc' }])
    .limit(TECH_CHECK_LIMIT)
    .select([
      'c.id', 'c.employee_name', 'c.hourly_rate', 'c.regular_minutes', 'c.overtime_minutes', 'c.pay_method',
      ...MONEY_KEYS.map((key) => `c.${key}`), ...(timeOffOn() ? TIME_OFF_COLUMNS.map((key) => `c.${key}`) : []),
      conn.raw("to_char(c.week_start, 'YYYY-MM-DD') as week_start"),
      conn.raw("to_char(c.pay_date, 'YYYY-MM-DD') as pay_date"),
    ]);
  return (await withPaperPayments(conn, rows)).map((row) => {
    const c = serializeCheck(row);
    return {
      id: c.id,
      name: c.name,
      weekStart: row.week_start,
      payDate: row.pay_date,
      grossCents: c.grossCents,
      netCents: c.netCents,
      regularHours: c.regularHours,
      overtimeHours: c.overtimeHours,
      ...(timeOffOn() ? { ptoHours: c.ptoHours, holidayHours: c.holidayHours } : {}),
      payMethod: c.payMethod,
    };
  });
}

// The stub of one of the caller's own checks. Another person's check, a draft, a voided check and an unknown or
// malformed id all answer 404, so ids cannot be probed.
async function getOwnStub(technicianId, checkId, conn = db) {
  if (!UUID_RE.test(String(checkId || ''))) throw new PayrollError(404, 'Pay stub not found.');
  const own = await conn('payroll_checks as c')
    .join('payroll_runs as r', 'r.id', 'c.run_id')
    .where({ 'c.id': checkId, 'c.technician_id': technicianId, 'c.status': 'finalized', 'r.status': 'finalized' })
    .first('c.id');
  if (!own) throw new PayrollError(404, 'Pay stub not found.');
  return getStub(checkId, conn);
}

// ---- CSV

const CSV_HEADERS = [
  'Employee', 'Regular Hours', 'Overtime Hours', 'Hourly Rate', 'Gross Pay', 'Federal Income Tax',
  'Social Security', 'Medicare', 'Additional Medicare', 'Net Pay', 'Employer Social Security',
  'Employer Medicare', 'FUTA', 'FL Reemployment Tax', 'Pay Method', 'Check Number',
];

// Appended at the END, gate on only, so a reader of the old columns keeps working.
const CSV_TIME_OFF_HEADERS = ['PTO Hours', 'PTO Pay', 'Holiday Hours', 'Holiday Pay'];
// After those, gate GATE_PAYROLL_PAY_LINES on only. HSA From Waves is not in Gross Pay.
const CSV_PAY_LINE_HEADERS = ['Review Bonus', 'Commission', 'Health Allowance', 'Overtime On Bonus And Allowance', 'HSA From Waves'];
// Only when a check in the run holds a season bonus, stay bonus or December gift. It is in Gross Pay.
const CSV_TECH_REWARDS_HEADERS = ['Tech Rewards Bonus'];
// Only when a check in the run has a minimum paid week. The pay is in Gross Pay; the hours are not hours worked.
const CSV_MINIMUM_WEEK_HEADERS = ['Minimum Week Hours', 'Minimum Week Pay'];
// Before the SIMPLE IRA column, only when a check in the run paid a production share. It is in Gross Pay.
const CSV_PRODUCTION_SHARE_HEADERS = ['Production Share'];
// Last, only when a check in the run has SIMPLE IRA savings. It is in Gross Pay and comes out of Net Pay.
const CSV_SIMPLE_HEADERS = ['SIMPLE IRA Savings'];

function checksToCsv(rows) {
  const withTimeOff = timeOffOn();
  // Gate on, or a check in the run that stored pay line figures (drafted while it was on).
  const withLines = payLinesOn() || rows.some(storedLines);
  const withSimple = rows.some(storedSimple);
  const withTechRewards = withLines && rows.some((row) => row.tech_rewards_cents != null);
  const withMinimum = rows.some((row) => row.minimum_week_minutes != null);
  const withShare = rows.some((row) => Number(row.production_share_cents) > 0);
  const lines = [csvRow([...CSV_HEADERS, ...(withTimeOff ? CSV_TIME_OFF_HEADERS : []), ...(withLines ? CSV_PAY_LINE_HEADERS : []), ...(withTechRewards ? CSV_TECH_REWARDS_HEADERS : []), ...(withMinimum ? CSV_MINIMUM_WEEK_HEADERS : []), ...(withShare ? CSV_PRODUCTION_SHARE_HEADERS : []), ...(withSimple ? CSV_SIMPLE_HEADERS : [])])];
  for (const row of rows) {
    const c = serializeCheck(row);
    lines.push(csvRow([
      c.name, c.regularHours, c.overtimeHours, c.hourlyRate, centsText(c.grossCents),
      centsText(c.federalIncomeTaxCents), centsText(c.socialSecurityCents), centsText(c.medicareCents),
      centsText(c.additionalMedicareCents), centsText(c.netCents), centsText(c.employerSocialSecurityCents),
      centsText(c.employerMedicareCents), centsText(c.futaCents), centsText(c.flReemploymentCents),
      c.payMethod === 'bank_transfer' ? 'Bank transfer' : 'Paper check', c.checkNumber || '',
      ...(withTimeOff ? [c.ptoHours, centsText(c.ptoPayCents), c.holidayHours, centsText(c.holidayPayCents)] : []),
      ...(withLines ? [
        centsText(c.reviewBonusCents), centsText(c.commissionCents), centsText(c.healthAllowanceCents),
        centsText(c.lineOvertimePremiumCents), centsText(c.hsaEmployerCents),
      ] : []),
      ...(withTechRewards ? [centsText(c.techRewardsCents || 0)] : []),
      ...(withMinimum ? [c.minimumWeekHours || '0.00', centsText(c.minimumWeekPayCents || 0)] : []),
      ...(withShare ? [centsText(c.productionShareCents || 0)] : []),
      ...(withSimple ? [centsText(c.simpleDeferralCents || 0)] : []),
    ]));
  }
  return lines.join('\n');
}

async function exportCsv(runId, conn = db) {
  requireUuid(runId, 'Pay run');
  const run = await loadRun(conn, runId);
  if (run.status === 'voided') throw new PayrollError(409, 'This pay run was voided.');
  const rows = await withPaperPayments(conn, await loadCheckRows(conn, runId));
  return { filename: `pay-run-${run.week_start}.csv`, csv: checksToCsv(rows) };
}

module.exports = {
  workedWeeks,
  weekStartSql,
  lineGuardWeek,
  lineOnlyCheckProblem,
  laterFinalCheckExists,
  defaultPayDate,
  validateWeek,
  resolvePayDate,
  centsText,
  buildCheck,
  ytdBefore,
  tokenOf,
  checksToCsv,
  listRuns,
  getRun,
  draftRun,
  recomputeRun,
  finalizeRun,
  voidRun,
  setCheckNumber,
  getStub,
  listOwnChecks,
  getOwnStub,
  exportCsv,
  lockPayrollMutations,
  PAYROLL_LOCK_NS,
  PAYROLL_LOCK_KEY,
};

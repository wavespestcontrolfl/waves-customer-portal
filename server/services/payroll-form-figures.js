/**
 * Basic payroll, layer 3a (GATE_PAYROLL_FORM_FIGURES, owner 2026-10-25, "can we
 * start building basic now, and add layers to it at later stages?"): the
 * line-by-line figures the owner types onto Form 941 (one quarter), the Florida
 * RT-6 (one quarter), Form 940 (one year) and each employee's W-2 with the W-3
 * totals (one year). The portal prepares numbers. It files, pays and sends
 * nothing, and it fills in no PDF (a later layer).
 *
 * Sources and rules:
 * - Only FINALIZED payroll_checks (status = 'finalized', the predicate that
 *   payroll-runs.js ytdBefore and payroll-tax-calendar.js use; a void sets the
 *   checks and the run to 'voided' in one transaction, so a voided or draft
 *   check is never read). Every period follows the PAY DATE, because wages are
 *   taxed when paid.
 * - Figures come from the stored check rows. No paycheck is worked out again.
 *   Rates and wage bases come from payroll-calc.js (TAX_YEARS, RATES). Money is
 *   integer cents until display. Half a cent rounds up.
 * - Deposits (941 line 13, 940 line 13) are the Tax page calendar rows of layer
 *   2 that the owner marked paid. Layer 2 writes no Form 940 deposit row, so
 *   940 line 13 reads rows keyed 'payroll:940_deposit:<year>' and finds none.
 * - Form 940 line 10 is 0 only when every quarter's Florida reemployment tax
 *   is marked paid in full on the Tax page by the Form 940 due date. Else
 *   lines 10, 12, 14, 15 and Part 5 read "Needs your check": tax paid late or
 *   not paid cuts the FUTA credit (IRS line 10 worksheet), and the portal does
 *   not work that worksheet.
 * - The 12th rule: a check counts for a month's 12th when week_start <= the
 *   12th <= week_start + 6. Only checks paid in the quarter are counted.
 * - No full SSN, EIN, bank or routing number is held or shown. Every form field
 *   that needs one reads "Enter from your records".
 * - A year or quarter with no checks returns zeros, not an error.
 */
const db = require('../models/db');
const { TAX_YEARS, RATES } = require('./payroll-calc');
const { PayrollError } = require('./payroll-w4');
const { rollIrs } = require('./payroll-tax-calendar');
// The pay week's last day, as payroll-runs.js works it out (Codex #6770 r1).
const { addStaffWorkDays } = require('../utils/staff-time-work-date');
const { WAVES_BUSINESS_NAME, WAVES_ADDRESS_LINE } = require('../constants/business');

const FROM_RECORDS = 'Enter from your records';
const DEPOSIT_LABEL = 'deposits recorded as paid on the Tax page';
const NEEDS_CHECK = 'Needs your check';
const FORM_941_SCHEDULE_THRESHOLD_CENTS = 250000;
// Pub 15 section 11: the $100,000 next-day deposit rule and the $50,000 lookback limit.
const NEXT_DAY_DEPOSIT_CENTS = 10000000;
const LOOKBACK_LIMIT_CENTS = 5000000;
const FORM_940_PART_5_THRESHOLD_CENTS = 50000;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const num = (value) => Number(value) || 0;
const max0 = (n) => (n > 0 ? n : 0);
const pad = (n) => String(n).padStart(2, '0');
// Half-up rounding of cents x basis points / 10,000 (cents are non-negative integers).
const pct = (cents, bp) => Math.floor((cents * bp + 5000) / 10000);
const pctText = (bp) => `${(bp / 100).toFixed(bp % 10 === 0 ? 1 : 2)}%`;
const centsText = (cents) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const monthOf = (check) => Number(check.payDate.slice(5, 7));
const quarterOfMonth = (month) => Math.ceil(month / 3);

// The 12th rule: the pay week holds the 12th of (year, month).
function weekHoldsTwelfth(check, year, month) {
  const twelfth = `${year}-${pad(month)}-12`;
  return check.weekStart <= twelfth && twelfth <= addStaffWorkDays(check.weekStart, 6);
}

function employeesOnTwelfth(checks, year, month) {
  return new Set(checks.filter((c) => weekHoldsTwelfth(c, year, month)).map((c) => c.technicianId)).size;
}

function socialSecurityWageBaseCents(year) {
  const tables = TAX_YEARS[year];
  if (!tables) throw new Error(`No Social Security wage base for ${year}`);
  return Math.round(tables.socialSecurityWageBase * 100);
}

// One stored check as plain numbers, with the three wage splits the forms need.
function normalize(row, wageBaseCents) {
  const gross = num(row.gross_cents);
  const ytd = num(row.ytd_gross_before_cents);
  const threshold = RATES.additionalMedicareThresholdCents;
  const capWages = Math.min(gross, max0(RATES.futaAndStateWageBaseCents - ytd));
  let snapshot = row.calc_snapshot;
  if (typeof snapshot === 'string') {
    try { snapshot = JSON.parse(snapshot); } catch { snapshot = null; }
  }
  return {
    technicianId: row.technician_id,
    name: row.employee_name,
    weekStart: row.week_start,
    payDate: row.pay_date,
    gross,
    overtimePremium: num(row.overtime_premium_cents),
    fit: num(row.federal_income_tax_cents),
    ssEmployee: num(row.social_security_cents),
    medicareEmployee: num(row.medicare_cents),
    addlMedicare: num(row.additional_medicare_cents),
    ssEmployer: num(row.employer_social_security_cents),
    medicareEmployer: num(row.employer_medicare_cents),
    futa: num(row.futa_cents),
    flReemployment: num(row.fl_reemployment_cents),
    ssWages: Math.min(gross, max0(wageBaseCents - ytd)),
    addlMedicareWages: max0(ytd + gross - threshold) - max0(ytd - threshold),
    capWages,
    excessWages: gross - capWages,
    snapshot,
  };
}

const sum = (checks, key) => checks.reduce((total, c) => total + c[key], 0);
// Every tax the 941 deposit covers: withheld income tax plus both halves of Social Security and Medicare.
const liabilityOf = (c) => c.fit + c.ssEmployee + c.medicareEmployee + c.addlMedicare + c.ssEmployer + c.medicareEmployer;

const row = (line, label, kind, value, extra = {}) => ({ line, label, kind, value, ...extra });
const cents = (line, label, value, extra) => row(line, label, 'cents', value, extra);
const count = (line, label, value, extra) => row(line, label, 'count', value, extra);
const text = (line, label, value, extra) => row(line, label, 'text', value, extra);

/**
 * Makes `values` (per month or per quarter) total `target` with no negative
 * entry and no cents on an entry that has none: extra cents go to the last
 * entry above zero, and missing cents come off the latest entries first, none
 * below zero (pre-push audit P1). Returns the new values and the difference.
 */
function spreadRounding(values, target) {
  const out = [...values];
  const rounding = target - out.reduce((acc, v) => acc + v, 0);
  if (rounding > 0) {
    let last = out.length - 1;
    while (last > 0 && out[last] <= 0) last -= 1;
    out[last] += rounding;
  } else {
    let missing = -rounding;
    for (let i = out.length - 1; i >= 0 && missing > 0; i -= 1) {
      const take = Math.min(Math.max(out[i], 0), missing);
      out[i] -= take;
      missing -= take;
    }
  }
  return { values: out, rounding };
}

/**
 * Splits line 12 over the quarter's three months. The months come from the
 * paychecks (the employer half rounded per check); line 12 takes the employer
 * share from line 5e. Any difference is spread by spreadRounding.
 */
function monthlyLiabilityLines(line12Cents, monthCents) {
  const { values, rounding } = spreadRounding(monthCents, line12Cents);
  return { months: values, rounding };
}

// Lines 2 to 12 of Form 941 for one quarter's checks.
function quarterTaxes(quarterChecks) {
  const wages = sum(quarterChecks, 'gross');
  const fit = sum(quarterChecks, 'fit');
  const ssWages = sum(quarterChecks, 'ssWages');
  const addlWages = sum(quarterChecks, 'addlMedicareWages');
  const ssTax = pct(ssWages, 2 * RATES.socialSecurityBp);
  const medicareTax = pct(wages, 2 * RATES.medicareBp);
  const addlTax = pct(addlWages, RATES.additionalMedicareBp);
  const line5e = ssTax + medicareTax + addlTax;
  const line6 = fit + line5e;
  // Line 7 (Form 941 instructions) is the fractions of cents in the EMPLOYEE
  // share only: the Social Security, Medicare and Additional Medicare the
  // paychecks withheld, less the employee share of line 5e figured on the
  // quarter's wages. The employer share is what line 5e leaves; its per-check
  // rounding is no adjustment (pre-push audit P0).
  const withheld = sum(quarterChecks, 'ssEmployee') + sum(quarterChecks, 'medicareEmployee') + sum(quarterChecks, 'addlMedicare');
  const employeeShare = pct(ssWages, RATES.socialSecurityBp) + pct(wages, RATES.medicareBp) + addlTax;
  const line7 = withheld - employeeShare;
  const line10 = line6 + line7;
  return { wages, fit, ssWages, addlWages, ssTax, medicareTax, addlTax, line5e, line6, line7, line10, line12: line10 };
}

/**
 * Form 941 line 16 (Form 941 instructions; Pub 15 section 11). Inputs come
 * from the stored checks: this quarter's line 12, the prior quarter's line 12,
 * the lookback period's tax (July 1 two years back to June 30 last year: the
 * four quarters' line 12) and each month's tax ('YYYY-MM' => cents) last year
 * and this year through the quarter's end. A month is a monthly depositor's
 * deposit period, so a month reaching $100,000 is a next-day deposit
 * obligation, and the employer is a semiweekly depositor from then on through
 * the next year.
 *   - A next-day obligation in this quarter: semiweekly (Schedule B).
 *   - Else line 12 under $2,500, or the prior quarter's under $2,500 while this
 *     one is under $100,000: no schedule (box 1).
 *   - Else a lookback over $50,000, or an earlier next-day obligation:
 *     semiweekly (Schedule B). The portal does not fill Schedule B.
 *   - Else monthly (box 2). A new employer's lookback is $0.
 */
function depositSchedule({ year, quarter, line12, priorQuarterLine12, lookbackCents, monthCents }) {
  const firstMonth = `${year}-${pad((quarter - 1) * 3 + 1)}`;
  const lastMonth = `${year}-${pad(quarter * 3)}`;
  const nextDay = [...monthCents.entries()]
    .filter(([month, value]) => value >= NEXT_DAY_DEPOSIT_CENTS && month <= lastMonth)
    .map(([month]) => month)
    .sort();
  const inQuarter = nextDay.find((month) => month >= firstMonth);
  if (inQuarter) return { kind: 'semiweekly', reason: `The tax for ${inQuarter} reached $100,000, so a next-day deposit was due.` };
  if (line12 < FORM_941_SCHEDULE_THRESHOLD_CENTS) return { kind: 'none', reason: 'Line 12 is less than $2,500: no schedule is needed' };
  if (priorQuarterLine12 < FORM_941_SCHEDULE_THRESHOLD_CENTS && line12 < NEXT_DAY_DEPOSIT_CENTS) {
    return { kind: 'none', reason: 'Line 12 of the prior quarter was less than $2,500: no schedule is needed' };
  }
  if (nextDay.length) return { kind: 'semiweekly', reason: `The tax for ${nextDay[0]} reached $100,000, so you have been a semiweekly depositor since then.` };
  if (lookbackCents > LOOKBACK_LIMIT_CENTS) return { kind: 'semiweekly', reason: `The lookback period holds ${centsText(lookbackCents)} of tax, more than $50,000.` };
  return { kind: 'monthly', reason: `The lookback period holds ${centsText(lookbackCents)} of tax, $50,000 or less, and no month reached $100,000.` };
}

function form941(year, quarter, quarterChecks, depositsCents, history) {
  const months = [1, 2, 3].map((n) => (quarter - 1) * 3 + n);
  const { wages, fit, ssWages, addlWages, ssTax, medicareTax, addlTax, line5e, line6, line7, line10, line12 } = quarterTaxes(quarterChecks);
  const line14 = max0(line12 - depositsCents);
  const line15 = max0(depositsCents - line12);

  const rows = [
    count('1', 'Number of employees who received wages, tips, or other compensation for the pay period including March 12, June 12, September 12, or December 12', employeesOnTwelfth(quarterChecks, year, months[2])),
    cents('2', 'Wages, tips, and other compensation', wages),
    cents('3', 'Federal income tax withheld from wages, tips, and other compensation', fit),
    cents('5a', 'Taxable social security wages (column 1) and tax (column 2)', ssWages, { rate: pctText(2 * RATES.socialSecurityBp), value2: ssTax }),
    cents('5b', 'Taxable social security tips', 0, { rate: pctText(2 * RATES.socialSecurityBp), value2: 0 }),
    cents('5c', 'Taxable Medicare wages and tips', wages, { rate: pctText(2 * RATES.medicareBp), value2: medicareTax }),
    cents('5d', 'Taxable wages and tips subject to Additional Medicare Tax withholding', addlWages, { rate: pctText(RATES.additionalMedicareBp), value2: addlTax }),
    cents('5e', 'Total social security and Medicare taxes (5a + 5b + 5c + 5d, column 2)', line5e),
    cents('5f', 'Section 3121(q) Notice and Demand: tax due on unreported tips', 0),
    cents('6', 'Total taxes before adjustments (lines 3 + 5e + 5f)', line6),
    cents('7', 'Current quarter’s adjustment for fractions of cents', line7, { note: 'The employee Social Security and Medicare the paychecks withheld, less the employee share of line 5e. It can be negative.' }),
    cents('8', 'Current quarter’s adjustment for sick pay', 0),
    cents('9', 'Current quarter’s adjustments for tips and group-term life insurance', 0),
    cents('10', 'Total taxes after adjustments (lines 6 + 7 + 8 + 9)', line10),
    cents('11', 'Qualified small business payroll tax credit for increasing research activities', 0),
    cents('12', 'Total taxes after adjustments and credits (line 10 minus line 11)', line12),
    cents('13', `Total deposits for this quarter (${DEPOSIT_LABEL})`, depositsCents),
    cents('14', 'Balance due (line 12 minus line 13, if line 12 is more)', line14),
    cents('15', 'Overpayment (line 13 minus line 12, if line 13 is more)', line15),
  ];
  const notes = [];

  const schedule = depositSchedule({ year, quarter, line12, ...history });
  const lookbackText = `The lookback period is July 1, ${year - 2} to June 30, ${year - 1}. These figures come from the portal's pay checks; tax reported outside the portal counts too.`;
  if (schedule.kind === 'none') {
    rows.push(text('16', 'Deposit schedule', schedule.reason));
  } else if (schedule.kind === 'semiweekly') {
    // Pre-push audit P1: never label a semiweekly depositor monthly.
    rows.push(text('16', 'Deposit schedule', NEEDS_CHECK, {
      note: `${schedule.reason} A semiweekly schedule depositor files Schedule B (Form 941) instead of the monthly lines. The portal does not fill it in.`,
    }));
    notes.push(lookbackText);
  } else {
    const monthCents = months.map((month) => quarterChecks
      .filter((c) => monthOf(c) === month)
      .reduce((total, c) => total + liabilityOf(c), 0));
    const split = monthlyLiabilityLines(line12, monthCents);
    rows.push(text('16', 'Deposit schedule', 'Monthly schedule depositor', { note: schedule.reason }));
    notes.push(lookbackText);
    split.months.forEach((value, index) => {
      rows.push(cents(`16 month ${index + 1}`, `Tax liability for month ${index + 1} (${MONTH_NAMES[months[index] - 1]})`, value));
    });
    rows.push(cents('16 total', 'Total liability for the quarter (must equal line 12)', line12));
    if (split.rounding > 0) notes.push(`The months include a rounding difference of ${split.rounding} cents, added to the last month with tax, so they total line 12.`);
    if (split.rounding < 0) notes.push(`The months include a rounding difference of ${-split.rounding} cents, taken off the latest months with tax, none below zero, so they total line 12.`);
  }
  notes.push('Line 13 counts only deposits you marked paid on the Tax page. A deposit you made but did not mark there is missing.');
  return { form: '941', year, quarter, rows, notes };
}

// The Florida rate each check used: the stored `floridaReemploymentRateBp`
// (written since tax forms layer 3a), else the calculator's new-employer rate,
// which is the only rate pay runs have ever passed (payroll-runs.js passes no
// reemploymentRateBp). Never rebuilt from a rounded tax: dividing a rounded
// cent amount by taxable wages can miss the rate (pre-push audit P1).
function rt6Rate(quarterChecks) {
  const rates = new Map();
  for (const c of quarterChecks) {
    if (!c.capWages) continue;
    const stored = c.snapshot && Number(c.snapshot.floridaReemploymentRateBp);
    const bp = Number.isInteger(stored) && stored >= 0 ? stored : RATES.floridaNewEmployerBp;
    rates.set(bp, (rates.get(bp) || 0) + c.capWages);
  }
  if (!rates.size) return { bp: null, distinct: [] };
  // More than one rate in a quarter (a rate notice mid-quarter): the rate on
  // the most taxable wages leads, and a note lists them all.
  const [bp] = [...rates.entries()].sort((a, b) => b[1] - a[1])[0];
  return { bp, distinct: [...rates.keys()].sort((a, b) => a - b) };
}

// RT-6 line 5 is line 4 times the rate, rounded once on the quarter's taxable
// wages (Florida RT-6 instructions), not the sum of per-paycheck rounding.
function rt6Tax(quarterChecks) {
  const gross = sum(quarterChecks, 'gross');
  const excess = sum(quarterChecks, 'excessWages');
  const checkTax = sum(quarterChecks, 'flReemployment');
  const { bp, distinct } = rt6Rate(quarterChecks);
  const tax = bp == null ? 0 : pct(gross - excess, bp);
  return { gross, excess, checkTax, rateBp: bp, distinct, tax };
}

function formRt6(year, quarter, quarterChecks) {
  const months = [1, 2, 3].map((n) => (quarter - 1) * 3 + n);
  const { gross, excess, checkTax, rateBp, distinct, tax } = rt6Tax(quarterChecks);
  const rows = months.map((month, index) => count(`1 month ${index + 1}`, `Covered employees, ${MONTH_NAMES[month - 1]}`, employeesOnTwelfth(quarterChecks, year, month)));
  rows.push(
    cents('2', 'Gross wages', gross),
    cents('3', 'Excess wages over the $7,000 wage base', excess),
    cents('4', 'Taxable wages (line 2 minus line 3)', gross - excess),
    cents('5', 'Tax due (line 4 times the rate)', tax, {
      rate: rateBp == null ? null : pctText(rateBp),
      note: [
        rateBp == null ? `No taxable wages this quarter. New employers start at ${pctText(RATES.floridaNewEmployerBp)}.`
          : 'The rate the paychecks used.',
        checkTax !== tax ? `The paychecks charged ${centsText(checkTax)}; the difference is per-paycheck rounding.` : null,
      ].filter(Boolean).join(' '),
    }),
  );
  const byEmployee = new Map();
  for (const c of quarterChecks) {
    const e = byEmployee.get(c.technicianId) || { name: c.name, grossCents: 0, taxableCents: 0 };
    e.name = c.name;
    e.grossCents += c.gross;
    e.taxableCents += c.capWages;
    byEmployee.set(c.technicianId, e);
  }
  const employees = [...byEmployee.values()]
    .map((e) => ({ ...e, ssn: FROM_RECORDS }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const notes = [];
  if (distinct.length > 1) notes.push(`The paychecks used more than one rate: ${distinct.map(pctText).join(', ')}.`);
  return { form: 'RT-6', year, quarter, rows, employees, notes };
}

const quarterChecksOf = (yearChecks, q) => yearChecks.filter((c) => quarterOfMonth(monthOf(c)) === q);

/**
 * Form 940 line 10 (IRS Form 940 instructions): state unemployment tax paid
 * after the due date for filing Form 940, or not paid, cuts the credit. The
 * quarters whose Florida tax is NOT marked paid in full on the Tax page by that
 * date (January 31 of the next year, moved past a weekend or legal holiday).
 * A quarter's Florida tax is the RT-6 line 5 figure, in full: the IRS gives
 * the full credit only when all of it is paid (pre-push audit P1; a cent short
 * of line 5 is not paid in full, even when the paychecks charged that much).
 * rt6Paid: the year's RT-6 calendar rows marked paid (base and balance rows)
 * as { source_key, amount_paid, paid_date }.
 */
function floridaQuartersNotPaidOnTime(year, yearChecks, rt6Paid) {
  const dueDate = rollIrs(`${year + 1}-01-31`);
  const open = [];
  for (const q of [1, 2, 3, 4]) {
    const owed = rt6Tax(quarterChecksOf(yearChecks, q)).tax;
    if (owed <= 0) continue;
    const prefix = `payroll:rt6:${year}-Q${q}`;
    const paid = rt6Paid
      .filter((r) => (r.source_key === prefix || String(r.source_key).startsWith(`${prefix}:balance:`))
        && r.paid_date && String(r.paid_date).slice(0, 10) <= dueDate)
      .reduce((acc, r) => acc + Math.round(num(r.amount_paid) * 100), 0);
    if (paid < owed) open.push(q);
  }
  return { dueDate, open };
}

function form940(year, yearChecks, depositsCents, rt6Paid = []) {
  const total = sum(yearChecks, 'gross');
  const byEmployee = new Map();
  for (const c of yearChecks) byEmployee.set(c.technicianId, (byEmployee.get(c.technicianId) || 0) + c.gross);
  const line5 = [...byEmployee.values()].reduce((acc, gross) => acc + max0(gross - RATES.futaAndStateWageBaseCents), 0);
  const line6 = line5;
  const line7 = total - line6;
  const line8 = pct(line7, RATES.futaBp);
  const line12 = line8;
  const line14 = max0(line12 - depositsCents);
  const line15 = max0(depositsCents - line12);
  const florida = floridaQuartersNotPaidOnTime(year, yearChecks, rt6Paid);
  // Line 10 is 0 only when every quarter's Florida tax is marked paid on time.
  // Otherwise lines 10, 12, 14, 15 and Part 5 are not final, so they show no
  // amount to copy (pre-push audit P1).
  const verified = florida.open.length === 0;
  const dueText = florida.dueDate;
  const line10 = verified
    ? cents('10', 'Adjustment if you did not pay all state unemployment tax by the due date', 0,
      yearChecks.length ? { note: `Florida reemployment tax for every quarter is marked paid on the Tax page by ${dueText}.` } : undefined)
    : text('10', 'Adjustment if you did not pay all state unemployment tax by the due date', NEEDS_CHECK, {
      note: `Florida reemployment tax for ${florida.open.map((q) => `Q${q}`).join(', ')} is not marked paid in full (RT-6 line 5) on the Tax page by ${dueText}. Tax paid late or not paid cuts the credit: use the line 10 worksheet in the Form 940 instructions.`,
    });
  const dependent = (line, label, value) => (verified ? cents(line, label, value) : text(line, label, NEEDS_CHECK, { note: 'Depends on line 10.' }));
  const rows = [
    text('1a', 'State where you paid wages', 'FL'),
    cents('3', 'Total payments to all employees', total),
    cents('4', 'Payments exempt from FUTA tax', 0),
    cents('5', 'Payments of more than $7,000 to each employee', line5),
    cents('6', 'Subtotal (lines 4 + 5)', line6),
    cents('7', 'Total taxable FUTA wages (line 3 minus line 6)', line7),
    cents('8', 'FUTA tax before adjustments', line8, { rate: pctText(RATES.futaBp) }),
    cents('9', 'Adjustment if some state wages were exempt from state unemployment tax', 0),
    line10,
    cents('11', 'Credit reduction for employees in a credit reduction state', 0, { note: 'Check Florida against the IRS credit reduction list every year. This line stays 0 unless Florida is on it.' }),
    dependent('12', 'Total FUTA tax after adjustments (lines 8 + 9 + 10 + 11)', line12),
    cents('13', `FUTA tax deposited for the year (${DEPOSIT_LABEL})`, depositsCents),
    dependent('14', 'Balance due (line 12 minus line 13, if line 12 is more)', line14),
    dependent('15', 'Overpayment (line 13 minus line 12, if line 13 is more)', line15),
  ];
  const notes = ['Line 13 counts only deposits you marked paid on the Tax page. The Tax page calendar does not yet write a Form 940 deposit row, so this is 0 unless a row was added.'];
  if (!verified) {
    // Part 5 totals line 12, so it waits for line 10 too.
    notes.push(line12 > FORM_940_PART_5_THRESHOLD_CENTS
      ? 'Part 5 (lines 16 and 17) is needed because line 8 is more than $500. Fill it in after line 10 is checked: line 17 must equal line 12.'
      : 'Part 5 is needed only if line 12 is more than $500. Decide after line 10 is checked.');
  } else if (line12 > FORM_940_PART_5_THRESHOLD_CENTS) {
    // The checks round FUTA per paycheck; line 12 rounds the year's taxable
    // wages once. Line 17 must equal line 12, so spreadRounding moves the cent
    // difference without a negative quarter or cents on a quarter with no FUTA.
    const { values: byQuarter, rounding } = spreadRounding([1, 2, 3, 4].map((q) => sum(quarterChecksOf(yearChecks, q), 'futa')), line12);
    rows.push(
      cents('16a', 'FUTA liability, 1st quarter (January to March)', byQuarter[0]),
      cents('16b', 'FUTA liability, 2nd quarter (April to June)', byQuarter[1]),
      cents('16c', 'FUTA liability, 3rd quarter (July to September)', byQuarter[2]),
      cents('16d', 'FUTA liability, 4th quarter (October to December)', byQuarter[3]),
      cents('17', 'Total tax liability for the year (must equal line 12)', byQuarter.reduce((acc, v) => acc + v, 0)),
    );
    let roundingText = '';
    if (rounding > 0) roundingText = ` The paychecks round FUTA per check, so the ${rounding} cent difference is added to the last quarter with FUTA.`;
    if (rounding < 0) roundingText = ` The paychecks round FUTA per check, so the ${-rounding} cent difference comes off the latest quarters with FUTA, none below zero.`;
    notes.push(`Part 5 is shown because line 12 is more than $500.${roundingText} Line 17 equals line 12.`);
  } else {
    notes.push('Part 5 is not needed because line 12 is $500 or less.');
  }
  return { form: '940', year, rows, notes };
}

function w2Figures(yearChecks, addresses) {
  const grouped = new Map();
  for (const c of yearChecks) {
    const list = grouped.get(c.technicianId) || [];
    list.push(c);
    grouped.set(c.technicianId, list);
  }
  const forms = [...grouped.entries()].map(([technicianId, checks]) => {
    const latest = checks.reduce((a, b) => (b.payDate >= a.payDate ? b : a));
    const tt = sum(checks, 'overtimePremium');
    return {
      technicianId,
      name: latest.name,
      address: addresses.get(technicianId) || null,
      ssn: FROM_RECORDS,
      box1: sum(checks, 'gross'),
      box2: sum(checks, 'fit'),
      box3: sum(checks, 'ssWages'),
      box4: sum(checks, 'ssEmployee'),
      box5: sum(checks, 'gross'),
      box6: sum(checks, 'medicareEmployee') + sum(checks, 'addlMedicare'),
      box12TT: tt > 0 ? tt : null,
      state: 'Florida has no state income tax: boxes 15 to 17 stay empty.',
    };
  });
  return forms.sort((a, b) => a.name.localeCompare(b.name));
}

// The W-3 carries no box 12 code TT total: the IRS W-2/W-3 instructions keep
// qualified overtime on each employee's W-2 only.
function w3Totals(forms) {
  const total = (key) => forms.reduce((acc, f) => acc + f[key], 0);
  return {
    boxC: forms.length,
    box1: total('box1'),
    box2: total('box2'),
    box3: total('box3'),
    box4: total('box4'),
    box5: total('box5'),
    box6: total('box6'),
  };
}

/**
 * Pure aggregation. rows are payroll_checks rows (finalized only, pay_date in
 * `year`, dates as YYYY-MM-DD text); deposits are paid calendar rows as
 * { source_key, amount_paid, amount_due }.
 */
function buildFormFigures({ year, quarter, rows = [], priorRows = [], deposits941 = [], deposits940 = [], rt6Paid = [], addresses = new Map() }) {
  // Each check takes its own pay year's Social Security wage base.
  const normalizeYear = (list, y) => {
    const wageBase = list.length ? socialSecurityWageBaseCents(y) : 0;
    return list.map((r) => normalize(r, wageBase));
  };
  const yearChecks = normalizeYear(rows, year);
  const priorChecks = [year - 2, year - 1].flatMap((y) => normalizeYear(priorRows.filter((r) => String(r.pay_date).startsWith(`${y}-`)), y));
  const quarterChecks = yearChecks.filter((c) => quarterOfMonth(monthOf(c)) === quarter);
  const allChecks = [...priorChecks, ...yearChecks];
  const line12Of = (y, q) => quarterTaxes(allChecks.filter((c) => c.payDate.startsWith(`${y}-`) && quarterOfMonth(monthOf(c)) === q)).line12;
  const quarterEnd = `${year}-${pad(quarter * 3)}`;
  const monthCents = new Map();
  for (const c of allChecks) {
    const month = c.payDate.slice(0, 7);
    if (month < `${year - 1}-01` || month > quarterEnd) continue;
    monthCents.set(month, (monthCents.get(month) || 0) + liabilityOf(c));
  }
  const history = {
    priorQuarterLine12: quarter === 1 ? line12Of(year - 1, 4) : line12Of(year, quarter - 1),
    lookbackCents: line12Of(year - 2, 3) + line12Of(year - 2, 4) + line12Of(year - 1, 1) + line12Of(year - 1, 2),
    monthCents,
  };
  const depositTotal = (list) => list.reduce((acc, d) => acc + Math.round(num(d.amount_paid ?? d.amount_due) * 100), 0);
  const w2 = w2Figures(yearChecks, addresses);
  return {
    year,
    quarter,
    employer: { name: WAVES_BUSINESS_NAME, address: WAVES_ADDRESS_LINE, ein: FROM_RECORDS },
    f941: form941(year, quarter, quarterChecks, depositTotal(deposits941), history),
    rt6: formRt6(year, quarter, quarterChecks),
    f940: form940(year, yearChecks, depositTotal(deposits940), rt6Paid),
    w2,
    w3: w3Totals(w2),
  };
}

const CHECK_COLUMNS = [
  'technician_id', 'employee_name', 'gross_cents', 'overtime_premium_cents', 'federal_income_tax_cents',
  'social_security_cents', 'medicare_cents', 'additional_medicare_cents', 'employer_social_security_cents',
  'employer_medicare_cents', 'futa_cents', 'fl_reemployment_cents', 'ytd_gross_before_cents', 'calc_snapshot',
];

// Paid deposit rows of layer 2 for one kind and a set of periods. A balance row
// ('<row>:balance:<n>') is a deposit too. Status 'paid' is the owner's mark.
async function paidDeposits(conn, kind, periods) {
  const pattern = `^payroll:${kind}:(${periods.join('|')})(:balance:[0-9]+)?$`;
  return conn('tax_filing_calendar')
    .where({ status: 'paid' })
    .whereRaw('source_key ~ ?', [pattern])
    .select('source_key', 'amount_paid', 'amount_due');
}

// The year's RT-6 rows marked paid (base and balance rows; a review row holds
// no payment), with the day each was marked paid, for Form 940 line 10.
async function paidRt6Rows(conn, year) {
  return conn('tax_filing_calendar')
    .where({ status: 'paid' })
    .whereRaw('source_key ~ ?', [`^payroll:rt6:${year}-Q[1-4](:balance:[0-9]+)?$`])
    .select('source_key', 'amount_paid', conn.raw("to_char(paid_date, 'YYYY-MM-DD') AS paid_date"));
}

/** The route's read: year and quarter are already validated integers. */
async function readFormFigures({ year, quarter, conn = db }) {
  const rows = await conn('payroll_checks')
    .where({ status: 'finalized' })
    .where('pay_date', '>=', `${year}-01-01`)
    .where('pay_date', '<=', `${year}-12-31`)
    .select(
      ...CHECK_COLUMNS,
      conn.raw("to_char(week_start, 'YYYY-MM-DD') AS week_start"),
      conn.raw("to_char(pay_date, 'YYYY-MM-DD') AS pay_date"),
    );
  // Form 941 line 16 also reads the lookback period and last year (July 1 two
  // years back through December 31 last year).
  const priorRows = await conn('payroll_checks')
    .where({ status: 'finalized' })
    .where('pay_date', '>=', `${year - 2}-07-01`)
    .where('pay_date', '<=', `${year - 1}-12-31`)
    .select(
      ...CHECK_COLUMNS,
      conn.raw("to_char(week_start, 'YYYY-MM-DD') AS week_start"),
      conn.raw("to_char(pay_date, 'YYYY-MM-DD') AS pay_date"),
    );
  const quarterMonths = [1, 2, 3].map((n) => `${year}-${pad((quarter - 1) * 3 + n)}`);
  const deposits941 = await paidDeposits(conn, '941_deposit', quarterMonths);
  const deposits940 = await paidDeposits(conn, '940_deposit', [String(year)]);
  const rt6Paid = await paidRt6Rows(conn, year);
  const ids = [...new Set(rows.map((r) => r.technician_id))];
  const addresses = new Map();
  if (ids.length) {
    const techs = await conn('technicians').whereIn('id', ids).select('id', 'address');
    for (const t of techs) {
      const address = String(t.address || '').trim();
      if (address) addresses.set(t.id, address);
    }
  }
  return buildFormFigures({ year, quarter, rows, priorRows, deposits941, deposits940, rt6Paid, addresses });
}

/** Query-string check: a 4-digit year from 2020 on and a quarter 1 to 4. */
function parseFormPeriod(query = {}) {
  const yearText = String(query.year ?? '');
  const quarterText = String(query.quarter ?? '');
  if (!/^\d{4}$/.test(yearText) || Number(yearText) < 2020 || Number(yearText) > 2100) {
    throw new PayrollError(400, 'year must be a four-digit year, 2020 or later.');
  }
  if (!/^[1-4]$/.test(quarterText)) throw new PayrollError(400, 'quarter must be 1, 2, 3 or 4.');
  return { year: Number(yearText), quarter: Number(quarterText) };
}

module.exports = { buildFormFigures, readFormFigures, parseFormPeriod, monthlyLiabilityLines, depositSchedule, FROM_RECORDS };

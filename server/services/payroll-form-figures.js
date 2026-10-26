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
 * - The 12th rule: a check counts for a month's 12th when week_start <= the
 *   12th <= week_start + 6. Only checks paid in the quarter are counted.
 * - No full SSN, EIN, bank or routing number is held or shown. Every form field
 *   that needs one reads "Enter from your records".
 * - A year or quarter with no checks returns zeros, not an error.
 */
const db = require('../models/db');
const { TAX_YEARS, RATES } = require('./payroll-calc');
const { PayrollError } = require('./payroll-w4');
const { WAVES_BUSINESS_NAME, WAVES_ADDRESS_LINE } = require('../constants/business');

const FROM_RECORDS = 'Enter from your records';
const DEPOSIT_LABEL = 'deposits recorded as paid on the Tax page';
const FORM_941_SCHEDULE_THRESHOLD_CENTS = 250000;
const FORM_940_PART_5_THRESHOLD_CENTS = 50000;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const num = (value) => Number(value) || 0;
const max0 = (n) => (n > 0 ? n : 0);
const pad = (n) => String(n).padStart(2, '0');
// Half-up rounding of cents x basis points / 10,000 (cents are non-negative integers).
const pct = (cents, bp) => Math.floor((cents * bp + 5000) / 10000);
const pctText = (bp) => `${(bp / 100).toFixed(bp % 10 === 0 ? 1 : 2)}%`;

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const monthOf = (check) => Number(check.payDate.slice(5, 7));
const quarterOfMonth = (month) => Math.ceil(month / 3);

// The 12th rule: the pay week holds the 12th of (year, month).
function weekHoldsTwelfth(check, year, month) {
  const twelfth = `${year}-${pad(month)}-12`;
  return check.weekStart <= twelfth && twelfth <= addDays(check.weekStart, 6);
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
 * Splits line 12 over the quarter's three months. The months already add up to
 * line 12 (both come from the stored tax columns); any difference still goes
 * into month 3.
 */
function monthlyLiabilityLines(line12Cents, monthCents) {
  const first = monthCents[0];
  const second = monthCents[1];
  const third = line12Cents - first - second;
  return { months: [first, second, third], monthThreeAdjustment: third - monthCents[2] };
}

function form941(year, quarter, quarterChecks, depositsCents) {
  const months = [1, 2, 3].map((n) => (quarter - 1) * 3 + n);
  const wages = sum(quarterChecks, 'gross');
  const fit = sum(quarterChecks, 'fit');
  const ssWages = sum(quarterChecks, 'ssWages');
  const addlWages = sum(quarterChecks, 'addlMedicareWages');
  const ssTax = pct(ssWages, 2 * RATES.socialSecurityBp);
  const medicareTax = pct(wages, 2 * RATES.medicareBp);
  const addlTax = pct(addlWages, RATES.additionalMedicareBp);
  const line5e = ssTax + medicareTax + addlTax;
  const line6 = fit + line5e;
  const stored = quarterChecks.reduce((total, c) => total + c.ssEmployee + c.medicareEmployee + c.addlMedicare + c.ssEmployer + c.medicareEmployer, 0);
  const line7 = stored - line5e;
  const line10 = line6 + line7;
  const line12 = line10;
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
    cents('7', 'Current quarter’s adjustment for fractions of cents', line7, { note: 'The cents the paychecks collected, less the form’s own rounding of line 5e. It can be negative.' }),
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

  if (line12 < FORM_941_SCHEDULE_THRESHOLD_CENTS) {
    rows.push(text('16', 'Deposit schedule', 'Line 12 is less than $2,500: no schedule is needed'));
  } else {
    const monthCents = months.map((month) => quarterChecks
      .filter((c) => monthOf(c) === month)
      .reduce((total, c) => total + liabilityOf(c), 0));
    const split = monthlyLiabilityLines(line12, monthCents);
    rows.push(text('16', 'Deposit schedule', 'Monthly schedule depositor (a new employer is monthly in its first year)'));
    split.months.forEach((value, index) => {
      rows.push(cents(`16 month ${index + 1}`, `Tax liability for month ${index + 1} (${MONTH_NAMES[months[index] - 1]})`, value));
    });
    rows.push(cents('16 total', 'Total liability for the quarter (must equal line 12)', line12));
    if (split.monthThreeAdjustment !== 0) {
      notes.push(`Month 3 includes a rounding difference of ${split.monthThreeAdjustment} cents so the three months total line 12.`);
    }
  }
  notes.push('Line 13 counts only deposits you marked paid on the Tax page. A deposit you made but did not mark there is missing.');
  return { form: '941', year, quarter, rows, notes };
}

function rt6Rate(quarterChecks) {
  const rates = new Map();
  let widest = null;
  for (const c of quarterChecks) {
    const snap = c.snapshot;
    const tax = snap && num(snap.floridaReemploymentCents);
    const cap = snap && snap.taxableWages && num(snap.taxableWages.floridaReemploymentCents);
    if (!cap || !tax) continue;
    const bp = Math.round((tax * 10000) / cap);
    if (!widest || cap > widest.cap) widest = { cap, bp };
    rates.set(bp, (rates.get(bp) || 0) + 1);
  }
  if (!rates.size) return { bp: null, distinct: [] };
  return { bp: widest.bp, distinct: [...rates.keys()].sort((a, b) => a - b) };
}

function formRt6(year, quarter, quarterChecks) {
  const months = [1, 2, 3].map((n) => (quarter - 1) * 3 + n);
  const gross = sum(quarterChecks, 'gross');
  const excess = sum(quarterChecks, 'excessWages');
  const tax = sum(quarterChecks, 'flReemployment');
  const { bp, distinct } = rt6Rate(quarterChecks);
  const rows = months.map((month, index) => count(`1 month ${index + 1}`, `Covered employees, ${MONTH_NAMES[month - 1]}`, employeesOnTwelfth(quarterChecks, year, month)));
  rows.push(
    cents('2', 'Gross wages', gross),
    cents('3', 'Excess wages over the $7,000 wage base', excess),
    cents('4', 'Taxable wages (line 2 minus line 3)', gross - excess),
    cents('5', 'Tax due (what the paychecks charged)', tax, {
      rate: bp == null ? null : pctText(bp),
      note: bp == null ? `No taxable wages this quarter. New employers start at ${pctText(RATES.floridaNewEmployerBp)}.` : 'The rate the paychecks used, read back from the stored pay figures.',
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

function form940(year, yearChecks, depositsCents) {
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
  const rows = [
    text('1a', 'State where you paid wages', 'FL'),
    cents('3', 'Total payments to all employees', total),
    cents('4', 'Payments exempt from FUTA tax', 0),
    cents('5', 'Payments of more than $7,000 to each employee', line5),
    cents('6', 'Subtotal (lines 4 + 5)', line6),
    cents('7', 'Total taxable FUTA wages (line 3 minus line 6)', line7),
    cents('8', 'FUTA tax before adjustments', line8, { rate: pctText(RATES.futaBp) }),
    cents('9', 'Adjustment if some state wages were exempt from state unemployment tax', 0),
    cents('10', 'Adjustment if you did not pay all state unemployment tax by the due date', 0),
    cents('11', 'Credit reduction for employees in a credit reduction state', 0, { note: 'Check Florida against the IRS credit reduction list every year. This line stays 0 unless Florida is on it.' }),
    cents('12', 'Total FUTA tax after adjustments (lines 8 + 9 + 10 + 11)', line12),
    cents('13', `FUTA tax deposited for the year (${DEPOSIT_LABEL})`, depositsCents),
    cents('14', 'Balance due (line 12 minus line 13, if line 12 is more)', line14),
    cents('15', 'Overpayment (line 13 minus line 12, if line 13 is more)', line15),
  ];
  const notes = ['Line 13 counts only deposits you marked paid on the Tax page. The Tax page calendar does not yet write a Form 940 deposit row, so this is 0 unless a row was added.'];
  if (line12 > FORM_940_PART_5_THRESHOLD_CENTS) {
    const byQuarter = [1, 2, 3, 4].map((q) => sum(yearChecks.filter((c) => quarterOfMonth(monthOf(c)) === q), 'futa'));
    const line16d = line12 - (byQuarter[0] + byQuarter[1] + byQuarter[2]);
    rows.push(
      cents('16a', 'FUTA liability, 1st quarter (January to March)', byQuarter[0]),
      cents('16b', 'FUTA liability, 2nd quarter (April to June)', byQuarter[1]),
      cents('16c', 'FUTA liability, 3rd quarter (July to September)', byQuarter[2]),
      cents('16d', 'FUTA liability, 4th quarter (October to December)', line16d),
      cents('17', 'Total tax liability for the year (must equal line 12)', byQuarter[0] + byQuarter[1] + byQuarter[2] + line16d),
    );
    notes.push('Part 5 is shown because line 12 is more than $500. Line 16d is line 12 less quarters 1 to 3, so line 17 equals line 12.');
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

function w3Totals(forms) {
  const total = (key) => forms.reduce((acc, f) => acc + f[key], 0);
  const tt = forms.reduce((acc, f) => acc + (f.box12TT || 0), 0);
  return {
    boxC: forms.length,
    box1: total('box1'),
    box2: total('box2'),
    box3: total('box3'),
    box4: total('box4'),
    box5: total('box5'),
    box6: total('box6'),
    box12TT: tt > 0 ? tt : null,
  };
}

/**
 * Pure aggregation. rows are payroll_checks rows (finalized only, pay_date in
 * `year`, dates as YYYY-MM-DD text); deposits are paid calendar rows as
 * { source_key, amount_paid, amount_due }.
 */
function buildFormFigures({ year, quarter, rows = [], deposits941 = [], deposits940 = [], addresses = new Map() }) {
  const wageBase = rows.length ? socialSecurityWageBaseCents(year) : 0;
  const yearChecks = rows.map((r) => normalize(r, wageBase));
  const quarterChecks = yearChecks.filter((c) => quarterOfMonth(monthOf(c)) === quarter);
  const depositTotal = (list) => list.reduce((acc, d) => acc + Math.round(num(d.amount_paid ?? d.amount_due) * 100), 0);
  const w2 = w2Figures(yearChecks, addresses);
  return {
    year,
    quarter,
    employer: { name: WAVES_BUSINESS_NAME, address: WAVES_ADDRESS_LINE, ein: FROM_RECORDS },
    f941: form941(year, quarter, quarterChecks, depositTotal(deposits941)),
    rt6: formRt6(year, quarter, quarterChecks),
    f940: form940(year, yearChecks, depositTotal(deposits940)),
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
  const quarterMonths = [1, 2, 3].map((n) => `${year}-${pad((quarter - 1) * 3 + n)}`);
  const deposits941 = await paidDeposits(conn, '941_deposit', quarterMonths);
  const deposits940 = await paidDeposits(conn, '940_deposit', [String(year)]);
  const ids = [...new Set(rows.map((r) => r.technician_id))];
  const addresses = new Map();
  if (ids.length) {
    const techs = await conn('technicians').whereIn('id', ids).select('id', 'address');
    for (const t of techs) {
      const address = String(t.address || '').trim();
      if (address) addresses.set(t.id, address);
    }
  }
  return buildFormFigures({ year, quarter, rows, deposits941, deposits940, addresses });
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

module.exports = { buildFormFigures, readFormFigures, parseFormPeriod, monthlyLiabilityLines, FROM_RECORDS };

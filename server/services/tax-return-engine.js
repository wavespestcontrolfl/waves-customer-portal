/**
 * Federal return engine for a single-member LLC (Schedule C, Schedule SE and
 * Form 1040), GATE_TAX_RETURN_ENGINE, nested under GATE_BANK_IMPORT.
 *
 *   computeReturn(inputs)  pure: numbers in, the return out. No database.
 *   gatherInputs(year)     reads the books, the P&L, the equipment register,
 *                          the home office and the tax-year record.
 *   computeYear(year)      gatherInputs + computeReturn.
 *   fileYear(year, opts)   computes, then freezes the result as the filed snapshot.
 *
 * Where each number comes from
 *   Gross receipts   the management P&L's revenue for the year (buildPnlReport:
 *                    payments ledger, net of refunds and of sales tax). There is
 *                    no second revenue definition: a sale the P&L does not count
 *                    is not on the return.
 *   Expenses         `expenses` rows dated in the year, grouped by their
 *                    category's Schedule C line, at the deductible amount (the
 *                    same clamp pnl-report.js uses), plus the synced Stripe
 *                    processing fees the P&L shows (line 10). Rows on line 13
 *                    and line 30 are left out: depreciation and the home office
 *                    are computed below, and counting both would double up.
 *                    A category with no known line lands on line 27a and warns.
 *   Depreciation     the equipment register, through the P&L's own proration
 *                    (prorateAssetDepreciation). Section 179 amounts are split
 *                    out because the business-income limit applies to them.
 *   Mileage          not used: like the P&L, the engine takes the actual-expense
 *                    method for vehicles.
 *
 * Ordering (section 179 before the home office, as Form 8829 has it; the
 * owner's working scripts took the home office first, and the engine follows
 * the form instead):
 *   1. other expenses and regular depreciation
 *   2. section 179, capped at gross receipts less those expenses (the home
 *      office is NOT subtracted) and at the year's dollar limit; the excess is
 *      the carryover out
 *   3. home office, capped at gross receipts less those expenses and the
 *      section 179 allowed (Form 8829 line 8 starts from Schedule C line 29,
 *      after line 13); actual: the excess is the carryover out; simplified: it
 *      expires
 *   4. net profit; Schedule SE; AGI = profit + other income - half the SE tax
 *   5. NOL deduction (Schedule 1 line 8a, so AGI is after it) = the smaller of
 *      the NOL carried in and 80% of taxable income before the NOL and QBI; QBI deduction = 20% of (profit - half SE
 *      - QBI loss carried in), at most 20% of taxable income after the NOL
 *   6. income tax: the IRS Tax Table under $100,000 of taxable income
 *      (midpoint of the row, whole dollars), the bracket formula above that;
 *      total tax = income tax + SE tax (+ the Additional Medicare Tax on SE
 *      earnings above its threshold)
 *
 * Simplifications, on purpose (each also surfaces as a warning where it bites):
 *   - A loss year's NOL = the loss less other income (all of it treated as
 *     business income, like W-2 wages in the 2024 script; interest is too small
 *     to matter). Form 172's nonbusiness-deduction add-backs are not modeled.
 *   - Other income is assumed not to be W-2 Social Security wages (the wage
 *     base is not reduced) and the Additional Medicare Tax counts SE earnings
 *     only.
 *   - Married filing separately and every credit are not modeled.
 *   - The return is for the whole calendar year; a year in progress is "to date".
 */
const crypto = require('crypto');
const db = require('../models/db');
const { etDateString } = require('../utils/datetime-et');
const {
  buildPnlReport, prorateAssetDepreciation, annotateMidQuarter, isDepreciationUncomputed,
} = require('./pnl-report');
const { getYearConstants, FILING_STATUSES } = require('./tax-year-constants');
const sharedBills = require('./tax-shared-bills');
const taxYears = require('./tax-years');

const STRIPE_FEES_CATEGORY = 'Stripe Processing Fees (synced)'; // name in pnl-report.js assemblePnl

const SCHEDULE_C_LABELS = {
  1: 'Gross receipts',
  8: 'Advertising',
  9: 'Car and truck expenses',
  10: 'Commissions and fees',
  11: 'Contract labor',
  13: 'Depreciation and section 179',
  15: 'Insurance (other than health)',
  '16a': 'Interest: mortgage',
  '16b': 'Interest: other',
  17: 'Legal and professional services',
  18: 'Office expense',
  '20a': 'Rent or lease: vehicles, machinery, equipment',
  '20b': 'Rent or lease: other business property',
  21: 'Repairs and maintenance',
  22: 'Supplies',
  23: 'Taxes and licenses',
  '24a': 'Travel',
  '24b': 'Deductible meals',
  25: 'Utilities',
  26: 'Wages',
  '27a': 'Other expenses',
  30: 'Business use of home',
  31: 'Net profit or (loss)',
};
// object keys that look like numbers sort first, so the printed order is explicit
const LINE_ORDER = ['1', '8', '9', '10', '11', '13', '15', '16a', '16b', '17', '18', '20a', '20b', '21', '22', '23', '24a', '24b', '25', '26', '27a', '30', '31'];
const FALLBACK_LINE = '27a';
// computed below from their own sources, never summed from expense rows
const COMPUTED_LINES = ['13', '30'];
// gross receipts and net profit: totals, never an expense line, always printed
const TOTAL_LINES = ['1', '31'];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => Number(v) || 0;
const fmt = (n) => `$${num(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const warn = (code, message) => ({ code, message });

function bracketTax(taxable, brackets) {
  let tax = 0;
  let lower = 0;
  for (const [upper, rate] of brackets) {
    const top = upper == null ? Infinity : upper;
    if (taxable > lower) tax += (Math.min(taxable, top) - lower) * rate;
    lower = top;
  }
  return round2(tax);
}

// The IRS Tax Table (Form 1040 instructions) for taxable income under $100,000:
// the tax is the bracket formula at the MIDPOINT of the row the income falls
// in, rounded to the nearest whole dollar (a half rounds up). Rows: $0-5, 5-15
// and 15-25, then $25 wide up to $3,000, then $50 wide up to $100,000.
// Verified against the 2024 and 2025 published tables. From $100,000 up the Tax
// Computation Worksheet is the bracket formula itself, so bracketTax is used.
const TAX_TABLE_LIMIT = 100000;
function taxTableRow(taxable) {
  if (taxable < 5) return [0, 5];
  if (taxable < 15) return [5, 15];
  if (taxable < 25) return [15, 25];
  if (taxable < 3000) {
    const lo = 25 + Math.floor((taxable - 25) / 25) * 25;
    return [lo, lo + 25];
  }
  const lo = 3000 + Math.floor((taxable - 3000) / 50) * 50;
  return [lo, lo + 50];
}
function incomeTaxFor(taxable, brackets) {
  if (taxable >= TAX_TABLE_LIMIT) return bracketTax(taxable, brackets);
  const [lo, hi] = taxTableRow(taxable);
  const cents = Math.round(bracketTax((lo + hi) / 2, brackets) * 100);
  return Math.floor((cents + 50) / 100);
}

// April 15 of the next year; a weekend moves it to Monday. Emancipation Day
// and extensions are not known here: callers treat this as advice, not a block.
function dueDate(year) {
  const d = new Date(Date.UTC(Number(year) + 1, 3, 15));
  const dow = d.getUTCDay();
  if (dow === 6) d.setUTCDate(17);
  if (dow === 0) d.setUTCDate(16);
  return d.toISOString().slice(0, 10);
}

function monthsBetween(fromYm, toYm) {
  return (toYm.year * 12 + toYm.month) - (fromYm.year * 12 + fromYm.month);
}
const ym = (dateStr) => ({ year: Number(dateStr.slice(0, 4)), month: Number(dateStr.slice(5, 7)) });

// What to set aside each month for the balance on this return: the rest of the
// year while it runs, otherwise the months until the due date (at least one).
function reserve({ year, today, balance }) {
  const amount = Math.max(round2(balance), 0);
  const yearEnd = `${year}-12-31`;
  let monthsLeft;
  let basis;
  if (today <= yearEnd) {
    monthsLeft = 12 - ym(today).month + 1;
    basis = 'the months left in the year';
  } else {
    const due = dueDate(year);
    monthsLeft = today < due ? Math.max(monthsBetween(ym(today), ym(due)), 1) : 1;
    basis = today < due ? 'the months until the return is due' : 'due now';
  }
  return { amount, months_left: monthsLeft, monthly: round2(amount / monthsLeft), basis };
}

function snapshotDiffers(snapshot, result) {
  const old = snapshot && snapshot.result;
  if (!old) return [];
  const pairs = [
    ['net profit', old.net_profit, result.net_profit],
    ['SE tax', old.se_tax, result.se_tax],
    ['AGI', old.agi, result.agi],
    ['NOL deduction', old.nol_used, result.nol_used],
    ['QBI deduction', old.qbi_deduction, result.qbi_deduction],
    ['taxable income', old.taxable_income, result.taxable_income],
    ['income tax', old.income_tax, result.income_tax],
    ['total tax', old.total_tax, result.total_tax],
    ['NOL carryover', old.carry_out?.nol, result.carry_out.nol],
    ['QBI loss carryover', old.carry_out?.qbi_loss, result.carry_out.qbi_loss],
    ['section 179 carryover', old.carry_out?.sec179, result.carry_out.sec179],
    ['home office carryover', old.carry_out?.home_office, result.carry_out.home_office],
  ];
  // every Schedule C line too: moving an expense between lines leaves the profit alone
  const lines = (r) => new Map((r.schedule_c || []).map((l) => [`Schedule C line ${l.line} (${l.label})`, l.amount]));
  const was = lines(old);
  const now = lines(result);
  for (const label of new Set([...was.keys(), ...now.keys()])) pairs.push([label, was.get(label), now.get(label)]);
  return pairs.filter(([, a, b]) => round2(a) !== round2(b)).map(([label, a, b]) => `${label} was ${fmt(a)} when filed, now ${fmt(b)}`);
}

// Filing is bound to the return the owner reviewed (fileYear): the fingerprint
// covers every figure on it, but not the warnings, the status or the reserve
// (the reserve moves with today's date).
function returnFingerprint(result) {
  const { warnings: _warnings, status: _status, reserve: _reserve, ...figures } = result;
  return crypto.createHash('sha256').update(JSON.stringify(figures)).digest('hex').slice(0, 32);
}

// Schedule C lines 8 to 27a from the expense rows. Lines 13 and 30 are
// computed from their own sources, so their rows are skipped; a line the engine
// does not know (or a total line) goes to 27a and is counted for a warning.
function classifyExpenses(expenseLines) {
  const byLine = new Map();
  let unknownTotal = 0;
  for (const e of expenseLines || []) {
    const given = String(e.line ?? '').trim().toLowerCase();
    if (COMPUTED_LINES.includes(given)) continue;
    const known = Boolean(SCHEDULE_C_LABELS[given]) && !TOTAL_LINES.includes(given);
    if (!known) unknownTotal += num(e.amount);
    const line = known ? given : FALLBACK_LINE;
    byLine.set(line, round2((byLine.get(line) || 0) + num(e.amount)));
  }
  return { byLine, unknownTotal };
}

// The home office, capped at `room` (what is left after the other expenses and
// section 179). Actual (Form 8829): the carry-in joins this year's amount and
// the excess carries out. Simplified: this year only, the excess expires and a
// carry-in waits untouched.
function homeOfficeLimit(ho, carryIn, room) {
  const carries = ho?.method === 'actual';
  const full = ho ? round2(ho.deduction) : 0;
  const pool = round2(full + (carries ? carryIn : 0));
  const allowed = round2(Math.min(pool, room));
  return {
    allowed,
    carryOut: carries ? round2(pool - allowed) : carryIn,
    summary: ho ? { method: ho.method, full_amount: full, carry_in: carryIn, pool, allowed } : null,
  };
}

// Every warning a return can carry, in the order they show: when it applies and
// what it says. r is the computed return; f holds the working figures the
// return does not show (the year's constants, today, the filing record, the
// SE earnings, taxable income before QBI, QBI after the carried loss, and how
// the books differ from a filed snapshot).
const RETURN_WARNINGS = [
  {
    code: 'unknown_line',
    when: (r, f) => f.unknownTotal !== 0,
    text: (r, f) => `${fmt(f.unknownTotal)} of expenses have no Schedule C line the engine knows. They are shown on line 27a.`,
  },
  {
    code: 'sec179_wages',
    when: (r) => r.lines.other_income > 0 && r.sec179.pool > 0,
    text: () => "Section 179's income limit can include wages; this engine counts business income only. Check Form 4562 line 11 by hand.",
  },
  {
    code: 'sec179_over_limit',
    when: (r, f) => r.sec179.elected > f.K.sec179_limit,
    text: (r, f) => `Section 179 elected for ${r.year} (${fmt(r.sec179.elected)}) is over the ${fmt(f.K.sec179_limit)} limit. Only the limit counts, and the rest is not carried forward. The phase-out for large purchases is not modeled: ask a tax preparer.`,
  },
  {
    code: 'home_office_carry_idle',
    when: (r) => r.home_office?.method !== 'actual' && r.carry_in.home_office > 0,
    text: (r) => (r.home_office
      ? `${fmt(r.carry_in.home_office)} of home office carryover cannot be used with the simplified method. It stays carried forward.`
      : `${fmt(r.carry_in.home_office)} of home office carryover is not used because no home office is entered for ${r.year}. It stays carried forward.`),
  },
  {
    code: 'addl_medicare_wages',
    when: (r, f) => f.seBase > 0 && r.lines.other_income > 0 && f.seBase + r.lines.other_income > f.K.addl_medicare_threshold[r.filing_status],
    text: () => 'The Additional Medicare Tax counts self-employment earnings only. Wages in Other income are not added: ask a tax preparer.',
  },
  {
    code: 'ss_wage_base_wages',
    when: (r, f) => r.se_tax > 0 && r.lines.other_income > 0 && round2(f.seBase + r.lines.other_income) > f.K.ss_wage_base,
    text: () => 'Wages use up the Social Security wage base before self-employment earnings do. This engine does not subtract wages in Other income, so the SE tax can be too high. Check Schedule SE lines 8a to 10 by hand.',
  },
  {
    code: 'qbi_threshold',
    when: (r, f) => f.taxableAfterNol > f.K.qbi_threshold[r.filing_status],
    text: (r, f) => `Taxable income is over the ${fmt(f.K.qbi_threshold[r.filing_status])} QBI threshold. The wage and property limit is not modeled: ask a tax preparer.`,
  },
  {
    code: 'qbi_minimum',
    when: (r, f) => Boolean(f.K.qbi_minimum) && f.qbiNet >= f.K.qbi_minimum.qbi && r.qbi_deduction < f.K.qbi_minimum.deduction && r.taxable_income > 0,
    text: (r, f) => `The ${fmt(f.K.qbi_minimum.deduction)} minimum QBI deduction (IRC 199A(i)) may apply to an active business with at least ${fmt(f.K.qbi_minimum.qbi)} of QBI. This engine does not add it: check Form 8995 with a tax preparer.`,
  },
  {
    code: 'year_in_progress',
    when: (r, f) => f.today <= `${r.year}-12-31`,
    text: (r) => `${r.year} is not over. These figures are to date.`,
  },
  {
    // a filed year is judged on its filing date, a draft on today
    code: 'simplified_late',
    when: (r, f) => r.home_office?.method === 'simplified' && ((f.isFiled && f.filedOn) || f.today) > r.due_date,
    text: (r, f) => `The simplified home office method is only valid on a timely original return (Rev. Proc. 2013-13 section 4.03). The ${r.year} return was due ${r.due_date}${f.isFiled ? ' and was filed later' : ''}. If no extension applies, use the actual method.`,
  },
  {
    code: 'filed_differs',
    when: (r, f) => f.isFiled && f.filedDiffs.length > 0,
    text: (r, f) => `This year is marked filed, but the books now give a different answer: ${f.filedDiffs.join('; ')}.`,
  },
];

/**
 * inputs: {
 *   year, filing_status, other_income, estimates_paid, gross_receipts,
 *   carry_in: { nol, qbi_loss, sec179, home_office },
 *   expense_lines: [{ line, amount }],            deductible amounts by Schedule C line
 *   depreciation: { regular, sec179_elected },    this year's, from the equipment register
 *   home_office: null | { method, deduction },    deduction = the year's full amount before the cap
 *   status, filed_on, filed_snapshot,             the tax-year record
 *   today (ET 'YYYY-MM-DD', default now), warnings (extra, from the readers), constants (tests)
 * }
 * Amounts are never negative (the year record and the books refuse them).
 */
function computeReturn(inputs = {}) {
  const year = Number(inputs.year);
  const K = inputs.constants || getYearConstants(year);
  const filing = inputs.filing_status || 'single';
  if (!FILING_STATUSES.includes(filing)) {
    const e = new Error(`filing_status must be one of ${FILING_STATUSES.join(', ')}`); e.status = 400; throw e;
  }
  const today = inputs.today || etDateString();
  const given = inputs.carry_in || {};
  const carryIn = {
    nol: round2(given.nol), qbi_loss: round2(given.qbi_loss), sec179: round2(given.sec179), home_office: round2(given.home_office),
  };
  const dep = inputs.depreciation || {};
  const gross = round2(inputs.gross_receipts);
  const otherIncome = round2(inputs.other_income);
  const estimatesPaid = round2(inputs.estimates_paid);

  // 1. expense lines (13 and 30 come from their own sources)
  const { byLine, unknownTotal } = classifyExpenses(inputs.expense_lines);
  const regularDep = round2(dep.regular);
  const expenseTotal = round2([...byLine.values()].reduce((s, v) => s + v, 0));
  const otherExpenses = round2(expenseTotal + regularDep);
  // income before section 179 and the home office
  const room = Math.max(round2(gross - otherExpenses), 0);

  // 2. section 179 comes first: its business-income limit is gross receipts
  // less every other expense, and it does NOT count the home office. Form 8829
  // line 8 starts from Schedule C line 29, which is AFTER line 13, so the home
  // office is limited by what section 179 leaves (3 below).
  // Form 4562 line 9: this year's election counts up to the dollar limit only.
  // Only an amount the income limit holds back carries forward (Treas. Reg.
  // 1.179-3(a)); the part over the dollar limit does not. A carry-in is used up
  // to the allowance this year's election leaves (1.179-3(b) and (c)), which is
  // the dollar limit cap on the total below.
  const elected = round2(dep.sec179_elected);
  const pool179 = round2(Math.min(elected, K.sec179_limit) + carryIn.sec179);
  const allowed179 = round2(Math.max(0, Math.min(pool179, K.sec179_limit, room)));

  // 3. home office, capped at what is left after other expenses, depreciation
  // and the section 179 allowed (floor 0)
  const ho = homeOfficeLimit(inputs.home_office, carryIn.home_office, Math.max(round2(room - allowed179), 0));

  // 4. profit, Schedule SE, AGI
  const profit = round2(gross - otherExpenses - ho.allowed - allowed179);
  const seBase = Math.max(round2(profit * K.se_factor), 0);
  const owesSe = seBase >= K.se_min_earnings;
  const seTax = owesSe ? round2(Math.min(seBase, K.ss_wage_base) * K.ss_rate + seBase * K.medicare_rate) : 0;
  // half of the SE tax, a half cent rounds up (cents in whole numbers: no float tie)
  const halfSe = Math.ceil(Math.round(seTax * 100) / 2) / 100;
  // the Additional Medicare Tax on SE earnings above the threshold, outside the half-SE deduction
  const addlMedicare = owesSe ? round2(Math.max(seBase - K.addl_medicare_threshold[filing], 0) * K.addl_medicare_rate) : 0;
  // income before the NOL deduction: the base of the 80% limit
  const agiBeforeNol = round2(profit + otherIncome - halfSe);
  const standard = K.standard_deduction[filing];

  // 5. NOL and QBI
  const taxableBeforeNol = Math.max(round2(agiBeforeNol - standard), 0);
  const nolUsed = round2(Math.min(carryIn.nol, round2(K.nol_limit_pct * taxableBeforeNol)));
  const taxableAfterNol = round2(taxableBeforeNol - nolUsed);
  // The NOL deduction is Schedule 1 line 8a, a part of total income, so the
  // AGI on the return (and the 1040-ES 110% test below) is after it.
  const agi = round2(agiBeforeNol - nolUsed);
  const qbiNet = round2(round2(profit - halfSe) - carryIn.qbi_loss);
  const qbiDeduction = round2(Math.min(K.qbi_rate * Math.max(qbiNet, 0), K.qbi_rate * taxableAfterNol));
  const taxable = round2(Math.max(taxableAfterNol - qbiDeduction, 0));
  // a loss year adds the loss less other income to the NOL (a profit adds nothing:
  // other income is never negative)
  const nolOut = round2(carryIn.nol - nolUsed + Math.max(-profit - otherIncome, 0));

  // 6. tax
  const incomeTax = incomeTaxFor(taxable, K.brackets[filing]);
  const totalTax = round2(incomeTax + seTax + addlMedicare);
  const owed = round2(totalTax - estimatesPaid);

  // next year's 1040-ES (a $0 total tax makes the safe harbor $0 too)
  const pct = agi > K.estimate_high_agi ? K.estimate_safe_harbor_high_pct : K.estimate_safe_harbor_pct;
  const safeHarbor = round2(totalTax * pct);
  const estimates = {
    no_estimates_required: totalTax === 0,
    note: totalTax === 0
      ? `No estimated payments are required for ${year + 1}: this year's total tax is $0 on a full 12-month year (IRC 6654(e)(2)).`
      : `To be safe from the underpayment penalty for ${year + 1}, pay ${Math.round(pct * 100)}% of this year's total tax (${fmt(safeHarbor)}), about ${fmt(safeHarbor / 4)} each quarter.`,
    safe_harbor_pct: pct,
    next_year_safe_harbor: safeHarbor,
    quarterly: round2(safeHarbor / 4),
  };

  // Schedule C as printed: the form's order, lines 1 and 31 always, the rest when not zero
  const computedLines = {
    1: [[SCHEDULE_C_LABELS[1], gross]],
    13: [['Depreciation', regularDep], ['Section 179 deduction', allowed179]],
    30: [[SCHEDULE_C_LABELS[30], ho.allowed]],
    31: [[SCHEDULE_C_LABELS[31], profit]],
  };
  const scheduleC = LINE_ORDER.flatMap((line) => (computedLines[line] || [[SCHEDULE_C_LABELS[line], byLine.get(line)]])
    .filter(([, amount]) => amount || TOTAL_LINES.includes(line))
    .map(([label, amount]) => ({ line, label, amount })));

  const result = {
    year,
    filing_status: filing,
    constants_source: K.source,
    due_date: dueDate(year),
    status: inputs.status || 'draft',
    lines: {
      gross_receipts: gross,
      regular_depreciation: regularDep,
      home_office_deduction: ho.allowed,
      sec179_allowed: allowed179,
      total_expenses: round2(gross - profit),
      net_profit: profit,
      other_income: otherIncome,
      standard_deduction: standard,
    },
    schedule_c: scheduleC,
    net_profit: profit,
    se_tax: seTax,
    half_se_deduction: halfSe,
    additional_medicare_tax: addlMedicare,
    agi_before_nol: agiBeforeNol,
    agi,
    standard_deduction: standard,
    nol_used: nolUsed,
    qbi_deduction: qbiDeduction,
    taxable_income: taxable,
    income_tax: incomeTax,
    total_tax: totalTax,
    estimates_paid: estimatesPaid,
    owed,
    home_office: ho.summary,
    sec179: { elected, carry_in: carryIn.sec179, pool: pool179, income_limit: room, allowed: allowed179 },
    carry_in: carryIn,
    carry_out: { nol: nolOut, qbi_loss: round2(Math.max(-qbiNet, 0)), sec179: round2(pool179 - allowed179), home_office: ho.carryOut },
    estimates,
    reserve: reserve({ year, today, balance: owed }),
    warnings: [],
  };
  result.fingerprint = returnFingerprint(result);
  const facts = {
    K, today, isFiled: inputs.status === 'filed', filedOn: inputs.filed_on, unknownTotal, seBase, taxableAfterNol, qbiNet,
    filedDiffs: snapshotDiffers(inputs.filed_snapshot, result),
  };
  result.warnings = [
    ...(inputs.warnings || []),
    ...RETURN_WARNINGS.filter((w) => w.when(result, facts)).map((w) => warn(w.code, w.text(result, facts))),
  ];
  return result;
}

// Business-use and election gates all live in prorateAssetDepreciation. The
// section 179 part is read by running the same asset as a pure section 179
// asset (no straight-line amount), so the split never re-implements a gate.
function splitDepreciation(assets, start, end) {
  let regular = 0;
  let sec179 = 0;
  for (const a of assets) {
    const total = prorateAssetDepreciation(a, start, end);
    const isSec179 = a.section_179_elected === true || a.depreciation_method === 'section_179';
    const part = isSec179 ? prorateAssetDepreciation({ ...a, depreciation_method: 'section_179', annual_depreciation: null }, start, end) : 0;
    sec179 += part;
    regular += total - part;
  }
  return { regular: round2(regular), sec179_elected: round2(sec179) };
}

async function gatherInputs(year) {
  const y = sharedBills.parseYear(year);
  getYearConstants(y); // 400 before any query for a year that is not loaded
  const start = `${y}-01-01`;
  const end = `${y}-12-31`;
  const [detail, pnl, expenseRows, assetRows, homeRow] = await Promise.all([
    taxYears.getYearDetail(y),
    buildPnlReport(db, start, end),
    db('expenses')
      .leftJoin('expense_categories', 'expenses.category_id', 'expense_categories.id')
      .whereBetween('expenses.expense_date', [start, end])
      .groupBy('expense_categories.irs_line')
      .select(
        'expense_categories.irs_line as line',
        db.raw('COUNT(*)::int as n'),
        db.raw("COALESCE(SUM(LEAST(expenses.amount, GREATEST(0, COALESCE(expenses.tax_deductible_amount, expenses.amount)))), 0)::text as total"),
      ),
    db('equipment_register').where(function activeOrDisposed() {
      this.where('active', true).orWhere('disposed', true).orWhereNotNull('disposal_date');
    }),
    db('tax_home_office').where({ tax_year: y }).first(),
  ]);

  const warnings = [];
  const expense_lines = [];
  for (const r of expenseRows) {
    const line = r.line == null ? '' : String(r.line).trim().toLowerCase();
    const amount = round2(r.total);
    if (COMPUTED_LINES.includes(line)) {
      if (amount) warnings.push(warn('computed_line_expenses', `${r.n} expense row(s) on Schedule C line ${line} (${fmt(amount)}) are left out: ${line === '13' ? 'depreciation comes from the equipment register' : 'the home office comes from the home office box'}.`));
      continue;
    }
    if (!line && amount) warnings.push(warn('uncategorized', `${r.n} expense row(s) with no category (${fmt(amount)}) are shown on line 27a.`));
    expense_lines.push({ line: line || FALLBACK_LINE, amount });
  }
  const fees = (pnl.operatingExpenses?.categories || []).find((c) => c.name === STRIPE_FEES_CATEGORY);
  if (fees && num(fees.amount)) expense_lines.push({ line: '10', amount: round2(fees.amount) });
  if (pnl.coverage && pnl.coverage.complete === false) warnings.push(warn('pnl_coverage', `Sales and fees may be incomplete: ${pnl.coverage.note}`));

  const assets = annotateMidQuarter(assetRows);
  const depreciation = splitDepreciation(assets, start, end);
  const uncomputed = assets.filter((a) => isDepreciationUncomputed(a, start, end));
  if (uncomputed.length) warnings.push(warn('depreciation_incomplete', `${uncomputed.length} equipment item(s) could not be depreciated automatically (mid-quarter year, unsupported class, or a vehicle with unconfirmed business use). Their depreciation reads $0 here.`));

  const carry_in = {};
  for (const [key, c] of Object.entries(detail.carry_in)) carry_in[key] = c.value;

  return {
    year: y,
    filing_status: detail.row.filing_status,
    other_income: detail.row.other_income,
    estimates_paid: detail.row.estimates_paid,
    carry_in,
    gross_receipts: num(pnl.revenue?.total),
    expense_lines,
    depreciation,
    home_office: homeRow ? { method: homeRow.method, deduction: sharedBills.homeOfficeDeduction(homeRow) } : null,
    status: detail.row.status,
    filed_on: detail.row.filed_on,
    filed_snapshot: detail.row.filed_snapshot,
    row_version: detail.row.version,
    prior_version: detail.prior_version,
    warnings,
  };
}

async function computeYear(year) {
  return computeReturn(await gatherInputs(year));
}

// Freeze the return the owner reviewed. The snapshot keeps the numbers but not
// the warnings. `fingerprint` is the one on the return the screen showed: the
// return is computed again here, and when the books, the equipment, the home
// office, the year's inputs or the prior year moved since it was shown, the
// fingerprints differ and it is a 409 with nothing written. Calculating and
// filing are one optimistic step: the year row exists first, the return is
// computed from the row as read (its version, and the prior year's version,
// whose filed snapshot feeds the carry-ins), and the filing only matches those
// same versions (markFiled). A PUT that lands in between is a 409.
// The books (expenses, equipment, home office) are read without a lock, on
// purpose: a book edit that lands while this request runs is the same as one
// that lands just after it. The snapshot is still the return the owner
// reviewed, and the filed year then warns that the books disagree
// (filed_differs). Locking those shared tables would stall every other writer.
async function fileYear(year, { filed_on: filedOn, fingerprint } = {}) {
  const y = sharedBills.parseYear(year);
  const date = taxYears.parseFiledOn(filedOn, y);
  getYearConstants(y); // 400 for a year that is not loaded, before a row is made
  if (typeof fingerprint !== 'string' || !fingerprint) throw sharedBills.httpError(400, 'fingerprint is required: file from the return on screen');
  await taxYears.ensureRow(y);
  const inputs = await gatherInputs(y);
  const { warnings: _warnings, ...result } = computeReturn(inputs);
  if (result.fingerprint !== fingerprint) {
    throw sharedBills.httpError(409, 'the return changed since it was shown; reload it and check it again before marking it filed');
  }
  return taxYears.markFiled(y, date, { frozen_at: new Date().toISOString(), result }, inputs.row_version, inputs.prior_version);
}

module.exports = {
  computeReturn, gatherInputs, computeYear, fileYear, splitDepreciation, bracketTax, incomeTaxFor, taxTableRow, dueDate, reserve,
  returnFingerprint, SCHEDULE_C_LABELS,
};

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
 * Ordering follows the owner's 2024 and 2025 working scripts:
 *   1. other expenses and regular depreciation
 *   2. home office, capped at gross receipts less those expenses (simplified:
 *      no carryover; actual: the excess is the carryover out)
 *   3. section 179, capped at gross receipts less everything above and at the
 *      year's dollar limit (the excess is the carryover out)
 *   4. net profit; Schedule SE; AGI = profit + other income - half the SE tax
 *   5. NOL deduction = the smaller of the NOL carried in and 80% of taxable
 *      income before the NOL and QBI; QBI deduction = 20% of (profit - half SE
 *      - QBI loss carried in), at most 20% of taxable income after the NOL
 *   6. income tax from the brackets; total tax = income tax + SE tax (+ the
 *      Additional Medicare Tax on SE earnings above its threshold)
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
    ['total tax', old.total_tax, result.total_tax],
    ['NOL carryover', old.carry_out?.nol, result.carry_out.nol],
    ['QBI loss carryover', old.carry_out?.qbi_loss, result.carry_out.qbi_loss],
    ['section 179 carryover', old.carry_out?.sec179, result.carry_out.sec179],
    ['home office carryover', old.carry_out?.home_office, result.carry_out.home_office],
  ];
  return pairs.filter(([, a, b]) => round2(a) !== round2(b)).map(([label, a, b]) => `${label} was ${fmt(a)} when filed, now ${fmt(b)}`);
}

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
 */
function computeReturn(inputs = {}) {
  const year = Number(inputs.year);
  const K = inputs.constants || getYearConstants(year);
  const filing = inputs.filing_status || 'single';
  if (!FILING_STATUSES.includes(filing)) {
    const e = new Error(`filing_status must be one of ${FILING_STATUSES.join(', ')}`); e.status = 400; throw e;
  }
  const today = inputs.today || etDateString();
  const warnings = [...(inputs.warnings || [])];

  const gross = round2(inputs.gross_receipts);
  const carryIn = {
    nol: round2(inputs.carry_in?.nol), qbi_loss: round2(inputs.carry_in?.qbi_loss),
    sec179: round2(inputs.carry_in?.sec179), home_office: round2(inputs.carry_in?.home_office),
  };
  const otherIncome = round2(inputs.other_income);
  const estimatesPaid = round2(inputs.estimates_paid);

  // 1. expense lines (13 and 30 come from their own sources)
  const byLine = new Map();
  let unknownTotal = 0;
  for (const e of inputs.expense_lines || []) {
    let line = String(e.line == null ? '' : e.line).trim().toLowerCase();
    if (COMPUTED_LINES.includes(line)) continue;
    if (!SCHEDULE_C_LABELS[line] || line === '1' || line === '31') { unknownTotal += num(e.amount); line = FALLBACK_LINE; }
    byLine.set(line, round2((byLine.get(line) || 0) + num(e.amount)));
  }
  if (unknownTotal) warnings.push(warn('unknown_line', `${fmt(unknownTotal)} of expenses have no Schedule C line the engine knows. They are shown on line 27a.`));
  const regularDep = round2(inputs.depreciation?.regular);
  const expenseTotal = round2([...byLine.values()].reduce((s, v) => s + v, 0));
  const otherExpenses = round2(expenseTotal + regularDep);
  const room = Math.max(round2(gross - otherExpenses), 0);

  // 2. home office
  const ho = inputs.home_office || null;
  const hoRaw = ho ? round2(ho.deduction) : 0;
  let hoAllowed = 0;
  let hoCarryOut = carryIn.home_office;
  let hoPool = 0;
  if (ho && ho.method === 'actual') {
    hoPool = round2(hoRaw + carryIn.home_office);
    hoAllowed = Math.min(hoPool, room);
    hoCarryOut = round2(hoPool - hoAllowed);
  } else {
    hoAllowed = Math.min(hoRaw, room);
    if (carryIn.home_office > 0) {
      warnings.push(warn('home_office_carry_idle', ho
        ? `${fmt(carryIn.home_office)} of home office carryover cannot be used with the simplified method. It stays carried forward.`
        : `${fmt(carryIn.home_office)} of home office carryover is not used because no home office is entered for ${year}. It stays carried forward.`));
    }
  }
  hoAllowed = round2(hoAllowed);

  // 3. section 179
  const elected = round2(inputs.depreciation?.sec179_elected);
  const pool179 = round2(elected + carryIn.sec179);
  const incomeLimit179 = Math.max(round2(room - hoAllowed), 0);
  const allowed179 = round2(Math.max(0, Math.min(pool179, K.sec179_limit, incomeLimit179)));
  const carryOut179 = round2(pool179 - allowed179);
  if (elected > K.sec179_limit) warnings.push(warn('sec179_over_limit', `Section 179 elected for ${year} (${fmt(elected)}) is over the ${fmt(K.sec179_limit)} limit. The phase-out for large purchases is not modeled: ask a tax preparer.`));

  // 4. profit, Schedule SE, AGI
  const profit = round2(gross - otherExpenses - hoAllowed - allowed179);
  const totalExpenses = round2(gross - profit);
  const seBase = profit > 0 ? round2(profit * K.se_factor) : 0;
  const seTax = seBase >= K.se_min_earnings
    ? round2(Math.min(seBase, K.ss_wage_base) * K.ss_rate + seBase * K.medicare_rate) : 0;
  // half of the SE tax, a half cent rounds up (cents in whole numbers: no float tie)
  const halfSe = Math.ceil(Math.round(seTax * 100) / 2) / 100;
  const addlThreshold = K.addl_medicare_threshold[filing];
  const addlMedicare = seBase >= K.se_min_earnings && seBase > addlThreshold
    ? round2((seBase - addlThreshold) * K.addl_medicare_rate) : 0;
  if (seBase > 0 && otherIncome > 0 && seBase + otherIncome > addlThreshold) {
    warnings.push(warn('addl_medicare_wages', 'The Additional Medicare Tax counts self-employment earnings only. Wages in Other income are not added: ask a tax preparer.'));
  }
  const agi = round2(profit + otherIncome - halfSe);
  const standard = K.standard_deduction[filing];

  // 5. NOL and QBI
  const taxableBeforeNol = Math.max(round2(agi - standard), 0);
  const nolUsed = round2(Math.min(carryIn.nol, round2(K.nol_limit_pct * taxableBeforeNol)));
  const taxableAfterNol = round2(taxableBeforeNol - nolUsed);
  const qbiIncome = round2(profit - halfSe);
  const qbiNet = round2(qbiIncome - carryIn.qbi_loss);
  const qbiDeduction = round2(Math.min(K.qbi_rate * Math.max(qbiNet, 0), K.qbi_rate * taxableAfterNol));
  if (taxableAfterNol > K.qbi_threshold[filing]) {
    warnings.push(warn('qbi_threshold', `Taxable income is over the ${fmt(K.qbi_threshold[filing])} QBI threshold. The wage and property limit is not modeled: ask a tax preparer.`));
  }
  const taxable = round2(Math.max(taxableAfterNol - qbiDeduction, 0));
  const nolGenerated = profit < 0 ? round2(Math.max(-profit - otherIncome, 0)) : 0;
  const nolOut = round2(carryIn.nol - nolUsed + nolGenerated);
  const qbiLossOut = round2(Math.max(-qbiNet, 0));

  // 6. tax
  const incomeTax = bracketTax(taxable, K.brackets[filing]);
  const totalTax = round2(incomeTax + seTax + addlMedicare);
  const owed = round2(totalTax - estimatesPaid);

  // next year's 1040-ES
  const noEstimates = totalTax === 0;
  const pct = agi > K.estimate_high_agi ? K.estimate_safe_harbor_high_pct : K.estimate_safe_harbor_pct;
  const safeHarbor = round2(totalTax * pct);
  const estimates = {
    no_estimates_required: noEstimates,
    note: noEstimates
      ? `No estimated payments are required for ${year + 1}: this year's total tax is $0 on a full 12-month year (IRC 6654(e)(2)).`
      : `To be safe from the underpayment penalty for ${year + 1}, pay ${Math.round(pct * 100)}% of this year's total tax (${fmt(safeHarbor)}), about ${fmt(safeHarbor / 4)} each quarter.`,
    safe_harbor_pct: pct,
    next_year_safe_harbor: noEstimates ? 0 : safeHarbor,
    quarterly: noEstimates ? 0 : round2(safeHarbor / 4),
  };

  // warnings that depend on the record
  const isFiled = inputs.status === 'filed';
  if (today <= `${year}-12-31`) warnings.push(warn('year_in_progress', `${year} is not over. These figures are to date.`));
  if (ho && ho.method === 'simplified') {
    const due = dueDate(year);
    const asOf = isFiled && inputs.filed_on ? inputs.filed_on : today;
    if (asOf > due) {
      warnings.push(warn('simplified_late', `The simplified home office method is only valid on a timely original return (Rev. Proc. 2013-13 section 4.03). The ${year} return was due ${due}${isFiled ? ' and was filed later' : ''}. If no extension applies, use the actual method.`));
    }
  }

  const scheduleC = [{ line: '1', label: SCHEDULE_C_LABELS[1], amount: gross }];
  const amounts = new Map(byLine);
  if (regularDep) amounts.set('13', regularDep);
  if (hoAllowed) amounts.set('30', hoAllowed);
  for (const line of LINE_ORDER) {
    if (line === '1' || line === '31') continue;
    if (line === '13' && (amounts.get('13') || allowed179)) {
      if (regularDep) scheduleC.push({ line: '13', label: 'Depreciation', amount: regularDep });
      if (allowed179) scheduleC.push({ line: '13', label: 'Section 179 deduction', amount: allowed179 });
    } else if (line !== '13' && amounts.get(line)) {
      scheduleC.push({ line, label: SCHEDULE_C_LABELS[line], amount: amounts.get(line) });
    }
  }
  scheduleC.push({ line: '31', label: SCHEDULE_C_LABELS[31], amount: profit });

  const result = {
    year,
    filing_status: filing,
    constants_source: K.source,
    due_date: dueDate(year),
    status: inputs.status || 'draft',
    lines: {
      gross_receipts: gross,
      regular_depreciation: regularDep,
      home_office_deduction: hoAllowed,
      sec179_allowed: allowed179,
      total_expenses: totalExpenses,
      net_profit: profit,
      other_income: otherIncome,
      standard_deduction: standard,
    },
    schedule_c: scheduleC,
    net_profit: profit,
    se_tax: seTax,
    half_se_deduction: halfSe,
    additional_medicare_tax: addlMedicare,
    agi,
    standard_deduction: standard,
    nol_used: nolUsed,
    qbi_deduction: qbiDeduction,
    taxable_income: taxable,
    income_tax: incomeTax,
    total_tax: totalTax,
    estimates_paid: estimatesPaid,
    owed,
    home_office: ho ? { method: ho.method, full_amount: hoRaw, carry_in: carryIn.home_office, pool: hoPool || hoRaw, allowed: hoAllowed } : null,
    sec179: { elected, carry_in: carryIn.sec179, pool: pool179, income_limit: incomeLimit179, allowed: allowed179 },
    carry_in: carryIn,
    carry_out: { nol: nolOut, qbi_loss: qbiLossOut, sec179: carryOut179, home_office: hoCarryOut },
    estimates,
    reserve: reserve({ year, today, balance: owed }),
    warnings,
  };
  if (isFiled) {
    const diffs = snapshotDiffers(inputs.filed_snapshot, result);
    if (diffs.length) warnings.push(warn('filed_differs', `This year is marked filed, but the books now give a different answer: ${diffs.join('; ')}.`));
  }
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
    warnings,
  };
}

async function computeYear(year) {
  return computeReturn(await gatherInputs(year));
}

// Freeze today's answer. The snapshot keeps the numbers but not the warnings.
async function fileYear(year, { filed_on: filedOn } = {}) {
  const y = sharedBills.parseYear(year);
  const date = taxYears.parseFiledOn(filedOn, y);
  const { warnings: _warnings, ...result } = await computeYear(y);
  return taxYears.markFiled(y, date, { frozen_at: new Date().toISOString(), result });
}

module.exports = {
  computeReturn, gatherInputs, computeYear, fileYear, splitDepreciation, bracketTax, dueDate, reserve,
  SCHEDULE_C_LABELS,
};

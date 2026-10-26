/**
 * Florida RT-6 line 5 (tax due) for one quarter's finalized pay checks. Shared
 * by the tax form figures (payroll-form-figures.js, layer 3a) and the Tax page
 * calendar (payroll-tax-calendar.js, layer 2), so the calendar row asks for the
 * amount the return shows.
 *   - Line 4 (taxable wages): each check's wages under the $7,000 base
 *     (RATES.futaAndStateWageBaseCents) left after its year-to-date wages.
 *   - Line 5: line 4 times the rate, rounded once on the quarter (Florida RT-6
 *     instructions), not the sum of per-check rounding.
 *   - The rate: the one each check stored (calc_snapshot.floridaReemploymentRateBp),
 *     else the calculator's new-employer rate, which is the only rate pay runs
 *     have ever passed (payroll-runs.js passes no reemploymentRateBp). Never
 *     rebuilt from a rounded tax: dividing a rounded cent amount by taxable
 *     wages can miss the rate. More than one rate in a quarter (a rate notice
 *     mid-quarter): the rate on the most taxable wages leads, and `distinct`
 *     lists them all.
 */
const { RATES } = require('./payroll-calc');

const num = (value) => Number(value) || 0;
const max0 = (n) => (n > 0 ? n : 0);
// Basis points of integer cents, half a cent up.
const pct = (cents, bp) => Math.floor((cents * bp + 5000) / 10000);

// One check's RT-6 inputs from a payroll_checks row (cents columns, calc_snapshot).
function rt6CheckInputs(row) {
  const gross = num(row.gross_cents);
  const capWages = Math.min(gross, max0(RATES.futaAndStateWageBaseCents - num(row.ytd_gross_before_cents)));
  let snapshot = row.calc_snapshot;
  if (typeof snapshot === 'string') {
    try { snapshot = JSON.parse(snapshot); } catch { snapshot = null; }
  }
  return { gross, capWages, excessWages: gross - capWages, flReemployment: num(row.fl_reemployment_cents), snapshot };
}

function rt6Rate(checks) {
  const rates = new Map();
  for (const c of checks) {
    if (!c.capWages) continue;
    const stored = c.snapshot && Number(c.snapshot.floridaReemploymentRateBp);
    const bp = Number.isInteger(stored) && stored >= 0 ? stored : RATES.floridaNewEmployerBp;
    rates.set(bp, (rates.get(bp) || 0) + c.capWages);
  }
  if (!rates.size) return { bp: null, distinct: [] };
  const [bp] = [...rates.entries()].sort((a, b) => b[1] - a[1])[0];
  return { bp, distinct: [...rates.keys()].sort((a, b) => a - b) };
}

// checks: rt6CheckInputs-shaped objects (payroll-form-figures' normalized checks carry the same fields).
function rt6Tax(checks) {
  const sumOf = (key) => checks.reduce((total, c) => total + c[key], 0);
  const gross = sumOf('gross');
  const excess = sumOf('excessWages');
  const checkTax = sumOf('flReemployment');
  const { bp, distinct } = rt6Rate(checks);
  const tax = bp == null ? 0 : pct(gross - excess, bp);
  return { gross, excess, checkTax, rateBp: bp, distinct, tax };
}

module.exports = { rt6CheckInputs, rt6Rate, rt6Tax, pct };

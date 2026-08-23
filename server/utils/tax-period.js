/**
 * Tax period derivation for `expenses` rows (tax_year / quarter).
 *
 * `expenses.expense_date` is a DATE column, so the period is derived from the
 * calendar date string itself ('YYYY-MM-DD') — never via `new Date('YYYY-MM-DD')`
 * (UTC parse → local getters shift the day near midnight). Date objects are
 * first rendered as an ET calendar day via etDateString().
 *
 * Single source of truth for every expense writer (admin-tax manual POST,
 * bank import, email invoice-processor, job expenses) — readers filter on
 * tax_year, so a writer that omits it makes the row invisible to the tax
 * dashboard / 1040-ES estimate / tax advisor / IB tax tools.
 */
const { etDateString } = require('./datetime-et');

const YMD = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * @param {string|Date} expenseDate 'YYYY-MM-DD' (ISO datetime prefix accepted) or Date
 * @returns {{ tax_year: string, quarter: string } | null} null when invalid
 */
function taxPeriodFor(expenseDate) {
  let ymd = expenseDate;
  if (expenseDate instanceof Date) {
    if (Number.isNaN(expenseDate.getTime())) return null;
    ymd = etDateString(expenseDate);
  }
  if (typeof ymd !== 'string') return null;
  const m = YMD.exec(ymd.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { tax_year: String(year), quarter: `Q${Math.ceil(month / 3)}` };
}

module.exports = { taxPeriodFor };

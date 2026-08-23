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
const { etDateString, validCalendarDate } = require('./datetime-et');

/**
 * @param {string|Date} expenseDate exactly 'YYYY-MM-DD' (no time suffix —
 *   anything trailing is rejected), or a Date (rendered as its ET calendar
 *   day). Impossible calendar dates (2026-02-31) are rejected via the shared
 *   validCalendarDate round-trip so callers can 400 before Postgres sees it.
 * @returns {{ tax_year: string, quarter: string, date: string } | null}
 *   `date` is the normalized 'YYYY-MM-DD' — persist THAT, never the raw input.
 */
function taxPeriodFor(expenseDate) {
  let ymd = expenseDate;
  if (expenseDate instanceof Date) {
    if (Number.isNaN(expenseDate.getTime())) return null;
    ymd = etDateString(expenseDate);
  }
  if (typeof ymd !== 'string') return null;
  const date = validCalendarDate(ymd.trim());
  if (!date) return null;
  const month = Number(date.slice(5, 7));
  return { tax_year: date.slice(0, 4), quarter: `Q${Math.ceil(month / 3)}`, date };
}

module.exports = { taxPeriodFor };

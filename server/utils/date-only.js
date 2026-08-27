// Shared strict YYYY-MM-DD validator for date-only columns. Field-level
// checks (calendar round-trip via Date.UTC) reject shapes an ISO parse
// would accept but PostgreSQL `date` cannot store (e.g. year 0000).
// Used by the compliance licensing surface and staff registration — keep
// ONE implementation so the two routes can never disagree on what a valid
// license_expiry is.
function validDateOnly(value) {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

module.exports = { validDateOnly };

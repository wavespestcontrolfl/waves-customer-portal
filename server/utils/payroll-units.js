const PAYROLL_SCALE = 100n;

// PostgreSQL NUMERIC(..., 2) and ROUND(numeric, 2) round exact decimal values
// half away from zero. JavaScript's binary floating-point Math.round can land
// one cent lower at boundaries such as 64.725. Keep payroll arithmetic in
// integer hundredths so writers and the rollout audit share one definition.
function payrollUnits(value) {
  if (value == null || value === '') return 0n;
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(String(value).trim());
  if (!match) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? BigInt(Math.round(numeric * 100)) : 0n;
  }

  const negative = match[1] === '-';
  const fraction = match[3] || '';
  let units = BigInt(match[2]) * PAYROLL_SCALE
    + BigInt((fraction.slice(0, 2) || '').padEnd(2, '0'));
  if (fraction.length > 2 && fraction[2] >= '5') units += 1n;
  return negative ? -units : units;
}

module.exports = { PAYROLL_SCALE, payrollUnits };

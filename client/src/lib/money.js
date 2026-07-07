/**
 * Shared customer-surface money formatter (design audit 2026-07-06):
 * the estimate page previously carried three identical copies plus a
 * fourth always-".00" variant, so "$99" and "$99.00" could coexist on
 * one page. One rule everywhere: whole dollars drop cents, fractional
 * amounts always show two decimals ($149, $12.34).
 */
export function fmtMoney(n) {
  if (n == null) return '—';
  const v = Math.round(Number(n) * 100) / 100;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

// Signed variant for discount/credit lines. Negative amounts render with the
// typographic minus (U+2212) — the ASCII hyphen reads as a dash, and
// accounting parentheses don't belong on customer surfaces (estimate audit
// 2026-07-07).
export function fmtMoneySigned(n) {
  if (n == null) return '—';
  const v = Math.round(Number(n) * 100) / 100;
  return v < 0 ? `−${fmtMoney(Math.abs(v))}` : fmtMoney(v);
}

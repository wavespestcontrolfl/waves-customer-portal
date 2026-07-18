/**
 * Shared customer-surface money formatter. One rule everywhere (owner
 * directive 2026-07-11): every price shows the full amount with cents —
 * $149.00, $12.34 — never a bare "$149".
 */
export function fmtMoney(n) {
  if (n == null) return '—';
  const v = Math.round(Number(n) * 100) / 100;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

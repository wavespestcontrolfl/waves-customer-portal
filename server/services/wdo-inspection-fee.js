// WDO inspection auto-invoice fee. The tech-entered inspection fee wins. A
// blank/digit-free value uses the owner-approved flat default, while an
// explicit numeric zero is a deliberate no-charge inspection. The default
// lives in @waves/report-redaction so billing, the server fee scrub, and the
// client preview all share one number (codex #2817).
const { WDO_DEFAULT_INSPECTION_FEE } = require('@waves/report-redaction');

function parseWdoFee(value) {
  const match = String(value ?? '').replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
  const amount = match ? Number(match[1]) : 0;
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function wdoFeeIsExplicitZero(value) {
  const match = String(value ?? '').replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
  return match != null && Number(match[1]) === 0;
}

function resolveWdoInspectionFee(findings) {
  const enteredFee = parseWdoFee(findings?.inspection_fee);
  if (enteredFee > 0) return enteredFee;
  if (wdoFeeIsExplicitZero(findings?.inspection_fee)) return 0;
  return WDO_DEFAULT_INSPECTION_FEE;
}

module.exports = {
  parseWdoFee,
  resolveWdoInspectionFee,
  wdoFeeIsExplicitZero,
};

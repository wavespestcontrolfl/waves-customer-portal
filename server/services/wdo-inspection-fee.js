// WDO inspection auto-invoice fee. The tech-entered inspection fee wins. A
// blank/digit-free value uses the owner-approved $250 flat default, while an
// explicit numeric zero is a deliberate no-charge inspection.
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
  return 250;
}

module.exports = {
  parseWdoFee,
  resolveWdoInspectionFee,
  wdoFeeIsExplicitZero,
};

export function fmt(n) {
  if (n === undefined || n === null || isNaN(n)) return '$0.00';
  return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtInt(n) {
  if (n === undefined || n === null || isNaN(n)) return '$0';
  return '$' + Math.round(Number(n)).toLocaleString();
}

// The Celsius WG yearly application limit as a customer reads it. The number is never hard-coded
// in a page: the stats route (/services/stats/summary) sends celsiusMaxPerYear (2 under the v13
// lawn program, 3 before it). With no figure yet the tip names no number.
export function celsiusCapTip(celsiusMaxPerYear) {
  const max = Number(celsiusMaxPerYear);
  if (Number.isInteger(max) && max > 0) return `We spot-treat with Celsius WG (max ${max} applications a year)`;
  return 'We spot-treat with Celsius WG (a yearly application limit applies)';
}

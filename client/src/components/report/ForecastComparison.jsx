// A forecast's legacy up/down/flat field compares to a seasonal baseline.
// Never feed it to the observed-activity TrendArrow used elsewhere in reports.
const BASELINE = { above: 'Above seasonal baseline', below: 'Below seasonal baseline', near: 'Near seasonal baseline' };
const LEGACY = { up: 'above', down: 'below', flat: 'near' };
const CHANGE = { up: 'higher', down: 'lower', flat: 'similar' };

export default function ForecastComparison({ forecast }) {
  const baseline = BASELINE[forecast?.baselineComparison || LEGACY[forecast?.trend]];
  const prior = forecast?.weekOverWeek;
  const change = CHANGE[prior?.direction];
  const hasComparison = change && /^\d{4}-\d{2}-\d{2}$/.test(prior?.previous_date || '');
  if (!baseline && !hasComparison) return null;
  return <div>
    {baseline ? <div>{baseline}</div> : null}
    {hasComparison ? <div>Modeled outlook {change} {prior.direction === 'flat' ? 'to' : 'than'} {prior.previous_date}</div> : null}
  </div>;
}

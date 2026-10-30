// One reading of a Quick Move commit response, shared by every staff Quick Move
// sheet (dispatch/Details RainOutSheet and the Tech Home sheet) so they agree on
// what a result that needs attention is, and on what stays on screen for it.
//
// The server answers 200 whenever at least one stop moved, so a failed stop, a
// customer who was not texted, or a stop moved onto an occupied slot (advisory
// overlap) all arrive as a "successful" HTTP result. Those must not vanish with
// the sheet: they are returned as `needsAttention` plus a `message` and the
// `followUps` (which stops, and what is left to do).

const UNKNOWN_STOP = 'A stop on this route';

const asArray = (v) => (Array.isArray(v) ? v : []);
const plural = (n, one, many) => (n === 1 ? one : many);
// Advisory overlap warnings a moved stop carries.
const rowWarnings = (r) => (r.ok ? asArray(r.warnings) : []);

// Per-stop follow-up rules: each returns the lines one result row adds.
const ROW_ISSUES = [
  (r) => (r.ok ? [] : ['Not moved — review dispatch']),
  (r, notify) => (r.ok && notify && !r.coveredByVisit && !r.smsSent
    ? ['Customer not texted — follow up manually'] : []),
  (r) => rowWarnings(r).map(String),
];

// `data`        the parsed POST rain-out response.
// `notify`      whether the sheet asked the server to text customers.
// `display`     the window label the sheet showed ("Today, 3:00 PM-4:00 PM").
// `stopName`    optional (id) => customer name, to say WHICH stop needs follow-up.
export function summarizeQuickMoveResult(data, { notify, display, stopName } = {}) {
  const { failedCount = 0, movedCount = 0 } = data || {};
  const results = asArray(data?.results);
  // "customer texted" comes from what actually HAPPENED, not the request flag:
  // a disabled template or missing phone moves the visit without an SMS
  // (smsSent:false on that result row).
  const texted = results.filter((r) => r.ok && r.smsSent).length;
  const notTexted = !!notify && texted < movedCount;
  const overlapWarnings = Array.isArray(data?.overlapWarnings)
    ? data.overlapWarnings : results.flatMap(rowWarnings);
  const overlapCount = overlapWarnings.length;
  // First matching row wins.
  const notifyClause = !notify ? '' : [
    [texted === movedCount, plural(movedCount, ', customer texted', ', customers texted')],
    [texted === 0, ', customer NOT texted'],
    [true, `, ${texted}/${movedCount} texted`],
  ].find(([hit]) => hit)[1];
  const summary = `Moved ${movedCount} ${plural(movedCount, 'stop', 'stops')} to ${display}${notifyClause}`;

  // Attention clauses, in display order. The overlap clause carries the dated
  // warnings themselves (one per clashing occurrence — a series shift can report
  // several future dates), never a bare count.
  const clauses = [
    [failedCount > 0, ` ${failedCount} ${plural(failedCount, 'stop', 'stops')} could not be moved — review dispatch.`],
    [notTexted, ' Some customers were NOT texted (no phone or template disabled) — follow up manually.'],
    [overlapCount > 0, ` ${overlapWarnings.join(' ')} Check the route on ${plural(overlapCount, 'that day', 'those days')}.`],
  ].filter(([on]) => on);
  const needsAttention = clauses.length > 0;
  const message = needsAttention ? `${summary}.${clauses.map(([, text]) => text).join('')}` : summary;

  // Which stops need follow-up, one row per stop, in result order.
  const followUps = results
    .map((r) => ({ id: r.id, name: stopName?.(r.id) || UNKNOWN_STOP, issues: ROW_ISSUES.flatMap((rule) => rule(r, notify)) }))
    .filter((row) => row.issues.length > 0);

  return {
    summary, message, movedCount, failedCount, notTexted, overlapCount, overlapWarnings,
    needsAttention, followUps,
  };
}

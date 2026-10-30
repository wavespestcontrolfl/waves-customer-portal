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

const plural = (n, one, many) => (n === 1 ? one : many);

// `data`        the parsed POST rain-out response.
// `notify`      whether the sheet asked the server to text customers.
// `display`     the window label the sheet showed ("Today, 3:00 PM-4:00 PM").
// `stopName`    optional (id) => customer name, to say WHICH stop needs follow-up.
export function summarizeQuickMoveResult(data, { notify, display, stopName } = {}) {
  const results = Array.isArray(data?.results) ? data.results : [];
  const failedCount = data?.failedCount || 0;
  const movedCount = data?.movedCount || 0;
  // "customer texted" comes from what actually HAPPENED, not the request flag:
  // a disabled template or missing phone moves the visit without an SMS
  // (smsSent:false on that result row).
  const texted = results.filter((r) => r.ok && r.smsSent).length;
  const notTexted = !!notify && texted < movedCount;
  const overlapWarnings = Array.isArray(data?.overlapWarnings)
    ? data.overlapWarnings
    : results.flatMap((r) => (r.ok && Array.isArray(r.warnings) ? r.warnings : []));
  const overlapCount = overlapWarnings.length;
  const notifyClause = !notify ? ''
    : texted === movedCount ? (movedCount === 1 ? ', customer texted' : ', customers texted')
      : texted === 0 ? ', customer NOT texted'
        : `, ${texted}/${movedCount} texted`;
  const summary = `Moved ${movedCount} ${plural(movedCount, 'stop', 'stops')} to ${display}${notifyClause}`;
  const needsAttention = failedCount > 0 || notTexted || overlapCount > 0;

  const failClause = failedCount > 0
    ? ` ${failedCount} stop${failedCount === 1 ? '' : 's'} could not be moved — review dispatch.`
    : '';
  const smsClause = notTexted
    ? ' Some customers were NOT texted (no phone or template disabled) — follow up manually.'
    : '';
  // The dated warnings themselves (one per clashing occurrence — a series shift
  // can report several future dates), never a bare count.
  const overlapClause = overlapCount > 0
    ? ` ${overlapWarnings.join(' ')} Check the route on ${overlapCount === 1 ? 'that day' : 'those days'}.`
    : '';
  const message = needsAttention ? `${summary}.${failClause}${smsClause}${overlapClause}` : summary;

  // Which stops need follow-up, one row per stop, in result order.
  const nameOf = (id) => (stopName && id != null ? stopName(id) : '') || UNKNOWN_STOP;
  const followUps = [];
  const rowFor = (r) => {
    let row = followUps.find((f) => String(f.id) === String(r.id));
    if (!row) {
      row = { id: r.id, name: nameOf(r.id), issues: [] };
      followUps.push(row);
    }
    return row;
  };
  results.forEach((r) => {
    if (!r.ok) {
      rowFor(r).issues.push('Not moved — review dispatch');
      return;
    }
    if (notify && !r.coveredByVisit && !r.smsSent) rowFor(r).issues.push('Customer not texted — follow up manually');
    if (Array.isArray(r.warnings)) r.warnings.forEach((w) => rowFor(r).issues.push(String(w)));
  });

  return {
    summary, message, movedCount, failedCount, notTexted, overlapCount, overlapWarnings,
    needsAttention, followUps,
  };
}

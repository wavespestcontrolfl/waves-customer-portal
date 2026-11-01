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

// ---------------------------------------------------------------------------
// "Let the customer pick a day" (GATE_QUICKMOVE_CUSTOMER_PICK). Both Quick Move
// sheets hand the visit to the customer with POST .../customer-pick instead of
// booking a time. These helpers hold what the two sheets share: who the
// customer is, whether the option shows, and how the answer reads.
// ---------------------------------------------------------------------------

// Selection key of the single "Let {first} pick a day" row in MOVE TO.
export const PICK_KEY = 'customer-pick';
const NO_NAME = 'the customer';
const CUSTOM_REASON_CODE = 'custom';

const nameTokens = (full) => String(full || '').trim().split(/\s+/).filter(Boolean);

// The customer's first name: the options payload first, then the sheet's props,
// then the first word of the full name. "the customer" when nothing names them.
export function customerFirstName(options, service) {
  const named = [
    // rain-out.js getOptions sends service.customerFirstName; the rest are fallbacks.
    options?.service?.customerFirstName,
    options?.service?.firstName, options?.customer?.firstName, options?.firstName,
    service?.firstName, service?.first_name, service?.customer_first_name,
  ].find((v) => typeof v === 'string' && v.trim());
  if (named) return named.trim();
  return nameTokens(service?.customerName || service?.customer_name)[0] || NO_NAME;
}

// The surname for the Today card heading; a one-word name stays whole.
export function customerLastName(service) {
  const tokens = nameTokens(service?.customerName || service?.customer_name);
  return tokens.length > 1 ? tokens.slice(1).join(' ') : (tokens[0] || 'Customer');
}

// The payload's pick block when the option is on for this reason, else null.
// The server only sends the block with the gate on; "Custom message" is a
// dispatcher-written text, so it never offers a hand-off.
export function usablePick(options, reason) {
  const pick = options?.customerPick;
  return pick?.available && reason !== CUSTOM_REASON_CODE ? pick : null;
}

export const pickSentMessage = (first, { offRoute } = {}) => (
  `Texted ${first} to pick a day.${offRoute ? ' Stop taken off your route.' : ''}`
);
export const pickNotTextedMessage = (first) => `Handed off, but ${first} was NOT texted — call them so they can pick a time.`;

// One follow-up line from a needsAttention entry (a string, or an object that
// carries its lines as `issues` or a single `issue` / `message` / `error`).
function attentionLines(entry) {
  if (typeof entry === 'string') return [entry];
  if (Array.isArray(entry?.issues)) return entry.issues.map(String);
  const one = entry?.issue || entry?.message || entry?.error;
  return one ? [String(one)] : [];
}

// `data`  the parsed POST customer-pick response.
// `first` the customer's first name as the sheet showed it.
// Returns the shape the sheets already hand their parents (summary, message,
// movedCount, notTexted …) so a parent treats a hand-off like a clean move.
export function summarizeCustomerPickResult(data, { first, offRoute } = {}) {
  const extra = asArray(data?.needsAttention).flatMap(attentionLines);
  // A refused or failed text and any server-flagged attention row read the
  // same way: the stop is handed off but the customer must be called.
  const needsAttention = data?.textSent === false || asArray(data?.needsAttention).length > 0;
  const message = needsAttention ? pickNotTextedMessage(first) : pickSentMessage(first, { offRoute });
  return {
    pick: true,
    summary: message,
    message,
    needsAttention,
    notTexted: needsAttention,
    pickBy: data?.pickBy || null,
    movedCount: 1,
    failedCount: 0,
    overlapCount: 0,
    overlapWarnings: [],
    followUps: extra.length ? [{ id: 'customer-pick', name: first, issues: extra }] : [],
  };
}

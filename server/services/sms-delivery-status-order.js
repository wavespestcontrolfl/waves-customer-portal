/**
 * Twilio does not promise the order of its status callbacks, so a late `sent`
 * can arrive after `delivered`. A delivery status never moves backward:
 * accepted / scheduled < queued < sending < sent < the final states
 * (delivered, partially_delivered, undelivered, failed, canceled) < read.
 */
const RANK = {
  accepted: 0, scheduled: 0,
  queued: 1,
  sending: 2,
  sent: 3,
  delivered: 4, partially_delivered: 4, undelivered: 4, failed: 4, canceled: 4,
  read: 5,
};
const FINAL_RANK = 4;
const LISTED = Object.keys(RANK);

// What an incoming status may replace. The UPDATE and the tests share this one rule.
// - A status before the final states (accepted ... sent) replaces only an empty value
//   or a listed EARLIER status (`replaceOnly`). So a stored value this table does not
//   list, such as a status Twilio adds later, is never moved back to `sent`.
// - A final state, `read`, or a status this table does not list replaces everything
//   except the stored statuses in `keep`: the same status, a final state, `read`.
function storedStatusRule(incoming) {
  const rank = RANK[incoming];
  if (rank < FINAL_RANK) return { replaceOnly: ['', ...LISTED.filter((stored) => RANK[stored] < rank)] };
  const floor = rank === undefined ? FINAL_RANK : rank;
  return { keep: [...new Set([incoming, ...LISTED.filter((stored) => RANK[stored] >= floor)])] };
}

// Adds the guard to an UPDATE on `column`, so the check and the write are one
// statement (two callbacks for one text are processed concurrently). A stored
// NULL is always written.
function onlyIfNotBehind(query, column, incoming) {
  const rule = storedStatusRule(incoming);
  return query.where((b) => (rule.replaceOnly
    ? b.whereNull(column).orWhereIn(column, rule.replaceOnly)
    : b.whereNull(column).orWhereNotIn(column, rule.keep)));
}

module.exports = { storedStatusRule, onlyIfNotBehind };

/**
 * Twilio does not promise the order of its status callbacks, so a late `sent`
 * can arrive after `delivered`. A delivery status never moves backward:
 * accepted / scheduled / queued < sending < sent < the final states
 * (delivered, undelivered, failed, canceled) < read.
 */
const RANK = {
  accepted: 0, scheduled: 0, queued: 0,
  sending: 1,
  sent: 2,
  delivered: 3, undelivered: 3, failed: 3, canceled: 3,
  read: 4,
};
const FINAL_RANK = 3;

// The stored statuses an incoming status must not replace. A stored NULL, an
// empty value or a value outside RANK is never listed, so it is always written.
function storedStatusesBlocking(incoming) {
  const incomingRank = RANK[incoming];
  return Object.keys(RANK).filter((stored) => {
    if (stored === incoming) return true;
    if (incomingRank === undefined) return RANK[stored] >= FINAL_RANK;
    return RANK[stored] > incomingRank || (incomingRank === FINAL_RANK && RANK[stored] === FINAL_RANK);
  });
}

// Adds the guard to an UPDATE on `column`, so the check and the write are one
// statement (two callbacks for one text are processed concurrently).
function onlyIfNotBehind(query, column, incoming) {
  return query.where((b) => b.whereNull(column).orWhereNotIn(column, storedStatusesBlocking(incoming)));
}

module.exports = { storedStatusesBlocking, onlyIfNotBehind };

// The second half of the fence order: the tech-day fences (tech-day-lock.js), then the visit row.
// A writer that read a visit BEFORE it took its fences, and chose a technician for that read,
// reads the visit again here, after them. While that writer waited, dispatch may have moved the
// visit, changed its window, its length or its service, or assigned it: the choice was then made
// for another visit.
//
// The lock is FOR NO KEY UPDATE, the one a plain UPDATE of the row takes: another update of the
// visit waits for this transaction, and a row that only references the visit (a foreign key)
// does not. xact-scoped: the caller must be inside a transaction.

// The fields a technician assignment is judged on: the day, the hours, who has the visit, what
// and where it is (the service and the place decide which technicians can take it), and its
// state (a visit that was cancelled, skipped or started a moment ago is not the one that was read).
const ASSIGNMENT_FIELDS = ['scheduled_date', 'window_start', 'window_end', 'estimated_duration_minutes', 'technician_id',
  'customer_id', 'service_id', 'service_key_snapshot', 'service_type', 'service_address_zip', 'lat', 'lng', 'status'];

// Two reads of one column through one driver give one type. A DATE is a Date object: its time is compared.
const sameValue = (a, b) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : (a ?? null) === (b ?? null));

// `early` is the caller's first read of the visit (a full row). `day` is the day the caller
// fenced, as PostgreSQL gave it (YYYY-MM-DD). Returns the row as it stands (the table's own
// columns) and `changed`: each assignment field that differs from the first read, 'fenced day'
// for a row that is not on the fenced day (the caller's fences then guard another day), or
// 'gone' for a row that no longer exists (`row` is then null). An empty list: the row is the
// one the caller read, and a choice made for that read still holds.
async function lockVisitAsRead(trx, early, day) {
  const read = await trx('scheduled_services').where({ id: early.id }).forNoKeyUpdate()
    .first('*', trx.raw("to_char(scheduled_date, 'YYYY-MM-DD') as fenced_day_key"));
  if (!read) return { row: null, changed: ['gone'] };
  const { fenced_day_key: rowDay, ...row } = read;
  const changed = ASSIGNMENT_FIELDS.filter((field) => !sameValue(early[field], row[field]));
  if (rowDay !== day) changed.push('fenced day');
  return { row, changed };
}

module.exports = { lockVisitAsRead, ASSIGNMENT_FIELDS };

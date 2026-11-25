// GATE_TECH_SHIFT_HOURS (D4): the line both Quick Move sheets show when a "rest of route" move
// would land later stops outside the technician's shift. `rows` is the option's
// routeShiftConflicts (server/services/rain-out.js routeShiftRows): one row for each such stop,
// with the window it would land on.
//
// `own`: the technician's own sheet. That commit refuses each of those stops while the other
// stops move, so the line says they will not move. The office's commit moves them and is told a
// line for each afterwards, so its line says the move is still allowed.
//
// A row's windowEnd is null for a stop with no stored end (it is judged on its length): the
// line then names the start alone.
//
// A stored 24:00 (PostgreSQL keeps it) can reach a row. It is midnight; the sheets' formatters
// read hour 24 as noon.
const clock = (formatTime, value) => formatTime(value === '24:00' ? '00:00' : value);
const hoursOf = (row, formatTime) => (row.windowEnd
  ? `${clock(formatTime, row.windowStart)}-${clock(formatTime, row.windowEnd)}`
  : `from ${clock(formatTime, row.windowStart)}`);

export default function RouteShiftNotice({ rows, formatTime, own = false, style }) {
  if (!rows.length) return null;
  const one = rows.length === 1;
  const count = one ? '1 stop lands' : `${rows.length} stops land`;
  const where = `${one ? '' : 'first: '}${hoursOf(rows[0], formatTime)}`;
  return (
    <div style={style}>
      {own
        ? `⚠️ With the rest of the route, ${count} outside your shift hours (${where}) — ${one ? 'that stop' : 'those stops'} will not move. Pick a different time.`
        : `⚠️ With the rest of the route, ${count} outside the technician's shift hours (${where}). The move is still allowed.`}
    </div>
  );
}

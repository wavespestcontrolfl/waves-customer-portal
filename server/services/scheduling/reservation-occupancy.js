'use strict';

// Staff can book a held visit without clearing its original expiration.
// Only an unclaimed hold releases its time when the database clock reaches expiry.
// The clock is NOW() (the transaction's start), or clock_timestamp() (the
// statement's own time) for a read under a lock taken after a wait, so a hold
// that ran out during the wait no longer counts (zone-day-funnel.js zoneStopDays).
function bookedVisitOrHoldLiveAt(clock) {
  return (query) => {
    query.whereNull('scheduled_services.reservation_expires_at')
      .orWhereRaw(`scheduled_services.customer_id IS NOT NULL OR scheduled_services.reservation_expires_at > ${clock}`);
  };
}

const bookedVisitOrLiveHold = bookedVisitOrHoldLiveAt('NOW()');
const bookedVisitOrLiveHoldByRealClock = bookedVisitOrHoldLiveAt('clock_timestamp()');

// The same rule as raw SQL, for a query that aliases the table or writes its
// own WHERE (stops-ahead.js, day-quality.js, route-reorder.js).
function bookedVisitOrLiveHoldSql(table = 'scheduled_services') {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new TypeError('Invalid scheduled-services table alias');
  return `(${table}.reservation_expires_at IS NULL OR ${table}.customer_id IS NOT NULL OR ${table}.reservation_expires_at > NOW())`;
}
const BOOKED_VISIT_OR_LIVE_HOLD_SQL = bookedVisitOrLiveHoldSql();

// The same rule for a row already read into memory.
function bookedVisitOrHoldIsLive(row, now = Date.now()) {
  return row?.customer_id != null || row?.reservation_expires_at == null
    || new Date(row.reservation_expires_at).getTime() > now;
}

module.exports = {
  bookedVisitOrLiveHold, bookedVisitOrLiveHoldByRealClock,
  bookedVisitOrLiveHoldSql, BOOKED_VISIT_OR_LIVE_HOLD_SQL, bookedVisitOrHoldIsLive,
};

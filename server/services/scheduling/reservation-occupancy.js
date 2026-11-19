'use strict';

// A staff-booked visit can retain its original reservation expiry. Only an
// unclaimed hold releases its time when the database clock reaches that expiry.
function liveServiceOrHoldSql(table = 'scheduled_services') {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new TypeError('Invalid scheduled-services table alias');
  return `(${table}.reservation_expires_at IS NULL OR ${table}.customer_id IS NOT NULL OR ${table}.reservation_expires_at > NOW())`;
}
const LIVE_SERVICE_OR_HOLD_SQL = liveServiceOrHoldSql();
function liveServiceOrHold(q) {
  q.whereNull('scheduled_services.reservation_expires_at')
    .orWhereRaw('scheduled_services.customer_id IS NOT NULL OR scheduled_services.reservation_expires_at > NOW()');
}

module.exports = { liveServiceOrHold, liveServiceOrHoldSql, LIVE_SERVICE_OR_HOLD_SQL };

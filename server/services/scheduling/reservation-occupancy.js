'use strict';

function liveServiceOrHoldSql(table = 'scheduled_services') {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error('invalid scheduled-services table alias');
  return `(${table}.customer_id IS NOT NULL OR ${table}.reservation_expires_at IS NULL`
    + ` OR ${table}.reservation_expires_at > NOW())`;
}

const LIVE_SERVICE_OR_HOLD_SQL = liveServiceOrHoldSql();

// A linked appointment stays booked even if the old estimate hold still has
// an expiry stamp. Only unlinked, stamped holds expire. Use the database
// clock so an offer and its locked booking check agree at the boundary.
function liveServiceOrHold(q) {
  q.whereNull('scheduled_services.reservation_expires_at')
    .orWhereRaw('scheduled_services.customer_id IS NOT NULL OR scheduled_services.reservation_expires_at > NOW()');
}

function serviceOrHoldIsLive(row, now = Date.now()) {
  return row?.customer_id != null
    || row?.reservation_expires_at == null
    || new Date(row.reservation_expires_at).getTime() > now;
}

module.exports = {
  LIVE_SERVICE_OR_HOLD_SQL, liveServiceOrHoldSql, liveServiceOrHold, serviceOrHoldIsLive,
};

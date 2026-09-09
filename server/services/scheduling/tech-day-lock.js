// Tech-day advisory fence — shared by every writer that can add, remove, or
// reassign a stop within a technician's day (assignment, swap, date-move,
// booking, reschedule, nightly reorder). The nightly route-reorder takes this
// lock before its membership read; any membership writer that does NOT hold
// it can commit a stop into a tech-day mid-reorder and leave the committed
// route_order not covering the day (SERIALIZABLE alone cannot fence a writer
// running at weaker isolation).
//
// Namespace + key MUST stay in lockstep with the existing holders —
// rebooker.js, slot-reservation.js, route-reorder.js — which all take:
//   pg_advisory_xact_lock(hashtext('slot-reserve'), hashtext('<techId|unassigned>:<YYYY-MM-DD>'))
// A key built with a different date format silently fails to collide, which
// un-fences the writer without any error.
//
// xact-scoped: callers must be inside a transaction; locks release on
// commit/rollback. Keys are deduped and sorted so two writers locking
// overlapping day-sets always acquire in the same order (no lock-order
// deadlock).

async function lockTechDays(trx, pairs) {
  if (require('./policy').capacityEnabled()) {
    // Some nested callers already hold rows. Never wait for a date lock in
    // that order; a retry keeps the shared date-before-tech fence intact.
    const { tryAcquireOccupancyLock } = require('./occupancy');
    for (const date of [...new Set(pairs.filter(pair => pair?.date).map(pair => pair.date))].sort()) {
      if (!await tryAcquireOccupancyLock(trx, date)) throw require('./arrival-route').capacityError('route_busy');
    }
  }
  const keys = [...new Set(
    pairs
      .filter(p => p && p.date)
      .map(p => `${p.techId || 'unassigned'}:${p.date}`),
  )].sort();
  for (const key of keys) {
    await trx.raw(
      'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
      ['slot-reserve', key],
    );
  }
  return keys;
}

module.exports = { lockTechDays };

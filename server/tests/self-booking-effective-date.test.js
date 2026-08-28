/**
 * SELF_BOOKING_EFFECTIVE_DATE_SQL — the one expression both
 * max_self_books_per_day counters key on: the offer builder's fullDays sweep
 * (routes/booking.js) and the commit gate countActiveSelfBookingsForDay.
 *
 * Why: self_booked_appointments keeps the slot COPY made at booking time.
 * The public reschedule path syncs the copy when the visit moves; admin
 * moves don't — so a visit moved-and-completed days earlier still held a
 * phantom cap slot on its original date and none on its new one (2026-08-14
 * field find). The cap must follow the LIVE visit: its scheduled_date while
 * active, nothing once inactive, the copy's own date only when unlinked.
 *
 * Asserted on a real knex(pg) builder — a correlated CASE/EXISTS whose
 * shape mocked chains can't verify.
 */
const knex = require('knex');
const {
  SELF_BOOKING_EFFECTIVE_DATE_SQL,
  SELF_BOOKING_INACTIVE_STATUSES,
} = require('../services/availability');

const kx = knex({ client: 'pg' });

afterAll(() => kx.destroy());

function commitGateSql(day) {
  return kx('self_booked_appointments')
    .whereRaw(`${SELF_BOOKING_EFFECTIVE_DATE_SQL} = ?::date`, [...SELF_BOOKING_INACTIVE_STATUSES, day])
    .whereNot('status', 'cancelled')
    .count('* as count')
    .toSQL()
    .toNative();
}

describe('SELF_BOOKING_EFFECTIVE_DATE_SQL', () => {
  test('keys on the linked live visit when one exists, correlated to THIS copy', () => {
    const { sql } = commitGateSql('2026-08-19');
    expect(sql).toMatch(/case when exists \(\s*select 1 from scheduled_services as linked_visit\s+where linked_visit\.self_booking_id = self_booked_appointments\.id/i);
    expect(sql).toMatch(/select live_visit\.scheduled_date from scheduled_services as live_visit\s+where live_visit\.self_booking_id = self_booked_appointments\.id/i);
    // One row per booking, never a multiplier.
    expect(sql).toMatch(/order by live_visit\.scheduled_date asc\s+limit 1/i);
  });

  test('an inactive live visit releases the cap; the released set matches the voice-row counter', () => {
    const { sql, bindings } = commitGateSql('2026-08-19');
    // Live status filter binds positionally: $1..$3 = inactive statuses.
    expect(sql).toMatch(/live_visit\.status not in \(\$1, \$2, \$3\)/i);
    expect(bindings.slice(0, 3)).toEqual(['cancelled', 'rescheduled', 'skipped']);
    // The day itself is the LAST binding, cast to date (both sides DATE —
    // no parameter drift between offer and commit).
    expect(sql).toMatch(/end\) = \$4::date/i);
    expect(bindings[3]).toBe('2026-08-19');
  });

  test('an unlinked copy (no live visit row) counts on its own date', () => {
    const { sql } = commitGateSql('2026-08-19');
    expect(sql).toMatch(/else self_booked_appointments\.date end/i);
    // No join on the outer query — unlinked rows must survive.
    expect(sql).not.toMatch(/^select[^(]*join/i);
    expect(sql.startsWith('select count(*) as "count" from "self_booked_appointments"')).toBe(true);
  });
});

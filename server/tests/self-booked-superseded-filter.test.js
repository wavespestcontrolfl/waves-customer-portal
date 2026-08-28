/**
 * excludeSupersededSelfBookings — the shared day-cap filter that releases a
 * booking's ORIGINAL day once its linked live visit (scheduled_services.
 * self_booking_id) moved off that date or went inactive.
 *
 * Why: self_booked_appointments keeps the slot COPY made at booking time.
 * The public reschedule path syncs the copy when the visit moves; admin
 * moves don't — so a visit moved-and-completed days earlier still held a
 * phantom max_self_books_per_day slot on its original date (2026-08-14
 * field find). Both counters (the offer builder's fullDays sweep in
 * routes/booking.js and the commit gate countActiveSelfBookingsForDay)
 * apply this one helper, so offer and commit stay in lockstep.
 *
 * SQL is asserted on a real knex(pg) builder — the filter is a correlated
 * NOT EXISTS whose shape mocked chains can't verify.
 */
const knex = require('knex');
const { excludeSupersededSelfBookings } = require('../services/availability');

const kx = knex({ client: 'pg' });

afterAll(() => kx.destroy());

function buildSql() {
  return kx('self_booked_appointments')
    .whereNot('status', 'cancelled')
    .where('date', '2026-08-19')
    .modify(excludeSupersededSelfBookings)
    .count('* as count')
    .toSQL();
}

describe('excludeSupersededSelfBookings', () => {
  test('emits a correlated NOT EXISTS against the linked live visit', () => {
    const { sql } = buildSql();
    expect(sql).toMatch(/not exists \(select 1 from "scheduled_services" as "live_visit"/);
    // Correlation: the probe is keyed to THIS copy's row, not a join dup.
    expect(sql).toContain('live_visit.self_booking_id = self_booked_appointments.id');
  });

  test('a copy is superseded when the live visit moved off its date OR went inactive', () => {
    const { sql, bindings } = buildSql();
    // Moved: live date differs from the copy's own date column (row-vs-row,
    // both DATE columns — no parameter drift between offer and commit).
    expect(sql).toContain('live_visit.scheduled_date <> self_booked_appointments.date');
    // Inactive: the same released set the voice-row counter uses — a
    // cancelled/rescheduled/skipped live visit gives its capacity back.
    expect(sql).toMatch(/"live_visit"\."status" in \(\?, \?, \?\)/);
    expect(bindings).toEqual(expect.arrayContaining(['cancelled', 'rescheduled', 'skipped']));
  });

  test('an unlinked copy (no live visit row) is untouched by the filter', () => {
    // NOT EXISTS over an empty correlated set is TRUE — the filter can only
    // ever EXCLUDE rows that have a superseding live visit. Guard the shape:
    // the outer query must not have gained a join that would drop unlinked
    // rows instead.
    const { sql } = buildSql();
    expect(sql).not.toMatch(/^select[^(]*join/i);
    expect(sql.startsWith('select count(*) as "count" from "self_booked_appointments"')).toBe(true);
  });
});

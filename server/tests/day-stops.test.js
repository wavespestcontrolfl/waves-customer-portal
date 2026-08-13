// The shared day-stops scaffold must generate the SAME SQL as the inline
// queries it replaced (admin-schedule /optimize + /optimize-route,
// intelligence-bar optimize_all_routes + optimize_tech_route) — the refactor
// is extraction, not behavior change. Built with a disconnected pg knex so the
// generated SQL/bindings can be compared literally.
const knex = require('knex')({ client: 'pg' });
const { dayStopsQuery, guardedCoordSelects } = require('../services/scheduling/day-stops');
const { stampedDivergesSql } = require('../services/stamped-address');

afterAll(() => knex.destroy());

function sql(q) {
  const { sql: text, bindings } = q.toSQL();
  return { text, bindings };
}

describe('dayStopsQuery generates the pre-extraction SQL', () => {
  test('admin /optimize shape (all techs, board select list)', () => {
    const select = [
      'scheduled_services.id', 'scheduled_services.time_window',
      'scheduled_services.zone', 'scheduled_services.service_type',
      'scheduled_services.technician_id',
      ...guardedCoordSelects(knex),
      knex.raw('COALESCE(scheduled_services.service_address_city, customers.city) as city'),
      knex.raw('COALESCE(scheduled_services.service_address_zip, customers.zip) as zip'),
      knex.raw("COALESCE(customers.first_name, '') || ' ' || COALESCE(customers.last_name, '') as customer_name"),
    ];
    const got = sql(dayStopsQuery(knex, { dateStr: '2026-08-18', excludeStatuses: ['cancelled', 'completed'], select }));

    // Reference: the original inline construction (semantically identical
    // where-clauses; select list literally shared).
    const ref = sql(knex('scheduled_services')
      .where('scheduled_services.scheduled_date', '2026-08-18')
      .whereNotIn('scheduled_services.status', ['cancelled', 'completed'])
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .select(...select));
    expect(got).toEqual(ref);
    // The divergence-guarded coordinate fallback must be present verbatim.
    expect(got.text).toContain(stampedDivergesSql('scheduled_services', 'customers'));
    expect(got.text).toContain('as lat');
    expect(got.text).toContain('as lng');
  });

  test('single-tech shape adds exactly one technician_id predicate', () => {
    const base = sql(dayStopsQuery(knex, { dateStr: '2026-08-18', excludeStatuses: ['cancelled'], select: ['scheduled_services.id'] }));
    const withTech = sql(dayStopsQuery(knex, { dateStr: '2026-08-18', technicianId: 't1', excludeStatuses: ['cancelled'], select: ['scheduled_services.id'] }));
    expect(withTech.text).toContain('"scheduled_services"."technician_id" = ?');
    expect(withTech.bindings).toContain('t1');
    expect(base.text).not.toContain('technician_id');
  });

  test('IB tool shape (scheduled_services.* + customer fields + guarded coords)', () => {
    const select = [
      'scheduled_services.*',
      'customers.first_name', 'customers.last_name', 'customers.city',
      ...guardedCoordSelects(knex),
    ];
    const got = sql(dayStopsQuery(knex, {
      dateStr: '2026-08-18', technicianId: 't2', excludeStatuses: ['cancelled', 'completed', 'rescheduled'], select,
    }));
    expect(got.text).toContain('"scheduled_services".*');
    expect(got.bindings).toEqual(expect.arrayContaining(['2026-08-18', 't2', 'cancelled', 'completed', 'rescheduled']));
  });

  test('explicit excludeStatuses and select are REQUIRED (no silent defaults)', () => {
    expect(() => dayStopsQuery(knex, { dateStr: '2026-08-18', select: ['scheduled_services.id'] })).toThrow(/excludeStatuses/);
    expect(() => dayStopsQuery(knex, { dateStr: '2026-08-18', excludeStatuses: ['cancelled'] })).toThrow(/select/);
  });
});

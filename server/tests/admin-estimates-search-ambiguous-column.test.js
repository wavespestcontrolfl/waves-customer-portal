/**
 * admin estimates list — search filter column qualification.
 *
 * GET /api/admin/estimates?search=... 500'd in production for every query:
 * the list builder leftJoins `technicians`, and that table gained its own
 * `address` column in 20260428000007_technicians_payroll_profile, so the
 * unqualified `whereILike('address', ...)` compiled to a Postgres
 * "column reference \"address\" is ambiguous" error. Name and phone searches
 * failed too — the ambiguous OR-arm poisons the whole predicate.
 *
 * The db mock is a connection-less knex instance so the compiled SQL is
 * asserted for real rather than faking the builder.
 */

jest.mock('../models/db', () => require('knex')({ client: 'pg' }));

const knex = require('knex')({ client: 'pg' });
const { applyEstimateSearchFilter } = require('../routes/admin-estimates')._internals;

// Mirrors the list route's base query — the leftJoin is what makes an
// unqualified column ambiguous, so the test is worthless without it.
const listQuery = () => knex('estimates')
  .leftJoin('technicians', 'estimates.created_by_technician_id', 'technicians.id')
  .select('estimates.*', 'technicians.name as created_by_name');

describe('applyEstimateSearchFilter', () => {
  test('qualifies every searched column to the estimates table', () => {
    const { sql } = applyEstimateSearchFilter(listQuery(), 'Testerson').toSQL().toNative();
    expect(sql).toContain('"estimates"."customer_name"');
    expect(sql).toContain('"estimates"."customer_phone"');
    expect(sql).toContain('"estimates"."address"');
  });

  test('leaves no bare column reference that technicians could also satisfy', () => {
    const { sql } = applyEstimateSearchFilter(listQuery(), 'Nowhere Ln').toSQL().toNative();
    // A bare `"address"` (not preceded by a table qualifier) is the exact
    // shape Postgres rejects once technicians.address exists.
    expect(sql).not.toMatch(/(?<!\.)"address"/);
    expect(sql).not.toMatch(/(?<!\.)"customer_name"/);
    expect(sql).not.toMatch(/(?<!\.)"customer_phone"/);
  });

  test('searches name, phone and address with the same wrapped term', () => {
    const { bindings } = applyEstimateSearchFilter(listQuery(), '5550100').toSQL().toNative();
    expect(bindings.filter((b) => b === '%5550100%')).toHaveLength(3);
  });
});

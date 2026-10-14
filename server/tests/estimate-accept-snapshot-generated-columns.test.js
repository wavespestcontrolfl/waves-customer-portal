/**
 * Round 31 (#6113): database-generated non-key ids never reach the effect
 * fingerprint. A preview inserts a plan-rate family (gen_random_uuid id) and
 * rolls it back; the confirm's dry run inserts it again with a fresh id. The
 * two snapshots must shape the same, or every first recurring acceptance
 * would refuse preview_changed with no business change.
 */
const { SNAPSHOT_TABLES, shapeRow, diffTable } = require('../services/estimate-accept-snapshot');

const spec = (table) => SNAPSHOT_TABLES.find((t) => t.table === table);

describe('generated non-key columns are dropped from snapshot rows', () => {
  test('customer_plan_rates and customer_turf_profiles declare their generated id', () => {
    expect(spec('customer_plan_rates').generatedColumns).toEqual(['id']);
    expect(spec('customer_turf_profiles').generatedColumns).toEqual(['id']);
  });

  test('two inserts of the same plan-rate family with different generated ids shape identically', () => {
    const base = { customer_id: 'c1', family_key: 'pest_control', per_visit_rate: '49.00', created_at: '2026-10-12T22:00:00Z' };
    const first = shapeRow(spec('customer_plan_rates'), { id: '11111111-1111-4111-8111-111111111111', ...base });
    const second = shapeRow(spec('customer_plan_rates'), { id: '22222222-2222-4222-8222-222222222222', ...base });
    expect(first).toEqual(second);
    expect(first).not.toHaveProperty('id');
  });

  test('a turf-profile insert diffs the same whatever id the database generated', () => {
    const s = spec('customer_turf_profiles');
    const row = (id) => shapeRow(s, { id, customer_id: 'c1', turf_type: 'st_augustine', lawn_sqft: 4000 });
    expect(diffTable(s, [], [row('a')])).toEqual(diffTable(s, [], [row('b')]));
  });

  test('a non-generated column still diffs', () => {
    const s = spec('customer_plan_rates');
    const row = (rate) => shapeRow(s, { id: 'x', customer_id: 'c1', family_key: 'pest_control', per_visit_rate: rate });
    expect(diffTable(s, [row('49.00')], [row('59.00')]).changed[0].columns.per_visit_rate).toEqual({ before: '49.00', after: '59.00' });
  });
});

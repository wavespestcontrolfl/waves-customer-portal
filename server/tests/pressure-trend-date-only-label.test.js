/**
 * Audit 2026-07-16 P3: rows lacking started_at fall back to service_date,
 * which parses to UTC midnight — America/New_York label formatting rolled
 * those back to the PREVIOUS calendar day. The fallback now anchors
 * date-only values at UTC noon (dateOnlyToNoonUtc), so a visit recorded on
 * Mar 04 labels as Mar 04.
 */

const { buildPressureTrendContextFromRows } = require('../services/service-report/pressure-trend');
const { dateOnlyToNoonUtc } = require('../services/service-report/time-format');

describe('pressure trend visit labels for date-only rows', () => {
  test('a row with only service_date labels as its own calendar day (no UTC-midnight rollback)', () => {
    const record = { id: 2, customer_id: 1, pressure_index: 2.0, service_date: '2026-03-04' };
    const prior = { id: 1, customer_id: 1, pressure_index: 3.0, service_date: '2026-03-01' };
    const ctx = buildPressureTrendContextFromRows({ record, priorRows: [prior] });
    expect(ctx.points.map((p) => p.label)).toEqual(['Mar 01', 'Mar 04']);
  });

  test('rows with a real started_at timestamp keep instant-based labels', () => {
    const record = { id: 2, customer_id: 1, pressure_index: 2.0, service_date: '2026-03-04', started_at: '2026-03-04T15:00:00.000Z' };
    const prior = { id: 1, customer_id: 1, pressure_index: 3.0, service_date: '2026-03-01', started_at: '2026-03-01T15:00:00.000Z' };
    const ctx = buildPressureTrendContextFromRows({ record, priorRows: [prior] });
    expect(ctx.points.map((p) => p.label)).toEqual(['Mar 01', 'Mar 04']);
  });
});

describe('dateOnlyToNoonUtc', () => {
  test('anchors date-only strings and UTC-midnight Dates at UTC noon', () => {
    expect(dateOnlyToNoonUtc('2026-03-04').toISOString()).toBe('2026-03-04T12:00:00.000Z');
    expect(dateOnlyToNoonUtc(new Date('2026-03-04T00:00:00.000Z')).toISOString()).toBe('2026-03-04T12:00:00.000Z');
  });

  test('passes true timestamps through untouched', () => {
    expect(dateOnlyToNoonUtc('2026-03-04T15:30:00.000Z').toISOString()).toBe('2026-03-04T15:30:00.000Z');
  });
});

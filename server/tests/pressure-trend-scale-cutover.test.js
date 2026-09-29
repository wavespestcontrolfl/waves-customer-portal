// #4741 (merged 2026-09-24) made the technician's 0-5 tap the Pest Pressure
// score exactly (tap 3 -> 3.0); before, the tap was blended (tap 3 -> 0.9)
// and no stored score was recalculated. A pre-cutover 0.9 next to a
// post-cutover 3.0 is the same rating on two scales, so the customer report
// must never call it "Pest pressure increased" - nor chart it as a jump.

const {
  buildPressureTrendContextFromRows,
  buildPressureTrendContext,
  TECH_RATING_CUTOVER_AT,
} = require('../services/service-report/pressure-trend');

const CUSTOMER = 'cust-synthetic-1';

function row(id, date, pressureIndex, extra = {}) {
  return {
    id,
    customer_id: CUSTOMER,
    status: 'completed',
    service_line: 'pest',
    service_type: 'Quarterly Pest Control Service',
    service_date: date,
    started_at: `${date}T15:00:00Z`,
    pressure_index: pressureIndex,
    ...extra,
  };
}

describe('pressure trend across the #4741 scale change', () => {
  test('cutover constant is midnight ET on 2026-09-24', () => {
    expect(new Date(TECH_RATING_CUTOVER_AT).toISOString()).toBe('2026-09-24T04:00:00.000Z');
  });

  test('June blended 0.9 then September tap 3.0 is a first reading, not "increased"', () => {
    const ctx = buildPressureTrendContextFromRows({
      record: row('rec-now', '2026-09-28', 3),
      priorRows: [row('rec-june', '2026-06-10', 0.9)],
    });
    expect(ctx.direction).toBe('first_visit');
    expect(ctx.delta).toBeUndefined();
    expect(ctx.customerSummary).toContain('first pressure marker: 3.0');
    expect(ctx.customerSummary).not.toMatch(/increased/i);
    // The chart gets the same filter: no fake 0.9 -> 3.0 jump.
    expect(ctx.points.map((p) => p.pressureIndex)).toEqual([3]);
    expect(ctx.points[0]).not.toHaveProperty('scale');
  });

  test('a low pre-cutover baseline does not trigger the low-baseline "increased" copy either', () => {
    const ctx = buildPressureTrendContextFromRows({
      record: row('rec-now', '2026-09-28', 1),
      priorRows: [row('rec-june', '2026-06-10', 0)],
    });
    expect(ctx.direction).toBe('first_visit');
    expect(ctx.customerSummary).not.toMatch(/increased/i);
  });

  test('old-scale readings still compare with each other', () => {
    const ctx = buildPressureTrendContextFromRows({
      record: row('rec-now', '2026-08-01', 1.7),
      priorRows: [row('rec-june', '2026-06-10', 0.9)],
    });
    expect(ctx.direction).toBe('up');
    expect(ctx.points).toHaveLength(2);
  });

  test('new-scale readings compare with each other, ignoring older blended ones', () => {
    const ctx = buildPressureTrendContextFromRows({
      record: row('rec-now', '2026-10-20', 2),
      priorRows: [
        row('rec-june', '2026-06-10', 0.9),
        row('rec-sep', '2026-09-25', 4),
      ],
    });
    expect(ctx.direction).toBe('down');
    expect(ctx.points.map((p) => p.pressureIndex)).toEqual([4, 2]);
  });

  test('an explicit per-record marker beats the cutover date', () => {
    // A customer-rated (blended) reading recorded after the cutover still
    // compares with older blended readings; a tap dated before it would not.
    const blendedAfter = buildPressureTrendContextFromRows({
      record: row('rec-now', '2026-10-01', 1.5, { pressure_scale: 'blended' }),
      priorRows: [row('rec-june', '2026-06-10', 0.9)],
    });
    expect(blendedAfter.direction).toBe('up');
    expect(blendedAfter.points).toHaveLength(2);
  });

  describe('database builder reads the score-row provenance', () => {
    function fakeKnex({ records, scores }) {
      return (table) => {
        const data = { service_records: records, pest_pressure_scores: scores, service_findings: [] }[table] || [];
        const q = {
          select: () => q,
          where: () => q,
          whereNot: () => q,
          whereNotNull: () => q,
          whereIn: () => q,
          modify: () => q,
          orderBy: () => q,
          limit: () => q,
          catch: () => Promise.resolve(data),
          then: (resolve, reject) => Promise.resolve(data).then(resolve, reject),
        };
        return q;
      };
    }
    const TAP = { technicianActivityRating: { value: 3, weight: 100, present: true } };

    test('tap-scored current visit vs a blended prior stays a first reading', async () => {
      const ctx = await buildPressureTrendContext({
        record: row('rec-now', '2026-09-28', 3),
        knex: fakeKnex({
          records: [row('rec-june', '2026-06-10', 0.9)],
          scores: [
            { service_record_id: 'rec-now', component_scores: TAP },
            { service_record_id: 'rec-june', component_scores: { clientRating: { value: 3, weight: 25, present: true } } },
          ],
        }),
      });
      expect(ctx.direction).toBe('first_visit');
      expect(ctx.points.map((p) => p.pressureIndex)).toEqual([3]);
    });

    test('two tap-scored visits compare and ignore the older blended one', async () => {
      const ctx = await buildPressureTrendContext({
        record: row('rec-now', '2026-10-20', 2),
        knex: fakeKnex({
          records: [row('rec-sep', '2026-09-25', 4), row('rec-june', '2026-06-10', 0.9)],
          scores: [
            { service_record_id: 'rec-now', component_scores: TAP },
            { service_record_id: 'rec-sep', component_scores: TAP },
            { service_record_id: 'rec-june', component_scores: {} },
          ],
        }),
      });
      expect(ctx.direction).toBe('down');
      expect(ctx.points.map((p) => p.pressureIndex)).toEqual([4, 2]);
    });

    test('the score-row marker beats the date: a post-cutover blended prior is not a tap-scale prior', async () => {
      const ctx = await buildPressureTrendContext({
        record: row('rec-now', '2026-10-20', 2),
        knex: fakeKnex({
          records: [row('rec-sep', '2026-09-25', 0.5)],
          scores: [
            { service_record_id: 'rec-now', component_scores: TAP },
            { service_record_id: 'rec-sep', component_scores: { clientRating: { value: 1, weight: 25, present: true } } },
          ],
        }),
      });
      expect(ctx.direction).toBe('first_visit');
      expect(ctx.points.map((p) => p.pressureIndex)).toEqual([2]);
    });

    test('a failed provenance lookup falls back to the cutover date', async () => {
      const knex = (table) => {
        const q = {
          select: () => q, where: () => q, whereNot: () => q, whereNotNull: () => q, whereIn: () => q,
          modify: () => q, orderBy: () => q, limit: () => q,
          catch: (handler) => (table === 'pest_pressure_scores'
            ? Promise.reject(new Error('relation does not exist')).catch(handler)
            : Promise.resolve(table === 'service_records' ? [row('rec-june', '2026-06-10', 0.9)] : [])),
          then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
        };
        return q;
      };
      const ctx = await buildPressureTrendContext({ record: row('rec-now', '2026-09-28', 3), knex });
      expect(ctx.direction).toBe('first_visit');
    });
  });
});

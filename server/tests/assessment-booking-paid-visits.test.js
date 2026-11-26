// The paid-visit read an annual renewal start comes from. Compiled SQL only: no database is needed.
jest.mock('../models/db', () => jest.fn());

const knex = require('knex');
const { paidEstimateVisitsQuery } = require('../services/assessment-booking');

const compile = () => paidEstimateVisitsQuery(knex({ client: 'pg' }), { estimateId: 'est-1', customerId: 'cust-1' }).toSQL();

describe('paidEstimateVisitsQuery', () => {
  test('reads only this estimate and this estimate\'s own customer', () => {
    const { sql, bindings } = compile();
    expect(sql).toMatch(/"scheduled_services"\."source_estimate_id" = \?|"scheduled_services"\."source_estimate_id" = \$1/);
    expect(sql).toMatch(/"scheduled_services"\."customer_id" = /);
    expect(bindings).toEqual(expect.arrayContaining(['est-1', 'cust-1']));
    expect(sql).toMatch(/"scheduled_services"\."reservation_expires_at" is null/);
  });

  test('callbacks, retained history and free assessments never anchor a paid term', () => {
    const { sql, bindings } = compile();
    expect(sql).toMatch(/is_callback IS NOT TRUE/);
    expect(sql).toMatch(/"scheduled_services"\."status" not in/);
    expect(bindings).toEqual(expect.arrayContaining(['cancelled', 'skipped', 'no_show', 'rescheduled']));
    expect(sql).toMatch(/NOT \(CASE WHEN/);
  });

  test('a legacy re-service whose callback flag is false never anchors a paid term', () => {
    const { sql, bindings } = compile();
    expect(sql).toMatch(/= ANY\(/);
    expect(sql).toMatch(/~\* /);
    expect(bindings).toEqual(expect.arrayContaining([['pest_re_service', 'lawn_re_service', 'rodent_trapping_followup']]));
    expect(bindings).toContain('\\mre-?service\\M');
  });

  test('included follow-ups and always-free labels never anchor a paid term', () => {
    const { sql, bindings } = compile();
    expect(sql).toMatch(/followup_included IS NOT TRUE/);
    expect(sql).toMatch(/COALESCE\(scheduled_services\.service_type, ''\) !~\* /);
    expect(bindings).toContain(require('../services/no-cost-visit-types').ALWAYS_FREE_SERVICE_TYPE_SQL_REGEX);
  });

  test('same-day visits order by start time then id after the date', () => {
    expect(compile().sql).toMatch(/order by "scheduled_services"\."scheduled_date" asc, "scheduled_services"\."window_start" asc, "scheduled_services"\."id" asc/);
  });
});

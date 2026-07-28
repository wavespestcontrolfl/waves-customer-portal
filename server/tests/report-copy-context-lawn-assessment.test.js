jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { buildReportCopyContext } = require('../services/service-report/report-copy-context');

// Permissive knex stub: every builder call returns the chain; awaiting it
// resolves to the rows configured for that table (empty otherwise).
function makeKnexStub(rowsByTable = {}) {
  const calls = [];
  const stub = (table) => {
    calls.push(table);
    const rows = rowsByTable[table] || [];
    const chain = {};
    for (const method of ['where', 'whereIn', 'whereNull', 'whereNot', 'orWhere', 'orderBy', 'orderByRaw', 'limit', 'select', 'leftJoin', 'join', 'groupBy', 'count', 'whereRaw', 'whereBetween']) {
      chain[method] = () => chain;
    }
    chain.first = async () => rows[0];
    chain.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
    chain.catch = () => chain;
    return chain;
  };
  stub.calls = calls;
  return stub;
}

const CUSTOMER = { id: 'c1', first_name: 'Pat', last_name: 'Lawn', city: 'Bradenton', state: 'FL', latitude: null, longitude: null, lawn_type: 'st_augustine', waveguard_tier: 'silver' };

describe('buildReportCopyContext lawn assessment grounding', () => {
  test('same-day confirmed assessment renders scores with deltas vs prior', async () => {
    const knex = makeKnexStub({
      customers: [CUSTOMER],
      lawn_assessments: [
        { service_date: '2026-07-28', is_baseline: false, observations: 'Chinch pressure easing along the driveway strip.', turf_density: 72, weed_suppression: 81, color_health: 64, fungus_control: 90, thatch_level: 70 },
        { service_date: '2026-06-20', is_baseline: false, observations: '', turf_density: 64, weed_suppression: 81, color_health: 58, fungus_control: 88, thatch_level: 70 },
      ],
    });
    const { contextText, signals } = await buildReportCopyContext({
      customerId: 'c1',
      serviceType: 'Monthly Lawn Care Service',
      serviceDate: '2026-07-28',
      knex,
    });
    expect(contextText).toContain('LAWN ASSESSMENT (photo-scored TODAY');
    expect(contextText).toContain('turf density 72/100 (+8 vs Jun 20, 2026)');
    expect(contextText).toContain('color health 64/100 (+6 vs Jun 20, 2026)');
    // Unchanged metrics carry no delta suffix.
    expect(contextText).toContain('weed suppression 81/100,');
    expect(contextText).toContain('Chinch pressure easing');
    expect(signals.hasLawnAssessment).toBe(true);
  });

  test('prior-only assessment is presented as history, not today', async () => {
    const knex = makeKnexStub({
      customers: [CUSTOMER],
      lawn_assessments: [
        { service_date: '2026-06-20', is_baseline: true, observations: '', turf_density: 64, weed_suppression: 70, color_health: 58, fungus_control: 88, thatch_level: 66 },
      ],
    });
    const { contextText } = await buildReportCopyContext({
      customerId: 'c1',
      serviceType: 'Monthly Lawn Care Service',
      serviceDate: '2026-07-28',
      knex,
    });
    expect(contextText).toContain('LAST LAWN ASSESSMENT (photo-scored Jun 20, 2026');
    expect(contextText).toContain('NOT today');
    expect(contextText).not.toContain('photo-scored TODAY');
  });

  test('non-lawn service lines never query lawn_assessments', async () => {
    const knex = makeKnexStub({ customers: [CUSTOMER] });
    const { contextText, signals } = await buildReportCopyContext({
      customerId: 'c1',
      serviceType: 'Quarterly Pest Control Service',
      serviceDate: '2026-07-28',
      knex,
    });
    expect(knex.calls).not.toContain('lawn_assessments');
    expect(contextText).not.toContain('LAWN ASSESSMENT');
    expect(signals.hasLawnAssessment).toBe(false);
  });
});

const { mapFindingsToRating } = require('../services/pest-pressure/components/technician-rating');
const { mapCountToRating, extractReServiceImpact } = require('../services/pest-pressure/components/re-service-impact');
const { mapPriorCycleCountToRating, buildSignatureSet } = require('../services/pest-pressure/components/recurring-issue');
const { mapRiskFindingsToRating } = require('../services/pest-pressure/components/risk-factor');

describe('technician-rating: mapFindingsToRating', () => {
  test('empty array → 0 (no evidence)', () => {
    expect(mapFindingsToRating([])).toBe(0);
  });

  test('only no_activity → 0', () => {
    expect(mapFindingsToRating([{ category: 'no_activity', severity: 'info' }])).toBe(0);
  });

  test('single low → 1 (minor evidence)', () => {
    expect(mapFindingsToRating([{ category: 'ant', severity: 'low' }])).toBe(1);
  });

  test('multiple low → 2 (light activity)', () => {
    expect(mapFindingsToRating([
      { category: 'ant', severity: 'low' },
      { category: 'spider', severity: 'low' },
    ])).toBe(2);
  });

  test('medium → 3 (active infestation)', () => {
    expect(mapFindingsToRating([{ category: 'roach', severity: 'medium' }])).toBe(3);
  });

  test('high → 4', () => {
    expect(mapFindingsToRating([{ category: 'roach', severity: 'high' }])).toBe(4);
  });

  test('critical → 5', () => {
    expect(mapFindingsToRating([{ category: 'rodent', severity: 'critical' }])).toBe(5);
  });

  test('mixed severities take the max', () => {
    expect(mapFindingsToRating([
      { category: 'ant', severity: 'low' },
      { category: 'roach', severity: 'high' },
      { category: 'spider', severity: 'medium' },
    ])).toBe(4);
  });
});

describe('re-service-impact: mapCountToRating', () => {
  test.each([
    [0, 0],
    [1, 3],
    [2, 4],
    [3, 5],
    [10, 5],
  ])('%i callbacks → %i', (count, expected) => {
    expect(mapCountToRating(count)).toBe(expected);
  });
});

describe('re-service-impact: extractReServiceImpact (mocked knex)', () => {
  function mockKnex(rows) {
    const builder = {
      where: jest.fn().mockReturnThis(),
      whereBetween: jest.fn().mockReturnThis(),
      whereNot: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue(rows),
    };
    return jest.fn().mockReturnValue(builder);
  }

  const baseArgs = {
    customerId: 'cust-1',
    serviceRecordId: 'svc-current',
    reviewPeriodStart: '2026-04-01',
    reviewPeriodEnd: '2026-05-17',
  };

  test('no rows → 0', async () => {
    const knex = mockKnex([]);
    const result = await extractReServiceImpact({ knex, ...baseArgs });
    expect(result.value).toBe(0);
    expect(result.count).toBe(0);
  });

  test('two qualifying callbacks → 4', async () => {
    const knex = mockKnex([
      { id: 'cb1', service_date: '2026-04-10', service_type: 'Callback', cancellation_reason: null },
      { id: 'cb2', service_date: '2026-04-25', service_type: 'Callback', cancellation_reason: null },
    ]);
    const result = await extractReServiceImpact({ knex, ...baseArgs });
    expect(result.value).toBe(4);
    expect(result.count).toBe(2);
  });

  test('excludes cancelled / no-show / administrative_reschedule', async () => {
    const knex = mockKnex([
      { id: 'cb1', service_date: '2026-04-10', cancellation_reason: 'no_show' },
      { id: 'cb2', service_date: '2026-04-15', cancellation_reason: 'cancelled' },
      { id: 'cb3', service_date: '2026-04-20', cancellation_reason: 'administrative_reschedule' },
      { id: 'cb4', service_date: '2026-04-25', cancellation_reason: null },
    ]);
    const result = await extractReServiceImpact({ knex, ...baseArgs });
    expect(result.value).toBe(3); // 1 qualifying callback
    expect(result.count).toBe(1);
    expect(result.rawCount).toBe(4);
  });
});

describe('recurring-issue: mapPriorCycleCountToRating', () => {
  test.each([
    [0, 0],
    [1, 1],
    [2, 3],
    [3, 5],
    [7, 5],
  ])('%i prior cycles with match → %i', (count, expected) => {
    expect(mapPriorCycleCountToRating(count)).toBe(expected);
  });
});

describe('recurring-issue: buildSignatureSet', () => {
  test('omits no_activity findings', () => {
    const set = buildSignatureSet([
      { category: 'no_activity', zone_id: 'z1' },
      { category: 'ant', zone_id: 'z2' },
    ]);
    expect(set.has('cat:no_activity')).toBe(false);
    expect(set.has('cat:ant')).toBe(true);
    expect(set.has('zone:z2')).toBe(true);
  });
});

describe('risk-factor: mapRiskFindingsToRating', () => {
  test('no findings → 0', () => {
    expect(mapRiskFindingsToRating([])).toBe(0);
  });

  test('one minor finding → 1', () => {
    expect(mapRiskFindingsToRating([{ category: 'moisture', severity: 'low' }])).toBe(1);
  });

  test('two minor findings → 2', () => {
    expect(mapRiskFindingsToRating([
      { category: 'moisture', severity: 'low' },
      { category: 'entry_point', severity: 'medium' },
    ])).toBe(2);
  });

  test('three or more findings → 3', () => {
    expect(mapRiskFindingsToRating([
      { category: 'moisture', severity: 'low' },
      { category: 'entry_point', severity: 'medium' },
      { category: 'harborage', severity: 'low' },
    ])).toBe(3);
  });

  test('any high severity → 4', () => {
    expect(mapRiskFindingsToRating([
      { category: 'entry_point', severity: 'high' },
    ])).toBe(4);
  });

  test('any critical severity → 5', () => {
    expect(mapRiskFindingsToRating([
      { category: 'entry_point', severity: 'low' },
      { category: 'moisture', severity: 'critical' },
    ])).toBe(5);
  });
});

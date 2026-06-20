const { mapFindingsToRating } = require('../services/pest-pressure/components/technician-rating');
const { mapCountToRating, extractReServiceImpact } = require('../services/pest-pressure/components/re-service-impact');
const { mapPriorCycleCountToRating, buildSignatureSet, extractRecurringIssue } = require('../services/pest-pressure/components/recurring-issue');
const { mapRiskFindingsToRating } = require('../services/pest-pressure/components/risk-factor');
const {
  serviceRecordSuppressesCustomerArtifacts,
  customerVisibleServiceRecordPredicate,
} = require('../services/pest-pressure/history-filter');

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
      whereRaw: jest.fn().mockReturnThis(),
      whereBetween: jest.fn().mockReturnThis(),
      whereNot: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue(rows),
    };
    const knex = jest.fn().mockReturnValue(builder);
    knex.builder = builder;
    return knex;
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
      { id: 'cb1', service_date: '2026-04-10', service_type: 'Callback' },
      { id: 'cb2', service_date: '2026-04-25', service_type: 'Callback' },
    ]);
    const result = await extractReServiceImpact({ knex, ...baseArgs });
    expect(result.value).toBe(4);
    expect(result.count).toBe(2);
  });

  test('excludes suppressed internal-only records from callback history query', async () => {
    const knex = mockKnex([]);
    await extractReServiceImpact({ knex, ...baseArgs });

    expect(knex.builder.whereRaw).toHaveBeenCalledWith(
      customerVisibleServiceRecordPredicate('service_records'),
    );
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

describe('recurring-issue: extractRecurringIssue cutoff date (codex P1 regression guard)', () => {
  // Before the fix, the prior-records query had no service_date filter,
  // so recalculating an older record after newer visits existed would
  // surface those newer records as "prior cycles" and inflate the
  // recurringIssueRating. The fix adds a `service_date < cutoff` filter
  // — either from the caller-passed serviceDate or by looking up the
  // current record's date from service_records.

  function buildKnex({ currentFindings = [], currentRecord = null, priorRecords = [], priorFindings = [], expectLookup = true } = {}) {
    const calls = { priorRecordsQuery: { whereCalls: [], whereRawCalls: [], orderBy: null, limit: null } };

    function priorRecordsChain() {
      // Capture .where(...) and .whereNot(...) invocations so the test
      // can assert the cutoff filter was applied.
      const chain = {};
      chain.where = jest.fn((...args) => { calls.priorRecordsQuery.whereCalls.push(['where', args]); return chain; });
      chain.whereRaw = jest.fn((...args) => { calls.priorRecordsQuery.whereRawCalls.push(args); return chain; });
      chain.whereNot = jest.fn((...args) => { calls.priorRecordsQuery.whereCalls.push(['whereNot', args]); return chain; });
      chain.orderBy = jest.fn((col, dir) => { calls.priorRecordsQuery.orderBy = [col, dir]; return chain; });
      chain.limit = jest.fn((n) => { calls.priorRecordsQuery.limit = n; return chain; });
      chain.select = jest.fn(() => chain);
      chain.then = (resolve, reject) => Promise.resolve(priorRecords).then(resolve, reject);
      chain.catch = (reject) => Promise.resolve(priorRecords).catch(reject);
      return chain;
    }

    function currentFindingsChain() {
      const chain = {
        where: jest.fn(() => chain),
        select: jest.fn(async () => currentFindings),
      };
      return chain;
    }

    function currentRecordLookupChain() {
      const chain = {
        where: jest.fn(() => chain),
        select: jest.fn(() => chain),
        first: jest.fn(async () => currentRecord),
      };
      return chain;
    }

    function priorFindingsChain() {
      const chain = {
        whereIn: jest.fn(() => chain),
        select: jest.fn(async () => priorFindings),
      };
      return chain;
    }

    // service_findings is hit twice (current + prior). service_records
    // is hit once (priorRecordsQuery) when serviceDate is passed by the
    // caller, or twice (current lookup + priorRecordsQuery) when omitted.
    const findingsCallSeq = [currentFindingsChain(), priorFindingsChain()];
    const recordsCallSeq = expectLookup
      ? [currentRecordLookupChain(), priorRecordsChain()]
      : [priorRecordsChain()];

    const knex = jest.fn((table) => {
      if (table === 'service_findings') {
        if (findingsCallSeq.length === 0) throw new Error('unexpected service_findings call');
        return findingsCallSeq.shift();
      }
      if (table === 'service_records') {
        if (recordsCallSeq.length === 0) throw new Error('unexpected service_records call');
        return recordsCallSeq.shift();
      }
      throw new Error(`unexpected table: ${table}`);
    });

    return { knex, calls };
  }

  test('applies service_date < cutoff filter when serviceDate is passed by caller', async () => {
    const { knex, calls } = buildKnex({
      currentFindings: [{ category: 'roach', zone_id: 'kitchen' }],
      priorRecords: [{ id: 'rec-old-1', service_date: '2026-03-01' }],
      priorFindings: [],
      expectLookup: false, // serviceDate passed → no fallback DB lookup
    });

    await extractRecurringIssue({
      knex,
      customerId: 'cust-1',
      serviceRecordId: 'rec-current',
      serviceDate: '2026-05-15',
    });

    const cutoffFilter = calls.priorRecordsQuery.whereCalls.find(
      ([, args]) => args[0] === 'service_date' && args[1] === '<',
    );
    expect(cutoffFilter).toBeDefined();
    expect(cutoffFilter[1][2]).toBe('2026-05-15');
    expect(calls.priorRecordsQuery.whereRawCalls).toContainEqual([
      customerVisibleServiceRecordPredicate('service_records'),
    ]);
  });

  test('looks up cutoff from service_records when serviceDate is not passed', async () => {
    const { knex, calls } = buildKnex({
      currentFindings: [{ category: 'ant', zone_id: 'patio' }],
      currentRecord: { service_date: '2026-04-10' },
      priorRecords: [],
      priorFindings: [],
    });

    await extractRecurringIssue({
      knex,
      customerId: 'cust-1',
      serviceRecordId: 'rec-current',
    });

    const cutoffFilter = calls.priorRecordsQuery.whereCalls.find(
      ([, args]) => args[0] === 'service_date' && args[1] === '<',
    );
    expect(cutoffFilter).toBeDefined();
    expect(cutoffFilter[1][2]).toBe('2026-04-10');
  });

  test('skips cutoff filter when neither caller-passed nor DB-resolvable date is available', async () => {
    // currentRecord intentionally null — service_records lookup returns null.
    // Defensive behavior: don't add a `service_date < null` filter that
    // would silently drop everything; let the query run unfiltered and
    // rely on the existing MAX_LOOKBACK limit to bound results.
    const { knex, calls } = buildKnex({
      currentFindings: [{ category: 'roach', zone_id: 'kitchen' }],
      currentRecord: null,
      priorRecords: [],
      priorFindings: [],
    });

    await extractRecurringIssue({
      knex,
      customerId: 'cust-1',
      serviceRecordId: 'rec-current',
    });

    const cutoffFilter = calls.priorRecordsQuery.whereCalls.find(
      ([, args]) => args[0] === 'service_date' && args[1] === '<',
    );
    expect(cutoffFilter).toBeUndefined();
  });
});

describe('pest-pressure history visibility filter', () => {
  test('suppresses non-auto_send service records from Pest Pressure history', () => {
    expect(serviceRecordSuppressesCustomerArtifacts({
      structured_notes: JSON.stringify({ typedReportDelivery: 'disabled' }),
    })).toBe(true);
    expect(serviceRecordSuppressesCustomerArtifacts({
      structured_notes: { typedReportDelivery: 'internal_only' },
    })).toBe(true);
    expect(serviceRecordSuppressesCustomerArtifacts({
      structured_notes: { typedReportDelivery: 'auto_send' },
    })).toBe(false);
    expect(serviceRecordSuppressesCustomerArtifacts({ structured_notes: '{}' })).toBe(false);
  });
});

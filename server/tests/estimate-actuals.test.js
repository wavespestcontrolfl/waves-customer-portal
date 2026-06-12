let mockDbHandler = () => { throw new Error('db handler not configured'); };

jest.mock('../models/db', () => {
  const mock = jest.fn((...args) => mockDbHandler(...args));
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql, bindings) => ({ __raw: sql, __bindings: bindings }));
  return mock;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../utils/cron-lock', () => ({
  runExclusive: (jobName, fn) => fn(),
}));

const {
  reconcileEstimateActuals,
  runEstimateActualsReconcile,
  varianceSummary,
  _private: { actualDurationMinutes, buildActualsRow, deltaPct, extractEstimateProfile },
} = require('../services/estimate-actuals');

afterEach(() => {
  delete process.env.ESTIMATE_ACTUALS_DISABLED;
});

describe('extractEstimateProfile', () => {
  it('reads the admin engineRequest.profile shape', () => {
    expect(extractEstimateProfile({
      engineRequest: { profile: { homeSqFt: '2200', lotSqFt: 9000, measuredTurfSf: 5200, estimatedTurfSf: 6100, stories: 1 } },
    })).toEqual({ homeSqFt: 2200, lotSqFt: 9000, turfSqFt: 5200, stories: 1 });
  });

  it('reads the public engineInputs v1 shape and prefers measured turf', () => {
    expect(extractEstimateProfile({
      engineInputs: { homeSqFt: 1800, lotSqFt: 7000, estimatedTurfSf: 4000, stories: 2 },
    })).toEqual({ homeSqFt: 1800, lotSqFt: 7000, turfSqFt: 4000, stories: 2 });
  });

  it('returns null on missing/garbage estimate_data', () => {
    expect(extractEstimateProfile(null)).toBeNull();
    expect(extractEstimateProfile({})).toBeNull();
    expect(extractEstimateProfile({ engineRequest: 'nope' })).toBeNull();
  });
});

describe('deltaPct', () => {
  it('positive when actual runs OVER the estimate', () => {
    expect(deltaPct(5000, 6000)).toBe(20);
    expect(deltaPct(6000, 5000)).toBeCloseTo(-16.67, 1);
  });

  it('missing either side is no-signal null, never 0 or a div-by-zero', () => {
    expect(deltaPct(null, 6000)).toBeNull();
    expect(deltaPct(5000, null)).toBeNull();
    expect(deltaPct(0, 6000)).toBeNull();
    expect(deltaPct('junk', 6000)).toBeNull();
  });
});

describe('actualDurationMinutes', () => {
  it('prefers the tracked actual_duration_minutes', () => {
    expect(actualDurationMinutes({ actual_duration_minutes: 47 }, {})).toBe(47);
  });

  it('falls back to arrival→completion, then report started→ended', () => {
    expect(actualDurationMinutes(
      { arrived_at: '2026-06-10T14:00:00Z', completed_at: '2026-06-10T14:45:00Z' }, {},
    )).toBe(45);
    expect(actualDurationMinutes(
      {},
      { started_at: '2026-06-10T14:00:00Z', ended_at: '2026-06-10T14:30:00Z' },
    )).toBe(30);
  });

  it('rejects nonsense spans (negative, multi-day) instead of poisoning deltas', () => {
    expect(actualDurationMinutes(
      { arrived_at: '2026-06-10T15:00:00Z', completed_at: '2026-06-10T14:00:00Z' }, {},
    )).toBeNull();
    expect(actualDurationMinutes(
      { arrived_at: '2026-06-01T14:00:00Z', completed_at: '2026-06-10T14:00:00Z' }, {},
    )).toBeNull();
  });
});

describe('buildActualsRow', () => {
  const baseInputs = {
    serviceRecord: {
      id: 'sr-1', customer_id: 'cust-1', service_line: 'lawn_care', service_date: '2026-06-10',
      started_at: null, ended_at: null,
    },
    scheduledService: {
      id: 'ss-1', estimated_duration_minutes: 40, actual_duration_minutes: 50,
      arrived_at: null, completed_at: null,
    },
    estimate: {
      id: 'est-1',
      estimate_data: { engineRequest: { profile: { homeSqFt: 2200, lotSqFt: 9000, estimatedTurfSf: 5000, stories: 1 } } },
    },
    completion: { treated_sqft: 6000, total_carrier_gal: 12.5 },
    productCount: '3',
  };

  it('writes priced-vs-observed with scalar deltas', () => {
    const row = buildActualsRow(baseInputs);
    expect(row.service_record_id).toBe('sr-1');
    expect(row.estimate_id).toBe('est-1');
    expect(JSON.parse(row.estimated)).toEqual({
      homeSqFt: 2200, lotSqFt: 9000, turfSqFt: 5000, stories: 1, durationMinutes: 40,
    });
    expect(JSON.parse(row.actual)).toEqual({
      treatedSqft: 6000, durationMinutes: 50, productCount: 3, totalCarrierGal: 12.5,
    });
    expect(row.turf_delta_pct).toBe(20);
    expect(row.duration_delta_pct).toBe(25);
  });

  it('a pest visit with no lawn completion has null turf delta, real duration delta', () => {
    const row = buildActualsRow({ ...baseInputs, completion: null, productCount: 0 });
    expect(row.turf_delta_pct).toBeNull();
    expect(row.duration_delta_pct).toBe(25);
    expect(JSON.parse(row.actual).treatedSqft).toBeNull();
  });
});

describe('reconcileEstimateActuals', () => {
  function spineBuilder(rows, captured) {
    const builder = {
      join() { return builder; },
      where() { return builder; },
      select() { return builder; },
      orderBy() { return builder; },
      limit: async () => rows,
    };
    return builder;
  }

  it('upserts one ledger row per completed traced service (idempotent on conflict)', async () => {
    const upserts = [];
    const spineRow = {
      service_record_id: 'sr-1', customer_id: 'cust-1', service_line: 'lawn_care',
      service_date: '2026-06-10', started_at: null, ended_at: null,
      scheduled_service_id: 'ss-1', estimated_duration_minutes: 40,
      actual_duration_minutes: 50, arrived_at: null, completed_at: null,
      estimate_id: 'est-1',
      estimate_data: { engineInputs: { homeSqFt: 2000, estimatedTurfSf: 5000 } },
    };
    mockDbHandler = (table) => {
      if (table === 'service_records as sr') return spineBuilder([spineRow]);
      if (table === 'lawn_protocol_service_completions') {
        return { where: () => ({ first: async () => ({ treated_sqft: 5500, total_carrier_gal: 10 }) }) };
      }
      if (table === 'service_products') {
        return { where: () => ({ count: () => ({ first: async () => ({ count: '2' }) }) }) };
      }
      if (table === 'estimate_actuals') {
        return {
          insert: (payload) => ({
            onConflict: (col) => ({
              merge: async () => { upserts.push({ payload, conflictCol: col }); },
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    };

    const result = await reconcileEstimateActuals();
    expect(result).toEqual({ written: 1, failed: 0, scanned: 1 });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].conflictCol).toBe('service_record_id');
    expect(upserts[0].payload.turf_delta_pct).toBe(10);
  });

  it('one malformed row does not abort the batch', async () => {
    const upserts = [];
    const rows = [
      { service_record_id: 'sr-bad', estimate_id: 'est-1', estimate_data: {} },
      {
        service_record_id: 'sr-ok', customer_id: 'cust-1', service_line: 'pest_control',
        service_date: '2026-06-10', scheduled_service_id: 'ss-2',
        estimated_duration_minutes: 30, actual_duration_minutes: 30,
        estimate_id: 'est-2', estimate_data: { engineInputs: { homeSqFt: 1500 } },
      },
    ];
    mockDbHandler = (table) => {
      if (table === 'service_records as sr') return spineBuilder(rows);
      if (table === 'lawn_protocol_service_completions') {
        return {
          where: ({ service_record_id }) => ({
            first: async () => {
              if (service_record_id === 'sr-bad') throw new Error('boom');
              return null;
            },
          }),
        };
      }
      if (table === 'service_products') {
        return { where: () => ({ count: () => ({ first: async () => ({ count: '0' }) }) }) };
      }
      if (table === 'estimate_actuals') {
        return {
          insert: (payload) => ({ onConflict: () => ({ merge: async () => { upserts.push(payload); } }) }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    };

    const result = await reconcileEstimateActuals();
    expect(result).toEqual({ written: 1, failed: 1, scanned: 2 });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].service_record_id).toBe('sr-ok');
  });

  it('kill switch skips without querying', async () => {
    process.env.ESTIMATE_ACTUALS_DISABLED = '1';
    mockDbHandler = () => { throw new Error('should not query'); };
    const result = await runEstimateActualsReconcile();
    expect(result.skipped).toBe(true);
  });
});

describe('varianceSummary', () => {
  it('shapes per-service-line bias aggregates with rounded averages', async () => {
    mockDbHandler = (table) => {
      expect(table).toBe('estimate_actuals');
      const builder = {
        where() { return builder; },
        select() { return builder; },
        count() { return builder; },
        avg() { return builder; },
        groupBy() { return builder; },
        orderBy: async () => [{
          service_line: 'lawn_care', services: '14',
          avg_turf_delta_pct: '12.3456', avg_duration_delta_pct: null,
          turf_samples: '11', duration_samples: '0',
        }],
      };
      return builder;
    };

    expect(await varianceSummary({ days: 90 })).toEqual([{
      serviceLine: 'lawn_care',
      services: 14,
      turf: { samples: 11, avgDeltaPct: 12.35 },
      duration: { samples: 0, avgDeltaPct: null },
    }]);
  });
});

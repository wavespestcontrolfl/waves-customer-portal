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
  _private: {
    actualDurationMinutes, buildActualsRow, deltaPct, extractEstimateProfile,
    extractTreeShrubEstimate, extractTreeShrubActuals, deltaPctNonnegativeActual,
  },
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

describe('deltaPctNonnegativeActual', () => {
  it('keeps the zero-actual case as -100% — the strongest overestimation signal (pre-push P1)', () => {
    expect(deltaPctNonnegativeActual(2000, 0)).toBe(-100);
    expect(deltaPctNonnegativeActual(2000, 2400)).toBe(20);
  });

  it('still requires a positive estimate and a present, sane actual', () => {
    expect(deltaPctNonnegativeActual(0, 100)).toBeNull();
    expect(deltaPctNonnegativeActual(null, 100)).toBeNull();
    expect(deltaPctNonnegativeActual(2000, null)).toBeNull();
    expect(deltaPctNonnegativeActual(2000, -5)).toBeNull();
    expect(deltaPctNonnegativeActual(2000, 'junk')).toBeNull();
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

  it('backfilled records (structured_notes.backfill) skip the span fallbacks — the noon-of-service-day completed_at must not fabricate a duration (PR #2897 fix round 9)', () => {
    // The backdated quiet closeout keeps the real stale arrival as history
    // and writes only a DAY-scale completed_at (ET noon of the service day,
    // so Billing Recovery's leak window sees the visit). Pairing them would
    // book a fabricated ~2h duration into the estimate-accuracy ledger.
    const backfilledRecord = { structured_notes: JSON.stringify({ backfill: true, timeOnSite: null }) };
    expect(actualDurationMinutes(
      { arrived_at: '2026-06-10T14:00:00Z', completed_at: '2026-06-10T16:00:00Z' },
      backfilledRecord,
    )).toBeNull();
    // The record-side span is equally untrusted for marked rows.
    expect(actualDurationMinutes(
      {},
      { ...backfilledRecord, started_at: '2026-06-10T14:00:00Z', ended_at: '2026-06-10T16:00:00Z' },
    )).toBeNull();
    // The tracked column IS trusted — the backfill policy writes it only
    // from the operator's typed duration.
    expect(actualDurationMinutes(
      { actual_duration_minutes: 45, arrived_at: '2026-06-10T14:00:00Z', completed_at: '2026-06-10T16:00:00Z' },
      backfilledRecord,
    )).toBe(45);
    // Object-shaped structured_notes (jsonb column) and non-backfill rows
    // keep the existing behavior.
    expect(actualDurationMinutes(
      { arrived_at: '2026-06-10T14:00:00Z', completed_at: '2026-06-10T16:00:00Z' },
      { structured_notes: { backfill: true } },
    )).toBeNull();
    expect(actualDurationMinutes(
      { arrived_at: '2026-06-10T14:00:00Z', completed_at: '2026-06-10T16:00:00Z' },
      { structured_notes: JSON.stringify({ timeOnSite: 30 }) },
    )).toBe(120);
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

  it('attaches the T&S calibration block with its own bed delta when both sides exist', () => {
    const row = buildActualsRow({
      ...baseInputs,
      serviceRecord: {
        ...baseInputs.serviceRecord,
        service_line: 'tree_shrub',
        service_data: JSON.stringify({
          typedReportSnapshot: {
            type: 'tree_shrub',
            values: { bed_sqft_serviced: '2400', palm_count_total: '8', shrub_density: 'Heavy', access_difficulty: 'Easy' },
          },
        }),
      },
      estimate: {
        id: 'est-1',
        estimate_data: {
          engineResult: {
            lineItems: [
              { service: 'pest_control', monthly: 60 },
              { service: 'tree_shrub', bedAreaUsed: 2000, bedAreaSource: 'lot_based', treeCount: 3, access: 'easy', tier: 'standard', onSiteMin: 27 },
            ],
          },
        },
      },
    });
    expect(JSON.parse(row.estimated).treeShrub).toEqual({
      bedSqFt: 2000, bedAreaSource: 'lot_based', bedAreaEstimated: true, treeCount: 3, access: 'easy', tier: 'standard', onSiteMin: 27,
    });
    expect(JSON.parse(row.actual).treeShrub).toEqual({
      bedSqFt: 2400, palmCount: 8, treeCount: null, shrubDensity: 'heavy', access: 'easy', bedSqFtDeltaPct: 20,
    });
    // The scalar columns stay lawn/pest-shaped — the bed delta lives only
    // inside the block (this estimate carries no turf profile at all).
    expect(row.turf_delta_pct).toBeNull();
  });

  it('non-T&S rows are byte-identical to the pre-lane shape (no empty blocks)', () => {
    const row = buildActualsRow(baseInputs);
    expect(JSON.parse(row.estimated).treeShrub).toBeUndefined();
    expect(JSON.parse(row.actual).treeShrub).toBeUndefined();
  });
});

describe('extractTreeShrubEstimate', () => {
  it('reads the full engine quote from agent/IB drafts (engineResult.lineItems)', () => {
    expect(extractTreeShrubEstimate({
      engineResult: {
        lineItems: [{ service: 'tree_shrub', bedArea: 1209, bedAreaSource: 'lot_based', treeCount: 3, access: 'easy', tier: 'standard', onSiteMin: 27 }],
      },
    })).toEqual({ bedSqFt: 1209, bedAreaSource: 'lot_based', bedAreaEstimated: true, treeCount: 3, access: 'easy', tier: 'standard', onSiteMin: 27 });
  });

  it('a priced zero tree count survives as 0 — evidence, not a missing value', () => {
    const extracted = extractTreeShrubEstimate({
      engineResult: {
        lineItems: [{ service: 'tree_shrub', bedArea: 1500, bedAreaSource: 'explicit', treeCount: 0, access: 'easy', tier: 'standard', onSiteMin: 25 }],
      },
    });
    expect(extracted.treeCount).toBe(0);
    expect(extracted.bedAreaEstimated).toBe(false);
  });

  it('bedAreaEstimated matches the legacy mapper cohorts: operator-entered "estimated" is FALSE, engine-inferred sources are TRUE (pre-push P1 r3)', () => {
    const withSource = (bedAreaSource) => extractTreeShrubEstimate({
      engineResult: { lineItems: [{ service: 'tree_shrub', bedArea: 1500, bedAreaSource, treeCount: 1 }] },
    }).bedAreaEstimated;
    expect(withSource('explicit')).toBe(false);
    expect(withSource('estimated')).toBe(false); // v1-legacy-mapper.js:523 semantics
    expect(withSource('lot_based')).toBe(true);
    expect(withSource('fallback')).toBe(true);
  });

  it('falls back to the lossy admin mapping — the collapsed boolean is kept, the enum is NOT invented from it', () => {
    expect(extractTreeShrubEstimate({
      result: {
        results: {
          tsMeta: { eb: 2000, et: 4, bedAreaIsEstimated: true },
          ts: [{ tier: 'standard', selected: false }, { tier: 'enhanced', selected: true }],
        },
      },
      engineRequest: { profile: { access: 'Moderate' } },
    })).toEqual({
      // bedAreaIsEstimated=true means lot_based OR fallback; false means
      // explicit OR operator-estimated — an enum built from it would corrupt
      // calibration cohorts (pre-push P1).
      bedSqFt: 2000, bedAreaSource: null, bedAreaEstimated: true, treeCount: 4,
      access: 'moderate', tier: 'enhanced', onSiteMin: null,
    });
  });

  it('admin estimates without a profile access record the engine default "easy" — that IS the priced access (pre-push P1 r4)', () => {
    expect(extractTreeShrubEstimate({
      result: { results: { tsMeta: { eb: 1800, et: 2, bedAreaIsEstimated: false }, ts: [] } },
      engineRequest: { profile: { homeSqFt: 2000 } },
    }).access).toBe('easy');
  });

  it('null when the estimate priced no T&S line', () => {
    expect(extractTreeShrubEstimate(null)).toBeNull();
    expect(extractTreeShrubEstimate({})).toBeNull();
    expect(extractTreeShrubEstimate({ engineResult: { lineItems: [{ service: 'pest_control' }] } })).toBeNull();
    // Quote-wizard/lead drafts whitelist away every T&S field — no block,
    // not a block of nulls.
    expect(extractTreeShrubEstimate({ engineResult: { lineItems: [{ service: 'tree_shrub', monthly: 49 }] } })).toBeNull();
  });
});

describe('extractTreeShrubActuals', () => {
  it('reads internal calibration fields from the primary typed snapshot (string or object jsonb)', () => {
    const data = {
      typedReportSnapshot: {
        type: 'tree_shrub',
        values: {
          plant_groups: 'Palms,Shrubs',
          bed_sqft_serviced: '2400',
          palm_count_total: '12',
          tree_count_total: '2',
          shrub_density: 'Moderate',
          access_difficulty: 'Difficult',
        },
      },
    };
    const expected = { bedSqFt: 2400, palmCount: 12, treeCount: 2, shrubDensity: 'moderate', access: 'difficult' };
    expect(extractTreeShrubActuals(data)).toEqual(expected);
    expect(extractTreeShrubActuals(JSON.stringify(data))).toEqual(expected);
  });

  it('companion T&S sections fill gaps (combined visits store T&S as a companion; palms_serviced is its palm count)', () => {
    expect(extractTreeShrubActuals({
      typedReportSnapshot: { type: 'one_time_lawn_treatment', values: {} },
      companionReportSnapshots: [
        { type: 'tree_shrub', values: { palms_serviced: '6', shrub_density: 'Light' } },
      ],
    })).toEqual({ bedSqFt: null, palmCount: 6, treeCount: null, shrubDensity: 'light', access: null });
  });

  it('recorded zeros and comma-grouped measurements survive (pre-push P1s)', () => {
    expect(extractTreeShrubActuals({
      typedReportSnapshot: {
        type: 'tree_shrub',
        values: { bed_sqft_serviced: '12,400', palm_count_total: '0', tree_count_total: 0 },
      },
    })).toEqual({ bedSqFt: 12400, palmCount: 0, treeCount: 0, shrubDensity: null, access: null });
  });

  it('null when there is no T&S section or nothing was recorded', () => {
    expect(extractTreeShrubActuals(null)).toBeNull();
    expect(extractTreeShrubActuals('not json')).toBeNull();
    expect(extractTreeShrubActuals({ typedReportSnapshot: { type: 'pest_inspection', values: {} } })).toBeNull();
    expect(extractTreeShrubActuals({
      typedReportSnapshot: { type: 'tree_shrub', values: { plant_groups: 'Shrubs' } },
    })).toBeNull();
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

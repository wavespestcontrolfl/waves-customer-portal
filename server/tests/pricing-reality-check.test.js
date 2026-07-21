const {
  buildPricingRealityCheckFromRows,
  extractQuotedMinutesFromEstimate,
  resolveActualMinutes,
  serviceMetric,
  sqftBand,
  validateGroupBy,
  validateLookbackDays,
  withOutliers,
} = require('../services/pricing-reality-check');

function completedRow(overrides = {}) {
  return {
    service_id: overrides.service_id || 'svc-1',
    service_type: overrides.service_type || 'Mowing',
    completed_at: overrides.completed_at || '2026-05-15T15:00:00.000Z',
    estimated_duration_minutes: overrides.estimated_duration_minutes,
    service_time_minutes: overrides.service_time_minutes,
    actual_duration_minutes: overrides.actual_duration_minutes,
    customer_id: overrides.customer_id || 'cust-1',
    first_name: 'Test',
    last_name: 'Customer',
    zone: 'Zone A',
    technician_id: 'tech-1',
    technician_name: 'Jane Doe',
    property_sqft: overrides.property_sqft || 8000,
    estimate_data: overrides.estimate_data || null,
    ...overrides,
  };
}

describe('pricing reality check calculations', () => {
  test('computes service variance, percent variance, and margin sign', () => {
    expect(serviceMetric({ serviceId: 'A', quotedMinutes: 60, actualMinutes: 90 })).toMatchObject({
      varianceMinutes: 30,
      percentVariance: 50,
      dollarMarginImpact: -17.5,
    });

    expect(serviceMetric({ serviceId: 'B', quotedMinutes: 100, actualMinutes: 80 })).toMatchObject({
      varianceMinutes: -20,
      percentVariance: -20,
    });
    expect(serviceMetric({ serviceId: 'B', quotedMinutes: 100, actualMinutes: 80 }).dollarMarginImpact)
      .toBeCloseTo(11.6667, 3);
  });

  test('computes weighted grouped fixture results', () => {
    const result = buildPricingRealityCheckFromRows([
      completedRow({ service_id: 'A', estimated_duration_minutes: 60, service_time_minutes: 90 }),
      completedRow({ service_id: 'B', estimated_duration_minutes: 100, service_time_minutes: 80 }),
      completedRow({ service_id: 'C', estimated_duration_minutes: 40, service_time_minutes: 40 }),
    ], { lookbackDays: 90, groupBy: 'service_type' });

    expect(result.summary.serviceCount).toBe(3);
    expect(result.summary.weightedPercentVariance).toBeCloseTo(5, 5);
    expect(result.summary.totalDollarMarginImpact).toBeCloseTo(-5.833, 3);
    expect(result.segments[0]).toMatchObject({
      key: 'Mowing',
      serviceCount: 3,
    });
    expect(result.segments[0].weightedPercentVariance).toBeCloseTo(5, 5);
  });

  test('uses service record timeOnSite as actual minutes when scheduled service duration is missing', () => {
    const result = buildPricingRealityCheckFromRows([
      completedRow({
        estimated_duration_minutes: 30,
        service_record_structured_notes: JSON.stringify({ timeOnSite: '42:35' }),
      }),
    ], { lookbackDays: 90, groupBy: 'service_type' });

    expect(result.coverage).toMatchObject({
      completedServiceCount: 1,
      includedServiceCount: 1,
    });
    expect(result.summary.avgActualMinutes).toBe(43);
  });

  test('uses service record start and end timestamps as an actual duration fallback', () => {
    const result = buildPricingRealityCheckFromRows([
      completedRow({
        estimated_duration_minutes: 30,
        service_record_started_at: '2026-05-15T14:00:00.000Z',
        service_record_ended_at: '2026-05-15T14:45:00.000Z',
      }),
    ], { lookbackDays: 90, groupBy: 'service_type' });

    expect(result.coverage).toMatchObject({
      completedServiceCount: 1,
      includedServiceCount: 1,
    });
    expect(result.summary.avgActualMinutes).toBe(45);
  });

  test('groups completed services by Eastern month', () => {
    const result = buildPricingRealityCheckFromRows([
      completedRow({
        completed_at: '2026-06-01T03:30:00.000Z',
        estimated_duration_minutes: 30,
        service_time_minutes: 30,
      }),
    ], { lookbackDays: 90, groupBy: 'month' });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({ key: '2026-05', label: '2026-05' });
    expect(result.availableFilters.months).toContain('2026-05');
  });

  test('treats date-only scheduled_date fallback as an Eastern calendar date', () => {
    const result = buildPricingRealityCheckFromRows([
      completedRow({
        completed_at: null,
        actual_end_time: null,
        check_out_time: null,
        time_entry_clock_out: null,
        scheduled_date: '2026-06-01',
        estimated_duration_minutes: 30,
        service_time_minutes: 30,
      }),
    ], { lookbackDays: 90, groupBy: 'month' });

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({ key: '2026-06', label: '2026-06' });
    expect(result.availableFilters.months).toContain('2026-06');
  });

  test.each([
    [7999, '7,500-7,999'],
    [8000, '8,000-8,499'],
    [8499, '8,000-8,499'],
    [8500, '8,500-9,999'],
  ])('assigns sqft band for %s', (sqft, expected) => {
    expect(sqftBand(sqft)).toBe(expected);
  });

  test('detects no outliers when n is below three or stddev is zero', () => {
    expect(withOutliers([{ varianceMinutes: 0 }, { varianceMinutes: 50 }]).some((row) => row.isOutlier)).toBe(false);
    expect(withOutliers([{ varianceMinutes: 3 }, { varianceMinutes: 3 }, { varianceMinutes: 3 }]).some((row) => row.isOutlier)).toBe(false);
  });

  test('marks abs z-score above two as an outlier', () => {
    const rows = withOutliers([0, 0, 0, 0, 0, 10].map((varianceMinutes) => ({ varianceMinutes })));
    expect(rows[5].zScore).toBeGreaterThan(2);
    expect(rows[5].isOutlier).toBe(true);
  });

  test('excludes missing quote, zero quote, missing actual, and negative actual rows', () => {
    const result = buildPricingRealityCheckFromRows([
      completedRow({ service_id: 'missing-quote', estimated_duration_minutes: null, service_time_minutes: 20 }),
      completedRow({ service_id: 'zero-quote', estimated_duration_minutes: 0, service_time_minutes: 20 }),
      completedRow({ service_id: 'missing-actual', estimated_duration_minutes: 30, service_time_minutes: null }),
      completedRow({ service_id: 'negative-actual', estimated_duration_minutes: 30, actual_duration_minutes: -5 }),
    ], { lookbackDays: 90, groupBy: 'service_type' });

    expect(result.coverage).toMatchObject({
      completedServiceCount: 4,
      includedServiceCount: 0,
      excludedMissingQuoteCount: 2,
      excludedMissingActualCount: 1,
      excludedInvalidDurationCount: 1,
    });
  });

  test('backfilled unknown-end rows report NO actual minutes — the durable marker skips every minutesBetween fallback rung (PR #2897 fix rounds 4+9)', () => {
    // The strip-shape backfill row as the write side now persists it (fix
    // round 9): real stale arrived_at kept as history, duration columns
    // NULL, every lifecycle/record end stamp stripped, the record's
    // structured timeOnSite null — and tracker completed_at = ET NOON of
    // the service day (a day-scale instant, written so Billing Recovery's
    // `ss.completed_at >= now()-window` leak query can SEE an uninvoiced
    // backfill; round 7's NULL hid it from the exact workbench meant to
    // catch it). That instant completes the arrived_at pair, so the guard
    // moved to the READ side: rows whose service_record carries
    // structured_notes.backfill (the same durable marker job-costing keys
    // its untrusted-span policy off) skip the minutesBetween fallback rungs
    // entirely — persisted operator/clock statements only.
    const stripShape = {
      arrived_at: '2026-06-20T14:00:00.000Z',
      check_in_time: '2026-06-20T14:00:00.000Z',
      actual_start_time: '2026-06-20T14:00:00.000Z',
      completed_at: '2026-06-20T16:00:00.000Z', // noon EDT of the service day
      actual_end_time: null,
      check_out_time: null,
      service_time_minutes: null,
      actual_duration_minutes: null,
      time_entry_minutes: null,
      time_entry_clock_in: null,
      time_entry_clock_out: null,
      service_record_started_at: '2026-06-20T14:00:00.000Z',
      service_record_ended_at: null,
      service_record_structured_notes: JSON.stringify({ timeOnSite: null, backfill: true }),
    };
    // Marked row: the completable arrived_at→noon pair is SKIPPED — the
    // honest unknown, not a fabricated ~2h visit.
    expect(resolveActualMinutes(stripShape)).toBeNull();
    // Without the marker the same columns really would fabricate — the
    // hazard the guard exists for (and proof non-backfill behavior is
    // untouched: unmarked rows keep the pair fallback).
    expect(resolveActualMinutes({ ...stripShape, service_record_structured_notes: null }))
      .toBe(120);
    // A marked row's PERSISTED statements still count: typed duration…
    expect(resolveActualMinutes({ ...stripShape, service_time_minutes: 45 })).toBe(45);
    // …summed job time entries, and the structured timeOnSite.
    expect(resolveActualMinutes({ ...stripShape, time_entry_minutes: 38 })).toBe(38);
    expect(resolveActualMinutes({
      ...stripShape,
      service_record_structured_notes: JSON.stringify({ timeOnSite: 52, backfill: true }),
    })).toBe(52);

    // Through the full build: excluded as missing-actual (honest unknown —
    // NOT invalid_duration, even when the stale start sits after noon and
    // the fabricated pair would be negative), and its month keys off the
    // service day via the noon instant.
    const result = buildPricingRealityCheckFromRows([
      completedRow({
        service_id: 'backfill-strip',
        estimated_duration_minutes: 30,
        scheduled_date: '2026-06-20',
        ...stripShape,
      }),
      completedRow({
        service_id: 'backfill-afternoon-start',
        estimated_duration_minutes: 30,
        scheduled_date: '2026-06-20',
        ...stripShape,
        arrived_at: '2026-06-20T19:30:00.000Z', // 3:30pm ET — after the noon instant
      }),
    ], { lookbackDays: 90, groupBy: 'month' });
    expect(result.coverage).toMatchObject({
      completedServiceCount: 2,
      includedServiceCount: 0,
      excludedMissingActualCount: 2,
      excludedInvalidDurationCount: 0,
    });
    expect(result.availableFilters.months).toContain('2026-06');
  });

  test('backfilled kept-end rows bucket into the SERVICE month with the typed minutes (backdated completed_at)', () => {
    // The kept shape: typed 45, end instants backdated to the service day
    // by backfillCompletionEndInstant. The visit lands in ITS month with
    // the operator's duration — not in the closeout month with a guess.
    const result = buildPricingRealityCheckFromRows([
      completedRow({
        service_id: 'backfill-kept',
        completed_at: '2026-06-20T16:00:00.000Z', // noon EDT on the visit day
        actual_end_time: '2026-06-20T16:00:00.000Z',
        check_out_time: '2026-06-20T16:00:00.000Z',
        estimated_duration_minutes: 40,
        service_time_minutes: 45,
        actual_duration_minutes: 45,
      }),
    ], { lookbackDays: 90, groupBy: 'month' });

    expect(result.coverage).toMatchObject({ completedServiceCount: 1, includedServiceCount: 1 });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({ key: '2026-06' });
  });

  test('validates lookbackDays and groupBy allowlists', () => {
    expect(validateLookbackDays('30')).toBe(30);
    expect(() => validateLookbackDays('45')).toThrow(/lookbackDays/);
    expect(validateGroupBy('technician')).toBe('technician');
    expect(() => validateGroupBy('total_dollar_margin_impact')).toThrow(/groupBy/);
  });

  test('extracts pricing-engine quoted minutes before scheduled duration fallback', () => {
    const estimateData = {
      result: {
        lineItems: [{
          service: 'pest_control',
          productionDiagnostics: { estimatedMinutes: 42 },
        }],
      },
    };

    expect(extractQuotedMinutesFromEstimate(estimateData, 'Pest Control')).toBe(42);
    const result = buildPricingRealityCheckFromRows([
      completedRow({
        service_id: 'quote-source',
        service_type: 'Pest Control',
        estimated_duration_minutes: 60,
        service_time_minutes: 50,
        estimate_data: estimateData,
      }),
    ], { lookbackDays: 90, groupBy: 'service_type' });
    expect(result.summary.avgQuotedMinutes).toBe(42);
  });

  test('does not assign root estimate minutes to a different service line', () => {
    const estimateData = {
      result: {
        productionDiagnostics: { estimatedMinutes: 42 },
        lineItems: [
          { service: 'Pest Control', productionDiagnostics: { estimatedMinutes: 42 } },
          { service: 'Mowing' },
        ],
      },
    };

    expect(extractQuotedMinutesFromEstimate(estimateData, 'Mowing')).toBeNull();
    const result = buildPricingRealityCheckFromRows([
      completedRow({
        service_id: 'mowing-fallback',
        service_type: 'Mowing',
        estimated_duration_minutes: 60,
        service_time_minutes: 50,
        estimate_data: estimateData,
      }),
    ], { lookbackDays: 90, groupBy: 'service_type' });
    expect(result.summary.avgQuotedMinutes).toBe(60);
  });
});

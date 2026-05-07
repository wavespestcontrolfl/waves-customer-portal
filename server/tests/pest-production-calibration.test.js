const {
  buildCalibrationRecord,
  calibrationRowsToCsv,
  calibrationExportRows,
  summarizeCalibrationRecords,
  lotBand,
  isPestOnlyServiceType,
} = require('../services/pest-production-calibration');

describe('pest production calibration', () => {
  test('builds a stored calibration snapshot from an accepted estimate and job timer', () => {
    const record = buildCalibrationRecord({
      scheduled_service_id: 'service-1',
      estimate_id: 'estimate-1',
      customer_id: 'customer-1',
      technician_id: 'tech-1',
      service_date: '2026-05-07',
      service_type: 'Pest Control',
      actual_minutes: '44.6',
      estimate_data: JSON.stringify({
        result: {
          property: {
            homeSqFt: 2500,
            lotSqFt: 12000,
            poolCageSize: 'large',
          },
          productionDiagnostics: {
            estimatedMinutes: 32.4,
            pricingConfidence: 'medium',
            poolCageSize: 'large',
            reviewReasons: ['large_pool_cage'],
            breakdown: { base: 20, poolCage: 12 },
          },
          recurring: { tier: 'Bronze' },
        },
      }),
    });

    expect(record).toMatchObject({
      scheduled_service_id: 'service-1',
      estimate_id: 'estimate-1',
      predicted_minutes: 32.4,
      actual_minutes: 44.6,
      delta_minutes: 12.2,
      pricing_confidence: 'medium',
      pool_cage_size: 'large',
      home_sqft: 2500,
      lot_sqft: 12000,
    });
    expect(JSON.parse(record.review_reasons)).toEqual(['large_pool_cage']);
    expect(JSON.parse(record.production_diagnostics).breakdown.poolCage).toBe(12);
    expect(JSON.parse(record.estimate_snapshot).pestPrice).toBeNull();
  });

  test('captures pest price when estimate payload includes recurring pest pricing', () => {
    const record = buildCalibrationRecord({
      scheduled_service_id: 'service-price',
      estimate_id: 'estimate-price',
      service_date: '2026-05-07',
      service_type: 'Pest Control',
      actual_minutes: 35,
      estimate_data: {
        result: {
          property: { homeSqFt: 2100, lotSqFt: 9000 },
          productionDiagnostics: {
            estimatedMinutes: 31.1,
            pricingConfidence: 'high',
            poolCageSize: 'none',
          },
          recurring: {
            pest: { perApp: 118.5 },
          },
        },
      },
    });

    expect(JSON.parse(record.estimate_snapshot).pestPrice).toBe(118.5);
  });

  test('leaves missing pest price blank in export instead of coercing to zero', () => {
    const rows = calibrationExportRows([{
      predicted_minutes: 30,
      actual_minutes: 40,
      delta_minutes: 10,
      estimate_snapshot: { pestPrice: null },
    }]);

    expect(rows[0].pest_price).toBe('');
  });

  test('reads production diagnostics from raw engineResult estimate data', () => {
    const record = buildCalibrationRecord({
      scheduled_service_id: 'service-2',
      estimate_id: 'estimate-2',
      service_date: '2026-05-07',
      service_type: 'Pest Control',
      actual_minutes: 29,
      estimate_data: {
        engineInputs: {
          homeSqFt: 1800,
          lotSqFt: 8500,
        },
        engineResult: {
          property: {
            homeSqFt: 1800,
            lotSqFt: 8500,
          },
          lineItems: [{
            service: 'pest_control',
            productionDiagnostics: {
              estimatedMinutes: 24,
              pricingConfidence: 'high',
              poolCageSize: 'none',
              reviewReasons: [],
            },
          }],
        },
      },
    });

    expect(record).toMatchObject({
      predicted_minutes: 24,
      actual_minutes: 29,
      delta_minutes: 5,
      pricing_confidence: 'high',
      lot_sqft: 8500,
    });
  });

  test('summarizes miss by pool cage, lot band, confidence, and outliers', () => {
    const records = [
      { pool_cage_size: 'none', lot_sqft: 7500, pricing_confidence: 'high', delta_minutes: -2 },
      { pool_cage_size: 'large', lot_sqft: 24000, pricing_confidence: 'medium', delta_minutes: 16 },
      { pool_cage_size: 'large', lot_sqft: 26000, pricing_confidence: 'medium', delta_minutes: 10 },
    ];

    const summary = summarizeCalibrationRecords(records);

    expect(summary.count).toBe(3);
    expect(summary.avgDelta).toBe(8);
    expect(summary.avgAbsDelta).toBe(9.3);
    expect(summary.outlierCount).toBe(1);
    expect(summary.byPoolCageSize).toContainEqual(expect.objectContaining({
      key: 'large',
      count: 2,
      avgDelta: 13,
    }));
    expect(summary.byLotBand).toContainEqual(expect.objectContaining({
      key: '20k-40k',
      count: 2,
    }));
    expect(summary.byConfidence).toContainEqual(expect.objectContaining({
      key: 'medium',
      count: 2,
    }));
  });

  test('bands lot sizes for reporting', () => {
    expect(lotBand(0)).toBe('unknown');
    expect(lotBand(9000)).toBe('<10k');
    expect(lotBand(15000)).toBe('10k-20k');
    expect(lotBand(25000)).toBe('20k-40k');
    expect(lotBand(50000)).toBe('40k+');
  });

  test('identifies pest-only scheduled service labels', () => {
    expect(isPestOnlyServiceType('Pest Control')).toBe(true);
    expect(isPestOnlyServiceType('Quarterly pest service')).toBe(true);
    expect(isPestOnlyServiceType('WaveGuard Bronze - Pest Control')).toBe(true);
    expect(isPestOnlyServiceType('Lawn Care')).toBe(false);
    expect(isPestOnlyServiceType('Tree & Shrub')).toBe(false);
    expect(isPestOnlyServiceType('Pest Control + Lawn Care')).toBe(false);
    expect(isPestOnlyServiceType('WaveGuard Gold - Lawn Care + Pest Control')).toBe(false);
  });

  test('builds CSV export rows with property, variance, price, and review signal', () => {
    const rows = calibrationExportRows([{
      service_date: '2026-05-07T00:00:00.000Z',
      customer_name: 'Ada Lovelace',
      address_line1: '123 Screen Cage Way',
      city: 'Parrish',
      technician_name: 'Tech One',
      service_type: 'Pest Control',
      predicted_minutes: 37.3,
      actual_minutes: 49.8,
      delta_minutes: 12.5,
      pricing_confidence: 'medium',
      pool_cage_size: 'large',
      home_sqft: 2600,
      lot_sqft: 24000,
      review_reasons: ['large_lot', 'pool_cage_size_inferred'],
      production_diagnostics: {
        poolCageSizeSource: 'inferred',
        pricingMode: 'shadow_only',
      },
      property_snapshot: { stories: 2 },
      estimate_snapshot: { pestPrice: 136 },
      scheduled_service_id: 'service-1',
      estimate_id: 'estimate-1',
    }]);

    expect(rows[0]).toMatchObject({
      service_date: '2026-05-07',
      customer_name: 'Ada Lovelace',
      predicted_minutes: '37.3',
      actual_minutes: '49.8',
      delta_minutes: '12.5',
      lot_band: '20k-40k',
      pest_price: '136.00',
      review_reasons: 'large_lot; pool_cage_size_inferred',
      pool_cage_size_source: 'inferred',
      pricing_mode: 'shadow_only',
      stories: 2,
    });

    const csv = calibrationRowsToCsv([{
      service_date: '2026-05-07',
      customer_name: 'Customer, With Comma',
      review_reasons: ['large_lot'],
      predicted_minutes: 30,
      actual_minutes: 40,
      delta_minutes: 10,
    }]);
    expect(csv.split('\n')[0]).toContain('service_date,customer_name,address_line1');
    expect(csv).toContain('"Customer, With Comma"');
  });

  test('neutralizes formula-like CSV cells before export', () => {
    const csv = calibrationRowsToCsv([{
      service_date: '2026-05-07',
      customer_name: '=HYPERLINK("https://example.com","x")',
      address_line1: '+123 Main St',
      city: '@Bradenton',
      predicted_minutes: 30,
      actual_minutes: 40,
      delta_minutes: 10,
    }]);

    expect(csv).toContain('\'=HYPERLINK');
    expect(csv).toContain('\'+123 Main St');
    expect(csv).toContain('\'@Bradenton');
  });
});

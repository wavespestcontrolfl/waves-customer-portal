process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Estimator audit P1-3 (margin visibility ruling: surfaced to the OWNER,
// never to customers): marginFloorMonthly is the armed 35%-margin floor
// basis (ceil(costFloorAnnual/12)) that lawnFrequenciesFromRows emits for
// the server-side ladder/section clamps. It must be stripped from every
// customer-bound bundle shape at the response boundary — a customer holding
// it can derive Waves' cost basis.
const { stripInternalMarginFieldsDeep } = require('../routes/estimate-public');

describe('stripInternalMarginFieldsDeep — customer response boundary', () => {
  test('strips marginFloorMonthly from frequencies, hidden entries, and nested section ladders', () => {
    const bundle = {
      frequencies: [
        { key: 'sixApps', monthly: 112, marginFloorMonthly: 108.34, manualDiscount: null },
        { key: 'nineApps', monthly: 96, perServiceTreatments: [{ perTreatment: 128, marginFloorMonthly: 90 }] },
      ],
      hiddenLawnFrequencies: [{ key: 'quarterly', monthly: 70, marginFloorMonthly: 70.84 }],
      services: [
        {
          key: 'lawn_care',
          cadenceLadder: [{ key: 'sixApps', monthly: 112, marginFloorMonthly: 108.34 }],
        },
      ],
      waveGuardTier: 'Silver',
      quoteRequired: false,
    };

    const out = stripInternalMarginFieldsDeep(bundle);

    expect(out.frequencies[0].marginFloorMonthly).toBeUndefined();
    expect(out.frequencies[1].perServiceTreatments[0].marginFloorMonthly).toBeUndefined();
    expect(out.hiddenLawnFrequencies[0].marginFloorMonthly).toBeUndefined();
    expect(out.services[0].cadenceLadder[0].marginFloorMonthly).toBeUndefined();
    // Everything else is untouched.
    expect(out.frequencies[0].monthly).toBe(112);
    expect(out.hiddenLawnFrequencies[0].monthly).toBe(70);
    expect(out.waveGuardTier).toBe('Silver');
    expect(out.quoteRequired).toBe(false);
  });

  test('clone semantics: the source bundle (the server-side cache) keeps its fields', () => {
    const bundle = { frequencies: [{ key: 'sixApps', marginFloorMonthly: 108.34 }] };
    const out = stripInternalMarginFieldsDeep(bundle);
    expect(bundle.frequencies[0].marginFloorMonthly).toBe(108.34);
    expect(out.frequencies[0].marginFloorMonthly).toBeUndefined();
    expect(out).not.toBe(bundle);
  });

  test('non-object and null inputs pass through', () => {
    expect(stripInternalMarginFieldsDeep(null)).toBeNull();
    expect(stripInternalMarginFieldsDeep([])).toEqual([]);
    expect(stripInternalMarginFieldsDeep(42)).toBe(42);
  });
});

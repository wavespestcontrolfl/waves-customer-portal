const {
  inferFrequencyKeyFromEstimateData,
  intervalPriceFromAnnual,
  intervalPriceFromMonthly,
  normalizeFrequencyKey,
  resolveBillingCadence,
} = require('../services/billing-cadence');

describe('billing cadence helpers', () => {
  test('normalizes customer-facing frequency labels', () => {
    expect(normalizeFrequencyKey('Quarterly')).toBe('quarterly');
    expect(normalizeFrequencyKey('Bi-Monthly')).toBe('bi_monthly');
    expect(normalizeFrequencyKey('bimonthly')).toBe('bi_monthly');
    expect(normalizeFrequencyKey('Every 2 months')).toBe('bi_monthly');
    expect(normalizeFrequencyKey('Monthly')).toBe('monthly');
  });

  test('converts monthly-equivalent rates to cadence charge amounts', () => {
    expect(intervalPriceFromMonthly(35.33, 'quarterly')).toBe(105.99);
    expect(intervalPriceFromMonthly(35.33, 'bi_monthly')).toBe(70.66);
    expect(intervalPriceFromMonthly(35.33, 'monthly')).toBe(35.33);
  });

  test('prefers accepted estimate customer selection for billing display', () => {
    const cadence = resolveBillingCadence({
      monthlyRate: 35.33,
      estimateData: {
        customerSelection: {
          frequency: 'quarterly',
          monthlyTotal: 35.33,
        },
      },
    });

    expect(cadence).toMatchObject({
      frequencyKey: 'quarterly',
      amount: 105.99,
      planLabel: 'Quarterly plan',
      displaySuffix: '/ quarter',
    });
  });

  test('infers pest cadence from stored recurring services when no selection is present', () => {
    const estimateData = {
      result: {
        recurring: {
          services: [
            { name: 'Lawn Care', frequency: 'monthly' },
            { name: 'Pest Control', frequency: 'Bi-Monthly' },
          ],
        },
      },
    };

    expect(inferFrequencyKeyFromEstimateData(estimateData)).toBe('bi_monthly');
    expect(resolveBillingCadence({ monthlyRate: 44.5, estimateData }).amount).toBe(89);
  });

  test('converts exact annuals to cadence charge amounts', () => {
    // Quarterly $392/yr = 4 x $98.00 exactly — never 32.67 * 3 = 98.01.
    expect(intervalPriceFromAnnual(392, 'quarterly')).toBe(98);
    expect(intervalPriceFromAnnual(392, 'bi_monthly')).toBe(65.33);
    expect(intervalPriceFromAnnual(392, 'monthly')).toBe(32.67);
  });

  test('interval charge derives from the exact annual when it corresponds to the monthly', () => {
    const cadence = resolveBillingCadence({
      monthlyRate: 32.67,
      annualRate: 392,
      frequencyKey: 'quarterly',
    });
    // Rounded-monthly path gave 32.67 * 3 = 98.01; the quoted per-visit is 98.00.
    expect(cadence.amount).toBe(98);
    expect(cadence.monthlyRate).toBe(32.67);
  });

  test('monthly cadence is unchanged by a corresponding annual', () => {
    expect(resolveBillingCadence({ monthlyRate: 32.67, annualRate: 392, frequencyKey: 'monthly' }).amount).toBe(32.67);
  });

  test('a non-corresponding annual is ignored — the monthly stays the billing authority', () => {
    // e.g. a stale/foreign annual (real price change never synced): drift > $0.50.
    expect(resolveBillingCadence({ monthlyRate: 32.67, annualRate: 432, frequencyKey: 'quarterly' }).amount).toBe(98.01);
  });

  test('callers that do not pass annualRate keep the legacy monthly derivation', () => {
    expect(resolveBillingCadence({ monthlyRate: 32.67, frequencyKey: 'quarterly' }).amount).toBe(98.01);
  });
});

describe('pinned legacy rodent rows never drive the billing cadence (codex #3591 r19/r20 P0)', () => {
  const { resolveBillingCadence, isPinnedLegacyRodentRow, collectRecurringServices } = require('../services/billing-cadence');
  const pinned = { service: 'rodent_bait', name: 'Rodent Bait Stations', mo: 49, monthly: 49, annual: 588, visitsPerYear: 4, legacyPinnedReplay: true, discountable: false };
  const fresh = { service: 'rodent_bait', name: 'Rodent Bait Stations', mo: 29.67, monthly: 29.67, annual: 356, visitsPerYear: 4, perApplicationBilled: true, stations: 5 };
  test('a rodent-only pre-realignment accept stays on the monthly lane: cadence monthly, charge = the disclosed monthly figure', () => {
    expect(isPinnedLegacyRodentRow(pinned)).toBe(true);
    expect(collectRecurringServices({ result: { recurring: { services: [pinned] } } })).toEqual([]);
    const cadence = resolveBillingCadence({ monthlyRate: 49, annualRate: 588, estimateData: { result: { recurring: { services: [pinned] } } } });
    expect(cadence.frequencyKey).toBe('monthly');
    expect(cadence.amount).toBe(49);
  });
  test('a new-model rodent row keeps its per-application (quarterly) cadence', () => {
    expect(isPinnedLegacyRodentRow(fresh)).toBe(false);
    const cadence = resolveBillingCadence({ monthlyRate: 29.67, annualRate: 356, estimateData: { result: { recurring: { services: [fresh] } } } });
    expect(cadence.frequencyKey).toBe('quarterly');
    expect(cadence.amount).toBe(89);
  });
});

describe('stored-legacy rodent rows classify without a pin (codex #3591 r37 P0)', () => {
  const { legacyRodentRowPredicateFor, collectRecurringServices, rodentRowHasNewModelMarker } = require('../services/billing-cadence');
  // A pre-realignment quote-wizard save handed straight to conversion by a
  // manual "mark as won": monthly row, no pin, no new-model marker.
  const storedLegacy = { result: { recurring: { services: [
    { service: 'rodent_bait', name: 'Rodent Bait Stations', mo: 49, visitsPerYear: 4 },
  ] } } };
  const storedNew = { result: { recurring: { services: [
    { service: 'rodent_bait', name: 'Rodent Bait Stations', mo: 29.67, perApplicationBilled: true, stations: 5 },
  ] } } };

  test('the stored estimate\'s legacy signal classifies an unpinned monthly rodent row as legacy; a bracket row never is', () => {
    const legacyRow = storedLegacy.result.recurring.services[0];
    const newRow = storedNew.result.recurring.services[0];
    expect(rodentRowHasNewModelMarker(legacyRow)).toBe(false);
    expect(rodentRowHasNewModelMarker(newRow)).toBe(true);
    expect(legacyRodentRowPredicateFor(storedLegacy)(legacyRow)).toBe(true);
    expect(legacyRodentRowPredicateFor(storedNew)(newRow)).toBe(false);
    // The signal is per-ESTIMATE: a marker-less row under a new-model
    // estimate is not reclassified, and a pest row is never touched.
    expect(legacyRodentRowPredicateFor(storedNew)(legacyRow)).toBe(false);
    expect(legacyRodentRowPredicateFor(storedLegacy)({ service: 'pest_control', mo: 45 })).toBe(false);
  });

  test('collectRecurringServices drops the unpinned legacy row exactly like a pinned one — it never drives the billing cadence', () => {
    expect(collectRecurringServices(storedLegacy)).toEqual([]);
    expect(collectRecurringServices(storedNew)).toHaveLength(1);
  });
});

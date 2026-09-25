// Palm-care inclusion bullet lane (owner 2026-09-24): palms are priced inside
// Tree & Shrub via the routine palm-care reserve — no separate line item, no
// new fee. The customer-facing bullet (client PriceCard) reads `palmCount`
// off a T&S perServiceTreatments row, so every server builder that can emit
// a tree_shrub row must attach it — but ONLY as a positive integer, so a
// zero/absent/invalid count leaves the row (and the rendered list) unchanged.
const {
  shapeFrequencyEntry,
  treeShrubFrequenciesFromResultStats,
  treeShrubPalmCountForEstData,
  shapeFromV1,
  recurringServicesWithSupplements,
} = require('../routes/estimate-public');

const QUARTERLY = { key: 'quarterly', label: 'Quarterly (4 visits/year)', engineFrequency: 'quarterly' };

function tsLineItem(overrides = {}) {
  return {
    service: 'tree_shrub',
    tier: 'standard',
    frequency: 6,
    visitsPerYear: 6,
    monthly: 66.75,
    annual: 801,
    perApp: 133.5,
    ...overrides,
  };
}

describe('shapeFrequencyEntry — combined-builder T&S row (server/routes/estimate-public.js ~L16953)', () => {
  test('attaches palmCount for a positive-integer palm count', () => {
    const engineResult = {
      summary: { recurringMonthlyAfterDiscount: 66.75, recurringAnnualAfterDiscount: 801 },
      lineItems: [tsLineItem({ palmCount: 4 })],
    };
    const entry = shapeFrequencyEntry(QUARTERLY, engineResult, {});
    const row = entry.perServiceTreatments.find((r) => r.service === 'tree_shrub');
    expect(row).toBeTruthy();
    expect(row.palmCount).toBe(4);
  });

  test.each([
    ['zero', 0],
    ['missing', undefined],
    ['non-integer', 2.5],
    ['negative', -3],
  ])('omits palmCount for a %s palm count, row otherwise unchanged', (_label, palmCount) => {
    const li = tsLineItem(palmCount === undefined ? {} : { palmCount });
    const engineResult = {
      summary: { recurringMonthlyAfterDiscount: 66.75, recurringAnnualAfterDiscount: 801 },
      lineItems: [li],
    };
    const entry = shapeFrequencyEntry(QUARTERLY, engineResult, {});
    const row = entry.perServiceTreatments.find((r) => r.service === 'tree_shrub');
    expect(row).toBeTruthy();
    expect(row.palmCount).toBeUndefined();
    // The rest of the row is unaffected by the palm-count wiring.
    expect(row.visitsPerYear).toBe(6);
  });

  test('a non-T&S recurring row never gets a palmCount, even if the line item carries one', () => {
    const engineResult = {
      summary: { recurringMonthlyAfterDiscount: 60, recurringAnnualAfterDiscount: 720 },
      lineItems: [{
        service: 'pest_control', visitsPerYear: 4, monthly: 60, annual: 720, perApp: 180, palmCount: 4,
      }],
    };
    const entry = shapeFrequencyEntry(QUARTERLY, engineResult, {});
    const row = entry.perServiceTreatments.find((r) => r.service === 'pest_control');
    expect(row.palmCount).toBeUndefined();
  });
});

describe('treeShrubPalmCountForEstData — stored-estimate line-item lookup', () => {
  test('reads a positive integer palmCount off result.lineItems', () => {
    const estData = { result: { lineItems: [tsLineItem({ palmCount: 7 })] } };
    expect(treeShrubPalmCountForEstData(estData)).toBe(7);
  });

  test('falls back to engineResult.lineItems (agent/engine draft shape)', () => {
    const estData = { engineResult: { lineItems: [tsLineItem({ palmCount: 2 })] } };
    expect(treeShrubPalmCountForEstData(estData)).toBe(2);
  });

  test.each([
    ['zero', 0, false],
    ['missing', undefined, false],
    ['non-integer', 1.5, false],
    ['no T&S line at all', undefined, true],
  ])('returns null for %s', (_label, palmCount, noLine) => {
    const estData = noLine
      ? { result: { lineItems: [{ service: 'pest_control', monthly: 60 }] } }
      : { result: { lineItems: [tsLineItem(palmCount === undefined ? {} : { palmCount })] } };
    expect(treeShrubPalmCountForEstData(estData)).toBeNull();
  });
});

describe('treeShrubFrequenciesFromResultStats — solo T&S ladder (server/routes/estimate-public.js ~L19898)', () => {
  const RESULT_STATS_TS = [
    { key: 'standard', v: 6, mo: 66.75, ann: 801, pa: 133.5, recommended: true, selected: true },
  ];

  test('attaches palmCount onto the tier row perServiceTreatments entry', () => {
    const estData = {
      result: {
        results: { ts: RESULT_STATS_TS },
        lineItems: [tsLineItem({ palmCount: 4 })],
      },
    };
    const [entry] = treeShrubFrequenciesFromResultStats(estData);
    expect(entry.perServiceTreatments[0].palmCount).toBe(4);
  });

  test.each([
    ['zero', 0],
    ['missing', undefined],
  ])('omits palmCount for a %s palm count — perServiceTreatments row otherwise unchanged', (_label, palmCount) => {
    const estData = {
      result: {
        results: { ts: RESULT_STATS_TS },
        lineItems: [tsLineItem(palmCount === undefined ? {} : { palmCount })],
      },
    };
    const [entry] = treeShrubFrequenciesFromResultStats(estData);
    expect(entry.perServiceTreatments[0]).toEqual({
      service: 'tree_shrub',
      label: 'Tree & Shrub',
      perTreatment: 133.5,
      displayPrice: 133.5,
      visitsPerYear: 6,
    });
  });
});

describe('recurringServicesWithSupplements — raw lineItems supplement path (agent/engine drafts)', () => {
  test('a positive-integer palmCount rides the tree_shrub supplement row', () => {
    const estResult = { lineItems: [tsLineItem({ palmCount: 5, annualAfterCredits: 801 })] };
    const services = recurringServicesWithSupplements(estResult);
    const row = services.find((s) => s.service === 'tree_shrub');
    expect(row.palmCount).toBe(5);
  });

  test.each([0, undefined])('omits palmCount for %s', (palmCount) => {
    const estResult = {
      lineItems: [tsLineItem(palmCount === undefined ? { annualAfterCredits: 801 } : { palmCount, annualAfterCredits: 801 })],
    };
    const services = recurringServicesWithSupplements(estResult);
    const row = services.find((s) => s.service === 'tree_shrub');
    expect(row.palmCount).toBeUndefined();
  });

  test('a non-T&S recurring supplement row never carries palmCount', () => {
    const estResult = {
      lineItems: [{ service: 'pest_control', annualAfterCredits: 720, palmCount: 4 }],
    };
    const services = recurringServicesWithSupplements(estResult);
    const row = services.find((s) => s.service === 'pest_control');
    expect(row.palmCount).toBeUndefined();
  });
});

describe('shapeFromV1 — bundled T&S + pest row (server/routes/estimate-public.js ~L23831)', () => {
  function v1WithTreeShrub(palmCountFields = {}) {
    return {
      pestTiers: [{ label: 'Quarterly', mo: 60, ann: 720, pa: 180, apps: 4 }],
      services: [
        { name: 'Pest Control', service: 'pest_control', mo: 60, monthly: 60, annual: 720, perTreatment: 180, visitsPerYear: 4 },
        {
          name: 'Tree & Shrub', service: 'tree_shrub', mo: 66.75, monthly: 66.75, annual: 801, perTreatment: 133.5, visitsPerYear: 6,
          ...palmCountFields,
        },
      ],
      discount: 0,
      manualDiscount: null,
    };
  }

  test('carries a positive-integer palmCount through to the T&S perServiceTreatments row', () => {
    const v1 = v1WithTreeShrub({ palmCount: 3 });
    const pestTier = v1.pestTiers[0];
    const entry = shapeFromV1(v1, QUARTERLY, pestTier, {}, {});
    const row = entry.perServiceTreatments.find((r) => r.service === 'tree_shrub');
    expect(row.palmCount).toBe(3);
  });

  test.each([0, undefined])('omits palmCount for %s, row otherwise unchanged', (palmCount) => {
    const v1 = v1WithTreeShrub(palmCount === undefined ? {} : { palmCount });
    const pestTier = v1.pestTiers[0];
    const entry = shapeFromV1(v1, QUARTERLY, pestTier, {}, {});
    const row = entry.perServiceTreatments.find((r) => r.service === 'tree_shrub');
    expect(row.palmCount).toBeUndefined();
    expect(row.visitsPerYear).toBe(6);
  });
});

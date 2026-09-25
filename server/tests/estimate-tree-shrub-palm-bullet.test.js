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
  enrichPricingBundleTreeShrubPalmCount,
  frequencyFromTreatmentRow,
  frequencyFromRecurringService,
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

// ── Codex round 1 fixes (2026-09-24) ────────────────────────────────────────

describe('treeShrubPalmCountForEstData — mapped-v1-shape fallbacks (Codex #1)', () => {
  // A solo T&S estimate saved in the MAPPED shape (quote-required, or an
  // ENGINE_ERROR fallback) carries no raw lineItems/engineResult at all —
  // the count lives on result.recurring.services[] and/or result.tsMeta.
  test('falls back to result.recurring.services[] tree_shrub row when no raw lineItems exist', () => {
    const estData = {
      result: {
        recurring: { services: [{ service: 'tree_shrub', mo: 66.75, palmCount: 6 }] },
      },
    };
    expect(treeShrubPalmCountForEstData(estData)).toBe(6);
  });

  test('falls back to result.tsMeta.palmCount when neither lineItems nor a mapped services row carry it', () => {
    const estData = { result: { tsMeta: { palmCount: 9, palmCountSource: 'service_line' } } };
    expect(treeShrubPalmCountForEstData(estData)).toBe(9);
  });

  test('raw lineItems win over the mapped-shape fallbacks when both are present', () => {
    const estData = {
      result: {
        lineItems: [tsLineItem({ palmCount: 4 })],
        recurring: { services: [{ service: 'tree_shrub', palmCount: 11 }] },
        tsMeta: { palmCount: 12 },
      },
    };
    expect(treeShrubPalmCountForEstData(estData)).toBe(4);
  });

  test('the mapped services row wins over tsMeta when both are present (no raw lineItems)', () => {
    const estData = {
      result: {
        recurring: { services: [{ service: 'tree_shrub', palmCount: 5 }] },
        tsMeta: { palmCount: 12 },
      },
    };
    expect(treeShrubPalmCountForEstData(estData)).toBe(5);
  });

  test.each([
    ['zero on both fallbacks', { recurring: { services: [{ service: 'tree_shrub', palmCount: 0 }] }, tsMeta: { palmCount: 0 } }],
    ['no tree_shrub row in recurring.services, no tsMeta', { recurring: { services: [{ service: 'pest_control', palmCount: 4 }] } }],
    ['non-integer tsMeta.palmCount', { tsMeta: { palmCount: 2.5 } }],
  ])('returns null for %s', (_label, result) => {
    expect(treeShrubPalmCountForEstData({ result })).toBeNull();
  });
});

describe('enrichPricingBundleTreeShrubPalmCount — sendSnapshot read-time enrichment (Codex #2)', () => {
  const estDataWithPalms = (palmCount) => ({ result: { lineItems: [tsLineItem({ palmCount })] } });

  test('adds palmCount to a top-level frequency row that lacks it, leaving prices byte-identical', () => {
    const bundle = {
      frequencies: [{
        key: 'quarterly',
        monthly: 66.75,
        annual: 801,
        perServiceTreatments: [{ service: 'tree_shrub', label: 'Tree & Shrub', perTreatment: 133.5, displayPrice: 133.5, visitsPerYear: 6 }],
      }],
    };
    const enriched = enrichPricingBundleTreeShrubPalmCount(bundle, estDataWithPalms(4));
    const row = enriched.frequencies[0].perServiceTreatments[0];
    expect(row.palmCount).toBe(4);
    // Every price-bearing field is untouched.
    expect(row.perTreatment).toBe(133.5);
    expect(row.displayPrice).toBe(133.5);
    expect(enriched.frequencies[0].monthly).toBe(66.75);
    expect(enriched.frequencies[0].annual).toBe(801);
  });

  test('reaches a nested services[].frequencies[].perServiceTreatments row', () => {
    const bundle = {
      services: [{
        key: 'tree_shrub',
        frequencies: [{
          key: 'recurring',
          monthly: 66.75,
          perServiceTreatments: [{ service: 'tree_shrub', perTreatment: 133.5 }],
        }],
      }],
    };
    const enriched = enrichPricingBundleTreeShrubPalmCount(bundle, estDataWithPalms(2));
    expect(enriched.services[0].frequencies[0].perServiceTreatments[0].palmCount).toBe(2);
  });

  test('reaches a serviceCadenceCombos[].perServiceTreatments row', () => {
    const bundle = {
      serviceCadenceCombos: [{
        selection: { tree_shrub: 'standard' },
        perServiceTreatments: [{ service: 'tree_shrub', perTreatment: 133.5 }],
      }],
    };
    const enriched = enrichPricingBundleTreeShrubPalmCount(bundle, estDataWithPalms(7));
    expect(enriched.serviceCadenceCombos[0].perServiceTreatments[0].palmCount).toBe(7);
  });

  test('a row that already carries a positive palmCount is left untouched', () => {
    const bundle = {
      frequencies: [{ perServiceTreatments: [{ service: 'tree_shrub', perTreatment: 100, palmCount: 3 }] }],
    };
    // Stored evidence disagrees (4) — the already-stamped row still wins;
    // this function only BACK-FILLS a missing count, never overwrites one.
    const enriched = enrichPricingBundleTreeShrubPalmCount(bundle, estDataWithPalms(4));
    expect(enriched.frequencies[0].perServiceTreatments[0].palmCount).toBe(3);
  });

  test('a non-T&S row is never touched even though the estimate has palms', () => {
    const bundle = {
      frequencies: [{ perServiceTreatments: [{ service: 'pest_control', perTreatment: 60 }] }],
    };
    const enriched = enrichPricingBundleTreeShrubPalmCount(bundle, estDataWithPalms(4));
    expect(enriched.frequencies[0].perServiceTreatments[0].palmCount).toBeUndefined();
  });

  test('returns the SAME bundle reference (byte-identical) when there is no palm count to add', () => {
    const bundle = {
      frequencies: [{ perServiceTreatments: [{ service: 'tree_shrub', perTreatment: 133.5 }] }],
    };
    const enriched = enrichPricingBundleTreeShrubPalmCount(bundle, { result: { lineItems: [tsLineItem({ palmCount: 0 })] } });
    expect(enriched).toBe(bundle);
  });

  test('returns the SAME bundle reference when every T&S row already carries its palmCount', () => {
    const bundle = {
      frequencies: [{ perServiceTreatments: [{ service: 'tree_shrub', perTreatment: 133.5, palmCount: 4 }] }],
    };
    const enriched = enrichPricingBundleTreeShrubPalmCount(bundle, estDataWithPalms(4));
    expect(enriched).toBe(bundle);
  });

  test('handles a null/non-object bundle without throwing', () => {
    expect(enrichPricingBundleTreeShrubPalmCount(null, estDataWithPalms(4))).toBeNull();
    expect(enrichPricingBundleTreeShrubPalmCount(undefined, estDataWithPalms(4))).toBeUndefined();
  });
});

describe('frequencyFromTreatmentRow — rowless split T&S card carries frequency.palmCount (Codex #3)', () => {
  const baseFrequency = { key: 'quarterly', label: 'Quarterly (4 visits/year)' };

  test('attaches frequency.palmCount for a tree_shrub row with a positive palm count, WITHOUT adding perServiceTreatments', () => {
    const row = { service: 'tree_shrub', displayPrice: 133.5, perTreatment: 133.5, visitsPerYear: 6, palmCount: 4 };
    const frequency = frequencyFromTreatmentRow(baseFrequency, 'tree_shrub', row, {}, {});
    expect(frequency.palmCount).toBe(4);
    // Still rowless by construction — the lower-risk carry never adds a
    // synthetic perServiceTreatments array (that would flip PriceCard's
    // isRowless / price-display / booking-math branches for this card).
    expect(frequency.perServiceTreatments).toBeUndefined();
    // Prices are untouched by the palm-count wiring.
    expect(frequency.monthly).toBeCloseTo(66.75, 2);
    expect(frequency.perTreatment).toBe(133.5);
  });

  test.each([0, undefined, -1, 2.5])('omits frequency.palmCount for a tree_shrub row with palmCount %s', (palmCount) => {
    const row = {
      service: 'tree_shrub', displayPrice: 133.5, perTreatment: 133.5, visitsPerYear: 6,
      ...(palmCount === undefined ? {} : { palmCount }),
    };
    const frequency = frequencyFromTreatmentRow(baseFrequency, 'tree_shrub', row, {}, {});
    expect(frequency.palmCount).toBeUndefined();
  });

  test('a non-T&S row never gets frequency.palmCount even if the row carries one', () => {
    const row = { service: 'pest_control', displayPrice: 60, perTreatment: 60, visitsPerYear: 4, palmCount: 4 };
    const frequency = frequencyFromTreatmentRow(baseFrequency, 'pest_control', row, {}, {});
    expect(frequency.palmCount).toBeUndefined();
  });
});

describe('frequencyFromRecurringService — no-matching-row fallback carries palmCount too (Codex #3)', () => {
  test('attaches frequency.palmCount from a positive-integer recurringService.palmCount', () => {
    const recurringService = { service: 'tree_shrub', monthly: 66.75, visitsPerYear: 6, palmCount: 5 };
    const frequency = frequencyFromRecurringService(recurringService, 'tree_shrub', 0);
    expect(frequency.palmCount).toBe(5);
    expect(frequency.perServiceTreatments).toBeUndefined();
  });

  test.each([0, undefined])('omits frequency.palmCount for %s', (palmCount) => {
    const recurringService = {
      service: 'tree_shrub', monthly: 66.75, visitsPerYear: 6,
      ...(palmCount === undefined ? {} : { palmCount }),
    };
    const frequency = frequencyFromRecurringService(recurringService, 'tree_shrub', 0);
    expect(frequency.palmCount).toBeUndefined();
  });
});

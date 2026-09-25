// Palm-care inclusion bullet lane (owner 2026-09-24): palms are priced inside
// Tree & Shrub via the routine palm-care reserve — no separate line item, no
// new fee. The customer-facing bullet (client PriceCard) reads `palmCount`
// off a T&S perServiceTreatments row, so every server builder that can emit
// a tree_shrub row must attach it — but ONLY as a positive integer, so a
// zero/absent/invalid count leaves the row (and the rendered list) unchanged.
//
// Codex round 2 P0 on #4789 ("Exclude unpriced property palms from legacy
// bullets"): a positive palmCount is not enough — priceTreeShrub only
// actually PRICES a palm count when either palmCountSource === 'service_line'
// (folded into the legacy per-tree term regardless of arm state) or the
// v4.7 routine palm-care reserve is armed (perPalmAnnual / minutesPerPalmVisit
// knob > 0). A PROPERTY-sourced count while unarmed prices NOTHING, so the
// bullet must never show for it. tsLineItem() below defaults to
// palmCountSource: 'service_line' (the common "always priced" case most
// round-1 tests exercise) — tests for the property/unarmed gap override it
// explicitly with `evidence: 'property_unarmed'` / `'none'`.
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
const { pricedTreeShrubPalmCount } = require('../services/pricing-engine/tree-shrub-palm-priced');

const QUARTERLY = { key: 'quarterly', label: 'Quarterly (4 visits/year)', engineFrequency: 'quarterly' };

// `evidence` selects the priceTreeShrub-shaped fields that make a palmCount
// PRICED ('service_line' default, or 'property_armed') vs merely present but
// UNPRICED ('property_unarmed', or 'none' for a legacy pre-knob row with no
// evidence at all).
const EVIDENCE_SHAPES = {
  service_line: { palmCountSource: 'service_line' },
  property_armed: { palmCountSource: 'property', palmReserveActive: true, palmMaterialArmed: true, palmLaborArmed: true },
  property_unarmed: { palmCountSource: 'property', palmReserveActive: false, palmMaterialArmed: false, palmLaborArmed: false },
  none: {},
};

function tsLineItem(overrides = {}) {
  const { evidence = 'service_line', ...rest } = overrides;
  return {
    service: 'tree_shrub',
    tier: 'standard',
    frequency: 6,
    visitsPerYear: 6,
    monthly: 66.75,
    annual: 801,
    perApp: 133.5,
    ...EVIDENCE_SHAPES[evidence],
    ...rest,
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
        // mapV1ToLegacyShape always stamps tsMeta alongside ts rows; the
        // mapped envelope is the exclusive evidence (Codex round 3 P0).
        results: { ts: RESULT_STATS_TS, tsMeta: { palmCount: 4, palmCountSource: 'service_line' } },
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
  // the count lives on result.recurring.services[] and/or
  // result.results.tsMeta (mapV1ToLegacyShape nests its R accumulator as
  // `results: R` — same path treeShrubKnobSignalForReplay reads). tsMeta
  // rows below default to palmCountSource: 'service_line' so they read as
  // PRICED without extra fields (the priced-only gate itself is covered
  // separately in the round-2 describe blocks further down).
  test('falls back to result.recurring.services[] tree_shrub row when no raw lineItems exist', () => {
    const estData = {
      result: {
        recurring: { services: [{ service: 'tree_shrub', mo: 66.75, palmCount: 6 }] },
      },
    };
    expect(treeShrubPalmCountForEstData(estData)).toBe(6);
  });

  test('falls back to result.results.tsMeta.palmCount when neither lineItems nor a mapped services row carry it', () => {
    const estData = { result: { results: { tsMeta: { palmCount: 9, palmCountSource: 'service_line' } } } };
    expect(treeShrubPalmCountForEstData(estData)).toBe(9);
  });

  // Precedence flipped in Codex round 3 P0: the mapped envelope is exclusive
  // whenever it exists (a revision can leave an older raw line behind).
  test('the mapped envelope wins over raw lineItems when both are present', () => {
    const estData = {
      result: {
        lineItems: [tsLineItem({ palmCount: 4 })],
        recurring: { services: [{ service: 'tree_shrub', palmCount: 11 }] },
        results: { tsMeta: { palmCount: 12, palmCountSource: 'service_line' } },
      },
    };
    expect(treeShrubPalmCountForEstData(estData)).toBe(12);
  });

  // tsMeta carries the full priced evidence, so it is read before the
  // write-time-gated recurring row (Codex round 3 P0).
  test('tsMeta wins over the mapped services row when both are present', () => {
    const estData = {
      result: {
        recurring: { services: [{ service: 'tree_shrub', palmCount: 5 }] },
        results: { tsMeta: { palmCount: 12, palmCountSource: 'service_line' } },
      },
    };
    expect(treeShrubPalmCountForEstData(estData)).toBe(12);
  });

  test.each([
    ['zero on both fallbacks', { recurring: { services: [{ service: 'tree_shrub', palmCount: 0 }] }, results: { tsMeta: { palmCount: 0, palmCountSource: 'service_line' } } }],
    ['no tree_shrub row in recurring.services, no tsMeta', { recurring: { services: [{ service: 'pest_control', palmCount: 4 }] } }],
    ['non-integer tsMeta.palmCount', { results: { tsMeta: { palmCount: 2.5, palmCountSource: 'service_line' } } }],
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

// ── Codex round 2 fix (2026-09-24): "Exclude unpriced property palms from
// legacy bullets" — a positive palmCount is not, by itself, evidence the
// quote priced it. ───────────────────────────────────────────────────────

describe('pricedTreeShrubPalmCount — the shared priced-evidence predicate (Codex round 2 P0)', () => {
  test('service-line source prices regardless of arm state', () => {
    expect(pricedTreeShrubPalmCount({ palmCount: 4, palmCountSource: 'service_line' })).toBe(4);
    expect(pricedTreeShrubPalmCount({
      palmCount: 4, palmCountSource: 'service_line', palmReserveActive: false, palmMaterialArmed: false, palmLaborArmed: false,
    })).toBe(4);
  });

  test('property source prices ONLY when the reserve is armed for at least one leg', () => {
    expect(pricedTreeShrubPalmCount({ palmCount: 4, palmCountSource: 'property', palmReserveActive: true })).toBe(4);
    expect(pricedTreeShrubPalmCount({ palmCount: 4, palmCountSource: 'property', palmMaterialArmed: true })).toBe(4);
    expect(pricedTreeShrubPalmCount({ palmCount: 4, palmCountSource: 'property', palmLaborArmed: true })).toBe(4);
    // tsMeta shape carries no boolean flags — pricingKnobs alone is enough.
    expect(pricedTreeShrubPalmCount({
      palmCount: 4, palmCountSource: 'property', pricingKnobs: { perPalmAnnual: 16 },
    })).toBe(4);
    expect(pricedTreeShrubPalmCount({
      palmCount: 4, palmCountSource: 'property', pricingKnobs: { minutesPerPalmVisit: 1.5 },
    })).toBe(4);
  });

  test('property source with the reserve fully unarmed never prices — the exact bug Codex found', () => {
    expect(pricedTreeShrubPalmCount({
      palmCount: 4, palmCountSource: 'property', palmReserveActive: false, palmMaterialArmed: false, palmLaborArmed: false,
    })).toBeNull();
    expect(pricedTreeShrubPalmCount({
      palmCount: 4, palmCountSource: 'property', pricingKnobs: { perPalmAnnual: 0, minutesPerPalmVisit: 0 },
    })).toBeNull();
  });

  test('fails closed with no evidence at all (a legacy pre-v4.7-knob row)', () => {
    expect(pricedTreeShrubPalmCount({ palmCount: 4 })).toBeNull();
    expect(pricedTreeShrubPalmCount({ palmCount: 4, palmCountSource: 'none' })).toBeNull();
  });

  test.each([0, undefined, -1, 2.5])('null for a non-positive-integer palmCount (%s) even with full arm evidence', (palmCount) => {
    expect(pricedTreeShrubPalmCount({
      ...(palmCount === undefined ? {} : { palmCount }), palmCountSource: 'property', palmReserveActive: true,
    })).toBeNull();
  });

  test('handles null/non-object input without throwing', () => {
    expect(pricedTreeShrubPalmCount(null)).toBeNull();
    expect(pricedTreeShrubPalmCount(undefined)).toBeNull();
  });
});

describe('End-to-end priced-only gating across every carrier (Codex round 2 P0)', () => {
  test('property-sourced + unarmed → no palmCount from shapeFrequencyEntry (fresh engine build)', () => {
    const engineResult = {
      summary: { recurringMonthlyAfterDiscount: 66.75, recurringAnnualAfterDiscount: 801 },
      lineItems: [tsLineItem({ palmCount: 4, evidence: 'property_unarmed' })],
    };
    const entry = shapeFrequencyEntry(QUARTERLY, engineResult, {});
    const row = entry.perServiceTreatments.find((r) => r.service === 'tree_shrub');
    expect(row.palmCount).toBeUndefined();
  });

  test('service-line + unarmed → palmCount IS shown from shapeFrequencyEntry (always priced)', () => {
    const engineResult = {
      summary: { recurringMonthlyAfterDiscount: 66.75, recurringAnnualAfterDiscount: 801 },
      lineItems: [tsLineItem({ palmCount: 4, evidence: 'service_line' })],
    };
    const entry = shapeFrequencyEntry(QUARTERLY, engineResult, {});
    const row = entry.perServiceTreatments.find((r) => r.service === 'tree_shrub');
    expect(row.palmCount).toBe(4);
  });

  test('property-sourced + ARMED → palmCount IS shown from shapeFrequencyEntry', () => {
    const engineResult = {
      summary: { recurringMonthlyAfterDiscount: 66.75, recurringAnnualAfterDiscount: 801 },
      lineItems: [tsLineItem({ palmCount: 4, evidence: 'property_armed' })],
    };
    const entry = shapeFrequencyEntry(QUARTERLY, engineResult, {});
    const row = entry.perServiceTreatments.find((r) => r.service === 'tree_shrub');
    expect(row.palmCount).toBe(4);
  });

  test('property-sourced + unarmed → no palmCount from recurringServicesWithSupplements (raw agent draft)', () => {
    const estResult = { lineItems: [tsLineItem({ palmCount: 4, evidence: 'property_unarmed', annualAfterCredits: 801 })] };
    const services = recurringServicesWithSupplements(estResult);
    const row = services.find((s) => s.service === 'tree_shrub');
    expect(row.palmCount).toBeUndefined();
  });

  test('property-sourced + unarmed → no palmCount from treeShrubPalmCountForEstData\'s raw-lineItem fallback', () => {
    const estData = { result: { lineItems: [tsLineItem({ palmCount: 4, evidence: 'property_unarmed' })] } };
    expect(treeShrubPalmCountForEstData(estData)).toBeNull();
  });

  test('property-sourced + ARMED → priced, from treeShrubPalmCountForEstData\'s raw-lineItem fallback', () => {
    const estData = { result: { lineItems: [tsLineItem({ palmCount: 4, evidence: 'property_armed' })] } };
    expect(treeShrubPalmCountForEstData(estData)).toBe(4);
  });

  test('property-sourced + unarmed tsMeta → no palmCount from treeShrubPalmCountForEstData\'s tsMeta fallback', () => {
    const estData = {
      result: {
        results: { tsMeta: { palmCount: 4, palmCountSource: 'property', pricingKnobs: { perPalmAnnual: 0, minutesPerPalmVisit: 0 } } },
      },
    };
    expect(treeShrubPalmCountForEstData(estData)).toBeNull();
  });

  test('service-line tsMeta with the reserve unarmed → priced, from the tsMeta fallback', () => {
    const estData = {
      result: {
        results: { tsMeta: { palmCount: 4, palmCountSource: 'service_line', pricingKnobs: { perPalmAnnual: 0, minutesPerPalmVisit: 0 } } },
      },
    };
    expect(treeShrubPalmCountForEstData(estData)).toBe(4);
  });

  test('property-sourced tsMeta with the reserve ARMED → priced, from the tsMeta fallback', () => {
    const estData = {
      result: {
        results: { tsMeta: { palmCount: 4, palmCountSource: 'property', pricingKnobs: { perPalmAnnual: 16, minutesPerPalmVisit: 1.5 } } },
      },
    };
    expect(treeShrubPalmCountForEstData(estData)).toBe(4);
  });

  test('tsMeta with no source and no knob evidence at all (legacy pre-v4.7 row) fails closed', () => {
    const estData = { result: { results: { tsMeta: { palmCount: 4 } } } };
    expect(treeShrubPalmCountForEstData(estData)).toBeNull();
  });

  test('missing evidence anywhere (no lineItems, no mapped row, no tsMeta) → null, never guessed', () => {
    expect(treeShrubPalmCountForEstData({ result: {} })).toBeNull();
  });

  test('property-sourced + unarmed → no palmCount from v1-legacy-mapper svcAdd, via mapV1ToLegacyShape', () => {
    const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
    const v1Result = {
      summary: {},
      lineItems: [tsLineItem({ palmCount: 4, evidence: 'property_unarmed' })],
      property: {},
    };
    const mapped = mapV1ToLegacyShape(v1Result);
    const row = mapped.recurring.services.find((s) => s.service === 'tree_shrub');
    expect(row).toBeTruthy();
    expect(row.palmCount).toBeUndefined();
    // results.tsMeta still carries the RAW count (unpriced or not) — the
    // palm/knob replay machinery needs it to reprice the same job; only the
    // customer-facing bullet carrier (recurring.services[]) is gated.
    expect(mapped.results.tsMeta.palmCount).toBe(4);
  });

  test('property-sourced + ARMED → palmCount shown from v1-legacy-mapper svcAdd, via mapV1ToLegacyShape', () => {
    const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
    const v1Result = {
      summary: {},
      lineItems: [tsLineItem({ palmCount: 4, evidence: 'property_armed' })],
      property: {},
    };
    const mapped = mapV1ToLegacyShape(v1Result);
    const row = mapped.recurring.services.find((s) => s.service === 'tree_shrub');
    expect(row.palmCount).toBe(4);
  });

  test('property-sourced + unarmed → snapshot enrichment adds NOTHING (Codex #2 x round-2 interaction)', () => {
    const bundle = {
      frequencies: [{
        monthly: 66.75,
        perServiceTreatments: [{ service: 'tree_shrub', perTreatment: 133.5, displayPrice: 133.5 }],
      }],
    };
    const estData = { result: { lineItems: [tsLineItem({ palmCount: 4, evidence: 'property_unarmed' })] } };
    const enriched = enrichPricingBundleTreeShrubPalmCount(bundle, estData);
    // No evidence to add → same bundle reference, row still has no palmCount.
    expect(enriched).toBe(bundle);
    expect(enriched.frequencies[0].perServiceTreatments[0].palmCount).toBeUndefined();
  });

  test('property-sourced + ARMED → snapshot enrichment DOES add the count', () => {
    const bundle = {
      frequencies: [{
        monthly: 66.75,
        perServiceTreatments: [{ service: 'tree_shrub', perTreatment: 133.5, displayPrice: 133.5 }],
      }],
    };
    const estData = { result: { lineItems: [tsLineItem({ palmCount: 4, evidence: 'property_armed' })] } };
    const enriched = enrichPricingBundleTreeShrubPalmCount(bundle, estData);
    expect(enriched.frequencies[0].perServiceTreatments[0].palmCount).toBe(4);
    // Price fields untouched.
    expect(enriched.frequencies[0].perServiceTreatments[0].perTreatment).toBe(133.5);
    expect(enriched.frequencies[0].monthly).toBe(66.75);
  });
});

describe('pricedTreeShrubPalmCount against the REAL priceTreeShrub engine output (field-name sanity check)', () => {
  const { priceTreeShrub } = require('../services/pricing-engine/service-pricing');

  test('a property palm count with the reserve at its unarmed constants-file default is NOT priced', () => {
    const line = priceTreeShrub({ palmCount: 4, bedArea: 500 }, { tier: 'standard' });
    expect(line.palmCountSource).toBe('property');
    expect(line.palmReserveActive).toBe(false);
    expect(pricedTreeShrubPalmCount(line)).toBeNull();
  });

  test('the same property palm count IS priced once the per-request knobs arm the reserve', () => {
    const line = priceTreeShrub(
      { palmCount: 4, bedArea: 500 },
      { tier: 'standard', knobs: { perPalmAnnual: 16, minutesPerPalmVisit: 1.5 } },
    );
    expect(line.palmCountSource).toBe('property');
    expect(line.palmReserveActive).toBe(true);
    expect(pricedTreeShrubPalmCount(line)).toBe(4);
  });

  test('a service-line palm count is priced even at the unarmed constants-file default (folded into the legacy term)', () => {
    const line = priceTreeShrub({ bedArea: 500 }, { tier: 'standard', palmCount: 4 });
    expect(line.palmCountSource).toBe('service_line');
    expect(line.palmReserveActive).toBe(false);
    expect(pricedTreeShrubPalmCount(line)).toBe(4);
  });

  test('no palms at all → palmCount 0, never priced', () => {
    const line = priceTreeShrub({ bedArea: 500 }, { tier: 'standard' });
    expect(line.palmCount).toBe(0);
    expect(pricedTreeShrubPalmCount(line)).toBeNull();
  });
});

describe('treeShrubPalmCountForEstData — mapped envelope is exclusive over a stale engineResult (Codex round 3 P0)', () => {
  const staleServiceLine = { service: 'tree_shrub', palmCount: 6, palmCountSource: 'service_line' };

  test('mapped tsMeta showing unpriced property palms beats a stale service_line engine line', () => {
    const estData = {
      result: { results: { tsMeta: { palmCount: 4, palmCountSource: 'property', pricingKnobs: { perPalmAnnual: 0, minutesPerPalmVisit: 0 } } } },
      engineResult: { lineItems: [staleServiceLine] },
    };
    expect(treeShrubPalmCountForEstData(estData)).toBeNull();
  });

  test('mapped tsMeta with zero palms beats a stale service_line engine line', () => {
    const estData = {
      result: { results: { tsMeta: { palmCount: 0, palmCountSource: 'none' } } },
      engineResult: { lineItems: [staleServiceLine] },
    };
    expect(treeShrubPalmCountForEstData(estData)).toBeNull();
  });

  test('mapped ts rows alone (pre-palm tsMeta-less envelope) still exclude the raw engine line', () => {
    const estData = {
      result: { results: { ts: [{ name: 'Standard', v: 6, mo: 50 }] } },
      engineResult: { lineItems: [staleServiceLine] },
    };
    expect(treeShrubPalmCountForEstData(estData)).toBeNull();
  });

  test('mapped tsMeta that proves pricing wins over a different stale engine count', () => {
    const estData = {
      result: { results: { tsMeta: { palmCount: 3, palmCountSource: 'property', pricingKnobs: { perPalmAnnual: 16, minutesPerPalmVisit: 1.5 } } } },
      engineResult: { lineItems: [staleServiceLine] },
    };
    expect(treeShrubPalmCountForEstData(estData)).toBe(3);
  });

  test('mapped recurring row (write-time gated) is used when no tsMeta exists', () => {
    const estData = {
      result: { recurring: { services: [{ service: 'tree_shrub', palmCount: 5 }] } },
      engineResult: { lineItems: [staleServiceLine] },
    };
    expect(treeShrubPalmCountForEstData(estData)).toBe(5);
  });

  test('raw engine line is consulted only when there is no mapped T&S envelope', () => {
    expect(treeShrubPalmCountForEstData({ engineResult: { lineItems: [staleServiceLine] } })).toBe(6);
  });
});

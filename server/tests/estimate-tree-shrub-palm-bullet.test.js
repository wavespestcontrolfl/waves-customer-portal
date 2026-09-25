// Palm-care inclusion bullet lane (owner 2026-09-24): palms are priced inside
// Tree & Shrub via the routine palm-care reserve — no separate line item, no
// new fee. Four Codex rounds on #4789 each found a different per-builder
// carry that leaked a raw or stale palmCount somewhere downstream
// (shapeFrequencyEntry, recurringServicesWithSupplements,
// v1-legacy-mapper's svcAdd, shapeFromV1, frequencyFromTreatmentRow/
// frequencyFromRecurringService, and finally one-tap-purchase.js's RAW
// engine line stored straight into result.recurring.services[]) — so as of
// round 4, NO pricing-bundle builder carries palmCount at all. The
// architecture is now a single evidence + stamping chokepoint:
//
//  - treeShrubPalmCountForEstData(estData, freshEngineResult?) resolves the
//    ONE authoritative, PRICED count for a request (fresh engine evidence
//    beats stored; the mapped envelope is exclusive over a stale raw
//    engineResult; every raw shape is read through pricedTreeShrubPalmCount,
//    never trusted as a plain positive integer).
//  - stampTreeShrubPalmCount(bundle, count) applies that ONE count to the
//    FINAL pricing bundle, on every buildPricingBundle return path,
//    overwriting/deleting unconditionally so a stray value from anywhere
//    upstream (or an older cached/snapshotted bundle) can never survive.
//
// This file tests the chokepoint itself, the shared pricedTreeShrubPalmCount
// predicate, real-engine sanity, and the legacy SSR renderer's own use of
// the same evidence function. It does NOT test shapeFrequencyEntry,
// recurringServicesWithSupplements, shapeFromV1, treeShrubFrequenciesFromResultStats,
// frequencyFromTreatmentRow/frequencyFromRecurringService, or v1-legacy-mapper's
// svcAdd for palmCount — none of them carry it any more.
const {
  treeShrubPalmCountForEstData,
  stampTreeShrubPalmCount,
  renderPage,
} = require('../routes/estimate-public');
const { pricedTreeShrubPalmCount } = require('../services/pricing-engine/tree-shrub-palm-priced');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { priceTreeShrub } = require('../services/pricing-engine/service-pricing');

// `evidence` selects the priceTreeShrub-shaped fields that make a palmCount
// PRICED ('service_line', or 'property_armed') vs merely present but
// UNPRICED ('property_unarmed'), or a legacy row with no evidence at all
// ('none').
// pricingKnobs is ALWAYS present on a real priceTreeShrub() line (armed or
// not) — tsMeta (v1-legacy-mapper) copies ONLY palmCountSource + pricingKnobs
// from the line, never the boolean palm*Armed flags, so a fixture meant to
// survive a real mapV1ToLegacyShape round-trip must carry pricingKnobs too.
const EVIDENCE_SHAPES = {
  service_line: { palmCountSource: 'service_line', pricingKnobs: { perPalmAnnual: 0, minutesPerPalmVisit: 0 } },
  property_armed: {
    palmCountSource: 'property', palmReserveActive: true, palmMaterialArmed: true, palmLaborArmed: true,
    pricingKnobs: { perPalmAnnual: 16, minutesPerPalmVisit: 1.5 },
  },
  property_unarmed: {
    palmCountSource: 'property', palmReserveActive: false, palmMaterialArmed: false, palmLaborArmed: false,
    pricingKnobs: { perPalmAnnual: 0, minutesPerPalmVisit: 0 },
  },
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

describe('pricedTreeShrubPalmCount — the shared priced-evidence predicate', () => {
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

  test('property source with the reserve fully unarmed never prices — the original round-2 bug', () => {
    expect(pricedTreeShrubPalmCount({
      palmCount: 4, palmCountSource: 'property', palmReserveActive: false, palmMaterialArmed: false, palmLaborArmed: false,
    })).toBeNull();
    expect(pricedTreeShrubPalmCount({
      palmCount: 4, palmCountSource: 'property', pricingKnobs: { perPalmAnnual: 0, minutesPerPalmVisit: 0 },
    })).toBeNull();
  });

  test('fails closed with no evidence at all (a legacy pre-v4.7-knob row, or a raw row from an unknown producer)', () => {
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

describe('pricedTreeShrubPalmCount against the REAL priceTreeShrub engine output (field-name sanity check)', () => {
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

describe('treeShrubPalmCountForEstData — raw lineItems fallback (no mapped T&S envelope at all)', () => {
  test('reads a priced count off result.lineItems', () => {
    const estData = { result: { lineItems: [tsLineItem({ palmCount: 7 })] } };
    expect(treeShrubPalmCountForEstData(estData)).toBe(7);
  });

  test('falls back to engineResult.lineItems (agent/engine draft shape)', () => {
    const estData = { engineResult: { lineItems: [tsLineItem({ palmCount: 2 })] } };
    expect(treeShrubPalmCountForEstData(estData)).toBe(2);
  });

  test('property-sourced + unarmed → null (unpriced)', () => {
    const estData = { result: { lineItems: [tsLineItem({ palmCount: 4, evidence: 'property_unarmed' })] } };
    expect(treeShrubPalmCountForEstData(estData)).toBeNull();
  });

  test('property-sourced + armed → priced', () => {
    const estData = { result: { lineItems: [tsLineItem({ palmCount: 4, evidence: 'property_armed' })] } };
    expect(treeShrubPalmCountForEstData(estData)).toBe(4);
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

describe('treeShrubPalmCountForEstData — mapped envelope (result.results.tsMeta / result.recurring.services[])', () => {
  test('falls back to result.recurring.services[] tree_shrub row when no tsMeta exists (row carries evidence)', () => {
    const estData = {
      result: {
        recurring: { services: [{ service: 'tree_shrub', mo: 66.75, palmCount: 6, palmCountSource: 'service_line' }] },
      },
    };
    expect(treeShrubPalmCountForEstData(estData)).toBe(6);
  });

  // Codex round 4 P0 ("Re-gate raw recurring rows before rendering palms"):
  // one-tap-purchase.js stores a RAW engine line straight into
  // result.recurring.services[] for its own recurring row — a positive
  // palmCount there is no longer trusted as pre-gated; it's read through
  // the same evidence predicate as any other raw shape.
  test('a mapped-slot row with NO evidence fields (bare palmCount) fails closed — the exact round-4 bug', () => {
    const estData = {
      result: {
        recurring: { services: [{ service: 'tree_shrub', mo: 66.75, palmCount: 6 }] },
      },
    };
    expect(treeShrubPalmCountForEstData(estData)).toBeNull();
  });

  test('a raw one-tap-purchase-shaped row (property-sourced, unarmed) in that exact slot fails closed', () => {
    // Mirrors one-tap-purchase.js: result = { ...engineResult, recurring: { services: [storedLine] } }
    // — storedLine IS the raw priceTreeShrub() line, spread verbatim, with
    // no results.tsMeta/results.ts at all (no mapped-mapper envelope).
    const rawLine = tsLineItem({ palmCount: 4, evidence: 'property_unarmed', selected: true, isSelected: true });
    const estData = { result: { recurring: { services: [rawLine] } } };
    expect(treeShrubPalmCountForEstData(estData)).toBeNull();
  });

  test('the same raw one-tap-purchase-shaped row, reserve ARMED, is priced', () => {
    const rawLine = tsLineItem({ palmCount: 4, evidence: 'property_armed', selected: true, isSelected: true });
    const estData = { result: { recurring: { services: [rawLine] } } };
    expect(treeShrubPalmCountForEstData(estData)).toBe(4);
  });

  test('the same raw one-tap-purchase-shaped row, service-line sourced, is priced', () => {
    const rawLine = tsLineItem({ palmCount: 4, evidence: 'service_line', selected: true, isSelected: true });
    const estData = { result: { recurring: { services: [rawLine] } } };
    expect(treeShrubPalmCountForEstData(estData)).toBe(4);
  });

  test('falls back to result.results.tsMeta.palmCount when there is no recurring.services row', () => {
    const estData = { result: { results: { tsMeta: { palmCount: 9, palmCountSource: 'service_line' } } } };
    expect(treeShrubPalmCountForEstData(estData)).toBe(9);
  });

  test('tsMeta wins over the mapped services row when both are present', () => {
    const estData = {
      result: {
        recurring: { services: [{ service: 'tree_shrub', palmCount: 5, palmCountSource: 'service_line' }] },
        results: { tsMeta: { palmCount: 12, palmCountSource: 'service_line' } },
      },
    };
    expect(treeShrubPalmCountForEstData(estData)).toBe(12);
  });

  test('a tsMeta that exists but proves unpriced is FINAL — the mapped row cannot contradict it', () => {
    const estData = {
      result: {
        recurring: { services: [{ service: 'tree_shrub', palmCount: 5, palmCountSource: 'service_line' }] },
        results: { tsMeta: { palmCount: 12, palmCountSource: 'property', pricingKnobs: { perPalmAnnual: 0, minutesPerPalmVisit: 0 } } },
      },
    };
    expect(treeShrubPalmCountForEstData(estData)).toBeNull();
  });

  test.each([
    ['zero on both fallbacks', { recurring: { services: [{ service: 'tree_shrub', palmCount: 0, palmCountSource: 'service_line' }] }, results: { tsMeta: { palmCount: 0, palmCountSource: 'service_line' } } }],
    ['no tree_shrub row in recurring.services, no tsMeta', { recurring: { services: [{ service: 'pest_control', palmCount: 4 }] } }],
    ['non-integer tsMeta.palmCount', { results: { tsMeta: { palmCount: 2.5, palmCountSource: 'service_line' } } }],
  ])('returns null for %s', (_label, result) => {
    expect(treeShrubPalmCountForEstData({ result })).toBeNull();
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

  test('mapped ts rows alone (pre-palm tsMeta-less envelope) still exclude the raw engine line', () => {
    const estData = {
      result: { results: { ts: [{ name: 'Standard', v: 6, mo: 50 }] } },
      engineResult: { lineItems: [staleServiceLine] },
    };
    expect(treeShrubPalmCountForEstData(estData)).toBeNull();
  });

  test('mapped recurring row (evidence-gated) wins over a stale, differing engine line when no tsMeta exists', () => {
    const estData = {
      result: { recurring: { services: [{ service: 'tree_shrub', palmCount: 5, palmCountSource: 'service_line' }] } },
      engineResult: { lineItems: [staleServiceLine] },
    };
    expect(treeShrubPalmCountForEstData(estData)).toBe(5);
  });

  test('raw engine line is consulted only when there is no mapped T&S envelope', () => {
    expect(treeShrubPalmCountForEstData({ engineResult: { lineItems: [staleServiceLine] } })).toBe(6);
  });
});

describe('treeShrubPalmCountForEstData — fresh engine result beats stored (Codex round 4)', () => {
  test('a fresh T&S line outranks a disagreeing stored mapped envelope', () => {
    const estData = {
      result: { results: { tsMeta: { palmCount: 12, palmCountSource: 'service_line' } } },
    };
    const freshEngineResult = { lineItems: [tsLineItem({ palmCount: 3, evidence: 'service_line' })] };
    expect(treeShrubPalmCountForEstData(estData, freshEngineResult)).toBe(3);
  });

  test('fresh evidence proving UNPRICED is final — never falls back to a stale stored count', () => {
    const estData = {
      result: { results: { tsMeta: { palmCount: 12, palmCountSource: 'service_line' } } },
    };
    const freshEngineResult = { lineItems: [tsLineItem({ palmCount: 3, evidence: 'property_unarmed' })] };
    expect(treeShrubPalmCountForEstData(estData, freshEngineResult)).toBeNull();
  });

  test('falls back to stored evidence when the fresh result has no T&S line at all', () => {
    const estData = { result: { results: { tsMeta: { palmCount: 9, palmCountSource: 'service_line' } } } };
    const freshEngineResult = { lineItems: [{ service: 'pest_control', monthly: 60 }] };
    expect(treeShrubPalmCountForEstData(estData, freshEngineResult)).toBe(9);
  });

  test('a null/absent fresh result behaves exactly like the single-argument call', () => {
    const estData = { result: { results: { tsMeta: { palmCount: 9, palmCountSource: 'service_line' } } } };
    expect(treeShrubPalmCountForEstData(estData, null)).toBe(9);
    expect(treeShrubPalmCountForEstData(estData, {})).toBe(9);
  });
});

describe('stampTreeShrubPalmCount — the chokepoint applied to the FINAL bundle', () => {
  test('stamps a tree_shrub perServiceTreatments row with the resolved count', () => {
    const bundle = {
      frequencies: [{
        key: 'quarterly',
        monthly: 66.75,
        annual: 801,
        perServiceTreatments: [{ service: 'tree_shrub', label: 'Tree & Shrub', perTreatment: 133.5, displayPrice: 133.5, visitsPerYear: 6 }],
      }],
    };
    const stamped = stampTreeShrubPalmCount(bundle, 4);
    const row = stamped.frequencies[0].perServiceTreatments[0];
    expect(row.palmCount).toBe(4);
    // Price fields untouched.
    expect(row.perTreatment).toBe(133.5);
    expect(row.displayPrice).toBe(133.5);
    expect(stamped.frequencies[0].monthly).toBe(66.75);
    expect(stamped.frequencies[0].annual).toBe(801);
  });

  test('OVERWRITES a row that already carries a DIFFERENT palmCount — this is not a fill-gaps enrichment', () => {
    const bundle = {
      frequencies: [{ perServiceTreatments: [{ service: 'tree_shrub', perTreatment: 100, palmCount: 99 }] }],
    };
    const stamped = stampTreeShrubPalmCount(bundle, 4);
    expect(stamped.frequencies[0].perServiceTreatments[0].palmCount).toBe(4);
  });

  test('DELETES palmCount from a row when the resolved count is null (stale/raw value can never survive)', () => {
    const bundle = {
      frequencies: [{ perServiceTreatments: [{ service: 'tree_shrub', perTreatment: 100, palmCount: 99 }] }],
    };
    const stamped = stampTreeShrubPalmCount(bundle, null);
    expect(stamped.frequencies[0].perServiceTreatments[0].palmCount).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(stamped.frequencies[0].perServiceTreatments[0], 'palmCount')).toBe(false);
  });

  test('reaches a nested services[].frequencies[].perServiceTreatments row', () => {
    const bundle = {
      services: [{
        key: 'tree_shrub',
        frequencies: [{ key: 'recurring', monthly: 66.75, perServiceTreatments: [{ service: 'tree_shrub', perTreatment: 133.5 }] }],
      }],
    };
    const stamped = stampTreeShrubPalmCount(bundle, 2);
    expect(stamped.services[0].frequencies[0].perServiceTreatments[0].palmCount).toBe(2);
  });

  test('reaches a serviceCadenceCombos[].perServiceTreatments row', () => {
    const bundle = {
      serviceCadenceCombos: [{
        selection: { tree_shrub: 'standard' },
        perServiceTreatments: [{ service: 'tree_shrub', perTreatment: 133.5 }],
      }],
    };
    const stamped = stampTreeShrubPalmCount(bundle, 7);
    expect(stamped.serviceCadenceCombos[0].perServiceTreatments[0].palmCount).toBe(7);
  });

  test('a non-T&S row is never touched even with a valid count', () => {
    const bundle = { frequencies: [{ perServiceTreatments: [{ service: 'pest_control', perTreatment: 60 }] }] };
    const stamped = stampTreeShrubPalmCount(bundle, 4);
    expect(stamped.frequencies[0].perServiceTreatments[0].palmCount).toBeUndefined();
  });

  test('ROWLESS tree_shrub frequency: self-identifying via serviceCategory (the solo-T&S ladder shape) gets frequency.palmCount', () => {
    const bundle = {
      frequencies: [{
        key: 'standard',
        serviceCategory: 'tree_shrub',
        monthly: 66.75,
        perServiceTreatments: [],
      }],
    };
    const stamped = stampTreeShrubPalmCount(bundle, 4);
    expect(stamped.frequencies[0].palmCount).toBe(4);
  });

  test('ROWLESS tree_shrub frequency: nested under a services[] section classified tree_shrub gets frequency.palmCount', () => {
    // Mirrors buildPricingServices → frequencyFromTreatmentRow's shape: the
    // SECTION carries the tree_shrub identity, the frequency itself carries
    // no serviceCategory and no perServiceTreatments at all.
    const bundle = {
      services: [{
        key: 'tree_shrub',
        category: 'tree_shrub',
        frequencies: [{ key: 'quarterly', label: 'Quarterly Tree & Shrub', monthly: 66.75, perTreatment: 133.5 }],
      }],
    };
    const stamped = stampTreeShrubPalmCount(bundle, 4);
    expect(stamped.services[0].frequencies[0].palmCount).toBe(4);
  });

  test('a rowless frequency in a NON-tree_shrub section is never touched', () => {
    const bundle = {
      services: [{
        key: 'lawn_care',
        frequencies: [{ key: 'quarterly', monthly: 40 }],
      }],
    };
    const stamped = stampTreeShrubPalmCount(bundle, 4);
    expect(stamped.services[0].frequencies[0].palmCount).toBeUndefined();
    // No change anywhere → same top-level bundle reference.
    expect(stamped).toBe(bundle);
  });

  test('DELETES a stale frequency.palmCount from a rowless T&S frequency when the resolved count is null', () => {
    const bundle = {
      frequencies: [{ key: 'standard', serviceCategory: 'tree_shrub', monthly: 66.75, perServiceTreatments: [], palmCount: 99 }],
    };
    const stamped = stampTreeShrubPalmCount(bundle, null);
    expect(stamped.frequencies[0].palmCount).toBeUndefined();
  });

  test('never touches a price field anywhere in the bundle', () => {
    const bundle = {
      frequencies: [{
        key: 'quarterly',
        monthly: 66.75,
        annual: 801,
        perTreatment: 133.5,
        serviceCategory: 'tree_shrub',
        perServiceTreatments: [{ service: 'tree_shrub', perTreatment: 133.5, displayPrice: 133.5, monthly: 66.75 }],
      }],
    };
    const stamped = stampTreeShrubPalmCount(bundle, 5);
    const freq = stamped.frequencies[0];
    expect(freq.monthly).toBe(66.75);
    expect(freq.annual).toBe(801);
    expect(freq.perTreatment).toBe(133.5);
    expect(freq.perServiceTreatments[0].perTreatment).toBe(133.5);
    expect(freq.perServiceTreatments[0].displayPrice).toBe(133.5);
    expect(freq.perServiceTreatments[0].monthly).toBe(66.75);
  });

  test('returns the SAME bundle reference when nothing needs to change (no T&S row/frequency present)', () => {
    const bundle = { frequencies: [{ perServiceTreatments: [{ service: 'pest_control', perTreatment: 60 }] }] };
    expect(stampTreeShrubPalmCount(bundle, 4)).toBe(bundle);
  });

  test('returns the SAME bundle reference when every T&S row already carries the resolved count', () => {
    const bundle = { frequencies: [{ perServiceTreatments: [{ service: 'tree_shrub', perTreatment: 133.5, palmCount: 4 }] }] };
    expect(stampTreeShrubPalmCount(bundle, 4)).toBe(bundle);
  });

  test('returns the SAME bundle reference when count is null/invalid and nothing had a palmCount to strip', () => {
    const bundle = { frequencies: [{ perServiceTreatments: [{ service: 'tree_shrub', perTreatment: 133.5 }] }] };
    expect(stampTreeShrubPalmCount(bundle, 0)).toBe(bundle);
    expect(stampTreeShrubPalmCount(bundle, null)).toBe(bundle);
  });

  test('handles a null/non-object bundle without throwing', () => {
    expect(stampTreeShrubPalmCount(null, 4)).toBeNull();
    expect(stampTreeShrubPalmCount(undefined, 4)).toBeUndefined();
  });
});

describe('End-to-end: one-tap-purchase.js raw recurring row, resolved and stamped (Codex round 4 P0)', () => {
  // one-tap-purchase.js writes: estimateData.result = { ...engineResult,
  // recurring: { services: [storedLine] } }, where storedLine IS the raw
  // priceTreeShrub() line item, spread verbatim (selected/isSelected added).
  // No results.tsMeta, no results.ts — no mapped-mapper envelope at all.
  function oneTapEstData({ palmCount, evidence }) {
    const storedLine = tsLineItem({ palmCount, evidence, selected: true, isSelected: true });
    return { result: { recurring: { services: [storedLine] } } };
  }
  const bundleWithTsRow = () => ({
    frequencies: [{
      key: 'recurring',
      monthly: 66.75,
      perServiceTreatments: [{ service: 'tree_shrub', label: 'Tree & Shrub', perTreatment: 133.5, displayPrice: 133.5 }],
    }],
  });

  test('property-sourced + unarmed → no palmCount ANYWHERE in the final stamped bundle', () => {
    const estData = oneTapEstData({ palmCount: 4, evidence: 'property_unarmed' });
    const count = treeShrubPalmCountForEstData(estData);
    expect(count).toBeNull();
    const stamped = stampTreeShrubPalmCount(bundleWithTsRow(), count);
    expect(stamped.frequencies[0].perServiceTreatments[0].palmCount).toBeUndefined();
  });

  test('a STALE stamped bundle (from before the one-tap purchase, carrying an old palmCount) gets it stripped', () => {
    const estData = oneTapEstData({ palmCount: 4, evidence: 'property_unarmed' });
    const count = treeShrubPalmCountForEstData(estData);
    const staleBundle = {
      frequencies: [{
        perServiceTreatments: [{ service: 'tree_shrub', perTreatment: 133.5, palmCount: 6 }],
      }],
    };
    const stamped = stampTreeShrubPalmCount(staleBundle, count);
    expect(stamped.frequencies[0].perServiceTreatments[0].palmCount).toBeUndefined();
  });

  test('property-sourced + armed → priced and stamped through to the final bundle', () => {
    const estData = oneTapEstData({ palmCount: 4, evidence: 'property_armed' });
    const count = treeShrubPalmCountForEstData(estData);
    expect(count).toBe(4);
    const stamped = stampTreeShrubPalmCount(bundleWithTsRow(), count);
    expect(stamped.frequencies[0].perServiceTreatments[0].palmCount).toBe(4);
  });

  test('service-line sourced → priced and stamped regardless of arm state', () => {
    const estData = oneTapEstData({ palmCount: 4, evidence: 'service_line' });
    const count = treeShrubPalmCountForEstData(estData);
    expect(count).toBe(4);
    const stamped = stampTreeShrubPalmCount(bundleWithTsRow(), count);
    expect(stamped.frequencies[0].perServiceTreatments[0].palmCount).toBe(4);
  });
});

describe('v1-legacy-mapper.js — the mapped row carries NO palmCount any more (Codex round 4)', () => {
  test('mapV1ToLegacyShape never stamps palmCount onto the recurring.services[] tree_shrub row', () => {
    const v1Result = {
      summary: {},
      lineItems: [tsLineItem({ palmCount: 4, evidence: 'property_armed' })],
      property: {},
    };
    const mapped = mapV1ToLegacyShape(v1Result);
    const row = mapped.recurring.services.find((s) => s.service === 'tree_shrub');
    expect(row).toBeTruthy();
    expect(row.palmCount).toBeUndefined();
    // results.tsMeta still carries the RAW count unconditionally — the
    // palm/knob replay machinery (estimate-tree-shrub-knob-replay.js) needs
    // the true count to reprice the same job; treeShrubPalmCountForEstData
    // (the chokepoint) is what gates it for display.
    expect(mapped.results.tsMeta.palmCount).toBe(4);
    expect(treeShrubPalmCountForEstData({ result: mapped })).toBe(4);
  });

  test('an unarmed property count still lands raw in tsMeta, but the chokepoint resolves it to null', () => {
    const v1Result = {
      summary: {},
      lineItems: [tsLineItem({ palmCount: 4, evidence: 'property_unarmed' })],
      property: {},
    };
    const mapped = mapV1ToLegacyShape(v1Result);
    expect(mapped.recurring.services.find((s) => s.service === 'tree_shrub').palmCount).toBeUndefined();
    expect(mapped.results.tsMeta.palmCount).toBe(4);
    expect(treeShrubPalmCountForEstData({ result: mapped })).toBeNull();
  });
});

describe('legacy SSR estimate page — same palm-care sentence on the T&S service card (Codex round 4 P0)', () => {
  function treeShrubSsrEstimate(overrides = {}) {
    return {
      id: `estimate-${Math.random().toString(36).slice(2)}`,
      status: 'sent',
      customerName: 'Test Customer',
      address: '1 Main St, Bradenton, FL 34203',
      monthlyTotal: 66.75,
      annualTotal: 801,
      onetimeTotal: 0,
      quoteRequired: false,
      ...overrides,
    };
  }
  // No result.recurring.services and no results.tsMeta here on purpose:
  // that shape (a mapped envelope with no palm evidence of its own) is
  // EXCLUSIVE over raw lineItems (Codex round 3 P0) and would resolve to
  // null regardless of what engineResult carries — the raw-lineItems
  // fallback is reached only with no mapped T&S envelope at all, so the
  // palm evidence lives on result.lineItems (recurringServicesWithSupplements
  // builds the display row from the very same raw line — one source, no
  // possible disagreement).
  function treeShrubSsrEstimateData({ palmCount, evidence }) {
    const lineItem = tsLineItem({ palmCount, evidence });
    return {
      result: {
        lineItems: [lineItem],
        oneTime: { items: [], membershipFee: 0 },
      },
    };
  }

  test('shows the palm bullet on the T&S service card for a priced (service-line) palm count', () => {
    const html = renderPage('ts-ssr-priced', treeShrubSsrEstimate(), treeShrubSsrEstimateData({ palmCount: 4, evidence: 'service_line' }));
    expect(html).toContain('Includes care for your 4 palms — seasonal palm nutrition and root-zone treatment when needed');
  });

  test('singularizes "palm" for a palm count of exactly 1', () => {
    const html = renderPage('ts-ssr-singular', treeShrubSsrEstimate(), treeShrubSsrEstimateData({ palmCount: 1, evidence: 'service_line' }));
    expect(html).toContain('Includes care for your 1 palm — seasonal palm nutrition and root-zone treatment when needed');
    expect(html).not.toContain('1 palms');
  });

  test('property-sourced + ARMED also shows the bullet', () => {
    const html = renderPage('ts-ssr-armed', treeShrubSsrEstimate(), treeShrubSsrEstimateData({ palmCount: 6, evidence: 'property_armed' }));
    expect(html).toContain('Includes care for your 6 palms — seasonal palm nutrition and root-zone treatment when needed');
  });

  test('omits the bullet entirely when the property count is unpriced (reserve unarmed)', () => {
    const html = renderPage('ts-ssr-unarmed', treeShrubSsrEstimate(), treeShrubSsrEstimateData({ palmCount: 4, evidence: 'property_unarmed' }));
    expect(html).not.toContain('Includes care for your');
  });

  test('omits the bullet when there are no palms at all', () => {
    const html = renderPage('ts-ssr-none', treeShrubSsrEstimate(), treeShrubSsrEstimateData({ palmCount: 0, evidence: 'service_line' }));
    expect(html).not.toContain('Includes care for your');
  });
});

describe('treeShrubPalmCountForEstData — quote-required mirror row does not shadow result.lineItems (Codex round 6)', () => {
  const pricedLine = { service: 'tree_shrub', palmCount: 4, palmCountSource: 'service_line' };
  const unpricedLine = { service: 'tree_shrub', palmCount: 4, palmCountSource: 'property', pricingKnobs: { perPalmAnnual: 0, minutesPerPalmVisit: 0 } };
  const mirror = { recurring: { services: [{ service: 'tree_shrub', name: 'Tree & Shrub', mo: 57.35 }] } };

  test('slim { service, name, mo } mirror falls through to the evidence-bearing lineItems', () => {
    expect(treeShrubPalmCountForEstData({ result: { ...mirror, lineItems: [pricedLine] } })).toBe(4);
  });

  test('the fallthrough still gates: unpriced lineItems evidence shows nothing', () => {
    expect(treeShrubPalmCountForEstData({ result: { ...mirror, lineItems: [unpricedLine] } })).toBeNull();
  });

  test('a recurring row WITH its own evidence stays the exclusive envelope (one-tap raw row)', () => {
    const estData = {
      result: {
        recurring: { services: [{ ...unpricedLine }] },
        lineItems: [pricedLine],
      },
    };
    expect(treeShrubPalmCountForEstData(estData)).toBeNull();
  });
});

describe('stampedTreeShrubPalmCountInBundle — fast-path fallback to an already-stamped count (Codex round 7)', () => {
  const { stampedTreeShrubPalmCountInBundle } = require('../routes/estimate-public');

  test('reads a stamped count off a top-level T&S treatment row', () => {
    const bundle = { frequencies: [{ perServiceTreatments: [{ service: 'tree_shrub', palmCount: 4 }] }] };
    expect(stampedTreeShrubPalmCountInBundle(bundle)).toBe(4);
  });

  test('reads a stamped count off a rowless split T&S card in services[]', () => {
    const bundle = { services: [{ key: 'tree_shrub', frequencies: [{ key: 'standard', palmCount: 3 }] }] };
    expect(stampedTreeShrubPalmCountInBundle(bundle)).toBe(3);
  });

  test('reads a stamped count off serviceCadenceCombos rows', () => {
    const bundle = { serviceCadenceCombos: [{ perServiceTreatments: [{ service: 'tree_shrub', palmCount: 2 }] }] };
    expect(stampedTreeShrubPalmCountInBundle(bundle)).toBe(2);
  });

  test('ignores non-T&S rows and invalid counts', () => {
    const bundle = { frequencies: [{ perServiceTreatments: [
      { service: 'pest_control', palmCount: 9 },
      { service: 'tree_shrub', palmCount: 0 },
    ] }] };
    expect(stampedTreeShrubPalmCountInBundle(bundle)).toBeNull();
    expect(stampedTreeShrubPalmCountInBundle(null)).toBeNull();
  });
});

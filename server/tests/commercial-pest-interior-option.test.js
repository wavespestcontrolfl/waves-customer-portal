/**
 * Commercial pest interior-service option (owner 2026-08-17): the cost
 * buildup is split into an exterior base (perimeter barrier + monitoring,
 * carrying overhead/drive/admin) and a footprint-driven interior component.
 * Interior is ON by default and the combined price is cent-identical to the
 * pre-split single buildup; the customer removes/adds it on the public page
 * via PUT /:token/interior-service (bond-switcher architecture, dark behind
 * GATE_COMMERCIAL_INTERIOR_OPTION).
 */

const {
  priceCommercialPest,
} = require('../services/pricing-engine/service-pricing');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');

describe('priceCommercialPest — exterior/interior component split', () => {
  test('combined (interior-on default) is cent-identical to the pre-split goldens', () => {
    // These are the pre-split golden anchors from pricing-commercial-auto-price
    // — the component decomposition must reproduce them exactly.
    expect(priceCommercialPest({ footprint: 3000, perimeter: 220 }).annual).toBe(1424.73);
    expect(priceCommercialPest({ footprint: 10000, perimeter: 400 }).annual).toBe(2280);
    expect(priceCommercialPest({ footprint: 20000, perimeter: 600 }).annual).toBe(3472.73);
  });

  test('worked example (5,000 sqft, quarterly): exterior ~$465, interior +~$239, combined ~$704', () => {
    const r = priceCommercialPest({ footprint: 5000, perimeter: 283 }, { pestVisits: 4 });
    expect(r.annual).toBeCloseTo(703.78, 2);
    expect(r.perApp).toBeCloseTo(175.95, 2);
    expect(r.interiorOption.exteriorOnly.annual).toBeCloseTo(464.99, 2);
    expect(r.interiorOption.exteriorOnly.perApp).toBeCloseTo(116.25, 2);
    expect(r.interiorOption.annualAdd).toBeCloseTo(238.79, 2);
    expect(r.interiorOption.perAppAdd).toBeCloseTo(59.7, 2);
  });

  test('snapshot arithmetic is exact: exteriorOnly + add === combined, per figure', () => {
    for (const fixture of [
      [{ footprint: 3000, perimeter: 220 }, {}],
      [{ footprint: 5000, perimeter: 283 }, { pestVisits: 4 }],
      [{ footprint: 20000, perimeter: 600 }, { pestVisits: 6 }],
    ]) {
      const io = priceCommercialPest(fixture[0], fixture[1]).interiorOption;
      expect(io.exteriorOnly.annual + io.annualAdd).toBeCloseTo(io.combined.annual, 10);
      expect(io.exteriorOnly.monthly + io.monthlyAdd).toBeCloseTo(io.combined.monthly, 10);
      expect(io.exteriorOnly.perApp + io.perAppAdd).toBeCloseTo(io.combined.perApp, 10);
    }
  });

  test('interiorService: "excluded" prices the exterior-only base and flags the snapshot', () => {
    const r = priceCommercialPest({ footprint: 5000, perimeter: 283 }, { pestVisits: 4, interiorService: 'excluded' });
    expect(r.annual).toBeCloseTo(464.99, 2);
    expect(r.monthly).toBe(r.interiorOption.exteriorOnly.monthly);
    expect(r.perApp).toBe(r.interiorOption.exteriorOnly.perApp);
    expect(r.interiorOption.selected).toBe(false);
    // Snapshot still carries both variants so the customer can add interior back.
    expect(r.interiorOption.combined.annual).toBeCloseTo(703.78, 2);
  });

  test('only the explicit "excluded" sentinel deselects — anything else keeps interior', () => {
    for (const value of [undefined, null, '', 'included', 'nonsense']) {
      const r = priceCommercialPest({ footprint: 5000, perimeter: 283 }, { interiorService: value });
      expect(r.interiorOption.selected).toBe(true);
      expect(r.annual).toBe(r.interiorOption.combined.annual);
    }
  });

  test('headline figures track the SELECTED scope: onSiteMin, costs, margin', () => {
    const on = priceCommercialPest({ footprint: 5000, perimeter: 283 });
    const off = priceCommercialPest({ footprint: 5000, perimeter: 283 }, { interiorService: 'excluded' });
    // Interior adds footprint-driven treatment time — the tech-time comparison
    // consumers (pricing-reality-check, estimate-actuals) must see the sold scope.
    expect(on.onSiteMin).toBeGreaterThan(off.onSiteMin);
    expect(on.onSiteMin).toBe(on.interiorOption.combined.onSiteMin);
    expect(off.onSiteMin).toBe(off.interiorOption.exteriorOnly.onSiteMin);
    expect(on.costs.total).toBeGreaterThan(off.costs.total);
    expect(off.costs.total).toBe(off.costs.componentCosts.exteriorAnnualCost);
    // Both scopes hold the 45% target margin.
    expect(on.margin).toBeCloseTo(0.45, 2);
    expect(off.margin).toBeCloseTo(0.45, 2);
    // Scope reads in the customer-facing detail line.
    expect(on.detail).toMatch(/interior service \+ exterior barrier/i);
    expect(off.detail).toMatch(/exterior barrier \+ monitoring; interior service available/i);
  });

  test('missing building footprint falls to a manual quote when interior is selected', () => {
    const r = priceCommercialPest({ lotSqFt: 60000 }, {});
    expect(r.quoteRequired).toBe(true);
    expect(r.annual).toBeNull();
  });

  test('buildingSizeMeasured:false stays an absolute manual-quote override (synthetic wizard data)', () => {
    // A profile-computed perimeter can be derived from the same synthetic
    // building size the wizard flagged — never auto-price under it.
    const r = priceCommercialPest({ lotSqFt: 60000, perimeter: 283 }, { interiorService: 'excluded', buildingSizeMeasured: false });
    expect(r.quoteRequired).toBe(true);
    expect(r.annual).toBeNull();
  });

  test('exterior-only with an explicit measured perimeter auto-prices without a footprint (r3 P2)', () => {
    const r = priceCommercialPest({ lotSqFt: 60000, perimeter: 283 }, { pestVisits: 4, interiorService: 'excluded' });
    expect(r.quoteRequired).toBe(false);
    // Exterior buildup never reads the footprint — same price as the
    // 5,000 sqft fixture's exterior variant (perimeter 283 both).
    expect(r.annual).toBeCloseTo(464.99, 2);
    // No snapshot: the interior component would price off the 2,000 sqft
    // fallback, so the toggle must not offer it.
    expect(r.interiorOption).toBeNull();
    // The sold-scope marker survives snapshot-less pricing — acceptance
    // reads it for the tech EXTERIOR ONLY preference (r4 P1).
    expect(r.interiorScope).toBe('excluded');
    expect(r.pricingConfidence).toBe('LOW');
    expect(r.footprintEstimated).toBe(true);
  });

  test('every priced line carries the sold-scope marker', () => {
    expect(priceCommercialPest({ footprint: 5000, perimeter: 283 }).interiorScope).toBe('included');
    expect(priceCommercialPest({ footprint: 5000, perimeter: 283 }, { interiorService: 'excluded' }).interiorScope).toBe('excluded');
  });
});

// The V2 estimator (and the public re-price path) reach the engine through
// translateV2CallToV1Input, which whitelists fields — a dropped field is
// silently discarded before pricing, and a replay missing it would silently
// resurrect the interior charge (the bond switcher's codex #2915 r4 lesson).
describe('estimator adapter forwards commercialInteriorService', () => {
  const commercialProfile = {
    address: '100 Interior Test Blvd',
    propertyType: 'Commercial',
    isCommercial: true,
    homeSqFt: 3000,
    lotSqFt: 8000,
    stories: 1,
  };
  const pestLine = (profile, options) => generateEstimate(
    translateV2CallToV1Input(profile, ['PEST'], options)
  ).lineItems.find((l) => l.service === 'commercial_pest');

  test('options-set exclusion reaches the engine', () => {
    const line = pestLine(commercialProfile, { commercialInteriorService: 'excluded' });
    expect(line.annual).toBe(954.04);
    expect(line.interiorOption.selected).toBe(false);
  });

  test('profile-persisted exclusion replays on re-price', () => {
    expect(pestLine({ ...commercialProfile, commercialInteriorService: 'excluded' }, {}).annual).toBe(954.04);
  });

  test('default (unset) keeps interior included', () => {
    const line = pestLine(commercialProfile, {});
    expect(line.annual).toBe(1452.22);
    expect(line.interiorOption.selected).toBe(true);
  });

  test('residential profile clears the field (never leaks into residential pricing)', () => {
    const input = translateV2CallToV1Input(
      { ...commercialProfile, propertyType: 'Single Family', isCommercial: false },
      ['PEST'],
      { isCommercial: 'NO', commercialInteriorService: 'excluded' }
    );
    expect(input.commercialInteriorService).toBe(null);
  });
});

describe('v1-legacy-mapper carries the interiorOption snapshot', () => {
  const commercialProfile = {
    address: '100 Interior Test Blvd',
    propertyType: 'Commercial',
    isCommercial: true,
    homeSqFt: 3000,
    lotSqFt: 8000,
    stories: 1,
  };

  test('mapped commercial_pest row keeps figures + snapshot', () => {
    const mapped = mapV1ToLegacyShape(generateEstimate(translateV2CallToV1Input(commercialProfile, ['PEST'], {})));
    const row = mapped.recurring.services.find((svc) => svc.service === 'commercial_pest');
    expect(row).toMatchObject({ mo: 121.02, annual: 1452.22, perTreatment: 121.02 });
    expect(row.interiorOption).toMatchObject({
      selected: true,
      annualAdd: 498.18,
      monthlyAdd: 41.52,
      perAppAdd: 41.52,
    });
    expect(row.interiorOption.exteriorOnly).toMatchObject({ annual: 954.04, monthly: 79.5, perApp: 79.5 });
  });
});

describe('interior-service switcher rewrite (estimate-public)', () => {
  const {
    applySelectedCommercialInteriorToEstimateData,
    commercialInteriorOptionFromEstimateData,
    commercialInteriorExcludedFromEstimateData,
    attachCommercialInteriorSelector,
  } = require('../routes/estimate-public');

  const commercialProfile = {
    address: '100 Interior Test Blvd',
    propertyType: 'Commercial',
    isCommercial: true,
    homeSqFt: 3000,
    lotSqFt: 8000,
    stories: 1,
  };

  function interiorEstimateData(options = {}) {
    const engineRequest = { profile: commercialProfile, selectedServices: ['PEST'], options: { ...options } };
    const v1Input = translateV2CallToV1Input(commercialProfile, ['PEST'], options);
    const estimate = generateEstimate(v1Input);
    const mapped = mapV1ToLegacyShape(estimate);
    return {
      inputs: { svcPest: true, commercialInteriorService: options.commercialInteriorService || '' },
      engineRequest,
      result: mapped,
    };
  }

  test('toggle OFF rewrites the row to exterior-only and adjusts totals by the exact deltas', () => {
    const parsed = interiorEstimateData();
    const before = parsed.result.recurring.monthlyTotal;
    const outcome = applySelectedCommercialInteriorToEstimateData(parsed, false);
    expect(outcome).toMatchObject({ ok: true, changed: true, interiorSelected: false });
    expect(outcome.monthlyDelta).toBeCloseTo(-41.52, 2);
    expect(outcome.annualDelta).toBeCloseTo(-498.18, 2);
    const row = parsed.result.recurring.services.find((svc) => svc.service === 'commercial_pest');
    expect(row.mo).toBe(79.5);
    expect(row.monthly).toBe(79.5);
    expect(row.annual).toBe(954.04);
    expect(row.perTreatment).toBe(79.5);
    expect(row.interiorOption.selected).toBe(false);
    // Scope description follows the sold scope (codex #3432 r2 P1).
    expect(row.detail).toMatch(/exterior barrier \+ monitoring; interior service available/i);
    expect(parsed.result.recurring.monthlyTotal).toBeCloseTo(before - 41.52, 2);
    expect(parsed.result.totals.year1).toBe(954.04);
    expect(parsed.result.totals.year2mo).toBe(79.5);
  });

  test('toggle back ON restores the combined figures exactly (no drift across round trips)', () => {
    const parsed = interiorEstimateData();
    applySelectedCommercialInteriorToEstimateData(parsed, false);
    const outcome = applySelectedCommercialInteriorToEstimateData(parsed, true);
    expect(outcome).toMatchObject({ ok: true, changed: true, interiorSelected: true });
    const row = parsed.result.recurring.services.find((svc) => svc.service === 'commercial_pest');
    expect(row.mo).toBe(121.02);
    expect(row.annual).toBe(1452.22);
    expect(row.detail).toMatch(/interior service \+ exterior barrier \+ monitoring/i);
    expect(parsed.result.recurring.monthlyTotal).toBe(121.02);
    expect(parsed.result.totals.year1).toBe(1452.22);
  });

  test('replay-resurrection guard: the toggle syncs every replayable input shape', () => {
    const parsed = interiorEstimateData();
    applySelectedCommercialInteriorToEstimateData(parsed, false);
    // V2/admin saves replay engineRequest through translateV2CallToV1Input —
    // the synced option must reproduce the toggled price on a live re-price.
    expect(parsed.engineRequest.options.commercialInteriorService).toBe('excluded');
    const replayed = generateEstimate(translateV2CallToV1Input(
      parsed.engineRequest.profile,
      parsed.engineRequest.selectedServices,
      parsed.engineRequest.options,
    ));
    expect(replayed.lineItems.find((l) => l.service === 'commercial_pest').annual).toBe(954.04);
    // The V1 admin form field stays in sync when present.
    expect(parsed.inputs.commercialInteriorService).toBe('excluded');
    // And back on.
    applySelectedCommercialInteriorToEstimateData(parsed, true);
    expect(parsed.engineRequest.options.commercialInteriorService).toBe('included');
  });

  test('engineRequest WITHOUT an options object gets one created (replay reads req.options only)', () => {
    // codex #3432 r1 P1: serverRecomputeFromEstimateData replays req.profile
    // + req.options || {} — a top-level write on the request is invisible, so
    // a later authoritative reprice would restore the interior charge.
    const parsed = interiorEstimateData();
    delete parsed.engineRequest.options;
    applySelectedCommercialInteriorToEstimateData(parsed, false);
    expect(parsed.engineRequest.options).toEqual({ commercialInteriorService: 'excluded' });
    const replayed = generateEstimate(translateV2CallToV1Input(
      parsed.engineRequest.profile,
      parsed.engineRequest.selectedServices,
      parsed.engineRequest.options,
    ));
    expect(replayed.lineItems.find((l) => l.service === 'commercial_pest').annual).toBe(954.04);
  });

  test('raw engine payloads (no mapped recurring lists) rewrite the line item + summary', () => {
    const engineResult = generateEstimate(translateV2CallToV1Input(commercialProfile, ['PEST'], {}));
    const parsed = { engineInputs: translateV2CallToV1Input(commercialProfile, ['PEST'], {}), engineResult };
    const outcome = applySelectedCommercialInteriorToEstimateData(parsed, false);
    expect(outcome).toMatchObject({ ok: true, interiorSelected: false });
    const line = engineResult.lineItems.find((l) => l.service === 'commercial_pest');
    expect(line.annual).toBe(954.04);
    expect(line.perApp).toBe(79.5);
    expect(line.internalPerVisitRevenue).toBe(79.5);
    expect(engineResult.summary.recurringAnnualAfterDiscount).toBe(954.04);
    expect(engineResult.summary.year2Monthly).toBe(79.5);
    // Flat engine-input shape synced too.
    expect(parsed.engineInputs.commercialInteriorService).toBe('excluded');
  });

  test('raw engine lines get their discounted mirrors rewritten too (r4 P1)', () => {
    // The converter's recurringLineAnnualAmount PREFERS annualAfterDiscount —
    // a stale combined value there would tax-share the prepay off the old
    // interior-inclusive amount after an exterior-only toggle.
    const engineResult = generateEstimate(translateV2CallToV1Input(commercialProfile, ['PEST'], {}));
    const line = engineResult.lineItems.find((l) => l.service === 'commercial_pest');
    line.annualAfterDiscount = line.annual;
    line.annualBeforeDiscount = line.annual;
    line.monthlyAfterDiscount = line.monthly;
    const parsed = { engineInputs: translateV2CallToV1Input(commercialProfile, ['PEST'], {}), engineResult };
    applySelectedCommercialInteriorToEstimateData(parsed, false);
    expect(line.annual).toBe(954.04);
    expect(line.annualAfterDiscount).toBe(954.04);
    expect(line.annualBeforeDiscount).toBe(954.04);
    expect(line.monthlyAfterDiscount).toBe(79.5);
    expect(line.interiorScope).toBe('excluded');
  });

  test('sold-scope read: snapshot selection, scope marker, and included states (r4 P1)', () => {
    // Snapshot path: toggle off → excluded.
    const parsed = interiorEstimateData();
    expect(commercialInteriorExcludedFromEstimateData(parsed)).toBe(false);
    applySelectedCommercialInteriorToEstimateData(parsed, false);
    expect(commercialInteriorExcludedFromEstimateData(parsed)).toBe(true);
    // Snapshot-less path (exterior-only priced off an explicit perimeter):
    // the marker alone carries the sold scope.
    const engineResult = generateEstimate(translateV2CallToV1Input(
      { ...commercialProfile, homeSqFt: null, perimeterLF: 283 },
      ['PEST'],
      { commercialInteriorService: 'excluded' },
    ));
    const line = engineResult.lineItems.find((l) => l.service === 'commercial_pest');
    expect(line.interiorOption).toBeNull();
    expect(commercialInteriorExcludedFromEstimateData({ engineResult })).toBe(true);
  });

  test('fails closed when no snapshot exists (pre-split estimates)', () => {
    const legacy = { result: { recurring: { services: [{ name: 'Commercial Pest Control', service: 'commercial_pest', mo: 190, annual: 2280 }] } } };
    expect(applySelectedCommercialInteriorToEstimateData(legacy, false))
      .toMatchObject({ ok: false, reason: 'interior_option_not_available' });
    expect(commercialInteriorOptionFromEstimateData(legacy)).toBeNull();
  });

  test('selector attaches to the commercial_pest section only when the gate is on', () => {
    const parsed = interiorEstimateData();
    const services = [{ key: 'commercial_pest', frequencies: [] }];
    delete process.env.GATE_COMMERCIAL_INTERIOR_OPTION;
    attachCommercialInteriorSelector(services, parsed);
    expect(services[0].interiorOption).toBeUndefined();
    process.env.GATE_COMMERCIAL_INTERIOR_OPTION = 'true';
    try {
      attachCommercialInteriorSelector(services, parsed);
      expect(services[0].interiorOption).toMatchObject({
        selected: true,
        perApplicationAdd: 41.52,
        monthlyAdd: 41.52,
        annualAdd: 498.18,
      });
      // After a toggle-off the selector reflects the stored selection.
      applySelectedCommercialInteriorToEstimateData(parsed, false);
      const services2 = [{ key: 'commercial_pest', frequencies: [] }];
      attachCommercialInteriorSelector(services2, parsed);
      expect(services2[0].interiorOption.selected).toBe(false);
    } finally {
      delete process.env.GATE_COMMERCIAL_INTERIOR_OPTION;
    }
  });

  test('no commercial section → attach is a no-op', () => {
    process.env.GATE_COMMERCIAL_INTERIOR_OPTION = 'true';
    try {
      const services = [{ key: 'pest_control', frequencies: [] }];
      attachCommercialInteriorSelector(services, interiorEstimateData());
      expect(services[0].interiorOption).toBeUndefined();
    } finally {
      delete process.env.GATE_COMMERCIAL_INTERIOR_OPTION;
    }
  });

  test('authored proposals never expose the selector — proposal itemization is the quote', () => {
    // codex #3432 r2 P1: a promoted estimate retains its engine rows (and
    // their interiorOption), but the authored proposal is the billed price.
    process.env.GATE_COMMERCIAL_INTERIOR_OPTION = 'true';
    try {
      const parsed = { ...interiorEstimateData(), proposal: { enabled: true } };
      const services = [{ key: 'commercial_pest', frequencies: [] }];
      attachCommercialInteriorSelector(services, parsed);
      expect(services[0].interiorOption).toBeUndefined();
    } finally {
      delete process.env.GATE_COMMERCIAL_INTERIOR_OPTION;
    }
  });
});

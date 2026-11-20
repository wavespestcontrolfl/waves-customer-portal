// Rodent exclusion roof style (GATE_EXCLUSION_ROOF_STYLE_PRICING, owner 2026-11-19 choice 2A): the technician's one-tap
// roof style multiplies the roof/high points on a tile roof and a barrel tile roof adds an eave closure line.
// Gate off, or no pick, must stay exactly as it was.
const {
  generateEstimate,
  priceRodentExclusionV2,
} = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { normalizeOneTimeBreakdown, extractEngineInputs } = require('../routes/estimate-public');
const { exclusionRoofStylePricingLive } = require('../config/feature-gates');
const { RODENT } = require('../services/pricing-engine/constants');
const { roofStyleReplaySignal } = require('../services/estimate-roof-style-replay');
const { sanitizeClientIdentityFields } = require('../services/estimate-client-identity-fields');

function withGate(value, fn) {
  const prior = process.env.GATE_EXCLUSION_ROOF_STYLE_PRICING;
  if (value === undefined) delete process.env.GATE_EXCLUSION_ROOF_STYLE_PRICING;
  else process.env.GATE_EXCLUSION_ROOF_STYLE_PRICING = value;
  try { return fn(); } finally {
    if (prior === undefined) delete process.env.GATE_EXCLUSION_ROOF_STYLE_PRICING;
    else process.env.GATE_EXCLUSION_ROOF_STYLE_PRICING = prior;
  }
}
const gateOn = (fn) => withGate('true', fn);

const POINTS = {
  standardWireMeshPoints: 1, advancedWireMeshPoints: 2, standardBirdBoxes: 1, tileHighBirdBoxes: 1, meshSoftLF: 10, waiveInspection: true,
};
const baseInput = (overrides = {}) => ({
  homeSqFt: 2000, stories: 1, lotSqFt: 10000, propertyType: 'single_family', zone: 'A',
  features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
  ...overrides,
});
const exclusion = (extra = {}) => ({ pricingVersion: 'v2', ...POINTS, ...extra });
const rowsOf = (estimate) => estimate.lineItems.filter((li) => li.service === 'rodent_exclusion');
const total = (estimate) => rowsOf(estimate).reduce((sum, li) => sum + li.price, 0);
const component = (result, name) => result.lineItems.find((li) => li.component === name);

describe('GATE_EXCLUSION_ROOF_STYLE_PRICING reader', () => {
  test('reads at call time and only for exactly true', () => {
    expect(withGate(undefined, exclusionRoofStylePricingLive)).toBe(false);
    expect(withGate('1', exclusionRoofStylePricingLive)).toBe(false);
    expect(withGate('TRUE', exclusionRoofStylePricingLive)).toBe(false);
    expect(withGate('true', exclusionRoofStylePricingLive)).toBe(true);
  });
});

describe('priceRodentExclusionV2 roof style', () => {
  const none = priceRodentExclusionV2(POINTS);

  test('no pick: the same result object, and no new keys', () => {
    expect(priceRodentExclusionV2({ ...POINTS, roofStyle: undefined, barrelEaveFt: 40 })).toEqual(none);
    expect(none.price).toBe(875);
    expect(JSON.stringify(none)).not.toMatch(/roofStyle|barrel/i);
  });

  test('any tile roof multiplies the roof/high points by 1.25 and nothing else', () => {
    for (const roofStyle of ['flat_tile', 'barrel_tile']) {
      const tile = priceRodentExclusionV2({ ...POINTS, roofStyle });
      expect(component(tile, 'wire_mesh_points').price).toBe(75 + 2 * 150 * 1.25);
      // Bird boxes (their own tile tier), linear mesh and ground (standard) points are untouched.
      expect(component(tile, 'bird_boxes').price).toBe(component(none, 'bird_boxes').price);
      expect(component(tile, 'linear_mesh').price).toBe(component(none, 'linear_mesh').price);
      expect(tile.price).toBe(none.price + 2 * 150 * 0.25);
    }
  });

  test('flat tile gets no closure line, even when feet are posted', () => {
    const flat = priceRodentExclusionV2({ ...POINTS, roofStyle: 'flat_tile', barrelEaveFt: 60 });
    expect(component(flat, 'barrel_eave_closure')).toBeUndefined();
    expect(flat.price).toBe(none.price + 75);
  });

  test('shingle, metal and other price as with no pick', () => {
    for (const roofStyle of ['shingle', 'metal', 'other']) {
      const result = priceRodentExclusionV2({ ...POINTS, roofStyle, barrelEaveFt: 60 });
      expect(result.price).toBe(none.price);
      expect(result.lineItems.map((li) => [li.component, li.price])).toEqual(none.lineItems.map((li) => [li.component, li.price]));
    }
  });

  test('barrel closure is $12 per foot with a $395 minimum for the line', () => {
    const at = (barrelEaveFt) => priceRodentExclusionV2({ ...POINTS, roofStyle: 'barrel_tile', barrelEaveFt });
    expect(component(at(40), 'barrel_eave_closure')).toMatchObject({ price: 480, label: 'Barrel tile eave closure (40 ft)' });
    expect(component(at(20), 'barrel_eave_closure').price).toBe(395);
    expect(component(at(33), 'barrel_eave_closure').price).toBe(396);
    expect(at(40).price).toBe(none.price + 75 + 480);
    // Rows still sum to the price the pricer charges.
    expect(at(40).lineItems.reduce((sum, li) => sum + li.price, 0)).toBe(at(40).price);
  });

  test('the closure row is exact; the rounding remainder goes to a non-closure row and rows sum to the price', () => {
    for (const points of [1, 3, 5]) {
      const result = priceRodentExclusionV2({ advancedWireMeshPoints: points, roofStyle: 'barrel_tile', barrelEaveFt: 40, waiveInspection: true });
      expect(component(result, 'barrel_eave_closure').price).toBe(480);
      expect(result.lineItems.reduce((sum, li) => sum + li.price, 0)).toBe(result.price);
    }
    const odd = priceRodentExclusionV2({ advancedWireMeshPoints: 1, roofStyle: 'barrel_tile', barrelEaveFt: 40, waiveInspection: true });
    expect(odd.price).toBe(668);
    expect(component(odd, 'wire_mesh_points').price).toBe(188);
    // Closure only, and a fractional measurement: a whole-dollar closure, nothing to reconcile.
    const only = priceRodentExclusionV2({ roofStyle: 'barrel_tile', barrelEaveFt: 33.3, waiveInspection: true });
    expect(component(only, 'barrel_eave_closure').price).toBe(400);
    expect(only.lineItems.reduce((sum, li) => sum + li.price, 0)).toBe(only.price);
  });

  test('zero, empty or bad feet add no closure line and say it needs a measurement', () => {
    for (const barrelEaveFt of [0, '', undefined, null, -5, 'abc']) {
      const result = priceRodentExclusionV2({ ...POINTS, roofStyle: 'barrel_tile', barrelEaveFt });
      expect(component(result, 'barrel_eave_closure')).toBeUndefined();
      expect(result.barrelClosureNeedsMeasurement).toBe(true);
      expect(result.price).toBe(none.price + 75);
    }
    expect(priceRodentExclusionV2({ ...POINTS, roofStyle: 'barrel_tile', barrelEaveFt: 30 }).barrelClosureNeedsMeasurement).toBeUndefined();
  });

  test('a barrel closure alone (no points) still quotes its line', () => {
    const result = priceRodentExclusionV2({ roofStyle: 'barrel_tile', barrelEaveFt: 50, waiveInspection: true });
    expect(component(result, 'barrel_eave_closure').price).toBe(600);
    expect(result.price).toBe(600);
  });
});

describe('estimate engine with a roof style', () => {
  const price = (extra, input = {}) => generateEstimate(baseInput({ services: { exclusion: exclusion(extra) }, ...input }));
  const error = (fn) => { try { fn(); } catch (err) { return err; } return null; };

  test('gate off: a request with no pick is byte-identical, whatever else it carries', () => {
    const stable = (estimate) => ({ ...estimate, generatedAt: undefined });
    const plain = stable(withGate(undefined, () => price({})));
    for (const extra of [{ roofStyle: undefined }, { roofStyle: null }, { roofStyle: '' }, { barrelEaveFt: 40 }]) {
      expect(stable(withGate(undefined, () => price(extra)))).toEqual(plain);
    }
    expect(JSON.stringify(plain)).not.toMatch(/roofStyle|barrel/i);
  });

  test('gate off: a new request with a roof style is refused (fail closed), never priced as no pick', () => {
    withGate(undefined, () => {
      for (const roofStyle of ['shingle', 'flat_tile', 'barrel_tile', 'metal', 'other']) {
        expect(error(() => price({ roofStyle, barrelEaveFt: 40 }))).toMatchObject({
          statusCode: 400, code: 'EXCLUSION_ROOF_STYLE_GATED', failClosed: true, isOperational: true,
        });
      }
    });
  });

  test('gate on: tile x1.25 on roof/high points, barrel closure, through the engine', () => {
    gateOn(() => {
      const base = price({});
      expect(total(price({ roofStyle: 'flat_tile' }))).toBe(total(base) + 75);
      expect(total(price({ roofStyle: 'barrel_tile', barrelEaveFt: 40 }))).toBe(total(base) + 75 + 480);
      expect(total(price({ roofStyle: 'barrel_tile', barrelEaveFt: 0 }))).toBe(total(base) + 75);
      expect(total(price({ roofStyle: 'metal' }))).toBe(total(base));
      const barrel = rowsOf(price({ roofStyle: 'barrel_tile', barrelEaveFt: 40 })).find((li) => li.component === 'barrel_eave_closure');
      expect(barrel).toMatchObject({ service: 'rodent_exclusion', price: 480, label: 'Barrel tile eave closure (40 ft)' });
    });
  });

  test('gate on: a style outside the five choices and a non-v2 shape are refused', () => {
    gateOn(() => {
      expect(error(() => price({ roofStyle: 'slate' }))).toMatchObject({ statusCode: 400, code: 'EXCLUSION_ROOF_STYLE_INVALID' });
      // A legacy shape with a pick is not refused by itself; measured barrel feet on a non-V2 request need counts.
      expect(error(() => generateEstimate(baseInput({ services: { exclusion: { simple: 1, roofStyle: 'flat_tile' } } })))).toBeNull();
      const legacyFeet = () => generateEstimate(baseInput({ services: { exclusion: { simple: 1, roofStyle: 'barrel_tile', barrelEaveFt: 40 } } }));
      expect(error(legacyFeet)).toMatchObject({ statusCode: 400, code: 'EXCLUSION_ROOF_STYLE_NEEDS_COUNTS', failClosed: true, isOperational: true });
    });
    // The gate decision comes first and covers every shape: off, a legacy request with a pick gets the gated error.
    withGate(undefined, () => {
      for (const exclusionInput of [{ simple: 1, roofStyle: 'flat_tile' }, { roofStyle: 'shingle' }]) {
        expect(error(() => generateEstimate(baseInput({ services: { exclusion: exclusionInput } })))).toMatchObject({ code: 'EXCLUSION_ROOF_STYLE_GATED' });
      }
    });
  });

  test('commercial property stays a manual quote, even with the commercial scoped one-time gate on and counted points', () => {
    const priorScoped = process.env.GATE_COMMERCIAL_ONETIME_SCOPED;
    process.env.GATE_COMMERCIAL_ONETIME_SCOPED = 'true';
    try {
      gateOn(() => {
        const commercial = (extra) => generateEstimate(baseInput({
          propertyType: 'commercial',
          services: { exclusion: { pricingVersion: 'v2', waiveInspection: true, ...extra } },
        }));
        const firm = (estimate) => estimate.lineItems.some((li) => li.service === 'rodent_exclusion' && li.price > 0);
        // Control: with the scoped gate on, counted points and no pick still auto-price (today's behavior).
        expect(firm(commercial({ advancedWireMeshPoints: 1 }))).toBe(true);
        // Feet with no counted points are refused outright (NEEDS_COUNTS), never a firm closure-only price.
        expect(() => commercial({ roofStyle: 'barrel_tile', barrelEaveFt: 80 })).toThrow(/Count the entry points/);
        // Any pick with counted points goes to the manual quote.
        for (const extra of [
          { roofStyle: 'barrel_tile', barrelEaveFt: 40, advancedWireMeshPoints: 1 },
          { roofStyle: 'flat_tile', advancedWireMeshPoints: 3, standardBirdBoxes: 1 },
          { roofStyle: 'shingle', advancedWireMeshPoints: 1 },
        ]) expect([extra, firm(commercial(extra))]).toEqual([extra, false]);
      });
    } finally {
      if (priorScoped === undefined) delete process.env.GATE_COMMERCIAL_ONETIME_SCOPED;
      else process.env.GATE_COMMERCIAL_ONETIME_SCOPED = priorScoped;
    }
  });

  test('whole-home seal and roof style combine: the home minimum is the floor of the same rows', () => {
    const sealed = gateOn(() => withGateBoth(() => price({ sealScope: 'whole_home', roofStyle: 'flat_tile' })));
    expect(rowsOf(sealed).every((li) => li.includesReentryGuarantee === true)).toBe(true);
    expect(total(sealed)).toBeGreaterThanOrEqual(595);
  });
});

function withGateBoth(fn) {
  const prior = process.env.GATE_EXCLUSION_WHOLE_HOME;
  process.env.GATE_EXCLUSION_WHOLE_HOME = 'true';
  try { return fn(); } finally {
    if (prior === undefined) delete process.env.GATE_EXCLUSION_WHOLE_HOME;
    else process.env.GATE_EXCLUSION_WHOLE_HOME = prior;
  }
}

describe('the estimator route translation of the roof style pick', () => {
  const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
  const profile = { homeSqFt: 2000, stories: 1, lotSqFt: 9000, propertyType: 'single_family' };
  const translate = (options) => translateV2CallToV1Input(profile, ['EXCLUSION'], { exclAdvancedWireMesh: 2, ...options });

  test('the pick passes through and the route reads no gate (the engine refuses it when the gate is off)', () => {
    withGate(undefined, () => {
      expect(translate({ exclRoofStyle: 'barrel_tile', exclBarrelEaveFt: '40' }).services.exclusion)
        .toMatchObject({ pricingVersion: 'v2', roofStyle: 'barrel_tile', barrelEaveFt: 40 });
      expect(() => generateEstimate(translate({ exclRoofStyle: 'flat_tile' }))).toThrow(/Clear the roof style/);
    });
  });

  test('feet travel only with Barrel tile; no pick reads nothing', () => {
    expect(translate({ exclRoofStyle: 'flat_tile', exclBarrelEaveFt: 40 }).services.exclusion.barrelEaveFt).toBeUndefined();
    const plain = translate({});
    expect(translate({ exclBarrelEaveFt: 40, exclRoofStyle: '' })).toEqual(plain);
    expect(plain.services.exclusion.roofStyle).toBeUndefined();
  });

  describe('the pick is always carried and never changes the shape', () => {
    const zero = (extra, services = ['EXCLUSION']) => translateV2CallToV1Input(profile, services, { exclWaiveInspection: true, ...extra });
    const exclTotal = (request) => generateEstimate(request).lineItems
      .filter((li) => ['exclusion', 'rodent_exclusion'].includes(li.service)).reduce((sum, li) => sum + li.price, 0);

    test('a pick on a zero-count request keeps the legacy shape and the same $595 line as no pick', () => {
      gateOn(() => {
        const noPick = zero({});
        expect(noPick.services.exclusion.pricingVersion).toBeUndefined();
        expect(exclTotal(noPick)).toBe(595);
        for (const exclRoofStyle of ['shingle', 'metal', 'other', 'flat_tile', 'barrel_tile']) {
          const request = zero({ exclRoofStyle });
          expect(request.services.exclusion).toMatchObject({ ...noPick.services.exclusion, roofStyle: exclRoofStyle });
          expect(request.services.exclusion.pricingVersion).toBeUndefined();
          expect(exclTotal(request)).toBe(595);
        }
      });
    });

    test('gate off + that pick is refused (GATED) on the legacy and the V2 shape alike', () => {
      withGate(undefined, () => {
        for (const exclRoofStyle of ['shingle', 'flat_tile', 'barrel_tile']) {
          expect(() => generateEstimate(zero({ exclRoofStyle }))).toThrow(/Clear the roof style/);
          expect(() => generateEstimate(translate({ exclRoofStyle }))).toThrow(/Clear the roof style/);
        }
      });
    });

    test('lookup shingle + confirmed Flat tile on a zero-count request: $595 exclusion line, $249 separate guarantee', () => {
      gateOn(() => {
        const eligible = { rgTrappingCompleted: true, rgExclusionCompleted: true, rgSanitationBaseline: true, rgNoActivityAfterFinalCheck: true };
        const priced = (extra) => {
          const request = zero({ ...eligible, ...extra }, ['EXCLUSION', 'RODENT_GUARANTEE']);
          return generateEstimate({ ...request, roofType: 'shingle' });
        };
        const base = priced({});
        const tile = priced({ exclRoofStyle: 'flat_tile' });
        expect(exclTotal({ ...zero({}), roofType: 'shingle' })).toBe(595);
        expect(base.lineItems.find((li) => li.service === 'rodent_guarantee').price).toBe(199);
        expect(tile.lineItems.find((li) => li.service === 'rodent_guarantee').price).toBe(249);
        expect(tile.lineItems.find((li) => li.service === 'exclusion').price).toBe(595);
      });
    });

    test('barrel feet on a request that is not V2-shaped are refused (NEEDS_COUNTS), never re-shaped to a lower price', () => {
      const feet = { exclRoofStyle: 'barrel_tile', exclBarrelEaveFt: 20 };
      gateOn(() => {
        // Zero counts: legacy shape exactly as without the pick; the engine refuses the feet with the tool's message.
        const request = zero(feet);
        expect(request.services.exclusion.pricingVersion).toBeUndefined();
        expect(request.services.exclusion).toMatchObject({ roofStyle: 'barrel_tile', barrelEaveFt: 20 });
        let error;
        try { generateEstimate(request); } catch (err) { error = err; }
        expect(error).toMatchObject({ statusCode: 400, code: 'EXCLUSION_ROOF_STYLE_NEEDS_COUNTS', failClosed: true, isOperational: true });
        expect(error.message).toBe('Count the entry points, or choose Whole home, before adding the barrel eave closure.');
        // Legacy counts, a standalone wire mesh or bird box selection: the shape is the same as without the pick.
        expect(zero({ ...feet, exclModerate: 2 }).services.exclusion.pricingVersion).toBeUndefined();
        expect(zero(feet, ['EXCLUSION', 'RODENT_WIRE_MESH']).services.exclusion.pricingVersion).toBeUndefined();
      });
      withGate(undefined, () => expect(() => generateEstimate(zero(feet))).toThrow(/Clear the roof style/));
    });

    test("the V2 shape alone is not priced work: '0', negative or NaN counts + feet are NEEDS_COUNTS; one real point + feet prices", () => {
      gateOn(() => {
        const withCounts = (counts) => generateEstimate(baseInput({
          services: { exclusion: { pricingVersion: 'v2', waiveInspection: true, roofStyle: 'barrel_tile', barrelEaveFt: 20, ...counts } },
        }));
        const error = (fn) => { try { fn(); } catch (err) { return err; } return null; };
        for (const counts of [{}, { standardWireMeshPoints: '0' }, { standardWireMeshPoints: -1 }, { advancedWireMeshPoints: NaN },
          { standardBirdBoxes: 'abc', meshSoftLF: -4, meshConcreteLF: Infinity }]) {
          expect([counts, error(() => withCounts(counts))]).toEqual([counts, expect.objectContaining({ code: 'EXCLUSION_ROOF_STYLE_NEEDS_COUNTS', statusCode: 400 })]);
        }
        const priced = withCounts({ standardWireMeshPoints: 1 });
        expect(rowsOf(priced).some((li) => li.component === 'barrel_eave_closure' && li.price === 395)).toBe(true);
        expect(total(withCounts({ standardWireMeshPoints: '2' }))).toBeGreaterThan(395);
      });
    });

    test('whole home with zero counts + feet is V2 and never lower than without the feet; V2 counts + feet add the closure row', () => {
      const bothGates = (fn) => gateOn(() => withGateBoth(fn));
      bothGates(() => {
        const wholeHome = (extra) => zero({ exclSealScope: 'whole_home', ...extra });
        const without = exclTotal(wholeHome({}));
        const withFeet = wholeHome({ exclRoofStyle: 'barrel_tile', exclBarrelEaveFt: 20 });
        expect(withFeet.services.exclusion.pricingVersion).toBe('v2');
        expect(exclTotal(withFeet)).toBeGreaterThanOrEqual(without);
        const counted = (extra) => translate({ exclWaiveInspection: true, ...extra });
        const base = exclTotal(counted({}));
        const closure = counted({ exclRoofStyle: 'barrel_tile', exclBarrelEaveFt: 20 });
        expect(rowsOf(generateEstimate(closure)).some((li) => li.component === 'barrel_eave_closure' && li.price === 395)).toBe(true);
        expect(exclTotal(closure)).toBeGreaterThanOrEqual(base);
      });
    });

    test('tile with roof/high points selects V2 and prices the multiplier', () => {
      gateOn(() => {
        const request = translate({ exclAdvancedWireMesh: 2, exclRoofStyle: 'flat_tile', exclWaiveInspection: true });
        expect(request.services.exclusion.pricingVersion).toBe('v2');
        expect(exclTotal(request)).toBe(exclTotal(translate({ exclAdvancedWireMesh: 2, exclWaiveInspection: true })) + 75);
      });
    });
  });

  test('gate off with NO pick: a zero-point request keeps the legacy shape, byte-identical to one that never mentions the field', () => {
    withGate(undefined, () => {
      const plain = translate({ exclAdvancedWireMesh: 0 });
      expect(plain.services.exclusion.pricingVersion).toBeUndefined();
      expect(translate({ exclAdvancedWireMesh: 0, exclRoofStyle: '', exclBarrelEaveFt: 40 })).toEqual(plain);
      expect(translate({ exclAdvancedWireMesh: 0, exclRoofStyle: null })).toEqual(plain);
      expect(() => generateEstimate(plain)).not.toThrow();
    });
  });
});

describe('the confirmed roof style sets the rodent guarantee tier', () => {
  const wholeHome = (extra = {}, input = {}) => generateEstimate(baseInput({
    roofType: 'shingle',
    services: { exclusion: { pricingVersion: 'v2', standardWireMeshPoints: 2, waiveInspection: true, sealScope: 'whole_home', ...extra } },
    ...input,
  }));
  const renewal = (estimate) => rowsOf(estimate)[0].guaranteeRenewalPrice;
  const both = (fn) => gateOn(() => withGateBoth(fn));

  test('lookup shingle + confirmed Flat tile = the tile tier ($249); other styles keep the standard tier ($199)', () => {
    both(() => {
      expect(renewal(wholeHome())).toBe(199);
      expect(renewal(wholeHome({ roofStyle: 'flat_tile' }))).toBe(249);
      expect(renewal(wholeHome({ roofStyle: 'barrel_tile', barrelEaveFt: 40 }))).toBe(249);
      for (const roofStyle of ['shingle', 'metal', 'other']) expect(renewal(wholeHome({ roofStyle }))).toBe(199);
      // The confirmed answer beats the lookup the other way too: a lookup tile roof confirmed Shingle is the standard tier.
      expect(renewal(wholeHome({ roofStyle: 'shingle' }, { roofType: 'tile' }))).toBe(199);
      expect(renewal(wholeHome({}, { roofType: 'tile' }))).toBe(249);
    });
  });

  test('a saved renewal stays frozen on replay, whatever the confirmed style says', () => {
    both(() => {
      const replay = generateEstimate({
        ...baseInput({ roofType: 'shingle', services: { exclusion: { pricingVersion: 'v2', standardWireMeshPoints: 2, waiveInspection: true, sealScope: 'whole_home', roofStyle: 'flat_tile' } } }),
        savedEstimateReplay: true,
        wholeHomeSealReplay: { minimum: 595, renewal: 199 },
      });
      expect(renewal(replay)).toBe(199);
    });
  });

  test('the separate paid guarantee line also reads the confirmed style', () => {
    gateOn(() => {
      const guarantee = (roofStyle) => generateEstimate(baseInput({
        roofType: 'shingle',
        services: {
          exclusion: { pricingVersion: 'v2', standardWireMeshPoints: 2, waiveInspection: true, ...(roofStyle ? { roofStyle } : {}) },
          rodentGuarantee: { eligibility: { trappingCompleted: true, exclusionCompleted: true, sanitationCompletedOrPhotoBaseline: true, noActivityAfterFinalTrapCheck: true } },
        },
      })).lineItems.find((li) => li.service === 'rodent_guarantee');
      expect(guarantee().price).toBe(199);
      expect(guarantee('flat_tile').price).toBe(249);
      expect(guarantee('metal').price).toBe(199);
    });
  });
});

describe('roof style terms are frozen on a saved estimate', () => {
  const request = () => baseInput({ services: { exclusion: exclusion({ roofStyle: 'barrel_tile', barrelEaveFt: 40 }) } });

  // Edits the constants the way a later code change would.
  function withConstantsChange(fn) {
    const cfg = RODENT.exclusionV2;
    const prior = [cfg.tileRoofMultiplier, cfg.barrelEaveClosure];
    cfg.tileRoofMultiplier = 1.5;
    cfg.barrelEaveClosure = { perFt: 20, minimum: 500 };
    try { return fn(); } finally { [cfg.tileRoofMultiplier, cfg.barrelEaveClosure] = prior; }
  }

  test('price, change the constants, replay with the gate off: same multiplier and per-foot rate', () => {
    gateOn(() => {
      const quoted = generateEstimate(request());
      const saved = { engineInputs: request(), result: mapV1ToLegacyShape(quoted) };
      withConstantsChange(() => {
        // A NEW quote after the change uses the new terms.
        expect(total(generateEstimate(request()))).toBeGreaterThan(total(quoted));
        for (const value of ['true', undefined]) {
          withGate(value, () => {
            const replayInputs = extractEngineInputs(saved);
            expect(replayInputs.roofStyleReplay).toEqual({ multiplier: 1.25, perFt: 12, minimum: 395 });
            expect(total(generateEstimate(replayInputs))).toBe(total(quoted));
          });
        }
      });
    });
  });

  test('a stored estimate re-priced as sold still prices its roof style after a rollback', () => {
    const quoted = gateOn(() => generateEstimate(request()));
    withGate(undefined, () => {
      const replayed = generateEstimate({ ...request(), savedEstimateReplay: true });
      expect(total(replayed)).toBe(total(quoted));
      expect(rowsOf(replayed).some((li) => li.component === 'barrel_eave_closure')).toBe(true);
    });
  });

  test('every saved shape yields the signal; a stale or foreign row yields none; an unstamped row replays live', () => {
    const quoted = gateOn(() => generateEstimate(request()));
    const mapped = mapV1ToLegacyShape(quoted);
    const rows = [...(mapped.oneTime.items || []), ...(mapped.oneTime.specItems || [])].filter((r) => r.service === 'rodent_exclusion');
    expect(rows.length).toBeGreaterThan(0);
    const expected = { multiplier: 1.25, perFt: 12, minimum: 395 };
    for (const saved of [
      { result: { oneTime: { items: rows } } },
      { result: { results: { oneTime: { specItems: rows } } } },
      { engineResult: { lineItems: rowsOf(quoted) } },
      { oneTime: { items: rows } },
    ]) expect(roofStyleReplaySignal(saved)).toEqual(expected);
    const plain = rows.map((r) => ({ service: r.service, label: r.label, price: r.price }));
    expect(roofStyleReplaySignal({ result: { oneTime: { items: plain } }, engineResult: { oneTime: { items: rows } } })).toBeNull();
    expect(roofStyleReplaySignal({ result: { oneTime: { items: rows.map((r) => ({ ...r, service: 'bed_bug' })) } } })).toBeNull();
    const unstamped = rows.map(({ barrelEavePerFt, barrelEaveMinimum, ...rest }) => rest);
    expect(roofStyleReplaySignal({ result: { oneTime: { items: unstamped } } })).toEqual({ multiplier: 1.25, perFt: null, minimum: null });
  });

  test('a posted roofStyleReplay is never honored on a new quote and is stripped from bodies', () => {
    gateOn(() => {
      const posted = generateEstimate({ ...request(), roofStyleReplay: { multiplier: 3, perFt: 1, minimum: 1 } });
      expect(total(posted)).toBe(total(generateEstimate(request())));
    });
    expect(sanitizeClientIdentityFields({ roofStyleReplay: { multiplier: 1 } })).toEqual({});
  });
});

describe('the closure row on the customer estimate', () => {
  test('the public row carries the plain label and price, and none of the internal terms', () => {
    const mapped = gateOn(() => mapV1ToLegacyShape(generateEstimate(baseInput({
      services: { exclusion: exclusion({ roofStyle: 'barrel_tile', barrelEaveFt: 40 }) },
    }))));
    const rows = normalizeOneTimeBreakdown({ result: mapped }).items.filter((r) => r.service === 'rodent_exclusion');
    const closure = rows.find((r) => /eave closure/i.test(r.label || r.name || ''));
    expect(closure).toMatchObject({ amount: 480 });
    expect(closure.label || closure.name).toBe('Barrel tile eave closure (40 ft)');
    for (const row of rows) {
      expect(Object.keys(row)).not.toEqual(expect.arrayContaining(['roofStyle']));
      expect(`${row.label} ${row.detail}`).not.toMatch(/guarantee|warranty|Waves Pest Control| our /i);
    }
  });
});

describe('the confirmed roof style prices only the V2 model; legacy pricers read the lookup as before', () => {
  const lookupShingle = { roofType: 'shingle' };
  const pick = (roofStyle) => ({ roofStyle });

  test('legacy exclusion pricer: a tile (or any) pick prices the line byte-identical to no pick, for either lookup roof type', () => {
    gateOn(() => {
      const legacy = (roofType, exclusionExtra) => generateEstimate(baseInput({
        roofType,
        services: { exclusion: { simple: 0, moderate: 6, advanced: 0, waiveInspection: true, ...exclusionExtra } },
      })).lineItems.find((li) => li.service === 'exclusion');
      for (const roofType of ['shingle', 'tile']) {
        const base = legacy(roofType, {});
        for (const style of ['shingle', 'flat_tile', 'barrel_tile', 'metal', 'other']) expect(legacy(roofType, pick(style))).toEqual(base);
      }
      expect(legacy('tile', {}).price).toBeGreaterThan(legacy('shingle', {}).price);
    });
  });

  test('exclusionV2 (sqft-tiered) and the guarantee combo read the lookup as before, whatever the pick', () => {
    gateOn(() => {
      const run = (key, roofStyle) => generateEstimate(baseInput({
        ...lookupShingle,
        services: {
          exclusion: { pricingVersion: 'v2', waiveInspection: true, ...(roofStyle ? pick(roofStyle) : {}) },
          [key]: { entryPointsFound: 40, guaranteeTerm: 12, baitStationTier: 'standard', stationCount: 4 },
        },
      })).lineItems.filter((li) => li.service !== 'rodent_exclusion' && li.service !== 'exclusion');
      const v2 = run('exclusionV2');
      expect(v2.length).toBeGreaterThan(0);
      expect(run('exclusionV2', 'flat_tile')).toEqual(v2);
      // The combo prices its own exclusion from the lookup roof type and has no roof-based tier: a pick changes nothing.
      const combo = run('rodentGuaranteeCombo');
      expect(combo.length).toBeGreaterThan(0);
      for (const style of ['flat_tile', 'barrel_tile', 'metal', 'shingle']) expect(run('rodentGuaranteeCombo', style)).toEqual(combo);
    });
  });
});

describe('barrel eave feet are validated before any coercion', () => {
  const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
  const profile = { homeSqFt: 2000, stories: 1, lotSqFt: 9000, propertyType: 'single_family' };
  const route = (exclBarrelEaveFt) => translateV2CallToV1Input(profile, ['EXCLUSION'], {
    exclAdvancedWireMesh: 1, exclRoofStyle: 'barrel_tile', exclBarrelEaveFt,
  }).services.exclusion.barrelEaveFt;
  const direct = (barrelEaveFt) => gateOn(() => generateEstimate(baseInput({
    services: { exclusion: { pricingVersion: 'v2', advancedWireMeshPoints: 1, waiveInspection: true, roofStyle: 'barrel_tile', barrelEaveFt } },
  })));
  const BAD = [true, false, 'abc', '4 0', '1e3', -1, '-1', Infinity, NaN, {}, [], [40]];

  test('the route accepts a finite number >= 0 or a numeric string, and empty = 0', () => {
    expect([40, '40', ' 40 ', '12.5', 0, '0', '', null, undefined].map(route)).toEqual([40, 40, 40, 12.5, 0, 0, 0, 0, 0]);
  });

  test('the route refuses anything else with EXCLUSION_ROOF_STYLE_INVALID (400)', () => {
    for (const value of BAD) {
      let error;
      try { route(value); } catch (err) { error = err; }
      expect([value, error && [error.statusCode, error.code, error.failClosed]]).toEqual([value, [400, 'EXCLUSION_ROOF_STYLE_INVALID', true]]);
    }
  });

  test('the engine runs the same check on direct inputs', () => {
    for (const value of BAD) {
      let error;
      try { direct(value); } catch (err) { error = err; }
      expect([value, error && error.code]).toEqual([value, 'EXCLUSION_ROOF_STYLE_INVALID']);
    }
    expect(rowsOf(direct('40')).find((li) => li.component === 'barrel_eave_closure').price).toBe(480);
    expect(rowsOf(direct('')).some((li) => li.component === 'barrel_eave_closure')).toBe(false);
  });

  test('a non-barrel style carries no feet and validates none', () => {
    const flat = translateV2CallToV1Input(profile, ['EXCLUSION'], { exclAdvancedWireMesh: 1, exclRoofStyle: 'flat_tile', exclBarrelEaveFt: true });
    expect(flat.services.exclusion.barrelEaveFt).toBeUndefined();
  });
});

describe('one tile multiplier source: the Settings-hydrated value, with a frozen stamp winning on replay', () => {
  const { SPECIALTY } = require('../services/pricing-engine/constants');
  const roofHigh = (extra = {}) => priceRodentExclusionV2({ advancedWireMeshPoints: 2, waiveInspection: true, roofStyle: 'flat_tile', ...extra });
  const withHydrated = (value, fn) => {
    const multipliers = SPECIALTY.exclusion.roofMultipliers;
    const prior = multipliers.tile;
    multipliers.tile = value;
    try { return fn(); } finally { multipliers.tile = prior; }
  };

  test('changing the hydrated tile value changes the V2 roof/high price; the live value is 1.25', () => {
    expect(component(roofHigh(), 'wire_mesh_points').price).toBe(375);
    withHydrated(1.4, () => {
      expect(component(roofHigh(), 'wire_mesh_points').price).toBe(420);
      expect(component(roofHigh(), 'wire_mesh_points').tileRoofMultiplier).toBe(1.4);
    });
    // Missing value: the code constant.
    withHydrated(undefined, () => expect(component(roofHigh(), 'wire_mesh_points').price).toBe(375));
  });

  test('a saved estimate keeps the stamped multiplier after the hydrated value changes', () => {
    const request = () => baseInput({ services: { exclusion: exclusion({ roofStyle: 'flat_tile' }) } });
    const quoted = gateOn(() => generateEstimate(request()));
    const saved = { engineInputs: request(), result: mapV1ToLegacyShape(quoted) };
    withHydrated(1.4, () => {
      expect(total(gateOn(() => generateEstimate(request())))).toBeGreaterThan(total(quoted));
      withGate(undefined, () => {
        const replayInputs = extractEngineInputs(saved);
        expect(replayInputs.roofStyleReplay.multiplier).toBe(1.25);
        expect(total(generateEstimate(replayInputs))).toBe(total(quoted));
      });
    });
  });
});

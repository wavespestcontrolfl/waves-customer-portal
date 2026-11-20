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
      const legacy = () => generateEstimate(baseInput({ services: { exclusion: { simple: 1, roofStyle: 'flat_tile' } } }));
      expect(error(legacy)).toMatchObject({ statusCode: 400, code: 'EXCLUSION_ROOF_STYLE_INCOMPATIBLE', failClosed: true });
    });
    // The gate decision comes first: off, the same request gets the gated error.
    withGate(undefined, () => {
      expect(error(() => generateEstimate(baseInput({ services: { exclusion: { simple: 1, roofStyle: 'flat_tile' } } })))).toMatchObject({ code: 'EXCLUSION_ROOF_STYLE_GATED' });
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
        // Any pick, with or without points or feet, goes to the manual quote.
        for (const extra of [
          { roofStyle: 'barrel_tile', barrelEaveFt: 80 },
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

  describe('a pick changes the shape only when it adds priced work', () => {
    const zero = (extra) => translate({ exclAdvancedWireMesh: 0, exclWaiveInspection: true, ...extra });
    const exclTotal = (request) => generateEstimate(request).lineItems
      .filter((li) => ['exclusion', 'rodent_exclusion'].includes(li.service)).reduce((sum, li) => sum + li.price, 0);

    test('shingle, metal, other and a bare tile pick price exactly as no pick (legacy stays legacy)', () => {
      gateOn(() => {
        const noPick = zero({});
        expect(noPick.services.exclusion.pricingVersion).toBeUndefined();
        const base = exclTotal(noPick);
        expect(base).toBe(595);
        for (const exclRoofStyle of ['shingle', 'metal', 'other', 'flat_tile', 'barrel_tile']) {
          const request = zero({ exclRoofStyle });
          expect(request.services.exclusion).toEqual(noPick.services.exclusion);
          expect(exclTotal(request)).toBe(base);
        }
      });
    });

    test('a pick on a V2-shaped request is carried, so the engine stamps it and refuses it when the gate is off', () => {
      for (const exclRoofStyle of ['shingle', 'metal', 'other', 'flat_tile', 'barrel_tile']) {
        expect(translate({ exclRoofStyle }).services.exclusion).toMatchObject({ pricingVersion: 'v2', roofStyle: exclRoofStyle });
        withGate(undefined, () => expect(() => generateEstimate(translate({ exclRoofStyle }))).toThrow(/Clear the roof style/));
        gateOn(() => expect(() => generateEstimate(translate({ exclRoofStyle }))).not.toThrow());
      }
    });

    test('barrel feet alone route to V2 with the closure; legacy counts beside them are refused, never discarded', () => {
      gateOn(() => {
        const request = zero({ exclRoofStyle: 'barrel_tile', exclBarrelEaveFt: 40 });
        expect(request.services.exclusion).toMatchObject({ pricingVersion: 'v2', roofStyle: 'barrel_tile', barrelEaveFt: 40 });
        expect(rowsOf(generateEstimate(request)).some((li) => li.component === 'barrel_eave_closure' && li.price === 480)).toBe(true);
        let error;
        try { zero({ exclRoofStyle: 'barrel_tile', exclBarrelEaveFt: 40, exclModerate: 2 }); } catch (err) { error = err; }
        expect(error).toMatchObject({ statusCode: 400, code: 'EXCLUSION_ROOF_STYLE_INCOMPATIBLE', failClosed: true });
      });
      // The refusal does not depend on the gate (the route cannot carry the pick beside legacy counts).
      expect(() => zero({ exclRoofStyle: 'barrel_tile', exclBarrelEaveFt: 40, exclSimple: 1 })).toThrow(/legacy point counts/);
      // Feet without Barrel tile, or with no feet, add no work and the legacy counts stay.
      expect(zero({ exclRoofStyle: 'flat_tile', exclBarrelEaveFt: 40, exclModerate: 2 }).services.exclusion.moderate).toBe(2);
      expect(zero({ exclRoofStyle: 'barrel_tile', exclBarrelEaveFt: 0, exclModerate: 2 }).services.exclusion.moderate).toBe(2);
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

const { priceAreaAddOn, generateEstimate } = require('../services/pricing-engine');
const {
  mapV1ToLegacyShape,
  estimateDataCarriesAreaAddOns,
  estimateAreaAddOnsGated,
} = require('../services/pricing-engine/v1-legacy-mapper');
const { AREA_ADDONS, GLOBAL } = require('../services/pricing-engine/constants');

// Owner rulings 2026-10-08: one cost-plus add-on pricer, 60% target at the
// top of each area tier, own visit by default, no recurring-customer perk.
// GATE_AREA_ADDONS is dark by default; every case below runs with it on unless
// it turns it off itself.
let savedGate;
beforeEach(() => {
  savedGate = process.env.GATE_AREA_ADDONS;
  process.env.GATE_AREA_ADDONS = 'true';
});
afterEach(() => {
  if (savedGate === undefined) delete process.env.GATE_AREA_ADDONS;
  else process.env.GATE_AREA_ADDONS = savedGate;
});

describe('area add-on treatment pricing', () => {
  test.each([
    ['bed_pre_emergent', 1000, 99, 69],
    ['bed_pre_emergent', 2000, 139, 109],
    ['bed_pre_emergent', 3500, 199, 169],
    ['lawn_insect_spot', 1000, 79, 49],
    ['lawn_insect_spot', 2000, 89, 59],
    ['lawn_insect_spot', 3500, 109, 79],
    ['fire_ant_yard', 3000, 99, 69],
    ['fire_ant_yard', 5000, 129, 99],
    ['fire_ant_yard', 8000, 169, 139],
    ['lawn_insect_preventive', 3000, 99, 69],
    ['lawn_insect_preventive', 5000, 119, 89],
    ['lawn_insect_preventive', 8000, 149, 119],
    ['hardscape_weed', 1000, 119, 89],
  ])('%s at %i sq ft is $%i own visit and $%i same trip', (key, areaSqFt, ownVisit, sameTrip) => {
    expect(priceAreaAddOn(key, { areaSqFt, grassType: 'st_augustine' }).price).toBe(ownVisit);
    expect(priceAreaAddOn(key, { areaSqFt, grassType: 'st_augustine', visitContext: 'sameTripAddOn' }).price).toBe(sameTrip);
  });

  test('every priced tier keeps at least the target margin in both visit contexts', () => {
    for (const [key, cfg] of Object.entries(AREA_ADDONS.items)) {
      for (const areaSqFt of cfg.tiers || [undefined]) {
        for (const visitContext of ['standalone', 'sameTripAddOn']) {
          for (const carries of [true, false]) {
            const line = priceAreaAddOn(key, { areaSqFt, visitContext, grassType: 'st_augustine', carriesDrive: carries, carriesAdmin: carries });
            expect(line.margin).toBeGreaterThanOrEqual(AREA_ADDONS.targetMargin);
            expect(line.price % 10).toBe(9);
          }
        }
      }
    }
  });

  test('an area inside a tier prices at the top of that tier', () => {
    const line = priceAreaAddOn('lawn_insect_spot', { areaSqFt: 1200, grassType: 'St. Augustine' });
    expect(line).toMatchObject({ price: 89, tierSqFt: 2000, areaSqFt: 1200 });
  });

  test('a same-trip add-on drops only the drive cost', () => {
    const own = priceAreaAddOn('fire_ant_yard', { areaSqFt: 5000 });
    const same = priceAreaAddOn('fire_ant_yard', { areaSqFt: 5000, visitContext: 'sameTripAddOn' });
    expect(own.costs.driveMin).toBe(GLOBAL.DRIVE_TIME);
    expect(same.costs.driveMin).toBe(0);
    expect(own.costs.material).toBe(same.costs.material);
    expect(own.costs.total - same.costs.total)
      .toBeCloseTo(GLOBAL.DRIVE_TIME * GLOBAL.LABOR_RATE / 60, 2);
  });

  test('web sweep is one flat labor-only job with no area', () => {
    const line = priceAreaAddOn('web_sweep');
    expect(line).toMatchObject({ price: 89, tierSqFt: null, areaSqFt: null });
    expect(line.costs.material).toBe(0);
    expect(priceAreaAddOn('web_sweep', { visitContext: 'sameTripAddOn' }).price).toBe(59);
  });

  test('version 1 sells one application: no application count exists, and a caller that sends one is refused', () => {
    const line = priceAreaAddOn('hardscape_weed', { areaSqFt: 1000 });
    expect(line.price).toBe(119);
    for (const key of ['applications', 'perApplication', 'maxPerYear']) expect(line).not.toHaveProperty(key);
    expect(JSON.stringify(line)).not.toMatch(/per application/i);
    for (const applications of [1, 2, 0, '2', null]) {
      expect(() => priceAreaAddOn('hardscape_weed', { areaSqFt: 1000, applications }))
        .toThrow(/applications is not supported/);
    }
    expect(() => generateEstimate({ ...HOME, services: { areaAddOns: [{ key: 'web_sweep', applications: 2 }] } }))
      .toThrow(expect.objectContaining({ statusCode: 400, failClosed: true }));
  });

  test('every add-on names its own catalog service key and family', () => {
    const keys = Object.values(AREA_ADDONS.items).map((cfg) => cfg.serviceKey);
    expect(new Set(keys).size).toBe(6);
    for (const [key, cfg] of Object.entries(AREA_ADDONS.items)) {
      expect(cfg.serviceKey).toBe(`area_addon_${key}`);
      expect(cfg.category).toBe(key === 'web_sweep' ? 'pest_control' : 'lawn_care');
      const line = priceAreaAddOn(key, { areaSqFt: cfg.tiers ? cfg.tiers[0] : undefined, grassType: 'st_augustine' });
      expect(line).toMatchObject({ catalogServiceKey: cfg.serviceKey, addOnCategory: cfg.category });
    }
  });

  test('the line never takes a discount pass', () => {
    expect(priceAreaAddOn('web_sweep')).toMatchObject({ service: 'area_addon', discountable: false });
  });

  test('an area above the largest tier is a custom quote, not an extrapolated price', () => {
    const line = priceAreaAddOn('bed_pre_emergent', { areaSqFt: 3501 });
    expect(line).toMatchObject({
      price: null,
      requiresCustomQuote: true,
      customQuoteReason: 'area_addon_area_above_largest_tier',
    });
  });

  test('the lawn insect spot prices for St. Augustine only (the Arena 2(ee) rate covers no other grass)', () => {
    for (const grassType of ['bermuda', 'zoysia', 'bahia', 'paspalum', '', undefined, null]) {
      expect(priceAreaAddOn('lawn_insect_spot', { areaSqFt: 1000, grassType })).toMatchObject({
        price: null,
        requiresCustomQuote: true,
        customQuoteReason: 'area_addon_grass_not_covered_by_label_rate',
      });
    }
    // Through the engine the estimate's grass applies, and an entry's own grass wins.
    const stAug = generateEstimate({ grassType: 'st_augustine', services: { areaAddOns: [{ key: 'lawn_insect_spot', areaSqFt: 1000 }] } });
    expect(stAug.lineItems.find((l) => l.service === 'area_addon').price).toBe(79);
    const zoysia = generateEstimate({ grassType: 'zoysia', services: { areaAddOns: [{ key: 'lawn_insect_spot', areaSqFt: 1000 }] } });
    expect(zoysia.lineItems.find((l) => l.service === 'area_addon')).toMatchObject({ price: null, requiresCustomQuote: true });
    const unknown = generateEstimate({ services: { areaAddOns: [{ key: 'lawn_insect_spot', areaSqFt: 1000 }] } });
    expect(unknown.lineItems.find((l) => l.service === 'area_addon').price).toBeNull();
    // An entry's own grass wins, an explicit unknown included: it never falls back to the estimate's grass.
    const entryUnknown = generateEstimate({ grassType: 'st_augustine', services: { areaAddOns: [{ key: 'lawn_insect_spot', areaSqFt: 1000, grassType: 'unknown' }] } });
    expect(entryUnknown.lineItems.find((l) => l.service === 'area_addon')).toMatchObject({ price: null, requiresCustomQuote: true, customQuoteReason: 'area_addon_grass_not_covered_by_label_rate' });
    const entryEmpty = generateEstimate({ grassType: 'st_augustine', services: { areaAddOns: [{ key: 'lawn_insect_spot', areaSqFt: 1000, grassType: '' }] } });
    expect(entryEmpty.lineItems.find((l) => l.service === 'area_addon').price).toBeNull();
    const entryChosen = generateEstimate({ grassType: 'zoysia', services: { areaAddOns: [{ key: 'lawn_insect_spot', areaSqFt: 1000, grassType: 'st_augustine' }] } });
    expect(entryChosen.lineItems.find((l) => l.service === 'area_addon').price).toBe(79);
    // A grass-free add-on is unaffected.
    expect(priceAreaAddOn('fire_ant_yard', { areaSqFt: 3000, grassType: 'bahia' }).price).toBe(99);
  });

  test('bad input is a 400 pricing error', () => {
    expect(() => priceAreaAddOn('aeration', { areaSqFt: 1000 })).toThrow(/addOnKey must be one of/);
    expect(() => priceAreaAddOn('fire_ant_yard', {})).toThrow(/areaSqFt is required/);
    expect(() => priceAreaAddOn('fire_ant_yard', { areaSqFt: -5 })).toThrow(/areaSqFt is required/);
    expect(() => priceAreaAddOn('fire_ant_yard', { areaSqFt: 3000, visitContext: 'builderBatch' }))
      .toThrow(/visitContext must be one of/);
    // Number(true) is 1 and Number([1200]) is 1200: neither is an area.
    for (const areaSqFt of [true, [1200], {}, '', '  ', null]) {
      expect(() => priceAreaAddOn('fire_ant_yard', { areaSqFt })).toThrow(/areaSqFt is required/);
    }
    expect(priceAreaAddOn('fire_ant_yard', { areaSqFt: '3000' }).price).toBe(99);
  });
});

// Synthetic property only: no customer data.
const HOME = { homeSqFt: 2000, lotSqFt: 7500 };
const TWO_ADDONS = [
  { key: 'bed_pre_emergent', areaSqFt: 1500 },
  { key: 'web_sweep' },
];
const addOnLines = (estimate) => estimate.lineItems.filter((l) => l.service === 'area_addon');

describe('area add-ons in the estimate engine (GATE_AREA_ADDONS)', () => {
  test.each([undefined, '', 'false', '0', 'off'])('gate %p refuses with a fail-closed 400 from both entry points', (value) => {
    if (value === undefined) delete process.env.GATE_AREA_ADDONS;
    else process.env.GATE_AREA_ADDONS = value;
    const expected = { statusCode: 400, code: 'AREA_ADDONS_GATED', failClosed: true };
    expect(() => priceAreaAddOn('web_sweep')).toThrow(expect.objectContaining(expected));
    expect(() => generateEstimate({ ...HOME, services: { areaAddOns: TWO_ADDONS } }))
      .toThrow(expect.objectContaining(expected));
    // A commercial property must not turn the gate off into a manual-quote line.
    expect(() => generateEstimate({ ...HOME, propertyType: 'commercial', services: { areaAddOns: TWO_ADDONS } }))
      .toThrow(expect.objectContaining(expected));
  });

  test('an empty list or no list never needs the gate', () => {
    delete process.env.GATE_AREA_ADDONS;
    expect(addOnLines(generateEstimate({ ...HOME, services: { areaAddOns: [] } }))).toEqual([]);
    expect(addOnLines(generateEstimate({ ...HOME, services: { pest: { frequency: 'quarterly' } } }))).toEqual([]);
  });

  test('two add-ons on one estimate are two line items and sum into the one-time total', () => {
    const estimate = generateEstimate({ ...HOME, services: { areaAddOns: TWO_ADDONS } });
    const lines = addOnLines(estimate);
    expect(lines.map((l) => [l.addOnKey, l.price])).toEqual([['bed_pre_emergent', 139], ['web_sweep', 39]]);
    expect(estimate.summary.oneTimeTotal).toBe(178);
  });

  test('a recurring customer gets no discount on an add-on, at any tier', () => {
    const alone = addOnLines(generateEstimate({ ...HOME, services: { areaAddOns: TWO_ADDONS } }));
    const recurring = addOnLines(generateEstimate({
      ...HOME,
      recurringCustomer: true,
      priorQualifyingServices: ['pest_control', 'lawn_care', 'mosquito'],
      services: { areaAddOns: TWO_ADDONS },
    }));
    expect(recurring.map((l) => l.price)).toEqual(alone.map((l) => l.price));
    for (const line of recurring) {
      expect(line.priceAfterDiscount).toBe(line.price);
      expect(line.discount).toMatchObject({ effectiveDiscount: 0, discountable: false });
    }
    // The price formula has no recurring-customer input at all.
    expect(alone[0].discountable).toBe(false);
  });

  test('add-ons do not count toward the WaveGuard tier or change recurring money', () => {
    const programs = { pest: { frequency: 'quarterly' }, lawn: { track: 'st_augustine', tier: 'enhanced' }, mosquito: { tier: 'silver' } };
    const without = generateEstimate({ ...HOME, services: programs });
    const withAddOns = generateEstimate({ ...HOME, services: { ...programs, areaAddOns: TWO_ADDONS } });
    expect(without.waveGuard.tier).not.toBe('none');
    expect(withAddOns.waveGuard.tier).toBe(without.waveGuard.tier);
    expect(withAddOns.waveGuard.activeServices).toEqual(without.waveGuard.activeServices);
    expect(withAddOns.summary.recurringAnnualAfterDiscount).toBe(without.summary.recurringAnnualAfterDiscount);
    expect(withAddOns.summary.oneTimeTotal).toBe(without.summary.oneTimeTotal + 178);
    // Add-ons alone are not a qualifying service.
    const alone = generateEstimate({ ...HOME, services: { areaAddOns: TWO_ADDONS } });
    expect(alone.waveGuard.activeServices).toEqual([]);
  });

  test('a manual estimate discount skips add-on lines', () => {
    const estimate = generateEstimate({
      ...HOME,
      manualDiscount: { type: 'PERCENT', value: 10 },
      services: { areaAddOns: TWO_ADDONS },
    });
    expect(addOnLines(estimate).map((l) => l.price)).toEqual([139, 39]);
    expect(estimate.summary.oneTimeTotal).toBe(178);
  });

  test.each([
    ['an object instead of a list', { key: 'web_sweep' }],
    ['a string', 'web_sweep'],
    ['null', null],
    ['true', true],
  ])('areaAddOns as %s fails closed', (_label, value) => {
    expect(() => generateEstimate({ ...HOME, services: { areaAddOns: value } }))
      .toThrow(expect.objectContaining({ name: 'PricingError', statusCode: 400, failClosed: true }));
  });

  test.each([
    ['a string entry', ['web_sweep']],
    ['a null entry', [null]],
    ['a nested list', [['web_sweep']]],
    ['an unknown key', [{ key: 'aeration', areaSqFt: 1000 }]],
    ['a missing area', [{ key: 'fire_ant_yard' }]],
  ])('%s fails closed, never skipped', (_label, entries) => {
    expect(() => generateEstimate({ ...HOME, services: { areaAddOns: entries } }))
      .toThrow(expect.objectContaining({ statusCode: 400, failClosed: true }));
  });

  test('a custom-quote add-on stays unpriced and hoists its review reason', () => {
    const estimate = generateEstimate({
      ...HOME,
      services: { areaAddOns: [{ key: 'fire_ant_yard', areaSqFt: 9000 }, { key: 'web_sweep' }] },
    });
    const [custom, priced] = addOnLines(estimate);
    expect(custom).toMatchObject({ price: null, requiresCustomQuote: true });
    expect(priced.price).toBe(89);
    expect(estimate.summary.oneTimeTotal).toBe(89);
    expect(JSON.stringify(estimate)).toContain('area_addon_area_above_largest_tier');
  });

  test('a commercial property gets one manual-quote line per family, not a residential price', () => {
    const estimate = generateEstimate({
      ...HOME,
      propertyType: 'commercial',
      services: { areaAddOns: [{ key: 'bed_pre_emergent', areaSqFt: 1500 }, { key: 'web_sweep' }, { key: 'hardscape_weed', areaSqFt: 1000 }] },
    });
    expect(addOnLines(estimate)).toEqual([]);
    expect(estimate.lineItems.map((l) => [l.service, l.quoteRequired])).toEqual([
      ['commercial_lawn', true],
      ['commercial_pest', true],
    ]);
  });
});

// Codex round 2 on #6135: one chokepoint per rule, so a narrow patch at one call site cannot leave a sibling path open.
describe('area add-on input rules in the estimate engine', () => {
  const run = (areaAddOns, extra = {}) => generateEstimate({ ...HOME, ...extra, services: { ...(extra.services || {}), areaAddOns } });
  const throwsFailClosed = (fn, message) => expect(fn).toThrow(expect.objectContaining({
    name: 'PricingError', statusCode: 400, failClosed: true, ...(message ? { message: expect.stringMatching(message) } : {}),
  }));

  test('the same key twice is refused: each add-on is sold once per estimate (a second application is a new estimate)', () => {
    throwsFailClosed(() => run([
      { key: 'hardscape_weed', areaSqFt: 1000 },
      { key: 'hardscape_weed', areaSqFt: 1000 },
    ]), /more than once/);
    throwsFailClosed(() => run([{ key: 'web_sweep' }, { key: 'web_sweep' }]), /more than once/);
  });

  test('a commercial property validates the entry first: unknown key or bad value throws, never a manual-quote line', () => {
    const commercial = { propertyType: 'commercial' };
    throwsFailClosed(() => run([{ key: 'aeration', areaSqFt: 1000 }], commercial), /addOnKey must be one of/);
    throwsFailClosed(() => run([{ key: 'fire_ant_yard' }], commercial), /areaSqFt is required/);
    throwsFailClosed(() => run([{ key: 'web_sweep' }], { ...commercial, services: { areaAddOnVisit: 'builderBatch' } }), /areaAddOnVisit must be one of/);
    throwsFailClosed(() => run([{ key: 'web_sweep', visitContext: 'standalone' }], commercial), /visitContext is set once for all area add-ons/);
    throwsFailClosed(() => run([{ key: 'web_sweep' }, 'web_sweep'], commercial), /must be an object/);
    // A valid entry is still the commercial manual-quote line.
    expect(run([{ key: 'fire_ant_yard', areaSqFt: 3000 }], commercial).lineItems.map((l) => l.service)).toEqual(['commercial_lawn']);
  });

  test('key casing, non-plain entries and malformed fields never price', () => {
    throwsFailClosed(() => run([{ key: 'Web_Sweep' }]), /addOnKey must be one of/);
    throwsFailClosed(() => run([{ key: ' web_sweep' }]), /addOnKey must be one of/);
    throwsFailClosed(() => run([{ key: ['web_sweep'] }]), /addOnKey must be one of/);
    throwsFailClosed(() => run([{}]), /addOnKey must be one of/);
    class Entry { constructor() { this.key = 'web_sweep'; } }
    throwsFailClosed(() => run([new Entry()]), /must be an object/);
    throwsFailClosed(() => run([new Date()]), /must be an object/);
    throwsFailClosed(() => priceAreaAddOn('web_sweep', null), /must be an object/);
    throwsFailClosed(() => priceAreaAddOn('web_sweep', 'sameTripAddOn'), /must be an object/);
    // Extra unknown fields are ignored.
    expect(addOnLines(run([{ key: 'web_sweep', note: 'ignored' }])).map((l) => l.price)).toEqual([89]);
  });

  test('web sweep is one flat job that ignores an area', () => {
    expect(addOnLines(run([{ key: 'web_sweep', areaSqFt: 'x' }]))[0].price).toBe(89);
  });
});

describe('same-visit area add-ons need a host visit on the same estimate', () => {
  const SAME = { areaAddOnVisit: 'sameTripAddOn' };
  const run = (areaAddOns, services = {}, extra = {}) => generateEstimate({ ...HOME, ...extra, services: { ...services, areaAddOns } });
  const HOST_ERROR = expect.objectContaining({
    name: 'PricingError', statusCode: 400, failClosed: true, message: 'Same visit needs a one-time service on this estimate. Sell the add-on on its own visit, or on its own estimate.',
    metadata: expect.objectContaining({ reason: 'AREA_ADDON_HOST_MISSING' }),
  });
  const SWEEP = [{ key: 'web_sweep' }];

  test('a same-visit web sweep alone throws; it is never silently repriced as its own visit', () => {
    expect(() => run(SWEEP, SAME)).toThrow(HOST_ERROR);
  });

  test('a RECURRING service alone is not a host: the one-time accept books the add-ons and a recurring accept is refused, so it fails closed at quote', () => {
    for (const services of [{ pest: { frequency: 'quarterly' } }, { lawn: { track: 'st_augustine', tier: 'enhanced' } }, { mosquito: { tier: 'silver' } }]) {
      expect(() => run(SWEEP, { ...services, ...SAME })).toThrow(HOST_ERROR);
    }
    // ... also with the one-time CHOICE a pest estimate can offer (show_one_time_option is a saved-row flag, not a priced line)
    expect(() => run(SWEEP, { pest: { frequency: 'quarterly' }, ...SAME }, { showOneTimeOption: true })).toThrow(HOST_ERROR);
    // The same recurring service with the add-on on its OWN visit is quoted as before.
    expect(addOnLines(run(SWEEP, { pest: { frequency: 'quarterly' } })).map((l) => l.price)).toEqual([89]);
  });

  test('a one-time host next to a recurring service prices the same-visit $59, and the fee that rides a recurring plan is not a host', () => {
    const estimate = run(SWEEP, { pest: { frequency: 'quarterly' }, oneTimePest: true, ...SAME });
    expect(addOnLines(estimate).map((l) => [l.visitContext, l.price, l.carriesVisitDrive])).toEqual([['sameTripAddOn', 59, false]]);
    // pest_initial_roach rides the recurring first visit (it is not a visit of its own)
    expect(() => run(SWEEP, { pest: { frequency: 'quarterly', roachType: 'german' }, ...SAME })).toThrow(HOST_ERROR);
  });

  test('the Cockroach Treatment sold ALONE is priced field work and hosts; the same service key as a fee on a recurring plan does not', () => {
    // standalone: true, its own booked visit
    const alone = run(SWEEP, { pestInitialRoach: { roachType: 'regular' }, ...SAME });
    expect(alone.lineItems.some((l) => l.service === 'pest_initial_roach' && l.standalone === true && l.price > 0)).toBe(true);
    expect(addOnLines(alone).map((l) => [l.visitContext, l.price])).toEqual([['sameTripAddOn', 59]]);
    // the engine's first-visit fee on a recurring pest plan: not a visit, no host (German and native)
    for (const roachType of ['german', 'regular']) {
      const feeOnly = { pest: { frequency: 'quarterly', roachType }, ...SAME };
      expect(() => run(SWEEP, feeOnly)).toThrow(HOST_ERROR);
    }
  });

  test.each([
    // [engine line, is a host]. Priced field work booked as a visit hosts; a fee, bond, rental, rider, surcharge, setup or retainer does not.
    [{ service: 'one_time_pest', price: 150 }, true],
    [{ service: 'one_time_lawn', price: 150 }, true],
    [{ service: 'one_time_mosquito', price: 150 }, true],
    [{ service: 'dethatching', price: 200 }, true],
    [{ service: 'wdo_inspection', price: 125 }, true],
    [{ service: 'rodent_guarantee_combo', price: 900 }, true],
    [{ service: 'pest_initial_roach', price: 225, standalone: true }, true],
    [{ service: 'pest_initial_roach', price: 225, standalone: false, autoFiredFromRecurringPest: true }, false],
    [{ service: 'rodent_guarantee', price: 300 }, false],
    [{ service: 'rodent_bait_setup', price: 99 }, false],
    [{ service: 'rodent_trapping_emergency_surcharge', price: 75 }, false],
    [{ service: 'trap_only_retainer', price: 480 }, false],
    [{ service: 'trap_only_setup', price: 95 }, false],
    [{ service: 'trap_only_extra_callback', price: 60 }, false],
    [{ service: 'termite_bond', annual: 240 }, false],
    [{ service: 'termite_station_rental', annual: 240 }, false],
    [{ service: 'waveguard_setup', price: 99 }, false],
    [{ service: 'manual_discount', price: 25 }, false],
    [{ service: 'rodent_bundle_discount', price: 25 }, false],
    [{ service: 'pest_control', price: 150 }, false],
    [{ service: 'one_time_pest', price: 150, quoteRequired: true }, false],
    [{ service: 'one_time_pest', price: 0 }, false],
  ])('host classification of %j is %s', (line, hosts) => {
    const { assertAreaAddOnHostVisit } = require('../services/pricing-engine/service-pricing');
    const call = () => assertAreaAddOnHostVisit({ visit: 'sameTripAddOn', requests: [{}] }, [line]);
    if (hosts) expect(call).not.toThrow(); else expect(call).toThrow(HOST_ERROR);
  });

  test('another one-time service is a host', () => {
    const estimate = run(SWEEP, { oneTimePest: true, ...SAME });
    expect(estimate.lineItems.some((l) => l.service === 'one_time_pest' && l.price > 0)).toBe(true);
    expect(addOnLines(estimate)[0].price).toBe(59);
  });

  test('an add-on never hosts the group: several same-visit add-ons with no other service throw', () => {
    expect(() => run([...SWEEP, { key: 'fire_ant_yard', areaSqFt: 3000 }], SAME)).toThrow(HOST_ERROR);
  });

  test('an unpriced line is never a host: a custom-quote add-on, a commercial manual quote, or a priced-nothing estimate', () => {
    expect(() => run([{ key: 'fire_ant_yard', areaSqFt: 9000 }], SAME)).toThrow(HOST_ERROR);
    expect(() => run([{ key: 'bed_pre_emergent', areaSqFt: 9000 }, ...SWEEP], SAME)).toThrow(HOST_ERROR);
    // commercial: the add-on lines are manual quotes, so nothing hosts the same-visit group
    expect(() => run([{ key: 'bed_pre_emergent', areaSqFt: 1500 }, ...SWEEP], SAME, { propertyType: 'commercial' })).toThrow(HOST_ERROR);
  });

  test('prior services the customer already holds are not a host (an existing visit is not supported yet)', () => {
    expect(() => run(SWEEP, SAME, { recurringCustomer: true, priorQualifyingServices: ['pest_control', 'lawn_care'] })).toThrow(HOST_ERROR);
  });

  test('an own visit never needs a host', () => {
    expect(addOnLines(run(SWEEP)).map((l) => l.price)).toEqual([89]);
    expect(addOnLines(run(SWEEP, { areaAddOnVisit: 'standalone' })).map((l) => l.price)).toEqual([89]);
  });

  test('a direct priceAreaAddOn call still prices same-trip (the engine owns the host check)', () => {
    expect(priceAreaAddOn('web_sweep', { visitContext: 'sameTripAddOn' }).price).toBe(59);
  });
});

// One drive allowance per visit (owner ruling 2026-10-08): the visit is chosen once for the group.
describe('several area add-ons are one visit with one drive', () => {
  const DRIVE = 20; // GLOBAL.DRIVE_TIME minutes, the constant the formula charges
  const run = (areaAddOns, services = {}, extra = {}) => generateEstimate({ ...HOME, ...extra, services: { ...services, areaAddOns } });
  const refused = (fn, message, reason) => expect(fn).toThrow(expect.objectContaining({
    name: 'PricingError', statusCode: 400, failClosed: true, message: expect.stringMatching(message),
    ...(reason ? { metadata: expect.objectContaining({ reason }) } : {}),
  }));
  const three = [
    { key: 'bed_pre_emergent', areaSqFt: 1500 },
    { key: 'fire_ant_yard', areaSqFt: 3000 },
    { key: 'web_sweep' },
  ];

  test('on their own visit two and three add-ons charge exactly one drive, on the first listed', () => {
    for (const list of [three.slice(0, 2), three]) {
      const lines = addOnLines(run(list));
      expect(lines.map((l) => l.costs.driveMin)).toEqual(list.map((_, i) => (i === 0 ? DRIVE : 0)));
      expect(lines.map((l) => l.carriesVisitDrive)).toEqual(list.map((_, i) => i === 0));
      expect(lines.every((l) => l.visitContext === 'standalone')).toBe(true);
    }
    // The follower prices at its same-trip price: the drive is not charged twice.
    const sameTrip = (key, areaSqFt) => priceAreaAddOn(key, { areaSqFt, visitContext: 'sameTripAddOn', carriesAdmin: false }).price;
    expect(addOnLines(run(three)).map((l) => l.price)).toEqual([
      priceAreaAddOn('bed_pre_emergent', { areaSqFt: 1500 }).price,
      sameTrip('fire_ant_yard', 3000),
      sameTrip('web_sweep'),
    ]);
  });

  // The $8 booking-and-invoicing cost is one job's cost, however many add-ons ride on it (Codex round 7 P2).
  test('the visit pays one admin charge: the first priced add-on carries it, own visit or same visit', () => {
    const { adminPerJob } = AREA_ADDONS;
    const sameVisit = { oneTimePest: true, areaAddOnVisit: 'sameTripAddOn' };
    for (const lines of [addOnLines(run(three)), addOnLines(run(three, sameVisit))]) {
      expect(lines.map((l) => l.costs.admin)).toEqual([adminPerJob, 0, 0]);
      expect(lines.map((l) => l.carriesJobAdmin)).toEqual([true, false, false]);
    }
    // A direct call prices a group of one: it carries the admin.
    expect(priceAreaAddOn('web_sweep', {})).toMatchObject({ carriesJobAdmin: true, costs: expect.objectContaining({ admin: adminPerJob }) });
    expect(priceAreaAddOn('web_sweep', { carriesAdmin: false })).toMatchObject({ carriesJobAdmin: false, costs: expect.objectContaining({ admin: 0 }) });
    // The carrier is the one that pays the admin's markup: the same add-on is cheaper without it.
    expect(priceAreaAddOn('web_sweep', { carriesAdmin: false, carriesDrive: false }).price).toBe(39);
    // A custom quote never carries it.
    expect(priceAreaAddOn('bed_pre_emergent', { areaSqFt: 9000 })).toMatchObject({ carriesJobAdmin: false, price: null });
    const lines = addOnLines(run([{ key: 'bed_pre_emergent', areaSqFt: 9000 }, { key: 'web_sweep' }]));
    expect(lines.map((l) => [l.addOnKey, l.carriesJobAdmin])).toEqual([['bed_pre_emergent', false], ['web_sweep', true]]);
  });

  test('the full price table: carrier and non-carrier, own visit and same visit, every tier', () => {
    const price = (key, areaSqFt, opts) => priceAreaAddOn(key, { areaSqFt, grassType: 'st_augustine', ...opts }).price;
    const table = {
      // [own carrier, own follower, same carrier, same follower]
      bed_pre_emergent: { 1000: [99, 49, 69, 49], 2000: [139, 89, 109, 89], 3500: [199, 149, 169, 149] },
      lawn_insect_spot: { 1000: [79, 29, 49, 29], 2000: [89, 39, 59, 39], 3500: [109, 59, 79, 59] },
      fire_ant_yard: { 3000: [99, 49, 69, 49], 5000: [129, 79, 99, 79], 8000: [169, 119, 139, 119] },
      lawn_insect_preventive: { 3000: [99, 49, 69, 49], 5000: [119, 69, 89, 69], 8000: [149, 99, 119, 99] },
      hardscape_weed: { 1000: [119, 69, 89, 69], 2000: [179, 129, 149, 129], 3500: [259, 209, 229, 209] },
    };
    for (const [key, tiers] of Object.entries(table)) {
      for (const [tier, [ownCarrier, ownFollower, sameCarrier, sameFollower]] of Object.entries(tiers)) {
        const area = Number(tier);
        const follower = { carriesDrive: false, carriesAdmin: false };
        expect([
          price(key, area), price(key, area, follower),
          price(key, area, { visitContext: 'sameTripAddOn' }), price(key, area, { visitContext: 'sameTripAddOn', ...follower }),
        ]).toEqual([ownCarrier, ownFollower, sameCarrier, sameFollower]);
      }
    }
    expect([priceAreaAddOn('web_sweep').price, priceAreaAddOn('web_sweep', { carriesDrive: false, carriesAdmin: false }).price,
      priceAreaAddOn('web_sweep', { visitContext: 'sameTripAddOn' }).price]).toEqual([89, 39, 59]);
  });

  test('the group is cheaper than the same add-ons each paying their own drive', () => {
    const eachOwn = three.map((e) => priceAreaAddOn(e.key, { areaSqFt: e.areaSqFt }).price).reduce((a, b) => a + b, 0);
    expect(run(three).summary.oneTimeTotal).toBeLessThan(eachOwn);
  });

  test('on the same visit as a service no add-on carries a drive', () => {
    const lines = addOnLines(run(three, { oneTimePest: true, areaAddOnVisit: 'sameTripAddOn' }));
    expect(lines.map((l) => [l.visitContext, l.costs.driveMin, l.carriesVisitDrive])).toEqual(three.map(() => ['sameTripAddOn', 0, false]));
  });

  test('a custom-quote or commercial first entry never carries the drive: the first PRICED add-on does', () => {
    const lines = addOnLines(run([{ key: 'bed_pre_emergent', areaSqFt: 9000 }, { key: 'fire_ant_yard', areaSqFt: 3000 }, { key: 'web_sweep' }]));
    expect(lines.map((l) => [l.addOnKey, l.carriesVisitDrive, l.price])).toEqual([
      ['bed_pre_emergent', false, null],
      ['fire_ant_yard', true, priceAreaAddOn('fire_ant_yard', { areaSqFt: 3000 }).price],
      ['web_sweep', false, priceAreaAddOn('web_sweep', { visitContext: 'sameTripAddOn', carriesAdmin: false }).price],
    ]);
    expect(lines.map((l) => [l.addOnKey, l.carriesJobAdmin])).toEqual([['bed_pre_emergent', false], ['fire_ant_yard', true], ['web_sweep', false]]);
    // A label-bound add-on with an unverified grass quotes as custom: the next priced one carries.
    const grass = addOnLines(run([{ key: 'lawn_insect_spot', areaSqFt: 1000, grassType: 'unknown' }, { key: 'web_sweep' }]));
    expect(grass.map((l) => [l.addOnKey, l.carriesVisitDrive])).toEqual([['lawn_insect_spot', false], ['web_sweep', true]]);
    // A commercial property: every add-on is a manual quote, so there is no add-on line and no drive.
    expect(addOnLines(run(three, {}, { propertyType: 'commercial' }))).toEqual([]);
  });

  test('every line keeps at least the target margin, carrier or not, on either visit', () => {
    const lines = [
      ...addOnLines(run(three)),
      ...addOnLines(run(three, { oneTimePest: true, areaAddOnVisit: 'sameTripAddOn' })),
    ];
    expect(lines).toHaveLength(6);
    for (const line of lines) expect(line.margin).toBeGreaterThanOrEqual(0.6);
  });

  test('the visit text says what the line was priced as', () => {
    const own = addOnLines(run(three));
    expect(own.map((l) => l.detail.split(' | ').pop())).toEqual([
      'Own visit',
      'Own visit, shared with the other add-ons',
      'Own visit, shared with the other add-ons',
    ]);
    const same = addOnLines(run(three, { oneTimePest: true, areaAddOnVisit: 'sameTripAddOn' }));
    expect(same.every((l) => l.detail.endsWith('Same visit as a booked service'))).toBe(true);
  });

  test('the old per-add-on visitContext is refused, never honored or ignored (an old client must not double-charge)', () => {
    for (const visitContext of ['standalone', 'sameTripAddOn', 'builderBatch', null]) {
      refused(() => run([{ key: 'web_sweep', visitContext }]), /visitContext is set once for all area add-ons/, 'AREA_ADDON_VISIT_PER_ENTRY');
    }
    refused(() => run([{ key: 'bed_pre_emergent', areaSqFt: 1500 }, { key: 'web_sweep', visitContext: 'sameTripAddOn' }], { oneTimePest: true }),
      /visitContext is set once/, 'AREA_ADDON_VISIT_PER_ENTRY');
  });

  test('a bad group visit is refused', () => {
    refused(() => run([{ key: 'web_sweep' }], { areaAddOnVisit: 'builderBatch' }), /areaAddOnVisit must be one of/);
    refused(() => run([{ key: 'web_sweep' }], { areaAddOnVisit: '' }), /areaAddOnVisit must be one of/);
  });

  test('a group visit with no add-ons changes nothing, gate on or off', () => {
    expect(addOnLines(run(undefined, { areaAddOnVisit: 'bogus' }))).toEqual([]);
    delete process.env.GATE_AREA_ADDONS;
    expect(addOnLines(run([], { areaAddOnVisit: 'sameTripAddOn' }))).toEqual([]);
  });
});

describe('a grass of null on a label-bound add-on is "not chosen", like the client\'s unknown', () => {
  const run = (entry, extra = {}) => addOnLines(generateEstimate({ ...HOME, ...extra, services: { lawn: { track: 'st_augustine', tier: 'enhanced' }, areaAddOns: [entry] } }))[0];
  const spot = { key: 'lawn_insect_spot', areaSqFt: 1000 };

  test('only an absent grass borrows the estimate\'s grass; null, "unknown" and "" quote as custom', () => {
    expect(run(spot)).toMatchObject({ price: expect.any(Number) });
    expect(run(spot).requiresCustomQuote).toBeUndefined();
    for (const grassType of [null, 'unknown', '']) {
      expect(run({ ...spot, grassType })).toMatchObject({ requiresCustomQuote: true, price: null });
    }
    expect(run({ ...spot, track: null })).toMatchObject({ requiresCustomQuote: true, price: null });
    expect(run({ ...spot, grassType: 'st_augustine' }).price).toEqual(expect.any(Number));
  });
});

describe('area add-ons through the legacy mapper', () => {
  test('each add-on is its own named one-time row and the totals add up', () => {
    const estimate = generateEstimate({ ...HOME, services: { areaAddOns: TWO_ADDONS } });
    const mapped = mapV1ToLegacyShape(estimate);
    expect(mapped.oneTime.items.map((i) => [i.service, i.name, i.price, i.addOnKey])).toEqual([
      ['area_addon', 'Bed Pre-Emergent Weed Control', 139, 'bed_pre_emergent'],
      ['area_addon', 'Web Sweep', 39, 'web_sweep'],
    ]);
    expect(mapped.oneTime.items[0]).toMatchObject({
      tierSqFt: 2000,
      discountable: false,
      catalogServiceKey: 'area_addon_bed_pre_emergent',
      addOnCategory: 'lawn_care',
      visitContext: 'standalone',
      carriesVisitDrive: true,
      carriesJobAdmin: true,
    });
    expect(mapped.oneTime.items[0].onSiteMinutes).toBeCloseTo(6 + 8 * 2, 5);
    expect(mapped.oneTime.items[1]).toMatchObject({ catalogServiceKey: 'area_addon_web_sweep', addOnCategory: 'pest_control', visitContext: 'standalone', carriesVisitDrive: false, carriesJobAdmin: false });
    expect(mapped.oneTime.specItems).toEqual([]);
    expect(mapped.oneTime.total).toBe(178);
    expect(mapped.oneTime.otSubtotal).toBe(178);
    expect(mapped.hasOneTime).toBe(true);
  });

  test('a custom-quote add-on maps like other custom-quote one-time lines: unpriced spec row', () => {
    const estimate = generateEstimate({
      ...HOME,
      services: { areaAddOns: [{ key: 'fire_ant_yard', areaSqFt: 9000 }, { key: 'web_sweep' }] },
    });
    const mapped = mapV1ToLegacyShape(estimate);
    expect(mapped.oneTime.items.map((i) => i.name)).toEqual(['Web Sweep']);
    expect(mapped.oneTime.specItems).toEqual([
      expect.objectContaining({
        service: 'area_addon',
        name: 'Fire Ant Yard Treatment',
        price: null,
        quoteRequired: true,
        requiresCustomQuote: true,
        customQuoteReason: 'area_addon_area_above_largest_tier',
        addOnKey: 'fire_ant_yard',
      }),
    ]);
    expect(mapped.oneTime.total).toBe(89);
    expect(mapped.quoteRequired).toBe(true);
    expect(mapped.quoteRequiredItems).toEqual([expect.objectContaining({ service: 'area_addon', name: 'Fire Ant Yard Treatment' })]);
  });
});

describe('area add-on rows carry one price and the catalog key through the mapper', () => {
  test('no row carries an application count or a unit price, and an unpriced custom-quote row keeps its catalog key', () => {
    const estimate = generateEstimate({
      ...HOME,
      services: { areaAddOns: [{ key: 'fire_ant_yard', areaSqFt: 9000 }, { key: 'hardscape_weed', areaSqFt: 1000 }] },
    });
    const mapped = mapV1ToLegacyShape(estimate);
    const spec = mapped.oneTime.specItems.find((i) => i.addOnKey === 'fire_ant_yard');
    expect(spec).toMatchObject({ catalogServiceKey: 'area_addon_fire_ant_yard', addOnCategory: 'lawn_care', price: null });
    expect(mapped.specItems.find((i) => i.addOnKey === 'fire_ant_yard')).toMatchObject({ catalogServiceKey: 'area_addon_fire_ant_yard' });
    const weed = mapped.oneTime.items[0];
    expect(weed).toMatchObject({ addOnKey: 'hardscape_weed', price: 119 });
    for (const row of [spec, weed]) {
      expect(row).not.toHaveProperty('applications');
      expect(row).not.toHaveProperty('perApplication');
    }
    expect(weed.detail).not.toMatch(/per application|per visit/i);
  });
});

describe('a persisted estimate carrying an area add-on (the gate is a kill switch for stored estimates)', () => {
  // Fixtures are built with the gate on (describe bodies run before beforeEach).
  const fromEngine = (areaAddOns) => {
    const prior = process.env.GATE_AREA_ADDONS;
    process.env.GATE_AREA_ADDONS = 'true';
    try { return generateEstimate({ ...HOME, services: { areaAddOns } }); } finally {
      if (prior === undefined) delete process.env.GATE_AREA_ADDONS; else process.env.GATE_AREA_ADDONS = prior;
    }
  };
  const PRICED = fromEngine([{ key: 'web_sweep' }]);
  const CUSTOM = fromEngine([{ key: 'fire_ant_yard', areaSqFt: 9000 }]);
  const MAPPED_PRICED = mapV1ToLegacyShape(PRICED);
  const MAPPED_CUSTOM = mapV1ToLegacyShape(CUSTOM);

  test.each([
    ['engineInputs.services.areaAddOns', { engineInputs: { services: { areaAddOns: [{ key: 'web_sweep' }] } } }],
    ['engineInput (public wizard) services.areaAddOns', { engineInput: { services: { areaAddOns: [{ key: 'web_sweep' }] } } }],
    ['inputs.services.areaAddOns', { inputs: { services: { areaAddOns: [{ key: 'web_sweep' }] } } }],
    ['engineRequest.options.services.areaAddOns', { engineRequest: { options: { services: { areaAddOns: [{ key: 'web_sweep' }] } } } }],
    ['engineRequest.options.areaAddOns', { engineRequest: { options: { areaAddOns: [{ key: 'web_sweep' }] } } }],
    ['a malformed non-empty areaAddOns value', { engineInputs: { services: { areaAddOns: 'web_sweep' } } }],
    ['mapped result.oneTime.items (priced)', { result: MAPPED_PRICED }],
    ['mapped result.oneTime.specItems (custom quote)', { result: MAPPED_CUSTOM }],
    ['mapped result.specItems', { result: { specItems: [{ service: 'area_addon' }] } }],
    ['mapped result.quoteRequiredItems', { result: { quoteRequiredItems: [{ service: 'area_addon', quoteRequired: true }] } }],
    ['bare mapped shape (oneTime at the top)', { oneTime: { items: [{ service: 'area_addon' }] } }],
    ['raw engineResult.lineItems', { engineInputs: {}, engineResult: PRICED }],
    ['raw result.lineItems', { result: { lineItems: PRICED.lineItems } }],
    ['a JSON string of a stored shape', JSON.stringify({ result: MAPPED_PRICED })],
  ])('detects %s', (_label, estimateData) => {
    expect(estimateDataCarriesAreaAddOns(estimateData)).toBe(true);
  });

  test.each([
    ['null', null],
    ['a string that is not JSON', 'not json'],
    ['an empty object', {}],
    ['an empty list', { engineInputs: { services: { areaAddOns: [] } } }],
    ['no add-on rows', { result: { oneTime: { items: [{ service: 'one_time_pest' }], specItems: [] } } }],
    ['a lawn-only mapped estimate', { result: mapV1ToLegacyShape(generateEstimate({ ...HOME, services: { pest: { frequency: 'quarterly' } } })) }],
  ])('does not flag %s', (_label, estimateData) => {
    expect(estimateDataCarriesAreaAddOns(estimateData)).toBe(false);
  });

  test('the guard is true only with an add-on and the gate off (read at call time)', () => {
    const stored = { result: MAPPED_PRICED };
    const clean = { result: { oneTime: { items: [], specItems: [] } } };
    for (const value of [undefined, '', 'false', '0', 'off']) {
      if (value === undefined) delete process.env.GATE_AREA_ADDONS; else process.env.GATE_AREA_ADDONS = value;
      expect(estimateAreaAddOnsGated(stored)).toBe(true);
      expect(estimateAreaAddOnsGated(clean)).toBe(false);
    }
    for (const value of ['1', 'true', 'on']) {
      process.env.GATE_AREA_ADDONS = value;
      expect(estimateAreaAddOnsGated(stored)).toBe(false);
    }
  });
});

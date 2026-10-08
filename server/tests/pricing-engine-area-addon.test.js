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
          const line = priceAreaAddOn(key, { areaSqFt, visitContext, grassType: 'st_augustine' });
          expect(line.margin).toBeGreaterThanOrEqual(AREA_ADDONS.targetMargin);
          expect(line.price % 10).toBe(9);
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
    expect(own.costs.perApplication - same.costs.perApplication)
      .toBeCloseTo(GLOBAL.DRIVE_TIME * GLOBAL.LABOR_RATE / 60, 2);
  });

  test('web sweep is one flat labor-only job with no area', () => {
    const line = priceAreaAddOn('web_sweep');
    expect(line).toMatchObject({ price: 89, tierSqFt: null, areaSqFt: null });
    expect(line.costs.material).toBe(0);
    expect(priceAreaAddOn('web_sweep', { visitContext: 'sameTripAddOn' }).price).toBe(59);
  });

  test('shell, rock and paver weed kill stops at the label limit of two a year', () => {
    expect(priceAreaAddOn('hardscape_weed', { areaSqFt: 1000, applications: 2 }).price).toBe(238);
    expect(priceAreaAddOn('hardscape_weed', { areaSqFt: 1000, applications: 3 })).toMatchObject({
      price: null,
      customQuoteReason: 'area_addon_applications_above_yearly_limit',
    });
  });

  test('two bed pre-emergent applications price at twice one application', () => {
    const line = priceAreaAddOn('bed_pre_emergent', { areaSqFt: 1000, applications: 2 });
    expect(line).toMatchObject({ price: 198, perApplication: 99, applications: 2 });
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

  test('more applications than the yearly limit is a custom quote', () => {
    // Two half-rate Arena applications equal the season limit; a third passes it.
    expect(priceAreaAddOn('lawn_insect_spot', { areaSqFt: 1000, applications: 2, grassType: 'st_augustine' }).price).toBe(158);
    const line = priceAreaAddOn('lawn_insect_spot', { areaSqFt: 1000, applications: 3, grassType: 'st_augustine' });
    expect(line).toMatchObject({
      price: null,
      requiresCustomQuote: true,
      customQuoteReason: 'area_addon_applications_above_yearly_limit',
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
    // A grass-free add-on is unaffected.
    expect(priceAreaAddOn('fire_ant_yard', { areaSqFt: 3000, grassType: 'bahia' }).price).toBe(99);
  });

  test('bad input is a 400 pricing error', () => {
    expect(() => priceAreaAddOn('aeration', { areaSqFt: 1000 })).toThrow(/addOnKey must be one of/);
    expect(() => priceAreaAddOn('fire_ant_yard', {})).toThrow(/areaSqFt is required/);
    expect(() => priceAreaAddOn('fire_ant_yard', { areaSqFt: -5 })).toThrow(/areaSqFt is required/);
    expect(() => priceAreaAddOn('fire_ant_yard', { areaSqFt: 3000, visitContext: 'builderBatch' }))
      .toThrow(/visitContext must be one of/);
    expect(() => priceAreaAddOn('fire_ant_yard', { areaSqFt: 3000, applications: 0 }))
      .toThrow(/applications must be a whole number/);
    // Number(true) is 1 and Number([1200]) is 1200: neither is an area.
    for (const areaSqFt of [true, [1200], {}, '', '  ', null]) {
      expect(() => priceAreaAddOn('fire_ant_yard', { areaSqFt })).toThrow(/areaSqFt is required/);
    }
    for (const applications of [true, [1], '', null]) {
      expect(() => priceAreaAddOn('fire_ant_yard', { areaSqFt: 3000, applications }))
        .toThrow(/applications must be a whole number/);
    }
    expect(priceAreaAddOn('fire_ant_yard', { areaSqFt: '3000', applications: '1' }).price).toBe(99);
  });
});

// Synthetic property only: no customer data.
const HOME = { homeSqFt: 2000, lotSqFt: 7500 };
const TWO_ADDONS = [
  { key: 'bed_pre_emergent', areaSqFt: 1500, applications: 2 },
  { key: 'web_sweep', visitContext: 'sameTripAddOn' },
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
    expect(lines.map((l) => [l.addOnKey, l.price])).toEqual([['bed_pre_emergent', 278], ['web_sweep', 59]]);
    expect(estimate.summary.oneTimeTotal).toBe(337);
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
    expect(withAddOns.summary.oneTimeTotal).toBe(without.summary.oneTimeTotal + 337);
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
    expect(addOnLines(estimate).map((l) => l.price)).toEqual([278, 59]);
    expect(estimate.summary.oneTimeTotal).toBe(337);
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

  test('the same key twice is refused, so maxPerYear cannot be split across rows', () => {
    // 2 + 2 = 4 applications of a 2-a-year weed kill would each pass maxPerYear on its own row.
    throwsFailClosed(() => run([
      { key: 'hardscape_weed', areaSqFt: 1000, applications: 2 },
      { key: 'hardscape_weed', areaSqFt: 1000, applications: 2 },
    ]), /more than once/);
    throwsFailClosed(() => run([{ key: 'web_sweep' }, { key: 'web_sweep', visitContext: 'sameTripAddOn' }]), /more than once/);
    // The count goes in applications; over the yearly limit that is one custom-quote row.
    const [line] = addOnLines(run([{ key: 'hardscape_weed', areaSqFt: 1000, applications: 4 }]));
    expect(line).toMatchObject({ price: null, customQuoteReason: 'area_addon_applications_above_yearly_limit' });
  });

  test('a commercial property validates the entry first: unknown key or bad value throws, never a manual-quote line', () => {
    const commercial = { propertyType: 'commercial' };
    throwsFailClosed(() => run([{ key: 'aeration', areaSqFt: 1000 }], commercial), /addOnKey must be one of/);
    throwsFailClosed(() => run([{ key: 'fire_ant_yard' }], commercial), /areaSqFt is required/);
    throwsFailClosed(() => run([{ key: 'web_sweep', applications: 0 }], commercial), /applications must be a whole number/);
    throwsFailClosed(() => run([{ key: 'web_sweep', visitContext: 'builderBatch' }], commercial), /visitContext must be one of/);
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

  test('web sweep takes applications up to its yearly limit and ignores an area', () => {
    expect(addOnLines(run([{ key: 'web_sweep', applications: 12, areaSqFt: 'x' }]))[0].price).toBe(89 * 12);
    expect(addOnLines(run([{ key: 'web_sweep', applications: 13 }]))[0]).toMatchObject({ price: null, requiresCustomQuote: true });
    throwsFailClosed(() => run([{ key: 'web_sweep', applications: 1.5 }]), /applications must be a whole number/);
  });
});

describe('same-visit area add-ons need a host visit on the same estimate', () => {
  const run = (areaAddOns, services = {}, extra = {}) => generateEstimate({ ...HOME, ...extra, services: { ...services, areaAddOns } });
  const HOST_ERROR = expect.objectContaining({
    name: 'PricingError', statusCode: 400, failClosed: true, message: expect.stringMatching(/same-visit area add-on needs a priced service on the same estimate/),
  });
  const SAME_TRIP_SWEEP = { key: 'web_sweep', visitContext: 'sameTripAddOn' };

  test('a same-trip web sweep alone throws; it is never silently repriced as standalone', () => {
    expect(() => run([SAME_TRIP_SWEEP])).toThrow(HOST_ERROR);
  });

  test('with recurring pest on the estimate it prices $59', () => {
    const estimate = run([SAME_TRIP_SWEEP], { pest: { frequency: 'quarterly' } });
    expect(addOnLines(estimate).map((l) => [l.visitContext, l.price])).toEqual([['sameTripAddOn', 59]]);
  });

  test('another one-time service is a host', () => {
    const estimate = run([SAME_TRIP_SWEEP], { oneTimePest: true });
    expect(estimate.lineItems.some((l) => l.service === 'one_time_pest' && l.price > 0)).toBe(true);
    expect(addOnLines(estimate)[0].price).toBe(59);
  });

  test('one standalone add-on hosts a same-trip add-on, in either list order', () => {
    const standalone = { key: 'bed_pre_emergent', areaSqFt: 1500 };
    for (const list of [[standalone, SAME_TRIP_SWEEP], [SAME_TRIP_SWEEP, standalone]]) {
      const lines = addOnLines(run(list));
      expect(lines.map((l) => [l.addOnKey, l.visitContext, l.price]).sort()).toEqual([
        ['bed_pre_emergent', 'standalone', 139],
        ['web_sweep', 'sameTripAddOn', 59],
      ]);
    }
  });

  test('two same-trip add-ons with no other line throw', () => {
    expect(() => run([SAME_TRIP_SWEEP, { key: 'fire_ant_yard', areaSqFt: 3000, visitContext: 'sameTripAddOn' }])).toThrow(HOST_ERROR);
  });

  test('an unpriced line is never a host: a custom-quote add-on, a commercial manual quote, or a priced-nothing estimate', () => {
    // standalone add-on over the top tier = custom quote, no price
    expect(() => run([{ key: 'fire_ant_yard', areaSqFt: 9000 }, SAME_TRIP_SWEEP])).toThrow(HOST_ERROR);
    expect(() => run([{ key: 'web_sweep', applications: 13 }, { key: 'bed_pre_emergent', areaSqFt: 1000, visitContext: 'sameTripAddOn' }])).toThrow(HOST_ERROR);
    // commercial: the add-on lines are manual quotes, so even a standalone one hosts nothing
    expect(() => run([{ key: 'bed_pre_emergent', areaSqFt: 1500 }, SAME_TRIP_SWEEP], {}, { propertyType: 'commercial' })).toThrow(HOST_ERROR);
  });

  test('prior services the customer already holds are not a host (an existing visit is not supported yet)', () => {
    expect(() => run([SAME_TRIP_SWEEP], {}, { recurringCustomer: true, priorQualifyingServices: ['pest_control', 'lawn_care'] })).toThrow(HOST_ERROR);
  });

  test('a standalone add-on never needs a host', () => {
    expect(addOnLines(run([{ key: 'web_sweep' }])).map((l) => l.price)).toEqual([89]);
  });

  test('a direct priceAreaAddOn call still prices same-trip (the engine owns the host check)', () => {
    expect(priceAreaAddOn('web_sweep', { visitContext: 'sameTripAddOn' }).price).toBe(59);
  });
});

describe('area add-ons through the legacy mapper', () => {
  test('each add-on is its own named one-time row and the totals add up', () => {
    const estimate = generateEstimate({ ...HOME, services: { areaAddOns: TWO_ADDONS } });
    const mapped = mapV1ToLegacyShape(estimate);
    expect(mapped.oneTime.items.map((i) => [i.service, i.name, i.price, i.addOnKey])).toEqual([
      ['area_addon', 'Bed Pre-Emergent Weed Control', 278, 'bed_pre_emergent'],
      ['area_addon', 'Web Sweep', 59, 'web_sweep'],
    ]);
    expect(mapped.oneTime.items[0]).toMatchObject({ applications: 2, tierSqFt: 2000, discountable: false });
    expect(mapped.oneTime.specItems).toEqual([]);
    expect(mapped.oneTime.total).toBe(337);
    expect(mapped.oneTime.otSubtotal).toBe(337);
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

describe('area add-on unit price through the mapper', () => {
  test('a two-application row carries perApplication on the item, and its detail names the per-application price', () => {
    const estimate = generateEstimate({
      ...HOME,
      services: { areaAddOns: [{ key: 'fire_ant_yard', areaSqFt: 5000, applications: 1 }, { key: 'bed_pre_emergent', areaSqFt: 1500, applications: 2 }] },
    });
    const mapped = mapV1ToLegacyShape(estimate);
    const bed = mapped.oneTime.items.find((i) => i.addOnKey === 'bed_pre_emergent');
    expect(bed).toMatchObject({ price: 278, applications: 2, perApplication: 139, maxPerYear: AREA_ADDONS.items.bed_pre_emergent.maxPerYear });
    expect(bed.detail).toContain('2 applications at $139 per application');
    expect(bed.detail).not.toMatch(/per visit/i);
    expect(mapped.oneTime.items.find((i) => i.addOnKey === 'fire_ant_yard')).toMatchObject({ applications: 1, perApplication: 129 });
  });

  test('the final projection keeps perApplication, and an unpriced custom-quote row carries null', () => {
    const estimate = generateEstimate({
      ...HOME,
      services: { areaAddOns: [{ key: 'fire_ant_yard', areaSqFt: 9000 }, { key: 'hardscape_weed', areaSqFt: 1000, applications: 2 }] },
    });
    const mapped = mapV1ToLegacyShape(estimate);
    expect(mapped.oneTime.specItems).toEqual([expect.objectContaining({ addOnKey: 'fire_ant_yard', perApplication: null })]);
    expect(mapped.specItems.find((i) => i.addOnKey === 'fire_ant_yard')).toMatchObject({ perApplication: null });
    expect(mapped.oneTime.items[0]).toMatchObject({ addOnKey: 'hardscape_weed', perApplication: 119, applications: 2 });
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

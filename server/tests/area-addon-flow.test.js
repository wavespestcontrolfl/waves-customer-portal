/**
 * Area add-ons, end to end behind GATE_AREA_ADDONS (owner rulings 2026-10-08):
 *   estimator options -> translateV2CallToV1Input -> generateEstimate -> mapper
 *   -> the public estimate's one-time rows, category, invoice label, copy and
 *   booking profile -> the catalog service the accept stamps -> the tax lookup.
 *
 * No database: the catalog and tax lookups run against the rows the migration
 * writes (area-addon-catalog-rows-migration.test.js owns the migration), through
 * small fakes of the exact queries slot-reservation and TaxCalculator issue.
 * The DATABASE_URL suites (accept transaction, completion invoice) run in CI.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
const { generateEstimate } = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { AREA_ADDONS } = require('../services/pricing-engine/constants');
const publicRoute = require('../routes/estimate-public');
const converter = require('../services/estimate-converter');
const copy = require('../services/estimate-one-time-copy');
const slotAvailability = require('../services/estimate-slot-availability');
const { catalogLinkForProfile } = require('../services/slot-reservation')._internals;
const migration = require('../models/migrations/20261008200000_area_addon_catalog_rows');

const ADDON_KEYS = Object.keys(AREA_ADDONS.items);
const PROFILE = { homeSqFt: 2000, lotSqFt: 7500 };
const AREA_FOR = (key) => (AREA_ADDONS.items[key].tiers ? AREA_ADDONS.items[key].tiers[0] : undefined);
const ALL_ENTRIES = ADDON_KEYS.map((key) => ({ key, ...(AREA_FOR(key) ? { areaSqFt: AREA_FOR(key) } : {}) }));

// Fixtures below price estimates while the describe blocks are collected, so the gate is on from the first line;
// the gate-off cases turn it off themselves and beforeEach restores it.
const savedGate = process.env.GATE_AREA_ADDONS;
process.env.GATE_AREA_ADDONS = 'true';
beforeEach(() => { process.env.GATE_AREA_ADDONS = 'true'; });
afterAll(() => {
  if (savedGate === undefined) delete process.env.GATE_AREA_ADDONS;
  else process.env.GATE_AREA_ADDONS = savedGate;
});

// The admin estimator's whole server leg: options -> engine input -> priced + mapped result.
function estimate(areaAddOns, { selected = [], options = {} } = {}) {
  const v1Input = translateV2CallToV1Input(PROFILE, selected, { grassType: 'A', ...options, ...(areaAddOns ? { areaAddOns } : {}) });
  const mapped = mapV1ToLegacyShape(generateEstimate(v1Input));
  return { v1Input, mapped, estData: { result: mapped, engineInputs: v1Input } };
}

describe('estimator translator: options.areaAddOns -> services.areaAddOns', () => {
  test('no option, null or an empty list adds nothing (byte-identical to before) and never needs the gate', () => {
    delete process.env.GATE_AREA_ADDONS;
    for (const options of [{}, { areaAddOns: null }, { areaAddOns: [] }]) {
      expect(translateV2CallToV1Input(PROFILE, ['PEST'], options).services).not.toHaveProperty('areaAddOns');
    }
  });

  test('entries become engine entries carrying only key and area; the visit rides once beside the list', () => {
    const { v1Input } = estimate([
      { key: 'bed_pre_emergent', areaSqFt: 1500, note: 'dropped', price: 1 },
      { key: 'web_sweep' },
    ]);
    expect(v1Input.services.areaAddOns).toEqual([
      { key: 'bed_pre_emergent', areaSqFt: 1500 },
      { key: 'web_sweep' },
    ]);
    expect(v1Input.services.areaAddOnVisit).toBe('standalone');
    expect(estimate([{ key: 'web_sweep' }], { selected: ['PEST'], options: { areaAddOnVisit: 'sameTripAddOn' } }).v1Input.services.areaAddOnVisit).toBe('sameTripAddOn');
    // No add-ons: no visit field either (byte-identical to before).
    expect(translateV2CallToV1Input(PROFILE, ['PEST'], { areaAddOnVisit: 'sameTripAddOn' }).services).not.toHaveProperty('areaAddOnVisit');
  });

  test('a visitContext on an add-on is refused (an old client would double-charge the drive); a bad group visit is refused', () => {
    for (const visitContext of ['standalone', 'sameTripAddOn', 'builderBatch', null]) {
      expect(() => estimate([{ key: 'web_sweep', visitContext }]))
        .toThrow(expect.objectContaining({ statusCode: 400, code: 'AREA_ADDON_VISIT_PER_ENTRY', failClosed: true, message: expect.stringMatching(/set once for all area add-ons/) }));
    }
    for (const areaAddOnVisit of ['builderBatch', '', 7]) {
      expect(() => estimate([{ key: 'web_sweep' }], { options: { areaAddOnVisit } }))
        .toThrow(expect.objectContaining({ statusCode: 400, code: 'AREA_ADDON_VISIT_INVALID', failClosed: true }));
    }
  });

  test('gate off: a non-empty list fails closed with a 400 the save replay rethrows', () => {
    delete process.env.GATE_AREA_ADDONS;
    expect(() => translateV2CallToV1Input(PROFILE, [], { areaAddOns: [{ key: 'web_sweep' }] }))
      .toThrow(expect.objectContaining({ statusCode: 400, code: 'AREA_ADDONS_GATED', failClosed: true }));
  });

  test.each([
    ['an object instead of a list', { key: 'web_sweep' }],
    ['a string', 'web_sweep'],
    ['a string entry', ['web_sweep']],
    ['a null entry', [null]],
    ['a nested list', [['web_sweep']]],
    ['the removed applications field', [{ key: 'bed_pre_emergent', areaSqFt: 1000, applications: 2 }]],
  ])('a malformed envelope (%s) is a 400 AREA_ADDON_INPUT_INVALID', (_label, areaAddOns) => {
    expect(() => translateV2CallToV1Input(PROFILE, [], { areaAddOns }))
      .toThrow(expect.objectContaining({ statusCode: 400, code: 'AREA_ADDON_INPUT_INVALID', failClosed: true }));
  });

  test('an unknown key or a missing area is the engine validator\'s fail-closed 400', () => {
    for (const bad of [{ key: 'aeration', areaSqFt: 1000 }, { key: 'fire_ant_yard' }]) {
      expect(() => estimate([bad])).toThrow(expect.objectContaining({ statusCode: 400, failClosed: true }));
    }
  });

  test('the lawn insect spot prices only for a grass the operator chose, and only St. Augustine', () => {
    const spot = [{ key: 'lawn_insect_spot', areaSqFt: 1000 }];
    const row = (options) => estimate(spot, { options }).mapped.oneTime;
    // The translator defaults an unpicked grass to St. Augustine: that default must not price a label-bound add-on.
    const { grassType: _drop, ...noGrass } = { grassType: undefined };
    const unpicked = translateV2CallToV1Input(PROFILE, [], { ...noGrass, areaAddOns: spot });
    expect(unpicked.services.areaAddOns[0].grassType).toBe('unknown');
    const unpickedMapped = mapV1ToLegacyShape(generateEstimate(unpicked)).oneTime;
    expect(unpickedMapped.items).toEqual([]);
    expect(unpickedMapped.specItems[0]).toMatchObject({ addOnKey: 'lawn_insect_spot', price: null, customQuoteReason: 'area_addon_grass_not_covered_by_label_rate' });
    expect(row({ grassType: 'A' }).items[0]).toMatchObject({ addOnKey: 'lawn_insect_spot', price: 79 });
    expect(row({ grassType: 'st_augustine' }).items[0].price).toBe(79);
    expect(row({ grassType: 'C1' }).specItems[0]).toMatchObject({ price: null, customQuoteReason: 'area_addon_grass_not_covered_by_label_rate' });
    // A grass-free add-on never gets a grass override.
    expect(estimate([{ key: 'fire_ant_yard', areaSqFt: 3000 }], { options: { grassType: 'C1' } }).v1Input.services.areaAddOns[0]).not.toHaveProperty('grassType');
  });

  test('an entry\'s own grass wins over the estimate\'s: unchosen or unknown quotes as custom, never the form default (Codex round 5 P1)', () => {
    const spot = (grassType) => [{ key: 'lawn_insect_spot', areaSqFt: 1000, ...(grassType === undefined ? {} : { grassType }) }];
    const sent = (grassType, options = { grassType: 'A' }) => estimate(spot(grassType), { options });
    const custom = { price: null, customQuoteReason: 'area_addon_grass_not_covered_by_label_rate' };
    // The form's default grass (A = St. Augustine) is on the estimate; the row's explicit unknown still quotes custom.
    for (const unchosen of ['unknown', '', '  ']) {
      expect(sent(unchosen).v1Input.services.areaAddOns[0].grassType).toBe(unchosen.trim() || 'unknown');
      expect(sent(unchosen).mapped.oneTime.specItems[0]).toMatchObject({ addOnKey: 'lawn_insect_spot', ...custom });
      expect(sent(unchosen).mapped.oneTime.items).toEqual([]);
    }
    // A chosen grass prices by itself, whatever the estimate's grass is.
    expect(sent('st_augustine', { grassType: 'C1' }).mapped.oneTime.items[0]).toMatchObject({ addOnKey: 'lawn_insect_spot', price: 79 });
    expect(sent('bermuda', { grassType: 'A' }).mapped.oneTime.specItems[0]).toMatchObject(custom);
    // No entry grass (an API caller): the estimate's grass applies, as before.
    expect(sent(undefined, { grassType: 'A' }).mapped.oneTime.items[0].price).toBe(79);
    // A grass-free add-on never takes an entry grass.
    expect(estimate([{ key: 'fire_ant_yard', areaSqFt: 3000, grassType: 'unknown' }]).v1Input.services.areaAddOns[0]).not.toHaveProperty('grassType');
  });

  test('a same-visit group is host-checked by the engine behind the same door', () => {
    const same = [{ key: 'web_sweep' }];
    const options = { areaAddOnVisit: 'sameTripAddOn' };
    expect(() => estimate(same, { options })).toThrow(/Add-ons on the same visit need a priced service/);
    expect(estimate(same, { selected: ['PEST'], options }).mapped.oneTime.items[0]).toMatchObject({ addOnKey: 'web_sweep', price: 59, visitContext: 'sameTripAddOn', carriesVisitDrive: false });
  });

  test('null grass on a label-bound add-on is "not chosen": it never borrows the form grass (client sends unknown)', () => {
    const spot = [{ key: 'lawn_insect_spot', areaSqFt: 1000, grassType: null }];
    expect(estimate(spot, { options: { grassType: 'A' } }).v1Input.services.areaAddOns[0].grassType).toBe('unknown');
    expect(estimate(spot, { options: { grassType: 'A' } }).mapped.oneTime.specItems[0]).toMatchObject({ addOnKey: 'lawn_insect_spot', price: null });
  });
});

describe('the estimate page classifies an add-on row by its key, not its name', () => {
  const { mapped, estData } = estimate(ALL_ENTRIES, { options: { grassType: 'A' } });
  const rows = publicRoute.normalizeOneTimeBreakdown(estData).items;
  const byKey = Object.fromEntries(rows.map((r) => [r.addOnKey, r]));

  test('the public one-time rows keep the add-on key, catalog key, family, tier and visit context', () => {
    expect(rows).toHaveLength(6);
    for (const [key, cfg] of Object.entries(AREA_ADDONS.items)) {
      expect(byKey[key]).toMatchObject({
        service: 'area_addon',
        label: cfg.name,
        catalogServiceKey: cfg.serviceKey,
        addOnCategory: cfg.category,
        visitContext: 'standalone',
        kind: 'charge',
      });
      expect(byKey[key].amount).toBeGreaterThan(0);
    }
    expect(byKey.web_sweep.tierSqFt).toBeUndefined();
    expect(byKey.bed_pre_emergent).toMatchObject({ tierSqFt: 1000, areaSqFt: 1000 });
    expect(mapped.oneTime.total).toBe(rows.reduce((sum, r) => sum + r.amount, 0));
  });

  test('category comes from the add-on key: web sweep is pest control, the rest lawn care', () => {
    for (const [key, cfg] of Object.entries(AREA_ADDONS.items)) {
      expect([key, publicRoute.serviceCategoryForOneTimeItem(byKey[key])]).toEqual([key, cfg.category]);
      expect(publicRoute.collectServiceCategories([], [byKey[key]])).toEqual(new Set([cfg.category]));
    }
    // A row with the add-on service but no usable key has no family: never a name guess.
    expect(publicRoute.serviceCategoryForOneTimeItem({ service: 'area_addon', name: 'Fire Ant Yard Treatment', amount: 99 })).toBeNull();
    expect(publicRoute.serviceCategoryForOneTimeItem({ service: 'area_addon', addOnKey: 'constructor', name: 'Web Sweep', amount: 89 })).toBeNull();
  });

  test('no add-on is the general one-time pest job: "Fire Ant Yard Treatment" matches no pest name rule', () => {
    for (const row of rows) {
      expect([row.addOnKey, publicRoute.isGeneralPestOneTimeItem(row)]).toEqual([row.addOnKey, false]);
      expect([row.addOnKey, converter.isGeneralPestOneTimeItem(row)]).toEqual([row.addOnKey, false]);
    }
    expect(publicRoute.detectPestOneTime(rows)).toBe(false);
    // The raw mapper rows (what the SSR page reads) too, and the name-only guess that used to fire.
    expect(publicRoute.isGeneralPestOneTimeItem({ service: 'area_addon', name: 'Fire Ant Yard Treatment' })).toBe(false);
    expect(publicRoute.isGeneralPestOneTimeItem({ service: 'one_time_pest_ant', name: 'Ant treatment' })).toBe(true);
  });

  test('the only-lawn mix rule: lawn add-ons keep a lawn-only estimate lawn-only, the web sweep does not', () => {
    const lawnRecurring = [{ service: 'lawn_care', name: 'Lawn Care' }];
    const lawnRows = rows.filter((r) => r.addOnCategory === 'lawn_care');
    expect(publicRoute.hasOnlyLawnCareServiceMix(lawnRecurring, lawnRows)).toBe(true);
    expect(publicRoute.hasOnlyLawnCareServiceMix(lawnRecurring, [...lawnRows, byKey.web_sweep])).toBe(false);
    for (const row of rows) {
      expect(publicRoute.isLawnCareOneTimeItem(row)).toBe(row.addOnCategory === 'lawn_care');
      expect(converter.isLawnCareOneTimeItem(row)).toBe(row.addOnCategory === 'lawn_care');
    }
  });

  test('the invoice label of each add-on is its own name, not a pest or generic one-time label', () => {
    for (const [key, cfg] of Object.entries(AREA_ADDONS.items)) {
      const label = publicRoute.buildOneTimeInvoiceServiceLabel({ estimate: {}, estData, oneTimeList: [byKey[key]] });
      expect([key, label]).toEqual([key, cfg.name]);
    }
  });

  test('an add-ons-only estimate is structurally one-time and its choice category is not turned into a bundle', () => {
    expect(publicRoute.isStructuralOneTimeOnlyEstimate(estData, {})).toBe(true);
    // Add-ons ride alongside a pest estimate\'s cadence: they do not make it a mixed "bundle".
    const withPest = estimate([{ key: 'fire_ant_yard', areaSqFt: 3000 }], { selected: ['PEST'] });
    expect(publicRoute.serviceCategoryForOneTimeChoice(withPest.estData)).toBe('pest_control');
    expect(publicRoute.oneTimeChoiceClassificationItems(publicRoute.normalizeOneTimeBreakdown(withPest.estData).items).filter((r) => r.service === 'area_addon')).toEqual([]);
    // ...and a pest-choice estimate keeps the add-on as a preserved add-on row with its key.
    const preserved = publicRoute.preservedOneTimeAddOnRowsFromBreakdown(publicRoute.normalizeOneTimeBreakdown(withPest.estData));
    expect(preserved).toEqual([expect.objectContaining({ service: 'area_addon', addOnKey: 'fire_ant_yard', catalogServiceKey: 'area_addon_fire_ant_yard', price: 99 })]);
  });

  describe('a manual discount never cuts an add-on row on the one-time choice path (Codex round 5 P1)', () => {
    const engineWith = (manualDiscount) => estimate(
      [{ key: 'web_sweep' }, { key: 'fire_ant_yard', areaSqFt: 3000 }],
      { selected: ['PEST'], options: { manualDiscount } },
    );
    const pestEstimate = { show_one_time_option: true };
    const choice = (estData) => ({
      amount: publicRoute.oneTimeChoiceAmountForEstimate(pestEstimate, estData),
      list: publicRoute.acceptedOneTimeChoiceListForEstimate(pestEstimate, estData),
    });
    const addOnPrices = (list) => Object.fromEntries(list.filter((r) => r.service === 'area_addon').map((r) => [r.addOnKey, r.price]));

    test.each([
      ['a percentage', { type: 'PERCENT', value: 10, label: 'Ten percent off' }],
      ['a fixed amount', { type: 'FIXED', value: 50, label: 'Fifty off' }],
    ])('%s keeps every add-on row at the engine price and out of the discount base', (_label, manualDiscount) => {
      const { estData, mapped } = engineWith(manualDiscount);
      const enginePrices = Object.fromEntries(mapped.oneTime.items.filter((r) => r.service === 'area_addon').map((r) => [r.addOnKey, r.price]));
      expect(enginePrices).toEqual({ web_sweep: 89, fire_ant_yard: 69 });
      // The engine took nothing from the add-ons: their rows sum to the full price.
      expect(Object.values(enginePrices).reduce((a, b) => a + b, 0)).toBe(158);
      const { amount, list } = choice(estData);
      expect(addOnPrices(list)).toEqual(enginePrices);
      expect(list.filter((r) => r.service === 'area_addon').every((r) => r.grossPrice === undefined && r.manualDiscountApplied === undefined)).toBe(true);
      const pestRow = list.find((r) => r.service === 'one_time_pest');
      expect(amount).toBe(Math.round((pestRow.price + 89 + 69) * 100) / 100);
    });

    test('rows mixed with a discountable specialty: only the specialty is cut, and the cut is the whole slice', () => {
      const { applyManualOneTimeDiscountToChoiceRows: apply } = publicRoute;
      const roach = { service: 'pest_initial_roach', name: 'Initial Roach Knockdown', label: 'Initial Roach Knockdown', price: 200 };
      const sweep = { service: 'area_addon', addOnKey: 'web_sweep', name: 'Web Sweep', label: 'Web Sweep', price: 59 };
      const ants = { service: 'area_addon', addOnKey: 'fire_ant_yard', name: 'Fire Ant Yard Treatment', label: 'Fire Ant Yard Treatment', price: 99 };
      const percent = apply([sweep, roach, ants], { type: 'PERCENT', value: 10 });
      expect(percent.map((r) => r.price)).toEqual([59, 180, 99]);
      expect(percent[1]).toMatchObject({ grossPrice: 200, manualDiscountApplied: 20 });
      expect(percent[0]).toBe(sweep);
      expect(percent[2]).toBe(ants);
      // FIXED uses the engine's slice, capped to the discountable rows only (never to the add-ons too).
      expect(apply([sweep, roach, ants], { type: 'FIXED', value: 500, oneTimeAmount: 40 }).map((r) => r.price)).toEqual([59, 160, 99]);
      expect(apply([sweep, roach, ants], { type: 'FIXED', value: 500, oneTimeAmount: 999 }).map((r) => r.price)).toEqual([59, 0, 99]);
    });

    test('an add-on-only list has nothing to discount and comes back untouched', () => {
      const { applyManualOneTimeDiscountToChoiceRows: apply } = publicRoute;
      const rows = [{ service: 'area_addon', addOnKey: 'web_sweep', price: 59 }, { service: 'area_addon', addOnKey: 'fire_ant_yard', price: 99 }];
      for (const manualDiscount of [{ type: 'PERCENT', value: 25 }, { type: 'FIXED', value: 40, oneTimeAmount: 40 }]) {
        expect(apply(rows, manualDiscount)).toBe(rows);
      }
    });

    test('an add-on-only estimate with a manual discount keeps the engine\'s price and total', () => {
      for (const manualDiscount of [{ type: 'PERCENT', value: 25 }, { type: 'FIXED', value: 40 }]) {
        const { mapped } = estimate([{ key: 'web_sweep' }, { key: 'fire_ant_yard', areaSqFt: 3000 }], { options: { manualDiscount } });
        expect(mapped.oneTime.items.map((r) => r.price)).toEqual([89, 69]);
        expect(mapped.oneTime.total).toBe(158);
      }
    });
  });

  test('the render rows and the acceptance list keep the add-on fields', () => {
    const rendered = publicRoute.oneTimeItemsForRender({}, estData);
    expect(rendered).toHaveLength(6);
    for (const row of rendered) expect(row).toMatchObject({ service: 'area_addon', addOnKey: expect.any(String), catalogServiceKey: expect.stringMatching(/^area_addon_/) });
    const { oneTimeList } = publicRoute.acceptanceServiceLists({ result: { oneTime: { items: [], specItems: [] } }, engineResult: undefined, ...{} });
    expect(oneTimeList).toEqual([]);
    const fromNormalized = publicRoute.acceptanceServiceLists({ engineResult: { oneTime: { items: rows.map((r) => ({ service: r.service, label: r.label, price: r.amount, ...r })) } } });
    expect(fromNormalized.oneTimeList.every((row) => row.service === 'area_addon' && row.addOnKey)).toBe(true);
  });

  test('an add-on never adopts the customer\'s ordinary visit: its adoption identity is specific, never a broad family', () => {
    const BROAD = new Set(['pest_control', 'lawn_care', 'tree_shrub', 'mosquito', 'rodent', 'rodent_bait', 'termite_bait']);
    for (const row of rows) {
      const keys = publicRoute.oneTimeItemFamilyKeys(row);
      expect([row.addOnKey, keys.filter((k) => BROAD.has(k))]).toEqual([row.addOnKey, []]);
    }
  });

  test('the public payload strips the internal on-site minutes and keeps the identity fields', () => {
    const { items } = publicRoute.sanitizePublicOneTimeBreakdown({ items: rows });
    for (const item of items) {
      expect(item).not.toHaveProperty('onSiteMinutes');
      expect(item).toHaveProperty('catalogServiceKey');
      expect(item).not.toHaveProperty('applications');
      expect(item).not.toHaveProperty('perApplication');
    }
    expect(rows[0].onSiteMinutes).toBeGreaterThan(0);
  });
});

describe('customer copy for each add-on', () => {
  const { estData } = estimate(ALL_ENTRIES, { options: { grassType: 'A' } });
  const rows = publicRoute.normalizeOneTimeBreakdown(estData).items;
  const copyOf = (key) => copy.resolveOneTimeServiceCopy(rows.find((r) => r.addOnKey === key));

  test('every add-on resolves its own pack entry with the area tier and the visit basis filled in', () => {
    for (const key of ADDON_KEYS) {
      const resolved = copyOf(key);
      expect(resolved.key).toBe(`area_addon_${key}`);
      expect(resolved.includes.join(' ')).not.toMatch(/\{Area\}|\{Visit\}/);
      // Several add-ons share one own visit: the line that carries the drive is "its own visit", the rest ride on it.
      expect(resolved.includes).toContain(key === ADDON_KEYS[0] ? 'Priced as its own visit' : 'Done on the same visit as your other add-on treatments');
      expect(resolved.assurance).toBeNull();
      expect(resolved.terms).toBe('One application. Pay on service day. No recurring schedule, no tier discount.');
      const tier = AREA_ADDONS.items[key].tiers;
      if (tier) expect(resolved.includes[0]).toContain(`up to ${tier[0].toLocaleString('en-US')} sq ft`);
    }
    const sameVisit = copy.resolveOneTimeServiceCopy({ ...rows.find((r) => r.addOnKey === 'web_sweep'), visitContext: 'sameTripAddOn' });
    expect(sameVisit.includes).toContain('Priced for the same visit as your other booked service');
    // A row stored before the drive flag existed keeps the own-visit wording.
    const { carriesVisitDrive: _flag, ...legacy } = rows.find((r) => r.addOnKey === 'web_sweep');
    expect(copy.resolveOneTimeServiceCopy(legacy).includes).toContain('Priced as its own visit');
  });

  test('copy makes no result, warranty, guarantee or brand claim', () => {
    const text = JSON.stringify(ADDON_KEYS.map((key) => ({ ...copy.ONE_TIME_SERVICE_COPY[`area_addon_${key}`] })));
    expect(text).not.toMatch(/guarante|warrant|eliminat|kill|permanent|100%|prevent(?!ive)|Snapshot|Arena|Topchoice|Acelepryn|Roundup/i);
  });

  test('a quote-required, unknown-key or key-less add-on row gets no copy (no entry, no new claims)', () => {
    expect(copy.resolveOneTimeServiceCopy({ service: 'area_addon', addOnKey: 'fire_ant_yard', quoteRequired: true })).toBeNull();
    expect(copy.resolveOneTimeServiceCopy({ service: 'area_addon', addOnKey: 'nope', tierSqFt: 1000 })).toBeNull();
    expect(copy.resolveOneTimeServiceCopy({ service: 'area_addon', name: 'Fire Ant Yard Treatment' })).toBeNull();
  });

  test('a single-add-on estimate gets that add-on\'s hero; two add-ons keep the generic copy', () => {
    const one = copy.oneTimeOnlyIntelligenceCopy([rows.find((r) => r.addOnKey === 'web_sweep')]);
    expect(one.key).toBe('area_addon_web_sweep');
    expect(one.hero.h1).toBe('Hello {first}, your web sweep quote is ready!');
    expect(copy.oneTimeOnlyIntelligenceCopy(rows.slice(0, 2))).toBeNull();
  });

  test('the packet guide is not unlocked by an add-on (the lawn guide needs a recurring lawn line or a listed one-time lawn row)', () => {
    const source = require('fs').readFileSync(require.resolve('../routes/estimate-public'), 'utf8');
    const set = /const ONE_TIME_LAWN_GUIDE_SERVICES = new Set\(\[([^\]]*)\]\)/.exec(source)[1];
    expect(set).not.toMatch(/area_addon/);
  });
});

describe('booking: the accept stamps each add-on\'s own catalog service and the engine minutes', () => {
  const { mapped, estData } = estimate(ALL_ENTRIES, { options: { grassType: 'A' } });
  const profileServices = slotAvailability._internals.oneTimeProfileServices({}, estData);

  test('the one-time profile carries one service per add-on: family, raw engine key, exact catalog key and a duration floor', () => {
    expect(profileServices).toHaveLength(6);
    for (const [key, cfg] of Object.entries(AREA_ADDONS.items)) {
      const row = profileServices.find((s) => s.label === cfg.name);
      expect(row).toMatchObject({ service: cfg.category, engineKey: 'area_addon', catalogServiceKey: cfg.serviceKey });
      const mappedRow = mapped.oneTime.items.find((i) => i.addOnKey === key);
      expect(row.durationMinutes).toBe(Math.ceil(mappedRow.onSiteMinutes));
      expect(row.durationMinutes).toBeGreaterThan(0);
    }
  });

  test('the slot profile of a one-time accept lists every add-on in the service mix', () => {
    const profile = slotAvailability.resolveEstimateSlotProfile(
      { show_one_time_option: false, estimate_data: estData },
      { serviceMode: 'one_time' },
    );
    expect(profile.services).toHaveLength(6);
    for (const cfg of Object.values(AREA_ADDONS.items)) expect(profile.serviceLabel).toContain(cfg.name.split(' ')[0]);
  });

  // Rows the migration writes, read through the exact-key query slot-reservation issues.
  function catalogConn() {
    const db = { services: [], service_completion_profiles: [], service_taxability: [], system_settings: [] };
    const knex = (table) => {
      const q = {
        where: (cond) => { q.cond = cond; return q; },
        first: async () => db[table].find((r) => Object.entries(q.cond || {}).every(([k, v]) => r[k] === v)),
        insert: (row) => { db[table].push({ id: `${table}-${db[table].length + 1}`, ...row }); const p = Promise.resolve([1]); p.returning = async () => [{ id: db[table][db[table].length - 1].id }]; return p; },
      };
      return q;
    };
    knex.schema = { hasTable: async (t) => t in db, hasColumn: async () => true };
    return { db, knex };
  }

  test('each add-on resolves to its own catalog row by the exact key, never by containment or name', async () => {
    const { db, knex } = catalogConn();
    await migration.up(knex);
    const lookups = [];
    const conn = () => ({
      where: (w) => ({ limit: () => ({ select: () => Promise.resolve((lookups.push(w), db.services.filter((r) => r.service_key === w.service_key))) }) }),
      whereRaw: () => { throw new Error('containment must not run'); },
    });
    conn.transaction = async (cb) => cb(conn);
    for (const cfg of Object.values(AREA_ADDONS.items)) {
      const service = profileServices.find((s) => s.catalogServiceKey === cfg.serviceKey);
      const link = await catalogLinkForProfile(conn, { serviceMode: 'one_time', services: [service] });
      expect(link).toMatchObject({ service_key: cfg.serviceKey, name: cfg.name });
    }
    expect(lookups.map((w) => w.service_key).sort()).toEqual(Object.values(AREA_ADDONS.items).map((c) => c.serviceKey).sort());
  });

  test('with several add-ons on one accept the visit is stamped with the pest-family service first, then the first add-on (one appointment carries the mix)', async () => {
    const { db, knex } = catalogConn();
    await migration.up(knex);
    const stamped = [];
    const conn = () => ({
      where: (w) => ({ limit: () => ({ select: () => Promise.resolve((stamped.push(w.service_key), db.services.filter((r) => r.service_key === w.service_key))) }) }),
    });
    conn.transaction = async (cb) => cb(conn);
    await catalogLinkForProfile(conn, { serviceMode: 'one_time', services: profileServices });
    expect(stamped).toEqual(['area_addon_web_sweep']);
    const lawnOnly = profileServices.filter((s) => s.service === 'lawn_care');
    stamped.length = 0;
    await catalogLinkForProfile(conn, { serviceMode: 'one_time', services: lawnOnly });
    expect(stamped).toEqual([lawnOnly[0].catalogServiceKey]);
  });
});

describe('invoice tax: residential is not taxed, commercial is, for every add-on', () => {
  const TaxCalculator = require('../services/tax-calculator');

  // The exact queries calculateTax issues, evaluated against the migration's rows.
  function taxConn(rows, customer) {
    const evalClauses = (clauses) => (row) => clauses.some((c) => c(row));
    const conn = (table) => {
      const filters = [];
      const b = {
        where(arg) {
          if (typeof arg === 'function') {
            const clauses = [];
            const rec = {
              where: (col, val) => { clauses.push((row) => row[col] === val); return rec; },
              orWhere: (col, op, val) => {
                clauses.push((row) => {
                  const hay = String(row[col] || '').toLowerCase();
                  const needle = String(val).toLowerCase().replace(/%/g, '');
                  return op === 'ilike' ? hay.includes(needle) : row[col] === op;
                });
                return rec;
              },
              whereNull: () => rec,
              orWhereNotNull: () => rec,
            };
            arg.call(rec);
            filters.push(evalClauses(clauses));
          } else if (arg && typeof arg === 'object') filters.push((row) => Object.entries(arg).every(([k, v]) => row[k] === v));
          return b;
        },
        andWhere(arg) { return typeof arg === 'function' ? b.where(arg) : b; },
        orderBy: () => b,
        first: async () => (rows[table] || []).find((r) => filters.every((f) => f(r))),
      };
      return b;
    };
    rows.customers = [customer];
    return conn;
  }

  async function taxFor(serviceType, propertyType) {
    const db = { services: [], service_completion_profiles: [], service_taxability: [], system_settings: [] };
    const knex = (table) => ({
      where: (cond) => ({ first: async () => db[table].find((r) => Object.entries(cond).every(([k, v]) => r[k] === v)) }),
      insert: (row) => { db[table].push({ id: `${table}-${db[table].length + 1}`, ...row }); const p = Promise.resolve([1]); p.returning = async () => [{ id: db[table][db[table].length - 1].id }]; return p; },
    });
    knex.schema = { hasTable: async (t) => t in db, hasColumn: async () => true };
    await migration.up(knex);
    const conn = taxConn({
      service_taxability: db.service_taxability,
      tax_exemptions: [],
      tax_rates: [{ county: 'Manatee', combined_rate: '0.07', state_rate: '0.06', county_surtax: '0.01', effective_date: '2020-01-01', active: true }],
    }, { id: 'c1', property_type: propertyType, zip: '34202' });
    return TaxCalculator.calculateTax('c1', serviceType, 100, { database: conn });
  }

  test.each(Object.values(AREA_ADDONS.items).map((cfg) => [cfg.name]))('%s: a residential customer pays no tax and a commercial customer pays the county rate', async (name) => {
    const residential = await taxFor(name, 'single_family');
    expect(residential).toMatchObject({ taxable: false, rate: 0, amount: 0 });
    const commercial = await taxFor(name, 'commercial');
    expect(commercial).toMatchObject({ taxable: true, rate: 0.07, amount: 7 });
  });
});

describe('gate off: every new path refuses or is absent', () => {
  test('translator, engine and catalog refuse; no add-on field leaks into a plain estimate', () => {
    delete process.env.GATE_AREA_ADDONS;
    expect(() => estimate([{ key: 'web_sweep' }])).toThrow(expect.objectContaining({ code: 'AREA_ADDONS_GATED', failClosed: true }));
    const plain = estimate(null, { selected: ['PEST'] });
    expect(JSON.stringify(plain.mapped)).not.toMatch(/area_addon|addOnKey|catalogServiceKey|onSiteMinutes/);
    expect(JSON.stringify(plain.v1Input)).not.toMatch(/areaAddOns/);
  });

  test('the one-time classifiers behave as before for any other row', () => {
    delete process.env.GATE_AREA_ADDONS;
    expect(publicRoute.serviceCategoryForOneTimeItem({ service: 'dethatching', name: 'Lawn Dethatching', amount: 150 })).toBe('lawn_care');
    expect(publicRoute.serviceCategoryForOneTimeItem({ service: 'one_time_pest', name: 'One-Time Pest Control', amount: 150 })).toBe('pest_control');
    expect(publicRoute.isGeneralPestOneTimeItem({ service: 'one_time_pest', name: 'One-Time Pest Control' })).toBe(true);
    expect(converter.isGeneralPestOneTimeItem({ service: 'one_time_pest', name: 'One-Time Pest Control' })).toBe(true);
    expect(converter.isLawnCareOneTimeItem({ service: 'one_time_lawn', name: 'Lawn Pest Knockdown' })).toBe(true);
  });
});

describe('the admin save replays the estimator request and the stored engine inputs (nothing whitelists them)', () => {
  const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');
  const deps = { needsSync: () => false, syncConstantsFromDB: jest.fn() };
  const request = (areaAddOns) => ({
    engineRequest: { profile: PROFILE, selectedServices: ['PEST'], options: { grassType: 'A', areaAddOns } },
  });

  test('the save recompute prices the add-ons from engineRequest.options and stores replayable engine inputs', async () => {
    const out = await serverRecomputeFromEstimateData(request([{ key: 'fire_ant_yard', areaSqFt: 5000 }, { key: 'web_sweep' }]), deps);
    expect(out.recomputed).toBe(true);
    const rows = out.serverResult.oneTime.items.filter((i) => i.service === 'area_addon');
    expect(rows.map((r) => [r.addOnKey, r.price, r.catalogServiceKey])).toEqual([
      ['fire_ant_yard', 129, 'area_addon_fire_ant_yard'],
      ['web_sweep', 59, 'area_addon_web_sweep'],
    ]);
    // The stored shape is detected by the kill-switch guard, and replays through the engine alone.
    const stored = { engineRequest: request([{ key: 'web_sweep' }]).engineRequest, result: out.serverResult };
    expect(require('../services/pricing-engine/v1-legacy-mapper').estimateDataCarriesAreaAddOns(stored)).toBe(true);
    const replay = await serverRecomputeFromEstimateData({ engineInputs: { ...PROFILE, services: { areaAddOns: [{ key: 'web_sweep' }] } } }, deps);
    expect(replay.serverResult.oneTime.items.find((i) => i.service === 'area_addon')).toMatchObject({ addOnKey: 'web_sweep', price: 89 });
  });

  test('an add-on-only request with no property data prices at translate, calculate and save (the estimator sends home and lot as 0)', async () => {
    const { needsTurfManualConfirmation } = require('../routes/property-lookup-v2');
    const EMPTY = { homeSqFt: 0, lotSqFt: 0 };
    const cases = [
      [[{ key: 'web_sweep' }], [['web_sweep', 89]]],
      [[{ key: 'fire_ant_yard', areaSqFt: 3000 }], [['fire_ant_yard', 99]]],
      [[{ key: 'web_sweep' }, { key: 'bed_pre_emergent', areaSqFt: 1000 }], [['web_sweep', 89], ['bed_pre_emergent', 69]]],
    ];
    for (const [areaAddOns, expected] of cases) {
      const options = { grassType: 'st_augustine', areaAddOns };
      expect(needsTurfManualConfirmation(EMPTY, [], options)).toBeNull();
      const mapped = mapV1ToLegacyShape(generateEstimate(translateV2CallToV1Input(EMPTY, [], options)));
      expect(mapped.oneTime.items.map((r) => [r.addOnKey, r.price])).toEqual(expected);
      expect(mapped.oneTime.specItems).toEqual([]);
      const saved = await serverRecomputeFromEstimateData({ engineRequest: { profile: EMPTY, selectedServices: [], options } }, deps);
      expect(saved.recomputed).toBe(true);
      expect(saved.serverResult.oneTime.items.map((r) => [r.addOnKey, r.price])).toEqual(expected);
    }
  });

  test('gate off: the save fails closed (never the browser-priced fallback) for the request and for stored engine inputs', async () => {
    delete process.env.GATE_AREA_ADDONS;
    await expect(serverRecomputeFromEstimateData(request([{ key: 'web_sweep' }]), deps))
      .rejects.toMatchObject({ statusCode: 400, code: 'AREA_ADDONS_GATED', failClosed: true });
    await expect(serverRecomputeFromEstimateData({ engineInputs: { ...PROFILE, services: { areaAddOns: [{ key: 'web_sweep' }] } } }, deps))
      .rejects.toMatchObject({ code: 'AREA_ADDONS_GATED', failClosed: true });
  });
});

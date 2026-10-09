/**
 * The area add-on prices are DB-authoritative (Codex round 9 on #6135): pricing_config row `area_addon_pricing`, seeded by
 * migration 20261010110000, synced over AREA_ADDONS by db-bridge on every sync, edited on the Pricing Logic panel's generic
 * One-time card, validated with bounds and a fail-closed fallback to the code defaults. A stored estimate replays the knobs it
 * was priced with. The label-bound fields (yearly limits, grass, product, identity) stay in code and no row reaches them.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const path = require('path');
const constants = require('../services/pricing-engine/constants');
const { AREA_ADDONS } = constants;
const { syncConstantsFromDB } = require('../services/pricing-engine/db-bridge');
const config = require('../services/pricing-engine/area-addon-config');
const { generateEstimate, priceAreaAddOn } = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { areaAddOnKnobSignalForReplay } = require('../services/estimate-area-addon-knob-replay');
const migration = require('../models/migrations/20261010110000_area_addon_pricing_config');

const HOME = { homeSqFt: 2000, lotSqFt: 7500 };
const LABEL_BOUND = ['maxPerYear', 'minDaysApart', 'requiresGrassTrack', 'limitProduct', 'serviceKey', 'name', 'category', 'areaLabel'];

function pricingConfigDb(rows) {
  const db = (table) => {
    const query = {
      select: jest.fn(async () => (table === 'pricing_config' ? rows : [])),
      orderBy: jest.fn(() => query),
      then: (resolve) => resolve([]),
    };
    return query;
  };
  db.schema = { hasTable: jest.fn(async () => true) };
  return db;
}
const row = (data) => [{ config_key: 'area_addon_pricing', data }, { config_key: 'global_labor_rate', data: { value: constants.GLOBAL.LABOR_RATE } }];
const sync = (data) => syncConstantsFromDB(pricingConfigDb(data === undefined ? row(undefined).slice(1) : row(data)));
const seed = () => JSON.parse(JSON.stringify(config.defaultAreaAddOnPricingData()));
const live = () => JSON.parse(JSON.stringify(AREA_ADDONS));

let savedGate;
let pristine;
beforeAll(() => { savedGate = process.env.GATE_AREA_ADDONS; process.env.GATE_AREA_ADDONS = 'true'; pristine = live(); });
afterAll(async () => { if (savedGate === undefined) delete process.env.GATE_AREA_ADDONS; else process.env.GATE_AREA_ADDONS = savedGate; });
afterEach(() => { config.rebaseAreaAddOns(); });

describe('the seed row is the code table, and the code table is the default', () => {
  test('the migration seeds exactly the in-code values (rate, setup, minutes, tiers, margin, admin) and no label-bound field', () => {
    expect(migration.SEED).toEqual(seed());
    for (const item of Object.values(migration.SEED.items)) for (const field of LABEL_BOUND) expect(item).not.toHaveProperty(field);
    expect(migration.SEED.items.web_sweep).not.toHaveProperty('tiers');
    expect(config.normalizeAreaAddOnPricingConfig(migration.SEED)).toMatchObject({ ok: true });
  });

  test('the frozen defaults are the table as written, not a view of the live one', () => {
    const defaults = constants.areaAddOnPricingDefaults();
    expect(defaults.items.bed_pre_emergent).toEqual({ materialPer1000: 10.32, setupMin: 6, minPer1000: 8, tiers: [1000, 2000, 3500] });
    expect(Object.isFrozen(defaults)).toBe(true);
    // exported through a function, never as an object: db-bridge snapshots and restores every object export in place
    expect(typeof constants.areaAddOnPricingDefaults).toBe('function');
    expect(Object.values(constants)).not.toContain(defaults);
  });

  test('up inserts the row once (category one_time, so it lists on the One-time tab), never overwrites; down removes it only while unedited', async () => {
    const rows = [];
    const knex = (table) => {
      if (table !== 'pricing_config') throw new Error(`unexpected ${table}`);
      let key;
      const q = {
        where(cond) { key = cond.config_key; return q; },
        first() { return Promise.resolve(rows.find((r) => r.config_key === key)); },
        insert(r) { return { onConflict: () => ({ ignore: async () => { rows.push({ ...r }); } }) }; },
        async del() { const i = rows.findIndex((r) => r.config_key === key); if (i >= 0) rows.splice(i, 1); },
      };
      return q;
    };
    knex.schema = { hasTable: async () => true };
    knex.fn = { now: () => 'now()' };
    await migration.up(knex);
    await migration.up(knex);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ config_key: 'area_addon_pricing', category: 'one_time' });
    // jsonb hands the keys back in another order: the comparison is by value
    rows[0].data = JSON.stringify({ items: Object.fromEntries(Object.entries(migration.SEED.items).reverse()), adminPerJob: 8, targetMargin: 0.6 });
    await migration.down(knex);
    expect(rows).toHaveLength(0);
    await migration.up(knex);
    rows[0].data = JSON.stringify({ ...migration.SEED, adminPerJob: 9 });
    await migration.down(knex);
    expect(rows).toHaveLength(1);
  });
});

describe('validation: bounds, plain JSON numbers, and no label-bound field', () => {
  const edit = (patch) => ({ ...seed(), ...patch });
  const bad = (data, pattern, opts) => expect(config.normalizeAreaAddOnPricingConfig(data, opts)).toMatchObject({ ok: false, error: expect.stringMatching(pattern) });

  test.each([
    [{ targetMargin: 0.9 }, /targetMargin/], [{ targetMargin: 0.1 }, /targetMargin/], [{ targetMargin: '0.6' }, /targetMargin/],
    [{ adminPerJob: -1 }, /adminPerJob/], [{ adminPerJob: 500 }, /adminPerJob/], [{ adminPerJob: null }, /adminPerJob/],
  ])('%j is refused', (patch, pattern) => bad(edit(patch), pattern));

  test('per add-on: material, setup minutes, minutes per 1,000 and tiers are bounded; strings and booleans are not numbers', () => {
    const item = (patch) => edit({ items: { fire_ant_yard: { ...seed().items.fire_ant_yard, ...patch } } });
    bad(item({ materialPer1000: 201 }), /materialPer1000/);
    bad(item({ materialPer1000: -1 }), /materialPer1000/);
    bad(item({ setupMin: 241 }), /setupMin/);
    bad(item({ minPer1000: '2.5' }), /minPer1000/);
    bad(item({ minPer1000: true }), /minPer1000/);
    bad(item({ tiers: [] }), /tiers/);
    bad(item({ tiers: [3000, 3000] }), /tiers/);
    bad(item({ tiers: [5000, 3000] }), /tiers/);
    bad(item({ tiers: [50] }), /tiers/);
    bad(item({ tiers: [1000, 2000, 3000, 4000, 5000, 6000, 7000] }), /tiers/);
    bad(item({ tiers: [1000.5] }), /tiers/);
    bad(edit({ items: { web_sweep: { tiers: [1000] } } }), /no area tiers/);
    bad(null, /object/);
    bad([], /object/);
    expect(config.normalizeAreaAddOnPricingConfig(item({ materialPer1000: 4.5, tiers: [2000, 4000, 9000] }))).toMatchObject({ ok: true });
  });

  test.each(LABEL_BOUND)('the admin PUT refuses %s (set in code); the sync ignores it', (field) => {
    const data = edit({ items: { fire_ant_yard: { ...seed().items.fire_ant_yard, [field]: 'x' } } });
    bad(data, new RegExp(`${field} is set in code`));
    expect(config.normalizeAreaAddOnPricingConfig(data, { strict: false })).toMatchObject({ ok: true });
  });

  test('an unknown add-on or an unknown top-level key is refused by the PUT and ignored by the sync', () => {
    bad(edit({ items: { not_an_addon: {} } }), /not an add-on/);
    bad({ ...seed(), surprise: 1 }, /not a setting/);
    expect(config.normalizeAreaAddOnPricingConfig({ ...seed(), surprise: 1 }, { strict: false })).toMatchObject({ ok: true });
  });

  test('the admin PUT validates it with the same function, before the write', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-pricing-config.js'), 'utf8');
    expect(src).toContain('const OWN_VALIDATORS = { area_addon_pricing: validateAreaAddOnPricing };');
    expect(src).toContain('const verdict = config.normalizeAreaAddOnPricingConfig(data);');
    expect(src).toContain('const verdict = validatePricingConfigFor(req.params.key, normalizedData, oldConfig);');
    expect(src).toContain("config_key: 'area_addon_pricing', name: 'Area Add-On Treatment Pricing', category: 'one_time'");
  });
});

// Codex round 35: the PUT replaces the whole stored object; a partial payload would reset every tuned value it leaves out.
describe('the admin PUT needs the whole area_addon_pricing object', () => {
  const { validatePricingConfigFor } = require('../routes/admin-pricing-config');
  const whole = () => JSON.parse(JSON.stringify(require('../services/pricing-engine/area-addon-config').defaultAreaAddOnPricingData()));
  test('the whole object passes; a missing top-level key, item or item field is refused by name', () => {
    expect(validatePricingConfigFor('area_addon_pricing', whole())).toEqual({ ok: true });
    expect(validatePricingConfigFor('area_addon_pricing', { targetMargin: 0.7 })).toEqual({ ok: false, error: 'area_addon_pricing: adminPerJob is missing. Send the whole object.' });
    const noItem = whole(); delete noItem.items.web_sweep;
    expect(validatePricingConfigFor('area_addon_pricing', noItem)).toEqual({ ok: false, error: 'area_addon_pricing: items.web_sweep is missing. Send the whole object.' });
    const noField = whole(); delete noField.items.bed_pre_emergent.setupMin;
    expect(validatePricingConfigFor('area_addon_pricing', noField)).toEqual({ ok: false, error: 'area_addon_pricing: items.bed_pre_emergent.setupMin is missing. Send the whole object.' });
  });
});

describe('the sync: the row drives the price, a bad or missing row leaves the code defaults', () => {
  const price = (key, opts) => priceAreaAddOn(key, opts).price;

  test('an edited row reprices the live engine; the next sync with the row gone restores the defaults, not the edit', async () => {
    const before = price('fire_ant_yard', { areaSqFt: 5000 });
    await sync({ ...seed(), targetMargin: 0.5 });
    expect(AREA_ADDONS.targetMargin).toBe(0.5);
    expect(price('fire_ant_yard', { areaSqFt: 5000 })).toBeLessThan(before);
    await sync(undefined);
    expect(AREA_ADDONS.targetMargin).toBe(pristine.targetMargin);
    expect(price('fire_ant_yard', { areaSqFt: 5000 })).toBe(before);
  });

  test('every editable knob moves the price the way the formula says', async () => {
    const base = { areaSqFt: 1000 };
    const at = async (patch, key = 'bed_pre_emergent') => { await sync({ ...seed(), items: { ...seed().items, [key]: { ...seed().items[key], ...patch } } }); return price(key, base); };
    const baseline = price('bed_pre_emergent', base);
    expect(await at({ materialPer1000: 40 })).toBeGreaterThan(baseline);
    expect(await at({ setupMin: 60 })).toBeGreaterThan(baseline);
    expect(await at({ minPer1000: 40 })).toBeGreaterThan(baseline);
    // a larger first tier prices the same 1,000 sq ft at the top of a bigger band
    expect(await at({ tiers: [1500, 2000, 3500] })).toBeGreaterThan(baseline);
    await sync({ ...seed(), adminPerJob: 60 });
    expect(price('bed_pre_emergent', base)).toBeGreaterThan(baseline);
  });

  test('a malformed row is ignored WHOLE: the valid fields beside the bad one are not applied either', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await sync({ ...seed(), targetMargin: 0.5, adminPerJob: 'free' });
    expect(AREA_ADDONS.targetMargin).toBe(pristine.targetMargin);
    expect(AREA_ADDONS.adminPerJob).toBe(pristine.adminPerJob);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('area_addon_pricing rejected'));
    warn.mockRestore();
  });

  test('the label-bound fields cannot move, whatever the row says', async () => {
    await sync({ ...seed(), items: { ...seed().items, fire_ant_yard: { ...seed().items.fire_ant_yard, maxPerYear: 9, limitProduct: 'Other', requiresGrassTrack: 'bahia', serviceKey: 'x' } } });
    expect(live().items).toEqual(pristine.items);
    expect(AREA_ADDONS.items.lawn_insect_spot.requiresGrassTrack).toBe('st_augustine');
  });

  test('db-bridge calls the shared apply on every sync, with the live object', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'pricing-engine', 'db-bridge.js'), 'utf8');
    expect(src).toContain("require('./area-addon-config').syncAreaAddOnPricingConfig(config.area_addon_pricing, constants.AREA_ADDONS)");
  });

  test('the estimator catalog reads the live tiers (an edit shows on the screen with no deploy)', async () => {
    await sync({ ...seed(), items: { ...seed().items, fire_ant_yard: { ...seed().items.fire_ant_yard, tiers: [4000, 6000, 9000] } } });
    const { areaAddOnCatalog } = require('../services/pricing-engine/service-pricing');
    expect(areaAddOnCatalog().find((item) => item.key === 'fire_ant_yard').tiers).toEqual([4000, 6000, 9000]);
  });
});

describe('replay: a sent estimate keeps the knobs it was priced with', () => {
  const quote = (areaAddOns = [{ key: 'bed_pre_emergent', areaSqFt: 1500 }, { key: 'fire_ant_yard', areaSqFt: 5000 }]) => {
    const result = generateEstimate({ ...HOME, services: { areaAddOns } });
    return { engineResult: result, result: mapV1ToLegacyShape(result) };
  };

  test('the priced line carries the knobs it used, and so does the mapped row; the public boundary strips them', () => {
    const { engineResult, result } = quote();
    const line = engineResult.lineItems.find((l) => l.addOnKey === 'bed_pre_emergent');
    expect(line.pricingKnobs).toEqual({ targetMargin: 0.6, adminPerJob: 8, laborRate: constants.GLOBAL.LABOR_RATE, driveMinutes: constants.GLOBAL.DRIVE_TIME, materialPer1000: 10.32, setupMin: 6, minPer1000: 8, tiers: [1000, 2000, 3500] });
    expect(result.oneTime.items.find((i) => i.addOnKey === 'bed_pre_emergent').pricingKnobs).toEqual(line.pricingKnobs);
    const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'estimate-public.js'), 'utf8');
    expect(route).toMatch(/ONE_TIME_ITEM_REVIEW_FIELDS = \[[^\]]*'pricingKnobs'\]/);
    expect(route).toContain("if (key === 'pricingKnobs' && value.service === 'area_addon') continue;");
  });

  test('after the admin edits the row, the replay still prices the sent estimate at the sent price; a fresh quote prices at the new one', async () => {
    const sent = quote();
    const sentPrices = sent.result.oneTime.items.map((i) => i.price);
    const signal = areaAddOnKnobSignalForReplay({ result: sent.result });
    expect(signal).toMatchObject({ targetMargin: 0.6, adminPerJob: 8 });
    await sync({ ...seed(), targetMargin: 0.4, items: { ...seed().items, bed_pre_emergent: { ...seed().items.bed_pre_emergent, tiers: [800, 2000, 3500] } } });
    const fresh = quote().result.oneTime.items.map((i) => i.price);
    expect(fresh).not.toEqual(sentPrices);
    const replay = generateEstimate({ ...HOME, services: { areaAddOns: [{ key: 'bed_pre_emergent', areaSqFt: 1500 }, { key: 'fire_ant_yard', areaSqFt: 5000 }] }, areaAddOnPricingKnobs: signal });
    expect(mapV1ToLegacyShape(replay).oneTime.items.map((i) => i.price)).toEqual(sentPrices);
  });

  test('a stored add-on row with NO stamp replays the in-code defaults; no add-on row injects nothing; an unpriced row injects nothing', () => {
    const { result } = quote();
    const unstamped = JSON.parse(JSON.stringify(result));
    for (const item of unstamped.oneTime.items) delete item.pricingKnobs;
    // (the labor rate and the drive minutes are left out: with no stamp they replay as current at replay)
    expect(areaAddOnKnobSignalForReplay({ result: unstamped })).toEqual({ targetMargin: 0.6, adminPerJob: 8, laborRate: undefined, driveMinutes: undefined, items: {
      bed_pre_emergent: { materialPer1000: 10.32, setupMin: 6, minPer1000: 8, tiers: [1000, 2000, 3500] },
      fire_ant_yard: { materialPer1000: 3.66, setupMin: 6, minPer1000: 2.5, tiers: [3000, 5000, 8000] },
    } });
    expect(areaAddOnKnobSignalForReplay({ result: { oneTime: { items: [{ service: 'one_time_pest', price: 150 }] } } })).toBeNull();
    expect(areaAddOnKnobSignalForReplay({ result: { oneTime: { specItems: [{ service: 'area_addon', addOnKey: 'web_sweep', price: null }] } } })).toBeNull();
    // Codex round 24: a row sold through another amount field the booking reads freezes its knobs too; a custom-quote row does not.
    for (const field of ['amount', 'total', 'priceAfterDiscount']) {
      expect(areaAddOnKnobSignalForReplay({ result: { oneTime: { items: [{ service: 'area_addon', addOnKey: 'web_sweep', [field]: 89 }] } } })).toMatchObject({ targetMargin: 0.6, items: { web_sweep: expect.any(Object) } });
    }
    expect(areaAddOnKnobSignalForReplay({ result: { oneTime: { items: [{ service: 'area_addon', addOnKey: 'web_sweep', price: 89, quoteRequired: true }] } } })).toBeNull();
    expect(areaAddOnKnobSignalForReplay(null)).toBeNull();
    expect(areaAddOnKnobSignalForReplay('{not json')).toBeNull();
  });

  // Codex round 11 P1 on #6135: the stamp froze the margin, admin charge, material, minutes and tiers, but the labor rate and
  // the drive minutes come from pricing_config rows (global_labor_rate, global_drive_time) an admin can edit, so a sent
  // estimate re-priced differently after either changed.
  describe('the global labor rate and drive minutes', () => {
    const savedGlobals = { rate: constants.GLOBAL.LABOR_RATE, drive: constants.GLOBAL.DRIVE_TIME };
    afterEach(() => { constants.GLOBAL.LABOR_RATE = savedGlobals.rate; constants.GLOBAL.DRIVE_TIME = savedGlobals.drive; });
    const list = [{ key: 'bed_pre_emergent', areaSqFt: 1500 }, { key: 'fire_ant_yard', areaSqFt: 5000 }];
    const prices = (result) => mapV1ToLegacyShape(result).oneTime.items.map((i) => i.price);

    test('the stamp carries both, and the replay keeps the sent price after either changes', () => {
      const sent = quote(list);
      const sentPrices = prices(sent.engineResult);
      const signal = areaAddOnKnobSignalForReplay({ result: sent.result });
      expect(signal).toMatchObject({ laborRate: savedGlobals.rate, driveMinutes: savedGlobals.drive });
      constants.GLOBAL.LABOR_RATE = savedGlobals.rate * 2;
      constants.GLOBAL.DRIVE_TIME = savedGlobals.drive * 3;
      expect(prices(quote(list).engineResult)).not.toEqual(sentPrices);
      const replay = generateEstimate({ ...HOME, services: { areaAddOns: list }, areaAddOnPricingKnobs: signal });
      expect(prices(replay)).toEqual(sentPrices);
      // Each one alone moves a fresh quote and none moves the replay.
      constants.GLOBAL.DRIVE_TIME = savedGlobals.drive;
      expect(prices(quote(list).engineResult)).not.toEqual(sentPrices);
      constants.GLOBAL.LABOR_RATE = savedGlobals.rate;
      constants.GLOBAL.DRIVE_TIME = savedGlobals.drive * 3;
      expect(prices(quote(list).engineResult)).not.toEqual(sentPrices);
      expect(prices(generateEstimate({ ...HOME, services: { areaAddOns: list }, areaAddOnPricingKnobs: signal }))).toEqual(sentPrices);
    });

    test('a stored row with no stamp replays the values current at replay, and a damaged stamp falls back to them', () => {
      const { result } = quote(list);
      const unstamped = JSON.parse(JSON.stringify(result));
      for (const item of unstamped.oneTime.items) delete item.pricingKnobs;
      const signal = areaAddOnKnobSignalForReplay({ result: unstamped });
      expect(signal.laborRate).toBeUndefined();
      expect(signal.driveMinutes).toBeUndefined();
      constants.GLOBAL.LABOR_RATE = savedGlobals.rate * 2;
      const live = prices(quote(list).engineResult);
      expect(prices(generateEstimate({ ...HOME, services: { areaAddOns: list }, areaAddOnPricingKnobs: signal }))).toEqual(live);
      for (const bad of [{ laborRate: -5 }, { laborRate: 0 }, { laborRate: '35' }, { laborRate: null }, { driveMinutes: -1 }, { driveMinutes: 'x' }]) {
        expect(prices(generateEstimate({ ...HOME, services: { areaAddOns: list }, areaAddOnPricingKnobs: { ...signal, ...bad } }))).toEqual(live);
      }
    });

    test('the pricer reads both from the knobs, never from GLOBAL directly', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'pricing-engine', 'service-pricing.js'), 'utf8');
      const start = src.indexOf('function priceAreaAddOn(addOnKey');
      const body = src.slice(start, src.indexOf('// The estimate\'s grass for an entry that does not carry one.', start));
      expect(body).not.toMatch(/GLOBAL\./);
      expect(body).toContain('knobs.driveMinutes');
      expect(body).toContain('knobs.laborRate');
    });

    test('which add-on carries the one drive and the one admin charge is NOT frozen: it follows the list being priced', () => {
      const sent = quote(list);
      const signal = areaAddOnKnobSignalForReplay({ result: sent.result });
      // Removing the first add-on (a revise) moves the drive and the admin charge to the next one.
      const revised = generateEstimate({ ...HOME, services: { areaAddOns: [list[1]] }, areaAddOnPricingKnobs: signal });
      const line = revised.lineItems.find((l) => l.addOnKey === 'fire_ant_yard');
      expect(line).toMatchObject({ carriesVisitDrive: true, carriesJobAdmin: true });
    });
  });

  test('both replay paths inject it; a posted copy is stripped as a server-owned field', () => {
    const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    expect(read('routes/estimate-public.js')).toContain("Object.assign(overrides, require('../services/estimate-area-addon-knob-replay').areaAddOnReplayOverrides(estData));");
    expect(read('services/admin-estimate-persistence.js')).toContain("Object.assign(v1Input, require('./estimate-area-addon-knob-replay').areaAddOnReplayOverrides(estimateData));");
    expect(require('../services/estimate-area-addon-knob-replay').areaAddOnReplayOverrides({ result: { oneTime: { items: [] } } })).toEqual({});
    const { CLIENT_IDENTITY_FIELDS, sanitizeClientIdentityFields } = require('../services/estimate-client-identity-fields');
    expect(CLIENT_IDENTITY_FIELDS).toContain('areaAddOnPricingKnobs');
    expect(sanitizeClientIdentityFields({ areaAddOnPricingKnobs: { targetMargin: 0.3 }, keep: 1 })).toEqual({ keep: 1 });
  });

  test('a posted entry cannot carry its own knobs into the engine', () => {
    const forged = generateEstimate({ ...HOME, services: { areaAddOns: [{ key: 'web_sweep', pricingKnobs: { targetMargin: 0.3, adminPerJob: 0, setupMin: 1 } }] } });
    expect(forged.lineItems.find((l) => l.addOnKey === 'web_sweep').price).toBe(89);
  });
});

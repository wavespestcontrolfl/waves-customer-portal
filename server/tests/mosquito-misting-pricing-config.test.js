/**
 * The mosquito misting prices are DB-authoritative: pricing_config row `mosquito_misting_pricing`, seeded by migration
 * 20261023000010, synced over MOSQUITO_MISTING by db-bridge on every sync, validated with bounds and a fail-closed fallback
 * to the code defaults. Labels, the nozzle/riser/refill bounds and the defaults stay in code and no row reaches them.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const path = require('path');
const constants = require('../services/pricing-engine/constants');
const { MOSQUITO_MISTING } = constants;
const { syncConstantsFromDB } = require('../services/pricing-engine/db-bridge');
const config = require('../services/pricing-engine/mosquito-misting-config');
const { priceMosquitoMisting } = require('../services/pricing-engine/service-pricing');
const migration = require('../models/migrations/20261023000010_mosquito_misting_pricing_config');
const retailMigration = require('../models/migrations/20261025090000_mosquito_misting_pynamite_retail_prices');

const CODE_OWNED = ['label', 'minNozzles', 'maxNozzles', 'maxRisers', 'maxRefillsPerYear', 'defaultTier', 'defaultSolution', 'defaultRefillsPerYear'];

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
const row = (data) => [{ config_key: 'mosquito_misting_pricing', data }, { config_key: 'global_labor_rate', data: { value: constants.GLOBAL.LABOR_RATE } }];
const sync = (data) => syncConstantsFromDB(pricingConfigDb(data === undefined ? row(undefined).slice(1) : row(data)));
const seed = () => JSON.parse(JSON.stringify(config.defaultMosquitoMistingPricingData()));
const live = () => JSON.parse(JSON.stringify(MOSQUITO_MISTING));
const PROPERTY = { homeSqFt: 2000, lotSqFt: 8000 };

let pristine;
beforeAll(() => { pristine = live(); });
afterEach(() => { config.rebaseMosquitoMisting(); });

describe('the seed row is the code table, and the code table is the default', () => {
  test('the frozen 10-23 migration keeps its own MistAway literals (history), and no code-owned field', () => {
    // 20261023000010 is frozen: its SEED is pinned to its own values, not to the live constants (20261025090000 moves them on).
    expect(migration.SEED.tiers).toEqual({
      essential: { price: 3795, hardwareCost: 1800, includedNozzles: 35 },
      smart: { price: 4595, hardwareCost: 2600, includedNozzles: 35 },
    });
    expect(migration.SEED).toMatchObject({
      extraNozzlePrice: 75, extraNozzleCost: 22, includedRisers: 10, extraRiserPrice: 45, extraRiserCost: 14,
      install: { techs: 2, hours: 10 }, serviceCallNoPlan: 149,
      refills: { standard: { price: 129, productCost: 45 }, natural: { price: 219, productCost: 95 }, premium: { price: 319, productCost: 140 } },
    });
    expect(migration.SEED.plan).toEqual({ monthly: 59, visitsPerYear: 12, laborMinutesPerVisit: 25, partsReservePerMonth: 10 });
    const flat = JSON.stringify(migration.SEED);
    for (const field of CODE_OWNED) expect(flat).not.toContain(`"${field}"`);
    expect(config.normalizeMosquitoMistingPricingConfig(migration.SEED)).toMatchObject({ ok: true });
  });

  test('the Pynamite retail migration NEXT is exactly the in-code values and no code-owned field', () => {
    expect(retailMigration.NEXT).toEqual(seed());
    expect(retailMigration.NEXT).toEqual(constants.mosquitoMistingPricingDefaults());
    expect(retailMigration.SEED).toBe(migration.SEED);
    expect(retailMigration.NEXT.tiers.smart).toEqual({ price: 4195, hardwareCost: 2560, includedNozzles: 30 });
    expect(retailMigration.NEXT.tiers.essential).toEqual({ price: 2795, hardwareCost: 1620, includedNozzles: 10 });
    expect(retailMigration.NEXT).toMatchObject({ includedRisers: 0, extraRiserPrice: 75, extraRiserCost: 30, install: { techs: 2, hours: 6 } });
    expect(retailMigration.NEXT.refills).toEqual({ standard: { price: 129, productCost: 70 }, natural: { price: 219, productCost: 95 }, premium: { price: 319, productCost: 203 } });
    const flat = JSON.stringify(retailMigration.NEXT);
    for (const field of CODE_OWNED) expect(flat).not.toContain(`"${field}"`);
    expect(config.normalizeMosquitoMistingPricingConfig(retailMigration.NEXT)).toMatchObject({ ok: true });
  });

  test('the frozen defaults are the table as written, not a view of the live one', () => {
    const defaults = constants.mosquitoMistingPricingDefaults();
    expect(Object.isFrozen(defaults)).toBe(true);
    expect(Object.isFrozen(defaults.tiers.smart)).toBe(true);
    expect(typeof constants.mosquitoMistingPricingDefaults).toBe('function');
    expect(Object.values(constants)).not.toContain(defaults);
  });

  test('up inserts the row once (category mosquito) with its audit records, never overwrites; down removes it only while unedited', async () => {
    const db = { pricing_config: [], pricing_config_audit: [], pricing_changelog: [] };
    const knex = (table) => {
      let cond = {};
      const match = (r) => Object.entries(cond).every(([k, v]) => r[k] === v);
      const q = {
        where(c) { cond = { ...cond, ...c }; return q; },
        first() { return Promise.resolve(db[table].find(match)); },
        insert(r) { return { onConflict: () => ({ ignore: async () => { db[table].push({ ...r }); } }), then: (res) => { db[table].push({ ...r }); res(); } }; },
        async del() { db[table] = db[table].filter((r) => !match(r)); },
      };
      return q;
    };
    knex.schema = { hasTable: async (t) => Object.prototype.hasOwnProperty.call(db, t) };
    knex.fn = { now: () => 'now()' };
    await migration.up(knex);
    await migration.up(knex);
    expect(db.pricing_config).toHaveLength(1);
    expect(db.pricing_config[0]).toMatchObject({ config_key: 'mosquito_misting_pricing', category: 'mosquito' });
    expect(db.pricing_config_audit).toHaveLength(1);
    expect(db.pricing_changelog).toHaveLength(1);
    // jsonb hands the keys back in another order: the comparison is by value
    db.pricing_config[0].data = JSON.stringify({ ...Object.fromEntries(Object.entries(migration.SEED).reverse()) });
    await migration.down(knex);
    expect(db.pricing_config).toHaveLength(0);
    expect(db.pricing_config_audit).toHaveLength(0);
    expect(db.pricing_changelog).toHaveLength(0);
    await migration.up(knex);
    db.pricing_config[0].data = JSON.stringify({ ...migration.SEED, serviceCallNoPlan: 150 });
    await migration.down(knex);
    expect(db.pricing_config).toHaveLength(1);
  });
});

describe('validation: bounds, plain JSON numbers, and no code-owned field', () => {
  const edit = (patch) => ({ ...seed(), ...patch });
  const bad = (data, pattern, opts) => expect(config.normalizeMosquitoMistingPricingConfig(data, opts)).toMatchObject({ ok: false, error: expect.stringMatching(pattern) });

  test.each([
    [{ extraNozzlePrice: -1 }, /extraNozzlePrice/], [{ extraNozzlePrice: 20001 }, /extraNozzlePrice/], [{ extraNozzleCost: '22' }, /extraNozzleCost/],
    [{ includedRisers: 201 }, /includedRisers/], [{ serviceCallNoPlan: null }, /serviceCallNoPlan/], [{ extraRiserPrice: NaN }, /extraRiserPrice/],
    [{ install: { techs: 0, hours: 10 } }, /install\.techs/], [{ install: { techs: 5, hours: 10 } }, /install\.techs/], [{ install: { techs: 2, hours: 81 } }, /install\.hours/],
    [{ plan: { ...seed().plan, visitsPerYear: 0 } }, /plan\.visitsPerYear/], [{ plan: { ...seed().plan, visitsPerYear: 25 } }, /plan\.visitsPerYear/],
    [{ plan: { ...seed().plan, laborMinutesPerVisit: 241 } }, /laborMinutesPerVisit/], [{ plan: { ...seed().plan, monthly: true } }, /plan\.monthly/],
    [{ tiers: { ...seed().tiers, smart: { ...seed().tiers.smart, price: -5 } } }, /tiers\.smart\.price/],
    [{ refills: { ...seed().refills, natural: { ...seed().refills.natural, productCost: 'x' } } }, /refills\.natural\.productCost/],
  ])('%j is refused', (patch, pattern) => bad(edit(patch), pattern));

  test.each([
    [{ tiers: { ...seed().tiers, smart: { ...seed().tiers.smart, includedNozzles: 0 } } }, /tiers\.smart\.includedNozzles/],
    [{ tiers: { ...seed().tiers, smart: { ...seed().tiers.smart, includedNozzles: 9 } } }, /tiers\.smart\.includedNozzles/],
    [{ tiers: { ...seed().tiers, smart: { ...seed().tiers.smart, includedNozzles: 100 } } }, /tiers\.smart\.includedNozzles/],
    [{ tiers: { ...seed().tiers, essential: { ...seed().tiers.essential, includedNozzles: 35.5 } } }, /tiers\.essential\.includedNozzles must be a whole number/],
    [{ includedRisers: 10.5 }, /includedRisers must be a whole number/],
    [{ includedRisers: 81 }, /includedRisers/],
    [{ includedRisers: -1 }, /includedRisers/],
  ])('included counts are whole numbers inside the code-owned limits: %j is refused', (patch, pattern) => bad(edit(patch), pattern));

  test.each([
    [{ plan: { ...seed().plan, visitsPerYear: 12.5 } }, /plan\.visitsPerYear must be a whole number/],
    [{ plan: { ...seed().plan, visitsPerYear: 0.5 } }, /plan\.visitsPerYear/],
    [{ install: { techs: 2.5, hours: 10 } }, /install\.techs must be a whole number/],
  ])('plan visits and install techs are whole numbers: %j is refused', (patch, pattern) => bad(edit(patch), pattern));

  test('whole-number plan visits and techs are accepted; hours may be fractional', () => {
    expect(config.normalizeMosquitoMistingPricingConfig(edit({ plan: { ...seed().plan, visitsPerYear: 24 }, install: { techs: 4, hours: 9.5 } }))).toMatchObject({ ok: true });
  });

  test('the edges of the included counts are accepted, and a bad one ignores the whole row on sync', async () => {
    const edges = edit({ includedRisers: 80, tiers: { ...seed().tiers, smart: { ...seed().tiers.smart, includedNozzles: 80 }, essential: { ...seed().tiers.essential, includedNozzles: 10 } } });
    expect(config.normalizeMosquitoMistingPricingConfig(edges)).toMatchObject({ ok: true });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const data = seed();
    data.plan.monthly = 70;
    data.tiers.smart.includedNozzles = 100;
    await sync(data);
    expect(live()).toEqual(pristine);
    warn.mockRestore();
  });

  test('not an object, an unknown tier or solution is refused by the PUT and ignored by the sync', () => {
    bad(null, /object/);
    bad([], /object/);
    bad(edit({ tiers: { ...seed().tiers, deluxe: { price: 1 } } }), /tiers\.deluxe is not one of ours/);
    bad(edit({ refills: { ...seed().refills, bleach: { price: 1 } } }), /refills\.bleach is not one of ours/);
    bad({ ...seed(), surprise: 1 }, /not a setting/);
    expect(config.normalizeMosquitoMistingPricingConfig({ ...seed(), surprise: 1, tiers: { ...seed().tiers, deluxe: { price: 1 } } }, { strict: false })).toMatchObject({ ok: true });
  });

  test.each([
    ['tiers.smart.label', (d) => { d.tiers.smart.label = 'x'; }, /tiers\.smart\.label is set in code/],
    ['refills.standard.label', (d) => { d.refills.standard.label = 'x'; }, /refills\.standard\.label is set in code/],
    ['plan.maxNozzles', (d) => { d.plan.maxNozzles = 500; }, /plan\.maxNozzles is set in code/],
    ['install.minNozzles', (d) => { d.install.minNozzles = 1; }, /install\.minNozzles is set in code/],
  ])('the admin PUT refuses %s (set in code); the sync ignores it', (_name, mutate, pattern) => {
    const data = seed();
    mutate(data);
    bad(data, pattern);
    expect(config.normalizeMosquitoMistingPricingConfig(data, { strict: false })).toMatchObject({ ok: true });
  });

  test.each(['minNozzles', 'maxNozzles', 'maxRisers', 'maxRefillsPerYear', 'defaultTier', 'defaultSolution', 'defaultRefillsPerYear', 'defaultTier'])(
    'a top-level %s is refused by the PUT',
    (field) => bad({ ...seed(), [field]: 5 }, new RegExp(`${field} is not a setting`)),
  );

  test('the admin PUT validates it with the same function and needs the whole object', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-pricing-config.js'), 'utf8');
    expect(src).toContain('OWN_VALIDATORS.mosquito_misting_pricing = validateMosquitoMistingPricing;');
    expect(src).toContain('config.normalizeMosquitoMistingPricingConfig(data)');
    expect(src).toContain("config_key: 'mosquito_misting_pricing', name: 'Mosquito Misting System Pricing', category: 'mosquito'");
    const { validatePricingConfigFor } = require('../routes/admin-pricing-config');
    expect(validatePricingConfigFor('mosquito_misting_pricing', seed())).toEqual({ ok: true });
    expect(validatePricingConfigFor('mosquito_misting_pricing', { serviceCallNoPlan: 150 }).error).toMatch(/is missing\. Send the whole object\./);
    const noMember = seed(); delete noMember.refills.premium;
    expect(validatePricingConfigFor('mosquito_misting_pricing', noMember)).toEqual({ ok: false, error: 'mosquito_misting_pricing: refills.premium is missing. Send the whole object.' });
    const noField = seed(); delete noField.plan.monthly;
    expect(validatePricingConfigFor('mosquito_misting_pricing', noField)).toEqual({ ok: false, error: 'mosquito_misting_pricing: plan.monthly is missing. Send the whole object.' });
  });
});

describe('the sync: the row drives the price, a bad or missing row leaves the code defaults', () => {
  const base = () => priceMosquitoMisting(PROPERTY, { tier: 'essential', nozzles: 40, risers: 12, solution: 'natural' });

  test('an edited row reprices install, plan and refill; the next sync with the row gone restores the defaults, not the edit', async () => {
    const before = base();
    const data = seed();
    data.tiers.essential.price = 3000;
    data.extraNozzlePrice = 100;
    data.extraRiserPrice = 60;
    data.plan.monthly = 70;
    data.refills.natural.price = 250;
    await sync(data);
    const after = base();
    expect(after.installation.price).toBe(3000 + 30 * 100 + 12 * 60);
    expect(after.monthly).toBe(70);
    expect(after.perApp).toBe(70);
    expect(after.annual).toBe(840);
    expect(after.refill.perFill).toBe(250);
    expect(after.pricingKnobs).toMatchObject({ tierPrice: 3000, extraNozzlePrice: 100, planMonthly: 70, refillPrice: 250 });
    await sync(undefined);
    expect(live()).toEqual(pristine);
    expect(base()).toEqual(before);
  });

  test('install labor and cost knobs move the cost basis', async () => {
    const data = seed();
    data.install = { techs: 3, hours: 8 };
    data.tiers.essential.hardwareCost = 2000;
    await sync(data);
    const r = base();
    expect(r.installation.laborCost).toBe(3 * 8 * constants.GLOBAL.LABOR_RATE);
    expect(r.installation.materialCost).toBe(2000 + 30 * 22 + 12 * 30);
  });

  test('a malformed row is ignored WHOLE: the valid fields beside the bad one are not applied either', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const data = seed();
    data.plan.monthly = 70;
    data.serviceCallNoPlan = 'free';
    await sync(data);
    expect(live()).toEqual(pristine);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mosquito_misting_pricing rejected'));
    warn.mockRestore();
  });

  test('an out-of-bounds field ignores the whole row', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const data = seed();
    data.tiers.smart.price = 5000;
    data.extraNozzlePrice = 99999;
    await sync(data);
    expect(MOSQUITO_MISTING.tiers.smart.price).toBe(pristine.tiers.smart.price);
    expect(MOSQUITO_MISTING.extraNozzlePrice).toBe(pristine.extraNozzlePrice);
    warn.mockRestore();
  });

  test('the code-owned fields cannot move, whatever the row says', async () => {
    const data = seed();
    data.tiers.smart.label = 'Hacked';
    data.plan.maxNozzles = 500;
    data.maxNozzles = 500;
    data.maxRisers = 500;
    data.defaultTier = 'essential';
    data.refills.standard.label = 'Hacked';
    data.plan.monthly = 65;
    await sync(data);
    const now = live();
    expect(now.plan.monthly).toBe(65);
    for (const field of CODE_OWNED) expect(now[field]).toEqual(pristine[field]);
    expect(now.tiers.smart.label).toBe(pristine.tiers.smart.label);
    expect(now.refills.standard.label).toBe(pristine.refills.standard.label);
    expect(now.plan.maxNozzles).toBeUndefined();
  });

  test('db-bridge calls the shared sync on every sync, with the live object', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'pricing-engine', 'db-bridge.js'), 'utf8');
    expect(src).toContain("require('./mosquito-misting-config').syncMosquitoMistingPricingConfig(config.mosquito_misting_pricing, constants.MOSQUITO_MISTING)");
  });
});

describe('pre-push audit P1s (cadence and zero plan)', () => {
  const { applyMosquitoMistingPricingConfig } = require('../services/pricing-engine/mosquito-misting-config');
  const { MOSQUITO_MISTING, mosquitoMistingPricingDefaults } = require('../services/pricing-engine/constants');
  const { priceMosquitoMisting } = require('../services/pricing-engine/service-pricing');
  afterEach(() => applyMosquitoMistingPricingConfig(null, MOSQUITO_MISTING));

  test('an edited visitsPerYear moves annual with it (annual = per application × cadence)', () => {
    const row = JSON.parse(JSON.stringify(mosquitoMistingPricingDefaults()));
    row.plan.visitsPerYear = 6;
    expect(applyMosquitoMistingPricingConfig(row, MOSQUITO_MISTING).applied).toBe(true);
    const r = priceMosquitoMisting({}, {});
    expect(r.perApp).toBe(59);
    expect(r.visitsPerYear).toBe(6);
    expect(r.annual).toBe(354);
    expect(r.monthly).toBe(29.5);
  });

  test('a $0 plan price is refused and the defaults stand', () => {
    const row = JSON.parse(JSON.stringify(mosquitoMistingPricingDefaults()));
    row.plan.monthly = 0;
    expect(applyMosquitoMistingPricingConfig(row, MOSQUITO_MISTING).applied).toBe(false);
    expect(priceMosquitoMisting({}, {}).annual).toBe(708);
  });
});

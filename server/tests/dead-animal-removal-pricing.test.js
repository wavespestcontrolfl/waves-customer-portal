/**
 * Dead Rodent Removal & Odor Treatment (owner approved 2026-10-26, dark behind GATE_DEAD_ANIMAL_REMOVAL): the pricer, the engine's
 * "riding" decision, the commercial hand-off, the gate (NEW QUOTES ONLY), the DB-editable row, the staff-estimator translator and
 * the legacy mapper. All names and addresses are synthetic.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const constants = require('../services/pricing-engine/constants');
const { GLOBAL, AREA_ADDONS, RODENT } = constants;
const { syncConstantsFromDB } = require('../services/pricing-engine/db-bridge');
const config = require('../services/pricing-engine/dead-animal-removal-config');
const { generateEstimate, priceDeadAnimalRemoval } = require('../services/pricing-engine');
const servicePricing = require('../services/pricing-engine/service-pricing');
const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const featureGates = require('../config/feature-gates');

const HOME = { homeSqFt: 2000, lotSqFt: 7500, footprint: 1800, stories: 1 };
const COMMERCIAL = { ...HOME, propertyType: 'commercial', commercialSubtype: 'office' };
const lineOf = (estimate) => estimate.lineItems.find((l) => l.service === 'rodent_dead_animal_removal');
const price = (services, base = HOME) => lineOf(generateEstimate({ ...base, services }));

let savedGate;
let pristine;
beforeAll(() => {
  savedGate = process.env.GATE_DEAD_ANIMAL_REMOVAL;
  pristine = JSON.parse(JSON.stringify(RODENT.deadAnimalRemoval));
});
beforeEach(() => { process.env.GATE_DEAD_ANIMAL_REMOVAL = 'true'; });
afterEach(() => {
  Object.assign(RODENT.deadAnimalRemoval.reachable, pristine.reachable);
  Object.assign(RODENT.deadAnimalRemoval.attic, pristine.attic);
});
afterAll(() => {
  if (savedGate === undefined) delete process.env.GATE_DEAD_ANIMAL_REMOVAL; else process.env.GATE_DEAD_ANIMAL_REMOVAL = savedGate;
});

// The owner's add-on cost formula, evaluated here only to pin the stored prices to it.
const roundUpToNine = (v) => Math.ceil((v - 9) / 10) * 10 + 9;
const formula = ({ onSiteMin, material, riding }) => {
  const driveMin = riding ? 0 : GLOBAL.DRIVE_TIME;
  const admin = riding ? 0 : AREA_ADDONS.adminPerJob;
  return roundUpToNine(((onSiteMin + driveMin) * GLOBAL.LABOR_RATE / 60 + material + admin) / 0.40);
};

describe('the stored prices sit at or above the owner cost formula (the floor)', () => {
  test.each([
    ['reachable', 45, 12, 149, 99],
    ['attic', 90, 15, 219, 169],
  ])('%s: the formula floor is written down and alone and riding are not below it', (tier, onSiteMin, material, aloneFloor, ridingFloor) => {
    const cfg = RODENT.deadAnimalRemoval[tier];
    expect(cfg.durationMin).toBe(onSiteMin);
    expect(cfg.material).toBe(material);
    expect(formula({ onSiteMin, material, riding: false })).toBe(aloneFloor);
    expect(formula({ onSiteMin, material, riding: true })).toBe(ridingFloor);
    expect(cfg.alone).toBeGreaterThanOrEqual(aloneFloor);
    expect(cfg.riding).toBeGreaterThanOrEqual(ridingFloor);
    expect(cfg.riding).toBeLessThanOrEqual(cfg.alone);
  });

  test('the four prices are 169 / 119 and 269 / 219', () => {
    expect([RODENT.deadAnimalRemoval.reachable.alone, RODENT.deadAnimalRemoval.reachable.riding]).toEqual([169, 119]);
    expect([RODENT.deadAnimalRemoval.attic.alone, RODENT.deadAnimalRemoval.attic.riding]).toEqual([269, 219]);
  });
});

describe('priceDeadAnimalRemoval', () => {
  test.each([
    ['reachable', false, 169, 45],
    ['reachable', true, 119, 45],
    ['attic', false, 269, 90],
    ['attic', true, 219, 90],
  ])('%s riding=%s -> $%i, %i minutes on site', (tier, riding, expected, minutes) => {
    const line = priceDeadAnimalRemoval({ tier, riding });
    expect(line).toMatchObject({
      service: 'rodent_dead_animal_removal', name: 'Dead Rodent Removal & Odor Treatment', tier, price: expected, riding, durationMin: minutes,
    });
    expect(line.detail).toContain(`${minutes} min on site`);
    expect(line.quoteRequired).toBeUndefined();
    // The stated cost: a riding line carries no drive and no admin.
    expect(line.costs.driveMin).toBe(riding ? 0 : GLOBAL.DRIVE_TIME);
    expect(line.costs.admin).toBe(riding ? 0 : AREA_ADDONS.adminPerJob);
    expect(line.margin).toBeGreaterThan(0.55);
  });

  test('in_wall is a custom quote with the manual review reason, never a price', () => {
    const line = priceDeadAnimalRemoval({ tier: 'in_wall', riding: true });
    expect(line).toMatchObject({
      price: null, quoteRequired: true, requiresCustomQuote: true, requiresManualReview: true,
      customQuoteReason: 'dead_animal_in_wall_custom_quote', manualReviewReasons: ['dead_animal_in_wall_custom_quote'], riding: false,
    });
  });

  test.each([undefined, null, ''])('an unchosen tier (%p) is a custom quote: there is no default tier', (tier) => {
    expect(priceDeadAnimalRemoval({ tier })).toMatchObject({ price: null, quoteRequired: true, requiresCustomQuote: true, customQuoteReason: 'dead_animal_access_not_chosen' });
    expect(priceDeadAnimalRemoval({})).toMatchObject({ price: null, quoteRequired: true });
  });

  test('a mistyped tier throws a 400 PricingError instead of becoming a custom quote', () => {
    expect(() => priceDeadAnimalRemoval({ tier: 'Attic' })).toThrow(expect.objectContaining({ name: 'PricingError', statusCode: 400, failClosed: true }));
    expect(() => priceDeadAnimalRemoval({ tier: 'basement' })).toThrow(/must be one of/);
  });

  test('riding is only true for a literal true', () => {
    expect(priceDeadAnimalRemoval({ tier: 'reachable', riding: 'true' }).price).toBe(169);
    expect(priceDeadAnimalRemoval({ tier: 'reachable', riding: 1 }).price).toBe(169);
  });
});

describe('the gate: NEW QUOTES ONLY', () => {
  test.each([undefined, '', '0', 'false', 'off', 'no'])('GATE_DEAD_ANIMAL_REMOVAL=%p is off', (value) => {
    if (value === undefined) delete process.env.GATE_DEAD_ANIMAL_REMOVAL; else process.env.GATE_DEAD_ANIMAL_REMOVAL = value;
    expect(featureGates.deadAnimalRemovalLive()).toBe(false);
    expect(() => priceDeadAnimalRemoval({ tier: 'reachable' })).toThrow(expect.objectContaining({
      name: 'PricingError', code: 'DEAD_ANIMAL_REMOVAL_GATED', status: 400, statusCode: 400, failClosed: true, isOperational: true,
    }));
    // The engine refuses the input too: nothing is dropped silently.
    expect(() => generateEstimate({ ...HOME, services: { deadAnimalRemoval: { tier: 'reachable' } } })).toThrow(expect.objectContaining({ code: 'DEAD_ANIMAL_REMOVAL_GATED', failClosed: true, statusCode: 400 }));
    // ... even for a custom-quote tier and even on a commercial property (before the manual-quote hand-off).
    expect(() => generateEstimate({ ...HOME, services: { deadAnimalRemoval: { tier: 'in_wall' } } })).toThrow(/GATE_DEAD_ANIMAL_REMOVAL/);
    expect(() => generateEstimate({ ...COMMERCIAL, services: { deadAnimalRemoval: { tier: 'attic' } } })).toThrow(/GATE_DEAD_ANIMAL_REMOVAL/);
  });

  test.each(['1', 'true', 'on', 'TRUE', 'On'])('GATE_DEAD_ANIMAL_REMOVAL=%p is on, read at call time', (value) => {
    process.env.GATE_DEAD_ANIMAL_REMOVAL = value;
    expect(featureGates.deadAnimalRemovalLive()).toBe(true);
    expect(price({ deadAnimalRemoval: { tier: 'reachable' } }).price).toBe(169);
    process.env.GATE_DEAD_ANIMAL_REMOVAL = 'false';
    expect(() => price({ deadAnimalRemoval: { tier: 'reachable' } })).toThrow(/not enabled/);
  });

  test('an estimate without the service is untouched by the gate', () => {
    delete process.env.GATE_DEAD_ANIMAL_REMOVAL;
    expect(() => generateEstimate({ ...HOME, services: { rodentInspection: true } })).not.toThrow();
    expect(() => generateEstimate({ ...HOME, services: { deadAnimalRemoval: undefined } })).not.toThrow();
  });
});

describe('the engine decides riding from its own priced rodent lines', () => {
  test('alone: own visit prices', () => {
    expect(price({ deadAnimalRemoval: { tier: 'reachable' } })).toMatchObject({ price: 169, riding: false });
    expect(price({ deadAnimalRemoval: { tier: 'attic' } })).toMatchObject({ price: 269, riding: false });
  });

  test('a priced trapping line on the same estimate makes it ride', () => {
    const estimate = generateEstimate({ ...HOME, services: { rodentTrapping: true, deadAnimalRemoval: { tier: 'reachable' } } });
    expect(estimate.lineItems.find((l) => l.service === 'rodent_trapping').price).toBeGreaterThan(0);
    expect(lineOf(estimate)).toMatchObject({ price: 119, riding: true });
    expect(lineOf(generateEstimate({ ...HOME, services: { rodentTrapping: true, deadAnimalRemoval: { tier: 'attic' } } }))).toMatchObject({ price: 219, riding: true });
  });

  test('the order of the keys on the request does not matter', () => {
    expect(lineOf(generateEstimate({ ...HOME, services: { deadAnimalRemoval: { tier: 'reachable' }, rodentTrapping: true } })).price).toBe(119);
  });

  test.each([
    ['sanitation', { sanitation: { tier: 'light', affectedSqFt: 200 } }],
    ['rodent inspection', { rodentInspection: true }],
    ['V2 exclusion', { exclusion: { pricingVersion: 'v2', standardWireMeshPoints: 2 } }],
    ['wire mesh', { rodentWireMesh: { meshLinearFeet: 20, meshSubstrate: 'wood_soft' } }],
    ['bird box', { rodentBirdBoxes: { birdBoxType: 'standard_bird_box', birdBoxQuantity: 1 } }],
    ['rodent guarantee combo (its price carries the exclusion work)', { rodentGuaranteeCombo: { guaranteeTerm: 12 } }],
  ])('a priced %s line makes it ride', (_label, extra) => {
    const estimate = generateEstimate({ ...HOME, services: { ...extra, deadAnimalRemoval: { tier: 'reachable' } } });
    expect(lineOf(estimate)).toMatchObject({ price: 119, riding: true });
  });

  test('the host rule: only a PRICED line hosts', () => {
    const { isDeadAnimalRidingHostLine } = servicePricing;
    expect(isDeadAnimalRidingHostLine({ service: 'rodent_trapping', price: 350 })).toBe(true);
    expect(isDeadAnimalRidingHostLine({ service: 'rodent_trapping', price: null, quoteRequired: true })).toBe(false);
    expect(isDeadAnimalRidingHostLine({ service: 'rodent_trapping', price: 350, requiresCustomQuote: true })).toBe(false);
    expect(isDeadAnimalRidingHostLine({ service: 'rodent_trapping', price: 0 })).toBe(false);
    expect(isDeadAnimalRidingHostLine({ service: 'exclusion', price: 295 })).toBe(true);
    expect(isDeadAnimalRidingHostLine(null)).toBe(false);
  });

  test('ENGINE: not riding when the trapping line on the same estimate is a custom quote', () => {
    // No residential rodent pricer returns a custom quote today, so the engine is loaded against a trapping pricer that does.
    jest.isolateModules(() => {
      jest.doMock('../services/pricing-engine/service-pricing', () => ({
        ...jest.requireActual('../services/pricing-engine/service-pricing'),
        priceRodentTrapping: () => ({
          service: 'rodent_trapping', name: 'Rodent Trapping', price: null, quoteRequired: true, requiresCustomQuote: true, customQuoteReason: 'test_custom_quote',
        }),
      }));
      const engine = require('../services/pricing-engine/estimate-engine');
      const estimate = engine.generateEstimate({ ...HOME, services: { rodentTrapping: true, deadAnimalRemoval: { tier: 'reachable' } } });
      expect(estimate.lineItems.find((l) => l.service === 'rodent_trapping').quoteRequired).toBe(true);
      expect(lineOf(estimate)).toMatchObject({ price: 169, riding: false });
      // With a PRICED host next to the custom quote, it rides again.
      const withHost = engine.generateEstimate({ ...HOME, services: { rodentTrapping: true, rodentInspection: true, deadAnimalRemoval: { tier: 'attic' } } });
      expect(lineOf(withHost)).toMatchObject({ price: 219, riding: true });
    });
    jest.dontMock('../services/pricing-engine/service-pricing');
  });

  test('recurring bait, fees, riders, discounts and other one-time services are not hosts', () => {
    const { DEAD_ANIMAL_RIDING_HOST_SERVICES: hosts, isDeadAnimalRidingHostLine } = servicePricing;
    for (const service of ['rodent_bait', 'rodent_bait_setup', 'rodent_guarantee', 'rodent_bundle_discount', 'trap_only_retainer', 'one_time_pest', 'area_addon', 'rodent_dead_animal_removal']) {
      expect(hosts.has(service)).toBe(false);
      expect(isDeadAnimalRidingHostLine({ service, price: 99 })).toBe(false);
    }
    expect(price({ rodentBait: true, deadAnimalRemoval: { tier: 'reachable' } })).toMatchObject({ price: 169, riding: false });
  });

  test('a riding key on the request is never read', () => {
    expect(price({ deadAnimalRemoval: { tier: 'reachable', riding: true } })).toMatchObject({ price: 169, riding: false });
    expect(price({ deadAnimalRemoval: { tier: 'reachable', riding: true } }).riding).toBe(false);
  });

  test('two lines are never produced, and the line is not its own host', () => {
    const estimate = generateEstimate({ ...HOME, services: { deadAnimalRemoval: { tier: 'attic' } } });
    expect(estimate.lineItems.filter((l) => l.service === 'rodent_dead_animal_removal')).toHaveLength(1);
  });
});

describe('custom quote lines and the commercial hand-off', () => {
  test('in_wall and an unchosen tier carry the custom-quote shape and a manual review reason on the estimate', () => {
    const inWall = generateEstimate({ ...HOME, services: { deadAnimalRemoval: { tier: 'in_wall' } } });
    expect(lineOf(inWall)).toMatchObject({ price: null, quoteRequired: true, requiresCustomQuote: true });
    expect(inWall.pricingMetadata.manualReviewReasons).toContain('dead_animal_in_wall_custom_quote');
    const none = generateEstimate({ ...HOME, services: { deadAnimalRemoval: {} } });
    expect(lineOf(none)).toMatchObject({ price: null, quoteRequired: true });
    expect(none.pricingMetadata.manualReviewReasons).toContain('dead_animal_access_not_chosen');
    expect(lineOf(generateEstimate({ ...HOME, services: { deadAnimalRemoval: true } }))).toMatchObject({ quoteRequired: true });
  });

  test('a custom-quote line adds nothing to the one-time total', () => {
    const estimate = generateEstimate({ ...HOME, services: { deadAnimalRemoval: { tier: 'in_wall' } } });
    expect(estimate.summary.oneTimeTotal ?? 0).toBe(0);
  });

  test('a commercial property gets a commercial manual-quote line and no automatic price', () => {
    for (const tier of ['reachable', 'attic', 'in_wall']) {
      const estimate = generateEstimate({ ...COMMERCIAL, services: { deadAnimalRemoval: { tier } } });
      expect(estimate.lineItems.some((l) => l.service === 'rodent_dead_animal_removal')).toBe(false);
      const manual = estimate.lineItems.find((l) => l.quoteRequired === true);
      expect(manual).toBeTruthy();
      expect(manual.isCommercial || String(manual.service).startsWith('commercial_')).toBe(true);
    }
  });

  test('a commercial property stays a manual quote even with the commercial scoped-one-time gate on', () => {
    const saved = process.env.GATE_COMMERCIAL_ONETIME_SCOPED;
    process.env.GATE_COMMERCIAL_ONETIME_SCOPED = 'true';
    try {
      const estimate = generateEstimate({ ...COMMERCIAL, services: { deadAnimalRemoval: { tier: 'reachable' } } });
      expect(estimate.lineItems.some((l) => l.service === 'rodent_dead_animal_removal')).toBe(false);
      expect(estimate.lineItems.some((l) => l.quoteRequired === true)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.GATE_COMMERCIAL_ONETIME_SCOPED; else process.env.GATE_COMMERCIAL_ONETIME_SCOPED = saved;
    }
  });

  test('a malformed envelope throws instead of skipping', () => {
    expect(() => generateEstimate({ ...HOME, services: { deadAnimalRemoval: 'attic' } })).toThrow(/must be an object/);
    expect(() => generateEstimate({ ...HOME, services: { deadAnimalRemoval: ['attic'] } })).toThrow(/must be an object/);
  });
});

describe('discount behavior matches the other rodent one-time lines', () => {
  const recurring = { isRecurringCustomer: true };
  const discounted = (services) => generateEstimate({ ...HOME, ...recurring, services }).lineItems;

  test('a recurring customer gets the 15% one-time perk, exactly as on rodent sanitation and the rodent inspection', () => {
    const [dead] = discounted({ deadAnimalRemoval: { tier: 'reachable' } });
    const [inspection] = discounted({ rodentInspection: true });
    const [sanitation] = discounted({ sanitation: { tier: 'light', affectedSqFt: 200 } });
    expect(dead).toMatchObject({ price: 169, priceBeforeDiscount: 169, priceAfterDiscount: 143.65 });
    expect(dead.discount.effectiveDiscount).toBe(0.15);
    expect(inspection.discount.effectiveDiscount).toBe(0.15);
    expect(sanitation.discount.effectiveDiscount).toBe(0.15);
    expect(dead.discountable).not.toBe(false);
  });

  test('a customer with no recurring service pays the fixed price', () => {
    expect(lineOf(generateEstimate({ ...HOME, services: { deadAnimalRemoval: { tier: 'attic' } } })).priceAfterDiscount).toBe(269);
  });

  test('the line is not part of a rodent bundle', () => {
    const estimate = generateEstimate({ ...HOME, services: { rodentTrapping: true, deadAnimalRemoval: { tier: 'reachable' } } });
    expect(estimate.lineItems.some((l) => l.service === 'rodent_bundle_discount')).toBe(false);
  });
});

describe('the DB-editable row (pricing_config rodent_dead_animal_removal)', () => {
  function pricingConfigDb(rows) {
    const db = (table) => {
      const query = { select: jest.fn(async () => (table === 'pricing_config' ? rows : [])), orderBy: jest.fn(() => query), then: (resolve) => resolve([]) };
      return query;
    };
    db.schema = { hasTable: jest.fn(async () => true) };
    return db;
  }
  const base = [{ config_key: 'global_labor_rate', data: { value: GLOBAL.LABOR_RATE } }];
  const sync = (data) => syncConstantsFromDB(pricingConfigDb(data === undefined ? base : [...base, { config_key: 'rodent_dead_animal_removal', data }]));
  const seed = () => JSON.parse(JSON.stringify(config.defaultDeadAnimalRemovalData()));

  test('the seed row is the code table', () => {
    expect(seed()).toEqual({
      reachable: { alone: 169, riding: 119, on_site_min: 45 },
      attic: { alone: 269, riding: 219, on_site_min: 90 },
    });
    expect(config.normalizeDeadAnimalRemovalConfig(seed())).toMatchObject({ ok: true });
  });

  test('a valid row is applied: prices and on-site minutes', async () => {
    const edited = { reachable: { alone: 159, riding: 109, on_site_min: 50 }, attic: { alone: 229, riding: 179, on_site_min: 100 } };
    await sync(edited);
    expect(price({ deadAnimalRemoval: { tier: 'reachable' } })).toMatchObject({ price: 159, durationMin: 50 });
    expect(price({ rodentInspection: true, deadAnimalRemoval: { tier: 'attic' } }).price).toBe(179);
    expect(RODENT.deadAnimalRemoval.attic.durationMin).toBe(100);
  });

  test.each([
    ['a string price', { ...seed(), reachable: { alone: '159', riding: 99, on_site_min: 45 } }],
    ['a negative price', { ...seed(), reachable: { alone: -1, riding: 99, on_site_min: 45 } }],
    ['a zero price', { ...seed(), attic: { alone: 0, riding: 0, on_site_min: 90 } }],
    ['a price above the bound', { ...seed(), attic: { alone: 5000, riding: 169, on_site_min: 90 } }],
    ['riding above alone', { ...seed(), reachable: { alone: 99, riding: 149, on_site_min: 45 } }],
    ['fractional minutes', { ...seed(), reachable: { alone: 149, riding: 99, on_site_min: 45.5 } }],
    ['zero minutes', { ...seed(), reachable: { alone: 149, riding: 99, on_site_min: 0 } }],
    ['a missing tier', { reachable: seed().reachable }],
    ['an unknown key', { ...seed(), in_wall: { alone: 100, riding: 80, on_site_min: 60 } }],
    ['an unknown field', { ...seed(), reachable: { ...seed().reachable, material: 12 } }],
    ['not an object', 'cheap'],
    ['an array', []],
  ])('a malformed row (%s) is ignored whole and the code defaults stand', async (_label, data) => {
    await sync(data);
    expect(price({ deadAnimalRemoval: { tier: 'reachable' } })).toMatchObject({ price: 169, durationMin: 45 });
    expect(price({ deadAnimalRemoval: { tier: 'attic' } })).toMatchObject({ price: 269, durationMin: 90 });
  });

  test('a deleted row restores the defaults on the next sync (an old edit is not pinned)', async () => {
    await sync({ reachable: { alone: 159, riding: 109, on_site_min: 50 }, attic: { alone: 229, riding: 179, on_site_min: 100 } });
    expect(price({ deadAnimalRemoval: { tier: 'reachable' } }).price).toBe(159);
    await sync(undefined);
    expect(price({ deadAnimalRemoval: { tier: 'reachable' } }).price).toBe(169);
  });

  test('a row edit never touches the stated material cost', async () => {
    await sync({ reachable: { alone: 159, riding: 109, on_site_min: 50 }, attic: { alone: 229, riding: 179, on_site_min: 100 } });
    expect(RODENT.deadAnimalRemoval.reachable.material).toBe(12);
  });
});

describe('the staff estimator translator (property-lookup-v2)', () => {
  const translate = (selected, options = {}) => translateV2CallToV1Input({ homeSqFt: 2000, lotSqFt: 7500 }, selected, options);

  test('RODENT_DEAD_ANIMAL with an Access choice becomes services.deadAnimalRemoval = { tier }', () => {
    for (const tier of ['reachable', 'attic', 'in_wall']) {
      expect(translate(['RODENT_DEAD_ANIMAL'], { deadAnimalAccess: tier }).services.deadAnimalRemoval).toEqual({ tier });
    }
  });

  test('no Access choice leaves the tier unset (a custom-quote line), never a default', () => {
    expect(translate(['RODENT_DEAD_ANIMAL'], {}).services.deadAnimalRemoval).toEqual({ tier: undefined });
    expect(translate(['RODENT_DEAD_ANIMAL'], { deadAnimalAccess: '' }).services.deadAnimalRemoval.tier).toBeUndefined();
    expect(lineOf(generateEstimate(translate(['RODENT_DEAD_ANIMAL'], {})))).toMatchObject({ quoteRequired: true });
  });

  test('not selected: no input, even when an access value is posted', () => {
    expect(translate([], { deadAnimalAccess: 'attic' }).services.deadAnimalRemoval).toBeUndefined();
  });

  test('a client riding value is not carried', () => {
    const input = translate(['RODENT_DEAD_ANIMAL'], { deadAnimalAccess: 'reachable', deadAnimalRiding: true, riding: true });
    expect(input.services.deadAnimalRemoval).toEqual({ tier: 'reachable' });
    expect(lineOf(generateEstimate(input))).toMatchObject({ price: 169, riding: false });
  });

  test('riding is decided with sanitation selected next to it', () => {
    const input = translate(['RODENT_SANITATION', 'RODENT_DEAD_ANIMAL'], { deadAnimalAccess: 'attic', sanitationTier: 'light', sanitationArea: 200 });
    expect(lineOf(generateEstimate(input))).toMatchObject({ price: 219, riding: true });
  });

  test('gate off: the whole translated request is refused with the 400', () => {
    delete process.env.GATE_DEAD_ANIMAL_REMOVAL;
    expect(() => generateEstimate(translate(['RODENT_DEAD_ANIMAL'], { deadAnimalAccess: 'reachable' }))).toThrow(expect.objectContaining({ code: 'DEAD_ANIMAL_REMOVAL_GATED', statusCode: 400 }));
  });
});

describe('the legacy mapper', () => {
  const mapped = (services) => mapV1ToLegacyShape(generateEstimate({ ...HOME, services }));
  const itemOf = (shape) => [...(shape.oneTime?.items || []), ...(shape.specItems || [])].find((i) => i.service === 'rodent_dead_animal_removal');

  test('a priced line becomes a one-time row with the label, the price, the tier and the on-site minutes', () => {
    const item = itemOf(mapped({ deadAnimalRemoval: { tier: 'attic' } }));
    expect(item).toMatchObject({ service: 'rodent_dead_animal_removal', name: 'Dead Rodent Removal & Odor Treatment', deadAnimalTier: 'attic', onSiteMinutes: 90 });
    expect(Number(item.price)).toBe(269);
  });

  test('a custom-quote line stays an unpriced quote-required row', () => {
    const item = itemOf(mapped({ deadAnimalRemoval: { tier: 'in_wall' } }));
    expect(item).toMatchObject({ service: 'rodent_dead_animal_removal', name: 'Dead Rodent Removal & Odor Treatment', quoteRequired: true });
    expect(item.price == null).toBe(true);
  });

  test('the one-time total counts the priced line only', () => {
    const shape = mapped({ rodentInspection: true, deadAnimalRemoval: { tier: 'reachable' } });
    const items = [...(shape.oneTime?.items || []), ...(shape.specItems || [])].filter((i) => i.price > 0);
    expect(items.map((i) => i.service).sort()).toEqual(['rodent_dead_animal_removal', 'rodent_inspection']);
    expect(items.find((i) => i.service === 'rodent_dead_animal_removal').price).toBe(119);
  });
});

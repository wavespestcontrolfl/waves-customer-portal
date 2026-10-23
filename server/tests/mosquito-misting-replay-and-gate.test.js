/**
 * Mosquito misting (GATE_MOSQUITO_MISTING), Codex round 2 on #6503:
 *  - a distinct identity in the shared service-key resolvers (never the barrier `mosquito` program);
 *  - a sent quote replays from the knobs it was priced with (pricing_config edits never move it);
 *  - a stored misting estimate is refused at every boundary while the gate is off.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { MOSQUITO_MISTING } = require('../services/pricing-engine/constants');
const config = require('../services/pricing-engine/mosquito-misting-config');
const { priceMosquitoMisting } = require('../services/pricing-engine/service-pricing');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const mapper = require('../services/pricing-engine/v1-legacy-mapper');
const { mistingKnobSignalForReplay } = require('../services/estimate-tree-shrub-knob-replay');
const converter = require('../services/estimate-converter');
const seeder = require('../services/recurring-appointment-seeder');
const { CLIENT_IDENTITY_FIELDS } = require('../services/estimate-client-identity-fields');

const PROPERTY = { homeSqFt: 2200, stories: 1, lotSqFt: 12000, propertyType: 'single_family' };
const OPTS = { tier: 'essential', nozzles: 40, risers: 12, solution: 'natural' };
const seed = () => JSON.parse(JSON.stringify(config.defaultMosquitoMistingPricingData()));
const saved = process.env.GATE_MOSQUITO_MISTING;
beforeEach(() => { process.env.GATE_MOSQUITO_MISTING = 'true'; });
afterEach(() => {
  config.rebaseMosquitoMisting();
  if (saved === undefined) delete process.env.GATE_MOSQUITO_MISTING; else process.env.GATE_MOSQUITO_MISTING = saved;
});

describe('identity: the misting plan is never the barrier mosquito program', () => {
  test('recurringServiceKey', () => {
    expect(converter.recurringServiceKey({ service: 'mosquito_misting' })).toBe('mosquito_misting');
    expect(converter.recurringServiceKey({ name: 'Mosquito Misting Service Plan' })).toBe('mosquito_misting');
    expect(converter.recurringServiceKey({ serviceKey: 'mosquito_misting_system' })).toBe('mosquito_misting');
    expect(converter.recurringServiceKey({ service: 'mosquito' })).toBe('mosquito');
    expect(converter.recurringServiceKey({ name: 'Mosquito Control' })).toBe('mosquito');
    expect(converter.recurringServiceKey({ service: 'commercial_mosquito' })).toBe('commercial_mosquito');
  });

  test('the recurring seeder never files a misting plan under the barrier family', () => {
    expect(seeder.serviceKeyFor({ service: 'mosquito_misting' })).toBe('mosquito_misting');
    expect(seeder.serviceKeyFor({ name: 'Mosquito Misting Service Plan' })).toBe('mosquito_misting');
    expect(seeder.serviceKeyFor({ service: 'mosquito' })).toBe('mosquito');
  });

  test('the setup fee: a misting-only plan carries none, the solo barrier mosquito plan still does', () => {
    const misting = { service: 'mosquito_misting', name: 'Mosquito Misting Service Plan' };
    expect(converter.shouldIncludeWaveGuardSetupFeeForRecurring({ recurringServices: [misting], estimateData: {} })).toBe(false);
    expect(converter.shouldIncludeWaveGuardSetupFeeForRecurring({ recurringServices: [{ service: 'mosquito', name: 'Mosquito' }], estimateData: {} })).toBe(true);
  });

  test('the mapped misting estimate resolves to the misting key end to end', () => {
    const mapped = mapper.mapV1ToLegacyShape(generateEstimate({ ...PROPERTY, services: { mosquitoMisting: OPTS } }));
    const keys = mapped.recurring.services.map((svc) => converter.recurringServiceKey(svc));
    expect(keys).toEqual(['mosquito_misting']);
  });
});

describe('replay: a sent misting quote keeps the prices it was priced with', () => {
  const quote = (knobs) => priceMosquitoMisting(PROPERTY, { ...OPTS, ...(knobs ? { knobs } : {}) });
  const figures = (r) => ({ install: r.installation.price, annual: r.annual, perApp: r.perApp, refill: r.refill.perFill, material: r.installation.materialCost, labor: r.installation.laborCost });

  test('after a config edit, repricing with the first result\'s knobs gives the same figures; a fresh quote gives the new ones', () => {
    const first = quote();
    const data = seed();
    data.tiers.essential.price = 3000;
    data.tiers.essential.hardwareCost = 1500;
    data.extraNozzlePrice = 90;
    data.extraRiserPrice = 60;
    data.install = { techs: 3, hours: 8 };
    data.plan = { monthly: 70, visitsPerYear: 10, laborMinutesPerVisit: 30, partsReservePerMonth: 12 };
    data.refills.natural.price = 250;
    config.applyMosquitoMistingPricingConfig(data);
    const fresh = quote();
    expect(figures(fresh)).not.toEqual(figures(first));
    expect(fresh.installation.price).toBe(3000 + 5 * 90 + 2 * 60);
    expect(fresh.annual).toBe(700);
    const replay = quote(first.pricingKnobs);
    expect(figures(replay)).toEqual(figures(first));
    expect(replay.pricingKnobs).toEqual(first.pricingKnobs);
    expect(replay.visitsPerYear).toBe(12);
  });

  test('knobs stamped for another tier or solution do not apply; a missing or non-finite knob falls back per field', () => {
    const first = quote();
    config.applyMosquitoMistingPricingConfig({ ...seed(), plan: { ...seed().plan, monthly: 80 } });
    const live = figures(quote());
    expect(figures(quote({ ...first.pricingKnobs, tier: 'smart' }))).toEqual(live);
    expect(figures(quote({ ...first.pricingKnobs, refillSolution: 'premium' }))).toEqual(live);
    expect(quote({ ...first.pricingKnobs, planMonthly: NaN }).perApp).toBe(80);
    expect(quote({ ...first.pricingKnobs, planMonthly: 'x', tierPrice: Infinity }).perApp).toBe(80);
    expect(quote({ planMonthly: 66 }).perApp).toBe(66);
    expect(quote([1, 2]).perApp).toBe(80);
  });

  test('the engine honors input.mistingPricingKnobs, and the mapper rows carry the stamp', () => {
    const first = generateEstimate({ ...PROPERTY, services: { mosquitoMisting: OPTS } });
    const stamp = first.lineItems.find((l) => l.service === 'mosquito_misting').pricingKnobs;
    const data = seed();
    data.plan.monthly = 90;
    data.tiers.essential.price = 2500;
    config.applyMosquitoMistingPricingConfig(data);
    const fresh = generateEstimate({ ...PROPERTY, services: { mosquitoMisting: OPTS } });
    expect(fresh.lineItems.find((l) => l.service === 'mosquito_misting').perApp).toBe(90);
    const replay = generateEstimate({ ...PROPERTY, services: { mosquitoMisting: OPTS }, mistingPricingKnobs: stamp });
    const line = replay.lineItems.find((l) => l.service === 'mosquito_misting');
    expect(line.perApp).toBe(59);
    expect(line.installation.price).toBe(3795 + 5 * 75 + 2 * 45);
    const mapped = mapper.mapV1ToLegacyShape(first);
    expect(mapped.recurring.services.find((s) => s.service === 'mosquito_misting').pricingKnobs).toEqual(stamp);
    expect(mapped.oneTime.items.find((i) => i.service === 'mosquito_misting_installation').pricingKnobs).toEqual(stamp);
  });

  test('mistingKnobSignalForReplay reads the stamp back from a stored estimate_data shape', () => {
    const est = generateEstimate({ ...PROPERTY, services: { mosquitoMisting: OPTS } });
    const stamp = est.lineItems.find((l) => l.service === 'mosquito_misting').pricingKnobs;
    const mapped = mapper.mapV1ToLegacyShape(est);
    expect(mistingKnobSignalForReplay({ result: mapped })).toEqual(stamp);
    expect(mistingKnobSignalForReplay(JSON.stringify({ result: mapped }))).toEqual(stamp);
    expect(mistingKnobSignalForReplay({ engineResult: est })).toEqual(stamp);
    // no misting row, an unstamped row, or a damaged stamp inject nothing
    expect(mistingKnobSignalForReplay({ result: mapper.mapV1ToLegacyShape(generateEstimate({ ...PROPERTY, services: { pest: { frequency: 'quarterly' } } })) })).toBeNull();
    const unstamped = JSON.parse(JSON.stringify(mapped));
    for (const row of unstamped.recurring.services) delete row.pricingKnobs;
    for (const row of unstamped.oneTime.items) delete row.pricingKnobs;
    expect(mistingKnobSignalForReplay({ result: unstamped })).toBeNull();
    const damaged = JSON.parse(JSON.stringify(mapped));
    damaged.recurring.services.find((s) => s.service === 'mosquito_misting').pricingKnobs.planMonthly = 'x';
    damaged.oneTime.items.find((i) => i.service === 'mosquito_misting_installation').pricingKnobs = null;
    expect(mistingKnobSignalForReplay({ result: damaged })).toBeNull();
    expect(mistingKnobSignalForReplay(null)).toBeNull();
  });

  test('a posted copy of the replay stamp is stripped as a server-owned field', () => {
    expect(CLIENT_IDENTITY_FIELDS).toContain('mistingPricingKnobs');
  });

  test('the replay paths inject it beside the termite stamp', () => {
    const fs = require('fs');
    const path = require('path');
    const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    expect(read('routes/estimate-public.js')).toContain('overrides.mistingPricingKnobs = mistingKnobs');
    expect(read('services/admin-estimate-persistence.js')).toContain('v1Input.mistingPricingKnobs = mistingKnobs');
  });
});

describe('a stored misting estimate is refused while the gate is off', () => {
  const stored = () => {
    const input = { ...PROPERTY, services: { mosquitoMisting: OPTS } };
    const est = generateEstimate(input);
    const mapped = mapper.mapV1ToLegacyShape(est);
    return { result: mapped, engineInputs: input };
  };

  test('gate off: the customer and staff refusals fire, with the reason and a 409-able code', () => {
    const data = stored(); // priced while the gate was on
    delete process.env.GATE_MOSQUITO_MISTING;
    expect(mapper.gatedAddOnCustomerRefusal(data)).toMatchObject({ code: 'MOSQUITO_MISTING_GATED', reason: 'mosquito_misting_disabled', error: expect.any(String) });
    expect(mapper.gatedAddOnCustomerRefusal(JSON.stringify(data))).toMatchObject({ code: 'MOSQUITO_MISTING_GATED' });
    expect(mapper.gatedAddOnStaffRefusal(data, 'accepting')).toMatchObject({ code: 'MOSQUITO_MISTING_GATED', reason: 'mosquito_misting_disabled', message: expect.stringMatching(/GATE_MOSQUITO_MISTING/) });
    expect(mapper.estimateMistingGated(data)).toBe(true);
  });

  test('every evidence shape counts: rows alone, inputs alone, the install item alone, the raw engine line', () => {
    const data = stored();
    delete process.env.GATE_MOSQUITO_MISTING;
    expect(mapper.estimateMistingGated({ result: data.result })).toBe(true);
    expect(mapper.estimateMistingGated({ engineInputs: data.engineInputs })).toBe(true);
    expect(mapper.estimateMistingGated({ engineRequest: { options: { services: { mosquito_misting: OPTS } } } })).toBe(true);
    expect(mapper.estimateMistingGated({ result: { oneTime: { items: [{ service: 'mosquito_misting_installation', price: 4000 }] } } })).toBe(true);
    expect(mapper.estimateMistingGated({ engineResult: { lineItems: [{ service: 'mosquito_misting', annual: 708 }] } })).toBe(true);
  });

  test('gate on: unchanged (no refusal)', () => {
    const data = stored();
    expect(mapper.gatedAddOnCustomerRefusal(data)).toBeNull();
    expect(mapper.gatedAddOnStaffRefusal(data, 'accepting')).toBeNull();
    expect(mapper.estimateMistingGated(data)).toBe(false);
  });

  test('an estimate with no misting is never refused, gate on or off', () => {
    const plain = { result: mapper.mapV1ToLegacyShape(generateEstimate({ ...PROPERTY, services: { pest: { frequency: 'quarterly' } } })), engineInputs: { services: { pest: {} } } };
    delete process.env.GATE_MOSQUITO_MISTING;
    expect(mapper.gatedAddOnCustomerRefusal(plain)).toBeNull();
    expect(mapper.estimateDataCarriesMosquitoMisting(plain)).toBe(false);
    expect(mapper.estimateDataCarriesMosquitoMisting(null)).toBe(false);
    expect(mapper.estimateDataCarriesMosquitoMisting('{not json')).toBe(false);
  });

  test('the engine fails closed on a replay with the stored stamp and the gate off; a fresh quote with the key is just ignored', () => {
    const stamp = generateEstimate({ ...PROPERTY, services: { mosquitoMisting: OPTS } }).lineItems.find((l) => l.service === 'mosquito_misting').pricingKnobs;
    delete process.env.GATE_MOSQUITO_MISTING;
    expect(() => generateEstimate({ ...PROPERTY, services: { mosquitoMisting: OPTS }, mistingPricingKnobs: stamp }))
      .toThrow(expect.objectContaining({ statusCode: 400, code: 'MOSQUITO_MISTING_GATED', reason: 'mosquito_misting_disabled', failClosed: true }));
    expect(() => generateEstimate({ ...PROPERTY, services: { pest: { frequency: 'quarterly' }, mosquitoMisting: OPTS } })).not.toThrow();
  });

  test('the accept route rechecks the gate inside the transaction through the same refusal', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'estimate-public.js'), 'utf8');
    expect(src).toContain('assertAreaAddOnGateOpenAtCommit(estimate);');
    expect(src).toMatch(/function assertAreaAddOnGateOpenAtCommit\(estimate\) \{\s*const refusal = require\('\.\.\/services\/pricing-engine\/v1-legacy-mapper'\)\.gatedAddOnCustomerRefusal\(/);
    // the deposit webhook treats it as unrecordable (refund rail) like the other gated add-ons
    const deposits = fs.readFileSync(path.join(__dirname, '..', 'services', 'estimate-deposits.js'), 'utf8');
    expect(deposits).toContain("reason: 'mosquito_misting_disabled'");
  });
});

describe('the other resolvers never read the misting plan as the barrier program', () => {
  test('waveguard-existing-services: a misting row is not a mosquito WaveGuard qualifier; a barrier row still is', () => {
    const { toQualifyingKeys } = require('../services/waveguard-existing-services');
    expect(toQualifyingKeys('Mosquito Misting Service Plan')).not.toContain('mosquito');
    expect(toQualifyingKeys('mosquito_misting')).not.toContain('mosquito');
    expect(toQualifyingKeys('Monthly Mosquito Control')).toContain('mosquito');
  });

  test('the tier-qualifying keys of a misting-only estimate are empty', () => {
    const mapped = mapper.mapV1ToLegacyShape(generateEstimate({ ...PROPERTY, services: { mosquitoMisting: OPTS } }));
    expect(converter.tierQualifyingRecurringServiceKeys(mapped.recurring.services)).toEqual([]);
  });
});

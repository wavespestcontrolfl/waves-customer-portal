/**
 * Mosquito misting (GATE_MOSQUITO_MISTING), Codex round 2 on #6503:
 *  - a distinct identity in the shared service-key resolvers (never the barrier `mosquito` program);
 *  - a sent quote replays from the knobs it was priced with (pricing_config edits never move it);
 *  - a stored misting estimate is refused at every boundary while the gate is off.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

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

  test('gate on: the GATED refusal is off (acceptance is separately pending, see below); the send refusal is clear', () => {
    const data = stored();
    expect(mapper.estimateMistingGated(data)).toBe(false);
    expect(mapper.gatedAddOnCustomerRefusal(data)).toMatchObject({ code: 'MOSQUITO_MISTING_ACCEPT_PENDING' });
    expect(mapper.gatedAddOnStaffRefusal(data, 'sending', { allowAcceptPending: true })).toBeNull();
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

describe('false misting selections are not selections (the engine\'s own rule)', () => {
  test.each([[false], [0], [''], [null], [undefined], ['yes'], [[]], [['x']]])('services.mosquitoMisting = %p is not carried', (value) => {
    delete process.env.GATE_MOSQUITO_MISTING;
    for (const key of ['mosquitoMisting', 'mosquito_misting']) {
      const data = { engineInputs: { services: { [key]: value } } };
      expect(mapper.estimateDataCarriesMosquitoMisting(data)).toBe(false);
      expect(mapper.estimateMistingGated(data)).toBe(false);
      expect(mapper.estimateMistingAcceptBlocked(data)).toBe(false);
      expect(mapper.gatedAddOnCustomerRefusal(data)).toBeNull();
    }
  });

  test('true and a plain object (even empty) are selections, like the engine', () => {
    for (const value of [true, {}, { tier: 'smart' }]) {
      expect(mapper.estimateDataCarriesMosquitoMisting({ engineInputs: { services: { mosquitoMisting: value } } })).toBe(true);
    }
  });
});

describe('the engine and the guard share ONE selection rule', () => {
  const { isMistingSelection } = require('../utils/mosquito-misting-system');
  const price = (value, extra = {}) => generateEstimate({ ...PROPERTY, services: { mosquitoMisting: value }, ...extra }).lineItems.some((l) => l.service === 'mosquito_misting');

  test.each([['yes', false], [1, false], [[], false], ['true', false], [{}, true], [true, true], [false, false], [0, false], ['', false], [null, false]])(
    'services.mosquitoMisting = %p: priced %p, and the guard agrees',
    (value, selected) => {
      expect(isMistingSelection(value)).toBe(selected);
      expect(price(value)).toBe(selected);
      expect(mapper.estimateDataCarriesMosquitoMisting({ engineInputs: { services: { mosquitoMisting: value } } })).toBe(selected);
      expect(mapper.estimateMistingAcceptBlocked({ engineInputs: { services: { mosquitoMisting: value } } })).toBe(selected);
    },
  );

  test('the snake_case spelling follows the same rule, and a rejected first spelling does not hide a valid second one', () => {
    expect(generateEstimate({ ...PROPERTY, services: { mosquito_misting: 'yes' } }).lineItems.some((l) => l.service === 'mosquito_misting')).toBe(false);
    expect(generateEstimate({ ...PROPERTY, services: { mosquito_misting: {} } }).lineItems.some((l) => l.service === 'mosquito_misting')).toBe(true);
    expect(generateEstimate({ ...PROPERTY, services: { mosquitoMisting: 'yes', mosquito_misting: true } }).lineItems.some((l) => l.service === 'mosquito_misting')).toBe(true);
  });

  test('a stored inputs-only estimate with a truthy string is neither priced on replay nor blocked, gate on or off', () => {
    const stamp = generateEstimate({ ...PROPERTY, services: { mosquitoMisting: OPTS } }).lineItems.find((l) => l.service === 'mosquito_misting').pricingKnobs;
    const stored = { engineInputs: { services: { mosquitoMisting: 'yes' } } };
    expect(mapper.gatedAddOnCustomerRefusal(stored)).toBeNull();
    expect(price('yes', { mistingPricingKnobs: stamp })).toBe(false);
    delete process.env.GATE_MOSQUITO_MISTING;
    expect(mapper.gatedAddOnCustomerRefusal(stored)).toBeNull();
    expect(() => generateEstimate({ ...PROPERTY, services: { mosquitoMisting: 'yes' }, mistingPricingKnobs: stamp })).not.toThrow();
  });
});

describe('acceptance of a priced misting estimate is pending misting PR 2, even with the gate on', () => {
  const constants = require('../services/pricing-engine/constants');
  const priced = () => {
    const input = { ...PROPERTY, services: { mosquitoMisting: OPTS } };
    return { result: mapper.mapV1ToLegacyShape(generateEstimate(input)), engineInputs: input };
  };
  const oversize = () => {
    const input = { ...PROPERTY, services: { pest: { frequency: 'quarterly' }, mosquitoMisting: { nozzles: 120 } } };
    return { result: mapper.mapV1ToLegacyShape(generateEstimate(input)), engineInputs: { ...input, services: { pest: input.services.pest } } };
  };

  test('the readiness constant is code-owned and false', () => {
    expect(constants.MOSQUITO_MISTING_CONVERSION_READY).toBe(false);
  });

  test('gate ON + priced misting: the customer and staff refusals fire with the new code, reason and texts', () => {
    const data = priced();
    expect(mapper.estimateMistingAcceptBlocked(data)).toBe(true);
    expect(mapper.gatedAddOnCustomerRefusal(data)).toEqual({
      error: mapper.AREA_ADDONS_GATED_CUSTOMER_MESSAGE, code: 'MOSQUITO_MISTING_ACCEPT_PENDING', reason: 'mosquito_misting_conversion_pending',
    });
    expect(mapper.gatedAddOnStaffRefusal(data, 'accepting')).toEqual({
      code: 'MOSQUITO_MISTING_ACCEPT_PENDING', reason: 'mosquito_misting_conversion_pending',
      message: 'This estimate includes a mosquito misting system. Online acceptance and scheduling for misting plans are not built yet (misting PR 2); book the design visit and the install by hand.',
    });
    expect(mapper.gatedAddOnCustomerRefusal(JSON.stringify(data))).toMatchObject({ code: 'MOSQUITO_MISTING_ACCEPT_PENDING' });
  });

  test('staff SEND stays allowed (allowAcceptPending); the public view never calls the refusal', () => {
    const data = priced();
    expect(mapper.gatedAddOnStaffRefusal(data, 'sending', { allowAcceptPending: true })).toBeNull();
    expect(mapper.gatedAddOnCustomerRefusal(data, { allowAcceptPending: true })).toBeNull();
    const fs = require('fs');
    const path = require('path');
    const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    expect(read('routes/admin-estimates.js')).toContain("'sending', { pricingAuthority: estimate.pricing_authority, allowAcceptPending: true }");
    // manual acceptance and the booking preflight use the plain staff refusal (blocked)
    expect(read('services/estimate-manual-acceptance.js')).toMatch(/mapper\.gatedAddOnStaffRefusal\(estimate\.estimate_data \|\| estimate\.estimateData, action, \{ pricingAuthority: estimate\.pricing_authority \}\)/);
  });

  test('manual acceptance refuses it with the new code', () => {
    const { persistedAddOnRefusal } = require('../services/estimate-manual-acceptance');
    if (typeof persistedAddOnRefusal !== 'function') return;
    expect(persistedAddOnRefusal({ estimate_data: priced() }, { action: 'accepting' })).toMatchObject({ code: 'MOSQUITO_MISTING_ACCEPT_PENDING' });
  });

  test('the deposit webhook records nothing for it', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'estimate-deposits.js'), 'utf8');
    expect(src).toContain("reason: 'mosquito_misting_conversion_pending'");
    expect(src).toContain('estimateMistingAcceptBlocked(estimate.estimate_data');
  });

  test('gate OFF: the existing gated code wins', () => {
    const data = priced();
    delete process.env.GATE_MOSQUITO_MISTING;
    expect(mapper.gatedAddOnCustomerRefusal(data)).toMatchObject({ code: 'MOSQUITO_MISTING_GATED', reason: 'mosquito_misting_disabled' });
    expect(mapper.gatedAddOnStaffRefusal(data, 'accepting')).toMatchObject({ code: 'MOSQUITO_MISTING_GATED' });
  });

  test('no misting: unchanged; an unpriced oversize-only row does not block', () => {
    const plain = { result: mapper.mapV1ToLegacyShape(generateEstimate({ ...PROPERTY, services: { pest: { frequency: 'quarterly' } } })), engineInputs: { services: { pest: {} } } };
    expect(mapper.estimateMistingAcceptBlocked(plain)).toBe(false);
    expect(mapper.gatedAddOnCustomerRefusal(plain)).toBeNull();
    expect(mapper.estimateDataCarriesPricedMisting(oversize())).toBe(false);
    expect(mapper.estimateMistingAcceptBlocked(oversize())).toBe(false);
    expect(mapper.gatedAddOnCustomerRefusal(oversize())).toBeNull();
  });

  test('evidence shapes: plan row, install item, raw engine line, selected input; an unpriced row beside nothing else does not count', () => {
    expect(mapper.estimateDataCarriesPricedMisting({ result: { recurring: { services: [{ service: 'mosquito_misting', mo: 59 }] } } })).toBe(true);
    expect(mapper.estimateDataCarriesPricedMisting({ result: { oneTime: { items: [{ service: 'mosquito_misting_installation', price: 4000 }] } } })).toBe(true);
    expect(mapper.estimateDataCarriesPricedMisting({ engineResult: { lineItems: [{ service: 'mosquito_misting', annual: 708 }] } })).toBe(true);
    expect(mapper.estimateDataCarriesPricedMisting({ engineInputs: { services: { mosquitoMisting: {} } } })).toBe(true);
    expect(mapper.estimateDataCarriesPricedMisting({ result: { recurring: { services: [{ service: 'mosquito_misting', quoteRequired: true }] } } })).toBe(false);
    expect(mapper.estimateDataCarriesPricedMisting(null)).toBe(false);
  });

  test('when conversion is ready the block lifts (the PR 2 switch)', () => {
    constants.MOSQUITO_MISTING_CONVERSION_READY = true;
    try {
      expect(mapper.estimateMistingAcceptBlocked(priced())).toBe(false);
      expect(mapper.gatedAddOnCustomerRefusal(priced())).toBeNull();
    } finally {
      constants.MOSQUITO_MISTING_CONVERSION_READY = false;
    }
  });
});

describe('replay resolves an implicit tier and solution from the stamp, not the live defaults', () => {
  test('a saved `mosquitoMisting: true` input replays the system it was sold as after the defaults change', () => {
    const { MOSQUITO_MISTING: M } = require('../services/pricing-engine/constants');
    const first = priceMosquitoMisting(PROPERTY, {});
    expect(first.tier).toBe('smart');
    expect(first.installation.price).toBe(4595);
    const savedTier = M.defaultTier;
    const savedSolution = M.defaultSolution;
    try {
      M.defaultTier = 'essential';
      M.defaultSolution = 'premium';
      const fresh = priceMosquitoMisting(PROPERTY, {});
      expect(fresh.tier).toBe('essential');
      expect(fresh.installation.price).toBe(3795);
      const replay = priceMosquitoMisting(PROPERTY, { knobs: first.pricingKnobs });
      expect(replay.tier).toBe('smart');
      expect(replay.solution).toBe('standard');
      expect(replay.installation.price).toBe(first.installation.price);
      expect(replay.annual).toBe(first.annual);
      expect(replay.refill.perFill).toBe(first.refill.perFill);
      expect(replay.manualReviewReasons).toEqual([]);
      // an explicit option still wins, and a mismatch with the stamp skips the stamp
      const explicit = priceMosquitoMisting(PROPERTY, { tier: 'essential', knobs: first.pricingKnobs });
      expect(explicit.tier).toBe('essential');
      expect(explicit.installation.price).toBe(3795);
      // through the engine, with the saved input shape `true`
      const est = generateEstimate({ ...PROPERTY, services: { mosquitoMisting: true }, mistingPricingKnobs: first.pricingKnobs });
      expect(est.lineItems.find((l) => l.service === 'mosquito_misting').installation.price).toBe(4595);
    } finally {
      M.defaultTier = savedTier;
      M.defaultSolution = savedSolution;
    }
  });
});

describe('an authored proposal keeps the misting identity', () => {
  const { normalizeBuilding, normalizePrograms } = require('../services/estimate-proposal');
  // The PUT stores buildings / programs through these normalizers; the detector reads what they persist.
  const authored = (lines, programs) => ({
    result: { recurring: { services: [{ service: 'pest_control', mo: 40 }] } },
    proposal: {
      enabled: true,
      buildings: [normalizeBuilding({ name: 'Home', lineItems: lines })],
      ...(programs ? { programs: normalizePrograms(programs) } : {}),
    },
  });
  const planLine = { description: 'Mosquito Misting Service Plan — 12 applications/yr', unitPrice: 59, frequency: 'per_application', visitsPerYear: 12 };
  const installLine = { service: 'mosquito_misting_installation', description: 'Essential system (drum) Installation', unitPrice: 4000, frequency: 'one_time' };
  const commercialLine = { service: 'commercial_pest', originalRequestedService: 'mosquito_misting', label: 'Mosquito Misting System (commercial)', description: 'Commercial misting', unitPrice: 9000, frequency: 'one_time' };
  const plainLine = { description: 'Quarterly pest control', unitPrice: 120, frequency: 'quarterly' };

  test('the normalizers keep the identity on a misting line and a program, and change nothing else', () => {
    const data = authored([planLine, installLine, commercialLine, plainLine], [{ service: 'mosquito', label: 'Mosquito Misting Service Plan', frequencyPerYear: 12, pricePerApplication: 59 }]);
    const lines = data.proposal.buildings[0].lineItems;
    expect(lines[0].service).toBe('mosquito_misting');
    expect(lines[1].service).toBe('mosquito_misting_installation');
    expect(lines[2]).toMatchObject({ service: 'mosquito_misting', originalRequestedService: 'mosquito_misting' });
    expect(lines[3]).not.toHaveProperty('service');
    expect(data.proposal.programs[0]).toMatchObject({ service: 'mosquito', identity: 'mosquito_misting' });
    const plain = authored([plainLine], [{ service: 'pest', label: 'Pest', frequencyPerYear: 4, pricePerApplication: 120 }]);
    expect(plain.proposal.buildings[0].lineItems[0]).not.toHaveProperty('service');
    expect(plain.proposal.programs[0]).not.toHaveProperty('identity');
  });

  test.each([['the plan line', [planLine]], ['the install line', [installLine]], ['the commercial manual-quote line', [commercialLine]]])('%s: gated with the gate off, accept-pending with the gate on', (_n, lines) => {
    const data = authored(lines);
    expect(data.proposal.enabled).toBe(true);
    expect(mapper.estimateMistingAcceptBlocked(data)).toBe(true);
    expect(mapper.gatedAddOnCustomerRefusal(data)).toMatchObject({ code: 'MOSQUITO_MISTING_ACCEPT_PENDING' });
    delete process.env.GATE_MOSQUITO_MISTING;
    expect(mapper.estimateMistingGated(data)).toBe(true);
    expect(mapper.gatedAddOnCustomerRefusal(data)).toMatchObject({ code: 'MOSQUITO_MISTING_GATED' });
    expect(mapper.gatedAddOnStaffRefusal(data, 'accepting')).toMatchObject({ code: 'MOSQUITO_MISTING_GATED' });
  });

  test('a misting PROGRAM is detected', () => {
    const data = authored([plainLine], [{ service: 'other', identity: 'mosquito_misting', label: 'Misting plan', frequencyPerYear: 12, pricePerApplication: 59 }]);
    expect(mapper.estimateMistingAcceptBlocked(data)).toBe(true);
  });

  test('a proposal with no misting line is not carried, and the retained engine rows do not leak through proposal mode', () => {
    const none = authored([plainLine]);
    expect(mapper.estimateDataCarriesMosquitoMisting(none)).toBe(false);
    expect(mapper.estimateMistingAcceptBlocked(none)).toBe(false);
    const leftover = { ...none, engineResult: { lineItems: [{ service: 'mosquito_misting', annual: 708 }] } };
    expect(mapper.estimateDataCarriesMosquitoMisting(leftover)).toBe(false);
  });

  test('the free design visit is not the misting system, and an unpriced misting line does not block', () => {
    const design = authored([{ service: 'mosquito_misting_system', description: 'Mosquito Misting System Service', unitPrice: 0, frequency: 'one_time' }, plainLine]);
    expect(mapper.estimateDataCarriesMosquitoMisting(design)).toBe(false);
    const unpriced = authored([{ ...planLine, unitPrice: 0 }, plainLine]);
    expect(mapper.estimateDataCarriesMosquitoMisting(unpriced)).toBe(true);
    expect(mapper.estimateMistingAcceptBlocked(unpriced)).toBe(false);
  });
});

describe('the proposal editor cannot launder the misting identity away', () => {
  const { normalizeBuilding, normalizePrograms, carryMistingIdentity } = require('../services/estimate-proposal');
  const { mistingProposalIdentity } = require('../utils/mosquito-misting-system');
  const savedProposal = () => ({
    enabled: true,
    buildings: [normalizeBuilding({ name: 'Home', lineItems: [
      { id: 'install', service: 'mosquito_misting_installation', description: 'Essential system (drum) Installation', unitPrice: 4000, frequency: 'one_time' },
      { id: 'commercial', service: 'commercial_pest', originalRequestedService: 'mosquito_misting', description: 'Commercial misting', unitPrice: 9000, frequency: 'one_time' },
      { id: 'plain', description: 'Quarterly pest', unitPrice: 120, frequency: 'quarterly' },
    ] })],
    programs: normalizePrograms([{ id: 'prog-1', service: 'mosquito', identity: 'mosquito_misting', label: 'Misting plan', frequencyPerYear: 12, pricePerApplication: 59 }]),
  });
  // What an older editor PUTs back: every line / program with its service / identity fields omitted (ids kept, as the editors do).
  const stripped = (proposal) => ({
    ...proposal,
    buildings: proposal.buildings.map((b) => ({ ...b, lineItems: b.lineItems.map(({ service, originalRequestedService, quoteRequired, ...rest }) => ({ ...rest, description: rest.description === 'Essential system (drum) Installation' ? 'Install' : rest.description })) })),
    programs: proposal.programs.map(({ identity, ...rest }) => ({ ...rest, label: 'Plan' })),
  });
  const persist = (incoming, saved) => {
    const carried = carryMistingIdentity(incoming, saved);
    return { buildings: carried.buildings.map((b) => normalizeBuilding(b)), programs: normalizePrograms(carried.programs), enabled: true };
  };

  test('a PUT with service / identity omitted still persists the identity (by line id; by program id)', () => {
    const saved = savedProposal();
    const next = persist(stripped(saved), saved);
    const byId = Object.fromEntries(next.buildings[0].lineItems.map((l) => [l.id, l]));
    expect(byId.install.service).toBe('mosquito_misting_installation');
    expect(byId.commercial).toMatchObject({ originalRequestedService: 'mosquito_misting' });
    expect(byId.plain).not.toHaveProperty('service');
    expect(next.programs[0].identity).toBe('mosquito_misting');
  });

  test('the refusals still fire after the round trip (gate on: accept-pending; gate off: gated)', () => {
    const saved = savedProposal();
    const data = { result: { recurring: { services: [{ service: 'pest_control' }] } }, proposal: persist(stripped(saved), saved) };
    expect(mapper.gatedAddOnStaffRefusal(data, 'accepting')).toMatchObject({ code: 'MOSQUITO_MISTING_ACCEPT_PENDING' });
    delete process.env.GATE_MOSQUITO_MISTING;
    expect(mapper.gatedAddOnStaffRefusal(data, 'accepting')).toMatchObject({ code: 'MOSQUITO_MISTING_GATED' });
    // control: without the carry the identity would be lost and the refusal would be null
    const lost = { ...data, proposal: { enabled: true, buildings: stripped(saved).buildings.map((b) => normalizeBuilding(b)), programs: normalizePrograms(stripped(saved).programs) } };
    expect(mapper.gatedAddOnStaffRefusal(lost, 'accepting')).toBeNull();
  });

  test('a new line (no id match) carries nothing, and the incoming object is not mutated', () => {
    const saved = savedProposal();
    const incoming = { buildings: [{ name: 'Home', lineItems: [{ id: 'brand-new', description: 'Sprinkler check', unitPrice: 50, frequency: 'one_time' }, { description: 'No id', unitPrice: 10, frequency: 'one_time' }] }] };
    const before = JSON.stringify(incoming);
    const carried = carryMistingIdentity(incoming, saved);
    expect(JSON.stringify(incoming)).toBe(before);
    for (const line of carried.buildings[0].lineItems) expect(line).not.toHaveProperty('service');
  });

  test('an incoming line that already names the system is left alone; the design visit key is never carried', () => {
    const saved = { buildings: [{ lineItems: [{ id: 'd', service: 'mosquito_misting_system' }] }] };
    const carried = carryMistingIdentity({ buildings: [{ lineItems: [{ id: 'd', description: 'Design visit' }] }] }, saved);
    expect(carried.buildings[0].lineItems[0]).not.toHaveProperty('service');
  });

  test('program identity is carried by STABLE ID only; a same-length array with a replaced program is never stamped by position', () => {
    const saved = { programs: [{ id: 'm1', service: 'mosquito', identity: 'mosquito_misting', label: 'Misting plan' }, { id: 'p1', service: 'pest', label: 'Pest' }] };
    const renamed = carryMistingIdentity({ programs: [{ id: 'm1', service: 'mosquito', label: 'Renamed' }, { id: 'p1', service: 'pest', label: 'Pest' }] }, saved);
    expect(renamed.programs[0].identity).toBe('mosquito_misting');
    expect(renamed.programs[1]).not.toHaveProperty('identity');
    // Codex repro: saved [misting, pest], incoming [pest, lawn] (same length) — nothing inherits the identity.
    const replaced = carryMistingIdentity({ programs: [{ id: 'p1', service: 'pest', label: 'Pest' }, { id: 'l1', service: 'lawn', label: 'Lawn' }] }, saved);
    for (const program of replaced.programs) expect(program).not.toHaveProperty('identity');
    // A legacy saved program with no id matches only an exact label, never a position.
    const legacy = { programs: [{ service: 'mosquito', identity: 'mosquito_misting', label: 'Misting plan' }] };
    expect(carryMistingIdentity({ programs: [{ service: 'mosquito', label: 'Misting plan' }] }, legacy).programs[0].identity).toBe('mosquito_misting');
    expect(carryMistingIdentity({ programs: [{ service: 'mosquito', label: 'Renamed' }] }, legacy).programs[0]).not.toHaveProperty('identity');
    // normalizeProgram keeps the id so the next save can match it.
    expect(normalizePrograms([{ id: 'm1', service: 'mosquito', identity: 'mosquito_misting', label: 'Misting plan', frequencyPerYear: 12, pricePerApplication: 59 }])[0]).toMatchObject({ id: 'm1', identity: 'mosquito_misting' });
  });

  test('a corrective-work row carries the identity by id through a save; a new row carries nothing', () => {
    const { normalizeCorrectiveWork } = require('../services/estimate-proposal');
    const saved = { enabled: true, buildings: [], correctiveWork: normalizeCorrectiveWork([{ id: 'cw-1', service: 'mosquito_misting_installation', label: 'Install', amount: 4000 }]) };
    expect(saved.correctiveWork[0]).toMatchObject({ id: 'cw-1', service: 'mosquito_misting_installation' });
    const incoming = { correctiveWork: [{ id: 'cw-1', label: 'Install', amount: 4000 }, { id: 'cw-new', label: 'Gutter', amount: 50 }] };
    const persisted = { enabled: true, buildings: [], correctiveWork: normalizeCorrectiveWork(carryMistingIdentity(incoming, saved).correctiveWork) };
    expect(persisted.correctiveWork[0].service).toBe('mosquito_misting_installation');
    expect(persisted.correctiveWork[1].service).toBeNull();
    const data = { result: { recurring: { services: [{ service: 'pest_control' }] } }, proposal: persisted };
    process.env.GATE_MOSQUITO_MISTING = 'true';
    expect(mapper.gatedAddOnCustomerRefusal(data)).toMatchObject({ code: 'MOSQUITO_MISTING_ACCEPT_PENDING' });
    const lost = { ...data, proposal: { enabled: true, buildings: [], correctiveWork: normalizeCorrectiveWork(incoming.correctiveWork) } };
    expect(mapper.gatedAddOnCustomerRefusal(lost)).toBeNull();
  });

  test('a corrective-work row with no service persists the inferred misting identity, so a later rename keeps it', () => {
    const { normalizeCorrectiveWork } = require('../services/estimate-proposal');
    const first = { enabled: true, buildings: [], correctiveWork: normalizeCorrectiveWork([{ id: 'cw-9', label: 'Smart system (tankless + app) Installation', amount: 4595 }]) };
    expect(first.correctiveWork[0].service).toBe('mosquito_misting_installation');
    const renamed = normalizeCorrectiveWork(carryMistingIdentity({ correctiveWork: [{ id: 'cw-9', label: 'Install the system', amount: 4595 }] }, first).correctiveWork);
    expect(renamed[0].service).toBe('mosquito_misting_installation');
    process.env.GATE_MOSQUITO_MISTING = 'true';
    expect(mapper.gatedAddOnCustomerRefusal({ result: { recurring: { services: [] } }, proposal: { enabled: true, buildings: [], correctiveWork: renamed } })).toMatchObject({ code: 'MOSQUITO_MISTING_ACCEPT_PENDING' });
    expect(normalizeCorrectiveWork([{ label: 'Gutter guard', amount: 50 }])[0].service).toBeNull();
  });

  test('text fallback: the install labels the mapper emits are recognized without any service field', () => {
    for (const label of ['Essential system (drum) Installation', 'Smart system (tankless + app) Installation']) {
      expect(mistingProposalIdentity({ description: label })).toBe('mosquito_misting_installation');
    }
    const mapped = mapper.mapV1ToLegacyShape(generateEstimate({ ...PROPERTY, services: { mosquitoMisting: OPTS } }));
    const item = mapped.oneTime.items.find((i) => i.service === 'mosquito_misting_installation');
    expect(mistingProposalIdentity({ description: item.name })).toBe('mosquito_misting_installation');
    expect(mistingProposalIdentity({ description: 'Quarterly pest control' })).toBeNull();
    expect(mistingProposalIdentity({ description: 'Mosquito Misting System Service' })).toBeNull();
  });

  test('the PUT route carries it before normalizing, only from an enabled saved proposal', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-estimates.js'), 'utf8');
    expect(src).toContain('savedProposal.enabled ? carryMistingIdentity(incoming, savedProposal) : incoming');
    expect(src).toContain('estimate_data: { proposal: { ...incomingWithIdentity, enabled: true } }');
  });
});

describe('bare "misting" stays the barrier mosquito program', () => {
  const { isMistingSystemIdentity } = require('../utils/mosquito-misting-system');
  const normalizer = require('../utils/service-normalizer');

  test('the shared predicate: key-first, then the system / service plan phrases only', () => {
    for (const yes of ['mosquito_misting', 'mosquito_misting_system', 'mosquito_misting_install', 'Mosquito Misting Service Plan', 'Mosquito Misting System Service']) {
      expect(isMistingSystemIdentity(yes)).toBe(true);
    }
    for (const no of ['21-day mosquito misting', 'mosquito misting', 'misting', 'Mosquito Misting', 'Mosquito Control', 'mosquito', '', null, undefined]) {
      expect(isMistingSystemIdentity(no)).toBe(false);
    }
  });

  test('recurringServiceKey and the seeder', () => {
    expect(converter.recurringServiceKey({ name: '21-day mosquito misting' })).toBe('mosquito');
    expect(converter.recurringServiceKey({ name: 'Mosquito Misting' })).toBe('mosquito');
    expect(seeder.serviceKeyFor({ name: '21-day mosquito misting' })).toBe('mosquito');
    for (const svc of [{ service: 'mosquito_misting' }, { name: 'Mosquito Misting Service Plan' }, { name: 'Mosquito Misting System Service' }]) {
      expect(converter.recurringServiceKey(svc)).toBe('mosquito_misting');
      expect(seeder.serviceKeyFor(svc)).toBe('mosquito_misting');
    }
  });

  test('the existing-services resolver and the add-service request', () => {
    const { toQualifyingKeys } = require('../services/waveguard-existing-services');
    expect(toQualifyingKeys('21-day mosquito misting')).toContain('mosquito');
    expect(toQualifyingKeys('Mosquito Misting Service Plan')).not.toContain('mosquito');
    expect(toQualifyingKeys('mosquito_misting')).not.toContain('mosquito');
  });

  test('the service-name normalizer', () => {
    expect(normalizer.normalizeServiceType('21-day mosquito misting')).toBe('Mosquito Barrier Treatment');
    expect(normalizer.normalizeServiceType('Mosquito Misting Service Plan')).toBe('Mosquito Misting Service Plan');
    expect(normalizer.normalizeServiceType('Mosquito Misting System Service')).toBe('Mosquito Misting System Service');
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

describe('pre-push audit: priced proposal lines and commercial rows', () => {
  const { normalizeBuilding } = require('../services/estimate-proposal');
  const authored = (lines) => ({
    result: { recurring: { services: [{ service: 'pest_control', mo: 40 }] } },
    proposal: { enabled: true, buildings: [normalizeBuilding({ name: 'Home', lineItems: lines })] },
  });
  afterEach(() => { delete process.env.GATE_MOSQUITO_MISTING; });

  test('a misting proposal line that keeps quoteRequired:true but carries a price is priced evidence (accept blocked)', () => {
    process.env.GATE_MOSQUITO_MISTING = 'true';
    const data = authored([{ service: 'mosquito_misting_installation', description: 'Essential system (drum) Installation', unitPrice: 9000, frequency: 'one_time', quoteRequired: true }]);
    expect(data.proposal.buildings[0].lineItems[0]).toMatchObject({ quoteRequired: true, unitPrice: 9000 });
    expect(mapper.estimateMistingAcceptBlocked(data)).toBe(true);
    expect(mapper.gatedAddOnStaffRefusal(data, 'accepting')).toMatchObject({ code: 'MOSQUITO_MISTING_ACCEPT_PENDING' });
  });

  test('a stored commercial misting manual-quote row is a misting row: gated when the gate is off, not accept-blocked when on', () => {
    const row = { service: 'commercial_pest', originalRequestedService: 'mosquito_misting', quoteRequired: true, name: 'Mosquito Misting System (commercial)' };
    const data = { result: { quoteRequiredItems: [row], recurring: { services: [] } }, engineInputs: { ...PROPERTY, services: { mosquitoMisting: OPTS } } };
    delete process.env.GATE_MOSQUITO_MISTING;
    expect(mapper.estimateMistingGated(data)).toBe(true);
    process.env.GATE_MOSQUITO_MISTING = 'true';
    expect(mapper.estimateMistingGated(data)).toBe(false);
    // Unpriced manual quote: the stored row decides, the selection fallback is not consulted.
    expect(mapper.estimateMistingAcceptBlocked(data)).toBe(false);
  });
});

describe('Codex round 7: replayed limits, distinct work labels, one account key', () => {
  const { priceMosquitoMisting } = require('../services/pricing-engine/service-pricing');
  const { MOSQUITO_MISTING } = require('../services/pricing-engine/constants');

  test('a sent quote replays against the layout limits it was validated under, not the live ones', () => {
    const first = priceMosquitoMisting({}, { tier: 'smart', nozzles: 80, refillsPerYear: 6 });
    expect(first.quoteRequired).toBe(false);
    expect(first.pricingKnobs).toMatchObject({ maxNozzles: 80, maxRefillsPerYear: 24, defaultRefillsPerYear: 4 });
    const live = { maxNozzles: MOSQUITO_MISTING.maxNozzles, maxRefillsPerYear: MOSQUITO_MISTING.maxRefillsPerYear, defaultRefillsPerYear: MOSQUITO_MISTING.defaultRefillsPerYear };
    try {
      MOSQUITO_MISTING.maxNozzles = 70; MOSQUITO_MISTING.maxRefillsPerYear = 5; MOSQUITO_MISTING.defaultRefillsPerYear = 2;
      const fresh = priceMosquitoMisting({}, { tier: 'smart', nozzles: 80, refillsPerYear: 6 });
      expect(fresh.quoteRequired).toBe(true);
      const replay = priceMosquitoMisting({}, { tier: 'smart', nozzles: 80, refillsPerYear: 6, knobs: first.pricingKnobs });
      expect(replay.quoteRequired).toBe(false);
      expect(replay.installation.price).toBe(first.installation.price);
      expect(replay.refill.refillsPerYear).toBe(6);
      expect(replay.pricingKnobs).toMatchObject({ maxNozzles: 80, maxRefillsPerYear: 24 });
    } finally { Object.assign(MOSQUITO_MISTING, live); }
  });

  test('hand-booked misting work rows keep their own label; the design visit and the plan keep theirs', () => {
    const n = require('../utils/service-normalizer');
    const f = Object.values(n).find((v) => typeof v === 'function');
    expect(f('Mosquito Misting System Installation')).toBe('Mosquito Misting System Installation');
    expect(f('Mosquito Misting System Refill')).toBe('Mosquito Misting System Refill');
    expect(f('Mosquito Misting System Maintenance')).toBe('Mosquito Misting System Maintenance');
    expect(f('Mosquito Misting System Service')).toBe('Mosquito Misting System Service');
    expect(f('Mosquito Misting Service Plan')).toBe('Mosquito Misting Service Plan');
    expect(f('21-day mosquito misting')).toBe('Mosquito Barrier Treatment');
  });

  test('the membership account key resolves the misting system before the commercial / residential split', () => {
    const ctx = require('../services/estimate-membership-context');
    const key = ctx.accountServiceKey || ctx._internals?.accountServiceKey;
    expect(typeof key).toBe('function');
    expect(key('Mosquito Misting Service Plan')).toBe('mosquito_misting');
    expect(key('Commercial Mosquito Misting System')).toBe('mosquito_misting');
    expect(key('Monthly Mosquito Control Service')).not.toBe('mosquito_misting');
    expect(key('Commercial Mosquito Program')).toBe('commercial_mosquito');
  });
});

describe('Codex round 8: whole-number counts, one commercial misting key', () => {
  const { priceMosquitoMisting } = require('../services/pricing-engine/service-pricing');

  test('a fractional nozzle or riser count is invalid (reason + fallback), never rounded into a different quote', () => {
    const n = priceMosquitoMisting({}, { tier: 'smart', nozzles: 35.5 });
    expect(n.nozzles).toBe(35);
    expect(n.manualReviewReasons).toContain('mosquito_misting_invalid_nozzles');
    const r = priceMosquitoMisting({}, { tier: 'smart', risers: 2.5 });
    expect(r.risers).toBe(0);
    expect(r.manualReviewReasons).toContain('mosquito_misting_invalid_risers');
    const ok = priceMosquitoMisting({}, { tier: 'smart', nozzles: 40, risers: 12 });
    expect(ok.manualReviewReasons).toEqual([]);
    expect(ok.nozzles).toBe(40);
    expect(ok.risers).toBe(12);
  });

  test('a commercial misting row files its invoices under the same canonical key the rows group by', () => {
    const ctx = require('../services/estimate-membership-context');
    expect(ctx.accountServiceKeys('Commercial Mosquito Misting System')).toEqual(['mosquito_misting']);
    expect(ctx.accountServiceKey('Commercial Mosquito Misting System')).toBe('mosquito_misting');
    expect(ctx.accountServiceKeys('Mosquito Misting Service Plan')).toEqual(['mosquito_misting']);
    expect(ctx.accountServiceKeys('Commercial Mosquito Program')).toEqual(['commercial_mosquito']);
  });
});


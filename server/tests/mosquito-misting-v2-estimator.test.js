/**
 * Misting on the staff estimator (misting PR 2b). The admin V2 calculate call is
 * { profile, selectedServices: ["MOSQUITO_MISTING"], options: { mosquitoMisting } }, and
 * translateV2CallToV1Input turns it into the engine's `services.mosquitoMisting`:
 *  - gate on: the typed layout reaches the engine unrounded, a blank field takes the engine default;
 *  - gate off: a fail-closed 400 (never a silent drop into a different quote);
 *  - a V2-saved misting estimate replays to the same figures after a price edit, because the knobs are
 *    read from the stored rows on the server and never from the posted options.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
const { generateEstimate } = require('../services/pricing-engine');
const mapper = require('../services/pricing-engine/v1-legacy-mapper');
const config = require('../services/pricing-engine/mosquito-misting-config');
const { mistingKnobSignalForReplay } = require('../services/estimate-tree-shrub-knob-replay');

const PROFILE = { homeSqFt: 2200, lotSqFt: 12000, stories: 1 };
const SELECTED = ['MOSQUITO_MISTING'];
const saved = process.env.GATE_MOSQUITO_MISTING;
beforeEach(() => { process.env.GATE_MOSQUITO_MISTING = 'true'; });
afterEach(() => {
  config.rebaseMosquitoMisting();
  if (saved === undefined) delete process.env.GATE_MOSQUITO_MISTING; else process.env.GATE_MOSQUITO_MISTING = saved;
});

const price = (options, selected = SELECTED) => mapper.mapV1ToLegacyShape(generateEstimate(translateV2CallToV1Input(PROFILE, selected, options)));
const plan = (mapped) => mapped.recurring.services.find((s) => s.service === 'mosquito_misting');
const install = (mapped) => mapped.oneTime.items.find((i) => i.service === 'mosquito_misting_installation');

describe('translateV2CallToV1Input: the misting selection', () => {
  test('gate on: the typed layout prices as the engine prices it, with the tier label on the install', () => {
    const mapped = price({ mosquitoMisting: { tier: 'essential', nozzles: '40', risers: '12', solution: 'natural', refillsPerYear: '6' } });
    expect(plan(mapped)).toMatchObject({ mo: 59, annual: 708, quoteRequired: false, manualReviewReasons: [] });
    expect(install(mapped).name).toBe('Compact system (10-gallon) Installation');
    expect(plan(mapped).detail).toContain('40 nozzles');
    expect(plan(mapped).detail).toContain('per refill application');
  });

  test('a blank field takes the engine default; a bare selection prices the default system', () => {
    const blank = price({ mosquitoMisting: { tier: '', nozzles: null, risers: undefined } });
    const bare = price({});
    expect(plan(blank)).toMatchObject({ mo: 59, quoteRequired: false });
    expect(install(bare).price).toBe(install(blank).price);
    expect(install(bare).name).toBe('Standard system (55-gallon) Installation');
  });

  test('what the rep typed is never rounded: a fractional count is a reason, not another quote', () => {
    const v1 = translateV2CallToV1Input(PROFILE, SELECTED, { mosquitoMisting: { nozzles: '12.5', risers: '2.5' } });
    expect(v1.services.mosquitoMisting).toEqual({ nozzles: '12.5', risers: '2.5' });
    const row = plan(mapper.mapV1ToLegacyShape(generateEstimate(v1)));
    expect(row.manualReviewReasons).toEqual(expect.arrayContaining(['mosquito_misting_invalid_nozzles', 'mosquito_misting_invalid_risers']));
  });

  test('an oversize layout is a manual quote row with no price', () => {
    const mapped = price({ mosquitoMisting: { nozzles: '90' } });
    expect(plan(mapped)).toMatchObject({ quoteRequired: true, annual: null, manualReviewReasons: ['mosquito_misting_oversize'] });
    expect(install(mapped)).toBeUndefined();
  });

  test('a commercial property takes the manual quote, with no special input', () => {
    const v1 = translateV2CallToV1Input({ ...PROFILE, propertyType: 'commercial', isCommercial: true }, SELECTED, { mosquitoMisting: { nozzles: '20' } });
    const mapped = mapper.mapV1ToLegacyShape(generateEstimate(v1));
    expect(plan(mapped)).toBeUndefined();
    expect(mapped.oneTime.specItems).toEqual([expect.objectContaining({
      name: 'Mosquito Misting System (commercial)', quoteRequired: true, originalRequestedService: 'mosquito_misting', price: null,
    })]);
  });

  test('gate off: a fail-closed 400, never a silent drop', () => {
    process.env.GATE_MOSQUITO_MISTING = 'false';
    let error;
    try { translateV2CallToV1Input(PROFILE, SELECTED, { mosquitoMisting: { nozzles: '20' } }); } catch (e) { error = e; }
    expect(error).toMatchObject({ statusCode: 400, failClosed: true, code: 'MOSQUITO_MISTING_GATED' });
  });

  test('a malformed envelope is refused; an unselected service ignores the option', () => {
    for (const bad of ['yes', 7, ['smart']]) {
      expect(() => translateV2CallToV1Input(PROFILE, SELECTED, { mosquitoMisting: bad })).toThrow(/mosquitoMisting must be an object/);
    }
    const v1 = translateV2CallToV1Input(PROFILE, ['MOSQUITO'], { mosquitoMisting: { nozzles: '20' } });
    expect(v1.services.mosquitoMisting).toBeUndefined();
  });

  test('only the five layout keys pass: a posted knob stamp inside the option never reaches the engine', () => {
    const v1 = translateV2CallToV1Input(PROFILE, SELECTED, {
      mosquitoMisting: { nozzles: '20', mistingPricingKnobs: { planMonthly: 1 }, knobs: { planMonthly: 1 } },
      mistingPricingKnobs: { planMonthly: 1 },
    });
    expect(v1.services.mosquitoMisting).toEqual({ nozzles: '20' });
    expect(v1.mistingPricingKnobs).toBeUndefined();
  });
});

describe('a V2-saved misting estimate replays to the same figures', () => {
  test('after a price edit the stored stamp keeps the sent figures; a fresh V2 call gets the new ones', () => {
    const request = { profile: PROFILE, selectedServices: SELECTED, options: { mosquitoMisting: { tier: 'smart', nozzles: '40', risers: '12' } } };
    const first = price(request.options);
    const stored = { result: first, engineRequest: request };
    const figures = (m) => ({ perApp: plan(m).mo, annual: plan(m).annual, install: install(m).price });

    const data = JSON.parse(JSON.stringify(config.defaultMosquitoMistingPricingData()));
    data.plan.monthly = 80;
    data.tiers.smart.price = 5000;
    config.applyMosquitoMistingPricingConfig(data);
    expect(figures(price(request.options))).not.toEqual(figures(first));

    // The save-replay path: translate the stored engineRequest, then add the stamp read back from the stored rows.
    const v1 = translateV2CallToV1Input(request.profile, request.selectedServices, request.options);
    const stamp = mistingKnobSignalForReplay(stored);
    expect(stamp).toMatchObject({ planMonthly: 59 });
    v1.mistingPricingKnobs = stamp;
    const replayed = mapper.mapV1ToLegacyShape(generateEstimate(v1));
    expect(figures(replayed)).toEqual(figures(first));
    expect(plan(replayed).pricingKnobs).toEqual(plan(first).pricingKnobs);
  });
});

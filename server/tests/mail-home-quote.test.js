/**
 * The home quote (services/mail/home-quote.js) with the engine input builder and the dry run of the estimate save
 * injected: no network, no database. The body the save is asked for, the engine input, the verdict (judge) with each
 * not-clean reason, a clean price, a refused save, an engine failure. The real engine input and the real dry run are in
 * mail-home-quote-engine.test.js. Made-up rows and amounts.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { priceHome, judge, estimateBody } = require('../services/mail/home-quote');
const { SQFT_SOURCES } = require('../services/estimator-engine/source-arbitration');
const { agentEngineResultDigest } = require('../services/agent-estimate-preview');

const row = { id: 'row-1', address_line1: '101 EXAMPLE TRL', city: 'SAMPLETON', state: 'FL', zip: '34212' };
const ADDRESS = '101 EXAMPLE TRL, SAMPLETON FL 34212';
const facts = { homeSqft: 1800, homeSqftSource: 'parcel_map', stories: 1, lotSqft: 8000 };
const line = { service: 'pest_control', pricingConfidence: 'HIGH' };

const prepared = (extra = {}) => ({
  estimate: {
    pricing_authority: 'SERVER',
    annual_total: '512.34',
    estimate_data: JSON.stringify({
      engineResult: { lineItems: [line] },
      result: { oneTime: { membershipFee: 37.5 } },
    }),
    ...extra,
  },
});
const withLines = (lineItems, membershipFee = 0) => prepared({ estimate_data: JSON.stringify({ engineResult: { lineItems }, result: { oneTime: { membershipFee } } }) });

function setup(over = {}) {
  const deps = {
    buildEngineInput: jest.fn((input) => ({ built: input })),
    dryRunEstimate: jest.fn(async () => prepared()),
    ...over,
  };
  return { deps, price: (f = facts) => priceHome(row, f, deps) };
}

describe('what the save is asked for', () => {
  test('a quarterly pest plan on a single-family home with the facts, county-assessed size for a map size', async () => {
    const t = setup();
    await t.price();
    expect(t.deps.buildEngineInput).toHaveBeenCalledTimes(1);
    expect(t.deps.buildEngineInput.mock.calls[0][0]).toEqual({
      intent: { services: { pest: { frequency: 'quarterly', roachType: 'none' } }, is_commercial: false, category: 'RESIDENTIAL' },
      propertyFacts: {
        home: { value: 1800, source: SQFT_SOURCES.COUNTY_ASSESSED, confidence: 'medium' },
        lot: { value: 8000, source: SQFT_SOURCES.COUNTY_ASSESSED },
        stories: 1,
        propertyType: 'single_family',
      },
      context: {},
      lookupEnriched: null,
    });
  });

  test('a permit plan size is given the permit-plan source', async () => {
    const t = setup();
    await t.price({ ...facts, homeSqft: 2100, homeSqftSource: 'permit_plan', stories: 1.5 });
    const { propertyFacts } = t.deps.buildEngineInput.mock.calls[0][0];
    expect(propertyFacts.home).toEqual({ value: 2100, source: SQFT_SOURCES.PERMIT_PLAN, confidence: 'medium' });
    expect(propertyFacts.stories).toBe(1.5);
  });

  test('the body carries the home\'s own address and the form inputs, and no customer, phone or email', async () => {
    const t = setup();
    await t.price();
    const [body] = t.deps.dryRunEstimate.mock.calls[0];
    expect(body).toEqual({
      address: ADDRESS,
      showOneTimeOption: false,
      billByInvoice: false,
      estimateData: {
        engineInputs: { built: t.deps.buildEngineInput.mock.calls[0][0] },
        inputs: { address: ADDRESS, propertyType: 'Single Family', homeSqFt: '1800', lotSqFt: '8000', stories: '1', svcPest: true, pestFreq: '4' },
      },
    });
    for (const key of ['customerName', 'customerPhone', 'customerEmail', 'customerId', 'moveId', 'leadId']) expect(body).not.toHaveProperty(key);
  });

  test('the address leaves out a part the row lacks', () => {
    expect(estimateBody({ address_line1: '101 EXAMPLE TRL', city: 'SAMPLETON' }, facts, {}).address).toBe('101 EXAMPLE TRL, SAMPLETON');
    expect(estimateBody({ address_line1: '101 EXAMPLE TRL' }, facts, {}).address).toBe('101 EXAMPLE TRL');
  });
});

describe('the result', () => {
  test('a clean price: the facts, the annual total, the setup fee and the engine digest of the result', async () => {
    const t = setup({ dryRunEstimate: jest.fn(async () => withLines([{ ...line, pricingConfidence: 'medium' }], 37.5)) });
    const out = await t.price();
    expect(out).toEqual({ status: 'priced', ...facts, priceAnnual: 512.34, priceSetupFee: 37.5, priceDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(out.priceDigest).toBe(agentEngineResultDigest({ lineItems: [{ ...line, pricingConfidence: 'medium' }] }));
  });

  test('the setup fee is 0 when the result has none, or a fee that is not a positive number', async () => {
    for (const fee of [0, null, undefined, -5, 'n/a']) {
      const t = setup({ dryRunEstimate: jest.fn(async () => withLines([line], fee)) });
      expect((await t.price()).priceSetupFee).toBe(0);
    }
  });

  test('the estimate data may come back as an object', async () => {
    const estimate = prepared().estimate;
    const t = setup({ dryRunEstimate: jest.fn(async () => ({ estimate: { ...estimate, estimate_data: JSON.parse(estimate.estimate_data) } })) });
    expect((await t.price()).status).toBe('priced');
  });

  test('a not-clean answer keeps the facts the price used and stores no price', async () => {
    const t = setup({ dryRunEstimate: jest.fn(async () => withLines([line, line])) });
    expect(await t.price()).toEqual({ status: 'not_clean', reason: 'not_one_line', ...facts });
  });
});

describe('the verdict (judge)', () => {
  test.each([
    ['not a server price', { estimate: { ...prepared().estimate, pricing_authority: 'CLIENT_FALLBACK' } }, 'not_server_price'],
    ['no estimate', { estimate: null }, 'not_server_price'],
    ['no engine line', withLines([]), 'not_one_line'],
    ['two engine lines', withLines([line, { service: 'lawn_care' }]), 'not_one_line'],
    ['a line that is not the pest line', withLines([{ service: 'lawn_care' }]), 'not_one_line'],
    ['no engine result', prepared({ estimate_data: '{}' }), 'not_one_line'],
    ['estimate data that is not JSON', prepared({ estimate_data: 'not json' }), 'not_one_line'],
    ['a line that needs a quote', withLines([{ ...line, quoteRequired: true }]), 'engine_review'],
    ['a line that requires a quote', withLines([{ ...line, requiresQuote: true }]), 'engine_review'],
    ['a line that needs manual review', withLines([{ ...line, requiresManualReview: true }]), 'engine_review'],
    ['a review reason', withLines([{ ...line, manualReviewReasons: ['lot size missing'] }]), 'engine_review'],
    ['a low confidence line', withLines([{ ...line, pricingConfidence: 'low' }]), 'engine_review'],
    ['a heuristic turf grade', withLines([{ ...line, turfConfidence: 'low' }]), 'engine_review'],
    ['an amount of 0', prepared({ annual_total: 0 }), 'no_amount'],
    ['an amount that is not a number', prepared({ annual_total: 'n/a' }), 'no_amount'],
    ['no amount at all', prepared({ annual_total: null }), 'no_amount'],
    ['an amount the column cannot hold', prepared({ annual_total: 5e8 }), 'no_amount'],
  ])('%s', (_name, estimate, reason) => {
    expect(judge(estimate)).toEqual({ reason });
  });

  test('a clean estimate gives its price', () => {
    expect(judge(prepared())).toEqual({ price: { annual: 512.34, setupFee: 37.5, digest: expect.any(String) } });
  });

  test('each reason reaches the result as not_clean', async () => {
    const answers = { not_server_price: { estimate: null }, engine_review: withLines([{ ...line, quoteRequired: true }]), no_amount: prepared({ annual_total: 0 }) };
    for (const [reason, answer] of Object.entries(answers)) {
      const t = setup({ dryRunEstimate: jest.fn(async () => answer) });
      expect(await t.price()).toEqual({ status: 'not_clean', reason, ...facts });
    }
  });
});

describe('failures', () => {
  test('a refusal of the save under 500 is not_clean / save_refused', async () => {
    for (const err of [Object.assign(new Error('refused'), { statusCode: 400 }), Object.assign(new Error('no'), { status: 422 })]) {
      const t = setup({ dryRunEstimate: jest.fn(async () => { throw err; }) });
      expect(await t.price()).toEqual({ status: 'not_clean', reason: 'save_refused', ...facts });
    }
  });

  test('a server error, or an error with no status, is failed / engine, with the facts kept', async () => {
    for (const err of [Object.assign(new Error('live pricing unavailable'), { statusCode: 503 }), new Error('connection lost')]) {
      const t = setup({ dryRunEstimate: jest.fn(async () => { throw err; }) });
      expect(await t.price()).toEqual({ status: 'failed', reason: 'engine', ...facts });
    }
  });

  test('an engine input that cannot be built is failed / engine and the save is never asked', async () => {
    const t = setup({ buildEngineInput: jest.fn(() => { throw new Error('bad facts'); }) });
    expect(await t.price()).toEqual({ status: 'failed', reason: 'engine', ...facts });
    expect(t.deps.dryRunEstimate).not.toHaveBeenCalled();
  });

  test('no message of an error reaches the result', async () => {
    const t = setup({ dryRunEstimate: jest.fn(async () => { throw new Error('101 EXAMPLE TRL TESTER ALEX J'); }) });
    expect(JSON.stringify(await t.price())).not.toMatch(/EXAMPLE|TESTER/);
  });
});

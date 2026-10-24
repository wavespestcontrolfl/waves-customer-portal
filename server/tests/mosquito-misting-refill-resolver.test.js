/**
 * Misting PR 2c, item 1: ONE refill resolver (services/misting-refill.js).
 * The refill's per-application price is the solution price of the customer's ACCEPTED misting estimate for the property, read from the
 * LIVE pricing table at the time of the attach. Anything that cannot be established is a refusal, never the Standard placeholder.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const mapper = require('../services/pricing-engine/v1-legacy-mapper');
const config = require('../services/pricing-engine/mosquito-misting-config');
const { MOSQUITO_MISTING } = require('../services/pricing-engine/constants');
const refill = require('../services/misting-refill');
const pricingEngine = require('../services/pricing-engine');

const PROPERTY = { homeSqFt: 2200, stories: 1, lotSqFt: 12000, propertyType: 'single_family' };
const CUSTOMER = 'cust-1';
const HOUSE = 'prop-house';
const OTHER_HOUSE = 'prop-other';
const PLAN = 'mosquito_misting_service';

const saved = process.env.GATE_MOSQUITO_MISTING;
beforeEach(() => {
  process.env.GATE_MOSQUITO_MISTING = 'true';
  // The live table was synced a moment ago; the staleness cases below override these.
  jest.spyOn(pricingEngine, 'needsSync').mockReturnValue(false);
  jest.spyOn(pricingEngine, 'syncConstantsFromDB').mockResolvedValue(true);
});
afterEach(() => {
  jest.restoreAllMocks();
  config.rebaseMosquitoMisting();
  if (saved === undefined) delete process.env.GATE_MOSQUITO_MISTING; else process.env.GATE_MOSQUITO_MISTING = saved;
});

// A stored estimate_data the way an accepted misting estimate keeps it: the mapped result plus the engine inputs.
function mistingData(solution) {
  const input = { ...PROPERTY, services: { mosquitoMisting: { tier: 'smart', nozzles: 40, ...(solution ? { solution } : {}) } } };
  return { result: mapper.mapV1ToLegacyShape(generateEstimate(input)), engineInputs: input };
}
const pestData = () => {
  const input = { ...PROPERTY, services: { pest: { frequency: 'quarterly' } } };
  return { result: mapper.mapV1ToLegacyShape(generateEstimate(input)), engineInputs: input };
};
const estimate = (over = {}) => ({
  id: 'est-1', customer_id: CUSTOMER, property_id: HOUSE, status: 'accepted', accepted_at: '2026-10-01T12:00:00Z',
  pricing_authority: null, estimate_data: mistingData('natural'), ...over,
});

// A scripted connection for exactly the reads the resolver makes.
function fakeDb(tables, { failEstimates = false } = {}) {
  return (table) => {
    let rows = tables[table] || [];
    const sorts = [];
    let lim = Infinity;
    let off = 0;
    const sorted = () => [...rows].sort((a, b) => {
      for (const [col, dir] of sorts) {
        if (a[col] === b[col]) continue;
        return (a[col] > b[col] ? 1 : -1) * (dir === 'desc' ? -1 : 1);
      }
      return 0;
    });
    const q = {
      where(cond) { rows = rows.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
      orderBy(col, dir = 'asc') { sorts.push([col, dir]); return q; },
      limit(n) { lim = n; return q; },
      offset(n) { off = n; return q; },
      first: async () => { if (failEstimates && table === 'estimates') throw new Error('db down'); return sorted()[0]; },
      select: async () => { if (failEstimates && table === 'estimates') throw new Error('db down'); return sorted().slice(off, off + lim); },
    };
    return q;
  };
}
const db = (estimates, extra = {}) => fakeDb({
  estimates, customer_properties: [{ id: HOUSE, customer_id: CUSTOMER, active: true }], ...extra,
});
const attach = (database, over = {}) => refill.resolveRefillAttachment({
  customerId: CUSTOMER, propertyId: HOUSE, parentServiceKey: PLAN, ...over,
}, database);

describe('price: the sold solution at the live table price', () => {
  test.each([['standard', 129], ['natural', 219], ['premium', 319]])('%s refill is %i per application, never the catalog placeholder', async (solution, price) => {
    const out = await attach(db([estimate({ estimate_data: mistingData(solution) })]));
    expect(out).toMatchObject({ ok: true, solution, unitPrice: price, estimateId: 'est-1' });
    expect(out.lineName).toBe(`Mosquito Misting System Refill - ${MOSQUITO_MISTING.refills[solution].label}`);
  });

  test('the price follows the live pricing row, not the price the estimate was quoted at', async () => {
    const data = JSON.parse(JSON.stringify(config.defaultMosquitoMistingPricingData()));
    data.refills.natural.price = 240;
    config.applyMosquitoMistingPricingConfig(data);
    expect((await attach(db([estimate()]))).unitPrice).toBe(240);
  });

  test('an unknown or non-positive solution price is null, so the refill is unpriced', () => {
    expect(config.mistingRefillPriceFor('bleach')).toBeNull();
    expect(config.mistingRefillPriceFor(undefined)).toBeNull();
    expect(config.mistingRefillPriceFor('natural', { refills: { natural: { price: 0 } } })).toBeNull();
    expect(config.mistingRefillPriceFor('natural', { refills: { natural: { price: NaN } } })).toBeNull();
    expect(config.mistingRefillPriceFor(' Premium ')).toBe(319);
  });

  test('a solution with no live price refuses instead of reading Standard', async () => {
    const real = MOSQUITO_MISTING.refills.natural.price;
    MOSQUITO_MISTING.refills.natural.price = 0;
    try {
      expect(await attach(db([estimate()]))).toMatchObject({ ok: false, code: 'MISTING_REFILL_PRICE_UNAVAILABLE', status: 409 });
    } finally { MOSQUITO_MISTING.refills.natural.price = real; }
  });
});

describe('the live table is fresh when the price is read', () => {
  test('a refresh that is due runs first, then the price is read', async () => {
    pricingEngine.needsSync.mockReturnValue(true);
    pricingEngine.syncConstantsFromDB.mockImplementation(async () => {
      const data = JSON.parse(JSON.stringify(config.defaultMosquitoMistingPricingData()));
      data.refills.natural.price = 233;
      config.applyMosquitoMistingPricingConfig(data);
      return true;
    });
    expect(await attach(db([estimate()]))).toMatchObject({ ok: true, unitPrice: 233 });
    expect(pricingEngine.syncConstantsFromDB).toHaveBeenCalledTimes(1);
  });

  test('no refresh is due: no sync call', async () => {
    await attach(db([estimate()]));
    expect(pricingEngine.syncConstantsFromDB).not.toHaveBeenCalled();
  });

  test('a due refresh that fails (returns false or throws) refuses with a retryable 503; nothing is priced from stale or default prices', async () => {
    pricingEngine.needsSync.mockReturnValue(true);
    pricingEngine.syncConstantsFromDB.mockResolvedValue(false);
    expect(await attach(db([estimate()]))).toMatchObject({ ok: false, code: 'MISTING_REFILL_PRICING_STALE', status: 503 });
    pricingEngine.syncConstantsFromDB.mockRejectedValue(new Error('connection lost'));
    expect(await attach(db([estimate()]))).toMatchObject({ ok: false, code: 'MISTING_REFILL_PRICING_STALE', status: 503 });
  });

  test('the refresh is not asked for when there is nothing to price (no estimate)', async () => {
    pricingEngine.needsSync.mockReturnValue(true);
    expect(await attach(db([]))).toMatchObject({ ok: false, code: 'MISTING_REFILL_UNPRICED' });
    expect(pricingEngine.syncConstantsFromDB).not.toHaveBeenCalled();
  });

  test('a stale-pricing refusal on an existing line is not a keep-stored case: the edit retries instead of billing an old price', () => {
    expect(refill.KEEP_STORED_ON.has('MISTING_REFILL_PRICING_STALE')).toBe(false);
  });
});

describe('which estimate decides: accepted, this customer, this property', () => {
  test('no accepted misting estimate is a staff-readable refusal', async () => {
    const out = await attach(db([]));
    expect(out).toMatchObject({ ok: false, code: 'MISTING_REFILL_UNPRICED', status: 409 });
    expect(out.message).toMatch(/no accepted misting estimate/);
  });

  test.each([['draft'], ['sent'], ['viewed'], ['declined'], ['expired']])('a %s estimate never decides the price', async (status) => {
    expect(await attach(db([estimate({ status })]))).toMatchObject({ ok: false, code: 'MISTING_REFILL_UNPRICED' });
  });

  test('another property\'s estimate and another customer\'s estimate never decide it', async () => {
    expect(await attach(db([estimate({ property_id: OTHER_HOUSE })]))).toMatchObject({ ok: false, code: 'MISTING_REFILL_UNPRICED' });
    expect(await attach(db([estimate({ customer_id: 'cust-2' })]))).toMatchObject({ ok: false, code: 'MISTING_REFILL_UNPRICED' });
  });

  test('an accepted estimate with no misting plan (pest) does not price a refill', async () => {
    expect(await attach(db([estimate({ estimate_data: pestData() })]))).toMatchObject({ ok: false, code: 'MISTING_REFILL_UNPRICED' });
  });

  test('the visit\'s own source estimate wins when it is the accepted misting one; a pest source estimate falls through to the property\'s', async () => {
    const rows = [
      estimate({ id: 'est-new', accepted_at: '2026-10-20T00:00:00Z', estimate_data: mistingData('premium') }),
      estimate({ id: 'est-old', accepted_at: '2026-09-01T00:00:00Z', estimate_data: mistingData('standard') }),
      estimate({ id: 'est-pest', accepted_at: '2026-10-25T00:00:00Z', estimate_data: pestData() }),
    ];
    expect(await attach(db(rows), { sourceEstimateId: 'est-old' })).toMatchObject({ ok: true, estimateId: 'est-old', solution: 'standard' });
    expect(await attach(db(rows), { sourceEstimateId: 'est-pest' })).toMatchObject({ ok: true, estimateId: 'est-new', solution: 'premium' });
    expect(await attach(db(rows))).toMatchObject({ ok: true, estimateId: 'est-new', solution: 'premium' });
  });

  test('a source estimate that is not accepted does not decide, the property\'s accepted one does', async () => {
    const rows = [estimate({ id: 'est-draft', status: 'draft', estimate_data: mistingData('premium') }), estimate({ id: 'est-ok' })];
    expect(await attach(db(rows), { sourceEstimateId: 'est-draft' })).toMatchObject({ ok: true, estimateId: 'est-ok', solution: 'natural' });
  });

  test('with no property named, a customer with one active property uses it; an estimate with no property belongs only to that sole property', async () => {
    const legacy = estimate({ property_id: null });
    expect(await attach(db([legacy]), { propertyId: null })).toMatchObject({ ok: true, solution: 'natural' });
    const two = { customer_properties: [{ id: HOUSE, customer_id: CUSTOMER, active: true }, { id: OTHER_HOUSE, customer_id: CUSTOMER, active: true }] };
    expect(await attach(db([legacy], two), { propertyId: null })).toMatchObject({ ok: false, code: 'MISTING_REFILL_UNPRICED' });
    expect(await attach(db([legacy], two), { propertyId: HOUSE })).toMatchObject({ ok: false, code: 'MISTING_REFILL_UNPRICED' });
    expect(await attach(db([estimate()], two), { propertyId: HOUSE })).toMatchObject({ ok: true });
  });

  test('no customer is unpriced without a read', async () => {
    const reads = [];
    const database = (table) => { reads.push(table); return db([estimate()])(table); };
    expect(await attach(database, { customerId: undefined })).toMatchObject({ ok: false, code: 'MISTING_REFILL_UNPRICED' });
    expect(reads).toEqual([]);
  });

  test('a failed read refuses with a retryable 503 and prices nothing', async () => {
    expect(await attach(fakeDb({ estimates: [estimate()], customer_properties: [] }, { failEstimates: true })))
      .toMatchObject({ ok: false, code: 'MISTING_REFILL_LOOKUP_FAILED', status: 503 });
  });
});

describe('which solution: stamped rows first, then engine inputs, never a guess', () => {
  test('an inputs-only estimate that names no solution was priced at the engine default', async () => {
    const inputsOnly = { engineInputs: mistingData().engineInputs };
    expect(await attach(db([estimate({ estimate_data: inputsOnly })]))).toMatchObject({ ok: true, solution: MOSQUITO_MISTING.defaultSolution });
    const named = { engineInputs: { ...PROPERTY, services: { mosquitoMisting: { solution: 'premium' } } } };
    expect(await attach(db([estimate({ estimate_data: named })]))).toMatchObject({ ok: true, solution: 'premium' });
  });

  test('an inputs-only estimate that names an unknown solution is unreadable, not Standard', async () => {
    const odd = { engineInputs: { ...PROPERTY, services: { mosquitoMisting: { solution: 'bleach' } } } };
    expect(await attach(db([estimate({ estimate_data: odd })]))).toMatchObject({ ok: false, code: 'MISTING_REFILL_SOLUTION_UNREADABLE', estimateId: 'est-1' });
  });

  test('stored rows with no stamp and no inputs are unreadable', async () => {
    const data = mistingData('natural');
    for (const row of data.result.recurring.services) { delete row.pricingKnobs; delete row.solution; delete row.refill; }
    for (const row of data.result.oneTime.items) { delete row.pricingKnobs; delete row.solution; delete row.refill; }
    delete data.engineInputs;
    expect(await attach(db([estimate({ estimate_data: data })]))).toMatchObject({ ok: false, code: 'MISTING_REFILL_SOLUTION_UNREADABLE' });
  });

  test('estimate_data stored as JSON text reads the same', async () => {
    expect(await attach(db([estimate({ estimate_data: JSON.stringify(mistingData('premium')) })]))).toMatchObject({ ok: true, solution: 'premium' });
  });
});

describe('the house comes from the booking\'s linked estimate when none is named', () => {
  const two = { customer_properties: [{ id: HOUSE, customer_id: CUSTOMER, active: true }, { id: OTHER_HOUSE, customer_id: CUSTOMER, active: true }] };
  const other = (over = {}) => estimate({ id: 'est-other', property_id: OTHER_HOUSE, estimate_data: mistingData('premium'), ...over });

  test('a multi-property customer with no property chosen: the linked misting estimate\'s own house decides', async () => {
    const out = await attach(db([estimate(), other()], two), { propertyId: null, sourceEstimateId: 'est-other' });
    expect(out).toMatchObject({ ok: true, estimateId: 'est-other', solution: 'premium' });
  });

  test('a linked estimate that is not a misting one still names the house: the misting estimate of THAT house is found', async () => {
    const pest = estimate({ id: 'est-pest', property_id: OTHER_HOUSE, accepted_at: '2026-10-28T00:00:00Z', estimate_data: pestData() });
    const out = await attach(db([estimate(), other({ accepted_at: '2026-10-02T00:00:00Z' }), pest], two), { propertyId: null, sourceEstimateId: 'est-pest' });
    expect(out).toMatchObject({ ok: true, estimateId: 'est-other', solution: 'premium' });
  });

  test('an explicit property wins over the linked estimate\'s', async () => {
    const out = await attach(db([estimate(), other()], two), { propertyId: HOUSE, sourceEstimateId: 'est-other' });
    expect(out).toMatchObject({ ok: true, estimateId: 'est-1', solution: 'natural' });
  });

  test('another customer\'s estimate names no house for this customer: a multi-property customer stays unpriced', async () => {
    const foreign = other({ id: 'est-foreign', customer_id: 'cust-2' });
    expect(await attach(db([estimate(), other(), foreign], two), { propertyId: null, sourceEstimateId: 'est-foreign' }))
      .toMatchObject({ ok: false, code: 'MISTING_REFILL_UNPRICED' });
  });

  test('no property, no linked estimate, several properties: unpriced (staff choose the house)', async () => {
    expect(await attach(db([estimate(), other()], two), { propertyId: null })).toMatchObject({ ok: false, code: 'MISTING_REFILL_UNPRICED' });
  });
});

describe('history is filtered before it is limited', () => {
  test('forty-five newer unrelated accepted estimates do not hide the older misting one', async () => {
    const newer = Array.from({ length: 45 }, (_, i) => estimate({
      id: `est-pest-${i}`, accepted_at: `2026-10-${String(10 + (i % 15)).padStart(2, '0')}T12:00:00Z`, estimate_data: pestData(),
    }));
    const old = estimate({ id: 'est-old-misting', accepted_at: '2026-01-05T12:00:00Z', estimate_data: mistingData('premium') });
    expect(await attach(db([...newer, old]))).toMatchObject({ ok: true, estimateId: 'est-old-misting', solution: 'premium' });
  });

  test('another property\'s newer misting estimate does not hide this property\'s older one', async () => {
    const rows = [
      estimate({ id: 'est-elsewhere', property_id: OTHER_HOUSE, accepted_at: '2026-10-30T00:00:00Z', estimate_data: mistingData('premium') }),
      estimate({ id: 'est-here', accepted_at: '2026-02-01T00:00:00Z', estimate_data: mistingData('standard') }),
    ];
    expect(await attach(db(rows))).toMatchObject({ ok: true, estimateId: 'est-here', solution: 'standard' });
  });
});

describe('an authored proposal is the authority on what was sold', () => {
  const misting = (extra = {}) => ({ service: 'mosquito_misting', name: 'Mosquito Misting Service Plan', price: 708, ...extra });
  const proposal = (lines) => ({ enabled: true, buildings: [{ lineItems: lines }] });
  const authored = (lines, base = mistingData('natural')) => ({ ...base, proposal: proposal(lines) });

  test('a proposal that removed the misting plan carries none, whatever engine rows the estimate retains', async () => {
    const removed = authored([{ service: 'pest_control', name: 'Pest Control', price: 400 }]);
    expect(await attach(db([estimate({ estimate_data: removed })]))).toMatchObject({ ok: false, code: 'MISTING_REFILL_UNPRICED' });
  });

  test('a proposal that sells misting must state the solution on its own misting line', async () => {
    const stated = authored([misting({ pricingKnobs: { refillSolution: 'premium' } })]);
    expect(await attach(db([estimate({ estimate_data: stated })]))).toMatchObject({ ok: true, solution: 'premium', unitPrice: 319 });
    const viaRefill = authored([misting({ refill: { solution: 'standard' } })]);
    expect(await attach(db([estimate({ estimate_data: viaRefill })]))).toMatchObject({ ok: true, solution: 'standard' });
  });

  test('a proposal-only misting sale (no engine rows, no inputs, no stated solution) is unreadable, not unpriced and not Standard', async () => {
    const only = { proposal: proposal([misting()]) };
    expect(await attach(db([estimate({ estimate_data: only })]))).toMatchObject({ ok: false, code: 'MISTING_REFILL_SOLUTION_UNREADABLE', estimateId: 'est-1' });
  });

  test('a proposal that keeps misting but states no solution does not borrow the retained engine rows (fail closed)', async () => {
    expect(await attach(db([estimate({ estimate_data: authored([misting()]) })]))).toMatchObject({ ok: false, code: 'MISTING_REFILL_SOLUTION_UNREADABLE' });
  });

  test('the proposal\'s own statement wins over the retained rows', async () => {
    const out = await attach(db([estimate({ estimate_data: authored([misting({ solution: 'standard' })], mistingData('premium')) })]));
    expect(out).toMatchObject({ ok: true, solution: 'standard' });
  });

  test('a proposal that is not authoritative (enabled false) leaves the retained rows in charge', async () => {
    const off = { ...mistingData('premium'), proposal: { enabled: false, buildings: [{ lineItems: [{ service: 'pest_control' }] }] } };
    expect(await attach(db([estimate({ estimate_data: off })]))).toMatchObject({ ok: true, solution: 'premium' });
  });
});

describe('where a refill can go', () => {
  test('never on a series (its price would be multiplied across the prepaid term)', async () => {
    expect(await attach(db([estimate()]), { isRecurring: true })).toMatchObject({ ok: false, code: 'MISTING_REFILL_ON_SERIES', status: 400 });
  });

  test('only on a Mosquito Misting Service Plan visit', async () => {
    for (const parentServiceKey of ['pest_control', 'mosquito_misting_install', 'mosquito_misting_system', null]) {
      expect(await attach(db([estimate()]), { parentServiceKey })).toMatchObject({ ok: false, code: 'MISTING_REFILL_WRONG_PARENT', status: 400 });
    }
  });

  test('never as the visit itself', async () => {
    expect(await attach(db([estimate()]), { parentServiceKey: 'mosquito_misting_refill' })).toMatchObject({ ok: false, code: 'MISTING_REFILL_ADDON_ONLY' });
  });

  test('a refusal becomes an operational error with the status, the staff text and the stable code', () => {
    const err = refill.refusalError({ status: 409, message: 'text', code: 'MISTING_REFILL_UNPRICED' });
    expect(err).toMatchObject({ status: 409, statusCode: 409, code: 'MISTING_REFILL_UNPRICED', isOperational: true, message: 'text' });
  });
});

describe('the gate', () => {
  test('refillLive follows GATE_MOSQUITO_MISTING at call time and reads a partial gate mock as off', () => {
    expect(refill.refillLive()).toBe(true);
    process.env.GATE_MOSQUITO_MISTING = 'false';
    expect(refill.refillLive()).toBe(false);
    delete process.env.GATE_MOSQUITO_MISTING;
    expect(refill.refillLive()).toBe(false);
  });
});

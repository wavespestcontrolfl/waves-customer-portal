// The customer report's lawn protocol card lists a window's products. The December LESCO Black Out 0-0-24 row (a non-default swap row,
// GATE_LAWN_DEC_LARGE_PATCH_K) is listed only while the swap gate and its prerequisites are live AND this visit applied the product;
// every other state leaves it out (no database; synthetic rows).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
const mockSummary = jest.fn();
jest.mock('../services/lawn-protocol-operating-layer', () => ({
  getProtocolWindowContext: jest.fn(async () => ({ protocol: { grass_track: 'zoysia' }, window: {}, products: [], gates: {} })),
  summarizeProtocolContext: (...args) => mockSummary(...args),
}));
const { buildLawnProtocolReportContext } = require('../services/service-report/dynamic-context');
const { swapOnlyRule, DEC_K_PRODUCT, DEC_FROM } = require('../config/lawn-v13-trouble-product-swaps');

const GATES = ['GATE_LAWN_V13', 'GATE_LAWN_SPOT_RULES', 'GATE_LAWN_TREATMENT_GUIDE', 'GATE_LAWN_TROUBLE_AREAS', 'GATE_LAWN_SPOT_TARGET', 'GATE_LAWN_DEC_LARGE_PATCH_K'];
const saved = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
afterEach(() => { for (const name of GATES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });

const TEN = { id: 'r1', productId: 't22', productName: DEC_FROM, protocolProductName: DEC_FROM, defaultInPlan: true, gates: { targetN: '0.45 lb N/1000' } };
const BLACK_OUT = { id: 'r2', productId: 'bo', productName: DEC_K_PRODUCT, protocolProductName: DEC_K_PRODUCT, defaultInPlan: false, gates: { targetK: '0.99 lb K2O/1000', trigger: 'active_large_patch_mapped' } };
const RECORD = { id: 'rec-1', customer_id: 'cust-1', service_date: '2026-12-10', scheduled_service_id: 'ss-1' };

// A knex stand-in: a completion for the record (so the card is the completed visit's) and the visit's service_products rows.
function makeKnex({ applied = [], failing = false } = {}) {
  const knex = (table) => {
    const rows = table === 'service_products' ? applied : (table === 'lawn_protocol_service_completions as lpsc' ? [{ id: 'c1', lawn_protocol_id: 'p1', window_key: 'dec_v13_spreader_feeding', metadata: {} }] : []);
    const q = {
      where: () => q, whereIn: () => q, leftJoin: () => q, select: () => q,
      first: () => Promise.resolve(rows[0] || null),
      catch: (onRejected) => (failing ? Promise.reject(new Error('db down')).catch(onRejected) : Promise.resolve(rows)),
      then: (resolve, reject) => (failing && table === 'service_products' ? Promise.reject(new Error('db down')).then(resolve, reject) : Promise.resolve(rows).then(resolve, reject)),
    };
    return q;
  };
  knex.schema = { hasTable: () => Promise.resolve(true) };
  return knex;
}
const run = async (knex) => (await buildLawnProtocolReportContext(RECORD, knex, new Date('2026-12-10T12:00:00Z'))).products.map((product) => product.productName);
beforeEach(() => { mockSummary.mockReturnValue({ version: '2026.10-v13', window: { month: 12 }, products: [TEN, BLACK_OUT] }); });

describe('swapOnlyRule', () => {
  test('finds the swap row by name or by its trigger, never a default row or another product', () => {
    expect(swapOnlyRule(BLACK_OUT)?.to).toBe(DEC_K_PRODUCT);
    expect(swapOnlyRule({ ...BLACK_OUT, productName: 'Renamed', protocolProductName: 'Renamed' })?.to).toBe(DEC_K_PRODUCT);
    expect(swapOnlyRule({ ...BLACK_OUT, defaultInPlan: true })).toBeNull();
    expect(swapOnlyRule(TEN)).toBeNull();
    expect(swapOnlyRule({ productName: 'Celsius WG', defaultInPlan: false, gates: { trigger: 'weeds' } })).toBeNull();
    expect(swapOnlyRule(null)).toBeNull();
  });
});

describe('the legacy lawn protocol card', () => {
  test('swap gate off: the Black Out row is not in the card, the 10-0-22 is', async () => {
    expect(await run(makeKnex({ applied: [{ product_id: 'bo' }] }))).toEqual([DEC_FROM]);
  });

  test.each(GATES.slice(1))('%s off (a gate the swap needs): the Black Out row is not in the card even if recorded', async (off) => {
    for (const name of GATES) process.env[name] = 'true';
    delete process.env[off];
    expect(await run(makeKnex({ applied: [{ product_id: 'bo' }] }))).toEqual([DEC_FROM]);
  });

  test('all gates on and the visit applied the Black Out: it appears, beside the window\'s other products', async () => {
    for (const name of GATES) process.env[name] = 'true';
    expect(await run(makeKnex({ applied: [{ product_id: 'bo' }] }))).toEqual([DEC_FROM, DEC_K_PRODUCT]);
  });

  test('all gates on but the visit did not apply it (a lawn with no large patch): it stays out', async () => {
    for (const name of GATES) process.env[name] = 'true';
    expect(await run(makeKnex({ applied: [] }))).toEqual([DEC_FROM]);
    expect(await run(makeKnex({ applied: [{ product_id: 'other' }] }))).toEqual([DEC_FROM]);
  });

  test('a failed read of the visit\'s products fails closed: the row stays out', async () => {
    for (const name of GATES) process.env[name] = 'true';
    expect(await run(makeKnex({ failing: true }))).toEqual([DEC_FROM]);
  });

  test('a window with no swap row is returned untouched (the same summary object content)', async () => {
    mockSummary.mockReturnValue({ version: '2026.10-v13', window: { month: 11 }, products: [TEN] });
    expect(await run(makeKnex())).toEqual([DEC_FROM]);
  });
});

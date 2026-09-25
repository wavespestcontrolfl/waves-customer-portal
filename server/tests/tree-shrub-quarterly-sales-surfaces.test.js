// Codex r6 on #4786: two more new-sale surfaces must not offer the retired
// 4x (Light / tree_shrub_quarterly) tree & shrub program.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { searchServiceLibrary } = require('../services/estimate-ai-context');
const { resolvePricingQuoteInput } = require('../routes/admin-pricing-config');

describe('estimate assistant service-library lookup', () => {
  test('excludes retired-for-sale catalog rows', async () => {
    const notIn = [];
    const query = {
      where(arg) { if (typeof arg === 'function') arg.call(this); return this; },
      orWhere() { return this; },
      orWhereNull() { return this; },
      orWhereRaw() { return this; },
      whereNotIn(column, values) { notIn.push([column, values]); return this; },
      select() { return this; },
      limit() { return Promise.resolve([]); },
    };
    await searchServiceLibrary(() => query, ['tree']);
    expect(notIn).toContainEqual(['service_key', expect.arrayContaining(['tree_shrub_quarterly'])]);
  });
});

describe('admin pricing calculators (/estimate, /quick-quote) input', () => {
  test.each(['light', 'LIGHT', 'premium', 'gold', ['standard'], 0])('rejects tier %p with a 400', async (tier) => {
    await expect(resolvePricingQuoteInput({ services: { treeShrub: { tier } } }))
      .rejects.toMatchObject({ statusCode: 400, isOperational: true });
  });

  test.each([undefined, null, '', 'standard', 'enhanced'])('accepts tier %p', async (tier) => {
    await expect(resolvePricingQuoteInput({ services: { treeShrub: { tier } } })).resolves.toBeTruthy();
  });
});

describe('knowledge index service connector (codex r8)', () => {
  test('does not index retired-for-sale catalog rows', async () => {
    const db = require('../models/db');
    const notIn = [];
    const builder = {
      where() { return this; },
      whereNotIn(column, values) { notIn.push([column, values]); return this; },
      select() { return Promise.resolve([]); },
    };
    db.mockImplementation(() => builder);
    const connectors = require('../services/knowledge-index/connectors');
    const loadServices = connectors.CONNECTORS.find((c) => c.source === 'service')?.load;
    expect(typeof loadServices).toBe('function');
    await loadServices();
    expect(notIn).toContainEqual(['service_key', expect.arrayContaining(['tree_shrub_quarterly'])]);
  });
});

describe('service library list — new-appointment picker (codex r11)', () => {
  const run = async (opts) => {
    const db = require('../models/db');
    const notIn = [];
    const builder = {
      select() { return this; },
      orderBy() { return this; },
      where() { return this; },
      whereNotIn(column, values) { notIn.push([column, values]); return this; },
      clone() { return this; },
      clearSelect() { return this; },
      clearOrder() { return this; },
      count() { return this; },
      first() { return Promise.resolve({ total: '0' }); },
      limit() { return this; },
      offset() { return Promise.resolve([]); },
    };
    db.mockImplementation(() => builder);
    const { getServices } = require('../services/service-library');
    await getServices(opts);
    return notIn;
  };

  test('sellable=true hides retired-for-sale rows', async () => {
    expect(await run({ isActive: 'true', sellable: 'true' }))
      .toContainEqual(['service_key', expect.arrayContaining(['tree_shrub_quarterly'])]);
  });

  test('the Service Library page (no sellable flag) still lists them', async () => {
    expect(await run({ isActive: 'true' })).toEqual([]);
  });
});

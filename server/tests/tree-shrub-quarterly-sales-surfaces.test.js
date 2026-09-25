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
    const calls = { notIn: [], exists: [] };
    const sub = {
      whereNull() { return this; },
      orWhereNotIn(column, values) { calls.notIn.push([column, values]); return this; },
      orWhereExists(fn) {
        const inner = {
          select() { return this; }, from(t) { calls.exists.push(t); return this; },
          join(t) { calls.exists.push(['join', t]); return this; },
          whereRaw(sql) { calls.exists.push(sql); return this; },
          where(col, val) { calls.exists.push([col, val]); return this; },
          whereNotIn(col, vals) { calls.exists.push([col, 'NOT IN', vals]); return this; },
        };
        fn.call(inner);
        return this;
      },
    };
    const builder = {
      select() { return this; },
      orderBy() { return this; },
      where(arg) { if (typeof arg === 'function') arg.call(sub); return this; },
      clone() { return this; },
      clearSelect() { return this; },
      clearOrder() { return this; },
      count() { return this; },
      first() { return Promise.resolve({ total: '0' }); },
      limit() { return this; },
      offset() { return Promise.resolve([]); },
    };
    db.mockImplementation(() => builder);
    db.raw = (sql) => sql;
    const { getServices } = require('../services/service-library');
    await getServices(opts);
    return calls;
  };
  const CUSTOMER = '5a3f2c1d-9b8e-4f6a-a1b2-c3d4e5f60789';

  test('sellable=true hides retired-for-sale rows', async () => {
    const calls = await run({ isActive: 'true', sellable: 'true' });
    expect(calls.notIn).toContainEqual(['service_key', expect.arrayContaining(['tree_shrub_quarterly'])]);
    expect(calls.exists).toEqual([]);
  });

  test('a customer with visits on the retired row still sees it (grandfathered catch-up)', async () => {
    const calls = await run({ isActive: 'true', sellable: 'true', sellableCustomerId: CUSTOMER });
    expect(calls.notIn).toContainEqual(['service_key', expect.arrayContaining(['tree_shrub_quarterly'])]);
    expect(calls.exists).toEqual(expect.arrayContaining([
      'scheduled_services', 'scheduled_services.service_id = services.id', ['scheduled_services.customer_id', CUSTOMER],
      // Live recurring visits only — completed/skipped history does not
      // grandfather (codex r13).
      ['scheduled_services.status', 'NOT IN', expect.arrayContaining(['completed', 'cancelled', 'skipped'])],
      ['scheduled_services.is_recurring', true],
      // ...or as an add-on line of a combined recurring visit (codex r14).
      'scheduled_service_addons', ['join', 'scheduled_services'], 'scheduled_service_addons.service_id = services.id',
    ]));
  });

  test('a non-uuid customer id is ignored', async () => {
    const calls = await run({ isActive: 'true', sellable: 'true', sellableCustomerId: "x' OR 1=1" });
    expect(calls.exists).toEqual([]);
  });

  test('the Service Library page (no sellable flag) still lists them', async () => {
    const calls = await run({ isActive: 'true' });
    expect(calls.notIn).toEqual([]);
  });
});

describe('new-appointment write boundary (codex r12)', () => {
  const RETIRED_ID = '11111111-2222-4333-8444-555555555555';
  const LIVE_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
  const CUSTOMER = '5a3f2c1d-9b8e-4f6a-a1b2-c3d4e5f60789';
  const OTHER = '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';

  // heldBy: customers with a LIVE recurring visit on the retired row, as the
  // visit's primary line (heldVia 'primary') or an add-on line ('addon').
  const run = async ({ customerId, serviceIds, serviceTypes, heldBy = [], heldVia = 'primary' }) => {
    const db = require('../models/db');
    const bare = (col) => col.replace(/^scheduled_services\.|^scheduled_service_addons\./, '');
    db.mockImplementation((table) => {
      const q = { table, filters: {} };
      const b = {
        join() { return this; },
        whereIn(col, vals) { q.filters[bare(col)] = vals; return this; },
        where(col, val) { q.filters[bare(col)] = [val]; return this; },
        whereNotIn(col, vals) { q.filters[`not:${bare(col)}`] = vals; return this; },
        distinct() { return this; },
        select() {
          const rows = [{ id: RETIRED_ID, service_key: 'tree_shrub_quarterly', name: 'Quarterly Tree & Shrub Care', short_name: 'Quarterly T&S' }]
            .filter((r) => q.filters.service_key.includes(r.service_key));
          return Promise.resolve(rows);
        },
        pluck() {
          const live = q.filters.is_recurring?.[0] === true && (q.filters['not:status'] || []).includes('completed');
          const via = table === 'scheduled_service_addons' ? 'addon' : 'primary';
          return Promise.resolve(live && via === heldVia && heldBy.includes(q.filters.customer_id[0]) ? [RETIRED_ID] : []);
        },
      };
      return b;
    });
    const { retiredServicesNotHeldBy } = require('../services/service-library');
    return retiredServicesNotHeldBy({ customerId, serviceIds, serviceTypes });
  };

  test('refuses the retired row for a customer not on the plan', async () => {
    const out = await run({ customerId: OTHER, serviceIds: [RETIRED_ID], heldBy: [CUSTOMER] });
    expect(out.map((r) => r.id)).toEqual([RETIRED_ID]);
  });

  test('allows it for the grandfathered customer', async () => {
    expect(await run({ customerId: CUSTOMER, serviceIds: [RETIRED_ID], heldBy: [CUSTOMER] })).toEqual([]);
  });

  test('a customer holding the plan as an add-on line is still grandfathered (codex r14)', async () => {
    expect(await run({ customerId: CUSTOMER, serviceIds: [RETIRED_ID], heldBy: [CUSTOMER], heldVia: 'addon' })).toEqual([]);
    expect((await run({ customerId: OTHER, serviceIds: [RETIRED_ID], heldBy: [CUSTOMER], heldVia: 'addon' })).map((r) => r.id)).toEqual([RETIRED_ID]);
  });

  test('live services and missing ids pass without a lookup', async () => {
    expect(await run({ customerId: OTHER, serviceIds: [LIVE_ID, null, undefined, 'not-a-uuid'] })).toEqual([]);
    const db = require('../models/db');
    db.mockClear();
    expect(await require('../services/service-library').retiredServicesNotHeldBy({ customerId: OTHER, serviceIds: [null] })).toEqual([]);
    expect(db).not.toHaveBeenCalled();
  });

  test('free-text bookings match the retired row by exact name, never by substring (codex r13)', async () => {
    const ids = async (serviceTypes) => (await run({ customerId: OTHER, serviceTypes })).map((r) => r.id);
    expect(await ids(['  quarterly tree & SHRUB care '])).toEqual([RETIRED_ID]);
    expect(await ids(['Quarterly T&S'])).toEqual([RETIRED_ID]);
    expect(await ids(['tree shrub quarterly'])).toEqual([RETIRED_ID]);
    expect(await ids(['Tree & Shrub Care', 'Quarterly Tree & Shrub Care visit'])).toEqual([]);
    expect(await run({ customerId: CUSTOMER, serviceTypes: ['Quarterly T&S'], heldBy: [CUSTOMER] })).toEqual([]);
  });

  test('sellable picker results flag the retired row', async () => {
    const db = require('../models/db');
    const builder = {
      select() { return this; }, orderBy() { return this; },
      where(arg) {
        if (typeof arg === 'function') arg.call({ whereNull() { return this; }, orWhereNotIn() { return this; }, orWhereExists() { return this; } });
        return this;
      },
      clone() { return this; }, clearSelect() { return this; }, clearOrder() { return this; }, count() { return this; },
      first() { return Promise.resolve({ total: '2' }); },
      limit() { return this; },
      offset() { return Promise.resolve([{ id: RETIRED_ID, service_key: 'tree_shrub_quarterly' }, { id: LIVE_ID, service_key: 'tree_shrub_6x' }]); },
    };
    db.mockImplementation(() => builder);
    const { getServices } = require('../services/service-library');
    const { services } = await getServices({ isActive: 'true', sellable: 'true', sellableCustomerId: CUSTOMER });
    expect(services.map((s) => s.retired_for_sale === true)).toEqual([true, false]);
  });
});

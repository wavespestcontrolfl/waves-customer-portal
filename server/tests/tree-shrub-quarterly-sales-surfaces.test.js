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

  // codex r17 P2: absent for the check above must be absent for the engine
  // too — normalizeTreeShrubTier trims '   ' to an empty key and throws.
  test('a whitespace-only tier reaches the engine as absent, so Standard prices (codex r17)', async () => {
    const body = { homeSqFt: 1800, lotSqFt: 8783, stories: 1, services: { treeShrub: { tier: '   ', access: 'easy', treeCount: 4 } } };
    const input = await resolvePricingQuoteInput(body);
    expect(input.services.treeShrub).not.toHaveProperty('tier');
    expect(input.services.treeShrub.access).toBe('easy');
    // The caller's body is left untouched.
    expect(body.services.treeShrub.tier).toBe('   ');
    const { generateEstimate } = require('../services/pricing-engine');
    expect(() => generateEstimate(input)).not.toThrow();
    const line = (generateEstimate(input).lineItems || []).find((l) => /tree/i.test(l.service || l.label || ''));
    expect(line?.tier).toBe('standard');
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
      // ...that is not its own one_time line — the write gate's predicate,
      // so the picker never offers what the save refuses (codex r18).
      require('../services/service-library').ADDON_LINE_IS_PLAN_SQL,
    ]));
  });

  test('the one add-on-line predicate excludes only one_time lines (codex r18)', () => {
    const { ADDON_LINE_IS_PLAN_SQL } = require('../services/service-library');
    expect(ADDON_LINE_IS_PLAN_SQL).toMatch(/scheduled_service_addons\.recurring_pattern IS NULL/);
    expect(ADDON_LINE_IS_PLAN_SQL).toMatch(/scheduled_service_addons\.recurring_pattern <> 'one_time'/);
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
  // addonPattern: the add-on line's own recurring_pattern (null = rides the
  // parent's cadence); the fake only counts an add-on line as held when the
  // query gated on it (codex r17).
  const run = async ({ customerId, serviceIds, serviceTypes, recurrence = null, heldBy = [], heldVia = 'primary', addonPattern = null }) => {
    const db = require('../models/db');
    const bare = (col) => col.replace(/^scheduled_services\.|^scheduled_service_addons\./, '');
    db.mockImplementation((table) => {
      const q = { table, filters: {} };
      const b = {
        join() { return this; },
        whereIn(col, vals) { q.filters[bare(col)] = vals; return this; },
        where(col, val) { q.filters[bare(col)] = [val]; return this; },
        whereRaw(sql) { q.filters[`raw:${sql}`] = true; return this; },
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
          const { ADDON_LINE_IS_PLAN_SQL } = require('../services/service-library');
          const lineIsPlan = via !== 'addon'
            || (q.filters[`raw:${ADDON_LINE_IS_PLAN_SQL}`] === true && addonPattern !== 'one_time');
          return Promise.resolve(live && lineIsPlan && via === heldVia && heldBy.includes(q.filters.customer_id[0]) ? [RETIRED_ID] : []);
        },
      };
      return b;
    });
    const { retiredServicesNotHeldBy } = require('../services/service-library');
    return retiredServicesNotHeldBy({ customerId, serviceIds, serviceTypes, recurrence });
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

  test('the retired tier\'s own name and four-application wording are recognized (codex r20)', async () => {
    const ids = async (serviceTypes) => (await run({ customerId: OTHER, serviceTypes })).map((r) => r.id);
    // The catalog row's real short name (20260718300000_tree_shrub_quarterly_catalog.js).
    expect(await ids(['Tree & Shrub (Light)'])).toEqual([RETIRED_ID]);
    expect(await ids(['tree & shrub care – light tier'])).toEqual([RETIRED_ID]);
    expect(await ids(['Tree & Shrub Care, four applications'])).toEqual([RETIRED_ID]);
    expect(await ids(['Tree & Shrub 4-visit program'])).toEqual([RETIRED_ID]);
    expect(await ids(['Tree & Shrub Care every 90 days'])).toEqual([RETIRED_ID]);
    expect(await ids(['Tree & Shrub Care every 60 days', 'Light Pest Control', 'Tree & Shrub Care (Standard)'])).toEqual([]);
    // "Ornamental" is the same family (serviceCatalogMatch) — codex r21.
    expect(await ids(['Quarterly Ornamental Care'])).toEqual([RETIRED_ID]);
    expect(await ids(['Ornamentals (Light)'])).toEqual([RETIRED_ID]);
    expect(await ids(['Ornamental Care', 'Bi-Monthly Ornamental Care'])).toEqual([]);
    expect((await run({ customerId: OTHER, serviceTypes: ['Ornamental Care'], recurrence: { pattern: 'quarterly' } })).map((r) => r.id)).toEqual([RETIRED_ID]);
  });

  test('a structured cadence names the retired plan just as the label would (codex r20)', async () => {
    const ids = async (serviceTypes, recurrence) => (await run({ customerId: OTHER, serviceTypes, recurrence })).map((r) => r.id);
    expect(await ids(['Tree & Shrub Care'], { pattern: 'quarterly' })).toEqual([RETIRED_ID]);
    expect(await ids(['Tree & Shrub Care'], { pattern: 'custom', intervalDays: 90 })).toEqual([RETIRED_ID]);
    expect(await ids(['Tree & Shrub Care'], { pattern: 'bimonthly' })).toEqual([]);
    expect(await ids(['Tree & Shrub Care'], { pattern: 'custom', intervalDays: 42 })).toEqual([]);
    expect(await ids(['Tree & Shrub Care'], null)).toEqual([]);
    // The cadence alone never names a retired row: it must pair with the service.
    expect(await ids(['Quarterly Pest Control'], { pattern: 'quarterly' })).toEqual([]);
    // The grandfathered customer still books their plan by cadence.
    expect(await run({ customerId: CUSTOMER, serviceTypes: ['Tree & Shrub Care'], recurrence: { pattern: 'quarterly' }, heldBy: [CUSTOMER] })).toEqual([]);
  });

  test('an add-on line\'s own cadence replaces the booking\'s for that label (codex r22)', async () => {
    const ids = async (serviceTypes, recurrence) => (await run({ customerId: OTHER, serviceTypes, recurrence })).map((r) => r.id);
    // Monthly lawn parent, live 6x T&S add-on posted with a quarterly pattern.
    expect(await ids(['Monthly Lawn Care', { label: 'Bi-Monthly Tree & Shrub Care', recurrence: { pattern: 'quarterly', intervalDays: null } }], { pattern: 'monthly' })).toEqual([RETIRED_ID]);
    // The same add-on riding the parent's monthly cadence, or on its own bimonthly one, is sellable.
    expect(await ids(['Monthly Lawn Care', { label: 'Bi-Monthly Tree & Shrub Care', recurrence: null }], { pattern: 'monthly' })).toEqual([]);
    expect(await ids([{ label: 'Tree & Shrub Care', recurrence: { pattern: 'bimonthly', intervalDays: null } }], { pattern: 'quarterly' })).toEqual([]);
    // A blank or malformed entry is ignored.
    expect(await ids([{ label: '', recurrence: { pattern: 'quarterly' } }, { label: null }, null], { pattern: 'quarterly' })).toEqual([]);
  });

  test('a one_time add-on line is not grandfathering evidence (codex r17)', async () => {
    expect((await run({ customerId: CUSTOMER, serviceIds: [RETIRED_ID], heldBy: [CUSTOMER], heldVia: 'addon', addonPattern: 'one_time' })).map((r) => r.id)).toEqual([RETIRED_ID]);
    // An add-on with its own recurring pattern, or none (rides the parent), still holds.
    expect(await run({ customerId: CUSTOMER, serviceIds: [RETIRED_ID], heldBy: [CUSTOMER], heldVia: 'addon', addonPattern: 'quarterly' })).toEqual([]);
    expect(await run({ customerId: CUSTOMER, serviceIds: [RETIRED_ID], heldBy: [CUSTOMER], heldVia: 'addon', addonPattern: null })).toEqual([]);
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
    expect(await ids(['Tree & Shrub Care', 'Bi-Monthly Tree & Shrub Care visit'])).toEqual([]);
    expect(await run({ customerId: CUSTOMER, serviceTypes: ['Quarterly T&S'], heldBy: [CUSTOMER] })).toEqual([]);
  });

  test('loose free-text variants of the retired plan are recognized (codex r16)', async () => {
    const ids = async (serviceTypes) => (await run({ customerId: OTHER, serviceTypes })).map((r) => r.id);
    expect(await ids(['Quarterly Tree & Shrub'])).toEqual([RETIRED_ID]);
    expect(await ids(['tree and shrub - quarterly'])).toEqual([RETIRED_ID]);
    expect(await ids(['T&S 4x'])).toEqual([RETIRED_ID]);
    expect(await ids(['Tree & Shrub Care  4x'])).toEqual([RETIRED_ID]);
    // Live cadences and other quarterly services are untouched.
    expect(await ids(['Bi-Monthly Tree & Shrub Care Service', 'Tree & Shrub 6x', 'Quarterly Pest Control', 'Tree & Shrub bimonthly '])).toEqual([]);
    expect(await run({ customerId: CUSTOMER, serviceTypes: ['Quarterly Tree & Shrub'], heldBy: [CUSTOMER] })).toEqual([]);
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

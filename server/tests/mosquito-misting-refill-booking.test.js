/**
 * Misting PR 2c, items 2-5: the staff paths that attach a refill all go through the ONE resolver (services/misting-refill.js).
 *  - a NEW booking (buildAppointmentPricing, behind POST / and POST /preview) and an Update Details save (normalizeUpdateDetailsAddons,
 *    behind the save and its preview) price the refill from the accepted misting estimate and ignore the posted catalog price;
 *  - a refill is one-time everywhere: an explicit 'one_time' row pattern, and the one-time-only key guard the series copies obey;
 *  - POST /preview carries the solution and per-application price (or the refusal) so staff see the amount before they book;
 *  - GATE_MOSQUITO_MISTING off: nothing changes (no read, no refusal, the posted price and name stand).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const mapper = require('../services/pricing-engine/v1-legacy-mapper');
const config = require('../services/pricing-engine/mosquito-misting-config');
const router = require('../routes/admin-schedule');
const pricingEngine = require('../services/pricing-engine');

const { normalizeUpdateDetailsAddons, lineDueOnRecurringDate, addonRecursAfterAnchor, filterAddonLinesForDate, isOneTimeOnlyAddonKey } = router._test;
const { buildAppointmentPricing } = router;

const PROPERTY = { homeSqFt: 2200, stories: 1, lotSqFt: 12000, propertyType: 'single_family' };
const CUSTOMER = { id: 'cust-1', waveguard_tier: null };
const HOUSE = 'prop-house';
const REFILL_ID = 'svc-refill';
const PLAN = { id: 'svc-plan', service_key: 'mosquito_misting_service', category: 'mosquito', base_price: 59, name: 'Mosquito Misting Service Plan' };
const REFILL = { id: REFILL_ID, service_key: 'mosquito_misting_refill', category: 'mosquito', base_price: 129, name: 'Mosquito Misting System Refill' };
const PEST = { id: 'svc-pest', service_key: 'pest_control', category: 'pest_control', base_price: 50, name: 'Pest Control' };

const saved = process.env.GATE_MOSQUITO_MISTING;
beforeEach(() => {
  process.env.GATE_MOSQUITO_MISTING = 'true';
  jest.spyOn(pricingEngine, 'needsSync').mockReturnValue(false);
});
afterEach(() => {
  jest.restoreAllMocks();
  config.rebaseMosquitoMisting();
  if (saved === undefined) delete process.env.GATE_MOSQUITO_MISTING; else process.env.GATE_MOSQUITO_MISTING = saved;
});

function mistingData(solution) {
  const input = { ...PROPERTY, services: { mosquitoMisting: { tier: 'smart', nozzles: 40, solution } } };
  return { result: mapper.mapV1ToLegacyShape(generateEstimate(input)), engineInputs: input };
}
const accepted = (solution = 'natural', over = {}) => ({
  id: 'est-1', customer_id: CUSTOMER.id, property_id: HOUSE, status: 'accepted', accepted_at: '2026-10-01T12:00:00Z',
  pricing_authority: null, estimate_data: mistingData(solution), ...over,
});

// A scripted connection over plain tables, with the reads these paths make; `reads` records which tables were touched.
function fakeDb(tables, reads = []) {
  const db = (table) => {
    reads.push(table);
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
      where(cond) { if (cond && typeof cond === 'object') rows = rows.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
      whereIn(col, values) { rows = rows.filter((r) => values.includes(r[col])); return q; },
      orderBy(col, dir = 'asc') { sorts.push([col, dir]); return q; },
      limit(n) { lim = n; return q; },
      offset(n) { off = n; return q; },
      forShare() { return q; },
      first: async () => sorted()[0],
      select: async () => sorted().slice(off, off + lim).map((r) => ({ ...r })),
      columnInfo: async () => Object.fromEntries((tables.__columns?.[table] || []).map((c) => [c, {}])),
    };
    return q;
  };
  return db;
}
const baseTables = (over = {}) => ({
  services: [PLAN, REFILL, PEST],
  estimates: [accepted()],
  customer_properties: [{ id: HOUSE, customer_id: CUSTOMER.id, active: true }],
  ...over,
});
const price = (overrides = {}, tables = baseTables(), reads = []) => buildAppointmentPricing({
  serviceRecord: PLAN, serviceType: PLAN.name, serviceId: PLAN.id, customer: CUSTOMER,
  serviceAddons: [{ serviceId: REFILL_ID, name: REFILL.name, basePrice: 129 }],
  refillContext: { propertyId: HOUSE, sourceEstimateId: null, isRecurring: false },
  conn: fakeDb(tables, reads),
  ...overrides,
});

describe('a new booking (buildAppointmentPricing, behind POST / and POST /preview)', () => {
  test('the refill takes the sold solution price, the posted catalog price is ignored, the line is named and one-time', async () => {
    const out = await price();
    expect(out.addonLines).toHaveLength(1);
    expect(out.addonLines[0]).toMatchObject({
      serviceKey: 'mosquito_misting_refill', base: 219, price: 219, recurringPattern: 'one_time',
      serviceName: 'Mosquito Misting System Refill - Natural (botanical)',
    });
    expect(out.finalPrice).toBe(59 + 219);
    expect(out.mistingRefills).toEqual([{ solution: 'natural', solutionLabel: 'Natural (botanical)', unitPrice: 219, estimateId: 'est-1' }]);
  });

  test('staff cannot type another price over it', async () => {
    for (const posted of [1, 0, 5000, null]) {
      const out = await price({ serviceAddons: [{ serviceId: REFILL_ID, name: REFILL.name, basePrice: posted }] });
      expect(out.addonLines[0].price).toBe(219);
    }
  });

  test('another add-on beside the refill is priced exactly as before', async () => {
    const out = await price({ serviceAddons: [{ serviceId: REFILL_ID, name: REFILL.name }, { serviceId: PEST.id, name: 'Pest Control', basePrice: 40, recurringPattern: 'quarterly' }] });
    expect(out.addonLines[1]).toMatchObject({ serviceKey: 'pest_control', price: 40, serviceName: 'Pest Control', recurringPattern: 'quarterly' });
    expect(out.finalPrice).toBe(59 + 219 + 40);
  });

  test('no accepted misting estimate refuses with the staff-readable reason (409) and prices nothing at the Standard placeholder', async () => {
    await expect(price({}, baseTables({ estimates: [] }))).rejects.toMatchObject({
      status: 409, code: 'MISTING_REFILL_UNPRICED', isOperational: true, message: expect.stringMatching(/no accepted misting estimate/),
    });
    await expect(price({}, baseTables({ estimates: [accepted('natural', { status: 'sent' })] }))).rejects.toMatchObject({ code: 'MISTING_REFILL_UNPRICED' });
  });

  test('a series booking refuses: the refill is billed on one visit, never multiplied across the prepaid term', async () => {
    await expect(price({ refillContext: { propertyId: HOUSE, isRecurring: true } })).rejects.toMatchObject({ status: 400, code: 'MISTING_REFILL_ON_SERIES' });
  });

  test('only a misting plan visit takes a refill, and the refill is never the visit itself', async () => {
    await expect(price({ serviceRecord: PEST, serviceType: 'Pest Control', serviceId: PEST.id })).rejects.toMatchObject({ code: 'MISTING_REFILL_WRONG_PARENT' });
    await expect(price({ serviceRecord: REFILL, serviceType: REFILL.name, serviceId: REFILL_ID, serviceAddons: [] }))
      .rejects.toMatchObject({ code: 'MISTING_REFILL_ADDON_ONLY' });
  });

  test('a multi-property customer with no house chosen: the booking\'s linked estimate names it (POST / and POST /preview)', async () => {
    const OTHER = 'prop-other';
    const tablesTwo = baseTables({
      estimates: [accepted('natural'), accepted('premium', { id: 'est-other', property_id: OTHER, accepted_at: '2026-10-05T00:00:00Z' })],
      customer_properties: [{ id: HOUSE, customer_id: CUSTOMER.id, active: true }, { id: OTHER, customer_id: CUSTOMER.id, active: true }],
    });
    const linked = await price({ refillContext: { propertyId: null, sourceEstimateId: 'est-other', isRecurring: false } }, tablesTwo);
    expect(linked.addonLines[0].price).toBe(319);
    // nothing names the house: the customer has two, so the refill is not priced for a guess
    await expect(price({ refillContext: { propertyId: null, sourceEstimateId: null, isRecurring: false } }, tablesTwo)).rejects.toMatchObject({ code: 'MISTING_REFILL_UNPRICED' });
  });

  test('IB and other callers with no refill context still go through the resolver (customer-scoped, sole property)', async () => {
    const out = await price({ refillContext: undefined });
    expect(out.addonLines[0].price).toBe(219);
  });

  test('gate off: byte-identical. The posted price and name stand, no pattern is added, nothing is read or refused', async () => {
    process.env.GATE_MOSQUITO_MISTING = 'false';
    const reads = [];
    const out = await price({}, baseTables({ estimates: [] }), reads);
    expect(out.addonLines[0]).toMatchObject({ base: 129, price: 129, serviceName: 'Mosquito Misting System Refill', recurringPattern: null });
    expect(out).not.toHaveProperty('mistingRefills');
    expect(reads).not.toContain('estimates');
    expect(reads).not.toContain('customer_properties');
    // a refill as the visit itself or on a series is not refused either
    await expect(price({ serviceRecord: REFILL, serviceId: REFILL_ID, serviceAddons: [], refillContext: { isRecurring: true } }, baseTables({ estimates: [] }))).resolves.toBeTruthy();
  });

  test('no refill add-on: no field is added to the result and no estimate is read, gate on', async () => {
    const reads = [];
    const out = await price({ serviceAddons: [{ serviceId: PEST.id, name: 'Pest Control', basePrice: 40 }] }, baseTables(), reads);
    expect(out).not.toHaveProperty('mistingRefills');
    expect(reads).not.toContain('estimates');
  });
});

describe('POST /preview (items 4): the amount staff see before they book', () => {
  const mockDb = require('../models/db');
  const layer = router.stack.find((l) => l.route && l.route.path === '/preview' && l.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const run = async (group, tables = baseTables()) => {
    const fake = fakeDb({ ...tables, customers: [CUSTOMER], discounts: [] });
    mockDb.mockImplementation(fake);
    const res = { body: undefined, status: jest.fn(function s() { return this; }), json: jest.fn(function j(b) { this.body = b; return this; }) };
    const next = jest.fn();
    await handler({ body: { groups: [group] }, headers: {} }, res, next);
    expect(next).not.toHaveBeenCalled();
    return res.body.results[0];
  };
  const group = (over = {}) => ({
    key: 'g1', customerId: CUSTOMER.id, scheduledDate: '2026-11-03', serviceType: PLAN.name, serviceId: PLAN.id,
    serviceAddons: [{ serviceId: REFILL_ID, name: REFILL.name, basePrice: 129 }], propertyId: HOUSE, ...over,
  });

  test('carries the solution and the per-application price, and the booking price includes it once', async () => {
    const row = await run(group());
    expect(row.error).toBeUndefined();
    expect(row.mistingRefills).toEqual([{ solution: 'natural', solutionLabel: 'Natural (botanical)', unitPrice: 219, estimateId: 'est-1' }]);
    expect(row.price).toBe(59 + 219);
    expect(row.addonLines).toEqual([{ price: 219, discount: null }]);
  });

  test('the prepay projection of a series is refused up front instead of multiplying the refill', async () => {
    const row = await run(group({ isRecurring: true, recurringCount: 12, collectPrepay: true }));
    expect(row).toMatchObject({ key: 'g1', code: 'MISTING_REFILL_ON_SERIES', error: expect.stringMatching(/billed on one visit/) });
    expect(row.prepay).toBeUndefined();
  });

  test('an unpriceable refill comes back as the group error with its code, which blocks Save in the modal', async () => {
    const row = await run(group(), baseTables({ estimates: [] }));
    expect(row).toMatchObject({ key: 'g1', code: 'MISTING_REFILL_UNPRICED', error: expect.stringMatching(/no accepted misting estimate/) });
  });

  test('with no property in the request the sole active property decides, as the booking does', async () => {
    const row = await run(group({ propertyId: undefined }));
    expect(row.mistingRefills[0].solution).toBe('natural');
  });

  test('gate off or no refill: the result has no refill field at all', async () => {
    const plain = await run(group({ serviceAddons: [] }));
    expect(plain).not.toHaveProperty('mistingRefills');
    process.env.GATE_MOSQUITO_MISTING = 'false';
    const off = await run(group(), baseTables({ estimates: [] }));
    expect(off).not.toHaveProperty('mistingRefills');
    expect(off.error).toBeUndefined();
    expect(off.price).toBe(59 + 129);
  });
});

describe('Update Details (item 5): the same resolver on a visit edit', () => {
  const VISIT = 'visit-1';
  const visitRow = (over = {}) => ({ id: VISIT, customer_id: CUSTOMER.id, property_id: HOUSE, source_estimate_id: null, service_id: PLAN.id, service_key_snapshot: PLAN.service_key, ...over });
  const tablesFor = (over = {}) => ({
    ...baseTables(),
    __columns: { scheduled_services: ['id', 'customer_id', 'property_id', 'source_estimate_id', 'service_id', 'service_key_snapshot'] },
    scheduled_services: [visitRow()],
    scheduled_service_addons: [],
    ...over,
  });
  const normalize = (addons, tables = tablesFor(), extra = {}) => normalizeUpdateDetailsAddons({
    db: fakeDb(tables), id: VISIT, addons, updates: {}, isRecurring: false, serviceType: PLAN.name, scheduledDate: '2026-11-03', ...extra,
  });
  const newLine = (over = {}) => ({ serviceId: REFILL_ID, name: REFILL.name, basePrice: 129, ...over });

  test('a new refill line is priced by the sold solution, named with it, one-time, whatever price was posted', async () => {
    for (const posted of [129, 1, null]) {
      const { normalizedAddons } = await normalize([newLine({ basePrice: posted })]);
      expect(normalizedAddons).toHaveLength(1);
      expect(normalizedAddons[0]).toMatchObject({
        serviceKey: 'mosquito_misting_refill', base: 219, price: 219, recurringPattern: 'one_time',
        serviceName: 'Mosquito Misting System Refill - Natural (botanical)',
      });
    }
  });

  test('the visit\'s own estimate, then the property\'s newest accepted one, decide the solution', async () => {
    const tables = tablesFor({
      estimates: [accepted('premium', { id: 'est-new', accepted_at: '2026-10-20T00:00:00Z' }), accepted('standard', { id: 'est-old', accepted_at: '2026-09-01T00:00:00Z' })],
      scheduled_services: [visitRow({ source_estimate_id: 'est-old' })],
    });
    expect((await normalize([newLine()], tables)).normalizedAddons[0].price).toBe(129);
    expect((await normalize([newLine()], tablesFor({ estimates: tables.estimates }))).normalizedAddons[0].price).toBe(319);
  });

  test('no accepted misting estimate refuses a new refill', async () => {
    await expect(normalize([newLine()], tablesFor({ estimates: [] }))).rejects.toMatchObject({ status: 409, code: 'MISTING_REFILL_UNPRICED' });
  });

  test('a refill the visit already has keeps its stored price and name when it cannot be priced now; it never blocks the edit', async () => {
    const stored = { id: 'row-1', scheduled_service_id: VISIT, service_id: REFILL_ID, service_name: 'Mosquito Misting System Refill - Premium (pyrethrins)', service_key_snapshot: 'mosquito_misting_refill', base_price: 319, estimated_price: 319 };
    const tables = tablesFor({ estimates: [], scheduled_service_addons: [stored] });
    const { normalizedAddons } = await normalize([newLine({ id: 'row-1', basePrice: 1, name: 'ignored' })], tables);
    expect(normalizedAddons[0]).toMatchObject({ base: 319, price: 319, serviceName: stored.service_name, recurringPattern: 'one_time' });
    // ...but a second NEW line is still refused
    await expect(normalize([newLine({ id: 'row-1' }), newLine()], tables)).rejects.toMatchObject({ code: 'MISTING_REFILL_UNPRICED' });
  });

  test('a refill that can be priced is re-priced from the live table on a later save', async () => {
    const stored = { id: 'row-1', scheduled_service_id: VISIT, service_id: REFILL_ID, service_name: 'Mosquito Misting System Refill - Natural (botanical)', service_key_snapshot: 'mosquito_misting_refill', base_price: 219, estimated_price: 219 };
    const data = JSON.parse(JSON.stringify(config.defaultMosquitoMistingPricingData()));
    data.refills.natural.price = 230;
    config.applyMosquitoMistingPricingConfig(data);
    const { normalizedAddons } = await normalize([newLine({ id: 'row-1', basePrice: 219 })], tablesFor({ scheduled_service_addons: [stored] }));
    expect(normalizedAddons[0].price).toBe(230);
  });

  test('only a misting plan visit takes it, judged on the service the save leaves the visit with', async () => {
    await expect(normalize([newLine()], tablesFor({ scheduled_services: [visitRow({ service_key_snapshot: 'pest_control' })] }))).rejects.toMatchObject({ code: 'MISTING_REFILL_WRONG_PARENT' });
    // a service change in the same save counts
    await expect(normalize([newLine()], tablesFor(), { updates: { service_key_snapshot: 'pest_control' } })).rejects.toMatchObject({ code: 'MISTING_REFILL_WRONG_PARENT' });
    const ok = await normalize([newLine()], tablesFor({ scheduled_services: [visitRow({ service_key_snapshot: null })] }));
    expect(ok.normalizedAddons[0].price).toBe(219);
  });

  test('gate off: untouched. The posted price and name pass, no pattern is forced, nothing is read', async () => {
    process.env.GATE_MOSQUITO_MISTING = 'false';
    const reads = [];
    const out = await normalizeUpdateDetailsAddons({
      db: fakeDb(tablesFor({ estimates: [] }), reads), id: VISIT, addons: [newLine()], updates: {}, isRecurring: false, serviceType: PLAN.name, scheduledDate: '2026-11-03',
    });
    expect(out.normalizedAddons[0]).toMatchObject({ base: 129, price: 129, serviceName: 'Mosquito Misting System Refill', recurringPattern: null });
    expect(reads).not.toContain('estimates');
  });

  test('another add-on on the same save is unchanged', async () => {
    const { normalizedAddons } = await normalize([newLine(), { serviceId: PEST.id, name: 'Pest Control', basePrice: 40, recurringPattern: 'quarterly' }]);
    expect(normalizedAddons[1]).toMatchObject({ serviceKey: 'pest_control', base: 40, price: 40, serviceName: 'Pest Control', recurringPattern: 'quarterly' });
  });
});

describe('Update Details that moves the visit to another house prices the refill for the destination', () => {
  const VISIT = 'visit-1';
  const OTHER = 'prop-other';
  const tables = (over = {}) => ({
    ...baseTables({
      estimates: [accepted('natural'), accepted('premium', { id: 'est-other', property_id: OTHER, accepted_at: '2026-10-05T00:00:00Z' })],
      customer_properties: [{ id: HOUSE, customer_id: CUSTOMER.id, active: true }, { id: OTHER, customer_id: CUSTOMER.id, active: true }],
    }),
    __columns: { scheduled_services: ['id', 'customer_id', 'property_id', 'source_estimate_id', 'service_id', 'service_key_snapshot'] },
    scheduled_services: [{ id: VISIT, customer_id: CUSTOMER.id, property_id: HOUSE, source_estimate_id: null, service_id: PLAN.id, service_key_snapshot: PLAN.service_key }],
    scheduled_service_addons: [],
    ...over,
  });
  const normalize = (extra = {}, t = tables()) => normalizeUpdateDetailsAddons({
    db: fakeDb(t), id: VISIT, addons: [{ serviceId: REFILL_ID, name: REFILL.name, basePrice: 129 }], updates: {}, isRecurring: false,
    serviceType: PLAN.name, scheduledDate: '2026-11-03', ...extra,
  });

  test('no move: priced for the house the visit is at', async () => {
    expect((await normalize()).normalizedAddons[0]).toMatchObject({ price: 219, refillPricedForProperty: HOUSE });
  });

  test('a move in the same save: priced for the destination, and tagged with it', async () => {
    expect((await normalize({ propertyId: OTHER })).normalizedAddons[0]).toMatchObject({ price: 319, refillPricedForProperty: OTHER });
  });

  test('a destination with no accepted misting estimate refuses instead of keeping the old house\'s price', async () => {
    await expect(normalize({ propertyId: OTHER }, tables({ estimates: [accepted('natural')] }))).rejects.toMatchObject({ code: 'MISTING_REFILL_UNPRICED' });
  });

  test('every refill line (priced now or kept as stored) carries the tag; other lines do not', async () => {
    const out = await normalize({}, tables());
    expect(Object.keys(out.normalizedAddons[0])).toContain('refillPricedForProperty');
    const pest = await normalizeUpdateDetailsAddons({
      db: fakeDb(tables()), id: VISIT, addons: [{ serviceId: PEST.id, name: 'Pest Control', basePrice: 40 }], updates: {}, isRecurring: false, serviceType: PLAN.name, scheduledDate: '2026-11-03',
    });
    expect(Object.keys(pest.normalizedAddons[0])).not.toContain('refillPricedForProperty');
  });

  test('a refill the visit already carries is kept at its stored price only while the visit stays at its house', async () => {
    const stored = { id: 'row-1', scheduled_service_id: VISIT, service_id: REFILL_ID, service_name: 'Mosquito Misting System Refill - Natural (botanical)', service_key_snapshot: 'mosquito_misting_refill', base_price: 219, estimated_price: 219 };
    const noEstimates = tables({ estimates: [], scheduled_service_addons: [stored] });
    const line = { id: 'row-1', serviceId: REFILL_ID, name: REFILL.name, basePrice: 219 };
    const run = (extra) => normalizeUpdateDetailsAddons({ db: fakeDb(noEstimates), id: VISIT, addons: [line], updates: {}, isRecurring: false, serviceType: PLAN.name, scheduledDate: '2026-11-03', ...extra });
    // stays put (no destination posted, or the same house posted): kept, and tagged so the row-lock check covers it
    expect((await run({})).normalizedAddons[0]).toMatchObject({ price: 219, refillPricedForProperty: HOUSE });
    expect((await run({ propertyId: HOUSE })).normalizedAddons[0]).toMatchObject({ price: 219, refillPricedForProperty: HOUSE });
    // moves to a house with no accepted misting estimate: refused, the old house's price is not carried over
    await expect(run({ propertyId: OTHER })).rejects.toMatchObject({ status: 409, code: 'MISTING_REFILL_UNPRICED' });
  });

  describe('assertRefillPropertyCurrent: the price is re-checked against the house under the save\'s row lock', () => {
    const { assertRefillPropertyCurrent } = router._test;
    const trxFor = (propertyId) => { const reads = []; const trx = (table) => { reads.push(table); return { where: () => ({ first: async () => ({ property_id: propertyId }) }) }; }; trx.reads = reads; return trx; };
    const line = (property) => ({ serviceKey: 'mosquito_misting_refill', refillPricedForProperty: property });

    test('the locked row\'s house matches what the refill was priced for: allowed', async () => {
      await expect(assertRefillPropertyCurrent(trxFor(HOUSE), VISIT, { addressPlan: null, replaceAddons: [line(HOUSE)] })).resolves.toBeUndefined();
    });

    test('another editor moved the visit in between: retryable 409, nothing saved at the old house\'s price', async () => {
      await expect(assertRefillPropertyCurrent(trxFor(OTHER), VISIT, { addressPlan: null, replaceAddons: [line(HOUSE)] }))
        .rejects.toMatchObject({ status: 409, code: 'VISIT_CHANGED_RETRY' });
    });

    test('this save\'s own move decides the house: priced for the destination is allowed, priced for the old house is not', async () => {
      const plan = { propertyId: OTHER };
      await expect(assertRefillPropertyCurrent(trxFor(HOUSE), VISIT, { addressPlan: plan, replaceAddons: [line(OTHER)] })).resolves.toBeUndefined();
      await expect(assertRefillPropertyCurrent(trxFor(HOUSE), VISIT, { addressPlan: plan, replaceAddons: [line(HOUSE)] }))
        .rejects.toMatchObject({ code: 'VISIT_CHANGED_RETRY' });
    });

    test('no priced refill line: no read at all', async () => {
      const trx = trxFor(HOUSE);
      await assertRefillPropertyCurrent(trx, VISIT, { addressPlan: null, replaceAddons: [{ serviceKey: 'pest_control' }, null] });
      await assertRefillPropertyCurrent(trx, VISIT, { addressPlan: null, replaceAddons: undefined });
      expect(trx.reads).toEqual([]);
    });

    test('a visit with no property and a refill priced with none agree', async () => {
      await expect(assertRefillPropertyCurrent(trxFor(null), VISIT, { addressPlan: null, replaceAddons: [line(null)] })).resolves.toBeUndefined();
    });
  });

  test('the save wires the check under the lock, right beside the area add-on edit check, and both planners pass the destination', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    expect(src).toContain('await assertRefillPropertyCurrent(trx, req.params.id, { addressPlan, replaceAddons });');
    expect(src).toContain('presetEligibilityCheck, propertyId,\n      });');
    expect(src).toContain("propertyId: typeof req.body.propertyId === 'string' ? req.body.propertyId : undefined,");
  });
});

describe('the refill is one-time on every series path (item 3, monthly path)', () => {
  const refillLine = (over = {}) => ({ serviceKey: 'mosquito_misting_refill', recurringPattern: null, ...over });
  const MONTHLY = ['2026-11-03', '2026-12-01', '2027-01-05', '2027-02-02'];

  test('the key is one-time-only: due on the anchor visit alone, whatever pattern the row holds', () => {
    expect(isOneTimeOnlyAddonKey('mosquito_misting_refill')).toBe(true);
    for (const recurringPattern of [null, 'monthly', 'monthly_nth_weekday', 'one_time']) {
      const due = MONTHLY.map((date) => lineDueOnRecurringDate(refillLine({ recurringPattern }), MONTHLY[0], date));
      expect(due).toEqual([true, false, false, false]);
    }
    expect(addonRecursAfterAnchor(refillLine())).toBe(false);
    expect(addonRecursAfterAnchor(refillLine({ recurringPattern: 'monthly' }))).toBe(false);
  });

  test('a snapshot-keyed row (the stored column) obeys the same guard', () => {
    const stored = { service_key_snapshot: 'mosquito_misting_refill', recurring_pattern: null };
    expect(lineDueOnRecurringDate(stored, MONTHLY[0], MONTHLY[1])).toBe(false);
    expect(addonRecursAfterAnchor(stored)).toBe(false);
  });

  test('the spawn filter keeps the refill on the anchor date only and the plan\'s own monthly line on every date', () => {
    const lines = [refillLine(), { serviceKey: 'mosquito_misting_service', recurringPattern: 'monthly' }];
    expect(filterAddonLinesForDate(lines, MONTHLY[0], MONTHLY[0]).map((l) => l.serviceKey)).toEqual(['mosquito_misting_refill', 'mosquito_misting_service']);
    for (const later of MONTHLY.slice(1)) {
      expect(filterAddonLinesForDate(lines, MONTHLY[0], later).map((l) => l.serviceKey)).toEqual(['mosquito_misting_service']);
    }
  });

  test('every producer of a refill row writes the explicit one-time pattern (a NULL pattern would ride the cadence of a plan reader)', async () => {
    const booking = await price();
    const edit = await normalizeUpdateDetailsAddons({
      db: fakeDb({ ...baseTables(), __columns: { scheduled_services: ['id', 'customer_id'] }, scheduled_services: [{ id: 'v', customer_id: CUSTOMER.id, property_id: HOUSE, service_key_snapshot: PLAN.service_key }], scheduled_service_addons: [] }),
      id: 'v', addons: [{ serviceId: REFILL_ID, name: REFILL.name }], updates: {}, isRecurring: false, serviceType: PLAN.name, scheduledDate: '2026-11-03',
    });
    expect(booking.addonLines[0].recurringPattern).toBe('one_time');
    expect(edit.normalizedAddons[0].recurringPattern).toBe('one_time');
  });
});

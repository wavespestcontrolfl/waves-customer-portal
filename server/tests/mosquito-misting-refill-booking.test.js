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
  config.applyMosquitoMistingPricingConfig(config.defaultMosquitoMistingPricingData());
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

describe('Update Details that moves the visit to another house never carries a refill with it', () => {
  const VISIT = 'visit-1';
  const OTHER = 'prop-other';
  const MOVED = 'visit-2';
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

  test('no move: priced for the house the visit is at, and tagged with it', async () => {
    expect((await normalize()).normalizedAddons[0]).toMatchObject({ price: 219, refillPricedForProperty: HOUSE });
  });

  test('posting the house the visit is already at is not a move', async () => {
    expect((await normalize({ propertyId: HOUSE })).normalizedAddons[0]).toMatchObject({ price: 219, refillPricedForProperty: HOUSE });
  });

  test('a refill line in a save that moves the address is refused, with the reason and the way out (no price is set for either house)', async () => {
    await expect(normalize({ propertyId: OTHER })).rejects.toMatchObject({
      status: 409, code: 'MISTING_REFILL_ADDRESS_MOVE', message: expect.stringMatching(/Remove the refill .* change the address, then add the refill again/),
    });
  });

  test('every refill line (priced now or kept as stored) carries the tag; other lines do not', async () => {
    const out = await normalize({}, tables());
    expect(Object.keys(out.normalizedAddons[0])).toContain('refillPricedForProperty');
    const pest = await normalizeUpdateDetailsAddons({
      db: fakeDb(tables()), id: VISIT, addons: [{ serviceId: PEST.id, name: 'Pest Control', basePrice: 40 }], updates: {}, isRecurring: false, serviceType: PLAN.name, scheduledDate: '2026-11-03',
    });
    expect(Object.keys(pest.normalizedAddons[0])).not.toContain('refillPricedForProperty');
  });

  test('a refill the visit already carries is kept at its stored price when it cannot be priced now, but a move refuses it', async () => {
    const stored = { id: 'row-1', scheduled_service_id: VISIT, service_id: REFILL_ID, service_name: 'Mosquito Misting System Refill - Natural (botanical)', service_key_snapshot: 'mosquito_misting_refill', base_price: 219, estimated_price: 219 };
    const noEstimates = tables({ estimates: [], scheduled_service_addons: [stored] });
    const line = { id: 'row-1', serviceId: REFILL_ID, name: REFILL.name, basePrice: 219 };
    const run = (extra) => normalizeUpdateDetailsAddons({ db: fakeDb(noEstimates), id: VISIT, addons: [line], updates: {}, isRecurring: false, serviceType: PLAN.name, scheduledDate: '2026-11-03', ...extra });
    expect((await run({})).normalizedAddons[0]).toMatchObject({ price: 219, refillPricedForProperty: HOUSE });
    expect((await run({ propertyId: HOUSE })).normalizedAddons[0]).toMatchObject({ price: 219, refillPricedForProperty: HOUSE });
    await expect(run({ propertyId: OTHER })).rejects.toMatchObject({ status: 409, code: 'MISTING_REFILL_ADDRESS_MOVE' });
  });

  test('gate off: a move with the line is not judged', async () => {
    process.env.GATE_MOSQUITO_MISTING = 'false';
    expect((await normalize({ propertyId: OTHER })).normalizedAddons[0]).toMatchObject({ price: 129 });
  });

  describe('assertRefillPropertyCurrent under the save\'s row lock', () => {
    const { assertRefillPropertyCurrent } = router._test;
    // A scripted transaction: the visit row and the add-on rows it may read.
    const trxFor = ({ propertyId = HOUSE, addons = [], movedProperty = HOUSE, hostKey = 'mosquito_misting_service', hostServiceId = null, services = [] } = {}) => {
      const reads = [];
      const trx = (table) => {
        reads.push(table);
        let rows = table === 'scheduled_service_addons' ? addons
          : table === 'services' ? services
            : [{ id: VISIT, property_id: propertyId, service_key_snapshot: hostKey, service_id: hostServiceId }, { id: MOVED, property_id: movedProperty }];
        const q = {
          where(cond) { if (cond && typeof cond === 'object') rows = rows.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
          whereIn(col, values) { rows = rows.filter((r) => values.includes(r[col])); return q; },
          select: async () => rows,
          first: async () => rows[0],
        };
        return q;
      };
      trx.reads = reads;
      return trx;
    };
    const priced = (property) => ({ serviceKey: 'mosquito_misting_refill', refillPricedForProperty: property });
    const stored = (visit) => ({ id: `row-${visit}`, scheduled_service_id: visit, service_key_snapshot: 'mosquito_misting_refill' });

    test('no address change: the locked row\'s house must be the one each refill line was priced for', async () => {
      await expect(assertRefillPropertyCurrent(trxFor(), VISIT, { addressPlan: null, replaceAddons: [priced(HOUSE)] })).resolves.toBeUndefined();
      await expect(assertRefillPropertyCurrent(trxFor({ propertyId: OTHER }), VISIT, { addressPlan: null, replaceAddons: [priced(HOUSE)] }))
        .rejects.toMatchObject({ status: 409, code: 'VISIT_CHANGED_RETRY' });
      await expect(assertRefillPropertyCurrent(trxFor({ propertyId: null }), VISIT, { addressPlan: null, replaceAddons: [priced(null)] })).resolves.toBeUndefined();
    });

    test('no address change: the locked row\'s host must still be the misting plan (a concurrent service switch is a retryable conflict)', async () => {
      await expect(assertRefillPropertyCurrent(trxFor({ hostKey: 'pest_control' }), VISIT, { addressPlan: null, replaceAddons: [priced(HOUSE)] }))
        .rejects.toMatchObject({ status: 409, code: 'VISIT_CHANGED_RETRY' });
      // No snapshot on the row: the catalog row behind service_id decides.
      await expect(assertRefillPropertyCurrent(trxFor({ hostKey: null, hostServiceId: 'svc-9', services: [{ id: 'svc-9', service_key: 'mosquito_misting_service' }] }), VISIT, { addressPlan: null, replaceAddons: [priced(HOUSE)] }))
        .resolves.toBeUndefined();
      await expect(assertRefillPropertyCurrent(trxFor({ hostKey: null, hostServiceId: 'svc-9', services: [{ id: 'svc-9', service_key: 'lawn_care' }] }), VISIT, { addressPlan: null, replaceAddons: [priced(HOUSE)] }))
        .rejects.toMatchObject({ status: 409, code: 'VISIT_CHANGED_RETRY' });
      // No key at all under the lock: fail closed.
      await expect(assertRefillPropertyCurrent(trxFor({ hostKey: null }), VISIT, { addressPlan: null, replaceAddons: [priced(HOUSE)] }))
        .rejects.toMatchObject({ status: 409, code: 'VISIT_CHANGED_RETRY' });
      // The save sets the service itself: that key was judged before the lock, the stored host is not re-read.
      await expect(assertRefillPropertyCurrent(trxFor({ hostKey: 'pest_control' }), VISIT, { addressPlan: null, replaceAddons: [priced(HOUSE)], updates: { service_key_snapshot: 'mosquito_misting_service' } }))
        .resolves.toBeUndefined();
    });

    test('a service-only save is judged again under the lock: a refill attached meanwhile stops the change away from the plan', async () => {
      const away = { service_key_snapshot: 'pest_control' };
      await expect(assertRefillPropertyCurrent(trxFor({ addons: [stored(VISIT)] }), VISIT, { addressPlan: null, replaceAddons: undefined, updates: away }))
        .rejects.toMatchObject({ status: 400, code: 'MISTING_REFILL_WRONG_PARENT' });
      await expect(assertRefillPropertyCurrent(trxFor({ addons: [] }), VISIT, { addressPlan: null, replaceAddons: undefined, updates: away }))
        .resolves.toBeUndefined();
      // Lines posted: they decide, the stored rows are not consulted here.
      await expect(assertRefillPropertyCurrent(trxFor({ addons: [stored(VISIT)] }), VISIT, { addressPlan: null, replaceAddons: [{ serviceKey: 'pest_control' }], updates: away }))
        .resolves.toBeUndefined();
    });

    test('no priced refill line and no address change: no read at all', async () => {
      const trx = trxFor();
      await assertRefillPropertyCurrent(trx, VISIT, { addressPlan: null, replaceAddons: [{ serviceKey: 'pest_control' }, null] });
      await assertRefillPropertyCurrent(trx, VISIT, { addressPlan: null, replaceAddons: undefined });
      expect(trx.reads).toEqual([]);
    });

    test('the move decision lives in the shared address mover, not here: an address plan is not read by this check', async () => {
      // Codex #6559 r1 P2: applyAppointmentAddress (services/appointment-address.js, assertNoMistingRefillMoves) runs earlier in the
      // same transaction and is the one judge of a refill that would change house; this check keeps no second copy.
      const trx = trxFor({ addons: [stored(VISIT)] });
      await expect(assertRefillPropertyCurrent(trx, VISIT, { replaceAddons: undefined })).resolves.toBeUndefined();
      expect(trx.reads).toEqual([]);
    });
  });

  describe('the shared address mover judges only the rows the move re-addresses (assertNoMistingRefillMoves)', () => {
    const address = require('../services/appointment-address');
    const { rowsTheMoveUpdates } = address._test;
    const trxWith = (addons) => (table) => {
      let rows = table === 'scheduled_service_addons' ? addons : [];
      const q = {
        where(cond) { rows = rows.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
        whereIn(col, values) { rows = rows.filter((r) => values.includes(r[col])); return q; },
        first: async () => rows[0],
      };
      return q;
    };
    const row = (id, property, status = 'pending') => ({ id, property_id: property, status });
    const stored = (visit) => ({ id: `row-${visit}`, scheduled_service_id: visit, service_key_snapshot: 'mosquito_misting_refill' });

    test('a completed series parent the plan carries is not a row the move updates; the anchor and package children always are', () => {
      const locked = [row('parent', HOUSE, 'completed'), row(VISIT, HOUSE), row('kid', HOUSE, 'rescheduled'), row('done', HOUSE, 'completed')];
      expect(rowsTheMoveUpdates(locked, { anchorId: VISIT, packageChildIds: ['kid'] }).map((r) => r.id)).toEqual([VISIT, 'kid']);
      expect(rowsTheMoveUpdates(locked, { anchorId: 'parent', packageChildIds: [] }).map((r) => r.id)).toEqual(['parent', VISIT]);
    });

    test('a refill on the completed parent does not block moving the future occurrences; one on a moved occurrence still does', async () => {
      const trx = trxWith([stored('parent')]);
      await expect(address.assertNoMistingRefillMoves(trx, [row(VISIT, HOUSE), row(MOVED, HOUSE)], OTHER, null)).resolves.toBeUndefined();
      await expect(address.assertNoMistingRefillMoves(trxWith([stored(MOVED)]), [row(VISIT, HOUSE), row(MOVED, HOUSE)], OTHER, null))
        .rejects.toMatchObject({ statusCode: 409, code: 'MISTING_REFILL_ADDRESS_MOVE' });
    });

    test('the edited visit is judged by what the save leaves on it; a row already at the destination is not moving', async () => {
      const edited = { id: VISIT, rowKeys: ['mosquito_misting_refill'] };
      await expect(address.assertNoMistingRefillMoves(trxWith([]), [row(VISIT, HOUSE)], OTHER, edited)).rejects.toMatchObject({ code: 'MISTING_REFILL_ADDRESS_MOVE' });
      await expect(address.assertNoMistingRefillMoves(trxWith([stored(VISIT)]), [row(VISIT, HOUSE)], OTHER, { id: VISIT, rowKeys: ['pest_control'] })).resolves.toBeUndefined();
      await expect(address.assertNoMistingRefillMoves(trxWith([stored(VISIT)]), [row(VISIT, OTHER)], OTHER, null)).resolves.toBeUndefined();
    });

    test('gate off: not judged', async () => {
      process.env.GATE_MOSQUITO_MISTING = 'false';
      await expect(address.assertNoMistingRefillMoves(trxWith([stored(VISIT)]), [row(VISIT, HOUSE)], OTHER, null)).resolves.toBeUndefined();
    });

    test('applyAppointmentAddress hands the mover the rows it re-addresses, computed before the guards', () => {
      const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'appointment-address.js'), 'utf8');
      const compute = src.indexOf('const addressRows = rowsTheMoveUpdates(locked,');
      const guard = src.indexOf('await assertNoMistingRefillMoves(trx, addressRows, plan.propertyId');
      expect(compute).toBeGreaterThan(0);
      expect(guard).toBeGreaterThan(compute);
    });
  });

  test('the save wires the check under the lock, right beside the area add-on edit check, and both planners pass the destination', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    expect(src).toContain('await assertRefillPropertyCurrent(trx, req.params.id, { replaceAddons, updates });');
    expect(src).toContain('presetEligibilityCheck, propertyId,\n      });');
    expect(src).toContain("propertyId: typeof req.body.propertyId === 'string' ? req.body.propertyId : undefined,");
  });
});

describe('annual prepay path: a refill on a covered occurrence is the add-on owed on top, so the repricing guard lets it save', () => {
  const { refillOnlyPriceChange, withoutAnnualPrepayCoverage } = router._test;
  const VISIT = 'occ-2';
  // The covered occurrence: base 59 stamped as the term's slice, no refill yet.
  const row = (over = {}) => ({ id: VISIT, estimated_price: '59.00', primary_line_price: '59.00', annual_prepay_term_id: 'term-1', prepaid_method: 'annual_prepay_invoice', prepaid_amount: '59.00', ...over });
  // storedNets are the visit's stored refill lines; otherAddons any other stored add-on lines
  const trxWith = (storedNets = [], otherAddons = []) => (table) => {
    const rows = table === 'scheduled_service_addons'
      ? [...storedNets.map((estimated_price) => ({ service_key_snapshot: 'mosquito_misting_refill', estimated_price })),
        ...otherAddons.map((estimated_price) => ({ service_key_snapshot: 'pest_control', estimated_price }))]
      : [];
    return { where: () => ({ select: async () => rows }) };
  };
  const refillLine = (price) => ({ serviceKey: 'mosquito_misting_refill', price });
  const savedBilling = process.env.GATE_ANNUAL_PREPAY_ADDON_BILLING;
  beforeEach(() => { process.env.GATE_ANNUAL_PREPAY_ADDON_BILLING = 'true'; });
  afterEach(() => { if (savedBilling === undefined) delete process.env.GATE_ANNUAL_PREPAY_ADDON_BILLING; else process.env.GATE_ANNUAL_PREPAY_ADDON_BILLING = savedBilling; });
  const run = (over = {}) => refillOnlyPriceChange(over.trx || trxWith(), VISIT, {
    row: over.row || row(), updates: over.updates || { estimated_price: 278 }, replaceAddons: over.replaceAddons || [refillLine(219)],
  });

  test('adding a refill raises the total by exactly its net: only the refill changed', async () => {
    await expect(run()).resolves.toBe(true);
    await expect(run({ updates: { estimated_price: 278, primary_line_price: 59 } })).resolves.toBe(true);
  });

  test('re-pricing a refill the visit already carries counts the change from what is stored', async () => {
    await expect(run({ trx: trxWith([219]), row: row({ estimated_price: '278.00' }), updates: { estimated_price: 289 }, replaceAddons: [refillLine(230)] })).resolves.toBe(true);
    await expect(run({ trx: trxWith([219]), row: row({ estimated_price: '278.00' }), updates: { estimated_price: 278 }, replaceAddons: [refillLine(219)] })).resolves.toBe(false);
  });

  test('anything else in the price change keeps the full guard', async () => {
    // the total moved by more than the refill (another add-on, an appointment discount, a primary edit)
    await expect(run({ updates: { estimated_price: 300 } })).resolves.toBe(false);
    await expect(run({ updates: { estimated_price: 250 } })).resolves.toBe(false);
    // the primary line price itself is posted as different
    await expect(run({ updates: { estimated_price: 278, primary_line_price: 40 } })).resolves.toBe(false);
    // no refill line at all
    await expect(run({ replaceAddons: [{ serviceKey: 'pest_control', price: 219 }] })).resolves.toBe(false);
    // add-ons not replaced in this save, or no price posted
    await expect(refillOnlyPriceChange(trxWith(), VISIT, { row: row(), updates: { estimated_price: 278 }, replaceAddons: undefined })).resolves.toBe(false);
    await expect(run({ updates: { primary_line_price: 59 } })).resolves.toBe(false);
    await expect(refillOnlyPriceChange(trxWith(), VISIT, { row: null, updates: { estimated_price: 278 }, replaceAddons: [refillLine(219)] })).resolves.toBe(false);
  });

  test('an estimate-converted visit with no primary_line_price: the base is the total less its stored add-ons, so an unchanged base still qualifies', async () => {
    // total 59 = base 59, no add-ons: the Update Details save materializes primary_line_price 59
    await expect(run({ row: row({ primary_line_price: null }), updates: { estimated_price: 278, primary_line_price: 59 } })).resolves.toBe(true);
    // total 79 = base 59 + a stored 20 add-on: the posted base 59 is unchanged; the base 79 is not
    await expect(run({ trx: trxWith([], [20]), row: row({ primary_line_price: null, estimated_price: '79.00' }), updates: { estimated_price: 298, primary_line_price: 59 } })).resolves.toBe(true);
    await expect(run({ trx: trxWith([], [20]), row: row({ primary_line_price: null, estimated_price: '79.00' }), updates: { estimated_price: 298, primary_line_price: 79 } })).resolves.toBe(false);
  });

  test('an occurrence the term has not stamped keeps the full guard (its prepay may still await payment)', async () => {
    await expect(run({ row: row({ annual_prepay_term_id: null }) })).resolves.toBe(false);
  });

  test('the add-on billing gate dark: never exempt, since the completion would not bill the refill', async () => {
    process.env.GATE_ANNUAL_PREPAY_ADDON_BILLING = 'false';
    await expect(run()).resolves.toBe(false);
    delete process.env.GATE_ANNUAL_PREPAY_ADDON_BILLING;
    await expect(run()).resolves.toBe(false);
  });

  test('gate off: never exempt', async () => {
    process.env.GATE_MOSQUITO_MISTING = 'false';
    await expect(run()).resolves.toBe(false);
  });

  test('the guard judges the row without the annual-prepay term link and stamp, and keeps every other money reason', () => {
    expect(withoutAnnualPrepayCoverage(row())).toMatchObject({ annual_prepay_term_id: null, prepaid_amount: null, id: VISIT, estimated_price: '59.00' });
    // a hand-collected prepayment (not the annual writer's method) is still prepaid money
    expect(withoutAnnualPrepayCoverage(row({ prepaid_method: 'cash' }))).toMatchObject({ annual_prepay_term_id: null, prepaid_amount: '59.00' });
  });

  test('the committed-money guard uses it, before the coverage check, and only for the refill-only change', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    const exempt = src.indexOf('await refillOnlyPriceChange(trx, req.params.id, { row: priceGuardRow, updates, replaceAddons })');
    const judged = src.indexOf('findBillingCoveredVisits(trx, [priceGuardRow || { id: req.params.id }], { liveInvoice: true })');
    expect(exempt).toBeGreaterThan(-1);
    expect(src).toContain('[withoutAnnualPrepayCoverage(priceGuardRow)], { liveInvoice: true, securePrepay: false }');
    expect(exempt).toBeLessThan(judged);
  });
});

describe('an explicit service change is never answered with the old service\'s identity', () => {
  const VISIT = 'visit-1';
  const tables = (over = {}) => ({
    ...baseTables(),
    __columns: { scheduled_services: ['id', 'customer_id', 'property_id', 'source_estimate_id', 'service_id', 'service_key_snapshot'] },
    scheduled_services: [{ id: VISIT, customer_id: CUSTOMER.id, property_id: HOUSE, source_estimate_id: null, service_id: PLAN.id, service_key_snapshot: null }],
    scheduled_service_addons: [],
    ...over,
  });
  const normalize = (updates) => normalizeUpdateDetailsAddons({
    db: fakeDb(tables()), id: VISIT, addons: [{ serviceId: REFILL_ID, name: REFILL.name }], updates, isRecurring: false, serviceType: PLAN.name, scheduledDate: '2026-11-03',
  });

  test('an unknown pick (service_key_snapshot null) is not the stored plan service', async () => {
    await expect(normalize({ service_id: null, service_key_snapshot: null })).rejects.toMatchObject({ code: 'MISTING_REFILL_WRONG_PARENT' });
  });

  test('a save that did not change the service still reads the stored one (snapshot, else the service row)', async () => {
    expect((await normalize({})).normalizedAddons[0].price).toBe(219);
    expect((await normalize({ service_id: PLAN.id })).normalizedAddons[0].price).toBe(219);
    await expect(normalize({ service_id: PEST.id })).rejects.toMatchObject({ code: 'MISTING_REFILL_WRONG_PARENT' });
  });
});

describe('a service change that reaches later occurrences leaves no refill on a non-plan visit', () => {
  const { assertNoStrandedRefill } = router._test;
  const conn = (rows) => (table) => {
    let found = table === 'scheduled_service_addons' ? rows : [];
    const q = {
      whereIn(col, values) { found = found.filter((r) => values.includes(r[col])); return q; },
      where(cond) { found = found.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
      first: async () => found[0],
    };
    return q;
  };
  const refillOn = (visit) => ({ id: `r-${visit}`, scheduled_service_id: visit, service_key_snapshot: 'mosquito_misting_refill' });

  test('a later occurrence that carries a refill blocks a change to another service (and an unknown one)', async () => {
    await expect(assertNoStrandedRefill(conn([refillOn('later-2')]), [{ id: 'later-1' }, { id: 'later-2' }], 'pest_control'))
      .rejects.toMatchObject({ status: 409, code: 'MISTING_REFILL_WRONG_PARENT' });
    await expect(assertNoStrandedRefill(conn([refillOn('later-2')]), [{ id: 'later-2' }], undefined)).rejects.toMatchObject({ code: 'MISTING_REFILL_WRONG_PARENT' });
    await expect(assertNoStrandedRefill(conn([refillOn('later-2')]), [{ id: 'later-2' }], null)).rejects.toMatchObject({ code: 'MISTING_REFILL_WRONG_PARENT' });
  });

  test('allowed: no refill on the targets, a change that stays on the plan service, no targets, or the gate off', async () => {
    await expect(assertNoStrandedRefill(conn([refillOn('elsewhere')]), [{ id: 'later-1' }], 'pest_control')).resolves.toBeUndefined();
    await expect(assertNoStrandedRefill(conn([refillOn('later-1')]), [{ id: 'later-1' }], 'mosquito_misting_service')).resolves.toBeUndefined();
    await expect(assertNoStrandedRefill(conn([refillOn('later-1')]), [], 'pest_control')).resolves.toBeUndefined();
    process.env.GATE_MOSQUITO_MISTING = 'false';
    await expect(assertNoStrandedRefill(conn([refillOn('later-1')]), [{ id: 'later-1' }], 'pest_control')).resolves.toBeUndefined();
  });

  test('the following-visits guard runs it on the locked targets, only for a service change', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    expect(src).toContain('if (serviceChanged) await assertNoStrandedRefill(conn, targets, proposedFields ? proposedFields.service_key_snapshot : undefined);');
  });
});

describe('Update Details that changes the visit\'s own service (placement rules apply to a partial request too)', () => {
  const { assertRefillPlacementOnEdit } = router._test;
  const VISIT = 'visit-1';
  const world = (storedKey = PLAN.service_key, addons = []) => fakeDb({
    __columns: { scheduled_services: ['id', 'service_key_snapshot'] },
    scheduled_services: [{ id: VISIT, service_key_snapshot: storedKey }],
    scheduled_service_addons: addons,
  });
  const keptRefill = { id: 'row-1', scheduled_service_id: VISIT, service_key_snapshot: 'mosquito_misting_refill' };
  const run = (db, updates, addonsPosted) => assertRefillPlacementOnEdit(db, VISIT, { updates, addonsPosted });

  test('changing the visit\'s service TO the refill is refused even with no add-on line posted', async () => {
    await expect(run(world(), { service_key_snapshot: 'mosquito_misting_refill' }, false)).rejects.toMatchObject({ status: 400, code: 'MISTING_REFILL_ADDON_ONLY' });
    await expect(run(world(), { service_key_snapshot: 'mosquito_misting_refill' }, true)).rejects.toMatchObject({ code: 'MISTING_REFILL_ADDON_ONLY' });
  });

  test('moving the host to another service while a refill row stays (add-ons not reposted) is refused', async () => {
    await expect(run(world(PLAN.service_key, [keptRefill]), { service_key_snapshot: 'pest_control' }, false))
      .rejects.toMatchObject({ status: 400, code: 'MISTING_REFILL_WRONG_PARENT' });
    await expect(run(world(PLAN.service_key, [keptRefill]), { service_key_snapshot: null }, false)).rejects.toMatchObject({ code: 'MISTING_REFILL_WRONG_PARENT' });
  });

  test('with the add-ons reposted the add-on resolver judges them instead; no refill row, or the plan service kept, is allowed', async () => {
    await expect(run(world(PLAN.service_key, [keptRefill]), { service_key_snapshot: 'pest_control' }, true)).resolves.toBeUndefined();
    await expect(run(world(PLAN.service_key, []), { service_key_snapshot: 'pest_control' }, false)).resolves.toBeUndefined();
    await expect(run(world('pest_control', [keptRefill]), { service_key_snapshot: PLAN.service_key }, false)).resolves.toBeUndefined();
  });

  test('a save that keeps the service is never judged: an older visit stays editable', async () => {
    await expect(run(world('mosquito_misting_refill', []), { service_key_snapshot: 'mosquito_misting_refill' }, false)).resolves.toBeUndefined();
    await expect(run(world(PLAN.service_key, [keptRefill]), {}, false)).resolves.toBeUndefined();
    await expect(run(world(PLAN.service_key, [keptRefill]), undefined, false)).resolves.toBeUndefined();
  });

  test('gate off: no read, no refusal', async () => {
    process.env.GATE_MOSQUITO_MISTING = 'false';
    const reads = [];
    const tables = { scheduled_services: [{ id: VISIT, service_key_snapshot: PLAN.service_key }], scheduled_service_addons: [keptRefill] };
    await expect(assertRefillPlacementOnEdit(fakeDb(tables, reads), VISIT, { updates: { service_key_snapshot: 'mosquito_misting_refill' }, addonsPosted: false })).resolves.toBeUndefined();
    expect(reads).toEqual([]);
  });

  test('the planner (save and preview) runs the placement check right after the service is resolved', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    expect(src).toContain('await assertRefillPlacementOnEdit(db, id, { updates, addonsPosted: Array.isArray(addons) });');
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

describe('the shared address mover refuses a refill it would carry to another house, for every caller', () => {
  const { assertNoMistingRefillMoves } = require('../services/appointment-address');
  const REFILL = 'mosquito_misting_refill';
  const rows = [{ id: 'v1', property_id: 'house-a' }, { id: 'v2', property_id: 'house-a' }];
  const trxWith = (withRefill, seen = []) => (table) => ({
    whereIn: (col, ids) => { seen.push({ table, ids }); return { where: () => ({ first: async () => (withRefill ? { id: 'a1' } : undefined) }) }; },
  });

  test('a moved visit that stores a refill is refused (the Intelligence Bar and geocode review pass no edited visit)', async () => {
    await expect(assertNoMistingRefillMoves(trxWith(true), rows, 'house-b', null)).rejects.toMatchObject({ code: 'MISTING_REFILL_ADDRESS_MOVE', statusCode: 409 });
  });

  test('no refill stored, or a visit already at the destination, moves freely', async () => {
    await expect(assertNoMistingRefillMoves(trxWith(false), rows, 'house-b', null)).resolves.toBeUndefined();
    const seen = [];
    await expect(assertNoMistingRefillMoves(trxWith(true, seen), rows, 'house-a', null)).resolves.toBeUndefined();
    expect(seen).toEqual([]);
  });

  test('the visit the same save edits is judged by what the save leaves on it, not by the rows it is dropping', async () => {
    const seen = [];
    // the save removes the stored refill: only the other moved visit's rows are read
    await expect(assertNoMistingRefillMoves(trxWith(false, seen), rows, 'house-b', { id: 'v1', rowKeys: ['pest_control'] })).resolves.toBeUndefined();
    expect(seen[0].ids).toEqual(['v2']);
    // the save posts a refill along with the move
    await expect(assertNoMistingRefillMoves(trxWith(false), rows, 'house-b', { id: 'v1', rowKeys: [REFILL] })).rejects.toMatchObject({ code: 'MISTING_REFILL_ADDRESS_MOVE' });
    // the only moved visit is the edited one and the save drops the refill: nothing else to read
    const none = [];
    await expect(assertNoMistingRefillMoves(trxWith(true, none), [rows[0]], 'house-b', { id: 'v1', rowKeys: [] })).resolves.toBeUndefined();
    expect(none).toEqual([]);
  });

  test('gate off: the mover is untouched', async () => {
    process.env.GATE_MOSQUITO_MISTING = 'false';
    await expect(assertNoMistingRefillMoves(trxWith(true), rows, 'house-b', null)).resolves.toBeUndefined();
  });
});

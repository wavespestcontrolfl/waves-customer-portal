// Recap context product data for the Fast Complete picker: catalog rows
// carry the short label and stock on hand, and commonProducts lists the
// products used most on the visit's service line. The SQL itself (order,
// limit, active-only, window, usual unit/amount) runs against PostgreSQL in
// pest-recap-common-products-postgres.test.js; this file pins the JS side:
// the line and ET window the query is bound to, the response shape, and
// the fail-soft paths.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/job-status', () => ({ transitionJobStatus: jest.fn() }));
jest.mock('../services/track-transitions', () => ({ markComplete: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/completion-recap', () => ({ generateRecap: jest.fn(), smsRecap: jest.fn() }));
jest.mock('../services/service-completion-profiles', () => ({
  resolveCompletionProfileForScheduledService: jest.fn().mockResolvedValue({ category: 'pest_control' }),
}));

const logger = require('../services/logger');
const { buildRecapContext } = require('../services/pest-recap');

const visit = {
  id: 'visit-example', customer_id: 'customer-example', property_id: 'property-a',
  service_type: 'Pest Control Re-Service', service_id: 'cat-1', scheduled_date: '2026-09-28', status: 'confirmed',
  first_name: 'Example', last_name: 'Customer',
  cust_address_line1: '100 Example Court', cust_city: 'Example City', cust_state: 'FL', cust_zip: '34201',
};

function contextDb({
  svc = visit, catalog = [], catalogError = null, commonRows = [], commonError = null,
  record = null, recordedProducts = [], ledgerRows = [], ledgerError = null,
} = {}) {
  const seen = { catalogWhere: null, catalogColumns: null, raw: [], timeout: [], ledgerWhere: null, ledgerNull: null };
  const knex = jest.fn((table) => {
    const q = {
      where: jest.fn((arg) => {
        if (table === 'products_catalog') seen.catalogWhere = arg;
        if (table === 'property_application_history') seen.ledgerWhere = arg;
        return q;
      }),
      whereNull: jest.fn((column) => { if (table === 'property_application_history') seen.ledgerNull = column; return q; }),
      leftJoin: jest.fn(() => q),
      orderBy: jest.fn(() => q),
      first: jest.fn().mockResolvedValue(table === 'scheduled_services' ? svc : table === 'service_records' ? record : null),
      select: jest.fn((...columns) => {
        if (table === 'scheduled_services') return q;
        if (table === 'products_catalog') {
          seen.catalogColumns = columns;
          return catalogError ? Promise.reject(catalogError) : Promise.resolve(catalog);
        }
        if (table === 'service_products') return Promise.resolve(recordedProducts.map((row) => ({ ...row })));
        if (table === 'property_application_history') return ledgerError ? Promise.reject(ledgerError) : Promise.resolve(ledgerRows);
        return Promise.resolve([]);
      }),
    };
    return q;
  });
  knex.schema = { hasColumn: jest.fn().mockResolvedValue(true) };
  knex.raw = jest.fn((sql, bindings) => {
    seen.raw.push({ sql, bindings });
    return {
      timeout: (ms, options) => {
        seen.timeout.push({ ms, options });
        return commonError ? Promise.reject(commonError) : Promise.resolve({ rows: commonRows });
      },
    };
  });
  return { knex, seen };
}

beforeEach(() => {
  logger.warn.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

test('catalog rows add the short label, stock unit, formulation and a numeric stock on hand', async () => {
  const { knex, seen } = contextDb({
    catalog: [
      { id: 'p-taurus', name: 'Taurus SC', display_name: 'Taurus', inventory_unit: 'fl_oz', inventory_on_hand: '12.5000' },
      { id: 'p-demand', name: 'Demand CS', display_name: null, inventory_unit: 'fl_oz', inventory_on_hand: '0.0000' },
      { id: 'p-alpine', name: 'Alpine WSG', display_name: 'Alpine', inventory_unit: null, inventory_on_hand: null },
    ],
  });

  const result = await buildRecapContext(visit.id, knex);

  expect(seen.catalogWhere).toEqual({ active: true });
  expect(seen.catalogColumns).toEqual(expect.arrayContaining([
    'id', 'name', 'category', 'default_rate', 'rate_unit', 'default_rate_per_1000', 'max_label_rate_per_1000',
    'application_method', 'display_name', 'inventory_unit', 'inventory_on_hand', 'formulation',
  ]));
  expect(result.products).toEqual([
    { id: 'p-taurus', name: 'Taurus SC', display_name: 'Taurus', inventory_unit: 'fl_oz', inventory_on_hand: 12.5 },
    { id: 'p-demand', name: 'Demand CS', display_name: null, inventory_unit: 'fl_oz', inventory_on_hand: 0 },
    { id: 'p-alpine', name: 'Alpine WSG', display_name: 'Alpine', inventory_unit: null, inventory_on_hand: null },
  ]);
});

// Only the Fast Complete sheet asks for the most-used list
// (?include=common_products on the route).
const WITH_COMMON = { includeCommonProducts: true };

test('without the Fast Complete opt-in (the recap modal, the stock re-read) the aggregate never runs', async () => {
  const { knex, seen } = contextDb({
    commonRows: [{ product_id: 'p-alpine', visits: 12, usual_unit: 'g', usual_amount: '5.000' }],
  });
  const result = await buildRecapContext(visit.id, knex);
  expect(result.ok).toBe(true);
  expect(seen.raw).toHaveLength(0);
  expect(result).not.toHaveProperty('commonProducts');
});

test('commonProducts keeps the query order and returns numbers, bound to the visit line and the ET 90-day window', async () => {
  // 10:30 PM ET on Sep 27 is already Sep 28 in UTC: the window must end on
  // the ET day and start 89 days before it.
  jest.useFakeTimers({ now: new Date('2026-09-28T02:30:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  const { knex, seen } = contextDb({
    commonRows: [
      { product_id: 'p-alpine', visits: 12, usual_unit: 'g', usual_amount: '5.000' },
      { product_id: 'p-gentrol', visits: 12, usual_unit: 'fl_oz', usual_amount: '1.500' },
      { product_id: 'p-demand', visits: 4, usual_unit: 'fl_oz', usual_amount: null },
      { product_id: 'p-bait', visits: 1, usual_unit: null, usual_amount: null },
    ],
  });

  const result = await buildRecapContext(visit.id, knex, WITH_COMMON);

  expect(result.ok).toBe(true);
  expect(result.commonProducts).toEqual([
    { productId: 'p-alpine', visits: 12, usualUnit: 'g', usualAmount: 5 },
    { productId: 'p-gentrol', visits: 12, usualUnit: 'fl_oz', usualAmount: 1.5 },
    { productId: 'p-demand', visits: 4, usualUnit: 'fl_oz', usualAmount: null },
    { productId: 'p-bait', visits: 1, usualUnit: null, usualAmount: null },
  ]);
  expect(seen.raw).toHaveLength(1);
  // A pest re-service resolves to the pest line, as the completion path
  // stamps it; the last binding is the 8-product limit.
  expect(seen.raw[0].bindings).toEqual(['pest', '2026-06-30', '2026-09-27', 8]);
  // Bounded and cancelled server-side, so a slow aggregate cannot hold the
  // context open.
  expect(seen.timeout).toEqual([{ ms: expect.any(Number), options: { cancel: true } }]);
  expect(seen.timeout[0].ms).toBeLessThanOrEqual(2000);
  expect(logger.warn).not.toHaveBeenCalled();
});

test('the line comes from the visit type, not a pest default', async () => {
  const { knex, seen } = contextDb({ svc: { ...visit, service_type: 'Lawn Care Visit #3' } });
  await buildRecapContext(visit.id, knex, WITH_COMMON);
  expect(seen.raw[0].bindings[0]).toBe('lawn');
});

test.each([null, '', '   '])('a visit with no type (%p) has no line: commonProducts is [] and nothing is queried', async (serviceType) => {
  const { knex, seen } = contextDb({ svc: { ...visit, service_type: serviceType } });
  const result = await buildRecapContext(visit.id, knex, WITH_COMMON);
  expect(result.ok).toBe(true);
  expect(result.commonProducts).toEqual([]);
  expect(seen.raw).toHaveLength(0);
  expect(logger.warn).not.toHaveBeenCalled();
});

test('a failed common-products query is [] with one warn that carries no driver text, and the context still loads', async () => {
  const err = Object.assign(new Error('canceling statement due to statement timeout: Example Customer 100 Example Court'), { code: '57014' });
  const { knex } = contextDb({
    catalog: [{ id: 'p-taurus', name: 'Taurus SC', inventory_on_hand: '3' }],
    commonError: err,
  });

  const result = await buildRecapContext(visit.id, knex, WITH_COMMON);

  expect(result.ok).toBe(true);
  expect(result.commonProducts).toEqual([]);
  expect(result.products).toEqual([{ id: 'p-taurus', name: 'Taurus SC', inventory_on_hand: 3 }]);
  expect(result.service.customerName).toBe('Example Customer');
  expect(logger.warn).toHaveBeenCalledTimes(1);
  const [message] = logger.warn.mock.calls[0];
  expect(message).toContain('57014');
  expect(message).not.toMatch(/Example Customer|Example Court|canceling statement/);
});

test('a catalog load failure is distinguishable from an authoritative empty catalog', async () => {
  const { knex } = contextDb({ catalogError: new Error('catalog down') });
  const result = await buildRecapContext(visit.id, knex);
  expect(result.ok).toBe(true);
  expect(result.products).toEqual([]);
  expect(result.catalogLoadFailed).toBe(true);
  const empty = await buildRecapContext(visit.id, contextDb({ catalog: [] }).knex);
  expect(empty.products).toEqual([]);
  expect(empty.catalogLoadFailed).toBe(false);
});

test('a reopened recap carries each recorded product\'s ledger rows (the recap rows keep no amounts)', async () => {
  const { knex, seen } = contextDb({
    record: { id: 'rec-1', technician_notes: null, status: 'completed' },
    recordedProducts: [
      { product_name: 'Taurus SC', application_rate: '1.6000', rate_unit: 'oz', product_id: 'p-taurus' },
      { product_name: 'LESCO Crosscheck Plus', application_rate: '4.0000', rate_unit: 'oz', product_id: 'p-cross' },
    ],
    ledgerRows: [
      { product_id: 'p-taurus', quantity_applied: '3.200', quantity_unit: 'fl_oz' },
      { product_id: 'p-cross', quantity_applied: null, quantity_unit: 'fl_oz' },
    ],
  });

  const result = await buildRecapContext(visit.id, knex);

  expect(seen.ledgerWhere).toEqual({ service_record_id: 'rec-1' });
  expect(seen.ledgerNull).toBe('retracted_at');
  const [taurus, cross] = result.existingRecord.products;
  expect(taurus).toMatchObject({ product_id: 'p-taurus', ledger_rows: [{ quantity: 3.2, quantity_unit: 'fl_oz' }] });
  expect(cross.ledger_rows).toEqual([{}]);
});

test('every active ledger row of the product goes: the linked legacy row (no product_id) and the catalog-id rows', async () => {
  const { knex } = contextDb({
    record: { id: 'rec-1', technician_notes: null, status: 'completed' },
    recordedProducts: [
      { service_product_id: 'sp-1', product_name: 'Taurus SC', application_rate: '1.6000', rate_unit: 'oz', product_id: 'p-taurus' },
      { service_product_id: 'sp-2', product_name: 'LESCO Crosscheck Plus', application_rate: '4.0000', rate_unit: 'oz', product_id: 'p-cross' },
    ],
    ledgerRows: [
      { product_id: null, service_product_id: 'sp-1', quantity_applied: null, quantity_unit: null, dilution_rate: null },
      { product_id: 'p-taurus', service_product_id: null, quantity_applied: '1.600', quantity_unit: 'fl_oz', dilution_rate: '0.03%' },
      { product_id: 'p-taurus', service_product_id: null, quantity_applied: '3.200', quantity_unit: 'fl_oz', dilution_rate: '0.06%' },
      { product_id: 'p-cross', service_product_id: 'sp-2', quantity_applied: '4.000', quantity_unit: 'fl_oz' },
    ],
  });

  const result = await buildRecapContext(visit.id, knex);

  const [taurus, cross] = result.existingRecord.products;
  expect(taurus.ledger_rows).toEqual([
    {},
    { quantity: 1.6, quantity_unit: 'fl_oz', dilution_rate: '0.03%' },
    { quantity: 3.2, quantity_unit: 'fl_oz', dilution_rate: '0.06%' },
  ]);
  expect(cross.ledger_rows).toEqual([{ quantity: 4, quantity_unit: 'fl_oz' }]);
});

test('a reopened recap carries the ledger dilution and date, also on a row with no quantity', async () => {
  const { knex } = contextDb({
    record: { id: 'rec-1', technician_notes: null, status: 'completed' },
    recordedProducts: [
      { product_name: 'Taurus SC', application_rate: '1.6000', rate_unit: 'oz', product_id: 'p-taurus' },
      { product_name: 'LESCO Crosscheck Plus', application_rate: '4.0000', rate_unit: 'oz', product_id: 'p-cross' },
    ],
    ledgerRows: [
      // pg returns a DATE column as a UTC-midnight Date.
      { product_id: 'p-taurus', quantity_applied: null, quantity_unit: null, dilution_rate: '0.06%', application_date: new Date('2026-10-14T00:00:00Z') },
      { product_id: 'p-cross', quantity_applied: '4.000', quantity_unit: 'fl_oz', dilution_rate: ' ', application_date: '2026-10-14' },
    ],
  });

  const result = await buildRecapContext(visit.id, knex);

  const [taurus, cross] = result.existingRecord.products;
  expect(taurus.ledger_rows).toEqual([{ dilution_rate: '0.06%', application_date: '2026-10-14' }]);
  expect(cross.ledger_rows).toEqual([{ quantity: 4, quantity_unit: 'fl_oz', application_date: '2026-10-14' }]);
});

test('a failed ledger read leaves the recorded products without a quantity and the context ok', async () => {
  const { knex } = contextDb({
    record: { id: 'rec-1', technician_notes: null, status: 'completed' },
    recordedProducts: [{ product_name: 'Taurus SC', application_rate: '1.6000', rate_unit: 'oz', product_id: 'p-taurus' }],
    ledgerError: new Error('boom'),
  });

  const result = await buildRecapContext(visit.id, knex);

  expect(result.ok).toBe(true);
  expect(result.existingRecord.products[0]).not.toHaveProperty('ledger_rows');
});

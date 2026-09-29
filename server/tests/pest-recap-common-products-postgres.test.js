/**
 * Real PostgreSQL: the recap context's catalog stock and its commonProducts
 * aggregate (pest-recap.js COMMON_PRODUCTS_SQL). Drives buildRecapContext
 * against a scratch schema — the completion-profile lookup is the only
 * stub on that path — so the order, limit, active-only filter, ET window,
 * usual unit and median below are the database's own answers, and
 * inventory_on_hand arrives through the real driver (numeric as a string)
 * before it is normalized.
 *
 * Self-skips without RECAP_TEST_DATABASE_URL, e.g.:
 *   RECAP_TEST_DATABASE_URL=postgresql://localhost:5432/waves_test \
 *     npx jest --runInBand tests/pest-recap-common-products-postgres.test.js
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/job-status', () => ({ transitionJobStatus: jest.fn() }));
jest.mock('../services/track-transitions', () => ({ markComplete: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/completion-recap', () => ({ generateRecap: jest.fn(), smsRecap: jest.fn() }));
jest.mock('../services/service-completion-profiles', () => ({
  resolveCompletionProfileForScheduledService: jest.fn().mockResolvedValue({ category: 'pest_control' }),
}));

const knexLib = require('knex');
const { randomUUID } = require('crypto');
const logger = require('../services/logger');
const { buildRecapContext } = require('../services/pest-recap');

const SKIP = !process.env.RECAP_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

// 10 PM ET on Sep 28 is already Sep 29 in UTC. The window is the 90 ET
// calendar days ending Sep 28: 2026-07-01 through 2026-09-28. Only Date is
// faked; the driver and the query timeout keep real timers.
const NOW = new Date('2026-09-29T02:00:00Z');
const FAKE_DATE_ONLY = {
  now: NOW,
  doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
    'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
    'setTimeout', 'clearTimeout'],
};

describeOrSkip('recap context common products on PostgreSQL', () => {
  let db;
  let schema;
  let customerId;

  beforeAll(async () => {
    const url = new URL(process.env.RECAP_TEST_DATABASE_URL);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/waves_test') {
      throw new Error('This test requires a local waves_test database');
    }
    schema = `recap_common_${randomUUID().replace(/-/g, '')}`;
    db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
    await db.raw('CREATE SCHEMA ??', [schema]);
    // Column types mirror the migrations the context and the aggregate read.
    await db.raw(`CREATE TABLE customers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      first_name text, last_name text, phone text,
      address_line1 text, address_line2 text, city text, state text, zip text
    )`);
    await db.raw(`CREATE TABLE scheduled_services (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id uuid REFERENCES customers(id),
      property_id uuid, service_id uuid,
      service_type text, status text, scheduled_date date
    )`);
    await db.raw(`CREATE TABLE job_status_history (
      job_id uuid, from_status text, to_status text, transitioned_at timestamptz
    )`);
    await db.raw(`CREATE TABLE products_catalog (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name varchar(150) NOT NULL, category varchar(50), active_ingredient text, moa_group text,
      default_rate numeric, default_unit text, rate_unit text, default_rate_per_1000 numeric,
      max_label_rate_per_1000 numeric, application_method text,
      display_name varchar(80), inventory_unit varchar(20), inventory_on_hand numeric(12, 4),
      formulation varchar(50), active boolean DEFAULT true
    )`);
    await db.raw(`CREATE TABLE service_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id uuid NOT NULL REFERENCES customers(id),
      scheduled_service_id uuid,
      service_date date NOT NULL,
      service_type varchar(100) NOT NULL,
      service_line varchar(40),
      status text DEFAULT 'completed' CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled')),
      technician_notes text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await db.raw(`CREATE TABLE service_products (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      service_record_id uuid NOT NULL REFERENCES service_records(id) ON DELETE CASCADE,
      product_id uuid REFERENCES products_catalog(id) ON DELETE SET NULL,
      product_name varchar(150) NOT NULL,
      application_rate numeric(8, 3), rate_unit varchar(20),
      total_amount numeric(8, 3), amount_unit varchar(20)
    )`);
  });

  afterAll(async () => {
    if (!db) return;
    await db.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
    await db.destroy();
  });

  beforeEach(async () => {
    logger.warn.mockClear();
    await db.raw('TRUNCATE service_products, service_records, job_status_history, scheduled_services, products_catalog, customers CASCADE');
    [{ id: customerId }] = await db('customers')
      .insert({ first_name: 'Example', last_name: 'Customer', address_line1: '100 Example Court', city: 'Example City', state: 'FL', zip: '34201' })
      .returning('id');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function product(name, extra = {}) {
    const [{ id }] = await db('products_catalog').insert({ name, category: 'Insecticide', ...extra }).returning('id');
    return id;
  }

  // One service record (a visit) carrying the given product rows.
  async function record(date, rows, { line = 'pest', status = 'completed' } = {}) {
    const [{ id }] = await db('service_records')
      .insert({ customer_id: customerId, service_date: date, service_type: 'Synthetic visit', service_line: line, status })
      .returning('id');
    await db('service_products').insert(rows.map((row) => ({
      service_record_id: id,
      product_id: row.id ?? null,
      product_name: row.name || 'Synthetic product',
      total_amount: row.amount ?? null,
      amount_unit: row.unit ?? null,
    })));
    return id;
  }

  async function visit(serviceType) {
    const [{ id }] = await db('scheduled_services')
      .insert({ customer_id: customerId, service_type: serviceType, status: 'confirmed', scheduled_date: '2026-09-28' })
      .returning('id');
    return id;
  }

  test('ranks the active products used on completed visits of the line within the ET window, with usual unit and median amount', async () => {
    const alpine = await product('Alpine WSG', { display_name: 'Alpine', inventory_unit: 'g', inventory_on_hand: 12.5, formulation: 'WSG' });
    const gentrol = await product('Gentrol IGR', { category: 'IGR' });
    const demand = await product('Demand CS', { inventory_unit: 'fl_oz', inventory_on_hand: 0 });
    const blocks = await product('Bait Station Block', { category: 'Bait' });
    const retired = await product('Retired Product', { active: false });
    const celsius = await product('Celsius WG', { category: 'Herbicide' });
    const old = await product('Old Product');
    const scheduled = await product('Scheduled Product');

    // Alpine: 5 visits, both window edges included, two of them recording
    // it twice. Units compare lower-cased and trimmed: g on 4 rows beats
    // oz on 3 → median(5, 5, 5, 6) = 5.
    await record('2026-07-01', [{ id: alpine, unit: 'g', amount: 5 }]);
    await record('2026-09-28', [{ id: alpine, unit: ' G ', amount: 6 }, { id: alpine, unit: 'G', amount: 5 }]);
    await record('2026-08-10', [{ id: alpine, unit: 'g', amount: 5 }]);
    await record('2026-08-11', [{ id: alpine, unit: 'oz', amount: 0.2 }, { id: alpine, unit: 'oz', amount: 0.2 }]);
    await record('2026-08-12', [{ id: alpine, unit: 'oz', amount: 0.2 }]);
    // Gentrol: 5 visits. oz and fl oz tie at 2 rows; oz was used more
    // recently, so it wins over the alphabetical order → median(1, 2) = 1.5.
    await record('2026-09-20', [{ id: gentrol, unit: 'oz', amount: 1 }]);
    await record('2026-09-21', [{ id: gentrol, unit: 'oz', amount: 2 }]);
    await record('2026-08-01', [{ id: gentrol, unit: 'fl_oz', amount: 0.5 }]);
    await record('2026-08-02', [{ id: gentrol, unit: 'fl_oz', amount: 0.5 }]);
    await record('2026-08-03', [{ id: gentrol }]);
    // Demand: 3 visits. A per-area rate unit is never the usual unit; fl oz
    // rows carry no positive total → usual amount null.
    await record('2026-09-01', [{ id: demand, unit: 'fl_oz' }]);
    await record('2026-09-02', [{ id: demand, unit: 'fl_oz', amount: 0 }]);
    await record('2026-09-03', [{ id: demand, unit: 'oz/1000sf', amount: 4 }, { id: demand, unit: 'oz/1000sf', amount: 4 }]);
    // Blank unit → no usual unit or amount.
    await record('2026-09-04', [{ id: blocks, unit: '  ', amount: 2 }]);

    // Never counted for pest: an inactive product, another line, outside
    // the ET window (the day before it, and the UTC-today/ET-tomorrow
    // date), a visit that is not completed, and unlinked rows. The lawn
    // amounts' median is interpolated, (0.085 + 0.09) / 2, then rounded to
    // 3 decimals.
    const lawnAmounts = [0.08, 0.08, 0.085, 0.09, 0.1, 0.1];
    for (const [i, day] of ['2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10'].entries()) {
      await record(day, [{ id: retired, unit: 'g', amount: 1 }]);
      await record(day, [{ id: celsius, unit: 'oz', amount: lawnAmounts[i] }], { line: 'lawn' });
      await record(day, [{ name: 'Taurus SC', unit: 'fl_oz', amount: 4 }]);
    }
    for (const day of ['2026-06-30', '2026-06-30', '2026-09-29', '2026-09-29', '2026-09-29', '2026-09-29']) {
      await record(day, [{ id: old, unit: 'g', amount: 1 }, { id: alpine, unit: 'oz', amount: 1 }]);
    }
    for (const status of ['scheduled', 'cancelled', 'in_progress', 'scheduled', 'cancelled', 'in_progress']) {
      await record('2026-09-15', [{ id: scheduled, unit: 'g', amount: 1 }, { id: alpine, unit: 'oz', amount: 1 }], { status });
    }

    const pestVisit = await visit('Pest Control Re-Service');
    const lawnVisit = await visit('Lawn Care Visit');
    jest.useFakeTimers(FAKE_DATE_ONLY);
    const pest = await buildRecapContext(pestVisit, db, { includeCommonProducts: true });
    const lawn = await buildRecapContext(lawnVisit, db, { includeCommonProducts: true });

    expect(logger.warn).not.toHaveBeenCalled();
    expect(pest.commonProducts).toEqual([
      { productId: alpine, visits: 5, usualUnit: 'g', usualAmount: 5 },
      { productId: gentrol, visits: 5, usualUnit: 'oz', usualAmount: 1.5 },
      { productId: demand, visits: 3, usualUnit: 'fl_oz', usualAmount: null },
      { productId: blocks, visits: 1, usualUnit: null, usualAmount: null },
    ]);
    expect(lawn.commonProducts).toEqual([
      { productId: celsius, visits: 6, usualUnit: 'oz', usualAmount: 0.088 },
    ]);

    // The catalog stays active-only, now with the label, the formulation
    // and numeric stock.
    const byId = new Map(pest.products.map((row) => [row.id, row]));
    expect(byId.has(retired)).toBe(false);
    expect(byId.get(alpine)).toMatchObject({ display_name: 'Alpine', inventory_unit: 'g', inventory_on_hand: 12.5, formulation: 'WSG' });
    expect(byId.get(demand)).toMatchObject({ display_name: null, inventory_unit: 'fl_oz', inventory_on_hand: 0 });
    expect(byId.get(gentrol)).toMatchObject({ display_name: null, inventory_unit: null, inventory_on_hand: null });
  });

  test('returns at most 8, most visits first and then by name', async () => {
    const ids = {};
    for (const name of ['Zeta', 'P10', 'P09', 'P08', 'P07', 'P06', 'P05', 'P04', 'P03', 'P02', 'P01']) {
      ids[name] = await product(name);
    }
    await record('2026-09-10', Object.values(ids).map((id) => ({ id })));
    await record('2026-09-11', [{ id: ids.Zeta }]);

    const pestVisit = await visit('Quarterly Pest Control');
    jest.useFakeTimers(FAKE_DATE_ONLY);
    const result = await buildRecapContext(pestVisit, db, { includeCommonProducts: true });

    expect(result.commonProducts.map((row) => [row.productId, row.visits])).toEqual([
      [ids.Zeta, 2],
      [ids.P01, 1], [ids.P02, 1], [ids.P03, 1], [ids.P04, 1], [ids.P05, 1], [ids.P06, 1], [ids.P07, 1],
    ]);
  });
});

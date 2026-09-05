// Opt-in PostgreSQL route regression: TEST_SCHEDULE_DB_URL must name a disposable
// local test database. Temporary tables shadow application tables; no live data.
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.fn = { now: () => db.connection.fn.now() };
  return db;
});
jest.mock('../services/estimate-deposits', () => ({ summarizeEstimateDeposit: async () => null }));
jest.mock('../services/estimate-payment-context', () => ({ buildEstimatePaymentContext: async () => null }));
jest.mock('../services/estimate-manual-acceptance', () => ({ prepayBookingEligibility: async () => ({ eligible: false }) }));

const describeWithPostgres = process.env.TEST_SCHEDULE_DB_URL ? describe : describe.skip;
describeWithPostgres('pending estimates in the appointment picker (PostgreSQL)', () => {
  let database;
  let transaction;
  let handler;
  const customerId = '00000000-0000-0000-0000-000000000001';
  beforeAll(async () => {
    const url = new URL(process.env.TEST_SCHEDULE_DB_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a disposable local test database');
    database = require('knex')({ client: 'pg', connection: url.href });
    transaction = await database.transaction();
    require('../models/db').connection = transaction;
    const router = require('../routes/admin-customers');
    handler = router.stack.find((layer) => layer.route?.path === '/:id/schedule-estimates').route.stack.at(-1).handle;
    await transaction.raw(`
      CREATE TEMP TABLE customers (id uuid, phone text, email text, deleted_at timestamptz);
      CREATE TEMP TABLE estimates (
        id integer, customer_id uuid, customer_phone text, customer_email text,
        status text, archived_at timestamptz, expires_at timestamptz, token text,
        service_interest text, estimate_data jsonb, estimate_slug text,
        monthly_total numeric, annual_total numeric, onetime_total numeric,
        waveguard_tier text, bill_by_invoice boolean, show_one_time_option boolean,
        created_at timestamptz, accepted_at timestamptz
      );
      CREATE TEMP TABLE services (
        id uuid, service_key text, name text, short_name text, category text,
        billing_type text, frequency text, visits_per_year integer,
        default_duration_minutes integer, base_price numeric, price_range_min numeric,
        price_range_max numeric, is_active boolean
      );
      CREATE TEMP TABLE scheduled_services (
        id uuid, source_estimate_id integer, scheduled_date date, window_start time,
        service_type text, status text
      );
    `);
    await transaction('customers').insert({ id: customerId, phone: '+19415550101', email: ' Picker@Example.test ' });
    const future = new Date(Date.now() + 86400000);
    const past = new Date(Date.now() - 86400000);
    const base = { status: 'sent', customer_phone: '(941) 555-0101', expires_at: future, onetime_total: 125, service_interest: 'One-Time Pest Control' };
    await transaction('estimates').insert([
      { ...base, id: 1 },
      { ...base, id: 2, status: 'viewed', customer_phone: null, customer_email: 'PICKER@example.test' },
      { ...base, id: 3, customer_id: customerId, customer_phone: null },
      { ...base, id: 4, customer_id: '00000000-0000-0000-0000-000000000002' },
      { ...base, id: 5, expires_at: past },
      { ...base, id: 6, archived_at: past },
      { ...base, id: 7, status: 'draft' },
      { ...base, id: 8, status: 'declined' },
      { ...base, id: 9, customer_phone: null, customer_email: null },
      { ...base, id: 10, customer_phone: '9415550102' },
      { ...base, id: 11, customer_id: customerId, status: 'accepted', expires_at: past },
      { ...base, id: 12, status: 'accepted' },
    ]);
  });
  afterAll(async () => { await transaction?.rollback(); await database?.destroy(); });

  async function load() {
    let payload;
    await handler({ params: { id: customerId } }, { json: (value) => { payload = value; } }, (error) => { throw error; });
    return payload.estimates;
  }
  test('returns matching sent/viewed quotes plus owned estimates, with quoted lines and prices', async () => {
    const estimates = await load();
    expect(estimates.map((row) => row.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 11]);
    expect(estimates[0].status).toBe('accepted');
    expect(estimates.find((row) => row.id === 1)).toMatchObject({
      status: 'sent', onetimeTotal: 125, lines: [expect.objectContaining({ price: 125 })],
    });
  });
  test('does not discover an unowned accepted quote through a shared contact', async () => {
    const estimates = await load();
    expect(estimates.some((row) => row.id === 12)).toBe(false);
    expect(estimates.some((row) => row.id === 11)).toBe(true);
  });
  test('missing or incomplete contact never matches blank unowned quotes', async () => {
    await transaction('customers').where({ id: customerId }).update({ phone: '0101', email: ' ' });
    expect((await load()).map((row) => row.id).sort((a, b) => a - b)).toEqual([3, 11]);
  });
});

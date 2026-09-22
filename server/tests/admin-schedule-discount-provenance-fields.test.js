/**
 * Real migrated PostgreSQL, synthetic records, rolled back after every test.
 *
 * Coordinator-approved scope extension on PR #4657 (#4654 merged, server/
 * routes/admin-schedule.js free — still not invoice.js/AdminInvoicesPage/
 * CreateAppointmentModal): the three scheduled_services GET mappers (day
 * '/', week '/week', list '/list') now project five READ-ONLY additive
 * fields — the parent row's own stored discount_type/discount_amount/
 * discount_id/discount_max_dollars, and pricingProvenance (the regime
 * marker + frozen-caps snapshot) — so the Edit appointment modal can
 * hydrate an existing appointment-level discount into its preview and
 * choose compound-vs-additive math by the row's own provenance instead of
 * guessing from the gate alone. This pins the mapper SHAPE only: the exact
 * key names, that a jsonb column round-trips as an object (never a string
 * needing JSON.parse), and that a row with no discount data reads back
 * null in every field — not that any money computation changed (it hasn't;
 * no write path reads these).
 */
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/weather-forecast', () => ({
  ...jest.requireActual('../services/weather-forecast'),
  getDailyRainOutlookBounded: jest.fn(async () => null),
}));

const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');

postgres('scheduled_services discount/provenance GET fields against migrated PostgreSQL', () => {
  let database;
  let trx;
  let customerId;
  const DATE = '2040-02-01';

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
  });

  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
    customerId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true,
      pipeline_stage: 'active_customer',
    });
  });

  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  const DISCOUNT_ID = randomUUID();
  const PROVENANCE = {
    pricing_regime: 'discount_stack_v1',
    engine_version: 1,
    caps: { line: { id: DISCOUNT_ID, cap: 15 }, addons: { [randomUUID()]: 20 } },
  };

  async function visit(overrides = {}) {
    const [row] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Quarterly Pest Control',
      service_key_snapshot: 'pest_general_quarterly', status: 'confirmed',
      scheduled_date: DATE, window_start: '08:00', window_end: '10:00',
      estimated_price: 111, ...overrides,
    }).returning('*');
    return row;
  }

  // router is required AFTER the db mock is in place (module-load order
  // matters: admin-schedule.js's own `require('../models/db')` must
  // resolve to the swappable-connection mock above).
  const router = require('../routes/admin-schedule');

  function findHandler(method, path) {
    const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }

  async function invoke(method, path, { query = {}, params = {} } = {}) {
    const handler = findHandler(method, path);
    const req = { query, params, headers: {} };
    let statusCode = 200;
    let payload = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(p) { payload = p; return this; },
    };
    let nextErr = null;
    await handler(req, res, (err) => { nextErr = err; });
    if (nextErr) throw nextErr;
    return { statusCode, payload };
  }

  function assertDiscountedRow(row) {
    expect(row.discountType).toBe('percentage');
    expect(row.discountAmount).toBe(10);
    expect(row.discountId).toBe(DISCOUNT_ID);
    expect(row.discountMaxDollars).toBe(25);
    // A jsonb column round-trips as an object through pg/knex — the mapper
    // must never need (or attempt) a JSON.parse of its own.
    expect(typeof row.pricingProvenance).toBe('object');
    expect(row.pricingProvenance).toEqual(PROVENANCE);
  }

  function assertUndiscountedRow(row) {
    expect(row.discountType).toBeNull();
    expect(row.discountAmount).toBeNull();
    expect(row.discountId).toBeNull();
    expect(row.discountMaxDollars).toBeNull();
    expect(row.pricingProvenance).toBeNull();
  }

  test('GET / (day) projects the five fields, and null when the row carries none', async () => {
    const discounted = await visit({
      discount_type: 'percentage', discount_amount: 10, discount_id: DISCOUNT_ID,
      discount_max_dollars: 25, pricing_provenance: PROVENANCE,
    });
    const plain = await visit({});
    const { statusCode, payload } = await invoke('get', '/', { query: { date: DATE } });
    expect(statusCode).toBe(200);
    assertDiscountedRow(payload.services.find((s) => s.id === discounted.id));
    assertUndiscountedRow(payload.services.find((s) => s.id === plain.id));
  });

  test('GET /week projects the five fields on the matching day, and null when the row carries none', async () => {
    const discounted = await visit({
      discount_type: 'percentage', discount_amount: 10, discount_id: DISCOUNT_ID,
      discount_max_dollars: 25, pricing_provenance: PROVENANCE,
    });
    const plain = await visit({});
    const { statusCode, payload } = await invoke('get', '/week', { query: { start: DATE } });
    expect(statusCode).toBe(200);
    const day = payload.days.find((d) => d.date === DATE);
    expect(day).toBeTruthy();
    assertDiscountedRow(day.services.find((s) => s.id === discounted.id));
    assertUndiscountedRow(day.services.find((s) => s.id === plain.id));
  });

  test('GET /list projects the five fields, and null when the row carries none', async () => {
    const discounted = await visit({
      discount_type: 'percentage', discount_amount: 10, discount_id: DISCOUNT_ID,
      discount_max_dollars: 25, pricing_provenance: PROVENANCE,
    });
    const plain = await visit({});
    const { statusCode, payload } = await invoke('get', '/list', { query: { from: DATE, to: DATE } });
    expect(statusCode).toBe(200);
    assertDiscountedRow(payload.services.find((s) => s.id === discounted.id));
    assertUndiscountedRow(payload.services.find((s) => s.id === plain.id));
  });
});

describe('scheduled_services PUT /:id/update-details — add-on discount catalog cap enforcement (Codex pre-push audit P0, round 4 on #4657) against migrated PostgreSQL', () => {
  let database;
  let trx;
  let customerId;
  let visitId;
  let discountId;

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
  });

  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
    customerId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true,
      pipeline_stage: 'active_customer',
    });
    discountId = randomUUID();
    await trx('discounts').insert({
      id: discountId, discount_key: 'capped_twenty_' + discountId.slice(0, 8), name: 'Capped Twenty', discount_type: 'percentage', amount: 20,
      max_discount_dollars: 5, is_active: true, is_auto_apply: false, show_in_invoices: true,
    });
    const [row] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Quarterly Pest Control',
      service_key_snapshot: 'pest_general_quarterly', status: 'confirmed',
      scheduled_date: '2040-02-01', window_start: '08:00', window_end: '10:00',
      estimated_price: 100, primary_line_price: 100,
    }).returning('*');
    visitId = row.id;
  });

  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  const router = require('../routes/admin-schedule');
  function findHandler(method, path) {
    const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  async function put(id, body) {
    const handler = findHandler('put', '/:id/update-details');
    const req = { params: { id }, query: {}, body, headers: {} };
    let statusCode = 200;
    let payload = null;
    const res = { status(code) { statusCode = code; return this; }, json(p) { payload = p; return this; } };
    let nextErr = null;
    await handler(req, res, (err) => { nextErr = err; });
    if (nextErr) throw nextErr;
    return { statusCode, payload };
  }

  test('a NEW 20%-off-capped-at-$5 add-on discount on an unmarked visit saves capped at $5, never the raw uncapped $20', async () => {
    const { statusCode } = await put(visitId, {
      primaryLinePrice: 100,
      addons: [{
        serviceName: 'Mosquito Add-on', basePrice: 100,
        discountType: 'percentage', discountAmount: 20, discountId, discountName: 'Capped Twenty',
      }],
    });
    expect(statusCode).toBe(200);
    const addonRow = await trx('scheduled_service_addons').where({ scheduled_service_id: visitId }).first();
    expect(addonRow).toBeTruthy();
    // Capped: $5 off a $100 line, net $95 — never the raw 20% ($20 off, net $80).
    expect(Number(addonRow.discount_dollars)).toBe(5);
    expect(Number(addonRow.estimated_price)).toBe(95);
  });
});

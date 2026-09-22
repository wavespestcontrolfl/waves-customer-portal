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

  const DISCOUNTED_OVERRIDES = {
    discount_type: 'percentage', discount_amount: 10, discount_id: DISCOUNT_ID,
    discount_max_dollars: 25, pricing_provenance: PROVENANCE,
    // :3421 (GitHub review round 2): the appointment discount's OWN scope.
    discount_service_key_filter: 'mosquito_monthly', discount_service_category_filter: null,
    // :3445: the PRIMARY line's own stored discount slot.
    line_discount_type: 'fixed_amount', line_discount_amount: 8, line_discount_id: DISCOUNT_ID,
    primary_line_price: 50,
  };

  function assertDiscountedRow(row) {
    expect(row.discountType).toBe('percentage');
    expect(row.discountAmount).toBe(10);
    expect(row.discountId).toBe(DISCOUNT_ID);
    expect(row.discountMaxDollars).toBe(25);
    // A jsonb column round-trips as an object through pg/knex — the mapper
    // must never need (or attempt) a JSON.parse of its own.
    expect(typeof row.pricingProvenance).toBe('object');
    expect(row.pricingProvenance).toEqual(PROVENANCE);
    expect(row.discountServiceKeyFilter).toBe('mosquito_monthly');
    expect(row.discountServiceCategoryFilter).toBeNull();
    expect(row.lineDiscountType).toBe('fixed_amount');
    expect(row.lineDiscountAmount).toBe(8);
    expect(row.lineDiscountId).toBe(DISCOUNT_ID);
  }

  function assertUndiscountedRow(row) {
    expect(row.discountType).toBeNull();
    expect(row.discountAmount).toBeNull();
    expect(row.discountId).toBeNull();
    expect(row.discountMaxDollars).toBeNull();
    expect(row.pricingProvenance).toBeNull();
    expect(row.discountServiceKeyFilter).toBeNull();
    expect(row.discountServiceCategoryFilter).toBeNull();
    expect(row.lineDiscountType).toBeNull();
    expect(row.lineDiscountAmount).toBeNull();
    expect(row.lineDiscountId).toBeNull();
  }

  test('GET / (day) projects every field, and null when the row carries none', async () => {
    const discounted = await visit(DISCOUNTED_OVERRIDES);
    const plain = await visit({});
    const { statusCode, payload } = await invoke('get', '/', { query: { date: DATE } });
    expect(statusCode).toBe(200);
    assertDiscountedRow(payload.services.find((s) => s.id === discounted.id));
    assertUndiscountedRow(payload.services.find((s) => s.id === plain.id));
  });

  test('GET /week projects every field on the matching day, and null when the row carries none', async () => {
    const discounted = await visit(DISCOUNTED_OVERRIDES);
    const plain = await visit({});
    const { statusCode, payload } = await invoke('get', '/week', { query: { start: DATE } });
    expect(statusCode).toBe(200);
    const day = payload.days.find((d) => d.date === DATE);
    expect(day).toBeTruthy();
    assertDiscountedRow(day.services.find((s) => s.id === discounted.id));
    assertUndiscountedRow(day.services.find((s) => s.id === plain.id));
  });

  test('GET /list projects every field, and null when the row carries none', async () => {
    const discounted = await visit(DISCOUNTED_OVERRIDES);
    const plain = await visit({});
    const { statusCode, payload } = await invoke('get', '/list', { query: { from: DATE, to: DATE } });
    expect(statusCode).toBe(200);
    assertDiscountedRow(payload.services.find((s) => s.id === discounted.id));
    assertUndiscountedRow(payload.services.find((s) => s.id === plain.id));
  });

  // :2302 (GitHub review round 2): MonthServiceChip passes the /month row
  // straight into EditServiceModal too — it must carry the SAME shape, not
  // just a display-only subset.
  test('GET /month projects every field, and null when the row carries none', async () => {
    const discounted = await visit(DISCOUNTED_OVERRIDES);
    const plain = await visit({});
    const { statusCode, payload } = await invoke('get', '/month', { query: { month: DATE.slice(0, 7) } });
    expect(statusCode).toBe(200);
    const day = payload.weeks.flat().find((d) => d.date === DATE);
    expect(day).toBeTruthy();
    const discountedRow = day.services.find((s) => s.id === discounted.id);
    assertDiscountedRow(discountedRow);
    expect(discountedRow.primaryLinePrice).toBe(50);
    assertUndiscountedRow(day.services.find((s) => s.id === plain.id));
  });
});

postgres('scheduled_services PUT /:id/update-details — add-on discount catalog cap enforcement (Codex pre-push audit P0, round 4 on #4657) against migrated PostgreSQL', () => {
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

postgres('scheduled_services PUT /:id/update-details — non-stackable stack_group enforcement (GitHub review round 2 on #4657, :2513) against migrated PostgreSQL', () => {
  let database;
  let trx;
  let customerId;
  let visitId;
  let silverId;
  let goldId;

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
    silverId = randomUUID();
    goldId = randomUUID();
    await trx('discounts').insert([
      { id: silverId, discount_key: 'wg_silver_' + silverId.slice(0, 8), name: 'WaveGuard Silver', discount_type: 'percentage', amount: 10, is_active: true, is_auto_apply: false, show_in_invoices: true, stack_group: 'tier', is_stackable: false },
      { id: goldId, discount_key: 'wg_gold_' + goldId.slice(0, 8), name: 'WaveGuard Gold', discount_type: 'percentage', amount: 15, is_active: true, is_auto_apply: false, show_in_invoices: true, stack_group: 'tier', is_stackable: false },
    ]);
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
    return { statusCode, payload, err: nextErr };
  }

  test('two FRESH same-group picks on separate lines are rejected 400', async () => {
    // The route's own catch branches on err.status/err.statusCode and
    // responds directly (res.status().json()) rather than calling next(err)
    // — httpError-thrown business-rule rejections never reach next() here.
    const { statusCode, payload } = await put(visitId, {
      primaryLinePrice: 100,
      addons: [
        { serviceName: 'Mosquito Add-on', basePrice: 50, discountType: 'percentage', discountAmount: 10, discountId: silverId, discountName: 'WaveGuard Silver' },
        { serviceName: 'Fert Add-on', basePrice: 50, discountType: 'percentage', discountAmount: 15, discountId: goldId, discountName: 'WaveGuard Gold' },
      ],
    });
    expect(statusCode).toBe(400);
    expect(payload.error).toMatch(/WaveGuard tier discount/);
  });

  test('a STORED appointment-level tier conflicts with a FRESH add-on pick in the same group — 400 (Codex pre-push audit P0, round 3 on #4657)', async () => {
    await trx('scheduled_services').where({ id: visitId }).update({ discount_id: silverId, discount_type: 'percentage', discount_amount: 10 });
    const { statusCode, payload } = await put(visitId, {
      // Appointment-level Discount control untouched this session — no
      // discountType/discountAmount posted at all, matching "leave alone".
      primaryLinePrice: 100,
      addons: [
        { serviceName: 'Fert Add-on', basePrice: 50, discountType: 'percentage', discountAmount: 15, discountId: goldId, discountName: 'WaveGuard Gold' },
      ],
    });
    expect(statusCode).toBe(400);
    expect(payload.error).toMatch(/WaveGuard tier discount/);
  });

  test('two ALREADY-PERSISTED same-group stamps are grandfathered — an unrelated resave succeeds', async () => {
    const [addon1] = await trx('scheduled_service_addons').insert({
      id: randomUUID(), scheduled_service_id: visitId, service_name: 'Mosquito Add-on',
      base_price: 50, estimated_price: 45, discount_id: silverId, discount_name: 'WaveGuard Silver',
      discount_type: 'percentage', discount_amount: 10, discount_dollars: 5,
    }).returning('*');
    const [addon2] = await trx('scheduled_service_addons').insert({
      id: randomUUID(), scheduled_service_id: visitId, service_name: 'Fert Add-on',
      base_price: 50, estimated_price: 42.5, discount_id: goldId, discount_name: 'WaveGuard Gold',
      discount_type: 'percentage', discount_amount: 15, discount_dollars: 7.5,
    }).returning('*');
    // Round-trip both lines UNCHANGED — an unrelated notes-only-style save.
    const { statusCode, err } = await put(visitId, {
      primaryLinePrice: 100,
      addons: [
        { id: addon1.id, serviceName: 'Mosquito Add-on', basePrice: 50, discountType: 'percentage', discountAmount: 10, discountId: silverId, discountName: 'WaveGuard Silver' },
        { id: addon2.id, serviceName: 'Fert Add-on', basePrice: 50, discountType: 'percentage', discountAmount: 15, discountId: goldId, discountName: 'WaveGuard Gold' },
      ],
    });
    expect(err).toBeFalsy();
    expect(statusCode).toBe(200);
  });
});

postgres('scheduled_services PUT /:id/update-details — structural round (P0 :9965, P1 :10095, P1 :2994) against migrated PostgreSQL', () => {
  let database;
  let trx;
  let customerId;
  let visitId;
  let silverId;
  let militaryId;
  let forgeableId;
  let minSubtotalId;

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
    // Every pinned scenario below is deliberately GATE-OFF (never set here)
    // — the P0 is specifically that a gate-OFF save gets zero preservation
    // coverage from legacyEconomicsPreservationDecision.
    delete process.env.GATE_DISCOUNT_STACKING;
    trx = await database.transaction();
    require('../models/db').connection = trx;
    customerId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true,
      pipeline_stage: 'active_customer', is_military: false,
    });
    silverId = randomUUID();
    militaryId = randomUUID();
    forgeableId = randomUUID();
    minSubtotalId = randomUUID();
    await trx('discounts').insert([
      {
        id: silverId, discount_key: 'wg_silver_' + silverId.slice(0, 8), name: 'WaveGuard Silver',
        discount_type: 'percentage', amount: 10, max_discount_dollars: 5, is_active: true,
        is_auto_apply: false, show_in_invoices: true, stack_group: 'tier', is_stackable: false,
      },
      {
        id: militaryId, discount_key: 'military_' + militaryId.slice(0, 8), name: 'Military Discount',
        discount_type: 'fixed_amount', amount: 10, is_active: true, is_auto_apply: false,
        show_in_invoices: true, requires_military: true,
      },
      {
        id: forgeableId, discount_key: 'small_percent_' + forgeableId.slice(0, 8), name: 'Small Percent Discount',
        discount_type: 'percentage', amount: 5, is_active: true, is_auto_apply: false, show_in_invoices: true,
      },
      {
        id: minSubtotalId, discount_key: 'min_subtotal_' + minSubtotalId.slice(0, 8), name: 'Min Subtotal Discount',
        discount_type: 'percentage', amount: 10, min_subtotal: 100, is_active: true,
        is_auto_apply: false, show_in_invoices: true,
      },
    ]);
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
    return { statusCode, payload, err: nextErr };
  }

  test('P0 :9965 — gate OFF, a notes-only resave of an UNCHANGED add-on stamp keeps its frozen $180 total, never the live-cap-clamped $195', async () => {
    const [addon] = await trx('scheduled_service_addons').insert({
      id: randomUUID(), scheduled_service_id: visitId, service_name: 'Mosquito Add-on',
      base_price: 100, estimated_price: 80, discount_id: silverId, discount_name: 'WaveGuard Silver',
      discount_type: 'percentage', discount_amount: 20, discount_dollars: 20,
    }).returning('*');
    // silverId's OWN catalog cap is $5 (see fixture above) — lower than the
    // $20 this line was originally stamped at. A notes-only resave that
    // round-trips this SAME line (same id, same discount identity/type/
    // amount) must not let that live cap silently reprice it.
    const { statusCode, err } = await put(visitId, {
      primaryLinePrice: 100,
      addons: [{
        id: addon.id, serviceName: 'Mosquito Add-on', basePrice: 100,
        discountType: 'percentage', discountAmount: 20, discountId: silverId, discountName: 'WaveGuard Silver',
      }],
    });
    expect(err).toBeFalsy();
    expect(statusCode).toBe(200);
    const addonRow = await trx('scheduled_service_addons').where({ scheduled_service_id: visitId }).first();
    expect(Number(addonRow.discount_dollars)).toBe(20);
    expect(Number(addonRow.estimated_price)).toBe(80);
    const visitRow = await trx('scheduled_services').where({ id: visitId }).first();
    expect(Number(visitRow.estimated_price)).toBe(180);
  });

  test('P1 :10095 — replacing a stored appointment-level Silver with a custom $5 discount, then picking Silver fresh on an add-on, is allowed', async () => {
    await trx('scheduled_services').where({ id: visitId })
      .update({ discount_id: silverId, discount_type: 'percentage', discount_amount: 10 });
    const { statusCode, payload, err } = await put(visitId, {
      // No discountId posted — a custom (catalog-less) discount replacing
      // the stored Silver preset.
      discountType: 'fixed_amount', discountAmount: 5,
      primaryLinePrice: 100,
      addons: [{
        serviceName: 'Mosquito Add-on', basePrice: 50, discountType: 'percentage',
        discountAmount: 10, discountId: silverId, discountName: 'WaveGuard Silver', lineDiscountFresh: true,
      }],
    });
    expect(err).toBeFalsy();
    expect(statusCode).toBe(200);
    expect(payload?.error).toBeFalsy();
  });

  test('P1 :2994 — a FRESH ineligible line discount pick is rejected 400, not silently saved', async () => {
    const { statusCode, payload } = await put(visitId, {
      primaryLinePrice: 100,
      addons: [{
        serviceName: 'Mosquito Add-on', basePrice: 50, discountType: 'fixed_amount',
        discountAmount: 10, discountId: militaryId, discountName: 'Military Discount', lineDiscountFresh: true,
      }],
    });
    expect(statusCode).toBe(400);
    expect(payload.error).toMatch(/not eligible/);
  });

  test('P1 :2994 — an UNTOUCHED stamped line discount is never re-validated, even though the customer would now fail its eligibility', async () => {
    const [addon] = await trx('scheduled_service_addons').insert({
      id: randomUUID(), scheduled_service_id: visitId, service_name: 'Mosquito Add-on',
      base_price: 50, estimated_price: 40, discount_id: militaryId, discount_name: 'Military Discount',
      discount_type: 'fixed_amount', discount_amount: 10, discount_dollars: 10,
    }).returning('*');
    // Customer is still not military (fixture default) — this stamp would
    // fail eligibility if re-checked. Round-tripped UNCHANGED, with no
    // lineDiscountFresh flag — exactly what an untouched line posts.
    const { statusCode, err } = await put(visitId, {
      primaryLinePrice: 100,
      addons: [{
        id: addon.id, serviceName: 'Mosquito Add-on', basePrice: 50, discountType: 'fixed_amount',
        discountAmount: 10, discountId: militaryId, discountName: 'Military Discount',
      }],
    });
    expect(err).toBeFalsy();
    expect(statusCode).toBe(200);
  });

  test('P1 :9413 — a fresh catalog-backed pick is resolved from the discount ROW, never a forged client-posted type/amount (no lineDiscountFresh sent, either)', async () => {
    // forgeableId is really a 5%-off discount with no eligibility
    // requirements. A caller attaches its real, active id but forges the
    // type/amount to an uncapped 90% off, and deliberately omits
    // lineDiscountFresh (the earlier partial fix's own bypass).
    const { statusCode, err } = await put(visitId, {
      primaryLinePrice: 100,
      addons: [{
        serviceName: 'Mosquito Add-on', basePrice: 100,
        discountType: 'percentage', discountAmount: 90, discountId: forgeableId, discountName: 'Small Percent Discount',
      }],
    });
    expect(err).toBeFalsy();
    expect(statusCode).toBe(200);
    const addonRow = await trx('scheduled_service_addons').where({ scheduled_service_id: visitId }).first();
    // The catalog's REAL 5% ($5 off, net $95) — never the forged 90% ($90
    // off, net $10).
    expect(Number(addonRow.discount_dollars)).toBe(5);
    expect(Number(addonRow.estimated_price)).toBe(95);
  });

  test('P2 :9631 — minimum subtotal is checked against the GROSS line amount, not the post-discount net', async () => {
    // minSubtotalId: 10% off, min_subtotal $100. A $100 gross line nets $90
    // after this discount — the OLD bug checked $90 against the $100
    // minimum and wrongly rejected a genuinely eligible boundary case.
    const { statusCode, payload, err } = await put(visitId, {
      primaryLinePrice: 100,
      addons: [{
        serviceName: 'Mosquito Add-on', basePrice: 100,
        discountType: 'percentage', discountAmount: 10, discountId: minSubtotalId, discountName: 'Min Subtotal Discount',
      }],
    });
    expect(payload?.error).toBeFalsy();
    expect(err).toBeFalsy();
    expect(statusCode).toBe(200);
    const addonRow = await trx('scheduled_service_addons').where({ scheduled_service_id: visitId }).first();
    expect(Number(addonRow.discount_dollars)).toBe(10);
    expect(Number(addonRow.estimated_price)).toBe(90);
  });
});

postgres('POST /:id/update-details/preview — dry-run parity with the real save (structural round on #4657)', () => {
  let database;
  let trx;
  let customerId;
  let visitId;

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
    delete process.env.GATE_DISCOUNT_STACKING;
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

  afterEach(async () => { if (trx) await trx.rollback(); delete process.env.GATE_DISCOUNT_STACKING; });
  afterAll(async () => { await database?.destroy(); });

  const router = require('../routes/admin-schedule');
  function findHandler(method, path) {
    const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  async function call(method, id, body) {
    const handler = findHandler(method, '/:id/update-details' + (method === 'post' ? '/preview' : ''));
    const req = { params: { id }, query: {}, body, headers: {} };
    let statusCode = 200;
    let payload = null;
    const res = { status(code) { statusCode = code; return this; }, json(p) { payload = p; return this; } };
    let nextErr = null;
    await handler(req, res, (err) => { nextErr = err; });
    return { statusCode, payload, err: nextErr };
  }
  const preview = (id, body) => call('post', id, body);
  const put = (id, body) => call('put', id, body);

  test('(a) notes-only legacy row: stored $90 kept, preview and save agree', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const [row] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Quarterly Pest Control',
      service_key_snapshot: 'pest_general_quarterly', status: 'confirmed',
      scheduled_date: '2040-02-01', window_start: '08:00', window_end: '10:00',
      estimated_price: 90, primary_line_price: 0,
    }).returning('*');
    visitId = row.id;
    const [addon] = await trx('scheduled_service_addons').insert({
      id: randomUUID(), scheduled_service_id: visitId, service_name: 'Mosquito Add-on',
      base_price: 100, estimated_price: 90, discount_type: 'percentage', discount_amount: 10, discount_dollars: 10,
    }).returning('*');
    const body = {
      primaryLinePrice: 0,
      addons: [{
        id: addon.id, serviceName: 'Mosquito Add-on', basePrice: 100,
        discountType: 'percentage', discountAmount: 10,
      }],
    };
    const previewResult = await preview(visitId, body);
    expect(previewResult.err).toBeFalsy();
    expect(previewResult.statusCode).toBe(200);
    expect(Number(previewResult.payload.total)).toBe(90);
    const saveResult = await put(visitId, body);
    expect(saveResult.err).toBeFalsy();
    expect(saveResult.statusCode).toBe(200);
    const savedRow = await trx('scheduled_services').where({ id: visitId }).first();
    expect(Number(savedRow.estimated_price)).toBe(90);
    expect(Number(previewResult.payload.total)).toBe(Number(savedRow.estimated_price));
  });

  test('(b) single-service estimatedPrice row: preview and save agree', async () => {
    const [row] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Quarterly Pest Control',
      service_key_snapshot: 'pest_general_quarterly', status: 'confirmed',
      scheduled_date: '2040-02-01', window_start: '08:00', window_end: '10:00',
      estimated_price: 50,
    }).returning('*');
    visitId = row.id;
    const body = { estimatedPrice: 100, discountType: 'fixed_amount', discountAmount: 10 };
    const previewResult = await preview(visitId, body);
    expect(previewResult.err).toBeFalsy();
    expect(previewResult.statusCode).toBe(200);
    expect(Number(previewResult.payload.total)).toBe(90);
    const saveResult = await put(visitId, body);
    expect(saveResult.err).toBeFalsy();
    expect(saveResult.statusCode).toBe(200);
    const savedRow = await trx('scheduled_services').where({ id: visitId }).first();
    expect(Number(savedRow.estimated_price)).toBe(90);
    expect(Number(previewResult.payload.total)).toBe(Number(savedRow.estimated_price));
  });

  test('(c) marked row with frozen caps: preview and save agree, restacking from the FROZEN cap not the live catalog', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const lineDiscountId = randomUUID();
    await trx('discounts').insert({
      id: lineDiscountId, discount_key: 'frozen_' + lineDiscountId.slice(0, 8), name: 'Frozen Line Discount',
      discount_type: 'percentage', amount: 20, max_discount_dollars: 5, is_active: true,
      is_auto_apply: false, show_in_invoices: true,
    });
    const [row] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Quarterly Pest Control',
      service_key_snapshot: 'pest_general_quarterly', status: 'confirmed',
      scheduled_date: '2040-02-01', window_start: '08:00', window_end: '10:00',
      estimated_price: 85, primary_line_price: 100,
      line_discount_type: 'percentage', line_discount_amount: 20, line_discount_id: lineDiscountId,
      pricing_provenance: {
        pricing_regime: 'discount_stack_v1', engine_version: 1,
        caps: { line: { id: lineDiscountId, cap: 15 }, addons: {} },
      },
    }).returning('*');
    visitId = row.id;
    const body = { primaryLinePrice: 100, addons: [] };
    const previewResult = await preview(visitId, body);
    expect(previewResult.err).toBeFalsy();
    expect(previewResult.statusCode).toBe(200);
    // Frozen cap ($15) wins over the catalog's now-lower live cap ($5, see
    // max_discount_dollars above): 100 - 15 = 85, never 100 - 5 = 95.
    expect(Number(previewResult.payload.total)).toBe(85);
    const saveResult = await put(visitId, body);
    expect(saveResult.err).toBeFalsy();
    expect(saveResult.statusCode).toBe(200);
    const savedRow = await trx('scheduled_services').where({ id: visitId }).first();
    expect(Number(savedRow.estimated_price)).toBe(85);
    expect(Number(previewResult.payload.total)).toBe(Number(savedRow.estimated_price));
  });

  test('(d) cap-lowered unmarked row: $190 kept, preview and save agree (never the live-cap-clamped $198)', async () => {
    const discountId = randomUUID();
    await trx('discounts').insert({
      id: discountId, discount_key: 'lowered_' + discountId.slice(0, 8), name: 'Lowered Cap Discount',
      discount_type: 'percentage', amount: 10, max_discount_dollars: 2, is_active: true,
      is_auto_apply: false, show_in_invoices: true,
    });
    const [row] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Quarterly Pest Control',
      service_key_snapshot: 'pest_general_quarterly', status: 'confirmed',
      scheduled_date: '2040-02-01', window_start: '08:00', window_end: '10:00',
      estimated_price: 190, primary_line_price: 100,
    }).returning('*');
    visitId = row.id;
    const [addon] = await trx('scheduled_service_addons').insert({
      id: randomUUID(), scheduled_service_id: visitId, service_name: 'Fert Add-on',
      base_price: 100, estimated_price: 90, discount_id: discountId, discount_name: 'Lowered Cap Discount',
      discount_type: 'percentage', discount_amount: 10, discount_dollars: 10,
    }).returning('*');
    const body = {
      primaryLinePrice: 100,
      addons: [{
        id: addon.id, serviceName: 'Fert Add-on', basePrice: 100,
        discountType: 'percentage', discountAmount: 10, discountId, discountName: 'Lowered Cap Discount',
      }],
    };
    const previewResult = await preview(visitId, body);
    expect(previewResult.err).toBeFalsy();
    expect(previewResult.statusCode).toBe(200);
    expect(Number(previewResult.payload.total)).toBe(190);
    const saveResult = await put(visitId, body);
    expect(saveResult.err).toBeFalsy();
    expect(saveResult.statusCode).toBe(200);
    const savedRow = await trx('scheduled_services').where({ id: visitId }).first();
    expect(Number(savedRow.estimated_price)).toBe(190);
    expect(Number(previewResult.payload.total)).toBe(Number(savedRow.estimated_price));
  });
});

postgres('round 4 on #4657 — preview must equal what the PUT persists, verbatim per line', () => {
  let database;
  let trx;
  let customerId;
  let visitId;

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
    delete process.env.GATE_DISCOUNT_STACKING;
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

  afterEach(async () => { if (trx) await trx.rollback(); delete process.env.GATE_DISCOUNT_STACKING; });
  afterAll(async () => { await database?.destroy(); });

  const router = require('../routes/admin-schedule');
  function findHandler(method, path) {
    const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  async function call(method, id, body) {
    const handler = findHandler(method, '/:id/update-details' + (method === 'post' ? '/preview' : ''));
    const req = { params: { id }, query: {}, body, headers: {} };
    let statusCode = 200;
    let payload = null;
    const res = { status(code) { statusCode = code; return this; }, json(p) { payload = p; return this; } };
    let nextErr = null;
    await handler(req, res, (err) => { nextErr = err; });
    return { statusCode, payload, err: nextErr };
  }
  const preview = (id, body) => call('post', id, body);
  const put = (id, body) => call('put', id, body);

  test(':13285 — the preview reports the CANONICAL (frozen-cap) per-line dollars, never the pre-restack figure the normalization loop alone would compute', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const discountId = randomUUID();
    await trx('discounts').insert({
      id: discountId, discount_key: 'half_off_' + discountId.slice(0, 8), name: 'Half Off',
      discount_type: 'percentage', amount: 50, max_discount_dollars: null, is_active: true,
      is_auto_apply: false, show_in_invoices: true,
    });
    const [row] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Quarterly Pest Control',
      service_key_snapshot: 'pest_general_quarterly', status: 'confirmed',
      scheduled_date: '2040-02-01', window_start: '08:00', window_end: '10:00',
      estimated_price: 100, primary_line_price: 100,
      // MARKED, with this discount's cap frozen at $2 even though the LIVE
      // catalog row above is uncapped — a fresh pick resolves against the
      // live (uncapped) cap first, then the canonical restack must clamp
      // it to the FROZEN $2.
      pricing_provenance: {
        pricing_regime: 'discount_stack_v1', engine_version: 1,
        caps: { line: null, addons: { [discountId]: 2 } },
      },
    }).returning('*');
    visitId = row.id;
    const body = {
      primaryLinePrice: 100,
      addons: [{
        serviceName: 'Mosquito Add-on', basePrice: 100,
        discountType: 'percentage', discountAmount: 50, discountId, discountName: 'Half Off',
      }],
    };
    const previewResult = await preview(visitId, body);
    expect(previewResult.err).toBeFalsy();
    expect(previewResult.statusCode).toBe(200);
    const previewAddon = previewResult.payload.addons.find((a) => a.serviceName === 'Mosquito Add-on');
    // Frozen $2 — never the live-cap (uncapped) $50 the addon-normalization
    // loop alone would have resolved before the canonical restack ran.
    expect(Number(previewAddon.discountDollars)).toBe(2);
    expect(Number(previewAddon.price)).toBe(98);
    // Primary ($100, no discount) + the addon's canonically-capped net ($98).
    expect(Number(previewResult.payload.total)).toBe(198);
    const saveResult = await put(visitId, body);
    expect(saveResult.err).toBeFalsy();
    expect(saveResult.statusCode).toBe(200);
    const savedAddon = await trx('scheduled_service_addons').where({ scheduled_service_id: visitId }).first();
    expect(Number(savedAddon.discount_dollars)).toBe(2);
    expect(Number(savedAddon.estimated_price)).toBe(98);
    expect(Number(previewAddon.discountDollars)).toBe(Number(savedAddon.discount_dollars));
    expect(Number(previewAddon.price)).toBe(Number(savedAddon.estimated_price));
  });

  test(':9542 — removing and reselecting the SAME preset after a reprice is treated as a FRESH pick (cap + eligibility enforced), not an unchanged round-trip', async () => {
    const discountId = randomUUID();
    await trx('discounts').insert({
      id: discountId, discount_key: 'twenty_capped_' + discountId.slice(0, 8), name: 'Twenty Percent Capped',
      discount_type: 'percentage', amount: 20, max_discount_dollars: 5, is_active: true,
      is_auto_apply: false, show_in_invoices: true,
    });
    const [row] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Quarterly Pest Control',
      service_key_snapshot: 'pest_general_quarterly', status: 'confirmed',
      scheduled_date: '2040-02-01', window_start: '08:00', window_end: '10:00',
      estimated_price: 200, primary_line_price: 100,
      // Unmarked.
    }).returning('*');
    visitId = row.id;
    const [addon] = await trx('scheduled_service_addons').insert({
      id: randomUUID(), scheduled_service_id: visitId, service_name: 'Mosquito Add-on',
      base_price: 100, estimated_price: 80, discount_id: discountId, discount_name: 'Twenty Percent Capped',
      discount_type: 'percentage', discount_amount: 20, discount_dollars: 20,
    }).returning('*');
    // SAME id/type/amount as stored, but the gross moved 100 -> 200 — the
    // operator removed and reselected the same preset after retyping Price.
    const body = {
      primaryLinePrice: 100,
      addons: [{
        id: addon.id, serviceName: 'Mosquito Add-on', basePrice: 200,
        discountType: 'percentage', discountAmount: 20, discountId, discountName: 'Twenty Percent Capped',
      }],
    };
    const previewResult = await preview(visitId, body);
    expect(previewResult.err).toBeFalsy();
    expect(previewResult.statusCode).toBe(200);
    const previewAddon = previewResult.payload.addons.find((a) => a.serviceName === 'Mosquito Add-on');
    // Capped at $5 (resolveLineDiscount, catalog-authoritative) — never the
    // uncapped $40 cap-unaware applyDiscount(200, 20%) would have produced.
    expect(Number(previewAddon.discountDollars)).toBe(5);
    expect(Number(previewAddon.price)).toBe(195);
    const saveResult = await put(visitId, body);
    expect(saveResult.err).toBeFalsy();
    expect(saveResult.statusCode).toBe(200);
    const savedAddon = await trx('scheduled_service_addons').where({ scheduled_service_id: visitId }).first();
    expect(Number(savedAddon.discount_dollars)).toBe(5);
    expect(Number(savedAddon.estimated_price)).toBe(195);
  });

  test(':13181 — a re-service conversion with no explicit new charge previews its saved ZERO price, never the stale carried-over total', async () => {
    let service = await trx('services').where({ service_key: 'pest_re_service' }).first();
    if (!service) {
      [service] = await trx('services').insert({
        id: randomUUID(), service_key: 'pest_re_service', name: 'Pest Re-Service',
        category: 'pest', frequency: 'as_needed', billing_type: 'one_time', visits_per_year: 0,
      }).returning('*');
    }
    await trx('customers').where({ id: customerId }).update({ waveguard_tier: 'Silver' });
    const [row] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Quarterly Pest Control',
      service_key_snapshot: 'pest_general_quarterly', status: 'confirmed',
      scheduled_date: '2040-02-01', window_start: '08:00', window_end: '10:00',
      estimated_price: 100, primary_line_price: 100, is_callback: false,
    }).returning('*');
    visitId = row.id;
    // Switches to the re-service catalog pick and echoes the SAME carried-over
    // $100 primary price — no explicit new charge typed.
    const body = { serviceId: service.id, serviceType: 'Pest Re-Service', primaryLinePrice: 100 };
    const previewResult = await preview(visitId, body);
    expect(previewResult.err).toBeFalsy();
    expect(previewResult.statusCode).toBe(200);
    expect(Number(previewResult.payload.total)).toBe(0);
    const saveResult = await put(visitId, body);
    expect(saveResult.err).toBeFalsy();
    expect(saveResult.statusCode).toBe(200);
    const savedRow = await trx('scheduled_services').where({ id: visitId }).first();
    expect(Number(savedRow.estimated_price)).toBe(0);
    expect(Number(previewResult.payload.total)).toBe(Number(savedRow.estimated_price));
  });
});

postgres('round 5 on #4657 — service-swap freshness, and a gross echo does not silently drop a stored appointment discount', () => {
  let database;
  let trx;
  let customerId;
  let visitId;

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
    delete process.env.GATE_DISCOUNT_STACKING;
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

  afterEach(async () => { if (trx) await trx.rollback(); delete process.env.GATE_DISCOUNT_STACKING; });
  afterAll(async () => { await database?.destroy(); });

  const router = require('../routes/admin-schedule');
  function findHandler(method, path) {
    const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  async function call(method, id, body) {
    const handler = findHandler(method, '/:id/update-details' + (method === 'post' ? '/preview' : ''));
    const req = { params: { id }, query: {}, body, headers: {} };
    let statusCode = 200;
    let payload = null;
    const res = { status(code) { statusCode = code; return this; }, json(p) { payload = p; return this; } };
    let nextErr = null;
    await handler(req, res, (err) => { nextErr = err; });
    return { statusCode, payload, err: nextErr };
  }
  const preview = (id, body) => call('post', id, body);
  const put = (id, body) => call('put', id, body);

  test(':9533 — a same-price, same-terms SERVICE swap on an add-on re-resolves through the catalog (scope/eligibility enforced), never round-trips as unchanged', async () => {
    const discountId = randomUUID();
    await trx('discounts').insert({
      id: discountId, discount_key: 'mosquito_only_' + discountId.slice(0, 8), name: 'Mosquito Only',
      discount_type: 'fixed_amount', amount: 10, is_active: true, is_auto_apply: false, show_in_invoices: true,
      service_key_filter: 'mosquito_monthly',
    });
    let mosquitoSvc = await trx('services').where({ service_key: 'mosquito_monthly' }).first();
    if (!mosquitoSvc) {
      [mosquitoSvc] = await trx('services').insert({
        id: randomUUID(), service_key: 'mosquito_monthly', name: 'Monthly Mosquito',
        category: 'mosquito', frequency: 'monthly', billing_type: 'recurring', visits_per_year: 12,
      }).returning('*');
    }
    let termiteSvc = await trx('services').where({ service_key: 'termite_bond' }).first();
    if (!termiteSvc) {
      [termiteSvc] = await trx('services').insert({
        id: randomUUID(), service_key: 'termite_bond', name: 'Termite Bond',
        category: 'termite', frequency: 'annual', billing_type: 'recurring', visits_per_year: 1,
      }).returning('*');
    }
    const [row] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Quarterly Pest Control',
      service_key_snapshot: 'pest_general_quarterly', status: 'confirmed',
      scheduled_date: '2040-02-01', window_start: '08:00', window_end: '10:00',
      estimated_price: 100, primary_line_price: 100,
    }).returning('*');
    visitId = row.id;
    const [addon] = await trx('scheduled_service_addons').insert({
      id: randomUUID(), scheduled_service_id: visitId, service_id: mosquitoSvc.id,
      service_name: 'Monthly Mosquito', base_price: 50, estimated_price: 40,
      discount_id: discountId, discount_name: 'Mosquito Only', discount_type: 'fixed_amount',
      discount_amount: 10, discount_dollars: 10,
    }).returning('*');
    // SAME id/type/amount, SAME $50 gross — but the line's own SERVICE swapped
    // to termite, which the Mosquito-Only preset does not reach at all.
    const body = {
      primaryLinePrice: 100,
      addons: [{
        id: addon.id, serviceId: termiteSvc.id, serviceName: 'Termite Bond', basePrice: 50,
        discountType: 'fixed_amount', discountAmount: 10, discountId, discountName: 'Mosquito Only',
      }],
    };
    // Re-resolved through resolveLineDiscount's own manualEligibilityFailures
    // (service_key_filter: mosquito_monthly, this line is now termite_bond) —
    // rejected 400, never silently round-tripped as "unchanged" with the
    // stale Mosquito-Only discount surviving on the new termite line.
    const previewResult = await preview(visitId, body);
    expect(previewResult.err).toBeFalsy();
    expect(previewResult.statusCode).toBe(400);
    expect(previewResult.payload.error).toMatch(/Mosquito Only is not eligible/);
    const saveResult = await put(visitId, body);
    expect(saveResult.statusCode).toBe(400);
    expect(saveResult.payload.error).toMatch(/Mosquito Only is not eligible/);
    // Nothing wrote — the addon row (and its stale mosquito stamp) is
    // untouched, not silently carried onto the new service.
    const unsavedAddon = await trx('scheduled_service_addons').where({ scheduled_service_id: visitId }).first();
    expect(unsavedAddon.service_id).toBe(mosquitoSvc.id);
    expect(unsavedAddon.discount_id).toBe(discountId);
  });

  test(':6083 — GATE OFF: a Month-launched notes-only save (estimatedPrice echoing the stored GROSS) preserves the stored appointment discount, never clears it', async () => {
    const [row] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Quarterly Pest Control',
      service_key_snapshot: 'pest_general_quarterly', status: 'confirmed',
      scheduled_date: '2040-02-01', window_start: '08:00', window_end: '10:00',
      // Stored: $100 gross, $10 fixed appointment discount, $90 net —
      // exactly the shape Month's own mapper now exposes.
      estimated_price: 90, primary_line_price: 100,
      discount_type: 'fixed_amount', discount_amount: 10,
    }).returning('*');
    visitId = row.id;
    // No addons array at all (a genuinely zero-add-on visit) — the
    // single-service branch. estimatedPrice echoes the STORED GROSS ($100),
    // exactly what the OLD (buggy) client seed would have sent; no
    // discountType/discountAmount posted (notes-only, control untouched).
    const body = { estimatedPrice: 100 };
    const previewResult = await preview(visitId, body);
    expect(previewResult.err).toBeFalsy();
    expect(previewResult.statusCode).toBe(200);
    // $90 (preserved) — never $100 (the gross, with the discount cleared).
    expect(Number(previewResult.payload.total)).toBe(90);
    const saveResult = await put(visitId, body);
    expect(saveResult.err).toBeFalsy();
    expect(saveResult.statusCode).toBe(200);
    const savedRow = await trx('scheduled_services').where({ id: visitId }).first();
    expect(Number(savedRow.estimated_price)).toBe(90);
    expect(savedRow.discount_type).toBe('fixed_amount');
    expect(Number(savedRow.discount_amount)).toBe(10);
    expect(Number(previewResult.payload.total)).toBe(Number(savedRow.estimated_price));
  });
});

postgres('round 6 on #4657 — a primary-service swap revalidates the stored discount, and the preview never shows a discount the same save just cleared', () => {
  let database;
  let trx;
  let customerId;

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
    delete process.env.GATE_DISCOUNT_STACKING;
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

  afterEach(async () => { if (trx) await trx.rollback(); delete process.env.GATE_DISCOUNT_STACKING; });
  afterAll(async () => { await database?.destroy(); });

  const router = require('../routes/admin-schedule');
  function findHandler(method, path) {
    const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }
  async function call(method, id, body) {
    const handler = findHandler(method, '/:id/update-details' + (method === 'post' ? '/preview' : ''));
    const req = { params: { id }, query: {}, body, headers: {} };
    let statusCode = 200;
    let payload = null;
    const res = { status(code) { statusCode = code; return this; }, json(p) { payload = p; return this; } };
    let nextErr = null;
    await handler(req, res, (err) => { nextErr = err; });
    return { statusCode, payload, err: nextErr };
  }
  const preview = (id, body) => call('post', id, body);
  const put = (id, body) => call('put', id, body);

  async function seedNoAddonVisit({ discountId, discountKey, serviceKeyFilter }) {
    let mosquitoSvc = await trx('services').where({ service_key: 'mosquito_monthly' }).first();
    if (!mosquitoSvc) {
      [mosquitoSvc] = await trx('services').insert({
        id: randomUUID(), service_key: 'mosquito_monthly', name: 'Monthly Mosquito',
        category: 'mosquito', frequency: 'monthly', billing_type: 'recurring', visits_per_year: 12,
      }).returning('*');
    }
    let termiteSvc = await trx('services').where({ service_key: 'termite_bond' }).first();
    if (!termiteSvc) {
      [termiteSvc] = await trx('services').insert({
        id: randomUUID(), service_key: 'termite_bond', name: 'Termite Bond',
        category: 'termite', frequency: 'annual', billing_type: 'recurring', visits_per_year: 1,
      }).returning('*');
    }
    await trx('discounts').insert({
      id: discountId, discount_key: discountKey, name: 'Mosquito Only',
      discount_type: 'fixed_amount', amount: 10, is_active: true, is_auto_apply: false, show_in_invoices: true,
      service_key_filter: serviceKeyFilter,
    });
    const [row] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Monthly Mosquito',
      service_id: mosquitoSvc.id, service_key_snapshot: 'mosquito_monthly',
      service_category_snapshot: 'mosquito', status: 'confirmed',
      scheduled_date: '2040-02-01', window_start: '08:00', window_end: '10:00',
      // Stored: $50 gross, $10 fixed discount, $40 net.
      estimated_price: 40, primary_line_price: 50,
      discount_type: 'fixed_amount', discount_amount: 10, discount_id: discountId,
    }).returning('*');
    return { visitId: row.id, mosquitoSvc, termiteSvc };
  }

  test(':9415 — swapping ONLY the primary service to one outside the stored discount\'s scope drops the discount instead of silently carrying it over', async () => {
    const discountId = randomUUID();
    const { visitId: id, termiteSvc } = await seedNoAddonVisit({
      discountId, discountKey: 'mosquito_only_' + discountId.slice(0, 8), serviceKeyFilter: 'mosquito_monthly',
    });
    // Price/discount echoed VERBATIM (the modal round-trips the stored
    // stamp unless the operator touches it) — only serviceId changed, to a
    // service the Mosquito-Only preset does not reach.
    const body = {
      serviceId: termiteSvc.id, estimatedPrice: 40, discountType: 'fixed_amount', discountAmount: 10, discountId,
    };
    const previewResult = await preview(id, body);
    expect(previewResult.err).toBeFalsy();
    expect(previewResult.statusCode).toBe(200);
    // Ineligible for the new service — dropped, not rejected: the full
    // $50 (undiscounted) is what this save would actually persist.
    expect(Number(previewResult.payload.total)).toBe(50);
    const saveResult = await put(id, body);
    expect(saveResult.err).toBeFalsy();
    expect(saveResult.statusCode).toBe(200);
    const savedRow = await trx('scheduled_services').where({ id }).first();
    expect(Number(savedRow.estimated_price)).toBe(50);
    expect(savedRow.discount_type).toBeNull();
    expect(savedRow.discount_amount).toBeNull();
    expect(savedRow.service_id).toBe(termiteSvc.id);
  });

  test(':9415 — swapping ONLY the primary service to one still inside the stored discount\'s scope preserves it', async () => {
    const discountId = randomUUID();
    let mosquitoSvc2 = await trx('services').where({ service_key: 'mosquito_monthly_v2' }).first();
    if (!mosquitoSvc2) {
      [mosquitoSvc2] = await trx('services').insert({
        id: randomUUID(), service_key: 'mosquito_monthly_v2', name: 'Monthly Mosquito Plus',
        category: 'mosquito', frequency: 'monthly', billing_type: 'recurring', visits_per_year: 12,
      }).returning('*');
    }
    const { visitId: id } = await seedNoAddonVisit({
      discountId, discountKey: 'mosquito_only_' + discountId.slice(0, 8), serviceKeyFilter: null,
    });
    // A preset with NO service_key_filter reaches every service — swap
    // stays eligible.
    const body = {
      serviceId: mosquitoSvc2.id, estimatedPrice: 40, discountType: 'fixed_amount', discountAmount: 10, discountId,
    };
    const previewResult = await preview(id, body);
    expect(previewResult.err).toBeFalsy();
    expect(previewResult.statusCode).toBe(200);
    expect(Number(previewResult.payload.total)).toBe(40);
    const saveResult = await put(id, body);
    expect(saveResult.err).toBeFalsy();
    expect(saveResult.statusCode).toBe(200);
    const savedRow = await trx('scheduled_services').where({ id }).first();
    expect(Number(savedRow.estimated_price)).toBe(40);
    expect(savedRow.service_id).toBe(mosquitoSvc2.id);
  });

  test(':13361 — a price change on a no-add-on visit whose primary line carries a stored line-discount stamp previews the stamp as CLEARED, matching what the PUT actually persists', async () => {
    const [row] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Quarterly Pest Control',
      service_key_snapshot: 'pest_general_quarterly', status: 'confirmed',
      scheduled_date: '2040-02-01', window_start: '08:00', window_end: '10:00',
      estimated_price: 90, primary_line_price: 100,
      // A frozen primary-line discount stamp (distinct columns from the
      // appointment-level discount_type/discount_amount above).
      line_discount_id: randomUUID(), line_discount_name: 'Legacy Primary Discount',
      line_discount_type: 'fixed_amount', line_discount_amount: 10, line_discount_dollars: 10,
    }).returning('*');
    const id = row.id;
    // A genuine price edit — no addons array — takes the single-service
    // rebase branch, which NULLS every line_discount_* column in `updates`
    // for the real PUT.
    const body = { estimatedPrice: 80 };
    const previewResult = await preview(id, body);
    expect(previewResult.err).toBeFalsy();
    expect(previewResult.statusCode).toBe(200);
    // The preview must show the cleared state, not the still-unwritten
    // stale DB row.
    expect(previewResult.payload.primaryLineDiscountDollars).toBeNull();
    expect(previewResult.payload.primaryLineDiscountName).toBeNull();
    const saveResult = await put(id, body);
    expect(saveResult.err).toBeFalsy();
    expect(saveResult.statusCode).toBe(200);
    const savedRow = await trx('scheduled_services').where({ id }).first();
    expect(savedRow.line_discount_dollars).toBeNull();
    expect(savedRow.line_discount_name).toBeNull();
  });
});

describe('scheduledServicesDiscountProvenanceColumns — fails CLOSED on a genuine introspection error (Codex pre-push audit P1, round 4 on #4657)', () => {
  // Pure unit test — no live DB needed at all: the function takes its
  // `database` handle as a plain argument, so a fake object whose own
  // columnInfo() rejects is enough to prove the contract without a real
  // Postgres connection.
  const { scheduledServicesDiscountProvenanceColumns, resetDiscountProvenanceColumnCache } = require('../routes/admin-schedule')._test;

  test('never throws, every column reads false (so the caller\'s own SELECT omits them, never a 500), and the failure is not cached', async () => {
    // The cache is a module-scope singleton this file's OWN earlier real-
    // Postgres tests already populated (successfully) — reset it so this
    // test genuinely exercises the failing introspection below, not an
    // already-cached answer from a prior call.
    resetDiscountProvenanceColumnCache();
    const failing = { scheduled_services: () => ({ columnInfo: () => Promise.reject(new Error('introspection blew up')) }) };
    const database = (table) => failing[table]();

    const present = await scheduledServicesDiscountProvenanceColumns(database);
    expect(Object.values(present).every((v) => v === false)).toBe(true);
    expect(present).toMatchObject({
      discount_type: false, discount_amount: false, discount_id: false, discount_max_dollars: false,
      discount_service_key_filter: false, discount_service_category_filter: false,
      line_discount_type: false, line_discount_amount: false, line_discount_id: false,
      line_discount_dollars: false, pricing_provenance: false,
    });

    // Uncached: a LATER, successful introspection is trusted, not stuck on
    // the earlier failure's guess.
    const recovered = { scheduled_services: () => ({ columnInfo: () => Promise.resolve({ discount_type: { type: 'varchar' } }) }) };
    const recoveredDb = (table) => recovered[table]();
    const present2 = await scheduledServicesDiscountProvenanceColumns(recoveredDb);
    expect(present2.discount_type).toBe(true);
    expect(present2.discount_amount).toBe(false);
  });
});

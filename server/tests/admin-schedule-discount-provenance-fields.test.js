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

  async function invoke(method, path, { query = {}, params = {}, techRole, technicianId } = {}) {
    const handler = findHandler(method, path);
    const req = { query, params, headers: {} };
    // Pre-push fallback audit P1 on #4657 (d17e523d73): a technician-role
    // staff token (req.techRole === 'technician', scoped to its own
    // technician_id by technicianCurrentVisitFilter) reaches every feed.
    if (techRole !== undefined) req.techRole = techRole;
    if (technicianId !== undefined) req.technicianId = technicianId;
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

  // Pre-push fallback audit P1 on #4657 (d17e523d73): the discount /
  // provenance projection exists for the admin Edit appointment modal
  // only. This router is requireTechOrAdmin, so a technician-role token
  // reaches every feed (scoped to its own visits); main's #4673 closed the
  // other technician-reachable pricing projections in this file. A
  // technician request gets NONE of these fields; an admin request is
  // unchanged (the four tests above).
  const TECH_REDACTED = [
    'discountType', 'discountAmount', 'discountId', 'discountMaxDollars',
    'discountServiceKeyFilter', 'discountServiceCategoryFilter',
    'lineDiscountType', 'lineDiscountAmount', 'lineDiscountId', 'lineDiscountDollars',
    'pricingProvenance',
  ];
  async function technicianFixture() {
    const technicianId = randomUUID();
    await trx('technicians').insert({ id: technicianId, name: 'Fixture Tech' });
    const row = await visit({ ...DISCOUNTED_OVERRIDES, technician_id: technicianId });
    return { technicianId, row };
  }
  function expectRedacted(row) {
    for (const key of TECH_REDACTED) expect(row).not.toHaveProperty(key);
  }

  test('technician: GET / (day) withholds every discount/provenance field on the technician\'s own visit; the base row still comes through', async () => {
    const { technicianId, row } = await technicianFixture();
    const { statusCode, payload } = await invoke('get', '/', { query: { date: DATE }, techRole: 'technician', technicianId });
    expect(statusCode).toBe(200);
    const found = payload.services.find((r) => r.id === row.id);
    expect(found).toBeTruthy();
    expectRedacted(found);
    expect(found.serviceType).toBeTruthy(); // the feed's normalized label — the base row itself still comes through
  });

  test('technician: GET /week withholds every discount/provenance field', async () => {
    const { technicianId, row } = await technicianFixture();
    const { statusCode, payload } = await invoke('get', '/week', { query: { start: DATE }, techRole: 'technician', technicianId });
    expect(statusCode).toBe(200);
    const day = payload.days.find((d) => d.date === DATE);
    const found = day.services.find((r) => r.id === row.id);
    expect(found).toBeTruthy();
    expectRedacted(found);
  });

  test('technician: GET /list withholds every discount/provenance field', async () => {
    const { technicianId, row } = await technicianFixture();
    const { statusCode, payload } = await invoke('get', '/list', { query: { from: DATE, to: DATE, start: DATE, end: DATE }, techRole: 'technician', technicianId });
    expect(statusCode).toBe(200);
    expect(JSON.stringify(payload)).toContain(row.id);
    expect(JSON.stringify(payload)).not.toMatch(/"pricingProvenance"|"discountMaxDollars"|"lineDiscountDollars"|"discountType"/);
  });

  test('technician: GET /month withholds the discount/provenance fields AND the two price fields this PR added to that feed', async () => {
    const { technicianId, row } = await technicianFixture();
    const { statusCode, payload } = await invoke('get', '/month', { query: { month: DATE.slice(0, 7), date: DATE, year: '2040', monthNumber: '2' }, techRole: 'technician', technicianId });
    expect(statusCode).toBe(200);
    const text = JSON.stringify(payload);
    expect(text).toContain(row.id);
    expect(text).not.toMatch(/"pricingProvenance"|"discountMaxDollars"|"lineDiscountDollars"|"discountType"|"primaryLinePrice"|"estimatedPrice"/);
  });

  test('admin (or role-less) request: the projection is unchanged — every field present', async () => {
    const row = await visit(DISCOUNTED_OVERRIDES);
    const { payload } = await invoke('get', '/', { query: { date: DATE }, techRole: 'admin' });
    assertDiscountedRow(payload.services.find((r) => r.id === row.id));
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

  // Follow-up to #4657 (owner-approved 2026-09-24): the generic row-version
  // CAS. A write to a column NO field comparator lists (internal_notes),
  // landing between the pre-transaction plan and the locked re-read, is
  // refused with 409 VISIT_CHANGED_RETRY / ROW_VERSION_DRIFT — and the same
  // save with no concurrent write commits normally.
  test('row-version CAS: a concurrent write to an UNLISTED column between the plan and the lock is refused 409; the quiet save commits', async () => {
    const realTrx = trx;
    // The route's own `db.transaction(...)` is the seam between "plan read"
    // and "locked re-read": inject the concurrent write right there.
    const injected = new Proxy(realTrx, {
      apply(target, _thisArg, args) { return target(...args); },
      get(target, prop) {
        if (prop === 'transaction') {
          return async (...args) => {
            await realTrx('scheduled_services').where({ id: visitId }).update({ internal_notes: 'written by another operator' });
            return realTrx.transaction(...args);
          };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    require('../models/db').connection = injected;
    // The retry refusal is an operational error the route hands to next()
    // (this helper rethrows it); accept a rendered 409 response too.
    let refused;
    try {
      refused = await put(visitId, { primaryLinePrice: 120, addons: [] });
    } catch (err) {
      refused = { statusCode: err.statusCode || err.status, payload: { code: err.code, reason: err.reason } };
    } finally {
      require('../models/db').connection = realTrx;
    }
    expect(refused.statusCode).toBe(409);
    expect(refused.payload.code).toBe('VISIT_CHANGED_RETRY');
    expect(refused.payload.reason).toBe('ROW_VERSION_DRIFT');
    const untouched = await realTrx('scheduled_services').where({ id: visitId }).first();
    expect(Number(untouched.estimated_price)).toBe(100); // nothing was written by the refused save

    const { statusCode } = await put(visitId, { primaryLinePrice: 120, addons: [] });
    expect(statusCode).toBe(200);
    const saved = await realTrx('scheduled_services').where({ id: visitId }).first();
    expect(Number(saved.estimated_price)).toBe(120);
  });

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

  // GitHub Codex round 11 on #4657 (P1, :10415): the conflict check's own
  // `_isNew` re-called isNewAddonDiscount WITHOUT the line's gross and
  // resolved service identity, so a grandfathered same-group stamp that
  // normalization already called FRESH (its gross changed — a reprice, or
  // a remove-and-reselect after one) was grandfathered a second time and
  // the re-applied conflicting tier persisted. The check now reuses the
  // normalized line's own discountTermChanged verdict.
  test('a grandfathered same-group stamp REPRICED on resave is a fresh pick again — 400 (GitHub round 11 P1 on #4657)', async () => {
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
    // Same Gold preset on the same line, but its gross moved $50 -> $60.
    const { statusCode, payload } = await put(visitId, {
      primaryLinePrice: 100,
      addons: [
        { id: addon1.id, serviceName: 'Mosquito Add-on', basePrice: 50, discountType: 'percentage', discountAmount: 10, discountId: silverId, discountName: 'WaveGuard Silver' },
        { id: addon2.id, serviceName: 'Fert Add-on', basePrice: 60, discountType: 'percentage', discountAmount: 15, discountId: goldId, discountName: 'WaveGuard Gold' },
      ],
    });
    expect(statusCode).toBe(400);
    expect(payload.error).toMatch(/WaveGuard tier discount/);
    const stored = await trx('scheduled_service_addons').where({ id: addon2.id }).first();
    expect(Number(stored.base_price)).toBe(50);
  });

  // Behaviour pin for the finding's own wording (appointment-level tier +
  // grandfathered add-on tier). This shape is ALSO caught by the engine's
  // own group check on the money path (discount-stack.js), so it does not
  // fail without the route fix — the two-add-on test above is the one
  // that does.
  test('a STORED appointment-level tier plus a grandfathered add-on tier stamp REPRICED on resave — 400 (GitHub round 11 P1 on #4657)', async () => {
    // A FIXED non-stackable tier credit at the appointment level: pricing
    // a stored PERCENTAGE appointment discount would need the percent-
    // exclusion catalog, which only the per-request middleware primes
    // (direct handler calls here never run it) — the conflict rule under
    // test is group-based and type-agnostic.
    const bronzeId = randomUUID();
    await trx('discounts').insert({
      id: bronzeId, discount_key: 'wg_bronze_' + bronzeId.slice(0, 8), name: 'WaveGuard Bronze Credit',
      discount_type: 'fixed_amount', amount: 5, is_active: true, is_auto_apply: false,
      show_in_invoices: true, stack_group: 'tier', is_stackable: false,
    });
    await trx('scheduled_services').where({ id: visitId }).update({
      discount_id: bronzeId, discount_type: 'fixed_amount', discount_amount: 5, discount_dollars: 5, estimated_price: 137.5,
    });
    const [addon] = await trx('scheduled_service_addons').insert({
      id: randomUUID(), scheduled_service_id: visitId, service_name: 'Fert Add-on',
      base_price: 50, estimated_price: 42.5, discount_id: goldId, discount_name: 'WaveGuard Gold',
      discount_type: 'percentage', discount_amount: 15, discount_dollars: 7.5,
    }).returning('*');
    // Unchanged round-trip: grandfathered, saves.
    const untouched = await put(visitId, {
      primaryLinePrice: 100,
      addons: [{ id: addon.id, serviceName: 'Fert Add-on', basePrice: 50, discountType: 'percentage', discountAmount: 15, discountId: goldId, discountName: 'WaveGuard Gold' }],
    });
    expect(untouched.err).toBeFalsy();
    expect(untouched.payload?.error).toBeUndefined();
    expect(untouched.statusCode).toBe(200);
    // GitHub Codex round 12 P1 (#4657, :9970): the save's own replace
    // strategy (insertScheduledServiceAddons) deletes and reinserts every
    // add-on row on EVERY successful save, so `addon.id` (captured before
    // the untouched save above) is already a STALE id — a real client
    // reloads the row after a save and edits from its fresh id, so this
    // re-reads the row's CURRENT id the same way, rather than replaying a
    // pre-save id the round-12 fix now (correctly) refuses as a
    // VISIT_CHANGED_RETRY.
    const currentAddon = await trx('scheduled_service_addons').where({ scheduled_service_id: visitId }).first();
    // Repriced: the same Gold stamp is a fresh pick against the stored Bronze.
    const repriced = await put(visitId, {
      primaryLinePrice: 100,
      addons: [{ id: currentAddon.id, serviceName: 'Fert Add-on', basePrice: 60, discountType: 'percentage', discountAmount: 15, discountId: goldId, discountName: 'WaveGuard Gold' }],
    });
    expect(repriced.statusCode).toBe(400);
    expect(repriced.payload.error).toMatch(/WaveGuard tier discount/);
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

  // GitHub Codex round 11 on #4657 (P2, :13876): an untouched zero-add-on
  // visit takes computeSingleServiceEstimatedPricePlan's no-op branch,
  // which never places discount_dollars in `updates` — the preview then
  // returned appointmentDiscountDollars null for a row that still carries
  // a persisted appointment discount, and the modal drew Subtotal $100 /
  // Total $90 with no discount line. The preview now falls back to the
  // stored figure whenever the plan leaves it alone, like the primary
  // line_discount_* fields already did.
  test('(a2) untouched zero-add-on visit with a stored appointment discount: preview returns the stored discount_dollars', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const [row] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Quarterly Pest Control',
      service_key_snapshot: 'pest_general_quarterly', status: 'confirmed',
      scheduled_date: '2040-02-01', window_start: '08:00', window_end: '10:00',
      estimated_price: 90, primary_line_price: 100,
      discount_type: 'fixed_amount', discount_amount: 10, discount_dollars: 10,
    }).returning('*');
    visitId = row.id;
    // No `addons` key at all — the client omits it for a zero-add-on
    // visit, which is what routes this save through the single-service
    // no-op branch (an `addons: []` array would take the addons branch,
    // which always restates discount_dollars itself).
    // Merged from main #4674: with primaryLinePrice present the caller
    // declares the desktop GROSS convention, so estimatedPrice is the gross
    // too — exactly what EditServiceModal posts for an untouched row (its
    // Price field is seeded from primaryLinePrice).
    const body = { estimatedPrice: 100, primaryLinePrice: 100 };
    const previewResult = await preview(visitId, body);
    expect(previewResult.err).toBeFalsy();
    expect(previewResult.statusCode).toBe(200);
    expect(Number(previewResult.payload.total)).toBe(90);
    expect(Number(previewResult.payload.appointmentDiscountDollars)).toBe(10);
    const saveResult = await put(visitId, body);
    expect(saveResult.err).toBeFalsy();
    expect(saveResult.statusCode).toBe(200);
    const savedRow = await trx('scheduled_services').where({ id: visitId }).first();
    expect(Number(savedRow.estimated_price)).toBe(90);
    expect(Number(savedRow.discount_dollars)).toBe(Number(previewResult.payload.appointmentDiscountDollars));
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

  test(':13469 — a marked row\'s PERCENTAGE primary-line discount restacks its cached dollar figure on a primary price change, and the preview shows the SAME fresh figure the PUT persists', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const lineDiscountId = randomUUID();
    await trx('discounts').insert({
      id: lineDiscountId, discount_key: 'pct10_' + lineDiscountId.slice(0, 8), name: '10% Off',
      discount_type: 'percentage', amount: 10, is_active: true, is_auto_apply: false, show_in_invoices: true,
    });
    const [row] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Quarterly Pest Control',
      service_key_snapshot: 'pest_general_quarterly', status: 'confirmed',
      scheduled_date: '2040-02-01', window_start: '08:00', window_end: '10:00',
      // Stored: $100 gross, 10% line discount = $10 cached dollars, $90 net.
      estimated_price: 90, primary_line_price: 100,
      line_discount_type: 'percentage', line_discount_amount: 10, line_discount_id: lineDiscountId,
      line_discount_dollars: 10, line_discount_name: '10% Off',
      pricing_provenance: {
        pricing_regime: 'discount_stack_v1', engine_version: 1,
        caps: { line: { id: lineDiscountId, cap: null }, addons: {} },
      },
    }).returning('*');
    visitId = row.id;
    // A genuine primary price change (100 -> 200, no addons touched) —
    // the SAME 10% recomputes to $20, not the stale cached $10.
    const body = { primaryLinePrice: 200, addons: [] };
    const previewResult = await preview(visitId, body);
    expect(previewResult.err).toBeFalsy();
    expect(previewResult.statusCode).toBe(200);
    expect(Number(previewResult.payload.total)).toBe(180);
    expect(Number(previewResult.payload.primaryLineDiscountDollars)).toBe(20);
    // The name is untouched by this restack (it's a derived-dollars-only
    // write) — the preview must still report it, not null.
    expect(previewResult.payload.primaryLineDiscountName).toBe('10% Off');
    const saveResult = await put(visitId, body);
    expect(saveResult.err).toBeFalsy();
    expect(saveResult.statusCode).toBe(200);
    const savedRow = await trx('scheduled_services').where({ id: visitId }).first();
    expect(Number(savedRow.estimated_price)).toBe(180);
    expect(Number(savedRow.line_discount_dollars)).toBe(20);
    expect(savedRow.line_discount_name).toBe('10% Off');
    expect(Number(previewResult.payload.total)).toBe(Number(savedRow.estimated_price));
    expect(Number(previewResult.payload.primaryLineDiscountDollars)).toBe(Number(savedRow.line_discount_dollars));
  });

  test(':10574 — an UNMARKED (legacy) row\'s stored primary-line discount dollars survive a genuine addons-array money edit, never silently nulled', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    const [row] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Quarterly Pest Control',
      service_key_snapshot: 'pest_general_quarterly', status: 'confirmed',
      scheduled_date: '2040-02-01', window_start: '08:00', window_end: '10:00',
      // Stored: $100 gross, a legacy $10 fixed line discount, $90 net.
      // NO pricing_provenance — this row predates the discount-stacking
      // marker entirely (the common shape for anything not resaved since).
      estimated_price: 90, primary_line_price: 100,
      line_discount_type: 'fixed_amount', line_discount_amount: 10, line_discount_id: randomUUID(),
      line_discount_dollars: 10, line_discount_name: 'Legacy $10 Off',
    }).returning('*');
    visitId = row.id;
    // A genuine, non-preserved money edit through the addons-array branch
    // (primary price actually changes, 100 -> 150) — the canonical restack
    // never runs for an unmarked row, so restackedPrimaryLineDiscountDollars
    // stays null; the fix must not write that null over the row's real
    // cached figure.
    const body = { primaryLinePrice: 150, addons: [] };
    const saveResult = await put(visitId, body);
    expect(saveResult.err).toBeFalsy();
    expect(saveResult.statusCode).toBe(200);
    const savedRow = await trx('scheduled_services').where({ id: visitId }).first();
    expect(Number(savedRow.primary_line_price)).toBe(150);
    // The stored discount stamp is untouched — this editor can't resend
    // it (pre-existing contract) — dollars included, never nulled out
    // from underneath the still-intact type/amount/id/name.
    expect(Number(savedRow.line_discount_dollars)).toBe(10);
    expect(savedRow.line_discount_type).toBe('fixed_amount');
    expect(savedRow.line_discount_name).toBe('Legacy $10 Off');
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

  // Pre-push fallback audit P1 (round 26c) control: a row with a REAL
  // service identity and a capped, scoped stored appointment discount —
  // every field the financial CAS snapshot now captures is non-null — must
  // still save a notes-only edit (the snapshot compares against the locked
  // row's own values; an unselected key would 409 every such save).
  test('round 26 CAS control — a notes-only save on a row with service_id, service snapshots and a capped, scoped stored discount is accepted (no FINANCIAL_STATE_DRIFT) and keeps its total', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    let [svc] = await trx('services').where({ service_key: 'pest_general_quarterly' });
    if (!svc) {
      [svc] = await trx('services').insert({
        id: randomUUID(), service_key: 'pest_general_quarterly', name: 'Quarterly Pest Control',
        category: 'pest', frequency: 'quarterly', billing_type: 'recurring', visits_per_year: 4,
      }).returning('*');
    }
    const discountId = randomUUID();
    await trx('discounts').insert({
      id: discountId, discount_key: 'scoped_capped_' + discountId.slice(0, 8), name: 'Scoped Capped',
      discount_type: 'fixed_amount', amount: 10, max_discount_dollars: 25, is_active: true,
      is_auto_apply: false, show_in_invoices: true, service_key_filter: 'pest_general_quarterly',
    });
    const [row] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Quarterly Pest Control',
      service_id: svc.id, service_key_snapshot: 'pest_general_quarterly', service_category_snapshot: 'pest',
      status: 'confirmed', scheduled_date: '2040-02-01', window_start: '08:00', window_end: '10:00',
      estimated_price: 140, primary_line_price: 100,
      discount_type: 'fixed_amount', discount_amount: 10, discount_dollars: 10, discount_id: discountId,
      discount_name: 'Scoped Capped', discount_max_dollars: 25,
      discount_service_key_filter: 'pest_general_quarterly', discount_service_category_filter: null,
    }).returning('*');
    visitId = row.id;
    const [addon] = await trx('scheduled_service_addons').insert({
      id: randomUUID(), scheduled_service_id: visitId, service_name: 'Mosquito Add-on',
      base_price: 50, estimated_price: 50,
    }).returning('*');
    const body = {
      notes: 'gate code 4321',
      primaryLinePrice: 100,
      addons: [{ id: addon.id, serviceName: 'Mosquito Add-on', basePrice: 50 }],
    };
    const previewResult = await preview(visitId, body);
    expect(previewResult.err).toBeFalsy();
    expect(previewResult.statusCode).toBe(200);
    const saveResult = await put(visitId, body);
    expect(saveResult.err).toBeFalsy();
    expect(saveResult.statusCode).toBe(200);
    const saved = await trx('scheduled_services').where({ id: visitId }).first();
    expect(Number(saved.estimated_price)).toBe(140);
    expect(saved.notes).toBe('gate code 4321');
    expect(String(saved.service_id)).toBe(String(svc.id));
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

  // GitHub Codex round 12 P2 (#4657, :13895): a free-callback conversion
  // zeros estimated_price/primary_line_price but, before this fix, left
  // the primary line's OWN stored discount (line_discount_dollars/_name)
  // untouched — and on a MARKED row the canonical restack just above (it
  // runs unconditionally for a marked row) had already PLANNED a fresh
  // nonzero line_discount_dollars against the visit's pre-conversion
  // total, so the free-conversion save persisted (and the preview
  // showed) a lingering discount on a $0 visit.
  test(':13895 — a free-callback conversion on a MARKED row clears the stale primary-line discount too, not just the total', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    let service = await trx('services').where({ service_key: 'pest_re_service' }).first();
    if (!service) {
      [service] = await trx('services').insert({
        id: randomUUID(), service_key: 'pest_re_service', name: 'Pest Re-Service',
        category: 'pest', frequency: 'as_needed', billing_type: 'one_time', visits_per_year: 0,
      }).returning('*');
    }
    await trx('customers').where({ id: customerId }).update({ waveguard_tier: 'Silver' });
    const lineDiscountId = randomUUID();
    const [row] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Quarterly Pest Control',
      service_key_snapshot: 'pest_general_quarterly', status: 'confirmed',
      scheduled_date: '2040-02-01', window_start: '08:00', window_end: '10:00',
      // Stored: $100 gross, 10% primary-line discount, $90 net — a
      // MARKED (canonically priced) row.
      estimated_price: 90, primary_line_price: 100, is_callback: false,
      line_discount_type: 'percentage', line_discount_amount: 10, line_discount_id: lineDiscountId,
      line_discount_dollars: 10, line_discount_name: 'Fixture 10% Primary',
      pricing_provenance: {
        pricing_regime: 'discount_stack_v1', engine_version: 1,
        caps: { line: { id: lineDiscountId, cap: null }, addons: {} },
      },
    }).returning('*');
    visitId = row.id;
    // Switches to the re-service catalog pick, echoes the stored NET
    // back (the only figure the modal has for "no change"), no add-ons.
    const body = { serviceId: service.id, serviceType: 'Pest Re-Service', primaryLinePrice: 90, addons: [] };
    const previewResult = await preview(visitId, body);
    expect(previewResult.err).toBeFalsy();
    expect(previewResult.statusCode).toBe(200);
    expect(Number(previewResult.payload.total)).toBe(0);
    // THE FIX: never the stale (or freshly re-restacked) $10 — a free
    // callback has no primary-line discount either.
    expect(previewResult.payload.primaryLineDiscountDollars).toBeNull();
    expect(previewResult.payload.primaryLineDiscountName).toBeNull();
    const saveResult = await put(visitId, body);
    expect(saveResult.err).toBeFalsy();
    expect(saveResult.statusCode).toBe(200);
    const savedRow = await trx('scheduled_services').where({ id: visitId }).first();
    expect(Number(savedRow.estimated_price)).toBe(0);
    expect(Number(savedRow.primary_line_price)).toBe(0);
    expect(savedRow.line_discount_dollars).toBeNull();
    expect(savedRow.line_discount_name).toBeNull();
    // GitHub Codex round 15 P1 (#4657, :10871): clearing only
    // dollars/name left line_discount_id/_type/_amount persisted, so
    // the hidden primary discount still read as ACTIVE to the
    // stack-group conflict check and a later canonical restack could
    // reapply it from the surviving id/type/amount. A free callback
    // must clear all five line_discount_* columns.
    expect(savedRow.line_discount_id).toBeNull();
    expect(savedRow.line_discount_type).toBeNull();
    expect(savedRow.line_discount_amount).toBeNull();
  });

  // Pre-push fallback audit P1 on #4657 (808ab6b50e): the same conversion
  // on a MARKED row whose add-on carried a CAPPED stamp planned a
  // re-frozen marker (the canonical restack runs before the zero block)
  // still holding that add-on's cap — and the primary line's — after the
  // save had removed every discount from the row. A later fresh re-pick
  // of that preset would clamp to the stale frozen cap, not the live one.
  test('fallback P1 (808ab6b50e) — a free-callback conversion on a MARKED row re-freezes the marker with NO add-on caps and NO line cap, never the pre-conversion snapshot', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    let service = await trx('services').where({ service_key: 'pest_re_service' }).first();
    if (!service) {
      [service] = await trx('services').insert({
        id: randomUUID(), service_key: 'pest_re_service', name: 'Pest Re-Service',
        category: 'pest', frequency: 'as_needed', billing_type: 'one_time', visits_per_year: 0,
      }).returning('*');
    }
    await trx('customers').where({ id: customerId }).update({ waveguard_tier: 'Silver' });
    const lineDiscountId = randomUUID();
    const addonDiscountId = randomUUID();
    await trx('discounts').insert({
      id: addonDiscountId, discount_key: `fixture_zero_${addonDiscountId.slice(0, 8)}`, name: 'Fixture 20% (cap $5)',
      discount_type: 'percentage', amount: 20, max_discount_dollars: 5, is_active: true, show_in_invoices: true,
    });
    const [row] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Quarterly Pest Control',
      service_key_snapshot: 'pest_general_quarterly', status: 'confirmed',
      scheduled_date: '2040-02-01', window_start: '08:00', window_end: '10:00',
      // Stored total = the figure the conversion classifier re-derives from
      // the echoed body (90 net primary + applyDiscount(100, 20%) = 80), so
      // the round-trip reads as "no new charge" and the free conversion fires.
      estimated_price: 170, primary_line_price: 100, is_callback: false,
      line_discount_type: 'percentage', line_discount_amount: 10, line_discount_id: lineDiscountId,
      line_discount_dollars: 10, line_discount_name: 'Fixture 10% Primary',
      pricing_provenance: {
        pricing_regime: 'discount_stack_v1', engine_version: 1,
        caps: { line: { id: lineDiscountId, cap: null }, addons: { [addonDiscountId]: 5 } },
      },
    }).returning('*');
    visitId = row.id;
    const addonRowId = randomUUID();
    await trx('scheduled_service_addons').insert({
      id: addonRowId, scheduled_service_id: visitId, service_name: 'Fixture Capped Add-On',
      base_price: 100, estimated_price: 95,
      discount_id: addonDiscountId, discount_type: 'percentage', discount_amount: 20, discount_dollars: 5,
    });
    // Converts to the re-service pick; the modal round-trips the add-on
    // and its stored stamp verbatim.
    const body = {
      serviceId: service.id, serviceType: 'Pest Re-Service', primaryLinePrice: 90,
      addons: [{
        id: addonRowId, serviceName: 'Fixture Capped Add-On', basePrice: 100,
        discountId: addonDiscountId, discountName: 'Fixture 20% (cap $5)', discountType: 'percentage', discountAmount: 20,
      }],
    };
    const saveResult = await put(visitId, body);
    expect(saveResult.err).toBeFalsy();
    expect(saveResult.statusCode).toBe(200);
    const savedRow = await trx('scheduled_services').where({ id: visitId }).first();
    expect(Number(savedRow.estimated_price)).toBe(0);
    const prov = typeof savedRow.pricing_provenance === 'string' ? JSON.parse(savedRow.pricing_provenance) : savedRow.pricing_provenance;
    // Still canonically priced (at $0) — the marker stays…
    expect(prov.pricing_regime).toBe('discount_stack_v1');
    // …but its frozen caps describe THIS row: nothing on any line.
    expect(prov.caps.addons).toEqual({});
    expect(prov.caps.line).toEqual({ id: null, cap: null });
    const savedAddon = await trx('scheduled_service_addons').where({ scheduled_service_id: visitId }).first();
    expect(Number(savedAddon.estimated_price)).toBe(0);
    expect(savedAddon.discount_id).toBeNull();
  });
});

postgres('round 12 on #4657 — collective-move date semantics mirrored in the preview (:13843)', () => {
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
    delete process.env.GATE_ADMIN_COLLECTIVE_MOVE;
    trx = await database.transaction();
    require('../models/db').connection = trx;
    customerId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true,
      pipeline_stage: 'active_customer',
      // Not yet a WaveGuard member — eligible for the Bronze-required
      // preset ONLY through the "this booking itself creates coverage"
      // floor (manualEligibilityFailures' anyMemberFloorMet), which
      // needs recurringMembershipBooking, which needs an UPCOMING date.
      waveguard_tier: null,
    });
  });

  afterEach(async () => {
    if (trx) await trx.rollback();
    delete process.env.GATE_DISCOUNT_STACKING;
    delete process.env.GATE_ADMIN_COLLECTIVE_MOVE;
  });
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

  async function seedRecurringRow(storedDate) {
    const [row] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, service_type: 'Quarterly Pest Control',
      service_key_snapshot: 'pest_general_quarterly', status: 'confirmed', is_recurring: true,
      scheduled_date: storedDate, window_start: '08:00', window_end: '10:00',
      estimated_price: 100, primary_line_price: 100,
    }).returning('*');
    return row.id;
  }

  async function seedBronzeDiscount() {
    const discountId = randomUUID();
    await trx('discounts').insert({
      id: discountId, discount_key: 'bronze_' + discountId.slice(0, 8), name: 'Any Member Discount',
      discount_type: 'fixed_amount', amount: 10, is_active: true, is_auto_apply: false, show_in_invoices: true,
      requires_waveguard_tier: 'Bronze',
    });
    return discountId;
  }

  test('a collective-move preview judges WaveGuard eligibility against the STORED (past) date, never the freshly submitted target — mirrors the save\'s own semantics', async () => {
    process.env.GATE_ADMIN_COLLECTIVE_MOVE = 'true';
    visitId = await seedRecurringRow('2020-01-01'); // stored date is in the past — NOT upcoming
    const discountId = await seedBronzeDiscount();
    const body = {
      scheduledDate: '2099-01-01', // a fresh, upcoming target — this IS a collective move (is_recurring, gate on, different date)
      primaryLinePrice: 100, addons: [], discountId,
    };
    const previewResult = await preview(visitId, body);
    // THE FIX: refused, exactly like the real save would be — the real
    // save's own planCollectiveEditDateMove strips the fresh date before
    // this SAME planner ever runs, so bookingCreatesWaveGuardCoverage
    // sees the STORED (past) date, never grants "any member" coverage
    // off it, and the Bronze-required preset fails eligibility.
    expect(previewResult.err).toBeFalsy();
    expect(previewResult.statusCode).toBe(400);
    expect(previewResult.payload.error).toMatch(/WaveGuard Bronze/);
  });

  test('scope check: the SAME preset on the SAME row is eligible when this is NOT a collective move (gate off) — the fresh submitted date is used, proving the mirroring is conditional, not a blanket regression', async () => {
    // Gate left off (deleted in beforeEach) — never a collective move,
    // so the preview must behave exactly as before this fix: the fresh
    // submitted (upcoming) date grants "any member" coverage.
    visitId = await seedRecurringRow('2020-01-01');
    const discountId = await seedBronzeDiscount();
    const body = {
      scheduledDate: '2099-01-01',
      primaryLinePrice: 100, addons: [], discountId,
    };
    const previewResult = await preview(visitId, body);
    expect(previewResult.err).toBeFalsy();
    expect(previewResult.statusCode).toBe(200);
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
    // Merged from main #4674: the value-based gross-echo backstop this test
    // originally pinned was superseded by an explicit signal — every
    // EditServiceModal save (Month-launched included) now posts
    // primaryLinePrice, and a bare estimatedPrice with no primaryLinePrice is
    // the mobile NET convention, where $100 is a genuine price change (pinned
    // the other way in update-details-discount-preserved-no-addons-mock.test.js).
    const body = { estimatedPrice: 100, primaryLinePrice: 100 };
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

postgres('round 6 on #4657 — the preview never shows a discount the same save just cleared; owner revert-and-carry pins the P0 legacy-null-gross repro', () => {
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

  // Codex pre-push audit P0 (owner revert-and-carry on #4657, this round):
  // pins the exact repro that forced the revert of the primaryServiceChanged/
  // serviceOnlyRebase rebase trigger — a LEGACY zero-add-on row whose
  // primary_line_price is NULL (never backfilled by the discount-stacking
  // migration; estimated_price is the only money column such a row has).
  // A service-only swap must NEVER re-derive a gross from this NULL column
  // and re-apply the stored discount on top of the already-net total — the
  // reverted code did exactly that ($90 -> $81). Post-revert, a
  // service-only swap on ANY row (legacy or not) takes the plain no-op
  // branch below and keeps the stored total verbatim; this test's actual
  // purpose is to ensure a future re-attempt at service-only revalidation
  // is tested against this exact legacy shape before it can ship again.
  test(':9465-p0-legacy-null-gross-double-discount — a legacy zero-add-on visit with NULL primary_line_price keeps its $90 net on a service-only swap, never re-discounts to $81', async () => {
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
      id: randomUUID(), customer_id: customerId, service_type: 'Monthly Mosquito',
      service_id: mosquitoSvc.id, service_key_snapshot: 'mosquito_monthly',
      service_category_snapshot: 'mosquito', status: 'confirmed',
      scheduled_date: '2040-02-01', window_start: '08:00', window_end: '10:00',
      // LEGACY shape: primary_line_price never backfilled (NULL) — only
      // estimated_price (the stored NET, $90) and the appointment-level
      // 10% discount exist.
      estimated_price: 90, primary_line_price: null,
      discount_type: 'percentage', discount_amount: 10,
    }).returning('*');
    const id = row.id;
    // Service-only swap: serviceId changes, Price echoes the stored NET
    // unedited (the real modal's own contract), no discount fields posted
    // at all — exactly what a genuine service-only edit sends.
    const body = { serviceId: termiteSvc.id, estimatedPrice: 90 };
    const previewResult = await preview(id, body);
    expect(previewResult.err).toBeFalsy();
    expect(previewResult.statusCode).toBe(200);
    // $90 preserved verbatim — never $81 (90 * 0.9, the double-discount
    // the reverted gross re-derivation produced on this exact shape).
    expect(Number(previewResult.payload.total)).toBe(90);
    const saveResult = await put(id, body);
    expect(saveResult.err).toBeFalsy();
    expect(saveResult.statusCode).toBe(200);
    const savedRow = await trx('scheduled_services').where({ id }).first();
    expect(Number(savedRow.estimated_price)).toBe(90);
    expect(Number(savedRow.discount_amount)).toBe(10);
    expect(savedRow.discount_type).toBe('percentage');
    expect(savedRow.service_id).toBe(termiteSvc.id);
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

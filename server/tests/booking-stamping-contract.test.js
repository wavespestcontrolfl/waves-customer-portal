/**
 * services/booking/create-scheduled-service.js — the booking stamping
 * contract. Contract under test:
 *   - validation is ungated: customer_id (slot-hold escape hatch),
 *     scheduled_date, status against the DB CHECK set, source attribution
 *   - gate OFF → no behavioral enrichment; only provenance attribution,
 *     caller values winning
 *   - gate ON → catalog-identity snapshot completion fills ONLY absent
 *     fields, never overrides, never guesses on ambiguity; a catalog QUERY
 *     error propagates (inside a trx the statement already aborted it)
 *   - createScheduledService wrapper: plain insert, and opt-in idempotency
 *     via onConflict('idempotency_key').ignore() with null on replay
 */

const mockGates = { bookingStampingContract: false };
jest.mock('../config/feature-gates', () => ({
  isEnabled: (g) => !!mockGates[g],
}));

const {
  completeScheduledServiceInsert,
  createScheduledService,
  SCHEDULED_SERVICE_STATUSES,
} = require('../services/booking/create-scheduled-service');

// Minimal knex-shaped conn: services reads resolve from `catalog`;
// scheduled_services inserts record their chain.
function makeConn(catalog = []) {
  const calls = { inserts: [], onConflict: [], ignored: 0 };
  const conn = (table) => {
    const chain = { _where: null };
    chain.where = (w) => { chain._where = w; return chain; };
    chain.whereRaw = (_sql, params) => { chain._name = params?.[0]; return chain; };
    chain.first = () => Promise.resolve(
      catalog.find((r) => r.id === chain._where?.id),
    );
    chain.select = () => Promise.resolve(
      catalog.filter((r) => r.is_active && String(r.name).toLowerCase() === String(chain._name || '').toLowerCase()),
    );
    chain.insert = (payload) => { calls.inserts.push({ table, payload }); return chain; };
    chain.onConflict = (col) => { calls.onConflict.push(col); return chain; };
    chain.ignore = () => { calls.ignored += 1; chain._ignored = true; return chain; };
    chain.returning = () => Promise.resolve(chain._ignored && conn._replay ? [] : [{ id: 'row-1', ...calls.inserts.at(-1)?.payload }]);
    return chain;
  };
  conn._calls = calls;
  return conn;
}

const COLS = {
  customer_id: {}, scheduled_date: {}, status: {}, service_type: {},
  service_id: {}, service_key_snapshot: {}, service_category_snapshot: {},
  source_action: {}, booking_source: {}, idempotency_key: {},
};

const BASE = {
  customer_id: 'cust-1',
  scheduled_date: '2026-09-15',
  status: 'pending',
  service_type: 'Quarterly Pest Control',
};

const CATALOG = [
  { id: 'svc-1', name: 'Quarterly Pest Control', service_key: 'pest_quarterly', category: 'pest', is_active: true },
  { id: 'svc-2', name: 'Lawn Care', service_key: 'lawn_care', category: 'lawn', is_active: true },
];

beforeEach(() => { mockGates.bookingStampingContract = false; });

describe('validation (ungated)', () => {
  const run = (data, opts = {}) => completeScheduledServiceInsert(data, {
    trx: makeConn(), cols: COLS, source: { sourceAction: 'test_lane' }, ...opts,
  });

  test('missing customer_id throws; allowNullCustomer admits the slot-hold shape', async () => {
    await expect(run({ ...BASE, customer_id: null })).rejects.toThrow(/customer_id/);
    await expect(run({ ...BASE, customer_id: null }, { allowNullCustomer: true })).resolves.toBeTruthy();
  });

  test('missing scheduled_date throws', async () => {
    await expect(run({ ...BASE, scheduled_date: null })).rejects.toThrow(/scheduled_date/);
  });

  test('status outside the CHECK set throws; every CHECK value passes; absent status passes (DB default)', async () => {
    await expect(run({ ...BASE, status: 'booked' })).rejects.toThrow(/CHECK set/);
    for (const status of SCHEDULED_SERVICE_STATUSES) {
      await expect(run({ ...BASE, status })).resolves.toBeTruthy();
    }
    const { status, ...noStatus } = BASE;
    await expect(run(noStatus)).resolves.toBeTruthy();
  });

  test('source attribution is required (from opts or an already-stamped payload)', async () => {
    await expect(completeScheduledServiceInsert(BASE, { trx: makeConn(), cols: COLS }))
      .rejects.toThrow(/source attribution/);
    await expect(completeScheduledServiceInsert({ ...BASE, source_action: 'legacy_lane' }, { trx: makeConn(), cols: COLS }))
      .resolves.toBeTruthy();
  });
});

describe('gate OFF — no behavioral enrichment', () => {
  test('payload passes through untouched except provenance; caller attribution wins; input not mutated', async () => {
    const input = { ...BASE };
    const out = await completeScheduledServiceInsert(input, {
      trx: makeConn(CATALOG), cols: COLS, source: { sourceAction: 'admin_ib', bookingSource: 'portal' },
    });
    expect(out).toEqual({ ...BASE, source_action: 'admin_ib', booking_source: 'portal' });
    expect(input).toEqual(BASE); // no mutation
    expect(out.service_key_snapshot).toBeUndefined(); // enrichment dark

    const stamped = await completeScheduledServiceInsert(
      { ...BASE, source_action: 'caller_says', booking_source: 'phone_call' },
      { trx: makeConn(CATALOG), cols: COLS, source: { sourceAction: 'admin_ib', bookingSource: 'portal' } },
    );
    expect(stamped.source_action).toBe('caller_says');
    expect(stamped.booking_source).toBe('phone_call');
  });
});

describe('gate ON — catalog-identity snapshot completion', () => {
  beforeEach(() => { mockGates.bookingStampingContract = true; });
  const run = (data, catalog = CATALOG) => completeScheduledServiceInsert(data, {
    trx: makeConn(catalog), cols: COLS, source: { sourceAction: 'test_lane' },
  });

  test('unique active name match fills service_id + both snapshots', async () => {
    const out = await run(BASE);
    expect(out.service_id).toBe('svc-1');
    expect(out.service_key_snapshot).toBe('pest_quarterly');
    expect(out.service_category_snapshot).toBe('pest');
  });

  test('service_id lookup wins over the name', async () => {
    const out = await run({ ...BASE, service_id: 'svc-2' });
    expect(out.service_id).toBe('svc-2');
    expect(out.service_key_snapshot).toBe('lawn_care');
    expect(out.service_category_snapshot).toBe('lawn');
  });

  test('caller-stamped snapshot fields are never overridden', async () => {
    const out = await run({ ...BASE, service_key_snapshot: 'termite_bond_1yr', service_category_snapshot: null });
    expect(out.service_key_snapshot).toBe('termite_bond_1yr');
    expect(out.service_category_snapshot).toBeNull(); // explicit null = caller's decision
  });

  test('ambiguous name → no stamp (enrichment never guesses)', async () => {
    const dupes = [...CATALOG, { id: 'svc-3', name: 'Quarterly Pest Control', service_key: 'pest_q2', category: 'pest', is_active: true }];
    const out = await run(BASE, dupes);
    expect(out.service_key_snapshot).toBeUndefined();
    expect(out.service_id).toBeUndefined();
  });

  test('catalog read failure PROPAGATES — inside a trx the statement already aborted it', async () => {
    const broken = () => { throw new Error('conn down'); };
    await expect(completeScheduledServiceInsert(BASE, {
      trx: broken, cols: COLS, source: { sourceAction: 'test_lane' },
    })).rejects.toThrow('conn down');
  });
});

describe('createScheduledService wrapper', () => {
  test('plain insert returns the created row', async () => {
    const conn = makeConn(CATALOG);
    const row = await createScheduledService({
      trx: conn, insertData: { ...BASE }, cols: COLS, source: { sourceAction: 'test_lane' },
    });
    expect(row.id).toBe('row-1');
    expect(conn._calls.inserts).toHaveLength(1);
    expect(conn._calls.onConflict).toHaveLength(0);
  });

  test('idempotencyKey stamps the column and applies onConflict-ignore; replay returns null', async () => {
    const conn = makeConn(CATALOG);
    const row = await createScheduledService({
      trx: conn, insertData: { ...BASE }, cols: COLS, source: { sourceAction: 'ai_call_pipeline' }, idempotencyKey: 'idem-1',
    });
    expect(row.idempotency_key).toBe('idem-1');
    expect(conn._calls.onConflict).toEqual(['idempotency_key']);

    const replayConn = makeConn(CATALOG);
    replayConn._replay = true;
    const replay = await createScheduledService({
      trx: replayConn, insertData: { ...BASE }, cols: COLS, source: { sourceAction: 'ai_call_pipeline' }, idempotencyKey: 'idem-1',
    });
    expect(replay).toBeNull();
  });

  test('a payload carrying a DIFFERENT idempotency key is refused', async () => {
    await expect(createScheduledService({
      trx: makeConn(),
      insertData: { ...BASE, idempotency_key: 'idem-other' },
      cols: COLS,
      source: { sourceAction: 'x' },
      idempotencyKey: 'idem-1',
    })).rejects.toThrow(/conflicts with insertData.idempotency_key/);
  });

  test('a payload already carrying the SAME idempotency key is fine', async () => {
    const conn = makeConn(CATALOG);
    const row = await createScheduledService({
      trx: conn,
      insertData: { ...BASE, idempotency_key: 'idem-1' },
      cols: COLS,
      source: { sourceAction: 'x' },
      idempotencyKey: 'idem-1',
    });
    expect(row.idempotency_key).toBe('idem-1');
  });

  test('idempotencyKey without the column throws instead of silently double-booking', async () => {
    const { idempotency_key, ...colsNoIdem } = COLS;
    await expect(createScheduledService({
      trx: makeConn(), insertData: { ...BASE }, cols: colsNoIdem, source: { sourceAction: 'x' }, idempotencyKey: 'idem-1',
    })).rejects.toThrow(/idempotency_key column/);
  });
});

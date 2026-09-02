/**
 * services/booking/create-scheduled-service.js — the booking stamping
 * contract. Contract under test:
 *   - validation is ungated: customer_id (slot-hold escape hatch),
 *     scheduled_date, source attribution — status is NOT gated here (the
 *     DB CHECK constraint is the one authority)
 *   - gate OFF → no behavioral enrichment; only provenance attribution,
 *     caller values winning
 *   - gate ON → catalog-identity snapshot completion fills ONLY missing
 *     (undefined or null) fields, never overrides a non-blank stamp, never
 *     guesses on ambiguity; a catalog QUERY
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
} = require('../services/booking/create-scheduled-service');

// Minimal knex-shaped conn: services reads resolve from `catalog` (rows
// default to live: is_active true, is_archived false); scheduled_services
// inserts record their chain.
function makeConn(rows = []) {
  const catalog = rows.map((r) => ({ is_active: true, is_archived: false, ...r }));
  const calls = { inserts: [], onConflict: [], ignored: 0 };
  const conn = (table) => {
    const chain = { _where: null };
    chain.where = (w) => { chain._where = { ...(chain._where || {}), ...w }; return chain; };
    chain.forShare = () => { calls.forShare = (calls.forShare || 0) + 1; return chain; };
    chain.whereRaw = (sql, params) => {
      if (/is_archived IS NOT TRUE/.test(sql)) chain._notArchived = true;
      else chain._names = (params || []).map((n) => String(n).toLowerCase());
      return chain;
    };
    chain.first = () => Promise.resolve(
      catalog.find((r) => r.id === chain._where?.id
        && (chain._where.is_active === undefined || r.is_active === chain._where.is_active)
        && !(chain._notArchived && r.is_archived === true)),
    );
    chain.select = () => Promise.resolve(catalog.filter((r) => {
      if (chain._where && !Object.entries(chain._where).every(([k, v]) => r[k] === v)) return false;
      if (chain._notArchived && r.is_archived === true) return false;
      if (chain._names !== undefined && !chain._names.includes(String(r.name).toLowerCase())) return false;
      return true;
    }));
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

  test('missing customer_id throws; allowNullCustomer admits ONLY the explicit hold shape', async () => {
    await expect(run({ ...BASE, customer_id: null })).rejects.toThrow(/customer_id/);
    // Explicit null + reservation expiry + estimate identity = the slot-hold shape.
    await expect(run({ ...BASE, customer_id: null, reservation_expires_at: new Date(), source_estimate_id: 'est-1' }, { allowNullCustomer: true })).resolves.toBeTruthy();
    // A hold without its estimate would be unmanaged capacity (GH Codex r17 P2).
    await expect(run({ ...BASE, customer_id: null, reservation_expires_at: new Date() }, { allowNullCustomer: true })).rejects.toThrow(/source_estimate_id/);
    await expect(run({ ...BASE, customer_id: null, reservation_expires_at: new Date(), source_estimate_id: '  ' }, { allowNullCustomer: true })).rejects.toThrow(/source_estimate_id/);
    // Merely omitted customer, or no hold marker: the hatch stays shut
    // (GH Codex r2 P2 — a permanent customer-less appointment).
    const { customer_id, ...omitted } = BASE;
    await expect(run(omitted, { allowNullCustomer: true })).rejects.toThrow(/customer_id/);
    await expect(run({ ...BASE, customer_id: null }, { allowNullCustomer: true })).rejects.toThrow(/customer_id/);
  });

  test('missing scheduled_date throws', async () => {
    await expect(run({ ...BASE, scheduled_date: null })).rejects.toThrow(/scheduled_date/);
  });

  test('status is passed through untouched — acceptance stays with the DB CHECK constraint', async () => {
    // No service-level status list: a value the CHECK set gains via a
    // future migration must not be rejected here first (GH Codex r5 P1).
    const out = await run({ ...BASE, status: 'some_future_status' });
    expect(out.status).toBe('some_future_status');
    const { status, ...noStatus } = BASE;
    const absent = await run(noStatus);
    expect(absent.status).toBeUndefined(); // DB default applies
  });

  test('a cols map without source_action fails closed (attribution has nowhere to land)', async () => {
    const { source_action, ...colsNoSource } = COLS;
    await expect(run(BASE, { cols: colsNoSource })).rejects.toThrow(/no source_action column/);
  });

  test('source attribution is required (from opts or an already-stamped payload)', async () => {
    await expect(completeScheduledServiceInsert(BASE, { trx: makeConn(), cols: COLS }))
      .rejects.toThrow(/source attribution/);
    await expect(completeScheduledServiceInsert({ ...BASE, source_action: 'legacy_lane' }, { trx: makeConn(), cols: COLS }))
      .resolves.toBeTruthy();
  });

  test('a null/blank/whitespace payload source_action is treated as absent — the supplied source stamps over it', async () => {
    for (const empty of [null, '', '   ']) {
      const out = await run({ ...BASE, source_action: empty });
      expect(out.source_action).toBe('test_lane');
    }
  });

  test('non-string attribution is refused, never coerced (GH Codex r8 P2)', async () => {
    for (const bad of [{ a: 1 }, true, 7]) {
      await expect(run(BASE, { source: { sourceAction: bad } })).rejects.toThrow(/must be a string/);
      await expect(run({ ...BASE, source_action: bad }, { source: {} })).rejects.toThrow(/must be a string/);
      await expect(run(BASE, { source: { sourceAction: 'admin_ib', bookingSource: bad } })).rejects.toThrow(/must be a string/);
      // …but a validly STAMPED payload wins before the option is even
      // looked at, so a malformed optional fallback can't reject it (r17 P2).
      const out = await run({ ...BASE, source_action: 'legacy_lane' }, { source: { sourceAction: bad } });
      expect(out.source_action).toBe('legacy_lane');
    }
  });

  test('whitespace-only attribution never satisfies the requirement nor gets stamped', async () => {
    // Trimmed on both sides (pre-push Codex r6 P1): '   ' from the option
    // is absent, and a whitespace bookingSource is not persisted.
    await expect(run(BASE, { source: { sourceAction: '   ' } })).rejects.toThrow(/source attribution/);
    await expect(run({ ...BASE, source_action: '   ' }, { source: { sourceAction: '  ' } })).rejects.toThrow(/source attribution/);
    const out = await run(BASE, { source: { sourceAction: ' admin_ib ', bookingSource: '   ' } });
    expect(out.source_action).toBe('admin_ib');
    expect(out).not.toHaveProperty('booking_source');
    // A blank PAYLOAD booking_source with nothing to stamp over it is
    // normalized to null, never persisted as '' (GH Codex r6 P2).
    for (const empty of ['', '   ']) {
      const blankPayload = await run({ ...BASE, booking_source: empty });
      expect(blankPayload.booking_source).toBeNull();
    }
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

  test('a durable service_key_snapshot outranks the mutable name (deleted-catalog-row shape)', async () => {
    // Row shape after ON DELETE SET NULL: snapshot key survives, id gone,
    // and the display name has since been reused by a DIFFERENT service.
    const catalog = [
      { id: 'svc-new', name: 'Quarterly Pest Control', service_key: 'pest_q_v2', category: 'pest', is_active: true },
      { id: 'svc-old', name: 'Quarterly Pest Control (2025)', service_key: 'pest_quarterly', category: 'pest', is_active: true },
    ];
    const out = await run({ ...BASE, service_key_snapshot: 'pest_quarterly' }, catalog);
    expect(out.service_id).toBe('svc-old'); // resolved by the snapshot key, not the name
    expect(out.service_key_snapshot).toBe('pest_quarterly'); // untouched
    expect(out.service_category_snapshot).toBe('pest');
  });

  test('a caller stamp that DISAGREES with the resolved row blocks every fill (no mixed identity)', async () => {
    // service_id → Lawn, but the caller stamped a pest key: filling the
    // category from Lawn would make a pest/lawn hybrid (pre-push Codex r9 P1).
    const out = await run({ ...BASE, service_id: 'svc-2', service_key_snapshot: 'pest_quarterly' });
    expect(out.service_id).toBe('svc-2');
    expect(out.service_key_snapshot).toBe('pest_quarterly');
    expect(out.service_category_snapshot).toBeUndefined();
    // Same for a disagreeing category with an absent key.
    const byCat = await run({ ...BASE, service_id: 'svc-2', service_category_snapshot: 'pest' });
    expect(byCat.service_key_snapshot).toBeUndefined();
    // An AGREEING stamp still lets the other field fill.
    const ok = await run({ ...BASE, service_id: 'svc-2', service_key_snapshot: 'lawn_care' });
    expect(ok.service_category_snapshot).toBe('lawn');
  });

  test('caller-stamped snapshot fields are never overridden', async () => {
    const out = await run({ ...BASE, service_key_snapshot: 'termite_bond_1yr', service_category_snapshot: null });
    expect(out.service_key_snapshot).toBe('termite_bond_1yr');
    expect(out.service_category_snapshot).toBeNull(); // no live row for that key → nothing to fill from
  });

  test('NULL snapshot fields count as missing and are filled (the fixed-shape "no identity" stamp)', async () => {
    // admin-schedule stamps both snapshots null when pricing lacks
    // identity; that row is exactly the snapshot-less one the scoped
    // discount replay throws on (GH Codex r14 P1).
    const out = await run({ ...BASE, service_id: null, service_key_snapshot: null, service_category_snapshot: null });
    expect(out.service_id).toBe('svc-1');
    expect(out.service_key_snapshot).toBe('pest_quarterly');
    expect(out.service_category_snapshot).toBe('pest');
  });

  test('inside a transaction the resolved catalog row is share-locked through the insert', async () => {
    const conn = makeConn(CATALOG);
    conn.isTransaction = true;
    await completeScheduledServiceInsert({ ...BASE, service_id: 'svc-1' }, {
      trx: conn, cols: COLS, source: { sourceAction: 'test_lane' },
    });
    expect(conn._calls.forShare).toBe(1);
  });

  test('legacy " Service"-suffixed label resolves through the alias bridge', async () => {
    const catalog = [
      { id: 'svc-p', name: 'Pest Control', service_key: 'pest_control', category: 'pest', is_active: true },
    ];
    const out = await run({ ...BASE, service_type: 'Pest Control Service' }, catalog);
    expect(out.service_id).toBe('svc-p');
    expect(out.service_key_snapshot).toBe('pest_control');
  });

  test('an archived row is never linked, and does not make a live name ambiguous', async () => {
    // archiveService flips is_active false + is_archived true together, but
    // the lookup filters on BOTH so an active-but-archived row can't be
    // stamped or shadow the live row (pre-push Codex r6 P1).
    const catalog = [
      { id: 'svc-live', name: 'Quarterly Pest Control', service_key: 'pest_quarterly', category: 'pest' },
      { id: 'svc-arch', name: 'Quarterly Pest Control', service_key: 'pest_q_old', category: 'pest', is_archived: true },
    ];
    const byName = await run(BASE, catalog);
    expect(byName.service_id).toBe('svc-live');
    const byKey = await run({ ...BASE, service_key_snapshot: 'pest_q_old' }, catalog);
    expect(byKey.service_id).toBeUndefined();
  });

  test('a caller-supplied service_id pointing at a retired row is kept, but derives no snapshot', async () => {
    // The id is the caller's stamp and is never overridden; the durable
    // key/category are withheld rather than copied from an archived or
    // inactive service (pre-push Codex r9 P1).
    for (const retired of [{ is_archived: true }, { is_active: false }]) {
      const catalog = [{ id: 'svc-old', name: 'Old Thing', service_key: 'old_thing', category: 'pest', ...retired }];
      const out = await run({ ...BASE, service_id: 'svc-old' }, catalog);
      expect(out.service_id).toBe('svc-old');
      expect(out.service_key_snapshot).toBeUndefined();
      expect(out.service_category_snapshot).toBeUndefined();
    }
  });

  test('a live row whose archive flag is NULL still links (nullable column, GH Codex r6 P2)', async () => {
    const catalog = [
      { id: 'svc-null', name: 'Quarterly Pest Control', service_key: 'pest_quarterly', category: 'pest', is_archived: null },
    ];
    const out = await run(BASE, catalog);
    expect(out.service_id).toBe('svc-null');
    const byKey = await run({ ...BASE, service_key_snapshot: 'pest_quarterly' }, catalog);
    expect(byKey.service_id).toBe('svc-null');
  });

  test('a bare legacy label resolves through the (label, cadence) map before generic expansion', async () => {
    // "Pest Control" + monthly is the Monthly plan, not the one-time
    // "Pest Control Service" the " Service" suffix would land on (GH Codex r15 P1).
    const catalog = [
      { id: 'svc-once', name: 'Pest Control Service', service_key: 'pest_once', category: 'pest' },
      { id: 'svc-month', name: 'Monthly Pest Control Service', service_key: 'pest_monthly', category: 'pest' },
      { id: 'svc-quarter', name: 'Quarterly Pest Control Service', service_key: 'pest_quarterly', category: 'pest' },
    ];
    const monthly = await run({ ...BASE, service_type: 'Pest Control', recurring_pattern: 'monthly' }, catalog);
    expect(monthly.service_id).toBe('svc-month');
    const quarterly = await run({ ...BASE, service_type: 'Pest Control', recurring_pattern: 'quarterly' }, catalog);
    expect(quarterly.service_id).toBe('svc-quarter');
    // No cadence evidence → the generic bridge, as before.
    const once = await run({ ...BASE, service_type: 'Pest Control' }, catalog);
    expect(once.service_id).toBe('svc-once');
    // The cadence-derived name goes through the alias bridge too: a catalog
    // restored by the cadence-rename migration's down() carries the
    // pre-rename spelling (GH Codex r16 P1).
    const { CADENCE_CONVENTION_RENAMES } = require('../config/service-name-aliases');
    const restored = CADENCE_CONVENTION_RENAMES.find(([, to]) => to === 'Monthly Lawn Care Service');
    expect(restored).toBeTruthy();
    const rolledBack = [{ id: 'svc-lawn-old', name: restored[0], service_key: 'lawn_monthly', category: 'lawn' }];
    const lawn = await run({ ...BASE, service_type: 'Lawn Care', recurring_pattern: 'monthly_nth_weekday' }, rolledBack);
    expect(lawn.service_id).toBe('svc-lawn-old');
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

  test('a null/blank/whitespace payload idempotency_key counts as absent — the option stamps over it', async () => {
    for (const absent of [null, '', '   ']) {
      const conn = makeConn(CATALOG);
      const row = await createScheduledService({
        trx: conn,
        insertData: { ...BASE, idempotency_key: absent },
        cols: COLS,
        source: { sourceAction: 'x' },
        idempotencyKey: 'idem-1',
      });
      expect(row.idempotency_key).toBe('idem-1');
    }
  });

  test('a padded payload key equal to the option after trimming is not a conflict', async () => {
    const row = await createScheduledService({
      trx: makeConn(CATALOG),
      insertData: { ...BASE, idempotency_key: '  idem-1 ' },
      cols: COLS,
      source: { sourceAction: 'x' },
      idempotencyKey: ' idem-1',
    });
    expect(row.idempotency_key).toBe('idem-1');
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

  test('a SUPPLIED blank idempotencyKey fails closed instead of inserting unguarded', async () => {
    for (const blank of ['', null, '   ']) {
      await expect(createScheduledService({
        trx: makeConn(), insertData: { ...BASE }, cols: COLS, source: { sourceAction: 'x' }, idempotencyKey: blank,
      })).rejects.toThrow(/blank/);
    }
  });

  test('idempotencyKey without the column throws instead of silently double-booking', async () => {
    const { idempotency_key, ...colsNoIdem } = COLS;
    await expect(createScheduledService({
      trx: makeConn(), insertData: { ...BASE }, cols: colsNoIdem, source: { sourceAction: 'x' }, idempotencyKey: 'idem-1',
    })).rejects.toThrow(/idempotency_key column/);
  });
});

// First adopter (admin-schedule POST / create parent): the contract must be a
// strict superset of today's insert — a fully stamped payload comes back
// byte-identical plus attribution, and ONLY the unlinked legacy-label shape
// (service_id absent, snapshots null — the rows that were still being
// created unlinked) gains a catalog identity, through the same
// (label, cadence) bridge series generation resolves through.
describe('admin create-parent adoption — gate ON fixtures', () => {
  beforeEach(() => { mockGates.bookingStampingContract = true; });
  const ADMIN_COLS = { source_action: true, booking_source: true, service_id: true, service_key_snapshot: true, service_category_snapshot: true };
  const ADMIN_CATALOG = [
    { id: 'svc-pq', name: 'Quarterly Pest Control Service', service_key: 'pest_general_quarterly', category: 'pest_control' },
    { id: 'svc-pm', name: 'Monthly Pest Control Service', service_key: 'pest_general_monthly', category: 'pest_control' },
    { id: 'svc-ot', name: 'One-Time Pest Control Service', service_key: 'one_time_pest_control', category: 'pest_control' },
  ];
  const run = (data) => completeScheduledServiceInsert(data, {
    trx: makeConn(ADMIN_CATALOG), cols: ADMIN_COLS, source: { sourceAction: 'admin_manual' },
  });
  const stampedAdminPayload = () => ({
    customer_id: 'cust-1', technician_id: 'tech-1', scheduled_date: '2026-09-10', window_start: '09:00', window_end: '10:00',
    service_type: 'Quarterly Pest Control Service', status: 'pending', time_window: 'morning', zone: 'N', estimated_duration_minutes: 45,
    notes: null, is_recurring: true, recurring_pattern: 'quarterly', property_id: 'prop-1',
    service_id: 'svc-pq', service_key_snapshot: 'pest_general_quarterly', service_category_snapshot: 'pest_control',
    estimated_price: 129, primary_line_price: 129, urgency: 'routine', is_callback: false, source_estimate_id: 'est-1',
    recurring_ongoing: true, recurring_nth: 2, recurring_weekday: 3, skip_weekends: true, create_invoice_on_complete: false,
    discount_id: 'd-1', discount_name: 'Spring', discount_type: 'percent', discount_amount: 10, discount_dollars: 12.9,
  });

  test('a fully stamped admin payload is returned unchanged except for attribution', async () => {
    const input = stampedAdminPayload();
    const out = await run(input);
    expect(out).toEqual({ ...input, source_action: 'admin_manual' });
  });

  test('the unlinked legacy-label shape ("Pest Control" + quarterly, snapshots null) gains the quarterly plan identity', async () => {
    const input = { ...stampedAdminPayload(), service_type: 'Pest Control', service_key_snapshot: null, service_category_snapshot: null };
    delete input.service_id;
    const out = await run(input);
    expect(out.service_id).toBe('svc-pq');
    expect(out.service_key_snapshot).toBe('pest_general_quarterly');
    expect(out.service_category_snapshot).toBe('pest_control');
    expect(out.source_action).toBe('admin_manual');
  });

  test('a bare label with no cadence evidence stays unlinked (enrichment never guesses)', async () => {
    const input = { ...stampedAdminPayload(), service_type: 'Pest Control', recurring_pattern: 'custom', service_key_snapshot: null, service_category_snapshot: null };
    delete input.service_id;
    const out = await run(input);
    expect(out.service_id).toBeUndefined();
    expect(out.service_key_snapshot).toBeNull();
    expect(out.service_category_snapshot).toBeNull();
  });
});

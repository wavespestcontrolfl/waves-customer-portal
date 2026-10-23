// ib_cancel_effect_bundles on a real PostgreSQL in a disposable schema (skipped without APP_TEST_DATABASE_URL, run for
// real in CI): the migration's shape, the transaction rollback of the bundle, and the sweep's SQL (the FOR UPDATE SKIP
// LOCKED claim, the age windows, the lease) driven end to end with the collaborators mocked. The logic is covered with
// an in-memory fake in ib-cancel-effect-bundles.test.js.
const { randomUUID } = require('node:crypto');
const knex = require('knex');
const migration = require('../models/migrations/20261023010000_ib_cancel_effect_bundles');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `ib_cancel_bundles_${randomUUID().replaceAll('-', '')}`;
const TABLE = 'ib_cancel_effect_bundles';

// The service reads ../models/db; point it at the schema-scoped connection this suite opens.
jest.mock('../models/db', () => new Proxy(function db() {}, {
  apply: (_target, _this, args) => global.__ibCancelDb(...args),
  get: (_target, prop) => {
    const value = global.__ibCancelDb[prop];
    return typeof value === 'function' ? value.bind(global.__ibCancelDb) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockFollowThrough = jest.fn(async () => ({ settled: 1 }));
jest.mock('../services/visit-cancellation-followthrough', () => ({ runVisitCancellationFollowThrough: (...a) => mockFollowThrough(...a) }));
const mockHandleCancellation = jest.fn(async (_id, opts) => { opts.outcome.notificationSent = true; });
jest.mock('../services/appointment-reminders', () => ({
  approvedCancellationNoticeStatus: async () => 'ready',
  handleCancellation: (...a) => mockHandleCancellation(...a),
}));
jest.mock('../services/messaging/send-window', () => ({ isWithinSendWindowET: () => true }));
const mockRecordResult = jest.fn(async () => true);
jest.mock('../services/intelligence-bar/pending-actions', () => ({ recordResult: (...a) => mockRecordResult(...a) }));
const mockRaise = jest.fn(async () => ({}));
jest.mock('../services/admin-alert-compose', () => ({ ...jest.requireActual('../services/admin-alert-compose'), raiseAdminAlert: (...a) => mockRaise(...a) }));

postgres('ib_cancel_effect_bundles (PostgreSQL)', () => {
  let admin;
  let app;
  let svc;
  const visit = randomUUID();
  const customer = randomUUID();

  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    app = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 6 } });
    global.__ibCancelDb = app;
    await app.schema.createTable('customers', (t) => { t.uuid('id').primary(); t.text('first_name'); t.text('last_name'); });
    await app.schema.createTable('scheduled_services', (t) => {
      t.uuid('id').primary(); t.uuid('customer_id'); t.text('status'); t.text('service_type'); t.date('scheduled_date');
    });
    await app.schema.createTable('job_status_history', (t) => {
      t.increments('id'); t.uuid('job_id'); t.text('from_status'); t.text('to_status'); t.timestamp('transitioned_at', { useTz: true });
    });
    await migration.up(app);
    svc = require('../services/ib-cancel-effect-bundles');
  });

  afterAll(async () => {
    delete global.__ibCancelDb;
    if (admin) await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (app) await app.destroy();
    if (admin) await admin.destroy();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await app(TABLE).del();
    await app('job_status_history').del();
    await app('scheduled_services').del();
    await app('customers').del();
    await app('customers').insert({ id: customer, first_name: 'Synthia', last_name: 'Tester' });
    await app('scheduled_services').insert({ id: visit, customer_id: customer, status: 'cancelled', service_type: 'Pest Control', scheduled_date: '2099-01-15' });
    await app('job_status_history').insert({ job_id: visit, from_status: 'confirmed', to_status: 'cancelled', transitioned_at: app.raw("now() - interval '40 minutes'") });
  });

  const pins = (extra = {}) => ({
    pendingActionId: randomUUID(), scheduledServiceId: visit, actorId: 'admin-1', notes: 'Cancelled via Intelligence Bar',
    notifyCustomer: true, approvedNotice: [{ recipient_key: 'abc', body: 'Your visit is cancelled.' }],
    linkedChildren: [{ id: randomUUID(), status: 'confirmed' }], approvedMoney: { invoices: [{ id: randomUUID(), total: 90 }], creditReversalOfferIds: [] },
    ...extra,
  });
  const ageBundle = (id, minutes) => app(TABLE).where({ id }).update({
    created_at: app.raw(`now() - interval '${minutes} minutes'`), lease_until: app.raw(`now() - interval '${minutes - 1} minutes'`),
  });

  test('defaults: uuid id, pending, zero attempts, a request lease, JSON round trip', async () => {
    const id = await app.transaction((trx) => svc.insertBundle(trx, pins()));
    const row = await app(TABLE).where({ id }).first();
    expect(row).toMatchObject({ status: 'pending', attempts: 0, lease_owner: 'request', notify_customer: true, finished_at: null, followthrough_done_at: null });
    expect(row.approved_notice).toEqual([{ recipient_key: 'abc', body: 'Your visit is cancelled.' }]);
    expect(row.linked_children).toHaveLength(1);
    expect(row.approved_money.invoices).toHaveLength(1);
    expect(row.lease_until.getTime()).toBeGreaterThan(Date.now() + 5 * 60 * 1000);
    expect(row.created_at).toBeInstanceOf(Date);
  });

  test('a rolled back cancel transaction leaves no bundle; a committed one leaves exactly one', async () => {
    await expect(app.transaction(async (trx) => { await svc.insertBundle(trx, pins()); throw new Error('status change failed'); })).rejects.toThrow('status change failed');
    expect(await app(TABLE).count({ n: '*' }).first()).toMatchObject({ n: '0' });
    await app.transaction((trx) => svc.insertBundle(trx, pins()));
    expect(await app(TABLE).count({ n: '*' }).first()).toMatchObject({ n: '1' });
  });

  test('one bundle per pending action; many with no pending action id; the status and attempts checks hold', async () => {
    const same = pins();
    await app.transaction((trx) => svc.insertBundle(trx, same));
    await expect(app.transaction((trx) => svc.insertBundle(trx, same))).rejects.toMatchObject({ code: '23505' });
    await app.transaction((trx) => svc.insertBundle(trx, pins({ pendingActionId: null })));
    await app.transaction((trx) => svc.insertBundle(trx, pins({ pendingActionId: null })));
    await expect(app(TABLE).where({ pending_action_id: same.pendingActionId }).update({ status: 'bogus' })).rejects.toMatchObject({ code: '23514' });
    await expect(app(TABLE).where({ pending_action_id: same.pendingActionId }).update({ attempts: -1 })).rejects.toMatchObject({ code: '23514' });
  });

  test('indexes: visit lookup, the open-work partial index and the finished partial index', async () => {
    const { rows } = await app.raw('SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = ? AND tablename = ?', [schema, TABLE]);
    const byName = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName.ib_cancel_effect_bundles_visit_idx).toMatch(/\(scheduled_service_id\)/);
    expect(byName.ib_cancel_effect_bundles_open_idx).toMatch(/\(created_at\) WHERE \(\(status\)::text = 'pending'::text\)/);
    expect(byName.ib_cancel_effect_bundles_finished_idx).toMatch(/\(finished_at\) WHERE/);
    expect(Object.values(byName).some((d) => /UNIQUE INDEX .*\(pending_action_id\)/.test(d))).toBe(true);
  });

  test('no foreign keys: nothing here can block a customer merge or delete', async () => {
    const { rows } = await app.raw("SELECT count(*)::int AS n FROM information_schema.table_constraints WHERE table_schema = ? AND table_name = ? AND constraint_type = 'FOREIGN KEY'", [schema, TABLE]);
    expect(rows[0].n).toBe(0);
  });

  test('the sweep finishes a stale bundle once, even when two sweeps start together (SKIP LOCKED + lease)', async () => {
    const id = await app.transaction((trx) => svc.insertBundle(trx, pins()));
    await ageBundle(id, 30);
    const [a, b] = await Promise.all([svc.sweepIbCancelBundles(), svc.sweepIbCancelBundles()]);
    expect(a.recovered + b.recovered).toBe(1);
    expect(mockFollowThrough).toHaveBeenCalledTimes(1);
    expect(mockHandleCancellation).toHaveBeenCalledTimes(1);
    expect(mockRaise).toHaveBeenCalledTimes(1);
    expect(await app(TABLE).where({ id }).first()).toMatchObject({ status: 'recovered', finish_note: 'sweep', lease_owner: null, attempts: 1 });
  });

  test('a bundle younger than 10 minutes, one the request completed, and one under a live lease are left alone', async () => {
    const young = await app.transaction((trx) => svc.insertBundle(trx, pins()));
    const done = await app.transaction((trx) => svc.insertBundle(trx, pins()));
    await ageBundle(done, 30);
    await app(TABLE).where({ id: done }).update({ status: 'complete', finished_at: app.fn.now() });
    const leased = await app.transaction((trx) => svc.insertBundle(trx, pins()));
    await ageBundle(leased, 30);
    await app(TABLE).where({ id: leased }).update({ lease_owner: 'other-pod', lease_until: app.raw("now() + interval '5 minutes'") });
    expect(await svc.sweepIbCancelBundles()).toMatchObject({ recovered: 0 });
    expect(mockFollowThrough).not.toHaveBeenCalled();
    expect((await app(TABLE).where({ id: young }).first()).attempts).toBe(0);
  });

  test('older than 24 hours is reported, not run; a lease that expired lets the sweep take over', async () => {
    const old = await app.transaction((trx) => svc.insertBundle(trx, pins()));
    await ageBundle(old, 25 * 60);
    const crashed = await app.transaction((trx) => svc.insertBundle(trx, pins()));
    await ageBundle(crashed, 30);
    const summary = await svc.sweepIbCancelBundles();
    expect(summary).toMatchObject({ reported: 1, recovered: 1 });
    expect(await app(TABLE).where({ id: old }).first()).toMatchObject({ status: 'expired', finish_note: 'hard_stop' });
    expect(mockFollowThrough).toHaveBeenCalledTimes(1);
  });

  test('a visit restored after the cancel is abandoned: nothing runs', async () => {
    const id = await app.transaction((trx) => svc.insertBundle(trx, pins()));
    await ageBundle(id, 30);
    await app('scheduled_services').where({ id: visit }).update({ status: 'confirmed' });
    await app('job_status_history').insert({ job_id: visit, from_status: 'cancelled', to_status: 'confirmed', transitioned_at: app.raw("now() - interval '5 minutes'") });
    expect(await svc.sweepIbCancelBundles()).toMatchObject({ abandoned: 1 });
    expect(await app(TABLE).where({ id }).first()).toMatchObject({ status: 'abandoned', finish_note: 'visit_is_confirmed' });
    expect(mockFollowThrough).not.toHaveBeenCalled();
  });

  test('down drops the table and up builds it again', async () => {
    await migration.down(app);
    expect(await app.schema.hasTable(TABLE)).toBe(false);
    await migration.up(app);
    expect(await app.schema.hasTable(TABLE)).toBe(true);
    await migration.up(app); // idempotent
  });
});

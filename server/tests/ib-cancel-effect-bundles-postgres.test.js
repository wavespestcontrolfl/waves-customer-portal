// ib_cancel_effect_bundles on a real PostgreSQL in a disposable schema (skipped without APP_TEST_DATABASE_URL, run for
// real in CI): the migration's shape, the transaction rollback of the bundle, and the sweep's SQL (the FOR UPDATE SKIP
// LOCKED claim, the age windows, the lease) driven end to end with the collaborators mocked. The logic is covered with
// an in-memory fake in ib-cancel-effect-bundles.test.js.
const { randomUUID } = require('node:crypto');
const knex = require('knex');
const migration = require('../models/migrations/20261023010000_ib_cancel_effect_bundles');
const { assertCancelGeneration } = require('../services/cancel-generation-fence');

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
let mockWindowOpen = true;
jest.mock('../services/messaging/send-window', () => ({
  isWithinSendWindowET: () => mockWindowOpen,
  nextSendWindowOpenET: () => new Date(Date.now() + 3 * 60 * 60 * 1000),
}));
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
    await app.schema.createTable('appointment_reminders', (t) => {
      t.uuid('id').primary().defaultTo(app.raw('gen_random_uuid()'));
      t.uuid('scheduled_service_id');
      t.timestamp('cancellation_notice_at', { useTz: true });
      t.text('cancellation_notice_state');
      t.boolean('cancelled').notNullable().defaultTo(false);
      t.timestamp('updated_at', { useTz: true });
    });
    await app.schema.createTable('tech_status', (t) => {
      t.uuid('id').primary().defaultTo(app.raw('gen_random_uuid()'));
      t.uuid('tech_id');
      t.uuid('current_job_id');
      t.text('status');
      t.float('lat');
      t.float('lng');
      t.timestamp('updated_at', { useTz: true });
      t.timestamp('location_updated_at', { useTz: true });
    });
    await app.schema.createTable('ib_pending_actions', (t) => { t.uuid('id').primary(); t.jsonb('result'); t.timestamp('updated_at', { useTz: true }); });
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
    mockWindowOpen = true;
    await app(TABLE).del();
    await app('job_status_history').del();
    await app('scheduled_services').del();
    await app('appointment_reminders').del();
    await app('tech_status').del();
    await app('customers').del();
    await app('ib_pending_actions').del();
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

  test('a restore landing after the last write-level fence (no text step) is caught by the terminal transaction: abandoned, not recovered', async () => {
    const id = await app.transaction((trx) => svc.insertBundle(trx, pins({ notifyCustomer: false, approvedNotice: null, linkedChildren: [], approvedMoney: {} })));
    await ageBundle(id, 30);
    mockFollowThrough.mockImplementationOnce(async () => {
      await app('scheduled_services').where({ id: visit }).update({ status: 'confirmed' });
      await app('job_status_history').insert({ job_id: visit, from_status: 'cancelled', to_status: 'confirmed', transitioned_at: app.fn.now() });
    });
    expect(await svc.sweepIbCancelBundles()).toMatchObject({ abandoned: 1, recovered: 0 });
    expect(await app(TABLE).where({ id }).first()).toMatchObject({ status: 'abandoned' });
  });

  test('a restore IN FLIGHT (visit row locked, uncommitted) at the terminal proof fails at once and keeps the bundle pending', async () => {
    const id = await app.transaction((trx) => svc.insertBundle(trx, pins({ notifyCustomer: false, approvedNotice: null, linkedChildren: [], approvedMoney: {} })));
    await ageBundle(id, 30);
    const restoring = await app.transaction();
    try {
      mockFollowThrough.mockImplementationOnce(async () => { await restoring('scheduled_services').where({ id: visit }).update({ status: 'confirmed' }); });
      const summary = await svc.sweepIbCancelBundles();
      expect(summary).toMatchObject({ failed: 1, recovered: 0, abandoned: 0 });
      expect(await app(TABLE).where({ id }).first()).toMatchObject({ status: 'pending', lease_owner: null });
    } finally {
      await restoring.rollback();
    }
    // The restore never committed: the retry finishes.
    await app(TABLE).where({ id }).update({ lease_until: null, next_attempt_at: null });
    expect(await svc.sweepIbCancelBundles()).toMatchObject({ recovered: 1 });
  });

  test('an exhausted bundle on a restored visit is abandoned, not expired; a restore in flight at the expired write keeps it pending', async () => {
    const restoredId = await app.transaction((trx) => svc.insertBundle(trx, pins()));
    await app(TABLE).where({ id: restoredId }).update({ attempts: 5, lease_owner: null, lease_until: null, created_at: app.raw("now() - interval '3 hours'") });
    await app('scheduled_services').where({ id: visit }).update({ status: 'confirmed' });
    await app('job_status_history').insert({ job_id: visit, from_status: 'cancelled', to_status: 'confirmed', transitioned_at: app.fn.now() });
    expect(await svc.sweepIbCancelBundles()).toMatchObject({ abandoned: 1, reported: 0 });
    expect(await app(TABLE).where({ id: restoredId }).first()).toMatchObject({ status: 'abandoned' });
    // Back to a cancelled visit (a new generation), and a fresh exhausted bundle for it.
    await app('scheduled_services').where({ id: visit }).update({ status: 'cancelled' });
    await app('job_status_history').insert({ job_id: visit, from_status: 'confirmed', to_status: 'cancelled', transitioned_at: app.fn.now() });
    const busyId = await app.transaction((trx) => svc.insertBundle(trx, pins()));
    await app(TABLE).where({ id: busyId }).update({ attempts: 5, lease_owner: null, lease_until: null, created_at: app.raw("now() - interval '3 hours'") });
    const restoring = await app.transaction();
    try {
      await restoring('scheduled_services').where({ id: visit }).update({ status: 'confirmed' });
      expect(await svc.sweepIbCancelBundles()).toMatchObject({ failed: 1, reported: 0 });
      expect(await app(TABLE).where({ id: busyId }).first()).toMatchObject({ status: 'pending', lease_owner: null });
    } finally {
      await restoring.rollback();
    }
    expect(await svc.sweepIbCancelBundles()).toMatchObject({ reported: 1 });
    expect(await app(TABLE).where({ id: busyId }).first()).toMatchObject({ status: 'expired', finish_note: 'attempts_exhausted' });
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


  // ── The cancellation-generation fence, on real row locks ────────────────────────────────────────────────────
  describe('cancel generation fence', () => {
    const fenceFor = (restorations = 0) => ({ visitId: visit, restorations, hits: [] });
    const restore = (conn) => conn('scheduled_services').where({ id: visit }).update({ status: 'confirmed' });
    const recancel = async () => {
      await app('scheduled_services').where({ id: visit }).update({ status: 'cancelled' });
      await app('job_status_history').insert({ job_id: visit, from_status: 'confirmed', to_status: 'cancelled', transitioned_at: app.fn.now() });
    };

    test('a standing cancel passes; the share lock is held only for the transaction', async () => {
      const fence = fenceFor();
      await app.transaction((trx) => assertCancelGeneration(trx, fence));
      expect(fence.hits).toEqual([]);
    });

    test('a restored visit is refused, and so is one cancelled, restored and cancelled again', async () => {
      await restore(app);
      await app('job_status_history').insert({ job_id: visit, from_status: 'cancelled', to_status: 'confirmed', transitioned_at: app.fn.now() });
      const restored = fenceFor();
      await expect(app.transaction((trx) => assertCancelGeneration(trx, restored))).rejects.toMatchObject({ code: 'CANCEL_FENCE', fenceReason: 'visit_is_confirmed' });
      await recancel();
      const again = fenceFor();
      await expect(app.transaction((trx) => assertCancelGeneration(trx, again))).rejects.toMatchObject({ fenceReason: 'visit_restored_since' });
      expect(again.hits).toEqual(['visit_restored_since']);
      // The NEW cancellation's own generation (one restoration seen) passes.
      await app.transaction((trx) => assertCancelGeneration(trx, fenceFor(1)));
    });

    test('a restore in flight (row locked, uncommitted) fails at once with visit_busy instead of waiting', async () => {
      const trxA = await app.transaction();
      try {
        await restore(trxA);
        const fence = fenceFor();
        const started = Date.now();
        await expect(app.transaction((trx) => assertCancelGeneration(trx, fence))).rejects.toMatchObject({ fenceReason: 'visit_busy' });
        expect(Date.now() - started).toBeLessThan(2000);
        expect(fence.hits).toEqual(['visit_busy']);
      } finally {
        await trxA.rollback();
      }
    });

    test('while the fence transaction holds its share lock a restore WAITS, then sees the commit order', async () => {
      const fence = fenceFor();
      const trxB = await app.transaction();
      await assertCancelGeneration(trxB, fence);
      let restored = false;
      const restoring = restore(app).then(() => { restored = true; });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(restored).toBe(false);
      await trxB.commit();
      await restoring;
      expect(restored).toBe(true);
      expect((await app('scheduled_services').where({ id: visit }).first()).status).toBe('confirmed');
    });

    // The ordering a timestamp comparison gets wrong. job_status_history.transitioned_at defaults to the transaction START
    // time. A restore transaction R begins, the cancel transaction C writes the bundle and commits, R (blocked on C's visit
    // row lock) then proceeds and commits its restoration: its history row is OLDER than the bundle. A different cancel D
    // follows. The count-based generation still refuses the old bundle.
    test('a restoration that began BEFORE the bundle insert but committed AFTER it is caught, even after the visit is cancelled again', async () => {
      await app('scheduled_services').where({ id: visit }).update({ status: 'confirmed' });
      await app('job_status_history').del();
      const restoreTx = await app.transaction();
      await restoreTx.raw('select 1'); // R's transaction clock starts here: now() is fixed from this point
      const cancelTx = await app.transaction();
      await cancelTx('scheduled_services').where({ id: visit }).forUpdate().first('id');
      const id = await svc.insertBundle(cancelTx, pins());
      await cancelTx('scheduled_services').where({ id: visit }).update({ status: 'cancelled' });
      await cancelTx('job_status_history').insert({ job_id: visit, from_status: 'confirmed', to_status: 'cancelled' });
      // R now asks for the visit row: it blocks on C's lock and reads the cancelled version once C commits.
      const restoreSees = restoreTx('scheduled_services').where({ id: visit }).forUpdate().first('status');
      await new Promise((resolve) => setTimeout(resolve, 150));
      await cancelTx.commit();
      expect((await restoreSees).status).toBe('cancelled');
      await restoreTx('scheduled_services').where({ id: visit }).update({ status: 'confirmed' });
      await restoreTx('job_status_history').insert({ job_id: visit, from_status: 'cancelled', to_status: 'confirmed' }); // transitioned_at = R's start
      await restoreTx.commit();
      await recancel(); // a DIFFERENT cancel D
      const bundle = await app(TABLE).where({ id }).first();
      const restoreRow = await app('job_status_history').where({ job_id: visit, to_status: 'confirmed' }).first();
      // The scenario is real: the restoration's timestamp is OLDER than the bundle, so a time comparison would have passed it.
      expect(new Date(restoreRow.transitioned_at).getTime()).toBeLessThan(new Date(bundle.created_at).getTime());
      expect(bundle.restorations_seen).toBe(0);
      expect((await app('scheduled_services').where({ id: visit }).first()).status).toBe('cancelled');
      // Every guard refuses the old bundle: the fence, the sweep's pre-check (abandons), and no effect runs.
      const fence = fenceFor(bundle.restorations_seen);
      await expect(app.transaction((trx) => assertCancelGeneration(trx, fence))).rejects.toMatchObject({ fenceReason: 'visit_restored_since' });
      await app(TABLE).where({ id }).update({ created_at: app.raw("now() - interval '30 minutes'"), lease_until: app.raw("now() - interval '20 minutes'") });
      expect(await svc.sweepIbCancelBundles()).toMatchObject({ abandoned: 1, recovered: 0 });
      expect(mockFollowThrough).not.toHaveBeenCalled();
      expect(mockHandleCancellation).not.toHaveBeenCalled();
      expect(await app(TABLE).where({ id }).first()).toMatchObject({ status: 'abandoned', finish_note: 'visit_restored_since' });
    });

      test('each approved linked visit pins its own restoration count under the children\'s row locks', async () => {
      const child = randomUUID();
      await app('scheduled_services').insert({ id: child, customer_id: customer, status: 'confirmed', service_type: 'Pest Control', scheduled_date: '2099-02-01' });
      await app('job_status_history').insert([
        { job_id: child, from_status: 'cancelled', to_status: 'confirmed', transitioned_at: app.fn.now() },
        { job_id: child, from_status: 'confirmed', to_status: 'cancelled', transitioned_at: app.fn.now() },
        { job_id: child, from_status: 'cancelled', to_status: 'confirmed', transitioned_at: app.fn.now() },
      ]);
      const id = await app.transaction((trx) => svc.insertBundle(trx, pins({ linkedChildren: [{ id: child, status: 'confirmed' }] })));
      expect((await app(TABLE).where({ id }).first()).linked_children).toEqual([{ id: child, status: 'confirmed', restorations_seen: 2 }]);
    });

  test('restorations from earlier lifecycles are pinned with the new cancel and do not block its recovery', async () => {
      await app('job_status_history').insert({ job_id: visit, from_status: 'cancelled', to_status: 'confirmed', transitioned_at: app.raw("now() - interval '3 days'") });
      const id = await app.transaction((trx) => svc.insertBundle(trx, pins()));
      expect((await app(TABLE).where({ id }).first()).restorations_seen).toBe(1);
      await app.transaction((trx) => assertCancelGeneration(trx, fenceFor(1)));
    });
  });

  // The recovered text's claim (AppointmentReminders.claimApprovedNoticeForGeneration): the visit is share-locked and the
  // generation proven BEFORE the reminder's approved marker is claimed, in one transaction. A single UPDATE with generation
  // subqueries could not promise this: after a lock wait PostgreSQL re-checks only the updated tuple, so a marker replaced by
  // a restore + re-cancel passed an older snapshot.
  describe('recovered text claim', () => {
    const { claimApprovedNoticeForGeneration } = jest.requireActual('../services/appointment-reminders');
    const marker = (extra = {}) => app('appointment_reminders').insert({ scheduled_service_id: visit, cancellation_notice_state: 'pending_approved', cancellation_notice_at: app.raw("now() - interval '30 minutes'"), ...extra }).returning('*');
    const fence = (restorations = 0) => ({ visitId: visit, restorations, hits: [] });

    test('a standing cancel claims the untouched approved marker and mints a fresh token', async () => {
      const [row] = await marker();
      const out = await claimApprovedNoticeForGeneration(row, fence());
      expect(out.claimed).toBe(1);
      const after = await app('appointment_reminders').where({ id: row.id }).first();
      expect(after.cancellation_notice_state).toBe('pending_approved');
      expect(new Date(after.cancellation_notice_at).getTime()).toBe(new Date(out.noticeToken).getTime());
    });

    test('any other marker is not claimed', async () => {
      const [row] = await marker({ cancellation_notice_state: 'sent' });
      expect((await claimApprovedNoticeForGeneration(row, fence())).claimed).toBe(0);
      expect((await app('appointment_reminders').where({ id: row.id }).first()).cancellation_notice_state).toBe('sent');
    });

    test('a restore + re-cancel that REPLACES the marker while it is in flight makes the claim fail at once and touch nothing; after it commits the old generation is refused', async () => {
      const [row] = await marker();
      const replaced = new Date(Date.now() - 1000);
      const trxR = await app.transaction();
      await trxR('scheduled_services').where({ id: visit }).update({ status: 'confirmed' });
      await trxR('job_status_history').insert({ job_id: visit, from_status: 'cancelled', to_status: 'confirmed' });
      await trxR('scheduled_services').where({ id: visit }).update({ status: 'cancelled' });
      await trxR('job_status_history').insert({ job_id: visit, from_status: 'confirmed', to_status: 'cancelled' });
      await trxR('appointment_reminders').where({ id: row.id }).update({ cancellation_notice_at: replaced, cancellation_notice_state: 'pending_approved' });
      const old = fence();
      await expect(claimApprovedNoticeForGeneration(row, old)).rejects.toMatchObject({ fenceReason: 'visit_busy' });
      await trxR.commit();
      const stillNew = await app('appointment_reminders').where({ id: row.id }).first();
      expect(new Date(stillNew.cancellation_notice_at).getTime()).toBe(replaced.getTime());
      // The new cancellation's marker is in place and the old bundle's claim is refused on the count.
      await expect(claimApprovedNoticeForGeneration(row, fence(0))).rejects.toMatchObject({ fenceReason: 'visit_restored_since' });
      expect(new Date((await app('appointment_reminders').where({ id: row.id }).first()).cancellation_notice_at).getTime()).toBe(replaced.getTime());
      // The new generation's own claim goes through.
      expect((await claimApprovedNoticeForGeneration(row, fence(1))).claimed).toBe(1);
    });
  });

  // The reminder close that handleCancellation does before it claims: for a fenced send it moves INSIDE the share-locked
  // claim transaction. Run on an older snapshot after a concurrent restore, the unfenced version re-closed the LIVE visit's
  // reminder and suppressed its future reminders.
  describe('reminder close and technician state under the fence', () => {
    const { claimApprovedNoticeForGeneration } = jest.requireActual('../services/appointment-reminders');
    const fence = (restorations = 0) => ({ visitId: visit, restorations, hits: [] });
    const reminder = async () => (await app('appointment_reminders').insert({ scheduled_service_id: visit, cancellation_notice_state: 'pending_approved', cancellation_notice_at: app.raw("now() - interval '30 minutes'") }).returning('*'))[0];

    test('a standing cancel closes the reminder in the same transaction as the claim', async () => {
      const row = await reminder();
      expect((await claimApprovedNoticeForGeneration(row, fence())).claimed).toBe(1);
      expect((await app('appointment_reminders').where({ id: row.id }).first()).cancelled).toBe(true);
    });

    test('a restore in flight, then committed: the claim never closes the (now live) visit\'s reminder', async () => {
      const row = await reminder();
      const trxR = await app.transaction();
      await trxR('scheduled_services').where({ id: visit }).update({ status: 'confirmed' });
      await trxR('job_status_history').insert({ job_id: visit, from_status: 'cancelled', to_status: 'confirmed' });
      await expect(claimApprovedNoticeForGeneration(row, fence())).rejects.toMatchObject({ fenceReason: 'visit_busy' });
      await trxR.commit();
      await expect(claimApprovedNoticeForGeneration(row, fence())).rejects.toMatchObject({ fenceReason: 'visit_is_confirmed' });
      expect((await app('appointment_reminders').where({ id: row.id }).first()).cancelled).toBe(false);
    });

    test('the technician-state cleanup takes tech_status NOWAIT under the fence, and a restore in flight refuses it before any write', async () => {
      const { clearTechCurrentJob } = jest.requireActual('../services/tech-status');
      const tech = randomUUID();
      await app('tech_status').insert({ tech_id: tech, current_job_id: visit, status: 'on_job' });
      const { assertCancelGeneration: prove } = require('../services/cancel-generation-fence');
      const clear = () => app.transaction(async (trx) => {
        await prove(trx, fence());
        return clearTechCurrentJob({ tech_id: tech, current_job_id: visit, status: 'idle', conn: trx, noWait: true });
      });
      // A busy tech_status row fails at once instead of waiting while the visit share lock is held.
      const holder = await app.transaction();
      await holder('tech_status').where({ tech_id: tech }).forUpdate().first('id');
      const started = Date.now();
      await expect(clear()).rejects.toMatchObject({ code: '55P03' });
      expect(Date.now() - started).toBeLessThan(2000);
      await holder.rollback();
      // A restore in flight refuses the cleanup before it touches tech_status.
      const trxR = await app.transaction();
      await trxR('scheduled_services').where({ id: visit }).update({ status: 'confirmed' });
      await expect(clear()).rejects.toMatchObject({ fenceReason: 'visit_busy' });
      await trxR.rollback();
      expect((await app('tech_status').where({ tech_id: tech }).first()).current_job_id).toBe(visit);
      // Standing cancel, free row: cleared.
      await clear();
      expect((await app('tech_status').where({ tech_id: tech }).first()).current_job_id).toBeNull();
    });
  });

  test('a visit restored while the recovery runs abandons the bundle and sends no text', async () => {
    const id = await app.transaction((trx) => svc.insertBundle(trx, pins()));
    await ageBundle(id, 30);
    mockFollowThrough.mockImplementationOnce(async ({ cancelFence }) => {
      await app('scheduled_services').where({ id: visit }).update({ status: 'confirmed' });
      await app('job_status_history').insert({ job_id: visit, from_status: 'cancelled', to_status: 'confirmed', transitioned_at: app.fn.now() });
      cancelFence.hits.push('visit_is_confirmed');
    });
    expect(await svc.sweepIbCancelBundles()).toMatchObject({ abandoned: 1, recovered: 0 });
    expect(mockHandleCancellation).not.toHaveBeenCalled();
    expect(await app(TABLE).where({ id }).first()).toMatchObject({ status: 'abandoned', finish_note: 'visit_is_confirmed_during_recovery', followthrough_done_at: null });
  });

  test('a text parked for the send window is skipped by the claim, so other bundles are never starved', async () => {
    mockWindowOpen = false;
    const parked = [];
    for (let i = 0; i < 12; i += 1) {
      const id = await app.transaction((trx) => svc.insertBundle(trx, pins()));
      await app(TABLE).where({ id }).update({ created_at: app.raw(`now() - interval '${60 - i} minutes'`), lease_until: app.raw("now() - interval '30 minutes'") });
      parked.push(id);
    }
    expect(await svc.sweepIbCancelBundles()).toMatchObject({ deferred: 10 });
    const rows = await app(TABLE).whereIn('id', parked).orderBy('created_at');
    expect(rows.slice(0, 10).every((r) => r.next_attempt_at && r.attempts === 0 && r.lease_owner === null && r.followthrough_done_at)).toBe(true);
    expect(await svc.sweepIbCancelBundles()).toMatchObject({ deferred: 2 });
    expect(mockFollowThrough).toHaveBeenCalledTimes(12);
    // Window open and the park time passed: the texts go, the money work is not repeated.
    mockWindowOpen = true;
    await app(TABLE).update({ next_attempt_at: app.raw("now() - interval '1 minute'") });
    await svc.sweepIbCancelBundles();
    await svc.sweepIbCancelBundles();
    expect(mockFollowThrough).toHaveBeenCalledTimes(12);
    expect(mockHandleCancellation).toHaveBeenCalledTimes(12);
    expect((await app(TABLE).whereIn('id', parked)).every((r) => r.status === 'recovered')).toBe(true);
  });

  // ── An exhausted bundle is claimed before it is reported; a complete bundle's missing receipt is rebuilt ────────
  describe('report claim and receipt reconcile (real SQL)', () => {
    const exhaust = async (id) => app(TABLE).where({ id }).update({
      attempts: 5, lease_owner: null, lease_until: null, created_at: app.raw("now() - interval '3 hours'"),
    });
    afterEach(() => { mockRecordResult.mockImplementation(async () => true); });
    // The real pending-actions write, so onlyIfEmpty is tested against a real row.
    const writeLikeRecordResult = async (id, result, opts = {}) => {
      const q = app('ib_pending_actions').where({ id });
      if (opts.onlyIfEmpty) q.whereNull('result');
      await q.update({ result: JSON.stringify(result), updated_at: app.fn.now() });
      return true;
    };

    test('two sweeps at once report an exhausted bundle exactly once', async () => {
      const id = await app.transaction((trx) => svc.insertBundle(trx, pins()));
      await exhaust(id);
      const [a, b] = await Promise.all([svc.sweepIbCancelBundles(), svc.sweepIbCancelBundles()]);
      expect(a.reported + b.reported).toBe(1);
      expect(mockRaise).toHaveBeenCalledTimes(1);
      expect(mockRecordResult).toHaveBeenCalledTimes(1);
      expect(await app(TABLE).where({ id }).first()).toMatchObject({ status: 'expired', finish_note: 'attempts_exhausted', lease_owner: null, attempts: 5 });
      expect(mockFollowThrough).not.toHaveBeenCalled();
    });

    test('the claim does not count an attempt and skips a row a live request still holds', async () => {
      const held = await app.transaction((trx) => svc.insertBundle(trx, pins()));
      await exhaust(held);
      await app(TABLE).where({ id: held }).update({ lease_owner: 'request', lease_until: app.raw("now() + interval '5 minutes'") });
      expect(await svc.sweepIbCancelBundles()).toMatchObject({ reported: 0 });
      expect(await app(TABLE).where({ id: held }).first()).toMatchObject({ status: 'pending', attempts: 5, lease_owner: 'request' });
    });

    test('while any sweep holds a live lease the request cannot complete the row or record a text outcome; an expired lease does not block it', async () => {
      const id = await app.transaction((trx) => svc.insertBundle(trx, pins()));
      const report = { ibCancelBundleId: id, ibMoneyReport: { skipped: [] }, ibLinkedChildReport: { skipped: [] } };
      await app(TABLE).where({ id }).update({ lease_owner: 'report:abc', lease_until: app.raw("now() + interval '5 minutes'") });
      await svc.liveFinish(report);
      expect((await app(TABLE).where({ id }).first()).status).toBe('pending');
      await app(TABLE).where({ id }).update({ lease_owner: 'report:abc', lease_until: app.raw("now() - interval '1 minute'") });
      await svc.liveFinish(report);
      expect(await app(TABLE).where({ id }).first()).toMatchObject({ status: 'complete', finish_note: 'request', lease_owner: null });
      const other = await app.transaction((trx) => svc.insertBundle(trx, pins()));
      await app(TABLE).where({ id: other }).update({ lease_owner: 'sweep-token', lease_until: app.raw("now() + interval '5 minutes'") });
      await svc.liveNotice({ ibCancelBundleId: other }, { notificationSent: true });
      await svc.liveFinish({ ...report, ibCancelBundleId: other });
      expect(await app(TABLE).where({ id: other }).first()).toMatchObject({ status: 'pending', notice_outcome: null });
      await app(TABLE).where({ id: other }).update({ lease_until: app.raw("now() - interval '1 minute'") });
      await svc.liveNotice({ ibCancelBundleId: other }, { notificationSent: true });
      await svc.liveFinish({ ...report, ibCancelBundleId: other });
      expect(await app(TABLE).where({ id: other }).first()).toMatchObject({ status: 'complete', notice_outcome: { state: 'sent', by: 'request' } });
    });

    const completeWithoutReceipt = async (extra = {}) => {
      const body = pins();
      const id = await app.transaction((trx) => svc.insertBundle(trx, body));
      await app(TABLE).where({ id }).update({
        status: 'complete', finish_note: 'request', lease_owner: null, lease_until: null,
        finished_at: app.raw("now() - interval '15 minutes'"), created_at: app.raw("now() - interval '20 minutes'"),
        followthrough_done_at: app.raw("now() - interval '15 minutes'"),
        followthrough_outcome: JSON.stringify({ money_skipped: [{ kind: 'invoice', id: 'inv-9', reason: 'paid_since_card' }], linked_skipped: [] }),
        notice_outcome: JSON.stringify({ state: 'sent', by: 'request' }),
        ...extra,
      });
      await app('ib_pending_actions').insert({ id: body.pendingActionId, result: null });
      return { id, actionId: body.pendingActionId };
    };

    test('a missing receipt is rebuilt once, even with two sweeps at once, and a present one is left alone', async () => {
      mockRecordResult.mockImplementation(writeLikeRecordResult);
      const gap = await completeWithoutReceipt();
      const fine = await completeWithoutReceipt();
      await app('ib_pending_actions').where({ id: fine.actionId }).update({ result: JSON.stringify({ success: true, from: 'request' }) });
      const [a, b] = await Promise.all([svc.sweepIbCancelBundles(), svc.sweepIbCancelBundles()]);
      expect(a.receipts + b.receipts).toBe(1);
      expect(mockRaise).toHaveBeenCalledTimes(1);
      const saved = (await app('ib_pending_actions').where({ id: gap.actionId }).first()).result;
      expect(saved).toMatchObject({ success: true, ran_dispatch_cancel: true, money_skipped: [{ kind: 'invoice', id: 'inv-9' }] });
      expect(saved.warning).toMatch(/stopped before it saved this result/);
      expect((await app('ib_pending_actions').where({ id: fine.actionId }).first()).result).toEqual({ success: true, from: 'request' });
      expect(await app(TABLE).where({ id: gap.id }).first()).toMatchObject({ status: 'complete', finish_note: 'request+receipt', lease_owner: null });
      expect((await app(TABLE).where({ id: fine.id }).first()).finish_note).toBe('request+receipt');
      expect(mockFollowThrough).not.toHaveBeenCalled();
      expect(mockHandleCancellation).not.toHaveBeenCalled();
      // A later pass finds nothing.
      expect(await svc.sweepIbCancelBundles()).toMatchObject({ receipts: 0 });
      expect(mockRaise).toHaveBeenCalledTimes(1);
    });

    test('recordResult: a request pointer receipt is replaced by the sweep, a real receipt is not, and a request never overwrites either', async () => {
      const { recordResult } = jest.requireActual('../services/intelligence-bar/pending-actions');
      const read = async (id) => (await app('ib_pending_actions').where({ id }).first()).result;
      const empty = randomUUID();
      const pointer = randomUUID();
      const real = randomUUID();
      await app('ib_pending_actions').insert([
        { id: empty, result: null },
        { id: pointer, result: JSON.stringify({ success: true, recovery_owns_outcome: true, from: 'request' }) },
        { id: real, result: JSON.stringify({ success: true, from: 'request' }) },
      ]);
      // The sweep's save (onlyIfEmpty + replaceRecoveryPointer).
      await recordResult(empty, { from: 'sweep' }, { onlyIfEmpty: true, replaceRecoveryPointer: true });
      await recordResult(pointer, { from: 'sweep' }, { onlyIfEmpty: true, replaceRecoveryPointer: true });
      await recordResult(real, { from: 'sweep' }, { onlyIfEmpty: true, replaceRecoveryPointer: true });
      expect(await read(empty)).toEqual({ from: 'sweep' });
      expect(await read(pointer)).toEqual({ from: 'sweep' });
      expect(await read(real)).toEqual({ success: true, from: 'request' });
      // The sweep's own earlier receipt is provisional until the bundle's terminal status is saved: a later sweep write replaces it.
      const own = randomUUID();
      await app('ib_pending_actions').insert({ id: own, result: JSON.stringify({ success: true, recovered_after_interruption: true, from: 'sweep-1' }) });
      await recordResult(own, { success: true, recovered_after_interruption: true, from: 'sweep-2' }, { onlyIfEmpty: true, replaceRecoveryPointer: true });
      expect(await read(own)).toMatchObject({ from: 'sweep-2' });
      // The request's pointer save (onlyIfEmpty only) never replaces a sweep receipt or another pointer.
      await recordResult(empty, { recovery_owns_outcome: true }, { onlyIfEmpty: true });
      expect(await read(empty)).toEqual({ from: 'sweep' });
      const fresh = randomUUID();
      await app('ib_pending_actions').insert({ id: fresh, result: null });
      await recordResult(fresh, { recovery_owns_outcome: true, from: 'request' }, { onlyIfEmpty: true });
      expect(await read(fresh)).toEqual({ recovery_owns_outcome: true, from: 'request' });
      await recordResult(fresh, { recovery_owns_outcome: true, from: 'again' }, { onlyIfEmpty: true });
      expect(await read(fresh)).toMatchObject({ from: 'request' });
    });

    test('a gap found after the hard stop is still reconciled (late, needs-you), and the 90-day prune keeps a bundle that still owes a receipt', async () => {
      mockRecordResult.mockImplementation(writeLikeRecordResult);
      const late = await completeWithoutReceipt({ finished_at: app.raw("now() - interval '30 hours'") });
      const owed = await completeWithoutReceipt({
        finished_at: app.raw("now() - interval '100 days'"), created_at: app.raw("now() - interval '101 days'"),
        lease_owner: 'other-pod', lease_until: app.raw("now() + interval '1 hour'"),
      });
      const checked = await completeWithoutReceipt({ finish_note: 'request+receipt', finished_at: app.raw("now() - interval '100 days'"), created_at: app.raw("now() - interval '101 days'") });
      expect(await svc.sweepIbCancelBundles()).toMatchObject({ receipts: 1 });
      expect(await app(TABLE).where({ id: late.id }).first()).toMatchObject({ finish_note: 'request+receipt' });
      expect(mockRaise.mock.calls[0][1].severity).toBe('needs-you');
      expect(await app(TABLE).where({ id: owed.id }).first()).toBeTruthy();
      expect(await app(TABLE).where({ id: checked.id }).first()).toBeUndefined();
    });

    test('a row completed 3 minutes ago is left to the request', async () => {
      mockRecordResult.mockImplementation(writeLikeRecordResult);
      await completeWithoutReceipt({ finished_at: app.raw("now() - interval '3 minutes'") });
      expect(await svc.sweepIbCancelBundles()).toMatchObject({ receipts: 0 });
      expect(mockRaise).not.toHaveBeenCalled();
    });
  });


  test('down drops the table and up builds it again', async () => {
    await migration.down(app);
    expect(await app.schema.hasTable(TABLE)).toBe(false);
    await migration.up(app);
    expect(await app.schema.hasTable(TABLE)).toBe(true);
    await migration.up(app); // idempotent
  });
});

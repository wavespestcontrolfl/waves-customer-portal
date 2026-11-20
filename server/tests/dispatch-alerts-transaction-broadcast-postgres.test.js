let mockPg;
const mockEmit = jest.fn();
const mockTo = jest.fn(() => ({ emit: mockEmit }));

jest.mock('../models/db', () => {
  const db = (table, ...args) => mockPg(table, ...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref', 'destroy']) {
    db[name] = (...args) => mockPg[name](...args);
  }
  for (const name of ['schema', 'fn', 'client']) {
    Object.defineProperty(db, name, { get: () => mockPg[name] });
  }
  return db;
});
jest.mock('../sockets', () => ({
  getIo: jest.fn(() => ({ to: mockTo })),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const knex = require('knex');
const { randomUUID } = require('crypto');
const DispatchAlerts = require('../services/dispatch-alerts');
const DispatchReview = require('../services/commercial-prepay-dispatch-review');
const SaleRecord = require('../services/commercial-prepay-sale-record');

const connection = process.env.DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let database;
let seededSales = [];

jest.setTimeout(120000);

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settleHooks() {
  await tick();
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function seedSetupReviewSale() {
  const ids = {
    customerId: randomUUID(),
    winnerId: randomUUID(),
    invoiceId: randomUUID(),
    termId: randomUUID(),
  };
  await database('customers').insert([ids.customerId, ids.winnerId].map((id, index) => ({
    id,
    first_name: 'Synthetic',
    last_name: index ? 'Broadcast Winner' : 'Broadcast Original',
    phone: `+1202555${String(parseInt(id.slice(0, 8), 16) % 10000).padStart(4, '0')}`,
    property_type: 'commercial',
  })));
  await database('invoices').insert({
    id: ids.invoiceId,
    token: randomUUID(),
    invoice_number: `TRX-${ids.invoiceId.slice(0, 8)}`,
    customer_id: ids.customerId,
    title: 'Commercial Rodent Bait Stations — Annual Prepay',
    status: 'paid',
    paid_at: new Date(),
    payment_recorded_at: new Date(),
    subtotal: 55,
    total: 55,
    due_date: '2099-01-01',
    line_items: JSON.stringify([]),
  });
  await database('annual_prepay_terms').insert({
    id: ids.termId,
    customer_id: ids.customerId,
    prepay_invoice_id: ids.invoiceId,
    plan_label: 'Commercial Rodent Bait Stations',
    monthly_rate: 55,
    prepay_amount: 55,
    term_start: '2099-01-01',
    term_end: '2099-12-31',
    status: 'active',
    coverage_service_type: 'Commercial Rodent Bait Stations',
    coverage_visit_count: 4,
  });
  await SaleRecord.recordUnbookedSale(database, {
    invoiceId: ids.invoiceId,
    customerId: ids.customerId,
    setupAmount: 55,
  });
  seededSales.push(ids);
  return ids;
}

async function mergeSetupReviewSale(ids) {
  const loser = await database('customers').where({ id: ids.customerId }).first();
  await database.transaction(async (trx) => {
    await trx('invoices').where({ id: ids.invoiceId }).update({ customer_id: ids.winnerId });
    await trx('annual_prepay_terms').where({ id: ids.termId }).update({ customer_id: ids.winnerId });
    const [journal] = await trx('customer_merge_journal').insert({
      winner_customer_id: ids.winnerId,
      loser_customer_id: ids.customerId,
      loser_snapshot: loser,
      repointed: {},
      repointed_ids: {
        version: 1,
        tables: {
          'invoices.customer_id': [ids.invoiceId],
          'annual_prepay_terms.customer_id': [ids.termId],
        },
      },
      winner_backfills: {},
      tier: 'manual',
      evidence: { synthetic: true },
      performed_by: 'test:dispatch-alert-broadcast',
      created_at: trx.raw('clock_timestamp()'),
    }).returning('id');
    ids.journalId = journal.id;
  });
}

async function undoSetupReviewMerge(ids) {
  await database.transaction(async (trx) => {
    await trx('customer_merge_journal').where({ id: ids.journalId }).update({ undone_at: trx.fn.now() });
    await trx('invoices').where({ id: ids.invoiceId }).update({ customer_id: ids.customerId });
    await trx('annual_prepay_terms').where({ id: ids.termId }).update({ customer_id: ids.customerId });
  });
}

function blockHydration() {
  const original = DispatchReview.hydrateCurrentCustomerLinks;
  let entered;
  let release;
  const started = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const spy = jest.spyOn(DispatchReview, 'hydrateCurrentCustomerLinks').mockImplementation(async (...args) => {
    entered();
    await blocked;
    return original(...args);
  });
  return { spy, started, release };
}

postgres('dispatch alert broadcasts require a real transaction commit', () => {
  beforeAll(() => {
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)
      || !/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)) {
      throw new Error('Dispatch transaction tests require a private local waves_qa_<32 hex> PostgreSQL database.');
    }
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    mockPg = database;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPg = database;
  });

  afterEach(async () => {
    await database('dispatch_alerts').where('type', 'like', 'trx_test_%').del();
    for (const ids of seededSales) {
      await database('dispatch_alerts').whereRaw("payload->>'sourceInvoiceId' = ?", [ids.invoiceId]).del();
      await database('customer_merge_journal')
        .whereIn('id', ids.journalId ? [ids.journalId] : [])
        .del();
      await database('audit_log').where({
        action: SaleRecord.UNBOOKED_SALE,
        resource_type: 'invoices',
        resource_id: ids.invoiceId,
      }).del();
      await database('annual_prepay_terms').where({ id: ids.termId }).del();
      await database('invoices').where({ id: ids.invoiceId }).del();
      await database('customers').whereIn('id', [ids.customerId, ids.winnerId]).del();
    }
    seededSales = [];
    jest.restoreAllMocks();
  });

  afterAll(async () => database?.destroy());

  test('explicit root rollback fulfills Knex executionPromise but emits no phantom create', async () => {
    const trx = await database.transaction();
    const type = `trx_test_root_${randomUUID().slice(0, 8)}`;
    const row = await DispatchAlerts.createAlert({
      type,
      severity: 'warn',
      payload: { synthetic: true },
      trx,
    });
    expect(row.id).toBeTruthy();
    expect(mockEmit).not.toHaveBeenCalled();

    await trx.rollback();
    await trx.executionPromise;
    await settleHooks();

    expect(await database('dispatch_alerts').where({ id: row.id }).first()).toBeUndefined();
    expect(mockTo).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test('rolled-back child then same parent resolve emits only the committed attempt', async () => {
    const type = `trx_test_child_${randomUUID().slice(0, 8)}`;
    const open = await DispatchAlerts.createAlert({ type, severity: 'warn' });
    await settleHooks();
    jest.clearAllMocks();

    const parent = await database.transaction();
    const child = await parent.transaction();
    const childResolved = await DispatchAlerts.resolveAlert({ id: open.id, resolvedBy: null, trx: child });
    expect(childResolved?.id).toBe(open.id);
    expect(mockEmit).not.toHaveBeenCalled();

    await child.rollback();
    await child.executionPromise;
    const parentResolved = await DispatchAlerts.resolveAlert({ id: open.id, resolvedBy: null, trx: parent });
    expect(parentResolved?.id).toBe(open.id);
    // now() is the outer transaction's stable timestamp: it cannot identify
    // which savepoint attempt produced the row that actually committed.
    expect(new Date(parentResolved.resolved_at).getTime())
      .toBe(new Date(childResolved.resolved_at).getTime());

    const resolvedBroadcast = new Promise((resolve) => mockEmit.mockImplementationOnce(resolve));
    await parent.commit();
    await parent.executionPromise;
    await resolvedBroadcast;
    await settleHooks();

    const persisted = await database('dispatch_alerts').where({ id: open.id }).first();
    expect(persisted.resolution_attempt_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(parentResolved.resolution_attempt_id).toBeUndefined();
    expect(childResolved.resolution_attempt_id).toBeUndefined();
    expect(mockTo).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith(DispatchAlerts.EVENT_RESOLVED, expect.objectContaining({
      id: open.id,
    }));
  });

  test('setup-review create broadcast follows an audited merge committed before hydration', async () => {
    const ids = await seedSetupReviewSale();
    const hydration = blockHydration();
    const create = DispatchAlerts.createAlert({
      type: DispatchReview.REVIEW_TYPE,
      severity: 'warn',
      payload: { sourceInvoiceId: ids.invoiceId, customerId: ids.customerId, amount: 55 },
    });
    await hydration.started;
    await mergeSetupReviewSale(ids);
    hydration.release();
    const created = await create;
    hydration.spy.mockRestore();

    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith(DispatchAlerts.EVENT, expect.objectContaining({
      id: created.id,
      payload: expect.objectContaining({ customerId: ids.winnerId }),
    }));
  });

  test('setup-review create broadcast follows an audited merge undo committed before hydration', async () => {
    const ids = await seedSetupReviewSale();
    await mergeSetupReviewSale(ids);
    const hydration = blockHydration();
    const create = DispatchAlerts.createAlert({
      type: DispatchReview.REVIEW_TYPE,
      severity: 'warn',
      payload: { sourceInvoiceId: ids.invoiceId, customerId: ids.winnerId, amount: 55 },
    });
    await hydration.started;
    await undoSetupReviewMerge(ids);
    hydration.release();
    const created = await create;
    hydration.spy.mockRestore();

    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith(DispatchAlerts.EVENT, expect.objectContaining({
      id: created.id,
      payload: expect.objectContaining({ customerId: ids.customerId }),
    }));
  });

  test('automatic and bulk resolves each broadcast once after commit', async () => {
    const auto = await DispatchAlerts.createAlert({
      type: `trx_test_auto_${randomUUID().slice(0, 8)}`,
      severity: 'warn',
      payload: { tracking_key: 'synthetic:auto' },
    });
    await settleHooks();
    jest.clearAllMocks();

    const autoTrx = await database.transaction();
    const autoResolved = await DispatchAlerts.resolveAlert({ id: auto.id, trx: autoTrx, auto: true });
    const autoBroadcast = new Promise((resolve) => mockEmit.mockImplementationOnce(resolve));
    await autoTrx.commit();
    await autoTrx.executionPromise;
    await autoBroadcast;
    await settleHooks();
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const persistedAuto = await database('dispatch_alerts').where({ id: auto.id }).first();
    expect(persistedAuto.resolution_attempt_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(autoResolved.resolution_attempt_id).toBeUndefined();
    expect(persistedAuto.payload).toEqual(expect.objectContaining({
      tracking_key: 'synthetic:auto',
      superseded_at: expect.any(String),
    }));

    const bulkRows = await Promise.all([1, 2].map((n) => DispatchAlerts.createAlert({
      type: `trx_test_bulk_${n}_${randomUUID().slice(0, 8)}`,
      severity: 'info',
      payload: { synthetic: n },
    })));
    await settleHooks();
    jest.clearAllMocks();
    const bulkTrx = await database.transaction();
    const bulk = await DispatchAlerts.resolveAllOpenAlerts({ trx: bulkTrx, resolvedBy: null });
    expect(bulk.alerts.map((row) => row.id).sort()).toEqual(bulkRows.map((row) => row.id).sort());
    expect(mockEmit).not.toHaveBeenCalled();
    const bulkBroadcasts = new Promise((resolve) => mockEmit.mockImplementation(() => {
      if (mockEmit.mock.calls.length === bulkRows.length) resolve();
    }));
    await bulkTrx.commit();
    await bulkTrx.executionPromise;
    await bulkBroadcasts;
    await settleHooks();
    expect(mockEmit).toHaveBeenCalledTimes(2);
    for (const row of bulkRows) {
      expect(mockEmit).toHaveBeenCalledWith(DispatchAlerts.EVENT_RESOLVED, expect.objectContaining({ id: row.id }));
    }
  });

  test('ordinary resolves preserve legacy array payloads while proving their write', async () => {
    const open = await DispatchAlerts.createAlert({
      type: `trx_test_legacy_${randomUUID().slice(0, 8)}`,
      severity: 'info',
      payload: ['legacy', { nested: true }],
    });
    await settleHooks();
    jest.clearAllMocks();

    const trx = await database.transaction();
    const resolved = await DispatchAlerts.resolveAlert({ id: open.id, trx, resolvedBy: null });
    const broadcast = new Promise((resolve) => mockEmit.mockImplementationOnce(resolve));
    await trx.commit();
    await trx.executionPromise;
    await broadcast;
    await settleHooks();

    const persisted = await database('dispatch_alerts').where({ id: open.id }).first();
    expect(persisted.payload).toEqual(['legacy', { nested: true }]);
    expect(persisted.resolution_attempt_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolved.resolution_attempt_id).toBeUndefined();
    expect(mockEmit).toHaveBeenCalledTimes(1);
  });

  test('successful root commits emit one create and one resolve after their writes commit', async () => {
    const hydrateSpy = jest.spyOn(DispatchReview, 'hydrateCurrentCustomerLinks');
    const type = `trx_test_success_${randomUUID().slice(0, 8)}`;
    const createTrx = await database.transaction();
    const created = await DispatchAlerts.createAlert({
      type,
      severity: 'critical',
      payload: { synthetic: true },
      trx: createTrx,
    });
    expect(mockEmit).not.toHaveBeenCalled();

    const createdBroadcast = new Promise((resolve) => mockEmit.mockImplementationOnce(resolve));
    await createTrx.commit();
    await createTrx.executionPromise;
    await createdBroadcast;
    expect(mockTo).toHaveBeenCalledTimes(1);
    expect(mockTo).toHaveBeenCalledWith(DispatchAlerts.ROOM);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith(DispatchAlerts.EVENT, expect.objectContaining({
      id: created.id,
      type,
      severity: 'critical',
      payload: { synthetic: true },
    }));
    expect(hydrateSpy).not.toHaveBeenCalled();
    expect(await database('dispatch_alerts').where({ id: created.id }).first()).toBeTruthy();

    jest.clearAllMocks();
    const resolveTrx = await database.transaction();
    const resolved = await DispatchAlerts.resolveAlert({
      id: created.id,
      resolvedBy: null,
      trx: resolveTrx,
    });
    expect(resolved?.resolved_at).toBeTruthy();
    expect(mockEmit).not.toHaveBeenCalled();

    const resolvedBroadcast = new Promise((resolve) => mockEmit.mockImplementationOnce(resolve));
    await resolveTrx.commit();
    await resolveTrx.executionPromise;
    await resolvedBroadcast;
    expect(mockTo).toHaveBeenCalledTimes(1);
    expect(mockTo).toHaveBeenCalledWith(DispatchAlerts.ROOM);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith(DispatchAlerts.EVENT_RESOLVED, {
      id: created.id,
      resolved_at: resolved.resolved_at,
      resolved_by: null,
    });
    expect((await database('dispatch_alerts').where({ id: created.id }).first()).resolved_at).toBeTruthy();
    hydrateSpy.mockRestore();
  });
});

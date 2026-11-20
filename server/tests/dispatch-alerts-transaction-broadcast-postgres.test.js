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

const connection = process.env.DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let database;

jest.setTimeout(120000);

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settleHooks() {
  await tick();
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 50));
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

  test('rolled-back child plus committed parent emits no phantom resolve', async () => {
    const type = `trx_test_child_${randomUUID().slice(0, 8)}`;
    const open = await DispatchAlerts.createAlert({ type, severity: 'warn' });
    await settleHooks();
    jest.clearAllMocks();

    const parent = await database.transaction();
    const child = await parent.transaction();
    const resolved = await DispatchAlerts.resolveAlert({ id: open.id, resolvedBy: null, trx: child });
    expect(resolved?.id).toBe(open.id);
    expect(mockEmit).not.toHaveBeenCalled();

    await child.rollback();
    await child.executionPromise;
    await parent.commit();
    await parent.executionPromise;
    await settleHooks();

    const persisted = await database('dispatch_alerts').where({ id: open.id }).first();
    expect(persisted.resolved_at).toBeNull();
    expect(mockTo).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test('successful root commits emit one create and one resolve after their writes commit', async () => {
    const type = `trx_test_success_${randomUUID().slice(0, 8)}`;
    const createTrx = await database.transaction();
    const created = await DispatchAlerts.createAlert({
      type,
      severity: 'critical',
      payload: { synthetic: true },
      trx: createTrx,
    });
    expect(mockEmit).not.toHaveBeenCalled();

    await createTrx.commit();
    await createTrx.executionPromise;
    await settleHooks();
    expect(mockTo).toHaveBeenCalledTimes(1);
    expect(mockTo).toHaveBeenCalledWith(DispatchAlerts.ROOM);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith(DispatchAlerts.EVENT, expect.objectContaining({
      id: created.id,
      type,
      severity: 'critical',
    }));
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

    await resolveTrx.commit();
    await resolveTrx.executionPromise;
    await settleHooks();
    expect(mockTo).toHaveBeenCalledTimes(1);
    expect(mockTo).toHaveBeenCalledWith(DispatchAlerts.ROOM);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith(DispatchAlerts.EVENT_RESOLVED, {
      id: created.id,
      resolved_at: resolved.resolved_at,
      resolved_by: null,
    });
    expect((await database('dispatch_alerts').where({ id: created.id }).first()).resolved_at).toBeTruthy();
  });
});

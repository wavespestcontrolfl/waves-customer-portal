/**
 * clearTechCurrentJob on a caller's transaction (the cancel recovery sweep) broadcasts dispatch:tech_status only AFTER the
 * transaction commits: a client must not see a cleared row before the commit, nor a state that a rollback removed.
 * Without a transaction handle the broadcast is immediate, as before. Synthetic ids only.
 */
const mockEmit = jest.fn();
const mockTo = jest.fn(() => ({ emit: mockEmit }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => {
  const db = jest.fn();
  db.fn = { now: () => 'now()' };
  return db;
});
jest.mock('../sockets', () => ({ getIo: () => ({ to: (...a) => mockTo(...a) }) }));

const row = { id: 'ts-1', tech_id: 'tech-1', status: 'idle', lat: null, lng: null, current_job_id: null, updated_at: new Date(), location_updated_at: null };
const fakeConn = (executionPromise) => {
  const chain = { where: () => chain, update: () => chain, returning: async () => [row], forUpdate: () => chain, noWait: () => chain, first: async () => ({ id: 'ts-1' }) };
  const conn = () => chain;
  if (executionPromise) conn.executionPromise = executionPromise;
  return conn;
};

let svc;
beforeAll(() => {
  jest.resetModules();
  svc = require('../services/tech-status');
});
beforeEach(() => { mockEmit.mockClear(); mockTo.mockClear(); });

describe('clearTechCurrentJob event timing', () => {
  test('on a transaction the event waits for the commit', async () => {
    let commit;
    const executionPromise = new Promise((resolve) => { commit = resolve; });
    const result = await svc.clearTechCurrentJob({ tech_id: 'tech-1', current_job_id: 'job-1', conn: fakeConn(executionPromise), noWait: true });
    expect(result).toMatchObject({ id: 'ts-1' });
    await new Promise((r) => setImmediate(r));
    expect(mockEmit).not.toHaveBeenCalled();
    commit();
    await new Promise((r) => setImmediate(r));
    expect(mockEmit).toHaveBeenCalledTimes(1);
  });

  test('without a transaction handle the event goes out at once (unchanged)', async () => {
    const db = require('../models/db');
    db.mockReturnValue(fakeConn(null)());
    await svc.clearTechCurrentJob({ tech_id: 'tech-1', current_job_id: 'job-1' });
    expect(mockEmit).toHaveBeenCalledTimes(1);
  });

  test('a rolled-back transaction emits nothing', async () => {
    let rollback;
    const executionPromise = new Promise((_resolve, reject) => { rollback = reject; });
    executionPromise.catch(() => {});
    await svc.clearTechCurrentJob({ tech_id: 'tech-1', current_job_id: 'job-1', conn: fakeConn(executionPromise) });
    rollback(new Error('rolled back'));
    await new Promise((r) => setImmediate(r));
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

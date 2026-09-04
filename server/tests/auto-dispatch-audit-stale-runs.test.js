/**
 * startRun settles runs the previous process abandoned mid-sweep (deploy
 * restart during the 4:10 tick, 2026-09-03): a 'running' row older than the
 * stale floor flips to failed with completed_at stamped, before the new run
 * row is inserted. A settle failure never blocks the real run.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));

const mockCalls = [];
let mockUpdateResult = 1;
let mockUpdateError = null;
function mockChain(table) {
  const c = { table, wheres: [], update: null };
  const api = {
    where: jest.fn((...args) => { c.wheres.push(args); return api; }),
    update: jest.fn(async (patch) => { c.update = patch; mockCalls.push(c); if (mockUpdateError) throw mockUpdateError; return mockUpdateResult; }),
    insert: jest.fn(() => ({ returning: jest.fn(async () => [{ id: 'run-new' }]) })),
  };
  return api;
}
const mockDb = jest.fn((table) => mockChain(table));
mockDb.fn = { now: () => 'NOW()' };
jest.mock('../models/db', () => mockDb);

const audit = require('../services/auto-dispatch/audit');

describe('auto-dispatch startRun settles abandoned runs', () => {
  beforeEach(() => { mockCalls.length = 0; mockUpdateResult = 1; mockUpdateError = null; });

  test('flips running rows older than the stale floor to failed before inserting the new run', async () => {
    const before = Date.now();
    const runId = await audit.startRun({ mode: 'apply' }, 'cron');
    expect(runId).toBe('run-new');
    expect(mockCalls).toHaveLength(1);
    const settle = mockCalls[0];
    expect(settle.table).toBe('auto_dispatch_runs');
    expect(settle.wheres[0]).toEqual([{ status: 'running' }]);
    const [col, op, cutoff] = settle.wheres[1];
    expect(col).toBe('started_at');
    expect(op).toBe('<');
    const expectedCutoff = before - audit.STALE_RUNNING_MINUTES * 60 * 1000;
    expect(Math.abs(cutoff.getTime() - expectedCutoff)).toBeLessThan(5000);
    expect(settle.update.status).toBe('failed');
    expect(settle.update.completed_at).toBe('NOW()');
    expect(settle.update.error_message).toMatch(/process exited mid-run/);
  });

  test('a settle failure is swallowed and the run still starts', async () => {
    mockUpdateError = new Error('relation missing');
    await expect(audit.startRun({ mode: 'dry_run' }, 'manual')).resolves.toBe('run-new');
  });
});

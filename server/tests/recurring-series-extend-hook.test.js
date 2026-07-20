/**
 * Dispatch completion → recurring-series maintenance hook (fix: series
 * refill was dead code).
 *
 * Production completions flow through POST /admin/dispatch/:serviceId/complete
 * and PUT /admin/dispatch/:serviceId/status — neither historically ran the
 * auto-extend / plan-ending maintenance, so ongoing plans ran dry silently.
 * The bridge service (recurring-series-extend) is failure-isolated by
 * contract: it never throws into a committed completion.
 *
 * Unit tests cover the bridge; source-pattern guards (house style) pin both
 * dispatch call sites so a refactor can't silently drop them.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../routes/admin-schedule', () => ({
  runRecurringSeriesMaintenance: jest.fn(),
}));

const adminSchedule = require('../routes/admin-schedule');
const { runPostCompletionSeriesMaintenance } = require('../services/recurring-series-extend');

const dispatchSrc = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');

describe('runPostCompletionSeriesMaintenance bridge', () => {
  beforeEach(() => jest.clearAllMocks());

  test('delegates to the shared maintenance with (db, svc)', async () => {
    adminSchedule.runRecurringSeriesMaintenance.mockResolvedValue(undefined);
    const db = () => {};
    const svc = { id: 42, recurring_parent_id: 7, customer_id: 3 };
    await runPostCompletionSeriesMaintenance({ db, svc, source: 'dispatch_complete' });
    expect(adminSchedule.runRecurringSeriesMaintenance).toHaveBeenCalledTimes(1);
    expect(adminSchedule.runRecurringSeriesMaintenance).toHaveBeenCalledWith(db, svc);
  });

  test('NEVER throws — a failed extend must not fail the committed completion', async () => {
    adminSchedule.runRecurringSeriesMaintenance.mockRejectedValue(new Error('db exploded'));
    await expect(runPostCompletionSeriesMaintenance({
      db: () => {}, svc: { id: 42 }, source: 'dispatch_status_complete',
    })).resolves.toBeUndefined();
  });

  test('no-ops without a db or a service row', async () => {
    await runPostCompletionSeriesMaintenance({ db: null, svc: { id: 1 } });
    await runPostCompletionSeriesMaintenance({ db: () => {}, svc: null });
    await runPostCompletionSeriesMaintenance();
    expect(adminSchedule.runRecurringSeriesMaintenance).not.toHaveBeenCalled();
  });
});

describe('dispatch routes wire the hook (source guards)', () => {
  test('both completion paths require the bridge service', () => {
    const requires = dispatchSrc.match(/require\('\.\.\/services\/recurring-series-extend'\)/g) || [];
    expect(requires.length).toBe(2);
  });

  test('PUT /:serviceId/status completed branch fires the hook', () => {
    expect(dispatchSrc).toContain("source: 'dispatch_status_complete'");
    // The hook lives inside the completed branch, after the lead-conversion
    // block that already anchors it.
    const completedBranch = dispatchSrc.indexOf("source: 'service_completed', customerId: svc.customer_id });");
    const hook = dispatchSrc.indexOf("source: 'dispatch_status_complete'");
    expect(completedBranch).toBeGreaterThan(-1);
    expect(hook).toBeGreaterThan(completedBranch);
  });

  test('POST /:serviceId/complete fires the hook before the response payload', () => {
    const hook = dispatchSrc.indexOf("source: 'dispatch_complete'");
    expect(hook).toBeGreaterThan(-1);
    // The /complete response assembly follows the hook — i.e. the hook sits
    // inside the route, after completion success, before the payload build.
    const payloadAfterHook = dispatchSrc.indexOf('const responsePayload = {', hook);
    expect(payloadAfterHook).toBeGreaterThan(hook);
  });

  test('both call sites are try/caught (failure isolation at the route too)', () => {
    const pattern = /try\s*\{\s*const \{ runPostCompletionSeriesMaintenance \} = require\('\.\.\/services\/recurring-series-extend'\);/g;
    const guarded = dispatchSrc.match(pattern) || [];
    expect(guarded.length).toBe(2);
  });
});

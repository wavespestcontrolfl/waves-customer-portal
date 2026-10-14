/**
 * GATE_LAWN_FAST_COMPLETE: strict `=== 'true'`, read at call time, dark in every
 * environment, mirrored per service onto the schedule payload as
 * `lawnFastCompleteEnabled`; and the /complete wiring of the `lawnFast`
 * preflight.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => jest.fn(() => { throw new Error('linked-project lookup is optional'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: jest.fn(async () => null),
}));

const { lawnFastCompleteLive, isEnabled, gates } = require('../config/feature-gates');
const { loadProjectCompletionContextByServiceId } = require('../routes/admin-schedule');

describe('GATE_LAWN_FAST_COMPLETE', () => {
  const saved = process.env.GATE_LAWN_FAST_COMPLETE;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_LAWN_FAST_COMPLETE; else process.env.GATE_LAWN_FAST_COMPLETE = saved;
  });

  test('ships dark: unset is off', () => {
    delete process.env.GATE_LAWN_FAST_COMPLETE;
    expect(lawnFastCompleteLive()).toBe(false);
  });

  test('only an exact "true" turns it on, read at call time', () => {
    process.env.GATE_LAWN_FAST_COMPLETE = 'true';
    expect(lawnFastCompleteLive()).toBe(true);
    for (const value of ['1', 'on', 'TRUE', 'yes', 'false', '']) {
      process.env.GATE_LAWN_FAST_COMPLETE = value;
      expect(lawnFastCompleteLive()).toBe(false);
    }
  });

  test('is its own switch, separate from the lawn re-service, pest and T&S gates', () => {
    expect(Object.keys(gates)).toEqual(expect.arrayContaining(['lawnFastComplete', 'lawnReserviceFastComplete', 'reserviceFastComplete', 'tsFastComplete']));
    expect(isEnabled('lawnFastComplete')).toBe(false);
  });

  describe('schedule payload', () => {
    const services = [{ id: 'svc-1' }, { id: 'svc-2' }];
    const flags = async () => {
      const map = await loadProjectCompletionContextByServiceId(services, { userId: 'tech-1' });
      return [map.get('svc-1').lawnFastCompleteEnabled, map.get('svc-2').lawnFastCompleteEnabled];
    };

    test('gate on: true for every service', async () => {
      process.env.GATE_LAWN_FAST_COMPLETE = 'true';
      expect(await flags()).toEqual([true, true]);
    });

    test.each([undefined, '', 'false', '1', 'TRUE'])('gate %p: false', async (value) => {
      if (value === undefined) delete process.env.GATE_LAWN_FAST_COMPLETE; else process.env.GATE_LAWN_FAST_COMPLETE = value;
      expect(await flags()).toEqual([false, false]);
    });
  });

  test('every schedule payload that carries the lawn re-service flag carries the lawn flag too', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    const count = (re) => (src.match(re) || []).length;
    expect(count(/lawnFastCompleteEnabled:/g)).toBe(count(/lawnReserviceFastCompleteEnabled:/g));
    expect(count(/lawnFastCompleteEnabled: projectCompletionContext\.lawnFastCompleteEnabled === true/g)).toBe(2);
  });
});

describe('/complete wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'complete-scheduled-service.js'), 'utf8');

  test('a lawnFast block runs the lawn-fast preflight before the lawn assessment preflight, and a block ends the attempt', () => {
    const fast = src.indexOf("require('./lawn-fast-complete').preflightLawnFastCompletion");
    const assessment = src.indexOf('await preflightLawnAssessmentCompletion({');
    expect(fast).toBeGreaterThan(-1);
    expect(assessment).toBeGreaterThan(fast);
    const block = src.slice(fast, assessment);
    expect(block).toMatch(/markCompletionAttemptFailed/);
    expect(block).toMatch(/return \(\{ status: lawnFastBlock\.status, body: lawnFastBlock\.payload \}\)/);
  });

  test('the preflight gets the expectedVisit the main flow then compares on the locked row', () => {
    expect(src).toMatch(/preflightLawnFastCompletion\(\{[^}]*expectedVisit,[^}]*\}\)/s);
    expect(src).toMatch(/recapVisitIdentityChanged\(expectedVisit, lockedSvcRow, snapshotCustomerRow\)/);
  });

  test('the lawnFast block itself reaches the preflight (it carries the visitType the sheet opened with)', () => {
    expect(src).toMatch(/preflightLawnFastCompletion\(\{[^}]*lawnFast,[^}]*\}\)/s);
  });

  describe('the locked-row visit-type check (source order, like the other locked-row compares)', () => {
    const lockAt = src.indexOf("const lockedSvcRow = await trx('scheduled_services').where({ id: svc.id }).forUpdate().first();");
    const identityAt = src.indexOf("require('./pest-recap').recapVisitIdentityChanged(expectedVisit, lockedSvcRow, snapshotCustomerRow)");
    const callAt = src.indexOf("assertLawnFastVisitTypeUnderLock({ trx, lockedCustomer: snapshotCustomerRow, lockedSvc: lockedSvcRow, lawnFast })");

    test('runs right after the main flow\'s locked identity compare, on the locked rows, only for a lawnFast block that is not an incomplete outcome', () => {
      expect(lockAt).toBeGreaterThan(-1);
      expect(identityAt).toBeGreaterThan(lockAt);
      expect(callAt).toBeGreaterThan(identityAt);
      expect(callAt - identityAt).toBeLessThan(600);
      expect(src.slice(identityAt, callAt)).toMatch(/if \(lawnFast != null && !isIncompleteVisit\) \{/);
    });

    test('the new-sod no-product claim: the sod record\'s advisory lock is the FIRST lock of the commit transaction, the recheck runs on the locked rows beside the visit-type check', () => {
      const persistAt = src.indexOf('const persistRecord = async (trx) => {');
      const lockCallAt = src.indexOf("require('./lawn-sod-sheet').lockSodRecordForNoProduct(trx, {");
      const mintAt = src.indexOf('if (systemQuietCloseout) {', persistAt);
      const shareAt = src.indexOf("const snapshotCustomerRow = await trx('customers')", persistAt);
      const assertAt = src.indexOf("require('./lawn-sod-sheet').assertNoProductUnderLock(trx, { svc, technicianNotes })");
      expect(persistAt).toBeGreaterThan(-1);
      // Before every other lock in the transaction: the mint lock, the invoice gate, baseline, estimate, customer, visit.
      expect(lockCallAt).toBeGreaterThan(persistAt);
      expect(lockCallAt).toBeLessThan(mintAt);
      expect(mintAt).toBeLessThan(shareAt);
      // After the visit-type check, on the locked rows, inside the same `lawnFast` block.
      expect(assertAt).toBeGreaterThan(callAt);
      expect(assertAt - callAt).toBeLessThan(600);
      expect(src.slice(callAt, assertAt)).not.toMatch(/\n          \}\n/);
      expect(src.slice(lockCallAt, lockCallAt + 300)).toContain('lawnFast, isIncompleteVisit, products, technicianNotes');
    });

    test('a stale claim rolls the completion back and answers 409 lawn_sod_no_product_stale, releasing the claim', () => {
      const at = src.indexOf("if (err && err.code === 'lawn_sod_no_product_stale') {");
      expect(at).toBeGreaterThan(-1);
      const block = src.slice(at, at + 400);
      expect(block).toContain('markCompletionAttemptFailed(completionAttempt, err, db)');
      expect(block).toContain('status: 409');
      expect(block).toContain('NO_PRODUCT_STALE.payload');
    });

    test('adds one column to the existing customer FOR SHARE read, only where the column exists, and no second lock or query', () => {
      const shareAt = src.indexOf("const snapshotCustomerRow = await trx('customers')");
      const read = src.slice(shareAt, src.indexOf('if (completionPricingPlan) {', shareAt));
      expect(read).toContain('.forShare()');
      expect(read).toContain("...(billingModeColumnsExist ? ['billing_mode'] : [])");
      expect((read.match(/trx\(/g) || []).length).toBe(1);
    });

    test('both abort codes release the claim; a changed type answers 409 with its reason, an unreadable one 503', () => {
      const changedAt = src.indexOf("if (err && err.code === 'visit_identity_changed') {");
      const changed = src.slice(changedAt, src.indexOf("if (err && err.code === 'lawn_fast_visit_type_unavailable') {", changedAt));
      expect(changed).toContain('markCompletionAttemptFailed(completionAttempt, err, db)');
      expect(changed).toContain("...(err.reason ? { reason: err.reason } : {})");
      const unavailableAt = src.indexOf("if (err && err.code === 'lawn_fast_visit_type_unavailable') {");
      const unavailable = src.slice(unavailableAt, src.indexOf("if (err && err.code === 'trace_changed') {", unavailableAt));
      expect(unavailable).toContain('markCompletionAttemptFailed(completionAttempt, err, db)');
      expect(unavailable).toContain('status: 503');
    });
  });

  test('only a body that carries the block is judged', () => {
    expect(src).toMatch(/^\s+lawnFast = null,$/m);
    expect(src).toMatch(/if \(lawnFast !== null && lawnFast !== undefined\)/);
  });
});

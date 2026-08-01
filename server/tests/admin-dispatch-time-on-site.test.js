/**
 * Admin time-on-site correction (forgotten-closeout fix).
 *
 * Two legs, both admin-only, both validated fail-closed:
 *  - LIVE override: a NUMERIC timeOnSite on a non-backfill completion is an
 *    admin-typed correction of the running timer (the panel's auto-elapsed
 *    string stays the unchanged default). 403 for a technician token — the
 *    tech portal never sends numbers, so a number there is tampering or a
 *    client bug. 400 out-of-range — the admin is live at the panel, unlike
 *    backfill's degrade-to-unknown posture.
 *  - AFTER-THE-FACT edit: PATCH /:serviceId/time-on-site corrects a
 *    completed row's recorded duration. Pure data write — no status
 *    transition, no markComplete, NO customer communications.
 *
 * Mirrors the backfill suite's three layers: pure helpers from the route's
 * _test bag composed with the real collaborators, source-contract pins on
 * the route wiring, and a behavioral drive of the PATCH handler against a
 * scripted knex mock.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

// The PATCH behavioral tests drive the real route handler — the module-level
// db is swapped per test via this holder (permissive default so the huge
// route module's dependency tree loads without a database).
let mockDbCurrent = null;
jest.mock('../models/db', () => {
  const defaultChain = () => {
    const chain = {};
    const methods = [
      'where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'andWhere',
      'orWhere', 'join', 'leftJoin', 'select', 'orderBy', 'groupBy', 'limit',
      'offset', 'update', 'insert', 'del', 'onConflict', 'merge', 'ignore',
    ];
    for (const m of methods) chain[m] = () => chain;
    chain.first = async () => null;
    chain.returning = async () => [];
    chain.count = async () => [{ count: 0 }];
    chain.columnInfo = async () => ({});
    chain.then = (resolve) => Promise.resolve([]).then(resolve);
    chain.catch = () => chain;
    return chain;
  };
  const proxy = (...args) => (mockDbCurrent ? mockDbCurrent(...args) : defaultChain());
  proxy.transaction = (...args) => (mockDbCurrent?.transaction
    ? mockDbCurrent.transaction(...args)
    : Promise.resolve());
  proxy.raw = (...args) => (mockDbCurrent?.raw ? mockDbCurrent.raw(...args) : {});
  proxy.fn = { now: () => new Date() };
  proxy.schema = { hasTable: async () => true, hasColumn: async () => true };
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/job-costing', () => ({ calculateJobCost: jest.fn(async () => ({})) }));

const fs = require('fs');
const path = require('path');

const router = require('../routes/admin-dispatch');
const {
  liveTimeOnSitePlan,
  adjustedCompletionEndInstant,
  timeOnSiteEditPlan,
  backfillTimeOnSiteMinutes,
  BACKFILL_MAX_TIME_ON_SITE_MINUTES,
} = require('../routes/admin-dispatch')._test;
const { buildCompletionLifecycleUpdates } = require('../utils/service-duration-capture');
const JobCosting = require('../services/job-costing');

const source = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('liveTimeOnSitePlan — the live-override intake gate', () => {
  test('string elapsed passes through untouched for ANY role — the unchanged default', () => {
    for (const role of ['admin', 'technician', undefined]) {
      expect(liveTimeOnSitePlan({ timeOnSite: '2:19:05', role }))
        .toEqual({ adjusted: false, effectiveTimeOnSite: '2:19:05' });
    }
    expect(liveTimeOnSitePlan({ timeOnSite: undefined, role: 'technician' }))
      .toEqual({ adjusted: false, effectiveTimeOnSite: undefined });
  });

  test('numeric value from a non-admin → 403 time_on_site_admin_only, fail-closed', () => {
    for (const role of ['technician', undefined, null, 'other']) {
      const plan = liveTimeOnSitePlan({ timeOnSite: 45, role });
      expect(plan.adjusted).toBe(false);
      expect(plan.status).toBe(403);
      expect(plan.error.code).toBe('time_on_site_admin_only');
    }
  });

  test('numeric value from an admin → adjusted, sanitized minutes', () => {
    expect(liveTimeOnSitePlan({ timeOnSite: 45, role: 'admin' }))
      .toEqual({ adjusted: true, effectiveTimeOnSite: 45 });
    expect(liveTimeOnSitePlan({ timeOnSite: 45.4, role: 'admin' }))
      .toEqual({ adjusted: true, effectiveTimeOnSite: 45 });
    expect(liveTimeOnSitePlan({ timeOnSite: BACKFILL_MAX_TIME_ON_SITE_MINUTES, role: 'admin' }))
      .toEqual({ adjusted: true, effectiveTimeOnSite: BACKFILL_MAX_TIME_ON_SITE_MINUTES });
  });

  test('out-of-range admin value → 400 time_on_site_invalid, never silently degraded', () => {
    for (const bad of [0, -5, BACKFILL_MAX_TIME_ON_SITE_MINUTES + 1, NaN]) {
      const plan = liveTimeOnSitePlan({ timeOnSite: bad, role: 'admin' });
      expect(plan.adjusted).toBe(false);
      expect(plan.status).toBe(400);
      expect(plan.error.code).toBe('time_on_site_invalid');
    }
  });

  test('backfill mode passes through — the backfill sanitizer owns that branch', () => {
    expect(liveTimeOnSitePlan({ timeOnSite: 45, role: 'technician', backfill: true }))
      .toEqual({ adjusted: false, effectiveTimeOnSite: 45 });
    expect(liveTimeOnSitePlan({ timeOnSite: 5000, role: 'admin', backfill: true }))
      .toEqual({ adjusted: false, effectiveTimeOnSite: 5000 });
  });
});

describe('adjustedCompletionEndInstant — the honest end for a typed duration', () => {
  const CHECKED_IN = {
    status: 'on_site',
    actual_start_time: '2026-07-19T16:00:00Z',
    check_in_time: '2026-07-19T16:00:00Z',
  };
  const NOW = new Date('2026-07-19T18:22:00Z'); // timer shows 2:22

  test('real row-backed start + typed minutes → start + minutes', () => {
    expect(adjustedCompletionEndInstant(CHECKED_IN, 45, NOW))
      .toEqual(new Date('2026-07-19T16:45:00Z'));
  });

  test('typed minutes exceeding the actual elapsed → null (no future end stamp)', () => {
    expect(adjustedCompletionEndInstant(CHECKED_IN, 200, NOW)).toBeNull();
    // Exactly-now is allowed — not in the future.
    expect(adjustedCompletionEndInstant(CHECKED_IN, 142, NOW))
      .toEqual(new Date('2026-07-19T18:22:00Z'));
  });

  test('no row-backed start → null (the shared helper infers start = end − minutes instead)', () => {
    expect(adjustedCompletionEndInstant({ status: 'confirmed' }, 45, NOW)).toBeNull();
  });

  test('invalid minutes → null', () => {
    expect(adjustedCompletionEndInstant(CHECKED_IN, 0, NOW)).toBeNull();
    expect(adjustedCompletionEndInstant(CHECKED_IN, 5000, NOW)).toBeNull();
  });
});

describe('timeOnSiteEditPlan — the after-the-fact edit gate', () => {
  const COMPLETED = {
    status: 'completed',
    actual_start_time: '2026-07-19T16:00:00Z',
    check_in_time: '2026-07-19T16:00:00Z',
  };
  const NOW = new Date('2026-07-20T12:00:00Z');

  test('invalid minutes → 400 time_on_site_invalid', () => {
    for (const bad of [0, -5, 721, 'abc', null, undefined, '']) {
      const plan = timeOnSiteEditPlan({ minutes: bad, service: COMPLETED, now: NOW });
      expect(plan.status).toBe(400);
      expect(plan.error.code).toBe('time_on_site_invalid');
    }
  });

  test('non-completed row → 409 service_not_completed (open rows correct at close-out)', () => {
    for (const status of ['pending', 'confirmed', 'en_route', 'on_site', 'cancelled', 'no_show']) {
      const plan = timeOnSiteEditPlan({ minutes: 45, service: { ...COMPLETED, status }, now: NOW });
      expect(plan.status).toBe(409);
      expect(plan.error.code).toBe('service_not_completed');
    }
  });

  test('completed row with a real start → minutes + newEnd = start + minutes', () => {
    const plan = timeOnSiteEditPlan({ minutes: 45, service: COMPLETED, now: NOW });
    expect(plan.error).toBeUndefined();
    expect(plan.minutes).toBe(45);
    expect(plan.newEnd).toEqual(new Date('2026-07-19T16:45:00Z'));
    expect(plan.isBackfillRecord).toBe(false);
  });

  test('rounding: fractional input lands as an integer', () => {
    expect(timeOnSiteEditPlan({ minutes: '45.6', service: COMPLETED, now: NOW }).minutes).toBe(46);
  });

  test('backfilled record with no start → duration only, no fabricated stamps', () => {
    const plan = timeOnSiteEditPlan({
      minutes: 45,
      service: { status: 'completed' },
      structuredNotes: { backfill: true },
      now: NOW,
    });
    expect(plan.minutes).toBe(45);
    expect(plan.newEnd).toBeNull();
    expect(plan.isBackfillRecord).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Composition with the real lifecycle builder
// ---------------------------------------------------------------------------

describe('live override composed with buildCompletionLifecycleUpdates', () => {
  const CHECKED_IN = {
    status: 'on_site',
    actual_start_time: '2026-07-19T16:00:00Z',
    check_in_time: '2026-07-19T16:00:00Z',
  };
  const NOW = new Date('2026-07-19T18:22:00Z');

  test('adjusted instant + typed minutes → durations AND end stamps agree with the operator', () => {
    const endAt = adjustedCompletionEndInstant(CHECKED_IN, 45, NOW);
    const updates = buildCompletionLifecycleUpdates(CHECKED_IN, endAt, { elapsed: 45 });
    expect(updates.service_time_minutes).toBe(45);
    expect(updates.actual_duration_minutes).toBe(45);
    expect(updates.actual_end_time).toEqual(new Date('2026-07-19T16:45:00Z'));
    expect(updates.check_out_time).toEqual(new Date('2026-07-19T16:45:00Z'));
    // The timestamp pair now re-derives the SAME duration every reader sees.
    expect(Math.round((updates.actual_end_time - new Date(CHECKED_IN.actual_start_time)) / 60000))
      .toBe(45);
  });

  test('clamped shape (typed > elapsed): wall-clock end stays, explicit duration columns win', () => {
    expect(adjustedCompletionEndInstant(CHECKED_IN, 200, NOW)).toBeNull();
    const updates = buildCompletionLifecycleUpdates(CHECKED_IN, NOW, { elapsed: 200 });
    expect(updates.service_time_minutes).toBe(200);
    expect(updates.actual_duration_minutes).toBe(200);
    expect(updates.actual_end_time).toEqual(NOW);
  });

  test('no-start quick-complete: the helper back-derives the start from the typed minutes', () => {
    const updates = buildCompletionLifecycleUpdates({ status: 'confirmed' }, NOW, { elapsed: 45 });
    expect(updates.service_time_minutes).toBe(45);
    expect(updates.actual_start_time).toEqual(new Date(NOW.getTime() - 45 * 60000));
  });

  test('the live sanitizer and the backfill sanitizer are the same 1..720 rule', () => {
    expect(backfillTimeOnSiteMinutes(45)).toBe(45);
    expect(backfillTimeOnSiteMinutes(721)).toBeNull();
    expect(liveTimeOnSitePlan({ timeOnSite: 721, role: 'admin' }).error.code)
      .toBe('time_on_site_invalid');
  });
});

// ---------------------------------------------------------------------------
// Source-contract pins on the route wiring
// ---------------------------------------------------------------------------

describe('route wiring contracts', () => {
  test('the live plan gates intake AFTER the backfill plan and BEFORE anything commits', () => {
    expect(source).toMatch(/const livePlan = liveTimeOnSitePlan\(\{ timeOnSite, role: req\.techRole, backfill: isBackfillCompletion \}\);/);
    expect(source).toMatch(/if \(livePlan\.error\) \{\s*\n\s*return res\.status\(livePlan\.status\)\.json\(livePlan\.error\);/);
    const backfillPlanAt = source.indexOf('backfillCompletionPlan({ backfill, scheduledDate: svc.scheduled_date');
    const livePlanAt = source.indexOf('const livePlan = liveTimeOnSitePlan(');
    const completionTrxAt = source.indexOf('const completionEndedAt = new Date();');
    expect(backfillPlanAt).toBeGreaterThan(-1);
    expect(livePlanAt).toBeGreaterThan(backfillPlanAt);
    expect(completionTrxAt).toBeGreaterThan(livePlanAt);
  });

  test('the adjusted end instant sits after backfill in the lifecycle fallback chain', () => {
    expect(source).toMatch(/const adjustedEndedAt = !isBackfillCompletion && liveAdjustedTimeOnSite\s*\n\s*\? adjustedCompletionEndInstant\(svc, effectiveTimeOnSite, completionEndedAt\)\s*\n\s*: null;\s*\n\s*const completionLifecycleAt = backfillEndedAt \|\| adjustedEndedAt \|\| completionEndedAt;/);
  });

  test('the adjusted marker freezes into structured_notes beside the backfill marker', () => {
    expect(source).toMatch(/\.\.\.\(liveAdjustedTimeOnSite \? \{ timeOnSiteAdjusted: true \} : \{\}\),/);
  });

  test('PATCH /:serviceId/time-on-site is registered with requireAdmin in its chain', () => {
    const layer = router.stack.find(
      (l) => l.route && l.route.path === '/:serviceId/time-on-site' && l.route.methods.patch,
    );
    expect(layer).toBeTruthy();
    expect(layer.route.stack.map((s) => s.handle.name)).toContain('requireAdmin');
  });

  test('the PATCH block is a pure data write: pdf invalidation yes, comms/transitions never', () => {
    const start = source.indexOf("router.patch('/:serviceId/time-on-site'");
    expect(start).toBeGreaterThan(-1);
    // Slice to the handler's own closing (catch + router-close), not the next
    // `router.` token — the following route's doc comment sits between them
    // and legitimately mentions transition machinery.
    const closer = '} catch (err) { next(err); }\n});';
    const end = source.indexOf(closer, start);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end + closer.length);
    expect(block).toMatch(/pdf_storage_key = null|pdf_storage_key: null/);
    expect(block).toMatch(/service_time_minutes: plan\.minutes,\s*\n\s*actual_duration_minutes: plan\.minutes,/);
    // Both timestamp families + completed_at move together, or not at all.
    expect(block).toMatch(/serviceUpdate\.actual_end_time = plan\.newEnd;\s*\n\s*serviceUpdate\.check_out_time = plan\.newEnd;\s*\n\s*serviceUpdate\.completed_at = plan\.newEnd;/);
    for (const forbidden of [
      'sendCustomerMessage',
      'sendCompletionSms',
      'markComplete',
      'transitionJobStatus',
      'notifyCustomer',
      'twilio',
    ]) {
      expect(block).not.toMatch(new RegExp(forbidden, 'i'));
    }
  });
});

// ---------------------------------------------------------------------------
// Behavioral: the PATCH handler against a scripted knex mock
// ---------------------------------------------------------------------------

function makeRecordingDb({ svc, record, recordCols }) {
  const calls = [];
  const chainFor = (table) => {
    const op = { table };
    calls.push(op);
    const chain = {
      where(criteria) { op.whereCriteria = criteria; return chain; },
      orderBy(col, dir) { op.orderBy = [col, dir]; return chain; },
      async first() {
        if (table === 'scheduled_services') return svc;
        if (table === 'service_records') return record;
        return null;
      },
      async update(payload) { op.updatePayload = payload; return 1; },
      async insert(payload) { op.insertPayload = payload; return [1]; },
      async columnInfo() { return recordCols; },
    };
    // The record fetch tacks .catch() onto .first()'s promise via the route's
    // inline chain — expose catch on the chain too for the query-level guard.
    chain.catch = () => chain;
    return chain;
  };
  const dbMock = (table) => chainFor(table);
  dbMock.transaction = async (fn) => fn((table) => chainFor(table));
  dbMock.calls = calls;
  return dbMock;
}

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

function patchHandler() {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === '/:serviceId/time-on-site' && l.route.methods.patch,
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const RECORD_COLS = {
  id: {}, structured_notes: {}, pdf_storage_key: {},
  ended_at: {}, completed_at: {}, actual_end_time: {}, check_out_time: {},
};

describe('PATCH /:serviceId/time-on-site — behavioral', () => {
  afterEach(() => { mockDbCurrent = null; jest.clearAllMocks(); });

  const COMPLETED_SVC = {
    id: 'svc-1',
    customer_id: 'cust-1',
    status: 'completed',
    service_type: 'pest',
    actual_start_time: '2026-07-19T16:00:00Z',
    check_in_time: '2026-07-19T16:00:00Z',
    service_time_minutes: 139,
    actual_duration_minutes: 139,
  };
  const RECORD = {
    id: 'rec-1',
    structured_notes: JSON.stringify({ visitOutcome: 'completed', timeOnSite: '2:19:05' }),
  };

  test('happy path: durations, end stamps, structured_notes, pdf invalidation, costing, audit', async () => {
    const dbMock = makeRecordingDb({ svc: COMPLETED_SVC, record: RECORD, recordCols: RECORD_COLS });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { minutes: 45 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      timeOnSiteMinutes: 45,
      endStampsRewritten: true,
      recordUpdated: true,
    });

    const svcUpdate = dbMock.calls.find((c) => c.table === 'scheduled_services' && c.updatePayload);
    expect(svcUpdate.whereCriteria).toEqual({ id: 'svc-1' });
    expect(svcUpdate.updatePayload.service_time_minutes).toBe(45);
    expect(svcUpdate.updatePayload.actual_duration_minutes).toBe(45);
    const expectedEnd = new Date('2026-07-19T16:45:00Z');
    expect(svcUpdate.updatePayload.actual_end_time).toEqual(expectedEnd);
    expect(svcUpdate.updatePayload.check_out_time).toEqual(expectedEnd);
    expect(svcUpdate.updatePayload.completed_at).toEqual(expectedEnd);

    const recUpdate = dbMock.calls.find((c) => c.table === 'service_records' && c.updatePayload);
    expect(recUpdate.whereCriteria).toEqual({ id: 'rec-1' });
    expect(recUpdate.updatePayload.pdf_storage_key).toBeNull();
    expect(recUpdate.updatePayload.ended_at).toEqual(expectedEnd);
    expect(recUpdate.updatePayload.completed_at).toEqual(expectedEnd);
    const notes = JSON.parse(recUpdate.updatePayload.structured_notes);
    expect(notes.timeOnSite).toBe(45);
    expect(notes.timeOnSiteAdjusted).toBe(true);
    expect(notes.timeOnSitePrior).toBe('2:19:05'); // first pre-edit value preserved
    expect(notes.visitOutcome).toBe('completed'); // merge, not replace

    expect(JobCosting.calculateJobCost).toHaveBeenCalledWith('svc-1');
    const audit = dbMock.calls.find((c) => c.table === 'activity_log');
    expect(audit.insertPayload.action).toBe('time_on_site_adjusted');
    expect(audit.insertPayload.admin_user_id).toBe('admin-1');
    expect(JSON.parse(audit.insertPayload.metadata)).toMatchObject({
      scheduled_service_id: 'svc-1',
      previous_minutes: 139,
      new_minutes: 45,
      end_stamps_rewritten: true,
    });
  });

  test('a repeat edit never overwrites timeOnSitePrior — the original stays the audit baseline', async () => {
    const editedOnce = {
      id: 'rec-1',
      structured_notes: JSON.stringify({
        timeOnSite: 45, timeOnSiteAdjusted: true, timeOnSitePrior: '2:19:05',
      }),
    };
    const dbMock = makeRecordingDb({ svc: COMPLETED_SVC, record: editedOnce, recordCols: RECORD_COLS });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { minutes: 50 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    const recUpdate = dbMock.calls.find((c) => c.table === 'service_records' && c.updatePayload);
    const notes = JSON.parse(recUpdate.updatePayload.structured_notes);
    expect(notes.timeOnSite).toBe(50);
    expect(notes.timeOnSitePrior).toBe('2:19:05');
  });

  test('backfilled no-start row: durations + notes only, no timestamps fabricated', async () => {
    const backfilledSvc = {
      id: 'svc-2', customer_id: 'cust-1', status: 'completed', service_type: 'pest',
      service_time_minutes: null, actual_duration_minutes: null,
    };
    const backfilledRecord = {
      id: 'rec-2',
      structured_notes: JSON.stringify({ backfill: true }),
    };
    const dbMock = makeRecordingDb({ svc: backfilledSvc, record: backfilledRecord, recordCols: RECORD_COLS });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-2' }, body: { minutes: 45 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(res.body.endStampsRewritten).toBe(false);
    const svcUpdate = dbMock.calls.find((c) => c.table === 'scheduled_services' && c.updatePayload);
    expect(svcUpdate.updatePayload.service_time_minutes).toBe(45);
    expect(svcUpdate.updatePayload.actual_end_time).toBeUndefined();
    expect(svcUpdate.updatePayload.completed_at).toBeUndefined();
    const recUpdate = dbMock.calls.find((c) => c.table === 'service_records' && c.updatePayload);
    expect(recUpdate.updatePayload.ended_at).toBeUndefined();
    const notes = JSON.parse(recUpdate.updatePayload.structured_notes);
    expect(notes.backfill).toBe(true); // durable marker survives the merge
    expect(notes.timeOnSite).toBe(45);
  });

  test('open row → 409; junk minutes → 400; unknown service → 404', async () => {
    const openSvc = { ...COMPLETED_SVC, status: 'on_site' };
    mockDbCurrent = makeRecordingDb({ svc: openSvc, record: null, recordCols: RECORD_COLS });
    let res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { minutes: 45 }, technicianId: 'a', techRole: 'admin' },
      res, (err) => { throw err; },
    );
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('service_not_completed');

    mockDbCurrent = makeRecordingDb({ svc: COMPLETED_SVC, record: RECORD, recordCols: RECORD_COLS });
    res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { minutes: 5000 }, technicianId: 'a', techRole: 'admin' },
      res, (err) => { throw err; },
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('time_on_site_invalid');

    mockDbCurrent = makeRecordingDb({ svc: null, record: null, recordCols: RECORD_COLS });
    res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'nope' }, body: { minutes: 45 }, technicianId: 'a', techRole: 'admin' },
      res, (err) => { throw err; },
    );
    expect(res.statusCode).toBe(404);
  });

  test('a legacy row with no service_record still corrects the scheduled_services columns', async () => {
    const dbMock = makeRecordingDb({ svc: COMPLETED_SVC, record: null, recordCols: RECORD_COLS });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { minutes: 45 }, technicianId: 'a', techRole: 'admin' },
      res, (err) => { throw err; },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.recordUpdated).toBe(false);
    expect(dbMock.calls.find((c) => c.table === 'scheduled_services' && c.updatePayload)).toBeTruthy();
    expect(dbMock.calls.find((c) => c.table === 'service_records' && c.updatePayload)).toBeUndefined();
  });
});

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
// calculateJobCost is mocked (the route awaits it post-commit) but
// resolveServiceRecord stays REAL — the PATCH behavioral tests exercise the
// actual FK-then-legacy resolution against the scripted db.
jest.mock('../services/job-costing', () => ({
  calculateJobCost: jest.fn(async () => ({})),
  resolveServiceRecord: jest.requireActual('../services/job-costing').resolveServiceRecord,
}));

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
// The REAL labor calculator (the module is jest.mocked above for the route's
// post-commit recalc) — override semantics are tested against the actual code.
const { calcLaborCost: realCalcLaborCost } = jest.requireActual('../services/job-costing');
const { timeOnSiteAdjustedPdfSignature } = require('../services/service-report/pdf-storage');

const source = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');
const costingSource = fs.readFileSync(path.join(__dirname, '../services/job-costing.js'), 'utf8');
const pdfQueueSource = fs.readFileSync(path.join(__dirname, '../services/service-report/pdf-queue.js'), 'utf8');
const reportsPublicSource = fs.readFileSync(path.join(__dirname, '../routes/reports-public.js'), 'utf8');

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

  test('a row that ALREADY carries an end stamp: the helper keeps the stale end — the route must force the adjusted instant (codex P2 round 3)', () => {
    // Hazard proof: buildCompletionLifecycleUpdates prefers a row-backed end
    // over its `at` argument, so a legacy operational completion being
    // finalized later would keep its inflated end while the duration columns
    // took the typed minutes — and every start→end pair reader would still
    // derive the stale span.
    const staleEnd = '2026-07-19T18:19:05Z';
    const withEnd = { ...CHECKED_IN, actual_end_time: staleEnd, check_out_time: staleEnd };
    const adjusted = adjustedCompletionEndInstant(withEnd, 45, NOW);
    const updates = buildCompletionLifecycleUpdates(withEnd, adjusted, { elapsed: 45 });
    expect(updates.actual_end_time).toEqual(new Date(staleEnd)); // the hazard
    // The route's live-adjusted branch forces the kept end fields:
    updates.actual_end_time = adjusted;
    updates.check_out_time = adjusted;
    expect(updates.actual_end_time).toEqual(new Date('2026-07-19T16:45:00Z'));
    expect(Math.round((updates.actual_end_time - new Date(withEnd.actual_start_time)) / 60000)).toBe(45);
    // And the route wiring pins the force to the live-adjusted branch only —
    // which ALSO stamps the durable row column the costing fence and the
    // no-opts labor override read, even when the end instant was clamped
    // (codex P2 round 11).
    expect(source).toMatch(/if \(!isBackfillCompletion && liveAdjustedTimeOnSite\) \{\s*\n\s*if \(adjustedEndedAt\) \{\s*\n\s*lifecycleUpdates\.actual_end_time = adjustedEndedAt;\s*\n\s*lifecycleUpdates\.check_out_time = adjustedEndedAt;\s*\n\s*\}/);
    expect(source).toMatch(/lifecycleUpdates\.time_on_site_adjusted_minutes = effectiveTimeOnSite;/);
  });

  test('markComplete honors a caller-supplied trusted instant — the adjusted end reaches completed_at (codex P2 round 11)', () => {
    const trackerSource = fs.readFileSync(
      path.join(__dirname, '../services/track-transitions.js'),
      'utf8',
    );
    // Trusted path: finite opts.completedAt wins, wall clock only as the
    // fallback — so the live override's adjusted instant is not discarded.
    // Untrusted (backfill) branch byte-identical to its prior contract.
    expect(trackerSource).toMatch(/const completedAtStamp = opts\.untrustedLifecycleSpan\s*\n\s*\? finiteDate\(opts\.completedAt\)\s*\n\s*: \(finiteDate\(opts\.completedAt\) \|\| now\);/);
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

function makeRecordingDb({ svc, record, recordCols, recordLookupError = null, legacyRows = null, columnInfoError = null }) {
  // `record` answers resolveServiceRecord's FK query (.first()); `legacyRows`
  // (when set) answers its awaited (customer, date, type) soft-join, so the
  // pre-FK shapes exercise the REAL legacy resolution path.
  const calls = [];
  const chainFor = (table) => {
    const op = { table };
    calls.push(op);
    const chain = {
      where(criteria) { op.whereCriteria = criteria; return chain; },
      orderBy(col, dir) { op.orderBy = [col, dir]; return chain; },
      limit(n) { op.limited = n; return chain; },
      count(spec) { op.counted = spec; return chain; },
      forUpdate() { op.locked = true; return chain; },
      async first() {
        if (table === 'scheduled_services') return op.counted ? { c: 1 } : svc;
        if (table === 'service_records') {
          if (recordLookupError) throw recordLookupError;
          return record;
        }
        return null;
      },
      async update(payload) { op.updatePayload = payload; return 1; },
      async insert(payload) { op.insertPayload = payload; return [1]; },
      async columnInfo() {
        if (columnInfoError) throw columnInfoError;
        return recordCols;
      },
      then(resolve, reject) {
        return Promise.resolve(table === 'service_records' && op.limited ? (legacyRows || []) : [])
          .then(resolve, reject);
      },
    };
    chain.catch = () => chain;
    return chain;
  };
  const trxFn = (table) => chainFor(table);
  trxFn.raw = (sql, bindings) => ({ __raw: true, sql, bindings });
  const dbMock = (table) => chainFor(table);
  dbMock.transaction = async (fn) => fn(trxFn);
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
  id: {}, structured_notes: {}, pdf_storage_key: {}, scheduled_service_id: {},
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
      costingUpdated: true,
    });

    const svcUpdate = dbMock.calls.find((c) => c.table === 'scheduled_services' && c.updatePayload);
    expect(svcUpdate.whereCriteria).toEqual({ id: 'svc-1' });
    expect(svcUpdate.updatePayload.service_time_minutes).toBe(45);
    expect(svcUpdate.updatePayload.actual_duration_minutes).toBe(45);
    // Durable row stamp — the marker that survives even with no report
    // record to carry structured_notes (codex P2 round 5).
    expect(svcUpdate.updatePayload.time_on_site_adjusted_minutes).toBe(45);
    const expectedEnd = new Date('2026-07-19T16:45:00Z');
    expect(svcUpdate.updatePayload.actual_end_time).toEqual(expectedEnd);
    expect(svcUpdate.updatePayload.check_out_time).toEqual(expectedEnd);
    expect(svcUpdate.updatePayload.completed_at).toEqual(expectedEnd);

    const recUpdate = dbMock.calls.find((c) => c.table === 'service_records' && c.updatePayload);
    expect(recUpdate.whereCriteria).toEqual({ id: 'rec-1' });
    expect(recUpdate.updatePayload.pdf_storage_key).toBeNull();
    expect(recUpdate.updatePayload.ended_at).toEqual(expectedEnd);
    expect(recUpdate.updatePayload.completed_at).toEqual(expectedEnd);
    // ATOMIC merge (codex P1 #3152): structured_notes is a single-statement
    // jsonb expression — only the correction keys travel, so a concurrent
    // full-column writer's keys (completionSmsStatus, photo notes) can never
    // be erased by this edit. The expression's semantics (sibling-key
    // preservation, first-edit-only timeOnSitePrior capture incl. the
    // JSON-null prior, NULL column) were executed and verified against a
    // real PostgreSQL 16 instance during development.
    const notesRaw = recUpdate.updatePayload.structured_notes;
    expect(notesRaw.__raw).toBe(true);
    expect(notesRaw.sql).toMatch(/\|\| \?::jsonb/);
    expect(notesRaw.sql).toMatch(/COALESCE\(structured_notes::jsonb, '\{\}'::jsonb\)/);
    expect(notesRaw.sql).toMatch(/CASE WHEN [\s\S]*-> 'timeOnSitePrior' IS NOT NULL\s*\n\s*THEN '\{\}'::jsonb/);
    expect(notesRaw.sql).toMatch(/jsonb_build_object\('timeOnSitePrior', COALESCE\(structured_notes::jsonb -> 'timeOnSite', 'null'::jsonb\)\)/);
    expect(notesRaw.bindings).toEqual([JSON.stringify({ timeOnSite: 45, timeOnSiteAdjusted: true })]);

    // An FK-linked record needs no heal — the linkage column stays untouched.
    expect(recUpdate.updatePayload.scheduled_service_id).toBeUndefined();

    // NO request-local minutes (codex P2 round 7): the recalc re-derives
    // from the durable row stamp committed in the same transaction, so
    // interleaved recalcs from concurrent corrections converge on the
    // newest committed value instead of the last-finishing request's.
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
    // The prior minutes were read from the LOCKED row inside the trx
    // (codex P2 round 10) — concurrent corrections serialize on the lock,
    // so each audit records the value it actually superseded.
    const lockedRead = dbMock.calls.find((c) => c.table === 'scheduled_services' && c.locked);
    expect(lockedRead).toBeTruthy();
    expect(source).toMatch(/const lockedSvc = await trx\('scheduled_services'\)\.where\(\{ id: svc\.id \}\)\.forUpdate\(\)\.first\(\);\s*\n\s*previousMinutes = positiveNumber\(lockedSvc\?\.service_time_minutes\)/);
  });

  test('the tracker completed_at carries the adjusted instant for live corrections (codex P2 round 10)', () => {
    // Date-window readers prefer completed_at over the corrected end
    // columns — a correction crossing an ET day boundary must not stay
    // attributed to the late-closeout day. Numeric effectiveTimeOnSite is
    // the durable mode signal (frozen-restored on resume), so the branch
    // holds on crash-resumed retries too.
    expect(source).toMatch(/: \(typeof effectiveTimeOnSite === 'number'\s*\n\s*\? adjustedCompletionEndInstant\(svc, effectiveTimeOnSite, new Date\(\)\)\s*\n\s*: null\);/);
  });

  test('a repeat edit sends only the correction keys — prior preservation lives in the SQL CASE, not JS state', async () => {
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
    const notesRaw = recUpdate.updatePayload.structured_notes;
    // The patch bindings never carry timeOnSitePrior — the CASE guard writes
    // it from the column's own pre-update value on the first edit only, so a
    // repeat edit cannot overwrite the original baseline (verified against
    // real PostgreSQL 16, including the JSON-null-prior shape).
    expect(notesRaw.bindings).toEqual([JSON.stringify({ timeOnSite: 50, timeOnSiteAdjusted: true })]);
    expect(notesRaw.sql).toMatch(/-> 'timeOnSitePrior' IS NOT NULL/);
  });

  test('a FAILED costing recalc is surfaced, never silent success (codex P2 round 9)', async () => {
    // The correction stands (costing is derived state that any later recalc
    // heals from the durable stamp) — but the response must say the refresh
    // failed so the client can warn instead of promising updated costs.
    JobCosting.calculateJobCost.mockRejectedValueOnce(new Error('transient db error'));
    const dbMock = makeRecordingDb({ svc: COMPLETED_SVC, record: RECORD, recordCols: RECORD_COLS });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { minutes: 45 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.costingUpdated).toBe(false);
    // The correction and audit trail still landed.
    expect(dbMock.calls.find((c) => c.table === 'scheduled_services' && c.updatePayload)).toBeTruthy();
    expect(dbMock.calls.find((c) => c.table === 'activity_log')).toBeTruthy();
  });

  test('a columnInfo FAILURE propagates — a degraded schema must not strip the FK lookup or the record-update legs (codex P2 round 4)', async () => {
    const dbMock = makeRecordingDb({
      svc: COMPLETED_SVC,
      record: RECORD,
      recordCols: RECORD_COLS,
      columnInfoError: new Error('metadata lookup timeout'),
    });
    mockDbCurrent = dbMock;
    const res = makeRes();
    let nextErr = null;
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { minutes: 45 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { nextErr = err; },
    );
    expect(nextErr?.message).toBe('metadata lookup timeout');
    expect(res.body).toBeNull();
    expect(dbMock.calls.find((c) => c.updatePayload)).toBeUndefined();
    expect(JobCosting.calculateJobCost).not.toHaveBeenCalled();
  });

  test('a service_records lookup FAILURE propagates — never a 200 that silently skipped the report correction (codex P2)', async () => {
    const dbMock = makeRecordingDb({
      svc: COMPLETED_SVC,
      record: null,
      recordCols: RECORD_COLS,
      recordLookupError: new Error('statement timeout'),
    });
    mockDbCurrent = dbMock;
    const res = makeRes();
    let nextErr = null;
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { minutes: 45 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { nextErr = err; },
    );
    expect(nextErr?.message).toBe('statement timeout');
    expect(res.body).toBeNull(); // no success response
    expect(dbMock.calls.find((c) => c.updatePayload)).toBeUndefined(); // nothing written
    expect(JobCosting.calculateJobCost).not.toHaveBeenCalled();
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
    // Merge patch carries ONLY the correction keys — the durable backfill
    // marker is untouched by construction (jsonb || merges keys, never
    // replaces the object).
    const notesRaw = recUpdate.updatePayload.structured_notes;
    expect(notesRaw.__raw).toBe(true);
    expect(notesRaw.bindings).toEqual([JSON.stringify({ timeOnSite: 45, timeOnSiteAdjusted: true })]);
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

  test('a pre-FK record (NULL scheduled_service_id) resolves via the legacy soft-join and gets corrected (codex P2 round 2)', async () => {
    // Visits completed before migration 20260427000007: the FK query finds
    // nothing, but resolveServiceRecord's (customer, date, type) soft-join
    // finds the record — the SAME resolution job costing uses, so the marker
    // this edit stamps is the record the recalc reads.
    const legacyRecord = {
      id: 'rec-legacy',
      scheduled_service_id: null,
      structured_notes: JSON.stringify({ visitOutcome: 'completed' }),
    };
    const dbMock = makeRecordingDb({
      svc: COMPLETED_SVC,
      record: null, // FK query misses
      recordCols: RECORD_COLS,
      legacyRows: [legacyRecord],
    });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { minutes: 45 }, technicianId: 'a', techRole: 'admin' },
      res, (err) => { throw err; },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.recordUpdated).toBe(true);
    const recUpdate = dbMock.calls.find((c) => c.table === 'service_records' && c.updatePayload);
    expect(recUpdate.whereCriteria).toEqual({ id: 'rec-legacy' });
    expect(recUpdate.updatePayload.pdf_storage_key).toBeNull();
    expect(recUpdate.updatePayload.structured_notes.__raw).toBe(true);
    // FK-heal (codex P2 round 3): the soft-join resolution stamps the FK in
    // the same update, so a later date/service-type edit can no longer
    // orphan the corrected record.
    expect(recUpdate.updatePayload.scheduled_service_id).toBe('svc-1');
  });

  test('an AMBIGUOUS legacy match is left untouched — scheduled_services corrects, the record leg is skipped', async () => {
    const rows = [
      { id: 'rec-newer', scheduled_service_id: null, structured_notes: null },
      { id: 'rec-older', scheduled_service_id: null, structured_notes: null },
    ];
    const dbMock = makeRecordingDb({
      svc: COMPLETED_SVC,
      record: null,
      recordCols: RECORD_COLS,
      legacyRows: rows,
    });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { minutes: 45 }, technicianId: 'a', techRole: 'admin' },
      res, (err) => { throw err; },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.recordUpdated).toBe(false);
    expect(res.body.recordAmbiguous).toBe(true);
    const ambSvcUpdate = dbMock.calls.find((c) => c.table === 'scheduled_services' && c.updatePayload);
    expect(ambSvcUpdate).toBeTruthy();
    // The skipped-record shapes are exactly why the durable row stamp
    // exists — the no-opts recalc re-derives the corrected labor from it,
    // now and on every later recalc (codex P2 rounds 5+7).
    expect(ambSvcUpdate.updatePayload.time_on_site_adjusted_minutes).toBe(45);
    expect(JobCosting.calculateJobCost).toHaveBeenCalledWith('svc-1');
    expect(dbMock.calls.find((c) => c.table === 'service_records' && c.updatePayload)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Completion-flow writers: post-commit notes writes are key merges (codex P1 round 2)
// ---------------------------------------------------------------------------

describe('post-commit structured_notes writers cannot clobber the correction', () => {
  test('mergeRecordNotesKeys is the atomic jsonb merge', () => {
    expect(source).toMatch(/function mergeRecordNotesKeys\(recordId, patch\) \{\s*\n\s*return db\('service_records'\)\.where\(\{ id: recordId \}\)\.update\(\{\s*\n\s*structured_notes: db\.raw\(\s*\n\s*"COALESCE\(structured_notes::jsonb, '\{\}'::jsonb\) \|\| \?::jsonb",/);
  });

  test('every whole-column structured_notes snapshot write left in the route is INSIDE the completion trx', () => {
    // Post-commit, the column has concurrent writers (this correction and
    // the completion side-effect stamps) — a whole-column write from either
    // side erases the other's keys. The five allowed serializeJsonb sites
    // are the record INSERT and four trx(...) updates, all inside the
    // completion transaction where nothing can race them. A sixth
    // occurrence means someone added a post-commit snapshot writer — route
    // it through mergeRecordNotesKeys instead.
    expect((source.match(/structured_notes: serializeJsonb\(/g) || []).length).toBe(5);
    // And the converted side-effect writers all go through the merge helper.
    expect((source.match(/mergeRecordNotesKeys\(record\.id, /g) || []).length).toBe(11);
  });

  test('the lawn synthesis gate merges only its lawnReportV2 key — never the whole column (codex P1 round 3)', () => {
    // finalizeLawnReportSynthesis runs post-commit on auto-send lawn
    // completions — a whole-column write from its stale snapshot erased any
    // key that landed in between (the admin correction included).
    const gateSource = fs.readFileSync(
      path.join(__dirname, '../services/service-report/lawn-report-write-gate.js'),
      'utf8',
    );
    expect(gateSource).toMatch(/COALESCE\(structured_notes::jsonb, '\{\}'::jsonb\) \|\| \?::jsonb/);
    expect(gateSource).toMatch(/JSON\.stringify\(\{ lawnReportV2: frozen \}\)/);
    expect(gateSource).not.toMatch(/structured_notes: JSON\.stringify\(merged\)/);
  });
});

// ---------------------------------------------------------------------------
// Job costing: the corrected duration is authoritative labor (codex P1 #3152)
// ---------------------------------------------------------------------------

function makeTimeEntriesDb(jobEntryMinutes) {
  // Scripted db for the REAL calcLaborCost: first query is the direct
  // job-entries lookup, second (if reached) the clock-in-window fallback.
  const chain = (rows) => {
    const c = {
      where: () => c,
      whereNot: () => c,
      whereBetween: () => c,
      select: async () => rows,
    };
    return c;
  };
  let call = 0;
  return () => chain(call++ === 0 ? jobEntryMinutes.map((m) => ({ duration_minutes: m })) : []);
}

describe('calcLaborCost — overrideLaborMinutes outranks the linked job time entry', () => {
  const RATE = 35;

  test('a job-tied entry with the inflated span loses to the operator correction', async () => {
    // The forgotten-closeout shape: entry says 139 min (forgotten clock-out),
    // the admin corrected the visit to 45.
    const { laborMinutes, laborCost } = await realCalcLaborCost(
      makeTimeEntriesDb([139]), 'svc-1', 'tech-1', null, null, RATE,
      { overrideLaborMinutes: 45 },
    );
    expect(laborMinutes).toBe(45);
    expect(laborCost).toBe(Math.round((45 / 60) * RATE * 100) / 100);
  });

  test('without the override the entry still wins — unadjusted visits are unchanged', async () => {
    const { laborMinutes } = await realCalcLaborCost(
      makeTimeEntriesDb([139]), 'svc-1', 'tech-1', null, null, RATE, {},
    );
    expect(laborMinutes).toBe(139);
  });

  test('explicitLaborMinutes (backfill) deliberately stays WEAKER than a job entry', async () => {
    const { laborMinutes } = await realCalcLaborCost(
      makeTimeEntriesDb([139]), 'svc-1', 'tech-1', null, null, RATE,
      { untrustedLifecycleSpan: true, explicitLaborMinutes: 45 },
    );
    expect(laborMinutes).toBe(139);
  });

  test('junk override values are ignored, never zero out labor', async () => {
    for (const junk of [0, -5, NaN, null, undefined, 'abc']) {
      const { laborMinutes } = await realCalcLaborCost(
        makeTimeEntriesDb([139]), 'svc-1', 'tech-1', null, null, RATE,
        { overrideLaborMinutes: junk },
      );
      expect(laborMinutes).toBe(139);
    }
  });
});

describe('job costing durable re-derivation from the timeOnSiteAdjusted marker', () => {
  // Every LATER recalculation (admin-job-costs recalc, expense CRUD, billing
  // recovery) calls calculateJobCost with no opts — the marker must re-derive
  // the override there or the first no-opts recalc resurrects the inflated
  // entry span. Same durable-policy shape as the backfill marker above it.
  test('calculateJobCost re-derives overrideLaborMinutes from the persisted marker + corrected column', () => {
    expect(costingSource).toMatch(/if \(recordNotes\.timeOnSiteAdjusted === true && overrideLaborMinutes == null\) \{\s*\n\s*const correctedMinutes = Number\(svc\.service_time_minutes\);\s*\n\s*if \(Number\.isFinite\(correctedMinutes\) && correctedMinutes > 0\) \{\s*\n\s*overrideLaborMinutes = correctedMinutes;/);
    expect(costingSource).toMatch(/\{ untrustedLifecycleSpan, explicitLaborMinutes, overrideLaborMinutes \},/);
    // The override is checked BEFORE the direct job-entries lookup.
    const overrideAt = costingSource.indexOf('const override = Number(overrideLaborMinutes);');
    const entriesAt = costingSource.indexOf("await db('time_entries')");
    expect(overrideAt).toBeGreaterThan(-1);
    expect(entriesAt).toBeGreaterThan(overrideAt);
  });

  test('the stamp fence skips stale financial writes when a newer correction landed mid-recalculation (codex P2 round 8)', async () => {
    // Correction A (45) starts costing; correction B (60) commits and its
    // costing finishes first. A's write landing last must NOT re-book 45 —
    // the fence re-reads the stamp just before the writes and bails.
    const { calculateJobCost: realCalculateJobCost } = jest.requireActual('../services/job-costing');
    const writes = { jobCosts: [], recordUpdates: [] };
    let svcReads = 0;
    const svcAtRead = {
      id: 'svc-1', customer_id: 'cust-1', status: 'completed',
      service_time_minutes: 45, actual_duration_minutes: 45,
      time_on_site_adjusted_minutes: 45,
      estimated_price: 129,
    };
    const dbFence = (table) => {
      const chain = {
        where: () => chain,
        whereNot: () => chain,
        whereBetween: () => chain,
        leftJoin: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        count: () => chain,
        forUpdate: () => chain,
        columnInfo: async () => ({ scheduled_service_id: {}, revenue: {} }),
        select: async () => [],
        async first() {
          if (table === 'scheduled_services') {
            svcReads += 1;
            // First read: A's view (45). Locked fence re-read: B already
            // stamped 60.
            return svcReads === 1 ? svcAtRead : { ...svcAtRead, time_on_site_adjusted_minutes: 60 };
          }
          return null;
        },
        insert: async (r) => { writes.jobCosts.push(r); return [1]; },
        update: async (u) => { writes.recordUpdates.push(u); return 1; },
      };
      chain.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
      return chain;
    };
    dbFence.transaction = async (fn) => fn(dbFence);
    const res = await realCalculateJobCost('svc-1', dbFence);
    expect(res.staleSkipped).toBe(true);
    expect(writes.jobCosts).toEqual([]);
    expect(writes.recordUpdates).toEqual([]);
    // Wiring (round 9): the fence read holds the scheduled_services row
    // lock in the SAME transaction as both financial writes — no window
    // between check and write remains.
    expect(costingSource).toMatch(/await db\.transaction\(async \(trx\) => \{\s*\n\s*const rowNow = await trx\('scheduled_services'\)\.where\(\{ id: scheduledServiceId \}\)\.forUpdate\(\)\.first\(\);/);
    const fenceAt = costingSource.indexOf('correction stamp moved during recalculation');
    const jobCostsWriteAt = costingSource.indexOf("await trx('job_costs').insert(row);");
    const writeThroughAt = costingSource.indexOf("await trx('service_records').where({ id: record.id }).update(upd);");
    expect(fenceAt).toBeGreaterThan(-1);
    expect(jobCostsWriteAt).toBeGreaterThan(fenceAt);
    expect(writeThroughAt).toBeGreaterThan(jobCostsWriteAt);
  });

  test('an ambiguous legacy match contributes NOTHING to costing — nulled at resolution, not just at the write-through (codex P2 round 6)', () => {
    // Pre-fix, calculateJobCost used the arbitrary newest ambiguous record's
    // revenue and products for this visit's job_costs; only the
    // service_records write-through was guarded. The record is now nulled
    // the moment ambiguity is detected, so it cannot reach deriveRevenue,
    // calcProductsCost, or the job_costs service_record_id linkage.
    expect(costingSource).toMatch(/const record = ambiguous \? null : resolvedRecord;/);
    const nullOutAt = costingSource.indexOf('const record = ambiguous ? null : resolvedRecord;');
    const deriveRevenueAt = costingSource.indexOf('const revenue = intentionallyFree ? 0 : deriveRevenue({');
    expect(nullOutAt).toBeGreaterThan(-1);
    expect(deriveRevenueAt).toBeGreaterThan(nullOutAt);
  });

  test('the ROW stamp is a second durable home — corrected visits with no record still re-derive (codex P2 round 5)', () => {
    expect(costingSource).toMatch(/if \(overrideLaborMinutes == null\) \{\s*\n\s*const stampedMinutes = Number\(svc\.time_on_site_adjusted_minutes\);\s*\n\s*if \(Number\.isFinite\(stampedMinutes\) && stampedMinutes > 0\) \{\s*\n\s*overrideLaborMinutes = stampedMinutes;/);
    // And the migration that adds the column exists, guarded + symmetric.
    const migrationSource = fs.readFileSync(
      path.join(__dirname, '../models/migrations/20260801400000_time_on_site_adjusted_minutes.js'),
      'utf8',
    );
    expect(migrationSource).toMatch(/hasColumn\('scheduled_services', 'time_on_site_adjusted_minutes'\)/);
    expect(migrationSource).toMatch(/t\.integer\('time_on_site_adjusted_minutes'\)\.nullable\(\)/);
    expect(migrationSource).toMatch(/dropColumn\('time_on_site_adjusted_minutes'\)/);
  });
});

// ---------------------------------------------------------------------------
// PDF cache fence: the corrected duration keys the storage key (codex P2 #3152)
// ---------------------------------------------------------------------------

describe('timeOnSiteAdjustedPdfSignature — stale in-flight renders cannot republish the old duration', () => {
  test('adjusted records key on the corrected value; unadjusted records keep their keys (no fleet cache bust)', () => {
    expect(timeOnSiteAdjustedPdfSignature({
      structured_notes: JSON.stringify({ timeOnSiteAdjusted: true, timeOnSite: 45 }),
    })).toBe('-tos45');
    expect(timeOnSiteAdjustedPdfSignature({
      structured_notes: { timeOnSiteAdjusted: true, timeOnSite: 50 },
    })).toBe('-tos50');
    // Unadjusted / absent / junk shapes all contribute nothing.
    expect(timeOnSiteAdjustedPdfSignature({
      structured_notes: JSON.stringify({ timeOnSite: '2:19:05' }),
    })).toBe('');
    expect(timeOnSiteAdjustedPdfSignature({ structured_notes: null })).toBe('');
    expect(timeOnSiteAdjustedPdfSignature({})).toBe('');
    expect(timeOnSiteAdjustedPdfSignature({ structured_notes: 'not json{' })).toBe('');
  });

  test('every storage-key composition site carries the component — write and expected sides in both modules', () => {
    // A missing site desynchronizes written vs expected keys: adjusted
    // records would either serve stale PDFs (the race this fences) or
    // re-render on every view (a silent cost). Two sites per module.
    expect((pdfQueueSource.match(/timeOnSiteAdjustedPdfSignature\(service\)/g) || []).length).toBe(2);
    expect((reportsPublicSource.match(/timeOnSiteAdjustedPdfSignature\(service\)/g) || []).length).toBe(2);
  });
});

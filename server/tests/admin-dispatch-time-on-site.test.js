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
// The linked job timer flows through the AUDITED edit workflow — mocked so
// the PATCH tests can assert the safe-path call without a real week lock.
jest.mock('../services/time-tracking', () => ({
  adminEditEntry: jest.fn(async () => ({})),
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
  // A row checked in at 16:00Z, evaluated at 18:19:05Z — server span 139m,
  // exactly what an honest panel timer would show.
  const TIMED_SVC = {
    actual_start_time: '2026-07-19T16:00:00Z',
    check_in_time: '2026-07-19T16:00:00Z',
  };
  const GATE_NOW = new Date('2026-07-19T18:19:05Z');

  test('an honest timer within tolerance passes through untouched for ANY role', () => {
    for (const role of ['admin', 'technician', undefined]) {
      expect(liveTimeOnSitePlan({ timeOnSite: '2:19:05', role, service: TIMED_SVC, now: GATE_NOW }))
        .toEqual({ adjusted: false, effectiveTimeOnSite: '2:19:05' });
    }
    expect(liveTimeOnSitePlan({ timeOnSite: undefined, role: 'technician' }))
      .toEqual({ adjusted: false, effectiveTimeOnSite: undefined });
  });

  test('a FORGED timer shape is replaced by the server-derived span (codex P1 round 14)', () => {
    // "45:00" is format-valid, but the row says 139 minutes — the format
    // alone proves nothing, the server span is recorded instead.
    for (const role of ['technician', 'admin']) {
      expect(liveTimeOnSitePlan({ timeOnSite: '45:00', role, service: TIMED_SVC, now: GATE_NOW }))
        .toEqual({ adjusted: false, effectiveTimeOnSite: '2:19:00' });
    }
    // Modest drift stays within tolerance and keeps the client's precision.
    expect(liveTimeOnSitePlan({ timeOnSite: '2:16:30', role: 'technician', service: TIMED_SVC, now: GATE_NOW }))
      .toEqual({ adjusted: false, effectiveTimeOnSite: '2:16:30' });
  });

  test('a ZERO-rounded server span is a reference, not a trust path (codex P1 round 17)', () => {
    // Check in and immediately submit: positiveMinutesBetween rounds the
    // elapsed span to null, which used to skip the comparison entirely and
    // accept any timer-shaped claim ("720:00") verbatim. Zero IS the
    // server's span — a divergent claim is replaced with the zero timer.
    const justStarted = { actual_start_time: new Date(GATE_NOW.getTime() - 10000) };
    for (const role of ['technician', 'admin']) {
      expect(liveTimeOnSitePlan({ timeOnSite: '720:00', role, service: justStarted, now: GATE_NOW }))
        .toEqual({ adjusted: false, effectiveTimeOnSite: '0:00:00' });
    }
    // The genuine just-started panel timer stays within tolerance of zero.
    expect(liveTimeOnSitePlan({ timeOnSite: '0:00:10', role: 'technician', service: justStarted, now: GATE_NOW }))
      .toEqual({ adjusted: false, effectiveTimeOnSite: '0:00:10' });
    // A start ahead of the clock (skew) takes the same zero reference.
    const futureStart = { actual_start_time: new Date(GATE_NOW.getTime() + 60000) };
    expect(liveTimeOnSitePlan({ timeOnSite: '45:00', role: 'technician', service: futureStart, now: GATE_NOW }))
      .toEqual({ adjusted: false, effectiveTimeOnSite: '0:00:00' });
  });

  test('a timer claim with NO row-backed start: admin keeps it, any other role records unknown', () => {
    expect(liveTimeOnSitePlan({ timeOnSite: '45:00', role: 'technician', service: {}, now: GATE_NOW }))
      .toEqual({ adjusted: false, effectiveTimeOnSite: null });
    expect(liveTimeOnSitePlan({ timeOnSite: '45:00', role: 'admin', service: {}, now: GATE_NOW }))
      .toEqual({ adjusted: false, effectiveTimeOnSite: '45:00' });
  });

  test('numeric value from a non-admin → 403 time_on_site_admin_only, fail-closed', () => {
    for (const role of ['technician', undefined, null, 'other']) {
      const plan = liveTimeOnSitePlan({ timeOnSite: 45, role });
      expect(plan.adjusted).toBe(false);
      expect(plan.status).toBe(403);
      expect(plan.error.code).toBe('time_on_site_admin_only');
    }
  });

  test('string-encoded minutes take the SAME gate — a tech cannot smuggle "45" past the type check (codex P1 round 13)', () => {
    // minutesFromElapsed parses bare numeric strings and "45 min" as
    // minutes, so every non-timer-format value is operator input and must
    // be role-gated. Only the panel timer's own shapes pass through.
    for (const smuggled of ['45', ' 45 ', '45 min', '45m', '45.5', ['45'], { toString: () => '45' }]) {
      const plan = liveTimeOnSitePlan({ timeOnSite: smuggled, role: 'technician' });
      expect(plan.adjusted).toBe(false);
      expect(plan.status).toBe(403);
      expect(plan.error.code).toBe('time_on_site_admin_only');
    }
    // An admin typing the same shapes is legitimate operator input.
    expect(liveTimeOnSitePlan({ timeOnSite: '45', role: 'admin' }))
      .toEqual({ adjusted: true, effectiveTimeOnSite: 45 });
    expect(liveTimeOnSitePlan({ timeOnSite: '45 min', role: 'admin' }))
      .toEqual({ adjusted: true, effectiveTimeOnSite: 45 });
    // Genuine timer shapes take the server-span validation, not the admin
    // gate — never a 403 for a real timer.
    for (const timer of ['2:19:05', '9:05', '412:07:33']) {
      const plan = liveTimeOnSitePlan({ timeOnSite: timer, role: 'technician', service: TIMED_SVC, now: GATE_NOW });
      expect(plan.status).toBeUndefined();
      expect(plan.adjusted).toBe(false);
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
    expect(source).toMatch(/if \(!isBackfillCompletion && liveAdjustedTimeOnSite && !correctionPreservedMidFlight\) \{\s*\n\s*if \(adjustedEndedAt\) \{\s*\n\s*lifecycleUpdates\.actual_end_time = adjustedEndedAt;\s*\n\s*lifecycleUpdates\.check_out_time = adjustedEndedAt;\s*\n\s*\}/);
    expect(source).toMatch(/lifecycleUpdates\.time_on_site_adjusted_minutes = effectiveTimeOnSite;/);
  });

  test('markComplete honors a caller-supplied trusted instant — the adjusted end reaches completed_at (codex P2 round 11)', () => {
    const trackerSource = fs.readFileSync(
      path.join(__dirname, '../services/track-transitions.js'),
      'utf8',
    );
    // Trusted path: finite opts.completedAt wins, wall clock only as the
    // fallback — so the live override's adjusted instant is not discarded.
    // Both branches sit behind the round-15 transition stamp fence: when a
    // newer correction owns completed_at, neither stamps anything.
    expect(trackerSource).toMatch(/let completedAtStamp = \(!transitionStampMatches \|\| priorCorrectionOwnsRow\)\s*\n\s*\? null[\s\S]{0,120}: \(opts\.untrustedLifecycleSpan\s*\n\s*\? finiteDate\(opts\.completedAt\)\s*\n\s*: \(finiteDate\(opts\.completedAt\) \|\| now\)\);/);
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
    expect(source).toMatch(/const livePlan = liveTimeOnSitePlan\(\{ timeOnSite, role: req\.techRole, backfill: isBackfillCompletion, service: svc \}\);/);
    expect(source).toMatch(/if \(livePlan\.error\) \{\s*\n\s*return res\.status\(livePlan\.status\)\.json\(livePlan\.error\);/);
    const backfillPlanAt = source.indexOf('backfillCompletionPlan({ backfill, scheduledDate: svc.scheduled_date');
    const livePlanAt = source.indexOf('const livePlan = liveTimeOnSitePlan(');
    const completionTrxAt = source.indexOf('const completionEndedAt = new Date();');
    expect(backfillPlanAt).toBeGreaterThan(-1);
    expect(livePlanAt).toBeGreaterThan(backfillPlanAt);
    expect(completionTrxAt).toBeGreaterThan(livePlanAt);
  });

  test('the adjusted end instant sits after backfill in the lifecycle fallback chain', () => {
    expect(source).toMatch(/const adjustedEndedAt = !isBackfillCompletion && liveAdjustedTimeOnSite\s*\n\s*&& !correctionPreservedMidFlight\s*\n\s*\? adjustedCompletionEndInstant\(svc, effectiveTimeOnSite, completionEndedAt\)\s*\n\s*: null;\s*\n\s*const completionLifecycleAt = backfillEndedAt \|\| adjustedEndedAt \|\| completionEndedAt;/);
  });

  test('the adjusted marker freezes into structured_notes beside the backfill marker', () => {
    expect(source).toMatch(/\.\.\.\(liveAdjustedTimeOnSite \|\| correctionPreservedMidFlight \? \{ timeOnSiteAdjusted: true \} : \{\}\),/);
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
    expect(block).toMatch(/serviceUpdate\.actual_end_time = newEnd;\s*\n\s*serviceUpdate\.check_out_time = newEnd;\s*\n\s*serviceUpdate\.completed_at = newEnd;/);
    // Record resolution runs under the row lock, before any write (codex
    // P2 round 13) — an in-flight finalization's fresh record is seen, and
    // a resolution failure aborts the whole correction.
    const lockAt = block.indexOf(".forUpdate().first();");
    const resolveAt = block.indexOf('.resolveServiceRecord(trx, lockedSvc || svc, serviceRecordCols)');
    const firstWriteAt = block.indexOf("await trx('scheduled_services').where({ id: svc.id }).update(serviceUpdate);");
    expect(lockAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeGreaterThan(lockAt);
    expect(firstWriteAt).toBeGreaterThan(resolveAt);
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

function makeRecordingDb({ svc, record, recordCols, recordLookupError = null, legacyRows = null, columnInfoError = null, timeEntries = null, timeEntriesLive = null }) {
  // `record` answers resolveServiceRecord's FK query (.first()); `legacyRows`
  // (when set) answers its awaited (customer, date, type) soft-join, so the
  // pre-FK shapes exercise the REAL legacy resolution path.
  const calls = [];
  let timeEntryReads = 0;
  const chainFor = (table) => {
    const op = { table };
    calls.push(op);
    const chain = {
      where(criteria) { op.whereCriteria = criteria; return chain; },
      orderBy(col, dir) { op.orderBy = [col, dir]; return chain; },
      limit(n) { op.limited = n; return chain; },
      count(spec) { op.counted = spec; return chain; },
      whereNot(col, val) { op.whereNot = [col, val]; return chain; },
      select(...cols) { op.selected = cols; return chain; },
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
        let rows;
        if (table === 'time_entries') {
          // First read = the in-transaction snapshot; later reads = the
          // sync's live membership recheck (round 24).
          timeEntryReads += 1;
          rows = timeEntryReads > 1 && timeEntriesLive !== null
            ? timeEntriesLive
            : (timeEntries || []);
        } else {
          rows = table === 'service_records' && op.limited ? (legacyRows || []) : [];
        }
        return Promise.resolve(rows).then(resolve, reject);
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
      // The committed revision is frozen in the audit (codex P2 round 19)
      // — COMPLETED_SVC has no prior seq, so this save is revision 1.
      correction_seq: 1,
    });
    // The prior minutes were read from the LOCKED row inside the trx
    // (codex P2 round 10) — concurrent corrections serialize on the lock,
    // so each audit records the value it actually superseded.
    const lockedRead = dbMock.calls.find((c) => c.table === 'scheduled_services' && c.locked);
    expect(lockedRead).toBeTruthy();
    expect(source).toMatch(/const lockedSvc = await trx\('scheduled_services'\)\.where\(\{ id: svc\.id \}\)\.forUpdate\(\)\.first\(\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*committedCorrectionSeq = \(Number\(lockedSvc\?\.time_on_site_correction_seq\) \|\| 0\) \+ 1;\s*\n(?:\s*\/\/[^\n]*\n)*\s*timerEntriesSnapshot = await trx\('time_entries'\)[\s\S]{0,300}?\s*previousMinutes = positiveNumber\(lockedSvc\?\.service_time_minutes\)/);
    // The audit INSERT rides the correction transaction (codex P2 round
    // 19): concurrent corrections serialize on the row lock, so in-trx
    // audits land in commit order — outside it, whichever request finished
    // its independent costing first wrote its audit first and created_at
    // could invert the correction history.
    const auditInsertAt = source.indexOf("await trx('activity_log').insert({");
    const costingCallAt = source.indexOf('await JobCosting.calculateJobCost(svc.id);');
    expect(auditInsertAt).toBeGreaterThan(-1);
    expect(costingCallAt).toBeGreaterThan(auditInsertAt);
  });

  test('an inflated linked job timer is corrected through the audited edit workflow (codex P1 round 20)', async () => {
    // The forgotten closeout inflated the linked time_entries row too —
    // timesheets and utilization read it directly. Exactly one closed,
    // non-voided, inflated job entry = the safe shape: route it through
    // adminEditEntry (originals preserved, day back to pending).
    const TimeTracking = require('../services/time-tracking');
    const clockIn = new Date('2026-07-19T16:00:00.000Z');
    const dbMock = makeRecordingDb({
      svc: COMPLETED_SVC,
      record: RECORD,
      recordCols: RECORD_COLS,
      timeEntries: [{
        id: 'te-1',
        clock_in: clockIn,
        clock_out: new Date('2026-07-19T18:19:05.000Z'),
        duration_minutes: 139,
        status: 'active',
      }],
    });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { minutes: 45 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(TimeTracking.adminEditEntry).toHaveBeenCalledWith('te-1', expect.objectContaining({
      // Duration-based: the audited edit derives clock_out from ITS locked
      // row, closing the snapshot race (codex P1, audit round 21b).
      target_duration_minutes: 45,
      edited_by: 'admin-1',
      edit_reason: expect.stringContaining('45 min'),
    }));
    expect(res.body.timeEntryCorrected).toBe(true);
    expect(res.body.timeEntryCorrectionBlocked).toBeUndefined();
  });

  test('an ambiguous or approved-week linked timer is surfaced, never forced (codex P1 round 20)', async () => {
    const TimeTracking = require('../services/time-tracking');
    // Several linked entries — editing one could pick the wrong clock.
    const twoEntries = makeRecordingDb({
      svc: COMPLETED_SVC,
      record: RECORD,
      recordCols: RECORD_COLS,
      timeEntries: [
        { id: 'te-1', clock_in: new Date('2026-07-19T16:00:00.000Z'), clock_out: new Date('2026-07-19T18:19:05.000Z'), duration_minutes: 139, status: 'active' },
        { id: 'te-2', clock_in: new Date('2026-07-19T13:00:00.000Z'), clock_out: new Date('2026-07-19T14:30:00.000Z'), duration_minutes: 90, status: 'active' },
      ],
    });
    mockDbCurrent = twoEntries;
    let res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { minutes: 45 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(TimeTracking.adminEditEntry).not.toHaveBeenCalled();
    expect(res.body.timeEntryCorrected).toBe(false);
    expect(res.body.timeEntryCorrectionBlocked).toBe('multiple_job_entries');

    // Approved week: the audited workflow refuses — surfaced, correction stands.
    TimeTracking.adminEditEntry.mockRejectedValueOnce(new Error('Week is approved — reopen it before editing entries.'));
    const oneEntry = makeRecordingDb({
      svc: COMPLETED_SVC,
      record: RECORD,
      recordCols: RECORD_COLS,
      timeEntries: [{
        id: 'te-9',
        clock_in: new Date('2026-07-19T16:00:00.000Z'),
        clock_out: new Date('2026-07-19T18:19:05.000Z'),
        duration_minutes: 139,
        status: 'active',
      }],
    });
    mockDbCurrent = oneEntry;
    res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { minutes: 45 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.timeEntryCorrected).toBe(false);
    expect(res.body.timeEntryCorrectionBlocked).toBe('approved_week');
  });

  test('a sub-minute divergence syncs too — hundredth-minute precision, no one-minute blind spot (codex P2 round 21)', async () => {
    // duration_minutes stores hundredths (adminEditEntry rounds to 0.01):
    // 45.6 against a 45-minute correction IS a divergence — the old
    // one-minute tolerance reported it as fully synced.
    const TimeTracking = require('../services/time-tracking');
    const clockIn = new Date('2026-07-19T16:00:00.000Z');
    const dbMock = makeRecordingDb({
      svc: COMPLETED_SVC,
      record: RECORD,
      recordCols: RECORD_COLS,
      timeEntries: [{
        id: 'te-sub',
        clock_in: clockIn,
        clock_out: new Date(clockIn.getTime() + 45.6 * 60000),
        duration_minutes: 45.6,
        status: 'active',
      }],
    });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { minutes: 45 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(TimeTracking.adminEditEntry).toHaveBeenCalledWith('te-sub', expect.objectContaining({
      target_duration_minutes: 45,
    }));
    expect(res.body.timeEntryCorrected).toBe(true);
    // Divergence is judged on the AGGREGATE at stored precision — an entry
    // already landed exactly on the corrected minutes no-ops.
    expect(source).toMatch(/const totalMinutes = jobEntries\.reduce\(\(s, e\) => s \+ \(Number\(e\.duration_minutes\) \|\| 0\), 0\);\s*\n\s*if \(Math\.abs\(totalMinutes - minutes\) <= 0\.005\) return;/);
    // And the audited edit is DURATION-based: clock_out derives from the
    // service's own locked row, not from this sync's unlocked snapshot
    // (codex P1, audit round 21b) — a concurrent clock_in edit can no
    // longer skew the saved duration.
    const timeTrackingSource = fs.readFileSync(
      path.join(__dirname, '../services/time-tracking.js'),
      'utf8',
    );
    expect(timeTrackingSource).toMatch(/if \(!clock_out && Number\.isFinite\(Number\(target_duration_minutes\)\) && Number\(target_duration_minutes\) > 0\) \{\s*\n\s*const baseIn = updates\.clock_in \|\| entry\.clock_in;\s*\n\s*const derivedOut = new Date\(new Date\(baseIn\)\.getTime\(\) \+ Number\(target_duration_minutes\) \* 60000\);/);
  });

  test('a concurrent payroll edit rejects the sync as entry_conflict — never silently replaced (codex P2 round 22)', async () => {
    // The sync passes the updated_at it observed; the audited edit's
    // locked read rejects on mismatch (staffTimeHttpError 409), and the
    // response surfaces it instead of overwriting the newer manual edit.
    const TimeTracking = require('../services/time-tracking');
    TimeTracking.adminEditEntry.mockRejectedValueOnce(
      Object.assign(new Error('Entry changed since it was read; reload before editing.'), { status: 409 }),
    );
    const observedUpdatedAt = new Date('2026-07-19T18:20:00.000Z');
    const dbMock = makeRecordingDb({
      svc: COMPLETED_SVC,
      record: RECORD,
      recordCols: RECORD_COLS,
      timeEntries: [{
        id: 'te-c',
        clock_in: new Date('2026-07-19T16:00:00.000Z'),
        clock_out: new Date('2026-07-19T18:19:05.000Z'),
        duration_minutes: 139,
        status: 'active',
        updated_at: observedUpdatedAt,
      }],
    });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { minutes: 45 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    // The observed version traveled with the edit…
    expect(TimeTracking.adminEditEntry).toHaveBeenCalledWith('te-c', expect.objectContaining({
      expected_updated_at: observedUpdatedAt,
    }));
    // …and the rejection surfaced rather than reading as success.
    expect(res.statusCode).toBe(200);
    expect(res.body.timeEntryCorrected).toBe(false);
    expect(res.body.timeEntryCorrectionBlocked).toBe('entry_conflict');
    // Service-side contract: the check runs against the LOCKED row.
    const timeTrackingSource = fs.readFileSync(
      path.join(__dirname, '../services/time-tracking.js'),
      'utf8',
    );
    expect(timeTrackingSource).toMatch(/if \(expected_updated_at !== undefined\) \{\s*\n\s*const observed = expected_updated_at \? new Date\(expected_updated_at\)\.getTime\(\) : null;\s*\n\s*const current = entry\.updated_at \? new Date\(entry\.updated_at\)\.getTime\(\) : null;\s*\n\s*if \(observed !== current\) \{/);
  });

  test('a timer started after the snapshot rejects the sync — membership recheck (codex P2 round 24)', async () => {
    // The correction transaction snapshotted one entry; a second job timer
    // appeared before the post-commit sync. Editing the snapshotted row
    // would report success while the payroll aggregate is still wrong —
    // surfaced as a conflict, nothing edited.
    const TimeTracking = require('../services/time-tracking');
    const base = {
      clock_in: new Date('2026-07-19T16:00:00.000Z'),
      clock_out: new Date('2026-07-19T18:19:05.000Z'),
      duration_minutes: 139,
      status: 'active',
      updated_at: new Date('2026-07-19T18:20:00.000Z'),
    };
    const dbMock = makeRecordingDb({
      svc: COMPLETED_SVC,
      record: RECORD,
      recordCols: RECORD_COLS,
      timeEntries: [{ id: 'te-1', ...base }],
      timeEntriesLive: [{ id: 'te-1', ...base }, { id: 'te-new', ...base, clock_out: null, duration_minutes: null }],
    });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { minutes: 45 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(TimeTracking.adminEditEntry).not.toHaveBeenCalled();
    expect(res.body.timeEntryCorrected).toBe(false);
    expect(res.body.timeEntryCorrectionBlocked).toBe('entry_conflict');
    // Resume guard: with NO transaction-time snapshot a divergent timer is
    // surfaced, never edited (no version predates the correction).
    expect(source).toMatch(/if \(entriesSnapshot === null\) \{\s*\n\s*corrected = false;\s*\n\s*blocked = 'entry_conflict';\s*\n\s*return;\s*\n\s*\}/);
  });

  test('a correction exceeding the elapsed span is rejected — no future paid time (codex P1 round 24)', async () => {
    // adminEditEntry refuses to derive a clock_out ahead of the wall clock
    // (the visit lifecycle clamps ITS end for the same input; payroll must
    // not record minutes that have not happened) — surfaced distinctly.
    const TimeTracking = require('../services/time-tracking');
    TimeTracking.adminEditEntry.mockRejectedValueOnce(
      Object.assign(new Error('Target duration extends the entry into the future; correct the timer manually once the interval has elapsed.'), { status: 400 }),
    );
    const dbMock = makeRecordingDb({
      svc: COMPLETED_SVC,
      record: RECORD,
      recordCols: RECORD_COLS,
      timeEntries: [{
        id: 'te-f',
        clock_in: new Date('2026-07-19T16:00:00.000Z'),
        clock_out: new Date('2026-07-19T16:30:00.000Z'),
        duration_minutes: 30,
        status: 'active',
        updated_at: new Date('2026-07-19T16:30:00.000Z'),
      }],
    });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { minutes: 120 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.timeEntryCorrected).toBe(false);
    expect(res.body.timeEntryCorrectionBlocked).toBe('exceeds_elapsed');
    // Service-side: the guard runs on the derived instant from the LOCKED
    // row, before any write.
    const timeTrackingSource = fs.readFileSync(
      path.join(__dirname, '../services/time-tracking.js'),
      'utf8',
    );
    expect(timeTrackingSource).toMatch(/if \(derivedOut\.getTime\(\) > Date\.now\(\)\) \{\s*\n\s*throw staffTimeHttpError\(400, 'Target duration extends the entry into the future/);
  });

  test('duplicate entries matching the corrected minutes are DIVERGENT in aggregate — surfaced, not silently fine (codex P1, audit round 21)', async () => {
    // Two duplicate 45-minute entries against a 45-minute correction total
    // 90 timesheet minutes: each entry individually "matches", but the
    // aggregate diverges and editing either one blindly could pick wrong —
    // surface multiple_job_entries. A legitimate split (20 + 25 = 45) stays
    // silent: the aggregate agrees.
    const TimeTracking = require('../services/time-tracking');
    const dup = (id, mins) => ({
      id,
      clock_in: new Date('2026-07-19T16:00:00.000Z'),
      clock_out: new Date(new Date('2026-07-19T16:00:00.000Z').getTime() + mins * 60000),
      duration_minutes: mins,
      status: 'active',
    });
    const dbMock = makeRecordingDb({
      svc: COMPLETED_SVC,
      record: RECORD,
      recordCols: RECORD_COLS,
      timeEntries: [dup('te-d1', 45), dup('te-d2', 45)],
    });
    mockDbCurrent = dbMock;
    let res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { minutes: 45 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(TimeTracking.adminEditEntry).not.toHaveBeenCalled();
    expect(res.body.timeEntryCorrected).toBe(false);
    expect(res.body.timeEntryCorrectionBlocked).toBe('multiple_job_entries');

    const splitMock = makeRecordingDb({
      svc: COMPLETED_SVC,
      record: RECORD,
      recordCols: RECORD_COLS,
      timeEntries: [dup('te-s1', 20), dup('te-s2', 25)],
    });
    mockDbCurrent = splitMock;
    res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { minutes: 45 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(TimeTracking.adminEditEntry).not.toHaveBeenCalled();
    expect(res.body.timeEntryCorrected).toBeUndefined();
    expect(res.body.timeEntryCorrectionBlocked).toBeUndefined();
  });

  test('a still-running linked timer is surfaced as entry_open, never silently fine (codex P1 round 20)', async () => {
    // clock_out == null: the span keeps growing past the corrected minutes
    // and the audited edit workflow is for completed intervals — the
    // response must say the timer needs a Timesheets fix, not read as a
    // full success.
    const TimeTracking = require('../services/time-tracking');
    const dbMock = makeRecordingDb({
      svc: COMPLETED_SVC,
      record: RECORD,
      recordCols: RECORD_COLS,
      timeEntries: [{
        id: 'te-open',
        clock_in: new Date('2026-07-19T16:00:00.000Z'),
        clock_out: null,
        duration_minutes: null,
        status: 'active',
      }],
    });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { minutes: 45 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(TimeTracking.adminEditEntry).not.toHaveBeenCalled();
    expect(res.body.timeEntryCorrected).toBe(false);
    expect(res.body.timeEntryCorrectionBlocked).toBe('entry_open');
  });

  test('an increased re-correction moves the linked timer too, fenced on the committed revision (codex P1 round 20)', async () => {
    // 45 → 60: the entry diverges in the OTHER direction — sync is on any
    // divergence, not only inflated-timer decreases.
    const TimeTracking = require('../services/time-tracking');
    const clockIn = new Date('2026-07-19T16:00:00.000Z');
    const dbMock = makeRecordingDb({
      svc: COMPLETED_SVC,
      record: RECORD,
      recordCols: RECORD_COLS,
      timeEntries: [{
        id: 'te-up',
        clock_in: clockIn,
        clock_out: new Date(clockIn.getTime() + 45 * 60000),
        duration_minutes: 45,
        status: 'active',
      }],
    });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { minutes: 60 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(TimeTracking.adminEditEntry).toHaveBeenCalledWith('te-up', expect.objectContaining({
      target_duration_minutes: 60,
    }));
    expect(res.body.timeEntryCorrected).toBe(true);
    // The sync serializes under the scheduled-services row lock (held
    // through the edit) and skips when the row already carries a NEWER
    // revision than this request committed — an older request can never
    // land its stale timer last.
    expect(source).toMatch(/if \(rowSeqNow != null && committedSeq != null && rowSeqNow > committedSeq\) return;/);
    // The live-override completion reuses the SAME fenced sync (audit
    // round 20c) — gated off backfills, on for numeric corrected minutes,
    // idempotent on crash-resumed retries.
    expect(source).toMatch(/if \(!isBackfillCompletion && typeof effectiveTimeOnSite === 'number'\) \{\s*\n\s*completionTimerSync = await syncLinkedJobTimer\(\{/);
    expect((source.match(/\.\.\.\(completionTimerSync\.corrected != null \? \{ timeEntryCorrected: completionTimerSync\.corrected \} : \{\}\),/g) || []).length).toBe(2);
    const timerLockAt = source.indexOf("await timerTrx('scheduled_services').where({ id: serviceId }).forUpdate().first();");
    const timerEditAt = source.indexOf("await require('../services/time-tracking').adminEditEntry(");
    expect(timerLockAt).toBeGreaterThan(-1);
    expect(timerEditAt).toBeGreaterThan(timerLockAt);
  });

  test('the tracker completed_at carries the adjusted instant for live corrections (codex P2 round 10)', () => {
    // Date-window readers prefer completed_at over the corrected end
    // columns — a correction crossing an ET day boundary must not stay
    // attributed to the late-closeout day. Numeric effectiveTimeOnSite is
    // the durable mode signal (frozen-restored on resume), so the branch
    // holds on crash-resumed retries too. Anchored to the transaction's own
    // wall clock so the clamp decision matches the committed stamps (codex
    // P2 round 14).
    expect(source).toMatch(/: \(typeof effectiveTimeOnSite === 'number'\s*\n\s*\? \(completionWallClockAt\s*\n\s*\? adjustedCompletionEndInstant\(svc, effectiveTimeOnSite, completionWallClockAt\)\s*\n\s*: \(finiteDate\(svc\.actual_end_time\) \|\| finiteDate\(svc\.check_out_time\) \|\| null\)\)\s*\n\s*: null\);/);
  });

  test('the finalization takes the row lock at transaction start — corrections and finalizations are strictly ordered (codex P2 round 14)', () => {
    expect(source).toMatch(/await db\.transaction\(async \(trx\) => \{\s*\n(?:\s*\/\/[^\n]*\n)*\s*const lockedSvcRow = await trx\('scheduled_services'\)\.where\(\{ id: svc\.id \}\)\.forUpdate\(\)\.first\(\);/);
  });

  test('the finalization reconciles with the LOCKED row and preserves a mid-flight correction (codex P2 round 15)', () => {
    // Lifecycle state adopts the locked row (a correction committing
    // between the handler's svc load and the lock already moved these
    // fields), and its stamped minutes outrank a plain stale-timer elapsed
    // in this request — explicit adjusted/backfill values keep authority.
    expect(source).toMatch(/for \(const field of \[\s*\n\s*'actual_end_time', 'check_out_time', 'completed_at',\s*\n\s*'service_time_minutes', 'actual_duration_minutes',\s*\n\s*'time_on_site_adjusted_minutes', 'time_on_site_correction_seq',\s*\n\s*\]\) \{\s*\n\s*if \(field in lockedSvcRow\) svc\[field\] = lockedSvcRow\[field\];/);
    expect(source).toMatch(/if \(Number\.isFinite\(stampedMinutes\) && stampedMinutes > 0\s*\n\s*&& \(stampMovedMidFlight\s*\n\s*\|\| \(!isBackfillCompletion && !liveAdjustedTimeOnSite\s*\n\s*&& typeof effectiveTimeOnSite !== 'number'\)\)\) \{\s*\n\s*effectiveTimeOnSite = stampedMinutes;\s*\n\s*correctionPreservedMidFlight = true;/);
    // The reconcile block sits between the lock and the wall-clock capture.
    const lockAt = source.indexOf("const lockedSvcRow = await trx('scheduled_services')");
    const preserveAt = source.indexOf('correctionPreservedMidFlight = true;');
    const wallClockAt = source.indexOf('completionWallClockAt = completionEndedAt;');
    expect(lockAt).toBeGreaterThan(-1);
    expect(preserveAt).toBeGreaterThan(lockAt);
    expect(wallClockAt).toBeGreaterThan(preserveAt);
  });

  test('a stamp that MOVED between the svc load and the lock outranks the request in every mode (codex P2 round 16)', () => {
    // The request's explicit live/backfill values were typed before the
    // moved stamp committed — the correction is the newer operator
    // statement, so the mode exclusion does not apply to it. The pre-lock
    // stamp is captured BEFORE the adoption loop overwrites svc.
    const preLockAt = source.indexOf('const preLockSeq = normStampVal(svc.time_on_site_correction_seq);');
    const adoptLoopAt = source.indexOf("if (field in lockedSvcRow) svc[field] = lockedSvcRow[field];");
    expect(preLockAt).toBeGreaterThan(-1);
    expect(adoptLoopAt).toBeGreaterThan(preLockAt);
    // The fence is the monotonic seq (codex P2 round 17) — a same-minutes
    // re-save bumps it while the value comparison stays blind; rows without
    // the column fall back to the round-16 value comparison.
    expect(source).toMatch(/const stampMovedMidFlight = Object\.prototype\.hasOwnProperty\.call\(lockedSvcRow, 'time_on_site_correction_seq'\)\s*\n\s*\? normStampVal\(lockedSvcRow\.time_on_site_correction_seq\) !== preLockSeq\s*\n\s*: \(Object\.prototype\.hasOwnProperty\.call\(lockedSvcRow, 'time_on_site_adjusted_minutes'\)\s*\n\s*&& normStampVal\(lockedSvcRow\.time_on_site_adjusted_minutes\) !== preLockStamp\);/);
    // The correction PATCH bumps the seq inside its row-locked transaction.
    expect(source).toMatch(/time_on_site_correction_seq: trx\.raw\('COALESCE\(time_on_site_correction_seq, 0\) \+ 1'\)/);
    // Both post-commit markComplete callers pass the observed revision.
    expect((source.match(/expectedCorrectionSeq: svc\.time_on_site_correction_seq \?\? null,/g) || []).length).toBe(2);
    // And the losing live override must not stamp its derived end or its
    // typed minutes over the correction's columns.
    expect(source).toMatch(/const adjustedEndedAt = !isBackfillCompletion && liveAdjustedTimeOnSite\s*\n\s*&& !correctionPreservedMidFlight\s*\n\s*\? adjustedCompletionEndInstant\(svc, effectiveTimeOnSite, completionEndedAt\)\s*\n\s*: null;/);
    expect(source).toMatch(/if \(!isBackfillCompletion && liveAdjustedTimeOnSite && !correctionPreservedMidFlight\) \{/);
  });

  test('the first-transition tracker write carries the atomic stamp fence (codex P2 round 16)', () => {
    const trackerSource = fs.readFileSync(
      path.join(__dirname, '../services/track-transitions.js'),
      'utf8',
    );
    // The in-memory transitionStampMatches check races a correction that
    // commits between loadService and the UPDATE — the full write predicates
    // on the stamp, and a fenced 0-row result retries as a transition-only
    // flip so the newer correction's lifecycle columns survive.
    expect(trackerSource).toMatch(/const transitionOnlyFlip = \(\) => db\('scheduled_services'\)\s*\n\s*\.where\(\{ id: serviceId \}\)\s*\n\s*\.whereIn\('track_state', transitionableStates\)\s*\n\s*\.update\(\{ track_state: 'complete', updated_at: now \}\);/);
    expect(trackerSource).toMatch(/if \(updated === 0 && stampFenceActive\) \{\s*\n\s*updated = await transitionOnlyFlip\(\);\s*\n\s*if \(updated > 0\) completedAtStamp = null;/);
  });

  test('the already-complete rewrite is conditional on the correction stamp too (codex P2 round 14)', () => {
    const trackerSource = fs.readFileSync(
      path.join(__dirname, '../services/track-transitions.js'),
      'utf8',
    );
    // completed_at alone is not a version token — a clamped newer
    // correction moves the stamp without moving completed_at, so the UPDATE
    // itself predicates on the stamp the caller's instant belongs to.
    expect(trackerSource).toMatch(/whereRaw\('time_on_site_correction_seq IS NOT DISTINCT FROM \?', \[\s*\n\s*fenceSeq == null \? null : Number\(fenceSeq\),\s*\n\s*\]\)/);
    // The fence defaults to the revision the call observed at load, so
    // status-route completions (no stated expectation) are fenced too
    // (codex P2 round 18).
    expect(trackerSource).toMatch(/const fenceSeq = opts\.expectedCorrectionSeq !== undefined\s*\n\s*\? opts\.expectedCorrectionSeq\s*\n\s*: \(svc\.time_on_site_correction_seq \?\? null\);/);
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

  test('the costing fence trips on the correction REVISION even when the minutes value is unchanged (codex P2 round 19)', async () => {
    // Correction A and correction B both say 45 — distinct revisions. B's
    // recalculation (pricing against newer financial inputs) finishes
    // first; A's run re-reads the locked row, sees the seq moved, and must
    // bail even though the minutes compare equal.
    const { calculateJobCost: realCalculateJobCost } = jest.requireActual('../services/job-costing');
    const writes = { jobCosts: [], recordUpdates: [] };
    let svcReads = 0;
    const svcAtRead = {
      id: 'svc-1', customer_id: 'cust-1', status: 'completed',
      service_time_minutes: 45, actual_duration_minutes: 45,
      time_on_site_adjusted_minutes: 45,
      time_on_site_correction_seq: 1,
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
            return svcReads === 1 ? svcAtRead : { ...svcAtRead, time_on_site_correction_seq: 2 };
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
    expect(costingSource).toMatch(/\|\| norm\(rowNow\?\.time_on_site_correction_seq\) !== norm\(svc\.time_on_site_correction_seq\)/);
  });

  test('a live override advances the revision, and tuple edits heal the legacy record link first (codex P2 round 19)', () => {
    // The live-override finalization is a correction: without a seq bump
    // the default-on tracker fence still matches the old revision and a
    // racing status-route completion can overwrite the override.
    expect(source).toMatch(/const bumpedSeq = \(Number\(\(lockedSvcRow \|\| svc\)\.time_on_site_correction_seq\) \|\| 0\) \+ 1;\s*\n\s*lifecycleUpdates\.time_on_site_correction_seq = bumpedSeq;\s*\n\s*svc\.time_on_site_correction_seq = bumpedSeq;/);
    // update-details resolves pre-FK legacy records through the OLD
    // (customer, date, type) tuple and stamps the durable FK BEFORE the
    // tuple changes — otherwise the time-on-site PATCH searches with the
    // new tuple and leaves the customer report stale.
    const adminScheduleSource = fs.readFileSync(
      path.join(__dirname, '../routes/admin-schedule.js'),
      'utf8',
    );
    const healAt = adminScheduleSource.indexOf('resolveServiceRecord(trx, preTupleRow, srCols)');
    const tupleUpdateAt = adminScheduleSource.indexOf("await trx('scheduled_services').where({ id: req.params.id }).update(updates);");
    expect(healAt).toBeGreaterThan(-1);
    expect(tupleUpdateAt).toBeGreaterThan(healAt);
    expect(adminScheduleSource).toMatch(/if \(legacyRecord && !legacyViaFk && !legacyAmbiguous\) \{\s*\n\s*await trx\('service_records'\)\s*\n\s*\.where\(\{ id: legacyRecord\.id \}\)\s*\n\s*\.update\(\{ scheduled_service_id: req\.params\.id \}\);/);
    // Round-20 guards: the heal takes the scheduled-service lock FIRST
    // (same lock order as the correction and costing paths — opposite
    // order deadlocks), and only a COMPLETED visit can own the record (an
    // open visit sharing the tuple must not steal a completed visit's
    // report).
    expect(adminScheduleSource).toMatch(/const preTupleRow = await trx\('scheduled_services'\)\.where\(\{ id: req\.params\.id \}\)\.forUpdate\(\)\.first\(\);/);
    expect(adminScheduleSource).toMatch(/if \(preTupleRow && preTupleRow\.status === 'completed' && srCols\.scheduled_service_id\) \{/);
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

  test('the per-save revision changes the key even when the minutes do not (codex P2 round 18)', () => {
    // A same-minutes re-save repairs end stamps — rendered content changed,
    // value didn't. The rev keeps the stale in-flight render's write-back
    // off the current key. Pre-rev corrected records keep their value-only
    // key (no cache bust); junk revs contribute nothing.
    expect(timeOnSiteAdjustedPdfSignature({
      structured_notes: JSON.stringify({ timeOnSiteAdjusted: true, timeOnSite: 45, timeOnSiteRev: 1 }),
    })).toBe('-tos45r1');
    expect(timeOnSiteAdjustedPdfSignature({
      structured_notes: { timeOnSiteAdjusted: true, timeOnSite: 45, timeOnSiteRev: 2 },
    })).toBe('-tos45r2');
    expect(timeOnSiteAdjustedPdfSignature({
      structured_notes: { timeOnSiteAdjusted: true, timeOnSite: 45, timeOnSiteRev: 'junk' },
    })).toBe('-tos45');
    // The PATCH bumps the rev in the same atomic merge that writes the keys.
    expect(source).toMatch(/jsonb_build_object\('timeOnSiteRev',\s*\n\s*COALESCE\(NULLIF\(COALESCE\(structured_notes::jsonb, '\{\}'::jsonb\) ->> 'timeOnSiteRev', ''\), '0'\)::int \+ 1\)/);
  });

  test('every storage-key composition site carries the component — write and expected sides in both modules', () => {
    // A missing site desynchronizes written vs expected keys: adjusted
    // records would either serve stale PDFs (the race this fences) or
    // re-render on every view (a silent cost). Two sites per module.
    expect((pdfQueueSource.match(/timeOnSiteAdjustedPdfSignature\(service\)/g) || []).length).toBe(2);
    expect((reportsPublicSource.match(/timeOnSiteAdjustedPdfSignature\(service\)/g) || []).length).toBe(2);
  });
});

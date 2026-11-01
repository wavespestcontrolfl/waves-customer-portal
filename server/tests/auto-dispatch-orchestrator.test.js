// Orchestrator glue test: mock the heavy sub-services (DB-backed) but use the
// REAL scorer + config so threshold / mode / counter / idempotency logic is
// exercised end to end.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/auto-dispatch/eligibility', () => ({
  isEligibleForAutoDispatch: jest.fn(() => ({ eligible: true })),
  isRecurringPlanActive: jest.fn(async () => ({ active: true })),
  isPersonPlacedVisit: jest.fn(async () => ({ placed: false })),
  VALID_STATUSES: jest.requireActual('../services/auto-dispatch/eligibility').VALID_STATUSES,
  heldOutOfAutoDispatch: jest.requireActual('../services/auto-dispatch/eligibility').heldOutOfAutoDispatch,
  lapsedPlanKeys: jest.fn(async () => new Set()),
  planKey: jest.requireActual('../services/auto-dispatch/eligibility').planKey,
  SLOT_CHANGED_SQL: '(1 = 1)',
}));
jest.mock('../services/auto-dispatch/preferences', () => ({
  getCustomerSchedulingPreferences: jest.fn(async () => ({
    preferred_day_indexes: [], effective_time_window: null, preferred_time_window: null,
    blackout: null, service_category: 'general', has_explicit_prefs: false, raw_snapshot: null,
  })),
}));
jest.mock('../services/auto-dispatch/candidate-slots', () => ({
  findValidCandidateSlots: jest.fn(),
  _internals: { readCurrentConflict: jest.fn(async () => null) },
}));
// The real composer over the faked notification store, spied: the pin
// notices assert the store call, the needs-a-person notices the composer call.
jest.mock('../services/admin-alert-compose', () => {
  const actual = jest.requireActual('../services/admin-alert-compose');
  return { ...actual, raiseAdminAlert: jest.fn(actual.raiseAdminAlert) };
});
jest.mock('../services/auto-dispatch/apply', () => ({ applyAutoDispatchMove: jest.fn(), unitMoveSize: jest.fn(async () => 1), revalidatePlacement: jest.fn(async () => ({ ok: true })), previewGroupMove: jest.fn(async () => null) }));
jest.mock('../services/geocoder', () => ({ ensureCustomerGeocoded: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({ id: 'n1' })),
  safeErrorSummary: jest.requireActual('../services/notification-service').safeErrorSummary,
  _private: { doneColumns: () => ({ done_at: 'now', done_by: 'auto-dispatch' }) },
}));
jest.mock('../services/auto-dispatch/audit', () => ({
  // Real budget helpers and key shape; only the notification-store read is faked.
  ...jest.requireActual('../services/auto-dispatch/audit'),
  standingMissingGeoKeys: jest.fn(async () => new Set()),
  ringsLeft: jest.fn(async () => 10),
  standingNoticeKeys: jest.fn(async () => new Set()),
  recentBudgetKeys: jest.fn(async () => new Set()),
  retireResolvedNotices: jest.fn(async () => {}),
  startRun: jest.fn(async () => 'run1'),
  logDecision: jest.fn(async () => {}),
  completeRun: jest.fn(async () => {}),
  flagUnplacedVisits: jest.fn(async () => 0),
  retireMissingGeoNotices: jest.fn(async () => {}),
  maintainMissingGeoNotices: jest.fn(async () => {}),
}));

jest.mock('../services/auto-dispatch/check-down-notice', () => ({ noteRun: jest.fn(async () => ({ action: 'none' })) }));
// The van's departure (GATE_AUTO_DISPATCH_DAY_RULES): read only when the run's day rules are on.
jest.mock('../services/scheduling/departure-time', () => ({ dayDepartureMinutes: jest.fn(async () => 450) }));

jest.mock('../services/tech-visit-notifications', () => ({
  pushAutoDispatchSummary: jest.fn(async () => ({ pushed: 1 })),
  beginAutoDispatchRun: jest.fn(async () => ({ pushed: 0 })),
}));

const db = require('../models/db');
const techNotices = require('../services/tech-visit-notifications');
const eligibility = require('../services/auto-dispatch/eligibility');
const candidateSlots = require('../services/auto-dispatch/candidate-slots');
const apply = require('../services/auto-dispatch/apply');
const geocoder = require('../services/geocoder');
const notifications = require('../services/notification-service');
const { raiseAdminAlert } = require('../services/admin-alert-compose');
const audit = require('../services/auto-dispatch/audit');
const { runAutoDispatch, _internals } = require('../services/auto-dispatch');

function buildChain(result) {
  const chain = {};
  const methods = ['leftJoin', 'where', 'whereIn', 'whereNot', 'whereNotIn', 'whereNull', 'whereNotNull',
    'orWhere', 'orWhereNull', 'orWhereNotNull', 'select', 'orderBy', 'orderByRaw', 'limit', 'first', 'returning', 'count', 'whereRaw', 'groupBy', 'update'];
  methods.forEach((m) => { chain[m] = (...args) => { args.forEach((a) => { if (typeof a === 'function') a.call(chain); }); return chain; }; });
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

let servicesResult;
// What the durable move log (reschedule_log) returns per read, in order; an
// Error rejects that read. Past the end it reads empty.
let moveLogReads;
function moveLogChain() {
  const next = moveLogReads.length ? moveLogReads.shift() : [];
  const chain = buildChain([]);
  if (next instanceof Error) chain.then = (resolve, reject) => Promise.reject(next).then(resolve, reject);
  else chain.then = (resolve, reject) => Promise.resolve(next).then(resolve, reject);
  return chain;
}
function svc(overrides = {}) {
  return {
    id: 's1', customer_id: 'c1', is_recurring: true, recurring_parent_id: null,
    status: 'confirmed', scheduled_date: '2026-08-04', technician_id: 't1',
    window_start: '09:00', window_end: '11:00', auto_dispatch_change_count: 0, ...overrides,
  };
}

const CURRENT = { is_current: true, detour_minutes: 40, stops_that_day: 3, technician_id: 't1', date: '2026-08-04', start_time: '09:00', capability_level: 'qualified' };
// An already-efficient current placement — a marginally-better candidate should NOT move it.
const CURRENT_GOOD = { ...CURRENT, detour_minutes: 10 };
const CAND_BIG = { is_current: false, detour_minutes: 0, stops_that_day: 5, technician_id: 't1', date: '2026-08-11', start_time: '08:00', capability_level: 'qualified', total_drive_minutes: 10 };
const CAND_SMALL = { is_current: false, detour_minutes: 8, stops_that_day: 3, technician_id: 't1', date: '2026-08-11', start_time: '09:00', capability_level: 'qualified', total_drive_minutes: 12 };
const CAND_MODERATE = { is_current: false, detour_minutes: 10, stops_that_day: 5, technician_id: 't1', date: '2026-08-11', start_time: '08:00', capability_level: 'qualified', total_drive_minutes: 12 };

beforeEach(() => {
  jest.clearAllMocks();
  servicesResult = [svc()];
  moveLogReads = [];
  candidateSlots._internals.readCurrentConflict.mockReset().mockResolvedValue(null);
  db.mockImplementation((table) => {
    if (table === 'reschedule_log') return moveLogChain();
    return buildChain(table === 'technician_capabilities' ? [] : servicesResult);
  });
  eligibility.isEligibleForAutoDispatch.mockReturnValue({ eligible: true });
  eligibility.isRecurringPlanActive.mockResolvedValue({ active: true });
  audit.standingMissingGeoKeys.mockResolvedValue(new Set());
  apply.applyAutoDispatchMove.mockResolvedValue({ ok: true, pre_status: 'confirmed', post_status: 'confirmed' });
  apply.revalidatePlacement.mockResolvedValue({ ok: true });
});

function lastDecision(action) {
  return audit.logDecision.mock.calls.map((c) => c[1]).filter((d) => d.action === action).pop();
}

test('dry_run recommends a clearly-better slot without applying', async () => {
  candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG] });
  const res = await runAutoDispatch({ mode: 'dry_run' });
  expect(res).toMatchObject({ recommended: 1, changed: 0, evaluated: 1 });
  expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
  const rec = lastDecision('recommended');
  expect(rec.reason_code).toBe('DRY_RUN_RECOMMENDATION');
  expect(rec.scores.improvement).toBeGreaterThanOrEqual(15);
});

test('apply mode moves the visit and logs a changed decision', async () => {
  const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
  process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true'; // apply gate must be on to mutate
  try {
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG] });
    const res = await runAutoDispatch({ mode: 'apply' });
    expect(res).toMatchObject({ changed: 1 });
    expect(apply.applyAutoDispatchMove).toHaveBeenCalledTimes(1);
    expect(lastDecision('changed').reason_code).toBe('CHANGE_APPLIED');
  } finally {
    process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
  }
});

test('every run ends by telling the move-check-down notice what the check did (owner audit 2026-10-22, finding 1)', async () => {
  const checkDown = require('../services/auto-dispatch/check-down-notice');
  await runAutoDispatch({ mode: 'dry_run' });
  expect(checkDown.noteRun).toHaveBeenCalledTimes(1);
  const [state, opts] = checkDown.noteRun.mock.calls[0];
  expect(opts).toEqual({ enabled: expect.any(Boolean), nowDate: expect.any(Date) });
  // The run's own tally (null when the check is off), before the run is recorded.
  expect(state === null || typeof state.broke === 'number').toBe(true);
  expect(checkDown.noteRun.mock.invocationCallOrder[0]).toBeLessThan(audit.completeRun.mock.invocationCallOrder[0]);
});

test('a run that moved visits sends the one summary push after the run is recorded; a dry run never does', async () => {
  const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
  process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
  try {
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG] });
    await runAutoDispatch({ mode: 'apply' });
    expect(techNotices.pushAutoDispatchSummary).toHaveBeenCalledTimes(1);
    expect(techNotices.pushAutoDispatchSummary).toHaveBeenCalledWith({ runId: 'run1' });
    expect(audit.completeRun.mock.invocationCallOrder[0])
      .toBeLessThan(techNotices.pushAutoDispatchSummary.mock.invocationCallOrder[0]);
    // Each run starts by pushing what a crashed run held, then holds its own under its id.
    expect(techNotices.beginAutoDispatchRun).toHaveBeenCalledWith('run1');
    expect(techNotices.beginAutoDispatchRun.mock.invocationCallOrder[0])
      .toBeLessThan(apply.applyAutoDispatchMove.mock.invocationCallOrder[0]);

    techNotices.pushAutoDispatchSummary.mockClear();
    await runAutoDispatch({ mode: 'dry_run' });
    expect(techNotices.pushAutoDispatchSummary).not.toHaveBeenCalled();
  } finally {
    process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
  }
});

test('the summary push still goes out when the audit row update fails (the per-visit pushes were held)', async () => {
  const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
  process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
  try {
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG] });
    audit.completeRun.mockRejectedValueOnce(new Error('audit down'));
    await expect(runAutoDispatch({ mode: 'apply' })).rejects.toThrow('audit down');
    expect(techNotices.pushAutoDispatchSummary).toHaveBeenCalledWith({ runId: 'run1' });
  } finally {
    process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
  }
});

test('apply requested without the server gate is downgraded to a dry-run recommendation', async () => {
  const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
  delete process.env.AUTO_DISPATCH_ALLOW_APPLY;
  try {
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG] });
    const res = await runAutoDispatch({ mode: 'apply' });
    expect(res).toMatchObject({ changed: 0, recommended: 1 });
    expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
    expect(audit.flagUnplacedVisits).toHaveBeenCalledTimes(1);
  } finally {
    process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
  }
});

test('apply mode honors the per-run change cap and counts cap-held moves as recommended', async () => {
  const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
  process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
  try {
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG] });
    const res = await runAutoDispatch({ mode: 'apply', maxChangesPerRun: 0 });
    expect(res).toMatchObject({ changed: 0, recommended: 1 });
    expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
    expect(audit.flagUnplacedVisits).toHaveBeenCalledTimes(1);
    expect(lastDecision('recommended').reason_code).toBe('MAX_CHANGES_REACHED');
  } finally {
    process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
  }
});

test('below-threshold improvement is left unchanged', async () => {
  candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT_GOOD, candidates: [CAND_SMALL] });
  const res = await runAutoDispatch({ mode: 'apply' });
  expect(res).toMatchObject({ changed: 0, recommended: 0 });
  expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
  expect(lastDecision('no_change').reason_code).toBe('NO_SCORE_IMPROVEMENT');
});

test('fails closed (run status failed) when capability data cannot load', async () => {
  db.mockImplementation((table) => {
    if (table === 'technician_capabilities') return { select: () => Promise.reject(new Error('capability table read failed')) };
    return buildChain(servicesResult);
  });
  const res = await runAutoDispatch({ mode: 'dry_run' });
  expect(res.status).toBe('failed');
  expect(candidateSlots.findValidCandidateSlots).not.toHaveBeenCalled();
});

test('self-heals a MISSING_GEO customer by geocoding, then re-checks (not skipped)', async () => {
  geocoder.ensureCustomerGeocoded.mockResolvedValue({ lat: 27.4, lng: -82.5 });
  eligibility.isEligibleForAutoDispatch
    .mockReturnValueOnce({ eligible: false, reason_code: 'MISSING_GEO', reason_description: 'no geo' })
    .mockReturnValueOnce({ eligible: true });
  candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG] });
  const res = await runAutoDispatch({ mode: 'dry_run' });
  expect(geocoder.ensureCustomerGeocoded).toHaveBeenCalledTimes(1);
  expect(res).toMatchObject({ skipped: 0, evaluated: 1, geocoded: 1, recommended: 1 });
  expect(notifications.notifyAdmin).not.toHaveBeenCalled(); // healed: nothing to tell staff
});

test('still skips MISSING_GEO when geocoding cannot resolve the address', async () => {
  geocoder.ensureCustomerGeocoded.mockResolvedValue(null);
  eligibility.isEligibleForAutoDispatch.mockReturnValue({ eligible: false, reason_code: 'MISSING_GEO', reason_description: 'no geo' });
  const res = await runAutoDispatch({ mode: 'dry_run' });
  expect(geocoder.ensureCustomerGeocoded).toHaveBeenCalledTimes(1);
  expect(res).toMatchObject({ skipped: 1, evaluated: 0, geocoded: 0 });
  expect(lastDecision('skipped').reason_code).toBe('MISSING_GEO');
});

test('a visit still without a map point after the geocode retry raises one admin notice, deduped per visit', async () => {
  geocoder.ensureCustomerGeocoded.mockResolvedValue(null);
  eligibility.isEligibleForAutoDispatch.mockReturnValue({ eligible: false, reason_code: 'MISSING_GEO', reason_description: 'no geo' });
  const res = await runAutoDispatch({ mode: 'dry_run' });
  expect(res).toMatchObject({ skipped: 1, failed: 0, status: 'completed' });
  expect(notifications.notifyAdmin).toHaveBeenCalledTimes(1);
  expect(notifications.notifyAdmin).toHaveBeenCalledWith(
    'schedule_conflict', 'Schedule — fix the address pin on a visit', expect.stringContaining('Aug 4'),
    expect.objectContaining({
      bell: true,
      link: '/admin/dispatch?tab=schedule&date=2026-08-04&appointment=s1',
      dedupeKey: 'auto-dispatch-missing-geo:s1:2026-08-04',
      refreshOnDedupe: true,
      metadata: expect.objectContaining({ scheduledServiceId: 's1', customerId: 'c1', scheduledDate: '2026-08-04' }),
    }),
  );
});

describe('missing-geo notice budget (Codex #6208 r3)', () => {
  function visitsWithoutPin(count) {
    servicesResult = Array.from({ length: count }, (_, i) => svc({ id: `g${i}`, customer_id: `c${i}`, scheduled_date: `2026-08-${String(10 + i).padStart(2, '0')}` }));
    db.mockImplementation((table) => buildChain(table === 'technician_capabilities' ? [] : servicesResult));
    geocoder.ensureCustomerGeocoded.mockResolvedValue(null);
    eligibility.isEligibleForAutoDispatch.mockReturnValue({ eligible: false, reason_code: 'MISSING_GEO', reason_description: 'no geo' });
  }
  const keysRung = () => notifications.notifyAdmin.mock.calls.map((c) => c[3].dedupeKey);

  test('11 visits ring 10 notices, soonest date first; the latest waits for the next run', async () => {
    visitsWithoutPin(11);
    const res = await runAutoDispatch({ mode: 'dry_run' });
    expect(res).toMatchObject({ skipped: 11, failed: 0, status: 'completed' });
    expect(keysRung()).toHaveLength(10);
    expect(keysRung()[0]).toBe('auto-dispatch-missing-geo:g0:2026-08-10');
    expect(keysRung()).not.toContain('auto-dispatch-missing-geo:g10:2026-08-20');
  });

  // The recheck runs BEFORE the budget picks: the soonest visit's pin was
  // fixed since pass 1, so the eleventh visit takes its slot (Codex #6208 r9 P2).
  test('a visit fixed since pass 1 frees its slot for a later visit', async () => {
    visitsWithoutPin(11);
    let reads = 0;
    const fixedFirst = () => servicesResult.map((r, i) => (i === 0 ? { ...r, lat: 27.4, lng: -82.5 } : r));
    db.mockImplementation((table) => buildChain(table === 'technician_capabilities' ? [] : (reads++ === 0 ? servicesResult : fixedFirst())));
    await runAutoDispatch({ mode: 'dry_run' });
    expect(keysRung()).toHaveLength(10);
    expect(keysRung()).not.toContain('auto-dispatch-missing-geo:g0:2026-08-10');
    expect(keysRung()).toContain('auto-dispatch-missing-geo:g10:2026-08-20');
  });

  // A notice whose write fails rang nothing: its slot goes to the next visit (r13 P2).
  test('a failed notice write spends no slot', async () => {
    visitsWithoutPin(11);
    notifications.notifyAdmin.mockRejectedValueOnce(new Error('notification store down'));
    await runAutoDispatch({ mode: 'dry_run' });
    expect(notifications.notifyAdmin).toHaveBeenCalledTimes(11);
    expect(keysRung()).toContain('auto-dispatch-missing-geo:g10:2026-08-20');
  });

  // notifyAdmin resolves null on a failed write: no notice, no slot (r14 P2).
  test('a notice write that resolves null spends no slot', async () => {
    visitsWithoutPin(11);
    notifications.notifyAdmin.mockResolvedValueOnce(null);
    await runAutoDispatch({ mode: 'dry_run' });
    expect(notifications.notifyAdmin).toHaveBeenCalledTimes(11);
  });

  test('a visit with a standing notice is refreshed and spends no budget', async () => {
    visitsWithoutPin(12);
    // The soonest visit's notice stands: its write is deduped and does not ring.
    audit.standingMissingGeoKeys.mockResolvedValue(new Set(['auto-dispatch-missing-geo:g0:2026-08-10']));
    notifications.notifyAdmin.mockImplementation(async (_c, _t, _b, opts) => ({ id: 'n1', deduped: opts.dedupeKey === 'auto-dispatch-missing-geo:g0:2026-08-10' }));
    await runAutoDispatch({ mode: 'dry_run' });
    expect(keysRung()).toHaveLength(11); // the standing one + 10 new
    expect(keysRung()).toContain('auto-dispatch-missing-geo:g10:2026-08-20');
    expect(keysRung()).not.toContain('auto-dispatch-missing-geo:g11:2026-08-21');
  });
});

test('nothing rings during pass 1: the notice comes at the run end, and a failed key read is logged, not a run failure', async () => {
  geocoder.ensureCustomerGeocoded.mockResolvedValue(null);
  eligibility.isEligibleForAutoDispatch.mockReturnValue({ eligible: false, reason_code: 'MISSING_GEO', reason_description: 'no geo' });
  audit.standingMissingGeoKeys.mockRejectedValue(new Error('notification store down'));
  const res = await runAutoDispatch({ mode: 'dry_run' });
  expect(res).toMatchObject({ skipped: 1, failed: 0, status: 'completed' });
  expect(notifications.notifyAdmin).not.toHaveBeenCalled();
});

test('a lapsed plan raises no missing-geo notice', async () => {
  geocoder.ensureCustomerGeocoded.mockResolvedValue(null);
  eligibility.isEligibleForAutoDispatch.mockReturnValue({ eligible: false, reason_code: 'MISSING_GEO', reason_description: 'no geo' });
  eligibility.isRecurringPlanActive.mockResolvedValue({ active: false, reason_code: 'RECURRING_PLAN_INACTIVE', reason_description: 'lapsed' });
  await runAutoDispatch({ mode: 'dry_run' });
  expect(notifications.notifyAdmin).not.toHaveBeenCalled();
  // The lapsed visit is in the close list: a standing pin notice for it closes.
  expect(audit.retireMissingGeoNotices).toHaveBeenCalledWith(new Set(['s1']), expect.any(Date));
});

// A stamped address that differs from the customer's skips the geocode
// self-heal and its plan gate, so the notice's own plan check must put the
// lapsed visit in the close list (Codex #6208 r6 P2).
test('a lapsed plan on a visit with a divergent stamped address closes its standing pin notice', async () => {
  servicesResult = [svc({ id: 's1', service_address_line1: '1 Test Rd', customer_address_line1: '9 Sample Ave' })];
  geocoder.ensureCustomerGeocoded.mockResolvedValue(null);
  eligibility.isEligibleForAutoDispatch.mockReturnValue({ eligible: false, reason_code: 'MISSING_GEO', reason_description: 'no geo' });
  eligibility.isRecurringPlanActive.mockResolvedValue({ active: false, reason_code: 'RECURRING_PLAN_INACTIVE', reason_description: 'lapsed' });
  await runAutoDispatch({ mode: 'dry_run' });
  expect(geocoder.ensureCustomerGeocoded).not.toHaveBeenCalled();
  expect(notifications.notifyAdmin).not.toHaveBeenCalled();
  expect(audit.retireMissingGeoNotices).toHaveBeenCalledWith(new Set(['s1']), expect.any(Date));
});

// Pass 1 makes no plan read for a visit with no answer yet; the run's end
// reads every collected series in one query (Codex #6208 r27 P2).
test('pin notice candidates get one bulk plan read at the run\'s end, and a lapsed series closes', async () => {
  servicesResult = [
    svc({ id: 's1', recurring_parent_id: 'p1', service_address_line1: '1 Test Rd', customer_address_line1: '9 Sample Ave' }),
    svc({ id: 's2', recurring_parent_id: 'p2', service_address_line1: '2 Test Rd', customer_address_line1: '9 Sample Ave' }),
  ];
  eligibility.isEligibleForAutoDispatch.mockReturnValue({ eligible: false, reason_code: 'MISSING_GEO', reason_description: 'no geo' });
  eligibility.lapsedPlanKeys.mockImplementationOnce(async (rows) => new Set(rows.filter((r) => r.id === 's1').map(eligibility.planKey)));
  await runAutoDispatch({ mode: 'dry_run' });
  expect(eligibility.lapsedPlanKeys).toHaveBeenCalledTimes(1);
  expect(eligibility.lapsedPlanKeys.mock.calls[0][0].map((r) => r.id)).toEqual(['s1', 's2']);
  // One single-visit read: just before the one NEW notice (s2).
  expect(eligibility.isRecurringPlanActive).toHaveBeenCalledTimes(1);
  expect(notifications.notifyAdmin).toHaveBeenCalledTimes(1);
  expect(audit.retireMissingGeoNotices).toHaveBeenCalledWith(new Set(['s1']), expect.any(Date));
});

describe('missing-geo notice close at the end of a run', () => {
  beforeEach(() => {
    geocoder.ensureCustomerGeocoded.mockResolvedValue(null);
    eligibility.isEligibleForAutoDispatch.mockReturnValue({ eligible: false, reason_code: 'MISSING_GEO', reason_description: 'no geo' });
  });

  test('a visit still skipped for a missing pin is not in the close list', async () => {
    await runAutoDispatch({ mode: 'dry_run' });
    expect(audit.retireMissingGeoNotices).toHaveBeenCalledTimes(1);
    expect(audit.retireMissingGeoNotices).toHaveBeenCalledWith(new Set(), expect.any(Date));
  });

  test('a visit that passed eligibility has a usable pin, so its standing notice may close', async () => {
    eligibility.isEligibleForAutoDispatch.mockReturnValue({ eligible: true });
    await runAutoDispatch({ mode: 'dry_run' });
    expect(audit.retireMissingGeoNotices).toHaveBeenCalledWith(new Set(['s1']), expect.any(Date));
  });

  test('does not close on a run that failed before pass 1 finished', async () => {
    db.mockImplementation(() => { throw new Error('database down'); });
    const res = await runAutoDispatch({ mode: 'dry_run' });
    expect(res.status).toBe('failed');
    expect(audit.retireMissingGeoNotices).not.toHaveBeenCalled();
    // The standing-notice upkeep reads each notice's own visit, so it does
    // not depend on pass 1 (Codex #6208 r19 P2).
    expect(audit.maintainMissingGeoNotices).toHaveBeenCalledTimes(1);
  });

  test('does not close when a visit failed in pass 1 (it was not fully looked at)', async () => {
    eligibility.isEligibleForAutoDispatch.mockImplementation(() => { throw new Error('boom'); });
    const res = await runAutoDispatch({ mode: 'dry_run' });
    expect(res.failed).toBe(1);
    expect(audit.retireMissingGeoNotices).not.toHaveBeenCalled();
  });

  test('a failed close is logged and does not fail the run', async () => {
    audit.retireMissingGeoNotices.mockRejectedValueOnce(new Error('notification store down'));
    await expect(runAutoDispatch({ mode: 'dry_run' })).resolves.toMatchObject({ status: 'completed' });
  });
});

test('a pin fixed after pass 1 raises no missing-geo notice and the visit joins the close list (Codex #6208 r6 P2)', async () => {
  geocoder.ensureCustomerGeocoded.mockResolvedValue(null);
  eligibility.isEligibleForAutoDispatch.mockReturnValue({ eligible: false, reason_code: 'MISSING_GEO', reason_description: 'no geo' });
  // Every scheduled_services read after the load returns the row with a pin.
  let reads = 0;
  db.mockImplementation((table) => buildChain(table === 'technician_capabilities' ? [] : (reads++ === 0 ? [svc()] : [svc({ lat: 27.4, lng: -82.5 })])));
  await runAutoDispatch({ mode: 'dry_run' });
  expect(notifications.notifyAdmin).not.toHaveBeenCalled();
  expect(audit.retireMissingGeoNotices).toHaveBeenCalledWith(new Set(['s1']), expect.any(Date));
});

// The notice is raised at the run's end: a customer archived or deactivated
// since pass 1 gets no alert for a pin nobody needs to fix (Codex #6208 r7 P2).
test.each([
  ['archived', { customer_deleted_at: '2026-08-01T10:00:00Z' }],
  ['deactivated', { customer_active: false }],
  // Staff took the visit out of auto-dispatch after pass 1 (r21 P2).
  ['with a visit locked', { auto_dispatch_locked: true }],
  ['with a visit excluded', { auto_dispatch_excluded: true }],
  ['who confirmed the visit', { customer_confirmed: true }],
])('a customer %s after pass 1 raises no missing-geo notice', async (_label, change) => {
  geocoder.ensureCustomerGeocoded.mockResolvedValue(null);
  eligibility.isEligibleForAutoDispatch.mockReturnValue({ eligible: false, reason_code: 'MISSING_GEO', reason_description: 'no geo' });
  let reads = 0;
  db.mockImplementation((table) => buildChain(table === 'technician_capabilities' ? [] : (reads++ === 0 ? [svc()] : [svc(change)])));
  await runAutoDispatch({ mode: 'dry_run' });
  expect(notifications.notifyAdmin).not.toHaveBeenCalled();
});

// Pass 1 reuses the plan answer the geo self-heal read (no second read per
// skipped visit, r8 P2). The plan is read once more only just before a
// notice is raised, at most once per notice (r11 P2).
test('a missing-geo visit reads its plan once in pass 1 and once before its notice', async () => {
  geocoder.ensureCustomerGeocoded.mockResolvedValue(null);
  eligibility.isEligibleForAutoDispatch.mockReturnValue({ eligible: false, reason_code: 'MISSING_GEO', reason_description: 'no geo' });
  await runAutoDispatch({ mode: 'dry_run' });
  expect(eligibility.isRecurringPlanActive).toHaveBeenCalledTimes(2);
  expect(notifications.notifyAdmin).toHaveBeenCalledTimes(1);
});

test('a plan that lapses between pass 1 and the notice raises nothing and joins the close list (Codex #6208 r11 P2)', async () => {
  geocoder.ensureCustomerGeocoded.mockResolvedValue(null);
  eligibility.isEligibleForAutoDispatch.mockReturnValue({ eligible: false, reason_code: 'MISSING_GEO', reason_description: 'no geo' });
  eligibility.isRecurringPlanActive.mockResolvedValueOnce({ active: true }).mockResolvedValueOnce({ active: false });
  await runAutoDispatch({ mode: 'dry_run' });
  expect(notifications.notifyAdmin).not.toHaveBeenCalled();
  expect(audit.retireMissingGeoNotices).toHaveBeenCalledWith(new Set(['s1']), expect.any(Date));
});

// notifyAdmin writes no row for an internal test customer, so its visit takes
// no slot from a real customer's (Codex #6208 r8 P2).
test('withinRingBudget skips an internal test customer before it counts slots', () => {
  const { INTERNAL_TEST_CUSTOMER_IDS } = require('../services/internal-test-customers');
  const rows = [
    { id: 'demo', customer_id: INTERNAL_TEST_CUSTOMER_IDS[0], date: '2026-08-01' },
    { id: 'real', customer_id: 'c-real', date: '2026-08-02' },
  ];
  expect(audit.withinRingBudget(rows, new Set(), 1, audit.missingGeoKey).map((r) => r.id)).toEqual(['real']);
});

test('a failed missing-geo notice is logged and fails neither the visit nor the run', async () => {
  geocoder.ensureCustomerGeocoded.mockResolvedValue(null);
  eligibility.isEligibleForAutoDispatch.mockReturnValue({ eligible: false, reason_code: 'MISSING_GEO', reason_description: 'no geo' });
  notifications.notifyAdmin.mockRejectedValueOnce(new Error('notification store down'));
  const res = await runAutoDispatch({ mode: 'dry_run' });
  expect(res).toMatchObject({ skipped: 1, failed: 0, status: 'completed' });
  expect(lastDecision('skipped').reason_code).toBe('MISSING_GEO');
});

test('an ineligible visit for any other reason raises no missing-geo notice', async () => {
  eligibility.isEligibleForAutoDispatch.mockReturnValue({ eligible: false, reason_code: 'LOCKED', reason_description: 'locked' });
  await runAutoDispatch({ mode: 'dry_run' });
  expect(notifications.notifyAdmin).not.toHaveBeenCalled();
});

test('caps geocode ATTEMPTS even when they all fail (counts attempts, not successes)', async () => {
  servicesResult = [svc({ id: 's1', customer_id: 'c1' }), svc({ id: 's2', customer_id: 'c2' })];
  db.mockImplementation((table) => buildChain(table === 'technician_capabilities' ? [] : servicesResult));
  geocoder.ensureCustomerGeocoded.mockResolvedValue(null); // never resolves
  eligibility.isEligibleForAutoDispatch.mockReturnValue({ eligible: false, reason_code: 'MISSING_GEO', reason_description: 'no geo' });
  const res = await runAutoDispatch({ mode: 'dry_run', maxGeocodesPerRun: 1 });
  expect(geocoder.ensureCustomerGeocoded).toHaveBeenCalledTimes(1); // 2 missing-geo, cap=1 → only 1 API attempt
  expect(res).toMatchObject({ skipped: 2, geocoded: 0, geocode_attempts: 1 });
});

test('dedupes geocode per customer — one API call for multiple visits of the same customer', async () => {
  servicesResult = [svc({ id: 's1', customer_id: 'cX' }), svc({ id: 's2', customer_id: 'cX' })];
  db.mockImplementation((table) => buildChain(table === 'technician_capabilities' ? [] : servicesResult));
  geocoder.ensureCustomerGeocoded.mockResolvedValue({ lat: 27.4, lng: -82.5 });
  eligibility.isEligibleForAutoDispatch
    .mockReturnValueOnce({ eligible: false, reason_code: 'MISSING_GEO', reason_description: 'x' }) // s1 initial
    .mockReturnValueOnce({ eligible: true })                                                       // s1 recheck (post-geocode)
    .mockReturnValueOnce({ eligible: false, reason_code: 'MISSING_GEO', reason_description: 'x' }) // s2 initial
    .mockReturnValueOnce({ eligible: true });                                                      // s2 recheck (from cache)
  candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG] });
  const res = await runAutoDispatch({ mode: 'dry_run' });
  expect(geocoder.ensureCustomerGeocoded).toHaveBeenCalledTimes(1); // one call for both visits of cX
  expect(res).toMatchObject({ evaluated: 2, geocoded: 1, geocode_attempts: 1, skipped: 0 });
});

test('does not spend geocode budget on an inactive recurring plan', async () => {
  geocoder.ensureCustomerGeocoded.mockResolvedValue({ lat: 27.4, lng: -82.5 });
  eligibility.isEligibleForAutoDispatch.mockReturnValue({ eligible: false, reason_code: 'MISSING_GEO', reason_description: 'x' });
  eligibility.isRecurringPlanActive.mockResolvedValue({ active: false, reason_code: 'RECURRING_PLAN_INACTIVE', reason_description: 'lapsed' });
  const res = await runAutoDispatch({ mode: 'dry_run' });
  expect(geocoder.ensureCustomerGeocoded).not.toHaveBeenCalled(); // plan checked first → no geocode
  expect(res).toMatchObject({ skipped: 1, geocode_attempts: 0 });
  expect(lastDecision('skipped').reason_code).toBe('RECURRING_PLAN_INACTIVE');
});

test('a visit a person put on its date is skipped before scoring, in every mode', async () => {
  eligibility.isPersonPlacedVisit.mockResolvedValueOnce({ placed: true, reason_code: 'PERSON_PLACED', reason_description: 'Date chosen by the customer (series move m1)' });
  const res = await runAutoDispatch({ mode: 'apply' });
  expect(res).toMatchObject({ skipped: 1, evaluated: 0, changed: 0 });
  expect(candidateSlots.findValidCandidateSlots).not.toHaveBeenCalled();
  expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
  expect(lastDecision('skipped').reason_code).toBe('PERSON_PLACED');
});

test('an unreadable move history skips the visit and marks the run degraded, not completed', async () => {
  eligibility.isPersonPlacedVisit.mockResolvedValueOnce({ placed: true, degraded: true, reason_code: 'PERSON_PLACED_UNKNOWN', reason_description: 'x' });
  const res = await runAutoDispatch({ mode: 'apply' });
  expect(res).toMatchObject({ skipped: 1, changed: 0, status: 'completed_with_errors' });
  expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
});

test('a grouped sibling refusal suppresses a dry-run recommendation outside flex mode too', async () => {
  candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG] });
  apply.previewGroupMove.mockResolvedValueOnce({ code: 'GROUP_MEMBER_GUARD', description: 'sibling placed by a person' });
  const res = await runAutoDispatch({ mode: 'dry_run' });
  expect(res).toMatchObject({ recommended: 0 });
  expect(apply.previewGroupMove).toHaveBeenCalled();
});

test('ineligible service is skipped before candidate generation', async () => {
  eligibility.isEligibleForAutoDispatch.mockReturnValue({ eligible: false, reason_code: 'INSIDE_LOCK_WINDOW', reason_description: 'x' });
  const res = await runAutoDispatch({ mode: 'dry_run' });
  expect(res).toMatchObject({ skipped: 1, evaluated: 0 });
  expect(candidateSlots.findValidCandidateSlots).not.toHaveBeenCalled();
  expect(lastDecision('skipped').reason_code).toBe('INSIDE_LOCK_WINDOW');
});

test('dry-run recommendation for a pending visit projects pending (not confirmed)', async () => {
  servicesResult = [svc({ status: 'pending' })];
  db.mockImplementation((table) => buildChain(table === 'technician_capabilities' ? [] : servicesResult));
  candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG] });
  await runAutoDispatch({ mode: 'dry_run' });
  expect(lastDecision('recommended').newPlacement.status).toBe('pending');
});

test('no candidate slots → no_change NO_VALID_SLOT', async () => {
  candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [] });
  const res = await runAutoDispatch({ mode: 'dry_run' });
  expect(res.recommended).toBe(0);
  expect(lastDecision('no_change').reason_code).toBe('NO_VALID_SLOT');
});

test('a NO_VALID_SLOT row keeps what the search saw (the window and each day\'s open starts), so a full week reads as full (finding 6)', async () => {
  const SEARCH = { date_from: '2026-08-01', date_to: '2026-08-08', open_starts_by_date: { '2026-08-01': 0, '2026-08-03': 0 } };
  candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [], drops: null, feasible: 0, search: SEARCH });
  await runAutoDispatch({ mode: 'dry_run' });
  expect(lastDecision('no_change')).toMatchObject({ reason_code: 'NO_VALID_SLOT', constraints: expect.objectContaining({ search: SEARCH }) });
});

test('apply mode spends a tight cap on the BEST-improvement move, not the first by date', async () => {
  const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
  process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
  try {
    // Same current placement for all; candidates differ only by detour, so a
    // smaller detour = strictly larger improvement. s1 (lowest gain) comes FIRST
    // by scheduled_date; s2 has the biggest gain. With cap=1, date-order would
    // move s1 — best-first must move s2.
    const cand = (detour) => ({ is_current: false, detour_minutes: detour, stops_that_day: 3, technician_id: 't1', date: '2026-08-11', start_time: '08:00', capability_level: 'qualified', total_drive_minutes: 10 });
    servicesResult = [
      svc({ id: 's1', customer_id: 'c1', scheduled_date: '2026-08-04' }),
      svc({ id: 's2', customer_id: 'c2', scheduled_date: '2026-08-05' }),
      svc({ id: 's3', customer_id: 'c3', scheduled_date: '2026-08-06' }),
    ];
    db.mockImplementation((table) => buildChain(table === 'technician_capabilities' ? [] : servicesResult));
    const byId = { s1: cand(8), s2: cand(0), s3: cand(4) }; // improvement: s2 > s3 > s1
    candidateSlots.findValidCandidateSlots.mockImplementation(async (service) => ({ current: CURRENT, candidates: [byId[service.id]] }));

    const res = await runAutoDispatch({ mode: 'apply', maxChangesPerRun: 1 });

    expect(res).toMatchObject({ evaluated: 3, changed: 1, recommended: 2 });
    expect(apply.applyAutoDispatchMove).toHaveBeenCalledTimes(1);
    expect(apply.applyAutoDispatchMove.mock.calls[0][0].id).toBe('s2'); // the biggest gain, not s1
    expect(lastDecision('changed').service.id).toBe('s2');
  } finally {
    process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
  }
});

test('a beyond-cap move that re-evaluation finds superseded is dropped (no_change), not counted as a cap-held recommendation', async () => {
  const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
  process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
  try {
    // cap=1: s1 (bigger gain) applies; s2 is beyond the cap AND, on the live
    // re-evaluation, no longer has a valid slot. It must be no_change (superseded),
    // not a MAX_CHANGES_REACHED recommendation — otherwise the reported backlog
    // overcounts moves that aren't actually pending anymore.
    servicesResult = [
      svc({ id: 's1', customer_id: 'c1', scheduled_date: '2026-08-04' }),
      svc({ id: 's2', customer_id: 'c2', scheduled_date: '2026-08-05' }),
    ];
    db.mockImplementation((table) => buildChain(table === 'technician_capabilities' ? [] : servicesResult));
    let s2calls = 0;
    candidateSlots.findValidCandidateSlots.mockImplementation(async (service) => {
      if (service.id === 's1') return { current: CURRENT, candidates: [CAND_BIG] }; // biggest gain → applied
      s2calls += 1; // s2: qualifies in pass 1, superseded on pass-2 re-eval
      return s2calls === 1 ? { current: CURRENT, candidates: [CAND_MODERATE] } : { current: CURRENT, candidates: [] };
    });

    const res = await runAutoDispatch({ mode: 'apply', maxChangesPerRun: 1 });

    expect(res).toMatchObject({ changed: 1, recommended: 0 }); // s2 NOT counted as cap-held
    expect(apply.applyAutoDispatchMove).toHaveBeenCalledTimes(1);
    expect(apply.applyAutoDispatchMove.mock.calls[0][0].id).toBe('s1');
    expect(lastDecision('no_change').reason_description).toMatch(/No longer qualifies on live re-evaluation/);
  } finally {
    process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
  }
});

test('a planned move the operator locks/cancels mid-run is reported superseded (no_change), not applied or cap-held', async () => {
  const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
  process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
  try {
    // The visit qualifies in pass 1, but an operator locks/excludes/moves it during
    // the run window. revalidatePlacement re-reads the live row and reports it stale
    // BEFORE re-scoring — so it is no_change (superseded), never applied or cap-held,
    // and the audit log doesn't claim a move that's no longer pending.
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG] });
    apply.revalidatePlacement.mockResolvedValueOnce({ ok: false, reason: 'Visit was locked/excluded from auto-dispatch after scoring' });

    const res = await runAutoDispatch({ mode: 'apply', maxChangesPerRun: 5 });

    expect(res).toMatchObject({ evaluated: 1, changed: 0, recommended: 0 });
    expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
    const nc = lastDecision('no_change');
    expect(nc.reason_code).toBe('SUPERSEDED_DURING_RUN');
    expect(nc.reason_description).toMatch(/Superseded by an operator during the run/);
  } finally {
    process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
  }
});

test('apply mode re-evaluates before moving: a move superseded by the live schedule is dropped, not force-applied', async () => {
  const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
  process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
  try {
    // Pass-1 scoring sees a worthwhile move; the pass-2 re-evaluation (against the
    // now-live schedule) finds no valid slot — so it must NOT apply.
    candidateSlots.findValidCandidateSlots
      .mockResolvedValueOnce({ current: CURRENT, candidates: [CAND_BIG] }) // pass 1: qualifies
      .mockResolvedValueOnce({ current: CURRENT, candidates: [] });        // pass 2: superseded
    const res = await runAutoDispatch({ mode: 'apply', maxChangesPerRun: 5 });

    expect(res).toMatchObject({ evaluated: 1, changed: 0 });
    expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
    expect(candidateSlots.findValidCandidateSlots).toHaveBeenCalledTimes(2); // scored, then re-scored
    expect(lastDecision('no_change').reason_description).toMatch(/No longer qualifies on live re-evaluation/);
  } finally {
    process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
  }
});

test('idempotency: an already-moved visit needs a much larger gain to move again', async () => {
  candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_MODERATE] });

  // change_count 0 → moderate gain clears the base threshold (recommended)
  servicesResult = [svc({ auto_dispatch_change_count: 0 })];
  const fresh = await runAutoDispatch({ mode: 'dry_run' });
  expect(fresh.recommended).toBe(1);

  // change_count 1 → raised bar (stability floor) holds it (no_change)
  jest.clearAllMocks();
  candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_MODERATE] });
  eligibility.isEligibleForAutoDispatch.mockReturnValue({ eligible: true });
  eligibility.isRecurringPlanActive.mockResolvedValue({ active: true });
  servicesResult = [svc({ auto_dispatch_change_count: 1 })];
  db.mockImplementation((table) => buildChain(table === 'technician_capabilities' ? [] : servicesResult));
  const moved = await runAutoDispatch({ mode: 'dry_run' });
  expect(moved.recommended).toBe(0);
  expect(lastDecision('no_change').reason_code).toBe('NO_SCORE_IMPROVEMENT');
});


test('an untimed due date is placed even when it offers no route improvement', async () => {
  servicesResult = [svc({ window_start: null, window_end: null, recurring_dispatch_due_date: '2026-08-04' })];
  candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT_GOOD, candidates: [CAND_SMALL] });
  const res = await runAutoDispatch({ mode: 'dry_run', minScoreImprovement: 100 });
  expect(res).toMatchObject({ recommended: 1, changed: 0 });
  expect(audit.flagUnplacedVisits).toHaveBeenCalledTimes(1);
});

test('unplaced due dates get the run budget ahead of ordinary route improvements', async () => {
  const previous = process.env.AUTO_DISPATCH_ALLOW_APPLY;
  process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
  try {
    servicesResult = [svc({ id: 'ordinary' }), svc({ id: 'due', window_start: null, window_end: null, recurring_dispatch_due_date: '2026-08-04' })];
    candidateSlots.findValidCandidateSlots.mockImplementation(async (row) => row.id === 'due'
      ? { current: CURRENT_GOOD, candidates: [CAND_SMALL] }
      : { current: CURRENT, candidates: [CAND_BIG] });
    await runAutoDispatch({ mode: 'apply', maxChangesPerRun: 1 });
    expect(apply.applyAutoDispatchMove).toHaveBeenCalledTimes(1);
    expect(apply.applyAutoDispatchMove.mock.calls[0][0].id).toBe('due');
    expect(audit.flagUnplacedVisits).toHaveBeenCalledTimes(1);
  } finally {
    if (previous === undefined) delete process.env.AUTO_DISPATCH_ALLOW_APPLY;
    else process.env.AUTO_DISPATCH_ALLOW_APPLY = previous;
  }
});

test('never heals a moved secondary property with primary-customer coordinates', async () => {
  servicesResult = [svc({ service_address_line1: '200 Example Avenue', customer_address_line1: '100 Example Street' })];
  eligibility.isEligibleForAutoDispatch.mockReturnValue({ eligible: false, reason_code: 'MISSING_GEO' });
  const res = await runAutoDispatch({ mode: 'dry_run' });
  expect(geocoder.ensureCustomerGeocoded).not.toHaveBeenCalled();
  expect(candidateSlots.findValidCandidateSlots).not.toHaveBeenCalled();
  expect(res).toMatchObject({ skipped: 1, evaluated: 0, geocode_attempts: 0 });
});


test.each([
  ['2026-08-01', 'earlier-due'],
  ['2026-08-04', 'higher-score'],
])('capped due placement honors deadline %s before route score', async (earlierDue, expectedId) => {
  const previous = process.env.AUTO_DISPATCH_ALLOW_APPLY;
  process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
  try {
    servicesResult = [
      svc({ id: 'higher-score', window_start: null, window_end: null, recurring_dispatch_due_date: '2026-08-04' }),
      svc({ id: 'earlier-due', window_start: null, window_end: null, recurring_dispatch_due_date: new Date(`${earlierDue}T00:00:00Z`) }),
    ];
    candidateSlots.findValidCandidateSlots.mockImplementation(async (row) => row.id === 'earlier-due'
      ? { current: CURRENT_GOOD, candidates: [CAND_SMALL] }
      : { current: CURRENT, candidates: [CAND_BIG] });
    await runAutoDispatch({ mode: 'apply', maxChangesPerRun: 1 });
    expect(apply.applyAutoDispatchMove).toHaveBeenCalledTimes(1);
    expect(apply.applyAutoDispatchMove.mock.calls[0][0].id).toBe(expectedId);
  } finally {
    if (previous === undefined) delete process.env.AUTO_DISPATCH_ALLOW_APPLY;
    else process.env.AUTO_DISPATCH_ALLOW_APPLY = previous;
  }
});

// GATE_AUTO_DISPATCH_SHARED_MODEL SLOT_TAKEN fallback — Codex pre-push P1
// findings (2026-09-26): (1) a fallback candidate offered to apply.js must
// itself clear the SAME move threshold as `best`; (2) a successful fallback
// that lands on a DIFFERENT candidate must be audited as the candidate that
// ACTUALLY moved, not the first one tried.
describe('SLOT_TAKEN fallback correctness (Codex pre-push P1)', () => {
  const PREFS = {
    preferred_day_indexes: [], effective_time_window: null, preferred_time_window: null,
    blackout: null, service_category: 'general', preferred_days: null, raw_snapshot: null,
  };
  const CONFIG = { minScoreImprovement: 15, removeStabilityFloor: 35 };

  test('P1 #1: an alternate that does NOT itself clear the move threshold is excluded from rankedCandidates', async () => {
    // Barely better than CURRENT (detour 40→38, same stop count/tech) — a
    // real improvement of ~1.8 points, well under the 15-point threshold.
    const CAND_TINY = { is_current: false, detour_minutes: 38, stops_that_day: 3, technician_id: 't1', date: '2026-08-12', start_time: '09:00', capability_level: 'qualified', total_drive_minutes: 50 };
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG, CAND_TINY], drops: {} });

    const result = await _internals.evaluatePlacement(svc(), PREFS, {}, CONFIG, '2026-06-20');

    expect(result.kind).toBe('move');
    expect(result.best.date).toBe(CAND_BIG.date);
    expect(result.rankedCandidates.some((c) => c.date === CAND_TINY.date)).toBe(false);
    expect(result.rankedCandidates.every((c) => c.date === CAND_BIG.date)).toBe(true);
  });

  test('P1 #1 wired end to end: apply.js is never handed the below-threshold alternate as alternateCandidates', async () => {
    const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
    process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
    try {
      const CAND_TINY = { is_current: false, detour_minutes: 38, stops_that_day: 3, technician_id: 't1', date: '2026-08-12', start_time: '09:00', capability_level: 'qualified', total_drive_minutes: 50 };
      candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG, CAND_TINY], drops: {} });
      await runAutoDispatch({ mode: 'apply' });
      const config = apply.applyAutoDispatchMove.mock.calls[0][3];
      expect(config.alternateCandidates.some((c) => c.date === CAND_TINY.date)).toBe(false);
    } finally {
      process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
    }
  });

  test('P1 #1: a second candidate that ALSO clears the threshold (just not as good as best) IS offered as a fallback', async () => {
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG, CAND_MODERATE], drops: {} });
    const result = await _internals.evaluatePlacement(svc(), PREFS, {}, CONFIG, '2026-06-20');
    expect(result.kind).toBe('move');
    expect(result.rankedCandidates.map((c) => c.date + c.start_time)).toContain(CAND_MODERATE.date + CAND_MODERATE.start_time);
  });

  test('P1 #2: a successful SLOT_TAKEN fallback is audited as the candidate that ACTUALLY moved, not fresh.best', async () => {
    const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
    process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
    try {
      candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG, CAND_MODERATE], drops: {} });
      // apply.js reports it landed on CAND_MODERATE (a fallback) after a
      // SLOT_TAKEN on CAND_BIG (fresh.best), on its 2nd attempt.
      apply.applyAutoDispatchMove.mockResolvedValue({
        ok: true, pre_status: 'confirmed', post_status: 'confirmed', applied: CAND_MODERATE, attempts: 2,
      });
      const res = await runAutoDispatch({ mode: 'apply' });
      expect(res).toMatchObject({ changed: 1 });
      const changed = lastDecision('changed');
      // The audit describes CAND_MODERATE (what actually moved) — NOT CAND_BIG.
      expect(changed.newPlacement).toMatchObject({
        date: CAND_MODERATE.date, window_start: CAND_MODERATE.start_time, window_end: CAND_MODERATE.end_time, technician_id: CAND_MODERATE.technician_id,
      });
      expect(changed.routeMetrics.candidate_detour_minutes).toBe(CAND_MODERATE.detour_minutes);
      expect(changed.routeMetrics.candidate_total_drive_minutes).toBe(CAND_MODERATE.total_drive_minutes);
      // attempts (ids/numbers only) surfaces how many candidates were tried.
      expect(changed.routeMetrics.attempts).toBe(2);
    } finally {
      process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
    }
  });

  test('P1 #2: the common (no-fallback) case still audits fresh.best, with attempts defaulting to 1', async () => {
    const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
    process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
    try {
      candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG] });
      // No `applied`/`attempts` in the mocked result — mirrors a plain
      // rebooker mock that doesn't know about this lane at all.
      apply.applyAutoDispatchMove.mockResolvedValue({ ok: true, pre_status: 'confirmed', post_status: 'confirmed' });
      await runAutoDispatch({ mode: 'apply' });
      const changed = lastDecision('changed');
      expect(changed.newPlacement).toMatchObject({ date: CAND_BIG.date, window_start: CAND_BIG.start_time });
      expect(changed.routeMetrics.attempts).toBe(1);
    } finally {
      process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
    }
  });
});

// Codex r1 findings on the shared-model apply path (GATE_AUTO_DISPATCH_SHARED_MODEL).
describe('shared-model apply path (Codex r1)', () => {
  // Barely better than CURRENT — does not clear the move threshold.
  const CAND_TINY_BASE = { is_current: false, detour_minutes: 38, stops_that_day: 3, technician_id: 't1', start_time: '09:00', capability_level: 'qualified', total_drive_minutes: 50 };
  const PREFS = {
    preferred_day_indexes: [], effective_time_window: null, preferred_time_window: null,
    blackout: null, service_category: 'general', preferred_days: null, raw_snapshot: { note: 'snap' },
  };
  const CONFIG = { minScoreImprovement: 15, removeStabilityFloor: 35 };

  // PRRT_kwDOR3YQi86mP9cs: every candidate is scored before the cap, and the
  // cap keeps the best TOTAL scores — not the first N in finder order.
  test('rankedCandidates are capped by total score after every candidate is scored', async () => {
    const weak = { ...CAND_TINY_BASE, date: '2026-08-12' };
    const weak2 = { ...CAND_TINY_BASE, date: '2026-08-13' };
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [weak, weak2, CAND_MODERATE, CAND_BIG], drops: {} });
    const result = await _internals.evaluatePlacement(svc(), PREFS, { scoreCap: 1 }, CONFIG, '2026-06-20');
    expect(result.kind).toBe('move');
    expect(result.rankedCandidates).toEqual([CAND_BIG]); // the 4th in finder order, first by score
  });

  // PRRT_kwDOR3YQi86mP9ci: the orchestrator hands apply.js a re-evaluation hook.
  test('apply.js receives a rescore hook that re-runs this visit\'s own evaluation', async () => {
    const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
    process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
    try {
      candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG], drops: {} });
      await runAutoDispatch({ mode: 'apply' });
      const config = apply.applyAutoDispatchMove.mock.calls[0][3];
      const callsBefore = candidateSlots.findValidCandidateSlots.mock.calls.length;
      const again = await config.rescore();
      expect(again.kind).toBe('move');
      expect(candidateSlots.findValidCandidateSlots.mock.calls.length).toBe(callsBefore + 1);
    } finally {
      process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
    }
  });

  // PRRT_kwDOR3YQi86mPzgr: the failure audit describes the candidate tried LAST.
  test('a failure after a fallback is audited as the last attempted candidate, with the attempt count', async () => {
    const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
    process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
    try {
      candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG, CAND_MODERATE], drops: {} });
      const refusal = Object.assign(new Error('That window conflicts with another job on the technician\'s route'), {
        code: 'SLOT_TAKEN', lastAttempted: CAND_MODERATE, attemptsTried: 2,
      });
      apply.applyAutoDispatchMove.mockRejectedValue(refusal);
      await runAutoDispatch({ mode: 'apply' });
      const failed = lastDecision('failed');
      expect(failed.newPlacement).toMatchObject({ date: CAND_MODERATE.date, window_start: CAND_MODERATE.start_time });
      expect(failed.routeMetrics.candidate_detour_minutes).toBe(CAND_MODERATE.detour_minutes);
      expect(failed.routeMetrics.attempts).toBe(2);
      expect(failed.error).toBe(refusal.message);
    } finally {
      process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
    }
  });

  // Codex pre-push P1: a retry's audit compares against the evaluation that
  // authorized it, not the first evaluation's current placement.
  test('a retry authorized by a re-evaluation is audited against THAT evaluation (success and failure)', async () => {
    const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
    process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
    try {
      candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG], drops: {} });
      const reCurrent = { ...CURRENT, detour_minutes: 12 };
      const reEvaluation = { kind: 'move', current: reCurrent, currentScore: { total_score: 51.5 }, threshold: 15 };
      apply.applyAutoDispatchMove.mockResolvedValueOnce({
        ok: true, pre_status: 'confirmed', post_status: 'confirmed', applied: CAND_MODERATE, attempts: 2, evaluation: reEvaluation,
      });
      await runAutoDispatch({ mode: 'apply' });
      const changed = lastDecision('changed');
      expect(changed.scores.old).toBe(51.5);
      expect(changed.routeMetrics.current_detour_minutes).toBe(12);

      audit.logDecision.mockClear();
      apply.applyAutoDispatchMove.mockRejectedValueOnce(Object.assign(new Error('taken'), {
        code: 'SLOT_TAKEN', lastAttempted: CAND_MODERATE, attemptsTried: 2, lastEvaluation: reEvaluation,
      }));
      await runAutoDispatch({ mode: 'apply' });
      const failed = lastDecision('failed');
      expect(failed.scores.old).toBe(51.5);
      expect(failed.routeMetrics.current_detour_minutes).toBe(12);
    } finally {
      process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
    }
  });

  // Codex r3 P1 (PRRT_kwDOR3YQi86mQlqy): an unreadable visit group is a
  // no-change skip with an ids-only reason — never a move, never an ERROR row.
  test('an unreadable visit group skips the visit: no move, GROUP_CONTEXT_UNAVAILABLE in the audit', async () => {
    const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
    process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
    try {
      candidateSlots.findValidCandidateSlots.mockRejectedValue(Object.assign(new Error('Visit group could not be read'), { code: 'GROUP_CONTEXT_UNAVAILABLE', skipEvaluation: true }));
      const result = await _internals.evaluatePlacement(svc(), PREFS, {}, CONFIG, '2026-06-20');
      expect(result).toMatchObject({ kind: 'no_change', reason_code: 'GROUP_CONTEXT_UNAVAILABLE' });

      const res = await runAutoDispatch({ mode: 'apply' });
      expect(res).toMatchObject({ changed: 0, failed: 0 });
      expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
      expect(lastDecision('no_change').reason_code).toBe('GROUP_CONTEXT_UNAVAILABLE');
    } finally {
      process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
    }
  });

  // Codex r7 (PRRT_kwDOR3YQi86mRfE_): the same no-change skip for an
  // unassigned visit whose day technician cannot be resolved.
  test('an unresolved day technician skips the visit with CURRENT_DAY_TECH_UNRESOLVED', async () => {
    candidateSlots.findValidCandidateSlots.mockRejectedValueOnce(Object.assign(new Error('No single assignable technician for an unassigned visit\'s day'), {
      code: 'CURRENT_DAY_TECH_UNRESOLVED', skipEvaluation: true,
    }));
    const result = await _internals.evaluatePlacement(svc(), PREFS, {}, CONFIG, '2026-06-20');
    expect(result).toMatchObject({ kind: 'no_change', reason_code: 'CURRENT_DAY_TECH_UNRESOLVED' });
  });

  test('any other slot-finder error still fails the visit as before', async () => {
    candidateSlots.findValidCandidateSlots.mockRejectedValueOnce(new Error('db down'));
    await expect(_internals.evaluatePlacement(svc(), PREFS, {}, CONFIG, '2026-06-20')).rejects.toThrow('db down');
  });

  // Codex pre-push P1 (staff control): a lock landing between attempts
  // surfaces exactly like a first-attempt lock — no move, the guard's reason.
  test('a visit locked between retry attempts is audited as the guard\'s STALE_PLACEMENT refusal, with no move', async () => {
    const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
    process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
    try {
      candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG, CAND_MODERATE], drops: {} });
      apply.applyAutoDispatchMove.mockRejectedValueOnce(Object.assign(new Error('Visit was locked/excluded from auto-dispatch after scoring'), { code: 'STALE_PLACEMENT' }));
      const res = await runAutoDispatch({ mode: 'apply' });
      expect(res).toMatchObject({ changed: 0 });
      const failed = lastDecision('failed');
      expect(failed.reason_description).toBe('Visit was locked/excluded from auto-dispatch after scoring');
      expect(failed.newPlacement).toMatchObject({ date: CAND_BIG.date, window_start: CAND_BIG.start_time }); // the fresh evaluation's row, as for a first-attempt lock
      expect(lastDecision('changed')).toBeUndefined();
    } finally {
      process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
    }
  });

  test('a failure whose error names no attempted candidate (gate off) keeps the fresh placement audit', async () => {
    const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
    process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
    try {
      candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG, CAND_MODERATE], drops: {} });
      apply.applyAutoDispatchMove.mockRejectedValue(Object.assign(new Error('taken'), { code: 'SLOT_TAKEN' }));
      await runAutoDispatch({ mode: 'apply' });
      const failed = lastDecision('failed');
      expect(failed.newPlacement).toMatchObject({ date: CAND_BIG.date, window_start: CAND_BIG.start_time });
      expect(failed.routeMetrics).not.toHaveProperty('attempts');
    } finally {
      process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
    }
  });
});

describe('moves need a real drive saving (owner 2026-10-09; same-day re-times too)', () => {
  const DEFAULT_WINDOW = { key: 'early_morning', startMin: 480, endMin: 600 };
  const prefsWithDefaultWindow = {
    preferred_day_indexes: [], effective_time_window: DEFAULT_WINDOW, preferred_time_window: null,
    blackout: null, service_category: 'general', has_explicit_prefs: false, raw_snapshot: null,
  };
  const preferences = require('../services/auto-dispatch/preferences');
  // Afternoon visit; the candidates save no drive and gain from the default
  // window, a tighter cluster and a lighter day.
  const AFTERNOON = { ...CURRENT, detour_minutes: 5, start_time: '14:00', same_area_share: 0, route_minutes: 600 };
  const NO_SAVING_DAY_MOVE = { ...CAND_BIG, detour_minutes: 5, start_time: '08:00', same_area_share: 1, route_minutes: 300 };

  afterEach(() => {
    preferences.getCustomerSchedulingPreferences.mockResolvedValue({
      preferred_day_indexes: [], effective_time_window: null, preferred_time_window: null,
      blackout: null, service_category: 'general', has_explicit_prefs: false, raw_snapshot: null,
    });
  });

  test('a day move that saves no drive is not recommended, and the audit says why', async () => {
    preferences.getCustomerSchedulingPreferences.mockResolvedValue(prefsWithDefaultWindow);
    servicesResult = [svc({ window_start: '14:00', window_end: '15:00' })];
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: AFTERNOON, candidates: [NO_SAVING_DAY_MOVE] });
    const res = await runAutoDispatch({ mode: 'dry_run' });
    expect(res).toMatchObject({ recommended: 0 });
    const row = lastDecision('no_change');
    expect(row.routeMetrics).toMatchObject({ day_move: true, drive_saving_minutes: 0 });
    expect(['NO_DRIVE_SAVING', 'NO_SCORE_IMPROVEMENT']).toContain(row.reason_code);
  });

  test('a same-day re-time that saves no drive is not recommended either (it was before 2026-10-09)', async () => {
    preferences.getCustomerSchedulingPreferences.mockResolvedValue(prefsWithDefaultWindow);
    servicesResult = [svc({ window_start: '14:00', window_end: '15:00' })];
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: AFTERNOON, candidates: [{ ...NO_SAVING_DAY_MOVE, date: CURRENT.date }] });
    const res = await runAutoDispatch({ mode: 'dry_run' });
    expect(res).toMatchObject({ recommended: 0 });
    const row = lastDecision('no_change');
    expect(row.routeMetrics).toMatchObject({ day_move: false, drive_saving_minutes: 0 });
    expect(['NO_DRIVE_SAVING', 'NO_SCORE_IMPROVEMENT']).toContain(row.reason_code);
  });

  test('a same-day re-time that saves the floor in drive is recommended', async () => {
    preferences.getCustomerSchedulingPreferences.mockResolvedValue(prefsWithDefaultWindow);
    servicesResult = [svc({ window_start: '14:00', window_end: '15:00' })];
    const current = { ...AFTERNOON, detour_minutes: 20 };
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current, candidates: [{ ...NO_SAVING_DAY_MOVE, date: CURRENT.date, detour_minutes: 5 }] });
    const res = await runAutoDispatch({ mode: 'dry_run' });
    expect(res).toMatchObject({ recommended: 1 });
    expect(lastDecision('recommended').routeMetrics).toMatchObject({ day_move: false, drive_saving_minutes: 15 });
  });

  // GATE_AUTO_DISPATCH_ROAD_CHECK (owner 2026-10-09, "drive time yes").
  describe('the road check on a move the model approves', () => {
    const roadCheck = require('../services/auto-dispatch/road-check');
    const legs = (name, date) => ({ [roadCheck.ROAD_LEGS]: { prev: { p: name }, stop: { s: name }, next: { n: name }, date, startMin: 540 } });
    // [in, out, base] minutes per placement, as Google would answer.
    const roads = (table) => jest.spyOn(roadCheck, 'createRunTravel').mockReturnValue({
      preload: async () => {},
      lookup: (leg) => ({ minutes: table[leg.from.p || leg.from.s][leg.from.s ? 1 : (leg.to.s ? 0 : 2)], source: 'google_traffic' }),
      diagnostics: () => ({ requests: 6, elements: 6 }),
    });
    const current = { ...CURRENT, ...legs('now', CURRENT.date) };
    const cand = { ...CAND_BIG, ...legs('cand', CAND_BIG.date) };
    afterEach(() => jest.restoreAllMocks());

    test('real roads agree: the move is recommended and the row carries both numbers', async () => {
      roads({ now: [25, 25, 10], cand: [10, 10, 10] });
      candidateSlots.findValidCandidateSlots.mockResolvedValue({ current, candidates: [cand] });
      expect(await runAutoDispatch({ mode: 'dry_run', roadCheckEnabled: true })).toMatchObject({ recommended: 1 });
      expect(lastDecision('recommended').routeMetrics).toMatchObject({
        drive_saving_minutes: 40, road: { saving_minutes: 30, current_detour_minutes: 40, candidate_detour_minutes: 10, source: 'google' },
      });
    });

    test('real roads say the move saves too little: nothing moves (NO_ROAD_DRIVE_SAVING)', async () => {
      roads({ now: [12, 12, 10], cand: [11, 11, 10] });
      candidateSlots.findValidCandidateSlots.mockResolvedValue({ current, candidates: [cand] });
      expect(await runAutoDispatch({ mode: 'dry_run', roadCheckEnabled: true })).toMatchObject({ recommended: 0 });
      const row = lastDecision('no_change');
      expect(row.reason_code).toBe('NO_ROAD_DRIVE_SAVING');
      expect(row.reason_description).toBe('The model says the move saves 40 drive minutes; real roads say 2 < 6 required');
    });

    test('gate off: no reader is made and the model decides alone', async () => {
      const made = roads({ now: [12, 12, 10], cand: [11, 11, 10] });
      candidateSlots.findValidCandidateSlots.mockResolvedValue({ current, candidates: [cand] });
      expect(await runAutoDispatch({ mode: 'dry_run' })).toMatchObject({ recommended: 1 });
      expect(made).not.toHaveBeenCalled();
      expect(lastDecision('recommended').routeMetrics.road).toBeUndefined();
    });
  });

  // GATE_AUTO_DISPATCH_ROAD_CHECK_AT_APPLY (owner 2026-10-28, Google cost "way too high").
  describe('the road check at apply', () => {
    const roadCheck = require('../services/auto-dispatch/road-check');
    const legs = (name, date) => ({ [roadCheck.ROAD_LEGS]: { prev: { p: name }, stop: { s: name }, next: { n: name }, date, startMin: 540 } });
    const current = { ...CURRENT, ...legs('now', CURRENT.date) };
    const cand = { ...CAND_BIG, ...legs('cand', CAND_BIG.date) };
    const table = { now: [25, 25, 10], cand: [10, 10, 10] };
    let prevAllow;
    let preload;
    // How many road buys had been made when pass 2 began (its first call is the supersession read).
    let boughtInPass1;
    beforeEach(() => {
      prevAllow = process.env.AUTO_DISPATCH_ALLOW_APPLY;
      process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
      preload = jest.fn(async () => {});
      jest.spyOn(roadCheck, 'createRunTravel').mockReturnValue({
        preload,
        lookup: (leg) => ({ minutes: table[leg.from.p || leg.from.s][leg.from.s ? 1 : (leg.to.s ? 0 : 2)], source: 'google_traffic' }),
        diagnostics: () => ({ requests: 0, elements: 0 }),
      });
      boughtInPass1 = null;
      apply.revalidatePlacement.mockImplementation(async () => {
        if (boughtInPass1 === null) boughtInPass1 = preload.mock.calls.length;
        return { ok: true };
      });
      candidateSlots.findValidCandidateSlots.mockResolvedValue({ current, candidates: [cand] });
    });
    afterEach(() => {
      jest.restoreAllMocks();
      if (prevAllow === undefined) delete process.env.AUTO_DISPATCH_ALLOW_APPLY; else process.env.AUTO_DISPATCH_ALLOW_APPLY = prevAllow;
    });

    test('gate on, apply: pass 1 buys nothing; the move about to be written is checked', async () => {
      const res = await runAutoDispatch({ mode: 'apply', roadCheckEnabled: true, roadCheckAtApply: true });
      expect(res).toMatchObject({ changed: 1 });
      expect(boughtInPass1).toBe(0);
      expect(preload.mock.calls.length).toBeGreaterThan(0);
      expect(lastDecision('changed').routeMetrics.road).toMatchObject({ saving_minutes: 30, source: 'google' });
    });

    test('gate on, cap already full: the held move is not re-evaluated and buys nothing', async () => {
      servicesResult = [svc(), svc({ id: 's2', customer_id: 'c2' })];
      const res = await runAutoDispatch({ mode: 'apply', roadCheckEnabled: true, roadCheckAtApply: true, maxChangesPerRun: 1 });
      expect(res).toMatchObject({ changed: 1, recommended: 1 });
      expect(boughtInPass1).toBe(0);
      // Only the one applied move was checked (one slot, three legs in a batch per side).
      const bought = preload.mock.calls.length;
      expect(bought).toBeGreaterThan(0);
      expect(apply.applyAutoDispatchMove).toHaveBeenCalledTimes(1);
      const held = lastDecision('recommended');
      expect(held).toMatchObject({ reason_code: 'MAX_CHANGES_REACHED', reason_description: expect.stringContaining('Per-run change cap 1 reached (valid move held, +') });
      expect(held.service.id).toBe('s2');
      // Run it again with the gate off for the same two visits: the held visit costs a road check of its own.
      preload.mockClear();
      await runAutoDispatch({ mode: 'apply', roadCheckEnabled: true, roadCheckAtApply: false, maxChangesPerRun: 1 });
      expect(preload.mock.calls.length).toBeGreaterThan(bought);
    });

    test('gate off, apply: today\'s behavior, the road is checked in pass 1', async () => {
      const res = await runAutoDispatch({ mode: 'apply', roadCheckEnabled: true, roadCheckAtApply: false });
      expect(res).toMatchObject({ changed: 1 });
      expect(boughtInPass1).toBeGreaterThan(0);
    });

    test('gate on, dry run: today\'s behavior, the road is checked and the row carries it', async () => {
      expect(await runAutoDispatch({ mode: 'dry_run', roadCheckEnabled: true, roadCheckAtApply: true })).toMatchObject({ recommended: 1 });
      expect(preload.mock.calls.length).toBeGreaterThan(0);
      expect(lastDecision('recommended').routeMetrics.road).toMatchObject({ saving_minutes: 30, source: 'google' });
    });

    test('the gate does nothing while the road check itself is off', async () => {
      await runAutoDispatch({ mode: 'apply', roadCheckEnabled: false, roadCheckAtApply: true });
      expect(roadCheck.createRunTravel).not.toHaveBeenCalled();
    });
  });

  test('a day move over the score bar with under 6 minutes saved reads NO_DRIVE_SAVING', async () => {
    const current = { ...CURRENT, detour_minutes: 5, same_area_share: 0, route_minutes: 600 };
    const cand = { ...CAND_BIG, detour_minutes: 2, same_area_share: 1, route_minutes: 300, start_time: '09:00' };
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current, candidates: [cand] });
    const prevGate = process.env.GATE_AUTO_DISPATCH_SHARED_MODEL;
    process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true';
    try {
      const res = await runAutoDispatch({ mode: 'dry_run' });
      expect(res).toMatchObject({ recommended: 0 });
      expect(lastDecision('no_change')).toMatchObject({ reason_code: 'NO_DRIVE_SAVING' });
    } finally {
      if (prevGate === undefined) delete process.env.GATE_AUTO_DISPATCH_SHARED_MODEL; else process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = prevGate;
    }
  });
});

describe('conflict moves (GATE_AUTO_DISPATCH_CONFLICT_MOVES)', () => {
  const OVERLAP = { kind: 'overlap', date: CURRENT.date, with: ['other-1'] };

  test('the gate reaches the candidate read as ctx.conflictMoves', async () => {
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT_GOOD, candidates: [CAND_SMALL] });
    await runAutoDispatch({ mode: 'dry_run' });
    expect(candidateSlots.findValidCandidateSlots.mock.calls[0][2].conflictMoves).toBe(false);
    await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
    expect(candidateSlots.findValidCandidateSlots.mock.calls[1][2].conflictMoves).toBe(true);
  });

  test('dry run: one recommendation per overlapping pair; a slot past the drive ceiling is not taken', async () => {
    servicesResult = [svc({ id: 'a1' }), svc({ id: 'b1' })];
    candidateSlots.findValidCandidateSlots
      .mockResolvedValueOnce({ current: { ...CURRENT_GOOD, conflict: { ...OVERLAP, with: ['b1'] } }, candidates: [CAND_SMALL] })
      .mockResolvedValueOnce({ current: { ...CURRENT_GOOD, conflict: { ...OVERLAP, with: ['a1'] } }, candidates: [CAND_SMALL] });
    const res = await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
    expect(res).toMatchObject({ recommended: 1 });
    expect(lastDecision('recommended').reason_description).toMatch(/^Would move off an overlapping stop \(/);
    expect(lastDecision('no_change').reason_code).toBe('CONFLICT_PARTNER_MOVES');

    servicesResult = [svc()];
    const FAR = { ...CAND_SMALL, detour_minutes: 60 };
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: { ...CURRENT_GOOD, conflict: OVERLAP }, candidates: [FAR] });
    const held = await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
    expect(held).toMatchObject({ recommended: 0 });
    expect(lastDecision('no_change')).toMatchObject({ reason_code: 'CONFLICT_NO_NEAR_SLOT', reason_description: expect.stringContaining('adds 50 drive minutes > 15') });
  });

  // Apply mode re-evaluates the partner with no conflict after the first
  // move; a partner that clears the ordinary bar moves too, so the dry run
  // recommends both (Codex #6207 r8 P2).
  test('dry run: a partner an ordinary optimization would move anyway is recommended too', async () => {
    servicesResult = [svc({ id: 'a1' }), svc({ id: 'b1' })];
    candidateSlots.findValidCandidateSlots
      .mockResolvedValueOnce({ current: { ...CURRENT, conflict: { ...OVERLAP, with: ['b1'] } }, candidates: [CAND_BIG] })
      .mockResolvedValueOnce({ current: { ...CURRENT, conflict: { ...OVERLAP, with: ['a1'] } }, candidates: [CAND_BIG] });
    const res = await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
    expect(res).toMatchObject({ recommended: 2 });
  });

  // While in conflict the same-day slot ranks first. Once the partner has
  // left, apply mode evaluates this visit with no conflict and takes the
  // higher-gain day move: the dry run shows that slot (Codex #6207 r10 P2).
  test('dry run: the partner that moves anyway shows its ordinary slot, not the conflict-ranked one', async () => {
    servicesResult = [svc({ id: 'a1' }), svc({ id: 'b1' })];
    const SAME_DAY = { ...CAND_SMALL, date: CURRENT.date, start_time: '14:00' };
    candidateSlots.findValidCandidateSlots.mockImplementation(async (service) => ({
      current: { ...CURRENT, conflict: { ...OVERLAP, with: [service.id === 'a1' ? 'b1' : 'a1'] } },
      candidates: service.id === 'a1' ? [SAME_DAY] : [SAME_DAY, CAND_BIG],
    }));
    const res = await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
    expect(res).toMatchObject({ recommended: 2 });
    const recs = audit.logDecision.mock.calls.map((c) => c[1]).filter((d) => d.action === 'recommended');
    const b = recs.find((d) => d.service.id === 'b1');
    expect(b.newPlacement).toMatchObject({ date: CAND_BIG.date, window_start: CAND_BIG.start_time });
    expect(b.reason_description).toMatch(/^Would move \(.*\) after the overlapping visit moves \(estimate/);
  });

  // Chain A-B-C. A's fix is certain. B then moves only on an ordinary-rules
  // estimate, which apply mode may not make: that estimate must not clear
  // C's overlap with B, so C keeps its own recommendation (Codex r14 P2).
  test('dry run: an estimated ordinary move does not clear a later overlap', async () => {
    servicesResult = [svc({ id: 'a1' }), svc({ id: 'b1' }), svc({ id: 'c1' })];
    const SAME_DAY = { ...CAND_SMALL, date: CURRENT.date, start_time: '14:00' };
    const chain = { a1: ['b1'], b1: ['a1'], c1: ['b1'] };
    candidateSlots.findValidCandidateSlots.mockImplementation(async (service) => ({
      current: { ...(service.id === 'b1' ? CURRENT : CURRENT_GOOD), conflict: { ...OVERLAP, with: chain[service.id] } },
      candidates: service.id === 'b1' ? [CAND_BIG] : [SAME_DAY],
    }));
    const res = await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
    const decisions = audit.logDecision.mock.calls.map((c) => c[1]);
    const c = decisions.find((d) => d.service.id === 'c1');
    expect(c.action).toBe('recommended');
    expect(c.reason_description).toMatch(/^Would move off an overlapping stop/);
    expect(res).toMatchObject({ recommended: 3 });
  });

  // No slot survives for a visit in conflict: the audit row still names the
  // conflict, so the rollout audit shows it (Codex r14 P2).
  test('a visit in conflict with no candidate keeps the conflict on its NO_VALID_SLOT row', async () => {
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: { ...CURRENT_GOOD, conflict: OVERLAP }, candidates: [] });
    await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
    expect(lastDecision('no_change')).toMatchObject({ reason_code: 'NO_VALID_SLOT', constraints: expect.objectContaining({ conflict: OVERLAP }) });
  });

  // Apply moves a grouped visit as one unit. The partner overlaps two of its
  // members: one recommendation for the unit, and the partner stays (r9 P2).
  test('dry run: a recommended grouped visit counts every member as moved', async () => {
    servicesResult = [svc({ id: 'g1' }), svc({ id: 'g2' }), svc({ id: 'p1' })];
    const unit = ['g1', 'g2'];
    candidateSlots.findValidCandidateSlots.mockImplementation(async (service) => ({
      current: service.id === 'p1'
        ? { ...CURRENT_GOOD, conflict: { ...OVERLAP, with: unit }, conflict_unit_ids: ['p1'] }
        : { ...CURRENT_GOOD, conflict: { ...OVERLAP, with: ['p1'] }, conflict_unit_ids: unit },
      candidates: [CAND_SMALL],
    }));
    const res = await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
    expect(res).toMatchObject({ recommended: 1 });
    expect(lastDecision('no_change')).toMatchObject({ reason_code: 'CONFLICT_PARTNER_MOVES', service: expect.objectContaining({ id: 'p1' }) });
  });

  test('an overlapping visit moves on a gain far under the bar, and the audit names the conflict', async () => {
    const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
    process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
    try {
      candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: { ...CURRENT_GOOD, conflict: OVERLAP }, candidates: [CAND_SMALL] });
      const res = await runAutoDispatch({ mode: 'apply', conflictMovesEnabled: true });
      expect(res).toMatchObject({ changed: 1 });
      const changed = lastDecision('changed');
      expect(changed.reason_description).toMatch(/^Moved off an overlapping stop/);
      expect(changed.constraints.conflict).toEqual(OVERLAP);
    } finally {
      process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
    }
  });

  test('dry run names the visit apply would move: the cheaper fix of a pair, whatever the load order (Codex r6 P2)', async () => {
    servicesResult = [svc({ id: 'daymove' }), svc({ id: 'sameday' })];
    const SAME_DAY = { ...CAND_SMALL, date: CURRENT.date, start_time: '14:00' };
    candidateSlots.findValidCandidateSlots.mockImplementation(async (service) => ({
      current: { ...CURRENT_GOOD, conflict: { ...OVERLAP, with: [service.id === 'sameday' ? 'daymove' : 'sameday'] } },
      candidates: [service.id === 'sameday' ? SAME_DAY : CAND_BIG],
    }));
    const res = await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
    expect(res).toMatchObject({ recommended: 1 });
    expect(lastDecision('recommended').service.id).toBe('sameday');
    expect(lastDecision('no_change')).toMatchObject({ reason_code: 'CONFLICT_PARTNER_MOVES' });
  });

  test('pass 2: of two visits in conflict, a same-day fix goes before a day move', async () => {
    const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
    process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
    try {
      servicesResult = [svc({ id: 'daymove' }), svc({ id: 'sameday' })];
      const SAME_DAY = { ...CAND_SMALL, date: CURRENT.date, start_time: '14:00' };
      candidateSlots.findValidCandidateSlots.mockImplementation(async (service) => ({
        current: { ...CURRENT_GOOD, conflict: OVERLAP }, candidates: [service.id === 'sameday' ? SAME_DAY : CAND_BIG],
      }));
      await runAutoDispatch({ mode: 'apply', conflictMovesEnabled: true });
      expect(apply.applyAutoDispatchMove.mock.calls.map((c) => c[0].id)).toEqual(['sameday', 'daymove']);
    } finally {
      process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
    }
  });

  test('pass 2 applies a visit in conflict before a larger ordinary gain', async () => {
    const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
    process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
    try {
      servicesResult = [svc({ id: 'gain' }), svc({ id: 'overlap' })];
      candidateSlots.findValidCandidateSlots.mockImplementation(async (service) => (service.id === 'overlap'
        ? { current: { ...CURRENT_GOOD, conflict: OVERLAP }, candidates: [CAND_SMALL] }
        : { current: CURRENT, candidates: [CAND_BIG] }));
      await runAutoDispatch({ mode: 'apply', conflictMovesEnabled: true });
      expect(apply.applyAutoDispatchMove.mock.calls.map((c) => c[0].id)).toEqual(['overlap', 'gain']);
    } finally {
      process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
    }
  });
});

describe('move limit (owner 2026-10-09: at most two automatic moves per visit)', () => {
  const AT_LIMIT = [{ scheduled_service_id: 's1', moves: '2' }];
  const OVERLAP = { kind: 'overlap', date: CURRENT.date, with: ['other-1'] };
  const applyMode = async (fn) => {
    const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
    process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
    try { return await fn(); } finally { process.env.AUTO_DISPATCH_ALLOW_APPLY = prev; }
  };
  // The run's end re-reads each conflict visit's row after a move: let a
  // point-read of scheduled_services answer with that visit's row.
  const rowReads = () => {
    const base = db.getMockImplementation();
    db.mockImplementation((table) => {
      const chain = base(table);
      if (table !== 'scheduled_services') return chain;
      let wanted = null;
      const where = chain.where;
      chain.where = (...args) => { if (args[0] && typeof args[0] === 'object' && args[0].id) wanted = args[0].id; return where(...args); };
      chain.first = async () => [...servicesResult, ...unscannedRows].find((row) => row.id === wanted) || null;
      return chain;
    });
  };
  // Visits the scan does not load (a one-time add-on, a person-placed visit)
  // that a point-read still finds.
  let unscannedRows = [];
  beforeEach(() => { unscannedRows = []; });
  // The run's end reads every conflict again (Codex #6253 r3): the visit's
  // row is there and the conflict still stands.
  const standing = (conflict = OVERLAP) => {
    rowReads();
    candidateSlots._internals.readCurrentConflict.mockResolvedValue(conflict);
  };
  const inConflict = { current: { ...CURRENT_GOOD, conflict: OVERLAP }, candidates: [CAND_SMALL] };
  const noticedIds = () => raiseAdminAlert.mock.calls.map(([, spec]) => spec.subject.id).sort();

  test('pass 1: a visit at the limit is skipped before any candidate is searched; a moved-once visit still moves', async () => {
    moveLogReads = [AT_LIMIT];
    const res = await runAutoDispatch({ mode: 'dry_run' });
    expect(res).toMatchObject({ skipped: 1, evaluated: 0, recommended: 0 });
    expect(candidateSlots.findValidCandidateSlots).not.toHaveBeenCalled();
    expect(lastDecision('skipped')).toMatchObject({ reason_code: 'MOVE_LIMIT_REACHED', reason_description: expect.stringContaining('limit 2') });
    expect(raiseAdminAlert).not.toHaveBeenCalled();

    moveLogReads = [[{ scheduled_service_id: 's1', moves: '1' }]];
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG] });
    expect(await runAutoDispatch({ mode: 'dry_run' })).toMatchObject({ recommended: 1 });
  });

  test('one bulk read counts every loaded visit (no per-visit query in pass 1)', async () => {
    servicesResult = [svc({ id: 'a1' }), svc({ id: 'b1' }), svc({ id: 'c1' })];
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG] });
    await runAutoDispatch({ mode: 'dry_run' });
    expect(db.mock.calls.filter(([t]) => t === 'reschedule_log')).toHaveLength(1);
  });

  test('AUTO_DISPATCH_MAX_MOVES_PER_VISIT 0 turns the limit off and reads nothing', async () => {
    moveLogReads = [AT_LIMIT];
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG] });
    expect(await runAutoDispatch({ mode: 'dry_run', maxAutoMovesPerVisit: 0 })).toMatchObject({ recommended: 1 });
    expect(db.mock.calls.filter(([t]) => t === 'reschedule_log')).toHaveLength(0);
  });

  test('an unreadable move log moves nothing and the run says so (fail closed)', async () => {
    moveLogReads = [new Error('log down')];
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG] });
    const res = await runAutoDispatch({ mode: 'dry_run' });
    expect(res).toMatchObject({ status: 'completed_with_errors', recommended: 0, skipped: 1 });
    expect(lastDecision('skipped').reason_code).toBe('MOVE_COUNT_UNKNOWN');
  });

  test('pass 2: a move another run landed since pass 1 is counted, and the visit does not move', async () => {
    await applyMode(async () => {
      moveLogReads = [[], AT_LIMIT]; // pass-1 bulk read clean; pass-2 single read at the limit
      candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG] });
      const res = await runAutoDispatch({ mode: 'apply' });
      expect(res).toMatchObject({ changed: 0 });
      expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
      expect(lastDecision('no_change')).toMatchObject({ reason_code: 'MOVE_LIMIT_REACHED' });
    });
  });

  test('a visit in conflict at the limit is not moved and a person is told', async () => {
    await applyMode(async () => {
      moveLogReads = [AT_LIMIT];
      standing();
      candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: { ...CURRENT_GOOD, conflict: OVERLAP }, candidates: [CAND_SMALL] });
      const res = await runAutoDispatch({ mode: 'apply', conflictMovesEnabled: true });
      expect(res).toMatchObject({ changed: 0, skipped: 1 });
      expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
      expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
      const [category, spec, opts] = raiseAdminAlert.mock.calls[0];
      expect(category).toBe('schedule_conflict');
      expect(spec).toMatchObject({ area: 'Schedule', severity: 'needs-you', who: 'person', subject: { type: 'visit', id: 's1' } });
      expect(spec.link).toBe('/admin/dispatch?tab=schedule&date=2026-08-04&appointment=s1');
      expect(opts).toMatchObject({ bell: true, dedupeKey: 'auto-dispatch-needs-person:s1:2026-08-04', refreshOnDedupe: true });
    });
  });

  // Codex #6253 r5: the recurring-placement alert already tells a person
  // about a visit with no arrival time; this lane adds no second bell.
  test('an unplaced due-date visit at the limit is not placed, and this lane raises no notice for it', async () => {
    moveLogReads = [AT_LIMIT];
    servicesResult = [svc({ window_start: null, window_end: null, recurring_dispatch_due_date: '2026-08-06' })];
    const res = await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
    expect(res).toMatchObject({ skipped: 1, recommended: 0 });
    expect(candidateSlots.findValidCandidateSlots).not.toHaveBeenCalled();
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  // Codex #6253 r5 P1: a guard skips the visit before any conflict read.
  test('a visit a guard skipped before evaluation (person-placed) still raises the notice when it is in conflict', async () => {
    rowReads();
    const placed = { placed: true, reason_code: 'PERSON_PLACED', reason_description: 'placed by a person' };
    eligibility.isPersonPlacedVisit.mockResolvedValueOnce(placed).mockResolvedValueOnce(placed).mockResolvedValueOnce(placed);
    candidateSlots._internals.readCurrentConflict.mockResolvedValue(OVERLAP);
    const res = await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
    expect(res).toMatchObject({ skipped: 1, evaluated: 0 });
    expect(noticedIds()).toEqual(['s1']);
    expect(raiseAdminAlert.mock.calls[0][1].why).toMatch(/overlaps another stop, and auto-dispatch did not move it/);
    // Clear: nothing raised, and its standing notice may close.
    raiseAdminAlert.mockClear();
    candidateSlots._internals.readCurrentConflict.mockResolvedValue(null);
    await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    // Gate off: no conflict is read for anyone.
    candidateSlots._internals.readCurrentConflict.mockResolvedValue(OVERLAP);
    await runAutoDispatch({ mode: 'dry_run' });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  // Codex #6253 r1 P1: a qualifying move that a grouped sibling's guard
  // refuses leaves the visit in conflict; a person is told.
  test('a conflict visit whose grouped sibling refuses the move raises the notice', async () => {
    standing();
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: { ...CURRENT_GOOD, conflict: OVERLAP }, candidates: [CAND_SMALL] });
    apply.previewGroupMove.mockResolvedValueOnce({ code: 'GROUP_MEMBER_GUARD', description: 'a sibling reached the move limit' });
    await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
    expect(lastDecision('no_change').reason_code).toBe('GROUP_MEMBER_GUARD');
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(raiseAdminAlert.mock.calls[0][1].why).toMatch(/overlaps another stop, and auto-dispatch did not move it/);
    // The same refusal on a visit that is not in conflict tells nobody.
    raiseAdminAlert.mockClear();
    candidateSlots._internals.readCurrentConflict.mockResolvedValue(null);
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG] });
    apply.previewGroupMove.mockResolvedValueOnce({ code: 'GROUP_MEMBER_GUARD', description: 'a sibling reached the move limit' });
    await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('a conflict visit whose write fails raises the notice', async () => {
    await applyMode(async () => {
      standing();
      candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: { ...CURRENT_GOOD, conflict: OVERLAP }, candidates: [CAND_SMALL] });
      apply.applyAutoDispatchMove.mockRejectedValue(new Error('refused by the writer'));
      const res = await runAutoDispatch({ mode: 'apply', conflictMovesEnabled: true });
      expect(res).toMatchObject({ changed: 0, failed: 1 });
      expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    });
  });

  // Codex #6253 r2: the run decides ONCE, at its end, from what is true then.
  describe('every conflict the run leaves in place, whatever path left it', () => {
    test('a qualifying conflict move held by the per-run cap raises the notice; the one that moved does not', async () => {
      await applyMode(async () => {
        rowReads();
        servicesResult = [svc({ id: 'a1' }), svc({ id: 'b1' })];
        candidateSlots.findValidCandidateSlots.mockResolvedValue(inConflict);
        // After the run: a1 moved and is clear, b1 still overlaps.
        candidateSlots._internals.readCurrentConflict.mockImplementation(async (service) => (service.id === 'b1' ? OVERLAP : null));
        const res = await runAutoDispatch({ mode: 'apply', conflictMovesEnabled: true, maxChangesPerRun: 1 });
        expect(res).toMatchObject({ changed: 1, recommended: 1 });
        expect(lastDecision('recommended').reason_code).toBe('MAX_CHANGES_REACHED');
        expect(noticedIds()).toEqual(['b1']);
      });
    });

    test('a partial grouped move: the member left behind raises the notice, the primary that moved does not', async () => {
      await applyMode(async () => {
        rowReads();
        servicesResult = [svc({ id: 's1' }), svc({ id: 'm2' })];
        candidateSlots.findValidCandidateSlots.mockResolvedValue(inConflict);
        apply.applyAutoDispatchMove.mockRejectedValue(Object.assign(new Error('partial'), { code: 'VISIT_PARTIAL_MOVE', movedCount: 1, failedMembers: ['m2'] }));
        candidateSlots._internals.readCurrentConflict.mockImplementation(async (service) => (service.id === 'm2' ? OVERLAP : null));
        const res = await runAutoDispatch({ mode: 'apply', conflictMovesEnabled: true });
        expect(res).toMatchObject({ changed: 1, failed: 1 });
        expect(noticedIds()).toEqual(['m2']);
      });
    });

    // Codex #6253 r4 P1: a one-time add-on is never loaded by the scan, so
    // it has no ledger entry of its own.
    test('a partial grouped move: a member the scan never loaded is read at the end too', async () => {
      await applyMode(async () => {
        rowReads();
        unscannedRows = [svc({ id: 'addon', is_recurring: false })];
        candidateSlots.findValidCandidateSlots.mockResolvedValue(inConflict);
        apply.applyAutoDispatchMove.mockRejectedValue(Object.assign(new Error('partial'), { code: 'VISIT_PARTIAL_MOVE', movedCount: 1, failedMembers: ['addon'] }));
        candidateSlots._internals.readCurrentConflict.mockImplementation(async (service) => (service.id === 'addon' ? OVERLAP : null));
        await runAutoDispatch({ mode: 'apply', conflictMovesEnabled: true });
        expect(noticedIds()).toEqual(['addon']);
        // Left behind but clear of every stop: nothing to tell.
        raiseAdminAlert.mockClear();
        candidateSlots._internals.readCurrentConflict.mockResolvedValue(null);
        await runAutoDispatch({ mode: 'apply', conflictMovesEnabled: true });
        expect(noticedIds()).toEqual([]);
      });
    });

    // Codex #6253 r4 P2: a person-placed visit is skipped before the conflict
    // read, so the run reads the conflict of every visit with an open notice.
    test('an open notice on a visit the run never evaluated closes when a person fixed it, and only then', async () => {
      const closable = () => {
        const q = { whereRaw: jest.fn(() => q), whereIn: jest.fn(() => q), whereNotIn: jest.fn(() => q) };
        audit.retireResolvedNotices.mock.calls[audit.retireResolvedNotices.mock.calls.length - 1][0].stillOpen(q);
        return q.whereNotIn.mock.calls.flatMap(([, ids]) => ids);
      };
      rowReads();
      servicesResult = [];
      unscannedRows = [svc({ id: 'placed' }), svc({ id: 'notime', window_start: null })];
      audit.standingNoticeKeys.mockResolvedValue(new Set(['auto-dispatch-needs-person:placed:2026-08-04', 'auto-dispatch-needs-person:notime:2026-08-04']));
      // Still overlapping: the notice stays, and no second one is raised.
      candidateSlots._internals.readCurrentConflict.mockResolvedValue(OVERLAP);
      await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
      expect(closable()).toEqual([]);
      expect(raiseAdminAlert).not.toHaveBeenCalled();
      // The person re-timed it clear. The visit with no arrival time is not
      // "clear": its own row decides that notice.
      candidateSlots._internals.readCurrentConflict.mockResolvedValue(null);
      await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
      expect(closable()).toEqual(['placed']);
      // Gate off: no conflict is read, so nothing is proven.
      await runAutoDispatch({ mode: 'dry_run' });
      expect(closable()).toEqual([]);
    });

    test('a visit whose overlap a partner\'s move cleared raises nothing and is proof for the closer', async () => {
      await applyMode(async () => {
        rowReads();
        servicesResult = [svc({ id: 'a1' }), svc({ id: 'b1' })];
        // b1 has no slot of its own; a1 moves away and frees it.
        candidateSlots.findValidCandidateSlots.mockImplementation(async (service) => (service.id === 'a1'
          ? inConflict : { current: { ...CURRENT_GOOD, conflict: OVERLAP }, candidates: [] }));
        const res = await runAutoDispatch({ mode: 'apply', conflictMovesEnabled: true });
        expect(res).toMatchObject({ changed: 1 });
        expect(raiseAdminAlert).not.toHaveBeenCalled();
        const q = { whereRaw: jest.fn(() => q), whereIn: jest.fn(() => q), whereNotIn: jest.fn(() => q) };
        audit.retireResolvedNotices.mock.calls[audit.retireResolvedNotices.mock.calls.length - 1][0].stillOpen(q);
        expect(q.whereNotIn.mock.calls.flatMap(([, ids]) => ids).sort()).toEqual(['a1', 'b1']);
      });
    });

    test('a re-read that fails keeps what the run saw', async () => {
      await applyMode(async () => {
        rowReads();
        servicesResult = [svc({ id: 'a1' }), svc({ id: 'b1' })];
        candidateSlots.findValidCandidateSlots.mockImplementation(async (service) => (service.id === 'a1'
          ? inConflict : { current: { ...CURRENT_GOOD, conflict: OVERLAP }, candidates: [] }));
        candidateSlots._internals.readCurrentConflict.mockRejectedValue(new Error('read down'));
        await runAutoDispatch({ mode: 'apply', conflictMovesEnabled: true });
        expect(noticedIds()).toEqual(['a1', 'b1']);
      });
    });

    test('a dry run moves nothing, so a conflict with a recommended move is told too', async () => {
      standing();
      candidateSlots.findValidCandidateSlots.mockResolvedValue(inConflict);
      const res = await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
      expect(res).toMatchObject({ changed: 0 });
      expect(noticedIds()).toEqual(['s1']);
    });
  });

  // The closer needs proof. `provenClear` reads the ids the run handed it.
  describe('which standing notices a run may close', () => {
    const provenClear = () => {
      const q = { whereRaw: jest.fn(() => q), whereIn: jest.fn(() => q), whereNotIn: jest.fn(() => q) };
      audit.retireResolvedNotices.mock.calls[audit.retireResolvedNotices.mock.calls.length - 1][0].stillOpen(q);
      return q.whereNotIn.mock.calls.flatMap(([, ids]) => ids);
    };

    test('a visit read clear at the end of the run is proof', async () => {
      rowReads();
      candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT_GOOD, candidates: [] });
      await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
      expect(provenClear()).toEqual(['s1']);
    });

    test('the conflict gate off proves nothing: the conflict was never read', async () => {
      candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT_GOOD, candidates: [] });
      await runAutoDispatch({ mode: 'dry_run' });
      expect(provenClear()).toEqual([]);
    });

    // Codex #6253 r1 P2: the move log could not be read, every visit skipped.
    test('a run whose move-count read failed proves nothing', async () => {
      moveLogReads = [new Error('log down')];
      candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT_GOOD, candidates: [] });
      const res = await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
      expect(res).toMatchObject({ status: 'completed_with_errors', skipped: 1 });
      expect(provenClear()).toEqual([]);
    });

    test('a visit still in conflict is not proof; a visit the run moved is', async () => {
      standing();
      candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: { ...CURRENT_GOOD, conflict: OVERLAP }, candidates: [] });
      await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
      expect(provenClear()).toEqual([]);
      expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
      raiseAdminAlert.mockClear();
      await applyMode(async () => {
        // After the move the conflict reads clear.
        candidateSlots._internals.readCurrentConflict.mockResolvedValue(null);
        candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: { ...CURRENT_GOOD, conflict: OVERLAP }, candidates: [CAND_SMALL] });
        const res = await runAutoDispatch({ mode: 'apply', conflictMovesEnabled: true });
        expect(res).toMatchObject({ changed: 1 });
        expect(provenClear()).toEqual(['s1']);
        expect(raiseAdminAlert).not.toHaveBeenCalled();
      });
    });
  });

  test('a conflict visit whose every slot adds too much drive raises the notice (CONFLICT_NO_NEAR_SLOT)', async () => {
    const FAR = { ...CAND_SMALL, detour_minutes: 60 };
    standing();
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: { ...CURRENT_GOOD, conflict: OVERLAP }, candidates: [FAR] });
    await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
    expect(lastDecision('no_change').reason_code).toBe('CONFLICT_NO_NEAR_SLOT');
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(raiseAdminAlert.mock.calls[0][1].why).toMatch(/adds too much drive/);
  });

  test('a conflict visit with no valid slot at all raises the notice; one that is not in conflict does not', async () => {
    standing({ kind: 'closed_day', date: CURRENT.date });
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: { ...CURRENT_GOOD, conflict: { kind: 'closed_day', date: CURRENT.date } }, candidates: [] });
    await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
    expect(lastDecision('no_change').reason_code).toBe('NO_VALID_SLOT');
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(raiseAdminAlert.mock.calls[0][1]).toMatchObject({ why: expect.stringMatching(/closed day.*no open slot/) });

    raiseAdminAlert.mockClear();
    candidateSlots._internals.readCurrentConflict.mockResolvedValue(null);
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT_GOOD, candidates: [] });
    await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  // Codex #6253 r6: a clear read from earlier in the run is not final.
  test('a visit read clear in pass 1 that a person put into an overlap during the run raises the notice', async () => {
    rowReads();
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT_GOOD, candidates: [] });
    candidateSlots._internals.readCurrentConflict.mockResolvedValue(OVERLAP);
    await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
    expect(noticedIds()).toEqual(['s1']);
  });

  // Codex #6253 r3: nothing moved in the run, but a person cancelled the
  // visit (or moved it clear) while the run worked.
  test('a conflict a person fixed during the run raises nothing, even when the run moved nothing', async () => {
    rowReads();
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: { ...CURRENT_GOOD, conflict: OVERLAP }, candidates: [] });
    // The end-of-run read finds the visit clear.
    expect(await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true })).toMatchObject({ changed: 0 });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    // ...or cancelled: no notice, and no proof of a clear conflict either.
    servicesResult = [svc({ status: 'cancelled' })];
    standing();
    await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('a failing notice never fails the run', async () => {
    standing();
    raiseAdminAlert.mockRejectedValueOnce(new Error('notifications down'));
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: { ...CURRENT_GOOD, conflict: OVERLAP }, candidates: [] });
    const res = await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
    expect(res.status).toBe('completed');
  });

  test('a closed-day read that throws fails the visit, not the run, and nothing moves (strict blackout read)', async () => {
    await applyMode(async () => {
      candidateSlots.findValidCandidateSlots.mockRejectedValue(new Error('blackout list unreadable'));
      const res = await runAutoDispatch({ mode: 'apply', conflictMovesEnabled: true });
      expect(res).toMatchObject({ status: 'completed_with_errors', failed: 1, changed: 0 });
      expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
    });
  });

  // D1 (owner 2026-10-22): the far double-booking list is a snapshot, so the
  // run tells the notice whether its end-of-run conflict read saw everything.
  describe('the far list is told whether the conflict scan was complete (D1)', () => {
    const needsPerson = require('../services/auto-dispatch/needs-person-notice');
    let spy;
    let listSpy;
    beforeEach(() => {
      spy = jest.spyOn(needsPerson, 'raiseNotices');
      listSpy = jest.spyOn(needsPerson, 'farListedVisitIds').mockResolvedValue([]);
    });
    afterEach(() => { spy.mockRestore(); listSpy.mockRestore(); });
    const scanCompleteOf = () => spy.mock.calls[spy.mock.calls.length - 1][1].scanComplete;

    test('every conflict read succeeded: complete', async () => {
      candidateSlots.findValidCandidateSlots.mockResolvedValue(inConflict);
      standing();
      await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
      expect(scanCompleteOf()).toBe(true);
    });

    test('a conflict re-read failed: incomplete', async () => {
      candidateSlots.findValidCandidateSlots.mockResolvedValue(inConflict);
      rowReads();
      candidateSlots._internals.readCurrentConflict.mockRejectedValue(new Error('read down'));
      await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
      expect(scanCompleteOf()).toBe(false);
    });

    test('conflict reads off: incomplete', async () => {
      await runAutoDispatch({ mode: 'dry_run' });
      expect(scanCompleteOf()).toBe(false);
    });

    test('a listed far visit the scan no longer loads (locked) is re-read and, still in conflict, collected', async () => {
      servicesResult = [];
      unscannedRows = [svc({ id: 'listed-1' })];
      listSpy.mockResolvedValue(['listed-1']);
      standing();
      await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
      const bucket = spy.mock.calls[spy.mock.calls.length - 1][0];
      expect([...bucket.values()].map((item) => item.id)).toEqual(['listed-1']);
      expect(scanCompleteOf()).toBe(true);
    });

    test('an unreadable far list makes the scan incomplete', async () => {
      listSpy.mockResolvedValue(null);
      candidateSlots.findValidCandidateSlots.mockResolvedValue(inConflict);
      standing();
      await runAutoDispatch({ mode: 'dry_run', conflictMovesEnabled: true });
      expect(scanCompleteOf()).toBe(false);
    });
  });
});

describe('move proofreader in pass 2 (GATE_AUTO_DISPATCH_PROOFREADER, owner 2026-10-12)', () => {
  const moveCheck = require('../services/auto-dispatch/proofreader/nightly');
  const ALLOW = { allowed: true, audit: { verdict: 'allow', why: 'nothing_breaks', entry_id: null, model: 'm', prompt_version: 'v' } };
  const stop = (code, verdict) => ({ allowed: false, reason_code: code, reason_description: 'stopped', audit: { verdict, why: 'x', entry_id: null, model: 'm', prompt_version: 'v' } });
  const applyMode = async (fn) => {
    const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
    process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
    try { return await fn(); } finally { process.env.AUTO_DISPATCH_ALLOW_APPLY = prev; }
  };
  let checkMove;
  beforeEach(() => {
    checkMove = jest.spyOn(moveCheck, 'checkMove');
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG, CAND_MODERATE] });
  });
  afterEach(() => jest.restoreAllMocks());

  test('allow: the visit moves on the approved slot only, and the row says the move was checked', async () => {
    await applyMode(async () => {
      checkMove.mockResolvedValue(ALLOW);
      expect(await runAutoDispatch({ mode: 'apply', proofreaderEnabled: true })).toMatchObject({ changed: 1, failed: 0 });
      const [{ service, best, run }] = checkMove.mock.calls[0];
      expect(service.id).toBe('s1');
      expect(best).toMatchObject({ date: CAND_BIG.date, start_time: CAND_BIG.start_time });
      expect(run.proofreader).toMatchObject({ calls: 0 });
      // The deadline counts from the run's entry, 300 seconds by default.
      expect(run.proofreader.deadlineAt).toBe(run.nowDate.getTime() + 300000);
      const options = apply.applyAutoDispatchMove.mock.calls[0][3];
      expect(options.alternateCandidates).toEqual([]);
      expect(options.rescore).toBeUndefined();
      expect(lastDecision('changed').constraints.proofreader).toEqual(ALLOW.audit);
    });
  });

  test.each([['PROOFREADER_HOLD', 'hold'], ['PROOFREADER_UNSURE', 'unknown'], ['PROOFREADER_NOT_ASKED', 'unknown']])('%s: the visit stays where it is', async (code, verdict) => {
    await applyMode(async () => {
      checkMove.mockResolvedValue(stop(code, verdict));
      expect(await runAutoDispatch({ mode: 'apply', proofreaderEnabled: true })).toMatchObject({ changed: 0, failed: 0 });
      expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
      const row = lastDecision('no_change');
      expect(row.reason_code).toBe(code);
      expect(row.constraints.proofreader.verdict).toBe(verdict);
    });
  });

  test('a check that broke leaves the visit and the run ends completed_with_errors; an unsure answer does not', async () => {
    await applyMode(async () => {
      checkMove.mockResolvedValue({ ...stop('PROOFREADER_UNSURE', 'unknown'), broke: true });
      expect(await runAutoDispatch({ mode: 'apply', proofreaderEnabled: true })).toMatchObject({ changed: 0, status: 'completed_with_errors' });
      raiseAdminAlert.mockClear();
      checkMove.mockResolvedValue({ ...stop('PROOFREADER_UNSURE', 'unknown'), broke: false });
      expect(await runAutoDispatch({ mode: 'apply', proofreaderEnabled: true })).toMatchObject({ changed: 0, status: 'completed' });
      // The visit stays and nobody is asked about it (owner 2026-10-29).
      expect(raiseAdminAlert).not.toHaveBeenCalled();
    });
  });

  test('the approved slot is taken before the write: nothing moves and the run is not a failed run', async () => {
    await applyMode(async () => {
      checkMove.mockResolvedValue(ALLOW);
      apply.applyAutoDispatchMove.mockRejectedValue(Object.assign(new Error('taken'), { code: 'SLOT_TAKEN' }));
      const res = await runAutoDispatch({ mode: 'apply', proofreaderEnabled: true });
      expect(res).toMatchObject({ changed: 0, failed: 0, status: 'completed' });
      expect(lastDecision('no_change').reason_code).toBe('APPROVED_SLOT_TAKEN');
      expect(lastDecision('failed')).toBeUndefined();
    });
  });

  test('a technician start address changed after scoring: nothing moves, no_change START_POINT_CHANGED, not a failed run', async () => {
    await applyMode(async () => {
      checkMove.mockResolvedValue(ALLOW);
      apply.applyAutoDispatchMove.mockRejectedValue(Object.assign(new Error('start address changed'), { code: 'START_POINT_CHANGED', statusCode: 409 }));
      const res = await runAutoDispatch({ mode: 'apply', proofreaderEnabled: true });
      expect(res).toMatchObject({ changed: 0, failed: 0, status: 'completed' });
      expect(lastDecision('no_change').reason_code).toBe('START_POINT_CHANGED');
      expect(lastDecision('failed')).toBeUndefined();
    });
  });

  test('the same refusal with no proofreader check: no_change, and the apply is handed the start-point lookup and the current day\'s technician', async () => {
    await applyMode(async () => {
      // An unassigned visit's current placement scored on t2's day (candidate-slots.js currentDayTechs).
      candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: { ...CURRENT, day_technician_id: 't2' }, candidates: [CAND_BIG, CAND_MODERATE] });
      apply.applyAutoDispatchMove.mockRejectedValue(Object.assign(new Error('start address changed'), { code: 'START_POINT_CHANGED', statusCode: 409 }));
      const res = await runAutoDispatch({ mode: 'apply' });
      expect(res).toMatchObject({ changed: 0, failed: 0 });
      expect(lastDecision('no_change').reason_code).toBe('START_POINT_CHANGED');
      expect(typeof apply.applyAutoDispatchMove.mock.calls[0][3].startPointFor).toBe('function');
      expect(apply.applyAutoDispatchMove.mock.calls[0][3].sourceDayTechnicianId).toBe('t2');
    });
  });

  test('the customer changed a stored preference while the model read: the visit stays and the next run rescores it', async () => {
    await applyMode(async () => {
      const preferences = require('../services/auto-dispatch/preferences');
      const before = await preferences.getCustomerSchedulingPreferences();
      checkMove.mockImplementation(async () => {
        preferences.getCustomerSchedulingPreferences.mockResolvedValueOnce({ ...before, preferred_day_indexes: [2] });
        return ALLOW;
      });
      expect(await runAutoDispatch({ mode: 'apply', proofreaderEnabled: true })).toMatchObject({ changed: 0, failed: 0, status: 'completed' });
      expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
      const row = lastDecision('no_change');
      expect(row.reason_code).toBe('SUPERSEDED_DURING_RUN');
      expect(row.reason_description).toMatch(/preferences changed/);
    });
  });

  test('a check that broke AND changed preferences: superseded, and the run still ends completed_with_errors', async () => {
    await applyMode(async () => {
      const preferences = require('../services/auto-dispatch/preferences');
      const before = await preferences.getCustomerSchedulingPreferences();
      checkMove.mockImplementation(async () => {
        preferences.getCustomerSchedulingPreferences.mockResolvedValueOnce({ ...before, preferred_day_indexes: [2] });
        return { ...stop('PROOFREADER_UNSURE', 'unknown'), broke: true };
      });
      expect(await runAutoDispatch({ mode: 'apply', proofreaderEnabled: true })).toMatchObject({ changed: 0, status: 'completed_with_errors' });
      expect(lastDecision('no_change').reason_code).toBe('SUPERSEDED_DURING_RUN');
    });
  });

  test('preferences changed under an unsure answer: superseded, and the run is green', async () => {
    await applyMode(async () => {
      const preferences = require('../services/auto-dispatch/preferences');
      const before = await preferences.getCustomerSchedulingPreferences();
      checkMove.mockImplementation(async () => {
        preferences.getCustomerSchedulingPreferences.mockResolvedValueOnce({ ...before, preferred_day_indexes: [2] });
        return stop('PROOFREADER_UNSURE', 'unknown');
      });
      expect(await runAutoDispatch({ mode: 'apply', proofreaderEnabled: true })).toMatchObject({ changed: 0, status: 'completed' });
      expect(lastDecision('no_change').reason_code).toBe('SUPERSEDED_DURING_RUN');
    });
  });

  test('a visit a person changed while the model read is superseded, not a failed run', async () => {
    await applyMode(async () => {
      checkMove.mockResolvedValue(ALLOW);
      apply.applyAutoDispatchMove.mockRejectedValue(Object.assign(new Error('locked'), { code: 'STALE_PLACEMENT' }));
      expect(await runAutoDispatch({ mode: 'apply', proofreaderEnabled: true })).toMatchObject({ changed: 0, failed: 0, status: 'completed' });
      expect(lastDecision('no_change').reason_code).toBe('SUPERSEDED_DURING_RUN');
    });
  });

  test('any other write failure of a checked move is still a failure', async () => {
    await applyMode(async () => {
      checkMove.mockResolvedValue(ALLOW);
      apply.applyAutoDispatchMove.mockRejectedValue(Object.assign(new Error('guard'), { code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD' }));
      expect(await runAutoDispatch({ mode: 'apply', proofreaderEnabled: true })).toMatchObject({ changed: 0, failed: 1 });
    });
  });

  test('a move the per-run cap holds is never asked about', async () => {
    await applyMode(async () => {
      checkMove.mockResolvedValue(ALLOW);
      await runAutoDispatch({ mode: 'apply', proofreaderEnabled: true, maxChangesPerRun: 0 });
      expect(checkMove).not.toHaveBeenCalled();
    });
  });

  test('gate off: the real check answers null, nothing is asked, and the fallback is unchanged', async () => {
    await applyMode(async () => {
      expect(await runAutoDispatch({ mode: 'apply' })).toMatchObject({ changed: 1 });
      expect(checkMove.mock.calls[0][0].run.proofreader).toBeNull();
      const options = apply.applyAutoDispatchMove.mock.calls[0][3];
      expect(typeof options.rescore).toBe('function');
      expect(options.alternateCandidates.length).toBeGreaterThan(0);
      expect(lastDecision('changed').constraints.proofreader).toBeUndefined();
    });
  });

  test('a dry run never asks', async () => {
    checkMove.mockResolvedValue(ALLOW);
    expect(await runAutoDispatch({ mode: 'dry_run', proofreaderEnabled: true })).toMatchObject({ recommended: 1 });
    expect(checkMove).not.toHaveBeenCalled();
  });
});

// GATE_AUTO_DISPATCH_ARRIVAL_SEARCH (owner 2026-10-24; config.arrivalSearch).
describe('arrival search (GATE_AUTO_DISPATCH_ARRIVAL_SEARCH)', () => {
  const searches = () => candidateSlots.findValidCandidateSlots.mock.calls.map((c) => c[2]);
  const withApply = async (fn) => {
    const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
    process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
    try { await fn(); } finally {
      if (prev === undefined) delete process.env.AUTO_DISPATCH_ALLOW_APPLY; else process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
    }
  };

  test('true: the run searches with the arrival engine (ctx.arrivalSearch), once per visit; off: today\'s search', async () => {
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG] });
    await runAutoDispatch({ mode: 'dry_run', arrivalSearch: 'true' });
    expect(searches().map((ctx) => ctx.arrivalSearch)).toEqual([true]);
    expect(lastDecision('recommended').constraints.arrival_search).toBeUndefined();
    candidateSlots.findValidCandidateSlots.mockClear();
    await runAutoDispatch({ mode: 'dry_run', arrivalSearch: 'off' });
    expect(searches().map((ctx) => ctx.arrivalSearch)).toEqual([false]);
  });

  test('true in apply mode: the re-check before the write searches the same way', async () => {
    await withApply(async () => {
      candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG] });
      expect(await runAutoDispatch({ mode: 'apply', arrivalSearch: 'true' })).toMatchObject({ changed: 1 });
      expect(searches().length).toBeGreaterThan(1);
      expect(searches().every((ctx) => ctx.arrivalSearch === true)).toBe(true);
    });
  });

  test('shadow: the visit stays on today\'s decision and its row records what the arrival search would do', async () => {
    await withApply(async () => {
      // Today's search: no better slot. The arrival search: a clearly better one.
      candidateSlots.findValidCandidateSlots.mockImplementation(async (_s, _p, ctx) => (ctx.arrivalSearch
        ? { current: CURRENT, candidates: [CAND_BIG] }
        : { current: CURRENT, candidates: [] }));
      const res = await runAutoDispatch({ mode: 'apply', arrivalSearch: 'shadow' });
      expect(res).toMatchObject({ changed: 0, evaluated: 1 });
      expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
      expect(searches().map((ctx) => [ctx.arrivalSearch, ctx.roadTravel])).toEqual([[false, null], [true, null]]);
      const row = lastDecision('no_change');
      expect(row.reason_code).toBe('NO_VALID_SLOT');
      expect(row.constraints.arrival_search).toEqual({
        would: 'move', date: CAND_BIG.date, window_start: CAND_BIG.start_time, technician_id: 't1',
        improvement: expect.any(Number), day_move: true, drive_saving_minutes: expect.any(Number), ms: expect.any(Number),
      });
      expect(row.constraints.arrival_search.improvement).toBeGreaterThanOrEqual(15);
    });
  });

  test('shadow: a would-not-move names its reason, and a failed arrival search never stops the run', async () => {
    candidateSlots.findValidCandidateSlots.mockImplementation(async (_s, _p, ctx) => (ctx.arrivalSearch
      ? { current: CURRENT_GOOD, candidates: [CAND_SMALL] }
      : { current: CURRENT, candidates: [] }));
    await runAutoDispatch({ mode: 'dry_run', arrivalSearch: 'shadow' });
    expect(lastDecision('no_change').constraints.arrival_search).toMatchObject({ would: expect.stringMatching(/^NO_/) });

    candidateSlots.findValidCandidateSlots.mockImplementation(async (_s, _p, ctx) => {
      if (ctx.arrivalSearch) throw Object.assign(new Error('route read failed'), { code: 'ECONNRESET' });
      return { current: CURRENT, candidates: [] };
    });
    expect(await runAutoDispatch({ mode: 'dry_run', arrivalSearch: 'shadow' })).toMatchObject({ evaluated: 1 });
    expect(lastDecision('no_change')).toMatchObject({ reason_code: 'NO_VALID_SLOT', constraints: { arrival_search: { would: 'error', error: 'ECONNRESET' } } });
  });
});

// GATE_AUTO_DISPATCH_KEEP_TECH (owner 2026-10-25; config.keepTech).
describe('keep technician (GATE_AUTO_DISPATCH_KEEP_TECH)', () => {
  const searches = () => candidateSlots.findValidCandidateSlots.mock.calls.map((c) => c[2]);
  const applyMode = async (fn) => {
    const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
    process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
    try { await fn(); } finally {
      if (prev === undefined) delete process.env.AUTO_DISPATCH_ALLOW_APPLY; else process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
    }
  };

  test('on: the run hands the search keepTech on its ctx, once per run; off: false', async () => {
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG] });
    await runAutoDispatch({ mode: 'dry_run', keepTech: true });
    expect(searches().map((ctx) => ctx.keepTech)).toEqual([true]);
    candidateSlots.findValidCandidateSlots.mockClear();
    await runAutoDispatch({ mode: 'dry_run', keepTech: false });
    expect(searches().map((ctx) => ctx.keepTech)).toEqual([false]);
  });

  test('the write refused a technician change: nothing moves, no_change TECH_CHANGE_BLOCKED, not a failed run', async () => {
    await applyMode(async () => {
      apply.applyAutoDispatchMove.mockRejectedValue(Object.assign(new Error('keep tech'), { code: 'TECH_CHANGE_BLOCKED', statusCode: 409 }));
      const res = await runAutoDispatch({ mode: 'apply', keepTech: true });
      expect(res).toMatchObject({ changed: 0, failed: 0, status: 'completed' });
      expect(lastDecision('no_change').reason_code).toBe('TECH_CHANGE_BLOCKED');
      expect(lastDecision('failed')).toBeUndefined();
      expect(apply.applyAutoDispatchMove.mock.calls[0][3].keepTech).toBe(true);
    });
  });
});

describe('day rules (GATE_AUTO_DISPATCH_DAY_RULES, owner 2026-10-24)', () => {
  const departureTime = require('../services/scheduling/departure-time');
  const searches = () => candidateSlots.findValidCandidateSlots.mock.calls.map((c) => c[2]);
  const withApply = async (fn) => {
    const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
    process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
    try { await fn(); } finally {
      if (prev === undefined) delete process.env.AUTO_DISPATCH_ALLOW_APPLY; else process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
    }
  };
  // 2026-08-09 is a Sunday, 2026-08-10 the Monday after.
  const SUNDAY = { ...CAND_BIG, date: '2026-08-09' };
  const SUNDAY_LESS = { ...CAND_BIG, date: '2026-08-09', start_time: '10:00', detour_minutes: 2 };
  const MONDAY = { ...CAND_BIG, date: '2026-08-10', detour_minutes: 4 };

  test('off: no departure read, no day rules on the search, nothing new in the run snapshot', async () => {
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG] });
    await runAutoDispatch({ mode: 'dry_run', dayRules: false });
    expect(departureTime.dayDepartureMinutes).not.toHaveBeenCalled();
    expect(searches()[0]).toMatchObject({ dayRules: false });
    expect(searches()[0].departureMinutes).toBeUndefined();
    expect(audit.startRun.mock.calls[0][0]).not.toHaveProperty('departureMinutes');
  });

  test('on: the departure is read once per run, kept in the run snapshot and carried by every search', async () => {
    servicesResult = [svc(), svc({ id: 's2', customer_id: 'c2' })];
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG] });
    await runAutoDispatch({ mode: 'dry_run', dayRules: true });
    expect(departureTime.dayDepartureMinutes).toHaveBeenCalledTimes(1);
    expect(departureTime.dayDepartureMinutes.mock.calls[0][1]).toEqual({ enabled: true });
    expect(audit.startRun.mock.calls[0][0]).toMatchObject({ dayRules: true, departureMinutes: 450, maxSundayMovesPerRun: 2 });
    expect(searches()).toHaveLength(2);
    expect(searches().every((ctx) => ctx.dayRules === true && ctx.departureMinutes === 450)).toBe(true);
  });

  test('past the Sunday cap a Sunday move is held as a valid move, and a weekday move still lands', async () => {
    await withApply(async () => {
      servicesResult = [svc(), svc({ id: 's2', customer_id: 'c2' }), svc({ id: 's3', customer_id: 'c3' })];
      const bySvc = { s1: SUNDAY, s2: SUNDAY_LESS, s3: MONDAY };
      candidateSlots.findValidCandidateSlots.mockImplementation(async (service) => ({ current: CURRENT, candidates: [bySvc[service.id]] }));
      const res = await runAutoDispatch({ mode: 'apply', dayRules: true, maxSundayMovesPerRun: 1 });
      expect(res).toMatchObject({ changed: 2, recommended: 1 });
      expect(apply.applyAutoDispatchMove.mock.calls.map(([service, best]) => [service.id, best.date]))
        .toEqual([['s1', '2026-08-09'], ['s3', '2026-08-10']]);
      const held = lastDecision('recommended');
      expect(held).toMatchObject({ reason_code: 'SUNDAY_CAP_REACHED', service: expect.objectContaining({ id: 's2' }) });
      expect(held.reason_description).toMatch(/Sunday move cap 1 reached/);
    });
  });

  test('past the Sunday cap no fallback slot is a Sunday: the alternates and the re-check after a taken slot drop them', async () => {
    await withApply(async () => {
      servicesResult = [svc(), svc({ id: 's2', customer_id: 'c2' })];
      const bySvc = { s1: [SUNDAY], s2: [{ ...MONDAY, detour_minutes: 1 }, SUNDAY_LESS] };
      candidateSlots.findValidCandidateSlots.mockImplementation(async (service) => ({ current: CURRENT, candidates: bySvc[service.id] }));
      await runAutoDispatch({ mode: 'apply', dayRules: true, maxSundayMovesPerRun: 1 });
      const [, best, , options] = apply.applyAutoDispatchMove.mock.calls.find(([service]) => service.id === 's2');
      expect(best.date).toBe('2026-08-10');
      expect(options.alternateCandidates.map((c) => c.date)).not.toContain('2026-08-09');
      const again = await options.rescore();
      expect(again.kind).toBe('move');
      expect(again.rankedCandidates.map((c) => c.date)).not.toContain('2026-08-09');
    });
  });

  test('a re-time on a visit already on a Sunday is not a move onto a Sunday: the cap does not hold it', async () => {
    await withApply(async () => {
      const onSunday = { ...CURRENT, date: '2026-08-09' };
      servicesResult = [svc({ scheduled_date: '2026-08-09' })];
      candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: onSunday, candidates: [{ ...SUNDAY, start_time: '13:00' }] });
      const res = await runAutoDispatch({ mode: 'apply', dayRules: true, maxSundayMovesPerRun: 0 });
      expect(res).toMatchObject({ changed: 1 });
      expect(lastDecision('recommended')).toBeUndefined();
    });
  });
});

describe('run log line words the day-move rule for the guard mode in force', () => {
  const { describeGuardRule } = _internals;
  test('legacy keeps the flat lock boundary', () => {
    expect(describeGuardRule('legacy', '2026-11-09', '2026-10-26')).toBe('lock>2026-11-09');
    expect(describeGuardRule(undefined, '2026-11-09', '2026-10-26')).toBe('lock>2026-11-09');
  });
  test('tiers says day moves start 7 days out', () => {
    expect(describeGuardRule('tiers', '2026-11-09', '2026-10-26')).toBe('tiers: day moves from 7 days out');
  });
  test('flex says frozen under 73h and day moves land on or after today + 5', () => {
    expect(describeGuardRule('flex', '2026-11-09', '2026-10-26')).toBe('flex: frozen under 73h, day moves on or after 2026-10-31');
  });
});

// GATE_AUTO_DISPATCH_DRY_TIME_ORDER (owner 2026-11-01): the decision is audited
// beside what the dry window would do; shadow moves and writes nothing extra.
describe('dry time audit (GATE_AUTO_DISPATCH_DRY_TIME_ORDER)', () => {
  const { TIME_WINDOWS } = require('../services/auto-dispatch/service-category');
  const CONFIG = { minScoreImprovement: 15, removeStabilityFloor: 35, minDayMoveDriveSavingMinutes: 0 };
  const BASE = {
    preferred_day_indexes: [], effective_time_window: TIME_WINDOWS.early_morning, default_time_window: TIME_WINDOWS.early_morning,
    preferred_time_window: null, blackout: null, service_category: 'general', preferred_days: null, raw_snapshot: null,
  };
  const dryTime = (mode) => ({ mode, hours: 0, class: 'proof', source: 'service_rule', window_key: 'dry_proof', customer_time: false });
  // A first placement ranks on the raw score, so the time window decides between the two slots.
  const FIRST_PLACEMENT = () => svc({ recurring_dispatch_due_date: '2026-08-04', window_start: null });
  const EARLY = { ...CAND_BIG, date: '2026-08-04', start_time: '08:00' };
  const LATE = { ...CAND_BIG, date: '2026-08-04', start_time: '14:00' };

  test('gate off: no dry_time in the audit', async () => {
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG], drops: {} });
    const result = await _internals.evaluatePlacement(svc(), BASE, {}, CONFIG, '2026-06-20');
    expect(result.audit.constraints).not.toHaveProperty('dry_time');
  });

  test('shadow: the live choice stays; the audit names where the dry window would put the visit', async () => {
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: null, candidates: [EARLY, LATE], drops: {} });
    const prefs = { ...BASE, dry_time: dryTime('shadow') };
    const noCurrent = await _internals.evaluatePlacement(FIRST_PLACEMENT(), prefs, {}, CONFIG, '2026-06-20');
    expect(noCurrent.kind).toBe('no_change');
    expect(noCurrent.audit.constraints.dry_time).toMatchObject({ mode: 'shadow', class: 'proof', live_best: null, shadow_best: null });

    const unplaced = { ...CURRENT, date: '2026-08-04', start_time: null, detour_minutes: 40 };
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: unplaced, candidates: [EARLY, LATE], drops: {} });
    const result = await _internals.evaluatePlacement(FIRST_PLACEMENT(), prefs, {}, CONFIG, '2026-06-20');
    expect(result.kind).toBe('move');
    expect(result.best.start_time).toBe('08:00'); // today's early window still decides
    expect(result.audit.constraints.dry_time).toMatchObject({
      mode: 'shadow',
      live_best: { date: '2026-08-04', start: '08:00' },
      shadow_best: { date: '2026-08-04', start: '14:00' }, // the dry window prefers the afternoon
    });
    expect(result.audit.constraints.effective_time_window).toBe('early_morning');
  });

  test('shadow, placed visit: today\'s rules leave it; the audit says the dry window would re-time it on the same date', async () => {
    const config = { ...CONFIG, minScoreImprovement: 5 };
    const info = { mode: 'shadow', hours: 4, class: 'long', source: 'service_rule', window_key: 'dry_long', customer_time: false };
    const prefs = {
      ...BASE, effective_time_window: TIME_WINDOWS.late_morning, default_time_window: TIME_WINDOWS.late_morning, dry_time: info,
    };
    const sameDay = { ...CAND_BIG, detour_minutes: CURRENT.detour_minutes, date: CURRENT.date, start_time: '08:00' };
    const otherDay = { ...sameDay, date: '2026-08-11' };
    const lateCurrent = { ...CURRENT, start_time: '11:00' }; // outside 8-10
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: lateCurrent, candidates: [otherDay, sameDay], drops: {} });
    const result = await _internals.evaluatePlacement(svc(), prefs, {}, config, '2026-06-20');
    expect(result.kind).toBe('no_change'); // the live path is unchanged
    expect(result.audit.constraints.dry_time).toMatchObject({
      live_best: null,
      shadow_best: { date: CURRENT.date, start: '08:00' },
      would_move: true,
      outside_window: true,
      dry_only: { date: CURRENT.date, start: '08:00', added_drive_min: 0 },
    });
  });

  test('shadow: starts only the dry-window search found (shadow_candidates) are scored for shadow_best and never for the live decision', async () => {
    const prefs = { ...BASE, dry_time: dryTime('shadow') };
    const unplaced = { ...CURRENT, date: '2026-08-04', start_time: null, detour_minutes: 40 };
    candidateSlots.findValidCandidateSlots.mockResolvedValue({
      current: unplaced, candidates: [EARLY], shadow_candidates: [LATE], drops: {},
    });
    const result = await _internals.evaluatePlacement(FIRST_PLACEMENT(), prefs, {}, CONFIG, '2026-06-20');
    expect(result.best.start_time).toBe('08:00');
    expect(result.rankedCandidates.map((c) => c.start_time)).toEqual(['08:00']);
    expect(result.audit.constraints.dry_time).toMatchObject({
      live_best: { start: '08:00' }, shadow_best: { date: '2026-08-04', start: '14:00' },
    });
  });

  test('shadow: an empty live pool still records the dry-window pick from shadow_candidates', async () => {
    const prefs = { ...BASE, dry_time: dryTime('shadow') };
    const unplaced = { ...CURRENT, date: '2026-08-04', start_time: null, detour_minutes: 40 };
    candidateSlots.findValidCandidateSlots.mockResolvedValue({
      current: unplaced, candidates: [], shadow_candidates: [LATE], drops: {},
    });
    const result = await _internals.evaluatePlacement(FIRST_PLACEMENT(), prefs, {}, CONFIG, '2026-06-20');
    expect(result.kind).toBe('no_change'); // the live path has nothing to place
    expect(result.audit.constraints.dry_time).toMatchObject({
      live_best: null, shadow_best: { date: '2026-08-04', start: '14:00' }, would_move: true,
    });
  });

  test('apply mode: the applied move keeps the dry_time block, with live_best the slot that moved', async () => {
    const preferences = require('../services/auto-dispatch/preferences');
    const prefs = { ...BASE, dry_time: { ...dryTime('shadow'), class: 'long', window_key: 'dry_long' } };
    preferences.getCustomerSchedulingPreferences.mockResolvedValue(prefs);
    const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
    process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
    try {
      candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG] });
      await runAutoDispatch({ mode: 'apply' });
      const changed = lastDecision('changed');
      expect(changed.reason_code).toBe('CHANGE_APPLIED');
      expect(changed.constraints.dry_time).toMatchObject({
        mode: 'shadow', class: 'long', current: { date: CURRENT.date, start: CURRENT.start_time }, live_best: { date: CAND_BIG.date, start: CAND_BIG.start_time },
      });
      expect(changed.constraints.dry_time).toHaveProperty('shadow_best');
      expect(changed.constraints.dry_time).toHaveProperty('outside_window');
    } finally {
      process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
      preferences.getCustomerSchedulingPreferences.mockImplementation(async () => ({
        preferred_day_indexes: [], effective_time_window: null, preferred_time_window: null,
        blackout: null, service_category: 'general', has_explicit_prefs: false, raw_snapshot: null,
      }));
    }
  });

  test('a SLOT_TAKEN fallback is audited with live_best the candidate apply.js landed on', async () => {
    const preferences = require('../services/auto-dispatch/preferences');
    preferences.getCustomerSchedulingPreferences.mockResolvedValue({ ...BASE, dry_time: dryTime('true') });
    const prev = process.env.AUTO_DISPATCH_ALLOW_APPLY;
    process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
    try {
      candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG, CAND_MODERATE] });
      apply.applyAutoDispatchMove.mockResolvedValue({ ok: true, pre_status: 'confirmed', post_status: 'confirmed', applied: CAND_MODERATE, attempts: 2 });
      await runAutoDispatch({ mode: 'apply' });
      expect(lastDecision('changed').constraints.dry_time).toMatchObject({ live_best: { date: CAND_MODERATE.date, start: CAND_MODERATE.start_time } });
    } finally {
      process.env.AUTO_DISPATCH_ALLOW_APPLY = prev;
      preferences.getCustomerSchedulingPreferences.mockImplementation(async () => ({
        preferred_day_indexes: [], effective_time_window: null, preferred_time_window: null,
        blackout: null, service_category: 'general', has_explicit_prefs: false, raw_snapshot: null,
      }));
    }
  });

  test('true: the audit carries the class and the current slot, no shadow_best', async () => {
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND_BIG], drops: {} });
    const result = await _internals.evaluatePlacement(svc(), { ...BASE, dry_time: dryTime('true') }, {}, CONFIG, '2026-06-20');
    expect(result.audit.constraints.dry_time).toMatchObject({ mode: 'true', current: { date: '2026-08-04', start: '09:00' } });
    expect(result.audit.constraints.dry_time).not.toHaveProperty('shadow_best');
  });
});

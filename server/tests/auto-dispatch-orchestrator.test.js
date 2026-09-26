// Orchestrator glue test: mock the heavy sub-services (DB-backed) but use the
// REAL scorer + config so threshold / mode / counter / idempotency logic is
// exercised end to end.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/auto-dispatch/eligibility', () => ({
  isEligibleForAutoDispatch: jest.fn(() => ({ eligible: true })),
  isRecurringPlanActive: jest.fn(async () => ({ active: true })),
}));
jest.mock('../services/auto-dispatch/preferences', () => ({
  getCustomerSchedulingPreferences: jest.fn(async () => ({
    preferred_day_indexes: [], effective_time_window: null, preferred_time_window: null,
    blackout: null, service_category: 'general', has_explicit_prefs: false, raw_snapshot: null,
  })),
}));
jest.mock('../services/auto-dispatch/candidate-slots', () => ({ findValidCandidateSlots: jest.fn(), GROUP_CONTEXT_UNAVAILABLE: 'GROUP_CONTEXT_UNAVAILABLE' }));
jest.mock('../services/auto-dispatch/apply', () => ({ applyAutoDispatchMove: jest.fn(), unitMoveSize: jest.fn(async () => 1), revalidatePlacement: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/geocoder', () => ({ ensureCustomerGeocoded: jest.fn() }));
jest.mock('../services/auto-dispatch/audit', () => ({
  startRun: jest.fn(async () => 'run1'),
  logDecision: jest.fn(async () => {}),
  completeRun: jest.fn(async () => {}),
  flagUnplacedVisits: jest.fn(async () => 0),
}));

const db = require('../models/db');
const eligibility = require('../services/auto-dispatch/eligibility');
const candidateSlots = require('../services/auto-dispatch/candidate-slots');
const apply = require('../services/auto-dispatch/apply');
const geocoder = require('../services/geocoder');
const audit = require('../services/auto-dispatch/audit');
const { runAutoDispatch, _internals } = require('../services/auto-dispatch');

function buildChain(result) {
  const chain = {};
  const methods = ['leftJoin', 'where', 'whereIn', 'whereNot', 'whereNotIn', 'whereNull', 'whereNotNull',
    'orWhere', 'orWhereNull', 'orWhereNotNull', 'select', 'orderBy', 'orderByRaw', 'limit', 'first', 'returning', 'count'];
  methods.forEach((m) => { chain[m] = (...args) => { args.forEach((a) => { if (typeof a === 'function') a.call(chain); }); return chain; }; });
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

let servicesResult;
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
  db.mockImplementation((table) => buildChain(table === 'technician_capabilities' ? [] : servicesResult));
  eligibility.isEligibleForAutoDispatch.mockReturnValue({ eligible: true });
  eligibility.isRecurringPlanActive.mockResolvedValue({ active: true });
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
});

test('still skips MISSING_GEO when geocoding cannot resolve the address', async () => {
  geocoder.ensureCustomerGeocoded.mockResolvedValue(null);
  eligibility.isEligibleForAutoDispatch.mockReturnValue({ eligible: false, reason_code: 'MISSING_GEO', reason_description: 'no geo' });
  const res = await runAutoDispatch({ mode: 'dry_run' });
  expect(geocoder.ensureCustomerGeocoded).toHaveBeenCalledTimes(1);
  expect(res).toMatchObject({ skipped: 1, evaluated: 0, geocoded: 0 });
  expect(lastDecision('skipped').reason_code).toBe('MISSING_GEO');
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
      candidateSlots.findValidCandidateSlots.mockRejectedValue(Object.assign(new Error('Visit group could not be read'), { code: 'GROUP_CONTEXT_UNAVAILABLE' }));
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

  test('any other slot-finder error still fails the visit as before', async () => {
    candidateSlots.findValidCandidateSlots.mockRejectedValueOnce(new Error('db down'));
    await expect(_internals.evaluatePlacement(svc(), PREFS, {}, CONFIG, '2026-06-20')).rejects.toThrow('db down');
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

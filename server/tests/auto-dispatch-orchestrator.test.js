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
jest.mock('../services/auto-dispatch/candidate-slots', () => ({ findValidCandidateSlots: jest.fn() }));
jest.mock('../services/auto-dispatch/apply', () => ({ applyAutoDispatchMove: jest.fn() }));
jest.mock('../services/geocoder', () => ({ ensureCustomerGeocoded: jest.fn() }));
jest.mock('../services/auto-dispatch/audit', () => ({
  startRun: jest.fn(async () => 'run1'),
  logDecision: jest.fn(async () => {}),
  completeRun: jest.fn(async () => {}),
}));

const db = require('../models/db');
const eligibility = require('../services/auto-dispatch/eligibility');
const candidateSlots = require('../services/auto-dispatch/candidate-slots');
const apply = require('../services/auto-dispatch/apply');
const geocoder = require('../services/geocoder');
const audit = require('../services/auto-dispatch/audit');
const { runAutoDispatch } = require('../services/auto-dispatch');

function buildChain(result) {
  const chain = {};
  const methods = ['leftJoin', 'where', 'whereIn', 'whereNot', 'whereNotIn', 'whereNull', 'whereNotNull',
    'orWhere', 'orWhereNull', 'orWhereNotNull', 'select', 'orderBy', 'limit', 'first', 'returning', 'count'];
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

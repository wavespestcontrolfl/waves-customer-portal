// REMINDERS-OFF LOCK (owner 2026-11-07, "lock") in the 04:10 / 05:00 auto-dispatch run: a visit whose 24-hour
// reminder will not go out is skipped at evaluation (REMINDER_24H_OFF, before any candidate search) in every guard
// mode, and a reminder turned off while the run scored the move stops it at the apply-time re-read. An unreadable
// answer moves nothing and the run is not green. An unplaced due-date visit is a first placement and is placed as
// before. Same harness as night-told-lock-orchestrator.test.js; the lock's reads and its place on the move
// transaction are in auto-dispatch-reminder-off-lock.test.js. Synthetic ids only.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/auto-dispatch/eligibility', () => ({
  isEligibleForAutoDispatch: jest.fn(() => ({ eligible: true })),
  isRecurringPlanActive: jest.fn(async () => ({ active: true })),
  isPersonPlacedVisit: jest.fn(async () => ({ placed: false })),
  SLOT_CHANGED_SQL: '(1 = 1)',
}));
jest.mock('../services/auto-dispatch/preferences', () => ({
  getCustomerSchedulingPreferences: jest.fn(async () => ({
    preferred_day_indexes: [], effective_time_window: null, preferred_time_window: null,
    blackout: null, service_category: 'general', has_explicit_prefs: false, raw_snapshot: null,
  })),
}));
jest.mock('../services/auto-dispatch/candidate-slots', () => ({ findValidCandidateSlots: jest.fn() }));
jest.mock('../services/auto-dispatch/apply', () => ({
  applyAutoDispatchMove: jest.fn(), unitMoveSize: jest.fn(async () => 1), revalidatePlacement: jest.fn(async () => ({ ok: true })), previewGroupMove: jest.fn(async () => null),
}));
jest.mock('../services/geocoder', () => ({ ensureCustomerGeocoded: jest.fn() }));
jest.mock('../services/appointment-reminders', () => ({
  loadVisitReminder24hAnswers: jest.fn(),
  composeScheduledApptTime: jest.fn((svc) => {
    if (!svc) return null;
    const datePart = String(svc.scheduled_date || '').slice(0, 10);
    const timePart = svc.window_start ? String(svc.window_start).slice(0, 8) : null;
    if (!datePart || !timePart) return null;
    return require('../utils/datetime-et').parseETDateTime(`${datePart}T${timePart}`);
  }),
}));
jest.mock('../services/auto-dispatch/check-down-notice', () => ({ noteRun: jest.fn(async () => ({ action: 'none' })) }));
jest.mock('../services/auto-dispatch/audit', () => ({
  startRun: jest.fn(async () => 'run1'),
  logDecision: jest.fn(async () => {}),
  completeRun: jest.fn(async () => {}),
  flagUnplacedVisits: jest.fn(async () => 0),
  // The run-end notice upkeep: stubbed, so a clean run reads 'completed' and the status checks below mean something.
  retireResolvedNotices: jest.fn(async () => {}),
  retireMissingGeoNotices: jest.fn(async () => {}),
  maintainMissingGeoNotices: jest.fn(async () => {}),
}));

const db = require('../models/db');
const { loadVisitReminder24hAnswers } = require('../services/appointment-reminders');
const candidateSlots = require('../services/auto-dispatch/candidate-slots');
const apply = require('../services/auto-dispatch/apply');
const audit = require('../services/auto-dispatch/audit');
const { shiftDateStr } = require('../services/auto-dispatch/dates');
const { etDateString, etParts } = require('../utils/datetime-et');
const { runAutoDispatch } = require('../services/auto-dispatch');

const TODAY = etDateString(new Date());
const CAND_DATE = shiftDateStr(TODAY, 6);
const HOUR = 3600000;

function visitAt(hours) {
  const t = new Date(Date.now() + hours * HOUR);
  const { hour, minute } = etParts(t);
  return { date: etDateString(t), start: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}

function buildChain(result) {
  const chain = {};
  const methods = ['leftJoin', 'where', 'whereIn', 'whereNot', 'whereNotIn', 'whereNull', 'whereNotNull',
    'orWhere', 'orWhereIn', 'orWhereNull', 'orWhereNotNull', 'select', 'orderBy', 'orderByRaw', 'limit', 'first', 'returning', 'count', 'whereRaw', 'orWhereRaw', 'groupBy'];
  methods.forEach((m) => { chain[m] = (...args) => { args.forEach((a) => { if (typeof a === 'function') a.call(chain); }); return chain; }; });
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

let visit;
let shape; // extra columns on the visit row (the unplaced due-date shape)

function svc() {
  return {
    id: 's1', customer_id: 'c1', property_id: 'p1', is_recurring: true, recurring_parent_id: 'p0',
    status: 'confirmed', scheduled_date: visit.date, technician_id: 't1',
    window_start: visit.start, window_end: null, auto_dispatch_change_count: 0, ...shape,
  };
}
const current = () => ({ is_current: true, detour_minutes: 40, stops_that_day: 3, technician_id: 't1', date: visit.date, start_time: visit.start, capability_level: 'qualified' });
const CAND = { is_current: false, detour_minutes: 0, stops_that_day: 5, technician_id: 't1', date: CAND_DATE, start_time: '08:00', end_time: '09:00', capability_level: 'qualified', total_drive_minutes: 10 };

// The reader's answers, in call order: `true` = the reminder goes out, `false` = it does not, an Error = the read fails.
function answersInOrder(...replies) {
  for (const reply of replies) {
    if (reply instanceof Error) loadVisitReminder24hAnswers.mockRejectedValueOnce(reply);
    else loadVisitReminder24hAnswers.mockImplementationOnce(async (_conn, visits) => new Map(visits.map((v) => [v.id, reply])));
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  loadVisitReminder24hAnswers.mockReset();
  loadVisitReminder24hAnswers.mockImplementation(async (_conn, visits) => new Map(visits.map((v) => [v.id, true])));
  process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
  visit = visitAt(30);
  shape = {};
  db.mockImplementation((table) => buildChain(table === 'scheduled_services' ? [svc()] : []));
  candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: current(), candidates: [CAND] });
  apply.applyAutoDispatchMove.mockResolvedValue({ ok: true, pre_status: 'confirmed', post_status: 'confirmed' });
  apply.revalidatePlacement.mockResolvedValue({ ok: true });
});
afterAll(() => { delete process.env.AUTO_DISPATCH_ALLOW_APPLY; });

const decisions = () => audit.logDecision.mock.calls.map((c) => c[1]);
const codes = () => decisions().map((d) => d.reason_code);
const flex = (over = {}) => runAutoDispatch({ mode: 'apply', flexTierEnabled: true, nightLock24h: true, ...over });
const tiers = (over = {}) => runAutoDispatch({ mode: 'apply', routeTiersEnabled: true, nightLock24h: true, ...over });
const legacy = (over = {}) => runAutoDispatch({ mode: 'apply', ...over });

describe.each([['flex', flex], ['tiers', tiers], ['legacy', legacy]])('%s mode', (_name, go) => {
  test('a visit whose 24-hour reminder will not go out is skipped REMINDER_24H_OFF before any candidate search', async () => {
    answersInOrder(false);
    const res = await go();
    expect(res.changed).toBe(0);
    expect(decisions()).toContainEqual(expect.objectContaining({ action: 'skipped', reason_code: 'REMINDER_24H_OFF' }));
    expect(candidateSlots.findValidCandidateSlots).not.toHaveBeenCalled();
    expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
    expect(loadVisitReminder24hAnswers).toHaveBeenCalledWith(db, [{ id: 's1', customer_id: 'c1', property_id: 'p1' }]);
  });

  test('a run whose reminder answers cannot be read moves nothing, and is not green', async () => {
    answersInOrder(new Error('prefs read down'));
    const res = await go();
    expect(res.changed).toBe(0);
    expect(codes()).toContain('REMINDER_24H_UNKNOWN');
    expect(res.status).toBe('completed_with_errors');
  });
});

describe('flex mode, apply', () => {
  test('control: the reminder goes out, the same visit moves, and the run is green', async () => {
    const res = await flex();
    expect(res.changed).toBe(1);
    expect(res.status).toBe('completed');
    expect(apply.applyAutoDispatchMove).toHaveBeenCalledTimes(1);
    expect(codes()).not.toContain('REMINDER_24H_OFF');
  });

  test('the reminder turned off while the run scored the move: the apply-time re-read stops it', async () => {
    answersInOrder(true, false);
    const res = await flex();
    expect(res.changed).toBe(0);
    expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
    expect(decisions()).toContainEqual(expect.objectContaining({ action: 'no_change', reason_code: 'REMINDER_24H_OFF' }));
    expect(loadVisitReminder24hAnswers).toHaveBeenCalledTimes(2);
  });

  test('an apply-time read that fails moves nothing, and the run is not green', async () => {
    answersInOrder(true, new Error('prefs read down'));
    const res = await flex();
    expect(res.changed).toBe(0);
    expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
    expect(decisions()).toContainEqual(expect.objectContaining({ action: 'no_change', reason_code: 'REMINDER_24H_UNKNOWN' }));
    expect(res.status).toBe('completed_with_errors');
  });

  test('an unplaced due-date visit is a first placement: it is placed as before, and its answer is never read', async () => {
    shape = { window_start: null, recurring_dispatch_due_date: shiftDateStr(TODAY, 5) };
    visit = { date: shiftDateStr(TODAY, 5), start: null };
    loadVisitReminder24hAnswers.mockImplementation(async (_conn, visits) => new Map(visits.map((v) => [v.id, false])));
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: { ...current(), start_time: null }, candidates: [CAND] });
    const res = await flex();
    expect(codes()).not.toContain('REMINDER_24H_OFF');
    expect(loadVisitReminder24hAnswers).not.toHaveBeenCalled();
    expect(res.changed).toBe(1);
  });
});

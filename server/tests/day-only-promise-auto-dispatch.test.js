// GATE_DAY_ONLY_PROMISE part A (owner 2026-11-05 "D1 a" / "D2 a"): through the real 04:10 auto-dispatch run (the same
// harness as night-told-lock-orchestrator.test.js),
// a recurring visit 30 h out whose latest promise is day-only, or an unknown window, is skipped REMINDER_SENT_FROZEN:
// the dispatcher moves DATES and the customer was told that day. Checked at evaluation and at the apply-time
// re-check; the moving visit's own transaction and the grouped-sibling guards are in the apply section below. The promise reader (told-visits) runs for real;
// only the detector's database read (loadPromiseEvents) is fed events. Synthetic ids only.
jest.mock('../services/no-show-detector', () => {
  const actual = jest.requireActual('../services/no-show-detector');
  return { ...actual, loadPromiseEvents: jest.fn() };
});
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
// A realistic composer (mirrors appointment-reminders.js's own
// composeScheduledApptTime) so flexTier.ownScheduleFrozen's hours-until
// math is genuine, without pulling the whole appointment-reminders module
// (and its own dependencies) into this orchestrator test.
jest.mock('../services/appointment-reminders', () => ({
  // The night run's reminders-off lock (auto-dispatch/reminder-off.js): every 24-hour reminder goes out here.
  loadVisitReminder24hAnswers: jest.fn(async (_conn, visits) => new Map(visits.map((v) => [v.id, true]))),
  composeScheduledApptTime: jest.fn((svc) => {
    if (!svc) return null;
    const datePart = String(svc.scheduled_date || '').slice(0, 10);
    const timePart = svc.window_start ? String(svc.window_start).slice(0, 8) : null;
    if (!datePart || !timePart) return null;
    return require('../utils/datetime-et').parseETDateTime(`${datePart}T${timePart}`);
  }),
}));
// The run-end move-check-down notice (check-down-notice.js) is upkeep this harness stubs, like audit.js's notices.
jest.mock('../services/auto-dispatch/check-down-notice', () => ({ noteRun: jest.fn(async () => ({ action: 'none' })) }));
jest.mock('../services/auto-dispatch/audit', () => ({
  startRun: jest.fn(async () => 'run1'),
  logDecision: jest.fn(async () => {}),
  completeRun: jest.fn(async () => {}),
  flagUnplacedVisits: jest.fn(async () => 0),
}));

const db = require('../models/db');
const detector = require('../services/no-show-detector');
const candidateSlots = require('../services/auto-dispatch/candidate-slots');
const apply = require('../services/auto-dispatch/apply');
const audit = require('../services/auto-dispatch/audit');
const { shiftDateStr } = require('../services/auto-dispatch/dates');
const { etDateString } = require('../utils/datetime-et');
const { runAutoDispatch } = require('../services/auto-dispatch');

const { etParts } = require('../utils/datetime-et');
const { _internals } = require('../services/auto-dispatch');

const TODAY = etDateString(new Date());
const CAND_DATE = shiftDateStr(TODAY, 6);
const HOUR = 3600000;

// The visit's date and HH:MM (ET) for an instant `hours` from now, so the
// real clock (the run reads `new Date()`) puts it that far out.
function visitAt(hours) {
  const t = new Date(Date.now() + hours * HOUR);
  const { hour, minute } = etParts(t);
  return {
    iso: t.toISOString(),
    date: etDateString(t),
    start: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

function buildChain(result) {
  const chain = {};
  const methods = ['leftJoin', 'where', 'whereIn', 'whereNot', 'whereNotIn', 'whereNull', 'whereNotNull',
    'orWhere', 'orWhereIn', 'orWhereNull', 'orWhereNotNull', 'select', 'orderBy', 'orderByRaw', 'limit', 'first', 'returning', 'count', 'whereRaw', 'orWhereRaw', 'groupBy'];
  methods.forEach((m) => { chain[m] = (...args) => { args.forEach((a) => { if (typeof a === 'function') a.call(chain); }); return chain; }; });
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

let visit; // the visit under test
let reminderResults; // consumed per appointment_reminders query, in order

function svc() {
  return {
    id: 's1', customer_id: 'c1', is_recurring: true, recurring_parent_id: 'p1',
    status: 'confirmed', scheduled_date: visit.date, technician_id: 't1',
    window_start: visit.start, window_end: null, auto_dispatch_change_count: 0,
  };
}
const current = () => ({ is_current: true, detour_minutes: 40, stops_that_day: 3, technician_id: 't1', date: visit.date, start_time: visit.start, capability_level: 'qualified' });
const CAND = { is_current: false, detour_minutes: 0, stops_that_day: 5, technician_id: 't1', date: CAND_DATE, start_time: '08:00', end_time: '09:00', capability_level: 'qualified', total_drive_minutes: 10 };

// One appointment_reminders row for the visit, `hours` out, with the flags given.
const reminderRow = (hours, flags) => ({
  scheduled_service_id: 's1', customer_id: 'c1', appointment_time: new Date(Date.now() + hours * HOUR).toISOString(),
  reminder_72h_sent: false, reminder_24h_sent: false, suppressed_by_sibling: false, ...flags,
});

function setup(hours, rows) {
  visit = visitAt(hours);
  reminderResults = rows.map((r) => [r]);
  candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: current(), candidates: [CAND] });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
  visit = visitAt(30);
  reminderResults = [];
  db.mockImplementation((table) => {
    if (table === 'appointment_reminders') return buildChain(reminderResults.length ? reminderResults.shift() : []);
    if (table === 'scheduled_services') return buildChain([svc()]);
    return buildChain([]);
  });
  apply.applyAutoDispatchMove.mockResolvedValue({ ok: true, pre_status: 'confirmed', post_status: 'confirmed' });
  apply.revalidatePlacement.mockResolvedValue({ ok: true });
});

beforeEach(() => { detector.loadPromiseEvents.mockReset(); detector.loadPromiseEvents.mockResolvedValue([]); });
afterAll(() => { delete process.env.AUTO_DISPATCH_ALLOW_APPLY; });

const skipCodes = () => audit.logDecision.mock.calls.map((c) => c[1]).filter((d) => d.action !== 'changed').map((d) => d.reason_code);
const tiers = (over = {}) => runAutoDispatch({ mode: 'apply', routeTiersEnabled: true, ...over });
const flex = (over = {}) => runAutoDispatch({ mode: 'apply', flexTierEnabled: true, ...over });

const SLOT = '2026-11-12T14:00:00.000Z';
const promise = (over = {}) => ({ visit_id: 's1', start_at: null, communicated_at: '2020-01-01T00:00:00Z', source: 'message', source_id: 1, ...over });
const dayPromise = () => detector.loadPromiseEvents.mockResolvedValue([promise({ level: 'day' })]);
const unknownPromise = () => detector.loadPromiseEvents.mockResolvedValue([promise()]);
const hourPromise = () => detector.loadPromiseEvents.mockResolvedValue([promise({ start_at: SLOT })]);

describe.each([['tiers', tiers, false], ['flex', flex, true]])('%s mode', (_name, go, moves) => {
  test('owner 2026-11-26 (W20): a visit 30 h out whose latest promise is day-only is NOT frozen at evaluation', async () => {
    setup(30, [reminderRow(30, {})]);
    dayPromise();
    const res = await go();
    expect(skipCodes()).not.toContain('REMINDER_SENT_FROZEN');
    if (moves) expect(res.changed).toBe(1);
  });

  test('owner 2026-11-26 (W20): an unknown-window promise is NOT frozen when anyPromise is false', async () => {
    setup(30, [reminderRow(30, {})]);
    unknownPromise();
    const res = await go();
    expect(skipCodes()).not.toContain('REMINDER_SENT_FROZEN');
    if (moves) expect(res.changed).toBe(1);
  });

  test('an explicit hour-window promise sent between pass 1 and apply still freezes the move', async () => {
    setup(30, [reminderRow(30, {}), reminderRow(30, {})]);
    detector.loadPromiseEvents.mockResolvedValueOnce([]).mockResolvedValue([promise({ start_at: SLOT })]);
    const res = await go();
    expect(res.changed).toBe(0);
    expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
    if (moves) expect(skipCodes()).toContain('REMINDER_SENT_FROZEN');
  });

  test('no promise at all, or a known slot with no day mark, behaves as PR 1 (no promise = movable, slot = frozen)', async () => {
    setup(30, [reminderRow(30, {}), reminderRow(30, {})]);
    const res = await go();
    expect(skipCodes()).not.toContain('REMINDER_SENT_FROZEN');
    if (moves) expect(res.changed).toBe(1);
    jest.clearAllMocks();
    setup(30, [reminderRow(30, {})]);
    hourPromise();
    await go();
    expect(skipCodes()).toContain('REMINDER_SENT_FROZEN');
  });

  test('a promise read that fails freezes the visit (fail closed)', async () => {
    setup(30, [reminderRow(30, {})]);
    detector.loadPromiseEvents.mockRejectedValue(new Error('promise read down'));
    const res = await go();
    expect(res.changed).toBe(0);
    expect(skipCodes()).toContain('REMINDER_STATUS_UNKNOWN');
  });
});

describe('the run config', () => {
  test('the run config records dayOnlyPromise: true while freezeReadArgs sets anyPromise: false', async () => {
    setup(30, [reminderRow(30, {})]);
    dayPromise();
    await tiers();
    expect(skipCodes()).not.toContain('REMINDER_SENT_FROZEN');
    expect(audit.startRun.mock.calls[0][0].dayOnlyPromise).toBe(true);
  });
});

describe('the freeze option', () => {
  const { freezeReadArgs } = _internals;
  test('freezeReadArgs sets anyPromise: false (owner 2026-11-26 W20: day-only confirmations are not frozen before 72h)', () => {
    expect(freezeReadArgs('flex')).toEqual([25, { lock24h: true, toldLock: true, anyPromise: false }]);
    expect(freezeReadArgs('tiers')).toEqual([24.25, { lock24h: true, toldLock: true, anyPromise: false }]);
  });
});

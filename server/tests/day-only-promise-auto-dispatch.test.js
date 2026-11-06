// GATE_DAY_ONLY_PROMISE part A (owner 2026-11-05 "D1 a" / "D2 a"): through the real 04:10 auto-dispatch run (the same
// harness as night-told-lock-orchestrator.test.js), with BOTH GATE_NIGHT_TOLD_LOCK and this gate on (and nightLock24h),
// a recurring visit 30 h out whose latest promise is day-only, or an unknown window, is skipped REMINDER_SENT_FROZEN:
// the dispatcher moves DATES and the customer was told that day. Checked at evaluation and at the apply-time
// re-check; the moving visit's own transaction and the grouped-sibling guards are in the apply section below. This gate
// off: PR 1's behavior (a day or unknown promise does not freeze). The promise reader (told-visits) runs for real;
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
afterEach(() => { delete process.env.GATE_NIGHT_LOCK_24H; delete process.env.GATE_NIGHT_TOLD_LOCK; delete process.env.GATE_DAY_ONLY_PROMISE; });
afterAll(() => { delete process.env.AUTO_DISPATCH_ALLOW_APPLY; });

const skipCodes = () => audit.logDecision.mock.calls.map((c) => c[1]).filter((d) => d.action !== 'changed').map((d) => d.reason_code);


afterEach(() => { delete process.env.GATE_NIGHT_TOLD_LOCK; });


const skipTexts = () => audit.logDecision.mock.calls.map((c) => c[1]).filter((d) => d.reason_code === 'REMINDER_SENT_FROZEN').map((d) => d.reason_description);
const tiers = (over = {}) => runAutoDispatch({ mode: 'apply', routeTiersEnabled: true, ...over });
const flex = (over = {}) => runAutoDispatch({ mode: 'apply', flexTierEnabled: true, ...over });

const SLOT = '2026-11-12T14:00:00.000Z';
const promise = (over = {}) => ({ visit_id: 's1', start_at: null, communicated_at: '2020-01-01T00:00:00Z', source: 'message', source_id: 1, ...over });
const dayPromise = () => detector.loadPromiseEvents.mockResolvedValue([promise({ level: 'day' })]);
const unknownPromise = () => detector.loadPromiseEvents.mockResolvedValue([promise()]);
const hourPromise = () => detector.loadPromiseEvents.mockResolvedValue([promise({ start_at: SLOT })]);
const on = { nightLock24h: true, nightToldLock: true, dayOnlyPromise: true };

describe.each([['tiers', tiers, false], ['flex', flex, true]])('%s mode', (_name, go, moves) => {
  test('all three gates on: a visit 30 h out whose latest promise is day-only is skipped REMINDER_SENT_FROZEN at evaluation', async () => {
    setup(30, [reminderRow(30, {})]);
    dayPromise();
    const res = await go(on);
    expect(res.changed).toBe(0);
    expect(skipCodes()).toContain('REMINDER_SENT_FROZEN');
    expect(skipTexts()[0]).toContain('told-time');
    expect(candidateSlots.findValidCandidateSlots).not.toHaveBeenCalled();
  });

  test('all three gates on: an unknown-window promise is skipped too', async () => {
    setup(30, [reminderRow(30, {})]);
    unknownPromise();
    const res = await go(on);
    expect(res.changed).toBe(0);
    expect(skipCodes()).toContain('REMINDER_SENT_FROZEN');
  });

  test('all three gates on: a day-only promise sent between pass 1 and the apply freezes the move (apply-time re-check)', async () => {
    setup(30, [reminderRow(30, {}), reminderRow(30, {})]);
    detector.loadPromiseEvents.mockResolvedValueOnce([]).mockResolvedValue([promise({ level: 'day' })]);
    const res = await go(on);
    expect(res.changed).toBe(0);
    expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
    if (moves) expect(skipCodes()).toContain('REMINDER_SENT_FROZEN');
  });

  test('all three gates on: no promise at all, or a known slot with no day mark, behaves as PR 1 (no promise = movable, slot = frozen)', async () => {
    setup(30, [reminderRow(30, {}), reminderRow(30, {})]);
    const res = await go(on);
    expect(skipCodes()).not.toContain('REMINDER_SENT_FROZEN');
    if (moves) expect(res.changed).toBe(1);
    jest.clearAllMocks();
    setup(30, [reminderRow(30, {})]);
    hourPromise();
    await go(on);
    expect(skipCodes()).toContain('REMINDER_SENT_FROZEN');
  });

  test('this gate off (told-lock on): PR 1 behavior, a day-only or unknown-window promise does not freeze', async () => {
    setup(30, [reminderRow(30, {}), reminderRow(30, {})]);
    dayPromise();
    const res = await go({ ...on, dayOnlyPromise: false });
    expect(skipCodes()).not.toContain('REMINDER_SENT_FROZEN');
    if (moves) expect(res.changed).toBe(1);
    jest.clearAllMocks();
    setup(30, [reminderRow(30, {}), reminderRow(30, {})]);
    unknownPromise();
    await go({ ...on, dayOnlyPromise: false });
    expect(skipCodes()).not.toContain('REMINDER_SENT_FROZEN');
  });

  test('a promise read that fails freezes the visit (fail closed)', async () => {
    setup(30, [reminderRow(30, {})]);
    detector.loadPromiseEvents.mockRejectedValue(new Error('promise read down'));
    const res = await go(on);
    expect(res.changed).toBe(0);
    expect(skipCodes()).toContain('REMINDER_STATUS_UNKNOWN');
  });
});

describe('this gate acts only together with the told-lock and nightLock24h', () => {
  test('told-lock off or nightLock24h off: a day-only promise freezes nothing, and no promise is read', async () => {
    setup(30, [reminderRow(30, {})]);
    dayPromise();
    await flex({ nightLock24h: true, nightToldLock: false, dayOnlyPromise: true });
    expect(skipCodes()).not.toContain('REMINDER_SENT_FROZEN');
    await flex({ nightLock24h: false, nightToldLock: true, dayOnlyPromise: true });
    expect(detector.loadPromiseEvents).not.toHaveBeenCalled();
  });

  test('all three gates read once per run from the environment; the run config carries dayOnlyPromise', async () => {
    setup(30, [reminderRow(30, {})]);
    dayPromise();
    process.env.GATE_NIGHT_LOCK_24H = 'true';
    process.env.GATE_NIGHT_TOLD_LOCK = 'true';
    process.env.GATE_DAY_ONLY_PROMISE = 'true';
    const res = await tiers();
    expect(res.changed).toBe(0);
    expect(skipCodes()).toContain('REMINDER_SENT_FROZEN');
    expect(audit.startRun.mock.calls[0][0].dayOnlyPromise).toBe(true);
  });

  test('the env gate off: config.dayOnlyPromise is false and a day-only promise does not freeze', async () => {
    setup(30, [reminderRow(30, {}), reminderRow(30, {})]);
    dayPromise();
    process.env.GATE_NIGHT_LOCK_24H = 'true';
    process.env.GATE_NIGHT_TOLD_LOCK = 'true';
    await flex();
    expect(audit.startRun.mock.calls[0][0].dayOnlyPromise).toBe(false);
    expect(skipCodes()).not.toContain('REMINDER_SENT_FROZEN');
  });
});

describe('dayOnlyOf and the freeze option', () => {
  const { dayOnlyOf, freezeReadArgs } = _internals;
  test('dayOnlyOf needs nightLock24h, nightToldLock and dayOnlyPromise, all strictly true', () => {
    expect(dayOnlyOf(on)).toBe(true);
    for (const off of [{ nightLock24h: false }, { nightToldLock: false }, { dayOnlyPromise: false }, { dayOnlyPromise: 'true' }]) expect(dayOnlyOf({ ...on, ...off })).toBe(false);
    expect(dayOnlyOf(undefined)).toBe(false);
    expect(dayOnlyOf({})).toBe(false);
  });

  test('freezeReadArgs adds anyPromise only with the told-lock and the day-only flag; otherwise exactly PR 1', () => {
    expect(freezeReadArgs('flex', true, true, true)).toEqual([25, { lock24h: true, toldLock: true, anyPromise: true }]);
    expect(freezeReadArgs('flex', true, true, false)).toEqual([25, { lock24h: true, toldLock: true }]);
    expect(freezeReadArgs('flex', true, true)).toEqual([25, { lock24h: true, toldLock: true }]);
    expect(freezeReadArgs('flex', true, false, true)).toEqual([25, { lock24h: true }]);
    expect(freezeReadArgs('flex', false, true, true)).toEqual([73]);
  });
});

// GATE_NIGHT_TOLD_LOCK orchestrator integration (owner 2026-11-05, "D1 a"): with the
// gate on AND the run's nightLock24h on (both read once per run into the config),
// the 04:10 / 05:00 auto-dispatch run skips a visit the customer was told a time
// for (a known-slot promise, read by auto-dispatch/told-visits.js, mocked here:
// REMINDER_SENT_FROZEN), at evaluation and at the apply-time re-check. A
// reminder_72h_sent flag with no real promise freezes nothing. Gate off, or nightLock24h off: today's behavior. Same harness as
// night-lock-24h-orchestrator.test.js. Synthetic ids only.
jest.mock('../services/auto-dispatch/told-visits', () => ({ loadToldVisitIds: jest.fn() }));
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
const { loadToldVisitIds } = require('../services/auto-dispatch/told-visits');
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

beforeEach(() => { loadToldVisitIds.mockReset(); loadToldVisitIds.mockResolvedValue(new Set()); });
afterEach(() => { delete process.env.GATE_NIGHT_LOCK_24H; });
afterAll(() => { delete process.env.AUTO_DISPATCH_ALLOW_APPLY; });

const skipCodes = () => audit.logDecision.mock.calls.map((c) => c[1]).filter((d) => d.action !== 'changed').map((d) => d.reason_code);


afterEach(() => { delete process.env.GATE_NIGHT_TOLD_LOCK; });

const skipTexts = () => audit.logDecision.mock.calls.map((c) => c[1]).filter((d) => d.reason_code === 'REMINDER_SENT_FROZEN').map((d) => d.reason_description);
const tiers = (over = {}) => runAutoDispatch({ mode: 'apply', routeTiersEnabled: true, ...over });
const flex = (over = {}) => runAutoDispatch({ mode: 'apply', flexTierEnabled: true, ...over });

const told = (...ids) => loadToldVisitIds.mockResolvedValue(new Set(ids));

// In tiers mode a 6-day move from a 30 h visit is outside the tier ladder (a drift skip), so only the freeze code is compared there.
describe.each([['tiers', tiers, false], ['flex', flex, true]])('%s mode', (_name, go, moves) => {
  test('gate on + nightLock24h on: a visit 30 h out with a known-slot promise is skipped REMINDER_SENT_FROZEN', async () => {
    setup(30, [reminderRow(30, {})]);
    told('s1');
    const res = await go({ nightLock24h: true, nightToldLock: true });
    expect(res.changed).toBe(0);
    expect(skipCodes()).toContain('REMINDER_SENT_FROZEN');
    expect(skipTexts()[0]).toContain('told-time');
    expect(candidateSlots.findValidCandidateSlots).not.toHaveBeenCalled();
  });

  test('a promise sent between pass 1 and the apply freezes the move (apply-time re-check)', async () => {
    setup(30, [reminderRow(30, {}), reminderRow(30, {})]);
    loadToldVisitIds.mockResolvedValueOnce(new Set()).mockResolvedValue(new Set(['s1']));
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: current(), candidates: [CAND] });
    const res = await go({ nightLock24h: true, nightToldLock: true });
    expect(res.changed).toBe(0);
    expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
    if (moves) expect(skipCodes()).toContain('REMINDER_SENT_FROZEN');
  });

  test('a reminder_72h_sent flag with no real promise (skipped reminder) freezes nothing', async () => {
    setup(30, [reminderRow(30, { reminder_72h_sent: true }), reminderRow(30, { reminder_72h_sent: true })]);
    const res = await go({ nightLock24h: true, nightToldLock: true });
    expect(skipCodes()).not.toContain('REMINDER_SENT_FROZEN');
    if (moves) expect(res.changed).toBe(1);
  });

  test('a promise read that fails freezes the visit (fail closed)', async () => {
    setup(30, [reminderRow(30, {})]);
    loadToldVisitIds.mockRejectedValue(new Error('promise read down'));
    const res = await go({ nightLock24h: true, nightToldLock: true });
    expect(res.changed).toBe(0);
    expect(skipCodes()).toContain('REMINDER_STATUS_UNKNOWN');
  });

  test('gate off: the same told visit is not frozen by the promise (today), and no promise is read', async () => {
    setup(30, [reminderRow(30, {}), reminderRow(30, {})]);
    told('s1');
    const res = await go({ nightLock24h: true, nightToldLock: false });
    expect(skipCodes()).not.toContain('REMINDER_SENT_FROZEN');
    expect(loadToldVisitIds).not.toHaveBeenCalled();
    if (moves) expect(res.changed).toBe(1);
  });
});

describe('the told-lock only acts with nightLock24h', () => {
  test('nightLock24h off: the 73-hour rule decides, text says 73-hour; no promise is read', async () => {
    setup(30, [reminderRow(30, { reminder_72h_sent: true })]);
    told('s1');
    await flex({ nightLock24h: false, nightToldLock: true });
    expect(skipCodes()).toContain('REMINDER_SENT_FROZEN');
    expect(skipTexts()[0]).toContain('73-hour');
    expect(loadToldVisitIds).not.toHaveBeenCalled();
  });

  test('both gates read once per run from the environment; the run config carries nightToldLock', async () => {
    setup(30, [reminderRow(30, {})]);
    told('s1');
    process.env.GATE_NIGHT_LOCK_24H = 'true';
    process.env.GATE_NIGHT_TOLD_LOCK = 'true';
    const res = await tiers();
    expect(res.changed).toBe(0);
    expect(skipCodes()).toContain('REMINDER_SENT_FROZEN');
    expect(audit.startRun.mock.calls[0][0].nightToldLock).toBe(true);
  });

  test('only the told-lock gate on (nightLock24h off by env): no promise is read, tiers keeps the 72-hour rule', async () => {
    setup(30, [reminderRow(30, { reminder_72h_sent: true })]);
    told('s1');
    process.env.GATE_NIGHT_TOLD_LOCK = 'true';
    await tiers();
    expect(skipTexts()[0]).toContain('72-hour');
    expect(loadToldVisitIds).not.toHaveBeenCalled();
    expect(audit.startRun.mock.calls[0][0].nightLock24h).toBe(false);
  });
});

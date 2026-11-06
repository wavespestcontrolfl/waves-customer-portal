// GATE_NIGHT_TOLD_LOCK orchestrator integration (owner 2026-11-05, "D1 a"): with the
// gate on AND the run's nightLock24h on (both read once per run into the config),
// the 04:10 / 05:00 auto-dispatch run skips a visit whose 72-hour reminder was
// really sent (REMINDER_SENT_FROZEN), at evaluation and at the apply-time
// re-check. Gate off, or nightLock24h off: today's behavior. Same harness as
// night-lock-24h-orchestrator.test.js. Synthetic ids only.
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

afterEach(() => { delete process.env.GATE_NIGHT_LOCK_24H; });
afterAll(() => { delete process.env.AUTO_DISPATCH_ALLOW_APPLY; });

const skipCodes = () => audit.logDecision.mock.calls.map((c) => c[1]).filter((d) => d.action !== 'changed').map((d) => d.reason_code);


afterEach(() => { delete process.env.GATE_NIGHT_TOLD_LOCK; });

const skipTexts = () => audit.logDecision.mock.calls.map((c) => c[1]).filter((d) => d.reason_code === 'REMINDER_SENT_FROZEN').map((d) => d.reason_description);
const tiers = (over = {}) => runAutoDispatch({ mode: 'apply', routeTiersEnabled: true, ...over });
const flex = (over = {}) => runAutoDispatch({ mode: 'apply', flexTierEnabled: true, ...over });

// In tiers mode a 6-day move from a 30 h visit is outside the tier ladder (a drift skip), so only the freeze code is compared there.
describe.each([['tiers', tiers, false], ['flex', flex, true]])('%s mode', (_name, go, moves) => {
  test('gate on + nightLock24h on: a visit 30 h out with its 72-hour reminder sent is skipped REMINDER_SENT_FROZEN', async () => {
    setup(30, [reminderRow(30, { reminder_72h_sent: true })]);
    const res = await go({ nightLock24h: true, nightToldLock: true });
    expect(res.changed).toBe(0);
    expect(skipCodes()).toContain('REMINDER_SENT_FROZEN');
    expect(skipTexts()[0]).toContain('72-hour');
    expect(candidateSlots.findValidCandidateSlots).not.toHaveBeenCalled();
  });

  test('a 72-hour reminder sent between pass 1 and the apply freezes the move (apply-time re-check)', async () => {
    setup(30, [reminderRow(30, { }), reminderRow(30, { reminder_72h_sent: true })]);
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: current(), candidates: [CAND] });
    const res = await go({ nightLock24h: true, nightToldLock: true });
    expect(res.changed).toBe(0);
    expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
    if (moves) expect(skipCodes()).toContain('REMINDER_SENT_FROZEN');
  });

  test('a windows_preclosed or cancelled 72-hour row is not a sent reminder', async () => {
    for (const flags of [{ windows_preclosed: true }, { cancelled: true }]) {
      audit.logDecision.mockClear();
      setup(30, [reminderRow(30, { reminder_72h_sent: true, ...flags }), reminderRow(30, { reminder_72h_sent: true, ...flags })]);
      const res = await go({ nightLock24h: true, nightToldLock: true });
      expect(skipCodes()).not.toContain('REMINDER_SENT_FROZEN');
      if (moves) expect(res.changed).toBe(1);
    }
  });

  test('gate off: the same visit is not frozen by that 72-hour reminder (today)', async () => {
    setup(30, [reminderRow(30, { reminder_72h_sent: true }), reminderRow(30, { reminder_72h_sent: true })]);
    const res = await go({ nightLock24h: true, nightToldLock: false });
    expect(skipCodes()).not.toContain('REMINDER_SENT_FROZEN');
    if (moves) expect(res.changed).toBe(1);
  });
});

describe('the told-lock only acts with nightLock24h', () => {
  test('nightLock24h off: the 73-hour rule decides, text says 73/72-hour not told-lock; the option is not passed', async () => {
    setup(30, [reminderRow(30, { reminder_72h_sent: true })]);
    await flex({ nightLock24h: false, nightToldLock: true });
    expect(skipCodes()).toContain('REMINDER_SENT_FROZEN');
    expect(skipTexts()[0]).toContain('73-hour');
  });

  test('both gates read once per run from the environment; the apply config carries nightToldLock', async () => {
    setup(30, [reminderRow(30, { reminder_72h_sent: true })]);
    process.env.GATE_NIGHT_LOCK_24H = 'true';
    process.env.GATE_NIGHT_TOLD_LOCK = 'true';
    const res = await tiers();
    expect(res.changed).toBe(0);
    expect(skipCodes()).toContain('REMINDER_SENT_FROZEN');
    expect(audit.startRun.mock.calls[0][0].nightToldLock).toBe(true);
  });

  test('only the told-lock gate on (nightLock24h off by env): no change from today in tiers mode', async () => {
    setup(30, [reminderRow(30, { reminder_72h_sent: true })]);
    process.env.GATE_NIGHT_TOLD_LOCK = 'true';
    await tiers();
    expect(skipTexts()[0]).toContain('72-hour');
    expect(audit.startRun.mock.calls[0][0].nightLock24h).toBe(false);
  });
});

// GATE_NIGHT_LOCK_24H orchestrator integration (owner 2026-11-03): with the
// gate on (config.nightLock24h, read once per run), the 04:10 night pass in
// flex mode freezes a visit only inside the 24-hour reminder's band (25 h
// flex clock) or once its 24-hour reminder was sent; the 72-hour reminder
// locks nothing. Gate off is the 09-25 rule. Same harness as
// flex-tier-apply-recheck.test.js (heavy sub-services mocked, REAL flex-tier
// and route-tiers logic over a mocked db).
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
const changed = () => audit.logDecision.mock.calls.map((c) => c[1]).filter((d) => d.action === 'changed');
const run = (over = {}) => runAutoDispatch({ mode: 'apply', flexTierEnabled: true, ...over });

describe('flex mode, gate on (config.nightLock24h)', () => {
  test('a visit 30 h out with its 72-hour reminder sent is NOT frozen, and the move applies', async () => {
    setup(30, [reminderRow(30, { reminder_72h_sent: true }), reminderRow(30, { reminder_72h_sent: true })]);
    const res = await run({ nightLock24h: true });
    expect(res.changed).toBe(1);
    expect(apply.applyAutoDispatchMove).toHaveBeenCalledTimes(1);
    expect(changed()[0].constraints.route_tiers).toMatchObject({ mode: 'flex' });
  });

  test('the SAME visit with the gate off is frozen by that 72-hour reminder (control)', async () => {
    setup(30, [reminderRow(30, { reminder_72h_sent: true })]);
    const res = await run({ nightLock24h: false });
    expect(res.changed).toBe(0);
    expect(skipCodes()).toContain('REMINDER_SENT_FROZEN');
    expect(candidateSlots.findValidCandidateSlots).not.toHaveBeenCalled();
  });

  test('a visit 23 h out is frozen by the 24-hour band (reminder row present)', async () => {
    setup(23, [reminderRow(23, {})]);
    const res = await run({ nightLock24h: true });
    expect(res.changed).toBe(0);
    expect(skipCodes()).toContain('REMINDER_SENT_FROZEN');
    expect(candidateSlots.findValidCandidateSlots).not.toHaveBeenCalled();
  });

  test('a visit 23 h out with NO reminder row is frozen by its own schedule (WITHIN_73H code kept, text says 25-hour)', async () => {
    setup(23, []);
    const res = await run({ nightLock24h: true });
    expect(res.changed).toBe(0);
    const skipped = audit.logDecision.mock.calls.map((c) => c[1]).find((d) => d.reason_code === 'WITHIN_73H');
    expect(skipped).toBeTruthy();
    expect(skipped.reason_description).toContain('25-hour');
  });

  test('a visit 30 h out with reminder_24h_sent is frozen', async () => {
    setup(30, [reminderRow(30, { reminder_24h_sent: true })]);
    const res = await run({ nightLock24h: true });
    expect(res.changed).toBe(0);
    const skipped = audit.logDecision.mock.calls.map((c) => c[1]).find((d) => d.reason_code === 'REMINDER_SENT_FROZEN');
    expect(skipped.reason_description).toContain('24-hour reminder already sent');
  });

  test('a 24-hour reminder sent between pass 1 and the apply freezes the move', async () => {
    setup(30, [reminderRow(30, {}), reminderRow(30, { reminder_24h_sent: true })]);
    const res = await run({ nightLock24h: true });
    expect(res.changed).toBe(0);
    expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
    expect(skipCodes()).toContain('REMINDER_SENT_FROZEN');
  });

  test('the freeze boundary is 25 h on the visit\'s own schedule (24 h 30 min frozen, 26 h free)', async () => {
    setup(24.5, []);
    expect((await run({ nightLock24h: true })).changed).toBe(0);
    setup(26, []);
    expect((await run({ nightLock24h: true })).changed).toBe(1);
  });

  test('the gate is read once per run: a flip DURING the run changes nothing, and the apply config carries the run\'s value', async () => {
    setup(30, [reminderRow(30, { reminder_72h_sent: true }), reminderRow(30, { reminder_72h_sent: true })]);
    process.env.GATE_NIGHT_LOCK_24H = 'true';
    candidateSlots.findValidCandidateSlots.mockImplementation(async () => {
      delete process.env.GATE_NIGHT_LOCK_24H; // kill switch pulled mid-run
      return { current: current(), candidates: [CAND] };
    });
    const res = await run();
    // Pass 2 (the apply-time recheck) still used the 24-hour rule.
    expect(res.changed).toBe(1);
    expect(candidateSlots.findValidCandidateSlots.mock.calls[0][2].nightLock24h).toBe(true);
    expect(audit.startRun.mock.calls[0][0].nightLock24h).toBe(true);
    const applyArgs = apply.applyAutoDispatchMove.mock.calls[0];
    expect(applyArgs.some((a) => a && typeof a === 'object' && a.nightLock24h === true)).toBe(true);
  });
});

describe('tiers mode follows the same reminder rule', () => {
  test('gate on: a 72-hour reminder sent no longer freezes a visit (the tier ladder decides); gate off still does', async () => {
    setup(30, [reminderRow(30, { reminder_72h_sent: true })]);
    await runAutoDispatch({ mode: 'apply', routeTiersEnabled: true, nightLock24h: true });
    expect(skipCodes()).not.toContain('REMINDER_SENT_FROZEN');
    audit.logDecision.mockClear();
    setup(30, [reminderRow(30, { reminder_72h_sent: true })]);
    await runAutoDispatch({ mode: 'apply', routeTiersEnabled: true, nightLock24h: false });
    expect(skipCodes()).toContain('REMINDER_SENT_FROZEN');
    audit.logDecision.mockClear();
    setup(30, [reminderRow(30, { reminder_24h_sent: true })]);
    await runAutoDispatch({ mode: 'apply', routeTiersEnabled: true, nightLock24h: true });
    expect(skipCodes()).toContain('REMINDER_SENT_FROZEN');
  });
});

describe('gate off: the 09-25 rule is untouched', () => {
  test('a visit 30 h out is still frozen (73-hour rule); the run records nightLock24h false', async () => {
    setup(30, [reminderRow(30, {})]);
    const res = await run();
    expect(res.changed).toBe(0);
    expect(skipCodes()).toContain('REMINDER_SENT_FROZEN'); // the 30 h row sits inside the 73 h band
    expect(audit.startRun.mock.calls[0][0].nightLock24h).toBe(false);
  });

  test('describeGuardRule words the rule for the mode in force', () => {
    const { describeGuardRule } = _internals;
    expect(describeGuardRule('flex', 'x', '2026-11-10')).toBe('flex: frozen under 73h, day moves on or after 2026-11-15');
    expect(describeGuardRule('flex', 'x', '2026-11-10', true)).toBe('flex: frozen under 25h, day moves on or after 2026-11-15');
    expect(describeGuardRule('tiers', 'x', '2026-11-10')).toBe('tiers: day moves from 7 days out');
    expect(describeGuardRule('tiers', 'x', '2026-11-10', true)).toBe('tiers: day moves from 7 days out, frozen under 24h');
    expect(describeGuardRule('legacy', '2026-11-24', '2026-11-10', true)).toBe('lock>2026-11-24');
  });
});

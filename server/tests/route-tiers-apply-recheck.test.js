// ROUTE-TIERS orchestrator integration (gate ON): the pass-2 apply path must
// re-check the reminder freeze right before mutating — a 72h reminder sent
// between the pass-1 sweep and the apply must freeze the move, and an
// unreadable re-check fails closed. Uses the orchestrator harness with the
// heavy sub-services mocked and REAL route-tiers logic over a mocked db.
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
jest.mock('../services/auto-dispatch/apply', () => ({ applyAutoDispatchMove: jest.fn(), revalidatePlacement: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/geocoder', () => ({ ensureCustomerGeocoded: jest.fn() }));
jest.mock('../services/auto-dispatch/audit', () => ({
  startRun: jest.fn(async () => 'run1'),
  logDecision: jest.fn(async () => {}),
  completeRun: jest.fn(async () => {}),
}));

const db = require('../models/db');
const candidateSlots = require('../services/auto-dispatch/candidate-slots');
const apply = require('../services/auto-dispatch/apply');
const audit = require('../services/auto-dispatch/audit');
const { shiftDateStr } = require('../services/auto-dispatch/dates');
const { etDateString } = require('../utils/datetime-et');
const { runAutoDispatch } = require('../services/auto-dispatch');

// Dates are relative to the REAL clock because the orchestrator derives
// "today" itself: a tier-1 visit 20 days out, moved 2 days later.
const TODAY = etDateString(new Date());
const VISIT_DATE = shiftDateStr(TODAY, 20);
const CAND_DATE = shiftDateStr(TODAY, 22);

function buildChain(result) {
  const chain = {};
  const methods = ['leftJoin', 'where', 'whereIn', 'whereNot', 'whereNotIn', 'whereNull', 'whereNotNull',
    'orWhere', 'orWhereNull', 'orWhereNotNull', 'select', 'orderBy', 'limit', 'first', 'returning', 'count'];
  methods.forEach((m) => { chain[m] = (...args) => { args.forEach((a) => { if (typeof a === 'function') a.call(chain); }); return chain; }; });
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function svc() {
  return {
    id: 's1', customer_id: 'c1', is_recurring: true, recurring_parent_id: 'p1',
    status: 'confirmed', scheduled_date: VISIT_DATE, technician_id: 't1',
    window_start: '09:00', window_end: '11:00', auto_dispatch_change_count: 0,
  };
}

const CURRENT = { is_current: true, detour_minutes: 40, stops_that_day: 3, technician_id: 't1', date: VISIT_DATE, start_time: '09:00', capability_level: 'qualified' };
const CAND = { is_current: false, detour_minutes: 0, stops_that_day: 5, technician_id: 't1', date: CAND_DATE, start_time: '08:00', end_time: '09:00', capability_level: 'qualified', total_drive_minutes: 10 };

let reminderResults; // consumed per appointment_reminders query, in order

beforeEach(() => {
  jest.clearAllMocks();
  process.env.AUTO_DISPATCH_ALLOW_APPLY = 'true';
  reminderResults = [];
  db.mockImplementation((table) => {
    if (table === 'appointment_reminders') {
      const next = reminderResults.length ? reminderResults.shift() : [];
      if (next instanceof Error) {
        const c = buildChain([]);
        c.then = (resolve, reject) => Promise.reject(next).then(resolve, reject);
        return c;
      }
      return buildChain(next);
    }
    if (table === 'scheduled_services') return buildChain([svc()]);
    return buildChain([]); // capabilities, reschedule_log, audit logs, alerts…
  });
  candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [CAND] });
  apply.applyAutoDispatchMove.mockResolvedValue({ ok: true, pre_status: 'confirmed', post_status: 'confirmed' });
  apply.revalidatePlacement.mockResolvedValue({ ok: true });
});

afterAll(() => { delete process.env.AUTO_DISPATCH_ALLOW_APPLY; });

function decisions(action) {
  return audit.logDecision.mock.calls.map((c) => c[1]).filter((d) => d.action === action);
}

test('clean freeze state both times ⇒ the tiered move applies', async () => {
  reminderResults = [[], []]; // pass-1 bulk read, pass-2 apply re-check
  const res = await runAutoDispatch({ mode: 'apply', routeTiersEnabled: true });
  expect(res.changed).toBe(1);
  expect(apply.applyAutoDispatchMove).toHaveBeenCalledTimes(1);
  // The tier window was threaded through to the audit constraints.
  const changed = decisions('changed')[0];
  expect(changed.constraints.route_tiers).toMatchObject({ radius: 5, anchor: VISIT_DATE, drift_budget_days: 5 });
});

test('a 72h reminder sent between pass 1 and the apply freezes the move', async () => {
  reminderResults = [
    [], // pass-1: clean
    [{ scheduled_service_id: 's1', customer_id: 'c1', appointment_time: `${VISIT_DATE}T09:00:00Z`, reminder_72h_sent: true, suppressed_by_sibling: false }], // apply re-check: sent
  ];
  const res = await runAutoDispatch({ mode: 'apply', routeTiersEnabled: true });
  expect(res.changed).toBe(0);
  expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
  expect(decisions('no_change').map((d) => d.reason_code)).toContain('REMINDER_SENT_FROZEN');
});

test('an unreadable apply-time re-check fails closed (no move)', async () => {
  reminderResults = [[], new Error('db down')];
  const res = await runAutoDispatch({ mode: 'apply', routeTiersEnabled: true });
  expect(res.changed).toBe(0);
  expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
  expect(decisions('no_change').map((d) => d.reason_code)).toContain('REMINDER_STATUS_UNKNOWN');
});

test('a run crossing ET midnight recomputes the tier window before applying', async () => {
  reminderResults = [[], []];
  // Visit 8 days out at pass 1. Between scoring and apply the clock jumps 2
  // days (simulated via the candidate-slots mock's side effect), so at apply
  // time the visit is 6 days out — tier 3, no day-moves. The pass-2 recompute
  // must refuse the move.
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  try {
    jest.setSystemTime(new Date('2026-08-13T08:10:00Z'));
    const visitDate = shiftDateStr(etDateString(new Date()), 8);
    const candDate = shiftDateStr(visitDate, 2);
    db.mockImplementation((table) => {
      if (table === 'appointment_reminders') return buildChain([]);
      if (table === 'scheduled_services') return buildChain([{ ...svc(), scheduled_date: visitDate }]);
      return buildChain([]);
    });
    candidateSlots.findValidCandidateSlots.mockImplementation(async () => {
      // Advance the wall clock 2 days during the "long scoring pass".
      jest.setSystemTime(new Date('2026-08-15T08:10:00Z'));
      return {
        current: { ...CURRENT, date: visitDate },
        candidates: [{ ...CAND, date: candDate }],
      };
    });
    const res = await runAutoDispatch({ mode: 'apply', routeTiersEnabled: true });
    expect(res.changed).toBe(0);
    expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
    expect(decisions('no_change').map((d) => d.reason_code)).toContain('TIER_LOCKED');
  } finally {
    jest.useRealTimers();
  }
});

test('a pass-1 frozen visit never reaches scoring at all', async () => {
  reminderResults = [
    [{ scheduled_service_id: 's1', customer_id: 'c1', appointment_time: `${VISIT_DATE}T09:00:00Z`, reminder_72h_sent: true, suppressed_by_sibling: false }],
  ];
  const res = await runAutoDispatch({ mode: 'apply', routeTiersEnabled: true });
  expect(res.changed).toBe(0);
  expect(candidateSlots.findValidCandidateSlots).not.toHaveBeenCalled();
  expect(decisions('skipped').map((d) => d.reason_code)).toContain('REMINDER_SENT_FROZEN');
});

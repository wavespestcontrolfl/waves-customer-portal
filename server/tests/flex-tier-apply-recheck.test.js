// FLEX-TIER orchestrator integration (GATE_AUTO_DISPATCH_FLEX_TIER on): the
// pass-1 sweep uses the 73h freeze + the fixed ±5-day radius (never the
// route-tiers days-out ladder), and the pass-2 apply path re-checks that
// freeze right before mutating. Mirrors route-tiers-apply-recheck.test.js's
// harness (heavy sub-services mocked, REAL flex-tier logic over a mocked db).
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

const TODAY = etDateString(new Date());
// 20 days out, same fixture shape as route-tiers-apply-recheck.test.js, but
// the Flexible tier's window is a flat ±5 days (never a days-out ladder), so
// the candidate must land inside orig±5, not merely inside the lookahead.
const VISIT_DATE = shiftDateStr(TODAY, 20);
const CAND_DATE = shiftDateStr(TODAY, 22);

function buildChain(result) {
  const chain = {};
  const methods = ['leftJoin', 'where', 'whereIn', 'whereNot', 'whereNotIn', 'whereNull', 'whereNotNull',
    'orWhere', 'orWhereIn', 'orWhereNull', 'orWhereNotNull', 'select', 'orderBy', 'orderByRaw', 'limit', 'first', 'returning', 'count'];
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
    // Series-neighbor evidence (loadSeriesNeighbors) also reads
    // scheduled_services — no other occurrence in range by default, so the
    // Flexible-tier window is unconstrained by the occurrence guard.
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

test('clean freeze state both times ⇒ the flex-tier move applies through the SAME apply path as route-tiers', async () => {
  reminderResults = [[], []]; // pass-1 bulk read, pass-2 apply re-check
  const res = await runAutoDispatch({ mode: 'apply', flexTierEnabled: true });
  expect(res.changed).toBe(1);
  // Reuses apply.js's applyAutoDispatchMove unchanged — no flex-specific
  // notification path exists or is needed (apply.js's own suite already
  // proves that call sends AppointmentReminders.handleReschedule with
  // sendNotification:false; this test proves flex-tier reaches that SAME
  // call, not a new one).
  expect(apply.applyAutoDispatchMove).toHaveBeenCalledTimes(1);
  const changed = decisions('changed')[0];
  expect(changed.constraints.route_tiers).toMatchObject({ mode: 'flex', radius_days: 5 });
});

test('a grouped move the member guard would refuse is neither recommended nor planned (Codex #4995 r4 P2)', async () => {
  apply.previewGroupMove.mockResolvedValue({ code: 'GROUP_MEMBER_GUARD', description: 'Grouped visit would be refused at apply — sibling inside 73 hours' });
  reminderResults = [[]];
  const dry = await runAutoDispatch({ mode: 'dry_run', flexTierEnabled: true });
  expect(dry.recommended).toBe(0);
  expect(decisions('no_change').map((d) => d.reason_code)).toContain('GROUP_MEMBER_GUARD');
  expect(apply.previewGroupMove).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }), CAND, expect.objectContaining({ guardMode: 'flex' }));

  audit.logDecision.mockClear();
  reminderResults = [[]];
  const res = await runAutoDispatch({ mode: 'apply', flexTierEnabled: true });
  expect(res.changed).toBe(0);
  expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
  apply.previewGroupMove.mockResolvedValue(null);
});

test('an unreadable canonical arrival refuses the move AND degrades the run — never a silent 73h skip (Codex #4995 r5 P2)', async () => {
  reminderResults = [[]];
  const stamped = {
    ...svc(), reservation_service_mix: { allocatedServiceIds: ['s0', 's1'], scheduledDate: VISIT_DATE, arrivalWindowStart: '09:00' },
  };
  db.mockImplementation((table) => {
    if (table === 'appointment_reminders') return buildChain(reminderResults.length ? reminderResults.shift() : []);
    if (table === 'scheduled_services') return buildChain([stamped]);
    return buildChain([]);
  });
  db.raw = jest.fn(async () => { throw new Error('function reservation_arrival_start(uuid) does not exist'); });
  try {
    const res = await runAutoDispatch({ mode: 'apply', flexTierEnabled: true });
    expect(res.changed).toBe(0);
    expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
    expect(res.status).toBe('completed_with_errors');
    expect(decisions('skipped').map((d) => d.reason_code)).not.toContain('WITHIN_73H');
    expect(decisions('failed')).toHaveLength(1);
  } finally {
    delete db.raw;
  }
});

test('route tiers never run the flex group preview (gate-off behavior unchanged)', async () => {
  reminderResults = [[], []];
  await runAutoDispatch({ mode: 'apply', routeTiersEnabled: true });
  expect(apply.previewGroupMove).not.toHaveBeenCalled();
});

test('flexTierEnabled takes precedence when routeTiersEnabled is also on', async () => {
  reminderResults = [[], []];
  const res = await runAutoDispatch({ mode: 'apply', flexTierEnabled: true, routeTiersEnabled: true });
  expect(res.changed).toBe(1);
  const changed = decisions('changed')[0];
  expect(changed.constraints.route_tiers.mode).toBe('flex'); // not 'tiers'
});

test('a reminder sent between pass 1 and the apply freezes the move (73h band)', async () => {
  reminderResults = [
    [], // pass-1: clean
    [{ scheduled_service_id: 's1', customer_id: 'c1', appointment_time: `${VISIT_DATE}T09:00:00Z`, reminder_72h_sent: true, suppressed_by_sibling: false }], // apply re-check: sent
  ];
  const res = await runAutoDispatch({ mode: 'apply', flexTierEnabled: true });
  expect(res.changed).toBe(0);
  expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
  expect(decisions('no_change').map((d) => d.reason_code)).toContain('REMINDER_SENT_FROZEN');
});

test('a visit inside the 73h band but outside route-tiers\' own 72.25h band is still frozen at pass 1', async () => {
  // 73h out: unsent flag, but the row sits inside the Flexible tier's OWN
  // (tighter) claimable band — must freeze even though it is outside the
  // narrower 72.25h band route-tiers itself uses.
  const at73h = new Date(Date.now() + 73 * 3600000).toISOString();
  reminderResults = [
    [{ scheduled_service_id: 's1', customer_id: 'c1', appointment_time: at73h, reminder_72h_sent: false, suppressed_by_sibling: false }],
  ];
  const res = await runAutoDispatch({ mode: 'apply', flexTierEnabled: true });
  expect(res.changed).toBe(0);
  expect(candidateSlots.findValidCandidateSlots).not.toHaveBeenCalled();
  expect(decisions('skipped').map((d) => d.reason_code)).toContain('REMINDER_SENT_FROZEN');
});

test('an unreadable apply-time re-check fails closed (no move) and degrades run status', async () => {
  reminderResults = [[], new Error('db down')];
  const res = await runAutoDispatch({ mode: 'apply', flexTierEnabled: true });
  expect(res.changed).toBe(0);
  expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
  expect(decisions('no_change').map((d) => d.reason_code)).toContain('REMINDER_STATUS_UNKNOWN');
  expect(res.status).toBe('completed_with_errors');
});

test('a failed pass-1 bulk guard read freezes everything AND degrades run status', async () => {
  reminderResults = [new Error('db down')];
  const res = await runAutoDispatch({ mode: 'apply', flexTierEnabled: true });
  expect(res.changed).toBe(0);
  expect(res.status).toBe('completed_with_errors');
  expect(decisions('skipped').map((d) => d.reason_code)).toContain('REMINDER_STATUS_UNKNOWN');
});

test('the series occurrence guard clamps the candidate window (a next occurrence inside ±5 days)', async () => {
  reminderResults = [[], []];
  const nextOccurrence = shiftDateStr(VISIT_DATE, 3); // inside the ±5 radius
  let scheduledServicesCalls = 0;
  db.mockImplementation((table) => {
    if (table === 'appointment_reminders') return buildChain(reminderResults.length ? reminderResults.shift() : []);
    if (table === 'scheduled_services') {
      scheduledServicesCalls++;
      // 1st call: loadEligibleServices (the eligible set for this run — just
      // the tapped visit). 2nd+: loadSeriesNeighbors' per-series read, which
      // must see the sibling occurrence to clamp the guard.
      if (scheduledServicesCalls === 1) return buildChain([svc()]);
      return buildChain([svc(), { id: 's2', recurring_parent_id: 'p1', scheduled_date: nextOccurrence, status: 'confirmed' }]);
    }
    return buildChain([]);
  });
  // The candidate the finder proposes sits PAST the next occurrence — a
  // placement the writer/finder itself would never offer once wired end to
  // end, but this unit exercises that the guard is what THREADS the clamp
  // into ctx.tierWindow (candidate-slots.js is mocked here, so it does not
  // itself filter): the audit constraints must show the clamped window.
  const res = await runAutoDispatch({ mode: 'apply', flexTierEnabled: true });
  expect(res.changed).toBe(1); // the (mocked) finder is not itself clamped in this harness
  const changed = decisions('changed')[0];
  expect(changed.constraints.route_tiers.window.dateTo).toBe(shiftDateStr(nextOccurrence, -1));
});

test('an apply-time series-neighbor read failure refuses the move AND degrades the run (Codex #4995 r6 P2)', async () => {
  reminderResults = [[], []];
  let scheduledServicesCalls = 0;
  db.mockImplementation((table) => {
    if (table === 'appointment_reminders') return buildChain(reminderResults.length ? reminderResults.shift() : []);
    if (table === 'scheduled_services') {
      scheduledServicesCalls++;
      // 1st: loadEligibleServices; 2nd: pass 1's bulk neighbor read (clean);
      // 3rd: the apply-time recheck's fresh neighbor read — which fails.
      if (scheduledServicesCalls === 3) {
        const c = buildChain([]);
        c.then = (resolve, reject) => Promise.reject(new Error('db down')).then(resolve, reject);
        return c;
      }
      return buildChain([svc()]);
    }
    return buildChain([]);
  });
  const res = await runAutoDispatch({ mode: 'apply', flexTierEnabled: true });
  expect(res.changed).toBe(0);
  expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
  expect(decisions('no_change').map((d) => d.reason_code)).toContain('SERIES_NEIGHBORS_UNKNOWN');
  expect(res.status).toBe('completed_with_errors');
});

test('same-day re-time is inside the window (never excluded)', async () => {
  reminderResults = [[], []];
  const sameDayCand = { ...CAND, date: VISIT_DATE, start_time: '13:00', end_time: '14:00' };
  candidateSlots.findValidCandidateSlots.mockResolvedValue({ current: CURRENT, candidates: [sameDayCand] });
  const res = await runAutoDispatch({ mode: 'apply', flexTierEnabled: true });
  expect(res.changed).toBe(1);
  const changed = decisions('changed')[0];
  expect(changed.newPlacement.date).toBe(VISIT_DATE);
  expect(changed.constraints.route_tiers.window.dateFrom <= VISIT_DATE).toBe(true);
  expect(changed.constraints.route_tiers.window.dateTo >= VISIT_DATE).toBe(true);
});

test('gate off (neither flexTierEnabled nor routeTiersEnabled): legacy flat lock, no tier window in the audit', async () => {
  reminderResults = [];
  const res = await runAutoDispatch({ mode: 'apply' });
  expect(res.changed).toBe(1);
  const changed = decisions('changed')[0];
  expect(changed.constraints.route_tiers).toBeUndefined();
});

// Codex pre-push P1, finding 1: loadReminderFreeze reports an EMPTY frozen
// set for a visit with NO appointment_reminders row at all (not "sent",
// just absent) — and the flex ctx removed eligibility.js's own days-out
// lock, so a visit due inside 73h with no reminder row yet must still be
// caught, directly from its own schedule, at BOTH pass 1 and the apply-time
// recheck.
describe('own-schedule 73h freeze — independent of reminder evidence (Codex pre-push P1)', () => {
  const soonDate = shiftDateStr(TODAY, 2); // ~48h out — inside 73h, well outside the lookahead-irrelevant range
  function soonSvc() {
    return { ...svc(), scheduled_date: soonDate };
  }

  test('pass 1: skipped as WITHIN_73H even though the reminder-freeze read is a clean empty set (no row)', async () => {
    reminderResults = [[]]; // no appointment_reminders row for this service at all
    db.mockImplementation((table) => {
      if (table === 'appointment_reminders') return buildChain(reminderResults.length ? reminderResults.shift() : []);
      if (table === 'scheduled_services') return buildChain([soonSvc()]);
      return buildChain([]);
    });
    const res = await runAutoDispatch({ mode: 'apply', flexTierEnabled: true });
    expect(res.changed).toBe(0);
    expect(candidateSlots.findValidCandidateSlots).not.toHaveBeenCalled();
    expect(decisions('skipped').map((d) => d.reason_code)).toContain('WITHIN_73H');
  });

  test('apply-time recheck: a visit that DRIFTS inside 73h during a slow scoring pass is caught independently of the reminder table', async () => {
    // The visit is >73h out when pass 1 reads the clock, but the "scoring
    // pass" (candidate-slots mock) advances the wall clock far enough that
    // by the apply-time recheck it is inside 73h — recheckDayMoveWindow's
    // own-schedule check must catch it even with a clean (empty) reminder
    // read both times.
    reminderResults = [[], []];
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      jest.setSystemTime(new Date('2026-08-13T08:00:00Z'));
      const visitDate = shiftDateStr(etDateString(new Date()), 4); // ~96h out — outside 73h at pass 1
      db.mockImplementation((table) => {
        if (table === 'appointment_reminders') return buildChain(reminderResults.length ? reminderResults.shift() : []);
        if (table === 'scheduled_services') return buildChain([{ ...svc(), scheduled_date: visitDate, window_start: '08:00' }]);
        return buildChain([]);
      });
      candidateSlots.findValidCandidateSlots.mockImplementation(async () => {
        // Advance the wall clock ~26h during the "long scoring pass" — the
        // visit (still at its own original date/window) is now inside 73h.
        jest.setSystemTime(new Date('2026-08-14T13:00:00Z'));
        return {
          current: { ...CURRENT, date: visitDate }, candidates: [{ ...CAND, date: shiftDateStr(visitDate, 1) }],
        };
      });
      const res = await runAutoDispatch({ mode: 'apply', flexTierEnabled: true });
      expect(res.changed).toBe(0);
      expect(apply.applyAutoDispatchMove).not.toHaveBeenCalled();
      expect(decisions('no_change').map((d) => d.reason_code)).toContain('WITHIN_73H');
    } finally {
      jest.useRealTimers();
    }
  });
});

// Outbound-callback booking legacy-row compatibility. The office-review hold
// was removed 2026-08-11 (owner directive): new outbound bookings land live
// via the normal ai_call_pipeline path. The distinct source_action marker,
// triage lane, and confirm hook remain so rows created PENDING before the
// removal still confirm cleanly (arm reminders, convert the lead, resolve
// their card). These verify that legacy machinery.
jest.mock('../models/db', () => jest.fn());
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/dispatch-alerts', () => ({ autoResolveOverdueAlertsForJob: jest.fn(async () => {}) }));
jest.mock('../services/appointment-reminders', () => ({ registerAppointment: jest.fn(async () => ({})) }));
jest.mock('../services/call-recording-processor', () => ({ convertCallLeadOnPhoneBooking: jest.fn(async () => true) }));
jest.mock('../services/inspection-credit', () => ({
  markBookingForInspectionCredit: jest.fn(async () => 1),
  redeemInspectionCreditForBooking: jest.fn(async () => ({})),
}));
jest.mock('../services/appointment-card-request', () => ({ requestCardForAppointment: jest.fn(async () => ({ requested: false })) }));

const { buildTriageItem } = require('../services/call-routing-gates');
const {
  CALL_OUTBOUND_REVIEW_SOURCE_ACTION,
  CALL_FOLLOWUP_SOURCE_ACTION,
  DISPATCH_OWNED_PENDING_SOURCE_ACTIONS,
  isPendingOutboundReviewBooking,
} = require('../services/call-booking-source-actions');
const {
  runOutboundReviewConfirmHook,
  activateLegacyOutboundReviewRowIfNeeded,
  sweepStrandedLegacyOutboundActivations,
} = require('../services/outbound-review-confirm');
const { transitionJobStatus } = require('../services/job-status');
const AppointmentReminders = require('../services/appointment-reminders');
const { convertCallLeadOnPhoneBooking } = require('../services/call-recording-processor');
const { requestCardForAppointment } = require('../services/appointment-card-request');

describe('outbound review booking — shared source-action markers', () => {
  test('the outbound-review marker is a distinct, stable string that fits source_action', () => {
    expect(CALL_OUTBOUND_REVIEW_SOURCE_ACTION).toBe('ai_call_outbound_review');
    expect(CALL_OUTBOUND_REVIEW_SOURCE_ACTION).not.toBe(CALL_FOLLOWUP_SOURCE_ACTION);
    // scheduled_services.source_action is varchar(30) — the marker MUST fit or
    // the pending-booking insert fails (value too long).
    expect(CALL_OUTBOUND_REVIEW_SOURCE_ACTION.length).toBeLessThanOrEqual(30);
    expect(CALL_FOLLOWUP_SOURCE_ACTION.length).toBeLessThanOrEqual(30);
  });

  test('dispatch-owned pending set covers BOTH the follow-up and outbound-review markers', () => {
    // The customer self-service routes (schedule.js) hide/refuse every marker in
    // this set until the office confirms — so both must be present.
    expect(DISPATCH_OWNED_PENDING_SOURCE_ACTIONS).toEqual(
      expect.arrayContaining([CALL_FOLLOWUP_SOURCE_ACTION, CALL_OUTBOUND_REVIEW_SOURCE_ACTION]),
    );
  });
});

describe('outbound review booking — triage lane', () => {
  test('outbound_booking_review maps to the time_ambiguous review lane', () => {
    const item = buildTriageItem({
      callLogId: 'c1',
      flag: 'outbound_booking_review',
      extraction: { meta: {} },
      severity: 'advisory',
    });
    expect(item.category).toBe('time_ambiguous');
    expect(item.reason_code).toBe('outbound_booking_review');
  });
});

describe('outbound review booking — originating lead carried on the card', () => {
  test('the review card payload carries lead_id + the booking-time quote flag', () => {
    // The booking can reuse an existing UNCLAIMED phone lead that never gets
    // customer_id stamped — the confirm hook's customer_id lookup alone would
    // miss it, so the insert path stashes the exact lead id on the card.
    const item = buildTriageItem({
      callLogId: 'c1',
      flag: 'outbound_booking_review',
      extraction: { meta: {} },
      severity: 'advisory',
      extraPayload: { lead_id: 'lead-9', keep_open_for_quote: true },
    });
    const payload = JSON.parse(item.payload);
    expect(payload.lead_id).toBe('lead-9');
    expect(payload.keep_open_for_quote).toBe(true);
  });
});

describe('transitionJobStatus — legacy pending review rows activate lazily', () => {
  test('pending outbound-review row → en_route stamps customer_confirmed and runs the confirm hook post-commit', async () => {
    // Rows created PENDING before the review-hold removal must not go
    // operational half-armed (Codex #3361 P0): the shared writer DETECTS
    // the legacy row in the transition trx and delegates activation to the
    // hook-first helper post-commit (Codex r4 P1 — stamp only after the
    // core legs succeed, so failures stay retryable). Reminder arming and
    // the customer_confirmed stamp are asserted as the observable legs.
    const legacyRow = {
      id: 'svc1',
      source_action: CALL_OUTBOUND_REVIEW_SOURCE_ACTION,
      status: 'pending',
      customer_confirmed: false,
      customer_id: 'cust1',
      scheduled_date: '2026-08-11',
      window_start: '09:00',
      service_type: 'pest_control',
      source_call_log_id: null,
      is_callback: false,
      estimated_price: 100,
    };
    const updates = [];
    const makeChain = (table) => {
      const q = {};
      ['where', 'whereNot', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'orWhere', 'whereRaw',
        'leftJoin', 'orderBy', 'limit', 'modify'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.select = jest.fn(async () => []);
      q.first = jest.fn(async () => {
        if (table === 'scheduled_services') return { ...legacyRow };
        if (table === 'scheduled_services as s') {
          return {
            job_id: 'svc1', customer_id: 'cust1', tech_id: null, service_type: 'pest_control',
            scheduled_date: '2026-08-11', window_start: '09:00', window_end: null,
            notes: null, internal_notes: null, updated_at: new Date(),
          };
        }
        return null;
      });
      q.update = jest.fn(async (vals) => { updates.push({ table, vals }); return 1; });
      q.insert = jest.fn(async () => 1);
      q.del = jest.fn(async () => 1);
      return q;
    };
    const trx = jest.fn((table) => makeChain(table));
    trx.transaction = async (cb) => cb(trx);
    trx.fn = { now: () => new Date() };
    trx.raw = jest.fn(() => ({}));
    trx.executionPromise = Promise.resolve();
    // The post-commit activation runs on the module-level db handle (not
    // the trx) — give it the same table-aware chain.
    const db = require('../models/db');
    db.mockImplementation((table) => makeChain(table));
    db.transaction = async (cb) => cb(db);
    db.fn = { now: () => new Date() };
    db.raw = jest.fn(() => ({}));

    await transitionJobStatus({
      jobId: 'svc1', fromStatus: 'pending', toStatus: 'en_route', transitionedBy: 'tech1', trx,
    });
    // The activation hook fires on executionPromise.then, fire-and-forget —
    // flush the microtask queue before asserting.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const confirmStamp = updates.find((u) => u.table === 'scheduled_services' && u.vals.customer_confirmed === true);
    expect(confirmStamp).toBeTruthy();
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalledWith(
      'svc1', 'cust1', '2026-08-11T09:00', 'pest_control', 'admin_manual', { sendConfirmation: false, closeReminderWindows: false },
    );
  });
});

describe('activateLegacyOutboundReviewRowIfNeeded — direct-writer belt', () => {
  // The reschedule writers (SmartRebooker, update-details, the shared
  // notice sender) bypass transitionJobStatus — this helper is their
  // activation seam for legacy pending review rows (Codex #3361 r2 P0).
  const makeDb = (row, { stampRows = 1 } = {}) => {
    const state = { updates: [] };
    const fn = (table) => {
      const q = {};
      ['where', 'whereNotIn', 'whereNull', 'whereIn', 'orderBy', 'limit'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.first = jest.fn(async () => (table === 'scheduled_services' ? row : null));
      q.select = jest.fn(async () => []);
      q.update = jest.fn(async (vals) => { state.updates.push({ table, vals }); return table === 'scheduled_services' ? stampRows : 1; });
      return q;
    };
    fn.fn = { now: () => new Date() };
    fn.transaction = async (cb) => cb(fn);
    fn.raw = jest.fn(async () => ({}));
    fn._state = state;
    return fn;
  };
  const legacyRow = {
    id: 'svc1',
    source_action: CALL_OUTBOUND_REVIEW_SOURCE_ACTION,
    status: 'pending',
    customer_confirmed: false,
    customer_id: 'cust1',
    scheduled_date: '2026-08-12',
    window_start: '09:00',
    service_type: 'pest_control',
    source_call_log_id: null,
    is_callback: false,
    estimated_price: 100,
  };

  beforeEach(() => jest.clearAllMocks());

  test('activates a legacy pending row: stamps customer_confirmed and runs the confirm hook', async () => {
    const db = makeDb({ ...legacyRow });
    const activated = await activateLegacyOutboundReviewRowIfNeeded(db, 'svc1', 'test');
    expect(activated).toBe(true);
    expect(db._state.updates.some((u) => u.table === 'scheduled_services' && u.vals.customer_confirmed === true)).toBe(true);
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalledWith(
      'svc1', 'cust1', '2026-08-12T09:00', 'pest_control', 'admin_manual', { sendConfirmation: false, closeReminderWindows: false },
    );
  });

  test('no-ops for a non-review row and for an already-confirmed row', async () => {
    expect(await activateLegacyOutboundReviewRowIfNeeded(
      makeDb({ ...legacyRow, source_action: 'ai_call_pipeline' }), 'svc1', 'test',
    )).toBe(false);
    expect(await activateLegacyOutboundReviewRowIfNeeded(
      makeDb({ ...legacyRow, customer_confirmed: true }), 'svc1', 'test',
    )).toBe(false);
    expect(AppointmentReminders.registerAppointment).not.toHaveBeenCalled();
  });

  test('a lost stamp race (0 rows) reports false — hook legs ran but are idempotent by contract', async () => {
    // Hook-first, stamp-on-success (Codex #3361 r3 P1): the loser of the
    // stamp race has already run the idempotent hook legs; the guarded
    // UPDATE keeps the stamp itself at-most-once.
    const db = makeDb({ ...legacyRow }, { stampRows: 0 });
    expect(await activateLegacyOutboundReviewRowIfNeeded(db, 'svc1', 'test')).toBe(false);
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalled();
  });

  test('the hourly sweep activates a worked-but-unstamped legacy row (durable retry, Codex r5 P1)', async () => {
    const state = { updates: [] };
    const workedRow = { ...legacyRow, status: 'completed' };
    const fn = (table) => {
      const q = {};
      ['where', 'whereNot', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'orWhere',
        'whereRaw', 'orderBy', 'limit', 'modify', 'leftJoin'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.select = jest.fn(async (col) => (table === 'scheduled_services' && col === 'id' ? [{ id: 'svc1' }] : []));
      q.first = jest.fn(async () => (table === 'scheduled_services' ? { ...workedRow } : null));
      q.update = jest.fn(async (vals) => { state.updates.push({ table, vals }); return 1; });
      q.insert = jest.fn(async () => 1);
      q.del = jest.fn(async () => 1);
      return q;
    };
    fn.fn = { now: () => new Date() };
    fn.transaction = async (cb) => cb(fn);
    fn.raw = jest.fn(async () => ({}));

    const result = await sweepStrandedLegacyOutboundActivations(fn, { limit: 5 });
    expect(result).toEqual({ candidates: 1, activated: 1 });
    expect(state.updates.some((u) => u.table === 'scheduled_services' && u.vals.customer_confirmed === true)).toBe(true);
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalled();
  });
});

// A hand-built knex-ish db mock for the confirm hook: table-aware first()/
// select()/update() so the triage-payload path and the fallback lead lookup
// can be exercised independently.
function confirmHookDb({ cardPayload = null, fallbackLeads = [], leadRow = null } = {}) {
  const state = { triageResolved: false };
  const fn = (table) => {
    const q = {};
    ['where', 'whereNotIn', 'whereNull', 'whereIn', 'orderBy', 'limit'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.select = jest.fn(async () => fallbackLeads);
    q.first = jest.fn(async () => {
      if (table === 'triage_items') return cardPayload ? { payload: JSON.stringify(cardPayload) } : null;
      if (table === 'leads') return leadRow;
      return null;
    });
    q.update = jest.fn(async () => { if (table === 'triage_items') state.triageResolved = true; return 1; });
    return q;
  };
  fn.fn = { now: () => new Date() };
  // Same-conn transaction passthrough + raw — the triage resolver now runs
  // inside a transaction that takes the shared per-call advisory lock.
  fn.transaction = async (cb) => cb(fn);
  fn.raw = jest.fn(async () => ({}));
  fn._state = state;
  return fn;
}

describe('runOutboundReviewConfirmHook — shared confirm side effects', () => {
  const svc = {
    id: 'svc1',
    customer_id: 'cust1',
    scheduled_date: '2026-07-14',
    window_start: '09:00',
    service_type: 'pest_control',
    source_call_log_id: 'call1',
  };

  beforeEach(() => jest.clearAllMocks());

  test('converts the ORIGINATING lead from the card payload (a reused unclaimed lead has no customer_id)', async () => {
    const db = confirmHookDb({
      cardPayload: { lead_id: 'lead-9', keep_open_for_quote: true },
      leadRow: { status: 'new' },
    });
    await runOutboundReviewConfirmHook(db, svc, 'test');
    expect(convertCallLeadOnPhoneBooking).toHaveBeenCalledWith(db, expect.objectContaining({
      leadId: 'lead-9',
      customerId: 'cust1',
      scheduledServiceId: 'svc1',
      keepOpenForQuote: true,
    }));
    // Reminders armed without a confirmation send; card resolved.
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalledWith(
      'svc1', 'cust1', '2026-07-14T09:00', 'pest_control', 'admin_manual', { sendConfirmation: false, closeReminderWindows: false },
    );
    expect(db._state.triageResolved).toBe(true);
  });

  test('a carried lead that moved mid-estimate stays OPEN even without the booking-time flag', async () => {
    const db = confirmHookDb({
      cardPayload: { lead_id: 'lead-9', keep_open_for_quote: false },
      leadRow: { status: 'estimate_sent' },
    });
    await runOutboundReviewConfirmHook(db, svc, 'test');
    expect(convertCallLeadOnPhoneBooking).toHaveBeenCalledWith(db, expect.objectContaining({
      leadId: 'lead-9',
      keepOpenForQuote: true,
    }));
  });

  test('pre-payload rows fall back to the single-active-lead heuristic', async () => {
    const db = confirmHookDb({ fallbackLeads: [{ id: 'lead-1', status: 'new' }] });
    await runOutboundReviewConfirmHook(db, svc, 'test');
    expect(convertCallLeadOnPhoneBooking).toHaveBeenCalledWith(db, expect.objectContaining({
      leadId: 'lead-1',
      keepOpenForQuote: false,
    }));
  });

  test('skipCardRequest:true (field confirm) skips the card-on-file leg; default keeps it', async () => {
    // Owner decision 2026-08-11: a tech-tap-confirmed booking collects the
    // card in person, so the funnel leg is skipped on the tech-track path —
    // and ONLY there; the office confirm paths keep the full funnel.
    const db = confirmHookDb({ fallbackLeads: [] });
    await runOutboundReviewConfirmHook(db, svc, 'test', { skipCardRequest: true });
    expect(requestCardForAppointment).not.toHaveBeenCalled();
    await runOutboundReviewConfirmHook(db, svc, 'test');
    expect(requestCardForAppointment).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledServiceId: 'svc1', trigger: 'outbound_review_confirm' }),
    );
  });

  test('an ambiguous fallback (two active leads) converts NOTHING', async () => {
    const db = confirmHookDb({ fallbackLeads: [{ id: 'lead-1', status: 'new' }, { id: 'lead-2', status: 'contacted' }] });
    await runOutboundReviewConfirmHook(db, svc, 'test');
    expect(convertCallLeadOnPhoneBooking).not.toHaveBeenCalled();
    // The other side effects still run.
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalled();
    expect(db._state.triageResolved).toBe(true);
  });
});

describe('isPendingOutboundReviewBooking — dispatch-implies-confirm detection', () => {
  // tech-track's en-route/on-site auto-confirm (PR #3356) keys on this
  // helper; the legacy-activation seams (PR #3361) share its condition
  // (source_action + pending + !customer_confirmed).
  const base = {
    source_action: CALL_OUTBOUND_REVIEW_SOURCE_ACTION,
    status: 'pending',
    customer_confirmed: false,
  };

  test('matches a pending, unconfirmed outbound-review row', () => {
    expect(isPendingOutboundReviewBooking(base)).toBe(true);
  });

  test('does NOT match other source_actions, non-pending status, confirmed rows, or missing rows', () => {
    expect(isPendingOutboundReviewBooking({ ...base, source_action: 'ai_call_pipeline' })).toBe(false);
    expect(isPendingOutboundReviewBooking({ ...base, source_action: CALL_FOLLOWUP_SOURCE_ACTION })).toBe(false);
    expect(isPendingOutboundReviewBooking({ ...base, status: 'confirmed' })).toBe(false);
    expect(isPendingOutboundReviewBooking({ ...base, status: 'cancelled' })).toBe(false);
    expect(isPendingOutboundReviewBooking({ ...base, customer_confirmed: true })).toBe(false);
    expect(isPendingOutboundReviewBooking(null)).toBe(false);
    expect(isPendingOutboundReviewBooking(undefined)).toBe(false);
  });
});

describe('confirm-hook reminder resync — explicit null-start guard (Codex r21 P2)', () => {
  const fs = require('fs');
  const path = require('path');

  test('handleReschedule expectGuard enforces window_start IS NULL for an asserted windowless slot', () => {
    // A date-only move observed windowless must not overwrite a
    // concurrently-assigned real window with the fabricated 09:00 fallback:
    // the guard distinguishes "windowStart key absent" (date-only check)
    // from "explicitly null" (IS NULL required).
    const reminders = fs.readFileSync(path.join(__dirname, '../services/appointment-reminders.js'), 'utf8');
    expect(reminders).toContain("Object.prototype.hasOwnProperty.call(options.expectSchedule, 'windowStart')");
    expect(reminders).toContain("else if (hasStartAssertion) q.whereNull('scheduled_services.window_start');");
  });

  test('the confirm hook passes the observed null start explicitly (not an omitted key)', () => {
    const hook = fs.readFileSync(path.join(__dirname, '../services/outbound-review-confirm.js'), 'utf8');
    expect(hook).toContain('windowStart: postSlot.window_start || null,');
  });
});

describe('live-booking confirmation — TCPA-blocked SMS email fallback (Codex r21 P1)', () => {
  const fs = require('fs');
  const path = require('path');

  test('the call pipeline flags the v2 TCPA SMS block as permanent so the default-sms channel emails instead', () => {
    // Behavior coverage lives in appointment-notification-channels.test.js
    // (deliverConfirmationByChannel smsPermanentlyBlocked cases); this pins
    // the pipeline wiring: only the TCPA gate (email still permitted) sets
    // the flag — the implied-consent non-ANI hold keeps its Needs Review
    // card instead.
    const callProc = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    expect(callProc).toContain('smsPermanentlyBlocked: v2SmsBlocked && !v2EmailBlocked,');
  });
});

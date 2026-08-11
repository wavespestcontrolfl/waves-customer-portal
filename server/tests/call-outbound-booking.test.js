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

const { buildTriageItem } = require('../services/call-routing-gates');
const {
  CALL_OUTBOUND_REVIEW_SOURCE_ACTION,
  CALL_FOLLOWUP_SOURCE_ACTION,
  DISPATCH_OWNED_PENDING_SOURCE_ACTIONS,
} = require('../services/call-booking-source-actions');
const { runOutboundReviewConfirmHook, activateLegacyOutboundReviewRowIfNeeded } = require('../services/outbound-review-confirm');
const { transitionJobStatus } = require('../services/job-status');
const AppointmentReminders = require('../services/appointment-reminders');
const { convertCallLeadOnPhoneBooking } = require('../services/call-recording-processor');

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
    // operational half-armed (Codex #3361 P0): the shared writer stamps
    // customer_confirmed in the transition trx and fires the confirm side
    // effects (reminder arming asserted here as the observable leg) after
    // commit.
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
      ['where', 'whereNot', 'whereIn', 'whereNull', 'whereNotNull', 'orWhere', 'whereRaw',
        'leftJoin', 'orderBy', 'limit', 'modify'].forEach((m) => { q[m] = jest.fn(() => q); });
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
      'svc1', 'cust1', '2026-08-11T09:00', 'pest_control', 'admin_manual', { sendConfirmation: false },
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
      'svc1', 'cust1', '2026-08-12T09:00', 'pest_control', 'admin_manual', { sendConfirmation: false },
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

  test('a lost stamp race (0 rows) skips the hook — the winner owns it', async () => {
    const db = makeDb({ ...legacyRow }, { stampRows: 0 });
    expect(await activateLegacyOutboundReviewRowIfNeeded(db, 'svc1', 'test')).toBe(false);
    expect(AppointmentReminders.registerAppointment).not.toHaveBeenCalled();
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
      'svc1', 'cust1', '2026-07-14T09:00', 'pest_control', 'admin_manual', { sendConfirmation: false },
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

  test('an ambiguous fallback (two active leads) converts NOTHING', async () => {
    const db = confirmHookDb({ fallbackLeads: [{ id: 'lead-1', status: 'new' }, { id: 'lead-2', status: 'contacted' }] });
    await runOutboundReviewConfirmHook(db, svc, 'test');
    expect(convertCallLeadOnPhoneBooking).not.toHaveBeenCalled();
    // The other side effects still run.
    expect(AppointmentReminders.registerAppointment).toHaveBeenCalled();
    expect(db._state.triageResolved).toBe(true);
  });
});

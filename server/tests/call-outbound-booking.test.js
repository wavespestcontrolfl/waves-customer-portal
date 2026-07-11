// Review-gated outbound-callback bookings (2026-07-11). A confirmed booking on
// an OUTBOUND call creates the appointment PENDING/needs-review with a distinct
// source_action so the customer can't self-confirm it, and an
// outbound_booking_review triage item for the office. These verify the shared
// markers + the triage lane; the insert-side / route filters are integration.
jest.mock('../models/db', () => jest.fn());
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/dispatch-alerts', () => ({ autoResolveOverdueAlertsForJob: jest.fn(async () => {}) }));
jest.mock('../services/appointment-reminders', () => ({ registerAppointment: jest.fn(async () => ({})) }));
jest.mock('../services/call-recording-processor', () => ({ convertCallLeadOnPhoneBooking: jest.fn(async () => true) }));

const { buildTriageItem } = require('../services/call-routing-gates');
const {
  CALL_OUTBOUND_REVIEW_SOURCE_ACTION,
  CALL_FOLLOWUP_SOURCE_ACTION,
  DISPATCH_OWNED_PENDING_SOURCE_ACTIONS,
} = require('../services/call-booking-source-actions');
const { transitionJobStatus } = require('../services/job-status');
const { runOutboundReviewConfirmHook } = require('../services/outbound-review-confirm');
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

describe('transitionJobStatus — review-booking guard is a typed conflict', () => {
  test('blocking a day-of transition on a pending review row throws OUTBOUND_REVIEW_UNCONFIRMED (not a bare Error)', async () => {
    // tech-track / dispatch / admin-schedule allow 'pending' as a source
    // status and translate this code to a 409 — a bare Error was a 500.
    const chain = {
      where: jest.fn(() => chain),
      first: jest.fn(async () => ({
        source_action: CALL_OUTBOUND_REVIEW_SOURCE_ACTION,
        status: 'pending',
        customer_confirmed: false,
      })),
    };
    const trx = jest.fn(() => chain);
    await expect(
      transitionJobStatus({ jobId: 'svc1', fromStatus: 'pending', toStatus: 'en_route', trx }),
    ).rejects.toMatchObject({ code: 'OUTBOUND_REVIEW_UNCONFIRMED' });
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

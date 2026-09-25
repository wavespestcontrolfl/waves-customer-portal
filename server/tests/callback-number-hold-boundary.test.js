/**
 * callback_number_needed hold — the single send-boundary design from codex
 * round-2 on PR #4807 (6 P1 + 1 P2 against the earlier scattered checks).
 *
 * Findings covered here:
 *   #1 — callbackNumberHoldFromRow compares TIMESTAMPS (hold_at vs
 *        cleared_at), not mere presence: a stale clearance that predates a
 *        fresh hold must not read as cleared.
 *   #3 — callbackNumberHoldActiveForVisit fails CLOSED on a read error
 *        (treats unknown as held), not open.
 *   #5 — the predicate resolves across BOTH a bare scheduledServiceId and a
 *        grouped visitId — any member of the occurrence can carry the hold.
 *   #7 — safeSendAppointment (the shared boundary for reminders,
 *        confirmation, reschedule, cancellation, no-show, series
 *        cancellation) reads metaExtra.scheduled_service_id/visit_id and
 *        refuses the send itself, so a caller that "forgot" to check
 *        (reschedule/cancellation, pre-round-2) is covered automatically.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/customer-contact', () => ({
  getAppointmentContacts: jest.fn((customer) => (customer?.phone
    ? [{ phone: customer.phone, name: customer.first_name, role: 'primary' }]
    : [])),
  isServiceContactRole: jest.fn(() => false),
  firstNameFrom: jest.fn((n) => n),
  prefsUnavailable: jest.fn(() => false),
  getPrimaryContact: jest.fn((customer) => ({ phone: customer?.phone, name: customer?.first_name, role: 'primary' })),
}));
jest.mock('../services/recipient-optin', () => ({
  filterRecipientsByOptin: jest.fn(async (contacts) => contacts),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const AppointmentReminders = require('../services/appointment-reminders');
const { callbackNumberHoldFromRow } = AppointmentReminders._test;

describe('callbackNumberHoldFromRow (finding #1 — timestamp comparison)', () => {
  test('no hold stamped → not held', () => {
    expect(callbackNumberHoldFromRow({ callback_number_hold_at: null, call_sms_cleared_at: null })).toBe(false);
    expect(callbackNumberHoldFromRow(null)).toBe(false);
    expect(callbackNumberHoldFromRow(undefined)).toBe(false);
  });

  test('held, never cleared', () => {
    expect(callbackNumberHoldFromRow({ callback_number_hold_at: new Date('2030-01-01T10:00:00Z'), call_sms_cleared_at: null })).toBe(true);
  });

  test('cleared AFTER the hold → not held', () => {
    expect(callbackNumberHoldFromRow({
      callback_number_hold_at: new Date('2030-01-01T10:00:00Z'),
      call_sms_cleared_at: new Date('2030-01-01T11:00:00Z'),
    })).toBe(false);
  });

  test('a STALE clearance that PREDATES a fresh hold is still held (the exact codex regression)', () => {
    // A reused booking or reprocessed call carries an older
    // call_sms_cleared_at from a PRIOR call; a brand-new hold on this same
    // row must not read as already-cleared by it.
    expect(callbackNumberHoldFromRow({
      callback_number_hold_at: new Date('2030-01-02T10:00:00Z'),
      call_sms_cleared_at: new Date('2030-01-01T09:00:00Z'),
    })).toBe(true);
  });

  test('an identical hold/clear timestamp reads as cleared (matches the GREATEST(hold_at, now()) stamp the clear paths write)', () => {
    // Both clearance writers (admin-triage's resolve, the phone-edit
    // fan-out) stamp call_sms_cleared_at as GREATEST(callback_number_hold_at,
    // now()) — guaranteeing cleared_at >= hold_at, never <. The predicate's
    // "clearedAt < heldAt" test must therefore treat an EQUAL stamp as
    // cleared, or a clearance written in the same instant as the hold could
    // never actually lift it.
    const t = new Date('2030-01-01T10:00:00Z');
    expect(callbackNumberHoldFromRow({ callback_number_hold_at: t, call_sms_cleared_at: t })).toBe(false);
  });
});

describe('callbackNumberHoldActiveForVisit (finding #3 fail-closed, #5 grouped visitId)', () => {
  function chain(result) {
    return { where: jest.fn().mockReturnThis(), select: jest.fn().mockResolvedValue(result) };
  }

  test('no scheduledServiceId or visitId at all → not held (nothing to check)', async () => {
    expect(await AppointmentReminders.callbackNumberHoldActiveForVisit(null)).toBe(false);
    expect(await AppointmentReminders.callbackNumberHoldActiveForVisit(undefined)).toBe(false);
    expect(await AppointmentReminders.callbackNumberHoldActiveForVisit({})).toBe(false);
  });

  test('accepts a bare scheduledServiceId string (legacy call shape)', async () => {
    db.mockReturnValueOnce(chain([{ callback_number_hold_at: new Date(), call_sms_cleared_at: null }]));
    expect(await AppointmentReminders.callbackNumberHoldActiveForVisit('svc-1')).toBe(true);
  });

  test('a read error FAILS CLOSED — treated as held, never as clear-to-text', async () => {
    db.mockReturnValueOnce({
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockRejectedValue(new Error('connection reset')),
    });
    expect(await AppointmentReminders.callbackNumberHoldActiveForVisit('svc-1')).toBe(true);
  });

  test('a grouped occurrence is held if ANY sibling member carries the hold, even when the queried id itself does not', async () => {
    // The row this caller is looking at is clear; a SIBLING sharing
    // visit_id still carries the active hold — the group check catches it.
    db.mockReturnValueOnce(chain([
      { callback_number_hold_at: null, call_sms_cleared_at: null },
      { callback_number_hold_at: new Date(), call_sms_cleared_at: null },
    ]));
    const held = await AppointmentReminders.callbackNumberHoldActiveForVisit({ scheduledServiceId: 'svc-owner', visitId: 'visit-group-1' });
    expect(held).toBe(true);
  });

  test('a clean group (every member cleared or never held) is not held', async () => {
    db.mockReturnValueOnce(chain([
      { callback_number_hold_at: null, call_sms_cleared_at: null },
      { callback_number_hold_at: new Date('2030-01-01T10:00:00Z'), call_sms_cleared_at: new Date('2030-01-01T11:00:00Z') },
    ]));
    const held = await AppointmentReminders.callbackNumberHoldActiveForVisit({ scheduledServiceId: 'svc-owner', visitId: 'visit-group-1' });
    expect(held).toBe(false);
  });
});

// Finding #7: handleReschedule/handleCancellation (and no-show/series
// cancellation) previously called safeSendAppointment WITHOUT ever checking
// the hold, so they texted the disclaimed ANI unconditionally. Their claim
// machinery (atomic notice tokens, audit reconciliation, multi-contact
// fan-out) is deep enough that a full functional mock is its own project —
// callback-number-hold-boundary's own tests above already prove
// safeSendAppointment enforces the hold whenever metaExtra carries
// scheduled_service_id/visit_id; this is the source-level proof that EVERY
// notice-sending call site actually threads it (i.e. that the fix in
// safeSendAppointment truly reaches all of them, closing the "unchecked"
// finding without re-deriving each caller's claim logic here).
describe('every safeSendAppointment call site threads scheduled_service_id (finding #7 wiring)', () => {
  const src = require('fs').readFileSync(require.resolve('../services/appointment-reminders'), 'utf8');
  const NEEDLE = 'safeSendAppointment(customer,';
  const starts = [];
  for (let i = src.indexOf(NEEDLE); i !== -1; i = src.indexOf(NEEDLE, i + 1)) starts.push(i);
  // A generous fixed window per call site — large enough to run well past
  // the render closure into the trailing (messageType, purpose, metaExtra,
  // sendOptions) arguments every call site carries, without needing to
  // balance parens across an arbitrarily long inline closure body.
  const callSites = starts.map((i) => src.slice(i, i + 2500));

  test('at least the 7 known callers (confirmation, 72h, 24h, reschedule, cancellation, no-show, series cancellation) are found', () => {
    expect(callSites.length).toBeGreaterThanOrEqual(7);
  });

  test('every safeSendAppointment call site includes scheduled_service_id in its metaExtra', () => {
    const missing = callSites.filter((call) => !call.includes('scheduled_service_id'));
    expect(missing).toEqual([]);
  });
});

describe('safeSendAppointment — the single send boundary (finding #7)', () => {
  const CUSTOMER = { id: 'cust-1', first_name: 'Ada', phone: '+19415550100' };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('held (via metaExtra.scheduled_service_id) → never dials Twilio, returns false, marks the outcome retryable', async () => {
    db.mockReturnValueOnce({
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue([{ callback_number_hold_at: new Date(), call_sms_cleared_at: null }]),
    });
    const sendOutcome = {};
    const sent = await AppointmentReminders.safeSendAppointment(
      CUSTOMER, {}, 'BODY', 'appointment_rescheduled', 'appointment_confirmation',
      { scheduled_service_id: 'svc-held' }, { sendOutcome },
    );
    expect(sent).toBe(false);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(sendOutcome.retryable).toBe(true);
    expect(sendOutcome.lastCode).toBe('CALLBACK_NUMBER_HOLD');
  });

  test('not held → proceeds to the real send', async () => {
    db.mockReturnValueOnce({
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue([{ callback_number_hold_at: null, call_sms_cleared_at: null }]),
    });
    const sent = await AppointmentReminders.safeSendAppointment(
      CUSTOMER, {}, 'BODY', 'appointment_rescheduled', 'appointment_confirmation',
      { scheduled_service_id: 'svc-clear' }, {},
    );
    expect(sent).toBe(true);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('no scheduled_service_id/visit_id in metaExtra at all → the hold check is skipped entirely (no visit context)', async () => {
    const sent = await AppointmentReminders.safeSendAppointment(
      CUSTOMER, {}, 'BODY', 'some_message', 'appointment_confirmation', {}, {},
    );
    expect(sent).toBe(true);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    // No hold read for scheduled_services specifically — the boundary has
    // no visit context to check at all.
    expect(db).not.toHaveBeenCalledWith('scheduled_services');
  });

  test('a read-error while held-checking FAILS CLOSED — the boundary refuses to text on an unknown consent state', async () => {
    db.mockReturnValueOnce({
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockRejectedValue(new Error('db down')),
    });
    const sent = await AppointmentReminders.safeSendAppointment(
      CUSTOMER, {}, 'BODY', 'appointment_cancelled', 'appointment_cancellation',
      { scheduled_service_id: 'svc-unknown' }, {},
    );
    expect(sent).toBe(false);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
});

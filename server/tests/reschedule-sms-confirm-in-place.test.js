// Confirm-in-place: a rain-out already books the appointment into option 1
// before texting the customer, so "1 to confirm" (or a "2" that lands on the
// same slot) must NOT re-run SmartRebooker.reschedule — re-validating a slot the
// visit already occupies would wrongly reject a same-day slot whose tight 1-hour
// internal window ticked past while the customer was deciding, even though the
// reply arrived inside the 2-hour window we quoted.
//
// The shortcut is deliberately narrow: it only fires for a LIVE booking on the
// exact same date + full window, and only while the reply is still inside the
// quoted 2-hour arrival window. Anything else (genuine future-day switch, a
// widened/edited window, a skipped/terminal visit, or a reply after the quoted
// window) falls through to the normal reschedule path.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/rebooker', () => ({ reschedule: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Default: no template row (renderSmsTemplate resolves undefined) so the
// built-in fallback copy is what the assertions below see; the template-path
// tests override per-call.
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn().mockResolvedValue({ sent: true }),
}));
jest.mock('../utils/datetime-et', () => ({
  // No-arg call = "today"; the confirmation copy also calls it with the
  // addETDays result to compute "tomorrow".
  etDateString: jest.fn((d) => (d ? '2026-07-05' : '2026-07-04')),
  // Default "now" = 1:30 PM ET, inside the 1:00-3:00 PM quoted window.
  etParts: jest.fn(() => ({ hour: 13, minute: 30 })),
  addETDays: jest.fn(() => new Date('2026-07-05T12:00:00Z')),
}));
jest.mock('../services/appointment-reminders', () => ({
  handleReschedule: jest.fn().mockResolvedValue({}),
  markRescheduleNoticeSent: jest.fn().mockResolvedValue({ updated: 1 }),
}));

const db = require('../models/db');
const SmartRebooker = require('../services/rebooker');
const AppointmentReminders = require('../services/appointment-reminders');
const { etParts, etDateString } = require('../utils/datetime-et');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const RescheduleSMS = require('../services/reschedule-sms');

db.fn = { now: jest.fn(() => 'NOW()') };

function chain(terminal = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(1),
    ...terminal,
  };
}

function wireDb(queues) {
  db.mockImplementation((table) => {
    const q = queues[table];
    if (!q || q.length === 0) throw new Error(`Unexpected db('${table}') call`);
    return q.shift();
  });
}

const OPTION1 = { date: '2026-07-04', window: { start: '13:00', end: '14:00', display: '1:00 PM - 3:00 PM' } };
const OPTION2 = { date: '2026-07-06', window: { start: '08:00', end: '09:00', display: '8:00 AM - 10:00 AM' } };

function pendingRow() {
  return {
    id: 'log-1',
    scheduled_service_id: 'svc-1',
    reason_code: 'weather_rain',
    sms_sent_at: '2026-07-04T17:00:00Z',
    notes: JSON.stringify({ option1: OPTION1, option2: OPTION2 }),
  };
}

// db call order in handleRescheduleReply: reschedule_log (fetch pending) →
// reschedule_log (mark responded) → scheduled_services (svc) → customers →
// reschedule_log (new_date/new_window).
function wire(svcRow, customer = { id: 'cust-1', phone: '+19415551234' }) {
  wireDb({
    reschedule_log: [
      chain({ first: jest.fn().mockResolvedValue(pendingRow()) }),
      chain(),
      chain(),
    ],
    scheduled_services: [chain({ first: jest.fn().mockResolvedValue(svcRow) })],
    customers: [chain({ first: jest.fn().mockResolvedValue(customer) })],
  });
}

describe('handleRescheduleReply — confirm-in-place', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    etParts.mockReturnValue({ hour: 13, minute: 30 });
    etDateString.mockImplementation((d) => (d ? '2026-07-05' : '2026-07-04'));
  });

  test('reply "1" on the live slot, inside the quoted window, confirms WITHOUT re-booking', async () => {
    // DB TIME is 'HH:MM:SS'; the reply option carries 'HH:MM' — both normalize equal.
    wire({ scheduled_date: '2026-07-04', window_start: '13:00:00', window_end: '14:00:00', status: 'confirmed' });

    const result = await RescheduleSMS.handleRescheduleReply('cust-1', '1');

    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0].body).toContain('1:00 PM - 3:00 PM');
    // Confirm-in-place never re-booked, so the rain-out route's own reminder
    // sync is still accurate — no second sync from this path.
    expect(AppointmentReminders.handleReschedule).not.toHaveBeenCalled();
    expect(result).toMatchObject({ handled: true, action: 'rescheduled', newDate: '2026-07-04' });
  });

  test('same-day confirmation never promises a day-before reminder', async () => {
    wire({ scheduled_date: '2026-07-04', window_start: '13:00:00', window_end: '14:00:00', status: 'confirmed' });

    await RescheduleSMS.handleRescheduleReply('cust-1', '1');

    const body = sendCustomerMessage.mock.calls[0][0].body;
    expect(body).toContain('See you today.');
    expect(body).not.toContain('day before');
  });

  test('next-day confirmation says "See you tomorrow." instead of promising a day-before reminder', async () => {
    // Make OPTION2's date (2026-07-06) read as tomorrow.
    etDateString.mockImplementation((d) => (d ? '2026-07-06' : '2026-07-05'));
    wire({ scheduled_date: '2026-07-05', window_start: '13:00:00', window_end: '14:00:00', status: 'confirmed' });

    await RescheduleSMS.handleRescheduleReply('cust-1', '2');

    const body = sendCustomerMessage.mock.calls[0][0].body;
    expect(body).toContain('See you tomorrow.');
    expect(body).not.toContain('day before');
  });

  test('a confirmation two or more days out still promises the day-before reminder', async () => {
    // Today 2026-07-04, tomorrow 2026-07-05; OPTION2 is 2026-07-06.
    wire({ scheduled_date: '2026-07-04', window_start: '13:00:00', window_end: '14:00:00', status: 'confirmed' });

    await RescheduleSMS.handleRescheduleReply('cust-1', '2');

    expect(sendCustomerMessage.mock.calls[0][0].body).toContain("We'll remind you the day before.");
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'reschedule_confirmed_future',
      { date: expect.any(String), time: '8:00 AM - 10:00 AM' },
      expect.objectContaining({ workflow: 'reschedule_reply', entity_id: 'svc-1' }),
    );
  });

  test('an active admin-edited template overrides the built-in confirmation copy', async () => {
    renderSmsTemplate.mockResolvedValueOnce('EDITED TEMPLATE BODY');
    wire({ scheduled_date: '2026-07-04', window_start: '13:00:00', window_end: '14:00:00', status: 'confirmed' });

    await RescheduleSMS.handleRescheduleReply('cust-1', '1');

    // Same-day slot selects the same-day template key.
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'reschedule_confirmed_today',
      { date: expect.any(String), time: '1:00 PM - 3:00 PM' },
      expect.objectContaining({ workflow: 'reschedule_reply', entity_id: 'svc-1' }),
    );
    expect(sendCustomerMessage.mock.calls[0][0].body).toBe('EDITED TEMPLATE BODY');
  });

  test('a disabled/missing template falls back to built-in copy — the confirmation always sends', async () => {
    // Default mock already resolves undefined (missing/disabled template).
    wire({ scheduled_date: '2026-07-04', window_start: '13:00:00', window_end: '14:00:00', status: 'confirmed' });

    await RescheduleSMS.handleRescheduleReply('cust-1', '1');

    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0].body)
      .toBe('Confirmed. Your service is rescheduled for Saturday, Jul 4, 1:00 PM - 3:00 PM.\n\nSee you today.');
  });

  test('call-requested reply renders the reschedule_call_requested template with built-in fallback', async () => {
    wireDb({
      reschedule_log: [
        chain({ first: jest.fn().mockResolvedValue(pendingRow()) }),
        chain(),
      ],
      customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', phone: '+19415551234' }) })],
    });

    const result = await RescheduleSMS.handleRescheduleReply('cust-1', 'please call me');

    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'reschedule_call_requested', {}, expect.objectContaining({ workflow: 'reschedule_reply', entity_id: 'svc-1' }),
    );
    expect(sendCustomerMessage.mock.calls[0][0].body).toBe("No problem. We'll give you a call shortly.");
    expect(result).toMatchObject({ handled: true, action: 'call_requested', smsSent: true });
  });

  test('scheduled_date as a JS Date still matches (no "Sat Jul 04" stringify bug)', async () => {
    wire({ scheduled_date: new Date('2026-07-04T00:00:00Z'), window_start: '13:00:00', window_end: '14:00:00', status: 'confirmed' });

    await RescheduleSMS.handleRescheduleReply('cust-1', '1');

    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('reply "2" switching to a different-day slot DOES re-book', async () => {
    wire({ scheduled_date: '2026-07-04', window_start: '13:00:00', window_end: '14:00:00', status: 'confirmed' });

    const result = await RescheduleSMS.handleRescheduleReply('cust-1', '2');

    expect(SmartRebooker.reschedule).toHaveBeenCalledWith(
      'svc-1', '2026-07-06', { start: '08:00', end: '09:00', display: '8:00 AM - 10:00 AM' },
      'weather_rain', 'customer_sms',
    );
    // The re-book moved the visit, so the reminder row must be re-armed onto
    // the new slot — otherwise the promised day-before reminder never fires.
    expect(AppointmentReminders.handleReschedule).toHaveBeenCalledWith(
      'svc-1', '2026-07-06T08:00', { sendNotification: false, coverDueWindows: true },
    );
    expect(result).toMatchObject({ handled: true, action: 'rescheduled', newDate: '2026-07-06' });
  });

  test('same-day reply AFTER the quoted 2-hour window falls through to reschedule', async () => {
    etParts.mockReturnValue({ hour: 16, minute: 0 }); // 4 PM ET, past the 1-3 PM window
    wire({ scheduled_date: '2026-07-04', window_start: '13:00:00', window_end: '14:00:00', status: 'confirmed' });

    await RescheduleSMS.handleRescheduleReply('cust-1', '1');

    // Not confirmed in place — the rebooker runs (and in prod would reject the
    // elapsed slot, routing to office follow-up).
    expect(SmartRebooker.reschedule).toHaveBeenCalledTimes(1);
  });

  test('a skipped visit is not confirmed in place', async () => {
    wire({ scheduled_date: '2026-07-04', window_start: '13:00:00', window_end: '14:00:00', status: 'skipped' });

    await RescheduleSMS.handleRescheduleReply('cust-1', '1');

    expect(SmartRebooker.reschedule).toHaveBeenCalledTimes(1);
  });

  test('a widened window (same start, different end) re-books to the tight slot', async () => {
    // Manually edited to a 2-hour block; the reply option still targets 1 hour.
    wire({ scheduled_date: '2026-07-04', window_start: '13:00:00', window_end: '15:00:00', status: 'confirmed' });

    await RescheduleSMS.handleRescheduleReply('cust-1', '1');

    expect(SmartRebooker.reschedule).toHaveBeenCalledWith(
      'svc-1', '2026-07-04', { start: '13:00', end: '14:00', display: '1:00 PM - 3:00 PM' },
      'weather_rain', 'customer_sms',
    );
  });
});

// Confirm-in-place: a rain-out already books the appointment into option 1
// before texting the customer, so "1 to confirm" (or a "2" that lands on the
// same slot) must NOT re-run SmartRebooker.reschedule — re-validating a slot the
// visit already occupies would wrongly reject a same-day slot whose tight 1-hour
// internal window ticked past while the customer was deciding, even though the
// reply arrived inside the 2-hour window we quoted. A reply that picks a genuinely
// different slot (future-day alt) still re-books.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/rebooker', () => ({ reschedule: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn().mockResolvedValue('body') }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn().mockResolvedValue({ sent: true }),
}));
jest.mock('../utils/datetime-et', () => ({ etDateString: jest.fn(() => '2026-07-04') }));

const db = require('../models/db');
const SmartRebooker = require('../services/rebooker');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
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

describe('handleRescheduleReply — confirm-in-place', () => {
  beforeEach(() => jest.clearAllMocks());

  test('reply "1" on the slot the appointment already occupies confirms WITHOUT re-booking', async () => {
    wireDb({
      reschedule_log: [
        chain({ first: jest.fn().mockResolvedValue(pendingRow()) }), // fetch pending
        chain(), // mark responded
        chain(), // new_date/new_window
      ],
      // Appointment is already on option 1 (rain-out moved it there). DB TIME is
      // 'HH:MM:SS'; the reply option carries 'HH:MM' — both must normalize equal.
      scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ scheduled_date: '2026-07-04', window_start: '13:00:00', status: 'confirmed' }) })],
      customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', phone: '+19415551234' }) })],
    });

    const result = await RescheduleSMS.handleRescheduleReply('cust-1', '1');

    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0].body).toContain('1:00 PM - 3:00 PM');
    expect(result).toMatchObject({ handled: true, action: 'rescheduled', newDate: '2026-07-04' });
  });

  test('reply "2" switching to a different-day slot DOES re-book', async () => {
    wireDb({
      reschedule_log: [
        chain({ first: jest.fn().mockResolvedValue(pendingRow()) }),
        chain(),
        chain(),
      ],
      scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ scheduled_date: '2026-07-04', window_start: '13:00:00', status: 'confirmed' }) })],
      customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', phone: '+19415551234' }) })],
    });

    const result = await RescheduleSMS.handleRescheduleReply('cust-1', '2');

    // Alt is a genuine move to a future day — re-book with the tight 1-hour slot.
    expect(SmartRebooker.reschedule).toHaveBeenCalledWith(
      'svc-1', '2026-07-06', { start: '08:00', end: '09:00', display: '8:00 AM - 10:00 AM' },
      'weather_rain', 'customer_sms',
    );
    expect(result).toMatchObject({ handled: true, action: 'rescheduled', newDate: '2026-07-06' });
  });
});

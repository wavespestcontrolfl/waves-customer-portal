/**
 * Reschedule-reply confirmation — covered-window re-arm on a blocked send.
 *
 * handleRescheduleReply covers the due 24h/72h reminder windows
 * (handleReschedule coverDueWindows / the rain-out route's earlier sync)
 * BEFORE the confirmation SMS goes out. sendAppointmentSms throws on a
 * blocked number, so the customer got neither the confirmation nor any
 * later reminder of the new time. The send is now wrapped: any no-send
 * outcome re-arms both windows (mirrors reschedule-public.js — "silence is
 * worse") and the original error still propagates.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/rebooker', () => ({ reschedule: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn().mockResolvedValue({ sent: true }),
}));
jest.mock('../utils/datetime-et', () => ({
  etDateString: jest.fn((d) => (d ? '2026-07-05' : '2026-07-04')),
  etParts: jest.fn(() => ({ hour: 13, minute: 30 })),
  addETDays: jest.fn(() => new Date('2026-07-05T12:00:00Z')),
}));
jest.mock('../services/appointment-reminders', () => ({
  handleReschedule: jest.fn().mockResolvedValue({}),
  markRescheduleNoticeSent: jest.fn().mockResolvedValue({ updated: 1 }),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const RescheduleSMS = require('../services/reschedule-sms');

db.fn = { now: jest.fn(() => 'NOW()') };

function chain({ rows = [], ...terminal } = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(1),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
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

beforeEach(() => {
  jest.clearAllMocks();
});

test('a blocked confirmation re-arms both reminder windows and still propagates the error', async () => {
  // Confirm-in-place path: the visit already sits on option 1's slot, so the
  // windows were covered by the rain-out route's earlier sync — the failed
  // confirmation is the only remaining customer notice.
  sendCustomerMessage.mockResolvedValueOnce({ blocked: true, code: 'blocked_number' });
  const rearmChain = chain();
  wireDb({
    reschedule_log: [
      chain({ rows: [pendingRow()] }),
      chain(), // mark responded
    ],
    scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ scheduled_date: '2026-07-04', window_start: '13:00:00', window_end: '14:00:00', status: 'confirmed' }) })],
    customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', phone: '+19415551234' }) })],
    appointment_reminders: [rearmChain],
  });

  await expect(RescheduleSMS.handleRescheduleReply('cust-1', '1'))
    .rejects.toThrow(/appointment SMS blocked/);

  expect(rearmChain.where).toHaveBeenCalledWith({ scheduled_service_id: 'svc-1' });
  expect(rearmChain.update).toHaveBeenCalledWith(expect.objectContaining({
    reminder_72h_sent: false,
    reminder_72h_sent_at: null,
    reminder_24h_sent: false,
    reminder_24h_sent_at: null,
  }));
});

test('a successful confirmation never touches the covered windows', async () => {
  wireDb({
    reschedule_log: [
      chain({ rows: [pendingRow()] }),
      chain(), // mark responded
      chain(), // new_date/new_window update
    ],
    scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ scheduled_date: '2026-07-04', window_start: '13:00:00', window_end: '14:00:00', status: 'confirmed' }) })],
    customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', phone: '+19415551234' }) })],
    // NO appointment_reminders queue: any re-arm call would throw Unexpected db().
  });

  const result = await RescheduleSMS.handleRescheduleReply('cust-1', '1');
  expect(result).toMatchObject({ handled: true, action: 'rescheduled' });
});

test('the blocked-confirmation re-arm skips sibling-suppressed and cancelled rows', async () => {
  // Same carve-out as the dispatch re-arm: clearing the sent flags on a
  // sibling-suppressed row would return it to the cron's send set alongside
  // the slot's owner (two texts for one window).
  sendCustomerMessage.mockResolvedValueOnce({ blocked: true, code: 'blocked_number' });
  const rearmChain = chain();
  wireDb({
    reschedule_log: [
      chain({ rows: [pendingRow()] }),
      chain(), // mark responded
    ],
    scheduled_services: [chain({ first: jest.fn().mockResolvedValue({ scheduled_date: '2026-07-04', window_start: '13:00:00', window_end: '14:00:00', status: 'confirmed' }) })],
    customers: [chain({ first: jest.fn().mockResolvedValue({ id: 'cust-1', phone: '+19415551234' }) })],
    appointment_reminders: [rearmChain],
  });

  await expect(RescheduleSMS.handleRescheduleReply('cust-1', '1'))
    .rejects.toThrow(/appointment SMS blocked/);

  expect(rearmChain.where).toHaveBeenCalledWith('suppressed_by_sibling', false);
  expect(rearmChain.where).toHaveBeenCalledWith('cancelled', false);
});

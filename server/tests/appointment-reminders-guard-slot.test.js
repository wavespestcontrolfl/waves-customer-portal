// guard_slot_ms feeds the move guard without being recorded as the promised
// window. A windowless reschedule tells the customer "at a time we'll
// confirm"; recording its bookkeeping 08:00 as rendered_slot_ms made the
// no-show detector hold the visit to an 8-10 AM promise nobody made.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/messaging/push-channel-routing', () => ({
  wantsAppFirst: jest.fn(async () => false),
}));
jest.mock('../services/messaging/validators/line-type', () => ({
  readCachedLineType: jest.fn(async () => ({ state: 'hit', lineType: 'mobile' })),
  cacheLineType: jest.fn(),
  NON_SMS_LINE_TYPES: new Set(['landline', 'fixedVoip']),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { wantsAppFirst } = require('../services/messaging/push-channel-routing');
const { safeSend } = require('../services/appointment-reminders')._test;

const SLOT = Date.parse('2026-10-02T12:00:00Z');

beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation(() => ({ where() { return this; }, first: async () => undefined }));
});

test('guard_slot_ms guards the send but is never recorded as the promised window', async () => {
  const sent = await safeSend('cust-1', '+19415550100', 'Body', 'appointment_rescheduled', 'appointment_confirmation',
    'phone_matches_customer', { scheduled_service_id: 'svc-1', guard_slot_ms: SLOT });
  expect(sent).toBe(true);
  const args = sendCustomerMessage.mock.calls[0][0];
  expect(args.renderedSlotMs).toBe(SLOT);
  expect(args.metadata).not.toHaveProperty('rendered_slot_ms');
  expect(args.metadata).not.toHaveProperty('guard_slot_ms');
  expect(args.metadata.scheduled_service_id).toBe('svc-1');
  expect(wantsAppFirst.mock.calls[0][0].metadata).not.toHaveProperty('guard_slot_ms');
});

test('rendered_slot_ms is still recorded and guards the send', async () => {
  await safeSend('cust-1', '+19415550100', 'Body', 'appointment_rescheduled', 'appointment_confirmation',
    'phone_matches_customer', { scheduled_service_id: 'svc-1', rendered_slot_ms: SLOT });
  const args = sendCustomerMessage.mock.calls[0][0];
  expect(args.renderedSlotMs).toBe(SLOT);
  expect(args.metadata.rendered_slot_ms).toBe(SLOT);
});

test('the reschedule notice passes guard_slot_ms only when the visit is windowless', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'appointment-reminders.js'), 'utf8');
  expect(src).toMatch(/'appointment_rescheduled', 'appointment_confirmation', \{[\s\S]{0,300}resolved\?\.windowless \? \{ guard_slot_ms: newApptTime\.getTime\(\) \} : \{ rendered_slot_ms: newApptTime\.getTime\(\) \}/);
});

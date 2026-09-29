// A windowless reschedule tells the customer "at a time we'll confirm". Its
// rendered slot is the resolver's bookkeeping 08:00: it still guards the
// send against a move, but is never recorded as the promised window — not
// on the audit row, and not in the fallback ledger when that row fails —
// or the no-show detector holds the visit to an 8-10 AM promise nobody made.
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
jest.mock('../services/no-show-detector', () => ({
  recordSentWindowFallback: jest.fn(async () => true),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { recordSentWindowFallback } = require('../services/no-show-detector');
const { safeSend } = require('../services/appointment-reminders')._test;
const { persistAudit } = require('../services/messaging/audit');
const { recordPromiseEvidenceFallback } = jest.requireActual('../services/messaging/send-customer-message')._internals;

const SLOT = Date.parse('2026-10-02T12:00:00Z');
const SID = `SM${'a'.repeat(32)}`;

beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation(() => ({ where() { return this; }, first: async () => undefined }));
});

describe('safeSend', () => {
  test('window_unknown: the slot guards the send, and is not recorded', async () => {
    const sent = await safeSend('cust-1', '+19415550100', 'Body', 'appointment_rescheduled', 'appointment_confirmation',
      'phone_matches_customer', { scheduled_service_id: 'svc-1', rendered_slot_ms: SLOT, window_unknown: true });
    expect(sent).toBe(true);
    const args = sendCustomerMessage.mock.calls[0][0];
    expect(args).toMatchObject({ renderedSlotMs: SLOT, promisedWindowUnknown: true, appointmentId: 'svc-1' });
    expect(args.metadata).not.toHaveProperty('rendered_slot_ms');
    expect(args.metadata.window_unknown).toBe(true);
  });

  test('a notice that quotes its window records it as before', async () => {
    await safeSend('cust-1', '+19415550100', 'Body', 'appointment_rescheduled', 'appointment_confirmation',
      'phone_matches_customer', { scheduled_service_id: 'svc-1', rendered_slot_ms: SLOT });
    const args = sendCustomerMessage.mock.calls[0][0];
    expect(args.renderedSlotMs).toBe(SLOT);
    expect(args).not.toHaveProperty('promisedWindowUnknown');
    expect(args.metadata.rendered_slot_ms).toBe(SLOT);
  });
});

describe('persistAudit', () => {
  const input = { to: '+19415550100', audience: 'customer', purpose: 'appointment_confirmation', channel: 'sms',
    appointmentId: 'svc-1', renderedSlotMs: SLOT, metadata: { original_message_type: 'appointment_rescheduled' } };
  function captureInsert() {
    const rows = [];
    db.mockImplementation(() => ({ insert: (row) => { rows.push(row); return { returning: async () => [{ id: 'a-1' }] }; } }));
    return rows;
  }

  test('an unknown-window notice gets no rendered_slot_ms on its audit row', async () => {
    const rows = captureInsert();
    await persistAudit({ input: { ...input, promisedWindowUnknown: true } });
    expect(rows[0].metadata).toEqual({ original_message_type: 'appointment_rescheduled' });
  });

  test('a known-window notice still stamps it', async () => {
    const rows = captureInsert();
    await persistAudit({ input });
    expect(rows[0].metadata.rendered_slot_ms).toBe(SLOT);
  });
});

describe('recordPromiseEvidenceFallback (delivered, but the audit row failed)', () => {
  const sendInput = { appointmentId: 'svc-1', renderedSlotMs: SLOT, metadata: { original_message_type: 'appointment_rescheduled' } };
  const delivered = { providerMessageId: SID, provider: 'twilio', sentAt: '2026-09-28T14:00:00.000Z' };

  test('an unknown-window notice records an unknown-window promise, not the 08:00 slot', async () => {
    await recordPromiseEvidenceFallback({ ...sendInput, promisedWindowUnknown: true }, delivered, { id: null });
    expect(recordSentWindowFallback).toHaveBeenCalledTimes(1);
    expect(recordSentWindowFallback.mock.calls[0][0]).toMatchObject({ visitId: 'svc-1', startAtMs: null, windowUnknown: true, providerSid: SID });
  });

  test('a known-window notice records its slot', async () => {
    await recordPromiseEvidenceFallback(sendInput, delivered, { id: null });
    expect(recordSentWindowFallback.mock.calls[0][0]).toMatchObject({ startAtMs: SLOT, windowUnknown: false });
  });
});

test('the reschedule notice flags window_unknown only when the visit is windowless', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'appointment-reminders.js'), 'utf8');
  expect(src).toMatch(/'appointment_rescheduled', 'appointment_confirmation', \{\s*scheduled_service_id: scheduledServiceId,\s*rendered_slot_ms: newApptTime\.getTime\(\),[\s\S]{0,200}\.\.\.\(resolved\?\.windowless \? \{ window_unknown: true \} : \{\}\)/);
});

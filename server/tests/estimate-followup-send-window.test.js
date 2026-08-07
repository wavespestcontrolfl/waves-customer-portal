// sendDualChannel vs the 8AM-8PM ET send window: a QUIET_HOURS_HOLD on the
// SMS leg requeues the text on the scheduled-SMS rail at nextAllowedAt and
// the email leg proceeds NOW (stage candidates live in bounded age windows,
// so releasing the claim to retry at 8 AM could age the touch out and lose
// both legs). If the requeue insert fails, the claim is released for a full
// retry. Any other SMS block (consent, suppression) keeps the old behavior:
// the email leg still carries the touch, nothing is queued.

jest.mock('../models/db', () => {
  const inserts = [];
  const mockDb = jest.fn((table) => ({
    insert: jest.fn(async (row) => { inserts.push({ table, row }); }),
  }));
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  mockDb._inserts = inserts;
  return mockDb;
});
jest.mock('../config/twilio-numbers', () => ({
  getOutboundNumber: jest.fn(() => '+19413180000'),
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true })),
  redactEmailAddresses: jest.fn((s) => s),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const EmailTemplateLibrary = require('../services/email-template-library');
const { sendDualChannel } = require('../services/estimate-follow-up')._private;

const EST = {
  id: 'est-1',
  customer_id: 'cust-1',
  customer_phone: '+19415550123',
  customer_email: 'c@example.com',
  created_at: '2026-08-01T00:00:00Z',
};

const EMAIL = { templateKey: 'estimate.followup_unviewed', stage: 'unviewed', payload: {} };

describe('estimate follow-up sendDualChannel send-window hold', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db._inserts.length = 0;
  });

  test('a held SMS leg requeues on the scheduled rail and the email proceeds now', async () => {
    sendCustomerMessage.mockResolvedValue({
      sent: false,
      blocked: true,
      code: 'QUIET_HOURS_HOLD',
      retryable: true,
      deferred: true,
      nextAllowedAt: '2026-08-07T12:00:00.000Z',
    });
    const attempted = await sendDualChannel(EST, { sms: 'Follow-up body', email: EMAIL });
    expect(attempted).toBe(true);
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
    expect(db._inserts).toHaveLength(1);
    const { table, row } = db._inserts[0];
    expect(table).toBe('sms_log');
    expect(row.status).toBe('scheduled');
    expect(row.scheduled_for).toEqual(new Date('2026-08-07T12:00:00.000Z'));
    expect(row.message_type).toBe('estimate_followup');
    expect(row.to_phone).toBe(EST.customer_phone);
  });

  test('a failed requeue releases the claim for a full retry', async () => {
    sendCustomerMessage.mockResolvedValue({
      sent: false,
      blocked: true,
      code: 'QUIET_HOURS_HOLD',
      retryable: true,
      deferred: true,
      nextAllowedAt: '2026-08-07T12:00:00.000Z',
    });
    db.mockImplementationOnce(() => ({
      insert: jest.fn(async () => { throw new Error('insert failed'); }),
    }));
    const attempted = await sendDualChannel(EST, { sms: 'Follow-up body', email: EMAIL });
    expect(attempted).toBe(false);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  });

  test('a terminal SMS block still lets the email leg carry the touch without queueing anything', async () => {
    sendCustomerMessage.mockResolvedValue({
      sent: false,
      blocked: true,
      code: 'SUPPRESSED',
    });
    const attempted = await sendDualChannel(EST, { sms: 'Follow-up body', email: EMAIL });
    expect(attempted).toBe(true);
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
    expect(db._inserts).toHaveLength(0);
  });

  test('inside the window both legs run', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: true });
    const attempted = await sendDualChannel(EST, { sms: 'Follow-up body', email: EMAIL });
    expect(attempted).toBe(true);
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
    expect(db._inserts).toHaveLength(0);
  });
});

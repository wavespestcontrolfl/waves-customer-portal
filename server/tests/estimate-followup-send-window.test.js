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
    // r20: the hold path reads the account phone to decide the replay's
    // refresh behavior; _firstImpl lets each pin choose the row (or throw).
    where: jest.fn(() => ({
      first: jest.fn(async () => (typeof mockDb._firstImpl === 'function' ? mockDb._firstImpl(table) : null)),
    })),
  }));
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  mockDb._inserts = inserts;
  mockDb._firstImpl = null;
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
    db._firstImpl = null;
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

  test('replay refresh rides ONLY a snapshot that IS the account phone (r20): a differing captured recipient stays frozen', async () => {
    sendCustomerMessage.mockResolvedValue({
      sent: false,
      blocked: true,
      code: 'QUIET_HOURS_HOLD',
      retryable: true,
      deferred: true,
      nextAllowedAt: '2026-08-07T12:00:00.000Z',
    });

    // Snapshot IS the account phone (formatting aside): safe to re-read live.
    db._firstImpl = () => ({ phone: '941-555-0123' });
    await sendDualChannel(EST, { sms: 'Follow-up body', email: EMAIL });
    let meta = JSON.parse(db._inserts[0].row.metadata);
    expect(meta.refresh_customer_phone).toBe(true);
    expect(meta.explicit_recipient).toBeUndefined();

    // Captured phone differs (a supported email-match linkage): FROZEN —
    // the replay must not swap the bearer estimate link onto the account
    // holder's number.
    db._inserts.length = 0;
    db._firstImpl = () => ({ phone: '+19419998888' });
    await sendDualChannel(EST, { sms: 'Follow-up body', email: EMAIL });
    meta = JSON.parse(db._inserts[0].row.metadata);
    expect(meta.refresh_customer_phone).toBeUndefined();
    expect(meta.explicit_recipient).toBe(true);
    expect(db._inserts[0].row.to_phone).toBe(EST.customer_phone);

    // Transient lookup failure defers the decision to replay (r24) —
    // freezing would assert "intentional alternate" about a number nobody
    // verified, and if the snapshot WAS the account phone the frozen
    // bearer link could ride a number the customer changes overnight.
    db._inserts.length = 0;
    db._firstImpl = () => { throw new Error('db down'); };
    await sendDualChannel(EST, { sms: 'Follow-up body', email: EMAIL });
    meta = JSON.parse(db._inserts[0].row.metadata);
    expect(meta.refresh_customer_phone).toBeUndefined();
    expect(meta.explicit_recipient).toBeUndefined();
    expect(meta.recipient_identity_unverified).toBe(true);
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
    // First db() call is the r20 account-phone lookup; the second is the
    // sms_log insert that must fail for this pin.
    db.mockImplementationOnce(() => ({
      where: jest.fn(() => ({ first: jest.fn(async () => null) })),
    })).mockImplementationOnce(() => ({
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

// processScheduledSends vs the 8AM-8PM ET send window (codex r2 P1): a
// scheduled invoice due outside the window must move to the window open
// WITHOUT burning one of its five scheduled_send_attempts, and without
// letting the email leg go out alone (which would finalize the invoice and
// strand the SMS pay link with no retry rail). Two layers under test:
//   1. the pre-claim guard — outside the window the row is deferred before
//      sendViaSMSAndEmail is ever called;
//   2. the hold-aware failure branch — a QUIET_HOURS_HOLD that slipped past
//      the guard (19:59→20:01 race) reschedules at nextAllowedAt instead of
//      incrementing the attempt counter.

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  fn.fn = { now: jest.fn(() => 'now()') };
  return fn;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(),
}));
jest.mock('../services/messaging/send-window', () => ({
  isWithinSendWindowET: jest.fn(),
  nextSendWindowOpenET: jest.fn(),
}));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const {
  isWithinSendWindowET,
  nextSendWindowOpenET,
} = require('../services/messaging/send-window');
const InvoiceService = require('../services/invoice');

const WINDOW_OPEN = new Date('2026-08-07T12:00:00.000Z'); // 8:00 AM ET

function chain({ rows, returning } = {}) {
  const q = {};
  for (const m of ['where', 'whereIn', 'whereNotNull', 'whereNull', 'orWhere', 'orderBy', 'limit', 'update', 'insert']) {
    q[m] = jest.fn(() => q);
  }
  q.select = jest.fn(async () => rows || []);
  q.returning = jest.fn(async () => returning || []);
  // Awaiting the chain itself (update/insert paths) resolves via then.
  q.then = (resolve) => Promise.resolve(rows || []).then(resolve);
  return q;
}

const dueRow = {
  id: 'inv-1',
  invoice_number: 'WPC-2026-1042',
  scheduled_send_attempts: 2,
  scheduled_request_review: false,
  scheduled_review_delay_minutes: null,
};

describe('processScheduledSends send-window handling', () => {
  let sendSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    isEnabled.mockImplementation((gate) => gate === 'smsSendWindow');
    nextSendWindowOpenET.mockReturnValue(WINDOW_OPEN);
    sendSpy = jest.spyOn(InvoiceService, 'sendViaSMSAndEmail');
  });

  afterEach(() => {
    sendSpy.mockRestore();
  });

  test('outside the window: due row defers to the window open without claiming or burning an attempt', async () => {
    isWithinSendWindowET.mockReturnValue(false);
    const staleRecovery = chain();
    const dueQuery = chain({ rows: [dueRow] });
    const deferUpdate = chain();
    db
      .mockReturnValueOnce(staleRecovery)
      .mockReturnValueOnce(dueQuery)
      .mockReturnValueOnce(deferUpdate);

    const result = await InvoiceService.processScheduledSends();

    expect(sendSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, failed: 0, deferred: 1 });
    const updateArgs = deferUpdate.update.mock.calls[0][0];
    expect(updateArgs.scheduled_send_at).toEqual(WINDOW_OPEN);
    expect(updateArgs.scheduled_send_attempts).toBeUndefined();
    expect(String(updateArgs.scheduled_send_error)).toContain('QUIET_HOURS_HOLD');
  });

  test('inside the window: the send proceeds', async () => {
    isWithinSendWindowET.mockReturnValue(true);
    const staleRecovery = chain();
    const dueQuery = chain({ rows: [dueRow] });
    const claim = chain({ returning: [{ id: 'inv-1', scheduled_request_review: false, scheduled_review_delay_minutes: null }] });
    db
      .mockReturnValueOnce(staleRecovery)
      .mockReturnValueOnce(dueQuery)
      .mockReturnValueOnce(claim);
    sendSpy.mockResolvedValue({ ok: true, sms: { ok: true }, email: { ok: true }, creditApplied: 0 });

    const result = await InvoiceService.processScheduledSends();

    expect(sendSpy).toHaveBeenCalledWith('inv-1', expect.objectContaining({ allowClaimed: true }));
    expect(result).toEqual({ sent: 1, failed: 0, deferred: 0 });
  });

  test('a QUIET_HOURS_HOLD that slips past the guard reschedules at nextAllowedAt and refunds the attempt', async () => {
    isWithinSendWindowET.mockReturnValue(true); // guard passed at 19:59...
    const staleRecovery = chain();
    const dueQuery = chain({ rows: [dueRow] });
    const claim = chain({ returning: [{ id: 'inv-1', scheduled_request_review: false, scheduled_review_delay_minutes: null }] });
    const holdUpdate = chain();
    db
      .mockReturnValueOnce(staleRecovery)
      .mockReturnValueOnce(dueQuery)
      .mockReturnValueOnce(claim)
      .mockReturnValueOnce(holdUpdate);
    // ...but the validator saw 20:01 (window closed mid-flight).
    sendSpy.mockResolvedValue({
      ok: false,
      sms: {
        ok: false,
        code: 'QUIET_HOURS_HOLD',
        error: 'payment-link SMS blocked: QUIET_HOURS_HOLD',
        deferred: true,
        nextAllowedAt: WINDOW_OPEN.toISOString(),
      },
      email: { ok: false, error: 'no email on file' },
      creditApplied: 0,
    });

    const result = await InvoiceService.processScheduledSends();

    expect(result).toEqual({ sent: 0, failed: 0, deferred: 1 });
    const updateArgs = holdUpdate.update.mock.calls[0][0];
    expect(updateArgs.status).toBe('scheduled');
    expect(updateArgs.scheduled_send_at).toEqual(WINDOW_OPEN);
    expect(updateArgs.scheduled_send_attempts).toBeUndefined();
  });

  test('an ordinary failure still increments the attempt counter', async () => {
    isWithinSendWindowET.mockReturnValue(true);
    const staleRecovery = chain();
    const dueQuery = chain({ rows: [dueRow] });
    const claim = chain({ returning: [{ id: 'inv-1', scheduled_request_review: false, scheduled_review_delay_minutes: null }] });
    const failUpdate = chain();
    db
      .mockReturnValueOnce(staleRecovery)
      .mockReturnValueOnce(dueQuery)
      .mockReturnValueOnce(claim)
      .mockReturnValueOnce(failUpdate);
    sendSpy.mockResolvedValue({
      ok: false,
      sms: { ok: false, error: 'Customer has no phone number' },
      email: { ok: false, error: 'no email on file' },
      creditApplied: 0,
    });

    const result = await InvoiceService.processScheduledSends();

    expect(result).toEqual({ sent: 0, failed: 1, deferred: 0 });
    const updateArgs = failUpdate.update.mock.calls[0][0];
    expect(updateArgs.scheduled_send_attempts).toBe(3);
  });
});

// A scheduled invoice carries scheduled_request_review /
// scheduled_review_delay_minutes, and the sendViaSMSAndEmail success path
// clears both unconditionally. Callers that take no review decision (the
// SendInvoiceModal posts {}, /batch/send passes no options) must inherit the
// stored flags instead of silently dropping the configured review request.
// An explicit requestReview true/false from the caller still wins.

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
jest.mock('../services/invoice-email', () => ({
  sendInvoiceEmail: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/review-request', () => ({
  create: jest.fn(async () => ({ id: 'rr-1' })),
}));
jest.mock('../services/invoice-followups', () => ({
  scheduleForInvoice: jest.fn(async () => {}),
  stopSequence: jest.fn(async () => {}),
}));

const db = require('../models/db');
const ReviewService = require('../services/review-request');
const InvoiceService = require('../services/invoice');

function chain({ first, returning } = {}) {
  const q = {};
  q.where = jest.fn(() => q);
  q.whereIn = jest.fn(() => q);
  q.select = jest.fn(() => q);
  q.update = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(async () => returning || []);
  q.insert = jest.fn(() => Promise.resolve());
  return q;
}

function scheduledInvoice(overrides = {}) {
  return {
    id: 'inv-1',
    status: 'scheduled',
    invoice_number: 'WPC-2026-1042',
    customer_id: 'cust-1',
    service_record_id: 'sr-1',
    scheduled_request_review: true,
    scheduled_review_delay_minutes: 120,
    ...overrides,
  };
}

// Mocks the db() call sequence inside sendViaSMSAndEmail:
//   1. claimInvoiceForSend read   2. claim update→returning
//   3. (review block) invoice read   4. success-path update
// The chains are permissive, so the same sequence also covers runs where
// the review block is skipped (call 3 becomes the success update).
function mockSendSequence(invoice) {
  db
    .mockReturnValueOnce(chain({ first: invoice }))
    .mockReturnValueOnce(chain({ returning: [{ ...invoice, status: 'sending' }] }))
    .mockReturnValueOnce(
      chain({
        first: {
          customer_id: invoice.customer_id,
          service_record_id: invoice.service_record_id,
        },
      }),
    )
    .mockReturnValue(chain());
}

describe('InvoiceService.sendViaSMSAndEmail scheduled-review fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .spyOn(InvoiceService, 'sendViaSMS')
      .mockResolvedValue({ sent: true, payUrl: 'https://pay.example/x' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('no review options → inherits the scheduled review request', async () => {
    mockSendSequence(scheduledInvoice());

    const result = await InvoiceService.sendViaSMSAndEmail('inv-1', {});

    expect(result.ok).toBe(true);
    expect(ReviewService.create).toHaveBeenCalledWith({
      customerId: 'cust-1',
      serviceRecordId: 'sr-1',
      triggeredBy: 'auto',
      delayMinutes: 120,
    });
  });

  test('explicit requestReview: false overrides the stored flag', async () => {
    mockSendSequence(scheduledInvoice());

    const result = await InvoiceService.sendViaSMSAndEmail('inv-1', {
      requestReview: false,
    });

    expect(result.ok).toBe(true);
    expect(ReviewService.create).not.toHaveBeenCalled();
  });

  test('no review options + no stored flag → no review request', async () => {
    mockSendSequence(
      scheduledInvoice({
        scheduled_request_review: false,
        scheduled_review_delay_minutes: null,
      }),
    );

    const result = await InvoiceService.sendViaSMSAndEmail('inv-1', {});

    expect(result.ok).toBe(true);
    expect(ReviewService.create).not.toHaveBeenCalled();
  });

  test('explicit requestReview + delay wins over stored minutes', async () => {
    mockSendSequence(scheduledInvoice());

    const result = await InvoiceService.sendViaSMSAndEmail('inv-1', {
      requestReview: true,
      reviewDelayMinutes: 30,
    });

    expect(result.ok).toBe(true);
    expect(ReviewService.create).toHaveBeenCalledWith(
      expect.objectContaining({ delayMinutes: 30 }),
    );
  });
});

// markDeliverySent is the OTHER finalization path that clears
// scheduled_request_review (combined project report+invoice send, completion
// SMS with invoice link) — the #1604 fix covered sendViaSMSAndEmail only, so
// a scheduled review-request invoice delivered through a combined send
// silently dropped its review. Same inheritance contract applies.
//
// db() call sequence inside markDeliverySent:
//   1. invoice read   2. finalize update→returning   3. activity_log insert
function mockMarkDeliverySequence(invoice, { finalized = true } = {}) {
  db
    .mockReturnValueOnce(chain({ first: invoice }))
    .mockReturnValueOnce(
      chain({ returning: finalized ? [{ ...invoice, status: 'sent', scheduled_request_review: false }] : [] }),
    )
    .mockReturnValue(chain());
}

describe('InvoiceService.markDeliverySent scheduled-review fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('no review options → inherits the scheduled review request', async () => {
    mockMarkDeliverySequence(scheduledInvoice());

    const result = await InvoiceService.markDeliverySent('inv-1', {
      sms: true,
      email: true,
      source: 'project_report_with_invoice',
    });

    expect(result.status).toBe('sent');
    expect(ReviewService.create).toHaveBeenCalledWith({
      customerId: 'cust-1',
      serviceRecordId: 'sr-1',
      triggeredBy: 'auto',
      delayMinutes: 120,
    });
  });

  test('explicit requestReview: false overrides the stored flag', async () => {
    mockMarkDeliverySequence(scheduledInvoice());

    await InvoiceService.markDeliverySent('inv-1', {
      email: true,
      requestReview: false,
    });

    expect(ReviewService.create).not.toHaveBeenCalled();
  });

  test('no stored flag → no review request', async () => {
    mockMarkDeliverySequence(
      scheduledInvoice({
        scheduled_request_review: false,
        scheduled_review_delay_minutes: null,
      }),
    );

    await InvoiceService.markDeliverySent('inv-1', { email: true });

    expect(ReviewService.create).not.toHaveBeenCalled();
  });

  test('concurrent finalization won the race → no duplicate review request', async () => {
    mockMarkDeliverySequence(scheduledInvoice(), { finalized: false });

    await InvoiceService.markDeliverySent('inv-1', { email: true });

    expect(ReviewService.create).not.toHaveBeenCalled();
  });

  test('non-finalizable status returns early without queueing', async () => {
    db.mockReturnValueOnce(chain({ first: scheduledInvoice({ status: 'paid' }) }));

    const result = await InvoiceService.markDeliverySent('inv-1', { email: true });

    expect(result.status).toBe('paid');
    expect(ReviewService.create).not.toHaveBeenCalled();
  });
});

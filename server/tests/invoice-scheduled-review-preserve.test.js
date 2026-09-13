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
  enrollPostService: jest.fn(async () => ({ id: 'rr-1' })),
}));
jest.mock('../services/invoice-followups', () => ({
  scheduleForInvoice: jest.fn(async () => {}),
  stopSequence: jest.fn(async () => {}),
}));
// The invoice-issued closeout (GATE_INVOICE_ISSUED_CLOSES_VISIT) runs before
// the review decision; gate-off by default here, one test flips its verdict.
jest.mock('../services/invoice-issued-closeout', () => ({
  closeOutVisitForIssuedInvoice: jest.fn(async () => ({ closed: false, reason: 'gate_off' })),
  // Durable provenance of a committed quiet closeout on the linked record
  // (pre-push P1 r7) — false by default: no closeout owns these records.
  issuedCloseoutOwnsRecord: jest.fn(async () => false),
}));

const db = require('../models/db');
const ReviewService = require('../services/review-request');
const InvoiceService = require('../services/invoice');
const { closeOutVisitForIssuedInvoice, issuedCloseoutOwnsRecord } = require('../services/invoice-issued-closeout');

function chain({ first, returning } = {}) {
  const q = {};
  q.where = jest.fn(() => q);
  q.whereIn = jest.fn(() => q);
  q.whereRaw = jest.fn(() => q);
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
//   1. payer_statement_id accrual pre-check   2. claimInvoiceForSend read
//   3. the claim's queued pay-link text check (none)
//   4. claim update→returning
//   5+. everything after the claim (the check re-run under the claim, the
//   success-path update, the review block's invoice read AFTER the
//   invoice-issued closeout): every `invoices` read answers with the
//   post-delivery row the review block reads back; other tables get a
//   permissive chain.
function mockSendSequence(invoice, reviewRead = {}) {
  db
    .mockReturnValueOnce(chain({ first: invoice }))
    .mockReturnValueOnce(chain({ first: invoice }))
    .mockReturnValueOnce(chain({ first: undefined }))
    .mockReturnValueOnce(chain({ returning: [{ ...invoice, status: 'sending' }] }))
    .mockImplementation((table) => (table === 'invoices'
      ? chain({
        first: {
          customer_id: invoice.customer_id,
          service_record_id: invoice.service_record_id,
          // What the review block reads back AFTER delivery: an unpaid
          // completion invoice is 'sent' at this point.
          status: 'sent',
          ...reviewRead,
        },
      })
      : chain()));
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

  test('unpaid COMPLETION invoice → review ask deferred to the paid webhook (Codex P1, PR #3104 r1)', async () => {
    mockSendSequence(scheduledInvoice());

    const result = await InvoiceService.sendViaSMSAndEmail('inv-1', {});

    expect(result.ok).toBe(true);
    expect(ReviewService.enrollPostService).not.toHaveBeenCalled();
  });

  test('prepaid completion invoice → inherits the scheduled review request at delivery', async () => {
    mockSendSequence(scheduledInvoice(), { status: 'prepaid' });

    const result = await InvoiceService.sendViaSMSAndEmail('inv-1', {});

    expect(result.ok).toBe(true);
    expect(ReviewService.enrollPostService).toHaveBeenCalledWith({
      customerId: 'cust-1',
      serviceRecordId: 'sr-1',
      triggeredBy: 'auto',
      delayMinutes: 120,
    });
  });

  test('standalone unpaid invoice (no service record) keeps the legacy at-delivery ask', async () => {
    mockSendSequence(scheduledInvoice({ service_record_id: null }));

    const result = await InvoiceService.sendViaSMSAndEmail('inv-1', {});

    expect(result.ok).toBe(true);
    expect(ReviewService.enrollPostService).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'cust-1', serviceRecordId: null }),
    );
  });

  test('explicit requestReview: false overrides the stored flag', async () => {
    mockSendSequence(scheduledInvoice());

    const result = await InvoiceService.sendViaSMSAndEmail('inv-1', {
      requestReview: false,
    });

    expect(result.ok).toBe(true);
    expect(ReviewService.enrollPostService).not.toHaveBeenCalled();
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
    expect(ReviewService.enrollPostService).not.toHaveBeenCalled();
  });

  test('explicit requestReview + delay wins over stored minutes', async () => {
    mockSendSequence(scheduledInvoice(), { status: 'prepaid' });

    const result = await InvoiceService.sendViaSMSAndEmail('inv-1', {
      requestReview: true,
      reviewDelayMinutes: 30,
    });

    expect(result.ok).toBe(true);
    expect(ReviewService.enrollPostService).toHaveBeenCalledWith(
      expect.objectContaining({ delayMinutes: 30 }),
    );
  });

  // Invoice issued ⇒ visit completed (GitHub r4 P1 #4127): a linked
  // pre-completion invoice carries no service_record_id until the closeout
  // writes it, so a review decision taken BEFORE the closeout would read it
  // as standalone and enroll an at-delivery ask — the one thing the quiet
  // closeout promises never to send.
  test('the review decision waits for the invoice-issued closeout — a closeout that completed the visit suppresses the ask', async () => {
    closeOutVisitForIssuedInvoice.mockResolvedValueOnce({ closed: true, visitId: 'svc-1', resumed: false });
    mockSendSequence(scheduledInvoice({ service_record_id: null }));

    const result = await InvoiceService.sendViaSMSAndEmail('inv-1', { requestReview: true });

    expect(result.ok).toBe(true);
    expect(closeOutVisitForIssuedInvoice).toHaveBeenCalledWith({ invoiceId: 'inv-1', trigger: 'sent', actorTechnicianId: null });
    expect(ReviewService.enrollPostService).not.toHaveBeenCalled();
  });

  test('a PAID completion invoice whose record was committed by the quiet closeout never enrolls — provenance beats a closed: false verdict (pre-push P1 r7)', async () => {
    mockSendSequence(scheduledInvoice(), { status: 'paid' });
    closeOutVisitForIssuedInvoice.mockResolvedValueOnce({ closed: false, reason: 'visit_completed', visitId: 'svc-1' });
    issuedCloseoutOwnsRecord.mockResolvedValueOnce(true);

    const result = await InvoiceService.sendViaSMSAndEmail('inv-1', {});

    expect(result.ok).toBe(true);
    expect(issuedCloseoutOwnsRecord).toHaveBeenCalledWith('sr-1');
    expect(ReviewService.enrollPostService).not.toHaveBeenCalled();
  });

  test('a closeout that left the visit alone (gate off / refused) keeps the standalone at-delivery ask, decided after it', async () => {
    mockSendSequence(scheduledInvoice({ service_record_id: null }));

    const result = await InvoiceService.sendViaSMSAndEmail('inv-1', {});

    expect(result.ok).toBe(true);
    expect(closeOutVisitForIssuedInvoice).toHaveBeenCalledTimes(1);
    expect(ReviewService.enrollPostService).toHaveBeenCalledTimes(1);
    expect(closeOutVisitForIssuedInvoice.mock.invocationCallOrder[0])
      .toBeLessThan(ReviewService.enrollPostService.mock.invocationCallOrder[0]);
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
//   4. (review block, AFTER the invoice-issued closeout) invoice linkage re-read
// Every `invoices` read from call 3 on answers with the post-closeout row
// (`postCloseoutRead` overrides its linkage); other tables get a permissive chain.
function mockMarkDeliverySequence(invoice, { finalized = true, postCloseoutRead = {} } = {}) {
  db
    .mockReturnValueOnce(chain({ first: invoice }))
    .mockReturnValueOnce(
      chain({ returning: finalized ? [{ ...invoice, status: 'sent', scheduled_request_review: false }] : [] }),
    )
    .mockImplementation((table) => (table === 'invoices'
      ? chain({ first: { service_record_id: invoice.service_record_id, status: 'sent', ...postCloseoutRead } })
      : chain()));
}

describe('InvoiceService.markDeliverySent scheduled-review fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('unpaid COMPLETION invoice → review ask deferred to the paid webhook (Codex P1, PR #3104 r1)', async () => {
    mockMarkDeliverySequence(scheduledInvoice());

    const result = await InvoiceService.markDeliverySent('inv-1', {
      sms: true,
      email: true,
      source: 'project_report_with_invoice',
    });

    expect(result.status).toBe('sent');
    expect(ReviewService.enrollPostService).not.toHaveBeenCalled();
  });

  test('standalone invoice (no service record) still inherits the scheduled review request', async () => {
    mockMarkDeliverySequence(scheduledInvoice({ service_record_id: null }));

    const result = await InvoiceService.markDeliverySent('inv-1', {
      sms: true,
      email: true,
      source: 'project_report_with_invoice',
    });

    expect(result.status).toBe('sent');
    expect(ReviewService.enrollPostService).toHaveBeenCalledWith({
      customerId: 'cust-1',
      serviceRecordId: null,
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

    expect(ReviewService.enrollPostService).not.toHaveBeenCalled();
  });

  test('no stored flag → no review request', async () => {
    mockMarkDeliverySequence(
      scheduledInvoice({
        scheduled_request_review: false,
        scheduled_review_delay_minutes: null,
      }),
    );

    await InvoiceService.markDeliverySent('inv-1', { email: true });

    expect(ReviewService.enrollPostService).not.toHaveBeenCalled();
  });

  test('concurrent finalization won the race → no duplicate review request', async () => {
    mockMarkDeliverySequence(scheduledInvoice(), { finalized: false });

    await InvoiceService.markDeliverySent('inv-1', { email: true });

    expect(ReviewService.enrollPostService).not.toHaveBeenCalled();
  });

  test('non-finalizable status returns early without queueing', async () => {
    db.mockReturnValueOnce(chain({ first: scheduledInvoice({ status: 'paid' }) }));

    const result = await InvoiceService.markDeliverySent('inv-1', { email: true });

    expect(result.status).toBe('paid');
    expect(ReviewService.enrollPostService).not.toHaveBeenCalled();
    expect(closeOutVisitForIssuedInvoice).not.toHaveBeenCalled();
  });

  test('the review decision waits for the invoice-issued closeout — a closeout that completed the visit suppresses the ask (GitHub r4 P1 #4127)', async () => {
    closeOutVisitForIssuedInvoice.mockResolvedValueOnce({ closed: true, visitId: 'svc-1', resumed: false });
    mockMarkDeliverySequence(scheduledInvoice({ service_record_id: null }));

    const result = await InvoiceService.markDeliverySent('inv-1', {
      sms: true,
      source: 'scheduled_send',
      actorTechnicianId: 'staff-1',
    });

    expect(result.status).toBe('sent');
    expect(closeOutVisitForIssuedInvoice).toHaveBeenCalledWith({ invoiceId: 'inv-1', trigger: 'sent', actorTechnicianId: 'staff-1' });
    expect(ReviewService.enrollPostService).not.toHaveBeenCalled();
  });

  // GitHub r5 P1 #4127: the closeout can commit the record and this
  // invoice's back-link and then throw in post-commit work — it reports
  // closed: false and the attempt stays resumable. The review decision must
  // read the DURABLE linkage after the closeout, never the pre-closeout row
  // (which still says standalone).
  test('a closeout that committed the back-link but reported closed: false still defers — the linkage is re-read after it', async () => {
    closeOutVisitForIssuedInvoice.mockResolvedValueOnce({ closed: false, reason: 'error', visitId: 'svc-1' });
    mockMarkDeliverySequence(scheduledInvoice({ service_record_id: null }), { postCloseoutRead: { service_record_id: 'sr-new', status: 'sent' } });

    const result = await InvoiceService.markDeliverySent('inv-1', { sms: true, source: 'scheduled_send' });

    expect(result.status).toBe('sent');
    expect(closeOutVisitForIssuedInvoice).toHaveBeenCalledTimes(1);
    expect(ReviewService.enrollPostService).not.toHaveBeenCalled();
  });

  test('a closeout that left the visit alone keeps the standalone ask, decided after the closeout', async () => {
    mockMarkDeliverySequence(scheduledInvoice({ service_record_id: null }));

    await InvoiceService.markDeliverySent('inv-1', { sms: true, source: 'scheduled_send' });

    expect(closeOutVisitForIssuedInvoice).toHaveBeenCalledTimes(1);
    expect(ReviewService.enrollPostService).toHaveBeenCalledTimes(1);
    expect(closeOutVisitForIssuedInvoice.mock.invocationCallOrder[0])
      .toBeLessThan(ReviewService.enrollPostService.mock.invocationCallOrder[0]);
  });
});

describe('sendViaSMSAndEmail: nothing due on a pre-completion open-visit invoice (deposit-covered) — settle, never a $0 pay link (Codex P1 r7 #4131)', () => {
  const zeroDue = (over = {}) => ({ payer_statement_id: null, status: 'draft', total: 0, credit_applied: 0, scheduled_service_id: 'svc-1', service_record_id: null, ...over });
  let smsSpy;
  beforeEach(() => {
    jest.clearAllMocks();
    smsSpy = jest.spyOn(InvoiceService, 'sendViaSMS').mockResolvedValue({ sent: true, payUrl: 'https://pay.example/x' });
  });
  afterEach(() => jest.restoreAllMocks());

  test('settles through the zero-balance transition and reports it covered — no claim, no SMS, no email', async () => {
    db.mockReturnValueOnce(chain({ first: zeroDue() }));
    const settle = jest.spyOn(InvoiceService, 'settleZeroBalance').mockResolvedValue({ settled: true, invoice: { id: 'inv-1', status: 'prepaid' } });
    const result = await InvoiceService.sendViaSMSAndEmail('inv-1', {});
    expect(result).toMatchObject({ ok: true, settled_by_deposit: true, sms: { code: 'settled_by_deposit' }, email: { code: 'settled_by_deposit' } });
    expect(settle).toHaveBeenCalledWith('inv-1', db);
    expect(smsSpy).not.toHaveBeenCalled();
    expect(db).toHaveBeenCalledTimes(1); // the pre-check read only — the claim never ran
  });

  test('a refused or throwing settlement REFUSES the send (retryable code) instead of delivering', async () => {
    db.mockReturnValueOnce(chain({ first: zeroDue() }));
    jest.spyOn(InvoiceService, 'settleZeroBalance').mockResolvedValue({ settled: false, reason: 'followup_in_flight', retryable: true });
    expect(await InvoiceService.sendViaSMSAndEmail('inv-1', {})).toMatchObject({ ok: false, code: 'deposit_settlement_pending', error: expect.stringMatching(/followup_in_flight/) });
    db.mockReturnValueOnce(chain({ first: zeroDue() }));
    jest.spyOn(InvoiceService, 'settleZeroBalance').mockRejectedValue(new Error('deadlock detected'));
    expect(await InvoiceService.sendViaSMSAndEmail('inv-1', {})).toMatchObject({ ok: false, code: 'deposit_settlement_pending', error: expect.stringMatching(/deadlock detected/) });
    expect(smsSpy).not.toHaveBeenCalled();
  });

  test('a record-linked visit invoice is IN scope (the completion back-links the record before it delivers — Codex P1 r9)', async () => {
    db.mockReturnValueOnce(chain({ first: zeroDue({ service_record_id: 'sr-1' }) }));
    const settle = jest.spyOn(InvoiceService, 'settleZeroBalance').mockResolvedValue({ settled: true, invoice: { id: 'inv-1', status: 'prepaid' } });
    expect(await InvoiceService.sendViaSMSAndEmail('inv-1', {})).toMatchObject({ ok: true, settled_by_deposit: true });
    expect(settle).toHaveBeenCalledWith('inv-1', db);
    expect(smsSpy).not.toHaveBeenCalled();
  });

  test('scope: a balance due, an unlinked invoice, or a non-claimable status all take the normal path', async () => {
    const settle = jest.spyOn(InvoiceService, 'settleZeroBalance').mockResolvedValue({ settled: true });
    for (const row of [zeroDue({ total: 117 }), zeroDue({ scheduled_service_id: null }), zeroDue({ status: 'void' })]) {
      db.mockReset();
      // mockSendSequence's first read IS the pre-check: the merged row carries the scope fields.
      mockSendSequence({ ...scheduledInvoice(), ...row });
      await InvoiceService.sendViaSMSAndEmail('inv-1', {}).catch(() => {});
      expect(settle).not.toHaveBeenCalled();
    }
  });
});

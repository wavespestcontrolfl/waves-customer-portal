// Split PR 3 of #4963: a queued invoice notice (invoice_send_deferred) replays
// without the send claim its original attempt held. Each leg re-runs the
// claim-less invoice checks at its own provider boundary, under the invoice
// lock (withInvoiceDepositSettlement) for Text/App and under the Email
// authority's lock for Email.
jest.mock('../models/db', () => {
  const database = jest.fn();
  database.raw = jest.fn((sql) => sql);
  database.transaction = jest.fn(async (callback) => callback(database));
  return database;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async () => 'https://waves.test/l/invoice'),
  invoiceShortCodePrefix: jest.fn(() => 'wpc'),
}));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://waves.test' }));
jest.mock('../services/invoice-prepay', () => ({
  loadInvoiceAnnualPrepay: jest.fn(async () => null),
  buildPrepayCoverageSummary: jest.fn(),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  isTemplateActive: jest.fn(async () => true),
  getTemplate: jest.fn(async () => 'Your invoice is ready'),
}));
jest.mock('../services/invoice-followups', () => ({ scheduleForInvoice: jest.fn(async () => true) }));
jest.mock('../services/estimate-deposits', () => ({
  assertInvoiceDepositSettlementReady: jest.fn(async () => true),
  withInvoiceDepositSettlement: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/customer-credit', () => ({ autoApplyAccountCreditIfEnabled: jest.fn(async () => null) }));
jest.mock('../services/lead-estimate-link', () => ({ convertLeadFromEvent: jest.fn(async () => null) }));
jest.mock('../services/invoice-issued-closeout', () => ({ closeOutVisitForIssuedInvoice: jest.fn(async () => null) }));
jest.mock('../services/messaging/invoice-send-replay-eligibility', () => ({ invoiceSendRefusal: jest.fn() }));

const { withInvoiceDepositSettlement } = require('../services/estimate-deposits');
const { invoiceSendRefusal } = require('../services/messaging/invoice-send-replay-eligibility');
const InvoiceService = require('../services/invoice');

const meta = { invoice_id: 'inv-1', customer_id: 'cust-1', entry_point: 'invoice_send_deferred' };
const accepted = { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM1' };

describe('queued invoice notice: Text/App provider handoff', () => {
  const trx = { locked: true };

  beforeEach(() => {
    jest.clearAllMocks();
    withInvoiceDepositSettlement.mockImplementation(async (_invoiceId, callback) => callback(trx, { id: 'inv-1' }));
    invoiceSendRefusal.mockResolvedValue(null);
  });

  test('dispatches inside the invoice lock after the claim-less checks pass on the locked handle', async () => {
    const dispatch = jest.fn(async () => accepted);
    await expect(InvoiceService.withDeferredInvoiceProviderHandoff(meta, dispatch)).resolves.toEqual(accepted);
    expect(withInvoiceDepositSettlement).toHaveBeenCalledWith('inv-1', expect.any(Function));
    expect(invoiceSendRefusal).toHaveBeenCalledWith(
      expect.objectContaining({ invoice_id: 'inv-1', customer_id: 'cust-1', source_entry_point: 'invoice_send_deferred' }), trx);
    expect(invoiceSendRefusal.mock.invocationCallOrder[0]).toBeLessThan(dispatch.mock.invocationCallOrder[0]);
  });

  test.each([
    ['a terminal refusal', { eligible: false, reason: 'invoice-terminal:void', retryable: false }],
    ['a retryable refusal', { eligible: false, reason: 'billing-email-eligibility-unavailable', retryable: true }],
  ])('%s never reaches the provider and keeps its retry flag', async (_label, refusal) => {
    invoiceSendRefusal.mockResolvedValue(refusal);
    const dispatch = jest.fn();
    await expect(InvoiceService.withDeferredInvoiceProviderHandoff(meta, dispatch)).resolves.toEqual(expect.objectContaining({
      sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'INVOICE_REPLAY_INELIGIBLE',
      reason: refusal.reason, retryable: refusal.retryable,
    }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('a lock conflict before the provider call is a retry, not a dropped notice', async () => {
    withInvoiceDepositSettlement.mockRejectedValue(Object.assign(new Error('This invoice is being updated'), { code: 'INVOICE_BUSY_RETRY' }));
    const dispatch = jest.fn();
    await expect(InvoiceService.withDeferredInvoiceProviderHandoff(meta, dispatch)).resolves.toEqual(expect.objectContaining({
      sent: false, deliveryOutcome: 'not_sent', code: 'INVOICE_BUSY_RETRY', retryable: true,
    }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('a failure after the provider call started stays uncertain and is never retried', async () => {
    withInvoiceDepositSettlement.mockImplementation(async (_invoiceId, callback) => {
      await callback(trx, { id: 'inv-1' });
      throw new Error('connection lost at commit');
    });
    const dispatch = jest.fn(async () => ({ sent: false, deliveryOutcome: 'not_sent' }));
    await expect(InvoiceService.withDeferredInvoiceProviderHandoff(meta, dispatch)).resolves.toEqual(expect.objectContaining({
      sent: false, deliveryOutcome: 'uncertain', retryable: false,
    }));
  });

  test('an accepted send survives a failed commit', async () => {
    withInvoiceDepositSettlement.mockImplementation(async (_invoiceId, callback) => {
      await callback(trx, { id: 'inv-1' });
      throw new Error('connection lost at commit');
    });
    await expect(InvoiceService.withDeferredInvoiceProviderHandoff(meta, jest.fn(async () => accepted)))
      .resolves.toEqual(expect.objectContaining({ ...accepted, settlementHandoffError: 'connection lost at commit' }));
  });

  test('a row without its invoice is refused before any lock', async () => {
    const dispatch = jest.fn();
    await expect(InvoiceService.withDeferredInvoiceProviderHandoff({ customer_id: 'cust-1' }, dispatch))
      .resolves.toEqual(expect.objectContaining({ sent: false, code: 'INVOICE_UNREADABLE' }));
    expect(withInvoiceDepositSettlement).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('queued invoice notice: Email leg check under the Email authority lock', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invoiceSendRefusal.mockResolvedValue(null);
  });

  test('passes on the authority transaction it is given', async () => {
    await expect(InvoiceService.checkDeferredInvoiceEmailDelivery(meta, { channel: 'email', database: 'authority-trx' }))
      .resolves.toEqual({ ok: true });
    expect(invoiceSendRefusal).toHaveBeenCalledWith(
      expect.objectContaining({ invoice_id: 'inv-1', source_entry_point: 'invoice_send_deferred' }), 'authority-trx');
  });

  test('refuses to read the invoice without the lock', async () => {
    await expect(InvoiceService.checkDeferredInvoiceEmailDelivery(meta, { channel: 'email' }))
      .resolves.toEqual(expect.objectContaining({ ok: false, code: 'INVOICE_LOCK_UNAVAILABLE', retryable: true }));
    expect(invoiceSendRefusal).not.toHaveBeenCalled();
  });

  test('a refusal blocks the Email leg with its reason', async () => {
    invoiceSendRefusal.mockResolvedValue({ eligible: false, reason: 'payer-billed', retryable: false });
    await expect(InvoiceService.checkDeferredInvoiceEmailDelivery(meta, { database: 'authority-trx' }))
      .resolves.toEqual({ ok: false, code: 'INVOICE_REPLAY_INELIGIBLE', reason: 'payer-billed', retryable: false });
  });

  test('a failed read holds the Email leg for a retry', async () => {
    invoiceSendRefusal.mockRejectedValue(Object.assign(new Error('visit is being edited'), { code: 'visit_busy' }));
    await expect(InvoiceService.checkDeferredInvoiceEmailDelivery(meta, { database: 'authority-trx' }))
      .resolves.toEqual(expect.objectContaining({ ok: false, code: 'visit_busy', retryable: true }));
  });
});

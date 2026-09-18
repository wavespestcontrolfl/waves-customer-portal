jest.mock('../models/db', () => {
  const database = jest.fn();
  database.raw = jest.fn((sql) => sql);
  return database;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
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
  getTemplate: jest.fn(async () => 'Your invoice is ready: https://waves.test/l/invoice'),
}));
jest.mock('../services/invoice-followups', () => ({ scheduleForInvoice: jest.fn(async () => true) }));
jest.mock('../services/invoice-helpers', () => ({
  ...jest.requireActual('../services/invoice-helpers'),
  INVOICE_UPDATE_ALLOWED_FIELDS: [],
  INVOICE_UNCOLLECTIBLE_STATUSES: [],
  assertInvoiceVoidable: jest.fn(),
  invoiceAmountDue: (invoice) => Number(invoice.total) - Number(invoice.credit_applied || 0),
  formatCardLine: jest.fn(),
  preserveWithdrawalStamp: jest.fn(() => null),
  selfPayAtDispatch: jest.fn(() => async () => ({ ok: true })),
}));
jest.mock('../services/estimate-deposits', () => ({
  assertInvoiceDepositSettlementReady: jest.fn(async () => true),
  withInvoiceDepositSettlement: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/customer-credit', () => ({
  autoApplyAccountCreditIfEnabled: jest.fn(async () => null),
}));
jest.mock('../services/lead-estimate-link', () => ({ convertLeadFromEvent: jest.fn(async () => null) }));
jest.mock('../services/invoice-issued-closeout', () => ({ closeOutVisitForIssuedInvoice: jest.fn(async () => null) }));

const db = require('../models/db');
const { withInvoiceDepositSettlement } = require('../services/estimate-deposits');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const InvoiceService = require('../services/invoice');

function query({ first } = {}) {
  const q = {};
  for (const method of ['where', 'whereIn', 'update', 'insert']) {
    q[method] = jest.fn(() => q);
  }
  q.first = jest.fn(async () => first);
  q.then = (resolve, reject) => Promise.resolve(1).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(1).catch(reject);
  return q;
}

describe('invoice SMS provider handoff', () => {
  const invoice = {
    id: 'inv-1',
    invoice_number: 'WPC-2026-1234',
    customer_id: 'cust-1',
    status: 'sending',
    send_claim_token: 'claim-1',
    total: '100.00',
    credit_applied: 0,
    token: 'invoice-token',
    service_type: 'Quarterly Pest Control',
    service_date: '2026-09-01',
    line_items: [{ description: 'Service', amount: 100 }],
  };
  let invoiceReads;

  beforeEach(() => {
    jest.clearAllMocks();
    invoiceReads = [invoice, invoice];
    db.mockImplementation((table) => {
      if (table === 'invoices') return query({ first: invoiceReads.shift() || invoice });
      if (table === 'customers') {
        return query({ first: { id: 'cust-1', first_name: 'Pat', phone: '+19415550101' } });
      }
      if (table === 'activity_log') return query();
      throw new Error(`Unexpected table: ${table}`);
    });
  });

  test('a commit failure after provider acceptance stays delivered and does not dispatch twice', async () => {
    const providerOutcome = {
      sent: true,
      blocked: false,
      channel: 'push',
      deliveryOutcome: 'provider_accepted',
      providerMessageId: 'push-accepted-1',
    };
    const dispatch = jest.fn(async () => providerOutcome);
    sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => withProviderHandoff(dispatch));
    withInvoiceDepositSettlement.mockImplementation(async (_invoiceId, callback) => {
      await callback(db, invoice);
      throw new Error('commit connection lost');
    });

    await expect(InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' }))
      .resolves.toMatchObject({ sent: true, payUrl: 'https://waves.test/l/invoice' });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(require('../services/logger').error).toHaveBeenCalledWith(
      expect.stringContaining('Provider outcome known for inv-1'),
    );
  });

  test('uses the fresh pre-handoff row after a partial credit applied behind the claim snapshot', async () => {
    const credited = {
      ...invoice,
      total: '75.00',
      line_items: [...invoice.line_items, { category: 'account_credit', amount: -25 }],
    };
    invoiceReads = [invoice, credited];
    const dispatch = jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted' }));
    sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => withProviderHandoff(dispatch));
    withInvoiceDepositSettlement.mockImplementation(async (_invoiceId, callback) => callback(db, credited));

    await expect(InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' }))
      .resolves.toMatchObject({ sent: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test('does not deliver a pay link when full credit landed before zero-balance close', async () => {
    const covered = {
      ...invoice,
      total: '0.00',
      line_items: [...invoice.line_items, { category: 'deposit_credit', amount: -100 }],
    };
    invoiceReads = [invoice, covered];
    const dispatch = jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted' }));
    sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => withProviderHandoff(dispatch));
    withInvoiceDepositSettlement.mockImplementation(async (_invoiceId, callback) => callback(db, covered));

    await expect(InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' }))
      .rejects.toMatchObject({ code: 'INVOICE_BALANCE_CHANGED' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('blocks the provider handoff when the linked visit was cancelled during preparation', async () => {
    const cancelled = { ...invoice, scheduled_service_id: 'svc-cancelled' };
    invoiceReads = [cancelled, cancelled];
    jest.spyOn(require('../services/invoice-helpers'), 'visitRefusesSettlement')
      .mockResolvedValueOnce('cancelled');
    const dispatch = jest.fn(async () => ({ sent: true }));
    sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => withProviderHandoff(dispatch));
    withInvoiceDepositSettlement.mockImplementation(async (_invoiceId, callback) => callback(db, cancelled));

    await expect(InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' }))
      .rejects.toMatchObject({ code: 'INVOICE_VISIT_TERMINAL' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('finishes direct-send bookkeeping when the finalize committed but its acknowledgement was lost', async () => {
    const state = { ...invoice, status: 'draft', send_claim_token: null };
    const ackLost = new Error('synthetic finalize acknowledgement lost');
    let failFinalizeAck = true;
    const invoiceQuery = () => {
      const filters = [];
      let count = 1;
      let failure = null;
      const q = {};
      q.where = jest.fn((criteria) => { filters.push(criteria); return q; });
      q.whereIn = jest.fn((key, values) => { filters.push({ [key]: values }); return q; });
      const matches = () => filters.every((criteria) => Object.entries(criteria).every(([key, value]) => (
        Array.isArray(value) ? value.includes(state[key]) : state[key] === value
      )));
      q.first = jest.fn(async () => (matches() ? { ...state } : undefined));
      q.update = jest.fn((payload) => {
        count = matches() ? 1 : 0;
        if (count) {
          for (const [key, value] of Object.entries(payload)) {
            state[key] = key === 'status' && String(value).startsWith('CASE WHEN')
              ? (['draft', 'scheduled', 'sending'].includes(state.status) ? 'sent' : state.status)
              : value;
          }
          if (payload.sms_sent_at && payload.status && failFinalizeAck) {
            failFinalizeAck = false;
            failure = ackLost;
          }
        }
        return q;
      });
      q.returning = jest.fn(async () => (count ? [{ ...state }] : []));
      q.then = (resolve, reject) => (failure ? Promise.reject(failure) : Promise.resolve(count)).then(resolve, reject);
      return q;
    };
    db.mockImplementation((table) => {
      if (table === 'invoices') return invoiceQuery();
      if (table === 'customers') return query({ first: { id: 'cust-1', first_name: 'Pat', phone: '+19415550101' } });
      if (table === 'activity_log') return query();
      throw new Error(`Unexpected table: ${table}`);
    });
    withInvoiceDepositSettlement.mockImplementation(async (_invoiceId, callback) => callback(db, { ...state }));
    const dispatch = jest.fn(async () => ({ sent: true, deliveryOutcome: 'provider_accepted' }));
    sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => withProviderHandoff(dispatch));

    await expect(InvoiceService.sendViaSMS('inv-1')).resolves.toMatchObject({
      sent: true,
      finalizeError: ackLost.message,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(require('../services/invoice-followups').scheduleForInvoice).toHaveBeenCalledTimes(1);
    expect(require('../services/lead-estimate-link').convertLeadFromEvent).toHaveBeenCalledTimes(1);
    expect(require('../services/invoice-issued-closeout').closeOutVisitForIssuedInvoice).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({ status: 'sent', send_claim_token: null });
  });
});

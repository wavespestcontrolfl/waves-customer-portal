jest.mock('../models/db', () => {
  const database = jest.fn();
  database.raw = jest.fn((sql) => sql);
  database.transaction = jest.fn(async (callback) => callback(database));
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
const { evaluateWhereRaw } = require('./helpers/sql-predicate');
const { withInvoiceDepositSettlement } = require('../services/estimate-deposits');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const InvoiceService = require('../services/invoice');

function query({ first, returning } = {}) {
  const q = {};
  for (const method of ['where', 'whereIn', 'whereRaw', 'whereNull', 'forUpdate', 'clone', 'update', 'insert']) {
    q[method] = jest.fn(() => q);
  }
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(async () => returning || []);
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
  // Every allowClaimed send now runs the queue-adoption reconcile
  // (reconcileQueuedSendUnderClaim), which reads sms_log for a live queued
  // pay-link text and, finding none, takes one extra 'invoices' read (the
  // adoption transaction's own owned-row check) before consuming any
  // still-scheduled row. consumedQueueRows lets a test simulate an
  // adopted row; queueQueries records every sms_log query issued.
  let consumedQueueRows;
  let queueQueries;

  beforeEach(() => {
    jest.clearAllMocks();
    invoiceReads = [invoice, invoice, invoice];
    consumedQueueRows = [];
    queueQueries = [];
    db.mockImplementation((table) => {
      if (table === 'invoices') return query({ first: invoiceReads.shift() || invoice });
      if (table === 'customers') {
        return query({ first: { id: 'cust-1', first_name: 'Pat', phone: '+19415550101' } });
      }
      if (table === 'activity_log') return query();
      if (table === 'sms_log') {
        const q = query({ returning: consumedQueueRows });
        queueQueries.push(q);
        return q;
      }
      throw new Error(`Unexpected table: ${table}`);
    });
  });

  test('a commit failure after provider acceptance stays delivered and does not dispatch twice', async () => {
    // This claim's adoption consumed an earlier queued pay-link text
    // (invoice_send_deferred). Provider acceptance below must RESOLVE that
    // obligation, not restore it — restoring it to 'scheduled' would leave a
    // second copy of the pay link queued for the morning send window.
    consumedQueueRows = [{ id: 'sms-adopted-1', scheduled_for: new Date('2026-09-01T12:00:00Z') }];
    invoiceReads = [invoice, invoice, invoice, invoice];
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
    // The adopted row was resolved (its pending marker cleared), never
    // restored to 'scheduled' — a live send actually delivered the text it
    // superseded.
    expect(queueQueries.some((q) => q.whereIn.mock.calls.some(
      ([field, ids]) => field === 'id' && ids.includes('sms-adopted-1'),
    ))).toBe(true);
    expect(queueQueries.some((q) => q.update.mock.calls.some(
      ([change]) => change.status === 'scheduled',
    ))).toBe(false);
  });

  test('a combined send stamps its accepted Text leg without finalizing before Email starts', async () => {
    const invoiceQueries = [];
    db.mockImplementation((table) => {
      if (table === 'invoices') {
        const q = query({ first: invoiceReads.shift() || invoice });
        invoiceQueries.push(q);
        return q;
      }
      if (table === 'customers') return query({ first: { id: 'cust-1', first_name: 'Pat', phone: '+19415550101' } });
      if (table === 'activity_log') return query();
      if (table === 'sms_log') return query({ returning: [] });
      throw new Error(`Unexpected table: ${table}`);
    });
    sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => withProviderHandoff(
      async () => ({ sent: true, deliveryOutcome: 'provider_accepted' }),
    ));
    withInvoiceDepositSettlement.mockImplementation(async (_invoiceId, callback) => callback(db, invoice));

    await expect(InvoiceService.sendViaSMS('inv-1', {
      allowClaimed: true,
      claimToken: 'claim-1',
      hasEmailLeg: true,
    })).resolves.toMatchObject({ sent: true });

    const deliveryStamp = invoiceQueries.flatMap((q) => q.update.mock.calls.map(([change]) => change))
      .find((change) => change.sms_sent_at);
    expect(deliveryStamp).toEqual(expect.objectContaining({ sms_sent_at: expect.any(Date) }));
    expect(deliveryStamp).not.toHaveProperty('status');
    expect(deliveryStamp).not.toHaveProperty('scheduled_send_at');
  });

  test('uses the fresh pre-handoff row after a partial credit applied behind the claim snapshot', async () => {
    const credited = {
      ...invoice,
      total: '75.00',
      line_items: [...invoice.line_items, { category: 'account_credit', amount: -25 }],
    };
    invoiceReads = [invoice, invoice, credited];
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
    invoiceReads = [invoice, invoice, covered];
    const dispatch = jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted' }));
    sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => withProviderHandoff(dispatch));
    withInvoiceDepositSettlement.mockImplementation(async (_invoiceId, callback) => callback(db, covered));

    await expect(InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' }))
      .rejects.toMatchObject({ code: 'INVOICE_BALANCE_CHANGED' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  // billingEmailPreSendCheck (send-customer-message.js:428) is the SAME
  // invoice guard withProviderHandoff runs, given to the explicit billing
  // Email leg instead — never that handoff itself, which would deadlock
  // against the Email authority's own lock on the same invoice row. It gets
  // its own database handle (the authority's locked trx in production;
  // here, a standalone double) rather than the claim-path `db` mock above,
  // pinning that it re-reads the invoice through exactly the handle it was
  // given.
  test('billingEmailPreSendCheck refuses when called without the locked handle', async () => {
    let captured;
    sendCustomerMessage.mockImplementation(async ({ billingEmailPreSendCheck }) => {
      captured = await billingEmailPreSendCheck({});
      return { sent: true, deliveryOutcome: 'accepted' };
    });
    await InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' });
    expect(captured).toMatchObject({ ok: false, code: 'INVOICE_LOCK_UNAVAILABLE', retryable: true });
  });

  test('billingEmailPreSendCheck (the explicit Email leg guard) passes when nothing changed, reading the invoice through its own given handle', async () => {
    const emailTrx = jest.fn((table) => {
      if (table === 'invoices') return query({ first: invoice });
      throw new Error(`Unexpected table: ${table}`);
    });
    let captured;
    sendCustomerMessage.mockImplementation(async ({ billingEmailPreSendCheck }) => {
      captured = await billingEmailPreSendCheck({ database: emailTrx });
      return { sent: true, deliveryOutcome: 'accepted' };
    });

    await expect(InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' }))
      .resolves.toMatchObject({ sent: true });
    expect(captured).toEqual({ ok: true });
    expect(emailTrx).toHaveBeenCalledWith('invoices');
  });

  test('billingEmailPreSendCheck blocks on INVOICE_BALANCE_CHANGED — the SAME code withProviderHandoff gives the SMS/App leg for this exact scenario above — when its own locked read finds the balance changed', async () => {
    const covered = {
      ...invoice,
      total: '0.00',
      line_items: [...invoice.line_items, { category: 'deposit_credit', amount: -100 }],
    };
    const emailTrx = jest.fn((table) => {
      if (table === 'invoices') return query({ first: covered });
      throw new Error(`Unexpected table: ${table}`);
    });
    let captured;
    sendCustomerMessage.mockImplementation(async ({ billingEmailPreSendCheck }) => {
      captured = await billingEmailPreSendCheck({ database: emailTrx });
      return { sent: true, deliveryOutcome: 'accepted' };
    });

    await expect(InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' }))
      .resolves.toMatchObject({ sent: true });
    expect(captured).toMatchObject({
      blocked: true, deliveryOutcome: 'not_sent', code: 'INVOICE_BALANCE_CHANGED',
      reason: 'Invoice balance changed while preparing delivery; retry send',
    });
  });

  test('billingEmailPreSendCheck blocks on send_claim_lost — the SAME code withProviderHandoff gives — when its own locked read finds a different send-claim token', async () => {
    const superseded = { ...invoice, send_claim_token: 'claim-2' };
    const emailTrx = jest.fn((table) => {
      if (table === 'invoices') return query({ first: superseded });
      throw new Error(`Unexpected table: ${table}`);
    });
    let captured;
    sendCustomerMessage.mockImplementation(async ({ billingEmailPreSendCheck }) => {
      captured = await billingEmailPreSendCheck({ database: emailTrx });
      return { sent: true, deliveryOutcome: 'accepted' };
    });

    await expect(InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' }))
      .resolves.toMatchObject({ sent: true });
    expect(captured).toMatchObject({ blocked: true, code: 'send_claim_lost' });
    expect(captured.ok).not.toBe(true);
  });

  test('blocks the provider handoff when the linked visit was cancelled during preparation', async () => {
    const cancelled = { ...invoice, scheduled_service_id: 'svc-cancelled' };
    invoiceReads = [cancelled, cancelled, cancelled];
    jest.spyOn(require('../services/invoice-helpers'), 'visitRefusesSettlement')
      .mockResolvedValueOnce('cancelled');
    const dispatch = jest.fn(async () => ({ sent: true }));
    sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => withProviderHandoff(dispatch));
    withInvoiceDepositSettlement.mockImplementation(async (_invoiceId, callback) => callback(db, cancelled));

    await expect(InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' }))
      .rejects.toMatchObject({ code: 'INVOICE_VISIT_TERMINAL' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('a throw after the provider boundary starts remains delivery-uncertain', async () => {
    const dispatchError = new Error('provider socket closed');
    sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => (
      withProviderHandoff(async () => { throw dispatchError; })
    ));
    withInvoiceDepositSettlement.mockImplementation(async (_invoiceId, callback) => callback(db, invoice));

    await expect(InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' }))
      .rejects.toMatchObject({ deliveryOutcome: 'uncertain' });
  });

  test('an explicit nested provider uncertainty is retained at the direct-send boundary', async () => {
    const providerError = Object.assign(new Error('provider wrapper failed'), {
      providerOutcome: { deliveryOutcome: 'uncertain' },
    });
    sendCustomerMessage.mockRejectedValueOnce(providerError);

    await expect(InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' }))
      .rejects.toMatchObject({
        deliveryOutcome: 'uncertain',
        providerOutcome: { deliveryOutcome: 'uncertain' },
      });
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
      // Round-2 Codex P1 (PR #4633): the claim's atomic flip now carries the
      // first-delivery/review-hold guards as REAL predicates on the UPDATE
      // itself (.whereNull/.whereRaw), not just the pre-claim snapshot —
      // this direct (non-allowClaimed) sendViaSMS call always runs that
      // flip, so this state machine needs both to actually evaluate.
      q.whereNull = jest.fn((col) => { filters.push((s) => s[col] == null); return q; });
      q.whereRaw = jest.fn((sql, bindings) => { filters.push((s) => evaluateWhereRaw(sql, bindings, s)); return q; });
      // The queue-adoption reconcile locks the row it just claimed
      // (`.forUpdate()`) before consuming any queued pay-link text — a
      // no-op here since this state machine has no real transaction.
      q.forUpdate = jest.fn(() => q);
      const matches = () => filters.every((criteria) => (
        typeof criteria === 'function'
          ? criteria(state)
          : Object.entries(criteria).every(([key, value]) => (
            Array.isArray(value) ? value.includes(state[key]) : state[key] === value
          ))
      ));
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
      // No queued pay-link text to adopt or restore in this scenario.
      if (table === 'sms_log') return query({ returning: [] });
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

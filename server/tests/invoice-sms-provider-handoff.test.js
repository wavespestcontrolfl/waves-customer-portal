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

  // Codex round-1 findings on PR #4963. P1: a phone-less customer whose
  // explicit invoice-channel selection includes Email must reach the
  // fan-out (the billing Email leg now resolves its own recipient from the
  // customer row, exactly like the pre-existing App/push leg) instead of
  // throwing "Customer has no phone number" before sendCustomerMessage is
  // ever called. P2: the fan-out's per-leg channelResults must stamp
  // email_sent_at for an accepted Email leg and sms_sent_at only for an
  // accepted Text/App leg — never sms_sent_at for an Email-only send.
  describe('Codex #4963 round 1: phone-less Email routing + per-channel delivery stamps', () => {
    test('a phone-less customer with an explicit Email selection reaches the fan-out instead of throwing', async () => {
      db.mockImplementation((table) => {
        if (table === 'invoices') return query({ first: invoiceReads.shift() || invoice });
        if (table === 'customers') {
          return query({ first: { id: 'cust-1', first_name: 'Pat', phone: null, email: 'pat@example.invalid' } });
        }
        if (table === 'notification_prefs') return query({ first: { customer_id: 'cust-1', invoice_channels: ['email'] } });
        if (table === 'activity_log') return query();
        if (table === 'sms_log') return query({ returning: [] });
        throw new Error(`Unexpected table: ${table}`);
      });
      sendCustomerMessage.mockImplementation(async () => ({
        sent: true, deliveryOutcome: 'accepted',
        channelResults: { email: { sent: true, deliveryOutcome: 'accepted' } },
      }));

      await expect(InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' }))
        .resolves.toMatchObject({ sent: true });
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      expect(sendCustomerMessage.mock.calls[0][0]).toMatchObject({ to: null });
    });

    test('a phone-less customer with no explicit billing-channel selection still throws (legacy, unchanged)', async () => {
      db.mockImplementation((table) => {
        if (table === 'invoices') return query({ first: invoiceReads.shift() || invoice });
        if (table === 'customers') return query({ first: { id: 'cust-1', first_name: 'Pat', phone: null } });
        // No notification_prefs row at all — explicitBillingChannels resolves
        // null (no explicit selection), the same legacy shape as today.
        if (table === 'notification_prefs') return query({ first: undefined });
        if (table === 'activity_log') return query();
        if (table === 'sms_log') return query({ returning: [] });
        throw new Error(`Unexpected table: ${table}`);
      });

      await expect(InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' }))
        .rejects.toThrow('Customer has no phone number');
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });

    test('a phone-less customer with only App (push) explicitly selected still reaches the fan-out (byte-identical to before)', async () => {
      db.mockImplementation((table) => {
        if (table === 'invoices') return query({ first: invoiceReads.shift() || invoice });
        if (table === 'customers') return query({ first: { id: 'cust-1', first_name: 'Pat', phone: null } });
        if (table === 'notification_prefs') return query({ first: { customer_id: 'cust-1', invoice_channels: ['push'] } });
        if (table === 'activity_log') return query();
        if (table === 'sms_log') return query({ returning: [] });
        throw new Error(`Unexpected table: ${table}`);
      });
      sendCustomerMessage.mockImplementation(async () => ({
        sent: true, deliveryOutcome: 'accepted',
        channelResults: { push: { sent: true, deliveryOutcome: 'accepted' } },
      }));

      await expect(InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' }))
        .resolves.toMatchObject({ sent: true });
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    });

    test('an Email-only accepted send stamps email_sent_at, not sms_sent_at', async () => {
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
      sendCustomerMessage.mockImplementation(async () => ({
        sent: true, deliveryOutcome: 'accepted',
        channelResults: { email: { sent: true, deliveryOutcome: 'accepted' } },
      }));

      await expect(InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' }))
        .resolves.toMatchObject({ sent: true });

      const deliveryStamp = invoiceQueries.flatMap((q) => q.update.mock.calls.map(([change]) => change))
        .find((change) => change.sent_at);
      expect(deliveryStamp).toBeTruthy();
      expect(deliveryStamp).toEqual(expect.objectContaining({ email_sent_at: expect.any(Date) }));
      expect(deliveryStamp).not.toHaveProperty('sms_sent_at');
    });

    test('an Email+Text accepted send stamps both email_sent_at and sms_sent_at', async () => {
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
      sendCustomerMessage.mockImplementation(async () => ({
        sent: true, deliveryOutcome: 'accepted',
        channelResults: {
          email: { sent: true, deliveryOutcome: 'accepted' },
          sms: { sent: true, deliveryOutcome: 'accepted' },
        },
      }));

      await expect(InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' }))
        .resolves.toMatchObject({ sent: true });

      const deliveryStamp = invoiceQueries.flatMap((q) => q.update.mock.calls.map(([change]) => change))
        .find((change) => change.sent_at);
      expect(deliveryStamp).toEqual(expect.objectContaining({
        email_sent_at: expect.any(Date), sms_sent_at: expect.any(Date),
      }));
    });

    test('an SMS-only accepted send stays byte-identical: stamps sms_sent_at, not email_sent_at', async () => {
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
      const dispatch = jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted' }));
      sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => withProviderHandoff(dispatch));
      withInvoiceDepositSettlement.mockImplementation(async (_invoiceId, callback) => callback(db, invoice));

      await expect(InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' }))
        .resolves.toMatchObject({ sent: true });

      const deliveryStamp = invoiceQueries.flatMap((q) => q.update.mock.calls.map(([change]) => change))
        .find((change) => change.sent_at);
      expect(deliveryStamp).toEqual(expect.objectContaining({ sms_sent_at: expect.any(Date) }));
      expect(deliveryStamp).not.toHaveProperty('email_sent_at');
    });
  });

  // Codex round-2 findings on PR #4963. P1: billing-channel-routing.js's
  // billingDispatchOutcome deliberately surfaces an UNFINISHED leg's own
  // retry/hold as the top-level sendResult when one leg (Email) accepted and
  // another (Text) still needs a retry — sendResult.sent stays false even
  // though Email genuinely delivered, which used to fall into the
  // full-failure branch and restore the claim (and could reverse applied
  // credit) out from under an already-delivered pay link. P2: the activity
  // log / info line must name the channel(s) that actually accepted, never
  // hardcode "SMS".
  describe('Codex #4963 round 2: a partially-accepted fan-out is finalized, never restored; activity log names the real channel(s)', () => {
    function invoiceQueryDb({ activityInserts, smsLogInserts, smsLogExisting = undefined } = {}) {
      const invoiceQueries = [];
      return {
        invoiceQueries,
        mock: (table) => {
          if (table === 'invoices') {
            const q = query({ first: invoiceReads.shift() || invoice });
            invoiceQueries.push(q);
            return q;
          }
          if (table === 'customers') return query({ first: { id: 'cust-1', first_name: 'Pat', phone: '+19415550101' } });
          if (table === 'activity_log') {
            const q = query();
            if (activityInserts) q.insert = jest.fn((row) => { activityInserts.push(row); return q; });
            return q;
          }
          if (table === 'sms_log') {
            const q = query({ first: smsLogExisting, returning: [] });
            if (smsLogInserts) q.insert = jest.fn((row) => { smsLogInserts.push(row); return q; });
            return q;
          }
          throw new Error(`Unexpected table: ${table}`);
        },
      };
    }
    // The one signal that distinguishes an actual claim RESTORE
    // (restoreSendClaim writes a bare `status: <previousStatus string>`)
    // from finalizeInvoiceAfterSms's own status write (always the mocked
    // db.raw(...) CASE WHEN string, which starts with "CASE WHEN").
    function claimWasRestored(invoiceQueries) {
      return invoiceQueries
        .flatMap((q) => q.update.mock.calls.map(([change]) => change))
        .some((change) => typeof change.status === 'string' && !change.status.startsWith('CASE WHEN'));
    }

    test('an accepted Email leg is finalized and never restores the claim when the Text leg still needs a retryable retry', async () => {
      const activityInserts = [];
      const { invoiceQueries, mock } = invoiceQueryDb({ activityInserts });
      db.mockImplementation(mock);
      sendCustomerMessage.mockImplementation(async () => ({
        sent: false, blocked: false, deliveryOutcome: 'not_sent',
        code: 'BILLING_CHANNEL_FAILED', reason: 'twilio unavailable', retryable: true,
        channelResults: {
          email: { sent: true, deliveryOutcome: 'accepted' },
          sms: { sent: false, blocked: false, deliveryOutcome: 'not_sent',
            code: 'BILLING_CHANNEL_FAILED', reason: 'twilio unavailable', retryable: true },
        },
      }));

      const result = await InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' });
      expect(result).toMatchObject({
        sent: true, pendingChannel: 'sms', pendingChannelCode: 'BILLING_CHANNEL_FAILED',
      });
      expect(claimWasRestored(invoiceQueries)).toBe(false);

      const deliveryStamp = invoiceQueries.flatMap((q) => q.update.mock.calls.map(([change]) => change))
        .find((change) => change.sent_at);
      expect(deliveryStamp).toEqual(expect.objectContaining({ email_sent_at: expect.any(Date) }));
      expect(deliveryStamp).not.toHaveProperty('sms_sent_at');
      expect(activityInserts[0]?.description).toMatch(/^Invoice WPC-2026-1234 sent via Email:/);
    });

    test('an accepted Email leg is finalized and never restores the claim when the Text leg returns a deferred replay hold (deferred + nextAllowedAt preserved)', async () => {
      const { invoiceQueries, mock } = invoiceQueryDb();
      db.mockImplementation(mock);
      const nextAllowedAt = new Date('2026-09-27T12:00:00.000Z').toISOString();
      sendCustomerMessage.mockImplementation(async () => ({
        sent: false, blocked: true, deliveryOutcome: 'not_sent',
        code: 'QUIET_HOURS_HOLD', reason: 'Automated SMS is limited to 8:00 AM-8:00 PM ET',
        retryable: true, deferred: true, nextAllowedAt,
        channelResults: {
          email: { sent: true, deliveryOutcome: 'accepted' },
          sms: { sent: false, blocked: true, deliveryOutcome: 'not_sent',
            code: 'QUIET_HOURS_HOLD', reason: 'Automated SMS is limited to 8:00 AM-8:00 PM ET',
            retryable: true, deferred: true, nextAllowedAt },
        },
      }));

      const result = await InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' });
      expect(result).toMatchObject({
        sent: true, pendingChannel: 'sms', pendingChannelCode: 'QUIET_HOURS_HOLD',
        pendingChannelDeferred: true, pendingChannelNextAllowedAt: nextAllowedAt,
      });
      expect(claimWasRestored(invoiceQueries)).toBe(false);
    });

    test('an accepted Email leg is finalized and never restores the claim when the Text leg outcome is uncertain (no double-send)', async () => {
      const { invoiceQueries, mock } = invoiceQueryDb();
      db.mockImplementation(mock);
      sendCustomerMessage.mockImplementation(async () => ({
        sent: false, blocked: false, deliveryOutcome: 'uncertain',
        code: 'INVOICE_PROVIDER_OUTCOME_UNCERTAIN', reason: 'provider socket closed',
        channelResults: {
          email: { sent: true, deliveryOutcome: 'accepted' },
          sms: { sent: false, blocked: false, deliveryOutcome: 'uncertain',
            code: 'INVOICE_PROVIDER_OUTCOME_UNCERTAIN', reason: 'provider socket closed' },
        },
      }));

      const result = await InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' });
      expect(result).toMatchObject({ sent: true, pendingChannel: 'sms' });
      expect(claimWasRestored(invoiceQueries)).toBe(false);
    });

    test('a full fan-out failure (nothing accepted) still throws through the ordinary failure path, byte-identical to before', async () => {
      const { mock } = invoiceQueryDb();
      db.mockImplementation(mock);
      sendCustomerMessage.mockImplementation(async () => ({
        sent: false, blocked: true, deliveryOutcome: 'not_sent',
        code: 'BILLING_CHANNEL_FAILED', reason: 'both legs failed', retryable: true,
        channelResults: {
          email: { sent: false, blocked: false, deliveryOutcome: 'not_sent',
            code: 'BILLING_CHANNEL_FAILED', reason: 'email failed', retryable: true },
          sms: { sent: false, blocked: false, deliveryOutcome: 'not_sent',
            code: 'BILLING_CHANNEL_FAILED', reason: 'sms failed', retryable: true },
        },
      }));

      // anyChannelAccepted correctly reads false here (not just checking
      // !sendResult.sent), so nothing accepted still throws through the SAME
      // full-failure branch as before this fix — its own restore/credit-
      // reversal bookkeeping (claimInvoiceForSend's previousStatus) is
      // already covered by the other tests in this file (e.g. the
      // commit-failure and terminal-visit cases above) and unrelated to
      // this fix, which only changes what happens when a leg WAS accepted.
      await expect(InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' }))
        .rejects.toMatchObject({ code: 'BILLING_CHANNEL_FAILED' });
    });

    test('an Email+Text accepted send logs the activity entry as "sent via Email and SMS"', async () => {
      const activityInserts = [];
      const { mock } = invoiceQueryDb({ activityInserts });
      db.mockImplementation(mock);
      sendCustomerMessage.mockImplementation(async () => ({
        sent: true, deliveryOutcome: 'accepted',
        channelResults: {
          email: { sent: true, deliveryOutcome: 'accepted' },
          sms: { sent: true, deliveryOutcome: 'accepted' },
        },
      }));

      await expect(InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' }))
        .resolves.toMatchObject({ sent: true });
      expect(activityInserts[0]?.description).toMatch(/^Invoice WPC-2026-1234 sent via Email and SMS:/);
    });

    test('an App-only (push) accepted send logs the activity entry as "sent via App", not "SMS"', async () => {
      const activityInserts = [];
      const { mock } = invoiceQueryDb({ activityInserts });
      db.mockImplementation(mock);
      sendCustomerMessage.mockImplementation(async () => ({
        sent: true, deliveryOutcome: 'accepted',
        channelResults: { push: { sent: true, deliveryOutcome: 'accepted' } },
      }));

      await expect(InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' }))
        .resolves.toMatchObject({ sent: true });
      expect(activityInserts[0]?.description).toMatch(/^Invoice WPC-2026-1234 sent via App:/);
    });

    test('a plain SMS-only send (no fan-out at all) keeps the byte-identical "sent via SMS" wording', async () => {
      const activityInserts = [];
      const { mock } = invoiceQueryDb({ activityInserts });
      db.mockImplementation(mock);
      const dispatch = jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted' }));
      sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => withProviderHandoff(dispatch));
      withInvoiceDepositSettlement.mockImplementation(async (_invoiceId, callback) => callback(db, invoice));

      await expect(InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' }))
        .resolves.toMatchObject({ sent: true });
      expect(activityInserts[0]?.description).toBe('Invoice WPC-2026-1234 sent via SMS: $100');
    });
  });

  // Codex round-3 P1 on PR #4963 (the pre-push audit): the round-2 fix
  // surfaced a pending leg on the result but never actually retried it —
  // "any such caller will treat the send as fully sent:true and silently
  // never deliver the pending channel". Fixed by queueing exactly one
  // invoice_send_deferred replay row (the SAME rail sendViaSMSAndEmail's
  // own held-SMS-leg queue uses) whenever the pending leg is genuinely
  // retryable or a deferred hold — never for `uncertain` (a retry could
  // double-send) and never for a permanently blocked leg (no
  // retryable/deferred flag — retrying it would just fail the same way).
  describe('Codex #4963 round 3: a pending leg after a partial accept is queued for retry, not silently dropped', () => {
    function invoiceQueryDb({ smsLogInserts, smsLogExisting } = {}) {
      const invoiceQueries = [];
      return {
        invoiceQueries,
        mock: (table) => {
          if (table === 'invoices') {
            const q = query({ first: invoiceReads.shift() || invoice });
            invoiceQueries.push(q);
            return q;
          }
          if (table === 'customers') return query({ first: { id: 'cust-1', first_name: 'Pat', phone: '+19415550101' } });
          if (table === 'activity_log') return query();
          if (table === 'sms_log') {
            const q = query({ first: smsLogExisting, returning: [] });
            if (smsLogInserts) q.insert = jest.fn((row) => { smsLogInserts.push(row); return q; });
            return q;
          }
          throw new Error(`Unexpected table: ${table}`);
        },
      };
    }

    test.each([
      ['uncertain first', ['push', 'sms']],
      ['retryable first', ['sms', 'push']],
    ])('an uncertain sibling blocks the requeue whatever the leg order (%s)', async (_label, order) => {
      const smsLogInserts = [];
      const { mock } = invoiceQueryDb({ smsLogInserts });
      db.mockImplementation(mock);
      const legs = {
        push: { sent: false, deliveryOutcome: 'uncertain', retryable: true, code: 'APP_OUTCOME_UNCERTAIN' },
        sms: { sent: false, blocked: false, deliveryOutcome: 'not_sent', code: 'BILLING_CHANNEL_FAILED', retryable: true },
      };
      const channelResults = { email: { sent: true, deliveryOutcome: 'accepted' } };
      order.forEach((k) => { channelResults[k] = legs[k]; });
      sendCustomerMessage.mockImplementation(async () => ({
        sent: false, blocked: false, deliveryOutcome: 'uncertain', code: 'APP_OUTCOME_UNCERTAIN', retryable: true, channelResults,
      }));
      const result = await InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' });
      expect(result).toMatchObject({ sent: true, pendingChannel: 'push', pendingChannelQueued: false });
      expect(smsLogInserts).toHaveLength(0);
    });

    test('a queued replay keeps Email in its fan-out when no Email leg was accepted', async () => {
      const smsLogInserts = [];
      const { mock } = invoiceQueryDb({ smsLogInserts });
      db.mockImplementation(mock);
      sendCustomerMessage.mockImplementation(async () => ({
        sent: false, blocked: false, deliveryOutcome: 'not_sent',
        code: 'BILLING_CHANNEL_FAILED', reason: 'twilio unavailable', retryable: true,
        channelResults: {
          push: { sent: true, deliveryOutcome: 'accepted' },
          sms: { sent: false, blocked: false, deliveryOutcome: 'not_sent',
            code: 'BILLING_CHANNEL_FAILED', reason: 'twilio unavailable', retryable: true },
        },
      }));
      const result = await InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' });
      expect(result).toMatchObject({ sent: true, pendingChannel: 'sms', pendingChannelQueued: true });
      expect(smsLogInserts).toHaveLength(1);
      expect(JSON.parse(smsLogInserts[0].metadata).hasEmailLeg).toBeUndefined();
    });

    test('a retryable pending Text leg is queued as one invoice_send_deferred row; invoice finalized; no claim restore', async () => {
      const smsLogInserts = [];
      const { mock } = invoiceQueryDb({ smsLogInserts });
      db.mockImplementation(mock);
      sendCustomerMessage.mockImplementation(async () => ({
        sent: false, blocked: false, deliveryOutcome: 'not_sent',
        code: 'BILLING_CHANNEL_FAILED', reason: 'twilio unavailable', retryable: true,
        channelResults: {
          email: { sent: true, deliveryOutcome: 'accepted' },
          sms: { sent: false, blocked: false, deliveryOutcome: 'not_sent',
            code: 'BILLING_CHANNEL_FAILED', reason: 'twilio unavailable', retryable: true },
        },
      }));

      const before = Date.now();
      const result = await InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' });
      expect(result).toMatchObject({
        sent: true, pendingChannel: 'sms', pendingChannelCode: 'BILLING_CHANNEL_FAILED', pendingChannelQueued: true,
      });

      expect(smsLogInserts).toHaveLength(1);
      const row = smsLogInserts[0];
      expect(row.to_phone).toBe('+19415550101');
      expect(row.status).toBe('scheduled');
      expect(row.message_body).toEqual(expect.any(String));
      expect(row.message_body.length).toBeGreaterThan(0);
      const meta = JSON.parse(row.metadata);
      expect(meta).toMatchObject({
        entry_point: 'invoice_send_deferred',
        invoice_id: 'inv-1',
        billingDeliveryCategory: 'invoice',
        notificationEventKey: 'invoice:inv-1:sent',
        hasEmailLeg: true,
        original_block_code: 'BILLING_CHANNEL_FAILED',
        replay_purpose: 'payment_link',
        refresh_customer_phone: true,
        resolve_from_by_customer: true,
      });
      // A phoned row never carries the phone-less replay marker.
      expect(meta.requires_registered_dispatch).toBeUndefined();
      // No explicit nextAllowedAt on a plain retryable — falls back to the
      // ~5-minute default backoff, not immediate and not indefinitely far.
      const scheduledForMs = new Date(row.scheduled_for).getTime();
      expect(scheduledForMs).toBeGreaterThan(before);
      expect(scheduledForMs).toBeLessThanOrEqual(before + 6 * 60 * 1000);
    });

    test('an Email-accepted + deferred-hold Text leg queues the row at nextAllowedAt', async () => {
      const smsLogInserts = [];
      const { mock } = invoiceQueryDb({ smsLogInserts });
      db.mockImplementation(mock);
      const nextAllowedAt = new Date('2026-09-27T12:00:00.000Z').toISOString();
      sendCustomerMessage.mockImplementation(async () => ({
        sent: false, blocked: true, deliveryOutcome: 'not_sent',
        code: 'QUIET_HOURS_HOLD', reason: 'Automated SMS is limited to 8:00 AM-8:00 PM ET',
        retryable: true, deferred: true, nextAllowedAt,
        channelResults: {
          email: { sent: true, deliveryOutcome: 'accepted' },
          sms: { sent: false, blocked: true, deliveryOutcome: 'not_sent',
            code: 'QUIET_HOURS_HOLD', reason: 'Automated SMS is limited to 8:00 AM-8:00 PM ET',
            retryable: true, deferred: true, nextAllowedAt },
        },
      }));

      const result = await InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' });
      expect(result).toMatchObject({ sent: true, pendingChannel: 'sms', pendingChannelQueued: true });
      expect(smsLogInserts).toHaveLength(1);
      expect(new Date(smsLogInserts[0].scheduled_for).toISOString()).toBe(nextAllowedAt);
    });

    test('an uncertain pending Text leg is surfaced but never queued (no double-send)', async () => {
      const smsLogInserts = [];
      const { mock } = invoiceQueryDb({ smsLogInserts });
      db.mockImplementation(mock);
      sendCustomerMessage.mockImplementation(async () => ({
        sent: false, blocked: false, deliveryOutcome: 'uncertain',
        code: 'INVOICE_PROVIDER_OUTCOME_UNCERTAIN', reason: 'provider socket closed',
        channelResults: {
          email: { sent: true, deliveryOutcome: 'accepted' },
          sms: { sent: false, blocked: false, deliveryOutcome: 'uncertain',
            code: 'INVOICE_PROVIDER_OUTCOME_UNCERTAIN', reason: 'provider socket closed' },
        },
      }));

      const result = await InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' });
      expect(result).toMatchObject({ sent: true, pendingChannel: 'sms' });
      expect(result.pendingChannelQueued).not.toBe(true);
      expect(smsLogInserts).toHaveLength(0);
    });

    test('a permanently blocked pending leg (no retryable/deferred flag) is surfaced but never queued', async () => {
      const smsLogInserts = [];
      const { mock } = invoiceQueryDb({ smsLogInserts });
      db.mockImplementation(mock);
      sendCustomerMessage.mockImplementation(async () => ({
        sent: false, blocked: true, deliveryOutcome: 'not_sent',
        code: 'MISSING_SMS_RECIPIENT', reason: 'Text is selected but no phone recipient is available',
        channelResults: {
          email: { sent: true, deliveryOutcome: 'accepted' },
          sms: { sent: false, blocked: true, deliveryOutcome: 'not_sent',
            code: 'MISSING_SMS_RECIPIENT', reason: 'Text is selected but no phone recipient is available' },
        },
      }));

      const result = await InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' });
      expect(result).toMatchObject({ sent: true, pendingChannel: 'sms', pendingChannelCode: 'MISSING_SMS_RECIPIENT' });
      expect(result.pendingChannelQueued).not.toBe(true);
      expect(smsLogInserts).toHaveLength(0);
    });

    test('an already-queued row is adopted, never duplicated', async () => {
      const smsLogInserts = [];
      // claimInvoiceForSend runs its OWN live-queue pre-check against
      // sms_log first (entry_point = ANY(...), a DIFFERENT query shape) —
      // only the pending-channel dedup check itself (a single entry_point
      // equality on invoice_send_deferred) should find the existing row, or
      // the claim step above it would see a false live-queue conflict.
      db.mockImplementation((table) => {
        if (table === 'invoices') return query({ first: invoiceReads.shift() || invoice });
        if (table === 'customers') return query({ first: { id: 'cust-1', first_name: 'Pat', phone: '+19415550101' } });
        if (table === 'activity_log') return query();
        if (table === 'sms_log') {
          const whereRawCalls = [];
          const q = query({ returning: [] });
          q.whereRaw = jest.fn((sql, params) => { whereRawCalls.push({ sql, params }); return q; });
          q.first = jest.fn(async () => {
            const isPendingChannelDedupCheck = whereRawCalls.some(
              (c) => c.sql.includes("entry_point' = ?") && c.params?.[0] === 'invoice_send_deferred',
            );
            return isPendingChannelDedupCheck ? { id: 'sms-log-existing-1' } : undefined;
          });
          q.insert = jest.fn((row) => { smsLogInserts.push(row); return q; });
          return q;
        }
        throw new Error(`Unexpected table: ${table}`);
      });
      sendCustomerMessage.mockImplementation(async () => ({
        sent: false, blocked: false, deliveryOutcome: 'not_sent',
        code: 'BILLING_CHANNEL_FAILED', reason: 'twilio unavailable', retryable: true,
        channelResults: {
          email: { sent: true, deliveryOutcome: 'accepted' },
          sms: { sent: false, blocked: false, deliveryOutcome: 'not_sent',
            code: 'BILLING_CHANNEL_FAILED', reason: 'twilio unavailable', retryable: true },
        },
      }));

      const result = await InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' });
      expect(result).toMatchObject({ sent: true, pendingChannel: 'sms', pendingChannelQueued: true });
      expect(smsLogInserts).toHaveLength(0);
    });

    test('SMS-only paths are unchanged: no pending channel, nothing queued', async () => {
      const smsLogInserts = [];
      const { mock } = invoiceQueryDb({ smsLogInserts });
      db.mockImplementation(mock);
      const dispatch = jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted' }));
      sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => withProviderHandoff(dispatch));
      withInvoiceDepositSettlement.mockImplementation(async (_invoiceId, callback) => callback(db, invoice));

      const result = await InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' });
      expect(result).toMatchObject({ sent: true });
      expect(result.pendingChannel).toBeUndefined();
      expect(smsLogInserts).toHaveLength(0);
    });
  });

  // Codex round-3 pre-push audit findings on PR #4963.
  // P1 (invoice.js:2225 at the time): requires_registered_dispatch was
  // stamped on every queued row, but deferred-replay-registry.js's
  // invoice_send_deferred entry has no `dispatch`, so dispatchDeferredReplay
  // (scheduler.js) returns DEFERRED_DISPATCH_UNAVAILABLE forever without
  // ever calling sendCustomerMessage. Fixed by NOT stamping it (phoned or
  // phone-less) until PR #4958 lands a dispatchDeferredReplay signature the
  // registry entry can safely use.
  // P2 (invoice.js:5503 at the time): a queue-insert failure was only
  // logged, never retried or durably marked — the pending leg silently
  // vanished while the result still reported sent:true. Fixed by moving the
  // enqueue INTO finalizeInvoiceAfterSms's own transaction, so it commits or
  // fails together with the delivery stamp and is retried by the SAME
  // already-existing post-delivery-bookkeeping-failure mechanism.
  describe('Codex #4963 round 3 pre-push audit: requires_registered_dispatch deferred; a queue-insert failure is retried, never silently dropped', () => {
    function invoiceQueryDb({ smsLogInserts, smsLogInsertFailCount = 0, customerPhone = '+19415550101', activityInserts } = {}) {
      const invoiceQueries = [];
      let smsLogInsertAttempts = 0;
      return {
        invoiceQueries,
        mock: (table) => {
          if (table === 'invoices') {
            const q = query({ first: invoiceReads.shift() || invoice });
            invoiceQueries.push(q);
            return q;
          }
          if (table === 'customers') return query({ first: { id: 'cust-1', first_name: 'Pat', phone: customerPhone } });
          // Only reached for a phone-less customer (explicitBillingAppSelected's
          // pre-routing check) — an explicit App/push selection.
          if (table === 'notification_prefs') return query({ first: { customer_id: 'cust-1', invoice_channels: ['push'] } });
          if (table === 'activity_log') {
            const q = query();
            if (activityInserts) q.insert = jest.fn((row) => { activityInserts.push(row); return q; });
            return q;
          }
          if (table === 'sms_log') {
            const q = query({ returning: [] });
            q.insert = jest.fn((row) => {
              smsLogInsertAttempts += 1;
              if (smsLogInsertAttempts <= smsLogInsertFailCount) {
                throw new Error(`synthetic sms_log insert failure (attempt ${smsLogInsertAttempts})`);
              }
              if (smsLogInserts) smsLogInserts.push(row);
              return q;
            });
            return q;
          }
          throw new Error(`Unexpected table: ${table}`);
        },
      };
    }
    const pendingSmsChannelResults = () => ({
      email: { sent: true, deliveryOutcome: 'accepted' },
      sms: { sent: false, blocked: false, deliveryOutcome: 'not_sent',
        code: 'BILLING_CHANNEL_FAILED', reason: 'twilio unavailable', retryable: true },
    });

    test('a phoned pending-leg row is queued without requires_registered_dispatch', async () => {
      const smsLogInserts = [];
      const { mock } = invoiceQueryDb({ smsLogInserts });
      db.mockImplementation(mock);
      sendCustomerMessage.mockImplementation(async () => ({
        sent: false, blocked: false, deliveryOutcome: 'not_sent',
        code: 'BILLING_CHANNEL_FAILED', reason: 'twilio unavailable', retryable: true,
        channelResults: pendingSmsChannelResults(),
      }));

      const result = await InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' });
      expect(result).toMatchObject({ sent: true, pendingChannelQueued: true });
      expect(smsLogInserts).toHaveLength(1);
      expect(JSON.parse(smsLogInserts[0].metadata).requires_registered_dispatch).toBeUndefined();
    });

    test('a phone-less pending App-leg row is queued with requires_registered_dispatch so it replays without a phone', async () => {
      const smsLogInserts = [];
      const { mock } = invoiceQueryDb({ smsLogInserts, customerPhone: null });
      db.mockImplementation(mock);
      sendCustomerMessage.mockImplementation(async () => ({
        sent: false, blocked: false, deliveryOutcome: 'not_sent',
        code: 'APP_PROVIDER_RETRY', reason: 'push provider retry', retryable: true,
        channelResults: {
          email: { sent: true, deliveryOutcome: 'accepted' },
          push: { sent: false, blocked: false, deliveryOutcome: 'not_sent',
            code: 'APP_PROVIDER_RETRY', reason: 'push provider retry', retryable: true },
        },
      }));

      const result = await InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' });
      expect(result).toMatchObject({ sent: true, pendingChannel: 'push', pendingChannelQueued: true });
      expect(smsLogInserts).toHaveLength(1);
      expect(smsLogInserts[0].to_phone).toBe('');
      expect(JSON.parse(smsLogInserts[0].metadata).requires_registered_dispatch).toBe(true);
    });

    test('a transient queue-insert failure is retried once (via the existing post-delivery-bookkeeping retry) and succeeds', async () => {
      const smsLogInserts = [];
      const activityInserts = [];
      const { mock, invoiceQueries } = invoiceQueryDb({ smsLogInserts, smsLogInsertFailCount: 1, activityInserts });
      db.mockImplementation(mock);
      sendCustomerMessage.mockImplementation(async () => ({
        sent: false, blocked: false, deliveryOutcome: 'not_sent',
        code: 'BILLING_CHANNEL_FAILED', reason: 'twilio unavailable', retryable: true,
        channelResults: pendingSmsChannelResults(),
      }));

      const result = await InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' });
      // The retry path's return shape (post-delivery-bookkeeping-failure
      // recovery) carries finalizeError, not the happy-path pendingChannel*
      // fields — but the accepted leg's stamp AND the queued row both made
      // it through on the second attempt.
      expect(result).toMatchObject({ sent: true, finalizeError: expect.any(String) });
      expect(smsLogInserts).toHaveLength(1);
      const deliveryStamp = invoiceQueries.flatMap((q) => q.update.mock.calls.map(([c]) => c))
        .find((c) => c.email_sent_at);
      expect(deliveryStamp).toBeTruthy();
    });

    test('a persistent queue-insert failure leaves the send claim in place (stale-claim recovery territory), never silently dropped', async () => {
      const smsLogInserts = [];
      const activityInserts = [];
      const { mock } = invoiceQueryDb({ smsLogInserts, smsLogInsertFailCount: 2, activityInserts });
      db.mockImplementation(mock);
      sendCustomerMessage.mockImplementation(async () => ({
        sent: false, blocked: false, deliveryOutcome: 'not_sent',
        code: 'BILLING_CHANNEL_FAILED', reason: 'twilio unavailable', retryable: true,
        channelResults: pendingSmsChannelResults(),
      }));

      const result = await InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' });
      // Same shape as any other "finalize retry also failed" outcome
      // (invoice.js: "row left under its send claim; do NOT auto-resend") —
      // never a silent sent:true with the pending leg simply forgotten.
      expect(result).toMatchObject({ sent: true, finalizeError: expect.any(String) });
      expect(result.claimLost).not.toBe(true);
      // Neither the queued row nor the post-delivery bookkeeping (which
      // only runs after a successful finalize) ever committed.
      expect(smsLogInserts).toHaveLength(0);
      expect(activityInserts).toHaveLength(0);
    });
  });

  // Codex round-3 P2 on PR #4963 (pre-push audit): the messaging contract
  // allows `sent: true` with `deliveryOutcome: 'not_sent'` (e.g. the
  // owner-phone kill switch, messaging/providers/twilio-sms.js's
  // `result.suppressed` branch) — `sent` alone was used to decide whether to
  // stamp a channel's delivery evidence and name it in the activity
  // description, so a suppressed-but-`sent:true` leg was wrongly recorded as
  // delivered.
  describe('Codex #4963 round 3 pre-push audit: only a genuinely deliveryOutcome:"accepted" leg is stamped or named', () => {
    test('an sms leg with sent:true but deliveryOutcome:not_sent (owner-phone kill switch) is never stamped or named as delivered', async () => {
      const activityInserts = [];
      const invoiceQueries = [];
      db.mockImplementation((table) => {
        if (table === 'invoices') {
          const q = query({ first: invoiceReads.shift() || invoice });
          invoiceQueries.push(q);
          return q;
        }
        if (table === 'customers') return query({ first: { id: 'cust-1', first_name: 'Pat', phone: '+19415550101' } });
        if (table === 'activity_log') {
          const q = query();
          q.insert = jest.fn((row) => { activityInserts.push(row); return q; });
          return q;
        }
        if (table === 'sms_log') return query({ returning: [] });
        throw new Error(`Unexpected table: ${table}`);
      });
      sendCustomerMessage.mockImplementation(async () => ({
        sent: true, deliveryOutcome: 'accepted',
        channelResults: {
          email: { sent: true, deliveryOutcome: 'accepted' },
          // The owner-phone kill switch's exact shape (twilio-sms.js
          // result.suppressed branch): sent:true, but not actually
          // delivered to the customer.
          sms: { sent: true, deliveryOutcome: 'not_sent', providerMessageId: 'owner-silence' },
        },
      }));

      const result = await InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' });
      expect(result).toMatchObject({ sent: true });

      const deliveryStamp = invoiceQueries.flatMap((q) => q.update.mock.calls.map(([c]) => c))
        .find((c) => c.sent_at);
      expect(deliveryStamp).toEqual(expect.objectContaining({ email_sent_at: expect.any(Date) }));
      expect(deliveryStamp).not.toHaveProperty('sms_sent_at');
      expect(activityInserts[0]?.description).toBe('Invoice WPC-2026-1234 sent via Email: $100');
    });
  });

  // Codex round-3 P1 add-on (invoice.js:144): billing channel arrays are
  // account-level, saved only on the account's PRIMARY profile
  // (routes/notifications.js). explicitBillingAppSelected read
  // notification_prefs by the INVOICE's own customer_id, so a phone-less
  // sibling property whose choice lives on the primary profile still threw
  // "Customer has no phone number". Mirrors push-channel-routing.js's
  // readChannelPreference: resolve the primary profile first, then read its
  // prefs.
  describe('Codex #4963 round 3 add-on: explicit App/Email selection resolves through the account PRIMARY profile', () => {
    // A customers-table double that answers differently depending on the
    // WHERE shape: a plain {id} lookup (the invoice's own customer, or
    // explicitBillingAppSelected's own read) returns the SIBLING row; the
    // {account_id, is_primary_profile: true} lookup (resolvePrimaryProfileId)
    // returns the primary profile's id.
    function siblingCustomersTable({ resolutionError = false } = {}) {
      const q = {};
      for (const m of ['whereIn', 'whereRaw', 'whereNull', 'forUpdate', 'clone', 'update', 'insert']) q[m] = jest.fn(() => q);
      let lastWhere = {};
      q.where = jest.fn((criteria) => { lastWhere = criteria || {}; return q; });
      q.first = jest.fn(async () => {
        if (lastWhere.account_id && lastWhere.is_primary_profile) {
          if (resolutionError) throw new Error('synthetic primary-profile lookup failure');
          return { id: 'cust-primary-1' };
        }
        return { id: 'cust-sibling-1', account_id: 'acct-1', first_name: 'Sib', phone: null };
      });
      q.then = (resolve, reject) => Promise.resolve(1).then(resolve, reject);
      q.catch = (reject) => Promise.resolve(1).catch(reject);
      return q;
    }
    function notificationPrefsTable(queriesSeen) {
      const q = query();
      let lastWhere = {};
      q.where = jest.fn((criteria) => { lastWhere = criteria || {}; return q; });
      q.first = jest.fn(async () => {
        queriesSeen.push(lastWhere);
        return lastWhere.customer_id === 'cust-primary-1' ? { invoice_channels: ['email'] } : undefined;
      });
      return q;
    }

    test('a phone-less sibling property routes on the account PRIMARY profile\'s explicit Email selection', async () => {
      const prefsQueries = [];
      db.mockImplementation((table) => {
        if (table === 'invoices') return query({ first: invoiceReads.shift() || invoice });
        if (table === 'customers') return siblingCustomersTable();
        if (table === 'notification_prefs') return notificationPrefsTable(prefsQueries);
        if (table === 'activity_log') return query();
        if (table === 'sms_log') return query({ returning: [] });
        throw new Error(`Unexpected table: ${table}`);
      });
      sendCustomerMessage.mockImplementation(async () => ({
        sent: true, deliveryOutcome: 'accepted',
        channelResults: { email: { sent: true, deliveryOutcome: 'accepted' } },
      }));

      await expect(InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' }))
        .resolves.toMatchObject({ sent: true });
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      // The prefs read that actually decided the routing targeted the
      // PRIMARY profile's id, never the sibling's own.
      expect(prefsQueries.some((w) => w.customer_id === 'cust-primary-1')).toBe(true);
    });

    test('a primary-profile resolution error still throws "no phone number" (fail closed, never a guess)', async () => {
      db.mockImplementation((table) => {
        if (table === 'invoices') return query({ first: invoiceReads.shift() || invoice });
        if (table === 'customers') return siblingCustomersTable({ resolutionError: true });
        if (table === 'activity_log') return query();
        if (table === 'sms_log') return query({ returning: [] });
        throw new Error(`Unexpected table: ${table}`);
      });

      await expect(InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' }))
        .rejects.toThrow('Customer has no phone number');
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });

    test('a single-profile (no account grouping) phone-less customer is unchanged: still routes on their own explicit Email selection', async () => {
      db.mockImplementation((table) => {
        if (table === 'invoices') return query({ first: invoiceReads.shift() || invoice });
        if (table === 'customers') return query({ first: { id: 'cust-1', first_name: 'Pat', phone: null } });
        if (table === 'notification_prefs') return query({ first: { customer_id: 'cust-1', invoice_channels: ['email'] } });
        if (table === 'activity_log') return query();
        if (table === 'sms_log') return query({ returning: [] });
        throw new Error(`Unexpected table: ${table}`);
      });
      sendCustomerMessage.mockImplementation(async () => ({
        sent: true, deliveryOutcome: 'accepted',
        channelResults: { email: { sent: true, deliveryOutcome: 'accepted' } },
      }));

      await expect(InvoiceService.sendViaSMS('inv-1', { allowClaimed: true, claimToken: 'claim-1' }))
        .resolves.toMatchObject({ sent: true });
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    });
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

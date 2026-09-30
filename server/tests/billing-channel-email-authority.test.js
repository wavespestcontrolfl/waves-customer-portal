const rows = {
  customers: { id: 'cust-1', first_name: 'Casey', email: 'casey@example.com' },
  notification_prefs: { customer_id: 'cust-1', billing_channels: ['email'] },
  invoices: { id: 'inv-1', customer_id: 'cust-1', status: 'sent' },
};

const defaultDbImplementation = (table) => ({
  where: jest.fn().mockReturnThis(),
  forUpdate: jest.fn().mockReturnThis(),
  first: jest.fn(async () => rows[table] || null),
});
const mockDb = jest.fn(defaultDbImplementation);
mockDb.transaction = jest.fn(async (callback) => callback(mockDb));

jest.mock('../models/db', () => mockDb);

// The dispute-hold read: no hold unless a test places one. Its real reads are pinned in the
// Postgres suites; here the authority's wiring around it is.
const mockHoldRead = jest.fn(async () => ({ held: false }));
jest.mock('../services/collections/collection-hold', () => ({
  ...jest.requireActual('../services/collections/collection-hold'),
  dueInvoiceHeldByDisputeHold: (...args) => mockHoldRead(...args),
}));

const mockWithCustomerCommsLock = jest.fn(async (database, _customerId, callback) => (
  database.transaction(callback)
));
const mockLockCustomerEmail = jest.fn(async () => {});
const mockLockSmsPhone = jest.fn(async () => {});
jest.mock('../utils/customer-comms-lock', () => ({
  withCustomerCommsLock: mockWithCustomerCommsLock,
  lockCustomerEmail: mockLockCustomerEmail,
  lockSmsPhone: mockLockSmsPhone,
}));

const mockWithInvoiceDepositSettlement = jest.fn(async (invoiceId, callback, database) => (
  database.transaction((trx) => {
    const invoice = rows.invoices?.id === invoiceId ? rows.invoices : null;
    return invoice ? callback(trx, invoice) : null;
  })
));
jest.mock('../services/estimate-deposits', () => ({
  withInvoiceDepositSettlement: mockWithInvoiceDepositSettlement,
}));

const mockLoadTemplateByKey = jest.fn(async () => ({
  template: { template_key: 'billing.notice', send_stream: 'transactional_required' },
}));
const mockActiveSuppressionFor = jest.fn(async () => null);

jest.mock('../services/email-template-library', () => ({
  loadTemplateByKey: mockLoadTemplateByKey,
  activeSuppressionFor: mockActiveSuppressionFor,
}));
jest.mock('../services/invoice-helpers', () => ({
  selfPayAtDispatch: jest.fn(() => async () => ({ ok: true })),
}));
jest.mock('../services/customer-contact', () => ({
  getInvoiceEmailRecipients: jest.fn(() => [{ email: 'casey@example.com', name: 'Casey', role: 'primary' }]),
}));
const mockLoadSuppressionState = jest.fn(async (_input, state) => Object.assign(state, { suppressionLoaded: true }));
const mockCheckSuppression = jest.fn(async () => ({ ok: true }));
jest.mock('../services/messaging/validators/suppression', () => ({
  loadSuppressionState: mockLoadSuppressionState,
  checkSuppression: mockCheckSuppression,
}));

const {
  loadBillingEmailContext,
  dispatchUnderBillingEmailAuthority,
} = require('../services/billing-channel-email-authority');
const { selfPayAtDispatch } = require('../services/invoice-helpers');
const { getInvoiceEmailRecipients } = require('../services/customer-contact');

function input(overrides = {}) {
  return {
    body: 'Your saved card needs attention. No invented outcome text.',
    customerId: 'cust-1',
    channel: 'email',
    metadata: {
      billingDeliveryCategory: 'billing',
      notificationEventKey: 'payment-expiry:pm-1:2026-10',
    },
    ...overrides,
  };
}

// Drives the same two-step flow the adapter runs: prepare context, then hand
// dispatch off to the authority under its locks. Tests assert on the
// resulting `state` (boundary block / handoff semantics) and `outcome`
// rather than a template-send result, since sending is the adapter's job.
async function runAuthority(overrides = {}, {
  preSendCheck, dispatch = jest.fn(async (database, providerBoundaryCheck) => {
    const verdict = await providerBoundaryCheck({ database });
    return verdict.ok === true ? { messageId: 'provider-1' } : null;
  }), templateKey, emailSuppression, holdExempt,
} = {}) {
  const requestInput = input(overrides);
  const context = await loadBillingEmailContext(requestInput);
  if (context.error) return { context, outcome: { ok: false }, state: null, dispatch };
  const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
  const outcome = await dispatchUnderBillingEmailAuthority({
    input: requestInput, recipientEmail: context.recipientEmail, templateKey, emailSuppression, preSendCheck, dispatch, state,
    ...(holdExempt ? { holdExempt } : {}),
  });
  return { context, outcome, state, dispatch };
}

describe('billing channel email authority', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.mockImplementation(defaultDbImplementation);
    mockDb.transaction.mockImplementation(async (callback) => callback(mockDb));
    mockWithCustomerCommsLock.mockImplementation(async (database, _customerId, callback) => (
      database.transaction(callback)
    ));
    mockLockCustomerEmail.mockResolvedValue();
    mockLockSmsPhone.mockResolvedValue();
    mockHoldRead.mockReset().mockResolvedValue({ held: false });
    mockLoadTemplateByKey.mockResolvedValue({
      template: { template_key: 'billing.notice', send_stream: 'transactional_required' },
    });
    mockActiveSuppressionFor.mockResolvedValue(null);
    mockLoadSuppressionState.mockImplementation(async (_input, state) => Object.assign(state, { suppressionLoaded: true }));
    mockCheckSuppression.mockResolvedValue({ ok: true });
    mockWithInvoiceDepositSettlement.mockImplementation(async (invoiceId, callback, database) => (
      database.transaction((trx) => {
        const invoice = rows.invoices?.id === invoiceId ? rows.invoices : null;
        return invoice ? callback(trx, invoice) : null;
      })
    ));
    selfPayAtDispatch.mockImplementation(() => async () => ({ ok: true }));
    getInvoiceEmailRecipients.mockImplementation(() => [{ email: 'casey@example.com', name: 'Casey', role: 'primary' }]);
    rows.customers = { id: 'cust-1', first_name: 'Casey', email: 'casey@example.com' };
    rows.notification_prefs = { customer_id: 'cust-1', billing_channels: ['email'] };
    rows.invoices = { id: 'inv-1', customer_id: 'cust-1', status: 'sent' };
  });

  test('does not allow dispatch when Email is absent from the explicit category selection', async () => {
    rows.notification_prefs = { customer_id: 'cust-1', billing_channels: ['sms', 'push'] };
    const { context } = await runAuthority();
    expect(context.error).toMatchObject({
      // A channel-selection mismatch can be the exact mid-dispatch
      // preference-change race the locked recheck below exists to catch, so
      // this returns the SAME schedulable hold Text/App already return via
      // preferenceChangeHold() (billing-channel-routing.js) instead of a
      // dead end.
      blocked: true, code: 'BILLING_PREFERENCES_CHANGED', deliveryOutcome: 'not_sent', deferred: true, retryable: true,
    });
  });

  // Owner ruling 2026-09-27: the shared check serves every billing email
  // sender, so a customer who never chose a billing channel keeps Email, as
  // those senders always did. Only an explicit choice without Email refuses.
  test.each([
    ['no explicit choice for the category', { customer_id: 'cust-1', invoice_channels: ['sms'] }],
    ['no notification_prefs row', undefined],
  ])('%s keeps Email, at the first read and at the locked recheck', async (_label, prefs) => {
    rows.notification_prefs = prefs;
    const { context, outcome, dispatch } = await runAuthority();
    expect(context.error).toBeUndefined();
    expect(context.recipientEmail).toBe('casey@example.com');
    expect(outcome).toEqual({ ok: true });
    expect(dispatch).toHaveBeenCalledWith(mockDb, expect.any(Function));
  });

  test('passes the authority transaction to provider preparation', async () => {
    const { outcome, dispatch } = await runAuthority();
    expect(outcome.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledWith(mockDb, expect.any(Function));
    expect(mockLoadSuppressionState).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'email', to: null }), expect.any(Object), mockDb,
    );
    expect(mockCheckSuppression).toHaveBeenCalledWith(
      expect.any(Object), null, expect.objectContaining({ suppressionLoaded: true }),
    );
  });

  // Owner ruling 2026-09-26: the portal-wide email switch never blocks a
  // billing email. Texts still honor STOP; this shared authority never
  // reads email_enabled at all.
  test('allows dispatch when the global email preference is disabled', async () => {
    rows.notification_prefs = { customer_id: 'cust-1', email_enabled: false, billing_channels: ['email'] };
    const { context, outcome, dispatch } = await runAuthority();
    expect(context.error).toBeUndefined();
    expect(outcome).toEqual({ ok: true });
    expect(dispatch).toHaveBeenCalledWith(mockDb, expect.any(Function));
  });

  test('rechecks the selected channel at the provider boundary', async () => {
    // This IS the Email-only -> Text-only mid-dispatch race: the locked
    // recheck's channel-selection mismatch must return the shared
    // schedulable hold, not a terminal drop, so the caller's replay
    // schedules against the customer's new choice instead of losing the
    // notice.
    let reads = 0;
    mockDb.mockImplementation((table) => ({
      where: jest.fn().mockReturnThis(),
      forUpdate: jest.fn().mockReturnThis(),
      first: jest.fn(async () => {
        if (table === 'notification_prefs') {
          reads += 1;
          return reads === 1
            ? { customer_id: 'cust-1', billing_channels: ['email'] }
            : { customer_id: 'cust-1', billing_channels: ['sms'] };
        }
        return rows[table] || null;
      }),
    }));
    const { outcome, state } = await runAuthority();
    expect(outcome.ok).toBe(false);
    expect(state.boundaryBlock).toMatchObject({
      blocked: true, code: 'BILLING_PREFERENCES_CHANGED', deferred: true, retryable: true,
    });
  });

  test('the global email preference flipping off between reads does not block the provider boundary recheck', async () => {
    let reads = 0;
    mockDb.mockImplementation((table) => ({
      where: jest.fn().mockReturnThis(),
      forUpdate: jest.fn().mockReturnThis(),
      first: jest.fn(async () => {
        if (table === 'notification_prefs') {
          reads += 1;
          return { customer_id: 'cust-1', email_enabled: reads === 1, billing_channels: ['email'] };
        }
        return rows[table] || null;
      }),
    }));
    const { outcome, state } = await runAuthority();
    expect(outcome.ok).toBe(true);
    expect(state.boundaryBlock).toBeNull();
  });

  test('locks the address and rechecks canonical suppression before provider dispatch', async () => {
    const handoffOrder = [];
    mockLockCustomerEmail.mockImplementationOnce(async (trx, email) => {
      expect(trx).toBe(mockDb);
      expect(email).toBe('casey@example.com');
      handoffOrder.push('address-lock');
    });
    mockActiveSuppressionFor.mockImplementationOnce(async (template, email, group, trx) => {
      expect(template).toMatchObject({ template_key: 'billing.notice' });
      expect(email).toBe('casey@example.com');
      expect(group).toBe('transactional_required');
      expect(trx).toBe(mockDb);
      handoffOrder.push('suppression-read');
      return { suppression_type: 'bounce', group_key: null };
    });

    const dispatch = jest.fn(async () => {});
    const { outcome, state } = await runAuthority({}, { dispatch });
    expect(outcome.ok).toBe(false);
    expect(state.boundaryBlock).toMatchObject({ blocked: true, code: 'EMAIL_SUPPRESSED', deliveryOutcome: 'not_sent' });
    expect(handoffOrder).toEqual(['address-lock', 'suppression-read']);
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('holds suppression read failures without exposing phone bindings or SQL', async () => {
    rows.customers = { ...rows.customers, phone: '+19415550100' };
    mockLoadSuppressionState.mockRejectedValueOnce(new Error(
      'select * from messaging_suppression where phone = +19415550100 - permission denied',
    ));
    const dispatch = jest.fn();
    const { outcome, state } = await runAuthority({}, { dispatch });
    expect(outcome.ok).toBe(false);
    expect(state.boundaryBlock).toMatchObject({
      blocked: true, code: 'BILLING_EMAIL_RECHECK_FAILED', retryable: true,
      reason: 'Billing email authority could not be verified',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('defers when the customer phone changes before the recipient row is locked', async () => {
    rows.customers = { ...rows.customers, phone: '(941) 555-0100' };
    mockLockSmsPhone.mockImplementationOnce(async (_trx, phone) => {
      expect(phone).toBe('+19415550100');
      rows.customers = { ...rows.customers, phone: '+19415550101' };
    });
    const { outcome, state, dispatch } = await runAuthority();
    expect(outcome).toEqual({ ok: false });
    expect(state.boundaryBlock).toMatchObject({ code: 'BILLING_EMAIL_RECHECK_FAILED', retryable: true });
    expect(dispatch).not.toHaveBeenCalled();
    expect(mockLoadSuppressionState).not.toHaveBeenCalled();
  });

  test('the locked suppression recheck loads billing.notice for a non-receipt category', async () => {
    const { outcome } = await runAuthority();
    expect(outcome.ok).toBe(true);
    expect(mockLoadTemplateByKey).toHaveBeenCalledWith('billing.notice', mockDb);
  });

  test("the locked suppression recheck loads the sender's own template when it names one", async () => {
    const { outcome } = await runAuthority({}, { templateKey: 'invoice.followup_3_day' });
    expect(outcome.ok).toBe(true);
    expect(mockLoadTemplateByKey).toHaveBeenCalledWith('invoice.followup_3_day', mockDb);
  });

  test('a sender outside the template library runs its own suppression check under the recipient lock', async () => {
    const handoffOrder = [];
    mockLockCustomerEmail.mockImplementationOnce(async () => { handoffOrder.push('address-lock'); });
    const emailSuppression = jest.fn(async (trx, email) => {
      expect(trx).toBe(mockDb);
      expect(email).toBe('casey@example.com');
      handoffOrder.push('own-suppression-read');
      return null;
    });
    const dispatch = jest.fn(async () => { handoffOrder.push('dispatch'); });

    const { outcome } = await runAuthority({}, { emailSuppression, dispatch });

    expect(outcome.ok).toBe(true);
    expect(handoffOrder).toEqual(['address-lock', 'own-suppression-read', 'dispatch']);
    expect(mockLoadTemplateByKey).not.toHaveBeenCalled();
    expect(mockActiveSuppressionFor).not.toHaveBeenCalled();
  });

  test("a sender's own suppression block refuses the dispatch; a staff do-not-contact still refuses first", async () => {
    const block = { sent: false, blocked: true, code: 'EMAIL_SUPPRESSED', reason: 'Suppressed: unsubscribe (service_operational)' };
    const suppressed = await runAuthority({}, { emailSuppression: jest.fn(async () => block) });
    expect(suppressed.outcome.ok).toBe(false);
    expect(suppressed.state.boundaryBlock).toBe(block);
    expect(suppressed.dispatch).not.toHaveBeenCalled();

    mockCheckSuppression.mockResolvedValueOnce({ ok: false, code: 'SUPPRESSED_MANUAL_DNC', reason: 'manual_dnc' });
    const emailSuppression = jest.fn();
    const dnc = await runAuthority({}, { emailSuppression });
    expect(dnc.state.boundaryBlock).toMatchObject({ code: 'SUPPRESSED_MANUAL_DNC' });
    expect(emailSuppression).not.toHaveBeenCalled();
    expect(dnc.dispatch).not.toHaveBeenCalled();
  });

  test('the locked suppression recheck loads billing.receipt_notice for the payment_receipt category', async () => {
    rows.notification_prefs = { customer_id: 'cust-1', payment_receipt_channels: ['email'] };
    const { outcome } = await runAuthority({
      metadata: { billingDeliveryCategory: 'payment_receipt', notificationEventKey: 'deposit-receipt:inv-1' },
    });
    expect(outcome.ok).toBe(true);
    expect(mockLoadTemplateByKey).toHaveBeenCalledWith('billing.receipt_notice', mockDb);
  });

  test('refuses an invoice that does not belong to the selected customer', async () => {
    rows.invoices = { id: 'inv-1', customer_id: 'cust-other', status: 'sent' };
    const { context } = await runAuthority({ invoiceId: 'inv-1' });
    expect(context.error).toMatchObject({ blocked: true, code: 'INVOICE_CUSTOMER_MISMATCH' });
  });

  test('refuses payer-owned invoice delivery before template dispatch', async () => {
    selfPayAtDispatch.mockImplementation(() => async () => ({
      ok: false,
      code: 'payer_billed',
      reason: 'Invoice is billed to a third-party payer',
    }));
    const { context } = await runAuthority({ invoiceId: 'inv-1' });
    expect(context.error).toMatchObject({ blocked: true, code: 'payer_billed' });
  });

  test('an unreadable invoice remains retryable at the locked provider boundary', async () => {
    selfPayAtDispatch
      .mockImplementationOnce(() => async () => ({ ok: true }))
      .mockImplementationOnce(() => async () => ({ ok: false, code: 'INVOICE_UNREADABLE' }));
    const { state, dispatch } = await runAuthority({ invoiceId: 'inv-1' });
    expect(state.boundaryBlock).toMatchObject({ code: 'INVOICE_UNREADABLE', retryable: true });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('rechecks invoice ownership while both handoff locks cover provider dispatch', async () => {
    rows.customers = { ...rows.customers, phone: '+19415550100' };
    let commsLocked = false;
    let invoiceLocked = false;
    let phoneLocked = false;
    const recipientLocks = [];
    const lockedTrx = jest.fn((table) => {
      const query = defaultDbImplementation(table);
      query.forUpdate.mockImplementation(() => {
        expect(commsLocked).toBe(true);
        expect(invoiceLocked).toBe(true);
        expect(phoneLocked).toBe(true);
        recipientLocks.push(table);
        return query;
      });
      return query;
    });
    mockWithCustomerCommsLock.mockImplementationOnce(async (database, customerId, callback) => {
      expect(database).toBe(mockDb);
      expect(customerId).toBe('cust-1');
      commsLocked = true;
      try { return await callback(lockedTrx); } finally { commsLocked = false; }
    });
    mockWithInvoiceDepositSettlement.mockImplementationOnce(async (invoiceId, callback, database) => {
      expect(invoiceId).toBe('inv-1');
      expect(database).toBe(lockedTrx);
      expect(commsLocked).toBe(true);
      expect(phoneLocked).toBe(true);
      invoiceLocked = true;
      try { return await callback(lockedTrx, rows.invoices); } finally { invoiceLocked = false; }
    });
    mockLockSmsPhone.mockImplementationOnce(async (trx, phone) => {
      expect(trx).toBe(lockedTrx);
      expect(phone).toBe('+19415550100');
      expect(commsLocked).toBe(true);
      expect(invoiceLocked).toBe(false);
      phoneLocked = true;
    });
    const dispatch = jest.fn(async (database, providerBoundaryCheck) => {
      expect(commsLocked).toBe(true);
      expect(invoiceLocked).toBe(true);
      expect(await providerBoundaryCheck({ database })).toEqual({ ok: true });
    });

    const { outcome, state } = await runAuthority({ invoiceId: 'inv-1' }, { dispatch });
    expect(outcome.ok).toBe(true);
    expect(state.providerAccepted).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(selfPayAtDispatch).toHaveBeenNthCalledWith(2, 'inv-1', lockedTrx);
    expect(recipientLocks).toEqual(['customers', 'notification_prefs']);
    expect(mockLockCustomerEmail).toHaveBeenCalledWith(lockedTrx, 'casey@example.com');
    expect(commsLocked).toBe(false);
    expect(invoiceLocked).toBe(false);
  });

  test('threads the same locked transaction into both producer checks', async () => {
    const lockedTrx = jest.fn((table) => defaultDbImplementation(table));
    mockWithCustomerCommsLock.mockImplementationOnce(async (database, customerId, callback) => {
      expect(database).toBe(mockDb);
      expect(customerId).toBe('cust-1');
      return callback(lockedTrx);
    });
    const preSendCheck = jest.fn(async ({ database }) => {
      expect(database).toBe(lockedTrx);
      return { ok: true };
    });
    const { outcome } = await runAuthority({}, { preSendCheck });
    expect(outcome.ok).toBe(true);
    expect(preSendCheck.mock.calls).toEqual([
      [{ channel: 'email', database: lockedTrx, providerBoundary: false }],
      [{ channel: 'email', database: lockedTrx, providerBoundary: true }],
    ]);
  });

  test('blocks when invoice ownership changes before provider dispatch', async () => {
    selfPayAtDispatch
      .mockImplementationOnce(() => async () => ({ ok: true }))
      .mockImplementationOnce(() => async () => ({
        ok: false, code: 'payer_billed', reason: 'Invoice moved to a third-party payer',
      }));
    const { outcome, state } = await runAuthority({ invoiceId: 'inv-1' });
    expect(outcome.ok).toBe(false);
    expect(state.boundaryBlock).toMatchObject({ blocked: true, code: 'payer_billed', deliveryOutcome: 'not_sent' });
  });

  test('preserves provider acceptance when the surrounding transaction cannot commit', async () => {
    mockWithCustomerCommsLock.mockImplementationOnce(async (database, _customerId, callback) => {
      await callback(database);
      throw new Error('read-only handoff commit failed');
    });
    const { outcome, state } = await runAuthority();
    expect(outcome.ok).toBe(true);
    expect(state.providerAccepted).toBe(true);
  });

  test('aborts when the billing recipient changes before provider handoff', async () => {
    getInvoiceEmailRecipients.mockImplementation((customer) => [{
      email: customer.email,
      name: customer.first_name,
      role: 'primary',
    }]);
    let customerReads = 0;
    mockDb.mockImplementation((table) => ({
      where: jest.fn().mockReturnThis(),
      forUpdate: jest.fn().mockReturnThis(),
      first: jest.fn(async () => {
        if (table === 'customers') {
          customerReads += 1;
          return customerReads === 1
            ? rows.customers
            : { ...rows.customers, email: 'new-billing@example.com' };
        }
        return rows[table] || null;
      }),
    }));
    const { outcome, state } = await runAuthority();
    expect(outcome.ok).toBe(false);
    expect(state.boundaryBlock).toMatchObject({ blocked: true, code: 'EMAIL_RECIPIENT_CHANGED' });
  });

  test('checks producer authority before preparation and again at the provider boundary', async () => {
    const preSendCheck = jest.fn(async () => ({ ok: true }));
    const { outcome } = await runAuthority({}, { preSendCheck });
    expect(outcome.ok).toBe(true);
    expect(preSendCheck.mock.calls).toEqual([
      [{ channel: 'email', database: mockDb, providerBoundary: false }],
      [{ channel: 'email', database: mockDb, providerBoundary: true }],
    ]);
  });

  test('blocks the provider request when the pre-send check fails', async () => {
    const preSendCheck = jest.fn(async () => ({
      ok: false, code: 'PORTAL_HOLD', reason: 'Portal hold active', retryable: true,
    }));
    const dispatch = jest.fn(async (database, providerBoundaryCheck) => {
      await providerBoundaryCheck({ database });
    });
    const { outcome, state } = await runAuthority({}, { preSendCheck, dispatch });
    expect(outcome.ok).toBe(false);
    expect(state.boundaryBlock).toMatchObject({
      blocked: true, code: 'PORTAL_HOLD', reason: 'Portal hold active', retryable: true,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(state.handoffStarted).toBe(false);
  });

  test('preserves a final caller-authority refusal when dispatch reports it as a throw', async () => {
    const preSendCheck = jest.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: false, code: 'AUTHORITY_CHANGED', reason: 'Authority changed', retryable: false,
      });
    const dispatch = jest.fn(async (database, providerBoundaryCheck) => {
      const verdict = await providerBoundaryCheck({ database });
      throw Object.assign(new Error(verdict.reason), {
        code: verdict.code,
        retryable: verdict.retryable,
        providerBoundaryBlocked: true,
      });
    });

    const { outcome, state } = await runAuthority({}, { preSendCheck, dispatch });

    expect(outcome).toEqual({ ok: false });
    expect(state.boundaryBlock).toMatchObject({
      code: 'AUTHORITY_CHANGED', reason: 'Authority changed', deliveryOutcome: 'not_sent',
    });
    expect(state.handoffStarted).toBe(false);
  });

  test('propagates a marker acknowledgement loss before the final check to dispatch recovery', async () => {
    const markerError = Object.assign(new Error('marker acknowledgement lost'), { code: 'ECONNRESET' });
    const preSendCheck = jest.fn(async () => ({ ok: true }));
    const dispatch = jest.fn(async () => { throw markerError; });

    await expect(runAuthority({}, { preSendCheck, dispatch })).rejects.toBe(markerError);

    expect(dispatch).toHaveBeenCalledWith(mockDb, expect.any(Function));
    expect(preSendCheck).toHaveBeenCalledTimes(1);
  });

  // Collections DISPUTE hold at the provider boundary (owner ruling 2026-09-30): the machine-initiated
  // dunning emails re-read it on the locked handle, so a hold placed AFTER the sender's preflight
  // (rail-guard consult, rendering, credit application, ledger writes) still stops the send.
  describe('dispute hold on machine-initiated dunning templates', () => {
    const DUNNING_TEMPLATES = [
      'invoice.followup_3_day', 'invoice.followup_90_day', 'billing_late_payment_7_day',
      'billing_late_payment_90_day', 'payment.microdeposit_verification', 'billing.previsit_balance',
      'invoice.followup_combined_3_day', 'invoice.followup_combined_90_day',
    ];

    test.each(DUNNING_TEMPLATES)('%s: a hold placed after the preflight refuses the send as a retryable wait', async (templateKey) => {
      const requestInput = input();
      const context = await loadBillingEmailContext(requestInput); // the sender's preflight: not held
      expect(context.error).toBeUndefined();
      mockHoldRead.mockResolvedValue({ held: true, reason: 'hold' }); // hold committed during the awaits
      const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
      const dispatch = jest.fn();
      const outcome = await dispatchUnderBillingEmailAuthority({
        input: requestInput, recipientEmail: context.recipientEmail, templateKey, dispatch, state,
      });
      expect(outcome).toEqual({ ok: false });
      expect(state.boundaryBlock).toMatchObject({
        code: 'COLLECTION_HOLD_DEFER', retryable: true, deliveryOutcome: 'not_sent', blocked: true,
      });
      expect(state.handoffStarted).toBe(false);
      expect(dispatch).not.toHaveBeenCalled();
      // read on the locked handle (savepoint), not the shared pool
      expect(mockHoldRead).toHaveBeenCalledWith('cust-1', mockDb);
    });

    test('a hold that commits during provider preparation stops the send at the final provider-boundary check', async () => {
      const dispatch = jest.fn(async (database, providerBoundaryCheck) => {
        mockHoldRead.mockResolvedValue({ held: true, reason: 'hold' }); // lands while the provider request is prepared
        await providerBoundaryCheck({ database });
        return { messageId: 'provider-1' };
      });
      const { outcome, state } = await runAuthority({}, { templateKey: 'invoice.followup_7_day', dispatch });
      expect(mockHoldRead).toHaveBeenCalledTimes(2); // before dispatch and again at the boundary
      expect(outcome).toEqual({ ok: false });
      expect(state.boundaryBlock).toMatchObject({ code: 'COLLECTION_HOLD_DEFER', retryable: true });
      expect(state.handoffStarted).toBe(false); // never reached the provider request
    });

    test('an unanswerable hold lookup holds the send (fail closed)', async () => {
      mockHoldRead.mockResolvedValue({ held: true, reason: 'lookup_failed', error: new Error('down') });
      const { outcome, state, dispatch } = await runAuthority({}, { templateKey: 'invoice.followup_14_day' });
      expect(outcome).toEqual({ ok: false });
      expect(state.boundaryBlock).toMatchObject({ code: 'COLLECTION_HOLD_DEFER', retryable: true });
      expect(dispatch).not.toHaveBeenCalled();
    });

    test('after the release the same send goes through', async () => {
      mockHoldRead.mockResolvedValue({ held: true, reason: 'hold' });
      expect((await runAuthority({}, { templateKey: 'invoice.followup_3_day' })).outcome).toEqual({ ok: false });
      mockHoldRead.mockResolvedValue({ held: false });
      const { outcome, state } = await runAuthority({}, { templateKey: 'invoice.followup_3_day' });
      expect(outcome.ok).toBe(true);
      expect(state.boundaryBlock).toBeNull();
    });

    test.each(['operator', 'customer'])('a trusted %s exemption skips the hold read entirely', async (holdExempt) => {
      mockHoldRead.mockResolvedValue({ held: true, reason: 'hold' });
      const { outcome } = await runAuthority({}, { templateKey: 'invoice.followup_3_day', holdExempt });
      expect(outcome.ok).toBe(true);
      expect(mockHoldRead).not.toHaveBeenCalled();
    });

    test('an unrecognised exemption value does not exempt', async () => {
      mockHoldRead.mockResolvedValue({ held: true, reason: 'hold' });
      const { outcome } = await runAuthority({}, { templateKey: 'invoice.followup_3_day', holdExempt: 'system' });
      expect(outcome).toEqual({ ok: false });
    });

    test('a payer-billed invoice is exempt (the email is AP-owned, not the customer\'s)', async () => {
      rows.invoices = { ...rows.invoices, payer_id: 'payer-1' };
      try {
        mockHoldRead.mockResolvedValue({ held: true, reason: 'hold' });
        // The senders' own ownership guards refuse a payer invoice for the homeowner; the hold check
        // never applies to it (payer-billed is exempt), so it is not read here.
        const { outcome, state } = await runAuthority({ invoiceId: 'inv-1' }, { templateKey: 'invoice.followup_3_day' });
        expect(state.boundaryBlock).toBeNull();
        expect(outcome.ok).toBe(true);
        expect(mockHoldRead).not.toHaveBeenCalled();
      } finally {
        rows.invoices = { id: 'inv-1', customer_id: 'cust-1', status: 'sent' };
      }
    });

    test('templates that are not dunning (a generic billing notice, a receipt) never read the hold', async () => {
      mockHoldRead.mockResolvedValue({ held: true, reason: 'hold' });
      for (const templateKey of [undefined, 'billing.notice', 'invoice.receipt', 'billing.receipt_notice']) {
        const { outcome } = await runAuthority({}, { templateKey });
        expect(outcome.ok).toBe(true);
      }
      expect(mockHoldRead).not.toHaveBeenCalled();
    });
  });
});

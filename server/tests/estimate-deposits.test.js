let mockDbHandler = () => { throw new Error('db handler not configured'); };
const mockRetrievePaymentIntent = jest.fn();
const mockRetrievePaymentMethod = jest.fn();
const mockCreateEstimateDepositIntent = jest.fn();

jest.mock('../models/db', () => {
  const mock = jest.fn((...args) => mockDbHandler(...args));
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  return mock;
});
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async () => null),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
// Email leg of the deposit receipt: SendGrid configured so the leg runs;
// sendTemplate captured; recipient resolution mocked to the customer's own
// email (the real helper's contact-slot logic is unit-tested elsewhere).
const mockSendTemplate = jest.fn(async () => ({ message: { provider_message_id: 'sg-1' } }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: (...args) => mockSendTemplate(...args),
}));
jest.mock('../services/customer-contact', () => ({
  getReceiptEmailRecipients: jest.fn((customer) => (customer?.email
    ? [{ email: customer.email, name: customer.first_name || null }]
    : [])),
}));
const mockRefundPaymentIntent = jest.fn();
const mockIsEstimateAcceptActive = jest.fn(() => true);
const mockFindLinkedAppt = jest.fn(async () => null);

jest.mock('../services/stripe', () => ({
  retrievePaymentIntent: (...args) => mockRetrievePaymentIntent(...args),
  retrievePaymentMethod: (...args) => mockRetrievePaymentMethod(...args),
  createEstimateDepositIntent: (...args) => mockCreateEstimateDepositIntent(...args),
  refundPaymentIntent: (...args) => mockRefundPaymentIntent(...args),
}));
jest.mock('../routes/estimate-public', () => ({
  isEstimateAcceptActive: (...args) => mockIsEstimateAcceptActive(...args),
  buildPricingBundle: jest.fn(async () => ({})),
  resolveEstimateQuoteRequirement: jest.fn(() => ({ quoteRequired: false })),
  isStructuralOneTimeOnlyEstimate: jest.fn(() => false),
  findLinkedUpcomingAppointment: (...args) => mockFindLinkedAppt(...args),
}));
jest.mock('../services/estimate-membership-context', () => ({
  buildEstimateMembershipContext: jest.fn(async () => ({ isExistingCustomer: false })),
}));
const mockTriggerNotification = jest.fn();
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: (...args) => mockTriggerNotification(...args),
}));
const mockLoadExistingRecurringQualifyingRows = jest.fn(async () => []);
jest.mock('../services/waveguard-existing-services', () => ({
  loadExistingRecurringQualifyingRows: (...args) => mockLoadExistingRecurringQualifyingRows(...args),
}));
// Label provenance defaults to a verified non-label (the legacy scenarios
// these tests stage); individual tests override to 'label' / 'unknown'.
const mockTierLabelStatus = jest.fn(async () => 'not_label');
jest.mock('../services/self-booking-plan-sync', () => ({
  tierLabelStatus: (...args) => mockTierLabelStatus(...args),
}));
const mockResolveForInvoice = jest.fn(async () => ({ payerId: null }));
jest.mock('../services/payer', () => ({
  resolveForInvoice: (...args) => mockResolveForInvoice(...args),
}));
// Lead-conversion trigger fired on a recorded deposit. Spy on the wiring; the
// resolver itself is unit-tested in lead-estimate-link.test.js.
const mockConvertLeadFromEvent = jest.fn(async () => ({ converted: false, reason: 'no_open_lead' }));
jest.mock('../services/lead-estimate-link', () => ({
  convertLeadFromEvent: (...args) => mockConvertLeadFromEvent(...args),
}));

const {
  assessDepositFollowUpEligibility,
  computeDepositAmount,
  createDepositIntentForEstimate,
  ensureDepositSatisfied,
  handleDepositIntentSucceeded,
  pendingDepositCredit,
  pendingDepositCreditForCustomer,
  resolveDepositPolicy,
  resolveDepositPolicyForEstimate,
  _private: { depositIntentMatchesEstimate },
} = require('../services/estimate-deposits');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ESTIMATE_DEPOSIT_REQUIRED = 'true';
});
afterEach(() => {
  delete process.env.ESTIMATE_DEPOSIT_REQUIRED;
});

describe('deposit retirement (owner ruling 2026-08-10)', () => {
  it('isDepositEnforced is permanently false — the env flag is dead on purpose', () => {
    // beforeEach sets ESTIMATE_DEPOSIT_REQUIRED='true'; the flag must not
    // resurrect the feature (re-enabling is a build decision — the mint and
    // payment endpoints were removed with the retirement).
    const { isDepositEnforced } = require('../services/estimate-deposits');
    expect(isDepositEnforced()).toBe(false);
  });

  it('resolveDepositPolicy is not-enforced for every accept shape', () => {
    const estimate = { id: 'est-1', onetime_total: 280 };
    for (const args of [
      { estimate, membership: {} },
      { estimate, membership: {}, oneTime: true, oneTimeUninvoiced: true },
      { estimate, membership: { isExistingCustomer: true } },
      { estimate, membership: {}, committedPrepayTerm: true },
    ]) {
      expect(resolveDepositPolicy(args)).toEqual({
        enforced: false, required: false, slotRequired: false, exemptReason: 'feature_disabled',
      });
    }
  });

  it('the enforcement half is gone from the module surface', () => {
    expect(ensureDepositSatisfied).toBeUndefined();
    expect(createDepositIntentForEstimate).toBeUndefined();
  });
});

describe('computeDepositAmount — flat per service class, never a percentage', () => {
  it('recurring = $49, one-time = $99, regardless of job size', () => {
    expect(computeDepositAmount()).toBe(49);
    expect(computeDepositAmount({ oneTime: false })).toBe(49);
    expect(computeDepositAmount({ oneTime: true })).toBe(99);
  });

  it('reads constants.DEPOSIT (pricing_config-authoritative) and falls back to defaults on junk', () => {
    const { DEPOSIT } = require('../services/pricing-engine/constants');
    const original = { ...DEPOSIT };
    try {
      DEPOSIT.recurringAmount = 59;
      DEPOSIT.oneTimeAmount = 89;
      expect(computeDepositAmount({ oneTime: false })).toBe(59);
      expect(computeDepositAmount({ oneTime: true })).toBe(89);
      DEPOSIT.recurringAmount = 'junk';
      DEPOSIT.oneTimeAmount = -5;
      expect(computeDepositAmount({ oneTime: false })).toBe(49);
      expect(computeDepositAmount({ oneTime: true })).toBe(99);
    } finally {
      Object.assign(DEPOSIT, original);
    }
  });
});

describe('depositIntentMatchesEstimate — the trust boundary', () => {
  const good = {
    status: 'succeeded',
    amount_received: 7000,
    metadata: { purpose: 'estimate_deposit', estimate_id: 'est-1' },
  };

  it('accepts only a succeeded estimate_deposit PI pinned to THIS estimate', () => {
    expect(depositIntentMatchesEstimate(good, 'est-1')).toBe(true);
    expect(depositIntentMatchesEstimate({ ...good, status: 'processing' }, 'est-1')).toBe(false);
    expect(depositIntentMatchesEstimate({ ...good, metadata: { ...good.metadata, estimate_id: 'est-2' } }, 'est-1')).toBe(false);
    expect(depositIntentMatchesEstimate({ ...good, metadata: { purpose: 'invoice', estimate_id: 'est-1' } }, 'est-1')).toBe(false);
    expect(depositIntentMatchesEstimate({ ...good, amount_received: 0 }, 'est-1')).toBe(false);
    expect(depositIntentMatchesEstimate(null, 'est-1')).toBe(false);
  });
});

describe('webhook + invoice credit', () => {
  // Stateful deposits-table fake: the claim-first refund discipline reads
  // and writes the SAME row across several queries, so the mock must carry
  // state. Conditional updates (status / whereIn) only land when the live
  // row matches — mirroring knex affected-row semantics.
  function statefulWebhookDb({ estimateRow, customerRow = null, prefsRow = null, initialDepositRow = null, onEstimateRead = null }) {
    const state = {
      row: initialDepositRow ? { credited_amount: 0, refunded_amount: 0, ...initialDepositRow } : null,
      inserts: [],
      updates: [],
    };
    const handler = (table) => {
      if (table === 'estimates') {
        return { where: () => ({ first: async () => { if (onEstimateRead) onEstimateRead(state); return estimateRow; } }) };
      }
      if (table === 'customers') {
        return { where: () => ({ first: async () => customerRow } ) };
      }
      if (table === 'notification_prefs') {
        return { where: () => ({ first: async () => prefsRow }) };
      }
      if (table === 'sms_log') {
        return { insert: async (row) => { state.smsLogInserts = (state.smsLogInserts || []).concat(row); return [row]; } };
      }
      if (table !== 'estimate_deposits') throw new Error(`unexpected table: ${table}`);
      const q = { criteria: {}, inStatuses: null };
      const chain = {
        where(c) { Object.assign(q.criteria, c); return chain; },
        whereIn(_col, vals) { q.inStatuses = vals; return chain; },
        first: async () => (state.row ? { ...state.row } : null),
        update: async (payload) => {
          if (!state.row) return 0;
          if (q.criteria.status && state.row.status !== q.criteria.status) return 0;
          if (q.inStatuses && !q.inStatuses.includes(state.row.status)) return 0;
          Object.assign(state.row, payload);
          state.updates.push({ criteria: { ...q.criteria }, inStatuses: q.inStatuses, payload });
          return 1;
        },
        insert(payload) {
          return {
            onConflict: () => ({
              // Awaited directly by the claim path, chained with .returning()
              // by markDepositReceived — support both shapes.
              ignore: () => {
                const promise = (async () => {
                  if (!state.row) {
                    state.row = { credited_amount: 0, refunded_amount: 0, ...payload };
                    state.inserts.push(payload);
                    return [{ id: 'dep-new' }];
                  }
                  return [];
                })();
                promise.returning = () => promise;
                return promise;
              },
              merge: async () => {
                if (!state.row) { state.row = { credited_amount: 0, refunded_amount: 0, ...payload }; state.inserts.push(payload); }
                else { Object.assign(state.row, payload); }
              },
            }),
          };
        },
      };
      return chain;
    };
    return { handler, state };
  }

  // RETIREMENT (owner ruling 2026-08-10): the deposit policy is permanently
  // not-required, so the RECORD path is reachable only through the fail-open
  // arms of depositStillRecordable (eligibility recheck error -> record: the
  // money has already been taken and a tracked row beats losing sight of it).
  // These tests pin the KEPT recording/receipt/lead machinery through that arm.
  const forceRecordableViaFailOpen = () => {
    require('../routes/estimate-public').buildPricingBundle
      .mockRejectedValue(new Error('eligibility gates unavailable (test) — fail open to record'));
  };

  const succeededPi = {
    id: 'pi_1', amount_received: 7000,
    metadata: { purpose: 'estimate_deposit', estimate_id: 'est-1' },
  };

  it('records an eligible deposit (monotonic: only pending rows advance)', async () => {
    forceRecordableViaFailOpen();
    mockIsEstimateAcceptActive.mockReturnValue(true);
    const { handler, state } = statefulWebhookDb({ estimateRow: { id: 'est-1', status: 'sent', onetime_total: 280 } });
    mockDbHandler = handler;

    const result = await handleDepositIntentSucceeded(succeededPi);
    expect(result.handled).toBe(true);
    expect(result.refunded).toBeUndefined();
    expect(state.row).toMatchObject({ estimate_id: 'est-1', amount: 70, status: 'received' });
    expect(mockRefundPaymentIntent).not.toHaveBeenCalled();
  });

  it('texts the deposit receipt exactly once — first record only, never on replay', async () => {
    forceRecordableViaFailOpen();
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    renderSmsTemplate.mockClear();
    sendCustomerMessage.mockClear();
    renderSmsTemplate.mockResolvedValue('Deposit received — applied toward your first visit.');
    mockIsEstimateAcceptActive.mockReturnValue(true);
    const { handler } = statefulWebhookDb({
      estimateRow: { id: 'est-1', status: 'sent', onetime_total: 280, customer_id: 'cust-1', customer_phone: '(941) 555-0199', customer_name: 'Sam Customer' },
      // The receipt must go to the CUSTOMER's verified phone, not the
      // estimate's stored one.
      customerRow: { id: 'cust-1', phone: '(941) 555-0100', first_name: 'Sam' },
    });
    mockDbHandler = handler;

    await handleDepositIntentSucceeded(succeededPi);
    expect(renderSmsTemplate).toHaveBeenCalledWith('deposit_receipt', expect.objectContaining({
      first_name: 'Sam',
      amount: '70',
    }), expect.any(Object));
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: '(941) 555-0100',
      purpose: 'payment_receipt',
      identityTrustLevel: 'phone_matches_customer',
    }));

    // Webhook replay — the row is already received; no second text.
    await handleDepositIntentSucceeded(succeededPi);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    renderSmsTemplate.mockResolvedValue(null);
  });

  it('requeues a quiet-held deposit receipt onto the scheduled-SMS rail', async () => {
    forceRecordableViaFailOpen();
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    renderSmsTemplate.mockClear();
    sendCustomerMessage.mockClear();
    renderSmsTemplate.mockResolvedValue('Deposit received.');
    const nextAllowedAt = '2026-07-07T12:00:00.000Z';
    sendCustomerMessage.mockResolvedValue({ sent: false, retryable: true, code: 'QUIET_HOURS_HOLD', nextAllowedAt });
    mockIsEstimateAcceptActive.mockReturnValue(true);
    const { handler, state } = statefulWebhookDb({
      estimateRow: { id: 'est-1', status: 'sent', onetime_total: 280, customer_phone: '(941) 555-0100', customer_name: 'Sam Customer' },
    });
    mockDbHandler = handler;

    await handleDepositIntentSucceeded(succeededPi);

    expect(state.smsLogInserts).toHaveLength(1);
    expect(state.smsLogInserts[0]).toMatchObject({
      status: 'scheduled',
      message_type: 'deposit_receipt',
      to_phone: '(941) 555-0100',
    });
    expect(state.smsLogInserts[0].scheduled_for.toISOString()).toBe(nextAllowedAt);
    // sms_log.from_phone is NOT NULL — the row must carry a real outbound
    // number (location default) or the insert throws and the receipt is lost.
    expect(state.smsLogInserts[0].from_phone).toEqual(expect.stringMatching(/^\+1\d{10}$/));
    // Lead-only estimate — the replay consent basis must ride the metadata,
    // and there is no customer row to refresh the recipient from.
    const leadMeta = JSON.parse(state.smsLogInserts[0].metadata);
    expect(leadMeta.consent_basis).toMatchObject({ status: 'transactional_allowed' });
    expect(leadMeta.refresh_customer_phone).toBeUndefined();
    renderSmsTemplate.mockResolvedValue(null);
    sendCustomerMessage.mockResolvedValue({ sent: true });
  });

  it('customer-linked receipt retries carry the location from-number and flag recipient refresh', async () => {
    forceRecordableViaFailOpen();
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    renderSmsTemplate.mockClear();
    sendCustomerMessage.mockClear();
    renderSmsTemplate.mockResolvedValue('Deposit received.');
    const nextAllowedAt = '2026-07-07T12:00:00.000Z';
    sendCustomerMessage.mockResolvedValue({ sent: false, retryable: true, code: 'QUIET_HOURS_HOLD', nextAllowedAt });
    mockIsEstimateAcceptActive.mockReturnValue(true);
    const { handler, state } = statefulWebhookDb({
      estimateRow: { id: 'est-1', status: 'sent', onetime_total: 280, customer_id: 'cust-1', customer_phone: '(941) 555-0199', customer_name: 'Sam Customer' },
      customerRow: { id: 'cust-1', phone: '(941) 555-0100', first_name: 'Sam', city: 'Venice' },
    });
    mockDbHandler = handler;

    await handleDepositIntentSucceeded(succeededPi);

    expect(state.smsLogInserts).toHaveLength(1);
    expect(state.smsLogInserts[0]).toMatchObject({
      customer_id: 'cust-1',
      to_phone: '(941) 555-0100', // customer's verified phone, not the estimate's
      from_phone: expect.stringMatching(/^\+1\d{10}$/), // Venice location line
    });
    // The cron re-reads customers.phone at nextAllowedAt so the
    // phone_matches_customer trust it asserts is still true then.
    expect(JSON.parse(state.smsLogInserts[0].metadata).refresh_customer_phone).toBe(true);
    renderSmsTemplate.mockResolvedValue(null);
    sendCustomerMessage.mockResolvedValue({ sent: true });
  });

  it('email-only receipt channel: no SMS, sends the deposit.receipt email instead', async () => {
    forceRecordableViaFailOpen();
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    renderSmsTemplate.mockClear();
    sendCustomerMessage.mockClear();
    mockSendTemplate.mockClear();
    mockIsEstimateAcceptActive.mockReturnValue(true);
    const { handler, state } = statefulWebhookDb({
      estimateRow: { id: 'est-1', status: 'sent', onetime_total: 280, customer_id: 'cust-1', customer_phone: '(941) 555-0199', customer_name: 'Sam Customer', customer_email: 'stale@estimate.example', token: 'tok-1' },
      customerRow: { id: 'cust-1', phone: '(941) 555-0100', first_name: 'Sam', city: 'Venice', email: 'sam@customer.example' },
      // The policy layer enforces the payment_receipt TOGGLE but not the
      // channel column — this path must honor the channel itself.
      prefsRow: { payment_receipt_channel: 'email' },
    });
    mockDbHandler = handler;

    await handleDepositIntentSucceeded(succeededPi);

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(state.smsLogInserts).toBeUndefined();
    // Email goes to the CUSTOMER's verified email (recipient helper), not
    // the estimate's stored one; idempotency keys on the PaymentIntent so a
    // post-refund second deposit still receipts.
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    expect(mockSendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'deposit.receipt',
      to: 'sam@customer.example',
      recipientType: 'customer',
      recipientId: 'cust-1',
      idempotencyKey: 'deposit_receipt:pi_1',
      triggerEventId: 'deposit_receipt:pi_1',
      // Provider rejection bodies can echo the address — never log raw.
      suppressProviderErrorLog: true,
      payload: expect.objectContaining({
        first_name: 'Sam',
        amount: '$70',
        estimate_url: expect.stringContaining('/estimate/tok-1'),
        // The template's "call us" line renders this — an empty payload
        // value would produce "call  — a real person answers".
        company_phone: '(941) 297-5749',
      }),
    }));
  });

  it('portal-wide email opt-out (email_enabled=false) suppresses the receipt email', async () => {
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    sendCustomerMessage.mockClear();
    mockSendTemplate.mockClear();
    mockIsEstimateAcceptActive.mockReturnValue(true);
    const { handler } = statefulWebhookDb({
      estimateRow: { id: 'est-1', status: 'sent', onetime_total: 280, customer_id: 'cust-1', customer_phone: '(941) 555-0199', customer_name: 'Sam Customer', token: 'tok-1' },
      customerRow: { id: 'cust-1', phone: '(941) 555-0100', first_name: 'Sam', email: 'sam@customer.example' },
      // transactional_required bypasses suppression groups, so the sender
      // itself must honor the portal-wide opt-out.
      prefsRow: { payment_receipt_channel: 'email', email_enabled: false },
    });
    mockDbHandler = handler;

    await handleDepositIntentSucceeded(succeededPi);

    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  it('receipt channel "both" sends the SMS and the email', async () => {
    forceRecordableViaFailOpen();
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    renderSmsTemplate.mockClear();
    sendCustomerMessage.mockClear();
    mockSendTemplate.mockClear();
    renderSmsTemplate.mockResolvedValue('Deposit received.');
    sendCustomerMessage.mockResolvedValue({ sent: true });
    mockIsEstimateAcceptActive.mockReturnValue(true);
    const { handler } = statefulWebhookDb({
      estimateRow: { id: 'est-1', status: 'sent', onetime_total: 280, customer_id: 'cust-1', customer_phone: '(941) 555-0199', customer_name: 'Sam Customer', token: 'tok-1' },
      customerRow: { id: 'cust-1', phone: '(941) 555-0100', first_name: 'Sam', city: 'Venice', email: 'sam@customer.example' },
      prefsRow: { payment_receipt_channel: 'both' },
    });
    mockDbHandler = handler;

    await handleDepositIntentSucceeded(succeededPi);

    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ to: '(941) 555-0100' }));
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    renderSmsTemplate.mockResolvedValue(null);
  });

  it('default sms channel sends NO email; phoneless sms-channel customer falls back to email', async () => {
    forceRecordableViaFailOpen();
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    renderSmsTemplate.mockClear();
    sendCustomerMessage.mockClear();
    mockSendTemplate.mockClear();
    renderSmsTemplate.mockResolvedValue('Deposit received.');
    sendCustomerMessage.mockResolvedValue({ sent: true });
    mockIsEstimateAcceptActive.mockReturnValue(true);

    // Default channel with a phone: SMS only.
    let ctx = statefulWebhookDb({
      estimateRow: { id: 'est-1', status: 'sent', onetime_total: 280, customer_id: 'cust-1', customer_phone: '(941) 555-0199', customer_name: 'Sam Customer', token: 'tok-1' },
      customerRow: { id: 'cust-1', phone: '(941) 555-0100', first_name: 'Sam', email: 'sam@customer.example' },
    });
    mockDbHandler = ctx.handler;
    await handleDepositIntentSucceeded(succeededPi);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(mockSendTemplate).not.toHaveBeenCalled();

    // sms channel but the customer row has NO usable phone: a receipt is the
    // only proof of payment — email gap-fill fires.
    sendCustomerMessage.mockClear();
    ctx = statefulWebhookDb({
      estimateRow: { id: 'est-1', status: 'sent', onetime_total: 280, customer_id: 'cust-1', customer_phone: '(941) 555-0199', customer_name: 'Sam Customer', token: 'tok-1' },
      customerRow: { id: 'cust-1', phone: '', first_name: 'Sam', email: 'sam@customer.example' },
    });
    mockDbHandler = ctx.handler;
    await handleDepositIntentSucceeded(succeededPi);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    renderSmsTemplate.mockResolvedValue(null);
  });

  it('receipt-texts opt-out on the default sms channel falls back to the email receipt', async () => {
    forceRecordableViaFailOpen();
    // payment_confirmation_sms=false blocks the SMS leg at the consent gate
    // (PURPOSE_OPTED_OUT since the policy added it as a prefsColumn) — a
    // default-channel customer would otherwise get NO record of the paid
    // deposit (Codex P2 on 4263af95). Same fallback as the no-phone case;
    // payment_receipt=false stays the full kill switch (covered above).
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    renderSmsTemplate.mockClear();
    sendCustomerMessage.mockClear();
    mockSendTemplate.mockClear();
    renderSmsTemplate.mockResolvedValue('Deposit received.');
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'PURPOSE_OPTED_OUT' });
    mockIsEstimateAcceptActive.mockReturnValue(true);
    const { handler } = statefulWebhookDb({
      estimateRow: { id: 'est-1', status: 'sent', onetime_total: 280, customer_id: 'cust-1', customer_phone: '(941) 555-0199', customer_name: 'Sam Customer', token: 'tok-1' },
      customerRow: { id: 'cust-1', phone: '(941) 555-0100', first_name: 'Sam', email: 'sam@customer.example' },
      prefsRow: { payment_confirmation_sms: false },
    });
    mockDbHandler = handler;

    await handleDepositIntentSucceeded(succeededPi);

    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    expect(mockSendTemplate).toHaveBeenCalledWith(expect.objectContaining({ templateKey: 'deposit.receipt' }));
    renderSmsTemplate.mockResolvedValue(null);
    sendCustomerMessage.mockResolvedValue({ sent: true });
  });

  it('email-only channel whose email leg is undeliverable falls back to the TEXT', async () => {
    forceRecordableViaFailOpen();
    // Stale email-only rows (email removed / email messages opted out after
    // choosing Email) must not leave a paid deposit with no receipt on any
    // channel (codex P1 on d040aa76) — mirrors the consent gate fallback.
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    renderSmsTemplate.mockClear();
    sendCustomerMessage.mockClear();
    mockSendTemplate.mockClear();
    renderSmsTemplate.mockResolvedValue('Deposit received.');
    sendCustomerMessage.mockResolvedValue({ sent: true });
    mockIsEstimateAcceptActive.mockReturnValue(true);

    // Portal-wide email opt-out
    let ctx = statefulWebhookDb({
      estimateRow: { id: 'est-1', status: 'sent', onetime_total: 280, customer_id: 'cust-1', customer_phone: '(941) 555-0199', customer_name: 'Sam Customer', token: 'tok-1' },
      customerRow: { id: 'cust-1', phone: '(941) 555-0100', first_name: 'Sam', email: 'sam@customer.example' },
      prefsRow: { payment_receipt_channel: 'email', email_enabled: false },
    });
    mockDbHandler = ctx.handler;
    await handleDepositIntentSucceeded(succeededPi);
    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);

    // No recipient email on file at all
    sendCustomerMessage.mockClear();
    ctx = statefulWebhookDb({
      estimateRow: { id: 'est-1', status: 'sent', onetime_total: 280, customer_id: 'cust-1', customer_phone: '(941) 555-0199', customer_name: 'Sam Customer', token: 'tok-1' },
      customerRow: { id: 'cust-1', phone: '(941) 555-0100', first_name: 'Sam', email: '' },
      prefsRow: { payment_receipt_channel: 'email' },
    });
    mockDbHandler = ctx.handler;
    await handleDepositIntentSucceeded(succeededPi);
    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    renderSmsTemplate.mockResolvedValue(null);
  });

  it('leads: SMS when the estimate has a phone; email gap-fill when it only has an email', async () => {
    forceRecordableViaFailOpen();
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    renderSmsTemplate.mockClear();
    sendCustomerMessage.mockClear();
    mockSendTemplate.mockClear();
    renderSmsTemplate.mockResolvedValue('Deposit received.');
    sendCustomerMessage.mockResolvedValue({ sent: true });
    mockIsEstimateAcceptActive.mockReturnValue(true);

    // Lead with a phone (and an email): SMS only — unchanged behavior.
    let ctx = statefulWebhookDb({
      estimateRow: { id: 'est-1', status: 'sent', onetime_total: 280, customer_phone: '(941) 555-0100', customer_name: 'Lead Person', customer_email: 'lead@example.com', token: 'tok-1' },
    });
    mockDbHandler = ctx.handler;
    await handleDepositIntentSucceeded(succeededPi);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(mockSendTemplate).not.toHaveBeenCalled();

    // Email-only lead: previously got NOTHING — the email leg is the fix.
    sendCustomerMessage.mockClear();
    ctx = statefulWebhookDb({
      estimateRow: { id: 'est-1', status: 'sent', onetime_total: 280, customer_phone: '', customer_name: 'Lead Person', customer_email: 'lead@example.com', token: 'tok-1' },
    });
    mockDbHandler = ctx.handler;
    await handleDepositIntentSucceeded(succeededPi);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    expect(mockSendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      to: 'lead@example.com',
      recipientType: 'lead',
      recipientId: null,
    }));
    renderSmsTemplate.mockResolvedValue(null);
  });

  it('payment_receipt opt-out suppresses the email leg too', async () => {
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    sendCustomerMessage.mockClear();
    mockSendTemplate.mockClear();
    mockIsEstimateAcceptActive.mockReturnValue(true);
    const { handler } = statefulWebhookDb({
      estimateRow: { id: 'est-1', status: 'sent', onetime_total: 280, customer_id: 'cust-1', customer_phone: '(941) 555-0199', customer_name: 'Sam Customer', token: 'tok-1' },
      customerRow: { id: 'cust-1', phone: '(941) 555-0100', first_name: 'Sam', email: 'sam@customer.example' },
      // Opted out of payment receipts entirely — the messaging policy blocks
      // the SMS; the email leg must check the toggle explicitly.
      prefsRow: { payment_receipt: false, payment_receipt_channel: 'email' },
    });
    mockDbHandler = handler;

    await handleDepositIntentSucceeded(succeededPi);

    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  it('requeues on CONSENT_LOOKUP_FAILED with a default delay — a DB blip must not eat the only receipt', async () => {
    forceRecordableViaFailOpen();
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    renderSmsTemplate.mockClear();
    sendCustomerMessage.mockClear();
    renderSmsTemplate.mockResolvedValue('Deposit received.');
    // CONSENT_LOOKUP_FAILED is retry-advised by contract but carries no
    // retryable/nextAllowedAt metadata.
    sendCustomerMessage.mockResolvedValue({ sent: false, code: 'CONSENT_LOOKUP_FAILED' });
    mockIsEstimateAcceptActive.mockReturnValue(true);
    const { handler, state } = statefulWebhookDb({
      estimateRow: { id: 'est-1', status: 'sent', onetime_total: 280, customer_id: 'cust-1', customer_phone: '(941) 555-0199', customer_name: 'Sam Customer' },
      customerRow: { id: 'cust-1', phone: '(941) 555-0100', first_name: 'Sam', city: 'Venice' },
    });
    mockDbHandler = handler;

    const before = Date.now();
    await handleDepositIntentSucceeded(succeededPi);

    expect(state.smsLogInserts).toHaveLength(1);
    expect(state.smsLogInserts[0]).toMatchObject({ message_type: 'deposit_receipt', status: 'scheduled' });
    const scheduledFor = state.smsLogInserts[0].scheduled_for.getTime();
    expect(scheduledFor).toBeGreaterThanOrEqual(before + 14 * 60 * 1000);
    expect(scheduledFor).toBeLessThanOrEqual(Date.now() + 16 * 60 * 1000);
    expect(JSON.parse(state.smsLogInserts[0].metadata).original_failure_code).toBe('CONSENT_LOOKUP_FAILED');
    renderSmsTemplate.mockResolvedValue(null);
    sendCustomerMessage.mockResolvedValue({ sent: true });
  });

  it('converts the originating lead to won when an eligible deposit is recorded', async () => {
    forceRecordableViaFailOpen();
    mockIsEstimateAcceptActive.mockReturnValue(true);
    mockConvertLeadFromEvent.mockClear();
    const { handler } = statefulWebhookDb({ estimateRow: { id: 'est-1', status: 'sent', onetime_total: 280 } });
    mockDbHandler = handler;

    const result = await handleDepositIntentSucceeded(succeededPi);
    expect(result.handled).toBe(true);
    // requireAcceptedEstimate: a paid deposit only converts once the estimate is
    // actually accepted — the resolver enforces it (unit-tested in lead-estimate-link).
    expect(mockConvertLeadFromEvent).toHaveBeenCalledWith({ source: 'deposit_paid', estimateId: 'est-1', requireAcceptedEstimate: true });
  });

  it('does NOT convert a lead when the deposit is refunded as stale (deal not accepted)', async () => {
    mockIsEstimateAcceptActive.mockReturnValue(false);
    mockRefundPaymentIntent.mockResolvedValue({ id: 're_stale' });
    mockConvertLeadFromEvent.mockClear();
    const { handler } = statefulWebhookDb({ estimateRow: { id: 'est-1', status: 'expired' } });
    mockDbHandler = handler;

    const result = await handleDepositIntentSucceeded(succeededPi);
    expect(result.refunded).toBe(true);
    expect(mockConvertLeadFromEvent).not.toHaveBeenCalled();
  });

  it('REFUNDS a stale deposit when the estimate is no longer acceptable — claim first, Stripe second, stamp third', async () => {
    mockIsEstimateAcceptActive.mockReturnValue(false);
    mockRefundPaymentIntent.mockResolvedValue({ id: 're_1' });
    const { handler, state } = statefulWebhookDb({ estimateRow: { id: 'est-1', status: 'expired' } });
    mockDbHandler = handler;

    const result = await handleDepositIntentSucceeded(succeededPi);
    expect(result.refunded).toBe(true);
    expect(mockRefundPaymentIntent).toHaveBeenCalledWith('pi_1');
    // Row was claimed as 'refunding' BEFORE Stripe, terminal-stamped after.
    expect(state.inserts[0]).toMatchObject({ status: 'refunding' });
    expect(state.row).toMatchObject({ status: 'refunded', refunded_amount: 70 });
  });

  it('REFUNDS a surplus deposit when acceptance completed without it', async () => {
    mockIsEstimateAcceptActive.mockReturnValue(true);
    mockRefundPaymentIntent.mockResolvedValue({ id: 're_2' });
    const { handler, state } = statefulWebhookDb({
      estimateRow: { id: 'est-1', status: 'accepted' },
      initialDepositRow: { id: 'd1', status: 'pending', amount: 70 },
    });
    mockDbHandler = handler;

    const result = await handleDepositIntentSucceeded(succeededPi);
    expect(result.refunded).toBe(true);
    expect(state.row.status).toBe('refunded');
  });

  it('NEVER refunds money an accept consumed mid-flight — the claim loses and the deposit stays received (P1 race)', async () => {
    mockIsEstimateAcceptActive.mockReturnValue(true);
    const { handler, state } = statefulWebhookDb({
      estimateRow: { id: 'est-1', status: 'accepted' },
      initialDepositRow: { id: 'd1', status: 'pending', amount: 70 },
      // Simulate the accept's live verification winning the race: the row
      // advances pending→received between the staleness decision and the
      // refund claim.
      onEstimateRead: (s) => { s.row.status = 'received'; },
    });
    mockDbHandler = handler;

    const result = await handleDepositIntentSucceeded(succeededPi);
    expect(result.handled).toBe(true);
    expect(result.replay).toBe(true);
    expect(mockRefundPaymentIntent).not.toHaveBeenCalled();
    expect(state.row.status).toBe('received');
  });

  it('replays of consumed or refunded deposits are no-ops', async () => {
    const { handler } = statefulWebhookDb({
      estimateRow: { id: 'est-1', status: 'sent' },
      initialDepositRow: { id: 'd1', status: 'credited' },
    });
    mockDbHandler = handler;
    const result = await handleDepositIntentSucceeded(succeededPi);
    expect(result.replay).toBe(true);
    expect(mockRefundPaymentIntent).not.toHaveBeenCalled();
  });

  it('a FAILED refund reverts the claim and THROWS so Stripe retries — money is never stranded', async () => {
    mockIsEstimateAcceptActive.mockReturnValue(false);
    mockRefundPaymentIntent.mockRejectedValue(new Error('stripe down'));
    const { handler, state } = statefulWebhookDb({ estimateRow: { id: 'est-1', status: 'expired' } });
    mockDbHandler = handler;

    await expect(handleDepositIntentSucceeded(succeededPi)).rejects.toThrow(/refund failed/);
    // The claim was reverted to pending — the webhook retry can re-claim.
    expect(state.row.status).toBe('pending');
  });

  it('pendingDepositCredit returns only the UNAPPLIED balance', async () => {
    mockDbHandler = () => ({
      where() { return this; },
      select: async () => [
        { id: 'd1', amount: '70.00', credited_amount: '0.00' },
        { id: 'd2', amount: '50.00', credited_amount: '30.00' },
      ],
    });
    const credit = await pendingDepositCredit('est-1');
    expect(credit.amount).toBe(90);
    expect(credit.lineItem.unit_price).toBe(-90);
  });

  it('no received rows (or fully consumed rows) = no credit', async () => {
    mockDbHandler = () => ({ where() { return this; }, select: async () => [] });
    expect(await pendingDepositCredit('est-1')).toBeNull();
    mockDbHandler = () => ({
      where() { return this; },
      select: async () => [{ id: 'd1', amount: '70.00', credited_amount: '70.00' }],
    });
    expect(await pendingDepositCredit('est-1')).toBeNull();
  });

  // Mock helper: the customer-wide scan query ('estimate_deposits as d')
  // returns `scanRows`; the per-estimate pendingDepositCredit query returns
  // `ledger[estimateId]`. `where({ estimate_id })` records which estimate the
  // ledger read is scoped to.
  const mockCustomerDepositLedger = (scanRows, ledger) => {
    mockDbHandler = (table) => {
      const b = {
        join() { return this; },
        where(arg) {
          if (arg && typeof arg === 'object' && arg.estimate_id) b._estimateId = arg.estimate_id;
          return this;
        },
        orderBy() { return this; },
        select: async () => (table === 'estimate_deposits as d'
          ? scanRows
          : (ledger[b._estimateId] || [])),
      };
      return b;
    };
  };

  it('pendingDepositCreditForCustomer skips exhausted estimates and tags the owning estimateId', async () => {
    // est-old's deposit is fully consumed; est-new still has an open $49 —
    // the helper must skip past est-old (oldest first) and return est-new's
    // credit with the estimateId the caller needs for consumption.
    mockCustomerDepositLedger(
      [
        { estimate_id: 'est-old', amount: '49.00', credited_amount: '49.00', refunded_amount: '0.00', estimate_slug: 'EST-2026-0001' },
        { estimate_id: 'est-new', amount: '49.00', credited_amount: '0.00', refunded_amount: '0.00', estimate_slug: 'EST-2026-0002' },
      ],
      {
        'est-old': [{ id: 'd1', amount: '49.00', credited_amount: '49.00', refunded_amount: '0.00' }],
        'est-new': [{ id: 'd2', amount: '49.00', credited_amount: '0.00', refunded_amount: '0.00' }],
      },
    );
    const credit = await pendingDepositCreditForCustomer('cust-1');
    expect(credit.estimateId).toBe('est-new');
    expect(credit.estimateSlug).toBe('EST-2026-0002');
    expect(credit.amount).toBe(49);
    expect(credit.lineItem.unit_price).toBe(-49);
    expect(credit.lineItem.category).toBe('deposit_credit');
  });

  it('an exhausted older row must not hide a later open row on the SAME estimate (Codex round-1 P2)', async () => {
    // d1 was split between credit and refund (nothing left); d2 is fully
    // open. The estimate-level aggregate is $99 — a per-row gate on d1 would
    // have skipped the whole estimate and stranded d2.
    mockCustomerDepositLedger(
      [
        { estimate_id: 'est-1', amount: '49.00', credited_amount: '24.00', refunded_amount: '25.00', estimate_slug: 'EST-2026-0009' },
        { estimate_id: 'est-1', amount: '99.00', credited_amount: '0.00', refunded_amount: '0.00', estimate_slug: 'EST-2026-0009' },
      ],
      {
        'est-1': [
          { id: 'd1', amount: '49.00', credited_amount: '24.00', refunded_amount: '25.00' },
          { id: 'd2', amount: '99.00', credited_amount: '0.00', refunded_amount: '0.00' },
        ],
      },
    );
    const credit = await pendingDepositCreditForCustomer('cust-1');
    expect(credit.estimateId).toBe('est-1');
    expect(credit.amount).toBe(99);
    expect(credit.lineItem.unit_price).toBe(-99);
  });

  it('picks the estimate with the oldest OPEN row, not one fronted by an exhausted early row (Codex round-3 FIFO)', async () => {
    // Scan order (created_at asc): est-a's earliest row is exhausted, est-b's
    // row is the oldest still-OPEN deposit, est-a has a later open row. The
    // true FIFO winner is est-b — est-a must not jump the queue on the
    // strength of its early fully-consumed row.
    mockCustomerDepositLedger(
      [
        { estimate_id: 'est-a', amount: '49.00', credited_amount: '49.00', refunded_amount: '0.00', estimate_slug: 'EST-2026-0100' },
        { estimate_id: 'est-b', amount: '49.00', credited_amount: '0.00', refunded_amount: '0.00', estimate_slug: 'EST-2026-0101' },
        { estimate_id: 'est-a', amount: '49.00', credited_amount: '0.00', refunded_amount: '0.00', estimate_slug: 'EST-2026-0100' },
      ],
      {
        'est-a': [
          { id: 'a1', amount: '49.00', credited_amount: '49.00', refunded_amount: '0.00' },
          { id: 'a2', amount: '49.00', credited_amount: '0.00', refunded_amount: '0.00' },
        ],
        'est-b': [{ id: 'b1', amount: '49.00', credited_amount: '0.00', refunded_amount: '0.00' }],
      },
    );
    const credit = await pendingDepositCreditForCustomer('cust-1');
    expect(credit.estimateId).toBe('est-b');
    expect(credit.estimateSlug).toBe('EST-2026-0101');
    expect(credit.amount).toBe(49);
  });

  it('pendingDepositCreditForCustomer returns null when every row is consumed or refunded (or none exist)', async () => {
    mockCustomerDepositLedger(
      [
        { estimate_id: 'est-1', amount: '49.00', credited_amount: '49.00', refunded_amount: '0.00', estimate_slug: 'EST-2026-0001' },
        { estimate_id: 'est-2', amount: '99.00', credited_amount: '0.00', refunded_amount: '99.00', estimate_slug: 'EST-2026-0002' },
      ],
      {},
    );
    expect(await pendingDepositCreditForCustomer('cust-1')).toBeNull();
    mockDbHandler = () => ({ join() { return this; }, where() { return this; }, orderBy() { return this; }, select: async () => [] });
    expect(await pendingDepositCreditForCustomer('cust-1')).toBeNull();
    expect(await pendingDepositCreditForCustomer(null)).toBeNull();
  });
});

describe('deposit reversal webhooks (refunds + disputes)', () => {
  const { handleDepositChargeReversed, handleDepositDisputeClosed } = require('../services/estimate-deposits');
  const logger = require('../services/logger');

  // updateResult mimics knex's affected-row count for the CONDITIONAL flip;
  // 0 = the row transitioned under us and the handler must re-read.
  function reversalDb({ row, updates = [], updateResult = 1, cols = { failed_refund_ids: {} } }) {
    return (table) => {
      if (table !== 'estimate_deposits') throw new Error(`unexpected table: ${table}`);
      return {
        columnInfo: async () => cols,
        where(criteria) {
          if (criteria && criteria.id) {
            return {
              update: async (payload) => {
                updates.push({ id: criteria.id, criteria, payload });
                return updateResult;
              },
            };
          }
          return { first: async () => row };
        },
      };
    };
  }

  it('unknown PI = not a deposit — webhook falls through to the payments path', async () => {
    mockDbHandler = reversalDb({ row: null });
    expect(await handleDepositChargeReversed('pi_x', 'charge.refunded')).toEqual({ handled: false });
    expect((await handleDepositChargeReversed(null, 'charge.refunded')).handled).toBe(false);
  });

  it('a received deposit flips to refunded (can never satisfy acceptance again)', async () => {
    const updates = [];
    mockDbHandler = reversalDb({
      row: { id: 'd1', status: 'received', estimate_id: 'est-1', amount: '49.00', credited_amount: '0.00' },
      updates,
    });
    const result = await handleDepositChargeReversed('pi_1', 'charge.refunded');
    expect(result.handled).toBe(true);
    expect(updates[0].payload.status).toBe('refunded');
  });

  it('a PARTIAL dashboard refund keeps the row live — the remainder still satisfies and credits (P2)', async () => {
    const updates = [];
    mockDbHandler = reversalDb({
      row: { id: 'd1', status: 'received', estimate_id: 'est-1', amount: '99.00', credited_amount: '0.00', refunded_amount: null },
      updates,
    });
    const result = await handleDepositChargeReversed('pi_1', 'charge.refunded', { amountRefundedCents: 5000 });
    expect(result.handled).toBe(true);
    // No status flip — only the cumulative refund is recorded; $49 stays
    // available for the gate and for invoice credit.
    expect(updates[0].payload.status).toBeUndefined();
    expect(updates[0].payload.refunded_amount).toBe(50);
    expect(logger.error).not.toHaveBeenCalled();

    // A SECOND partial refund grows the cumulative record; covering the full
    // amount flips the row terminal.
    const updates2 = [];
    mockDbHandler = reversalDb({
      row: { id: 'd1', status: 'received', estimate_id: 'est-1', amount: '99.00', credited_amount: '0.00', refunded_amount: '50.00' },
      updates: updates2,
    });
    await handleDepositChargeReversed('pi_1', 'charge.refunded', { amountRefundedCents: 9900 });
    expect(updates2[0].payload).toMatchObject({ status: 'refunded', refunded_amount: 99 });
  });

  it('a dashboard refund of the FACE amount on a surcharged deposit records the full face (never deflated) — r4', async () => {
    // $49 deposit captured at $50.42 (card_surcharge 1.42). An operator
    // refunds "$49.00" from the dashboard, meaning the whole deposit.
    // Proportional deflation would record ~$47.62 and leave $1.38 able to
    // satisfy acceptance — the conservative reading records the full face.
    const updates = [];
    mockDbHandler = reversalDb({
      row: { id: 'd1', status: 'received', estimate_id: 'est-1', amount: '49.00', credited_amount: '0.00', refunded_amount: null, card_surcharge: '1.42' },
      updates,
    });
    const result = await handleDepositChargeReversed('pi_1', 'charge.refunded', { amountRefundedCents: 4900 });
    expect(result.handled).toBe(true);
    expect(updates[0].payload).toMatchObject({ status: 'refunded', refunded_amount: 49 });
  });

  it('the echo of OUR prorated sweep refund on a surcharged deposit replays instead of re-recording — r4', async () => {
    // Sweep refunded a $20 remainder + $0.58 prorated fee = 2058c gross;
    // the ledger already stamps refunded_amount 20.00. The gross deflates
    // back to ~2000c and must read as a replay, not a new dashboard refund.
    mockDbHandler = reversalDb({
      row: { id: 'd1', status: 'credited', estimate_id: 'est-1', amount: '49.00', credited_amount: '29.00', refunded_amount: '20.00', card_surcharge: '1.42' },
      updates: [],
    });
    const result = await handleDepositChargeReversed('pi_1', 'charge.refunded', { amountRefundedCents: 2058 });
    expect(result).toEqual({ handled: true, replay: true });
  });

  it('an already-credited deposit flips AND flags for manual reconciliation', async () => {
    const updates = [];
    mockDbHandler = reversalDb({
      row: { id: 'd1', status: 'credited', estimate_id: 'est-1', amount: '70.00', credited_amount: '70.00', credited_invoice_id: 'inv-1' },
      updates,
    });
    const result = await handleDepositChargeReversed('pi_1', 'dispute.created');
    expect(result.handled).toBe(true);
    expect(updates[0].payload.status).toBe('refunded');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('manual reconciliation'),
      expect.objectContaining({ invoiceId: 'inv-1' }),
    );
  });

  it('replays of already-refunded deposits are no-ops', async () => {
    const updates = [];
    mockDbHandler = reversalDb({ row: { id: 'd1', status: 'refunded' }, updates });
    const result = await handleDepositChargeReversed('pi_1', 'charge.refunded');
    expect(result.replay).toBe(true);
    expect(updates).toHaveLength(0);
  });

  it('a refund whose failure was already recorded is REFUSED — the ledger never flips for money Stripe kept', async () => {
    const updates = [];
    mockDbHandler = reversalDb({
      row: { id: 'd1', status: 'received', estimate_id: 'est-1', amount: '49.00', credited_amount: '0.00', failed_refund_ids: ['re_bounced'] },
      updates,
    });
    const result = await handleDepositChargeReversed('pi_1', 'charge.refunded', { refundId: 're_bounced' });
    expect(result).toEqual({ handled: true, bounced: true });
    expect(updates).toHaveLength(0);
  });

  it('a refund NOT in the failed fence still reverses normally', async () => {
    const updates = [];
    mockDbHandler = reversalDb({
      row: { id: 'd1', status: 'received', estimate_id: 'est-1', amount: '49.00', credited_amount: '0.00', failed_refund_ids: ['re_bounced'] },
      updates,
    });
    const result = await handleDepositChargeReversed('pi_1', 'charge.refunded', { refundId: 're_ok' });
    expect(result.handled).toBe(true);
    expect(updates[0].payload.status).toBe('refunded');
  });

  it('pre-migration (no failed_refund_ids column) skips the fence and reverses', async () => {
    const updates = [];
    mockDbHandler = reversalDb({
      row: { id: 'd1', status: 'received', estimate_id: 'est-1', amount: '49.00', credited_amount: '0.00' },
      updates,
      cols: {},
    });
    const result = await handleDepositChargeReversed('pi_1', 'charge.refunded', { refundId: 're_any' });
    expect(result.handled).toBe(true);
    expect(updates[0].payload.status).toBe('refunded');
  });

  it('the flip is CONDITIONAL on the state the alert decision used', async () => {
    const updates = [];
    mockDbHandler = reversalDb({
      row: { id: 'd1', status: 'received', estimate_id: 'est-1', credited_amount: '0.00' },
      updates,
    });
    await handleDepositChargeReversed('pi_1', 'charge.refunded');
    expect(updates[0].criteria).toMatchObject({ id: 'd1', status: 'received', credited_amount: '0.00' });
  });

  it('unwinnable transition contention THROWS so Stripe retries the reversal', async () => {
    mockDbHandler = reversalDb({
      row: { id: 'd1', status: 'received', estimate_id: 'est-1', credited_amount: '0.00' },
      updateResult: 0,
    });
    await expect(handleDepositChargeReversed('pi_1', 'charge.refunded'))
      .rejects.toThrow(/contention/);
  });

  it('dispute closed: lost is silent (row already refunded); won flags for manual restore', async () => {
    mockDbHandler = reversalDb({ row: { id: 'd1', status: 'refunded', estimate_id: 'est-1' } });
    expect((await handleDepositDisputeClosed('pi_1', 'lost')).handled).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
    expect((await handleDepositDisputeClosed('pi_1', 'won')).handled).toBe(true);
    expect(logger.error).toHaveBeenCalled();
    // Non-deposit PIs fall through to the payments path.
    mockDbHandler = reversalDb({ row: null });
    expect((await handleDepositDisputeClosed('pi_9', 'won')).handled).toBe(false);
  });

  it('warning_closed restores like won — the inquiry ended with the funds still ours (P2)', async () => {
    mockDbHandler = reversalDb({ row: { id: 'd1', status: 'refunded', estimate_id: 'est-1' } });
    expect((await handleDepositDisputeClosed('pi_1', 'warning_closed')).handled).toBe(true);
    expect(logger.error).toHaveBeenCalled();
  });

  it('the echo of OUR OWN remainder refund never flips a credited row or false-alarms', async () => {
    const updates = [];
    // Partially-credited row whose $29 remainder WE refunded and stamped.
    mockDbHandler = reversalDb({
      row: { id: 'd1', status: 'credited', estimate_id: 'est-1', credited_amount: '70.00', refunded_amount: '29.00' },
      updates,
    });
    const result = await handleDepositChargeReversed('pi_1', 'charge.refunded', { amountRefundedCents: 2900 });
    expect(result.replay).toBe(true);
    expect(updates).toHaveLength(0);
    expect(logger.error).not.toHaveBeenCalled();
    // A LARGER dashboard reversal on the same row is NOT an echo — it flips
    // and flags for manual reconciliation as before.
    const updates2 = [];
    mockDbHandler = reversalDb({
      row: { id: 'd1', status: 'credited', estimate_id: 'est-1', amount: '99.00', credited_amount: '70.00', refunded_amount: '29.00', credited_invoice_id: 'inv-1' },
      updates: updates2,
    });
    const bigger = await handleDepositChargeReversed('pi_1', 'charge.refunded', { amountRefundedCents: 9900 });
    expect(bigger.handled).toBe(true);
    expect(updates2[0].payload.status).toBe('refunded');
    expect(logger.error).toHaveBeenCalled();
  });

  it('an echo landing MID-refund stamps the refund terminal state — a partial credit survives (P1)', async () => {
    // $99 deposit, $70 credited to an invoice, our $29 remainder refund is
    // between the Stripe call and the terminal stamp. The echo must finish
    // the job the refunder started: keep the credit, record the remainder —
    // NOT flip to plain refunded (which would erase a credit the invoice
    // still carries and suppress the reconcile trail).
    const updates = [];
    mockDbHandler = reversalDb({
      row: { id: 'd1', status: 'refunding', estimate_id: 'est-1', amount: '99.00', credited_amount: '70.00', refunded_amount: '0.00' },
      updates,
    });
    const result = await handleDepositChargeReversed('pi_1', 'charge.refunded', { amountRefundedCents: 2900 });
    expect(result.handled).toBe(true);
    expect(updates[0].criteria).toMatchObject({ id: 'd1', status: 'refunding' });
    expect(updates[0].payload).toMatchObject({ status: 'credited', refunded_amount: 29 });
    expect(logger.error).not.toHaveBeenCalled();

    // Zero-credit in-flight refund (stale deposit) — plain refunded with the
    // full amount recorded so later echoes register as replays.
    const updates2 = [];
    mockDbHandler = reversalDb({
      row: { id: 'd2', status: 'refunding', estimate_id: 'est-1', amount: '49.00', credited_amount: '0.00', refunded_amount: '0.00' },
      updates: updates2,
    });
    await handleDepositChargeReversed('pi_2', 'charge.refunded');
    expect(updates2[0].payload).toMatchObject({ status: 'refunded', refunded_amount: 49 });
  });
});

describe('refundUnconsumedDeposits — exempt-path sweep', () => {
  const { refundUnconsumedDeposits } = require('../services/estimate-deposits');

  // Stateful rows fake: claim (received→refunding), then terminal stamp.
  function sweepDb({ rows }) {
    const state = { rows: rows.map((r) => ({ credited_amount: 0, refunded_amount: 0, ...r })), updates: [] };
    const handler = (table) => {
      if (table !== 'estimate_deposits') throw new Error(`unexpected table: ${table}`);
      const q = { criteria: {} };
      const chain = {
        where(c) { Object.assign(q.criteria, c); return chain; },
        select: async () => (state.selectRows
          ? state.selectRows.map((r) => ({ ...r }))
          : state.rows.filter((r) => r.status === q.criteria.status).map((r) => ({ ...r }))),
        update: async (payload) => {
          const target = state.rows.find((r) => r.id === q.criteria.id);
          if (!target) return 0;
          if (q.criteria.status && target.status !== q.criteria.status) return 0;
          if (q.criteria.credited_amount !== undefined && String(target.credited_amount) !== String(q.criteria.credited_amount)) return 0;
          Object.assign(target, payload);
          state.updates.push({ criteria: { ...q.criteria }, payload });
          return 1;
        },
      };
      return chain;
    };
    return { handler, state };
  }

  it('refunds untouched deposits in full and partially-credited remainders partially', async () => {
    mockRefundPaymentIntent.mockResolvedValue({ id: 're_1' });
    const { handler, state } = sweepDb({
      rows: [
        { id: 'd1', stripe_payment_intent_id: 'pi_a', status: 'received', amount: '49.00', credited_amount: '0.00' },
        { id: 'd2', stripe_payment_intent_id: 'pi_b', status: 'received', amount: '99.00', credited_amount: '70.00' },
      ],
    });
    mockDbHandler = handler;

    const result = await refundUnconsumedDeposits({ estimateId: 'est-1', reason: 'exempt_accept:prepay_annual' });
    expect(result.refunded).toBe(78); // 49 + 29
    expect(mockRefundPaymentIntent).toHaveBeenCalledWith('pi_a', { amountCents: 4900 });
    expect(mockRefundPaymentIntent).toHaveBeenCalledWith('pi_b', { amountCents: 2900 });
    const d1 = state.rows.find((r) => r.id === 'd1');
    const d2 = state.rows.find((r) => r.id === 'd2');
    // Untouched money ends refunded; a partially-credited row keeps its
    // credit — only the remainder came back.
    expect(d1).toMatchObject({ status: 'refunded', refunded_amount: 49 });
    expect(d2).toMatchObject({ status: 'credited', refunded_amount: 29 });
  });

  it('a Stripe failure reverts the claim, raises the reconcile alert, and keeps sweeping', async () => {
    mockRefundPaymentIntent.mockRejectedValue(new Error('stripe down'));
    const { handler, state } = sweepDb({
      rows: [{ id: 'd1', stripe_payment_intent_id: 'pi_a', status: 'received', amount: '49.00', credited_amount: '0.00' }],
    });
    mockDbHandler = handler;

    const result = await refundUnconsumedDeposits({ estimateId: 'est-1', reason: 'exempt_accept:prepay_annual' });
    expect(result.refunded).toBe(0);
    expect(state.rows[0].status).toBe('received');
    expect(mockTriggerNotification).toHaveBeenCalledWith('estimate_deposit_reconcile_needed', { estimateId: 'est-1' });
  });

  it('includeSurchargeShare:false refunds FACE VALUE only — the captured fee stays earned (cancel-signup ruling 2026-07-15)', async () => {
    mockRefundPaymentIntent.mockResolvedValue({ id: 're_1' });
    const { handler, state } = sweepDb({
      rows: [{ id: 'd1', stripe_payment_intent_id: 'pi_a', status: 'received', amount: '49.00', credited_amount: '0.00', card_surcharge: '1.42' }],
    });
    mockDbHandler = handler;

    const result = await refundUnconsumedDeposits({ estimateId: 'est-1', reason: 'cancel_signup', includeSurchargeShare: false });
    expect(result.refunded).toBe(49);
    // Face cents only — no prorated fee share rides the refund.
    expect(mockRefundPaymentIntent).toHaveBeenCalledWith('pi_a', { amountCents: 4900 });
    // refunded_surcharge 0 = the explicit "fee stayed earned" marker the
    // deposit revenue rollup reads (vs NULL = legacy proration fallback).
    expect(state.rows[0]).toMatchObject({ status: 'refunded', refunded_amount: 49, refunded_surcharge: 0 });
    // The CLAIM update pre-stamped the face total so a webhook echo landing
    // mid-'refunding' hits the replay guard instead of deflating the stamp.
    const claimUpdate = state.updates.find((u) => u.payload.status === 'refunding');
    expect(claimUpdate.payload.refunded_amount).toBe(49);
  });

  it('the prorated sweep stamps the fee share it returned in refunded_surcharge', async () => {
    mockRefundPaymentIntent.mockResolvedValue({ id: 're_1' });
    const { handler, state } = sweepDb({
      rows: [{ id: 'd1', stripe_payment_intent_id: 'pi_a', status: 'received', amount: '49.00', credited_amount: '0.00', card_surcharge: '1.42' }],
    });
    mockDbHandler = handler;

    const result = await refundUnconsumedDeposits({ estimateId: 'est-1', reason: 'exempt_accept:prepay_annual' });
    expect(result.refunded).toBe(49);
    // Full remainder + full fee share rides the refund; the stamp records it.
    expect(mockRefundPaymentIntent).toHaveBeenCalledWith('pi_a', { amountCents: 5042 });
    expect(state.rows[0]).toMatchObject({ status: 'refunded', refunded_amount: 49, refunded_surcharge: 1.42 });
  });

  it('never rolls back after Stripe succeeds — a failed terminal stamp keeps the refunding claim + pre-stamp', async () => {
    mockRefundPaymentIntent.mockResolvedValue({ id: 're_1' });
    const { handler, state } = sweepDb({
      rows: [{ id: 'd1', stripe_payment_intent_id: 'pi_a', status: 'received', amount: '49.00', credited_amount: '0.00', card_surcharge: '1.42' }],
    });
    mockDbHandler = (table) => {
      const c = handler(table);
      const origUpdate = c.update;
      c.update = async (payload) => {
        if (payload.status === 'refunded' || payload.status === 'credited') throw new Error('db blip');
        return origUpdate(payload);
      };
      return c;
    };

    const result = await refundUnconsumedDeposits({ estimateId: 'est-1', reason: 'cancel_signup', includeSurchargeShare: false });
    // Money moved and is counted; the row stays CLAIMED (sweeps exclude
    // 'refunding', so nothing can double-refund it) with the face
    // pre-stamp intact, and a human is paged.
    expect(result.refunded).toBe(49);
    expect(state.rows[0]).toMatchObject({ status: 'refunding', refunded_amount: 49 });
    expect(mockTriggerNotification).toHaveBeenCalledWith('estimate_deposit_reconcile_needed', { estimateId: 'est-1' });
  });

  it('face-only Stripe failure reverts the pre-stamp with the claim — the ledger never says money moved', async () => {
    mockRefundPaymentIntent.mockRejectedValue(new Error('stripe down'));
    const { handler, state } = sweepDb({
      rows: [{ id: 'd1', stripe_payment_intent_id: 'pi_a', status: 'received', amount: '49.00', credited_amount: '0.00', card_surcharge: '1.42' }],
    });
    mockDbHandler = handler;

    const result = await refundUnconsumedDeposits({ estimateId: 'est-1', reason: 'cancel_signup', includeSurchargeShare: false });
    expect(result.refunded).toBe(0);
    expect(state.rows[0]).toMatchObject({ status: 'received', refunded_amount: 0 });
  });

  it('rows consumed mid-sweep are skipped — their claim simply loses', async () => {
    mockRefundPaymentIntent.mockResolvedValue({ id: 're_1' });
    const { handler, state } = sweepDb({
      rows: [{ id: 'd1', stripe_payment_intent_id: 'pi_a', status: 'credited', amount: '49.00', credited_amount: '49.00' }],
    });
    // The select snapshot saw the row as received, but the live row was
    // consumed before the claim (an invoice consume won the race).
    state.selectRows = [{ id: 'd1', stripe_payment_intent_id: 'pi_a', status: 'received', amount: '49.00', credited_amount: '0.00' }];
    mockDbHandler = handler;

    const result = await refundUnconsumedDeposits({ estimateId: 'est-1', reason: 'exempt_accept:prepay_annual' });
    expect(result.refunded).toBe(0);
    expect(mockRefundPaymentIntent).not.toHaveBeenCalled();
  });
});

describe('sweepTerminalEstimateDeposits — decline/expiry lifecycle refunds (P1)', () => {
  const { sweepTerminalEstimateDeposits } = require('../services/estimate-deposits');

  // First query (aliased join) finds estimates holding stranded money;
  // the per-estimate refund then runs the standard sweep queries.
  function terminalSweepDb({ strandedEstimateIds = [], rows = [] }) {
    return (table) => {
      if (table === 'estimate_deposits as ed') {
        const chain = {
          join: () => chain,
          where: () => chain,
          whereIn: () => chain,
          distinct: async () => strandedEstimateIds.map((id) => ({ estimate_id: id })),
        };
        return chain;
      }
      if (table !== 'estimate_deposits') throw new Error(`unexpected table: ${table}`);
      const q = { criteria: {} };
      const chain = {
        where(c) { Object.assign(q.criteria, c); return chain; },
        select: async () => rows
          .filter((r) => r.status === q.criteria.status && r.estimate_id === q.criteria.estimate_id)
          .map((r) => ({ ...r })),
        update: async (payload) => {
          const target = rows.find((r) => r.id === q.criteria.id);
          if (!target) return 0;
          if (q.criteria.status && target.status !== q.criteria.status) return 0;
          if (q.criteria.credited_amount !== undefined && String(target.credited_amount) !== String(q.criteria.credited_amount)) return 0;
          Object.assign(target, payload);
          return 1;
        },
      };
      return chain;
    };
  }

  it('refunds received deposits stranded on declined/expired estimates — paid-then-abandoned money comes back', async () => {
    mockRefundPaymentIntent.mockResolvedValue({ id: 're_1' });
    const rows = [
      { id: 'd1', estimate_id: 'est-9', stripe_payment_intent_id: 'pi_a', status: 'received', amount: '49.00', credited_amount: '0.00', refunded_amount: 0 },
    ];
    mockDbHandler = terminalSweepDb({ strandedEstimateIds: ['est-9'], rows });

    const result = await sweepTerminalEstimateDeposits();
    expect(result).toEqual({ estimatesSwept: 1, refundedTotal: 49 });
    expect(mockRefundPaymentIntent).toHaveBeenCalledWith('pi_a', { amountCents: 4900 });
    expect(rows[0]).toMatchObject({ status: 'refunded', refunded_amount: 49 });
  });

  it('nothing stranded = no Stripe calls', async () => {
    mockDbHandler = terminalSweepDb({ strandedEstimateIds: [], rows: [] });
    const result = await sweepTerminalEstimateDeposits();
    expect(result).toEqual({ estimatesSwept: 0, refundedTotal: 0 });
    expect(mockRefundPaymentIntent).not.toHaveBeenCalled();
  });

  it('one estimate failing does not stop the sweep for the rest', async () => {
    mockRefundPaymentIntent
      .mockRejectedValueOnce(new Error('stripe down'))
      .mockResolvedValueOnce({ id: 're_2' });
    const rows = [
      { id: 'd1', estimate_id: 'est-a', stripe_payment_intent_id: 'pi_a', status: 'received', amount: '49.00', credited_amount: '0.00', refunded_amount: 0 },
      { id: 'd2', estimate_id: 'est-b', stripe_payment_intent_id: 'pi_b', status: 'received', amount: '99.00', credited_amount: '0.00', refunded_amount: 0 },
    ];
    mockDbHandler = terminalSweepDb({ strandedEstimateIds: ['est-a', 'est-b'], rows });

    const result = await sweepTerminalEstimateDeposits();
    expect(result).toEqual({ estimatesSwept: 1, refundedTotal: 99 });
    // The failed estimate's row reverted to received for the next daily run.
    expect(rows[0].status).toBe('received');
    expect(rows[1].status).toBe('refunded');
  });
});

describe('consumeDepositCredit — partial application tracking', () => {
  const { consumeDepositCredit } = require('../services/estimate-deposits');

  // updateResults maps row id → affected count, mimicking the CONDITIONAL
  // update; 0 = the row was flipped under us by a reversal webhook.
  function consumeDb({ rows, updates = [], updateResults = {} }) {
    return () => ({
      where(criteria) {
        if (criteria && criteria.id) {
          return {
            update: async (payload) => {
              updates.push({ id: criteria.id, criteria, payload });
              return updateResults[criteria.id] ?? 1;
            },
          };
        }
        return this;
      },
      orderBy() { return this; },
      select: async () => rows,
    });
  }

  it('allocates oldest-first; partial rows stay received with only the remainder available', async () => {
    const updates = [];
    mockDbHandler = consumeDb({
      rows: [
        { id: 'd1', amount: '50.00', credited_amount: '0.00' },
        { id: 'd2', amount: '70.00', credited_amount: '0.00' },
      ],
      updates,
    });

    // Apply $80: d1 fully consumed ($50, flips credited), d2 partially ($30, stays received).
    const allocated = await consumeDepositCredit({ estimateId: 'est-1', amount: 80, invoiceId: 'inv-1' });
    expect(allocated).toBe(80);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ id: 'd1', payload: { credited_amount: 50, status: 'credited', credited_invoice_id: 'inv-1' } });
    // Conditional on the exact state the allocation was computed from.
    expect(updates[0].criteria).toMatchObject({ id: 'd1', status: 'received', credited_amount: '0.00' });
    expect(updates[1].id).toBe('d2');
    expect(updates[1].payload.credited_amount).toBe(30);
    expect(updates[1].payload.status).toBeUndefined();
  });

  it('a row flipped to refunded mid-consume is NOT counted — allocated reflects only won rows', async () => {
    const updates = [];
    mockDbHandler = consumeDb({
      rows: [
        { id: 'd1', amount: '50.00', credited_amount: '0.00' },
        { id: 'd2', amount: '70.00', credited_amount: '0.00' },
      ],
      updates,
      // d2's conditional update loses (a reversal webhook flipped it).
      updateResults: { d2: 0 },
    });

    const allocated = await consumeDepositCredit({ estimateId: 'est-1', amount: 80, invoiceId: 'inv-1' });
    // Only d1's $50 was actually consumed — callers see the mismatch vs the
    // $80 they applied and roll the invoice back.
    expect(allocated).toBe(50);
  });

  it('zero/negative amounts are no-ops', async () => {
    mockDbHandler = () => { throw new Error('should not query'); };
    expect(await consumeDepositCredit({ estimateId: 'est-1', amount: 0, invoiceId: 'inv-1' })).toBe(0);
  });

  it('partially refunded rows expose only the unrefunded remainder (P2)', async () => {
    const updates = [];
    // $99 deposit, $50 already returned via dashboard partial refund — only
    // $49 may ever be credited, and credit+refund together exhaust the row.
    mockDbHandler = consumeDb({
      rows: [{ id: 'd1', amount: '99.00', credited_amount: '0.00', refunded_amount: '50.00' }],
      updates,
    });
    const allocated = await consumeDepositCredit({ estimateId: 'est-1', amount: 80, invoiceId: 'inv-1' });
    expect(allocated).toBe(49);
    expect(updates[0].payload).toMatchObject({ credited_amount: 49, status: 'credited', credited_invoice_id: 'inv-1' });
    expect(updates[0].criteria).toMatchObject({ refunded_amount: '50.00' });
  });

  it('pendingDepositCredit nets partial refunds out of the available balance (P2)', async () => {
    mockDbHandler = consumeDb({
      rows: [{ id: 'd1', amount: '99.00', credited_amount: '20.00', refunded_amount: '50.00' }],
    });
    const credit = await pendingDepositCredit('est-1');
    expect(credit.amount).toBe(29);
  });
});

describe('restoreDepositCreditForVoidedInvoice — void returns consumed dollars to the ledger (P1)', () => {
  const { restoreDepositCreditForVoidedInvoice } = require('../services/estimate-deposits');
  const logger = require('../services/logger');

  function voidedInvoice(creditLines) {
    return {
      id: 'inv-void',
      status: 'void',
      line_items: JSON.stringify([
        { description: 'Service', quantity: 1, unit_price: 100 },
        ...creditLines,
      ]),
    };
  }
  const creditLine = (amount, estimateId = 'est-1') => ({
    description: 'Deposit credit (paid at acceptance)',
    quantity: 1,
    unit_price: -amount,
    amount: -amount,
    category: 'deposit_credit',
    ...(estimateId ? { estimate_id: estimateId } : {}),
  });

  // Mirrors consumeDb: conditional updates report affected counts; 0 = the
  // row was flipped under us by a reversal webhook.
  function restoreDb({ rows, updates = [], updateResults = {} }) {
    return () => ({
      where(criteria) {
        if (criteria && criteria.id) {
          return {
            update: async (payload) => {
              updates.push({ id: criteria.id, criteria, payload });
              return updateResults[criteria.id] ?? 1;
            },
          };
        }
        return this;
      },
      whereIn() { return this; },
      orderBy() { return this; },
      select: async () => rows,
    });
  }

  it('restores newest consumption first; a fully-consumed row flips back to received with no invoice stamp', async () => {
    const updates = [];
    mockDbHandler = restoreDb({
      rows: [
        { id: 'd2', status: 'credited', credited_amount: '49.00' }, // newest
        { id: 'd1', status: 'received', credited_amount: '30.00' },
      ],
      updates,
    });

    const restored = await restoreDepositCreditForVoidedInvoice({ invoice: voidedInvoice([creditLine(70)]) });

    expect(restored).toBe(70);
    expect(updates[0]).toMatchObject({
      id: 'd2',
      payload: { credited_amount: 0, status: 'received', credited_invoice_id: null },
    });
    // Conditional on the exact state the math used.
    expect(updates[0].criteria).toMatchObject({ id: 'd2', status: 'credited', credited_amount: '49.00' });
    // The remaining $21 comes off the partially-consumed row, which keeps
    // its received status (no status key in the payload).
    expect(updates[1].id).toBe('d1');
    expect(updates[1].payload.credited_amount).toBe(9);
    expect(updates[1].payload.status).toBeUndefined();
  });

  it('a row flipped terminal mid-restore is skipped — the shortfall alerts and THROWS so the void rolls back (P1)', async () => {
    const updates = [];
    mockDbHandler = restoreDb({
      rows: [{ id: 'd1', status: 'credited', credited_amount: '49.00' }],
      updates,
      updateResults: { d1: 0 },
    });

    // Never resurrects refunded money; the throw aborts the enclosing void
    // transaction so the invoice stays live until a human reconciles.
    await expect(restoreDepositCreditForVoidedInvoice({ invoice: voidedInvoice([creditLine(49)]) }))
      .rejects.toThrow(/void blocked/);
    expect(logger.error).toHaveBeenCalled();
    expect(mockTriggerNotification).toHaveBeenCalledWith('estimate_deposit_reconcile_needed', { invoiceId: 'inv-void' });
  });

  it('an unstamped legacy credit line cannot be attributed — alert + throw instead of guessing a ledger', async () => {
    mockDbHandler = () => { throw new Error('should not query without an estimate stamp'); };
    await expect(restoreDepositCreditForVoidedInvoice({ invoice: voidedInvoice([creditLine(49, null)]) }))
      .rejects.toThrow(/void blocked/);
    expect(mockTriggerNotification).toHaveBeenCalledWith('estimate_deposit_reconcile_needed', { invoiceId: 'inv-void' });
  });

  it('no deposit lines (or unparseable line_items) = silent no-op', async () => {
    mockDbHandler = () => { throw new Error('should not query'); };
    expect(await restoreDepositCreditForVoidedInvoice({ invoice: voidedInvoice([]) })).toBe(0);
    expect(await restoreDepositCreditForVoidedInvoice({ invoice: { id: 'x', line_items: '{not json' } })).toBe(0);
    expect(mockTriggerNotification).not.toHaveBeenCalled();
  });
});

describe('handleDepositIntentCanceled — canceled PIs go terminal so retries mint fresh intents (P1)', () => {
  const { handleDepositIntentCanceled } = require('../services/estimate-deposits');

  function canceledDb({ updates = [], updateResult = 1 } = {}) {
    return (table) => {
      if (table !== 'estimate_deposits') throw new Error(`unexpected table: ${table}`);
      return {
        where(criteria) {
          return {
            update: async (payload) => {
              updates.push({ criteria, payload });
              return updateResult;
            },
          };
        },
      };
    };
  }

  it('flips ONLY the pending row to failed — the terminal row advances the retry generation', async () => {
    const updates = [];
    mockDbHandler = canceledDb({ updates });
    const result = await handleDepositIntentCanceled({
      id: 'pi_dead',
      metadata: { purpose: 'estimate_deposit', estimate_id: 'est-1' },
    });
    expect(result.handled).toBe(true);
    expect(updates[0].criteria).toMatchObject({ stripe_payment_intent_id: 'pi_dead', status: 'pending' });
    expect(updates[0].payload.status).toBe('failed');
  });

  it('non-deposit PIs and received/credited rows are untouched', async () => {
    mockDbHandler = () => { throw new Error('should not query'); };
    expect((await handleDepositIntentCanceled({ id: 'pi_x', metadata: {} })).handled).toBe(false);
    // A row already received/credited simply does not match the conditional
    // (status: pending) — the cancellation echo cannot un-receive money.
    const updates = [];
    mockDbHandler = canceledDb({ updates, updateResult: 0 });
    const result = await handleDepositIntentCanceled({
      id: 'pi_paid',
      metadata: { purpose: 'estimate_deposit', estimate_id: 'est-1' },
    });
    expect(result.handled).toBe(true);
    expect(updates[0].criteria).toMatchObject({ status: 'pending' });
  });
});

describe('assessDepositFollowUpEligibility (deposit-abandonment nudge) — RETIRED', () => {
  const gates = require('../routes/estimate-public');
  const { buildEstimateMembershipContext } = require('../services/estimate-membership-context');
  const { assessDepositFollowUpEligibility } = require('../services/estimate-deposits');

  // Minimal chainable for this helper's three reads.
  function followUpDb({ estimate, receivedRows = [], pendingRow = undefined }) {
    return (table) => {
      const b = {};
      for (const m of ['where', 'whereIn', 'orderBy', 'select']) {
        b[m] = jest.fn(() => b);
      }
      b.first = jest.fn(async () =>
        table === 'estimates' ? estimate : pendingRow,
      );
      b.then = (resolve, reject) =>
        Promise.resolve(table === 'estimate_deposits' ? receivedRows : [])
          .then(resolve, reject);
      return b;
    };
  }

  const NOW = new Date('2026-06-10T15:00:00Z');
  const hoursBefore = (h) => new Date(NOW.getTime() - h * 3600000);

  beforeEach(() => {
    mockIsEstimateAcceptActive.mockReturnValue(true);
    gates.buildPricingBundle.mockResolvedValue({});
    gates.resolveEstimateQuoteRequirement.mockReturnValue({ quoteRequired: false });
    gates.isStructuralOneTimeOnlyEstimate.mockReturnValue(false);
    buildEstimateMembershipContext.mockResolvedValue({ isExistingCustomer: false });
    mockLoadExistingRecurringQualifyingRows.mockResolvedValue([]);
  });

  // RETIREMENT PIN (owner ruling 2026-08-10): the deposit policy is
  // permanently not-required, so the abandonment nudge is permanently
  // ineligible — even for the once-perfect shape (live estimate, in-window
  // pending intent, nothing received). No new pending intents can exist
  // (the mint endpoints were removed); this covers webhook-era residue.
  it('never eligible — deposits are retired, even for the once-perfect nudge shape', async () => {
    mockDbHandler = followUpDb({
      estimate: { id: 'est-1', status: 'viewed', estimate_data: '{}' },
      receivedRows: [],
      pendingRow: { id: 'dep-1', status: 'pending', updated_at: hoursBefore(3) },
    });
    const out = await assessDepositFollowUpEligibility('est-1', NOW);
    expect(out.eligible).toBe(false);
  });
});
describe('sendDepositReceiptEmailFallback — scheduled-replay handoff to the email leg', () => {
  const { sendDepositReceiptEmailFallback } = require('../services/estimate-deposits');

  const ledgerCalls = { where: [], orderBy: 0 };
  const fallbackDb = ({ estimate, customer, prefs, ledger, prefsLookupThrows = false }) => (table) => {
    const rows = {
      estimates: estimate,
      customers: customer,
      notification_prefs: prefs,
      estimate_deposits: ledger,
    };
    const q = {
      where: (...args) => { if (table === 'estimate_deposits') ledgerCalls.where.push(args[0]); return q; },
      whereIn: () => q,
      orderBy: () => { if (table === 'estimate_deposits') ledgerCalls.orderBy += 1; return q; },
      first: () => (table === 'notification_prefs' && prefsLookupThrows
        ? Promise.reject(new Error('db blip'))
        : Promise.resolve(rows[table] ?? null)),
    };
    return q;
  };

  const baseEstimate = { id: 'est-1', customer_id: 'cust-1', customer_phone: '(941) 555-0199', customer_name: 'Sam Customer', customer_email: 'stale@estimate.example', token: 'tok-1' };
  const baseCustomer = { id: 'cust-1', phone: '(941) 555-0100', first_name: 'Sam', email: 'sam@customer.example' };
  const baseLedger = { amount: 70, stripe_payment_intent_id: 'pi_replay' };

  beforeEach(() => { mockSendTemplate.mockClear(); ledgerCalls.where.length = 0; ledgerCalls.orderBy = 0; });

  it('re-derives amount + PaymentIntent from the deposit ledger and sends the email', async () => {
    mockDbHandler = fallbackDb({ estimate: baseEstimate, customer: baseCustomer, prefs: { payment_confirmation_sms: false }, ledger: baseLedger });
    const r = await sendDepositReceiptEmailFallback('est-1');
    expect(r).toEqual({ sent: true });
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    expect(mockSendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'deposit.receipt',
      to: 'sam@customer.example',
      idempotencyKey: 'deposit_receipt:pi_replay',
      payload: expect.objectContaining({ amount: '$70' }),
    }));
  });

  it('payment_receipt=false stays the full kill switch — PURPOSE_OPTED_OUT replays must not email', async () => {
    mockDbHandler = fallbackDb({ estimate: baseEstimate, customer: baseCustomer, prefs: { payment_receipt: false }, ledger: baseLedger });
    const r = await sendDepositReceiptEmailFallback('est-1');
    expect(r).toEqual({ sent: false, reason: 'receipt_opted_out' });
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  it('portal-wide email opt-out is honored', async () => {
    mockDbHandler = fallbackDb({ estimate: baseEstimate, customer: baseCustomer, prefs: { email_enabled: false }, ledger: baseLedger });
    const r = await sendDepositReceiptEmailFallback('est-1');
    expect(r).toEqual({ sent: false, reason: 'email_opted_out' });
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  it('no received/credited ledger row → nothing to receipt', async () => {
    mockDbHandler = fallbackDb({ estimate: baseEstimate, customer: baseCustomer, prefs: {}, ledger: null });
    const r = await sendDepositReceiptEmailFallback('est-1');
    expect(r).toEqual({ sent: false, reason: 'no_received_deposit' });
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  it('propagates a non-send from the email leg — a recipient-less fallback must not read as receipted', async () => {
    // The scheduler logs this result; { sent: true } over a skipped email
    // would make the missing receipt invisible (codex round 7).
    mockDbHandler = fallbackDb({ estimate: baseEstimate, customer: { ...baseCustomer, email: '' }, prefs: {}, ledger: baseLedger });
    const r = await sendDepositReceiptEmailFallback('est-1');
    expect(r).toEqual({ sent: false, reason: 'no_recipient_email' });
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the prefs lookup errors — a DB blip must not bypass the kill switch', async () => {
    // The fallback often runs right after a PURPOSE_OPTED_OUT block that may
    // BE the payment_receipt=false kill switch (codex round 6).
    mockDbHandler = fallbackDb({ estimate: baseEstimate, customer: baseCustomer, ledger: baseLedger, prefsLookupThrows: true });
    const r = await sendDepositReceiptEmailFallback('est-1');
    expect(r).toEqual({ sent: false, reason: 'prefs_lookup_failed' });
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  it('targets the QUEUED deposit by PaymentIntent on multi-deposit estimates — never latest-row', async () => {
    // A queued older receipt must not email the newest top-up's amount/PI
    // (wrong idempotency key = wrong dedupe; codex round 6).
    mockDbHandler = fallbackDb({ estimate: baseEstimate, customer: baseCustomer, prefs: {}, ledger: { amount: 35, stripe_payment_intent_id: 'pi_queued' } });
    const r = await sendDepositReceiptEmailFallback('est-1', { paymentIntentId: 'pi_queued' });
    expect(r).toEqual({ sent: true });
    expect(ledgerCalls.where).toContainEqual({ stripe_payment_intent_id: 'pi_queued' });
    expect(ledgerCalls.orderBy).toBe(0);
    expect(mockSendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'deposit_receipt:pi_queued',
      payload: expect.objectContaining({ amount: '$35' }),
    }));
  });
});

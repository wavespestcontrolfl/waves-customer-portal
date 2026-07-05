jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(),
}));
jest.mock('../services/account-membership-email', () => ({
  sendMembershipRenewalReminder: jest.fn(),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'wpc'),
}));
jest.mock('../utils/portal-url', () => ({
  publicPortalUrl: jest.fn(() => 'https://portal.wavespestcontrol.com'),
}));
jest.mock('../services/customer-credit', () => ({
  autoApplyAccountCreditIfEnabled: jest.fn().mockResolvedValue(null),
  reverseAppliedCredit: jest.fn().mockResolvedValue(0),
}));

const db = require('../models/db');
const { autoApplyAccountCreditIfEnabled, reverseAppliedCredit } = require('../services/customer-credit');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
const { _private } = AnnualPrepayRenewals;

const REMINDER_COLS = {
  payment_reminder_3d_sent_at: {},
  payment_reminder_3d_claimed_at: {},
  payment_reminder_1d_sent_at: {},
  payment_reminder_1d_claimed_at: {},
};

function query({ first, returning, columnInfo, rows = [] } = {}) {
  const q = {};
  [
    'whereIn',
    'whereNull',
    'whereBetween',
    'whereNotIn',
    'whereNotNull',
    'orderBy',
    'select',
    'join',
  ].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.where = jest.fn((arg) => {
    if (typeof arg === 'function') arg.call(q);
    return q;
  });
  q.orWhere = jest.fn(() => q);
  q.orWhereNotNull = jest.fn(() => q);
  q.update = jest.fn(() => q);
  q.insert = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(async () => returning || []);
  q.columnInfo = jest.fn(async () => columnInfo || {});
  q.catch = jest.fn(() => Promise.resolve());
  q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return q;
}

function setDbQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    const queue = tableQueues.get(table);
    if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
    return queue.shift();
  });
  return tableQueues;
}

const BASE_TERM = {
  id: 'term-1',
  customer_id: 'cust-1',
  prepay_invoice_id: 'inv-1',
  status: 'payment_pending',
  term_start: '2026-07-11',
  term_end: '2027-07-11',
  payment_reminder_3d_sent_at: null,
  payment_reminder_1d_sent_at: null,
};

const UNPAID_INVOICE = { id: 'inv-1', status: 'sent', total: '392.04', token: 'tok-1', payer_id: null };
const CUSTOMER = { id: 'cust-1', first_name: 'Aaron', phone: '+15550001111' };

describe('annual prepay pre-visit payment reminders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
    _private.resetCachesForTests();
  });

  test('column helpers map only the supported day counts', () => {
    expect(_private.paymentReminderColumnForDaysOut(3)).toBe('payment_reminder_3d_sent_at');
    expect(_private.paymentReminderColumnForDaysOut(1)).toBe('payment_reminder_1d_sent_at');
    expect(_private.paymentReminderColumnForDaysOut(7)).toBe(null);
    expect(_private.paymentReminderClaimColumnForDaysOut(3)).toBe('payment_reminder_3d_claimed_at');
    expect(_private.paymentReminderClaimColumnForDaysOut(1)).toBe('payment_reminder_1d_claimed_at');
  });

  test('happy path: claims, renders the template with amount/visit/pay link, sends payment_link SMS, marks sent', async () => {
    const claimQ = query({ returning: [{ ...BASE_TERM }] });
    const markSentQ = query();
    setDbQueues({
      annual_prepay_terms: [
        query({ columnInfo: REMINDER_COLS }), // annualPrepayColumns
        claimQ,
        markSentQ,
      ],
      invoices: [
        query({ first: { ...UNPAID_INVOICE } }),
        query({ first: { ...UNPAID_INVOICE } }), // post-credit-seam re-read
      ],
      invoice_followup_sequences: [query({ first: undefined })],
      customers: [query({ first: { ...CUSTOMER } })],
      customer_interactions: [query()],
    });
    renderSmsTemplate.mockResolvedValue('pay reminder body');
    sendCustomerMessage.mockResolvedValue({ sent: true });

    const result = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1);

    expect(result).toEqual({ sent: true, termId: 'term-1' });
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'annual_prepay_payment_reminder',
      expect.objectContaining({
        first_name: 'Aaron',
        amount_text: ' for $392.04',
        first_visit_date: expect.stringContaining('July 11'),
        pay_link: 'https://portal.wavespestcontrol.com/pay/tok-1',
      }),
      expect.objectContaining({ workflow: 'annual_prepay_payment_reminder' }),
    );
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'payment_link',
      invoiceId: 'inv-1',
      customerId: 'cust-1',
      entryPoint: 'annual_prepay_payment_reminder',
    }));
    // Sent column stamped + claim cleared.
    expect(markSentQ.update).toHaveBeenCalledWith(expect.objectContaining({
      payment_reminder_1d_sent_at: expect.any(Date),
      payment_reminder_1d_claimed_at: null,
    }));
  });

  test.each(['paid', 'processing', 'prepaid', 'void'])(
    'skips a %s invoice (canonical collectibility — in-flight ACH must not be re-asked) — no claim, no SMS',
    async (status) => {
      setDbQueues({
        annual_prepay_terms: [query({ columnInfo: REMINDER_COLS })],
        invoices: [query({ first: { ...UNPAID_INVOICE, status } })],
      });

      const result = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1);

      expect(result).toEqual({ sent: false, reason: 'invoice_not_collectible' });
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    },
  );

  test('skips when already-applied account credit fully covers the balance (pre-claim)', async () => {
    setDbQueues({
      annual_prepay_terms: [query({ columnInfo: REMINDER_COLS })],
      invoices: [query({ first: { ...UNPAID_INVOICE, credit_applied: '392.04' } })],
      invoice_followup_sequences: [query({ first: undefined })],
    });

    const result = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1);

    expect(result).toEqual({ sent: false, reason: 'fully_credited' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('quotes the amount DUE (total minus applied credit), not the gross total', async () => {
    const partialCredit = { ...UNPAID_INVOICE, credit_applied: '92.04' };
    setDbQueues({
      annual_prepay_terms: [
        query({ columnInfo: REMINDER_COLS }),
        query({ returning: [{ ...BASE_TERM }] }),
        query(),
      ],
      invoices: [query({ first: partialCredit }), query({ first: partialCredit })],
      invoice_followup_sequences: [query({ first: undefined })],
      customers: [query({ first: { ...CUSTOMER } })],
      customer_interactions: [query()],
    });
    renderSmsTemplate.mockResolvedValue('pay reminder body');
    sendCustomerMessage.mockResolvedValue({ sent: true });

    const result = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1);

    expect(result).toEqual({ sent: true, termId: 'term-1' });
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'annual_prepay_payment_reminder',
      expect.objectContaining({ amount_text: ' for $300.00' }),
      expect.anything(),
    );
  });

  test('skips a payer-billed invoice — never texts the homeowner a payer pay link', async () => {
    setDbQueues({
      annual_prepay_terms: [query({ columnInfo: REMINDER_COLS })],
      invoices: [query({ first: { ...UNPAID_INVOICE, payer_id: 'payer-9' } })],
    });
    // payer check fires on the first read — before the credit seam re-read.

    const result = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1);

    expect(result).toEqual({ sent: false, reason: 'payer_billed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('defers to the invoice follow-up sequence when dunning touched the customer recently', async () => {
    setDbQueues({
      annual_prepay_terms: [query({ columnInfo: REMINDER_COLS })],
      invoices: [query({ first: { ...UNPAID_INVOICE } })],
      invoice_followup_sequences: [query({
        first: { status: 'active', last_touch_at: new Date(Date.now() - 60 * 60 * 1000), next_touch_at: null },
      })],
    });

    const result = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 3);

    expect(result).toEqual({ sent: false, reason: 'dunning_active_today' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a DUE dunning touch suppresses only on days the follow-up cron runs (Tue–Fri)', async () => {
    const dueRow = { status: 'active', last_touch_at: null, next_touch_at: new Date('2026-07-06T14:00:00Z') };
    // Wednesday 2026-07-08: cron fires → suppress.
    setDbQueues({ invoice_followup_sequences: [query({ first: { ...dueRow } })] });
    await expect(_private.invoiceDunningActiveToday('inv-1', { todayYmd: '2026-07-08' })).resolves.toBe(true);
    // Monday 2026-07-06: no dunning runs Mondays — the reminder must NOT be
    // suppressed or the customer reaches the visit with no contact at all.
    setDbQueues({ invoice_followup_sequences: [query({ first: { ...dueRow } })] });
    await expect(_private.invoiceDunningActiveToday('inv-1', { todayYmd: '2026-07-06' })).resolves.toBe(false);
    // Saturday 2026-07-11: same.
    setDbQueues({ invoice_followup_sequences: [query({ first: { ...dueRow } })] });
    await expect(_private.invoiceDunningActiveToday('inv-1', { todayYmd: '2026-07-11' })).resolves.toBe(false);
  });

  test('missing SMS template releases the claim instead of stamping sent', async () => {
    const claimQ = query({ returning: [{ ...BASE_TERM }] });
    const releaseQ = query();
    setDbQueues({
      annual_prepay_terms: [
        query({ columnInfo: REMINDER_COLS }),
        claimQ,
        releaseQ,
      ],
      invoices: [query({ first: { ...UNPAID_INVOICE } }), query({ first: { ...UNPAID_INVOICE } })],
      invoice_followup_sequences: [query({ first: undefined })],
      customers: [query({ first: { ...CUSTOMER } })],
    });
    renderSmsTemplate.mockResolvedValue(null);

    const result = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1);

    expect(result).toEqual({ sent: false, reason: 'missing_sms_template' });
    expect(releaseQ.update).toHaveBeenCalledWith(expect.objectContaining({
      payment_reminder_1d_claimed_at: null,
    }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('no phone: marks the reminder sent (email leg already exists) so the cron never re-claims', async () => {
    const claimQ = query({ returning: [{ ...BASE_TERM }] });
    const markQ = query();
    setDbQueues({
      annual_prepay_terms: [
        query({ columnInfo: REMINDER_COLS }),
        claimQ,
        markQ,
      ],
      invoices: [query({ first: { ...UNPAID_INVOICE } }), query({ first: { ...UNPAID_INVOICE } })],
      invoice_followup_sequences: [query({ first: undefined })],
      customers: [query({ first: { ...CUSTOMER, phone: null } })],
    });

    const result = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1);

    expect(result).toEqual({ sent: false, reason: 'no_phone' });
    expect(markQ.update).toHaveBeenCalledWith(expect.objectContaining({
      payment_reminder_1d_sent_at: expect.any(Date),
    }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('credit the seam applied is REVERSED when the reminder cannot be delivered (mirrors dunning)', async () => {
    autoApplyAccountCreditIfEnabled.mockResolvedValueOnce({ applied: 50 });
    const claimQ = query({ returning: [{ ...BASE_TERM }] });
    const releaseQ = query();
    setDbQueues({
      annual_prepay_terms: [
        query({ columnInfo: REMINDER_COLS }),
        claimQ,
        releaseQ,
      ],
      invoices: [
        query({ first: { ...UNPAID_INVOICE } }),
        // post-seam re-read: 50 applied, balance remains — reminder still owed
        query({ first: { ...UNPAID_INVOICE, credit_applied: '50.00' } }),
      ],
      invoice_followup_sequences: [query({ first: undefined })],
      customers: [query({ first: { ...CUSTOMER } })],
    });
    renderSmsTemplate.mockResolvedValue(null); // template missing → no touch

    const result = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1);

    expect(result).toEqual({ sent: false, reason: 'missing_sms_template' });
    expect(reverseAppliedCredit).toHaveBeenCalledWith(expect.objectContaining({
      invoiceId: 'inv-1',
      amount: 50,
      createdBy: 'system:prepay_reminder_undelivered',
    }));
  });

  test('a seam apply that FULLY covers the invoice keeps the credit (settle event, not an undelivered touch)', async () => {
    autoApplyAccountCreditIfEnabled.mockResolvedValueOnce({ applied: 392.04, fullyCovered: true });
    const claimQ = query({ returning: [{ ...BASE_TERM }] });
    const releaseQ = query();
    setDbQueues({
      annual_prepay_terms: [
        query({ columnInfo: REMINDER_COLS }),
        claimQ,
        releaseQ,
      ],
      invoices: [
        query({ first: { ...UNPAID_INVOICE } }),
        query({ first: { ...UNPAID_INVOICE, status: 'prepaid', credit_applied: '392.04' } }),
      ],
      invoice_followup_sequences: [query({ first: undefined })],
    });

    const result = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1);

    expect(result).toEqual({ sent: false, reason: 'invoice_not_collectible' });
    expect(reverseAppliedCredit).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('soft-deleted customer never gets a pay-link text — claim released', async () => {
    const claimQ = query({ returning: [{ ...BASE_TERM }] });
    const releaseQ = query();
    setDbQueues({
      annual_prepay_terms: [
        query({ columnInfo: REMINDER_COLS }),
        claimQ,
        releaseQ,
      ],
      invoices: [query({ first: { ...UNPAID_INVOICE } }), query({ first: { ...UNPAID_INVOICE } })],
      invoice_followup_sequences: [query({ first: undefined })],
      // whereNull('deleted_at') filters the archived account out.
      customers: [query({ first: undefined })],
    });

    const result = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1);

    expect(result).toEqual({ sent: false, reason: 'customer_missing_or_deleted' });
    expect(releaseQ.update).toHaveBeenCalledWith(expect.objectContaining({
      payment_reminder_1d_claimed_at: null,
    }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('already-sent column short-circuits before any invoice read', async () => {
    setDbQueues({
      annual_prepay_terms: [query({ columnInfo: REMINDER_COLS })],
    });

    const result = await AnnualPrepayRenewals.sendPaymentPendingReminder(
      { ...BASE_TERM, payment_reminder_1d_sent_at: new Date() },
      1,
    );

    expect(result).toEqual({ sent: false, reason: 'already_sent' });
  });

  test('checkAndSendPaymentReminders skips cleanly before the migration lands (columns missing)', async () => {
    setDbQueues({
      // activatePaidPendingTerms join query — no paid-pending rows.
      'annual_prepay_terms as t': [query({ rows: [] })],
      // annualPrepayColumns (once per daysOut loop; cache fills on first call)
      annual_prepay_terms: [query({ columnInfo: { id: {}, status: {} } })],
    });

    const result = await AnnualPrepayRenewals.checkAndSendPaymentReminders({ today: '2026-07-08' });

    expect(result).toEqual({ sent: 0 });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('checkAndSendPaymentReminders targets term_start at today+3 and today+1', async () => {
    const candidateQ3 = query({ rows: [] });
    const candidateQ1 = query({ rows: [] });
    setDbQueues({
      'annual_prepay_terms as t': [query({ rows: [] })],
      annual_prepay_terms: [
        query({ columnInfo: REMINDER_COLS }), // cols (cached after first call)
        candidateQ3,
        candidateQ1,
      ],
    });

    const result = await AnnualPrepayRenewals.checkAndSendPaymentReminders({ today: '2026-07-08' });

    expect(result).toEqual({ sent: 0 });
    expect(candidateQ3.where).toHaveBeenCalledWith('term_start', '2026-07-11');
    expect(candidateQ1.where).toHaveBeenCalledWith('term_start', '2026-07-09');
  });
});

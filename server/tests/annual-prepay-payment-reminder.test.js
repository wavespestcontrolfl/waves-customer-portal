jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
  classifyDeliveryCertainty: jest.requireActual('../services/messaging/send-customer-message').classifyDeliveryCertainty,
}));
jest.mock('../services/billing-reminder-delivery', () => ({
  reminderProgress: jest.fn(),
  sendReminderChannels: jest.fn(),
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
// The reminder now consults the collections rail-guard (gate-on only) and
// records-then-sends through the always-on contact ledger — mocked healthy
// so the delivery-path tests exercise the send.
jest.mock('../services/collections/rail-guard', () => ({
  collectionsChannelPermitted: jest.fn(async () => true),
}));
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(async () => ({ id: 'led-1', metadata: {} })),
  claimAttempt: jest.fn(async () => ({ allowed: true })),
  markSendFailed: jest.fn(async () => true),
  markDelivered: jest.fn(async () => true),
}));
jest.mock('../services/customer-credit', () => ({
  autoApplyAccountCreditIfEnabled: jest.fn().mockResolvedValue(null),
  reverseAppliedCredit: jest.fn().mockResolvedValue(0),
}));

const db = require('../models/db');
const { autoApplyAccountCreditIfEnabled, reverseAppliedCredit } = require('../services/customer-credit');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const { reminderProgress, sendReminderChannels } = require('../services/billing-reminder-delivery');
const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
const { _private } = AnnualPrepayRenewals;

// A fully-migrated schema: annualPrepayColumns caches only a probe that
// carries every termite notice column (Codex #4921 r8), and these tests rely
// on that cache across the per-rung loop.
const TERMITE_NOTICE_COLS = Object.fromEntries([
  'annual_plan_version', 'notice_45_sent_at', 'notice_45_claimed_at', 'notice_45_late_sent_at',
  'notice_45_late_escalated_at', 'notice_30_sent_at', 'notice_30_claimed_at', 'notice_30_late_sent_at',
  'notice_30_late_escalated_at', 'notice_missed_escalated_at',
  'notice_45_undelivered_escalated_at', 'notice_30_undelivered_escalated_at',
  'notice_witness_conflict', 'notice_witness_conflict_belled_at',
].map((c) => [c, {}]));
const REMINDER_COLS = {
  ...TERMITE_NOTICE_COLS,
  payment_reminder_3d_sent_at: {},
  payment_reminder_3d_claimed_at: {},
  payment_reminder_1d_sent_at: {},
  payment_reminder_1d_claimed_at: {},
};

function query({ first, firstError, returning, columnInfo, rows = [] } = {}) {
  const q = {};
  [
    'whereIn',
    'whereNull',
    'whereBetween',
    'whereNotIn',
    'whereNotNull',
    'whereRaw',
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
  q.modify = jest.fn((callback) => { callback(q); return q; });
  q.forUpdate = jest.fn(() => q);
  q.update = jest.fn(() => q);
  q.insert = jest.fn(() => q);
  q.first = jest.fn(async () => { if (firstError) throw firstError; return first; });
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
    if (table === 'notification_prefs' && (!queue || !queue.length)) return query();
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
    reminderProgress.mockResolvedValue([]);
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
    'skips a %s invoice (canonical collectibility — in-flight ACH must not be re-asked) — releases claim, no SMS',
    async (status) => {
      setDbQueues({
        annual_prepay_terms: [query({ columnInfo: REMINDER_COLS }), query({ returning: [{ ...BASE_TERM }] }), query()],
        invoices: [query({ first: { ...UNPAID_INVOICE, status } })],
      });

      const result = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1);

      expect(result).toEqual({ sent: false, reason: 'invoice_not_collectible' });
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    },
  );

  test('skips when already-applied account credit fully covers the balance before the credit seam', async () => {
    setDbQueues({
      annual_prepay_terms: [query({ columnInfo: REMINDER_COLS }), query({ returning: [{ ...BASE_TERM }] }), query()],
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
      annual_prepay_terms: [query({ columnInfo: REMINDER_COLS }), query({ returning: [{ ...BASE_TERM }] }), query()],
      invoices: [query({ first: { ...UNPAID_INVOICE, payer_id: 'payer-9' } })],
    });
    // payer check fires on the first read — before the credit seam re-read.

    const result = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1);

    expect(result).toEqual({ sent: false, reason: 'payer_billed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('defers to the invoice follow-up sequence when dunning touched the customer recently', async () => {
    setDbQueues({
      annual_prepay_terms: [query({ columnInfo: REMINDER_COLS }), query({ returning: [{ ...BASE_TERM }] }), query()],
      invoices: [query({ first: { ...UNPAID_INVOICE } })],
      invoice_followup_sequences: [query({
        first: { status: 'active', last_touch_at: new Date(Date.now() - 60 * 60 * 1000), next_touch_at: null },
      })],
    });

    const result = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 3);

    expect(result).toEqual({ sent: false, reason: 'dunning_active_today' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a recent FINAL dunning touch suppresses even after the sequence flips to completed (shared 10 AM hour)', async () => {
    setDbQueues({
      invoice_followup_sequences: [query({
        first: { status: 'completed', last_touch_at: new Date(Date.now() - 5 * 60 * 1000), next_touch_at: null },
      })],
    });
    await expect(_private.invoiceDunningActiveToday('inv-1', {})).resolves.toBe(true);
  });

  test('paused / autopay-held / stopped sequences suppress (deliberate dunning controls); completed alone does not', async () => {
    for (const status of ['paused', 'autopay_hold', 'stopped']) {
      setDbQueues({
        invoice_followup_sequences: [query({ first: { status, last_touch_at: null, next_touch_at: null } })],
      });
      await expect(_private.invoiceDunningActiveToday('inv-1', {})).resolves.toBe(status === 'completed' ? false : true);
    }
    setDbQueues({
      invoice_followup_sequences: [query({ first: { status: 'completed', last_touch_at: null, next_touch_at: null } })],
    });
    await expect(_private.invoiceDunningActiveToday('inv-1', {})).resolves.toBe(false);
  });

  test('post-delivery bookkeeping failure keeps the credit and still reports sent (never reverse a delivered touch)', async () => {
    autoApplyAccountCreditIfEnabled.mockResolvedValueOnce({ applied: 50 });
    const claimQ = query({ returning: [{ ...BASE_TERM }] });
    const failingStampQ = query();
    failingStampQ.update = jest.fn(() => { throw new Error('db down'); });
    setDbQueues({
      annual_prepay_terms: [
        query({ columnInfo: REMINDER_COLS }),
        claimQ,
        failingStampQ,
      ],
      invoices: [
        query({ first: { ...UNPAID_INVOICE } }),
        query({ first: { ...UNPAID_INVOICE, credit_applied: '50.00' } }),
      ],
      invoice_followup_sequences: [query({ first: undefined })],
      customers: [query({ first: { ...CUSTOMER } })],
    });
    renderSmsTemplate.mockResolvedValue('pay reminder body');
    sendCustomerMessage.mockResolvedValue({ sent: true });

    const result = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1);

    expect(result).toEqual({ sent: true, termId: 'term-1' });
    expect(reverseAppliedCredit).not.toHaveBeenCalled();
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

  test('derives the dunning send day from the supplied clock when todayYmd is omitted', async () => {
    setDbQueues({ invoice_followup_sequences: [query({ first: {
      status: 'active', last_touch_at: null, next_touch_at: new Date('2026-07-08T14:00:00Z'),
    } })] });

    await expect(_private.invoiceDunningActiveToday('inv-1', {
      now: new Date('2026-07-08T16:00:00Z'),
    })).resolves.toBe(true);
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

// gh-r1 (2026-08-14): the reminder is a balance-outreach rail — policy
// consult + record-then-send ledger discipline bind it like the dunning
// engines. Denials and ledger outages release the claim for a later retry.
describe('collections policy + ledger on the payment reminder', () => {
  const { collectionsChannelPermitted } = require('../services/collections/rail-guard');
  const ContactLedger = require('../services/collections/contact-ledger');

  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
    _private.resetCachesForTests();
    collectionsChannelPermitted.mockResolvedValue(true);
    ContactLedger.recordContact.mockResolvedValue({ id: 'led-1', metadata: {} });
  });

  function armThroughSend({ releaseExpected = false } = {}) {
    const claimQ = query({ returning: [{ ...BASE_TERM }] });
    const tailQ = query(); // markSent OR releaseClaim — both update annual_prepay_terms
    setDbQueues({
      annual_prepay_terms: [
        query({ columnInfo: REMINDER_COLS }),
        claimQ,
        tailQ,
      ],
      invoices: [
        query({ first: { ...UNPAID_INVOICE } }),
        query({ first: { ...UNPAID_INVOICE } }),
      ],
      invoice_followup_sequences: [query({ first: undefined })],
      customers: [query({ first: { ...CUSTOMER } })],
      ...(releaseExpected ? {} : { customer_interactions: [query()] }),
    });
    renderSmsTemplate.mockResolvedValue('pay reminder body');
    sendCustomerMessage.mockResolvedValue({ sent: true });
    return { tailQ };
  }

  test('a policy denial releases the claim, reverses the credit, and sends NOTHING', async () => {
    armThroughSend({ releaseExpected: true });
    collectionsChannelPermitted.mockResolvedValueOnce(false);
    const result = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1);
    expect(result).toEqual({ sent: false, reason: 'collections_policy_denied' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();
    // r7: the plan invoice is 'draft' (never in the eligible set) — the
    // consult is aggregate (invoiceId null) with the validated plan amount
    // riding the off-ledger carve-out.
    expect(collectionsChannelPermitted).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1', channel: 'sms', purpose: 'balance_reminder',
      invoiceId: null, offLedgerBalanceCents: 39204,
    }));
  });

  test('an unavailable ledger skips the send and releases the claim (record-then-send)', async () => {
    armThroughSend({ releaseExpected: true });
    ContactLedger.recordContact.mockRejectedValueOnce(new Error('ledger down'));
    const result = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1);
    expect(result).toEqual({ sent: false, reason: 'ledger_unavailable' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('the delivered path records BEFORE the send; a blocked send stamps send_failed', async () => {
    armThroughSend();
    const result = await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1);
    expect(result).toEqual({ sent: true, termId: 'term-1' });
    expect(ContactLedger.recordContact.mock.invocationCallOrder[0])
      .toBeLessThan(sendCustomerMessage.mock.invocationCallOrder[0]);
    expect(ContactLedger.recordContact).toHaveBeenCalledWith(expect.objectContaining({
      source: 'annual_prepay_payment_reminder', invoiceIds: ['inv-1'],
    }));

    jest.clearAllMocks();
    db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
    _private.resetCachesForTests();
    collectionsChannelPermitted.mockResolvedValue(true);
    ContactLedger.recordContact.mockResolvedValue({ id: 'led-1', metadata: {} });
    armThroughSend({ releaseExpected: true });
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, code: 'QUIET_HOURS_HOLD' });
    await AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1);
    expect(ContactLedger.markSendFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'led-1' }),
      expect.objectContaining({ code: 'QUIET_HOURS_HOLD' }),
    );
  });
});

describe('explicit annual payment reminder channels', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
    _private.resetCachesForTests();
    reminderProgress.mockResolvedValue([]);
    renderSmsTemplate.mockResolvedValue('pay reminder body');
    sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted' });
  });

  function arm(channel, creditApplied = 0) {
    setDbQueues({
      annual_prepay_terms: [query({ columnInfo: REMINDER_COLS }),
        query({ returning: [{ ...BASE_TERM }] }), query()],
      invoices: [query({ first: { ...UNPAID_INVOICE } }), query({ first: { ...UNPAID_INVOICE, credit_applied: creditApplied } })],
      invoice_followup_sequences: [query({ first: undefined })],
      customers: [query({ first: { ...CUSTOMER } })],
      notification_prefs: [query({ first: { customer_id: CUSTOMER.id, billing_channels: [channel] } })],
      customer_interactions: [query()],
      collections_contact_ledger: [query()],
    });
    sendReminderChannels.mockImplementation(async (args) => {
      await args.send(channel, { id: `ledger-${channel}` });
      return { complete: true, deliveredNow: [channel], results: {} };
    });
  }

  test.each(['email', 'push', 'sms'])('routes the selected %s leg with a final quote guard', async (channel) => {
    arm(channel);
    await expect(AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1))
      .resolves.toEqual({ sent: true, termId: 'term-1', complete: true });

    expect(sendReminderChannels).toHaveBeenCalledWith(expect.objectContaining({
      invoiceId: null, invoiceIds: ['inv-1'], policyInvoiceIds: [],
      offLedgerBalanceCents: 39204, eventKey: 'annual-prepay-payment:term-1:1',
    }));
    const input = sendCustomerMessage.mock.calls[0][0];
    expect(input.metadata).toMatchObject({
      annual_prepay_term_id: 'term-1', first_visit_date: '2026-07-11', days_out: 1,
      rendered_amount: '392.04', billingDeliveryLeg: channel,
      collections_ledger_id: `ledger-${channel}`,
    });
    if (channel === 'sms') {
      expect(input.preSendCheck).toBeUndefined();
      expect(input.providerPreSendCheck).toEqual(expect.any(Function));
      expect(input.withSmsHandoff).toEqual(expect.any(Function));
    } else {
      expect(input.preSendCheck).toEqual(expect.any(Function));
    }
    if (channel === 'push') expect(input).toMatchObject({ channel: 'sms', metadata: { appOnly: true } });
  });

  test('keeps newly applied credit after a visible App bell when audit and ledger acceptance fail', async () => {
    arm('push', 40);
    autoApplyAccountCreditIfEnabled.mockResolvedValueOnce({ applied: 40 });
    const providerOutcome = { deliveryOutcome: 'not_sent', bellPersisted: true };
    sendCustomerMessage.mockRejectedValueOnce(Object.assign(new Error('canonical audit unavailable'), { providerOutcome }));
    const ContactLedger = require('../services/collections/contact-ledger');
    ContactLedger.markDelivered.mockResolvedValueOnce(false);
    sendReminderChannels.mockImplementation(jest.requireActual('../services/billing-reminder-delivery').sendReminderChannels);
    await expect(AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1))
      .resolves.toEqual({ sent: true, termId: 'term-1', complete: false });
    expect(ContactLedger.markDelivered).toHaveBeenCalledWith(expect.objectContaining({ id: 'led-1' }));
    expect(reverseAppliedCredit).not.toHaveBeenCalled();
  });

  test.each(['returned', 'thrown'])('reverses this run\'s credit for an old deduped App bell (%s)', async (shape) => {
    arm('push', 40);
    autoApplyAccountCreditIfEnabled.mockResolvedValueOnce({ applied: 40 });
    const oldBell = { sent: true, deliveryOutcome: 'accepted', bellPersisted: true,
      deduped: true, eventVisibleAt: '2026-07-01T12:00:00.000Z' };
    if (shape === 'returned') sendCustomerMessage.mockResolvedValueOnce(oldBell);
    else sendCustomerMessage.mockRejectedValueOnce(Object.assign(new Error('old bell'), { providerOutcome: oldBell }));
    sendReminderChannels.mockImplementation(async (args) => {
      await args.send('push', { id: 'ledger-push' });
      return { complete: true, deliveredNow: [], results: { push: oldBell } };
    });
    if (shape === 'returned') {
      await expect(AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1))
        .resolves.toMatchObject({ sent: false, complete: true });
    } else {
      await expect(AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1))
        .rejects.toThrow('old bell');
    }
    expect(reverseAppliedCredit).toHaveBeenCalledWith(expect.objectContaining({ amount: 40 }));
  });

  test('prior delivery does not count as a send on an attempt that reaches no channel', async () => {
    arm('push', 40);
    autoApplyAccountCreditIfEnabled.mockResolvedValueOnce({ applied: 40 });
    reminderProgress.mockResolvedValueOnce([{
      metadata: { notificationEventKey: 'annual-prepay-payment:term-1:1' },
      delivered: new Set(['sms']),
    }]);
    sendReminderChannels.mockResolvedValueOnce({ complete: false, deliveredNow: [], results: {} });

    await expect(AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1))
      .resolves.toEqual({ sent: false, termId: 'term-1', complete: false });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(reverseAppliedCredit).toHaveBeenCalledWith(expect.objectContaining({ amount: 40 }));
  });

  test('an unreadable stored choice retries without falling through to legacy Text', async () => {
    autoApplyAccountCreditIfEnabled.mockResolvedValueOnce({ applied: 40 });
    const release = query();
    setDbQueues({
      annual_prepay_terms: [query({ columnInfo: REMINDER_COLS }),
        query({ returning: [{ ...BASE_TERM }] }), release],
      invoices: [query({ first: { ...UNPAID_INVOICE } }), query({ first: { ...UNPAID_INVOICE } })],
      invoice_followup_sequences: [query({ first: undefined })],
      customers: [query({ first: { ...CUSTOMER } })],
      notification_prefs: [query({ firstError: new Error('preferences unavailable') })],
    });
    await expect(AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 1))
      .resolves.toEqual({ sent: false, reason: 'notification_prefs_unavailable' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(reverseAppliedCredit).toHaveBeenCalledWith(expect.objectContaining({ amount: 40 }));
    expect(release.update).toHaveBeenCalled();
  });
});

describe('durable annual attempt evidence', () => {
  const cols = { ...REMINDER_COLS, first_visit_date: {},
    payment_reminder_3d_attempted_for: {}, payment_reminder_1d_attempted_for: {} };
  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
    _private.resetCachesForTests();
  });

  test.each([
    [3, 'explicit', ['email'], '2026-07-11'], [3, 'legacy', undefined, null],
    [1, 'explicit', ['email'], '2026-07-11'], [1, 'legacy', undefined, null],
  ])(
    '%i-day %s invoice-read failure releases the claim with the correct durable evidence', async (daysOut, _label, channels, marker) => {
      const claim = query({ returning: [{ ...BASE_TERM }] });
      const release = query();
      const invoice = query({ firstError: new Error('invoice unreadable') });
      setDbQueues({ annual_prepay_terms: [query({ columnInfo: cols }), claim, release],
        notification_prefs: [query({ first: { billing_channels: channels } })], invoices: [invoice] });
      await expect(AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, daysOut))
        .rejects.toThrow('invoice unreadable');
      expect(claim.update).toHaveBeenCalledWith(expect.objectContaining({ [`payment_reminder_${daysOut}d_attempted_for`]: marker }));
      expect(claim.update.mock.invocationCallOrder[0]).toBeLessThan(invoice.first.mock.invocationCallOrder[0]);
      expect(claim.whereRaw).toHaveBeenCalledWith('COALESCE(first_visit_date, term_start) = ?', ['2026-07-11']);
      expect(release.update).toHaveBeenCalledWith(expect.objectContaining({ [`payment_reminder_${daysOut}d_claimed_at`]: null }));
    },
  );

  test('unreadable stored choice cannot certify or claim an explicit attempt', async () => {
    const claim = query({ returning: [{ ...BASE_TERM }] });
    setDbQueues({ annual_prepay_terms: [query({ columnInfo: cols }), claim],
      notification_prefs: [query({ firstError: new Error('choice unreadable') })] });
    await expect(AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 3))
      .resolves.toEqual({ sent: false, reason: 'notification_prefs_unavailable' });
    expect(claim.update).not.toHaveBeenCalled();
  });

  test.each([
    ['legacy to explicit', null, ['email'], null],
    ['empty choice to explicit', [], ['email'], null],
    ['explicit to legacy', ['email'], null, '2026-07-11'],
  ])('holds %s preference change after claim without sending an unmarked or legacy leg', async (_label, before, after, marker) => {
    const claim = query({ returning: [{ ...BASE_TERM }] });
    const release = query();
    setDbQueues({ annual_prepay_terms: [query({ columnInfo: cols }), claim, release],
      notification_prefs: [query({ first: { billing_channels: before } }),
        query({ first: { billing_channels: after } })],
      invoices: [query({ first: { ...UNPAID_INVOICE } }), query({ first: { ...UNPAID_INVOICE } })],
      invoice_followup_sequences: [query({ first: undefined })],
      customers: [query({ first: { ...CUSTOMER } })],
    });
    await expect(AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 3))
      .resolves.toEqual({ sent: false, reason: 'notification_prefs_changed' });
    expect(claim.update).toHaveBeenCalledWith(expect.objectContaining({ payment_reminder_3d_attempted_for: marker }));
    expect(release.update).toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('clearing the explicit choice after a resumed claim cannot fall through to Text', async () => {
    reminderProgress.mockResolvedValue([]);
    setDbQueues({ annual_prepay_terms: [query({ columnInfo: cols }),
      query({ returning: [{ ...BASE_TERM }] }), query()],
      notification_prefs: [query({ first: { billing_channels: ['email'] } }), query()],
      invoices: [query({ first: { ...UNPAID_INVOICE } }), query({ first: { ...UNPAID_INVOICE } })],
      invoice_followup_sequences: [query()], customers: [query({ first: { ...CUSTOMER } })] });
    await expect(AnnualPrepayRenewals.sendPaymentPendingReminder({ ...BASE_TERM }, 3, { resume: true }))
      .resolves.toEqual({ sent: false, reason: 'notification_prefs_changed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(sendReminderChannels).not.toHaveBeenCalled();
  });

  test.each(['scan', 'choice'])('a failed resume %s still runs the normal 1-day reminder', async (failure) => {
    const resume = query({ rows: [{ ...BASE_TERM }] });
    if (failure === 'scan') resume.select.mockImplementation(() => Promise.reject(new Error('resume unreadable')));
    setDbQueues({ 'annual_prepay_terms as t': [query()], annual_prepay_terms: [query({ columnInfo: cols }),
      query(), resume, query({ rows: [{ ...BASE_TERM }] }),
      query({ returning: [{ ...BASE_TERM }] }), query()],
      ...(failure === 'choice' ? { notification_prefs: [query({ firstError: new Error('choice unreadable') })] } : {}),
      invoices: [query({ first: { ...UNPAID_INVOICE } }), query({ first: { ...UNPAID_INVOICE } })],
      invoice_followup_sequences: [query()], customers: [query({ first: { ...CUSTOMER } })], customer_interactions: [query()] });
    renderSmsTemplate.mockResolvedValue('pay reminder body');
    sendCustomerMessage.mockResolvedValue({ sent: true });
    await expect(AnnualPrepayRenewals.checkAndSendPaymentReminders({ today: '2026-07-08' })).resolves.toEqual({ sent: 1 });
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ days_out: 1 }) }));
  });
});

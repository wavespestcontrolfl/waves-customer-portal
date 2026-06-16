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

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const AccountMembershipEmail = require('../services/account-membership-email');
const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
const { _private } = AnnualPrepayRenewals;

function query({ first, returning, columnInfo, rows = [] } = {}) {
  const q = {};
  [
    'whereIn',
    'whereNull',
    'whereBetween',
    'whereNotIn',
    'orderBy',
    'select',
  ].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.where = jest.fn((arg) => {
    if (typeof arg === 'function') arg.call(q);
    return q;
  });
  q.orWhere = jest.fn(() => q);
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

describe('annual prepay renewal helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
    _private.resetCachesForTests();
  });

  test('keeps PostgreSQL DATE objects on their calendar day', () => {
    expect(_private.dateOnly(new Date('2026-05-14T00:00:00.000Z'))).toBe('2026-05-14');
  });

  test('adds calendar months while preserving valid end-of-month dates', () => {
    expect(_private.addMonthsSameDay('2024-01-31', 1)).toBe('2024-02-29');
    expect(_private.addMonthsSameDay('2025-01-31', 1)).toBe('2025-02-28');
    expect(_private.addMonthsSameDay('2026-05-14', 12)).toBe('2027-05-14');
  });

  test('normalizes annual prepay cadences to their month spacing', () => {
    expect(_private.normalizeCoverageCadence('Bi-Monthly')).toBe('bimonthly');
    expect(_private.normalizeCoverageCadence('Semi-Annual')).toBe('semiannual');
    expect(_private.normalizeCoverageCadence('Quarterly')).toBe('quarterly');
    expect(_private.normalizeCoverageCadence('Every 6 Weeks')).toBe('every_6_weeks');
    expect(_private.coverageCadenceMonths('monthly')).toBe(1);
    expect(_private.coverageCadenceMonths('bimonthly')).toBe(2);
    expect(_private.coverageCadenceMonths('quarterly')).toBe(3);
    expect(_private.coverageCadenceMonths('triannual')).toBe(4);
    expect(_private.coverageCadenceMonths('semiannual')).toBe(6);
    expect(_private.coverageCadenceDays('every_6_weeks')).toBe(42);
  });

  test('maps supported customer notice offsets to term columns', () => {
    expect(_private.noticeColumnForDaysOut(30)).toBe('notice_30_sent_at');
    expect(_private.noticeColumnForDaysOut('15')).toBe('notice_15_sent_at');
    expect(_private.noticeColumnForDaysOut(7)).toBe('notice_7_sent_at');
    expect(_private.noticeColumnForDaysOut(10)).toBeNull();
    expect(_private.noticeClaimColumnForDaysOut(30)).toBe('notice_30_claimed_at');
    expect(_private.noticeClaimColumnForDaysOut(15)).toBe('notice_15_claimed_at');
    expect(_private.noticeClaimColumnForDaysOut(10)).toBeNull();
  });

  test('keeps draft prepay invoices payment pending until collected', () => {
    expect(_private.invoiceTermStatus({ status: 'draft', paid_at: null })).toBe('payment_pending');
    expect(_private.invoiceTermStatus({ status: 'sent', paid_at: null })).toBe('payment_pending');
    expect(_private.invoiceTermStatus({ status: 'paid', paid_at: null })).toBe('active');
    expect(_private.invoiceTermStatus({ status: 'viewed', paid_at: new Date('2026-05-14T12:00:00Z') })).toBe('active');
    expect(_private.invoiceTermStatus({ status: 'void', paid_at: null })).toBe('cancelled');
    expect(_private.invoiceTermStatus({ status: 'refunded', paid_at: new Date('2026-05-14T12:00:00Z') })).toBe('cancelled');
  });

  test('matches annual prepay coverage labels to scheduled pest service labels', () => {
    expect(_private.serviceMatchesCoverage(
      { service_type: 'Pest Control' },
      'Quarterly Pest Control',
    )).toBe(true);
    expect(_private.serviceMatchesCoverage(
      { service_type: 'Monthly Lawn Care' },
      'Every 6 Weeks Lawn Care',
    )).toBe(true);
    expect(_private.serviceMatchesCoverage(
      { service_type: 'Quarterly Pest Barrier' },
      'Pest Control',
    )).toBe(false);
    expect(_private.splitCoverageAmount(100, 3)).toEqual([33.33, 33.33, 33.34]);
  });

  test('stamps matching future covered visits prepaid when an annual prepay term activates', async () => {
    const rows = [
      { id: 'svc-1', customer_id: 'customer-1', scheduled_date: '2026-06-20', service_type: 'Pest Control', status: 'pending' },
      { id: 'svc-2', customer_id: 'customer-1', scheduled_date: '2026-09-20', service_type: 'Quarterly Pest Control', status: 'confirmed' },
      { id: 'svc-3', customer_id: 'customer-1', scheduled_date: '2026-12-20', service_type: 'Lawn Care', status: 'pending' },
      { id: 'svc-4', customer_id: 'customer-1', scheduled_date: '2027-03-20', service_type: 'Pest Control', status: 'completed' },
      { id: 'svc-5', customer_id: 'customer-1', scheduled_date: '2027-05-20', service_type: 'Pest Control', status: 'pending' },
    ];
    const columnQuery = query({
      columnInfo: {
        prepaid_amount: {},
        prepaid_method: {},
        prepaid_at: {},
        annual_prepay_term_id: {},
        updated_at: {},
      },
    });
    const rowsQuery = query({ rows });
    const updateOne = query({ returning: [{ id: 'svc-1' }] });
    const updateTwo = query({ returning: [{ id: 'svc-2' }] });
    const updateThree = query({ returning: [{ id: 'svc-5' }] });
    setDbQueues({
      scheduled_services: [
        columnQuery,
        rowsQuery,
        updateOne,
        updateTwo,
        updateThree,
      ],
    });

    await expect(AnnualPrepayRenewals.applyPrepaidCoverageForTerm({
      id: 'term-1',
      customer_id: 'customer-1',
      prepay_amount: 999.99,
      term_start: '2026-06-15',
      term_end: '2027-06-15',
      coverage_service_type: 'Quarterly Pest Control',
      coverage_visit_count: 4,
    })).resolves.toMatchObject({
      stampedCount: 3,
      matchedCount: 4,
      expectedVisitCount: 4,
      perVisitAmount: 249.99,
    });

    expect(rowsQuery.where).toHaveBeenCalledWith({ customer_id: 'customer-1' });
    expect(rowsQuery.whereBetween).toHaveBeenCalledWith('scheduled_date', ['2026-06-15', '2027-06-15']);
    expect(updateOne.update).toHaveBeenCalledWith(expect.objectContaining({
      prepaid_amount: 249.99,
      prepaid_method: 'annual_prepay_invoice',
      annual_prepay_term_id: 'term-1',
    }));
    expect(updateTwo.update).toHaveBeenCalledWith(expect.objectContaining({
      prepaid_amount: 249.99,
      prepaid_method: 'annual_prepay_invoice',
      annual_prepay_term_id: 'term-1',
    }));
    expect(updateThree.update).toHaveBeenCalledWith(expect.objectContaining({
      prepaid_amount: 250.02,
      prepaid_method: 'annual_prepay_invoice',
      annual_prepay_term_id: 'term-1',
    }));
  });

  test('creates the quarterly coverage series when no matching visits already exist', async () => {
    const columnQuery = query({
      columnInfo: {
        scheduled_date: {},
        service_type: {},
        annual_prepay_term_id: {},
        is_recurring: {},
        recurring_pattern: {},
        recurring_parent_id: {},
        recurring_ongoing: {},
        technician_id: {},
        window_start: {},
        window_end: {},
        time_window: {},
        customer_notes: {},
        zone: {},
        notes: {},
        estimated_duration_minutes: {},
      },
    });
    const rowsQuery = query({ rows: [] });
    const parentInsert = query({ returning: [{ id: 'svc-1', scheduled_date: '2026-06-15' }] });
    const childInsert1 = query({ returning: [{ id: 'svc-2', scheduled_date: '2026-09-15' }] });
    const childInsert2 = query({ returning: [{ id: 'svc-3', scheduled_date: '2026-12-15' }] });
    const childInsert3 = query({ returning: [{ id: 'svc-4', scheduled_date: '2027-03-15' }] });
    setDbQueues({
      scheduled_services: [
        columnQuery,
        rowsQuery,
        parentInsert,
        childInsert1,
        childInsert2,
        childInsert3,
      ],
    });

    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-1',
      customer_id: 'customer-1',
      term_start: '2026-06-15',
      term_end: '2027-06-15',
      coverage_service_type: 'Quarterly Pest Control',
      coverage_visit_count: 4,
    })).resolves.toMatchObject({
      createdCount: 4,
      targetDates: ['2026-06-15', '2026-09-15', '2026-12-15', '2027-03-15'],
      existingCount: 0,
    });

    expect(parentInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
      customer_id: 'customer-1',
      scheduled_date: '2026-06-15',
      service_type: 'Quarterly Pest Control',
      status: 'pending',
      annual_prepay_term_id: 'term-1',
      is_recurring: true,
      recurring_pattern: 'quarterly',
      recurring_ongoing: false,
      estimated_duration_minutes: 45,
    }));
    expect(childInsert1.insert).toHaveBeenCalledWith(expect.objectContaining({
      scheduled_date: '2026-09-15',
      recurring_parent_id: 'svc-1',
      annual_prepay_term_id: 'term-1',
    }));
    expect(childInsert2.insert).toHaveBeenCalledWith(expect.objectContaining({
      scheduled_date: '2026-12-15',
      recurring_parent_id: 'svc-1',
      annual_prepay_term_id: 'term-1',
    }));
    expect(childInsert3.insert).toHaveBeenCalledWith(expect.objectContaining({
      scheduled_date: '2027-03-15',
      recurring_parent_id: 'svc-1',
      annual_prepay_term_id: 'term-1',
    }));
  });

  test('creates the monthly coverage series when cadence is monthly', async () => {
    const columnQuery = query({
      columnInfo: {
        scheduled_date: {},
        service_type: {},
        annual_prepay_term_id: {},
        is_recurring: {},
        recurring_pattern: {},
        recurring_parent_id: {},
        recurring_ongoing: {},
        technician_id: {},
        window_start: {},
        window_end: {},
        time_window: {},
        customer_notes: {},
        zone: {},
        notes: {},
        estimated_duration_minutes: {},
      },
    });
    const rowsQuery = query({ rows: [] });
    const parentInsert = query({ returning: [{ id: 'svc-10', scheduled_date: '2026-06-15' }] });
    const childInsert1 = query({ returning: [{ id: 'svc-11', scheduled_date: '2026-07-15' }] });
    const childInsert2 = query({ returning: [{ id: 'svc-12', scheduled_date: '2026-08-15' }] });
    setDbQueues({
      scheduled_services: [
        columnQuery,
        rowsQuery,
        parentInsert,
        childInsert1,
        childInsert2,
      ],
    });

    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-2',
      customer_id: 'customer-2',
      term_start: '2026-06-15',
      term_end: '2026-12-15',
      coverage_service_type: 'Monthly Lawn Care',
      coverage_visit_count: 3,
      coverage_cadence: 'monthly',
    })).resolves.toMatchObject({
      createdCount: 3,
      targetDates: ['2026-06-15', '2026-07-15', '2026-08-15'],
      existingCount: 0,
    });

    expect(parentInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
      service_type: 'Monthly Lawn Care',
      recurring_pattern: 'monthly',
      estimated_duration_minutes: 30,
    }));
    expect(childInsert1.insert).toHaveBeenCalledWith(expect.objectContaining({
      scheduled_date: '2026-07-15',
      recurring_parent_id: 'svc-10',
    }));
    expect(childInsert2.insert).toHaveBeenCalledWith(expect.objectContaining({
      scheduled_date: '2026-08-15',
      recurring_parent_id: 'svc-10',
    }));
  });

  test('creates the six-week coverage series when cadence is every_6_weeks', async () => {
    const columnQuery = query({
      columnInfo: {
        scheduled_date: {},
        service_type: {},
        annual_prepay_term_id: {},
        is_recurring: {},
        recurring_pattern: {},
        recurring_interval_days: {},
        recurring_parent_id: {},
        recurring_ongoing: {},
        technician_id: {},
        window_start: {},
        window_end: {},
        time_window: {},
        customer_notes: {},
        zone: {},
        notes: {},
        estimated_duration_minutes: {},
      },
    });
    const rowsQuery = query({ rows: [] });
    const parentInsert = query({ returning: [{ id: 'svc-20', scheduled_date: '2026-06-15' }] });
    const childInsert1 = query({ returning: [{ id: 'svc-21', scheduled_date: '2026-07-27' }] });
    const childInsert2 = query({ returning: [{ id: 'svc-22', scheduled_date: '2026-09-07' }] });
    setDbQueues({
      scheduled_services: [
        columnQuery,
        rowsQuery,
        parentInsert,
        childInsert1,
        childInsert2,
      ],
    });

    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-3',
      customer_id: 'customer-3',
      term_start: '2026-06-15',
      term_end: '2026-12-15',
      coverage_service_type: 'Monthly Lawn Care',
      coverage_visit_count: 3,
      coverage_cadence: 'every_6_weeks',
    })).resolves.toMatchObject({
      createdCount: 3,
      targetDates: ['2026-06-15', '2026-07-27', '2026-09-07'],
      existingCount: 0,
    });

    expect(parentInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
      service_type: 'Monthly Lawn Care',
      recurring_pattern: 'custom',
      recurring_interval_days: 42,
      estimated_duration_minutes: 30,
    }));
    expect(childInsert1.insert).toHaveBeenCalledWith(expect.objectContaining({
      scheduled_date: '2026-07-27',
      recurring_parent_id: 'svc-20',
    }));
    expect(childInsert2.insert).toHaveBeenCalledWith(expect.objectContaining({
      scheduled_date: '2026-09-07',
      recurring_parent_id: 'svc-20',
    }));
  });

  test('calculates whole-day distances from date-only strings', () => {
    expect(_private.daysUntil('2026-05-14', '2026-05-14')).toBe(0);
    expect(_private.daysUntil('2026-05-14', '2026-06-13')).toBe(30);
    expect(_private.daysUntil('2026-05-14', '2026-05-07')).toBe(-7);
  });

  test('alerts when either term end or final scheduled service is inside the renewal window', () => {
    expect(_private.shouldAlertTerm({
      term_end: '2026-06-13',
      last_scheduled_service_date: null,
    }, '2026-05-14', 30)).toBe(true);

    expect(_private.shouldAlertTerm({
      term_end: '2026-08-15',
      last_scheduled_service_date: '2026-06-01',
    }, '2026-05-14', 30)).toBe(true);
  });

  test('does not treat an early-term scheduled service as the final-service renewal trigger', () => {
    expect(_private.shouldAlertTerm({
      term_end: '2027-05-14',
      last_scheduled_service_date: '2026-06-01',
    }, '2026-05-14', 30)).toBe(false);
  });

  test('does not alert once the last service is beyond the grace window and term end is far away', () => {
    expect(_private.shouldAlertTerm({
      term_end: '2026-12-31',
      last_scheduled_service_date: '2026-04-29',
    }, '2026-05-14', 30)).toBe(false);
  });

  test('finds refunded invoice from payment metadata aliases before querying invoices', async () => {
    const conn = jest.fn();
    await expect(_private.findInvoiceIdForRefundedPayment({
      metadata: JSON.stringify({ invoice_id: 'invoice-meta' }),
    }, conn)).resolves.toBe('invoice-meta');
    await expect(_private.findInvoiceIdForRefundedPayment({
      metadata: { waves_invoice_id: 'invoice-waves' },
    }, conn)).resolves.toBe('invoice-waves');
    expect(conn).not.toHaveBeenCalled();
  });

  test('falls back to invoice lookup by Stripe charge when payment metadata is missing', async () => {
    const lookups = [];
    const conn = jest.fn(() => ({
      where(criteria) {
        lookups.push(criteria);
        return {
          first: jest.fn().mockResolvedValue(criteria.stripe_charge_id === 'ch_123' ? { id: 'invoice-charge' } : null),
        };
      },
    }));

    await expect(_private.findInvoiceIdForRefundedPayment({
      stripe_payment_intent_id: 'pi_missing',
      stripe_charge_id: 'ch_123',
    }, conn)).resolves.toBe('invoice-charge');
    expect(lookups).toEqual([
      { stripe_payment_intent_id: 'pi_missing' },
      { stripe_charge_id: 'ch_123' },
    ]);
  });

  test('renewal decisions claim only open undecided terms', async () => {
    db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
    const chain = {
      where: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ id: 'term-1', status: 'cancelled', renewal_decision: 'cancel' }]),
    };
    db.mockReturnValue(chain);

    await expect(AnnualPrepayRenewals.recordDecision({
      termId: 'term-1',
      action: 'cancel',
      adminUserId: 'admin-1',
    })).resolves.toEqual(expect.objectContaining({ id: 'term-1' }));

    expect(chain.where).toHaveBeenCalledWith({ id: 'term-1' });
    expect(chain.whereIn).toHaveBeenCalledWith('status', ['active', 'renewal_pending']);
    expect(chain.whereNull).toHaveBeenCalledWith('renewal_decision');
  });

  test('sends renewal email when SMS cannot be delivered because the customer has no phone', async () => {
    const term = {
      id: 'term-1',
      customer_id: 'customer-1',
      status: 'active',
      term_start: '2026-05-20',
      term_end: '2027-05-20',
      notice_30_sent_at: null,
      notice_30_claimed_at: null,
      renewal_decision: null,
    };
    const refreshedTerm = {
      ...term,
      status: 'active',
      last_scheduled_service_id: null,
      last_scheduled_service_date: null,
    };
    const claimQuery = query({ returning: [{ ...refreshedTerm, status: 'renewal_pending' }] });
    const markNoticeQuery = query();
    setDbQueues({
      scheduled_services: [
        query({ first: null }),
        query({ columnInfo: {} }),
      ],
      annual_prepay_terms: [
        query({ returning: [refreshedTerm] }),
        claimQuery,
        markNoticeQuery,
      ],
      customers: [
        query({ first: { id: 'customer-1', email: 'stan@example.com', phone: null } }),
      ],
    });
    AccountMembershipEmail.sendMembershipRenewalReminder.mockResolvedValue({ ok: true });

    await expect(AnnualPrepayRenewals.sendCustomerTermNotice(term, 30)).resolves.toMatchObject({
      sent: true,
      termId: 'term-1',
      channel: 'email',
      sms: false,
    });

    expect(renderSmsTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(AccountMembershipEmail.sendMembershipRenewalReminder).toHaveBeenCalledWith({
      customerId: 'customer-1',
      renewalDate: '2027-05-20',
      daysOut: 30,
      termId: 'term-1',
      lastServiceDate: null,
    });
    expect(markNoticeQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      notice_30_sent_at: expect.any(Date),
      notice_30_claimed_at: null,
    }));
  });
});

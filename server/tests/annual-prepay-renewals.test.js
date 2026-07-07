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
// Lazy-required by reconcilePendingWindowCompletions (and the cancel-path
// invoice reopen) — mocked so the unit tests don't pull real invoice/credit
// machinery.
jest.mock('../services/invoice', () => ({
  settleInvoiceAsAnnualPrepayCovered: jest.fn(),
  reopenAnnualPrepayCoveredInvoicesForTerm: jest.fn(),
}));
jest.mock('../services/customer-credit', () => ({
  postCreditMovement: jest.fn(),
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
    'forUpdate',
    'leftJoin',
    'whereRaw',
  ].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.modify = jest.fn((fn) => { if (typeof fn === 'function') fn(q); return q; });
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

  test('caps coverage service labels to the scheduled_services.service_type width (100)', () => {
    const longLabel = `${'A'.repeat(150)} Pest Control`;
    const normalized = _private.normalizeCoverageServiceType(longLabel);
    expect(normalized).toHaveLength(100);
    expect(_private.normalizeCoverageServiceType('Quarterly Pest Control')).toBe('Quarterly Pest Control');
    expect(_private.normalizeCoverageServiceType('   ')).toBeNull();
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

  test('keeps an already-stamped visit in the slice when a new earlier visit appears', async () => {
    // Term sold 1 visit; the Aug visit is already stamped/linked to this term.
    // A new earlier (Jul) matching visit is added. Plain date-order slicing would
    // pick the Jul visit and orphan the Aug stamp (leaving 2 visits prepaid for a
    // 1-visit term); the selection must keep the committed Aug visit instead.
    const rows = [
      { id: 'svc-new', customer_id: 'c1', scheduled_date: '2026-07-01', service_type: 'Quarterly Pest Control', status: 'pending', prepaid_amount: null, prepaid_method: null, annual_prepay_term_id: null },
      { id: 'svc-stamped', customer_id: 'c1', scheduled_date: '2026-08-01', service_type: 'Quarterly Pest Control', status: 'pending', prepaid_amount: 100, prepaid_method: 'annual_prepay_invoice', annual_prepay_term_id: 'term-1' },
    ];
    setDbQueues({ scheduled_services: [query({ rows })] });

    const selected = await _private.coverageRowsForTerm({
      id: 'term-1',
      customer_id: 'c1',
      coverage_service_type: 'Quarterly Pest Control',
      coverage_visit_count: 1,
      term_start: '2026-06-15',
      term_end: '2027-06-15',
    });

    expect(selected.map((r) => r.id)).toEqual(['svc-stamped']);
  });

  test('does not overwrite a manual cash/Zelle prepaid stamp when activating coverage', async () => {
    const rows = [
      // Independently prepaid (cash) and already linked to this term by
      // attachScheduledServices — its real out-of-band payment must survive.
      { id: 'svc-1', customer_id: 'customer-1', scheduled_date: '2026-06-20', service_type: 'Quarterly Pest Control', status: 'pending', prepaid_amount: 75, prepaid_method: 'cash', annual_prepay_term_id: 'term-1' },
      { id: 'svc-2', customer_id: 'customer-1', scheduled_date: '2026-09-20', service_type: 'Quarterly Pest Control', status: 'pending' },
    ];
    const columnQuery = query({
      columnInfo: {
        prepaid_amount: {}, prepaid_method: {}, prepaid_at: {}, annual_prepay_term_id: {}, updated_at: {},
      },
    });
    const rowsQuery = query({ rows });
    const updateTwo = query({ returning: [{ id: 'svc-2' }] });
    // Only svc-2 should be stamped; if the guard failed and svc-1 were restamped,
    // the second update would hit an empty queue and throw.
    setDbQueues({ scheduled_services: [columnQuery, rowsQuery, updateTwo] });

    const result = await AnnualPrepayRenewals.applyPrepaidCoverageForTerm({
      id: 'term-1',
      customer_id: 'customer-1',
      prepay_amount: 400,
      term_start: '2026-06-15',
      term_end: '2027-06-15',
      coverage_service_type: 'Quarterly Pest Control',
      coverage_visit_count: 2,
    });

    expect(result.stampedCount).toBe(1);
    expect(updateTwo.update).toHaveBeenCalledWith(expect.objectContaining({
      prepaid_method: 'annual_prepay_invoice',
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
      estimated_duration_minutes: 60,
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

  test('clears prepaid stamps on non-completed visits when a void/refund cancels a term', async () => {
    const columnQuery = query({
      columnInfo: {
        status: {},
        prepaid_amount: {},
        prepaid_method: {},
        prepaid_at: {},
        prepaid_note: {},
        annual_prepay_term_id: {},
        updated_at: {},
      },
    });
    const updateQuery = query({ rows: 2 });
    setDbQueues({ scheduled_services: [columnQuery, updateQuery] });

    await AnnualPrepayRenewals.clearPrepaidStampsForTerm('term-1', db);

    // Only the cancelled term's still-open visits are cleared; completed/terminal
    // visits are excluded so already-serviced work isn't re-billed.
    expect(updateQuery.where).toHaveBeenCalledWith({ annual_prepay_term_id: 'term-1' });
    expect(updateQuery.whereNotIn).toHaveBeenCalledWith('status', expect.arrayContaining(['completed']));
    // Only annual-prepay stamps are cleared; an independent cash/Zelle prepay stamp survives.
    expect(updateQuery.where).toHaveBeenCalledWith('prepaid_method', 'annual_prepay_invoice');
    expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      prepaid_amount: null,
      prepaid_method: null,
      prepaid_at: null,
      prepaid_note: null,
    }));
  });

  test('seeds annual-prepay visits with a pre-tax billable price + invoice-on-complete', async () => {
    const columnQuery = query({
      columnInfo: {
        scheduled_date: {},
        service_type: {},
        annual_prepay_term_id: {},
        estimated_price: {},
        create_invoice_on_complete: {},
      },
    });
    const rowsQuery = query({ rows: [] });
    const invoiceQuery = query({ first: { subtotal: 400, total: 428 } });
    const insert1 = query({ returning: [{ id: 'svc-1', scheduled_date: '2026-06-15' }] });
    const insert2 = query({ returning: [{ id: 'svc-2', scheduled_date: '2026-09-15' }] });
    const insert3 = query({ returning: [{ id: 'svc-3', scheduled_date: '2026-12-15' }] });
    const insert4 = query({ returning: [{ id: 'svc-4', scheduled_date: '2027-03-15' }] });
    setDbQueues({
      scheduled_services: [columnQuery, rowsQuery, insert1, insert2, insert3, insert4],
      invoices: [invoiceQuery],
    });

    await _private.ensureCoverageRowsForTerm({
      id: 'term-1',
      customer_id: 'customer-1',
      prepay_invoice_id: 'inv-1',
      term_start: '2026-06-15',
      term_end: '2027-06-15',
      coverage_service_type: 'Quarterly Pest Control',
      coverage_visit_count: 4,
    });

    // 400 pre-tax subtotal / 4 visits = 100 per visit; flagged to bill only if
    // coverage is later voided (the prepaid stamp suppresses it while intact).
    expect(invoiceQuery.first).toHaveBeenCalled();
    expect(insert1.insert).toHaveBeenCalledWith(expect.objectContaining({
      estimated_price: 100,
      create_invoice_on_complete: true,
    }));
  });

  test('reuses existing off-cadence visits instead of seeding a duplicate series', async () => {
    const columnQuery = query({
      columnInfo: {
        scheduled_date: {},
        service_type: {},
        annual_prepay_term_id: {},
        is_recurring: {},
        recurring_pattern: {},
        recurring_parent_id: {},
        recurring_ongoing: {},
        estimated_duration_minutes: {},
        notes: {},
      },
    });
    // Existing quarterly route lands on the 15th of Jul/Oct; the generated
    // targets are Jun/Sep/Dec 15 + Mar 15. Jul-15 and Oct-15 sit within half a
    // quarter of the Jun-15/Sep-15 targets, so only the two genuinely uncovered
    // slots (Dec-15, Mar-15) seed — no second series stacked on the existing one.
    const rowsQuery = query({
      rows: [
        { id: 'svc-a', customer_id: 'customer-9', scheduled_date: '2026-07-15', service_type: 'Pest Control', status: 'pending' },
        { id: 'svc-b', customer_id: 'customer-9', scheduled_date: '2026-10-15', service_type: 'Pest Control', status: 'pending' },
      ],
    });
    const insert1 = query({ returning: [{ id: 'svc-c', scheduled_date: '2026-12-15' }] });
    const insert2 = query({ returning: [{ id: 'svc-d', scheduled_date: '2027-03-15' }] });
    setDbQueues({
      scheduled_services: [columnQuery, rowsQuery, insert1, insert2],
    });

    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-9',
      customer_id: 'customer-9',
      term_start: '2026-06-15',
      term_end: '2027-06-15',
      coverage_service_type: 'Quarterly Pest Control',
      coverage_visit_count: 4,
    })).resolves.toMatchObject({
      createdCount: 2,
      existingCount: 2,
    });

    expect(insert1.insert).toHaveBeenCalledWith(expect.objectContaining({ scheduled_date: '2026-12-15' }));
    expect(insert2.insert).toHaveBeenCalledWith(expect.objectContaining({ scheduled_date: '2027-03-15' }));
  });

  test('does not let a cancelled in-window visit consume a sold coverage slot', async () => {
    const columnQuery = query({
      columnInfo: {
        scheduled_date: {},
        service_type: {},
        annual_prepay_term_id: {},
        is_recurring: {},
        recurring_pattern: {},
        recurring_parent_id: {},
        recurring_ongoing: {},
        estimated_duration_minutes: {},
        notes: {},
      },
    });
    // A cancelled Pest Control visit sits in-window. It can't be stamped prepaid
    // downstream, so it must not reduce the seeded count or suppress a same-slot
    // replacement — all four sold visits still seed.
    const rowsQuery = query({
      rows: [
        { id: 'svc-x', customer_id: 'customer-7', scheduled_date: '2026-07-15', service_type: 'Pest Control', status: 'cancelled' },
      ],
    });
    const i1 = query({ returning: [{ id: 's1', scheduled_date: '2026-06-15' }] });
    const i2 = query({ returning: [{ id: 's2', scheduled_date: '2026-09-15' }] });
    const i3 = query({ returning: [{ id: 's3', scheduled_date: '2026-12-15' }] });
    const i4 = query({ returning: [{ id: 's4', scheduled_date: '2027-03-15' }] });
    setDbQueues({
      scheduled_services: [columnQuery, rowsQuery, i1, i2, i3, i4],
    });

    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-7',
      customer_id: 'customer-7',
      term_start: '2026-06-15',
      term_end: '2027-06-15',
      coverage_service_type: 'Quarterly Pest Control',
      coverage_visit_count: 4,
    })).resolves.toMatchObject({
      createdCount: 4,
      existingCount: 0,
    });
  });

  test('matches an existing visit to a single coverage slot, not both neighbors', async () => {
    const columnQuery = query({
      columnInfo: {
        scheduled_date: {},
        service_type: {},
        annual_prepay_term_id: {},
        is_recurring: {},
        recurring_pattern: {},
        recurring_parent_id: {},
        recurring_ongoing: {},
        estimated_duration_minutes: {},
        notes: {},
      },
    });
    // One existing visit on Feb 15 sits within the 45-day quarterly tolerance of
    // BOTH the Jan 1 and Apr 1 targets. It must fill only one slot, so a 4-visit
    // term still seeds the remaining three (Apr 1 / Jul 1 / Oct 1) rather than
    // letting the single visit cover two slots and short the paid coverage.
    const rowsQuery = query({
      rows: [
        { id: 'svc-m', customer_id: 'customer-5', scheduled_date: '2026-02-15', service_type: 'Pest Control', status: 'pending' },
      ],
    });
    const i1 = query({ returning: [{ id: 's1', scheduled_date: '2026-04-01' }] });
    const i2 = query({ returning: [{ id: 's2', scheduled_date: '2026-07-01' }] });
    const i3 = query({ returning: [{ id: 's3', scheduled_date: '2026-10-01' }] });
    setDbQueues({
      scheduled_services: [columnQuery, rowsQuery, i1, i2, i3],
    });

    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-5',
      customer_id: 'customer-5',
      term_start: '2026-01-01',
      term_end: '2026-12-31',
      coverage_service_type: 'Quarterly Pest Control',
      coverage_visit_count: 4,
    })).resolves.toMatchObject({
      createdCount: 3,
      existingCount: 1,
    });

    expect(i1.insert).toHaveBeenCalledWith(expect.objectContaining({ scheduled_date: '2026-04-01' }));
    expect(i3.insert).toHaveBeenCalledWith(expect.objectContaining({ scheduled_date: '2026-10-01' }));
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
      estimated_duration_minutes: 60,
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
      estimated_duration_minutes: 60,
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

  test('bounds generated coverage dates to the selected term window', () => {
    expect(_private.coverageScheduleDates(
      '2026-01-15',
      12,
      'monthly',
      '2026-06-15',
    )).toEqual([
      '2026-01-15',
      '2026-02-15',
      '2026-03-15',
      '2026-04-15',
      '2026-05-15',
      '2026-06-15',
    ]);

    expect(_private.coverageScheduleDates(
      '2026-01-01',
      9,
      'every_6_weeks',
      '2026-04-15',
    )).toEqual([
      '2026-01-01',
      '2026-02-12',
      '2026-03-26',
    ]);
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

describe('reconcilePendingWindowCompletions (pending-window double-bill guard)', () => {
  const InvoiceService = require('../services/invoice');
  const { postCreditMovement } = require('../services/customer-credit');

  const TERM = {
    id: 'term-1',
    customer_id: 'customer-1',
    prepay_amount: 400,
    term_start: '2026-06-15',
    term_end: '2027-06-15',
    coverage_service_type: 'Quarterly Pest Control',
    coverage_visit_count: 4,
  };
  const completedRow = (over = {}) => ({
    id: 'svc-done',
    customer_id: 'customer-1',
    scheduled_date: '2026-06-20',
    service_type: 'Quarterly Pest Control',
    status: 'completed',
    prepaid_amount: null,
    prepaid_method: null,
    annual_prepay_term_id: null,
    ...over,
  });
  const pendingRow = (id, date) => ({
    id, customer_id: 'customer-1', scheduled_date: date,
    service_type: 'Quarterly Pest Control', status: 'pending',
  });

  beforeEach(() => {
    InvoiceService.settleInvoiceAsAnnualPrepayCovered.mockReset();
    postCreditMovement.mockReset();
    // The credit path opens its own transaction when running on the global
    // pool (conn === db) so the dedupe check shares the ledger write's lock.
    db.transaction = jest.fn(async (cb) => cb(db));
  });

  test('settles a still-open completion invoice as coverage (the paid annual IS that visit\'s payment)', async () => {
    setDbQueues({
      scheduled_services: [query({ rows: [completedRow(), pendingRow('s2', '2026-09-20'), pendingRow('s3', '2026-12-20'), pendingRow('s4', '2027-03-20')] })],
      invoices: [query({ first: { id: 'inv-visit', status: 'pending', payment_recorded_at: null, annual_prepay_covered_term_id: null } })],
    });
    InvoiceService.settleInvoiceAsAnnualPrepayCovered.mockResolvedValueOnce({ settled: true });

    const result = await AnnualPrepayRenewals.reconcilePendingWindowCompletions(TERM);

    expect(result).toEqual({ settled: 1, credited: 0 });
    expect(InvoiceService.settleInvoiceAsAnnualPrepayCovered).toHaveBeenCalledWith('inv-visit', 'term-1');
    expect(postCreditMovement).not.toHaveBeenCalled();
  });

  test('a PAID completion invoice returns the visit\'s slice as account credit (ledger-deduped)', async () => {
    setDbQueues({
      scheduled_services: [query({ rows: [completedRow(), pendingRow('s2', '2026-09-20'), pendingRow('s3', '2026-12-20'), pendingRow('s4', '2027-03-20')] })],
      invoices: [query({ first: { id: 'inv-visit', status: 'paid', payment_recorded_at: '2026-06-21', annual_prepay_covered_term_id: null } })],
      customers: [query({ first: { id: 'customer-1' } })],
      customer_credit_ledger: [query({ first: undefined })],
    });

    const result = await AnnualPrepayRenewals.reconcilePendingWindowCompletions(TERM);

    expect(result).toEqual({ settled: 0, credited: 1 });
    expect(InvoiceService.settleInvoiceAsAnnualPrepayCovered).not.toHaveBeenCalled();
    // The dedupe check + ledger write run inside ONE transaction under the
    // customer row lock (race-safe idempotency).
    expect(db.transaction).toHaveBeenCalled();
    expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-1',
      delta: 100, // 400 / 4 covered visits — the completed visit's slice
      source: 'adjustment',
      invoiceId: 'inv-visit',
      createdBy: 'system:annual_prepay_pending_completion',
    }), db);
  });

  test('an existing ledger entry for the term+visit blocks a second credit (idempotent on retried webhooks)', async () => {
    setDbQueues({
      scheduled_services: [query({ rows: [completedRow(), pendingRow('s2', '2026-09-20'), pendingRow('s3', '2026-12-20'), pendingRow('s4', '2027-03-20')] })],
      invoices: [query({ first: { id: 'inv-visit', status: 'paid', payment_recorded_at: '2026-06-21', annual_prepay_covered_term_id: null } })],
      customers: [query({ first: { id: 'customer-1' } })],
      customer_credit_ledger: [query({ first: { id: 'ledger-1' } })],
    });

    const result = await AnnualPrepayRenewals.reconcilePendingWindowCompletions(TERM);

    expect(result).toEqual({ settled: 0, credited: 0 });
    expect(postCreditMovement).not.toHaveBeenCalled();
  });

  test('a PROCESSING completion invoice gets neither settle nor credit (in-flight money can still fail)', async () => {
    setDbQueues({
      scheduled_services: [query({ rows: [completedRow(), pendingRow('s2', '2026-09-20'), pendingRow('s3', '2026-12-20'), pendingRow('s4', '2027-03-20')] })],
      invoices: [query({ first: { id: 'inv-visit', status: 'processing', payment_recorded_at: null, annual_prepay_covered_term_id: null } })],
    });

    const result = await AnnualPrepayRenewals.reconcilePendingWindowCompletions(TERM);

    expect(result).toEqual({ settled: 0, credited: 0 });
    expect(InvoiceService.settleInvoiceAsAnnualPrepayCovered).not.toHaveBeenCalled();
    expect(postCreditMovement).not.toHaveBeenCalled();
  });

  test('a settle-refused OPEN invoice is left alone (no credit for money never collected)', async () => {
    setDbQueues({
      scheduled_services: [query({ rows: [completedRow(), pendingRow('s2', '2026-09-20'), pendingRow('s3', '2026-12-20'), pendingRow('s4', '2027-03-20')] })],
      invoices: [query({ first: { id: 'inv-visit', status: 'pending', payment_recorded_at: null, annual_prepay_covered_term_id: null } })],
    });
    InvoiceService.settleInvoiceAsAnnualPrepayCovered.mockResolvedValueOnce({ settled: false, reason: 'has_add_ons' });

    const result = await AnnualPrepayRenewals.reconcilePendingWindowCompletions(TERM);

    expect(result).toEqual({ settled: 0, credited: 0 });
    expect(postCreditMovement).not.toHaveBeenCalled();
  });

  test('an account-credit-covered (bare prepaid) visit invoice still returns the slice — real credit was consumed', async () => {
    // The credit seam flips fully credit-covered invoices to 'prepaid' with NO
    // annual_prepay_covered_term_id — that consumed the customer's actual
    // credit for the visit, so the annual's slice must still come back.
    setDbQueues({
      scheduled_services: [query({ rows: [completedRow(), pendingRow('s2', '2026-09-20'), pendingRow('s3', '2026-12-20'), pendingRow('s4', '2027-03-20')] })],
      invoices: [query({ first: { id: 'inv-visit', status: 'prepaid', payment_recorded_at: null, annual_prepay_covered_term_id: null } })],
      customers: [query({ first: { id: 'customer-1' } })],
      customer_credit_ledger: [query({ first: undefined })],
    });

    const result = await AnnualPrepayRenewals.reconcilePendingWindowCompletions(TERM);

    expect(result).toEqual({ settled: 0, credited: 1 });
    expect(InvoiceService.settleInvoiceAsAnnualPrepayCovered).not.toHaveBeenCalled();
    expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({ delta: 100 }), db);
  });

  test('a coverage-settled visit invoice (covered_term marker set) is skipped — the reopen path owns reversals', async () => {
    setDbQueues({
      scheduled_services: [query({ rows: [completedRow(), pendingRow('s2', '2026-09-20'), pendingRow('s3', '2026-12-20'), pendingRow('s4', '2027-03-20')] })],
      invoices: [query({ first: { id: 'inv-visit', status: 'prepaid', payment_recorded_at: null, annual_prepay_covered_term_id: 'term-other' } })],
    });

    const result = await AnnualPrepayRenewals.reconcilePendingWindowCompletions(TERM);

    expect(result).toEqual({ settled: 0, credited: 0 });
    expect(postCreditMovement).not.toHaveBeenCalled();
  });

  test('never-invoiced and already-covered completions need nothing', async () => {
    setDbQueues({
      scheduled_services: [query({
        rows: [
          // Never billed — the annual slice IS this visit's payment.
          completedRow(),
          // Already delivered as coverage (settled at completion by dispatch).
          completedRow({ id: 'svc-covered', scheduled_date: '2026-09-20', prepaid_amount: 100, prepaid_method: 'annual_prepay_invoice', annual_prepay_term_id: 'term-1' }),
          pendingRow('s3', '2026-12-20'),
          pendingRow('s4', '2027-03-20'),
        ],
      })],
      invoices: [query({ first: undefined })],
    });

    const result = await AnnualPrepayRenewals.reconcilePendingWindowCompletions(TERM);

    expect(result).toEqual({ settled: 0, credited: 0 });
    expect(InvoiceService.settleInvoiceAsAnnualPrepayCovered).not.toHaveBeenCalled();
    expect(postCreditMovement).not.toHaveBeenCalled();
  });
});

describe('reversePendingWindowCompletionCredits (refund claw-back)', () => {
  const { postCreditMovement } = require('../services/customer-credit');
  const TERM = { id: 'term-1', customer_id: 'customer-1' };
  const creditRow = {
    id: 'cl-1',
    delta: 100,
    invoice_id: 'inv-visit',
    note: "Annual prepay paid after this visit already billed — the visit's prepay share returned as account credit (term term-1, visit svc-done)",
  };

  beforeEach(() => {
    postCreditMovement.mockReset();
    db.transaction = jest.fn(async (cb) => cb(db));
  });

  test('reverses an issued pending-completion credit when the annual prepay refunds', async () => {
    setDbQueues({
      customers: [query({ first: { id: 'customer-1', account_credits: 150 } })],
      customer_credit_ledger: [query({ rows: [creditRow] }), query({ rows: [] })],
    });

    const reversed = await AnnualPrepayRenewals.reversePendingWindowCompletionCredits(TERM);

    expect(reversed).toBe(1);
    expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-1',
      delta: -100,
      source: 'adjustment',
      invoiceId: 'inv-visit',
      createdBy: 'system:annual_prepay_pending_completion_reversal',
    }), db);
  });

  test('an existing reversal row for the term+visit marker blocks a second claw-back', async () => {
    setDbQueues({
      customers: [query({ first: { id: 'customer-1', account_credits: 150 } })],
      customer_credit_ledger: [
        query({ rows: [creditRow] }),
        query({ rows: [{ note: 'Annual prepay refunded — reversing the visit\'s pending-completion credit (term term-1, visit svc-done)' }] }),
      ],
    });

    const reversed = await AnnualPrepayRenewals.reversePendingWindowCompletionCredits(TERM);

    expect(reversed).toBe(0);
    expect(postCreditMovement).not.toHaveBeenCalled();
  });

  test("a visit-invoice refund reverses only THAT visit's credit (visitId narrows the marker)", async () => {
    const creditsQuery = query({ rows: [creditRow] });
    setDbQueues({
      customers: [query({ first: { id: 'customer-1', account_credits: 150 } })],
      customer_credit_ledger: [creditsQuery, query({ rows: [] })],
    });

    const reversed = await AnnualPrepayRenewals.reversePendingWindowCompletionCredits(TERM, undefined, { visitId: 'svc-done' });

    expect(reversed).toBe(1);
    expect(creditsQuery.where).toHaveBeenCalledWith('note', 'like', '%term term-1, visit svc-done)%');
    expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({ delta: -100 }), db);
  });

  test('an exhausted balance is never pulled negative — a zero-delta marker row still records the reversal as handled', async () => {
    const markerInsert = query();
    setDbQueues({
      customers: [query({ first: { id: 'customer-1', account_credits: 0 } })],
      customer_credit_ledger: [query({ rows: [creditRow] }), query({ rows: [] }), markerInsert],
    });

    const reversed = await AnnualPrepayRenewals.reversePendingWindowCompletionCredits(TERM);

    expect(reversed).toBe(0);
    expect(postCreditMovement).not.toHaveBeenCalled();
    // Refund syncs replay (Stripe/admin retries): without a dedupe marker a
    // later retry — running after UNRELATED credit lands — would claw the
    // spent slice out of that new balance. The zero-delta row is the marker.
    expect(markerInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
      customer_id: 'customer-1',
      delta: 0,
      balance_after: 0,
      created_by: 'system:annual_prepay_pending_completion_reversal',
      note: expect.stringContaining('(term term-1, visit svc-done)'),
    }));
  });

  test('the zero-delta marker row blocks the claw-back on a replayed refund sync after new credit lands', async () => {
    setDbQueues({
      customers: [query({ first: { id: 'customer-1', account_credits: 250 } })],
      customer_credit_ledger: [
        query({ rows: [creditRow] }),
        query({ rows: [{ note: "Annual prepay refunded — the visit's pending-completion credit was already spent; nothing reversed, operator follow-up needed (term term-1, visit svc-done)" }] }),
      ],
    });

    const reversed = await AnnualPrepayRenewals.reversePendingWindowCompletionCredits(TERM);

    expect(reversed).toBe(0);
    expect(postCreditMovement).not.toHaveBeenCalled();
  });
});

describe('createTermForAnnualPrepay born-already-paid reconcile', () => {
  const InvoiceService = require('../services/invoice');
  const { postCreditMovement } = require('../services/customer-credit');

  // The Customer 360 "record annual prepay" flow marks the invoice paid BEFORE
  // creating the term, so the term is born active and never passes through
  // syncTermForInvoicePayment — creation itself must run the pending-window
  // reconcile or completed covered visits stay double-billed.
  const TERM = {
    id: 'term-1',
    customer_id: 'customer-1',
    status: 'active',
    prepay_amount: 400,
    term_start: '2026-06-15',
    term_end: '2027-06-15',
    coverage_service_type: 'Quarterly Pest Control',
    coverage_visit_count: 4,
    coverage_cadence: 'quarterly',
  };
  const visitRows = [
    { id: 'svc-done', customer_id: 'customer-1', scheduled_date: '2026-06-20', service_type: 'Quarterly Pest Control', status: 'completed', prepaid_amount: null, prepaid_method: null, annual_prepay_term_id: null },
    { id: 's2', customer_id: 'customer-1', scheduled_date: '2026-09-20', service_type: 'Quarterly Pest Control', status: 'pending' },
    { id: 's3', customer_id: 'customer-1', scheduled_date: '2026-12-20', service_type: 'Quarterly Pest Control', status: 'pending' },
    { id: 's4', customer_id: 'customer-1', scheduled_date: '2027-03-20', service_type: 'Quarterly Pest Control', status: 'pending' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
    _private.resetCachesForTests();
    InvoiceService.settleInvoiceAsAnnualPrepayCovered.mockReset();
    postCreditMovement.mockReset();
    db.transaction = jest.fn(async (cb) => cb(db));
  });

  test('a term inserted already ACTIVE reconciles its pending-window completions (Customer 360 record-prepay path)', async () => {
    setDbQueues({
      annual_prepay_terms: [
        query({ columnInfo: {} }), // annualPrepayColumns
        query({ first: undefined }), // existing-term lookup (customer + window)
        query({ returning: [TERM] }), // insert
        query({ first: TERM }), // refreshTermSnapshot term read
        query({ returning: [TERM] }), // refreshTermSnapshot snapshot update
      ],
      scheduled_services: [
        // Minimal column set: seeding/attach/stamp machinery no-ops, which
        // isolates the creation → reconcile hand-off under test.
        query({ columnInfo: { scheduled_date: {}, service_type: {} } }),
        query({ rows: visitRows }), // ensureCoverageRowsForTerm existing-rows read
        query({ rows: visitRows }), // refreshTermSnapshot covered-rows read
        query({ rows: visitRows }), // reconcile coverage read
      ],
      invoices: [
        query({ first: { id: 'inv-visit', status: 'paid', payment_recorded_at: '2026-06-21', annual_prepay_covered_term_id: null } }),
      ],
      customers: [
        query({ columnInfo: {} }), // syncCustomerRenewalDate column probe (no renewal column)
        query({ first: { id: 'customer-1' } }), // credit-path row lock
      ],
      customer_credit_ledger: [query({ first: undefined })],
    });

    const created = await AnnualPrepayRenewals.createTermForAnnualPrepay({
      customerId: 'customer-1',
      termStart: '2026-06-15',
      coverageServiceType: 'Quarterly Pest Control',
      coverageVisitCount: 4,
      coverageCadence: 'quarterly',
      prepayAmount: 400,
    });

    expect(created).toEqual(TERM);
    // The completed pending-window visit's PAID invoice slice came back as
    // account credit — proof the reconcile ran at creation time.
    expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-1',
      delta: 100,
      invoiceId: 'inv-visit',
      createdBy: 'system:annual_prepay_pending_completion',
    }), db);
  });

  test('inside a caller transaction the born-paid reconcile defers to AFTER commit (settle leg opens its own trx)', async () => {
    // settleInvoiceAsAnnualPrepayCovered runs on the global pool: inside the
    // caller trx it would stamp a covered-term marker against a term row the
    // trx hasn't committed yet (FK wait/fail, swallowed) — so creation inside
    // a trx must defer the reconcile to trx.executionPromise.
    let commitResolve;
    const commitPromise = new Promise((resolve) => { commitResolve = resolve; });
    const trx = jest.fn((table) => db(table));
    trx.executionPromise = commitPromise;
    setDbQueues({
      annual_prepay_terms: [
        query({ columnInfo: {} }),
        query({ first: undefined }),
        query({ returning: [TERM] }),
        query({ first: TERM }),
        query({ returning: [TERM] }),
      ],
      scheduled_services: [
        query({ columnInfo: { scheduled_date: {}, service_type: {} } }),
        query({ rows: visitRows }),
        query({ rows: visitRows }),
        query({ rows: visitRows }),
      ],
      invoices: [
        query({ first: { id: 'inv-visit', status: 'paid', payment_recorded_at: '2026-06-21', annual_prepay_covered_term_id: null } }),
      ],
      customers: [
        query({ columnInfo: {} }),
        query({ first: { id: 'customer-1' } }),
      ],
      customer_credit_ledger: [query({ first: undefined })],
    });

    const created = await AnnualPrepayRenewals.createTermForAnnualPrepay({
      customerId: 'customer-1',
      termStart: '2026-06-15',
      coverageServiceType: 'Quarterly Pest Control',
      coverageVisitCount: 4,
      coverageCadence: 'quarterly',
      prepayAmount: 400,
      conn: trx,
    });

    expect(created).toEqual(TERM);
    // Still inside the caller transaction: nothing settled/credited yet.
    expect(postCreditMovement).not.toHaveBeenCalled();

    commitResolve();
    await new Promise((resolve) => { setImmediate(resolve); });

    // After commit the reconcile ran on the GLOBAL pool, not the caller trx.
    expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-1',
      delta: 100,
      invoiceId: 'inv-visit',
      createdBy: 'system:annual_prepay_pending_completion',
    }), db);
  });
});

describe('syncTermForInvoicePayment visit-invoice hook (covered-status semantics)', () => {
  const { postCreditMovement } = require('../services/customer-credit');

  const DECIDED_TERM = {
    id: 'term-1',
    customer_id: 'customer-1',
    status: 'renewed',
    prepay_amount: 400,
    term_start: '2026-06-15',
    term_end: '2027-06-15',
    coverage_service_type: 'Quarterly Pest Control',
    coverage_visit_count: 4,
  };
  const visitRows = [
    { id: 'svc-done', customer_id: 'customer-1', scheduled_date: '2026-06-20', service_type: 'Quarterly Pest Control', status: 'completed', prepaid_amount: null, prepaid_method: null, annual_prepay_term_id: null },
    { id: 's2', customer_id: 'customer-1', scheduled_date: '2026-09-20', service_type: 'Quarterly Pest Control', status: 'pending' },
    { id: 's3', customer_id: 'customer-1', scheduled_date: '2026-12-20', service_type: 'Quarterly Pest Control', status: 'pending' },
    { id: 's4', customer_id: 'customer-1', scheduled_date: '2027-03-20', service_type: 'Quarterly Pest Control', status: 'pending' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
    _private.resetCachesForTests();
    postCreditMovement.mockReset();
    db.transaction = jest.fn(async (cb) => cb(db));
  });

  test('a visit invoice paid AFTER the term renewal was decided still reconciles the slice (renewed term stays covered)', async () => {
    // coveredTermsAsOf resolves the covering term — a decided (renewed) term
    // is covered through term_end, so the late payment still owes its slice
    // back. The old ACTIVE_STATUSES lookup found nothing here.
    setDbQueues({
      annual_prepay_terms: [
        query({ rows: [] }), // prepay_invoice_id match — none (visit invoice)
      ],
      // coveredTermsAsOf opens its query on the ALIASED table name.
      'annual_prepay_terms as t': [
        query({ first: DECIDED_TERM }), // covering-term lookup
      ],
      scheduled_services: [
        query({ first: { id: 'svc-done', annual_prepay_term_id: 'term-1' } }), // visit attach-link read
        query({ rows: visitRows }), // reconcile coverage read
      ],
      invoices: [
        query({ first: { id: 'inv-visit', status: 'paid', payment_recorded_at: '2026-07-01', annual_prepay_covered_term_id: null } }),
      ],
      customers: [query({ first: { id: 'customer-1' } })],
      customer_credit_ledger: [query({ first: undefined })],
    });

    await AnnualPrepayRenewals.syncTermForInvoicePayment({
      id: 'inv-visit',
      status: 'paid',
      paid_at: '2026-07-01',
      scheduled_service_id: 'svc-done',
    });

    expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-1',
      delta: 100,
      invoiceId: 'inv-visit',
      createdBy: 'system:annual_prepay_pending_completion',
    }), db);
  });

  test("a visit invoice resolved as 'prepaid' by the account-credit seam still reconciles (consumed credit = collected money)", async () => {
    // invoiceTermStatus maps status='prepaid' (no paid_at) to payment_pending,
    // so the hook must gate on the visit invoice's own collected-ness — the
    // seam's full-coverage sync passes exactly this shape.
    setDbQueues({
      annual_prepay_terms: [
        query({ rows: [] }),
      ],
      'annual_prepay_terms as t': [
        query({ first: DECIDED_TERM }),
      ],
      scheduled_services: [
        query({ first: { id: 'svc-done', annual_prepay_term_id: 'term-1' } }),
        query({ rows: visitRows }),
      ],
      invoices: [
        query({ first: { id: 'inv-visit', status: 'prepaid', payment_recorded_at: null, annual_prepay_covered_term_id: null } }),
      ],
      customers: [query({ first: { id: 'customer-1' } })],
      customer_credit_ledger: [query({ first: undefined })],
    });

    await AnnualPrepayRenewals.syncTermForInvoicePayment({
      id: 'inv-visit',
      status: 'prepaid',
      paid_at: null,
      scheduled_service_id: 'svc-done',
    });

    expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-1',
      delta: 100,
      invoiceId: 'inv-visit',
      createdBy: 'system:annual_prepay_pending_completion',
    }), db);
  });

  test('a term whose paid coverage no longer validates mints nothing (coveredTermsAsOf returns no term)', async () => {
    // e.g. a renewed-status term whose prepay invoice was refunded: the
    // decided status survives the refund sync, so the status alone must not
    // gate the credit — coveredTermsAsOf's invoice/payment revalidation does.
    const coverageLookup = query({ first: undefined }); // revalidation excludes the term
    setDbQueues({
      annual_prepay_terms: [
        query({ rows: [] }),
      ],
      'annual_prepay_terms as t': [coverageLookup],
      scheduled_services: [
        query({ first: { id: 'svc-done', annual_prepay_term_id: 'term-1' } }),
      ],
    });

    await AnnualPrepayRenewals.syncTermForInvoicePayment({
      id: 'inv-visit',
      status: 'paid',
      paid_at: '2026-07-01',
      scheduled_service_id: 'svc-done',
    });

    // The lookup RAN (hook didn't crash) and its exclusion is what blocked the
    // credit — not an error swallowed by the hook's best-effort catch.
    expect(coverageLookup.first).toHaveBeenCalled();
    expect(postCreditMovement).not.toHaveBeenCalled();
  });
});

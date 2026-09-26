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
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(),
}));
jest.mock('../services/account-membership-email', () => ({
  sendMembershipRenewalReminder: jest.fn(),
  sendTermiteRenewalReminder: jest.fn(),
  // Default: no already-accepted termite reminder on file.
  findAcceptedTermiteRenewalReminder: jest.fn(async () => null),
}));
jest.mock('../services/cancellation-resolution', () => ({
  cancelFlowV2Enabled: jest.fn(() => true),
}));
jest.mock('../utils/portal-url', () => ({
  portalUrl: jest.fn((path) => `https://portal.wavespestcontrol.com${path || ''}`),
}));
// Lazy-required by reconcilePendingWindowCompletions (and the cancel-path
// invoice reopen) — mocked so the unit tests don't pull real invoice/credit
// machinery.
jest.mock('../services/invoice', () => ({
  settleInvoiceAsAnnualPrepayCovered: jest.fn(),
  reopenAnnualPrepayCoveredInvoicesForTerm: jest.fn(),
  retireRodentSetupObligationForRevivedPrepay: jest.fn(async () => null),
  _retireSwitchRestoredInvoicesForRevivedPrepay: jest.fn(async () => 0),
}));
jest.mock('../services/customer-credit', () => ({
  postCreditMovement: jest.fn(),
  // Literal duplicates of the real identities (a requireActual would drag
  // the db pool in); the identity-pinning test below keeps them honest.
  WAVEGUARD_EXTENSION_CREDIT_BY: 'system:waveguard_tier_extension',
  WAVEGUARD_EXTENSION_REVERSAL_BY: 'system:waveguard_tier_extension_reversal',
  WAVEGUARD_EXTENSION_RESTORE_BY: 'system:waveguard_tier_extension_restore',
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn().mockResolvedValue({ id: 'notif-1' }),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const AccountMembershipEmail = require('../services/account-membership-email');
const CancellationResolution = require('../services/cancellation-resolution');
const NotificationService = require('../services/notification-service');
const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
const { _private } = AnnualPrepayRenewals;

function query({ first, returning, columnInfo, rows = [] } = {}) {
  const q = {};
  [
    'whereIn',
    'whereNull',
    'whereNot',
    'whereBetween',
    'whereNotIn',
    'orderBy',
    'select',
    'forUpdate',
    'leftJoin',
    'join',
    'whereRaw',
    'whereNotNull',
    'orWhereNotNull',
    'orWhereNull',
    'orWhereRaw',
    'orWhereNot',
    'orWhereIn',
    'orWhereNotIn',
  ].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.modify = jest.fn((fn) => { if (typeof fn === 'function') fn(q); return q; });
  q.where = jest.fn((arg) => {
    // Callers use both styles: `function () { this.whereX() }` and
    // `(q) => q.whereX()` (scheduling/occupancy) — bind AND pass.
    if (typeof arg === 'function') arg.call(q, q);
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
    if (!queue || !queue.length) {
      // r41: every seeding insert presence-probes the term owner under the
      // comms fence via this alias. Default = owner unchanged, so seeding
      // tests stay focused; the moved-owner defer pin queues its own miss.
      if (table === 'annual_prepay_terms as apt_owner_probe') {
        return query({ first: { customer_id: 'owner-unchanged' } });
      }
      // Termite notice prior-acceptance probe (Codex #4921 pre-push P1).
      // Default = no accepted SMS on file, so send tests stay focused; the
      // recovery tests queue their own rows.
      if (table === 'messaging_audit_log') return query({ first: undefined });
      throw new Error(`Unexpected db table ${table}`);
    }
    return queue.shift();
  });
  return tableQueues;
}

describe('annual prepay renewal helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
    // scheduling/occupancy lock probes: pg_try_advisory_xact_lock succeeds.
    db.raw = jest.fn().mockResolvedValue({ rows: [{ locked: true }] });
    // The timed first-visit seed opens its own transaction when the caller
    // passed a bare connection; run the callback against the same mock.
    db.transaction = jest.fn(async (cb) => cb(db));
    _private.resetCachesForTests();
    // jest.clearAllMocks() above clears calls but not a prior test's
    // mockReturnValue override — pin the default explicitly so a termite
    // cancel-flow-off test can't leak `false` into a later test.
    CancellationResolution.cancelFlowV2Enabled.mockReturnValue(true);
  });

  test('exposes serviceMatchesCoverage at the module root (the booking preflight destructures it)', () => {
    // admin-schedule's one-step-prepay preflight does
    // `const { serviceMatchesCoverage } = require('annual-prepay-renewals')` —
    // when this only lived under _private the destructure was undefined and
    // every eligible one-step booking 500'd.
    expect(typeof AnnualPrepayRenewals.serviceMatchesCoverage).toBe('function');
    expect(AnnualPrepayRenewals.serviceMatchesCoverage(
      { service_type: 'Pest Control' },
      'Quarterly Pest Control',
    )).toBe(true);
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
    expect(_private.noticeColumnForDaysOut(45)).toBe('notice_45_sent_at');
    expect(_private.noticeColumnForDaysOut(30)).toBe('notice_30_sent_at');
    expect(_private.noticeColumnForDaysOut('15')).toBe('notice_15_sent_at');
    expect(_private.noticeColumnForDaysOut(7)).toBe('notice_7_sent_at');
    expect(_private.noticeColumnForDaysOut(10)).toBeNull();
    expect(_private.noticeClaimColumnForDaysOut(45)).toBe('notice_45_claimed_at');
    expect(_private.noticeClaimColumnForDaysOut(30)).toBe('notice_30_claimed_at');
    expect(_private.noticeClaimColumnForDaysOut(15)).toBe('notice_15_claimed_at');
    expect(_private.noticeClaimColumnForDaysOut(10)).toBeNull();
  });

  // Slice 5 ("notice ladder"): the 45-day rung exists ONLY for termite
  // annual-plan terms (annual_plan_version set) — every other annual-prepay
  // term (lawn/mosquito/rodent/quarterly — this table is shared) never gets
  // it, so CUSTOMER_NOTICE_DAYS itself ([30, 15, 7]) stays untouched.
  test('isTermiteAnnualPlanTerm is true only for a term with annual_plan_version set', () => {
    expect(_private.isTermiteAnnualPlanTerm({ annual_plan_version: 'v3' })).toBe(true);
    expect(_private.isTermiteAnnualPlanTerm({ annual_plan_version: null })).toBe(false);
    expect(_private.isTermiteAnnualPlanTerm({})).toBe(false);
    expect(_private.isTermiteAnnualPlanTerm(null)).toBe(false);
  });

  test('formatCurrencyLabel matches email-template.js currency() formatting', () => {
    expect(_private.formatCurrencyLabel(650)).toBe('$650.00');
    expect(_private.formatCurrencyLabel(1234.5)).toBe('$1,234.50');
    expect(_private.formatCurrencyLabel(null)).toBe('$0.00');
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

  test('a callback / re-service never consumes a sold coverage slot', async () => {
    // 4 quarterly visits sold. A completed re-service callback sits inside the
    // window and its service_type collapses to the same coverage key as the
    // quarterly service ("Pest Control Re-Service" → "pestcontrolre" contains
    // "pestcontrol"). Text matching alone adopted it as visit 2 of 4 and pushed
    // the real fourth quarterly visit out of coverage (prod, 2026-09-07). The
    // callback is free by definition — it must be skipped before slicing.
    const quarterly = (id, scheduled_date, status = 'pending') => ({
      id, customer_id: 'c1', scheduled_date, status, service_type: 'Quarterly Pest Control Service',
      is_callback: false, prepaid_amount: null, prepaid_method: null, annual_prepay_term_id: null,
    });
    const rows = [
      quarterly('svc-jun', '2026-06-12', 'completed'),
      // Completed BEFORE the scheduler auto-flag shipped: is_callback is still
      // false (the backfill flagged non-terminal rows only), so the label is
      // the only evidence — the runtime re-service classifier must catch it.
      { id: 'svc-legacy-callback', customer_id: 'c1', scheduled_date: '2026-07-20', status: 'completed', service_type: 'Pest Control Re-Service', is_callback: false, prepaid_amount: null, prepaid_method: null, annual_prepay_term_id: null },
      { id: 'svc-callback', customer_id: 'c1', scheduled_date: '2026-08-30', status: 'completed', service_type: 'Pest Control Re-Service', is_callback: true, prepaid_amount: null, prepaid_method: null, annual_prepay_term_id: null },
      quarterly('svc-sep', '2026-09-11'),
      quarterly('svc-dec', '2026-12-11'),
      quarterly('svc-mar', '2027-03-12'),
    ];
    setDbQueues({ scheduled_services: [query({ rows })] });

    const selected = await _private.coverageRowsForTerm({
      id: 'term-1',
      customer_id: 'c1',
      coverage_service_type: 'Quarterly Pest Control Service',
      coverage_visit_count: 4,
      term_start: '2026-06-12',
      term_end: '2027-06-12',
    });

    expect(selected.map((r) => r.id)).toEqual(['svc-jun', 'svc-sep', 'svc-dec', 'svc-mar']);
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
    // The status skip is re-asserted IN the UPDATE (#3878 r5): a visit
    // cancelled between the eligibility read and this write is never
    // stamped — the predicate rides the same statement as the write.
    expect(updateTwo.whereNull).toHaveBeenCalledWith('status');
    expect(updateTwo.orWhereNotIn).toHaveBeenCalledWith('status', expect.arrayContaining(['cancelled', 'no_show', 'skipped', 'completed']));
  });

  test('a visit cancelled between the eligibility read and the stamp write is not counted as stamped (0-row update, #3878 r5)', async () => {
    const rows = [
      { id: 'svc-1', customer_id: 'customer-1', scheduled_date: '2026-06-20', service_type: 'Quarterly Pest Control', status: 'pending' },
    ];
    const columnQuery = query({ columnInfo: { prepaid_amount: {}, prepaid_method: {}, prepaid_at: {}, annual_prepay_term_id: {}, updated_at: {} } });
    const rowsQuery = query({ rows });
    // The row read as 'pending' was cancelled before the UPDATE ran: the
    // status predicate matches nothing and returning() is empty.
    const racedUpdate = query({ returning: [] });
    // Re-read of the unmatched row classifies the race: it is now cancelled.
    const reread = query({ rows: [{ id: 'svc-1', status: 'cancelled' }] });
    setDbQueues({
      scheduled_services: [columnQuery, rowsQuery, racedUpdate, reread],
      notifications: [query({ first: undefined })], // coverage-exception dedupe probe: none open
    });
    const { notifyAdmin } = require('../services/notification-service');
    notifyAdmin.mockClear();

    const result = await AnnualPrepayRenewals.applyPrepaidCoverageForTerm({
      id: 'term-1', customer_id: 'customer-1', prepay_amount: 200,
      term_start: '2026-06-15', term_end: '2027-06-15',
      coverage_service_type: 'Quarterly Pest Control', coverage_visit_count: 1,
    });
    expect(racedUpdate.update).toHaveBeenCalled();
    expect(result.stampedCount).toBe(0);
    expect(result.racedRowIds).toEqual(['svc-1']);
    // Callers discard the result, so the shortfall is filed as a durable
    // operator exception right here (Codex #3882 r1 P1).
    expect(notifyAdmin).toHaveBeenCalledWith(
      'alert',
      expect.any(String),
      expect.stringMatching(/1 paid visit\(s\) were cancelled while the annual prepay was being applied.*0 of 1 sold visits/),
      expect.objectContaining({ metadata: expect.objectContaining({ reason: 'stamp_raced_cancel', annual_prepay_term_id: 'term-1' }) }),
    );
  });

  test('a visit COMPLETED between the eligibility read and the stamp write is not a cancellation shortfall — it files its own completion-race exception (hook P1 + Codex r2 P1)', async () => {
    const rows = [
      { id: 'svc-1', customer_id: 'customer-1', scheduled_date: '2026-06-20', service_type: 'Quarterly Pest Control', status: 'on_site' },
    ];
    const columnQuery = query({ columnInfo: { prepaid_amount: {}, prepaid_method: {}, prepaid_at: {}, annual_prepay_term_id: {}, updated_at: {} } });
    const rowsQuery = query({ rows });
    const racedUpdate = query({ returning: [] });
    const reread = query({ rows: [{ id: 'svc-1', status: 'completed' }] });
    setDbQueues({
      scheduled_services: [columnQuery, rowsQuery, racedUpdate, reread],
      notifications: [query({ first: undefined })],
    });
    const { notifyAdmin } = require('../services/notification-service');
    notifyAdmin.mockClear();

    const result = await AnnualPrepayRenewals.applyPrepaidCoverageForTerm({
      id: 'term-1', customer_id: 'customer-1', prepay_amount: 200,
      term_start: '2026-06-15', term_end: '2027-06-15',
      coverage_service_type: 'Quarterly Pest Control', coverage_visit_count: 1,
    });
    expect(result.stampedCount).toBe(0);
    expect(result.racedRowIds).toEqual([]);
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin).toHaveBeenCalledWith(
      'alert', expect.any(String), expect.stringContaining('completed while the annual prepay was being applied'),
      expect.objectContaining({ metadata: expect.objectContaining({ reason: 'stamp_raced_completion', annual_prepay_term_id: 'term-1' }) }),
    );
  });

  test('a term whose owner moved under the comms fence (merge-undo) defers every seed — no visits on the stale kept owner', async () => {
    const columnQuery = query({
      columnInfo: {
        scheduled_date: {}, service_type: {}, annual_prepay_term_id: {},
        is_recurring: {}, recurring_pattern: {}, recurring_parent_id: {},
        recurring_ongoing: {}, technician_id: {}, window_start: {},
        window_end: {}, time_window: {}, customer_notes: {}, zone: {},
        notes: {}, estimated_duration_minutes: {},
      },
    });
    const rowsQuery = query({ rows: [] });
    const insertQuery = query({ returning: [{ id: 'svc-never' }] });
    const missProbe = () => query({ first: undefined });
    setDbQueues({
      scheduled_services: [columnQuery, rowsQuery, query({ first: undefined }), insertQuery],
      // The presence probe misses on every seeded date — one entry per seed
      // (the default owner-unchanged fallback only serves an EMPTY queue).
      'annual_prepay_terms as apt_owner_probe': [missProbe(), missProbe(), missProbe(), missProbe()],
    });

    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-moved',
      customer_id: 'customer-kept',
      term_start: '2026-06-15',
      term_end: '2027-06-15',
      coverage_service_type: 'Quarterly Pest Control',
      coverage_visit_count: 4,
    }, undefined, { today: '2026-01-01' })).resolves.toMatchObject({
      createdCount: 0,
      existingCount: 0,
    });

    expect(insertQuery.insert).not.toHaveBeenCalled();
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
        query({ first: undefined }),
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
    }, undefined, { today: '2026-01-01' })).resolves.toMatchObject({
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

  test('semiannual PALM coverage stamps the recurring catalog identity on every seeded visit (codex #3349 r14 P1)', async () => {
    // A bare service_type 'Palm Injection' misfiles at completion: the
    // exact-name lookup misses and the unique short-name match is the
    // ONE-TIME palm_injection row — paid recurring visits would get
    // one-time billing + token-only portal posture.
    const columnQuery = query({
      columnInfo: {
        scheduled_date: {}, service_type: {}, service_id: {},
        service_key_snapshot: {}, annual_prepay_term_id: {},
        is_recurring: {}, recurring_pattern: {}, recurring_parent_id: {},
        recurring_ongoing: {}, technician_id: {}, window_start: {},
        window_end: {}, time_window: {}, customer_notes: {}, zone: {},
        notes: {}, estimated_duration_minutes: {},
      },
    });
    const rowsQuery = query({ rows: [] });
    const parentInsert = query({ returning: [{ id: 'svc-p1', scheduled_date: '2026-06-15' }] });
    const childInsert = query({ returning: [{ id: 'svc-p2', scheduled_date: '2026-12-15' }] });
    setDbQueues({
      scheduled_services: [columnQuery, rowsQuery, query({ first: undefined }), parentInsert, childInsert],
      services: [
        // Filter looks up BOTH ids (semiannual + one-time), then the
        // seeding resolve repeats them.
        query({ first: { id: 'cat-palm-semi' } }),
        query({ first: { id: 'cat-palm-onetime' } }),
        query({ first: { id: 'cat-palm-semi', service_key: 'palm_injection_semiannual' } }),
        query({ first: { id: 'cat-palm-onetime', service_key: 'palm_injection' } }),
      ],
    });

    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-palm',
      customer_id: 'customer-palm',
      term_start: '2026-06-15',
      term_end: '2027-06-15',
      coverage_service_type: 'Palm Injection',
      coverage_visit_count: 2,
    }, undefined, { today: '2026-01-01' })).resolves.toMatchObject({
      createdCount: 2,
      targetDates: ['2026-06-15', '2026-12-15'],
    });

    expect(parentInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
      service_type: 'Palm Injection',
      service_id: 'cat-palm-semi',
      service_key_snapshot: 'palm_injection_semiannual',
      recurring_pattern: 'semiannual',
    }));
    expect(childInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
      service_id: 'cat-palm-semi',
      service_key_snapshot: 'palm_injection_semiannual',
      recurring_parent_id: 'svc-p1',
    }));
  });

  test('an ADOPTED name-only palm visit is backfilled with the recurring catalog identity (codex #3349 r15 pre-push P1)', async () => {
    // buildInsert stamps only NEW rows; a matched pre-existing name-only
    // visit must be backfilled or it keeps resolving the one-time row.
    const columnQuery = query({
      columnInfo: {
        scheduled_date: {}, service_type: {}, service_id: {},
        service_key_snapshot: {}, annual_prepay_term_id: {},
        is_recurring: {}, recurring_pattern: {}, recurring_parent_id: {},
        recurring_ongoing: {}, technician_id: {}, window_start: {},
        window_end: {}, time_window: {}, customer_notes: {}, zone: {},
        notes: {}, estimated_duration_minutes: {},
      },
    });
    // Committed to THIS term: name-only rows without identity or
    // provenance are excluded from palm coverage matching entirely
    // (codex r18 pre-push P0 — a genuine one-time sale must never be
    // adopted), so the legacy-adoption case is a term-attached row.
    const adoptedRow = {
      id: 'v-adopted', scheduled_date: '2026-06-15', service_type: 'Palm Injection',
      service_id: null, annual_prepay_term_id: 'term-palm-adopt', status: 'pending',
    };
    const rowsQuery = query({ rows: [adoptedRow] });
    const childInsert = query({ returning: [{ id: 'svc-p2', scheduled_date: '2026-12-15' }] });
    const backfillUpdate = query({});
    setDbQueues({
      scheduled_services: [columnQuery, rowsQuery, query({ first: undefined }), backfillUpdate, childInsert],
      services: [
        // Filter looks up BOTH ids (semiannual + one-time), then the
        // seeding resolve repeats them.
        query({ first: { id: 'cat-palm-semi' } }),
        query({ first: { id: 'cat-palm-onetime' } }),
        query({ first: { id: 'cat-palm-semi', service_key: 'palm_injection_semiannual' } }),
        query({ first: { id: 'cat-palm-onetime', service_key: 'palm_injection' } }),
      ],
    });

    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-palm-adopt',
      customer_id: 'customer-palm',
      term_start: '2026-06-15',
      term_end: '2027-06-15',
      coverage_service_type: 'Palm Injection',
      coverage_visit_count: 2,
    }, undefined, { today: '2026-01-01' })).resolves.toMatchObject({
      createdCount: 1,
      existingCount: 1,
    });

    expect(backfillUpdate.whereIn).toHaveBeenCalledWith('id', ['v-adopted']);
    expect(backfillUpdate.update).toHaveBeenCalledWith({
      service_id: 'cat-palm-semi',
      service_key_snapshot: 'palm_injection_semiannual',
    });
  });

  test('an adopted palm visit carrying the STALE one-time id is retargeted; other explicit ids stay (codex #3349 r16 P1)', async () => {
    // Legacy adoption: booked before the recurring row existed, so it
    // carries the one-time palm_injection id — completion trusts the id
    // first, so it must be retargeted in this definitively semiannual
    // context. An unrelated explicit id is a deliberate booking and stays.
    const columnQuery = query({
      columnInfo: {
        scheduled_date: {}, service_type: {}, service_id: {},
        service_key_snapshot: {}, annual_prepay_term_id: {},
        is_recurring: {}, recurring_pattern: {}, recurring_parent_id: {},
        recurring_ongoing: {}, technician_id: {}, window_start: {},
        window_end: {}, time_window: {}, customer_notes: {}, zone: {},
        notes: {}, estimated_duration_minutes: {},
      },
    });
    const rowsQuery = query({
      rows: [
        // Committed to THIS term (provenance) — the stale one-time id
        // retargets.
        { id: 'v-stale', scheduled_date: '2026-06-15', service_type: 'Palm Injection', service_id: 'cat-palm-onetime', annual_prepay_term_id: 'term-palm-stale', status: 'pending' },
        // One-time id WITHOUT term provenance = possibly a GENUINE
        // one-time palm sale (codex r18 pre-push P0) — never converted.
        { id: 'v-genuine-onetime', scheduled_date: '2026-12-15', service_type: 'Palm Injection', service_id: 'cat-palm-onetime', status: 'pending' },
      ],
    });
    const backfillUpdate = query({});
    const replacementInsert = query({ returning: [{ id: 'svc-new', scheduled_date: '2026-12-15' }] });
    setDbQueues({
      scheduled_services: [columnQuery, rowsQuery, query({ first: undefined }), backfillUpdate, replacementInsert],
      services: [
        // Filter looks up BOTH ids (semiannual + one-time), then the
        // seeding resolve repeats them.
        query({ first: { id: 'cat-palm-semi' } }),
        query({ first: { id: 'cat-palm-onetime' } }),
        query({ first: { id: 'cat-palm-semi', service_key: 'palm_injection_semiannual' } }),
        query({ first: { id: 'cat-palm-onetime', service_key: 'palm_injection' } }),
      ],
    });

    // The uncommitted one-time row is EXCLUDED from coverage matching, so
    // coverage seeds a correctly-identified replacement visit instead of
    // adopting the genuine one-time sale.
    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-palm-stale',
      customer_id: 'customer-palm',
      term_start: '2026-06-15',
      term_end: '2027-06-15',
      coverage_service_type: 'Palm Injection',
      coverage_visit_count: 2,
    }, undefined, { today: '2026-01-01' })).resolves.toMatchObject({
      createdCount: 1,
      existingCount: 1,
    });

    // Only the stale one-time id is retargeted — v-deliberate is excluded.
    expect(backfillUpdate.whereIn).toHaveBeenCalledWith('id', ['v-stale']);
    expect(backfillUpdate.update).toHaveBeenCalledWith({
      service_id: 'cat-palm-semi',
      service_key_snapshot: 'palm_injection_semiannual',
    });
  });

  test('a payment-pending reserved palm visit (estimate provenance only) is ADOPTED and retargeted, never replaced (codex r18 pre-push P0)', async () => {
    // The sold first visit of a not-yet-activated term carries only
    // source_estimate_id — no term link, no prepaid stamp, no identity.
    // Estimate provenance counts as commitment: the visit is adopted into
    // coverage and backfilled, instead of being excluded (which would
    // seed a replacement and leave the sold visit separately billable).
    const columnQuery = query({
      columnInfo: {
        scheduled_date: {}, service_type: {}, service_id: {},
        service_key_snapshot: {}, annual_prepay_term_id: {},
        is_recurring: {}, recurring_pattern: {}, recurring_parent_id: {},
        recurring_ongoing: {}, technician_id: {}, window_start: {},
        window_end: {}, time_window: {}, customer_notes: {}, zone: {},
        notes: {}, estimated_duration_minutes: {},
      },
    });
    const rowsQuery = query({
      rows: [
        // The seeded reserved parent carries recurring markers — the
        // provenance tiebreaker (codex r19 P0 second pass).
        { id: 'v-reserved', scheduled_date: '2026-06-15', service_type: 'Palm Injection', service_id: null, is_recurring: true, source_estimate_id: 'est-42', status: 'pending' },
      ],
    });
    const backfillUpdate = query({});
    const childInsert = query({ returning: [{ id: 'svc-p2', scheduled_date: '2026-12-15' }] });
    setDbQueues({
      scheduled_services: [columnQuery, rowsQuery, query({ first: undefined }), backfillUpdate, childInsert],
      services: [
        // Filter looks up BOTH ids (semiannual + one-time), then the
        // seeding resolve repeats them.
        query({ first: { id: 'cat-palm-semi' } }),
        query({ first: { id: 'cat-palm-onetime' } }),
        query({ first: { id: 'cat-palm-semi', service_key: 'palm_injection_semiannual' } }),
        query({ first: { id: 'cat-palm-onetime', service_key: 'palm_injection' } }),
      ],
    });

    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-palm-resv',
      customer_id: 'customer-palm',
      source_estimate_id: 'est-42',
      term_start: '2026-06-15',
      term_end: '2027-06-15',
      coverage_service_type: 'Palm Injection',
      coverage_visit_count: 2,
    }, undefined, { today: '2026-01-01' })).resolves.toMatchObject({
      createdCount: 1,
      existingCount: 1,
    });

    expect(backfillUpdate.whereIn).toHaveBeenCalledWith('id', ['v-reserved']);
  });

  test('a one-time palm visit from the SAME estimate is never consumed as coverage (codex r19 P1)', async () => {
    // One estimate can sell the recurring program AND a genuine one-time
    // palm item — both visits carry source_estimate_id. The one-time
    // identity disqualifies estimate provenance: only a direct term link
    // or prepaid stamp commits such a row.
    const columnQuery = query({
      columnInfo: {
        scheduled_date: {}, service_type: {}, service_id: {},
        service_key_snapshot: {}, annual_prepay_term_id: {},
        is_recurring: {}, recurring_pattern: {}, recurring_parent_id: {},
        recurring_ongoing: {}, technician_id: {}, window_start: {},
        window_end: {}, time_window: {}, customer_notes: {}, zone: {},
        notes: {}, estimated_duration_minutes: {},
      },
    });
    const rowsQuery = query({
      rows: [
        { id: 'v-reserved', scheduled_date: '2026-06-15', service_type: 'Palm Injection', service_id: null, is_recurring: true, source_estimate_id: 'est-42', status: 'pending' },
        { id: 'v-est-onetime', scheduled_date: '2026-09-01', service_type: 'Palm Injection', service_id: 'cat-palm-onetime', source_estimate_id: 'est-42', status: 'pending' },
        // NAME-ONLY one-time reservation from the same estimate: no
        // recurring markers, no identity — provenance alone must not
        // commit it (codex r19 P0 second pass).
        { id: 'v-onetime-nameonly', scheduled_date: '2027-03-01', service_type: 'Palm Injection', service_id: null, source_estimate_id: 'est-42', status: 'pending' },
        // Legacy payment-pending PARENT: stale one-time id BUT recurring
        // markers + estimate provenance — the sold program's visit, so it
        // commits and the backfill retargets it (codex r19 P0 third pass).
        { id: 'v-legacy-parent', scheduled_date: '2026-11-20', service_type: 'Palm Injection', service_id: 'cat-palm-onetime', is_recurring: true, source_estimate_id: 'est-42', status: 'pending' },
        // FOREIGN identity (codex r26 pre-push P0): a name-matched row
        // carrying another service's id never counts as palm coverage even
        // with provenance + markers — the backfill cannot own it.
        { id: 'v-foreign', scheduled_date: '2027-05-01', service_type: 'Palm Injection', service_id: 'svc-something-else', is_recurring: true, source_estimate_id: 'est-42', status: 'pending' },
        // CONTRADICTORY identity (codex r27 pre-push P0): a foreign id
        // beats a semiannual snapshot — completion trusts the id, so
        // counting this row would suppress the other service's billing.
        { id: 'v-contradictory', scheduled_date: '2027-04-01', service_type: 'Palm Injection', service_id: 'svc-something-else', service_key_snapshot: 'palm_injection_semiannual', is_recurring: true, source_estimate_id: 'est-42', status: 'pending' },
      ],
    });
    const backfillUpdate = query({});
    const childInsert = query({ returning: [{ id: 'svc-p2', scheduled_date: '2026-12-15' }] });
    setDbQueues({
      scheduled_services: [columnQuery, rowsQuery, query({ first: undefined }), backfillUpdate, childInsert],
      services: [
        query({ first: { id: 'cat-palm-semi' } }),
        query({ first: { id: 'cat-palm-onetime' } }),
        query({ first: { id: 'cat-palm-semi', service_key: 'palm_injection_semiannual' } }),
        query({ first: { id: 'cat-palm-onetime', service_key: 'palm_injection' } }),
      ],
    });

    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-palm-mixed',
      customer_id: 'customer-palm',
      source_estimate_id: 'est-42',
      term_start: '2026-06-15',
      term_end: '2027-06-15',
      coverage_service_type: 'Palm Injection',
      coverage_visit_count: 2,
    }, undefined, { today: '2026-01-01' })).resolves.toMatchObject({
      createdCount: 0,
      existingCount: 2,
    });

    // The reserved visit AND the legacy stale-id parent are adopted and
    // backfilled; both one-time items (id-carrying and name-only) keep
    // their identity and separate billing.
    expect(backfillUpdate.whereIn).toHaveBeenCalledWith('id', ['v-reserved', 'v-legacy-parent']);
  });

  test('a visit linked to a DIFFERENT term never commits — stamps and estimates do not cross terms (codex r21 pre-push P0)', async () => {
    // Renewal boundary: the prior term's stamped visit sits inside the new
    // term's window. It must not be consumed as the new term's coverage.
    const colQ2 = query({
      columnInfo: {
        scheduled_date: {}, service_type: {}, service_id: {},
        service_key_snapshot: {}, annual_prepay_term_id: {}, is_recurring: {},
        recurring_pattern: {}, recurring_parent_id: {}, recurring_ongoing: {},
        technician_id: {}, window_start: {}, window_end: {}, time_window: {},
        customer_notes: {}, zone: {}, notes: {}, estimated_duration_minutes: {},
      },
    });
    const rowsQ = query({
      rows: [
        { id: 'v-prior-term', scheduled_date: '2026-06-20', service_type: 'Palm Injection', service_id: 'cat-palm-semi', annual_prepay_term_id: 'term-OLD', prepaid_amount: 100, prepaid_method: 'annual_prepay_invoice', is_recurring: true, status: 'pending' },
      ],
    });
    const p1 = query({ returning: [{ id: 'svc-t1', scheduled_date: '2026-06-15' }] });
    const c1 = query({ returning: [{ id: 'svc-t2', scheduled_date: '2026-12-15' }] });
    setDbQueues({
      scheduled_services: [colQ2, rowsQ, query({ first: undefined }), p1, c1],
      services: [
        query({ first: { id: 'cat-palm-semi' } }),
        query({ first: { id: 'cat-palm-onetime' } }),
        query({ first: { id: 'cat-palm-semi', service_key: 'palm_injection_semiannual' } }),
        query({ first: { id: 'cat-palm-onetime', service_key: 'palm_injection' } }),
      ],
    });
    // The identity-carrying row matches the FILTER via its recurring id,
    // but the tolerance matcher may still consume the 06-15 slot; the key
    // pin is commitment: rowCommittedToTerm(term-NEW, v-prior-term) is
    // false, so the slice prefers... assert via created visits: both sold
    // visits must exist for the NEW term (the prior-term visit covers at
    // most a slot by identity, never by commitment).
    const result = await _private.ensureCoverageRowsForTerm({
      id: 'term-NEW',
      customer_id: 'customer-palm',
      term_start: '2026-06-15',
      term_end: '2027-06-15',
      coverage_service_type: 'Palm Injection',
      coverage_visit_count: 2,
    }, undefined, { today: '2026-01-01' });
    // The other-term row is excluded even though it carries the recurring
    // identity — the new term seeds its FULL sold count.
    expect(result.existingCount).toBe(0);
    expect(result.createdCount).toBe(2);
  });

  test('a FAILED palm identity lookup rejects the refresh — never silently excludes id-carrying rows (codex r21 P0)', async () => {
    const throwingLookup = query({});
    throwingLookup.first = jest.fn(async () => { throw new Error('db down'); });
    const colQ = query({
      columnInfo: {
        scheduled_date: {}, service_type: {}, service_id: {},
        service_key_snapshot: {}, annual_prepay_term_id: {}, is_recurring: {},
        recurring_pattern: {}, recurring_parent_id: {}, recurring_ongoing: {},
        technician_id: {}, window_start: {}, window_end: {}, time_window: {},
        customer_notes: {}, zone: {}, notes: {}, estimated_duration_minutes: {},
      },
    });
    setDbQueues({
      scheduled_services: [colQ, query({ rows: [] })],
      services: [throwingLookup],
    });
    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-palm-dbdown',
      customer_id: 'customer-palm',
      term_start: '2026-06-15',
      term_end: '2027-06-15',
      coverage_service_type: 'Palm Injection',
      coverage_visit_count: 2,
    }, undefined, { today: '2026-01-01' })).rejects.toThrow('db down');
  });

  test('a LEGACY quarterly nutritional palm term seeds normally — never the injection deferral (codex r20 pre-push P0)', async () => {
    const columnQuery = query({
      columnInfo: {
        scheduled_date: {}, service_type: {}, service_id: {},
        service_key_snapshot: {}, annual_prepay_term_id: {},
        is_recurring: {}, recurring_pattern: {}, recurring_parent_id: {},
        recurring_ongoing: {}, technician_id: {}, window_start: {},
        window_end: {}, time_window: {}, customer_notes: {}, zone: {},
        notes: {}, estimated_duration_minutes: {},
      },
    });
    const parentInsert = query({ returning: [{ id: 'svc-n1', scheduled_date: '2026-06-15' }] });
    const childInserts = [
      query({ returning: [{ id: 'svc-n2', scheduled_date: '2026-09-15' }] }),
      query({ returning: [{ id: 'svc-n3', scheduled_date: '2026-12-15' }] }),
      query({ returning: [{ id: 'svc-n4', scheduled_date: '2027-03-15' }] }),
    ];
    setDbQueues({
      // NO services queue: the injection identity lookups must never run
      // for the nutritional program (the fake db throws on unqueued
      // tables, so this pins the exclusion).
      scheduled_services: [columnQuery, query({ rows: [] }), query({ first: undefined }), parentInsert, ...childInserts],
    });

    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-nutritional',
      customer_id: 'customer-nut',
      term_start: '2026-06-15',
      term_end: '2027-06-15',
      coverage_service_type: 'Palm Tree Nutritional Treatment',
      coverage_visit_count: 4,
    }, undefined, { today: '2026-01-01' })).resolves.toMatchObject({
      createdCount: 4,
    });

    // The bare historical 'Palm Treatment' label (codex r21 P0) is the
    // nutritional lane too — same untouched path.
    // scheduledServiceColumns is cached within the process — the second
    // run consumes no columnInfo entry.
    setDbQueues({
      scheduled_services: [
        query({ rows: [] }), query({ first: undefined }),
        query({ returning: [{ id: 'svc-l1', scheduled_date: '2026-06-15' }] }),
        query({ returning: [{ id: 'svc-l2', scheduled_date: '2026-09-15' }] }),
        query({ returning: [{ id: 'svc-l3', scheduled_date: '2026-12-15' }] }),
        query({ returning: [{ id: 'svc-l4', scheduled_date: '2027-03-15' }] }),
      ],
    });
    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-legacy-label',
      customer_id: 'customer-nut',
      term_start: '2026-06-15',
      term_end: '2027-06-15',
      coverage_service_type: 'Palm Treatment',
      coverage_visit_count: 4,
    }, undefined, { today: '2026-01-01' })).resolves.toMatchObject({
      createdCount: 4,
    });
  });

  test('palm coverage DEFERS (no visits, no term mutation) when the recurring catalog row is missing (codex r15/r17 pre-push)', async () => {
    const columnQuery = query({
      columnInfo: {
        scheduled_date: {}, service_type: {}, service_id: {},
        service_key_snapshot: {}, annual_prepay_term_id: {},
        is_recurring: {}, recurring_pattern: {}, recurring_parent_id: {},
        recurring_ongoing: {}, technician_id: {}, window_start: {},
        window_end: {}, time_window: {}, customer_notes: {}, zone: {},
        notes: {}, estimated_duration_minutes: {},
      },
    });
    setDbQueues({
      scheduled_services: [columnQuery, query({ rows: [] }), query({ first: undefined })],
      services: [query({ first: undefined }), query({ first: undefined }), query({ first: undefined })],
      notifications: [query({ first: undefined })],
    });

    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-palm-nocat',
      customer_id: 'customer-palm',
      term_start: '2026-06-15',
      term_end: '2027-06-15',
      coverage_service_type: 'Palm Injection',
      coverage_visit_count: 2,
    }, undefined, { today: '2026-01-01' })).resolves.toMatchObject({
      createdCount: 0,
      reason: 'palm_catalog_missing',
      // The deferral runs before any slide persists — it must expose the
      // AUTHORITATIVE term end, never an unpersisted extension (codex r18
      // pre-push P0).
      effectiveTermEnd: '2027-06-15',
    });
  });

  test('the palm catalog check runs BEFORE the term-end slide persists (codex r17 pre-push P1)', () => {
    // A deferred run must not extend the coverage window — repeated
    // deferrals would re-apply the payment lag on every refresh and
    // postpone renewal indefinitely.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../services/annual-prepay-renewals.js'), 'utf8');
    const palmCheck = src.indexOf("palm_injection_semiannual");
    const slidePersist = src.indexOf('// Persist the slid coverage window');
    expect(palmCheck).toBeGreaterThan(-1);
    expect(slidePersist).toBeGreaterThan(-1);
    expect(palmCheck).toBeLessThan(slidePersist);
    // And refreshTermSnapshot runs attach + prepaid stamping even on a
    // palm deferral (codex r18 pre-push P0, superseding the earlier
    // hard-stop): the prepaid stamp is the anti-double-bill mechanism —
    // an already-booked palm visit left unstamped would invoice at
    // completion after the prepay was collected. Identity stays
    // quarantined via the durable coverage exception.
    expect(src).not.toContain('palmDeferred');
    expect(src).toContain('Attach + prepaid stamping run even on a palm-identity DEFERRAL');
  });

  test('a palm term with a NON-semiannual coverage cadence defers with an exception — nothing seeds (codex r18 pre-push P1)', async () => {
    const columnQuery = query({
      columnInfo: {
        scheduled_date: {}, service_type: {}, service_id: {},
        service_key_snapshot: {}, annual_prepay_term_id: {},
        is_recurring: {}, recurring_pattern: {}, recurring_parent_id: {},
        recurring_ongoing: {}, technician_id: {}, window_start: {},
        window_end: {}, time_window: {}, customer_notes: {}, zone: {},
        notes: {}, estimated_duration_minutes: {},
      },
    });
    setDbQueues({
      scheduled_services: [columnQuery, query({ rows: [] }), query({ first: undefined })],
      services: [query({ first: undefined }), query({ first: undefined })],
      notifications: [query({ first: undefined })],
    });

    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-palm-badcadence',
      customer_id: 'customer-palm',
      term_start: '2026-06-15',
      term_end: '2027-06-15',
      coverage_service_type: 'Palm Injection',
      coverage_visit_count: 2,
      coverage_cadence: 'monthly',
    }, undefined, { today: '2026-01-01' })).resolves.toMatchObject({
      createdCount: 0,
      reason: 'palm_coverage_cadence_invalid',
      effectiveTermEnd: '2027-06-15',
    });
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

  test('a refresh clears the annual-prepay stamp and term link a callback picked up before the matcher excluded it', async () => {
    // Legacy state: a callback adopted into coverage before is_callback was
    // excluded still carries the term link and (if it was pending when the
    // term activated) a positive annual-prepay stamp. Left alone, the term
    // holds five allocations for four sold visits and the free callback
    // reads as prepaid. Every status is in scope — a callback's annual stamp
    // is never billing truth — but a cash/Zelle stamp is not ours to clear.
    const columnQuery = query({
      columnInfo: {
        status: {}, is_callback: {}, service_type: {}, service_key_snapshot: {}, prepaid_amount: {},
        prepaid_method: {}, prepaid_at: {}, prepaid_note: {}, annual_prepay_term_id: {}, updated_at: {},
      },
    });
    const stampClear = query({ rows: 1 });
    const unlink = query({ rows: 1 });
    setDbQueues({ scheduled_services: [columnQuery, stampClear, unlink] });

    const detached = await _private.detachCallbacksFromTerm({ id: 'term-1' }, db);

    expect(detached).toBe(1);
    expect(stampClear.where).toHaveBeenCalledWith({
      annual_prepay_term_id: 'term-1', prepaid_method: 'annual_prepay_invoice',
    });
    expect(stampClear.whereNotIn).not.toHaveBeenCalled();
    expect(stampClear.update).toHaveBeenCalledWith(expect.objectContaining({
      prepaid_amount: null, prepaid_method: null, prepaid_at: null, prepaid_note: null,
    }));
    expect(unlink.where).toHaveBeenCalledWith({ annual_prepay_term_id: 'term-1' });
    // Callback identity = the persisted flag OR the re-service label / catalog
    // key, so a legacy completed re-service (is_callback still false) detaches too.
    for (const q of [stampClear, unlink]) {
      expect(q.where).toHaveBeenCalledWith('is_callback', true);
      expect(q.orWhereRaw).toHaveBeenCalledWith('service_type ILIKE ?', ['%re-service%']);
      expect(q.orWhereIn).toHaveBeenCalledWith('service_key_snapshot', expect.arrayContaining(['pest_re_service', 'lawn_re_service']));
    }
    expect(unlink.update).toHaveBeenCalledWith(expect.objectContaining({ annual_prepay_term_id: null }));
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
      scheduled_services: [columnQuery, rowsQuery, query({ first: undefined }), insert1, insert2, insert3, insert4],
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
      scheduled_services: [columnQuery, rowsQuery, query({ first: undefined }), insert1, insert2],
    });

    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-9',
      customer_id: 'customer-9',
      term_start: '2026-06-15',
      term_end: '2027-06-15',
      coverage_service_type: 'Quarterly Pest Control',
      coverage_visit_count: 4,
    }, undefined, { today: '2026-01-01' })).resolves.toMatchObject({
      createdCount: 2,
      existingCount: 2,
    });

    expect(insert1.insert).toHaveBeenCalledWith(expect.objectContaining({ scheduled_date: '2026-12-15' }));
    expect(insert2.insert).toHaveBeenCalledWith(expect.objectContaining({ scheduled_date: '2027-03-15' }));
  });

  test('gives ONLY the first seeded visit the promised arrival window', async () => {
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
        estimated_duration_minutes: {},
        notes: {},
      },
    });
    const rowsQuery = query({ rows: [] });
    const lockedRecheck = query({ rows: [] }); // no concurrent same-day visit
    const conflictQuery = query({ rows: [] }); // board is clear at 08:00
    const first = query({ returning: [{ id: 'svc-w1', scheduled_date: '2026-08-01', window_start: '08:00' }] });
    const second = query({ returning: [{ id: 'svc-w2', scheduled_date: '2026-11-01' }] });
    setDbQueues({ scheduled_services: [columnQuery, rowsQuery, query({ first: undefined }), lockedRecheck, conflictQuery, first, second] });

    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-w',
      customer_id: 'customer-w',
      term_start: '2026-07-30',
      term_end: '2027-07-30',
      coverage_service_type: 'Quarterly Pest Control',
      coverage_visit_count: 2,
      coverage_cadence: 'quarterly',
      first_visit_date: '2026-08-01',
      first_visit_window_start: '08:00',
    }, undefined, { today: '2026-07-31' })).resolves.toMatchObject({
      createdCount: 2,
      targetDates: ['2026-08-01', '2026-11-01'],
    });

    // window_end is the 60-minute job block; the customer-facing 8:00-10:00
    // arrival window is derived from window_start at display time.
    expect(first.insert).toHaveBeenCalledWith(expect.objectContaining({
      scheduled_date: '2026-08-01',
      window_start: '08:00',
      window_end: '09:00',
    }));
    // Later placeholders stay windowless so dispatch can still route them.
    expect(second.insert).toHaveBeenCalledWith(expect.objectContaining({
      scheduled_date: '2026-11-01',
      window_start: null,
      window_end: null,
    }));
  });

  test('keeps the promised window when it overlaps at seeding time — overlaps are advisory', async () => {
    const columnQuery = query({
      columnInfo: {
        scheduled_date: {},
        service_type: {},
        annual_prepay_term_id: {},
        window_start: {},
        window_end: {},
        time_window: {},
        technician_id: {},
        estimated_duration_minutes: {},
        notes: {},
      },
    });
    const rowsQuery = query({ rows: [] });
    const lockedRecheck = query({ rows: [] }); // no concurrent same-day visit
    // The board moved between minting the invoice and paying it.
    const conflictQuery = query({ rows: [{ id: 'svc-other', window_start: '08:00', window_end: '09:00' }] });
    const seeded = query({ returning: [{ id: 'svc-x1', scheduled_date: '2026-08-01' }] });
    setDbQueues({ scheduled_services: [columnQuery, rowsQuery, query({ first: undefined }), lockedRecheck, conflictQuery, seeded] });

    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-x',
      customer_id: 'customer-x',
      term_start: '2026-08-01',
      term_end: '2027-08-01',
      coverage_service_type: 'Quarterly Pest Control',
      coverage_visit_count: 1,
      coverage_cadence: 'annual',
      first_visit_date: '2026-08-01',
      first_visit_window_start: '08:00',
    }, undefined, { today: '2026-07-31' })).resolves.toMatchObject({ createdCount: 1 });

    // Right date AND the promised time — an overlap warns, it never drops
    // the time the customer was quoted.
    expect(seeded.insert).toHaveBeenCalledWith(expect.objectContaining({
      scheduled_date: '2026-08-01',
      window_start: '08:00',
      window_end: '09:00',
    }));
  });

  test('seeds WITHOUT a window (and files window_unverified) when the date lock cannot be taken — an unprobed overlap is not kept', async () => {
    // The rung-1 occupancy date lock (first raw probe) loses to a concurrent
    // writer; later probes (customer-comms lock, rung 6) succeed.
    db.raw = jest.fn()
      .mockResolvedValueOnce({ rows: [{ locked: false }] })
      .mockResolvedValue({ rows: [{ locked: true }] });
    const columnQuery = query({
      columnInfo: {
        scheduled_date: {},
        service_type: {},
        annual_prepay_term_id: {},
        window_start: {},
        window_end: {},
        time_window: {},
        technician_id: {},
        estimated_duration_minutes: {},
        notes: {},
      },
    });
    const rowsQuery = query({ rows: [] });
    const unlockedRecheck = query({ rows: [] }); // post-failure adoption recheck
    const seeded = query({ returning: [{ id: 'svc-x2', scheduled_date: '2026-08-01' }] });
    setDbQueues({
      scheduled_services: [columnQuery, rowsQuery, query({ first: undefined }), unlockedRecheck, seeded],
      notifications: [query({ first: undefined })], // coverage-exception dedupe probe: none open
    });

    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-lock',
      customer_id: 'customer-x',
      term_start: '2026-08-01',
      term_end: '2027-08-01',
      coverage_service_type: 'Quarterly Pest Control',
      coverage_visit_count: 1,
      coverage_cadence: 'annual',
      first_visit_date: '2026-08-01',
      first_visit_window_start: '08:00',
    }, undefined, { today: '2026-07-31' })).resolves.toMatchObject({ createdCount: 1 });

    expect(seeded.insert).toHaveBeenCalledWith(expect.objectContaining({
      scheduled_date: '2026-08-01',
      window_start: null,
      window_end: null,
    }));
    const { notifyAdmin } = require('../services/notification-service');
    expect(notifyAdmin).toHaveBeenCalledWith(
      'alert', expect.any(String), expect.stringContaining('could not be checked'),
      expect.objectContaining({ metadata: expect.objectContaining({ reason: 'window_unverified' }) }),
    );
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
      scheduled_services: [columnQuery, rowsQuery, query({ first: undefined }), i1, i2, i3, i4],
    });

    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-7',
      customer_id: 'customer-7',
      term_start: '2026-06-15',
      term_end: '2027-06-15',
      coverage_service_type: 'Quarterly Pest Control',
      coverage_visit_count: 4,
    }, undefined, { today: '2026-01-01' })).resolves.toMatchObject({
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
      scheduled_services: [columnQuery, rowsQuery, query({ first: undefined }), i1, i2, i3],
    });

    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-5',
      customer_id: 'customer-5',
      term_start: '2026-01-01',
      term_end: '2026-12-31',
      coverage_service_type: 'Quarterly Pest Control',
      coverage_visit_count: 4,
    }, undefined, { today: '2026-01-01' })).resolves.toMatchObject({
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
        query({ first: undefined }),
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
    }, undefined, { today: '2026-01-01' })).resolves.toMatchObject({
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
        query({ first: undefined }),
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
    }, undefined, { today: '2026-01-01' })).resolves.toMatchObject({
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

  test('never generates a coverage visit before today', () => {
    // Term minted 2026-07-30, paid 2026-08-01: visit 1 must not land in the
    // past (2026-07 regression). The series shifts with the anchor so cadence
    // spacing is preserved.
    expect(_private.coverageScheduleDates(
      '2026-07-30',
      4,
      'quarterly',
      '2027-07-30',
      { notBefore: '2026-08-01' },
    )).toEqual(['2026-08-01', '2026-11-01', '2027-02-01', '2027-05-01']);

    // Anchor already in the future — untouched.
    expect(_private.coverageScheduleDates(
      '2026-07-30',
      4,
      'quarterly',
      '2027-07-30',
      { notBefore: '2026-07-01' },
    )).toEqual(['2026-07-30', '2026-10-30', '2027-01-30', '2027-04-30']);

    // No options at all = the pre-existing behavior, byte for byte.
    expect(_private.coverageScheduleDates('2026-07-30', 4, 'quarterly', '2027-07-30'))
      .toEqual(['2026-07-30', '2026-10-30', '2027-01-30', '2027-04-30']);
  });

  test('an operator-promised first visit anchors the coverage series', () => {
    expect(_private.coverageScheduleDates(
      '2026-07-30',
      4,
      'quarterly',
      '2027-07-30',
      { firstVisitDate: '2026-08-01', notBefore: '2026-07-30' },
    )).toEqual(['2026-08-01', '2026-11-01', '2027-02-01', '2027-05-01']);
  });

  test('a promised first visit that has already passed does NOT seed a past visit', () => {
    // The promise is honored only while it is still keepable. Payment landing
    // after the promised date must not recreate the past-dated visit this
    // whole change exists to prevent.
    expect(_private.coverageScheduleDates(
      '2026-07-30',
      4,
      'quarterly',
      '2027-07-30',
      { firstVisitDate: '2026-08-01', notBefore: '2026-08-05' },
    )).toEqual(['2026-08-05', '2026-11-05', '2027-02-05', '2027-05-05']);
  });

  test('a promised first target adopts only an exact-date visit, never a tolerance match', async () => {
    const columnQuery = query({
      columnInfo: {
        scheduled_date: {},
        service_type: {},
        annual_prepay_term_id: {},
        window_start: {},
        window_end: {},
        time_window: {},
        technician_id: {},
        estimated_duration_minutes: {},
        notes: {},
      },
    });
    // An unrelated existing route visit two weeks after the promised date —
    // inside the half-cadence tolerance that would normally consume the slot.
    const rowsQuery = query({
      rows: [
        { id: 'svc-route', customer_id: 'customer-p', scheduled_date: '2026-08-15', service_type: 'Quarterly Pest Control', status: 'pending' },
      ],
    });
    const seeded = query({ returning: [{ id: 'svc-p1', scheduled_date: '2026-08-01' }] });
    setDbQueues({ scheduled_services: [columnQuery, rowsQuery, query({ first: undefined }), seeded] });

    // 2 sold, 1 existing → 1 to seed. Without the exact-only rule the Aug-15
    // visit would absorb the Aug-01 promised slot and Nov-01 would seed instead.
    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-p',
      customer_id: 'customer-p',
      term_start: '2026-08-01',
      term_end: '2027-08-01',
      coverage_service_type: 'Quarterly Pest Control',
      coverage_visit_count: 2,
      coverage_cadence: 'quarterly',
      first_visit_date: '2026-08-01',
    }, undefined, { today: '2026-07-31' })).resolves.toMatchObject({ createdCount: 1 });

    expect(seeded.insert).toHaveBeenCalledWith(expect.objectContaining({
      scheduled_date: '2026-08-01',
    }));
  });

  test('an adopted promised-date visit is retimed to the promised window', async () => {
    const columnQuery = query({
      columnInfo: {
        scheduled_date: {},
        service_type: {},
        annual_prepay_term_id: {},
        window_start: {},
        window_end: {},
        time_window: {},
        window_display: {},
        technician_id: {},
        estimated_duration_minutes: {},
        notes: {},
      },
    });
    // The call-booked visit sits on the promised DATE but has no window, runs
    // 90 minutes, and carries a stale display label.
    const adopted = {
      id: 'svc-adopted',
      customer_id: 'customer-r',
      scheduled_date: '2026-08-01',
      service_type: 'Quarterly Pest Control',
      status: 'pending',
      window_start: null,
      recurring_dispatch_due_date: '2026-08-01',
      estimated_duration_minutes: 90,
      window_display: '10:00-11:30 AM',
    };
    const rowsQuery = query({ rows: [adopted] });
    const lockedReRead = query({ first: adopted }); // row unchanged under the lock
    const conflictQuery = query({ rows: [] }); // clear at 08:00 (row itself excluded)
    const retimeUpdate = query({});
    const laterSeed = query({ returning: [{ id: 'svc-r2', scheduled_date: '2026-11-01' }] });
    setDbQueues({ scheduled_services: [columnQuery, rowsQuery, query({ first: undefined }), lockedReRead, conflictQuery, retimeUpdate, laterSeed] });

    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-r',
      customer_id: 'customer-r',
      term_start: '2026-08-01',
      term_end: '2027-08-01',
      coverage_service_type: 'Quarterly Pest Control',
      coverage_visit_count: 2,
      coverage_cadence: 'quarterly',
      first_visit_date: '2026-08-01',
      first_visit_window_start: '08:00',
    }, undefined, { today: '2026-07-31' })).resolves.toMatchObject({ createdCount: 1 });

    // The adopted visit received the promised window with ITS OWN 90-minute
    // duration (08:00-09:30, not the seeder's 60-minute default), and the stale
    // display fields were cleared so every surface recomputes from window_start.
    expect(retimeUpdate.where).toHaveBeenCalledWith({ id: 'svc-adopted' });
    expect(retimeUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      window_start: '08:00',
      window_end: '09:30',
      recurring_dispatch_due_date: null,
      time_window: null,
      window_display: null,
    }));
    // The seeded LATER visit stays windowless — the promise applies to visit 1.
    expect(laterSeed.insert).toHaveBeenCalledWith(expect.objectContaining({
      scheduled_date: '2026-11-01',
      window_start: null,
    }));
  });

  test('a completed adopted visit is never retimed — history stays intact', async () => {
    const columnQuery = query({
      columnInfo: {
        scheduled_date: {},
        service_type: {},
        annual_prepay_term_id: {},
        window_start: {},
        window_end: {},
        time_window: {},
        window_display: {},
        technician_id: {},
        estimated_duration_minutes: {},
        notes: {},
      },
    });
    // Prepay collected at the completion appointment: the just-serviced row is
    // adopted for coverage but its recorded time must not be rewritten.
    const rowsQuery = query({
      rows: [{
        id: 'svc-done',
        customer_id: 'customer-c',
        scheduled_date: '2026-08-01',
        service_type: 'Quarterly Pest Control',
        status: 'completed',
        window_start: '10:00',
      }],
    });
    const laterSeed = query({ returning: [{ id: 'svc-c2', scheduled_date: '2026-11-01' }] });
    setDbQueues({ scheduled_services: [columnQuery, rowsQuery, query({ first: undefined }), laterSeed] });

    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-c',
      customer_id: 'customer-c',
      term_start: '2026-08-01',
      term_end: '2027-08-01',
      coverage_service_type: 'Quarterly Pest Control',
      coverage_visit_count: 2,
      coverage_cadence: 'quarterly',
      first_visit_date: '2026-08-01',
      first_visit_window_start: '08:00',
    }, undefined, { today: '2026-08-01', nowHHMM: '07:00' })).resolves.toMatchObject({ createdCount: 1 });

    // No update ran against the completed row — only the later seed inserted.
    expect(laterSeed.insert).toHaveBeenCalledWith(expect.objectContaining({ scheduled_date: '2026-11-01' }));
    expect(laterSeed.update).not.toHaveBeenCalled();
  });

  test('a promised hour that has already elapsed on the payment day seeds windowless', async () => {
    const columnQuery = query({
      columnInfo: {
        scheduled_date: {},
        service_type: {},
        annual_prepay_term_id: {},
        window_start: {},
        window_end: {},
        time_window: {},
        technician_id: {},
        estimated_duration_minutes: {},
        notes: {},
      },
    });
    const rowsQuery = query({ rows: [] });
    const seeded = query({ returning: [{ id: 'svc-e1', scheduled_date: '2026-08-01' }] });
    setDbQueues({ scheduled_services: [columnQuery, rowsQuery, query({ first: undefined }), seeded] });

    // Payment lands at 4 PM on the promised day; the 8 AM window is over.
    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-e',
      customer_id: 'customer-e',
      term_start: '2026-08-01',
      term_end: '2027-08-01',
      coverage_service_type: 'Quarterly Pest Control',
      coverage_visit_count: 1,
      coverage_cadence: 'annual',
      first_visit_date: '2026-08-01',
      first_visit_window_start: '08:00',
    }, undefined, { today: '2026-08-01', nowHHMM: '16:00' })).resolves.toMatchObject({ createdCount: 1 });

    expect(seeded.insert).toHaveBeenCalledWith(expect.objectContaining({
      scheduled_date: '2026-08-01',
      window_start: null,
      window_end: null,
    }));
  });

  test('a late payment slides the coverage window so all sold visits still fit', async () => {
    const columnQuery = query({
      columnInfo: {
        scheduled_date: {},
        service_type: {},
        annual_prepay_term_id: {},
        window_start: {},
        window_end: {},
        time_window: {},
        technician_id: {},
        estimated_duration_minutes: {},
        notes: {},
      },
    });
    const rowsQuery = query({ rows: [] });
    const inserts = [
      query({ returning: [{ id: 'svc-s1', scheduled_date: '2026-12-30' }] }),
      query({ returning: [{ id: 'svc-s2', scheduled_date: '2027-03-30' }] }),
      query({ returning: [{ id: 'svc-s3', scheduled_date: '2027-06-30' }] }),
      query({ returning: [{ id: 'svc-s4', scheduled_date: '2027-09-30' }] }),
    ];
    const termColsQuery = query({ columnInfo: { term_end: {}, first_visit_date: {} } });
    const successorQuery = query({ first: undefined }); // no later term to collide with
    const termSlideUpdate = query({});
    const termStampUpdate = query({});
    const refetchRows = query({ rows: [] }); // slid window still empty
    setDbQueues({
      scheduled_services: [columnQuery, rowsQuery, query({ first: undefined }), refetchRows, ...inserts],
      annual_prepay_terms: [termColsQuery, successorQuery, termSlideUpdate, termStampUpdate],
    });

    // Paid 5 months after mint: the customer bought 4 quarterly visits, so the
    // window slides by the lag instead of truncating the tail — the 4th visit
    // (2027-09-30, past the original 2027-07-30 end) still seeds and the term
    // row records the new end.
    const term = {
      id: 'term-s',
      customer_id: 'customer-s',
      term_start: '2026-07-30',
      term_end: '2027-07-30',
      coverage_service_type: 'Quarterly Pest Control',
      coverage_visit_count: 4,
      coverage_cadence: 'quarterly',
    };
    await expect(_private.ensureCoverageRowsForTerm(term, undefined, { today: '2026-12-30' }))
      .resolves.toMatchObject({
        createdCount: 4,
        targetDates: ['2026-12-30', '2027-03-30', '2027-06-30', '2027-09-30'],
      });

    expect(termSlideUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ term_end: '2027-12-30' }));
    // The in-memory term carries the slid end for the attach/stamp steps that
    // follow inside refreshTermSnapshot.
    expect(term.term_end).toBe('2027-12-30');
    expect(inserts[3].insert).toHaveBeenCalledWith(expect.objectContaining({ scheduled_date: '2027-09-30' }));
  });

  test('refreshing an already-activated term never slides the window again (idempotent)', async () => {
    const columnQuery = query({
      columnInfo: {
        scheduled_date: {},
        service_type: {},
        annual_prepay_term_id: {},
        window_start: {},
        window_end: {},
        time_window: {},
        technician_id: {},
        estimated_duration_minutes: {},
        notes: {},
      },
    });
    // The term activated months ago: its 4 coverage rows are LINKED. Today is
    // far past the first visit — an always-on floor would compute a fresh lag
    // and extend term_end on every schedule-edit refresh, forever.
    const linked = (id, date) => ({
      id,
      customer_id: 'customer-i',
      scheduled_date: date,
      service_type: 'Quarterly Pest Control',
      status: 'pending',
      annual_prepay_term_id: 'term-i',
    });
    const rowsQuery = query({
      rows: [
        linked('svc-i1', '2026-08-01'),
        linked('svc-i2', '2026-11-01'),
        linked('svc-i3', '2027-02-01'),
        linked('svc-i4', '2027-05-01'),
      ],
    });
    // NOTE: no annual_prepay_terms queue at all — any slide/stamp query would
    // throw "Unexpected db table" and fail this test.
    setDbQueues({ scheduled_services: [columnQuery, rowsQuery, query({ first: { id: 'svc-i1' } })] });

    await expect(_private.ensureCoverageRowsForTerm({
      id: 'term-i',
      customer_id: 'customer-i',
      term_start: '2026-08-01',
      term_end: '2027-08-01',
      coverage_service_type: 'Quarterly Pest Control',
      coverage_visit_count: 4,
      coverage_cadence: 'quarterly',
      first_visit_date: '2026-08-01',
    }, undefined, { today: '2027-03-15' })).resolves.toMatchObject({
      createdCount: 0,
      effectiveTermEnd: '2027-08-01',
    });
  });

  test('the effective first visit date prefers the promise, falling back to term start', () => {
    expect(_private.effectiveFirstVisitDate({ term_start: '2026-07-30', first_visit_date: '2026-08-01' }))
      .toBe('2026-08-01');
    expect(_private.effectiveFirstVisitDate({ term_start: '2026-07-30', first_visit_date: null }))
      .toBe('2026-07-30');
    expect(_private.effectiveFirstVisitDate({ term_start: '2026-07-30' })).toBe('2026-07-30');
  });

  test('the payment-day floor is inviolable — an unabsorbable lag truncates, never back-dates', () => {
    // Paid 5 months late: anchoring at the floor pushes visit 4 past term_end.
    // A past visit can never be serviced (and reminders skip it), so the floor
    // wins and the tail TRUNCATES — the seeder logs the shortfall for the
    // operator to extend the term or schedule the remainder manually.
    expect(_private.coverageScheduleDates(
      '2026-07-30',
      4,
      'quarterly',
      '2027-07-30',
      { notBefore: '2026-12-30' },
    )).toEqual(['2026-12-30', '2027-03-30', '2027-06-30']);
  });

  test('normalizes and offsets first-visit arrival times', () => {
    expect(_private.normalizeWindowStart('08:00')).toBe('08:00');
    expect(_private.normalizeWindowStart('8:00')).toBe('08:00');
    expect(_private.normalizeWindowStart('08:00:00')).toBe('08:00');
    expect(_private.normalizeWindowStart('')).toBeNull();
    expect(_private.normalizeWindowStart(null)).toBeNull();
    expect(_private.normalizeWindowStart('nope')).toBeNull();
    expect(_private.normalizeWindowStart('24:00')).toBeNull();
    // Appointment windows START ON THE HOUR (owner rule) — enforced in the
    // normalizer so the API and the UI's `step` can't disagree.
    expect(_private.normalizeWindowStart('08:30')).toBeNull();
    expect(_private.normalizeWindowStart('08:15')).toBeNull();
    expect(_private.normalizeWindowStart('08:60')).toBeNull();
    // window_end is the 60-minute job block, not the 2-hour customer promise.
    expect(_private.addMinutesHHMM('08:00', 60)).toBe('09:00');
    expect(_private.addMinutesHHMM('22:00', 60)).toBe('23:00');
    // window_end stays duration-driven: a block that would cross midnight is
    // rejected outright rather than shortened into a partial visit.
    expect(_private.addMinutesHHMM('23:00', 60)).toBeNull();
    expect(_private.addMinutesHHMM(null, 60)).toBeNull();
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

  // ---- termite annual plan: 45/30-day renewal-notice rung (slice 5, owner ruling §A2)

  test('a termite annual-plan term at 45 days out renders the termite SMS template with every variable, excludes the setup fee from renewal_fee, and stamps notice_45_sent_at only after the SMS actually sends', async () => {
    pinTermiteToday();
    const term = {
      id: 'term-1',
      customer_id: 'customer-1',
      status: 'active',
      term_start: '2026-05-20',
      term_end: '2027-05-20',
      annual_plan_version: 'v3',
      installation_anchored_at: '2026-05-20T00:00:00.000Z',
      // prepay_amount already excludes the one-time Station Setup fee
      // (estimate-converter.js subtracts annualPlanSetupFeeAmount before
      // it is ever written here) — renewal_fee must render this figure
      // untouched, never re-adding a setup amount.
      prepay_amount: 650,
      notice_45_sent_at: null,
      notice_45_claimed_at: null,
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
        query({ first: { id: 'customer-1', first_name: 'Stan', address_line1: '123 Bayshore Rd', city: 'Bradenton', email: 'stan@example.com', phone: '+19415550100' } }),
      ],
      customer_interactions: [query()],
    });
    CancellationResolution.cancelFlowV2Enabled.mockReturnValue(true);
    renderSmsTemplate.mockResolvedValue('rendered termite sms');
    sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted' });
    AccountMembershipEmail.sendTermiteRenewalReminder.mockResolvedValue({ ok: true });

    await expect(AnnualPrepayRenewals.sendCustomerTermNotice(term, 45)).resolves.toMatchObject({
      sent: true,
      termId: 'term-1',
    });

    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'termite_annual_renewal_notice',
      {
        first_name: 'Stan',
        address_short: '123 Bayshore Rd, Bradenton',
        renewal_date: _private.formatDateLabel('2027-05-20'),
        renewal_fee: '$650.00',
        cancel_link: 'https://portal.wavespestcontrol.com/?tab=plan',
      },
      expect.objectContaining({ workflow: 'termite_annual_renewal_notice', entity_id: 'term-1' }),
    );
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: '+19415550100',
      body: 'rendered termite sms',
      metadata: expect.objectContaining({ original_message_type: 'termite_annual_renewal_notice', annual_prepay_term_id: 'term-1', days_out: 45 }),
    }));
    expect(markNoticeQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      notice_45_sent_at: expect.any(Date),
      notice_45_claimed_at: null,
    }));
    // The email leg is a fire-and-forget companion send after a successful
    // SMS (`void sendRenewalEmail()`) — the call itself is synchronous even
    // though its own await isn't on this function's return path.
    expect(AccountMembershipEmail.sendTermiteRenewalReminder).toHaveBeenCalledWith({
      customerId: 'customer-1',
      termId: 'term-1',
      daysOut: 45,
      renewalDate: '2027-05-20',
      renewalFee: 650,
      // term_end is inclusive coverage: the successor starts the day after.
      // newEnd is +12mo SAME-DAY FROM newStart (2027-05-21), not from
      // term_end — matching createTermForAnnualPrepay's own default so the
      // notice and the successor slice 6b mints never disagree (Codex
      // #4921 r2 P2).
      newStart: '2027-05-21',
      newEnd: '2028-05-21',
      cancelLink: 'https://portal.wavespestcontrol.com/?tab=plan',
      // No source estimate → no plan property → the email falls back to
      // the customer's address.
      address: null,
      lastInspectionDate: null,
    });
  });

  // The 45-day witness depends on today vs term_end, so every termite
  // rung test pins the clock (Date only) instead of drifting into "late".
  function pinTermiteToday() {
    jest.useFakeTimers({
      now: new Date('2026-09-26T16:00:00Z'),
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'],
    });
  }
  afterEach(() => { jest.useRealTimers(); });

  // Shared harness for the witness-evidence cases below (Codex #4921 r1).
  function termiteNoticeHarness({ termEnd = '2027-05-20' } = {}) {
    const term = {
      id: 'term-1',
      customer_id: 'customer-1',
      status: 'active',
      term_start: '2026-05-20',
      term_end: termEnd,
      annual_plan_version: 'v3',
      installation_anchored_at: '2026-05-20T00:00:00.000Z',
      prepay_amount: 650,
      notice_45_sent_at: null,
      notice_45_claimed_at: null,
      notice_45_late_sent_at: null,
      renewal_decision: null,
    };
    const refreshedTerm = { ...term, last_scheduled_service_id: null, last_scheduled_service_date: null };
    const claimQuery = query({ returning: [{ ...refreshedTerm, status: 'renewal_pending' }] });
    const secondQuery = query();
    setDbQueues({
      scheduled_services: [query({ first: null }), query({ columnInfo: {} })],
      annual_prepay_terms: [query({ returning: [refreshedTerm] }), claimQuery, secondQuery],
      customers: [
        query({ first: { id: 'customer-1', first_name: 'Stan', address_line1: '123 Bayshore Rd', city: 'Bradenton', email: 'stan@example.com', phone: '+19415550100' } }),
      ],
      customer_interactions: [query()],
    });
    CancellationResolution.cancelFlowV2Enabled.mockReturnValue(true);
    renderSmsTemplate.mockResolvedValue('rendered termite sms');
    return { term, secondQuery };
  }

  // newEnd must be derived from newStart (term_end + 1 day), never from
  // term_end directly — createTermForAnnualPrepay defaults a fresh term's
  // end the same way (start + 12mo same-day), so the notice and the
  // successor slice 6b actually mints must never disagree (Codex #4921 r2
  // P2).
  test('newEnd derives from newStart across a Feb 28 term_end: newStart 2027-03-01, newEnd 2028-03-01 — NOT the term_end-anchored 2028-02-28', async () => {
    pinTermiteToday();
    const { term } = termiteNoticeHarness({ termEnd: '2027-02-28' });
    sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted' });
    AccountMembershipEmail.sendTermiteRenewalReminder.mockResolvedValue({ ok: true });

    await expect(AnnualPrepayRenewals.sendCustomerTermNotice(term, 45)).resolves.toMatchObject({ sent: true });

    expect(AccountMembershipEmail.sendTermiteRenewalReminder).toHaveBeenCalledWith(expect.objectContaining({
      newStart: '2027-03-01',
      newEnd: '2028-03-01',
    }));
  });

  test('newEnd derives from newStart across a month-end term_end: term_end 2027-04-30 → newStart 2027-05-01 → newEnd 2028-05-01', async () => {
    pinTermiteToday();
    const { term } = termiteNoticeHarness({ termEnd: '2027-04-30' });
    sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted' });
    AccountMembershipEmail.sendTermiteRenewalReminder.mockResolvedValue({ ok: true });

    await expect(AnnualPrepayRenewals.sendCustomerTermNotice(term, 45)).resolves.toMatchObject({ sent: true });

    expect(AccountMembershipEmail.sendTermiteRenewalReminder).toHaveBeenCalledWith(expect.objectContaining({
      newStart: '2027-05-01',
      newEnd: '2028-05-01',
    }));
  });

  test('an owner-silenced termite SMS (sent:true, deliveryOutcome not_sent) is NOT a witness — the email must confirm, else the claim is released', async () => {
    pinTermiteToday();
    const { term, secondQuery } = termiteNoticeHarness();
    sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'not_sent', providerMessageId: 'owner-silence' });
    AccountMembershipEmail.sendTermiteRenewalReminder.mockResolvedValue({ ok: false, reason: 'opted_out' });

    await expect(AnnualPrepayRenewals.sendCustomerTermNotice(term, 45)).resolves.toMatchObject({ sent: false, reason: 'sms_not_sent' });
    expect(secondQuery.update).toHaveBeenCalledWith(expect.objectContaining({ notice_45_claimed_at: null }));
    expect(secondQuery.update).not.toHaveBeenCalledWith(expect.objectContaining({ notice_45_sent_at: expect.anything() }));
  });

  test('an owner-silenced termite SMS with a confirmed email stamps the witness via email', async () => {
    pinTermiteToday();
    const { term, secondQuery } = termiteNoticeHarness();
    sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'not_sent', providerMessageId: 'owner-silence' });
    AccountMembershipEmail.sendTermiteRenewalReminder.mockResolvedValue({ ok: true });

    await expect(AnnualPrepayRenewals.sendCustomerTermNotice(term, 45)).resolves.toMatchObject({ sent: true, channel: 'email' });
    expect(secondQuery.update).toHaveBeenCalledWith(expect.objectContaining({ notice_45_sent_at: expect.any(Date), notice_45_claimed_at: null }));
  });

  test('an UNCERTAIN termite SMS with no confirmed email keeps its claim (never re-texted immediately) and records no witness', async () => {
    pinTermiteToday();
    const { term, secondQuery } = termiteNoticeHarness();
    sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'uncertain' });
    AccountMembershipEmail.sendTermiteRenewalReminder.mockResolvedValue({ ok: false });

    await expect(AnnualPrepayRenewals.sendCustomerTermNotice(term, 45)).resolves.toMatchObject({ sent: false, reason: 'sms_unknown' });
    expect(secondQuery.update).not.toHaveBeenCalled();
  });

  test('a termite SMS that returns sent:false with an UNCERTAIN handoff keeps its claim when the email also fails (never an immediate re-text)', async () => {
    pinTermiteToday();
    const { term, secondQuery } = termiteNoticeHarness();
    sendCustomerMessage.mockResolvedValue({ sent: false, deliveryOutcome: 'uncertain', code: 'PROVIDER_TIMEOUT' });
    AccountMembershipEmail.sendTermiteRenewalReminder.mockResolvedValue({ ok: false });

    await expect(AnnualPrepayRenewals.sendCustomerTermNotice(term, 45)).resolves.toMatchObject({ sent: false });
    expect(secondQuery.update).not.toHaveBeenCalled();
  });

  test('a LATE 45-day catch-up (under 45 days to term_end) goes to notice_45_late_sent_at, never the 45-day witness, and bells staff', async () => {
    pinTermiteToday();
    const { term, secondQuery } = termiteNoticeHarness({ termEnd: '2026-11-03' }); // 38 days out
    sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted' });
    AccountMembershipEmail.sendTermiteRenewalReminder.mockResolvedValue({ ok: true });

    await expect(AnnualPrepayRenewals.sendCustomerTermNotice(term, 45)).resolves.toMatchObject({ sent: true });
    expect(secondQuery.update).toHaveBeenCalledWith(expect.objectContaining({ notice_45_late_sent_at: expect.any(Date), notice_45_claimed_at: null }));
    expect(secondQuery.update).not.toHaveBeenCalledWith(expect.objectContaining({ notice_45_sent_at: expect.anything() }));
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
      'alert',
      'Termite annual renewal notice went out late',
      expect.any(String),
      expect.objectContaining({ bell: true, metadata: expect.objectContaining({ customerId: 'customer-1', reason: 'notice_45_late' }) }),
    );
  });

  describe('fileTermiteLateNoticeException — durable escalation (Codex #4921 r2 P1)', () => {
    test('a confirmed admin-bell insert stamps notice_45_late_escalated_at', async () => {
      const term = { id: 'term-late-1', customer_id: 'customer-1', term_end: '2027-05-20' };
      const updateQuery = query();
      setDbQueues({
        // annualPrepayColumns() columnInfo probe, then the escalation update.
        annual_prepay_terms: [query({ columnInfo: { notice_45_late_escalated_at: {} } }), updateQuery],
      });
      NotificationService.notifyAdmin.mockResolvedValue({ id: 'notif-late-1', deduped: false });

      await expect(_private.fileTermiteLateNoticeException(term, 45)).resolves.toBe(true);

      expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({ notice_45_late_escalated_at: expect.any(Date) }));
    });

    // notifyAdmin returns null on an INSERT failure rather than throwing
    // (notification-service.js) — the exact failure mode this escalation
    // column exists to survive. Nothing must be stamped, so the term stays
    // a candidate for termiteLateNoticeEscalationCandidates() on the next
    // sweep instead of being silently dropped.
    test('a failed admin-bell insert (notifyAdmin returns null) leaves the escalation unstamped and reports false, so the next sweep retries it', async () => {
      const term = { id: 'term-late-2', customer_id: 'customer-1', term_end: '2027-05-20' };
      // No further 'annual_prepay_terms' queue entries: the failure path
      // returns before ever probing annualPrepayColumns() or writing.
      setDbQueues({ annual_prepay_terms: [] });
      NotificationService.notifyAdmin.mockResolvedValue(null);

      await expect(_private.fileTermiteLateNoticeException(term, 45)).resolves.toBe(false);
    });

    test('notifyAdmin throwing is caught and also reports false (never crashes the sweep)', async () => {
      const term = { id: 'term-late-3', customer_id: 'customer-1', term_end: '2027-05-20' };
      setDbQueues({ annual_prepay_terms: [] });
      NotificationService.notifyAdmin.mockRejectedValue(new Error('db unavailable'));

      await expect(_private.fileTermiteLateNoticeException(term, 45)).resolves.toBe(false);
    });
  });

  test('the termite notice names the PLAN\'s property (source estimate), not a different billing address', async () => {
    pinTermiteToday();
    const term = {
      id: 'term-2',
      customer_id: 'customer-1',
      source_estimate_id: 'estimate-9',
      status: 'active',
      term_start: '2026-05-20',
      term_end: '2027-05-20',
      annual_plan_version: 'v3',
      installation_anchored_at: '2026-05-20T00:00:00.000Z',
      prepay_amount: 650,
      notice_45_sent_at: null,
      notice_45_claimed_at: null,
      renewal_decision: null,
    };
    const refreshedTerm = { ...term, last_scheduled_service_id: null, last_scheduled_service_date: null };
    setDbQueues({
      scheduled_services: [query({ first: null }), query({ columnInfo: {} })],
      annual_prepay_terms: [
        query({ returning: [refreshedTerm] }),
        query({ returning: [{ ...refreshedTerm, status: 'renewal_pending' }] }),
        query(),
      ],
      customers: [
        query({ first: { id: 'customer-1', first_name: 'Stan', address_line1: '1 Billing Way', city: 'Tampa', email: 'stan@example.com', phone: '+19415550100' } }),
      ],
      estimates: [
        query({ first: { property_id: 'property-9', address: '9 Palm Ave Fallback, Sarasota' } }),
      ],
      customer_properties: [
        query({ first: { address_line1: '9 Palm Ave', address_line2: null, city: 'Sarasota', state: 'FL', zip: '34236' } }),
      ],
      customer_interactions: [query()],
    });
    CancellationResolution.cancelFlowV2Enabled.mockReturnValue(true);
    renderSmsTemplate.mockResolvedValue('rendered termite sms');
    sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted' });
    AccountMembershipEmail.sendTermiteRenewalReminder.mockResolvedValue({ ok: true });

    await expect(AnnualPrepayRenewals.sendCustomerTermNotice(term, 45)).resolves.toMatchObject({ sent: true });
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'termite_annual_renewal_notice',
      expect.objectContaining({ address_short: '9 Palm Ave, Sarasota' }),
      expect.anything(),
    );
    expect(AccountMembershipEmail.sendTermiteRenewalReminder).toHaveBeenCalledWith(
      expect.objectContaining({ address: '9 Palm Ave, Sarasota, FL, 34236' }),
    );
  });

  // ---- Codex #4921 r4 P1: a plan-property lookup ERROR is not absence ----
  describe('planPropertyForTerm — errors propagate, only genuine absence falls back (Codex #4921 r4 P1)', () => {
    const throwingFirst = () => {
      const q = query();
      q.first = jest.fn(async () => { throw new Error('connection terminated'); });
      return q;
    };

    test('an ERROR reading the estimate rejects (never a silent null → customer address)', async () => {
      setDbQueues({ estimates: [throwingFirst()] });
      await expect(_private.planPropertyForTerm({ id: 't', source_estimate_id: 'est-1' })).rejects.toThrow('connection terminated');
    });

    test('an ERROR reading the linked property rejects too', async () => {
      setDbQueues({
        estimates: [query({ first: { property_id: 'prop-1', address: '9 Palm Ave' } })],
        customer_properties: [throwingFirst()],
      });
      await expect(_private.planPropertyForTerm({ id: 't', source_estimate_id: 'est-1' })).rejects.toThrow('connection terminated');
    });

    test('genuinely absent data still returns null (no estimate link, no estimate row, no property and no address)', async () => {
      setDbQueues({
        estimates: [query({ first: undefined }), query({ first: { property_id: 'prop-gone', address: null } })],
        customer_properties: [query({ first: undefined })],
      });
      await expect(_private.planPropertyForTerm({ id: 't' })).resolves.toBeNull();
      await expect(_private.planPropertyForTerm({ id: 't', source_estimate_id: 'est-missing' })).resolves.toBeNull();
      await expect(_private.planPropertyForTerm({ id: 't', source_estimate_id: 'est-2' })).resolves.toBeNull();
    });

    test('sendCustomerTermNotice aborts on a plan-property lookup error: nothing is sent, the claim is released, and the error surfaces for the sweep to log and retry', async () => {
      pinTermiteToday();
      const term = {
        id: 'term-err', customer_id: 'customer-1', source_estimate_id: 'estimate-9', status: 'active',
        term_start: '2026-05-20', term_end: '2027-05-20', annual_plan_version: 'v3',
        installation_anchored_at: '2026-05-20T00:00:00.000Z', prepay_amount: 650,
        notice_45_sent_at: null, notice_45_claimed_at: null, notice_45_late_sent_at: null, renewal_decision: null,
      };
      const refreshedTerm = { ...term, last_scheduled_service_id: null, last_scheduled_service_date: null };
      const releaseQuery = query();
      setDbQueues({
        scheduled_services: [query({ first: null }), query({ columnInfo: {} })],
        annual_prepay_terms: [
          query({ returning: [refreshedTerm] }),
          query({ returning: [{ ...refreshedTerm, status: 'renewal_pending' }] }),
          releaseQuery,
        ],
        customers: [query({ first: { id: 'customer-1', first_name: 'Stan', address_line1: '1 Billing Way', city: 'Tampa', phone: '+19415550100' } })],
        estimates: [throwingFirst()],
      });

      await expect(AnnualPrepayRenewals.sendCustomerTermNotice(term, 45)).rejects.toThrow('connection terminated');
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(AccountMembershipEmail.sendTermiteRenewalReminder).not.toHaveBeenCalled();
      expect(releaseQuery.update).toHaveBeenCalledWith(expect.objectContaining({ notice_45_claimed_at: null, status: 'active' }));
      expect(releaseQuery.update).not.toHaveBeenCalledWith(expect.objectContaining({ notice_45_sent_at: expect.anything() }));
    });
  });

  // ---- Codex #4921 r4 P1: a deduped email retry keeps its ORIGINAL time ----
  describe('on-time email acceptance survives a failed witness stamp (Codex #4921 r4 P1)', () => {
    const DAY45 = new Date('2026-09-26T16:00:00Z'); // term_end 2026-11-10 → exactly 45 days out (ET)
    const termFields = {
      id: 'term-dedupe', customer_id: 'customer-1', status: 'active', term_start: '2025-11-10', term_end: '2026-11-10',
      annual_plan_version: 'v3', installation_anchored_at: '2025-11-10T00:00:00.000Z', prepay_amount: 650,
      notice_45_sent_at: null, notice_45_claimed_at: null, notice_45_late_sent_at: null, renewal_decision: null,
    };
    const refreshed = { ...termFields, last_scheduled_service_id: null, last_scheduled_service_date: null };
    const customerRow = { id: 'customer-1', first_name: 'Stan', address_line1: '123 Bayshore Rd', city: 'Bradenton', phone: '+19415550100' };

    test('day 45: email accepted on time but the stamp transaction fails; day 44: the deduped retry still stamps notice_45_sent_at at the ORIGINAL time — never late, no late bell', async () => {
      pinTermiteToday();
      const stampQuery = query();
      setDbQueues({
        scheduled_services: [query({ first: null }), query({ columnInfo: {} }), query({ first: null })],
        annual_prepay_terms: [
          // day 45 (the failed stamp leaves the claim to its 15-minute TTL,
          // so tomorrow's sweep re-claims it)
          query({ returning: [refreshed] }),
          query({ returning: [{ ...refreshed, status: 'renewal_pending' }] }),
          // day 44
          query({ returning: [refreshed] }),
          query({ returning: [{ ...refreshed, status: 'renewal_pending' }] }),
          stampQuery,
        ],
        customers: [query({ first: customerRow }), query({ first: customerRow })],
      });
      renderSmsTemplate.mockResolvedValue('rendered termite sms');
      // SMS is definitively down both days; the email carries the notice.
      sendCustomerMessage.mockResolvedValue({ sent: false, code: 'PROVIDER_DOWN', deliveryOutcome: 'not_sent' });

      // Day 45: provider accepts the email, then the witness transaction fails.
      AccountMembershipEmail.sendTermiteRenewalReminder.mockResolvedValueOnce({ ok: true, messageId: 'sg-1' });
      db.transaction.mockImplementationOnce(async () => { throw new Error('stamp write failed'); });
      await expect(AnnualPrepayRenewals.sendCustomerTermNotice(termFields, 45)).rejects.toThrow('stamp write failed');

      // Day 44: the email layer dedupes against the day-45 acceptance.
      jest.setSystemTime(new Date('2026-09-27T16:00:00Z'));
      AccountMembershipEmail.sendTermiteRenewalReminder.mockResolvedValueOnce({
        ok: true, deduped: true, messageId: 'sg-1', sentAt: DAY45.toISOString(),
      });
      await expect(AnnualPrepayRenewals.sendCustomerTermNotice(termFields, 45)).resolves.toMatchObject({ sent: true, channel: 'email' });

      expect(stampQuery.update).toHaveBeenCalledWith(expect.objectContaining({ notice_45_sent_at: DAY45, notice_45_claimed_at: null }));
      expect(stampQuery.update).not.toHaveBeenCalledWith(expect.objectContaining({ notice_45_late_sent_at: expect.anything() }));
      expect(NotificationService.notifyAdmin).not.toHaveBeenCalledWith('alert', 'Termite annual renewal notice went out late', expect.anything(), expect.anything());
    });

    test('day 44 retry whose SMS is accepted: the email leg is awaited first and its deduped day-45 acceptance is the witness time (on time)', async () => {
      pinTermiteToday();
      jest.setSystemTime(new Date('2026-09-27T16:00:00Z'));
      const stampQuery = query();
      setDbQueues({
        scheduled_services: [query({ first: null }), query({ columnInfo: {} })],
        annual_prepay_terms: [
          query({ returning: [refreshed] }),
          query({ returning: [{ ...refreshed, status: 'renewal_pending' }] }),
          stampQuery,
        ],
        customers: [query({ first: customerRow })],
        customer_interactions: [query()],
      });
      renderSmsTemplate.mockResolvedValue('rendered termite sms');
      sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted' });
      AccountMembershipEmail.sendTermiteRenewalReminder.mockResolvedValue({
        ok: true, deduped: true, messageId: 'sg-1', sentAt: DAY45.toISOString(),
      });

      await expect(AnnualPrepayRenewals.sendCustomerTermNotice(termFields, 45)).resolves.toMatchObject({ sent: true });
      expect(AccountMembershipEmail.sendTermiteRenewalReminder).toHaveBeenCalledTimes(1); // not re-sent in the background
      expect(stampQuery.update).toHaveBeenCalledWith(expect.objectContaining({ notice_45_sent_at: DAY45 }));
      expect(stampQuery.update).not.toHaveBeenCalledWith(expect.objectContaining({ notice_45_late_sent_at: expect.anything() }));
    });

    test('with NO earlier acceptance, a day-44 send is still recorded late (the deduped time is the only thing trusted)', async () => {
      pinTermiteToday();
      jest.setSystemTime(new Date('2026-09-27T16:00:00Z'));
      const stampQuery = query();
      setDbQueues({
        scheduled_services: [query({ first: null }), query({ columnInfo: {} })],
        annual_prepay_terms: [
          query({ returning: [refreshed] }),
          query({ returning: [{ ...refreshed, status: 'renewal_pending' }] }),
          stampQuery,
        ],
        customers: [query({ first: customerRow })],
        customer_interactions: [query()],
      });
      renderSmsTemplate.mockResolvedValue('rendered termite sms');
      sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted' });
      // A fresh (non-deduped) send: any sentAt on it is ignored.
      AccountMembershipEmail.sendTermiteRenewalReminder.mockResolvedValue({ ok: true, messageId: 'sg-2', sentAt: DAY45.toISOString() });

      await expect(AnnualPrepayRenewals.sendCustomerTermNotice(termFields, 45)).resolves.toMatchObject({ sent: true });
      expect(stampQuery.update).toHaveBeenCalledWith(expect.objectContaining({ notice_45_late_sent_at: expect.any(Date) }));
      expect(stampQuery.update).not.toHaveBeenCalledWith(expect.objectContaining({ notice_45_sent_at: expect.anything() }));
    });

    test('originalEmailAcceptance trusts only a deduped, valid, non-future sentAt', () => {
      pinTermiteToday();
      expect(_private.originalEmailAcceptance({ ok: true, deduped: true, sentAt: '2026-09-26T14:00:00Z' })).toEqual(new Date('2026-09-26T14:00:00Z'));
      expect(_private.originalEmailAcceptance({ ok: true, deduped: true, sentAt: new Date('2026-09-25T10:00:00Z') })).toEqual(new Date('2026-09-25T10:00:00Z'));
      expect(_private.originalEmailAcceptance({ ok: true, sentAt: '2026-09-26T14:00:00Z' })).toBeNull();
      expect(_private.originalEmailAcceptance({ ok: true, deduped: true, sentAt: null })).toBeNull();
      expect(_private.originalEmailAcceptance({ ok: true, deduped: true, sentAt: 'not a date' })).toBeNull();
      expect(_private.originalEmailAcceptance({ ok: true, deduped: true, sentAt: '2026-09-28T00:00:00Z' })).toBeNull();
    });
  });

  // ---- Codex #4921 pre-push P1: recover persisted acceptance first ----
  describe('persisted acceptance is recovered before any re-send (Codex #4921 pre-push P1)', () => {
    const DAY45 = new Date('2026-09-26T16:00:00Z'); // term_end 2026-11-10 → exactly 45 days out (ET)
    const termFields = {
      id: 'term-recover', customer_id: 'customer-1', status: 'active', term_start: '2025-11-10', term_end: '2026-11-10',
      annual_plan_version: 'v3', installation_anchored_at: '2025-11-10T00:00:00.000Z', prepay_amount: 650,
      notice_45_sent_at: null, notice_45_claimed_at: null, notice_45_late_sent_at: null, renewal_decision: null,
    };
    const refreshed = { ...termFields, last_scheduled_service_id: null, last_scheduled_service_date: null };
    const customerRow = { id: 'customer-1', first_name: 'Stan', address_line1: '123 Bayshore Rd', city: 'Bradenton', phone: '+19415550100' };
    const lateBellCalls = () => NotificationService.notifyAdmin.mock.calls
      .filter((c) => c[1] === 'Termite annual renewal notice went out late');

    test('day 45: SMS accepted on time, the stamp fails; day 44: the persisted acceptance is recovered — notice_45_sent_at at the day-45 time, no second text, no email, no late bell', async () => {
      pinTermiteToday();
      const releaseQuery = query();
      const stampQuery = query();
      const auditProbe = query({ first: { sent_at: DAY45 } });
      setDbQueues({
        scheduled_services: [query({ first: null }), query({ columnInfo: {} }), query({ first: null })],
        annual_prepay_terms: [
          // day 45
          query({ returning: [refreshed] }),
          query({ returning: [{ ...refreshed, status: 'renewal_pending' }] }),
          releaseQuery,
          // day 44
          query({ returning: [refreshed] }),
          query({ returning: [{ ...refreshed, status: 'renewal_pending' }] }),
          stampQuery,
        ],
        customers: [query({ first: customerRow }), query({ first: customerRow })],
        // day 45: nothing accepted yet; day 44: the day-45 SMS is on file.
        messaging_audit_log: [query({ first: undefined }), auditProbe],
      });
      renderSmsTemplate.mockResolvedValue('rendered termite sms');
      sendCustomerMessage.mockResolvedValueOnce({ sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'a'.repeat(32)}` });
      db.transaction.mockImplementationOnce(async () => { throw new Error('stamp write failed'); });

      await expect(AnnualPrepayRenewals.sendCustomerTermNotice(termFields, 45)).rejects.toThrow('stamp write failed');
      expect(releaseQuery.update).toHaveBeenCalledWith(expect.objectContaining({ notice_45_claimed_at: null }));
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);

      jest.setSystemTime(new Date('2026-09-27T16:00:00Z'));
      AccountMembershipEmail.sendTermiteRenewalReminder.mockClear();
      await expect(AnnualPrepayRenewals.sendCustomerTermNotice(termFields, 45))
        .resolves.toMatchObject({ sent: true, channel: 'sms', recovered: true });

      expect(sendCustomerMessage).toHaveBeenCalledTimes(1); // never re-texted
      expect(AccountMembershipEmail.sendTermiteRenewalReminder).not.toHaveBeenCalled();
      expect(stampQuery.update).toHaveBeenCalledWith(expect.objectContaining({ notice_45_sent_at: DAY45, notice_45_claimed_at: null }));
      expect(stampQuery.update).not.toHaveBeenCalledWith(expect.objectContaining({ notice_45_late_sent_at: expect.anything() }));
      expect(lateBellCalls()).toHaveLength(0);
      // The probe is scoped to this customer, term and rung, accepted Twilio sends only.
      expect(auditProbe.where).toHaveBeenCalledWith({ customer_id: 'customer-1', channel: 'sms', provider: 'twilio' });
      expect(auditProbe.whereNull).toHaveBeenCalledWith('blocked_code');
      expect(auditProbe.whereRaw).toHaveBeenCalledWith("metadata->>'annual_prepay_term_id' = ?", ['term-recover']);
      expect(auditProbe.whereRaw).toHaveBeenCalledWith("metadata->>'days_out' = ?", ['45']);
      expect(auditProbe.whereRaw).toHaveBeenCalledWith("metadata->>'original_message_type' = ?", ['termite_annual_renewal_notice']);
      expect(auditProbe.orderBy).toHaveBeenCalledWith('sent_at', 'asc');
    });

    test('a recovered acceptance that was genuinely late is still stamped late (with its bell), from the ORIGINAL time', async () => {
      pinTermiteToday();
      jest.setSystemTime(new Date('2026-09-29T16:00:00Z'));
      const day44 = new Date('2026-09-27T16:00:00Z');
      const stampQuery = query();
      setDbQueues({
        scheduled_services: [query({ first: null }), query({ columnInfo: {} })],
        annual_prepay_terms: [
          query({ returning: [refreshed] }),
          query({ returning: [{ ...refreshed, status: 'renewal_pending' }] }),
          stampQuery,
        ],
        customers: [query({ first: customerRow })],
        messaging_audit_log: [query({ first: { sent_at: day44 } })],
      });

      await expect(AnnualPrepayRenewals.sendCustomerTermNotice(termFields, 45)).resolves.toMatchObject({ sent: true, recovered: true });
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(stampQuery.update).toHaveBeenCalledWith(expect.objectContaining({ notice_45_late_sent_at: day44 }));
      expect(lateBellCalls()).toHaveLength(1);
    });

    test('an already-accepted EMAIL (earlier than any SMS) is recovered the same way — witness at the email time, nothing sent', async () => {
      pinTermiteToday();
      jest.setSystemTime(new Date('2026-09-27T16:00:00Z'));
      const stampQuery = query();
      setDbQueues({
        scheduled_services: [query({ first: null }), query({ columnInfo: {} })],
        annual_prepay_terms: [
          query({ returning: [refreshed] }),
          query({ returning: [{ ...refreshed, status: 'renewal_pending' }] }),
          stampQuery,
        ],
        customers: [query({ first: customerRow })],
        messaging_audit_log: [query({ first: undefined })],
      });
      AccountMembershipEmail.findAcceptedTermiteRenewalReminder.mockResolvedValueOnce({ sentAt: DAY45.toISOString() });

      await expect(AnnualPrepayRenewals.sendCustomerTermNotice(termFields, 45))
        .resolves.toMatchObject({ sent: true, channel: 'email', recovered: true });
      expect(AccountMembershipEmail.findAcceptedTermiteRenewalReminder).toHaveBeenCalledWith({
        customerId: 'customer-1', termId: 'term-recover', daysOut: 45, renewalDate: '2026-11-10',
      });
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(AccountMembershipEmail.sendTermiteRenewalReminder).not.toHaveBeenCalled();
      expect(stampQuery.update).toHaveBeenCalledWith(expect.objectContaining({ notice_45_sent_at: DAY45 }));
    });

    test.each([
      ['the SMS audit lookup', 'sms'],
      ['the email lookup', 'email'],
    ])('a lookup ERROR in %s aborts: nothing is sent or stamped, the claim is released, and the error surfaces for a retry next run', async (_label, which) => {
      pinTermiteToday();
      jest.setSystemTime(new Date('2026-09-27T16:00:00Z'));
      const releaseQuery = query();
      const auditProbe = query();
      if (which === 'sms') auditProbe.first = jest.fn(async () => { throw new Error('audit read failed'); });
      else AccountMembershipEmail.findAcceptedTermiteRenewalReminder.mockRejectedValueOnce(new Error('email read failed'));
      setDbQueues({
        scheduled_services: [query({ first: null }), query({ columnInfo: {} })],
        annual_prepay_terms: [
          query({ returning: [refreshed] }),
          query({ returning: [{ ...refreshed, status: 'renewal_pending' }] }),
          releaseQuery,
        ],
        customers: [query({ first: customerRow })],
        messaging_audit_log: [auditProbe],
      });

      await expect(AnnualPrepayRenewals.sendCustomerTermNotice(termFields, 45)).rejects.toThrow(/read failed/);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(AccountMembershipEmail.sendTermiteRenewalReminder).not.toHaveBeenCalled();
      expect(releaseQuery.update).toHaveBeenCalledWith(expect.objectContaining({ notice_45_claimed_at: null, status: 'active' }));
      expect(releaseQuery.update).not.toHaveBeenCalledWith(expect.objectContaining({ notice_45_late_sent_at: expect.anything() }));
      expect(lateBellCalls()).toHaveLength(0);
    });

    test('with NO prior acceptance the normal send runs unchanged (a day-44 send is texted and recorded late)', async () => {
      pinTermiteToday();
      jest.setSystemTime(new Date('2026-09-27T16:00:00Z'));
      const stampQuery = query();
      setDbQueues({
        scheduled_services: [query({ first: null }), query({ columnInfo: {} })],
        annual_prepay_terms: [
          query({ returning: [refreshed] }),
          query({ returning: [{ ...refreshed, status: 'renewal_pending' }] }),
          stampQuery,
        ],
        customers: [query({ first: customerRow })],
        messaging_audit_log: [query({ first: undefined })],
        customer_interactions: [query()],
      });
      renderSmsTemplate.mockResolvedValue('rendered termite sms');
      sendCustomerMessage.mockResolvedValueOnce({ sent: true, deliveryOutcome: 'accepted' });
      AccountMembershipEmail.sendTermiteRenewalReminder.mockResolvedValueOnce({ ok: true });

      await expect(AnnualPrepayRenewals.sendCustomerTermNotice(termFields, 45)).resolves.toEqual({ sent: true, termId: 'term-recover' });
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      expect(stampQuery.update).toHaveBeenCalledWith(expect.objectContaining({ notice_45_late_sent_at: expect.any(Date) }));
    });

    test('priorTermiteNoticeAcceptance returns the EARLIEST of SMS and email, and ignores a future or invalid time', async () => {
      pinTermiteToday();
      const term = { id: 'term-recover', customer_id: 'customer-1', term_end: '2026-11-10' };
      setDbQueues({
        messaging_audit_log: [
          query({ first: { sent_at: new Date('2026-09-26T15:00:00Z') } }),
          query({ first: { sent_at: new Date('2026-09-26T15:00:00Z') } }),
          query({ first: { sent_at: new Date('2026-10-01T00:00:00Z') } }),
        ],
      });
      AccountMembershipEmail.findAcceptedTermiteRenewalReminder
        .mockResolvedValueOnce({ sentAt: '2026-09-26T14:00:00Z' })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ sentAt: 'garbage' });

      await expect(_private.priorTermiteNoticeAcceptance(term, 45)).resolves.toEqual({ channel: 'email', at: new Date('2026-09-26T14:00:00Z') });
      await expect(_private.priorTermiteNoticeAcceptance(term, 45)).resolves.toEqual({ channel: 'sms', at: new Date('2026-09-26T15:00:00Z') });
      await expect(_private.priorTermiteNoticeAcceptance(term, 45)).resolves.toBeNull();
    });
  });

  // ---- Codex #4921 r4 P1: undelivered past a rung's own deadline ----
  describe('undelivered-past-deadline escalation (Codex #4921 r4 P1)', () => {
    const TODAY = '2026-09-26';
    const plus = (n) => _private.addDaysYmd(TODAY, n);
    const base = { id: 'term-u', customer_id: 'customer-1', annual_plan_version: 'v3' };

    test('termiteUndeliveredRungs: the 45 rung the first day it is under 45 days out and undelivered; the 30 rung under 30; never on/before its deadline, once delivered or already escalated, or at term_end', () => {
      expect(_private.termiteUndeliveredRungs({ ...base, term_end: plus(45) }, TODAY)).toEqual([]);
      expect(_private.termiteUndeliveredRungs({ ...base, term_end: plus(44) }, TODAY)).toEqual([45]);
      expect(_private.termiteUndeliveredRungs({ ...base, term_end: plus(30) }, TODAY)).toEqual([45]);
      expect(_private.termiteUndeliveredRungs({ ...base, term_end: plus(29) }, TODAY)).toEqual([45, 30]);
      expect(_private.termiteUndeliveredRungs({ ...base, term_end: plus(29), notice_45_late_sent_at: new Date() }, TODAY)).toEqual([30]);
      expect(_private.termiteUndeliveredRungs({ ...base, term_end: plus(29), notice_45_sent_at: new Date() }, TODAY)).toEqual([30]);
      expect(_private.termiteUndeliveredRungs({ ...base, term_end: plus(29), notice_45_undelivered_escalated_at: new Date() }, TODAY)).toEqual([30]);
      expect(_private.termiteUndeliveredRungs({ ...base, term_end: plus(29), notice_30_undelivered_escalated_at: new Date() }, TODAY)).toEqual([45]);
      expect(_private.termiteUndeliveredRungs({ ...base, term_end: TODAY }, TODAY)).toEqual([]);
    });

    test('a confirmed bell stamps the rung\'s OWN undelivered column (45), keyed per term+rung, and never the late-escalation column', async () => {
      const updateQuery = query();
      setDbQueues({ annual_prepay_terms: [updateQuery] });
      NotificationService.notifyAdmin.mockResolvedValue({ id: 'notif-u45', deduped: false });

      await expect(_private.fileTermiteUndeliveredNoticeException({ ...base, term_end: plus(44) }, 45)).resolves.toBe(true);

      expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
        'alert',
        'Termite annual renewal notice not delivered',
        expect.stringContaining('45-day deadline has passed'),
        expect.objectContaining({
          bell: true,
          dedupeKey: 'termite-annual-notice:term-u:45:undelivered',
          metadata: expect.objectContaining({ reason: 'notice_45_undelivered', days_out: 45 }),
        }),
      );
      expect(updateQuery.whereNull).toHaveBeenCalledWith('notice_45_undelivered_escalated_at');
      expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({ notice_45_undelivered_escalated_at: expect.any(Date) }));
      expect(updateQuery.update).not.toHaveBeenCalledWith(expect.objectContaining({ notice_45_late_escalated_at: expect.anything() }));
    });

    test('the 30 rung stamps notice_30_undelivered_escalated_at', async () => {
      const updateQuery = query();
      setDbQueues({ annual_prepay_terms: [updateQuery] });
      NotificationService.notifyAdmin.mockResolvedValue({ id: 'notif-u30' });

      await expect(_private.fileTermiteUndeliveredNoticeException({ ...base, term_end: plus(20) }, 30)).resolves.toBe(true);
      expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
        'alert', 'Termite annual renewal notice not delivered', expect.any(String),
        expect.objectContaining({ dedupeKey: 'termite-annual-notice:term-u:30:undelivered' }),
      );
      expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({ notice_30_undelivered_escalated_at: expect.any(Date) }));
    });

    test('a failed bell insert (notifyAdmin null) or a throw stamps nothing and reports false, so the next sweep retries', async () => {
      setDbQueues({ annual_prepay_terms: [] });
      NotificationService.notifyAdmin.mockResolvedValueOnce(null);
      await expect(_private.fileTermiteUndeliveredNoticeException({ ...base, term_end: plus(44) }, 45)).resolves.toBe(false);
      NotificationService.notifyAdmin.mockRejectedValueOnce(new Error('db unavailable'));
      await expect(_private.fileTermiteUndeliveredNoticeException({ ...base, term_end: plus(44) }, 45)).resolves.toBe(false);
      await expect(_private.fileTermiteUndeliveredNoticeException({ ...base, term_end: plus(44) }, 15)).resolves.toBe(false);
    });
  });

  test('a termite annual-plan term whose SMS send fails does NOT stamp notice_45_sent_at when the email fallback also fails (provider-success-only witness)', async () => {
    const term = {
      id: 'term-1',
      customer_id: 'customer-1',
      status: 'active',
      term_start: '2026-05-20',
      term_end: '2027-05-20',
      annual_plan_version: 'v3',
      installation_anchored_at: '2026-05-20T00:00:00.000Z',
      prepay_amount: 650,
      notice_45_sent_at: null,
      notice_45_claimed_at: null,
      renewal_decision: null,
    };
    const refreshedTerm = { ...term, status: 'active', last_scheduled_service_id: null, last_scheduled_service_date: null };
    const claimQuery = query({ returning: [{ ...refreshedTerm, status: 'renewal_pending' }] });
    const releaseQuery = query();
    setDbQueues({
      scheduled_services: [query({ first: null }), query({ columnInfo: {} })],
      annual_prepay_terms: [
        query({ returning: [refreshedTerm] }),
        claimQuery,
        releaseQuery, // releaseClaim() on total failure
      ],
      customers: [
        query({ first: { id: 'customer-1', first_name: 'Stan', address_line1: '123 Bayshore Rd', city: 'Bradenton', phone: '+19415550100' } }),
      ],
    });
    CancellationResolution.cancelFlowV2Enabled.mockReturnValue(true);
    renderSmsTemplate.mockResolvedValue('rendered termite sms');
    sendCustomerMessage.mockResolvedValue({ sent: false, reason: 'blocked' });
    AccountMembershipEmail.sendTermiteRenewalReminder.mockResolvedValue({ ok: false, reason: 'email_opted_out' });

    await expect(AnnualPrepayRenewals.sendCustomerTermNotice(term, 45)).resolves.toMatchObject({
      sent: false,
      reason: 'blocked',
    });

    // No markNoticeSent call ever happened — only the claim-release update.
    expect(releaseQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      notice_45_claimed_at: null,
      status: 'active',
    }));
    expect(releaseQuery.update).not.toHaveBeenCalledWith(expect.objectContaining({ notice_45_sent_at: expect.anything() }));
  });

  test('a termite annual-plan term skips the 45-day rung and rings an admin bell (no send) when the portal cancel-request flow is off', async () => {
    const term = {
      id: 'term-1',
      customer_id: 'customer-1',
      status: 'active',
      term_start: '2026-05-20',
      term_end: '2027-05-20',
      annual_plan_version: 'v3',
      installation_anchored_at: '2026-05-20T00:00:00.000Z',
      prepay_amount: 650,
      notice_45_sent_at: null,
      notice_45_claimed_at: null,
      renewal_decision: null,
    };
    setDbQueues({
      scheduled_services: [query({ first: null }), query({ columnInfo: {} })],
      annual_prepay_terms: [query({ returning: [{ ...term, last_scheduled_service_id: null, last_scheduled_service_date: null }] })],
      notifications: [query({ first: undefined })], // dedupe probe: no open alert yet
    });
    CancellationResolution.cancelFlowV2Enabled.mockReturnValue(false);
    NotificationService.notifyAdmin.mockClear();

    await expect(AnnualPrepayRenewals.sendCustomerTermNotice(term, 45)).resolves.toMatchObject({
      sent: false,
      reason: 'cancel_flow_disabled',
    });

    expect(renderSmsTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(AccountMembershipEmail.sendTermiteRenewalReminder).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
      'alert',
      expect.stringMatching(/cancel flow is off/i),
      expect.stringContaining('term-1'),
      expect.objectContaining({ metadata: expect.objectContaining({ reason: 'cancel_flow_disabled', days_out: 45, annual_prepay_term_id: 'term-1' }) }),
    );
  });

  // An ORIGINAL termite term still awaiting its installation anchor
  // (coverageAwaitsInstallation) must never get a renewal notice — its
  // term_end is only a provisional placeholder, and a notice would let
  // claimTermNotice flip an 'active' term to renewal_pending, which the
  // installation sweep's ANCHORABLE_TERM_STATUSES (payment_pending/active
  // only) would then never anchor (Codex #4921 r2 P1).
  test('a termite annual-plan term still awaiting installation skips EVERY rung (not just 45/30) and rings an admin bell instead', async () => {
    const term = {
      id: 'term-1',
      customer_id: 'customer-1',
      status: 'active',
      term_start: '2026-05-20',
      term_end: '2027-05-20',
      annual_plan_version: 'v3',
      renewed_from_term_id: null,
      installation_anchored_at: null, // never anchored — installation hasn't happened
      prepay_amount: 650,
      notice_45_sent_at: null,
      notice_45_claimed_at: null,
      renewal_decision: null,
    };
    setDbQueues({
      scheduled_services: [query({ first: null }), query({ columnInfo: {} })],
      annual_prepay_terms: [query({ returning: [{ ...term, last_scheduled_service_id: null, last_scheduled_service_date: null }] })],
      notifications: [query({ first: undefined })], // dedupe probe: no open alert yet
    });
    NotificationService.notifyAdmin.mockClear();

    // Even a 15-day (generic-copy) rung is blocked — the guard is not
    // limited to the termite-copy days (45/30).
    await expect(AnnualPrepayRenewals.sendCustomerTermNotice(term, 15)).resolves.toMatchObject({
      sent: false,
      reason: 'awaiting_installation',
    });

    expect(renderSmsTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
      'alert',
      expect.stringMatching(/installation never completed/i),
      expect.stringContaining('term-1'),
      expect.objectContaining({ bell: true, metadata: expect.objectContaining({ reason: 'awaiting_installation', days_out: 15, annual_prepay_term_id: 'term-1' }) }),
    );
  });

  describe('termiteNoticePreflight — the awaiting-installation guard directly (unit-level, every rung)', () => {
    beforeEach(() => {
      setDbQueues({ notifications: [query({ first: undefined }), query({ first: undefined }), query({ first: undefined }), query({ first: undefined })] });
      NotificationService.notifyAdmin.mockClear();
    });

    test('blocks 45, 30, 15, AND 7 alike for an unanchored original', async () => {
      const term = {
        id: 'term-await', customer_id: 'customer-await', annual_plan_version: 'v3',
        renewed_from_term_id: null, installation_anchored_at: null, term_end: '2027-05-20', prepay_amount: 650,
      };
      for (const daysOut of [45, 30, 15, 7]) {
        await expect(_private.termiteNoticePreflight(term, daysOut)).resolves.toEqual({ blocked: 'awaiting_installation' });
      }
      expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(4);
    });

    test('does NOT block a renewal successor (renewed_from_term_id set) — it is not "awaiting installation"', async () => {
      const term = {
        id: 'term-successor', customer_id: 'customer-1', annual_plan_version: 'v3',
        renewed_from_term_id: 'term-original', installation_anchored_at: null, term_end: '2027-05-20', prepay_amount: 650,
      };
      await expect(_private.termiteNoticePreflight(term, 15)).resolves.toEqual({ termiteRung: false });
      expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    });

    test('does NOT block an already-anchored original', async () => {
      const term = {
        id: 'term-anchored', customer_id: 'customer-1', annual_plan_version: 'v3',
        renewed_from_term_id: null, installation_anchored_at: '2026-05-20T00:00:00.000Z', term_end: '2027-05-20', prepay_amount: 650,
      };
      CancellationResolution.cancelFlowV2Enabled.mockReturnValue(true);
      await expect(_private.termiteNoticePreflight(term, 45)).resolves.toEqual({ termiteRung: true });
      expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    });
  });

  test('a 45-day rung is refused outright for a non-termite term even when called directly', async () => {
    const term = {
      id: 'term-1',
      customer_id: 'customer-1',
      status: 'active',
      term_start: '2026-05-20',
      term_end: '2027-05-20',
      annual_plan_version: null,
      notice_45_sent_at: null,
      notice_45_claimed_at: null,
      renewal_decision: null,
    };
    // refreshTermSnapshot runs on the passed-in object with no coverage
    // config, so it makes exactly its usual two scheduled_services calls
    // and one annual_prepay_terms update — the not-termite guard trips
    // immediately after, before any claim is attempted.
    setDbQueues({
      scheduled_services: [query({ first: null }), query({ columnInfo: {} })],
      annual_prepay_terms: [query({ returning: [{ ...term, last_scheduled_service_id: null, last_scheduled_service_date: null }] })],
    });

    await expect(AnnualPrepayRenewals.sendCustomerTermNotice(term, 45)).resolves.toEqual({
      sent: false,
      reason: 'not_termite_plan',
    });
  });

  test('a termite annual-plan term at 15 days out still uses the generic reminder template and email, not the termite copy', async () => {
    const term = {
      id: 'term-1',
      customer_id: 'customer-1',
      status: 'active',
      term_start: '2026-05-20',
      term_end: '2026-11-05',
      annual_plan_version: 'v3',
      installation_anchored_at: '2026-05-20T00:00:00.000Z',
      prepay_amount: 650,
      notice_15_sent_at: null,
      notice_15_claimed_at: null,
      renewal_decision: null,
    };
    const refreshedTerm = { ...term, status: 'active', last_scheduled_service_id: null, last_scheduled_service_date: null };
    const claimQuery = query({ returning: [{ ...refreshedTerm, status: 'renewal_pending' }] });
    const markNoticeQuery = query();
    setDbQueues({
      scheduled_services: [query({ first: null }), query({ columnInfo: {} })],
      annual_prepay_terms: [
        query({ returning: [refreshedTerm] }),
        claimQuery,
        markNoticeQuery,
      ],
      customers: [
        query({ first: { id: 'customer-1', first_name: 'Stan', phone: '+19415550100' } }),
      ],
      customer_interactions: [query()],
    });
    renderSmsTemplate.mockResolvedValue('rendered generic sms');
    sendCustomerMessage.mockResolvedValue({ sent: true });
    AccountMembershipEmail.sendMembershipRenewalReminder.mockResolvedValue({ ok: true });

    await expect(AnnualPrepayRenewals.sendCustomerTermNotice(term, 15)).resolves.toMatchObject({ sent: true, termId: 'term-1' });

    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'annual_prepay_renewal_reminder',
      expect.objectContaining({ first_name: 'Stan' }),
      expect.objectContaining({ workflow: 'annual_prepay_renewal_reminder' }),
    );
    expect(AccountMembershipEmail.sendTermiteRenewalReminder).not.toHaveBeenCalled();
    expect(markNoticeQuery.update).toHaveBeenCalledWith(expect.objectContaining({ notice_15_sent_at: expect.any(Date) }));
  });

  // Real bug found while verifying this slice: formatCurrencyLabel's
  // Number(amount || 0) fallback rendered a live "$0.00" renewal-fee SMS for
  // a termite term with no prepay_amount recorded (confirmed via a probe
  // before the fix: renderSmsTemplate was called with renewal_fee: '$0.00'
  // and the SMS actually sent). Fixed by failing closed the same way the
  // cancel-flow-off branch does: skip the rung + admin bell, never a
  // fabricated dollar amount.
  test('a termite annual-plan term with a NULL prepay_amount skips the rung and rings an admin bell instead of sending a fabricated "$0.00" renewal fee', async () => {
    const term = {
      id: 'term-1',
      customer_id: 'customer-1',
      status: 'active',
      term_start: '2026-05-20',
      term_end: '2027-05-20',
      annual_plan_version: 'v3',
      installation_anchored_at: '2026-05-20T00:00:00.000Z',
      prepay_amount: null,
      notice_45_sent_at: null,
      notice_45_claimed_at: null,
      renewal_decision: null,
    };
    setDbQueues({
      scheduled_services: [query({ first: null }), query({ columnInfo: {} })],
      annual_prepay_terms: [query({ returning: [{ ...term, last_scheduled_service_id: null, last_scheduled_service_date: null }] })],
      notifications: [query({ first: undefined })], // dedupe probe: no open alert yet
    });
    CancellationResolution.cancelFlowV2Enabled.mockReturnValue(true);
    NotificationService.notifyAdmin.mockClear();

    await expect(AnnualPrepayRenewals.sendCustomerTermNotice(term, 45)).resolves.toMatchObject({
      sent: false,
      reason: 'missing_prepay_amount',
    });

    expect(renderSmsTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(AccountMembershipEmail.sendTermiteRenewalReminder).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
      'alert',
      expect.stringMatching(/no renewal fee on file/i),
      expect.stringContaining('term-1'),
      expect.objectContaining({ metadata: expect.objectContaining({ reason: 'missing_prepay_amount', days_out: 45, annual_prepay_term_id: 'term-1' }) }),
    );
  });

  test('a termite annual-plan term with prepay_amount 0 (a genuine zero-fee term, distinct from NULL) still renders "$0.00" and sends — only a missing amount fails closed', async () => {
    pinTermiteToday();
    const term = {
      id: 'term-1',
      customer_id: 'customer-1',
      status: 'active',
      term_start: '2026-05-20',
      term_end: '2027-05-20',
      annual_plan_version: 'v3',
      installation_anchored_at: '2026-05-20T00:00:00.000Z',
      prepay_amount: 0,
      notice_45_sent_at: null,
      notice_45_claimed_at: null,
      renewal_decision: null,
    };
    const refreshedTerm = { ...term, status: 'active', last_scheduled_service_id: null, last_scheduled_service_date: null };
    const claimQuery = query({ returning: [{ ...refreshedTerm, status: 'renewal_pending' }] });
    const markNoticeQuery = query();
    setDbQueues({
      scheduled_services: [query({ first: null }), query({ columnInfo: {} })],
      annual_prepay_terms: [
        query({ returning: [refreshedTerm] }),
        claimQuery,
        markNoticeQuery,
      ],
      customers: [
        query({ first: { id: 'customer-1', first_name: 'Stan', address_line1: '123 Bayshore Rd', city: 'Bradenton', phone: '+19415550100' } }),
      ],
      customer_interactions: [query()],
    });
    CancellationResolution.cancelFlowV2Enabled.mockReturnValue(true);
    renderSmsTemplate.mockResolvedValue('rendered termite sms');
    sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted' });
    AccountMembershipEmail.sendTermiteRenewalReminder.mockResolvedValue({ ok: true });

    await expect(AnnualPrepayRenewals.sendCustomerTermNotice(term, 45)).resolves.toMatchObject({ sent: true });
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'termite_annual_renewal_notice',
      expect.objectContaining({ renewal_fee: '$0.00' }),
      expect.anything(),
    );
  });

  // ---- termite annual plan: coverage waits for the installation (codex #4819 r6 P1)

  const TERMITE_COVERAGE_COLUMNS = {
    scheduled_date: {}, service_type: {}, annual_prepay_term_id: {},
    is_recurring: {}, recurring_pattern: {}, recurring_parent_id: {},
    recurring_ongoing: {}, technician_id: {}, window_start: {},
    window_end: {}, time_window: {}, customer_notes: {}, zone: {},
    notes: {}, estimated_duration_minutes: {},
  };
  const termiteTerm = (overrides = {}) => ({
    id: 'term-termite',
    customer_id: 'customer-termite',
    source_estimate_id: 'est-termite',
    term_start: '2026-09-25',
    term_end: '2027-09-25',
    coverage_service_type: 'Termite Bait',
    coverage_visit_count: 1,
    coverage_cadence: 'annual',
    annual_plan_version: 'v3',
    renewed_from_term_id: null,
    installation_anchored_at: null,
    installation_anchor_visit_id: null,
    ...overrides,
  });

  test('a PAID termite annual term seeds NOTHING before its installation anchors — no db access at all', async () => {
    // No queues: any table access throws.
    setDbQueues({});
    await expect(_private.ensureCoverageRowsForTerm(termiteTerm(), undefined, { today: '2026-09-25' }))
      .resolves.toEqual({
        createdCount: 0, targetDates: [], effectiveTermEnd: '2027-09-25', reason: 'awaiting_installation',
      });
  });

  test('the termite installation deferral holds through refreshTermSnapshot for an ACTIVE (paid) term: attach runs, nothing is inserted', async () => {
    const insertQuery = query({ returning: [{ id: 'never' }] });
    setDbQueues({
      annual_prepay_terms: [query({ first: termiteTerm({ status: 'active' }) }), query({ returning: [termiteTerm({ status: 'active' })] })],
      scheduled_services: [
        query({ columnInfo: TERMITE_COVERAGE_COLUMNS }),
        // detachCallbacksFromTerm + attach/stamp read in-window rows — none.
        ...Array.from({ length: 6 }, () => query({ rows: [] })),
        insertQuery,
      ],
    });
    await AnnualPrepayRenewals.refreshTermSnapshot('term-termite');
    expect(insertQuery.insert).not.toHaveBeenCalled();
  });

  test('codex #4819 r7 P1: a term CREATED with annualPlanVersion carries the marker into its first refresh — no signature-day visit is seeded', async () => {
    const termInsert = query({ returning: [termiteTerm({ status: 'payment_pending' })] });
    const seedInsert = query({ returning: [{ id: 'never' }] });
    setDbQueues({
      annual_prepay_terms: [
        query({ columnInfo: { annual_plan_version: {}, coverage_service_type: {}, coverage_visit_count: {}, coverage_cadence: {} } }),
        query({ first: undefined }), // existing lookup by source estimate
        query({ first: undefined }), // existing lookup by customer + window
        termInsert,
        query({ first: termiteTerm({ status: 'payment_pending' }) }), // refreshTermSnapshot term read
        query({ returning: [termiteTerm({ status: 'payment_pending' })] }),
      ],
      scheduled_services: [
        query({ columnInfo: TERMITE_COVERAGE_COLUMNS }),
        ...Array.from({ length: 6 }, () => query({ rows: [] })),
        seedInsert,
      ],
    });

    await AnnualPrepayRenewals.createTermForAnnualPrepay({
      customerId: 'customer-termite',
      sourceEstimateId: 'est-termite',
      termStart: '2026-09-25',
      coverageServiceType: 'Termite Bait',
      coverageVisitCount: 1,
      coverageCadence: 'annual',
      annualPlanVersion: 'v3',
    });

    expect(termInsert.insert).toHaveBeenCalledWith(expect.objectContaining({ annual_plan_version: 'v3' }));
    expect(seedInsert.insert).not.toHaveBeenCalled();
  });

  test('renewal successors and unstamped terms are never deferred — they reach the seeding path', async () => {
    const run = (t) => _private.ensureCoverageRowsForTerm(t, undefined, { today: '2026-01-01' });
    for (const term of [termiteTerm({ renewed_from_term_id: 'term-prior' }), termiteTerm({ annual_plan_version: null })]) {
      _private.resetCachesForTests();
      const insertQuery = query({ returning: [{ id: 'svc-seeded', scheduled_date: term.term_start }] });
      setDbQueues({
        scheduled_services: [query({ columnInfo: TERMITE_COVERAGE_COLUMNS }), query({ rows: [] }), query({ first: undefined }), insertQuery],
      });
      await expect(run(term)).resolves.toMatchObject({ createdCount: 1 });
    }
  });

  test('once anchored, the installation visit itself is the coverage year\'s visit — even under an installation label — and the anchored window never slides', async () => {
    const installRow = {
      id: 'v-install',
      customer_id: 'customer-termite',
      scheduled_date: '2026-10-14',
      service_type: 'Termite Station Install',
      status: 'completed',
    };
    const insertQuery = query({ returning: [{ id: 'never' }] });
    setDbQueues({
      scheduled_services: [
        query({ columnInfo: TERMITE_COVERAGE_COLUMNS }),
        query({ rows: [installRow] }),
        query({ first: undefined }), // no row linked to the term yet
        insertQuery,
      ],
      // No annual_prepay_terms queue: a term_end slide write would throw.
    });
    const result = await _private.ensureCoverageRowsForTerm(termiteTerm({
      term_start: '2026-10-14',
      term_end: '2027-10-14',
      installation_anchored_at: new Date('2026-10-15T10:10:00Z'),
      installation_anchor_visit_id: 'v-install',
    }), undefined, { today: '2026-10-15' });

    expect(result).toMatchObject({ createdCount: 0, existingCount: 1, effectiveTermEnd: '2027-10-14' });
    expect(insertQuery.insert).not.toHaveBeenCalled();
  });

  test('once anchored, a term with no installation row in its window seeds its visit inside the anchored window (never past-dated, never slid)', async () => {
    const insertQuery = query({ returning: [{ id: 'svc-seeded', scheduled_date: '2026-10-20' }] });
    setDbQueues({
      scheduled_services: [
        query({ columnInfo: TERMITE_COVERAGE_COLUMNS }),
        query({ rows: [] }),
        query({ first: undefined }),
        insertQuery,
      ],
    });
    const result = await _private.ensureCoverageRowsForTerm(termiteTerm({
      term_start: '2026-10-14',
      term_end: '2027-10-14',
      installation_anchored_at: new Date('2026-10-20T10:10:00Z'),
      installation_anchor_visit_id: 'v-gone',
    }), undefined, { today: '2026-10-20' });

    expect(result).toMatchObject({ createdCount: 1, targetDates: ['2026-10-20'], effectiveTermEnd: '2027-10-14' });
    expect(insertQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
      scheduled_date: '2026-10-20', service_type: 'Termite Bait', annual_prepay_term_id: 'term-termite',
    }));
  });

  // ---- termite annual plan: unified 45/30 notice-obligation pass (Codex #4921 r3 structural fix)

  describe('termiteRungDue — pure due/retry logic', () => {
    const termiteTermFor = (termEnd) => ({ term_end: termEnd, annual_plan_version: 'v3' });

    test('45-day rung: due from term_end-45 through term_end, false once sent/late, false before the window opens', () => {
      const term = termiteTermFor('2026-11-10');
      expect(_private.termiteRungDue(term, 45, '2026-09-20')).toBe(false); // 51 days out — not open yet
      expect(_private.termiteRungDue(term, 45, '2026-09-26')).toBe(true); // exactly 45 days out
      expect(_private.termiteRungDue(term, 45, '2026-09-27')).toBe(true); // 44 days out — retried daily, never dropped
      expect(_private.termiteRungDue(term, 45, '2026-11-09')).toBe(true); // 1 day out — still due if never sent
      expect(_private.termiteRungDue({ ...term, notice_45_sent_at: new Date() }, 45, '2026-10-01')).toBe(false);
      expect(_private.termiteRungDue({ ...term, notice_45_late_sent_at: new Date() }, 45, '2026-10-01')).toBe(false);
    });

    test('30-day rung: due from term_end-30 through term_end, false once sent/late, false before the window opens', () => {
      const term = termiteTermFor('2026-11-10');
      expect(_private.termiteRungDue(term, 30, '2026-10-05')).toBe(false); // 36 days out — not open yet
      expect(_private.termiteRungDue(term, 30, '2026-10-11')).toBe(true); // exactly 30 days out
      expect(_private.termiteRungDue(term, 30, '2026-11-09')).toBe(true); // 1 day out
      expect(_private.termiteRungDue({ ...term, notice_30_sent_at: new Date() }, 30, '2026-11-01')).toBe(false);
      expect(_private.termiteRungDue({ ...term, notice_30_late_sent_at: new Date() }, 30, '2026-11-01')).toBe(false);
    });

    // Codex #4921 r3 finding #1/#2: a failed attempt (nothing stamped) must
    // stay due tomorrow — this is the property that makes the daily retry
    // work at all, for BOTH rungs.
    test('a rung with nothing stamped stays due on every subsequent day up through term_end (the retry property)', () => {
      const term = termiteTermFor('2026-11-10');
      for (const today of ['2026-09-26', '2026-09-27', '2026-10-11', '2026-11-09']) {
        expect(_private.termiteRungDue(term, 45, today)).toBe(true);
      }
      for (const today of ['2026-10-11', '2026-10-12', '2026-11-01', '2026-11-09']) {
        expect(_private.termiteRungDue(term, 30, today)).toBe(true);
      }
    });
  });

  describe('processTermiteNoticeObligations — one message per run, both rungs', () => {
    function baseTermiteTerm(termEnd) {
      return {
        id: 'term-1',
        customer_id: 'customer-1',
        status: 'active',
        term_start: '2026-05-20',
        term_end: termEnd,
        annual_plan_version: 'v3',
        installation_anchored_at: '2026-05-20T00:00:00.000Z',
        prepay_amount: 650,
        notice_45_sent_at: null,
        notice_45_claimed_at: null,
        notice_45_late_sent_at: null,
        notice_30_sent_at: null,
        notice_30_claimed_at: null,
        notice_30_late_sent_at: null,
        renewal_decision: null,
      };
    }

    // Pre-push audit P1 on the r3 structural fix: the 45-day rung's
    // missed/late record — and its "the customer has been told" staff
    // bell — must land ONLY after the combined 30-day send is CONFIRMED
    // delivered, in the very same step that records the 30-day witness
    // (markNoticeSent). Recording it up front, before the send is even
    // attempted, would leave false delivery evidence (a disabled cancel
    // flow, a missing renewal fee, or a delivery failure can all still
    // block the send after this point) and would wrongly suppress the
    // missed-notice escalation / clear the campaign cooldown.
    test('both rungs due at once: a FAILED combined send (customer not found) leaves BOTH rungs unstamped and never bells staff "the customer has been told"', async () => {
      pinTermiteToday(); // 2026-09-26
      const term = baseTermiteTerm('2026-10-16'); // 20 days out — both due
      const refreshQuery = query({ returning: [{ ...term, last_scheduled_service_id: null, last_scheduled_service_date: null }] });
      const claimQuery = query({ returning: [{ ...term, status: 'renewal_pending' }] });
      const releaseQuery = query();
      setDbQueues({
        // Only the refresh/claim/release entries — NOT a fourth or fifth
        // entry for a missed-late stamp or its escalation. If the
        // implementation still recorded the 45 rung before delivery, this
        // queue would run dry and throw "Unexpected db table", failing
        // the test.
        annual_prepay_terms: [refreshQuery, claimQuery, releaseQuery],
        scheduled_services: [query({ first: null }), query({ columnInfo: {} })],
        customers: [query({ first: null })], // customer not found → release claim, delivery never confirmed
      });
      NotificationService.notifyAdmin.mockClear();

      const result = await _private.processTermiteNoticeObligations(term, '2026-09-26');

      expect(result).toMatchObject({ sent: false, reason: 'customer_not_found' });
      expect(releaseQuery.update).toHaveBeenCalledWith(expect.objectContaining({ notice_30_claimed_at: null }));
      expect(releaseQuery.update).not.toHaveBeenCalledWith(expect.objectContaining({ notice_30_sent_at: expect.anything() }));
      // No "the customer has been told" bell for the 45 rung — nothing was
      // ever delivered.
      expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    });

    // Same combined-send case, but delivery succeeds: BOTH the 30-day
    // witness and the 45-day missed/late record (+ its own escalation
    // bell) land together, in that order — never before the send.
    test('both rungs due at once: a SUCCESSFUL combined send stamps the 30-day witness AND the 45-day missed/late record, with its own late escalation', async () => {
      pinTermiteToday(); // 2026-09-26
      const term = baseTermiteTerm('2026-10-26'); // exactly 30 days out — 30-day send is ON TIME, 45 still due too
      const refreshedTerm = { ...term, last_scheduled_service_id: null, last_scheduled_service_date: null };
      const refreshQuery = query({ returning: [refreshedTerm] });
      const claimQuery = query({ returning: [{ ...refreshedTerm, status: 'renewal_pending' }] });
      const markNoticeQuery = query(); // the 30-day witness update
      const missedLateUpdate = query({ returning: [{ ...refreshedTerm, notice_45_late_sent_at: new Date() }] });
      const columnInfoQuery45 = query({ columnInfo: { notice_45_late_escalated_at: {} } });
      const escalatedUpdate45 = query();
      setDbQueues({
        annual_prepay_terms: [refreshQuery, claimQuery, markNoticeQuery, missedLateUpdate, columnInfoQuery45, escalatedUpdate45],
        scheduled_services: [query({ first: null }), query({ columnInfo: {} })],
        customers: [
          query({ first: { id: 'customer-1', first_name: 'Stan', address_line1: '123 Bayshore Rd', city: 'Bradenton', email: 'stan@example.com', phone: '+19415550100' } }),
        ],
        customer_interactions: [query()],
      });
      CancellationResolution.cancelFlowV2Enabled.mockReturnValue(true);
      renderSmsTemplate.mockResolvedValue('rendered termite sms');
      sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted' });
      AccountMembershipEmail.sendTermiteRenewalReminder.mockResolvedValue({ ok: true });
      NotificationService.notifyAdmin.mockResolvedValue({ id: 'notif-late-45' });

      const result = await _private.processTermiteNoticeObligations(term, '2026-09-26');

      expect(result).toMatchObject({ sent: true, termId: 'term-1' });
      // The 30-day witness is the on-time column (exactly 30 days out).
      expect(markNoticeQuery.update).toHaveBeenCalledWith(expect.objectContaining({ notice_30_sent_at: expect.any(Date) }));
      // The 45-day rung lands as missed/late in the SAME confirmed-delivery
      // step — never before it.
      expect(missedLateUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ notice_45_late_sent_at: expect.any(Date) }));
      expect(markNoticeQuery.update.mock.invocationCallOrder[0])
        .toBeLessThan(missedLateUpdate.update.mock.invocationCallOrder[0]);
      expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
        'alert',
        'Termite annual renewal notice went out late',
        expect.any(String),
        expect.objectContaining({ metadata: expect.objectContaining({ reason: 'notice_45_late', days_out: 45, annual_prepay_term_id: 'term-1' }) }),
      );
      expect(escalatedUpdate45.update).toHaveBeenCalledWith(expect.objectContaining({ notice_45_late_escalated_at: expect.any(Date) }));
    });

    // coverageAwaitsInstallation must block the missed-late stamp too — an
    // unanchored original's term_end is only a provisional placeholder, so
    // nothing about it (sent, late, or missed) should ever be recorded.
    test('both rungs due at once, but the term is still awaiting installation: no missed-late stamp — the send itself bells and skips', async () => {
      pinTermiteToday();
      const term = { ...baseTermiteTerm('2026-10-16'), installation_anchored_at: null, renewed_from_term_id: null };
      const refreshQuery = query({ returning: [{ ...term, last_scheduled_service_id: null, last_scheduled_service_date: null }] });
      setDbQueues({
        annual_prepay_terms: [refreshQuery],
        scheduled_services: [query({ first: null }), query({ columnInfo: {} })],
        notifications: [query({ first: undefined })],
      });
      NotificationService.notifyAdmin.mockClear();

      const result = await _private.processTermiteNoticeObligations(term, '2026-09-26');

      expect(result).toMatchObject({ sent: false, reason: 'awaiting_installation' });
      expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
      expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
        'alert',
        expect.stringMatching(/installation never completed/i),
        expect.any(String),
        expect.objectContaining({ metadata: expect.objectContaining({ reason: 'awaiting_installation' }) }),
      );
    });

    // A term first seen at 44 days out: only the 45-day rung is due (30 is
    // still 14 days away) — sent, but LATE (fewer than 45 days out).
    test('found at 44 days out: only the 45-day rung is due, and it records LATE (not the on-time witness)', async () => {
      pinTermiteToday();
      const { term, secondQuery } = termiteNoticeHarness({ termEnd: '2026-11-09' }); // 44 days out
      sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted' });
      AccountMembershipEmail.sendTermiteRenewalReminder.mockResolvedValue({ ok: true });

      const result = await _private.processTermiteNoticeObligations(term, '2026-09-26');

      expect(result).toMatchObject({ sent: true });
      expect(secondQuery.update).toHaveBeenCalledWith(expect.objectContaining({ notice_45_late_sent_at: expect.any(Date) }));
      expect(secondQuery.update).not.toHaveBeenCalledWith(expect.objectContaining({ notice_45_sent_at: expect.anything() }));
    });

    test('neither rung due yet: reports not_due without touching the DB claim/send path', async () => {
      const term = baseTermiteTerm('2026-12-31'); // far in the future
      const result = await _private.processTermiteNoticeObligations(term, '2026-09-26');
      expect(result).toEqual({ sent: false, reason: 'not_due' });
    });
  });

  // A double-channel (SMS + email) failure on the 30-day rung releases the
  // claim and stamps nothing, exactly like the existing 45-day case — then
  // a later retry (the daily sweep re-selecting the still-unsent term)
  // succeeds. Extends the existing 45-only coverage to the 30-day rung
  // (Codex #4921 r3: both rungs must retry the same way).
  test('30-day rung: a double-channel send failure stamps nothing and releases the claim; a subsequent retry succeeds', async () => {
    pinTermiteToday();
    const failedTerm = {
      id: 'term-1',
      customer_id: 'customer-1',
      status: 'active',
      term_start: '2026-05-20',
      term_end: '2026-10-26', // 30 days out
      annual_plan_version: 'v3',
      installation_anchored_at: '2026-05-20T00:00:00.000Z',
      prepay_amount: 650,
      notice_30_sent_at: null,
      notice_30_claimed_at: null,
      notice_30_late_sent_at: null,
      renewal_decision: null,
    };
    const refreshedFailed = { ...failedTerm, last_scheduled_service_id: null, last_scheduled_service_date: null };
    const failClaimQuery = query({ returning: [{ ...refreshedFailed, status: 'renewal_pending' }] });
    const releaseQuery = query();
    setDbQueues({
      scheduled_services: [query({ first: null }), query({ columnInfo: {} })],
      annual_prepay_terms: [query({ returning: [refreshedFailed] }), failClaimQuery, releaseQuery],
      customers: [
        query({ first: { id: 'customer-1', first_name: 'Stan', address_line1: '123 Bayshore Rd', city: 'Bradenton', email: 'stan@example.com', phone: '+19415550100' } }),
      ],
    });
    CancellationResolution.cancelFlowV2Enabled.mockReturnValue(true);
    renderSmsTemplate.mockResolvedValue('rendered termite sms');
    sendCustomerMessage.mockResolvedValue({ sent: false, code: 'undeliverable' });
    AccountMembershipEmail.sendTermiteRenewalReminder.mockResolvedValue({ ok: false, reason: 'email_failed' });

    const firstAttempt = await AnnualPrepayRenewals.sendCustomerTermNotice(failedTerm, 30);
    expect(firstAttempt).toMatchObject({ sent: false });
    expect(releaseQuery.update).toHaveBeenCalledWith(expect.objectContaining({ notice_30_claimed_at: null }));
    expect(releaseQuery.update).not.toHaveBeenCalledWith(expect.objectContaining({ notice_30_sent_at: expect.anything() }));

    // "Tomorrow": nothing was stamped, so the term is still due (retry
    // property proven directly against the same row).
    expect(_private.termiteRungDue(refreshedFailed, 30, '2026-09-27')).toBe(true);

    // The retry itself succeeds once delivery does.
    const retryTerm = { ...refreshedFailed }; // still unsent/unclaimed, as the release left it
    const retryRefresh = query({ returning: [retryTerm] });
    const retryClaim = query({ returning: [{ ...retryTerm, status: 'renewal_pending' }] });
    const retryMarkSent = query();
    setDbQueues({
      scheduled_services: [query({ first: null }), query({ columnInfo: {} })],
      annual_prepay_terms: [retryRefresh, retryClaim, retryMarkSent],
      customers: [
        query({ first: { id: 'customer-1', first_name: 'Stan', address_line1: '123 Bayshore Rd', city: 'Bradenton', email: 'stan@example.com', phone: '+19415550100' } }),
      ],
      customer_interactions: [query()],
    });
    sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted' });
    AccountMembershipEmail.sendTermiteRenewalReminder.mockResolvedValue({ ok: true });

    const retryAttempt = await AnnualPrepayRenewals.sendCustomerTermNotice(retryTerm, 30);
    expect(retryAttempt).toMatchObject({ sent: true });
    expect(retryMarkSent.update).toHaveBeenCalledWith(expect.objectContaining({ notice_30_sent_at: expect.any(Date) }));
  });

  describe('fileTermiteMissedNoticeException — durable "obligation missed" escalation (Codex #4921 r3)', () => {
    test('a confirmed admin-bell insert stamps notice_missed_escalated_at, atomically deduped (no standalone SELECT)', async () => {
      const term = {
        id: 'term-missed-1', customer_id: 'customer-1', term_end: '2026-09-20',
        notice_45_sent_at: null, notice_45_late_sent_at: null,
        notice_30_sent_at: new Date(), notice_30_late_sent_at: null,
      };
      const updateQuery = query();
      setDbQueues({
        // No 'notifications' table entry at all — a standalone SELECT probe
        // would throw "Unexpected db table notifications" and fail this test.
        annual_prepay_terms: [query({ columnInfo: { notice_missed_escalated_at: {} } }), updateQuery],
      });
      NotificationService.notifyAdmin.mockResolvedValue({ id: 'notif-missed-1', deduped: false });

      await expect(_private.fileTermiteMissedNoticeException(term)).resolves.toBe(true);

      expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
        'alert',
        'Termite annual renewal notice obligation missed',
        expect.stringContaining('term-missed-1'),
        expect.objectContaining({
          bell: true,
          dedupeKey: 'termite-annual-notice:term-missed-1:missed',
          metadata: expect.objectContaining({ reason: 'notice_missed', missing45: true, missing30: false }),
        }),
      );
      expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({ notice_missed_escalated_at: expect.any(Date) }));
    });

    test('a failed admin-bell insert (notifyAdmin returns null) leaves the escalation unstamped and reports false, so the next sweep retries it', async () => {
      const term = { id: 'term-missed-2', customer_id: 'customer-1', term_end: '2026-09-20' };
      setDbQueues({ annual_prepay_terms: [] }); // never reached — the failure path returns before any write
      NotificationService.notifyAdmin.mockResolvedValue(null);

      await expect(_private.fileTermiteMissedNoticeException(term)).resolves.toBe(false);
    });
  });

  // Codex #4921 r3 P1: fileTermiteAwaitingInstallationException / fileTermiteCancelLinkException /
  // fileTermiteMissingFeeException used to run a standalone SELECT-then-insert
  // dedupe probe BEFORE calling notifyAdmin — not atomic across pods. They now
  // pass dedupeKey + dedupeWindowMs straight to notifyAdmin, which serializes
  // the probe and insert under one Postgres advisory lock in its own
  // transaction. No standalone 'notifications' query happens at all.
  describe('termite exception helpers — atomic dedupe via notifyAdmin (no standalone SELECT)', () => {
    test('fileTermiteAwaitingInstallationException passes dedupeKey + a 7-day dedupeWindowMs, and never queries notifications directly', async () => {
      setDbQueues({}); // a 'notifications' table access would throw here
      NotificationService.notifyAdmin.mockClear();

      await _private.fileTermiteAwaitingInstallationException({ id: 'term-x', customer_id: 'cust-x' }, 45);

      expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
        'alert',
        expect.stringMatching(/installation never completed/i),
        expect.any(String),
        expect.objectContaining({
          dedupeKey: 'termite-annual-notice:term-x:45:awaiting_installation',
          dedupeWindowMs: 7 * 24 * 60 * 60 * 1000,
        }),
      );
    });

    test('fileTermiteLateNoticeException (30-day rung) stamps notice_30_late_escalated_at, not the 45-day column', async () => {
      const term = { id: 'term-late-30', customer_id: 'customer-1', term_end: '2027-05-20' };
      const updateQuery = query();
      setDbQueues({
        annual_prepay_terms: [query({ columnInfo: { notice_30_late_escalated_at: {} } }), updateQuery],
      });
      NotificationService.notifyAdmin.mockResolvedValue({ id: 'notif-late-30', deduped: false });

      await expect(_private.fileTermiteLateNoticeException(term, 30)).resolves.toBe(true);

      expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
        'alert',
        'Termite annual renewal notice went out late',
        expect.any(String),
        expect.objectContaining({
          dedupeKey: 'termite-annual-notice:term-late-30:30:late',
          metadata: expect.objectContaining({ reason: 'notice_30_late', days_out: 30 }),
        }),
      );
      expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({ notice_30_late_escalated_at: expect.any(Date) }));
    });
  });

  // Every column checkAndSend's termite readiness gate requires, plus the
  // 000108 undelivered-escalation pair.
  const TERMITE_READY_COLS = {
    annual_plan_version: {},
    notice_45_sent_at: {},
    notice_45_claimed_at: {},
    notice_45_late_sent_at: {},
    notice_45_late_escalated_at: {},
    notice_30_sent_at: {},
    notice_30_claimed_at: {},
    notice_30_late_sent_at: {},
    notice_30_late_escalated_at: {},
    notice_missed_escalated_at: {},
    notice_45_undelivered_escalated_at: {},
    notice_30_undelivered_escalated_at: {},
  };

  // Generic (non-termite) prepay terms: the shared 30/15/7 loop excludes
  // termite terms from ITS OWN 30-day query when the termite notice-
  // obligation pass ran (it owns that rung then), but 15/7 are untouched.
  test('checkAndSend: with the termite pass ready, the shared loop excludes termite terms from its OWN 30-day query only — 15/7 stay unfiltered', async () => {
    const q30 = query({ rows: [] });
    const q15 = query({ rows: [] });
    const q7 = query({ rows: [] });
    setDbQueues({
      'annual_prepay_terms as t': [query({ rows: [] })], // activatePaidPendingTerms
      annual_prepay_terms: [
        query({ columnInfo: TERMITE_READY_COLS }),
        query({ rows: [] }), // termite obligation candidates
        query({ rows: [] }), // late-escalation retry candidates
        query({ rows: [] }), // undelivered-past-deadline candidates
        query({ rows: [] }), // missed-notice candidates
        q30, q15, q7,
      ],
    });

    const result = await AnnualPrepayRenewals.checkAndSend({ today: '2026-09-26' });

    expect(result).toEqual({ sent: 0 });
    expect(q30.whereNull).toHaveBeenCalledWith('annual_plan_version');
    expect(q15.whereNull).not.toHaveBeenCalledWith('annual_plan_version');
    expect(q7.whereNull).not.toHaveBeenCalledWith('annual_plan_version');
  });

  // Codex #4921 r4 P1: when the termite pass did NOT run (a failed or
  // incomplete schema probe), the shared loop must not exclude termite
  // terms either — they fall back to the exact-day 30-day send instead of
  // getting no notice at all.
  test('checkAndSend: with the termite pass NOT ready (failed schema probe), the shared 30-day loop keeps termite terms instead of excluding them', async () => {
    const failingProbe = query();
    failingProbe.columnInfo = jest.fn(async () => { throw new Error('connection reset'); });
    const q30 = query({ rows: [] });
    const q15 = query({ rows: [] });
    const q7 = query({ rows: [] });
    setDbQueues({
      'annual_prepay_terms as t': [query({ rows: [] })],
      annual_prepay_terms: [failingProbe, q30, q15, q7],
    });

    await expect(AnnualPrepayRenewals.checkAndSend({ today: '2026-09-26' })).resolves.toEqual({ sent: 0 });
    expect(q30.whereNull).not.toHaveBeenCalledWith('annual_plan_version');
  });

  // Codex #4921 r4 P1: a transient columnInfo() failure used to be cached as
  // {} for the life of the process, silently disabling every column-gated
  // path until a restart.
  test('annualPrepayColumns never caches a failed or empty probe; the next call re-probes and caches the real columns', async () => {
    const failingProbe = query();
    failingProbe.columnInfo = jest.fn(async () => { throw new Error('connection reset'); });
    const emptyProbe = query({ columnInfo: {} });
    const goodProbe = query({ columnInfo: TERMITE_READY_COLS });
    setDbQueues({ annual_prepay_terms: [failingProbe, emptyProbe, goodProbe] });

    await expect(_private.annualPrepayColumns()).resolves.toEqual({});
    await expect(_private.annualPrepayColumns()).resolves.toEqual({});
    await expect(_private.annualPrepayColumns()).resolves.toBe(TERMITE_READY_COLS);
    // Cached now: no further probe (the queue is empty, so a probe would throw).
    await expect(_private.annualPrepayColumns()).resolves.toBe(TERMITE_READY_COLS);
    expect(goodProbe.columnInfo).toHaveBeenCalledTimes(1);
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
    // A real term row always carries this column. Distinct from the
    // 'inv-visit' the other cases use, so only the self-referential tests
    // below trip the guard.
    prepay_invoice_id: 'inv-prepay',
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
      payments: [query({ first: undefined })],
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
      payments: [query({ first: undefined })],
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

  test('a PARTIALLY paid open invoice (payment_recorded_at, still collectible) gets neither settle nor credit', async () => {
    // The in-person prepay application reduces the invoice total and stamps
    // payment_recorded_at while the remainder stays collectible — crediting
    // the full slice on that stamp alone would over-credit a partly-paid
    // visit, and the settle helper refuses invoices with payments applied.
    const InvoiceServiceLocal = require('../services/invoice');
    setDbQueues({
      scheduled_services: [query({ rows: [completedRow(), pendingRow('s2', '2026-09-20'), pendingRow('s3', '2026-12-20'), pendingRow('s4', '2027-03-20')] })],
      invoices: [query({ first: { id: 'inv-visit', status: 'pending', payment_recorded_at: '2026-06-21', annual_prepay_covered_term_id: null } })],
    });

    const result = await AnnualPrepayRenewals.reconcilePendingWindowCompletions(TERM);

    expect(result).toEqual({ settled: 0, credited: 0 });
    expect(InvoiceServiceLocal.settleInvoiceAsAnnualPrepayCovered).not.toHaveBeenCalled();
    expect(postCreditMovement).not.toHaveBeenCalled();
  });

  test('a PARTIALLY REFUNDED paid invoice gets no slice credit (refund state lives on payments)', async () => {
    // Stripe partial refunds leave invoices.status='paid' — refund_status /
    // refund_amount live on the payment rows. Crediting the full slice would
    // over-credit a visit the customer already got money back on.
    setDbQueues({
      scheduled_services: [query({ rows: [completedRow(), pendingRow('s2', '2026-09-20'), pendingRow('s3', '2026-12-20'), pendingRow('s4', '2027-03-20')] })],
      invoices: [query({ first: { id: 'inv-visit', status: 'paid', payment_recorded_at: '2026-06-21', annual_prepay_covered_term_id: null } })],
      payments: [query({ first: { id: 'pay-partial-refund' } })],
    });

    const result = await AnnualPrepayRenewals.reconcilePendingWindowCompletions(TERM);

    expect(result).toEqual({ settled: 0, credited: 0 });
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
      payments: [query({ first: undefined })],
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

  // The same-day-close shape: ONE invoice bills the completed first visit AND
  // sells the annual, so it carries the visit's scheduled_service_id and IS
  // the term's prepay invoice. Its 'paid' status is the annual being paid —
  // not a second collection — so neither leg may fire. Prod 2026-08-08 minted
  // $265 of credit across 3 customers through exactly this hole.
  test('a completion invoice that IS the term\'s own prepay invoice is never credited', async () => {
    setDbQueues({
      scheduled_services: [query({ rows: [completedRow(), pendingRow('s2', '2026-09-20'), pendingRow('s3', '2026-12-20'), pendingRow('s4', '2027-03-20')] })],
      invoices: [query({ first: { id: 'inv-prepay', status: 'paid', payment_recorded_at: '2026-06-21', annual_prepay_covered_term_id: null } })],
    });

    const result = await AnnualPrepayRenewals.reconcilePendingWindowCompletions(TERM);

    expect(result).toEqual({ settled: 0, credited: 0 });
    expect(postCreditMovement).not.toHaveBeenCalled();
    expect(InvoiceService.settleInvoiceAsAnnualPrepayCovered).not.toHaveBeenCalled();
  });

  // A prepay invoice in prod carries annual_prepay_term_id NULL while its term
  // points at it, so the guard must key on the TERM's prepay_invoice_id. An
  // invoice-side check would miss that row and credit it.
  test('guards on the term\'s prepay_invoice_id even when the invoice\'s own term link is null', async () => {
    setDbQueues({
      scheduled_services: [query({ rows: [completedRow(), pendingRow('s2', '2026-09-20'), pendingRow('s3', '2026-12-20'), pendingRow('s4', '2027-03-20')] })],
      invoices: [query({ first: { id: 'inv-prepay', status: 'paid', annual_prepay_term_id: null, annual_prepay_covered_term_id: null } })],
    });

    const result = await AnnualPrepayRenewals.reconcilePendingWindowCompletions(TERM);

    expect(result).toEqual({ settled: 0, credited: 0 });
    expect(postCreditMovement).not.toHaveBeenCalled();
  });

  // A caller that hands over a term row without the column must not read as
  // "no prepay invoice" — that would fail the guard OPEN and re-mint the bug.
  test('a partial term row (column not selected) resolves prepay_invoice_id instead of failing open', async () => {
    const { prepay_invoice_id: _omitted, ...partialTerm } = TERM;
    setDbQueues({
      scheduled_services: [query({ rows: [completedRow(), pendingRow('s2', '2026-09-20'), pendingRow('s3', '2026-12-20'), pendingRow('s4', '2027-03-20')] })],
      annual_prepay_terms: [query({ first: { prepay_invoice_id: 'inv-prepay' } })],
      invoices: [query({ first: { id: 'inv-prepay', status: 'paid', annual_prepay_covered_term_id: null } })],
    });

    const result = await AnnualPrepayRenewals.reconcilePendingWindowCompletions(partialTerm);

    expect(result).toEqual({ settled: 0, credited: 0 });
    expect(postCreditMovement).not.toHaveBeenCalled();
  });

  // Guard scope check: a genuinely separate visit invoice still credits, so
  // the fix can't silently disable the real double-bill protection.
  test('a separate paid visit invoice still credits (the real double-bill case survives the guard)', async () => {
    setDbQueues({
      scheduled_services: [query({ rows: [completedRow(), pendingRow('s2', '2026-09-20'), pendingRow('s3', '2026-12-20'), pendingRow('s4', '2027-03-20')] })],
      invoices: [query({ first: { id: 'inv-visit', status: 'paid', payment_recorded_at: '2026-06-21', annual_prepay_covered_term_id: null } })],
      payments: [query({ first: undefined })],
      customers: [query({ first: { id: 'customer-1' } })],
      customer_credit_ledger: [query({ first: undefined })],
    });

    const result = await AnnualPrepayRenewals.reconcilePendingWindowCompletions(TERM);

    expect(result).toEqual({ settled: 0, credited: 1 });
    expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({
      delta: 100,
      invoiceId: 'inv-visit',
      createdBy: 'system:annual_prepay_pending_completion',
    }), db);
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

  // The self-referential backfill (migration 20260808040000) reverses the same
  // grants under its own identity. If this dedupe only recognized the runtime
  // reversal marker, refunding the annual afterwards would find the original
  // positive credit still in the ledger and claw the SAME slice back twice.
  test('a backfill reversal already counts as reversed — a later refund cannot claw the same slice back twice', async () => {
    setDbQueues({
      customers: [query({ first: { id: 'customer-1', account_credits: 250 } })],
      customer_credit_ledger: [
        query({ rows: [creditRow] }),
        query({
          rows: [{
            note: 'Reversing an annual-prepay credit issued in error — the visit was billed on the '
              + "term's own prepay invoice, so its slice was never collected twice (term term-1, visit svc-done)",
          }],
        }),
      ],
    });

    const reversed = await AnnualPrepayRenewals.reversePendingWindowCompletionCredits(TERM);

    expect(reversed).toBe(0);
    expect(postCreditMovement).not.toHaveBeenCalled();
  });

  // The migration is frozen and duplicates this literal rather than importing
  // it. If the service constant is ever renamed without the migration, the
  // dedupe above silently stops matching and the double-claw-back returns.
  test('the backfill reversal identity matches the literal the migration writes', () => {
    const migrationSource = require('fs').readFileSync(
      require('path').join(__dirname, '../models/migrations/20260808040000_backfill_self_referential_prepay_credits.js'),
      'utf8',
    );
    expect(migrationSource).toContain("const BACKFILL_BY = 'system:annual_prepay_self_referential_credit_backfill'");
    expect(_private.PENDING_COMPLETION_REVERSAL_IDENTITIES)
      .toContain('system:annual_prepay_self_referential_credit_backfill');
  });
});

describe('reverseWaveguardExtensionCredits (tier-extension refund claw-back)', () => {
  const { postCreditMovement } = require('../services/customer-credit');
  const TERM = { id: 'term-1', customer_id: 'customer-1' };
  const grantRow = {
    id: 'cl-wg-1',
    delta: 4.9,
    invoice_id: 'inv-prepay',
    created_by: 'system:waveguard_tier_extension',
    note: 'WaveGuard Silver extension — prepaid-term difference (term term-1, estimate est-9)',
  };
  const reversalEvent = {
    id: 'cl-wg-2',
    delta: -4.9,
    invoice_id: 'inv-prepay',
    created_by: 'system:waveguard_tier_extension_reversal',
    note: 'Annual prepay refunded — reversing the WaveGuard extension credit (term term-1, estimate est-9)',
  };

  beforeEach(() => {
    postCreditMovement.mockReset();
    db.transaction = jest.fn(async (cb) => cb(db));
  });

  // Savepoint on a caller transaction (pre-push P1, codex r5 round): same
  // contract as the restore helper — a swallowed failure on a raw caller
  // trx would leave it aborted; a knex trx runs the work under
  // conn.transaction (a savepoint) instead.
  test('a caller transaction runs the claw-back under conn.transaction (savepoint), not raw', async () => {
    const tables = {
      customers: [query({ first: { id: 'customer-1', account_credits: 20 } })],
      customer_credit_ledger: [
        query({ rows: [grantRow] }), // per-term grants
        query({ rows: [] }), // legacy-shape grants
        query({ rows: [grantRow] }), // marker events (grant-last → clawable)
      ],
    };
    const trx = jest.fn((table) => {
      const queue = tables[table];
      if (!queue || !queue.length) throw new Error(`Unexpected trx table ${table}`);
      return queue.shift();
    });
    trx.isTransaction = true;
    trx.transaction = jest.fn(async (cb) => cb(trx));

    const reversed = await AnnualPrepayRenewals.reverseWaveguardExtensionCredits(TERM, trx);

    expect(reversed).toBe(1);
    expect(trx.transaction).toHaveBeenCalledTimes(1);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({ delta: -4.9 }), trx);
  });

  // Ledger queue order per run: per-term grants → legacy-shape grants →
  // (per legacy: park dedupe + park insert) → per-credit marker events.
  test('reverses the extension grant when its prepay term refunds', async () => {
    const grantsQuery = query({ rows: [grantRow] });
    const eventsQuery = query({ rows: [grantRow] });
    setDbQueues({
      customers: [query({ first: { id: 'customer-1', account_credits: 20 } })],
      customer_credit_ledger: [grantsQuery, query({ rows: [] }), eventsQuery],
    });

    const reversed = await AnnualPrepayRenewals.reverseWaveguardExtensionCredits(TERM);

    expect(reversed).toBe(1);
    // Selection is by class identity + the per-term LIKE the grants mint.
    expect(grantsQuery.where).toHaveBeenCalledWith(expect.objectContaining({
      customer_id: 'customer-1',
      created_by: 'system:waveguard_tier_extension',
    }));
    expect(grantsQuery.where).toHaveBeenCalledWith('note', 'like', '%term term-1,%');
    // The last-event probe reads all three class identities for the marker.
    expect(eventsQuery.whereIn).toHaveBeenCalledWith('created_by', [
      'system:waveguard_tier_extension',
      'system:waveguard_tier_extension_reversal',
      'system:waveguard_tier_extension_restore',
    ]);
    // Chronological order MUST come from created_at — ledger ids are random
    // UUIDs, and an id-ordered event log would shuffle grant/claw/restore
    // and break the last-event rule (pre-push audit P0).
    expect(eventsQuery.orderBy).toHaveBeenNthCalledWith(1, 'created_at', 'asc');
    expect(eventsQuery.orderBy).toHaveBeenNthCalledWith(2, 'id', 'asc');
    expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-1',
      delta: -4.9,
      source: 'adjustment',
      invoiceId: 'inv-prepay',
      note: expect.stringContaining('(term term-1, estimate est-9)'),
      createdBy: 'system:waveguard_tier_extension_reversal',
      // Insert-order stamp — the event log orders by created_at, and the
      // column default (transaction-start now()) can invert commit order.
      stampInsertOrder: true,
    }), db);
  });

  test('a reversal-last marker blocks a second claw-back (replayed refund sync)', async () => {
    setDbQueues({
      customers: [query({ first: { id: 'customer-1', account_credits: 20 } })],
      customer_credit_ledger: [
        query({ rows: [grantRow] }),
        query({ rows: [] }),
        query({ rows: [grantRow, reversalEvent] }),
      ],
    });

    const reversed = await AnnualPrepayRenewals.reverseWaveguardExtensionCredits(TERM);

    expect(reversed).toBe(0);
    expect(postCreditMovement).not.toHaveBeenCalled();
  });

  test('after a repayment restore, a second refund claws the RESTORED amount, not the original grant (last-event rule)', async () => {
    setDbQueues({
      customers: [query({ first: { id: 'customer-1', account_credits: 20 } })],
      customer_credit_ledger: [
        query({ rows: [grantRow] }),
        query({ rows: [] }),
        query({
          rows: [
            grantRow,
            { ...reversalEvent, delta: -2.5 },
            {
              id: 'cl-wg-3',
              delta: 2.5,
              invoice_id: 'inv-prepay',
              created_by: 'system:waveguard_tier_extension_restore',
              note: 'Annual prepay re-paid — restoring the WaveGuard extension credit (term term-1, estimate est-9)',
            },
          ],
        }),
      ],
    });

    const reversed = await AnnualPrepayRenewals.reverseWaveguardExtensionCredits(TERM);

    expect(reversed).toBe(1);
    expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({
      delta: -2.5,
      createdBy: 'system:waveguard_tier_extension_reversal',
    }), db);
  });

  test('an exhausted balance writes the zero-delta dedupe row instead of pulling negative', async () => {
    const markerInsert = query();
    setDbQueues({
      customers: [query({ first: { id: 'customer-1', account_credits: 0 } })],
      customer_credit_ledger: [
        query({ rows: [grantRow] }),
        query({ rows: [] }),
        query({ rows: [grantRow] }),
        markerInsert,
      ],
    });

    const reversed = await AnnualPrepayRenewals.reverseWaveguardExtensionCredits(TERM);

    expect(reversed).toBe(0);
    expect(postCreditMovement).not.toHaveBeenCalled();
    expect(markerInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
      customer_id: 'customer-1',
      delta: 0,
      balance_after: 0,
      created_by: 'system:waveguard_tier_extension_reversal',
      note: expect.stringContaining('(term term-1, estimate est-9)'),
    }));
  });

  test('a partially available balance reverses what remains (capped, never negative)', async () => {
    setDbQueues({
      customers: [query({ first: { id: 'customer-1', account_credits: 2.5 } })],
      customer_credit_ledger: [
        query({ rows: [grantRow] }),
        query({ rows: [] }),
        query({ rows: [grantRow] }),
      ],
    });

    const reversed = await AnnualPrepayRenewals.reverseWaveguardExtensionCredits(TERM);

    expect(reversed).toBe(1);
    expect(postCreditMovement).toHaveBeenCalledWith(
      expect.objectContaining({ delta: -2.5 }), db,
    );
  });

  test('no grants for the term is a clean no-op', async () => {
    setDbQueues({
      customers: [query({ first: { id: 'customer-1', account_credits: 20 } })],
      customer_credit_ledger: [query({ rows: [] }), query({ rows: [] })],
    });

    const reversed = await AnnualPrepayRenewals.reverseWaveguardExtensionCredits(TERM);

    expect(reversed).toBe(0);
    expect(postCreditMovement).not.toHaveBeenCalled();
  });

  // Pre-guards shape: ONE aggregate grant naming every term. Per-term
  // clawback cannot honestly slice it — it must PARK for the operator, and
  // exactly once.
  const legacyGrantRow = {
    id: 'cl-legacy-1',
    delta: 9.8,
    invoice_id: 'inv-prepay',
    created_by: 'system:waveguard_tier_extension',
    note: 'WaveGuard Silver extension — prepaid-term difference (estimate #est-9; terms: term-1, term-2)',
  };

  test('a legacy aggregate grant naming the refunded term parks for the operator instead of being sliced', async () => {
    const parkInsert = query();
    setDbQueues({
      customers: [query({ first: { id: 'customer-1', account_credits: 20 } })],
      customer_credit_ledger: [
        query({ rows: [] }), // per-term grants: the aggregate shape doesn't match "(term <id>,"
        query({ rows: [legacyGrantRow] }),
        query({ first: undefined }), // no prior park row
        parkInsert,
      ],
    });

    const reversed = await AnnualPrepayRenewals.reverseWaveguardExtensionCredits(TERM);

    expect(reversed).toBe(0);
    expect(postCreditMovement).not.toHaveBeenCalled();
    expect(parkInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
      customer_id: 'customer-1',
      delta: 0,
      created_by: 'system:waveguard_tier_extension_reversal',
      note: expect.stringContaining('(term term-1, legacy ledger cl-legacy-1)'),
    }));
  });

  test('a replayed refund does not park the same legacy grant twice', async () => {
    setDbQueues({
      customers: [query({ first: { id: 'customer-1', account_credits: 20 } })],
      customer_credit_ledger: [
        query({ rows: [] }),
        query({ rows: [legacyGrantRow] }),
        query({ first: { id: 'cl-park-1' } }),
      ],
    });

    const reversed = await AnnualPrepayRenewals.reverseWaveguardExtensionCredits(TERM);

    expect(reversed).toBe(0);
    expect(postCreditMovement).not.toHaveBeenCalled();
  });

  // The grant identity is shared through customer-credit.js — pin the real
  // module's constants against the literals this suite (and the writer's
  // suite) mock, so a rename can never silently split writer from reversal.
  test('the shared identity constants match the real customer-credit module', () => {
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '../services/customer-credit.js'),
      'utf8',
    );
    expect(source).toContain("const WAVEGUARD_EXTENSION_CREDIT_BY = 'system:waveguard_tier_extension'");
    expect(source).toContain("const WAVEGUARD_EXTENSION_REVERSAL_BY = 'system:waveguard_tier_extension_reversal'");
    expect(source).toContain("const WAVEGUARD_EXTENSION_RESTORE_BY = 'system:waveguard_tier_extension_restore'");
  });
});

describe('restoreWaveguardExtensionCredits (repayment restore after the claw-back)', () => {
  const { postCreditMovement } = require('../services/customer-credit');
  const TERM = { id: 'term-1', customer_id: 'customer-1' };
  const grantEvent = {
    id: 'cl-wg-1',
    delta: 4.9,
    invoice_id: 'inv-prepay',
    created_by: 'system:waveguard_tier_extension',
    note: 'WaveGuard Silver extension — prepaid-term difference (term term-1, estimate est-9)',
  };
  const reversalRow = {
    id: 'cl-wg-2',
    delta: -4.9,
    invoice_id: 'inv-prepay',
    created_by: 'system:waveguard_tier_extension_reversal',
    note: 'Annual prepay refunded — reversing the WaveGuard extension credit (term term-1, estimate est-9)',
  };
  const restoreRow = {
    id: 'cl-wg-3',
    delta: 4.9,
    invoice_id: 'inv-prepay',
    created_by: 'system:waveguard_tier_extension_restore',
    note: 'Annual prepay re-paid — restoring the WaveGuard extension credit (term term-1, estimate est-9)',
  };

  beforeEach(() => {
    postCreditMovement.mockReset();
    db.transaction = jest.fn(async (cb) => cb(db));
  });

  // Ledger queue order per run: reversal rows for the term → per-marker
  // events (skipped entirely for legacy park markers).
  test('restores exactly what the claw took when the prepay is re-paid', async () => {
    setDbQueues({
      customers: [query({ first: { id: 'customer-1' } })],
      customer_credit_ledger: [
        query({ rows: [reversalRow] }),
        query({ rows: [grantEvent, reversalRow] }),
      ],
    });

    const restored = await AnnualPrepayRenewals.restoreWaveguardExtensionCredits(TERM);

    expect(restored).toBe(1);
    expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'customer-1',
      delta: 4.9,
      source: 'adjustment',
      invoiceId: 'inv-prepay',
      note: expect.stringContaining('(term term-1, estimate est-9)'),
      createdBy: 'system:waveguard_tier_extension_restore',
      stampInsertOrder: true,
    }), db);
  });

  test('a replayed repayment sync does not restore twice (restore-last marker)', async () => {
    setDbQueues({
      customers: [query({ first: { id: 'customer-1' } })],
      customer_credit_ledger: [
        query({ rows: [reversalRow] }),
        query({ rows: [grantEvent, reversalRow, restoreRow] }),
      ],
    });

    const restored = await AnnualPrepayRenewals.restoreWaveguardExtensionCredits(TERM);

    expect(restored).toBe(0);
    expect(postCreditMovement).not.toHaveBeenCalled();
  });

  test('a partial claw restores only the partial', async () => {
    const partialReversal = { ...reversalRow, delta: -2.5 };
    setDbQueues({
      customers: [query({ first: { id: 'customer-1' } })],
      customer_credit_ledger: [
        query({ rows: [partialReversal] }),
        query({ rows: [grantEvent, partialReversal] }),
      ],
    });

    const restored = await AnnualPrepayRenewals.restoreWaveguardExtensionCredits(TERM);

    expect(restored).toBe(1);
    expect(postCreditMovement).toHaveBeenCalledWith(
      expect.objectContaining({ delta: 2.5 }), db,
    );
  });

  test('the zero-delta exhausted settle row restores nothing — that value was already spent toward bills', async () => {
    const exhaustedRow = {
      ...reversalRow,
      delta: 0,
      note: 'Annual prepay refunded — the WaveGuard extension credit was already spent; nothing reversed, operator follow-up needed (term term-1, estimate est-9)',
    };
    setDbQueues({
      customers: [query({ first: { id: 'customer-1' } })],
      customer_credit_ledger: [
        query({ rows: [exhaustedRow] }),
        query({ rows: [grantEvent, exhaustedRow] }),
      ],
    });

    const restored = await AnnualPrepayRenewals.restoreWaveguardExtensionCredits(TERM);

    expect(restored).toBe(0);
    expect(postCreditMovement).not.toHaveBeenCalled();
  });

  test('a legacy park row is operator-owned — restore never touches it', async () => {
    const parkRow = {
      ...reversalRow,
      delta: 0,
      note: 'Annual prepay refunded — a legacy aggregate WaveGuard extension credit names this term and cannot be auto-reversed per-term; operator review needed (term term-1, legacy ledger cl-legacy-1)',
    };
    setDbQueues({
      customers: [query({ first: { id: 'customer-1' } })],
      customer_credit_ledger: [query({ rows: [parkRow] })],
    });

    const restored = await AnnualPrepayRenewals.restoreWaveguardExtensionCredits(TERM);

    expect(restored).toBe(0);
    expect(postCreditMovement).not.toHaveBeenCalled();
  });

  test('no reversal rows for the term is a clean no-op', async () => {
    setDbQueues({
      customers: [query({ first: { id: 'customer-1' } })],
      customer_credit_ledger: [query({ rows: [] })],
    });

    const restored = await AnnualPrepayRenewals.restoreWaveguardExtensionCredits(TERM);

    expect(restored).toBe(0);
    expect(postCreditMovement).not.toHaveBeenCalled();
  });

  // Savepoint on a caller transaction (pre-push P1, codex r5 round): the
  // helper swallows its own errors, so a failed statement on a RAW caller
  // trx would leave that transaction aborted while the helper reports a
  // quiet no-op — every later statement in the caller then fails. A knex
  // trx must therefore be wrapped via conn.transaction (a savepoint).
  test('a caller transaction runs the work under conn.transaction (savepoint), not raw', async () => {
    const tables = {
      customers: [query({ first: { id: 'customer-1' } })],
      customer_credit_ledger: [
        query({ rows: [reversalRow] }),
        query({ rows: [grantEvent, reversalRow] }),
      ],
    };
    const trx = jest.fn((table) => {
      const queue = tables[table];
      if (!queue || !queue.length) throw new Error(`Unexpected trx table ${table}`);
      return queue.shift();
    });
    trx.isTransaction = true;
    trx.transaction = jest.fn(async (cb) => cb(trx));

    const restored = await AnnualPrepayRenewals.restoreWaveguardExtensionCredits(TERM, trx);

    expect(restored).toBe(1);
    expect(trx.transaction).toHaveBeenCalledTimes(1);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({ delta: 4.9 }), trx);
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
    // The insert returns '*', so the born-paid term carries this column.
    // Distinct from 'inv-visit' — these cases reconcile a genuinely separate
    // visit invoice and must still credit.
    prepay_invoice_id: 'inv-prepay',
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
        // annualPrepayColumns: a minimal NON-empty probe (no optional
        // column) — only a successful non-empty probe is cached (Codex
        // #4921 r4 P1), and later steps reuse this one.
        query({ columnInfo: { id: {} } }),
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
      payments: [query({ first: undefined })],
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
        // Coverage-window slide check (real-clock floor shifts this past-dated
        // fixture): empty columnInfo → no term_end column → slide skipped.
        query({ columnInfo: {} }),
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
      payments: [query({ first: undefined })],
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

describe('createTermForAnnualPrepay window edit — out-of-window detach is NOT best-effort', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
    _private.resetCachesForTests();
    db.transaction = jest.fn(async (cb) => cb(db));
  });

  test('a failed stamp detach ABORTS the window edit instead of logging on', async () => {
    // annualPrepayCoversVisit is calendar-independent (no term window), which
    // is only sound because a window edit ALWAYS strips the stamps of visits
    // it pushed out of coverage. Pin: when that detach fails, the edit throws
    // — a swallowed failure here would leave the shrunken window silently
    // suppressing completion billing for the removed visits.
    const EXISTING = {
      id: 'term-9',
      customer_id: 'customer-1',
      source_estimate_id: 'est-9',
      prepay_invoice_id: null,
      plan_label: 'WaveGuard Annual Prepay',
      monthly_rate: 100,
      prepay_amount: 1200,
      status: 'active',
      renewal_decision: null,
      term_start: '2026-01-10',
      term_end: '2027-01-10',
    };
    const failingStampClear = query();
    failingStampClear.andWhere = jest.fn(() => failingStampClear);
    failingStampClear.then = (resolve, reject) => Promise.reject(new Error('deadlock detected')).then(resolve, reject);

    setDbQueues({
      annual_prepay_terms: [
        query({ columnInfo: {} }), // annualPrepayColumns
        query({ first: EXISTING }), // source-estimate existing-term lookup
        query({}), // the window update itself
      ],
      scheduled_services: [
        query({ columnInfo: { scheduled_date: {}, annual_prepay_term_id: {}, prepaid_amount: {}, prepaid_method: {} } }), // scheduledServiceColumns
        failingStampClear, // out-of-window stamp clear — fails
      ],
    });

    await expect(AnnualPrepayRenewals.createTermForAnnualPrepay({
      customerId: 'customer-1',
      sourceEstimateId: 'est-9',
      termStart: '2026-03-01', // explicit window change → detach must run
      prepayAmount: 1200,
    })).rejects.toThrow(/could not detach out-of-window visits/);
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
    // coveredTermsAsOf selects t.* — a resolved term always carries this.
    // Distinct from the 'inv-visit' these cases reconcile, so the
    // self-referential guard correctly leaves them crediting.
    prepay_invoice_id: 'inv-prepay',
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
      payments: [query({ first: undefined })],
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
      payments: [query({ first: undefined })],
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

// billing_mode stamp timing (Codex round-2): the annual_prepay stamp must
// only land once the term is genuinely ACTIVE (paid). A payment_pending term
// keeps the customer 'per_application' so pre-payment completions bill per
// application; the payment sync stamps on the pending→active transition.
describe('annual_prepay billing_mode stamp timing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = {
      hasTable: jest.fn().mockResolvedValue(true),
      hasColumn: jest.fn().mockResolvedValue(true),
    };
    _private.resetCachesForTests();
    db.transaction = jest.fn(async (cb) => cb(db));
  });

  test('a term born payment_pending does NOT stamp billing_mode (customer stays per_application until paid)', async () => {
    const PENDING = {
      id: 'term-p',
      customer_id: 'customer-1',
      status: 'payment_pending',
      prepay_amount: 400,
      term_start: '2026-07-09',
      term_end: '2027-07-09',
    };
    setDbQueues({
      invoices: [
        query({ first: { id: 'inv-pre', status: 'sent', paid_at: null } }), // statusForPrepayInvoice → unpaid
        query({ columnInfo: {} }), // syncInvoiceTerm column probe (no term column → no-op)
      ],
      annual_prepay_terms: [
        query({ columnInfo: {} }), // annualPrepayColumns
        query({ first: undefined }), // existing-term lookup (by invoice/estimate)
        query({ first: undefined }), // existing-term lookup (customer + window)
        query({ returning: [PENDING] }), // insert
        query({ first: PENDING }), // refreshTermSnapshot term read
        query({ returning: [PENDING] }), // refreshTermSnapshot snapshot update
      ],
      scheduled_services: [
        query({ first: undefined }), // findLastScheduledServiceForTerm
      ],
      // NO customers queue: any customers access (renewal-date sync or the
      // billing_mode stamp) would throw and fail the test.
    });

    const created = await AnnualPrepayRenewals.createTermForAnnualPrepay({
      customerId: 'customer-1',
      prepayInvoiceId: 'inv-pre',
      termStart: '2026-07-09',
      prepayAmount: 400,
    });

    expect(created).toEqual(PENDING);
    expect(db.schema.hasColumn).not.toHaveBeenCalled(); // stamp never ran
  });

  test('a term born ACTIVE stamps billing_mode annual_prepay at creation', async () => {
    const ACTIVE = {
      id: 'term-a',
      customer_id: 'customer-1',
      status: 'active',
      prepay_amount: null,
      term_start: '2026-07-09',
      term_end: '2027-07-09',
    };
    const stampQ = query({});
    const priorWriteQ = query({});
    setDbQueues({
      annual_prepay_terms: [
        query({ columnInfo: {} }), // annualPrepayColumns
        query({ first: undefined }), // existing-term lookup
        query({ returning: [ACTIVE] }), // insert
        query({ first: ACTIVE }), // refreshTermSnapshot term read
        query({ returning: [ACTIVE] }), // refreshTermSnapshot snapshot update
        priorWriteQ, // prior_billing_mode record on the term
      ],
      scheduled_services: [
        query({ columnInfo: { scheduled_date: {}, service_type: {} } }), // scheduledServiceColumns (attach no-ops)
        query({ first: undefined }), // findLastScheduledServiceForTerm
      ],
      customers: [
        query({ columnInfo: {} }), // syncCustomerRenewalDate probe (no renewal column)
        query({ first: { billing_mode: 'per_application' } }), // prior-mode read
        stampQ, // billing_mode stamp update
      ],
    });

    const created = await AnnualPrepayRenewals.createTermForAnnualPrepay({
      customerId: 'customer-1',
      termStart: '2026-07-09',
    });

    expect(created).toEqual(ACTIVE);
    // The stamp records what the customer WAS (round-7: refunds restore it).
    expect(priorWriteQ.update).toHaveBeenCalledWith(
      expect.objectContaining({ prior_billing_mode: 'per_application' }),
    );
    expect(stampQ.update).toHaveBeenCalledWith(
      expect.objectContaining({ billing_mode: 'annual_prepay' }),
    );
  });

  test('syncTermForInvoicePayment stamps billing_mode on the pending→active transition', async () => {
    const PENDING = {
      id: 'term-s',
      customer_id: 'customer-1',
      status: 'payment_pending',
      prepay_amount: null,
      term_start: '2026-07-09',
      term_end: '2027-07-09',
    };
    const ACTIVE = { ...PENDING, status: 'active' };
    const stampQ = query({});
    setDbQueues({
      annual_prepay_terms: [
        query({ rows: [PENDING] }), // terms select for the paid invoice
        query({ rows: [] }), // dispute-cancel revival lookup — none
        query({ returning: [ACTIVE] }), // pending→active transition update
        query({ returning: [ACTIVE] }), // refreshTermSnapshot snapshot update
        query({}), // prior_billing_mode record on the term
      ],
      scheduled_services: [
        query({ columnInfo: { scheduled_date: {}, service_type: {} } }), // scheduledServiceColumns
        query({ first: undefined }), // findLastScheduledServiceForTerm
      ],
      customers: [
        query({ columnInfo: {} }), // syncCustomerRenewalDate probe
        query({ first: { billing_mode: 'per_application' } }), // prior-mode read
        stampQ, // billing_mode stamp update
      ],
    });

    const results = await AnnualPrepayRenewals.syncTermForInvoicePayment(
      { id: 'inv-paid', status: 'paid', paid_at: '2026-07-09' },
    );

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('active');
    expect(stampQ.update).toHaveBeenCalledWith(
      expect.objectContaining({ billing_mode: 'annual_prepay' }),
    );
  });
});

// billing_mode reset on term void/refund (Codex round-5): the monthly cron
// now skips 'annual_prepay' outright, so a cancelled/refunded term MUST
// return the customer to a billable mode at the term choke point —
// estimate-flow terms to per-visit billing, manual/Customer-360 prepays to
// legacy monthly (NULL).
describe('billing_mode reset on term void/refund', () => {
  const cancelQueues = (term, cancelled, resetQ) => ({
    annual_prepay_terms: [
      query({ rows: [term] }), // terms select for the refunded invoice
      query({ returning: [cancelled] }), // cancel transition update
      query({ first: undefined }), // reset helper's replacement-coverage check
      query({ first: undefined }), // prior_billing_mode read (not recorded → heuristic)
      query({ rows: [] }), // decided-covered terms sweep (post-loop)
    ],
    scheduled_services: [
      query({ columnInfo: { scheduled_date: {} } }), // clearPrepaidStamps probe → no-op
    ],
    customers: [
      query({ first: { id: 'customer-1', account_credits: 0 } }), // pending-completion reversal row lock
      query({ first: { id: 'customer-1', account_credits: 0 } }), // WaveGuard extension reversal row lock
      resetQ, // billing_mode reset
    ],
    // One grants select per reversal class — both empty here.
    customer_credit_ledger: [query({ rows: [] }), query({ rows: [] })],
  });

  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = {
      hasTable: jest.fn().mockResolvedValue(true),
      hasColumn: jest.fn().mockResolvedValue(true),
    };
    _private.resetCachesForTests();
    db.transaction = jest.fn(async (cb) => cb(db));
  });

  test('an estimate-flow term void resets the customer to per_application', async () => {
    const TERM = {
      id: 'term-c', customer_id: 'customer-1', status: 'active',
      source_estimate_id: 'est-9', prepay_amount: null,
      term_start: '2026-07-09', term_end: '2027-07-09',
    };
    const resetQ = query({});
    setDbQueues(cancelQueues(TERM, { ...TERM, status: 'cancelled' }, resetQ));

    const results = await AnnualPrepayRenewals.syncTermForInvoicePayment(
      { id: 'inv-r', status: 'refunded', paid_at: null },
    );

    expect(results[0].status).toBe('cancelled');
    expect(resetQ.update).toHaveBeenCalledWith(
      expect.objectContaining({ billing_mode: 'per_application' }),
    );
  });

  test('a MANUAL term with a RECORDED prior mode restores it exactly — per_application customer who bought a manual prepay (Codex round-7)', async () => {
    const TERM = {
      id: 'term-mp', customer_id: 'customer-1', status: 'active',
      source_estimate_id: null, prepay_amount: null,
      term_start: '2026-07-09', term_end: '2027-07-09',
    };
    const resetQ = query({});
    const queues = cancelQueues(TERM, { ...TERM, status: 'cancelled' }, resetQ);
    // prior_billing_mode WAS recorded at stamp time — the heuristic
    // (no source estimate → NULL) must NOT win over it.
    queues.annual_prepay_terms[3] = query({ first: { prior_billing_mode: 'per_application' } });
    setDbQueues(queues);

    await AnnualPrepayRenewals.syncTermForInvoicePayment(
      { id: 'inv-r', status: 'refunded', paid_at: null },
    );

    expect(resetQ.update).toHaveBeenCalledWith(
      expect.objectContaining({ billing_mode: 'per_application' }),
    );
  });

  test("a recorded prior of 'none' restores legacy NULL", async () => {
    const TERM = {
      id: 'term-le', customer_id: 'customer-1', status: 'active',
      source_estimate_id: 'est-1', prepay_amount: null,
      term_start: '2026-07-09', term_end: '2027-07-09',
    };
    const resetQ = query({});
    const queues = cancelQueues(TERM, { ...TERM, status: 'cancelled' }, resetQ);
    // Recorded 'none' (prior was NULL legacy monthly) beats the heuristic
    // (source estimate present → per_application).
    queues.annual_prepay_terms[3] = query({ first: { prior_billing_mode: 'none' } });
    setDbQueues(queues);

    await AnnualPrepayRenewals.syncTermForInvoicePayment(
      { id: 'inv-r', status: 'refunded', paid_at: null },
    );

    expect(resetQ.update).toHaveBeenCalledWith(
      expect.objectContaining({ billing_mode: null }),
    );
  });

  test('a manual/Customer-360 term void resets to NULL (legacy monthly)', async () => {
    const TERM = {
      id: 'term-m', customer_id: 'customer-1', status: 'active',
      source_estimate_id: null, prepay_amount: null,
      term_start: '2026-07-09', term_end: '2027-07-09',
    };
    const resetQ = query({});
    setDbQueues(cancelQueues(TERM, { ...TERM, status: 'cancelled' }, resetQ));

    await AnnualPrepayRenewals.syncTermForInvoicePayment(
      { id: 'inv-r', status: 'refunded', paid_at: null },
    );

    expect(resetQ.update).toHaveBeenCalledWith(
      expect.objectContaining({ billing_mode: null }),
    );
  });
});

// Codex round-6 P1: a decided-lapse term (status 'cancelled' +
// renewal_decision) whose invoice refunds is handled by the decided-covered
// sweep, not the active loop — it must ALSO reset billing_mode when no
// replacement coverage exists, or the customer stays 'annual_prepay' with
// the cron skipping them and completion refusing to bill.
describe('billing_mode reset for decided-lapse terms on refund', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = {
      hasTable: jest.fn().mockResolvedValue(true),
      hasColumn: jest.fn().mockResolvedValue(true),
    };
    _private.resetCachesForTests();
    db.transaction = jest.fn(async (cb) => cb(db));
  });

  test('refunded decided-lapse term with no replacement coverage resets the mode', async () => {
    const DECIDED = { id: 'term-d', customer_id: 'customer-1', source_estimate_id: 'est-1' };
    const resetQ = query({});
    setDbQueues({
      annual_prepay_terms: [
        query({ rows: [] }), // active/pending terms select — none (already decided)
        query({ rows: [DECIDED] }), // decided-covered terms sweep
        query({ first: undefined }), // reset helper's replacement-coverage check
        query({ first: undefined }), // prior_billing_mode read (not recorded → heuristic)
      ],
      scheduled_services: [
        query({ columnInfo: { scheduled_date: {} } }), // clearPrepaidStamps probe → no-op
      ],
      customers: [
        query({ first: { id: 'customer-1', account_credits: 0 } }), // pending-completion reversal row lock
        query({ first: { id: 'customer-1', account_credits: 0 } }), // WaveGuard extension reversal row lock
        resetQ,
      ],
      customer_credit_ledger: [query({ rows: [] }), query({ rows: [] })],
    });

    await AnnualPrepayRenewals.syncTermForInvoicePayment(
      { id: 'inv-r', status: 'refunded', paid_at: null },
    );

    expect(resetQ.update).toHaveBeenCalledWith(
      expect.objectContaining({ billing_mode: 'per_application' }),
    );
  });

  test('the replacement lookup filters to a LIVE window — an expired active row is not coverage (Codex round-11)', async () => {
    // coveredTermsAsOf only covers dates inside [term_start, term_end], so a
    // lapsed never-decided 'active' row with a past term_end must not keep
    // the annual_prepay stamp. The mock returns no replacement; assert the
    // query itself carried the term_end >= today (ET) predicate that
    // excludes expired rows, and the mode still reset.
    const DECIDED = { id: 'term-d', customer_id: 'customer-1', source_estimate_id: 'est-1' };
    const replacementQ = query({ first: undefined });
    const resetQ = query({});
    setDbQueues({
      annual_prepay_terms: [
        query({ rows: [] }),
        query({ rows: [DECIDED] }),
        replacementQ, // replacement-coverage check (live-window filtered)
        query({ first: undefined }), // prior_billing_mode read → heuristic
      ],
      scheduled_services: [
        query({ columnInfo: { scheduled_date: {} } }),
      ],
      customers: [
        query({ first: { id: 'customer-1', account_credits: 0 } }),
        query({ first: { id: 'customer-1', account_credits: 0 } }), // WaveGuard extension reversal row lock
        resetQ,
      ],
      customer_credit_ledger: [query({ rows: [] }), query({ rows: [] })],
    });

    await AnnualPrepayRenewals.syncTermForInvoicePayment(
      { id: 'inv-r', status: 'refunded', paid_at: null },
    );

    expect(replacementQ.where).toHaveBeenCalledWith('term_end', '>=', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    // A paid FUTURE term (not started) is not coverage today either (Codex
    // round-12) — the window must contain today on BOTH ends.
    expect(replacementQ.where).toHaveBeenCalledWith('term_start', '<=', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(resetQ.update).toHaveBeenCalledWith(
      expect.objectContaining({ billing_mode: 'per_application' }),
    );
  });

  test('a replacement live term keeps the customer annual_prepay (renewed-then-old-refunded)', async () => {
    const DECIDED = { id: 'term-d', customer_id: 'customer-1', source_estimate_id: 'est-1' };
    setDbQueues({
      annual_prepay_terms: [
        query({ rows: [] }),
        query({ rows: [DECIDED] }),
        query({ first: { id: 'term-new' } }), // replacement coverage EXISTS
      ],
      scheduled_services: [
        query({ columnInfo: { scheduled_date: {} } }),
      ],
      customers: [
        query({ first: { id: 'customer-1', account_credits: 0 } }),
        // NO reset entry: a customers access for the reset would throw
      ],
      customer_credit_ledger: [query({ rows: [] })],
    });

    await expect(AnnualPrepayRenewals.syncTermForInvoicePayment(
      { id: 'inv-r', status: 'refunded', paid_at: null },
    )).resolves.toBeDefined();
  });
});

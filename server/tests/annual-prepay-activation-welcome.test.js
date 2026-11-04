// Annual-prepay activation sends the "new recurring customer" welcome for the
// FIRST series it seeds (owner 2026-11-04, "welcome text"), like the admin
// create route. The candidacy is the real shared gate
// (isNewRecurringSignupCandidate) against a queued db; only the enqueue
// (sendNewRecurringWelcome) is a spy. Forward-only, no gate.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
  classifyDeliveryCertainty: jest.fn(),
}));
jest.mock('../services/new-recurring-welcome-sms', () => ({
  ...jest.requireActual('../services/new-recurring-welcome-sms'),
  sendNewRecurringWelcome: jest.fn(async () => ({ sent: false, queued: true })),
}));
jest.mock('../services/invoice', () => ({
  settleInvoiceAsAnnualPrepayCovered: jest.fn(),
  reopenAnnualPrepayCoveredInvoicesForTerm: jest.fn(),
}));
jest.mock('../services/customer-credit', () => ({
  postCreditMovement: jest.fn(),
  WAVEGUARD_EXTENSION_CREDIT_BY: 'system:waveguard_tier_extension',
  WAVEGUARD_EXTENSION_REVERSAL_BY: 'system:waveguard_tier_extension_reversal',
  WAVEGUARD_EXTENSION_RESTORE_BY: 'system:waveguard_tier_extension_restore',
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { sendNewRecurringWelcome } = require('../services/new-recurring-welcome-sms');
const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
const { _private } = AnnualPrepayRenewals;

function query({ first, returning, columnInfo, rows = [] } = {}) {
  const q = {};
  [
    'whereIn', 'whereNull', 'whereNot', 'whereBetween', 'whereNotIn', 'orderBy', 'select',
    'forUpdate', 'noWait', 'leftJoin', 'join', 'limit', 'whereRaw', 'whereNotNull',
    'orWhereNotNull', 'orWhereNull', 'orWhereRaw', 'orWhereNot', 'orWhereIn', 'orWhereNotIn',
    'whereNotExists', 'orWhere',
  ].forEach((method) => { q[method] = jest.fn(() => q); });
  q.modify = jest.fn((fn) => { if (typeof fn === 'function') fn(q); return q; });
  q.where = jest.fn((arg) => {
    if (typeof arg === 'function') arg.call(q, q);
    return q;
  });
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
      if (table === 'scheduled_services as seed_recheck') return query({ rows: [] });
      if (table === 'services') return query({ first: undefined });
      if (table === 'annual_prepay_terms as apt_owner_probe') {
        return query({ first: { customer_id: 'owner-unchanged' } });
      }
      if (table === 'activity_log') return query({ first: undefined });
      throw new Error(`Unexpected db table ${table}`);
    }
    return queue.shift();
  });
}

const COLS = {
  scheduled_date: {}, service_type: {}, annual_prepay_term_id: {}, is_recurring: {},
  recurring_pattern: {}, recurring_parent_id: {}, recurring_ongoing: {}, technician_id: {},
  window_start: {}, window_end: {}, time_window: {}, customer_notes: {}, zone: {},
  notes: {}, estimated_duration_minutes: {},
};
const TERM = {
  id: 'term-1',
  customer_id: 'customer-1',
  term_start: '2026-06-15',
  term_end: '2027-06-15',
  coverage_service_type: 'Quarterly Pest Control',
  coverage_visit_count: 4,
};
const CUSTOMER = { id: 'customer-1', first_name: 'Test', last_name: 'Customer', phone: '+15555550100', email: null };

// Queue order for a first activation with nothing seeded yet: columns, the
// existing-coverage read, the already-activated probe, the two candidacy
// reads (prior recurring series, prior serviced visit), then four inserts.
function activationQueues({ priorSeries, priorVisit, priorRecord } = {}) {
  const inserts = [
    query({ returning: [{ id: 'svc-1', scheduled_date: '2026-06-15', recurring_pattern: 'quarterly' }] }),
    query({ returning: [{ id: 'svc-2', scheduled_date: '2026-09-15', recurring_pattern: 'quarterly' }] }),
    query({ returning: [{ id: 'svc-3', scheduled_date: '2026-12-15', recurring_pattern: 'quarterly' }] }),
    query({ returning: [{ id: 'svc-4', scheduled_date: '2027-03-15', recurring_pattern: 'quarterly' }] }),
  ];
  setDbQueues({
    scheduled_services: [
      query({ columnInfo: COLS }),
      query({ rows: [] }),
      query({ first: undefined }),
      query({ first: priorSeries }),
      query({ first: priorVisit }),
      ...inserts,
    ],
    service_records: [query({ first: priorRecord })],
    customers: [query({ first: CUSTOMER })],
  });
  return inserts;
}

describe('annual prepay activation sends the new recurring welcome', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
    db.raw = jest.fn().mockResolvedValue({ rows: [{ locked: true }] });
    db.transaction = jest.fn(async (cb) => cb(db));
    _private.resetCachesForTests();
  });

  const seed = (opts = {}) => _private.ensureCoverageRowsForTerm({ ...TERM }, undefined, { today: '2026-01-01', ...opts });

  test('new customer: the welcome is queued once, for the series root, with the activation entry point', async () => {
    const inserts = activationQueues();
    const result = await seed();
    expect(result.createdCount).toBe(4);
    expect(inserts[0].insert).toHaveBeenCalledWith(expect.objectContaining({ is_recurring: true }));
    expect(sendNewRecurringWelcome).toHaveBeenCalledTimes(1);
    expect(sendNewRecurringWelcome).toHaveBeenCalledWith({
      customer: CUSTOMER,
      scheduledServiceId: 'svc-1',
      recurringPattern: 'quarterly',
      entryPoint: 'annual_prepay_activation',
    });
  });

  test('renewal: an earlier recurring series disqualifies the customer, no welcome', async () => {
    activationQueues({ priorSeries: { id: 'old-series' } });
    const result = await seed();
    expect(result.createdCount).toBe(4);
    expect(sendNewRecurringWelcome).not.toHaveBeenCalled();
  });

  test('existing customer: a serviced visit older than the new-customer window disqualifies, no welcome', async () => {
    activationQueues({ priorVisit: { id: 'old-visit' } });
    await seed();
    expect(sendNewRecurringWelcome).not.toHaveBeenCalled();
  });

  test('existing customer: a completed service record older than the window disqualifies, no welcome', async () => {
    activationQueues({ priorRecord: { id: 'old-record' } });
    await seed();
    expect(sendNewRecurringWelcome).not.toHaveBeenCalled();
  });

  test('a send that throws never fails the activation and logs an error', async () => {
    activationQueues();
    sendNewRecurringWelcome.mockRejectedValueOnce(new Error('queue down'));
    const result = await seed();
    expect(result.createdCount).toBe(4);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('new recurring welcome failed'));
  });

  test('a gap-fill refresh of an already-activated term never asks and never sends', async () => {
    const historyRead = query();
    setDbQueues({
      scheduled_services: [
        query({ columnInfo: COLS }),
        query({ rows: [] }),
        query({ returning: [{ id: 'svc-9', scheduled_date: '2026-06-15', recurring_pattern: 'quarterly' }] }),
        query({ returning: [{ id: 'svc-10', scheduled_date: '2026-09-15', recurring_pattern: 'quarterly' }] }),
        query({ returning: [{ id: 'svc-11', scheduled_date: '2026-12-15', recurring_pattern: 'quarterly' }] }),
        query({ returning: [{ id: 'svc-12', scheduled_date: '2027-03-15', recurring_pattern: 'quarterly' }] }),
      ],
      service_records: [historyRead],
    });
    const result = await seed({ gapFillOnly: true, seedNotBefore: '2026-01-01' });
    expect(result.createdCount).toBe(4);
    expect(historyRead.first).not.toHaveBeenCalled();
    expect(sendNewRecurringWelcome).not.toHaveBeenCalled();
  });

  test('nothing to seed: no candidacy read and no send', async () => {
    const existing = [
      { id: 'a', customer_id: 'customer-1', scheduled_date: '2026-06-15', service_type: 'Quarterly Pest Control', status: 'pending', is_recurring: true },
      { id: 'b', customer_id: 'customer-1', scheduled_date: '2026-09-15', service_type: 'Quarterly Pest Control', status: 'pending', is_recurring: true },
      { id: 'c', customer_id: 'customer-1', scheduled_date: '2026-12-15', service_type: 'Quarterly Pest Control', status: 'pending', is_recurring: true },
      { id: 'd', customer_id: 'customer-1', scheduled_date: '2027-03-15', service_type: 'Quarterly Pest Control', status: 'pending', is_recurring: true },
    ];
    setDbQueues({ scheduled_services: [query({ columnInfo: COLS }), query({ rows: existing }), query({ first: { id: 'a' } })] });
    const result = await seed();
    expect(result.createdCount).toBe(0);
    expect(sendNewRecurringWelcome).not.toHaveBeenCalled();
  });
});

describe('queueFirstSeriesWelcomeAfterCommit', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  const send = (conn, extra = {}) => _private.queueFirstSeriesWelcomeAfterCommit(conn, TERM, {
    candidate: true, rootId: 'svc-1', createdRows: [{ id: 'svc-1', recurring_pattern: 'quarterly' }], ...extra,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    setDbQueues({ customers: [query({ first: CUSTOMER })] });
  });

  test('inside a transaction nothing is sent until COMMIT', async () => {
    const commit = deferred();
    await send({ isTransaction: true, executionPromise: commit.promise });
    await flush();
    expect(sendNewRecurringWelcome).not.toHaveBeenCalled();
    commit.resolve();
    await flush();
    expect(sendNewRecurringWelcome).toHaveBeenCalledTimes(1);
    expect(sendNewRecurringWelcome).toHaveBeenCalledWith(expect.objectContaining({
      scheduledServiceId: 'svc-1', entryPoint: 'annual_prepay_activation',
    }));
  });

  test('a rollback drops the welcome', async () => {
    const commit = deferred();
    await send({ isTransaction: true, executionPromise: commit.promise });
    commit.reject(new Error('rolled back'));
    await flush();
    expect(sendNewRecurringWelcome).not.toHaveBeenCalled();
  });

  test('a savepoint waits for the OUTERMOST transaction, not its own release', async () => {
    const outer = deferred();
    const savepoint = {
      isTransaction: true,
      executionPromise: Promise.resolve(), // releases before the real commit
      parentTransaction: { isTransaction: true, executionPromise: outer.promise },
    };
    await send(savepoint);
    await flush();
    expect(sendNewRecurringWelcome).not.toHaveBeenCalled();
    outer.resolve();
    await flush();
    expect(sendNewRecurringWelcome).toHaveBeenCalledTimes(1);
  });

  test('a savepoint that rolled back (error swallowed) while the outer transaction commits sends nothing', async () => {
    const outer = deferred();
    const savepoint = deferred();
    await send({
      isTransaction: true,
      executionPromise: savepoint.promise,
      parentTransaction: { isTransaction: true, executionPromise: outer.promise },
    });
    savepoint.reject(new Error('savepoint rolled back'));
    outer.resolve();
    await flush();
    expect(sendNewRecurringWelcome).not.toHaveBeenCalled();
  });

  test('on the global pool the rows are already committed, so it sends inline', async () => {
    await send(db);
    expect(sendNewRecurringWelcome).toHaveBeenCalledTimes(1);
  });

  test('not a candidate, or nothing seeded: nothing is queued', async () => {
    await send(db, { candidate: false });
    await send(db, { createdRows: [] });
    expect(sendNewRecurringWelcome).not.toHaveBeenCalled();
  });

  test('a missing customer row sends nothing and does not throw', async () => {
    setDbQueues({ customers: [query({ first: undefined })] });
    await expect(send(db)).resolves.toBeUndefined();
    expect(sendNewRecurringWelcome).not.toHaveBeenCalled();
  });
});

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ error: jest.fn() }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn() }));

const db = require('../models/db');
const { triggerNotification } = require('../services/notification-triggers');
const { enqueuePaymentFailureNotification, processPendingPaymentFailureNotifications } = require('../services/payment-failure-notifications');

const TABLE = 'stripe_payment_notification_log';
const intent = { id: 'pi_failure', amount: 8500, latest_charge: 'ch_attempt', metadata: { waves_customer_id: 'cust_metadata' } };
let rows;
let ledger;
let invoice;
let customer;
let readPayment;
let inserted;
let locked;
let lockRequests;
let clock;

function job(piId = 'pi_failure', attemptId = 'ch_attempt') {
  return { payment_intent_id: piId, outcome: 'failed', attempt_id: attemptId,
    notified_at: 1, pending_payload: { amount: 85, customerId: 'cust_metadata', reason: 'Card declined' } };
}

// Model commit/rollback and SKIP LOCKED without a database or external calls.
function query(table, session = null) {
  let filters = {};
  let pendingOnly = false;
  let settledOnly = false;
  let locking = false;
  let batchLimit = Infinity;
  let insertRow;
  let ignoringConflict = false;
  const matches = (row) => Object.entries(filters).every(([key, value]) => row[key] === value)
    && (!pendingOnly || row.pending_payload != null);
  const chain = {
    where: (value) => { filters = { ...filters, ...value }; return chain; },
    whereNotNull: () => { pendingOnly = true; return chain; },
    whereIn: () => { settledOnly = true; return chain; },
    orderBy: () => chain,
    limit: (value) => { batchLimit = value; return chain; },
    forUpdate: () => { locking = true; return chain; },
    skipLocked: () => { expect(locking).toBe(true); return chain; },
    first: async () => {
      if (table === TABLE) {
        const row = rows.find(matches);
        if (!row) return undefined;
        if (locking) {
          lockRequests += 1;
          if (locked.has(row)) return undefined;
          locked.add(row);
          session.locks.push(row);
        }
        return row;
      }
      if (table === 'payments') return readPayment({ settledOnly, filters });
      if (table === 'invoices') return invoice;
      if (table === 'customers') return customer;
      throw new Error(`Unexpected table ${table}`);
    },
    select: async () => rows.filter(matches).sort((a, b) => a.notified_at - b.notified_at)
      .slice(0, batchLimit).map(({ payment_intent_id, outcome, attempt_id }) => ({ payment_intent_id, outcome, attempt_id })),
    update: async (patch) => {
      const updates = rows.filter(matches).map((row) => ({ row, patch }));
      if (session) session.updates.push(...updates);
      else updates.forEach(({ row }) => Object.assign(row, patch));
      return 1;
    },
    insert: (value) => { insertRow = value; return chain; },
    onConflict: (key) => { expect(key).toEqual(['payment_intent_id', 'outcome', 'attempt_id']); return chain; },
    ignore: () => { ignoringConflict = true; return chain; },
    then: (resolve, reject) => Promise.resolve().then(() => {
      expect(table).toBe(TABLE);
      expect(ignoringConflict).toBe(true);
      inserted.push(insertRow);
      const duplicate = rows.some((row) => ['payment_intent_id', 'outcome', 'attempt_id'].every((key) => row[key] === insertRow[key]));
      if (!duplicate) rows.push({ ...insertRow, notified_at: rows.length + 1 });
    }).then(resolve, reject),
  };
  return chain;
}

beforeEach(() => {
  jest.clearAllMocks();
  rows = [];
  ledger = null;
  invoice = { id: 'inv_failure', customer_id: 'cust_invoice' };
  customer = { first_name: 'Synthetic', last_name: 'Customer' };
  inserted = [];
  locked = new Set();
  lockRequests = 0;
  clock = 100;
  readPayment = jest.fn(async ({ settledOnly }) => settledOnly
    ? (['paid', 'refunded', 'disputed'].includes(ledger?.status) ? ledger : undefined)
    : ledger);
  db.mockImplementation((table) => query(table));
  db.fn = { now: () => ++clock };
  db.transaction = jest.fn(async (callback) => {
    const session = { locks: [], updates: [] };
    try {
      const trx = (table) => query(table, session);
      trx.fn = db.fn;
      const result = await callback(trx);
      for (const { row, patch } of session.updates) Object.assign(row, patch);
      return result;
    } finally {
      session.locks.forEach((row) => locked.delete(row));
    }
  });
  triggerNotification.mockResolvedValue({ bellWritten: true });
});

test('enqueue stores minimal payload, dedupes one attempt, and performs no notification work', async () => {
  await enqueuePaymentFailureNotification(intent, 'Card declined', 'evt_failure');
  await enqueuePaymentFailureNotification(intent, 'Repeated event', 'evt_duplicate');
  expect(rows).toHaveLength(1);
  expect(inserted[0]).toEqual({ payment_intent_id: 'pi_failure', outcome: 'failed', attempt_id: 'ch_attempt',
    pending_payload: { amount: 85, customerId: 'cust_metadata', reason: 'Card declined' } });
  expect(triggerNotification).not.toHaveBeenCalled();
  expect(db.transaction).not.toHaveBeenCalled();
  expect(db.mock.calls.every(([table]) => table === TABLE)).toBe(true);
});

test('expanded charge IDs and charge-less event IDs retain distinct attempt identities', async () => {
  await enqueuePaymentFailureNotification({ ...intent, latest_charge: { id: 'ch_expanded' } }, 'Declined', 'evt_1');
  await enqueuePaymentFailureNotification({ ...intent, latest_charge: null }, 'Declined', 'evt_2');
  await enqueuePaymentFailureNotification({ ...intent, latest_charge: null }, 'Declined', 'evt_3');
  expect(rows.map((row) => row.attempt_id)).toEqual(['ch_expanded', 'evt_2', 'evt_3']);
});

test('existing delivered claims never become pending again', async () => {
  rows = [{ ...job(), pending_payload: null }, { ...job('pi_success'), outcome: 'succeeded', pending_payload: null }];
  await enqueuePaymentFailureNotification(intent, 'Declined', 'evt_failure');
  expect(await processPendingPaymentFailureNotifications()).toEqual({ processed: 0, failed: 0, skipped: 0 });
  expect(rows.every((row) => row.pending_payload === null)).toBe(true);
  expect(triggerNotification).not.toHaveBeenCalled();
});

test('pending payloads for another outcome are outside the failure worker', async () => {
  rows = [{ ...job(), outcome: 'succeeded' }];
  expect(await processPendingPaymentFailureNotifications()).toEqual({ processed: 0, failed: 0, skipped: 0 });
  expect(triggerNotification).not.toHaveBeenCalled();
  expect(rows[0].pending_payload).not.toBeNull();
});

test('enqueue database failure propagates for webhook retry', async () => {
  db.mockImplementation(() => { throw new Error('Database unavailable'); });
  await expect(enqueuePaymentFailureNotification(intent, 'Declined', 'evt_failure')).rejects.toThrow('Database unavailable');
});

test('dispatch resolves live invoice/customer details and supplies stable identity and rechecks', async () => {
  rows = [job()];
  expect(await processPendingPaymentFailureNotifications()).toEqual({ processed: 1, failed: 0, skipped: 0 });
  expect(triggerNotification).toHaveBeenCalledWith('payment_failed', {
    amount: 85, customerName: 'Synthetic Customer', customerId: 'cust_invoice', reason: 'Card declined',
    invoiceId: 'inv_failure', paymentIntentId: 'pi_failure', attemptId: 'ch_attempt',
  }, expect.objectContaining({ dedupeKey: 'payment-failed:pi_failure:ch_attempt',
    shouldContinue: expect.any(Function), beforePush: expect.any(Function) }));
  expect(rows[0].pending_payload).toBeNull();
  expect(rows[0].notified_at).toBeGreaterThan(100);
  expect(lockRequests).toBe(1);
});

test.each(['paid', 'refunded', 'disputed'])('already %s payments suppress queued failures', async (status) => {
  rows = [job()];
  ledger = { id: 'pmt_settled', status };
  expect((await processPendingPaymentFailureNotifications()).processed).toBe(1);
  expect(triggerNotification).not.toHaveBeenCalled();
  expect(rows[0].pending_payload).toBeNull();
});

test.each([{ bellWritten: true }, { push: { sent: 1 } }, { suppressed: true }, { policySilenced: true }])(
  'delivery or deliberate suppression completes a job: %j', async (result) => {
    rows = [job()];
    triggerNotification.mockResolvedValue(result);
    expect((await processPendingPaymentFailureNotifications()).processed).toBe(1);
    expect(rows[0].pending_payload).toBeNull();
  });

test('metadata customer fallback reaches the existing test-account suppression gate', async () => {
  rows = [job()];
  invoice = null;
  triggerNotification.mockResolvedValue({ suppressed: true });
  await processPendingPaymentFailureNotifications();
  expect(triggerNotification.mock.calls[0][1]).toMatchObject({ customerId: 'cust_metadata', invoiceId: null });
  expect(rows[0].pending_payload).toBeNull();
});

test('undelivered jobs survive and retry with the same bell dedupe key', async () => {
  rows = [job()];
  triggerNotification.mockResolvedValueOnce({ bellWritten: false, prefsUnavailable: true });
  expect(await processPendingPaymentFailureNotifications()).toEqual({ processed: 0, failed: 1, skipped: 0 });
  expect(rows[0].pending_payload).not.toBeNull();
  expect((await processPendingPaymentFailureNotifications()).processed).toBe(1);
  expect(triggerNotification.mock.calls.map((call) => call[2].dedupeKey)).toEqual([
    'payment-failed:pi_failure:ch_attempt', 'payment-failed:pi_failure:ch_attempt',
  ]);
});

test('a delivered bell with retryable push failure retains the pending job', async () => {
  rows = [job()];
  triggerNotification.mockResolvedValueOnce({ bellWritten: true, retryable: true,
    push: { sent: 0, failed: 1, deliveredSubscriptionIds: [] } });
  expect(await processPendingPaymentFailureNotifications()).toEqual({ processed: 0, failed: 1, skipped: 0 });
  expect(rows[0].pending_payload).toMatchObject({ reason: 'Card declined', deliveredSubscriptionIds: [] });
  expect(rows[0].notified_at).toBeGreaterThan(100);
  expect((await processPendingPaymentFailureNotifications()).processed).toBe(1);
});

test.each([null, undefined, { bellWritten: true, error: 'Push unavailable' }, { prefsUnavailable: true }])(
  'null or explicit failure outcomes remain pending: %j', async (result) => {
    rows = [job()];
    triggerNotification.mockResolvedValueOnce(result);
    expect((await processPendingPaymentFailureNotifications()).failed).toBe(1);
    expect(rows[0].pending_payload).not.toBeNull();
  });

test('accepted pushes survive a retryable bell failure and are forwarded on retry', async () => {
  rows = [job()];
  rows[0].pending_payload.deliveredSubscriptionIds = ['sub_prior'];
  triggerNotification.mockResolvedValueOnce({ bellWritten: false, retryable: true,
    push: { sent: 2, failed: 0, deliveredSubscriptionIds: ['sub_prior', 'sub_new'] } });
  expect(await processPendingPaymentFailureNotifications()).toEqual({ processed: 0, failed: 1, skipped: 0 });
  expect(rows[0].pending_payload.deliveredSubscriptionIds).toEqual(['sub_prior', 'sub_new']);
  expect(triggerNotification.mock.calls[0][2].deliveredSubscriptionIds).toEqual(['sub_prior']);
  triggerNotification.mockResolvedValueOnce({ bellWritten: true, retryable: false,
    push: { sent: 2, failed: 0, deliveredSubscriptionIds: ['sub_prior', 'sub_new'] } });
  expect((await processPendingPaymentFailureNotifications()).processed).toBe(1);
  expect(triggerNotification.mock.calls[1][2].deliveredSubscriptionIds).toEqual(['sub_prior', 'sub_new']);
  expect(rows[0].pending_payload).toBeNull();
});

test('partial push acceptance accumulates across retries without losing prior IDs', async () => {
  rows = [job()];
  triggerNotification.mockResolvedValueOnce({ bellWritten: true, retryable: true,
    push: { sent: 1, failed: 2, deliveredSubscriptionIds: ['sub_first'] } });
  triggerNotification.mockResolvedValueOnce({ bellWritten: true, retryable: true,
    push: { sent: 2, failed: 1, deliveredSubscriptionIds: ['sub_second'] } });
  expect((await processPendingPaymentFailureNotifications()).failed).toBe(1);
  expect((await processPendingPaymentFailureNotifications()).failed).toBe(1);
  expect(rows[0].pending_payload.deliveredSubscriptionIds).toEqual(['sub_first', 'sub_second']);
});

test.each([{ suppressed: true }, { policySilenced: true }])('deliberate suppression completes even a retryable result: %j', async (suppression) => {
  rows = [job()];
  triggerNotification.mockResolvedValueOnce({ retryable: true, ...suppression });
  expect((await processPendingPaymentFailureNotifications()).processed).toBe(1);
  expect(rows[0].pending_payload).toBeNull();
});

test('settlement observed before push completes a partially delivered retryable job', async () => {
  rows = [job()];
  triggerNotification.mockImplementationOnce(async (_key, _payload, options) => {
    ledger = { id: 'pmt_now_paid', status: 'paid' };
    expect(await options.beforePush()).toBe(false);
    return { bellWritten: true, retryable: true };
  });
  expect((await processPendingPaymentFailureNotifications()).processed).toBe(1);
  expect(rows[0].pending_payload).toBeNull();
});

test('a failed first job does not prevent the remaining bounded batch from dispatching', async () => {
  rows = [job('pi_poison'), { ...job('pi_healthy'), notified_at: 2 }, { ...job('pi_later'), notified_at: 3 }];
  triggerNotification.mockRejectedValueOnce(new Error('Transient delivery failure'));
  expect(await processPendingPaymentFailureNotifications({ limit: 2 })).toEqual({ processed: 1, failed: 1, skipped: 0 });
  expect(rows.map((row) => row.pending_payload === null)).toEqual([false, true, false]);
  expect(triggerNotification).toHaveBeenCalledTimes(2);
});

test('a full failed batch rotates behind newer jobs for the next sweep', async () => {
  rows = [job('pi_poison_1'), { ...job('pi_poison_2'), notified_at: 2 }, { ...job('pi_newer'), notified_at: 3 }];
  triggerNotification.mockResolvedValueOnce({ prefsUnavailable: true }).mockResolvedValueOnce({ prefsUnavailable: true });
  expect((await processPendingPaymentFailureNotifications({ limit: 2 })).failed).toBe(2);
  expect(rows[0].notified_at).toBeGreaterThan(rows[2].notified_at);
  expect(rows[1].notified_at).toBeGreaterThan(rows[2].notified_at);
  expect((await processPendingPaymentFailureNotifications({ limit: 1 })).processed).toBe(1);
  expect(triggerNotification.mock.calls[2][1].paymentIntentId).toBe('pi_newer');
  expect(rows[2].pending_payload).toBeNull();
});

test('two workers skip a job locked by the other worker', async () => {
  rows = [job()];
  let unblock;
  let entered;
  const entering = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { unblock = resolve; });
  triggerNotification.mockImplementationOnce(async () => { entered(); await blocked; return { bellWritten: true }; });
  const first = processPendingPaymentFailureNotifications();
  await entering;
  expect(await processPendingPaymentFailureNotifications()).toEqual({ processed: 0, failed: 0, skipped: 1 });
  unblock();
  expect((await first).processed).toBe(1);
  expect(triggerNotification).toHaveBeenCalledTimes(1);
});

test('payment settling after the first ledger lookup suppresses pre-bell and push callbacks', async () => {
  rows = [job()];
  triggerNotification.mockImplementationOnce(async (_key, _payload, options) => {
    ledger = { id: 'pmt_now_paid', status: 'paid' };
    expect(await options.shouldContinue()).toBe(false);
    expect(await options.beforePush()).toBe(false);
    return { bellWritten: false, suppressed: true };
  });
  expect((await processPendingPaymentFailureNotifications()).processed).toBe(1);
  expect(rows[0].pending_payload).toBeNull();
});

test('payment settling during badge work suppresses the final push', async () => {
  rows = [job()];
  triggerNotification.mockImplementationOnce(async (_key, _payload, options) => {
    expect(await options.shouldContinue()).toBe(true);
    expect(await options.beforePush()).toBe(true);
    ledger = { id: 'pmt_now_paid', status: 'paid' };
    expect(await options.beforePush({ dispatching: true })).toBe(false);
    return { bellWritten: true, push: { sent: 0, skipped: 'superseded_before_push' } };
  });
  expect((await processPendingPaymentFailureNotifications()).processed).toBe(1);
});

test.each(['shouldContinue', 'beforePush'])('a %s ledger failure fails closed and preserves pending even after a bell', async (callback) => {
  rows = [job()];
  triggerNotification.mockImplementationOnce(async (_key, _payload, options) => {
    readPayment.mockRejectedValueOnce(new Error('Ledger unavailable'));
    expect(await options[callback]()).toBe(false);
    return { bellWritten: true, suppressed: true };
  });
  expect((await processPendingPaymentFailureNotifications()).failed).toBe(1);
  expect(rows[0].pending_payload).not.toBeNull();
});

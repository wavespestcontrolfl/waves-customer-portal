/**
 * B16: reconcileScaParkedAlerts — the durable closer for the "autopay parked on card
 * authentication" alerts. Event-time closes (Charge now, the succeeded webhook) are the fast path
 * and best-effort; each hangs off one event and can fail or never fire (a redelivered Stripe event
 * is deduped, a customer can pay another way). The daily retry sweep runs this reconciler, which
 * reads only the OPEN alerts of the family and closes those whose debt is now collected.
 *
 * In-memory ledger / notifications / health table behind a small query evaluator, so the real
 * helper code (raise, settle, supersede, close, reconcile) runs end to end.
 */
const mockS = { payments: [], health: [], notifications: [], closeFailures: 0, healthSeq: 0 };

// ---- a tiny evaluator for the query shapes autopay-sca-parked.js issues ----
function mockPaymentsQuery() {
  const preds = [];
  const mk = (b) => {
    const own = [];
    const add = (op, fn) => own.push({ op, fn });
    const g = {
      where: (a, v) => { if (typeof a === 'function') { const sub = mk({}); a.call(sub, sub); add('and', sub.pred); } else if (typeof a === 'object') add('and', (r) => Object.entries(a).every(([k, x]) => String(r[k]) === String(x))); else add('and', (r) => String(r[a]) === String(v)); return g; },
      orWhere: (a, v) => { if (typeof a === 'function') { const sub = mk({}); a.call(sub, sub); add('or', sub.pred); } else add('or', (r) => String(r[a]) === String(v)); return g; },
      andWhere: (col, op, v) => { add('and', (r) => (op === '>=' ? String(r[col]) >= v : op === '<=' ? String(r[col]) <= v : op === 'like' ? String(r[col] || '').includes(String(v).replace(/%/g, '')) : false)); return g; },
      whereNull: (c) => { add('and', (r) => r[c] == null); return g; },
      whereNot: (o) => { add('and', (r) => !Object.entries(o).every(([k, x]) => String(r[k]) === String(x))); return g; },
      whereRaw: (sql, b2) => {
        if (/^metadata->>'billed_month' = \?/.test(sql)) add('and', (r) => mockMeta(r).billed_month === b2[0]);
        else if (/metadata IS NULL OR metadata->>'billed_month' IS NULL/.test(sql)) add('and', (r) => !mockMeta(r).billed_month);
        else add('and', () => true);
        return g;
      },
    };
    Object.defineProperty(g, 'pred', { get: () => (r) => own.reduce((acc, { op, fn }, i) => (i === 0 ? fn(r) : op === 'or' ? acc || fn(r) : acc && fn(r)), true) });
    return g;
  };
  const q = mk({});
  const rows = () => mockS.payments.filter((r) => q.pred(r));
  q.select = () => Promise.resolve(rows().map((r) => ({ ...r })));
  q.first = () => Promise.resolve(rows()[0] ? { ...rows()[0] } : undefined);
  q.update = (payload) => { q._payload = payload; return q; };
  q.returning = () => { const hit = rows(); hit.forEach((r) => Object.assign(r, q._payload, { failure_reason: 'resolved' })); return Promise.resolve(hit.map((r) => ({ id: r.id, customer_id: r.customer_id, stripe_payment_intent_id: r.stripe_payment_intent_id }))); };
  void preds;
  return q;
}
const mockMeta = (r) => (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata) || {};

function mockHealthQuery() {
  const f = { eq: {}, in: {}, prefix: '', pis: null, ids: null };
  const b = {};
  b.insert = (row) => { mockS.health.push({ id: ++mockS.healthSeq, status: 'new', ...row, trigger_data: typeof row.trigger_data === 'string' ? JSON.parse(row.trigger_data) : row.trigger_data }); return Promise.resolve([1]); };
  b.where = (a) => { if (typeof a === 'function') a.call(b, b); else Object.assign(f.eq, a); return b; };
  b.whereIn = (c, v) => { f.in[c] = v; return b; };
  const raw = (sql, bind) => { if (/starts_with/.test(sql)) f.prefix = bind[0]; else if (/'stripe_payment_intent_id' = ANY/.test(sql)) f.pis = bind[0]; else if (/'payment_id' = ANY/.test(sql)) f.ids = bind[0]; return b; };
  b.whereRaw = raw; b.orWhereRaw = raw;
  const hit = () => mockS.health.filter((r) => Object.entries(f.eq).every(([k, v]) => String(r[k]) === String(v))
    && Object.entries(f.in).every(([k, v]) => v.includes(r[k]))
    && String(r.trigger_data?.source || '').startsWith(f.prefix)
    && (f.pis === null || f.pis.includes(String(r.trigger_data?.stripe_payment_intent_id)) || (f.ids || []).includes(String(r.trigger_data?.payment_id))));
  b.select = () => Promise.resolve(hit().map((r) => ({ customer_id: r.customer_id, trigger_data: r.trigger_data })));
  b.update = (payload) => { const h = hit(); h.forEach((r) => Object.assign(r, payload)); return Promise.resolve(h.length); };
  return b;
}

jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    if (table === 'payments') return mockPaymentsQuery();
    if (table === 'customer_health_alerts') return mockHealthQuery();
    throw new Error(`unexpected table ${table}`);
  });
  db.fn = { now: () => 'NOW' };
  db.raw = (sql, b) => ({ sql, b });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async (_cat, title, body, opts) => {
    const row = { title, body, opts, metadata: { ...opts.metadata, dedupeKey: opts.dedupeKey }, cleared: false };
    mockS.notifications.push(row);
    return { id: mockS.notifications.length };
  }),
  _private: { doneColumns: jest.fn(() => ({})) },
}));
jest.mock('../services/admin-alert-episodes', () => ({
  openAdminAlertMetadata: jest.fn(async (_c, prefix) => mockS.notifications.filter((n) => !n.cleared && String(n.metadata.dedupeKey).startsWith(prefix)).map((n) => n.metadata)),
  closeAdminAlertKeys: jest.fn(async (_c, keys) => {
    if (mockS.closeFailures > 0) { mockS.closeFailures -= 1; throw new Error('notifications down'); }
    let n = 0;
    mockS.notifications.forEach((row) => { if (!row.cleared && keys.includes(row.metadata.dedupeKey)) { row.cleared = true; n += 1; } });
    return n;
  }),
}));

const NotificationService = require('../services/notification-service');
const adminEpisodes = require('../services/admin-alert-episodes');
const logger = require('../services/logger');
const Sca = require('../services/autopay-sca-parked');

const CUSTOMER = { id: 'cust-1', first_name: 'Pat', last_name: 'Synthetic' };
const parkedRow = (over = {}) => ({
  id: 'pay-sca-1', customer_id: 'cust-1', status: 'failed', stripe_payment_intent_id: 'pi_sca_1', amount: '89.00',
  superseded_by_payment_id: null, next_retry_at: null, payment_date: '2026-10-01',
  description: 'Silver WaveGuard Monthly — Pat Synthetic — REQUIRES AUTH',
  metadata: JSON.stringify({ billed_month: '2026-10', requires_action: true }), ...over,
});
const scaErr = (over = {}) => Object.assign(new Error('Customer authentication required'), {
  code: 'STRIPE_REQUIRES_ACTION', stripePaymentIntentId: 'pi_sca_1',
  paymentRecord: { id: 'pay-sca-1', amount: '89.00', stripe_payment_intent_id: 'pi_sca_1', metadata: JSON.stringify({ billed_month: '2026-10' }) }, ...over,
});
const replacement = (over = {}) => ({
  id: 'pay-new', customer_id: 'cust-1', status: 'paid', stripe_payment_intent_id: 'pi_new', amount: '89.00',
  superseded_by_payment_id: null, next_retry_at: null, payment_date: '2026-10-04',
  description: 'Manual charge — WaveGuard Silver', metadata: JSON.stringify({ billed_month: '2026-10', payment_state: 'paid' }), ...over,
});
const openAlerts = () => mockS.notifications.filter((n) => !n.cleared);

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(mockS, { payments: [], health: [], notifications: [], closeFailures: 0, healthSeq: 0 });
});

describe('what the alert carries (the association no longer depends on the payments row)', () => {
  test('metadata: customer, PI, payment id, billed_month, kind, amount_cents', async () => {
    await Sca.alertAutopayScaParked(CUSTOMER, scaErr(), { amount: 89, source: 'autopay', kind: 'monthly', billedMonth: '2026-10' });
    expect(openAlerts()[0].metadata).toMatchObject({
      customer_id: 'cust-1', stripe_payment_intent_id: 'pi_sca_1', payment_id: 'pay-sca-1',
      billed_month: '2026-10', kind: 'monthly', amount_cents: 8900, source: 'autopay',
    });
  });

  test('failed-row insert failed (paymentRecord null): month comes from the caller, payment id is null', async () => {
    await Sca.alertAutopayScaParked(CUSTOMER, scaErr({ paymentRecord: null }), { amount: 89, source: 'autopay', kind: 'monthly', billedMonth: '2026-10' });
    expect(openAlerts()[0].metadata).toMatchObject({ payment_id: null, stripe_payment_intent_id: 'pi_sca_1', billed_month: '2026-10', kind: 'monthly', amount_cents: 8900 });
  });

  test('the health-alert fallback carries the same association', async () => {
    NotificationService.notifyAdmin.mockResolvedValueOnce(null);
    await Sca.alertAutopayScaParked(CUSTOMER, scaErr(), { amount: 89, source: 'autopay', kind: 'monthly', billedMonth: '2026-10' });
    expect(mockS.health[0].trigger_data).toMatchObject({ customer_id: 'cust-1', stripe_payment_intent_id: 'pi_sca_1', payment_id: 'pay-sca-1', billed_month: '2026-10', kind: 'monthly', amount_cents: 8900 });
  });
});

describe('reconcileScaParkedAlerts', () => {
  test('A: a close that failed at webhook time is repaired by the next reconciler run (no Charge now, no redelivery)', async () => {
    mockS.payments = [parkedRow()];
    await Sca.alertAutopayScaParked(CUSTOMER, scaErr(), { amount: 89, source: 'autopay', kind: 'monthly', billedMonth: '2026-10' });
    // the ACH replacement settles: supersede commits, the alert close fails (swallowed; the webhook event is marked processed)
    mockS.payments.push(replacement());
    mockS.closeFailures = 2; // own-PI close and the post-supersede close both fail
    await Sca.settleParkedForPaidPayment(replacement());
    expect(mockS.payments[0].superseded_by_payment_id).toBe('pay-new'); // committed
    expect(openAlerts()).toHaveLength(1); // alert still open, still telling staff to collect paid debt

    const summary = await Sca.reconcileScaParkedAlerts(); // the daily sweep, nobody pressed anything
    expect(summary).toMatchObject({ examined: 1, collected: 1, failed: 0 });
    expect(openAlerts()).toHaveLength(0);
  });

  test('C: alert raised with paymentRecord = null: a paid replacement for that billed_month closes it from the alert metadata', async () => {
    await Sca.alertAutopayScaParked(CUSTOMER, scaErr({ paymentRecord: null }), { amount: 89, source: 'autopay', kind: 'monthly', billedMonth: '2026-10' });
    expect(mockS.payments).toHaveLength(0); // there never was a failed row
    // still owed: nothing paid yet
    await Sca.reconcileScaParkedAlerts();
    expect(openAlerts()).toHaveLength(1);
    mockS.payments.push(replacement());
    await expect(Sca.reconcileScaParkedAlerts()).resolves.toMatchObject({ collected: 1 });
    expect(openAlerts()).toHaveLength(0);
  });

  test('a month paid by ANOTHER payment also supersedes the still-open parked row, then closes the alert', async () => {
    mockS.payments = [parkedRow(), replacement()];
    await Sca.alertAutopayScaParked(CUSTOMER, scaErr(), { amount: 89, source: 'autopay', kind: 'monthly', billedMonth: '2026-10' });
    await Sca.reconcileScaParkedAlerts();
    expect(mockS.payments[0].superseded_by_payment_id).toBe('pay-new');
    expect(openAlerts()).toHaveLength(0);
  });

  test('the parked row itself becoming paid (its own PI succeeded) closes it for a monthly alert', async () => {
    mockS.payments = [parkedRow()];
    await Sca.alertAutopayScaParked(CUSTOMER, scaErr(), { amount: 89, source: 'autopay', kind: 'monthly', billedMonth: '2026-10' });
    mockS.payments[0].status = 'paid';
    await Sca.reconcileScaParkedAlerts();
    expect(openAlerts()).toHaveLength(0);
  });

  test('B: a one-time parked alert is not closed by an amount-matching replacement; it closes only when ITS row is paid or superseded', async () => {
    const oneTimeRow = parkedRow({ description: 'Pest add-on — REQUIRES AUTH', metadata: JSON.stringify({ requires_action: true }) });
    mockS.payments = [oneTimeRow];
    await Sca.alertAutopayScaParked(CUSTOMER, scaErr({ paymentRecord: { id: 'pay-sca-1', amount: '89.00', stripe_payment_intent_id: 'pi_sca_1', metadata: '{}' } }),
      { amount: 89, source: 'autopay_retry', kind: 'one_time', billedMonth: null });
    const alert = openAlerts()[0];
    expect(alert.metadata).toMatchObject({ kind: 'one_time', billed_month: null });
    expect(alert.body).toBeDefined();
    // honest wording: it does not promise automatic closure
    expect(alert.opts.detail).toMatch(/mark this done/);
    // an explicit-amount Charge now for the same amount (no billed_month): NOT linked by guessing
    mockS.payments.push(replacement({ id: 'pay-explicit', metadata: JSON.stringify({ payment_state: 'paid' }) }));
    await Sca.settleParkedForPaidPayment(replacement({ id: 'pay-explicit', metadata: JSON.stringify({ payment_state: 'paid' }) }));
    await Sca.reconcileScaParkedAlerts();
    expect(openAlerts()).toHaveLength(1);
    // hard signal: its own row is superseded (or paid)
    mockS.payments[0].superseded_by_payment_id = 'pay-explicit';
    await Sca.reconcileScaParkedAlerts();
    expect(openAlerts()).toHaveLength(0);
  });

  test('still owed: an alert with no signal is left open and untouched; other customers\' payments do not count', async () => {
    mockS.payments = [parkedRow(), replacement({ customer_id: 'cust-2', id: 'pay-other-cust' })];
    await Sca.alertAutopayScaParked(CUSTOMER, scaErr(), { amount: 89, source: 'autopay', kind: 'monthly', billedMonth: '2026-10' });
    const summary = await Sca.reconcileScaParkedAlerts();
    expect(summary).toMatchObject({ examined: 1, collected: 0, failed: 0 });
    expect(openAlerts()).toHaveLength(1);
    expect(mockS.payments[0].superseded_by_payment_id).toBeNull();
  });

  test('a collected fallback health alert is resolved by the reconciler too (bell never existed)', async () => {
    mockS.payments = [parkedRow(), replacement()];
    NotificationService.notifyAdmin.mockResolvedValueOnce(null);
    await Sca.alertAutopayScaParked(CUSTOMER, scaErr(), { amount: 89, source: 'autopay', kind: 'monthly', billedMonth: '2026-10' });
    expect(mockS.health[0].status).toBe('new');
    await Sca.reconcileScaParkedAlerts();
    expect(mockS.health[0]).toMatchObject({ status: 'resolved' });
  });

  test('idempotent: a second run examines nothing new and rewrites nothing', async () => {
    mockS.payments = [parkedRow(), replacement()];
    await Sca.alertAutopayScaParked(CUSTOMER, scaErr(), { amount: 89, source: 'autopay', kind: 'monthly', billedMonth: '2026-10' });
    await Sca.reconcileScaParkedAlerts();
    adminEpisodes.closeAdminAlertKeys.mockClear();
    await expect(Sca.reconcileScaParkedAlerts()).resolves.toEqual({ examined: 0, collected: 0, failed: 0 });
    expect(adminEpisodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('never throws: a failure reading the open alerts, or closing one, is logged and counted', async () => {
    adminEpisodes.openAdminAlertMetadata.mockRejectedValueOnce(new Error('db down'));
    await expect(Sca.reconcileScaParkedAlerts()).resolves.toMatchObject({ failed: 1 });
    expect(logger.error.mock.calls.some((c) => /could not read open alerts/.test(String(c[0])))).toBe(true);

    mockS.payments = [parkedRow(), replacement()];
    await Sca.alertAutopayScaParked(CUSTOMER, scaErr(), { amount: 89, source: 'autopay', kind: 'monthly', billedMonth: '2026-10' });
    mockS.payments.push(replacement({ id: 'pay-new-2', stripe_payment_intent_id: 'pi_2' })); // irrelevant row
    mockS.closeFailures = 5;
    await expect(Sca.reconcileScaParkedAlerts()).resolves.toBeDefined(); // close failures are logged, never thrown
    expect(logger.error).toHaveBeenCalled();
  });
});

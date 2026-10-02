/**
 * Codex round-26 P1 (PR #5331, money state): the shared Zelle eligibility predicate is asked by SMS drafting and
 * send-time rechecks. Those callers must NEVER write charge-claim state — the default (writing) mode of
 * assertNoInvoiceChargeReconciliationPending releases a stale pre-submit saved-card claim / promotes a submitted
 * one while the original charge worker can still commit, which would expose a second payment rail.
 * The public pay page GET keeps main's behavior (default), exactly as before this PR.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => {
  const dbFn = jest.fn();
  dbFn.raw = (sql) => sql;
  return dbFn;
});
jest.mock('../services/invoice', () => ({ getByToken: jest.fn() }));
jest.mock('../services/estimate-deposits', () => ({ assertInvoiceDepositSettlementReady: jest.fn(async () => {}), withInvoiceDepositSettlement: jest.fn() }));
jest.mock('../services/invoice-attachments', () => ({ list: jest.fn(async () => []) }));
jest.mock('../services/stripe', () => ({
  isAvailable: () => true,
  assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined),
  retrievePaymentIntent: jest.fn(async () => null),
  cancelPaymentIntent: jest.fn(),
  savedCardChargeSuppressesAlternateCollection: (err) => err?.code === 'STRIPE_CHARGE_IN_PROGRESS',
}));
jest.mock('../config/stripe-config', () => ({ publishableKey: 'pk_test_1' }));
jest.mock('../services/pdf/invoice-pdf', () => ({ generateInvoicePDF: jest.fn() }));
jest.mock('../services/payment-method-consents', () => ({}));
jest.mock('../services/receipt-delivery-queue', () => ({}));
jest.mock('../services/bill-payment-error-alerts', () => ({ alertBillPaymentError: jest.fn(async () => {}) }));
jest.mock('../services/payer', () => ({ attachToInvoice: jest.fn(async () => null), resolveForInvoice: jest.fn(async () => ({ payerId: null })) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false), gates: { autoApplyAccountCredit: false } }));
jest.mock('../services/open-balance', () => ({ openBalanceInvoices: jest.fn(async () => []), openBalanceSummary: jest.fn(async () => ({ total: 0, count: 0, moreCount: 0, invoices: [] })) }));
jest.mock('../services/completion-balance-sweep', () => ({ dunningStoppedInvoiceIds: jest.fn(async () => new Set()) }));

const db = require('../models/db');
const StripeService = require('../services/stripe');
const PayCombined = require('../services/pay-combined');
const payRouter = require('../routes/pay-v2');

const invoice = { id: 'inv-1', customer_id: 'c1', status: 'overdue', total: '150.00', credit_applied: 0 };
function chain(first) {
  const q = {};
  ['where', 'whereIn', 'select', 'orderBy', 'limit'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => first);
  return q;
}

beforeEach(() => {
  process.env.ZELLE_RECIPIENT = 'pay@example.com';
  db.mockReset().mockImplementation(() => chain({ billing_mode: null, monthly_rate: null }));
  StripeService.assertNoInvoiceChargeReconciliationPending.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { delete process.env.ZELLE_RECIPIENT; jest.restoreAllMocks(); });

describe('isZelleTransferEligible / payPageZelleVisibility readOnly plumbing', () => {
  test('readOnly: the charge-claim fence is asked in READ-ONLY mode, and so are the sibling fences', async () => {
    const siblings = jest.spyOn(PayCombined, 'combinedEligibleSiblings').mockResolvedValue(null);
    await expect(payRouter.isZelleTransferEligible(invoice, { readOnly: true })).resolves.toBe(true);
    expect(StripeService.assertNoInvoiceChargeReconciliationPending).toHaveBeenCalledWith('inv-1', db, { readOnly: true });
    expect(siblings).toHaveBeenCalledWith(invoice, expect.objectContaining({ readOnly: true }));
  });
  test('payPageZelleVisibility passes readOnly through (the SMS entry point)', async () => {
    const siblings = jest.spyOn(PayCombined, 'combinedEligibleSiblings').mockResolvedValue(null);
    const out = await payRouter.payPageZelleVisibility({ invoice, readOnly: true, creditWillCoverAnchor: false });
    expect(out.visible).toBe(true);
    expect(StripeService.assertNoInvoiceChargeReconciliationPending).toHaveBeenCalledWith('inv-1', db, { readOnly: true });
    expect(siblings).toHaveBeenCalledWith(invoice, expect.objectContaining({ readOnly: true }));
  });
  test('default (the public pay page GET): main\'s behavior is unchanged — the plain single-argument call, no readOnly on siblings', async () => {
    const siblings = jest.spyOn(PayCombined, 'combinedEligibleSiblings').mockResolvedValue(null);
    await payRouter.payPageZelleVisibility({ invoice, creditWillCoverAnchor: false });
    expect(StripeService.assertNoInvoiceChargeReconciliationPending).toHaveBeenCalledWith('inv-1');
    expect(siblings.mock.calls[0][1]).not.toHaveProperty('readOnly');
  });
  test('a fenced claim still withholds Zelle in read-only mode (STRIPE_CHARGE_IN_PROGRESS => not eligible)', async () => {
    jest.spyOn(PayCombined, 'combinedEligibleSiblings').mockResolvedValue(null);
    StripeService.assertNoInvoiceChargeReconciliationPending.mockRejectedValue(Object.assign(new Error('in progress'), { code: 'STRIPE_CHARGE_IN_PROGRESS' }));
    await expect(payRouter.isZelleTransferEligible(invoice, { readOnly: true })).resolves.toBe(false);
  });
});

describe('SMS callers pass readOnly (the two entry points)', () => {
  test('zelleInvoiceStillEligible (the one eligibility read: send-time rechecks) => payPageZelleVisibility({ readOnly: true })', () => {
    const src = require('fs').readFileSync(require.resolve('../services/sms-amount-recheck'), 'utf8');
    expect(src).toMatch(/payPageZelleVisibility\(\{ invoice: invoiceRow, dbh, readOnly: true \}\)/);
  });
  test('liveZelleFacts (draft time AND send time) reads eligibility only through zelleInvoiceStillEligible, so it is read-only too', () => {
    const src = require('fs').readFileSync(require.resolve('../services/sms-amount-recheck'), 'utf8');
    const live = src.slice(src.indexOf('async function liveZelleFacts'), src.indexOf('// Cheap, read-free pre-screen'));
    expect(live).toMatch(/await zelleInvoiceStillEligible\(\{ customerId, zelleInvoiceId: invoiceId, dbh \}\)/);
    expect(live).not.toMatch(/payPageZelleVisibility/);
  });
  test('the drafter asks liveZelleFacts (no eligibility lookup of its own, no direct pay-page call)', () => {
    const src = require('fs').readFileSync(require.resolve('../services/sms-shadow-drafter'), 'utf8');
    expect(src).toMatch(/require\('\.\/sms-amount-recheck'\)\.liveZelleFacts\(/);
    expect(src).not.toMatch(/payPageZelleVisibility/);
    expect(src).not.toMatch(/fetchZelleEligibility/);
  });
  test('the public GET route does not opt in (main\'s behavior)', () => {
    const src = require('fs').readFileSync(require.resolve('../routes/pay-v2'), 'utf8');
    const getRoute = src.slice(src.indexOf("router.get('/:token'"), src.indexOf("router.get('/:token'") + 20000);
    expect(getRoute).not.toMatch(/payPageZelleVisibility\([^)]*readOnly/);
  });
});

describe('the real fence: read-only never writes; the default mode does', () => {
  const realStripeFence = () => {
    let fence;
    jest.isolateModules(() => {
      jest.dontMock('../services/stripe');
      jest.doMock('stripe', () => jest.fn(() => ({})));
      fence = jest.requireActual('../services/stripe').assertNoInvoiceChargeReconciliationPending;
    });
    return fence;
  };
  const staleClaim = { id: 'att-1', status: 'claimed', created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), submitted_at: null, stripe_payment_intent_id: null, idempotency_key: 'k' };
  const fakeDb = (claim) => {
    const writes = [];
    const builder = (table) => {
      const b = {};
      for (const m of ['where', 'whereIn', 'whereNull', 'whereNot', 'whereRaw', 'orWhereNull', 'orderBy', 'limit', 'select', 'whereNotNull', 'whereColumn']) b[m] = jest.fn(() => b);
      b.first = jest.fn(async () => (table === 'stripe_invoice_charge_attempts' ? claim : null));
      for (const m of ['update', 'insert', 'del', 'delete']) b[m] = jest.fn(async () => { writes.push([table, m]); return 1; });
      return b;
    };
    const database = jest.fn(builder);
    database.raw = (x) => x;
    database.fn = { now: () => 'now' };
    database.writes = writes;
    return database;
  };
  test('stale PRE-submit claim, readOnly: fenced as IN PROGRESS and NOTHING is written', async () => {
    const fence = realStripeFence();
    const database = fakeDb(staleClaim);
    await expect(fence('inv-1', database, { readOnly: true })).rejects.toMatchObject({ code: 'STRIPE_CHARGE_IN_PROGRESS' });
    expect(database.writes).toEqual([]);
  });
  test('stale SUBMITTED claim, readOnly: reads as AMBIGUOUS and NOTHING is written', async () => {
    const fence = realStripeFence();
    const database = fakeDb({ ...staleClaim, submitted_at: new Date().toISOString() });
    await expect(fence('inv-1', database, { readOnly: true })).rejects.toMatchObject({ code: 'STRIPE_AMBIGUOUS_OUTCOME' });
    expect(database.writes).toEqual([]);
  });
  test('control: the DEFAULT (writing) mode releases the same stale pre-submit claim — the write the SMS paths must never make', async () => {
    const fence = realStripeFence();
    const database = fakeDb(staleClaim);
    await fence('inv-1', database).catch(() => {});
    expect(database.writes.some(([table, m]) => table === 'stripe_invoice_charge_attempts' && m === 'update')).toBe(true);
  });
});

// Codex round-57 P1: for the SMS (read-only) path, a DEGRADED sibling read is unverified sibling debt - Zelle is denied
describe('degraded sibling resolution (read-only callers)', () => {
  const degradeWith = (reason) => jest.spyOn(PayCombined, 'combinedEligibleSiblings').mockImplementation(async (inv, opts) => { opts.onDegrade?.(reason); return null; });
  test.each(['incomplete', 'over_cap', 'payer_unresolved'])('%s => not eligible', async (reason) => {
    degradeWith(reason);
    await expect(payRouter.isZelleTransferEligible(invoice, { readOnly: true })).resolves.toBe(false);
  });
  test.each(['none', 'gate_off'])('%s => still eligible (genuinely no siblings)', async (reason) => {
    degradeWith(reason);
    await expect(payRouter.isZelleTransferEligible(invoice, { readOnly: true })).resolves.toBe(true);
  });
  test('the pay page GET (not read-only) is unchanged: no onDegrade is passed', async () => {
    const siblings = jest.spyOn(PayCombined, 'combinedEligibleSiblings').mockResolvedValue(null);
    await payRouter.payPageZelleVisibility({ invoice, creditWillCoverAnchor: false });
    expect(siblings.mock.calls[0][1]).not.toHaveProperty('onDegrade');
  });
});

// Codex round-61 P1: the pay page reads the Zelle recipient AGAIN after the eligibility awaits
test('the pay page GET re-reads the recipient after payPageZelleVisibility (never the value captured before its awaits)', () => {
  const src = require('fs').readFileSync(require.resolve('../routes/pay-v2'), 'utf8');
  const vis = src.indexOf('const zelleVisibility = await payPageZelleVisibility({');
  const reread = src.indexOf('manualPayOptions = manualPayOptionsFromEnv();', vis);
  expect(vis).toBeGreaterThan(-1);
  expect(reread).toBeGreaterThan(vis);
  expect(src).not.toContain('manualPayOptions = configuredManualPayOptions;');
});

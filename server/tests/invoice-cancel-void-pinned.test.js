/**
 * The cancel void sweep in its card-confirmed (pinned) mode, and the
 * read-only preview the Intelligence Bar card pins from. Same fixtures
 * through both: the preview's invoice set is what an unpinned sweep voids,
 * and a pinned sweep voids ONLY the pinned invoices at the pinned amounts —
 * an invoice created after the card, or one whose amounts moved (checked
 * before any Stripe call and again under the row lock), is left open.
 * Synthetic ids/amounts only; every collaborator is mocked.
 */
let mockInvoiceRows = [];
let mockLockedOverride = {};
let mockOtherRows = {};
const mockUpdates = [];
jest.mock('../models/db', () => {
  const makeChain = (table) => {
    const state = { whereObj: null, idIn: null };
    const chain = {};
    for (const m of ['whereNotIn', 'whereRaw', 'orderBy', 'forUpdate', 'whereNull', 'orWhereIn']) chain[m] = jest.fn(() => chain);
    chain.whereNot = jest.fn((col, val) => { if (col === 'id') state.notId = String(val); return chain; });
    chain.where = jest.fn((arg) => {
      if (arg && typeof arg === 'object') state.whereObj = { ...(state.whereObj || {}), ...arg };
      return chain;
    });
    chain.whereIn = jest.fn((col, vals) => {
      if (col === 'id') state.idIn = vals.map(String);
      return chain;
    });
    chain.select = jest.fn(() => chain);
    const rows = () => {
      if (table !== 'invoices') return mockOtherRows[table] || [];
      let r = mockInvoiceRows;
      if (state.idIn) r = r.filter((x) => state.idIn.includes(String(x.id)));
      if (state.whereObj?.id) r = r.filter((x) => String(x.id) === String(state.whereObj.id));
      if (state.whereObj?.stripe_payment_intent_id) r = r.filter((x) => x.stripe_payment_intent_id === state.whereObj.stripe_payment_intent_id);
      if (state.notId) r = r.filter((x) => String(x.id) !== state.notId);
      return r;
    };
    chain.then = (res, rej) => Promise.resolve(rows()).then(res, rej);
    chain.first = jest.fn(async () => {
      const r = rows()[0];
      return r ? { ...r, ...(mockLockedOverride[r.id] || {}) } : null;
    });
    chain.update = jest.fn((patch) => {
      mockUpdates.push({ table, id: state.whereObj?.id, patch });
      return { returning: async () => { const r = rows()[0]; return r ? [{ ...r, ...patch }] : []; } };
    });
    return chain;
  };
  const db = jest.fn((t) => makeChain(t));
  // db.transaction(cb) runs the callback; db.transaction() (no callback) hands back a manual transaction - the pinned
  // sweep's combined-payment lock - whose queries and advisory-lock raw() are recorded like any other.
  db.transaction = jest.fn(async (cb) => {
    if (cb) return cb(db);
    const lockTrx = (t) => makeChain(t);
    lockTrx.raw = db.raw;
    lockTrx.commit = jest.fn(async () => {});
    lockTrx.rollback = jest.fn(async () => {});
    db.__lockTrx = lockTrx;
    return lockTrx;
  });
  db.fn = { now: () => 'NOW' };
  db.raw = jest.fn((x) => x);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/estimate-deposits', () => ({ restoreDepositCreditForVoidedInvoice: jest.fn(async () => 0) }));
jest.mock('../services/customer-credit', () => ({ restoreAccountCreditForVoidedInvoice: jest.fn(async () => {}) }));
const mockReverse = jest.fn(async () => ({ reversed: 0 }));
jest.mock('../services/inspection-credit', () => ({ reverseInspectionCreditForBooking: (...a) => mockReverse(...a) }));
jest.mock('../services/annual-prepay-renewals', () => ({
  syncTermForInvoicePayment: jest.fn(async () => {}),
  acquireTermiteGateAtEntry: jest.fn(async () => {}),
}));
const mockStopSequence = jest.fn(async () => {});
jest.mock('../services/invoice-followups', () => ({ stopSequence: (...a) => mockStopSequence(...a) }));
const mockChargeFence = jest.fn(async () => {});
jest.mock('../services/stripe', () => ({
  retrievePaymentIntent: jest.fn(), cancelPaymentIntent: jest.fn(),
  assertNoInvoiceChargeReconciliationPending: (...a) => mockChargeFence(...a),
}));

const mockFence = jest.fn(async () => {});
jest.mock('../services/cancel-generation-fence', () => ({ assertCancelGeneration: (...a) => mockFence(...a) }));

const InvoiceService = require('../services/invoice');
const db = require('../models/db');

const deposit = (amt) => JSON.stringify([{ category: 'service', amount: 125 }, { category: 'deposit_credit', amount: -amt, estimate_id: 'est-1' }]);
const INV_A = { id: 'inv-a', invoice_number: 'WPC-TEST-1', status: 'sent', total: '50.00', credit_applied: '0.00', line_items: deposit(75), scheduled_service_id: 'svc-1' };
const INV_B = { id: 'inv-b', invoice_number: 'WPC-TEST-2', status: 'draft', total: '20.00', credit_applied: '5.00', line_items: '[]', scheduled_service_id: 'svc-1' };
const voidedIds = () => mockUpdates.filter((u) => u.table === 'invoices' && u.patch.status === 'void').map((u) => u.id);

beforeEach(() => {
  jest.clearAllMocks();
  mockInvoiceRows = [INV_A, INV_B];
  mockLockedOverride = {};
  mockOtherRows = {};
  mockUpdates.length = 0;
  mockFence.mockReset();
  mockFence.mockResolvedValue(undefined);
  jest.spyOn(InvoiceService, 'restoreRodentSetupObligationForReversedInvoice').mockResolvedValue(undefined);
});

test('the preview pins each invoice with total, account credit and deposit credit — and an unpinned sweep voids that same set', async () => {
  const preview = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
  expect(preview).toEqual([
    { id: 'inv-a', invoice_number: 'WPC-TEST-1', status: 'sent', payment_intent: false, total: 50, credit_applied: 0, deposit_credit: 75 },
    { id: 'inv-b', invoice_number: 'WPC-TEST-2', status: 'draft', payment_intent: false, total: 20, credit_applied: 5, deposit_credit: 0 },
  ]);
  const voided = await InvoiceService.voidOpenInvoicesForCancelledService('svc-1');
  expect([...voided]).toEqual(preview.map((p) => p.id));
  expect(mockReverse).toHaveBeenCalledWith({ scheduledServiceId: 'svc-1', createdBy: 'system:inspection_credit_cancellation_void_hook' });
});

test('a pinned sweep voids only the pinned invoices — one created after the card stays open', async () => {
  const pinned = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
  mockInvoiceRows = [INV_A, INV_B, { id: 'inv-late', invoice_number: 'WPC-TEST-3', status: 'draft', total: '99.00', credit_applied: '0', line_items: '[]' }];
  const voided = await InvoiceService.voidOpenInvoicesForCancelledService('svc-1', { pinnedInvoices: pinned, pinnedCreditReversalOfferIds: ['offer-1'] });
  expect([...voided]).toEqual(['inv-a', 'inv-b']);
  expect(voidedIds()).not.toContain('inv-late');
  expect(mockReverse).toHaveBeenCalledWith(expect.objectContaining({ scheduledServiceId: 'svc-1', pinnedReversalOfferIds: ['offer-1'] }));
});

test('a pinned invoice whose deposit moved after the card is skipped BEFORE any Stripe call', async () => {
  const pinned = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
  mockInvoiceRows = [{ ...INV_A, line_items: deposit(60), stripe_payment_intent_id: 'pi_test' }, INV_B];
  const voided = await InvoiceService.voidOpenInvoicesForCancelledService('svc-1', { pinnedInvoices: pinned });
  expect([...voided]).toEqual(['inv-b']);
  expect(require('../services/stripe').retrievePaymentIntent).not.toHaveBeenCalled();
});

test('a pinned invoice whose amounts moved between the scan and the row lock is not voided', async () => {
  const pinned = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
  mockLockedOverride = { 'inv-a': { total: '65.00' } };
  const voided = await InvoiceService.voidOpenInvoicesForCancelledService('svc-1', { pinnedInvoices: pinned });
  expect([...voided]).toEqual(['inv-b']);
  expect(voidedIds()).toEqual(['inv-b']);
});

test('an empty pin voids nothing but still runs the (pinned) credit reversal', async () => {
  const voided = await InvoiceService.voidOpenInvoicesForCancelledService('svc-1', { pinnedInvoices: [], pinnedCreditReversalOfferIds: [] });
  expect([...voided]).toEqual([]);
  expect(mockReverse).toHaveBeenCalledWith(expect.objectContaining({ pinnedReversalOfferIds: [] }));
});

test('a pinned invoice that gained a card PaymentIntent since the card is left alone — no Stripe call, no void', async () => {
  const pinned = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
  mockInvoiceRows = [INV_A, { ...INV_B, stripe_payment_intent_id: 'pi_test' }];
  const stripe = require('../services/stripe');
  stripe.retrievePaymentIntent.mockResolvedValue({ status: 'requires_payment_method' });
  const voided = await InvoiceService.voidOpenInvoicesForCancelledService('svc-1', { pinnedInvoices: pinned });
  expect([...voided]).toEqual(['inv-a']);
  expect(stripe.retrievePaymentIntent).not.toHaveBeenCalled();
  expect(stripe.cancelPaymentIntent).not.toHaveBeenCalled();
});

// Opt-in piCache (the Intelligence Bar cancel check under the visit lock): PaymentIntents looked up before the lock
// are reused, and with piCacheOnly an uncached one throws instead of calling Stripe while the lock is held.
describe('previewInvoiceVoidForCancelledService piCache', () => {
  const withPi = () => { mockInvoiceRows = [{ ...INV_A, stripe_payment_intent_id: 'pi_test' }, INV_B]; };

  test('without a cache every call retrieves the PaymentIntent (unchanged)', async () => {
    withPi();
    const stripe = require('../services/stripe');
    stripe.retrievePaymentIntent.mockResolvedValue({ status: 'requires_payment_method' });
    await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
    await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
    expect(stripe.retrievePaymentIntent).toHaveBeenCalledTimes(2);
  });

  test('a cache fills on the first (pre-lock) call and the cache-only call under the lock makes NO Stripe call', async () => {
    withPi();
    const stripe = require('../services/stripe');
    stripe.retrievePaymentIntent.mockResolvedValue({ status: 'requires_payment_method' });
    const piCache = new Map();
    const before = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1', { piCache });
    expect(stripe.retrievePaymentIntent).toHaveBeenCalledTimes(1);
    expect(piCache.get('pi_test')).toEqual({ status: 'requires_payment_method' });
    const inLock = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1', { piCache, piCacheOnly: true });
    expect(stripe.retrievePaymentIntent).toHaveBeenCalledTimes(1);
    expect(inLock).toEqual(before);
  });

  test('a PaymentIntent that appeared after the pre-lock check cannot be verified under the lock: it throws, no Stripe call', async () => {
    mockInvoiceRows = [INV_A, INV_B];
    const piCache = new Map();
    await InvoiceService.previewInvoiceVoidForCancelledService('svc-1', { piCache });
    withPi();
    const stripe = require('../services/stripe');
    await expect(InvoiceService.previewInvoiceVoidForCancelledService('svc-1', { piCache, piCacheOnly: true })).rejects.toThrow(/was not checked before the lock/);
    expect(stripe.retrievePaymentIntent).not.toHaveBeenCalled();
  });

  test('a cached in-flight PaymentIntent still excludes the invoice from the void set', async () => {
    withPi();
    const piCache = new Map([['pi_test', { status: 'processing' }]]);
    const set = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1', { piCache, piCacheOnly: true });
    expect(set.map((i) => i.id)).toEqual(['inv-b']);
  });
});

// A card that approved cancelling an invoice's open card payment attempt names that exact PaymentIntent
// (payment_intent_id). The pinned sweep cancels and voids only that one, re-checked under the invoice row lock.
describe('pinned sweep and an approved PaymentIntent', () => {
  const stripe = require('../services/stripe');
  const withPi = (id = 'pi_test') => { mockInvoiceRows = [{ ...INV_A, stripe_payment_intent_id: id }, INV_B]; };

  test('the preview names the PaymentIntent the void would cancel (only when there is one)', async () => {
    withPi();
    stripe.retrievePaymentIntent.mockResolvedValue({ status: 'requires_payment_method' });
    const preview = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
    expect(preview.find((i) => i.id === 'inv-a')).toMatchObject({ payment_intent: true, payment_intent_id: 'pi_test' });
    expect(preview.find((i) => i.id === 'inv-b')).not.toHaveProperty('payment_intent_id');
  });

  test('the approved PaymentIntent is cancelled at Stripe and its invoice voided', async () => {
    withPi();
    stripe.retrievePaymentIntent.mockResolvedValue({ status: 'requires_payment_method' });
    const pinned = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
    const voided = await InvoiceService.voidOpenInvoicesForCancelledService('svc-1', { pinnedInvoices: pinned });
    expect([...voided]).toEqual(['inv-a', 'inv-b']);
    expect(stripe.cancelPaymentIntent).toHaveBeenCalledTimes(1);
    expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi_test', expect.anything());
  });

  test('a DIFFERENT PaymentIntent attached since the card is left alone: no Stripe call, no void', async () => {
    withPi();
    stripe.retrievePaymentIntent.mockResolvedValue({ status: 'requires_payment_method' });
    const pinned = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
    stripe.retrievePaymentIntent.mockClear();
    withPi('pi_other');
    const voided = await InvoiceService.voidOpenInvoicesForCancelledService('svc-1', { pinnedInvoices: pinned });
    expect([...voided]).toEqual(['inv-b']);
    expect(stripe.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(stripe.cancelPaymentIntent).not.toHaveBeenCalled();
  });

  test('a PaymentIntent that went in flight after the card is NOT cancelled and the invoice is left open', async () => {
    withPi();
    stripe.retrievePaymentIntent.mockResolvedValueOnce({ status: 'requires_payment_method' });
    const pinned = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
    stripe.retrievePaymentIntent.mockResolvedValue({ status: 'processing' });
    const voided = await InvoiceService.voidOpenInvoicesForCancelledService('svc-1', { pinnedInvoices: pinned });
    expect([...voided]).toEqual(['inv-b']);
    expect(stripe.cancelPaymentIntent).not.toHaveBeenCalled();
  });
});

// A PaymentIntent that also covers another invoice (a combined payment) is never cancelled by a card-confirmed cancel:
// cancelling it would clear the stamps on invoices the card did not list.
describe('combined payments', () => {
  const stripe = require('../services/stripe');
  const combined = () => { mockInvoiceRows = [{ ...INV_A, stripe_payment_intent_id: 'pi_shared' }, { ...INV_B, stripe_payment_intent_id: 'pi_shared', scheduled_service_id: 'svc-other' }]; };

  test('the preview flags the invoice whose PaymentIntent also rides another invoice (combined_payment), and no other', async () => {
    mockInvoiceRows = [{ ...INV_A, stripe_payment_intent_id: 'pi_solo' }, INV_B];
    stripe.retrievePaymentIntent.mockResolvedValue({ status: 'requires_payment_method' });
    const solo = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
    expect(solo.find((i) => i.id === 'inv-a')).not.toHaveProperty('combined_payment');
    combined();
    mockInvoiceRows[1].scheduled_service_id = 'svc-1';
    const shared = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
    expect(shared.find((i) => i.id === 'inv-a')).toMatchObject({ payment_intent_id: 'pi_shared', combined_payment: true });
  });

  test('the pinned sweep leaves a combined payment alone: no Stripe call, no void, no stamp cleared', async () => {
    mockInvoiceRows = [{ ...INV_A, stripe_payment_intent_id: 'pi_shared' }];
    stripe.retrievePaymentIntent.mockResolvedValue({ status: 'requires_payment_method' });
    const pinned = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
    stripe.retrievePaymentIntent.mockClear();
    stripe.cancelPaymentIntent.mockClear();
    // A sibling invoice (another visit) now rides the same PaymentIntent.
    mockInvoiceRows = [{ ...INV_A, stripe_payment_intent_id: 'pi_shared' }, { ...INV_B, id: 'inv-sibling', stripe_payment_intent_id: 'pi_shared', scheduled_service_id: 'svc-other' }];
    const voided = await InvoiceService.voidOpenInvoicesForCancelledService('svc-1', { pinnedInvoices: pinned });
    expect([...voided]).toEqual([]);
    expect(stripe.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(voidedIds()).toEqual([]);
  });

  test('an UNPINNED sweep (Dispatch) is unchanged by the combined-payment check', async () => {
    combined();
    stripe.retrievePaymentIntent.mockResolvedValue({ status: 'requires_payment_method' });
    await InvoiceService.voidOpenInvoicesForCancelledService('svc-1');
    expect(stripe.retrievePaymentIntent).toHaveBeenCalled();
  });
});

// The pinned sweep serializes with combined setup: the sibling check, the Stripe cancel and the stamp clear all run
// under the same per-customer pay.combined.customer advisory lock the combined session setup takes.
describe('pinned sweep takes the combined-payment lock', () => {
  test('the lock is released BEFORE the post-commit follow-up stop (which takes the same customer lock itself)', async () => {
    const stripe = require('../services/stripe');
    const db = require('../models/db');
    mockInvoiceRows = [{ ...INV_A, customer_id: 'cust-1', stripe_payment_intent_id: 'pi_test' }];
    stripe.retrievePaymentIntent.mockResolvedValue({ status: 'requires_payment_method' });
    const pinned = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
    const order = [];
    mockStopSequence.mockImplementation(async () => { order.push('stop-followups'); });
    const origTransaction = db.transaction.getMockImplementation();
    db.transaction.mockImplementation(async (cb) => {
      const out = await origTransaction(cb);
      if (!cb) out.commit = jest.fn(async () => { order.push('release-lock'); });
      return out;
    });
    await InvoiceService.voidOpenInvoicesForCancelledService('svc-1', { pinnedInvoices: pinned });
    db.transaction.mockImplementation(origTransaction);
    expect(order).toEqual(['release-lock', 'stop-followups']);
    mockStopSequence.mockImplementation(async () => {});
  });

  const stripe = require('../services/stripe');
  const db = require('../models/db');
  const lockCalls = () => db.raw.mock.calls.filter((c) => String(c[0]).includes('pg_advisory_xact_lock') && c[1]?.[0] === 'pay.combined.customer');

  beforeEach(() => { db.raw.mockClear(); stripe.retrievePaymentIntent.mockReset(); stripe.cancelPaymentIntent.mockReset(); });

  test('the lock for the invoice\'s customer is taken BEFORE the Stripe cancel and released after the candidate settles', async () => {
    mockInvoiceRows = [{ ...INV_A, customer_id: 'cust-1', stripe_payment_intent_id: 'pi_test' }];
    stripe.retrievePaymentIntent.mockResolvedValue({ status: 'requires_payment_method' });
    const pinned = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
    const order = [];
    db.raw.mockImplementation((sql, bindings) => { if (bindings?.[0] === 'pay.combined.customer') order.push(`lock:${bindings[1]}`); return sql; });
    stripe.cancelPaymentIntent.mockImplementation(async () => { order.push('stripe-cancel'); });
    const voided = await InvoiceService.voidOpenInvoicesForCancelledService('svc-1', { pinnedInvoices: pinned });
    expect([...voided]).toEqual(['inv-a']);
    expect(order).toEqual(['lock:cust-1', 'stripe-cancel']);
    expect(db.__lockTrx.commit).toHaveBeenCalledTimes(1);
    db.raw.mockImplementation((x) => x);
  });

  test('a pinned invoice with no PaymentIntent takes no lock and opens no extra transaction', async () => {
    mockInvoiceRows = [INV_B];
    const pinned = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
    db.raw.mockClear();
    db.__lockTrx = undefined;
    await InvoiceService.voidOpenInvoicesForCancelledService('svc-1', { pinnedInvoices: pinned });
    expect(lockCalls()).toHaveLength(0);
    expect(db.__lockTrx).toBeUndefined();
  });

  test('a sibling found under the lock refuses the cancel, and the lock is still released', async () => {
    mockInvoiceRows = [{ ...INV_A, customer_id: 'cust-1', stripe_payment_intent_id: 'pi_test' }];
    stripe.retrievePaymentIntent.mockResolvedValue({ status: 'requires_payment_method' });
    const pinned = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
    mockInvoiceRows = [...mockInvoiceRows, { ...INV_B, id: 'inv-sibling', stripe_payment_intent_id: 'pi_test', scheduled_service_id: 'svc-other' }];
    const voided = await InvoiceService.voidOpenInvoicesForCancelledService('svc-1', { pinnedInvoices: pinned });
    expect([...voided]).toEqual([]);
    expect(lockCalls()).toHaveLength(1);
    expect(stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(db.__lockTrx.commit).toHaveBeenCalledTimes(1);
  });

  test('Dispatch\'s unpinned sweep takes no combined-payment lock', async () => {
    mockInvoiceRows = [{ ...INV_A, customer_id: 'cust-1', stripe_payment_intent_id: 'pi_test' }];
    stripe.retrievePaymentIntent.mockResolvedValue({ status: 'requires_payment_method' });
    await InvoiceService.voidOpenInvoicesForCancelledService('svc-1');
    expect(lockCalls()).toHaveLength(0);
  });
});

// Downstream billing effects (a rodent setup-fee line or claim, an annual-prepay invoice, a membership-dues stamp) were
// refused at preview. An invoice edited after the final preview can keep its amounts and still gain one, so the pinned
// void repeats the check on the locked invoice row and skips the void on drift.
describe('pinned void rechecks downstream billing effects under the invoice lock', () => {
  const SETUP = [{ description: 'Bait Station Setup — one-time setup fee', amount: 150 }];
  const run = async () => {
    const pinned = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
    return { pinned, voided: [...(await InvoiceService.voidOpenInvoicesForCancelledService('svc-1', { pinnedInvoices: pinned }))] };
  };

  test.each([
    ['gained a rodent setup-fee line', () => { mockLockedOverride['inv-b'] = { line_items: SETUP }; }],
    ['gained a membership-dues stamp', () => { mockLockedOverride['inv-b'] = { line_items: [{ description: 'Dues', membership_dues_month: '2026-11' }] }; }],
    ['gained a setup-fee claim', () => { mockOtherRows.setup_fee_claims = [{ id: 'claim-1' }]; }],
    ['became an annual-prepay invoice', () => { mockOtherRows.annual_prepay_terms = [{ id: 'term-1' }]; }],
  ])('an invoice that %s since the card is NOT voided (reported by the follow-through as not carried out)', async (_label, drift) => {
    mockInvoiceRows = [INV_B];
    const pinned = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
    drift();
    const voided = [...(await InvoiceService.voidOpenInvoicesForCancelledService('svc-1', { pinnedInvoices: pinned }))];
    expect(voided).toEqual([]);
    expect(voidedIds()).toEqual([]);
  });

  // The crash state: a worker died after submitting a saved-card charge to Stripe, so the invoice is still 'sent' with no
  // PaymentIntent and no payments row, but an unresolved submitted claim exists. The pinned void must refuse it.
  test.each([
    ['an ambiguous submitted claim', { code: 'STRIPE_AMBIGUOUS_OUTCOME', reconciliationRequired: true }],
    ['a saved-card charge in progress', { code: 'STRIPE_CHARGE_IN_PROGRESS' }],
    ['an unresolved orphan charge', { code: 'STRIPE_CHARGED_DB_FAILED', reconciliationRequired: true }],
  ])('an invoice with %s is NOT voided by the pinned sweep (the invoice stays open)', async (_label, fence) => {
    mockInvoiceRows = [INV_B];
    const pinned = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
    mockChargeFence.mockRejectedValueOnce(Object.assign(new Error('charge pending'), fence));
    const voided = [...(await InvoiceService.voidOpenInvoicesForCancelledService('svc-1', { pinnedInvoices: pinned }))];
    expect(voided).toEqual([]);
    expect(voidedIds()).toEqual([]);
    // Read-only, on the void transaction, for this invoice.
    expect(mockChargeFence).toHaveBeenCalledWith('inv-b', expect.anything(), { readOnly: true });
  });

  // The bar's void_invoice rules, run on the locked row by the shared classifier (invoice-void-classifier.js): an invoice that
  // gained a charge marker, a paid date or an active payment plan after the card is left open (reported by the follow-through).
  test.each([
    ['a Stripe charge id (stripe_charge_id)', () => { mockLockedOverride['inv-b'] = { stripe_charge_id: 'ch_test' }; }],
    ['a paid date (paid_at)', () => { mockLockedOverride['inv-b'] = { paid_at: '2026-10-20T12:00:00Z' }; }],
    ['a recorded payment (payment_recorded_at)', () => { mockLockedOverride['inv-b'] = { payment_recorded_at: '2026-10-20T12:00:00Z' }; }],
    ['an active payment plan', () => { mockOtherRows.payment_plans = [{ id: 'plan-1', status: 'active' }]; }],
  ])('an invoice that gained %s since the card is NOT voided by the pinned sweep', async (_label, drift) => {
    mockInvoiceRows = [INV_B];
    const pinned = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
    drift();
    const voided = [...(await InvoiceService.voidOpenInvoicesForCancelledService('svc-1', { pinnedInvoices: pinned }))];
    expect(voided).toEqual([]);
    expect(voidedIds()).toEqual([]);
  });

  test("the same markers do not stop Dispatch's unpinned sweep (unchanged)", async () => {
    mockInvoiceRows = [INV_B];
    mockLockedOverride['inv-b'] = { stripe_charge_id: 'ch_test', paid_at: '2026-10-20T12:00:00Z' };
    mockOtherRows.payment_plans = [{ id: 'plan-1', status: 'active' }];
    expect([...(await InvoiceService.voidOpenInvoicesForCancelledService('svc-1'))]).toEqual(['inv-b']);
  });

  test('a fence read that FAILS (not a reconciliation verdict) also leaves the invoice open', async () => {
    mockInvoiceRows = [INV_B];
    const pinned = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
    mockChargeFence.mockRejectedValueOnce(new Error('connection terminated'));
    expect([...(await InvoiceService.voidOpenInvoicesForCancelledService('svc-1', { pinnedInvoices: pinned }))]).toEqual([]);
    expect(voidedIds()).toEqual([]);
  });

  test("Dispatch's unpinned sweep does not run the charge fence (unchanged)", async () => {
    mockInvoiceRows = [INV_B];
    mockChargeFence.mockRejectedValue(Object.assign(new Error('charge pending'), { code: 'STRIPE_AMBIGUOUS_OUTCOME', reconciliationRequired: true }));
    expect([...(await InvoiceService.voidOpenInvoicesForCancelledService('svc-1'))]).toEqual(['inv-b']);
    expect(mockChargeFence).not.toHaveBeenCalled();
    mockChargeFence.mockReset().mockResolvedValue(undefined);
  });

  test('an unchanged plain invoice is still voided', async () => {
    mockInvoiceRows = [INV_B];
    expect((await run()).voided).toEqual(['inv-b']);
  });

  test('Dispatch\'s unpinned sweep does not run the check (it voids as before)', async () => {
    mockInvoiceRows = [INV_B];
    mockLockedOverride['inv-b'] = { line_items: SETUP };
    const voided = [...(await InvoiceService.voidOpenInvoicesForCancelledService('svc-1'))];
    expect(voided).toEqual(['inv-b']);
  });
});

// If preparing the combined-payment lock fails, the manual transaction is rolled back and the error surfaces (the
// candidate is logged and left open) - no leaked connection or advisory lock.
describe('combined-payment lock preparation failure', () => {
  const stripe = require('../services/stripe');
  const db = require('../models/db');

  test('a failing advisory lock rolls the manual transaction back, calls no Stripe, and voids nothing', async () => {
    mockInvoiceRows = [{ ...INV_A, customer_id: 'cust-1', stripe_payment_intent_id: 'pi_test' }];
    stripe.retrievePaymentIntent.mockReset().mockResolvedValue({ status: 'requires_payment_method' });
    stripe.cancelPaymentIntent.mockReset();
    const pinned = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
    stripe.retrievePaymentIntent.mockClear();
    db.raw.mockImplementation((sql, bindings) => {
      if (bindings?.[0] === 'pay.combined.customer') throw new Error('lock timeout');
      return sql;
    });
    const voided = await InvoiceService.voidOpenInvoicesForCancelledService('svc-1', { pinnedInvoices: pinned });
    db.raw.mockImplementation((x) => x);
    expect([...voided]).toEqual([]);
    expect(db.__lockTrx.rollback).toHaveBeenCalledTimes(1);
    expect(db.__lockTrx.commit).not.toHaveBeenCalled();
    expect(stripe.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(stripe.cancelPaymentIntent).not.toHaveBeenCalled();
  });
});

// Recovery sweep only (services/cancel-generation-fence.js): every void re-proves, inside its own transaction and under
// the invoice row lock, that the visit is still the cancelled one the card approved; a pre-check keeps Stripe untouched.
describe('cancelFence (the cancel recovery sweep)', () => {
  const FENCE = { visitId: 'svc-1', restorations: 0, hits: [] };
  const refuse = (reason) => Object.assign(new Error(`cancellation fence: ${reason}`), { code: 'CANCEL_FENCE', fenceReason: reason });
  const sweep = async () => {
    const pinned = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
    require('../services/stripe').retrievePaymentIntent.mockClear(); // the card's preview looks the PaymentIntent up; the sweep must not
    return InvoiceService.voidOpenInvoicesForCancelledService('svc-1', { pinnedInvoices: pinned, pinnedCreditReversalOfferIds: ['offer-1'], cancelFence: FENCE });
  };

  test('a standing cancel is fenced twice per invoice (before Stripe, then in the locked transaction) and the fence reaches the credit reversal', async () => {
    const voided = await sweep();
    expect([...voided]).toEqual(['inv-a', 'inv-b']);
    expect(mockFence).toHaveBeenCalledTimes(4);
    // Per invoice: a point-in-time proof before any Stripe call (the pool, no lock held across the network call), then the
    // NOWAIT proof inside the void transaction under the invoice row lock. No share lock is ever held on a separate connection.
    // (This suite's transaction mock hands back the pool handle, so the two proofs share a connection here; the lock behaviour
    // is proven on real PostgreSQL in ib-cancel-effect-bundles-postgres.test.js.)
    expect(db.transaction.mock.calls.filter(([cb]) => cb === undefined)).toEqual([]); // no manual share-lock transaction held across Stripe
    expect(mockFence).toHaveBeenCalledWith(expect.anything(), FENCE);
    expect(mockReverse).toHaveBeenCalledWith(expect.objectContaining({ pinnedReversalOfferIds: ['offer-1'], cancelFence: FENCE }));
  });

  test('a visit restored before the sweep: nothing is voided and no Stripe call is made', async () => {
    mockFence.mockRejectedValue(refuse('visit_is_confirmed'));
    mockInvoiceRows = [{ ...INV_B, stripe_payment_intent_id: 'pi_test' }];
    const voided = await sweep();
    expect([...voided]).toEqual([]);
    expect(voidedIds()).toEqual([]);
    expect(require('../services/stripe').retrievePaymentIntent).not.toHaveBeenCalled();
  });

  test('a restore that lands between the pre-check and the row lock stops the void inside its transaction', async () => {
    mockFence.mockResolvedValueOnce(undefined).mockRejectedValueOnce(refuse('visit_busy'));
    mockInvoiceRows = [INV_B];
    const voided = await sweep();
    expect([...voided]).toEqual([]);
    expect(voidedIds()).toEqual([]);
  });

  test('an UNEXPECTED failure while voiding (not a fence refusal) is a retryable hit; without a fence it stays swallowed as before', async () => {
    const hitFence = { ...FENCE, hits: [] };
    mockFence.mockRejectedValue(new Error('connection terminated'));
    mockInvoiceRows = [INV_B];
    const pinned = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
    const voided = await InvoiceService.voidOpenInvoicesForCancelledService('svc-1', { pinnedInvoices: pinned, cancelFence: hitFence });
    expect([...voided]).toEqual([]);
    expect(hitFence.hits).toContain('invoice_void_error');
    // A fence REFUSAL records its own hit (in the fence), never this one.
    const refused = { ...FENCE, hits: [] };
    mockFence.mockReset();
    mockFence.mockRejectedValue(refuse('visit_is_confirmed'));
    await InvoiceService.voidOpenInvoicesForCancelledService('svc-1', { pinnedInvoices: pinned, cancelFence: refused });
    expect(refused.hits).not.toContain('invoice_void_error');
  });

  test('a failed candidate lookup (the whole sweep throws) is a retryable hit too', async () => {
    const hitFence = { ...FENCE, hits: [] };
    const pinned = await InvoiceService.previewInvoiceVoidForCancelledService('svc-1');
    const original = db.mockImplementation;
    mockInvoiceRows = null; // the candidate query reads rows.map: a null result makes the lookup throw
    const voided = await InvoiceService.voidOpenInvoicesForCancelledService('svc-1', { pinnedInvoices: pinned, cancelFence: hitFence });
    expect([...voided]).toEqual([]);
    expect(hitFence.hits).toContain('invoice_void_error');
    expect(original).toBe(db.mockImplementation);
  });

  test('a credit reversal that THROWS is a retryable hit', async () => {
    const hitFence = { ...FENCE, hits: [] };
    mockReverse.mockRejectedValueOnce(new Error('connection terminated'));
    await InvoiceService.voidOpenInvoicesForCancelledService('svc-1', { cancelFence: hitFence });
    expect(hitFence.hits).toContain('credit_reversal_error');
  });

  test('without a fence nothing consults it (the request, Dispatch and every other caller are unchanged)', async () => {
    await InvoiceService.voidOpenInvoicesForCancelledService('svc-1');
    expect(mockFence).not.toHaveBeenCalled();
    expect(Object.keys(mockReverse.mock.calls[0][0])).not.toContain('cancelFence');
  });
});

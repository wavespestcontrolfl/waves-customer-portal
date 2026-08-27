/**
 * Combined-balance selection: a sibling bound to an ABANDONED pay session
 * (unconfirmed PI, no payment row, older than an hour) is no longer
 * invisible to the combined flow. Every /pay page open mints a PI, so the
 * old "any attached PI = owned elsewhere" rule hid exactly the overdue
 * invoices this flow exists to collect (found 2026-08-27: a $435 annual
 * prepay opened once in July, never paid, never itemized on later pay
 * pages).
 *
 * Contract pinned here:
 *   - GET (preview) mode: an abandoned-PI sibling is INCLUDED, nothing is
 *     canceled or written;
 *   - setup mode (releaseAbandonedPaymentIntents): the dead PI is canceled
 *     in Stripe and its stamps cleared BEFORE the sibling is returned; a
 *     failed release excludes the sibling instead of throwing;
 *   - everything that could be a live session still fails CLOSED: money in
 *     flight, ACH micro-deposit verification, a PI minted <1h ago, a live
 *     payments row, a PI that doesn't own the invoice, unreadable Stripe.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true), gates: {} }));
jest.mock('../services/payer', () => ({ resolveForInvoice: jest.fn(async () => ({ payerId: null })) }));
jest.mock('../services/completion-balance-sweep', () => ({ dunningStoppedInvoiceIds: jest.fn(async () => new Set()) }));
const mockOpenBalance = jest.fn();
jest.mock('../services/open-balance', () => ({ openBalanceInvoices: (...a) => mockOpenBalance(...a) }));
const mockRetrieve = jest.fn();
const mockCancel = jest.fn();
jest.mock('../services/stripe', () => ({
  retrievePaymentIntent: (...a) => mockRetrieve(...a),
  cancelPaymentIntent: (...a) => mockCancel(...a),
  assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined),
}));

const db = require('../models/db');
const PayCombined = require('../services/pay-combined');

const ANCHOR_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const SIBLING_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const DEAD_PI = 'pi_dead_july';
const SEVEN_WEEKS_AGO = Math.floor(Date.now() / 1000) - 49 * 24 * 3600;

const anchor = () => ({ id: ANCHOR_ID, invoice_number: 'INV-NEW', customer_id: 'cust-1', payer_id: null, payer_statement_id: null, stripe_payment_intent_id: null });
const sibling = (over = {}) => ({
  id: SIBLING_ID, invoice_number: 'INV-OLD', status: 'viewed', total: '435.00', credit_applied: 0,
  service_date: null, due_date: '2026-07-07', stripe_payment_intent_id: DEAD_PI, ...over,
});
const deadPi = (over = {}) => ({
  id: DEAD_PI, status: 'requires_payment_method', payment_method: null, next_action: null,
  created: SEVEN_WEEKS_AGO, metadata: { waves_invoice_id: SIBLING_ID }, ...over,
});

let paymentRow;
let invoiceUpdate;
function installDb() {
  paymentRow = null;
  invoiceUpdate = jest.fn(async () => 1);
  db.mockImplementation((table) => {
    const q = {};
    ['where', 'whereIn', 'whereNotIn', 'select', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => (table === 'payments' ? paymentRow : null));
    q.update = jest.fn((...a) => (table === 'invoices' ? invoiceUpdate(...a) : Promise.resolve(0)));
    return q;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  installDb();
  mockOpenBalance.mockResolvedValue([sibling()]);
  mockRetrieve.mockResolvedValue(deadPi());
  mockCancel.mockResolvedValue({ id: DEAD_PI, status: 'canceled' });
});

describe('abandoned sibling PI — preview (GET) mode', () => {
  test('an abandoned-PI sibling is included without any Stripe write', async () => {
    const out = await PayCombined.combinedEligibleSiblings(anchor());
    expect(out.map((i) => i.invoice_number)).toEqual(['INV-OLD']);
    expect(mockRetrieve).toHaveBeenCalledWith(DEAD_PI);
    expect(mockCancel).not.toHaveBeenCalled();
    expect(invoiceUpdate).not.toHaveBeenCalled();
    // Preview must not pretend the row is unbound — setup does the release.
    expect(out[0].stripe_payment_intent_id).toBe(DEAD_PI);
  });

  test.each([
    ['processing', deadPi({ status: 'processing' })],
    ['succeeded', deadPi({ status: 'succeeded' })],
    ['requires_capture', deadPi({ status: 'requires_capture' })],
    ['ACH micro-deposit verification', deadPi({ status: 'requires_action', next_action: { type: 'verify_with_microdeposits' } })],
    ['minted 10 minutes ago', deadPi({ created: Math.floor(Date.now() / 1000) - 600 })],
    // Single-invoice setup REUSES an old PI in place — a weeks-old `created`
    // with a fresh pay_session_touched_at is a page reopened just now.
    ['minted weeks ago but re-set-up 10 minutes ago', deadPi({ metadata: { waves_invoice_id: SIBLING_ID, pay_session_touched_at: String(Math.floor(Date.now() / 1000) - 600) } })],
    ['carrying an unparseable pay_session_touched_at', deadPi({ metadata: { waves_invoice_id: SIBLING_ID, pay_session_touched_at: 'yesterday' } })],
    ['missing created timestamp', deadPi({ created: undefined })],
    ['owned by a different invoice', deadPi({ metadata: { waves_invoice_id: 'cccccccc-0000-0000-0000-000000000003' } })],
  ])('a sibling whose PI is %s stays excluded (fail closed)', async (_label, pi) => {
    mockRetrieve.mockResolvedValue(pi);
    expect(await PayCombined.combinedEligibleSiblings(anchor())).toBeNull();
    expect(mockCancel).not.toHaveBeenCalled();
  });

  test('a weeks-old pay_session_touched_at stamp is abandoned like a bare old PI', async () => {
    mockRetrieve.mockResolvedValue(deadPi({ metadata: { waves_invoice_id: SIBLING_ID, pay_session_touched_at: String(SEVEN_WEEKS_AGO + 3600) } }));
    expect(await PayCombined.combinedEligibleSiblings(anchor())).toHaveLength(1);
  });

  test('a live payments row on the PI keeps the sibling excluded without reading Stripe', async () => {
    paymentRow = { status: 'pending' };
    expect(await PayCombined.combinedEligibleSiblings(anchor())).toBeNull();
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  test('a terminal payments row (failed) does not block the abandoned verdict', async () => {
    paymentRow = { status: 'failed' };
    const out = await PayCombined.combinedEligibleSiblings(anchor());
    expect(out).toHaveLength(1);
  });

  test('Stripe unconfigured (null) or unreadable ⇒ excluded, never thrown', async () => {
    mockRetrieve.mockResolvedValueOnce(null);
    expect(await PayCombined.combinedEligibleSiblings(anchor())).toBeNull();
    mockRetrieve.mockRejectedValueOnce(new Error('stripe down'));
    expect(await PayCombined.combinedEligibleSiblings(anchor())).toBeNull();
  });

  test('a sibling stamped with the anchor\'s OWN combined PI is still included on reload without a Stripe read', async () => {
    mockOpenBalance.mockResolvedValue([sibling({ stripe_payment_intent_id: 'pi_combined_live' })]);
    const out = await PayCombined.combinedEligibleSiblings(anchor(), { reusePaymentIntentId: 'pi_combined_live' });
    expect(out).toHaveLength(1);
    expect(mockRetrieve).not.toHaveBeenCalled();
  });
});

describe('abandoned sibling PI — setup (release) mode', () => {
  test('cancels the dead PI, clears its stamps, and returns the sibling unbound', async () => {
    const out = await PayCombined.combinedEligibleSiblings(anchor(), { releaseAbandonedPaymentIntents: true });
    expect(out).toHaveLength(1);
    expect(mockCancel).toHaveBeenCalledWith(DEAD_PI);
    expect(invoiceUpdate).toHaveBeenCalledWith(expect.objectContaining({ stripe_payment_intent_id: null }));
    expect(out[0].stripe_payment_intent_id).toBeNull();
    // Cancel happens BEFORE the stamp is dropped (a tab holding the old
    // client secret must not be able to confirm once the share moves).
    expect(mockCancel.mock.invocationCallOrder[0]).toBeLessThan(invoiceUpdate.mock.invocationCallOrder[0]);
  });

  test('an already-canceled PI skips the Stripe cancel but still finishes the stamp cleanup', async () => {
    mockRetrieve.mockResolvedValue(deadPi({ status: 'canceled' }));
    const out = await PayCombined.combinedEligibleSiblings(anchor(), { releaseAbandonedPaymentIntents: true });
    expect(out).toHaveLength(1);
    expect(mockCancel).not.toHaveBeenCalled();
    expect(invoiceUpdate).toHaveBeenCalledTimes(1);
  });

  test('a failed cancel excludes the sibling (no throw, no stamp change)', async () => {
    mockCancel.mockRejectedValue(new Error('intent already processing'));
    expect(await PayCombined.combinedEligibleSiblings(anchor(), { releaseAbandonedPaymentIntents: true })).toBeNull();
    expect(invoiceUpdate).not.toHaveBeenCalled();
  });
});

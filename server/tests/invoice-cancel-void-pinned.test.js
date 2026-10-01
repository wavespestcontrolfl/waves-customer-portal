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
const mockUpdates = [];
jest.mock('../models/db', () => {
  const makeChain = (table) => {
    const state = { whereObj: null, idIn: null };
    const chain = {};
    for (const m of ['whereNot', 'whereNotIn', 'whereRaw', 'orderBy', 'forUpdate', 'whereNull', 'orWhereIn']) chain[m] = jest.fn(() => chain);
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
      if (table !== 'invoices') return [];
      let r = mockInvoiceRows;
      if (state.idIn) r = r.filter((x) => state.idIn.includes(String(x.id)));
      if (state.whereObj?.id) r = r.filter((x) => String(x.id) === String(state.whereObj.id));
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
  db.transaction = jest.fn(async (cb) => cb(db));
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
jest.mock('../services/invoice-followups', () => ({ stopSequence: jest.fn(async () => {}) }));
jest.mock('../services/stripe', () => ({ retrievePaymentIntent: jest.fn(), cancelPaymentIntent: jest.fn() }));

const InvoiceService = require('../services/invoice');

const deposit = (amt) => JSON.stringify([{ category: 'service', amount: 125 }, { category: 'deposit_credit', amount: -amt, estimate_id: 'est-1' }]);
const INV_A = { id: 'inv-a', invoice_number: 'WPC-TEST-1', status: 'sent', total: '50.00', credit_applied: '0.00', line_items: deposit(75), scheduled_service_id: 'svc-1' };
const INV_B = { id: 'inv-b', invoice_number: 'WPC-TEST-2', status: 'draft', total: '20.00', credit_applied: '5.00', line_items: '[]', scheduled_service_id: 'svc-1' };
const voidedIds = () => mockUpdates.filter((u) => u.table === 'invoices' && u.patch.status === 'void').map((u) => u.id);

beforeEach(() => {
  jest.clearAllMocks();
  mockInvoiceRows = [INV_A, INV_B];
  mockLockedOverride = {};
  mockUpdates.length = 0;
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

/**
 * Re-service conversion invoice voiding — credit-restore contract.
 *
 * The conversion used to bulk-void a visit's unpaid invoices, which left any
 * consumed deposit credit stranded: the estimate_deposits row stayed
 * 'credited' against a void invoice, so the deposit never rolled forward and
 * never refunded (money-path audit 2026-07-06). The contract now mirrors
 * InvoiceService.voidInvoice:
 *   - every voided invoice restores deposit credit AND auto-applied account
 *     credit inside the SAME transaction
 *   - money in flight is never voided away: a paid/processing payments row,
 *     a recorded payment, or an attached PI that is processing/succeeded/
 *     unverifiable SKIPS the invoice
 *   - a still-cancelable open payment session (PI) is cancelled BEFORE the
 *     void so its client secret can't confirm against a terminal invoice
 *   - a restore shortfall throws so the whole conversion rolls back
 */
jest.mock('../services/estimate-deposits', () => ({
  restoreDepositCreditForVoidedInvoice: jest.fn().mockResolvedValue({ restored: true }),
}));
jest.mock('../services/customer-credit', () => ({
  restoreAccountCreditForVoidedInvoice: jest.fn().mockResolvedValue({ restored: true }),
}));
jest.mock('../services/stripe', () => ({
  retrievePaymentIntent: jest.fn(),
  cancelPaymentIntent: jest.fn().mockResolvedValue({ status: 'canceled' }),
}));

const { restoreDepositCreditForVoidedInvoice } = require('../services/estimate-deposits');
const { restoreAccountCreditForVoidedInvoice } = require('../services/customer-credit');
const StripeService = require('../services/stripe');
const adminScheduleRouter = require('../routes/admin-schedule');

const { voidConversionInvoicesRestoringCredits } = adminScheduleRouter._test;

// Minimal knex-transaction stand-in: behavior is programmed per invoice id.
// state[id] = { row: {...invoice}, inFlightPayment: bool, updates: 0|1 }
function fakeTrx(state) {
  return (table) => {
    const ctx = { table, id: null };
    const chain = {
      where(cond) { if (cond && cond.id !== undefined) ctx.id = cond.id; return chain; },
      whereIn() { return chain; },
      whereNotIn() { return chain; },
      whereRaw(_sql, bindings) { ctx.id = bindings[0]; return chain; },
      forUpdate() { return chain; },
      first() {
        const s = state[ctx.id] || {};
        if (ctx.table === 'payments') return Promise.resolve(s.inFlightPayment ? { id: `pay-${ctx.id}` } : undefined);
        return Promise.resolve(s.row);
      },
      update() {
        const s = state[ctx.id] || {};
        return Promise.resolve(s.updates ?? 0);
      },
      catch(fn) { return Promise.resolve(chain).catch(fn); },
    };
    return chain;
  };
}

const voidUpdate = { status: 'void' };
const openInvoice = (id, extra = {}) => ({ id, status: 'sent', line_items: '[]', payment_recorded_at: null, stripe_payment_intent_id: null, ...extra });

beforeEach(() => {
  jest.clearAllMocks();
  StripeService.cancelPaymentIntent.mockResolvedValue({ status: 'canceled' });
});

describe('voidConversionInvoicesRestoringCredits', () => {
  test('voids an unpaid invoice and restores deposit + account credit in the same trx', async () => {
    const row = openInvoice('inv-1');
    const trx = fakeTrx({ 'inv-1': { row, updates: 1 } });
    const voided = await voidConversionInvoicesRestoringCredits({ trx, ids: ['inv-1'], voidUpdate });
    expect(voided).toEqual(['inv-1']);
    expect(restoreDepositCreditForVoidedInvoice).toHaveBeenCalledWith({ invoice: row, trx });
    expect(restoreAccountCreditForVoidedInvoice).toHaveBeenCalledWith(
      { invoice: row, createdBy: 'system:void' },
      trx,
    );
    expect(StripeService.retrievePaymentIntent).not.toHaveBeenCalled();
  });

  test('SKIPS an invoice with an in-flight payments row — no void, no restores', async () => {
    const trx = fakeTrx({ 'inv-ach': { row: openInvoice('inv-ach'), inFlightPayment: true, updates: 1 } });
    const voided = await voidConversionInvoicesRestoringCredits({ trx, ids: ['inv-ach'], voidUpdate });
    expect(voided).toEqual([]);
    expect(restoreDepositCreditForVoidedInvoice).not.toHaveBeenCalled();
    expect(restoreAccountCreditForVoidedInvoice).not.toHaveBeenCalled();
  });

  test('SKIPS an invoice with a recorded payment', async () => {
    const trx = fakeTrx({ 'inv-rec': { row: openInvoice('inv-rec', { payment_recorded_at: '2026-07-01' }), updates: 1 } });
    const voided = await voidConversionInvoicesRestoringCredits({ trx, ids: ['inv-rec'], voidUpdate });
    expect(voided).toEqual([]);
    expect(restoreDepositCreditForVoidedInvoice).not.toHaveBeenCalled();
  });

  test('cancels a still-cancelable open payment session BEFORE voiding', async () => {
    StripeService.retrievePaymentIntent.mockResolvedValueOnce({ id: 'pi_1', status: 'requires_payment_method' });
    const row = openInvoice('inv-pi', { stripe_payment_intent_id: 'pi_1' });
    const trx = fakeTrx({ 'inv-pi': { row, updates: 1 } });
    const voided = await voidConversionInvoicesRestoringCredits({ trx, ids: ['inv-pi'], voidUpdate });
    expect(voided).toEqual(['inv-pi']);
    expect(StripeService.cancelPaymentIntent).toHaveBeenCalledWith('pi_1', { cancellation_reason: 'abandoned' });
    expect(restoreDepositCreditForVoidedInvoice).toHaveBeenCalledTimes(1);
  });

  test('SKIPS when the attached PI has money in flight (processing) — no cancel, no void', async () => {
    StripeService.retrievePaymentIntent.mockResolvedValueOnce({ id: 'pi_2', status: 'processing' });
    const trx = fakeTrx({ 'inv-flight': { row: openInvoice('inv-flight', { stripe_payment_intent_id: 'pi_2' }), updates: 1 } });
    const voided = await voidConversionInvoicesRestoringCredits({ trx, ids: ['inv-flight'], voidUpdate });
    expect(voided).toEqual([]);
    expect(StripeService.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(restoreDepositCreditForVoidedInvoice).not.toHaveBeenCalled();
  });

  test('SKIPS when the attached PI cannot be verified or cancelled', async () => {
    StripeService.retrievePaymentIntent.mockRejectedValueOnce(new Error('stripe down'));
    const trxA = fakeTrx({ 'inv-x': { row: openInvoice('inv-x', { stripe_payment_intent_id: 'pi_x' }), updates: 1 } });
    expect(await voidConversionInvoicesRestoringCredits({ trx: trxA, ids: ['inv-x'], voidUpdate })).toEqual([]);

    StripeService.retrievePaymentIntent.mockResolvedValueOnce({ id: 'pi_y', status: 'requires_confirmation' });
    StripeService.cancelPaymentIntent.mockRejectedValueOnce(new Error('cannot cancel'));
    const trxB = fakeTrx({ 'inv-y': { row: openInvoice('inv-y', { stripe_payment_intent_id: 'pi_y' }), updates: 1 } });
    expect(await voidConversionInvoicesRestoringCredits({ trx: trxB, ids: ['inv-y'], voidUpdate })).toEqual([]);
    expect(restoreDepositCreditForVoidedInvoice).not.toHaveBeenCalled();
  });

  test('no restore when the row is already terminal or the conditional void matched nothing', async () => {
    const trx = fakeTrx({
      'inv-void': { row: openInvoice('inv-void', { status: 'void' }), updates: 1 },
      'inv-race': { row: openInvoice('inv-race'), updates: 0 },
      'inv-gone': {},
    });
    const voided = await voidConversionInvoicesRestoringCredits({ trx, ids: ['inv-void', 'inv-race', 'inv-gone'], voidUpdate });
    expect(voided).toEqual([]);
    expect(restoreDepositCreditForVoidedInvoice).not.toHaveBeenCalled();
  });

  test('a restore shortfall propagates so the conversion transaction rolls back', async () => {
    restoreDepositCreditForVoidedInvoice.mockRejectedValueOnce(new Error('deposit restore shortfall'));
    const trx = fakeTrx({ 'inv-2': { row: openInvoice('inv-2'), updates: 1 } });
    await expect(
      voidConversionInvoicesRestoringCredits({ trx, ids: ['inv-2'], voidUpdate }),
    ).rejects.toThrow('deposit restore shortfall');
  });

  test('processes a mixed batch: skips money-in-flight, voids the rest', async () => {
    StripeService.retrievePaymentIntent.mockResolvedValueOnce({ id: 'pi_b', status: 'succeeded' });
    const trx = fakeTrx({
      'inv-a': { row: openInvoice('inv-a'), updates: 1 },
      'inv-b': { row: openInvoice('inv-b', { stripe_payment_intent_id: 'pi_b' }), updates: 1 },
      'inv-c': { row: openInvoice('inv-c'), updates: 1 },
    });
    const voided = await voidConversionInvoicesRestoringCredits({ trx, ids: ['inv-a', 'inv-b', 'inv-c'], voidUpdate });
    expect(voided).toEqual(['inv-a', 'inv-c']);
    expect(restoreDepositCreditForVoidedInvoice).toHaveBeenCalledTimes(2);
  });
});

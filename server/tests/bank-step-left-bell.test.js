/**
 * Bank step left bell (server/services/bank-step-left-bell.js, owner 2026-11-24 "build bell").
 * recordBankSelection keeps one pay_bank_selections row per invoice while the pay page sits on Bank account;
 * runBankStepLeftBell rings one office bell per selection left 30 min to 24 h, after invoice-side and live-intent
 * checks. db is a small fake; Stripe, the alert writer and the payer-ownership check are injected or mocked.
 */
const state = { selections: [], invoices: {}, rung: {}, reported: {}, calls: [] };

jest.mock('../models/db', () => jest.fn((table) => {
  const filters = {};
  const q = {
    where: jest.fn((w, op, value) => { if (w && typeof w === 'object') Object.assign(filters, w); else filters[`${w} ${op}`] = value; return q; }),
    whereNot: jest.fn(() => q),
    orderBy: jest.fn(() => q),
    limit: jest.fn(() => q),
    select: jest.fn(async () => {
      const lo = filters['selected_at >='].getTime();
      const hi = filters['selected_at <='].getTime();
      return state.selections.filter((s) => s.selected_at.getTime() >= lo && s.selected_at.getTime() <= hi);
    }),
    first: jest.fn(async () => {
      if (table === 'invoices') return state.invoices[filters.id];
      if (table === 'bill_payment_error_alerts') return (filters.phase ? state.rung : state.reported)[filters.invoice_id];
      return undefined;
    }),
    insert: jest.fn((row) => { state.calls.push(['insert', table, row]); return { onConflict: () => ({ merge: async (cols) => state.calls.push(['merge', cols]) }) }; }),
    del: jest.fn(async () => { state.calls.push(['del', table, { ...filters }]); return 1; }),
  };
  return q;
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const ownership = { value: null };
jest.mock('../services/invoice-payer-ownership', () => ({ invoicePayerOwnership: jest.fn(async () => ownership.value) }));

const { recordBankSelection, runBankStepLeftBell } = require('../services/bank-step-left-bell');

const NOW = new Date('2026-11-24T21:00:00Z');
const at = (iso) => new Date(iso);

function invoice(extra = {}) {
  return { id: 'inv-1', customer_id: 'cust-1', invoice_number: 'WPC-2026-0100', status: 'viewed', total: '155.00', credit_applied: '0', amount_paid: '0', stripe_payment_intent_id: 'pi_a', payer_id: null, payer_statement_id: null, archived_at: null, ...extra };
}
function livePi(extra = {}) {
  return { id: 'pi_a', status: 'requires_payment_method', metadata: { selected_method_category: 'us_bank_account' }, last_payment_error: null, ...extra };
}
function stripeReturning(pi) {
  return { paymentIntents: { retrieve: jest.fn(async () => pi) } };
}
function seed({ selectedAt = '2026-11-24T20:20:00Z', inv = invoice() } = {}) {
  state.selections.push({ invoice_id: 'inv-1', payment_intent_id: 'pi_a', selected_at: at(selectedAt) });
  if (inv) state.invoices['inv-1'] = inv;
}

beforeEach(() => {
  state.selections = []; state.invoices = {}; state.rung = {}; state.reported = {}; state.calls = [];
  ownership.value = null;
});

describe('recordBankSelection', () => {
  test('a switch to Bank account upserts the row with the intent and time', async () => {
    await recordBankSelection('inv-1', 'us_bank_account', 'pi_a', { now: NOW });
    expect(state.calls[0]).toEqual(['insert', 'pay_bank_selections', { invoice_id: 'inv-1', payment_intent_id: 'pi_a', selected_at: NOW }]);
    expect(state.calls[1]).toEqual(['merge', ['payment_intent_id', 'selected_at']]);
  });

  test('a switch to card deletes the row', async () => {
    await recordBankSelection('inv-1', 'card', 'pi_a');
    expect(state.calls).toEqual([['del', 'pay_bank_selections', { invoice_id: 'inv-1' }]]);
  });

  test('a database failure is logged and swallowed (never blocks the payment)', async () => {
    const db = require('../models/db');
    db.mockImplementationOnce(() => { throw new Error('down'); });
    await expect(recordBankSelection('inv-1', 'us_bank_account', 'pi_a')).resolves.toBeUndefined();
    expect(require('../services/logger').warn).toHaveBeenCalled();
  });
});

describe('runBankStepLeftBell', () => {
  test('rings once for a selection left 30+ minutes, through the bill-payment alert path', async () => {
    seed();
    const stripe = stripeReturning(livePi());
    const alert = jest.fn(async () => ({ notified: true }));
    const tally = await runBankStepLeftBell({ now: NOW, stripe, alert });
    expect(stripe.paymentIntents.retrieve).toHaveBeenCalledWith('pi_a');
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({
      invoice: state.invoices['inv-1'], phase: 'bank_step_left', methodCategory: 'us_bank_account', paymentIntentId: 'pi_a', source: 'server',
    }));
    expect(tally).toMatchObject({ candidates: 1, rang: 1, duplicate: 0, failed: 0 });
  });

  test('reads only selections 30 min to 24 h old', async () => {
    seed({ selectedAt: '2026-11-24T20:45:00Z' });
    state.selections.push({ invoice_id: 'inv-2', payment_intent_id: 'pi_b', selected_at: at('2026-11-23T20:00:00Z') });
    const tally = await runBankStepLeftBell({ now: NOW, stripe: stripeReturning(livePi()), alert: jest.fn() });
    expect(tally.candidates).toBe(0);
  });

  test.each([
    ['invoice_not_found', () => seed({ inv: null })],
    ['intent_replaced', () => seed({ inv: invoice({ stripe_payment_intent_id: 'pi_newer' }) })],
    ['not_collectible', () => seed({ inv: invoice({ status: 'paid' }) })],
    ['not_collectible', () => seed({ inv: invoice({ status: 'processing' }) })],
    ['archived', () => seed({ inv: invoice({ archived_at: '2026-11-24T19:00:00Z' }) })],
    ['nothing_due', () => seed({ inv: invoice({ amount_paid: '155.00' }) })],
    ['payer_owned', () => { seed(); ownership.value = 'payer_owned'; }],
    ['payer_unverifiable', () => { seed(); ownership.value = 'payer_unverifiable'; }],
    ['already_rung', () => { seed(); state.rung['inv-1'] = { id: 'a1' }; }],
    ['error_already_reported', () => { seed(); state.reported['inv-1'] = { id: 'a2' }; }],
  ])('invoice check, does not ring: %s', async (reason, arrange) => {
    arrange();
    const stripe = stripeReturning(livePi());
    const alert = jest.fn();
    const tally = await runBankStepLeftBell({ now: NOW, stripe, alert });
    expect(alert).not.toHaveBeenCalled();
    expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(tally.skipped).toEqual({ [reason]: 1 });
  });

  test.each([
    ['status_changed', livePi({ status: 'processing' })],
    ['status_changed', livePi({ status: 'requires_action' })],
    ['method_changed', livePi({ metadata: { selected_method_category: 'card' } })],
    ['payment_error_on_intent', livePi({ last_payment_error: { code: 'x' } })],
  ])('live intent check, does not ring: %s', async (reason, pi) => {
    seed();
    const alert = jest.fn();
    const tally = await runBankStepLeftBell({ now: NOW, stripe: stripeReturning(pi), alert });
    expect(alert).not.toHaveBeenCalled();
    expect(tally.skipped).toEqual({ [reason]: 1 });
  });

  test('a duplicate and a failed alert write are counted apart', async () => {
    seed();
    expect(await runBankStepLeftBell({ now: NOW, stripe: stripeReturning(livePi()), alert: jest.fn(async () => ({ notified: false, duplicate: true })) })).toMatchObject({ duplicate: 1, failed: 0 });
    expect(await runBankStepLeftBell({ now: NOW, stripe: stripeReturning(livePi()), alert: jest.fn(async () => ({ notified: false, error: 'bell' })) })).toMatchObject({ duplicate: 0, failed: 1 });
  });

  test('a Stripe failure on one selection is logged and counted', async () => {
    seed();
    const stripe = { paymentIntents: { retrieve: jest.fn(async () => { throw Object.assign(new Error('x'), { code: 'resource_missing' }); }) } };
    expect(await runBankStepLeftBell({ now: NOW, stripe, alert: jest.fn() })).toMatchObject({ failed: 1, rang: 0 });
  });

  test('does nothing without a Stripe client', async () => {
    expect(await runBankStepLeftBell({ now: NOW, stripe: null })).toEqual({ skipped: 'stripe_unavailable', candidates: 0, rang: 0 });
  });
});

// Card details sync: Stripe's card account updater renews saved cards and
// the portal's stored expiry must follow (GATE_CARD_DETAILS_SYNC).

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/audit-log', () => ({ auditCardDetailsSynced: jest.fn(async () => 1) }));
jest.mock('../services/stripe', () => ({ retrievePaymentMethod: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gates: { cardDetailsSync: true }, isEnabled: jest.fn(() => true) }));

const logger = require('../services/logger');
const { auditCardDetailsSynced } = require('../services/audit-log');
const stripe = require('../services/stripe');
const gatesModule = require('../config/feature-gates');
const { applyStripeCardDetails, syncNearExpiryCards } = require('../services/card-details-sync');

// Minimal in-memory knex for the payment_methods table.
function fakeKnex(rows) {
  const updates = [];
  const knex = (table) => {
    if (table !== 'payment_methods') throw new Error(`unexpected table ${table}`);
    let filter = {};
    let needNotNull = null;
    const q = {
      where(f) { filter = f; return q; },
      whereNotNull(col) { needNotNull = col; return q; },
      select() {
        return Promise.resolve(rows.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v)
          && (!needNotNull || r[needNotNull] != null)));
      },
      update(patch) {
        const hit = rows.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
        hit.forEach((r) => Object.assign(r, patch));
        updates.push({ filter, patch });
        return Promise.resolve(hit.length);
      },
    };
    return q;
  };
  knex.updates = updates;
  return knex;
}

const card = (over = {}) => ({
  id: 'row-1', processor: 'stripe', method_type: 'card', stripe_payment_method_id: 'pm_a',
  exp_month: '11', exp_year: '2026', last_four: '4242', card_brand: 'VISA', card_funding: 'credit',
  ...over,
});
const stripeCard = (over = {}, cardOver = {}) => ({
  id: 'pm_a', type: 'card', customer: 'cus_1',
  card: { brand: 'visa', last4: '4242', exp_month: 11, exp_year: 2029, funding: 'credit', ...cardOver },
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  gatesModule.gates.cardDetailsSync = true;
});

describe('applyStripeCardDetails', () => {
  test('writes a stale expiry with savePaymentMethod formatting and audits it', async () => {
    const rows = [card()];
    const knex = fakeKnex(rows);
    const out = await applyStripeCardDetails(stripeCard({}, { exp_month: 3, last4: '1111' }), { source: 'webhook', database: knex });
    expect(out).toEqual({ updated: 1 });
    expect(rows[0]).toMatchObject({ exp_month: '03', exp_year: '2029', last_four: '1111' });
    expect(knex.updates[0].filter).toEqual({ id: 'row-1', stripe_payment_method_id: 'pm_a' });
    expect(knex.updates[0].patch.updated_at).toBeInstanceOf(Date);
    const audit = auditCardDetailsSynced.mock.calls[0][0];
    expect(audit).toMatchObject({
      payment_method_row_id: 'row-1', source: 'webhook', old_expiry: '11/2026', new_expiry: '03/2029',
    });
    expect(audit.changed_fields).toEqual(expect.arrayContaining(['expiry', 'last_four']));
    expect(JSON.stringify(audit)).not.toContain('1111');
  });

  test('values equal after normalization are a no-op', async () => {
    const rows = [card({ exp_month: '03', exp_year: '29' })];
    const knex = fakeKnex(rows);
    const out = await applyStripeCardDetails(stripeCard({}, { exp_month: 3, exp_year: 2029 }), { database: knex });
    expect(out).toEqual({ updated: 0 });
    expect(knex.updates).toHaveLength(0);
    expect(auditCardDetailsSynced).not.toHaveBeenCalled();
  });

  test('bank rows that share the id are never touched; a null method_type counts as a card', async () => {
    const rows = [
      card({ id: 'bank-1', method_type: 'ach' }),
      card({ id: 'bank-2', method_type: 'us_bank_account' }),
      card({ id: 'legacy', method_type: null }),
    ];
    const knex = fakeKnex(rows);
    const out = await applyStripeCardDetails(stripeCard(), { database: knex });
    expect(out).toEqual({ updated: 1 });
    expect(rows[0].exp_year).toBe('2026');
    expect(rows[1].exp_year).toBe('2026');
    expect(rows[2].exp_year).toBe('2029');
  });

  test('a non-card PaymentMethod does nothing', async () => {
    const knex = jest.fn();
    expect(await applyStripeCardDetails({ id: 'pm_a', type: 'us_bank_account' }, { database: knex })).toEqual({ updated: 0 });
    expect(knex).not.toHaveBeenCalled();
  });

  test('funding is never nulled when Stripe has none', async () => {
    const rows = [card({ card_funding: 'credit' })];
    const knex = fakeKnex(rows);
    await applyStripeCardDetails(stripeCard({}, { funding: null }), { database: knex });
    expect(rows[0].card_funding).toBe('credit');
    expect(knex.updates[0].patch).not.toHaveProperty('card_funding');
    expect(knex.updates[0].patch).not.toHaveProperty('card_funding_checked_at');
  });

  test('a changed funding is written with its checked-at stamp', async () => {
    const rows = [card({ card_funding: 'credit', exp_year: '2029' })];
    const knex = fakeKnex(rows);
    const out = await applyStripeCardDetails(stripeCard({}, { funding: 'debit' }), { database: knex });
    expect(out).toEqual({ updated: 1 });
    expect(rows[0].card_funding).toBe('debit');
    expect(rows[0].card_funding_checked_at).toBeInstanceOf(Date);
    expect(auditCardDetailsSynced.mock.calls[0][0].changed_fields).toEqual(['funding']);
  });

  test('a failed audit write does not undo or block the update', async () => {
    auditCardDetailsSynced.mockRejectedValueOnce(new Error('audit down'));
    const rows = [card()];
    const out = await applyStripeCardDetails(stripeCard(), { database: fakeKnex(rows) });
    expect(out).toEqual({ updated: 1 });
    expect(rows[0].exp_year).toBe('2029');
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('syncNearExpiryCards', () => {
  const NOW = new Date('2026-11-15T15:00:00Z'); // 2026-11 in ET

  test('gate off: no Stripe call', async () => {
    gatesModule.gates.cardDetailsSync = false;
    const knex = jest.fn();
    expect(await syncNearExpiryCards({ now: NOW, database: knex })).toEqual({ skipped: 'gate_off' });
    expect(stripe.retrievePaymentMethod).not.toHaveBeenCalled();
    expect(knex).not.toHaveBeenCalled();
  });

  test('a missing gate property reads as off', async () => {
    delete gatesModule.gates.cardDetailsSync;
    expect(await syncNearExpiryCards({ now: NOW, database: jest.fn() })).toEqual({ skipped: 'gate_off' });
  });

  test('keeps past, near and unparseable expiries, skips far ones and banks', async () => {
    const rows = [
      card({ id: 'past', stripe_payment_method_id: 'pm_past', exp_month: '01', exp_year: '2026' }),
      card({ id: 'edge', stripe_payment_method_id: 'pm_edge', exp_month: '01', exp_year: '2027' }), // now + 2 months
      card({ id: 'far', stripe_payment_method_id: 'pm_far', exp_month: '02', exp_year: '2027' }),
      card({ id: 'bad', stripe_payment_method_id: 'pm_bad', exp_month: null, exp_year: 'x' }),
      card({ id: 'twodigit', stripe_payment_method_id: 'pm_two', exp_month: '12', exp_year: '26' }),
      card({ id: 'bank', stripe_payment_method_id: 'pm_bank', method_type: 'ach', exp_month: '01', exp_year: '2020' }),
      card({ id: 'other', stripe_payment_method_id: 'pm_x', processor: 'square' }),
    ];
    stripe.retrievePaymentMethod.mockImplementation(async (id) => ({ id, type: 'card', customer: 'cus', card: { brand: 'visa', last4: '4242', exp_month: 1, exp_year: 2099 } }));
    const out = await syncNearExpiryCards({ now: NOW, database: fakeKnex(rows) });
    const asked = stripe.retrievePaymentMethod.mock.calls.map((c) => c[0]).sort();
    expect(asked).toEqual(['pm_bad', 'pm_edge', 'pm_past', 'pm_two']);
    expect(out).toEqual({ checked: 4, updated: 4, detached: 0, errors: 0 });
  });

  test('a PM detached at Stripe is skipped and counted', async () => {
    const rows = [card({ exp_year: '2025' })];
    stripe.retrievePaymentMethod.mockResolvedValue(stripeCard({ customer: null }));
    const out = await syncNearExpiryCards({ now: NOW, database: fakeKnex(rows) });
    expect(out).toEqual({ checked: 1, updated: 0, detached: 1, errors: 0 });
    expect(rows[0].exp_year).toBe('2025');
  });

  test('one Stripe error, or Stripe unconfigured, does not stop the other cards', async () => {
    const rows = [
      card({ id: 'a', stripe_payment_method_id: 'pm_err', exp_year: '2025' }),
      card({ id: 'b', stripe_payment_method_id: 'pm_null', exp_year: '2025' }),
      card({ id: 'c', stripe_payment_method_id: 'pm_ok', exp_year: '2025' }),
    ];
    stripe.retrievePaymentMethod.mockImplementation(async (id) => {
      if (id === 'pm_err') throw new Error('stripe 500');
      if (id === 'pm_null') return null;
      return { id, type: 'card', customer: 'cus', card: { brand: 'visa', last4: '4242', exp_month: 11, exp_year: 2029 } };
    });
    const out = await syncNearExpiryCards({ now: NOW, database: fakeKnex(rows) });
    expect(out).toEqual({ checked: 3, updated: 1, detached: 0, errors: 2 });
    expect(rows[2].exp_year).toBe('2029');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('stripe 500'));
  });
});

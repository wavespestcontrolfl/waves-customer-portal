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
const { applyStripeCardDetails, refreshCardFromStripe, syncNearExpiryCards } = require('../services/card-details-sync');

// Minimal in-memory knex: payment_methods reads and updates, plus the fill-only payments snapshot write.
// `writes` records the order of the two tables' updates.
function fakeKnex(rows) {
  const updates = [];
  const paymentFills = [];
  const writes = [];
  const knex = (table) => {
    if (table === 'payments') {
      const call = { filter: null, guard: null };
      const q = {
        where(f) {
          if (typeof f !== 'function') { call.filter = f; return q; }
          call.guard = [];
          const b = {
            whereNull(col) { call.guard.push(['null', col]); return b; },
            orWhereNull(col) { call.guard.push(['orNull', col]); return b; },
          };
          f(b);
          return q;
        },
        update(fill) { paymentFills.push({ ...call, fill }); writes.push('payments'); return Promise.resolve(1); },
      };
      return q;
    }
    if (table !== 'payment_methods') throw new Error(`unexpected table ${table}`);
    let filter = {};
    let needNotNull = null;
    const q = {
      where(f) { filter = f; return q; },
      whereNotNull(col) { needNotNull = col; return q; },
      select() {
        return Promise.resolve(rows.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v)
          && (!needNotNull || r[needNotNull] != null)).map((r) => ({ ...r })));
      },
      update(patch) {
        const hit = rows.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
        hit.forEach((r) => Object.assign(r, patch));
        updates.push({ filter, patch });
        writes.push('payment_methods');
        return Promise.resolve(hit.length);
      },
    };
    return q;
  };
  knex.raw = (sql, bindings) => ({ sql, bindings });
  knex.table = rows;
  knex.updates = updates;
  knex.paymentFills = paymentFills;
  knex.writes = writes;
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

// applyStripeCardDetails compares against the rows read BEFORE Stripe was asked: here, copies of the table now.
const apply = (pm, knex, opts = {}) => applyStripeCardDetails(pm, {
  database: knex, ...opts, rows: knex.table.filter((r) => r.stripe_payment_method_id === pm.id).map((r) => ({ ...r })),
});
const CAS = (r) => ({ exp_month: r.exp_month, exp_year: r.exp_year, last_four: r.last_four, card_brand: r.card_brand, card_funding: r.card_funding });

beforeEach(() => {
  jest.clearAllMocks();
  gatesModule.gates.cardDetailsSync = true;
});

describe('applyStripeCardDetails', () => {
  test('writes a stale expiry with savePaymentMethod formatting and audits it', async () => {
    const rows = [card()];
    const knex = fakeKnex(rows);
    const out = await apply(stripeCard({}, { exp_month: 3, last4: '1111' }), knex, { source: 'webhook' });
    expect(out).toEqual({ updated: 1, conflict: false });
    expect(rows[0]).toMatchObject({ exp_month: '03', exp_year: '2029', last_four: '1111' });
    // Written only while the row still holds what was read before Stripe answered (compare-and-set).
    expect(knex.updates[0].filter).toEqual({ id: 'row-1', stripe_payment_method_id: 'pm_a', ...CAS(card()) });
    // The Auto Pay fallback orders duplicate default cards by updated_at: a detail refresh never moves it.
    expect(knex.updates[0].patch).not.toHaveProperty('updated_at');
    const audit = auditCardDetailsSynced.mock.calls[0][0];
    expect(audit).toMatchObject({
      payment_method_row_id: 'row-1', source: 'webhook', old_expiry: '11/2026', new_expiry: '03/2029',
    });
    expect(audit.changed_fields).toEqual(expect.arrayContaining(['expiry', 'last_four']));
    expect(JSON.stringify(audit)).not.toContain('1111');
    // A replaced number: before the saved card changes, its earlier payments with no snapshot get the card they
    // were made with (fill-only), so payment history still shows the old last four on them.
    expect(knex.writes).toEqual(['payments', 'payment_methods']);
    expect(knex.paymentFills).toEqual([{
      filter: { payment_method_id: 'row-1' },
      guard: [['null', 'card_last_four'], ['orNull', 'card_brand']],
      fill: {
        card_last_four: { sql: 'COALESCE(card_last_four, ?)', bindings: ['4242'] },
        card_brand: { sql: 'COALESCE(card_brand, ?)', bindings: ['VISA'] },
      },
    }]);
  });

  test('an expiry-only renewal writes no payment snapshot', async () => {
    const rows = [card()];
    const knex = fakeKnex(rows);
    expect(await apply(stripeCard(), knex)).toEqual({ updated: 1, conflict: false });
    expect(rows[0]).toMatchObject({ exp_year: '2029', last_four: '4242', card_brand: 'VISA' });
    expect(knex.writes).toEqual(['payment_methods']);
    expect(knex.paymentFills).toEqual([]);
  });

  test('a saved card with no stored brand or last four has nothing to preserve', async () => {
    const rows = [card({ last_four: null, card_brand: null })];
    const knex = fakeKnex(rows);
    expect(await apply(stripeCard(), knex)).toEqual({ updated: 1, conflict: false });
    expect(rows[0]).toMatchObject({ last_four: '4242', card_brand: 'VISA' });
    expect(knex.paymentFills).toEqual([]);
  });

  test('values equal after normalization are a no-op', async () => {
    const rows = [card({ exp_month: '03', exp_year: '29' })];
    const knex = fakeKnex(rows);
    const out = await apply(stripeCard({}, { exp_month: 3, exp_year: 2029 }), knex);
    expect(out).toEqual({ updated: 0, conflict: false });
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
    const out = await apply(stripeCard(), knex);
    expect(out).toEqual({ updated: 1, conflict: false });
    expect(rows[0].exp_year).toBe('2026');
    expect(rows[1].exp_year).toBe('2026');
    expect(rows[2].exp_year).toBe('2029');
  });

  test('a non-card PaymentMethod does nothing', async () => {
    const knex = jest.fn();
    expect(await applyStripeCardDetails({ id: 'pm_a', type: 'us_bank_account' }, { database: knex })).toEqual({ updated: 0, conflict: false });
    expect(knex).not.toHaveBeenCalled();
  });

  test('funding is never nulled when Stripe has none', async () => {
    const rows = [card({ card_funding: 'credit' })];
    const knex = fakeKnex(rows);
    await apply(stripeCard({}, { funding: null }), knex);
    expect(rows[0].card_funding).toBe('credit');
    expect(knex.updates[0].patch).not.toHaveProperty('card_funding');
    expect(knex.updates[0].patch).not.toHaveProperty('card_funding_checked_at');
  });

  test('a changed funding is written with its checked-at stamp', async () => {
    const rows = [card({ card_funding: 'credit', exp_year: '2029' })];
    const knex = fakeKnex(rows);
    const out = await apply(stripeCard({}, { funding: 'debit' }), knex);
    expect(out).toEqual({ updated: 1, conflict: false });
    expect(rows[0].card_funding).toBe('debit');
    expect(rows[0].card_funding_checked_at).toBeInstanceOf(Date);
    expect(auditCardDetailsSynced.mock.calls[0][0].changed_fields).toEqual(['funding']);
  });

  test('a failed audit write does not undo or block the update', async () => {
    auditCardDetailsSynced.mockRejectedValueOnce(new Error('audit down'));
    const rows = [card()];
    const out = await apply(stripeCard(), fakeKnex(rows));
    expect(out).toEqual({ updated: 1, conflict: false });
    expect(rows[0].exp_year).toBe('2029');
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('refreshCardFromStripe', () => {
  test('re-reads the card from Stripe and writes what changed', async () => {
    const rows = [card()];
    stripe.retrievePaymentMethod.mockResolvedValue(stripeCard());
    expect(await refreshCardFromStripe('pm_a', { source: 'webhook', database: fakeKnex(rows) })).toEqual({ updated: 1, conflict: false });
    expect(stripe.retrievePaymentMethod).toHaveBeenCalledWith('pm_a');
    expect(rows[0].exp_year).toBe('2029');
  });

  // Codex #7672 r3: the daily refresh reads Stripe just before the account updater renews the card, the webhook's
  // refresh writes the renewal, then the daily one resumes with its older answer. It compares with the row as read
  // BEFORE its Stripe read, so it has nothing to write, and the renewal stays.
  test('an older Stripe answer than a concurrent refresh already wrote is never applied', async () => {
    const rows = [card()]; // portal 11/2026
    stripe.retrievePaymentMethod.mockImplementationOnce(async () => {
      Object.assign(rows[0], { exp_month: '11', exp_year: '2029' }); // the webhook's refresh lands meanwhile
      return stripeCard({}, { exp_month: 11, exp_year: 2026 }); // the daily answer, from before the renewal
    });
    const knex = fakeKnex(rows);
    expect(await refreshCardFromStripe('pm_a', { source: 'daily_sync', database: knex })).toEqual({ updated: 0, conflict: false });
    expect(rows[0]).toMatchObject({ exp_month: '11', exp_year: '2029' });
    expect(knex.updates).toEqual([]);
  });

  test('a row that changed while Stripe answered is not written; the refresh reads both again', async () => {
    const rows = [card()]; // portal 11/2026
    stripe.retrievePaymentMethod
      .mockImplementationOnce(async () => {
        Object.assign(rows[0], { exp_month: '11', exp_year: '2029' }); // a concurrent refresh lands first
        return stripeCard({}, { exp_month: 12, exp_year: 2028 });
      })
      .mockResolvedValueOnce(stripeCard({}, { exp_month: 12, exp_year: 2030 }));
    const knex = fakeKnex(rows);
    expect(await refreshCardFromStripe('pm_a', { database: knex })).toEqual({ updated: 1, conflict: false });
    expect(stripe.retrievePaymentMethod).toHaveBeenCalledTimes(2);
    // The first write was refused (the row no longer held what was read); the second applied the fresh answer.
    expect(knex.updates).toHaveLength(2);
    expect(rows[0]).toMatchObject({ exp_month: '12', exp_year: '2030' });
  });

  test('a card that keeps changing stops after three tries and reports the conflict', async () => {
    const rows = [card()];
    let year = 2027;
    stripe.retrievePaymentMethod.mockImplementation(async () => {
      year += 1;
      Object.assign(rows[0], { exp_year: String(year) }); // another refresh lands every time
      return stripeCard({}, { exp_month: 1, exp_year: year + 10 });
    });
    expect(await refreshCardFromStripe('pm_a', { database: fakeKnex(rows) })).toEqual({ updated: 0, conflict: true });
    expect(stripe.retrievePaymentMethod).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('still changing'));
  });

  test('Stripe returning nothing, and a card with no Stripe customer, write nothing', async () => {
    const rows = [card()];
    stripe.retrievePaymentMethod.mockResolvedValueOnce(null);
    expect(await refreshCardFromStripe('pm_a', { database: fakeKnex(rows) })).toEqual({ stripeMissing: true, updated: 0 });
    stripe.retrievePaymentMethod.mockResolvedValueOnce(stripeCard({ customer: null }));
    expect(await refreshCardFromStripe('pm_a', { database: fakeKnex(rows) })).toEqual({ detached: true, updated: 0 });
    expect(rows[0].exp_year).toBe('2026');
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
      card({ id: 'other', stripe_payment_method_id: 'pm_x', processor: 'other_processor' }),
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

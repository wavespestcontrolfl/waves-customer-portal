/**
 * B10 — a dispute recorded on a collections call (collections_flags
 * collection_hold, customer-level) must stop off-session charges exactly like
 * an admin-stopped follow-up sequence does.
 *
 * Covered: the shared lookup (active hold, release resumes, pre-existing
 * rows honored, lookup failure throws), dunningStoppedInvoiceIds (sweep +
 * combined pay chokepoint), the sweep end to end, the binding check inside
 * chargeInvoiceWithSavedCard, and the account-credit apply.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

// ── tiny in-memory knex stand-in ──────────────────────────────────────────
function makeFakeDb(tables, { failTable = null } = {}) {
  const build = (name) => {
    const filters = [];
    const q = {};
    const rows = () => (tables[name] || []).filter((r) => filters.every((f) => f(r)));
    q.where = (a, b) => {
      if (a && typeof a === 'object') Object.entries(a).forEach(([k, v]) => filters.push((r) => String(r[k]) === String(v)));
      else filters.push((r) => String(r[a]) === String(b));
      return q;
    };
    q.whereIn = (col, vals) => { filters.push((r) => vals.map(String).includes(String(r[col]))); return q; };
    q.whereNull = (col) => { filters.push((r) => r[col] == null); return q; };
    q.forUpdate = () => q;
    q.select = async () => { if (failTable === name) throw new Error('db down'); return rows(); };
    q.first = async () => { if (failTable === name) throw new Error('db down'); return rows()[0]; };
    return q;
  };
  const fake = jest.fn((name) => build(name));
  fake.raw = jest.fn(async () => ({}));
  return fake;
}

const HOLD = { id: 'f1', customer_id: 'cust-1', flag: 'collection_hold', released_at: null };
const INVOICES = [
  { id: 'inv-1', customer_id: 'cust-1' },
  { id: 'inv-2', customer_id: 'cust-1' },
  { id: 'inv-9', customer_id: 'cust-2' },
];

describe('collection-hold lookup', () => {
  const load = (tables, opts) => {
    jest.resetModules();
    jest.doMock('../models/db', () => makeFakeDb(tables, opts));
    return require('../services/collections/collection-hold');
  };

  test('an unreleased collection_hold row holds the customer', async () => {
    const m = load({ collections_flags: [{ ...HOLD }] });
    expect(await m.customerHasActiveCollectionHold('cust-1')).toBe(true);
    expect(await m.customerHasActiveCollectionHold('cust-2')).toBe(false);
    expect(await m.customerHasActiveCollectionHold(null)).toBe(false);
  });

  test('releasing the hold (released_at stamped) re-enables charging', async () => {
    const flags = [{ ...HOLD }];
    const m = load({ collections_flags: flags });
    expect(await m.customerHasActiveCollectionHold('cust-1')).toBe(true);
    flags[0].released_at = new Date(); // what flags.releaseFlag does
    expect(await m.customerHasActiveCollectionHold('cust-1')).toBe(false);
  });

  test('other flags (pays_by_check, do_not_text) are not a charge hold', async () => {
    const m = load({ collections_flags: [{ ...HOLD, flag: 'pays_by_check' }, { ...HOLD, id: 'f2', flag: 'do_not_text' }] });
    expect(await m.customerHasActiveCollectionHold('cust-1')).toBe(false);
  });

  test('collectionHoldInvoiceIds maps invoices to their customer\'s hold only', async () => {
    const m = load({ invoices: INVOICES, collections_flags: [{ ...HOLD }] });
    expect([...await m.collectionHoldInvoiceIds(['inv-1', 'inv-2', 'inv-9'])].sort()).toEqual(['inv-1', 'inv-2']);
    expect((await m.collectionHoldInvoiceIds([])).size).toBe(0);
  });

  test('a lookup failure throws — never reads as "no hold"', async () => {
    const m = load({ invoices: INVOICES, collections_flags: [] }, { failTable: 'collections_flags' });
    await expect(m.customerHasActiveCollectionHold('cust-1')).rejects.toThrow('db down');
    await expect(m.collectionHoldInvoiceIds(['inv-1'])).rejects.toThrow('db down');
  });
});

describe('dunningStoppedInvoiceIds honors the collections hold', () => {
  const load = (tables, opts) => {
    jest.resetModules();
    jest.doMock('../models/db', () => makeFakeDb(tables, opts));
    jest.doMock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
    return require('../services/completion-balance-sweep');
  };

  test('union of stopped sequences and held customers', async () => {
    const { dunningStoppedInvoiceIds } = load({
      invoices: INVOICES,
      invoice_followup_sequences: [{ invoice_id: 'inv-9', status: 'stopped' }],
      collections_flags: [{ ...HOLD }],
    });
    expect([...await dunningStoppedInvoiceIds(['inv-1', 'inv-2', 'inv-9'])].sort()).toEqual(['inv-1', 'inv-2', 'inv-9']);
  });

  test('no hold and no stopped sequence → nothing stopped; a released hold stops nothing', async () => {
    const { dunningStoppedInvoiceIds } = load({
      invoices: INVOICES,
      invoice_followup_sequences: [],
      collections_flags: [{ ...HOLD, released_at: new Date() }],
    });
    expect((await dunningStoppedInvoiceIds(['inv-1', 'inv-2', 'inv-9'])).size).toBe(0);
  });

  test('hold lookup failure propagates (callers refuse)', async () => {
    const { dunningStoppedInvoiceIds } = load({
      invoices: INVOICES, invoice_followup_sequences: [], collections_flags: [],
    }, { failTable: 'collections_flags' });
    await expect(dunningStoppedInvoiceIds(['inv-1'])).rejects.toThrow('db down');
  });
});

describe('completion balance sweep with a dispute hold', () => {
  const OLD = { service_date: '2020-01-01', scheduled_service_id: null, service_record_id: null, notes: null, line_items: [], total: '50.00', subtotal: '50.00', discount_amount: '0' };
  let flags;
  let mockCharge;
  let runCompletionBalanceSweep;

  beforeEach(() => {
    jest.resetModules();
    flags = [{ ...HOLD }];
    const invoices = [
      { ...OLD, id: 'inv-1', customer_id: 'cust-1', invoice_number: 'INV-1' },
      { ...OLD, id: 'inv-2', customer_id: 'cust-1', invoice_number: 'INV-2' },
    ];
    jest.doMock('../models/db', () => makeFakeDb({ invoices, invoice_followup_sequences: [], collections_flags: flags }));
    jest.doMock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
    jest.doMock('../services/autopay-log', () => ({ logAutopay: jest.fn(async () => {}) }));
    jest.doMock('../services/open-balance', () => ({ openBalanceInvoices: jest.fn(async () => invoices) }));
    mockCharge = jest.fn(async () => ({ status: 'paid' }));
    jest.doMock('../services/stripe', () => ({
      chargeInvoiceWithSavedCard: (...a) => mockCharge(...a),
      savedCardChargeSuppressesAlternateCollection: () => false,
      savedCardChargeNeedsReconciliation: () => false,
    }));
    ({ runCompletionBalanceSweep } = require('../services/completion-balance-sweep'));
  });

  const args = { customerId: 'cust-1', excludeInvoiceId: 'inv-current', paymentMethodId: 'pm-1' };

  test('an active dispute hold: nothing is charged, every candidate counted skipped', async () => {
    const result = await runCompletionBalanceSweep(args);
    expect(mockCharge).not.toHaveBeenCalled();
    expect(result).toMatchObject({ charged: 0, skipped: 2, considered: 2 });
  });

  test('after the hold is released the same sweep charges again', async () => {
    flags[0].released_at = new Date();
    const result = await runCompletionBalanceSweep(args);
    expect(mockCharge).toHaveBeenCalledTimes(2);
    expect(result.charged).toBe(2);
    // the binding check still rides every charge
    expect(mockCharge.mock.calls[0][2]).toMatchObject({ refuseWhenDunningStopped: true });
  });

  test('a hold-lookup failure fails closed: no charge, never throws', async () => {
    jest.resetModules();
    const invoices = [{ ...OLD, id: 'inv-1', customer_id: 'cust-1', invoice_number: 'INV-1' }];
    jest.doMock('../models/db', () => makeFakeDb({ invoices, invoice_followup_sequences: [], collections_flags: [] }, { failTable: 'collections_flags' }));
    jest.doMock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
    jest.doMock('../services/autopay-log', () => ({ logAutopay: jest.fn(async () => {}) }));
    jest.doMock('../services/open-balance', () => ({ openBalanceInvoices: jest.fn(async () => invoices) }));
    const charge = jest.fn(async () => ({ status: 'paid' }));
    jest.doMock('../services/stripe', () => ({
      chargeInvoiceWithSavedCard: charge,
      savedCardChargeSuppressesAlternateCollection: () => false,
      savedCardChargeNeedsReconciliation: () => false,
    }));
    const { runCompletionBalanceSweep: sweep } = require('../services/completion-balance-sweep');
    await expect(sweep(args)).resolves.toMatchObject({ charged: 0 });
    expect(charge).not.toHaveBeenCalled();
  });
});

describe('chargeInvoiceWithSavedCard binding check (refuseWhenDunningStopped)', () => {
  const invoice = {
    id: 'inv-1', invoice_number: 'INV-1', customer_id: 'cust-1', status: 'draft',
    subtotal: '200.00', total: '200.00', discount_amount: '0.00',
    credit_applied: '0.00', payer_id: null, stripe_payment_intent_id: null,
  };
  const card = {
    id: 'pm-1', customer_id: 'cust-1', method_type: 'card',
    stripe_payment_method_id: 'pm_stripe_1', card_funding: 'debit', last_four: '4242',
  };

  // Mirrors stripe-saved-card-quote.test.js: the invoice/method/attempt reads
  // are real-shaped; collections_flags is the state under test.
  function setup({ holdRows, holdThrows = false }) {
    jest.resetModules();
    const events = [];
    // doMock registrations outlive resetModules — drop the sweep block's fake.
    jest.dontMock('../services/stripe');
    let chargeAttempt = null;
    const db = jest.fn((table) => {
      const chain = {};
      ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereRaw', 'orWhereColumn', 'forUpdate', 'orderBy'].forEach((method) => {
        chain[method] = jest.fn((arg) => {
          if (method === 'where' && typeof arg === 'function') arg.call(chain);
          return chain;
        });
      });
      chain.first = jest.fn(async () => {
        if (table === 'invoices') return invoice;
        if (table === 'payment_methods') return card;
        if (table === 'customers') return { id: 'cust-1', stripe_customer_id: 'cus-1' };
        if (table === 'collections_flags') {
          events.push('flags-read');
          if (holdThrows) throw new Error('flags table unreadable');
          return holdRows[0];
        }
        if (table === 'stripe_invoice_charge_attempts') return chargeAttempt;
        return null;
      });
      chain.insert = jest.fn((payload) => {
        if (table === 'stripe_invoice_charge_attempts') chargeAttempt = { ...payload, created_at: new Date(), resolved_at: null };
        return chain;
      });
      chain.returning = jest.fn(async () => (chargeAttempt ? [chargeAttempt] : []));
      chain.update = jest.fn(async (payload) => {
        if (table === 'stripe_invoice_charge_attempts' && chargeAttempt) Object.assign(chargeAttempt, payload);
        return 1;
      });
      chain.select = jest.fn(async () => { const row = await chain.first(); return row ? [row] : []; });
      return chain;
    });
    db.transaction = jest.fn(async (callback) => callback(db));
    db.fn = { now: jest.fn(() => 'NOW') };
    db.raw = jest.fn((sql, bindings) => { events.push(`raw:${sql}`); return { sql, bindings }; });
    const stripeClient = { paymentIntents: { retrieve: jest.fn(), cancel: jest.fn(), create: jest.fn(async () => { throw new Error('REACHED_STRIPE'); }) } };
    jest.doMock('../models/db', () => db);
    jest.doMock('stripe', () => jest.fn(() => stripeClient));
    jest.doMock('../config', () => ({}));
    jest.doMock('../config/stripe-config', () => ({ secretKey: 'sk_test_mock', publishableKey: 'pk_test_mock' }));
    jest.doMock('../config/feature-gates', () => ({ gates: { autoApplyAccountCredit: false } }));
    return { StripeService: require('../services/stripe'), stripeClient, events, db };
  }

  test('an active dispute hold refuses the charge before Stripe (INVOICE_COLLECTION_STOPPED)', async () => {
    const { StripeService, stripeClient } = setup({ holdRows: [{ ...HOLD }] });
    await expect(StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', { refuseWhenDunningStopped: true }))
      .rejects.toMatchObject({ code: 'INVOICE_COLLECTION_STOPPED', message: expect.stringContaining('billing dispute') });
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
  });

  test('with the hold released the guard passes and the charge proceeds to Stripe', async () => {
    const { StripeService, stripeClient } = setup({ holdRows: [] });
    await expect(StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', { refuseWhenDunningStopped: true }))
      .rejects.not.toMatchObject({ code: 'INVOICE_COLLECTION_STOPPED' });
    expect(stripeClient.paymentIntents.create).toHaveBeenCalled();
  });

  test('a hold-lookup failure fails closed: the charge throws before Stripe', async () => {
    const { StripeService, stripeClient } = setup({ holdRows: [], holdThrows: true });
    await expect(StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', { refuseWhenDunningStopped: true }))
      .rejects.toThrow('flags table unreadable');
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
  });

  test('refuseWhenCollectionHold alone (completion lanes) refuses on a hold and never reads the follow-up sequence', async () => {
    const { StripeService, stripeClient, db } = setup({ holdRows: [{ ...HOLD }] });
    await expect(StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', { refuseWhenCollectionHold: true }))
      .rejects.toMatchObject({ code: 'INVOICE_COLLECTION_STOPPED', message: expect.stringContaining('billing dispute') });
    expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
    expect(db.mock.calls.map((c) => c[0])).not.toContain('invoice_followup_sequences');
  });

  test('refuseWhenCollectionHold alone lets a clean customer through to Stripe', async () => {
    const { StripeService, stripeClient } = setup({ holdRows: [] });
    await expect(StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', { refuseWhenCollectionHold: true }))
      .rejects.not.toMatchObject({ code: 'INVOICE_COLLECTION_STOPPED' });
    expect(stripeClient.paymentIntents.create).toHaveBeenCalled();
  });

  test('P0 ordering: the customer hold lock is taken BEFORE the hold is read, and before Stripe', async () => {
    const { StripeService, events } = setup({ holdRows: [] });
    await StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', { refuseWhenCollectionHold: true }).catch(() => {});
    const lockAt = events.findIndex((e) => e.startsWith('raw:SELECT pg_advisory_xact_lock_shared'));
    const readAt = events.indexOf('flags-read');
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(readAt).toBeGreaterThan(lockAt);
  });

  test('callers that did not opt in (admin charge-card) are unchanged by a hold', async () => {
    const { StripeService, stripeClient } = setup({ holdRows: [{ ...HOLD }] });
    await expect(StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', {}))
      .rejects.not.toMatchObject({ code: 'INVOICE_COLLECTION_STOPPED' });
    expect(stripeClient.paymentIntents.create).toHaveBeenCalled();
  });
});

describe('applyAccountCreditToInvoice (refuseWhenDunningStopped) honors the hold', () => {
  const load = (tables, opts) => {
    jest.resetModules();
    jest.doMock('../models/db', () => makeFakeDb(tables, opts));
    const credit = require('../services/customer-credit');
    return { credit, trx: makeFakeDb(tables, opts) };
  };
  const base = () => ({
    invoices: [{ id: 'inv-1', customer_id: 'cust-1', status: 'sent', total: '50.00', credit_applied: '0' }],
    invoice_followup_sequences: [],
  });

  test('an active dispute hold consumes no credit', async () => {
    const { credit, trx } = load({ ...base(), collections_flags: [{ ...HOLD }] });
    await expect(credit.applyAccountCreditToInvoice({ invoiceId: 'inv-1', customerRequested: true, refuseWhenDunningStopped: true }, trx))
      .resolves.toEqual({ applied: 0, skipped: 'dunning_stopped' });
  });

  test('a lookup failure throws (fail closed) rather than applying credit', async () => {
    const { credit, trx } = load({ ...base(), collections_flags: [] }, { failTable: 'collections_flags' });
    await expect(credit.applyAccountCreditToInvoice({ invoiceId: 'inv-1', customerRequested: true, refuseWhenDunningStopped: true }, trx))
      .rejects.toThrow('db down');
  });

  test('a released hold no longer short-circuits with dunning_stopped', async () => {
    const { credit, trx } = load({ ...base(), collections_flags: [{ ...HOLD, released_at: new Date() }] });
    let outcome;
    try { outcome = await credit.applyAccountCreditToInvoice({ invoiceId: 'inv-1', customerRequested: true, refuseWhenDunningStopped: true }, trx); } catch (e) { outcome = { threw: e.message }; }
    expect(outcome).not.toEqual({ applied: 0, skipped: 'dunning_stopped' });
  });
});

describe('applyAccountCreditToInvoice refuseWhenCollectionHold (hold only)', () => {
  test('refuses on a hold without reading the follow-up sequence, and takes the shared lock first', async () => {
    jest.resetModules();
    const tables = { invoices: [{ id: 'inv-1', customer_id: 'cust-1', status: 'sent', total: '50.00', credit_applied: '0' }], invoice_followup_sequences: [], collections_flags: [{ ...HOLD }] };
    jest.doMock('../models/db', () => makeFakeDb(tables));
    const trx = makeFakeDb(tables);
    const credit = require('../services/customer-credit');
    await expect(credit.applyAccountCreditToInvoice({ invoiceId: 'inv-1', customerRequested: true, refuseWhenCollectionHold: true }, trx))
      .resolves.toEqual({ applied: 0, skipped: 'dunning_stopped' });
    expect(trx.raw).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock_shared'), ['collections_hold:cust-1']);
    expect(trx.mock.calls.map((c) => c[0])).not.toContain('invoice_followup_sequences');
  });
});

describe('completion route wiring (complete-scheduled-service.js)', () => {
  // The completion handler is too large to drive in a unit test; pin the two
  // automatic money calls it makes to the hold guard, on EVERY lane.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');

  test('the automatic account-credit apply asks for the hold guard on every lane', () => {
    const i = src.indexOf('const creditResult = await applyAccountCreditToInvoice({');
    expect(i).toBeGreaterThan(0);
    const end = src.indexOf('if (creditResult?.applied > 0)', i);
    const call = src.slice(i, end);
    // Top level of the options object (after the lane spreads), not inside one.
    expect(call).toMatch(/\} : \{\}\),\s*(\/\/[^\n]*\n\s*)*refuseWhenCollectionHold: true,\s*\}\);/);
  });

  test('the automatic completion charge asks for the hold guard on every lane; the stopped-sequence guard stays extended-lane only', () => {
    const i = src.indexOf('await StripeService.chargeInvoiceWithSavedCard(invoice.id, autopayPm.id, {');
    expect(i).toBeGreaterThan(0);
    const call = src.slice(i, i + 9000);
    const holdAt = call.indexOf('refuseWhenCollectionHold: true');
    const stoppedAt = call.indexOf('refuseWhenDunningStopped: true');
    expect(holdAt).toBeGreaterThan(0);
    expect(holdAt).toBeLessThan(call.indexOf('maxAuthorizedSubtotal: capCeiling'));
    // still inside the extendedAutopayCharge spread
    expect(call.slice(0, stoppedAt)).toMatch(/\.\.\.\(extendedAutopayCharge \? \{[^}]*$/s);
  });
});

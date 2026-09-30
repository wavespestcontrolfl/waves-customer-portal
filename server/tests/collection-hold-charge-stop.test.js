/**
 * B10 — a DISPUTE hold recorded on a collections call (collections_flags
 * collection_hold whose reason starts with "dispute") stops off-session
 * charges BY DEFAULT in the charge primitives; customer- and operator-
 * initiated callers opt out explicitly. Fallback collection_hold rows
 * (wrong-number / wrong-party artifacts) never stop money.
 *
 * Covered here (mocked db): the shared lookup and its dispute discriminator,
 * dunningStoppedInvoiceIds, the sweep, the three primitives
 * (chargeInvoiceWithSavedCard, charge / chargeMonthly / chargeOneTime,
 * chargeSavedPaymentMethodOffSession) incl. opt-outs and fail-closed, the
 * account-credit apply, and the completion route wiring. Real-Postgres
 * behaviour lives in collection-hold-postgres.test.js.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

// ── tiny in-memory knex stand-in ──────────────────────────────────────────
// whereRaw understands the one predicate the hold lookup uses:
//   reason ILIKE ?   (prefix match, case-insensitive)
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
    q.whereRaw = (sql, bindings = []) => {
      if (/reason ILIKE \?/i.test(sql)) {
        const prefix = String(bindings[0]).replace(/%$/, '').toLowerCase();
        filters.push((r) => String(r.reason || '').toLowerCase().startsWith(prefix));
      }
      return q;
    };
    q.forUpdate = () => q;
    q.select = async () => { if (failTable === name) throw new Error('db down'); return rows(); };
    q.first = async () => { if (failTable === name) throw new Error('db down'); return rows()[0]; };
    return q;
  };
  const fake = jest.fn((name) => build(name));
  fake.raw = jest.fn(async () => ({}));
  return fake;
}

// A dispute hold exactly as placeDisputeHold writes it, and the two
// fallback artifacts exactly as collections-conversation.js writes them.
const HOLD = { id: 'f1', customer_id: 'cust-1', flag: 'collection_hold', reason: 'dispute on call: says the July bill is wrong', released_at: null };
const FALLBACK_WRONG_NUMBER = { id: 'f2', customer_id: 'cust-1', flag: 'collection_hold', reason: 'wrong-number report on billing follow-up call; wrong_number flag write failed', released_at: null };
const FALLBACK_WRONG_PARTY = { id: 'f3', customer_id: 'cust-1', flag: 'collection_hold', reason: 'wrong-party answer on billing follow-up call; review card failed to file', released_at: null };
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

  test.each([
    ['with a summary', 'dispute on call: says the July bill is wrong'],
    ['without a summary', 'dispute raised on call'],
    ['upgraded over a fallback row', 'dispute on call: x; earlier hold: wrong-number report on billing follow-up call'],
  ])('an unreleased dispute hold (%s) holds the customer', async (_label, reason) => {
    const m = load({ collections_flags: [{ ...HOLD, reason }] });
    expect(await m.customerHasActiveCollectionHold('cust-1')).toBe(true);
    expect(await m.customerHasActiveCollectionHold('cust-2')).toBe(false);
    expect(await m.customerHasActiveCollectionHold(null)).toBe(false);
  });

  test('fallback collection_hold artifacts (wrong number / wrong party / no reason) do NOT stop money', async () => {
    const m = load({ collections_flags: [FALLBACK_WRONG_NUMBER, FALLBACK_WRONG_PARTY, { ...HOLD, id: 'f4', reason: null }] });
    expect(await m.customerHasActiveCollectionHold('cust-1')).toBe(false);
  });

  test('releasing the hold (released_at stamped) re-enables charging', async () => {
    const flags = [{ ...HOLD }];
    const m = load({ collections_flags: flags });
    expect(await m.customerHasActiveCollectionHold('cust-1')).toBe(true);
    flags[0].released_at = new Date(); // what flags.releaseFlag does
    expect(await m.customerHasActiveCollectionHold('cust-1')).toBe(false);
  });

  test('other flags (pays_by_check, do_not_text) are not a charge hold', async () => {
    const m = load({ collections_flags: [{ ...HOLD, flag: 'pays_by_check' }, { ...HOLD, id: 'f9', flag: 'do_not_text' }] });
    expect(await m.customerHasActiveCollectionHold('cust-1')).toBe(false);
  });

  test('collectionHoldInvoiceIds maps invoices to their customer\'s DISPUTE hold only', async () => {
    const m = load({ invoices: INVOICES, collections_flags: [{ ...HOLD }, { ...FALLBACK_WRONG_PARTY, customer_id: 'cust-2' }] });
    expect([...await m.collectionHoldInvoiceIds(['inv-1', 'inv-2', 'inv-9'])].sort()).toEqual(['inv-1', 'inv-2']);
    expect((await m.collectionHoldInvoiceIds([])).size).toBe(0);
  });

  test('the CHECKED lookup wraps a failure as COLLECTION_HOLD_CHECK_FAILED (retryable, pre-Stripe) — never the raw DB error', async () => {
    const m = load({ collections_flags: [] }, { failTable: 'collections_flags' });
    await expect(m.customerHasActiveCollectionHoldChecked('cust-1')).rejects.toMatchObject({ code: 'COLLECTION_HOLD_CHECK_FAILED', cause: expect.objectContaining({ message: 'db down' }) });
    await expect(m.assertNoCollectionHold('cust-1')).rejects.toMatchObject({ code: 'COLLECTION_HOLD_CHECK_FAILED' });
    expect(m.isCollectionHoldRefusal({ code: 'COLLECTION_HOLD_CHECK_FAILED' })).toBe(true);
    expect(m.isCollectionHoldRefusal({ code: 'COLLECTION_HOLD_ACTIVE' })).toBe(true);
    // the admin-stopped follow-up sequence code is a DIFFERENT thing
    expect(m.isCollectionHoldRefusal({ code: 'INVOICE_COLLECTION_STOPPED' })).toBe(false);
    expect(m.isCollectionHoldRefusal(new Error('card_declined'))).toBe(false);
  });

  test('assertNoCollectionHold throws COLLECTION_HOLD_ACTIVE only for a dispute hold', async () => {
    const held = load({ collections_flags: [{ ...HOLD }] });
    await expect(held.assertNoCollectionHold('cust-1')).rejects.toMatchObject({ code: 'COLLECTION_HOLD_ACTIVE' });
    await expect(held.assertNoCollectionHold('cust-2')).resolves.toBeUndefined();
    const fallbackOnly = load({ collections_flags: [FALLBACK_WRONG_NUMBER] });
    await expect(fallbackOnly.assertNoCollectionHold('cust-1')).resolves.toBeUndefined();
  });

  test('a raw lookup failure throws — never reads as "no hold"', async () => {
    const m = load({ invoices: INVOICES, collections_flags: [] }, { failTable: 'collections_flags' });
    await expect(m.customerHasActiveCollectionHold('cust-1')).rejects.toThrow('db down');
    await expect(m.collectionHoldInvoiceIds(['inv-1'])).rejects.toThrow('db down');
  });
});

describe('dunningStoppedInvoiceIds honors the collections dispute hold', () => {
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

  test('no hold, a fallback hold, or a released hold stops nothing', async () => {
    const { dunningStoppedInvoiceIds } = load({
      invoices: INVOICES,
      invoice_followup_sequences: [],
      collections_flags: [{ ...HOLD, released_at: new Date() }, FALLBACK_WRONG_NUMBER],
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
  let mockLogAutopay;
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
    mockLogAutopay = jest.fn(async () => {});
    jest.doMock('../services/autopay-log', () => ({ logAutopay: (...a) => mockLogAutopay(...a) }));
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
    expect(mockCharge.mock.calls[0][2]).toMatchObject({ refuseWhenDunningStopped: true });
  });

  test('a fallback (non-dispute) collection_hold does not stop the sweep', async () => {
    flags[0] = { ...FALLBACK_WRONG_PARTY };
    const result = await runCompletionBalanceSweep(args);
    expect(result.charged).toBe(2);
  });

  test.each(['COLLECTION_HOLD_ACTIVE', 'COLLECTION_HOLD_CHECK_FAILED'])('a hold refusal from the charge (%s) is a quiet SKIP — not a failed charge, logged as skipped_collection_hold', async (code) => {
    flags[0].released_at = new Date(); // preflight passes; the primitive's own check is what refuses
    mockCharge.mockRejectedValueOnce(Object.assign(new Error('hold'), { code }));
    const result = await runCompletionBalanceSweep(args);
    expect(result).toMatchObject({ charged: 0, failed: 0, skipped: 1 });
    expect(mockCharge).toHaveBeenCalledTimes(1); // sweep stops
    expect(mockLogAutopay).toHaveBeenCalledWith('cust-1', 'skipped_collection_hold', expect.anything());
    expect(mockLogAutopay).not.toHaveBeenCalledWith('cust-1', 'charge_failed', expect.anything());
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

// ── the three off-session primitives ──────────────────────────────────────
describe('off-session charge primitives — the hold check is default-ON', () => {
  const invoice = {
    id: 'inv-1', invoice_number: 'INV-1', customer_id: 'cust-1', status: 'draft',
    subtotal: '200.00', total: '200.00', discount_amount: '0.00',
    credit_applied: '0.00', payer_id: null, stripe_payment_intent_id: null,
  };
  const card = {
    id: 'pm-1', customer_id: 'cust-1', method_type: 'card',
    stripe_payment_method_id: 'pm_stripe_1', card_funding: 'debit', last_four: '4242',
  };

  // holdRows are what the collections_flags query returns (the fake below does
  // not evaluate SQL predicates — discrimination is covered by the lookup
  // tests above and the real-Postgres suite).
  function setup({ holdRows = [], holdThrows = false } = {}) {
    jest.resetModules();
    const events = [];
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
    const audit = jest.fn(async () => {});
    const autopay = jest.fn(async () => {});
    jest.doMock('../services/audit-log', () => ({ recordAuditEvent: audit }));
    jest.doMock('../services/autopay-log', () => ({ logAutopay: autopay }));
    return { StripeService: require('../services/stripe'), stripeClient, events, db, audit, autopay };
  }

  const HOLD_ROW = [{ id: 'f1' }];

  describe('chargeInvoiceWithSavedCard', () => {
    test('a dispute hold refuses the charge before Stripe with COLLECTION_HOLD_ACTIVE — no opt-in needed', async () => {
      const { StripeService, stripeClient } = setup({ holdRows: HOLD_ROW });
      await expect(StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', {}))
        .rejects.toMatchObject({ code: 'COLLECTION_HOLD_ACTIVE', message: expect.stringContaining('billing dispute') });
      expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
    });

    test('with no hold the charge proceeds to Stripe', async () => {
      const { StripeService, stripeClient } = setup({ holdRows: [] });
      await expect(StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', {}))
        .rejects.not.toMatchObject({ code: 'COLLECTION_HOLD_ACTIVE' });
      expect(stripeClient.paymentIntents.create).toHaveBeenCalled();
    });

    test('a hold-lookup failure fails closed with COLLECTION_HOLD_CHECK_FAILED before Stripe', async () => {
      const { StripeService, stripeClient } = setup({ holdThrows: true });
      await expect(StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', {}))
        .rejects.toMatchObject({ code: 'COLLECTION_HOLD_CHECK_FAILED', message: expect.stringContaining('flags table unreadable') });
      expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
    });

    test('customerInitiated (the customer is at the keyboard) opts out - a hold does not refuse and the hold is not even read', async () => {
      const { StripeService, stripeClient, events } = setup({ holdRows: HOLD_ROW });
      await expect(StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', { customerInitiated: true }))
        .rejects.not.toMatchObject({ code: 'COLLECTION_HOLD_ACTIVE' });
      expect(stripeClient.paymentIntents.create).toHaveBeenCalled();
      expect(events).not.toContain('flags-read');
    });

    describe('operatorOverride records the override AT the charge boundary', () => {
      const trail = { actorId: 'admin-7', ip: '1.2.3.4', userAgent: 'ua', route: 'admin_invoice_charge_card', invoiceId: 'inv-1' };

      test('an active dispute hold at the locked check: the charge proceeds and audit + collection_hold_overridden name the admin', async () => {
        const { StripeService, stripeClient, audit, autopay } = setup({ holdRows: HOLD_ROW });
        await expect(StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', { operatorOverride: true, overrideTrail: trail }))
          .rejects.not.toMatchObject({ code: 'COLLECTION_HOLD_ACTIVE' });
        expect(stripeClient.paymentIntents.create).toHaveBeenCalled();
        expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'customer.collection_hold_overridden', actor_id: 'admin-7', resource_id: 'cust-1', ip_address: '1.2.3.4' }));
        expect(autopay).toHaveBeenCalledWith('cust-1', 'collection_hold_overridden', { details: expect.objectContaining({ admin_id: 'admin-7', route: 'admin_invoice_charge_card', invoice_id: 'inv-1' }) });
      });

      test('no hold: the charge proceeds and nothing is recorded', async () => {
        const { StripeService, stripeClient, audit, autopay } = setup({ holdRows: [] });
        await StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', { operatorOverride: true, overrideTrail: trail }).catch(() => {});
        expect(stripeClient.paymentIntents.create).toHaveBeenCalled();
        expect(audit).not.toHaveBeenCalled();
        expect(autopay).not.toHaveBeenCalled();
      });

      test('a failing hold lookup or audit write never blocks the charge', async () => {
        const broken = setup({ holdThrows: true });
        await expect(broken.StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', { operatorOverride: true, overrideTrail: trail }))
          .rejects.not.toMatchObject({ code: 'COLLECTION_HOLD_CHECK_FAILED' });
        expect(broken.stripeClient.paymentIntents.create).toHaveBeenCalled();
        const auditDown = setup({ holdRows: HOLD_ROW });
        auditDown.audit.mockRejectedValueOnce(new Error('audit down'));
        await auditDown.StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', { operatorOverride: true, overrideTrail: trail }).catch(() => {});
        expect(auditDown.stripeClient.paymentIntents.create).toHaveBeenCalled();
      });

      test('the hold is read AFTER the invoice lock inside the charge transaction, not pre-checked by the route', async () => {
        const { StripeService, db } = setup({ holdRows: HOLD_ROW });
        await StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', { operatorOverride: true, overrideTrail: trail }).catch(() => {});
        const tables = db.mock.calls.map((c) => c[0]);
        expect(tables.indexOf('collections_flags')).toBeGreaterThan(tables.indexOf('invoices'));
      });
    });

    test('the hold read takes NO advisory lock — the hold writer never waits on a charge', async () => {
      const { StripeService, events } = setup({ holdRows: [] });
      await StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', {}).catch(() => {});
      expect(events.filter((e) => /advisory/i.test(e))).toEqual([]);
    });

    test('the admin-stopped follow-up sequence check is independent of the hold (refuseWhenDunningStopped, extended lane only)', async () => {
      const { StripeService, db } = setup({ holdRows: [] });
      await StripeService.chargeInvoiceWithSavedCard('inv-1', 'pm-1', {}).catch(() => {});
      expect(db.mock.calls.map((c) => c[0])).not.toContain('invoice_followup_sequences');
    });
  });

  describe('charge / chargeMonthly / chargeOneTime (monthly dues + retries)', () => {
    test('a dispute hold refuses charge() before any customer/Stripe work — COLLECTION_HOLD_ACTIVE', async () => {
      const { StripeService, stripeClient, db } = setup({ holdRows: HOLD_ROW });
      await expect(StripeService.charge('cust-1', 89, 'Silver WaveGuard Monthly', {}, 'k1'))
        .rejects.toMatchObject({ code: 'COLLECTION_HOLD_ACTIVE' });
      expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
      expect(db.mock.calls.map((c) => c[0])).not.toContain('customers');
    });

    test('chargeOneTime forwards the guard; a lookup failure fails closed', async () => {
      const held = setup({ holdRows: HOLD_ROW });
      await expect(held.StripeService.chargeOneTime('cust-1', 50, 'x', 'k2', {})).rejects.toMatchObject({ code: 'COLLECTION_HOLD_ACTIVE' });
      const broken = setup({ holdThrows: true });
      await expect(broken.StripeService.chargeOneTime('cust-1', 50, 'x', 'k3', {})).rejects.toMatchObject({ code: 'COLLECTION_HOLD_CHECK_FAILED' });
    });

    test('operatorOverride (admin Charge now) is not refused and records the override at the boundary when a hold is active', async () => {
      const { StripeService, audit, autopay, stripeClient } = setup({ holdRows: HOLD_ROW });
      await expect(StripeService.charge('cust-1', 89, 'x', {}, 'k4', {
        operatorOverride: true, overrideTrail: { actorId: 'admin-7', route: 'admin_charge_now' },
      })).rejects.not.toMatchObject({ code: 'COLLECTION_HOLD_ACTIVE' });
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'customer.collection_hold_overridden', actor_id: 'admin-7' }));
      expect(autopay).toHaveBeenCalledWith('cust-1', 'collection_hold_overridden', { details: expect.objectContaining({ admin_id: 'admin-7', route: 'admin_charge_now' }) });
      expect(stripeClient.paymentIntents.create).toBeDefined();
    });

    test('chargeOneTime forwards the override + its trail to charge()', async () => {
      const { StripeService, audit } = setup({ holdRows: HOLD_ROW });
      await StripeService.chargeOneTime('cust-1', 50, 'x', 'k6', {}, { operatorOverride: true, overrideTrail: { actorId: 'admin-8', route: 'admin_charge_now' } }).catch(() => {});
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({ actor_id: 'admin-8' }));
    });

    test('chargeMonthly has no override option (no production caller uses one): it always goes through the default-on guard', () => {
      const { StripeService } = setup({ holdRows: HOLD_ROW });
      expect(StripeService.chargeMonthly.toString()).not.toMatch(/operatorOverride/);
      expect(StripeService.chargeMonthly.length).toBeLessThanOrEqual(2);
    });

    test('no hold: charge() gets past the guard', async () => {
      const { StripeService } = setup({ holdRows: [] });
      await expect(StripeService.charge('cust-1', 89, 'x', {}, 'k5')).rejects.not.toMatchObject({ code: 'COLLECTION_HOLD_ACTIVE' });
    });
  });

  describe('chargeSavedPaymentMethodOffSession (no-show / late-cancel fees)', () => {
    const feeArgs = { customerId: 'cust-1', paymentMethodId: 'pm_x', amountDollars: 49, description: 'fee', idempotencyKey: 'fee-1' };

    test('a dispute hold refuses the fee before Stripe', async () => {
      const { StripeService, stripeClient } = setup({ holdRows: HOLD_ROW });
      await expect(StripeService.chargeSavedPaymentMethodOffSession(feeArgs)).rejects.toMatchObject({ code: 'COLLECTION_HOLD_ACTIVE' });
      expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
    });

    test('a lookup failure fails closed', async () => {
      const broken = setup({ holdThrows: true });
      await expect(broken.StripeService.chargeSavedPaymentMethodOffSession(feeArgs)).rejects.toMatchObject({ code: 'COLLECTION_HOLD_CHECK_FAILED' });
    });

    test('there is no override option: a fee charge is always automatic, so a stray operatorOverride is ignored and the hold still refuses', async () => {
      const { StripeService, stripeClient } = setup({ holdRows: HOLD_ROW });
      await expect(StripeService.chargeSavedPaymentMethodOffSession({ ...feeArgs, operatorOverride: true })).rejects.toMatchObject({ code: 'COLLECTION_HOLD_ACTIVE' });
      expect(stripeClient.paymentIntents.create).not.toHaveBeenCalled();
    });
  });
});

describe('applyAccountCreditToInvoice refuseWhenCollectionHold', () => {
  const tables = () => ({
    invoices: [{ id: 'inv-1', customer_id: 'cust-1', status: 'sent', total: '50.00', credit_applied: '0' }],
    invoice_followup_sequences: [],
    collections_flags: [{ ...HOLD }],
  });
  const load = (t, opts) => {
    jest.resetModules();
    jest.doMock('../models/db', () => makeFakeDb(t));
    return { credit: require('../services/customer-credit'), trx: makeFakeDb(t, opts) };
  };

  test('refuses on a dispute hold without reading the follow-up sequence', async () => {
    const { credit, trx } = load(tables());
    await expect(credit.applyAccountCreditToInvoice({ invoiceId: 'inv-1', customerRequested: true, refuseWhenCollectionHold: true }, trx))
      .resolves.toEqual({ applied: 0, skipped: 'dunning_stopped' });
    expect(trx.mock.calls.map((c) => c[0])).not.toContain('invoice_followup_sequences');
  });

  test('a lookup failure throws COLLECTION_HOLD_CHECK_FAILED (fail closed) rather than applying credit', async () => {
    const { credit, trx } = load(tables(), { failTable: 'collections_flags' });
    await expect(credit.applyAccountCreditToInvoice({ invoiceId: 'inv-1', customerRequested: true, refuseWhenCollectionHold: true }, trx))
      .rejects.toMatchObject({ code: 'COLLECTION_HOLD_CHECK_FAILED' });
  });

  test('a released or fallback hold no longer short-circuits with dunning_stopped', async () => {
    for (const flags of [[{ ...HOLD, released_at: new Date() }], [FALLBACK_WRONG_NUMBER]]) {
      const { credit, trx } = load({ ...tables(), collections_flags: flags });
      let outcome;
      try { outcome = await credit.applyAccountCreditToInvoice({ invoiceId: 'inv-1', customerRequested: true, refuseWhenCollectionHold: true }, trx); } catch (e) { outcome = { threw: e.message }; }
      expect(outcome).not.toEqual({ applied: 0, skipped: 'dunning_stopped' });
    }
  });
});

describe('autoApplyAccountCreditIfEnabled (the automatic seam wrapper) refuses on a dispute hold', () => {
  const load = (flags) => {
    jest.resetModules();
    const fake = makeFakeDb({
      invoices: [{ id: 'inv-1', customer_id: 'cust-1', status: 'sent', total: '50.00', credit_applied: '0' }],
      invoice_followup_sequences: [],
      collections_flags: flags,
    });
    fake.transaction = jest.fn(async (fn) => fn(fake));
    jest.doMock('../models/db', () => fake);
    // credit gate ON, collections-policy rail guard OFF: the hold refusal must
    // not depend on GATE_COLLECTIONS_POLICY
    jest.doMock('../config/feature-gates', () => ({ gates: { autoApplyAccountCredit: true, collectionsPolicy: false } }));
    delete process.env.GATE_COLLECTIONS_POLICY;
    return { credit: require('../services/customer-credit'), fake };
  };

  test('an active dispute hold stops the automatic apply before the customer opt-in read or any balance movement', async () => {
    const { credit, fake } = load([{ ...HOLD }]);
    await expect(credit.autoApplyAccountCreditIfEnabled('inv-1')).resolves.toEqual({ applied: 0, skipped: 'dunning_stopped' });
    expect(fake.mock.calls.map((c) => c[0])).not.toContain('customers');
  });

  test('no hold, or a fallback (non-dispute) hold, is not refused for the hold', async () => {
    for (const flags of [[], [FALLBACK_WRONG_NUMBER]]) {
      const { credit } = load(flags);
      const out = await credit.autoApplyAccountCreditIfEnabled('inv-1');
      expect(out).not.toEqual({ applied: 0, skipped: 'dunning_stopped' });
    }
  });

  test('a customer-requested apply is not made by this wrapper and stays exempt from the hold', async () => {
    const { credit, fake } = load([{ ...HOLD }]);
    const out = await credit.applyAccountCreditToInvoice({ invoiceId: 'inv-1', customerRequested: true }, fake);
    expect(out).not.toEqual({ applied: 0, skipped: 'dunning_stopped' });
  });
});

describe('completion route wiring (complete-scheduled-service.js)', () => {
  // The completion handler is too large to drive in a unit test; pin its two
  // automatic money calls: the credit apply asks for the hold guard, and the
  // charge relies on the primitive's default (no opt-out flag).
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');

  test('the automatic account-credit apply asks for the hold guard on every lane', () => {
    const i = src.indexOf('const creditResult = await applyAccountCreditToInvoice({');
    expect(i).toBeGreaterThan(0);
    const end = src.indexOf('if (creditResult?.applied > 0)', i);
    const call = src.slice(i, end);
    expect(call).toMatch(/\} : \{\}\),\s*(\/\/[^\n]*\n\s*)*refuseWhenCollectionHold: true,\s*\}\);/);
  });

  test('the automatic completion charge has no hold opt-out (default-on) and keeps the stopped-sequence guard extended-lane only', () => {
    const i = src.indexOf('await StripeService.chargeInvoiceWithSavedCard(invoice.id, autopayPm.id, {');
    expect(i).toBeGreaterThan(0);
    const call = src.slice(i, i + 9000);
    expect(call).not.toMatch(/operatorOverride|customerInitiated: true/);
    const stoppedAt = call.indexOf('refuseWhenDunningStopped: true');
    expect(stoppedAt).toBeGreaterThan(0);
    expect(call.slice(0, stoppedAt)).toMatch(/\.\.\.\(extendedAutopayCharge \? \{[^}]*$/s);
  });
});

describe('D: visit-completion payment — a hold refusal is non-durable', () => {
  const load = () => {
    jest.resetModules();
    jest.doMock('../services/stripe', () => ({ savedCardChargeSuppressesAlternateCollection: () => false }));
    jest.doMock('../models/db', () => makeFakeDb({}));
    return require('../services/visit-completion-payment').classifyVisitPaymentError;
  };

  test.each(['COLLECTION_HOLD_ACTIVE', 'COLLECTION_HOLD_CHECK_FAILED'])('%s -> retry / payment_pending, NO durable billing_hold (resumes after release)', (code) => {
    expect(load()(Object.assign(new Error('hold'), { code }))).toEqual({ outcome: 'retry', reason: 'payment_pending', billingHold: false });
  });

  test('the durable office_required hold is still what the admin-stopped / review codes get', () => {
    const classify = load();
    expect(classify(Object.assign(new Error('x'), { code: 'INVOICE_COLLECTION_STOPPED' }))).toMatchObject({ reason: 'office_required', billingHold: true });
    expect(classify(Object.assign(new Error('x'), { code: 'VISIT_PAYMENT_REVIEW_REQUIRED' }))).toMatchObject({ billingHold: true });
    expect(classify(new Error('boom'))).toMatchObject({ outcome: 'retry', billingHold: false });
    expect(classify(Object.assign(new Error('declined'), { wavesCardDecline: {} }))).toMatchObject({ reason: 'payment_failed', billingHold: false });
  });
});

describe('recurring-card-on-file prepay recovery sweep (source pin)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../services/recurring-card-on-file.js'), 'utf8');
  test('a hold refusal defers the claimed job BEFORE the decline / pay-link fallback', () => {
    const holdAt = src.indexOf('if (isCollectionHoldRefusal(err))');
    const fallbackAt = src.indexOf('A DETERMINISTIC failure (decline, guard refusal, missing method)');
    expect(holdAt).toBeGreaterThan(0);
    expect(holdAt).toBeLessThan(fallbackAt);
    expect(src.slice(holdAt, fallbackAt)).toMatch(/continue;/);
    expect(src.slice(holdAt, fallbackAt)).not.toMatch(/sendViaSMSAndEmail|alertUncollected/);
  });
});

describe('operator override leaves a trail (never blocks)', () => {
  function load({ holdRows = [], holdThrows = false } = {}) {
    jest.resetModules();
    const audit = jest.fn(async () => {});
    const autopay = jest.fn(async () => {});
    jest.doMock('../models/db', () => makeFakeDb({ collections_flags: holdRows }, holdThrows ? { failTable: 'collections_flags' } : {}));
    jest.doMock('../services/audit-log', () => ({ recordAuditEvent: audit }));
    jest.doMock('../services/autopay-log', () => ({ logAutopay: autopay }));
    return { m: require('../services/collections/collection-hold'), audit, autopay };
  }
  const who = { customerId: 'cust-1', actorId: 'admin-7', ip: '1.2.3.4', route: 'admin_charge_now' };

  test('an active dispute hold: audit row + collection_hold_overridden autopay event naming the admin', async () => {
    const { m, audit, autopay } = load({ holdRows: [{ ...HOLD }] });
    expect(await m.recordHoldOverride(who)).toBe(true);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'customer.collection_hold_overridden', actor_id: 'admin-7', resource_id: 'cust-1' }));
    expect(autopay).toHaveBeenCalledWith('cust-1', 'collection_hold_overridden', { details: expect.objectContaining({ admin_id: 'admin-7', route: 'admin_charge_now' }) });
  });

  test('no dispute hold (none / fallback / released): nothing recorded', async () => {
    for (const holdRows of [[], [FALLBACK_WRONG_NUMBER], [{ ...HOLD, released_at: new Date() }]]) {
      const { m, audit, autopay } = load({ holdRows });
      expect(await m.recordHoldOverride(who)).toBe(false);
      expect(audit).not.toHaveBeenCalled();
      expect(autopay).not.toHaveBeenCalled();
    }
  });

  test('a failing lookup or audit write never throws (the charge is not blocked)', async () => {
    const a = load({ holdThrows: true });
    await expect(a.m.recordHoldOverride(who)).resolves.toBe(false);
    const b = load({ holdRows: [{ ...HOLD }] });
    b.audit.mockRejectedValueOnce(new Error('audit down'));
    await expect(b.m.recordHoldOverride(who)).resolves.toBe(false);
  });

  test('on a caller transaction the lookup runs in a savepoint, so a failed read cannot abort the charge transaction', async () => {
    const { m } = load({ holdRows: [{ ...HOLD }] });
    const spDb = makeFakeDb({ collections_flags: [{ ...HOLD }] });
    const trx = Object.assign(jest.fn(() => { throw new Error('the outer transaction must not be queried directly'); }), {
      isTransaction: true,
      transaction: jest.fn(async (fn) => fn(spDb)),
    });
    expect(await m.recordHoldOverride({ ...who, database: trx })).toBe(true);
    expect(trx.transaction).toHaveBeenCalledTimes(1);
    expect(trx).not.toHaveBeenCalled();
    // A savepoint whose read fails rolls back to the savepoint and only logs.
    trx.transaction.mockRejectedValueOnce(new Error('current transaction is aborted'));
    await expect(m.recordHoldOverride({ ...who, database: trx })).resolves.toBe(false);
  });

  test('the routes pass the override trail INTO the charge (recorded at the boundary) and no longer pre-check the hold', () => {
    const fs = require('fs'); const path = require('path');
    const bh = fs.readFileSync(path.join(__dirname, '../routes/admin-billing-health.js'), 'utf8');
    expect((bh.match(/operatorOverride: true, overrideTrail: chargeNowOverrideTrail\(req\)/g) || []).length).toBe(2);
    expect(bh).not.toMatch(/recordHoldOverride|recordChargeNowHoldOverride/);
    const inv = fs.readFileSync(path.join(__dirname, '../routes/admin-invoices.js'), 'utf8');
    expect(inv).not.toMatch(/recordHoldOverride/);
    expect(inv.indexOf("route: 'admin_invoice_charge_card'")).toBeGreaterThan(inv.indexOf('operatorOverride: true'));
    expect(inv).toMatch(/overrideTrail: \{/);
  });
});

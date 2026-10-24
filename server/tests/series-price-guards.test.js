/**
 * GATE_SERIES_PRICE_GUARDS (services/series-price-guards.js): the extension
 * price verdict, the last-paid lookup, the unbilled-completion predicate and
 * the office alert copy (raised through the real composeAdminAlert, which
 * throws under NODE_ENV=test on any notification-rule violation). How
 * extendSeriesOnceLocked acts on a verdict is covered in
 * recurring-series-topup.test.js. Fixtures are fake.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn(() => ({ where: () => ({ first: async () => ({ first_name: 'Pat', last_name: 'Example' }) }) }));
  return fn;
});
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));

const NotificationService = require('../services/notification-service');
const guards = require('../services/series-price-guards');

// Minimal fake knex: `answers[table]` is the row .first() resolves; nested
// where(fn) callbacks are invoked so the query shape runs.
function fakeConn(answers) {
  const seen = [];
  const conn = (table) => {
    const b = {};
    const calls = [];
    for (const m of ['where', 'orWhere', 'orWhereIn', 'whereNull', 'whereNotNull', 'select', 'orderBy']) {
      b[m] = (...args) => {
        seen.push([table, m, ...args]);
        calls.push([m, ...args]);
        if (typeof args[0] === 'function') args[0](b);
        return b;
      };
    }
    b.first = async (...cols) => {
      seen.push([table, 'first', ...cols]);
      const answer = answers[table];
      return typeof answer === 'function' ? answer(calls) : answer;
    };
    return b;
  };
  conn.seen = seen;
  return conn;
}

// scheduled_services answers two reads: the prepay-link probe (whereNotNull)
// and the newest completed visit.
const lastPaidConn = (amount, { prepayLinked = false } = {}) => fakeConn({
  scheduled_services: (calls) => (calls.some((c) => c[0] === 'whereNotNull')
    ? (prepayLinked ? { id: 'linked-child' } : undefined)
    : { id: 'visit-9' }),
  invoices: amount == null ? undefined : { total: String(amount + 7), tax_amount: '7.00' },
});

describe('lastPaidSeriesVisitAmount', () => {
  test('pre-tax total of the paid invoice on the newest completed visit', async () => {
    const conn = lastPaidConn(117);
    await expect(guards.lastPaidSeriesVisitAmount(conn, 'root-1')).resolves.toBe(117);
    expect(conn.seen).toContainEqual(['scheduled_services', 'where', 'status', 'completed']);
    // Base visits only: a booster (is_recurring false) or a free callback is
    // never the baseline (a newer $0 booster must not replace the paid price).
    expect(conn.seen).toContainEqual(['scheduled_services', 'where', 'is_recurring', true]);
    expect(conn.seen).toContainEqual(['scheduled_services', 'orWhere', 'is_callback', false]);
    expect(conn.seen).toContainEqual(['invoices', 'where', 'status', 'paid']);
  });
  test('null with no completed visit or no paid invoice', async () => {
    await expect(guards.lastPaidSeriesVisitAmount(fakeConn({}), 'root-1')).resolves.toBeNull();
    await expect(guards.lastPaidSeriesVisitAmount(lastPaidConn(null), 'root-1')).resolves.toBeNull();
  });
});

describe('extensionPriceVerdict', () => {
  const child = (price, extra = {}) => ({ estimated_price: price, service_type: 'Quarterly Pest Control', ...extra });
  const live = { status: 'completed', customer_id: 'c1' };
  const cancelled = { status: 'cancelled', customer_id: 'c1' };

  test('cancelled root priced from a prepay total: skip', async () => {
    await expect(guards.extensionPriceVerdict(lastPaidConn(117), { parent: cancelled, parentId: 'r', child: child(333.45) }))
      .resolves.toEqual({ skip: true, kind: 'cancelled_root', price: 333.45, lastPaid: 117 });
  });
  test('cancelled root with no paid visit to compare: skip (fail closed)', async () => {
    await expect(guards.extensionPriceVerdict(lastPaidConn(null), { parent: cancelled, parentId: 'r', child: child(117) }))
      .resolves.toMatchObject({ skip: true, kind: 'cancelled_root', lastPaid: null });
  });
  test('cancelled root whose price the last paid visit backs: insert as before', async () => {
    await expect(guards.extensionPriceVerdict(lastPaidConn(117), { parent: cancelled, parentId: 'r', child: child(117) }))
      .resolves.toBeNull();
  });
  test('live root more than 25% over the last paid visit: insert and alert', async () => {
    await expect(guards.extensionPriceVerdict(lastPaidConn(117), { parent: live, parentId: 'r', child: child(216.99) }))
      .resolves.toEqual({ skip: false, kind: 'over_last_paid', price: 216.99, lastPaid: 117 });
  });
  test('at or under 25% over: no alert', async () => {
    await expect(guards.extensionPriceVerdict(lastPaidConn(100), { parent: live, parentId: 'r', child: child(125) })).resolves.toBeNull();
    await expect(guards.extensionPriceVerdict(lastPaidConn(100), { parent: live, parentId: 'r', child: child(110) })).resolves.toBeNull();
    await expect(guards.extensionPriceVerdict(lastPaidConn(100), { parent: live, parentId: 'r', child: child(125.01) }))
      .resolves.toMatchObject({ kind: 'over_last_paid' });
  });
  test('live root with no paid visit: no verdict', async () => {
    await expect(guards.extensionPriceVerdict(lastPaidConn(null), { parent: live, parentId: 'r', child: child(500) })).resolves.toBeNull();
  });
  test('exempt: a series whose prepay term links only a child (mid-series prepay), even under a cancelled root', async () => {
    const conn = lastPaidConn(null, { prepayLinked: true });
    await expect(guards.extensionPriceVerdict(conn, { parent: cancelled, parentId: 'r', child: child(333.45) })).resolves.toBeNull();
    expect(conn.seen.some(([t, m]) => t === 'invoices' && m === 'first')).toBe(false);
  });
  test('exempt: callback, always-free type, unpriced child, root-linked prepay series — and no reads', async () => {
    const cases = [
      { parent: cancelled, child: child(333.45, { is_callback: true }) },
      { parent: cancelled, child: child(333.45, { service_type: 'Re-Service' }) },
      { parent: cancelled, child: child(null) },
      { parent: cancelled, child: child(0) },
      { parent: { ...cancelled, annual_prepay_term_id: 't1' }, child: child(333.45) },
    ];
    for (const c of cases) {
      const conn = lastPaidConn(117);
      await expect(guards.extensionPriceVerdict(conn, { ...c, parentId: 'r' })).resolves.toBeNull();
      expect(conn.seen).toHaveLength(0);
    }
  });
});

describe('unbilledCompletionAlertDue', () => {
  const base = {
    visitPerformed: true, isCallback: false, serviceType: 'Quarterly Pest Control', reviewedVisitPrice: false,
    authoritativeZeroPrice: false, invoiceAmount: 0, prepaidCovered: false, autopayCoversVisit: false, alreadyPaid: false, invoice: null, invoiceCreated: false,
  };
  test('a performed $0 visit with nothing billed or covering it is due, on any lane', () => {
    expect(guards.unbilledCompletionAlertDue(base)).toBe(true);
    expect(guards.unbilledCompletionAlertDue({ ...base, invoiceAmount: null })).toBe(true);
  });
  test.each([
    ['priced', { invoiceAmount: 117 }],
    ['not performed', { visitPerformed: false }],
    ['callback', { isCallback: true }],
    ['always-free type', { serviceType: 'Re-Service' }],
    ['reviewed price at completion', { reviewedVisitPrice: true }],
    ['an authoritative $0 (discounted to $0, or stamped $0 under the free-zero ruling)', { authoritativeZeroPrice: true }],
    ['prepaid / annual prepay', { prepaidCovered: true }],
    ['dues cover it', { autopayCoversVisit: true }],
    ['already paid', { alreadyPaid: true }],
    ['an existing invoice', { invoice: { id: 'i1' } }],
    ['an invoice was minted', { invoiceCreated: true }],
  ])('not due when %s', (_label, patch) => {
    expect(guards.unbilledCompletionAlertDue({ ...base, ...patch })).toBe(false);
  });
});

describe('completion wiring (source contract)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'complete-scheduled-service.js'), 'utf8');
  const at = src.indexOf('SeriesPriceGuards.unbilledCompletionAlertDue({');
  const block = src.slice(at - 400, at + 600);
  test('gated, after the mint, and fed the billing-lane authoritative-zero fact', () => {
    expect(at).toBeGreaterThan(src.indexOf('const shouldInvoice = '));
    expect(block).toContain('SeriesPriceGuards.seriesPriceGuardsLive()');
    expect(block).toContain('authoritativeZeroPrice: hasAuthoritativeZeroPrice(svc.estimated_price, svc.primary_line_price)');
    expect(block).toContain('invoiceAmount: mintInvoiceAmount');
  });
  test('a discounted-to-$0 visit reads as authoritative through the shared predicate', () => {
    const { hasAuthoritativeZeroPrice } = require('../services/billing-lane');
    expect(hasAuthoritativeZeroPrice('0', '89.00')).toBe(true);
    expect(hasAuthoritativeZeroPrice(null, '89.00')).toBe(false);
  });
});

describe('office alert copy', () => {
  beforeEach(() => NotificationService.notifyAdmin.mockClear());

  test('unbilled completion: name and date in the headline, service and price in the why, deduped per visit', async () => {
    await guards.raiseUnbilledCompletionAlert({
      id: 'visit-1', customer_id: 'c1', first_name: 'Pat', last_name: 'Example',
      scheduled_date: '2026-10-20', service_type: 'Quarterly Pest Control', estimated_price: '0.00', cust_billing_mode: 'per_visit',
    });
    const [category, title, why, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('billing');
    expect(title).toBe("Billing — bill Pat Example's Oct 20 visit");
    expect(why).toBe('Quarterly Pest Control completed with no invoice, price on file $0.00.');
    expect(title).not.toMatch(/FIX:/);
    expect(opts).toMatchObject({ dedupeKey: 'unbilled-completion:visit-1', bell: true });
    expect(opts.link).toContain('appointment=visit-1');
    expect(opts.metadata).toMatchObject({ severity: 'needs-you', who: 'person', doneWhen: 'visit_billed' });
  });

  test('unbilled completion with no price on file says so', async () => {
    await guards.raiseUnbilledCompletionAlert({
      id: 'visit-2', customer_id: 'c1', scheduled_date: '2026-10-20', service_type: 'Lawn Care', estimated_price: null,
    });
    expect(NotificationService.notifyAdmin.mock.calls[0][2]).toBe('Lawn Care completed with no invoice, no price on file.');
  });

  test('cancelled root: one alert per series, names the price and the last paid amount', async () => {
    await guards.raiseExtensionPriceAlert(
      { skip: true, kind: 'cancelled_root', price: 333.45, lastPaid: 117 },
      { parent: { customer_id: 'c1' }, parentId: 'root-1', childDate: '2026-11-03', serviceType: 'Quarterly Pest Control' },
    );
    const [, title, why, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(title).toBe("Schedule — check Pat Example's plan price");
    expect(why).toBe('Not added: the Nov 3 visit would bill $333.45 from a cancelled first visit, the last paid visit was $117.00.');
    expect(opts).toMatchObject({ dedupeKey: 'series-price-guard:cancelled-root:root-1', dedupeOpenOnly: true });
  });

  test('over the last paid visit: links the inserted visit, one open alert per series', async () => {
    await guards.raiseExtensionPriceAlert(
      { skip: false, kind: 'over_last_paid', price: 216.99, lastPaid: 117 },
      { parent: { customer_id: 'c1' }, parentId: 'root-1', childId: 'child-7', childDate: '2026-11-03', serviceType: 'Quarterly Pest Control' },
    );
    const [, title, why, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(title).toBe("Billing — check Pat Example's Nov 3 visit price");
    expect(why).toBe('The Nov 3 visit was added at $216.99; the last paid visit was $117.00.');
    expect(opts.dedupeKey).toBe('series-price-guard:over-last-paid:root-1');
    expect(opts.link).toContain('appointment=child-7');
  });
});

describe('raiseExtensionPriceAlertAfterCommit', () => {
  const verdict = { skip: false, kind: 'over_last_paid', price: 216.99, lastPaid: 117 };
  const ctx = { parent: { customer_id: 'c1' }, parentId: 'root-1', childId: 'child-7', childDate: '2026-11-03' };
  const flush = () => new Promise((r) => setImmediate(r));
  beforeEach(() => NotificationService.notifyAdmin.mockClear());

  test('rings once the transaction commits', async () => {
    guards.raiseExtensionPriceAlertAfterCommit({ executionPromise: Promise.resolve() }, verdict, ctx);
    await flush(); await flush();
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('never rings on rollback (the top-up dry run)', async () => {
    const rolledBack = Promise.reject(new Error('dry-run rollback'));
    rolledBack.catch(() => {});
    guards.raiseExtensionPriceAlertAfterCommit({ executionPromise: rolledBack }, verdict, ctx);
    await flush(); await flush();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });
});

describe('gate', () => {
  test('GATE_SERIES_PRICE_GUARDS is off unless exactly "true"', () => {
    jest.isolateModules(() => {
      const prev = process.env.GATE_SERIES_PRICE_GUARDS;
      delete process.env.GATE_SERIES_PRICE_GUARDS;
      expect(require('../services/series-price-guards').seriesPriceGuardsLive()).toBe(false);
      if (prev !== undefined) process.env.GATE_SERIES_PRICE_GUARDS = prev;
    });
    jest.isolateModules(() => {
      process.env.GATE_SERIES_PRICE_GUARDS = 'true';
      expect(require('../services/series-price-guards').seriesPriceGuardsLive()).toBe(true);
      delete process.env.GATE_SERIES_PRICE_GUARDS;
    });
  });
});

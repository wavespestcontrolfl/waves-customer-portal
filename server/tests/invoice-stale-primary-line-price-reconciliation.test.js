/**
 * Codex round 5 P1 (server/services/invoice.js buildScheduledServiceInvoiceLines):
 * a never-priced row (estimated_price null) can still carry a STALE positive
 * primary_line_price left over from a different pricing regime (e.g. a
 * per-application row that was never priced for THIS acceptance but still has
 * an old primary_line_price on file). With no authoritative net on the row,
 * the caller's fallbackAmount (e.g. the current acceptance fee) is the only
 * trustworthy net — but the builder used to emit the stale primary line
 * verbatim and only reconcile the replay DOWN to it, never up. A stale $50
 * primary beside a $97.20 fee previewed $97.20 (the fallback) while the
 * minted invoice totaled only $50 — preview and mint disagreed.
 *
 * Fixed by scoping "primaryBaseKnown" (and so the reconciliation's stored
 * net) to an ACTUAL authoritative price on the row (a real positive
 * estimated_price, or the provenance-backed genuine $0 — hasAuthoritativeZeroPrice)
 * rather than the bare presence of primary_line_price, and reconciling the
 * replay in BOTH directions against fallbackAmount when no authoritative net
 * exists.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/tax-calculator', () => ({
  calculateTax: jest.fn(async () => ({ rate: 0, amount: 0 })),
}));
jest.mock('../services/discount-engine', () => ({
  getDiscountForTier: jest.fn(),
  recordInvoiceDiscounts: jest.fn(),
  calculateDiscounts: jest.fn(async () => ({ discounts: [] })),
}));

const InvoiceService = require('../services/invoice');

// A minimal fake connection covering only the two tables
// buildScheduledServiceInvoiceLines reads (scheduled_services,
// scheduled_service_addons) — passed as the `database` option so this test
// never touches the real db module.
function fakeConn({ scheduled, addons = [] }) {
  return (table) => {
    if (table === 'scheduled_services') {
      return {
        where: () => ({ first: async () => scheduled, catch: () => ({ first: async () => scheduled }) }),
      };
    }
    if (table === 'scheduled_service_addons') {
      const q = {
        where: () => q,
        orderBy: () => q,
        catch: () => q,
        then: (resolve) => resolve(addons),
      };
      return q;
    }
    throw new Error(`unexpected table: ${table}`);
  };
}

function netTotal(lineItems) {
  return Math.round(lineItems.reduce((sum, item) => sum + (Number(item.amount) || 0), 0) * 100) / 100;
}

describe('buildScheduledServiceInvoiceLines — stale primary_line_price beside a never-priced row', () => {
  test('a stale LOWER primary_line_price ($50) reconciles UP to the current fee ($97.20), matching the checkout preview', async () => {
    const scheduled = {
      id: 'sched-1',
      service_type: 'Every 6 Weeks Lawn Care',
      estimated_price: null,
      primary_line_price: 50,
    };
    const database = fakeConn({ scheduled });

    const { lineItems } = await InvoiceService.buildLineItemsForScheduledService('sched-1', {
      fallbackAmount: 97.2,
      fallbackDescription: 'Service visit',
      database,
    });

    expect(netTotal(lineItems)).toBe(97.2);
  });

  test('a stale HIGHER primary_line_price ($150) reconciles DOWN to the current fee ($97.20) too', async () => {
    const scheduled = {
      id: 'sched-1',
      service_type: 'Every 6 Weeks Lawn Care',
      estimated_price: null,
      primary_line_price: 150,
    };
    const database = fakeConn({ scheduled });

    const { lineItems } = await InvoiceService.buildLineItemsForScheduledService('sched-1', {
      fallbackAmount: 97.2,
      fallbackDescription: 'Service visit',
      database,
    });

    expect(netTotal(lineItems)).toBe(97.2);
  });

  test('an authoritative POSITIVE estimated_price is unaffected — primary_line_price is trusted and never reconciled against an unrelated fallback', async () => {
    const scheduled = {
      id: 'sched-1',
      service_type: 'Quarterly Pest Control',
      estimated_price: 138,
      primary_line_price: 138,
    };
    const database = fakeConn({ scheduled });

    const { lineItems } = await InvoiceService.buildLineItemsForScheduledService('sched-1', {
      // A fallback that disagrees with the row's own authoritative price —
      // it must be ignored entirely, never reconciled toward.
      fallbackAmount: 999,
      fallbackDescription: 'Service visit',
      database,
    });

    expect(netTotal(lineItems)).toBe(138);
  });

  test('a provenance-backed genuine $0 (hasAuthoritativeZeroPrice) still stays $0 — never reconciled UP toward an unrelated fallback', async () => {
    const scheduled = {
      id: 'sched-1',
      service_type: 'Quarterly Pest Control',
      estimated_price: 0,
      primary_line_price: 100,
    };
    const database = fakeConn({ scheduled });

    const { lineItems } = await InvoiceService.buildLineItemsForScheduledService('sched-1', {
      fallbackAmount: 97.2,
      fallbackDescription: 'Service visit',
      database,
    });

    expect(netTotal(lineItems)).toBe(0);
  });
});

// Codex r1 P1 on #5256: under GATE_STAMPED_ZERO_FREE a BARE stamped $0 (no
// primary_line_price) is authoritative too, so a stored add-on reconciles
// down to it instead of topping up to a stale fee fallback. Gate off keeps
// today's behavior.
describe('buildScheduledServiceInvoiceLines — bare stamped $0 under GATE_STAMPED_ZERO_FREE', () => {
  afterEach(() => { delete process.env.GATE_STAMPED_ZERO_FREE; });
  const scheduled = { id: 'sched-z', service_type: 'Rodent Trapping', estimated_price: 0, primary_line_price: null };
  const addons = [{ id: 'a1', service_name: 'Bait station refill', base_price: 40, estimated_price: 40 }];

  test('gate on: a stale fee fallback never re-bills the stamped $0 — add-on and fee reconcile to $0', async () => {
    process.env.GATE_STAMPED_ZERO_FREE = 'true';
    const { lineItems } = await InvoiceService.buildLineItemsForScheduledService('sched-z', {
      fallbackAmount: 97.2, fallbackDescription: 'Service visit', database: fakeConn({ scheduled, addons }),
    });
    expect(netTotal(lineItems)).toBe(0);
  });

  test('gate off: unchanged — the fee fallback still wins over a bare $0', async () => {
    const { lineItems } = await InvoiceService.buildLineItemsForScheduledService('sched-z', {
      fallbackAmount: 97.2, fallbackDescription: 'Service visit', database: fakeConn({ scheduled, addons }),
    });
    expect(netTotal(lineItems)).toBe(97.2);
  });
});

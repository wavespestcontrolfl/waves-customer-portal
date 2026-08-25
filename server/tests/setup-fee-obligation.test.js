// Unit tests for setup-fee-obligation — the never-minted setup-fee
// detector behind the completion parking (GATE_UNMINTED_SETUP_FEE_PARK)
// and the provenance card's "Setup fee not invoiced" warning. The
// qualification rules (solo-plan mix, existing-customer/operator waivers)
// come from the REAL estimate-converter helpers on purpose — the detector
// must never disagree with the accept path's own fee authority.

let mockTables = {};

jest.mock('../models/db', () => {
  const handler = (table) => {
    const spec = mockTables[table];
    const chain = {};
    const notIn = {};
    const self = () => chain;
    ['where', 'whereNot', 'whereIn', 'whereNull', 'orderBy'].forEach((m) => {
      chain[m] = jest.fn(self);
    });
    // whereNotIn is honored on `first` so status-vocabulary filters (e.g.
    // cancelled prepay terms never suppress) are actually exercised.
    chain.whereNotIn = jest.fn((col, vals) => {
      notIn[col] = Array.isArray(vals) ? vals.map((v) => String(v)) : [];
      return chain;
    });
    const resolve = () => (typeof spec === 'function' ? spec() : spec) ?? null;
    chain.first = jest.fn(async () => {
      const v = resolve();
      const row = Array.isArray(v) ? (v[0] ?? null) : v;
      if (row && notIn.status && notIn.status.includes(String(row.status || ''))) return null;
      return row;
    });
    chain.select = jest.fn(async () => {
      const v = resolve();
      if (Array.isArray(v)) return v;
      return v ? [v] : [];
    });
    chain.pluck = jest.fn(async () => []);
    return chain;
  };
  const mock = jest.fn((table) => handler(table));
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  return mock;
});

const { findUnmintedSetupFeeObligation } = require('../services/setup-fee-obligation');
const EstimateConverter = require('../services/estimate-converter');

const EST_ID = 'e1000000-0000-0000-0000-000000000001';
const CUST_ID = 'c1000000-0000-0000-0000-000000000001';

function soloPestEstimateData(extra = {}) {
  return {
    recurring: { services: [{ name: 'Pest Control', frequency: 'quarterly', mo: 29.33 }] },
    ...extra,
  };
}

function acceptedEstimate(overrides = {}) {
  return {
    id: EST_ID,
    customer_id: CUST_ID,
    status: 'accepted',
    accepted_at: '2026-08-01T12:00:00Z',
    bill_by_invoice: false,
    estimate_slug: 'EST-2026-9901',
    estimate_data: JSON.stringify(soloPestEstimateData()),
    ...overrides,
  };
}

function baseTables(overrides = {}) {
  return {
    estimates: acceptedEstimate(),
    annual_prepay_terms: null,
    invoices: null,
    activity_log: { id: 'log-1' },
    scheduled_services: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockTables = baseTables();
});

test('fixture sanity: the real converter authority charges the fee for this mix', () => {
  const data = soloPestEstimateData();
  expect(EstimateConverter.shouldIncludeWaveGuardSetupFeeForRecurring({
    recurringServices: EstimateConverter.recurringServicesFromEstimateData(data),
    estimateData: data,
  })).toBe(true);
});

test('owed: accepted solo-pest estimate with no term, no stamped invoice, converter provenance', async () => {
  const result = await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID, customerId: CUST_ID });
  expect(result.owed).toBe(true);
  expect(result.setupFee).toBe(EstimateConverter.WAVEGUARD_SETUP_FEE);
  expect(result.estimateSlug).toBe('EST-2026-9901');
  expect(result.firstVisitAlreadyCompleted).toBe(false);
});

const FEE_LINE = JSON.stringify([{ description: 'WaveGuard Membership — one-time setup fee', amount: 99 }]);
const APP_ONLY_LINE = JSON.stringify([{ description: 'First Service Application', amount: 88 }]);

test('a LIVE stamped invoice CARRYING the setup fee means minted — not owed', async () => {
  mockTables = baseTables({ invoices: { id: 'inv-1', status: 'sent', line_items: FEE_LINE } });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(false);
});

test('a LIVE stamped application-ONLY invoice never billed the fee — obligation survives', async () => {
  // Stamped "first application only" invoices are legitimate converter
  // output; clearing on the stamp alone would lose the $99 permanently.
  mockTables = baseTables({ invoices: { id: 'inv-1', status: 'sent', line_items: APP_ONLY_LINE } });
  const result = await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID });
  expect(result.owed).toBe(true);
  expect(result.deadInvoice).toBe(null);
});

test('a REFUNDED fee-carrying invoice attached to a visit resolves — not owed', async () => {
  mockTables = baseTables({
    invoices: { id: 'inv-1', status: 'refunded', scheduled_service_id: 'ss-1', line_items: FEE_LINE },
  });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(false);
});

test('a REFUNDED fee-carrying invoice with NO attachment (setup-only acceptance mint) also resolves — never instruct a re-bill', async () => {
  // The fee was collected then deliberately refunded; a bounced refund
  // restores the row to paid — a manual re-bill instruction risks double
  // collection.
  mockTables = baseTables({
    invoices: { id: 'inv-1', status: 'refunded', scheduled_service_id: null, service_record_id: null, line_items: FEE_LINE },
  });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(false);
});

test('a REFUNDED application-ONLY invoice never billed the fee — obligation survives', async () => {
  mockTables = baseTables({
    invoices: { id: 'inv-1', status: 'refunded', scheduled_service_id: 'ss-1', line_items: APP_ONLY_LINE },
  });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(true);
});

test('a CANCELED attached fee invoice DISCOVERABLE by #3474\'s lane (same estimate + same date) — not owed', async () => {
  let ssCall = 0;
  mockTables = baseTables({
    invoices: {
      id: 'inv-1',
      status: 'canceled',
      scheduled_service_id: 'ss-1',
      line_items: JSON.stringify([{ description: 'WaveGuard Membership — one-time setup fee', amount: 99 }]),
    },
    // Call 1 = the attached visit, call 2 = the completing visit — same
    // estimate, same scheduled date ⇒ the sibling finder sees the row.
    scheduled_services: () => (++ssCall === 1
      ? { scheduled_date: '2026-08-20', source_estimate_id: EST_ID }
      : { scheduled_date: '2026-08-20' }),
  });
  expect((await findUnmintedSetupFeeObligation({
    sourceEstimateId: EST_ID,
    excludeScheduledServiceId: 'ss-now',
  })).owed).toBe(false);
});

test('a CANCELED attached fee invoice on a replaced-and-moved visit (different date) is INVISIBLE to #3474 — obligation survives', async () => {
  let ssCall = 0;
  mockTables = baseTables({
    invoices: {
      id: 'inv-1',
      status: 'canceled',
      scheduled_service_id: 'ss-1',
      line_items: JSON.stringify([{ description: 'WaveGuard Membership — one-time setup fee', amount: 99 }]),
    },
    scheduled_services: () => {
      ssCall += 1;
      if (ssCall === 1) return { scheduled_date: '2026-08-13', source_estimate_id: EST_ID };
      if (ssCall === 2) return { scheduled_date: '2026-08-20' };
      return null; // prior-completed probe
    },
  });
  const result = await findUnmintedSetupFeeObligation({
    sourceEstimateId: EST_ID,
    excludeScheduledServiceId: 'ss-now',
  });
  expect(result.owed).toBe(true);
});

test('a CANCELED attached fee invoice with NO completing-visit context (display callers) — obligation survives', async () => {
  mockTables = baseTables({
    invoices: {
      id: 'inv-1',
      status: 'canceled',
      scheduled_service_id: 'ss-1',
      line_items: JSON.stringify([{ description: 'WaveGuard Membership — one-time setup fee', amount: 99 }]),
    },
  });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(true);
});

test('a VOID attached invoice is invisible to every completion suppressor — obligation survives', async () => {
  // findFirstApplicationInvoiceForEstimateService excludes 'void' outright
  // and the terminal lookup handles only 'refunded' — attachment alone is
  // not proof another lane will park it.
  mockTables = baseTables({
    invoices: { id: 'inv-1', invoice_number: 'WPC-2026-0101', status: 'void', scheduled_service_id: 'ss-1', line_items: FEE_LINE },
  });
  const result = await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID });
  expect(result.owed).toBe(true);
  expect(result.deadInvoice).toEqual({
    id: 'inv-1',
    invoiceNumber: 'WPC-2026-0101',
    status: 'void',
  });
});

test('a CANCELED attached invoice WITHOUT a setup-fee line remints normally elsewhere — obligation survives', async () => {
  mockTables = baseTables({
    invoices: {
      id: 'inv-1',
      status: 'canceled',
      scheduled_service_id: 'ss-1',
      line_items: JSON.stringify([{ description: 'First Service Application', amount: 88 }]),
    },
  });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(true);
});

test('a dead UNATTACHED stamped invoice leaves the fee unbilled — owed, dead invoice named', async () => {
  mockTables = baseTables({
    invoices: { id: 'inv-1', invoice_number: 'WPC-2026-0100', status: 'canceled', line_items: FEE_LINE },
  });
  const result = await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID });
  expect(result.owed).toBe(true);
  expect(result.deadInvoice).toEqual({
    id: 'inv-1',
    invoiceNumber: 'WPC-2026-0100',
    status: 'canceled',
  });
});

test('a LIVE annual prepay term waives the fee — not owed', async () => {
  mockTables = baseTables({ annual_prepay_terms: { id: 'term-1', status: 'active' } });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(false);
});

test('a REFUNDED prepay term does not suppress either (the table CHECK permits it)', async () => {
  mockTables = baseTables({ annual_prepay_terms: { id: 'term-1', status: 'refunded' } });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(true);
});

test('a live prepay invoice whose line says "setup fee waived" is NOT a billed fee — obligation survives', async () => {
  // The converter's real annual-prepay line reads "12 months prepaid
  // (setup fee waived)" — after that prepay is refunded and its term
  // cancelled, the waived text must not read as fee-collected.
  mockTables = baseTables({
    annual_prepay_terms: { id: 'term-1', status: 'cancelled' },
    invoices: {
      id: 'inv-1',
      status: 'refunded',
      line_items: JSON.stringify([{ description: '12 months prepaid (setup fee waived)', amount: 340 }]),
    },
  });
  const result = await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID });
  expect(result.owed).toBe(true);
});

test('a CANCELLED prepay term does not suppress — the customer is back on per-application billing', async () => {
  // A voided/refunded prepay flips its term to 'cancelled'; for a Mark
  // Won accept there is no superseded acceptance invoice to restore, so
  // a dead term must not satisfy the obligation (Codex PR r2 P1).
  mockTables = baseTables({ annual_prepay_terms: { id: 'term-1', status: 'cancelled' } });
  const result = await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID });
  expect(result.owed).toBe(true);
});

test('accepts before the 2026-07-10 fee rule are out of scope', async () => {
  mockTables = baseTables({ estimates: acceptedEstimate({ accepted_at: '2026-06-01T12:00:00Z' }) });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(false);
});

test('a same-day accept with NO snapshot is out of scope — the calendar-day proxy must not retro-charge', async () => {
  // The rule deployed the EVENING of 2026-07-10; a midday accept with no
  // persisted display evidence may predate it — never demand an unagreed fee.
  mockTables = baseTables({ estimates: acceptedEstimate({ accepted_at: '2026-07-10T16:00:00Z' }) });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(false);
});

test('persisted snapshot SHOWING the fee puts the accept in scope regardless of the date proxy', async () => {
  mockTables = baseTables({
    estimates: acceptedEstimate({
      accepted_at: '2026-07-10T16:00:00Z',
      estimate_data: JSON.stringify(soloPestEstimateData({
        sendSnapshot: { pricingBundle: { firstVisitFees: [{ service: 'waveguard_setup', amount: 99 }] } },
      })),
    }),
  });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(true);
});

test('a fee-less snapshot is NOT no-fee evidence — post-cutoff accepts stay in scope (stale bundles are repaired at view time)', async () => {
  mockTables = baseTables({
    estimates: acceptedEstimate({
      accepted_at: '2026-08-01T12:00:00Z',
      estimate_data: JSON.stringify(soloPestEstimateData({
        sendSnapshot: { pricingBundle: { firstVisitFees: [], oneTimeBreakdown: { items: [] } } },
      })),
    }),
  });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(true);
});

test('a fee-less snapshot on a PRE-cutoff accept stays out of scope', async () => {
  mockTables = baseTables({
    estimates: acceptedEstimate({
      accepted_at: '2026-07-10T16:00:00Z',
      estimate_data: JSON.stringify(soloPestEstimateData({
        sendSnapshot: { pricingBundle: { firstVisitFees: [] } },
      })),
    }),
  });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(false);
});

test('no estimate_converted activity row (accept never converted) — not owed', async () => {
  mockTables = baseTables({ activity_log: null });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(false);
});

// The detector reads `invoices` twice: first the stamped-acceptance scan
// (a .select), then — only when a prior completed plan row exists — the
// billed-evidence probe (a .first). This helper feeds them in order.
function invoicesInOrder(stampedSpec, billedSpec) {
  let call = 0;
  return () => (++call === 1 ? stampedSpec : billedSpec);
}

test('a prior completed AND BILLED plan visit (is_recurring) flags firstVisitAlreadyCompleted (historic leak, no parking)', async () => {
  mockTables = baseTables({
    scheduled_services: { id: 'ss-prior', is_recurring: true, recurring_parent_id: null },
    invoices: invoicesInOrder(null, {
    id: 'inv-billed',
    status: 'sent',
    line_items: JSON.stringify([{ client_id: 'scheduled_ss-prior_primary', description: 'Quarterly Pest Control', amount: 88 }]),
  }),
  });
  const result = await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID });
  expect(result.owed).toBe(true);
  expect(result.firstVisitAlreadyCompleted).toBe(true);
});

test('a prior completed AND BILLED recurring CHILD (recurring_parent_id) also counts as a plan visit', async () => {
  mockTables = baseTables({
    scheduled_services: { id: 'ss-child', is_recurring: false, recurring_parent_id: 'ss-parent' },
    invoices: invoicesInOrder(null, {
    id: 'inv-billed',
    status: 'paid',
    line_items: JSON.stringify([{ client_id: 'scheduled_ss-child_primary', description: 'Quarterly Pest Control', amount: 88 }]),
  }),
  });
  const result = await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID });
  expect(result.owed).toBe(true);
  expect(result.firstVisitAlreadyCompleted).toBe(true);
});

test('a prior completed plan visit with NO billing evidence (declined/coverage-suppressed) keeps the obligation live', async () => {
  // Completion status alone proves nothing: inspection_only /
  // customer_declined outcomes and coverage-suppressed billings mark the
  // row completed while minting nothing — the next performed application
  // must still park.
  mockTables = baseTables({
    scheduled_services: { id: 'ss-prior', is_recurring: true, recurring_parent_id: null },
    invoices: null,
  });
  const result = await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID });
  expect(result.owed).toBe(true);
  expect(result.firstVisitAlreadyCompleted).toBe(false);
});

test('a prior completed one-time add-on (non-recurring, even same category) does not release the hold', async () => {
  // Durable recurrence identity, not service-type text: a same-category
  // pest corrective (ad-hoc, is_recurring=false) must not count as the
  // first plan application.
  mockTables = baseTables({ scheduled_services: { id: 'ss-addon', is_recurring: false, recurring_parent_id: null } });
  const result = await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID });
  expect(result.owed).toBe(true);
  expect(result.firstVisitAlreadyCompleted).toBe(false);
});

test('the completing visit itself, when a non-plan row (add-on mint), never owns the obligation', async () => {
  expect((await findUnmintedSetupFeeObligation({
    sourceEstimateId: EST_ID,
    visitPlanRow: { is_recurring: false, recurring_parent_id: null },
  })).owed).toBe(false);
});

test('the completing visit on a plan row keeps the obligation', async () => {
  const result = await findUnmintedSetupFeeObligation({
    sourceEstimateId: EST_ID,
    visitPlanRow: { is_recurring: true, recurring_parent_id: null },
  });
  expect(result.owed).toBe(true);
});

test('non-accepted estimate — not owed', async () => {
  mockTables = baseTables({ estimates: acceptedEstimate({ status: 'sent' }) });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(false);
});

test('invoice-mode estimates bill through their own proposal invoice — not owed', async () => {
  mockTables = baseTables({ estimates: acceptedEstimate({ bill_by_invoice: true }) });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(false);
});

test('existing-customer waiver flows through from the converter authority — not owed', async () => {
  mockTables = baseTables({
    estimates: acceptedEstimate({
      estimate_data: JSON.stringify(soloPestEstimateData({ membershipSnapshot: { isExistingCustomer: true } })),
    }),
  });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(false);
});

test('customer mismatch (re-linked visit) — not owed', async () => {
  expect((await findUnmintedSetupFeeObligation({
    sourceEstimateId: EST_ID,
    customerId: 'c2000000-0000-0000-0000-000000000002',
  })).owed).toBe(false);
});

test('missing sourceEstimateId — not owed, no reads', async () => {
  expect((await findUnmintedSetupFeeObligation({})).owed).toBe(false);
});

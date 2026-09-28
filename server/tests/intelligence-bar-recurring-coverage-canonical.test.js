/**
 * hasLiveRecurringCoverage (tools.js) — the "or recurring customers" half of
 * the WaveGuard member discount, and the mosquito ladder's own floor — reuses
 * the canonical owned-service lifecycle (waveguard-existing-services.js
 * loadOwnedRecurringServiceKeys) instead of a hand-rolled
 * is_recurring/status/date query (Codex round 5, P1).
 *
 * The rest of the IB test suite mocks loadOwnedRecurringServiceKeys directly
 * (it only needs to control WHETHER a customer has coverage, not re-derive
 * the loader's own lifecycle rules). This file does the opposite: it does
 * NOT mock waveguard-existing-services, and instead wires the real
 * scheduled_services rows the canonical loader reads, to prove the loader's
 * own exclusions actually reach the IB member discount — a callback row and
 * a one-time-booking-source row must NOT count as live recurring coverage,
 * even though both are is_recurring/non-terminal/future rows the OLD
 * hand-rolled query would have wrongly counted.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { ibBookingProposal } = require('../services/intelligence-bar/tools');

function chain(overrides = {}) {
  const builder = {};
  Object.assign(builder, {
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    select: jest.fn().mockResolvedValue([]),
    first: jest.fn().mockResolvedValue(undefined),
    columnInfo: jest.fn().mockResolvedValue({}),
    ...overrides,
  });
  return builder;
}

function wireDb(queues) {
  db.mockImplementation((table) => {
    const q = queues[table];
    if (!q || q.length === 0) throw new Error(`Unexpected db('${table}') call`);
    return q.shift();
  });
}

const bookingCustomer = {
  id: 'cust-1', first_name: 'Ada', last_name: 'L', billing_mode: 'per_application', per_application_fee: 95,
  waveguard_tier: null, monthly_rate: 0, active: true,
};

const ONE_TIME_PEST = {
  id: 'svc-otp', name: 'One-Time Pest Control Service', short_name: null,
  service_key: 'one_time_pest_control', base_price: '250.00', category: 'pest', billing_type: 'one_time',
};

const GENERIC = {
  id: 'disc-member', discount_key: 'waveguard_member', name: 'WaveGuard Member Discount', discount_type: 'percentage',
  amount: '15.00', requires_waveguard_tier: 'Bronze', service_key_filter: null, is_active: true, show_in_invoices: true, max_discount_dollars: null,
};

// Upcoming — the canonical loader applies its lifecycle evidence
// unconditionally, so a stale past row would already fail on date alone;
// these rows must be excluded for their OWN reason (callback / one-time
// source), not merely because they're old.
const FUTURE = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);

// Answers EITHER calling convention against the same fixture rows:
//   - the OLD hand-rolled query: .where(...).whereNotIn(...).where(...).first('id')
//     — a crude is_recurring/status/date filter with no callback/one-time-
//     source awareness, so it resolves truthy whenever ANY row is present,
//     callback/one-time-source included (that crudeness IS the round-5 bug).
//   - the NEW canonical loader: .columnInfo() (used by loadActiveRecurringServiceRows
//     to decide which optional columns to select) and a separate .select(...)
//     bulk read, which loadOwnedRecurringServiceKeys then filters row-by-row.
// This single fixture makes the SAME test genuinely discriminate old vs new
// code — proof the fix is what changes the verdict, not the test's mocking.
function universalRecurringChain(rows) {
  return chain({
    columnInfo: jest.fn().mockResolvedValue({ is_recurring: {} }),
    select: jest.fn().mockResolvedValue(rows),
    first: jest.fn().mockResolvedValue(rows.length ? { id: rows[0].id } : undefined),
  });
}

function wireCanonicalLoader(recurringRows) {
  db.raw = jest.fn(() => Promise.resolve({ rows: [] }));
  wireDb({
    customers: [
      chain({ first: jest.fn().mockResolvedValue(bookingCustomer) }), // ibBookingProposal's own read
      chain({ first: jest.fn().mockResolvedValue(bookingCustomer) }), // loadActiveRecurringServiceRows' own customer read
    ],
    services: [chain({ select: jest.fn().mockResolvedValue([ONE_TIME_PEST]) })],
    // A second entry (loadInvoiceDiscount's own re-read of the picked row)
    // is consumed only when a discount actually applies (the contrast case).
    discounts: [
      chain({ select: jest.fn().mockResolvedValue([GENERIC]) }),
      chain({ first: jest.fn().mockResolvedValue(GENERIC) }),
    ],
    // The OLD code makes exactly one 'scheduled_services' call (the direct
    // query); the NEW canonical loader makes two (columnInfo, then select).
    // Two identical universal entries serve either code path faithfully.
    scheduled_services: [universalRecurringChain(recurringRows), universalRecurringChain(recurringRows)],
    // loadCatalogFieldsByRowId's own aliased query (new code only) — no
    // catalog rows needed, an empty join degrades every row to
    // service_type-only classification.
    'scheduled_services as s': [chain({ select: jest.fn().mockResolvedValue([]) })],
  });
}

describe('live recurring coverage through the canonical ownership loader (Codex round 5, P1)', () => {
  test('a callback-only recurring row does not count as live coverage — no automatic member discount', async () => {
    const callbackRow = {
      id: 'ss-callback', service_type: 'Quarterly Pest Control', scheduled_date: FUTURE, status: 'pending',
      is_recurring: true, is_callback: true, source: null,
    };
    wireCanonicalLoader([callbackRow]);
    const result = await ibBookingProposal('cust-1', ONE_TIME_PEST.name, undefined);
    expect(result).toMatchObject({ price: 250, discountId: null });
  });

  test('a one-time-booking-source recurring row does not count as live coverage — no automatic member discount', async () => {
    const oneTimeSourceRow = {
      id: 'ss-onetime-source', service_type: 'Quarterly Pest Control', scheduled_date: FUTURE, status: 'pending',
      is_recurring: true, is_callback: false, source: 'quote-wizard-onetime',
    };
    wireCanonicalLoader([oneTimeSourceRow]);
    const result = await ibBookingProposal('cust-1', ONE_TIME_PEST.name, undefined);
    expect(result).toMatchObject({ price: 250, discountId: null });
  });

  test('a genuine, live recurring row DOES count as coverage (contrast case: proves the wiring can see a positive)', async () => {
    const liveRow = {
      id: 'ss-live', service_type: 'Quarterly Pest Control', scheduled_date: FUTURE, status: 'pending',
      is_recurring: true, is_callback: false, source: null,
    };
    wireCanonicalLoader([liveRow]);
    const result = await ibBookingProposal('cust-1', ONE_TIME_PEST.name, undefined);
    expect(result).toMatchObject({ price: 212.5, discountId: 'disc-member' });
  });

  test('a live palm-injection plan (a recurring plan with no ownership family) counts as coverage (Codex r7)', async () => {
    const palmRow = {
      id: 'ss-palm', service_type: 'Palm Injection', scheduled_date: FUTURE, status: 'pending',
      is_recurring: true, is_callback: false, source: null,
    };
    wireCanonicalLoader([palmRow]);
    const result = await ibBookingProposal('cust-1', ONE_TIME_PEST.name, undefined);
    expect(result).toMatchObject({ price: 212.5, discountId: 'disc-member' });
  });
});

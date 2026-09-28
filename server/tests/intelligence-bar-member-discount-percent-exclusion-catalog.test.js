/**
 * memberOneOffDiscount (tools.js) awaits the percent-discount exclusion
 * catalog prime before consulting it (Codex r3 on #5093, P1).
 *
 * The catalog (admin-schedule.js's percentExclusionCatalog) maps a catalog
 * row's service_key to an excluded verdict via its ENGINE identity
 * (services.engine_keys) — this is the ONLY way a variant key with no
 * literal WAVEGUARD.excludedFromPercentDiscount entry and no
 * PERCENT_EXCLUSION_KEY_ALIASES entry (e.g. a whole-structure bed bug heat
 * variant) resolves as excluded. Every in-router calculator gets this
 * catalog primed for free — the admin-schedule router awaits
 * primePercentDiscountExclusions() before any handler runs. The IB booking
 * path has no such middleware: memberOneOffDiscount used to consult
 * lineExcludedFromPercentDiscount without ever awaiting that prime, so on
 * the first booking after boot (or after a prime failure) a member booking
 * an engine_keys-only-excluded variant service wrongly got the automatic
 * 15% member discount.
 *
 * This test isolates admin-schedule.js's module-level catalog state in its
 * OWN test file (rather than intelligence-bar-appointment-tools.test.js,
 * whose shared beforeEach primes db.raw with a shape that trivially
 * "succeeds" the prime with zero rows on the very first booking test and
 * then TTL-caches that empty catalog for the rest of the file — which would
 * make this fix untestable there).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/tech-status', () => ({
  clearTechCurrentJob: jest.fn().mockResolvedValue(null),
}));
jest.mock('../sockets', () => ({
  getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })) })),
}));
jest.mock('../services/appointment-reminders', () => ({
  registerAppointment: jest.fn().mockResolvedValue({ id: 'rem-1' }),
  sendConfirmation: jest.fn().mockResolvedValue(true),
}));
// Live recurring coverage goes through the canonical ownership loader
// (waveguard-existing-services.js loadOwnedRecurringServiceKeys — Codex
// round 5, P1); this file is about the percent-exclusion catalog prime, not
// recurring coverage, so the loader is mocked to a plain "no coverage" —
// consistent with the original bare scheduled_services stub it replaces.
jest.mock('../services/waveguard-existing-services', () => ({
  ...jest.requireActual('../services/waveguard-existing-services'),
  loadLiveRecurringObligationRows: jest.fn().mockResolvedValue([]),
}));

const db = require('../models/db');
const { ibBookingProposal } = require('../services/intelligence-bar/tools');

function chain(overrides = {}) {
  const builder = {};
  Object.assign(builder, {
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    forUpdate: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockResolvedValue([]),
    first: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });
  return builder;
}

function wireDb(queues) {
  db.mockImplementation((table) => {
    if (table === 'services' && !queues.services) {
      return { where() { return this; }, whereIn() { return this; }, select: () => Promise.resolve([]) };
    }
    if (table === 'discounts' && !queues.discounts) {
      return { where() { return this; }, whereIn() { return this; }, orderBy() { return this; }, select: () => Promise.resolve([]) };
    }
    const q = queues[table];
    if (!q || q.length === 0) throw new Error(`Unexpected db('${table}') call`);
    return q.shift();
  });
}

const catalog = (rows) => chain({ select: jest.fn().mockResolvedValue(rows) });
const listing = (rows) => chain({ orderBy: jest.fn().mockReturnThis(), select: jest.fn().mockResolvedValue(rows) });

const MEMBER = {
  id: 'cust-1', first_name: 'Ada', last_name: 'L', billing_mode: 'monthly_membership', monthly_rate: 89,
  waveguard_tier: 'Gold', active: true,
};
const GENERIC = {
  id: 'disc-member', discount_key: 'waveguard_member', name: 'WaveGuard Member Discount', discount_type: 'percentage',
  amount: '15.00', requires_waveguard_tier: 'Bronze', service_key_filter: null, is_active: true, show_in_invoices: true, max_discount_dollars: null,
};
// A catalog row excluded from percent discounts ONLY through its ENGINE
// identity (services.engine_keys → 'bed_bug', a WAVEGUARD-excluded family).
// Not a literal WAVEGUARD.excludedFromPercentDiscount key and not a
// PERCENT_EXCLUSION_KEY_ALIASES entry — the only way this key resolves as
// excluded is through the primed catalog map.
const BED_BUG_VARIANT = {
  id: 'svc-bbv', name: 'Bed Bug Heat Treatment (Whole-Structure)', short_name: null,
  service_key: 'bed_bug_heat_whole_structure', base_price: '200.00', category: 'pest',
};

describe('memberOneOffDiscount awaits the percent-exclusion catalog prime (Codex r3 on #5093, P1)', () => {
  test('a variant key excluded only via services.engine_keys never gets the automatic 15% once the catalog is primed', async () => {
    // The exact priming query primePercentDiscountExclusions issues
    // (admin-schedule.js): select service_key, engine_keys from services
    // where engine_keys is not null. Resolved off a macrotask (setTimeout),
    // not a bare microtask: ibBookingPricing's own require of
    // buildAppointmentPricing (admin-schedule.js) fires this prime
    // fire-and-forget BEFORE calling memberOneOffDiscount, and the handful
    // of incidental awaits already on that call path (the discounts query,
    // etc.) drain enough queued microtasks that an immediately-resolved
    // mock would settle before the check runs EVEN ON THE OLD, unawaited
    // code — masking the bug. A real Postgres round-trip is a macrotask-
    // scale delay, so this is the faithful way to reproduce "first booking
    // after boot (or after a slow prime)" deterministically: old code's
    // synchronous check runs before this timer fires (catalog still empty,
    // wrongly not-excluded); new code's explicit await waits for it either way.
    db.raw = jest.fn(() => new Promise((resolve) => {
      setTimeout(() => resolve({
        rows: [{ service_key: 'bed_bug_heat_whole_structure', engine_keys: ['bed_bug'] }],
      }), 5);
    }));
    wireDb({
      customers: [chain({ first: jest.fn().mockResolvedValue(MEMBER) })],
      services: [catalog([BED_BUG_VARIANT])],
      // A second entry (loadInvoiceDiscount's own re-read of the picked
      // row) is provisioned but consumed ONLY on the buggy path, where the
      // exclusion is missed and the discount proceeds to pricing — proof
      // this test genuinely exercises the race rather than failing on an
      // unrelated missing-mock error.
      discounts: [listing([GENERIC]), chain({ first: jest.fn().mockResolvedValue(GENERIC) })],
      // The exclusion skip means no eligible row on the membership pass, so
      // the recurring-coverage fallback runs once — the canonical loader is
      // mocked to no coverage above (irrelevant either way: the exclusion
      // applies before eligibility is checked on both passes, same as the
      // literal-key bed-bug test).
    });
    const result = await ibBookingProposal('cust-1', BED_BUG_VARIANT.name, undefined);
    expect(result).toMatchObject({ price: 200, discountId: null });
    expect(db.raw).toHaveBeenCalled();
    // Generous timeout: the first require of tools.js is slow on a loaded
    // machine, and the 5 ms prime delay is not what this bounds.
  }, 30000);
});

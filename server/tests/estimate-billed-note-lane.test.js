/**
 * billedPerApplication vs the live billing lane (codex P1s on #2978).
 *
 * The "Billed $X/mo" note suppressor must track how the accept path will
 * actually bill: everyone converts to per-application billing EXCEPT a
 * CURRENT monthly member (estimate-converter preservesExistingMembership).
 * buildPricingBundle resolves the lane LIVE from the linked customer row via
 * the shared predicate (billing-cadence customerPreservesMonthlyMembership)
 * and enforces the flag symmetrically — strip for preserved members, add
 * missing flags on tier-plan surfaces for everyone else (pre-flag send
 * snapshots included).
 */

const mockDbState = { customer: null, calls: [] };

jest.mock('../models/db', () => {
  const handler = (table) => {
    const builder = {
      where: () => builder,
      whereIn: () => builder,
      whereNull: () => builder,
      whereNotNull: () => builder,
      andWhere: () => builder,
      orderBy: () => builder,
      limit: () => builder,
      select: async () => [],
      first: async () => {
        mockDbState.calls.push(table);
        if (table === 'customers') {
          if (mockDbState.customer instanceof Error) throw mockDbState.customer;
          return mockDbState.customer;
        }
        return null;
      },
    };
    return builder;
  };
  handler.fn = { now: () => new Date() };
  handler.raw = async () => ({ rows: [] });
  return handler;
});

const {
  buildPricingBundle,
  addMissingBilledPerApplicationFlags,
} = require('../routes/estimate-public');

function lawnEstimateRow({ customerId = null } = {}) {
  return {
    id: `estimate-lane-${customerId || 'lead'}`,
    status: 'sent',
    customer_id: customerId,
    monthly_total: 55.5,
    annual_total: 666,
    onetime_total: 0,
    estimate_data: {
      result: {
        hasRecurring: true,
        recurring: {
          monthlyTotal: 55.5,
          services: [{ name: 'Lawn Care', service: 'lawn_care', mo: 55.5, ann: 666, v: 6, visitsPerYear: 6, perTreatment: 111 }],
        },
        results: {
          lawn: [
            { name: 'Standard', v: 6, mo: 55.5, ann: 666, pa: 111 },
            { name: 'Enhanced', v: 9, mo: 66.75, ann: 801, pa: 89, recommended: true },
          ],
        },
        oneTime: { items: [] },
      },
    },
  };
}

function collectFlags(bundle) {
  const flags = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if ('billedPerApplication' in node) flags.push(node.billedPerApplication);
    Object.values(node).forEach(walk);
  };
  walk(bundle);
  return flags;
}

beforeEach(() => {
  mockDbState.customer = null;
  mockDbState.calls = [];
});

describe('buildPricingBundle lane enforcement', () => {
  test('lead estimate (no customer link): flags present, no customer lookup', async () => {
    const bundle = await buildPricingBundle(lawnEstimateRow());
    expect(collectFlags(bundle).length).toBeGreaterThan(0);
    expect(mockDbState.calls).not.toContain('customers');
  });

  test('linked CURRENT monthly member (legacy NULL lane): every flag stripped, note preserved', async () => {
    mockDbState.customer = { id: 'cust-1', pipeline_stage: 'active_customer', monthly_rate: 95, billing_mode: null };
    const bundle = await buildPricingBundle(lawnEstimateRow({ customerId: 'cust-1' }));
    expect(collectFlags(bundle)).toEqual([]);
  });

  test('linked monthly_membership member: stripped too', async () => {
    mockDbState.customer = { id: 'cust-1', pipeline_stage: 'won', monthly_rate: 60, billing_mode: 'monthly_membership' };
    const bundle = await buildPricingBundle(lawnEstimateRow({ customerId: 'cust-1' }));
    expect(collectFlags(bundle)).toEqual([]);
  });

  test('linked per_application-lane customer: flags present (their accept bills per application)', async () => {
    mockDbState.customer = { id: 'cust-1', pipeline_stage: 'active_customer', monthly_rate: 95, billing_mode: 'per_application' };
    const bundle = await buildPricingBundle(lawnEstimateRow({ customerId: 'cust-1' }));
    expect(collectFlags(bundle).length).toBeGreaterThan(0);
  });

  test('linked but customer row missing: flags present (converts like a new signup)', async () => {
    mockDbState.customer = null;
    const bundle = await buildPricingBundle(lawnEstimateRow({ customerId: 'cust-gone' }));
    expect(collectFlags(bundle).length).toBeGreaterThan(0);
  });

  test('lane lookup failure on a linked estimate fails to the monthly disclosure (strip)', async () => {
    mockDbState.customer = new Error('connection refused');
    const bundle = await buildPricingBundle(lawnEstimateRow({ customerId: 'cust-1' }));
    expect(collectFlags(bundle)).toEqual([]);
  });
});

describe('addMissingBilledPerApplicationFlags — pre-flag send-snapshot back-fill', () => {
  test('adds the flag on tier-plan section entries and serviceCategory ladders, never on termite/pest rows', () => {
    const preFlagBundle = {
      frequencies: [
        // Single-service lawn ladder entry from an old snapshot (no flag).
        { key: 'standard', serviceCategory: 'lawn_care', monthly: 55.5, perTreatment: 111, visitsPerYear: 6 },
        // Pest cadence entry — no serviceCategory, must stay untouched.
        { key: 'quarterly', monthly: 95, perTreatment: 285, visitsPerYear: 4 },
      ],
      services: [
        {
          key: 'tree_shrub',
          frequencies: [
            { key: 'enhanced', monthly: 68.6, perTreatment: 91.47, visitsPerYear: 9 },
            { key: 'quote', quoteRequired: true, monthly: null, perTreatment: null, visitsPerYear: 9 },
          ],
        },
        {
          // Legacy flat-monthly termite monitoring: derived per-visit price +
          // visit count but genuinely billed monthly — the #2965 carve-out.
          key: 'termite_bait',
          frequencies: [
            { key: 'recurring', monthly: 29.75, perTreatment: 89.25, visitsPerYear: 4 },
          ],
        },
      ],
    };
    const out = addMissingBilledPerApplicationFlags(preFlagBundle);
    expect(out.frequencies[0].billedPerApplication).toBe(true);
    expect(out.frequencies[1].billedPerApplication).toBeUndefined();
    const ts = out.services.find((s) => s.key === 'tree_shrub');
    expect(ts.frequencies[0].billedPerApplication).toBe(true);
    expect(ts.frequencies[1].billedPerApplication).toBeUndefined(); // quote-required
    const termite = out.services.find((s) => s.key === 'termite_bait');
    expect(termite.frequencies[0].billedPerApplication).toBeUndefined();
    // Copying transform — the input (cache-resident) bundle is untouched.
    expect(preFlagBundle.frequencies[0].billedPerApplication).toBeUndefined();
  });
});

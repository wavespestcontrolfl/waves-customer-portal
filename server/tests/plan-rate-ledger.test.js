jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  gates: {},
}));

const featureGates = require('../config/feature-gates');
const {
  UNATTRIBUTED,
  planRateLedgerEnabled,
  estimateFamilySlices,
  applyAcceptToLedger,
  resetLedgerToScalar,
  syncScalarWriteToLedger,
} = require('../services/plan-rate-ledger');
const { classifyAddOnAcceptContext } = require('../services/estimate-converter');

// Stateful fake knex: customer_plan_rates rows live in `store`; supports the
// exact chains the ledger uses (where().select(), insert().onConflict().merge(),
// where().del(), schema.hasTable).
function makeLedgerDb(initialRows = [], { hasTable = true } = {}) {
  const store = initialRows.map((r) => ({ ...r }));
  const db = (table) => {
    if (table !== 'customer_plan_rates') throw new Error(`unexpected table ${table}`);
    const ctx = { filter: null };
    const q = {
      where(filter) { ctx.filter = filter; return q; },
      select() {
        return Promise.resolve(store
          .filter((r) => r.customer_id === ctx.filter.customer_id)
          .map((r) => ({ family_key: r.family_key, monthly_rate: r.monthly_rate, source: r.source })));
      },
      insert(row) {
        return {
          onConflict() {
            return {
              merge(mergeFields) {
                const existing = store.find((r) => r.customer_id === row.customer_id
                  && r.family_key === row.family_key);
                if (existing) Object.assign(existing, mergeFields);
                else store.push({ ...row });
                return Promise.resolve();
              },
            };
          },
          then(resolve, reject) {
            store.push({ ...row });
            return Promise.resolve().then(resolve, reject);
          },
        };
      },
      del() {
        const before = store.length;
        for (let i = store.length - 1; i >= 0; i -= 1) {
          const matches = store[i].customer_id === ctx.filter.customer_id
            && (ctx.filter.family_key === undefined || store[i].family_key === ctx.filter.family_key);
          if (matches) store.splice(i, 1);
        }
        return Promise.resolve(before - store.length);
      },
    };
    return q;
  };
  db.schema = { hasTable: async () => hasTable };
  db.store = store;
  return db;
}

describe('planRateLedgerEnabled', () => {
  test('reads the planRateLedger gate', () => {
    featureGates.isEnabled.mockReturnValueOnce(true);
    expect(planRateLedgerEnabled()).toBe(true);
    expect(featureGates.isEnabled).toHaveBeenCalledWith('planRateLedger');
    expect(planRateLedgerEnabled()).toBe(false);
  });
});

describe('estimateFamilySlices', () => {
  test('splits a multi-service estimate per family, cent-exact against the billed monthly', () => {
    const slices = estimateFamilySlices({
      estimateData: {
        result: {
          recurring: {
            services: [
              { name: 'Quarterly Pest Control Service', service: 'pest_control', mo: 45 },
              { name: 'Bi-Monthly Tree & Shrub Care Service', service: 'tree_shrub', mo: 32.87 },
            ],
          },
        },
      },
      monthlyRate: 77.87,
    });
    expect(slices.pest_control).toBeCloseTo(45, 2);
    expect(slices.tree_shrub).toBeCloseTo(32.87, 2);
    const total = Object.values(slices).reduce((s, v) => s + v, 0);
    expect(Math.round(total * 100) / 100).toBe(77.87);
  });

  test('normalizes proportionally when the billed monthly differs from line sums (summary discount)', () => {
    const slices = estimateFamilySlices({
      estimateData: {
        result: {
          recurring: {
            services: [
              { name: 'Quarterly Pest Control Service', service: 'pest_control', mo: 50 },
              { name: 'Monthly Mosquito Control', service: 'mosquito', mo: 50 },
            ],
          },
        },
      },
      monthlyRate: 90, // 10% off at summary level
    });
    expect(slices.pest_control).toBe(45);
    expect(slices.mosquito).toBe(45);
  });

  test('prefers per-line post-discount stamps over pre-discount monthly', () => {
    const slices = estimateFamilySlices({
      estimateData: {
        result: {
          recurring: {
            services: [
              { name: 'Bi-Monthly Tree & Shrub Care Service', service: 'tree_shrub', mo: 32.87, manualFinalAnnual: 354.96 },
            ],
          },
        },
      },
      monthlyRate: 29.58,
    });
    expect(slices.tree_shrub).toBe(29.58);
  });

  test('supplemental companion lines (scalar rodent bait) get their own slice', () => {
    const slices = estimateFamilySlices({
      estimateData: {
        result: {
          recurring: {
            services: [{ name: 'Quarterly Pest Control Service', service: 'pest_control', mo: 40 }],
            rodentBaitMo: 24,
          },
        },
      },
      monthlyRate: 64,
    });
    expect(slices.pest_control).toBe(40);
    expect(slices.rodent_bait).toBe(24);
  });

  test('a supplement duplicated as a recurring line counts once (codex r1)', () => {
    // Legacy payloads carry rodent bait BOTH ways — double-counting would
    // distort every proportionally-normalized sibling slice.
    const slices = estimateFamilySlices({
      estimateData: {
        result: {
          recurring: {
            services: [
              { name: 'Quarterly Pest Control Service', service: 'pest_control', mo: 40 },
              { name: 'Rodent Bait Stations', service: 'rodent_bait', mo: 24 },
            ],
            rodentBaitMo: 24,
          },
        },
      },
      monthlyRate: 64,
    });
    expect(slices.pest_control).toBe(40);
    expect(slices.rodent_bait).toBe(24);
  });

  test('unknown specialty names slice under their slug identity; nameless lines pool unattributed', () => {
    // The #3228 classifier gives unknown specialty names slug-only
    // identities — a distinct component key its own re-quote can replace.
    const slugged = estimateFamilySlices({
      estimateData: {
        result: { recurring: { services: [{ name: 'Mystery Service', mo: 20 }] } },
      },
      monthlyRate: 20,
    });
    expect(slugged.mystery_service).toBe(20);
    // A line with no classifiable identity at all pools under unattributed.
    const pooled = estimateFamilySlices({
      estimateData: {
        result: { recurring: { services: [{ mo: 20 }] } },
      },
      monthlyRate: 20,
    });
    expect(pooled[UNATTRIBUTED]).toBe(20);
    expect(estimateFamilySlices({ estimateData: {}, monthlyRate: 33 }))
      .toEqual({ [UNATTRIBUTED]: 33 });
    expect(estimateFamilySlices({ estimateData: {}, monthlyRate: 0 })).toEqual({});
  });
});

describe('applyAcceptToLedger', () => {
  const CUST = 'cust-1';

  test('case 1 — seeded ledger: re-quote replaces only its own family (THE multi-plan fix)', async () => {
    const db = makeLedgerDb([
      { customer_id: CUST, family_key: 'pest_control', monthly_rate: 40 },
      { customer_id: CUST, family_key: 'lawn_care', monthly_rate: 50 },
    ]);
    const out = await applyAcceptToLedger(db, {
      customerId: CUST,
      estimateId: 'est-1',
      slices: { lawn_care: 60 },
      previousScalar: 90,
      addOnBase: 0,
    });
    expect(out.scalar).toBe(100); // 40 pest + 60 new lawn
    expect(out.components).toEqual({ pest_control: 40, lawn_care: 60 });
    expect(out.reviewNeeded).toBe(false);
  });

  test('case 2 — empty ledger + disjoint add-on parks the legacy scalar as unattributed', async () => {
    const db = makeLedgerDb([]);
    const out = await applyAcceptToLedger(db, {
      customerId: CUST,
      estimateId: 'est-1',
      slices: { tree_shrub: 32.87 },
      previousScalar: 31.81,
      addOnBase: 31.81,
    });
    expect(out.scalar).toBe(64.68);
    expect(out.components).toEqual({ [UNATTRIBUTED]: 31.81, tree_shrub: 32.87 });
  });

  test('case 3 — empty ledger + same-family replace seeds slices and flags review for multi-plan customers', async () => {
    const db = makeLedgerDb([]);
    const out = await applyAcceptToLedger(db, {
      customerId: CUST,
      estimateId: 'est-1',
      slices: { lawn_care: 60 },
      previousScalar: 90,
      addOnBase: 0,
      hadOtherLiveFamilies: true,
    });
    expect(out.scalar).toBe(60); // legacy replace outcome, now attributed
    expect(out.reviewNeeded).toBe(true);
    const single = await applyAcceptToLedger(makeLedgerDb([]), {
      customerId: CUST,
      estimateId: 'est-1',
      slices: { lawn_care: 60 },
      previousScalar: 50,
      addOnBase: 0,
      hadOtherLiveFamilies: false,
    });
    expect(single.reviewNeeded).toBe(false);
  });

  test('case 4 — new signup seeds components equal to the slices', async () => {
    const db = makeLedgerDb([]);
    const out = await applyAcceptToLedger(db, {
      customerId: CUST,
      estimateId: 'est-1',
      slices: { pest_control: 45, mosquito: 30 },
      previousScalar: 0,
      addOnBase: 0,
    });
    expect(out.scalar).toBe(75);
  });

  test('an unattributed blob is QUARANTINED, not seeded (codex r1)', async () => {
    // Backfill-parked multi-plan customer ($90 unattributed) re-quotes a
    // family that may be INSIDE the blob → the blob is deleted (legacy
    // replace semantics), the accept's slices stand, and the owner reviews.
    const requote = makeLedgerDb([
      { customer_id: CUST, family_key: UNATTRIBUTED, monthly_rate: 90 },
    ]);
    const out = await applyAcceptToLedger(requote, {
      customerId: CUST,
      estimateId: 'est-1',
      slices: { lawn_care: 60 },
      previousScalar: 90,
      addOnBase: 0,
      hadOtherLiveFamilies: true,
    });
    expect(out.scalar).toBe(60); // NOT 150 — the blob may contain lawn
    expect(out.reviewNeeded).toBe(true);
    expect(requote.store.some((r) => r.family_key === UNATTRIBUTED)).toBe(false);
    // A PROVEN-disjoint add-on keeps the blob parked and sums.
    const addon = makeLedgerDb([
      { customer_id: CUST, family_key: UNATTRIBUTED, monthly_rate: 90 },
    ]);
    const addOut = await applyAcceptToLedger(addon, {
      customerId: CUST,
      estimateId: 'est-1',
      slices: { mosquito: 30 },
      previousScalar: 90,
      addOnBase: 90,
    });
    expect(addOut.scalar).toBe(120);
    expect(addOut.reviewNeeded).toBe(false);
    // A re-quote of an ALREADY-attributed family leaves the blob alone.
    const mixed = makeLedgerDb([
      { customer_id: CUST, family_key: UNATTRIBUTED, monthly_rate: 90 },
      { customer_id: CUST, family_key: 'tree_shrub', monthly_rate: 32.87 },
    ]);
    const mixedOut = await applyAcceptToLedger(mixed, {
      customerId: CUST,
      estimateId: 'est-1',
      slices: { tree_shrub: 35 },
      previousScalar: 122.87,
      addOnBase: 0,
    });
    expect(mixedOut.scalar).toBe(125); // 90 blob + 35 new tree
    expect(mixedOut.reviewNeeded).toBe(false);
  });

  test('a new termite accept supersedes obsolete termite rider components (codex r4)', async () => {
    // Rental → purchased-stations: the rental component must not keep
    // billing beside the new bait plan.
    const db = makeLedgerDb([
      { customer_id: CUST, family_key: 'pest_control', monthly_rate: 40 },
      { customer_id: CUST, family_key: 'termite_station_rental', monthly_rate: 15 },
      { customer_id: CUST, family_key: 'termite_bait', monthly_rate: 30 },
    ]);
    const out = await applyAcceptToLedger(db, {
      customerId: CUST,
      estimateId: 'est-1',
      slices: { termite_bait: 35 },
      previousScalar: 85,
      addOnBase: 0,
    });
    expect(out.scalar).toBe(75); // 40 pest + 35 new bait; rental GONE
    expect(db.store.some((r) => r.family_key === 'termite_station_rental')).toBe(false);
    expect(out.reviewNeeded).toBe(true); // superseded rider gets one eyeball
    // Non-termite accepts leave termite components alone.
    const untouched = makeLedgerDb([
      { customer_id: CUST, family_key: 'termite_bait', monthly_rate: 30 },
    ]);
    const pestOut = await applyAcceptToLedger(untouched, {
      customerId: CUST,
      estimateId: 'est-1',
      slices: { pest_control: 45 },
      previousScalar: 30,
      addOnBase: 0,
    });
    expect(pestOut.scalar).toBe(75);
    expect(untouched.store.some((r) => r.family_key === 'termite_bait')).toBe(true);
    expect(pestOut.reviewNeeded).toBe(false);
  });

  test('missing table or empty slices yields null scalar (caller keeps legacy semantics)', async () => {
    await expect(applyAcceptToLedger(makeLedgerDb([], { hasTable: false }), {
      customerId: CUST, slices: { pest_control: 40 }, previousScalar: 0,
    })).resolves.toEqual({ scalar: null, components: null, reviewNeeded: false });
    await expect(applyAcceptToLedger(makeLedgerDb([]), {
      customerId: CUST, slices: {}, previousScalar: 40,
    })).resolves.toEqual({ scalar: null, components: null, reviewNeeded: false });
  });
});

describe('cross-property same-family components (codex r10)', () => {
  test('a proven cross-property add-on MERGES the family component instead of replacing it', async () => {
    const db = makeLedgerDb([
      { customer_id: 'cust-1', family_key: 'pest_control', monthly_rate: 40 },
    ]);
    const out = await applyAcceptToLedger(db, {
      customerId: 'cust-1',
      estimateId: 'est-b',
      slices: { pest_control: 50 },
      previousScalar: 40,
      addOnBase: 40, // classifier property-scoped the replace evidence away
    });
    expect(out.scalar).toBe(90); // $40 property A + $50 property B — never 50
    const row = db.store.find((r) => r.family_key === 'pest_control');
    expect(row.monthly_rate).toBe(90);
    expect(row.source).toBe('cross_property_merge');
  });

  test('a later REPLACE of a property-merged component proceeds but flags review (un-splittable)', async () => {
    const db = makeLedgerDb([
      { customer_id: 'cust-1', family_key: 'pest_control', monthly_rate: 90, source: 'cross_property_merge' },
      { customer_id: 'cust-1', family_key: 'lawn_care', monthly_rate: 30 },
    ]);
    const out = await applyAcceptToLedger(db, {
      customerId: 'cust-1',
      estimateId: 'est-a2',
      slices: { pest_control: 45 },
      previousScalar: 120,
      addOnBase: 0, // same property re-quote — replace path
    });
    expect(out.scalar).toBe(75); // 45 + lawn 30 (legacy replace of the merged key)
    expect(out.reviewNeeded).toBe(true); // owner verifies the other property's slice
  });
});

describe('codex r11 — cross-property termite variants', () => {
  test('a proven add-on never supersedes termite variants at other properties', async () => {
    const db = makeLedgerDb([
      { customer_id: 'cust-1', family_key: 'termite_bond_5yr', monthly_rate: 12 },
    ]);
    const out = await applyAcceptToLedger(db, {
      customerId: 'cust-1',
      estimateId: 'est-b',
      slices: { termite_bond_1yr: 15 },
      previousScalar: 12,
      addOnBase: 12, // grouped accept — property B's new bond
    });
    expect(out.scalar).toBe(27); // both bonds bill
    expect(db.store.some((r) => r.family_key === 'termite_bond_5yr')).toBe(true);
    expect(db.store.some((r) => r.family_key === 'termite_bond_1yr')).toBe(true);
  });
});

describe('local codex P0 regressions (r8 push audit)', () => {
  test('a fully comped re-quote emits ZERO slices so seeded components are deleted', async () => {
    const slices = estimateFamilySlices({
      estimateData: {
        result: {
          recurring: {
            services: [
              { name: 'Quarterly Pest Control Service', service: 'pest_control', mo: 40, manualFinalAnnual: 0 },
              { name: 'Bi-Monthly Lawn Care Service', service: 'lawn_care', mo: 50, manualFinalAnnual: 0 },
            ],
          },
        },
      },
      monthlyRate: 0,
    });
    expect(slices).toEqual({ pest_control: 0, lawn_care: 0 });
    const db = makeLedgerDb([
      { customer_id: 'cust-1', family_key: 'pest_control', monthly_rate: 40 },
      { customer_id: 'cust-1', family_key: 'lawn_care', monthly_rate: 50 },
    ]);
    const out = await applyAcceptToLedger(db, {
      customerId: 'cust-1', estimateId: 'est-1', slices, previousScalar: 90, addOnBase: 0,
    });
    expect(out.scalar).toBe(0);
    expect(db.store).toHaveLength(0);
  });

  test('an unclassifiable slice without proven add-on evidence wipes ambiguous components (fail closed)', async () => {
    const db = makeLedgerDb([
      { customer_id: 'cust-1', family_key: 'pest_control', monthly_rate: 40 },
      { customer_id: 'cust-1', family_key: 'lawn_care', monthly_rate: 50 },
    ]);
    const out = await applyAcceptToLedger(db, {
      customerId: 'cust-1',
      estimateId: 'est-1',
      slices: { [UNATTRIBUTED]: 60 },
      previousScalar: 90,
      addOnBase: 0,
    });
    expect(out.scalar).toBe(60); // legacy replace — never 150
    expect(out.reviewNeeded).toBe(true);
    expect(db.store.map((r) => r.family_key)).toEqual([UNATTRIBUTED]);
  });
});

describe('seedLedgerComponents (codex r7/r8)', () => {
  test('replaces existing rows with the provided per-family components', async () => {
    const { seedLedgerComponents } = require('../services/plan-rate-ledger');
    const db = makeLedgerDb([
      { customer_id: 'cust-1', family_key: UNATTRIBUTED, monthly_rate: 90 },
    ]);
    db.transaction = async (fn) => fn(db);
    await seedLedgerComponents(db, 'cust-1', { pest_control: 45, mosquito: 30 }, { source: 'plan_sync' });
    expect(db.store.map((r) => [r.family_key, r.monthly_rate]).sort())
      .toEqual([['mosquito', 30], ['pest_control', 45]]);
  });

  test('authoritative failures throw; advisory failures warn', async () => {
    const { seedLedgerComponents } = require('../services/plan-rate-ledger');
    const db = makeLedgerDb([]);
    db.transaction = async () => { throw new Error('seed boom'); };
    await expect(seedLedgerComponents(db, 'cust-1', { pest_control: 45 })).resolves.toBeUndefined();
    featureGates.isEnabled.mockReturnValue(true);
    await expect(seedLedgerComponents(db, 'cust-1', { pest_control: 45 })).rejects.toThrow('seed boom');
    featureGates.isEnabled.mockReturnValue(false);
  });
});

describe('codex r7 hardening', () => {
  test('a parked unattributed blob MERGES with an accepted unattributed slice on a proven add-on', async () => {
    const db = makeLedgerDb([
      { customer_id: 'cust-1', family_key: UNATTRIBUTED, monthly_rate: 90 },
    ]);
    const out = await applyAcceptToLedger(db, {
      customerId: 'cust-1',
      estimateId: 'est-1',
      slices: { mosquito: 30, [UNATTRIBUTED]: 10 },
      previousScalar: 90,
      addOnBase: 90,
    });
    expect(out.scalar).toBe(130); // 90 parked + 30 mosquito + 10 slice — never 40
    expect(db.store.find((r) => r.family_key === UNATTRIBUTED).monthly_rate).toBe(100);
  });

  test('a zero-comped recurring line still blocks its supplemental-scalar twin', () => {
    const slices = estimateFamilySlices({
      estimateData: {
        result: {
          recurring: {
            services: [
              { name: 'Quarterly Pest Control Service', service: 'pest_control', mo: 40 },
              { name: 'Rodent Bait Stations', service: 'rodent_bait', mo: 24, manualFinalAnnual: 0 },
            ],
            rodentBaitMo: 24,
          },
        },
      },
      monthlyRate: 40,
    });
    // The comp wins: rodent slices to ZERO (deletes its component), the
    // supplement must not resurrect it positive.
    expect(slices.rodent_bait).toBe(0);
    expect(slices.pest_control).toBe(40);
  });

  test('termite supersession is scoped to the variant group', async () => {
    // Bait-only re-quote keeps an independent bond.
    const bondKept = makeLedgerDb([
      { customer_id: 'cust-1', family_key: 'termite_bait', monthly_rate: 30 },
      { customer_id: 'cust-1', family_key: 'termite_bond_5yr', monthly_rate: 12 },
    ]);
    const baitOut = await applyAcceptToLedger(bondKept, {
      customerId: 'cust-1',
      estimateId: 'est-1',
      slices: { termite_bait: 35 },
      previousScalar: 42,
      addOnBase: 0,
    });
    expect(baitOut.scalar).toBe(47); // 35 new bait + 12 bond kept
    expect(bondKept.store.some((r) => r.family_key === 'termite_bond_5yr')).toBe(true);
    // A new bond TERM supersedes the old one.
    const bondSwap = makeLedgerDb([
      { customer_id: 'cust-1', family_key: 'termite_bond_5yr', monthly_rate: 12 },
    ]);
    const swapOut = await applyAcceptToLedger(bondSwap, {
      customerId: 'cust-1',
      estimateId: 'est-1',
      slices: { termite_bond_1yr: 15 },
      previousScalar: 12,
      addOnBase: 0,
    });
    expect(swapOut.scalar).toBe(15);
    expect(bondSwap.store.some((r) => r.family_key === 'termite_bond_5yr')).toBe(false);
    expect(swapOut.reviewNeeded).toBe(true);
  });
});

describe('codex r6 hardening', () => {
  test('oversized classifier slugs map to a stable bounded key that fits varchar(64)', () => {
    const { boundedFamilyKey } = require('../services/plan-rate-ledger');
    // No family tokens anywhere — the classifier emits its full slug
    // identity (92 chars), which must bound to the 64-char column.
    const longName = 'Zanzibar Quilted Meridian Halcyon Zephyr Cadenza Marigold Sonata Vermillion Arpeggio Program';
    const slug = longName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const bounded = boundedFamilyKey(slug);
    expect(bounded.length).toBeLessThanOrEqual(64);
    expect(boundedFamilyKey(slug)).toBe(bounded); // deterministic
    expect(bounded.startsWith(slug.slice(0, 40))).toBe(true); // prefix preserved
    expect(boundedFamilyKey('pest_control')).toBe('pest_control'); // short keys untouched
    // Slicing an estimate with such a line stores the bounded key.
    const slices = estimateFamilySlices({
      estimateData: { result: { recurring: { services: [{ name: longName, mo: 20 }] } } },
      monthlyRate: 20,
    });
    expect(slices[bounded]).toBe(20);
  });
});

describe('codex r5 hardening', () => {
  test('annual-only engine rows (annual/ann, no monthly) still slice per family', () => {
    const slices = estimateFamilySlices({
      estimateData: {
        result: {
          recurring: {
            services: [
              { name: 'Quarterly Pest Control Service', service: 'pest_control', annual: 480 },
              { name: 'Bi-Monthly Lawn Care Service', service: 'lawn_care', ann: 600 },
            ],
          },
        },
      },
      monthlyRate: 90,
    });
    expect(slices.pest_control).toBe(40);
    expect(slices.lawn_care).toBe(50);
  });

  test('a churned customer\'s components are wiped on re-signup (non-authoritative)', async () => {
    const db = makeLedgerDb([
      { customer_id: 'cust-1', family_key: 'pest_control', monthly_rate: 40 },
      { customer_id: 'cust-1', family_key: 'lawn_care', monthly_rate: 50 },
    ]);
    const out = await applyAcceptToLedger(db, {
      customerId: 'cust-1',
      estimateId: 'est-1',
      slices: { pest_control: 45 },
      previousScalar: 90,
      addOnBase: 0,
      customerIsLive: false,
    });
    // Legacy replace semantics: cancelled siblings never sum back in.
    expect(out.scalar).toBe(45);
    expect(db.store.map((r) => r.family_key)).toEqual(['pest_control']);
  });

  test('a table-probe FAILURE throws under the authority gate instead of reading as absent', async () => {
    const db = makeLedgerDb([]);
    db.schema = { hasTable: async () => { throw new Error('metadata query timeout'); } };
    // Advisory: absent-equivalent (null scalar, caller keeps legacy).
    await expect(applyAcceptToLedger(db, {
      customerId: 'cust-1', slices: { pest_control: 40 }, previousScalar: 0,
    })).resolves.toEqual({ scalar: null, components: null, reviewNeeded: false });
    // Authoritative: propagate so the converter's fail-closed machinery runs.
    featureGates.isEnabled.mockReturnValue(true);
    await expect(applyAcceptToLedger(db, {
      customerId: 'cust-1', slices: { pest_control: 40 }, previousScalar: 0,
    })).rejects.toThrow('metadata query timeout');
    featureGates.isEnabled.mockReturnValue(false);
  });
});

describe('zero-priced accepted families (codex r2)', () => {
  test('an explicitly comped line yields a ZERO slice', () => {
    const slices = estimateFamilySlices({
      estimateData: {
        result: {
          recurring: {
            services: [
              { name: 'Quarterly Pest Control Service', service: 'pest_control', mo: 40, manualFinalAnnual: 0 },
              { name: 'Bi-Monthly Lawn Care Service', service: 'lawn_care', mo: 50 },
            ],
          },
        },
      },
      monthlyRate: 50,
    });
    expect(slices.pest_control).toBe(0);
    expect(slices.lawn_care).toBe(50);
  });

  test('a zero slice DELETES the family component so the comped plan stops billing', async () => {
    const db = makeLedgerDb([
      { customer_id: 'cust-1', family_key: 'pest_control', monthly_rate: 40 },
      { customer_id: 'cust-1', family_key: 'lawn_care', monthly_rate: 50 },
    ]);
    const out = await applyAcceptToLedger(db, {
      customerId: 'cust-1',
      estimateId: 'est-1',
      slices: { pest_control: 0, lawn_care: 50 },
      previousScalar: 90,
      addOnBase: 0,
    });
    expect(out.scalar).toBe(50);
    expect(db.store.some((r) => r.family_key === 'pest_control')).toBe(false);
  });

  test('a line with NO price provenance is untouched, not zeroed', () => {
    const slices = estimateFamilySlices({
      estimateData: {
        result: {
          recurring: {
            services: [
              { name: 'Quarterly Pest Control Service', service: 'pest_control' },
              { name: 'Bi-Monthly Lawn Care Service', service: 'lawn_care', mo: 50 },
            ],
          },
        },
      },
      monthlyRate: 50,
    });
    expect(slices.pest_control).toBeUndefined();
    expect(slices.lawn_care).toBe(50);
  });
});

describe('syncScalarWriteToLedger (codex r2)', () => {
  test('advisory (gate off): failures are swallowed', async () => {
    const db = makeLedgerDb([], { hasTable: true });
    db.transaction = async () => { throw new Error('savepoint boom'); };
    await expect(syncScalarWriteToLedger(db, 'cust-1', 50, { source: 'admin_edit' }))
      .resolves.toBeUndefined();
  });

  test('authoritative (gate on): failures throw and fail the caller write', async () => {
    featureGates.isEnabled.mockReturnValue(true);
    const db = makeLedgerDb([], { hasTable: true });
    db.transaction = async () => { throw new Error('savepoint boom'); };
    await expect(syncScalarWriteToLedger(db, 'cust-1', 50, { source: 'admin_edit' }))
      .rejects.toThrow('savepoint boom');
    featureGates.isEnabled.mockReturnValue(false);
  });

  test('resets through a transaction to a single unattributed component', async () => {
    const db = makeLedgerDb([
      { customer_id: 'cust-1', family_key: 'pest_control', monthly_rate: 40 },
    ]);
    db.transaction = async (fn) => fn(db);
    await syncScalarWriteToLedger(db, 'cust-1', 75, { source: 'ib_update' });
    expect(db.store).toHaveLength(1);
    expect(db.store[0]).toMatchObject({ family_key: UNATTRIBUTED, monthly_rate: 75 });
  });
});

describe('resetLedgerToScalar', () => {
  test('replaces all components with a single unattributed one; zero clears entirely', async () => {
    const db = makeLedgerDb([
      { customer_id: 'cust-1', family_key: 'pest_control', monthly_rate: 40 },
      { customer_id: 'cust-1', family_key: 'lawn_care', monthly_rate: 50 },
    ]);
    await resetLedgerToScalar(db, 'cust-1', 75, { source: 'admin_edit' });
    expect(db.store).toHaveLength(1);
    expect(db.store[0]).toMatchObject({ family_key: UNATTRIBUTED, monthly_rate: 75 });
    await resetLedgerToScalar(db, 'cust-1', 0, { source: 'admin_edit' });
    expect(db.store).toHaveLength(0);
  });
});

// ── classifyAddOnAcceptContext (converter) ──────────────────────────────────

function makeConvFakeConn(rows) {
  const conn = () => {
    const q = {};
    const chain = () => (...args) => {
      if (typeof args[0] === 'function') args[0](nested());
      return q;
    };
    ['whereIn', 'whereNotIn', 'where', 'whereNull', 'leftJoin', 'select'].forEach((m) => { q[m] = chain(); });
    q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
    return q;
  };
  conn.transaction = async (fn) => fn(conn);
  return conn;
}
function nested() {
  const b = {};
  ['where', 'orWhere', 'whereNull', 'whereNot', 'orWhereNot'].forEach((m) => {
    b[m] = (...args) => { if (typeof args[0] === 'function') args[0](nested()); return b; };
  });
  return b;
}

describe('classifyAddOnAcceptContext', () => {
  const TS_ESTIMATE = { id: 'est-1', customer_id: 'cust-1' };
  const TS_DATA = {
    result: {
      recurring: {
        services: [{
          name: 'Bi-Monthly Tree & Shrub Care Service',
          service: 'tree_shrub',
          selected: true,
          isSelected: true,
          mo: 32.87,
        }],
      },
    },
  };
  const LIVE = { id: 'cust-1', pipeline_stage: 'active_customer', monthly_rate: '31.81' };
  const PEST_ROW = { service_type: 'Quarterly Pest Control Service', is_callback: false, catalog_service_key: null, catalog_service_name: null };
  const TS_ROW = { service_type: 'Bi-Monthly Tree & Shrub Care Service', is_callback: false, catalog_service_key: null, catalog_service_name: null };

  test('disjoint add-on: base carries the rate AND flags other live families', async () => {
    await expect(classifyAddOnAcceptContext({
      database: makeConvFakeConn([PEST_ROW]),
      estimateId: 'est-1',
      estimate: TS_ESTIMATE,
      estimateData: TS_DATA,
      customer: LIVE,
    })).resolves.toEqual({ addOnBase: 31.81, hadOtherLiveFamilies: true });
  });

  test('same-family single-plan re-quote: replace, no review signal', async () => {
    await expect(classifyAddOnAcceptContext({
      database: makeConvFakeConn([TS_ROW]),
      estimateId: 'est-1',
      estimate: TS_ESTIMATE,
      estimateData: TS_DATA,
      customer: LIVE,
    })).resolves.toEqual({ addOnBase: 0, hadOtherLiveFamilies: false });
  });

  test('same-family re-quote with ANOTHER live plan: replace + review signal (the hand-fix case)', async () => {
    await expect(classifyAddOnAcceptContext({
      database: makeConvFakeConn([TS_ROW, PEST_ROW]),
      estimateId: 'est-1',
      estimate: TS_ESTIMATE,
      estimateData: TS_DATA,
      customer: LIVE,
    })).resolves.toEqual({ addOnBase: 0, hadOtherLiveFamilies: true });
  });

  test('unclassifiable rows: replace (fail closed) but still counted as other-family evidence', async () => {
    await expect(classifyAddOnAcceptContext({
      database: makeConvFakeConn([{ service_type: 'Service', is_callback: false, catalog_service_key: null, catalog_service_name: null }]),
      estimateId: 'est-1',
      estimate: TS_ESTIMATE,
      estimateData: TS_DATA,
      customer: LIVE,
    })).resolves.toEqual({ addOnBase: 0, hadOtherLiveFamilies: true });
  });

  test('non-live stage / no rate yields the empty context', async () => {
    await expect(classifyAddOnAcceptContext({
      database: makeConvFakeConn([PEST_ROW]),
      estimateId: 'est-1',
      estimate: TS_ESTIMATE,
      estimateData: TS_DATA,
      customer: { ...LIVE, pipeline_stage: 'churned' },
    })).resolves.toEqual({ addOnBase: 0, hadOtherLiveFamilies: false });
  });
});

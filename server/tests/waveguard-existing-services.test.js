// Plan-gating for WaveGuard "existing customer" detection.
//
// The estimate flow must treat a customer as an EXISTING member only when they
// actually hold a WaveGuard plan (customers.waveguard_tier) — NOT merely because
// they have a recurring scheduled visit. Regression: Cristina Lipham was a "No
// Plan" lead whose first quarterly service had been scheduled; that single
// pending row wrongly waived her $99 setup and hid the annual-prepay option.

const {
  isMembershipCustomerRow,
  isActivePlanCustomer,
  loadExistingRecurringQualifyingRows,
  loadExistingQualifyingServiceKeys,
  toQualifyingKeys,
} = require('../services/waveguard-existing-services');

function fakeDb({ customer, scheduledRows = [], scheduledColumns = null } = {}) {
  const db = (table) => ({
    where: () => db(table),
    whereNotIn: () => db(table),
    columnInfo: async () => scheduledColumns || ({ is_recurring: {}, estimated_price: {} }),
    first: async () => (table === 'customers' ? customer : null),
    select: async () => (table === 'scheduled_services' ? scheduledRows : []),
  });
  return db;
}

describe('isMembershipCustomerRow', () => {
  test('real plan tiers are members', () => {
    for (const tier of ['Bronze', 'Silver', 'Gold', 'Platinum', 'silver']) {
      expect(isMembershipCustomerRow({ waveguard_tier: tier })).toBe(true);
    }
  });

  test('non-plan tiers are NOT members', () => {
    for (const tier of [null, undefined, '', 'none', 'None', 'One-Time', 'onetime', 'N/A']) {
      expect(isMembershipCustomerRow({ waveguard_tier: tier })).toBe(false);
    }
  });

  test('falls back to a positive recurring monthly_rate when no tier is set', () => {
    expect(isMembershipCustomerRow({ waveguard_tier: null, monthly_rate: 95 })).toBe(true);
    expect(isMembershipCustomerRow({ waveguard_tier: null, monthly_rate: 0 })).toBe(false);
  });
});

describe('isActivePlanCustomer', () => {
  test('true for a member, false for a No-Plan customer', async () => {
    expect(await isActivePlanCustomer(fakeDb({ customer: { id: 'c1', waveguard_tier: 'Gold' } }), 'c1')).toBe(true);
    expect(await isActivePlanCustomer(fakeDb({ customer: { id: 'c1', waveguard_tier: null } }), 'c1')).toBe(false);
  });

  test('false for an inactive member, missing customer, or missing args', async () => {
    expect(await isActivePlanCustomer(fakeDb({ customer: { id: 'c1', waveguard_tier: 'Gold', active: false } }), 'c1')).toBe(false);
    expect(await isActivePlanCustomer(fakeDb({ customer: null }), 'c1')).toBe(false);
    expect(await isActivePlanCustomer(null, 'c1')).toBe(false);
    expect(await isActivePlanCustomer(fakeDb({ customer: {} }), null)).toBe(false);
  });
});

describe('strict mode — a failed membership read is UNKNOWN, never "no plan" (codex #3591 r68 P1)', () => {
  const failingDb = (table) => ({
    where: () => failingDb(table),
    whereNotIn: () => failingDb(table),
    columnInfo: async () => ({ is_recurring: {} }),
    first: async () => { if (table === 'customers') throw new Error('db down'); return null; },
    select: async () => [],
  });
  test('default swallows to false / []; strict propagates through every loader', async () => {
    expect(await isActivePlanCustomer(failingDb, 'c1')).toBe(false);
    expect(await loadExistingRecurringQualifyingRows(failingDb, 'c1')).toEqual([]);
    expect(await loadExistingQualifyingServiceKeys(failingDb, 'c1')).toEqual([]);
    await expect(isActivePlanCustomer(failingDb, 'c1', { strict: true })).rejects.toThrow('db down');
    await expect(loadExistingRecurringQualifyingRows(failingDb, 'c1', { strict: true })).rejects.toThrow('db down');
    await expect(loadExistingQualifyingServiceKeys(failingDb, 'c1', { strict: true })).rejects.toThrow('db down');
    // The shared evidence resolver is strict THROUGHOUT (codex #3591 r75
    // P1): a failed read must reach the callers' 503/refusal paths, never
    // degrade to an empty tier list or a label-only waiver.
    const { resolveCustomerQualifyingEvidence } = require('../services/waveguard-existing-services');
    await expect(resolveCustomerQualifyingEvidence(failingDb, { customerId: 'c1' })).rejects.toThrow('db down');
  });
});

describe('loadExistingRecurringQualifyingRows plan-gate', () => {
  const pestRow = { id: 's1', service_type: 'Quarterly Pest Control', scheduled_date: '2099-09-12' };

  test('returns rows for an actual plan member', async () => {
    const db = fakeDb({ customer: { id: 'c1', waveguard_tier: 'Bronze' }, scheduledRows: [pestRow] });
    const rows = await loadExistingRecurringQualifyingRows(db, 'c1');
    expect(rows).toHaveLength(1);
  });

  test('returns [] for a No-Plan customer even with a pending recurring visit', async () => {
    const db = fakeDb({ customer: { id: 'c1', waveguard_tier: null }, scheduledRows: [pestRow] });
    const rows = await loadExistingRecurringQualifyingRows(db, 'c1');
    expect(rows).toEqual([]);
  });

  test('planGate: false qualifies on the LIVE rows without the membership stamp — the rodent setup-waiver read (codex #3591 r73 P1)', async () => {
    // The owner's waiver rule is "any OTHER qualifying recurring service",
    // not plan membership: a qualifying row whose tier stamp has not landed
    // yet (booking enrolls after resolving the setup, or auto-enroll is
    // gated off) must still waive the $99.
    const db = fakeDb({ customer: { id: 'c1', waveguard_tier: null }, scheduledRows: [pestRow] });
    expect(await loadExistingRecurringQualifyingRows(db, 'c1', { planGate: false })).toHaveLength(1);
    expect(await loadExistingQualifyingServiceKeys(db, 'c1', { planGate: false })).toEqual(['pest_control']);
    // An inactive customer stays excluded either way (the row loader's own guard).
    const inactive = fakeDb({ customer: { id: 'c1', waveguard_tier: null, active: false }, scheduledRows: [pestRow] });
    expect(await loadExistingRecurringQualifyingRows(inactive, 'c1', { planGate: false })).toEqual([]);
    // TIER derivation always keeps the gate.
    expect(await loadExistingQualifyingServiceKeys(db, 'c1')).toEqual([]);
  });

  test('planGate: false runs the CANONICAL qualification even while auto-tiering is gated off (codex #3591 r79 P1)', async () => {
    // GATE_AUTO_WAVEGUARD_TIER is off in tests — the legacy label-only
    // branch must serve TIER reads only. The waiver read still applies the
    // full predicates: a commercial row and a past-dated pending row never
    // waive the $99.
    const commercialRow = { id: 's2', service_type: 'Commercial Lawn Care', scheduled_date: '2099-09-12', status: 'pending' };
    const staleRow = { id: 's3', service_type: 'Quarterly Pest Control', scheduled_date: '2001-01-01', status: 'pending' };
    const db = fakeDb({ customer: { id: 'c1', waveguard_tier: null }, scheduledRows: [commercialRow, staleRow] });
    expect(await loadExistingQualifyingServiceKeys(db, 'c1', { planGate: false })).toEqual([]);
  });

  test('authoritative qualifying keys expand combined plan components', async () => {
    const db = fakeDb({
      customer: { id: 'c1', waveguard_tier: 'Silver' },
      scheduledRows: [
        { id: 'combo', service_type: 'Quarterly Pest + Lawn' },
        // Rodent bait qualifies since 2026-08-29 (owner directive).
        { id: 'rodent', service_type: 'Rodent Bait Stations' },
      ],
    });

    expect(toQualifyingKeys('Quarterly Pest + Lawn')).toEqual(['pest_control', 'lawn_care']);
    expect(await loadExistingQualifyingServiceKeys(db, 'c1')).toEqual(['pest_control', 'lawn_care', 'rodent_bait']);
  });

  test('rodent bait qualification follows the LIVE tier_qualifier flag (codex #3591 r13 P1)', async () => {
    const constants = require('../services/pricing-engine/constants');
    const idx = constants.WAVEGUARD.qualifyingServices.indexOf('rodent_bait');
    expect(idx).toBeGreaterThanOrEqual(0);
    constants.WAVEGUARD.qualifyingServices.splice(idx, 1);
    try {
      expect(toQualifyingKeys('Rodent Bait Stations')).toEqual([]);
      const db = fakeDb({
        customer: { id: 'c1', waveguard_tier: 'Silver' },
        scheduledRows: [{ id: 'pest', service_type: 'Quarterly Pest Control' }, { id: 'rodent', service_type: 'Rodent Bait Stations' }],
      });
      expect(await loadExistingQualifyingServiceKeys(db, 'c1')).toEqual(['pest_control']);
      // A recognized bait CATALOG identity with a stale generic label never
      // falls back to the label while rodent is disabled (codex #3591 r25 P1).
      const { qualifyingKeysForRow } = require('../services/waveguard-existing-services');
      expect(qualifyingKeysForRow({ service_type: 'Pest Control', service_key: 'rodent_bait_quarterly', service_name: 'Quarterly Rodent Bait Station Service' })).toEqual([]);
    } finally {
      constants.WAVEGUARD.qualifyingServices.push('rodent_bait');
    }
    expect(toQualifyingKeys('Rodent Bait Stations')).toEqual(['rodent_bait']);
    const { qualifyingKeysForRow } = require('../services/waveguard-existing-services');
    expect(qualifyingKeysForRow({ service_type: 'Pest Control', service_key: 'rodent_bait_quarterly', service_name: 'Quarterly Rodent Bait Station Service' })).toEqual(['rodent_bait']);
  });

  test('rodent-trapping- and palm-only rows never feed qualifying keys (bait stations DO, since 2026-08-29)', async () => {
    const db = fakeDb({
      customer: { id: 'c1', waveguard_tier: 'Gold' },
      scheduledRows: [
        // Rodent-led but NOT a bait/station/monitoring program — the
        // one-time rodent service label stays a non-qualifier.
        { id: 'rodent', service_type: 'Rodent Pest Control' },
        { id: 'palm', service_type: 'Palm Tree Injections' },
      ],
    });
    expect(await loadExistingQualifyingServiceKeys(db, 'c1')).toEqual([]);
  });

  test('active-service addresses retain apartment and unit identifiers', async () => {
    const db = fakeDb({
      customer: { id: 'c1', waveguard_tier: 'Bronze' },
      scheduledColumns: {
        is_recurring: {},
        estimated_price: {},
        service_address_line1: {},
        service_address_line2: {},
        service_address_city: {},
        service_address_zip: {},
      },
      scheduledRows: [{
        id: 'unit-a',
        service_type: 'Quarterly Pest Control',
        service_address_line1: '123 Palm Ave',
        service_address_line2: 'Apt A',
        service_address_city: 'Bradenton',
        service_address_zip: '34209',
      }],
    });

    const rows = await loadExistingRecurringQualifyingRows(db, 'c1');
    expect(rows[0].effective_service_address).toBe('123 Palm Ave Apt A, Bradenton, 34209');
  });
});

describe('toQualifyingKeys rodent/palm exclusions', () => {
  test('rodent-led names never qualify as pest coverage', () => {
    // rodent_general_one_time's canonical label leads with rodent — it is a
    // rodent service, not pest coverage. Bait-station rows qualify as
    // rodent_bait since 2026-08-29 (owner directive); non-bait rodent
    // labels still qualify as nothing.
    expect(toQualifyingKeys('Rodent Pest Control')).toEqual([]);
    expect(toQualifyingKeys('Quarterly Rodent Bait Station Service')).toEqual(['rodent_bait']);
    expect(toQualifyingKeys('rodent_bait_quarterly')).toEqual(['rodent_bait']);
    expect(toQualifyingKeys('Rodent Trapping')).toEqual([]);
  });

  test('pest-primary combined names keep pest coverage', () => {
    // "pest" BEFORE the rodent token = pest-primary, matching detectServiceLine
    // and recurring-appointment-seeder's serviceKeyFor.
    expect(toQualifyingKeys('Pest & Rodent Control')).toEqual(['pest_control']);
  });

  test('palm labels never qualify as tree & shrub', () => {
    expect(toQualifyingKeys('Palm Tree Injections')).toEqual([]);
    expect(toQualifyingKeys('Palm Injections')).toEqual([]);
  });

  test('genuine pest and tree/shrub labels still qualify unchanged', () => {
    expect(toQualifyingKeys('Quarterly Pest Control')).toEqual(['pest_control']);
    expect(toQualifyingKeys('Tree & Shrub Care')).toEqual(['tree_shrub']);
    // Palmetto-bug pest names carry no palm token and stay pest coverage.
    expect(toQualifyingKeys('Palmetto Bug Pest Control')).toEqual(['pest_control']);
  });
});

describe('resolveCustomerQualifyingEvidence (codex #3591 r34 P1) — tier per property, setup waiver account-wide', () => {
  const { resolveCustomerQualifyingEvidence } = require('../services/waveguard-existing-services');
  const customer = { address_line1: '100 Main St', address_line2: null, city: 'Parrish', zip: '34219' };
  const loadKeys = jest.fn(async (_db, _id, opts) => (opts?.streetScope ? ['mosquito'] : ['pest_control', 'mosquito']));
  beforeEach(() => loadKeys.mockClear());

  test('no customer → empty evidence, no lookup', async () => {
    expect(await resolveCustomerQualifyingEvidence(fakeDb({ customer }), { customerId: null, loadKeys }))
      .toEqual({ tierKeys: [], setupWaiverKeys: [], groupedEstimate: false, perPropertyStreetScope: null });
    expect(loadKeys).not.toHaveBeenCalled();
  });

  test('same property (or no address): waiver reads UNGATED (planGate: false) and STRICT, tier keeps the plan gate and is STRICT too (codex #3591 r73/r75 P1)', async () => {
    const out = await resolveCustomerQualifyingEvidence(fakeDb({ customer }), { customerId: 'c1', address: '100 Main St, Parrish, FL 34219', loadKeys });
    expect(out.groupedEstimate).toBe(false);
    expect(out.tierKeys).toEqual(['pest_control', 'mosquito']);
    expect(out.setupWaiverKeys).toEqual(['pest_control', 'mosquito']);
    expect(loadKeys).toHaveBeenCalledTimes(2);
    expect(loadKeys.mock.calls[0][2]).toEqual({ planGate: false, strict: true });
    expect(loadKeys.mock.calls[1][2]).toEqual({ strict: true });
  });

  test('a NON-primary street flips to per-property scope: tier from the street-scoped lookup, waiver from the account', async () => {
    const out = await resolveCustomerQualifyingEvidence(fakeDb({ customer }), { customerId: 'c1', address: '12 Second St, Parrish, FL 34219', loadKeys });
    expect(out.groupedEstimate).toBe(true);
    expect(out.perPropertyStreetScope).toMatchObject({ estimateStreet: expect.any(String), customerPrimaryStreet: expect.any(String) });
    expect(out.tierKeys).toEqual(['mosquito']);
    expect(out.setupWaiverKeys).toEqual(['pest_control', 'mosquito']);
    expect(loadKeys).toHaveBeenCalledTimes(2);
    expect(loadKeys.mock.calls[1][2]).toEqual({ streetScope: out.perPropertyStreetScope, strict: true });
  });

  test('an explicit group anchor on the primary street keeps the account-wide waiver while scoping the tier', async () => {
    const out = await resolveCustomerQualifyingEvidence(fakeDb({ customer }), {
      customerId: 'c1', address: '100 Main St, Parrish, FL 34219', groupedEstimate: true, loadKeys,
    });
    expect(out.groupedEstimate).toBe(true);
    expect(out.tierKeys).toEqual(['mosquito']);
    expect(out.setupWaiverKeys).toEqual(['pest_control', 'mosquito']);
  });

  test('grouped with NO parseable street: tier prices standalone, waiver evidence still account-wide', async () => {
    const out = await resolveCustomerQualifyingEvidence(fakeDb({ customer }), { customerId: 'c1', groupedEstimate: true, loadKeys });
    expect(out.tierKeys).toEqual([]);
    expect(out.setupWaiverKeys).toEqual(['pest_control', 'mosquito']);
    expect(loadKeys).toHaveBeenCalledTimes(1);
  });

  test('a failing key lookup propagates (callers refuse retryably, never price a member as a non-member)', async () => {
    await expect(resolveCustomerQualifyingEvidence(fakeDb({ customer }), { customerId: 'c1', loadKeys: async () => { throw new Error('db down'); } }))
      .rejects.toThrow('db down');
  });
});

// computeMembershipContext — existing-customer membership snapshot math.
// Covers the per-visit savings basis (last PAID invoice amount preferred,
// scheduled estimated_price fallback) and the new-service per-application
// savings figure shown on the public estimate.

// Controllable gate mock: default-off keeps every pre-existing test on the
// real test-env behavior (all gates dark); the extension suite flips ONLY
// waveguardExtendExisting.
let mockExtendExistingGate = false;
jest.mock('../config/feature-gates', () => ({
  isEnabled: (gate) => (gate === 'waveguardExtendExisting' ? mockExtendExistingGate : false),
}));

const {
  computeMembershipContext,
  loadCurrentServiceSpendContext,
  publicMembershipView,
} = require('../services/estimate-membership-context');

// Minimal chainable knex fake: every chain method returns the builder;
// first()/select() resolve canned rows per table.
function fakeDb({
  // An actual WaveGuard plan member (waveguard_tier set) — the existing-service
  // tier math only applies to real members, never to a lead with a stray visit.
  customer = { id: 'cust-1', first_name: 'Don', active: true, waveguard_tier: 'Bronze' },
  scheduledRows = [],
  paidInvoices = [],
  prepaidTerm = null,
  invoiceQueryThrows = false,
  addonRows = [],
  addonQueryThrows = false,
  mintedInvoiceLinks = [],
  mintedProbeThrows = false,
  // Opt-in catalog-join support. WITHOUT catalogRows the builder has no
  // leftJoin at all, so the catalog and cadence loaders throw and degrade
  // exactly as they did before this parameter existed — every pre-existing
  // test keeps its behavior byte-for-byte. Rows carry both loaders' columns
  // (service_key/service_name for classification, frequency/visits_per_year
  // for cadence); each loader reads only what it selected.
  catalogRows = null,
  // annual_prepay_terms rows backing prepaid scheduled rows. The TERM is the
  // authoritative source of a prepaid per-application figure
  // (prepay_amount / coverage_visit_count), so a prepaid fixture without a
  // matching term here withholds — which is the intended behavior.
  prepaidTerms = [],
  prepaidTermsQueryThrows = false,
} = {}) {
  const db = (table) => {
    // Per-call state: the extension's minted-invoice probe is the only
    // invoices query keyed by scheduled_service_id — the last-paid lookup
    // keys by customer/service_type and must keep returning paidInvoices.
    let probesServiceIds = false;
    const builder = {
      // coveredTermsAsOf always leftJoins, so the join must exist whenever a
      // terms fixture is in play. The catalog loader's degrade-on-no-join
      // behavior is preserved in select() instead of by withholding leftJoin.
      ...((catalogRows || prepaidTerms.length) ? { leftJoin: () => builder } : {}),
      where: () => builder,
      // coveredTermsAsOf composes its paid-coverage guard from these; a
      // missing one throws and the loader degrades to "no live term", which
      // silently looks like a legitimate withhold.
      orWhere: () => builder,
      orWhereNotNull: () => builder,
      orWhereIn: () => builder,
      whereNull: () => builder,
      whereRaw: () => builder,
      join: () => builder,
      whereIn: (col) => {
        if (col === 'scheduled_service_id') probesServiceIds = true;
        return builder;
      },
      whereNot: () => builder,
      whereNotIn: () => builder,
      whereNotNull: () => builder,
      andWhere: () => builder,
      orderBy: () => builder,
      limit: () => builder,
      columnInfo: async () => ({
        is_recurring: {},
        estimated_price: {},
        annual_prepay_term_id: {},
        service_address_line1: {},
        service_address_line2: {},
        service_address_city: {},
        service_address_zip: {},
      }),
      first: async () => {
        if (table === 'customers') return customer;
        if (table === 'annual_prepay_terms') return prepaidTerm;
        return null;
      },
      select: async (...cols) => {
        // The JOINED query is PROJECTED for real (codex #3353 r5): returning
        // every fixture property regardless of what the caller selected let a
        // missing column (recurring_interval_days) pass here while resolving
        // to undefined against a real database. Honoring the projection means
        // a column the code reads but never selects now fails the test.
        if (table === 'scheduled_services as s') {
          // Without a catalog fixture the join is treated as unavailable, so
          // the catalog/cadence loaders degrade exactly as they do against a
          // database lacking the services table.
          if (!catalogRows) throw new Error('relation does not exist');
          const requested = cols.flat().map((col) => {
            const text = String(col);
            const aliased = / as /i.test(text) ? text.split(/ as /i)[1] : text;
            return aliased.includes('.') ? aliased.split('.').pop() : aliased;
          });
          return (catalogRows || []).map((row) => Object.fromEntries(
            requested.filter((key) => key in row).map((key) => [key, row[key]]),
          ));
        }
        if (table === 'annual_prepay_terms' || table === 'annual_prepay_terms as t') {
          if (prepaidTermsQueryThrows) throw new Error('relation does not exist');
          return prepaidTerms;
        }
        if (table === 'scheduled_services') return scheduledRows;
        if (table === 'invoices') {
          if (probesServiceIds) {
            if (mintedProbeThrows) throw new Error('relation does not exist');
            return mintedInvoiceLinks.map((id) => ({ scheduled_service_id: id }));
          }
          if (invoiceQueryThrows) throw new Error('relation does not exist');
          return paidInvoices;
        }
        if (table === 'scheduled_service_addons') {
          if (addonQueryThrows) throw new Error('relation does not exist');
          return addonRows;
        }
        return [];
      },
    };
    return builder;
  };
  db.fn = { now: () => new Date() };
  return db;
}

function lawnEstimateData() {
  return {
    result: {
      results: {
        lawn: [{ v: 9, recommended: true }],
      },
      recurring: {
        discount: 0.10,
        annualBeforeDiscount: 837,
        annualAfterDiscount: 753.30,
        services: [{ name: 'Lawn Care', mo: 69.75 }],
      },
    },
  };
}

function futurePestRows() {
  return [
    { id: 's1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120 },
    { id: 's2', service_type: 'pest_control', scheduled_date: '2099-04-05', estimated_price: 120 },
    { id: 's3', service_type: 'pest_control', scheduled_date: '2099-07-05', estimated_price: 120 },
  ];
}

describe('computeMembershipContext', () => {
  test('account spend lists non-tier recurring work without using it for WaveGuard qualification', async () => {
    const database = fakeDb({
      scheduledRows: [
        { id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120 },
        { id: 'r1', service_type: 'rodent_bait', scheduled_date: '2099-02-05', estimated_price: 45 },
      ],
      paidInvoices: [
        { service_type: 'pest_control', total: 117, paid_at: '2026-05-20' },
        { service_type: 'rodent_bait', total: 42, paid_at: '2026-05-21' },
      ],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.existingServiceKeys).toEqual(['pest_control']);
    expect(spend).toEqual(expect.objectContaining({
      currentTier: 'bronze',
      currentTierLabel: 'Bronze',
      currentDiscountPct: 0,
    }));
    expect(spend.currentServices).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'pest_control', currentPerVisit: 117, qualifiesForWaveGuard: true }),
      expect.objectContaining({ key: 'rodent_bait', currentPerVisit: 42, qualifiesForWaveGuard: false }),
    ]));
    expect(spend.currentSpendPerVisitTotal).toBe(159);
  });

  test('display-name recurring rows canonicalize to template keys for duplicate checks', async () => {
    const database = fakeDb({
      scheduledRows: [
        { id: 'r1', service_type: 'Rodent Bait Stations', scheduled_date: '2099-02-05', estimated_price: 45 },
        { id: 'p1', service_type: 'Palm Injection', scheduled_date: '2099-03-05', estimated_price: 60 },
      ],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.existingServiceKeys).toEqual([]);
    expect(spend.currentServices.map((service) => service.key).sort()).toEqual(['palm_injection', 'rodent_bait']);
  });

  test('palm- and rodent-led names keep canonical precedence in component keys', async () => {
    const database = fakeDb({
      scheduledRows: [
        { id: 'palm1', service_type: 'Palm Tree Injections', scheduled_date: '2099-01-05', estimated_price: 60 },
        { id: 'rod1', service_type: 'Rodent Pest Control', scheduled_date: '2099-02-05', estimated_price: 45 },
        { id: 'combo1', service_type: 'Pest & Rodent Control', scheduled_date: '2099-03-05', estimated_price: 120 },
      ],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    // Mirrors toQualifyingKeys precedence: "Palm Tree Injections" is the palm
    // service (a tree_shrub component would wrongly block adding Tree &
    // Shrub); a rodent-led name is the rodent service, never pest coverage;
    // only the pest-primary combined label keeps pest_control.
    const byKey = Object.fromEntries(spend.currentServices.map((service) => [service.key, service]));
    expect(Object.keys(byKey).sort()).toEqual(['palm_injection', 'pest_control', 'rodent_bait']);
    expect(byKey.palm_injection.keys).toEqual(['palm_injection']);
    expect(byKey.rodent_bait.keys).toEqual(['rodent_bait']);
    expect(byKey.pest_control.keys).toEqual(['pest_control']);
  });

  test('combined service components retain only their own property addresses', async () => {
    const database = fakeDb();
    const spend = await loadCurrentServiceSpendContext(database, 'cust-1', {
      existingRows: [
        {
          id: 'combo-a', service_type: 'Quarterly Pest + Lawn', scheduled_date: '2099-01-05',
          estimated_price: 180, effective_service_address: '1 Property A St, Bradenton FL 34208',
        },
        {
          id: 'pest-b', service_type: 'Quarterly Pest Control', scheduled_date: '2099-02-05',
          estimated_price: 117, effective_service_address: '2 Property B St, Venice FL 34285',
        },
      ],
    });

    const grouped = spend.currentServices.find((service) => service.key === 'pest_control');
    expect(grouped.keys).toEqual(expect.arrayContaining(['pest_control', 'lawn_care']));
    expect(grouped.componentServiceAddresses).toEqual({
      pest_control: ['1 Property A St, Bradenton FL 34208', '2 Property B St, Venice FL 34285'],
      lawn_care: ['1 Property A St, Bradenton FL 34208'],
    });
    expect(grouped.componentServiceAddressesComplete).toEqual({
      pest_control: true,
      lawn_care: true,
    });
  });

  test('the same recurring service at two properties counts BOTH contracts toward spend', async () => {
    const database = fakeDb({
      // Newest paid invoice reflects ONE property's contract — it must not
      // stand in for both, and the second contract must still be counted.
      paidInvoices: [{ service_type: 'pest_control', total: 117, paid_at: '2026-05-20' }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1', {
      existingRows: [
        {
          id: 'a1', service_type: 'Quarterly Pest Control', scheduled_date: '2099-01-05',
          estimated_price: 120, effective_service_address: '1 Property A St, Bradenton FL 34208',
        },
        {
          id: 'a2', service_type: 'Quarterly Pest Control', scheduled_date: '2099-04-05',
          estimated_price: 120, effective_service_address: '1 Property A St, Bradenton FL 34208',
        },
        {
          id: 'b1', service_type: 'Quarterly Pest Control', scheduled_date: '2099-02-05',
          estimated_price: 95, effective_service_address: '2 Property B St, Venice FL 34285',
        },
      ],
    });

    const pest = spend.currentServices.find((service) => service.key === 'pest_control');
    // Per-property contracts: $120 (A) + $95 (B). Visit rows at the SAME
    // property stay one contract (never $120 + $120), and the account-wide
    // invoice amount is not applied across contracts.
    expect(pest).toMatchObject({
      currentPerVisit: 215,
      scheduledPerVisit: 215,
      spendSource: 'scheduled_estimate',
      lastPaidAt: null,
      activeScheduledVisits: 3,
    });
    expect(pest.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        serviceAddress: '1 Property A St, Bradenton FL 34208',
        scheduledPerVisit: 120,
        activeScheduledVisits: 2,
      }),
      expect.objectContaining({
        serviceAddress: '2 Property B St, Venice FL 34285',
        scheduledPerVisit: 95,
        activeScheduledVisits: 1,
      }),
    ]));
    expect(spend.currentSpendPerVisitTotal).toBe(215);
  });

  test('a single-property contract still prefers the last-paid invoice basis', async () => {
    const database = fakeDb({
      paidInvoices: [{ service_type: 'pest_control', total: 117, paid_at: '2026-05-20' }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1', {
      existingRows: [
        {
          id: 'a1', service_type: 'Quarterly Pest Control', scheduled_date: '2099-01-05',
          estimated_price: 120, effective_service_address: '1 Property A St, Bradenton FL 34208',
        },
        {
          id: 'a2', service_type: 'Quarterly Pest Control', scheduled_date: '2099-04-05',
          estimated_price: 120, effective_service_address: '1 Property A St, Bradenton FL 34208',
        },
      ],
    });

    expect(spend.currentServices).toEqual([
      expect.objectContaining({
        key: 'pest_control',
        currentPerVisit: 117,
        spendSource: 'last_paid_invoice',
        lastPaidAt: '2026-05-20',
      }),
    ]);
    expect(spend.currentSpendPerVisitTotal).toBe(117);
  });

  test('differently formatted stamps of one property collapse to a single contract', async () => {
    const database = fakeDb();

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1', {
      existingRows: [
        {
          id: 'v1', service_type: 'Quarterly Pest Control', scheduled_date: '2099-01-05',
          estimated_price: 120, effective_service_address: '123 Main Street, Bradenton, 34208',
        },
        {
          id: 'v2', service_type: 'Quarterly Pest Control', scheduled_date: '2099-04-05',
          estimated_price: 120, effective_service_address: '123 Main St, Bradenton, 34208',
        },
      ],
    });

    // '123 Main Street' vs '123 Main St' is formatting drift on ONE contract —
    // the per-visit price counts once, never once per spelling.
    const pest = spend.currentServices.find((service) => service.key === 'pest_control');
    expect(pest.contracts).toHaveLength(1);
    expect(pest).toMatchObject({
      currentPerVisit: 120,
      spendSource: 'scheduled_estimate',
      activeScheduledVisits: 2,
    });
    expect(spend.currentSpendPerVisitTotal).toBe(120);
  });

  test('explicit different units at the same street stay separate contracts', async () => {
    const database = fakeDb();

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1', {
      existingRows: [
        {
          id: 'u1', service_type: 'Quarterly Pest Control', scheduled_date: '2099-01-05',
          estimated_price: 120, effective_service_address: '500 Gulf Blvd Unit 101, Venice, 34285',
        },
        {
          id: 'u2', service_type: 'Quarterly Pest Control', scheduled_date: '2099-02-05',
          estimated_price: 95, effective_service_address: '500 Gulf Blvd Unit 102, Venice, 34285',
        },
      ],
    });

    const pest = spend.currentServices.find((service) => service.key === 'pest_control');
    expect(pest.contracts).toHaveLength(2);
    expect(pest).toMatchObject({ currentPerVisit: 215, spendSource: 'scheduled_estimate' });
    expect(spend.currentSpendPerVisitTotal).toBe(215);
  });

  test('a unitless stamp never bridges two explicit units, regardless of row order', async () => {
    const unit101 = {
      id: 'u1', service_type: 'Quarterly Pest Control', scheduled_date: '2099-01-05',
      estimated_price: 120, effective_service_address: '500 Gulf Blvd Unit 101, Venice, 34285',
    };
    const unit102 = {
      id: 'u2', service_type: 'Quarterly Pest Control', scheduled_date: '2099-02-05',
      estimated_price: 95, effective_service_address: '500 Gulf Blvd Unit 102, Venice, 34285',
    };
    const unitless = {
      id: 'u3', service_type: 'Quarterly Pest Control', scheduled_date: '2099-03-05',
      estimated_price: 110, effective_service_address: '500 Gulf Blvd, Venice, 34285',
    };

    const results = [];
    for (const existingRows of [[unitless, unit101, unit102], [unit101, unit102, unitless]]) {
      const spend = await loadCurrentServiceSpendContext(fakeDb(), 'cust-1', { existingRows });
      results.push(spend.currentServices.find((service) => service.key === 'pest_control'));
    }

    for (const pest of results) {
      // Units 101 and 102 are proven-distinct contracts; the ambiguous
      // unitless stamp folds into an existing unit group instead of bridging
      // the two into one or minting a third contract.
      expect(pest.contracts).toHaveLength(2);
      expect(pest.contracts.map((contract) => contract.serviceAddress).sort()).toEqual([
        '500 Gulf Blvd Unit 101, Venice, 34285',
        '500 Gulf Blvd Unit 102, Venice, 34285',
      ]);
      expect(pest.currentPerVisit).toBe(215);
      expect(pest.activeScheduledVisits).toBe(3);
    }
    // Same contract set and spend no matter which row the DB returned first.
    // serviceAddresses / componentServiceAddresses are set-semantics metadata
    // that follows raw row order, so they're sorted before comparing.
    const normalized = results.map((service) => ({
      ...service,
      serviceAddresses: [...service.serviceAddresses].sort(),
      componentServiceAddresses: Object.fromEntries(
        Object.entries(service.componentServiceAddresses)
          .map(([component, addresses]) => [component, [...addresses].sort()]),
      ),
    }));
    expect(normalized[0]).toEqual(normalized[1]);
  });

  test('two unitless stamps of the same street remain one contract', async () => {
    const spend = await loadCurrentServiceSpendContext(fakeDb(), 'cust-1', {
      existingRows: [
        {
          id: 'v1', service_type: 'Quarterly Pest Control', scheduled_date: '2099-01-05',
          estimated_price: 120, effective_service_address: '500 Gulf Blvd, Venice, 34285',
        },
        {
          id: 'v2', service_type: 'Quarterly Pest Control', scheduled_date: '2099-04-05',
          estimated_price: 120, effective_service_address: '500 Gulf Blvd, Venice, 34285',
        },
      ],
    });

    const pest = spend.currentServices.find((service) => service.key === 'pest_control');
    expect(pest.contracts).toHaveLength(1);
    expect(pest).toMatchObject({ currentPerVisit: 120, activeScheduledVisits: 2 });
    expect(spend.currentSpendPerVisitTotal).toBe(120);
  });

  test('mixed stamped/unstamped rows collapse to one contract rather than double-counting', async () => {
    const database = fakeDb();

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1', {
      existingRows: [
        {
          id: 'a1', service_type: 'Quarterly Pest Control', scheduled_date: '2099-01-05',
          estimated_price: 120, effective_service_address: '1 Property A St, Bradenton FL 34208',
        },
        {
          id: 'legacy', service_type: 'Quarterly Pest Control', scheduled_date: '2099-02-05',
          estimated_price: 95, effective_service_address: null,
        },
      ],
    });

    // The unstamped row could be the SAME contract as the stamped one, so the
    // set is not property-split: one contract, first priced row's rate.
    expect(spend.currentServices).toEqual([
      expect.objectContaining({
        key: 'pest_control',
        currentPerVisit: 120,
        spendSource: 'scheduled_estimate',
      }),
    ]);
    expect(spend.currentSpendPerVisitTotal).toBe(120);
  });

  test('existing-service spend is preserved as context while discounts apply only to additions', async () => {
    const database = fakeDb({
      scheduledRows: futurePestRows(),
      paidInvoices: [
        { service_type: 'Quarterly Pest Control', total: '117.00', paid_at: '2026-05-20' },
        { service_type: 'Quarterly Pest Control', total: '95.00', paid_at: '2026-02-20' },
      ],
    });

    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
    });

    expect(ctx).toMatchObject({
      isExistingCustomer: true,
      tierLabel: 'Silver',
      existingServiceKeys: ['pest_control'],
    });
    expect(ctx.existingServices).toEqual([]);
    expect(ctx.discountAppliesTo).toBe('new_services_only');
    expect(ctx.currentServices).toEqual([
      expect.objectContaining({
        key: 'pest_control',
        currentPerVisit: 117,
        spendSource: 'last_paid_invoice',
        lastPaidAt: '2026-05-20',
      }),
    ]);
    expect(ctx.currentSpendPerVisitTotal).toBe(117);
  });

  test('frozen membership snapshot expands every component of a combined active plan', async () => {
    const database = fakeDb({
      scheduledRows: [{
        id: 'combo-1',
        service_type: 'Quarterly Pest + Lawn',
        scheduled_date: '2099-01-05',
        estimated_price: 180,
      }],
    });

    const snapshot = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: {
        lineItems: [{
          service: 'tree_shrub',
          annualAfterDiscount: 840,
          monthlyAfterDiscount: 70,
          recurring: true,
          frequency: 6,
        }],
      },
    });

    expect(snapshot).toMatchObject({
      tier: 'gold',
      tierLabel: 'Gold',
      existingServiceKeys: ['pest_control', 'lawn_care'],
    });
    expect(snapshot.newServices).toEqual([
      expect.objectContaining({ key: 'tree_shrub' }),
    ]);
  });

  test('the frozen snapshot lists non-tier recurring work, not just qualifying rows', async () => {
    const database = fakeDb({
      scheduledRows: [
        { id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120 },
        { id: 'r1', service_type: 'Rodent Bait Stations', scheduled_date: '2099-02-05', estimated_price: 45 },
      ],
    });

    const snapshot = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: { lineItems: [{ service: 'lawn_care', annualAfterDiscount: 840, monthlyAfterDiscount: 70, recurring: true, frequency: 6 }] },
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot.currentServices.map((service) => service.key).sort()).toEqual(['pest_control', 'rodent_bait']);
  });

  test('commercial display names canonicalize to commercial_ + the residential template key', async () => {
    const database = fakeDb({
      scheduledRows: [
        { id: 'c1', service_type: 'Commercial Turf Treatment Program', scheduled_date: '2099-01-05', estimated_price: 300 },
        { id: 'c2', service_type: 'Commercial Rodent Bait Stations', scheduled_date: '2099-02-05', estimated_price: 60 },
      ],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.existingServiceKeys).toEqual([]);
    expect(spend.currentServices.map((service) => service.key).sort())
      .toEqual(['commercial_lawn_care', 'commercial_rodent_bait']);
  });

  test('a customer row with NO existing services is NOT flagged existing (keeps prepay eligible)', async () => {
    // Regression: a brand-new pest/lawn signup whose customer row already
    // exists (created at intake/onsite) carries zero qualifying recurring
    // services. It must render as a NEW customer so the annual-prepay option
    // and the WaveGuard setup fee are not suppressed by the existing-customer
    // guard in estimate-public / estimate-converter.
    const database = fakeDb({ scheduledRows: [] });

    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
    });

    expect(ctx).toMatchObject({ isExistingCustomer: false });
    expect(ctx.existingServiceKeys).toEqual([]);
  });

  test('a "No Plan" customer with a pending recurring visit is NOT flagged existing', async () => {
    // Regression (Cristina Lipham): a lead/one-time buyer whose initial pest
    // service auto-scheduled a quarterly follow-up has a recurring qualifying
    // scheduled_services row, but no WaveGuard plan tier. They must render as a
    // NEW customer — $99 setup charged, annual prepay offered — not get the
    // member treatment off a single scheduled visit.
    const database = fakeDb({
      customer: { id: 'cust-1', first_name: 'Cristina', active: true, waveguard_tier: null },
      scheduledRows: futurePestRows(),
    });

    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
    });

    expect(ctx).toMatchObject({ isExistingCustomer: false });
    expect(ctx.existingServiceKeys).toEqual([]);
  });

  test('a one-time tier ("One-Time") does not count as plan membership', async () => {
    const database = fakeDb({
      customer: { id: 'cust-1', first_name: 'Cristina', active: true, waveguard_tier: 'One-Time' },
      scheduledRows: futurePestRows(),
    });

    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
    });

    expect(ctx).toMatchObject({ isExistingCustomer: false });
    expect(ctx.existingServiceKeys).toEqual([]);
  });

  test('falls back to scheduled estimated_price when there is no paid history', async () => {
    const database = fakeDb({ scheduledRows: futurePestRows(), paidInvoices: [] });

    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
    });

    expect(ctx.currentServices[0]).toMatchObject({ currentPerVisit: 120, spendSource: 'scheduled_estimate' });
  });

  test('invoice lookup failure degrades to the estimated_price fallback, not an error', async () => {
    const database = fakeDb({ scheduledRows: futurePestRows(), invoiceQueryThrows: true });

    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
    });

    expect(ctx).not.toBeNull();
    expect(ctx.currentServices[0]).toMatchObject({ currentPerVisit: 120, spendSource: 'scheduled_estimate' });
  });

  test('new-service savings include a per-application dollar figure', async () => {
    const database = fakeDb({
      scheduledRows: futurePestRows(),
      paidInvoices: [{ service_type: 'pest_control', total: 117, paid_at: '2026-05-20' }],
    });

    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
    });

    // $69.75/mo over 9 applications = $93/application; 10% member discount.
    expect(ctx.newServices).toEqual([
      expect.objectContaining({
        key: 'lawn_care',
        discountPct: 10,
        monthlySavings: 6.98,
        perApplicationSavings: 9.30,
      }),
    ]);
  });

  test('a margin-guarded service shows ITS capped rate, not the blended aggregate', async () => {
    const database = fakeDb({ scheduledRows: futurePestRows() });

    // Gold bundle where the guard capped tree_shrub at ~6% while lawn took
    // the full 15%. Blended aggregate = 1 - 1356.5/1550 ≈ 12.5% — the old
    // uniform smear advertised 12% on BOTH lines.
    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: {
        result: {
          results: { lawn: [{ v: 12, recommended: true }], ts: [{ v: 6, selected: true }] },
          recurring: {
            discount: 0.15,
            annualBeforeDiscount: 1550,
            annualAfterDiscount: 1356.5,
            services: [
              { name: 'Lawn Care', mo: 55, annualAfterDiscount: 561 },
              { name: 'Tree & Shrub', mo: 36.5, perTreatment: 73, visitsPerYear: 6, annualAfterDiscount: 411.3 },
            ],
          },
        },
      },
    });

    const byKey = Object.fromEntries(ctx.newServices.map((s) => [s.key, s]));
    // Lawn: full tier rate from its own before/after pair (660 → 561 = 15%).
    expect(byKey.lawn_care).toMatchObject({
      discountPct: 15,
      monthlySavings: 8.25,
      perApplicationSavings: 8.25,
    });
    // Tree & Shrub: the guard kept 438 → 411.3, a 6% effective rate. The
    // card must not advertise more than that line actually received.
    expect(byKey.tree_shrub).toMatchObject({ discountPct: 6 });
    expect(byKey.tree_shrub.perApplicationSavings).toBeCloseTo(73 * (1 - 411.3 / 438), 2);
  });

  test('setup line items are excluded from the last-paid per-visit basis', async () => {
    const database = fakeDb({
      scheduledRows: futurePestRows(),
      // First standard accept invoice: $99 setup + $117 first application on
      // ONE service-linked invoice. Only the service line may count.
      paidInvoices: [{
        service_type: 'pest_control',
        total: '216.00',
        paid_at: '2026-05-20',
        line_items: JSON.stringify([
          { description: 'WaveGuard Membership — one-time setup fee', quantity: 1, unit_price: 99 },
          { description: 'First service application', quantity: 1, unit_price: 117 },
        ]),
      }],
    });

    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
    });

    expect(ctx.currentServices[0]).toMatchObject({ currentPerVisit: 117 });
  });

  test('discount line items reduce the last-paid per-visit basis', async () => {
    const database = fakeDb({
      scheduledRows: futurePestRows(),
      // $120 visit with a -$12 member discount row — the customer actually
      // paid $108, so current spend must show $108, not $120.
      paidInvoices: [{
        service_type: 'pest_control',
        total: '108.00',
        paid_at: '2026-05-20',
        line_items: JSON.stringify([
          { description: 'Quarterly pest control visit', quantity: 1, unit_price: 120 },
          { description: 'WaveGuard Silver — 10% off', quantity: 1, amount: -12 },
        ]),
      }],
    });

    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
    });

    expect(ctx.currentServices[0]).toMatchObject({ currentPerVisit: 108 });
  });

  test('an all-setup invoice is skipped in favor of an older service invoice', async () => {
    const database = fakeDb({
      scheduledRows: futurePestRows(),
      paidInvoices: [
        {
          service_type: 'pest_control',
          total: '99.00',
          paid_at: '2026-06-01',
          line_items: JSON.stringify([
            { description: 'WaveGuard Membership — one-time setup fee', quantity: 1, unit_price: 99 },
          ]),
        },
        { service_type: 'pest_control', total: '117.00', paid_at: '2026-05-20', line_items: '[]' },
      ],
    });

    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
    });

    expect(ctx.currentServices[0]).toMatchObject({ currentPerVisit: 117 });
  });

  test('publicMembershipView: the public link gets ONLY the customer-page whitelist', async () => {
    const database = fakeDb({
      scheduledRows: [{
        id: 'p1',
        service_type: 'pest_control',
        scheduled_date: '2099-01-05',
        estimated_price: 120,
        service_address_line1: '999 Secondary Property Ln',
        service_address_city: 'Venice',
        service_address_zip: '34285',
      }],
      paidInvoices: [{ service_type: 'pest_control', total: 117, paid_at: '2026-05-20' }],
    });

    const snapshot = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
    });

    // The frozen snapshot itself KEEPS the staff context — admin surfaces and
    // accept-time logic read it.
    expect(snapshot.currentServices[0]).toMatchObject({
      currentPerVisit: 117,
      lastPaidAt: '2026-05-20',
      serviceAddresses: ['999 Secondary Property Ln, Venice, 34285'],
    });
    expect(snapshot.currentSpendPerVisitTotal).toBe(117);

    const view = publicMembershipView(snapshot);

    expect(Object.keys(view).sort()).toEqual([
      'discountAppliesTo', 'existingServiceKeys', 'existingServices', 'firstName',
      'isExistingCustomer', 'newServices', 'tier', 'tierDiscountPct', 'tierLabel', 'upgrade',
    ]);
    const json = JSON.stringify(view);
    for (const staffMarker of [
      'currentServices', 'currentSpendPerVisitTotal', 'serviceAddress', 'contracts',
      'lastPaidAt', 'currentPerVisit', 'scheduledPerVisit', 'spendSource',
      'nextScheduledDate', 'activeScheduledVisits', '999 Secondary Property Ln', '2026-05-20',
    ]) {
      expect(json).not.toContain(staffMarker);
    }
    // Everything the customer page renders survives intact.
    expect(view).toMatchObject({
      isExistingCustomer: true,
      firstName: 'Don',
      tier: 'silver',
      tierLabel: 'Silver',
      tierDiscountPct: 10,
      discountAppliesTo: 'new_services_only',
      existingServiceKeys: ['pest_control'],
    });
    expect(view.upgrade).toMatchObject({ fromLabel: 'Bronze', toLabel: 'Silver', deltaPct: 10 });
    expect(view.newServices).toEqual([expect.objectContaining({
      key: 'lawn_care',
      label: 'Lawn Care',
      discountPct: 10,
      monthlySavings: 6.98,
      perApplicationSavings: 9.30,
    })]);
  });

  test('publicMembershipView: a missing snapshot projects to null', () => {
    expect(publicMembershipView(null)).toBeNull();
    expect(publicMembershipView(undefined)).toBeNull();
  });

  test('setup/prepay invoices without service_type never feed the per-visit basis', async () => {
    const database = fakeDb({
      scheduledRows: futurePestRows(),
      // The whereNotNull('service_type') filter is in the query itself; rows
      // that still arrive with a non-qualifying type are skipped too.
      paidInvoices: [
        { service_type: 'rodent_bait', total: 500, paid_at: '2026-06-01' },
        { service_type: 'pest_control', total: 117, paid_at: '2026-05-20' },
      ],
    });

    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
    });

    expect(ctx.currentServices[0]).toMatchObject({ currentPerVisit: 117 });
  });
});

// Existing-service tier extension (owner decision 2026-08-10, dark behind
// GATE_WAVEGUARD_EXTEND_EXISTING): a tier-raising estimate freezes the
// customer's current qualifying services at the delta rate, and the public
// projection deliberately carries the prices + visit dates the customer page
// renders.
// Staff-panel context for pricing an upgrade: the cadence behind a
// per-application figure, and a usable basis for the plans that carry no
// invoice or scheduled price (legacy and monthly-lane members, which used to
// read "unavailable" and tell the office nothing).
describe('current-spend cadence and stamped billing basis', () => {
  const memberWith = (extra) => ({
    id: 'cust-1', first_name: 'Don', active: true, waveguard_tier: 'Bronze', ...extra,
  });

  test('catalog cadence surfaces as a label and a visit count', async () => {
    const database = fakeDb({
      scheduledRows: [
        { id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120 },
      ],
      paidInvoices: [{ service_type: 'pest_control', total: 117, paid_at: '2026-05-20' }],
      catalogRows: [{
        id: 'p1', service_key: 'pest_general_quarterly', service_name: 'Pest Control',
        frequency: 'quarterly', visits_per_year: 4,
      }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      key: 'pest_control',
      currentPerVisit: 117,
      cadenceLabel: 'Quarterly',
      visitsPerYear: 4,
      spendSource: 'last_paid_invoice',
    }));
  });

  test('"bimonthly" reads as every other month, never twice a month', async () => {
    const database = fakeDb({
      scheduledRows: [{ id: 'l1', service_type: 'lawn_care', scheduled_date: '2099-01-05', estimated_price: 80 }],
      catalogRows: [{ id: 'l1', frequency: 'bimonthly', visits_per_year: 6 }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.currentServices[0].cadenceLabel).toBe('Every other month');
  });

  test('a single-service account with no invoice or scheduled price falls back to the stamped per-application fee', async () => {
    const database = fakeDb({
      customer: memberWith({ billing_mode: 'per_application', per_application_fee: 95 }),
      scheduledRows: [{ id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05' }],
      catalogRows: [{ id: 'p1', frequency: 'quarterly', visits_per_year: 4 }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      currentPerVisit: 95,
      spendSource: 'per_application_fee',
      cadenceLabel: 'Quarterly',
    }));
  });

  test('a monthly member with no per-visit evidence derives per application from the monthly rate', async () => {
    const database = fakeDb({
      customer: memberWith({ monthly_rate: 95 }),
      scheduledRows: [{ id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05' }],
      catalogRows: [{ id: 'p1', frequency: 'quarterly', visits_per_year: 4 }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    // $95/mo x 12 / 4 visits — the arithmetic equivalent, labelled as derived
    // so staff never reads it as an amount the customer was charged.
    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      currentPerVisit: 285,
      spendSource: 'monthly_rate_derived',
    }));
  });

  test('a multi-service account never borrows the whole-plan billing stamp for one service', async () => {
    const database = fakeDb({
      customer: memberWith({ billing_mode: 'per_application', per_application_fee: 95, monthly_rate: 150 }),
      scheduledRows: [
        { id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05' },
        { id: 'l1', service_type: 'lawn_care', scheduled_date: '2099-01-06' },
      ],
      catalogRows: [
        { id: 'p1', frequency: 'quarterly', visits_per_year: 4 },
        { id: 'l1', frequency: 'bimonthly', visits_per_year: 6 },
      ],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    // The converter only stamps per_application_fee for a SINGLE-recurring-unit
    // accept, so on a two-service account it is a whole-plan figure that
    // belongs to neither line.
    for (const service of spend.currentServices) {
      expect(service.currentPerVisit).toBeNull();
      expect(service.spendSource).toBe('unavailable');
    }
    expect(spend.currentSpendPerVisitTotal).toBe(0);
  });

  test('real payment evidence still outranks the billing stamp', async () => {
    const database = fakeDb({
      customer: memberWith({ billing_mode: 'per_application', per_application_fee: 95 }),
      scheduledRows: [
        { id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120 },
      ],
      paidInvoices: [{ service_type: 'pest_control', total: 117, paid_at: '2026-05-20' }],
      catalogRows: [{ id: 'p1', frequency: 'quarterly', visits_per_year: 4 }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      currentPerVisit: 117,
      spendSource: 'last_paid_invoice',
    }));
  });

  test('an annual-prepay contract quotes the PAID allocation, never the list price', async () => {
    const database = fakeDb({
      scheduledRows: [
        { id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120, annual_prepay_term_id: 't1', prepaid_amount: 114, prepaid_method: 'annual_prepay_invoice' },
        { id: 'p2', service_type: 'pest_control', scheduled_date: '2099-04-05', estimated_price: 120, annual_prepay_term_id: 't1', prepaid_amount: 114, prepaid_method: 'annual_prepay_invoice' },
      ],
      catalogRows: [{ id: 'p1', frequency: 'quarterly', visits_per_year: 4 }],
      prepaidTerms: [{ id: 't1', prepay_amount: 456, coverage_visit_count: 4 }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    // estimated_price stays the undiscounted list figure; the TERM says what
    // was actually paid per application. A panel captioned "currently pays"
    // must show the latter.
    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      currentPerVisit: 114,
      spendSource: 'prepaid_allocation',
    }));
  });

  test('a non-uniformly prepaid contract keeps the scheduled price rather than one row\'s allocation', async () => {
    const database = fakeDb({
      scheduledRows: [
        { id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120, annual_prepay_term_id: 't1', prepaid_amount: 114, prepaid_method: 'annual_prepay_invoice' },
        { id: 'p2', service_type: 'pest_control', scheduled_date: '2099-04-05', estimated_price: 120 },
      ],
      catalogRows: [{ id: 'p1', frequency: 'quarterly', visits_per_year: 4 }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      currentPerVisit: 120,
      spendSource: 'scheduled_estimate',
    }));
  });

  test('a combined single row never lets the whole-plan total become one component\'s price', async () => {
    const database = fakeDb({
      // ONE row, but two recurring families — accountServiceKey groups it
      // under pest_control alone, so a key-count-only gate would pass and
      // report the pest+termite plan total as Pest Control's per-app price.
      customer: memberWith({ monthly_rate: 150 }),
      scheduledRows: [
        { id: 'c1', service_type: 'Quarterly Pest + Termite Bait Station', scheduled_date: '2099-01-05' },
      ],
      catalogRows: [{ id: 'c1', frequency: 'quarterly', visits_per_year: 4 }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    const combined = spend.currentServices[0];
    expect(combined.keys.length).toBeGreaterThan(1);
    expect(combined.currentPerVisit).toBeNull();
    expect(combined.spendSource).toBe('unavailable');
  });

  test('per-property contracts each carry their own billed figure', async () => {
    const database = fakeDb({
      scheduledRows: [
        { id: 'a1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 100, service_address_line1: '1 Palm St', service_address_city: 'Bradenton', service_address_zip: '34203' },
        { id: 'b1', service_type: 'pest_control', scheduled_date: '2099-01-06', estimated_price: 100, service_address_line1: '2 Oak Ave', service_address_city: 'Venice', service_address_zip: '34285' },
      ],
      catalogRows: [{ id: 'a1', frequency: 'quarterly', visits_per_year: 4 }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    // The aggregate is the account's family spend, NOT one visit's charge —
    // the per-contract figures are what a single property is quoted against,
    // so both must be present for the panel to itemize instead of showing
    // "$200.00 per application".
    const service = spend.currentServices[0];
    expect(service.currentPerVisit).toBe(200);
    expect(service.contracts).toHaveLength(2);
    expect(service.contracts.map((contract) => contract.perVisit)).toEqual([100, 100]);
  });

  test('a COMBINED invoice never becomes one component\'s per-application price', async () => {
    const database = fakeDb({
      scheduledRows: [
        { id: 'c1', service_type: 'Quarterly Pest + Termite Bait Station', scheduled_date: '2099-01-05', estimated_price: 150 },
      ],
      // One charge covering pest AND termite — filed under pest_control by
      // accountServiceKey, so using it would quote the bundle as pest's price.
      paidInvoices: [{ service_type: 'Quarterly Pest + Termite Bait Station', total: 150, paid_at: '2026-05-20' }],
      catalogRows: [{ id: 'c1', frequency: 'quarterly', visits_per_year: 4 }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.currentServices[0].spendSource).not.toBe('last_paid_invoice');
  });

  test('an active prepaid allocation outranks a superseded per-visit invoice', async () => {
    const database = fakeDb({
      scheduledRows: [
        { id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120, annual_prepay_term_id: 't1', prepaid_amount: 114, prepaid_method: 'annual_prepay_invoice' },
        { id: 'p2', service_type: 'pest_control', scheduled_date: '2099-04-05', estimated_price: 120, annual_prepay_term_id: 't1', prepaid_amount: 114, prepaid_method: 'annual_prepay_invoice' },
      ],
      // Paid BEFORE the customer moved onto the annual-prepay term — the
      // annual-prepay invoice itself carries no service_type, so this older
      // row is what survives in lastPaidByKey.
      paidInvoices: [{ service_type: 'pest_control', total: 120, paid_at: '2026-01-10' }],
      catalogRows: [{ id: 'p1', frequency: 'quarterly', visits_per_year: 4 }],
      prepaidTerms: [{ id: 't1', prepay_amount: 456, coverage_visit_count: 4 }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      currentPerVisit: 114,
      spendSource: 'prepaid_allocation',
    }));
  });

  test('the live series cadence overrides the catalog default', async () => {
    const database = fakeDb({
      customer: memberWith({ monthly_rate: 100 }),
      scheduledRows: [
        { id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05', recurring_pattern: 'monthly' },
      ],
      // Catalog says quarterly; the live series runs monthly. Reading the
      // catalog would label it 4/yr AND turn $100/mo into $300/application.
      // catalogRows model the JOINED row, so they carry s.recurring_pattern
      // alongside the catalog columns.
      catalogRows: [{ id: 'p1', recurring_pattern: 'monthly', frequency: 'quarterly', visits_per_year: 4 }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      cadenceLabel: 'Monthly',
      visitsPerYear: 12,
      currentPerVisit: 100,
      spendSource: 'monthly_rate_derived',
    }));
  });

  // Superseded by the r6 rule: a 'custom' pattern with NO interval days is a
  // declared live recurrence we cannot name, so it must withhold rather than
  // inherit the catalog default. This test asserted the inverse when it was
  // written in r4 — the rule changed, so its expectation did too.
  test('a bare custom pattern with no interval days withholds cadence', async () => {
    const database = fakeDb({
      scheduledRows: [
        { id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120, recurring_pattern: 'custom' },
      ],
      catalogRows: [{ id: 'p1', recurring_pattern: 'custom', frequency: 'quarterly', visits_per_year: 4 }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      cadenceLabel: null,
      visitsPerYear: null,
      // The price basis is unaffected — the scheduled price still stands.
      currentPerVisit: 120,
      spendSource: 'scheduled_estimate',
    }));
  });

  test('a custom series resolves its cadence from interval days, not the catalog', async () => {
    const database = fakeDb({
      customer: memberWith({ monthly_rate: 100 }),
      scheduledRows: [
        { id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05' },
      ],
      // 'custom' names nothing on its own, but 42 days IS every-6-weeks (9/yr).
      // Falling back to the quarterly catalog default would show 4/yr and turn
      // $100/mo into $300 per application instead of ~$133.
      catalogRows: [{
        id: 'p1', recurring_pattern: 'custom', recurring_interval_days: 42,
        frequency: 'quarterly', visits_per_year: 4,
      }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      cadenceLabel: 'Every 6 weeks',
      visitsPerYear: 9,
      currentPerVisit: 133.33,
    }));
  });

  test("the scheduler's monthly_nth_weekday pattern counts as monthly", async () => {
    const database = fakeDb({
      scheduledRows: [{ id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 90 }],
      catalogRows: [{
        id: 'p1', recurring_pattern: 'monthly_nth_weekday',
        frequency: 'quarterly', visits_per_year: 4,
      }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      cadenceLabel: 'Monthly', visitsPerYear: 12,
    }));
  });

  test('contracts on different schedules keep their own cadence; the family stays silent', async () => {
    const database = fakeDb({
      scheduledRows: [
        { id: 'a1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 60, service_address_line1: '1 Palm St', service_address_city: 'Bradenton', service_address_zip: '34203' },
        { id: 'b1', service_type: 'pest_control', scheduled_date: '2099-01-06', estimated_price: 100, service_address_line1: '2 Oak Ave', service_address_city: 'Venice', service_address_zip: '34285' },
      ],
      catalogRows: [
        { id: 'a1', recurring_pattern: 'monthly', frequency: 'monthly', visits_per_year: 12 },
        { id: 'b1', recurring_pattern: 'quarterly', frequency: 'quarterly', visits_per_year: 4 },
      ],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    const service = spend.currentServices[0];
    // One property is monthly, the other quarterly — showing either above BOTH
    // would be an arbitrary pick out of an unordered query.
    expect(service.cadenceLabel).toBeNull();
    expect(service.visitsPerYear).toBeNull();
    const byAddress = Object.fromEntries(service.contracts.map((c) => [c.serviceAddress, c]));
    expect(byAddress['1 Palm St, Bradenton, 34203']).toEqual(expect.objectContaining({ cadenceLabel: 'Monthly', visitsPerYear: 12 }));
    expect(byAddress['2 Oak Ave, Venice, 34285']).toEqual(expect.objectContaining({ cadenceLabel: 'Quarterly', visitsPerYear: 4 }));
  });

  test('a prepaid property beside a pay-per-visit one reports a mixed basis, not one source for both', async () => {
    const database = fakeDb({
      scheduledRows: [
        { id: 'a1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120, annual_prepay_term_id: 't1', prepaid_amount: 114, prepaid_method: 'annual_prepay_invoice', service_address_line1: '1 Palm St', service_address_city: 'Bradenton', service_address_zip: '34203' },
        { id: 'b1', service_type: 'pest_control', scheduled_date: '2099-01-06', estimated_price: 100, service_address_line1: '2 Oak Ave', service_address_city: 'Venice', service_address_zip: '34285' },
      ],
      catalogRows: [
        { id: 'a1', frequency: 'quarterly', visits_per_year: 4 },
        { id: 'b1', frequency: 'quarterly', visits_per_year: 4 },
      ],
      prepaidTerms: [{ id: 't1', prepay_amount: 456, coverage_visit_count: 4 }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    const service = spend.currentServices[0];
    expect(service.spendSource).toBe('mixed_basis');
    const byAddress = Object.fromEntries(service.contracts.map((c) => [c.serviceAddress, c]));
    expect(byAddress['1 Palm St, Bradenton, 34203'].spendSource).toBe('prepaid_allocation');
    expect(byAddress['1 Palm St, Bradenton, 34203'].perVisit).toBe(114);
    expect(byAddress['2 Oak Ave, Venice, 34285'].spendSource).toBe('scheduled_estimate');
    expect(byAddress['2 Oak Ave, Venice, 34285'].perVisit).toBe(100);
  });

  test('a weekly series shows NO cadence rather than inheriting the catalog default', async () => {
    const database = fakeDb({
      customer: memberWith({ monthly_rate: 100 }),
      scheduledRows: [{ id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05' }],
      // The scheduler supports weekly; normalizeCoverageCadence can't name it
      // and cadenceFromIntervalDays rejects 7 days as a non-coverage cadence.
      // Falling back to the quarterly catalog would show 4/yr and divide
      // $100/mo by 4 — a per-application figure for a plan that isn't billed
      // that way.
      catalogRows: [{
        id: 'p1', recurring_pattern: 'weekly', recurring_interval_days: 7,
        frequency: 'quarterly', visits_per_year: 4,
      }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      cadenceLabel: null,
      visitsPerYear: null,
      currentPerVisit: null,
      spendSource: 'unavailable',
    }));
  });

  test('a series declaring no recurrence of its own still uses the catalog cadence', async () => {
    const database = fakeDb({
      scheduledRows: [{ id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120 }],
      catalogRows: [{ id: 'p1', frequency: 'quarterly', visits_per_year: 4 }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      cadenceLabel: 'Quarterly', visitsPerYear: 4,
    }));
  });

  test('a prepaid allocation does not carry the superseded invoice\'s payment date', async () => {
    const database = fakeDb({
      scheduledRows: [
        { id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120, annual_prepay_term_id: 't1', prepaid_amount: 114, prepaid_method: 'annual_prepay_invoice' },
        { id: 'p2', service_type: 'pest_control', scheduled_date: '2099-04-05', estimated_price: 120, annual_prepay_term_id: 't1', prepaid_amount: 114, prepaid_method: 'annual_prepay_invoice' },
      ],
      paidInvoices: [{ service_type: 'pest_control', total: 120, paid_at: '2026-01-10' }],
      catalogRows: [{ id: 'p1', frequency: 'quarterly', visits_per_year: 4 }],
      prepaidTerms: [{ id: 't1', prepay_amount: 456, coverage_visit_count: 4 }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    // Otherwise the panel reads "prepaid allocation · 2026-01-10", dating the
    // current allocation to the payment it superseded.
    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      spendSource: 'prepaid_allocation',
      currentPerVisit: 114,
      lastPaidAt: null,
    }));
  });

  test("a split-remainder prepaid term quotes what was paid, not the list price", async () => {
    const database = fakeDb({
      // splitCoverageAmount($455.01, 4) → 113.75 / 113.75 / 113.75 / 113.76.
      // The cent remainder lands on the final visit BY DESIGN, so demanding
      // exact equality would reject a perfectly normal term and quote the
      // $120 list price the paid term disproves.
      scheduledRows: [
        { id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120, annual_prepay_term_id: 't1', prepaid_amount: 113.75, prepaid_method: 'annual_prepay_invoice' },
        { id: 'p2', service_type: 'pest_control', scheduled_date: '2099-04-05', estimated_price: 120, annual_prepay_term_id: 't1', prepaid_amount: 113.75, prepaid_method: 'annual_prepay_invoice' },
        { id: 'p3', service_type: 'pest_control', scheduled_date: '2099-07-05', estimated_price: 120, annual_prepay_term_id: 't1', prepaid_amount: 113.75, prepaid_method: 'annual_prepay_invoice' },
        { id: 'p4', service_type: 'pest_control', scheduled_date: '2099-10-05', estimated_price: 120, annual_prepay_term_id: 't1', prepaid_amount: 113.76, prepaid_method: 'annual_prepay_invoice' },
      ],
      catalogRows: [{ id: 'p1', frequency: 'quarterly', visits_per_year: 4 }],
      prepaidTerms: [{ id: 't1', prepay_amount: 455.01, coverage_visit_count: 4 }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    // $455.01 / 4 = $113.7525 → $113.75 to the cent.
    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      currentPerVisit: 113.75,
      spendSource: 'prepaid_allocation',
    }));
  });

  test('a fully prepaid contract with unrelatable allocations withholds rather than showing list price', async () => {
    const database = fakeDb({
      // Not a split remainder — two genuinely different allocations. Averaging
      // would invent a figure nobody paid, and the list price is disproven by
      // the active term, so the honest answer is nothing.
      scheduledRows: [
        { id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120, annual_prepay_term_id: 't1', prepaid_amount: 90, prepaid_method: 'annual_prepay_invoice' },
        { id: 'p2', service_type: 'pest_control', scheduled_date: '2099-04-05', estimated_price: 120, annual_prepay_term_id: 't2', prepaid_amount: 140, prepaid_method: 'annual_prepay_invoice' },
      ],
      catalogRows: [{ id: 'p1', frequency: 'quarterly', visits_per_year: 4 }],
      prepaidTerms: [
        { id: 't1', prepay_amount: 360, coverage_visit_count: 4 },
        { id: 't2', prepay_amount: 560, coverage_visit_count: 4 },
      ],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      currentPerVisit: null,
      spendSource: 'unavailable',
    }));
  });

  test('a partly-completed prepaid term still quotes the whole term\'s per-application figure', async () => {
    const database = fakeDb({
      // A 4-visit $455.03 term allocates 113.75/113.75/113.75/113.78. Two
      // visits have COMPLETED, so they're filtered out of the active rows and
      // only the remainder-loaded tail survives. Deriving the figure from
      // those rows gave $113.78 (or withheld on the spread); the term itself
      // says $455.03 / 4 = $113.7575 → $113.76.
      scheduledRows: [
        { id: 'p3', service_type: 'pest_control', scheduled_date: '2099-07-05', estimated_price: 120, annual_prepay_term_id: 't1', prepaid_amount: 113.75, prepaid_method: 'annual_prepay_invoice' },
        { id: 'p4', service_type: 'pest_control', scheduled_date: '2099-10-05', estimated_price: 120, annual_prepay_term_id: 't1', prepaid_amount: 113.78, prepaid_method: 'annual_prepay_invoice' },
      ],
      catalogRows: [{ id: 'p3', frequency: 'quarterly', visits_per_year: 4 }],
      prepaidTerms: [{ id: 't1', prepay_amount: 455.03, coverage_visit_count: 4 }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      currentPerVisit: 113.76,
      spendSource: 'prepaid_allocation',
    }));
  });

  test('cancelled prepay coverage bills at the scheduled price again, not the term figure', async () => {
    const database = fakeDb({
      // A voided/refunded/disputed prepay: clearPrepaidStampsForTerm nulls the
      // per-visit stamps so these visits bill normally, but keeps
      // annual_prepay_term_id for audit. The term row still exists and still
      // has its original amount — keying on the link alone would keep quoting
      // $114 for visits that will now bill $120.
      scheduledRows: [
        { id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120, annual_prepay_term_id: 't1', prepaid_amount: null },
        { id: 'p2', service_type: 'pest_control', scheduled_date: '2099-04-05', estimated_price: 120, annual_prepay_term_id: 't1', prepaid_amount: null },
      ],
      catalogRows: [{ id: 'p1', frequency: 'quarterly', visits_per_year: 4 }],
      prepaidTerms: [{ id: 't1', prepay_amount: 456, coverage_visit_count: 4 }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      currentPerVisit: 120,
      spendSource: 'scheduled_estimate',
    }));
  });

  test('an independently prepaid visit is not treated as annual-term coverage', async () => {
    const database = fakeDb({
      // applyPrepaidCoverageForTerm PRESERVES an out-of-band cash/Zelle stamp
      // while attachScheduledServices may still have linked the row to the
      // term. A positive amount plus a term link is therefore not proof the
      // annual term paid for it — the METHOD is.
      scheduledRows: [
        { id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120, annual_prepay_term_id: 't1', prepaid_amount: 60, prepaid_method: 'cash' },
        { id: 'p2', service_type: 'pest_control', scheduled_date: '2099-04-05', estimated_price: 120, annual_prepay_term_id: 't1', prepaid_amount: 60, prepaid_method: 'cash' },
      ],
      catalogRows: [{ id: 'p1', frequency: 'quarterly', visits_per_year: 4 }],
      prepaidTerms: [{ id: 't1', prepay_amount: 456, coverage_visit_count: 4 }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    // NOT $114 (456/4) — that term did not pay for these visits.
    expect(spend.currentServices[0].currentPerVisit).not.toBe(114);
    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      currentPerVisit: 120,
      spendSource: 'scheduled_estimate',
    }));
  });

  test('after a cancelled prepay the scheduled price outranks the older invoice', async () => {
    const database = fakeDb({
      // Stamps cleared by clearPrepaidStampsForTerm, audit link retained.
      scheduledRows: [
        { id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120, annual_prepay_term_id: 't1', prepaid_amount: null },
        { id: 'p2', service_type: 'pest_control', scheduled_date: '2099-04-05', estimated_price: 120, annual_prepay_term_id: 't1', prepaid_amount: null },
      ],
      // Paid per-visit BEFORE the prepay. Two arrangements ago — these visits
      // will bill their $120 scheduled price now.
      paidInvoices: [{ service_type: 'pest_control', total: 100, paid_at: '2026-01-10' }],
      catalogRows: [{ id: 'p1', frequency: 'quarterly', visits_per_year: 4 }],
      prepaidTerms: [{ id: 't1', prepay_amount: 456, coverage_visit_count: 4 }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      currentPerVisit: 120,
      spendSource: 'scheduled_estimate',
      lastPaidAt: null,
    }));
  });

  test('a stamp whose term is no longer in the covered set bills the scheduled price', async () => {
    const database = fakeDb({
      scheduledRows: [
        { id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120, annual_prepay_term_id: 't-missing', prepaid_amount: 114, prepaid_method: 'annual_prepay_invoice' },
      ],
      catalogRows: [{ id: 'p1', frequency: 'quarterly', visits_per_year: 4 }],
      // Absent from coveredTermsAsOf = coverage is not live. That is a
      // DEFINITE answer: the visit bills its scheduled price.
      prepaidTerms: [],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      currentPerVisit: 120,
      spendSource: 'scheduled_estimate',
    }));
  });

  test('a stamp left on a RETYPED appointment is not treated as term coverage', async () => {
    const database = fakeDb({
      // Coverage-selection cleanup is best-effort, so an appointment retyped
      // out of the term's coverage keeps its stamp. Completion billing rejects
      // that coverage via serviceMatchesCoverage; the panel must too, or it
      // divides the pest term's amount under Lawn Care.
      scheduledRows: [
        { id: 'l1', service_type: 'lawn_care', scheduled_date: '2099-01-05', estimated_price: 80, annual_prepay_term_id: 't1', prepaid_amount: 114, prepaid_method: 'annual_prepay_invoice' },
      ],
      catalogRows: [{ id: 'l1', frequency: 'quarterly', visits_per_year: 4 }],
      prepaidTerms: [{
        id: 't1', prepay_amount: 456, coverage_visit_count: 4,
        customer_id: 'cust-1', coverage_service_type: 'Pest Control',
      }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.currentServices[0].currentPerVisit).not.toBe(114);
    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      currentPerVisit: 80,
      spendSource: 'scheduled_estimate',
    }));
  });

  test("a stamp pointing at another customer's term is not treated as coverage", async () => {
    const database = fakeDb({
      scheduledRows: [
        { id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120, annual_prepay_term_id: 't1', prepaid_amount: 114, prepaid_method: 'annual_prepay_invoice' },
      ],
      catalogRows: [{ id: 'p1', frequency: 'quarterly', visits_per_year: 4 }],
      prepaidTerms: [{
        id: 't1', prepay_amount: 456, coverage_visit_count: 4,
        customer_id: 'someone-else', coverage_service_type: 'Pest Control',
      }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      currentPerVisit: 120,
      spendSource: 'scheduled_estimate',
    }));
  });

  test('a FAILED coverage lookup withholds instead of assuming the prepay lapsed', async () => {
    const database = fakeDb({
      scheduledRows: [
        { id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120, annual_prepay_term_id: 't1', prepaid_amount: 114, prepaid_method: 'annual_prepay_invoice' },
      ],
      catalogRows: [{ id: 'p1', frequency: 'quarterly', visits_per_year: 4 }],
      prepaidTerms: [{ id: 't1', prepay_amount: 456, coverage_visit_count: 4 }],
      // "Not in the covered set" and "the query failed" mean opposite things —
      // a customer who may still be prepaid must not be quoted $120 on a guess.
      prepaidTermsQueryThrows: true,
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      currentPerVisit: null,
      spendSource: 'unavailable',
    }));
  });

  test('seasonal Feb–Oct resolves through the shared cadence helper', async () => {
    const database = fakeDb({
      customer: memberWith({ monthly_rate: 90 }),
      scheduledRows: [{ id: 'm1', service_type: 'mosquito', scheduled_date: '2099-03-05' }],
      // The coverage vocabulary drops seasonal_feb_oct; the shared helper
      // knows it is 9 visits.
      catalogRows: [{
        id: 'm1', recurring_pattern: 'seasonal_feb_oct',
        frequency: 'monthly', visits_per_year: 12,
      }],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      cadenceLabel: 'Seasonal (Feb–Oct)',
      visitsPerYear: 9,
      currentPerVisit: 120,
    }));
  });

  test('an unaverageable prepaid contract withholds even when an older invoice exists', async () => {
    const database = fakeDb({
      scheduledRows: [
        { id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120, annual_prepay_term_id: 't1', prepaid_amount: 90, prepaid_method: 'annual_prepay_invoice' },
        { id: 'p2', service_type: 'pest_control', scheduled_date: '2099-04-05', estimated_price: 120, annual_prepay_term_id: 't2', prepaid_amount: 140, prepaid_method: 'annual_prepay_invoice' },
      ],
      // The r7 fix suppressed only the scheduled price, so this superseded
      // per-visit invoice still surfaced. A paid term disproves it too.
      paidInvoices: [{ service_type: 'pest_control', total: 120, paid_at: '2026-01-10' }],
      catalogRows: [{ id: 'p1', frequency: 'quarterly', visits_per_year: 4 }],
      prepaidTerms: [
        { id: 't1', prepay_amount: 360, coverage_visit_count: 4 },
        { id: 't2', prepay_amount: 560, coverage_visit_count: 4 },
      ],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      currentPerVisit: null,
      spendSource: 'unavailable',
    }));
  });

  test('two different prepaid terms are never averaged together', async () => {
    const database = fakeDb({
      // $100.00 and $100.02 sit within the old count-based tolerance, but a
      // TWO-visit splitCoverageAmount series can differ by at most one cent —
      // and these are two distinct terms, so the $100.01 average is invented.
      scheduledRows: [
        { id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120, annual_prepay_term_id: 't1', prepaid_amount: 100, prepaid_method: 'annual_prepay_invoice' },
        { id: 'p2', service_type: 'pest_control', scheduled_date: '2099-04-05', estimated_price: 120, annual_prepay_term_id: 't2', prepaid_amount: 100.02, prepaid_method: 'annual_prepay_invoice' },
      ],
      catalogRows: [{ id: 'p1', frequency: 'quarterly', visits_per_year: 4 }],
      prepaidTerms: [
        { id: 't1', prepay_amount: 400, coverage_visit_count: 4 },
        { id: 't2', prepay_amount: 400.08, coverage_visit_count: 4 },
      ],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.currentServices[0].currentPerVisit).toBeNull();
    expect(spend.currentServices[0].spendSource).toBe('unavailable');
  });

  test('a cadence lookup failure leaves the label out instead of breaking the panel', async () => {
    // No catalogRows — the builder has no leftJoin, so the cadence loader
    // throws exactly as it does against a database without the services table.
    const database = fakeDb({
      scheduledRows: [
        { id: 'p1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120 },
      ],
    });

    const spend = await loadCurrentServiceSpendContext(database, 'cust-1');

    expect(spend.currentServices[0]).toEqual(expect.objectContaining({
      currentPerVisit: 120,
      cadenceLabel: null,
      visitsPerYear: null,
      spendSource: 'scheduled_estimate',
    }));
  });
});

describe('existing-service tier extension snapshot', () => {
  afterEach(() => { mockExtendExistingGate = false; });

  test('gate off: a tier-raising estimate freezes an EMPTY extension list', async () => {
    const database = fakeDb({
      scheduledRows: futurePestRows(),
      paidInvoices: [{ service_type: 'pest_control', total: 117, paid_at: '2026-05-20' }],
    });
    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
    });
    expect(ctx.upgrade).toMatchObject({ fromLabel: 'Bronze', toLabel: 'Silver' });
    expect(ctx.existingServices).toEqual([]);
    expect(ctx.discountAppliesTo).toBe('new_services_only');
  });

  test('gate on: Bronze→Silver lawn add-on lists existing pest at the delta rate with its upcoming visits', async () => {
    mockExtendExistingGate = true;
    const database = fakeDb({
      scheduledRows: futurePestRows(),
      paidInvoices: [{ service_type: 'pest_control', total: 117, paid_at: '2026-05-20' }],
    });
    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
    });
    // Basis is the ROW scheduled price (120), NOT the last-paid invoice
    // (117) — the accept-time frozen-price check verifies against the row,
    // so an invoice-derived figure would park as drift on arrival (codex
    // #3338 r13).
    expect(ctx.existingServices).toEqual([expect.objectContaining({
      key: 'pest_control',
      label: 'Pest Control',
      currentPerVisit: 120,
      extraDiscountPct: 10,
      perVisitSavings: 12,
      newPerVisit: 108,
      remainingVisits: 3,
      upcomingVisitDates: ['2099-01-05', '2099-04-05', '2099-07-05'],
      // Frozen appointment identities the accept-time apply pins to
      // (codex #3338 r10) — staff-side only.
      rowIds: ['s1', 's2', 's3'],
      prepaid: false,
    })]);
    expect(ctx.discountAppliesTo).toBe('new_and_existing_services');
  });

  test('gate on: an annual-prepay family displays the PAID allocation as its basis (accept credits, never reprices)', async () => {
    mockExtendExistingGate = true;
    const database = fakeDb({
      scheduledRows: futurePestRows().map((row) => ({
        ...row, annual_prepay_term_id: 'term-1', prepaid_amount: 100,
      })),
      paidInvoices: [{ service_type: 'pest_control', total: 117, paid_at: '2026-05-20' }],
    });
    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
    });
    // Basis is the PAID allocation (100), never the list row price (120):
    // the accept-time credit rides the allocation, so a list-price
    // strikethrough would advertise a larger figure than the ledger
    // movement (codex #3338 r23 sibling).
    expect(ctx.existingServices[0]).toMatchObject({
      key: 'pest_control',
      prepaid: true,
      currentPerVisit: 100,
      newPerVisit: 90,
      perVisitSavings: 10,
    });
  });

  test('gate on: mixed prepaid/pay-per-visit and uneven-allocation families stay on the review path', async () => {
    mockExtendExistingGate = true;
    // One figure cannot honestly cover a family whose applications are paid
    // two different ways (or at two different allocations).
    const mixed = fakeDb({
      scheduledRows: [
        {
          id: 's1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120, annual_prepay_term_id: 'term-1', prepaid_amount: 100,
        },
        {
          id: 's2', service_type: 'pest_control', scheduled_date: '2099-04-05', estimated_price: 120,
        },
      ],
      paidInvoices: [],
    });
    const mixedCtx = await computeMembershipContext(mixed, { customerId: 'cust-1', freezeExtensionPlan: true, estData: lawnEstimateData() });
    expect(mixedCtx.existingServices).toEqual([]);
    const uneven = fakeDb({
      scheduledRows: [
        {
          id: 's1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120, annual_prepay_term_id: 'term-1', prepaid_amount: 100,
        },
        {
          id: 's2', service_type: 'pest_control', scheduled_date: '2099-04-05', estimated_price: 120, annual_prepay_term_id: 'term-1', prepaid_amount: 95,
        },
      ],
      paidInvoices: [],
    });
    const unevenCtx = await computeMembershipContext(uneven, { customerId: 'cust-1', freezeExtensionPlan: true, estData: lawnEstimateData() });
    expect(unevenCtx.existingServices).toEqual([]);
  });

  test('gate on: one-cent basis differences are different bases (exact cents)', async () => {
    mockExtendExistingGate = true;
    // Split-remainder prepaid term ($16.75 + $16.76): one shared frozen
    // savings would be a cent off on the remainder application (codex
    // #3338 r9) — not uniform, review path.
    const remainder = fakeDb({
      scheduledRows: [
        {
          id: 's1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 20, annual_prepay_term_id: 'term-1', prepaid_amount: 16.75,
        },
        {
          id: 's2', service_type: 'pest_control', scheduled_date: '2099-04-05', estimated_price: 20, annual_prepay_term_id: 'term-1', prepaid_amount: 16.76,
        },
      ],
      paidInvoices: [],
    });
    const remainderCtx = await computeMembershipContext(remainder, { customerId: 'cust-1', freezeExtensionPlan: true, estData: lawnEstimateData() });
    expect(remainderCtx.existingServices).toEqual([]);
    // Same rule on the pay-per-visit basis: a $120.01 sibling is NOT the
    // $120 basis and stays off the frozen plan.
    const centOff = fakeDb({
      scheduledRows: [
        { id: 's1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120 },
        { id: 's2', service_type: 'pest_control', scheduled_date: '2099-04-05', estimated_price: 120.01 },
      ],
      paidInvoices: [],
    });
    const centCtx = await computeMembershipContext(centOff, { customerId: 'cust-1', freezeExtensionPlan: true, estData: lawnEstimateData() });
    expect(centCtx.existingServices[0]).toMatchObject({ rowIds: ['s1'], remainingVisits: 1 });
  });

  test('gate on: the basis is the NEXT upcoming appointment price regardless of DB row order', async () => {
    mockExtendExistingGate = true;
    // Mixed-price family delivered in an order that puts the LATER $120
    // cohort first: the basis must still be the earliest appointment's
    // $135 (codex #3338 r10 — cohort selection must never follow DB row
    // order, or the same unchanged estimate freezes a different plan per
    // save).
    const database = fakeDb({
      scheduledRows: [
        { id: 's2', service_type: 'pest_control', scheduled_date: '2099-04-05', estimated_price: 120 },
        { id: 's3', service_type: 'pest_control', scheduled_date: '2099-07-05', estimated_price: 120 },
        { id: 's1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 135 },
      ],
      paidInvoices: [],
    });
    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
    });
    expect(ctx.existingServices[0]).toMatchObject({
      currentPerVisit: 135,
      rowIds: ['s1'],
      upcomingVisitDates: ['2099-01-05'],
      remainingVisits: 1,
    });
  });

  test('gate on: a visit with add-ons is excluded from the frozen plan; probe failure parks the family', async () => {
    mockExtendExistingGate = true;
    const withAddon = fakeDb({
      scheduledRows: futurePestRows(),
      paidInvoices: [],
      addonRows: [{ scheduled_service_id: 's2' }],
    });
    const ctx = await computeMembershipContext(withAddon, { customerId: 'cust-1', freezeExtensionPlan: true, estData: lawnEstimateData() });
    // s2 nets primary + add-ons into one estimated_price — discounting it
    // would discount the non-qualifying add-ons too (codex #3338 r24). The
    // clean siblings still freeze.
    expect(ctx.existingServices[0]).toMatchObject({
      rowIds: ['s1', 's3'],
      upcomingVisitDates: ['2099-01-05', '2099-07-05'],
      remainingVisits: 2,
    });
    const probeDown = fakeDb({
      scheduledRows: futurePestRows(),
      paidInvoices: [],
      addonQueryThrows: true,
    });
    const parked = await computeMembershipContext(probeDown, { customerId: 'cust-1', freezeExtensionPlan: true, estData: lawnEstimateData() });
    // FAIL CLOSED: cannot verify add-ons → the family stays on the
    // review-bell path rather than advertising a visit the apply may park.
    expect(parked.existingServices).toEqual([]);
  });

  test('gate on: a visit with a pre-minted invoice is excluded from the frozen plan (accept would park it)', async () => {
    mockExtendExistingGate = true;
    // Charge Now / pre-completion mints exist at save time and are
    // knowable — the card must not promise a visit the apply parks
    // (codex #3338 r7).
    const withMint = fakeDb({
      scheduledRows: futurePestRows(),
      paidInvoices: [],
      mintedInvoiceLinks: ['s1'],
    });
    const ctx = await computeMembershipContext(withMint, { customerId: 'cust-1', freezeExtensionPlan: true, estData: lawnEstimateData() });
    expect(ctx.existingServices[0]).toMatchObject({
      rowIds: ['s2', 's3'],
      upcomingVisitDates: ['2099-04-05', '2099-07-05'],
      remainingVisits: 2,
    });
    const probeDown = fakeDb({
      scheduledRows: futurePestRows(),
      paidInvoices: [],
      mintedProbeThrows: true,
    });
    const parked = await computeMembershipContext(probeDown, { customerId: 'cust-1', freezeExtensionPlan: true, estData: lawnEstimateData() });
    expect(parked.existingServices).toEqual([]);
  });

  test('no property-scope opt-in (agent lanes): gate on still freezes NO extension plan', async () => {
    mockExtendExistingGate = true;
    const database = fakeDb({
      scheduledRows: futurePestRows(),
      paidInvoices: [{ service_type: 'pest_control', total: 117, paid_at: '2026-05-20' }],
    });
    // IB estimate tools and the estimator engine pass no property scope —
    // a secondary-property agent estimate must never freeze (or later
    // reprice) another property's visits (codex #3338 r7). Tier/upgrade
    // context stays intact; only the frozen plan is withheld.
    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      estData: lawnEstimateData(),
    });
    expect(ctx.upgrade).toMatchObject({ fromLabel: 'Bronze', toLabel: 'Silver' });
    expect(ctx.existingServices).toEqual([]);
    expect(ctx.discountAppliesTo).toBe('new_services_only');
  });

  test('primary-lane plan scoping: a series stamped at another property never freezes; tier context stays account-wide', async () => {
    mockExtendExistingGate = true;
    const { normalizedStampedStreet } = require('../services/estimate-property-linkage');
    const primaryKey = normalizedStampedStreet('123 Main St', null, 'Venice', '34285');
    // Pest series stamped at the customer's SECONDARY property while the
    // estimate quotes the primary street (codex #3338 r8): the primary
    // lane's priors pricing is account-wide, so the tier context must keep
    // matching it — but the frozen plan must not cover the other
    // property's visits.
    const database = fakeDb({
      scheduledRows: futurePestRows().map((row) => ({
        ...row,
        service_address_line1: '999 Other Ave',
        service_address_city: 'Venice',
        service_address_zip: '34285',
      })),
      paidInvoices: [],
    });
    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
      extensionStreetScope: { estimateStreet: primaryKey, customerPrimaryStreet: primaryKey },
    });
    expect(ctx.upgrade).toMatchObject({ fromLabel: 'Bronze', toLabel: 'Silver' });
    expect(ctx.existingServices).toEqual([]);
    expect(ctx.discountAppliesTo).toBe('new_services_only');
    // Control: the same series stamped AT the quoted street freezes.
    const atQuoted = fakeDb({
      scheduledRows: futurePestRows().map((row) => ({
        ...row,
        service_address_line1: '123 Main St',
        service_address_city: 'Venice',
        service_address_zip: '34285',
      })),
      paidInvoices: [],
    });
    const scoped = await computeMembershipContext(atQuoted, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
      extensionStreetScope: { estimateStreet: primaryKey, customerPrimaryStreet: primaryKey },
    });
    expect(scoped.existingServices).toHaveLength(1);
    expect(scoped.existingServices[0].rowIds).toEqual(['s1', 's2', 's3']);
  });

  test('gate on: a family this estimate re-quotes is never listed as an extension too', async () => {
    mockExtendExistingGate = true;
    const database = fakeDb({
      scheduledRows: futurePestRows(),
      paidInvoices: [{ service_type: 'pest_control', total: 117, paid_at: '2026-05-20' }],
    });
    // The estimate itself re-quotes pest AND adds lawn: combined Silver, but
    // the pest family is a priced line of the estimate, not an extension.
    const estData = {
      result: {
        results: { lawn: [{ v: 9, recommended: true }] },
        recurring: {
          discount: 0.10,
          annualBeforeDiscount: 1400,
          annualAfterDiscount: 1260,
          services: [
            { name: 'Pest Control', mo: 47 },
            { name: 'Lawn Care', mo: 69.75 },
          ],
        },
      },
    };
    const ctx = await computeMembershipContext(database, { customerId: 'cust-1', freezeExtensionPlan: true, estData });
    expect(ctx.existingServices).toEqual([]);
    expect(ctx.discountAppliesTo).toBe('new_services_only');
  });

  test('gate on: an above-Bronze origin stays on the review path (delta math would not equal the tier rate)', async () => {
    mockExtendExistingGate = true;
    const database = fakeDb({
      // Existing pest + lawn → current tier Silver (10% already contracted).
      scheduledRows: [
        ...futurePestRows(),
        { id: 'l1', service_type: 'lawn_care', scheduled_date: '2099-02-01', estimated_price: 80 },
      ],
      paidInvoices: [],
    });
    // Adding mosquito raises Silver → Gold, but the extension only freezes
    // Bronze-origin upgrades (codex #3338 r3).
    const estData = {
      result: {
        recurring: {
          discount: 0.15,
          annualBeforeDiscount: 500,
          annualAfterDiscount: 425,
          services: [{ name: 'Mosquito Treatment', mo: 41.67 }],
        },
      },
    };
    const ctx = await computeMembershipContext(database, { customerId: 'cust-1', freezeExtensionPlan: true, estData });
    expect(ctx.upgrade).toMatchObject({ fromLabel: 'Silver', toLabel: 'Gold' });
    expect(ctx.existingServices).toEqual([]);
    expect(ctx.discountAppliesTo).toBe('new_services_only');
  });

  test('gate on: a monthly-lane member stays on the review path (row repricing never touches monthly_rate)', async () => {
    mockExtendExistingGate = true;
    const database = fakeDb({
      customer: {
        id: 'cust-1', first_name: 'Don', active: true, waveguard_tier: 'Bronze',
        pipeline_stage: 'active_customer', monthly_rate: 55, billing_mode: null,
      },
      scheduledRows: futurePestRows(),
      paidInvoices: [{ service_type: 'pest_control', total: 117, paid_at: '2026-05-20' }],
    });
    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
    });
    expect(ctx.upgrade).toMatchObject({ fromLabel: 'Bronze', toLabel: 'Silver' });
    expect(ctx.existingServices).toEqual([]);
  });

  test('gate on: callback visits never appear in the frozen appointment list', async () => {
    mockExtendExistingGate = true;
    const database = fakeDb({
      scheduledRows: [
        ...futurePestRows(),
        { id: 'cb', service_type: 'pest_control', scheduled_date: '2099-02-14', estimated_price: 0, is_callback: true },
      ],
      paidInvoices: [{ service_type: 'pest_control', total: 117, paid_at: '2026-05-20' }],
    });
    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
    });
    // The accept-time reprice excludes callbacks, so the displayed list
    // must too (codex #3338 r7).
    expect(ctx.existingServices[0].upcomingVisitDates).toEqual(['2099-01-05', '2099-04-05', '2099-07-05']);
  });

  test('gate flipped off after freezing: the projection stops exposing the frozen extension', async () => {
    mockExtendExistingGate = true;
    const database = fakeDb({
      scheduledRows: futurePestRows(),
      paidInvoices: [{ service_type: 'pest_control', total: 117, paid_at: '2026-05-20' }],
    });
    const snapshot = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
    });
    expect(snapshot.existingServices).toHaveLength(1);
    // Kill switch flips off with the frozen plan already saved: display
    // must go dormant with the accept-side apply (codex #3338 r1) — and
    // the SSR copy discriminator must fall back with it (codex #3338 r8),
    // or the legacy upgrade blurb keeps promising existing-service
    // coverage the accept side won't deliver.
    mockExtendExistingGate = false;
    const view = publicMembershipView(snapshot);
    expect(view.existingServices).toEqual([]);
    expect(view.discountAppliesTo).toBe('new_services_only');
    // COMMITTED estimates follow the persisted OUTCOME, not the gate
    // (codex #3338 r19): only an extension that actually APPLIED keeps its
    // permanent record — an accept whose plan parked moved no money and
    // must not read as repriced, and legacy accepted rows (no outcome)
    // project nothing.
    const appliedSnapshot = {
      ...snapshot,
      extensionOutcome: {
        applied: true, repricedRowCount: 3, creditAmount: 0, appliedFamilies: ['pest_control'],
      },
    };
    const committedApplied = publicMembershipView(appliedSnapshot, { committed: true });
    expect(committedApplied.existingServices).toHaveLength(1);
    expect(committedApplied.discountAppliesTo).toBe('new_and_existing_services');
    const committedParked = publicMembershipView(
      { ...snapshot, extensionOutcome: { applied: false, reviewFamilies: ['Pest Control'] } },
      { committed: true },
    );
    expect(committedParked.existingServices).toEqual([]);
    expect(committedParked.discountAppliesTo).toBe('new_services_only');
    const committedLegacy = publicMembershipView(snapshot, { committed: true });
    expect(committedLegacy.existingServices).toEqual([]);
    // Partial application (codex #3338 r26): applied=true only says SOME
    // money moved — the committed recap projects ONLY the families the
    // apply honored in full, and an applied outcome carrying no
    // appliedFamilies list projects nothing (fail closed; no legacy
    // applied outcomes exist — the gate has never shipped on).
    const twoFamilySnapshot = {
      ...snapshot,
      existingServices: [
        ...snapshot.existingServices,
        { ...snapshot.existingServices[0], key: 'mosquito', label: 'Mosquito Protection' },
      ],
    };
    const committedPartial = publicMembershipView(
      {
        ...twoFamilySnapshot,
        extensionOutcome: { applied: true, repricedRowCount: 3, appliedFamilies: ['pest_control'] },
      },
      { committed: true },
    );
    expect(committedPartial.existingServices).toHaveLength(1);
    expect(committedPartial.existingServices[0].key).toBe('pest_control');
    expect(committedPartial.discountAppliesTo).toBe('new_and_existing_services');
    const committedNoFamilyList = publicMembershipView(
      { ...snapshot, extensionOutcome: { applied: true, repricedRowCount: 3 } },
      { committed: true },
    );
    expect(committedNoFamilyList.existingServices).toEqual([]);
    expect(committedNoFamilyList.discountAppliesTo).toBe('new_services_only');
  });

  test('per-property scope: excluded existing rows price the estimate as standalone (grouped street unparsable)', async () => {
    mockExtendExistingGate = true;
    const database = fakeDb({
      scheduledRows: futurePestRows(),
      paidInvoices: [],
    });
    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
      excludeExistingRows: true,
    });
    // Mirrors the reprice branch that priced with no priors (codex #3338
    // r22): the snapshot must not advertise another property's plans.
    expect(ctx.isExistingCustomer).toBe(false);
    expect(ctx.existingServices).toEqual([]);
  });

  test('per-property scope: a street scope matching no rows freezes no extension', async () => {
    mockExtendExistingGate = true;
    const database = fakeDb({
      scheduledRows: futurePestRows(),
      paidInvoices: [],
    });
    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
      // Unstamped rows resolve via the customer's primary street; an empty
      // primary street can never match the quoted street, so every account
      // row is excluded from this property's snapshot.
      streetScope: { estimateStreet: '999 elsewhere ave, venice, 34285', customerPrimaryStreet: '' },
    });
    expect(ctx.isExistingCustomer).toBe(false);
    expect(ctx.existingServices).toEqual([]);
  });

  test('gate on: a mixed-price contract freezes only the appointments sharing the displayed basis', async () => {
    mockExtendExistingGate = true;
    const database = fakeDb({
      scheduledRows: [
        { id: 's1', service_type: 'pest_control', scheduled_date: '2099-01-05', estimated_price: 120 },
        { id: 's2', service_type: 'pest_control', scheduled_date: '2099-04-05', estimated_price: 120 },
        // Drifted and unpriced siblings must not be LISTED as covered —
        // accept would skip them (codex #3338 r19 sibling).
        { id: 's3', service_type: 'pest_control', scheduled_date: '2099-07-05', estimated_price: 135 },
        { id: 's4', service_type: 'pest_control', scheduled_date: '2099-10-05', estimated_price: null },
      ],
      paidInvoices: [],
    });
    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
    });
    expect(ctx.existingServices[0]).toMatchObject({
      currentPerVisit: 120,
      newPerVisit: 108,
      remainingVisits: 2,
      upcomingVisitDates: ['2099-01-05', '2099-04-05'],
      rowIds: ['s1', 's2'],
    });
  });

  test('gate on: no tier change means no extension rows', async () => {
    mockExtendExistingGate = true;
    const database = fakeDb({
      // Existing pest + lawn already → Silver; adding the same families
      // re-quotes, no upgrade.
      scheduledRows: [
        ...futurePestRows(),
        { id: 'l1', service_type: 'lawn_care', scheduled_date: '2099-02-01', estimated_price: 80 },
      ],
      paidInvoices: [],
    });
    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
    });
    expect(ctx.upgrade).toBeNull();
    expect(ctx.existingServices).toEqual([]);
  });

  test('publicMembershipView deliberately projects the extension prices and dates — and nothing else new', async () => {
    mockExtendExistingGate = true;
    const database = fakeDb({
      scheduledRows: futurePestRows(),
      paidInvoices: [{ service_type: 'pest_control', total: 117, paid_at: '2026-05-20' }],
    });
    const snapshot = await computeMembershipContext(database, {
      customerId: 'cust-1',
      freezeExtensionPlan: true,
      estData: lawnEstimateData(),
    });
    const view = publicMembershipView(snapshot);
    expect(view.existingServices).toEqual([{
      key: 'pest_control',
      label: 'Pest Control',
      currentPerVisit: 120,
      newPerVisit: 108,
      extraDiscountPct: 10,
      perVisitSavings: 12,
      remainingVisits: 3,
      upcomingVisitDates: ['2099-01-05', '2099-04-05', '2099-07-05'],
      prepaid: false,
    }]);
    // The staff account context stays server-side even with the extension on.
    const json = JSON.stringify(view);
    for (const staffMarker of [
      'currentServices', 'currentSpendPerVisitTotal', 'serviceAddress', 'contracts',
      'lastPaidAt', 'scheduledPerVisit', 'spendSource', 'nextScheduledDate',
    ]) {
      expect(json).not.toContain(staffMarker);
    }
  });
});

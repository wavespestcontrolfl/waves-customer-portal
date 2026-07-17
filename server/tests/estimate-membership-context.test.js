// computeMembershipContext — existing-customer membership snapshot math.
// Covers the per-visit savings basis (last PAID invoice amount preferred,
// scheduled estimated_price fallback) and the new-service per-application
// savings figure shown on the public estimate.

const {
  computeMembershipContext,
  loadCurrentServiceSpendContext,
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
} = {}) {
  const db = (table) => {
    const builder = {
      where: () => builder,
      whereIn: () => builder,
      whereNotIn: () => builder,
      whereNotNull: () => builder,
      andWhere: () => builder,
      orderBy: () => builder,
      limit: () => builder,
      columnInfo: async () => ({ is_recurring: {}, estimated_price: {}, annual_prepay_term_id: {} }),
      first: async () => {
        if (table === 'customers') return customer;
        if (table === 'annual_prepay_terms') return prepaidTerm;
        return null;
      },
      select: async () => {
        if (table === 'scheduled_services') return scheduledRows;
        if (table === 'invoices') {
          if (invoiceQueryThrows) throw new Error('relation does not exist');
          return paidInvoices;
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
      estData: lawnEstimateData(),
    });

    expect(ctx).toMatchObject({ isExistingCustomer: false });
    expect(ctx.existingServiceKeys).toEqual([]);
  });

  test('falls back to scheduled estimated_price when there is no paid history', async () => {
    const database = fakeDb({ scheduledRows: futurePestRows(), paidInvoices: [] });

    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      estData: lawnEstimateData(),
    });

    expect(ctx.currentServices[0]).toMatchObject({ currentPerVisit: 120, spendSource: 'scheduled_estimate' });
  });

  test('invoice lookup failure degrades to the estimated_price fallback, not an error', async () => {
    const database = fakeDb({ scheduledRows: futurePestRows(), invoiceQueryThrows: true });

    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
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
      estData: lawnEstimateData(),
    });

    expect(ctx.currentServices[0]).toMatchObject({ currentPerVisit: 117 });
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
      estData: lawnEstimateData(),
    });

    expect(ctx.currentServices[0]).toMatchObject({ currentPerVisit: 117 });
  });
});

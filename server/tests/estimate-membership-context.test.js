// computeMembershipContext — existing-customer membership snapshot math.
// Covers the per-visit savings basis (last PAID invoice amount preferred,
// scheduled estimated_price fallback) and the new-service per-application
// savings figure shown on the public estimate.

const { computeMembershipContext } = require('../services/estimate-membership-context');

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
  test('existing-service per-visit savings use the last PAID invoice amount', async () => {
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
    expect(ctx.existingServices).toEqual([
      expect.objectContaining({
        key: 'pest_control',
        extraDiscountPct: 10,
        perVisitSavings: 11.70, // 10% of the $117 they last paid — not the $120 estimated_price
        remainingVisits: 3,
      }),
    ]);
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

    expect(ctx.existingServices[0]).toMatchObject({ perVisitSavings: 12.00 });
  });

  test('invoice lookup failure degrades to the estimated_price fallback, not an error', async () => {
    const database = fakeDb({ scheduledRows: futurePestRows(), invoiceQueryThrows: true });

    const ctx = await computeMembershipContext(database, {
      customerId: 'cust-1',
      estData: lawnEstimateData(),
    });

    expect(ctx).not.toBeNull();
    expect(ctx.existingServices[0]).toMatchObject({ perVisitSavings: 12.00 });
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

    expect(ctx.existingServices[0]).toMatchObject({ perVisitSavings: 11.70 });
  });

  test('discount line items reduce the last-paid per-visit basis', async () => {
    const database = fakeDb({
      scheduledRows: futurePestRows(),
      // $120 visit with a -$12 member discount row — the customer actually
      // paid $108, so savings must be based on $108, not $120.
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

    expect(ctx.existingServices[0]).toMatchObject({ perVisitSavings: 10.80 });
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

    expect(ctx.existingServices[0]).toMatchObject({ perVisitSavings: 11.70 });
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

    expect(ctx.existingServices[0]).toMatchObject({ perVisitSavings: 11.70 });
  });
});

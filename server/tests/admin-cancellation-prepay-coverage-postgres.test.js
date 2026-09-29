/**
 * Cancel plan's prepay paths against live Postgres and the REAL
 * annual-prepay-renewals module (admin-customers-cancel-plan.test.js mocks it,
 * with coverageRowsForTerm at the root, which is how both bugs below hid):
 *   - coverageRowsForTerm lived only under _private, so all three of
 *     admin-cancellation.js's root reads threw and failed closed. "End of paid
 *     coverage" always refused (409 coverage_rows_unavailable), every prepay
 *     refund went to manual calculation, and a scoped cancel on a prepay
 *     account always refused;
 *   - pg hydrates a DATE column as a Date, and String() of one reads
 *     "Mon Oct 05 …". The cancel impact compared that as text against the ISO
 *     keep-through boundary, so the preview kept no covered visit, and it
 *     ordered visits by weekday name.
 * Every row these tests insert is deleted afterwards.
 */
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

maybeDescribe('Cancel plan prepay coverage (live Postgres, real renewals module)', () => {
  let db;
  let cancellation;
  const RUN = `cpc-${Date.now()}`;
  const made = { annual_prepay_terms: [], scheduled_services: [], invoices: [], customers: [] };
  let n = 0;
  const priorGate = process.env.GATE_CANCEL_FLOW_V2;

  beforeAll(() => {
    process.env.GATE_CANCEL_FLOW_V2 = 'true';
    db = require('../models/db');
    cancellation = require('../services/admin-cancellation');
  });
  afterAll(async () => {
    if (priorGate === undefined) delete process.env.GATE_CANCEL_FLOW_V2;
    else process.env.GATE_CANCEL_FLOW_V2 = priorGate;
    for (const table of ['annual_prepay_terms', 'scheduled_services', 'invoices', 'customers']) {
      if (made[table].length) await db(table).whereIn('id', made[table]).del();
    }
    await db.destroy();
  });

  const insert = async (table, row) => {
    const [r] = await db(table).insert(row).returning('*');
    made[table].push(r.id);
    return r;
  };
  const customer = () => {
    n += 1;
    return insert('customers', { first_name: 'Cancel', last_name: `Probe ${n}`, phone: `+1555557${String(1000 + n)}`, pipeline_stage: 'active_customer', active: true });
  };
  const visit = (c, scheduledDate, over = {}) => insert('scheduled_services', {
    customer_id: c.id, scheduled_date: scheduledDate, service_type: 'General Pest Control', status: 'pending', ...over,
  });
  // A paid annual prepay term sold as four General Pest Control visits for $400:
  // one done in March, three still ahead.
  const prepayCustomer = async () => {
    const c = await customer();
    n += 1;
    const invoice = await insert('invoices', { customer_id: c.id, token: `${RUN}-${n}`, invoice_number: `${RUN}-${n}`, status: 'paid', paid_at: new Date('2026-01-02T12:00:00Z'), total: 400 });
    const term = await insert('annual_prepay_terms', { customer_id: c.id, term_start: '2026-01-01', term_end: '2026-12-31', status: 'active',
      prepay_invoice_id: invoice.id, coverage_service_type: 'General Pest Control', coverage_visit_count: 4, prepay_amount: 400 });
    const done = await visit(c, '2026-03-05', { status: 'completed', annual_prepay_term_id: term.id });
    const ahead = [];
    for (const d of ['2026-10-05', '2026-11-05', '2026-12-05']) ahead.push(await visit(c, d, { annual_prepay_term_id: term.id }));
    return { c, term, done, ahead };
  };

  test('the prepay refund counts completed coverage through the real module: four sold, one done, $300 for the three left', async () => {
    const { c, term } = await prepayCustomer();
    await expect(cancellation.computePrepayRefund({ ...term, customer_id: c.id })).resolves.toMatchObject({
      needsManualCalc: false, reason: null, includedVisits: 4, completedVisits: 1, remainingVisits: 3, amount: 300,
    });
  });

  test('an "End of paid coverage" preview keeps the covered visits and pulls only the uncovered one, with ISO dates', async () => {
    const { c } = await prepayCustomer();
    const lawn = await visit(c, '2026-10-20', { service_type: 'Lawn Care' }); // not the term's
    const preview = await cancellation.previewCancelPlan({ customerId: c.id, effectiveDate: 'end_of_coverage', prepayDisposition: 'end_at_term' });
    expect(preview).toMatchObject({ effectiveDate: 'end_of_coverage', effectiveOn: '2026-12-31' });
    expect(preview.impact.pulledVisitKeys).toEqual([`${lawn.id}:2026-10-20`]);
    expect(preview.impact.visitsCancelled).toBe(1);
    expect(preview.impact.prepay).toMatchObject({ covered: true, endsAt: '2026-12-31' });
  });

  test('an effective-now preview names the next visit by date, not by weekday name', async () => {
    const c = await customer();
    await visit(c, '2026-10-09'); // "Fri Oct 09" sorts before "Mon Oct 05" as text
    await visit(c, '2026-10-05');
    const preview = await cancellation.previewCancelPlan({ customerId: c.id });
    const pest = preview.impact.families.find((f) => f.key === 'pest_control');
    expect(pest).toMatchObject({ upcomingVisits: 2, nextVisitDate: '2026-10-05' });
    expect(preview.impact.pulledVisitKeys).toEqual(expect.arrayContaining([expect.stringMatching(/:2026-10-05$/), expect.stringMatching(/:2026-10-09$/)]));
  });

  test('a scoped cancel of another family reads the term\'s covered rows instead of refusing; one over the covered family still refuses', async () => {
    const { c } = await prepayCustomer();
    await visit(c, '2026-10-20', { service_type: 'Lawn Care' });
    const lawnOnly = await cancellation.previewCancelPlan({ customerId: c.id, families: ['lawn_care'] });
    expect(lawnOnly.scopeError).not.toBe('scoped_covers_prepaid');
    const pestOnly = await cancellation.previewCancelPlan({ customerId: c.id, families: ['pest_control'] });
    expect(pestOnly.scopeError).toBe('scoped_covers_prepaid');
  });
});

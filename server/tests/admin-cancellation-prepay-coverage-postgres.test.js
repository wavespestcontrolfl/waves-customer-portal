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
const { etDateString, addETDays } = require('../utils/datetime-et');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

// Dates relative to today (ET): the preview judges "upcoming" against the real
// clock, so fixed literals would go stale (AGENTS.md near-today rule).
const day = (offset) => etDateString(addETDays(new Date(), offset));
// The first Monday at least three days out, and the Friday after it: as text
// ("Fri …" < "Mon …") the Friday sorts first, by date the Monday does.
function mondayThenFriday() {
  for (let k = 3; k < 10; k += 1) {
    if (new Date(`${day(k)}T12:00:00Z`).getUTCDay() === 1) return [day(k), day(k + 4)];
  }
  throw new Error('no Monday within a week');
}

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
  // one done, three still ahead, the term ending in 90 days.
  const TERM_END = day(90);
  const prepayCustomer = async () => {
    const c = await customer();
    n += 1;
    const invoice = await insert('invoices', { customer_id: c.id, token: `${RUN}-${n}`, invoice_number: `${RUN}-${n}`, status: 'paid', paid_at: new Date('2026-01-02T12:00:00Z'), total: 400 });
    const term = await insert('annual_prepay_terms', { customer_id: c.id, term_start: day(-200), term_end: TERM_END, status: 'active',
      prepay_invoice_id: invoice.id, coverage_service_type: 'General Pest Control', coverage_visit_count: 4, prepay_amount: 400 });
    const done = await visit(c, day(-100), { status: 'completed', annual_prepay_term_id: term.id });
    const ahead = [];
    for (const d of [day(6), day(37), day(68)]) ahead.push(await visit(c, d, { annual_prepay_term_id: term.id }));
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
    const lawn = await visit(c, day(20), { service_type: 'Lawn Care' }); // not the term's
    const preview = await cancellation.previewCancelPlan({ customerId: c.id, effectiveDate: 'end_of_coverage', prepayDisposition: 'end_at_term' });
    expect(preview).toMatchObject({ effectiveDate: 'end_of_coverage', effectiveOn: TERM_END });
    expect(preview.impact.pulledVisitKeys).toEqual([`${lawn.id}:${day(20)}`]);
    expect(preview.impact.visitsCancelled).toBe(1);
    expect(preview.impact.prepay).toMatchObject({ covered: true, endsAt: TERM_END });
  });

  test('an effective-now preview names the next visit by date, not by weekday name', async () => {
    const c = await customer();
    const [monday, friday] = mondayThenFriday();
    await visit(c, friday);
    await visit(c, monday);
    const preview = await cancellation.previewCancelPlan({ customerId: c.id });
    const pest = preview.impact.families.find((f) => f.key === 'pest_control');
    expect(pest).toMatchObject({ upcomingVisits: 2, nextVisitDate: monday });
    expect(preview.impact.pulledVisitKeys.map((k) => k.split(':')[1]).sort()).toEqual([monday, friday]);
  });

  test('a scoped cancel of another family reads the term\'s covered rows instead of refusing; one over the covered family still refuses', async () => {
    const { c } = await prepayCustomer();
    await visit(c, day(20), { service_type: 'Lawn Care' });
    const lawnOnly = await cancellation.previewCancelPlan({ customerId: c.id, families: ['lawn_care'] });
    expect(lawnOnly.scopeError).not.toBe('scoped_covers_prepaid');
    const pestOnly = await cancellation.previewCancelPlan({ customerId: c.id, families: ['pest_control'] });
    expect(pestOnly.scopeError).toBe('scoped_covers_prepaid');
  });
});

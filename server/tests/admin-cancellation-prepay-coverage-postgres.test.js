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

// It writes customers, invoices, terms and visits, so only a disposable
// database: CI's localhost waves_test, or this worktree's own QA database.
function disposableDatabase(connection) {
  const url = new URL(connection);
  const localCi = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
  const ownedQa = process.env.WAVES_LOCAL_DEV === '1'
    && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
  return localCi || ownedQa;
}

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
    if (!disposableDatabase(process.env.DATABASE_URL)) throw new Error('Use disposable CI or this worktree\'s private QA database');
    process.env.GATE_CANCEL_FLOW_V2 = 'true';
    db = require('../models/db');
    cancellation = require('../services/admin-cancellation');
  });
  afterAll(async () => {
    if (priorGate === undefined) delete process.env.GATE_CANCEL_FLOW_V2;
    else process.env.GATE_CANCEL_FLOW_V2 = priorGate;
    if (!db) return;
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

  // An original termite annual plan anchored to its installation: one visit
  // sold, and the installation (booked under a label the monitoring coverage
  // text does not match) IS that visit, by term.installation_anchor_visit_id.
  const anchoredTermiteCustomer = async () => {
    const c = await customer();
    n += 1;
    const invoice = await insert('invoices', { customer_id: c.id, token: `${RUN}-${n}`, invoice_number: `${RUN}-${n}`, status: 'paid', paid_at: new Date('2026-01-02T12:00:00Z'), total: 300 });
    const install = await visit(c, day(-99), { service_type: 'Termite Installation Setup', status: 'completed' });
    const term = await insert('annual_prepay_terms', { customer_id: c.id, term_start: day(-100), term_end: day(265), status: 'active',
      prepay_invoice_id: invoice.id, coverage_service_type: 'Termite Bait Station Monitoring', coverage_visit_count: 1, prepay_amount: 300,
      installation_anchor_visit_id: install.id, installation_anchored_at: new Date() });
    await db('scheduled_services').where({ id: install.id }).update({ annual_prepay_term_id: term.id });
    return c;
  };

  test('an anchored termite plan counts its installation as the sold visit: nothing to refund now, and End of paid coverage no longer refuses', async () => {
    const c = await anchoredTermiteCustomer();
    const now = await cancellation.previewCancelPlan({ customerId: c.id, prepayDisposition: 'end_now_refund' });
    expect(now.prepay.refund).toMatchObject({ needsManualCalc: false, includedVisits: 1, completedVisits: 1, remainingVisits: 0, amount: 0 });
    const kept = await cancellation.previewCancelPlan({ customerId: c.id, effectiveDate: 'end_of_coverage', prepayDisposition: 'end_at_term' });
    expect(kept).toMatchObject({ effectiveDate: 'end_of_coverage', effectiveOn: day(265) });
  });

  test('the post-sweep refund recount judges the visits the approved refund counted: a same-service one-off never takes a freed slot, a covered visit that completed still counts', async () => {
    const { c, term, ahead } = await prepayCustomer();
    // A separately billed one-off of the same service inside the window: not the plan's.
    await visit(c, day(-50), { status: 'completed' });
    const approved = await cancellation.computePrepayRefund({ ...term, customer_id: c.id });
    expect(approved).toMatchObject({ completedVisits: 1, amount: 300 });
    const { coverageRowsForTerm } = require('../services/annual-prepay-renewals');
    const coveredIds = (await coverageRowsForTerm({ ...term, customer_id: c.id })).map((r) => r.id);
    // The race the recount exists for: a covered visit completes before the sweep reaches it.
    await db('scheduled_services').where({ id: ahead[0].id }).update({ status: 'completed' });
    // The sweep cancels the rest.
    await db('scheduled_services').whereIn('id', ahead.slice(1).map((v) => v.id)).update({ status: 'cancelled' });
    await expect(cancellation.computePrepayRefund({ ...term, customer_id: c.id }, { coveredIds }))
      .resolves.toMatchObject({ completedVisits: 2, remainingVisits: 2, amount: 200 });
    // Derived again without the approved set, the freed slots adopt the one-off.
    await expect(cancellation.computePrepayRefund({ ...term, customer_id: c.id }))
      .resolves.toMatchObject({ completedVisits: 3, amount: 100 });
  });

  test('a renewal whose plan lineage cannot be traced is manual, never a full refund off an empty covered set', async () => {
    const c = await customer();
    n += 1;
    const invoice = await insert('invoices', { customer_id: c.id, token: `${RUN}-${n}`, invoice_number: `${RUN}-${n}`, status: 'paid', paid_at: new Date('2026-01-02T12:00:00Z'), total: 400 });
    // The chain names neither an estimate nor a property: unresolvable.
    const original = await insert('annual_prepay_terms', { customer_id: c.id, term_start: day(-465), term_end: day(-100), status: 'renewed',
      coverage_service_type: 'General Pest Control', coverage_visit_count: 4, prepay_amount: 400 });
    const successor = await insert('annual_prepay_terms', { customer_id: c.id, term_start: day(-99), term_end: day(265), status: 'active',
      renewed_from_term_id: original.id, prepay_invoice_id: invoice.id, coverage_service_type: 'General Pest Control', coverage_visit_count: 4, prepay_amount: 400 });
    await visit(c, day(-50), { status: 'completed', annual_prepay_term_id: successor.id });
    await expect(cancellation.computePrepayRefund({ ...successor, customer_id: c.id }))
      .resolves.toMatchObject({ needsManualCalc: true, amount: null, reason: 'coverage_lineage_unresolved' });
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

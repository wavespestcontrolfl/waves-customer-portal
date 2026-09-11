/**
 * Annual-prepay coverage must survive series generation.
 *
 * Coverage is a THREE-field invariant (annualPrepayCoversVisit): the term
 * id, prepaid_method AND a positive prepaid_amount. Two generators were
 * dropping part of it:
 *
 *   1. buildRecurringFollowUpRows (booking + estimate conversion) copied
 *      annual_prepay_term_id but not the stamp, so children read as
 *      UNCOVERED — 43 such rows in prod on 2026-09-11.
 *   2. The completion-time auto-extend (runRecurringSeriesMaintenance)
 *      carried no prepay field at all, so a prepay customer's next visit
 *      billed again for service the prepay had already bought (Tom Kenedy,
 *      2026-10-22).
 *
 * The budget rule for (2): a term buys exactly coverage_visit_count visits.
 * An extension takes an unused slot or it bills.
 */
const { buildRecurringFollowUpRows } = require('../services/recurring-appointment-seeder');
const { resolveExtensionPrepayCoverage } = require('../routes/admin-schedule')._test;

const TERM_ID = 'term-1';
const PARENT = {
  id: 'parent-1',
  customer_id: 'cust-1',
  scheduled_date: '2026-07-23',
  service_type: 'Quarterly Pest Control Service',
  recurring_pattern: 'quarterly',
};

describe('buildRecurringFollowUpRows carries the whole prepay stamp', () => {
  test('a fully stamped parent passes term id + method + amount to its children', () => {
    const rows = buildRecurringFollowUpRows({
      ...PARENT,
      annual_prepay_term_id: TERM_ID,
      prepaid_method: 'annual_prepay_invoice',
      prepaid_amount: '111.15',
    }, { pattern: 'quarterly', plannedCount: 3 });

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.annual_prepay_term_id).toBe(TERM_ID);
      expect(row.prepaid_method).toBe('annual_prepay_invoice');
      expect(Number(row.prepaid_amount)).toBeGreaterThan(0);
    }
  });

  test('a link-only parent yields children with the link and NO partial stamp', () => {
    const rows = buildRecurringFollowUpRows({
      ...PARENT,
      annual_prepay_term_id: TERM_ID,
    }, { pattern: 'quarterly', plannedCount: 3 });

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.annual_prepay_term_id).toBe(TERM_ID);
      // A half stamp makes the CHARGING guard throw "unverifiable" rather
      // than read as uncovered — carry all three or none.
      expect(row.prepaid_method).toBeUndefined();
      expect(row.prepaid_amount).toBeUndefined();
    }
  });

  test('an amount with no term id is not passed through as a stamp', () => {
    const rows = buildRecurringFollowUpRows({
      ...PARENT,
      prepaid_method: 'annual_prepay_invoice',
      prepaid_amount: '111.15',
    }, { pattern: 'quarterly', plannedCount: 2 });

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.prepaid_method).toBeUndefined();
      expect(row.prepaid_amount).toBeUndefined();
    }
  });

  test('a parent on no prepay term is untouched', () => {
    const rows = buildRecurringFollowUpRows(PARENT, { pattern: 'quarterly', plannedCount: 2 });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.annual_prepay_term_id).toBeUndefined();
      expect(row.prepaid_method).toBeUndefined();
    }
  });
});

const COLS = {
  annual_prepay_term_id: {}, prepaid_method: {}, prepaid_amount: {},
};

// The helper reads the term through `conn` and the already-spent slots
// through the renewals module's own coverageRowsForTerm. Stub that seam
// directly — driving it through a fake knex chain silently yielded an empty
// row set, which made every "a slot is free" assertion pass vacuously.
const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');

let coverageRowsSpy;
afterEach(() => {
  if (coverageRowsSpy) coverageRowsSpy.mockRestore();
  coverageRowsSpy = null;
});

function connWith(term, coverageRows = []) {
  coverageRowsSpy = jest
    .spyOn(AnnualPrepayRenewals._private, 'coverageRowsForTerm')
    .mockResolvedValue(coverageRows);
  const conn = (table) => {
    const b = {};
    b.where = () => b;
    b.first = () => Promise.resolve(table === 'annual_prepay_terms' ? term : undefined);
    return b;
  };
  conn.schema = { hasTable: () => Promise.resolve(true) };
  return conn;
}

const LIVE_TERM = {
  id: TERM_ID,
  prepay_amount: '444.60',
  coverage_visit_count: 4,
  coverage_service_type: 'Quarterly Pest Control',
  term_start: '2025-08-25',
  term_end: '2027-01-31',
  status: 'active',
};

const stamped = (n) => Array.from({ length: n }, (_, i) => ({
  id: `covered-${i}`, annual_prepay_term_id: TERM_ID, prepaid_amount: '111.15',
}));

describe('resolveExtensionPrepayCoverage — the auto-extend budget rule', () => {
  const parent = { id: 'parent-1', annual_prepay_term_id: TERM_ID };

  test('an unused slot is taken, with all three fields set', async () => {
    const got = await resolveExtensionPrepayCoverage(
      connWith(LIVE_TERM, stamped(2)), parent, COLS, 'Quarterly Pest Control Service',
    );
    expect(got).toEqual({
      annual_prepay_term_id: TERM_ID,
      prepaid_method: 'annual_prepay_invoice',
      prepaid_amount: 111.15,
    });
  });

  test('an exhausted plan stamps nothing — the extension bills, correctly', async () => {
    const got = await resolveExtensionPrepayCoverage(
      connWith(LIVE_TERM, stamped(4)), parent, COLS, 'Quarterly Pest Control Service',
    );
    expect(got).toBeNull();
  });

  test('cancelled slots are already excluded by coverageRowsForTerm, so a written-off slot is reissued', async () => {
    // Two live stamps out of four -> a slot is free even though the term
    // once had four rows (Tom Kenedy: two slots written off by the
    // data-hygiene sweep).
    const got = await resolveExtensionPrepayCoverage(
      connWith(LIVE_TERM, stamped(2)), parent, COLS, 'Quarterly Pest Control Service',
    );
    expect(got).not.toBeNull();
  });

  test('a service the term does not cover is never stamped', async () => {
    const got = await resolveExtensionPrepayCoverage(
      connWith(LIVE_TERM, stamped(1)), parent, COLS, 'Mosquito Barrier Treatment',
    );
    expect(got).toBeNull();
  });

  test('the matcher tolerates catalog label drift (Service suffix, dropped cadence word)', async () => {
    for (const label of ['Quarterly Pest Control Service', 'Pest Control Service', 'Pest Control']) {
      const got = await resolveExtensionPrepayCoverage(
        connWith(LIVE_TERM, stamped(1)), parent, COLS, label,
      );
      expect(got).not.toBeNull();
    }
  });

  test('a legacy term with no coverage config is left to the backfills', async () => {
    const got = await resolveExtensionPrepayCoverage(
      connWith({ ...LIVE_TERM, coverage_visit_count: null }, []), parent, COLS, 'Quarterly Pest Control Service',
    );
    expect(got).toBeNull();
  });

  test('a parent on no term, a missing term, and a missing column all yield null', async () => {
    await expect(resolveExtensionPrepayCoverage(
      connWith(LIVE_TERM, []), { id: 'p' }, COLS, 'Quarterly Pest Control Service',
    )).resolves.toBeNull();
    await expect(resolveExtensionPrepayCoverage(
      connWith(undefined, []), parent, COLS, 'Quarterly Pest Control Service',
    )).resolves.toBeNull();
    await expect(resolveExtensionPrepayCoverage(
      connWith(LIVE_TERM, []), parent, { prepaid_method: {} }, 'Quarterly Pest Control Service',
    )).resolves.toBeNull();
  });

  test('a query failure fails to UNCOVERED rather than blocking the extension', async () => {
    const conn = () => { throw new Error('column does not exist'); };
    await expect(resolveExtensionPrepayCoverage(
      conn, parent, COLS, 'Quarterly Pest Control Service',
    )).resolves.toBeNull();
  });
});

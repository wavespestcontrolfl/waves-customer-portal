/**
 * Annual-prepay coverage must survive series generation — and never exceed
 * what the customer bought.
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
 *      billed again for service the prepay had already bought (one prod
 *      term, extension dated 2026-10-22).
 *
 * The budget rule both now obey: a term buys exactly coverage_visit_count
 * visits. A generated visit takes an unused slot or it bills. Blindly
 * copying the parent's stamp was the first fix and was WRONG — plannedCount
 * is independent of the coverage budget, so it would mark excess visits
 * prepaid and suppress invoices the customer owes.
 */
const seeder = require('../services/recurring-appointment-seeder');
const { buildRecurringFollowUpRows } = seeder;
const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
const { resolveExtensionPrepayCoverage } = require('../routes/admin-schedule')._test;

const TERM_ID = 'term-1';
const PARENT = {
  id: 'parent-1',
  customer_id: 'cust-1',
  scheduled_date: '2026-07-23',
  service_type: 'Quarterly Pest Control Service',
  recurring_pattern: 'quarterly',
};

test('the seeder mirrors the renewals module prepaid-method constant', () => {
  // The seeder holds the literal to avoid a require cycle; this pins them.
  const rows = buildRecurringFollowUpRows(
    { ...PARENT, annual_prepay_term_id: TERM_ID },
    { pattern: 'quarterly', plannedCount: 2, prepaidSlots: 1, prepaidSliceAmount: 111.15 },
  );
  expect(rows[0].prepaid_method).toBe(AnnualPrepayRenewals.ANNUAL_PREPAY_PREPAID_METHOD);
});

describe('buildRecurringFollowUpRows allocates coverage against a budget', () => {
  const build = (parent, opts) => buildRecurringFollowUpRows(
    { ...PARENT, ...parent }, { pattern: 'quarterly', plannedCount: 4, ...opts },
  );
  const stampedRows = (rows) => rows.filter((r) => r.prepaid_method);

  test('only as many children as there are slots are stamped', () => {
    const rows = build({ annual_prepay_term_id: TERM_ID }, {
      prepaidSlots: 2, prepaidSliceAmount: 111.15,
    });
    expect(rows.length).toBeGreaterThan(2);
    expect(stampedRows(rows)).toHaveLength(2);
    for (const row of stampedRows(rows)) {
      expect(row.annual_prepay_term_id).toBe(TERM_ID);
      expect(row.prepaid_method).toBe('annual_prepay_invoice');
      expect(Number(row.prepaid_amount)).toBe(111.15);
    }
    // Rows past the budget keep the link but stay uncovered, so they bill.
    for (const row of rows.filter((r) => !r.prepaid_method)) {
      expect(row.annual_prepay_term_id).toBe(TERM_ID);
      expect(row.prepaid_amount).toBeUndefined();
    }
  });

  test('no allocation supplied stamps nothing — the safe default', () => {
    const rows = build({
      annual_prepay_term_id: TERM_ID,
      prepaid_method: 'annual_prepay_invoice',
      prepaid_amount: '111.15',
    }, {});
    expect(rows.length).toBeGreaterThan(0);
    expect(stampedRows(rows)).toHaveLength(0);
  });

  test("a parent's own stamp is never copied — an independent cash/check/Zelle stamp is a per-visit fact", () => {
    const rows = build({
      annual_prepay_term_id: TERM_ID,
      prepaid_method: 'check',
      prepaid_amount: '500.00',
    }, { prepaidSlots: 4, prepaidSliceAmount: 111.15 });
    for (const row of rows) {
      expect(row.prepaid_method).not.toBe('check');
      expect(Number(row.prepaid_amount || 0)).not.toBe(500);
    }
  });

  test('a slice of zero or a parent on no term stamps nothing', () => {
    expect(stampedRows(build({ annual_prepay_term_id: TERM_ID }, {
      prepaidSlots: 4, prepaidSliceAmount: 0,
    }))).toHaveLength(0);
    expect(stampedRows(build({}, {
      prepaidSlots: 4, prepaidSliceAmount: 111.15,
    }))).toHaveLength(0);
  });
});

describe('remainingCoverageSlots counts allocations with NO date bound', () => {
  // A window-bounded count would read a visit scheduled past term_end as
  // unspent and hand out a free slot on every extension, indefinitely.
  function countingConn(spent) {
    const captured = {};
    const conn = () => {
      const b = {};
      b.where = (...args) => { captured.where = [...(captured.where || []), args]; return b; };
      b.whereNotIn = (...args) => { captured.whereNotIn = args; return b; };
      b.count = () => b;
      b.first = () => Promise.resolve({ n: spent });
      return b;
    };
    conn.captured = captured;
    return conn;
  }

  const term = { id: TERM_ID, coverage_visit_count: 4, prepay_amount: '444.60' };

  test('remaining = count minus live stamped rows', async () => {
    await expect(AnnualPrepayRenewals.remainingCoverageSlots(term, countingConn(1))).resolves.toBe(3);
    await expect(AnnualPrepayRenewals.remainingCoverageSlots(term, countingConn(4))).resolves.toBe(0);
    // Never negative, even if more rows were stamped than the plan bought.
    await expect(AnnualPrepayRenewals.remainingCoverageSlots(term, countingConn(9))).resolves.toBe(0);
  });

  test('the query filters on the term and excludes written-off rows, with no date predicate', async () => {
    const conn = countingConn(0);
    await AnnualPrepayRenewals.remainingCoverageSlots(term, conn);
    const flat = JSON.stringify(conn.captured);
    expect(flat).toContain(TERM_ID);
    expect(conn.captured.whereNotIn[1]).toEqual(
      expect.arrayContaining(['cancelled', 'no_show', 'skipped', 'rescheduled']),
    );
    expect(flat).not.toMatch(/term_start|term_end|scheduled_date/);
  });

  test('a term with no coverage config has no budget to hand out', async () => {
    await expect(AnnualPrepayRenewals.remainingCoverageSlots(
      { id: TERM_ID, coverage_visit_count: null }, countingConn(0),
    )).resolves.toBe(0);
    await expect(AnnualPrepayRenewals.remainingCoverageSlots(null, countingConn(0))).resolves.toBe(0);
  });
});

const COLS = { annual_prepay_term_id: {}, prepaid_method: {}, prepaid_amount: {} };

const LIVE_TERM = {
  id: TERM_ID,
  prepay_amount: '444.60',
  coverage_visit_count: 4,
  coverage_service_type: 'Quarterly Pest Control',
  status: 'active',
};

let slotsSpy;
afterEach(() => {
  if (slotsSpy) slotsSpy.mockRestore();
  slotsSpy = null;
});

function connWith(term, slotsLeft = 0) {
  slotsSpy = jest
    .spyOn(AnnualPrepayRenewals, 'remainingCoverageSlots')
    .mockResolvedValue(slotsLeft);
  const conn = (table) => {
    const b = {};
    b.where = () => b;
    b.first = () => Promise.resolve(table === 'annual_prepay_terms' ? term : undefined);
    return b;
  };
  conn.schema = { hasTable: () => Promise.resolve(true) };
  return conn;
}

describe('resolveExtensionPrepayCoverage — the auto-extend budget rule', () => {
  const parent = { id: 'parent-1', annual_prepay_term_id: TERM_ID };

  test('an unused slot is taken, with all three fields set', async () => {
    const got = await resolveExtensionPrepayCoverage(
      connWith(LIVE_TERM, 2), parent, COLS, 'Quarterly Pest Control Service',
    );
    expect(got).toEqual({
      annual_prepay_term_id: TERM_ID,
      prepaid_method: 'annual_prepay_invoice',
      prepaid_amount: 111.15,
    });
  });

  test('an exhausted plan stamps nothing — the extension bills, correctly', async () => {
    const got = await resolveExtensionPrepayCoverage(
      connWith(LIVE_TERM, 0), parent, COLS, 'Quarterly Pest Control Service',
    );
    expect(got).toBeNull();
  });

  test('a service the term does not cover is never stamped', async () => {
    const got = await resolveExtensionPrepayCoverage(
      connWith(LIVE_TERM, 3), parent, COLS, 'Mosquito Barrier Treatment',
    );
    expect(got).toBeNull();
  });

  test('the matcher tolerates catalog label drift (Service suffix, dropped cadence word)', async () => {
    for (const label of ['Quarterly Pest Control Service', 'Pest Control Service', 'Pest Control']) {
       
      const got = await resolveExtensionPrepayCoverage(
        connWith(LIVE_TERM, 3), parent, COLS, label,
      );
      expect(got).not.toBeNull();
      slotsSpy.mockRestore();
    }
  });

  test('a legacy term with no coverage config is left to the backfills', async () => {
    const got = await resolveExtensionPrepayCoverage(
      connWith({ ...LIVE_TERM, coverage_visit_count: null }, 4), parent, COLS, 'Quarterly Pest Control Service',
    );
    expect(got).toBeNull();
  });

  test('a parent on no term, a missing term, and a missing column all yield null', async () => {
    await expect(resolveExtensionPrepayCoverage(
      connWith(LIVE_TERM, 4), { id: 'p' }, COLS, 'Quarterly Pest Control Service',
    )).resolves.toBeNull();
    await expect(resolveExtensionPrepayCoverage(
      connWith(undefined, 4), parent, COLS, 'Quarterly Pest Control Service',
    )).resolves.toBeNull();
    await expect(resolveExtensionPrepayCoverage(
      connWith(LIVE_TERM, 4), parent, { prepaid_method: {} }, 'Quarterly Pest Control Service',
    )).resolves.toBeNull();
  });

  test('a query failure fails to UNCOVERED rather than blocking the extension', async () => {
    const conn = () => { throw new Error('column does not exist'); };
    await expect(resolveExtensionPrepayCoverage(
      conn, parent, COLS, 'Quarterly Pest Control Service',
    )).resolves.toBeNull();
  });
});

describe('resolvePrepaidSeedAllocation — the seeder budget lookup', () => {
  const { resolvePrepaidSeedAllocation } = seeder._internals;
  const parent = { id: 'p', annual_prepay_term_id: TERM_ID, service_type: 'Quarterly Pest Control Service' };

  test('resolves the remaining slots and one slice', async () => {
    await expect(resolvePrepaidSeedAllocation(connWith(LIVE_TERM, 3), parent, COLS))
      .resolves.toEqual({ prepaidSlots: 3, prepaidSliceAmount: 111.15 });
  });

  test('a spent plan, an uncovered service, and no term all allocate nothing', async () => {
    await expect(resolvePrepaidSeedAllocation(connWith(LIVE_TERM, 0), parent, COLS))
      .resolves.toEqual({});
    await expect(resolvePrepaidSeedAllocation(
      connWith(LIVE_TERM, 3), { ...parent, service_type: 'Mosquito Barrier Treatment' }, COLS,
    )).resolves.toEqual({});
    await expect(resolvePrepaidSeedAllocation(connWith(LIVE_TERM, 3), { id: 'p' }, COLS))
      .resolves.toEqual({});
  });

  test('a query failure allocates nothing rather than throwing', async () => {
    const conn = () => { throw new Error('boom'); };
    await expect(resolvePrepaidSeedAllocation(conn, parent, COLS)).resolves.toEqual({});
  });
});

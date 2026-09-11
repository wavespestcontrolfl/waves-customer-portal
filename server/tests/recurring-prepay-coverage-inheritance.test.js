/**
 * Annual-prepay coverage must survive series generation — through the ONE
 * coverage authority, not a second opinion.
 *
 * Coverage is a three-field invariant (annualPrepayCoversVisit): the term id,
 * prepaid_method AND a positive prepaid_amount. Two generators were dropping
 * part of it:
 *
 *   1. buildRecurringFollowUpRows (booking + estimate conversion) copied
 *      annual_prepay_term_id but not the stamp, so children read as
 *      UNCOVERED — 43 such rows in prod on 2026-09-11.
 *   2. The completion-time auto-extend (runRecurringSeriesMaintenance)
 *      carried no prepay field at all, so a prepay customer's next visit
 *      billed again for service the prepay had already bought (one prod
 *      term, extension dated 2026-10-22).
 *
 * Earlier attempts at this fix each grew their OWN budget arithmetic beside
 * applyPrepaidCoverageForTerm and reconcilePendingWindowCompletions, and
 * three review rounds found three different ways for four allocators to
 * disagree — over-stamping past coverage_visit_count, freeing a slot by
 * dropping NULL-status rows from a NOT IN, missing consumption reconciliation
 * had already spent without stamping, and duplicating the remainder cents
 * after a non-final cancellation. So both generators now insert their rows
 * and DELEGATE: applyPrepaidCoverageForTerm decides who is covered and for
 * how much. These tests pin the delegation.
 */
const seeder = require('../services/recurring-appointment-seeder');
const { buildRecurringFollowUpRows } = seeder;
const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
const { applyExtensionPrepayCoverage } = require('../routes/admin-schedule')._test;

const TERM_ID = 'term-1';
const PARENT = {
  id: 'parent-1',
  customer_id: 'cust-1',
  scheduled_date: '2026-07-23',
  service_type: 'Quarterly Pest Control Service',
  recurring_pattern: 'quarterly',
};

describe('buildRecurringFollowUpRows carries the LINK and never a stamp', () => {
  const build = (parent, opts = {}) => buildRecurringFollowUpRows(
    { ...PARENT, ...parent }, { pattern: 'quarterly', plannedCount: 4, ...opts },
  );

  test('children inherit the term link so the coverage authority can find them', () => {
    const rows = build({ annual_prepay_term_id: TERM_ID });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.annual_prepay_term_id).toBe(TERM_ID);
  });

  test('no child is stamped in the builder, whatever the parent carries', () => {
    // Including an out-of-band cash/check/Zelle stamp, which is a per-visit
    // fact and must never be smeared across a series.
    for (const parent of [
      { annual_prepay_term_id: TERM_ID, prepaid_method: 'annual_prepay_invoice', prepaid_amount: '111.15' },
      { annual_prepay_term_id: TERM_ID, prepaid_method: 'check', prepaid_amount: '500.00' },
      { prepaid_method: 'annual_prepay_invoice', prepaid_amount: '111.15' },
    ]) {
      const rows = build(parent);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.prepaid_method).toBeUndefined();
        expect(row.prepaid_amount).toBeUndefined();
      }
    }
  });
});

// Both generators reach the authority the same way: load the term, hand it
// and the caller's connection to applyPrepaidCoverageForTerm, quietly.
function connWithTerm(term, { isTransaction = false } = {}) {
  const conn = (table) => {
    const b = {};
    b.where = () => b;
    b.first = () => Promise.resolve(table === 'annual_prepay_terms' ? term : undefined);
    return b;
  };
  conn.isTransaction = isTransaction;
  // knex's nested transaction == a SAVEPOINT. The fake hands the callback a
  // child connection and records that the savepoint was opened.
  conn.savepoints = 0;
  conn.transaction = (run) => {
    conn.savepoints += 1;
    const sp = connWithTerm(term);
    sp.isTransaction = true;
    return Promise.resolve(run(sp));
  };
  return conn;
}

const LIVE_TERM = { id: TERM_ID, prepay_amount: '444.60', coverage_visit_count: 4 };
const COLS = { annual_prepay_term_id: {} };

describe.each([
  ['auto-extend', (conn, parent) => applyExtensionPrepayCoverage(conn, parent)],
  ['seeder', (conn, parent) => seeder._internals.applySeededPrepayCoverage(conn, parent, COLS)],
])('%s delegates coverage to applyPrepaidCoverageForTerm', (_label, run) => {
  const parent = { id: 'parent-1', annual_prepay_term_id: TERM_ID };
  let applySpy;
  beforeEach(() => {
    applySpy = jest.spyOn(AnnualPrepayRenewals, 'applyPrepaidCoverageForTerm').mockResolvedValue({});
  });
  afterEach(() => applySpy.mockRestore());

  test("passes the term, the CALLER's connection, and quiet bells", async () => {
    const conn = connWithTerm(LIVE_TERM);
    await run(conn, parent);
    expect(applySpy).toHaveBeenCalledTimes(1);
    const [term, passedConn, options] = applySpy.mock.calls[0];
    expect(term.id).toBe(TERM_ID);
    // Same connection ⇒ the stamp commits or rolls back with the insert.
    expect(passedConn).toBe(conn);
    // One bell per generated visit would bury the daily sweep's real ones.
    expect(options).toEqual({ quietExceptions: true });
  });

  test('a parent on no term never calls the authority', async () => {
    await run(connWithTerm(LIVE_TERM), { id: 'p' });
    expect(applySpy).not.toHaveBeenCalled();
  });

  test('a term row that no longer exists never calls the authority', async () => {
    await run(connWithTerm(undefined), parent);
    expect(applySpy).not.toHaveBeenCalled();
  });

  test('inside a caller transaction the work runs in a SAVEPOINT', async () => {
    // A failed statement poisons a PostgreSQL transaction (25P02), so a bare
    // try/catch would still roll back the visit that was just inserted.
    const conn = connWithTerm(LIVE_TERM, { isTransaction: true });
    await run(conn, parent);
    expect(conn.savepoints).toBe(1);
    expect(applySpy).toHaveBeenCalledTimes(1);
    // The allocator gets the SAVEPOINT connection, not the outer trx.
    expect(applySpy.mock.calls[0][1]).not.toBe(conn);
    expect(applySpy.mock.calls[0][1].isTransaction).toBe(true);
  });

  test('a plain connection needs no savepoint', async () => {
    const conn = connWithTerm(LIVE_TERM);
    await run(conn, parent);
    expect(conn.savepoints).toBe(0);
    expect(applySpy.mock.calls[0][1]).toBe(conn);
  });

  test('a failure inside the savepoint is swallowed, not propagated', async () => {
    applySpy.mockRejectedValue(new Error('boom'));
    const conn = connWithTerm(LIVE_TERM, { isTransaction: true });
    await expect(run(conn, parent)).resolves.toBeUndefined();
    expect(conn.savepoints).toBe(1);
  });

  test('a failure leaves the visit uncovered rather than failing the insert', async () => {
    applySpy.mockRejectedValue(new Error('boom'));
    await expect(run(connWithTerm(LIVE_TERM), parent)).resolves.toBeUndefined();
    const exploding = () => { throw new Error('column does not exist'); };
    await expect(run(exploding, parent)).resolves.toBeUndefined();
  });
});

test('the seeder skips the re-apply when the link column does not exist', async () => {
  const applySpy = jest.spyOn(AnnualPrepayRenewals, 'applyPrepaidCoverageForTerm').mockResolvedValue({});
  await seeder._internals.applySeededPrepayCoverage(
    connWithTerm(LIVE_TERM), { id: 'p', annual_prepay_term_id: TERM_ID }, {},
  );
  expect(applySpy).not.toHaveBeenCalled();
  applySpy.mockRestore();
});

describe('quietExceptions suppresses the bells and nothing else', () => {
  test('only exception filing reads the flag; stamping and the warn log do not', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'services', 'annual-prepay-renewals.js'), 'utf8',
    );
    const fn = src.slice(
      src.indexOf('async function applyPrepaidCoverageForTerm'),
      src.indexOf('async function reconcilePendingWindowCompletions'),
    );
    expect(fn).toBeTruthy();
    const uses = fn.split('\n').filter((l) => l.includes('quietExceptions'));
    expect(uses.length).toBeGreaterThanOrEqual(3); // signature + both bells
    for (const line of uses) {
      expect(line).toMatch(/fileCoverageExceptionAfterCommit|async function applyPrepaidCoverageForTerm/);
    }
    // The warn-level record of a race is NOT suppressed.
    expect(fn).toMatch(/completed while the prepaid stamp ran/);
    expect(fn).toMatch(/were cancelled while the prepaid stamp ran/);
  });
});

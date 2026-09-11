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
// The term is resolved through coveredTermsAsOf — the live/paid authority —
// so the fake stands in for THAT, not a bare annual_prepay_terms lookup.
// `term` is what the authority yields: undefined means "not a covered term"
// (unpaid, refunded, revoked, or simply gone).
let coveredSpy;
afterEach(() => {
  if (coveredSpy) coveredSpy.mockRestore();
  coveredSpy = null;
});

function connWithTerm(term, { isTransaction = false, siblingRow = undefined } = {}) {
  coveredSpy = jest.spyOn(AnnualPrepayRenewals, 'coveredTermsAsOf').mockImplementation(() => {
    const b = {};
    b.where = () => b;
    b.first = () => Promise.resolve(term);
    return b;
  });
  const conn = (table) => {
    const b = {};
    for (const m of ['where', 'whereNotNull', 'whereNotIn', 'orderBy']) b[m] = () => b;
    b.first = () => Promise.resolve(
      table === 'scheduled_services' ? siblingRow : (table === 'annual_prepay_terms' ? term : undefined),
    );
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
    // Only the self-healing completion-race bell is silenced.
    expect(options).toEqual({ quietTransientExceptions: true });
  });

  test('a parent on no term never calls the authority', async () => {
    await run(connWithTerm(LIVE_TERM), { id: 'p' });
    expect(applySpy).not.toHaveBeenCalled();
  });

  test('a term that is not live+paid never gets stamped', async () => {
    // coveredTermsAsOf yields nothing for an unpaid, refunded or revoked
    // term. Those keep their visit links for audit, and re-stamping one
    // would restore coverage revocation deliberately cleared — and block
    // cancelling the visit, since findBillingCoveredVisits reads a positive
    // prepaid_amount as money held.
    await run(connWithTerm(undefined), parent);
    expect(applySpy).not.toHaveBeenCalled();
  });

  test('the term is resolved through coveredTermsAsOf, not a bare lookup', async () => {
    const conn = connWithTerm(LIVE_TERM);
    await run(conn, parent);
    expect(coveredSpy).toHaveBeenCalled();
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

describe('the auto-extend finds the term wherever the series carries it', () => {
  // Annual prepay activated partway through an ongoing series links only
  // visits inside the term window, so a root parent predating term_start is
  // never linked. Reading the term from the root alone left the extension
  // unstamped — the very bug this PR fixes.
  let applySpy;
  beforeEach(() => {
    applySpy = jest.spyOn(AnnualPrepayRenewals, 'applyPrepaidCoverageForTerm').mockResolvedValue({});
  });
  afterEach(() => applySpy.mockRestore());

  test('the just-completed visit carries it, the unlinked root does not', async () => {
    await applyExtensionPrepayCoverage(
      connWithTerm(LIVE_TERM), { id: 'root', annual_prepay_term_id: null },
      { id: 'svc', annual_prepay_term_id: TERM_ID },
    );
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy.mock.calls[0][0].id).toBe(TERM_ID);
  });

  test('neither root nor svc carries it — a linked sibling does', async () => {
    const conn = connWithTerm(LIVE_TERM, { siblingRow: { annual_prepay_term_id: TERM_ID } });
    await applyExtensionPrepayCoverage(conn, { id: 'root' }, { id: 'svc' });
    expect(applySpy).toHaveBeenCalledTimes(1);
  });

  test('nothing in the series is linked — nothing is stamped', async () => {
    await applyExtensionPrepayCoverage(connWithTerm(LIVE_TERM), { id: 'root' }, { id: 'svc' });
    expect(applySpy).not.toHaveBeenCalled();
  });

  test('a failed sibling lookup degrades to unstamped, never throws', async () => {
    const conn = (table) => {
      if (table === 'scheduled_services') throw new Error('column does not exist');
      const b = {};
      b.where = () => b;
      b.first = () => Promise.resolve(LIVE_TERM);
      return b;
    };
    await expect(applyExtensionPrepayCoverage(conn, { id: 'root' }, { id: 'svc' })).resolves.toBeUndefined();
    expect(applySpy).not.toHaveBeenCalled();
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

describe('quietTransientExceptions silences ONE bell, never the durable one', () => {
  test('the flag gates stamp_raced_completion only; stamp_raced_cancel always fires', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'services', 'annual-prepay-renewals.js'), 'utf8',
    );
    const fn = src.slice(
      src.indexOf('async function applyPrepaidCoverageForTerm'),
      src.indexOf('async function reconcilePendingWindowCompletions'),
    );
    expect(fn).toBeTruthy();
    const lines = fn.split('\n');
    const flagged = lines.filter((l) => l.includes('quietTransientExceptions') && !l.trim().startsWith('//'));
    // Exactly the signature and the ONE guarded bell read the flag.
    expect(flagged).toHaveLength(2);
    expect(flagged.some((l) => l.includes('async function applyPrepaidCoverageForTerm'))).toBe(true);
    expect(flagged.some((l) => l.includes("'stamp_raced_completion'"))).toBe(true);

    // stamp_raced_cancel reports a PAID slot cancelled out from under the
    // stamp. Nothing re-seeds it and reconcileCoveredTermsSweep only handles
    // COMPLETED visits, so silencing it would leave the customer's paid
    // schedule short and invisible. It must be filed unconditionally.
    const cancelLine = lines.find((l) => l.includes("'stamp_raced_cancel'"));
    expect(cancelLine).toBeTruthy();
    expect(cancelLine).not.toMatch(/quietTransientExceptions/);
    expect(cancelLine.trim()).toMatch(/^await fileCoverageExceptionAfterCommit\(/);

    // The warn-level record of either race is never suppressed.
    expect(fn).toMatch(/completed while the prepaid stamp ran/);
    expect(fn).toMatch(/were cancelled while the prepaid stamp ran/);
  });
});

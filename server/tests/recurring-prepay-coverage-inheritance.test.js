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

let detachSpy;
let fileExcSpy;
beforeEach(() => {
  detachSpy = jest.spyOn(AnnualPrepayRenewals._private, 'detachCallbacksFromTerm').mockResolvedValue(0);
  fileExcSpy = jest.spyOn(AnnualPrepayRenewals._private, 'fileCoverageExceptionAfterCommit').mockResolvedValue();
});
afterEach(() => {
  detachSpy.mockRestore();
  fileExcSpy.mockRestore();
});
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

function connWithTerm(term, { isTransaction = false, seriesTermIds: linkedIds = [] } = {}) {
  // coveredTermsAsOf is the live/paid authority. `term` is what it yields —
  // undefined means "no term is live, paid and covering that date".
  coveredSpy = jest.spyOn(AnnualPrepayRenewals, 'coveredTermsAsOf').mockImplementation((c, date) => {
    const b = {};
    coveredSpy.lastDate = date;
    (coveredSpy.dates = coveredSpy.dates || []).push(date);
    const yielded = typeof term === 'function' ? term(date) : term;
    b.where = () => b;
    b.whereIn = (_col, ids) => { coveredSpy.lastIds = ids; return b; };
    b.orderBy = () => b;
    b.first = () => Promise.resolve(Array.isArray(yielded) ? yielded[0] : yielded);
    b.select = () => Promise.resolve(
      Array.isArray(yielded) ? yielded : (yielded ? [yielded] : []),
    );
    return b;
  });
  const conn = () => {
    const b = {};
    for (const m of ['where', 'whereNotNull', 'whereNotIn', 'distinct', 'orderBy']) b[m] = () => b;
    b.pluck = () => Promise.resolve(linkedIds);
    b.first = () => Promise.resolve(undefined);
    return b;
  };
  conn.isTransaction = isTransaction;
  // knex's nested transaction == a SAVEPOINT. The fake hands the callback a
  // child connection and records that the savepoint was opened.
  conn.savepoints = 0;
  conn.transaction = (run) => {
    conn.savepoints += 1;
    const sp = connWithTerm(term, { seriesTermIds: linkedIds });
    sp.isTransaction = true;
    return Promise.resolve(run(sp));
  };
  return conn;
}

const LIVE_TERM = { id: TERM_ID, prepay_amount: '444.60', coverage_visit_count: 4 };
const COLS = { annual_prepay_term_id: {} };

describe.each([
  ['auto-extend', (conn, parent) => applyExtensionPrepayCoverage(conn, parent)],
  ['seeder', (conn, parent) => seeder._internals.applySeededPrepayCoverage(conn, parent, COLS, ['2027-01-28'])],
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
    // Only the self-healing completion-race bell is silenced, and alerts
    // are scoped to the OUTER transaction, never the savepoint.
    expect(options.quietTransientExceptions).toBe(true);
    expect(options.notifyConn).toBe(conn);
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

  test('candidates come from svc, the parent AND live siblings', async () => {
    const conn = connWithTerm(LIVE_TERM, { seriesTermIds: ['sibling-term'] });
    await applyExtensionPrepayCoverage(
      conn, { id: 'root', annual_prepay_term_id: 'root-term' },
      { id: 'svc', annual_prepay_term_id: 'svc-term' }, '2027-01-28',
    );
    expect(coveredSpy.lastIds).toEqual(expect.arrayContaining(['svc-term', 'root-term', 'sibling-term']));
    expect(applySpy).toHaveBeenCalledTimes(1);
  });

  test("selection is by the NEW visit's date, not the first historical link", async () => {
    // At a renewal boundary the completed visit still points at the OLD term,
    // whose window excludes the extension, while a sibling carries the
    // renewed one. coveredTermsAsOf must be asked about the extension's date.
    const conn = connWithTerm(LIVE_TERM, { seriesTermIds: ['renewed-term'] });
    await applyExtensionPrepayCoverage(
      conn, { id: 'root' }, { id: 'svc', annual_prepay_term_id: 'expired-term' }, '2027-04-22',
    );
    expect(coveredSpy.lastDate).toBe('2027-04-22');
  });

  test('an unlinked root still resolves through a linked sibling', async () => {
    const conn = connWithTerm(LIVE_TERM, { seriesTermIds: [TERM_ID] });
    await applyExtensionPrepayCoverage(conn, { id: 'root' }, { id: 'svc' }, '2027-01-28');
    expect(applySpy).toHaveBeenCalledTimes(1);
  });

  test('nothing in the series is linked — the authority is never asked', async () => {
    const conn = connWithTerm(LIVE_TERM, { seriesTermIds: [] });
    await applyExtensionPrepayCoverage(conn, { id: 'root' }, { id: 'svc' }, '2027-01-28');
    expect(coveredSpy).not.toHaveBeenCalled();
    expect(applySpy).not.toHaveBeenCalled();
  });

  test('no term covers that date — nothing is stamped', async () => {
    const conn = connWithTerm(undefined, { seriesTermIds: [TERM_ID] });
    await applyExtensionPrepayCoverage(conn, { id: 'root' }, { id: 'svc' }, '2027-01-28');
    expect(applySpy).not.toHaveBeenCalled();
  });

  test('the series scan runs INSIDE the savepoint, not on the outer trx', async () => {
    // A failed statement leaves a PG transaction aborted (25P02) even when
    // JS catches it, so a scan outside the savepoint would roll back the
    // visit that was just inserted.
    const conn = connWithTerm(LIVE_TERM, { isTransaction: true, seriesTermIds: [TERM_ID] });
    let scannedOnOuter = false;
    const outerQuery = conn;
    const wrapped = Object.assign((...args) => { scannedOnOuter = true; return outerQuery(...args); }, conn);
    wrapped.isTransaction = true;
    wrapped.transaction = conn.transaction;
    await applyExtensionPrepayCoverage(wrapped, { id: 'root' }, { id: 'svc' }, '2027-01-28');
    expect(conn.savepoints).toBe(1);
    expect(scannedOnOuter).toBe(false);
  });

  test('a failed series scan degrades to unstamped, never throws', async () => {
    const exploding = () => { throw new Error('column does not exist'); };
    exploding.isTransaction = false;
    await expect(
      applyExtensionPrepayCoverage(exploding, { id: 'root' }, { id: 'svc' }, '2027-01-28'),
    ).resolves.toBeUndefined();
    expect(applySpy).not.toHaveBeenCalled();
  });
});

test('the seeder skips the re-apply when the link column does not exist', async () => {
  const applySpy = jest.spyOn(AnnualPrepayRenewals, 'applyPrepaidCoverageForTerm').mockResolvedValue({});
  await seeder._internals.applySeededPrepayCoverage(
    connWithTerm(LIVE_TERM), { id: 'p', annual_prepay_term_id: TERM_ID }, {}, ['2027-01-28'],
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
    // One is the option's own declaration in the signature; the other is the
    // single bell it guards.
    expect(flagged.some((l) => l.includes('quietTransientExceptions = false'))).toBe(true);
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

describe('a seeded batch spanning a renewal boundary', () => {
  // Picking one term from the earliest date left the later visits unstamped
  // despite a linked, paid renewal — and an earliest date predating coverage
  // skipped the whole batch.
  const OLD_TERM = { id: 'old-term', prepay_amount: '400.00', coverage_visit_count: 4 };
  const NEW_TERM = { id: 'new-term', prepay_amount: '444.60', coverage_visit_count: 4 };
  let applySpy;
  beforeEach(() => {
    applySpy = jest.spyOn(AnnualPrepayRenewals, 'applyPrepaidCoverageForTerm').mockResolvedValue({});
  });
  afterEach(() => applySpy.mockRestore());

  test('every term covering any seeded date is applied, once each', async () => {
    const byDate = (date) => (date < '2027-01-01' ? [OLD_TERM] : [NEW_TERM]);
    const conn = connWithTerm(byDate, { seriesTermIds: ['old-term', 'new-term'] });
    await seeder._internals.applySeededPrepayCoverage(
      conn, { id: 'root', annual_prepay_term_id: 'old-term' }, COLS,
      ['2026-10-22', '2026-12-11', '2027-03-12', '2027-06-11'],
    );
    const applied = applySpy.mock.calls.map(([t]) => t.id);
    expect(applied).toEqual(expect.arrayContaining(['old-term', 'new-term']));
    // Deduped: each term applied once however many dates it covers.
    expect(new Set(applied).size).toBe(applied.length);
  });

  test('an earliest date outside coverage no longer skips the batch', async () => {
    const byDate = (date) => (date === '2026-01-01' ? [] : [NEW_TERM]);
    const conn = connWithTerm(byDate, { seriesTermIds: ['new-term'] });
    await seeder._internals.applySeededPrepayCoverage(
      conn, { id: 'root' }, COLS, ['2026-01-01', '2027-03-12'],
    );
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy.mock.calls[0][0].id).toBe('new-term');
  });
});

describe('the durable trail and the legacy-callback cleanup', () => {
  let applySpy;
  beforeEach(() => {
    applySpy = jest.spyOn(AnnualPrepayRenewals, 'applyPrepaidCoverageForTerm').mockResolvedValue({});
  });
  afterEach(() => applySpy.mockRestore());

  test('legacy callbacks are detached BEFORE the allocator runs', async () => {
    const order = [];
    detachSpy.mockImplementation(async () => { order.push('detach'); return 0; });
    applySpy.mockImplementation(async () => { order.push('apply'); return {}; });
    await applyExtensionPrepayCoverage(
      connWithTerm(LIVE_TERM, { seriesTermIds: [TERM_ID] }), { id: 'root' }, { id: 'svc' }, '2027-01-28',
    );
    expect(order).toEqual(['detach', 'apply']);
  });

  test('a failed re-apply files a durable operator exception on the OUTER trx', async () => {
    applySpy.mockRejectedValue(new Error('boom'));
    const conn = connWithTerm(LIVE_TERM, { seriesTermIds: [TERM_ID] });
    await expect(
      applyExtensionPrepayCoverage(conn, { id: 'root' }, { id: 'svc' }, '2027-01-28'),
    ).resolves.toBeUndefined();
    expect(fileExcSpy).toHaveBeenCalledTimes(1);
    const [scope, term, reason] = fileExcSpy.mock.calls[0];
    expect(scope).toBe(conn);
    expect(term.id).toBe(TERM_ID);
    expect(reason).toBe('generator_coverage_failed');
  });

  test('a failure before any term resolves files nothing to attribute', async () => {
    const conn = connWithTerm(undefined, { seriesTermIds: [TERM_ID] });
    await applyExtensionPrepayCoverage(conn, { id: 'root' }, { id: 'svc' }, '2027-01-28');
    expect(fileExcSpy).not.toHaveBeenCalled();
  });

  test('term DISCOVERY filters on no status at all (source guard)', () => {
    // Discovery is not slot counting. Any linked visit — live, NULL-status
    // or terminal — is evidence the series belongs to that term; a cancelled
    // sibling is often the ONLY evidence, and its cancellation freed the very
    // slot the replacement wants. coveredTermsAsOf rejects unpaid/revoked
    // terms and coverageRowsForTerm still excludes terminal rows from the
    // covered set, so discovery needs no status predicate of its own.
    const fs = require('fs');
    const path = require('path');
    for (const rel of ['../routes/admin-schedule.js', '../services/recurring-appointment-seeder.js']) {
      const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
      const at = src.indexOf("whereNotNull('annual_prepay_term_id')");
      expect(at).toBeGreaterThan(0);
      const scan = src.slice(at, src.indexOf("distinct('annual_prepay_term_id')", at));
      const code = scan.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      expect(code).not.toMatch(/whereNotIn\('status'|whereNull\('status'|orWhereNotIn\('status'/);
    }
  });
});

/**
 * bank-import service — statement parsing, row identity, and the
 * deterministic matching policy.
 *
 * The load-bearing behaviors:
 *  1. Both Capital One export shapes (card Debit/Credit columns, checking
 *     Transaction Amount + Type) and a generic signed-amount CSV normalize
 *     to the same row shape; a bad line skips with a reason, never throws.
 *  2. Row hashes make overlapping re-uploads no-ops WITHOUT collapsing two
 *     genuinely identical same-day purchases (per-file occurrence ordinal).
 *  3. Matching only auto-links exact single-candidate hits, always through
 *     a status='unmatched' CAS, and transfer-looking rows never match.
 */

const state = {
  bankRows: [],
  payouts: [],
  expenses: [],
  updates: [],
  queried: [],
  builders: [],
};

function makeBuilder(table) {
  const b = {};
  const chain = (name) => { b[name] = jest.fn(() => b); };
  ['where', 'andWhere', 'whereNot', 'whereNotIn', 'whereBetween', 'whereRaw', 'whereIn', 'whereNull', 'whereNotNull', 'whereNotExists',
    'orderBy', 'limit', 'groupBy', 'groupByRaw', 'select', 'first'].forEach(chain);
  b.update = jest.fn((patch) => {
    // Only row-scoped updates (where({id,...})) are the matcher's claims and
    // parks; the dangling-link heal sweep uses whereIn/whereNull and is
    // treated as a no-op here so it doesn't pollute the assertions.
    const wheres = b.where.mock.calls.map(c => c[0]);
    if (!wheres.some(w => w && typeof w === 'object' && 'id' in w)) return Promise.resolve(0);
    state.updates.push({ table, where: wheres, patch });
    return Promise.resolve(1);
  });
  b.then = (resolve, reject) => {
    state.queried.push(table);
    let rows = table === 'bank_transactions' ? state.bankRows
      : table === 'stripe_payouts' ? state.payouts
        : table === 'expenses' ? state.expenses : [];
    // mirror the status + pending-flag filters so the unmatched loop and the
    // reconciliation sweep each see only their own rows (a row with no
    // status set counts as 'unmatched')
    if (table === 'bank_transactions') {
      const statusWhere = b.where.mock.calls.map(c => c[0]).find(a => a && typeof a === 'object' && 'status' in a);
      if (statusWhere) rows = rows.filter(r => (r.status || 'unmatched') === statusWhere.status);
      if (b.whereRaw.mock.calls.some(c => String(c[0]).includes('reconcilePending'))) {
        rows = rows.filter(r => r.suggestion && r.suggestion.reconcilePending === true);
      }
      // mirror the bounded pass's fresh-vs-examined split
      const isExamined = (r) => !!(r.suggestion && (r.suggestion.ignore || r.suggestion.candidates || r.suggestion.payoutCandidates || r.suggestion.noMatch));
      const raws = b.whereRaw.mock.calls.map(c => String(c[0]));
      if (raws.some(s => s.includes('or not jsonb_exists_any'))) rows = rows.filter(r => !isExamined(r));
      else if (raws.some(s => s.includes('suggestion is not null and'))) rows = rows.filter(isExamined);
    }
    return Promise.resolve(rows).then(resolve, reject);
  };
  b.first = jest.fn(() => b.then(rows => rows[0]));
  state.builders.push({ table, b });
  return b;
}

const mockDb = jest.fn((table) => makeBuilder(table));
mockDb.raw = jest.fn((sql) => sql);
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// A confirmed payout link must echo into the EXISTING reconciliation
// mechanism — stubbed here, asserted below.
jest.mock('../services/stripe-banking', () => ({ reconcilePayout: jest.fn(() => Promise.resolve({})) }));
const { reconcilePayout } = require('../services/stripe-banking');

const {
  parseStatementCsv, withRowHashes, hashRow, transferSuggestion,
  runDeterministicMatching, parseDateCell, addDays, vendorEvidence,
} = require('../services/bank-import');

beforeEach(() => {
  state.bankRows = [];
  state.payouts = [];
  state.expenses = [];
  state.updates = [];
  state.queried = [];
  state.builders = [];
  reconcilePayout.mockClear();
});

describe('parseStatementCsv', () => {
  test('Capital One card format: Debit/Credit columns, MM/DD/YYYY dates', () => {
    const csv = [
      'Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit',
      '08/09/2026,08/10/2026,1234,WAWA 5211 VENICE FL,Gas,58.12,',
      '08/08/2026,08/09/2026,1234,PAYMENT THANK YOU,Payment,,250.00',
    ].join('\n');
    const { rows, skipped } = parseStatementCsv(csv);
    expect(skipped).toEqual([]);
    expect(rows).toEqual([
      { txn_date: '2026-08-09', description: 'WAWA 5211 VENICE FL', amount: 58.12, direction: 'debit' },
      { txn_date: '2026-08-08', description: 'PAYMENT THANK YOU', amount: 250, direction: 'credit' },
    ]);
  });

  test('Capital One checking format: Transaction Amount + Transaction Type', () => {
    const csv = [
      'Account Number,Transaction Date,Transaction Amount,Transaction Type,Transaction Description,Balance',
      '9876,2026-08-11,"$2,418.66",Credit,STRIPE PAYOUT ST-K3D9,"$5,000.00"',
      '9876,2026-08-10,$312.40,Debit,SITEONE LANDSCAPE SUPPLY,"$2,581.34"',
    ].join('\n');
    const { rows, skipped } = parseStatementCsv(csv);
    expect(skipped).toEqual([]);
    expect(rows[0]).toEqual({ txn_date: '2026-08-11', description: 'STRIPE PAYOUT ST-K3D9', amount: 2418.66, direction: 'credit' });
    expect(rows[1]).toEqual({ txn_date: '2026-08-10', description: 'SITEONE LANDSCAPE SUPPLY', amount: 312.4, direction: 'debit' });
  });

  test('generic signed Amount column: negative is a debit', () => {
    const csv = 'Date,Description,Amount\n08/10/26,HD SUPPLY,-204.87\n08/10/26,REFUND,15.00';
    const { rows } = parseStatementCsv(csv);
    expect(rows[0]).toMatchObject({ amount: 204.87, direction: 'debit', txn_date: '2026-08-10' });
    expect(rows[1]).toMatchObject({ amount: 15, direction: 'credit' });
  });

  test('bad rows skip with a line + reason instead of throwing', () => {
    const csv = [
      'Date,Description,Amount',
      'not-a-date,SOMETHING,10.00',
      '08/10/2026,,10.00',
      '08/10/2026,ZERO ROW,0.00',
      '08/10/2026,GOOD ROW,10.00',
    ].join('\n');
    const { rows, skipped } = parseStatementCsv(csv);
    expect(rows).toHaveLength(1);
    expect(skipped.map(s => s.reason)).toEqual(['unparseable date', 'missing description', 'zero amount']);
    expect(skipped[0].line).toBe(2);
  });

  test('a row with both Debit and Credit populated is skipped, not guessed', () => {
    const csv = 'Transaction Date,Description,Debit,Credit\n08/09/2026,WEIRD ROW,10.00,10.00';
    const { rows, skipped } = parseStatementCsv(csv);
    expect(rows).toHaveLength(0);
    expect(skipped[0].reason).toBe('both debit and credit populated');
  });
});

describe('withRowHashes', () => {
  const twoCoffees = [
    { txn_date: '2026-08-09', description: 'COFFEE SHOP', amount: 4.5, direction: 'debit' },
    { txn_date: '2026-08-09', description: 'COFFEE SHOP', amount: 4.5, direction: 'debit' },
  ];

  test('identical same-day rows get DISTINCT hashes (occurrence ordinal)', () => {
    const [a, b] = withRowHashes('capone-card', twoCoffees);
    expect(a.row_hash).not.toBe(b.row_hash);
  });

  test('re-hashing the same file reproduces the same hashes (dedupe works)', () => {
    const first = withRowHashes('capone-card', twoCoffees).map(r => r.row_hash);
    const second = withRowHashes('capone-card', twoCoffees).map(r => r.row_hash);
    expect(second).toEqual(first);
  });

  test('a partial-overlap file dedupes the shared occurrence and keeps the new one', () => {
    const subset = withRowHashes('capone-card', twoCoffees.slice(0, 1)).map(r => r.row_hash);
    const superset = withRowHashes('capone-card', twoCoffees).map(r => r.row_hash);
    expect(superset[0]).toBe(subset[0]);
    expect(subset).not.toContain(superset[1]);
  });

  test('account label is part of identity — same row on two cards stays apart', () => {
    const [a] = withRowHashes('capone-card-1111', twoCoffees.slice(0, 1));
    const [b] = withRowHashes('capone-card-2222', twoCoffees.slice(0, 1));
    expect(a.row_hash).not.toBe(b.row_hash);
  });

  test('label case/whitespace variants hash identically (canonicalized inside the hash)', () => {
    const [a] = withRowHashes('Capone-Checking ', twoCoffees.slice(0, 1));
    const [b] = withRowHashes('capone-checking', twoCoffees.slice(0, 1));
    expect(a.row_hash).toBe(b.row_hash);
  });

  test('hashRow continues the ordinal sequence — the force-duplicates path can mint the next copy', () => {
    const [a, b] = withRowHashes('capone-card', twoCoffees);
    expect(a.ordinal).toBe(0);
    expect(b.ordinal).toBe(1);
    expect(hashRow('capone-card', twoCoffees[0], 1)).toBe(b.row_hash);
    const third = hashRow('capone-card', twoCoffees[0], 2);
    expect(third).not.toBe(a.row_hash);
    expect(third).not.toBe(b.row_hash);
  });
});

describe('transferSuggestion', () => {
  test.each([
    'CAPITAL ONE CRCARDPMT AUTH',
    'CAPITAL ONE ONLINE PYMT',
    'PAYMENT THANK YOU',
    'TRANSFER TO SAVINGS',
    'CAPITAL ONE MOBILE PYMT',
  ])('flags "%s" as an internal transfer', (desc) => {
    expect(transferSuggestion(desc)).toMatchObject({ ignore: true });
  });

  test('ordinary vendors are not flagged', () => {
    expect(transferSuggestion('WAWA 5211 VENICE FL')).toBeNull();
    expect(transferSuggestion('SITEONE LANDSCAPE SUPPLY')).toBeNull();
  });
});

describe('vendorEvidence', () => {
  test('shares a significant token between bank description and vendor', () => {
    expect(vendorEvidence('SITEONE LANDSCAPE SUPPLY 4471', { vendor_name: 'SiteOne', description: 'sod order' })).toBe(true);
    expect(vendorEvidence('SOME RANDOM STORE', { vendor_name: 'SiteOne', description: 'sod order' })).toBe(false);
  });

  test('short and stopword tokens are not evidence', () => {
    expect(vendorEvidence('THE ONLINE CARD PURCHASE LLC', { vendor_name: 'The LLC', description: 'online purchase' })).toBe(false);
  });

  test('evidence comes from vendor IDENTITY only — a description mentioning the same city is not it', () => {
    // "VENICE" appears in both, but only in the expense's free-form description
    expect(vendorEvidence('WAWA 5211 VENICE FL', { vendor_name: 'Ace Hardware', description: 'shop supplies Venice store' })).toBe(false);
  });

  test('local geography and pure numbers are never evidence, even inside vendor_name', () => {
    expect(vendorEvidence('WAWA 5211 VENICE FL', { vendor_name: 'Venice Print Co' })).toBe(false); // only VENICE shared
    expect(vendorEvidence('STORE 5211 PURCHASE', { vendor_name: 'Depot 5211' })).toBe(false); // only the number shared
    expect(vendorEvidence('WAWA 5211 VENICE FL', { vendor_name: 'Wawa' })).toBe(true); // the actual vendor still matches
  });

  test('an expense with no vendor_name can never auto-link', () => {
    expect(vendorEvidence('SITEONE LANDSCAPE SUPPLY', { vendor_name: null, description: 'SiteOne order' })).toBe(false);
  });
});

describe('date helpers', () => {
  test('parseDateCell handles all three statement formats', () => {
    expect(parseDateCell('08/09/2026')).toBe('2026-08-09');
    expect(parseDateCell('8/9/26')).toBe('2026-08-09');
    expect(parseDateCell('2026-08-09')).toBe('2026-08-09');
    expect(parseDateCell('garbage')).toBeNull();
  });

  test('shape-valid but impossible calendar dates are rejected (would abort the bulk insert)', () => {
    expect(parseDateCell('02/31/2026')).toBeNull();
    expect(parseDateCell('2026-99-01')).toBeNull();
    expect(parseDateCell('13/01/2026')).toBeNull();
    expect(parseDateCell('02/29/2028')).toBe('2028-02-29'); // real leap day survives
    expect(parseDateCell('02/29/2027')).toBeNull();
  });

  test('amounts beyond numeric(12,2) are skipped with a reason, not sent to the DB', () => {
    const csv = 'Date,Description,Amount\n08/10/2026,HUGE,-99999999999.00\n08/10/2026,FINE,-10.00';
    const { rows, skipped } = parseStatementCsv(csv);
    expect(rows).toHaveLength(1);
    expect(skipped[0].reason).toBe('amount exceeds storable range');
  });

  test('addDays crosses month boundaries as calendar math', () => {
    expect(addDays('2026-08-30', 5)).toBe('2026-09-04');
    expect(addDays('2026-08-02', -5)).toBe('2026-07-28');
  });
});

describe('runDeterministicMatching', () => {
  test('a credit with exactly one payout candidate links through a status CAS and echoes reconciliation', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'STRIPE PAYOUT', amount: 2418.66, direction: 'credit', account_type: 'bank', suggestion: null }];
    state.payouts = [{ id: 'po-1', amount: '2418.66', reconciled: false }];
    const summary = await runDeterministicMatching();
    expect(summary.payoutsLinked).toBe(1);
    const link = state.updates.find(u => u.patch.status === 'matched_payout');
    expect(link.patch.matched_payout_id).toBe('po-1');
    // CAS: the update is scoped to id AND status='unmatched'
    expect(link.where).toContainEqual({ id: 'bt-1', status: 'unmatched' });
    // reconciliation INTENT rides in the claim itself (crash-safe)…
    expect(link.patch.suggestion.reconcilePending).toBe(true);
    // …the echo goes through the existing mechanism with a row-specific
    // author under the unreconciled guard plus a still-linked precondition…
    expect(reconcilePayout).toHaveBeenCalledWith('po-1', 2418.66, expect.stringContaining('bt-1'), 'bank-import:bt-1', 'confirmed',
      expect.objectContaining({ onlyIfUnreconciled: true, precondition: expect.any(Function) }));
    // …and the flag clears via jsonb key-subtraction, CAS-scoped to THIS
    // link so it can never strip a newer link's pending flag
    const cleared = state.updates.find(u => typeof u.patch.suggestion === 'string' && u.patch.suggestion.includes("- 'reconcilePending'"));
    expect(cleared).toBeDefined();
    expect(cleared.where).toContainEqual({ id: 'bt-1', status: 'matched_payout', matched_payout_id: 'po-1' });
  });

  test('the pending flag ALWAYS rides in the claim — the guarded echo resolves current state', async () => {
    reconcilePayout.mockClear();
    // even a payout that LOOKS reconciled at candidate-read time gets the
    // flag: the unlocked pre-read can go stale, and the guard inside the
    // echo (onlyIfUnreconciled, row-locked) is the actual decision point
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'STRIPE PAYOUT', amount: 2418.66, direction: 'credit', account_type: 'bank', suggestion: null }];
    state.payouts = [{ id: 'po-1', amount: '2418.66', reconciled: true }];
    const summary = await runDeterministicMatching();
    expect(summary.payoutsLinked).toBe(1);
    const link = state.updates.find(u => u.patch.status === 'matched_payout');
    expect(link.patch.suggestion.reconcilePending).toBe(true);
    expect(reconcilePayout).toHaveBeenCalledWith('po-1', 2418.66, expect.any(String), 'bank-import:bt-1', 'confirmed',
      expect.objectContaining({ onlyIfUnreconciled: true }));
    // and the flag clears whether the echo wrote or was atomically skipped
    expect(state.updates.find(u => typeof u.patch.suggestion === 'string' && u.patch.suggestion.includes("- 'reconcilePending'"))).toBeDefined();
  });

  test('a CARD-statement credit never enters payout matching (refund/payment credit, not a payout)', async () => {
    reconcilePayout.mockClear();
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'MERCHANT REFUND', amount: 2418.66, direction: 'credit', account_type: 'card', suggestion: null }];
    state.payouts = [{ id: 'po-1', amount: '2418.66', reconciled: false }];
    const summary = await runDeterministicMatching();
    expect(summary.payoutsLinked).toBe(0);
    expect(state.queried.filter(t => t === 'stripe_payouts')).toHaveLength(0);
    // the only write is the noMatch demotion — never a link or a park
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].patch.suggestion).toEqual({ noMatch: true });
  });

  test('a debit with exactly one expense candidate links; two candidates park', async () => {
    state.bankRows = [
      { id: 'bt-1', txn_date: '2026-08-10', description: 'SITEONE', amount: 312.4, direction: 'debit', suggestion: null },
    ];
    state.expenses = [{ id: 'exp-1', amount: '312.40', description: 'SiteOne order', vendor_name: 'SiteOne', expense_date: '2026-08-10' }];
    let summary = await runDeterministicMatching();
    expect(summary.expensesLinked).toBe(1);
    expect(state.updates.find(u => u.patch.status === 'matched_expense').patch.matched_expense_id).toBe('exp-1');

    state.updates = [];
    state.expenses = [
      { id: 'exp-1', amount: '312.40', description: 'SiteOne order', vendor_name: 'SiteOne', expense_date: '2026-08-10' },
      { id: 'exp-2', amount: '312.40', description: 'SiteOne credit', vendor_name: 'SiteOne', expense_date: '2026-08-11' },
    ];
    summary = await runDeterministicMatching();
    expect(summary.expensesLinked).toBe(0);
    expect(summary.ambiguous).toBe(1);
    const parked = state.updates.find(u => u.patch.suggestion);
    expect(parked.patch.suggestion.candidates).toHaveLength(2);
    expect(state.updates.find(u => u.patch.status)).toBeUndefined();
  });

  test('exact amount WITHOUT vendor evidence parks instead of auto-linking', async () => {
    state.bankRows = [
      { id: 'bt-1', txn_date: '2026-08-10', description: 'SOME RANDOM STORE', amount: 312.4, direction: 'debit', suggestion: null },
    ];
    state.expenses = [{ id: 'exp-1', amount: '312.40', description: 'SiteOne order', vendor_name: 'SiteOne', expense_date: '2026-08-10' }];
    const summary = await runDeterministicMatching();
    expect(summary.expensesLinked).toBe(0);
    expect(summary.ambiguous).toBe(1);
    expect(state.updates.find(u => u.patch.status)).toBeUndefined();
    expect(state.updates.find(u => u.patch.suggestion).patch.suggestion.candidates).toHaveLength(1);
  });

  test('a second strong candidate anywhere in the set blocks auto-link (no cap can hide it)', async () => {
    state.bankRows = [
      { id: 'bt-1', txn_date: '2026-08-10', description: 'SITEONE LANDSCAPE', amount: 312.4, direction: 'debit', suggestion: null },
    ];
    // Two candidates BOTH exact-cent + vendor-evidence strong → must park.
    state.expenses = Array.from({ length: 8 }, (_, i) => (
      { id: `exp-${i}`, amount: '312.40', description: 'SiteOne order', vendor_name: 'SiteOne', expense_date: '2026-08-10' }
    ));
    const summary = await runDeterministicMatching();
    expect(summary.expensesLinked).toBe(0);
    expect(summary.ambiguous).toBe(1);
    expect(state.updates.find(u => u.patch.status)).toBeUndefined();
    // full candidate set is parked with its true total for the operator
    const parked = state.updates.find(u => u.patch.suggestion).patch.suggestion;
    expect(parked.candidates).toHaveLength(8);
    expect(parked.candidatesTotal).toBe(8);
  });

  test('near-miss amount (within candidate tolerance) never auto-links', async () => {
    state.bankRows = [
      { id: 'bt-1', txn_date: '2026-08-10', description: 'SITEONE LANDSCAPE', amount: 312.41, direction: 'debit', suggestion: null },
    ];
    state.expenses = [{ id: 'exp-1', amount: '312.40', description: 'SiteOne order', vendor_name: 'SiteOne', expense_date: '2026-08-10' }];
    const summary = await runDeterministicMatching();
    expect(summary.expensesLinked).toBe(0);
    expect(state.updates.find(u => u.patch.status)).toBeUndefined();
  });

  test('transfer-looking rows get the ignore suggestion and never query candidates', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-08', description: 'CAPITAL ONE CRCARDPMT', amount: 500, direction: 'debit', suggestion: null }];
    state.expenses = [{ id: 'exp-1', description: 'X', vendor_name: 'X', expense_date: '2026-08-08' }];
    const summary = await runDeterministicMatching();
    expect(summary.transferFlagged).toBe(1);
    expect(summary.expensesLinked).toBe(0);
    expect(state.queried.filter(t => t === 'expenses')).toHaveLength(0);
    expect(state.updates[0].patch.suggestion.ignore).toBe(true);
  });

  test('a failed reconciliation echo flags the row and the next pass retries it', async () => {
    // Pass 1: link succeeds, echo fails → row gains suggestion.reconcilePending
    reconcilePayout.mockRejectedValueOnce(new Error('bank_reconciliation insert failed'));
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'STRIPE PAYOUT', amount: 2418.66, direction: 'credit', account_type: 'bank', suggestion: null }];
    state.payouts = [{ id: 'po-1', amount: '2418.66', reconciled: false }];
    let summary = await runDeterministicMatching();
    expect(summary.payoutsLinked).toBe(1);
    // the flag was persisted IN the claim update (crash-safe), and the
    // failed echo adds no clearing update
    const link = state.updates.find(u => u.patch.status === 'matched_payout');
    expect(link.patch.suggestion.reconcilePending).toBe(true);
    expect(state.updates.find(u => typeof u.patch.suggestion === 'string')).toBeUndefined(); // no clearing update

    // Pass 2: the row is matched_payout + flagged → sweep retries and clears
    state.updates = [];
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', amount: '2418.66', direction: 'credit', account_type: 'bank', status: 'matched_payout', matched_payout_id: 'po-1', suggestion: { reconcilePending: true } }];
    summary = await runDeterministicMatching();
    expect(summary.reconcileRetried).toBe(1);
    expect(reconcilePayout).toHaveBeenLastCalledWith('po-1', 2418.66, expect.stringContaining('retry'), 'bank-import:bt-1', 'confirmed',
      expect.objectContaining({ onlyIfUnreconciled: true, precondition: expect.any(Function) }));
    const cleared = state.updates.find(u => typeof u.patch.suggestion === 'string' && u.patch.suggestion.includes("- 'reconcilePending'"));
    expect(cleared).toBeDefined();
    expect(cleared.where).toContainEqual({ id: 'bt-1', status: 'matched_payout', matched_payout_id: 'po-1' });
  });

  test("operator unlink rulings exclude ALL previously rejected targets, not just the latest", async () => {
    state.bankRows = [
      { id: 'bt-1', txn_date: '2026-08-11', description: 'STRIPE PAYOUT', amount: 2418.66, direction: 'credit', account_type: 'bank', suggestion: { rejectedPayoutIds: ['po-0'], lastUnlink: { was: 'matched_payout', payoutId: 'po-1' } } },
      { id: 'bt-2', txn_date: '2026-08-10', description: 'SITEONE LANDSCAPE', amount: 312.4, direction: 'debit', suggestion: { rejectedExpenseIds: ['exp-0'], lastUnlink: { was: 'matched_expense', expenseId: 'exp-1' } } },
    ];
    state.payouts = [];
    state.expenses = [];
    await runDeterministicMatching();
    const payoutBuilder = state.builders.find(x => x.table === 'stripe_payouts');
    expect(payoutBuilder.b.whereNotIn).toHaveBeenCalledWith('id', expect.arrayContaining(['po-0', 'po-1']));
    const expenseBuilder = state.builders.find(x => x.table === 'expenses');
    expect(expenseBuilder.b.whereNotIn).toHaveBeenCalledWith('id', expect.arrayContaining(['exp-0', 'exp-1']));
  });

  test('a card debit never auto-links to an expense the books say was paid by ACH/check/cash', async () => {
    state.bankRows = [
      { id: 'bt-1', txn_date: '2026-08-10', description: 'SITEONE LANDSCAPE', amount: 312.4, direction: 'debit', account_type: 'card', suggestion: null },
    ];
    state.expenses = [{ id: 'exp-1', amount: '312.40', description: 'SiteOne order', vendor_name: 'SiteOne', expense_date: '2026-08-10', payment_method: 'ach' }];
    const summary = await runDeterministicMatching();
    expect(summary.expensesLinked).toBe(0);
    expect(summary.ambiguous).toBe(1); // parks for the operator instead
    // an unknown payment method stays eligible
    state.updates = [];
    state.expenses = [{ id: 'exp-1', amount: '312.40', description: 'SiteOne order', vendor_name: 'SiteOne', expense_date: '2026-08-10', payment_method: null }];
    const second = await runDeterministicMatching();
    expect(second.expensesLinked).toBe(1);
  });

  test('ambiguous payout credits PARK their candidates for the manual link path', async () => {
    state.bankRows = [
      { id: 'bt-1', txn_date: '2026-08-11', description: 'DEPOSIT', amount: 2418.66, direction: 'credit', account_type: 'bank', suggestion: null },
    ];
    state.payouts = [
      { id: 'po-1', amount: '2418.66', arrival_date: '2026-08-10', reconciled: false },
      { id: 'po-2', amount: '2418.66', arrival_date: '2026-08-11', reconciled: false },
    ];
    const summary = await runDeterministicMatching();
    expect(summary.payoutsLinked).toBe(0);
    expect(summary.ambiguous).toBe(1);
    const parked = state.updates.find(u => u.patch.suggestion && u.patch.suggestion.payoutCandidates);
    expect(parked.patch.suggestion.payoutCandidates).toHaveLength(2);
    expect(parked.patch.suggestion.payoutCandidatesTotal).toBe(2);
    expect(parked.patch.suggestion.payoutCandidates[0]).toEqual({ id: 'po-1', amount: 2418.66, arrival_date: '2026-08-10' });
  });

  test('parked/flagged rows cannot starve fresh imports out of a bounded pass', async () => {
    state.bankRows = [
      // two OLD examined rows that stay unmatched by design
      { id: 'bt-old-1', txn_date: '2026-08-01', description: 'TRANSFERISH', amount: 9, direction: 'debit', suggestion: { ignore: true, reason: 'x' } },
      { id: 'bt-old-2', txn_date: '2026-08-02', description: 'AMBIG', amount: 9, direction: 'debit', suggestion: { candidates: [{ id: 'e' }], candidatesTotal: 1 } },
      // the FRESH row a naive oldest-first limit-2 scan would never reach
      { id: 'bt-new', txn_date: '2026-08-10', description: 'SITEONE LANDSCAPE', amount: 312.4, direction: 'debit', suggestion: null },
    ];
    state.expenses = [{ id: 'exp-1', amount: '312.40', description: 'SiteOne order', vendor_name: 'SiteOne', expense_date: '2026-08-10', payment_method: null }];
    const summary = await runDeterministicMatching({ limit: 2 });
    // the fresh row was processed (and linked) despite the two older parked rows
    expect(summary.expensesLinked).toBe(1);
    expect(state.updates.find(u => u.patch.status === 'matched_expense')).toBeDefined();
  });

  test('a processed row with NOTHING to propose is marked noMatch so bounded passes advance past it', async () => {
    state.bankRows = [
      { id: 'bt-1', txn_date: '2026-08-10', description: 'MYSTERY VENDOR', amount: 55, direction: 'debit', suggestion: null },
      { id: 'bt-2', txn_date: '2026-08-11', description: 'CARD REFUND', amount: 12, direction: 'credit', account_type: 'card', suggestion: null },
    ];
    state.expenses = [];
    await runDeterministicMatching();
    const marks = state.updates.filter(u => u.patch.suggestion && u.patch.suggestion.noMatch === true);
    expect(marks.map(m => m.where[0].id).sort()).toEqual(['bt-1', 'bt-2']);
    // already-marked rows are not re-written
    state.updates = [];
    state.bankRows = state.bankRows.map(r => ({ ...r, suggestion: { noMatch: true } }));
    await runDeterministicMatching();
    expect(state.updates).toHaveLength(0);
  });

  test("the sweep REVERTS a link whose reconciliation a human rejected — Tax never claims what Banking rejects", async () => {
    reconcilePayout.mockResolvedValueOnce({ payout_id: 'po-1', skipped: true, reason: 'human_rejected' });
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', amount: '2418.66', direction: 'credit', account_type: 'bank', status: 'matched_payout', matched_payout_id: 'po-1', suggestion: { reconcilePending: true } }];
    state.payouts = [{ id: 'po-1', reconciled: false }];
    const summary = await runDeterministicMatching();
    expect(summary.reconcileRetried).toBe(0);
    const revert = state.updates.find(u => u.patch.status === 'unmatched');
    expect(revert).toBeDefined();
    expect(revert.where).toContainEqual({ id: 'bt-1', status: 'matched_payout', matched_payout_id: 'po-1' });
    expect(revert.patch.matched_payout_id).toBeNull();
    // the rejected payout joins the row's exclusion list and the revert is audited
    expect(revert.patch.suggestion.rejectedPayoutIds).toEqual(['po-1']);
    expect(revert.patch.suggestion.autoRevert.payoutId).toBe('po-1');
    expect(revert.patch.suggestion.reconcilePending).toBeUndefined();
  });

  test('a bounded pass reports moreRemaining instead of scanning everything', async () => {
    state.bankRows = [
      { id: 'bt-1', txn_date: '2026-08-09', description: 'A', amount: 1, direction: 'debit', suggestion: null },
      { id: 'bt-2', txn_date: '2026-08-10', description: 'B', amount: 2, direction: 'debit', suggestion: null },
      { id: 'bt-3', txn_date: '2026-08-11', description: 'C', amount: 3, direction: 'debit', suggestion: null },
    ];
    state.expenses = [];
    const summary = await runDeterministicMatching({ limit: 2 });
    expect(summary.scanned).toBe(2);
    expect(summary.moreRemaining).toBe(true);
    const unbounded = await runDeterministicMatching();
    expect(unbounded.scanned).toBe(3);
    expect(unbounded.moreRemaining).toBe(false);
  });

  test('the transfer flag MERGES into suggestion — durable identity records survive', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-08', description: 'CAPITAL ONE CRCARDPMT', amount: 500, direction: 'debit', suggestion: { forceToken: 'tok-1', forcedFor: 'abc' } }];
    await runDeterministicMatching();
    const flagged = state.updates.find(u => u.patch.suggestion && u.patch.suggestion.ignore);
    expect(flagged.patch.suggestion).toMatchObject({ ignore: true, forceToken: 'tok-1', forcedFor: 'abc' });
  });

  test('an already-flagged transfer row is not re-flagged (idempotent)', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-08', description: 'TRANSFER TO SAVINGS', amount: 1000, direction: 'debit', suggestion: { ignore: true, reason: 'x' } }];
    const summary = await runDeterministicMatching();
    expect(summary.transferFlagged).toBe(0);
    expect(state.updates).toHaveLength(0);
  });
});

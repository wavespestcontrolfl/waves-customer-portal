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
};

function makeBuilder(table) {
  const b = {};
  const chain = (name) => { b[name] = jest.fn(() => b); };
  ['where', 'whereNot', 'whereBetween', 'whereRaw', 'whereIn', 'whereNull', 'whereNotExists',
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
    const rows = table === 'bank_transactions' ? state.bankRows
      : table === 'stripe_payouts' ? state.payouts
        : table === 'expenses' ? state.expenses : [];
    return Promise.resolve(rows).then(resolve, reject);
  };
  return b;
}

const mockDb = jest.fn((table) => makeBuilder(table));
mockDb.raw = jest.fn((sql) => sql);
jest.mock('../models/db', () => mockDb);

const {
  parseStatementCsv, withRowHashes, transferSuggestion,
  runDeterministicMatching, parseDateCell, addDays, vendorEvidence,
} = require('../services/bank-import');

beforeEach(() => {
  state.bankRows = [];
  state.payouts = [];
  state.expenses = [];
  state.updates = [];
  state.queried = [];
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
});

describe('date helpers', () => {
  test('parseDateCell handles all three statement formats', () => {
    expect(parseDateCell('08/09/2026')).toBe('2026-08-09');
    expect(parseDateCell('8/9/26')).toBe('2026-08-09');
    expect(parseDateCell('2026-08-09')).toBe('2026-08-09');
    expect(parseDateCell('garbage')).toBeNull();
  });

  test('addDays crosses month boundaries as calendar math', () => {
    expect(addDays('2026-08-30', 5)).toBe('2026-09-04');
    expect(addDays('2026-08-02', -5)).toBe('2026-07-28');
  });
});

describe('runDeterministicMatching', () => {
  test('a credit with exactly one payout candidate links through a status CAS', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'STRIPE PAYOUT', amount: 2418.66, direction: 'credit', suggestion: null }];
    state.payouts = [{ id: 'po-1', amount: '2418.66' }];
    const summary = await runDeterministicMatching();
    expect(summary.payoutsLinked).toBe(1);
    const link = state.updates.find(u => u.patch.status === 'matched_payout');
    expect(link.patch.matched_payout_id).toBe('po-1');
    // CAS: the update is scoped to id AND status='unmatched'
    expect(link.where).toContainEqual({ id: 'bt-1', status: 'unmatched' });
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
    // operator-facing suggestion list stays bounded even when the set is larger
    expect(state.updates.find(u => u.patch.suggestion).patch.suggestion.candidates).toHaveLength(6);
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

  test('an already-flagged transfer row is not re-flagged (idempotent)', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-08', description: 'TRANSFER TO SAVINGS', amount: 1000, direction: 'debit', suggestion: { ignore: true, reason: 'x' } }];
    const summary = await runDeterministicMatching();
    expect(summary.transferFlagged).toBe(0);
    expect(state.updates).toHaveLength(0);
  });
});

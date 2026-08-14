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
  reconRows: [],
  updates: [],
  queried: [],
  builders: [],
};

function makeBuilder(table) {
  const b = {};
  const chain = (name) => { b[name] = jest.fn(() => b); };
  ['join', 'leftJoin', 'joinRaw', 'forUpdate', 'where', 'andWhere', 'whereNot', 'whereNotIn', 'whereBetween', 'whereRaw', 'whereIn', 'whereNull', 'whereNotNull', 'whereNotExists',
    'orderBy', 'limit', 'groupBy', 'groupByRaw', 'havingRaw', 'select', 'first'].forEach(chain);
  b.update = jest.fn((patch) => {
    // Only row-scoped updates (where({id,...})) are the matcher's claims and
    // parks; the dangling-link heal sweep uses whereIn/whereNull and is
    // treated as a no-op here so it doesn't pollute the assertions.
    const wheres = b.where.mock.calls.map(c => c[0]);
    if (!wheres.some(w => w && typeof w === 'object' && 'id' in w)) return Promise.resolve(0);
    const u = { table, where: wheres, patch };
    state.updates.push(u);
    if (state.onUpdate) state.onUpdate(u); // concurrency hooks for race tests
    return Promise.resolve(1);
  });
  b.then = (resolve, reject) => {
    state.queried.push(table);
    let rows = table === 'bank_transactions' ? state.bankRows
      : table === 'stripe_payouts' ? state.payouts
        : table === 'expenses' ? state.expenses
          : table === 'bank_reconciliation' ? state.reconRows : [];
    // the heal queries join payouts: one scans UNRECONCILED links, the
    // amount-mismatch scan targets RECONCILED ones (both skip pending rows)
    if (table === 'bank_transactions as bt') {
      // the edited-expense-link heal is one narrow-column scan of every
      // surviving link (violation logic runs in JS in the service) —
      // return the joined link rows verbatim
      const expenseHealScan = b.where.mock.calls.some(c => c[0] === 'bt.status' && c[1] === 'matched_expense');
      if (expenseHealScan) {
        return Promise.resolve(state.bankRows
          .filter(r => r.status === 'matched_expense' && r.matched_expense_id)
          .flatMap(r => {
            const e = state.expenses.find(x => x.id === r.matched_expense_id);
            if (!e) return [];
            const rsum = state.bankRows
              .filter(x => x.status === 'refund_applied' && x.suggestion?.refundAppliedTo === e.id)
              .reduce((s, x) => s + Number(x.suggestion.refundAmount || 0), 0);
            return [{
              id: r.id, bt_amount: r.amount, txn_date: r.txn_date, description: r.description,
              account_type: r.account_type, match_method: r.match_method, expense_id: r.matched_expense_id,
              e_amount: e.amount, e_date: e.expense_date, vendor_name: e.vendor_name, payment_method: e.payment_method, rsum,
            }];
          })).then(resolve, reject);
      }
      // the orphan-refund heal anti-joins expenses on the suggestion target
      const refundScan = b.where.mock.calls.some(c => c[0] === 'bt.status' && c[1] === 'refund_applied');
      if (refundScan) {
        rows = state.bankRows
          .filter(r => r.status === 'refund_applied' && r.suggestion?.refundAppliedTo
            && !state.expenses.some(e => e.id === r.suggestion.refundAppliedTo))
          .map(r => ({ id: r.id, target: r.suggestion.refundAppliedTo }));
      } else if (b.whereRaw.mock.calls.some(c => String(c[0]).includes("reconcilePending' = 'true'"))) {
        // the pending-ineligible heal scan: pending links joined to their
        // payout columns
        rows = state.bankRows
          .filter(r => r.status === 'matched_payout' && r.matched_payout_id && r.suggestion && r.suggestion.reconcilePending === true)
          .map(r => {
            const p = state.payouts.find(pp => pp.id === r.matched_payout_id);
            return { ...r, payout_amount: p && p.amount, payout_status: p && p.status, arrival_date: p && p.arrival_date, payout_reconciled: !!(p && p.reconciled) };
          });
      } else {
        const wantReconciled = b.where.mock.calls.some(c => c[0] === 'sp.reconciled' && c[1] === true);
        rows = state.bankRows.filter(r => r.status === 'matched_payout'
          && r.matched_payout_id
          && !(r.suggestion && r.suggestion.reconcilePending)
          && state.payouts.some(p => p.id === r.matched_payout_id && p.reconciled === wantReconciled))
          // the scan JOINs payout columns — mirror them onto the row
          .map(r => {
            const p = state.payouts.find(pp => pp.id === r.matched_payout_id);
            return { ...r, payout_amount: p && p.amount, payout_status: p && p.status, arrival_date: p && p.arrival_date };
          });
      }
    }
    // the payout survey is amount-aware against the EFFECTIVE banked amount
    // (lateral latest-confirmed join) — mirror the mapping and the filter
    if (table === 'stripe_payouts' && b.joinRaw.mock.calls.some(c => String(c[0]).includes('actual_amount'))) {
      rows = rows.map(p => {
        const latest = state.reconRows.find(r => r.status === 'confirmed' && (r.payout_id === undefined || r.payout_id === p.id));
        const eff = p.reconciled && latest && latest.actual_amount != null ? Number(latest.actual_amount) : Number(p.amount);
        return { ...p, effective_amount: eff };
      });
      const effCall = b.whereRaw.mock.calls.find(c => String(c[0]).includes('coalesce(latest.actual_amount'));
      if (effCall && Array.isArray(effCall[1])) {
        rows = rows.filter(p => Math.abs(p.effective_amount - Number(effCall[1][0])) <= Number(effCall[1][1]) + 0.001);
      }
    }
    // the gross-candidate scan joins applied refunds back onto expenses —
    // mirror the join + having filter (gross within tolerance of the bound
    // amount) so gross matching is testable
    if (table === 'expenses as e') {
      const having = b.havingRaw.mock.calls[0];
      const target = having && Array.isArray(having[1]) ? Number(having[1][0]) : null;
      rows = state.expenses.map(e => {
        const refunds = state.bankRows.filter(r => r.status === 'refund_applied' && r.suggestion?.refundAppliedTo === e.id);
        if (!refunds.length) return null;
        const gross = Number(e.amount) + refunds.reduce((s, r) => s + Number(r.suggestion.refundAmount || 0), 0);
        return { ...e, gross_amount: gross };
      }).filter(Boolean).filter(e => target == null || Math.abs(e.gross_amount - target) <= 0.011);
    }
    // the debit matcher's NET query filters by amount in SQL — mirror it so
    // a refund-reduced expense is correctly absent from the net candidates
    if (table === 'expenses') {
      const absCall = b.whereRaw.mock.calls.find(c => String(c[0]).includes('abs(amount'));
      if (absCall && Array.isArray(absCall[1])) {
        rows = rows
          .filter(e => Math.abs(Number(e.amount) - Number(absCall[1][0])) <= Number(absCall[1][1]) + 0.001)
          // refund-reduced expenses are excluded from NET matching in SQL —
          // they participate only through the gross path
          .filter(e => !state.bankRows.some(r => r.status === 'refund_applied' && r.suggestion?.refundAppliedTo === e.id));
      }
      // date-window filters mirror the SQL (the refund lookback floors at
      // the credit's tax year — prior-year targets never surface)
      const between = b.whereBetween.mock.calls.find(c => c[0] === 'expense_date');
      if (between && Array.isArray(between[1])) {
        rows = rows.filter(e => e.expense_date >= between[1][0] && e.expense_date <= between[1][1]);
      }
    }
    // mirror the status + pending-flag filters so the unmatched loop and the
    // reconciliation sweep each see only their own rows (a row with no
    // status set counts as 'unmatched')
    if (table === 'bank_transactions') {
      // appliedRefundTotal aggregates refund credits for one expense — the
      // locked gross revalidation depends on it
      const refundSumCall = b.whereRaw.mock.calls.find(c => String(c[0]).includes('refundAppliedTo'));
      if (refundSumCall) {
        const expId = Array.isArray(refundSumCall[1]) ? refundSumCall[1][0] : refundSumCall[1];
        const total = state.bankRows
          .filter(r => r.status === 'refund_applied' && r.suggestion?.refundAppliedTo === expId)
          .reduce((s, r) => s + Number(r.suggestion.refundAmount || 0), 0);
        return Promise.resolve([{ total }]).then(resolve, reject);
      }
      const statusWhere = b.where.mock.calls.map(c => c[0]).find(a => a && typeof a === 'object' && 'status' in a);
      if (statusWhere) rows = rows.filter(r => (r.status || 'unmatched') === statusWhere.status);
      if (b.whereRaw.mock.calls.some(c => String(c[0]).includes('reconcilePending'))) {
        rows = rows.filter(r => r.suggestion && r.suggestion.reconcilePending === true);
      }
      for (const c of b.whereRaw.mock.calls.filter(cc => String(cc[0]).includes('verifyPending'))) {
        // "= 'true'" selects pending-verify rows (the sweeps); "<> 'true'"
        // EXCLUDES them (the echo retry fetch)
        if (String(c[0]).includes('<>')) rows = rows.filter(r => !(r.suggestion && r.suggestion.verifyPending === true));
        else rows = rows.filter(r => r.suggestion && r.suggestion.verifyPending === true);
      }
      // mirror the bounded pass's fresh-vs-examined split
      const isExamined = (r) => !!(r.suggestion && (r.suggestion.ignore || r.suggestion.candidates || r.suggestion.payoutCandidates || r.suggestion.refundCandidates || r.suggestion.noMatch));
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
// raw with bindings returns both (suggestionMerge asserts); binding-less
// raw stays a string (the jsonb key-subtraction clears assert on it)
mockDb.raw = jest.fn((sql, bindings) => (bindings ? { sql, bindings } : sql));
// transaction passthrough — the callback gets the same table router
mockDb.transaction = jest.fn(async (cb) => cb(mockDb));
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// A confirmed payout link must echo into the EXISTING reconciliation
// mechanism — stubbed here, asserted below.
jest.mock('../services/stripe-banking', () => ({ reconcilePayout: jest.fn(() => Promise.resolve({})) }));
const { reconcilePayout } = require('../services/stripe-banking');

const {
  parseStatementCsv, withRowHashes, hashRow, transferSuggestion,
  runDeterministicMatching, parseDateCell, addDays, vendorEvidence,
  isPlausibleExpenseLink, isPlausiblePayoutLink,
} = require('../services/bank-import');

// suggestion writes go through suggestionMerge → a raw {sql, bindings:[json]};
// this unwraps the merged payload (null for key-subtraction clears)
const sugOf = (u) => {
  const s = u.patch.suggestion;
  if (!s) return null;
  if (typeof s === 'string') return null;
  if (s.bindings) return JSON.parse(s.bindings[0]);
  return s;
};

beforeEach(() => {
  state.bankRows = [];
  state.payouts = [];
  state.expenses = [];
  state.reconRows = [];
  state.updates = [];
  state.queried = [];
  state.builders = [];
  state.onUpdate = null;
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

  test('a NUL byte in the description skips the row — one corrupted cell must not abort the bulk insert', () => {
    const csv = 'Transaction Date,Description,Debit,Credit\n08/01/2026,GOOD VENDOR,10.00,\n08/02/2026,BAD\u0000VENDOR,20.00,\n';
    const { rows, skipped } = parseStatementCsv(csv);
    expect(rows).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toContain('NUL');
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

describe('manual-link plausibility (same windows as the matcher)', () => {
  const row = { amount: '58.12', txn_date: '2026-08-09' };

  test('expense links require exact-tolerance amount and the ±5-day window', () => {
    expect(isPlausibleExpenseLink(row, { amount: '58.12', expense_date: '2026-08-12' })).toBe(true);
    expect(isPlausibleExpenseLink(row, { amount: '58.13', expense_date: '2026-08-12' })).toBe(true); // within tolerance
    expect(isPlausibleExpenseLink(row, { amount: '999.00', expense_date: '2026-08-12' })).toBe(false);
    expect(isPlausibleExpenseLink(row, { amount: '58.12', expense_date: '2026-08-20' })).toBe(false);
  });

  test('payout links require exact-tolerance amount and the ±3-day arrival window', () => {
    const credit = { amount: '2418.66', txn_date: '2026-08-11' };
    expect(isPlausiblePayoutLink(credit, { amount: '2418.66', arrival_date: '2026-08-08' })).toBe(true);
    expect(isPlausiblePayoutLink(credit, { amount: '2418.66', arrival_date: '2026-08-07' })).toBe(false);
    expect(isPlausiblePayoutLink(credit, { amount: '100.00', arrival_date: '2026-08-11' })).toBe(false);
  });
});

describe('date helpers', () => {
  test('parseDateCell handles all three statement formats', () => {
    expect(parseDateCell('08/09/2026')).toBe('2026-08-09');
    expect(parseDateCell('8/9/26')).toBe('2026-08-09');
    expect(parseDateCell('2026-08-09')).toBe('2026-08-09');
    expect(parseDateCell('garbage')).toBeNull();
  });

  test('year zero is rejected — PostgreSQL has no year 0 and it would abort the whole bulk insert', () => {
    expect(parseDateCell('0000-01-01')).toBeNull();
    expect(parseDateCell('01/01/0000')).toBeNull();
  });

  test('trailing garbage after an ISO date is rejected, not silently truncated; ISO datetimes still parse', () => {
    expect(parseDateCell('2026-04-15junk')).toBeNull();
    expect(parseDateCell('2026-04-150')).toBeNull();
    expect(parseDateCell('2026-04-15 10:30:00')).toBe('2026-04-15');
    expect(parseDateCell('2026-04-15T10:30:00Z')).toBe('2026-04-15');
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
    expect(sugOf(link).reconcilePending).toBe(true);
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
    expect(sugOf(link).reconcilePending).toBe(true);
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
    expect(sugOf(state.updates[0])).toEqual({ noMatch: true });
  });

  test('a debit with exactly one expense candidate links; two candidates park', async () => {
    state.bankRows = [
      { id: 'bt-1', txn_date: '2026-08-10', description: 'SITEONE', amount: 312.4, direction: 'debit', suggestion: null },
    ];
    state.expenses = [{ id: 'exp-1', amount: '312.40', description: 'SiteOne order', vendor_name: 'SiteOne', expense_date: '2026-08-10' }];
    let summary = await runDeterministicMatching();
    expect(summary.expensesLinked).toBe(1);
    expect(state.updates.find(u => u.patch.status === 'matched_expense').patch.matched_expense_id).toBe('exp-1');
    // the claim locked the candidate expense and revalidated it
    expect(state.builders.some(x => x.table === 'expenses' && x.b.forUpdate.mock.calls.length > 0)).toBe(true);

    state.updates = [];
    state.expenses = [
      { id: 'exp-1', amount: '312.40', description: 'SiteOne order', vendor_name: 'SiteOne', expense_date: '2026-08-10' },
      { id: 'exp-2', amount: '312.40', description: 'SiteOne credit', vendor_name: 'SiteOne', expense_date: '2026-08-11' },
    ];
    summary = await runDeterministicMatching();
    expect(summary.expensesLinked).toBe(0);
    expect(summary.ambiguous).toBe(1);
    const parked = state.updates.find(u => sugOf(u));
    expect(sugOf(parked).candidates).toHaveLength(2);
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
    expect(sugOf(state.updates.find(u => sugOf(u))).candidates).toHaveLength(1);
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
    const parked = sugOf(state.updates.find(u => sugOf(u)));
    expect(parked.candidates).toHaveLength(8);
    expect(parked.candidatesTotal).toBe(8);
  });

  test('one STRONG candidate among other window candidates still parks — plurality goes to the operator', async () => {
    state.bankRows = [
      { id: 'bt-1', txn_date: '2026-08-10', description: 'SITEONE LANDSCAPE', amount: 312.4, direction: 'debit', suggestion: null },
    ];
    state.expenses = [
      { id: 'exp-1', amount: '312.40', description: 'SiteOne order', vendor_name: 'SiteOne', expense_date: '2026-08-10' }, // strong
      { id: 'exp-2', amount: '312.40', description: 'unrelated', vendor_name: 'Somebody Else', expense_date: '2026-08-12' }, // weak, same window
    ];
    const summary = await runDeterministicMatching();
    expect(summary.expensesLinked).toBe(0);
    expect(summary.ambiguous).toBe(1);
    expect(state.updates.find(u => u.patch.status)).toBeUndefined();
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

  test('transfer-looking debits get the ignore flag and NEVER auto-link — but park candidates for manual linking', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-08', description: 'CAPITAL ONE CRCARDPMT', amount: 500, direction: 'debit', account_type: 'bank', suggestion: null }];
    state.expenses = [{ id: 'exp-1', amount: '500.00', description: 'card payment', vendor_name: 'Capital One', expense_date: '2026-08-08', payment_method: 'ach' }];
    const summary = await runDeterministicMatching();
    expect(summary.transferFlagged).toBe(1);
    expect(summary.expensesLinked).toBe(0); // suppression holds — never auto-matches
    expect(state.updates.find(u => u.patch.status)).toBeUndefined();
    const flagged = state.updates.find(u => sugOf(u) && sugOf(u).ignore);
    expect(sugOf(flagged).ignore).toBe(true);
    // the operator can still LINK the existing ledger expense instead of
    // being forced into a duplicate create or Ignore
    expect(sugOf(flagged).candidates).toHaveLength(1);
    expect(sugOf(flagged).candidates[0].id).toBe('exp-1');
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
    expect(sugOf(link).reconcilePending).toBe(true);
    // no update clears reconcilePending (raw-minus is a plain string; the
    // verifyPending clear after the successful uniqueness check is fine)
    expect(state.updates.find(u => typeof u.patch.suggestion === 'string' && u.patch.suggestion.includes('reconcilePending'))).toBeUndefined();

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
    // several expenses builders exist now (the refund-candidate scan is one)
    // — the DEBIT matcher's builder is the one that must carry the exclusion
    const expenseExcluded = state.builders.some(x => x.table === 'expenses'
      && x.b.whereNotIn.mock.calls.some(c => c[0] === 'id' && c[1].includes('exp-0') && c[1].includes('exp-1')));
    expect(expenseExcluded).toBe(true);
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

  test('a card-statement credit parks refund candidates (vendor evidence, amount ≥ credit) — never auto-applies', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'WAWA 5211 REFUND', amount: 20, direction: 'credit', account_type: 'card', suggestion: null }];
    state.expenses = [
      { id: 'exp-1', amount: '58.12', description: 'gas', vendor_name: 'Wawa', expense_date: '2026-08-01', payment_method: 'card' },
      { id: 'exp-2', amount: '58.12', description: 'unrelated', vendor_name: 'SiteOne', expense_date: '2026-08-01', payment_method: 'card' },
    ];
    const summary = await runDeterministicMatching();
    expect(summary.payoutsLinked).toBe(0);
    const parked = state.updates.find(u => sugOf(u) && sugOf(u).refundCandidates);
    expect(sugOf(parked).refundCandidates).toHaveLength(1); // vendor-evidence filtered
    expect(sugOf(parked).refundCandidates[0].id).toBe('exp-1');
    expect(state.updates.find(u => u.patch.status)).toBeUndefined(); // nothing auto-applied
  });

  test('a BANK credit no payout explains parks refund candidates (purchase refunded into checking)', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'WAWA 5211 REFUND', amount: 20, direction: 'credit', account_type: 'bank', suggestion: null }];
    state.payouts = []; // nothing to explain the credit
    state.expenses = [{ id: 'exp-1', amount: '58.12', description: 'gas', vendor_name: 'Wawa', expense_date: '2026-08-01', payment_method: 'ach' }];
    const summary = await runDeterministicMatching();
    expect(summary.payoutsLinked).toBe(0);
    const parked = state.updates.find(u => sugOf(u) && sugOf(u).refundCandidates);
    expect(parked).toBeDefined(); // the operator gets a refund path, not Ignore-only
    expect(sugOf(parked).refundCandidates[0].id).toBe('exp-1');
    // stale payout keys are subtracted in the same write — only one review
    // action list may be present at a time (the UI dispatches on it)
    expect(String(parked.patch.suggestion.sql)).toContain("'payoutCandidates'");
  });

  test('an ambiguous bank credit parks BOTH payout and refund candidates — the refund path is never hidden', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'WAWA 5211 REFUND', amount: 20, direction: 'credit', account_type: 'bank', suggestion: null }];
    // two unrelated same-amount payouts make the payout side ambiguous…
    state.payouts = [
      { id: 'po-1', amount: '20.00', arrival_date: '2026-08-10', reconciled: false },
      { id: 'po-2', amount: '20.00', arrival_date: '2026-08-11', reconciled: false },
    ];
    // …while the credit is really a refund of this purchase
    state.expenses = [{ id: 'exp-1', amount: '58.12', description: 'gas', vendor_name: 'Wawa', expense_date: '2026-08-01', payment_method: 'ach' }];
    const summary = await runDeterministicMatching();
    expect(summary.payoutsLinked).toBe(0);
    const parked = state.updates.find(u => sugOf(u) && sugOf(u).payoutCandidates);
    const sug = sugOf(parked);
    expect(sug.payoutCandidates).toHaveLength(2);
    expect(sug.refundCandidates).toHaveLength(1); // the union parks — no link-then-unlink dance
    expect(sug.refundCandidates[0].id).toBe('exp-1');
  });

  test('a bank credit with an eligible payout still prefers the payout path over refund parking', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'STRIPE DEPOSIT WAWA', amount: 20, direction: 'credit', account_type: 'bank', suggestion: null }];
    state.payouts = [{ id: 'po-1', amount: '20.00', arrival_date: '2026-08-11', reconciled: false }];
    state.expenses = [{ id: 'exp-1', amount: '58.12', description: 'gas', vendor_name: 'Wawa', expense_date: '2026-08-01', payment_method: 'ach' }];
    const summary = await runDeterministicMatching();
    expect(summary.payoutsLinked).toBe(1);
    expect(state.updates.find(u => sugOf(u) && sugOf(u).refundCandidates)).toBeUndefined();
  });

  test('refund candidates park likeliest-first (nearest covering amount, newest) and cap at 20 with an honest total', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'WAWA 5211 REFUND', amount: 20, direction: 'credit', account_type: 'card', suggestion: null }];
    state.expenses = [
      { id: 'exp-big', amount: '99.00', description: 'gas', vendor_name: 'Wawa', expense_date: '2026-08-05', payment_method: 'card' },
      { id: 'exp-old', amount: '21.00', description: 'gas', vendor_name: 'Wawa', expense_date: '2026-07-01', payment_method: 'card' },
      { id: 'exp-new', amount: '21.00', description: 'gas', vendor_name: 'Wawa', expense_date: '2026-08-05', payment_method: 'card' },
      ...Array.from({ length: 20 }, (_, i) => ({ id: `exp-f${String(i).padStart(2, '0')}`, amount: '25.00', description: 'gas', vendor_name: 'Wawa', expense_date: '2026-08-02', payment_method: 'card' })),
    ];
    await runDeterministicMatching();
    const parked = state.updates.find(u => sugOf(u) && sugOf(u).refundCandidates);
    const sug = sugOf(parked);
    expect(sug.refundCandidates).toHaveLength(20); // bounded display slice
    expect(sug.refundCandidatesTotal).toBe(23); // honest disclosure of the overflow
    // nearest covering amount first; same amount → most recent purchase first
    expect(sug.refundCandidates[0].id).toBe('exp-new');
    expect(sug.refundCandidates[1].id).toBe('exp-old');
    expect(sug.refundCandidates[sug.refundCandidates.length - 1].id).not.toBe('exp-big'); // 99.00 sorts last, off the slice
  });

  test('a bank debit never auto-links to a CASH expense — cash spend cannot be a bank transaction', async () => {
    state.bankRows = [
      { id: 'bt-1', txn_date: '2026-08-10', description: 'SITEONE LANDSCAPE', amount: 312.4, direction: 'debit', account_type: 'bank', suggestion: null },
    ];
    state.expenses = [{ id: 'exp-1', amount: '312.40', description: 'SiteOne order', vendor_name: 'SiteOne', expense_date: '2026-08-10', payment_method: 'cash' }];
    const summary = await runDeterministicMatching();
    expect(summary.expensesLinked).toBe(0);
    expect(summary.ambiguous).toBe(1); // parks for the operator instead
    // ach/check/card stay eligible for checking debits
    state.updates = [];
    state.expenses = [{ id: 'exp-1', amount: '312.40', description: 'SiteOne order', vendor_name: 'SiteOne', expense_date: '2026-08-10', payment_method: 'check' }];
    const second = await runDeterministicMatching();
    expect(second.expensesLinked).toBe(1);
  });

  test('a transfer-flagged CREDIT still parks refund candidates — Ignore is never the only action', async () => {
    // vendor refund whose descriptor contains a transfer word
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'WAWA REFUND TRANSFER', amount: 20, direction: 'credit', account_type: 'card', suggestion: null }];
    state.expenses = [{ id: 'exp-1', amount: '58.12', description: 'gas', vendor_name: 'Wawa', expense_date: '2026-08-01', payment_method: 'card' }];
    const summary = await runDeterministicMatching();
    expect(summary.transferFlagged).toBe(1);
    const flagged = state.updates.find(u => sugOf(u) && sugOf(u).ignore);
    expect(sugOf(flagged).refundCandidates).toHaveLength(1); // flag AND the refund action, one write
    expect(sugOf(flagged).refundCandidates[0].id).toBe('exp-1');
    expect(state.updates.find(u => u.patch.status)).toBeUndefined(); // still never auto-matches
  });

  test('a merchant merely CONTAINING "stripe" (PINSTRIPES) is not payout provenance — parks instead of linking', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'PINSTRIPES BRADENTON', amount: 500, direction: 'credit', account_type: 'bank', account_label: 'capone-checking', suggestion: null }];
    state.payouts = [{ id: 'po-1', amount: '500.00', arrival_date: '2026-08-11', reconciled: false, bank_last_four: '9876' }];
    const summary = await runDeterministicMatching();
    expect(summary.payoutsLinked).toBe(0); // a coincidental same-amount credit must not consume the payout
    const parked = state.updates.find(u => sugOf(u) && sugOf(u).payoutCandidates);
    expect(parked).toBeDefined();
  });

  test('parking candidates CLEARS a prior noMatch — stale lists cannot hide behind the early bump branch', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-10', description: 'SITEONE LANDSCAPE', amount: 312.4, direction: 'debit', account_type: 'card', suggestion: { noMatch: true } }];
    state.expenses = [
      { id: 'exp-1', amount: '312.40', description: 'order', vendor_name: 'SiteOne', expense_date: '2026-08-10', payment_method: 'card' },
      { id: 'exp-2', amount: '312.40', description: 'order 2', vendor_name: 'SiteOne', expense_date: '2026-08-10', payment_method: 'card' },
    ];
    await runDeterministicMatching();
    const parked = state.updates.find(u => sugOf(u) && sugOf(u).candidates);
    expect(parked).toBeDefined();
    expect(String(parked.patch.suggestion.sql)).toContain("'noMatch'"); // subtracted in the same write
    // each parked candidate carries its amount — one-cent near-misses are
    // otherwise indistinguishable in the picker
    expect(sugOf(parked).candidates[0].amount).toBe(312.4);
  });

  test('a retry the batch could NOT resolve (human draft) still reports more work remaining', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', amount: '100.00', direction: 'credit', account_type: 'bank', status: 'matched_payout', matched_payout_id: 'po-1', suggestion: { reconcilePending: true } }];
    state.payouts = [{ id: 'po-1', amount: '100.00', arrival_date: '2026-08-11', status: 'paid', reconciled: false }];
    reconcilePayout.mockResolvedValueOnce({ payout_id: 'po-1', skipped: true, reason: 'human_draft' });
    const summary = await runDeterministicMatching();
    expect(summary.reconcileRetried).toBe(0);
    expect(summary.moreRemaining).toBe(true); // the pending flag stayed — matching is NOT done
  });

  test('pending reconciliation retries are BOUNDED per pass with an honest morePending signal', async () => {
    state.bankRows = Array.from({ length: 27 }, (_, i) => ({
      id: `bt-${String(i).padStart(2, '0')}`, txn_date: '2026-08-11', amount: '100.00', direction: 'credit', account_type: 'bank',
      status: 'matched_payout', matched_payout_id: 'po-1', suggestion: { reconcilePending: true },
    }));
    state.payouts = [{ id: 'po-1', amount: '100.00', arrival_date: '2026-08-11', status: 'paid', reconciled: false }];
    const summary = await runDeterministicMatching();
    expect(summary.reconcilePending).toBe(25); // the batch, not the backlog
    expect(summary.moreRemaining).toBe(true); // the backlog is not silently "done"
  });

  test('a Stripe-shaped BANK credit is payout territory even when the description says TRANSFER', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'STRIPE TRANSFER ST-77', amount: 2418.66, direction: 'credit', account_type: 'bank', suggestion: null }];
    state.payouts = [{ id: 'po-1', amount: '2418.66', arrival_date: '2026-08-11', reconciled: false }];
    const summary = await runDeterministicMatching();
    expect(summary.transferFlagged).toBe(0); // the suppression would leave the deposit Ignore-only
    expect(summary.payoutsLinked).toBe(1);
    // debits keep the suppression — "STRIPE" money never leaves these accounts
    state.updates = [];
    state.bankRows = [{ id: 'bt-2', txn_date: '2026-08-11', description: 'STRIPE TRANSFER ST-78', amount: 100, direction: 'debit', account_type: 'bank', suggestion: null }];
    const second = await runDeterministicMatching();
    expect(second.transferFlagged).toBe(1);
  });

  test('a refund-REDUCED expense is never a net candidate — a coincidental same-net debit cannot consume it', async () => {
    // $100 purchase refunded $20 → expense now $80 net; a DISTINCT $80
    // debit from the same vendor must not auto-link to it (the expense
    // belongs to the original $100 debit via the gross path)
    state.bankRows = [
      { id: 'bt-credit', txn_date: '2026-08-05', description: 'WAWA 5211 REFUND', amount: 20, direction: 'credit', account_type: 'card', status: 'refund_applied', suggestion: { refundAppliedTo: 'exp-1', refundAmount: 20 } },
      { id: 'bt-debit', txn_date: '2026-08-02', description: 'WAWA 5211', amount: 80, direction: 'debit', account_type: 'card', suggestion: null },
    ];
    state.expenses = [{ id: 'exp-1', amount: '80.00', description: 'gas', vendor_name: 'Wawa', expense_date: '2026-08-01', payment_method: 'card' }];
    const summary = await runDeterministicMatching();
    expect(summary.expensesLinked).toBe(0);
    expect(state.updates.find(u => u.patch.status === 'matched_expense')).toBeUndefined();
  });

  test('candidate uniqueness is re-judged INSIDE the claim transaction — a mid-flight insert parks, not links', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-10', description: 'SITEONE LANDSCAPE', amount: 312.4, direction: 'debit', account_type: 'card', suggestion: null }];
    state.expenses = [{ id: 'exp-1', amount: '312.40', description: 'order', vendor_name: 'SiteOne', expense_date: '2026-08-10', payment_method: 'card' }];
    // a second same-amount, same-vendor expense lands AFTER the unlocked
    // survey but BEFORE the claim transaction acquires the lock
    mockDb.transaction.mockImplementationOnce(async (cb) => {
      state.expenses.push({ id: 'exp-2', amount: '312.40', description: 'order 2', vendor_name: 'SiteOne', expense_date: '2026-08-10', payment_method: 'card' });
      return cb(mockDb);
    });
    const summary = await runDeterministicMatching();
    expect(summary.expensesLinked).toBe(0);
    expect(state.updates.find(u => u.patch.status === 'matched_expense')).toBeUndefined();
  });

  test('a payout survey OVERFLOW parks candidates instead of auto-linking or staying forever fresh', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'STRIPE DEPOSIT', amount: 500, direction: 'credit', account_type: 'bank', suggestion: null }];
    state.payouts = Array.from({ length: 51 }, (_, i) => ({ id: `po-${String(i).padStart(2, '0')}`, amount: '500.00', arrival_date: '2026-08-11', reconciled: false }));
    const summary = await runDeterministicMatching();
    expect(summary.payoutsLinked).toBe(0); // uniqueness would be a guess over a truncated survey
    expect(summary.ambiguous).toBe(1);
    const parked = state.updates.find(u => sugOf(u) && sugOf(u).payoutCandidates);
    expect(parked).toBeDefined(); // the row leaves the fresh pool with candidates, not a bare continue
    expect(sugOf(parked).payoutCandidates).toHaveLength(20);
    expect(sugOf(parked).payoutCandidatesTotal).toBe(51);
  });

  test('ambiguous payout candidates park nearest-arrival-first with an honest total', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'DEPOSIT', amount: 500, direction: 'credit', account_type: 'bank', suggestion: null }];
    state.payouts = [
      { id: 'po-far', amount: '500.00', arrival_date: '2026-08-09', reconciled: false },
      { id: 'po-near', amount: '500.00', arrival_date: '2026-08-11', reconciled: false },
      { id: 'po-mid', amount: '500.00', arrival_date: '2026-08-10', reconciled: false },
    ];
    await runDeterministicMatching();
    const parked = state.updates.find(u => sugOf(u) && sugOf(u).payoutCandidates);
    const sug = sugOf(parked);
    expect(sug.payoutCandidates.map(c => c.id)).toEqual(['po-near', 'po-mid', 'po-far']);
    expect(sug.payoutCandidatesTotal).toBe(3);
  });

  test('an EDITED linked expense that no longer matches is healed — the link reverts to review', async () => {
    // linked at $100, operator later edits the expense to $120 → coverage
    // would keep counting least(100, 120) while the unique index blocks the
    // right expense from claiming the row
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-10', amount: '100.00', direction: 'debit', account_type: 'card', status: 'matched_expense', matched_expense_id: 'exp-1', suggestion: null }];
    state.expenses = [{ id: 'exp-1', amount: '120.00', vendor_name: 'SiteOne', expense_date: '2026-08-10', payment_method: 'card' }];
    const summary = await runDeterministicMatching();
    expect(summary.expenseLinksReverted).toBe(1);
    const revert = state.updates.find(u => u.patch.status === 'unmatched');
    expect(revert.where).toContainEqual({ id: 'bt-1', status: 'matched_expense', matched_expense_id: 'exp-1' });
    expect(sugOf(revert).autoRevert.reason).toContain('edited');
  });

  test('a crash between claim and verify is healed — the verifyPending sweep reverts a now-plural link', async () => {
    // the claim committed with the durable marker, then the process died
    // before the post-claim survey; a second candidate exists now
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-10', description: 'SITEONE LANDSCAPE', amount: '312.40', direction: 'debit', account_type: 'card', status: 'matched_expense', matched_expense_id: 'exp-1', suggestion: { verifyPending: true } }];
    state.expenses = [
      { id: 'exp-1', amount: '312.40', description: 'order', vendor_name: 'SiteOne', expense_date: '2026-08-10', payment_method: 'card' },
      { id: 'exp-2', amount: '312.40', description: 'order 2', vendor_name: 'SiteOne', expense_date: '2026-08-10', payment_method: 'card' },
    ];
    const summary = await runDeterministicMatching();
    expect(summary.claimVerifyReverted).toBe(1);
    const revert = state.updates.find(u => u.patch.status === 'unmatched');
    expect(revert.where).toContainEqual({ id: 'bt-1', status: 'matched_expense', matched_expense_id: 'exp-1' });
    expect(sugOf(revert).autoRevert.reason).toContain('ambiguous');
  });

  test('a crashed-but-still-unique claim just clears its verifyPending marker', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-10', description: 'SITEONE LANDSCAPE', amount: '312.40', direction: 'debit', account_type: 'card', status: 'matched_expense', matched_expense_id: 'exp-1', suggestion: { verifyPending: true } }];
    state.expenses = [{ id: 'exp-1', amount: '312.40', description: 'order', vendor_name: 'SiteOne', expense_date: '2026-08-10', payment_method: 'card' }];
    const summary = await runDeterministicMatching();
    expect(summary.claimVerifyReverted).toBe(0);
    expect(state.updates.find(u => u.patch.status === 'unmatched')).toBeUndefined();
    const clear = state.updates.find(u => typeof u.patch.suggestion === 'string' && u.patch.suggestion.includes('verifyPending'));
    expect(clear).toBeDefined();
  });

  test('an expense corrected back BETWEEN the heal scan and the lock keeps its link', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-10', amount: '100.00', direction: 'debit', account_type: 'card', status: 'matched_expense', matched_expense_id: 'exp-1', suggestion: null }];
    state.expenses = [{ id: 'exp-1', amount: '120.00', vendor_name: 'SiteOne', expense_date: '2026-08-10', payment_method: 'card' }];
    // the operator fixes the typo while the heal pass is mid-flight — the
    // locked re-read must see the corrected value and keep the link
    mockDb.transaction.mockImplementationOnce(async (cb) => {
      state.expenses[0] = { ...state.expenses[0], amount: '100.00' };
      return cb(mockDb);
    });
    const summary = await runDeterministicMatching();
    expect(summary.expenseLinksReverted).toBe(0);
    expect(state.updates.find(u => u.patch.status === 'unmatched')).toBeUndefined();
  });

  test('a refunded link whose NET was edited to equal the debit is healed — only the gross reading validates', async () => {
    state.bankRows = [
      { id: 'bt-1', txn_date: '2026-08-10', amount: '100.00', direction: 'debit', account_type: 'card', status: 'matched_expense', matched_expense_id: 'exp-1', suggestion: null },
      { id: 'bt-credit', txn_date: '2026-08-12', amount: 20, direction: 'credit', account_type: 'card', status: 'refund_applied', suggestion: { refundAppliedTo: 'exp-1', refundAmount: 20 } },
    ];
    // operator edited the net UP to 100 — gross is now 120, which no longer
    // explains the $100 debit; the net coincidence must not fake validity
    state.expenses = [{ id: 'exp-1', amount: '100.00', vendor_name: 'SiteOne', expense_date: '2026-08-10', payment_method: 'card' }];
    const summary = await runDeterministicMatching();
    expect(summary.expenseLinksReverted).toBe(1);
  });

  test('a crashed claim whose expense drifted one cent is NOT cleared — the sweep re-proves the full policy', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-10', description: 'SITEONE LANDSCAPE', amount: '312.40', direction: 'debit', account_type: 'card', status: 'matched_expense', match_method: 'expense_amount_date_vendor', matched_expense_id: 'exp-1', suggestion: { verifyPending: true } }];
    // within the one-cent candidate tolerance, so the survey still returns
    // the sole id — but the exact-cent automatic policy no longer holds
    state.expenses = [{ id: 'exp-1', amount: '312.41', description: 'order', vendor_name: 'SiteOne', expense_date: '2026-08-10', payment_method: 'card' }];
    const summary = await runDeterministicMatching();
    expect(summary.claimVerifyReverted).toBe(1);
    expect(state.updates.find(u => typeof u.patch.suggestion === 'string' && u.patch.suggestion.includes('verifyPending') && !u.patch.status)).toBeUndefined(); // never cleared
  });

  test('a refund-REDUCED linked expense is NOT healed away — its gross still matches the debit', async () => {
    state.bankRows = [
      { id: 'bt-1', txn_date: '2026-08-10', amount: '100.00', direction: 'debit', account_type: 'card', status: 'matched_expense', matched_expense_id: 'exp-1', suggestion: null },
      { id: 'bt-credit', txn_date: '2026-08-12', amount: 20, direction: 'credit', account_type: 'card', status: 'refund_applied', suggestion: { refundAppliedTo: 'exp-1', refundAmount: 20 } },
    ];
    state.expenses = [{ id: 'exp-1', amount: '80.00', vendor_name: 'SiteOne', expense_date: '2026-08-10', payment_method: 'card' }];
    const summary = await runDeterministicMatching();
    expect(summary.expenseLinksReverted).toBe(0);
    expect(state.updates.find(u => u.patch.status === 'unmatched')).toBeUndefined();
  });

  test('a phantom expense committing DURING the claim is caught by the post-claim verify', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-10', description: 'SITEONE LANDSCAPE', amount: 312.4, direction: 'debit', account_type: 'card', suggestion: null }];
    state.expenses = [{ id: 'exp-1', amount: '312.40', description: 'order', vendor_name: 'SiteOne', expense_date: '2026-08-10', payment_method: 'card' }];
    // the phantom's insert commits while the claim transaction is open —
    // invisible to the locked in-transaction recheck, visible to the
    // fresh-snapshot verify that follows the commit
    mockDb.transaction.mockImplementationOnce(async (cb) => {
      const out = await cb(mockDb);
      state.expenses.push({ id: 'exp-2', amount: '312.40', description: 'order 2', vendor_name: 'SiteOne', expense_date: '2026-08-10', payment_method: 'card' });
      return out;
    });
    const summary = await runDeterministicMatching();
    expect(summary.expensesLinked).toBe(0);
    const revert = state.updates.find(u => u.patch.status === 'unmatched');
    expect(revert).toBeDefined();
    expect(sugOf(revert).autoRevert.reason).toContain('ambiguous');
  });

  test('a stale confirmed actual on an UNRECONCILED payout is ignored — expected amount governs (no claim/revert loop)', async () => {
    // historical confirmed discrepancy (2400 actual), later rejected/unlinked
    // → reconciled is false, and the stale 2400 must NOT bait a claim the
    // echo would immediately revert
    state.payouts = [{ id: 'po-1', amount: '2418.66', arrival_date: '2026-08-11', reconciled: false }];
    state.reconRows = [{ payout_id: 'po-1', status: 'confirmed', actual_amount: '2400.00' }];
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'STRIPE DEPOSIT', amount: 2400.0, direction: 'credit', account_type: 'bank', suggestion: null }];
    let summary = await runDeterministicMatching();
    expect(summary.payoutsLinked).toBe(0);
    // the EXPECTED amount still matches normally
    state.updates = [];
    state.bankRows = [{ id: 'bt-2', txn_date: '2026-08-11', description: 'STRIPE DEPOSIT', amount: 2418.66, direction: 'credit', account_type: 'bank', suggestion: null }];
    summary = await runDeterministicMatching();
    expect(summary.payoutsLinked).toBe(1);
  });

  test('the matching payout is found even when 50+ other payouts crowd the window (amount-aware survey)', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'STRIPE DEPOSIT', amount: 500, direction: 'credit', account_type: 'bank', suggestion: null }];
    state.payouts = [
      ...Array.from({ length: 51 }, (_, i) => ({ id: `po-noise-${String(i).padStart(2, '0')}`, amount: '999.00', arrival_date: '2026-08-11', reconciled: false })),
      { id: 'po-match', amount: '500.00', arrival_date: '2026-08-11', reconciled: false },
    ];
    const summary = await runDeterministicMatching();
    // the old amount-BLIND fetch cap could truncate the window to 51 noise
    // rows and send this credit to no-match with no payout path at all
    expect(summary.payoutsLinked).toBe(1);
    expect(state.updates.find(u => u.patch.status === 'matched_payout').patch.matched_payout_id).toBe('po-match');
  });

  test('a payout arriving between survey and claim reverts the auto-link BEFORE any echo (post-claim verify)', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'STRIPE DEPOSIT', amount: 500, direction: 'credit', account_type: 'bank', suggestion: null }];
    state.payouts = [{ id: 'po-1', amount: '500.00', arrival_date: '2026-08-11', reconciled: false }];
    // the delayed payout webhook lands right after the claim CAS commits
    state.onUpdate = (u) => {
      if (u.patch.status === 'matched_payout') {
        state.onUpdate = null;
        state.payouts.push({ id: 'po-2', amount: '500.00', arrival_date: '2026-08-11', reconciled: false });
      }
    };
    const summary = await runDeterministicMatching();
    expect(summary.payoutsLinked).toBe(0);
    expect(reconcilePayout).not.toHaveBeenCalled(); // reverted claims are never echoed
    const revert = state.updates.find(u => u.patch.status === 'unmatched');
    expect(revert.where).toContainEqual({ id: 'bt-1', status: 'matched_payout', matched_payout_id: 'po-1' });
    expect(sugOf(revert).autoRevert.reason).toContain('ambiguous');
  });

  test('the ambiguity rollback REVERSES a reconciliation a concurrent retry confirmed mid-verify', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'STRIPE DEPOSIT', amount: 500, direction: 'credit', account_type: 'bank', suggestion: null }];
    state.payouts = [{ id: 'po-1', amount: '500.00', arrival_date: '2026-08-11', reconciled: false }];
    // between the claim and the post-claim verify: a concurrent pass's
    // pending-retry CONFIRMS our echo, and a same-amount payout arrives
    state.onUpdate = (u) => {
      if (u.patch.status === 'matched_payout') {
        state.onUpdate = null;
        state.payouts[0] = { ...state.payouts[0], reconciled: true, reconciled_by: 'bank-import:bt-1' };
        state.payouts.push({ id: 'po-2', amount: '500.00', arrival_date: '2026-08-11', reconciled: false });
        // the concurrent confirm carries an actual amount for effectivePayoutAmount
        state.reconRows = [{ payout_id: 'po-1', status: 'confirmed', actual_amount: '500.00' }];
      }
    };
    const summary = await runDeterministicMatching();
    expect(summary.payoutsLinked).toBe(0);
    const revert = state.updates.find(u => u.patch.status === 'unmatched');
    expect(revert).toBeDefined();
    // the reversal rides in the SAME transaction as the unlink — Banking
    // can never keep reporting the payout reconciled by an unlinked row
    expect(reconcilePayout).toHaveBeenCalledWith('po-1', 500, expect.stringContaining('Ambiguity rollback'), 'bank-import:bt-1', 'rejected', expect.objectContaining({ trx: expect.anything() }));
  });

  test('an AUTO-linked expense whose vendor was corrected away is healed; a matching vendor survives', async () => {
    state.bankRows = [
      { id: 'bt-changed', txn_date: '2026-08-10', description: 'SITEONE LANDSCAPE', amount: '100.00', direction: 'debit', account_type: 'card', status: 'matched_expense', match_method: 'expense_amount_date_vendor', matched_expense_id: 'exp-1', suggestion: null },
      { id: 'bt-kept', txn_date: '2026-08-10', description: 'SITEONE LANDSCAPE', amount: '100.00', direction: 'debit', account_type: 'card', status: 'matched_expense', match_method: 'expense_amount_date_vendor', matched_expense_id: 'exp-2', suggestion: null },
    ];
    state.expenses = [
      // operator corrected this expense to a different vendor — the auto
      // link's justification is gone
      { id: 'exp-1', amount: '100.00', vendor_name: 'Home Depot', expense_date: '2026-08-10', payment_method: 'card' },
      { id: 'exp-2', amount: '100.00', vendor_name: 'SiteOne', expense_date: '2026-08-10', payment_method: 'card' },
    ];
    const summary = await runDeterministicMatching();
    expect(summary.expenseLinksReverted).toBe(1);
    const revert = state.updates.find(u => u.patch.status === 'unmatched');
    expect(revert.where).toContainEqual({ id: 'bt-changed', status: 'matched_expense', matched_expense_id: 'exp-1', match_method: 'expense_amount_date_vendor' });
    expect(sugOf(revert).autoRevert.reason).toContain('vendor');
  });

  test('an AUTO-linked expense edited to an incompatible payment method is healed; a MANUAL link is not', async () => {
    state.bankRows = [
      { id: 'bt-auto', txn_date: '2026-08-10', amount: '100.00', direction: 'debit', account_type: 'card', status: 'matched_expense', match_method: 'expense_amount_date_vendor', matched_expense_id: 'exp-1', suggestion: null },
      { id: 'bt-manual', txn_date: '2026-08-10', amount: '100.00', direction: 'debit', account_type: 'card', status: 'matched_expense', match_method: 'manual', matched_expense_id: 'exp-2', suggestion: null },
    ];
    state.expenses = [
      { id: 'exp-1', amount: '100.00', vendor_name: 'SiteOne', expense_date: '2026-08-10', payment_method: 'cash' },
      { id: 'exp-2', amount: '100.00', vendor_name: 'SiteOne', expense_date: '2026-08-10', payment_method: 'cash' },
    ];
    const summary = await runDeterministicMatching();
    expect(summary.expenseLinksReverted).toBe(1);
    const revert = state.updates.find(u => u.patch.status === 'unmatched');
    expect(revert.where).toContainEqual({ id: 'bt-auto', status: 'matched_expense', matched_expense_id: 'exp-1', match_method: 'expense_amount_date_vendor' });
  });

  test('a payout claim that crashed before its verify is finished by the sweep — plural reverts, never echoes', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'STRIPE DEPOSIT', amount: '500.00', direction: 'credit', account_type: 'bank', status: 'matched_payout', matched_payout_id: 'po-1', suggestion: { reconcilePending: true, verifyPending: true } }];
    state.payouts = [
      { id: 'po-1', amount: '500.00', arrival_date: '2026-08-11', status: 'paid', reconciled: false },
      { id: 'po-2', amount: '500.00', arrival_date: '2026-08-11', status: 'paid', reconciled: false },
    ];
    const summary = await runDeterministicMatching();
    expect(summary.payoutVerifyReverted).toBe(1);
    expect(reconcilePayout).not.toHaveBeenCalled(); // the pending retry never echoed the unverified claim
    const revert = state.updates.find(u => u.patch.status === 'unmatched');
    expect(revert.where).toContainEqual({ id: 'bt-1', status: 'matched_payout', matched_payout_id: 'po-1' });
    expect(sugOf(revert).autoRevert.reason).toContain('ambiguous');
  });

  test('a crashed-but-still-unique payout claim clears its marker (the echo then reaches it next fetch)', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'STRIPE DEPOSIT', amount: '500.00', direction: 'credit', account_type: 'bank', status: 'matched_payout', matched_payout_id: 'po-1', suggestion: { reconcilePending: true, verifyPending: true } }];
    state.payouts = [{ id: 'po-1', amount: '500.00', arrival_date: '2026-08-11', status: 'paid', reconciled: false }];
    const summary = await runDeterministicMatching();
    expect(summary.payoutVerifyReverted).toBe(0);
    expect(state.updates.find(u => u.patch.status === 'unmatched')).toBeUndefined();
    const clear = state.updates.find(u => typeof u.patch.suggestion === 'string' && u.patch.suggestion.includes('verifyPending'));
    expect(clear).toBeDefined();
    // the retry fetch EXCLUDES unverified rows — nothing echoed this pass
    expect(reconcilePayout).not.toHaveBeenCalled();
  });

  test('a RECONCILED payout whose status flipped (amount unchanged) reverts at the echo re-check too', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', amount: '2418.66', direction: 'credit', account_type: 'bank', status: 'matched_payout', matched_payout_id: 'po-1', suggestion: { reconcilePending: true } }];
    // webhook flipped status while reconciled stayed true; the confirmed
    // amount still matches — the old amount-only re-check kept the link
    state.payouts = [{ id: 'po-1', amount: '2418.66', arrival_date: '2026-08-11', status: 'failed', reconciled: true }];
    state.reconRows = [{ payout_id: 'po-1', status: 'confirmed', actual_amount: '2418.66' }];
    reconcilePayout.mockResolvedValueOnce({ payout_id: 'po-1', skipped: true, reason: 'guard' });
    const summary = await runDeterministicMatching();
    expect(summary.reconcileRetried).toBe(0);
    const revert = state.updates.find(u => u.patch.status === 'unmatched');
    expect(revert).toBeDefined();
    expect(sugOf(revert).autoRevert.reason).toContain('no longer eligible');
  });

  test('a linked payout that turned INELIGIBLE (webhook rewrote it) reverts instead of confirming', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', amount: '2418.66', direction: 'credit', account_type: 'bank', status: 'matched_payout', matched_payout_id: 'po-1', suggestion: { reconcilePending: true } }];
    // the payout.failed webhook landed after matching — status is no longer paid
    state.payouts = [{ id: 'po-1', amount: '2418.66', arrival_date: '2026-08-11', status: 'failed', reconciled: false }];
    reconcilePayout.mockResolvedValueOnce({ payout_id: 'po-1', skipped: true, reason: 'precondition' });
    const summary = await runDeterministicMatching();
    expect(summary.reconcileRetried).toBe(0);
    const revert = state.updates.find(u => u.patch.status === 'unmatched');
    expect(revert).toBeDefined();
    expect(revert.where).toContainEqual({ id: 'bt-1', status: 'matched_payout', matched_payout_id: 'po-1' });
    expect(sugOf(revert).autoRevert.reason).toContain('no longer eligible');
  });

  test('a full-price debit still matches its expense after a refund reduced it (GROSS matching)', async () => {
    // refund applied BEFORE the original debit was imported: expense is now
    // $38.12 net, but the statement debit carries the gross $58.12
    state.bankRows = [
      { id: 'bt-credit', txn_date: '2026-08-05', description: 'WAWA 5211 REFUND', amount: 20, direction: 'credit', account_type: 'card', status: 'refund_applied', suggestion: { refundAppliedTo: 'exp-1', refundAmount: 20 } },
      { id: 'bt-debit', txn_date: '2026-08-02', description: 'WAWA 5211', amount: 58.12, direction: 'debit', account_type: 'card', suggestion: null },
    ];
    state.expenses = [{ id: 'exp-1', amount: '38.12', description: 'gas', vendor_name: 'Wawa', expense_date: '2026-08-01', payment_method: 'card' }];
    const summary = await runDeterministicMatching();
    expect(summary.expensesLinked).toBe(1);
    const claim = state.updates.find(u => u.patch.status === 'matched_expense');
    expect(claim.patch.matched_expense_id).toBe('exp-1');
    // the refund credit row itself is never disturbed by the pass
    expect(state.updates.find(u => u.where.some(w => w && w.id === 'bt-credit'))).toBeUndefined();
  });

  test('an amount+date-only match WITHOUT provenance parks instead of auto-linking', async () => {
    // same amount, right window — but nothing says this deposit IS the payout
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'CHECK DEPOSIT 1042', amount: 2418.66, direction: 'credit', account_type: 'bank', account_label: 'capone-checking', suggestion: null }];
    state.payouts = [{ id: 'po-1', amount: '2418.66', arrival_date: '2026-08-11', reconciled: false, bank_last_four: '9876' }];
    const summary = await runDeterministicMatching();
    expect(summary.payoutsLinked).toBe(0);
    expect(summary.ambiguous).toBe(1); // parks for the operator
    const parked = state.updates.find(u => sugOf(u) && sugOf(u).payoutCandidates);
    expect(parked).toBeDefined();
  });

  test('account-label last-4 provenance links when the description is not Stripe-shaped', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'ACH CREDIT SETTLEMENT', amount: 2418.66, direction: 'credit', account_type: 'bank', account_label: 'capone-checking-9876', suggestion: null }];
    state.payouts = [{ id: 'po-1', amount: '2418.66', arrival_date: '2026-08-11', reconciled: false, bank_last_four: '9876' }];
    const summary = await runDeterministicMatching();
    expect(summary.payoutsLinked).toBe(1);
  });

  test('a Banking-derived rejection lifts once a corrected CONFIRMED reconciliation lands', async () => {
    // the payout was auto-reverted earlier (bankingRejectedPayoutIds), then a
    // human corrected course and confirmed a matching reconciliation
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'STRIPE PAYOUT ST-9', amount: 2400.0, direction: 'credit', account_type: 'bank', suggestion: { bankingRejectedPayoutIds: ['po-1'], autoRevert: { payoutId: 'po-1' } } }];
    state.payouts = [{ id: 'po-1', amount: '2418.66', arrival_date: '2026-08-11', reconciled: true, bank_last_four: null }];
    state.reconRows = [{ status: 'confirmed', actual_amount: '2400.00' }];
    const summary = await runDeterministicMatching();
    expect(summary.payoutsLinked).toBe(1); // eligible again — the rejection no longer stands

    // …but while the payout stays unreconciled, the derived rejection holds
    state.updates = [];
    state.payouts = [{ id: 'po-1', amount: '2400.00', arrival_date: '2026-08-11', reconciled: false, bank_last_four: null }];
    state.reconRows = [];
    const second = await runDeterministicMatching();
    expect(second.payoutsLinked).toBe(0);
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
    const parked = state.updates.find(u => sugOf(u) && sugOf(u).payoutCandidates);
    expect(sugOf(parked).payoutCandidates).toHaveLength(2);
    expect(sugOf(parked).payoutCandidatesTotal).toBe(2);
    // nearest arrival to the posting date parks first
    expect(sugOf(parked).payoutCandidates[0]).toEqual({ id: 'po-2', amount: 2418.66, arrival_date: '2026-08-11' });
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

  test('an empty rescan CLEARS stale parked candidates while demoting to noMatch', async () => {
    // the parked expense was deleted/claimed since — the rescan finds none
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-10', description: 'MYSTERY', amount: 55, direction: 'debit', suggestion: { candidates: [{ id: 'exp-gone' }], candidatesTotal: 1 } }];
    state.expenses = [];
    await runDeterministicMatching();
    const mark = state.updates.find(u => sugOf(u) && sugOf(u).noMatch === true);
    expect(mark).toBeDefined();
    // the merge SUBTRACTS the stale candidate keys so the UI stops offering them
    expect(mark.patch.suggestion.sql).toContain("- 'candidates'");
    expect(mark.patch.suggestion.sql).toContain("- 'payoutCandidates'");
    expect(mark.patch.suggestion.sql).toContain("- 'refundCandidates'");
  });

  test('a processed row with NOTHING to propose is marked noMatch so bounded passes advance past it', async () => {
    state.bankRows = [
      { id: 'bt-1', txn_date: '2026-08-10', description: 'MYSTERY VENDOR', amount: 55, direction: 'debit', suggestion: null },
      { id: 'bt-2', txn_date: '2026-08-11', description: 'CARD REFUND', amount: 12, direction: 'credit', account_type: 'card', suggestion: null },
    ];
    state.expenses = [];
    await runDeterministicMatching();
    const marks = state.updates.filter(u => sugOf(u) && sugOf(u).noMatch === true);
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
    state.payouts = [{ id: 'po-1', amount: '2418.66', arrival_date: '2026-08-11', status: 'paid', reconciled: false }];
    state.reconRows = [{ status: 'rejected', reconciled_by: 'adam' }]; // the locked re-check confirms the ruling still stands
    const summary = await runDeterministicMatching();
    expect(summary.reconcileRetried).toBe(0);
    const revert = state.updates.find(u => u.patch.status === 'unmatched');
    expect(revert).toBeDefined();
    expect(revert.where).toContainEqual({ id: 'bt-1', status: 'matched_payout', matched_payout_id: 'po-1' });
    expect(revert.patch.matched_payout_id).toBeNull();
    // the rejected payout joins the row's exclusion list and the revert is audited
    expect(sugOf(revert).bankingRejectedPayoutIds).toEqual(['po-1']);
    expect(sugOf(revert).autoRevert.payoutId).toBe('po-1');
    expect(sugOf(revert).reconcilePending).toBeUndefined();
  });

  test('a LATER human rejection heals: the still-matched row is reverted next pass', async () => {
    // echo long done (no pending flag), then a human rejected the payout on Banking
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', amount: '2418.66', direction: 'credit', account_type: 'bank', status: 'matched_payout', matched_payout_id: 'po-1', suggestion: null }];
    state.payouts = [{ id: 'po-1', amount: '2418.66', arrival_date: '2026-08-11', status: 'paid', reconciled: false }];
    state.reconRows = [{ status: 'rejected', reconciled_by: 'adam' }];
    const summary = await runDeterministicMatching();
    expect(summary.linksReverted).toBe(1);
    const revert = state.updates.find(u => u.patch.status === 'unmatched');
    expect(revert.where).toContainEqual({ id: 'bt-1', status: 'matched_payout', matched_payout_id: 'po-1' });
    expect(sugOf(revert).bankingRejectedPayoutIds).toEqual(['po-1']);
    expect(sugOf(revert).autoRevert.payoutId).toBe('po-1');
    // the decision was made under the payout row lock, state re-read inside
    const lockingBuilder = state.builders.find(x => x.table === 'stripe_payouts' && x.b.forUpdate.mock.calls.length > 0);
    expect(lockingBuilder).toBeDefined();
  });

  test('a payout reconciled DISCREPANTLY mid-echo reverts the fresh link instead of finalizing it', async () => {
    // validated as unreconciled/matching, then a human reconciles it with a
    // different banked amount DURING the echo → guard skip + revalidation
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'STRIPE PAYOUT ST-77', amount: 2418.66, direction: 'credit', account_type: 'bank', suggestion: null }];
    state.payouts = [{ id: 'po-1', amount: '2418.66', arrival_date: '2026-08-11', reconciled: false }];
    reconcilePayout.mockImplementationOnce(async () => {
      state.payouts = [{ id: 'po-1', amount: '2418.66', arrival_date: '2026-08-11', reconciled: true }];
      state.reconRows = [{ status: 'confirmed', actual_amount: '2400.00' }];
      return { payout_id: 'po-1', skipped: true, reason: 'guard' };
    });
    const summary = await runDeterministicMatching();
    expect(summary.amountMismatchReverted).toBe(1);
    expect(summary.payoutsLinked).toBe(0); // decremented back
    const revert = state.updates.find(u => u.patch.status === 'unmatched');
    expect(revert.where).toContainEqual({ id: 'bt-1', status: 'matched_payout', matched_payout_id: 'po-1' });
    expect(sugOf(revert).autoRevert.reason).toContain('different banked amount');
  });

  test('a reconciled payout with a DISCREPANT confirmed amount matches by its actual banked amount', async () => {
    // Stripe expected 2418.66, but a human confirmed 2400.00 actually landed
    state.payouts = [{ id: 'po-1', amount: '2418.66', arrival_date: '2026-08-11', reconciled: true }];
    state.reconRows = [{ status: 'confirmed', actual_amount: '2400.00' }];

    // a credit matching only the EXPECTED amount is not explained by it
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', description: 'DEPOSIT', amount: 2418.66, direction: 'credit', account_type: 'bank', suggestion: null }];
    let summary = await runDeterministicMatching();
    expect(summary.payoutsLinked).toBe(0);
    expect(state.updates.find(u => u.patch.status === 'matched_payout')).toBeUndefined();

    // a credit matching the ACTUAL banked amount links — the old SQL
    // expected-amount filter would have dropped this candidate entirely
    state.updates = [];
    state.bankRows = [{ id: 'bt-2', txn_date: '2026-08-11', description: 'STRIPE DEPOSIT', amount: 2400.0, direction: 'credit', account_type: 'bank', suggestion: null }];
    summary = await runDeterministicMatching();
    expect(summary.payoutsLinked).toBe(1);
    expect(state.updates.find(u => u.patch.status === 'matched_payout').patch.matched_payout_id).toBe('po-1');
  });

  test('a linked-but-unreconciled row with NO human rejection gets its pending marker restored', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', amount: '2418.66', direction: 'credit', account_type: 'bank', status: 'matched_payout', matched_payout_id: 'po-1', suggestion: null }];
    state.payouts = [{ id: 'po-1', amount: '2418.66', arrival_date: '2026-08-11', status: 'paid', reconciled: false }];
    state.reconRows = []; // no rejection on record — this is a lost marker
    const summary = await runDeterministicMatching();
    expect(summary.linksRemarked).toBe(1);
    const remark = state.updates.find(u => sugOf(u) && sugOf(u).reconcilePending === true && !u.patch.status);
    expect(remark).toBeDefined();
  });

  test('bounded passes ROTATE the examined pool — rescanned noMatch rows go to the back of the queue', async () => {
    state.bankRows = [
      { id: 'bt-1', txn_date: '2026-08-01', description: 'A', amount: 1, direction: 'debit', suggestion: { noMatch: true } },
      { id: 'bt-2', txn_date: '2026-08-02', description: 'B', amount: 2, direction: 'debit', suggestion: { noMatch: true } },
    ];
    state.expenses = [];
    await runDeterministicMatching({ limit: 5 });
    // each rescan writes an updated_at-only bump (rotation), never re-marks
    const bumps = state.updates.filter(u => u.patch.updated_at && !u.patch.suggestion && !u.patch.status);
    expect(bumps).toHaveLength(2);
  });

  test('a pending link whose payout was reconciled DISCREPANTLY while waiting is reverted by the sweep', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', amount: '2418.66', direction: 'credit', account_type: 'bank', status: 'matched_payout', matched_payout_id: 'po-1', suggestion: { reconcilePending: true } }];
    state.payouts = [{ id: 'po-1', amount: '2418.66', reconciled: true }];
    state.reconRows = [{ status: 'confirmed', actual_amount: '2400.00' }];
    reconcilePayout.mockResolvedValueOnce({ payout_id: 'po-1', skipped: true, reason: 'guard' });
    const summary = await runDeterministicMatching();
    expect(summary.reconcileRetried).toBe(0);
    const revert = state.updates.find(u => u.patch.status === 'unmatched');
    expect(revert).toBeDefined();
    // the page-load heal scan now catches this BEFORE the echo retry —
    // reconciled+pending rows are revalidated under the payout lock
    expect(sugOf(revert).autoRevert.reason).toContain('no longer eligible');
  });

  test('moreRemaining stays true when the fresh pool fills the limit but examined rows still exist', async () => {
    state.bankRows = [
      { id: 'bt-1', txn_date: '2026-08-09', description: 'A', amount: 1, direction: 'debit', suggestion: null },
      { id: 'bt-2', txn_date: '2026-08-10', description: 'B', amount: 2, direction: 'debit', suggestion: null },
      { id: 'bt-3', txn_date: '2026-08-01', description: 'OLD', amount: 3, direction: 'debit', suggestion: { noMatch: true } },
    ];
    state.expenses = [];
    const summary = await runDeterministicMatching({ limit: 2 });
    expect(summary.scanned).toBe(2); // fresh pool exactly fills the limit
    expect(summary.moreRemaining).toBe(true); // …but the examined row is not forgotten
  });

  test("a human DRAFT reconciliation pauses automation — no re-mark, no revert, no re-confirm", async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', amount: '2418.66', direction: 'credit', account_type: 'bank', status: 'matched_payout', matched_payout_id: 'po-1', suggestion: null }];
    state.payouts = [{ id: 'po-1', amount: '2418.66', arrival_date: '2026-08-11', status: 'paid', reconciled: false }];
    state.reconRows = [{ status: 'draft', reconciled_by: 'adam' }];
    const summary = await runDeterministicMatching();
    expect(summary.linksRemarked).toBe(0);
    expect(summary.linksReverted).toBe(0);
    expect(state.updates).toHaveLength(0);
    expect(reconcilePayout).not.toHaveBeenCalled();
  });

  test('a RECONCILED link whose later human reconciliation carries a different amount is reverted', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', amount: '2418.66', direction: 'credit', account_type: 'bank', status: 'matched_payout', matched_payout_id: 'po-1', suggestion: null }];
    state.payouts = [{ id: 'po-1', amount: '2418.66', arrival_date: '2026-08-11', status: 'paid', reconciled: true }];
    state.reconRows = [{ payout_id: 'po-1', status: 'confirmed', actual_amount: '2000.00', reconciled_by: 'adam' }];
    const summary = await runDeterministicMatching();
    expect(summary.linksReverted).toBe(1);
    const revert = state.updates.find(u => u.patch.status === 'unmatched');
    expect(revert.where).toContainEqual({ id: 'bt-1', status: 'matched_payout', matched_payout_id: 'po-1' });
    expect(sugOf(revert).autoRevert.reason).toContain('no longer explains');
  });

  test('a RECONCILED link whose payout later FAILED (amount unchanged) is reverted — the credit is not hidden', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', amount: '2418.66', direction: 'credit', account_type: 'bank', status: 'matched_payout', matched_payout_id: 'po-1', suggestion: null }];
    // payout.failed webhook AFTER the echo succeeded: reconciled stays true,
    // amount unchanged — only status flipped; the echo was BANK-authored
    state.payouts = [{ id: 'po-1', amount: '2418.66', arrival_date: '2026-08-11', status: 'failed', reconciled: true, reconciled_by: 'bank-import:bt-1' }];
    state.reconRows = [{ payout_id: 'po-1', status: 'confirmed', actual_amount: '2418.66' }];
    const summary = await runDeterministicMatching();
    expect(summary.linksReverted).toBe(1);
    expect(sugOf(state.updates.find(u => u.patch.status === 'unmatched')).autoRevert.reason).toContain('status');
    // our OWN reconciliation is reversed in the same transaction — Banking
    // must not keep a confirmed reconciliation authored by an unmatched row
    expect(reconcilePayout).toHaveBeenCalledWith('po-1', 2418.66, expect.stringContaining('Eligibility revert'), 'bank-import:bt-1', 'rejected', expect.objectContaining({ trx: expect.anything() }));
  });

  test('a HUMAN-authored reconciliation survives an eligibility revert — only the link is released', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', amount: '2418.66', direction: 'credit', account_type: 'bank', status: 'matched_payout', matched_payout_id: 'po-1', suggestion: null }];
    state.payouts = [{ id: 'po-1', amount: '2418.66', arrival_date: '2026-08-11', status: 'failed', reconciled: true, reconciled_by: 'adam' }];
    state.reconRows = [{ payout_id: 'po-1', status: 'confirmed', actual_amount: '2418.66' }];
    const summary = await runDeterministicMatching();
    expect(summary.linksReverted).toBe(1);
    expect(reconcilePayout).not.toHaveBeenCalled();
  });

  test('the healer holds EXACT cents for auto links; manual links keep the one-cent tolerance', async () => {
    state.bankRows = [
      { id: 'bt-auto', txn_date: '2026-08-10', amount: '100.00', direction: 'debit', account_type: 'card', status: 'matched_expense', match_method: 'expense_amount_date_vendor', matched_expense_id: 'exp-1', description: 'SITEONE LANDSCAPE', suggestion: null },
      { id: 'bt-manual', txn_date: '2026-08-10', amount: '100.00', direction: 'debit', account_type: 'card', status: 'matched_expense', match_method: 'manual', matched_expense_id: 'exp-2', suggestion: null },
    ];
    state.expenses = [
      // both edited by ONE cent — voids the automatic justification only
      { id: 'exp-1', amount: '100.01', vendor_name: 'SiteOne', expense_date: '2026-08-10', payment_method: 'card' },
      { id: 'exp-2', amount: '100.01', vendor_name: 'SiteOne', expense_date: '2026-08-10', payment_method: 'card' },
    ];
    const summary = await runDeterministicMatching();
    expect(summary.expenseLinksReverted).toBe(1);
    const revert = state.updates.find(u => u.patch.status === 'unmatched');
    expect(revert.where).toContainEqual({ id: 'bt-auto', status: 'matched_expense', matched_expense_id: 'exp-1', match_method: 'expense_amount_date_vendor' });
  });

  test('refund candidates never offer PRIOR-YEAR expenses — apply-refund would only 409 them', async () => {
    // credit posts in January; the November purchase is within 90 days but
    // in the prior tax year (a manual recovery-income case)
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-01-15', description: 'WAWA REFUND', amount: 20, direction: 'credit', account_type: 'card', suggestion: null }];
    state.expenses = [{ id: 'exp-old', amount: '58.12', description: 'gas', vendor_name: 'Wawa', expense_date: '2025-12-20', payment_method: 'card' }];
    await runDeterministicMatching();
    expect(state.updates.find(u => sugOf(u) && sugOf(u).refundCandidates)).toBeUndefined();
    // the SQL lookback floors at the credit's tax year
    const between = state.builders.find(x => x.table === 'expenses' && x.b.whereBetween.mock.calls.length);
    expect(between.b.whereBetween.mock.calls[0][1][0]).toBe('2026-01-01');
  });

  test('a draft-paused pending link is reverted on page load once the human FINALIZES the rejection', async () => {
    // payout stays paid/eligible — only the human ruling changed
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', amount: '500.00', direction: 'credit', account_type: 'bank', status: 'matched_payout', matched_payout_id: 'po-1', suggestion: { reconcilePending: true } }];
    state.payouts = [{ id: 'po-1', amount: '500.00', arrival_date: '2026-08-11', status: 'paid', reconciled: false }];
    state.reconRows = [{ payout_id: 'po-1', status: 'rejected', reconciled_by: 'adam' }];
    const summary = await runDeterministicMatching();
    expect(summary.linksReverted).toBe(1);
    const revert = state.updates.find(u => u.patch.status === 'unmatched');
    expect(sugOf(revert).bankingRejectedPayoutIds).toEqual(['po-1']); // the ruling stands as an exclusion
    expect(sugOf(revert).autoRevert.reason).toContain('rejected by a human');
  });

  test('a PENDING link whose payout turned ineligible is healed WITHOUT the retry path (page-load healer)', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', amount: '500.00', direction: 'credit', account_type: 'bank', status: 'matched_payout', matched_payout_id: 'po-1', suggestion: { reconcilePending: true } }];
    state.payouts = [{ id: 'po-1', amount: '500.00', arrival_date: '2026-08-11', status: 'failed', reconciled: false }];
    const summary = await runDeterministicMatching();
    expect(summary.linksReverted).toBe(1); // the heal scan itself reverts — no echo needed
    const revert = state.updates.find(u => u.patch.status === 'unmatched');
    expect(sugOf(revert).autoRevert.reason).toContain('no longer eligible');
  });

  test('a RECONCILED link still fully eligible is left alone by the heal scan', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', amount: '2418.66', direction: 'credit', account_type: 'bank', status: 'matched_payout', matched_payout_id: 'po-1', suggestion: null }];
    state.payouts = [{ id: 'po-1', amount: '2418.66', arrival_date: '2026-08-11', status: 'paid', reconciled: true }];
    state.reconRows = [{ payout_id: 'po-1', status: 'confirmed', actual_amount: '2418.66' }];
    const summary = await runDeterministicMatching();
    expect(summary.linksReverted).toBe(0);
    expect(state.updates.find(u => u.patch.status === 'unmatched')).toBeUndefined();
  });

  test('a refund_applied row whose target expense was DELETED reverts to review', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', amount: '20.00', direction: 'credit', account_type: 'card', status: 'refund_applied', suggestion: { refundAppliedTo: 'exp-gone', refundAmount: 20 } }];
    state.expenses = []; // the expense no longer exists
    const summary = await runDeterministicMatching();
    expect(summary.orphanRefundsReverted).toBe(1);
    const revert = state.updates.find(u => u.patch.status === 'unmatched');
    expect(revert.where).toContainEqual({ id: 'bt-1', status: 'refund_applied' });
    expect(sugOf(revert).autoRevert.reason).toContain('deleted');
  });

  test('a human-DRAFT skip keeps the pending flag — the sweep waits for the human', async () => {
    reconcilePayout.mockResolvedValueOnce({ payout_id: 'po-1', skipped: true, reason: 'human_draft' });
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-11', amount: '2418.66', direction: 'credit', account_type: 'bank', status: 'matched_payout', matched_payout_id: 'po-1', suggestion: { reconcilePending: true } }];
    state.payouts = [{ id: 'po-1', amount: '2418.66', arrival_date: '2026-08-11', status: 'paid', reconciled: false }];
    const summary = await runDeterministicMatching();
    expect(summary.reconcileRetried).toBe(0);
    // no clear, no revert — the flag survives for the next pass
    expect(state.updates).toHaveLength(0);
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
    const flagged = state.updates.find(u => sugOf(u) && sugOf(u).ignore);
    // merge semantics: existing keys survive at the DB; the payload carries the flag
    expect(sugOf(flagged)).toMatchObject({ ignore: true });
  });

  test('an already-flagged transfer row is not re-flagged (idempotent)', async () => {
    state.bankRows = [{ id: 'bt-1', txn_date: '2026-08-08', description: 'TRANSFER TO SAVINGS', amount: 1000, direction: 'debit', suggestion: { ignore: true, reason: 'x' } }];
    const summary = await runDeterministicMatching();
    expect(summary.transferFlagged).toBe(0);
    expect(state.updates).toHaveLength(0);
  });
});

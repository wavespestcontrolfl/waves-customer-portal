const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  HEADER, parseLedgerCsv, mapRow, categoryNameForLine, rowHash, summarize, withOrdinals, parseArgs, run,
} = require('../scripts/import-tax-ledger-csv');

const HEADER_LINE = HEADER.join(',');

function csv(...lines) {
  return [HEADER_LINE, ...lines].join('\n') + '\n';
}

// source,date,description,amount,direction,class,category,sched_c_line,flag,processor_match,bank_category
function row(over = {}) {
  const base = {
    source: '3098', date: '2025-03-14', description: 'ACME SUPPLY 4471', amount: '12.50', direction: 'out',
    class: 'expense', category: 'Supplies (chemicals, equipment, hardware)', sched_c_line: '22', flag: '', processor_match: '', bank_category: '',
  };
  const r = { ...base, ...over };
  return HEADER.map(h => (/[",]/.test(r[h]) ? `"${r[h]}"` : r[h])).join(',');
}

function parsedRow(over = {}) {
  return parseLedgerCsv(csv(row(over)))[0];
}

const toCentsOf = v => Math.round(Math.abs(parseFloat(v)) * 100);

describe('parseLedgerCsv header validation', () => {
  test('accepts the exact header and a BOM', () => {
    expect(parseLedgerCsv(`﻿${csv(row())}`)).toHaveLength(1);
  });

  test('rejects an unknown column', () => {
    expect(() => parseLedgerCsv(`${HEADER_LINE},extra\n`)).toThrow(/unknown column.*extra/);
  });

  test('rejects a missing or reordered column', () => {
    expect(() => parseLedgerCsv(`${HEADER.slice(0, -1).join(',')}\n`)).toThrow(/header must be exactly/);
    const swapped = [HEADER[1], HEADER[0], ...HEADER.slice(2)].join(',');
    expect(() => parseLedgerCsv(`${swapped}\n`)).toThrow(/header must be exactly/);
  });

  test('rejects an empty file, and a header with no rows, with one-line messages', () => {
    expect(() => parseLedgerCsv('')).toThrow(/empty/);
    expect(() => parseLedgerCsv(`${HEADER_LINE}\n`)).toThrow(/header but no rows/);
  });

  test.each([
    [{ date: '2025-02-31' }, /date/],
    [{ date: '2052-03-14' }, /date must be a real YYYY-MM-DD date in 2024-/],
    [{ date: '2023-12-31' }, /date must be a real YYYY-MM-DD date in 2024-/],
    [{ source: 'amexx' }, /source must be one of/],
    [{ source: '1234' }, /source must be one of/],
    [{ amount: '-4.00' }, /amount/],
    [{ amount: 'abc' }, /amount/],
    [{ direction: 'sideways' }, /direction/],
    [{ class: 'mystery' }, /unknown class/],
    [{ description: '' }, /description/],
  ])('rejects a bad row %j with a line number', (over, re) => {
    expect(() => parseLedgerCsv(csv(row(over)))).toThrow(/^line 2: /);
    expect(() => parseLedgerCsv(csv(row(over)))).toThrow(re);
  });

  test('parses amount with $ and commas, trims, and keeps quoted commas', () => {
    const [r] = parseLedgerCsv(csv(row({ amount: '$1,234.5', description: 'ACME, INC 9' })));
    expect(r.amount).toBe(1234.5);
    expect(r.description).toBe('ACME, INC 9');
    expect(parseLedgerCsv(csv(row({ amount: ' 12.30 ' })))[0].amount).toBe(12.3);
    expect(parseLedgerCsv(csv(row({ amount: '1,234' })))[0].amount).toBe(1234); // row() quotes the cell
  });

  test.each(['12,34', '1,2,3', '1,2345.00', '1,234,56.00', '1 234', '$'])('rejects a malformed money cell %s instead of reading it as digits', (amount) => {
    expect(() => parseLedgerCsv(csv(row({ amount })))).toThrow(/^line 2: .*amount/);
  });
});

describe('parseArgs', () => {
  test('requires --file and rejects unknown flags', () => {
    expect(() => parseArgs([])).toThrow(/missing --file/);
    expect(() => parseArgs(['--file', 'a.csv', '--bogus'])).toThrow(/unknown argument/);
    expect(parseArgs(['--file=a.csv', '--dry-run'])).toEqual({ file: 'a.csv', dryRun: true });
  });
});

describe('direction, account and field mapping', () => {
  test('out is debit, in is credit', () => {
    expect(mapRow(parsedRow({ direction: 'out' }), 0, 'l.csv').bank.direction).toBe('debit');
    expect(mapRow(parsedRow({ direction: 'in', class: 'income_proc' }), 0, 'l.csv').bank.direction).toBe('credit');
  });

  test('card sources map to card, others to bank, label is ledger-<source>', () => {
    for (const source of ['9731', '6646', '8804', 'amex']) {
      const { bank } = mapRow(parsedRow({ source }), 0, 'l.csv');
      expect(bank.account_type).toBe('card');
      expect(bank.account_label).toBe(`ledger-${source}`);
    }
    expect(mapRow(parsedRow({ source: '3098' }), 0, 'l.csv').bank.account_type).toBe('bank');
    expect(mapRow(parsedRow({ source: '3965' }), 0, 'l.csv').bank.account_type).toBe('bank');
  });

  test('bank row carries source, file basename, date, amount and truncated description', () => {
    const long = 'X'.repeat(600);
    const { bank } = mapRow(parsedRow({ description: long }), 0, 'ledger-2025.csv');
    expect(bank).toMatchObject({ source: 'ledger-csv', source_file: 'ledger-2025.csv', txn_date: '2025-03-14', amount: 12.5 });
    expect(bank.description).toHaveLength(500);
  });
});

describe('row hashing', () => {
  test('matches the documented sha256 tuple', () => {
    const expected = crypto.createHash('sha256').update('ledger|3098|2025-03-14|ACME SUPPLY 4471|12.50|out|0').digest('hex');
    expect(rowHash('3098', '2025-03-14', 'ACME SUPPLY 4471', 12.5, 'out', 0)).toBe(expected);
  });

  test('identical rows in one file get ordinals 0,1,2 and distinct hashes', () => {
    const rows = parseLedgerCsv(csv(
      row({ description: 'CORNER FUEL 12', amount: '4.00' }),
      row({ description: 'CORNER FUEL 12', amount: '4.00' }),
      row({ description: 'CORNER FUEL 12', amount: '4.00' }),
      row({ description: 'CORNER FUEL 12', amount: '5.00' }),
    ));
    expect(withOrdinals(rows)).toEqual([0, 1, 2, 0]);
    const hashes = rows.map((r, i) => mapRow(r, withOrdinals(rows)[i], 'l.csv').bank.row_hash);
    expect(new Set(hashes).size).toBe(4);
  });

  test('the source is case-folded before the identity: AMEX and amex are one row on a reimport', () => {
    const lower = parsedRow({ source: 'amex' });
    const upper = parsedRow({ source: 'AMEX' });
    expect(upper.source).toBe('amex');
    expect(mapRow(upper, 0, 'l.csv').bank.row_hash).toBe(mapRow(lower, 0, 'l.csv').bank.row_hash);
    expect(mapRow(upper, 0, 'l.csv').bank.account_label).toBe('ledger-amex');
    expect(withOrdinals([lower, upper])).toEqual([0, 1]); // the same tuple twice in one file: ordinals, not two identities
  });

  test('same tuple but different source or direction is a different row', () => {
    const rows = parseLedgerCsv(csv(
      row({ source: '3098' }), row({ source: '3965' }), row({ direction: 'in', class: 'refund' }),
    ));
    expect(withOrdinals(rows)).toEqual([0, 0, 0]);
  });
});

describe('class to status table', () => {
  const map = over => mapRow(parsedRow(over), 0, 'l.csv');

  test.each([['expense', '22'], ['vehicle', '9'], ['interest', '16a']])('%s out becomes a created expense', (cls, line) => {
    const m = map({ class: cls, sched_c_line: line, flag: 'F1' });
    expect(m.bank.status).toBe('created_expense');
    expect(m.bank.match_method).toBe('ledger-import');
    expect(m.expense).toMatchObject({ amount: 12.5, tax_deductible_amount: 12.5, expense_date: '2025-03-14', vendor_name: 'ACME SUPPLY 4471', payment_method: 'ach', tax_year: '2025', quarter: 'Q1' });
    expect(m.expense.notes).toBe(`imported from ledger CSV l.csv (class ${cls}, flag F1)`);
    expect(m.bank.suggestion).toEqual({ ledgerClass: cls, ledgerCategory: 'Supplies (chemicals, equipment, hardware)', flag: 'F1', schedCLine: line, processorMatch: false });
  });

  test('card account expense books as card, quarter follows the month', () => {
    const m = map({ source: 'amex', date: '2025-11-02' });
    expect(m.expense.payment_method).toBe('card');
    expect(m.expense.quarter).toBe('Q4');
  });

  test.each(['expense', 'vehicle', 'interest'])('%s in is an OPEN refund credit with no expense: Bank Import applies it to the original expense', cls => {
    const m = map({ class: cls, direction: 'in' });
    expect(m.bank.status).toBe('unmatched');
    expect(m.expense).toBeNull();
    expect(m.bank.status).toBe('unmatched');
    expect(m.unmatchedLine).toBe('refund');
    expect(m.bank.suggestion).toMatchObject({ refundCredit: true, reason: expect.stringMatching(/apply it to the original expense in Bank Import/), ledgerClass: cls });
    expect(m.bank.suggestion.ignore).toBeUndefined();
  });

  test('a money-in class on money OUT (a processor fee filed as income_proc, a receipt class on a debit) is parked for review, never ignored', () => {
    for (const cls of ['income_proc', 'receipt_unmatched']) {
      const m = mapRow(parsedRow({ class: cls, direction: 'out', sched_c_line: '', category: 'Income' }), 0, 'l.csv');
      expect([cls, m.bank.status, m.expense]).toEqual([cls, 'unmatched', null]);
      expect(m.bank.suggestion.note).toMatch(new RegExp(`${cls} class on money out`));
    }
    expect(mapRow(parsedRow({ class: 'income_proc', direction: 'in', sched_c_line: '', category: 'Income' }), 0, 'l.csv').bank.status).toBe('ignored');
  });

  test('refund is an open refund credit, not ignored', () => {
    const m = mapRow(parsedRow({ direction: 'in', class: 'refund', sched_c_line: '' }), 0, 'l.csv');
    expect(m.bank.status).toBe('unmatched');
    expect(m.expense).toBeNull();
    expect(m.bank.suggestion).toMatchObject({ refundCredit: true, ledgerClass: 'refund' });
  });

  test.each(['personal', 'transfer', 'income_proc', 'reward'])('%s is ignored', cls => {
    // a processor deposit is money in; the other classes here are money out
    const m = map({ class: cls, description: 'Zelle money sent to TEST HELPER', sched_c_line: '', direction: cls === 'income_proc' ? 'in' : 'out' });
    expect(m.bank.status).toBe('ignored');
    expect(m.expense).toBeNull();
    expect(m.bank.suggestion).toMatchObject({ ignore: true, reason: `${cls} per the ledger`, ledgerClass: cls });
  });

  test('asset is ignored with the Form 4562 note', () => {
    const m = map({ class: 'asset', sched_c_line: '' });
    expect(m.bank.status).toBe('ignored');
    expect(m.bank.suggestion.reason).toMatch(/asset.*depreciated on Form 4562/);
  });

  test.each(['receipt_unmatched', 'review', 'unknown'])('%s stays unmatched with a review note and no expense', cls => {
    // a receipt is money in; review and unknown rows here are money out
    const m = map({ class: cls, flag: 'CHECK', sched_c_line: '22', direction: cls === 'receipt_unmatched' ? 'in' : 'out' });
    expect(m.bank.status).toBe('unmatched');
    expect(m.expense).toBeNull();
    expect(m.bank.suggestion).toMatchObject({ review: true, note: `the ledger says ${cls}: "Supplies (chemicals, equipment, hardware)" [CHECK]`, schedCLine: '22', flag: 'CHECK' });
    expect(m.unmatchedLine).toBe('22');
  });

  test('business row with a line that has no category (24a, 13) stays unmatched', () => {
    for (const line of ['24a', '13']) {
      const m = map({ sched_c_line: line, category: 'Travel' });
      expect(m.bank.status).toBe('unmatched');
      expect(m.expense).toBeNull();
      expect(m.bank.suggestion.review).toBe(true);
      expect(m.unmatchedLine).toBe(line);
    }
  });

  test('meals are deducted at 50 percent, matching the portal policy', () => {
    const m = map({ sched_c_line: '24b', amount: '41.25', category: 'Meals' });
    expect(m.expense.tax_deductible_amount).toBe(20.63);
    expect(m.expense.amount).toBe(41.25);
  });

  test('description and vendor are capped', () => {
    const m = map({ category: 'C'.repeat(400), description: 'D'.repeat(400) });
    expect(m.expense.description).toHaveLength(300);
    expect(m.expense.vendor_name).toHaveLength(200);
  });
});

describe('categoryNameForLine', () => {
  test.each([
    ['8', 'Advertising & Marketing'], ['9', 'Vehicle Expenses'], ['10', 'Commissions & Fees'], ['11', 'Contract Labor'],
    ['15', 'Insurance'], ['17', 'Legal & Professional'], ['18', 'Office Expenses'], ['21', 'Repairs & Maintenance'],
    ['22', 'Supplies'], ['23', 'Taxes & Licenses'], ['25', 'Utilities'], ['30', 'Home Office'],
    ['16a', 'Interest'], ['16b', null], ['24b', 'Meals & Entertainment'],
  ])('line %s -> %s', (line, name) => {
    expect(categoryNameForLine(line, 'anything')).toBe(name);
  });

  test('line 10 books as Commissions & Fees whatever its text; only a Stripe fee is parked (see the Stripe fee test)', () => {
    // the line maps to its category whatever the text; parking a Stripe fee is mapRow's call, from the text
    expect(categoryNameForLine('10', 'Stripe processing fees')).toBe('Commissions & Fees');
    expect(categoryNameForLine('10', 'Merchant fee')).toBe('Commissions & Fees');
    expect(categoryNameForLine('10', 'Sales commission to a referrer')).toBe('Commissions & Fees');
    const m = mapRow(parsedRow({ sched_c_line: '10', category: 'Stripe processing fees' }), 0, 'l.csv');
    expect([m.bank.status, m.expense, m.businessParked]).toEqual(['unmatched', null, true]);
    expect(m.bank.suggestion.note).toMatch(/the P&L adds synced Stripe fees on its own/);
  });

  test('27a splits on Dues or education', () => {
    expect(categoryNameForLine('27a', 'Software subscriptions')).toBe('Software & Technology');
    expect(categoryNameForLine('27a', 'Website hosting')).toBe('Software & Technology');
    // any other 27a item is parked for review, never relabelled as software
    for (const other of ['Bank fees', 'Uniforms', 'Postage', 'Other', '']) expect([other, categoryNameForLine('27a', other)]).toEqual([other, null]);
    expect(categoryNameForLine('27a', 'Dues & memberships')).toBe('Training & Education');
    expect(categoryNameForLine('27a', 'Continuing education')).toBe('Training & Education');
    expect(categoryNameForLine('27a', 'CONTINUING EDUCATION')).toBe('Training & Education');
  });

  test('no category for 24a, 13, 27b, blank or unknown', () => {
    for (const line of ['24a', '13', '27b', '', undefined, 'zz']) {
      expect(categoryNameForLine(line, 'x')).toBeNull();
    }
  });
});

describe('summarize', () => {
  test('tallies status, categories, unmatched lines and totals in cents', () => {
    const rows = parseLedgerCsv(csv(
      row({ amount: '10.10' }),
      row({ amount: '0.20', description: 'ACME SUPPLY 2' }),
      row({ sched_c_line: '24a', amount: '5.00' }),
      row({ class: 'income_proc', direction: 'in', amount: '100.00', sched_c_line: '' }),
    ));
    const ord = withOrdinals(rows);
    const s = summarize(rows.map((r, i) => mapRow(r, ord[i], 'l.csv')));
    expect(s.rows).toBe(4);
    expect(s.expensesCreated).toBe(2);
    expect(s.byStatus.created_expense.count).toBe(2);
    expect(s.expensesByCategory.Supplies).toEqual({ count: 2, cents: 1030 });
    expect(s.unmatchedByLine['24a']).toEqual({ count: 1, cents: 500 });
    expect(s.totals).toEqual({ debitCents: 1530, creditCents: 10000, expenseCents: 1030 });
  });
});

// ---- run() against an in-memory fake knex ----

function makeFakeDb({ categories } = {}) {
  const tables = {
    bank_transactions: [],
    expenses: [],
    expense_categories: categories || [
      'Advertising & Marketing', 'Vehicle Expenses', 'Insurance', 'Supplies', 'Software & Technology',
      'Training & Education', 'Interest', 'Meals & Entertainment',
    ].map((name, i) => ({ id: `cat-${i}`, name })),
  };
  tables.plaid_accounts = [];
  tables.plaid_items = [];
  let seq = 0;
  let conns = 0;
  const log = { transactions: 0, rollbacks: 0, writes: 0, locks: [] };

  function builderFor(store, table) {
    const state = { filter: null, pending: null, ignoreConflict: false, wantReturn: false, raws: [], first: null };
    const b = {
      whereIn(col, vals) { state.filter = { col, vals: new Set(vals) }; return b; },
      whereBetween(col, [lo, hi]) { state.range = { col, lo, hi }; return b; },
      whereNot(col, val) { state.not = { col, val }; return b; },
      whereNotNull(col) { state.notNull = col; return b; },
      // grouped wheres (bank-import's appliedRefundTotal) run their callback
      // against this builder; raw predicates are recorded for the refund sum
      where(arg) { if (typeof arg === 'function') arg.call(b); else state.eq = arg; return b; },
      orWhere(arg) { if (typeof arg === 'function') arg.call(b); return b; },
      whereRaw(sql, binds) { state.raws.push({ sql, binds: binds || [] }); return b; },
      first(...cols) { state.first = cols.length ? cols : true; return b; },
      forUpdate() { return b; },
      update(patch) { state.patch = patch; return b; },
      delete() { state.deleting = true; return b; },
      select() { return b; },
      insert(rows) { state.pending = Array.isArray(rows) ? rows : [rows]; return b; },
      onConflict() { return b; },
      ignore() { state.ignoreConflict = true; return b; },
      returning() { state.wantReturn = true; return b; },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          if (state.pending) {
            log.writes += 1;
            const inserted = [];
            for (const r of state.pending) {
              if (table === 'bank_transactions' && store[table].some(x => x.row_hash === r.row_hash)) {
                if (state.ignoreConflict) continue;
                throw new Error('unique violation on row_hash');
              }
              const withId = { ...r, id: `id-${(seq += 1)}` };
              store[table].push(withId);
              inserted.push({ id: withId.id, row_hash: withId.row_hash });
            }
            return state.wantReturn ? inserted : undefined;
          }
          const ymd = v => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : v);
          // appliedRefundTotal: applied refunds add their refundAmount, released ones their own amount
          const refundSum = state.raws.find(r => /refundAppliedTo|releasedRefundOf/.test(r.sql));
          if (state.first && refundSum) {
            const id = String(refundSum.binds[0]);
            const total = store[table].reduce((sum, r) => {
              if (r.status === 'refund_applied' && String(r.suggestion?.refundAppliedTo) === id) return sum + Number(r.suggestion.refundAmount || 0);
              if (r.status === 'ignored' && String(r.suggestion?.releasedRefundOf) === id) return sum + Number(r.amount || 0);
              return sum;
            }, 0);
            return { total };
          }
          let out = store[table];
          if (state.filter) out = out.filter(r => state.filter.vals.has(r[state.filter.col]));
          if (state.range) out = out.filter(r => ymd(r[state.range.col]) >= state.range.lo && ymd(r[state.range.col]) <= state.range.hi);
          if (state.not) out = out.filter(r => r[state.not.col] !== state.not.val);
          if (state.notNull) out = out.filter(r => r[state.notNull] !== null && r[state.notNull] !== undefined);
          if (state.eq) out = out.filter(r => Object.entries(state.eq).every(([k, v]) => r[k] === v));
          if (state.patch) {
            // a raw jsonb key subtraction (the verify marker's clear) is applied; any other raw is stored as the tests inspect it
            const sql = state.patch.suggestion && typeof state.patch.suggestion.sql === 'string' ? state.patch.suggestion.sql : '';
            const sub = sql.match(/^suggestion - '(\w+)'$/);
            const subMerge = sql.match(/^\(coalesce\(suggestion, '\{\}'::jsonb\) - '(\w+)'\) \|\| \?::jsonb$/);
            out.forEach(r => {
              if (sub) { const sug = { ...(r.suggestion || {}) }; delete sug[sub[1]]; Object.assign(r, { ...state.patch, suggestion: sug }); }
              else if (subMerge) { const sug = { ...(r.suggestion || {}) }; delete sug[subMerge[1]]; Object.assign(r, { ...state.patch, suggestion: { ...sug, ...JSON.parse(state.patch.suggestion.bindings[0]) } }); }
              else Object.assign(r, state.patch);
            });
            log.writes += 1;
            return out.length;
          }
          if (state.deleting) { const gone = new Set(out); store[table] = store[table].filter(r => !gone.has(r)); log.writes += 1; return gone.size; }
          return state.first ? (out[0] || null) : out;
        }).then(resolve, reject);
      },
    };
    return b;
  }

  const db = table => builderFor(tables, table);
  // a raw pinned to a connection (the run's session lock) is recorded with the write count at that moment
  db.raw = (sql, bindings) => {
    const q = { sql, bindings };
    Object.defineProperty(q, 'connection', { enumerable: false, value: (conn) => { log.locks.push({ sql, bindings, conn: conn.id, writes: log.writes }); return Promise.resolve([]); } });
    return q;
  };
  db.client = {
    acquireConnection: async () => ({ id: `conn-${(conns += 1)}` }),
    releaseConnection: async (conn) => { log.locks.push({ released: conn.id, writes: log.writes }); },
  };
  db.transaction = async fn => {
    log.transactions += 1;
    const staged = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.slice()]));
    const trx = table => builderFor(staged, table);
    trx.raw = db.raw;
    try {
      const out = await fn(trx);
      Object.keys(tables).forEach(k => { tables[k] = staged[k]; });
      return out;
    } catch (err) {
      log.rollbacks += 1;
      throw err;
    }
  };
  db.tables = () => tables;
  db.log = log;
  return db;
}

describe('run', () => {
  let dir;
  let file;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
    file = path.join(dir, 'ledger-2025.csv');
    fs.writeFileSync(file, csv(
      row({ description: 'ACME SUPPLY 4471', amount: '12.50' }),
      row({ description: 'CORNER FUEL 12', amount: '4.00', class: 'vehicle', sched_c_line: '9', category: 'Vehicle fuel' }),
      row({ description: 'CORNER FUEL 12', amount: '4.00', class: 'vehicle', sched_c_line: '9', category: 'Vehicle fuel' }),
      row({ description: 'Zelle money sent to TEST HELPER', amount: '300.00', class: 'personal', sched_c_line: '', category: 'Personal' }),
      row({ description: 'MYSTERY CHARGE 77', amount: '19.99', class: 'review', category: 'Unknown merchant', flag: 'NOREC', sched_c_line: '22' }),
      row({ description: 'AIRLINE 0001', amount: '210.00', sched_c_line: '24a', category: 'Travel' }),
      row({ description: 'PROCESSOR DEPOSIT', amount: '500.00', direction: 'in', class: 'income_proc', sched_c_line: '', category: 'Income' }),
      row({ description: 'TRADE SCHOOL DUES', amount: '80.00', source: 'amex', sched_c_line: '27a', category: 'Dues & education' }),
    ));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('dry run reads but writes nothing and says DRY RUN', async () => {
    const db = makeFakeDb();
    const { report, counts } = await run({ file, dryRun: true, db });
    expect(report).toMatch(/^DRY RUN/);
    expect(counts).toEqual({ read: 8, inserted: 8, duplicates: 0, held: 0, parked: 0, kept: 0, portalExpenses: 0 });
    expect(db.tables().bank_transactions).toHaveLength(0);
    expect(db.tables().expenses).toHaveLength(0);
    expect(db.log.writes).toBe(0);
    expect(db.log.transactions).toBe(0);
  });

  test('real run inserts bank rows and expenses, linked and categorized', async () => {
    const db = makeFakeDb();
    const { report, counts } = await run({ file, db });
    expect(report).not.toMatch(/DRY RUN/);
    expect(counts).toEqual({ read: 8, inserted: 8, duplicates: 0, held: 0, parked: 0, kept: 0, portalExpenses: 0 });

    const { bank_transactions: bank, expenses } = db.tables();
    expect(bank).toHaveLength(8);
    expect(expenses).toHaveLength(4); // supplies, two fuel, dues
    expect(db.log.transactions).toBe(4);

    const byStatus = s => bank.filter(b => b.status === s).length;
    expect(byStatus('created_expense')).toBe(4);
    expect(byStatus('ignored')).toBe(2);
    expect(byStatus('unmatched')).toBe(2); // review row + 24a row

    // every created_expense row points at a real expense; no expense is orphaned
    const linked = bank.filter(b => b.matched_expense_id).map(b => b.matched_expense_id).sort();
    expect(linked).toEqual(expenses.map(e => e.id).sort());

    const dues = expenses.find(e => e.vendor_name === 'TRADE SCHOOL DUES');
    expect(dues.category_id).toBe('cat-5'); // Training & Education
    expect(dues.payment_method).toBe('card');
    expect(expenses.filter(e => e.category_id === 'cat-1')).toHaveLength(2); // two identical fuel rows both loaded

    expect(report).toMatch(/left unmatched by Schedule C line/);
    expect(report).toMatch(/24a/);
  });

  test('a rerun with a changed classification holds the row (class, category and line are not in the hash); an unchanged one is a duplicate', async () => {
    const db = makeFakeDb();
    await run({ file, db });
    const rows = parseLedgerCsv(fs.readFileSync(file, 'utf8'));
    // personal -> expense: the earlier run ignored it; now the ledger books it
    const edited = rows.map((r) => ({ ...r }));
    const helper = edited.find((r) => /TEST HELPER/.test(r.description)); helper.class = 'expense'; helper.category = 'Contract labor'; helper.sched_c_line = '11';
    // expense -> personal: the earlier run booked it; now the ledger says personal
    const acme = edited.find((r) => r.description === 'ACME SUPPLY 4471'); acme.class = 'personal'; acme.category = 'Personal'; acme.sched_c_line = '';
    // Supplies -> Advertising: the earlier run booked it under Supplies
    const dues = edited.find((r) => /TRADE SCHOOL/.test(r.description)); dues.sched_c_line = '8'; dues.category = 'Advertising';
    fs.writeFileSync(file, csv(...edited.map((r) => row({ source: r.source, date: r.date, description: r.description, amount: String(r.amount.toFixed(2)), direction: r.direction, class: r.class, category: r.category, sched_c_line: r.sched_c_line, flag: r.flag }))));
    const { counts, report } = await run({ file, db });
    expect(counts).toMatchObject({ inserted: 0, held: 3, duplicates: 5 });
    // held with what was loaded and what the file says now; nothing is rewritten (the owner changes it in Bank Import)
    expect(report).toMatch(/\[loaded by an earlier run as personal \(Personal\); the file now reads it differently \(change it in Bank Import, not by re-import\); the ledger says expense \(Contract Labor\)\]/);
    expect(report).toMatch(/\[loaded by an earlier run as expense \(Supplies \(chemicals, equipment, hardware\), line 22\); the file now reads it differently .*; the ledger says personal\]/);
    expect(report).toMatch(/\[loaded by an earlier run as expense \(Dues & education, line 27a\); the file now reads it differently .*; the ledger says expense \(Advertising & Marketing\)\]/);
    expect(db.tables().expenses).toHaveLength(4); // nothing re-booked or deleted by guesswork
    expect(db.tables().bank_transactions).toHaveLength(8);
    // each held row carries the conflict as a review note Bank Import shows, merged onto the stored suggestion (status untouched)
    const noted = db.tables().bank_transactions.filter(b => b.suggestion && b.suggestion.bindings);
    expect(noted).toHaveLength(3);
    const acmeRow = db.tables().bank_transactions.find(b => b.description === 'ACME SUPPLY 4471');
    expect(acmeRow.status).toBe('created_expense');
    expect(acmeRow.suggestion.sql).toMatch(/\|\| \?::jsonb$/); // merged onto the stored suggestion, never a rebuild
    // a ledger category default an earlier run stored goes with the old reading (a model's or a rule's would stay)
    expect(acmeRow.suggestion.sql).toMatch(/case when suggestion ->> 'categorySource' = 'ledger' then coalesce\(suggestion, '\{\}'::jsonb\) - 'categoryId' - 'categoryName' - 'irsLine' - 'categorySource' else/);
    const merged = JSON.parse(acmeRow.suggestion.bindings[0]);
    expect(merged.categoryId).toBeUndefined();
    // the note names the way out for a CREATED row (Bank Import has no unlink for it), and the stored reading follows the file
    expect(merged).toMatchObject({ review: true, note: expect.stringMatching(/^the ledger file now reads this row as personal \(Personal\); it was loaded as expense \(Supplies \(chemicals, equipment, hardware\), line 22\) and booked as an expense: delete that expense on the Expenses tab \(this row reopens\), then decide it here$/), ledgerClass: 'personal', ledgerCategory: 'Personal', schedCLine: '', ledgerConflict: expect.objectContaining({ loadedAs: expect.stringMatching(/^expense/), fileSays: 'personal (Personal)', line: expect.any(Number) }) });
    // the helper's row was ignored: its way out is an unignore
    const helperRow = db.tables().bank_transactions.find(b => /TEST HELPER/.test(b.description));
    expect(JSON.parse(helperRow.suggestion.bindings[0]).note).toMatch(/ and ignored: unignore it here if the file is right, then decide it$/);
    // a rerun of the same corrected file does not hold the rows again: the stored reading now matches the file (the fake stores the merged patch as the row's suggestion)
    for (const b of noted) b.suggestion = { ...JSON.parse(b.suggestion.bindings[0]) };
    expect((await run({ file, db })).counts).toMatchObject({ held: 0, duplicates: 8, inserted: 0 });
  });

  test('a parked row corrected to another business category on a rerun gets the corrected category as its default', async () => {
    const db = makeFakeDb();
    db.tables().expenses.push({ id: 'exp-hand', expense_date: '2025-03-14', amount: '12.50', vendor_name: 'Acme Supply', description: 'supplies' });
    await run({ file, db }); // the Acme row parks (a hand expense of the same amount) with Supplies as its ledger default
    const acmeRow = db.tables().bank_transactions.find(b => b.description === 'ACME SUPPLY 4471');
    expect(acmeRow.suggestion).toMatchObject({ categoryName: 'Supplies', categorySource: 'ledger' });
    const rows = parseLedgerCsv(fs.readFileSync(file, 'utf8'));
    const edited = rows.map((r) => ({ ...r }));
    const acme = edited.find((r) => r.description === 'ACME SUPPLY 4471'); acme.sched_c_line = '24b'; acme.category = 'Meals';
    fs.writeFileSync(file, csv(...edited.map((r) => row({ source: r.source, date: r.date, description: r.description, amount: String(r.amount.toFixed(2)), direction: r.direction, class: r.class, category: r.category, sched_c_line: r.sched_c_line, flag: r.flag }))));
    const { counts } = await run({ file, db });
    expect(counts).toMatchObject({ held: 1 });
    const merged = JSON.parse(acmeRow.suggestion.bindings[0]);
    expect(merged).toMatchObject({ categoryId: 'cat-7', categoryName: 'Meals & Entertainment', categorySource: 'ledger', schedCLine: '24b', review: true });
  });

  test('a dry run lists the holds but writes no note', async () => {
    const db = makeFakeDb();
    await run({ file, db });
    const rows = parseLedgerCsv(fs.readFileSync(file, 'utf8'));
    const edited = rows.map((r) => ({ ...r }));
    const acme = edited.find((r) => r.description === 'ACME SUPPLY 4471'); acme.class = 'personal'; acme.category = 'Personal'; acme.sched_c_line = '';
    fs.writeFileSync(file, csv(...edited.map((r) => row({ source: r.source, date: r.date, description: r.description, amount: String(r.amount.toFixed(2)), direction: r.direction, class: r.class, category: r.category, sched_c_line: r.sched_c_line, flag: r.flag }))));
    const writes = db.log.writes;
    const { counts } = await run({ file, db, dryRun: true });
    expect(counts).toMatchObject({ held: 1, duplicates: 7, inserted: 0 });
    expect(db.log.writes).toBe(writes);
  });

  test('a rerun holds a row an earlier run loaded whose expense was deleted since, instead of skipping it as a duplicate', async () => {
    const db = makeFakeDb();
    await run({ file, db });
    const loaded = db.tables().bank_transactions.find(r => r.description === 'ACME SUPPLY 4471');
    expect(loaded.status).toBe('created_expense');
    // the owner deleted the expense: the FK goes null (ON DELETE SET NULL)
    loaded.matched_expense_id = null;
    db.tables().expenses = db.tables().expenses.filter(e => e.vendor_name !== 'ACME SUPPLY 4471');
    const { counts, report } = await run({ file, db });
    expect(counts).toMatchObject({ inserted: 0, held: 1, duplicates: 7 });
    expect(report).toMatch(/loaded by an earlier run but its expense was deleted since; the ledger says expense \(Supplies\)/);
    expect(db.tables().expenses.find(e => e.vendor_name === 'ACME SUPPLY 4471')).toBeUndefined(); // nothing re-booked by guesswork
    expect(JSON.parse(loaded.suggestion.bindings[0]).note).toMatch(/but its expense was deleted since: create the expense here, or ignore the row$/);
  });

  test('second run inserts nothing and creates no duplicate expense', async () => {
    const db = makeFakeDb();
    await run({ file, db });
    const before = { bank: db.tables().bank_transactions.length, exp: db.tables().expenses.length };
    const second = await run({ file, db });
    expect(second.counts).toEqual({ read: 8, inserted: 0, duplicates: 8, held: 0, parked: 0, kept: 0, portalExpenses: 0 });
    expect(db.tables().bank_transactions).toHaveLength(before.bank);
    expect(db.tables().expenses).toHaveLength(before.exp);
  });

  test('a business row whose category is missing from the database is parked, not expensed', async () => {
    const db = makeFakeDb({ categories: [{ id: 'cat-x', name: 'Insurance' }] });
    const { summary } = await run({ file, db });
    expect(db.tables().expenses).toHaveLength(0);
    expect(summary.expensesCreated).toBe(0);
    expect(db.tables().bank_transactions.filter(b => b.status === 'unmatched')).toHaveLength(6);
  });

  test('a non-expense row another writer inserted after the lookup is skipped and left out of the report totals', async () => {
    const db = makeFakeDb();
    const realDb = db;
    const rows = parseLedgerCsv(fs.readFileSync(file, 'utf8'));
    // a row that makes no expense (its class is ignored), pre-inserted as if by a concurrent import
    const idx = rows.findIndex(r => !mapRow(r).expense);
    const target = rows[idx];
    const hash = rowHash(target.source, target.date, target.description, target.amount, target.direction, 0);
    realDb.tables().bank_transactions.push({ id: 'pre', row_hash: hash, status: 'ignored', amount: target.amount, direction: target.direction });
    const blind = table => {
      if (table !== 'bank_transactions') return realDb(table);
      const real = realDb(table);
      const blindLookup = { select: () => Promise.resolve([]) };
      return { ...real, insert: (...a) => real.insert(...a), whereIn: () => blindLookup };
    };
    blind.transaction = realDb.transaction;
    blind.raw = realDb.raw;
    blind.client = realDb.client;
    const { counts, summary } = await run({ file, db: blind });
    expect(counts).toEqual({ read: 8, inserted: 7, duplicates: 1, held: 0, parked: 0, kept: 0, portalExpenses: 0 });
    // the summary covers the seven rows that landed, not the raced one
    expect(summary.rows).toBe(7);
    const clean = await run({ file, db: makeFakeDb() });
    expect(summary.totals.debitCents + summary.totals.creditCents).toBe(clean.summary.totals.debitCents + clean.summary.totals.creditCents - toCentsOf(target.amount));
  });

  test('a lost insert race rolls the expense back and counts a duplicate', async () => {
    const db = makeFakeDb();
    const realDb = db;
    const first = parseLedgerCsv(fs.readFileSync(file, 'utf8'))[0];
    const hash = rowHash(first.source, first.date, first.description, first.amount, first.direction, 0);
    realDb.tables().bank_transactions.push({ id: 'pre', row_hash: hash });
    const blind = table => {
      if (table !== 'bank_transactions') return realDb(table);
      const real = realDb(table);
      // the existence lookup sees nothing, as if the other writer committed after it
      const blindLookup = { select: () => Promise.resolve([]) };
      return { ...real, insert: (...a) => real.insert(...a), whereIn: () => blindLookup };
    };
    blind.transaction = realDb.transaction;
    blind.raw = realDb.raw;
    blind.client = realDb.client;
    const { counts } = await run({ file, db: blind });
    expect(counts.duplicates).toBe(1);
    expect(counts.inserted).toBe(7);
    expect(realDb.log.rollbacks).toBe(1);
    expect(realDb.tables().expenses).toHaveLength(3); // the raced row left no orphan expense
  });

  test('missing file and bad header fail with one-line errors', async () => {
    const db = makeFakeDb();
    await expect(run({ file: path.join(dir, 'nope.csv'), db })).rejects.toThrow(/cannot read file/);
    const bad = path.join(dir, 'bad.csv');
    fs.writeFileSync(bad, 'a,b,c\n1,2,3\n');
    await expect(run({ file: bad, db })).rejects.toThrow(/unknown column/);
    await expect(run({ db })).rejects.toThrow(/missing --file/);
  });
});

describe('shared helpers', () => {
  test('the year ceiling is the Eastern calendar year, not the server clock\'s', () => {
    const line = `${HEADER.join(',')}\n3098,2027-01-01,ACME,10.00,out,expense,Supplies,22,,,`;
    // 03:00Z on Jan 1 is still Dec 31 in Eastern time: a 2027 row is not yet a real date for the books
    expect(() => parseLedgerCsv(line, { now: new Date('2027-01-01T03:00:00Z') })).toThrow(/date must be a real YYYY-MM-DD date in 2024-2026/);
    // 05:30Z is 00:30 Eastern on Jan 1
    expect(parseLedgerCsv(line, { now: new Date('2027-01-01T05:30:00Z') })[0].period.tax_year).toBe('2027');
  });

  test('a date the JavaScript year-remapping trap would accept is rejected by the shared validator', () => {
    const header = HEADER.join(',');
    const good = `${header}\n3098,2024-02-29,ACME,10.00,out,expense,Supplies,22,,,`;
    expect(parseLedgerCsv(good)[0].period).toEqual({ tax_year: '2024', quarter: 'Q1', date: '2024-02-29' });
    for (const bad of ['0012-02-29', '2024-02-30', '2024-13-01', '1999-01-01', '24-01-01']) {
      expect(() => parseLedgerCsv(`${header}\n3098,${bad},ACME,10.00,out,expense,Supplies,22,,,`)).toThrow(/real YYYY-MM-DD date/);
    }
  });

  test('the partial-deduction policy is the shared one (meals 50%)', () => {
    const { categoryDeductibleAmount } = require('../services/expense-categorizer');
    const m = mapRow(parsedRow({ sched_c_line: '24b', category: 'Meals', amount: '40.00' }), 0, 'l.csv');
    expect(m.expense.tax_deductible_amount).toBe(categoryDeductibleAmount('Meals & Entertainment', 40));
    expect(m.expense.tax_deductible_amount).toBe(20);
    const s = mapRow(parsedRow({ sched_c_line: '22', category: 'Supplies', amount: '40.00' }), 0, 'l.csv');
    expect(s.expense.tax_deductible_amount).toBe(40);
  });

  test('a NUL byte in any persisted text field fails the whole file before anything is written', () => {
    const header = HEADER.join(',');
    for (const [col, line] of [['source', '30\u000098,2025-03-14,ACME,10.00,out,expense,Supplies,22,,,'], ['category', '3098,2025-03-14,ACME,10.00,out,expense,Supp\u0000lies,22,,,'], ['flag', '3098,2025-03-14,ACME,10.00,out,expense,Supplies,22,NO\u0000REC,,'], ['bank_category', '3098,2025-03-14,ACME,10.00,out,expense,Supplies,22,,,Mer\u0000chandise']]) {
      expect(() => parseLedgerCsv(`${header}\n${line}`)).toThrow(new RegExp(`${col} contains a NUL byte`));
    }
  });

  test('a refund-class row that is money OUT is parked for ordinary review, never offered as a refund credit', () => {
    const m = mapRow(parsedRow({ direction: 'out', class: 'refund', sched_c_line: '' }), 0, 'l.csv');
    expect(m.bank.status).toBe('unmatched');
    expect(m.bank.suggestion).toMatchObject({ review: true, note: expect.stringMatching(/refund class on money out/) });
    expect(m.bank.suggestion.refundCredit).toBeUndefined();
    expect(m.expense).toBeNull();
  });

  test('an amount with more than two decimals fails the file instead of being rounded', () => {
    const header = HEADER.join(',');
    expect(() => parseLedgerCsv(`${header}\n3098,2025-03-14,ACME,12.505,out,expense,Supplies,22,,,`)).toThrow(/amount must be a positive decimal/);
    expect(parseLedgerCsv(`${header}\n3098,2025-03-14,ACME,12.5,out,expense,Supplies,22,,,`)[0].amount).toBe(12.5);
    expect(parseLedgerCsv(`${header}\n3098,2025-03-14,ACME,"1,234.00",out,expense,Supplies,22,,,`)[0].amount).toBe(1234);
  });

  test('a file with rows from two tax years is refused, naming the stray lines', () => {
    const text = csv(row({ date: '2025-03-14' }), row({ date: '2025-04-01' }), row({ date: '2024-12-31', description: 'STRAY' }));
    expect(() => parseLedgerCsv(text)).toThrow(/rows from tax years 2024, 2025: one file loads one year; fix the stray date\(s\), e\.g\. line 4 \(2024-12-31\)/);
  });

  test('parseArgs knows --file and --dry-run only: nothing is reconciled by guesswork, so there is no --skip-existing', () => {
    expect(parseArgs(['--file', 'x.csv', '--dry-run'])).toEqual({ file: 'x.csv', dryRun: true });
    expect(() => parseArgs(['--file', 'x.csv', '--skip-existing'])).toThrow(/unknown argument: --skip-existing/);
  });

  test('only a Stripe processing FEE is parked (the P&L adds synced Stripe fees itself); a purchase that mentions Stripe, and any other processor or bank fee, marked or not, books as the expense it is', () => {
    const stripe = mapRow(parsedRow({ sched_c_line: '10', description: 'STRIPE FEE 0042', category: 'Commissions and fees' }), 0, 'l.csv');
    expect(stripe.expense).toBeNull();
    expect(stripe.bank.status).toBe('unmatched');
    expect(stripe.bank.suggestion).toMatchObject({ review: true, manualLink: true, note: expect.stringMatching(/^Stripe fee: the P&L adds synced Stripe fees on its own/) });
    const byCategory = mapRow(parsedRow({ sched_c_line: '27a', description: 'PAYMENT 0042', category: 'Stripe processing fees' }), 0, 'l.csv');
    expect(byCategory.expense).toBeNull();
    // a Stripe-processed vendor charge or a Stripe subscription is a purchase, not a fee in the sync: it books on its own line
    const vendor = mapRow(parsedRow({ sched_c_line: '22', description: 'STRIPE *ACME SUPPLY', category: 'Supplies' }), 0, 'l.csv');
    expect(vendor.expense).not.toBeNull();
    const software = mapRow(parsedRow({ sched_c_line: '27a', description: 'STRIPE PAYMENTS', category: 'Stripe software subscription' }), 0, 'l.csv');
    expect(software.expense).not.toBeNull();
    expect(software.categoryName).toBe('Software & Technology');
    // a Square-era fee, a bank's merchant fee, a row the ledger matched to a processor record: none of these is in the Stripe sync
    for (const over of [
      { sched_c_line: '10', description: 'SQ *FEE 0042', category: 'Commissions and fees', processor_match: 'Y' },
      { sched_c_line: '10', description: 'BANK MERCHANT FEE', category: 'Processing fee' },
      { sched_c_line: '22', description: 'ACME SUPPLY 4471', category: 'Supplies', processor_match: 'y' },
    ]) {
      const m = mapRow(parsedRow(over), 0, 'l.csv');
      expect(m.expense).not.toBeNull();
    }
    expect(mapRow(parsedRow({ sched_c_line: '10', description: 'SQ *FEE 0042', category: 'Commissions and fees', processor_match: 'Y' }), 0, 'l.csv').categoryName).toBe('Commissions & Fees');
    // a processor deposit (money in) is the ordinary ignored payout, unchanged
    const deposit = mapRow(parsedRow({ class: 'income_proc', direction: 'in', sched_c_line: '', category: 'Income', processor_match: 'Y' }), 0, 'l.csv');
    expect(deposit.bank.status).toBe('ignored');
  });

  test('every parked business row is manual-only for the matcher (manualLink), whatever parked it', () => {
    const noLine = mapRow(parsedRow({ sched_c_line: '24a', category: 'Travel' }), 0, 'l.csv');
    expect(noLine.bank.suggestion).toMatchObject({ review: true, manualLink: true });
    const interest = mapRow(parsedRow({ class: 'interest', sched_c_line: '16b', category: 'Card interest' }), 0, 'l.csv');
    expect(interest.bank.suggestion).toMatchObject({ review: true, manualLink: true });
    // a plain review row (not a business row) carries no marker: the matcher may link it as usual
    const review = mapRow(parsedRow({ class: 'review', sched_c_line: '' }), 0, 'l.csv');
    expect(review.bank.suggestion.manualLink).toBeUndefined();
  });

  test('every row stores the ledger reading a rerun compares (class, category, line), the ignored classes too', () => {
    for (const over of [{}, { class: 'personal', category: 'Personal', sched_c_line: '' }, { class: 'refund', direction: 'in' }, { class: 'review', sched_c_line: '24a' }]) {
      const r = parsedRow(over);
      const m = mapRow(r, 0, 'l.csv');
      expect(m.bank.suggestion).toMatchObject({ ledgerClass: r.class, ledgerCategory: r.category, schedCLine: r.sched_c_line, processorMatch: false });
    }
  });
});

describe('what the portal already holds', () => {
  const fixture = (...lines) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
    const file = path.join(dir, 'ledger-2025.csv');
    fs.writeFileSync(file, csv(...(lines.length ? lines : [row({ description: 'ACME SUPPLY 4471', amount: '12.50' })])));
    return file;
  };
  const otherRow = (over = {}) => ({ id: 'up-1', row_hash: 'upload-hash', source: 'csv', account_label: 'capone-card-3098', txn_date: '2025-03-14', description: 'other', amount: '1.00', direction: 'debit', status: 'unmatched', ...over });

  test('a bank row from a feed or an upload in the file\'s range refuses the run (dry run too), whatever its account or state, before any write', async () => {
    const file = fixture();
    for (const dryRun of [true, false]) {
      const db = makeFakeDb();
      db.tables().bank_transactions.push(otherRow());
      await expect(run({ file, db, dryRun })).rejects.toThrow(/already holds 1 bank row\(s\) from a feed or an upload between 2025-03-14 and 2025-03-14.*classify those rows in Bank Import instead\. First: 2025-03-14 "other" 1\.00 debit \(capone-card-3098\)/);
      expect(db.tables().bank_transactions).toHaveLength(1);
      expect(db.log.writes).toBe(0);
    }
    // the loader never matches the ledger against it: same account or another, open, booked or ignored, upload or feed
    for (const over of [{ account_label: 'checking 9999' }, { status: 'created_expense', matched_expense_id: 'e-x' }, { status: 'ignored' }, { source: 'plaid', account_label: 'Amex Business' }, { description: 'ACME SUPPLY 4471', amount: '12.50' }]) {
      const db = makeFakeDb();
      db.tables().bank_transactions.push(otherRow(over));
      await expect(run({ file, db })).rejects.toThrow(/already holds 1 bank row\(s\)/);
    }
    // outside the range it does not count
    const db = makeFakeDb();
    db.tables().bank_transactions.push(otherRow({ txn_date: '2025-03-15' }));
    expect((await run({ file, db })).counts).toEqual({ read: 1, inserted: 1, duplicates: 0, held: 0, parked: 0, kept: 0, portalExpenses: 0 });
  });

  test('a row an earlier run loaded that is no longer in the file (corrected text, date or amount; dropped; the file moved) refuses the rerun; another file\'s rows do not count', async () => {
    const acme = { description: 'ACME SUPPLY 4471', amount: '12.50', date: '2025-03-14' };
    const fuel = { description: 'CORNER FUEL 12', amount: '4.00', date: '2025-03-16', class: 'vehicle', sched_c_line: '9', category: 'Vehicle fuel' };
    const variants = {
      text: [row({ ...acme, description: 'ACME SUPPLY 4471 BRADENTON' }), row(fuel)],
      date: [row({ ...acme, date: '2025-03-13' }), row(fuel)],
      amount: [row({ ...acme, amount: '12.55' }), row(fuel)],
      dropped: [row(fuel)],
      // the whole file moved a month: the loaded rows are outside the new range but came from this file name
      moved: [row({ ...acme, date: '2025-04-14' }), row({ ...fuel, date: '2025-04-16' })],
    };
    for (const [name, edited] of Object.entries(variants)) {
      const file = fixture(row(acme), row(fuel));
      const db = makeFakeDb();
      await run({ file, db });
      const before = { bank: db.tables().bank_transactions.length, exp: db.tables().expenses.length, writes: db.log.writes };
      fs.writeFileSync(file, csv(...edited));
      await expect(run({ file, db })).rejects.toThrow(/[12] row\(s\) an earlier run loaded for tax year 2025 are not in this file \(one file loads a year: a corrected date, text or amount, or a dropped row\); a loaded row is corrected in Bank Import, not by re-import.*First: 2025-03-14 "ACME SUPPLY 4471" 12\.50 debit \(ledger-2025\.csv\)/);
      expect([name, db.tables().bank_transactions.length, db.tables().expenses.length, db.log.writes]).toEqual([name, before.bank, before.exp, before.writes]);
    }
    // the other year's rows do not count, whatever file name they came from (two years may come from files of one name)
    for (const sourceFile of ['ledger-2024.csv', 'ledger-2025.csv']) {
      const file = fixture(row(acme), row(fuel));
      const db = makeFakeDb();
      db.tables().expenses.push({ id: 'exp-2024', expense_date: '2024-12-31', amount: '12.50', vendor_name: 'ACME SUPPLY 4471', description: 'x' });
      db.tables().bank_transactions.push({ id: 'led-2024', row_hash: 'prior-2024', source: 'ledger-csv', source_file: sourceFile, account_label: 'ledger-3098', txn_date: '2024-12-31', description: 'ACME SUPPLY 4471', amount: '12.50', direction: 'debit', status: 'created_expense', matched_expense_id: 'exp-2024' });
      expect((await run({ file, db })).counts).toEqual({ read: 2, inserted: 2, duplicates: 0, held: 0, parked: 0, kept: 0, portalExpenses: 0 });
    }
  });

  test('a rerun that changes only the flag holds the row (the note and the expense audit text carry it)', async () => {
    const file = fixture(row({ description: 'ACME SUPPLY 4471', amount: '12.50', flag: '' }));
    const db = makeFakeDb();
    await run({ file, db });
    fs.writeFileSync(file, csv(row({ description: 'ACME SUPPLY 4471', amount: '12.50', flag: 'NOREC' })));
    const { counts, report } = await run({ file, db });
    expect(counts).toMatchObject({ inserted: 0, duplicates: 0, held: 1 });
    expect(report).toMatch(/the file now reads it differently/);
  });

  test('a rerun that adds the processor mark to a booked row holds it (the reading changed); the same mark spelled another way is a duplicate', async () => {
    const file = fixture(row({ description: 'CARD PROCESSOR FEE', amount: '3.20', sched_c_line: '10', category: 'Commissions and fees' }));
    const db = makeFakeDb({ categories: [{ id: 'cat-c', name: 'Commissions & Fees' }] });
    await run({ file, db });
    expect(db.tables().expenses).toHaveLength(1); // booked: a generic fee is not a Stripe fee
    fs.writeFileSync(file, csv(row({ description: 'CARD PROCESSOR FEE', amount: '3.20', sched_c_line: '10', category: 'Commissions and fees', processor_match: 'Y' })));
    const { counts, report } = await run({ file, db });
    expect(counts).toEqual({ read: 1, inserted: 0, duplicates: 0, held: 1, parked: 0, kept: 0, portalExpenses: 0 });
    expect(report).toMatch(/\[loaded by an earlier run as expense \(Commissions and fees, line 10\); the file now reads it differently \(change it in Bank Import, not by re-import\); the ledger says expense \(Commissions & Fees\)\]/);
    expect(db.tables().expenses).toHaveLength(1); // nothing deleted by guesswork: the owner changes it in Bank Import
    // the mark spelled 'yes' on the next run reads the same as 'Y'
    const file2 = fixture(row({ description: 'OTHER PROCESSOR FEE', amount: '4.10', sched_c_line: '10', category: 'Commissions and fees', processor_match: 'Y' }));
    const db2 = makeFakeDb({ categories: [{ id: 'cat-c', name: 'Commissions & Fees' }] });
    await run({ file: file2, db: db2 });
    expect(db2.tables().expenses).toHaveLength(1); // booked (the mark alone parks nothing)
    fs.writeFileSync(file2, csv(row({ description: 'OTHER PROCESSOR FEE', amount: '4.10', sched_c_line: '10', category: 'Commissions and fees', processor_match: 'yes' })));
    expect((await run({ file: file2, db: db2 })).counts).toMatchObject({ duplicates: 1, held: 0 });
  });

  test('a rerun of an unchanged file is all duplicates; the expenses it made are the ledger\'s own, not "already in the portal"', async () => {
    const file = fixture();
    const db = makeFakeDb();
    await run({ file, db });
    const second = await run({ file, db });
    expect(second.counts).toEqual({ read: 1, inserted: 0, duplicates: 1, held: 0, parked: 0, kept: 0, portalExpenses: 0 });
    expect(db.tables().expenses).toHaveLength(1);
    // the owner's later decision on a loaded row stands: an ignore in Bank Import does not make the row "without its expense"
    db.tables().bank_transactions[0].status = 'ignored';
    expect((await run({ file, db })).counts).toMatchObject({ duplicates: 1, held: 0 });
  });

  test('a loaded row the portal still has open without its expense (parked then, or reopened) is held, not skipped', async () => {
    const file = fixture();
    const db = makeFakeDb({ categories: [{ id: 'cat-x', name: 'Insurance' }] }); // no Supplies: the first run parks the row
    await run({ file, db });
    expect(db.tables().bank_transactions[0].status).toBe('unmatched');
    db.tables().expense_categories.push({ id: 'cat-s', name: 'Supplies' });
    const { counts, report } = await run({ file, db });
    expect(counts).toEqual({ read: 1, inserted: 0, duplicates: 0, held: 1, parked: 0, kept: 0, portalExpenses: 0 });
    expect(report).toMatch(/\[loaded by an earlier run and open in the portal without its expense; the ledger says expense \(Supplies\)\]/);
    expect(db.tables().expenses).toHaveLength(0); // booked in Bank Import, not here
  });

  test('an expense already in the portal of the same gross amount within the matcher window parks the ledger expense row (loaded open, no expense) and lists it; outside the window or at another amount the row books', async () => {
    const file = fixture(row({ description: 'ACME SUPPLY 4471', amount: '12.50', date: '2025-03-14' }), row({ description: 'ACME SUPPLY 4471', amount: '12.50', date: '2025-03-20' }));
    const db = makeFakeDb();
    db.tables().expenses.push({ id: 'exp-a', expense_date: '2025-03-12', amount: '12.50', vendor_name: 'Acme Supply', description: 'receipt' }); // 2 days before the first, 8 before the second
    db.tables().expenses.push({ id: 'exp-b', expense_date: '2025-03-08', amount: '12.50', vendor_name: 'Acme Supply', description: 'older receipt' }); // 6 days before the first: outside the window and the widened range
    db.tables().expenses.push({ id: 'exp-c', expense_date: '2025-03-14', amount: '99.00', vendor_name: 'Acme Supply', description: 'another amount' });
    const { counts, report } = await run({ file, db });
    expect(counts).toEqual({ read: 2, inserted: 2, duplicates: 0, held: 0, parked: 1, kept: 0, portalExpenses: 2 });
    expect(report).toMatch(/parked for review:\s+1 \(loaded as open rows, no expense/);
    expect(report).toMatch(/line 2  2025-03-14  ACME SUPPLY 4471  12\.50  \[an expense of the same amount already in the portal: "Acme Supply" dated 2 days earlier; the ledger says expense \(Supplies\)\]/);
    expect(report).toMatch(/expenses in the portal:\s+2 entered by hand or from a feed/);
    expect(report).toMatch(/2025-03-12  Acme Supply\s+12\.50/);
    expect(report).toMatch(/2025-03-14  Acme Supply\s+99\.00/);
    expect(db.tables().expenses).toHaveLength(4); // the second ledger row (nothing within 5 days) is booked; the first is not
    // the parked row is in the portal, open, with the reason and the expense it may be, so the owner can link or create it there
    const parkedRow = db.tables().bank_transactions.find(b => b.txn_date === '2025-03-14');
    expect(parkedRow).toMatchObject({ status: 'unmatched', match_method: null });
    expect(parkedRow.matched_expense_id).toBeUndefined();
    expect(parkedRow.suggestion).toMatchObject({ review: true, ledgerClass: 'expense', note: expect.stringMatching(/^an expense of the same amount already in the portal: "Acme Supply" dated 2 days earlier: link this row to that expense in Bank Import, or create the expense there/) });
    // the candidates in the shape Bank Import's Link selector reads (the matcher's own), so the link is one click away
    expect(parkedRow.suggestion.candidates).toEqual([{ id: 'exp-a', amount: 12.5, description: 'receipt', vendor_name: 'Acme Supply', expense_date: '2025-03-12' }]);
    expect(parkedRow.suggestion.candidatesTotal).toBe(1);
    // the matcher offers candidates on it and never claims one (manualLink); the ledger's category rides along for Create expense
    expect(parkedRow.suggestion).toMatchObject({ manualLink: true, categoryId: 'cat-3', categoryName: 'Supplies', categorySource: 'ledger' });
    // a rerun before the owner decides it: the row is in the portal, open and without its expense, so it is held (listed), never loaded twice
    expect((await run({ file, db })).counts).toEqual({ read: 2, inserted: 0, duplicates: 1, held: 1, parked: 0, kept: 0, portalExpenses: 2 });
    expect(db.tables().bank_transactions).toHaveLength(2);
  });

  test('a portal expense one cent off (the matcher\'s candidate tolerance) parks the row too, naming the amount; two cents off does not', async () => {
    const file = fixture(row({ description: 'ACME SUPPLY 4471', amount: '12.50', date: '2025-03-14' }));
    const db = makeFakeDb();
    db.tables().expenses.push({ id: 'exp-near', expense_date: '2025-03-14', amount: '12.49', vendor_name: 'Acme Supply', description: 'x' });
    const { counts, report } = await run({ file, db });
    expect(counts).toMatchObject({ parked: 1, inserted: 1 });
    expect(report).toMatch(/\[an expense of the same amount within one cent already in the portal: "Acme Supply" dated the same day \(12\.49\); the ledger says expense \(Supplies\)\]/);
    expect(db.tables().expenses).toHaveLength(1);
    const db2 = makeFakeDb();
    db2.tables().expenses.push({ id: 'exp-far', expense_date: '2025-03-14', amount: '12.48', vendor_name: 'Acme Supply', description: 'x' });
    expect((await run({ file, db: db2 })).counts).toMatchObject({ parked: 0, inserted: 1 });
    expect(db2.tables().expenses).toHaveLength(2);
  });

  test('the nearby check runs again inside each row\'s write: an expense entered after the snapshot parks the row instead of being doubled', async () => {
    const file = fixture(row({ description: 'ACME SUPPLY 4471', amount: '12.50', date: '2025-03-14' }), row({ description: 'OTHER SHOP', amount: '5.00', date: '2025-03-15' }));
    const db = makeFakeDb();
    // the snapshot sees no expense; a hand expense lands just before the first row's write
    const realTx = db.transaction;
    let injected = false;
    db.transaction = async (fn) => {
      if (!injected) { injected = true; db.tables().expenses.push({ id: 'exp-race', expense_date: '2025-03-14', amount: '12.50', vendor_name: 'Acme Supply', description: 'entered meanwhile' }); }
      return realTx(fn);
    };
    const { counts, report } = await run({ file, db });
    expect(counts).toEqual({ read: 2, inserted: 2, duplicates: 0, held: 0, parked: 1, kept: 0, portalExpenses: 0 });
    expect(report).toMatch(/line 2 .*\[an expense of the same amount already in the portal: "Acme Supply" dated the same day \(entered after this run started\); the ledger says expense \(Supplies\)\]/);
    expect(db.tables().expenses.map(e => e.vendor_name)).toEqual(['Acme Supply', 'OTHER SHOP']); // no second Acme
    const parkedRow = db.tables().bank_transactions.find(b => b.description === 'ACME SUPPLY 4471');
    expect(parkedRow).toMatchObject({ status: 'unmatched' });
    expect(parkedRow.suggestion).toMatchObject({ review: true, manualLink: true, candidates: [expect.objectContaining({ id: 'exp-race' })] });
    // expenses this run made are the ledger's own: two identical fuel rows both book
    const file2 = fixture(row({ description: 'CORNER FUEL 12', amount: '4.00', class: 'vehicle', sched_c_line: '9', category: 'Vehicle fuel' }), row({ description: 'CORNER FUEL 12', amount: '4.00', class: 'vehicle', sched_c_line: '9', category: 'Vehicle fuel' }));
    const db2 = makeFakeDb();
    expect((await run({ file: file2, db: db2 })).counts).toMatchObject({ inserted: 2, parked: 0 });
    expect(db2.tables().expenses).toHaveLength(2);
  });

  test('a parked row whose category is missing from this database says so in the note and carries no category', async () => {
    const file = fixture();
    const db = makeFakeDb({ categories: [{ id: 'cat-x', name: 'Insurance' }] });
    db.tables().expenses.push({ id: 'exp-hand', expense_date: '2025-03-14', amount: '12.50', vendor_name: 'Acme Supply', description: 'supplies' });
    const { counts } = await run({ file, db });
    expect(counts).toMatchObject({ parked: 1, inserted: 1 });
    const parkedRow = db.tables().bank_transactions[0];
    expect(parkedRow.suggestion.note).toMatch(/; no category in the portal for line 22$/);
    expect(parkedRow.suggestion.categoryId).toBeUndefined();
    expect(parkedRow.suggestion.manualLink).toBe(true);
  });

  test('the shared matcher honors the manualLink marker the importer writes', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/bank-import.js'), 'utf8');
    expect(src).toMatch(/manualLinkOnly\(row\)/);
    expect(src).toMatch(/suggestion\.manualLink/);
  });

  test('no one-for-one assignment: two ledger rows near two receipts of one amount are both parked, every nearby expense listed on each', async () => {
    const file = fixture(row({ description: 'ACME SUPPLY 4471', amount: '12.50', date: '2025-03-05' }), row({ description: 'ACME SUPPLY 4471', amount: '12.50', date: '2025-03-10' }));
    const db = makeFakeDb();
    // the greedy trap: nearest-first would give Mar 5 the Mar 5 receipt and import Mar 10 (Feb 28 is outside its window), yet Mar 5's receipt could be Mar 10's
    db.tables().expenses.push({ id: 'exp-1', expense_date: '2025-02-28', amount: '12.50', vendor_name: 'First', description: 'x' });
    db.tables().expenses.push({ id: 'exp-2', expense_date: '2025-03-05', amount: '12.50', vendor_name: 'Second', description: 'x' });
    const { counts, report } = await run({ file, db });
    expect(counts).toEqual({ read: 2, inserted: 2, duplicates: 0, held: 0, parked: 2, kept: 0, portalExpenses: 2 });
    // listed and stored newest first, then id: the candidates endpoint's order, so later pages continue the same list
    expect(report).toMatch(/line 2 .*\[2 expenses of the same amount already in the portal: "Second" dated the same day, "First" dated 5 days earlier; the ledger says expense \(Supplies\)\]/);
    expect(report).toMatch(/line 3 .*\[an expense of the same amount already in the portal: "Second" dated 5 days earlier; the ledger says expense \(Supplies\)\]/);
    expect(db.tables().expenses).toHaveLength(2); // nothing booked
    expect(db.tables().bank_transactions.map(b => b.suggestion.candidates.map(c => c.id))).toEqual([['exp-2', 'exp-1'], ['exp-2']]);
  });

  test('an expense whose payment method cannot be this account (cash, ach or check vs a card row; cash vs a bank row) does not park the ledger row', async () => {
    let file = fixture(row({ description: 'ACME SUPPLY 4471', amount: '12.50', source: '9731' })); // a card row
    for (const [method, parked] of [['cash', 0], ['ach', 0], ['check', 0], ['card', 1], [null, 1]]) {
      const db = makeFakeDb();
      db.tables().expenses.push({ id: 'exp-h', expense_date: '2025-03-14', amount: '12.50', vendor_name: 'Acme Supply', description: 'supplies', payment_method: method });
      const { counts } = await run({ file, db });
      expect([method, counts.parked, counts.inserted, db.tables().expenses.length]).toEqual([method, parked, 1, 2 - parked]);
    }
    file = fixture(row({ description: 'ACME SUPPLY 4471', amount: '12.50', source: '3098' })); // a bank row: only cash is implausible
    for (const [method, parked] of [['cash', 0], ['ach', 1], ['check', 1]]) {
      const db = makeFakeDb();
      db.tables().expenses.push({ id: 'exp-h', expense_date: '2025-03-14', amount: '12.50', vendor_name: 'Acme Supply', description: 'supplies', payment_method: method });
      expect([method, (await run({ file, db })).counts.parked]).toEqual([method, parked]);
    }
  });

  test('an expense a refund reduced is compared at its gross amount (applied or released refund), as the matcher does', async () => {
    const file = fixture(row({ description: 'ACME SUPPLY 4471', amount: '100.00', date: '2025-03-14' }));
    for (const refund of [
      { status: 'refund_applied', amount: '20.00', suggestion: { refundAppliedTo: 'exp-r', refundAmount: 20 } },
      { status: 'ignored', amount: '20.00', suggestion: { releasedRefundOf: 'exp-r' } },
    ]) {
      const db = makeFakeDb();
      // entered by hand at 100, reduced to 80 by the refund the owner applied in Bank Import a month later (that credit is outside the file's range)
      db.tables().expenses.push({ id: 'exp-r', expense_date: '2025-03-14', amount: '80.00', vendor_name: 'Acme Supply', description: 'supplies' });
      db.tables().bank_transactions.push({ id: 'rf-1', row_hash: 'rf', source: 'csv', account_label: 'card 3098', txn_date: '2025-04-20', description: 'ACME REFUND', direction: 'credit', ...refund });
      const { counts, report } = await run({ file, db });
      expect(counts).toMatchObject({ parked: 1, inserted: 1, portalExpenses: 1 });
      expect(report).toMatch(/\[an expense of the same amount already in the portal: "Acme Supply" dated the same day \(80\.00 after refunds\); the ledger says expense \(Supplies\)\]/);
      expect(report).toMatch(/Acme Supply\s+80\.00 \(gross 100\.00 before refunds\)/);
      expect(db.tables().expenses).toHaveLength(1);
    }
    // without a refund the 80 and the 100 are different charges: the ledger row books
    const db3 = makeFakeDb();
    db3.tables().expenses.push({ id: 'exp-r', expense_date: '2025-03-14', amount: '80.00', vendor_name: 'Acme Supply', description: 'supplies' });
    expect((await run({ file, db: db3 })).counts).toMatchObject({ parked: 0, inserted: 1, portalExpenses: 1 });
    expect(db3.tables().expenses).toHaveLength(2);
  });

  test('an expense a feed row (posted outside the range) already holds cannot be linked again: the ledger row is parked as already booked, with no candidates', async () => {
    const file = fixture(row({ description: 'ACME SUPPLY 4471', amount: '100.00', date: '2025-03-14' }));
    const db = makeFakeDb();
    db.tables().expenses.push({ id: 'exp-l', expense_date: '2025-03-14', amount: '100.00', vendor_name: 'Acme Supply', description: 'supplies' });
    db.tables().bank_transactions.push({ id: 'pl-1', row_hash: 'h1', source: 'plaid', account_label: 'checking 3098', txn_date: '2025-03-15', description: 'ACME SUPPLY 4471', amount: '100.00', direction: 'debit', status: 'matched_expense', matched_expense_id: 'exp-l' });
    const { counts, report } = await run({ file, db });
    expect(counts).toEqual({ read: 1, inserted: 1, duplicates: 0, held: 0, parked: 1, kept: 0, portalExpenses: 1 });
    expect(report).toMatch(/\[already booked in the portal: an expense of the same amount linked to a feed or upload row \(checking 3098, posted 2025-03-15\); the ledger says expense \(Supplies\)\]/);
    expect(report).toMatch(/Acme Supply\s+100\.00 \(linked to a feed or upload row\)/);
    expect(db.tables().expenses).toHaveLength(1);
    const parkedRow = db.tables().bank_transactions.find(b => b.description === 'ACME SUPPLY 4471' && b.source === 'ledger-csv');
    expect(parkedRow.suggestion).toMatchObject({ review: true, manualLink: true, note: expect.stringMatching(/^already booked in the portal: .*: ignore this row if it is the same charge, or create the expense here if it is a different purchase$/) });
    expect(parkedRow.suggestion.candidates).toBeUndefined();
    // the ledger's category rides along here too: a different purchase books under its own line
    expect(parkedRow.suggestion).toMatchObject({ categoryId: 'cat-3', categoryName: 'Supplies', categorySource: 'ledger' });
  });

  test('after the commit the check runs once more on a fresh read (the matcher\'s post-claim verify): an expense that landed between the recheck and the insert reverts the booking into a park', async () => {
    const file = fixture(row({ description: 'ACME SUPPLY 4471', amount: '12.50', date: '2025-03-14' }), row({ description: 'OTHER SHOP', amount: '5.00', date: '2025-03-15' }));
    const db = makeFakeDb();
    // the hand expense commits right after the first row's transaction (after its recheck, before the verify)
    const realTx = db.transaction;
    let n = 0;
    db.transaction = async (fn) => {
      const out = await realTx(fn);
      n += 1;
      if (n === 1) db.tables().expenses.push({ id: 'exp-race', expense_date: '2025-03-14', amount: '12.50', vendor_name: 'Acme Supply', description: 'entered meanwhile' });
      return out;
    };
    const { counts, report } = await run({ file, db });
    expect(counts).toEqual({ read: 2, inserted: 2, duplicates: 0, held: 0, parked: 1, kept: 0, portalExpenses: 0 });
    expect(report).toMatch(/line 2 .*\(entered while this run wrote it\); the ledger says expense \(Supplies\)\]/);
    expect(db.tables().expenses.map(e => e.vendor_name).sort()).toEqual(['Acme Supply', 'OTHER SHOP']); // the ledger's Acme expense is gone again
    const parkedRow = db.tables().bank_transactions.find(b => b.description === 'ACME SUPPLY 4471');
    expect(parkedRow).toMatchObject({ status: 'unmatched', matched_expense_id: null, match_method: null });
    expect(parkedRow.suggestion).toMatchObject({ review: true, manualLink: true, candidates: [expect.objectContaining({ id: 'exp-race' })] });
  });

  test('a park whose row lost the insert race is neither counted nor reported', async () => {
    const file = fixture(row({ description: 'ACME SUPPLY 4471', amount: '12.50', date: '2025-03-14' }));
    const realDb = makeFakeDb();
    const first = parseLedgerCsv(fs.readFileSync(file, 'utf8'))[0];
    const hash = rowHash(first.source, first.date, first.description, first.amount, first.direction, 0);
    realDb.tables().bank_transactions.push({ id: 'pre', row_hash: hash, status: 'ignored', amount: first.amount, direction: first.direction });
    // a hand expense parks the row at write time; the existence lookup is blind, so the insert meets the hash
    realDb.tables().expenses.push({ id: 'exp-hand', expense_date: '2025-03-14', amount: '12.50', vendor_name: 'Acme Supply', description: 'supplies' });
    const blind = table => {
      if (table !== 'bank_transactions') return realDb(table);
      const real = realDb(table);
      return { ...real, insert: (...a) => real.insert(...a), whereIn: (col, vals) => (col === 'row_hash' ? { select: () => Promise.resolve([]) } : real.whereIn(col, vals)) };
    };
    blind.transaction = realDb.transaction;
    blind.raw = realDb.raw;
    blind.client = realDb.client;
    const { counts } = await run({ file, db: blind });
    expect(counts).toEqual({ read: 1, inserted: 0, duplicates: 1, held: 0, parked: 0, kept: 0, portalExpenses: 1 });
    expect(realDb.tables().expenses).toHaveLength(1); // no expense made for a row that was not written
  });

  test('the post-commit verify reverts only a row still holding this run\'s booking: a row another writer changed meanwhile keeps its state and the expense stands', async () => {
    const file = fixture(row({ description: 'ACME SUPPLY 4471', amount: '12.50', date: '2025-03-14' }));
    const realDb = makeFakeDb();
    // the lookup and the in-transaction recheck see no expense; by the verify after the commit a hand
    // expense exists AND someone unlinked the row (as Bank Import's unlink leaves it)
    let expenseReads = 0;
    const db = table => {
      if (table !== 'expenses') return realDb(table);
      const real = realDb(table);
      return {
        ...real,
        whereBetween: (...a) => {
          expenseReads += 1;
          if (expenseReads === 2) {
            realDb.tables().expenses.push({ id: 'exp-hand', expense_date: '2025-03-14', amount: '12.50', vendor_name: 'Acme Supply', description: 'supplies' });
            Object.assign(realDb.tables().bank_transactions.find(b => b.description === 'ACME SUPPLY 4471'), { status: 'unmatched', matched_expense_id: null, match_method: null });
          }
          return real.whereBetween(...a);
        },
      };
    };
    db.transaction = realDb.transaction;
    db.raw = realDb.raw;
    db.client = realDb.client;
    const { counts } = await run({ file, db });
    expect(expenseReads).toBe(2);
    expect(counts).toEqual({ read: 1, inserted: 1, duplicates: 0, held: 0, parked: 0, kept: 0, portalExpenses: 0 });
    // the other writer's state stands, and so does the expense it now refers to on its own terms
    expect(realDb.tables().bank_transactions[0]).toMatchObject({ status: 'unmatched', matched_expense_id: null });
    expect(realDb.tables().expenses.map(e => e.id).sort()).toEqual(['exp-hand', 'id-1'].sort());
  });

  test('a connected Plaid feed that starts inside the file\'s days refuses the load (the feed will deliver those rows itself); a feed starting after the file, a disabled account, a removed connection or another account\'s last four do not', async () => {
    const file = fixture(row({ source: '9731', date: '2025-03-14' }), row({ source: 'amex', date: '2025-03-20', description: 'AMEX ROW' }));
    const db = makeFakeDb();
    db.tables().plaid_items.push({ id: 'it-1', institution_name: 'Capital One', status: 'active' }, { id: 'it-2', institution_name: 'American Express', status: 'active' }, { id: 'it-3', institution_name: 'Capital One', status: 'removed' });
    db.tables().plaid_accounts.push({ id: 'pa-1', plaid_item_id: 'it-1', account_label: 'Spark Card', mask: '9731', sync_from: '2025-03-20', enabled: true });
    await expect(run({ file, db, dryRun: true })).rejects.toThrow(/^a connected bank feed starts inside this file's days and will deliver these rows itself: Spark Card \(Capital One …9731, from 2025-03-20\)\. Stop that feed, or start it after 2025-03-20, before loading this file$/);
    db.tables().plaid_accounts[0].sync_from = '2025-03-21'; // starts after the file's last day
    await expect(run({ file, db, dryRun: true })).resolves.toMatchObject({ counts: { read: 2 } });
    // a named source: the file's amex rows against an American Express connection, by institution (its mask is not the source)
    db.tables().plaid_accounts.push({ id: 'pa-2', plaid_item_id: 'it-2', account_label: 'Amex Blue', mask: '1005', sync_from: '2025-01-01', enabled: true });
    await expect(run({ file, db, dryRun: true })).rejects.toThrow(/Amex Blue \(American Express …1005, from 2025-01-01\)/);
    db.tables().plaid_accounts[1].enabled = false;
    db.tables().plaid_accounts.push({ id: 'pa-3', plaid_item_id: 'it-3', account_label: 'Old Spark', mask: '9731', sync_from: '2025-01-01', enabled: true }); // removed connection
    db.tables().plaid_accounts.push({ id: 'pa-4', plaid_item_id: 'it-1', account_label: 'Checking', mask: '0001', sync_from: '2025-01-01', enabled: true }); // not a source in this file
    await expect(run({ file, db, dryRun: true })).resolves.toMatchObject({ counts: { read: 2 } });
  });

  test('a rerun that changes an open credit between review and refund keeps the refund flag Bank Import keys on in step with the new reading; a settled row is left as decided', async () => {
    const credit = (over) => row({ description: 'ACME SUPPLY CREDIT', amount: '12.50', direction: 'in', sched_c_line: '', ...over });
    const file = fixture(credit({ class: 'review', category: 'Check this' }));
    const db = makeFakeDb();
    await run({ file, db });
    const stored = () => db.tables().bank_transactions[0];
    expect(stored()).toMatchObject({ status: 'unmatched', suggestion: expect.objectContaining({ review: true }) });
    expect(stored().suggestion.refundCredit).toBeUndefined();
    // review -> refund: the flag and its reason are set with the note
    fs.writeFileSync(file, csv(credit({ class: 'refund', category: 'Refund' })));
    expect((await run({ file, db })).counts).toMatchObject({ held: 1 });
    let merged = JSON.parse(stored().suggestion.bindings[0]);
    expect(merged).toMatchObject({ refundCredit: true, reason: expect.stringMatching(/^refund credit from the ledger/), review: true, ledgerClass: 'refund' });
    expect(stored().suggestion.sql).not.toMatch(/refundCredit/);
    // refund -> review: the flag and its reason go, only from a row that carried the flag (a transfer flag's reason is not touched)
    stored().suggestion = { ...merged };
    fs.writeFileSync(file, csv(credit({ class: 'review', category: 'Check this' })));
    expect((await run({ file, db })).counts).toMatchObject({ held: 1 });
    expect(stored().suggestion.sql).toMatch(/^\(case when jsonb_exists\(suggestion, 'refundCredit'\) then \(case when .* end\) - 'refundCredit' - 'reason' else \(case when .* end\) end\) \|\| \?::jsonb$/);
    merged = JSON.parse(stored().suggestion.bindings[0]);
    expect(merged.refundCredit).toBeUndefined();
    expect(merged.reason).toBeUndefined();
    // a row the owner settled since keeps what the decision left: no flag change either way
    stored().suggestion = { ...merged };
    stored().status = 'refund_applied';
    fs.writeFileSync(file, csv(credit({ class: 'refund', category: 'Refund' })));
    expect((await run({ file, db })).counts).toMatchObject({ held: 1 });
    expect(stored().suggestion.sql).not.toMatch(/refundCredit/);
    expect(JSON.parse(stored().suggestion.bindings[0]).refundCredit).toBeUndefined();
  });

  test('a run holds the ledger lock on one connection from its first read to its last write, and releases it on a refusal too', async () => {
    const file = fixture(row({ description: 'ACME SUPPLY 4471', amount: '12.50', date: '2025-03-14' }));
    const db = makeFakeDb();
    await run({ file, db });
    const [lock, ...rest] = db.log.locks;
    expect(lock).toEqual({ sql: 'select pg_advisory_lock(hashtext(?))', bindings: ['bank-import:ledger'], conn: 'conn-1', writes: 0 });
    expect(db.log.writes).toBeGreaterThan(0);
    expect(rest.find(l => /pg_advisory_unlock/.test(l.sql))).toEqual({ sql: 'select pg_advisory_unlock(hashtext(?))', bindings: ['bank-import:ledger'], conn: 'conn-1', writes: db.log.writes });
    expect(rest[rest.length - 1]).toEqual({ released: 'conn-1', writes: db.log.writes });
    // a refused run: unlocked and released all the same
    db.tables().plaid_items.push({ id: 'it', institution_name: 'Bank', status: 'active' });
    db.tables().plaid_accounts.push({ id: 'pa', plaid_item_id: 'it', account_label: 'Spark', mask: '9731', sync_from: '2025-01-01', enabled: true });
    fs.writeFileSync(file, csv(row({ source: '9731', date: '2025-03-14' })));
    await expect(run({ file, db })).rejects.toThrow(/a connected bank feed starts inside this file's days/);
    expect(db.log.locks.filter(l => /pg_advisory_unlock/.test(l.sql)).map(l => l.conn)).toEqual(['conn-1', 'conn-2']);
    expect(db.log.locks.filter(l => l.released).map(l => l.released)).toEqual(['conn-1', 'conn-2']);
  });

  test('a booking commits with its verify marker and clears it only after the check; a marker a dead run left is finished by the next run before the row is judged', async () => {
    const file = fixture(row({ description: 'ACME SUPPLY 4471', amount: '12.50', date: '2025-03-14' }));
    const db = makeFakeDb();
    const inserts = [];
    const seen = (t) => (table) => { const b = t(table); if (table === 'bank_transactions') { const ins = b.insert; b.insert = (rows) => { inserts.push(...(Array.isArray(rows) ? rows : [rows])); return ins(rows); }; } return b; };
    const spy = seen(db);
    spy.transaction = (fn) => db.transaction((trx) => fn(Object.assign(seen(trx), { raw: trx.raw })));
    spy.raw = db.raw; spy.client = db.client; spy.tables = db.tables; spy.log = db.log;
    expect((await run({ file, db: spy })).counts).toMatchObject({ inserted: 1, parked: 0 });
    const marker = inserts.find(r => r.status === 'created_expense').suggestion.ledgerVerifyPending;
    expect(marker).toEqual({ at: expect.any(String), expense: expect.objectContaining({ amount: 12.5, vendor_name: 'ACME SUPPLY 4471', category_id: 'cat-3' }) }); // committed with the booking, with what was written
    const stored = () => db.tables().bank_transactions[0];
    expect(stored().suggestion.ledgerVerifyPending).toBeUndefined(); // cleared after the check
    expect(stored().suggestion).toMatchObject({ ledgerClass: 'expense', schedCLine: '22' });
    // a run that died between the commit and the check: the marker is still set, and a hand expense landed in that gap
    stored().suggestion = { ...stored().suggestion, ledgerVerifyPending: marker };
    db.tables().expenses.push({ id: 'exp-hand', expense_date: '2025-03-14', amount: '12.50', vendor_name: 'Acme Supply', description: 'supplies' });
    const dry = await run({ file, db, dryRun: true });
    expect(dry.counts).toMatchObject({ kept: 1, parked: 0, duplicates: 1 });
    expect(dry.report).toMatch(/booked by an earlier run that ended before its check; the next run \(not a dry run\) checks it/);
    expect(db.tables().expenses).toHaveLength(2); // a dry run writes nothing
    const { counts, report } = await run({ file, db });
    expect(counts).toEqual({ read: 1, inserted: 0, duplicates: 1, held: 0, parked: 1, kept: 0, portalExpenses: 1 });
    expect(report).toMatch(/an expense of the same amount already in the portal: "Acme Supply" dated the same day \(entered while an earlier run wrote it; that run ended before its check\)/);
    expect(db.tables().expenses.map(e => e.id)).toEqual(['exp-hand']); // the doubled booking is gone
    expect(stored()).toMatchObject({ status: 'unmatched', matched_expense_id: null, suggestion: expect.objectContaining({ review: true, manualLink: true }) });
    expect(stored().suggestion.ledgerVerifyPending).toBeUndefined();
    // the dead run's expense was EDITED or REFUNDED before the next run: a check never deletes it; the booking is kept and the row says so
    for (const change of ['edited', 'edited-with-file', 'receipt', 'job', 'refunded']) {
      const db3 = makeFakeDb();
      const file3 = fixture(row({ description: 'ACME SUPPLY 4471', amount: '12.50', date: '2025-03-14' }));
      await run({ file: file3, db: db3 });
      const row3 = () => db3.tables().bank_transactions.find(b => b.source === 'ledger-csv');
      const booked = db3.tables().expenses.find(e => e.id === row3().matched_expense_id);
      const { id: _id, ...written } = booked;
      row3().suggestion = { ...row3().suggestion, ledgerVerifyPending: { at: '2025-03-14T00:00:00.000Z', expense: { ...written } } };
      db3.tables().expenses.push({ id: 'exp-hand', expense_date: '2025-03-14', amount: '12.50', vendor_name: 'Acme Supply', description: 'supplies' });
      if (change === 'edited') booked.description = 'owner note';
      else if (change === 'edited-with-file') {
        // the owner corrected the expense AND the file to the same text: against the file it looks untouched; against what was written it is edited
        booked.description = 'Office supplies';
        fs.writeFileSync(file3, csv(row({ description: 'ACME SUPPLY 4471', amount: '12.50', date: '2025-03-14', category: 'Office supplies' })));
      } else if (change === 'receipt') booked.receipt_s3_key = 'receipts/x.jpg'; // a column the ledger never set, filled since
      else if (change === 'job') booked.scheduled_service_id = 'svc-1';
      else db3.tables().bank_transactions.push({ id: 'rf', row_hash: 'rf', source: 'csv', status: 'refund_applied', amount: '2.00', direction: 'credit', suggestion: { refundAppliedTo: row3().matched_expense_id, refundAmount: 2 } });
      const out3 = await run({ file: file3, db: db3 });
      expect(out3.counts).toMatchObject({ kept: 1, parked: 0, inserted: 0, ...(change === 'edited-with-file' ? { held: 1, duplicates: 0 } : { held: 0, duplicates: 1 }) });
      expect(out3.report).toMatch(/bookings kept:\s+1 .*\n  line 2 .*this booking was kept: its expense was edited or refunded since, compare the two on the Expenses tab\]/);
      expect(db3.tables().expenses).toHaveLength(2); // nothing deleted
      expect(row3()).toMatchObject({ status: 'created_expense', matched_expense_id: expect.any(String) });
      if (change === 'edited-with-file') {
        expect(JSON.parse(row3().suggestion.bindings[0])).toMatchObject({ review: true, ledgerCategory: 'Office supplies', ledgerConflict: expect.objectContaining({ fileSays: expect.stringMatching(/Office supplies/) }) }); // the changed reading is held too
      } else {
        expect(row3().suggestion).toMatchObject({ review: true, note: expect.stringMatching(/this booking was kept/), ledgerClass: 'expense' });
        expect(row3().suggestion.ledgerVerifyPending).toBeUndefined();
      }
    }
    // a marker on a row the owner unlinked since: nothing to verify, the marker goes
    const db2 = makeFakeDb();
    await run({ file, db: db2 });
    Object.assign(db2.tables().bank_transactions[0], { status: 'unmatched', matched_expense_id: null, suggestion: { ...db2.tables().bank_transactions[0].suggestion, ledgerVerifyPending: { at: 'x', expense: {} } } });
    expect((await run({ file, db: db2 })).counts).toMatchObject({ parked: 0, kept: 0, held: 1 });
    expect(db2.tables().bank_transactions[0].suggestion.bindings).toBeDefined(); // held: open without its expense, noted
    expect(db2.tables().expenses).toHaveLength(1);
  });

  test('a rerun of an unchanged file keeps the note an open row already carries (a nearby expense, a missing category); a reopened row with none gets the plain one', async () => {
    const file = fixture(row({ description: 'ACME SUPPLY 4471', amount: '12.50', date: '2025-03-14' }));
    const db = makeFakeDb();
    db.tables().expenses.push({ id: 'exp-hand', expense_date: '2025-03-14', amount: '12.50', vendor_name: 'Acme Supply', description: 'supplies' });
    expect((await run({ file, db })).counts).toMatchObject({ parked: 1 });
    const stored = () => db.tables().bank_transactions[0];
    expect(stored().suggestion.note).toMatch(/^an expense of the same amount already in the portal/);
    expect((await run({ file, db })).counts).toMatchObject({ held: 1, duplicates: 0 });
    let merged = JSON.parse(stored().suggestion.bindings[0]);
    expect(merged.note).toBeUndefined(); // the park's own note stands
    expect(merged.ledgerConflict).toBeUndefined(); // the reading did not change
    expect(merged).toMatchObject({ review: true, ledgerClass: 'expense' });
    // a reopened row (its expense deleted, the row back to open with no note) gets the plain note
    stored().suggestion = { ledgerClass: 'expense', ledgerCategory: 'Supplies (chemicals, equipment, hardware)', schedCLine: '22', flag: '' };
    expect((await run({ file, db })).counts).toMatchObject({ held: 1 });
    merged = JSON.parse(stored().suggestion.bindings[0]);
    expect(merged.note).toMatch(/^loaded from the ledger as expense .* and still open without its expense: create the expense here, or ignore the row$/);
    expect(merged.ledgerConflict).toBeUndefined();
  });

  test('expenses the other year\'s ledger run made are the ledger\'s own: not listed, never held against, even within the window of this file', async () => {
    const file = fixture(row({ description: 'ACME SUPPLY 4471', amount: '12.50', date: '2025-01-02' }));
    const db = makeFakeDb();
    // the 2024 file's last charge, 3 days before this file's first row, same amount: still the ledger's own, not a portal expense
    db.tables().expenses.push({ id: 'exp-prior', expense_date: '2024-12-30', amount: '12.50', vendor_name: 'ACME SUPPLY 4471', description: 'x' });
    db.tables().bank_transactions.push({ id: 'led-1', row_hash: 'prior', source: 'ledger-csv', source_file: 'ledger-2024.csv', account_label: 'ledger-3098', txn_date: '2024-12-30', description: 'ACME SUPPLY 4471', amount: '12.50', direction: 'debit', status: 'created_expense', matched_expense_id: 'exp-prior' });
    const { counts } = await run({ file, db });
    expect(counts).toEqual({ read: 1, inserted: 1, duplicates: 0, held: 0, parked: 0, kept: 0, portalExpenses: 0 });
  });

  test('dry run reports the holds and the portal\'s expenses without writing', async () => {
    const file = fixture();
    const db = makeFakeDb();
    db.tables().expenses.push({ id: 'exp-hand', expense_date: '2025-03-14', amount: '12.50', vendor_name: 'Acme Supply', description: 'supplies' });
    const { counts, report } = await run({ file, db, dryRun: true });
    expect(counts).toEqual({ read: 1, inserted: 1, duplicates: 0, held: 0, parked: 1, kept: 0, portalExpenses: 1 });
    expect(report).toMatch(/^DRY RUN/);
    expect(report).toMatch(/parked for review:\s+1 /);
    expect(db.log.writes).toBe(0);
    expect(db.tables().bank_transactions).toHaveLength(0);
  });
});

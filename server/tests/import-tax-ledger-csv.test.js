const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  HEADER, parseLedgerCsv, mapRow, categoryNameForLine, rowHash, tupleKey, sameAccount, summarize, withOrdinals, parseArgs, run,
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
    expect(parseArgs(['--file=a.csv', '--dry-run'])).toEqual({ file: 'a.csv', dryRun: true, skipExisting: false });
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
    expect(m.bank.suggestion).toEqual({ ledgerClass: cls, ledgerCategory: 'Supplies (chemicals, equipment, hardware)', flag: 'F1', schedCLine: line });
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

  test('refund is an open refund credit, not ignored', () => {
    const m = mapRow(parsedRow({ direction: 'in', class: 'refund', sched_c_line: '' }), 0, 'l.csv');
    expect(m.bank.status).toBe('unmatched');
    expect(m.expense).toBeNull();
    expect(m.bank.suggestion).toMatchObject({ refundCredit: true, ledgerClass: 'refund' });
  });

  test.each(['personal', 'transfer', 'income_proc', 'reward'])('%s is ignored', cls => {
    const m = map({ class: cls, description: 'Zelle money sent to TEST HELPER', sched_c_line: '' });
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
    const m = map({ class: cls, flag: 'CHECK', sched_c_line: '22' });
    expect(m.bank.status).toBe('unmatched');
    expect(m.expense).toBeNull();
    expect(m.bank.suggestion).toMatchObject({ review: true, note: 'Supplies (chemicals, equipment, hardware) [CHECK]', schedCLine: '22', flag: 'CHECK' });
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
  let seq = 0;
  const log = { transactions: 0, rollbacks: 0, writes: 0 };

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
      first(expr) { state.first = expr || true; return b; },
      update(patch) { state.patch = patch; return b; },
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
          if (state.patch) { out.forEach(r => Object.assign(r, state.patch)); log.writes += 1; return out.length; }
          return out;
        }).then(resolve, reject);
      },
    };
    return b;
  }

  const db = table => builderFor(tables, table);
  db.raw = sql => ({ sql });
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
    expect(counts).toEqual({ read: 8, inserted: 8, duplicates: 0, overlaps: 0, held: 0, unsure: 0, handExpenses: 0 });
    expect(db.tables().bank_transactions).toHaveLength(0);
    expect(db.tables().expenses).toHaveLength(0);
    expect(db.log.writes).toBe(0);
    expect(db.log.transactions).toBe(0);
  });

  test('real run inserts bank rows and expenses, linked and categorized', async () => {
    const db = makeFakeDb();
    const { report, counts } = await run({ file, db });
    expect(report).not.toMatch(/DRY RUN/);
    expect(counts).toEqual({ read: 8, inserted: 8, duplicates: 0, overlaps: 0, held: 0, unsure: 0, handExpenses: 0 });

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
  });

  test('second run inserts nothing and creates no duplicate expense', async () => {
    const db = makeFakeDb();
    await run({ file, db });
    const before = { bank: db.tables().bank_transactions.length, exp: db.tables().expenses.length };
    const second = await run({ file, db });
    expect(second.counts).toEqual({ read: 8, inserted: 0, duplicates: 8, overlaps: 0, held: 0, unsure: 0, handExpenses: 0 });
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
    const { counts, summary } = await run({ file, db: blind });
    expect(counts).toEqual({ read: 8, inserted: 7, duplicates: 1, overlaps: 0, held: 0, unsure: 0, handExpenses: 0 });
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

  test('a range the portal already holds from a feed or upload is refused without --skip-existing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
    const file = path.join(dir, 'ledger-2025.csv');
    fs.writeFileSync(file, csv(row({ description: 'ACME SUPPLY 4471', amount: '12.50' })));
    const db = makeFakeDb();
    const target = parseLedgerCsv(fs.readFileSync(file, 'utf8'))[0];
    db.tables().bank_transactions.push({ id: 'up-1', row_hash: 'upload-hash', source: 'csv', account_label: 'capone-card-3098', txn_date: target.date, description: 'other', amount: '1.00', direction: 'debit', status: 'unmatched' });
    await expect(run({ file, db })).rejects.toThrow(/already holds 1 bank row\(s\).*rerun with --skip-existing/);
    expect(db.tables().bank_transactions).toHaveLength(1);
    expect(db.log.writes).toBe(0);
    // an expense in the range refuses too
    const db2 = makeFakeDb();
    db2.tables().expenses.push({ id: 'e1', expense_date: target.date, amount: '5.00', vendor_name: 'X' });
    await expect(run({ file, db: db2 })).rejects.toThrow(/0 bank row\(s\).*1 hand-entered expense\(s\)/);
  });

  test('--skip-existing: a bank row of the SAME account, day, amount and direction is left out; the account is read from the label or the Plaid mask', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
    const file = path.join(dir, 'ledger-2025.csv');
    fs.writeFileSync(file, csv(
      row({ description: 'ACME SUPPLY 4471', amount: '12.50' }),
      row({ description: 'CORNER FUEL 12', amount: '4.00', class: 'vehicle', sched_c_line: '9', category: 'Vehicle fuel' }),
    ));
    const db = makeFakeDb();
    const [first, second] = parseLedgerCsv(fs.readFileSync(file, 'utf8'));
    // an upload labelled with the account's last four, and a Plaid account whose mask is those digits
    db.tables().bank_transactions.push({ id: 'up-1', row_hash: 'h1', source: 'csv', account_label: 'capone-card-3098', txn_date: first.date, description: first.description.toLowerCase(), amount: first.amount, direction: 'debit', status: 'unmatched' });
    db.tables().plaid_accounts.push({ account_label: 'checking-main', mask: '3098' });
    db.tables().bank_transactions.push({ id: 'pl-1', row_hash: 'h2', source: 'plaid', account_label: 'checking-main', txn_date: new Date(`${second.date}T00:00:00`), description: 'Corner Fuel 12', amount: '4.00', direction: 'debit', status: 'created_expense', matched_expense_id: 'exp-x' });
    const { counts, summary, report } = await run({ file, db, skipExisting: true });
    // the booked row (created_expense) is answered: left out; the row still OPEN in the
    // portal is held and listed with the ledger's reading, never counted as present
    expect(counts).toEqual({ read: 2, inserted: 0, duplicates: 0, overlaps: 1, held: 1, unsure: 0, handExpenses: 0 });
    expect(summary.rows).toBe(0);
    expect(report).toMatch(/already in the portal:\s+1 /);
    expect(report).toMatch(/held, not imported:\s+1 /);
    expect(report).toMatch(/\[the same row is open in the portal, not booked; the ledger says expense \(Supplies\)\]  \(portal: "acme supply 4471" in capone-card-3098\)/);
    expect(db.tables().expenses).toHaveLength(0);
    expect(db.tables().bank_transactions).toHaveLength(2);
    // the same row linked in the portal is answered there: an overlap; IGNORED there while the
    // ledger books an expense is a conflict: held
    for (const [status, expected] of [['matched_expense', { overlaps: 1, held: 0 }], ['ignored', { overlaps: 0, held: 1 }]]) {
      const dbs = makeFakeDb();
      dbs.tables().bank_transactions.push({ id: 'up-1', row_hash: 'h1', source: 'csv', account_label: 'capone-card-3098', txn_date: first.date, description: first.description, amount: first.amount, direction: 'debit', status, matched_expense_id: status === 'matched_expense' ? 'exp-x' : null });
      const out = await run({ file, db: dbs, skipExisting: true });
      expect(out.counts).toMatchObject({ ...expected, inserted: 1 });
    }
  });

  test('--skip-existing: a matching bank row in ANOTHER or an unknown account does not consume the ledger row; it is imported and listed to check', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
    const file = path.join(dir, 'ledger-2025.csv');
    fs.writeFileSync(file, csv(row({ description: 'ACME SUPPLY 4471', amount: '12.50' })));
    const db = makeFakeDb();
    const first = parseLedgerCsv(fs.readFileSync(file, 'utf8'))[0];
    db.tables().bank_transactions.push({ id: 'up-9', row_hash: 'h9', source: 'csv', account_label: 'capone-card-9731', txn_date: first.date, description: first.description, amount: first.amount, direction: 'debit', status: 'unmatched' });
    const { counts, report } = await run({ file, db, skipExisting: true });
    expect(counts).toEqual({ read: 1, inserted: 1, duplicates: 0, overlaps: 0, held: 0, unsure: 1, handExpenses: 0 });
    expect(report).toMatch(/check these:\s+1 /);
    expect(report).toMatch(/portal account: capone-card-9731/);
    expect(db.tables().expenses).toHaveLength(1);
  });

  test('--skip-existing: matches are consumed one-for-one; two identical ledger rows against one portal row load one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
    const file = path.join(dir, 'ledger-2025.csv');
    fs.writeFileSync(file, csv(
      row({ description: 'CORNER FUEL 12', amount: '4.00', class: 'vehicle', sched_c_line: '9', category: 'Vehicle fuel' }),
      row({ description: 'CORNER FUEL 12', amount: '4.00', class: 'vehicle', sched_c_line: '9', category: 'Vehicle fuel' }),
    ));
    const db = makeFakeDb();
    const first = parseLedgerCsv(fs.readFileSync(file, 'utf8'))[0];
    db.tables().bank_transactions.push({ id: 'up-1', row_hash: 'h1', source: 'csv', account_label: 'card 3098', txn_date: first.date, description: 'Corner Fuel 12', amount: '4.00', direction: 'debit', status: 'created_expense', matched_expense_id: 'exp-x' });
    const { counts } = await run({ file, db, skipExisting: true });
    expect(counts).toEqual({ read: 2, inserted: 1, duplicates: 0, overlaps: 1, held: 0, unsure: 0, handExpenses: 0 });
    expect(db.tables().expenses).toHaveLength(1);
    expect(tupleKey({ txn_date: '2024-05-01', description: 'a  b', amount: '1', direction: 'debit' })).toBe('2024-05-01|A B|1.00|debit');
    expect(tupleKey({ txn_date: new Date(2024, 4, 1), description: 'A B', amount: 1, direction: 'debit' })).toBe('2024-05-01|A B|1.00|debit');
  });
});

describe('--skip-existing and expenses', () => {
  const fixture = (...extra) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
    const file = path.join(dir, 'ledger-2025.csv');
    fs.writeFileSync(file, csv(row({ description: 'ACME SUPPLY 4471', amount: '12.50' }), ...extra));
    return file;
  };

  test('a hand-entered expense in the range refuses without the flag; with it, it is listed, never matched by guesswork', async () => {
    const file = fixture();
    const db = makeFakeDb();
    const first = parseLedgerCsv(fs.readFileSync(file, 'utf8'))[0];
    db.tables().expenses.push({ id: 'exp-hand', expense_date: first.date, amount: '12.50', vendor_name: 'Acme Supply', description: 'supplies' });
    await expect(run({ file, db })).rejects.toThrow(/1 hand-entered expense\(s\)/);
    // same day and amount: the ledger row is held for the owner, not booked on top of it
    const { counts, report } = await run({ file, db, skipExisting: true });
    expect(counts).toEqual({ read: 1, inserted: 0, duplicates: 0, overlaps: 0, held: 1, unsure: 0, handExpenses: 1 });
    expect(report).toMatch(/hand-entered expenses:\s+1 in this range/);
    expect(report).toMatch(/Acme Supply\s+12\.50/);
    expect(report).toMatch(/\[a hand-entered expense of the same amount, dated the same day; the ledger says expense \(Supplies\)\]  \(portal: "Acme Supply" in a hand-entered expense\)/);
    expect(db.tables().expenses).toHaveLength(1);
    // a different amount on the same day is not held
    const db2 = makeFakeDb();
    db2.tables().expenses.push({ id: 'exp-other', expense_date: first.date, amount: '99.00', vendor_name: 'Acme Supply', description: 'supplies' });
    const out2 = await run({ file, db: db2, skipExisting: true });
    expect(out2.counts).toEqual({ read: 1, inserted: 1, duplicates: 0, overlaps: 0, held: 0, unsure: 0, handExpenses: 1 });
    expect(db2.tables().expenses).toHaveLength(2);
  });

  test('a hand-entered expense of the same amount within the matcher window (receipt vs posting date) holds the row; outside it does not; nearest first, one-for-one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
    const file = path.join(dir, 'ledger-2025.csv');
    fs.writeFileSync(file, csv(
      row({ description: 'ACME SUPPLY 4471', amount: '12.50', date: '2025-03-14' }),
      row({ description: 'ACME SUPPLY 4471', amount: '12.50', date: '2025-03-20' }),
    ));
    const db = makeFakeDb();
    // a receipt dated 2 days before the first posting holds that row; a receipt 6 days before it is outside the
    // window (and outside the file's range widened by the window: not loaded, not listed), so the second ledger
    // row books
    db.tables().expenses.push({ id: 'exp-a', expense_date: '2025-03-12', amount: '12.50', vendor_name: 'Acme Supply', description: 'receipt' });
    db.tables().expenses.push({ id: 'exp-b', expense_date: '2025-03-08', amount: '12.50', vendor_name: 'Acme Supply', description: 'older receipt' });
    const { counts, report } = await run({ file, db, skipExisting: true });
    expect(counts).toEqual({ read: 2, inserted: 1, duplicates: 0, overlaps: 0, held: 1, unsure: 0, handExpenses: 1 });
    expect(report).toMatch(/line 2 .*\[a hand-entered expense of the same amount, dated 2 days earlier; the ledger says expense \(Supplies\)\]/);
    expect(db.tables().expenses).toHaveLength(3); // the second ledger row (no expense within 5 days) is booked
    // the nearest expense is the one held against, even when a farther one comes first in the list
    const db2 = makeFakeDb();
    db2.tables().expenses.push({ id: 'exp-far', expense_date: '2025-03-19', amount: '12.50', vendor_name: 'Far', description: 'x' });
    db2.tables().expenses.push({ id: 'exp-near', expense_date: '2025-03-15', amount: '12.50', vendor_name: 'Near', description: 'x' });
    const out2 = await run({ file, db: db2, skipExisting: true });
    expect(out2.counts).toMatchObject({ held: 2, inserted: 0 });
    expect(out2.report).toMatch(/line 2 .*dated 1 day later.*\(portal: "Near" in a hand-entered expense\)/);
    expect(out2.report).toMatch(/line 3 .*dated 1 day earlier.*\(portal: "Far" in a hand-entered expense\)/);
  });

  test.each([
    ['matched_expense', { matched_expense_id: null }, /its expense was deleted/],
    ['created_expense', { matched_expense_id: null }, /its expense was deleted/],
    ['matched_payout', { matched_payout_id: null }, /its payout link is gone/],
  ])('an exact overlap whose %s link is dangling is held as open, not counted as booked', async (status, link, re) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
    const file = path.join(dir, 'ledger-2025.csv');
    fs.writeFileSync(file, csv(row({ description: 'ACME SUPPLY 4471', amount: '12.50' })));
    const db = makeFakeDb();
    const first = parseLedgerCsv(fs.readFileSync(file, 'utf8'))[0];
    db.tables().bank_transactions.push({ id: 'up-1', row_hash: 'h1', source: 'csv', account_label: 'card 3098', txn_date: first.date, description: first.description, amount: first.amount, direction: 'debit', status, ...link });
    const { counts, report } = await run({ file, db, skipExisting: true });
    expect(counts).toMatchObject({ overlaps: 0, held: 1, inserted: 0 });
    expect(report).toMatch(re);
    // the same statuses with a live link are answered: an overlap
    const db2 = makeFakeDb();
    db2.tables().bank_transactions.push({ id: 'up-1', row_hash: 'h1', source: 'csv', account_label: 'card 3098', txn_date: first.date, description: first.description, amount: first.amount, direction: 'debit', status, matched_expense_id: 'exp-x', matched_payout_id: 'po-x' });
    expect((await run({ file, db: db2, skipExisting: true })).counts).toMatchObject({ overlaps: 1, held: 0, inserted: 0 });
  });

  test('an expense linked to a bank row posted a day after the ledger charge still holds the row; the row and its expense are consumed once', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
    const file = path.join(dir, 'ledger-2025.csv');
    fs.writeFileSync(file, csv(row({ description: 'ACME SUPPLY 4471', amount: '100.00', date: '2025-03-14' }), row({ description: 'OTHER SHOP', amount: '5.00', date: '2025-03-20' })));
    const linked = (db) => {
      db.tables().expenses.push({ id: 'exp-l', expense_date: '2025-03-14', amount: '100.00', vendor_name: 'Acme Supply', description: 'supplies' });
      db.tables().bank_transactions.push({ id: 'pl-1', row_hash: 'h1', source: 'plaid', account_label: 'checking 3098', txn_date: '2025-03-15', description: 'ACME SUPPLY 4471', amount: '100.00', direction: 'debit', status: 'matched_expense', matched_expense_id: 'exp-l' });
    };
    const db = makeFakeDb();
    linked(db);
    const { counts, report } = await run({ file, db, skipExisting: true });
    // the exact-day overlap misses (posted the 15th, charged the 14th); the linked expense holds the row
    expect(counts).toEqual({ read: 2, inserted: 1, duplicates: 0, overlaps: 0, held: 1, unsure: 0, handExpenses: 0 });
    expect(report).toMatch(/line 2 .*\[an expense linked to a bank row of the same amount, dated the same day; the ledger says expense \(Supplies\)\]  \(portal: "Acme Supply" in an expense linked to a bank row\)/);
    expect(db.tables().expenses).toHaveLength(2); // exp-l + OTHER SHOP, no second Acme
    // one transaction, consumed once: when the ledger also carries the posting-day row (exact overlap),
    // the overlap takes the bank row AND its expense, and the charge-day row loads as its own purchase
    const db2 = makeFakeDb();
    linked(db2);
    fs.writeFileSync(file, csv(
      row({ description: 'ACME SUPPLY 4471', amount: '100.00', date: '2025-03-14' }),
      row({ description: 'ACME SUPPLY 4471', amount: '100.00', date: '2025-03-15' }),
    ));
    const out2 = await run({ file, db: db2, skipExisting: true });
    expect(out2.counts).toEqual({ read: 2, inserted: 1, duplicates: 0, overlaps: 1, held: 0, unsure: 0, handExpenses: 0 });
    // and the other way round: the expense taken by a hold takes its bank row out of the overlap pools
    const db3 = makeFakeDb();
    linked(db3);
    fs.writeFileSync(file, csv(
      row({ description: 'ACME SUPPLY 4471', amount: '100.00', date: '2025-03-16' }),
      row({ description: 'Acme supply 4471 posted', amount: '100.00', date: '2025-03-15' }),
    ));
    const out3 = await run({ file, db: db3, skipExisting: true });
    // row 1 (the 16th, within the window) holds against exp-l and takes pl-1 with it; row 2 (same day,
    // amount and account as pl-1 under other text) finds no row left and loads
    expect(out3.counts).toEqual({ read: 2, inserted: 1, duplicates: 0, overlaps: 0, held: 1, unsure: 0, handExpenses: 0 });
    // a linked expense carries its bank row's ACCOUNT: the same amount on another card is a distinct purchase
    const db4 = makeFakeDb();
    db4.tables().expenses.push({ id: 'exp-l', expense_date: '2025-03-14', amount: '100.00', vendor_name: 'Acme Supply', description: 'supplies' });
    db4.tables().bank_transactions.push({ id: 'pl-1', row_hash: 'h1', source: 'plaid', account_label: 'card 9731', txn_date: '2025-03-15', description: 'ACME SUPPLY 4471', amount: '100.00', direction: 'debit', status: 'matched_expense', matched_expense_id: 'exp-l' });
    fs.writeFileSync(file, csv(row({ description: 'ACME SUPPLY 4471', amount: '100.00', date: '2025-03-14', source: '3098' })));
    const out4 = await run({ file, db: db4, skipExisting: true });
    expect(out4.counts).toEqual({ read: 1, inserted: 1, duplicates: 0, overlaps: 0, held: 0, unsure: 0, handExpenses: 0 });
    expect(db4.tables().expenses).toHaveLength(2);
  });

  test('a hand-entered expense whose payment method cannot be this account (cash vs a card row, ach vs a card row) does not hold the ledger row', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
    const file = path.join(dir, 'ledger-2025.csv');
    fs.writeFileSync(file, csv(row({ description: 'ACME SUPPLY 4471', amount: '12.50', source: '9731' }))); // a card row
    for (const [method, held] of [['cash', 0], ['ach', 0], ['check', 0], ['card', 1], [null, 1]]) {
      const db = makeFakeDb();
      db.tables().expenses.push({ id: 'exp-h', expense_date: '2025-03-14', amount: '12.50', vendor_name: 'Acme Supply', description: 'supplies', payment_method: method });
      const { counts } = await run({ file, db, skipExisting: true });
      expect([method, counts.held, counts.inserted]).toEqual([method, held, 1 - held]);
    }
    // a bank row: only cash is implausible
    fs.writeFileSync(file, csv(row({ description: 'ACME SUPPLY 4471', amount: '12.50', source: '3098' })));
    for (const [method, held] of [['cash', 0], ['ach', 1], ['check', 1]]) {
      const db = makeFakeDb();
      db.tables().expenses.push({ id: 'exp-h', expense_date: '2025-03-14', amount: '12.50', vendor_name: 'Acme Supply', description: 'supplies', payment_method: method });
      expect([method, (await run({ file, db, skipExisting: true })).counts.held]).toEqual([method, held]);
    }
  });

  test('an expense an earlier ledger run made just outside the file range (inside the window) is the ledger\'s own: never held against', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
    const file = path.join(dir, 'ledger-2025.csv');
    fs.writeFileSync(file, csv(row({ description: 'ACME SUPPLY 4471', amount: '12.50', date: '2025-03-14' })));
    const db = makeFakeDb();
    // the earlier run loaded a 12.50 charge on the 12th and made its expense
    db.tables().expenses.push({ id: 'exp-prior', expense_date: '2025-03-12', amount: '12.50', vendor_name: 'ACME SUPPLY 4471', description: 'x' });
    db.tables().bank_transactions.push({ id: 'led-1', row_hash: 'prior', source: 'ledger-csv', account_label: 'ledger-3098', txn_date: '2025-03-12', description: 'ACME SUPPLY 4471', amount: '12.50', direction: 'debit', status: 'created_expense', matched_expense_id: 'exp-prior' });
    const { counts } = await run({ file, db, skipExisting: true });
    expect(counts).toEqual({ read: 1, inserted: 1, duplicates: 0, overlaps: 0, held: 0, unsure: 0, handExpenses: 0 });
  });

  test('an exact overlap the portal IGNORED is held when the ledger books an expense, and settled when the ledger also ignores it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
    const file = path.join(dir, 'ledger-2025.csv');
    fs.writeFileSync(file, csv(row({ description: 'ACME SUPPLY 4471', amount: '12.50' })));
    const db = makeFakeDb();
    const first = parseLedgerCsv(fs.readFileSync(file, 'utf8'))[0];
    db.tables().bank_transactions.push({ id: 'up-1', row_hash: 'h1', source: 'csv', account_label: 'card 3098', txn_date: first.date, description: first.description, amount: first.amount, direction: 'debit', status: 'ignored' });
    const { counts, report } = await run({ file, db, skipExisting: true });
    expect(counts).toMatchObject({ overlaps: 0, held: 1, inserted: 0 });
    expect(report).toMatch(/the portal ignored this row but the ledger says it is business/);
    // a refund credit the portal ignored WITHOUT applying it leaves the expense at its gross
    // amount: held; a released refund (releasedRefundOf) is accounted for: an overlap
    fs.writeFileSync(file, csv(row({ description: 'ACME SUPPLY REFUND', amount: '12.50', direction: 'in', class: 'refund', sched_c_line: '', category: 'Refund' })));
    for (const [suggestion, expected] of [[null, { held: 1, overlaps: 0 }], [{ releasedRefundOf: 'exp-9' }, { held: 0, overlaps: 1 }]]) {
      const dbr = makeFakeDb();
      dbr.tables().bank_transactions.push({ id: 'up-r', row_hash: 'hr', source: 'csv', account_label: 'card 3098', txn_date: first.date, description: 'ACME SUPPLY REFUND', amount: 12.5, direction: 'credit', status: 'ignored', suggestion });
      const out = await run({ file, db: dbr, skipExisting: true });
      expect([suggestion, out.counts.held, out.counts.overlaps]).toEqual([suggestion, expected.held, expected.overlaps]);
      if (!suggestion) expect(out.report).toMatch(/ignored this refund credit without applying it/);
    }
    // the mirror conflict: the portal BOOKED an expense, the ledger says personal: held; a ledger
    // expense against a booked row is the same answer: an overlap
    fs.writeFileSync(file, csv(row({ description: 'ACME SUPPLY 4471', amount: '12.50', class: 'personal', sched_c_line: '', category: 'Personal' })));
    for (const [status, link, expected] of [['created_expense', 'exp-x', { held: 1, overlaps: 0 }], ['matched_expense', 'exp-x', { held: 1, overlaps: 0 }], ['matched_payout', null, { held: 0, overlaps: 1 }]]) {
      const dbb = makeFakeDb();
      dbb.tables().bank_transactions.push({ id: 'up-b', row_hash: 'hb', source: 'csv', account_label: 'card 3098', txn_date: first.date, description: first.description, amount: first.amount, direction: 'debit', status, matched_expense_id: link, matched_payout_id: status === 'matched_payout' ? 'po-x' : null });
      const out = await run({ file, db: dbb, skipExisting: true });
      expect([status, out.counts.held, out.counts.overlaps]).toEqual([status, expected.held, expected.overlaps]);
      if (expected.held) expect(out.report).toMatch(/the portal booked this row as an expense but the ledger does not/);
    }
    // both say expense but under different categories: held for the owner to pick; the same
    // category (or an expense whose category is unknown here) is the same answer
    fs.writeFileSync(file, csv(row({ description: 'ACME SUPPLY 4471', amount: '12.50' }))); // Supplies (line 22)
    for (const [categoryName, expected] of [['Advertising & Marketing', { held: 1, overlaps: 0 }], ['Supplies', { held: 0, overlaps: 1 }], [null, { held: 0, overlaps: 1 }]]) {
      const dbc = makeFakeDb();
      const cat = dbc.tables().expense_categories.find(c => c.name === categoryName);
      dbc.tables().expenses.push({ id: 'exp-booked', expense_date: first.date, amount: '12.50', vendor_name: 'Acme Supply', description: 'supplies', category_id: cat ? cat.id : null });
      dbc.tables().bank_transactions.push({ id: 'up-c', row_hash: 'hc', source: 'csv', account_label: 'card 3098', txn_date: first.date, description: first.description, amount: first.amount, direction: 'debit', status: 'created_expense', matched_expense_id: 'exp-booked' });
      const out = await run({ file, db: dbc, skipExisting: true });
      expect([categoryName, out.counts.held, out.counts.overlaps]).toEqual([categoryName, expected.held, expected.overlaps]);
      if (expected.held) expect(out.report).toMatch(/booked this row under Advertising & Marketing, the ledger says Supplies/);
    }
    // a credit the portal linked to a payout while the ledger says refund: held; a processor
    // deposit the ledger also reads as income is the same answer
    for (const [cls, expected] of [['refund', { held: 1, overlaps: 0 }], ['income_proc', { held: 0, overlaps: 1 }]]) {
      fs.writeFileSync(file, csv(row({ description: 'PROCESSOR CREDIT 77', amount: '12.50', direction: 'in', class: cls, sched_c_line: '', category: cls === 'refund' ? 'Refund' : 'Income' })));
      const dbp = makeFakeDb();
      dbp.tables().bank_transactions.push({ id: 'up-p', row_hash: 'hp', source: 'csv', account_label: 'checking 3098', txn_date: first.date, description: 'PROCESSOR CREDIT 77', amount: 12.5, direction: 'credit', status: 'matched_payout', matched_payout_id: 'po-1' });
      const out = await run({ file, db: dbp, skipExisting: true });
      expect([cls, out.counts.held, out.counts.overlaps]).toEqual([cls, expected.held, expected.overlaps]);
      if (expected.held) expect(out.report).toMatch(/linked this credit to a payout but the ledger says it is a refund credit/);
    }
    // a business row the ledger PARKED (a line with no category here, 16b) is business all the same:
    // ignored in the portal = conflict; booked in the portal = the category needs a check
    fs.writeFileSync(file, csv(row({ description: 'ACME SUPPLY 4471', amount: '12.50', class: 'interest', sched_c_line: '16b', category: 'Card interest' })));
    for (const [status, link, re] of [['ignored', null, /ledger says it is business/], ['created_expense', 'exp-x', /line 16b has no category here/]]) {
      const dbq = makeFakeDb();
      dbq.tables().bank_transactions.push({ id: 'up-q', row_hash: 'hq', source: 'csv', account_label: 'card 3098', txn_date: first.date, description: first.description, amount: first.amount, direction: 'debit', status, matched_expense_id: link });
      const out = await run({ file, db: dbq, skipExisting: true });
      expect([status, out.counts.held, out.counts.overlaps]).toEqual([status, 1, 0]);
      expect(out.report).toMatch(re);
    }
    // the ledger says personal too: the portal's ignore is the same answer
    fs.writeFileSync(file, csv(row({ description: 'ACME SUPPLY 4471', amount: '12.50', class: 'personal', sched_c_line: '', category: 'Personal' })));
    const db2 = makeFakeDb();
    db2.tables().bank_transactions.push({ id: 'up-1', row_hash: 'h1', source: 'csv', account_label: 'card 3098', txn_date: first.date, description: first.description, amount: first.amount, direction: 'debit', status: 'ignored' });
    expect((await run({ file, db: db2, skipExisting: true })).counts).toMatchObject({ overlaps: 1, held: 0, inserted: 0 });
  });

  test('a Plaid row whose account label was renamed since still resolves to its account through plaid_account_id', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
    const file = path.join(dir, 'ledger-2025.csv');
    fs.writeFileSync(file, csv(row({ description: 'ACME SUPPLY 4471', amount: '12.50', source: '3098' })));
    const db = makeFakeDb();
    const first = parseLedgerCsv(fs.readFileSync(file, 'utf8'))[0];
    // the account was first labelled without its last four, then renamed; old rows keep the old label
    db.tables().plaid_accounts.push({ account_id: 'plaid-acct-1', account_label: 'main checking 3098', mask: '3098' });
    db.tables().bank_transactions.push({ id: 'pl-1', row_hash: 'h1', source: 'plaid', account_label: 'main checking', plaid_account_id: 'plaid-acct-1', txn_date: first.date, description: first.description, amount: first.amount, direction: 'debit', status: 'created_expense', matched_expense_id: 'exp-x' });
    expect((await run({ file, db, skipExisting: true })).counts).toMatchObject({ overlaps: 1, held: 0, inserted: 0 });
    // another Plaid account's row (other mask) is not this account, even when its stale label
    // carries the ledger's digits: the resolved mask is the answer either way
    const db2 = makeFakeDb();
    db2.tables().plaid_accounts.push({ account_id: 'plaid-acct-2', account_label: 'savings 7777', mask: '7777' });
    db2.tables().bank_transactions.push({ id: 'pl-2', row_hash: 'h2', source: 'plaid', account_label: 'old label 3098', plaid_account_id: 'plaid-acct-2', txn_date: first.date, description: first.description, amount: first.amount, direction: 'debit', status: 'created_expense', matched_expense_id: 'exp-x' });
    expect((await run({ file, db: db2, skipExisting: true })).counts).toMatchObject({ overlaps: 0, unsure: 1, inserted: 1 });
    // the amex source has no mask to compare: the Plaid account's CURRENT label carries the alias
    fs.writeFileSync(file, csv(row({ description: 'ACME SUPPLY 4471', amount: '12.50', source: 'amex' })));
    const db3 = makeFakeDb();
    db3.tables().plaid_accounts.push({ account_id: 'plaid-amex', account_label: 'American Express Blue 1005', mask: '1005' });
    db3.tables().bank_transactions.push({ id: 'pl-3', row_hash: 'h3', source: 'plaid', account_label: 'blue card', plaid_account_id: 'plaid-amex', txn_date: first.date, description: first.description, amount: first.amount, direction: 'debit', status: 'created_expense', matched_expense_id: 'exp-x' });
    expect((await run({ file, db: db3, skipExisting: true })).counts).toMatchObject({ overlaps: 1, held: 0, inserted: 0 });
    // and a numeric source never matches a Plaid account whose label merely says amex
    fs.writeFileSync(file, csv(row({ description: 'ACME SUPPLY 4471', amount: '12.50', source: '3098' })));
    const db4 = makeFakeDb();
    db4.tables().plaid_accounts.push({ account_id: 'plaid-amex', account_label: 'amex 3098 rewards', mask: '1005' });
    db4.tables().bank_transactions.push({ id: 'pl-4', row_hash: 'h4', source: 'plaid', account_label: 'amex 3098 rewards', plaid_account_id: 'plaid-amex', txn_date: first.date, description: first.description, amount: first.amount, direction: 'debit', status: 'created_expense', matched_expense_id: 'exp-x' });
    expect((await run({ file, db: db4, skipExisting: true })).counts).toMatchObject({ overlaps: 0, inserted: 1 });
  });

  test('a hand-entered expense a refund reduced is compared at its gross amount (applied or released refund), as the matcher does', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
    const file = path.join(dir, 'ledger-2025.csv');
    fs.writeFileSync(file, csv(row({ description: 'ACME SUPPLY 4471', amount: '100.00', date: '2025-03-14' })));
    for (const refund of [
      { status: 'refund_applied', amount: '20.00', suggestion: { refundAppliedTo: 'exp-r', refundAmount: 20 } },
      { status: 'ignored', amount: '20.00', suggestion: { releasedRefundOf: 'exp-r' } },
    ]) {
      const db = makeFakeDb();
      // entered by hand at 100, reduced to 80 by the refund the owner applied in Bank Import a month later
      db.tables().expenses.push({ id: 'exp-r', expense_date: '2025-03-14', amount: '80.00', vendor_name: 'Acme Supply', description: 'supplies' });
      db.tables().bank_transactions.push({ id: 'rf-1', row_hash: 'rf', source: 'csv', account_label: 'card 3098', txn_date: '2025-04-20', description: 'ACME REFUND', direction: 'credit', ...refund });
      const { counts, report } = await run({ file, db, skipExisting: true });
      expect(counts).toMatchObject({ held: 1, inserted: 0, handExpenses: 1 });
      expect(report).toMatch(/\[a hand-entered expense of the same amount \(80\.00 after refunds\), dated the same day; the ledger says expense \(Supplies\)\]/);
      expect(report).toMatch(/Acme Supply\s+80\.00 \(gross 100\.00 before refunds\)/);
      expect(db.tables().expenses).toHaveLength(1);
    }
    // without a refund the 80 and the 100 are different charges: the ledger row books
    const db3 = makeFakeDb();
    db3.tables().expenses.push({ id: 'exp-r', expense_date: '2025-03-14', amount: '80.00', vendor_name: 'Acme Supply', description: 'supplies' });
    expect((await run({ file, db: db3, skipExisting: true })).counts).toMatchObject({ held: 0, inserted: 1, handExpenses: 1 });
  });

  test('an expense linked to a bank row is covered through that row: not listed, and the refusal does not count it', async () => {
    const file = fixture();
    const db = makeFakeDb();
    const first = parseLedgerCsv(fs.readFileSync(file, 'utf8'))[0];
    db.tables().expenses.push({ id: 'exp-up', expense_date: first.date, amount: '12.50', vendor_name: 'ACME SUPPLY 4471', description: 'x' });
    db.tables().bank_transactions.push({ id: 'up-1', row_hash: 'h1', source: 'csv', account_label: 'card-3098', txn_date: first.date, description: 'ACME SUPPLY 4471', amount: '12.50', direction: 'debit', status: 'created_expense', matched_expense_id: 'exp-up' });
    await expect(run({ file, db })).rejects.toThrow(/1 bank row\(s\).*0 hand-entered/);
    const { counts } = await run({ file, db, skipExisting: true });
    expect(counts).toEqual({ read: 1, inserted: 0, duplicates: 0, overlaps: 1, held: 0, unsure: 0, handExpenses: 0 });
    expect(db.tables().expenses).toHaveLength(1);
  });

  test('expenses an earlier ledger run made are the ledger\'s own: a second run is not refused for them', async () => {
    const file = fixture();
    const db = makeFakeDb();
    await run({ file, db });
    const second = await run({ file, db });
    expect(second.counts).toEqual({ read: 1, inserted: 0, duplicates: 1, overlaps: 0, held: 0, unsure: 0, handExpenses: 0 });
  });

  test('sameAccount: the ledger source (last four or amex) must appear in the label or equal the Plaid mask', () => {
    const masks = new Map([['checking-main', '3098']]);
    expect(sameAccount('3098', 'capone-card-3098', masks)).toBe(true);
    expect(sameAccount('3098', 'checking-main', masks)).toBe(true);
    expect(sameAccount('amex', 'Amex Business', masks)).toBe(true);
    // Plaid's default label for the card spells the issuer out
    expect(sameAccount('amex', 'american-express-card-1005', masks)).toBe(true);
    expect(sameAccount('amex', 'American Express Blue', masks)).toBe(true);
    expect(sameAccount('amex', 'capone-card-3098', masks)).toBe(false);
    expect(sameAccount('3098', 'capone-card-9731', masks)).toBe(false);
    expect(sameAccount('3098', 'checking', masks)).toBe(false);
    expect(sameAccount('', 'capone-card-3098', masks)).toBe(false);
  });

  test('dry run with --skip-existing reports what it would leave out without writing', async () => {
    const file = fixture();
    const db = makeFakeDb();
    const first = parseLedgerCsv(fs.readFileSync(file, 'utf8'))[0];
    db.tables().bank_transactions.push({ id: 'up-1', row_hash: 'h1', source: 'csv', account_label: 'card-3098', txn_date: first.date, description: first.description, amount: '12.50', direction: 'debit', status: 'created_expense', matched_expense_id: 'exp-x' });
    const { counts, report } = await run({ file, db, dryRun: true, skipExisting: true });
    expect(counts).toEqual({ read: 1, inserted: 0, duplicates: 0, overlaps: 1, held: 0, unsure: 0, handExpenses: 0 });
    expect(report).toMatch(/DRY RUN/);
    expect(db.log.writes).toBe(0);
  });

  test('a same-account row of the same day, amount and direction under different text HOLDS the ledger row', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
    const file = path.join(dir, 'ledger-2025.csv');
    fs.writeFileSync(file, csv(
      row({ description: 'DEBIT CARD PURCHASE - WAWA 5519 BRADENTON FL', amount: '41.10', class: 'vehicle', sched_c_line: '9', category: 'Vehicle fuel' }),
      row({ description: 'ACME SUPPLY 4471', amount: '12.50' }),
    ));
    const db = makeFakeDb();
    const first = parseLedgerCsv(fs.readFileSync(file, 'utf8'))[0];
    db.tables().plaid_accounts.push({ account_label: 'checking-main', mask: '3098' });
    db.tables().bank_transactions.push({ id: 'pl-1', row_hash: 'h2', source: 'plaid', account_label: 'checking-main', txn_date: first.date, description: 'Wawa', amount: '41.10', direction: 'debit', status: 'unmatched' });
    const { counts, report } = await run({ file, db, skipExisting: true });
    expect(counts).toEqual({ read: 2, inserted: 1, duplicates: 0, overlaps: 0, held: 1, unsure: 0, handExpenses: 0 });
    expect(report).toMatch(/held, not imported:\s+1 /);
    expect(report).toMatch(/\(portal: "Wawa" in checking-main\)/);
    expect(db.tables().expenses).toHaveLength(1);
    expect(db.tables().expenses[0].vendor_name).toBe('ACME SUPPLY 4471');
    const db2 = makeFakeDb();
    db2.tables().bank_transactions.push({ id: 'pl-2', row_hash: 'h3', source: 'csv', account_label: 'card-9731', txn_date: first.date, description: 'Wawa', amount: '41.10', direction: 'debit', status: 'unmatched' });
    const second = await run({ file, db: db2, skipExisting: true });
    expect(second.counts).toEqual({ read: 2, inserted: 2, duplicates: 0, overlaps: 0, held: 0, unsure: 0, handExpenses: 0 });
  });

  test('an exact match later in the file reserves its portal row before a looser match earlier in the file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
    const file = path.join(dir, 'ledger-2025.csv');
    fs.writeFileSync(file, csv(
      row({ description: 'DEBIT CARD PURCHASE - WAWA 5519 BRADENTON FL', amount: '41.10', class: 'vehicle', sched_c_line: '9', category: 'Vehicle fuel' }),
      row({ description: 'Wawa', amount: '41.10', class: 'vehicle', sched_c_line: '9', category: 'Vehicle fuel' }),
    ));
    const db = makeFakeDb();
    const first = parseLedgerCsv(fs.readFileSync(file, 'utf8'))[0];
    db.tables().bank_transactions.push({ id: 'pl-1', row_hash: 'h2', source: 'plaid', account_label: 'checking 3098', txn_date: first.date, description: 'Wawa', amount: '41.10', direction: 'debit', status: 'unmatched' });
    const { counts, report } = await run({ file, db, skipExisting: true });
    // the exact match (still open in the portal) is held; the looser earlier row loads
    expect(counts).toEqual({ read: 2, inserted: 1, duplicates: 0, overlaps: 0, held: 1, unsure: 0, handExpenses: 0 });
    expect(report).toMatch(/line 3 .*\[the same row is open in the portal, not booked; the ledger says vehicle \(Vehicle Expenses\)\]/);
    expect(db.tables().expenses[0].vendor_name).toBe('DEBIT CARD PURCHASE - WAWA 5519 BRADENTON FL');
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

  test('a held row is never also listed as "imported, check it", even with an exact match in another account', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
    const file = path.join(dir, 'ledger-2025.csv');
    fs.writeFileSync(file, csv(row({ description: 'DEBIT CARD PURCHASE - WAWA 5519 BRADENTON FL', amount: '41.10', class: 'vehicle', sched_c_line: '9', category: 'Vehicle fuel' })));
    const db = makeFakeDb();
    const first = parseLedgerCsv(fs.readFileSync(file, 'utf8'))[0];
    // another account has the exact text; the SAME account has the charge under other text → held, not "check"
    db.tables().bank_transactions.push({ id: 'o-1', row_hash: 'h1', source: 'csv', account_label: 'card-9731', txn_date: first.date, description: first.description, amount: '41.10', direction: 'debit', status: 'unmatched' });
    db.tables().bank_transactions.push({ id: 's-1', row_hash: 'h2', source: 'plaid', account_label: 'checking 3098', txn_date: first.date, description: 'Wawa', amount: '41.10', direction: 'debit', status: 'unmatched' });
    const { counts, report } = await run({ file, db, skipExisting: true });
    expect(counts).toEqual({ read: 1, inserted: 0, duplicates: 0, overlaps: 0, held: 1, unsure: 0, handExpenses: 0 });
    expect(report).toMatch(/check these:\s+0 /);
  });

  test('an amount with more than two decimals fails the file instead of being rounded', () => {
    const header = HEADER.join(',');
    expect(() => parseLedgerCsv(`${header}\n3098,2025-03-14,ACME,12.505,out,expense,Supplies,22,,,`)).toThrow(/amount must be a positive decimal/);
    expect(parseLedgerCsv(`${header}\n3098,2025-03-14,ACME,12.5,out,expense,Supplies,22,,,`)[0].amount).toBe(12.5);
    expect(parseLedgerCsv(`${header}\n3098,2025-03-14,ACME,"1,234.00",out,expense,Supplies,22,,,`)[0].amount).toBe(1234);
  });

  test('parseArgs reads --skip-existing', () => {
    expect(parseArgs(['--file', 'x.csv', '--skip-existing', '--dry-run'])).toEqual({ file: 'x.csv', dryRun: true, skipExisting: true });
  });
});

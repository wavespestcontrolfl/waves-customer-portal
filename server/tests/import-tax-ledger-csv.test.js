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

  test('rejects an empty file', () => {
    expect(() => parseLedgerCsv('')).toThrow(/empty/);
  });

  test.each([
    [{ date: '2025-02-31' }, /date/],
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
    const state = { filter: null, pending: null, ignoreConflict: false, wantReturn: false };
    const b = {
      whereIn(col, vals) { state.filter = { col, vals: new Set(vals) }; return b; },
      whereBetween(col, [lo, hi]) { state.range = { col, lo, hi }; return b; },
      whereNot(col, val) { state.not = { col, val }; return b; },
      whereNotNull(col) { state.notNull = col; return b; },
      where(obj) { state.eq = obj; return b; },
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
  db.transaction = async fn => {
    log.transactions += 1;
    const staged = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.slice()]));
    const trx = table => builderFor(staged, table);
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
    db.tables().bank_transactions.push({ id: 'pl-1', row_hash: 'h2', source: 'plaid', account_label: 'checking-main', txn_date: new Date(`${second.date}T00:00:00`), description: 'Corner Fuel 12', amount: '4.00', direction: 'debit', status: 'created_expense' });
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
    // the same open row, ignored or linked in the portal, is answered there: an overlap
    for (const status of ['ignored', 'matched_expense']) {
      const dbs = makeFakeDb();
      dbs.tables().bank_transactions.push({ id: 'up-1', row_hash: 'h1', source: 'csv', account_label: 'capone-card-3098', txn_date: first.date, description: first.description, amount: first.amount, direction: 'debit', status });
      const out = await run({ file, db: dbs, skipExisting: true });
      expect(out.counts).toMatchObject({ overlaps: 1, held: 0, inserted: 1 });
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
    db.tables().bank_transactions.push({ id: 'up-1', row_hash: 'h1', source: 'csv', account_label: 'card 3098', txn_date: first.date, description: 'Corner Fuel 12', amount: '4.00', direction: 'debit', status: 'created_expense' });
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
    db.tables().bank_transactions.push({ id: 'up-1', row_hash: 'h1', source: 'csv', account_label: 'card-3098', txn_date: first.date, description: first.description, amount: '12.50', direction: 'debit', status: 'created_expense' });
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

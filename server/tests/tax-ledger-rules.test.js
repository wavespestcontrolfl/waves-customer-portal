/**
 * Tax ledger rules (GATE_TAX_LEDGER): the pure pieces, the seed table, and
 * the suggestion-only pass + inbox decisions against a recording db stub.
 *
 * Locked-down behaviors:
 *  1. Rules run lowest priority first; a disabled or invalid-regex rule is
 *     skipped (and the invalid one logged), never thrown.
 *  2. A suggestion is the same jsonb the Bank Import tab reads: an expense
 *     rule pre-fills categoryId/categoryName/irsLine; personal and transfer
 *     set ignore+reason; income sets ignore+income; review sets review+note.
 *  3. Every seed pattern compiles, names a kind the service knows, and an
 *     expense/review category from the seeded expense_categories names.
 *  4. applyRules never changes status: it merges the suggestion on
 *     'unmatched' rows (clearing the previous classification first), stamps
 *     every examined row, pages with a keyset so no row starves, never
 *     touches a row the owner decided, leaves a matcher-flagged transfer
 *     alone, clears a stale rule classification on a full forced pass,
 *     writes nothing unrelated on a payee pass, and counts hits per rule.
 *  5. decide(): expense never writes (the client calls create-expense); a
 *     row with live link candidates or one the matcher never examined is
 *     refused; every decision UPDATE repeats the eligibility predicates and
 *     an Always rule commits in the same transaction, after the decision;
 *     later only flags the row; income moves it to the Income shelf, still
 *     open (nothing counts it as revenue); personal/transfer park the row
 *     as 'ignored' with the reason; a non-open or bank-changed row is a 409.
 *  6. applyAfterImport is a no-op when the gate is off and swallows errors.
 *  7. The seed rows are written at runtime, once per process, idempotent by
 *     pattern (never a migration), with the category id resolved by name.
 */
const state = { rules: [], bankRows: [], bankRow: null, updates: [], ruleUpdates: [], inserted: [], seeded: [], categories: [], category: null, casResult: 1 };

function builder(table) {
  const wheres = [];
  const b = {
    table,
    leftJoin: jest.fn(() => b), where: jest.fn((c) => { wheres.push(c); return b; }), whereRaw: jest.fn((sql) => { wheres.push(sql); return b; }),
    orderBy: jest.fn(() => b), limit: jest.fn(() => b), select: jest.fn(() => b),
    first: jest.fn(() => Promise.resolve(table === 'expense_categories' ? state.category : state.bankRow)),
    update: jest.fn((patch) => {
      (table === 'tax_ledger_rules' ? state.ruleUpdates : state.updates).push({ wheres: wheres.slice(), patch });
      // awaited directly it is the row count; .returning('*') gives the saved row (updateRule)
      const done = Promise.resolve(table === 'tax_ledger_rules' ? 1 : state.casResult);
      done.returning = () => Promise.resolve(state.bankRow ? [{ id: state.bankRow.id, ...state.bankRow, ...patch }] : []);
      return done;
    }),
    insert: jest.fn((row) => { (Array.isArray(row) ? state.seeded : state.inserted).push(row); return b; }),
    onConflict: jest.fn(() => b), merge: jest.fn(() => b), ignore: jest.fn(() => Promise.resolve()), whereNotIn: jest.fn(() => b),
    returning: jest.fn(() => Promise.resolve([{ id: 'rule-new', ...state.inserted[state.inserted.length - 1] }])),
  };
  const rows = table === 'tax_ledger_rules as r' ? state.rules : table === 'expense_categories' ? state.categories : state.bankRows;
  b.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return b;
}
const mockDb = jest.fn((table) => builder(table));
mockDb.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
mockDb.transaction = jest.fn(async (cb) => cb(mockDb));
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// suggestionMerge is a db.raw in production; here it echoes the patch so the
// tests can assert what the rule wrote.
jest.mock('../services/bank-import', () => ({
  suggestionMerge: jest.fn((patch, removeKeys = []) => ({ merged: patch, removed: removeKeys })),
  hasUnresolvedBankChange: jest.fn((row) => !!(row?.suggestion?.plaidModified || row?.suggestion?.plaidRemoved)),
  BANK_CHANGE_UNRESOLVED_SQL_NOT: '(suggestion->\'plaidModified\') is null',
}));

const logger = require('../services/logger');
const svc = require('../services/tax-ledger-rules');
const seeds = require('../services/tax-ledger-seed-rules');

const SEEDED_CATEGORY_NAMES = [
  'Advertising & Marketing', 'Vehicle Expenses', 'Commissions & Fees', 'Contract Labor', 'Insurance', 'Office Expenses',
  'Supplies', 'Taxes & Licenses', 'Utilities', 'Software & Technology', 'Training & Education', 'Home Office', 'Interest',
  'Rent & Lease', 'Repairs & Maintenance', 'Travel', 'Meals',
];

beforeEach(() => {
  Object.assign(state, { rules: [], bankRows: [], bankRow: null, updates: [], ruleUpdates: [], inserted: [], seeded: [], categories: [], category: null, casResult: 1 });
  mockDb.mockClear(); logger.warn.mockClear();
  delete process.env.GATE_BANK_IMPORT; delete process.env.GATE_TAX_LEDGER;
});

describe('compileRules / matchRule', () => {
  test('lowest priority first, then the newest rule; disabled and invalid rules are skipped', () => {
    const compiled = svc.compileRules([
      { id: 'seed', pattern: 'costco', priority: 100, created_at: '2026-01-01' },
      { id: 'owner', pattern: 'costco gas', priority: 10, created_at: '2026-02-01' },
      { id: 'off', pattern: 'costco', priority: 1, enabled: false },
      { id: 'bad', pattern: '(', priority: 1 },
      { id: 'older', pattern: 'wawa', priority: 10, created_at: '2026-01-15' },
    ]);
    expect(compiled.map((r) => r.id)).toEqual(['owner', 'older', 'seed']);
    // created_at arrives as a Date from Postgres: compare in time, not as text
    const dated = svc.compileRules([
      { id: 'first', pattern: 'b', priority: 10, created_at: new Date('2026-09-05T10:00:00Z') },
      { id: 'later', pattern: 'a', priority: 10, created_at: new Date('2026-10-23T10:00:00Z') },
    ]);
    expect(dated.map((r) => r.id)).toEqual(['later', 'first']);
    // an Always decision is an owner rule at the same priority as every other: the latest
    // reading of an overlapping payee wins, the older rule keeps the rows only it matches
    const owners = svc.compileRules([
      { id: 'acme-personal', pattern: 'acme', kind: 'personal', priority: 10, source: 'owner', created_at: new Date('2026-09-01T10:00:00Z') },
      { id: 'acme-hardware', pattern: '\\bacme\\W*hardware\\b', kind: 'expense', category_id: 'cat-s', priority: 10, source: 'owner', created_at: new Date('2026-10-01T10:00:00Z') },
    ]);
    expect(svc.matchRule('ACME HARDWARE 1234', owners, 'debit').id).toBe('acme-hardware');
    expect(svc.matchRule('ACME 1234', owners, 'debit').id).toBe('acme-personal');
    // repeating Always on the older pattern upserts it (updated_at moves, created_at stays): that
    // decision is the latest reading again and wins the overlap back
    const redecided = svc.compileRules([
      { id: 'acme-personal', pattern: 'acme', kind: 'personal', priority: 10, source: 'owner', created_at: new Date('2026-09-01T10:00:00Z'), updated_at: new Date('2026-10-05T10:00:00Z') },
      { id: 'acme-hardware', pattern: '\\bacme\\W*hardware\\b', kind: 'expense', category_id: 'cat-s', priority: 10, source: 'owner', created_at: new Date('2026-10-01T10:00:00Z'), updated_at: new Date('2026-10-01T10:00:00Z') },
    ]);
    expect(svc.matchRule('ACME HARDWARE 1234', redecided, 'debit').id).toBe('acme-personal');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('rule bad skipped'));
    expect(svc.matchRule('DEBIT CARD PURCHASE - COSTCO GAS #123', compiled).id).toBe('owner');
    expect(svc.matchRule('COSTCO WHOLESALE', compiled).id).toBe('seed');
    expect(svc.matchRule('SITEONE LANDSCAPE', compiled)).toBeNull();
  });

  test('compilePattern rejects empty, too long and invalid patterns with a 400', () => {
    expect(() => svc.compilePattern('')).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => svc.compilePattern('a'.repeat(241))).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => svc.compilePattern('(')).toThrow(expect.objectContaining({ status: 400 }));
    expect(svc.compilePattern('costco\\W*gas').test('COSTCO GAS')).toBe(true);
  });

  test('compilePattern admits only the safe grammar: the catastrophic shapes are refused, every seed and every Inbox pattern passes', () => {
    for (const bad of ['(a+)+$', '(a*)*b', '(x|xy)+z', '((ab)+)+', '(\\w+\\s?)+$', '(a?a?)+$', '(a|a)*', '(a)\\1', '(?=a)b', '(?<!a)b', '(?:ab)+', 'a{2,4}b', 'ab+', '[a-z]+', 'ab*c', '^wawa$', '(ab', 'ab)',
      // too many variable-length parts in one alternative
      'a?'.repeat(35) + 'b', 'a?b?c?d?', '.*a.*b.*c', '\\W*\\s*\\d*x', '(a)?(b)?(c)?(d)?', '(a|aa)'.repeat(30) + 'b', '(a|aa)(b|bb)(c|cc)',
      // an alternative with nothing that must match would match every description
      'wawa|', '|wawa', 'wawa||shell', '(wawa|)', '(|wawa) gas', '.*', 'x?', '\\b', '(wawa)?', '\\W*', '()',
      // two wildcards with nothing that must match between them: cubic on a long description
      '.*.*x', '.*\\W*x', '\\W*\\s*x', '(.*a)?.*b', '(a.*).*b', 'a.*(b.*)?.*c', 'nic\\W*-?\\s*fl']) {
      expect([bad, () => svc.compilePattern(bad)]).toEqual([bad, expect.any(Function)]);
      expect(() => svc.compilePattern(bad)).toThrow(expect.objectContaining({ status: 400 }));
    }
    for (const ok of ['costco\\W*gas', '\\bwawa\\b', 'google\\W*ads|facebk|meta ads', 'o.?reilly auto', 'wu\\b.*\\bco\\b', '(ab|cd)e', '(mobile )?ach', 'usps po\\b', 'check deposit \\(mobile\\) reversal', 'cash app \\*', 'x corp\\.? paid', 'nic\\W*fl', 'colou?r', "o'reilly", 'at&t', 'apple\\.com/bill', '[a-z]ar', 'take 5', '.*a.*b', '(.*a)b.*',
      // the caps are per alternative
      'a?b?c?x|d?e?f?y', '.*a.*|.*b.*', '\\bsiteone\\W*landscape\\W*supply\\b', '(a|aa)(b|bb)c', '(a|aa)b|(c|cc)d|(e|ee)f']) {
      expect([ok, svc.compilePattern(ok)]).toEqual([ok, expect.any(RegExp)]);
    }
    for (const r of seeds.SEED_RULES) expect([r.pattern, svc.compilePattern(r.pattern, { maxLength: Infinity })]).toEqual([r.pattern, expect.any(RegExp)]);
    // a seed may be a long alternation of literals; the owner's typed pattern keeps the cap
    expect(svc.compileRules(seeds.SEED_RULES.map((r, i) => ({ ...r, id: `s${i}` })))).toHaveLength(seeds.SEED_RULES.length);
    for (const d of ['DEBIT CARD PURCHASE - SITEONE LANDSCAPE SUPPLY 1234', "O'REILLY AUTO PARTS 0042", 'AMAZON.COM*AB12CD']) {
      expect(svc.compilePattern(svc.patternFromDescription(d))).toEqual(expect.any(RegExp));
    }
    // bounded in practice: every seed plus the widest allowed shapes against an adversarial description
    const adversarial = `${'a'.repeat(140)} ${'wawa '.repeat(20)}${'x'.repeat(100)}`;
    const widest = svc.compileRules([
      ...seeds.SEED_RULES.map((r, i) => ({ ...r, id: `s${i}` })),
      { id: 'w1', pattern: 'a?a?a?.*b.*c', priority: 1 }, { id: 'w2', pattern: '\\W*\\s*(a)?(b)?c?', priority: 1 }, { id: 'w3', pattern: '.*a.*a', priority: 1 }, { id: 'w4', pattern: '(a|aa)(a|aa)a?a?a?.*b', priority: 1 },
    ]);
    const t0 = Date.now();
    for (let k = 0; k < 20; k += 1) svc.matchRule(adversarial, widest);
    expect(Date.now() - t0).toBeLessThan(500);
    // stored rules take the same check: an unsafe one is skipped, not run
    const compiled = svc.compileRules([{ id: 'evil', pattern: '(a+)+$', priority: 1 }, { id: 'ok', pattern: 'wawa', priority: 2 }]);
    expect(compiled.map((r) => r.id)).toEqual(['ok']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('rule evil skipped'));
  });

  test('matchRule skips an income rule for money out and takes the next rule that fits', () => {
    const compiled = svc.compileRules([
      { id: 'inc', pattern: 'acme', kind: 'income', priority: 10 },
      { id: 'exp', pattern: 'acme', kind: 'expense', priority: 100 },
    ]);
    expect(svc.matchRule('ACME SUPPLY', compiled, 'credit').id).toBe('inc');
    expect(svc.matchRule('ACME SUPPLY', compiled, 'debit').id).toBe('exp');
    expect(svc.matchRule('ACME SUPPLY', compiled).id).toBe('inc');
    // an expense rule never labels money in (a merchant refund is a review item, not an expense)
    const onlyExpense = svc.compileRules([{ id: 'exp', pattern: 'home depot', kind: 'expense', priority: 100 }]);
    expect(svc.matchRule('HOME DEPOT REFUND', onlyExpense, 'credit')).toBeNull();
    expect(svc.matchRule('HOME DEPOT 123', onlyExpense, 'debit').id).toBe('exp');
  });
});

describe('suggestionFor', () => {
  const base = { id: 'r1', pattern: 'x', source: 'seed' };
  test('expense pre-fills the category the Bank Import tab reads', () => {
    expect(svc.suggestionFor({ ...base, kind: 'expense', category_id: 'cat-1', category_name: 'Supplies', irs_line: '22' }))
      .toEqual(expect.objectContaining({ categoryId: 'cat-1', categoryName: 'Supplies', irsLine: '22', categorySource: 'rule', rule: expect.objectContaining({ id: 'r1', kind: 'expense' }) }));
  });
  test('transfer sets the tab\'s ignore flag with a reason; personal and income never touch ignore', () => {
    expect(svc.suggestionFor({ ...base, kind: 'transfer', note: 'card payment' })).toEqual(expect.objectContaining({ ignore: true, reason: 'transfer per ledger rule: card payment' }));
    const personal = svc.suggestionFor({ ...base, kind: 'personal' });
    expect(personal).toEqual(expect.objectContaining({ personal: true, reason: 'personal per ledger rule' }));
    expect(personal.ignore).toBeUndefined();
    const income = svc.suggestionFor({ ...base, kind: 'income' });
    expect(income).toEqual(expect.objectContaining({ income: true, reason: svc.INCOME_REASON }));
    expect(income.ignore).toBeUndefined();
  });
  test('review flags the row and may pre-fill a category', () => {
    expect(svc.suggestionFor({ ...base, kind: 'review', note: 'helper or personal?', category_id: 'cat-2', category_name: 'Contract Labor', irs_line: '11' }))
      .toEqual(expect.objectContaining({ review: true, note: 'helper or personal?', categoryId: 'cat-2', irsLine: '11', categorySource: 'rule' }));
    expect(svc.suggestionFor({ ...base, kind: 'review' }).ignore).toBeUndefined();
    expect(svc.suggestionFor({ ...base, kind: 'review' }).categorySource).toBeUndefined();
  });
});

describe('patternFromDescription', () => {
  const cases = [
    ['DEBIT CARD PURCHASE - SITEONE LANDSCAPE SUPPLY 1234 BRADENTON FL', '\\bsiteone\\W*landscape\\W*supply\\b'],
    ['Zelle money sent to ACME HELPER CO', '\\bacme\\W*helper\\b'],
    ['POS PURCHASE - WAWA 5519', '\\bwawa\\b'],
    // a number ends the payee name: the city after it is not part of the rule
    ['WAWA 5519 BRADENTON FL', '\\bwawa\\b'],
    // a noise word ends it too
    ['THE UPS STORE 1234 BRADENTON FL', '\\bups\\b'],
    ['AMAZON.COM*AB12CD', '\\bamazon\\.com\\b'],
    ["O'REILLY AUTO PARTS 0042", "\\bo'reilly\\W*auto\\W*parts\\b"],
    // bank framing never anchors a rule
    ['CHECKCARD 1234 WAWA', '\\bwawa\\b'],
    ['ACH DEBIT 1234 ACME', '\\bacme\\b'],
    ['ACH DEBIT 1234', null],
    ['1234567 ##', null],
    ['DBT CRD 1234 WAWA', '\\bwawa\\b'],
    ['DBT CRD 1234', null],
    ['CHKCARD PURCH AUTH 0617 SHELL OIL', '\\bshell\\W*oil\\b'],
    // a digit glued to the payee sits inside the word boundary: the rule tolerates a digit run there
    ['GOOGLE *ADS1234567', '\\bgoogle\\W*ads\\d*\\b'],
    ['1PASSWORD', '\\b\\d*password\\b'],
    ['ACME2 HARDWARE', '\\bacme\\d*\\b'],
    // a third wildcard would break the grammar's cap: two words instead of a rule that is refused later
    ['ALPHA BETA GAMMA9 CITY', '\\balpha\\W*beta\\b'],
  ];
  test.each(cases)('%s → %s', (description, expected) => {
    expect(svc.patternFromDescription(description)).toBe(expected);
  });
  test('the pattern it returns matches the description it came from, and not a longer word', () => {
    for (const [d, pat] of cases) {
      if (!pat) continue;
      expect([d, new RegExp(pat, 'i').test(d)]).toEqual([d, true]);
    }
    expect(new RegExp(svc.patternFromDescription('THE UPS STORE 1234'), 'i').test('GROUPS ONLINE')).toBe(false);
  });
});

describe('seed rules', () => {
  test('every seed compiles, names a known kind and a seeded category, and patterns are unique', () => {
    const seen = new Set();
    for (const r of seeds.SEED_RULES) {
      expect(() => new RegExp(r.pattern, 'i')).not.toThrow();
      expect(svc.KINDS).toContain(r.kind);
      if (r.kind === 'expense') expect(SEEDED_CATEGORY_NAMES).toContain(r.category);
      if (r.category) expect(SEEDED_CATEGORY_NAMES).toContain(r.category);
      expect([80, 90, 95, 100]).toContain(r.priority);
      expect(seen.has(r.pattern)).toBe(false);
      seen.add(r.pattern);
    }
    expect(seeds.SEED_CATEGORY_NAMES.every((n) => SEEDED_CATEGORY_NAMES.includes(n))).toBe(true);
    expect(Object.keys(seeds.CATEGORY_LINES).every((n) => SEEDED_CATEGORY_NAMES.includes(n))).toBe(true);
  });

  test.each([
    ['DEPOSIT FROM STRIPE', 'review', null],
    ['CAPITAL ONE AUTOPAY PYMT', 'transfer', null],
    ['DEBIT CARD PURCHASE - COSTCO GAS #0123', 'expense', 'Vehicle Expenses'],
    ['GOOGLE *ADS1234567', 'expense', 'Advertising & Marketing'],
    ['FIVERR', 'expense', 'Contract Labor'],
    ['Zelle money received from SOMEONE', 'review', null],
    ['AMAZON.COM*1A2B3C', 'review', 'Supplies'],
    ['CAPITAL ONE MEMBER FEE', 'personal', null],
    // overlaps: the specific rule wins over the broad personal list or the broad merchant rule
    ['TARGET SPECIALTY PRODUCTS 0042', 'expense', 'Supplies'],
    ['TARGET 00012345 BRADENTON', 'personal', null],
    ['WALMART.COM 8009256278', 'review', 'Office Expenses'],
    ['WAL-MART #1234', 'personal', null],
    ['USPS PO 1130440123', 'review', 'Advertising & Marketing'],
    ['USPS STAMPS 123', 'expense', 'Office Expenses'],
    ['TEMU.COM', 'review', 'Supplies'],
    // card interest: line 16b has no category, so it is a review item with no pre-filled category
    ['INTEREST CHARGE ON PURCHASES', 'review', null],
  ])('%s → %s / %s', (description, kind, category) => {
    const compiled = svc.compileRules(seeds.SEED_RULES.map((r, i) => ({ ...r, id: `s${i}`, created_at: '2026-01-01' })));
    const hit = svc.matchRule(description, compiled);
    expect(hit).not.toBeNull();
    expect(hit.kind).toBe(kind);
    expect(hit.category || null).toBe(category);
  });
});

describe('assertPatternFast (worker probe)', () => {
  test('every seed and a plain owner pattern finish within the budget; an overrun is a 400 and the worker is stopped', async () => {
    await expect(svc.assertPatternFast('wawa')).resolves.toBe(true);
    for (const r of seeds.SEED_RULES) await expect(svc.assertPatternFast(r.pattern)).resolves.toBe(true);
    await expect(svc.assertPatternFast('wawa', { budgetMs: 0 })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/too slow/) });
    // the adversarial strings cover every character class the grammar admits, at full length
    const strings = svc.probeStrings('costco\\W*gas');
    expect(strings.length).toBeGreaterThan(20);
    for (const s of strings) expect(s).toHaveLength(300);
    expect(strings.some((s) => s.endsWith('costco'))).toBe(true);
  });
});

describe('the matcher knows every key a rule owns', () => {
  test('bank-import drops, with the ledger off, every classification key a rule can write', () => {
    // read as text: the matcher module pulls the real db at load time
    const src = require('fs').readFileSync(require.resolve('../services/bank-import'), 'utf8');
    const list = (name) => JSON.parse(src.match(new RegExp(`const ${name} = (\\[[^\\]]*\\])`))[1].replace(/'/g, '"'));
    const dropped = new Set([...list('LEDGER_RULE_KEYS'), ...list('LEDGER_RULE_CATEGORY_KEYS')]);
    const ruleWritten = svc.CLASSIFICATION_KEYS.filter((k) => !['ignore', 'reason', 'decision', 'decidedAt'].includes(k));
    for (const k of ruleWritten) expect([k, dropped.has(k)]).toEqual([k, true]);
    expect(dropped.has('examined')).toBe(true);
  });
});

describe('ensureSeedRules (runtime seed)', () => {
  test('writes every seed once per process with onConflict(pattern).ignore and the category id by name', async () => {
    state.categories = [{ id: 'cat-v', name: 'Vehicle Expenses' }, { id: 'cat-s', name: 'Supplies' }];
    expect(await svc.ensureSeedRules()).toBe(seeds.SEED_RULES.length);
    expect(state.seeded).toHaveLength(1);
    const rows = state.seeded[0];
    expect(rows).toHaveLength(seeds.SEED_RULES.length);
    const gas = rows.find((r) => /costco gas/.test(r.pattern));
    expect(gas).toEqual(expect.objectContaining({ kind: 'expense', category_id: 'cat-v', irs_line: '9', enabled: true, source: 'seed', priority: 90 }));
    const unknownCat = rows.find((r) => /google\\W\*ads/.test(r.pattern));
    expect(unknownCat.category_id).toBeNull();
    expect(unknownCat.irs_line).toBe('8');
    const seedBuilders = mockDb.mock.results.map((r) => r.value).filter((b) => b.table === 'tax_ledger_rules');
    const seedBuilder = seedBuilders[0];
    expect(seedBuilder.onConflict).toHaveBeenCalledWith('pattern');
    // a pristine seed row follows the code; an owner-edited row (updated_at moved) keeps the owner's values
    expect(seedBuilder.merge).toHaveBeenCalledWith(['kind', 'category_id', 'irs_line', 'note', 'priority', 'enabled']);
    expect(seedBuilder.whereRaw).toHaveBeenCalledWith(expect.stringContaining('updated_at = tax_ledger_rules.created_at'));
    expect(seedBuilder.ignore).not.toHaveBeenCalled();
    // a seed the code no longer lists is disabled, never deleted
    const retire = seedBuilders[1];
    expect(retire.whereNotIn).toHaveBeenCalledWith('pattern', rows.map((r) => r.pattern));
    expect(retire.update).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    // retiring is the code's doing: the row stays pristine (no updated_at move), so a seed the code
    // lists again later is re-enabled by the merge instead of staying off as an owner edit
    expect(retire.update).toHaveBeenCalledWith(expect.not.objectContaining({ updated_at: expect.anything() }));
    // second call: memoized, no second write
    mockDb.mockClear();
    expect(await svc.ensureSeedRules()).toBe(seeds.SEED_RULES.length);
    expect(mockDb).not.toHaveBeenCalled();
  });
});

describe('applyRules (suggestion-only)', () => {
  const selects = () => mockDb.mock.results.map((r) => r.value).filter((b) => b.table === 'bank_transactions' && b.select.mock.calls.length);
  beforeEach(() => {
    state.rules = [
      { id: 'r-gas', pattern: 'costco gas', kind: 'expense', category_id: 'cat-v', category_name: 'Vehicle Expenses', irs_line: '9', priority: 100, enabled: true },
      { id: 'r-acme', pattern: 'acme', kind: 'income', priority: 10, enabled: true, source: 'owner' },
    ];
    // every row the matcher examined carries its marker (noMatch here)
    state.bankRows = [
      { id: 'b1', txn_date: '2026-01-02', description: 'COSTCO GAS #1', suggestion: { noMatch: true, categoryId: 'cat-old', categorySource: 'ai' } },
      { id: 'b2', txn_date: '2026-01-03', description: 'ZELLE MONEY RECEIVED FROM ACME', direction: 'credit', suggestion: { noMatch: true } },
      // money OUT to the same payee: the income rule does not fit, no other rule does either
      { id: 'b8', txn_date: '2026-01-03', description: 'ZELLE MONEY SENT TO ACME', direction: 'debit', suggestion: { noMatch: true } },
      { id: 'b3', txn_date: '2026-01-04', description: 'COSTCO GAS #2', suggestion: { noMatch: true } },
      { id: 'b4', txn_date: '2026-01-05', description: 'UNKNOWN PAYEE', suggestion: { noMatch: true } },
      { id: 'b5', txn_date: '2026-01-06', description: 'COSTCO GAS #3', suggestion: { ignore: true, reason: 'internal transfer?' } },
      // decided by the owner (Income shelf): the SQL excludes it; the loop guards too
      { id: 'b6', txn_date: '2026-01-07', description: 'COSTCO GAS #4', suggestion: { noMatch: true, income: true, decision: 'income', decidedAt: '2026-01-08T00:00:00Z' } },
      // not examined by the matcher yet: the SQL excludes it; the loop guards too
      { id: 'b0', txn_date: '2026-01-08', description: 'COSTCO GAS #5', suggestion: null },
      // on the Later shelf (a decision): an income rule must not pull it onto the Income shelf too
      { id: 'bL', txn_date: '2026-01-09', description: 'ZELLE MONEY RECEIVED FROM ACME', direction: 'credit', suggestion: { noMatch: true, later: true, decision: 'later' } },
    ];
  });

  test('counts and rule hits book only the classifications whose guarded UPDATE landed', async () => {
    state.casResult = 0; // every row changed after the page was read (a decision, a matcher flag, a link)
    const out = await svc.applyRules({ limit: 500 });
    expect(out).toEqual({ examined: 9, suggested: 0, cleared: 0, byKind: {}, more: false, cursor: null });
    expect(state.updates).toHaveLength(6); // the guarded writes were attempted
    expect(state.ruleUpdates).toHaveLength(0); // no hit for a classification that is not stored
  });

  test('merges a suggestion on each matching open row after clearing the old classification, stamps every examined row, never touches status, skips a matcher-flagged transfer, counts hits', async () => {
    const out = await svc.applyRules({ limit: 500 });
    expect(out).toEqual({ examined: 9, suggested: 3, cleared: 0, byKind: { expense: 2, income: 1 }, more: false, cursor: null });
    expect(selects()[0].whereRaw).toHaveBeenCalledWith("(suggestion -> 'decision') is null");
    expect(selects()[0].whereRaw).toHaveBeenCalledWith(svc.MATCHER_EXAMINED_SQL);
    expect(state.updates).toHaveLength(6);
    expect(state.updates.map((u) => u.wheres[0].id)).toEqual(expect.not.arrayContaining(['b6', 'b0', 'bL']));
    // the rule set is read AFTER the page's rows (an Always propagation that finished before the
    // read is in both; one that finishes after it fails the versioned UPDATE)
    const tables = mockDb.mock.calls.map((c) => c[0]);
    const pageRead = tables.indexOf('bank_transactions');
    const rulesAfterRead = tables.indexOf('tax_ledger_rules as r', pageRead);
    expect(rulesAfterRead).toBeGreaterThan(pageRead);
    expect(rulesAfterRead).toBeLessThan(tables.indexOf('bank_transactions', pageRead + 1));
    const stamps = new Set();
    for (const u of state.updates) {
      expect(u.patch.status).toBeUndefined();
      expect(u.wheres).toContainEqual(expect.objectContaining({ status: 'unmatched' }));
      expect(u.wheres).toContain("(suggestion -> 'decision') is null");
      expect(u.wheres).toContain(svc.MATCHER_EXAMINED_SQL);
      // a seed write is conditional on the matcher not having flagged the row since it was read
      if (u.wheres[0].id !== 'b5') expect(u.wheres).toContain(svc.NO_MATCHER_FLAG_SQL);
      // and on the row's classification version (rulesAt) still being the one this pass read: a
      // newer pass, even one that re-pointed the same rule id, wins
      expect(u.wheres).toContain(svc.RULE_SNAPSHOT_SQL);
      stamps.add(u.patch.suggestion.merged.rulesAt);
    }
    expect(stamps.size).toBe(1);
    const byId = Object.fromEntries(state.updates.map((u) => [u.wheres[0].id, u.patch.suggestion]));
    expect(byId.b1.merged).toEqual(expect.objectContaining({ categoryId: 'cat-v', irsLine: '9', categorySource: 'rule' }));
    expect(byId.b1.removed).toEqual(svc.CLASSIFICATION_KEYS);
    expect(byId.b2.merged).toEqual(expect.objectContaining({ income: true }));
    expect(byId.b2.merged.ignore).toBeUndefined();
    expect(byId.b4.merged).toEqual({ rulesAt: expect.any(String) });
    expect(byId.b4.removed).toEqual([]);
    expect(byId.b8.merged).toEqual({ rulesAt: expect.any(String) });
    expect(byId.b5.merged).toEqual({ rulesAt: expect.any(String) });
    const hits = Object.fromEntries(state.ruleUpdates.map((u) => [u.wheres[0].id, u.patch.hits.bindings[0]]));
    expect(hits).toEqual({ 'r-gas': 2, 'r-acme': 1 });
    // recording a hit is not an edit: a seed row stays pristine for the reconcile
    for (const u of state.ruleUpdates) expect(u.patch.updated_at).toBeUndefined();
  });

  test('the matcher transfer flag holds against a seed but an owner rule writes over it', async () => {
    state.rules = [{ id: 'r-owner', pattern: 'costco gas #3', kind: 'expense', category_id: 'cat-v', category_name: 'Vehicle Expenses', irs_line: '9', priority: 10, enabled: true, source: 'owner' }];
    state.bankRows = [{ id: 'b5', txn_date: '2026-01-06', description: 'COSTCO GAS #3', direction: 'debit', suggestion: { ignore: true, reason: 'internal transfer?' } }];
    const out = await svc.applyRules({ force: true });
    expect(out.suggested).toBe(1);
    expect(state.updates[0].patch.suggestion.merged).toEqual(expect.objectContaining({ categoryId: 'cat-v', categorySource: 'rule', examined: true }));
    // the owner's rule replaces the heuristic's flag (the tab reads ignore first); the evidence is recorded explicitly
    expect(state.updates[0].patch.suggestion.removed).toContain('ignore');
    expect(state.updates[0].patch.suggestion.removed).toContain('reason');
    // a row the matcher had flagged is written without the no-flag guard; others carry it
    expect(state.updates[0].wheres).not.toContain(svc.NO_MATCHER_FLAG_SQL);
    expect(svc.matcherExamined({ suggestion: { examined: true, categoryId: 'cat-v', rule: { id: 'r-owner', kind: 'expense' } } })).toBe(true);
    // the same rule as a seed does not
    state.rules[0].source = 'seed'; state.updates = [];
    expect((await svc.applyRules({ force: true })).suggested).toBe(0);
    expect(state.updates[0].patch.suggestion.merged).toEqual({ rulesAt: expect.any(String) });
  });

  test('without force only unstamped rows are read; a payee pass (force + pattern) writes that rule only and stamps nothing else', async () => {
    await svc.applyRules({});
    expect(selects()[0].whereRaw).toHaveBeenCalledWith(expect.stringContaining("(suggestion -> 'rulesAt') is null"));
    state.updates = []; state.ruleUpdates = []; mockDb.mockClear();
    const out = await svc.applyRules({ force: true, pattern: 'acme' });
    expect(selects()[0].whereRaw).not.toHaveBeenCalledWith(expect.stringContaining("(suggestion -> 'rulesAt') is null"));
    expect(out).toEqual({ examined: 9, suggested: 1, cleared: 0, byKind: { income: 1 }, more: false, cursor: null });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].wheres[0]).toEqual({ id: 'b2', status: 'unmatched' });
    expect(state.updates[0].patch.suggestion.removed).toEqual(svc.CLASSIFICATION_KEYS);
  });

  test('an owner override whose rule is gone is cleared back to the matcher when only a seed is left; owner to owner keeps the marker', async () => {
    // the owner rule that overrode the matcher's transfer flag is gone; the Costco seed still matches:
    // the seed does NOT take the row (a matcher flag holds against seeds); the row is cleared so the
    // matcher's next rescan flags it again, and it stays visible to the Inbox through that flag
    state.rules = state.rules.filter((r) => r.id === 'r-gas');
    state.bankRows = [
      { id: 'b1', txn_date: '2026-01-02', description: 'AUTOPAY COSTCO GAS #1', direction: 'debit', suggestion: { examined: true, rule: { id: 'r-old-owner', kind: 'personal', source: 'owner' }, personal: true, rulesAt: 'old' } },
    ];
    let out = await svc.applyRules({ force: true });
    expect(out).toEqual(expect.objectContaining({ examined: 1, suggested: 0, cleared: 1 }));
    expect(state.updates[0].patch.suggestion.merged).toEqual({ rulesAt: expect.any(String) });
    expect(state.updates[0].patch.suggestion.removed).toEqual([...svc.CLASSIFICATION_KEYS, 'examined']);
    // a newer owner rule taking over keeps the marker: an owner rule still holds the row
    state.rules = [{ id: 'r-new-owner', pattern: 'costco gas', kind: 'expense', category_id: 'cat-v', category_name: 'Vehicle Expenses', irs_line: '9', priority: 10, enabled: true, source: 'owner' }];
    state.updates = [];
    out = await svc.applyRules({ force: true });
    expect(out).toEqual(expect.objectContaining({ suggested: 1 }));
    expect(state.updates[0].patch.suggestion.removed).toEqual(svc.CLASSIFICATION_KEYS);
  });

  test('a full forced pass clears a classification an earlier rule wrote when no rule matches any more', async () => {
    state.rules = state.rules.filter((r) => r.id !== 'r-gas');
    state.bankRows = [
      // an owner override of the matcher's transfer flag (examined, no ignore) whose rule is gone
      { id: 'b1', txn_date: '2026-01-02', description: 'COSTCO GAS #1', suggestion: { examined: true, rule: { id: 'r-gas', kind: 'expense', source: 'owner' }, categoryId: 'cat-v', rulesAt: 'old' } },
      { id: 'b7', txn_date: '2026-01-03', description: 'HOME DEPOT', suggestion: { noMatch: true, categoryId: 'cat-ai', categorySource: 'ai' } },
    ];
    const out = await svc.applyRules({ force: true });
    expect(out).toEqual({ examined: 2, suggested: 0, cleared: 1, byKind: {}, more: false, cursor: null });
    const byId = Object.fromEntries(state.updates.map((u) => [u.wheres[0].id, u.patch.suggestion]));
    // the override marker goes with the stale classification: the row returns to the matcher's reading
    expect(byId.b1).toEqual({ merged: { rulesAt: expect.any(String) }, removed: [...svc.CLASSIFICATION_KEYS, 'examined'] });
    // an AI suggestion no rule owns is left alone
    expect(byId.b7).toEqual({ merged: { rulesAt: expect.any(String) }, removed: [] });
    // the non-forced pass never clears: it only sees unstamped rows
    state.updates = [];
    await svc.applyRules({});
    expect(state.updates.every((u) => u.patch.suggestion.removed.length === 0)).toBe(true);
  });

  test('pages by (txn_date, id) keyset until the row budget is spent', async () => {
    state.bankRows = Array.from({ length: 500 }, (_, i) => ({ id: `b${i}`, txn_date: '2026-01-01', description: 'UNKNOWN', suggestion: { noMatch: true } }));
    const out = await svc.applyRules({ limit: 1000 });
    expect(out.examined).toBe(1000);
    const pages = selects();
    expect(pages).toHaveLength(2);
    expect(pages[0].whereRaw).not.toHaveBeenCalledWith(expect.stringContaining('(txn_date, id) >'), expect.anything());
    expect(pages[1].whereRaw).toHaveBeenCalledWith(expect.stringContaining('(txn_date, id) > (?::date, ?::uuid)'), ['2026-01-01', 'b499']);
    expect(pages[0].limit).toHaveBeenCalledWith(500);
    // budget spent on a full page: the caller gets a cursor to continue from
    expect(out.more).toBe(true);
    expect(out.cursor).toEqual({ txn_date: '2026-01-01', id: 'b499' });
    mockDb.mockClear();
    const next = await svc.applyRules({ limit: 1000, after: out.cursor });
    expect(selects()[0].whereRaw).toHaveBeenCalledWith(expect.stringContaining('(txn_date, id) > (?::date, ?::uuid)'), ['2026-01-01', 'b499']);
    expect(next.more).toBe(true);
    // a short last page ends the pass: no cursor
    state.bankRows = state.bankRows.slice(0, 10);
    const last = await svc.applyRules({ limit: 1000 });
    expect(last).toEqual(expect.objectContaining({ examined: 10, more: false, cursor: null }));
  });

  test('applyRulesForPattern follows its cursor to the end of the open rows, bounded by rounds', async () => {
    state.rules = [{ id: 'r-u', pattern: 'unknown', kind: 'personal', priority: 10, enabled: true }];
    state.bankRows = Array.from({ length: 500 }, (_, i) => ({ id: `b${i}`, txn_date: '2026-01-01', description: 'UNKNOWN', suggestion: { noMatch: true } }));
    // the mock always returns a full page: three rounds of 1000 rows, then it stops short
    const out = await svc.applyRulesForPattern('unknown', { budget: 1000, maxRounds: 3 });
    expect(out).toEqual({ examined: 3000, suggested: 3000, complete: false });
    expect(selects()).toHaveLength(6);
    expect(selects()[2].whereRaw).toHaveBeenCalledWith(expect.stringContaining('(txn_date, id) > (?::date, ?::uuid)'), ['2026-01-01', 'b499']);
    state.bankRows = state.bankRows.slice(0, 10); mockDb.mockClear();
    expect(await svc.applyRulesForPattern('unknown', { budget: 1000, maxRounds: 3 })).toEqual({ examined: 10, suggested: 10, complete: true });
    expect(selects()).toHaveLength(1);
  });

  test('no enabled rules: a plain pass reads nothing; a full forced pass still clears what old rules wrote', async () => {
    state.rules = [];
    expect(await svc.applyRules({})).toEqual({ examined: 0, suggested: 0, cleared: 0, byKind: {}, more: false, cursor: null });
    expect(state.updates).toHaveLength(0);
    expect(selects()).toHaveLength(0);
    state.bankRows = [{ id: 'b1', txn_date: '2026-01-02', description: 'COSTCO GAS #1', suggestion: { noMatch: true, rule: { id: 'r-gas' }, categoryId: 'cat-v', rulesAt: 'old' } }];
    const out = await svc.applyRules({ force: true });
    expect(out).toEqual(expect.objectContaining({ examined: 1, cleared: 1 }));
    expect(state.updates[0].patch.suggestion).toEqual({ merged: { rulesAt: expect.any(String) }, removed: [...svc.CLASSIFICATION_KEYS, 'examined'] });
  });
});

describe('applyAfterImport', () => {
  test('is a no-op when the ledger gate is off, even with bank import on', async () => {
    process.env.GATE_BANK_IMPORT = 'true';
    expect(await svc.applyAfterImport('upload')).toBeNull();
    expect(mockDb).not.toHaveBeenCalled();
  });
  test('runs the pass when both gates are on and swallows a failure with a warning', async () => {
    process.env.GATE_BANK_IMPORT = 'true'; process.env.GATE_TAX_LEDGER = 'true';
    state.rules = [{ id: 'r', pattern: 'x', kind: 'personal', priority: 100, enabled: true }];
    // the pass follows its cursor through the matching budget and reports the totals
    expect(await svc.applyAfterImport('upload')).toEqual({ examined: 0, suggested: 0, cleared: 0 });
    mockDb.mockImplementationOnce(() => { throw new Error('db down'); });
    expect(await svc.applyAfterImport('plaid item 1')).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('rule pass after plaid item 1 failed: db down'));
  });
});

describe('decide', () => {
  // a row the matcher examined and found nothing for (its noMatch marker)
  const open = () => ({ id: 'b1', status: 'unmatched', description: 'DEBIT CARD PURCHASE - WAWA 5519', direction: 'debit', suggestion: { noMatch: true } });
  const moneyIn = () => ({ ...open(), description: 'ZELLE MONEY RECEIVED FROM SOMEONE', direction: 'credit' });

  test('rejects an unknown decision, a missing row, a settled row and a bank-changed row', async () => {
    await expect(svc.decide({ id: 'b1', decision: 'maybe' })).rejects.toMatchObject({ status: 400 });
    state.bankRow = null;
    await expect(svc.decide({ id: 'b1', decision: 'personal' })).rejects.toMatchObject({ status: 404 });
    state.bankRow = { ...open(), status: 'created_expense' };
    await expect(svc.decide({ id: 'b1', decision: 'personal' })).rejects.toMatchObject({ status: 409 });
    state.bankRow = { ...open(), suggestion: { plaidModified: { amount: 1 } } };
    await expect(svc.decide({ id: 'b1', decision: 'personal' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/bank changed/) });
    // a possible link to an existing expense or payout belongs to Bank Import
    for (const key of ['candidates', 'payoutCandidates', 'refundCandidates']) {
      state.bankRow = { ...open(), suggestion: { [key]: [{ id: 'x' }] } };
      await expect(svc.decide({ id: 'b1', decision: 'expense', categoryId: 'cat-v' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Bank Import/) });
    }
    state.bankRow = { ...open(), suggestion: { candidates: [] } };
    expect(await svc.decide({ id: 'b1', decision: 'expense', categoryId: 'cat-v' })).toEqual(expect.objectContaining({ createExpense: true }));
    // not examined by the matcher yet: an existing expense may still explain it
    for (const suggestion of [null, {}, { categoryId: 'cat-ai', categorySource: 'ai' }]) {
      state.bankRow = { ...open(), suggestion };
      await expect(svc.decide({ id: 'b1', decision: 'personal' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/matcher has not examined/) });
    }
    expect(state.updates).toHaveLength(0);
  });

  test('expense writes nothing: the client makes the expense through create-expense', async () => {
    state.bankRow = open();
    await expect(svc.decide({ id: 'b1', decision: 'expense' })).rejects.toMatchObject({ status: 400 });
    expect(await svc.decide({ id: 'b1', decision: 'expense', categoryId: 'cat-v' })).toEqual({ success: true, action: 'create-expense', createExpense: true, ruleCreated: false });
    expect(state.updates).toHaveLength(0);
    expect(state.inserted).toHaveLength(0);
  });

  test('later is a decision: it shelves the row (rule passes skip decided rows) and clears an income shelf; the row stays open', async () => {
    state.bankRow = open();
    expect(await svc.decide({ id: 'b1', decision: 'later' })).toEqual({ success: true, action: 'later', ruleCreated: false, propagated: true });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].patch).toEqual({ suggestion: { merged: { later: true, decision: 'later', decidedAt: expect.any(String) }, removed: ['income'] }, updated_at: expect.any(Date) });
    expect(state.updates[0].patch.status).toBeUndefined();
    expect(state.updates[0].wheres).toEqual([{ id: 'b1', status: 'unmatched' }, svc.DECIDABLE_SQL]);
  });

  test('income moves the row to the Income shelf: still unmatched, nothing counts it as revenue; money out can never be income', async () => {
    state.bankRow = open();
    await expect(svc.decide({ id: 'b1', decision: 'income' })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/money in/) });
    expect(state.updates).toHaveLength(0);
    state.bankRow = moneyIn();
    expect(await svc.decide({ id: 'b1', decision: 'income' })).toEqual({ success: true, action: 'income', ruleCreated: false, propagated: true });
    const u = state.updates[0];
    expect(u.wheres).toEqual([{ id: 'b1', status: 'unmatched' }, svc.DECIDABLE_SQL]);
    expect(u.patch.status).toBeUndefined();
    expect(u.patch.suggestion.merged).toEqual({ income: true, reason: svc.INCOME_REASON, decision: 'income', decidedAt: expect.any(String) });
    expect(u.patch.suggestion.merged.ignore).toBeUndefined();
    expect(u.patch.suggestion.removed).toEqual(['ignore', 'personal', 'review', 'note', 'later']);
    state.casResult = 0; state.bankRow = moneyIn();
    await expect(svc.decide({ id: 'b1', decision: 'income' })).rejects.toMatchObject({ status: 409 });
  });

  test('income on a row whose only examination marker is the matcher ignore flag keeps the evidence (examined:true)', async () => {
    state.bankRow = { ...moneyIn(), suggestion: { ignore: true, reason: 'internal transfer?' } };
    await svc.decide({ id: 'b1', decision: 'income' });
    expect(state.updates[0].patch.suggestion.merged).toEqual(expect.objectContaining({ income: true, examined: true }));
    expect(state.updates[0].patch.suggestion.removed).toContain('ignore');
    expect(svc.matcherExamined({ suggestion: { income: true, examined: true } })).toBe(true);
    expect(svc.MATCHER_EXAMINED_SQL).toContain("'examined'");
    // with another marker present the marker is still written: the matcher reads 'examined' (or the
    // decision) as "do not put the transfer flag back", whatever else the row carries
    state.updates = []; state.bankRow = { ...moneyIn(), suggestion: { ignore: true, noMatch: true } };
    await svc.decide({ id: 'b1', decision: 'income' });
    expect(state.updates[0].patch.suggestion.merged.examined).toBe(true);
    // no flag to replace: no marker
    state.updates = []; state.bankRow = { ...moneyIn(), suggestion: { noMatch: true } };
    await svc.decide({ id: 'b1', decision: 'income' });
    expect(state.updates[0].patch.suggestion.merged.examined).toBeUndefined();
  });

  test('recorded settles a row on the Income shelf (ignored, income kept, no rule) and is refused elsewhere', async () => {
    state.bankRow = { ...moneyIn(), suggestion: { noMatch: true, income: true, decision: 'income', decidedAt: '2026-01-02T00:00:00Z' } };
    const out = await svc.decide({ id: 'b1', decision: 'recorded', always: true });
    expect(out).toEqual(expect.objectContaining({ action: 'ignored', ruleCreated: false }));
    const w = state.updates[0];
    expect(w.patch.status).toBe('ignored');
    expect(w.patch.suggestion.merged).toEqual(expect.objectContaining({ income: true, decision: 'recorded', reason: expect.stringMatching(/recorded as a sale/) }));
    expect(state.inserted).toHaveLength(0);
    // the UPDATE repeats the shelf check
    expect(w.wheres).toContain(svc.ON_INCOME_SHELF_SQL);
    // a row an income RULE pre-filled (no decision yet) sits on the shelf too and gets the same completion
    state.updates = []; state.bankRow = { ...moneyIn(), suggestion: { noMatch: true, income: true, rule: { id: 'r1', kind: 'income' }, rulesAt: '2026-01-02T00:00:00Z' } };
    expect(await svc.decide({ id: 'b1', decision: 'recorded' })).toEqual(expect.objectContaining({ action: 'ignored', ruleCreated: false }));
    expect(state.updates[0].patch.status).toBe('ignored');
    expect(state.updates[0].patch.suggestion.merged).toEqual(expect.objectContaining({ income: true, decision: 'recorded' }));
    // off the shelf (no income key, a Later row): refused
    for (const sug of [{ noMatch: true }, { noMatch: true, later: true, decision: 'later' }]) {
      state.updates = []; state.bankRow = { ...moneyIn(), suggestion: sug };
      await expect(svc.decide({ id: 'b1', decision: 'recorded' })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Income shelf/) });
    }
  });

  test.each([
    ['personal', { personal: true }],
    ['transfer', { ignore: true }],
  ])('%s parks the row as ignored with the reason and clears the other classification keys', async (decision, flag) => {
    state.bankRow = open();
    expect(await svc.decide({ id: 'b1', decision })).toEqual({ success: true, action: 'ignored', ruleCreated: false, propagated: true });
    const u = state.updates[0];
    expect(u.wheres).toEqual([{ id: 'b1', status: 'unmatched' }, svc.DECIDABLE_SQL]);
    expect(u.patch.status).toBe('ignored');
    expect(u.patch.suggestion.merged).toEqual({ ...flag, reason: `${decision} per the owner`, decision, decidedAt: expect.any(String) });
    expect(u.patch.suggestion.removed).toEqual(expect.arrayContaining(['income', 'later', 'categoryId', 'review']));
  });

  test('a lost race on the status CAS is a 409', async () => {
    state.bankRow = open(); state.casResult = 0;
    await expect(svc.decide({ id: 'b1', decision: 'personal' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/reload/) });
  });

  test('every decision UPDATE repeats the eligibility predicates, so a match parked mid-decision wins', async () => {
    for (const decision of ['later', 'income', 'personal', 'transfer']) {
      state.bankRow = decision === 'income' ? moneyIn() : open(); state.updates = [];
      await svc.decide({ id: 'b1', decision });
      expect(state.updates[0].wheres).toEqual([{ id: 'b1', status: 'unmatched' }, svc.DECIDABLE_SQL]);
    }
    expect(svc.DECIDABLE_SQL).toContain('plaidModified');
    expect(svc.DECIDABLE_SQL).toContain("jsonb_typeof(suggestion->'candidates') = 'array'");
    state.bankRow = open(); state.casResult = 0;
    await expect(svc.decide({ id: 'b1', decision: 'later' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/possible match or a bank change/) });
  });

  test('always: the decision commits first, in one transaction with the owner rule (priority 10), then the payee pass runs', async () => {
    state.bankRow = open();
    // the forced pass reloads rules from the table: the owner rule is there now
    state.rules = [{ id: 'rule-new', pattern: '\\bwawa\\b', kind: 'personal', priority: 10, enabled: true, source: 'owner' }];
    state.bankRows = [{ id: 'b9', description: 'DEBIT CARD PURCHASE - WAWA 1234', suggestion: { noMatch: true, rule: { id: 'seed' } } }];
    const out = await svc.decide({ id: 'b1', decision: 'personal', always: true });
    expect(out).toEqual({ success: true, action: 'ignored', ruleCreated: true, propagated: true });
    expect(mockDb.transaction).toHaveBeenCalled();
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toEqual(expect.objectContaining({ pattern: '\\bwawa\\b', kind: 'personal', priority: 10, source: 'owner', enabled: true, category_id: null }));
    // the decided row was parked first, then the payee pass wrote the other wawa row
    expect(state.updates.map((u) => u.wheres[0].id)).toEqual(['b1', 'b9']);
    expect(state.updates[0].patch.status).toBe('ignored');
    expect(state.updates[1].patch.status).toBeUndefined();
  });

  test('a failed payee pass after a committed decision is logged, not reported as a failure', async () => {
    state.bankRow = open();
    const plain = (table) => builder(table);
    mockDb.mockImplementation((table) => { if (table === 'tax_ledger_rules as r') throw new Error('db down'); return plain(table); });
    const out = await svc.decide({ id: 'b1', decision: 'personal', always: true });
    mockDb.mockImplementation(plain);
    expect(out).toEqual({ success: true, action: 'ignored', ruleCreated: true, propagated: false });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('payee pass after a decision failed: db down'));
    expect(state.inserted).toHaveLength(1);
  });

  test('always on a refused decision writes no rule', async () => {
    state.bankRow = open(); state.casResult = 0;
    await expect(svc.decide({ id: 'b1', decision: 'transfer', always: true })).rejects.toMatchObject({ status: 409 });
    expect(state.inserted).toHaveLength(0);
  });

  test('expense never writes a rule here: create-expense does, once the expense exists (ownerRuleFor)', async () => {
    state.bankRow = open(); state.category = { id: 'cat-v', name: 'Vehicle Expenses', irs_line: '9' };
    const out = await svc.decide({ id: 'b1', decision: 'expense', categoryId: 'cat-v', always: true });
    expect(out).toEqual({ success: true, action: 'create-expense', createExpense: true, ruleCreated: false });
    expect(state.inserted).toHaveLength(0);
    expect(svc.ownerRuleFor(open(), 'expense', 'cat-v')).toEqual({ pattern: '\\bwawa\\b', kind: 'expense', categoryId: 'cat-v', note: 'from the inbox', priority: 10, source: 'owner' });
    expect(svc.ownerRuleFor({ description: '1234 ##' }, 'personal', null)).toBeNull();
  });
});

describe('createRule / updateRule', () => {
  test('createRule validates the pattern, the kind and the category', async () => {
    await expect(svc.createRule({ pattern: '(', kind: 'expense' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.createRule({ pattern: 'wawa', kind: 'nope' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.createRule({ pattern: 'wawa', kind: 'expense' })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/categoryId/) });
    state.category = null;
    await expect(svc.createRule({ pattern: 'wawa', kind: 'expense', categoryId: 'ghost' })).rejects.toMatchObject({ status: 400, message: 'unknown categoryId' });
    const saved = await svc.createRule({ pattern: ' wawa ', kind: 'personal', note: 'x'.repeat(600) });
    expect(saved).toEqual(expect.objectContaining({ pattern: 'wawa', kind: 'personal', priority: 10, source: 'owner' }));
    expect(saved.note).toHaveLength(500);
  });
  test('updateRule rejects an empty patch and a bad priority', async () => {
    await expect(svc.updateRule('r1', {})).rejects.toMatchObject({ status: 400 });
    await expect(svc.updateRule('r1', { priority: 'high' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.updateRule('r1', { pattern: '[' })).rejects.toMatchObject({ status: 400 });
  });

  test('updateRule keeps the invariant: the rule as it would be after the change needs a category when it is an expense', async () => {
    state.bankRow = { id: 'r1', kind: 'personal', category_id: null };
    await expect(svc.updateRule('r1', { kind: 'expense' })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/categoryId/) });
    state.bankRow = { id: 'r1', kind: 'expense', category_id: 'cat-v' };
    await expect(svc.updateRule('r1', { categoryId: null })).rejects.toMatchObject({ status: 400 });
    state.category = { id: 'cat-s', name: 'Supplies', irs_line: '22' };
    state.bankRow = { id: 'r1', kind: 'personal', category_id: null };
    await expect(svc.updateRule('r1', { kind: 'expense', categoryId: 'cat-s' })).resolves.toBeTruthy();
    await expect(svc.updateRule('r1', { enabled: false })).resolves.toBeTruthy();
    state.bankRow = null;
    await expect(svc.updateRule('ghost', { kind: 'personal' })).rejects.toMatchObject({ status: 404 });
  });

  test('a stored pattern is case-folded (letters only; escapes keep their case), so WAWA and wawa are one rule', async () => {
    expect(svc.canonicalPattern('WAWA')).toBe('wawa');
    expect(svc.canonicalPattern('\\bWAWA\\W*GAS\\b')).toBe('\\bwawa\\W*gas\\b');
    expect(svc.canonicalPattern('Costco\\S+Gas')).toBe('costco\\S+gas');
    const saved = await svc.createRule({ pattern: ' \\bWAWA\\W*GAS ', kind: 'personal' });
    expect(saved.pattern).toBe('\\bwawa\\W*gas');
  });

  test('Always on a description with no payee word is refused up front, nothing written', async () => {
    state.bankRow = { id: 'b1', status: 'unmatched', description: 'ACH DEBIT 1234', direction: 'debit', suggestion: { noMatch: true } };
    await expect(svc.decide({ id: 'b1', decision: 'personal', always: true })).rejects.toMatchObject({ status: 400, message: svc.NO_RULE_MESSAGE });
    await expect(svc.decide({ id: 'b1', decision: 'expense', categoryId: 'cat-v', always: true })).rejects.toMatchObject({ status: 400 });
    expect(state.updates).toHaveLength(0);
    expect(state.inserted).toHaveLength(0);
    // without Always the decision goes through
    expect(await svc.decide({ id: 'b1', decision: 'personal' })).toEqual(expect.objectContaining({ action: 'ignored' }));
  });
});

describe('views', () => {
  test('every view admits only matcher-examined rows without live link candidates; bankImport and unexamined count the rest', () => {
    for (const v of ['open', 'later', 'income']) {
      expect(svc.VIEW_SQL[v]).toContain("jsonb_typeof(suggestion->'candidates') = 'array'");
      expect(svc.VIEW_SQL[v]).toContain(svc.MATCHER_EXAMINED_SQL);
    }
    expect(svc.VIEW_SQL.bankImport).toMatch(/^not \(/);
    expect(svc.VIEW_SQL.unexamined).toBe(`not ${svc.MATCHER_EXAMINED_SQL}`);
    expect(svc.MATCHER_EXAMINED_SQL).toContain("array['noMatch','candidates','payoutCandidates','refundCandidates','examined']");
    expect(svc.matcherExamined({ suggestion: { noMatch: true } })).toBe(true);
    expect(svc.matcherExamined({ suggestion: { ignore: true, reason: 'x' } })).toBe(true);
    // an ignore a transfer RULE wrote does not count: a rule cannot manufacture "examined"
    expect(svc.matcherExamined({ suggestion: { ignore: true, rule: { id: 'r', kind: 'transfer' } } })).toBe(false);
    expect(svc.MATCHER_EXAMINED_SQL).toContain("jsonb_exists(coalesce(suggestion, '{}'::jsonb), 'ignore') and not jsonb_exists(coalesce(suggestion, '{}'::jsonb), 'rule')");
    expect(svc.MATCHER_EXAMINED_SQL).not.toMatch(/\?/);
    expect(svc.DECIDABLE_SQL).toContain(svc.MATCHER_EXAMINED_SQL);
    expect(svc.matcherExamined({ suggestion: { categoryId: 'ai' } })).toBe(false);
    expect(svc.matcherExamined({ suggestion: null })).toBe(false);
    expect(svc.inboxBlock({ suggestion: { noMatch: true } })).toBeNull();
    expect(svc.inboxBlock({ suggestion: { candidates: [{ id: 1 }] } })).toMatch(/Bank Import/);
    expect(svc.inboxBlock({ suggestion: null })).toMatch(/matcher has not examined/);
    expect(svc.hasLiveCandidates({ suggestion: { payoutCandidates: [{ id: 1 }] } })).toBe(true);
    expect(svc.hasLiveCandidates({ suggestion: { candidates: [], noMatch: true } })).toBe(false);
    expect(svc.hasLiveCandidates({ suggestion: null })).toBe(false);
  });
});

describe('visibleSuggestion (the kill switch)', () => {
  const ruleSug = { rule: { id: 'r', kind: 'expense' }, categoryId: 'c', categoryName: 'Supplies', irsLine: '22', categorySource: 'rule', rulesAt: 't', noMatch: true, candidates: [{ id: 1 }] };
  test('with the gate on, a suggestion passes through untouched', () => {
    process.env.GATE_BANK_IMPORT = 'true'; process.env.GATE_TAX_LEDGER = 'true';
    expect(svc.visibleSuggestion(ruleSug)).toBe(ruleSug);
  });
  test('with the gate off, what a rule wrote is removed; the matcher keys and owner decisions stay', () => {
    process.env.GATE_BANK_IMPORT = 'true'; delete process.env.GATE_TAX_LEDGER;
    expect(svc.visibleSuggestion(ruleSug)).toEqual({ noMatch: true, candidates: [{ id: 1 }] });
    expect(svc.visibleSuggestion({ rule: { id: 'r', kind: 'transfer' }, ignore: true, reason: 'transfer per ledger rule', rulesAt: 't' })).toEqual({});
    // the matcher's own transfer flag (no rule key) is not a rule's
    const matcher = { ignore: true, reason: 'internal transfer?' };
    expect(svc.visibleSuggestion(matcher)).toBe(matcher);
    // an owner decision survives the gate: the Income shelf flag and the decision itself
    expect(svc.visibleSuggestion({ rule: { id: 'r', kind: 'review' }, income: true, decision: 'income', decidedAt: 'd', reason: 'x', noMatch: true }))
      .toEqual({ income: true, decision: 'income', decidedAt: 'd', reason: 'x', noMatch: true });
    // a review rule's pre-filled category is rule-owned too
    expect(svc.visibleSuggestion({ rule: { id: 'r', kind: 'review' }, review: true, note: 'n', categoryId: 'c', categorySource: 'rule', noMatch: true })).toEqual({ noMatch: true });
    // an AI category (not categorySource rule) stays
    expect(svc.visibleSuggestion({ rule: { id: 'r', kind: 'review' }, categoryId: 'ai', categorySource: 'ai' })).toEqual({ categoryId: 'ai', categorySource: 'ai' });
    expect(svc.visibleSuggestion(null)).toBeNull();
  });
});

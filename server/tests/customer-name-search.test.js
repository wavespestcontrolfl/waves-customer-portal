jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// The shared loader and cap live in tools.js (one export line); stand in for it
// so this unit test does not load the whole Intelligence Bar.
const mockCaps = [];
jest.mock('../services/intelligence-bar/tools', () => ({
  NAME_INDEX_BOOK_CAP: 200000,
  nameCandidates: (query, cap) => { mockCaps.push(cap); return query.limit(cap); },
}));

const { shouldSearchSoundAlike, findSoundAlikeCustomers, EXACT_ROWS_BELOW, MAX_APPROXIMATE_ROWS } = require('../services/customer-name-search');
const { resetNameIndexCache } = require('../services/intelligence-bar/name-match');

// Awaitable knex-style chain over fixed rows. `whereIn` on customers.id keeps
// only the listed ids, like the database does for the scope read.
function fakeKnex(book) {
  const calls = { loads: 0, scope: [] };
  const make = (rows) => {
    const chain = {};
    chain.rows = rows;
    for (const m of ['whereNull', 'select', 'orderBy', 'clearSelect', 'clearOrder']) chain[m] = jest.fn(() => chain);
    chain.limit = jest.fn(() => { calls.loads += 1; return Promise.resolve(book); });
    chain.clone = jest.fn(() => make(rows));
    chain.whereIn = jest.fn((_col, list) => { calls.scope.push(list); return Promise.resolve(book.filter((r) => list.includes(r.id))); });
    return chain;
  };
  const knex = jest.fn(() => make(book));
  knex.calls = calls;
  return knex;
}

const book = [
  { id: 'a', first_name: 'Orlan', last_name: 'Stompf' },
  { id: 'b', first_name: 'Orlan', last_name: 'Stimpf' },
  { id: 'c', first_name: 'Zxqvel', last_name: 'Brantmoor' },
];

describe('shouldSearchSoundAlike', () => {
  test('runs for a name with fewer than 3 exact rows only', () => {
    expect(EXACT_ROWS_BELOW).toBe(3);
    expect(shouldSearchSoundAlike('Orlan damp', 0)).toBe(true);
    expect(shouldSearchSoundAlike('Orlan damp', 2)).toBe(true);
    expect(shouldSearchSoundAlike('Orlan damp', 3)).toBe(false);
  });
  test('never for a text-only address: street words, state, or a place the exact rows matched', () => {
    for (const text of ['Main Street', 'Oak Ave', 'Pine Ridge Rd', 'Bradenton FL', 'Palm Court', 'unit five']) {
      expect(shouldSearchSoundAlike(text, 0)).toBe(false);
    }
    // A city on file: the exact rows matched the text on their city column.
    expect(shouldSearchSoundAlike('Fort Myers', 1, [{ city: 'Fort Myers', address_line1: '1 Sample Way' }])).toBe(false);
    expect(shouldSearchSoundAlike('Fort Myers', 1, [{ address: '2 Fort Myers Cove', city: 'Sample' }])).toBe(false);
    // The exact rows matched on a name: the name pass still runs.
    expect(shouldSearchSoundAlike('Orlan damp', 1, [{ city: 'Fort Myers', address_line1: '1 Sample Way' }])).toBe(true);
  });

  test('never for a phone, email, address or one letter', () => {
    for (const text of ['941-555-0100', 'a@b.co', '12 Main St', 'x', '', undefined, null]) {
      expect(shouldSearchSoundAlike(text, 0)).toBe(false);
    }
  });
});

describe('findSoundAlikeCustomers', () => {
  beforeEach(() => resetNameIndexCache());

  test('ranks sound-alikes, never returns an exact id, caps at 8', async () => {
    const found = await findSoundAlikeCustomers(fakeKnex(book), 'Orlan damp', { exactIds: ['b'] });
    expect(found.map((r) => r.id)).toEqual(['a']);
    expect(found.length).toBeLessThanOrEqual(MAX_APPROXIMATE_ROWS);
  });

  test('reads only the survivors through the scope query', async () => {
    const knex = fakeKnex(book);
    const scoped = [];
    const scopeQuery = {
      clone: () => scopeQuery,
      clearSelect: () => scopeQuery,
      clearOrder: () => scopeQuery,
      select: () => scopeQuery,
      whereIn: (_c, list) => { scoped.push(list); return Promise.resolve(list.includes('b') ? [{ id: 'b' }] : []); },
    };
    const found = await findSoundAlikeCustomers(knex, 'Orlan damp', { scopeQuery });
    expect(found.map((r) => r.id)).toEqual(['b']);
    expect(scoped.length).toBe(1);
    expect(scoped[0]).not.toContain('c');
  });

  test('loads the index with the Intelligence Bar loader and its 200,000 cap', async () => {
    mockCaps.length = 0;
    await findSoundAlikeCustomers(fakeKnex(book), 'Orlan damp');
    expect(mockCaps).toEqual([200000]);
  });

  test('501 matching names: a scope allowing only the last still finds it', async () => {
    const many = Array.from({ length: 501 }, (_, n) => ({ id: `c${String(n).padStart(3, '0')}`, first_name: 'Zara', last_name: 'Quillfern' }));
    const scopeQuery = {
      clone: () => scopeQuery, clearSelect: () => scopeQuery, clearOrder: () => scopeQuery, select: () => scopeQuery,
      whereIn: (_c, list) => Promise.resolve(list.filter((id) => id === 'c500').map((id) => ({ id }))),
    };
    const found = await findSoundAlikeCustomers(fakeKnex(many), 'Zara Quilfern', { scopeQuery });
    expect(found.map((r) => r.id)).toEqual(['c500']);
  });

  test('a database failure returns no rows instead of throwing', async () => {
    const knex = jest.fn(() => { throw new Error('boom'); });
    await expect(findSoundAlikeCustomers(knex, 'Orlan damp')).resolves.toEqual([]);
  });

  test('a non-name search returns nothing without reading the book', async () => {
    const knex = fakeKnex(book);
    await expect(findSoundAlikeCustomers(knex, '941-555-0100')).resolves.toEqual([]);
    expect(knex).not.toHaveBeenCalled();
  });
});

describe('customerSearchFuzzyLive', () => {
  const { customerSearchFuzzyLive } = require('../config/feature-gates');
  afterEach(() => { delete process.env.GATE_CUSTOMER_SEARCH_FUZZY; });
  test('dark unless exactly "true"', () => {
    expect(customerSearchFuzzyLive()).toBe(false);
    for (const value of ['1', 'TRUE', 'yes', '']) {
      process.env.GATE_CUSTOMER_SEARCH_FUZZY = value;
      expect(customerSearchFuzzyLive()).toBe(false);
    }
    process.env.GATE_CUSTOMER_SEARCH_FUZZY = 'true';
    expect(customerSearchFuzzyLive()).toBe(true);
  });
});

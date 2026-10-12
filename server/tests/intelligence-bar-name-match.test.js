const previousAdminPhone = process.env.ADAM_PHONE;
process.env.ADAM_PHONE = '+15555550999';
afterAll(() => { if (previousAdminPhone === undefined) delete process.env.ADAM_PHONE; else process.env.ADAM_PHONE = previousAdminPhone; });
// Real Knex SQL compilation with an in-memory transport: never opens a DB socket.
jest.mock('../models/db', () => {
  const db = require('knex')({ client: 'pg' });
  db.__queries = [];
  db.__rows = () => [];
  db.client.acquireConnection = async () => ({});
  db.client.releaseConnection = async () => {};
  db.client._query = async (_, query) => {
    db.__queries.push(query);
    query.response = { command: 'SELECT', rows: db.__rows(query) };
    return query;
  };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/customer-email-fanout', () => ({ EMAIL_FANOUT_DISCLOSURE: '' }));
const db = require('../models/db');
const { executeTool } = require('../services/intelligence-bar/tools');
const { rankNameMatches, phoneticKey, isNameLikeSearch, tokenize } = require('../services/intelligence-bar/name-match');

const lakeCompany = { id: 'c-lake', first_name: 'Pat', last_name: 'Example', company_name: 'Fybi Lake Rentals' };
const otherLake = { id: 'c-other', first_name: 'Sam', last_name: 'Sample', company_name: 'Harbor Lake Rentals' };
const person = { id: 'c-person', first_name: 'Jon', last_name: 'Smith', company_name: null };
const pool = [lakeCompany, otherLake, person, { id: 'c-x', first_name: 'Zed', last_name: 'Quill', company_name: 'Quill Roofing' }];

describe('name-match scorer', () => {
  test('different spellings of one sound share a key', () => {
    expect(phoneticKey('Phoebe')).toBe(phoneticKey('Fybi'));
    expect(phoneticKey('John')).toBe(phoneticKey('Jhon'));
    expect(phoneticKey('Kristin')).toBe(phoneticKey('Christen'));
    expect(phoneticKey('Phoebe')).not.toBe(phoneticKey('Harbor'));
  });

  test('spelled-out letters collapse into one word, stopwords drop', () => {
    expect(tokenize('S-I-V-I Lake Rentals LLC')).toEqual(['sivi', 'lake', 'rentals']);
    expect(tokenize('f i b i')).toEqual(['fibi']);
    expect(tokenize('J R Smith')).toEqual(['j', 'r', 'smith']);
  });

  test('phone, email and address-number searches skip the fallback', () => {
    expect(isNameLikeSearch('Phoebe Lake Rentals')).toBe(true);
    expect(isNameLikeSearch('5555550100')).toBe(false);
    expect(isNameLikeSearch('(555) 555-0100')).toBe(false);
    expect(isNameLikeSearch('someone@example.com')).toBe(false);
    expect(isNameLikeSearch('  ')).toBe(false);
    // An address has more letters than digits; any digit still rules it out.
    expect(isNameLikeSearch('123 Main St')).toBe(false);
    expect(isNameLikeSearch('Main Street 12')).toBe(false);
  });

  test('two shared words plus one sound-alike word find the company, not the other lake company', () => {
    const ranked = rankNameMatches('Phoebe Lake Rentals', pool);
    expect(ranked.map(r => r.id)).toEqual(['c-lake']);
    expect(ranked[0].score).toBeGreaterThan(0.9);
  });

  test('spelled-out and wrong-letter dictations still reach the company', () => {
    expect(rankNameMatches('F-Y-B-I Lake Rentals', pool).map(r => r.id)).toEqual(['c-lake']);
    expect(rankNameMatches('Fiby Lake Rentals', pool).map(r => r.id)).toEqual(['c-lake']);
    expect(rankNameMatches('Jhon Smyth', pool).map(r => r.id)).toEqual(['c-person']);
  });

  test('common words alone do not match everything, and garbage returns nothing', () => {
    expect(rankNameMatches('Zebra Lake Rentals', pool)).toEqual([]);
    expect(rankNameMatches('Lake Rentals', pool).map(r => r.id).sort()).toEqual(['c-lake', 'c-other']);
    expect(rankNameMatches('Xylophone Trumpet', pool)).toEqual([]);
  });

  test('returns at most five, best first', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, first_name: 'Fybi', last_name: `L${i}`, company_name: null }));
    expect(rankNameMatches('Phoebe', many)).toHaveLength(5);
  });
});

describe('query_customers sound-alike fallback', () => {
  beforeEach(() => { db.__queries = []; db.__rows = () => []; });

  test('an empty exact search falls back, marks the result approximate, and keeps filters and scope', async () => {
    db.__rows = (q) => {
      if (q.sql.includes('count(*)') && q.sql.includes('ILIKE')) return [{ count: '0' }];
      if (q.sql.includes('count(*)')) return [{ count: '4' }];
      if (q.sql.includes('"company_name"') && !q.sql.includes('"email"')) return pool;
      if (q.sql.includes('"email"')) return [{ id: 'c-lake', first_name: 'Pat', last_name: 'Example', active: true }];
      return [];
    };
    const result = await executeTool('query_customers', { search: 'Phoebe Lake Rentals', filters: { active: true } });
    expect(result).toMatchObject({ approximate: true, total_matching: 1, returned_count: 1, has_more: false, next_offset: null });
    expect(result.note).toMatch(/offer_choices/);
    expect(result.customers).toEqual([expect.objectContaining({ id: 'c-lake', name: 'Pat Example' })]);

    const candidateQuery = db.__queries.find(q => q.sql.includes('"customers"."company_name"') && !q.sql.includes('"customers"."email"'));
    expect(candidateQuery.sql).toContain('"customers"."deleted_at" is null');
    expect(candidateQuery.sql).toContain('"active" =');
    expect(candidateQuery.sql).not.toMatch(/ilike/i);
    expect(candidateQuery.sql).toContain('limit');
    const rowsQuery = db.__queries.find(q => q.sql.includes('"customers"."email"') && q.sql.includes('"customers"."id" in'));
    expect(rowsQuery.sql).toContain('"customers"."deleted_at" is null');
  });

  test('a customer-scoped task only ranks its own customers', async () => {
    db.__rows = (q) => {
      if (q.sql.includes('count(*)')) return [{ count: '0' }];
      if (q.sql.includes('"company_name"') && !q.sql.includes('"email"')) return pool;
      return [];
    };
    await executeTool('query_customers', { search: 'Phoebe' }, { readCustomerIds: ['scoped-1'] });
    const candidateQuery = db.__queries.find(q => q.sql.includes('"customers"."company_name"') && !q.sql.includes('"customers"."email"'));
    expect(candidateQuery.sql).toContain('"customers"."id" in');
    expect(candidateQuery.bindings).toContain('scoped-1');
  });

  test('the fallback honors limit, skips later pages, and shows the company', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, first_name: 'Fybi', last_name: `L${i}`, company_name: `Fybi Co ${i}` }));
    db.__rows = (q) => {
      if (q.sql.includes('count(*)')) return [{ count: '0' }];
      if (q.sql.includes('"customers"."id" in')) return many.slice(0, 2).map(c => ({ ...c, company_name: 'Fybi Lake Rentals' }));
      if (!q.sql.includes('"customers"."email"')) return many;
      return [];
    };
    const limited = await executeTool('query_customers', { search: 'Phoebe', limit: 2 });
    expect(limited).toMatchObject({ approximate: true, returned_count: 2, has_more: false, next_offset: null });
    expect(limited.customers[0].company_name).toBe('Fybi Lake Rentals');
    const inQuery = db.__queries.find(q => q.sql.includes('"customers"."id" in'));
    expect(inQuery.bindings.filter(b => /^n\d$/.test(b))).toHaveLength(2);

    db.__queries = [];
    const paged = await executeTool('query_customers', { search: 'Phoebe', limit: 2, offset: 2 });
    expect(paged.approximate).toBeUndefined();
    expect(paged.returned_count).toBe(0);
    expect(db.__queries.some(q => q.sql.includes('"customers"."company_name"') && !q.sql.includes('"customers"."email"'))).toBe(false);
  });

  test('exact hits keep the original shape with no approximate marker', async () => {
    db.__rows = (q) => (q.sql.includes('count(*)') ? [{ count: '1' }] : [{ id: 'c-lake', first_name: 'Pat' }]);
    const result = await executeTool('query_customers', { search: 'Pat' });
    expect(result.approximate).toBeUndefined();
    expect(result.note).toBeUndefined();
    expect(result).toMatchObject({ total_matching: 1, returned_count: 1 });
    expect(db.__queries.filter(q => q.sql.includes('"company_name"') && !q.sql.includes('ILIKE'))).toHaveLength(0);
  });

  test('phone and email searches never run the fallback', async () => {
    db.__rows = (q) => (q.sql.includes('count(*)') ? [{ count: '0' }] : []);
    for (const search of ['9415550100', 'nobody@example.com']) {
      db.__queries = [];
      const result = await executeTool('query_customers', { search });
      expect(result).toMatchObject({ total_matching: 0, returned_count: 0 });
      expect(result.approximate).toBeUndefined();
      expect(db.__queries).toHaveLength(3); // count, rows, total: no candidate read
    }
  });

  test('no close name returns the ordinary empty result', async () => {
    db.__rows = (q) => {
      if (q.sql.includes('count(*)')) return [{ count: '0' }];
      if (q.sql.includes('"company_name"') && !q.sql.includes('"email"')) return pool;
      return [];
    };
    const result = await executeTool('query_customers', { search: 'Xylophone Trumpet' });
    expect(result).toMatchObject({ total_matching: 0, returned_count: 0 });
    expect(result.approximate).toBeUndefined();
  });
});

test('a short first name finds the full one when the last name sounds the same', () => {
  const candidates = [
    { id: 'a', first_name: 'Geoffrey', last_name: 'Tanner' },
    { id: 'b', first_name: 'Samuel', last_name: 'Brennard' },
    { id: 'c', first_name: 'Dana', last_name: 'Whitlock' },
  ];
  expect(rankNameMatches('Sam Braynard', candidates).map(r => r.id)).toEqual(['b']);
  expect(rankNameMatches('Sa Whitlock', candidates)).toEqual([]);
});

test('letters NFD cannot split are folded by the shared policy, in both directions', () => {
  const candidates = [
    { id: 'o', first_name: 'Søren', last_name: 'Example', company_name: null },
    { id: 'l', first_name: 'Pat', last_name: null, company_name: 'Łukow Lake Rentals' },
  ];
  expect(tokenize('Søren Łukow')).toEqual(['soren', 'lukow']);
  expect(rankNameMatches('Soren Example', candidates).map(r => r.id)).toEqual(['o']);
  expect(rankNameMatches('Lukow Lake Rentals', candidates).map(r => r.id)).toEqual(['l']);
  expect(rankNameMatches('Søren Example', [{ id: 'p', first_name: 'Soren', last_name: 'Example' }]).map(r => r.id)).toEqual(['p']);
});

test('one customer word satisfies at most one search word', () => {
  const candidates = [
    { id: 'only-first', first_name: 'Samuel', last_name: 'Zeller', company_name: null },
    { id: 'both', first_name: 'Samuel', last_name: 'Samson', company_name: null },
    { id: 'three', first_name: 'Pat', last_name: null, company_name: 'Fybi Lake Rentals' },
  ];
  expect(rankNameMatches('Sam Samson', candidates).map(r => r.id)).toEqual(['both']);
  // A three-word company search still matches a three-word company, and a
  // spelled-out run still counts as one word.
  expect(rankNameMatches('Phoebe Lake Rentals', candidates).map(r => r.id)).toEqual(['three']);
  expect(rankNameMatches('F-Y-B-I Lake', candidates).map(r => r.id)).toEqual(['three']);
  // More search words than the customer has words: unmatched words fail it.
  expect(rankNameMatches('Phoebe Lake Rentals Pat Extra Words', candidates)).toEqual([]);
});

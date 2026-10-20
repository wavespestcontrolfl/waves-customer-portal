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

// ─── Name matcher v2 (GATE_NAME_MATCH_V2) ───────────────────────

const { MAX_RESULTS_V2, suffixSimilarity } = require('../services/intelligence-bar/name-match');
const { doubleMetaphone } = require('../utils/double-metaphone');
const { etDateString } = require('../utils/datetime-et');

const named = (id, first, last, company = null) => ({ id, first_name: first, last_name: last, company_name: company });
// Five other Richards that sound like "dump" push a v1 Stumpf off its list of five.
const richards = [
  named('stumpf', 'Richard', 'Stumpf'), named('dumas', 'Richard', 'Dumas'), named('dumbar', 'Richard', 'Dumbar'),
  named('dumont', 'Richard', 'Dumont'), named('dumford', 'Richard', 'Dumford'), named('dumpson', 'Richard', 'Dumpson'),
  named('quill', 'Zed', 'Quill'), named('stone', 'Rick', 'Stone'),
];
const ids = (ranked) => ranked.map((r) => r.id);
const v2 = { v2: true };

describe('name matcher v2: scoring', () => {
  test('Double Metaphone follows the published algorithm on known names', () => {
    expect(doubleMetaphone('Smith')).toEqual(['SM0', 'XMT']);
    expect(doubleMetaphone('Schmidt')).toEqual(['XMT', 'SMT']);
    expect(doubleMetaphone('Xavier')).toEqual(['SF', 'SFR']);
    expect(doubleMetaphone('Michael')).toEqual(['MKL', 'MXL']);
    expect(doubleMetaphone('Allman')[0]).toBe(doubleMetaphone('Aleman')[0]);
    expect(doubleMetaphone('')).toEqual(['', '']);
  });

  test('gate off keeps the original scores exactly', () => {
    const v1 = rankNameMatches('richard dump', richards);
    expect(v1).toEqual([
      { id: 'dumpson', score: 0.95 }, { id: 'dumas', score: 0.913 }, { id: 'dumbar', score: 0.913 },
      { id: 'dumford', score: 0.913 }, { id: 'dumont', score: 0.913 },
    ]);
    expect(ids(v1)).not.toContain('stumpf'); // five results and the cap pushed Stumpf off
    expect(rankNameMatches('richard dump', [named('stumpf', 'Richard', 'Stumpf')])).toEqual([{ id: 'stumpf', score: 0.75 }]);
    expect(rankNameMatches('Jhon Smyth', pool)).toEqual([{ id: 'c-person', score: 0.9 }]);
    // Context and the possessive do nothing without v2.
    const context = { onScreenCustomerId: 'stumpf', visitTodayIds: new Set(['stumpf']), recentContactIds: new Set(['stumpf']) };
    expect(rankNameMatches('richard dump', richards, { context })).toEqual(v1);
    expect(tokenize("Richard's dump")).toEqual(['richard', 's', 'dump']);
    expect(rankNameMatches("Richard's dump", richards)).toEqual([]);
    expect(rankNameMatches('Mac Donald', [named('m', 'Pat', 'McDonald')])).toEqual([]);
  });

  test('"richard dump" finds Stumpf in the top eight with no context, and first with a visit today', () => {
    const plain = rankNameMatches('richard dump', richards, v2);
    expect(plain.find((r) => r.id === 'stumpf')).toEqual({ id: 'stumpf', score: 0.9 });
    expect(plain.length).toBeLessThanOrEqual(MAX_RESULTS_V2);
    expect(plain[0].id).toBe('dumpson');
    expect(ids(plain).indexOf('stumpf')).toBeLessThan(8);

    const visit = rankNameMatches('richard dump', richards, { ...v2, context: { visitTodayIds: new Set(['stumpf']) } });
    expect(visit[0]).toEqual({ id: 'stumpf', score: 1, reasons: ['visit_soon'] });
    const screen = rankNameMatches('richard dump', richards, { ...v2, context: { onScreenCustomerId: 'stumpf', recentContactIds: new Set(['stumpf']) } });
    expect(screen[0]).toEqual({ id: 'stumpf', score: 1.1, reasons: ['on_screen', 'recent_contact'] });
  });

  test('a context bonus lowers the floor to 0.65 for that customer only', () => {
    const weak = [named('weak', 'Rick', 'Dima'), named('other', 'Rick', 'Dima')];
    expect(rankNameMatches('richard dumas', weak, v2)).toEqual([]); // base 0.712, under the 0.75 floor
    const boosted = rankNameMatches('richard dumas', weak, { ...v2, context: { visitTodayIds: new Set(['weak']) } });
    expect(boosted).toEqual([{ id: 'weak', score: 0.812, reasons: ['visit_soon'] }]);
    // A bonus cannot rescue a customer whose spelling is far off.
    expect(rankNameMatches('richard dumas', [named('far', 'Zed', 'Quill')], { ...v2, context: { onScreenCustomerId: 'far' } })).toEqual([]);
  });

  test('possessive and a lone s are not search words', () => {
    expect(tokenize("Richard's dump", v2)).toEqual(['richard', 'dump']);
    expect(tokenize('Richard’s dump', v2)).toEqual(['richard', 'dump']);
    expect(tokenize('richard s dump', v2)).toEqual(['richard', 'dump']);
    expect(ids(rankNameMatches("Richard's dump", richards, v2))).toContain('stumpf');
    expect(ids(rankNameMatches('Richard’s dump', richards, v2))).toContain('stumpf');
  });

  test('shared endings score 0.6 to 0.9; a first name that matches exactly keeps a garbled last name as a choice', () => {
    expect(suffixSimilarity('stumpf', 'rumpf')).toBeCloseTo(0.6 + 0.3 * (4 / 5), 5);
    expect(suffixSimilarity('dump', 'stumpf')).toBe(0);
    expect(suffixSimilarity('jo', 'bo')).toBe(0);
    const three = [named('a', 'Richard', 'Van Dumas'), named('b', 'Zed', 'Quill')];
    expect(ids(rankNameMatches('richard van dumas', three, v2))).toEqual(['a']);
    const choices = rankNameMatches('richard stunpfel', [named('s', 'Richard', 'Stumpf'), named('q', 'Zed', 'Quill')], v2);
    expect(ids(choices)).toEqual(['s']);
  });

  test('sound-alike tolerances: voiced pairs, pf, initial st, one dropped final consonant', () => {
    const { tolerantKey } = require('../services/intelligence-bar/name-match');
    expect(tolerantKey('dump')).toBe(tolerantKey('stumpf'));
    expect(tolerantKey('Tomas')).toBe(tolerantKey('Domas'));
    expect(tolerantKey('Garcia')).toBe(tolerantKey('Karcia'));
    expect(tolerantKey('Zimmer')).toBe(tolerantKey('Simmer'));
    expect(ids(rankNameMatches('Jon Stump', [named('s', 'John', 'Stumps')], v2))).toEqual(['s']);
    expect(ids(rankNameMatches('Pat Dump', [named('s', 'Pat', 'Stumpf'), named('q', 'Pat', 'Quill')], v2))).toEqual(['s']);
  });

  test('alleman finds Allman and Aleman, ahead of an unrelated name', () => {
    const list = [named('allman', 'Pat', 'Allman'), named('aleman', 'Pat', 'Aleman'), named('zimmer', 'Pat', 'Zimmer')];
    expect(ids(rankNameMatches('Pat alleman', list, v2)).sort()).toEqual(['aleman', 'allman']);
    expect(ids(rankNameMatches('alleman', list, v2)).sort()).toEqual(['aleman', 'allman']);
  });

  test('McDonald, Mac Donald and Macdonald find each other', () => {
    const list = [named('mc', 'Pat', 'McDonald'), named('mac', 'Pat', 'Macdonald'), named('spaced', 'Pat', 'Mac Donald'), named('zed', 'Pat', 'Zimmer')];
    for (const search of ['Pat McDonald', 'Pat Mac Donald', 'Pat Macdonald']) {
      expect(ids(rankNameMatches(search, list, v2)).sort()).toEqual(['mac', 'mc', 'spaced']);
    }
  });

  test('Anne-Marie, Anne Marie and Annemarie find each other', () => {
    const list = [named('a', 'Anne Marie', 'Lee'), named('b', 'Annemarie', 'Lee'), named('c', 'Anne-Marie', 'Lee'), named('d', 'Bob', 'Lee')];
    for (const search of ['Anne-Marie Lee', 'Anne Marie Lee', 'Annemarie Lee']) {
      expect(ids(rankNameMatches(search, list, v2)).sort()).toEqual(['a', 'b', 'c']);
    }
  });

  test('a run together search word never passes for a short first name', () => {
    expect(rankNameMatches('richard xyzzy', [named('r', 'Richard', 'Stumpf'), named('k', 'Rick', 'Stone')], v2)).toEqual([]);
    expect(rankNameMatches('richard dump', [named('k', 'Rick', 'Stone')], v2)).toEqual([]);
  });

  test('accents fold: Nunez, Hernandes and Jose find Nuñez, Hernández and José', () => {
    expect(ids(rankNameMatches('Pat Nunez', [named('n', 'Pat', 'Nuñez')], v2))).toEqual(['n']);
    expect(ids(rankNameMatches('Pat Hernandes', [named('h', 'Pat', 'Hernández')], v2))).toEqual(['h']);
    expect(ids(rankNameMatches('Jose Reed', [named('j', 'José', 'Reed')], v2))).toEqual(['j']);
    expect(ids(rankNameMatches('Pat Nuñez', [named('n', 'Pat', 'Nunez')], v2))).toEqual(['n']);
  });

  test('a phone number or email never ranks anyone', () => {
    for (const search of ['9415550100', '(941) 555-0100', 'richard@example.com']) {
      expect(rankNameMatches(search, richards, v2)).toEqual([]);
    }
  });

  test('the v1 test pool still ranks the same way under v2', () => {
    expect(ids(rankNameMatches('Phoebe Lake Rentals', pool, v2))).toEqual(['c-lake']);
    expect(ids(rankNameMatches('F-Y-B-I Lake Rentals', pool, v2))).toEqual(['c-lake']);
    expect(ids(rankNameMatches('Jhon Smyth', pool, v2))).toEqual(['c-person']);
    expect(rankNameMatches('Zebra Lake Rentals', pool, v2)).toEqual([]);
    expect(rankNameMatches('Xylophone Trumpet', pool, v2)).toEqual([]);
  });
});

describe('query_customers name matcher v2', () => {
  const candidates = [named('dumas', 'Richard', 'Dumas'), named('stumpf', 'Richard', 'Stumpf'), named('quill', 'Zed', 'Quill')];
  const today = etDateString();
  let previous;
  beforeEach(() => {
    previous = process.env.GATE_NAME_MATCH_V2;
    db.__queries = [];
    db.__rows = () => [];
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.GATE_NAME_MATCH_V2; else process.env.GATE_NAME_MATCH_V2 = previous;
  });

  // One exact hit (Dumas), the whole book as candidates, Stumpf has a visit.
  function oneExactHit({ visits = [{ customer_id: 'stumpf' }], texts = [], calls = [] } = {}) {
    db.__rows = (q) => {
      if (q.sql.includes('from "scheduled_services"')) return visits;
      if (q.sql.includes('from "sms_log"')) return texts;
      if (q.sql.includes('from "call_log"')) return calls;
      if (q.sql.includes('count(*)')) return [{ count: '1' }];
      if (!q.sql.includes('"customers"."email"')) return candidates; // name columns only
      if (q.sql.includes('"customers"."id" in') && q.bindings.includes('stumpf')) return [{ id: 'stumpf', first_name: 'Richard', last_name: 'Stumpf', active: true }];
      return [{ id: 'dumas', first_name: 'Richard', last_name: 'Dumas', active: true }];
    };
  }
  const candidateQuery = () => db.__queries.find((q) => q.sql.includes('"customers"."company_name"') && !q.sql.includes('"customers"."email"'));

  test('gate off: one exact hit is returned as is and no context is read', async () => {
    delete process.env.GATE_NAME_MATCH_V2;
    oneExactHit();
    const result = await executeTool('query_customers', { search: 'richard dump' }, { pageCustomerId: 'stumpf' });
    expect(result.alternatives).toBeUndefined();
    expect(result.approximate).toBeUndefined();
    expect(result.note).toBeUndefined();
    expect(db.__queries).toHaveLength(3); // count, rows, total
  });

  test('gate on: a wrong single exact hit comes with the right person as an alternative', async () => {
    process.env.GATE_NAME_MATCH_V2 = 'true';
    oneExactHit();
    const result = await executeTool('query_customers', { search: 'richard dump' });
    expect(result.customers).toEqual([expect.objectContaining({ id: 'dumas' })]);
    expect(result.total_matching).toBe(1);
    expect(result.alternatives).toEqual([expect.objectContaining({ id: 'stumpf', match: { score: 1, reasons: ['visit_soon'] } })]);
    expect(result.exact_hit_match).toEqual({ rank: 2, score: 0.913, reasons: [] });
    expect(result.note).toMatch(/offer_choices/);
    expect(result.approximate).toBeUndefined();
    // One read per context source, one column, today and tomorrow (ET) and the last 7 days.
    const visitQuery = db.__queries.find((q) => q.sql.includes('from "scheduled_services"'));
    expect(visitQuery.sql).toMatch(/select distinct "customer_id" from "scheduled_services"/);
    expect(visitQuery.bindings).toContain(today);
    expect(db.__queries.some((q) => q.sql.includes('select distinct "customer_id" from "sms_log"'))).toBe(true);
    expect(db.__queries.some((q) => q.sql.includes('select distinct "customer_id" from "call_log"'))).toBe(true);
  });

  test('gate on: the customer on screen and a recent text count', async () => {
    process.env.GATE_NAME_MATCH_V2 = 'true';
    oneExactHit({ visits: [], texts: [{ customer_id: 'dumas' }] });
    const result = await executeTool('query_customers', { search: 'richard dump' }, { pageCustomerId: 'stumpf' });
    expect(result.alternatives[0]).toMatchObject({ id: 'stumpf', match: { score: 1.05, reasons: ['on_screen'] } });
    expect(result.exact_hit_match).toEqual({ rank: 2, score: 0.963, reasons: ['recent_contact'] });
  });

  test('gate on: nothing close to the exact hit leaves the result alone', async () => {
    process.env.GATE_NAME_MATCH_V2 = 'true';
    db.__rows = (q) => {
      if (q.sql.includes('count(*)')) return [{ count: '1' }];
      if (/from "(scheduled_services|sms_log|call_log)"/.test(q.sql)) return [];
      if (!q.sql.includes('"customers"."email"')) return [named('quill', 'Zed', 'Quill')];
      return [{ id: 'quill', first_name: 'Zed', last_name: 'Quill' }];
    };
    const result = await executeTool('query_customers', { search: 'zed' });
    expect(result.alternatives).toBeUndefined();
    expect(result.exact_hit_match).toBeUndefined();
  });

  test('gate on: a scoped task (or technician) ranks and reads only its own customers', async () => {
    process.env.GATE_NAME_MATCH_V2 = 'true';
    oneExactHit();
    await executeTool('query_customers', { search: 'richard dump' }, { readCustomerIds: ['scoped-1'], pageCustomerId: 'stumpf' });
    expect(candidateQuery().sql).toContain('"customers"."id" in');
    expect(candidateQuery().bindings).toContain('scoped-1');
    const rowsQuery = db.__queries.find((q) => q.sql.includes('"customers"."email"') && q.bindings.includes('stumpf'));
    expect(rowsQuery.sql).toContain('"customers"."deleted_at" is null');
    expect(rowsQuery.bindings).toContain('scoped-1');
    // The context reads never touch the customers table: they only re-rank scoped rows.
    for (const q of db.__queries.filter((x) => /from "(sms_log|call_log)"/.test(x.sql))) expect(q.sql).not.toMatch(/"customers"/);
  });

  test('gate on: an empty exact search ranks the v2 way, up to eight, with match info', async () => {
    process.env.GATE_NAME_MATCH_V2 = 'true';
    const many = Array.from({ length: 10 }, (_, i) => named(`d${i}`, 'Richard', `Dumas${i}`));
    db.__rows = (q) => {
      if (/from "(scheduled_services|sms_log|call_log)"/.test(q.sql)) return q.sql.includes('scheduled_services') ? [{ customer_id: 'd9' }] : [];
      if (q.sql.includes('count(*)')) return [{ count: '0' }];
      if (!q.sql.includes('"customers"."email"')) return many;
      if (q.sql.includes('"customers"."id" in')) return many.filter((c) => q.bindings.includes(c.id));
      return [];
    };
    const result = await executeTool('query_customers', { search: 'richard dumas' });
    expect(result).toMatchObject({ approximate: true, returned_count: 8, has_more: false, next_offset: null });
    expect(result.customers[0]).toMatchObject({ id: 'd9', match: { reasons: ['visit_soon'] } });
    expect(result.note).toMatch(/match\.reasons/);
  });

  test('gate on: a context read that fails only drops the bonus', async () => {
    process.env.GATE_NAME_MATCH_V2 = 'true';
    oneExactHit();
    const rows = db.__rows;
    db.__rows = (q) => { if (q.sql.includes('from "sms_log"')) throw new Error('boom'); return rows(q); };
    const result = await executeTool('query_customers', { search: 'richard dump' });
    expect(result.alternatives).toEqual([expect.objectContaining({ id: 'stumpf', match: { score: 0.9, reasons: [] } })]);
  });

  test('gate on: phone and email searches never rank or read context', async () => {
    process.env.GATE_NAME_MATCH_V2 = 'true';
    db.__rows = (q) => (q.sql.includes('count(*)') ? [{ count: '1' }] : [{ id: 'c1', first_name: 'Pat' }]);
    for (const search of ['9415550100', 'nobody@example.com']) {
      db.__queries = [];
      const result = await executeTool('query_customers', { search });
      expect(result.alternatives).toBeUndefined();
      expect(db.__queries).toHaveLength(3);
    }
  });
});

describe('name match v2 work budget (Codex #6367 security P2)', () => {
  const { rankNameMatches } = require('../services/intelligence-bar/name-match');
  const pool = [{ id: 'a', first_name: 'Richard', last_name: 'Stumpf' }];

  test('a search with more than 6 words or 120 characters is not ranked', () => {
    expect(rankNameMatches(Array(1000).fill('richard').join(' '), pool, { v2: true })).toEqual([]);
    expect(rankNameMatches('richard stumpf one two three four five', pool, { v2: true })).toEqual([]);
    expect(rankNameMatches(`richard ${'x'.repeat(130)}`, pool, { v2: true })).toEqual([]);
  });

  test('a long candidate name and long words finish fast', () => {
    const big = [{ id: 'b', first_name: 'Richard', last_name: Array(500).fill('stumpf').join(' '), company_name: 'y'.repeat(5000) }];
    const started = Date.now();
    rankNameMatches('richard stumpf', big, { v2: true });
    expect(Date.now() - started).toBeLessThan(200);
  });

  test('a normal spoken name still matches', () => {
    expect(rankNameMatches('richard stumpf', pool, { v2: true })[0]).toEqual(expect.objectContaining({ id: 'a' }));
  });
});

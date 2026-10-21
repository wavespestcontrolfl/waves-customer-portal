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

const {
  MAX_RESULTS_V2, suffixSimilarity, MAX_SURVIVORS, buildNameIndex, prefilterNameIndex, resetNameIndexCache,
} = require('../services/intelligence-bar/name-match');
const { doubleMetaphone } = require('../utils/double-metaphone');
const { etDateString } = require('../utils/datetime-et');

const named = (id, first, last, company = null) => ({ id, first_name: first, last_name: last, company_name: company });
// Five other Richards that sound like "dump" push a v1 Stompf off its list of five.
const richards = [
  named('stompf', 'Richard', 'Stompf'), named('dumas', 'Richard', 'Dumas'), named('dumbar', 'Richard', 'Dumbar'),
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
    expect(ids(v1)).not.toContain('stompf'); // five results and the cap pushed Stompf off
    expect(rankNameMatches('richard dump', [named('stompf', 'Richard', 'Stompf')])).toEqual([]); // v1 misses it entirely
    expect(rankNameMatches('Jhon Smyth', pool)).toEqual([{ id: 'c-person', score: 0.9 }]);
    // Context and the possessive do nothing without v2.
    const context = { onScreenCustomerId: 'stompf', visitTodayIds: new Set(['stompf']), recentContactIds: new Set(['stompf']) };
    expect(rankNameMatches('richard dump', richards, { context })).toEqual(v1);
    expect(tokenize("Richard's dump")).toEqual(['richard', 's', 'dump']);
    expect(rankNameMatches("Richard's dump", richards)).toEqual([]);
    expect(rankNameMatches('Mac Donald', [named('m', 'Pat', 'McDonald')])).toEqual([]);
  });

  test('"richard dump" finds Stompf in the top eight with no context, and first with a visit today', () => {
    const plain = rankNameMatches('richard dump', richards, v2);
    expect(plain.find((r) => r.id === 'stompf')).toEqual({ id: 'stompf', score: 0.9 });
    expect(plain.length).toBeLessThanOrEqual(MAX_RESULTS_V2);
    expect(plain[0].id).toBe('dumpson');
    expect(ids(plain).indexOf('stompf')).toBeLessThan(8);

    const visit = rankNameMatches('richard dump', richards, { ...v2, context: { visitTodayIds: new Set(['stompf']) } });
    expect(visit[0]).toEqual({ id: 'stompf', score: 1, reasons: ['visit_soon'] });
    const screen = rankNameMatches('richard dump', richards, { ...v2, context: { onScreenCustomerId: 'stompf', recentContactIds: new Set(['stompf']) } });
    expect(screen[0]).toEqual({ id: 'stompf', score: 1.1, reasons: ['on_screen', 'recent_contact'] });
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
    expect(ids(rankNameMatches("Richard's dump", richards, v2))).toContain('stompf');
    expect(ids(rankNameMatches('Richard’s dump', richards, v2))).toContain('stompf');
  });

  test('shared endings score 0.6 to 0.9; a first name that matches exactly keeps a garbled last name as a choice', () => {
    expect(suffixSimilarity('stompf', 'rumpf')).toBeCloseTo(0.6 + 0.3 * (3 / 5), 5);
    expect(suffixSimilarity('dump', 'stompf')).toBe(0);
    expect(suffixSimilarity('jo', 'bo')).toBe(0);
    const three = [named('a', 'Richard', 'Van Dumas'), named('b', 'Zed', 'Quill')];
    expect(ids(rankNameMatches('richard van dumas', three, v2))).toEqual(['a']);
    const choices = rankNameMatches('richard stunpfel', [named('s', 'Richard', 'Stompf'), named('q', 'Zed', 'Quill')], v2);
    expect(ids(choices)).toEqual(['s']);
  });

  test('sound-alike tolerances: voiced pairs, pf, initial st, one dropped final consonant', () => {
    const { tolerantKey } = require('../services/intelligence-bar/name-match');
    expect(tolerantKey('dump')).toBe(tolerantKey('stompf'));
    expect(tolerantKey('Tomas')).toBe(tolerantKey('Domas'));
    expect(tolerantKey('Garcia')).toBe(tolerantKey('Karcia'));
    expect(tolerantKey('Zimmer')).toBe(tolerantKey('Simmer'));
    expect(ids(rankNameMatches('Jon Stump', [named('s', 'John', 'Stumps')], v2))).toEqual(['s']);
    expect(ids(rankNameMatches('Pat Dump', [named('s', 'Pat', 'Stompf'), named('q', 'Pat', 'Quill')], v2))).toEqual(['s']);
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
    expect(rankNameMatches('richard xyzzy', [named('r', 'Richard', 'Stompf'), named('k', 'Rick', 'Stone')], v2)).toEqual([]);
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
  const candidates = [named('dumas', 'Richard', 'Dumas'), named('stompf', 'Richard', 'Stompf'), named('quill', 'Zed', 'Quill')];
  const today = etDateString();
  let previous;
  beforeEach(() => {
    previous = process.env.GATE_NAME_MATCH_V2;
    resetNameIndexCache();
    db.__queries = [];
    db.__rows = () => [];
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.GATE_NAME_MATCH_V2; else process.env.GATE_NAME_MATCH_V2 = previous;
  });

  // One exact hit (Dumas), the whole book as candidates, Stompf has a visit.
  function oneExactHit({ visits = [{ customer_id: 'stompf' }], texts = [], calls = [] } = {}) {
    db.__rows = (q) => {
      if (q.sql.includes('from "scheduled_services"')) return visits;
      if (q.sql.includes('from "sms_log"')) return texts;
      if (q.sql.includes('from "call_log"')) return calls;
      if (q.sql.includes('count(*)')) return [{ count: '1' }];
      if (!q.sql.includes('"customers"."email"')) return candidates; // name columns only
      if (q.sql.includes('"customers"."id" in') && q.bindings.includes('stompf')) return [{ id: 'stompf', first_name: 'Richard', last_name: 'Stompf', active: true }];
      return [{ id: 'dumas', first_name: 'Richard', last_name: 'Dumas', active: true }];
    };
  }
  const candidateQuery = () => db.__queries.find((q) => q.sql.includes('"customers"."company_name"') && !q.sql.includes('"customers"."email"'));

  test('gate off: one exact hit is returned as is and no context is read', async () => {
    delete process.env.GATE_NAME_MATCH_V2;
    oneExactHit();
    const result = await executeTool('query_customers', { search: 'richard dump' }, { pageCustomerId: 'stompf' });
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
    expect(result.alternatives).toEqual([expect.objectContaining({ id: 'stompf', match: { score: 1, reasons: ['visit_soon'] } })]);
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
    const result = await executeTool('query_customers', { search: 'richard dump' }, { pageCustomerId: 'stompf' });
    expect(result.alternatives[0]).toMatchObject({ id: 'stompf', match: { score: 1.05, reasons: ['on_screen'] } });
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
    await executeTool('query_customers', { search: 'richard dump' }, { readCustomerIds: ['scoped-1'], pageCustomerId: 'stompf' });
    expect(candidateQuery().sql).toContain('"customers"."id" in');
    expect(candidateQuery().bindings).toContain('scoped-1');
    const rowsQuery = db.__queries.find((q) => q.sql.includes('"customers"."email"') && q.bindings.includes('stompf'));
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
    expect(result.alternatives).toEqual([expect.objectContaining({ id: 'stompf', match: { score: 0.9, reasons: [] } })]);
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
  const pool = [{ id: 'a', first_name: 'Richard', last_name: 'Stompf' }];

  test('a search with more than 6 words or 120 characters is not ranked', () => {
    expect(rankNameMatches(Array(1000).fill('richard').join(' '), pool, { v2: true })).toEqual([]);
    expect(rankNameMatches('richard stompf one two three four five', pool, { v2: true })).toEqual([]);
    expect(rankNameMatches(`richard ${'x'.repeat(130)}`, pool, { v2: true })).toEqual([]);
  });

  test('a long candidate name and long words finish fast', () => {
    const big = [{ id: 'b', first_name: 'Richard', last_name: Array(500).fill('stompf').join(' '), company_name: 'y'.repeat(5000) }];
    const started = Date.now();
    rankNameMatches('richard stompf', big, { v2: true });
    expect(Date.now() - started).toBeLessThan(200);
  });

  test('a normal spoken name still matches', () => {
    expect(rankNameMatches('richard stompf', pool, { v2: true })[0]).toEqual(expect.objectContaining({ id: 'a' }));
  });
});

describe('name match v2 work cap (Codex #6367 perf)', () => {
  const firsts = ['Pat', 'Maria', 'Jose', 'Anne', 'Sam', 'Lee', 'Kim', 'Dana', 'Ray', 'Tom', 'Ana', 'Ben'];
  const lasts = ['Smith', 'Garcia', 'Nguyen', 'Allman', 'Jones', 'Brown', 'Taylor', 'Reed', 'Lopez', 'Clark', 'Young', 'Hall', 'Dunn'];
  // 20,000 synthetic customers plus 600 Richards (more than the survivor cap) and the two Stompf rows.
  const book = Array.from({ length: 20000 }, (_, i) => named(`b${String(i).padStart(5, '0')}`, `${firsts[i % 12]}${i % 7 ? '' : 'son'}`, `${lasts[(i * 7) % 13]}${i % 11 ? '' : 'ton'}`));
  const richardsBook = Array.from({ length: 600 }, (_, i) => named(`r${String(i).padStart(3, '0')}`, 'Richard', lasts[i % 13]));
  const stompfRows = [named('stompf-r', 'Richard', 'Stompf'), named('stompf-o', 'Orlando', 'Stompf')];
  const everyone = [...book, ...richardsBook, ...stompfRows];
  const fastest = (fn, runs = 3) => {
    let best = Infinity;
    for (let i = 0; i < runs; i += 1) { const t = process.hrtime.bigint(); fn(); best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6); }
    return best;
  };

  test('a call over a built index of 20,000 customers finishes in under 150 ms and still ranks Stompf', () => {
    const index = buildNameIndex(everyone);
    expect(prefilterNameIndex('richard dump', index).length).toBeLessThanOrEqual(MAX_SURVIVORS);
    for (const [search, id] of [['richard dump', 'stompf-r'], ['orlan dump', 'stompf-o'], ["Richard's dump", 'stompf-r']]) {
      const run = (context) => rankNameMatches(search, prefilterNameIndex(search, index), { v2: true, prefiltered: true, context });
      expect(fastest(() => run(null))).toBeLessThan(150);
      expect(ids(run(null))).toContain(id);
      const visit = run({ visitTodayIds: new Set([id]) });
      expect(visit[0]).toMatchObject({ id, reasons: ['visit_soon'] });
      expect(fastest(() => run({ visitTodayIds: new Set([id]) }))).toBeLessThan(150);
    }
  });

  test('spelling-only matches get through the prefilter: a shared ending or one slip', () => {
    const index = buildNameIndex([named('h', 'Pat', 'Henderson'), named('s', 'Pat', 'Smyth-Jones'), named('q', 'Zed', 'Quill'), named('l', 'Pat', 'Lindqvist')]);
    const survivors = (search) => prefilterNameIndex(search, index).map((e) => e.id);
    expect(survivors('Pat Anderson')).toContain('h');
    expect(ids(rankNameMatches('Pat Anderson', survivors('Pat Anderson').map((id) => index.byId.get(id)), { v2: true, prefiltered: true }))).toContain('h');
    // The same answer as scoring every row with no prefilter in the way.
    expect(ids(rankNameMatches('Pat Anderson', [named('h', 'Pat', 'Henderson')], v2))).toEqual(['h']);
    expect(survivors('Pat Lindqvest')).toContain('l');
    // One wrong, missing or extra letter anywhere in the word still retrieves it.
    const typos = buildNameIndex([named('j', 'Pat', 'Jones'), named('r', 'Pat', 'Ramirez')]);
    for (const word of ['Jomes', 'Jnes', 'Jonnes', 'Zones']) expect(prefilterNameIndex(`Pat ${word}`, typos).map((e) => e.id)).toContain('j');
    expect(ids(rankNameMatches('Pat Jomes', [named('j', 'Pat', 'Jones')], v2))).toEqual(['j']);
    expect(ids(rankNameMatches('Pat Jomes', prefilterNameIndex('Pat Jomes', typos), { v2: true, prefiltered: true }))).toContain('j');
  });

  test('a one-letter deletion retrieves from either side, short words included', () => {
    const only = (list, search) => prefilterNameIndex(search, buildNameIndex(list)).map((e) => e.id);
    expect(only([named('a', 'Zed', 'Jose')], 'joe')).toEqual(['a']);
    expect(only([named('a', 'Zed', 'Joe')], 'jose')).toEqual(['a']);
    expect(only([named('a', 'Zed', 'Mark')], 'mak')).toEqual(['a']);
    expect(only([named('a', 'Zed', 'Mak')], 'mark')).toEqual(['a']);
    expect(only([named('a', 'Zed', 'Quill')], 'joe')).toEqual([]);
  });

  test('survivors are capped and need a shared key; an unrelated book yields none', () => {
    const index = buildNameIndex(everyone);
    expect(prefilterNameIndex('richard', index)).toHaveLength(MAX_SURVIVORS);
    expect(prefilterNameIndex('xylophone trumpet', index)).toEqual([]);
    expect(prefilterNameIndex('9415550100', index)).toEqual([]);
    // The customer on screen rides along even with no shared key.
    expect(prefilterNameIndex('xylophone trumpet', index, { include: ['stompf-r'] }).map((e) => e.id)).toEqual(['stompf-r']);
  });

  describe('through query_customers', () => {
    const prev = process.env.GATE_NAME_MATCH_V2;
    beforeEach(() => { process.env.GATE_NAME_MATCH_V2 = 'true'; resetNameIndexCache(); db.__queries = []; });
    afterAll(() => { if (prev === undefined) delete process.env.GATE_NAME_MATCH_V2; else process.env.GATE_NAME_MATCH_V2 = prev; });

    const mockBook = (visits = []) => {
      db.__rows = (q) => {
        if (q.sql.includes('from "scheduled_services"')) return visits;
        if (/from "(sms_log|call_log)"/.test(q.sql)) return [];
        if (q.sql.includes('count(*)')) return [{ count: '1' }];
        if (!q.sql.includes('"customers"."email"')) return everyone;
        if (q.bindings.includes('stompf-r')) return [{ id: 'stompf-r', first_name: 'Richard', last_name: 'Stompf' }];
        return [{ id: 'b00001', first_name: 'Pat', last_name: 'Dunn' }];
      };
    };
    const candidateReads = () => db.__queries.filter((q) => q.sql.includes('"customers"."company_name"') && !q.sql.includes('"customers"."email"')).length;

    test('an unscoped book is read once, then served from the cache; a call is under 150 ms', async () => {
      mockBook([{ customer_id: 'stompf-r' }]);
      const first = await executeTool('query_customers', { search: 'richard dump' });
      expect(first.alternatives[0]).toMatchObject({ id: 'stompf-r' });
      expect(candidateReads()).toBe(1);
      const started = process.hrtime.bigint();
      const second = await executeTool('query_customers', { search: 'richard dump' });
      expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(150);
      expect(second.alternatives[0]).toMatchObject({ id: 'stompf-r', match: { score: 1, reasons: ['visit_soon'] } });
      expect(candidateReads()).toBe(1);
      // A filter set shares the one cached book: the database applies it to the survivors.
      await executeTool('query_customers', { search: 'richard dump', filters: { active: true } });
      expect(candidateReads()).toBe(1);
      const allowQuery = db.__queries.filter((q) => q.sql.startsWith('select "customers"."id" from "customers"') && q.sql.includes('"active" =')).pop();
      expect(allowQuery.sql).toContain('"customers"."deleted_at" is null');
      expect(allowQuery.sql).toContain('"customers"."id" in');
      expect(allowQuery.bindings.filter((b) => typeof b === 'string' && (/^(b|r)\d+$/.test(b) || b.startsWith('stompf'))).length).toBeLessThanOrEqual(MAX_SURVIVORS + 1);
    });

    test('a customer the query does not allow never comes back', async () => {
      db.__rows = (q) => {
        if (q.sql.includes('count(*)')) return [{ count: '1' }];
        if (q.sql.includes('"customers"."company_name"') && !q.sql.includes('"customers"."email"')) return everyone;
        if (q.sql.startsWith('select "customers"."id" from "customers"')) return []; // the filters exclude every survivor
        return [{ id: 'b00001', first_name: 'Pat', last_name: 'Dunn' }];
      };
      const result = await executeTool('query_customers', { search: 'richard dump', filters: { active: true } });
      expect(result.alternatives).toBeUndefined();
    });

    test('filtered-out customers do not use up the survivor slots: the next chunk is checked (Codex #6367 r4)', async () => {
      let allowCalls = 0;
      let allowedId = null;
      db.__rows = (q) => {
        if (q.sql.includes('count(*)')) return [{ count: '1' }];
        if (/from "(scheduled_services|sms_log|call_log)"/.test(q.sql)) return [];
        if (q.sql.includes('"customers"."company_name"') && !q.sql.includes('"customers"."email"')) return everyone;
        if (q.sql.startsWith('select "customers"."id" from "customers"')) {
          allowCalls += 1;
          if (allowCalls === 1) return []; // the filter excludes the whole first chunk
          allowedId = q.bindings.find((b) => typeof b === 'string' && /^(b|r)\d+$|^stompf/.test(b));
          return allowedId ? [{ id: allowedId }] : [];
        }
        return [{ id: allowedId || 'b00001', first_name: 'Richard', last_name: 'Allowed' }];
      };
      const result = await executeTool('query_customers', { search: 'richard', filters: { active: true } });
      expect(allowCalls).toBeGreaterThanOrEqual(2);
      expect(allowedId).toBeTruthy();
      expect(JSON.stringify(result)).toContain(allowedId);
    });

    test('a recent text counts only when it went out (canceled and held rows hidden)', async () => {
      mockBook();
      await executeTool('query_customers', { search: 'richard dump' });
      const sms = db.__queries.find((q) => q.sql.includes('from "sms_log"'));
      expect(sms.sql).toMatch(/NOT \(/);
      expect(sms.sql).toMatch(/"direction" = \$\d+/);
      expect(sms.bindings).toEqual(expect.arrayContaining(['inbound', 'sent', 'delivered']));
      expect(sms.bindings).not.toContain('scheduled');
    });

    test('a scoped task never uses the cache', async () => {
      mockBook();
      await executeTool('query_customers', { search: 'richard dump' }, { readCustomerIds: ['scoped-1'] });
      await executeTool('query_customers', { search: 'richard dump' }, { readCustomerIds: ['scoped-1'] });
      expect(candidateReads()).toBe(2);
      await executeTool('query_customers', { search: 'richard dump' }, { readCustomerIds: ['scoped-2'] });
      expect(candidateReads()).toBe(3);
    });

    test('context reads cover only the survivors; a sole survivor still gets them (context lowers the floor)', async () => {
      mockBook();
      await executeTool('query_customers', { search: 'richard dump' });
      const visit = db.__queries.find((q) => q.sql.includes('from "scheduled_services"'));
      expect(visit.sql).toContain('"customer_id" in');
      expect(visit.bindings).toContain('stompf-r');
      expect(visit.bindings).not.toContain('b00003'); // an unrelated customer
      expect(visit.bindings.filter((b) => typeof b === 'string' && /^(b|r)\d+$/.test(b)).length).toBeLessThanOrEqual(MAX_SURVIVORS);

      resetNameIndexCache();
      db.__queries = [];
      db.__rows = (q) => {
        if (q.sql.includes('count(*)')) return [{ count: '1' }];
        if (!q.sql.includes('"customers"."email"')) return [named('only', 'Richard', 'Stompf'), named('other', 'Zed', 'Quill')];
        return [{ id: 'only', first_name: 'Richard', last_name: 'Stompf' }];
      };
      await executeTool('query_customers', { search: 'richard stompf' });
      const reads = db.__queries.filter((q) => /from "(scheduled_services|sms_log|call_log)"/.test(q.sql));
      expect(reads.length).toBeGreaterThan(0);
      for (const q of reads) expect(q.bindings).not.toContain('other');
    });
  });
});

describe('name match v2: review round 5', () => {
  const prev = process.env.GATE_NAME_MATCH_V2;
  beforeEach(() => { process.env.GATE_NAME_MATCH_V2 = 'true'; resetNameIndexCache(); db.__queries = []; db.__rows = () => []; });
  afterAll(() => { if (prev === undefined) delete process.env.GATE_NAME_MATCH_V2; else process.env.GATE_NAME_MATCH_V2 = prev; });
  const book = [named('dumas', 'Richard', 'Dumas'), named('stompf', 'Richard', 'Stompf'), named('quill', 'Zed', 'Quill')];
  const row = (id, first, last) => ({ id, first_name: first, last_name: last, active: true });

  test('several exact hits keep the same rows, ordered by name fit and context', async () => {
    db.__rows = (q) => {
      if (q.sql.includes('from "scheduled_services"')) return [{ customer_id: 'stompf' }];
      if (/from "(sms_log|call_log)"/.test(q.sql)) return [];
      if (q.sql.includes('count(*)')) return [{ count: '2' }];
      return [row('dumas', 'Richard', 'Dumas'), row('stompf', 'Richard', 'Stompf')];
    };
    const ordered = await executeTool('query_customers', { search: 'richard dump' });
    expect(ordered.customers.map((c) => c.id)).toEqual(['stompf', 'dumas']);
    expect(ordered.customers[0].match).toEqual({ score: 1, reasons: ['visit_soon'] });
    expect(ordered).toMatchObject({ total_matching: 2, returned_count: 2 });
    expect(ordered.note).toMatch(/offer_choices/);
    // An explicit sort keeps its order; the set never changes.
    const sorted = await executeTool('query_customers', { search: 'richard dump', sort_by: 'name' });
    expect(sorted.customers.map((c) => c.id)).toEqual(['dumas', 'stompf']);
    expect(sorted.customers[1].match.reasons).toEqual(['visit_soon']);
    // Gate off: the old result, untouched.
    delete process.env.GATE_NAME_MATCH_V2;
    const off = await executeTool('query_customers', { search: 'richard dump' });
    expect(off.customers.map((c) => c.id)).toEqual(['dumas', 'stompf']);
    expect(off.customers[0].match).toBeUndefined();
    expect(off.note).toBeUndefined();
  });

  test('the call bonus counts only calls that reached someone', async () => {
    db.__rows = (q) => (q.sql.includes('count(*)') ? [{ count: '2' }] : [row('dumas', 'Richard', 'Dumas'), row('stompf', 'Richard', 'Stompf')]);
    await executeTool('query_customers', { search: 'richard dump' });
    const calls = db.__queries.find((q) => q.sql.includes('from "call_log"'));
    expect(calls.sql).toContain('"bridged_at" is not null'); // outbound: the customer leg was dialed
    expect(calls.sql).toMatch(/"answered_by" in/); // inbound: answered by a person or Sandy
    expect(calls.sql).toContain('"recording_sid" is not null');
    expect(calls.sql).toMatch(/"direction" = \$\d+/);
  });

  test('a customer renamed since the index was built is scored by the current name', async () => {
    const fetched = { renamed: row('stompf', 'Zed', 'Quill') }; // now someone else
    db.__rows = (q) => {
      if (/from "(scheduled_services|sms_log|call_log)"/.test(q.sql)) return [];
      if (q.sql.includes('count(*)')) return [{ count: '1' }];
      if (q.sql.startsWith('select "customers"."id" from "customers"')) return book.map((b) => ({ id: b.id }));
      if (q.sql.includes('"customers"."company_name"') && !q.sql.includes('"customers"."email"')) return book; // cached index: old names
      if (q.sql.includes('"customers"."id" in')) return [fetched.renamed, row('dumas', 'Richard', 'Dumas')].filter((r) => q.bindings.includes(r.id));
      return [row('dumas', 'Richard', 'Dumas')];
    };
    const result = await executeTool('query_customers', { search: 'richard dump' });
    expect(result.alternatives).toBeUndefined(); // the renamed row no longer qualifies
    // Still qualifying after a rename: shown with its current score.
    fetched.renamed = row('stompf', 'Richard', 'Stompf');
    resetNameIndexCache();
    const kept = await executeTool('query_customers', { search: 'richard dump' });
    expect(kept.alternatives[0]).toMatchObject({ id: 'stompf', match: { score: 0.9 } });
  });

  test('creating or updating a customer drops the cached name index', async () => {
    db.__rows = (q) => {
      if (/from "(scheduled_services|sms_log|call_log)"/.test(q.sql)) return [];
      if (q.sql.includes('count(*)')) return [{ count: '1' }];
      if (q.sql.includes('"customers"."company_name"') && !q.sql.includes('"customers"."email"')) return book;
      return [row('dumas', 'Richard', 'Dumas')];
    };
    const reads = () => db.__queries.filter((q) => q.sql.includes('"customers"."company_name"') && !q.sql.includes('"customers"."email"')).length;
    await executeTool('query_customers', { search: 'richard dump' });
    await executeTool('query_customers', { search: 'richard dump' });
    expect(reads()).toBe(1);
    await executeTool('update_customer', { customer_id: 'dumas', updates: { first_name: 'Rick' } }); // the write's own result does not matter
    await executeTool('query_customers', { search: 'richard dump' });
    expect(reads()).toBe(2);
    await executeTool('create_customer', { first_name: 'Pat' });
    await executeTool('query_customers', { search: 'richard dump' });
    expect(reads()).toBe(3);
  });
});

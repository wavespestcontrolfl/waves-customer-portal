const protectedPages = require('../services/content/protected-pages');
const knex = require('knex')({ client: 'pg' });

describe('protected-pages pattern layer', () => {
  test('pest-control city hub is a protected money page', () => {
    const r = protectedPages.isProtectedByPattern('/pest-control-sarasota-fl/');
    expect(r.protected).toBe(true);
    expect(r.reason).toBe('money_page');
    expect(r.source).toBe('pattern');
  });

  test('pest-control quote page is protected', () => {
    expect(protectedPages.isProtectedByPattern('/pest-control-quote-venice-fl/').protected).toBe(true);
  });

  test('handles full URLs, query strings, and missing slashes', () => {
    expect(protectedPages.isProtectedByPattern('https://www.wavespestcontrol.com/pest-control-bradenton-fl/?utm=x').protected).toBe(true);
    expect(protectedPages.isProtectedByPattern('pest-control-parrish-fl').protected).toBe(true);
  });

  test('service spokes are NOT money pages', () => {
    expect(protectedPages.isProtectedByPattern('/termite-control-sarasota-fl/').protected).toBe(false);
    expect(protectedPages.isProtectedByPattern('/lawn-care-venice-fl/').protected).toBe(false);
    expect(protectedPages.isProtectedByPattern('/blog/ghost-ants/').protected).toBe(false);
  });

  test('normalizePath strips host/query/slashes and lowercases', () => {
    expect(protectedPages.normalizePath('https://x.com/Pest-Control-Sarasota-FL/?a=1#h')).toBe('pest-control-sarasota-fl');
  });
});

describe('protected-pages registry layer', () => {
  test('isProtected returns pattern hit without touching db', async () => {
    let dbCalled = false;
    const db = () => { dbCalled = true; return {}; };
    const r = await protectedPages.isProtected('/pest-control-sarasota-fl/', { db });
    expect(r.protected).toBe(true);
    expect(dbCalled).toBe(false); // pattern short-circuits before db
  });

  test('isProtected consults the registry for non-pattern URLs', async () => {
    const row = { reason: 'high_traffic', notes: '6000 impressions' };
    const db = () => ({ whereRaw: () => ({ first: async () => row }) });
    const r = await protectedPages.isProtected('/rodent-control-sarasota-fl/', { db });
    expect(r.protected).toBe(true);
    expect(r.reason).toBe('high_traffic');
    expect(r.source).toBe('registry');
  });

  test('isProtected returns not-protected when neither pattern nor registry match', async () => {
    const db = () => ({ whereRaw: () => ({ first: async () => null }) });
    const r = await protectedPages.isProtected('/some-blog-post/', { db });
    expect(r.protected).toBe(false);
  });

  test('registry read error fails CLOSED (protect rather than expose)', async () => {
    const db = () => ({ whereRaw: () => ({ first: async () => { throw new Error('db down'); } }) });
    const r = await protectedPages.isProtected('/rodent-control-sarasota-fl/', { db });
    expect(r.protected).toBe(true);
    expect(r.reason).toBe('protected_check_error');
  });

  // Regression: a literal `?` in the whereRaw regex (`https?`) was parsed by
  // knex as a 2nd positional bind placeholder, so the real query threw
  // "Expected 1 bindings, saw 2" and fail-closed every non-pattern URL as
  // protected_check_error. The prior mocks never exercised the SQL/bindings;
  // this builds the query with a REAL knex(pg) builder so a mismatch throws.
  test('registry query is built with valid placeholder/binding parity (real knex)', async () => {
    let built = null;
    const db = (table) => ({
      whereRaw: (sql, bindings) => {
        built = knex(table).whereRaw(sql, bindings).toString(); // throws on binding mismatch
        return { first: async () => null };
      },
    });
    const r = await protectedPages.isProtected('/lawn-care-sarasota-fl/', { db });
    expect(r).toEqual({ protected: false }); // built cleanly → not the fail-closed error path
    expect(built).toContain('https{0,1}'); // fixed regex, no literal ?
    expect(built).toContain("LOWER('lawn-care-sarasota-fl')"); // the one real binding
  });
});

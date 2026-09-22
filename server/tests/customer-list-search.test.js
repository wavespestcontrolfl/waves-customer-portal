const knex = require('knex');
const {
  applyCustomerNameOrder,
  applyCustomerSearchFilter,
  applyStableCustomerOrder,
  compactNameSearch,
  customerSearchTerms,
  escapeLikePattern,
  normalizedNameSearch,
} = require('../services/customer-list-search');

const pg = knex({ client: 'pg' });

afterAll(async () => {
  await pg.destroy();
});

describe('customer list search', () => {
  test('tokenizes Unicode names and normalizes name punctuation without stripping accents', () => {
    expect(customerSearchTerms("  Jos\u00e9   D'Angelo-Smith  ")).toEqual([
      'Jos\u00e9',
      'D',
      'Angelo',
      'Smith',
    ]);
    expect(normalizedNameSearch("  Jos\u00e9   D'Angelo-Smith  ")).toBe('jos\u00e9 d angelo smith');
    expect(compactNameSearch("  Jos\u00e9   D'Angelo-Smith  ")).toBe('jos\u00e9dangelosmith');
  });

  test('escapes every LIKE metacharacter', () => {
    expect(escapeLikePattern('50%_off\\today')).toBe('50\\%\\_off\\\\today');
  });

  test('keeps broad customer fields and binds escaped search inputs', () => {
    const input = "O'Neill_100%";
    const compiled = applyCustomerSearchFilter(pg('customers'), input).toSQL();
    const sql = compiled.sql.toLowerCase();

    expect(sql).toContain("customers.company_name::text");
    expect(sql).toContain("customers.address_line1::text");
    expect(sql).toContain("customers.email::text");
    expect(sql).toContain("customers.account_id::text");
    expect(sql).toContain("escape '\\'");
    expect(compiled.sql).not.toContain(input);
    expect(compiled.bindings).toContain("%O'Neill\\_100\\%%");
    expect(compiled.bindings).toContain('%oneill100%');
  });

  test('requires every phrase token in the combined customer row', () => {
    const compiled = applyCustomerSearchFilter(
      pg('customers'),
      '14208 Sundial Pl, Lakewood Ranch FL',
    ).toSQL();

    for (const token of ['%14208%', '%Sundial%', '%Pl%', '%Lakewood%', '%Ranch%', '%FL%']) {
      expect(compiled.bindings).toContain(token);
    }
  });

  test('keeps punctuation-insensitive phone matching', () => {
    const compiled = applyCustomerSearchFilter(pg('customers'), '(941) 555-0100').toSQL();

    expect(compiled.sql).toContain("regexp_replace(COALESCE(customers.phone, ''), '[^0-9]', '', 'g')");
    expect(compiled.bindings).toContain('%9415550100%');
  });

  test('ranks exact full and reversed names before surname, first name, prefixes, and broad matches', () => {
    const compiled = applyCustomerNameOrder(pg('customers'), "O'Neill Jos\u00e9").toSQL();
    const sql = compiled.sql.toLowerCase();
    const caseStart = sql.indexOf('case');
    const exactFull = sql.indexOf('then 0', caseStart);
    const exactSurname = sql.indexOf('then 1', exactFull);
    const exactFirst = sql.indexOf('then 2', exactSurname);
    const prefixFull = sql.indexOf('then 3', exactFirst);
    const broadName = sql.indexOf('then 6', prefixFull);

    expect(exactFull).toBeGreaterThan(caseStart);
    expect(exactSurname).toBeGreaterThan(exactFull);
    expect(exactFirst).toBeGreaterThan(exactSurname);
    expect(prefixFull).toBeGreaterThan(exactFirst);
    expect(broadName).toBeGreaterThan(prefixFull);
    expect(compiled.bindings.slice(0, 4)).toEqual(Array(4).fill('oneilljos\u00e9'));
    expect(compiled.bindings.slice(4, 8)).toEqual(Array(4).fill('oneilljos\u00e9%'));
    expect(compiled.bindings.slice(8, 10)).toEqual(Array(2).fill('%oneilljos\u00e9%'));
    expect(sql).toContain('"customers"."id" asc');
  });

  test('keeps descending name direction while using id as a deterministic tie', () => {
    const compiled = applyCustomerNameOrder(pg('customers'), '', 'desc').toSQL();
    const sql = compiled.sql.toLowerCase();

    expect(sql).not.toContain('case');
    expect(sql).toContain("lower(nullif(btrim(customers.first_name), '')) desc nulls last");
    expect(sql).toContain("lower(nullif(btrim(customers.last_name), '')) desc nulls last");
    expect(sql).toContain('"customers"."id" asc');
  });

  test('adds stable name and id ties after an explicit non-name sort', () => {
    const query = pg('customers').orderBy('lead_score', 'desc');
    const compiled = applyStableCustomerOrder(query).toSQL();
    const sql = compiled.sql.toLowerCase();

    expect(sql).toContain('order by "lead_score" desc');
    expect(sql).toContain("lower(nullif(btrim(customers.first_name), '')) asc nulls last");
    expect(sql).toContain('"customers"."id" asc');
  });
});

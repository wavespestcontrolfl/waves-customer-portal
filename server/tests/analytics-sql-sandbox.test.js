const { validateAnalyticsSql, SqlGuardError } = require('../services/analytics-sql-sandbox');

describe('analytics-sql-sandbox validateAnalyticsSql', () => {
  const ok = (sql) => expect(() => validateAnalyticsSql(sql)).not.toThrow();
  const bad = (sql) => expect(() => validateAnalyticsSql(sql)).toThrow(SqlGuardError);

  test('accepts simple allowlisted SELECTs', () => {
    ok('SELECT count(*) FROM customers');
    ok("SELECT to_char(member_since,'YYYY-MM') m, count(*) c FROM customers GROUP BY 1 ORDER BY 1");
    ok('SELECT l.id FROM leads l JOIN lead_sources s ON s.id = l.lead_source_id');
    ok('SELECT * FROM (SELECT revenue FROM service_records) q'); // subquery FROM allowlisted
  });

  test('strips a trailing semicolon but rejects mid-statement ones', () => {
    expect(validateAnalyticsSql('SELECT 1 FROM customers;')).toBe('SELECT 1 FROM customers');
    bad('SELECT 1 FROM customers; DROP TABLE customers');
    bad('SELECT 1 FROM customers; SELECT 2 FROM leads');
  });

  test('rejects non-SELECT / write / DDL leading statements', () => {
    bad('UPDATE customers SET active=false');
    bad('DELETE FROM customers');
    bad('INSERT INTO leads (id) VALUES (1)');
    bad('DROP TABLE customers');
    bad('WITH x AS (SELECT 1) SELECT * FROM x'); // CTEs disallowed in v1
  });

  test('rejects comments and dollar-quoting (injection vectors)', () => {
    bad('SELECT 1 FROM customers -- comment');
    bad('SELECT 1 /* c */ FROM customers');
    bad("SELECT $$x$$ FROM customers");
  });

  test('rejects catalog / system / file access', () => {
    bad('SELECT * FROM pg_catalog.pg_tables');
    bad('SELECT * FROM information_schema.columns');
    bad('SELECT pg_sleep(10) FROM customers');
    bad('SELECT current_setting(\'jwt.secret\') FROM customers');
    bad('SELECT pg_read_file(\'/etc/passwd\') FROM customers');
  });

  test('rejects non-allowlisted and sensitive tables/columns', () => {
    bad('SELECT * FROM technicians');          // not allowlisted (holds auth)
    bad('SELECT * FROM users');                // not allowlisted
    bad('SELECT password FROM customers');     // sensitive column name
    bad('SELECT api_key FROM customers');
    bad('SELECT stripe_secret FROM payments');
    bad('SELECT 1 FROM secret_tokens');
  });

  test('requires at least one readable table', () => {
    bad('SELECT 1');
    bad('SELECT now()');
  });
});

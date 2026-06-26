const { validateAnalyticsSql, SqlGuardError } = require('../services/analytics-sql-sandbox');

// NOTE: table/column scoping (only safe columns of analytics tables are
// readable) is enforced at run time by the `aichart_readonly` DB role inside
// runReadOnlyAnalyticsQuery — Postgres denies everything else regardless of SQL
// shape. That can't be unit-tested without a DB and is verified against prod
// (the role probe: ungranted column / SELECT * / other table / query_to_xml all
// → "permission denied"). These tests cover the static, pure defense-in-depth
// layer (structural + catalog/exec-function rejects).
describe('analytics-sql-sandbox validateAnalyticsSql (static defense-in-depth)', () => {
  const ok = (sql) => expect(() => validateAnalyticsSql(sql)).not.toThrow();
  const bad = (sql) => expect(() => validateAnalyticsSql(sql)).toThrow(SqlGuardError);

  test('accepts single SELECTs that read from a table', () => {
    ok('SELECT count(*) FROM customers');
    ok("SELECT to_char(member_since,'YYYY-MM') m, count(*) c FROM customers GROUP BY 1 ORDER BY 1");
    ok('SELECT l.id FROM leads l JOIN lead_sources s ON s.id = l.lead_source_id');
    ok('SELECT * FROM (SELECT revenue FROM service_records) q');
  });

  test('strips a trailing semicolon but rejects mid-statement ones', () => {
    expect(validateAnalyticsSql('SELECT 1 FROM customers;')).toBe('SELECT 1 FROM customers');
    bad('SELECT 1 FROM customers; DROP TABLE customers');
    bad('SELECT 1 FROM customers; SELECT 2 FROM leads');
  });

  test('rejects non-SELECT / write / DDL leading forms', () => {
    bad('UPDATE customers SET active=false');
    bad('DELETE FROM customers');
    bad('INSERT INTO leads (id) VALUES (1)');
    bad('DROP TABLE customers');
  });

  test('allows a read-only WITH/CTE (role + READ ONLY tx enforce safety, not this prefix)', () => {
    ok('WITH x AS (SELECT 1 AS n FROM customers) SELECT n FROM x');
    // a write inside a CTE still passes the STATIC check (the role / read-only
    // transaction reject it at run time) — but a chained statement does not:
    bad('WITH x AS (SELECT 1 FROM customers) SELECT 1; DROP TABLE customers');
  });

  test('rejects comments and dollar-quoting (injection vectors)', () => {
    bad('SELECT 1 FROM customers -- comment');
    bad('SELECT 1 /* c */ FROM customers');
    bad('SELECT $$x$$ FROM customers');
    bad('SELECT $tag$x$tag$ FROM customers');
  });

  test('rejects catalog / system / SQL-executing functions', () => {
    bad('SELECT * FROM pg_catalog.pg_tables');
    bad('SELECT * FROM information_schema.columns');
    bad('SELECT pg_sleep(10) FROM customers');
    bad("SELECT current_setting('jwt.secret') FROM customers");
    bad("SELECT pg_read_file('/etc/passwd') FROM customers");
    bad("SELECT query_to_xml('SELECT 1 FROM technicians', false, true, '') FROM customers");
    bad("SELECT table_to_xml('technicians', false, true, '') FROM customers");
    bad('SELECT dblink_connect($1) FROM customers');
  });

  test('requires a FROM clause', () => {
    bad('SELECT 1');
    bad('SELECT now()');
  });
});

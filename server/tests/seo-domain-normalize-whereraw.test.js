/**
 * Regression: the signup/citation lane normalizes a stored `target_domain` (strip
 * scheme + leading www) inside a knex `whereRaw` to compare hosts. The optional
 * scheme MUST be written `https{0,1}`, NOT `https?` — knex parses a literal `?`
 * inside a whereRaw as a positional binding placeholder, so `https?` plus the real
 * `= ?` looks like two placeholders for one value and throws at compile time
 * ("Expected 1 bindings, saw 2"). This path is only hit on a live domain-allowlisted
 * claim / placement de-dupe / verifier reconcile, so it slipped past the DB-mocked
 * unit tests and only surfaced on the first real supervised run.
 */
const fs = require('fs');
const path = require('path');
const knex = require('knex')({ client: 'pg' });

const NORMALIZED_DOMAIN_SQL = "lower(regexp_replace(regexp_replace(target_domain, '^https{0,1}://', ''), '^www\\.', ''))";

describe('seo target_domain normalization whereRaw', () => {
  test('corrected fragment compiles to exactly one binding', () => {
    let compiled;
    expect(() => {
      compiled = knex('seo_link_prospects').whereRaw(`${NORMALIZED_DOMAIN_SQL} = ?`, ['example.com']).toSQL();
    }).not.toThrow();
    expect(compiled.bindings).toEqual(['example.com']);
    // The scheme strip must survive into the SQL (still strips http:// and https://).
    expect(compiled.sql).toContain('https{0,1}');
  });

  test('the old https? form is the footgun — knex miscounts bindings', () => {
    const buggy = "lower(regexp_replace(regexp_replace(target_domain, '^https?://', ''), '^www\\.', '')) = ?";
    expect(() => knex('seo_link_prospects').whereRaw(buggy, ['example.com']).toSQL())
      .toThrow(/Expected 1 bindings, saw 2/);
  });

  test('no SEO service file reintroduces the https? whereRaw pattern', () => {
    const files = ['link-prospect-worker.js', 'signup-runner.js', 'link-prospect-verifier.js'];
    for (const f of files) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'seo', f), 'utf8');
      expect(src).not.toContain("'^https?://'");
    }
  });
});

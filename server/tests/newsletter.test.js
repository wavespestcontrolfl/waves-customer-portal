/**
 * Newsletter unit tests — pure-function regression coverage for the
 * highest-blast-radius helpers. No DB access (Knex .toSQL() inspects
 * generated SQL without executing). No SendGrid calls.
 *
 * Scope:
 *   - buildSubscriberQuery: encodes the segment-filter contract that
 *     Compose's audience picker depends on. A regression here silently
 *     mails the wrong audience.
 *   - EMAIL_RE / escapeHtml from public-newsletter: defenses for the
 *     stored-XSS class of bug fixed in PR §2.1.
 */

const { buildSubscriberQuery } = require('../services/newsletter-sender');
const publicRouter = require('../routes/public-newsletter');
const { EMAIL_RE, escapeHtml } = publicRouter;

describe('newsletter buildSubscriberQuery', () => {
  // Knex .toSQL() returns { sql, bindings } from the query builder
  // without opening a DB connection — perfect for shape assertions.
  const shapeOf = (filter) => buildSubscriberQuery(filter).toSQL();

  test('null filter targets every active subscriber', () => {
    const { sql, bindings } = shapeOf(null);
    expect(sql).toMatch(/from "newsletter_subscribers"/);
    expect(sql).toMatch(/"status" = \$1/);
    expect(bindings).toContain('active');
    expect(sql).not.toMatch(/customer_id/);
    expect(sql).not.toMatch(/source/);
    expect(sql).not.toMatch(/tags/);
  });

  test('customersOnly adds customer_id IS NOT NULL', () => {
    const { sql } = shapeOf({ customersOnly: true });
    expect(sql).toMatch(/"customer_id" is not null/);
    expect(sql).not.toMatch(/"customer_id" is null/);
  });

  test('leadsOnly adds customer_id IS NULL', () => {
    const { sql } = shapeOf({ leadsOnly: true });
    expect(sql).toMatch(/"customer_id" is null/);
  });

  test('sources filter binds each value via whereIn', () => {
    const { sql, bindings } = shapeOf({ sources: ['website', 'quote_wizard'] });
    expect(sql).toMatch(/"source" in \(\$\d+, \$\d+\)/);
    expect(bindings).toEqual(expect.arrayContaining(['website', 'quote_wizard']));
  });

  test('empty sources array is a no-op (no whereIn injected)', () => {
    const { sql } = shapeOf({ sources: [] });
    expect(sql).not.toMatch(/"source" in/);
  });

  test('tags filter uses jsonb ?| operator with N bindings', () => {
    const { sql, bindings } = shapeOf({ tags: ['platinum-tier', 'hurricane-prep'] });
    // Knex emits the raw fragment we passed; verify both bindings made it
    // through and the ?| operator is present (escaped as ?\| by some
    // parameter parsers — accept either rendering).
    expect(sql).toMatch(/tags \?\|? array\[\?,\?\]/);
    expect(bindings).toEqual(expect.arrayContaining(['platinum-tier', 'hurricane-prep']));
  });

  test('combined filters compose all clauses', () => {
    const { sql, bindings } = shapeOf({
      customersOnly: true,
      tags: ['vip'],
      sources: ['admin_manual'],
    });
    expect(sql).toMatch(/"status" = \$1/);
    expect(sql).toMatch(/"customer_id" is not null/);
    expect(sql).toMatch(/"source" in/);
    expect(sql).toMatch(/tags \?\|? array/);
    expect(bindings).toEqual(expect.arrayContaining(['active', 'admin_manual', 'vip']));
  });

  test('customersOnly + leadsOnly is a contradiction the query expresses verbatim', () => {
    // The route doesn't reject this — the audit recommended adding a
    // 0-recipient guard at send time (§3.10) and that's where the empty
    // result is caught. The query itself is still well-formed.
    const { sql } = shapeOf({ customersOnly: true, leadsOnly: true });
    expect(sql).toMatch(/"customer_id" is not null/);
    expect(sql).toMatch(/"customer_id" is null/);
  });
});

describe('newsletter EMAIL_RE', () => {
  const ok = ['a@b.co', 'first.last@example.com', 'with+tag@gmail.com', 'h@host.io'];
  const bad = [
    '',
    'no-at-sign',
    '@nolocal.com',
    'noTld@host',
    'with space@host.com',
    'two@@host.com',
    'trailing.dot@host.',
  ];

  test.each(ok)('accepts %s', (e) => {
    expect(EMAIL_RE.test(e)).toBe(true);
  });

  test.each(bad)('rejects %s', (e) => {
    expect(EMAIL_RE.test(e)).toBe(false);
  });
});

describe('newsletter escapeHtml', () => {
  test('escapes the five HTML metacharacters', () => {
    expect(escapeHtml('<img onerror="x">')).toBe('&lt;img onerror=&quot;x&quot;&gt;');
    expect(escapeHtml("it's & <them>")).toBe('it&#39;s &amp; &lt;them&gt;');
  });

  test('returns empty string for null/undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  test('passes through plain ascii unchanged', () => {
    expect(escapeHtml('foo@bar.co')).toBe('foo@bar.co');
  });

  test('coerces non-strings before escaping', () => {
    expect(escapeHtml(123)).toBe('123');
  });
});

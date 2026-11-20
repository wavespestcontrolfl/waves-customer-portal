/**
 * buildSubscriberQuery's subscriber_ids key (services/newsletter-sender.js): an exact list of
 * newsletter_subscribers ids, which a Waves Pest Insider issue uses for its audience
 * (services/pest-insider/audience.js). Shape only: knex toSQL, no database connection.
 */
const { buildSubscriberQuery } = require('../services/newsletter-sender');
const { warmAudienceQuery } = require('../services/pest-insider/audience');

const shapeOf = (filter) => buildSubscriberQuery(filter).toSQL();
const P = '(?:\\$\\d+|\\?)';

describe('subscriber_ids', () => {
  test('a usable list narrows to exactly those ids, as one array binding', () => {
    const { sql, bindings } = shapeOf({ subscriber_ids: [3, 1, 2] });
    expect(sql).toMatch(new RegExp(`newsletter_subscribers\\.id = ANY\\(${P}::int\\[\\]\\)`));
    expect(bindings).toContainEqual([3, 1, 2]);
    expect(sql).not.toMatch(/1 = 0/);
  });

  test.each([
    ['an empty list', []],
    ['a string', '1,2'],
    ['an object', { 0: 1 }],
    ['a number', 7],
    ['a non-integer element', [1, 2.5]],
    ['a zero', [0]],
    ['a negative id', [-4]],
    ['a numeric-string element', [1, '2']],
    ['a null element', [1, null]],
    ['an unsafe integer', [Number.MAX_SAFE_INTEGER + 1]],
    ['an id past the Postgres integer range', [1, 2147483648]],
  ])('%s fails closed', (_label, value) => {
    const { sql } = shapeOf({ subscriber_ids: value });
    expect(sql).toMatch(/1 = 0/);
    expect(sql).not.toMatch(/ANY\(/);
  });

  test('the largest Postgres integer is still a usable id', () => {
    const { sql, bindings } = shapeOf({ subscriber_ids: [2147483647] });
    expect(sql).toMatch(/ANY\(/);
    expect(bindings).toContainEqual([2147483647]);
  });

  test('the Pest Insider holdout name keeps the list query; the dispatch re-check applies it', () => {
    const plain = shapeOf({ subscriber_ids: [3, 1] });
    const named = shapeOf({ subscriber_ids: [3, 1], holdout: 'pest-insider' });
    expect(named.sql).toBe(plain.sql);
    expect(named.bindings).toEqual(plain.bindings);
  });

  test.each([
    ['an unknown name', 'pest-insider-v2'],
    ['an inherited property name', 'toString'],
    ['a number', 5],
    ['an object', { name: 'pest-insider' }],
  ])('a holdout given as %s fails closed', (_label, holdout) => {
    const { sql } = shapeOf({ subscriber_ids: [3, 1], holdout });
    expect(sql).toMatch(/1 = 0/);
    expect(sql).not.toMatch(/ANY\(/);
  });

  test('absent or null keeps the old behavior', () => {
    for (const filter of [{}, { subscriber_ids: null }, { subscriber_ids: undefined }]) {
      const { sql } = shapeOf(filter);
      expect(sql).not.toMatch(/ANY\(/);
      expect(sql).not.toMatch(/1 = 0/);
    }
  });

  test('the list narrows the send path query and keeps every rule and key before it', () => {
    const base = shapeOf({ audience: 'customers' });
    const narrowed = shapeOf({ audience: 'customers', subscriber_ids: [5] });
    expect(narrowed.bindings.slice(0, base.bindings.length)).toEqual(base.bindings);
    expect(narrowed.bindings[narrowed.bindings.length - 1]).toEqual([5]);
    expect(narrowed.sql.startsWith(base.sql)).toBe(true);
    expect(narrowed.sql).toMatch(/"customer_id" is not null/);
  });
});

describe('warmAudienceQuery', () => {
  test('starts from the send path query and requires an opened Waves email or Waves newsletter between the cutoff and asOf', () => {
    const since = new Date('2026-09-03T12:00:00Z');
    const until = new Date('2026-12-02T12:00:00Z');
    const base = shapeOf(null);
    const { sql, bindings } = warmAudienceQuery({ since, until }).toSQL();
    expect(bindings.slice(0, base.bindings.length)).toEqual(base.bindings);
    expect(bindings.slice(-4)).toEqual([since, until, since, until]);
    // One group: either open counts, and the group is ANDed with every send-path rule before it.
    expect(sql).toContain(' and (exists (select 1 from "email_messages" as "opened" where lower(opened.recipient_email_snapshot) = lower(newsletter_subscribers.email)'
      + ' and "opened"."opened_at" >= ? and "opened"."opened_at" <= ?)'
      + ' or exists (select 1 from "newsletter_send_deliveries" as "nl_open" where (nl_open.subscriber_id = newsletter_subscribers.id or lower(nl_open.email) = lower(newsletter_subscribers.email))'
      + ' and "nl_open"."opened_at" >= ? and "nl_open"."opened_at" <= ?)) order by');
    // The send path query opens with its WITH clauses; the main select after them reads two columns.
    expect(sql).toContain(') select "newsletter_subscribers"."id", "newsletter_subscribers"."customer_id" from "newsletter_subscribers" where ');
    expect(sql).toMatch(/order by "newsletter_subscribers"\."id" asc$/);
  });
});

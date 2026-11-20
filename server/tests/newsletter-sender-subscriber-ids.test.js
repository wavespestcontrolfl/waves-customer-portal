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
    ['with no list', {}],
    ['with a null list', { subscriber_ids: null }],
  ])('a send that names the holdout %s matches nobody, never the whole list', (_label, filter) => {
    const { sql } = shapeOf({ ...filter, holdout: 'pest-insider' });
    expect(sql).toMatch(/1 = 0/);
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
  test('starts from the send path query and requires an open event on the current address between the cutoff and asOf', () => {
    const since = new Date('2026-09-03T12:00:00Z');
    const until = new Date('2026-12-02T12:00:00Z');
    const base = shapeOf(null);
    const { sql, bindings } = warmAudienceQuery({ since, until }).toSQL();
    expect(bindings.slice(0, base.bindings.length)).toEqual(base.bindings);
    expect(bindings.slice(-3)).toEqual(['open', since, until]);
    // One group, ANDed with every send-path rule before it, on the open's own time.
    expect(sql).toContain(' and (exists (select 1 from "sendgrid_webhook_events" as "opened" where "opened"."event_type" = ?'
      + ' and lower(opened.email) = lower(newsletter_subscribers.email)'
      + ' and coalesce(opened.occurred_at, opened.created_at) >= ? and coalesce(opened.occurred_at, opened.created_at) <= ?)) order by');
    // The address alone decides: a subscriber-id match would let a former address's open qualify a corrected one.
    expect(sql.slice(sql.indexOf(' and (exists (select 1 from "sendgrid_webhook_events"'))).not.toMatch(/subscriber_id/);
    // The send path query opens with its WITH clauses; the main select after them reads the reader's id,
    // customer link and address, and the customers behind its mailbox from the same read
    // (withMailboxCustomers: one grouped row per mailbox, joined once).
    expect(sql).toContain('"mailbox_customers" as materialized (select "linked"."mailbox_key" as "mc_mailbox_key",'
      + ' array_agg(DISTINCT linked.customer_id) AS mc_customer_ids from (');
    expect(sql).toContain('from "customers" where "deleted_at" is null and TRIM(COALESCE(email, \'\')) <> \'\') as "linked" group by "linked"."mailbox_key")');
    expect(sql).toContain(') select "newsletter_subscribers"."id", "newsletter_subscribers"."customer_id", "newsletter_subscribers"."email",'
      + ' COALESCE(mailbox_customers.mc_customer_ids, \'{}\') AS mailbox_customer_ids from "newsletter_subscribers"'
      + ' LEFT JOIN mailbox_customers ON mailbox_customers.mc_mailbox_key = (CASE WHEN SPLIT_PART(LOWER(TRIM(newsletter_subscribers.email)), \'@\', 2)');
    expect(sql).toMatch(/order by "newsletter_subscribers"\."id" asc$/);
  });
});

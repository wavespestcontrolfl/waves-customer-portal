/**
 * Send-time explicit marketing opt-out (owner ruling 2026-09-28, #5165) —
 * no DB access: the generated SQL shape (Knex .toSQL()) and a source
 * contract that EVERY audience read in newsletter-sender.js carries the
 * predicate. Behaviour (who is excluded, the resume skip) is proven against
 * real Postgres in newsletter-sender-marketing-optout-postgres.test.js.
 */
const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const { buildSubscriberQuery, excludeMarketingOptedOut, outstandingEligibleDeliveries } = require('../services/newsletter-sender');

describe('excludeMarketingOptedOut', () => {
  test('buildSubscriberQuery anti-joins explicit opt-outs on the linked customer or any live same-mailbox profile', () => {
    const { sql } = buildSubscriberQuery(null).toSQL();
    // The notification_prefs/customers join is pre-filtered to explicit
    // opt-out rows in its own MATERIALIZED CTE (codex #5165 EXPLAIN finding:
    // a plain/inlined derived table gets flattened back into a per-outer-row
    // rescan) — the outer query anti-joins against that small precomputed set.
    expect(sql).toMatch(/with "opted_out_profiles" as materialized \(select "moc"\."id" as "customer_id", "moc"\."email" as "email" from "notification_prefs" as "mop" inner join "customers" as "moc" on "moc"\."id" = "mop"\."customer_id" where "moc"\."deleted_at" is null/i);
    // Explicit opt-outs only: an equality on false / 'sms' is never true for NULL.
    expect(sql).toContain("mop.marketing_offers = false OR mop.email_enabled = false OR LOWER(TRIM(mop.marketing_channel)) = 'sms'");
    expect(sql).toMatch(/not exists \(select 1 from "opted_out_profiles" as "oo"/i);
    expect(sql).toContain('oo.customer_id = newsletter_subscribers.customer_id');
    expect(sql).toContain('LOWER(TRIM(oo.email)) = LOWER(TRIM(newsletter_subscribers.email))');
    // Google mailbox identity from customer-comms-lock.js GOOGLE_MAILBOX_SQL —
    // the non-empty guard now applies to BOTH sides of the mailbox match.
    expect(sql).toContain("SPLIT_PART(LOWER(TRIM(oo.email)), '@', 2) IN ('gmail.com', 'googlemail.com')");
    expect(sql).toContain("REPLACE(SPLIT_PART(SPLIT_PART(LOWER(TRIM(oo.email)), '@', 1), '+', 1), '.', '') <> ''");
    expect(sql).toContain("REPLACE(SPLIT_PART(SPLIT_PART(LOWER(TRIM(newsletter_subscribers.email)), '@', 1), '+', 1), '.', '') <> ''");
  });

  test('present with a segment filter too, and usable on a delivery-ledger join (resume precheck shape)', () => {
    expect(buildSubscriberQuery({ customersOnly: true }).toSQL().sql).toMatch(/"notification_prefs" as "mop"/);
    const { sql } = excludeMarketingOptedOut(
      db('newsletter_send_deliveries').join('newsletter_subscribers', 'newsletter_subscribers.id', 'newsletter_send_deliveries.subscriber_id'),
    ).toSQL();
    expect(sql).toMatch(/"notification_prefs" as "mop"/);
  });

  // #5187's outstandingEligibleDeliveries backs the resume precheck,
  // hasOutstandingDeliveries ("correctable"), and GET /sends' correlated
  // EXISTS — all must agree with what a resume would actually mail.
  test('outstandingEligibleDeliveries carries the predicate, including its correlated EXISTS form (GET /sends)', () => {
    expect(outstandingEligibleDeliveries('send-1').toSQL().sql).toMatch(/"notification_prefs" as "mop"/);
    const { sql } = db('newsletter_sends').select(db.raw('EXISTS (?) AS has_outstanding', [
      outstandingEligibleDeliveries('newsletter_sends.id', { correlate: true }).select(db.raw('1')),
    ])).toSQL();
    // A CTE is valid inside a subquery expression (Postgres) — the MATERIALIZED
    // opt-out set is still scoped to this one EXISTS(...), never shared globally.
    expect(sql).toMatch(/EXISTS \(\(with "opted_out_profiles" as materialized \(select .*"notification_prefs" as "mop".*oo\.customer_id = newsletter_subscribers\.customer_id/is);
  });

  // Every audience read (fresh selection, resume refetch, per-chunk
  // re-check, resume precheck — and any added later) goes through
  // excludeArchivedCustomers; each such call must be wrapped by the opt-out
  // predicate, or a resume could mail an opted-out person.
  test('every excludeArchivedCustomers call in the sender is wrapped by excludeMarketingOptedOut', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/newsletter-sender.js'), 'utf8');
    const calls = [...src.matchAll(/excludeArchivedCustomers\(/g)].map((m) => m.index)
      .filter((i) => !src.slice(Math.max(0, i - 9), i).endsWith('function '));
    expect(calls.length).toBeGreaterThanOrEqual(4); // selection, refetch, chunk re-check, outstandingEligibleDeliveries
    for (const i of calls) {
      expect(src.slice(Math.max(0, i - 'excludeMarketingOptedOut('.length), i)).toBe('excludeMarketingOptedOut(');
    }
  });
});

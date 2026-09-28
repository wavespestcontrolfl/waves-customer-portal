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
const { buildSubscriberQuery, excludeMarketingOptedOut } = require('../services/newsletter-sender');

describe('excludeMarketingOptedOut', () => {
  test('buildSubscriberQuery anti-joins explicit opt-outs on the linked customer or any live same-mailbox profile', () => {
    const { sql } = buildSubscriberQuery(null).toSQL();
    expect(sql).toMatch(/not exists \(select 1 from "notification_prefs" as "mop" inner join "customers" as "moc" on "moc"\."id" = "mop"\."customer_id" where "moc"\."deleted_at" is null/i);
    // Explicit opt-outs only: an equality on false / 'sms' is never true for NULL.
    expect(sql).toContain("mop.marketing_offers = false OR mop.email_enabled = false OR LOWER(TRIM(mop.marketing_channel)) = 'sms'");
    expect(sql).toContain('moc.id = newsletter_subscribers.customer_id');
    expect(sql).toContain('LOWER(TRIM(moc.email)) = LOWER(TRIM(newsletter_subscribers.email))');
    // Google mailbox identity from customer-comms-lock.js GOOGLE_MAILBOX_SQL.
    expect(sql).toContain("SPLIT_PART(LOWER(TRIM(moc.email)), '@', 2) IN ('gmail.com', 'googlemail.com')");
    expect(sql).toContain("REPLACE(SPLIT_PART(SPLIT_PART(LOWER(TRIM(newsletter_subscribers.email)), '@', 1), '+', 1), '.', '')");
  });

  test('present with a segment filter too, and usable on a delivery-ledger join (resume precheck shape)', () => {
    expect(buildSubscriberQuery({ customersOnly: true }).toSQL().sql).toMatch(/"notification_prefs" as "mop"/);
    const { sql } = excludeMarketingOptedOut(
      db('newsletter_send_deliveries').join('newsletter_subscribers', 'newsletter_subscribers.id', 'newsletter_send_deliveries.subscriber_id'),
    ).toSQL();
    expect(sql).toMatch(/"notification_prefs" as "mop"/);
  });

  // Every audience read (fresh selection, resume refetch, per-chunk
  // re-check, resume precheck — and any added later) goes through
  // excludeArchivedCustomers; each such call must be wrapped by the opt-out
  // predicate, or a resume could mail an opted-out person.
  test('every excludeArchivedCustomers call in the sender is wrapped by excludeMarketingOptedOut', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/newsletter-sender.js'), 'utf8');
    const calls = [...src.matchAll(/excludeArchivedCustomers\(/g)].map((m) => m.index)
      .filter((i) => !src.slice(Math.max(0, i - 9), i).endsWith('function '));
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const i of calls) {
      expect(src.slice(Math.max(0, i - 'excludeMarketingOptedOut('.length), i)).toBe('excludeMarketingOptedOut(');
    }
  });
});

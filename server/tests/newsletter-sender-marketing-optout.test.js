/**
 * Send-time mailbox mailability (owner rulings 2026-09-28 + 2026-09-29,
 * #5165) — no DB access: the generated SQL shape (Knex .toSQL()) and a
 * source contract that EVERY audience read in newsletter-sender.js carries
 * the predicate. Behaviour (who is excluded, the resume skip) is proven
 * against real Postgres in newsletter-sender-marketing-optout-postgres.test.js.
 *
 * Owner ruling 2026-09-29 (option A): per-writer mailbox locks were reverted
 * (they kept spreading into live paths and produced a genuine deadlock) in
 * favor of judging mailbox state at SEND TIME — excludeMailboxNotMailable
 * now carries BOTH the explicit-opt-out rule and a new rule: an active
 * subscriber is skipped when ANY OTHER newsletter_subscribers row for the
 * SAME MAILBOX has a status other than 'active'.
 */
const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const { buildSubscriberQuery, excludeMailboxNotMailable, outstandingEligibleDeliveries } = require('../services/newsletter-sender');

describe('excludeMailboxNotMailable', () => {
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

  // Owner ruling 2026-09-29 — the second half of the merged predicate: an
  // active subscriber is skipped when ANY OTHER row sharing its mailbox
  // (exact or Google alias) has a status other than 'active'. Pre-filtered
  // into its own MATERIALIZED CTE keyed on a single computed mailbox
  // identity (never an OR of exact-match-or-Google-alias), so Postgres can
  // plan the match as a real equi-join/hash anti-join instead of a per-row
  // rescan of the whole non-active tail (codex #5165 EXPLAIN finding).
  test('buildSubscriberQuery anti-joins any non-active same-mailbox sibling row, via a single computed mailbox-key equi-join', () => {
    const { sql } = buildSubscriberQuery(null).toSQL();
    expect(sql).toMatch(/"blocked_mailbox_siblings" as materialized \(select distinct \(case when/i);
    // status IS DISTINCT FROM 'active', never `<> 'active'` — a NULL status
    // (the column carries no NOT NULL) must also block, fail-closed.
    expect(sql).toContain("status IS DISTINCT FROM 'active'");
    expect(sql).toMatch(/from "newsletter_subscribers" where status is distinct from 'active'/i);
    // The mailbox-key CASE: a Google address collapses to its stripped
    // mailbox identity (never empty), everything else to its own
    // LOWER(TRIM) — computed identically on the CTE side and the outer
    // newsletter_subscribers.email side, so the two are a single equality.
    expect(sql).toContain("SPLIT_PART(LOWER(TRIM(email)), '@', 2) IN ('gmail.com', 'googlemail.com')");
    expect(sql).toContain("REPLACE(SPLIT_PART(SPLIT_PART(LOWER(TRIM(email)), '@', 1), '+', 1), '.', '') <> ''");
    expect(sql).toContain("|| '@gmail.com'");
    expect(sql).toMatch(/not exists \(select 1 from "blocked_mailbox_siblings" as "bm" where bm\.mailbox_key = \(case when/i);
    expect(sql).toContain('SPLIT_PART(LOWER(TRIM(newsletter_subscribers.email))');
  });

  test('present with a segment filter too, and usable on a delivery-ledger join (resume precheck shape)', () => {
    expect(buildSubscriberQuery({ customersOnly: true }).toSQL().sql).toMatch(/"notification_prefs" as "mop"/);
    const { sql } = excludeMailboxNotMailable(
      db('newsletter_send_deliveries').join('newsletter_subscribers', 'newsletter_subscribers.id', 'newsletter_send_deliveries.subscriber_id'),
    ).toSQL();
    expect(sql).toMatch(/"notification_prefs" as "mop"/);
    expect(sql).toMatch(/"blocked_mailbox_siblings" as materialized/i);
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
    expect(sql).toMatch(/"blocked_mailbox_siblings" as materialized/i);
  });

  // Every audience read (fresh selection, resume refetch, per-chunk
  // re-check, resume precheck — and any added later) goes through
  // excludeArchivedCustomers; each such call must be wrapped by the
  // mailbox-mailability predicate, or a resume could mail a
  // no-longer-mailable person.
  test('every excludeArchivedCustomers call in the sender is wrapped by excludeMailboxNotMailable', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/newsletter-sender.js'), 'utf8');
    const calls = [...src.matchAll(/excludeArchivedCustomers\(/g)].map((m) => m.index)
      .filter((i) => !src.slice(Math.max(0, i - 9), i).endsWith('function '))
      // The canonical-row CTE inside the predicate itself filters its pick
      // set with this helper (codex #5165 :235) — an input to the
      // predicate, not an audience read.
      .filter((i) => !src.slice(src.lastIndexOf('\nconst ', i), i).startsWith('\nconst CANONICAL_ACTIVE_MAILBOX_SQL'));
    expect(calls.length).toBeGreaterThanOrEqual(4); // selection, refetch, chunk re-check, outstandingEligibleDeliveries
    for (const i of calls) {
      expect(src.slice(Math.max(0, i - 'excludeMailboxNotMailable('.length), i)).toBe('excludeMailboxNotMailable(');
    }
  });

  // Codex #5165 (:160) — newsletter-sunset.js has no excludeArchivedCustomers
  // call to anchor on, so the contract is named-function-by-function: every
  // audience/cohort/denominator read that decides who gets flagged, counted
  // as awaiting a win-back, swept into sunset, or used as the valve's
  // active-list denominator must carry excludeMailboxNotMailable — a
  // non-mailable subscriber (opted out, or a same-mailbox sibling that's
  // unsubscribed/pending/inactive/waitlist) the sender already skips at
  // send time must never be flagged, counted as "awaiting", or drive the
  // valve fraction, or the job stages a win-back draft it can never
  // resolve (see the module's own comments on findFlagCandidates /
  // cohortAwaitingWinback for why).
  test('every sunset audience/cohort/denominator read in newsletter-sunset.js carries excludeMailboxNotMailable', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/newsletter-sunset.js'), 'utf8');
    const FUNCTIONS = ['findFlagCandidates', 'cohortAwaitingWinback', 'findSunsetCandidates', 'runNewsletterSunset'];
    for (const name of FUNCTIONS) {
      const start = src.indexOf(`async function ${name}(`);
      expect(start).toBeGreaterThanOrEqual(0); // the function still exists under this exact name
      const nextFn = src.slice(start + 1).search(/\n(async )?function /);
      const body = nextFn === -1 ? src.slice(start) : src.slice(start, start + 1 + nextFn);
      expect(body).toContain('excludeMailboxNotMailable(');
    }
  });
});

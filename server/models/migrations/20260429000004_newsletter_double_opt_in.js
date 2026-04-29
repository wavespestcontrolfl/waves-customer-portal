/**
 * Double-opt-in for newsletter signups.
 *
 * Prior to this migration, every public signup landed at status='active'
 * immediately — the email field was unverified and a hostile party could
 * sign up arbitrary addresses. Going forward, the public-form path
 * inserts at status='pending', sends a confirmation email with a
 * single-use token, and only flips to status='active' once the recipient
 * clicks through.
 *
 * Grandfathering: existing active subscribers are left alone. We backfill
 * confirmed_at = subscribed_at on every status='active' row so the
 * "confirmed" set stays accurate without re-prompting the entire list.
 *
 * Admin manual add and the quote-wizard dual-write skip the pending step
 * (admin-trusted + transactional context where the email is already in
 * use). Only the public website signup requires confirmation.
 *
 * Cron purge of unconfirmed pending rows lives in a follow-up — for now
 * pending rows accumulate harmlessly, never receive newsletter sends
 * (buildSubscriberQuery filters status='active'), and an operator can
 * resend a confirmation by retrying signup.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('newsletter_subscribers', (t) => {
    // gen_random_uuid() default + unique constraint mirrors
    // unsubscribe_token from 20260418000008 — every row gets a token,
    // including pre-existing active rows; harmless if unused.
    t.uuid('confirmation_token').defaultTo(knex.raw('gen_random_uuid()')).unique();
    t.timestamp('confirmation_sent_at');
    t.timestamp('confirmed_at');
  });

  // Backfill so we can answer "is this row confirmed?" with a column
  // lookup instead of an exception list. Existing rows are grandfathered
  // by virtue of having any confirmed_at value.
  await knex.raw(`
    UPDATE newsletter_subscribers
       SET confirmed_at = COALESCE(subscribed_at, NOW())
     WHERE status = 'active' AND confirmed_at IS NULL
  `);

  // Backfill tokens for rows the default missed (concurrent
  // alter+default race; same defensive pattern as 20260418000008's
  // unsubscribe_token backfill).
  await knex.raw(`
    UPDATE newsletter_subscribers
       SET confirmation_token = gen_random_uuid()
     WHERE confirmation_token IS NULL
  `);
};

exports.down = async function (knex) {
  await knex.schema.alterTable('newsletter_subscribers', (t) => {
    t.dropColumn('confirmation_token');
    t.dropColumn('confirmation_sent_at');
    t.dropColumn('confirmed_at');
  });
};

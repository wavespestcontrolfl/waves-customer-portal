/**
 * content_email_approvals — email-reply approval loop for parked autonomous
 * content runs (owner directive 2026-07-28: "I don't have time to approve
 * these things … send to my email and I can say approved or not approved").
 *
 * One row per parked run we emailed the owner about. The IMAP poller matches
 * reply subjects on `token`, verifies the sender allowlist, and executes the
 * decision through the SAME entrypoints the operator script uses
 * (approveAndPublishNamedCompetitor / trust-build stamp) — this table is the
 * audit trail and idempotency guard, never a second source of truth for run
 * state.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('content_email_approvals');
  if (has) return;
  await knex.schema.createTable('content_email_approvals', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // Short reply-matching token carried in the email subject ("EA-1a2b3c4d").
    t.string('token', 20).notNullable().unique();
    // One active approval request per run.
    t.uuid('run_id').notNullable().unique()
      .references('id').inTable('autonomous_runs').onDelete('CASCADE');
    t.uuid('opportunity_id')
      .references('id').inTable('opportunity_queue').onDelete('SET NULL');
    // The run's skip_reason at send time (named_competitor_review /
    // trust_build_<n>_of_<m>) — decides which approve path executes.
    t.string('kind', 60).notNullable();
    // awaiting_reply → executing → approved | rejected | superseded | failed
    // ('executing' is the crash-recoverable claim state; 'superseded' means
    // a newer run replaced the emailed one before the reply arrived).
    t.string('status', 20).notNullable().defaultTo('awaiting_reply');
    // The parsed reply decision, persisted at claim time so a crash during
    // execution can be recovered without re-reading the mailbox.
    t.string('decision', 10);
    // sha256 of the emailed draft snapshot (title|body|metadata) — an
    // approval binds to the CONTENT the owner read, not just the run id;
    // a payload edited after the email went out re-emails with a fresh
    // token instead of publishing unseen content.
    t.string('draft_sha', 64);
    // The truncation verdict of the email AS DELIVERED — decision-time
    // recomputation can diverge (opportunity.query mutates under reseeds),
    // so the verdict that gates emailed approval is the persisted one.
    t.boolean('email_truncated');
    // Send-claim timestamp (distinct from confirmed delivery): a crash
    // between claiming and SMTP completing leaves email_sending_at set with
    // email_sent_at null — reclaimable after a staleness window.
    t.timestamp('email_sending_at');
    t.timestamp('email_sent_at');
    t.text('decided_by'); // "email:<sender>" — audit, never trusted alone
    t.timestamp('decided_at');
    t.text('last_error');
    t.timestamps(true, true);
    t.index('status');
  });

  // Single-row IMAP cursor: the highest mailbox UID the poller has fully
  // handled. Advancing it past ambiguous/unauthorized replies is what makes
  // their admin notifications fire exactly once.
  const hasState = await knex.schema.hasTable('content_email_approval_state');
  if (!hasState) {
    await knex.schema.createTable('content_email_approval_state', (t) => {
      t.smallint('id').primary(); // always 1
      t.bigInteger('last_uid').notNullable().defaultTo(0);
      // IMAP UIDs are scoped to the mailbox's UIDVALIDITY — if the mailbox
      // is replaced/regenerated (or APPROVAL_IMAP_USER changes), the cursor
      // must reset or new replies would be skipped forever.
      t.bigInteger('uid_validity');
      t.string('mailbox_user', 255);
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('content_email_approval_state');
  await knex.schema.dropTableIfExists('content_email_approvals');
};

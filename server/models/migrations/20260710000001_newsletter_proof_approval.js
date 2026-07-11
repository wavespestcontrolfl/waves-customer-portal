/**
 * Newsletter proof-approval flow: the weekly autopilot draft is proofed to
 * the owner's inbox, and an email reply of "approved" releases the list
 * send. These columns track that lifecycle on newsletter_sends:
 *
 *   proof_token             — short random token embedded in the proof
 *                             email's subject ([PROOF-xxxxxxxx]); the reply
 *                             handler matches replies back to the send by it
 *   proof_sent_at           — when the proof email went out (idempotency
 *                             marker; catch-up cron re-runs must not re-proof)
 *   proof_approved_at       — when an allowlisted approval reply was accepted
 *                             (atomic claim column — set-once via whereNull)
 *   proof_approval_email_id — emails.id of the approving reply (audit trail)
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('newsletter_sends');
  if (!hasTable) return;

  if (!(await knex.schema.hasColumn('newsletter_sends', 'proof_token'))) {
    await knex.schema.alterTable('newsletter_sends', (t) => {
      t.text('proof_token');
    });
  }
  if (!(await knex.schema.hasColumn('newsletter_sends', 'proof_sent_at'))) {
    await knex.schema.alterTable('newsletter_sends', (t) => {
      t.timestamp('proof_sent_at', { useTz: true });
    });
  }
  if (!(await knex.schema.hasColumn('newsletter_sends', 'proof_approved_at'))) {
    await knex.schema.alterTable('newsletter_sends', (t) => {
      t.timestamp('proof_approved_at', { useTz: true });
    });
  }
  if (!(await knex.schema.hasColumn('newsletter_sends', 'proof_approval_email_id'))) {
    await knex.schema.alterTable('newsletter_sends', (t) => {
      t.uuid('proof_approval_email_id');
    });
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('newsletter_sends');
  if (!hasTable) return;

  for (const col of ['proof_approval_email_id', 'proof_approved_at', 'proof_sent_at', 'proof_token']) {
    if (await knex.schema.hasColumn('newsletter_sends', col)) {
      await knex.schema.alterTable('newsletter_sends', (t) => {
        t.dropColumn(col);
      });
    }
  }
};

/**
 * Email bounce-recovery ledger.
 *
 * When a transactional/service email hard-bounces because the recipient address
 * has a domain-level transcription typo (e.g. captured wrong on a phone call),
 * server/services/email-bounce-recovery.js corrects the domain and re-sends the
 * exact stored snapshot to the fixed address. One row per bounced message tracks
 * the attempt end-to-end: the candidate, whether it was sent, and — once the
 * corrected address actually delivers — whether we committed the fix to the
 * customer record.
 *
 * The UNIQUE constraint on original_message_id is the idempotency guard: the
 * SendGrid event webhook can re-deliver the same bounce, and a recovery send can
 * itself bounce; either way we only ever open one recovery per original message.
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('email_bounce_recoveries', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // The message that bounced. Unique → at most one recovery per message.
    t.uuid('original_message_id')
      .notNullable()
      .references('id').inTable('email_messages').onDelete('CASCADE');
    t.string('bounced_email').notNullable();

    // The corrected candidate we computed / sent to.
    t.string('corrected_email');
    t.string('correction_rule', 40);     // missing_dot | tld_fix | domain_typo
    t.string('confidence', 20);          // high | medium | low

    // Lifecycle:
    //   no_candidate         — bounce had no safe domain correction
    //   skipped_low_confidence — candidate existed but below the send threshold
    //   corrected_suppressed — corrected address is itself suppressed; not sent
    //   resent               — re-sent to corrected address, awaiting delivery
    //   send_failed          — provider rejected the recovery send
    //   delivered            — corrected address delivered (pre-commit)
    //   committed            — delivered AND customer record updated
    //   redelivered_bounced  — the recovery send also bounced
    t.string('status', 40).notNullable().defaultTo('pending');

    // The re-send (a fresh email_messages row addressed to corrected_email).
    t.uuid('recovery_message_id')
      .references('id').inTable('email_messages').onDelete('SET NULL');

    // Customer whose stored address we may overwrite on delivery.
    t.uuid('customer_id')
      .references('id').inTable('customers').onDelete('SET NULL');
    t.string('customer_email_field', 40); // which column held the bad address
    t.boolean('record_updated').notNullable().defaultTo(false);
    t.timestamp('committed_at');

    t.jsonb('metadata').defaultTo('{}');
    t.timestamps(true, true);

    t.unique(['original_message_id']);
    t.index(['status']);
    t.index(['bounced_email']);
    t.index(['recovery_message_id']);
    t.index(['customer_id']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('email_bounce_recoveries');
};

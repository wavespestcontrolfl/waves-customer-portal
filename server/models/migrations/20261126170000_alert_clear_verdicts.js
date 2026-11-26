/**
 * alert_clear_verdicts — what the alert clear-up agent (services/alert-clear-agent.js, GATE_ALERT_CLEAR_AGENT=shadow) decided for
 * each open admin alert about a customer text, email, voicemail or missed call. One row per judgment, newest wins. SHADOW ONLY:
 * nothing reads this table to close, edit or ring a notification; a week of rows is scored against what staff really did.
 *
 * The fingerprint is a hash of the alert's after-event ids, so an alert is judged again only when something new happened.
 * No foreign key on purpose: a notification row can be pruned, and the verdict stays as evidence. Additive only.
 */

const TABLE = 'alert_clear_verdicts';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.schema.createTable(TABLE, (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('notification_id').notNullable();
    t.text('category');
    t.text('outcome').notNullable();
    t.text('source').notNullable();
    t.text('rule');
    t.text('why');
    t.text('proof_type');
    t.text('proof_id');
    t.text('fingerprint').notNullable();
    t.text('model');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT alert_clear_verdicts_outcome_check CHECK (outcome IN ('answered', 'nothing_to_answer', 'still_owed'))`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT alert_clear_verdicts_source_check CHECK (source IN ('rule', 'ai'))`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS alert_clear_verdicts_notification_created_idx ON ${TABLE} (notification_id, created_at DESC)`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(TABLE);
};

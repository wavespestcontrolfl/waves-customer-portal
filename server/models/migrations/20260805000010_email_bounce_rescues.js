/**
 * email_bounce_rescues — ledger for the on-bounce transcript rescue
 * (email-bounce-rescue.js). One row per bounced address ever examined:
 * what evidence tier produced a candidate, what action was taken
 * (applied / suggested / skipped_*), and the verbatim evidence.
 *
 * The UNIQUE(bounced_email) is load-bearing: it is the loop guard that
 * makes a re-bounce of the same address a no-op instead of a rescue loop,
 * and it makes webhook + backfill racing safe (second insert loses).
 *
 * Origin: 2026-08-05 manual sweep of 36 active bounce suppressions — 9
 * were recoverable from the customer's own words already in call_log /
 * inbound emails (spec: waves-ops/specs/bounce-transcript-rescue-spec.md).
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('email_bounce_rescues')) return;
  await knex.schema.createTable('email_bounce_rescues', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('bounced_email').notNullable().unique();
    t.uuid('customer_id').nullable();
    t.uuid('lead_id').nullable();
    // 'inbound_ground_truth' | 'domain_repair' | 'extractor_consensus'
    // | 'transcript_decode' | 'name_inference' — null when no candidate.
    t.text('tier').nullable();
    t.text('candidate_email').nullable();
    t.jsonb('evidence').notNullable().defaultTo('{}');
    // 'applied' | 'suggested' | 'no_candidate' | 'skipped_<reason>'
    t.text('status').notNullable();
    t.timestamp('applied_at', { useTz: true }).nullable();
    t.text('applied_by').nullable();
    t.timestamps(true, true);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_bounce_rescues'))) return;
  await knex.schema.dropTable('email_bounce_rescues');
};

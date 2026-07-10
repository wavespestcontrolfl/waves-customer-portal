// Zero-triage mission (2026-07-10): audit ledger for the 1,000-call mining run
// and the ongoing self-audit cron. Every discrepancy between the production
// pipeline's output and an independent re-analysis lands here with its
// citation (call SID + field + old/new value + transcript excerpt), so every
// claimed variance is reproducible from the row alone. Written by offline
// backfill scripts and the nightly self-audit job — nothing in the live call
// path writes here.
exports.up = async function up(knex) {
  const hasFindings = await knex.schema.hasTable('call_audit_findings');
  if (!hasFindings) {
    await knex.schema.createTable('call_audit_findings', (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('call_log_id').notNullable().references('id').inTable('call_log').onDelete('CASCADE');
      table.string('twilio_call_sid');
      table.timestamp('call_created_at');
      // Which audit produced this row: 'mining_2026_07' backfill, 'self_audit' cron.
      table.string('audit_source').notNullable();
      table.string('category').notNullable(); // missed_lead, wrong_service_type, spam_false_positive, ...
      table.string('severity').notNullable(); // lost_revenue | customer_harm | data_quality | cosmetic
      table.string('field'); // extraction field in dispute, null for call-level findings
      table.text('old_value'); // production pipeline's value
      table.text('new_value'); // re-analysis value
      table.text('transcript_excerpt'); // <=300 chars citation
      table.jsonb('detail'); // model/versions, confidence, downstream-reality snapshot
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.unique(['call_log_id', 'audit_source', 'category', 'field']); // idempotent backfill upserts
      table.index(['audit_source', 'category']);
      table.index('created_at');
    });
  }
  const hasVerdicts = await knex.schema.hasTable('call_spam_verdicts');
  if (!hasVerdicts) {
    await knex.schema.createTable('call_spam_verdicts', (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('call_log_id').notNullable().references('id').inTable('call_log').onDelete('CASCADE');
      table.string('verdict').notNullable(); // spam | not_spam | insufficient_signals
      // ≥2 independent signals required for verdict='spam' (asymmetric-cost rule).
      table.jsonb('signals').notNullable(); // {risk: {...}, content: {...}, history: {...}}
      table.string('classifier_version').notNullable();
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.unique(['call_log_id', 'classifier_version']); // resumable backfill
      table.index('verdict');
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('call_spam_verdicts')) await knex.schema.dropTable('call_spam_verdicts');
  if (await knex.schema.hasTable('call_audit_findings')) await knex.schema.dropTable('call_audit_findings');
};

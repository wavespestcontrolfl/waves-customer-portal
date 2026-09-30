'use strict';

/**
 * Extend the shared commitment ledger to email, mirroring the SMS lane
 * (20260906000001_sms_operational_actions.js). Additive only — the CHECK
 * constraint is dropped and recreated to add the new source column, and the
 * down migration mirrors the SMS one's safety guard (refuse to drop
 * recorded evidence; disable the gate instead).
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('call_commitments'))) return;
  if (!(await knex.schema.hasColumn('call_commitments', 'email_id'))) {
    await knex.schema.alterTable('call_commitments', (t) => {
      // emails.id is uuid (20260414000005_email_portal.js), matching
      // call_log_id/sms_log_id's own type.
      t.uuid('email_id').references('id').inTable('emails').onDelete('CASCADE');
      t.unique(['email_id', 'commitment_key']);
    });
    await knex.raw('ALTER TABLE call_commitments DROP CONSTRAINT IF EXISTS commitment_one_source');
    await knex.raw(`ALTER TABLE call_commitments ADD CONSTRAINT commitment_one_source
      CHECK ((call_log_id IS NOT NULL)::int + (sms_log_id IS NOT NULL)::int + (email_id IS NOT NULL)::int = 1)`);
  }
  // The customer an email row belongs to, as a real column: a staff
  // promise's Gmail SENT row never carries emails.customer_id, and a
  // customer merge repoints every *_customer_id column (customer-dedupe.js
  // customerFkColumns, and its undo) but never a jsonb snapshot. No FK, like
  // the other soft pointers the merge already covers.
  if (!(await knex.schema.hasColumn('call_commitments', 'email_customer_id'))) {
    await knex.schema.alterTable('call_commitments', (t) => {
      t.uuid('email_customer_id');
      t.index(['email_customer_id']);
    });
  }
  // Intake dedup for the email lane, mirroring sms_log.operational_analysis.
  if (!(await knex.schema.hasColumn('emails', 'operational_analysis'))) {
    await knex.schema.alterTable('emails', (t) => t.jsonb('operational_analysis'));
  }
  // The shared extraction-receipt store (data-hygiene/source-extraction-
  // store.js) is generic on source_type in code, but the table's own CHECK
  // constraint only allowed 'call_log' and 'message'. Widen it for 'email'
  // (email-operational-actions.js's intake retry/backoff bookkeeping).
  if (await knex.schema.hasTable('data_hygiene_source_extractions')) {
    await knex.raw('ALTER TABLE data_hygiene_source_extractions DROP CONSTRAINT IF EXISTS data_hygiene_source_extractions_source_type_check');
    await knex.raw(`ALTER TABLE data_hygiene_source_extractions ADD CONSTRAINT data_hygiene_source_extractions_source_type_check
      CHECK (source_type::text = ANY (ARRAY['call_log', 'message', 'email']::text[]))`);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('call_commitments'))) return;
  // Preserve recorded evidence. Rollback is safe only before activation;
  // deliberately refuse to discard a customer's outstanding obligations.
  if (await knex.schema.hasTable('data_hygiene_source_extractions')) {
    const recordedReceipts = await knex('data_hygiene_source_extractions').where({ source_type: 'email' }).first('id');
    if (recordedReceipts) throw new Error('Email extraction receipts exist; disable the gate instead of dropping them');
  }
  if (await knex.schema.hasColumn('emails', 'operational_analysis')) {
    const analyzed = await knex('emails').whereNotNull('operational_analysis').first('id');
    if (analyzed) throw new Error('Email analysis exists; disable the gate instead of dropping its evidence');
  }
  if (await knex.schema.hasColumn('call_commitments', 'email_id')) {
    const recorded = await knex('call_commitments').whereNotNull('email_id').first('id');
    if (recorded) throw new Error('Email commitments exist; disable the gate instead of dropping their evidence');
    await knex.raw('ALTER TABLE call_commitments DROP CONSTRAINT IF EXISTS commitment_one_source');
    await knex.schema.alterTable('call_commitments', (t) => {
      t.dropUnique(['email_id', 'commitment_key']);
      t.dropColumn('email_id');
    });
    if (await knex.schema.hasColumn('call_commitments', 'email_customer_id')) {
      await knex.schema.alterTable('call_commitments', (t) => t.dropColumn('email_customer_id'));
    }
    // Restore the exact pre-email 2-source constraint.
    await knex.raw(`ALTER TABLE call_commitments ADD CONSTRAINT commitment_one_source
      CHECK ((call_log_id IS NOT NULL)::int + (sms_log_id IS NOT NULL)::int = 1)`);
  }
  if (await knex.schema.hasColumn('emails', 'operational_analysis')) {
    await knex.schema.alterTable('emails', (t) => t.dropColumn('operational_analysis'));
  }
  if (await knex.schema.hasTable('data_hygiene_source_extractions')) {
    await knex.raw('ALTER TABLE data_hygiene_source_extractions DROP CONSTRAINT IF EXISTS data_hygiene_source_extractions_source_type_check');
    await knex.raw(`ALTER TABLE data_hygiene_source_extractions ADD CONSTRAINT data_hygiene_source_extractions_source_type_check
      CHECK (source_type::text = ANY (ARRAY['call_log', 'message']::text[]))`);
  }
};

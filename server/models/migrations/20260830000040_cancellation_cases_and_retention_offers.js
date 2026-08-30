'use strict';

/**
 * Cancellation resolution engine (PR E, owner GO 2026-08-30).
 *
 * cancellation_cases — one row per cancel request: the reason (taxonomy v2,
 *   CHECK-constrained), the hard-stop/review verdict, the ONE retention card
 *   shown (template id + validated slots + action) and its outcome, plus a
 *   snapshot of the account at the moment (tier, rate, families) so the
 *   Customer 360 and reporting can read what happened without re-deriving.
 *
 * retention_offers — the single money rail: 15% off the next 2 charges of
 *   the cancelled family, $75 cap, once per customer per 18 months. Applied
 *   later as its own invoice line; charges_applied/amount_applied enforce
 *   the cap. Nothing grants until the portal flow ships (C1).
 *
 * Reason codes mirror server/services/cancellation-resolution/reason-codes.js.
 */

const REASON_CODES = [
  'price', 'results_pest', 'results_lawn', 'service_experience', 'away',
  'scheduling_access_communication', 'moving_or_property_change', 'no_longer_needed',
  'service_mix', 'diy', 'competitor', 'hoa_or_landlord', 'financial_hardship',
  'health_or_chemicals', 'billing_issue', 'unexpected_recurring',
  'damage_or_adverse_effect', 'personal_circumstances', 'other',
];
const REVIEW_TYPES = ['billing', 'incident', 'disclosure', 'none'];
const OUTCOMES = ['shown', 'accepted', 'declined', 'none'];
const CASE_STATUSES = ['open', 'committed', 'abandoned'];
const OFFER_STATUSES = ['granted', 'exhausted', 'voided'];

const quoted = (list) => list.map((v) => `'${v}'`).join(', ');

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('cancellation_cases'))) {
    await knex.schema.createTable('cancellation_cases', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.uuid('service_request_id').references('id').inTable('service_requests').onDelete('SET NULL');
      t.jsonb('scope').notNullable().defaultTo('[]'); // family keys; [] = whole account
      t.string('reason_code', 40);
      t.smallint('reason_code_version').notNullable().defaultTo(2);
      t.text('reason_text');
      t.boolean('hard_stop').notNullable().defaultTo(false);
      t.string('review_type', 20);
      t.string('resolution_template_id', 60);
      t.jsonb('resolution_slots');
      t.jsonb('resolution_action');
      t.string('resolution_outcome', 20).notNullable().defaultTo('none');
      t.jsonb('snapshot').notNullable().defaultTo('{}');
      t.string('status', 20).notNullable().defaultTo('open');
      t.timestamps(true, true);
      t.index(['customer_id', 'created_at'], 'idx_cancellation_cases_customer_time');
    });
    await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS cancellation_cases_request_uniq ON cancellation_cases (service_request_id) WHERE service_request_id IS NOT NULL');
    await knex.raw(`ALTER TABLE cancellation_cases ADD CONSTRAINT cancellation_cases_reason_code_check CHECK (reason_code IS NULL OR reason_code IN (${quoted(REASON_CODES)}))`);
    await knex.raw(`ALTER TABLE cancellation_cases ADD CONSTRAINT cancellation_cases_review_type_check CHECK (review_type IS NULL OR review_type IN (${quoted(REVIEW_TYPES)}))`);
    await knex.raw(`ALTER TABLE cancellation_cases ADD CONSTRAINT cancellation_cases_outcome_check CHECK (resolution_outcome IN (${quoted(OUTCOMES)}))`);
    await knex.raw(`ALTER TABLE cancellation_cases ADD CONSTRAINT cancellation_cases_status_check CHECK (status IN (${quoted(CASE_STATUSES)}))`);
  }

  if (!(await knex.schema.hasTable('retention_offers'))) {
    await knex.schema.createTable('retention_offers', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.uuid('cancellation_case_id').references('id').inTable('cancellation_cases').onDelete('SET NULL');
      t.string('family_key', 64).notNullable();
      t.decimal('percent_off', 5, 2).notNullable();
      t.smallint('max_charges').notNullable();
      t.decimal('cap_amount', 10, 2).notNullable();
      t.smallint('charges_applied').notNullable().defaultTo(0);
      t.decimal('amount_applied', 10, 2).notNullable().defaultTo(0);
      t.jsonb('applied_invoice_ids').notNullable().defaultTo('[]');
      t.string('status', 20).notNullable().defaultTo('granted');
      t.timestamp('granted_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('expires_at', { useTz: true });
      t.timestamps(true, true);
      t.index(['customer_id', 'status'], 'idx_retention_offers_customer_status');
    });
    await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS retention_offers_case_uniq ON retention_offers (cancellation_case_id) WHERE cancellation_case_id IS NOT NULL');
    await knex.raw(`ALTER TABLE retention_offers ADD CONSTRAINT retention_offers_status_check CHECK (status IN (${quoted(OFFER_STATUSES)}))`);
    await knex.raw('ALTER TABLE retention_offers ADD CONSTRAINT retention_offers_cap_check CHECK (amount_applied >= 0 AND amount_applied <= cap_amount AND charges_applied >= 0 AND charges_applied <= max_charges)');
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('retention_offers');
  await knex.schema.dropTableIfExists('cancellation_cases');
};

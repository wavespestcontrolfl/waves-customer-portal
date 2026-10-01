/**
 * scheduled_services — a clean place to store the customer's own words for
 * WHY they booked a re-service, instead of mixing them into notes with
 * system text ("Self-booked. Notes: …") or an AI call_summary next to a
 * Call SID. Three nullable columns:
 *   customer_request         — the customer's words, or a call paraphrase.
 *   customer_request_source  — 'picker' | 'text' | 'call' | 'office'.
 *   customer_request_pests   — jsonb array of pest keys (picker chips).
 * Nothing reads or writes these until the callers in this same PR (the
 * /reservice picker, createSelfBooking, and the AI call booking insert) —
 * additive and inert until then.
 */
const CHECK_NAME = 'scheduled_services_customer_request_source_check';
const ALLOWED_SOURCES = "('picker', 'text', 'call', 'office')";

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;

  if (!(await knex.schema.hasColumn('scheduled_services', 'customer_request'))) {
    await knex.schema.alterTable('scheduled_services', (table) => {
      table.text('customer_request').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('scheduled_services', 'customer_request_source'))) {
    await knex.schema.alterTable('scheduled_services', (table) => {
      table.text('customer_request_source').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('scheduled_services', 'customer_request_pests'))) {
    await knex.schema.alterTable('scheduled_services', (table) => {
      table.jsonb('customer_request_pests').nullable();
    });
  }

  await knex.raw(`ALTER TABLE scheduled_services DROP CONSTRAINT IF EXISTS ${CHECK_NAME}`);
  await knex.raw(`
    ALTER TABLE scheduled_services
    ADD CONSTRAINT ${CHECK_NAME}
    CHECK (customer_request_source IS NULL OR customer_request_source IN ${ALLOWED_SOURCES})
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;

  await knex.raw(`ALTER TABLE scheduled_services DROP CONSTRAINT IF EXISTS ${CHECK_NAME}`);

  if (await knex.schema.hasColumn('scheduled_services', 'customer_request_pests')) {
    await knex.schema.alterTable('scheduled_services', (table) => {
      table.dropColumn('customer_request_pests');
    });
  }
  if (await knex.schema.hasColumn('scheduled_services', 'customer_request_source')) {
    await knex.schema.alterTable('scheduled_services', (table) => {
      table.dropColumn('customer_request_source');
    });
  }
  if (await knex.schema.hasColumn('scheduled_services', 'customer_request')) {
    await knex.schema.alterTable('scheduled_services', (table) => {
      table.dropColumn('customer_request');
    });
  }
};

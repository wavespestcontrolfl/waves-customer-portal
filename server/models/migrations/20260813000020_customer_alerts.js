'use strict';

/**
 * customer_alerts — the property-alerts engine's ledger (portal roadmap
 * bet 6, owner rulings 2026-08-13: alerts deliver as push + bell).
 *
 * One row per fired alert. The ledger serves three jobs:
 *   - frequency caps: per-rule cooldowns AND the cross-rule
 *     one-alert-per-customer-per-week cap read this table;
 *   - the portal "Property alerts" card lists a customer's recent rows;
 *   - idempotency backstop: (customer_id, dedupe_key) is unique, so a
 *     double-fired sweep cannot ledger the same alert twice (the bell/push
 *     layer dedupes independently on the same key).
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('customer_alerts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('customer_id').notNullable()
      .references('id').inTable('customers').onDelete('CASCADE');
    table.string('rule_key', 60).notNullable();
    table.string('dedupe_key', 120).notNullable();
    table.string('title', 180).notNullable();
    table.text('body').notNullable();
    table.jsonb('payload').notNullable().defaultTo('{}');
    table.timestamp('fired_at').notNullable().defaultTo(knex.fn.now());
    table.index(['customer_id', 'fired_at'], 'idx_customer_alerts_customer_fired');
    table.index(['customer_id', 'rule_key', 'fired_at'], 'idx_customer_alerts_rule_fired');
    table.unique(['customer_id', 'dedupe_key'], 'uq_customer_alerts_dedupe');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('customer_alerts');
};

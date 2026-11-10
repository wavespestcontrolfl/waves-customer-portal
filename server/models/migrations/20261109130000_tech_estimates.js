'use strict';

/**
 * tech_estimates: which estimates the technician estimate tool made (GATE_TECH_ESTIMATES, owner
 * 2026-11-09, "GO, FOR ALL"). One row per tool estimate, written by routes/tech-estimates.js in the same
 * transaction as the estimate. `estimates` gets no new column and the office save never writes this table.
 * office_first_reasons holds the server's detailed reasons the quote needs the office before it is sent
 * (changed_fact:<name>, one_time_over_limit, engine_review, member_address, phone_matches_customer); the
 * phone is only ever shown a shorter set of codes. Additive and idempotent (hasTable guards both ways).
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('tech_estimates')) return;
  await knex.schema.createTable('tech_estimates', (t) => {
    t.uuid('estimate_id').primary().references('id').inTable('estimates').onDelete('CASCADE');
    t.uuid('technician_id').notNullable().references('id').inTable('technicians');
    t.jsonb('office_first_reasons').notNullable().defaultTo('[]');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  // The list reads newest first (knex's index() has no direction).
  await knex.raw('CREATE INDEX idx_tech_estimates_technician_created ON tech_estimates (technician_id, created_at DESC)');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('tech_estimates'))) return;
  await knex.schema.dropTable('tech_estimates');
};

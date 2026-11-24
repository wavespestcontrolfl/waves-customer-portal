'use strict';

/**
 * roof_entry_reads: one row per staff roof read (GATE_ROOF_ENTRY_READ, owner 2026-11-19). A vision model reads a free
 * county aerial photo of the home and flags the likely rodent entry-point types on the roof, so the technician knows
 * where to look. Staff only; nothing here reaches a customer.
 *   lookup_key           sha256 of image_source + the crop centre (lat, lng) rounded to 5 decimals: a read of the same
 *                        roof in the same photo is reused for 90 days instead of paying for a new call. It is also the
 *                        key of the advisory lock (hashtext) that stops two servers paying for one property.
 *   ai_flags             { <entry type>: { likely: 'yes'|'no'|'unsure', pins: [{ x, y }] } }, pins as 0-1 image fractions.
 *                        {} when the model answer failed validation (ai_tier 'unknown').
 *   ai_tier              'low' | 'med' | 'high' | 'unknown' (unreadable roof or failed validation; never reused).
 *   tech_final_count     the entry points the technician found on site; with tech_final_flags it lets us compare
 *                        the AI read with the technician later. Null until the technician reports.
 *   cost_estimate_cents  estimated spend of the one model call (never a billed figure).
 * estimate_id / customer_id are context only and null-on-delete, so a deleted estimate or customer never blocks on it.
 * Additive and idempotent (hasTable guards both ways).
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('roof_entry_reads')) return;
  await knex.schema.createTable('roof_entry_reads', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('estimate_id').nullable().references('id').inTable('estimates').onDelete('SET NULL');
    t.uuid('customer_id').nullable().references('id').inTable('customers').onDelete('SET NULL');
    t.string('lookup_key', 64).notNullable();
    t.string('county', 40).notNullable();
    t.string('image_source', 64).notNullable();
    t.integer('image_year').notNullable();
    t.string('model', 120).notNullable();
    t.jsonb('ai_flags').notNullable().defaultTo('{}');
    t.string('ai_tier', 16).notNullable();
    t.integer('tech_final_count').nullable();
    t.jsonb('tech_final_flags').nullable();
    t.integer('cost_estimate_cents').notNullable().defaultTo(0);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  // The reuse check reads the newest row for one property (knex's index() has no direction).
  await knex.raw('CREATE INDEX idx_roof_entry_reads_key_created ON roof_entry_reads (lookup_key, created_at DESC)');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('roof_entry_reads'))) return;
  await knex.schema.dropTable('roof_entry_reads');
};

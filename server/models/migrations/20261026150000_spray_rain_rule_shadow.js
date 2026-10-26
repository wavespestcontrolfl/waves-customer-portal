'use strict';

/**
 * spray_rain_rule_shadow: one row per visit per visit day, written while GATE_SPRAY_RAIN_RULES=shadow by
 * services/spray-rain-rule-shadow.js (owner 2026-10-26, plan page "Visit-Day Rain Rule": the label rain
 * rules run in shadow before they change the board or a dose).
 *
 * The row holds the WORST verdict the rain rules would have shown on any job card or readiness build
 * that day (UNIQUE scheduled_service_id + visit_date; a later read replaces the peak columns only when
 * it is worse, and refreshes last_seen_at at most every 10 minutes).
 *
 *   live_label / live_hold  the weather chip the board showed at the peak read, and whether any read's
 *                           live check held (a hold hides that product's dose today).
 *   shadow_status           ok | unknown | caution | hold under the rain rules; dose_hidden = a hold.
 *   start_pop / max_pop_4h  the rain chance (%) of the start hour and the highest in the next 4 hours at
 *                           the peak read, so any other odds tier can be counted later.
 *   products                [{ name, verdict, reason, source }] at the peak read.
 *
 * Audit trail only. Nothing reads it to decide anything. Additive and idempotent.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('spray_rain_rule_shadow')) return;
  await knex.schema.createTable('spray_rain_rule_shadow', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('scheduled_service_id').notNullable().references('id').inTable('scheduled_services').onDelete('CASCADE');
    t.date('visit_date').notNullable();
    t.timestamp('start_at', { useTz: true });
    t.string('service_type', 120);
    t.string('live_label', 160);
    t.boolean('live_hold').notNullable().defaultTo(false);
    t.string('shadow_status', 10).notNullable();
    t.string('shadow_label', 160);
    t.smallint('start_pop');
    t.smallint('max_pop_4h');
    t.boolean('dose_hidden').notNullable().defaultTo(false);
    t.jsonb('products').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    t.integer('reads').notNullable().defaultTo(1);
    t.timestamp('first_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('peak_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['scheduled_service_id', 'visit_date']);
  });
  await knex.raw(`ALTER TABLE spray_rain_rule_shadow ADD CONSTRAINT spray_rain_rule_shadow_status_check
    CHECK (shadow_status IN ('ok', 'unknown', 'caution', 'hold'))`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('spray_rain_rule_shadow');
};

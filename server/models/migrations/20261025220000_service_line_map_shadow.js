'use strict';

/**
 * Service-line map, SHADOW ONLY (GATE_SERVICE_LINE_MAP=shadow, owner 2026-10-25:
 * a second technician starts early 2027; the new technician is the home tech for
 * general pest, rodent and mosquito, the owner for lawn / tree & shrub and
 * termite / WDO, and the owner covers every gap).
 *
 * service_line_techs: one row per service line (the five dispatch categories of
 *   auto-dispatch/service-category.js), with a home and a gap technician. No seed
 *   rows: technician ids differ per environment, and an empty table reads as "no
 *   map". ON DELETE SET NULL, so removing a technician never blocks on this table.
 *
 * service_line_pick_shadow: the log. After each booking choice point commits, one
 *   row records the technician actually chosen next to the one the map would pick.
 *   Audit trail only; nothing reads it to decide anything. The id columns carry NO
 *   foreign keys on purpose: a row can be written while the booking it names is
 *   still in the caller's transaction, and the log must never block, or be
 *   blocked by, a delete anywhere else.
 *
 * Additive and idempotent.
 */
const LINES = ['general', 'mosquito', 'lawn', 'rodent', 'termite'];
const SOURCES = ['book', 'phone_live', 'after_call', 'estimate_accept', 'office_auto', 'night_run'];
const quoted = (list) => list.map((v) => `'${v}'`).join(', ');

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('service_line_techs'))) {
    await knex.schema.createTable('service_line_techs', (t) => {
      t.text('service_category').primary();
      t.uuid('home_technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.uuid('gap_technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.uuid('updated_by').nullable();
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
    await knex.raw(`ALTER TABLE service_line_techs ADD CONSTRAINT service_line_techs_category_check
      CHECK (service_category IN (${quoted(LINES)}))`);
  }

  if (!(await knex.schema.hasTable('service_line_pick_shadow'))) {
    await knex.schema.createTable('service_line_pick_shadow', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.text('source').notNullable();
      t.uuid('scheduled_service_id').nullable();
      t.uuid('customer_id').nullable();
      t.date('visit_date').nullable();
      t.text('window_start').nullable();
      t.text('run_id').nullable();
      t.text('service_type').nullable();
      t.text('service_line').nullable();
      t.text('line_from').nullable();
      t.uuid('actual_technician_id').nullable();
      t.uuid('would_technician_id').nullable();
      t.text('would_reason').nullable();
      t.uuid('home_technician_id').nullable();
      t.boolean('would_free').nullable();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index(['created_at'], 'service_line_pick_shadow_created_idx');
      t.index(['visit_date'], 'service_line_pick_shadow_visit_date_idx');
    });
    await knex.raw(`ALTER TABLE service_line_pick_shadow ADD CONSTRAINT service_line_pick_shadow_source_check
      CHECK (source IN (${quoted(SOURCES)}))`);
    await knex.raw(`ALTER TABLE service_line_pick_shadow ADD CONSTRAINT service_line_pick_shadow_line_from_check
      CHECK (line_from IS NULL OR line_from IN ('catalog', 'name'))`);
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('service_line_pick_shadow');
  await knex.schema.dropTableIfExists('service_line_techs');
};

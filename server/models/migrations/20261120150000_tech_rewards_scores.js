'use strict';

/**
 * Tech Rewards Plan D5-2: the data under the technician season-bonus score
 * (owner rulings 2026-11-20; calculator = server/services/tech-rewards-calc.js,
 * score reads = server/services/tech-rewards-scores.js). Three tables, additive,
 * no backfill, nothing reads them until the later audit screen and scoreboard.
 *
 *   tech_reward_settings  versioned score settings (weights + band cut lines).
 *                         A row is never changed or deleted: a trigger refuses
 *                         UPDATE and DELETE so a change is a new, higher
 *                         version. The setting in force on a date is the
 *                         highest version whose effective_from is on or before it.
 *   tech_protocol_audits  one row per audited visit (the owner's monthly check).
 *                         result is 'match' or 'mismatch'. audit_month is the
 *                         first day of the month the audit counts toward. A deleted visit
 *                         never deletes its audit result: scheduled_service_id goes NULL
 *                         (ON DELETE SET NULL; the unique constraint ignores NULLs).
 *   tech_owner_ratings    the owner's 0..100 rating of a technician for one
 *                         month, one row per technician per month.
 *
 * Ids of people point at technicians.id, where admin logins live too: audited_by and
 * rated_by are FKs (SET NULL keeps the row if that login is removed); created_by on
 * the frozen settings is a plain uuid, so the author stays even after the login goes.
 * A technician row is never hard-deleted in practice (active=false), so the
 * technician FKs are RESTRICT: score history is not silently dropped.
 *
 * A pushed migration is frozen: a fix is another file.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('tech_reward_settings'))) {
    await knex.schema.createTable('tech_reward_settings', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.integer('version').notNullable().unique();
      t.jsonb('weights').notNullable();
      t.jsonb('cut_lines').notNullable();
      t.date('effective_from').notNullable();
      t.uuid('created_by').nullable(); // no FK: the author stays on the row after the login goes
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
    await knex.raw('ALTER TABLE tech_reward_settings ADD CONSTRAINT tech_reward_settings_version_check CHECK (version >= 1)');
    await knex.raw("ALTER TABLE tech_reward_settings ADD CONSTRAINT tech_reward_settings_weights_check CHECK (jsonb_typeof(weights) = 'object')");
    await knex.raw("ALTER TABLE tech_reward_settings ADD CONSTRAINT tech_reward_settings_cut_lines_check CHECK (jsonb_typeof(cut_lines) = 'object')");
    await knex.raw('CREATE INDEX tech_reward_settings_effective_idx ON tech_reward_settings (effective_from, version DESC)');
    await knex.raw(`
      CREATE OR REPLACE FUNCTION tech_reward_settings_frozen() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'tech_reward_settings rows are never changed or deleted: insert a new version';
      END;
      $$ LANGUAGE plpgsql
    `);
    await knex.raw(`
      CREATE TRIGGER tech_reward_settings_frozen_trg
        BEFORE UPDATE OR DELETE ON tech_reward_settings
        FOR EACH ROW EXECUTE FUNCTION tech_reward_settings_frozen()
    `);
  }

  if (!(await knex.schema.hasTable('tech_protocol_audits'))) {
    await knex.schema.createTable('tech_protocol_audits', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('technician_id').notNullable().references('id').inTable('technicians').onDelete('RESTRICT');
      t.uuid('scheduled_service_id').nullable().unique().references('id').inTable('scheduled_services').onDelete('SET NULL');
      t.date('audit_month').notNullable();
      t.text('result').notNullable();
      t.text('note').nullable();
      t.uuid('audited_by').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.timestamp('audited_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
    await knex.raw("ALTER TABLE tech_protocol_audits ADD CONSTRAINT tech_protocol_audits_result_check CHECK (result IN ('match', 'mismatch'))");
    await knex.raw('ALTER TABLE tech_protocol_audits ADD CONSTRAINT tech_protocol_audits_month_check CHECK (EXTRACT(DAY FROM audit_month) = 1)');
    await knex.raw('CREATE INDEX tech_protocol_audits_tech_month_idx ON tech_protocol_audits (technician_id, audit_month)');
  }

  if (!(await knex.schema.hasTable('tech_owner_ratings'))) {
    await knex.schema.createTable('tech_owner_ratings', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('technician_id').notNullable().references('id').inTable('technicians').onDelete('RESTRICT');
      t.date('period_month').notNullable();
      t.specificType('rating', 'smallint').notNullable();
      t.text('note').nullable();
      t.uuid('rated_by').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.timestamp('rated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.unique(['technician_id', 'period_month'], 'tech_owner_ratings_tech_month_uniq');
    });
    await knex.raw('ALTER TABLE tech_owner_ratings ADD CONSTRAINT tech_owner_ratings_rating_check CHECK (rating BETWEEN 0 AND 100)');
    await knex.raw('ALTER TABLE tech_owner_ratings ADD CONSTRAINT tech_owner_ratings_month_check CHECK (EXTRACT(DAY FROM period_month) = 1)');
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('tech_owner_ratings');
  await knex.schema.dropTableIfExists('tech_protocol_audits');
  await knex.schema.dropTableIfExists('tech_reward_settings');
  await knex.raw('DROP FUNCTION IF EXISTS tech_reward_settings_frozen()');
};

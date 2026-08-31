'use strict';

/**
 * Cancel-flow C2 — the two "away" alternatives inside the cancel flow
 * (ruling C-4; pause is NOT a product):
 *
 * - plan_holds: a lawn / mosquito / tree & shrub family put on hold until a
 *   customer-chosen resume date (≤ 180 days). Visits are moved to the resume
 *   date, the family's monthly component is suspended (held_monthly_rate is
 *   restored on resume), the tier is protected (customers.tier_protected_until)
 *   so the bundle price stays locked, and a text goes out 7 days before the
 *   restart. Once per family per 12 months (partial unique on live holds).
 * - property_preferences.away_mode_until: pest Away Mode — exterior-only
 *   visits continue, nobody needs to be home, reports still send. Price and
 *   tier unchanged. Dispatch/tech surfaces read this date.
 *
 * Guarded; idempotent both directions.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('plan_holds'))) {
    await knex.schema.createTable('plan_holds', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.uuid('cancellation_case_id').references('id').inTable('cancellation_cases').onDelete('SET NULL');
      t.string('family_key', 64).notNullable();
      t.date('starts_on').notNullable();
      t.date('resume_on').notNullable();
      t.decimal('held_monthly_rate', 10, 2);
      t.jsonb('moved_visits').notNullable().defaultTo('[]');
      t.string('status', 20).notNullable().defaultTo('active');
      t.timestamp('reminder_sent_at', { useTz: true });
      t.timestamp('resumed_at', { useTz: true });
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index(['customer_id', 'status'], 'idx_plan_holds_customer_status');
      t.index(['status', 'resume_on'], 'idx_plan_holds_status_resume');
    });
    await knex.raw("ALTER TABLE plan_holds ADD CONSTRAINT plan_holds_status_check CHECK (status IN ('active', 'resumed', 'cancelled'))");
    await knex.raw('ALTER TABLE plan_holds ADD CONSTRAINT plan_holds_window_check CHECK (resume_on > starts_on AND resume_on <= starts_on + 180)');
    // One LIVE hold per family per customer at a time.
    await knex.raw("CREATE UNIQUE INDEX plan_holds_live_family_uniq ON plan_holds (customer_id, family_key) WHERE status = 'active'");
  }

  if (await knex.schema.hasTable('customers') && !(await knex.schema.hasColumn('customers', 'tier_protected_until'))) {
    await knex.schema.alterTable('customers', (t) => {
      t.date('tier_protected_until');
    });
  }

  if (await knex.schema.hasTable('property_preferences') && !(await knex.schema.hasColumn('property_preferences', 'away_mode_until'))) {
    await knex.schema.alterTable('property_preferences', (t) => {
      t.date('away_mode_until');
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('property_preferences') && await knex.schema.hasColumn('property_preferences', 'away_mode_until')) {
    await knex.schema.alterTable('property_preferences', (t) => { t.dropColumn('away_mode_until'); });
  }
  if (await knex.schema.hasTable('customers') && await knex.schema.hasColumn('customers', 'tier_protected_until')) {
    await knex.schema.alterTable('customers', (t) => { t.dropColumn('tier_protected_until'); });
  }
  await knex.schema.dropTableIfExists('plan_holds');
};

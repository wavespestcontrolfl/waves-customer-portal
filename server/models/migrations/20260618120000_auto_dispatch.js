/**
 * Auto-Dispatch Optimizer — schema
 *
 * Adds the autonomous-optimization control columns to scheduled_services and
 * two thin bookkeeping tables (runs + per-service audit log). The optimization
 * itself reuses the existing engine (find-time scoring, route-matrix, rebooker);
 * these tables only record what the daily job evaluated, recommended, or changed.
 *
 * Recurring detection reuses the existing scheduled_services.is_recurring +
 * recurring_parent_id columns — no new "plan" model is introduced here.
 */
exports.up = async function up(knex) {
  // --- scheduled_services control columns -----------------------------------
  const ss = 'scheduled_services';
  const addIfMissing = async (col, build) => {
    if (!(await knex.schema.hasColumn(ss, col))) {
      await knex.schema.alterTable(ss, build);
    }
  };
  await addIfMissing('auto_dispatch_locked', (t) =>
    t.boolean('auto_dispatch_locked').notNullable().defaultTo(false));
  await addIfMissing('auto_dispatch_excluded', (t) =>
    t.boolean('auto_dispatch_excluded').notNullable().defaultTo(false));
  await addIfMissing('last_auto_dispatch_at', (t) =>
    t.timestamp('last_auto_dispatch_at', { useTz: true }).nullable());
  await addIfMissing('last_auto_dispatch_run_id', (t) =>
    t.uuid('last_auto_dispatch_run_id').nullable());
  await addIfMissing('auto_dispatch_change_count', (t) =>
    t.integer('auto_dispatch_change_count').notNullable().defaultTo(0));

  // --- auto_dispatch_runs ----------------------------------------------------
  if (!(await knex.schema.hasTable('auto_dispatch_runs'))) {
    await knex.schema.createTable('auto_dispatch_runs', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('completed_at', { useTz: true }).nullable();
      // running | completed | completed_with_errors | failed
      t.string('status', 32).notNullable().defaultTo('running');
      // dry_run | apply
      t.string('mode', 16).notNullable().defaultTo('dry_run');
      t.integer('total_evaluated').notNullable().defaultTo(0);
      t.integer('total_skipped').notNullable().defaultTo(0);
      t.integer('total_recommended').notNullable().defaultTo(0);
      t.integer('total_changed').notNullable().defaultTo(0);
      t.integer('total_failed').notNullable().defaultTo(0);
      t.jsonb('config_snapshot').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.string('triggered_by', 64).notNullable().defaultTo('cron');
      t.text('error_message').nullable();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.index(['started_at'], 'idx_auto_dispatch_runs_started');
      t.index(['status'], 'idx_auto_dispatch_runs_status');
    });
  }

  // --- auto_dispatch_audit_logs ---------------------------------------------
  if (!(await knex.schema.hasTable('auto_dispatch_audit_logs'))) {
    await knex.schema.createTable('auto_dispatch_audit_logs', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('auto_dispatch_run_id').notNullable()
        .references('id').inTable('auto_dispatch_runs').onDelete('CASCADE');
      t.uuid('scheduled_service_id').nullable()
        .references('id').inTable('scheduled_services').onDelete('SET NULL');
      t.uuid('customer_id').nullable();
      t.uuid('recurring_parent_id').nullable();
      // skipped | no_change | recommended | changed | failed
      t.string('action', 24).notNullable();
      t.string('reason_code', 48).nullable();
      t.text('reason_description').nullable();

      // before / after placement
      t.date('old_scheduled_date').nullable();
      t.string('old_window_start', 8).nullable();
      t.string('old_window_end', 8).nullable();
      t.uuid('old_technician_id').nullable();
      t.string('old_status', 32).nullable();
      t.string('old_zone', 40).nullable();
      t.date('new_scheduled_date').nullable();
      t.string('new_window_start', 8).nullable();
      t.string('new_window_end', 8).nullable();
      t.uuid('new_technician_id').nullable();
      t.string('new_status', 32).nullable();
      t.string('new_zone', 40).nullable();

      t.decimal('old_score', 8, 2).nullable();
      t.decimal('new_score', 8, 2).nullable();
      t.decimal('score_improvement', 8, 2).nullable();

      t.jsonb('portal_preferences_snapshot').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.jsonb('route_metrics_snapshot').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.jsonb('constraints_checked').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.string('applied_by', 64).nullable();
      t.text('error_message').nullable();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.index(['auto_dispatch_run_id'], 'idx_auto_dispatch_audit_run');
      t.index(['scheduled_service_id', 'created_at'], 'idx_auto_dispatch_audit_service');
      t.index(['customer_id'], 'idx_auto_dispatch_audit_customer');
      t.index(['action'], 'idx_auto_dispatch_audit_action');
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('auto_dispatch_audit_logs');
  await knex.schema.dropTableIfExists('auto_dispatch_runs');
  const ss = 'scheduled_services';
  const dropIfPresent = async (col) => {
    if (await knex.schema.hasColumn(ss, col)) {
      await knex.schema.alterTable(ss, (t) => t.dropColumn(col));
    }
  };
  await dropIfPresent('auto_dispatch_change_count');
  await dropIfPresent('last_auto_dispatch_run_id');
  await dropIfPresent('last_auto_dispatch_at');
  await dropIfPresent('auto_dispatch_excluded');
  await dropIfPresent('auto_dispatch_locked');
};

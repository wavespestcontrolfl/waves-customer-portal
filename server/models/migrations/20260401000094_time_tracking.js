exports.up = async function (knex) {
  // 1. Core time entries table
  if (!(await knex.schema.hasTable('time_entries'))) {
    await knex.schema.createTable('time_entries', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('technician_id').notNullable();
      t.enu('entry_type', ['shift', 'job', 'break', 'drive', 'admin_time']).notNullable();
      t.enu('status', ['active', 'completed', 'edited', 'voided']).notNullable().defaultTo('active');
      t.timestamp('clock_in').notNullable().defaultTo(knex.fn.now());
      t.timestamp('clock_out');
      t.decimal('duration_minutes', 10, 2);
      t.uuid('job_id');
      t.uuid('customer_id');
      t.decimal('clock_in_lat', 10, 7);
      t.decimal('clock_in_lng', 10, 7);
      t.decimal('clock_out_lat', 10, 7);
      t.decimal('clock_out_lng', 10, 7);
      t.text('clock_in_address');
      t.string('service_type');
      t.string('pay_type').defaultTo('hourly');
      t.text('notes');
      t.text('edit_reason');
      t.uuid('edited_by');
      t.timestamp('edited_at');
      t.timestamp('original_clock_in');
      t.timestamp('original_clock_out');
      t.string('source').defaultTo('app');
      t.timestamps(true, true);
      t.index('technician_id');
      t.index(['technician_id', 'clock_in']);
      t.index('job_id');
      t.index('status');
      t.index('entry_type');
      t.index('clock_in');
    });
  }

  // 2. Daily summary table
  if (!(await knex.schema.hasTable('time_entry_daily_summary'))) {
    await knex.schema.createTable('time_entry_daily_summary', (t) => {
      t.increments('id').primary();
      t.uuid('technician_id').notNullable();
      t.date('work_date').notNullable();
      t.decimal('total_shift_minutes', 10, 2).defaultTo(0);
      t.decimal('total_job_minutes', 10, 2).defaultTo(0);
      t.decimal('total_drive_minutes', 10, 2).defaultTo(0);
      t.decimal('total_break_minutes', 10, 2).defaultTo(0);
      t.decimal('total_admin_minutes', 10, 2).defaultTo(0);
      t.integer('job_count').defaultTo(0);
      t.timestamp('first_clock_in');
      t.timestamp('last_clock_out');
      t.decimal('overtime_minutes', 10, 2).defaultTo(0);
      t.decimal('utilization_pct', 5, 2).defaultTo(0);
      t.decimal('revenue_generated', 10, 2).defaultTo(0);
      t.decimal('rpmh_actual', 10, 2).defaultTo(0);
      t.string('status', 20).notNullable().defaultTo('pending');
      t.uuid('approved_by');
      t.timestamp('approved_at');
      t.text('notes');
      t.timestamps(true, true);
      t.unique(['technician_id', 'work_date']);
    });
  }

  // 3. Weekly summary table
  if (!(await knex.schema.hasTable('time_weekly_summary'))) {
    await knex.schema.createTable('time_weekly_summary', (t) => {
      t.increments('id').primary();
      t.uuid('technician_id').notNullable();
      t.date('week_start').notNullable();
      t.date('week_end').notNullable();
      t.decimal('total_shift_minutes', 10, 2).defaultTo(0);
      t.decimal('total_job_minutes', 10, 2).defaultTo(0);
      t.decimal('total_drive_minutes', 10, 2).defaultTo(0);
      t.decimal('regular_minutes', 10, 2).defaultTo(0);
      t.decimal('overtime_minutes', 10, 2).defaultTo(0);
      t.integer('days_worked').defaultTo(0);
      t.integer('job_count').defaultTo(0);
      t.decimal('total_revenue', 10, 2).defaultTo(0);
      t.decimal('avg_rpmh', 10, 2).defaultTo(0);
      t.decimal('utilization_pct', 5, 2).defaultTo(0);
      t.string('status', 20).notNullable().defaultTo('pending');
      t.timestamps(true, true);
      t.unique(['technician_id', 'week_start']);
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('time_weekly_summary');
  await knex.schema.dropTableIfExists('time_entry_daily_summary');
  await knex.schema.dropTableIfExists('time_entries');
};

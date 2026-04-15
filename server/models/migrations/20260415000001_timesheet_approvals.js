/**
 * Timesheet approval audit log — track approve/reject actions per daily summary.
 *
 * The `time_entry_daily_summary` table already has status/approved_by/approved_at,
 * but no history. This table captures each action with admin, reason, and before/after
 * status so disputes can be reconstructed.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('timesheet_approvals'))) {
    await knex.schema.createTable('timesheet_approvals', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.integer('daily_summary_id').notNullable();
      t.uuid('technician_id').notNullable();
      t.date('work_date').notNullable();
      t.enu('action', ['approved', 'rejected', 'reopened']).notNullable();
      t.uuid('admin_id');
      t.text('reason');
      t.string('prior_status', 20);
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.index('daily_summary_id');
      t.index(['technician_id', 'work_date']);
    });
  }

  // Add `rejected` to status enum via plain string column (postgres)
  // status is already varchar(20), so no schema change needed — values just expand.
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('timesheet_approvals');
};

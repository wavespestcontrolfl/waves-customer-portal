/**
 * Entry-level approval fields for time_entries.
 *
 * Weekly approval locks the week's entries by flipping approval_status='approved'
 * so nothing can be edited until an admin explicitly unlocks the week.
 */
exports.up = async function (knex) {
  const hasCol = async (col) => knex.schema.hasColumn('time_entries', col);

  if (!(await hasCol('approval_status'))) {
    await knex.schema.alterTable('time_entries', (t) => {
      // 'pending' | 'approved' | 'disputed'
      t.string('approval_status', 20).defaultTo('pending');
    });
  }
  if (!(await hasCol('approved_by'))) {
    await knex.schema.alterTable('time_entries', (t) => t.uuid('approved_by'));
  }
  if (!(await hasCol('approved_at'))) {
    await knex.schema.alterTable('time_entries', (t) => t.timestamp('approved_at'));
  }
  if (!(await hasCol('approval_notes'))) {
    await knex.schema.alterTable('time_entries', (t) => t.text('approval_notes'));
  }

  // time_weekly_summary is missing approved_by / approved_at (daily summary has them)
  const hasWeeklyCol = async (col) => knex.schema.hasColumn('time_weekly_summary', col);
  if (!(await hasWeeklyCol('approved_by'))) {
    await knex.schema.alterTable('time_weekly_summary', (t) => t.uuid('approved_by'));
  }
  if (!(await hasWeeklyCol('approved_at'))) {
    await knex.schema.alterTable('time_weekly_summary', (t) => t.timestamp('approved_at'));
  }
  if (!(await hasWeeklyCol('approval_notes'))) {
    await knex.schema.alterTable('time_weekly_summary', (t) => t.text('approval_notes'));
  }
};

exports.down = async function (knex) {
  await knex.schema.alterTable('time_entries', (t) => {
    t.dropColumn('approval_status');
    t.dropColumn('approved_by');
    t.dropColumn('approved_at');
    t.dropColumn('approval_notes');
  });
  await knex.schema.alterTable('time_weekly_summary', (t) => {
    t.dropColumn('approved_by');
    t.dropColumn('approved_at');
    t.dropColumn('approval_notes');
  });
};

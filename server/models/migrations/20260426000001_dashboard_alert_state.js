// Two-table state machine for dashboard ops alerts:
//
//   dashboard_alert_state     — server-side cron tracking. One row per
//                              currently-active alert. Records the count
//                              that was last pushed so the cron knows
//                              whether to re-fire on escalation.
//
//   dashboard_alert_dismissed — per-admin user dismissals. When an
//                              operator clicks "Mark as read" on a live
//                              alert chip, we record the count at that
//                              moment. The bell skips alerts the user
//                              has dismissed UNTIL the count grows
//                              (escalation re-shows it) or 24 hours
//                              elapse (auto-expire).
//
// Both tables are intentionally light — alert ids are short strings
// owned by server/services/dashboard-alerts.js and live in code, not in
// a registry table.

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('dashboard_alert_state'))) {
    await knex.schema.createTable('dashboard_alert_state', (t) => {
      t.string('alert_id', 60).primary();
      t.string('severity', 20).notNullable();
      t.integer('current_count').notNullable().defaultTo(0);
      t.integer('last_pushed_count');
      t.timestamp('first_seen_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('last_seen_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('last_pushed_at');
      // Stash the human label that was pushed so SMS replays can use it
      // without recomputing.
      t.text('last_label');
    });
  }

  if (!(await knex.schema.hasTable('dashboard_alert_dismissed'))) {
    await knex.schema.createTable('dashboard_alert_dismissed', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      // technicians.id (admin user id used by req.technicianId in
      // server/middleware/admin-auth.js — we don't FK to that table to
      // avoid a cascade-on-delete surprise removing dismissal history).
      t.uuid('admin_user_id').notNullable();
      t.string('alert_id', 60).notNullable();
      // Count at the moment of dismissal. If current_count grows past
      // this, the alert re-surfaces in the bell (escalation).
      t.integer('dismissed_at_count').notNullable();
      t.timestamp('dismissed_at').notNullable().defaultTo(knex.fn.now());
      t.index(['admin_user_id', 'alert_id']);
      t.index('dismissed_at');
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('dashboard_alert_dismissed');
  await knex.schema.dropTableIfExists('dashboard_alert_state');
};

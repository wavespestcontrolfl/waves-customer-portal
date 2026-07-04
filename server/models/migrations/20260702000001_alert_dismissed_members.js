// Adds queue membership to per-admin dashboard-alert dismissals.
//
// dismissed_at_count alone can't tell "the same N items I dismissed" apart
// from "a different item entered the queue while another left" — for a queue
// alert like leads_awaiting_contact that means a brand-new lead crossing the
// 30-minute SLA at an unchanged (or lower) count stays hidden for up to the
// 24h dismissal window. Queue alerts now carry their sorted member ids
// (dashboard-alerts.js queueMembers); the dismissal records them, and the
// bell re-shows the alert only when a member NOT covered by the dismissal
// enters — a queue that merely shrank to a subset stays dismissed.
//
// TEXT (comma-joined ids): these queues are operationally small (SLA-breached
// leads, 3-day expiring estimates, at-risk recurring accounts). Nullable:
// alerts without members (aggregate-style: autopay coverage, unattributed
// counts) and pre-migration dismissal rows keep the pure count behavior.

exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('dashboard_alert_dismissed', 'dismissed_members');
  if (!has) {
    await knex.schema.alterTable('dashboard_alert_dismissed', (t) => {
      t.text('dismissed_members');
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('dashboard_alert_dismissed', 'dismissed_members');
  if (has) {
    await knex.schema.alterTable('dashboard_alert_dismissed', (t) => {
      t.dropColumn('dismissed_members');
    });
  }
};

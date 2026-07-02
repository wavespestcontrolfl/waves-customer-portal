// Adds a membership fingerprint to per-admin dashboard-alert dismissals.
//
// dismissed_at_count alone can't tell "the same N items I dismissed" apart
// from "a different item entered the queue while another left" — for a queue
// alert like leads_awaiting_contact that means a brand-new lead crossing the
// 30-minute SLA at an unchanged count stays hidden for up to the 24h dismissal
// window. The alert now carries an order-independent md5 of its member ids
// (dashboard-alerts.js membershipFingerprint); the dismissal records it, and
// the bell re-shows the alert when the fingerprint changes. Nullable: alerts
// without a fingerprint (and pre-migration dismissal rows) keep the pure
// count-based behavior.

exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('dashboard_alert_dismissed', 'dismissed_fingerprint');
  if (!has) {
    await knex.schema.alterTable('dashboard_alert_dismissed', (t) => {
      t.string('dismissed_fingerprint', 64);
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('dashboard_alert_dismissed', 'dismissed_fingerprint');
  if (has) {
    await knex.schema.alterTable('dashboard_alert_dismissed', (t) => {
      t.dropColumn('dismissed_fingerprint');
    });
  }
};

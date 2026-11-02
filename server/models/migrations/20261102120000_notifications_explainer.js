/**
 * notifications.explainer (owner 2026-11-02, GATE_ALERT_EXPLAINER): the bell's "What to do" summary of one
 * admin alert, written by services/admin-alert-explainer.js the first time an admin opens it and kept on the
 * row so the next open is instant. jsonb, nullable. It is not part of the row's content version
 * (NOTIFICATION_VERSION_SQL hashes title, body, link, detail and metadata only), so saving a summary never
 * fences a Done or a button tap. Each summary carries the version it was written for; a row whose text
 * changed since reads as having none.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notifications'))) return;
  if (await knex.schema.hasColumn('notifications', 'explainer')) return;
  await knex.schema.alterTable('notifications', (t) => {
    t.jsonb('explainer').nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('notifications'))) return;
  if (!(await knex.schema.hasColumn('notifications', 'explainer'))) return;
  await knex.schema.alterTable('notifications', (t) => {
    t.dropColumn('explainer');
  });
};

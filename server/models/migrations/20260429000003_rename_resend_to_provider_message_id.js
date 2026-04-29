/**
 * Rename newsletter_send_deliveries.resend_message_id →
 * provider_message_id. The column held a Resend message id when this
 * project briefly used Resend; once we migrated to SendGrid, the field
 * carried SendGrid's X-Message-Id under a stale name. Anyone reading
 * the schema went looking for a Resend integration that doesn't exist.
 *
 * Postgres handles the rename as a metadata-only operation (no table
 * rewrite), and indexes that reference the column auto-update to the
 * new name — including the composite (resend_message_id, email) index
 * added in 20260429000001.
 *
 * Deploy ordering: Railway runs `npm run db:migrate` as a pre-deploy
 * command, so the rename lands BEFORE the new container that reads
 * the new name. There's a brief window where the old container's
 * still serving and would 500 on writes to the renamed column —
 * acceptable at Waves' scale (the inflight risk is one in-progress
 * send), and SendGrid retries event webhooks on non-2xx so dropped
 * events recover on their own.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('newsletter_send_deliveries', (t) => {
    t.renameColumn('resend_message_id', 'provider_message_id');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('newsletter_send_deliveries', (t) => {
    t.renameColumn('provider_message_id', 'resend_message_id');
  });
};

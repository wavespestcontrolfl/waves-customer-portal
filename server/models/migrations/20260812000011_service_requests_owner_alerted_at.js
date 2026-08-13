/**
 * Alert receipt for voice-filed re-service requests.
 *
 * The ticket queue is a documented black hole (owner ruling: 14 requests, zero
 * resolved), and the INTERNAL owner alert is the ruled escape hatch for
 * voice-filed tickets — which made the alert load-bearing while it ran as a
 * post-commit best-effort side effect: a process exit between the ticket commit
 * and the page left a durable ticket nobody would ever see, and the
 * already-open dedupe then refused to file (correctly) without ever re-paging.
 *
 * `owner_alerted_at` is the durable receipt: stamped when the owner page
 * actually went out, retried on the next voice touch of the same open request,
 * and swept hourly for rows that never got either (relay-reservice
 * sweepUnalertedVoiceReservices).
 *
 * `owner_alert_claimed_at` is the send CLAIM — an expirable lease taken
 * atomically before paging so the creator, the already-open retry guards, and
 * the hourly sweep can never page the same ticket concurrently. Released on a
 * failed send; reclaimable after 2 minutes when no receipt exists (a claim
 * whose process died must not strand the page).
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('service_requests', 'owner_alerted_at'))) {
    await knex.schema.alterTable('service_requests', (t) => {
      t.timestamp('owner_alerted_at', { useTz: true });
    });
  }
  if (!(await knex.schema.hasColumn('service_requests', 'owner_alert_claimed_at'))) {
    await knex.schema.alterTable('service_requests', (t) => {
      t.timestamp('owner_alert_claimed_at', { useTz: true });
    });
  }
};

exports.down = async function down(knex) {
  for (const col of ['owner_alerted_at', 'owner_alert_claimed_at']) {
     
    if (await knex.schema.hasColumn('service_requests', col)) {
       
      await knex.schema.alterTable('service_requests', (t) => {
        t.dropColumn(col);
      });
    }
  }
};

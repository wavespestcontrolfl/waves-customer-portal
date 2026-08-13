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
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('service_requests', 'owner_alerted_at')) return;
  await knex.schema.alterTable('service_requests', (t) => {
    t.timestamp('owner_alerted_at', { useTz: true });
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('service_requests', 'owner_alerted_at'))) return;
  await knex.schema.alterTable('service_requests', (t) => {
    t.dropColumn('owner_alerted_at');
  });
};

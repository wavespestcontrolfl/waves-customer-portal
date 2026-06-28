/**
 * Async-result tracking for Google Customer Match audience syncs.
 *
 * Google's Data Manager audienceMembers:ingest/:remove finish ASYNCHRONOUSLY — the
 * HTTP 200 only means "accepted", and the real result (SUCCESS / FAILED /
 * PARTIAL_SUCCESS) is read later via requestStatus:retrieve. google-customer-match.js
 * persists the upload optimistically into `member_keys` but records the in-flight ops
 * in `pending` so the next run can poll their requestId and REVERT any that failed
 * (re-sending those rows on the next delta). Without this, a request that later fails
 * would leave its hashes in member_keys forever and never retry.
 *
 * Meta rows (ad_audience_syncs.platform = 'meta') don't use these columns — Meta's
 * Custom Audience add/remove is acknowledged synchronously.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('ad_audience_syncs', (t) => {
    t.jsonb('pending').notNullable().defaultTo('[]'); // [{ requestId, op, at, members:[{k,d}] }]
    t.string('last_request_id', 120);
    // customerId:listId the member_keys were uploaded to — if the configured
    // destination changes, state is reset so the new list gets a full re-upload.
    t.string('destination_sig', 80);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('ad_audience_syncs', (t) => {
    t.dropColumn('pending');
    t.dropColumn('last_request_id');
    t.dropColumn('destination_sig');
  });
};

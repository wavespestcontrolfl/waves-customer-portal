/**
 * Stage 2 — store the Google Address Validation verdict per call.
 *
 * ai_address_validation: provider-neutral result from
 *   server/services/address-validation (status, inServiceArea, county,
 *   granularity, normalized address, replaced/inferred/unconfirmed flags).
 *   Recorded in shadow on every valid v2 extraction so the promotion-readiness
 *   gate can measure address outcomes, and reused by the routing gate.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('call_log', (t) => {
    t.jsonb('ai_address_validation');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('call_log', (t) => {
    t.dropColumn('ai_address_validation');
  });
};

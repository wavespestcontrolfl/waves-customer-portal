/**
 * reschedule_log.occurrence_service_id: the missed occurrence's CATALOG service,
 * frozen when it is logged (beside occurrence_service_type / occurrence_property_id,
 * 20261002140000).
 *
 * The SMS missed-visit fact decides whether a later visit followed a no-show up by
 * comparing service identity the way the catalog-aware invariants do: the catalog
 * row by service_id, else an exact catalog-name match. A label alone cannot tell a
 * renamed label of the same catalog row from a different service, so the writers
 * (missed-appointment onSkip, the rebooker's per-service move) now stamp the
 * scheduled row's service_id too. Nullable: older rows, and rows whose visit had
 * no catalog link, fall back to the label. No FK: a snapshot outlives the row.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('reschedule_log', (t) => {
    t.uuid('occurrence_service_id');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('reschedule_log', (t) => {
    t.dropColumn('occurrence_service_id');
  });
};

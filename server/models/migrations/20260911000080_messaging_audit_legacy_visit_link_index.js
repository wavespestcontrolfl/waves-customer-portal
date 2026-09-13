// messaging_audit_log.appointment_id has only been stamped by the appointment
// senders since 2026-08-06; before that the visit linkage lived solely in the
// row's metadata. no-show-detector.js's promise-evidence read therefore scopes
// on either, and the metadata half needs its own index or the read falls back
// to a sequential scan of message history every five minutes.
//
// Partial on appointment_id IS NULL: the indexed half is only ever consulted
// for rows that lack the column, which is the legacy tail and never grows.
exports.up = async function up(knex) {
  await knex.raw(`CREATE INDEX IF NOT EXISTS messaging_audit_legacy_visit_link_idx
    ON messaging_audit_log ((metadata->>'scheduled_service_id'))
    WHERE appointment_id IS NULL AND metadata->>'scheduled_service_id' IS NOT NULL`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS messaging_audit_legacy_visit_link_idx');
};

'use strict';

/**
 * Tech Rewards Plan D5-3b: what the owner reviewed, stored on the mark. Two nullable columns on
 * tech_protocol_audits, additive, no backfill:
 *
 *   reviewed_record_id    the visit's canonical service_records.id the owner reviewed (a plain uuid, no FK:
 *                         the record may be deleted later and the mark must keep saying which one it judged).
 *   evidence_fingerprint  sha256 of the evidence the board showed for that visit (photos, products and rates,
 *                         counts, area, protocol version and window); see server/services/tech-protocol-audit.js.
 *
 * A mark counts only while both still match the visit (when set). Old rows keep NULL in both and keep the
 * earlier rule (same technician and month, no record made after the mark). The table's constraints and
 * indexes are untouched. A pushed migration is frozen: a fix is another file.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('tech_protocol_audits'))) return;
  if (!(await knex.schema.hasColumn('tech_protocol_audits', 'reviewed_record_id'))) {
    await knex.schema.alterTable('tech_protocol_audits', (t) => { t.uuid('reviewed_record_id').nullable(); });
  }
  if (!(await knex.schema.hasColumn('tech_protocol_audits', 'evidence_fingerprint'))) {
    await knex.schema.alterTable('tech_protocol_audits', (t) => { t.text('evidence_fingerprint').nullable(); });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('tech_protocol_audits'))) return;
  await knex.schema.alterTable('tech_protocol_audits', (t) => {
    t.dropColumn('reviewed_record_id');
    t.dropColumn('evidence_fingerprint');
  });
};

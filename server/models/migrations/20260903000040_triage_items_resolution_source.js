/**
 * Triage auto-resolution audit trail — who closed the card.
 *
 * `triage_items.resolution_source` ('auto' | 'human' | NULL). The nightly
 * auto-resolve sweep stamps 'auto'; the admin-triage verdict / dismiss /
 * resolve / apply-property-roles transitions stamp 'human'. Event-driven
 * resolvers (email fanout, recording supersede, hallucination dismissal)
 * keep NULL — they were never distinguishable in the UI and this lane does
 * not change that. Before this column the only marker was the free-text
 * "Auto-resolved:" prefix of resolution_note. Additive and reversible; no
 * CHECK, matching the table's status/severity convention.
 */
const TABLE = 'triage_items';
const COL = 'resolution_source';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn(TABLE, COL))) {
    await knex.schema.alterTable(TABLE, (t) => { t.string(COL, 20); });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn(TABLE, COL)) {
    await knex.schema.alterTable(TABLE, (t) => { t.dropColumn(COL); });
  }
};

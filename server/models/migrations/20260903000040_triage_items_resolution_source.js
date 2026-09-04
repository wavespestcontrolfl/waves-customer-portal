/**
 * Triage auto-resolution audit trail — who closed the card.
 *
 * `triage_items.resolution_source` ('auto' | 'human' | NULL). The nightly
 * auto-resolve sweep stamps 'auto'; the admin-triage verdict / dismiss /
 * resolve / apply-property-roles transitions stamp 'human'. Event-driven
 * resolvers (email fanout, recording supersede, hallucination dismissal)
 * keep NULL — they were never distinguishable in the UI and this lane does
 * not change that. Before this column the only marker was the free-text
 * "Auto-resolved:" prefix of resolution_note — so `up` also backfills the
 * cards the sweep closed BEFORE the column existed (terminal rows whose note
 * carries a sweep-owned prefix) to 'auto', or the audit filter would omit
 * them (pre-push codex P1). Idempotent: only NULL rows are stamped.
 * Additive and reversible; no CHECK, matching the table's status/severity
 * convention.
 */
const TABLE = 'triage_items';
const COL = 'resolution_source';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn(TABLE, COL))) {
    await knex.schema.alterTable(TABLE, (t) => { t.string(COL, 20); });
  }
  await knex(TABLE)
    .whereNull(COL)
    .whereIn('status', ['resolved', 'dismissed'])
    .where((q) => q.where('resolution_note', 'like', 'Auto-resolved:%').orWhere('resolution_note', 'like', 'Auto-dismissed:%'))
    .update({ [COL]: 'auto' });
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn(TABLE, COL)) {
    await knex.schema.alterTable(TABLE, (t) => { t.dropColumn(COL); });
  }
};

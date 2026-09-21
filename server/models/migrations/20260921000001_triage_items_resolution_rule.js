/**
 * Triage auto-resolution audit trail — WHICH rule closed the card.
 *
 * `triage_items.resolution_rule` (the auto-resolver's rule key, e.g.
 * 'email_dictation_unambiguous'; NULL for human and event-driven closes).
 * The first-touch ledger must tell a card the resolver closed under
 * GATE_FIRST_TOUCH_AUTO_RELEASE from an operator's approval so the gate can
 * be re-asked at the send; before this column the only marker was the exact
 * text of resolution_note, which a wording change would silently break
 * (pre-push audit P1 on #4622). `up` backfills rows the sweep already closed
 * under that rule by their note text — idempotent, NULL rows only. Additive
 * and reversible; no CHECK, matching the table's convention.
 */
const TABLE = 'triage_items';
const COL = 'resolution_rule';
const DICTATION_RULE = 'email_dictation_unambiguous';
const DICTATION_NOTE = 'Auto-resolved: the email was dictated unambiguously (V1, V2 and the release target agree, no digit doubt, domain accepts mail); released without a read-back.';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn(TABLE, COL))) {
    await knex.schema.alterTable(TABLE, (t) => { t.string(COL, 60); });
  }
  await knex(TABLE)
    .whereNull(COL)
    .where({ resolution_source: 'auto', resolution_note: DICTATION_NOTE })
    .update({ [COL]: DICTATION_RULE });
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn(TABLE, COL)) {
    await knex.schema.alterTable(TABLE, (t) => { t.dropColumn(COL); });
  }
};

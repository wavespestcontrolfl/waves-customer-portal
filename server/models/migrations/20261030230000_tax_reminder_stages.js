/**
 * Tax deadline bells (GATE_TAX_DEADLINE_BELLS, owner 2026-10-30, "All tax
 * deadlines ring"): which reminder stages a filing row has already rung.
 *
 *   tax_filing_calendar.reminder_stages  jsonb, default {}. Stage name to the
 *     ISO time that stage rang: d14, d3, d1, and overdue (the last one rung;
 *     the daily overdue bell is deduped by its own key). Only the 8:23 ET job
 *     writes it, and only while the gate is on.
 *
 * Additive. Idempotent (hasColumn). reminder_sent / reminder_sent_at stay as
 * they are.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('tax_filing_calendar', 'reminder_stages'))) {
    await knex.schema.alterTable('tax_filing_calendar', (t) => {
      t.jsonb('reminder_stages').notNullable().defaultTo('{}');
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('tax_filing_calendar', 'reminder_stages')) {
    await knex.schema.alterTable('tax_filing_calendar', (t) => {
      t.dropColumn('reminder_stages');
    });
  }
};

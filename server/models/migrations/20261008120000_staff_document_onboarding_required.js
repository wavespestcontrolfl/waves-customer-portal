/**
 * "Required at onboarding" flag on a staff document (GATE_STAFF_ONBOARDING_DOCS, owner 2026-10-08).
 *
 *   document_templates.onboarding_required   boolean NOT NULL DEFAULT false
 *
 * An admin sets it from the staff documents page. Existing rows get false, so nothing is
 * required or assigned until an admin turns a document on. The migration seeds nothing.
 *
 * CHECK document_templates_onboarding_staff_only: only a staff document can be required, so the
 * customer-facing templates that share this table can never be picked up by the assignment code.
 *
 * The column is not evidence: document_templates has no immutability trigger, and the flag can be
 * switched off again (the open records it already created stay, as every open staff record does).
 *
 * down() drops the check and the column. That loses only the flag, never a signature or a record.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('document_templates', 'onboarding_required'))) {
    await knex.schema.alterTable('document_templates', (t) => {
      t.boolean('onboarding_required').notNullable().defaultTo(false);
    });
  }
  await knex.raw('ALTER TABLE document_templates DROP CONSTRAINT IF EXISTS document_templates_onboarding_staff_only');
  await knex.raw(`ALTER TABLE document_templates ADD CONSTRAINT document_templates_onboarding_staff_only
    CHECK (onboarding_required = false OR audience = 'staff')`);
};

exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE document_templates DROP CONSTRAINT IF EXISTS document_templates_onboarding_staff_only');
  if (await knex.schema.hasColumn('document_templates', 'onboarding_required')) {
    await knex.schema.alterTable('document_templates', (t) => t.dropColumn('onboarding_required'));
  }
};

// Consent artifact for on-location service contacts (third-party SMS
// recipients). Stamped when the account holder attests, from the portal
// property editor, that each listed person agreed to receive service
// texts. Recipient-level double opt-in is a separate follow-up; these
// columns record who attested, when, and which disclosure text they saw.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customers'))) return;
  if (!(await knex.schema.hasColumn('customers', 'service_contacts_consent_at'))) {
    await knex.schema.alterTable('customers', (t) => {
      t.timestamp('service_contacts_consent_at', { useTz: true }).nullable();
    });
  }
  if (!(await knex.schema.hasColumn('customers', 'service_contacts_consent_source'))) {
    await knex.schema.alterTable('customers', (t) => {
      t.string('service_contacts_consent_source', 40).nullable();
    });
  }
  if (!(await knex.schema.hasColumn('customers', 'service_contacts_consent_text_version'))) {
    await knex.schema.alterTable('customers', (t) => {
      t.string('service_contacts_consent_text_version', 40).nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customers'))) return;
  if (await knex.schema.hasColumn('customers', 'service_contacts_consent_at')) {
    await knex.schema.alterTable('customers', (t) => {
      t.dropColumn('service_contacts_consent_at');
    });
  }
  if (await knex.schema.hasColumn('customers', 'service_contacts_consent_source')) {
    await knex.schema.alterTable('customers', (t) => {
      t.dropColumn('service_contacts_consent_source');
    });
  }
  if (await knex.schema.hasColumn('customers', 'service_contacts_consent_text_version')) {
    await knex.schema.alterTable('customers', (t) => {
      t.dropColumn('service_contacts_consent_text_version');
    });
  }
};

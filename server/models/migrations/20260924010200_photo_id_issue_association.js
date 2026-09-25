/**
 * Smallest customer Photo ID issue association. Existing identifications stay
 * unassociated; new customer pest submissions opt in behind the route gate.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pest_identifications'))) return;

  if (!(await knex.schema.hasTable('photo_id_issues'))) {
    await knex.schema.createTable('photo_id_issues', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.uuid('property_id').nullable().references('id').inTable('customer_properties').onDelete('SET NULL');
      t.string('area', 30).nullable();
      t.timestamps(true, true);

      t.index(['customer_id', 'property_id', 'created_at'], 'photo_id_issues_customer_property_created_idx');
    });
  }

  if (!(await knex.schema.hasColumn('pest_identifications', 'issue_id'))) {
    await knex.schema.alterTable('pest_identifications', (t) => {
      t.uuid('issue_id').nullable().references('id').inTable('photo_id_issues').onDelete('SET NULL');
      t.index(['issue_id', 'created_at'], 'pest_identifications_issue_created_idx');
    });
  }
  if (!(await knex.schema.hasColumn('pest_identifications', 'observed_on'))) {
    await knex.schema.alterTable('pest_identifications', (t) => {
      t.date('observed_on').nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pest_identifications'))) return;

  if (await knex.schema.hasColumn('pest_identifications', 'observed_on')) {
    await knex.schema.alterTable('pest_identifications', (t) => { t.dropColumn('observed_on'); });
  }
  if (await knex.schema.hasColumn('pest_identifications', 'issue_id')) {
    await knex.schema.alterTable('pest_identifications', (t) => { t.dropColumn('issue_id'); });
  }
  if (await knex.schema.hasTable('photo_id_issues')) {
    await knex.schema.dropTable('photo_id_issues');
  }
};

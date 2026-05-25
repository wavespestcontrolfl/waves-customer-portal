exports.up = async function up(knex) {
  const hasVariants = await knex.schema.hasTable('sms_template_variants');
  if (!hasVariants) {
    await knex.schema.createTable('sms_template_variants', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('template_key', 120).notNullable();
      t.string('variant_key', 120).notNullable();
      t.string('name', 200);
      t.text('body').notNullable();
      t.integer('weight').notNullable().defaultTo(1);
      t.string('status', 20).notNullable().defaultTo('active');
      t.boolean('is_control').notNullable().defaultTo(false);
      t.jsonb('metadata').notNullable().defaultTo('{}');
      t.timestamps(true, true);

      t.unique(['template_key', 'variant_key']);
      t.index(['template_key', 'status']);
    });
  }

  const hasChecks = await knex.schema.hasTable('sms_contact_compliance_checks');
  if (!hasChecks) {
    await knex.schema.createTable('sms_contact_compliance_checks', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('phone_hash', 64).notNullable();
      t.string('phone_last4', 4).notNullable();
      t.string('source', 40).notNullable().defaultTo('manual');
      t.string('line_type', 40);
      t.string('carrier', 120);
      t.boolean('dnc_listed');
      t.boolean('reassigned_risk');
      t.timestamp('consent_checked_at', { useTz: true });
      t.jsonb('raw_result').notNullable().defaultTo('{}');
      t.timestamp('checked_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamps(true, true);

      t.index(['phone_hash', 'checked_at']);
      t.index(['dnc_listed']);
      t.index(['reassigned_risk']);
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('sms_contact_compliance_checks');
  await knex.schema.dropTableIfExists('sms_template_variants');
};

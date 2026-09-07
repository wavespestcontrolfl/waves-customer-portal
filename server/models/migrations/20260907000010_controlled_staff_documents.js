// Extends the template/version library; staff issuance never uses customer delivery.
exports.up = async function up(knex) {
  await knex.schema.createTable('policy_values', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.integer('revision').notNullable().unique();
    t.jsonb('values').notNullable();
    t.timestamp('effective_at', { useTz: true }).notNullable().unique();
    t.string('content_hash', 64).notNullable();
    t.uuid('approved_by').notNullable().references('id').inTable('technicians');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.alterTable('document_templates', t => {
    t.string('staff_kind', 20);
    t.string('staff_access', 20);
    t.uuid('legacy_company_document_id').references('id').inTable('company_documents');
  });
  await knex.schema.alterTable('document_template_versions', t => {
    t.jsonb('staff_metadata');
    t.jsonb('content_snapshot');
    t.string('content_hash', 64);
    t.timestamp('effective_at', { useTz: true });
    t.uuid('policy_values_id').references('id').inTable('policy_values');
    t.uuid('approved_by').references('id').inTable('technicians');
  });
  await knex.raw(`ALTER TABLE document_templates ADD CONSTRAINT staff_document_kind CHECK
    ((audience = 'staff' AND staff_kind IS NOT NULL AND staff_access IS NOT NULL AND staff_kind IN ('policy','procedure','form') AND staff_access IN ('staff','admin'))
      OR (audience <> 'staff' AND staff_kind IS NULL AND staff_access IS NULL))`);
  await knex.schema.createTable('staff_document_acknowledgments', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('version_id').notNullable().references('id').inTable('document_template_versions');
    t.uuid('technician_id').notNullable().references('id').inTable('technicians');
    t.string('content_hash', 64).notNullable();
    t.string('signed_name', 180).notNullable();
    t.text('statement').notNullable();
    t.timestamp('acknowledged_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['version_id', 'technician_id']);
  });
  await knex.schema.createTable('staff_document_records', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('version_id').notNullable().references('id').inTable('document_template_versions');
    t.string('content_hash', 64).notNullable();
    t.uuid('created_by').notNullable().references('id').inTable('technicians');
    t.uuid('owner_id').notNullable().references('id').inTable('technicians');
    t.timestamp('due_at', { useTz: true }).notNullable();
    t.jsonb('answers').notNullable().defaultTo('{}');
    t.jsonb('completed_steps').notNullable().defaultTo('[]');
    t.timestamp('completed_at', { useTz: true });
    t.timestamps(true, true);
    t.index(['owner_id', 'due_at']);
  });
  // Published evidence is immutable even if a generic template writer is used.
  await knex.raw(`CREATE FUNCTION protect_staff_document_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_TABLE_NAME = 'document_template_versions' THEN
        IF OLD.content_snapshot IS NULL THEN
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END IF;
      END IF;
      IF TG_TABLE_NAME = 'staff_document_records' THEN
        IF OLD.completed_at IS NULL THEN
          IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Staff records cannot be deleted'; END IF;
          RETURN NEW;
        END IF;
      END IF;
      RAISE EXCEPTION 'Issued staff document evidence is immutable';
    END $$`);
  for (const table of ['document_template_versions', 'policy_values', 'staff_document_acknowledgments', 'staff_document_records']) {
    await knex.raw('CREATE TRIGGER protect_staff_evidence BEFORE UPDATE OR DELETE ON ?? FOR EACH ROW EXECUTE FUNCTION protect_staff_document_evidence()', [table]);
  }
};

exports.down = async function down(knex) {
  if (await knex('document_templates').where({ audience: 'staff' }).first('id') || await knex('policy_values').first('id')) {
    throw new Error('Controlled staff documents contain history. Preserve the schema and roll forward; do not delete document evidence.');
  }
  for (const table of ['document_template_versions', 'policy_values', 'staff_document_acknowledgments', 'staff_document_records']) {
    await knex.raw('DROP TRIGGER protect_staff_evidence ON ??', [table]);
  }
  await knex.raw('DROP FUNCTION protect_staff_document_evidence()');
  await knex.schema.dropTable('staff_document_records');
  await knex.schema.dropTable('staff_document_acknowledgments');
  await knex.schema.alterTable('document_template_versions', t => t.dropColumns('staff_metadata', 'content_snapshot', 'content_hash', 'effective_at', 'policy_values_id', 'approved_by'));
  await knex.raw('ALTER TABLE document_templates DROP CONSTRAINT staff_document_kind');
  await knex.schema.alterTable('document_templates', t => t.dropColumns('staff_kind', 'staff_access', 'legacy_company_document_id'));
  await knex.schema.dropTable('policy_values');
};

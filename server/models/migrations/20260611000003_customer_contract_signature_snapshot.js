exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_contracts'))) return;

  const contractInfo = await knex('customer_contracts').columnInfo().catch(() => ({}));
  if (!contractInfo.requires_signature_snapshot) {
    await knex.schema.alterTable('customer_contracts', (t) => {
      t.boolean('requires_signature_snapshot');
    });
  }

  if (await knex.schema.hasTable('document_templates')) {
    await knex.raw(`
      UPDATE customer_contracts AS cc
      SET requires_signature_snapshot = COALESCE(dt.requires_signature, true)
      FROM document_templates AS dt
      WHERE cc.contract_type = 'document_template'
        AND cc.document_template_id = dt.id
        AND cc.requires_signature_snapshot IS NULL
    `);
  }

  await knex('customer_contracts')
    .where({ contract_type: 'document_template' })
    .whereNull('requires_signature_snapshot')
    .update({ requires_signature_snapshot: true });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customer_contracts'))) return;
  const contractInfo = await knex('customer_contracts').columnInfo().catch(() => ({}));
  if (!contractInfo.requires_signature_snapshot) return;
  await knex.schema.alterTable('customer_contracts', (t) => {
    t.dropColumn('requires_signature_snapshot');
  });
};

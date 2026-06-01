const DEFAULT_TEMPLATES = [
  {
    template_key: 'service_agreement.residential_pest',
    name: 'Residential Pest Service Agreement',
    category: 'service_agreement',
    document_type: 'service_agreement',
    description: 'Reusable service agreement scaffold for recurring residential pest service.',
    tags: ['agreement', 'recurring', 'residential'],
    requires_signature: true,
    title: 'Residential Pest Service Agreement',
    body: [
      'Residential Pest Service Agreement',
      '',
      'Customer: {{customer.name}}',
      'Service address: {{customer.address}}',
      'Service plan: {{service.name}}',
      'Start date: {{agreement.start_date}}',
      '',
      'Waves Pest Control, LLC will provide the services described in the customer account, estimate, or written scope associated with this agreement. Service frequency, target pests, access notes, and pricing should be confirmed before work begins.',
      '',
      'Customer responsibilities: provide safe access to service areas, disclose known hazards, follow preparation instructions, and notify Waves of pest activity changes between visits.',
      '',
      'Cancellation and changes: either party may request changes in writing. Any required renewal, cancellation, or notice terms should be reviewed before sending this agreement.',
      '',
      'Electronic signature: by signing, the customer confirms that they reviewed this agreement and intend to sign it electronically.',
    ].join('\n'),
    variables: [
      'customer.name',
      'customer.address',
      'service.name',
      'agreement.start_date',
    ],
  },
  {
    template_key: 'notice.wdo_inspection',
    name: 'WDO Inspection Notice',
    category: 'wdo',
    document_type: 'wdo_notice',
    description: 'Pre-inspection notice for Wood-Destroying Organism inspection appointments.',
    tags: ['wdo', 'inspection', 'notice'],
    requires_signature: true,
    title: 'WDO Inspection Notice',
    body: [
      'Wood-Destroying Organism Inspection Notice',
      '',
      'Customer: {{customer.name}}',
      'Property: {{customer.address}}',
      'Inspection date: {{inspection.date}}',
      '',
      'This notice confirms that Waves Pest Control is scheduled to inspect visible and accessible areas of the property for wood-destroying organism activity or conducive conditions. Inaccessible areas, concealed damage, stored items, and areas blocked by finishes or personal property may limit findings.',
      '',
      'The inspection report is a point-in-time record. It does not replace repair estimates, structural engineering review, or seller disclosure obligations.',
      '',
      'Customer acknowledgement: by signing, the customer confirms the inspection scope and access limitations have been reviewed.',
    ].join('\n'),
    variables: [
      'customer.name',
      'customer.address',
      'inspection.date',
    ],
  },
  {
    template_key: 'prep.bed_bug',
    name: 'Bed Bug Preparation Form',
    category: 'prep_form',
    document_type: 'prep_form',
    description: 'Customer acknowledgement for bed bug treatment preparation.',
    tags: ['prep', 'bed_bug'],
    requires_signature: true,
    title: 'Bed Bug Treatment Preparation Form',
    body: [
      'Bed Bug Treatment Preparation Form',
      '',
      'Customer: {{customer.name}}',
      'Service address: {{customer.address}}',
      'Appointment date: {{service.date}}',
      '',
      'Before service, remove clutter from sleeping areas, launder bedding and washable fabrics on high heat where appropriate, and keep treated rooms accessible. Do not move infested furniture or belongings to unaffected rooms unless Waves instructs you to do so.',
      '',
      'After service, follow technician instructions for re-entry, vacuuming, laundering, and follow-up monitoring. Activity may continue while the treatment plan takes effect.',
      '',
      'Customer acknowledgement: by signing, the customer confirms they reviewed the preparation steps and understands that incomplete preparation can reduce treatment effectiveness.',
    ].join('\n'),
    variables: [
      'customer.name',
      'customer.address',
      'service.date',
    ],
  },
];

exports.up = async function up(knex) {
  const hasTemplates = await knex.schema.hasTable('document_templates');
  if (!hasTemplates) {
    await knex.schema.createTable('document_templates', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('template_key', 120).notNullable().unique();
      t.string('name', 180).notNullable();
      t.string('category', 80).notNullable().defaultTo('general');
      t.string('document_type', 80).notNullable().defaultTo('other');
      t.string('status', 30).notNullable().defaultTo('active');
      t.text('description');
      t.boolean('requires_signature').notNullable().defaultTo(true);
      t.string('audience', 60).notNullable().defaultTo('customer');
      t.jsonb('variables').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
      t.jsonb('tags').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
      t.uuid('active_version_id');
      t.uuid('created_by').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.uuid('updated_by').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.timestamps(true, true);

      t.index(['status', 'category'], 'idx_document_templates_status_category');
      t.index(['document_type'], 'idx_document_templates_document_type');
    });
  }

  const hasVersions = await knex.schema.hasTable('document_template_versions');
  if (!hasVersions) {
    await knex.schema.createTable('document_template_versions', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('template_id').notNullable().references('id').inTable('document_templates').onDelete('CASCADE');
      t.integer('version_number').notNullable();
      t.string('title', 220).notNullable();
      t.text('body').notNullable();
      t.text('signer_disclosure');
      t.jsonb('variables').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
      t.jsonb('required_fields').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
      t.uuid('created_by').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.timestamp('published_at', { useTz: true });
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.unique(['template_id', 'version_number'], 'uniq_document_template_version_number');
      t.index(['template_id', 'created_at'], 'idx_document_template_versions_template_created');
    });
  }

  const contractInfo = await knex('customer_contracts').columnInfo().catch(() => ({}));
  await knex.schema.alterTable('customer_contracts', (t) => {
    if (!contractInfo.document_template_id) {
      t.uuid('document_template_id').nullable().references('id').inTable('document_templates').onDelete('SET NULL');
    }
    if (!contractInfo.document_template_version_id) {
      t.uuid('document_template_version_id').nullable().references('id').inTable('document_template_versions').onDelete('SET NULL');
    }
    if (!contractInfo.document_template_key) {
      t.string('document_template_key', 120);
    }
    if (!contractInfo.document_variables_snapshot) {
      t.jsonb('document_variables_snapshot').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    }
    if (!contractInfo.document_render_summary) {
      t.jsonb('document_render_summary').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    }
  });

  for (const seed of DEFAULT_TEMPLATES) {
    const existing = await knex('document_templates').where({ template_key: seed.template_key }).first();
    let template = existing;
    if (!template) {
      [template] = await knex('document_templates').insert({
        template_key: seed.template_key,
        name: seed.name,
        category: seed.category,
        document_type: seed.document_type,
        status: 'active',
        description: seed.description,
        requires_signature: seed.requires_signature,
        variables: JSON.stringify(seed.variables),
        tags: JSON.stringify(seed.tags),
      }).returning('*');
    }

    const activeVersion = await knex('document_template_versions')
      .where({ template_id: template.id, version_number: 1 })
      .first();
    let version = activeVersion;
    if (!version) {
      [version] = await knex('document_template_versions').insert({
        template_id: template.id,
        version_number: 1,
        title: seed.title,
        body: seed.body,
        signer_disclosure: 'I agree to receive and sign this document electronically.',
        variables: JSON.stringify(seed.variables),
        required_fields: JSON.stringify(['initials', 'signedName']),
        published_at: knex.fn.now(),
      }).returning('*');
    }

    if (!template.active_version_id && version?.id) {
      await knex('document_templates').where({ id: template.id }).update({
        active_version_id: version.id,
        updated_at: knex.fn.now(),
      });
    }
  }
};

exports.down = async function down(knex) {
  const contractInfo = await knex('customer_contracts').columnInfo().catch(() => ({}));
  await knex.schema.alterTable('customer_contracts', (t) => {
    if (contractInfo.document_render_summary) t.dropColumn('document_render_summary');
    if (contractInfo.document_variables_snapshot) t.dropColumn('document_variables_snapshot');
    if (contractInfo.document_template_key) t.dropColumn('document_template_key');
    if (contractInfo.document_template_version_id) t.dropColumn('document_template_version_id');
    if (contractInfo.document_template_id) t.dropColumn('document_template_id');
  });
  await knex.schema.dropTableIfExists('document_template_versions');
  await knex.schema.dropTableIfExists('document_templates');
};

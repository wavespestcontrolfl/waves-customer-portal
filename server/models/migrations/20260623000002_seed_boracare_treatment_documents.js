// Seeds two Bora-Care wood-treatment documents into the existing document
// template library (tables created in 20260601000009_document_template_library):
//   1. Bora-Care Treatment Outline  — informational scope of the treatment.
//   2. Bora-Care Treatment Agreement — signable contract that explicitly
//      states the treatment includes no retreatment and no repair.
// Bora-Care is the one-time borate wood treatment applied to bare attic
// framing / surface wood during an attic remediation. Until now it carried no
// outline or contract document of its own.
const DEFAULT_TEMPLATES = [
  {
    template_key: 'treatment_outline.bora_care',
    name: 'Bora-Care Treatment Outline',
    category: 'treatment_outline',
    document_type: 'treatment_outline',
    description: 'Informational outline of the Bora-Care borate wood treatment applied during attic remediation.',
    tags: ['treatment_outline', 'bora_care', 'attic', 'termite'],
    requires_signature: false,
    title: 'Bora-Care Wood Treatment — Treatment Outline',
    body: [
      'Bora-Care Wood Treatment — Treatment Outline',
      '',
      'Customer: {{customer.name}}',
      'Service address: {{customer.address}}',
      'Treatment date: {{service.date}}',
      '',
      'What Bora-Care is: Bora-Care is a borate-based wood treatment applied to bare, accessible wood. It protects treated wood against subterranean and drywood termites, wood-boring beetles, and wood-decay fungi.',
      '',
      'Where it is applied: Waves Pest Control applies Bora-Care to the measured attic framing and accessible bare-wood surface areas (such as exposed framing and block) identified during the attic remediation. Only bare wood that is accessible at the time of service can be treated.',
      '',
      'What this treatment does not include: This is a one-time treatment. It does not include retreatment, repair of existing or future wood or structural damage, or any ongoing service plan or warranty. These terms are confirmed in the separate Bora-Care Treatment Agreement.',
      '',
      'Customer preparation: Provide safe access to the attic and any surface areas to be treated, clear stored items where needed, and follow technician instructions for re-entry after application.',
    ].join('\n'),
    variables: [
      'customer.name',
      'customer.address',
      'service.date',
    ],
  },
  {
    template_key: 'service_agreement.bora_care',
    name: 'Bora-Care Treatment Agreement',
    category: 'service_agreement',
    document_type: 'service_agreement',
    description: 'Signable Bora-Care wood treatment agreement for attic remediation. States no retreatment or repair.',
    tags: ['agreement', 'bora_care', 'attic', 'termite'],
    requires_signature: true,
    title: 'Bora-Care Wood Treatment Agreement',
    body: [
      'Bora-Care Wood Treatment Agreement',
      '',
      'Customer: {{customer.name}}',
      'Service address: {{customer.address}}',
      'Treatment date: {{service.date}}',
      '',
      'Scope of service: Waves Pest Control, LLC will apply Bora-Care borate wood treatment to the measured attic framing and accessible bare-wood surface areas associated with the attic remediation described in the customer’s estimate or written scope.',
      '',
      'No retreatment or repair: This is a one-time Bora-Care borate wood treatment. It carries no warranty, guarantee, or service plan. Waves Pest Control provides no retreatment and no repair of any wood damage, structural damage, or future infestation. Bora-Care treats only the bare wood surfaces accessible and treated at the time of service.',
      '',
      'Customer responsibilities: Provide safe access to all areas to be treated, disclose known hazards, and follow technician instructions for re-entry after application. Areas that are inaccessible, concealed, or not bare wood at the time of service cannot be treated.',
      '',
      'Electronic signature: By signing, the customer confirms they reviewed this agreement, understand that this service includes no retreatment and no repair, and intend to sign it electronically.',
    ].join('\n'),
    variables: [
      'customer.name',
      'customer.address',
      'service.date',
    ],
  },
];

exports.up = async function up(knex) {
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
        signer_disclosure: seed.requires_signature
          ? 'I agree to receive and sign this document electronically.'
          : null,
        variables: JSON.stringify(seed.variables),
        required_fields: JSON.stringify(seed.requires_signature ? ['initials', 'signedName'] : []),
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
  // Only remove the rows this migration seeds — the tables are owned by
  // 20260601000009_document_template_library and must stay intact.
  const keys = DEFAULT_TEMPLATES.map((t) => t.template_key);
  const templates = await knex('document_templates').whereIn('template_key', keys).select('id');
  const ids = templates.map((t) => t.id);
  if (ids.length) {
    // Detach active_version_id before deleting versions (FK from versions table is CASCADE).
    await knex('document_templates').whereIn('id', ids).update({ active_version_id: null });
    await knex('document_template_versions').whereIn('template_id', ids).del();
    await knex('document_templates').whereIn('id', ids).del();
  }
};

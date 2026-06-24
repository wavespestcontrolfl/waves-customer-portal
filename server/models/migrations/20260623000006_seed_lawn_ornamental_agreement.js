// Seeds the signable Lawn & Ornamental Service Agreement into the existing
// document template library (tables created in 20260601000009). Lawn care
// previously reused the residential pest agreement, which lacks the
// results-not-guaranteed / customer-responsibility terms lawn needs. Per
// owner decision (2026-06-24): covers lawn (turf) + tree & shrub
// (ornamental); no guarantee of specific results but free re-service between
// scheduled visits; ongoing program cancellable anytime with written notice.
// Scope/pricing are per-account variables from the estimate or written scope.
const DEFAULT_TEMPLATES = [
  {
    template_key: 'service_agreement.lawn_ornamental',
    name: 'Lawn & Ornamental Service Agreement',
    category: 'service_agreement',
    document_type: 'service_agreement',
    description: 'Signable lawn (turf) + tree & shrub (ornamental) service agreement. Results not guaranteed; free re-service between visits; ongoing, cancel anytime.',
    tags: ['agreement', 'lawn', 'turf', 'ornamental', 'tree_shrub', 'recurring'],
    requires_signature: true,
    title: 'Lawn & Ornamental Service Agreement',
    body: [
      'Lawn & Ornamental Service Agreement',
      '',
      'Customer: {{customer.name}}',
      'Service address: {{customer.address}}',
      'Service plan: {{service.name}}',
      'Start date: {{agreement.start_date}}',
      '',
      'Scope of service: Waves Pest Control, LLC will provide the lawn (turf) and tree & shrub (ornamental) care services described in the customer account, estimate, or written scope associated with this agreement. The program may include fertilization, weed control, and insect and disease (fungus) management appropriate to the turf type, landscape, season, and Florida label and ordinance limits. Service frequency, treated areas, and pricing are confirmed before service begins.',
      '',
      'Results and re-service: Lawn and ornamental results depend on many factors outside Waves’ control — watering and irrigation, mowing practices, soil and drainage, weather, shade, foot and pet traffic, existing pest or disease pressure, and prior lawn condition. For these reasons Waves does not guarantee specific results, green-up, or the complete elimination of weeds, insects, or disease. If covered activity appears between scheduled visits, Waves will provide a free re-service visit on request during the active program.',
      '',
      'Customer responsibilities: Maintain proper watering and irrigation and mow at the recommended height per Waves’ guidance, provide safe access to all treated areas, keep pets and people off treated areas until they have dried, and report concerns promptly so Waves can respond. Conditions the customer was advised to correct (irrigation, drainage, mowing, thatch, soil) and did not are not Waves’ responsibility.',
      '',
      'Notices and re-entry: Service is performed by licensed applicators using EPA-registered products applied per label directions. Where required, application notices are posted and re-entry guidance is provided; follow the technician’s re-entry instructions for treated areas.',
      '',
      'Term and cancellation: This is an ongoing program with no fixed term. Either party may cancel at any time with written notice. Charges for services already performed remain due.',
      '',
      'Limitation: Waves is not responsible for pre-existing lawn or landscape damage, loss caused by conditions outside its control, or activity arising from conditions the customer was advised to correct and did not. This agreement does not guarantee specific results; Waves commits to the agreed program and free re-service between scheduled visits.',
      '',
      'Electronic signature: By signing, the customer confirms they reviewed this agreement, understand that specific results are not guaranteed and that free re-service is available between visits, and intend to sign it electronically.',
    ].join('\n'),
    variables: [
      'customer.name',
      'customer.address',
      'service.name',
      'agreement.start_date',
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
  // Only remove the rows this migration seeds — the tables are owned by
  // 20260601000009_document_template_library and must stay intact.
  const keys = DEFAULT_TEMPLATES.map((t) => t.template_key);
  const templates = await knex('document_templates').whereIn('template_key', keys).select('id');
  const ids = templates.map((t) => t.id);
  if (ids.length) {
    await knex('document_templates').whereIn('id', ids).update({ active_version_id: null });
    await knex('document_template_versions').whereIn('template_id', ids).del();
    await knex('document_templates').whereIn('id', ids).del();
  }
};

// Seeds the signable Commercial Pest Service Agreement into the existing
// document template library (tables created in 20260601000009). Commercial
// accounts previously signed the residential pest agreement, which lacks the
// terms a business needs. Per owner decision (2026-06-24): Net 30 billing,
// 12-month term auto-renewing year-to-year with 30-day written non-renewal
// notice, 30-day written cancellation, and a certificate of insurance plus
// additional-insured status on request. Scope/pricing are per-account
// variables filled in from the estimate or written scope of work.
const DEFAULT_TEMPLATES = [
  {
    template_key: 'service_agreement.commercial_pest',
    name: 'Commercial Pest Service Agreement',
    category: 'service_agreement',
    document_type: 'service_agreement',
    description: 'Signable commercial pest service agreement: Net 30, 12-month auto-renewing term, 30-day cancellation, COI/additional-insured on request.',
    tags: ['agreement', 'commercial', 'recurring', 'pest'],
    requires_signature: true,
    title: 'Commercial Pest Service Agreement',
    body: [
      'Commercial Pest Service Agreement',
      '',
      'Business / account: {{customer.name}}',
      'Service location(s): {{customer.address}}',
      'Service plan: {{service.name}}',
      'Start date: {{agreement.start_date}}',
      '',
      'Scope of service: Waves Pest Control, LLC will provide the commercial pest services described in the customer account, estimate, or written scope of work associated with this agreement. Service frequency, covered pests, treated areas, access requirements, and pricing are confirmed in that scope before service begins. Additional or specialty work outside the agreed scope is quoted separately and is not performed without authorization.',
      '',
      'Term and renewal: This agreement begins on the start date shown and continues for an initial term of twelve (12) months. After the initial term it renews automatically for successive twelve (12) month terms unless either party gives written notice of non-renewal at least thirty (30) days before the end of the then-current term.',
      '',
      'Billing and payment: Services are invoiced on Net 30 terms — payment is due within thirty (30) days of the invoice date. Past-due balances may be subject to a late fee and/or suspension of service until the account is brought current. Pricing may be adjusted at renewal or with at least thirty (30) days’ written notice.',
      '',
      'Cancellation: Either party may cancel this agreement with thirty (30) days’ written notice. Charges for services already performed remain due through the effective date of cancellation.',
      '',
      'Insurance: Waves Pest Control, LLC is licensed and insured. A certificate of insurance will be provided on request, and Waves will name the customer as an additional insured on request.',
      '',
      'Customer responsibilities: Provide safe and timely access to all service areas, disclose known hazards and sensitive areas (food handling, sensitive equipment, and similar), maintain sanitation and structural conditions that support effective pest control, and notify Waves of pest activity or facility changes between visits.',
      '',
      'Service standards: Service is performed by licensed applicators using EPA-registered products applied per label directions, with service documentation available for the customer’s records and regulatory or audit needs.',
      '',
      'Limitation: Waves is not responsible for pre-existing conditions, structural or sanitation deficiencies outside its control, or activity arising from conditions the customer was advised to correct and did not. This agreement does not guarantee the complete absence of pests; Waves commits to the agreed service program and prompt response to covered activity between scheduled visits.',
      '',
      'Electronic signature: By signing, the authorized representative confirms they have authority to bind the business, have reviewed this agreement, and intend to sign it electronically.',
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

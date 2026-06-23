// Seeds the signable Rodent Exclusion Guarantee into the existing document
// template library (tables created in 20260601000009_document_template_library).
// The rodent guarantee terms already exist as an internal SOP
// (20260415000017_seed_rodent_guarantee_docs) but had no customer-signed
// document. Per owner decision (2026-06-23): annual price is a per-customer
// variable ({{guarantee.annual_price}}, currently $199/yr) and the full
// 7-item exclusions list from the SOP is stated verbatim.
const DEFAULT_TEMPLATES = [
  {
    template_key: 'service_agreement.rodent_exclusion_guarantee',
    name: 'Rodent Exclusion Guarantee Agreement',
    category: 'service_agreement',
    document_type: 'service_agreement',
    description: 'Signable annual rodent exclusion guarantee: up to 4 callbacks in 12 months, re-sealing of original exclusion points. Lists covered/not-covered terms and renewal rules.',
    tags: ['agreement', 'rodent', 'guarantee', 'exclusion', 'callback', 'warranty'],
    requires_signature: true,
    title: 'Rodent Exclusion Guarantee Agreement',
    body: [
      'Rodent Exclusion Guarantee Agreement',
      '',
      'Customer: {{customer.name}}',
      'Property address: {{customer.address}}',
      'Exclusion completion date: {{exclusion.completion_date}}',
      'Guarantee period: 12 months from exclusion completion',
      'Annual price: {{guarantee.annual_price}}',
      '',
      'About this guarantee: The Rodent Exclusion Guarantee is an annual renewal available to customers who completed the full rodent package (trapping plus exclusion) with Waves Pest Control, LLC. It activates upon completion of the exclusion work and covers callback visits for rodent re-entry at the original exclusion points.',
      '',
      'What is covered:',
      '- Up to 4 callback visits within the 12-month guarantee period.',
      '- A full inspection at each callback visit.',
      '- Re-trapping if new activity is confirmed.',
      '- Re-sealing of ORIGINAL exclusion points that have failed or been compromised by normal wear.',
      '- Materials included for re-seal work (copper mesh, expanding foam, caulk, minor hardware cloth patches).',
      '',
      'What is NOT covered:',
      '- New entry points that were not part of the original exclusion scope (quoted separately).',
      '- Damage from hurricanes, tropical storms, or structural settling.',
      '- Entry points created by other contractors, homeowner renovations, or structural modifications.',
      '- Properties that declined recommended vegetation management at the time of exclusion (tree limbs within 3 ft of the structure, overgrown landscaping against the foundation).',
      '- New tree limb contact that developed after the original service.',
      '- Attic insulation remediation or drywall repair.',
      '- Interior damage caused by rodents (chewed wiring, contaminated insulation, staining).',
      '',
      'Enrollment and renewal:',
      '- Must be purchased within 30 days of exclusion completion.',
      '- Renews annually on the exclusion completion anniversary date at the annual price shown.',
      '- Non-refundable once activated.',
      '- This guarantee does NOT auto-renew — the customer must actively opt in at renewal. Renewal reminders are sent 30 days, 14 days, and 3 days before expiration.',
      '- If the guarantee lapses (is not renewed), reinstatement requires a full re-inspection at standard inspection rates before re-enrolling. A free callback will not be dispatched on a lapsed guarantee.',
      '',
      'Customer responsibilities: Provide safe access for inspections and callback work, maintain recommended vegetation clearance around the structure, correct conducive conditions when notified, and report suspected rodent activity promptly.',
      '',
      'Electronic signature: By signing, the customer confirms they reviewed this guarantee, understand what is and is not covered, and intend to sign it electronically.',
    ].join('\n'),
    variables: [
      'customer.name',
      'customer.address',
      'exclusion.completion_date',
      'guarantee.annual_price',
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

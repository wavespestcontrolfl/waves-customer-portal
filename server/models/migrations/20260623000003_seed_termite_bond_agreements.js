// Seeds two signable termite bond agreements into the existing document
// template library (tables created in 20260601000009_document_template_library).
// Waves sells termite bond services (1/5/10-year) but had no customer-signed
// bond document. Per owner decision (2026-06-23):
//   - Two coverage variants: retreatment-only, and repair + retreatment.
//   - Annual renewal required to keep coverage active.
//   - Transferable to a new owner subject to a re-inspection.
//   - One template per variant; bond term + pricing are per-customer variables.
// Exclusion/void language is standard termite-bond scaffolding and is meant to
// be reviewed/edited in the admin template editor.
const DEFAULT_TEMPLATES = [
  {
    template_key: 'service_agreement.termite_bond_retreatment',
    name: 'Termite Retreatment Bond Agreement',
    category: 'service_agreement',
    document_type: 'service_agreement',
    description: 'Signable termite bond covering retreatment only (no repair of termite damage). Annual renewal required; transferable with re-inspection.',
    tags: ['agreement', 'termite', 'bond', 'retreatment', 'warranty'],
    requires_signature: true,
    title: 'Termite Retreatment Bond Agreement',
    body: [
      'Termite Retreatment Bond Agreement',
      '',
      'Customer: {{customer.name}}',
      'Property address: {{customer.address}}',
      'Bond term: {{bond.term}}',
      'Effective date: {{bond.start_date}}',
      'Treatment type: {{treatment.type}}',
      'Initial bond price: {{bond.price}}',
      'Annual renewal: {{bond.renewal_price}}',
      '',
      'Coverage — retreatment only: Waves Pest Control, LLC warrants the covered termite treatment at the property above for the bond term shown. If covered subterranean termite activity is found at the property during the active bond period, Waves will re-treat the affected area(s) at no additional charge. This bond covers RE-TREATMENT ONLY. It does NOT include repair of any termite damage — existing, new, or otherwise — or replacement of any wood, structural, or other materials.',
      '',
      'Annual renewal: This bond must be renewed each year, at the annual renewal amount shown, to keep retreatment coverage active. If a renewal is not paid by its due date, the bond lapses and retreatment coverage ends. Reinstatement after a lapse requires a new inspection and may require a new treatment at current pricing.',
      '',
      'Transfer on sale: This bond may be transferred to a new owner if the property is sold, subject to a transfer re-inspection by Waves and any applicable transfer or inspection fee. Coverage for the new owner begins only after the re-inspection is completed.',
      '',
      'What is not covered / what voids this bond: This bond does not cover, and may be voided by, any of the following: (a) drywood termites or pests other than the covered termite species, unless separately listed; (b) moisture or water intrusion that is not corrected; (c) structural alterations, additions, or new construction at the property after the original treatment; (d) conducive conditions (wood-to-ground contact, debris, mulch against the structure, leaks) that are not corrected; (e) changes to soil grade, landscaping, or the treated zone that disturb the treatment; (f) any treatment or chemical application to the structure by anyone other than Waves; (g) failure to maintain the annual renewal.',
      '',
      'Customer responsibilities: Provide safe access for inspections and retreatment, correct conducive conditions and moisture issues when notified, and notify Waves promptly of suspected termite activity. Allow Waves to perform periodic inspections during the bond term.',
      '',
      'Electronic signature: By signing, the customer confirms they reviewed this agreement, understand that this bond covers retreatment only and does NOT include repair of termite damage, and intend to sign it electronically.',
    ].join('\n'),
    variables: [
      'customer.name',
      'customer.address',
      'bond.term',
      'bond.start_date',
      'treatment.type',
      'bond.price',
      'bond.renewal_price',
    ],
  },
  {
    template_key: 'service_agreement.termite_bond_repair',
    name: 'Termite Repair & Retreatment Bond Agreement',
    category: 'service_agreement',
    document_type: 'service_agreement',
    description: 'Signable termite bond covering retreatment plus repair of new covered termite damage. Annual renewal required; transferable with re-inspection.',
    tags: ['agreement', 'termite', 'bond', 'repair', 'retreatment', 'warranty'],
    requires_signature: true,
    title: 'Termite Repair & Retreatment Bond Agreement',
    body: [
      'Termite Repair & Retreatment Bond Agreement',
      '',
      'Customer: {{customer.name}}',
      'Property address: {{customer.address}}',
      'Bond term: {{bond.term}}',
      'Effective date: {{bond.start_date}}',
      'Treatment type: {{treatment.type}}',
      'Initial bond price: {{bond.price}}',
      'Annual renewal: {{bond.renewal_price}}',
      '',
      'Coverage — retreatment and repair: Waves Pest Control, LLC warrants the covered termite treatment at the property above for the bond term shown. If covered subterranean termite activity is found at the property during the active bond period, Waves will (1) re-treat the affected area(s) at no additional charge, and (2) repair new termite damage caused by covered termite activity that occurs during the active bond period, up to the coverage terms confirmed in writing with this bond. This bond does NOT cover repair of damage that existed before the bond effective date, or damage from termites or pests not covered by this bond.',
      '',
      'Annual renewal: This bond must be renewed each year, at the annual renewal amount shown, to keep retreatment and repair coverage active. If a renewal is not paid by its due date, the bond lapses and coverage ends. Reinstatement after a lapse requires a new inspection and may require a new treatment at current pricing.',
      '',
      'Transfer on sale: This bond may be transferred to a new owner if the property is sold, subject to a transfer re-inspection by Waves and any applicable transfer or inspection fee. Coverage for the new owner begins only after the re-inspection is completed.',
      '',
      'What is not covered / what voids this bond: This bond does not cover, and may be voided by, any of the following: (a) damage existing as of the bond effective date or noted on the initial inspection; (b) drywood termites or pests other than the covered termite species, unless separately listed; (c) moisture or water intrusion that is not corrected; (d) structural alterations, additions, or new construction at the property after the original treatment; (e) conducive conditions (wood-to-ground contact, debris, mulch against the structure, leaks) that are not corrected; (f) changes to soil grade, landscaping, or the treated zone that disturb the treatment; (g) any treatment or chemical application to the structure by anyone other than Waves; (h) failure to maintain the annual renewal.',
      '',
      'Customer responsibilities: Provide safe access for inspections, retreatment, and repair work; correct conducive conditions and moisture issues when notified; and notify Waves promptly of suspected termite activity. Allow Waves to perform periodic inspections during the bond term.',
      '',
      'Electronic signature: By signing, the customer confirms they reviewed this agreement, understand the retreatment and repair coverage and its limits, and intend to sign it electronically.',
    ].join('\n'),
    variables: [
      'customer.name',
      'customer.address',
      'bond.term',
      'bond.start_date',
      'treatment.type',
      'bond.price',
      'bond.renewal_price',
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

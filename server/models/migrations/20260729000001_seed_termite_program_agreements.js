// Seeds two signable termite bait-station PROGRAM agreements into the
// document template library (tables from 20260601000009). The site, the
// comparison sheet, and the service-details guide all promise "your signed
// termite agreement spells out the covered structures and terms" — but the
// library only carried the two BOND agreements (20260623000003), and the
// station program itself (especially the rental structure's hardware terms)
// had no signable document. Per owner decisions:
//   - 2026-07-28: the menu is Trelona-only; monitoring is billed per
//     application on the quarterly station check.
//   - 2026-07-28: the annual renewable warranty is an OPTIONAL bond priced
//     separately — the first year is NOT included with installation, and
//     this agreement must not imply otherwise.
//   - 2026-07-26: rental stations remain Waves property (removed on
//     cancellation); purchased stations belong to the customer permanently.
// One template per ownership structure; prices and dates are per-customer
// variables. Wording is standard scaffolding meant to be reviewed/edited in
// the admin template editor (same posture as the bond seed).
const DEFAULT_TEMPLATES = [
  {
    template_key: 'service_agreement.termite_bait_program_purchase',
    name: 'Termite Bait Station Program Agreement (Purchased Stations)',
    category: 'service_agreement',
    document_type: 'service_agreement',
    description: 'Signable agreement for the Trelona bait-station program with customer-owned stations: one-time installation purchase plus quarterly station checks billed per application. Warranty coverage is a separate optional bond.',
    tags: ['agreement', 'termite', 'bait', 'program', 'purchase'],
    requires_signature: true,
    title: 'Termite Bait Station Program Agreement (Purchased Stations)',
    body: [
      'Termite Bait Station Program Agreement — Purchased Stations',
      '',
      'Customer: {{customer.name}}',
      'Service address: {{customer.address}}',
      'System: {{program.system}}',
      'Installation (one-time, purchased): {{program.install_price}}',
      'Quarterly station check: {{program.per_application}} per application',
      'Program start date: {{agreement.start_date}}',
      '',
      'The program: Waves Pest Control, LLC will install in-ground termite bait stations in accessible soil around the perimeter of the structure at the service address, placed per the product label. The number and location of stations is set by the property and confirmed on the installation report. Waves will check every accessible station on a quarterly schedule, document each check in the customer’s service report (station condition, activity found, bait consumption, cartridges replaced), and replace bait cartridges when the manufacturer’s replacement criteria are met.',
      '',
      'Station ownership — purchased: The stations and in-ground hardware are purchased by the customer with the installation charge shown above and are the customer’s property once installed and paid for. If the program ends for any reason, the stations remain in place at the service address; quarterly service, monitoring, and documentation end with the program.',
      '',
      'Billing: The installation charge is billed once. The quarterly station check is billed per application at the rate shown above. Rates for future periods may be adjusted with advance written notice.',
      '',
      'Warranty is separate and optional: This is a service agreement, not a warranty or bond. Termite warranty coverage (an annual renewable bond) is available separately, is NOT included with installation or with this agreement, and is governed solely by its own signed bond agreement if purchased. Monitoring does not guarantee the absence of termites, and no repair or retreatment coverage is provided under this agreement.',
      '',
      'Cancellation: Either party may end the program with written notice. Amounts for services already performed (including the installation) remain due and are not refunded. The stations remain the customer’s property.',
      '',
      'Customer responsibilities: Provide safe access for scheduled checks; do not open, move, remove, bury, pave over, or damage stations; notify Waves before hardscape, landscaping, irrigation, grading, or construction changes near the structure; and notify Waves promptly of suspected termite activity or a damaged or exposed station.',
      '',
      'Electronic signature: By signing, the customer confirms they reviewed this agreement, understand that the stations are purchased and that warranty coverage is a separate optional bond, and intend to sign it electronically.',
    ].join('\n'),
    variables: [
      'customer.name',
      'customer.address',
      'program.system',
      'program.install_price',
      'program.per_application',
      'agreement.start_date',
    ],
  },
  {
    template_key: 'service_agreement.termite_bait_program_rental',
    name: 'Termite Bait Station Program Agreement (Rented Stations)',
    category: 'service_agreement',
    document_type: 'service_agreement',
    description: 'Signable agreement for the Trelona bait-station program with Waves-owned (rented) stations: no installation charge, hardware rental billed per application alongside the quarterly station check, stations removed on cancellation. Warranty coverage is a separate optional bond.',
    tags: ['agreement', 'termite', 'bait', 'program', 'rental'],
    requires_signature: true,
    title: 'Termite Bait Station Program Agreement (Rented Stations)',
    body: [
      'Termite Bait Station Program Agreement — Rented Stations',
      '',
      'Customer: {{customer.name}}',
      'Service address: {{customer.address}}',
      'System: {{program.system}}',
      'Installation: $0 — hardware installed at no up-front charge',
      'Quarterly station check: {{program.per_application}} per application',
      'Station rental: {{program.rental_per_application}} per application',
      'Total per application: {{program.combined_per_application}}',
      'Program start date: {{agreement.start_date}}',
      '',
      'The program: Waves Pest Control, LLC will install in-ground termite bait stations in accessible soil around the perimeter of the structure at the service address, placed per the product label. The number and location of stations is set by the property and confirmed on the installation report. Waves will check every accessible station on a quarterly schedule, document each check in the customer’s service report (station condition, activity found, bait consumption, cartridges replaced), and replace bait cartridges when the manufacturer’s replacement criteria are met.',
      '',
      'Station ownership — rented: The stations and all in-ground hardware are and remain the property of Waves Pest Control, LLC. The customer pays no installation charge; instead, the station rental amount shown above is billed with each quarterly application for as long as the program runs. The rental is a rental rate, not a payment plan: it does not build ownership or equity in the hardware, and it does not end after the hardware cost is recovered.',
      '',
      'Billing: The quarterly station check and the station rental are billed together, per application, at the rates shown above. Rates for future periods may be adjusted with advance written notice.',
      '',
      'Warranty is separate and optional: This is a service agreement, not a warranty or bond. Termite warranty coverage (an annual renewable bond) is available separately, is NOT included with installation or with this agreement, and is governed solely by its own signed bond agreement if purchased. Monitoring does not guarantee the absence of termites, and no repair or retreatment coverage is provided under this agreement.',
      '',
      'Cancellation and removal: Either party may end the program with written notice. On cancellation, Waves will remove its stations from the property and in-ground protection ends with the program. Amounts for services already performed remain due. The customer’s inspection and service history remains available in their customer portal account.',
      '',
      'Customer responsibilities: Provide safe access for scheduled checks and for station removal on cancellation; do not open, move, remove, bury, pave over, or damage stations; notify Waves before hardscape, landscaping, irrigation, grading, or construction changes near the structure; and notify Waves promptly of suspected termite activity or a damaged or exposed station.',
      '',
      'Electronic signature: By signing, the customer confirms they reviewed this agreement, understand that the stations remain Waves property and are removed if the program ends and that warranty coverage is a separate optional bond, and intend to sign it electronically.',
    ].join('\n'),
    variables: [
      'customer.name',
      'customer.address',
      'program.system',
      'program.per_application',
      'program.rental_per_application',
      'program.combined_per_application',
      'agreement.start_date',
    ],
  },
];

exports.up = async function up(knex) {
  const hasTemplates = await knex.schema.hasTable('document_templates');
  if (!hasTemplates) return;
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

exports.down = async function down() {
  // Deliberate no-op (same posture as 20260726000004): these are CONTENT
  // seeds into an admin-managed library. up() tolerates pre-existing
  // templates and the admin editor can author new versions after seeding,
  // so no rollback can reliably distinguish migration-created rows from
  // admin-owned ones — and customer_contracts references the versions via
  // ON DELETE SET NULL, so a wrong delete would also damage signed-contract
  // provenance. Removing or retiring these templates is an admin-editor
  // operation (set status archived), not a schema rollback.
};

exports.DEFAULT_TEMPLATES = DEFAULT_TEMPLATES;

// Seeds the New Construction Termite Warranty: the written contract Rule
// 5E-14.105(3) F.A.C. requires for every pre-construction subterranean
// termite treatment of a new building (owner 2026-10-23 "ok go and build
// this", decision page claude.ai/artifact/WdVsF6gZYJB1BJoT7qaKEL). Drafted
// from the primary text of Rule 5E-14.105 (as amended 4-29-2025), F.S.
// 482.226(5), 482.227 and 482.2265 with Fable as advisor.
// - Retreatment only; Formosan and Asian subterranean termites covered.
// - Runs from the initial treatment date; issued within 30 days.
// - Builder 1-year plan renewable yearly through year 5 (Massey model),
//   prepaid 5-year and 10-year plans.
// - Lines wrapped in ** print bold (F.S. 482.227 bold statements and
//   headings) on the signing page and the PDF.
// Every job value is a merge field the office fills at issue from the
// pre-treat certificate (client/src/lib/pretreatWarrantyValues.js).
const TEMPLATE = {
  template_key: 'service_agreement.termite_new_construction_warranty',
  name: 'New Construction Termite Warranty',
  category: 'service_agreement',
  document_type: 'service_agreement',
  description: 'Florida new-construction pre-treat warranty (Rule 5E-14.105(3)): retreatment only, runs from the initial treatment date, issued within 30 days, builder 1-year plan renewable through year 5.',
  tags: ['agreement', 'termite', 'pre-treat', 'new construction', 'warranty', 'retreatment'],
  requires_signature: true,
  title: 'New Construction Termite Warranty',
  body: [
    '**WAVES PEST CONTROL, LLC — NEW CONSTRUCTION TERMITE WARRANTY**',
    'Waves Pest Control, LLC · 13649 Luxe Ave #110, Bradenton, FL 34211 · (941) 297-5749 · FDACS License JB351547',
    'Warranty No. {{warranty.number}}',
    '',
    '**RETREATMENT ONLY. THIS WARRANTY DOES NOT COVER DAMAGE REPAIR.**',
    '**THIS WARRANTY HAS CONDITIONS, LIMITATIONS AND EXCLUSIONS. SEE THE BOLD HEADINGS BELOW.**',
    '**COVERS: SUBTERRANEAN TERMITES, INCLUDING FORMOSAN AND ASIAN SUBTERRANEAN TERMITES. DOES NOT COVER DRYWOOD TERMITES OR OTHER WOOD-DESTROYING ORGANISMS.**',
    '',
    '**1. Who this warranty is between**',
    'Waves Pest Control, LLC ("Waves," "we") and the property owner or authorized agent named below ("you"). Owner or agent: {{customer.name}}, {{customer.address}}. Builder: {{project.builder}}.',
    '',
    '**2. Property covered**',
    '{{project.address}} · Lot {{project.lot}} · Permit {{project.permit}}. Structures covered: {{warranty.structures}} Not covered: any structure, addition or slab attached to or next to a building that existed before this treatment. Detached sheds, pools, decks and fences are not covered unless listed above.',
    '',
    '**3. Treatment we performed**',
    'A preventive soil treatment for subterranean termites during construction. No termite infestation was known to be present. Product: {{treatment.product}} ({{treatment.active_ingredient}}) at {{treatment.concentration}}% · {{treatment.gallons}} gallons · {{treatment.sq_ft}} sq ft · {{treatment.linear_ft}} linear ft. Initial treatment date: {{treatment.initial_date}}. {{treatment.final_exterior_line}} Applicator: {{treatment.applicator}}, ID card {{treatment.applicator_id}}.',
    'This warranty runs from the initial treatment date, {{treatment.initial_date}}. We issue it within 30 days of that date.',
    '',
    '**4. Plan and term**',
    'Plan: {{warranty.plan}}, covered through {{warranty.term_end}}. On the Builder 1-Year plan you may renew each year through year 5; we cannot refuse those renewals. After year 5, or after the paid term of a 5-year or 10-year plan, renewal is yearly at our option. Agreement date: the date of the last e-signature below.',
    '',
    '**5. Prices**',
    'Treatment price (paid by {{warranty.payer}}): {{warranty.treatment_price}}. Plan price: {{warranty.plan_price}} (no renewal fee is due during a prepaid term). Annual renewal fee: {{warranty.renewal_fee}}. This fee is fixed for every renewal through year 5. After year 5 we may change it with written notice at least 30 days before a renewal date. Structural repairs: not offered. No bond or insurance company guarantees this work; "bond" in a plan name means our retreatment promise only.',
    '',
    '**6. Renewal**',
    'Renewal is due each year on {{warranty.renewal_due}}. We send a renewal notice about 30 days before. Pay the fee by the due date and coverage continues for one more year. A payment within 30 days after the due date keeps coverage with no gap. After that the warranty ends on the due date; we may reinstate it after an inspection at our standard inspection price.',
    '',
    '**7. Annual inspection**',
    'Each warranty year includes one inspection of the accessible parts of the property for subterranean termites, about every 12 months, at no extra fee. After each inspection we give you a signed report that says whether we found termites, whether we treated, and which product we used.',
    '',
    '**8. What we do if termites appear**',
    'If live subterranean termites infest a covered structure during the warranty period, tell us in writing (text, email or mail). We will inspect within 30 calendar days of your notice, and apply the treatment needed to control the infestation within 90 days of finding it (180 days for commercial or multi-unit buildings), at no charge. If the warranty ends before we can treat, we will offer in writing to treat within 90 days at no cost.',
    '',
    '**CONDITIONS AND LIMITATIONS**',
    '- We do not repair or pay for damage to the structure or its contents. Retreatment is the only remedy.',
    '- Coverage depends on renewal fees being paid when due (section 6).',
    '- You must give us reasonable access to inspect and treat.',
    '- The final exterior treatment must be completed before the home is occupied. If the builder does not allow it, we tell the owner in writing, and the untreated exterior is excluded until it is treated.',
    '- These can break the treated barrier: soil, mulch or landscaping added against the foundation; new slabs, patios or stoops; digging next to the foundation; plumbing or irrigation leaks; wood, siding or stucco touching soil; moisture against the foundation.',
    '- If we find one of these conditions, we tell you in writing within 60 days, and you have 60 days to correct it. We may decline to retreat only if that condition mainly caused the infestation and you did not correct it after our notice.',
    '- Call us before work that disturbs treated soil. We can re-treat the disturbed area for a fee.',
    '',
    '**EXCLUSIONS**',
    '- Drywood termites, wood borers, carpenter ants, fungi and any organism other than subterranean termites.',
    '- Structures not listed in section 2, including later additions.',
    '- Damage of any kind, and conditions caused by moisture or construction defects.',
    '',
    '**9. Treatment notice**',
    'We posted the treatment notice required by section 482.226(5), Florida Statutes: {{warranty.notice_location}}. Only the property owner may remove it.',
    '',
    '**10. New owner**',
    'This warranty goes with the home. If the home is sold, the new owner keeps the remaining term and the right to renew, with no transfer fee. Send us the new owner\'s name and contact details in writing within 30 days of closing so our notices reach them. If the builder signed as agent, the first homebuyer becomes "you" on the closing date with no notice needed; the builder gives us the buyer\'s name.',
    '',
    '**11. Cancellation**',
    'You may cancel at any time by written notice. The warranty ends on the date we receive it. Renewal fees already paid are not refunded. We may cancel only for non-payment, or if you refuse access after written notice.',
    '',
    '**12. Other terms**',
    '{{warranty.contract_basis}} Waves does all work with its own staff. This document is the whole agreement; changes must be in writing and signed by both of us. Florida law governs. Questions or complaints about a pest control contract: FDACS Bureau of Inspection and Incident Response, 850-617-7996, biircomplaints@fdacs.gov.',
    '',
    '**Signatures**',
    'Both parties agree to sign and receive this warranty electronically.',
    'Signed for Waves Pest Control, LLC: {{issuer.name}}, {{issuer.title}}, on {{warranty.issue_date}}.',
    'Consumer Notice Form FDACS-13692 signed on {{warranty.consumer_notice_date}}.',
    'The owner or authorized agent signs below.',
  ].join('\n'),
  variables: [
    'warranty.number',
    'customer.name',
    'customer.address',
    'project.builder',
    'project.address',
    'project.lot',
    'project.permit',
    'warranty.structures',
    'treatment.product',
    'treatment.active_ingredient',
    'treatment.concentration',
    'treatment.gallons',
    'treatment.sq_ft',
    'treatment.linear_ft',
    'treatment.initial_date',
    'treatment.final_exterior_line',
    'treatment.applicator',
    'treatment.applicator_id',
    'warranty.plan',
    'warranty.term_end',
    'warranty.payer',
    'warranty.treatment_price',
    'warranty.plan_price',
    'warranty.renewal_fee',
    'warranty.renewal_due',
    'warranty.notice_location',
    'warranty.contract_basis',
    'issuer.name',
    'issuer.title',
    'warranty.issue_date',
    'warranty.consumer_notice_date',
  ],
};

exports.up = async function up(knex) {
  const existing = await knex('document_templates').where({ template_key: TEMPLATE.template_key }).first();
  let template = existing;
  if (!template) {
    [template] = await knex('document_templates').insert({
      template_key: TEMPLATE.template_key,
      name: TEMPLATE.name,
      category: TEMPLATE.category,
      document_type: TEMPLATE.document_type,
      status: 'active',
      description: TEMPLATE.description,
      requires_signature: TEMPLATE.requires_signature,
      variables: JSON.stringify(TEMPLATE.variables),
      tags: JSON.stringify(TEMPLATE.tags),
    }).returning('*');
  }

  let version = await knex('document_template_versions')
    .where({ template_id: template.id, version_number: 1 })
    .first();
  if (!version) {
    [version] = await knex('document_template_versions').insert({
      template_id: template.id,
      version_number: 1,
      title: TEMPLATE.title,
      body: TEMPLATE.body,
      signer_disclosure: 'I agree to receive and sign this document electronically.',
      variables: JSON.stringify(TEMPLATE.variables),
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
};

exports.down = async function down(knex) {
  // Only remove what this migration seeds, and only while nothing was issued
  // from it: an issued warranty is a signed record and keeps its template.
  const template = await knex('document_templates').where({ template_key: TEMPLATE.template_key }).first();
  if (!template) return;
  const issued = await knex('customer_contracts').where({ document_template_id: template.id }).first();
  if (issued) return;
  await knex('document_templates').where({ id: template.id }).update({ active_version_id: null });
  await knex('document_template_versions').where({ template_id: template.id }).del();
  await knex('document_templates').where({ id: template.id }).del();
};

exports.TEMPLATE = TEMPLATE;

// Builder Master Agreement and Lot Order for new-construction subterranean
// termite pre-treatments (Rule 5E-14.105(3)(c), F.A.C., as amended
// 4-29-2025): one agreement with a repeat builder before its first slab, and
// a signed Lot Order for each lot that states the lot's total price in
// dollars (5E-14.105(2)(i)). Owner 10-24 "do whatever you recommend"
// (decision page claude.ai/artifact/Vp4n6ypuLKLCEtZXmVdDYz):
// - each lot warranty runs from the lot's final treatment date (Q3);
// - the renewal fee is capped at $149.00 a year through year 5 (Q5);
// - the builder signs FDACS-13692 before this agreement.
// Drafted from the rule text with Fable as advisor. Lines wrapped in ** print
// bold (F.S. 482.227 statements and headings).
const BUSINESS_LINE = 'Waves Pest Control, LLC · 13649 Luxe Ave #110, Bradenton, FL 34211 · (941) 297-5749 · FDACS License JB351547';
const BOLD_STATEMENTS = [
  '**THE WARRANTY FOR EACH LOT IS FOR RETREATMENT ONLY. NO DAMAGE REPAIR IS OFFERED.**',
  '**COVERS: SUBTERRANEAN TERMITES, INCLUDING FORMOSAN AND ASIAN SUBTERRANEAN TERMITES. DOES NOT COVER DRYWOOD TERMITES OR OTHER WOOD-DESTROYING ORGANISMS.**',
];

const MASTER = {
  template_key: 'service_agreement.termite_builder_master_agreement',
  name: 'Builder Master Agreement (New Construction Termite)',
  category: 'service_agreement',
  document_type: 'service_agreement',
  description: 'Rule 5E-14.105(3)(c) master agreement with a builder for new-construction subterranean termite pre-treatments: a signed Lot Order per lot, lot warranties from the final treatment date, renewal fee not more than $149.00 a year through year 5.',
  tags: ['agreement', 'termite', 'pre-treat', 'new construction', 'builder', 'master agreement'],
  requires_signature: true,
  title: 'Builder Master Agreement: New Construction Termite Pre-Treatment',
  body: [
    '**WAVES PEST CONTROL, LLC — BUILDER MASTER AGREEMENT**',
    '**NEW CONSTRUCTION SUBTERRANEAN TERMITE PRE-TREATMENT (RULE 5E-14.105(3)(c), F.A.C.)**',
    BUSINESS_LINE,
    '',
    ...BOLD_STATEMENTS,
    '**THERE ARE CONDITIONS, LIMITATIONS AND EXCLUSIONS. SEE SECTION 8 AND THE BOLD HEADINGS IN EACH LOT WARRANTY.**',
    '',
    '**1. Who this agreement is between**',
    'Waves Pest Control, LLC ("Waves," "we") and the builder named here ("Builder," "you"), as owner or authorized agent of each lot it orders under this agreement: {{customer.name}}, {{customer.address}}.',
    '',
    '**2. What this agreement covers**',
    'Preventive treatments for subterranean termites on new buildings the Builder orders from us while this agreement is in force. The Builder orders each lot on its own Lot Order, signed by the Builder before we treat. The Lot Order names the lot, block, subdivision, street address and permit, the structures to treat, the treatment, and the total price for that lot. No termite infestation is known to be present on a lot when we treat it; the treatment is preventive.',
    '',
    '**3. Treatment**',
    'Unless the Lot Order says otherwise, we apply a liquid termiticide soil treatment, following its label and Rule 5E-14.106, F.A.C.: under the slab before it is poured, and a final exterior treatment around the foundation after final grading and before the home is occupied. Products we use: Termidor SC or Taurus SC (fipronil), Talstar P (bifenthrin) or Premise 2 (imidacloprid). Where the Lot Order says so, we apply a borate wood treatment (Bora-Care, disodium octaborate tetrahydrate) to the structural wood, following its label, instead of or in addition to the soil treatment. Each lot warranty names the product, the amount and the dates.',
    '',
    '**4. Price**',
    'Price schedule: {{agreement.price_schedule}}. Each Lot Order states the total price for that lot in dollars, worked out from this schedule. That total is the most we charge for the treatment of that lot. The only other charge is a re-treatment of soil the Builder disturbs (section 8), at the price stated in the Lot Order.',
    '',
    '**5. Warranty for each lot**',
    'For each treated lot we issue a New Construction Termite Warranty within 30 days of that lot\'s final treatment date (for a soil treatment, the final exterior treatment after grading). It runs for at least one year from that date. If live subterranean termites infest a covered structure during the warranty period, we apply the treatment needed to control the infestation at no charge. We issue the warranty to the Builder as owner or agent.',
    '',
    '**6. Renewal**',
    'The warranty holder may renew each lot warranty every year for 4 more years after the first year (through year 5), and we cannot refuse those renewals. Each lot warranty states its annual renewal fee. That fee is not more than $149.00 a year and does not change through year 5. After year 5, renewal is yearly at our option.',
    '',
    '**7. Homebuyer**',
    'Each lot warranty goes with the home, with no transfer fee. The first homebuyer becomes the warranty holder on the closing date. At closing the Builder gives the buyer a copy of the lot warranty. Within 30 days of closing the Builder gives us the buyer\'s name and contact details.',
    '',
    '**8. CONDITIONS AND LIMITATIONS**',
    '- We do not repair or pay for damage to a structure or its contents. Retreatment is the only remedy.',
    '- The Builder tells us at least 2 business days before each slab pour and before final grading, and gives us access to treat.',
    '- The final exterior treatment is part of the treatment and must be done before the home is occupied. If the Builder does not allow it, we tell the Builder in writing, and the untreated exterior is excluded from the lot warranty until it is treated.',
    '- The Builder does not let treated soil be disturbed after we treat without telling us first. We re-treat disturbed soil at the price stated in the Lot Order.',
    '- Each lot warranty lists the conditions that can let termites past the treatment, such as soil or mulch against the foundation, new slabs, digging, leaks, and wood or siding touching soil. If we find one, we tell the warranty holder in writing within 60 days, and the holder has 60 days to correct it before it limits our duty to retreat.',
    '- Additions, and structures attached to a building that existed before the treatment, are not covered.',
    '',
    '**9. Treatment notice and records**',
    'For each lot we post the treatment notice required by section 482.226(5), Florida Statutes, at the location stated in its warranty. Each lot\'s treatment certificate gives our business name, the applicator\'s ID card number, the product and its active ingredient.',
    '',
    '**10. Term**',
    'This agreement starts on the date of the last e-signature below. It stays in force until either party ends it by written notice. Ending it does not affect a Lot Order already signed or a warranty already issued.',
    '',
    '**11. Other terms**',
    'The Builder, as owner or authorized agent, signed the Consumer Notice Form FDACS-13692 on {{agreement.consumer_notice_date}}, before this agreement. Waves does all work with its own staff. This agreement, with each Lot Order and lot warranty, is the whole agreement; changes must be in writing and signed by both of us. Florida law governs. Questions or complaints about a pest control contract: FDACS Bureau of Inspection and Incident Response, 850-617-7996, biircomplaints@fdacs.gov.',
    '',
    '**Signatures**',
    'Both parties agree to sign and receive this agreement electronically.',
    'Signed for Waves Pest Control, LLC: {{issuer.name}}, {{issuer.title}}, on {{issuer.date}}.',
    'The Builder\'s owner or authorized agent signs below.',
  ].join('\n'),
  variables: ['customer.name', 'customer.address', 'agreement.price_schedule', 'agreement.consumer_notice_date', 'issuer.name', 'issuer.title', 'issuer.date'],
};

const LOT_ORDER = {
  template_key: 'service_agreement.termite_builder_lot_order',
  name: 'Builder Lot Order (New Construction Termite)',
  category: 'service_agreement',
  document_type: 'service_agreement',
  description: 'One lot ordered under the Builder Master Agreement: the lot, the structures, the treatment and the lot\'s total price in dollars (Rule 5E-14.105(2)(i)).',
  tags: ['agreement', 'termite', 'pre-treat', 'new construction', 'builder', 'lot order'],
  requires_signature: true,
  title: 'Lot Order: New Construction Termite Pre-Treatment',
  body: [
    '**WAVES PEST CONTROL, LLC — LOT ORDER: NEW CONSTRUCTION TERMITE PRE-TREATMENT**',
    BUSINESS_LINE,
    'Ordered under the Builder Master Agreement with {{customer.name}} dated {{lot.agreement_date}}. That agreement\'s terms apply to this lot.',
    '',
    ...BOLD_STATEMENTS,
    '',
    '**1. Lot**',
    'Lot/Block {{lot.lot_block}} · Subdivision {{lot.subdivision}} · {{lot.address}} · Permit {{lot.permit}}.',
    '',
    '**2. Structures to treat**',
    '{{lot.structures}}',
    '',
    '**3. Treatment**',
    '{{lot.treatment}}',
    '',
    '**4. Price**',
    'Total price for this lot: {{lot.price_total}} ({{lot.price_basis}}). This is the most we charge for the treatment of this lot.',
    'Re-treatment of soil the Builder disturbs: {{lot.disturbed_soil_price}} per application.',
    'Annual renewal fee for this lot\'s warranty, years 2 to 5: {{lot.renewal_fee}}.',
    '',
    '**5. Schedule**',
    'Expected slab pour: {{lot.scheduled_date}}. The Builder tells us at least 2 business days before the slab pour and before final grading.',
    '',
    '**Signatures**',
    'Both parties agree to sign and receive this Lot Order electronically.',
    'Signed for Waves Pest Control, LLC: {{issuer.name}}, {{issuer.title}}, on {{issuer.date}}.',
    'The Builder\'s owner or authorized agent signs below.',
  ].join('\n'),
  variables: [
    'customer.name', 'lot.agreement_date', 'lot.lot_block', 'lot.subdivision', 'lot.address', 'lot.permit', 'lot.structures', 'lot.treatment',
    'lot.price_total', 'lot.price_basis', 'lot.disturbed_soil_price', 'lot.renewal_fee', 'lot.scheduled_date', 'issuer.name', 'issuer.title', 'issuer.date',
  ],
};

const TEMPLATES = [MASTER, LOT_ORDER];

async function seed(knex, spec) {
  let template = await knex('document_templates').where({ template_key: spec.template_key }).forUpdate().first();
  const fields = {
    name: spec.name,
    category: spec.category,
    document_type: spec.document_type,
    status: 'active',
    audience: 'customer',
    description: spec.description,
    requires_signature: spec.requires_signature,
    variables: JSON.stringify(spec.variables),
    tags: JSON.stringify(spec.tags),
  };
  if (template) {
    await knex('document_templates').where({ id: template.id }).update({ ...fields, updated_at: knex.fn.now() });
  } else {
    [template] = await knex('document_templates').insert({ template_key: spec.template_key, ...fields }).returning('*');
  }
  // This migration's version is found by its body, numbered after any other.
  let version = await knex('document_template_versions').where({ template_id: template.id, body: spec.body }).first();
  if (!version) {
    const latest = await knex('document_template_versions').where({ template_id: template.id }).max('version_number as n').first();
    [version] = await knex('document_template_versions').insert({
      template_id: template.id,
      version_number: (Number(latest?.n) || 0) + 1,
      title: spec.title,
      body: spec.body,
      signer_disclosure: 'I agree to receive and sign this document electronically.',
      variables: JSON.stringify(spec.variables),
      required_fields: JSON.stringify(['initials', 'signedName']),
      published_at: knex.fn.now(),
    }).returning('*');
  }
  await knex('document_templates').where({ id: template.id }).update({ active_version_id: version.id, updated_at: knex.fn.now() });
}

exports.up = async function up(knex) {
  for (const spec of TEMPLATES) await seed(knex, spec);
};

// Undo only this migration's versions, and only while nothing was issued
// from them: a signed agreement keeps its text.
exports.down = async function down(knex) {
  for (const spec of TEMPLATES) {
    const template = await knex('document_templates').where({ template_key: spec.template_key }).forUpdate().first();
    if (!template) continue;
    const mine = await knex('document_template_versions').where({ template_id: template.id, body: spec.body }).first();
    if (!mine) continue;
    const issued = await knex('customer_contracts').where({ document_template_version_id: mine.id }).first();
    if (issued) continue;
    await knex('document_templates').where({ id: template.id, active_version_id: mine.id }).update({ active_version_id: null });
    await knex('document_template_versions').where({ id: mine.id }).del();
  }
};

exports.MASTER = MASTER;
exports.LOT_ORDER = LOT_ORDER;

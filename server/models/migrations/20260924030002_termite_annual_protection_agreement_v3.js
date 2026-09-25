'use strict';

// Waves Subterranean Termite Protection — Annual Service Agreement (v3).
// Owner rulings 2026-09-24 (docs/estimator-pricing-plan-2026-09-03.md
// §A2-A4, termite-annual-plan-scope-20260924.md §3): Formosan subterranean
// termites INCLUDED; one annual inspection plus activity-directed visits;
// A-13 = auto-charge the saved payment method at renewal under the consent
// captured in this agreement (30-day grace, failure => lapse + station
// retrieval); A-11 = the owner (certified operator) reviews the wording
// himself, no outside counsel.
//
// This migration ONLY seeds the template as a DRAFT:
//   - document_templates.status = 'draft' (never 'active')
//   - document_templates.active_version_id stays NULL
//   - document_template_versions.published_at stays NULL
// It does not touch, cancel, or supersede the existing v1/v2 quarterly
// purchase/rental templates (20260729000001 / 20260730000001) — those keep
// serving the quarterly bait-station product unchanged. Activation is a
// separate, deliberate one-line migration written after the owner's own
// sign-off (plan §2 "flip checklist") — this row is inert until then:
// termite-program-agreement.js's template lookup requires
// status:'active', so nothing can select or render this version yet.
const TEMPLATE_KEY = 'service_agreement.termite_annual_protection';

const TEMPLATE_V3_ANNUAL = {
  template_key: TEMPLATE_KEY,
  name: 'Waves Subterranean Termite Protection — Annual Service Agreement',
  category: 'service_agreement',
  document_type: 'service_agreement',
  description: 'DRAFT — seeded 2026-09-24, not yet reviewed/activated. Annual Trelona ATBS bait-station protection (Waves-owned stations): one annual inspection plus activity-directed visits, retreatment-only warranty, auto-renews under Section 501.165 with 45/30-day notice, auto-charges the saved payment method at renewal (30-day grace, then lapse + station retrieval). Owner (certified operator) reviews this wording before activation — plan doc §A2-A4.',
  tags: ['agreement', 'termite', 'annual', 'draft'],
  requires_signature: true,
  title: 'Waves Subterranean Termite Protection — Annual Service Agreement',
  body: [
    'WAVES SUBTERRANEAN TERMITE PROTECTION — ANNUAL SERVICE AGREEMENT',
    '',
    'COVERAGE DISCLOSURE (first page — Rule 5E-14.105, F.A.C.)',
    'THIS AGREEMENT COVERS: SUBTERRANEAN TERMITES, including Formosan',
    'subterranean termites.',
    'THIS AGREEMENT DOES NOT COVER: DRYWOOD TERMITES (treatment such as',
    'Bora-Care is quoted separately), dampwood termites, powderpost beetles,',
    'old house borers, wood-decay fungi, or any other wood-destroying',
    'organism.',
    'THIS AGREEMENT PROVIDES RETREATMENT ONLY — NO REPAIR. If covered',
    'subterranean termite activity is found at the covered structure while',
    'coverage is active, Waves will treat it at no additional charge. This',
    'agreement does not cover repair of any termite damage — existing, new,',
    'or otherwise — or replacement of any wood, structural, or other',
    'materials. (Section 482.227(2)–(3), Florida Statutes.)',
    '',
    'Customer: {{customer.name}}',
    'Service address: {{customer.address}}',
    'Covered structure(s): the primary structure at the service address.',
    'Detached structures (garages, sheds, fences, decks, docks, pool',
    'enclosures) are NOT covered unless listed here in writing: none.',
    'System: {{program.system}} (Waves-owned in-ground bait stations)',
    'Treatment basis: Preventive installation. If the pre-installation',
    'inspection documents an existing live infestation, this agreement',
    'covers CONTROL of the subterranean termite activity identified on that',
    'inspection report, which is incorporated into this agreement.',
    'Coverage period: 12 months, {{agreement.start_date}} to',
    '{{agreement.end_date}}, renewable annually as stated below.',
    '',
    'PRICING (total maximum prices — Rule 5E-14.105, F.A.C.)',
    'Station setup (one-time; stations remain Waves property):',
    '  {{program.setup_price}}',
    'Annual protection fee (prepaid; 12 months of coverage; one annual',
    '  inspection and station service): {{program.annual_price}}',
    'Annual renewal fee for the next coverage period: {{program.annual_price}}',
    '  (renewal-period rates may change only prospectively, with the new',
    '  amount stated in the renewal notice at least 30 days before the',
    '  renewal date)',
    'Structural repair price under this agreement: NONE — this agreement',
    'provides no repair service or repair coverage.',
    'No other charges apply for covered retreatment or for activity-',
    'directed follow-up visits.',
    '',
    'THE PROGRAM',
    'Waves Pest Control, LLC (FL business license JB351547) will install',
    'in-ground termite bait stations in accessible soil around the',
    'perimeter of the covered structure, placed per the product label. The',
    'number and location of stations is set by the property and confirmed',
    'on the installation report, which also records construction type and',
    'any perimeter sections that could not be accessed.',
    'Included each coverage year: one scheduled whole-structure inspection',
    'with every accessible station serviced; bait cartridge replacement per',
    'the manufacturer’s criteria; additional label-directed visits when',
    'activity or heavy bait consumption is found; retreatment of covered',
    'subterranean termite activity; a signed annual inspection report,',
    'retained by Waves for three years and available in the customer',
    'portal.',
    'Not included (separately quoted if recommended): supplemental liquid',
    'treatments, additional stations beyond the installed count, treatment',
    'of detached structures, drywood termite treatment of any kind, repairs.',
    'Reinspection interval: annual, plus activity-directed visits.',
    '',
    'STATION OWNERSHIP — WAVES-OWNED',
    'The stations and in-ground hardware remain Waves property. The setup',
    'fee covers placement and does not transfer ownership. When coverage',
    'ends for any reason, Waves will retrieve its stations and in-ground',
    'protection ends.',
    '',
    'WHAT THIS PROTECTION IS — AND IS NOT',
    'Bait-station protection is a detection, baiting and retreatment',
    'program. No program can guarantee the absence of termites. Waves’',
    'obligation on covered activity is retreatment as stated above; this',
    'agreement creates NO obligation to repair damage and NO assurance that',
    'the structure is or will remain free of wood-destroying organisms.',
    '',
    'CUSTOMER RESPONSIBILITIES; NOTICE AND OPPORTUNITY TO CORRECT',
    'The customer agrees to: provide safe access for the annual inspection,',
    'activity-directed visits, and station retrieval when coverage ends;',
    'not open, move, remove, bury, pave over, or damage stations; notify',
    'Waves before hardscape, landscaping, irrigation, grading, structural',
    'alteration, or construction changes near the covered structure; and',
    'notify Waves promptly of suspected termite activity or a damaged or',
    'exposed station.',
    '',
    'If Waves identifies a condition that interferes with protection or',
    'promotes termite activity (for example, wood-to-soil contact, soil or',
    'mulch above the slab line, persistent moisture, or a blocked station',
    'line), Waves will notify the customer in writing within 60 days of',
    'discovery and the customer will have 60 days to correct the condition.',
    'Waves will not rely on any limitation or condition in this agreement',
    'without having provided that written notice and correction period.',
    '',
    'BILLING; COVERAGE PERIOD; RENEWAL; NONRENEWAL',
    'The setup fee and the first annual protection fee are billed together',
    'and are due before installation. Coverage runs for 12 months from the',
    'program start date.',
    'AUTOMATIC RENEWAL (Section 501.165, Florida Statutes): this agreement',
    'renews for successive 12-month coverage periods unless the customer',
    'cancels before the renewal date. Waves will send written renewal',
    'notice at least 45 days and again 30 days before the renewal date,',
    'stating the renewal fee and how to cancel. The customer may decline',
    'renewal at any time before the renewal date online through their',
    'customer portal (the same way this agreement was accepted), by email,',
    'or in writing — never only by phone.',
    'By signing, the customer authorizes Waves to charge the renewal fee to',
    'the payment method on file on or after the renewal date, unless the',
    'customer has cancelled. If the charge fails, Waves will notify the',
    'customer; if it is not paid within 30 days coverage lapses and',
    'stations are retrieved.',
    'Either party may end this agreement with written notice. Amounts for',
    'services already performed (including the setup fee) remain due and',
    'are not refunded; coverage already paid for continues to the end of',
    'the paid period, after which Waves retrieves its stations.',
    'If this structure is currently covered by another company’s termite',
    'contract, Florida law requires a signed Consumer Consent form',
    '(FDACS-13671) before this agreement replaces that coverage; Waves will',
    'provide the form.',
    '',
    'TRANSFER TO A NEW OWNER',
    'If the covered property is sold, this agreement may be transferred to',
    'the new owner at the then-current rates, subject to: (a) written',
    'notice to Waves before or at closing; (b) a transfer inspection; and',
    '(c) the new owner signing Waves’ then-current annual service',
    'agreement. Without a completed transfer, coverage ends at closing and',
    'Waves will retrieve its stations.',
    '',
    'LIMITATION OF LIABILITY',
    'To the maximum extent permitted by law: (a) Waves’ total liability',
    'under this agreement is limited to the amounts the customer paid for',
    'services in the 12 months preceding the claim; (b) Waves is not liable',
    'for indirect, incidental, special, or consequential damages, including',
    'damage to contents or personal property, mold or moisture damage, loss',
    'of use, relocation costs, diminution in value, or lost income; and',
    '(c) Waves’ sole obligation for covered termite activity is retreatment',
    'as stated in this agreement; Waves is not liable for damage caused by',
    'wood-destroying organisms or for the cost of repairing it. Nothing in',
    'this section limits liability that cannot lawfully be limited, and',
    'nothing in this agreement will be applied to deny a service obligation',
    'in a manner prohibited by Rule 5E-14.105, F.A.C.',
    '',
    'GENERAL TERMS',
    'Governing law and venue: Florida law governs this agreement; venue for',
    'any dispute lies in Manatee County, Florida. In any action to enforce',
    'this agreement, the prevailing party is entitled to reasonable',
    'attorneys’ fees and costs.',
    'Entire agreement; amendments in writing; severability: if any',
    'provision is unenforceable, the remainder stands.',
    'Consumer notice: the customer acknowledges receiving the Florida',
    'Consumer Information Notice (FDACS-13692) before work begins.',
    'Assignment: Waves will not subcontract the services under this',
    'agreement without the customer’s prior written approval as required by',
    'Rule 5E-14.105, F.A.C.',
    '',
    'SIGNATURES (Rule 5E-14.105(2), F.A.C.)',
    'Customer: ______________________  Date: ________',
    'Waves Pest Control, LLC — certified operator in charge:',
    '______________________  License: ________  Date: ________',
    'ELECTRONIC SIGNATURE: By signing, the customer confirms they reviewed',
    'this agreement — including the first-page coverage disclosure stating',
    'that drywood termites are not covered and that this agreement provides',
    'retreatment only and no repair — and intend to sign it electronically.',
  ].join('\n'),
  variables: [
    'customer.name',
    'customer.address',
    'program.system',
    'program.setup_price',
    'program.annual_price',
    'agreement.start_date',
    'agreement.end_date',
  ],
};

exports.up = async function up(knex) {
  const hasTemplates = await knex.schema.hasTable('document_templates');
  const hasVersions = await knex.schema.hasTable('document_template_versions');
  if (!hasTemplates || !hasVersions) return;

  // Idempotent: never overwrite an operator-edited draft on a re-run.
  const existing = await knex('document_templates').where({ template_key: TEMPLATE_KEY }).first('id');
  if (existing) return;

  const [template] = await knex('document_templates').insert({
    template_key: TEMPLATE_V3_ANNUAL.template_key,
    name: TEMPLATE_V3_ANNUAL.name,
    category: TEMPLATE_V3_ANNUAL.category,
    document_type: TEMPLATE_V3_ANNUAL.document_type,
    // DRAFT — never 'active'. Activation is a separate migration after the
    // owner's own review (A-11); this row must not be selectable by
    // termite-program-agreement.js (which requires status:'active') and
    // must not supersede or cancel the v1/v2 quarterly templates.
    status: 'draft',
    description: TEMPLATE_V3_ANNUAL.description,
    requires_signature: TEMPLATE_V3_ANNUAL.requires_signature,
    variables: JSON.stringify(TEMPLATE_V3_ANNUAL.variables),
    tags: JSON.stringify(TEMPLATE_V3_ANNUAL.tags),
    // active_version_id intentionally left NULL.
  }).returning('*');

  await knex('document_template_versions').insert({
    template_id: template.id,
    version_number: 1,
    title: TEMPLATE_V3_ANNUAL.title,
    body: TEMPLATE_V3_ANNUAL.body,
    signer_disclosure: 'I agree to receive and sign this document electronically.',
    variables: JSON.stringify(TEMPLATE_V3_ANNUAL.variables),
    required_fields: JSON.stringify(['initials', 'signedName']),
    // published_at intentionally left NULL — never published by this
    // migration; the activation migration stamps it at rollout time.
  });
};

exports.down = async function down(knex) {
  const hasTemplates = await knex.schema.hasTable('document_templates');
  if (!hasTemplates) return;
  const template = await knex('document_templates')
    .where({ template_key: TEMPLATE_KEY })
    .first('id', 'active_version_id');
  if (!template) return;
  // This migration only ever seeds an inert draft it never activates — if a
  // LATER migration activated it, active_version_id now points here and
  // this rollback must not silently delete a live, signable template out
  // from under active_version_id. Refuse in that case; the activation
  // migration owns its own rollback.
  if (template.active_version_id) return;
  await knex('document_template_versions').where({ template_id: template.id }).del();
  await knex('document_templates').where({ id: template.id }).del();
};

exports.TEMPLATE_KEY = TEMPLATE_KEY;
exports.TEMPLATE_V3_ANNUAL = TEMPLATE_V3_ANNUAL;

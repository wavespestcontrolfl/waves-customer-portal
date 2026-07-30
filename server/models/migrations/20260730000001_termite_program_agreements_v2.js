// Version 2 of the termite bait-station program agreements (owner-approved
// drafts 2026-07-29, built to Rule 5E-14.105, F.A.C. after the compliance
// research pass). Adds over v1: first-page coverage disclosure (subterranean
// incl. Formosan covered; drywood and other WDOs named as NOT covered),
// not-a-warranty statement on page one, treatment basis, covered-structure
// identification, total-maximum-price block with an explicit no-repair-price
// line, 60-day-notice/60-day-cure before relying on any condition, transfer-
// to-new-owner terms, FDACS-13692 consumer-notice acknowledgment,
// FDACS-13671 takeover-consent line, no-subcontracting-without-approval,
// limitation of liability with consequential-damages waiver, venue and
// attorneys' fees. The optional arbitration clause was deliberately OMITTED
// pending owner+attorney decision. Merge variables are UNCHANGED from v1,
// so the accept-time prep service needs no changes.
//
// Inserts version 2 rows and repoints active_version_id. down() repoints
// active_version_id back to version 1 and leaves all rows in place —
// content-seed rollbacks are never destructive (owner rule 2026-07-29).
const TEMPLATE_V2 = [
  {
    template_key: 'service_agreement.termite_bait_program_purchase',
    title: 'Termite Bait Station Program Agreement (Purchased Stations)',
    body: [
      "TERMITE BAIT STATION PROGRAM AGREEMENT — PURCHASED STATIONS",
      "",
      "COVERAGE DISCLOSURE (first page — Rule 5E-14.105, F.A.C.)",
      "THIS AGREEMENT COVERS: SUBTERRANEAN TERMITES, including Formosan",
      "subterranean termites.",
      "THIS AGREEMENT DOES NOT COVER: DRYWOOD TERMITES, dampwood termites,",
      "powderpost beetles, old house borers, wood-decay fungi, or any other",
      "wood-destroying organism.",
      "THIS IS A MONITORING AND BAITING SERVICE AGREEMENT. IT IS NOT A",
      "WARRANTY OR BOND. It includes no retreatment guarantee and no damage",
      "repair coverage of any kind. An optional annual renewable warranty",
      "(termite bond) is available separately and is governed solely by its",
      "own signed bond agreement if purchased.",
      "",
      "Customer: {{customer.name}}",
      "Service address: {{customer.address}}",
      "Covered structure(s): the primary structure at the service address.",
      "Detached structures (garages, sheds, fences, decks, docks, pool",
      "enclosures) are NOT covered unless listed here in writing: none.",
      "System: {{program.system}}",
      "Treatment basis: Preventive installation. If the pre-installation",
      "inspection documents an existing live infestation, this agreement",
      "covers CONTROL of the subterranean termite activity identified on that",
      "inspection report, which is incorporated into this agreement.",
      "Program start date: {{agreement.start_date}}",
      "",
      "PRICING (total maximum prices — Rule 5E-14.105, F.A.C.)",
      "Installation (one-time, purchased hardware): {{program.install_price}}",
      "Quarterly station check: {{program.per_application}} per application",
      "(4 applications per year). This is the maximum per-application price",
      "for the initial 12 months. Renewal-period rates may be adjusted only",
      "prospectively, with at least 30 days' written notice.",
      "Structural repair price under this agreement: NONE — this agreement",
      "provides no repair service or repair coverage.",
      "",
      "THE PROGRAM",
      "Waves Pest Control, LLC (FL business license JB351547) will install",
      "in-ground termite bait stations in accessible soil around the",
      "perimeter of the covered structure, placed per the product label. The",
      "number and location of stations is set by the property and confirmed",
      "on the installation report, which also records the construction type",
      "observed (e.g., concrete block, wood frame) and any perimeter sections",
      "that could not be accessed. Waves will check every accessible station",
      "on a quarterly schedule (approximately every 3 months), document each",
      "check in the customer's service report (station condition, activity",
      "found, bait consumption, cartridges replaced), and replace bait",
      "cartridges when the manufacturer's replacement criteria are met.",
      "",
      "Included: quarterly inspection of accessible stations; bait cartridge",
      "replacement per label criteria; documented service reports.",
      "Not included (separately quoted if recommended): supplemental liquid",
      "treatments, additional stations beyond the installed count, treatment",
      "of detached structures, drywood termite treatment of any kind, repairs.",
      "",
      "STATION OWNERSHIP — PURCHASED: The stations and in-ground hardware are",
      "purchased by the customer with the installation charge shown above and",
      "are the customer's property once installed and paid for. If the",
      "program ends for any reason, the stations remain in place; quarterly",
      "service, monitoring, and documentation end with the program.",
      "",
      "WHAT MONITORING IS — AND IS NOT",
      "Bait-station monitoring is a detection-and-baiting program. Finding",
      "termites in a station means the system is working; it does not by",
      "itself establish that termites are absent from the structure, and no",
      "monitoring program can guarantee the absence of termites. THIS",
      "AGREEMENT PROVIDES NO ASSURANCE THAT THE STRUCTURE IS OR WILL REMAIN",
      "FREE OF WOOD-DESTROYING ORGANISMS AND NO OBLIGATION TO RETREAT OR",
      "REPAIR. Retreatment and repair obligations exist only under a",
      "separately signed termite bond, and only as stated there.",
      "",
      "CUSTOMER RESPONSIBILITIES; NOTICE AND OPPORTUNITY TO CORRECT",
      "The customer agrees to: provide safe access for scheduled checks; not",
      "open, move, remove, bury, pave over, or damage stations; notify Waves",
      "before hardscape, landscaping, irrigation, grading, structural",
      "alteration, or construction changes near the covered structure; and",
      "notify Waves promptly of suspected termite activity or a damaged or",
      "exposed station.",
      "",
      "If Waves identifies a condition that interferes with monitoring or",
      "promotes termite activity (for example, wood-to-soil contact, soil or",
      "mulch above the slab line, persistent moisture, or a blocked station",
      "line), Waves will notify the customer in writing within 60 days of",
      "discovery and the customer will have 60 days to correct the condition.",
      "Waves will not rely on any limitation or condition in this agreement",
      "without having provided that written notice and correction period.",
      "",
      "BILLING; TERM; CANCELLATION",
      "The installation charge is billed once. The quarterly station check is",
      "billed per application at the rate shown above. The initial term is 12",
      "months from the program start date, renewing automatically in 12-month",
      "periods until cancelled. Either party may cancel at any time with",
      "written notice. Amounts for services already performed (including the",
      "installation) remain due and are not refunded. On cancellation the",
      "stations remain the customer's property and all Waves service",
      "obligations end.",
      "",
      "If this structure is currently covered by another company's termite",
      "contract, Florida law requires a signed Consumer Consent form",
      "(FDACS-13671) before this agreement replaces that coverage; Waves will",
      "provide the form.",
      "",
      "TRANSFER TO A NEW OWNER",
      "If the covered property is sold, this agreement may be transferred to",
      "the new owner at the then-current rates, subject to: (a) written",
      "notice to Waves before or at closing; (b) a transfer inspection; and",
      "(c) the new owner signing Waves' then-current program agreement. The",
      "purchased stations are part of the property and convey with it whether",
      "or not the service transfers; without a completed transfer, quarterly",
      "service ends at closing and the stations remain. Any termite bond has",
      "its own transfer terms (transfer inspection and transfer fee) stated",
      "in the bond agreement.",
      "",
      "LIMITATION OF LIABILITY",
      "To the maximum extent permitted by law: (a) Waves' total liability",
      "under this agreement is limited to the amounts the customer paid for",
      "services in the 12 months preceding the claim; (b) Waves is not liable",
      "for indirect, incidental, special, or consequential damages, including",
      "damage to contents or personal property, mold or moisture damage, loss",
      "of use, relocation costs, diminution in value, or lost income; and",
      "(c) Waves is not liable for damage caused by wood-destroying organisms",
      "— this agreement provides monitoring and baiting service only, and any",
      "damage-related obligations exist solely under a separately signed",
      "bond. Nothing in this section limits liability that cannot lawfully be",
      "limited, and nothing in this agreement will be applied to deny a",
      "service obligation in a manner prohibited by Rule 5E-14.105, F.A.C.",
      "",
      "GENERAL TERMS",
      "Governing law and venue: Florida law governs this agreement; venue for",
      "any dispute lies in Manatee County, Florida. In any action to enforce",
      "this agreement, the prevailing party is entitled to reasonable",
      "attorneys' fees and costs.",
      "Entire agreement; amendments in writing; severability: if any",
      "provision is unenforceable, the remainder stands.",
      "Consumer notice: the customer acknowledges receiving the Florida",
      "Consumer Information Notice (FDACS-13692) before work begins.",
      "Assignment: Waves will not subcontract the services under this",
      "agreement without the customer's prior written approval as required by",
      "Rule 5E-14.105, F.A.C.",
      "",
      "ELECTRONIC SIGNATURE: By signing, the customer confirms they reviewed",
      "this agreement — including the first-page coverage disclosure stating",
      "that drywood termites are not covered and that this agreement is not a",
      "warranty — and intend to sign it electronically."
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
    title: 'Termite Bait Station Program Agreement (Rented Stations)',
    body: [
      "TERMITE BAIT STATION PROGRAM AGREEMENT — RENTED STATIONS",
      "",
      "COVERAGE DISCLOSURE (first page — Rule 5E-14.105, F.A.C.)",
      "THIS AGREEMENT COVERS: SUBTERRANEAN TERMITES, including Formosan",
      "subterranean termites.",
      "THIS AGREEMENT DOES NOT COVER: DRYWOOD TERMITES, dampwood termites,",
      "powderpost beetles, old house borers, wood-decay fungi, or any other",
      "wood-destroying organism.",
      "THIS IS A MONITORING AND BAITING SERVICE AGREEMENT. IT IS NOT A",
      "WARRANTY OR BOND. It includes no retreatment guarantee and no damage",
      "repair coverage of any kind. An optional annual renewable warranty",
      "(termite bond) is available separately and is governed solely by its",
      "own signed bond agreement if purchased.",
      "",
      "Customer: {{customer.name}}",
      "Service address: {{customer.address}}",
      "Covered structure(s): the primary structure at the service address.",
      "Detached structures (garages, sheds, fences, decks, docks, pool",
      "enclosures) are NOT covered unless listed here in writing: none.",
      "System: {{program.system}}",
      "Treatment basis: Preventive installation. If the pre-installation",
      "inspection documents an existing live infestation, this agreement",
      "covers CONTROL of the subterranean termite activity identified on that",
      "inspection report, which is incorporated into this agreement.",
      "Program start date: {{agreement.start_date}}",
      "",
      "PRICING (total maximum prices — Rule 5E-14.105, F.A.C.)",
      "Installation: $0 — hardware installed at no up-front charge.",
      "Quarterly station check: {{program.per_application}} per application.",
      "Station rental: {{program.rental_per_application}} per application.",
      "Total per application: {{program.combined_per_application}}",
      "(4 applications per year). This is the maximum per-application price",
      "for the initial 12 months. Renewal-period rates may be adjusted only",
      "prospectively, with at least 30 days' written notice.",
      "Structural repair price under this agreement: NONE — this agreement",
      "provides no repair service or repair coverage.",
      "",
      "THE PROGRAM",
      "Waves Pest Control, LLC (FL business license JB351547) will install",
      "in-ground termite bait stations in accessible soil around the",
      "perimeter of the covered structure, placed per the product label. The",
      "number and location of stations is set by the property and confirmed",
      "on the installation report, which also records the construction type",
      "observed (e.g., concrete block, wood frame) and any perimeter sections",
      "that could not be accessed. Waves will check every accessible station",
      "on a quarterly schedule (approximately every 3 months), document each",
      "check in the customer's service report (station condition, activity",
      "found, bait consumption, cartridges replaced), and replace bait",
      "cartridges when the manufacturer's replacement criteria are met.",
      "",
      "Included: quarterly inspection of accessible stations; bait cartridge",
      "replacement per label criteria; documented service reports.",
      "Not included (separately quoted if recommended): supplemental liquid",
      "treatments, additional stations beyond the installed count, treatment",
      "of detached structures, drywood termite treatment of any kind, repairs.",
      "",
      "STATION OWNERSHIP — RENTED: The stations and all in-ground hardware",
      "are and remain the property of Waves Pest Control, LLC. The customer",
      "pays no installation charge; instead, the station rental amount shown",
      "above is billed with each quarterly application for as long as the",
      "program runs. THE RENTAL IS A RENTAL RATE, NOT A PAYMENT PLAN: it does",
      "not build ownership or equity in the hardware and does not end after",
      "the hardware cost is recovered. The customer agrees not to remove,",
      "relocate, or dispose of the stations, and to grant Waves reasonable",
      "access to service them and, on cancellation, to retrieve them.",
      "Stations destroyed or rendered unrecoverable by the customer's",
      "intentional act or property alteration (for example, paving or",
      "building over a station after written notice) may be billed at",
      "hardware replacement cost.",
      "",
      "WHAT MONITORING IS — AND IS NOT",
      "Bait-station monitoring is a detection-and-baiting program. Finding",
      "termites in a station means the system is working; it does not by",
      "itself establish that termites are absent from the structure, and no",
      "monitoring program can guarantee the absence of termites. THIS",
      "AGREEMENT PROVIDES NO ASSURANCE THAT THE STRUCTURE IS OR WILL REMAIN",
      "FREE OF WOOD-DESTROYING ORGANISMS AND NO OBLIGATION TO RETREAT OR",
      "REPAIR. Retreatment and repair obligations exist only under a",
      "separately signed termite bond, and only as stated there.",
      "",
      "CUSTOMER RESPONSIBILITIES; NOTICE AND OPPORTUNITY TO CORRECT",
      "The customer agrees to: provide safe access for scheduled checks and",
      "for station retrieval on cancellation; not open, move, remove, bury,",
      "pave over, or damage stations; notify Waves before hardscape,",
      "landscaping, irrigation, grading, structural alteration, or",
      "construction changes near the covered structure; and notify Waves",
      "promptly of suspected termite activity or a damaged or exposed",
      "station.",
      "",
      "If Waves identifies a condition that interferes with monitoring or",
      "promotes termite activity (for example, wood-to-soil contact, soil or",
      "mulch above the slab line, persistent moisture, or a blocked station",
      "line), Waves will notify the customer in writing within 60 days of",
      "discovery and the customer will have 60 days to correct the condition.",
      "Waves will not rely on any limitation or condition in this agreement",
      "without having provided that written notice and correction period.",
      "",
      "BILLING; TERM; CANCELLATION AND REMOVAL",
      "The quarterly station check and the station rental are billed",
      "together, per application, at the rates shown above. The initial term",
      "is 12 months from the program start date, renewing automatically in",
      "12-month periods until cancelled. Either party may cancel at any time",
      "with written notice. On cancellation, Waves will remove its stations",
      "from the property within a reasonable time and in-ground protection",
      "ends with the program. Amounts for services already performed remain",
      "due. The customer's inspection and service history remains available",
      "in their customer portal account.",
      "",
      "If this structure is currently covered by another company's termite",
      "contract, Florida law requires a signed Consumer Consent form",
      "(FDACS-13671) before this agreement replaces that coverage; Waves will",
      "provide the form.",
      "",
      "TRANSFER TO A NEW OWNER",
      "If the covered property is sold, this agreement may be transferred to",
      "the new owner at the then-current rates, subject to: (a) written",
      "notice to Waves before or at closing; (b) a transfer inspection; and",
      "(c) the new owner signing Waves' then-current program agreement.",
      "Without a completed transfer, the rental program ends at closing and",
      "Waves will retrieve its stations. Any termite bond has its own",
      "transfer terms (transfer inspection and transfer fee) stated in the",
      "bond agreement.",
      "",
      "LIMITATION OF LIABILITY",
      "To the maximum extent permitted by law: (a) Waves' total liability",
      "under this agreement is limited to the amounts the customer paid for",
      "services in the 12 months preceding the claim; (b) Waves is not liable",
      "for indirect, incidental, special, or consequential damages, including",
      "damage to contents or personal property, mold or moisture damage, loss",
      "of use, relocation costs, diminution in value, or lost income; and",
      "(c) Waves is not liable for damage caused by wood-destroying organisms",
      "— this agreement provides monitoring and baiting service only, and any",
      "damage-related obligations exist solely under a separately signed",
      "bond. Nothing in this section limits liability that cannot lawfully be",
      "limited, and nothing in this agreement will be applied to deny a",
      "service obligation in a manner prohibited by Rule 5E-14.105, F.A.C.",
      "",
      "GENERAL TERMS",
      "Governing law and venue: Florida law governs this agreement; venue for",
      "any dispute lies in Manatee County, Florida. In any action to enforce",
      "this agreement, the prevailing party is entitled to reasonable",
      "attorneys' fees and costs.",
      "Entire agreement; amendments in writing; severability: if any",
      "provision is unenforceable, the remainder stands.",
      "Consumer notice: the customer acknowledges receiving the Florida",
      "Consumer Information Notice (FDACS-13692) before work begins.",
      "Assignment: Waves will not subcontract the services under this",
      "agreement without the customer's prior written approval as required by",
      "Rule 5E-14.105, F.A.C.",
      "",
      "ELECTRONIC SIGNATURE: By signing, the customer confirms they reviewed",
      "this agreement — including the first-page coverage disclosure stating",
      "that drywood termites are not covered and that this agreement is not a",
      "warranty — that they understand the stations remain Waves property and",
      "are removed if the program ends, and intend to sign it electronically."
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
  // Tiny generic state table so down() can restore the ACTUAL pre-migration
  // active version (version-number inference can pick an unapproved draft).
  const hasState = await knex.schema.hasTable('migration_rollback_state');
  if (!hasState) {
    await knex.schema.createTable('migration_rollback_state', (t) => {
      t.increments('id').primary();
      t.string('migration_name', 200).notNullable();
      t.string('state_key', 200).notNullable();
      t.text('state_value');
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.unique(['migration_name', 'state_key']);
    });
  }
  const MIGRATION_NAME = '20260730000001_termite_program_agreements_v2';
  const seededVersionIds = [];
  for (const seed of TEMPLATE_V2) {
    const template = await knex('document_templates').where({ template_key: seed.template_key }).first();
    if (!template) continue;

    // Identify OUR version by content, never by version number alone: an
    // admin edit made before this migration runs would occupy version 2
    // (the editor allocates sequentially), and treating that row as ours
    // would silently strand the approved compliance wording. If our body
    // isn't present, insert it at the next unused version number.
    const versions = await knex('document_template_versions')
      .where({ template_id: template.id })
      .orderBy('version_number', 'asc');
    let seededVersion = versions.find((v) => v.body === seed.body) || null;
    if (!seededVersion) {
      const nextNumber = versions.length
        ? Math.max(...versions.map((v) => Number(v.version_number) || 0)) + 1
        : 1;
      [seededVersion] = await knex('document_template_versions').insert({
        template_id: template.id,
        version_number: nextNumber,
        title: seed.title,
        body: seed.body,
        signer_disclosure: 'I agree to receive and sign this document electronically.',
        variables: JSON.stringify(seed.variables),
        required_fields: JSON.stringify(['initials', 'signedName']),
        published_at: knex.fn.now(),
      }).returning('*');
    }
    if (seededVersion?.id) seededVersionIds.push(seededVersion.id);
    if (seededVersion?.id && template.active_version_id !== seededVersion.id) {
      // Record the ACTUAL prior active version for a faithful rollback
      // (idempotent: only the first run's value is kept).
      const existingState = await knex('migration_rollback_state')
        .where({ migration_name: MIGRATION_NAME, state_key: `prior_active:${seed.template_key}` })
        .first();
      if (!existingState) {
        await knex('migration_rollback_state').insert({
          migration_name: MIGRATION_NAME,
          state_key: `prior_active:${seed.template_key}`,
          state_value: template.active_version_id || '',
        });
      }
      // Activation IS the rollout moment: the expired-recovery cutoff reads
      // the active version's published_at, so a reused (older or never-published)
      // matching version must carry the activation time, not its original
      // authoring time.
      await knex('document_template_versions').where({ id: seededVersion.id }).update({
        published_at: knex.fn.now(),
      });
      await knex('document_templates').where({ id: template.id }).update({
        active_version_id: seededVersion.id,
        variables: JSON.stringify(seed.variables),
        updated_at: knex.fn.now(),
      });
    }
  }

  // Open (unsigned) requests still carry the superseded v1 wording in their
  // contract_text_snapshot — a customer could still open and SIGN the old
  // terms after this compliance migration. Cancel them; the daily
  // reconciliation sweep re-preps replacements from the active (v2) body,
  // and signed rows are historical records that stay untouched.
  const hasContracts = await knex.schema.hasTable('customer_contracts');
  if (!hasContracts) return;
  const templateKeys = TEMPLATE_V2.map((t) => t.template_key);
  const openRows = await knex('customer_contracts')
    .whereIn('document_template_key', templateKeys)
    .whereIn('status', ['draft', 'sent', 'viewed'])
    // Requests already rendered from the approved body (an admin-created
    // version the content lookup matched) were never superseded — their
    // signing links stay live.
    .modify((q) => { if (seededVersionIds.length) q.whereNotIn('document_template_version_id', seededVersionIds); })
    .select('id', 'customer_id', 'status', 'recipient_name', 'document_variables_snapshot');
  const now = new Date();
  for (const row of openRows) {
    const priorStatus = row.status;
    // Conditional on the status still being open: a customer signing
    // concurrently with the deploy could commit 'signed' between the
    // unlocked read above and this update — an executed agreement must
    // never be overwritten as cancelled (same guard as the service's
    // supersession path). The event is recorded only when the cancel
    // actually landed.
    const cancelled = await knex('customer_contracts')
      .where({ id: row.id })
      .whereIn('status', ['draft', 'sent', 'viewed'])
      .update({
        status: 'cancelled',
        cancelled_at: now,
        cancelled_reason: 'Superseded by updated compliance wording (v2 templates)',
        updated_at: now,
      });
    if (!cancelled) continue;
    await knex('customer_contract_events').insert({
      contract_id: row.id,
      customer_id: row.customer_id,
      event_type: 'cancelled',
      actor_type: 'system',
      actor_id: null,
      // prior_status lets down() restore the request exactly as it was.
      metadata: JSON.stringify({ reason: 'superseded_by_v2_migration', prior_status: priorStatus }),
    });
    // Service-generated requests carry the estimate id in their snapshot and
    // the reconciliation sweep re-preps them from the v2 body automatically.
    // MANUALLY issued requests (generic document-library route) have no
    // estimate linkage, so reconciliation can't replace them — hand those to
    // the operator explicitly with an admin bell per cancelled request.
    let snapshot = row.document_variables_snapshot;
    if (typeof snapshot === 'string') {
      try { snapshot = JSON.parse(snapshot); } catch { snapshot = null; }
    }
    const serviceGenerated = !!snapshot?.estimate?.id;
    if (!serviceGenerated) {
      const hasNotifications = await knex.schema.hasTable('notifications');
      if (hasNotifications) {
        await knex('notifications').insert({
          recipient_type: 'admin',
          recipient_id: null,
          category: 'estimate',
          title: 'Re-issue termite agreement (wording updated)',
          body: `The open termite program agreement for ${row.recipient_name || 'a customer'} was cancelled because its wording was superseded by the v2 compliance templates. It was issued manually, so re-issue it from the document library on the updated template.`,
          icon: '\u{1F4DD}',
          link: `/admin/customers/${row.customer_id}`,
          metadata: JSON.stringify({ contractId: row.id, customerId: row.customer_id, reason: 'superseded_by_v2_migration' }),
        });
        // Durably mark the handoff so the daily superseded sweep doesn't
        // ring the identical re-issue bell again tomorrow (same marker the
        // sweep writes).
        await knex('customer_contract_events').insert({
          contract_id: row.id,
          customer_id: row.customer_id,
          event_type: 'superseded_reprocessed',
          actor_type: 'system',
          actor_id: null,
          metadata: JSON.stringify({ outcome: 'manual_reissue_belled_by_migration' }),
        });
      }
    }
  }
};

exports.down = async function down(knex) {
  // Non-destructive: repoint the active version back to v1; every row stays.
  const hasTemplates = await knex.schema.hasTable('document_templates');
  if (!hasTemplates) return;
  const MIGRATION_NAME = '20260730000001_termite_program_agreements_v2';
  const hasState = await knex.schema.hasTable('migration_rollback_state');
  for (const seed of TEMPLATE_V2) {
    const template = await knex('document_templates').where({ template_key: seed.template_key }).first();
    if (!template) continue;
    // Restore the RECORDED pre-migration active version — never inferred
    // from version numbers (that can activate an unapproved draft). No
    // recorded state means up() never repointed this template (the approved
    // body was already active): leave it untouched.
    // Cancelled v1 requests stay cancelled on rollback — recreating them
    // would resurrect superseded wording; the reconciliation sweep preps
    // fresh ones from whatever version is active.
    if (!hasState) continue;
    const state = await knex('migration_rollback_state')
      .where({ migration_name: MIGRATION_NAME, state_key: `prior_active:${seed.template_key}` })
      .first();
    if (!state) continue;
    const priorId = state.state_value || null;
    if (priorId) {
      const priorRow = await knex('document_template_versions').where({ id: priorId }).first('id');
      if (priorRow) {
        await knex('document_templates').where({ id: template.id }).update({
          active_version_id: priorId,
          updated_at: knex.fn.now(),
        });
      }
    }
    await knex('migration_rollback_state')
      .where({ migration_name: MIGRATION_NAME, state_key: `prior_active:${seed.template_key}` })
      .del();
  }

  // Requests up() cancelled must come back with the rollback: after the
  // prior version is active again the sweep's reactivation guard skips
  // them, and older estimates fall outside the ordinary window — without
  // this, customers keep dead 410 links with no replacement. Restore each
  // row to its recorded prior status (only if still carrying our
  // cancellation), clear the cancellation fields, and drop any reprocessed
  // markers so future logic re-evaluates them fresh.
  const hasContracts = await knex.schema.hasTable('customer_contracts');
  const hasEvents = await knex.schema.hasTable('customer_contract_events');
  if (hasContracts && hasEvents) {
    const cancelEvents = await knex('customer_contract_events')
      .where({ event_type: 'cancelled', actor_type: 'system' })
      .whereRaw("metadata->>'reason' = 'superseded_by_v2_migration'")
      .select('contract_id', 'customer_id', 'metadata');
    for (const evt of cancelEvents) {
      let meta = evt.metadata;
      if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
      const priorStatus = ['draft', 'sent', 'viewed'].includes(meta?.prior_status) ? meta.prior_status : 'draft';
      const restored = await knex('customer_contracts')
        .where({ id: evt.contract_id, status: 'cancelled' })
        .where('cancelled_reason', 'like', 'Superseded by updated compliance wording%')
        .update({
          status: priorStatus,
          cancelled_at: null,
          cancelled_reason: null,
          updated_at: knex.fn.now(),
        });
      if (restored) {
        await knex('customer_contract_events')
          .where({ contract_id: evt.contract_id, event_type: 'superseded_reprocessed' })
          .del();
        await knex('customer_contract_events').insert({
          contract_id: evt.contract_id,
          customer_id: evt.customer_id,
          event_type: 'reopened',
          actor_type: 'system',
          actor_id: null,
          metadata: JSON.stringify({ reason: 'v2_migration_rolled_back' }),
        });
      }
    }
  }
};

exports.TEMPLATE_V2 = TEMPLATE_V2;

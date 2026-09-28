/**
 * Email division — first four templates (re-cut of #5160/20260928080000,
 * which is closed: its seed migration was already pushed and is therefore
 * frozen per waves-db §4 — this is a fresh seed on a fresh branch, not a
 * correction chain on top of the old one).
 *
 * Seeds four templates DRAFT (assertTemplateSendable in email-template-library.js
 * refuses anything but 'active', so nothing here can send) plus preview
 * fixtures and, for three of the four, a DRAFT automation catalog row (the
 * executor only ever loads `status = 'active'` — see
 * email-template-automation-executor.js:400, and none of these three
 * trigger_event_keys are wired in TRIGGER_MAPPINGS yet either — that wiring
 * is a later PR). lc.rain_and_treatment gets a template + fixtures only:
 * its trigger event does not exist yet.
 *
 * Copy source: the 2026-09-28 draft (email-division-templates-draft-20260928.md,
 * not shipped in this repo), including its two later revisions
 * (label/manufacturer-verified numbers only; the UF/IFAS LH059 timing claim
 * removed after the citation was found withdrawn).
 *
 * Fixes six findings Codex raised on #5160 (head 29a358fbd), incorporated
 * directly here rather than as a correction chain, since nothing here has
 * been pushed before:
 *  - P1: down() is a documented no-op (waves-db §4 / Codex: a seed rollback
 *    must never delete a row an operator has since edited or published;
 *    the simplest, established way to guarantee that is to never delete).
 *  - P1: legal_classification 'commercial' isn't in the admin API's
 *    enum (transactional_relationship | commercial_marketing | mixed) —
 *    nurture.expired_1's template AND automation rows now use
 *    'commercial_marketing'.
 *  - P1: the expired-estimate CTA is relabeled and the body copy rewritten
 *    to describe what the link actually does once the estimate is expired
 *    (isEstimateCustomerViewable is false for status 'expired', but
 *    isEstimateExtensionRequestEligible is true for a real, once-sent
 *    estimate — EstimateViewPage.jsx's 404 branch renders a working
 *    "request more time" action against the SAME token via POST
 *    /:token/extension-request). The link target is unchanged (still the
 *    estimate page); only the promise made about it changed.
 *  - P2: nurture.expired_1's idempotency key now includes {estimate_id},
 *    not just {customer_email} — otherwise a second estimate emailed to
 *    the same address after the first's follow-up would dedupe away.
 *  - P2: the three lc.* templates' `purpose` is 'pest' (was 'lawn_care') —
 *    they are structural pest-control lifecycle emails, not lawn care.
 *  - P1 (local pre-push audit, Codex out of quota / claude fallback):
 *    up() re-running (e.g. a manually cleared knex_migrations row) must
 *    never overwrite a template/version/automation row an operator has
 *    since drafted or published — upsertTemplate/upsertAutomation now
 *    read-modify-write, skipping the overwrite whenever created_by /
 *    last_published_by / published_by is non-null (only an authenticated
 *    admin action ever sets those; this migration's own inserts never do).
 *  - P2: nurture.expired_1's content_sensitivity is 'normal' (was 'lead',
 *    not in the admin API's enum: normal | financial | account |
 *    health_safety | property_sensitive).
 *
 * Optional-section mechanism: every section whose fact may be unknown is its
 * own single-row `details` block (`variant: 'faq'`) whose value is ONE
 * pre-composed sentence variable (e.g. rain_since_visit_sentence). The
 * library already drops a details block entirely when every row's value is
 * blank (email-template-library.js renderBlocks 'details' branch filters
 * empty rows first, then skips the block when none remain) — so the label
 * (the section's heading) and the sentence disappear together, with no
 * static filler and no orphan heading. No library change needed. A variable
 * that's optional but not independently renderable on its own line
 * (secondary_products_sentence in B1) gets its own single-variable paragraph
 * block for the same reason: a blank paragraph block already renders nothing.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const GUIDES_B1 = { type: 'small_note', content: 'Guides: Ghost ants in Florida kitchens · Do pest control sprays harm pets · What every visit covers' };
const SOURCE_B1 = { type: 'small_note', content: 'Source: activity averages are Waves visit records, 2026; rain is NOAA radar near your home, local totals may vary; product behavior from the manufacturer and the product label.' };
const GUIDES_B5 = { type: 'small_note', content: 'Guides: What every visit covers · Ghost ants in Florida kitchens' };
const SOURCE_B5 = { type: 'small_note', content: 'Source: activity ratings are Waves visit records, 2026; product behavior from the manufacturer label.' };
const GUIDES_B6 = { type: 'small_note', content: 'Guides: Palmetto bugs after rain · Ants after the storm' };
const SOURCE_B6 = { type: 'small_note', content: 'Source: rain from NOAA radar near your home; forecast from the National Weather Service; local totals may vary.' };
const SOURCE_C1 = { type: 'small_note', content: 'Source: local activity figures are Waves visit records, current season.' };
const SIGNATURE = { type: 'signature', content: '— The Waves Team' };

const TEMPLATES = [
  {
    key: 'lc.first_visit_pest',
    name: 'Lawn Care · First Visit Pest Follow-Up',
    purpose: 'pest',
    sensitivity: 'account',
    suppressionGroup: 'service_operational',
    required: [
      'first_name', 'visit_date_short', 'visit_date_long', 'tech_first_name', 'areas_treated_list',
      'primary_product_name', 'primary_active_ingredient', 'primary_product_family_phrase',
      'pests_named_list', 'next_visit_date',
    ],
    optional: ['secondary_products_sentence', 'activity_rating_sentence', 'rain_since_visit_sentence', 'pet_advisory_sentence'],
    subject: 'What the treatment at your foundation is doing today, {{first_name}}',
    preview: "Day-by-day, what to expect from {{visit_date_short}}'s visit, and when to call us.",
    blocks: [
      { type: 'heading', content: 'What we did on {{visit_date_long}}' },
      { type: 'paragraph', content: '{{tech_first_name}} treated {{areas_treated_list}}. The main product was {{primary_product_name}} ({{primary_active_ingredient}}), a {{primary_product_family_phrase}}.' },
      { type: 'paragraph', content: '{{secondary_products_sentence}}' },
      { type: 'paragraph', content: 'The pests recorded at your home: {{pests_named_list}}.' },
      { type: 'heading', content: 'What to expect' },
      { type: 'list', items: [
        'The band at your foundation is a non-repellent: ants and roaches cannot detect it, so they keep walking through it and carry it back to the colony. It works through the colony rather than killing on contact.',
        'That is why you may still see ants after the visit, sometimes for a while. It is the treatment working, not failing. Please do not spray the ants you see with a store-bought repellent; it scatters the colony.',
        'Spiders, wasps and anything that walks the treated surfaces are handled by the contact product on the eaves, entry points and lanai.',
      ] },
      { type: 'details', variant: 'faq', rows: [{ label: 'Your number', value: '{{activity_rating_sentence}}' }] },
      { type: 'details', variant: 'faq', rows: [{ label: 'Rain since the visit', value: '{{rain_since_visit_sentence}}' }] },
      { type: 'details', variant: 'faq', rows: [{ label: 'Pets and re-entry', value: '{{pet_advisory_sentence}}' }] },
      { type: 'paragraph', content: 'If you still see activity on day 21, reply to this email or text us a photo. A re-service between visits is free on your plan. Your next visit is scheduled for about {{next_visit_date}}; 91 days is our median.' },
      GUIDES_B1,
      SOURCE_B1,
      SIGNATURE,
    ],
    fixtures: {
      full: {
        first_name: 'Jordan', visit_date_short: 'Sep 24', visit_date_long: 'September 24, 2026',
        tech_first_name: 'Marco', areas_treated_list: 'the foundation perimeter, garage entry, and lanai',
        primary_product_name: 'Taurus SC', primary_active_ingredient: 'fipronil',
        primary_product_family_phrase: 'non-repellent that ants carry back to the colony',
        secondary_products_sentence: 'We also applied a contact residual along the eaves and entry points for spiders and wasps.',
        pests_named_list: 'ghost ants and Cuban brown roaches',
        activity_rating_sentence: 'Your activity rating at this visit was 3 of 5. Across Waves customers, the activity rating at the first visit averages 2.9 out of 5 and 1.1 at the second.',
        rain_since_visit_sentence: '0.8 inches of rain fell at your address since the visit. The product label asks us to apply when rain is not predicted for the next 24 hours, and we plan visits around that. Heavy rain afterwards does push ants and palmetto bugs indoors for a few days. A flare this week after a storm is weather, not a failed treatment.',
        // AGENTS.md compliance rule: never a fixed re-entry/drying minute
        // figure — "safe once dry" + technician confirms timing.
        pet_advisory_sentence: "Keep pets and kids off the treated foundation line and interior baseboards until they're dry — the technician confirmed the exact timing on your visit report.",
        next_visit_date: 'December 24, 2026',
      },
      sparse: {
        first_name: 'Jordan', visit_date_short: 'Sep 24', visit_date_long: 'September 24, 2026',
        tech_first_name: 'Marco', areas_treated_list: 'the foundation perimeter and garage entry',
        primary_product_name: 'Taurus SC', primary_active_ingredient: 'fipronil',
        primary_product_family_phrase: 'non-repellent that ants carry back to the colony',
        secondary_products_sentence: '', pests_named_list: 'ghost ants',
        activity_rating_sentence: '', rain_since_visit_sentence: '', pet_advisory_sentence: '',
        next_visit_date: 'December 24, 2026',
      },
    },
  },
  {
    key: 'lc.why_91_days',
    name: 'Lawn Care · Why 91 Days',
    purpose: 'pest',
    sensitivity: 'account',
    suppressionGroup: 'service_operational',
    // The draft's per-template Variables list omits first_name (it treats
    // it as an ambient customer-payload field, same as the irrigation seed's
    // SHARED_VARIABLES), but the subject line uses {{first_name}} in all
    // four templates, so it is added to allowed/required here for every one.
    required: ['first_name', 'plan_interval_days', 'plan_name', 'nonrepellent_product', 'contact_product'],
    optional: ['area_intel_sentence'],
    subject: 'Why we come back every {{plan_interval_days}} days, {{first_name}}',
    preview: 'The two products on your plan, how long each one holds, and what the free re-service is for.',
    blocks: [
      { type: 'heading', content: 'Two products, two jobs' },
      { type: 'paragraph', content: 'Your {{plan_name}} uses a non-repellent band ({{nonrepellent_product}}) and a contact product ({{contact_product}}). The non-repellent is carried into the colony by the ants themselves, so it keeps working after the ants you can see are gone. The contact product works on the surfaces it is sprayed on: eaves, entry points, the lanai. It is what keeps spiders and wasps from settling there, and it wears with sun, rain and time.' },
      { type: 'heading', content: 'So why {{plan_interval_days}} days' },
      { type: 'paragraph', content: 'Surfaces weather and new colonies move in from the lot line, so the perimeter has to be renewed before that happens rather than after. Our own records are the evidence: the activity rating at a first visit averages 2.9 out of 5, and by the second visit it averages 1.1. Coming more often renews the surface product sooner; it does not make the colony product work faster, which is why we do not push monthly visits on a home that is holding.' },
      { type: 'heading', content: 'Between visits' },
      { type: 'paragraph', content: 'If something shows up in weeks 4 to 12, that is what the free re-service is for. Reply here or text a photo; we come out at no charge and it does not move your next scheduled visit.' },
      { type: 'details', variant: 'faq', rows: [{ label: 'This month near you', value: '{{area_intel_sentence}}' }] },
      GUIDES_B5,
      SOURCE_B5,
      SIGNATURE,
    ],
    fixtures: {
      full: {
        first_name: 'Jordan', plan_interval_days: '91', plan_name: 'Quarterly Pest Plan',
        nonrepellent_product: 'Taurus SC', contact_product: 'a bifenthrin contact spray',
        area_intel_sentence: 'In September our technicians treated ants at 55 of 90 visits in Manatee County; it is the busiest ant month of the year.',
      },
      sparse: {
        first_name: 'Jordan', plan_interval_days: '91', plan_name: 'Quarterly Pest Plan',
        nonrepellent_product: 'Taurus SC', contact_product: 'a bifenthrin contact spray',
        area_intel_sentence: '',
      },
    },
  },
  {
    key: 'lc.rain_and_treatment',
    name: 'Lawn Care · Rain and Your Treatment',
    purpose: 'pest',
    sensitivity: 'account',
    suppressionGroup: 'service_operational',
    required: ['first_name', 'nonrepellent_product', 'contact_product', 'irrigation_hold_hours'],
    optional: ['rain_last_7_sentence', 'forecast_sentence'],
    subject: "What rain does to your treatment (and what it doesn't), {{first_name}}",
    // Not "the one-hour rule" (the copy revision dropped that
    // retailer-sourced drying-time claim) — dry-first plus the label's
    // 24-hour no-rain-forecast window are the two rules the body describes.
    preview: 'Dry first, no rain in the forecast, and why the ants show up right after a storm.',
    blocks: [
      { type: 'heading', content: 'The two rules our technicians work by' },
      { type: 'list', items: [
        'Dry first. The band at your foundation ({{nonrepellent_product}}) and the contact product on the eaves and entry points ({{contact_product}}) both need to dry before people or pets are back on treated surfaces; that instruction is on the product label and on your visit report.',
        'No rain in the forecast. The label asks for application when rain is not predicted for the next 24 hours, so wind or rain does not wash the product off the treated area. It is also why your visit report asked you to hold irrigation for {{irrigation_hold_hours}} hours.',
      ] },
      { type: 'heading', content: "When we reschedule for rain, and when we don't" },
      { type: 'paragraph', content: 'The label does not allow application during rain, and a forecast with no dry window defeats the purpose, so we move the visit rather than treat into a downpour. You get a text the morning of with the forecast chance and a link to pick the new time. If the day turns out dry after all, the next open slot is yours; reply to the text.' },
      { type: 'heading', content: 'Why the ants come in after a storm' },
      { type: 'paragraph', content: 'Heavy rain floods colonies in the lawn and beds, and the survivors move to the driest place they can reach: your kitchen. This is not the treatment failing. The band is between them and the house; most of what you see in the two days after a storm is walking through it. Wipe the trail, fix the drip under the sink if there is one, and do not spray repellent indoors.' },
      { type: 'details', variant: 'faq', rows: [{ label: 'At your address this week', value: '{{rain_last_7_sentence}}' }] },
      { type: 'details', variant: 'faq', rows: [{ label: 'Looking ahead', value: '{{forecast_sentence}}' }] },
      GUIDES_B6,
      SOURCE_B6,
      SIGNATURE,
    ],
    fixtures: {
      full: {
        first_name: 'Jordan', nonrepellent_product: 'Taurus SC', contact_product: 'a bifenthrin contact spray',
        irrigation_hold_hours: '24',
        rain_last_7_sentence: '0.8 inches of rain fell at your address in the last 7 days.',
        forecast_sentence: 'No rain is in the forecast for the next 3 days.',
      },
      sparse: {
        first_name: 'Jordan', nonrepellent_product: 'Taurus SC', contact_product: 'a bifenthrin contact spray',
        irrigation_hold_hours: '24', rain_last_7_sentence: '', forecast_sentence: '',
      },
    },
  },
  {
    key: 'nurture.expired_1',
    name: 'Nurture · Estimate Expired (Touch 1)',
    purpose: 'nurture',
    sensitivity: 'normal',
    suppressionGroup: 'marketing_nurture',
    required: ['first_name', 'service_quoted', 'address_short', 'expired_date_short', 'pest_or_problem_named', 'estimate_link'],
    optional: ['area_intel_sentence', 'consultation_offer_block'],
    ctaLabel: 'Request more time on my estimate',
    ctaUrlVariable: 'estimate_link',
    subject: 'Still here if you need us, {{first_name}}',
    preview: 'Your {{service_quoted}} estimate is saved. One question.',
    blocks: [
      // The link is the SAME estimate page either way — an estimate expired
      // 3 days ago is never isEstimateCustomerViewable (estimate-public.js),
      // but IS isEstimateExtensionRequestEligible for a real, once-sent
      // estimate, and EstimateViewPage.jsx's 404 branch renders a working
      // "request more time" action against that same token (POST
      // /:token/extension-request) rather than a dead end. Copy below
      // describes THAT action, not "view your saved numbers" (Codex P1).
      { type: 'paragraph', content: "Your estimate for {{service_quoted}} at {{address_short}} reached its date on {{expired_date_short}}. Nothing has been booked, and the numbers are still on file — the link below lets you request more time on the same estimate, no new quote needed." },
      { type: 'heading', content: 'One question: did the {{pest_or_problem_named}} get handled?' },
      { type: 'paragraph', content: 'If it did, reply "handled" and we will stop writing. If it didn\'t, reply with what you are seeing now and we will tell you straight whether the quote still fits.' },
      { type: 'details', variant: 'faq', rows: [{ label: 'What we are seeing near you', value: '{{area_intel_sentence}}' }] },
      { type: 'paragraph', content: '{{consultation_offer_block}}' },
      { type: 'cta', label: 'Request more time on my estimate', url_variable: 'estimate_link' },
      { type: 'small_note', content: 'No prices in this email; the estimate page carries them. If you would rather not hear from us about this, the link at the bottom stops these in one click.' },
      SOURCE_C1,
      SIGNATURE,
    ],
    fixtures: {
      full: {
        first_name: 'Jordan', service_quoted: 'quarterly pest control', address_short: 'Blackburn Point Rd',
        expired_date_short: 'Sep 21', pest_or_problem_named: 'ghost ants',
        area_intel_sentence: 'In the last 60 days our technicians treated big-headed ants at 65% of our visits in Parrish.',
        consultation_offer_block: 'Not sure yet? For recurring plans we will come look first, free, and quote from what we find: https://portal.wavespestcontrol.com/inspection/sample-token',
        estimate_link: 'https://portal.wavespestcontrol.com/estimate/sample',
      },
      sparse: {
        first_name: 'Jordan', service_quoted: 'quarterly pest control', address_short: 'Blackburn Point Rd',
        expired_date_short: 'Sep 21', pest_or_problem_named: 'ghost ants',
        area_intel_sentence: '', consultation_offer_block: '',
        estimate_link: 'https://portal.wavespestcontrol.com/estimate/sample',
      },
    },
  },
];

// lc.rain_and_treatment has no catalog row — no automation entry names it
// (its trigger event does not exist yet; see PR body). None of these three
// trigger_event_keys are in TRIGGER_MAPPINGS
// (email-template-automation-executor.js) yet either — wiring that, and
// flipping status to 'active', is a later PR; these rows do nothing today.
const AUTOMATIONS = [
  {
    key: 'lc.first_visit_pest', name: 'Lawn Care · First Visit Pest Follow-Up',
    trigger: 'visit.completed_first', template: 'lc.first_visit_pest', delayMinutes: 2880,
    suppressionGroup: 'service_operational', legal: 'transactional_relationship',
    frequencyCap: 'once_per_customer', idempotency: 'lc.first_visit_pest:{customer_id}',
    exit: { stop_if: ['customer.cancelled'] },
    dryRunNotes: "Fires 2 days after a customer's first completed pest visit (visit.completed_first).",
  },
  {
    key: 'lc.why_91_days', name: 'Lawn Care · Why 91 Days',
    trigger: 'visit.completed_first', template: 'lc.why_91_days', delayMinutes: 20160,
    suppressionGroup: 'service_operational', legal: 'transactional_relationship',
    frequencyCap: 'once_per_customer', idempotency: 'lc.why_91_days:{customer_id}',
    exit: { stop_if: ['customer.cancelled'] },
    dryRunNotes: "Fires 14 days after a customer's first completed pest visit (visit.completed_first).",
  },
  {
    key: 'nurture.expired_1', name: 'Nurture · Estimate Expired (Touch 1)',
    trigger: 'estimate.expired', template: 'nurture.expired_1', delayMinutes: 4320,
    suppressionGroup: 'marketing_nurture', legal: 'commercial_marketing',
    // {estimate_id} keeps two different estimates emailed to the same
    // address from deduplicating into one automation run (Codex P2).
    frequencyCap: 'once_per_estimate', idempotency: 'nurture.expired_1:{customer_email}:{estimate_id}',
    exit: { stop_if: ['estimate.accepted', 'estimate.archived'] },
    dryRunNotes: 'Fires 3 days after an estimate expires (estimate.expired).',
  },
];

function templateRow(t) {
  const allowed = [...t.required, ...t.optional];
  return {
    template_key: t.key,
    name: t.name,
    description: t.description || null,
    mode: 'service',
    purpose: t.purpose,
    legal_classification: t.suppressionGroup === 'marketing_nurture' ? 'commercial_marketing' : 'transactional_relationship',
    audience: 'customer',
    message_priority: 'normal',
    content_sensitivity: t.sensitivity || 'normal',
    send_stream: t.suppressionGroup,
    suppression_group_key: t.suppressionGroup,
    layout_wrapper_id: 'service_default_v1',
    from_name: 'Waves Pest Control',
    from_email: SERVICE_FROM,
    reply_to: SERVICE_FROM,
    default_cta_label: t.ctaLabel || null,
    default_cta_url_variable: t.ctaUrlVariable || null,
    allowed_variables: JSON.stringify(allowed),
    required_variables: JSON.stringify(t.required),
    optional_variables: JSON.stringify(t.optional),
    // Draft: assertTemplateSendable in email-template-library.js refuses
    // anything except 'active' (409 EMAIL_TEMPLATE_DISABLED) — this is what
    // makes the seed unsendable, not an absent automation row.
    status: 'draft',
    updated_at: new Date(),
  };
}

function automationRow(a) {
  return {
    automation_key: a.key,
    name: a.name,
    description: a.dryRunNotes || null,
    trigger_event_key: a.trigger,
    trigger_description: a.dryRunNotes || null,
    template_key: a.template,
    delay_minutes: a.delayMinutes,
    audience: 'customer',
    // Draft: the executor only loads status = 'active' rows
    // (email-template-automation-executor.js:400) — this row does nothing
    // until an operator flips it, independent of the template's own status.
    status: 'draft',
    suppression_group_key: a.suppressionGroup,
    legal_classification: a.legal,
    frequency_cap: a.frequencyCap,
    idempotency_key_template: a.idempotency,
    conditions: JSON.stringify({}),
    exit_conditions: JSON.stringify(a.exit),
    retry_policy: JSON.stringify({ max_attempts: 2, backoff_minutes: [15, 60] }),
    quiet_hours: JSON.stringify({ enabled: false }),
    timezone: 'America/New_York',
    owner: 'operations',
    dry_run_notes: a.dryRunNotes || null,
    updated_at: new Date(),
  };
}

// `created_by` / `last_published_by` (templates) and `created_by` /
// `published_by` (versions) are only ever set by an authenticated admin
// action (admin-email-templates.js, behind adminAuthenticate) — this
// migration's own inserts never set them. A non-null value is therefore
// conclusive proof a person has touched the row since it was seeded (drafted
// a revision via createDraftVersion, or published one), and re-running up()
// must never overwrite that — the local pre-push audit's own P1 finding on
// this file (the seed's up() unconditionally overwrote rows on every
// re-run, which would silently revert an operator's published edit if the
// migration were ever re-applied, e.g. a manually cleared knex_migrations
// row). Read-modify-write, not overwrite, same principle as down() below.
function touchedByHuman(row) {
  return !!(row && (row.created_by || row.last_published_by || row.published_by));
}

async function upsertTemplate(knex, t) {
  const existing = await knex('email_templates').where({ template_key: t.key }).first();
  let template = existing;
  const row = templateRow(t);

  if (!template) {
    [template] = await knex('email_templates').insert({ ...row, created_at: new Date() }).returning('*');
  } else if (!touchedByHuman(template)) {
    await knex('email_templates').where({ id: template.id }).update(row);
    template = await knex('email_templates').where({ id: template.id }).first();
  }
  // else: an operator has already touched this template row — leave it
  // exactly as they left it.

  // A brand-new, never-published template has no active_version_id (that
  // field is set only by publishVersion, on an explicit staff publish) — so
  // idempotency here is keyed on template_id alone: reuse whatever version
  // this seed previously wrote instead of growing a new version_number on
  // every migration re-run.
  let version = await knex('email_template_versions')
    .where({ template_id: template.id })
    .orderBy('version_number', 'desc')
    .first();
  const versionFields = {
    // Draft template rows never carry an 'active' version — publishVersion
    // is the only path that flips a version (and its template) to active.
    status: 'draft',
    subject: t.subject,
    preview_text: t.preview || null,
    blocks: JSON.stringify(t.blocks || []),
    text_body: null,
    updated_at: new Date(),
  };
  if (!version) {
    const latest = await knex('email_template_versions')
      .where({ template_id: template.id })
      .max('version_number as max')
      .first();
    const nextVersion = Number(latest?.max || 0) + 1;
    [version] = await knex('email_template_versions').insert({
      template_id: template.id,
      version_number: nextVersion,
      created_at: new Date(),
      ...versionFields,
    }).returning('*');
  } else if (!touchedByHuman(version)) {
    await knex('email_template_versions').where({ id: version.id }).update(versionFields);
  }
  // else: the latest version is an operator's own draft or published
  // revision (created_by/published_by set via createDraftVersion /
  // publishVersion) — leave its content alone.

  if (await knex.schema.hasTable('email_template_fixtures')) {
    for (const [name, payload] of Object.entries(t.fixtures || {})) {
      const isDefault = name === 'full';
      const existingFixture = await knex('email_template_fixtures')
        .where({ template_id: template.id, name })
        .first();
      const fields = { name, payload: JSON.stringify(payload), is_default: isDefault, updated_at: new Date() };
      if (existingFixture) {
        await knex('email_template_fixtures').where({ id: existingFixture.id }).update(fields);
      } else {
        await knex('email_template_fixtures').insert({ template_id: template.id, created_at: new Date(), ...fields });
      }
    }
  }
}

async function upsertAutomation(knex, a) {
  const existing = await knex('email_template_automations').where({ automation_key: a.key }).first();
  const row = automationRow(a);
  if (!existing) {
    await knex('email_template_automations').insert({ ...row, created_at: new Date() });
  } else if (!touchedByHuman(existing)) {
    await knex('email_template_automations').where({ id: existing.id }).update(row);
  }
  // else: an operator has already touched this automation row.
}

exports.up = async function up(knex) {
  const hasTemplateTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions');
  if (hasTemplateTables) {
    for (const template of TEMPLATES) {
      await upsertTemplate(knex, template);
    }
  }
  if (await knex.schema.hasTable('email_template_automations')) {
    for (const automation of AUTOMATIONS) {
      await upsertAutomation(knex, automation);
    }
  }
};

// Documented no-op (waves-db §4 / Codex round-0 P1 on #5160): a seed
// migration for admin-editable rows must never delete-by-key on rollback —
// an operator may have edited or published one of these templates since it
// ran, and deleting the template row cascades (FK) to its versions and
// fixtures, permanently discarding that edit. Seed/data-correction
// rollbacks are never destructive (same convention as
// 20260702000003_seed_flea_prep_email_automation.js's down()).
exports.down = async function down() {};

exports.TEMPLATES = TEMPLATES;
exports.AUTOMATIONS = AUTOMATIONS;
exports.__private = { TEMPLATES, AUTOMATIONS, templateRow, automationRow };

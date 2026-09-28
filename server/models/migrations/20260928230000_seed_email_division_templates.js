/**
 * Email division — first four templates. Second re-cut in this lane:
 * #5160/20260928080000 was closed (its seed migration was pushed and
 * therefore frozen per waves-db §4); its replacement, #5252/20260928220000
 * on branch feat/email-division-templates-v2, is ALSO being closed as
 * superseded by this PR — that seed migration had likewise already been
 * pushed once (making it frozen too) before the Fable review, Codex round
 * 1, and three more local pre-push audit rounds below were fixed directly
 * on top of it across several local commits; `git push` on that branch was
 * then correctly refused by the migration-guard pre-push hook (a pushed
 * migration file may never be edited, only superseded). Re-cutting the
 * whole PR — a fresh branch off refreshed origin/main, one new migration
 * file with everything folded in from the start — was simpler and safer
 * than writing a chain of UPDATE-only correction migrations for a change
 * this large (new copy in every block, a removed automations section, and
 * a changed re-run guard). This file's OWN content is exactly what
 * feat/email-division-templates-v2's local history converged on; only the
 * filename/timestamp and this note are new. Frozen the same way once
 * pushed — see waves-db §4 before editing anything below.
 *
 * Seeds four templates DRAFT (assertTemplateSendable in email-template-library.js
 * refuses anything but 'active', so nothing here can send). Templates only —
 * no automation catalog rows: Codex round 1 on #5252 (P2 :280) found the
 * executor (email-template-automation-executor.js) dispatches a trigger
 * straight through sendTemplate, not through the email division's own
 * sendWithLedger eligibility/cap/reservation path (server/services/
 * email-division/ledger.js, #5157) — seeding automation rows here, even
 * draft ones, would misdescribe how this division is meant to send. The
 * wiring PR that maps visit.completed_first / estimate.expired into
 * TRIGGER_MAPPINGS and creates the catalog rows MUST dispatch through
 * sendWithLedger, not the executor's direct sendTemplate call.
 *
 * Copy source: the 2026-09-28 draft (email-division-templates-draft-20260928.md,
 * not shipped in this repo), including its two later revisions
 * (label/manufacturer-verified numbers only; the UF/IFAS LH059 timing claim
 * removed after the citation was found withdrawn), PLUS an independent
 * Fable review of #5252 (head ef8a9a5bdf) checked every remaining factual
 * claim against server/services/email-division/fact-register-data.js
 * (feat/email-division-fact-register-v4) — the only source besides Waves'
 * own named data a claim in this copy may rest on. Claims with no entry
 * there were reworded or removed rather than added to the register (that
 * file belongs to #5187): dropped or rewritten — a "you may still see ants,
 * it's working, don't spray a repellent" aside with no source; "spiders and
 * wasps handled by the contact product" (no target-pest claim in the
 * register for bifenthrin); "keeps working after the ants you can see are
 * gone" / "wears with sun, rain and time" (the register explicitly states
 * no residual duration for either product and forbids attributing a
 * visibility timeline to the manufacturer); "new colonies move in from the
 * lot line" / "coming more often renews the surface product sooner" (no
 * such mechanism in the register — the "why this cadence" case now rests on
 * Waves' own activity-rating data instead); "ants after a storm... colonies
 * flood... two days" (the register supports American cockroaches moving
 * indoors during extreme weather, not ants, and states no day count — the
 * whole section is reframed around the supported cockroach fact); the
 * dry-before-contact label instruction attributed to BOTH products (the
 * register carries it only for the bifenthrin/Talak label); "91 days is our
 * median" (no source line covers it); "the estimate page carries [the
 * prices]" and an unconditional "request more time" promise (the extension
 * action is conditional — isEstimateExtensionRequestEligible, estimate-
 * public.js — so the copy now promises only what holds for every
 * recipient). What's kept and re-verified: Taurus SC is a non-repellent
 * pests can't detect and spread through the colony (manufacturer); the
 * bifenthrin/Talak label's 24-hour no-rain-forecast window, no application
 * during rain, dry-before-contact, and the lawn watering/mowing hold
 * (label says "for lawns" — not extended to the perimeter band here);
 * American cockroaches ("palmetto bugs") move indoors for food, water, or
 * to avoid extreme weather (UF/IFAS); Waves' own activity-rating averages,
 * computed nightly across completed visits (getActivityRatingAverages(),
 * server/services/email-division/visit-products.js) and area-intel
 * sentences (getAreaIntelSentence(), server/services/email-division/
 * area-intel.js) — named here so both are checkable against their actual
 * readers, not just a generic "Waves data" line.
 *
 * Fixes six findings Codex raised on #5160 (head 29a358fbd):
 *  - down() is a documented no-op (waves-db §4 / Codex: a seed rollback
 *    must never delete a row an operator has since edited or published;
 *    the simplest, established way to guarantee that is to never delete).
 *  - legal_classification 'commercial' isn't in the admin API's enum
 *    (transactional_relationship | commercial_marketing | mixed) —
 *    nurture.expired_1 now uses 'commercial_marketing'.
 *  - the expired-estimate CTA/copy describe what the link actually does
 *    (see the Fable P2-4 note above — refined further on this round).
 *  - the three lc.* templates' `purpose` is 'pest' (was 'lawn_care').
 *
 * Local pre-push audit (5 rounds, #5252's first push) fixed re-run
 * overwrite bugs with a touchedByHuman() provenance guard on templates/
 * versions/automations, plus insert-once for fixtures (no provenance
 * column), a service-chrome wrapper pin for the marketing_nurture
 * template, and a PII-free idempotency key. Two later rounds superseded
 * pieces of that:
 *  - Fable P2-3 / Codex P2 :401 on #5252: PUT /:key (template) and
 *    PUT /versions/:id (draft version) never set created_by /
 *    last_published_by / published_by (admin-email-templates.js), so an
 *    ordinary in-place edit through the real admin routes was NOT proof
 *    against touchedByHuman() and would still be silently reverted by a
 *    re-run. Codex's accepted remedy, applied here: insert-once for
 *    templates AND versions too (not just fixtures) — a re-run never
 *    updates a row that already exists, full stop. A later content change
 *    to a template ships as a new migration or is made through the admin
 *    UI, never as an edit to this file's seed values (this file is
 *    frozen anyway — see the top of this comment).
 *  - Codex P2 :280 on #5252: automations removed entirely (see above) —
 *    this also resolves Fable P2-5 (the automation `audience` field) since
 *    no automation row is seeded.
 *  - Codex P2 :91 on #5252: the three lc.* templates' displayed `name`
 *    (the admin list's primary label) is "Pest Control — …", not
 *    "Lawn Care — …" — they are pest-control lifecycle emails.
 *
 * Optional-section mechanism: every section whose fact may be unknown is its
 * own single-row `details` block (`variant: 'faq'`) whose value is ONE
 * pre-composed sentence variable (e.g. rain_since_visit_sentence). The
 * library already drops a details block entirely when every row's value is
 * blank (email-template-library.js renderBlocks 'details' branch filters
 * empty rows first, then skips the block when none remain) — so the label
 * (the section's heading) and the sentence disappear together, with no
 * static filler and no orphan heading. No library change needed for this
 * mechanism. A variable that's optional but not independently renderable on
 * its own line (secondary_products_sentence in B1) gets its own
 * single-variable paragraph block for the same reason: a blank paragraph
 * block already renders nothing.
 *
 * The unsubscribe-footer wording fix (Fable P1-1 — the service-chrome
 * footer was hardcoded to "referral emails" for every service_pinned_v1
 * template) is a LIBRARY change, not a migration one: see
 * email-template-library.js's unsubscribeFooterLabelFor().
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const GUIDES_B1 = { type: 'small_note', content: 'Guides: Ghost ants in Florida kitchens · Do pest control sprays harm pets · What every visit covers' };
// No year in this footer: the migration is insert-once/frozen (see the
// header comment) and this row is never auto-updated, so a hardcoded year
// would read as stale in any year other than when it was seeded — "activity
// averages" and "computed nightly" already say this is a rolling, ongoing
// figure (local pre-push audit round 6 P1).
const SOURCE_B1 = { type: 'small_note', content: 'Source: activity averages are Waves visit records, computed nightly across completed visits; rain is NOAA radar near your home, local totals may vary; non-repellent behavior from the Taurus SC manufacturer; indoor movement during weather from University of Florida IFAS.' };
const GUIDES_B5 = { type: 'small_note', content: 'Guides: What every visit covers · Ghost ants in Florida kitchens' };
const SOURCE_B5 = { type: 'small_note', content: 'Source: activity ratings are Waves visit records, computed nightly across completed visits; non-repellent behavior from the Taurus SC manufacturer.' };
const GUIDES_B6 = { type: 'small_note', content: 'Guides: Palmetto bugs after rain' };
const SOURCE_B6 = { type: 'small_note', content: 'Source: rain from NOAA radar near your home; forecast from the National Weather Service; local totals may vary; product behavior from the Talak 7.9% F label; indoor movement during weather from University of Florida IFAS.' };
const SOURCE_C1 = { type: 'small_note', content: 'Source: local activity figures are Waves visit records, current season.' };
const SIGNATURE = { type: 'signature', content: '— The Waves Team' };

const TEMPLATES = [
  {
    key: 'lc.first_visit_pest',
    name: 'Pest Control · First Visit Follow-Up',
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
      { type: 'paragraph', content: 'The band at your foundation is a non-repellent: ants and roaches cannot detect it, so they keep walking through it and carry it back to the colony. It works through the colony rather than killing on contact.' },
      { type: 'details', variant: 'faq', rows: [{ label: 'Your number', value: '{{activity_rating_sentence}}' }] },
      { type: 'details', variant: 'faq', rows: [{ label: 'Rain since the visit', value: '{{rain_since_visit_sentence}}' }] },
      { type: 'details', variant: 'faq', rows: [{ label: 'Pets and re-entry', value: '{{pet_advisory_sentence}}' }] },
      { type: 'paragraph', content: 'If you still see activity on day 21, reply to this email or text us a photo. A re-service between visits is free on your plan. Your next visit is scheduled for about {{next_visit_date}}.' },
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
        secondary_products_sentence: 'We also applied a contact residual along the eaves and entry points.',
        pests_named_list: 'ghost ants and Cuban brown roaches',
        activity_rating_sentence: 'Your activity rating at this visit was 3 of 5. Across Waves customers, the activity rating at the first visit averages 2.9 out of 5 and 1.1 at the second.',
        // Rewritten per the fact register (Fable P1-2 on #5252): no "ants",
        // no duration ("for a few days") — American cockroaches moving
        // indoors during extreme weather is the one supported claim here.
        rain_since_visit_sentence: "0.8 inches of rain fell at your address since the visit. We plan visits around forecast rain to protect the products we use. American cockroaches — sometimes called palmetto bugs — often move indoors during extreme weather, so a flare this week after a storm is weather, not a failed treatment.",
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
    name: 'Pest Control · Why 91 Days',
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
      // Rewritten per the fact register: kept the touch/ingest/spread
      // mechanism (Taurus SC manufacturer); dropped "keeps working after
      // the ants you can see are gone" (a visibility-duration claim the
      // register forbids attributing to the manufacturer) and "spiders and
      // wasps... it wears with sun, rain and time" (no target-pest or
      // residual-duration claim in the bifenthrin/Talak label).
      { type: 'paragraph', content: "Your {{plan_name}} uses a non-repellent band ({{nonrepellent_product}}) and a contact product ({{contact_product}}). The non-repellent is carried into the colony by the ants themselves — they can't detect it, so they track it back and spread it to the rest of the colony. The contact product goes on the surfaces where pests travel: eaves, entry points, the lanai." },
      { type: 'heading', content: 'So why {{plan_interval_days}} days' },
      // Rewritten: the "surfaces weather" / "new colonies move in from the
      // lot line" / "renews the surface product sooner" claims had no
      // source — the cadence case now rests only on Waves' own
      // activity-rating data (SOURCE_B5), stated as evidence for the
      // cadence rather than a claim about how long a product lasts.
      { type: 'paragraph', content: 'Our own visit records are the evidence, not a claim about how long any single product lasts: the activity rating at a first visit averages 2.9 out of 5, and by the second visit it averages 1.1. That is the pattern this cadence is built around — coming more often would mean visits sooner, not a faster-working product, which is why we do not push monthly visits on a home that is holding.' },
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
    name: 'Pest Control · Rain and Your Treatment',
    purpose: 'pest',
    sensitivity: 'account',
    suppressionGroup: 'service_operational',
    required: ['first_name', 'nonrepellent_product', 'contact_product', 'irrigation_hold_hours'],
    optional: ['rain_last_7_sentence', 'forecast_sentence'],
    subject: "What rain does to your treatment (and what it doesn't), {{first_name}}",
    // Not "the one-hour rule" (the copy revision dropped that
    // retailer-sourced drying-time claim), and not "why the ants show up"
    // (the fact register supports American cockroaches moving indoors
    // during extreme weather, not ants — Fable P1-2 on #5252).
    preview: 'Dry first, no rain in the forecast, and why palmetto bugs turn up after bad weather.',
    blocks: [
      { type: 'heading', content: 'The two rules our technicians work by' },
      { type: 'list', items: [
        // The dry-before-contact instruction is on the Talak/bifenthrin
        // label only — Taurus SC's manufacturer page states no drying or
        // re-entry direction, so the label attribution is scoped to the
        // contact product (Fable P1-2 on #5252).
        "Dry first. The contact product on the eaves and entry points ({{contact_product}}) needs to dry before people or pets are back on treated surfaces; that instruction is on the product label and your visit report. The band at your foundation ({{nonrepellent_product}}) is a soil application, not a surface spray, so this particular label rule is about the contact product.",
        // The label's watering/mowing hold is stated "for lawns" only — not
        // extended here to a blanket claim about the treated perimeter.
        'No rain in the forecast. The label asks for application when rain is not predicted for the next 24 hours, so wind or rain does not wash the product off the treated area. Your visit report may also ask you to hold irrigation for {{irrigation_hold_hours}} hours where the label calls for it on lawns.',
      ] },
      { type: 'heading', content: "When we reschedule for rain, and when we don't" },
      { type: 'paragraph', content: 'The label does not allow application during rain, and a forecast with no dry window defeats the purpose, so we move the visit rather than treat into a downpour. You get a text the morning of with the forecast chance and a link to pick the new time. If the day turns out dry after all, the next open slot is yours; reply to the text.' },
      { type: 'heading', content: 'Why palmetto bugs turn up after bad weather' },
      // Rewritten around the one supported source (American cockroaches
      // move indoors to avoid extreme weather, or to find food and water —
      // UF/IFAS). Dropped "floods colonies", "the lot line", "two days",
      // and every "ants" reference in this section — no source states any
      // of them.
      { type: 'paragraph', content: "American cockroaches — the ones you may know as palmetto bugs — move indoors to find food and water or to get away from extreme weather. This isn't the treatment failing; wipe up any trail you see, fix a leaky drip under the sink if there is one, and skip the store-bought spray indoors." },
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
    // "View my estimate" holds true for every recipient regardless of
    // isEstimateExtensionRequestEligible (estimate-public.js): the link
    // always goes to the estimate page, which either offers the extension
    // action or tells the reader how to reach the office. The CTA no
    // longer promises the extension action specifically (Fable P2-4 on
    // #5252).
    ctaLabel: 'View my estimate',
    ctaUrlVariable: 'estimate_link',
    subject: 'Still here if you need us, {{first_name}}',
    preview: 'Your {{service_quoted}} estimate is saved. One question.',
    blocks: [
      // The link is the SAME estimate page either way — an estimate expired
      // 3 days ago is never isEstimateCustomerViewable (estimate-public.js),
      // and isEstimateExtensionRequestEligible is conditional (false for a
      // plan_restart source, a fixed-bid quote, or one never sent/viewed).
      // An ineligible recipient's link resolves to the "isn't valid, call
      // us" screen instead of the extension action, so the copy below
      // promises only what holds for every recipient (Fable P2-4 on
      // #5252, refining the P1 fix from #5252's first push).
      { type: 'paragraph', content: "Your estimate for {{service_quoted}} at {{address_short}} reached its date on {{expired_date_short}}. Nothing has been booked. The link below takes you back to that estimate — if it's still eligible, you can ask for more time on the same numbers; if not, it'll tell you how to reach us." },
      { type: 'heading', content: 'One question: did the {{pest_or_problem_named}} get handled?' },
      { type: 'paragraph', content: 'If it did, reply "handled" and we will stop writing. If it didn\'t, reply with what you are seeing now and we will tell you straight whether the quote still fits.' },
      { type: 'details', variant: 'faq', rows: [{ label: 'What we are seeing near you', value: '{{area_intel_sentence}}' }] },
      { type: 'paragraph', content: '{{consultation_offer_block}}' },
      { type: 'cta', label: 'View my estimate', url_variable: 'estimate_link' },
      // "The estimate page carries them" was dropped — untrue for an
      // expired, ineligible estimate until/unless an extension is granted.
      { type: 'small_note', content: 'No prices in this email. If you would rather not hear from us about this, the link at the bottom stops these in one click.' },
      SOURCE_C1,
      SIGNATURE,
    ],
    fixtures: {
      full: {
        first_name: 'Jordan', service_quoted: 'quarterly pest control', address_short: 'Example Test Ln',
        expired_date_short: 'Sep 21', pest_or_problem_named: 'ghost ants',
        area_intel_sentence: 'In the last 60 days our technicians treated big-headed ants at 65% of our visits in Parrish.',
        consultation_offer_block: 'Not sure yet? For recurring plans we will come look first, free, and quote from what we find: https://portal.wavespestcontrol.com/inspection/sample-token',
        estimate_link: 'https://portal.wavespestcontrol.com/estimate/sample',
      },
      sparse: {
        first_name: 'Jordan', service_quoted: 'quarterly pest control', address_short: 'Example Test Ln',
        expired_date_short: 'Sep 21', pest_or_problem_named: 'ghost ants',
        area_intel_sentence: '', consultation_offer_block: '',
        estimate_link: 'https://portal.wavespestcontrol.com/estimate/sample',
      },
    },
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
    // nurture.expired_1 rides a marketing_* suppression stream but is
    // meant to read like a personal service touch, not a newsletter
    // broadcast. mode: 'service' alone does not get it that: sendTemplate's
    // modeOverride (email-template-library.js) forces mode 'marketing'
    // (and the newsletter wrapper) for any isMarketingSend template UNLESS
    // layout_wrapper_id === 'service_pinned_v1' — the exact mechanism
    // referral.invite already uses for this same combination (owner
    // directive 2026-07-06). The unsubscribe/ASM requirement itself is
    // unaffected either way — it keys off isMarketingSend
    // (suppression_group_key), never the wrapper. The footer's OWN wording
    // ("Unsubscribe from referral emails") was hardcoded for referral.invite
    // and is fixed at the library level (unsubscribeFooterLabelFor), not
    // here (Fable P1-1 on #5252).
    layout_wrapper_id: t.suppressionGroup === 'marketing_nurture' ? 'service_pinned_v1' : 'service_default_v1',
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
    // makes the seed unsendable.
    status: 'draft',
    updated_at: new Date(),
  };
}

// Insert-once, never update: the touchedByHuman() provenance guard this
// migration carried through its first four local-audit rounds assumed an
// admin edit always sets created_by / last_published_by / published_by, but
// the REAL edit routes (admin-email-templates.js PUT /:key and
// PUT /versions/:id) update content and updated_at without ever touching
// those fields — an ordinary in-place edit through the actual admin UI was
// therefore NOT proof against the guard and would still be silently
// reverted by a migration re-run (Fable P2-3 / Codex P2 :401 on #5252).
// Codex's accepted remedy: stop trying to detect an edit at all — insert
// once, and never touch a row that already exists, for templates, versions,
// AND fixtures alike. A later content change to any of them ships as a new
// migration (this file is frozen once pushed, same as its predecessor) or
// is made directly through the admin UI.
async function upsertTemplate(knex, t) {
  const existing = await knex('email_templates').where({ template_key: t.key }).first();
  let template = existing;

  if (!template) {
    const row = templateRow(t);
    [template] = await knex('email_templates').insert({ ...row, created_at: new Date() }).returning('*');
  }
  // else: already seeded (or since edited by an operator) — leave it alone.

  let version = await knex('email_template_versions')
    .where({ template_id: template.id })
    .first();
  if (!version) {
    const versionFields = {
      // Draft template rows never carry an 'active' version —
      // publishVersion is the only path that flips a version (and its
      // template) to active.
      status: 'draft',
      subject: t.subject,
      preview_text: t.preview || null,
      blocks: JSON.stringify(t.blocks || []),
      text_body: null,
      updated_at: new Date(),
    };
    [version] = await knex('email_template_versions').insert({
      template_id: template.id,
      version_number: 1,
      created_at: new Date(),
      ...versionFields,
    }).returning('*');
  }
  // else: already seeded (or since edited via createDraftVersion /
  // publishVersion, or a direct PUT /versions/:id) — leave its content
  // alone.

  if (await knex.schema.hasTable('email_template_fixtures')) {
    for (const [name, payload] of Object.entries(t.fixtures || {})) {
      const isDefault = name === 'full';
      const existingFixture = await knex('email_template_fixtures')
        .where({ template_id: template.id, name })
        .first();
      if (!existingFixture) {
        const fields = { name, payload: JSON.stringify(payload), is_default: isDefault, updated_at: new Date() };
        await knex('email_template_fixtures').insert({ template_id: template.id, created_at: new Date(), ...fields });
      }
    }
  }
}

exports.up = async function up(knex) {
  const hasTemplateTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions');
  if (hasTemplateTables) {
    for (const template of TEMPLATES) {
      await upsertTemplate(knex, template);
    }
  }
  // No email_template_automations rows are written by this migration — see
  // the header comment (Codex P2 :280 on #5252).
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
exports.__private = { TEMPLATES, templateRow };

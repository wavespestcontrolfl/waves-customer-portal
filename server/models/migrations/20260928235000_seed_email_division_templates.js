/**
 * Email division — first four templates. FOURTH re-cut in this lane (v5):
 * #5160/20260928080000, #5252/20260928220000, #5257/20260928230000 and
 * #5260/20260928233000 each pushed a seed migration that is frozen per
 * waves-db §4 the moment it is pushed. #5260 (feat/email-division-
 * templates-v4) came back clean from Codex round 1, but a parallel
 * correctness review found six P2 copy/contract defects in its seeded
 * content, and the owner ruled (2026-09-28) that no re-service timing
 * appears anywhere. Rather than a correction chain, this is a full re-cut
 * again: fresh branch, one new migration file (20260928235000, later than
 * every migration on main) with every finding folded in from the start —
 * a new file name also keeps it clear of any preview DB that ran the v4
 * file. #5260 stays open for the primary to close. Frozen the same way
 * once THIS file is pushed — see waves-db §4 before editing anything below.
 *
 * v5 fixes (parallel review of #5260 head 088ae248bc + owner ruling):
 *  1. nurture.expired_1 promised `reply "handled" and we will stop
 *     writing` — nothing in the code reads an email reply (replies land in
 *     the contact@ inbox). The promise is gone; the only exit offered is
 *     the footer unsubscribe link, described scope-neutrally ("stops our
 *     marketing emails").
 *  2. OWNER RULING 2026-09-28 (binding): no re-service timing anywhere. B1's
 *     "day 21" and B5's "weeks 4 to 12" are gone; both now say, in their
 *     own flow, "If you still see activity between visits, reply or text us
 *     a photo — a re-service between visits is free and doesn't move your
 *     next visit." B1's "What to expect" heading (an efficacy-timeline
 *     frame) is gone, and B5 no longer says "not a faster-working product"
 *     (a speed-of-action claim the manufacturer never makes).
 *  3. B1's static "The band at your foundation is a non-repellent: ants and
 *     roaches cannot detect it… carry it back to the colony" rendered for
 *     every visit whatever primary_product_name was (a bifenthrin visit got
 *     a false non-repellent claim) and called cockroaches colony insects.
 *     It is now the OPTIONAL `nonrepellent_band_note` section (a single-row
 *     faq details block, the same blank-drops mechanism every other optional
 *     section here uses): the sender sets it ONLY when the visit's primary
 *     product is Taurus SC, to the manufacturer's own statement (non-
 *     repellent; target pests cannot detect it and "touch, ingest and
 *     spread" it — Control Solutions Taurus SC product page), and leaves it
 *     blank otherwise. No colony claim. The template's own sentence around
 *     primary_product_family_phrase now takes the phrase after a colon, so
 *     a phrase carrying its own article ("a contact product…") never reads
 *     "a a …". B5's static mechanism sentence is reduced to the same
 *     manufacturer statement (no "track it back", no colony).
 *  4. The activity averages are averages of service_records.
 *     client_pest_rating per (service_line, visit_number), min 20 rated
 *     visits (#5164 visit-products.js getActivityRatingAverages). That
 *     rating is a 0 (none) to 5 (high) pest-activity rating recorded for a
 *     visit — by the technician at closeout, or by the customer on the
 *     report when the technician recorded none. The raw rating is never
 *     shown on a customer report (the report shows the composite "Pest
 *     pressure" score), so the copy names it as the pest activity rating
 *     our visit records carry, gives its real 0-5 scale, and does not
 *     claim it is on the customer's report (nor that every visit has one:
 *     the rating is captured only where the service line allows it). Still required variables: a
 *     sender without a cohort of at least 20 must skip the send.
 *  5. nurture.expired_1's free-text `consultation_offer_block` payload is
 *     gone (payload text is always escaped, so its URL could never be a
 *     link, was not short-wrapped and was not safeUrl-checked). It is now
 *     the repo's existing mechanism: an optional `consultation_url` rendered
 *     by a `cta` block with `variant: 'link'` directly after the primary
 *     CTA, with the same label the 20260926010000 chain gives
 *     estimate.engage_gone_quiet. A blank consultation_url drops the link.
 *  6. Seed mechanics: when a template_key row already existed, the v4 file
 *     still inserted a version and fixtures under it (two default fixtures
 *     were possible). Versions and fixtures are now inserted ONLY for a
 *     template this migration inserted.
 *  7. "Source:" lines no longer cite a figure an optional section carried
 *     after that section dropped: B1 and C1 have no static Source line (each
 *     optional sentence names its own source — see the wiring contract
 *     below), B6's static line cites only the label and UF/IFAS (the
 *     always-rendered claims), and B5's cites only what always renders.
 *
 * Wiring contract (the sender PR must honour this — nothing here sends):
 *  - lc.first_visit_pest: every required variable present. Optional
 *    sentences each name their own source in-line (fixtures show the
 *    shape): activity_rating_sentence (Waves visit records; skip the
 *    averages clause when the cohort is below 20), rain_since_visit_sentence
 *    (NOAA radar), pet_advisory_sentence (no fixed minute figure),
 *    nonrepellent_band_note (Taurus SC primary product only, manufacturer
 *    wording only), secondary_products_sentence.
 *  - lc.why_91_days: send only when the plan's non-repellent is Taurus SC
 *    (the product whose manufacturer statement the copy quotes) and both
 *    activity_avg_* come from a cohort of at least 20 rated visits on the
 *    plan's service line; otherwise skip the send. area_intel_sentence
 *    names Waves' own visits as its source.
 *  - lc.rain_and_treatment: send only when the contact product is Talak
 *    7.9% F (the label the rules are quoted from). rain_last_7_sentence
 *    names NOAA radar, forecast_sentence names the National Weather Service.
 *  - nurture.expired_1: consultation_url only from the existing consultation
 *    eligibility, channel 'email', short-wrapped by
 *    lead-consultation-email-block.js's shortWrap, and only when the
 *    recipient is the lead's own inbox; otherwise blank.
 *
 * Codex round 1 on #5257 (head 36923a58a7), fixed here:
 *  - :216 lc.why_91_days' preview promised "how long each one holds"
 *    while the body carries no duration and disclaims one. The preview now
 *    promises what the body delivers: what each product does and the
 *    visit-record evidence behind the cadence.
 *  - :280 lc.rain_and_treatment told customers to expect a morning text
 *    with a link to PICK a new time. The real flow (server/services/
 *    rain-out.js, started by the technician or the office when weather
 *    stops a visit) moves the visit and books the new time FIRST, then
 *    texts the new time with a link to choose a different one — or, when
 *    no link can be built, asks the customer to reply. The text is skipped
 *    entirely when there is no phone on file or its template is off, and
 *    storm-watch.js never texts customers. The section now says we move and
 *    book it, nothing is needed from the customer, the text carries a link
 *    or a reply option, and a missing text is answered by replying to the
 *    email. No time of day is promised.
 *  - :232 the literal 2.9 / 1.1 activity-rating averages were frozen text
 *    in an insert-once template. They are now REQUIRED payload variables
 *    (activity_avg_first_visit / activity_avg_second_visit) the sender
 *    fills from Waves' own completed-visit records at send time; no
 *    reader for them exists on main yet, so this file names none, and
 *    required means a sender without the figures cannot send (the render
 *    refuses) rather than print a blank or stale number. The Source
 *    footers no longer say "computed nightly" either: nothing on main
 *    computes these figures on any schedule. Fixtures carry synthetic
 *    sample values, not real averages.
 *  - email-template-library.js:765 the service-chrome unsubscribe footer
 *    named one stream ("these follow-ups" / "referral emails") but
 *    asmGroupIdFor() maps EVERY marketing_* stream to the one newsletter
 *    ASM group, so the click unsubscribes from all of them. The footer now
 *    says "Waves marketing emails" for any marketing stream. The per-stream
 *    label map from #5257 is gone; this is a one-line change to the
 *    footer that main already had. nurture.expired_1's own small note
 *    said the link "stops these" — same understatement — and now says it
 *    stops our marketing emails.
 *  - :428 no audit provenance for the newly seeded admin-editable
 *    templates: one critical email_template.seeded audit_log event per
 *    template actually INSERTED (none on a re-run that finds the row),
 *    recorded through recordAuditEvent on the migration's own knex
 *    (trx: knex, critical: true) exactly like
 *    20260926000100_billing_receipt_notice_email_template.js.
 *
 * Content re-read against sources for this re-cut (content rules: a
 * product statement quotes the label or manufacturer, or is Waves' own
 * data, or is not said): B1 no longer says the non-repellent "works
 * through the colony rather than killing on contact" (the manufacturer
 * says pests "touch, ingest and spread" it — nothing about contact kill);
 * B6 no longer calls the foundation band "a soil application, not a
 * surface spray" (no source), no longer tells the reader palmetto bugs
 * after a storm are "not the treatment failing" or to "wipe up any
 * trail" (the UF source says only why American cockroaches come indoors);
 * B1's preview no longer promises a "day-by-day" the body does not carry,
 * and its subject drops "today". Fixture area-intel sentences now use the
 * one-month, one-city shape the planned area-intel sentence has, without
 * the unsupported "busiest ant month of the year".
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
 * to avoid extreme weather (UF/IFAS); Waves' own activity-rating averages
 * and area-intel sentences, both from Waves' completed-visit records and
 * both supplied by the sender at send time (no reader for either is on
 * main yet — see the #5257 notes above).
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
 * The unsubscribe-footer wording fix (Fable P1-1 on #5252, then Codex
 * :765 on #5257 — the service-chrome footer was hardcoded to "referral
 * emails") is a LIBRARY change, not a migration one: see renderTemplate's
 * unsubScope in email-template-library.js.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const GUIDES_B1 = { type: 'small_note', content: 'Guides: Ghost ants in Florida kitchens · Do pest control sprays harm pets · What every visit covers' };
// No static Source line for B1 (v5 item 7): every sourced figure in this
// template (activity averages, radar rain, the non-repellent statement, the
// UF/IFAS weather note) lives in an OPTIONAL sentence that names its own
// source in-line and drops with its section, so a static footer citing
// them would outlive them on a sparse send.
const GUIDES_B5 = { type: 'small_note', content: 'Guides: What every visit covers · Ghost ants in Florida kitchens' };
// Cites only what always renders in B5 (v5 item 7): the required
// activity averages and the static manufacturer sentence. No year and no
// "computed nightly" (the insert-once row is never auto-updated).
const SOURCE_B5 = { type: 'small_note', content: 'Source: pest activity ratings are Waves visit records; non-repellent behavior from the Taurus SC manufacturer.' };
const GUIDES_B6 = { type: 'small_note', content: 'Guides: Palmetto bugs after rain' };
// Cites only the always-rendered claims (v5 item 7): the label rules and
// the UF/IFAS palmetto-bug paragraph. The optional radar-rain and forecast
// sentences name NOAA / the National Weather Service themselves.
const SOURCE_B6 = { type: 'small_note', content: 'Source: application rules from the Talak 7.9% F label; indoor movement during weather from University of Florida IFAS.' };
// No static Source line for C1 (v5 item 7): the only sourced figure is the
// optional area-intel sentence, which names Waves' own visits itself.
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
    optional: ['secondary_products_sentence', 'nonrepellent_band_note', 'activity_rating_sentence', 'rain_since_visit_sentence', 'pet_advisory_sentence'],
    // No "day-by-day" (the body has no per-day timeline) and no "today"
    // (re-cut v4 content read). v5: no "what the treatment is doing" /
    // "how the foundation band works" either — the product explanation is
    // an optional section now (item 3), so neither line may promise it.
    subject: 'What we did at your first visit, {{first_name}}',
    preview: "What we did on {{visit_date_short}}'s visit, what we recorded, and how to reach us between visits.",
    blocks: [
      { type: 'heading', content: 'What we did on {{visit_date_long}}' },
      // v5: the phrase follows a colon so a sender phrase that carries its
      // own article ("a contact product that…") never renders "a a …".
      { type: 'paragraph', content: '{{tech_first_name}} treated {{areas_treated_list}}. The main product was {{primary_product_name}} ({{primary_active_ingredient}}): {{primary_product_family_phrase}}.' },
      { type: 'paragraph', content: '{{secondary_products_sentence}}' },
      { type: 'paragraph', content: 'The pests recorded at your home: {{pests_named_list}}.' },
      // v5 item 3: the non-repellent statement is OPTIONAL and product-
      // bound. The sender sets nonrepellent_band_note ONLY when the visit's
      // primary product is Taurus SC, to the manufacturer's own words
      // (non-repellent; target pests cannot detect it and "touch, ingest
      // and spread" it — Control Solutions product page), and leaves it
      // blank for any other product, so a bifenthrin visit never renders a
      // non-repellent claim. No colony claim (cockroaches are not colony
      // insects). The v4 "What to expect" heading is gone with it (an
      // efficacy-timeline frame, and an orphan heading on a sparse send).
      { type: 'details', variant: 'faq', rows: [{ label: 'About {{primary_product_name}}', value: '{{nonrepellent_band_note}}' }] },
      // v5 item 4: named for what it is — the 0-5 pest activity rating
      // recorded for a visit (service_records.client_pest_rating).
      { type: 'details', variant: 'faq', rows: [{ label: 'Pest activity rating', value: '{{activity_rating_sentence}}' }] },
      { type: 'details', variant: 'faq', rows: [{ label: 'Rain since the visit', value: '{{rain_since_visit_sentence}}' }] },
      { type: 'details', variant: 'faq', rows: [{ label: 'Pets and re-entry', value: '{{pet_advisory_sentence}}' }] },
      // OWNER RULING 2026-09-28: no re-service timing anywhere (no "day
      // 21"); the owner's sentence, verbatim.
      { type: 'heading', content: 'Between visits' },
      { type: 'paragraph', content: "If you still see activity between visits, reply or text us a photo — a re-service between visits is free and doesn't move your next visit. Your next visit is scheduled for about {{next_visit_date}}." },
      GUIDES_B1,
      SIGNATURE,
    ],
    fixtures: {
      full: {
        first_name: 'Jordan', visit_date_short: 'Sep 24', visit_date_long: 'September 24, 2026',
        tech_first_name: 'Marco', areas_treated_list: 'the foundation perimeter, garage entry, and lanai',
        primary_product_name: 'Taurus SC', primary_active_ingredient: 'fipronil',
        primary_product_family_phrase: 'a non-repellent insecticide',
        // Manufacturer wording only (Control Solutions, Taurus SC product
        // page), attributed in-line; no colony claim (v5 item 3).
        nonrepellent_band_note: 'Its manufacturer describes Taurus SC as a non-repellent insecticide that target pests cannot detect, so they touch, ingest and spread it.',
        secondary_products_sentence: 'We also applied a contact product along the eaves and entry points.',
        pests_named_list: 'ghost ants and Cuban brown roaches',
        // Synthetic sample figures (Codex :232 on #5257) — never real
        // averages. v5 item 4: names the metric and its real 0-5 scale and
        // its source (Waves visit records) in-line.
        activity_rating_sentence: 'The pest activity rating recorded at this visit was 3, on a scale from 0 (none) to 5 (high). Across Waves visit records, that rating averages 3.1 at a first visit and 1.2 at the second.',
        // Rewritten per the fact register (Fable P1-2 on #5252): no "ants",
        // no duration ("for a few days") — American cockroaches moving
        // indoors during extreme weather is the one supported claim here.
        // No "not a failed treatment": the UF source says why American
        // cockroaches come indoors, nothing about whether a treatment worked.
        // v5 item 7: each source named in-line (NOAA radar, UF/IFAS).
        rain_since_visit_sentence: 'NOAA radar shows about 0.8 inches of rain near your address since the visit; local totals may vary. We plan visits around forecast rain to protect the products we use. University of Florida IFAS notes that American cockroaches — sometimes called palmetto bugs — move indoors to avoid extreme weather.',
        // AGENTS.md compliance rule: never a fixed re-entry/drying minute
        // figure — "safe once dry" + technician confirms timing.
        pet_advisory_sentence: "Keep pets and kids off the treated foundation line and interior baseboards until they're dry — the technician confirmed the exact timing on your visit report.",
        next_visit_date: 'December 24, 2026',
      },
      sparse: {
        first_name: 'Jordan', visit_date_short: 'Sep 24', visit_date_long: 'September 24, 2026',
        tech_first_name: 'Marco', areas_treated_list: 'the foundation perimeter and garage entry',
        // A contact-product visit (v5 item 3): nonrepellent_band_note is
        // blank, so no non-repellent statement renders.
        primary_product_name: 'Talak 7.9% F', primary_active_ingredient: 'bifenthrin',
        primary_product_family_phrase: 'a contact product',
        secondary_products_sentence: '', pests_named_list: 'ghost ants',
        nonrepellent_band_note: '',
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
    // activity_avg_first_visit / activity_avg_second_visit are required
    // (Codex :232 on #5257): the "So why N days" paragraph reads them as
    // payload variables, not frozen text, so a sender without current
    // figures cannot send this email (renderTemplate reports them missing
    // and sendTemplate refuses) instead of printing a blank or stale number.
    required: [
      'first_name', 'plan_interval_days', 'plan_name', 'nonrepellent_product', 'contact_product',
      'activity_avg_first_visit', 'activity_avg_second_visit',
    ],
    optional: ['area_intel_sentence'],
    subject: 'Why we come back every {{plan_interval_days}} days, {{first_name}}',
    // Not "how long each one holds" (Codex :216 on #5257) — the body
    // carries no duration and disclaims one; the preview promises what the
    // email delivers: what each product does and the visit-record evidence
    // behind the cadence.
    preview: 'The two products on your plan, what each one does, and what our visit records show about this schedule.',
    blocks: [
      { type: 'heading', content: 'Two products, two jobs' },
      // Rewritten per the fact register: kept the touch/ingest/spread
      // mechanism (Taurus SC manufacturer); dropped "keeps working after
      // the ants you can see are gone" (a visibility-duration claim the
      // register forbids attributing to the manufacturer) and "spiders and
      // wasps... it wears with sun, rain and time" (no target-pest or
      // residual-duration claim in the bifenthrin/Talak label).
      // v5 item 3: the mechanism sentence is the manufacturer's own
      // statement (target pests cannot detect it; they touch, ingest and
      // spread it) — no "track it back", no colony. The wiring contract
      // limits this template to plans whose non-repellent is Taurus SC.
      { type: 'paragraph', content: "Your {{plan_name}} uses a non-repellent band ({{nonrepellent_product}}) and a contact product ({{contact_product}}). Its manufacturer describes the non-repellent as undetectable to target pests, so they touch, ingest and spread it. The contact product goes on the surfaces where pests travel: eaves, entry points, the lanai." },
      { type: 'heading', content: 'So why {{plan_interval_days}} days' },
      // Rewritten: the "surfaces weather" / "new colonies move in from the
      // lot line" / "renews the surface product sooner" claims had no
      // source — the cadence case now rests only on Waves' own
      // activity-rating data (SOURCE_B5), stated as evidence for the
      // cadence rather than a claim about how long a product lasts. The
      // averages themselves are payload variables, not frozen literals
      // (Codex :232 on #5257) — see the required-variables comment above.
      // v5 item 4: names the metric the #5164 reader averages
      // (service_records.client_pest_rating, 0-5, recorded per visit) and
      // its real scale; never claims it is on the customer's report (the
      // raw rating is not shown there). v5 item 2: "not a faster-working
      // product" dropped (a speed-of-action claim no source makes).
      { type: 'paragraph', content: 'Our own visit records are the evidence, not a claim about how long any single product lasts. Our visit records carry a pest activity rating, from 0 (none) to 5 (high). Across those records, it averages {{activity_avg_first_visit}} at a first visit and {{activity_avg_second_visit}} at the second. That is the pattern this schedule is built around.' },
      { type: 'heading', content: 'Between visits' },
      // OWNER RULING 2026-09-28: no re-service timing (no "weeks 4 to
      // 12"); the owner's sentence, verbatim.
      { type: 'paragraph', content: "If you still see activity between visits, reply or text us a photo — a re-service between visits is free and doesn't move your next visit." },
      { type: 'details', variant: 'faq', rows: [{ label: 'This month near you', value: '{{area_intel_sentence}}' }] },
      GUIDES_B5,
      SOURCE_B5,
      SIGNATURE,
    ],
    fixtures: {
      full: {
        first_name: 'Jordan', plan_interval_days: '91', plan_name: 'Quarterly Pest Plan',
        nonrepellent_product: 'Taurus SC', contact_product: 'a bifenthrin contact spray',
        // Synthetic sample figures, not real averages (Codex :232 on
        // #5257) — deliberately different from the 2.9 / 1.1 this template
        // used to carry as frozen text.
        activity_avg_first_visit: '3.1', activity_avg_second_visit: '1.2',
        // Month + city shape, no "busiest ant month of the year" (no source).
        area_intel_sentence: 'In September our technicians treated ghost ants at 61% of our 90 visits in Parrish.',
      },
      sparse: {
        first_name: 'Jordan', plan_interval_days: '91', plan_name: 'Quarterly Pest Plan',
        nonrepellent_product: 'Taurus SC', contact_product: 'a bifenthrin contact spray',
        // Required variables stay non-blank even in the sparse fixture —
        // only the optional area_intel_sentence drops.
        activity_avg_first_visit: '3.1', activity_avg_second_visit: '1.2',
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
    // nonrepellent_product left the body with the unsourced "soil
    // application" sentence below, so it is no longer a variable here.
    required: ['first_name', 'contact_product', 'irrigation_hold_hours'],
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
        // "The band ... is a soil application, not a surface spray" was
        // dropped in the v4 re-cut: no source states it.
        'Dry first. The contact product on the eaves and entry points ({{contact_product}}) needs to dry before people or pets are back on treated surfaces; that instruction is on its label and your visit report.',
        // The label's watering/mowing hold is stated "for lawns" only — not
        // extended here to a blanket claim about the treated perimeter.
        // Label: rain not predicted for 24 hours "will help to ensure that
        // wind or rain does not blow or wash pesticide off the treatment
        // area" — "helps", not a guarantee.
        'No rain in the forecast. The label asks for application when rain is not predicted for the next 24 hours, to help keep wind or rain from washing the product off the treated area. Your visit report may also ask you to hold irrigation for {{irrigation_hold_hours}} hours where the label calls for it on lawns.',
      ] },
      { type: 'heading', content: 'When rain moves your visit' },
      // Rewritten (Codex :280 on #5257) around rain-out.js: the technician
      // or the office moves the visit and books the new time FIRST
      // (SmartRebooker.reschedule — "the appointment NEVER goes unbooked"),
      // then sendMovedSms texts the new time with the /reschedule link, or
      // "reply to this message" when no link can be built. That text is
      // skipped with no phone on file or its template off, and
      // storm-watch.js never texts customers — hence the email-reply
      // fallback. No time of day is promised: rain-out.js runs whenever the
      // weather hits.
      { type: 'paragraph', content: "The label does not allow application during rain, so when rain stops us from treating, we move your visit ourselves and book the new time — there's nothing you need to do. We then text you the new date and time, usually with a link to choose a different time if that one doesn't suit you; you can also just reply to the text. If your visit was moved and you didn't get a text, reply to this email and we'll confirm your new time." },
      { type: 'heading', content: 'Why palmetto bugs turn up after bad weather' },
      // Rewritten around the one supported source (American cockroaches
      // move indoors to avoid extreme weather, or to find food and water —
      // UF/IFAS). Dropped "floods colonies", "the lot line", "two days",
      // and every "ants" reference in this section — no source states any
      // of them.
      // v4 re-cut: dropped "This isn't the treatment failing" (the source
      // says nothing about treatment results) and "wipe up any trail" (an
      // ant behavior, not a cockroach one).
      { type: 'paragraph', content: "American cockroaches — the ones you may know as palmetto bugs — move indoors to find food and water or to get away from extreme weather. Fix any leaky drip under the sink, since that is a water source, and skip the store-bought spray indoors. If you keep seeing them, reply to this email or text us a photo." },
      { type: 'details', variant: 'faq', rows: [{ label: 'At your address this week', value: '{{rain_last_7_sentence}}' }] },
      { type: 'details', variant: 'faq', rows: [{ label: 'Looking ahead', value: '{{forecast_sentence}}' }] },
      GUIDES_B6,
      SOURCE_B6,
      SIGNATURE,
    ],
    fixtures: {
      full: {
        first_name: 'Jordan', contact_product: 'a bifenthrin contact spray',
        irrigation_hold_hours: '24',
        // v5 item 7: sources named in-line (the static footer no longer
        // cites them).
        rain_last_7_sentence: 'NOAA radar shows about 0.8 inches of rain near your address in the last 7 days; local totals may vary.',
        forecast_sentence: 'The National Weather Service forecast shows no rain for the next 3 days.',
      },
      sparse: {
        first_name: 'Jordan', contact_product: 'a bifenthrin contact spray',
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
    // v5 item 5: consultation_url (a real link, via a cta variant:'link'
    // block) replaces the free-text consultation_offer_block payload.
    optional: ['area_intel_sentence', 'consultation_url'],
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
      // v5 item 1: no `reply "handled" and we will stop writing` — nothing
      // in the code reads an email reply. The only exit offered is the
      // footer unsubscribe link (small note below).
      { type: 'paragraph', content: "If it didn't, reply with what you are seeing now and we will tell you straight whether the quote still fits. If it did, there is nothing you need to do." },
      { type: 'details', variant: 'faq', rows: [{ label: 'What we are seeing near you', value: '{{area_intel_sentence}}' }] },
      { type: 'cta', label: 'View my estimate', url_variable: 'estimate_link' },
      // v5 item 5: the existing consultation-link mechanism (20260926010000
      // chain, same label), directly after the primary CTA. The library
      // renders it through safeUrl as a real anchor and drops it when
      // consultation_url is blank; the sender short-wraps it.
      { type: 'cta', variant: 'link', label: 'Rather have us come look first? Pick a time for a free consultation →', url_variable: 'consultation_url' },
      // "The estimate page carries them" was dropped — untrue for an
      // expired, ineligible estimate until/unless an extension is granted.
      // Not "stops these": the footer link unsubscribes from every Waves
      // marketing email (one shared ASM group — Codex :765 on #5257).
      { type: 'small_note', content: 'No prices in this email. If you would rather not hear from us, the unsubscribe link at the bottom stops our marketing emails.' },
      SIGNATURE,
    ],
    fixtures: {
      full: {
        first_name: 'Jordan', service_quoted: 'quarterly pest control', address_short: 'Example Test Ln',
        expired_date_short: 'Sep 21', pest_or_problem_named: 'ghost ants',
        area_intel_sentence: 'In September our technicians treated big-headed ants at 65% of our 40 visits in Parrish.',
        consultation_url: 'https://portal.wavespestcontrol.com/inspection/sample-token',
        estimate_link: 'https://portal.wavespestcontrol.com/estimate/sample',
      },
      sparse: {
        first_name: 'Jordan', service_quoted: 'quarterly pest control', address_short: 'Example Test Ln',
        expired_date_short: 'Sep 21', pest_or_problem_named: 'ghost ants',
        area_intel_sentence: '', consultation_url: '',
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
    // and is fixed at the library level (renderTemplate's unsubScope: one
    // scope-neutral label for every marketing_* stream, since they share
    // one ASM group), not here (Fable P1-1 on #5252, Codex :765 on #5257).
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
  // Already seeded (or since created/edited by an operator) — leave the
  // template AND everything under it alone. v5 item 6: the v4 file skipped
  // only the template insert and audit event here, then still inserted a
  // version and fixtures under the existing row (a second default fixture
  // was possible). Versions and fixtures are seeded ONLY for a template
  // this migration inserted.
  if (existing) return;

  const [template] = await knex('email_templates').insert({ ...templateRow(t), created_at: new Date() }).returning('*');

  // Row-level creation provenance for this admin-editable template (Codex
  // :428 on #5257) — one critical event per template actually INSERTED,
  // never on a re-run that found the row already there, same shape as
  // 20260926000100_billing_receipt_notice_email_template.js's own
  // recordAuditEvent call on the migration's own knex.
  if (await knex.schema.hasTable('audit_log')) {
    await require('../../services/audit-log').recordAuditEvent({
      actor_type: 'system',
      action: 'email_template.seeded',
      resource_type: 'email_template',
      resource_id: template.id,
      metadata: { templateKey: t.key, migration: '20260928235000_seed_email_division_templates' },
      trx: knex,
      critical: true,
    });
  }

  // Draft template rows never carry an 'active' version — publishVersion is
  // the only path that flips a version (and its template) to active.
  await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: 1,
    status: 'draft',
    subject: t.subject,
    preview_text: t.preview || null,
    blocks: JSON.stringify(t.blocks || []),
    text_body: null,
    created_at: new Date(),
    updated_at: new Date(),
  });

  if (await knex.schema.hasTable('email_template_fixtures')) {
    for (const [name, payload] of Object.entries(t.fixtures || {})) {
      await knex('email_template_fixtures').insert({
        template_id: template.id,
        name,
        payload: JSON.stringify(payload),
        is_default: name === 'full',
        created_at: new Date(),
        updated_at: new Date(),
      });
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

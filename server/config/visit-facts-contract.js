/**
 * Visit facts contract — Step 1 of the owner's plan to sync the tech's
 * Complete Service form with the customer service report (owner rulings
 * 2026-09-28, see docs/design/DECISIONS.md "Visit facts contract").
 *
 * This is a REGISTRY, not a behavior change. It pins, per service line: which
 * facts a completed visit records, who/what captures each one (tech tap /
 * voice fill / protocol prefill / derived / photo), where it is stored,
 * which file(s) write it, which report section reads it (when a section
 * exists), and what the customer report shows when the fact is missing.
 * Later PRs (voice fill, the merged Recommendations list, the dark report
 * sections) write and read these SAME facts — this file is the thing they
 * must keep in sync with.
 *
 * Companion doc: docs/design/visit-facts-contract.md (per-line tables, "how
 * to add a fact", and the "Known gaps" list every `status: 'gap'` fact here
 * must be named in).
 *
 * Enforcement: server/tests/visit-facts-contract.test.js — static, no DB —
 * checks registry shape, that every writer/reader path exists on disk, that
 * a fact's storage key string actually appears in a writer and in each
 * reader file (so a rename/removal fails CI instead of silently going
 * stale), that every `status: 'gap'` fact is listed in the doc's Known gaps
 * section, and that no voice-fill line carries an undeclared tap-only fact.
 *
 * Sibling pattern: server/config/completion-lane-registry.js (routing
 * decisions — which catalog key completes through which form) +
 * server/tests/completion-lane-coverage-contract.test.js. This registry pins
 * FACTS, not lane routing, and does not replace that registry: `catalogKeys`
 * below is a cross-reference only.
 *
 * Scope note (owner ruling 2026-09-28): WDO inspection (`wdo_inspection`) and
 * termite slab pre-treat (`termite_slab_pretreat` / typed pointer
 * `pre_treatment_termite_certificate`) are OUT of scope — they stay on the
 * compliance Projects flow (FDACS-13645 / FBC certificate machinery), never
 * a customer Service Report. See EXCLUDED_SERVICE_LINES below.
 *
 * Existing, narrower contract this file does NOT duplicate:
 * docs/design/specialty-service-completion-contract.md owns the typed
 * PROJECT_TYPES forms' tiers, required fields, zero options and copy
 * templates. The typed lines below list only the fields a report section
 * reads by name; every other non-internal typed field still renders through
 * the generic typed findings list (activity-indicators.js
 * buildTypedReportSnapshot), per that doc.
 */

'use strict';

/**
 * @typedef {'tap'|'voice'|'prefill'|'derived'|'photo'} FactCapture
 * - tap: the technician types or selects the value on the Complete Service
 *   form (SchedulePage.jsx CompletionPanel) or Fast Complete sheet.
 * - voice: voice fill writes the value (owner ruling 2026-09-27: voice fill
 *   covers every completion except WDO + pre-treat; 2026-09-28: "Found" and
 *   "Treated" are read-only summary lines filled from voice). Voice fill is
 *   a follow-up PR — no fact is voice-written TODAY; 'voice' marks the fact
 *   voice fill must write into (the tap path stays behind "Show all fields").
 * - prefill: defaulted from the protocol / product label / service config;
 *   the tech confirms or adjusts rather than starting from blank.
 * - derived: computed by the server from other recorded facts or photos
 *   (never itself a form field).
 * - photo: an uploaded image (optionally captioned).
 *
 * @typedef {'hidden'|'fallback'|'filler'|'required'} WhenMissing
 * - hidden: the report section (or line) that would show this fact does not
 *   render when it is absent.
 * - fallback: the report substitutes a less specific source or a default.
 * - filler: the report renders fixed zero-state template copy.
 * - required: Complete Service refuses to submit without it.
 *
 * @typedef {Object} VisitFactReader
 * @property {string} file - repo-relative path, verified to exist on disk.
 * @property {string} section - the report section/behavior this reader
 *   produces from the fact (human label, not a file path).
 * @property {string} [readerSymbol] - identifier that appears in `file` when
 *   the reader consumes the fact generically (e.g. by iterating every typed
 *   field) instead of naming the storage key. The contract test accepts the
 *   storage key OR this symbol.
 *
 * @typedef {Object} VisitFact
 * @property {string} key - unique within its service line's `facts` array.
 * @property {string} label - human name (used in the doc tables).
 * @property {FactCapture[]} capture - every way the fact gets filled.
 * @property {string|null} storage - '<table>.<column>' or a dotted JSON path
 *   ('structured_notes.<key>', 'service_data.<snapshot>.values.<key>'); the
 *   LAST dotted segment is the key the contract test searches for. null only
 *   for a `status: 'gap'` fact that has no storage yet.
 * @property {string[]} writers - repo-relative paths, verified to exist
 *   (the server writer plus the client surface that submits the value).
 * @property {VisitFactReader[]} readers - empty array = no report section
 *   reads this fact yet (must pair with `status: 'gap'`).
 * @property {WhenMissing} whenMissing
 * @property {string} [notes]
 * @property {'gap'} [status] - the fact is needed but no report section
 *   reads it (or nothing records it); MUST have `readers: []` and MUST be
 *   named in docs/design/visit-facts-contract.md's "Known gaps" section.
 * @property {boolean} [tapOnly] - true when a fact on a voice-fill line is
 *   deliberately tap-only (capture exactly ['tap']); requires `reason`.
 * @property {string} [reason] - required when `tapOnly` is true.
 *
 * @typedef {Object} ServiceLineFacts
 * @property {string} label
 * @property {string[]} catalogKeys - representative `services.service_key`
 *   values completing through this line's form (cross-reference to
 *   completion-lane-registry.js, not a second routing source of truth).
 * @property {boolean} voiceFill - voice fill applies to this line (owner
 *   ruling 2026-09-27: every in-scope line).
 * @property {VisitFact[]} facts
 */

// ---------------------------------------------------------------------------
// Verified file paths (writers / readers). Centralized so a rename touches
// one line; the contract test independently re-verifies every one exists.
// ---------------------------------------------------------------------------

const COMPLETE_SERVICE = 'server/services/complete-scheduled-service.js';
const SCHEDULE_PAGE = 'client/src/pages/admin/SchedulePage.jsx'; // full Complete Service form (CompletionPanel)
const FAST_COMPLETE_SHEET = 'client/src/components/tech/FastCompleteSheet.jsx';
const SERVICE_PHOTOS = 'server/services/service-photos.js';
const TURF_HEIGHT_SERVICE = 'server/services/turf-height-service.js';
const LAWN_ASSESSMENT_ROUTE = 'server/routes/admin-lawn-assessment.js';
const TREE_SHRUB_ASSESSMENT = 'server/services/tree-shrub-assessment.js';
const PROJECT_TYPES = 'server/services/project-types.js';
const TIP_LIBRARY = 'server/services/service-report/tip-library.js';
const SERVICE_COMPLETION_CHOICES = 'client/src/lib/service-completion-choices.js';

const REPORT_DATA = 'server/services/service-report/report-data.js';
const REPORT_VIEW_PAGE = 'client/src/pages/ReportViewPage.jsx';
const PREMIUM_EXPERIENCE = 'server/services/service-report/premium-experience.js';
const ACTIVITY_INDICATORS = 'server/services/service-report/activity-indicators.js';
const CROSS_SELL = 'server/services/service-report/cross-sell.js';
const RESERVICE_REPORT = 'server/services/service-report/reservice-report.js';
const LAWN_REPORT_V2 = 'server/services/service-report/lawn-report-v2.js';
const MOSQUITO_REPORT_V2 = 'server/services/service-report/mosquito-report-v2.js';
const TREE_SHRUB_REPORT_V2 = 'server/services/service-report/tree-shrub-report-v2.js';
const COCKROACH_REPORT_V2 = 'server/services/service-report/cockroach-report-v2.js';
const TERMITE_REPORT_V2 = 'server/services/service-report/termite-report-v2.js';
const RODENT_REPORT_NARRATIVE = 'server/services/service-report/rodent-report-narrative.js';

/** Every non-internal typed field renders here (generic typed findings list). */
const TYPED_FINDINGS_LIST = Object.freeze({
  file: ACTIVITY_INDICATORS,
  section: 'Typed findings list (every non-internal findingsFields key)',
  readerSymbol: 'buildTypedReportSnapshot',
});

// ---------------------------------------------------------------------------
// Shared fact builders — reused across lines so a shared wiring change
// (e.g. a new service_products column) is edited in one place.
// ---------------------------------------------------------------------------

/**
 * Per-product facts every product row carries (complete-scheduled-service.js
 * service_products insert ~7000-7022; report-data.js ~3784-3789 and
 * premium-experience.js read them back for every line). These are also the
 * facts the dark pest "what to expect" section needs: method + area +
 * targets per product.
 * @returns {VisitFact[]}
 */
function productFacts() {
  return [
    {
      key: 'product_application_method',
      label: 'Product application method',
      capture: ['prefill', 'voice', 'tap'],
      storage: 'service_products.application_method',
      writers: [COMPLETE_SERVICE, SCHEDULE_PAGE, FAST_COMPLETE_SHEET],
      readers: [
        { file: REPORT_DATA, section: 'What we did / products applied' },
        { file: PREMIUM_EXPERIENCE, section: 'Property defense status / primary move' },
      ],
      whenMissing: 'hidden',
      notes: 'Fast Complete derives each row\'s method from the visit-level method picker (rowMethod) unless the tech overrides it per row.',
    },
    {
      key: 'product_targets',
      label: 'Product targets (pests / turf issues the product was aimed at)',
      capture: ['prefill', 'voice', 'tap'],
      storage: 'service_products.targets',
      writers: [COMPLETE_SERVICE, SCHEDULE_PAGE, FAST_COMPLETE_SHEET],
      readers: [
        { file: REPORT_DATA, section: 'What we did / products applied' },
        { file: PREMIUM_EXPERIENCE, section: 'Bug files / pressure receipt' },
        { file: LAWN_REPORT_V2, section: 'Treatment card (lawn)' },
        { file: TREE_SHRUB_REPORT_V2, section: 'Treatment card (tree & shrub)' },
      ],
      whenMissing: 'hidden',
      notes: 'On the full form targets are prefilled from the product label list — they describe the product mix, NOT pests found. Fast Complete writes the tech\'s picked pests into every row\'s targets.',
    },
    {
      key: 'product_application_area',
      label: 'Product application area (where it went)',
      capture: ['voice', 'tap'],
      storage: 'service_products.application_area',
      writers: [COMPLETE_SERVICE, SCHEDULE_PAGE, FAST_COMPLETE_SHEET],
      readers: [
        { file: REPORT_DATA, section: 'What we did / products applied' },
        { file: PREMIUM_EXPERIENCE, section: 'Property defense status (treated areas)' },
      ],
      whenMissing: 'hidden',
      notes: 'Prod, last 30 days: 100 of 240 pest product rows have no area (owner audit 2026-09-28) — see Known gaps (data quality).',
    },
    {
      key: 'product_area_value',
      label: 'Product measured area (value; unit in service_products.area_unit)',
      capture: ['voice', 'tap'],
      storage: 'service_products.area_value',
      writers: [COMPLETE_SERVICE, SCHEDULE_PAGE, FAST_COMPLETE_SHEET],
      readers: [{ file: REPORT_DATA, section: 'What we did / products applied' }],
      whenMissing: 'hidden',
      notes: 'Required (blocks submit) for perimeter_spray (linear ft) and for methods whose report application needs square feet — see the linear_ft / sqft checks in complete-scheduled-service.js.',
    },
    {
      key: 'product_total_amount',
      label: 'Product total amount applied (unit in service_products.amount_unit)',
      capture: ['prefill', 'voice', 'tap'],
      storage: 'service_products.total_amount',
      writers: [COMPLETE_SERVICE, SCHEDULE_PAGE, FAST_COMPLETE_SHEET],
      readers: [{ file: REPORT_DATA, section: 'What we did / products applied' }],
      whenMissing: 'hidden',
      notes: 'Per-product standard amounts are deferred ("protocols later", owner 2026-09-28); voice fill must never guess an amount.',
    },
  ];
}

/**
 * The structured facts the basic (untyped) Complete Service form records —
 * recurring pest, one-time pest, pest re-service, recurring lawn, mosquito,
 * termite-bait primary and palm. All land in service_records.structured_notes
 * (the object built ~5755 in complete-scheduled-service.js) except
 * technician_notes, a service_records column.
 * @param {{ extraReaders?: Record<string, VisitFactReader[]> }} [opts]
 * @returns {VisitFact[]}
 */
function genericCompletionFacts(opts = {}) {
  const extra = opts.extraReaders || {};
  const withExtra = (key, base) => base.concat(extra[key] || []);
  return [
    {
      key: 'areas_treated',
      label: 'Areas treated ("Treated" summary line)',
      capture: ['voice', 'tap'],
      storage: 'structured_notes.areasTreated',
      writers: [COMPLETE_SERVICE, SCHEDULE_PAGE],
      readers: withExtra('areas_treated', [{ file: REPORT_DATA, section: 'Areas treated / coverage' }]),
      whenMissing: 'fallback',
      notes: 'Falls back to the request\'s areasServiced when areasTreated is absent (completionAreas in complete-scheduled-service.js) — Fast Complete sends only areasServiced.',
    },
    {
      key: 'observations',
      label: 'Observations (tech picks + protocol defaults, merged)',
      capture: ['voice', 'tap'],
      storage: 'structured_notes.observations',
      writers: [COMPLETE_SERVICE, SCHEDULE_PAGE],
      readers: withExtra('observations', [{ file: REPORT_DATA, section: 'Findings / what we found' }]),
      whenMissing: 'hidden',
      notes: 'Prod, last 30 days: 0/69 recurring pest visits recorded an observation (owner audit 2026-09-28). The recurring-pest vocabulary (shared/service-completion-observations.json) is species-neutral.',
    },
    {
      key: 'form_observations',
      label: 'Observations — form provenance only (no protocol defaults)',
      capture: ['voice', 'tap'],
      storage: 'structured_notes.formObservations',
      writers: [COMPLETE_SERVICE, SCHEDULE_PAGE],
      readers: withExtra('form_observations', [{ file: REPORT_DATA, section: 'Findings (form-sourced, structuredObservations)' }]),
      whenMissing: 'hidden',
    },
    {
      key: 'finding_rows',
      label: 'Finding rows (one per submitted observation)',
      capture: ['derived'],
      storage: 'service_findings.title',
      writers: [COMPLETE_SERVICE],
      readers: withExtra('finding_rows', [{ file: REPORT_DATA, section: 'Findings list' }]),
      whenMissing: 'hidden',
      notes: 'Written from the submitted observations on untyped Service Report V1 completions (skipped for internal-only consultations).',
    },
    {
      key: 'recommendations',
      label: 'Recommendations (tech picks + protocol defaults, merged)',
      capture: ['prefill', 'tap'],
      storage: 'structured_notes.recommendations',
      writers: [COMPLETE_SERVICE, SCHEDULE_PAGE, SERVICE_COMPLETION_CHOICES],
      readers: withExtra('recommendations', [{ file: REPORT_DATA, section: 'Recommendations' }]),
      whenMissing: 'hidden',
      notes: 'Prod, last 30 days: 2/69 recurring pest visits recorded one. Owner ruling 2026-09-28: this vocabulary (service-completion-choices.js, GATE_SERVICE_REPORT_COMPLETION_CHOICES) and tip-library.js merge into ONE searchable prefilled Recommendations list.',
    },
    {
      key: 'form_recommendations',
      label: 'Recommendations — form provenance only',
      capture: ['prefill', 'tap'],
      storage: 'structured_notes.formRecommendations',
      writers: [COMPLETE_SERVICE, SCHEDULE_PAGE],
      readers: withExtra('form_recommendations', [{ file: REPORT_DATA, section: 'Recommendations (form-sourced, structuredRecommendations)' }]),
      whenMissing: 'hidden',
    },
    {
      key: 'tech_tips',
      label: 'Tips from your tech (up to 3 from the owner-approved library)',
      capture: ['prefill', 'tap'],
      storage: 'structured_notes.techTips',
      writers: [COMPLETE_SERVICE, TIP_LIBRARY, SCHEDULE_PAGE],
      readers: withExtra('tech_tips', [
        { file: REPORT_DATA, section: 'Tips from your tech (payload.techNote, GATE_TECH_TIPS)' },
        { file: REPORT_VIEW_PAGE, section: 'Tips from your tech note', readerSymbol: 'techNote' },
      ]),
      whenMissing: 'hidden',
      notes: 'The tech picks tip ids; the server resolves and freezes the copy (freezeTechTips). Merges into the Recommendations list per the 2026-09-28 ruling.',
    },
    {
      key: 'protocol_actions_completed',
      label: 'Protocol actions completed',
      capture: ['prefill', 'tap'],
      storage: 'structured_notes.protocolActionsCompleted',
      writers: [COMPLETE_SERVICE],
      readers: withExtra('protocol_actions_completed', [{ file: REPORT_DATA, section: 'What we did (protocol action list)' }]),
      whenMissing: 'hidden',
    },
    {
      key: 'technician_notes',
      label: 'Technician notes (tagged lines + report body)',
      capture: ['voice', 'tap'],
      storage: 'service_records.technician_notes',
      writers: [COMPLETE_SERVICE, SCHEDULE_PAGE, FAST_COMPLETE_SHEET],
      readers: withExtra('technician_notes', [{ file: REPORT_DATA, section: 'Technician report body + [found]/[next] tagged lines' }]),
      whenMissing: 'hidden',
      notes: 'Customer-facing. The planned voice-fill OFFICE note is a different field and must never reach the report writer (owner ruling 2026-09-28).',
    },
    {
      key: 'customer_concern_text',
      label: 'Customer\'s stated concern',
      capture: ['tap'],
      tapOnly: true,
      reason: 'The customer\'s own words about why they called; customer texts and calls shape voice-fill questions but never fill findings (owner 2026-09-27).',
      storage: 'structured_notes.customerConcernText',
      writers: [COMPLETE_SERVICE, SCHEDULE_PAGE],
      readers: withExtra('customer_concern_text', [{ file: REPORT_DATA, section: 'Customer concern grounding' }]),
      whenMissing: 'hidden',
    },
    {
      key: 'customer_recap',
      label: 'Customer recap (AI-drafted from the facts, tech-editable)',
      capture: ['derived', 'voice', 'tap'],
      storage: 'structured_notes.customerRecap',
      writers: [COMPLETE_SERVICE, SCHEDULE_PAGE],
      readers: withExtra('customer_recap', [{ file: REPORT_DATA, section: 'Visit summary paragraph' }]),
      whenMissing: 'fallback',
      notes: 'report-data.js falls back to a generated visitSummary when customerRecap is empty.',
    },
    {
      key: 'customer_interaction',
      label: 'Customer interaction (met / not home / discussed …)',
      capture: ['voice', 'tap'],
      storage: 'structured_notes.customerInteraction',
      writers: [COMPLETE_SERVICE, SCHEDULE_PAGE],
      readers: withExtra('customer_interaction', [{ file: REPORT_DATA, section: 'Customer interaction line' }]),
      whenMissing: 'hidden',
    },
    {
      key: 'visit_outcome',
      label: 'Visit outcome (completed / inspection_only / customer_declined …)',
      capture: ['prefill', 'tap'],
      storage: 'structured_notes.visitOutcome',
      writers: [COMPLETE_SERVICE, SCHEDULE_PAGE, FAST_COMPLETE_SHEET],
      readers: withExtra('visit_outcome', [{ file: REPORT_DATA, section: 'No-application copy branch' }]),
      whenMissing: 'fallback',
      notes: 'Defaults to \'completed\' when the form sends nothing.',
    },
  ];
}

/**
 * The pest activity rating (the one activity gauge on untyped pest lines).
 * @returns {VisitFact}
 */
function pestActivityRatingFact() {
  return {
    key: 'pest_activity_rating',
    label: 'Pest activity seen (rating)',
    capture: ['prefill', 'voice', 'tap'],
    storage: 'service_records.client_pest_rating',
    writers: [COMPLETE_SERVICE, SCHEDULE_PAGE, FAST_COMPLETE_SHEET],
    readers: [{ file: REPORT_DATA, section: 'Activity rating / pest pressure' }],
    whenMissing: 'hidden',
    notes: 'First visits prefill 5 unless the tech clears the picker (clientPestRatingPrefilled / clientPestRatingCleared).',
  };
}

/**
 * Completion photos. Captions feed the report gallery; the AI report writer
 * gets only the photo COUNT (admin-schedule.js), never the photos or
 * captions — see Known gaps.
 * @param {{ whenMissing?: WhenMissing, notes?: string }} [opts]
 * @returns {VisitFact[]}
 */
function photoFacts(opts = {}) {
  return [
    {
      key: 'completion_photos',
      label: 'Completion photos + captions',
      capture: ['photo'],
      storage: 'service_photos.caption',
      writers: [COMPLETE_SERVICE, SERVICE_PHOTOS, SCHEDULE_PAGE],
      readers: [
        { file: REPORT_DATA, section: 'Photos gallery (caption under each photo)' },
        { file: REPORT_VIEW_PAGE, section: 'Photos section' },
      ],
      whenMissing: opts.whenMissing || 'hidden',
      notes: opts.notes || 'Prod, last 30 days: photos on 2/100 visits (owner audit 2026-09-28). Fast Complete sends no photos.',
    },
  ];
}

/**
 * A typed PROJECT_TYPES findings field. Primary sections freeze into
 * service_data.typedReportSnapshot; companion sections (e.g. termite bait on
 * pest_termite_bait_quarterly, tree & shrub on lawn_tree_shrub_combo) freeze
 * into service_data.companionReportSnapshots[] (complete-scheduled-service.js
 * ~6215 / ~6306). Every typed fact also renders through TYPED_FINDINGS_LIST.
 * @param {{ key: string, label: string, companion?: boolean, readers?: VisitFactReader[], whenMissing?: WhenMissing, notes?: string }} def
 * @returns {VisitFact}
 */
function typedFindingFact(def) {
  const snapshot = def.companion ? 'companionReportSnapshots[]' : 'typedReportSnapshot';
  return {
    key: def.key,
    label: def.label,
    capture: ['voice', 'tap'],
    storage: `service_data.${snapshot}.values.${def.key}`,
    writers: [COMPLETE_SERVICE, PROJECT_TYPES, SCHEDULE_PAGE],
    readers: [TYPED_FINDINGS_LIST, ...(def.readers || [])],
    whenMissing: def.whenMissing || 'hidden',
    ...(def.notes ? { notes: def.notes } : {}),
  };
}

// ---------------------------------------------------------------------------
// Excluded service lines (owner ruling — never a customer Service Report
// line; they stay on the compliance Projects flow).
// ---------------------------------------------------------------------------

const EXCLUDED_SERVICE_LINES = Object.freeze({
  wdo_inspection: 'FDACS-13645 WDO inspection stays on the compliance project flow (completion-lane-registry.js COMPLIANCE_PROJECT_KEYS.wdo_inspection) — never a customer Service Report.',
  termite_slab_pretreat: 'Pre-treatment termite certificate (FBC) stays on the compliance project flow (COMPLIANCE_PROJECT_KEYS.termite_slab_pretreat -> pre_treatment_termite_certificate) — never a customer Service Report.',
});

// ---------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------

/** @type {Record<string, ServiceLineFacts>} */
const VISIT_FACTS_CONTRACT = {
  recurring_pest: {
    label: 'Recurring pest control',
    catalogKeys: ['pest_general_bimonthly', 'pest_general_monthly', 'pest_general_quarterly', 'pest_general_semiannual', 'waveguard_membership'],
    voiceFill: true,
    facts: [
      ...genericCompletionFacts(),
      pestActivityRatingFact(),
      ...productFacts(),
      ...photoFacts(),
      {
        key: 'pests_found_where',
        label: 'Pests found + where ("Found" summary line)',
        capture: ['voice'],
        storage: null,
        writers: [],
        readers: [],
        whenMissing: 'hidden',
        status: 'gap',
        notes: 'Owner ruling 2026-09-28: "Found" (pests, where) is a read-only summary line filled from voice. Nothing records it today: observations are species-neutral and unused (0/69), and product targets are the label list, not finds.',
      },
    ],
  },

  one_time_pest: {
    label: 'One-time pest (basic form: one-time pest, fire ant, tick, bee/wasp, mud dauber, cleanout, bed bug)',
    catalogKeys: ['one_time_pest_control', 'fire_ant', 'tick_control', 'bee_wasp_removal', 'mud_dauber_removal', 'pest_initial_cleanout', 'bed_bug_treatment'],
    voiceFill: true,
    facts: [
      ...genericCompletionFacts(),
      pestActivityRatingFact(),
      ...productFacts(),
      ...photoFacts(),
    ],
  },

  reservice_pest: {
    label: 'Pest re-service (callback; full form or Fast Complete)',
    catalogKeys: ['pest_re_service'],
    voiceFill: true,
    facts: [
      ...genericCompletionFacts({
        extraReaders: {
          visit_outcome: [{ file: RESERVICE_REPORT, section: 'Re-service hero copy (inspect-only vs re-treated, GATE_RESERVICE_REPORT_COPY)' }],
        },
      }),
      pestActivityRatingFact(),
      ...productFacts(),
      ...photoFacts(),
      {
        key: 'fast_complete_customer_text',
        label: 'Customer recap text from Fast Complete',
        capture: ['voice', 'tap'],
        storage: null,
        writers: [FAST_COMPLETE_SHEET],
        readers: [],
        whenMissing: 'hidden',
        status: 'gap',
        notes: 'FastCompleteSheet.jsx completionBody sends no customerRecap (and sendCompletionSms:false, requestReview:false): a re-service closed through Fast Complete carries no customer-facing text.',
      },
    ],
  },

  lawn: {
    label: 'Lawn care (recurring programs + the lawn half of lawn & T&S combo)',
    catalogKeys: ['lawn_care_6week', 'lawn_care_monthly', 'lawn_care_quarterly', 'lawn_care_recurring', 'lawn_fertilization', 'lawn_tree_shrub_combo'],
    voiceFill: true,
    facts: [
      ...genericCompletionFacts(),
      ...productFacts(),
      ...photoFacts(),
      {
        key: 'lawn_assessment_observations',
        label: 'Lawn assessment observations (photo diagnosis narrative)',
        capture: ['photo', 'derived'],
        storage: 'lawn_assessments.observations',
        writers: [LAWN_ASSESSMENT_ROUTE],
        readers: [{ file: LAWN_REPORT_V2, section: 'Diagnosis / insights card' }],
        whenMissing: 'fallback',
        notes: 'lawn-report-v2.js falls back through observations || aiSummary || customerSummary.',
      },
      {
        key: 'turf_height_reading',
        label: 'Turf height-of-cut gauge reading',
        capture: ['tap', 'photo'],
        storage: 'turf_height_readings.manual_height_in',
        writers: [COMPLETE_SERVICE, TURF_HEIGHT_SERVICE],
        readers: [{ file: REPORT_DATA, section: 'Mowing height card' }],
        whenMissing: 'hidden',
        notes: 'Optional manualHeightIn + gaugePhoto on the completion body; one row per service record.',
      },
    ],
  },

  mosquito: {
    label: 'Mosquito control (recurring)',
    catalogKeys: ['mosquito_monthly', 'mosquito_seasonal'],
    voiceFill: true,
    facts: [
      ...genericCompletionFacts({
        extraReaders: {
          finding_rows: [{ file: MOSQUITO_REPORT_V2, section: 'Habitat watch card (standing water / foliage / lanai)' }],
        },
      }),
      ...productFacts(),
      ...photoFacts(),
    ],
  },

  tree_shrub: {
    label: 'Tree & shrub (companion section of lawn & T&S combo)',
    catalogKeys: ['lawn_tree_shrub_combo'],
    voiceFill: true,
    facts: [
      typedFindingFact({ key: 'observed_conditions', label: 'Observed plant conditions', companion: true }),
      typedFindingFact({ key: 'treatments_completed', label: 'Treatments completed', companion: true }),
      typedFindingFact({ key: 'customer_recommendations', label: 'Customer recommendations', companion: true }),
      {
        key: 'tree_shrub_assessment_observations',
        label: 'Tree & shrub assessment observations (photo scoring narrative)',
        capture: ['photo', 'derived'],
        storage: 'tree_shrub_assessments.observations',
        writers: [TREE_SHRUB_ASSESSMENT],
        readers: [{ file: TREE_SHRUB_REPORT_V2, section: 'Findings summary + hero photo caption' }],
        whenMissing: 'fallback',
        notes: 'tree-shrub-report-v2.js falls back through observations || aiSummary.',
      },
      ...productFacts(),
      ...photoFacts({
        whenMissing: 'required',
        notes: 'Tree & shrub closeout requires TREE_SHRUB_MIN_CLOSEOUT_PHOTOS uploaded photos (treeShrubPhotoGateRequired); the upload tally lands in structured_notes.completionPhotos.',
      }),
    ],
  },

  cockroach: {
    label: 'Cockroach (typed cockroach form: control + German roach packages)',
    catalogKeys: ['cockroach_control', 'german_roach', 'german_roach_initial'],
    voiceFill: true,
    facts: [
      typedFindingFact({
        key: 'species',
        label: 'Cockroach species',
        readers: [{ file: COCKROACH_REPORT_V2, section: 'Status + status summary' }],
      }),
      typedFindingFact({
        key: 'activity_level',
        label: 'Cockroach activity level',
        readers: [
          { file: COCKROACH_REPORT_V2, section: '"Activity today" metric' },
          { file: CROSS_SELL, section: 'Cross-sell V2 findings signal (companion roach activity, GATE_REPORT_CROSS_SELL_V2)' },
        ],
      }),
      typedFindingFact({
        key: 'activity_locations',
        label: 'Where activity was noted',
        readers: [{ file: COCKROACH_REPORT_V2, section: '"Areas with activity" metric' }],
      }),
      typedFindingFact({
        key: 'work_completed',
        label: 'Work completed today (treatment chips)',
        readers: [{ file: COCKROACH_REPORT_V2, section: '"What we did" (buildWork)' }],
        notes: 'buildWork reads ONLY these chips — see gap cockroach_work_from_products.',
      }),
      typedFindingFact({
        key: 'customer_prep',
        label: 'Customer prep / aftercare',
        readers: [{ file: COCKROACH_REPORT_V2, section: 'How you can help (buildHelp)' }],
      }),
      ...productFacts(),
      ...photoFacts(),
      {
        key: 'cockroach_work_from_products',
        label: 'Products applied, as a source for the cockroach "What we did" section',
        capture: ['voice', 'tap'],
        storage: 'service_products.product_name',
        writers: [COMPLETE_SERVICE],
        readers: [],
        whenMissing: 'hidden',
        status: 'gap',
        notes: 'cockroach-report-v2.js buildWork(chips(values.work_completed)) never falls back to the visit\'s service_products rows: a visit completed without work_completed chips shows no work even though products were recorded.',
      },
    ],
  },

  termite_bait: {
    label: 'Termite bait monitoring (pest primary + termite bait companion)',
    catalogKeys: ['pest_termite_bait_quarterly'],
    voiceFill: true,
    facts: [
      ...genericCompletionFacts(),
      ...productFacts(),
      ...photoFacts(),
      typedFindingFact({
        key: 'stations_checked', label: 'Stations checked (count)', companion: true,
        readers: [{ file: TERMITE_REPORT_V2, section: 'Station summary + counts' }],
      }),
      typedFindingFact({
        key: 'total_stations', label: 'Total stations on property (count)', companion: true,
        readers: [{ file: TERMITE_REPORT_V2, section: 'Station summary + counts' }],
      }),
      typedFindingFact({
        key: 'stations_inaccessible', label: 'Stations inaccessible (count)', companion: true,
        readers: [{ file: TERMITE_REPORT_V2, section: 'Station summary + counts' }],
      }),
      typedFindingFact({
        key: 'stations_with_activity', label: 'Stations with termite activity (count)', companion: true,
        readers: [{ file: TERMITE_REPORT_V2, section: 'Activity summary' }],
      }),
      typedFindingFact({
        key: 'termite_activity', label: 'Termite activity (none / active / previous feeding)', companion: true,
        readers: [
          { file: TERMITE_REPORT_V2, section: 'Status resolution' },
          { file: CROSS_SELL, section: 'Cross-sell V2 findings signal (termite)' },
        ],
      }),
      typedFindingFact({
        key: 'bait_consumption', label: 'Bait consumption level', companion: true,
        readers: [
          { file: TERMITE_REPORT_V2, section: 'Bait condition' },
          { file: CROSS_SELL, section: 'Cross-sell V2 findings signal (bait stations)' },
        ],
      }),
      typedFindingFact({
        key: 'active_station_location', label: 'Active station number / location', companion: true,
        readers: [{ file: TERMITE_REPORT_V2, section: 'Active-location detail line' }],
      }),
      typedFindingFact({
        key: 'customer_recommendations', label: 'Customer recommendations (bait program)', companion: true,
        readers: [{ file: TERMITE_REPORT_V2, section: 'Recommendations' }],
      }),
    ],
  },

  rodent: {
    label: 'Rodent trapping + exclusion (typed)',
    catalogKeys: ['rodent_trapping_exclusion', 'rodent_trapping_sanitation', 'rodent_trapping_exclusion_sanitation', 'rodent_trapping_followup', 'rodent_exclusion', 'rodent_exclusion_only'],
    voiceFill: true,
    facts: [
      typedFindingFact({
        key: 'species',
        label: 'Rodent species',
        readers: [{ file: RODENT_REPORT_NARRATIVE, section: 'Species grounding for the narrative' }],
      }),
      typedFindingFact({
        key: 'traps_checked',
        label: 'Traps checked / set (count)',
        readers: [{ file: REPORT_DATA, section: 'Trap counts (station summary)' }],
      }),
      typedFindingFact({
        key: 'captures',
        label: 'Captures (count)',
        readers: [
          { file: RODENT_REPORT_NARRATIVE, section: 'Grounded capture sentence' },
          { file: CROSS_SELL, section: 'Cross-sell V2 findings signal (rodent trapping)' },
        ],
      }),
      typedFindingFact({ key: 'entry_points_addressed', label: 'Entry points addressed (exclusion)' }),
      typedFindingFact({ key: 'exclusion_work_completed', label: 'Exclusion work completed' }),
      typedFindingFact({ key: 'sanitation_recommendations', label: 'Sanitation recommendations' }),
      ...productFacts(),
      ...photoFacts(),
    ],
  },

  wildlife: {
    label: 'Wildlife trapping (typed)',
    catalogKeys: ['wildlife_trapping'],
    voiceFill: true,
    facts: [
      typedFindingFact({ key: 'target_animal', label: 'Suspected wildlife species' }),
      typedFindingFact({ key: 'evidence_observed', label: 'Wildlife evidence observed' }),
      typedFindingFact({ key: 'entry_points', label: 'Entry / access points' }),
      typedFindingFact({ key: 'traps_checked', label: 'Traps checked (count)' }),
      typedFindingFact({ key: 'customer_recommendations', label: 'Customer recommendations' }),
      ...photoFacts(),
    ],
  },

  flea: {
    label: 'Flea & tick (typed flea form)',
    catalogKeys: ['flea_tick'],
    voiceFill: true,
    facts: [
      typedFindingFact({
        key: 'evidence_level',
        label: 'Evidence / activity level',
        readers: [{ file: ACTIVITY_INDICATORS, section: 'Flea activity gauge (score derived from evidence_level)' }],
      }),
      typedFindingFact({
        key: 'activity_areas',
        label: 'Activity areas',
        whenMissing: 'required',
        notes: 'requiredUnless evidence_level = \'None observed\' (project-types.js).',
      }),
      typedFindingFact({
        key: 'areas_treated',
        label: 'Areas treated',
        readers: [{ file: REPORT_DATA, section: 'Areas treated (TYPED_AREA_FIELD_KEYS)' }],
      }),
      typedFindingFact({ key: 'customer_prep', label: 'Customer prep / aftercare' }),
      ...productFacts(),
      ...photoFacts(),
    ],
  },

  palm: {
    label: 'Palm treatment (basic form; typed palm_injection repoint deferred)',
    catalogKeys: ['palm_treatment'],
    voiceFill: true,
    facts: [
      ...genericCompletionFacts(),
      ...productFacts(),
      ...photoFacts(),
    ],
  },
};

// ---------------------------------------------------------------------------
// Frozen exports.
// ---------------------------------------------------------------------------

Object.values(VISIT_FACTS_CONTRACT).forEach((line) => {
  Object.freeze(line.catalogKeys);
  line.facts.forEach((fact) => {
    Object.freeze(fact.capture);
    Object.freeze(fact.writers);
    Object.freeze(fact.readers);
    Object.freeze(fact);
  });
  Object.freeze(line.facts);
  Object.freeze(line);
});
Object.freeze(VISIT_FACTS_CONTRACT);

module.exports = {
  VISIT_FACTS_CONTRACT,
  EXCLUDED_SERVICE_LINES,
};

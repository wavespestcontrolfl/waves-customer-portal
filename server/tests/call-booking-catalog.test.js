// cancelCallFollowUpsForParentCancel routes each child status flip through
// transitionJobStatus (the sole scheduled_services.status writer) — stub it
// so the helper's own behavior (narrow filter, tracking columns, per-child
// best-effort) is what's under test.
jest.mock('../services/job-status', () => ({
  transitionJobStatus: jest.fn().mockResolvedValue(undefined),
}));
const { transitionJobStatus } = require('../services/job-status');

const {
  loadBookableCallServices,
  resolveCallBookingCatalogService,
  resolveCallBookingPrice,
  resolveCallFollowUpPlan,
  callBookingInvoiceOnComplete,
  callFollowUpBillingShape,
  callBookingDateOnly,
  sanitizeQuotedCallPrice,
  shiftCallFollowUpsForParentMove,
  cancelCallFollowUpsForParentCancel,
} = require('../services/call-booking-catalog');
const { validateModelOutput } = require('../schemas/validate-extraction');
const { flatView } = require('../utils/extraction-compat');
const { normalizeCallExtraction } = require('../utils/intake-normalize');
const { buildExtractionPrompt } = require('../services/prompts/call-extraction-v1');

const CATALOG = [
  {
    id: 'svc-roach',
    service_key: 'cockroach_control',
    name: 'Cockroach Control Service',
    short_name: 'Cockroach Control',
    billing_type: 'one_time',
    pricing_type: 'fixed',
    base_price: '350.00',
    default_duration_minutes: 60,
    requires_follow_up: true,
    follow_up_interval_days: 14,
  },
  {
    id: 'svc-bedbug',
    service_key: 'bed_bug_treatment',
    name: 'Bed Bug Treatment',
    short_name: 'Bed Bug',
    billing_type: 'one_time',
    pricing_type: 'fixed',
    base_price: '850.00',
    default_duration_minutes: 120,
    requires_follow_up: true,
    follow_up_interval_days: 14,
  },
  {
    id: 'svc-pest-q',
    service_key: 'pest_general_quarterly',
    name: 'General Pest Control (Quarterly)',
    short_name: 'Pest Quarterly',
    billing_type: 'recurring',
    pricing_type: 'variable',
    base_price: '65.00',
    default_duration_minutes: 45,
    requires_follow_up: false,
    follow_up_interval_days: null,
  },
  {
    id: 'svc-exclusion',
    service_key: 'rodent_exclusion',
    name: 'Rodent Exclusion',
    short_name: 'Exclusion',
    billing_type: 'one_time',
    pricing_type: 'variable',
    base_price: '1200.00',
    default_duration_minutes: 180,
    requires_follow_up: false,
    follow_up_interval_days: null,
  },
];

describe('resolveCallBookingCatalogService', () => {
  test('model specific_service_name pick wins (verbatim catalog name)', () => {
    const row = resolveCallBookingCatalogService({
      extracted: { specific_service_name: 'Cockroach Control Service' },
      transcription: 'unrelated text',
      services: CATALOG,
    });
    expect(row?.service_key).toBe('cockroach_control');
  });

  test('matched_service naming a catalog entry exactly resolves', () => {
    const row = resolveCallBookingCatalogService({
      extracted: { matched_service: 'bed bug treatment' },
      services: CATALOG,
    });
    expect(row?.service_key).toBe('bed_bug_treatment');
  });

  test('model pick outranks keyword rules', () => {
    const row = resolveCallBookingCatalogService({
      extracted: { specific_service_name: 'Bed Bug Treatment' },
      transcription: 'we found roaches and bed bugs everywhere',
      services: CATALOG,
    });
    expect(row?.service_key).toBe('bed_bug_treatment');
  });

  test('roach keywords in transcript resolve to cockroach_control', () => {
    const row = resolveCallBookingCatalogService({
      extracted: { requested_service: 'pest control', matched_service: 'General Pest Control' },
      transcription: 'I have little roaches all up under my dishwasher, hundreds came out of my suitcase',
      services: CATALOG,
    });
    expect(row?.service_key).toBe('cockroach_control');
  });

  test('german cockroach mention in extraction text resolves without transcript', () => {
    const row = resolveCallBookingCatalogService({
      extracted: { pain_points: 'German cockroach nymphs under the dishwasher' },
      services: CATALOG,
    });
    expect(row?.service_key).toBe('cockroach_control');
  });

  test('palmetto-bug-only calls do NOT map to the cockroach program', () => {
    const row = resolveCallBookingCatalogService({
      extracted: { requested_service: 'pest control' },
      transcription: 'I keep seeing big palmetto bugs in the lanai at night',
      services: CATALOG,
    });
    expect(row).toBeNull();
  });

  test('"palmetto roaches" wording does NOT map to the cockroach program', () => {
    const row = resolveCallBookingCatalogService({
      extracted: { requested_service: 'pest control' },
      transcription: 'We get those big palmetto roaches on the pool deck every summer',
      services: CATALOG,
    });
    expect(row).toBeNull();
  });

  test('"palmetto cockroach" wording does NOT map to the cockroach program', () => {
    const row = resolveCallBookingCatalogService({
      extracted: { pain_points: 'a palmetto cockroach in the garage now and then' },
      services: CATALOG,
    });
    expect(row).toBeNull();
  });

  test('a real roach problem alongside palmetto wording still maps to the program', () => {
    const row = resolveCallBookingCatalogService({
      extracted: { requested_service: 'pest control' },
      transcription: 'It is not just palmetto roaches outside — there are german roaches inside the kitchen cabinets',
      services: CATALOG,
    });
    expect(row?.service_key).toBe('cockroach_control');
  });

  test('negated roach mention ("not roaches, just ants") does NOT map to the cockroach program', () => {
    const row = resolveCallBookingCatalogService({
      extracted: { requested_service: 'pest control' },
      transcription: 'No, it is not roaches, just ants everywhere in the kitchen',
      services: CATALOG,
    });
    expect(row).toBeNull();
  });

  test('negated contraction ("don\'t have roaches") does NOT map to the cockroach program', () => {
    const row = resolveCallBookingCatalogService({
      extracted: { requested_service: 'pest control' },
      transcription: "We don't have roaches, the problem is fleas in the carpet",
      services: CATALOG,
    });
    expect(row).toBeNull();
  });

  test('longer negation ("don\'t currently have any german roaches") does NOT map to the cockroach program', () => {
    const row = resolveCallBookingCatalogService({
      extracted: { requested_service: 'pest control' },
      transcription: "We don't currently have any german roaches, just ants on the patio",
      services: CATALOG,
    });
    expect(row).toBeNull();
  });

  test('hedged negation ("don\'t think we have roaches") does NOT map to the cockroach program', () => {
    const row = resolveCallBookingCatalogService({
      extracted: { requested_service: 'pest control' },
      transcription: "I don't think we have roaches, it is probably spiders in the lanai",
      services: CATALOG,
    });
    expect(row).toBeNull();
  });

  test('adversative conjunction survives the negation strip ("don\'t have ants but roaches")', () => {
    const row = resolveCallBookingCatalogService({
      extracted: { requested_service: 'pest control' },
      transcription: "We don't have ants but roaches are everywhere in the kitchen",
      services: CATALOG,
    });
    expect(row?.service_key).toBe('cockroach_control');
  });

  test('"never had roaches" does NOT map to the cockroach program', () => {
    const row = resolveCallBookingCatalogService({
      extracted: { requested_service: 'mosquito treatment' },
      transcription: 'We never had roaches before, this call is about mosquitoes in the backyard',
      services: CATALOG,
    });
    expect(row).toBeNull();
  });

  test('historical roach mention ("last time it was roaches") does NOT map to the cockroach program', () => {
    const row = resolveCallBookingCatalogService({
      extracted: { requested_service: 'lawn treatment' },
      transcription: 'Last time it was roaches but this visit is for the lawn treatment',
      services: CATALOG,
    });
    expect(row).toBeNull();
  });

  test('reverse-order historical mention ("we had roaches last time") does NOT map either', () => {
    const row = resolveCallBookingCatalogService({
      extracted: { requested_service: 'lawn treatment' },
      transcription: 'We had roaches last time, but this appointment is for the lawn',
      services: CATALOG,
    });
    expect(row).toBeNull();
  });

  test('"roaches a couple years ago" does NOT map to the cockroach program', () => {
    const row = resolveCallBookingCatalogService({
      extracted: { requested_service: 'pest control' },
      transcription: 'You treated our roaches a couple years ago, now we need help with ants',
      services: CATALOG,
    });
    expect(row).toBeNull();
  });

  test('an affirmative roach mention alongside a negated one still maps to the program', () => {
    const row = resolveCallBookingCatalogService({
      extracted: { requested_service: 'pest control' },
      transcription: 'They are not palmetto bugs, we have german roaches in the kitchen',
      services: CATALOG,
    });
    expect(row?.service_key).toBe('cockroach_control');
  });

  test('keyword rule is skipped when the service_key is not in the catalog', () => {
    const row = resolveCallBookingCatalogService({
      extracted: {},
      transcription: 'roaches in the kitchen',
      services: CATALOG.filter((s) => s.service_key !== 'cockroach_control'),
    });
    expect(row).toBeNull();
  });

  test('empty catalog fails open to null', () => {
    expect(resolveCallBookingCatalogService({
      extracted: { specific_service_name: 'Cockroach Control Service' },
      transcription: 'roaches',
      services: [],
    })).toBeNull();
  });
});

describe('resolveCallBookingPrice', () => {
  const roach = CATALOG[0];

  test('transcript-quoted price wins over catalog', () => {
    expect(resolveCallBookingPrice({ quotedPrice: 375, catalogRow: roach }))
      .toEqual({ price: 375, source: 'transcript' });
  });

  test('catalog base_price backstops a one_time service with no quote', () => {
    expect(resolveCallBookingPrice({ quotedPrice: null, catalogRow: roach }))
      .toEqual({ price: 350, source: 'catalog' });
  });

  test('recurring services never take the catalog fallback', () => {
    expect(resolveCallBookingPrice({ quotedPrice: null, catalogRow: CATALOG[2] }))
      .toEqual({ price: null, source: null });
  });

  test('a quoted rate on a recurring service is NOT billable — subscription billing owns it', () => {
    expect(resolveCallBookingPrice({ quotedPrice: 65, catalogRow: CATALOG[2] }))
      .toEqual({ price: null, source: null });
  });

  test('a quote with no catalog match is NOT billable — billing type unknown', () => {
    expect(resolveCallBookingPrice({ quotedPrice: 350, catalogRow: null }))
      .toEqual({ price: null, source: null });
  });

  test('a variable-priced one_time service never takes its base_price on its own', () => {
    const exclusion = CATALOG.find((s) => s.service_key === 'rodent_exclusion');
    expect(resolveCallBookingPrice({ quotedPrice: null, catalogRow: exclusion }))
      .toEqual({ price: null, source: null });
  });

  test('a transcript quote on a variable-priced one_time service IS billable — it is the agreed job price', () => {
    const exclusion = CATALOG.find((s) => s.service_key === 'rodent_exclusion');
    expect(resolveCallBookingPrice({ quotedPrice: 1450, catalogRow: exclusion }))
      .toEqual({ price: 1450, source: 'transcript' });
  });

  test('no quote and no catalog row -> null', () => {
    expect(resolveCallBookingPrice({ quotedPrice: null, catalogRow: null }))
      .toEqual({ price: null, source: null });
  });

  test('implausible quotes are rejected, catalog backstop applies', () => {
    expect(resolveCallBookingPrice({ quotedPrice: 3.5, catalogRow: roach }).source).toBe('catalog');
    expect(resolveCallBookingPrice({ quotedPrice: 9415551234, catalogRow: roach }).source).toBe('catalog');
  });

  test('numeric strings are coerced', () => {
    expect(sanitizeQuotedCallPrice('$350')).toBe(350);
    expect(sanitizeQuotedCallPrice('350.50')).toBe(350.5);
    expect(sanitizeQuotedCallPrice('$1,350')).toBe(1350);
    expect(sanitizeQuotedCallPrice('abc')).toBeNull();
    expect(sanitizeQuotedCallPrice(null)).toBeNull();
  });

  test('range-like strings are rejected, never concatenated into an inflated price', () => {
    expect(sanitizeQuotedCallPrice('50 to 60')).toBeNull();
    expect(sanitizeQuotedCallPrice('350 or 450')).toBeNull();
    expect(sanitizeQuotedCallPrice('2 treatments at 175')).toBeNull();
    expect(resolveCallBookingPrice({ quotedPrice: '50 to 60', catalogRow: roach }))
      .toEqual({ price: 350, source: 'catalog' });
  });
});

describe('callBookingInvoiceOnComplete', () => {
  const roach = CATALOG.find((s) => s.service_key === 'cockroach_control');
  const quarterly = CATALOG.find((s) => s.service_key === 'pest_general_quarterly');

  test('priced one_time catalog booking flags invoice-on-complete', () => {
    expect(callBookingInvoiceOnComplete({ price: 350, catalogRow: roach })).toBe(true);
  });

  test('recurring catalog row never flags, even with a transcript-quoted price', () => {
    expect(callBookingInvoiceOnComplete({ price: 65, catalogRow: quarterly })).toBe(false);
  });

  test('coarse legacy label (no catalog row) never flags — billing type unknown', () => {
    expect(callBookingInvoiceOnComplete({ price: 150, catalogRow: null })).toBe(false);
  });

  test('unpriced one_time booking does not flag', () => {
    expect(callBookingInvoiceOnComplete({ price: null, catalogRow: roach })).toBe(false);
  });
});

describe('resolveCallFollowUpPlan', () => {
  const roach = CATALOG[0];

  test('mention with no date -> parent date + catalog interval, parent window', () => {
    const plan = resolveCallFollowUpPlan({
      extracted: { follow_up_visit_mentioned: true },
      catalogRow: roach,
      parentDate: '2026-07-02',
      parentWindowStart: '08:00',
    });
    expect(plan).toEqual({ scheduledDate: '2026-07-16', windowStart: '08:00' });
  });

  test('default interval is 14 days when the catalog row has none', () => {
    const plan = resolveCallFollowUpPlan({
      extracted: { follow_up_visit_mentioned: true },
      catalogRow: null,
      parentDate: '2026-07-02',
      parentWindowStart: '10:00',
    });
    expect(plan.scheduledDate).toBe('2026-07-16');
  });

  test('explicitly agreed future follow-up date and time win', () => {
    const plan = resolveCallFollowUpPlan({
      extracted: { follow_up_visit_mentioned: true, follow_up_date_time: '2026-07-20T13:00' },
      catalogRow: roach,
      parentDate: '2026-07-02',
      parentWindowStart: '08:00',
    });
    expect(plan).toEqual({ scheduledDate: '2026-07-20', windowStart: '13:00' });
  });

  test('a follow_up_date_time alone (no boolean) still counts as mentioned', () => {
    const plan = resolveCallFollowUpPlan({
      extracted: { follow_up_date_time: '2026-07-20T13:00' },
      catalogRow: roach,
      parentDate: '2026-07-02',
    });
    expect(plan?.scheduledDate).toBe('2026-07-20');
  });

  test('a stated date on/before the initial visit falls back to the interval', () => {
    const plan = resolveCallFollowUpPlan({
      extracted: { follow_up_visit_mentioned: true, follow_up_date_time: '2026-07-02T08:00' },
      catalogRow: roach,
      parentDate: '2026-07-02',
      parentWindowStart: '08:00',
    });
    expect(plan.scheduledDate).toBe('2026-07-16');
  });

  test('date-only signal equal to the parent date (copied confirmed_start_at) does NOT imply a follow-up', () => {
    expect(resolveCallFollowUpPlan({
      extracted: { follow_up_date_time: '2026-07-02T08:00' },
      catalogRow: roach,
      parentDate: '2026-07-02',
      parentWindowStart: '08:00',
    })).toBeNull();
  });

  test('date-only signal before the parent date does NOT imply a follow-up', () => {
    expect(resolveCallFollowUpPlan({
      extracted: { follow_up_visit_mentioned: false, follow_up_date_time: '2026-06-20' },
      catalogRow: roach,
      parentDate: '2026-07-02',
    })).toBeNull();
  });

  test('no mention -> no follow-up', () => {
    expect(resolveCallFollowUpPlan({
      extracted: { follow_up_visit_mentioned: false },
      catalogRow: roach,
      parentDate: '2026-07-02',
    })).toBeNull();
  });

  test('invalid parent date -> no follow-up', () => {
    expect(resolveCallFollowUpPlan({
      extracted: { follow_up_visit_mentioned: true },
      catalogRow: roach,
      parentDate: 'July 2',
    })).toBeNull();
  });

  test('date-shaped but non-calendar parent date (2026-13-01) -> no follow-up', () => {
    expect(resolveCallFollowUpPlan({
      extracted: { follow_up_visit_mentioned: true },
      catalogRow: roach,
      parentDate: '2026-13-01',
    })).toBeNull();
  });

  test('date-shaped but non-calendar extracted date (2026-02-30) falls back to the interval', () => {
    const plan = resolveCallFollowUpPlan({
      extracted: { follow_up_visit_mentioned: true, follow_up_date_time: '2026-02-30T13:00' },
      catalogRow: roach,
      parentDate: '2026-02-02',
      parentWindowStart: '08:00',
    });
    expect(plan).toEqual({ scheduledDate: '2026-02-16', windowStart: '08:00' });
  });

  test('bogus extracted window time (13:75) is dropped in favor of the parent window', () => {
    const plan = resolveCallFollowUpPlan({
      extracted: { follow_up_visit_mentioned: true, follow_up_date_time: '2026-07-20T13:75' },
      catalogRow: roach,
      parentDate: '2026-07-02',
      parentWindowStart: '08:00',
    });
    expect(plan).toEqual({ scheduledDate: '2026-07-20', windowStart: '08:00' });
  });

  test('garbage follow_up_date_time alone ("two weeks") does not create a follow-up', () => {
    expect(resolveCallFollowUpPlan({
      extracted: { follow_up_visit_mentioned: false, follow_up_date_time: 'two weeks' },
      catalogRow: roach,
      parentDate: '2026-07-02',
      parentWindowStart: '08:00',
    })).toBeNull();
  });

  test('non-calendar follow_up_date_time alone (no boolean) does not create a follow-up', () => {
    expect(resolveCallFollowUpPlan({
      extracted: { follow_up_date_time: '2026-02-30T13:00' },
      catalogRow: roach,
      parentDate: '2026-02-02',
    })).toBeNull();
  });

  test('bogus parent window start falls back to 09:00', () => {
    const plan = resolveCallFollowUpPlan({
      extracted: { follow_up_visit_mentioned: true },
      catalogRow: roach,
      parentDate: '2026-07-02',
      parentWindowStart: '8am',
    });
    expect(plan).toEqual({ scheduledDate: '2026-07-16', windowStart: '09:00' });
  });
});

describe('extraction plumbing for the new booking fields', () => {
  test('V2 model output with the new optional fields passes schema validation', () => {
    const output = {
      meta: {
        is_voicemail: false,
        is_spam: false,
        transcript_word_count: 342,
        transcript_duration_seconds: 185,
        call_summary: 'Caller reports roaches under the dishwasher, booked treatment.',
      },
      caller: {
        name_full: 'Adam Pitts',
        first_name: 'Adam',
        last_name: 'Pitts',
        organization_name: null,
        name_confidence: 0.9,
        phone_e164: '+19415551234',
        phone_raw_spoken: null,
        phone_source: 'caller_id',
        email: null,
        relationship_to_property: 'owner',
        on_site_authorization: true,
        decision_maker_present: true,
        preferred_contact_method: 'phone',
      },
      consent: {
        sms_consent_given: true,
        sms_consent_quote: 'Yes, text me the confirmation.',
        call_recording_disclosed: true,
        do_not_contact_request: false,
      },
      property: {
        service_address: {
          raw_text: '14506 20th Street East, Parrish',
          street_line_1: '14506 20th Street East',
          street_line_2: null,
          city: 'Parrish',
          state: 'FL',
          postal_code: '34219',
          county: 'Manatee',
          subdivision_or_community: null,
          normalization_status: 'not_attempted',
        },
        property_type: 'single_family',
        hoa_community_flag: false,
        hoa_common_area_service: false,
        commercial_subtype: null,
        approximate_lot_size_acres: null,
        approximate_living_sqft: null,
        pets_on_property: { present: false, species_notes: null },
        access_notes: null,
      },
      service_request: {
        primary_service_category: 'pest_general',
        secondary_categories: [],
        pests_observed_status: 'observed',
        pests_observed: [
          {
            pest_type: 'roaches_german',
            location_on_property: 'kitchen',
            severity_signal: 'sighting_multiple',
            first_observed: 'this week',
            prior_treatment_attempts: null,
          },
        ],
        service_intent: 'active_infestation_treatment',
        urgency: 'within_48_hours',
        waveguard_tier_mentioned: null,
        specific_service_name: 'Cockroach Control Service',
        quoted_price_usd: 350,
      },
      customer_history: {
        status: 'new_customer',
        competitor_name: null,
        referral_source: null,
        prior_complaint_mentioned: false,
      },
      scheduling: {
        status: 'confirmed',
        confirmed_start_at: '2026-07-02T08:00:00-04:00',
        requested_date_range_start: null,
        requested_date_range_end: null,
        preferred_time_of_day: 'morning',
        callback_window_start: null,
        callback_window_end: null,
        follow_up_mentioned: true,
        follow_up_start_at: null,
        blackout_dates: [],
        scheduling_notes_raw: null,
      },
      sentiment_and_lead: {
        sentiment: 'neutral',
        lead_quality: 'hot',
        objections_raised: [],
        buying_signals: ['just come, that is fine'],
      },
      evidence: [
        {
          field_path: '/scheduling/status',
          quote: 'First thing tomorrow morning will be fine.',
          speaker: 'caller',
          transcript_offset_ms: null,
        },
      ],
      confidence: {
        caller_identity: 0.9,
        service_address: 0.95,
        property_type: 0.8,
        primary_service_category: 0.95,
        urgency: 0.85,
        scheduling_window: 0.9,
        consent_capture: 0.92,
        overall: 0.91,
      },
      triage_flags: [],
    };
    const withNewFields = validateModelOutput(output);
    expect(withNewFields.valid).toBe(true);

    // Backward compat: the same output WITHOUT the new optional fields must
    // still validate (old prompt versions / models that omit them).
    delete output.service_request.specific_service_name;
    delete output.service_request.quoted_price_usd;
    delete output.scheduling.follow_up_mentioned;
    delete output.scheduling.follow_up_start_at;
    expect(validateModelOutput(output).valid).toBe(true);
  });

  test('flatView exposes specific service, quoted price, and follow-up fields', () => {
    const flat = flatView({
      meta: { schema_version: '1.0.0' },
      service_request: {
        primary_service_category: 'pest_general',
        specific_service_name: 'Cockroach Control Service',
        quoted_price_usd: 350,
      },
      scheduling: {
        status: 'confirmed',
        confirmed_start_at: '2026-07-02T08:00:00-04:00',
        follow_up_mentioned: true,
        follow_up_start_at: null,
      },
    });
    expect(flat.specific_service_name).toBe('Cockroach Control Service');
    expect(flat.quoted_price).toBe(350);
    expect(flat.follow_up_visit_mentioned).toBe(true);
    expect(flat.follow_up_date_time).toBeNull();
  });

  test('normalizeCallExtraction sanitizes the new V1 fields', () => {
    const out = normalizeCallExtraction({
      quoted_price: '350',
      follow_up_visit_mentioned: true,
      follow_up_date_time: ' 2026-07-16T08:00 ',
      specific_service_name: ' Cockroach Control Service ',
    });
    expect(out.quoted_price).toBe(350);
    expect(out.follow_up_visit_mentioned).toBe(true);
    expect(out.follow_up_date_time).toBe('2026-07-16T08:00');
    expect(out.specific_service_name).toBe('Cockroach Control Service');

    const junk = normalizeCallExtraction({ quoted_price: 'call me', follow_up_visit_mentioned: 'yes' });
    expect(junk.quoted_price).toBeNull();
    expect(junk.follow_up_visit_mentioned).toBe(false);

    // Ranges must not collapse into a concatenated number ("50 to 60" -> 5060).
    expect(normalizeCallExtraction({ quoted_price: '50 to 60' }).quoted_price).toBeNull();
    expect(normalizeCallExtraction({ quoted_price: '$1,350' }).quoted_price).toBe(1350);
  });

  test('extraction prompt lists the bookable catalog when provided', () => {
    const prompt = buildExtractionPrompt('transcript', '+19415550000', '2026-07-01', {
      bookableServiceNames: ['Cockroach Control Service', 'Bed Bug Treatment'],
    });
    expect(prompt).toContain('BOOKABLE SERVICE CATALOG');
    expect(prompt).toContain('- Cockroach Control Service');
    // Without the option the list block is absent (keeps PROMPT_HASH inputs stable).
    expect(buildExtractionPrompt('t', 'p', 'd')).not.toContain('- Cockroach Control Service');
  });
});

describe('shiftCallFollowUpsForParentMove (shared parent-move child shift)', () => {
  // Chain-recording fake knex conn: captures the where filter and update
  // payload; update() resolves to the canned row count.
  function fakeConn({ updatedCount = 1 } = {}) {
    const log = { table: null, where: null, update: null, raws: [] };
    const conn = (table) => {
      log.table = table;
      const chain = {
        where: (arg) => { log.where = arg; return chain; },
        update: (arg) => { log.update = arg; return Promise.resolve(updatedCount); },
      };
      return chain;
    };
    conn.raw = (sql, bindings) => { const raw = { sql, bindings }; log.raws.push(raw); return raw; };
    conn.fn = { now: () => 'NOW()' };
    return { conn, log };
  }

  test('shifts the still-pending, never-confirmed child by the parent delta', async () => {
    const { conn, log } = fakeConn({ updatedCount: 1 });
    const shifted = await shiftCallFollowUpsForParentMove({
      conn,
      parentServiceId: 'svc-parent',
      fromDate: '2026-07-02',
      toDate: '2026-07-05',
    });
    expect(shifted).toBe(1);
    expect(log.table).toBe('scheduled_services');
    // Narrow filter: only the AI-call child, still pending, never confirmed.
    expect(log.where).toEqual({
      parent_service_id: 'svc-parent',
      source_action: 'ai_call_pipeline_followup',
      status: 'pending',
      customer_confirmed: false,
    });
    // Delta applied in SQL: scheduled_date + (to - from).
    expect(log.raws[0].bindings).toEqual(['2026-07-05', '2026-07-02']);
  });

  test('pg date hydration (JS Date at LOCAL midnight) recovers the calendar date', async () => {
    const { conn, log } = fakeConn();
    // new Date(y, m, d) is local midnight — exactly how pg hydrates a `date`
    // column; toISOString here would roll back a day in any UTC- timezone.
    await shiftCallFollowUpsForParentMove({
      conn,
      parentServiceId: 'svc-parent',
      fromDate: new Date(2026, 6, 2),
      toDate: '2026-07-09T00:00:00.000Z',
    });
    expect(log.raws[0].bindings).toEqual(['2026-07-09', '2026-07-02']);
  });

  test('no-ops (0, no query) when the date did not change', async () => {
    const { conn, log } = fakeConn();
    const shifted = await shiftCallFollowUpsForParentMove({
      conn,
      parentServiceId: 'svc-parent',
      fromDate: new Date(2026, 6, 2),
      toDate: '2026-07-02',
    });
    expect(shifted).toBe(0);
    expect(log.table).toBeNull();
  });

  test('no-ops on missing parent id or unparseable dates', async () => {
    const { conn, log } = fakeConn();
    expect(await shiftCallFollowUpsForParentMove({ conn, parentServiceId: null, fromDate: '2026-07-02', toDate: '2026-07-05' })).toBe(0);
    expect(await shiftCallFollowUpsForParentMove({ conn, parentServiceId: 'svc-p', fromDate: 'not-a-date', toDate: '2026-07-05' })).toBe(0);
    expect(await shiftCallFollowUpsForParentMove({ conn, parentServiceId: 'svc-p', fromDate: '2026-07-02', toDate: null })).toBe(0);
    expect(await shiftCallFollowUpsForParentMove({ conn, parentServiceId: 'svc-p', fromDate: new Date('invalid'), toDate: '2026-07-05' })).toBe(0);
    expect(log.table).toBeNull();
  });
});

describe('cancelCallFollowUpsForParentCancel (shared parent-cancel child cascade)', () => {
  // Chain-recording fake knex conn: the child SELECT resolves to the canned
  // rows; transaction() hands each callback a trx whose update payloads are
  // captured for assertion.
  function fakeConn({ children = [] } = {}) {
    const log = { table: null, selectWhere: null, updates: [], trxCount: 0 };
    const conn = (table) => {
      log.table = table;
      const chain = {
        where: (arg) => { log.selectWhere = arg; return chain; },
        select: () => Promise.resolve(children),
      };
      return chain;
    };
    conn.transaction = async (fn) => {
      log.trxCount += 1;
      const trx = (table) => {
        let whereArg = null;
        const chain = {
          where: (arg) => { whereArg = arg; return chain; },
          update: (payload) => { log.updates.push({ table, where: whereArg, payload }); return Promise.resolve(1); },
        };
        return chain;
      };
      return fn(trx);
    };
    return { conn, log };
  }

  beforeEach(() => {
    transitionJobStatus.mockClear();
    transitionJobStatus.mockResolvedValue(undefined);
  });

  test('cancels each pending, never-confirmed child through transitionJobStatus + tracking columns', async () => {
    const { conn, log } = fakeConn({ children: [{ id: 'child-1' }, { id: 'child-2' }] });
    const cancelled = await cancelCallFollowUpsForParentCancel({ conn, parentServiceId: 'svc-parent' });
    expect(cancelled).toBe(2);
    // Narrow filter: only the AI-call child, still pending, never confirmed.
    expect(log.selectWhere).toEqual({
      parent_service_id: 'svc-parent',
      source_action: 'ai_call_pipeline_followup',
      status: 'pending',
      customer_confirmed: false,
    });
    expect(transitionJobStatus).toHaveBeenCalledTimes(2);
    expect(transitionJobStatus.mock.calls[0][0]).toMatchObject({
      jobId: 'child-1',
      fromStatus: 'pending',
      toStatus: 'cancelled',
      transitionedBy: null,
      notes: 'Cancelled with parent call booking svc-parent',
    });
    // Tracking columns land on the same per-child trx.
    expect(log.updates).toHaveLength(2);
    expect(log.updates[0].where).toEqual({ id: 'child-1' });
    expect(log.updates[0].payload).toMatchObject({
      track_state: 'cancelled',
      cancellation_reason: 'parent_call_booking_cancelled',
    });
  });

  test('best-effort per child: one failed flip does not stop the rest', async () => {
    const { conn } = fakeConn({ children: [{ id: 'child-1' }, { id: 'child-2' }] });
    transitionJobStatus
      .mockRejectedValueOnce(new Error('racing transition'))
      .mockResolvedValueOnce(undefined);
    const cancelled = await cancelCallFollowUpsForParentCancel({ conn, parentServiceId: 'svc-parent' });
    expect(cancelled).toBe(1);
    expect(transitionJobStatus).toHaveBeenCalledTimes(2);
  });

  test('no children → 0, no transactions; missing parent id → 0, no query', async () => {
    const empty = fakeConn({ children: [] });
    expect(await cancelCallFollowUpsForParentCancel({ conn: empty.conn, parentServiceId: 'svc-parent' })).toBe(0);
    expect(empty.log.trxCount).toBe(0);

    const untouched = fakeConn();
    expect(await cancelCallFollowUpsForParentCancel({ conn: untouched.conn, parentServiceId: null })).toBe(0);
    expect(untouched.log.table).toBeNull();
  });
});

describe('callFollowUpBillingShape (visit-2 billing rides the package price)', () => {
  test('a priced package books the child as a $0 included visit', () => {
    expect(callFollowUpBillingShape(350)).toEqual({
      estimated_price: 0,
      followup_included: true,
      create_invoice_on_complete: false,
    });
  });

  test('an unpriced booking leaves the child billable-neutral — never a free included visit', () => {
    expect(callFollowUpBillingShape(null)).toEqual({
      estimated_price: null,
      followup_included: false,
      create_invoice_on_complete: false,
    });
    expect(callFollowUpBillingShape(undefined)).toEqual({
      estimated_price: null,
      followup_included: false,
      create_invoice_on_complete: false,
    });
  });
});

describe('callBookingDateOnly (pg date hydration)', () => {
  test('recovers the calendar date from a pg-hydrated local-midnight Date', () => {
    expect(callBookingDateOnly(new Date(2026, 6, 2))).toBe('2026-07-02');
  });

  test('passes through date strings and rejects garbage', () => {
    expect(callBookingDateOnly('2026-07-09T00:00:00.000Z')).toBe('2026-07-09');
    expect(callBookingDateOnly('2026-07-09')).toBe('2026-07-09');
    expect(callBookingDateOnly('not-a-date')).toBeNull();
    expect(callBookingDateOnly(null)).toBeNull();
    expect(callBookingDateOnly(new Date('invalid'))).toBeNull();
  });
});

describe('loadBookableCallServices (catalog order feeds the prompt hash)', () => {
  test('orders by stable catalog fields so identical catalogs stamp one prompt version', async () => {
    const orderBys = [];
    const chain = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn((col, dir) => { orderBys.push([col, dir]); return chain; }),
      select: jest.fn().mockResolvedValue([{ name: 'A' }]),
    };
    const conn = jest.fn(() => chain);
    const rows = await loadBookableCallServices(conn);
    expect(rows).toEqual([{ name: 'A' }]);
    expect(orderBys).toEqual([['name', 'asc'], ['id', 'asc']]);
  });
});

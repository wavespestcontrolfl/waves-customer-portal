// V2-primary adoption (owner promotion 2026-07-23): a VALID V2 extraction's
// fields drive the canonical customer/lead writes via adoptV2PrimaryFields.
// Regression anchor: 2026-07-23 — a booked 8 AM recurring-service call whose
// V1 leg parse-failed to the null-name stub produced NO customer, NO lead, NO
// appointment, and NO confirmation SMS while ai_extraction_enriched held the
// complete, correct extraction (name at 0.99 confidence, confirmed slot,
// address). Fixtures fictitious; 555-01xx numbers.
const {
  adoptV2PrimaryFields,
  mapSentimentToLegacy,
  mapCallNatureToLegacy,
  EXTRACTION_INVALID_JSON_SUMMARY,
} = require('../utils/extraction-compat');

function v2Fixture(overrides = {}) {
  const base = {
    meta: {
      schema_version: '1.7.0',
      is_voicemail: false,
      is_spam: false,
      transcript_word_count: 1200,
      call_summary: 'Caller booked recurring pest control for tomorrow at 8 AM.',
    },
    caller: {
      name_full: 'Rita Galliano',
      first_name: 'Rita',
      last_name: 'Galliano',
      name_confidence: 0.99,
      phone_e164: '+15555550188',
      phone_source: 'caller_id',
      email: 'rita.example@example.com',
      relationship_to_property: 'owner',
    },
    property: {
      service_address: {
        street_line_1: '123 Seagrass Ln',
        street_line_2: null,
        city: 'Bradenton',
        state: 'FL',
        postal_code: '34211',
      },
      additional_properties: [],
    },
    scheduling: {
      status: 'confirmed',
      confirmed_start_at: '2026-07-24T08:00:00-04:00',
      follow_up_mentioned: false,
      follow_up_start_at: null,
    },
    service_request: {
      primary_service_category: 'pest_general',
      specific_service_name: 'Quarterly Pest Control Service',
      quoted_price_usd: null,
      quote_requested: true,
      quote_promised: false,
    },
    sentiment_and_lead: { sentiment: 'positive', lead_quality: 'hot' },
    call_nature: 'new_lead',
    triage_flags: [],
  };
  return { ...base, ...overrides };
}

// The V1 parse-failure stub, exactly as extractCallData produces it.
function v1Stub() {
  return {
    first_name: null,
    last_name: null,
    email: null,
    phone: null,
    address_line1: null,
    city: null,
    state: null,
    zip: null,
    requested_service: null,
    preferred_date_time: null,
    sentiment: null,
    pain_points: null,
    call_summary: EXTRACTION_INVALID_JSON_SUMMARY,
    lead_quality: 'cold',
    matched_service: null,
    is_spam: false,
    is_voicemail: false,
  };
}

describe('adoptV2PrimaryFields — stub rescue (the incident class)', () => {
  test('a null-name V1 stub adopts identity, address, schedule, and summary from V2', () => {
    const { merged, adoptedFields } = adoptV2PrimaryFields(v1Stub(), v2Fixture());
    expect(merged.first_name).toBe('Rita');
    expect(merged.last_name).toBe('Galliano');
    expect(merged.address_line1).toBe('123 Seagrass Ln');
    expect(merged.city).toBe('Bradenton');
    expect(merged.zip).toBe('34211');
    expect(merged.appointment_confirmed).toBe(true);
    expect(merged.preferred_date_time).toBe('2026-07-24T08:00');
    expect(merged.matched_service).toBe('Quarterly Pest Control Service');
    expect(merged.call_summary).toBe('Caller booked recurring pest control for tomorrow at 8 AM.');
    expect(merged.lead_quality).toBe('hot');
    expect(merged.is_lead).toBe(true);
    expect(merged.call_type).toBe('new_inquiry');
    expect(adoptedFields).toEqual(expect.arrayContaining(['first_name', 'last_name', 'appointment_confirmed', 'preferred_date_time']));
  });

  test('the nested V2 object never leaks into the merged legacy shape', () => {
    const { merged } = adoptV2PrimaryFields(v1Stub(), v2Fixture());
    expect(merged._v2).toBeUndefined();
    expect(merged.caller).toBeUndefined();
    expect(merged.scheduling).toBeUndefined();
    expect(merged.meta).toBeUndefined();
  });

  test('non-V2 extraction and null are no-ops', () => {
    const v1 = v1Stub();
    expect(adoptV2PrimaryFields(v1, null).merged).toBe(v1);
    expect(adoptV2PrimaryFields(v1, { first_name: 'Flat' }).merged).toBe(v1);
    expect(adoptV2PrimaryFields(v1, null).adoptedFields).toEqual([]);
  });
});

describe('adoptV2PrimaryFields — identity conflict rules', () => {
  test('V2 name wins over a differing V1 name only at name_confidence ≥ 0.9', () => {
    const v1 = { ...v1Stub(), first_name: 'Reeta', last_name: 'Galiano' };
    const confident = adoptV2PrimaryFields(v1, v2Fixture()).merged;
    expect(confident.first_name).toBe('Rita');
    expect(confident.last_name).toBe('Galliano');

    const shaky = v2Fixture();
    shaky.caller = { ...shaky.caller, name_confidence: 0.6 };
    const kept = adoptV2PrimaryFields(v1, shaky).merged;
    expect(kept.first_name).toBe('Reeta');
    expect(kept.last_name).toBe('Galiano');
  });

  test('a low-confidence V2 name still fills an EMPTY V1 name', () => {
    const shaky = v2Fixture();
    shaky.caller = { ...shaky.caller, name_confidence: 0.4 };
    const { merged } = adoptV2PrimaryFields(v1Stub(), shaky);
    expect(merged.first_name).toBe('Rita');
  });

  test('a confident V2 conflict replaces the name AS A UNIT — no V1-surname chimera', () => {
    const v1 = { ...v1Stub(), first_name: 'John', last_name: 'Smith' };
    const v2 = v2Fixture();
    v2.caller = { ...v2.caller, first_name: 'Jane', last_name: null, name_full: 'Jane', name_confidence: 0.95 };
    const { merged } = adoptV2PrimaryFields(v1, v2);
    expect(merged.first_name).toBe('Jane');
    expect(merged.last_name).toBeNull();
  });

  test('COMPLEMENTARY partial names merge — a V2 surname never clears a V1 first name', () => {
    const v1 = { ...v1Stub(), first_name: 'Rita', last_name: null };
    const v2 = v2Fixture();
    v2.caller = { ...v2.caller, first_name: null, last_name: 'Galliano', name_full: 'Galliano', name_confidence: 0.99 };
    const { merged } = adoptV2PrimaryFields(v1, v2);
    expect(merged.first_name).toBe('Rita');
    expect(merged.last_name).toBe('Galliano');
  });

  test('matching overlap with a V2-only extra part merges instead of replacing', () => {
    const v1 = { ...v1Stub(), first_name: 'Rita', last_name: null };
    const { merged } = adoptV2PrimaryFields(v1, v2Fixture());
    expect(merged.first_name).toBe('Rita');
    expect(merged.last_name).toBe('Galliano');
  });
});

describe('adoptV2PrimaryFields — address unit (line2) ownership', () => {
  test('a DIFFERENT V2 street clears a V1-only unit', () => {
    const v1 = { ...v1Stub(), address_line1: '999 Old Rd', address_line2: 'Unit 4', city: 'Venice' };
    const { merged } = adoptV2PrimaryFields(v1, v2Fixture());
    expect(merged.address_line1).toBe('123 Seagrass Ln');
    expect(merged.address_line2).toBeNull();
    expect(merged.city).toBe('Bradenton');
  });

  test('the SAME full address keeps a V1 unit V2 simply did not capture', () => {
    const v1 = { ...v1Stub(), address_line1: '123 seagrass ln', address_line2: 'Unit 4', city: 'Bradenton', zip: '34211' };
    const { merged } = adoptV2PrimaryFields(v1, v2Fixture());
    expect(merged.address_line2).toBe('Unit 4');
  });

  test('same street but a DIFFERENT city/zip is a different property — V1 unit cleared', () => {
    const v1 = { ...v1Stub(), address_line1: '123 Seagrass Ln', address_line2: 'Unit 4', city: 'Venice', zip: '34285' };
    const { merged } = adoptV2PrimaryFields(v1, v2Fixture());
    expect(merged.address_line2).toBeNull();
    expect(merged.city).toBe('Bradenton');
    expect(merged.zip).toBe('34211');
  });

  test('a V2-heard unit wins outright', () => {
    const v1 = { ...v1Stub(), address_line1: '123 Seagrass Ln', address_line2: 'Unit 4' };
    const v2 = v2Fixture();
    v2.property = { ...v2.property, service_address: { ...v2.property.service_address, street_line_2: 'Apt 7' } };
    const { merged } = adoptV2PrimaryFields(v1, v2);
    expect(merged.address_line2).toBe('Apt 7');
  });
});

describe('adoptV2PrimaryFields — scheduling verdict', () => {
  test('V2 non-confirmed status demotes a V1 confirmed appointment', () => {
    const v1 = { ...v1Stub(), appointment_confirmed: true, preferred_date_time: '2026-07-24T10:00' };
    const v2 = v2Fixture();
    v2.scheduling = { ...v2.scheduling, status: 'reschedule_requested' };
    const { merged } = adoptV2PrimaryFields(v1, v2);
    expect(merged.appointment_confirmed).toBe(false);
    expect(merged.preferred_date_time).toBeNull();
  });

  test('ambiguous V2 status leaves the V1 verdict alone', () => {
    const v1 = { ...v1Stub(), appointment_confirmed: true, preferred_date_time: '2026-07-24T10:00' };
    const v2 = v2Fixture();
    v2.scheduling = { ...v2.scheduling, status: 'ambiguous', confirmed_start_at: null };
    const { merged } = adoptV2PrimaryFields(v1, v2);
    expect(merged.appointment_confirmed).toBe(true);
    expect(merged.preferred_date_time).toBe('2026-07-24T10:00');
  });

  test('confirmed without a parseable start time adopts nothing', () => {
    const v2 = v2Fixture();
    v2.scheduling = { ...v2.scheduling, confirmed_start_at: null };
    const { merged } = adoptV2PrimaryFields(v1Stub(), v2);
    expect(merged.appointment_confirmed).toBeUndefined();
    expect(merged.preferred_date_time).toBeNull();
  });

  test('ET-offset ISO normalizes to the legacy wall clock via the injected converter', () => {
    const calls = [];
    const etWallClock = (v) => { calls.push(v); return '2026-07-24T08:00'; };
    const { merged } = adoptV2PrimaryFields(v1Stub(), v2Fixture(), { etWallClock });
    expect(calls).toContain('2026-07-24T08:00:00-04:00');
    expect(merged.preferred_date_time).toBe('2026-07-24T08:00');
  });
});

describe('adoptV2PrimaryFields — OR flags and fill-gap tiers', () => {
  test('spam/voicemail/quote flags OR in: V2 true wins, V2 false never un-flags', () => {
    const v2 = v2Fixture();
    v2.meta = { ...v2.meta, is_spam: true };
    const flagged = adoptV2PrimaryFields(v1Stub(), v2).merged;
    expect(flagged.is_spam).toBe(true);
    expect(flagged.quote_requested).toBe(true);

    const v1Spam = { ...v1Stub(), is_spam: true };
    const clean = v2Fixture();
    const still = adoptV2PrimaryFields(v1Spam, clean).merged;
    expect(still.is_spam).toBe(true);
  });

  test('email fills only a gap; a V1-captured email is left for the arbiter lanes', () => {
    const v1 = { ...v1Stub(), email: 'v1heard@example.com' };
    const { merged } = adoptV2PrimaryFields(v1, v2Fixture());
    expect(merged.email).toBe('v1heard@example.com');
    expect(adoptV2PrimaryFields(v1Stub(), v2Fixture()).merged.email).toBe('rita.example@example.com');
  });

  test('phone adopts only a SPOKEN callback number, never a caller-ID echo', () => {
    expect(adoptV2PrimaryFields(v1Stub(), v2Fixture()).merged.phone).toBeNull();
    const spoken = v2Fixture();
    spoken.caller = { ...spoken.caller, phone_source: 'spoken' };
    expect(adoptV2PrimaryFields(v1Stub(), spoken).merged.phone).toBe('+15555550188');
  });

  test('a SPOKEN V2 callback replaces a V1 phone that is just the ANI backfill', () => {
    const spoken = v2Fixture();
    spoken.caller = { ...spoken.caller, phone_source: 'spoken', phone_e164: '+15555550188' };
    const aniEcho = { ...v1Stub(), phone: '+15555550100' };
    const { merged } = adoptV2PrimaryFields(aniEcho, spoken, { callerPhone: '+15555550100' });
    expect(merged.phone).toBe('+15555550188');
  });

  test('a V1-heard callback that differs from the ANI is kept over the V2 spoken number', () => {
    const spoken = v2Fixture();
    spoken.caller = { ...spoken.caller, phone_source: 'spoken', phone_e164: '+15555550188' };
    const realV1Callback = { ...v1Stub(), phone: '+15555550177' };
    const { merged } = adoptV2PrimaryFields(realV1Callback, spoken, { callerPhone: '+15555550100' });
    expect(merged.phone).toBe('+15555550177');
  });

  test('a V1 matched_service survives (recurring-intent backstop already ran on it)', () => {
    const v1 = { ...v1Stub(), matched_service: 'Bi-Monthly Pest Control Service' };
    const { merged } = adoptV2PrimaryFields(v1, v2Fixture());
    expect(merged.matched_service).toBe('Bi-Monthly Pest Control Service');
  });

  test('a spam-class call_nature trips is_spam, not just call_type', () => {
    for (const nature of ['spam_solicitation', 'robocall', 'wrong_number', 'vendor_or_partner']) {
      const v2 = v2Fixture({ call_nature: nature });
      const { merged } = adoptV2PrimaryFields(v1Stub(), v2);
      expect(merged.is_spam).toBe(true);
    }
    expect(adoptV2PrimaryFields(v1Stub(), v2Fixture()).merged.is_spam).toBe(false);
  });

  test('category-only V2 service uses the family primary label, not the lossy coarse map', () => {
    const v2 = v2Fixture();
    v2.service_request = { ...v2.service_request, specific_service_name: null, primary_service_category: 'stinging_insect' };
    const { merged } = adoptV2PrimaryFields(v1Stub(), v2);
    expect(merged.matched_service).toBe('Bee / Wasp Nest Removal Service');

    const excl = v2Fixture();
    excl.service_request = { ...excl.service_request, specific_service_name: null, primary_service_category: 'exclusion' };
    expect(adoptV2PrimaryFields(v1Stub(), excl).merged.matched_service).toBe('Rodent Exclusion');
  });

  test('a healthy V1 call_summary is never replaced; only the stub sentinel is', () => {
    const v1 = { ...v1Stub(), call_summary: 'V1 wrote a real summary.' };
    expect(adoptV2PrimaryFields(v1, v2Fixture()).merged.call_summary).toBe('V1 wrote a real summary.');
    expect(adoptV2PrimaryFields(v1Stub(), v2Fixture()).merged.call_summary)
      .toBe('Caller booked recurring pest control for tomorrow at 8 AM.');
  });
});

describe('legacy enum mappers', () => {
  test('mapSentimentToLegacy folds the V2 superset into the legacy enum', () => {
    expect(mapSentimentToLegacy('positive')).toBe('positive');
    expect(mapSentimentToLegacy('angry')).toBe('frustrated');
    expect(mapSentimentToLegacy('urgent_distress')).toBe('frustrated');
    expect(mapSentimentToLegacy('confused')).toBe('neutral');
    expect(mapSentimentToLegacy(null)).toBeNull();
    expect(mapSentimentToLegacy('nonsense')).toBeNull();
  });

  test('mapCallNatureToLegacy folds call_nature into the legacy call_type enum', () => {
    expect(mapCallNatureToLegacy('new_lead')).toBe('new_inquiry');
    expect(mapCallNatureToLegacy('billing_question')).toBe('billing');
    expect(mapCallNatureToLegacy('robocall')).toBe('spam');
    expect(mapCallNatureToLegacy('vendor_or_partner')).toBe('spam');
    expect(mapCallNatureToLegacy('silent_or_noise')).toBe('voicemail');
    expect(mapCallNatureToLegacy(null)).toBeNull();
  });
});

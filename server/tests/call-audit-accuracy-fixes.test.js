/**
 * Call-pipeline accuracy fixes (2026-07-08 audit) — the cheap-wins batch.
 *
 * Pins: ET wall-clock conversion for zone-suffixed V2 datetimes (UTC-Z leak),
 * ANI-vs-spoken near-miss preference, anonymous-sentinel phone gate, the
 * transcript-labeling word-integrity check, triage category/payload
 * enrichment, the widened schema enums, and the readiness-script cohort
 * prefix contract.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false),
  isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));

const { _test } = require('../services/call-recording-processor');
const {
  v2IsoToEtWallClock,
  phoneNearMissOfAni,
  isUsableContactPhone,
  labeledTranscriptPreservesWords,
  resolveCallContactPhone,
} = _test;
const { buildTriageItem } = require('../services/call-routing-gates');
const { computeDeterministicTriageFlags, ADVISORY_TRIAGE_FLAGS } = require('../services/call-triage-flags');
const { mapServiceCategoryToLegacy } = require('../utils/extraction-compat');
const { validateModelOutput } = require('../schemas/validate-extraction');
const { extractionPromptVersion, PROMPT_HASH } = require('../services/prompts/call-extraction-v1');

// ─── v2IsoToEtWallClock — the UTC-Z booking leak ────────────────────────────

describe('v2IsoToEtWallClock', () => {
  test('correct EDT offset is an identity (wall clock preserved)', () => {
    expect(v2IsoToEtWallClock('2026-07-14T10:00:00-04:00')).toBe('2026-07-14T10:00');
  });

  test('correct EST offset is an identity', () => {
    expect(v2IsoToEtWallClock('2026-01-14T10:00:00-05:00')).toBe('2026-01-14T10:00');
  });

  test('UTC Z timestamp converts to the ET wall clock instead of booking 4h late', () => {
    // 14:00Z during EDT == 10:00 ET. The old slice(0,16) booked 14:00.
    expect(v2IsoToEtWallClock('2026-07-14T14:00:00Z')).toBe('2026-07-14T10:00');
    // Non-ET numeric offset also converts via the instant.
    expect(v2IsoToEtWallClock('2026-07-14T14:00:00+00:00')).toBe('2026-07-14T10:00');
  });

  test('wrong-season ET offset keeps the agreed WALL clock (codex P1)', () => {
    // Model used the EST offset in July: the 10:00 the caller agreed to is
    // authoritative — converting the instant would book 11:00, an hour late.
    expect(v2IsoToEtWallClock('2026-07-14T10:00:00-05:00')).toBe('2026-07-14T10:00');
  });

  test('zone-less wall clock passes through; garbage returns null', () => {
    expect(v2IsoToEtWallClock('2026-07-14T10:00')).toBe('2026-07-14T10:00');
    expect(v2IsoToEtWallClock('2026-07-14T10:00:00')).toBe('2026-07-14T10:00');
    expect(v2IsoToEtWallClock('July 14 at 10')).toBeNull();
    expect(v2IsoToEtWallClock(null)).toBeNull();
  });
});

// ─── ANI near-miss + sentinel gate ──────────────────────────────────────────

describe('phone identity guards', () => {
  const inbound = { direction: 'inbound', from_phone: '+19415552091', to_phone: '+19415550000' };

  test('a spoken number 1-2 digits off the ANI keeps the ANI (mistranscribed digits)', () => {
    expect(phoneNearMissOfAni('+19415552021', '+19415552091')).toBe(true);
    expect(resolveCallContactPhone(inbound, '+19415552021')).toBe('+19415552091');
  });

  test('a wholesale-different callback number still wins (legit "reach me at" case)', () => {
    expect(phoneNearMissOfAni('+14075551234', '+19415552091')).toBe(false);
    expect(resolveCallContactPhone(inbound, '+14075551234')).toBe('+14075551234');
  });

  test('3+ digit differences are not near-misses', () => {
    expect(phoneNearMissOfAni('+19415559876', '+19415552091')).toBe(false);
  });

  test('anonymous sentinels and words never become contact phones', () => {
    expect(isUsableContactPhone('+266696687')).toBe(false); // Twilio ANONYMOUS
    expect(isUsableContactPhone('+7378742833')).toBe(false); // Twilio RESTRICTED
    expect(isUsableContactPhone('anonymous')).toBe(false);
    expect(isUsableContactPhone('Restricted')).toBe(false);
    expect(isUsableContactPhone('client:agent')).toBe(false);
    expect(isUsableContactPhone('+19415552091')).toBe(true);
  });

  test('a blocked caller ID with a valid spoken number resolves to the spoken number', () => {
    const blocked = { direction: 'inbound', from_phone: '+266696687', to_phone: '+19415550000' };
    expect(resolveCallContactPhone(blocked, '+19415552091')).toBe('+19415552091');
  });

  test('a blocked caller ID with no spoken number resolves to nothing (no phantom customer key)', () => {
    // Mark our own line internal (as prod config does) so the only remaining
    // candidate is the sentinel — which must be refused.
    const twilioNumbers = require('../config/twilio-numbers');
    twilioNumbers.isInternalNumber.mockImplementation((v) => v === '+19415550000');
    try {
      const blocked = { direction: 'inbound', from_phone: '+266696687', to_phone: '+19415550000' };
      expect(resolveCallContactPhone(blocked, null)).toBeNull();
    } finally {
      twilioNumbers.isInternalNumber.mockImplementation(() => false);
    }
  });
});

// ─── Transcript-labeling word integrity ─────────────────────────────────────

describe('labeledTranscriptPreservesWords', () => {
  const raw = 'Speaker 1: I do not want to cancel my service.\nSpeaker 2: Understood, we will keep it active.';

  test('a prefix-only relabel passes', () => {
    const labeled = 'Caller: I do not want to cancel my service.\nAgent: Understood, we will keep it active.';
    expect(labeledTranscriptPreservesWords(raw, labeled)).toBe(true);
  });

  test('a dropped negation fails the check', () => {
    const corrupted = 'Caller: I do want to cancel my service.\nAgent: Understood, we will keep it active.';
    expect(labeledTranscriptPreservesWords(raw, corrupted)).toBe(false);
  });

  test('a swapped word fails the check', () => {
    const corrupted = 'Caller: I do not want to cancel my account.\nAgent: Understood, we will keep it active.';
    expect(labeledTranscriptPreservesWords(raw, corrupted)).toBe(false);
  });

  test('reflowed turns with identical words pass (multiset, not sequence)', () => {
    const reflowed = 'Caller: I do not want to cancel my service. Understood, we will keep it active.\nAgent: ';
    expect(labeledTranscriptPreservesWords(raw, reflowed)).toBe(true);
  });
});

// ─── Triage categories + payload enrichment ─────────────────────────────────

describe('triage surfacing', () => {
  const extraction = {
    meta: { call_summary: 'Caller asked for Tuesday, first slot of the day.' },
    confidence: { overall: 0.82 },
    scheduling: {
      status: 'requested',
      confirmed_start_at: null,
      requested_date_range_start: '2026-07-14',
      requested_date_range_end: '2026-07-14',
      preferred_time_of_day: 'morning',
      callback_window_start: null,
      callback_window_end: null,
      scheduling_notes_raw: 'first slot of the day',
    },
    property: {
      additional_properties: [
        { address_line1: '456 Pine Ave', city: 'Venice', zip: null, is_rental: true },
      ],
    },
  };

  test('gate-rejection reasons file as time_ambiguous, not service_unknown', () => {
    expect(buildTriageItem({ callLogId: 'c1', flag: 'not_confirmed', extraction }).category).toBe('time_ambiguous');
    expect(buildTriageItem({ callLogId: 'c1', flag: 'confirmed_without_start_time', extraction }).category).toBe('time_ambiguous');
    expect(buildTriageItem({ callLogId: 'c1', flag: 'cancellation_request', extraction }).category).toBe('time_ambiguous');
    expect(buildTriageItem({ callLogId: 'c1', flag: 'auto_booking_skipped_after_approval', extraction }).category).toBe('time_ambiguous');
  });

  test('scheduling-shaped cards carry the captured window fields', () => {
    const item = buildTriageItem({ callLogId: 'c1', flag: 'not_confirmed', extraction });
    const payload = JSON.parse(item.payload);
    expect(payload.scheduling_window).toEqual({
      status: 'requested',
      confirmed_start_at: null,
      requested_date_range_start: '2026-07-14',
      requested_date_range_end: '2026-07-14',
      preferred_time_of_day: 'morning',
      callback_window_start: null,
      callback_window_end: null,
      scheduling_notes_raw: 'first slot of the day',
    });
  });

  test('multi_property_call cards carry the extra addresses and file as address_review', () => {
    const item = buildTriageItem({ callLogId: 'c1', flag: 'multi_property_call', extraction });
    expect(item.category).toBe('address_review');
    const payload = JSON.parse(item.payload);
    expect(payload.additional_properties).toHaveLength(1);
    expect(payload.additional_properties[0].address_line1).toBe('456 Pine Ave');
  });

  test('secondary_contact_captured carries other_parties_mentioned when set', () => {
    const item = buildTriageItem({
      callLogId: 'c1',
      flag: 'secondary_contact_captured',
      extraction: { ...extraction, secondary_contact: { first_name: 'Sarah' }, other_parties_mentioned: true },
    });
    const payload = JSON.parse(item.payload);
    expect(payload.other_parties_mentioned).toBe(true);
    expect(payload.secondary_contact.first_name).toBe('Sarah');
  });

  test('secondary_contact_is_existing_customer files as customer_field_conflict', () => {
    expect(buildTriageItem({ callLogId: 'c1', flag: 'secondary_contact_is_existing_customer', extraction }).category)
      .toBe('customer_field_conflict');
  });
});

// ─── AV-accept advisory readback ────────────────────────────────────────────

describe('address_readback under a decisive AV accept', () => {
  const baseExtraction = {
    meta: { is_voicemail: false, is_spam: false },
    caller: {},
    property: { service_address: { street_line_1: '1520 Park Ave', city: 'Sarasota' } },
    consent: {},
    scheduling: { status: 'none' },
    confidence: { overall: 0.9, service_address: 0.5 },
    sentiment_and_lead: {},
    customer_history: {},
    triage_flags: [],
  };

  test('AV accept + low model address confidence emits the advisory readback flag', () => {
    const flags = computeDeterministicTriageFlags(baseExtraction, {
      addressValidation: { status: 'validated_accept' },
    });
    expect(flags).toContain('address_readback');
    expect(ADVISORY_TRIAGE_FLAGS.has('address_readback')).toBe(true);
  });

  test('AV accept + confident address stays clean (no flag)', () => {
    const flags = computeDeterministicTriageFlags(
      { ...baseExtraction, confidence: { overall: 0.9, service_address: 0.92 } },
      { addressValidation: { status: 'validated_accept' } },
    );
    expect(flags).not.toContain('address_readback');
    expect(flags).not.toContain('low_confidence_address');
  });
});

// ─── Schema widenings (1.3.0) ───────────────────────────────────────────────

describe('schema 1.3.0 additive widenings', () => {
  function validModelOutput(overrides = {}) {
    return {
      meta: { is_voicemail: false, is_spam: false, transcript_word_count: 100, transcript_duration_seconds: 60, call_summary: 'x' },
      caller: {
        name_full: 'Melissa', first_name: 'Melissa', last_name: null, organization_name: null,
        name_confidence: 0.9, phone_e164: '+14074933469', phone_raw_spoken: null, phone_source: 'spoken',
        email: null, relationship_to_property: 'owner', on_site_authorization: true, decision_maker_present: true,
        preferred_contact_method: 'phone',
      },
      consent: { sms_consent_given: false, sms_consent_quote: null, call_recording_disclosed: true, do_not_contact_request: false },
      property: {
        service_address: { raw_text: '123 Oak St', street_line_1: '123 Oak St', street_line_2: null, city: 'Venice', state: 'FL', postal_code: '34285', county: 'Sarasota', subdivision_or_community: null, normalization_status: 'not_attempted' },
        property_type: 'single_family', hoa_community_flag: false, hoa_common_area_service: false,
        commercial_subtype: null, approximate_lot_size_acres: null, approximate_living_sqft: null,
        pets_on_property: { present: false, species_notes: null }, access_notes: null,
      },
      service_request: {
        primary_service_category: 'pest_general', secondary_categories: [], pests_observed_status: 'not_observed_inquiry',
        pests_observed: [], service_intent: 'recurring_membership_inquiry', urgency: 'scheduling_flexible',
        waveguard_tier_mentioned: null, specific_service_name: null, quoted_price_usd: null,
        quote_requested: false, quote_promised: false,
      },
      customer_history: { status: 'new_customer', competitor_name: null, referral_source: null, prior_complaint_mentioned: false },
      scheduling: { status: 'none', confirmed_start_at: null, requested_date_range_start: null, requested_date_range_end: null, preferred_time_of_day: null, callback_window_start: null, callback_window_end: null, blackout_dates: [], scheduling_notes_raw: null },
      sentiment_and_lead: { sentiment: 'neutral', lead_quality: 'warm', objections_raised: [], buying_signals: [] },
      evidence: [],
      confidence: { caller_identity: 0.9, service_address: 0.95, property_type: 0.8, primary_service_category: 0.95, urgency: 0.85, scheduling_window: 0.9, consent_capture: 0.9, overall: 0.9 },
      triage_flags: [],
      ...overrides,
    };
  }

  test('bed_bug and wdo are valid primary service categories', () => {
    for (const cat of ['bed_bug', 'wdo']) {
      const payload = validModelOutput();
      payload.service_request.primary_service_category = cat;
      const res = validateModelOutput(payload);
      expect(res.valid).toBe(true);
    }
  });

  test('new pest types and swarmers_seen severity validate', () => {
    const payload = validModelOutput();
    payload.service_request.primary_service_category = 'mosquito';
    payload.service_request.pests_observed_status = 'observed';
    payload.service_request.pests_observed = [{ pest_type: 'no_see_ums', severity_signal: 'swarmers_seen' }];
    const res = validateModelOutput(payload);
    expect(res.valid).toBe(true);
  });

  test('existing_appointment_coordination is a valid triage flag; other_parties_mentioned validates', () => {
    const res = validateModelOutput(validModelOutput({
      triage_flags: ['existing_appointment_coordination'],
      other_parties_mentioned: true,
    }));
    expect(res.valid).toBe(true);
  });

  test('bed_bug/wdo map to specific legacy labels, not a coarse downgrade', () => {
    expect(mapServiceCategoryToLegacy('bed_bug')).toBe('Bed Bug Treatment');
    expect(mapServiceCategoryToLegacy('wdo')).toBe('WDO Inspection');
  });
});

// ─── Readiness-script cohort contract ───────────────────────────────────────

describe('prompt-version cohort shape', () => {
  test('catalog-era versions are prefix-extensions of the bare hash (the readiness script matches on this)', () => {
    const suffixed = extractionPromptVersion(['General Pest Control', 'Lawn Care']);
    expect(suffixed.startsWith(`${PROMPT_HASH}-cat.`)).toBe(true);
    expect(extractionPromptVersion([])).toBe(PROMPT_HASH);
  });
});

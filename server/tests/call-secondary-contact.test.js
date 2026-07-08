/**
 * Secondary-contact extraction + service-contact persistence.
 *
 * Pins the contract from the real 2026-07-08 WDO call: a realtor booked an
 * inspection for a home BUYER and directed notifications to "the buyer and
 * myself" — the buyer's name and phone had no schema slot and were dropped
 * (only their email leaked into the caller's record). The extraction now
 * carries a secondary_contact, and — behind GATE_CALL_SECONDARY_CONTACT —
 * the pipeline persists it into the first empty service-contact slot so the
 * existing appointment fan-out (confirmation / en-route / tech-arrived)
 * reaches both parties, keeping the caller in the loop via
 * appointment_notify_primary.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false),
  isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));

const db = require('../models/db');
const { _test } = require('../services/call-recording-processor');
const {
  normalizeCallExtraction,
  resolveCallSecondaryContact,
  persistCallSecondaryContact,
} = _test;
const { flatView, mapSecondaryContactToLegacy } = require('../utils/extraction-compat');
const { normalizeSecondaryContact: normalizeSecondaryContactV2 } = require('../utils/normalize-extraction-v2');
const { validateModelOutput, validatePersisted, SCHEMA_VERSION } = require('../schemas/validate-extraction');
const { ADVISORY_TRIAGE_FLAGS, computeDeterministicTriageFlags } = require('../services/call-triage-flags');
const { SERVICE_CONTACT_SLOTS } = require('../services/customer-contact');

afterEach(() => {
  db.mockReset();
});

// ─── V1 extraction normalization ───────────────────────────────────────────

describe('normalizeCallExtraction — secondary_contact', () => {
  test('keeps a well-formed secondary contact and normalizes components', () => {
    const out = normalizeCallExtraction({
      secondary_contact: {
        first_name: 'joseph',
        last_name: 'haught',
        phone: '954-290-1693',
        email: 'Joseph.Haught89431@Gmail.com',
        role: 'home_buyer',
        wants_notifications: 'true',
        notes: 'relocating from out of area',
      },
    });
    expect(out.secondary_contact).toEqual({
      first_name: 'joseph',
      last_name: 'haught',
      phone: '+19542901693',
      email: 'joseph.haught89431@gmail.com',
      role: 'home_buyer',
      wants_notifications: true,
      notes: 'relocating from out of area',
    });
  });

  test('nulls a garbled email and an unusable phone; junk role becomes unknown', () => {
    const out = normalizeCallExtraction({
      secondary_contact: {
        first_name: 'Pat',
        phone: '29',
        email: 'www.cw63@gmail.com',
        role: 'buyer agent!!',
        wants_notifications: false,
      },
    });
    expect(out.secondary_contact.phone).toBeNull();
    expect(out.secondary_contact.email).toBeNull();
    expect(out.secondary_contact.role).toBe('unknown');
    expect(out.secondary_contact.wants_notifications).toBe(false);
  });

  test('an empty shell collapses to null; absent field stays null (legacy extractions unaffected)', () => {
    expect(normalizeCallExtraction({
      secondary_contact: { role: 'tenant', wants_notifications: true, notes: 'x' },
    }).secondary_contact).toBeNull();
    expect(normalizeCallExtraction({ first_name: 'Casey' }).secondary_contact).toBeNull();
    expect(normalizeCallExtraction({ secondary_contact: 'garbage' }).secondary_contact).toBeNull();
  });
});

// ─── V2 ↔ legacy mapping ───────────────────────────────────────────────────

describe('secondary_contact V2 mapping', () => {
  const v2Contact = {
    name_full: 'Joseph Haught',
    first_name: 'Joseph',
    last_name: 'Haught',
    phone_e164: '+19542901693',
    phone_raw_spoken: 'nine five four...',
    email: 'joseph.haught89431@gmail.com',
    role: 'home_buyer',
    wants_notifications: true,
    notes: null,
  };

  test('mapSecondaryContactToLegacy maps to the flat V1 shape', () => {
    expect(mapSecondaryContactToLegacy(v2Contact)).toEqual({
      first_name: 'Joseph',
      last_name: 'Haught',
      phone: '+19542901693',
      email: 'joseph.haught89431@gmail.com',
      role: 'home_buyer',
      wants_notifications: true,
      notes: null,
    });
    expect(mapSecondaryContactToLegacy(null)).toBeNull();
    expect(mapSecondaryContactToLegacy({ role: 'tenant', wants_notifications: false })).toBeNull();
  });

  test('flatView carries secondary_contact from a V2 extraction', () => {
    const flat = flatView({
      meta: { schema_version: '1.2.0' },
      caller: {},
      secondary_contact: v2Contact,
    });
    expect(flat.secondary_contact.phone).toBe('+19542901693');
    expect(flat.secondary_contact.role).toBe('home_buyer');
  });

  test('a V2 contact with only name_full keeps its name in the flat mapping', () => {
    const mapped = mapSecondaryContactToLegacy({
      name_full: 'Joseph Haught', first_name: null, last_name: null,
      phone_e164: '+19542901693', email: null, role: 'home_buyer', wants_notifications: true, notes: null,
    });
    expect(mapped.first_name).toBe('Joseph');
    expect(mapped.last_name).toBe('Haught');
  });

  test('resolveCallSecondaryContact: same person → field-wise merge, V2 fills V1 gaps, wants_notifications ORs', () => {
    const v1Partial = { first_name: 'Joseph', last_name: null, phone: null, email: null, role: 'unknown', wants_notifications: false, notes: null };
    const merged = resolveCallSecondaryContact({ secondary_contact: v1Partial }, { secondary_contact: v2Contact });
    expect(merged).toEqual({
      first_name: 'Joseph',
      last_name: 'Haught',
      phone: '+19542901693',
      email: 'joseph.haught89431@gmail.com',
      role: 'home_buyer',
      wants_notifications: true,
      notes: null,
    });
    expect(resolveCallSecondaryContact({}, { secondary_contact: v2Contact }).first_name).toBe('Joseph');
    expect(resolveCallSecondaryContact({}, null)).toBeNull();
  });

  test('resolveCallSecondaryContact: conflicting identities never merge — V1 wins unmerged', () => {
    const v1Matt = { first_name: 'Matt', last_name: null, phone: '+19415551111', email: null, role: 'real_estate_agent', wants_notifications: false, notes: null };
    const out = resolveCallSecondaryContact({ secondary_contact: v1Matt }, { secondary_contact: v2Contact });
    expect(out).toBe(v1Matt);
    expect(out.wants_notifications).toBe(false);
  });

  test('normalizeExtractionV2 secondary contact: e164/email enforced, garbled email rejected, empty shell nulled', () => {
    const normalized = normalizeSecondaryContactV2({
      ...v2Contact, phone_e164: 'not-a-phone', email: 'nope', first_name: 'joseph', last_name: null, name_full: null,
    });
    expect(normalized.phone_e164).toBeNull();
    expect(normalized.email).toBeNull();
    expect(normalized.first_name).toBe('Joseph');
    // URL-shaped transcript garble is not a mailbox — same guard as V1.
    expect(normalizeSecondaryContactV2({ ...v2Contact, email: 'www.cw63@gmail.com' }).email).toBeNull();
    expect(normalizeSecondaryContactV2({ role: 'tenant', wants_notifications: true })).toBeNull();
  });
});

// ─── schema: additive 1.2.0 ────────────────────────────────────────────────

describe('schema 1.2.0 — secondary_contact is additive', () => {
  // Compact valid payload mirroring call-extraction-v2.test.js's fixture.
  function validModelOutput() {
    return {
      meta: { is_voicemail: false, is_spam: false, transcript_word_count: 100, transcript_duration_seconds: 60, call_summary: 'Realtor books a WDO inspection for a buyer.' },
      caller: {
        name_full: 'Melissa', first_name: 'Melissa', last_name: null, organization_name: 'Coldwell Banker',
        name_confidence: 0.9, phone_e164: '+14074933469', phone_raw_spoken: null, phone_source: 'spoken',
        email: null, relationship_to_property: 'other', on_site_authorization: true, decision_maker_present: true,
        preferred_contact_method: 'phone',
      },
      consent: { sms_consent_given: true, sms_consent_quote: 'you can send notifications to the buyer and myself', call_recording_disclosed: true, do_not_contact_request: false },
      property: {
        service_address: { raw_text: '11530 Water Poppy Terrace', street_line_1: '11530 Water Poppy Terrace', street_line_2: null, city: 'Bradenton', state: 'FL', postal_code: '34202', county: 'Manatee', subdivision_or_community: 'Lakewood Ranch', normalization_status: 'not_attempted' },
        property_type: 'single_family', hoa_community_flag: true, hoa_common_area_service: false,
        commercial_subtype: null, approximate_lot_size_acres: null, approximate_living_sqft: null,
        pets_on_property: { present: false, species_notes: null }, access_notes: null,
      },
      service_request: {
        primary_service_category: 'termite', secondary_categories: [], pests_observed_status: 'not_observed_inquiry',
        pests_observed: [], service_intent: 'inspection_only', urgency: 'within_48_hours',
        waveguard_tier_mentioned: null, specific_service_name: null, quoted_price_usd: 250,
        quote_requested: true, quote_promised: false,
      },
      customer_history: { status: 'new_customer', competitor_name: null, referral_source: null, prior_complaint_mentioned: false },
      scheduling: { status: 'confirmed', confirmed_start_at: '2026-07-09T12:00:00-04:00', requested_date_range_start: null, requested_date_range_end: null, preferred_time_of_day: null, callback_window_start: null, callback_window_end: null, blackout_dates: [], scheduling_notes_raw: null },
      sentiment_and_lead: { sentiment: 'positive', lead_quality: 'hot', objections_raised: [], buying_signals: [] },
      evidence: [],
      confidence: { caller_identity: 0.9, service_address: 0.95, property_type: 0.8, primary_service_category: 0.95, urgency: 0.85, scheduling_window: 0.9, consent_capture: 0.9, overall: 0.9 },
      triage_flags: [],
    };
  }

  const secondaryContact = {
    name_full: 'Joseph Haught', first_name: 'Joseph', last_name: 'Haught',
    phone_e164: '+19542901693', phone_raw_spoken: null,
    email: 'joseph.haught89431@gmail.com', role: 'home_buyer',
    wants_notifications: true, notes: null,
  };

  function persistedMeta(payload, version) {
    payload.meta.call_id = '550e8400-e29b-41d4-a716-446655440000';
    payload.meta.schema_version = version;
    payload.meta.extracted_at = '2026-07-08T22:00:00Z';
    payload.meta.extraction_model = 'gemini-2.5-pro';
    payload.meta.extraction_prompt_version = 'v2-abc123';
    return payload;
  }

  test('current SCHEMA_VERSION is 1.2.0', () => {
    expect(SCHEMA_VERSION).toBe('1.2.0');
  });

  test('a payload WITHOUT secondary_contact still validates (1.1.0-shape unchanged)', () => {
    expect(validateModelOutput(validModelOutput()).valid).toBe(true);
    expect(validatePersisted(persistedMeta(validModelOutput(), '1.1.0')).valid).toBe(true);
    expect(validatePersisted(persistedMeta(validModelOutput(), '1.0.0')).valid).toBe(true);
  });

  test('a payload WITH secondary_contact validates in both schemas at 1.2.0', () => {
    const withContact = { ...validModelOutput(), secondary_contact: secondaryContact };
    const model = validateModelOutput(withContact);
    expect(model.errors).toBeNull();
    expect(model.valid).toBe(true);
    const persisted = validatePersisted(persistedMeta({ ...validModelOutput(), secondary_contact: secondaryContact }, '1.2.0'));
    expect(persisted.errors).toBeNull();
    expect(persisted.valid).toBe(true);
    // Explicit null is also valid — the model is told to emit null when no
    // second person was named.
    expect(validateModelOutput({ ...validModelOutput(), secondary_contact: null }).valid).toBe(true);
  });

  test('model-output tolerates a non-E.164 secondary phone (server normalizes; must not schema-fail the extraction)', () => {
    const sloppy = { ...validModelOutput(), secondary_contact: { ...secondaryContact, phone_e164: '954-290-1693', email: null } };
    expect(validateModelOutput(sloppy).valid).toBe(true);
    // The persisted schema IS strict — but only after normalization has run.
    const normalized = normalizeSecondaryContactV2(sloppy.secondary_contact);
    expect(normalized.phone_e164).toBe('+19542901693');
  });

  test('deterministic triage flag fires and is advisory', () => {
    const extraction = persistedMeta({ ...validModelOutput(), secondary_contact: secondaryContact }, '1.2.0');
    const flags = computeDeterministicTriageFlags(extraction, {});
    expect(flags).toContain('secondary_contact_captured');
    expect(ADVISORY_TRIAGE_FLAGS.has('secondary_contact_captured')).toBe(true);
    // No secondary contact → no flag.
    expect(computeDeterministicTriageFlags(persistedMeta(validModelOutput(), '1.1.0'), {})).not.toContain('secondary_contact_captured');
  });
});

// ─── service-contact slot persistence ──────────────────────────────────────

describe('persistCallSecondaryContact', () => {
  const buyer = {
    first_name: 'Joseph', last_name: 'Haught', phone: '+19542901693',
    email: 'joseph.haught89431@gmail.com', role: 'home_buyer',
    wants_notifications: true, notes: null,
  };

  function makeDb({ customer, updateRows = 1 }) {
    const writes = { updates: [], prefsMerges: [], whereFns: 0 };
    db.mockImplementation((table) => {
      if (table === 'customers') {
        const b = {
          where: jest.fn((arg) => {
            // The conditional slot write chains .where(fn) emptiness guards —
            // invoke them against a sub-builder (mirroring knex) so the
            // predicate is exercised and counted.
            if (typeof arg === 'function') {
              writes.whereFns += 1;
              const sub = { whereNull: jest.fn(() => sub), orWhere: jest.fn(() => sub) };
              arg(sub);
            }
            return b;
          }),
          first: jest.fn(async () => customer),
          update: jest.fn(async (payload) => { writes.updates.push(payload); return updateRows; }),
        };
        return b;
      }
      if (table === 'notification_prefs') {
        return {
          insert: jest.fn((payload) => ({
            onConflict: jest.fn(() => ({
              merge: jest.fn(async (mergePayload) => { writes.prefsMerges.push({ payload, mergePayload }); return 1; }),
            })),
          })),
        };
      }
      throw new Error(`unexpected table ${table}`);
    });
    return writes;
  }

  const bareCustomer = {
    id: 'cust-1', phone: '+14074933469', email: null,
    service_contact_name: null, service_contact_phone: null, service_contact_email: null,
    service_contact2_name: null, service_contact2_phone: null, service_contact2_email: null,
    service_contact3_name: null, service_contact3_phone: null, service_contact3_email: null,
  };

  test('writes the first empty slot and keeps the primary on appointment texts AND service reports', async () => {
    const writes = makeDb({ customer: bareCustomer });
    const result = await persistCallSecondaryContact('cust-1', buyer);
    expect(result).toBe('written');
    expect(writes.updates).toEqual([{
      service_contact_name: 'Joseph Haught',
      service_contact_phone: '+19542901693',
      service_contact_email: 'joseph.haught89431@gmail.com',
    }]);
    // Emptiness re-asserted in the UPDATE's WHERE (race guard) — one
    // predicate per slot column.
    expect(writes.whereFns).toBe(3);
    expect(writes.prefsMerges).toHaveLength(1);
    expect(writes.prefsMerges[0].mergePayload).toEqual({
      appointment_notify_primary: true,
      service_report_notify_primary: true,
    });
  });

  test('a lost race (slot filled between read and write) is a no-op, not an overwrite', async () => {
    const writes = makeDb({ customer: bareCustomer, updateRows: 0 });
    expect(await persistCallSecondaryContact('cust-1', buyer)).toBe('skipped_slot_race');
    expect(writes.prefsMerges).toHaveLength(0);
  });

  test('new phone but an email already on the record: phone is kept, duplicate email is dropped', async () => {
    const writes = makeDb({ customer: { ...bareCustomer, email: 'joseph.haught89431@gmail.com' } });
    expect(await persistCallSecondaryContact('cust-1', buyer)).toBe('written');
    expect(writes.updates).toEqual([{
      service_contact_name: 'Joseph Haught',
      service_contact_phone: '+19542901693',
      service_contact_email: null,
    }]);
  });

  test('no explicit notification intent → no write (contact stays triage/lead-only)', async () => {
    const writes = makeDb({ customer: bareCustomer });
    expect(await persistCallSecondaryContact('cust-1', { ...buyer, wants_notifications: false })).toBe('skipped_no_intent');
    expect(await persistCallSecondaryContact('cust-1', null)).toBe('skipped_no_intent');
    expect(await persistCallSecondaryContact('cust-1', { ...buyer, phone: null, email: null })).toBe('skipped_no_contact_info');
    expect(writes.updates).toHaveLength(0);
    expect(writes.prefsMerges).toHaveLength(0);
  });

  test('a phone already on the record (primary or slot, any format) is a no-op', async () => {
    const writes = makeDb({ customer: { ...bareCustomer, phone: '9542901693' } });
    expect(await persistCallSecondaryContact('cust-1', buyer)).toBe('skipped_phone_on_record');
    const writes2 = makeDb({ customer: { ...bareCustomer, service_contact2_phone: '(954) 290-1693' } });
    expect(await persistCallSecondaryContact('cust-1', buyer)).toBe('skipped_phone_on_record');
    expect(writes.updates).toHaveLength(0);
    expect(writes2.updates).toHaveLength(0);
  });

  test('existing service contacts: fills the next empty slot but preserves the admin notify-primary choice', async () => {
    const writes = makeDb({
      customer: { ...bareCustomer, service_contact_name: 'Property Manager', service_contact_phone: '+19415557777' },
    });
    expect(await persistCallSecondaryContact('cust-1', buyer)).toBe('written');
    expect(writes.updates).toEqual([{
      service_contact2_name: 'Joseph Haught',
      service_contact2_phone: '+19542901693',
      service_contact2_email: 'joseph.haught89431@gmail.com',
    }]);
    expect(writes.prefsMerges).toHaveLength(0);
  });

  test('all three slots occupied → no-op', async () => {
    const full = { ...bareCustomer };
    for (const slot of SERVICE_CONTACT_SLOTS) full[slot.phone] = '+1941555000' + SERVICE_CONTACT_SLOTS.indexOf(slot);
    const writes = makeDb({ customer: full });
    expect(await persistCallSecondaryContact('cust-1', buyer)).toBe('skipped_slots_full');
    expect(writes.updates).toHaveLength(0);
  });

  test('email-only contact dedups against emails on record', async () => {
    const writes = makeDb({ customer: { ...bareCustomer, email: 'JOSEPH.HAUGHT89431@gmail.com' } });
    expect(await persistCallSecondaryContact('cust-1', { ...buyer, phone: null })).toBe('skipped_email_on_record');
    expect(writes.updates).toHaveLength(0);
  });
});

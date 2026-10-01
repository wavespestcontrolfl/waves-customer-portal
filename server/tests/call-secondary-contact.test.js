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
  resolveCallSecondaryContacts,
  persistCallSecondaryContact,
  onSiteOptinAskTrigger,
  decideOnSiteOptinAsk,
  validatePhoneCallAppointmentCustomer,
} = _test;
const { flatView, mapSecondaryContactToLegacy, canonicalV2Secondary } = require('../utils/extraction-compat');
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
      is_billing_party: false,
      notes: 'relocating from out of area',
    });
  });

  test('preserves is_billing_party through V1 normalization (payer linkage input)', () => {
    const out = normalizeCallExtraction({
      secondary_contact: {
        first_name: 'James', last_name: 'Brenner', email: 'jim@example.com',
        role: 'landlord', wants_notifications: true, is_billing_party: 'true',
      },
    });
    expect(out.secondary_contact.is_billing_party).toBe(true);
  });

  test('1.7.0: lender role survives the V1 allowlist (loan officer named as a party)', () => {
    const out = normalizeCallExtraction({
      secondary_contact: {
        first_name: 'Robert', last_name: 'Cozzano',
        email: 'rc@example.com', role: 'lender', wants_notifications: true,
      },
    });
    expect(out.secondary_contact.role).toBe('lender');
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
      wants_appointment_texts: false,
      on_site: false,
      is_billing_party: false,
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
      wants_appointment_texts: false,
      on_site: false,
      is_billing_party: false,
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
    // Same first name + different surname is a DIFFERENT person — "Joseph
    // Smith" must not inherit Joseph Haught's phone/email.
    const v1JosephSmith = { first_name: 'Joseph', last_name: 'Smith', phone: null, email: null, role: 'tenant', wants_notifications: true, notes: null };
    expect(resolveCallSecondaryContact({ secondary_contact: v1JosephSmith }, { secondary_contact: v2Contact })).toBe(v1JosephSmith);
  });

  test('buildTriageItem carries the extraction secondary_contact on every insert site', () => {
    const { buildTriageItem } = require('../services/call-routing-gates');
    const item = buildTriageItem({
      callLogId: 'call-1',
      flag: 'secondary_contact_captured',
      extraction: { meta: { call_summary: 's' }, secondary_contact: v2Contact },
      severity: 'advisory',
    });
    expect(JSON.parse(item.payload).secondary_contact.phone_e164).toBe('+19542901693');
    // Other flags are unaffected.
    const other = buildTriageItem({ callLogId: 'call-1', flag: 'missing_last_name', extraction: { meta: {}, secondary_contact: v2Contact } });
    expect(JSON.parse(other.payload).secondary_contact).toBeUndefined();
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
      consent: { sms_consent_given: true, sms_consent_quote: 'you can send notifications to the buyer and myself', call_recording_disclosed: true, do_not_contact_request: false, sms_declined: false },
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

  test('current SCHEMA_VERSION is 1.22.0', () => {
    expect(SCHEMA_VERSION).toBe('1.22.0');
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

  test('1.7.0: arranger caller relationships validate (real_estate_agent, lender)', () => {
    // The live failure this encodes: realtor and loan-officer callers were
    // forced into relationship_to_property "other", making arranger calls
    // undetectable downstream.
    for (const rel of ['real_estate_agent', 'lender']) {
      const data = validModelOutput();
      data.caller.relationship_to_property = rel;
      const model = validateModelOutput(data);
      expect(model.errors).toBeNull();
      expect(model.valid).toBe(true);
      expect(validatePersisted(persistedMeta(data, '1.7.0')).valid).toBe(true);
    }
  });

  test('1.7.0: secondary role lender validates in both schemas (New Day USA pattern)', () => {
    const lenderContact = { ...secondaryContact, name_full: 'Robert Cozzano', first_name: 'Robert', last_name: 'Cozzano', role: 'lender' };
    const withLender = { ...validModelOutput(), secondary_contact: lenderContact, secondary_contacts: [lenderContact] };
    const model = validateModelOutput(withLender);
    expect(model.errors).toBeNull();
    expect(model.valid).toBe(true);
    expect(validatePersisted(persistedMeta({ ...validModelOutput(), secondary_contact: lenderContact, secondary_contacts: [lenderContact] }, '1.7.0')).valid).toBe(true);
  });

  test('1.22.0: wants_appointment_texts / on_site are optional booleans in both schemas, non-boolean rejected', () => {
    const base = { ...secondaryContact };
    // Absent (older payloads) still validates.
    expect(validateModelOutput({ ...validModelOutput(), secondary_contact: base }).valid).toBe(true);
    const flagged = { ...base, wants_appointment_texts: true, on_site: true };
    const withFlags = { ...validModelOutput(), secondary_contact: flagged, secondary_contacts: [flagged] };
    const model = validateModelOutput(withFlags);
    expect(model.errors).toBeNull();
    expect(model.valid).toBe(true);
    const persisted = validatePersisted(persistedMeta({ ...validModelOutput(), secondary_contact: flagged, secondary_contacts: [flagged] }, SCHEMA_VERSION));
    expect(persisted.errors).toBeNull();
    expect(persisted.valid).toBe(true);
    for (const bad of [{ ...base, wants_appointment_texts: 'yes' }, { ...base, on_site: null }]) {
      expect(validateModelOutput({ ...validModelOutput(), secondary_contact: bad }).valid).toBe(false);
      expect(validatePersisted(persistedMeta({ ...validModelOutput(), secondary_contact: bad }, SCHEMA_VERSION)).valid).toBe(false);
      expect(validateModelOutput({ ...validModelOutput(), secondary_contacts: [bad] }).valid).toBe(false);
    }
    expect(validateModelOutput({ ...validModelOutput(), secondary_contact: { ...base, bogus_field: true } }).valid).toBe(false);
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
  // Every phone-bearing slot write stamps the row-level consent artifact
  // (#2955): the account holder requested the contact on a recorded call.
  const CALL_CONSENT_STAMP = {
    service_contacts_consent_at: expect.any(Date),
    service_contacts_consent_source: 'call_pipeline_request',
    service_contacts_consent_text_version: 'call-2026-07-23',
  };
  const buyer = {
    first_name: 'Joseph', last_name: 'Haught', phone: '+19542901693',
    email: 'joseph.haught89431@gmail.com', role: 'home_buyer',
    wants_notifications: true, notes: null,
  };

  function makeDb({ customer, updateRows = 1, otherCustomer = null, prefs = undefined }) {
    const writes = { updates: [], prefsMerges: [], whereFns: 0 };
    db.raw = jest.fn((sql, binds) => ({ sql, binds }));
    db.mockImplementation((table) => {
      if (table === 'customers') {
        // One builder serves both queries against `customers`: the main
        // `.where({id}).first()` fetch AND the cross-customer collision check
        // (`.whereNull().whereNot().whereRaw().first('id')`) — the whereRaw
        // call marks which query this is.
        let isCollisionQuery = false;
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
          whereNull: jest.fn(() => b),
          whereNot: jest.fn(() => b),
          whereRaw: jest.fn(() => { isCollisionQuery = true; return b; }),
          first: jest.fn(async () => (isCollisionQuery ? otherCustomer : customer)),
          update: jest.fn(async (payload) => { writes.updates.push(payload); return updateRows; }),
        };
        return b;
      }
      if (table === 'notification_prefs') {
        const b = {
          where: jest.fn(() => b),
          first: jest.fn(async () => prefs),
          insert: jest.fn((payload) => ({
            onConflict: jest.fn(() => ({
              merge: jest.fn(async (mergePayload) => { writes.prefsMerges.push({ payload, mergePayload }); return 1; }),
            })),
          })),
        };
        return b;
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
    const result = await persistCallSecondaryContact('cust-1', buyer, { smsConsentExplicit: true });
    expect(result).toBe('written');
    expect(writes.updates).toEqual([{
      service_contact_name: 'Joseph Haught',
      service_contact_phone: '+19542901693',
      service_contact_email: 'joseph.haught89431@gmail.com',
      service_contact_role: 'home_buyer',
      // Phone contact requested on a recorded call → consent artifact
      // stamps in the same atomic write (#2955).
      ...CALL_CONSENT_STAMP,
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
    // Prefs land BEFORE the slot write by design (a crash between the two must
    // never leave a visible slot with the primary silently dropped); a lost
    // race leaves them set — benign, since no new contact was written.
    expect(writes.prefsMerges).toHaveLength(1);
  });

  test('new phone but an email already on the record: phone is kept, duplicate email is dropped', async () => {
    const writes = makeDb({ customer: { ...bareCustomer, email: 'joseph.haught89431@gmail.com' } });
    expect(await persistCallSecondaryContact('cust-1', buyer, { smsConsentExplicit: true })).toBe('written');
    expect(writes.updates).toEqual([{
      service_contact_name: 'Joseph Haught',
      service_contact_phone: '+19542901693',
      service_contact_email: null,
      service_contact_role: 'home_buyer',
      ...CALL_CONSENT_STAMP,
    }]);
  });

  test('already-stamped row + explicit consent: adding a contact refreshes the stamp (#2955 r3)', async () => {
    const writes = makeDb({
      customer: {
        ...bareCustomer,
        service_contact_name: 'Property Manager',
        service_contact_phone: '+19415557777',
        service_contacts_consent_at: '2026-07-22T00:00:00Z',
      },
    });
    expect(await persistCallSecondaryContact('cust-1', buyer, { smsConsentExplicit: true })).toBe('written');
    expect(writes.updates).toEqual([{
      service_contact2_name: 'Joseph Haught',
      service_contact2_phone: '+19542901693',
      service_contact2_email: 'joseph.haught89431@gmail.com',
      service_contact2_role: 'home_buyer',
      ...CALL_CONSENT_STAMP,
    }]);
  });

  test('unconsented phone added to a STAMPED row clears the stamp (codex r5 P1)', async () => {
    const writes = makeDb({
      customer: {
        ...bareCustomer,
        service_contact_name: 'Property Manager',
        service_contact_phone: '+19415557777',
        service_contacts_consent_at: '2026-07-22T00:00:00Z',
      },
    });
    expect(await persistCallSecondaryContact('cust-1', buyer)).toBe('written');
    expect(writes.updates).toEqual([{
      service_contact2_name: 'Joseph Haught',
      service_contact2_phone: '+19542901693',
      service_contact2_email: 'joseph.haught89431@gmail.com',
      service_contact2_role: 'home_buyer',
      // The old stamp never described the new phone — cleared, so the
      // fanout gate holds the whole list until re-attestation.
      service_contacts_consent_at: null,
      service_contacts_consent_source: null,
      service_contacts_consent_text_version: null,
      // ...remembering which phones it DID cover, so the new recipient's YES
      // can restore the stamp (grandfathered slots have no opt-in row).
      service_preferences: {
        sql: "jsonb_set(COALESCE(service_preferences, '{}'::jsonb), '{consent_covered_phone_keys}', ?::jsonb)",
        binds: [JSON.stringify(['9415557777'])],
      },
    }]);
  });

  test('keepConsentStamp (new phone already behind a blocking opt-in row): an inferred on-site add does NOT clear the account\'s existing stamp', async () => {
    const writes = makeDb({
      customer: {
        ...bareCustomer,
        service_contact_name: 'Property Manager',
        service_contact_phone: '+19415557777',
        service_contacts_consent_at: '2026-07-22T00:00:00Z',
      },
    });
    expect(await persistCallSecondaryContact('cust-1', { ...buyer, role: 'spouse_partner', on_site: true }, { onSiteAskEligible: true, keepConsentStamp: true })).toBe('written');
    expect(writes.updates[0]).not.toHaveProperty('service_contacts_consent_at');
    // ...and the new phone goes on the account's unconsented list (held out of
    // every text resolver until its own YES, whatever the opt-in gate does).
    expect(writes.updates[0].service_preferences.sql).toContain('unconsented_slot_phone_keys');
    expect(writes.updates[0].service_preferences.binds).toEqual(['9542901693']);
  });

  test('keepConsentStamp on a row with NO prior stamp (this write stamps it for the caller\'s explicit consent): the inferred phone is still held', async () => {
    const writes = makeDb({ customer: bareCustomer });
    expect(await persistCallSecondaryContact('cust-1', { ...buyer, role: 'spouse_partner', on_site: true, wants_notifications: false }, { smsConsentExplicit: true, onSiteAskEligible: true, keepConsentStamp: true })).toBe('written');
    expect(writes.updates[0].service_contacts_consent_at).toBeInstanceOf(Date);
    expect(writes.updates[0].service_preferences.sql).toContain('unconsented_slot_phone_keys');
  });

  test('a re-added phone that already confirmed its own opt-in keeps its consent: the stamp stays and it is NOT held', async () => {
    const writes = makeDb({
      customer: { ...bareCustomer, service_contact_name: 'Property Manager', service_contact_phone: '+19415557777', service_contacts_consent_at: '2026-07-22T00:00:00Z' },
    });
    expect(await persistCallSecondaryContact('cust-1', { ...buyer, role: 'spouse_partner', on_site: true }, { onSiteAskEligible: true, keepConsentStamp: true, holdPhone: false })).toBe('written');
    expect(writes.updates[0]).not.toHaveProperty('service_contacts_consent_at');
    expect(writes.updates[0]).not.toHaveProperty('service_preferences');
  });

  test('no explicit SMS consent on the call -> slot written WITHOUT a consent stamp (#2955 r2)', async () => {
    const writes = makeDb({ customer: bareCustomer });
    expect(await persistCallSecondaryContact('cust-1', buyer)).toBe('written');
    expect(writes.updates).toEqual([{
      service_contact_name: 'Joseph Haught',
      service_contact_phone: '+19542901693',
      service_contact_email: 'joseph.haught89431@gmail.com',
      service_contact_role: 'home_buyer',
    }]);
  });

  test('an on-site contact with no notification ask is still saved (unstamped) so the opt-in ask can reach them', async () => {
    const writes = makeDb({ customer: bareCustomer });
    expect(await persistCallSecondaryContact('cust-1', { ...buyer, role: 'spouse_partner', wants_notifications: false, on_site: true }, { onSiteAskEligible: true })).toBe('written');
    expect(writes.updates[0].service_contacts_consent_at).toBeUndefined();
    // Nobody asked for notifications to them: the phone is filed, the email is not.
    expect(writes.updates[0].service_contact_email).toBeNull();
    expect(writes.updates[0].service_contact_phone).toBe(buyer.phone);
    // The ask cannot go out (do-not-contact / dark rail → not eligible): no write.
    const writesDark = makeDb({ customer: bareCustomer });
    expect(await persistCallSecondaryContact('cust-1', { ...buyer, role: 'spouse_partner', wants_notifications: false, on_site: true })).toBe('skipped_no_intent');
    expect(writesDark.updates).toHaveLength(0);
    // A non-on-site role with on_site=true is not an ask trigger: no write.
    const writes2 = makeDb({ customer: bareCustomer });
    expect(await persistCallSecondaryContact('cust-1', { ...buyer, role: 'real_estate_agent', wants_notifications: false, on_site: true }, { onSiteAskEligible: true })).toBe('skipped_no_intent');
    expect(writes2.updates).toHaveLength(0);
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
    // Slot match with an EMPTY role column: identity is a no-op, but the
    // role the call just identified backfills onto the matched slot (codex
    // round-8 P2) — otherwise household-role matching can never link this
    // stored contact's future calls.
    const writes2 = makeDb({ customer: { ...bareCustomer, service_contact2_phone: '(954) 290-1693' } });
    expect(await persistCallSecondaryContact('cust-1', buyer)).toBe('skipped_phone_on_record_role_backfilled');
    // Slot match with a role already recorded stays a full no-op.
    const writes3 = makeDb({ customer: { ...bareCustomer, service_contact2_phone: '(954) 290-1693', service_contact2_role: 'tenant' } });
    expect(await persistCallSecondaryContact('cust-1', buyer)).toBe('skipped_phone_on_record');
    expect(writes.updates).toHaveLength(0);
    expect(writes2.updates).toEqual([{ service_contact2_role: 'home_buyer' }]);
    expect(writes3.updates).toHaveLength(0);
  });

  test('a service-contact slot email satisfies the appointment email requirement (post-scrub bookability)', () => {
    // The chimera scrub clears the buyer's email off the caller's fields; the
    // gated persistence writes it into a slot BEFORE the appointment gate —
    // the gate must accept it or the exact realtor-books-for-buyer call this
    // feature targets is skipped as missing_required_customer_fields.
    const base = {
      first_name: 'Melissa', last_name: 'Realtor', phone: '+14074933469',
      email: null, address_line1: '11530 Water Poppy Ter', city: 'Lakewood Ranch', state: 'FL', zip: '34202',
    };
    // Email moved from REQUIRED to ADVISORY on 2026-07-31 (owner ruling): a
    // booking is never held for a missing email, so this now asserts the
    // slot email satisfies the CAPTURE check (clears the advisory) rather
    // than clearing a block. `missing` stays empty either way.
    const noSlot = validatePhoneCallAppointmentCustomer(base, {}, '+14074933469');
    expect(noSlot.advisory).toContain('email');
    expect(noSlot.missing).not.toContain('email');
    const withSlot = validatePhoneCallAppointmentCustomer({ ...base, service_contact_email: 'joseph.haught89431@gmail.com' }, {}, '+14074933469');
    expect(withSlot.advisory).not.toContain('email');
    expect(withSlot.ok).toBe(true);
  });

  test('PERSISTED-OR-REVIEW: an email that exists only in the extraction never satisfies the capture check', () => {
    // appointment-email's recipient resolver reads STORED addresses only
    // (customer.email + service-contact slots). The gated persistence runs
    // BEFORE this gate on a freshly re-read customer row, so a successfully
    // stored secondary email passes via slotEmail (test above). When it was
    // NOT stored — GATE_CALL_SECONDARY_CONTACT off, slots full, race, or a
    // persistCallSecondaryContact skip — the address is treated as NOT
    // captured.
    //
    // Since 2026-07-31 that raises the `email` ADVISORY (office collects it
    // on the confirmation touch) instead of holding the booking — the owner
    // ruled a call that agreed a time must book. PERSISTED-OR-REVIEW still
    // decides WHICH emails count; it just no longer gates the appointment.
    const base = {
      first_name: 'Melissa', last_name: 'Realtor', phone: '+14074933469',
      email: null, address_line1: '11530 Water Poppy Ter', city: 'Lakewood Ranch', state: 'FL', zip: '34202',
    };
    // Notification-intent buyer captured in the extraction but never stored:
    const res = validatePhoneCallAppointmentCustomer(base, {
      secondary_contact: { first_name: 'Joseph', last_name: 'Haught', email: 'joseph.haught89431@gmail.com', role: 'home_buyer', wants_notifications: true },
    }, '+14074933469');
    expect(res.advisory).toContain('email');
    expect(res.missing).not.toContain('email');
    expect(res.ok).toBe(true); // books; the office collects the email
    // Access contact without intent — same advisory.
    const resAccess = validatePhoneCallAppointmentCustomer(base, {
      secondary_contact: { first_name: 'Rigo', email: 'rigo@example.com', role: 'home_seller', wants_notifications: false, notes: 'access contact' },
    }, '+14074933469');
    expect(resAccess.advisory).toContain('email');
    expect(resAccess.ok).toBe(true);
  });

  test('lender is an agent-type slot role: a slot-phone hit alone never auto-links (serves many buyers)', () => {
    const { slotOnlyLinkAllowed } = require('../services/call-recording-processor')._test;
    const customer = {
      service_contact_phone: '+18777175476', service_contact_name: 'Robert Cozzano',
      service_contact_role: 'lender',
    };
    // Same number, same first name — still blocked: the lender's next call is
    // usually a DIFFERENT buyer's inspection.
    expect(slotOnlyLinkAllowed(customer, '+18777175476', { first_name: 'Robert' })).toBe(false);
    // Household-type role on the same shape still links (control).
    const householdCustomer = { ...customer, service_contact_role: 'tenant' };
    expect(slotOnlyLinkAllowed(householdCustomer, '+18777175476', { first_name: 'Robert' })).toBe(true);
  });

  test('a name-only placeholder slot never carried notifications: prefs are still set, and the placeholder is not overwritten', async () => {
    const writes = makeDb({ customer: { ...bareCustomer, service_contact_name: 'Gate guard (placeholder)' } });
    expect(await persistCallSecondaryContact('cust-1', buyer)).toBe('written');
    // Slot 1 has content (name) — never overwritten; write lands in slot 2.
    expect(Object.keys(writes.updates[0])).toEqual(
      expect.arrayContaining(['service_contact2_name', 'service_contact2_phone', 'service_contact2_email'])
    );
    // But a name-only slot is unreachable (no phone/email), so this is the
    // customer's FIRST reachable contact — notify-primary prefs must be set.
    expect(writes.prefsMerges).toHaveLength(1);
  });

  test('existing PHONE contact: appointment notify-primary is the admin\'s prior choice, but the FIRST slot email still flips the report flag', async () => {
    const writes = makeDb({
      customer: { ...bareCustomer, service_contact_name: 'Property Manager', service_contact_phone: '+19415557777' },
    });
    expect(await persistCallSecondaryContact('cust-1', buyer, { smsConsentExplicit: true })).toBe('written');
    // Slot 1 already held an UNSTAMPED phone contact — the call only spoke
    // for the buyer, so no row-level stamp is minted (#2955 r3).
    expect(writes.updates).toEqual([{
      service_contact2_name: 'Joseph Haught',
      service_contact2_phone: '+19542901693',
      service_contact2_email: 'joseph.haught89431@gmail.com',
      service_contact2_role: 'home_buyer',
    }]);
    // Slot phones already existed → the admin's appointment notify-primary
    // choice stands. No slot EMAIL existed → report emails flip now.
    expect(writes.prefsMerges).toHaveLength(1);
    expect(writes.prefsMerges[0].mergePayload).toEqual({ service_report_notify_primary: true });
  });

  test('existing EMAIL-only contact: first slot PHONE still flips appointment notify-primary', async () => {
    const writes = makeDb({
      customer: { ...bareCustomer, service_contact_name: 'Landlord', service_contact_email: 'landlord@example.com' },
    });
    expect(await persistCallSecondaryContact('cust-1', buyer)).toBe('written');
    // A slot email already existed → the report-email choice stands; the
    // first slot PHONE flips appointment texts.
    expect(writes.prefsMerges).toHaveLength(1);
    expect(writes.prefsMerges[0].mergePayload).toEqual({ appointment_notify_primary: true });
  });

  test('email-only secondary contact: slot written with email, only the report flag flips', async () => {
    const writes = makeDb({ customer: bareCustomer });
    expect(await persistCallSecondaryContact('cust-1', { ...buyer, phone: null })).toBe('written');
    expect(writes.updates).toEqual([{
      service_contact_name: 'Joseph Haught',
      service_contact_phone: null,
      service_contact_email: 'joseph.haught89431@gmail.com',
      service_contact_role: 'home_buyer',
    }]);
    expect(writes.prefsMerges).toHaveLength(1);
    expect(writes.prefsMerges[0].mergePayload).toEqual({ service_report_notify_primary: true });
  });

  test('all three slots occupied → no-op', async () => {
    const full = { ...bareCustomer };
    for (const slot of SERVICE_CONTACT_SLOTS) full[slot.phone] = '+1941555000' + SERVICE_CONTACT_SLOTS.indexOf(slot);
    const writes = makeDb({ customer: full });
    expect(await persistCallSecondaryContact('cust-1', buyer)).toBe('skipped_slots_full');
    expect(writes.updates).toHaveLength(0);
  });

  test('a secondary phone that belongs to a DIFFERENT customer is never slotted (cross-account SMS guard)', async () => {
    const writes = makeDb({ customer: bareCustomer, otherCustomer: { id: 'cust-2' } });
    expect(await persistCallSecondaryContact('cust-1', buyer)).toBe('skipped_phone_belongs_to_other_customer');
    expect(writes.updates).toHaveLength(0);
    expect(writes.prefsMerges).toHaveLength(0);
  });

  test('a default-FALSE prefs row still flips notify-primary on the first slot contact (codex P1)', async () => {
    // Prefs rows default both columns to false (call-created customers insert
    // one moments before persistence) — a "preserve existing false" guard
    // would leave the caller cut out of the updates they asked for.
    const writes = makeDb({
      customer: bareCustomer,
      prefs: { customer_id: 'cust-1', appointment_notify_primary: false, service_report_notify_primary: false },
    });
    expect(await persistCallSecondaryContact('cust-1', buyer)).toBe('written');
    expect(writes.prefsMerges).toHaveLength(1);
    expect(writes.prefsMerges[0].mergePayload).toEqual({ appointment_notify_primary: true, service_report_notify_primary: true });
  });

  test('email-only contact dedups against emails on record', async () => {
    const writes = makeDb({ customer: { ...bareCustomer, email: 'JOSEPH.HAUGHT89431@gmail.com' } });
    expect(await persistCallSecondaryContact('cust-1', { ...buyer, phone: null })).toBe('skipped_email_on_record');
    expect(writes.updates).toHaveLength(0);
  });
});

// ─── on-site contact: the pipeline only SENDS THE ASK (owner redesign 2026-10-01).
// Consent comes only from the recipient's own YES (recipient-optin.js).

describe('on-site contact opt-in ask', () => {
  const spouse = {
    first_name: 'Sample', last_name: 'Spouse', phone: '+15550100123', role: 'spouse_partner',
    wants_notifications: true, wants_appointment_texts: true, on_site: false,
  };

  test('trigger = on-site role AND (wants_appointment_texts OR on_site) AND a phone', () => {
    // home_seller: the seller who meets the technician (WDO / access visits).
    for (const role of ['spouse_partner', 'home_buyer', 'home_seller', 'tenant', 'family_member']) {
      expect(onSiteOptinAskTrigger({ ...spouse, role })).toBe(true);
    }
    expect(onSiteOptinAskTrigger({ ...spouse, wants_appointment_texts: false, on_site: true })).toBe(true);
    for (const role of ['landlord', 'lender', 'real_estate_agent', 'property_manager', 'other', 'unknown', null]) {
      expect(onSiteOptinAskTrigger({ ...spouse, role })).toBe(false);
    }
    expect(onSiteOptinAskTrigger({ ...spouse, wants_appointment_texts: false, on_site: false })).toBe(false);
    // wants_notifications alone (report / invoice emails) never triggers.
    expect(onSiteOptinAskTrigger({ ...spouse, wants_appointment_texts: false })).toBe(false);
    expect(onSiteOptinAskTrigger({ ...spouse, phone: null })).toBe(false);
    expect(onSiteOptinAskTrigger(null)).toBe(false);
  });

  test('ask sent / not sent per gate (reasons feed the review card)', () => {
    const live = { optinRailLive: true, persistResult: 'written' };
    expect(decideOnSiteOptinAsk(spouse, live)).toEqual({ ask: true, reason: null });
    // A phone filed by an earlier pass is asked too (a retry never leaves them unasked).
    expect(decideOnSiteOptinAsk(spouse, { ...live, persistResult: 'skipped_phone_on_record' }).ask).toBe(true);
    expect(decideOnSiteOptinAsk(spouse, { ...live, persistResult: 'skipped_phone_on_record_role_backfilled' }).ask).toBe(true);
    // Gates.
    expect(decideOnSiteOptinAsk({ ...spouse, role: 'lender' }, live)).toEqual({ ask: false, reason: 'not_on_site_contact' });
    expect(decideOnSiteOptinAsk(spouse, { ...live, doNotContact: true })).toEqual({ ask: false, reason: 'do_not_contact' });
    expect(decideOnSiteOptinAsk(spouse, { ...live, optinRailLive: false })).toEqual({ ask: false, reason: 'optin_rail_dark' });
    expect(decideOnSiteOptinAsk(spouse, { ...live, persistResult: 'skipped_phone_belongs_to_other_customer' })).toEqual({ ask: false, reason: 'slot_not_saved' });
    expect(decideOnSiteOptinAsk(spouse, { ...live, persistResult: 'skipped_slots_full' }).ask).toBe(false);
  });

  test('the pipeline NEVER stamps consent from the on-site rule: the slot is written unstamped without V2 explicit consent', async () => {
    const db2 = require('../models/db');
    const updates = [];
    db2.mockImplementation((table) => {
      if (table === 'customers') {
        let collision = false;
        const b = {
          where: jest.fn((arg) => { if (typeof arg === 'function') { const sub = { whereNull: () => sub, orWhere: () => sub }; arg(sub); } return b; }),
          whereNull: jest.fn(() => b),
          whereNot: jest.fn(() => b),
          whereRaw: jest.fn(() => { collision = true; return b; }),
          first: jest.fn(async () => (collision ? null : {
            id: 'cust-1', phone: '+15550100999', email: null,
            service_contact_name: null, service_contact_phone: null, service_contact_email: null,
            service_contact2_name: null, service_contact2_phone: null, service_contact2_email: null,
            service_contact3_name: null, service_contact3_phone: null, service_contact3_email: null,
          })),
          update: jest.fn(async (p) => { updates.push(p); return 1; }),
        };
        return b;
      }
      if (table === 'notification_prefs') {
        const b = { where: () => b, first: async () => undefined, insert: () => ({ onConflict: () => ({ merge: async () => 1 }) }) };
        return b;
      }
      throw new Error(`unexpected table ${table}`);
    });
    const wanted = { ...spouse, on_site: true };
    expect(await persistCallSecondaryContact('cust-1', wanted, { smsConsentExplicit: false })).toBe('written');
    expect(updates[0]).toMatchObject({ service_contact_phone: '+15550100123', service_contact_role: 'spouse_partner' });
    for (const key of ['service_contacts_consent_at', 'service_contacts_consent_source', 'service_contacts_consent_text_version']) {
      expect(updates[0]).not.toHaveProperty(key);
    }
    // And the source never names the removed on-site stamp source.
    const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    expect(src).not.toContain('call_pipeline_onsite_contact');
    expect(src).not.toContain('consent_upgraded_phone_on_record');
    expect(src).not.toContain('written_consent_withheld');
    expect(src).not.toContain('beforeStamp');
    expect(src).not.toContain('phoneWithheld');
  });

  test('the loop only QUEUES the on-site ask (awaiting_booking); explicit consent keeps its own claim path', () => {
    const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    expect(src).toContain('decideOnSiteOptinAsk(secondaryEntry, { doNotContact: v2DoNotContact, optinRailLive, persistResult: result })');
    expect(src).toContain('pendingOnSiteAsks.push({ entry: secondaryEntry });');
    expect(src).toContain("const optinAskState = onSiteDecision.ask ? 'awaiting_booking' : `not_sent:${onSiteDecision.reason}`;");
    expect(src).toContain('JSON.stringify({ optin_ask: value })');
    // The save only admits an on-site-only contact when the ask can go out.
    expect(src).toContain('onSiteAskEligible: onSitePreAsk,');
    // Either extractor's do-not-contact request blocks the ask.
    expect(src).toMatch(/const v2DoNotContact = v2CanonicalExtraction\?\.consent\?\.do_not_contact_request === true\s*\|\| extracted\.do_not_contact_request === true;/);
    // Explicit V2 consent keeps the original claim path (fresh slot only).
    // ...but never for an entry queued for the booking site; that phone is also
    // kept out of the same-call fan-out until it has an opt-in row.
    expect(src).toContain("if (result === 'written' && secondaryEntry?.phone && v2SmsConsentExplicit && !onSiteDecision.ask && !v2DoNotContact) {");
    expect(src).toContain('if (!onSiteAlreadyConfirmed) optinClaimFailedPhones.add(lastTen(secondaryEntry.phone));');
    // A re-added phone that already confirmed here gets the account stamp back.
    expect(src).toContain("await require('./recipient-optin').restoreConfirmedPhone(customerId, lastTen(secondaryEntry.phone));");
    // A phone NEW to the account is durably blocked (ask_failed, reclaimable)
    // BEFORE the slot write, so the account's existing consent stamp stays; a
    // phone already on record is left alone.
    expect(src).toContain('if (newKey && !knownKeys.includes(newKey)) {');
    expect(src).toContain('keepConsentStamp: onSiteBlockedBeforeWrite,');
    // A phone that already confirmed on this account is not held again.
    expect(src).toContain('holdPhone: onSiteBlockedBeforeWrite && !onSiteAlreadyConfirmed,');
    // The confirmed-status read runs for every on-site phone, on record or new.
    const pre = src.slice(src.indexOf('if (newKey && !knownKeys.includes(newKey)) {'));
    expect(pre.indexOf("onSiteAlreadyConfirmed = existing?.status === 'confirmed';")).toBeGreaterThan(pre.indexOf('onSiteBlockedBeforeWrite = true;\n          }'));
    const block = src.indexOf('if (newKey && !knownKeys.includes(newKey)) {');
    expect(block).toBeLessThan(src.indexOf('const result = await persistCallSecondaryContact(customerId, secondaryEntry, {', block));
    // The same-call fan-out gate is the original one.
    expect(src).toContain('const extraContacts = !v2SmsConsentExplicit ? [] : (await filterRecipientsByOptin(');
    // No booking landed: the card says so.
    expect(src).toContain("for (const { entry } of pendingOnSiteAsks) await markOptinAsk(entry, 'not_sent:no_booking');");
  });

  test('the booking site sends the on-site ask only once a confirmed visit landed: claim with the VISIT address and id, dispatch outcome on the card', () => {
    const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    const landed = src.indexOf('scheduledServiceId = svc.id;');
    // Runs AFTER any reuse activation, never for a street-level hold or an
    // address-disputed visit, and only for a confirmed, live, future visit.
    const activation = src.indexOf(".activateLegacyOutboundReviewRowIfNeeded(db, svc.id, 'call-proc-reuse');", landed);
    const site = src.indexOf("if (onSiteAskVisitState !== 'dead') {", landed);
    expect(site).toBeGreaterThan(activation);
    expect(activation).toBeGreaterThan(landed);
    const gate = src.slice(src.lastIndexOf('const onSiteAskVisitState', site), site);
    expect(gate).toContain('!disputeHeldReuse && houseNumberDisputed !== true');
    expect(gate).toContain('!(await isStreetLevelHoldRow(db, svc))');
    expect(gate).toContain(".where({ id: svc.id, status: 'confirmed' })");
    expect(gate).toContain("q.whereNull('customer_confirmed').orWhere('customer_confirmed', true)");
    // The canonical customer-promised arrival, still ahead.
    expect(gate).toContain("scheduledServiceApptTime(svc.id, { throwOnError: true })");
    expect(gate).toContain("return at?.getTime() > Date.now() ? 'live' : 'dead';");
    // An unreadable visit is NOT read as gone: the ask is claimed (visit-bound)
    // but not dispatched, so the recovery sweep re-checks the same visit.
    expect(gate).toContain("})().catch(() => 'unknown')");
    const block = src.slice(site, site + 6000);
    // The ask quotes the booked visit's address.
    expect(block).toContain("const visitAddress = [svc.service_address_line1, svc.service_address_city].filter(Boolean).join(', ');");
    expect(block).toContain('propertyAddress: visitAddress ||');
    // The visit rides the claim (a send-window-deferred ask is re-checked against it).
    expect(block).toContain('visitId: svc.id,');
    expect(block).toContain("if (claims.length && onSiteAskVisitState === 'unknown') {");
    expect(block).toContain("await markOptinAsk(entry, 'not_sent:visit_check_retry');");
    expect(block).toContain("const requested = typeof outcome === 'number' ? outcome : Number(outcome?.requested || 0);");
    expect(block).toContain("return markOptinAsk(entry, requested > 0 ? 'sent' : 'not_sent:dispatch_failed');");
    // No caller demotion and no booking marker in this PR (owner split 10-01).
    expect(src).not.toContain('appointment_notify_primary: false');
    expect(src).not.toContain('demote_primary_on_optin');
    // The persistence loop no longer claims for the on-site path.
    expect(src).not.toContain('(askedViaOnSite && secondaryEntry?.phone)');
  });
});

describe('on-site flags through the V1/V2 resolution', () => {
  const entry = (flags = {}) => ({
    name_full: 'Sample Spouse', first_name: 'Sample', last_name: 'Spouse', phone_e164: '+15550100123', email: null,
    role: 'spouse_partner', wants_notifications: true, ...flags,
  });
  const { normalizeSecondaryContact: normalizeV1 } = require('../utils/intake-normalize');

  test('a rejected V2 identity is excluded by its CANONICAL form: name-only singleton + mirror carrying a different phone than V1 never becomes a second contact', () => {
    // V1 caught only the phone (no name), so name-based dedupe cannot hide a resurrected mirror.
    const v1 = { secondary_contact: { first_name: null, last_name: null, phone: '+15550100777', role: 'spouse_partner', wants_notifications: true } };
    const v2 = {
      secondary_contact: entry({ phone_e164: null }),
      secondary_contacts: [entry({ phone_e164: '+15550100123', on_site: true })],
    };
    const list = resolveCallSecondaryContacts(v1, v2);
    expect(list).toHaveLength(1);
    expect(list[0].phone).toBe('+15550100777');
  });

  test('mapper: strict booleans, false when absent', () => {
    expect(mapSecondaryContactToLegacy(entry())).toMatchObject({ wants_appointment_texts: false, on_site: false });
    expect(mapSecondaryContactToLegacy(entry({ wants_appointment_texts: true, on_site: true }))).toMatchObject({ wants_appointment_texts: true, on_site: true });
    expect(mapSecondaryContactToLegacy(entry({ on_site: 'yes' })).on_site).toBe(false);
  });

  test('V1 does not extract the flags (no V1 plumbing): a V1 contact never carries them', () => {
    const v1 = normalizeV1({ first_name: 'Sample', phone: '+15550100123', role: 'spouse_partner', wants_notifications: true, wants_appointment_texts: true, on_site: true });
    expect(v1).not.toHaveProperty('wants_appointment_texts');
    expect(v1).not.toHaveProperty('on_site');
    const merged = resolveCallSecondaryContact({ secondary_contact: v1 }, { secondary_contact: entry() });
    expect(onSiteOptinAskTrigger(merged)).toBe(false);
  });

  test('V2 flags carry on V2\'s own phone or a same person — never onto V1\'s different phone; bound to V2\'s own role', () => {
    const v2 = { secondary_contact: entry({ wants_appointment_texts: true }) };
    // V1 name-only, V2 supplies the phone: V2's own phone carries V2's flag.
    const v1NameOnly = normalizeV1({ first_name: 'Sample', last_name: 'Spouse', role: 'spouse_partner', wants_notifications: true });
    expect(onSiteOptinAskTrigger(resolveCallSecondaryContact({ secondary_contact: v1NameOnly }, v2))).toBe(true);
    // V1 has its OWN different-identity phone-only contact: V2's flag must not attach to V1's number.
    const v1PhoneOnly = normalizeV1({ phone: '+15550100777', role: 'spouse_partner', wants_notifications: true });
    const v2NameOnly = { secondary_contact: { ...entry({ wants_appointment_texts: true }), phone_e164: null } };
    const merged = resolveCallSecondaryContact({ secondary_contact: v1PhoneOnly }, v2NameOnly);
    expect(merged.phone).toBe('+15550100777');
    expect(onSiteOptinAskTrigger(merged)).toBe(false);
    // Conflicting identities: V1 wins unmerged, V2's flags never arrive.
    expect(onSiteOptinAskTrigger(resolveCallSecondaryContact({ secondary_contact: v1PhoneOnly }, v2))).toBe(false);
    // V2's own lender role never pairs with the flags (merged role from V1 is spouse, V2 says lender).
    const v1Spouse = normalizeV1({ first_name: 'Sample', last_name: 'Spouse', role: 'spouse_partner', wants_notifications: true });
    const lenderV2 = { secondary_contact: entry({ wants_appointment_texts: true, role: 'lender' }) };
    expect(onSiteOptinAskTrigger(resolveCallSecondaryContact({ secondary_contact: v1Spouse }, lenderV2))).toBe(false);
  });

  test('singleton + same-person array[0]: flags from either shape count (OR); a different person never lends flags', () => {
    const v2 = { secondary_contact: entry(), secondary_contacts: [entry({ wants_appointment_texts: true, on_site: true })] };
    expect(canonicalV2Secondary(v2)).toMatchObject({ wants_appointment_texts: true, on_site: true });
    expect(onSiteOptinAskTrigger(resolveCallSecondaryContact({}, v2))).toBe(true);
    expect(resolveCallSecondaryContacts({}, v2)).toHaveLength(1);
    const other = { ...entry({ wants_appointment_texts: true, on_site: true }), name_full: 'Other Tenant', first_name: 'Other', last_name: 'Tenant', phone_e164: '+15550100888' };
    expect(onSiteOptinAskTrigger(resolveCallSecondaryContact({}, { secondary_contact: entry(), secondary_contacts: [other] }))).toBe(false);
  });

  test('entries 2+ (V2 array only) keep their own flags', () => {
    const second = { ...entry({ wants_appointment_texts: true }), name_full: 'Sample Tenant', first_name: 'Sample', last_name: 'Tenant', phone_e164: '+15550100888', role: 'tenant' };
    const list = resolveCallSecondaryContacts({}, { secondary_contact: entry(), secondary_contacts: [entry(), second] });
    expect(list).toHaveLength(2);
    expect(onSiteOptinAskTrigger(list[0])).toBe(false);
    expect(onSiteOptinAskTrigger(list[1])).toBe(true);
  });

  test('the V2 normalizer keeps strict booleans', () => {
    expect(normalizeSecondaryContactV2(entry())).toMatchObject({ wants_appointment_texts: false, on_site: false });
    expect(normalizeSecondaryContactV2(entry({ wants_appointment_texts: true, on_site: true }))).toMatchObject({ wants_appointment_texts: true, on_site: true });
    expect(normalizeSecondaryContactV2(entry({ wants_appointment_texts: 'true', on_site: 1 }))).toMatchObject({ wants_appointment_texts: false, on_site: false });
  });
});

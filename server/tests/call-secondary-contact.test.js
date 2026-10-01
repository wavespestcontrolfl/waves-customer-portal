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
  onSiteNotifyConsent,
  verifyOnSiteGrounding,
  resolveSecondaryConsent,
  orderSecondaryEntriesForPersistence,
  validatePhoneCallAppointmentCustomer,
} = _test;
const { flatView, mapSecondaryContactToLegacy, mapSecondaryContactsToLegacy } = require('../utils/extraction-compat');
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
      wants_appointment_texts: false,
      on_site: false,
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
      wants_appointment_texts_quote: null,
      on_site_quote: null,
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
      wants_appointment_texts_quote: null,
      on_site_quote: null,
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

  test('current SCHEMA_VERSION is 1.21.0', () => {
    expect(SCHEMA_VERSION).toBe('1.21.0');
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

  test('1.21.0: wants_appointment_texts / on_site are optional booleans in both schemas, non-boolean rejected', () => {
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
    // Non-boolean fails both schemas (additionalProperties stays false elsewhere).
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

  test('persist never writes the caller opt-out; it only REPORTS eligibility once the slot commits (booking may not land)', async () => {
    const spouseContact = { first_name: 'Sample', last_name: 'Spouse', phone: '+15550100123', role: 'spouse_partner', wants_notifications: true };
    const grounded = { smsConsentExplicit: true, smsConsentSource: 'call_pipeline_onsite_contact', onSiteGrounded: true };
    // 0-row slot race: not eligible, nothing written.
    let eligible = 0;
    const fire = () => { eligible += 1; };
    const raced = makeDb({ customer: bareCustomer, updateRows: 0 });
    expect(await persistCallSecondaryContact('cust-1', spouseContact, { ...grounded, onPrimaryOptOutEligible: fire })).toBe('skipped_slot_race');
    expect(eligible).toBe(0);
    // Landed: eligible, and the caller KEEPS the default TRUE flip (no false is ever written here).
    const landed = makeDb({ customer: bareCustomer });
    expect(await persistCallSecondaryContact('cust-1', spouseContact, { ...grounded, onPrimaryOptOutEligible: fire })).toBe('written');
    expect(eligible).toBe(1);
    expect(landed.prefsMerges.map((m) => m.mergePayload)).toEqual([{ appointment_notify_primary: true }]);
    // Not grounded on-site (even with the on-site SOURCE): never eligible.
    makeDb({ customer: bareCustomer });
    await persistCallSecondaryContact('cust-1', spouseContact, { ...grounded, onSiteGrounded: false, onPrimaryOptOutEligible: fire });
    expect(eligible).toBe(1);
    // Not the FIRST slot phone: never eligible.
    makeDb({ customer: { ...bareCustomer, service_contact_name: 'Other', service_contact_phone: '+15550100777', service_contacts_consent_at: '2026-07-22T00:00:00Z' } });
    await persistCallSecondaryContact('cust-1', spouseContact, { ...grounded, onPrimaryOptOutEligible: fire });
    expect(eligible).toBe(1);
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
      // Stamped row: the attestation's source and text version are KEPT (not
      // in the write); only the timestamp refreshes.
      service_contacts_consent_at: expect.any(Date),
    }]);
    expect(writes.updates[0]).not.toHaveProperty('service_contacts_consent_source');
    expect(writes.updates[0]).not.toHaveProperty('service_contacts_consent_text_version');
  });

  test('unconsented phone never joins a STAMPED row — phone withheld, stamp kept (#5467; supersedes codex r5 on #2948)', async () => {
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
      // The stamp describes only consented phones, so this one stays OFF
      // the slot (review card keeps it); the stamp is not touched.
      service_contact2_phone: null,
      service_contact2_email: 'joseph.haught89431@gmail.com',
      service_contact2_role: 'home_buyer',
    }]);
  });

  test('withheld-phone contact dedupes on email, then on name — a reprocess never fills a second slot', async () => {
    const stamped = { ...bareCustomer, service_contact_name: 'Sample Lender', service_contact_phone: '+19415557777', service_contacts_consent_at: '2026-07-22T00:00:00Z' };
    // Name-only (phone withheld, no email) and the name is already on a slot.
    const w1 = makeDb({ customer: stamped });
    expect(await persistCallSecondaryContact('cust-1', { first_name: 'sample', last_name: 'LENDER', phone: '+15550100444', wants_notifications: true, role: 'lender' }))
      .toBe('skipped_name_on_record_phone_withheld');
    expect(w1.updates).toEqual([]);
    // Email on record + phone withheld → the email-dedupe skip, not a new slot.
    const w2 = makeDb({ customer: { ...stamped, service_contact_email: 'lender@example.com' } });
    expect(await persistCallSecondaryContact('cust-1', { first_name: 'Other', last_name: 'Name', email: 'LENDER@example.com', phone: '+15550100444', wants_notifications: true, role: 'lender' }))
      .toMatch(/^skipped_email_on_record/); // role backfill on the matched slot is fine
    expect(w2.updates.some((u) => Object.keys(u).some((k) => /phone|_name$/.test(k)))).toBe(false);
  });

  test('unconsented phone-only contact on a STAMPED row is skipped outright', async () => {
    const writes = makeDb({
      customer: { ...bareCustomer, service_contact_phone: '+19415557777', service_contacts_consent_at: '2026-07-22T00:00:00Z' },
    });
    expect(await persistCallSecondaryContact('cust-1', { phone: '+15550100444', wants_notifications: true, role: 'lender' })).toBe('skipped_phone_withheld_unconsented');
    expect(writes.updates).toEqual([]);
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
    // Consented phone landed but the account-wide stamp is omitted (the
    // unstamped row already holds another phone): the distinct status says so.
    expect(await persistCallSecondaryContact('cust-1', buyer, { smsConsentExplicit: true })).toBe('written_consent_withheld');
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

// ─── on-site contact consent (owner ruling 2026-09-30) ─────────────────────

describe('on-site contact is the appointment contact point', () => {
  const spouse = {
    first_name: 'Sample', last_name: 'Spouse', phone: '+15550100123',
    email: 'sample@example.com', role: 'spouse_partner',
    wants_notifications: true, wants_appointment_texts: true, on_site: true, notes: null,
  };

  describe('onSiteNotifyConsent', () => {
    test.each(['spouse_partner', 'home_buyer', 'tenant', 'family_member'])('%s with appointment-text intent + on-site + phone qualifies', (role) => {
      expect(onSiteNotifyConsent({ ...spouse, role })).toBe(true);
    });
    test.each(['home_seller', 'landlord', 'lender', 'real_estate_agent', 'property_manager', 'other', 'unknown', null])('%s never qualifies', (role) => {
      expect(onSiteNotifyConsent({ ...spouse, role })).toBe(false);
    });
    test('requires wants_appointment_texts === true, on_site === true and a phone', () => {
      expect(onSiteNotifyConsent({ ...spouse, wants_appointment_texts: false })).toBe(false);
      expect(onSiteNotifyConsent({ ...spouse, wants_appointment_texts: undefined })).toBe(false);
      expect(onSiteNotifyConsent({ ...spouse, on_site: false })).toBe(false);
      expect(onSiteNotifyConsent({ ...spouse, on_site: undefined })).toBe(false);
      expect(onSiteNotifyConsent({ ...spouse, phone: null })).toBe(false);
      expect(onSiteNotifyConsent({ ...spouse, phone: '  ' })).toBe(false);
      expect(onSiteNotifyConsent(null)).toBe(false);
    });
    test('email/report-only intent never qualifies: wants_notifications is channel-neutral (codex P1)', () => {
      // "Email him the report" sets wants_notifications true but NOT
      // wants_appointment_texts, even with a phone on file and an on-site role.
      const reportOnly = { ...spouse, wants_notifications: true, wants_appointment_texts: false };
      expect(onSiteNotifyConsent(reportOnly)).toBe(false);
      // wants_notifications alone (no V1 grounding fields — e.g. a V2 contact) fails closed.
      const { wants_appointment_texts, on_site, ...v2Shaped } = spouse;
      expect(onSiteNotifyConsent(v2Shaped)).toBe(false);
      // The rule no longer depends on wants_notifications itself.
      expect(onSiteNotifyConsent({ ...spouse, wants_notifications: false })).toBe(true);
    });
    test('role match is case-insensitive', () => {
      expect(onSiteNotifyConsent({ ...spouse, role: ' Spouse_Partner ' })).toBe(true);
    });
  });

  const bare = {
    id: 'cust-1', phone: '+15550100999', email: null,
    service_contact_name: null, service_contact_phone: null, service_contact_email: null,
    service_contact2_name: null, service_contact2_phone: null, service_contact2_email: null,
    service_contact3_name: null, service_contact3_phone: null, service_contact3_email: null,
  };

  // Same db stub shape as the persistence suite above, trimmed to what the
  // slot write touches.
  function stubDb(customer) {
    const updates = [];
    db.mockImplementation((table) => {
      if (table === 'customers') {
        let isCollisionQuery = false;
        const b = {
          where: jest.fn((arg) => {
            if (typeof arg === 'function') {
              const sub = { whereNull: jest.fn(() => sub), orWhere: jest.fn(() => sub) };
              arg(sub);
            }
            return b;
          }),
          whereNull: jest.fn(() => b),
          whereNot: jest.fn(() => b),
          whereRaw: jest.fn(() => { isCollisionQuery = true; return b; }),
          first: jest.fn(async () => (isCollisionQuery ? null : customer)),
          update: jest.fn(async (payload) => { updates.push(payload); return 1; }),
        };
        return b;
      }
      if (table === 'notification_prefs') {
        const b = {
          where: jest.fn(() => b),
          first: jest.fn(async () => undefined),
          insert: jest.fn(() => ({ onConflict: jest.fn(() => ({ merge: jest.fn(async () => 1) })) })),
        };
        return b;
      }
      throw new Error(`unexpected table ${table}`);
    });
    return updates;
  }

  // Mirrors the processor's persistence loop: resolve the per-contact consent,
  // then hand it to the writer.
  async function persistLikeLoop(contact, v2SmsConsentExplicit) {
    const { smsConsentExplicit, smsConsentSource } = resolveSecondaryConsent(contact, v2SmsConsentExplicit);
    return persistCallSecondaryContact('cust-1', contact, { smsConsentExplicit, smsConsentSource });
  }

  test('(a) spouse + appointment-text intent + on-site + phone stamps source call_pipeline_onsite_contact even with V2 consent false', async () => {
    const updates = stubDb(bare);
    expect(await persistLikeLoop(spouse, false)).toBe('written');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      service_contacts_consent_at: expect.any(Date),
      service_contacts_consent_source: 'call_pipeline_onsite_contact',
      service_contacts_consent_text_version: 'call-2026-07-23',
      service_contact_role: 'spouse_partner',
    });
  });

  test.each(['lender', 'real_estate_agent'])('(b) role %s with every grounded field and V2 consent false writes NO stamp', async (role) => {
    const updates = stubDb(bare);
    expect(await persistLikeLoop({ ...spouse, role }, false)).toBe('written');
    expect(updates[0]).not.toHaveProperty('service_contacts_consent_at');
    expect(updates[0]).not.toHaveProperty('service_contacts_consent_source');
  });

  test('(c2) report-only intent (wants_notifications true, no appointment-text intent) slots the contact but writes NO stamp', async () => {
    const updates = stubDb(bare);
    expect(await persistLikeLoop({ ...spouse, wants_appointment_texts: false }, false)).toBe('written');
    expect(updates[0]).not.toHaveProperty('service_contacts_consent_at');
    expect(updates[0]).not.toHaveProperty('service_contacts_consent_source');
  });

  test('(c3) appointment-text intent but NOT on site -> slotted, NO stamp', async () => {
    const updates = stubDb(bare);
    expect(await persistLikeLoop({ ...spouse, on_site: false }, false)).toBe('written');
    expect(updates[0]).not.toHaveProperty('service_contacts_consent_at');
  });

  test('(c) spouse WITHOUT notification intent is not slotted and not stamped', async () => {
    const updates = stubDb(bare);
    expect(await persistLikeLoop({ ...spouse, wants_notifications: false }, false)).toBe('skipped_no_intent');
    expect(updates).toHaveLength(0);
  });

  test('(d) explicit V2 consent keeps source call_pipeline_request, even for an on-site role', async () => {
    const updates = stubDb(bare);
    expect(await persistLikeLoop(spouse, true)).toBe('written');
    expect(updates[0].service_contacts_consent_source).toBe('call_pipeline_request');
    const updates2 = stubDb(bare);
    expect(await persistLikeLoop({ ...spouse, role: 'real_estate_agent' }, true)).toBe('written');
    expect(updates2[0].service_contacts_consent_source).toBe('call_pipeline_request');
  });

  test('persistCallSecondaryContact defaults the stamp source to call_pipeline_request', async () => {
    const updates = stubDb(bare);
    await persistCallSecondaryContact('cust-1', spouse, { smsConsentExplicit: true });
    expect(updates[0].service_contacts_consent_source).toBe('call_pipeline_request');
  });
});

describe('secondary-contact grounding fields through the compat mappers', () => {
  const { normalizeSecondaryContact: normalizeV1 } = require('../utils/intake-normalize');
  const v2Base = {
    name_full: 'Sample Spouse', first_name: 'Sample', last_name: 'Spouse',
    phone_e164: '+15550100123', email: null, role: 'spouse_partner',
    wants_notifications: true, notes: null,
  };

  test('mapSecondaryContactToLegacy defaults both fields to false when absent (a V2 contact without them fails closed)', () => {
    const mapped = mapSecondaryContactToLegacy(v2Base);
    expect(mapped.wants_appointment_texts).toBe(false);
    expect(mapped.on_site).toBe(false);
    expect(onSiteNotifyConsent(mapped)).toBe(false);
  });

  test('mapSecondaryContactToLegacy passes both fields through when present', () => {
    const mapped = mapSecondaryContactToLegacy({ ...v2Base, wants_appointment_texts: true, on_site: true });
    expect(mapped.wants_appointment_texts).toBe(true);
    expect(mapped.on_site).toBe(true);
    // Only a strict true counts.
    expect(mapSecondaryContactToLegacy({ ...v2Base, on_site: 'yes' }).on_site).toBe(false);
  });

  test('a V2-shaped contact carrying both fields true qualifies through the mapper (schema 1.21.0)', () => {
    const mapped = mapSecondaryContactToLegacy({ ...v2Base, wants_appointment_texts: true, on_site: true });
    expect(onSiteNotifyConsent(mapped)).toBe(true);
    // Report-only V2 contact: wants_notifications true, no appointment-text intent.
    expect(onSiteNotifyConsent(mapSecondaryContactToLegacy({ ...v2Base, wants_appointment_texts: false, on_site: true }))).toBe(false);
    expect(onSiteNotifyConsent(mapSecondaryContactToLegacy({ ...v2Base, wants_appointment_texts: true, on_site: false }))).toBe(false);
  });

  test('V2 normalizer keeps strict booleans and defaults absent/garbled fields to false', () => {
    expect(normalizeSecondaryContactV2(v2Base)).toMatchObject({ wants_appointment_texts: false, on_site: false });
    expect(normalizeSecondaryContactV2({ ...v2Base, wants_appointment_texts: true, on_site: true }))
      .toMatchObject({ wants_appointment_texts: true, on_site: true });
    expect(normalizeSecondaryContactV2({ ...v2Base, wants_appointment_texts: 'true', on_site: 1 }))
      .toMatchObject({ wants_appointment_texts: false, on_site: false });
  });

  test('V2 grounding flags follow the carry rules: own phone or same person, never the other extractor\'s number', () => {
    const v2Flagged = { ...v2Base, wants_appointment_texts: true, on_site: true };
    // V1 has no phone and is name-only (no flags); V2's own phone carries V2's flags.
    const v1NameOnly = normalizeV1({ first_name: 'Sample', last_name: 'Spouse', role: 'spouse_partner', wants_notifications: true });
    const ownPhone = resolveCallSecondaryContact({ secondary_contact: v1NameOnly }, { secondary_contact: v2Flagged });
    expect(ownPhone.phone).toBe('+15550100123');
    expect(onSiteNotifyConsent(ownPhone)).toBe(true);

    // V1 has its OWN phone and V2 is a name-only entry with flags (no shared
    // identifier): the merged phone is V1's, so V2's flags must not authorize it.
    const v1PhoneOnly = normalizeV1({ phone: '+15550100777', role: 'spouse_partner', wants_notifications: true });
    const v2NameOnly = { ...v2Flagged, phone_e164: null, email: null };
    const otherNumber = resolveCallSecondaryContact({ secondary_contact: v1PhoneOnly }, { secondary_contact: v2NameOnly });
    expect(otherNumber.phone).toBe('+15550100777');
    expect(otherNumber.wants_appointment_texts).toBe(false);
    expect(otherNumber.on_site).toBe(false);
    expect(onSiteNotifyConsent(otherNumber)).toBe(false);

    // Same phone on both sides = positively the same person: V2's flags carry.
    const samePhone = resolveCallSecondaryContact({ secondary_contact: v1PhoneOnly }, { secondary_contact: { ...v2Flagged, phone_e164: '+15550100777' } });
    expect(onSiteNotifyConsent(samePhone)).toBe(true);

    // A conflicting identity returns V1 unmerged — V2's flags never arrive.
    const conflict = resolveCallSecondaryContact({ secondary_contact: v1PhoneOnly }, { secondary_contact: v2Flagged });
    expect(conflict.phone).toBe('+15550100777');
    expect(onSiteNotifyConsent(conflict)).toBe(false);
  });

  test('entries 2+ (V2 array only) take the fields straight from V2', () => {
    const second = { ...v2Base, name_full: 'Sample Tenant', first_name: 'Sample', last_name: 'Tenant', phone_e164: '+15550100888', role: 'tenant', wants_appointment_texts: true, on_site: true };
    const list = resolveCallSecondaryContacts({}, { secondary_contact: v2Base, secondary_contacts: [v2Base, second] });
    expect(list).toHaveLength(2);
    expect(onSiteNotifyConsent(list[0])).toBe(false);
    expect(onSiteNotifyConsent(list[1])).toBe(true);
  });

  test('V1 normalizer keeps strict booleans and defaults absent fields to false', () => {
    const base = { first_name: 'Sample', phone: '+15550100123', role: 'spouse_partner', wants_notifications: true };
    const absent = normalizeV1(base);
    expect(absent.wants_appointment_texts).toBe(false);
    expect(absent.on_site).toBe(false);
    const present = normalizeV1({ ...base, wants_appointment_texts: true, on_site: true });
    expect(present.wants_appointment_texts).toBe(true);
    expect(present.on_site).toBe(true);
  });

  test('V1 flags alone NEVER carry (no evidence contract) — only a valid V2 extraction\'s flags do (owner 2026-09-30 audit)', () => {
    const v1 = normalizeV1({ first_name: 'Sample', last_name: 'Spouse', phone: '+15550100123', role: 'spouse_partner', wants_notifications: true, wants_appointment_texts: true, on_site: true });
    // V1 + V2 without the fields: V1's true flags are dropped.
    const merged = resolveCallSecondaryContact({ secondary_contact: v1 }, { secondary_contact: v2Base });
    expect(merged.wants_appointment_texts).toBe(false);
    expect(merged.on_site).toBe(false);
    // V1 only (no valid V2 extraction): fail closed.
    const v1Only = resolveCallSecondaryContact({ secondary_contact: v1 }, null);
    expect(v1Only.wants_appointment_texts).toBe(false);
    expect(onSiteNotifyConsent(v1Only)).toBe(false);
    // V1 and V2 DISAGREE (V1 true, V2 false): V2's reading wins — false.
    expect(onSiteNotifyConsent(resolveCallSecondaryContact({ secondary_contact: v1 }, { secondary_contact: { ...v2Base, wants_appointment_texts: false, on_site: true } }))).toBe(false);
    // V2 true, V1 silent/false: V2's flags carry on the shared phone.
    const v2True = { ...v2Base, wants_appointment_texts: true, on_site: true };
    expect(onSiteNotifyConsent(resolveCallSecondaryContact({ secondary_contact: { ...v1, wants_appointment_texts: false, on_site: false } }, { secondary_contact: v2True }))).toBe(true);
    const v2Only = resolveCallSecondaryContact({}, { secondary_contact: v2Base });
    expect(onSiteNotifyConsent(v2Only)).toBe(false);
  });

  test('flags are bound to their own extractor\'s role — a V1 lender\'s "text him" never pairs with V2\'s spouse_partner role (pre-push codex P1, round 7)', () => {
    const v1Lender = normalizeV1({ first_name: 'Sample', last_name: 'Spouse', phone: '+15550100123', role: 'lender', wants_notifications: true, wants_appointment_texts: true, on_site: true });
    const v2Spouse = { ...v2Base, role: 'spouse_partner' };
    const merged = resolveCallSecondaryContact({ secondary_contact: v1Lender }, { secondary_contact: v2Spouse });
    expect(merged.role).toBe('lender');
    expect(merged.wants_appointment_texts).toBe(false);
    expect(onSiteNotifyConsent(merged)).toBe(false);
    // The mirror: V1 role unknown (so V2's spouse_partner is the merged role),
    // flags from V1 only → still not grounded; flags from V2 (own role) → grounded.
    const v1Unknown = normalizeV1({ ...v1Lender, role: 'unknown' });
    const m2 = resolveCallSecondaryContact({ secondary_contact: v1Unknown }, { secondary_contact: v2Spouse });
    expect(m2.role).toBe('spouse_partner');
    expect(m2.wants_appointment_texts).toBe(false);
    const m3 = resolveCallSecondaryContact({ secondary_contact: v1Unknown }, { secondary_contact: { ...v2Spouse, wants_appointment_texts: true, on_site: true } });
    expect(onSiteNotifyConsent(m3)).toBe(true);
  });

  test('V1 grounding never rides a V2-supplied phone unless V2 is positively the same person (pre-push codex P1)', () => {
    // Name-only V1 (no phone) with both grounding flags; V2 is phone-only.
    // Nothing conflicts, yet nothing proves they are one person — the merge
    // may take V2's phone for the slot, but NOT carry V1's text consent onto it.
    const v1NoPhone = normalizeV1({ first_name: 'Sample', last_name: 'Spouse', role: 'spouse_partner', wants_notifications: true, wants_appointment_texts: true, on_site: true });
    const v2PhoneOnly = { ...v2Base, name_full: null, first_name: null, last_name: null, email: null, phone_e164: '+15550100777' };
    const merged = resolveCallSecondaryContact({ secondary_contact: v1NoPhone }, { secondary_contact: v2PhoneOnly });
    expect(merged.phone).toBe('+15550100777');
    expect(merged.wants_appointment_texts).toBe(false);
    expect(merged.on_site).toBe(false);
    expect(onSiteNotifyConsent(merged)).toBe(false);

    // Same full name on both sides = positively the same person. V1's flags
    // still never carry (V1 has no evidence contract); V2's own flags do.
    const v2SameName = { ...v2PhoneOnly, name_full: 'Sample Spouse', first_name: 'Sample', last_name: 'Spouse' };
    const same = resolveCallSecondaryContact({ secondary_contact: v1NoPhone }, { secondary_contact: v2SameName });
    expect(same.phone).toBe('+15550100777');
    expect(onSiteNotifyConsent(same)).toBe(false);
    const sameV2Flags = resolveCallSecondaryContact({ secondary_contact: v1NoPhone }, { secondary_contact: { ...v2SameName, wants_appointment_texts: true, on_site: true } });
    expect(onSiteNotifyConsent(sameV2Flags)).toBe(true);
  });
});

// Stateful db stub: every update merges into the one customer row, so a
// multi-contact sequence sees the stamp a previous contact left behind.
function statefulDb(initial) {
  const state = { customer: { ...initial }, updates: [], collisionQueries: 0 };
  db.mockImplementation((table) => {
    if (table === 'customers') {
      let isCollision = false;
      const b = {
        where: jest.fn((arg) => {
          if (typeof arg === 'function') {
            const sub = { whereNull: jest.fn(() => sub), orWhere: jest.fn(() => sub) };
            arg(sub);
          }
          return b;
        }),
        whereNull: jest.fn(() => b),
        whereNot: jest.fn(() => b),
        whereRaw: jest.fn(() => { isCollision = true; return b; }),
        first: jest.fn(async () => {
          if (isCollision) { state.collisionQueries += 1; return null; }
          return { ...state.customer };
        }),
        update: jest.fn(async (payload) => { state.updates.push(payload); Object.assign(state.customer, payload); return 1; }),
      };
      return b;
    }
    if (table === 'notification_prefs') {
      const b = {
        where: jest.fn(() => b),
        first: jest.fn(async () => undefined),
        insert: jest.fn(() => ({ onConflict: jest.fn(() => ({ merge: jest.fn(async () => 1) })) })),
      };
      return b;
    }
    throw new Error(`unexpected table ${table}`);
  });
  return state;
}

// Pre-push codex P1 on #5467: the consent artifact is account-wide, so a
// non-consented phone written AFTER the on-site contact's stamp must never
// clear it. The loop orders consented entries first and withholds a later
// unconsented phone from the slot (review card keeps it).
describe('mixed per-contact consent on one call never clears the on-site stamp (#5467)', () => {
  const emptyRow = {
    id: 'cust-1', phone: '+15550100999', email: null,
    service_contact_name: null, service_contact_phone: null, service_contact_email: null,
    service_contact2_name: null, service_contact2_phone: null, service_contact2_email: null,
    service_contact3_name: null, service_contact3_phone: null, service_contact3_email: null,
  };
  const lender = { first_name: 'Sample', last_name: 'Lender', phone: '+15550100444', role: 'lender', wants_notifications: true };
  const spouse = {
    first_name: 'Sample', last_name: 'Spouse', phone: '+15550100123', role: 'spouse_partner',
    wants_notifications: true, wants_appointment_texts: true, on_site: true,
  };

  test('orderSecondaryEntriesForPersistence puts consented entries first, stable otherwise', () => {
    const ordered = orderSecondaryEntriesForPersistence([lender, spouse], false);
    expect(ordered).toEqual([spouse, lender]);
    // V2 explicit consent: every entry consents, so extraction order stands.
    expect(orderSecondaryEntriesForPersistence([lender, spouse], true)).toEqual([lender, spouse]);
    expect(orderSecondaryEntriesForPersistence(null, false)).toEqual([]);
  });

  test('lender extracted BEFORE the on-site spouse: spouse writes with the stamp, lender phone is withheld', async () => {
    const state = statefulDb(emptyRow);
    const results = [];
    for (const entry of orderSecondaryEntriesForPersistence([lender, spouse], false)) {
      const { smsConsentExplicit, smsConsentSource } = resolveSecondaryConsent(entry, false);
      results.push(await persistCallSecondaryContact('cust-1', entry, { smsConsentExplicit, smsConsentSource }));
    }
    expect(results).toEqual(['written', 'written']);
    // Spouse first: slot 1 with phone + on-site stamp.
    expect(state.updates[0]).toMatchObject({
      service_contact_phone: '+15550100123',
      service_contact_role: 'spouse_partner',
      service_contacts_consent_source: 'call_pipeline_onsite_contact',
    });
    // Lender second: name lands, phone withheld, stamp never touched or cleared.
    expect(state.updates[1]).toMatchObject({ service_contact2_name: 'Sample Lender', service_contact2_phone: null });
    expect(state.updates[1]).not.toHaveProperty('service_contacts_consent_at');
    expect(state.customer.service_contacts_consent_at).toBeInstanceOf(Date);
    expect(state.customer.service_contact2_phone).toBeNull();
  });

  test('a withheld phone never raises a cross-customer collision lookup', async () => {
    const state = statefulDb({ ...emptyRow, service_contact_name: 'Sample Spouse', service_contact_phone: '+15550100123', service_contacts_consent_at: new Date() });
    expect(await persistCallSecondaryContact('cust-1', lender)).toBe('written');
    expect(state.collisionQueries).toBe(0);
    // A phone that WILL be written still gets the guard.
    const state2 = statefulDb(emptyRow);
    await persistCallSecondaryContact('cust-1', lender);
    expect(state2.collisionQueries).toBe(1);
  });
});

describe('consent upgrade for a phone already on record (#5467)', () => {
  const spouseRow = {
    id: 'cust-1', phone: '+15550100999', email: null,
    service_contact_name: 'Sample Spouse', service_contact_phone: '+15550100123', service_contact_email: null,
    service_contact_role: null,
    service_contact2_name: null, service_contact2_phone: null, service_contact2_email: null,
    service_contact3_name: null, service_contact3_phone: null, service_contact3_email: null,
  };
  const spouse = {
    first_name: 'Sample', last_name: 'Spouse', phone: '+15550100123', role: 'spouse_partner',
    wants_notifications: true, wants_appointment_texts: true, on_site: true,
  };
  const onSite = { smsConsentExplicit: true, smsConsentSource: 'call_pipeline_onsite_contact' };

  test('upgrade is refused when the slot phone is another customer\'s primary number (pre-push codex P1)', async () => {
    const state = statefulDb({ id: 'cust-1', phone: '+15550100999', email: null,
      service_contact_name: 'Sample Spouse', service_contact_phone: '+15550100123', service_contact_email: null, service_contact_role: 'spouse_partner',
      service_contact2_name: null, service_contact2_phone: null, service_contact2_email: null,
      service_contact3_name: null, service_contact3_phone: null, service_contact3_email: null });
    // The cross-customer lookup (whereRaw + first) finds another owner.
    const base = db.getMockImplementation();
    db.mockImplementation((table) => {
      const b = base(table);
      if (table === 'customers') {
        const origFirst = b.first;
        b.first = jest.fn(async (...a) => (b.whereRaw.mock.calls.length ? { id: 'cust-2' } : origFirst(...a)));
      }
      return b;
    });
    const res = await persistCallSecondaryContact('cust-1', { first_name: 'Sample', last_name: 'Spouse', phone: '+15550100123', role: 'spouse_partner', wants_notifications: true },
      { smsConsentExplicit: true, smsConsentSource: 'call_pipeline_onsite_contact' });
    expect(res).toBe('skipped_phone_belongs_to_other_customer');
    expect(state.updates.some((u) => u.service_contacts_consent_at)).toBe(false);
  });

  test('single-phone unstamped row: stamps the artifact (and backfills the role) -> consent_upgraded_phone_on_record', async () => {
    const state = statefulDb(spouseRow);
    expect(await persistCallSecondaryContact('cust-1', spouse, onSite)).toBe('consent_upgraded_phone_on_record');
    expect(state.updates[0]).toEqual({
      service_contacts_consent_at: expect.any(Date),
      service_contacts_consent_source: 'call_pipeline_onsite_contact',
      service_contacts_consent_text_version: 'call-2026-07-23',
    });
    // Role backfill still ran for the unroled slot.
    expect(state.updates.some((u) => u.service_contact_role === 'spouse_partner')).toBe(true);
  });

  test('another UNCONSENTED slot phone on the row blocks the upgrade — existing status, no stamp', async () => {
    const state = statefulDb({ ...spouseRow, service_contact2_name: 'Sample Lender', service_contact2_phone: '+15550100444' });
    const status = await persistCallSecondaryContact('cust-1', spouse, onSite);
    expect(status).toBe('skipped_phone_on_record_consent_withheld');
    expect(state.updates.some((u) => 'service_contacts_consent_at' in u)).toBe(false);
  });

  test('already-stamped row keeps its status and artifact', async () => {
    const stampedAt = new Date('2026-07-22T00:00:00Z');
    const state = statefulDb({ ...spouseRow, service_contact_role: 'spouse_partner', service_contacts_consent_at: stampedAt, service_contacts_consent_source: 'portal' });
    expect(await persistCallSecondaryContact('cust-1', spouse, onSite)).toBe('skipped_phone_on_record');
    expect(state.updates).toEqual([]);
  });

  test('without explicit consent the on-record phone is never stamped', async () => {
    const state = statefulDb({ ...spouseRow, service_contact_role: 'spouse_partner' });
    expect(await persistCallSecondaryContact('cust-1', spouse)).toBe('skipped_phone_on_record');
    expect(state.updates).toEqual([]);
  });

  test('a fresh write whose stamp is withheld returns written_consent_withheld and the card is marked', async () => {
    const state = statefulDb({ ...spouseRow, service_contact_name: 'Other Lender', service_contact_phone: '+15550100777', service_contact_role: 'lender' });
    expect(await persistCallSecondaryContact('cust-1', { ...spouse, phone: '+15550100555' }, onSite)).toBe('written_consent_withheld');
    expect(state.updates.some((u) => u.service_contact2_phone === '+15550100555')).toBe(true);
    expect(state.updates.some((u) => 'service_contacts_consent_at' in u)).toBe(false);
    // Stamp present on the write -> plain 'written'.
    const clean = statefulDb({ ...spouseRow, service_contact_name: null, service_contact_phone: null });
    expect(await persistCallSecondaryContact('cust-1', spouse, onSite)).toBe('written');
    expect(clean.updates[0]).toHaveProperty('service_contacts_consent_at');
    // Unconsented write is never "consent withheld" (nothing was grounded).
    statefulDb({ ...spouseRow, service_contact_name: null, service_contact_phone: null });
    expect(await persistCallSecondaryContact('cust-1', spouse)).toBe('written');
  });

  test('the loop marks the card for BOTH withheld statuses and dispatches the opt-in for the fresh one', () => {
    const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    expect(src).toContain("result === 'skipped_phone_on_record_consent_withheld' || result === 'written_consent_withheld'");
    expect(src).toContain("'written', 'written_consent_withheld', 'consent_upgraded_phone_on_record'");
  });

  test('the loop claims the opt-in on an upgrade as well as a fresh write', () => {
    const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    expect(src).toContain("['written', 'written_consent_withheld', 'consent_upgraded_phone_on_record', 'skipped_phone_on_record_consent_withheld'].includes(result) && claimedOptins.length && claimedCustRow");
  });
});

describe('on-site grounding must be pinned to a CALLER quote that is in the transcript (#5467)', () => {
  const transcript = [
    'Agent: We could put his cell phone on the account so he gets the reminders.',
    'Caller: Yeah.',
    'Agent: And is he going to be there for the visit?',
    'Caller: Yes, he will be at the house all day Tuesday.',
  ].join('\n');
  const grounded = {
    first_name: 'Sample', last_name: 'Spouse', phone: '+15550100123', role: 'spouse_partner',
    wants_notifications: true,
    wants_appointment_texts: true, wants_appointment_texts_quote: 'Yeah.',
    on_site: true, on_site_quote: 'he will be at the house all day Tuesday',
  };

  test('both quotes in CALLER turns -> qualifies (a bare "Yeah" grounds only as the whole turn; punctuation/case-insensitive)', () => {
    const v = verifyOnSiteGrounding(grounded, transcript);
    expect(v.wants_appointment_texts).toBe(true);
    expect(v.on_site).toBe(true);
    expect(onSiteNotifyConsent(v)).toBe(true);
    expect(verifyOnSiteGrounding({ ...grounded, wants_appointment_texts_quote: 'YEAH', on_site_quote: 'Yes, HE will be at the house' }, transcript).on_site).toBe(true);
  });

  test('negated or refusing quotes never ground (substantive or short), but "no problem" idioms do', () => {
    const say = (agent, caller) => [`Agent: ${agent}`, `Caller: ${caller}`].join('\n');
    // Codex counterexamples.
    const refusedTexts = say('Should we text him the reminders?', "Don't send him appointment texts.");
    expect(verifyOnSiteGrounding({ ...grounded, wants_appointment_texts_quote: "Don't send him appointment texts" }, refusedTexts).wants_appointment_texts).toBe(false);
    const notThere = say('Will he be there?', 'He will not be at the house on Tuesday.');
    expect(verifyOnSiteGrounding({ ...grounded, on_site_quote: 'He will not be at the house on Tuesday' }, notThere).on_site).toBe(false);
    // Other refusal shapes.
    for (const quote of ["I'd rather not have him get texts", 'Never text him please', 'Nobody will be home that day', 'Please stop texting him', 'He cannot be there']) {
      expect(verifyOnSiteGrounding({ ...grounded, wants_appointment_texts_quote: quote, on_site_quote: quote }, say('Text him the reminders? Will he be there?', quote))).toMatchObject({ wants_appointment_texts: false, on_site: false });
    }
    // Affirmative idioms with "no/not" still ground.
    const idiom = say('Do you want us to text him the reminders?', 'No problem, text him the reminders.');
    expect(verifyOnSiteGrounding({ ...grounded, wants_appointment_texts_quote: 'No problem, text him the reminders' }, idiom).wants_appointment_texts).toBe(true);
    const notAProblem = say('Can we text him the tracking link?', 'That is not a problem, text him the tracking link.');
    expect(verifyOnSiteGrounding({ ...grounded, wants_appointment_texts_quote: 'That is not a problem, text him the tracking link' }, notAProblem).wants_appointment_texts).toBe(true);
    // A short answer must itself be affirmative: "No." / "Nope." / "Thanks." never ground.
    for (const quote of ['No.', 'Nope.', 'Thanks.']) {
      const t = say('Should we text him the reminders?', quote);
      expect(verifyOnSiteGrounding({ ...grounded, wants_appointment_texts_quote: quote }, t).wants_appointment_texts).toBe(false);
    }
    expect(verifyOnSiteGrounding({ ...grounded, wants_appointment_texts_quote: 'Sounds good.' }, say('Should we text him the reminders?', 'Sounds good.')).wants_appointment_texts).toBe(true);
  });

  test('a short affirmation counts only after an agent turn that asked about THAT field', () => {
    // Motivating call: agent offers reminders/tracking link, caller "Yeah." -> texts grounded.
    const motivating = ['Agent: Would you like us to text him the reminders and the tracking link?', 'Caller: Yeah.'].join('\n');
    expect(verifyOnSiteGrounding({ ...grounded, on_site: false }, motivating).wants_appointment_texts).toBe(true);
    // The same "Yeah." after an unrelated question does not.
    const unrelated = ["Agent: What's the zip code?", 'Caller: Yeah.'].join('\n');
    expect(verifyOnSiteGrounding(grounded, unrelated).wants_appointment_texts).toBe(false);
    // No preceding agent turn at all (opening caller turn), or a caller turn before it.
    expect(verifyOnSiteGrounding(grounded, 'Caller: Yeah.').wants_appointment_texts).toBe(false);
    expect(verifyOnSiteGrounding(grounded, ['Caller: Hello.', 'Caller: Yeah.'].join('\n')).wants_appointment_texts).toBe(false);
    // The prompt must be about the SAME field: a texts question does not ground on_site, and vice versa.
    const textsQuestion = ['Agent: Should we text him the reminders?', 'Caller: Yeah.'].join('\n');
    expect(verifyOnSiteGrounding({ ...grounded, on_site_quote: 'Yeah.' }, textsQuestion).on_site).toBe(false);
    const presenceQuestion = ['Agent: Will he be there that day?', 'Caller: Yeah.'].join('\n');
    expect(verifyOnSiteGrounding({ ...grounded, wants_appointment_texts_quote: 'Yeah.' }, presenceQuestion).wants_appointment_texts).toBe(false);
    expect(verifyOnSiteGrounding({ ...grounded, on_site_quote: 'Yeah.' }, presenceQuestion).on_site).toBe(true);
    // Codex counterexamples: topical words in an unrelated question do not ground the field.
    const termites = ['Agent: Are there termites?', 'Caller: Yes.'].join('\n');
    expect(verifyOnSiteGrounding({ ...grounded, on_site_quote: 'Yes.' }, termites).on_site).toBe(false);
    const gotMessage = ['Agent: Did you get my message?', 'Caller: Yes.'].join('\n');
    expect(verifyOnSiteGrounding({ ...grounded, wants_appointment_texts_quote: 'Yes.' }, gotMessage).wants_appointment_texts).toBe(false);
    // Texts need a recipient reference in the same agent turn.
    const noRecipient = ['Agent: We send reminders.', 'Caller: Yes.'].join('\n');
    expect(verifyOnSiteGrounding({ ...grounded, wants_appointment_texts_quote: 'Yes.' }, noRecipient).wants_appointment_texts).toBe(false);
    // The motivating real call, and a presence question, still ground.
    const real = ["Agent: We could put his cell phone on the account so he'll get the reminders and the certification.", 'Caller: Yeah.'].join('\n');
    expect(verifyOnSiteGrounding({ ...grounded, on_site: false }, real).wants_appointment_texts).toBe(true);
    const presence = ["Agent: Okay, so he'll be there Tuesday?", 'Caller: Yes.'].join('\n');
    expect(verifyOnSiteGrounding({ ...grounded, on_site_quote: 'Yes.' }, presence).on_site).toBe(true);
    // Filler-only phrases of 3+ words are still generic ("Yeah, that works").
    const filler = ["Agent: What's the zip code?", 'Caller: Yeah, that works.'].join('\n');
    expect(verifyOnSiteGrounding({ ...grounded, wants_appointment_texts_quote: 'Yeah, that works' }, filler).wants_appointment_texts).toBe(false);
    // Substantive quotes keep the plain caller-turn rule (no prompt needed).
    const substantive = ["Agent: What's the zip code?", 'Caller: Please text him the reminders on the day.'].join('\n');
    expect(verifyOnSiteGrounding({ ...grounded, wants_appointment_texts_quote: 'Please text him the reminders on the day' }, substantive).wants_appointment_texts).toBe(true);
  });

  test('missing quote -> that flag is forced false (both are required)', () => {
    const v = verifyOnSiteGrounding({ ...grounded, on_site_quote: null }, transcript);
    expect(v.on_site).toBe(false);
    expect(v.wants_appointment_texts).toBe(true);
    expect(onSiteNotifyConsent(v)).toBe(false);
    expect(onSiteNotifyConsent(verifyOnSiteGrounding({ ...grounded, wants_appointment_texts_quote: '   ' }, transcript))).toBe(false);
  });

  test('a quote that is not in the transcript, or only in an AGENT turn, forces false', () => {
    expect(onSiteNotifyConsent(verifyOnSiteGrounding({ ...grounded, on_site_quote: 'he lives there full time' }, transcript))).toBe(false);
    // Said by the agent, not the caller.
    expect(onSiteNotifyConsent(verifyOnSiteGrounding({ ...grounded, wants_appointment_texts_quote: 'We could put his cell phone on the account so he gets the reminders' }, transcript))).toBe(false);
    // A one-word quote must be the whole caller turn — "Yeah" inside a longer turn is not enough.
    const longer = 'Agent: Text him?\nCaller: Yeah that would be fine thanks.';
    expect(verifyOnSiteGrounding({ ...grounded, wants_appointment_texts_quote: 'Yeah' }, longer).wants_appointment_texts).toBe(false);
  });

  test('an unlabeled or empty transcript fails closed; false flags stay false; input not mutated', () => {
    expect(onSiteNotifyConsent(verifyOnSiteGrounding(grounded, 'Yeah. he will be at the house all day Tuesday'))).toBe(false);
    expect(onSiteNotifyConsent(verifyOnSiteGrounding(grounded, null))).toBe(false);
    expect(onSiteNotifyConsent(verifyOnSiteGrounding(grounded, ''))).toBe(false);
    const input = { ...grounded, on_site: false };
    expect(verifyOnSiteGrounding(input, transcript).on_site).toBe(false);
    expect(input.on_site).toBe(false);
    expect(verifyOnSiteGrounding(null, transcript)).toBeNull();
  });

  const { normalizeSecondaryContact: normalizeV1 } = require('../utils/intake-normalize');
  const v2Contact = {
    name_full: 'Sample Spouse', first_name: 'Sample', last_name: 'Spouse', phone_e164: '+15550100123',
    email: null, role: 'spouse_partner', wants_notifications: true, wants_appointment_texts: true, on_site: true,
  };
  const second = { ...v2Contact, name_full: 'Sample Tenant', first_name: 'Sample', last_name: 'Tenant', phone_e164: '+15550100888', role: 'tenant' };
  const evidence = [
    { field_path: '/secondary_contact/wants_appointment_texts', quote: 'Yeah.', speaker: 'caller' },
    { field_path: '/secondary_contact/on_site', quote: 'he will be at the house all day Tuesday', speaker: 'caller' },
    { field_path: '/secondary_contacts/1/on_site', quote: 'she lives in the back unit', speaker: 'caller' },
    { field_path: '/secondary_contacts/1/wants_appointment_texts', quote: '   ', speaker: 'caller' },
    { field_path: '/secondary_contacts/1/wants_appointment_texts', quote: 'text her too', speaker: 'agent' },
  ];

  test('V2 evidence[] pointers map to the matching contact; agent-spoken or blank quotes are not evidence', () => {
    // The singleton mirrors entry 0 (same person), so it may read entry 0's pointers.
    const single = mapSecondaryContactToLegacy(v2Contact, { evidence, counterpart: v2Contact });
    expect(single.wants_appointment_texts_quote).toBe('Yeah.');
    expect(single.on_site_quote).toBe('he will be at the house all day Tuesday');
    const list = mapSecondaryContactsToLegacy([v2Contact, second], evidence, v2Contact);
    expect(list[0].on_site_quote).toBe('he will be at the house all day Tuesday');
    expect(list[1].on_site_quote).toBe('she lives in the back unit');
    expect(list[1].wants_appointment_texts_quote).toBeNull();
    const alt = mapSecondaryContactToLegacy(v2Contact, { evidence: [{ field_path: 'secondary_contacts[0].on_site', quote: 'he will be at the house', speaker: 'caller' }], counterpart: v2Contact });
    expect(alt.on_site_quote).toBe('he will be at the house');
    expect(mapSecondaryContactToLegacy(second, { evidence: [{ field_path: '/secondary_contact/on_site', quote: 'x'.repeat(20), speaker: 'caller' }], index: 1 }).on_site_quote).toBeNull();
    expect(mapSecondaryContactToLegacy(v2Contact).on_site_quote).toBeNull();
  });

  test('end to end: only V2 with caller-pinned evidence qualifies, after transcript verification', () => {
    const merged = resolveCallSecondaryContact({}, { secondary_contact: v2Contact, evidence });
    expect(onSiteNotifyConsent(verifyOnSiteGrounding(merged, transcript))).toBe(true);
    // Hallucinated flags with no evidence[] never qualify.
    expect(onSiteNotifyConsent(verifyOnSiteGrounding(resolveCallSecondaryContact({}, { secondary_contact: v2Contact }), transcript))).toBe(false);
    // V1 saying yes with a V2 that has no flags: never.
    const v1 = normalizeV1({ first_name: 'Sample', last_name: 'Spouse', phone: '+15550100123', role: 'spouse_partner', wants_notifications: true, wants_appointment_texts: true, on_site: true });
    expect(onSiteNotifyConsent(verifyOnSiteGrounding(resolveCallSecondaryContact({ secondary_contact: v1 }, null), transcript))).toBe(false);
  });

  test('entries 2+ keep their own evidence through resolveCallSecondaryContacts', () => {
    const list = resolveCallSecondaryContacts({}, { secondary_contact: v2Contact, secondary_contacts: [v2Contact, { ...second, wants_appointment_texts: true }], evidence });
    expect(list).toHaveLength(2);
    expect(list[1].on_site_quote).toBe('she lives in the back unit');
    // Entry 2's text-intent quote was blank/agent-spoken, so it can never verify.
    expect(onSiteNotifyConsent(verifyOnSiteGrounding(list[1], `${transcript}\nCaller: she lives in the back unit`))).toBe(false);
  });

  test('the processor applies verifyOnSiteGrounding where callSecondaryContacts is built', () => {
    const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    expect(src).toContain('resolveCallSecondaryContacts(extracted, v2CanonicalExtraction)\n      .map((c) => verifyOnSiteGrounding(c, transcription))');
  });
});

describe('do-not-contact, notify-primary and withheld-consent rules for the on-site contact (#5467)', () => {
  const spouse = {
    first_name: 'Sample', last_name: 'Spouse', phone: '+15550100123', role: 'spouse_partner',
    wants_notifications: true, wants_appointment_texts: true, on_site: true,
  };

  test('do_not_contact_request: no on-site consent (so no stamp and no opt-in claim); explicit V2 consent path untouched', () => {
    expect(resolveSecondaryConsent(spouse, false, { doNotContact: true }).smsConsentExplicit).toBe(false);
    expect(resolveSecondaryConsent(spouse, false, { doNotContact: false }).smsConsentExplicit).toBe(true);
    expect(resolveSecondaryConsent(spouse, true, { doNotContact: true }).smsConsentExplicit).toBe(true);
    expect(orderSecondaryEntriesForPersistence([{ ...spouse, role: 'lender', wants_appointment_texts: false }, spouse], false, { doNotContact: true }))
      .toEqual([{ ...spouse, role: 'lender', wants_appointment_texts: false }, spouse]);
  });

  test('do_not_contact_request: the slot still writes, with no stamp', async () => {
    const state = statefulDb({ id: 'cust-1', phone: '+15550100999', email: null,
      service_contact_name: null, service_contact_phone: null, service_contact_email: null,
      service_contact2_name: null, service_contact2_phone: null, service_contact2_email: null,
      service_contact3_name: null, service_contact3_phone: null, service_contact3_email: null });
    const { smsConsentExplicit, smsConsentSource } = resolveSecondaryConsent(spouse, false, { doNotContact: true });
    expect(await persistCallSecondaryContact('cust-1', spouse, { smsConsentExplicit, smsConsentSource })).toBe('written');
    expect(state.updates[0]).toMatchObject({ service_contact_phone: '+15550100123' });
    expect(state.updates[0]).not.toHaveProperty('service_contacts_consent_at');
  });

  test('the loop and fan-out gate read the do-not-contact flag', () => {
    const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    expect(src).toContain('const v2DoNotContact = v2CanonicalExtraction?.consent?.do_not_contact_request === true;');
    expect(src).toContain('!v2DoNotContact && optinRailLive && callSecondaryContacts.some(onSiteNotifyConsent)');
    expect(src).toContain('{ doNotContact: v2DoNotContact, optinRailLive }');
  });

  test('eligibility follows the GROUNDED on-site rule, not the stamp source (explicit V2 consent included)', async () => {
    const bare = { id: 'cust-1', phone: '+15550100999', email: null,
      service_contact_name: null, service_contact_phone: null, service_contact_email: null,
      service_contact2_name: null, service_contact2_phone: null, service_contact2_email: null,
      service_contact3_name: null, service_contact3_phone: null, service_contact3_email: null };
    const eligibleFor = async (opts) => {
      statefulDb(bare);
      let fired = 0;
      await persistCallSecondaryContact('cust-1', spouse, { ...opts, onPrimaryOptOutEligible: () => { fired += 1; } });
      return fired;
    };
    // On-site rule source + grounded.
    expect(await eligibleFor({ smsConsentExplicit: true, smsConsentSource: 'call_pipeline_onsite_contact', onSiteGrounded: true })).toBe(1);
    // Explicit V2 consent (source stays call_pipeline_request) + grounded on-site contact: STILL eligible.
    expect(await eligibleFor({ smsConsentExplicit: true, smsConsentSource: 'call_pipeline_request', onSiteGrounded: true })).toBe(1);
    // V2-consented but NOT a grounded on-site contact: not eligible.
    expect(await eligibleFor({ smsConsentExplicit: true, smsConsentSource: 'call_pipeline_request', onSiteGrounded: false })).toBe(0);
    // The on-site SOURCE alone (not grounded) is not enough.
    expect(await eligibleFor({ smsConsentExplicit: true, smsConsentSource: 'call_pipeline_onsite_contact', onSiteGrounded: false })).toBe(0);
    // Grounded but no consent (do-not-contact): not eligible.
    expect(await eligibleFor({ smsConsentExplicit: false, smsConsentSource: 'call_pipeline_onsite_contact', onSiteGrounded: true })).toBe(0);
  });

  test('the booking site writes a durable demote MARKER (never the pref) after scheduledServiceId lands; persistence never writes false', () => {
    const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    expect(src).toContain('deferPrimaryOptOutPhoneKey = String(secondaryEntry.phone');
    const landed = src.indexOf('scheduledServiceId = svc.id;');
    const marker = src.indexOf('demote_primary_on_optin: {', landed);
    expect(landed).toBeGreaterThan(-1);
    expect(marker).toBeGreaterThan(landed);
    expect(marker - landed).toBeLessThan(5200);
    const block = src.slice(landed, marker + 400);
    expect(block).toContain('if (deferPrimaryOptOutCustomerId && deferPrimaryOptOutPhoneKey)');
    expect(block).toContain('phone_key: deferPrimaryOptOutPhoneKey');
    expect(block).toContain('scheduled_service_id: svc.id');
    expect(block).toContain("COALESCE(service_preferences, \\'{}\\'::jsonb) ||");
    // The only pref write is the already-confirmed shortcut (one insert + one merge); no state-recovery block remains.
    expect(src.split('appointment_notify_primary: false').length - 1).toBe(2);
    expect(src).not.toContain('primaryOptOutFromState');
    expect(src).not.toContain('onSiteConsentedPhonesThisCall');
  });

  test('phone on record + another unconsented slot phone: distinct withheld status (the card says why)', async () => {
    const row = { id: 'cust-1', phone: '+15550100999', email: null,
      service_contact_name: 'Sample Spouse', service_contact_phone: '+15550100123', service_contact_email: null, service_contact_role: 'spouse_partner',
      service_contact2_name: 'Sample Lender', service_contact2_phone: '+15550100444', service_contact2_email: null,
      service_contact3_name: null, service_contact3_phone: null, service_contact3_email: null };
    const state = statefulDb(row);
    expect(await persistCallSecondaryContact('cust-1', spouse, { smsConsentExplicit: true, smsConsentSource: 'call_pipeline_onsite_contact' }))
      .toBe('skipped_phone_on_record_consent_withheld');
    expect(state.updates.some((u) => 'service_contacts_consent_at' in u)).toBe(false);
    const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    expect(src).toContain("result === 'skipped_phone_on_record_consent_withheld'");
    expect(src).toContain('consent_withheld: consentWithheldMarker');
    expect(src).toContain("railDarkWithheld ? 'optin_rail_dark'");
  });
});

// Pre-push codex P1: an unconsented phone write must re-assert, in the UPDATE's
// own WHERE, that the row is still unstamped — the read that decided
// phoneWithheld=false can be overtaken by a portal attestation.
describe('unconsented phone write re-checks the consent stamp atomically (#5467)', () => {
  test('the slot UPDATE carries whereNull(service_contacts_consent_at) for an unconsented phone, and not for a consented one', () => {
    const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    const at = src.indexOf("let write = db('customers').where({ id: customerId });");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 1500);
    expect(block).toContain("if (effectivePhone && !smsConsentExplicit) {\n    write = write.whereNull('service_contacts_consent_at');");
  });
});

// Pre-push codex P1: evidence pointers use the MODEL's secondary_contacts
// indices; when normalization drops a non-object shell (or the cap of 3 cuts
// the tail) the pointers are remapped to the kept entry's new position and
// pointers to dropped entries are removed.
describe('V2 normalization keeps evidence indices aligned with secondary_contacts', () => {
  const { normalizeExtractionV2, remapSecondaryContactEvidence } = require('../utils/normalize-extraction-v2');
  const contact = (n) => ({ name_full: `Sample ${n}`, first_name: 'Sample', last_name: String(n), phone_e164: `+1555010010${n}`, role: 'tenant', wants_notifications: true, wants_appointment_texts: true, on_site: true });

  test('a dropped shell shifts later pointers; the shell\'s own pointers are removed', () => {
    const out = normalizeExtractionV2({
      secondary_contacts: ['garbage', contact(1), contact(2)],
      evidence: [
        { field_path: '/secondary_contacts/0/on_site', quote: 'x', speaker: 'caller' },
        { field_path: '/secondary_contacts/1/on_site', quote: 'one on site', speaker: 'caller' },
        { field_path: '/secondary_contacts/2/wants_appointment_texts', quote: 'two texts', speaker: 'caller' },
        { field_path: '/property/service_address', quote: 'addr', speaker: 'caller' },
      ],
    });
    expect(out.secondary_contacts).toHaveLength(2);
    expect(out.evidence.map((e) => e.field_path)).toEqual([
      '/secondary_contacts/0/on_site', '/secondary_contacts/1/wants_appointment_texts', '/property/service_address',
    ]);
    expect(out.evidence[0].quote).toBe('one on site');
  });

  test('no drops → evidence untouched; pointers past the cap of 3 are removed', () => {
    const ev = [{ field_path: '/secondary_contacts/0/on_site', quote: 'q' }, { field_path: '/secondary_contacts/3/on_site', quote: 'late' }];
    const out = normalizeExtractionV2({ secondary_contacts: [contact(1), contact(2), contact(3), contact(4)], evidence: ev });
    expect(out.secondary_contacts).toHaveLength(3);
    expect(out.evidence).toEqual([ev[0]]);
    expect(remapSecondaryContactEvidence(undefined, new Map())).toBeUndefined();
  });
});

// Pre-push codex P1: the singleton secondary_contact and secondary_contacts[0]
// share evidence pointers ONLY when they are positively the same person.
describe('singleton / entry-0 evidence sharing requires the same person', () => {
  const { mapSecondaryContactToLegacy: mapOne, mapSecondaryContactsToLegacy: mapMany, sameV2Person } = require('../utils/extraction-compat');
  const spouse = { name_full: 'Sample Spouse', first_name: 'Sample', last_name: 'Spouse', phone_e164: '+15550100123', role: 'spouse_partner', wants_notifications: true, wants_appointment_texts: true, on_site: true };
  const lender = { name_full: 'Other Lender', first_name: 'Other', last_name: 'Lender', phone_e164: '+15550100777', role: 'lender', wants_notifications: true, wants_appointment_texts: true, on_site: true };
  const evidence = [
    { field_path: '/secondary_contacts/0/on_site', quote: 'he lives there', speaker: 'caller' },
    { field_path: '/secondary_contacts/0/wants_appointment_texts', quote: 'yeah text him', speaker: 'caller' },
  ];

  test('different people: the singleton does NOT inherit entry 0\'s quotes (and vice versa)', () => {
    expect(sameV2Person(spouse, lender)).toBe(false);
    const single = mapOne(lender, { evidence, counterpart: spouse });
    expect(single.on_site_quote).toBeNull();
    expect(single.wants_appointment_texts_quote).toBeNull();
    const singletonEv = [{ field_path: '/secondary_contact/on_site', quote: 'q', speaker: 'caller' }];
    expect(mapMany([spouse], singletonEv, lender)[0].on_site_quote).toBeNull();
  });

  test('conflicting phone or email vetoes sharing even when the full name matches (pre-push codex P1)', () => {
    expect(sameV2Person(spouse, { ...spouse, phone_e164: '+15550100777' })).toBe(false);
    expect(sameV2Person({ ...spouse, email: 'a@example.com' }, { ...spouse, phone_e164: null, email: 'b@example.com' })).toBe(false);
    const single = mapOne({ ...spouse, phone_e164: '+15550100777' }, { evidence, counterpart: spouse });
    expect(single.on_site_quote).toBeNull();
  });

  test('same person (phone / email / full name): quotes are shared both ways', () => {
    expect(sameV2Person(spouse, { ...lender, phone_e164: spouse.phone_e164 })).toBe(true);
    expect(sameV2Person({ ...spouse, phone_e164: null, email: 'a@example.com' }, { ...lender, email: 'A@example.com' })).toBe(true);
    expect(sameV2Person({ ...spouse, phone_e164: null }, { ...lender, name_full: 'sample  spouse' })).toBe(true);
    const single = mapOne({ ...spouse, phone_e164: null }, { evidence, counterpart: spouse });
    expect(single.on_site_quote).toBe('he lives there');
    expect(single.wants_appointment_texts_quote).toBe('yeah text him');
  });
});

// Pre-push codex P1: the opt-in claim must exist BEFORE the consent stamp is
// published (a stamped row with a rowless phone reads as grandfathered).
describe('beforeStamp hook runs before any consent-stamp UPDATE (#5467)', () => {
  const emptyRow = {
    id: 'cust-1', phone: '+15550100999', email: null,
    service_contact_name: null, service_contact_phone: null, service_contact_email: null,
    service_contact2_name: null, service_contact2_phone: null, service_contact2_email: null,
    service_contact3_name: null, service_contact3_phone: null, service_contact3_email: null,
  };
  const spouse = { first_name: 'Sample', last_name: 'Spouse', phone: '+15550100123', role: 'spouse_partner', wants_notifications: true };
  const onSite = { smsConsentExplicit: true, smsConsentSource: 'call_pipeline_onsite_contact' };

  test('fresh consented write: hook runs with ZERO updates applied, then the stamped slot write lands', async () => {
    const state = statefulDb(emptyRow);
    let updatesAtHook = -1;
    const res = await persistCallSecondaryContact('cust-1', spouse, { ...onSite, beforeStamp: async () => { updatesAtHook = state.updates.length; } });
    expect(res).toBe('written');
    expect(updatesAtHook).toBe(0);
    expect(state.updates.some((u) => u.service_contacts_consent_at)).toBe(true);
  });

  test('consented write whose stamp is withheld (another unconsented slot phone) still runs the hook', async () => {
    const state = statefulDb({ ...emptyRow, service_contact_name: 'Other Lender', service_contact_phone: '+15550100777' });
    let called = 0;
    const res = await persistCallSecondaryContact('cust-1', spouse, { ...onSite, beforeStamp: async () => { called += 1; } });
    expect(res).toBe('written_consent_withheld');
    expect(called).toBe(1);
    expect(state.updates.some((u) => u.service_contacts_consent_at)).toBe(false);
  });

  test('withheld-on-record path: the cross-customer guard runs BEFORE the hook (no claim for another customer\'s number)', async () => {
    let called = 0;
    statefulDb({ ...emptyRow, service_contact_name: 'Sample Spouse', service_contact_phone: '+15550100123', service_contact2_name: 'Other Lender', service_contact2_phone: '+15550100777' });
    const base = db.getMockImplementation();
    db.mockImplementation((table) => {
      const b = base(table);
      if (table === 'customers') {
        const origFirst = b.first;
        b.first = jest.fn(async (...a) => (b.whereRaw.mock.calls.length ? { id: 'cust-2' } : origFirst(...a)));
      }
      return b;
    });
    const res = await persistCallSecondaryContact('cust-1', spouse, { ...onSite, beforeStamp: async () => { called += 1; } });
    expect(res).toBe('skipped_phone_belongs_to_other_customer');
    expect(called).toBe(0);
  });

  test('phone-on-record with the upgrade withheld still runs the hook', async () => {
    let called = 0;
    statefulDb({ ...emptyRow, service_contact_name: 'Sample Spouse', service_contact_phone: '+15550100123', service_contact2_name: 'Other Lender', service_contact2_phone: '+15550100777' });
    const res = await persistCallSecondaryContact('cust-1', spouse, { ...onSite, beforeStamp: async () => { called += 1; } });
    expect(res).toBe('skipped_phone_on_record_consent_withheld');
    expect(called).toBe(1);
  });

  test('unconsented write: hook is not called', async () => {
    statefulDb(emptyRow);
    let called = false;
    await persistCallSecondaryContact('cust-1', { ...spouse, role: 'lender', phone: '+15550100777' }, { smsConsentExplicit: false, beforeStamp: async () => { called = true; } });
    expect(called).toBe(false);
  });

  test('a throwing hook aborts before the stamp — no customers UPDATE at all', async () => {
    const state = statefulDb(emptyRow);
    await expect(persistCallSecondaryContact('cust-1', spouse, { ...onSite, beforeStamp: async () => { throw new Error('claim down'); } })).rejects.toThrow('claim down');
    expect(state.updates).toEqual([]);
  });

  test('phone-on-record upgrade: hook runs before the stamp UPDATE', async () => {
    const state = statefulDb({ ...emptyRow, service_contact_name: 'Sample Spouse', service_contact_phone: '+15550100123', service_contact_role: 'spouse_partner' });
    let updatesAtHook = -1;
    const res = await persistCallSecondaryContact('cust-1', spouse, { ...onSite, beforeStamp: async () => { updatesAtHook = state.updates.length; } });
    expect(res).toBe('consent_upgraded_phone_on_record');
    expect(updatesAtHook).toBe(0);
    expect(state.updates[0]).toHaveProperty('service_contacts_consent_at');
  });

  test('the loop claims the opt-in inside beforeStamp and dispatches only after a committed write', () => {
    const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    expect(src).toContain('beforeStamp: claimOptinBeforeStamp');
    expect(src).toContain("['written', 'written_consent_withheld', 'consent_upgraded_phone_on_record', 'skipped_phone_on_record_consent_withheld'].includes(result) && claimedOptins.length && claimedCustRow");
  });
});

// Round 5 (pre-push codex P1s on #5467).
describe('round 5: contractions, generic affirmations, subject pronouns', () => {
  const say = (agent, caller) => [`Agent: ${agent}`, `Caller: ${caller}`].join('\n');
  const base = {
    first_name: 'Sample', last_name: 'Spouse', phone: '+15550100123', role: 'spouse_partner', wants_notifications: true,
    wants_appointment_texts: true, on_site: true,
  };

  test('negative contractions never ground', () => {
    for (const quote of ["He doesn't want appointment texts", "She didn't ask for reminders", "He wouldn't want the tracking link", "He hasn't got a phone", "He isn't going to be there", "They weren't home"]) {
      expect(verifyOnSiteGrounding({ ...base, wants_appointment_texts_quote: quote, on_site_quote: quote }, say('Should we text him the reminders? Will he be there?', quote))).toMatchObject({ wants_appointment_texts: false, on_site: false });
    }
  });

  test('an all-affirmative/filler quote of ANY length is prompt-bound', () => {
    const t = say('Is the name spelled S-A-M?', "Yes, that's correct.");
    expect(verifyOnSiteGrounding({ ...base, wants_appointment_texts_quote: "Yes, that's correct" }, t).wants_appointment_texts).toBe(false);
    const ok = say('Should we text him the appointment reminders?', "Yes, that's correct.");
    expect(verifyOnSiteGrounding({ ...base, wants_appointment_texts_quote: "Yes, that's correct" }, ok).wants_appointment_texts).toBe(true);
    // Longer all-filler phrases too.
    expect(verifyOnSiteGrounding({ ...base, wants_appointment_texts_quote: 'Yes of course that works' }, say('What is your zip code?', 'Yes of course that works.')).wants_appointment_texts).toBe(false);
    // A substantive quote keeps the plain rule.
    expect(verifyOnSiteGrounding({ ...base, wants_appointment_texts_quote: 'Please text him the reminders on Tuesday' }, say('What is your zip code?', 'Please text him the reminders on Tuesday.')).wants_appointment_texts).toBe(true);
  });

  test('subject pronouns count as a recipient reference', () => {
    const t = say('Should he get appointment reminders?', 'Yes.');
    expect(verifyOnSiteGrounding({ ...base, wants_appointment_texts_quote: 'Yes.' }, t).wants_appointment_texts).toBe(true);
    // Still needs a texts phrase: a bare pronoun question is not enough.
    expect(verifyOnSiteGrounding({ ...base, wants_appointment_texts_quote: 'Yes.' }, say('Is he your husband?', 'Yes.')).wants_appointment_texts).toBe(false);
  });
});

describe('round 5: singleton / mirrored array[0] canonicalization', () => {
  const entry = (flags) => ({
    name_full: 'Sample Spouse', first_name: 'Sample', last_name: 'Spouse', phone_e164: '+15550100123', email: null,
    role: 'spouse_partner', wants_notifications: true, ...flags,
  });
  const evidence = [
    { field_path: '/secondary_contacts/0/wants_appointment_texts', quote: 'Yeah.', speaker: 'caller' },
    { field_path: '/secondary_contacts/0/on_site', quote: 'he will be there all day', speaker: 'caller' },
  ];
  test('singleton without the fields + same-person array[0] with both true + evidence -> merged contact qualifies', () => {
    const v2 = { secondary_contact: entry({}), secondary_contacts: [entry({ wants_appointment_texts: true, on_site: true })], evidence };
    const merged = resolveCallSecondaryContact({}, v2);
    expect(merged).toMatchObject({ wants_appointment_texts: true, on_site: true, wants_appointment_texts_quote: 'Yeah.', on_site_quote: 'he will be there all day' });
    expect(onSiteNotifyConsent(merged)).toBe(true);
    // resolveCallSecondaryContacts keeps it as entry 0 (no duplicate).
    expect(resolveCallSecondaryContacts({}, v2)).toHaveLength(1);
  });
  test('a DIFFERENT person in array[0] never lends its flags', () => {
    const other = entry({ wants_appointment_texts: true, on_site: true });
    other.name_full = 'Other Tenant'; other.first_name = 'Other'; other.last_name = 'Tenant'; other.phone_e164 = '+15550100888';
    const v2 = { secondary_contact: entry({}), secondary_contacts: [other], evidence };
    expect(onSiteNotifyConsent(resolveCallSecondaryContact({}, v2))).toBe(false);
  });
});

describe('round 5: the on-site rule needs a live opt-in rail', () => {
  const spouse = { first_name: 'Sample', last_name: 'Spouse', phone: '+15550100123', role: 'spouse_partner', wants_notifications: true, wants_appointment_texts: true, on_site: true };
  test('rail dark: no on-site consent (so no stamp and no claim); explicit V2 consent is unaffected', () => {
    expect(resolveSecondaryConsent(spouse, false, { optinRailLive: false }).smsConsentExplicit).toBe(false);
    expect(resolveSecondaryConsent(spouse, false, { optinRailLive: true }).smsConsentExplicit).toBe(true);
    expect(resolveSecondaryConsent(spouse, true, { optinRailLive: false }).smsConsentExplicit).toBe(true);
    expect(orderSecondaryEntriesForPersistence([{ ...spouse, role: 'lender' }, spouse], false, { optinRailLive: false })[0].role).toBe('lender');
  });
  test('rail dark: the slot still writes, with no stamp; rail live: stamp', async () => {
    const bare = { id: 'cust-1', phone: '+15550100999', email: null,
      service_contact_name: null, service_contact_phone: null, service_contact_email: null,
      service_contact2_name: null, service_contact2_phone: null, service_contact2_email: null,
      service_contact3_name: null, service_contact3_phone: null, service_contact3_email: null };
    const run = async (optinRailLive) => {
      const state = statefulDb(bare);
      const { smsConsentExplicit, smsConsentSource } = resolveSecondaryConsent(spouse, false, { optinRailLive });
      let claimed = 0;
      await persistCallSecondaryContact('cust-1', spouse, { smsConsentExplicit, smsConsentSource, beforeStamp: async () => { claimed += 1; } });
      return { state, claimed };
    };
    const dark = await run(false);
    expect(dark.state.updates[0]).toMatchObject({ service_contact_phone: '+15550100123' });
    expect(dark.state.updates[0]).not.toHaveProperty('service_contacts_consent_at');
    expect(dark.claimed).toBe(0);
    const live = await run(true);
    expect(live.state.updates[0]).toHaveProperty('service_contacts_consent_at');
    expect(live.claimed).toBe(1);
  });
  test('the loop reads the rail once and marks the card optin_rail_dark', () => {
    const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    expect(src).toContain("await require('./recipient-optin').isOptinRailLive()");
    expect(src).toContain("railDarkWithheld ? 'optin_rail_dark'");
  });
  test('isOptinRailLive: gate on AND template active', async () => {
    jest.resetModules();
    const dbMock = jest.fn();
    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => globalThis.__gateOn) }));
    const { isOptinRailLive } = require('../services/recipient-optin');
    const template = (row) => dbMock.mockImplementation(() => ({ where: () => ({ first: async () => row }) }));
    globalThis.__gateOn = false; template({ is_active: true });
    expect(await isOptinRailLive()).toBe(false);
    globalThis.__gateOn = true; template(null);
    expect(await isOptinRailLive()).toBe(false);
    template({ is_active: false });
    expect(await isOptinRailLive()).toBe(false);
    template({ is_active: true });
    expect(await isOptinRailLive()).toBe(true);
    dbMock.mockImplementation(() => { throw new Error('boom'); });
    expect(await isOptinRailLive()).toBe(false);
    jest.dontMock('../config/feature-gates');
    jest.resetModules();
  });
});

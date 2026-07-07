/**
 * Multi-property + promised-quote call handling.
 *
 * Pins the contract that closed a real 2026-07-07 multi-property quote call: a caller
 * who gives TWO addresses on one call keeps BOTH (primary in the flat fields,
 * the rest in additional_properties), and a call where the agent promised to
 * send a quote afterwards must NOT auto-convert its lead to `won` when the
 * pipeline also books an appointment — the lead stays open in the pipeline
 * until the quote is actually worked.
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
  convertCallLeadOnPhoneBooking,
  resolveCallAdditionalProperties,
  resolveCallQuoteSignals,
  normalizeCallExtraction,
} = _test;
const { flatView, mapAdditionalPropertiesToLegacy } = require('../utils/extraction-compat');
const { validateModelOutput } = require('../schemas/validate-extraction');
const { canAutoRoute, ADVISORY_TRIAGE_FLAGS } = require('../services/call-triage-flags');

// ─── extraction normalization ──────────────────────────────────────────────

describe('normalizeCallExtraction — additional_properties + quote flags', () => {
  test('keeps well-formed additional properties and normalizes components', () => {
    const out = normalizeCallExtraction({
      additional_properties: [
        { address_line1: '456 sample rental ct', city: 'Bradenton', state: 'Florida', zip: '34211-1234', is_rental: true, notes: 'condo, interior only' },
      ],
      quote_requested: true,
      quote_promised: 'true',
    });
    expect(out.additional_properties).toHaveLength(1);
    expect(out.additional_properties[0]).toMatchObject({
      city: 'Bradenton',
      state: 'FL',
      zip: '34211',
      is_rental: true,
      notes: 'condo, interior only',
    });
    expect(out.additional_properties[0].address_line1).toMatch(/sample rental ct/i);
    expect(out.quote_requested).toBe(true);
    expect(out.quote_promised).toBe(true);
  });

  test('drops entries without a street, caps the list, and defaults flags to false', () => {
    const out = normalizeCallExtraction({
      additional_properties: [
        { city: 'Sarasota', zip: '34236' }, // no street → dropped
        null,
        'garbage',
        ...Array.from({ length: 8 }, (_, i) => ({ address_line1: `${i + 1} Main St`, city: 'Bradenton', zip: '34211' })),
      ],
      quote_requested: 'yes', // junk → false
      quote_promised: null,
    });
    expect(out.additional_properties.length).toBe(5); // MAX_ADDITIONAL_PROPERTIES cap
    expect(out.additional_properties.every((p) => p.address_line1)).toBe(true);
    expect(out.quote_requested).toBe(false);
    expect(out.quote_promised).toBe(false);
  });

  test('absent fields normalize to empty array / false (legacy extractions unaffected)', () => {
    const out = normalizeCallExtraction({ first_name: 'Casey' });
    expect(out.additional_properties).toEqual([]);
    expect(out.quote_requested).toBe(false);
    expect(out.quote_promised).toBe(false);
  });
});

// ─── V2 → flat mapping ──────────────────────────────────────────────────────

describe('flatView / mapAdditionalPropertiesToLegacy', () => {
  const v2 = {
    meta: { schema_version: '1.1.0', is_voicemail: false, is_spam: false, transcript_word_count: 10, call_summary: 's' },
    caller: { first_name: 'Casey', last_name: 'Landlord' },
    property: {
      service_address: { street_line_1: '123 Sample Home Way', city: 'Bradenton', state: 'FL', postal_code: '34211' },
      additional_properties: [
        { street_line_1: '456 Sample Rental Ct', city: 'Bradenton', state: 'FL', postal_code: '34211', occupancy: 'rental_investment', property_type: 'condo', notes: 'interior only' },
        { street_line_1: null }, // no street → dropped
      ],
    },
    service_request: { quote_requested: true, quote_promised: true },
    scheduling: { status: 'confirmed', confirmed_start_at: '2026-07-15T12:00:00-04:00' },
  };

  test('maps V2 additional_properties to the legacy flat shape', () => {
    const flat = flatView(v2);
    expect(flat.additional_properties).toHaveLength(1);
    expect(flat.additional_properties[0]).toEqual({
      address_line1: '456 Sample Rental Ct',
      address_line2: null,
      city: 'Bradenton',
      state: 'FL',
      zip: '34211',
      is_rental: true,
      property_type: 'condo',
      notes: 'interior only',
    });
    expect(flat.quote_requested).toBe(true);
    expect(flat.quote_promised).toBe(true);
  });

  test('mapAdditionalPropertiesToLegacy tolerates non-arrays', () => {
    expect(mapAdditionalPropertiesToLegacy(null)).toEqual([]);
    expect(mapAdditionalPropertiesToLegacy('x')).toEqual([]);
  });
});

// ─── resolver helpers ───────────────────────────────────────────────────────

describe('resolveCallAdditionalProperties / resolveCallQuoteSignals', () => {
  test('prefers V1 entries, falls back to V2', () => {
    const v1Entry = [{ address_line1: '1 A St', city: 'Venice', zip: '34285', is_rental: false }];
    expect(resolveCallAdditionalProperties({ additional_properties: v1Entry }, null)).toEqual(v1Entry);
    const v2 = { property: { additional_properties: [{ street_line_1: '2 B St', city: 'Parrish', postal_code: '34219' }] } };
    const fromV2 = resolveCallAdditionalProperties({ additional_properties: [] }, v2);
    expect(fromV2).toHaveLength(1);
    expect(fromV2[0].address_line1).toBe('2 B St');
  });

  test('quote signals union both extractors and require literal true', () => {
    expect(resolveCallQuoteSignals({ quote_promised: true }, null)).toEqual({ quoteRequested: false, quotePromised: true });
    expect(resolveCallQuoteSignals({}, { service_request: { quote_requested: true } }))
      .toEqual({ quoteRequested: true, quotePromised: false });
    expect(resolveCallQuoteSignals({ quote_promised: 'yes' }, { service_request: { quote_promised: null } }))
      .toEqual({ quoteRequested: false, quotePromised: false });
  });
});

// ─── schema + routing gate ──────────────────────────────────────────────────

describe('schema 1.1.0 additions + advisory routing', () => {
  function validExtraction() {
    return {
      meta: { is_voicemail: false, is_spam: false, transcript_word_count: 100, call_summary: 'Two rentals, quarterly pest, quote promised.' },
      caller: { first_name: 'Casey', last_name: 'Landlord', relationship_to_property: 'owner', on_site_authorization: true, decision_maker_present: true, phone_source: 'both' },
      consent: { sms_consent_given: false, sms_consent_quote: null, call_recording_disclosed: true, do_not_contact_request: false },
      property: {
        service_address: { raw_text: '123 Sample Home Way', street_line_1: '123 Sample Home Way', street_line_2: null, city: 'Bradenton', state: 'FL', postal_code: '34211', county: 'Manatee', subdivision_or_community: null, normalization_status: 'not_attempted' },
        property_type: 'single_family',
        hoa_community_flag: true,
        hoa_common_area_service: false,
        additional_properties: [
          { raw_text: '456 Sample Rental Ct', street_line_1: '456 Sample Rental Ct', street_line_2: null, city: 'Bradenton', state: 'FL', postal_code: '34211', subdivision_or_community: 'Example Country Club', property_type: 'condo', occupancy: 'rental_investment', notes: 'interior only, HOA covers exterior' },
        ],
      },
      service_request: { primary_service_category: 'pest_general', service_intent: 'recurring_membership_inquiry', urgency: 'scheduling_flexible', pests_observed: [], pests_observed_status: 'not_observed_preventative', quote_requested: true, quote_promised: true },
      customer_history: { status: 'new_customer', prior_complaint_mentioned: false },
      sentiment_and_lead: { sentiment: 'positive', lead_quality: 'hot' },
      confidence: { overall: 0.95, caller_identity: 0.95, service_address: 0.9, primary_service_category: 0.95, urgency: 0.9, scheduling_window: 0.95, property_type: 0.9, consent_capture: 0.9 },
      triage_flags: ['multi_property_call', 'quote_promised'],
    };
  }

  test('extraction with additional_properties + quote flags validates', () => {
    const { valid, errors } = validateModelOutput(validExtraction());
    expect(errors).toBeNull();
    expect(valid).toBe(true);
  });

  test('multi_property_call and quote_promised are advisory — they never block auto-routing', () => {
    expect(ADVISORY_TRIAGE_FLAGS.has('multi_property_call')).toBe(true);
    expect(ADVISORY_TRIAGE_FLAGS.has('quote_promised')).toBe(true);
    const extraction = {
      ...validExtraction(),
      scheduling: { status: 'confirmed', confirmed_start_at: '2026-07-15T12:00:00-04:00' },
      // strip flags the deterministic pass doesn't emit for this shape
      consent: { sms_consent_given: true, sms_consent_quote: 'yes text me', call_recording_disclosed: true, do_not_contact_request: false },
    };
    const result = canAutoRoute(extraction, {
      addressValidation: { status: 'validated_accept', inServiceArea: true },
    });
    // The two new flags may appear in result.flags but must not block.
    if (!result.allowed) {
      expect(result.appointmentBlockingFlags || []).not.toContain('multi_property_call');
      expect(result.appointmentBlockingFlags || []).not.toContain('quote_promised');
    } else {
      expect(result.allowed).toBe(true);
    }
  });
});

// ─── lead conversion: quote pending keeps the lead open ─────────────────────

// Mirrors the stub style of call-lead-booking-conversion.test.js.
function makeInner({ convertible = { id: 'lead-1' } } = {}) {
  const writes = { updates: [], inserts: [] };
  const inner = jest.fn((table) => {
    const b = {
      _table: table,
      where: jest.fn((arg) => { if (typeof arg === 'function') arg(b); return b; }),
      whereNull: jest.fn(() => b),
      orWhere: jest.fn(() => b),
      whereNotIn: jest.fn(() => b),
      first: jest.fn(async () => (table === 'leads' ? convertible : null)),
      update: jest.fn(async (payload) => { writes.updates.push({ table, payload }); return 1; }),
      insert: jest.fn(async (payload) => { writes.inserts.push({ table, payload }); return [1]; }),
    };
    return b;
  });
  inner._writes = writes;
  return inner;
}
const makeTrx = (inner) => ({ transaction: jest.fn(async (fn) => fn(inner)) });

describe('convertCallLeadOnPhoneBooking — keepOpenForQuote', () => {
  const ARGS = { leadId: 'lead-1', customerId: 'cust-1', scheduledServiceId: 'svc-1', callSid: 'CA-test' };

  test('quote pending: claims an OPEN lead without touching status, won, or the customer', async () => {
    const inner = makeInner({ convertible: { id: 'lead-1', status: 'new' } });
    const converted = await convertCallLeadOnPhoneBooking(makeTrx(inner), { ...ARGS, keepOpenForQuote: true });
    expect(converted).toBe(false);
    const leadUpdates = inner._writes.updates.filter((w) => w.table === 'leads');
    expect(leadUpdates).toHaveLength(1);
    expect(leadUpdates[0].payload.status).toBeUndefined();
    expect(leadUpdates[0].payload.customer_id).toBe('cust-1');
    expect(leadUpdates[0].payload.converted_at).toBeUndefined();
    // no customers write (promoteCustomerOnBooking not reached)
    expect(inner._writes.updates.some((w) => w.table === 'customers')).toBe(false);
    // timeline records the booking with the quote-pending trigger
    const activity = inner._writes.inserts.find((w) => w.table === 'lead_activities');
    expect(activity).toBeTruthy();
    expect(activity.payload.activity_type).toBe('appointment_booked');
    expect(JSON.parse(activity.payload.metadata).triggerSource).toBe('appointment_booked_quote_pending');
  });

  test('quote pending: a CLOSED (lost/unresponsive) reused lead is reopened to new', async () => {
    const inner = makeInner({ convertible: { id: 'lead-1', status: 'lost' } });
    const converted = await convertCallLeadOnPhoneBooking(makeTrx(inner), { ...ARGS, keepOpenForQuote: true });
    expect(converted).toBe(false);
    const leadUpdates = inner._writes.updates.filter((w) => w.table === 'leads');
    expect(leadUpdates).toHaveLength(1);
    expect(leadUpdates[0].payload.status).toBe('new');
    expect(leadUpdates[0].payload.converted_at).toBeUndefined();
  });

  test('default path still converts to won', async () => {
    const inner = makeInner();
    const converted = await convertCallLeadOnPhoneBooking(makeTrx(inner), ARGS);
    expect(converted).toBe(true);
    const wonWrite = inner._writes.updates.find((w) => w.table === 'leads' && w.payload.status === 'won');
    expect(wonWrite).toBeTruthy();
  });
});

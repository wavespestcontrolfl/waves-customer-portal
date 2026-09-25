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
  bookingPreDraftAssessmentDrafted,
  rerunAssessmentPreDraftAfterQuarantineClear,
  normalizeCallExtraction,
} = _test;
// ONE shared resolver + formatter for the processor gate and the engine
// backstop (codex #4815 r6 P2).
const { resolveCallAgreedPrice, formatAgreedPriceLabel } = require('../utils/call-agreed-price');
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
      occupancy: 'rental_investment',
      is_primary_residence: null,
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

// ─── owner ruling 2026-09-24: the spoken word beats the estimator ──────────
// The $300 flea call — "just to confirm one more time, it's $300, that's
// two treatments" / "Yep" — still spawned a $387 estimator-engine draft two
// minutes later. resolveCallAgreedPrice must return the accepted amount so
// the engine can be skipped for exactly that call, and null for every call
// where the caller has not actually accepted a price yet.
//
// codex #4815 r1 P1s: (1) service_request.quoted_price_usd — the schema's
// OWN narrower "agent quoted AND caller accepted" total — counts as agreed
// on its own, independent of the broader price/prices[] object; (2) V2
// ONLY — downstream composer decisions read the validated V2 extraction
// plus the raw transcript, never the unvalidated V1 blob, so with no valid
// V2 extraction this always returns null and the engine runs as before.
//
// codex #4815 r3 P2: returns { amount, amountMax? } (not a bare number) so
// a genuinely accepted RANGE ("$90 to $100") is never collapsed to its low
// end — amount_usd is defined as the range's LOW end and amount_max_usd
// the HIGH end (schema description + the prompt's own "$90 to 100"
// example), so reporting amount alone as an exact figure ("$90 agreed")
// misrepresents what the caller actually accepted.
describe('resolveCallAgreedPrice', () => {
  test('V2 price.accepted: an accepted EXACT price with a finite positive amount is returned, no amountMax', () => {
    const v2 = { service_request: { price: { amount_usd: 300, accepted: true, caller_response: 'accepted', stated_by: 'agent' } } };
    expect(resolveCallAgreedPrice(v2)).toEqual({ amount: 300 });
  });

  test('V2 price.accepted: a genuine accepted RANGE carries amountMax through', () => {
    const v2 = { service_request: { price: { amount_usd: 90, amount_max_usd: 100, accepted: true, caller_response: 'accepted' } } };
    expect(resolveCallAgreedPrice(v2)).toEqual({ amount: 90, amountMax: 100 });
  });

  test('a NON-range price.amount_max_usd (absent, equal, or lower than amount_usd) never adds amountMax', () => {
    expect(resolveCallAgreedPrice({ service_request: { price: { amount_usd: 300, amount_max_usd: null, accepted: true } } })).toEqual({ amount: 300 });
    expect(resolveCallAgreedPrice({ service_request: { price: { amount_usd: 300, amount_max_usd: 300, accepted: true } } })).toEqual({ amount: 300 });
    expect(resolveCallAgreedPrice({ service_request: { price: { amount_usd: 300, amount_max_usd: 250, accepted: true } } })).toEqual({ amount: 300 });
  });

  test('V2 quoted_price_usd: a finite positive value is agreed on its own, with no price object at all — always EXACT, never a range', () => {
    // codex #4815 r3 P2: quoted_price_usd is defined by the extraction
    // prompt as null whenever the amount is "uncertain OR A RANGE" — it
    // never itself carries a paired max, so this path stays exact.
    expect(resolveCallAgreedPrice({ service_request: { quoted_price_usd: 300 } })).toEqual({ amount: 300 });
  });

  test('V2 quoted_price_usd wins even when the broader price object is absent/null/unaccepted', () => {
    expect(resolveCallAgreedPrice({ service_request: { quoted_price_usd: 300, price: null } })).toEqual({ amount: 300 });
    expect(resolveCallAgreedPrice({ service_request: { quoted_price_usd: 300, price: { amount_usd: 387, accepted: false } } })).toEqual({ amount: 300 });
  });

  test('a stated price the caller declined or is still considering returns null', () => {
    const declined = { service_request: { price: { amount_usd: 387, accepted: false, caller_response: 'declined' } } };
    expect(resolveCallAgreedPrice(declined)).toBeNull();
    const considering = { service_request: { price: { amount_usd: 387, accepted: null, caller_response: 'not_at_issue' } } };
    expect(resolveCallAgreedPrice(considering)).toBeNull();
  });

  test('accepted but non-finite/zero/negative amount returns null (never a fabricated price), for both fields', () => {
    expect(resolveCallAgreedPrice({ service_request: { price: { amount_usd: null, accepted: true } } })).toBeNull();
    expect(resolveCallAgreedPrice({ service_request: { price: { amount_usd: 0, accepted: true } } })).toBeNull();
    expect(resolveCallAgreedPrice({ service_request: { price: { amount_usd: -50, accepted: true } } })).toBeNull();
    expect(resolveCallAgreedPrice({ service_request: { price: { amount_usd: NaN, accepted: true } } })).toBeNull();
    expect(resolveCallAgreedPrice({ service_request: { quoted_price_usd: 0 } })).toBeNull();
    expect(resolveCallAgreedPrice({ service_request: { quoted_price_usd: -50 } })).toBeNull();
    expect(resolveCallAgreedPrice({ service_request: { quoted_price_usd: null } })).toBeNull();
  });

  test('no price at all (quote requested only, nothing agreed) returns null', () => {
    expect(resolveCallAgreedPrice({ service_request: { quote_requested: true } })).toBeNull();
    expect(resolveCallAgreedPrice(null)).toBeNull();
    expect(resolveCallAgreedPrice({})).toBeNull();
    expect(resolveCallAgreedPrice({ service_request: {} })).toBeNull();
  });

  // codex #4815 r6 P2: the accepted billing unit and every accepted
  // component (upfront + recurring) ride along — "$90 per quarter" agreed
  // is never reported as a bare "$90.00".
  test('the accepted billing UNIT rides along (and "unknown" is dropped, not rendered)', () => {
    expect(resolveCallAgreedPrice({ service_request: { price: { amount_usd: 90, unit: 'per_quarter', accepted: true } } }))
      .toEqual({ amount: 90, unit: 'per_quarter' });
    expect(resolveCallAgreedPrice({ service_request: { price: { amount_usd: 90, amount_max_usd: 100, unit: 'per_month', accepted: true } } }))
      .toEqual({ amount: 90, amountMax: 100, unit: 'per_month' });
    expect(resolveCallAgreedPrice({ service_request: { price: { amount_usd: 300, unit: 'unknown', accepted: true } } }))
      .toEqual({ amount: 300 });
  });

  test('quoted_price_usd borrows the unit of the accepted price entry with the SAME amount', () => {
    const v2 = { service_request: { quoted_price_usd: 150, price: { amount_usd: 150, unit: 'per_application', accepted: true } } };
    expect(resolveCallAgreedPrice(v2)).toEqual({ amount: 150, unit: 'per_application' });
  });

  test('an upfront + recurring agreement keeps EVERY accepted component, primary first', () => {
    const upfront = { amount_usd: 150, unit: 'one_time', accepted: true, caller_response: 'accepted' };
    const recurring = { amount_usd: 50, unit: 'per_month', accepted: true, caller_response: 'accepted' };
    const declinedAlt = { amount_usd: 400, unit: 'per_year', accepted: false, caller_response: 'declined' };
    const v2 = { service_request: { price: upfront, prices: [upfront, recurring, declinedAlt] } };
    expect(resolveCallAgreedPrice(v2)).toEqual({
      amount: 150, unit: 'one_time', additionalTerms: [{ amount: 50, unit: 'per_month' }],
    });
  });

  test('with no valid V2 extraction, V1-shaped fields (quoted_price/appointment_confirmed) are NEVER honored — always null', () => {
    // codex #4815 r1 P1: downstream composer decisions never read V1.
    // resolveCallAgreedPrice takes the V2 extraction alone; passing a
    // V1-shaped object in that slot must not be mistaken for V2 and must
    // not gate the engine.
    expect(resolveCallAgreedPrice({ quoted_price: 300, appointment_confirmed: true })).toBeNull();
    expect(resolveCallAgreedPrice(undefined)).toBeNull();
  });
});

describe('formatAgreedPriceLabel', () => {
  test('an exact amount formats as a single figure', () => {
    expect(formatAgreedPriceLabel({ amount: 90 })).toBe('$90.00');
  });

  test('a genuine range formats as low–high, never collapsed to the low end', () => {
    expect(formatAgreedPriceLabel({ amount: 90, amountMax: 100 })).toBe('$90.00–$100.00');
  });

  test('an amountMax that is not actually higher is ignored (defense in depth)', () => {
    expect(formatAgreedPriceLabel({ amount: 90, amountMax: 90 })).toBe('$90.00');
    expect(formatAgreedPriceLabel({ amount: 90, amountMax: 50 })).toBe('$90.00');
  });

  test('renders the full agreed terms — billing unit and every accepted component (codex #4815 r6 P2)', () => {
    expect(formatAgreedPriceLabel({ amount: 90, unit: 'per_quarter' })).toBe('$90.00/quarter');
    expect(formatAgreedPriceLabel({ amount: 90, amountMax: 100, unit: 'per_month' })).toBe('$90.00–$100.00/month');
    expect(formatAgreedPriceLabel({ amount: 150, unit: 'per_application' })).toBe('$150.00 per application');
    expect(formatAgreedPriceLabel({ amount: 300, unit: 'per_year' })).toBe('$300.00/year');
    expect(formatAgreedPriceLabel({ amount: 150, unit: 'one_time', additionalTerms: [{ amount: 50, unit: 'per_month' }] }))
      .toBe('$150.00 one-time + $50.00/month');
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
      forNoKeyUpdate: jest.fn(() => b),
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

// ─── codex #4815 r2 P2 (refined r3 P2): sweep/pre-draft ordering ───────────
// The booking pre-draft hook (quotePromised:true, the documented assessment
// exception) can clear this call's same-generation estimator_draft_block
// while composing an assessment draft; the post-finalization price-agreed
// sweep must wait for that SAME promise to settle before deciding whether
// to re-stamp the block, rather than racing it. bookingPreDraftAssessmentDrafted
// is the isolated, unit-testable decision the sweep chains onto.
//
// codex #4815 r3 P2: keyed on estimateId, NOT the outcome's own `drafted`
// flag — maybeDraftEstimateForCall/maybePreDraftForBooking report
// `drafted: false` for an ALREADY-VALID exception estimate just as often as
// for a genuine skip (an existing/reconciled draft, a duplicate-guard hit,
// or the call-delegated path's own "existing draft recovery" branch all
// carry a real estimateId while `drafted` reads false). Every shape that
// can come back from those two functions is tested here.
// codex #4815 r9 P2: when the pre-finalization invalidation failed, the
// QUEUED agreed-price verdict refused the assessment pre-draft that ran
// first; once the fallback sweep lands and clears that entry, the pre-draft
// is re-run ONCE — and only when the agreed-price verdict was the reason.
describe('rerunAssessmentPreDraftAfterQuarantineClear', () => {
  test('a pre-draft the queued agreed-price verdict refused is re-run once', async () => {
    const rerun = jest.fn(async () => ({ drafted: true, delegated: 'call_engine', estimateId: 'est-assess-2' }));
    const outcome = await rerunAssessmentPreDraftAfterQuarantineClear({
      bookingPreDraftPromise: Promise.resolve({ drafted: false, delegated: 'call_engine', estimateId: null, blockedBy: 'price_agreed_on_call' }),
      rerun,
      callSid: 'CA-r9',
    });
    expect(rerun).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ estimateId: 'est-assess-2' });
  });

  test.each([
    ['a pre-draft that already drafted', { drafted: true, estimateId: 'est-1' }],
    ['a genuine skip (not an assessment)', { drafted: false, skipped: 'not_assessment' }],
    ['a refusal by ANOTHER verdict', { drafted: false, delegated: 'call_engine', estimateId: null, blockedBy: 'email_identity_conflict' }],
    ['a failed hook (null)', null],
  ])('%s is never re-run', async (_label, first) => {
    const rerun = jest.fn();
    await expect(rerunAssessmentPreDraftAfterQuarantineClear({
      bookingPreDraftPromise: Promise.resolve(first), rerun, callSid: 'CA-r9',
    })).resolves.toBeNull();
    expect(rerun).not.toHaveBeenCalled();
  });

  test('no tracked pre-draft (gate off / no booking) re-runs nothing; a re-run failure never throws', async () => {
    await expect(rerunAssessmentPreDraftAfterQuarantineClear({ bookingPreDraftPromise: null, rerun: jest.fn(), callSid: 'CA-r9' })).resolves.toBeNull();
    await expect(rerunAssessmentPreDraftAfterQuarantineClear({
      bookingPreDraftPromise: Promise.resolve({ estimateId: null, blockedBy: 'price_agreed_on_call' }),
      rerun: jest.fn(async () => { throw new Error('composer down'); }),
      callSid: 'CA-r9',
    })).resolves.toBeNull();
  });
});

describe('bookingPreDraftAssessmentDrafted', () => {
  test('no tracked promise (gate off / no booking) never blocks the sweep', async () => {
    expect(await bookingPreDraftAssessmentDrafted(null)).toBe(false);
    expect(await bookingPreDraftAssessmentDrafted(undefined)).toBe(false);
  });

  test('a genuinely SLOW pre-draft promise is awaited to completion — the ordering, not just the value, is real', async () => {
    // A fake promise ordering: resolves on a later microtask/macrotask tick
    // with a fresh draft, proving the helper actually AWAITS the
    // settlement rather than reading a value that happened to be ready
    // synchronously.
    let resolved = false;
    const slowPromise = new Promise((resolve) => {
      setTimeout(() => {
        resolved = true;
        resolve({ drafted: true, estimateId: 'est-assess-1' });
      }, 20);
    });

    const resultPromise = bookingPreDraftAssessmentDrafted(slowPromise);
    // The helper must not have decided yet — the tracked promise has not
    // settled (this assertion would fail if the helper raced ahead).
    expect(resolved).toBe(false);

    const result = await resultPromise;
    expect(resolved).toBe(true);
    expect(result).toBe(true);
  });

  test('a FRESH draft (drafted:true, estimateId set) stands the sweep down', async () => {
    expect(await bookingPreDraftAssessmentDrafted(Promise.resolve({ drafted: true, estimateId: 'est-1' }))).toBe(true);
  });

  test('an EXISTING/reconciled draft (drafted:false, skipped:"already_drafted", estimateId set) ALSO stands the sweep down', async () => {
    // codex #4815 r3 P2: the exact regression — booking-predraft.js returns
    // this shape for a draft the tagger hook already created, and reading
    // `drafted` alone let the sweep archive that live, valid estimate.
    expect(await bookingPreDraftAssessmentDrafted(Promise.resolve({ drafted: false, skipped: 'already_drafted', estimateId: 'est-existing' }))).toBe(true);
  });

  test('a DUPLICATE-guard hit (drafted:false, skipped:"duplicate_open_estimate", estimateId set) ALSO stands the sweep down', async () => {
    expect(await bookingPreDraftAssessmentDrafted(Promise.resolve({ drafted: false, skipped: 'duplicate_open_estimate', estimateId: 'est-dup' }))).toBe(true);
  });

  test('the call-delegated path\'s own "existing draft recovery" (created:false, estimateId set, mapped to drafted:false) ALSO stands the sweep down', async () => {
    // maybeDraftEstimateForCall's re-entry recovery path sets lane:
    // 'existing' + estimateId with created staying false — booking-predraft.js
    // maps that straight through as { drafted: outcome.created === true,
    // estimateId: outcome.estimateId }.
    expect(await bookingPreDraftAssessmentDrafted(Promise.resolve({ drafted: false, delegated: 'call_engine', lane: 'existing', estimateId: 'est-recovered' }))).toBe(true);
  });

  test('a genuine skip with NO estimateId (gate off, not an assessment, booking dead, no customer) lets the sweep proceed', async () => {
    expect(await bookingPreDraftAssessmentDrafted(Promise.resolve({ drafted: false, skipped: 'gate_off' }))).toBe(false);
    expect(await bookingPreDraftAssessmentDrafted(Promise.resolve({ drafted: false, skipped: 'not_assessment' }))).toBe(false);
    expect(await bookingPreDraftAssessmentDrafted(Promise.resolve({ drafted: false, skipped: 'booking_terminal' }))).toBe(false);
    expect(await bookingPreDraftAssessmentDrafted(Promise.resolve({ drafted: false, skipped: 'no_customer' }))).toBe(false);
  });

  test('a genuine composer failure (drafted:false, skipped:"error", no estimateId) lets the sweep proceed', async () => {
    expect(await bookingPreDraftAssessmentDrafted(Promise.resolve({ drafted: false, skipped: 'error' }))).toBe(false);
  });

  test('a null/undefined settled outcome lets the sweep proceed', async () => {
    expect(await bookingPreDraftAssessmentDrafted(Promise.resolve(null))).toBe(false);
    expect(await bookingPreDraftAssessmentDrafted(Promise.resolve(undefined))).toBe(false);
  });

  test('a rejected promise (belt-and-braces — the tracked promise never actually rejects) never blocks the sweep', async () => {
    expect(await bookingPreDraftAssessmentDrafted(Promise.reject(new Error('unexpected')))).toBe(false);
  });
});

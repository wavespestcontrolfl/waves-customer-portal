// Call-agent audit fixes (2026-09-02..08 week, 93 calls graded). Each block
// pins one live miss from the audit and the rule that closes it.
const {
  canAutoRoute, computeDeterministicTriageFlags, statesNewAddress, dispatchesToOnFileAddress,
  isExplicitlyNonOwner, BLOCKING_TRIAGE_FLAGS, deriveCallReviewBridge,
} = require('../services/call-triage-flags');
const { __private: { pushTagFor } } = require('../services/notification-triggers');
const { buildAddressLines } = require('../services/address-validation');
const { decideDisposition } = require('../services/call-disposition');
const { adoptV2PrimaryFields } = require('../utils/extraction-compat');
const { sameSpokenFirstName } = require('../utils/name-match');
const { missedCallEligible } = require('../services/missed-call-bell');
const { repeatCallerPlan, callerKey, REPEAT_THRESHOLD, LEASE_MS } = require('../services/repeat-caller-bell');
const { buildExtractionPrompt } = require('../services/prompts/call-extraction-v1');

const AV_CLEAN = { status: 'validated_accept', inServiceArea: true, county: 'Manatee County' };
const ANI = '+19415550100';
const v2 = (over = {}) => ({
  meta: { schema_version: '1.7.0', is_voicemail: false, is_spam: false, call_summary: 's' },
  caller: { relationship_to_property: 'unknown', on_site_authorization: false },
  property: { service_address: {} },
  scheduling: { status: 'confirmed', confirmed_start_at: '2026-09-11T10:00:00-04:00' },
  confidence: { overall: 0.9 },
  consent: {},
  triage_flags: [],
  ...over,
});

describe('finding 1 — caller_not_authorized fires only for an explicit third party', () => {
  test('relationship classes', () => {
    for (const r of ['owner', 'spouse_partner', 'unknown', null, undefined, '']) expect(isExplicitlyNonOwner(r)).toBe(false);
    for (const r of ['tenant', 'property_manager', 'real_estate_agent', 'lender', 'employee', 'hoa_board_member', 'other']) expect(isExplicitlyNonOwner(r)).toBe(true);
  });

  test('the homeowner cancelling her own visit (audit #9) raises no authorization flag', () => {
    const flags = computeDeterministicTriageFlags(v2({ caller: { relationship_to_property: 'unknown', on_site_authorization: false } }));
    expect(flags).not.toContain('caller_not_authorized');
  });

  test('a tenant with no authorization still does', () => {
    const flags = computeDeterministicTriageFlags(v2({ caller: { relationship_to_property: 'tenant', on_site_authorization: false } }));
    expect(flags).toContain('caller_not_authorized');
  });

  test('a MODEL-emitted flag on an unknown relationship is dropped before routing', () => {
    const r = canAutoRoute(v2({ triage_flags: ['caller_not_authorized'] }), { contactPhone: ANI, addressValidation: AV_CLEAN });
    expect(r.allowed).toBe(true);
    expect(r.flags).not.toContain('caller_not_authorized');
  });

  test('a MODEL-emitted flag on an explicit third party is kept', () => {
    const r = canAutoRoute(v2({ triage_flags: ['caller_not_authorized'], caller: { relationship_to_property: 'property_manager', on_site_authorization: false } }), { contactPhone: ANI, addressValidation: AV_CLEAN });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });
});

describe('finding 2 — low_extraction_confidence threshold is the "very uncertain" boundary', () => {
  test('a clear short call scored 0.6 by the old rubric no longer flags or blocks', () => {
    expect(computeDeterministicTriageFlags(v2({ confidence: { overall: 0.6 } }))).not.toContain('low_extraction_confidence');
    expect(canAutoRoute(v2({ confidence: { overall: 0.6 } }), { contactPhone: ANI, addressValidation: AV_CLEAN }).allowed).toBe(true);
  });
  test('a genuinely garbled extraction (0.3) still flags and blocks', () => {
    expect(computeDeterministicTriageFlags(v2({ confidence: { overall: 0.3 } }))).toContain('low_extraction_confidence');
    expect(canAutoRoute(v2({ confidence: { overall: 0.3 } }), { contactPhone: ANI, addressValidation: AV_CLEAN }).allowed).toBe(false);
  });
  test('the prompt scores fidelity, not completeness', () => {
    const p = buildExtractionPrompt('t', '+19415550100', '2026-09-08');
    expect(p).toMatch(/does NOT lower its section's score/);
    expect(p).toMatch(/Never for owner, spouse_partner, or unknown/);
  });
});

describe('finding 3 — address fragments and on-file restatements', () => {
  const onFile = { hasAddress: true, addressLine1: '1234 Sample Palm Dr', addressLine2: null, addressCity: 'Parrish', addressZip: '34219' };

  test('a bare house number is not sent to Google', () => {
    expect(buildAddressLines({ street_line_1: '2468' })).toEqual([]);
    expect(buildAddressLines({ street_line_1: '2468', city: 'Bradenton', state: 'FL' })).toEqual(['Bradenton FL']);
    expect(buildAddressLines({ street_line_1: '2468', street_line_2: 'Apt 4', city: 'Bradenton' })).toEqual(['Bradenton']); // codex r2: a unit is not a street name
    expect(buildAddressLines({ street_line_1: '2468 Sample Palm Street', city: 'Bradenton' })).toEqual(['2468 Sample Palm Street', 'Bradenton']);
  });

  test('"I\'m in Parrish" from the Parrish customer is a restatement, not a new address (audit #58)', () => {
    const ex = v2({ property: { service_address: { city: 'Parrish', raw_text: "I'm in Parrish." } } });
    expect(statesNewAddress(ex)).toBe(true);
    expect(statesNewAddress(ex, onFile)).toBe(false);
    expect(dispatchesToOnFileAddress(ex, { failOpen: true, knownCustomer: onFile })).toBe(true);
  });

  test('restating the on-file street books on the on-file address', () => {
    const ex = v2({ property: { service_address: { street_line_1: '1234 Sample Palm Drive', city: 'Parrish' } }, triage_flags: ['address_unverified'] });
    const r = canAutoRoute(ex, { contactPhone: ANI, failOpen: true, knownCustomer: onFile, addressValidation: { status: 'missing_component', inServiceArea: true } });
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toContain('address_unverified');
  });

  test('a DIFFERENT city, ZIP, street or a unit is still a new address', () => {
    expect(statesNewAddress(v2({ property: { service_address: { city: 'Sarasota' } } }), onFile)).toBe(true);
    expect(statesNewAddress(v2({ property: { service_address: { postal_code: '34203' } } }), onFile)).toBe(true);
    expect(statesNewAddress(v2({ property: { service_address: { street_line_1: '1236 Sample Palm Dr' } } }), onFile)).toBe(true);
    expect(statesNewAddress(v2({ property: { service_address: { street_line_1: '1234 Other Grove Cir' } } }), onFile)).toBe(true);
    expect(statesNewAddress(v2({ property: { service_address: { unit: 'Apt 4B' } } }), onFile)).toBe(true);
    expect(statesNewAddress(v2({ property: { service_address: { subdivision_or_community: 'Lakewood Ranch' } } }), onFile)).toBe(true);
  });

  test('raw_text only: accepted when it carries the on-file house number and street word', () => {
    expect(statesNewAddress(v2({ property: { service_address: { raw_text: 'twelve thirty four sample palm, same as before' } } }), onFile)).toBe(true);
    expect(statesNewAddress(v2({ property: { service_address: { raw_text: '1234 sample palm, same as before' } } }), onFile)).toBe(false);
  });

  test('no on-file address → every stated component is new (unchanged contract)', () => {
    expect(statesNewAddress(v2({ property: { service_address: { city: 'Parrish' } } }), { hasAddress: false })).toBe(true);
    expect(statesNewAddress(v2({ property: { service_address: { city: 'Parrish' } } }), null)).toBe(true);
  });
});

describe('finding 5/6 — repeat callers and spoken-name variants', () => {
  test('Jayson is the same spoken name as Jason; Bob is Robert; Ann is not Anna-Maria', () => {
    expect(sameSpokenFirstName('jason', 'jayson')).toBe(true);
    expect(sameSpokenFirstName('debbie', 'debbi')).toBe(true);
    expect(sameSpokenFirstName('bob', 'robert')).toBe(true);
    expect(sameSpokenFirstName('amy', 'ami')).toBe(false); // too short to trust one edit
    expect(sameSpokenFirstName('karen', 'kevin')).toBe(false);
    expect(sameSpokenFirstName('', 'jason')).toBe(false);
  });

  test('repeat-caller plan: three calls in the window ring once, a booking or a prior ring silences', () => {
    const now = Date.parse('2026-09-06T18:00:00Z');
    const at = (minsAgo, extra = {}) => ({ created_at: new Date(now - minsAgo * 60000).toISOString(), status: 'completed', answered_by: 'voicemail', ...extra });
    expect(repeatCallerPlan([at(6), at(30)], now)).toBeNull();
    const plan = repeatCallerPlan([at(6), at(30), at(90, { answered_by: 'human' })], now);
    expect(plan).toEqual(expect.objectContaining({ count: REPEAT_THRESHOLD, unanswered: 2 }));
    expect(repeatCallerPlan([at(6), at(30), at(200)], now)).toBeNull(); // third call outside 3h
    expect(repeatCallerPlan([at(6), at(30, { repeat_caller_alerted_at: '2026-09-06T17:30:00Z' }), at(90)], now)).toBeNull();
    expect(repeatCallerPlan([at(6), at(30, { booked: true }), at(90)], now)).toBeNull();
    // codex r3: a live lease is another worker delivering; a stale one is a dead worker's and is reclaimable
    expect(repeatCallerPlan([at(6), at(30, { repeat_caller_claim: new Date(now - 60000).toISOString() }), at(90)], now)).toBeNull();
    expect(repeatCallerPlan([at(6), at(30, { repeat_caller_claim: new Date(now - LEASE_MS - 1000).toISOString() }), at(90)], now)).not.toBeNull();
  });

  test('repeat-caller identity is the full E.164 number, not a ten-digit suffix (r3 P2)', () => {
    expect(callerKey('+19415550100')).toBe('19415550100');
    expect(callerKey('9415550100')).toBe('19415550100');
    expect(callerKey('+449415550100')).toBe('449415550100');
    expect(callerKey('+449415550100')).not.toBe(callerKey('+19415550100'));
    expect(callerKey('anonymous')).toBeNull();
  });
});

describe('finding 4 — missed-call bell for unknown callers (GATE_MISSED_CALL_UNKNOWN_CALLERS)', () => {
  const base = { direction: 'inbound', customer_id: null, from_phone: '+19415550123', answered_by: 'voicemail', recording_sid: null, call_outcome: null, metadata: { location: 'GBP — Sarasota' } };
  test('gate off → customers only, as before', () => {
    expect(missedCallEligible(base)).toBe(false);
    expect(missedCallEligible({ ...base, customer_id: 'c1' })).toBe(true);
  });
  test('gate on → an unknown dialable number rings; withheld ID, sandbox and Nomorobo spam stay quiet', () => {
    const on = { unknownCallers: true };
    expect(missedCallEligible(base, Date.now(), on)).toBe(true);
    expect(missedCallEligible({ ...base, from_phone: 'anonymous' }, Date.now(), on)).toBe(false);
    expect(missedCallEligible({ ...base, source: 'voice_relay_sandbox' }, Date.now(), on)).toBe(false);
    const spam = { ...base, metadata: { addons: { results: { nomorobo_spamscore: { status: 'successful', result: { score: 1 } } } } } };
    expect(missedCallEligible(spam, Date.now(), on)).toBe(false);
    const clean = { ...base, metadata: { addons: { results: { nomorobo_spamscore: { status: 'successful', result: { score: 0 } } } } } };
    expect(missedCallEligible(clean, Date.now(), on)).toBe(true);
  });
});

describe('finding 7 — a V2 not-spam verdict overrides the V1 spam call', () => {
  const v1Spam = { is_spam: true, call_type: 'spam', lead_quality: 'cold', first_name: 'Alba' };
  test('property manager / vendor with is_spam_content=false is NOT spam (audit #20, #37)', () => {
    const { merged } = adoptV2PrimaryFields({ ...v1Spam }, v2({ call_nature: 'vendor_or_partner', spam_verdict: { is_spam_content: false, spam_kind: 'not_spam' }, recommended_disposition: 'callback_task_created' }));
    expect(merged.is_spam).toBe(false);
  });
  test('the cleared vendor call is legacy call_type other, not spam (r3 P2)', () => {
    const { merged } = adoptV2PrimaryFields({ ...v1Spam }, v2({ call_nature: 'vendor_or_partner', spam_verdict: { is_spam_content: false, spam_kind: 'not_spam' } }));
    expect(merged.call_type).toBe('other');
    expect(merged.is_lead).toBe(false);
    const kept = adoptV2PrimaryFields({ ...v1Spam }, v2({ call_nature: 'vendor_or_partner', spam_verdict: null })).merged;
    expect(kept.call_type).toBe('spam');
  });
  test('a hard-spam nature keeps the discard even with a stray not-spam verdict', () => {
    const { merged } = adoptV2PrimaryFields({ ...v1Spam }, v2({ call_nature: 'spam_solicitation', spam_verdict: { is_spam_content: false, spam_kind: 'not_spam' } }));
    expect(merged.is_spam).toBe(true);
  });
  test('no verdict → V1 spam still wins (unchanged)', () => {
    const { merged } = adoptV2PrimaryFields({ ...v1Spam }, v2({ call_nature: 'vendor_or_partner', spam_verdict: null }));
    expect(merged.is_spam).toBe(true);
  });
  test('V2 content-spam still raises the flag on a clean V1', () => {
    const { merged } = adoptV2PrimaryFields({ is_spam: false }, v2({ call_nature: 'robocall', spam_verdict: { is_spam_content: true, spam_kind: 'robocall' } }));
    expect(merged.is_spam).toBe(true);
  });
});

describe('finding 8 — urgency is not a complaint', () => {
  test('a known customer who wants someone out today is not escalated as a complaint (audit #61, #67)', () => {
    const { disposition } = decideDisposition({
      extraction: { service_request: { urgency: 'emergency_same_day', quote_requested: true }, triage_flags: [] },
      outcome: { isKnownCustomer: true },
    });
    expect(disposition).not.toBe('complaint_escalated');
  });
  test('a prior complaint from a known customer still escalates', () => {
    const { disposition } = decideDisposition({
      extraction: { customer_history: { prior_complaint_mentioned: true }, triage_flags: [] },
      outcome: { isKnownCustomer: true },
    });
    expect(disposition).toBe('complaint_escalated');
  });
  test('scheduling-change holds are still blocking flags', () => {
    for (const f of ['cancellation_request', 'reschedule_or_cancel', 'existing_appointment_coordination']) expect(BLOCKING_TRIAGE_FLAGS.has(f)).toBe(true);
  });
});

describe('codex round 1', () => {
  test('a restated unit keeps its digits: Apt 5B is a new address, #4B and Unit 4-B are the on-file one (P1)', () => {
    const condo = { hasAddress: true, addressLine1: '500 Sample Tower Blvd', addressLine2: 'Apt 4B', addressCity: 'Sarasota', addressZip: '34240' };
    const stated = (unit) => v2({ property: { service_address: { street_line_1: '500 Sample Tower Blvd', unit } } });
    expect(statesNewAddress(stated('Apt 5B'), condo)).toBe(true);
    expect(statesNewAddress(stated('#4B'), condo)).toBe(false);
    expect(statesNewAddress(stated('Unit 4-B'), condo)).toBe(false);
    expect(statesNewAddress(stated('Apt 4B'), { ...condo, addressLine2: null })).toBe(true);
  });

  test('Mary and Gary on one household line are two people; mid-word drift is still one name (P1)', () => {
    expect(sameSpokenFirstName('mary', 'gary')).toBe(false);
    expect(sameSpokenFirstName('kevin', 'devin')).toBe(false);
    expect(sameSpokenFirstName('jason', 'jayson')).toBe(true);
    expect(sameSpokenFirstName('debbie', 'debbi')).toBe(true);
    expect(sameSpokenFirstName('dana', 'dane')).toBe(false); // four letters: too short to trust one edit
    expect(sameSpokenFirstName('karen', 'karin')).toBe(false); // codex r2: a same-length substitution is a different name (Maria / Marie are one via the nickname table, not this rule)
    expect(sameSpokenFirstName('jennifer', 'jenifer')).toBe(true); // a dropped letter is drift
    expect(sameSpokenFirstName('hannah', 'hanna')).toBe(true); // silent final h
    expect(sameSpokenFirstName('julia', 'julian')).toBe(false); // codex r4: an appended letter is a different name
    expect(sameSpokenFirstName('andre', 'andrea')).toBe(false);
  });

  test('a unit spoken inside raw_text is compared too (r2 P1)', () => {
    const condo = { hasAddress: true, addressLine1: '500 Sample Tower Blvd', addressLine2: 'Apt 4B', addressCity: 'Sarasota', addressZip: '34240' };
    const raw = (raw_text) => v2({ property: { service_address: { raw_text } } });
    expect(statesNewAddress(raw('500 sample tower apt 5b'), condo)).toBe(true);
    expect(statesNewAddress(raw('500 Sample Tower Blvd #4B'), condo)).toBe(false);
    expect(statesNewAddress(raw('500 sample tower, unit 4-b'), condo)).toBe(false);
    expect(statesNewAddress(raw('500 sample tower apt 4b'), { ...condo, addressLine2: null })).toBe(true);
    // codex r3: the structured street must not answer before the raw unit is compared
    expect(statesNewAddress(v2({ property: { service_address: { street_line_1: '500 Sample Tower Blvd', raw_text: '500 Sample Tower Blvd Apt 5B' } } }), condo)).toBe(true);
    expect(statesNewAddress(v2({ property: { service_address: { street_line_1: '500 Sample Tower Blvd', raw_text: '500 Sample Tower Blvd Apt 4B' } } }), condo)).toBe(false);
  });

  test('raw street names match as whole tokens, so a directional prefix cannot vouch for another street (r3 P1)', () => {
    const lake = { hasAddress: true, addressLine1: '123 W Lake Dr', addressLine2: null, addressCity: 'Sarasota', addressZip: '34240' };
    const raw = (raw_text) => v2({ property: { service_address: { raw_text } } });
    expect(statesNewAddress(raw('123 New Palm Ave'), lake)).toBe(true);
    expect(statesNewAddress(raw('123 Wrong Road'), lake)).toBe(true);
    expect(statesNewAddress(raw('123 w lake, same place'), lake)).toBe(false);
  });

  test('a raw street with no house number is new-address evidence even beside a matching city (r4 P1)', () => {
    const lake = { hasAddress: true, addressLine1: '123 W Lake Dr', addressLine2: null, addressCity: 'Sarasota', addressZip: '34240' };
    const said = (raw_text, extra = {}) => v2({ property: { service_address: { raw_text, ...extra } } });
    expect(statesNewAddress(said('Oak Avenue, Sarasota', { city: 'Sarasota' }), lake)).toBe(true);
    expect(statesNewAddress(said('over on Oak Avenue'), lake)).toBe(true);
    expect(statesNewAddress(said('on W Lake, same place', { city: 'Sarasota' }), lake)).toBe(false);
    expect(statesNewAddress(said("I'm in Sarasota, same place", { city: 'Sarasota' }), lake)).toBe(false);
  });

  test('raw words naming another street override a structured street that happens to match the file (r5 P1)', () => {
    const palm = { hasAddress: true, addressLine1: '1234 Sample Palm Dr', addressLine2: null, addressCity: 'Parrish', addressZip: '34219' };
    const both = (raw_text) => v2({ property: { service_address: { street_line_1: '1234 Sample Palm Drive', raw_text } } });
    expect(statesNewAddress(both('9876 Other Grove Circle, Parrish'), palm)).toBe(true);
    expect(statesNewAddress(both('1236 Sample Palm Drive'), palm)).toBe(true);
    expect(statesNewAddress(both('1234 sample palm drive, same as always'), palm)).toBe(false);
    expect(statesNewAddress(both('yes, same place'), palm)).toBe(false);
  });

  test.each([
    '1234 Sample Palm Grove Circle',
    '1234 Grove Sample Palm Circle',
    '1234 Palm Sample Drive',
    '1234 Sample Palm Drive North',
    '1234 Sample Palm Street Drive',
  ])('the complete raw street name must agree before reusing the on-file address: %s', (raw_text) => {
    const palm = { hasAddress: true, addressLine1: '1234 Sample Palm Dr', addressCity: 'Parrish', addressZip: '34219' };
    for (const street_line_1 of [undefined, '1234 Sample Palm Drive']) {
      const ex = v2({ property: { service_address: { raw_text, street_line_1 } }, triage_flags: ['address_unverified'] });
      expect(statesNewAddress(ex, palm)).toBe(true);
      expect(dispatchesToOnFileAddress(ex, { failOpen: true, knownCustomer: palm })).toBe(false);
      expect(canAutoRoute(ex, {
        contactPhone: ANI, failOpen: true, knownCustomer: palm,
        addressValidation: { status: 'missing_component', inServiceArea: true },
      }).allowed).toBe(false);
    }
  });

  test('a complete raw address still accepts matching locality and unit components', () => {
    const condo = { hasAddress: true, addressLine1: '500 Sample Tower Blvd', addressLine2: 'Apt 4B', addressCity: 'Sarasota', addressZip: '34240' };
    const ex = v2({ property: { service_address: { raw_text: '500 Sample Tower Boulevard Apt 4B Sarasota FL 34240' } } });
    expect(statesNewAddress(ex, condo)).toBe(false);
  });

  test('a trailing street direction must agree and must not be discarded as a locality', () => {
    const north = { hasAddress: true, addressLine1: '1234 Sample Palm Dr North', addressCity: 'Parrish', addressZip: '34219' };
    const stated = raw_text => v2({ property: { service_address: { raw_text } } });
    expect(statesNewAddress(stated('1234 Sample Palm Drive North'), north)).toBe(false);
    expect(statesNewAddress(stated('1234 Sample Palm Drive South'), north)).toBe(true);
    expect(statesNewAddress(stated('1234 Sample Palm Drive North, Sarasota'), north)).toBe(true);
  });

  test.each(['restricted', '+7378742833', '7378742833', '+17378742833', '+86282452253'])('withheld caller %s cannot ring either bell', (from_phone) => {
    expect(callerKey(from_phone)).toBeNull();
    expect(missedCallEligible({ direction: 'inbound', customer_id: null, from_phone, answered_by: 'missed' }, Date.now(), { unknownCallers: true })).toBe(false);
  });

  test('the shadow bridge applies the same relationship rule as routing (P2)', () => {
    const base = { addressValidation: { status: 'validated_accept' }, extracted: { first_name: 'Ann', last_name: 'Lee' }, v2TriageFlags: ['caller_not_authorized'] };
    expect(deriveCallReviewBridge({ ...base }).needsConfirmation).not.toContain('caller_not_authorized');
    expect(deriveCallReviewBridge({ ...base, callerRelationship: 'unknown' }).needsConfirmation).not.toContain('caller_not_authorized');
    expect(deriveCallReviewBridge({ ...base, callerRelationship: 'spouse_partner' }).needsConfirmation).not.toContain('caller_not_authorized');
    expect(deriveCallReviewBridge({ ...base, callerRelationship: 'tenant' }).needsConfirmation).toContain('caller_not_authorized');
    expect(deriveCallReviewBridge({ ...base, callerRelationship: 'property_manager' }).needsConfirmation).toContain('caller_not_authorized');
  });

  test('repeat-caller pushes carry a per-call tag (P2)', () => {
    expect(pushTagFor('repeat_caller', { callLogId: 'c-1' })).toBe('waves-repeat_caller-c-1');
    expect(pushTagFor('repeat_caller', { callLogId: 'c-2' })).not.toBe(pushTagFor('repeat_caller', { callLogId: 'c-1' }));
  });
});

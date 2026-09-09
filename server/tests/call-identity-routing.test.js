const { canAutoRoute, computeDeterministicTriageFlags, isExplicitlyNonOwner, BLOCKING_TRIAGE_FLAGS, deriveCallReviewBridge } = require('../services/call-triage-flags');
const { decideDisposition } = require('../services/call-disposition');
const { adoptV2PrimaryFields } = require('../utils/extraction-compat');
const { sameSpokenFirstName } = require('../utils/name-match');
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

describe('finding 5/6 — repeat callers and spoken-name variants', () => {
  test('Jayson is the same spoken name as Jason; Bob is Robert; Ann is not Anna-Maria', () => {
    expect(sameSpokenFirstName('jason', 'jayson')).toBe(true);
    expect(sameSpokenFirstName('debbie', 'debbi')).toBe(true);
    expect(sameSpokenFirstName('bob', 'robert')).toBe(true);
    expect(sameSpokenFirstName('amy', 'ami')).toBe(false); // too short to trust one edit
    expect(sameSpokenFirstName('karen', 'kevin')).toBe(false);
    expect(sameSpokenFirstName('', 'jason')).toBe(false);
  });
  test.each([['aisha', 'alisha'], ['sarah', 'sahar'], ['janet', 'jeanet']])('an unlisted spelling difference cannot merge %s and %s', (a, b) => {
    expect(sameSpokenFirstName(a, b)).toBe(false);
    expect(sameSpokenFirstName(b, a)).toBe(false);
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

describe('regressions', () => {
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

  test('the shadow bridge applies the same relationship rule as routing (P2)', () => {
    const base = { addressValidation: { status: 'validated_accept' }, extracted: { first_name: 'Ann', last_name: 'Lee' }, v2TriageFlags: ['caller_not_authorized'] };
    expect(deriveCallReviewBridge({ ...base }).needsConfirmation).not.toContain('caller_not_authorized');
    expect(deriveCallReviewBridge({ ...base, callerRelationship: 'unknown' }).needsConfirmation).not.toContain('caller_not_authorized');
    expect(deriveCallReviewBridge({ ...base, callerRelationship: 'spouse_partner' }).needsConfirmation).not.toContain('caller_not_authorized');
    expect(deriveCallReviewBridge({ ...base, callerRelationship: 'tenant' }).needsConfirmation).toContain('caller_not_authorized');
    expect(deriveCallReviewBridge({ ...base, callerRelationship: 'property_manager' }).needsConfirmation).toContain('caller_not_authorized');
  });
});

// Owner ruling 2026-09-28: a family member of the homeowner/resident
// (grandchild, child, parent, sibling, in-law, etc.) booking service at THAT
// RELATIVE'S home, with a time CONFIRMED on the call, is an authorized
// caller — the call agent must book instead of hard-blocking on
// caller_not_authorized. Live miss (call f5a54dbd, 2026-09-28, inbound): the
// caller booked a paper-wasp nest knockdown ($175) at "my grandfather's
// house", confirmed for Sun Oct 4 11am, and the booking blocked with
// routing.reason "triage_flags" / appointment_blocking_flags
// ["caller_not_authorized"] because the pre-1.18.0 schema had no enum value
// for a family caller other than "other", which also covers strangers.
//
// Deliberately independent of isAuthorizedWdoArrangerBooking: this covers
// ANY service type, not just WDO inspections, and rests on the FAMILY
// relationship rather than a recognized professional arranger role.
//
// Anonymized extraction shapes only — no real names/emails/phones.
const {
  isAuthorizedFamilyMemberBooking,
  suppressUnsupportedModelFlags,
  computeDeterministicTriageFlags,
  canAutoRoute,
} = require('../services/call-triage-flags');

const AV_CLEAN = { status: 'validated_accept', inServiceArea: true, county: 'Manatee County' };
const ANI = '+19415550100';

// Mirrors the f5a54dbd shape: a grandchild booking a one-time treatment at
// her grandfather's house, staff offered a slot, caller confirmed it.
function familyExtraction(over = {}) {
  return {
    meta: { schema_version: '1.18.0', is_voicemail: false, is_spam: false, call_summary: 'Grandchild booking a paper-wasp nest knockdown at her grandfather’s house.' },
    caller: { relationship_to_property: 'family_member', on_site_authorization: false },
    property: { service_address: { street_line_1: '4313 Example Dr', city: 'Sarasota', postal_code: '34232', county: 'Sarasota' } },
    service_request: {
      primary_service_category: 'pest_general',
      specific_service_name: 'Paper Wasp Nest Knockdown',
      service_intent: 'active_infestation_treatment',
      urgency: 'within_one_week',
      pests_observed: ['wasps'],
      pests_observed_status: 'confirmed',
    },
    scheduling: { status: 'confirmed', confirmed_start_at: '2026-10-04T11:00:00-04:00' },
    confidence: { overall: 0.9, service_address: 0.9 },
    consent: {},
    triage_flags: [],
    ...over,
  };
}

describe('isAuthorizedFamilyMemberBooking (predicate)', () => {
  test('family_member + confirmed with a start time is authorized', () => {
    expect(isAuthorizedFamilyMemberBooking(familyExtraction())).toBe(true);
  });

  test('authorized for ANY service type, not just WDO — the f5a54dbd shape (paper-wasp knockdown)', () => {
    expect(isAuthorizedFamilyMemberBooking(familyExtraction())).toBe(true);
  });

  test('authorized for a WDO inspection too (no service-type restriction)', () => {
    const wdo = familyExtraction({
      service_request: {
        primary_service_category: 'wdo',
        specific_service_name: 'WDO Inspection Service',
        service_intent: 'inspection_only',
        urgency: 'within_one_week',
        pests_observed: [],
        pests_observed_status: 'not_discussed',
      },
    });
    expect(isAuthorizedFamilyMemberBooking(wdo)).toBe(true);
  });

  test('case/whitespace on the relationship is normalized', () => {
    expect(isAuthorizedFamilyMemberBooking(familyExtraction({ caller: { relationship_to_property: ' Family_Member ', on_site_authorization: false } }))).toBe(true);
  });

  test('unconfirmed scheduling status does not qualify — today’s behavior is kept', () => {
    for (const status of ['requested', 'offered', 'ambiguous', 'none', 'reschedule_requested']) {
      expect(isAuthorizedFamilyMemberBooking(familyExtraction({ scheduling: { status, confirmed_start_at: null } }))).toBe(false);
    }
  });

  test('confirmed with no confirmed_start_at does not qualify', () => {
    expect(isAuthorizedFamilyMemberBooking(familyExtraction({ scheduling: { status: 'confirmed', confirmed_start_at: null } }))).toBe(false);
  });

  test.each(['spouse_partner', 'other', 'tenant', 'property_manager', 'hoa_board_member', 'employee', 'real_estate_agent', 'lender', 'home_buyer', 'owner', 'unknown'])(
    '%s is NOT covered by this ruling even with a confirmed time',
    (relationship) => {
      expect(isAuthorizedFamilyMemberBooking(familyExtraction({ caller: { relationship_to_property: relationship, on_site_authorization: false } }))).toBe(false);
    }
  );

  test('missing/null extraction does not throw', () => {
    expect(isAuthorizedFamilyMemberBooking(null)).toBe(false);
    expect(isAuthorizedFamilyMemberBooking(undefined)).toBe(false);
    expect(isAuthorizedFamilyMemberBooking({})).toBe(false);
  });
});

describe('computeDeterministicTriageFlags — family member demotion', () => {
  test('family_member + confirmed raises no caller_not_authorized', () => {
    const flags = computeDeterministicTriageFlags(familyExtraction());
    expect(flags).not.toContain('caller_not_authorized');
  });

  test('family_member but only requested (not confirmed) still raises the flag', () => {
    const flags = computeDeterministicTriageFlags(familyExtraction({ scheduling: { status: 'requested', confirmed_start_at: null } }));
    expect(flags).toContain('caller_not_authorized');
  });

  test('"other" (unspecified third party) + confirmed still raises the flag — the exact pre-1.18.0 shape that missed call f5a54dbd', () => {
    const flags = computeDeterministicTriageFlags(familyExtraction({ caller: { relationship_to_property: 'other', on_site_authorization: false } }));
    expect(flags).toContain('caller_not_authorized');
  });

  test('spouse_partner never reaches this predicate — OWNER_EQUIVALENT_RELATIONSHIPS never raises caller_not_authorized for it in the first place', () => {
    const flags = computeDeterministicTriageFlags(familyExtraction({ caller: { relationship_to_property: 'spouse_partner', on_site_authorization: false } }));
    expect(flags).not.toContain('caller_not_authorized');
  });

  test('property_manager + confirmed still raises the flag (not covered by the family-member ruling)', () => {
    const flags = computeDeterministicTriageFlags(familyExtraction({ caller: { relationship_to_property: 'property_manager', on_site_authorization: false } }));
    expect(flags).toContain('caller_not_authorized');
  });
});

describe('suppressUnsupportedModelFlags — family member', () => {
  test('the model copy of caller_not_authorized is dropped for an authorized family member', () => {
    expect(suppressUnsupportedModelFlags(['caller_not_authorized', 'no_sms_consent_captured'], familyExtraction()))
      .toEqual(['no_sms_consent_captured']);
  });

  test('the model copy survives for an unconfirmed family_member call', () => {
    const unconfirmed = familyExtraction({ scheduling: { status: 'requested', confirmed_start_at: null } });
    expect(suppressUnsupportedModelFlags(['caller_not_authorized'], unconfirmed)).toEqual(['caller_not_authorized']);
  });

  test('the model copy survives for "other" even with a confirmed time', () => {
    const other = familyExtraction({ caller: { relationship_to_property: 'other', on_site_authorization: false } });
    expect(suppressUnsupportedModelFlags(['caller_not_authorized'], other)).toEqual(['caller_not_authorized']);
  });
});

describe('canAutoRoute — the pipeline decision for an f5a54dbd-shaped call', () => {
  test('family_member + confirmed: deterministic AND model-emitted caller_not_authorized are both suppressed; no blocking flags', () => {
    const r = canAutoRoute(familyExtraction({ triage_flags: ['caller_not_authorized'] }), {
      contactPhone: ANI,
      addressValidation: AV_CLEAN,
    });
    expect(r.allowed).toBe(true);
    expect(r.flags || []).not.toContain('caller_not_authorized');
    expect(r.appointmentBlockingFlags || []).not.toContain('caller_not_authorized');
    expect(r.failedOpenFlags || []).not.toContain('caller_not_authorized');
  });

  test('family_member but status is offered (not confirmed): still blocked', () => {
    const r = canAutoRoute(familyExtraction({ scheduling: { status: 'offered', confirmed_start_at: null } }), {
      contactPhone: ANI,
      addressValidation: AV_CLEAN,
    });
    expect(r.allowed).toBe(false);
  });

  test('"other" + confirmed: still blocked on caller_not_authorized (the exact live-miss shape before schema 1.18.0)', () => {
    const r = canAutoRoute(familyExtraction({ caller: { relationship_to_property: 'other', on_site_authorization: false } }), {
      contactPhone: ANI,
      addressValidation: AV_CLEAN,
    });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });
});

describe('decision version — family-member contract is versioned and listed', () => {
  const { V2_DECISION_VERSION, V2_DECISION_VERSIONS } = require('../services/call-routing-gates');

  test('v2-1.49.0 is listed after the home_buyer WDO-arranger contract (v2-1.48.0)', () => {
    expect(V2_DECISION_VERSIONS).toContain('v2-1.49.0');
    expect(V2_DECISION_VERSIONS.indexOf('v2-1.49.0')).toBeGreaterThan(V2_DECISION_VERSIONS.indexOf('v2-1.48.0'));
    expect(V2_DECISION_VERSIONS.indexOf(V2_DECISION_VERSION)).toBeGreaterThanOrEqual(V2_DECISION_VERSIONS.indexOf('v2-1.49.0'));
  });

  test('V2_DECISION_VERSIONS ends with the current V2_DECISION_VERSION', () => {
    expect(V2_DECISION_VERSIONS[V2_DECISION_VERSIONS.length - 1]).toBe(V2_DECISION_VERSION);
  });
});

// Same source-pinning style as call-wdo-arranger-authorization.test.js's own
// P2 coverage: the card-retirement finalization transaction is deep inside
// processRecording's giant closure, so this pins that the family-member
// authorization is actually wired into the SAME retire block the WDO
// arranger contract uses, rather than standing up a live integration test.
describe('force-reprocess card retirement — family member authorization retires the stale caller_not_authorized card', () => {
  const fs = require('fs');
  const source = fs.readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');

  test('familyMemberAuthorizedThisPass is computed from isAuthorizedFamilyMemberBooking on the valid V2 result', () => {
    expect(source).toContain('const familyMemberAuthorizedThisPass = v2Result?.status === \'valid\' && isAuthorizedFamilyMemberBooking(v2Result.extraction);');
  });

  test('the retire condition covers either authorization path', () => {
    expect(source).toContain("(wdoArrangerAuthorizedThisPass || familyMemberAuthorizedThisPass)");
  });

  test('the resolution note cites the 2026-09-28 owner ruling for the family-member path', () => {
    expect(source).toContain('a family member booking service at their relative’s home with a confirmed time is an authorized caller (owner ruling 2026-09-28)');
  });

  test('isAuthorizedFamilyMemberBooking is imported from call-triage-flags', () => {
    const importLine = source.split('\n').find((l) => l.includes("require('./call-triage-flags')"));
    expect(importLine).toBeTruthy();
    expect(importLine).toContain('isAuthorizedFamilyMemberBooking');
  });
});

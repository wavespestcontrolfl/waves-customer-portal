// Owner ruling 2026-09-26: a lender or realtor ARRANGING a WDO inspection is
// an authorized caller when staff agreed the time on the call — the same bar
// a homeowner's own booking meets. Live miss (call 17ed9362, 2026-09-24,
// inbound): a lender ordering a refinance WDO inspection, confirmed for 10am
// Monday, blocked with routing.reason "triage_flags" solely on
// caller_not_authorized. The general agent-commitment demotion
// (hasAgentCommittedEvidence, closed-vocabulary grammar) did NOT clear it —
// the agent's quote ("But yeah, we'll see him on Monday at 10 o'clock.") had
// no am/pm and out-of-vocabulary words — and this ruling is deliberately a
// separate, narrower rule that does not touch that grammar.
//
// Anonymized extraction shapes only — no real names/emails/phones.
const {
  isAuthorizedWdoArrangerBooking,
  isWdoInspectionRequest,
  computeDeterministicTriageFlags,
  canAutoRoute,
} = require('../services/call-triage-flags');

const AV_CLEAN = { status: 'validated_accept', inServiceArea: true, county: 'Manatee County' };
const ANI = '+19415550100';

// Mirrors the 17ed9362 shape: lender arranging a refinance WDO inspection,
// staff offered a slot, caller confirmed it.
function wdoExtraction(over = {}) {
  return {
    meta: { schema_version: '1.14.0', is_voicemail: false, is_spam: false, call_summary: 'Lender arranging a refinance WDO inspection.' },
    caller: { relationship_to_property: 'lender', on_site_authorization: false },
    property: { service_address: { street_line_1: '123 Example St', city: 'Bradenton', postal_code: '34205', county: 'Manatee' } },
    service_request: {
      primary_service_category: 'wdo',
      specific_service_name: 'WDO Inspection Service',
      service_intent: 'inspection_only',
      urgency: 'within_one_week',
      pests_observed: [],
      pests_observed_status: 'not_discussed',
    },
    scheduling: { status: 'confirmed', confirmed_start_at: '2026-09-28T10:00:00-04:00' },
    confidence: { overall: 0.9, service_address: 0.9 },
    consent: {},
    triage_flags: [],
    ...over,
  };
}

describe('isAuthorizedWdoArrangerBooking (predicate)', () => {
  test('lender + WDO + confirmed with a start time is authorized', () => {
    expect(isAuthorizedWdoArrangerBooking(wdoExtraction())).toBe(true);
  });

  test('real_estate_agent + WDO + confirmed is authorized', () => {
    expect(isAuthorizedWdoArrangerBooking(wdoExtraction({ caller: { relationship_to_property: 'real_estate_agent', on_site_authorization: false } }))).toBe(true);
  });

  test('case/whitespace on the relationship is normalized', () => {
    expect(isAuthorizedWdoArrangerBooking(wdoExtraction({ caller: { relationship_to_property: ' Lender ', on_site_authorization: false } }))).toBe(true);
  });

  test('requested/offered scheduling status does not qualify', () => {
    for (const status of ['requested', 'offered', 'ambiguous', 'none']) {
      expect(isAuthorizedWdoArrangerBooking(wdoExtraction({ scheduling: { status, confirmed_start_at: null } }))).toBe(false);
    }
  });

  test('confirmed with no confirmed_start_at does not qualify', () => {
    expect(isAuthorizedWdoArrangerBooking(wdoExtraction({ scheduling: { status: 'confirmed', confirmed_start_at: null } }))).toBe(false);
  });

  test.each(['property_manager', 'other', 'tenant', 'hoa_board_member', 'employee'])(
    '%s is NOT covered by this ruling even with WDO + confirmed',
    (relationship) => {
      expect(isAuthorizedWdoArrangerBooking(wdoExtraction({ caller: { relationship_to_property: relationship, on_site_authorization: false } }))).toBe(false);
    }
  );

  test('a non-WDO service (general pest) does not qualify even for a lender', () => {
    expect(isAuthorizedWdoArrangerBooking(wdoExtraction({
      service_request: {
        primary_service_category: 'pest_general',
        specific_service_name: 'General Pest Control',
        service_intent: 'active_infestation_treatment',
        urgency: 'within_one_week',
        pests_observed: [],
        pests_observed_status: 'not_discussed',
      },
    }))).toBe(false);
  });

  // codex #4966 r1 P1: a treatment (or any non-inspection) intent fails
  // closed even with a catalog-looking "WDO Inspection Service" name.
  test.each(['active_infestation_treatment', 'preventative_one_time', 'quote_only', undefined])(
    'service_intent %s never qualifies, even named "WDO Inspection Service"',
    (intent) => {
      expect(isWdoInspectionRequest({ service_intent: intent, primary_service_category: 'wdo', specific_service_name: 'WDO Inspection Service' })).toBe(false);
      const sr = { ...wdoExtraction().service_request, service_intent: intent, specific_service_name: 'WDO Inspection Service' };
      expect(isAuthorizedWdoArrangerBooking(wdoExtraction({ service_request: sr }))).toBe(false);
      expect(computeDeterministicTriageFlags(wdoExtraction({ service_request: sr }))).toContain('caller_not_authorized');
    }
  );

  // codex #4966 r2 P1: the name is an exact-name ALLOWLIST, so inflected or
  // extra treatment wording can never slip past a blocklist.
  test.each([
    'WDO inspection and treatments', 'WDO Retreatment', 'WDO inspection (tented)',
    'WDO inspection, baited', 'WDO fumigated inspection', 'WDO Inspection + Termite Treatment',
    'WDO Inspection and Repair', 'Termite Inspection Service', 'WDO Inspection Service for treatment',
  ])('name %p never qualifies', (name) => {
    expect(isWdoInspectionRequest({ service_intent: 'inspection_only', primary_service_category: 'wdo', specific_service_name: name })).toBe(false);
  });
  test.each([
    'WDO', 'WDO Inspection', 'WDO Inspection Service', 'wdo inspection report',
    'Wood-Destroying Organism Inspection', 'Wood Destroying Organisms (WDO) Inspection',
    'WDO clearance letter', 'WDO Inspection Certificate',
  ])('name %p qualifies', (name) => {
    expect(isWdoInspectionRequest({ service_intent: 'inspection_only', primary_service_category: 'wdo', specific_service_name: name })).toBe(true);
  });

  test('isWdoInspectionRequest matches on category or specific name', () => {
    expect(isWdoInspectionRequest({ service_intent: 'inspection_only', primary_service_category: 'wdo', specific_service_name: null })).toBe(true);
    expect(isWdoInspectionRequest({ service_intent: 'inspection_only', primary_service_category: 'inspection_only', specific_service_name: 'WDO Inspection Service' })).toBe(true);
    expect(isWdoInspectionRequest({ service_intent: 'inspection_only', primary_service_category: 'pest_general', specific_service_name: 'General Pest Control' })).toBe(false);
  });
});

describe('computeDeterministicTriageFlags — WDO arranger demotion', () => {
  test('lender + WDO + confirmed raises no caller_not_authorized', () => {
    const flags = computeDeterministicTriageFlags(wdoExtraction());
    expect(flags).not.toContain('caller_not_authorized');
  });

  test('real_estate_agent + WDO + confirmed raises no caller_not_authorized', () => {
    const flags = computeDeterministicTriageFlags(wdoExtraction({ caller: { relationship_to_property: 'real_estate_agent', on_site_authorization: false } }));
    expect(flags).not.toContain('caller_not_authorized');
  });

  test('lender + WDO but only requested (not confirmed) still raises the flag', () => {
    const flags = computeDeterministicTriageFlags(wdoExtraction({ scheduling: { status: 'requested', confirmed_start_at: null } }));
    expect(flags).toContain('caller_not_authorized');
  });

  test('property_manager + WDO + confirmed still raises the flag', () => {
    const flags = computeDeterministicTriageFlags(wdoExtraction({ caller: { relationship_to_property: 'property_manager', on_site_authorization: false } }));
    expect(flags).toContain('caller_not_authorized');
  });

  test('other (buyer under contract) + WDO + confirmed still raises the flag', () => {
    const flags = computeDeterministicTriageFlags(wdoExtraction({ caller: { relationship_to_property: 'other', on_site_authorization: false } }));
    expect(flags).toContain('caller_not_authorized');
  });

  test('tenant + WDO + confirmed still raises the flag', () => {
    const flags = computeDeterministicTriageFlags(wdoExtraction({ caller: { relationship_to_property: 'tenant', on_site_authorization: false } }));
    expect(flags).toContain('caller_not_authorized');
  });

  test('lender + non-WDO service (general pest) + confirmed still raises the flag', () => {
    const flags = computeDeterministicTriageFlags(wdoExtraction({
      service_request: {
        primary_service_category: 'pest_general',
        specific_service_name: 'General Pest Control',
        service_intent: 'active_infestation_treatment',
        urgency: 'within_one_week',
        pests_observed: [],
        pests_observed_status: 'not_discussed',
      },
    }));
    expect(flags).toContain('caller_not_authorized');
  });
});

describe('canAutoRoute — the pipeline decision for a 17ed9362-shaped call', () => {
  test('lender + WDO + confirmed: deterministic AND model-emitted caller_not_authorized are both suppressed; no blocking flags', () => {
    const r = canAutoRoute(wdoExtraction({ triage_flags: ['caller_not_authorized'] }), {
      contactPhone: ANI,
      addressValidation: AV_CLEAN,
    });
    expect(r.allowed).toBe(true);
    expect(r.flags || []).not.toContain('caller_not_authorized');
    expect(r.appointmentBlockingFlags || []).not.toContain('caller_not_authorized');
    // No advisory "confirm the account holder" card either — the owner ruled
    // the arranger IS authorized.
    expect(r.failedOpenFlags || []).not.toContain('caller_not_authorized');
  });

  test('real_estate_agent + WDO + confirmed: same result', () => {
    const r = canAutoRoute(wdoExtraction({
      caller: { relationship_to_property: 'real_estate_agent', on_site_authorization: false },
      triage_flags: ['caller_not_authorized'],
    }), { contactPhone: ANI, addressValidation: AV_CLEAN });
    expect(r.allowed).toBe(true);
    expect(r.appointmentBlockingFlags || []).not.toContain('caller_not_authorized');
    expect(r.failedOpenFlags || []).not.toContain('caller_not_authorized');
  });

  test('lender + WDO but status is offered (not confirmed): still blocked', () => {
    const r = canAutoRoute(wdoExtraction({ scheduling: { status: 'offered', confirmed_start_at: null } }), {
      contactPhone: ANI,
      addressValidation: AV_CLEAN,
    });
    expect(r.allowed).toBe(false);
  });

  test('property_manager + WDO + confirmed: still blocked on caller_not_authorized', () => {
    const r = canAutoRoute(wdoExtraction({ caller: { relationship_to_property: 'property_manager', on_site_authorization: false } }), {
      contactPhone: ANI,
      addressValidation: AV_CLEAN,
    });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('other (buyer under contract) + WDO + confirmed: still blocked', () => {
    const r = canAutoRoute(wdoExtraction({ caller: { relationship_to_property: 'other', on_site_authorization: false } }), {
      contactPhone: ANI,
      addressValidation: AV_CLEAN,
    });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('tenant + WDO + confirmed: still blocked', () => {
    const r = canAutoRoute(wdoExtraction({ caller: { relationship_to_property: 'tenant', on_site_authorization: false } }), {
      contactPhone: ANI,
      addressValidation: AV_CLEAN,
    });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('lender + non-WDO service (general pest) + confirmed: still blocked', () => {
    const r = canAutoRoute(wdoExtraction({
      service_request: {
        primary_service_category: 'pest_general',
        specific_service_name: 'General Pest Control',
        service_intent: 'active_infestation_treatment',
        urgency: 'within_one_week',
        pests_observed: [],
        pests_observed_status: 'not_discussed',
      },
    }), { contactPhone: ANI, addressValidation: AV_CLEAN });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('lender + WDO + confirmed but out_of_service_area also present: still blocked by the OTHER hard flag', () => {
    const r = canAutoRoute(wdoExtraction({
      property: { service_address: { street_line_1: '9 Rural Rd', city: 'Nowhere', postal_code: '00000', county: 'Lee' } },
    }), { contactPhone: ANI, addressValidation: { status: 'out_of_service_area', inServiceArea: false, county: 'Lee County' } });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('out_of_service_area');
    expect(r.appointmentBlockingFlags).not.toContain('caller_not_authorized');
  });

  test('direction independence: canAutoRoute takes no direction input — an outbound call with the identical extraction reaches the same decision', () => {
    // canAutoRoute/computeDeterministicTriageFlags never read call direction;
    // the opts shape below is exactly what an OUTBOUND call site passes
    // (agentCommitFailOpen is disabled for outbound elsewhere, but this
    // ruling does not depend on that opt at all).
    const outboundOpts = { contactPhone: ANI, addressValidation: AV_CLEAN, agentCommitFailOpen: false, failOpen: false };
    const inboundOpts = { contactPhone: ANI, addressValidation: AV_CLEAN, agentCommitFailOpen: true, failOpen: true };
    const rOutbound = canAutoRoute(wdoExtraction(), outboundOpts);
    const rInbound = canAutoRoute(wdoExtraction(), inboundOpts);
    expect(rOutbound.allowed).toBe(true);
    expect(rInbound.allowed).toBe(true);
  });
});

// Codex #4890 r1 follow-ups.
describe('codex #4890 r1 — audit trail and shadow bridge', () => {
  const {
    suppressUnsupportedModelFlags,
    deriveCallReviewBridge,
  } = require('../services/call-triage-flags');
  const { V2_DECISION_VERSION, V2_DECISION_VERSIONS } = require('../services/call-routing-gates');

  test('the exported model-flag suppression drops the model copy for an authorized arranger (used by the processor finalFlags merges)', () => {
    expect(suppressUnsupportedModelFlags(['caller_not_authorized', 'no_sms_consent_captured'], wdoExtraction()))
      .toEqual(['no_sms_consent_captured']);
  });

  test('the model copy survives for a buyer (relationship other)', () => {
    const buyer = wdoExtraction({ caller: { relationship_to_property: 'other', on_site_authorization: false } });
    expect(suppressUnsupportedModelFlags(['caller_not_authorized'], buyer)).toEqual(['caller_not_authorized']);
  });

  test('the route-decision version is bumped for the new routing contract and stays in the version list', () => {
    // Later bumps (v2-1.45.0 outbound parity, #4912) move the current
    // version on; the arranger contract's version must stay listed.
    expect(V2_DECISION_VERSIONS).toEqual(expect.arrayContaining(['v2-1.43.0', 'v2-1.44.0']));
    expect(V2_DECISION_VERSIONS.indexOf(V2_DECISION_VERSION)).toBeGreaterThanOrEqual(V2_DECISION_VERSIONS.indexOf('v2-1.44.0'));
  });

  test('shadow bridge: without a (valid) V2 extraction the caller_not_authorized reason still files', () => {
    const out = deriveCallReviewBridge({
      addressValidation: AV_CLEAN,
      extracted: { address_line1: '123 Example St', city: 'Bradenton', zip: '34205', first_name: 'Pat', last_name: 'Example' },
      v2TriageFlags: ['caller_not_authorized'],
      callerRelationship: 'lender',
      v2Extraction: null,
    });
    expect(out.needsConfirmation).toContain('caller_not_authorized');
  });

  test('shadow bridge: a valid authorized-arranger extraction files no caller_not_authorized reason', () => {
    const out = deriveCallReviewBridge({
      addressValidation: AV_CLEAN,
      extracted: { address_line1: '123 Example St', city: 'Bradenton', zip: '34205', first_name: 'Pat', last_name: 'Example' },
      v2TriageFlags: ['caller_not_authorized'],
      callerRelationship: 'lender',
      v2Extraction: wdoExtraction(),
    });
    expect(out.needsConfirmation).not.toContain('caller_not_authorized');
  });
});

describe('codex #4890 r5/r6 — WDO identity and elapsed agreed days', () => {
  const { arrangerSlotElapsed } = require('../services/call-recording-processor')._test;

  test('a named non-WDO service is not a WDO request even when the category says wdo', () => {
    const contradictory = wdoExtraction({
      service_request: { service_intent: 'inspection_only', primary_service_category: 'wdo', specific_service_name: 'Termite Inspection Service' },
    });
    expect(isAuthorizedWdoArrangerBooking(contradictory)).toBe(false);
    expect(computeDeterministicTriageFlags(contradictory, { contactPhone: ANI, addressValidation: AV_CLEAN })).toContain('caller_not_authorized');
  });

  test('the category alone identifies a WDO when no specific service was named', () => {
    const categoryOnly = wdoExtraction({ service_request: { service_intent: 'inspection_only', primary_service_category: 'wdo', specific_service_name: null } });
    expect(isAuthorizedWdoArrangerBooking(categoryOnly)).toBe(true);
  });

  test('the routing predicate is clock-free — a past slot still reads as authorized (the booking write refuses it)', () => {
    const past = wdoExtraction({ scheduling: { status: 'confirmed', confirmed_start_at: '2020-01-06T10:00:00-05:00' } });
    expect(isAuthorizedWdoArrangerBooking(past)).toBe(true);
  });

  // codex #4919 round-7 P1: arrangerSlotElapsed is now a THIN WRAPPER over
  // slotElapsedAtBookingTime (`authorized && slotElapsedAtBookingTime(...)`)
  // — its own contract (including the `authorized: false` no-op case) is
  // unchanged and still exhaustively covered here, but production's two
  // booking call sites (call-recording-processor.js, the early check and
  // the pre-insert recheck) now call slotElapsedAtBookingTime directly and
  // unconditionally, so the elapsed check applies to every fresh booking,
  // not only arranger-authorized ones — see the describe block below for
  // slotElapsedAtBookingTime's own direct coverage.
  describe('arrangerSlotElapsed (clock pinned to 2026-09-28 13:30 EDT)', () => {
    beforeAll(() => { jest.useFakeTimers({ now: new Date('2026-09-28T17:30:00Z') }); });
    afterAll(() => { jest.useRealTimers(); });

    test('an agreed ET day that has already passed is refused', () => {
      expect(arrangerSlotElapsed({ authorized: true, scheduledDate: '2026-09-27', windowStart: '16:00' })).toBe(true);
    });

    test('a same-day slot whose start has passed on the ET wall clock is refused (codex #4890 r7 P1)', () => {
      expect(arrangerSlotElapsed({ authorized: true, scheduledDate: '2026-09-28', windowStart: '10:00' })).toBe(true);
    });

    test('a midnight start rendered as "24:00" counts as the start of the day (codex #4890 r8 P2)', () => {
      expect(arrangerSlotElapsed({ authorized: true, scheduledDate: '2026-09-28', windowStart: '24:00' })).toBe(true);
    });

    test('a later same-day slot still books', () => {
      expect(arrangerSlotElapsed({ authorized: true, scheduledDate: '2026-09-28', windowStart: '16:00' })).toBe(false);
    });

    test('a future agreed day still books', () => {
      expect(arrangerSlotElapsed({ authorized: true, scheduledDate: '2026-09-29', windowStart: '10:00' })).toBe(false);
    });

    test('the authorized:false gate is still a no-op on this wrapper, even though production no longer relies on it', () => {
      expect(arrangerSlotElapsed({ authorized: false, scheduledDate: '2026-09-27', windowStart: '10:00' })).toBe(false);
    });
  });

  // The generalized check itself (codex #4919 round-7 P1) — no
  // `authorized` concept at all, since it now applies to every fresh call
  // booking regardless of arranger status or mode.
  describe('slotElapsedAtBookingTime (clock pinned to 2026-09-28 13:30 EDT) — applies to every booking, not just arranger-authorized ones', () => {
    const { slotElapsedAtBookingTime } = require('../services/call-recording-processor')._test;
    beforeAll(() => { jest.useFakeTimers({ now: new Date('2026-09-28T17:30:00Z') }); });
    afterAll(() => { jest.useRealTimers(); });

    test('an ORDINARY (non-arranger) booking whose agreed ET day has already passed is refused', () => {
      expect(slotElapsedAtBookingTime('2026-09-27', '16:00')).toBe(true);
    });

    test('an ORDINARY same-day slot whose start has passed on the ET wall clock is refused', () => {
      expect(slotElapsedAtBookingTime('2026-09-28', '10:00')).toBe(true);
    });

    test('an ORDINARY later same-day slot still books', () => {
      expect(slotElapsedAtBookingTime('2026-09-28', '16:00')).toBe(false);
    });

    test('an ORDINARY future agreed day still books', () => {
      expect(slotElapsedAtBookingTime('2026-09-29', '10:00')).toBe(false);
    });

    test('no scheduledDate at all is never elapsed (nothing to refuse)', () => {
      expect(slotElapsedAtBookingTime(null, '10:00')).toBe(false);
      expect(slotElapsedAtBookingTime(undefined, '10:00')).toBe(false);
    });

    test('arrangerSlotElapsed(authorized: true, ...) agrees with slotElapsedAtBookingTime for the same inputs — the wrapper is exact', () => {
      for (const [scheduledDate, windowStart] of [['2026-09-27', '16:00'], ['2026-09-28', '10:00'], ['2026-09-28', '16:00'], ['2026-09-29', '10:00']]) {
        expect(arrangerSlotElapsed({ authorized: true, scheduledDate, windowStart }))
          .toBe(slotElapsedAtBookingTime(scheduledDate, windowStart));
      }
    });
  });

  test('the spelled-out WDO service name is recognized (codex #4890 r7 P2)', () => {
    const spelled = wdoExtraction({ service_request: { service_intent: 'inspection_only', primary_service_category: 'wdo', specific_service_name: 'Wood-Destroying Organism Inspection' } });
    expect(isAuthorizedWdoArrangerBooking(spelled)).toBe(true);
  });
});

// Codex #4890 post-merge review P1: specific_service_name is free text, so a
// lender/realtor call labelled "WDO Treatment Service" matched the bare
// \bWDO\b identity regex and, through isAuthorizedWdoArrangerBooking,
// stripped caller_not_authorized from a third party's TREATMENT request.
// The owner ruling covers only an inspection/report arranged for a lender or
// realtor — never a treatment.
describe('codex #4890 post-merge review P1 — arranger authorization requires INSPECTION identity, never treatment', () => {
  test('"WDO Inspection Service" binds (inspection identity, no treatment wording)', () => {
    expect(isWdoInspectionRequest({ service_intent: 'inspection_only', primary_service_category: 'wdo', specific_service_name: 'WDO Inspection Service' })).toBe(true);
    const bound = wdoExtraction({ service_request: { service_intent: 'inspection_only', primary_service_category: 'wdo', specific_service_name: 'WDO Inspection Service' } });
    expect(isAuthorizedWdoArrangerBooking(bound)).toBe(true);
  });

  test.each([
    ['WDO Treatment Service'],
    ['WDO Treatment'],
    ['Wood-Destroying Organism Treatment'],
    ['termite treatment'],
    ['WDO inspection and treatment'],
  ])('%s does NOT bind — not an inspection/report request', (specificServiceName) => {
    expect(isWdoInspectionRequest({ service_intent: 'inspection_only', primary_service_category: 'wdo', specific_service_name: specificServiceName })).toBe(false);
    const notBound = wdoExtraction({ service_request: { service_intent: 'inspection_only', primary_service_category: 'wdo', specific_service_name: specificServiceName } });
    expect(isAuthorizedWdoArrangerBooking(notBound)).toBe(false);
    // Fails closed all the way through: the deterministic pass still raises
    // caller_not_authorized for a lender/realtor arranging a TREATMENT, even
    // with a confirmed slot.
    expect(computeDeterministicTriageFlags(notBound, { contactPhone: ANI, addressValidation: AV_CLEAN })).toContain('caller_not_authorized');
  });
});

// codex #4890 review, P2 round 2 — two source-contract pins on
// call-recording-processor.js. Both fixes touch code deep inside a single
// giant transaction closure that processRecording builds up (Twilio,
// extraction, DB pool, and 15k+ lines of surrounding state), so a live
// through-the-transaction integration test would need to stand up almost
// that entire pass. The finalization transaction's lock-then-transition
// contract is already pinned this way elsewhere in this codebase (see
// call-processor-ownership-fences.test.js's regex-scan style for the same
// function), and arrangerSlotElapsed's own logic is already exhaustively
// unit-tested above — what these two pin is that the fix is actually wired
// in, in the right place, relative to the writes it must run before.
describe('codex #4890 P2 — the card-retirement finalization transaction takes the triage lock first', () => {
  const fs = require('fs');
  const source = fs.readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');

  const txStart = source.indexOf('const finalized = await db.transaction(async (trx) => {');
  const retireMarker = source.indexOf('Superseded — a lender or realtor arranging a confirmed WDO inspection is an authorized caller');

  test('the finalization transaction and the WDO-authorized retire block are both found in source', () => {
    expect(txStart).toBeGreaterThan(-1);
    expect(retireMarker).toBeGreaterThan(txStart);
  });

  test('lockTriageCall(trx, call.id) is taken inside the transaction, before every triage_items card transition it contains (including the WDO retire)', () => {
    const body = source.slice(txStart, retireMarker);
    const lockIdx = body.indexOf('await lockTriageCall(trx, call.id);');
    const firstTriageWrite = body.indexOf("trx('triage_items')");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(firstTriageWrite).toBeGreaterThan(-1);
    // The lock must precede the FIRST card transition in this transaction —
    // an admin verdict resolving a different card concurrently must fully
    // serialize against every one of these, not just the WDO retire.
    expect(lockIdx).toBeLessThan(firstTriageWrite);
  });

  test('the review_status recompute that follows the WDO retire is also inside the locked transaction', () => {
    const retireBlockEnd = source.indexOf('\n      }\n', retireMarker);
    const retireBlock = source.slice(retireMarker, retireBlockEnd);
    expect(retireBlock).toContain("trx('call_log')");
    expect(retireBlock).toContain('review_status: null');
  });
});

describe('codex #4890 P2 — the arranger slot-elapsed guard is rechecked inside the scheduling transaction', () => {
  const fs = require('fs');
  const source = fs.readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');

  const txStart = source.indexOf('const svc = await db.transaction(async (trx) => {');
  const insertMarker = source.indexOf("const [created] = await trx('scheduled_services')");

  test('the scheduling transaction and the fresh-insert site are both found in source', () => {
    expect(txStart).toBeGreaterThan(-1);
    expect(insertMarker).toBeGreaterThan(txStart);
  });

  // codex #4919 round-7 P1: generalized from arranger-only to every fresh
  // booking — the pre-insert recheck now calls slotElapsedAtBookingTime
  // directly (no `authorized`/arranger gate at this call site; every
  // booking reaches this same insert, in both enforce and shadow/legacy
  // mode) — see call-timeline.test.js / call-recording-processor-guards.test.js
  // for slotElapsedAtBookingTime's own unit coverage.
  test('the elapsed check is re-run immediately before the fresh insert, ungated by arranger status — every booking gets this recheck now', () => {
    const body = source.slice(txStart, insertMarker);
    const idx = body.lastIndexOf('slotElapsedAtBookingTime(');
    expect(idx).toBeGreaterThan(-1);
    // No leftover arranger-gated call at this site.
    expect(body.lastIndexOf('arrangerSlotElapsed({')).toBe(-1);
    const recheck = body.slice(idx, idx + 500);
    // Same call-linked-visit exemption as the early check, now read through
    // this transaction's own connection.
    expect(recheck).toContain('findExistingCallAppointment({ customerId, call, scheduledDate, windowStart, serviceType, trx }');
    // Refuses via the same generic hold mechanism every other in-transaction
    // scheduling refusal on this path uses.
    expect(recheck).toContain('__held');
  });

  test('nothing between the recheck and the insert can move scheduledDate/windowStart out from under it', () => {
    const body = source.slice(txStart, insertMarker);
    const idx = body.lastIndexOf('slotElapsedAtBookingTime(');
    expect(idx).toBeGreaterThan(-1);
    const between = body.slice(idx, body.length);
    // The only statement between the recheck and the insert is the insert
    // call itself (plus the recheck's own guard body) — no re-assignment of
    // scheduledDate/windowStart sneaks in between the check and the write it
    // guards.
    expect(between).not.toMatch(/\bscheduledDate\s*=/);
    expect(between).not.toMatch(/\bwindowStart\s*=/);
  });

  test('the in-transaction hold reason is excluded from the generic auto_booking_skipped_after_approval fallback (no double-filed card for the same refusal)', () => {
    const heldReasonsMatch = source.match(/const heldReasons = new Set\(\[[^\]]*\]\);/);
    expect(heldReasonsMatch).toBeTruthy();
    expect(heldReasonsMatch[0]).toContain("'arranger_slot_elapsed_pre_insert'");
    // And the recheck itself returns exactly that reason, so the two stay in sync.
    expect(source).toContain("return { __held: { reason: 'arranger_slot_elapsed_pre_insert' } };");
  });

  test('the in-transaction hold reason is distinct from the early (pre-transaction) check\'s skippedReason, so the early check keeps its own auto_booking_skipped_after_approval fallback card', () => {
    // Regression guard: if the in-transaction reason were ever changed to
    // 'slot_elapsed_at_booking_time' (the early check's own skippedReason,
    // codex #4919 round-7 P1 — was 'past_extracted_date' before the
    // generalization) and added to heldReasons, the early check's refusal
    // would silently stop filing ANY review card in enforce mode (its
    // shadow-mode card is separate and unaffected either way).
    const heldReasonsMatch = source.match(/const heldReasons = new Set\(\[[^\]]*\]\);/)[0];
    expect(heldReasonsMatch).not.toContain("'slot_elapsed_at_booking_time'");
    expect(heldReasonsMatch).not.toContain("'past_extracted_date'");
  });
});

// Codex #4890 post-merge review P2: buildTriageItem left
// 'arranger_slot_elapsed_pre_insert' out of flagToCategoryMap AND
// SCHEDULING_PAYLOAD_FLAGS, so the card filed as service_unknown with no
// scheduling-window snapshot for the office to re-book against.
describe('codex #4890 post-merge review P2 — arranger_slot_elapsed_pre_insert files in the scheduling lane', () => {
  const { buildTriageItem } = require('../services/call-routing-gates');

  test('buildTriageItem gives it the scheduling (time_ambiguous) category and carries the scheduling_window payload', () => {
    const item = buildTriageItem({
      callLogId: 42,
      flag: 'arranger_slot_elapsed_pre_insert',
      extraction: wdoExtraction(),
      severity: 'advisory',
    });
    expect(item.category).toBe('time_ambiguous');
    const payload = JSON.parse(item.payload);
    expect(payload.scheduling_window).toEqual(expect.objectContaining({
      status: 'confirmed',
      confirmed_start_at: '2026-09-28T10:00:00-04:00',
    }));
  });
});

// codex #4919 round-7 P1: the EARLY (pre-transaction) elapsed-slot check —
// generalized the same way as the pre-insert recheck above, from
// arranger-only to every fresh booking. Source-pinned for the same reason
// as the pre-insert recheck's own P2 tests: a live run needs standing up
// almost the whole processRecording pass.
describe('codex #4919 round-7 P1 — the early elapsed-slot check is generalized and files a shadow-mode card', () => {
  const fs = require('fs');
  const source = fs.readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');

  const checkAt = source.indexOf('if (scheduledDate && slotElapsedAtBookingTime(scheduledDate, windowStart)');

  test('the early check calls slotElapsedAtBookingTime directly — no arranger/authorized gate', () => {
    expect(checkAt).toBeGreaterThan(-1);
    const section = source.slice(checkAt, checkAt + 700);
    expect(section).toContain("findExistingCallAppointment({ customerId, call, scheduledDate, windowStart, serviceType }");
    expect(section).toContain("skippedReason: 'slot_elapsed_at_booking_time'");
    expect(section).not.toContain('wdoArrangerAuthorizedThisPass');
  });

  test('shadow/legacy mode files its own card for this skip — same lock + merge + dispute-field-clearing shape as start_before_call\'s shadow card', () => {
    const gateAt = source.indexOf('if (!(CALL_EXTRACTION_V2_DRIVES_ROUTING && CALL_EXTRACTION_V2_ENABLED)) {', checkAt);
    expect(gateAt).toBeGreaterThan(checkAt);
    const catchAt = source.indexOf('slot-elapsed-at-booking-time triage insert failed', gateAt);
    expect(catchAt).toBeGreaterThan(gateAt);
    const section = source.slice(gateAt, catchAt);
    expect(section).toContain('await lockTriageCall(ttrx, call.id);');
    expect(section).toContain("ttrx('call_log').where({ id: call.id, processing_token: procToken }).first('id')");
    expect(section).toContain("flag: 'auto_booking_skipped_after_approval'");
    expect(section).toContain("skipped_reason: 'slot_elapsed_at_booking_time'");
    expect(section).toContain('dispute_customer_id: customerId ? String(customerId) : null');
    expect(section).toContain('retained_service_id: null');
    expect(section).toContain('retained_scheduled_date: null');
    expect(section).toContain("COALESCE(triage_items.payload, '{}'::jsonb) || EXCLUDED.payload");
    expect(section).not.toContain('.ignore()');
  });

  test('"slot_elapsed_at_booking_time" is NOT in the enforce-mode fallback\'s heldReasons — it relies on that generic fallback for its enforce-mode card, same as start_before_call', () => {
    const heldReasonsMatch = source.match(/const heldReasons = new Set\(\[[^\]]*\]\);/)[0];
    expect(heldReasonsMatch).not.toContain("'slot_elapsed_at_booking_time'");
    expect(heldReasonsMatch).not.toContain("'start_before_call'");
  });
});

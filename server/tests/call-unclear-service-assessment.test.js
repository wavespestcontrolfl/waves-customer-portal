// GATE_CALL_UNCLEAR_SERVICE_ASSESSMENT (owner-approved review item, 2026-09-30).
// A call with a CONFIRMED, ON-THE-HOUR time and a TRUSTED address must not be
// held only because the service is unclear (ambiguous_pest_or_service, or
// low_extraction_confidence when service_address is the only low sub-score):
// the existing fail-open "Waves Assessment" catalog fallback books it, the
// office keeps its advisory card. Gate off = today's behavior, every case.
// Synthetic data only.
const { canAutoRoute } = require('../services/call-triage-flags');
const CallRecordingProcessor = require('../services/call-recording-processor');

const {
  resolveSchedulableCallService, forcedAssessmentBooking, demoteOpenTriageCards,
  applyUnclearServiceTranscriptVeto, unclearServiceAssessmentActive,
} = CallRecordingProcessor._test;
const { resolveCallBookingPrice, resolveCallFollowUpPlan } = require('../services/call-booking-catalog');
const { buildRouteDecision, upsertRouteDecision, ROUTE_DECISION_REFRESH_COLUMNS, V2_DECISION_VERSION, V2_DECISION_VERSIONS } = require('../services/call-routing-gates');

const AV_CLEAN = { status: 'validated_accept', inServiceArea: true, county: 'Manatee County' };
const ON_FILE = Object.freeze({ hasAddress: true, addressLine1: '100 Synthetic St', addressZip: '34202' });
const ON_THE_HOUR = '2026-10-02T10:00:00-04:00';
const OFF_THE_HOUR = '2026-10-02T10:30:00-04:00';

// `meta` is present so computeDeterministicTriageFlags runs (the real
// low_extraction_confidence emitter); flags injected per test are the model's.
function extraction({ flags = [], confidence, scheduling } = {}) {
  return {
    meta: {},
    triage_flags: flags,
    caller: { phone_e164: '+19415550100' },
    confidence: confidence || { overall: 0.9, service_address: 0.9, primary_service_category: 0.9 },
    scheduling: scheduling || { status: 'confirmed', confirmed_start_at: ON_THE_HOUR },
    consent: {},
  };
}

const GATE_ON = { failOpen: true, unclearServiceAssessment: true, addressValidation: AV_CLEAN, contactPhone: '+19415550100' };
const GATE_OFF = { failOpen: true, addressValidation: AV_CLEAN, contactPhone: '+19415550100' };

describe('ambiguous_pest_or_service', () => {
  const ambiguous = () => extraction({ flags: ['ambiguous_pest_or_service'] });

  test('gate OFF: the flag still holds a confirmed, on-the-hour, trusted-address call', () => {
    const r = canAutoRoute(ambiguous(), GATE_OFF);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('triage_flags');
    expect(r.appointmentBlockingFlags).toEqual(['ambiguous_pest_or_service']);
  });

  test('gate explicitly false behaves like unset', () => {
    const r = canAutoRoute(ambiguous(), { ...GATE_OFF, unclearServiceAssessment: false });
    expect(r).toMatchObject({ allowed: false, reason: 'triage_flags' });
  });

  test('gate ON: fails open to the assessment fallback and rides failedOpenFlags for the office card', () => {
    const r = canAutoRoute(ambiguous(), GATE_ON);
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(['ambiguous_pest_or_service']);
    expect(r.flags).toContain('ambiguous_pest_or_service');
    expect(r.appointmentBlockingFlags).toBeUndefined();
  });

  test('gate ON: a known customer dispatching to the on-file address counts as trusted', () => {
    const r = canAutoRoute(ambiguous(), { failOpen: true, unclearServiceAssessment: true, knownCustomer: ON_FILE, contactPhone: '+19415550100' });
    expect(r.allowed).toBe(true);
    expect(r.usesOnFileAddress).toBe(true);
    // (the unstated-address flags also fail open here — the existing on-file rule)
    expect(r.failedOpenFlags).toContain('ambiguous_pest_or_service');
  });

  test('gate ON but fail-open booking OFF: still held (the fallback needs fail-open)', () => {
    const r = canAutoRoute(ambiguous(), { unclearServiceAssessment: true, addressValidation: AV_CLEAN, contactPhone: '+19415550100' });
    expect(r).toMatchObject({ allowed: false, reason: 'triage_flags' });
  });

  test('gate ON, NOT confirmed: still held', () => {
    for (const scheduling of [
      { status: 'tentative', confirmed_start_at: ON_THE_HOUR },
      { status: 'offered', confirmed_start_at: null },
      { status: 'confirmed', confirmed_start_at: null },
    ]) {
      const r = canAutoRoute(extraction({ flags: ['ambiguous_pest_or_service'], scheduling }), GATE_ON);
      expect(r.allowed).toBe(false);
      expect(r.appointmentBlockingFlags).toContain('ambiguous_pest_or_service');
    }
  });

  test('gate ON, OFF the hour: still held on the flag', () => {
    const r = canAutoRoute(extraction({
      flags: ['ambiguous_pest_or_service'],
      scheduling: { status: 'confirmed', confirmed_start_at: OFF_THE_HOUR },
    }), GATE_ON);
    expect(r).toMatchObject({ allowed: false, reason: 'triage_flags' });
    expect(r.appointmentBlockingFlags).toContain('ambiguous_pest_or_service');
  });

  test('gate ON, UNTRUSTED address (no AV verdict, no on-file address): still held', () => {
    const r = canAutoRoute(ambiguous(), { failOpen: true, unclearServiceAssessment: true, contactPhone: '+19415550100' });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('ambiguous_pest_or_service');
  });

  test('gate ON, AV not positive (confirm_needed / out of area): still held', () => {
    for (const addressValidation of [
      { status: 'confirm_needed', inServiceArea: true },
      { status: 'validated_accept', inServiceArea: false },
    ]) {
      const r = canAutoRoute(ambiguous(), { ...GATE_ON, addressValidation });
      expect(r.allowed).toBe(false);
      expect(r.appointmentBlockingFlags).toContain('ambiguous_pest_or_service');
    }
  });

  test('gate ON, known customer who STATES a new address without AV: still held', () => {
    const ex = ambiguous();
    ex.property = { service_address: { street_line_1: '9 Elsewhere Ln', city: 'Sarasota', postal_code: '34231' } };
    const r = canAutoRoute(ex, { failOpen: true, unclearServiceAssessment: true, knownCustomer: ON_FILE, contactPhone: '+19415550100' });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('ambiguous_pest_or_service');
  });

  test('gate ON never rescues another hard block riding with the flag', () => {
    for (const hard of ['do_not_contact_requested', 'spam_or_wrong_number', 'commercial_requires_quote']) {
      const r = canAutoRoute(extraction({ flags: ['ambiguous_pest_or_service', hard] }), GATE_ON);
      expect(r.allowed).toBe(false);
      expect(r.appointmentBlockingFlags).toContain(hard);
      expect(r.failedOpenFlags || []).toContain('ambiguous_pest_or_service');
    }
  });
});

describe('low_extraction_confidence with only service_address low', () => {
  const lowAddressOnly = (extra = {}) => extraction({
    confidence: { overall: 0.3, service_address: 0.2, primary_service_category: 0.9, urgency: 0.8, consent_capture: 0.9, ...extra },
  });

  test('the deterministic emitter really raises the flag for this shape', () => {
    const r = canAutoRoute(lowAddressOnly(), { ...GATE_OFF, addressValidation: AV_CLEAN });
    expect(r.allowed).toBe(false);
    expect(r.flags).toContain('low_extraction_confidence');
  });

  test('gate OFF: held on low_extraction_confidence', () => {
    const r = canAutoRoute(lowAddressOnly(), GATE_OFF);
    expect(r).toMatchObject({ allowed: false, reason: 'triage_flags' });
    expect(r.appointmentBlockingFlags).toContain('low_extraction_confidence');
  });

  test('gate ON: fails open at BOTH the flag check and the score check', () => {
    const r = canAutoRoute(lowAddressOnly(), GATE_ON);
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(['low_extraction_confidence']);
    // Not the score-level exit the second check owns.
    expect(r.reason).toBeUndefined();
  });

  test('gate ON, on-file address: allowed and flagged for the card', () => {
    const r = canAutoRoute(lowAddressOnly(), { failOpen: true, unclearServiceAssessment: true, knownCustomer: { ...ON_FILE, addressOnly: true }, contactPhone: '+19415550100' });
    // addressOnly (new-lead) trust never lifts confidence on its own — the new
    // gate does, because the service-address score is the only low one.
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toContain('low_extraction_confidence');
  });

  test('gate ON, another sub-score is low too: still held', () => {
    for (const other of [
      { primary_service_category: 0.2 },
      { caller_identity: 0.1 },
      { urgency: 0.4 },
      { consent_capture: 0.3 },
    ]) {
      const r = canAutoRoute(lowAddressOnly(other), GATE_ON);
      expect(r.allowed).toBe(false);
      expect(r.appointmentBlockingFlags).toContain('low_extraction_confidence');
    }
  });

  test('gate ON, service_address is NOT the low one: still held', () => {
    const r = canAutoRoute(extraction({
      confidence: { overall: 0.3, service_address: 0.9, primary_service_category: 0.9 },
    }), GATE_ON);
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('low_extraction_confidence');
  });

  test('gate ON, NOT confirmed / off the hour / untrusted address: still held', () => {
    const notConfirmed = canAutoRoute(extraction({
      confidence: lowAddressOnly().confidence,
      scheduling: { status: 'tentative', confirmed_start_at: ON_THE_HOUR },
    }), GATE_ON);
    expect(notConfirmed.allowed).toBe(false);

    const offHour = canAutoRoute(extraction({
      confidence: lowAddressOnly().confidence,
      scheduling: { status: 'confirmed', confirmed_start_at: OFF_THE_HOUR },
    }), GATE_ON);
    expect(offHour.allowed).toBe(false);
    expect(offHour.appointmentBlockingFlags).toContain('low_extraction_confidence');

    const untrusted = canAutoRoute(lowAddressOnly(), { failOpen: true, unclearServiceAssessment: true, contactPhone: '+19415550100' });
    expect(untrusted.allowed).toBe(false);
  });

  test('the two checks agree: a low overall with no service_address score blocks at both', () => {
    const r = canAutoRoute(extraction({ confidence: { overall: 0.3, primary_service_category: 0.9 } }), GATE_ON);
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('low_extraction_confidence');
  });

  test('both unclear-service flags together fail open together under the gate', () => {
    const ex = lowAddressOnly();
    ex.triage_flags = ['ambiguous_pest_or_service'];
    const r = canAutoRoute(ex, GATE_ON);
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['ambiguous_pest_or_service', 'low_extraction_confidence']));
  });
});

describe('the transcript veto rides EVERY admission by this gate (codex r3 P1)', () => {
  const lowAddressOnly = () => extraction({
    confidence: { overall: 0.3, service_address: 0.2, primary_service_category: 0.9 },
  });

  test('both waivers set the single admitted signal; only the ambiguous one forces the Assessment', () => {
    const lowConf = canAutoRoute(lowAddressOnly(), GATE_ON);
    expect(lowConf).toMatchObject({ allowed: true, unclearServiceGateAdmitted: true, forceAssessmentService: false });
    const amb = canAutoRoute(extraction({ flags: ['ambiguous_pest_or_service'] }), GATE_ON);
    expect(amb).toMatchObject({ allowed: true, unclearServiceGateAdmitted: true, forceAssessmentService: true });
    // gate off: neither
    expect(canAutoRoute(extraction(), GATE_OFF).unclearServiceGateAdmitted).toBeUndefined();
  });

  test('SEO solicitor through the low-confidence path: the resolver vetoes on the transcript once the signal is passed', () => {
    const admitted = canAutoRoute(lowAddressOnly(), GATE_ON);
    expect(admitted.unclearServiceGateAdmitted).toBe(true);
    const extracted = { matched_service: 'General Pest Control', requested_service: 'pest control', call_summary: 'Caller about pest control.' };
    const transcription = 'Agent: Hello.\nCaller: I can improve your website SEO and Google ranking for your pest control company, organic traffic guaranteed.\n';
    // what the processor passes: fullTranscriptVeto = admitted.unclearServiceGateAdmitted
    const r = resolveSchedulableCallService(extracted, { transcription, fullTranscriptVeto: admitted.unclearServiceGateAdmitted === true });
    expect(r).toMatchObject({ ok: false, reason: 'unsupported_service' });
    expect(r.noMatch).toBeUndefined();
  });

  test('the processor wires the veto to the admitted signal, not to the forced-Assessment flag', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    expect(src).toMatch(/fullTranscriptVeto: v2UnclearServiceGateAdmitted/);
    expect(src).toMatch(/v2UnclearServiceGateAdmitted = routingResult\.unclearServiceGateAdmitted === true/);
  });
});

describe('the V1 address-conflict hold keeps the gate\'s waived-flag cards (codex r3 P2)', () => {
  const { demoteFailOpenOnV1AddressConflict } = CallRecordingProcessor;
  const knownCaller = { hasAddress: true, addressLine1: '100 Synthetic St', addressZip: '34202', addressCity: 'Bradenton', addressState: 'FL' };
  const conflictingV1 = { address_line1: '9 Elsewhere Ln', city: 'Sarasota', state: 'FL', zip: '34231' };

  test('a held call still owes the advisory service card for what the gate waived', () => {
    const allowed = {
      allowed: true, flags: ['ambiguous_pest_or_service'], usesOnFileAddress: true,
      failedOpenFlags: ['caller_phone_missing', 'ambiguous_pest_or_service'],
      unclearServiceGateAdmitted: true, unclearServiceDemotedFlags: ['ambiguous_pest_or_service'], forceAssessmentService: true,
    };
    const held = demoteFailOpenOnV1AddressConflict(allowed, conflictingV1, knownCaller);
    expect(held).toMatchObject({ allowed: false, reason: 'v1_only_new_address', appointmentBlockingFlags: ['address_unverified'] });
    expect(held.failedOpenFlags).toEqual(['ambiguous_pest_or_service']);
    expect(held.unclearServiceDemotedFlags).toEqual(['ambiguous_pest_or_service']);
    // a held call is not an admission: nothing downstream may act as admitted
    expect(held.unclearServiceGateAdmitted).toBeUndefined();
    expect(held.forceAssessmentService).toBeUndefined();
  });

  test('gate off: the replacement verdict is exactly what it was', () => {
    const allowed = { allowed: true, flags: [], usesOnFileAddress: true, failedOpenFlags: ['missing_service_address'] };
    expect(demoteFailOpenOnV1AddressConflict(allowed, conflictingV1, knownCaller)).toEqual({
      allowed: false, reason: 'v1_only_new_address', flags: [], appointmentBlockingFlags: ['address_unverified'],
    });
  });
});

describe('service resolver vetoes still apply downstream', () => {
  test('a demoted unclear flag reaches the resolver, whose hard vetoes stay un-bookable', () => {
    // canAutoRoute lets the call through under the gate ...
    const r = canAutoRoute(extraction({ flags: ['ambiguous_pest_or_service'] }), GATE_ON);
    expect(r.allowed).toBe(true);

    // ... but an unsupported / non-service call is still vetoed by the
    // resolver (ok:false, NO noMatch), so the Assessment fallback never fires.
    const veto = resolveSchedulableCallService({
      matched_service: null,
      requested_service: 'SEO for pest control website',
      call_summary: 'Caller wanted Google ranking help for a synthetic pest control website.',
    });
    expect(veto).toMatchObject({ ok: false, reason: 'unsupported_service' });
    expect(veto.noMatch).toBeUndefined();

    const adminOnly = resolveSchedulableCallService({
      matched_service: null,
      requested_service: 'copy of my invoice',
      call_summary: 'Caller asked for a receipt for a synthetic invoice.',
    });
    expect(adminOnly.ok).toBe(false);
    expect(adminOnly.noMatch).toBeUndefined();
  });

  test('a genuinely unclear service resolves to noMatch — the shape the Assessment fallback books', () => {
    const unclear = resolveSchedulableCallService({
      matched_service: null,
      requested_service: null,
      call_summary: 'Caller asked about something around the yard.',
    });
    expect(unclear.ok).toBe(false);
    expect(unclear.noMatch).toBe(true);
  });
});

describe('gate wiring', () => {
  const loadGates = (value) => {
    const prev = process.env.GATE_CALL_UNCLEAR_SERVICE_ASSESSMENT;
    if (value === undefined) delete process.env.GATE_CALL_UNCLEAR_SERVICE_ASSESSMENT;
    else process.env.GATE_CALL_UNCLEAR_SERVICE_ASSESSMENT = value;
    let gates;
    jest.isolateModules(() => { gates = require('../config/feature-gates'); });
    if (prev === undefined) delete process.env.GATE_CALL_UNCLEAR_SERVICE_ASSESSMENT;
    else process.env.GATE_CALL_UNCLEAR_SERVICE_ASSESSMENT = prev;
    return gates;
  };

  test('default OFF; only the exact string "true" turns it on', () => {
    expect(loadGates(undefined).isEnabled('callUnclearServiceAssessment')).toBe(false);
    for (const v of ['', 'false', '1', 'TRUE', 'yes', ' true']) {
      expect(loadGates(v).isEnabled('callUnclearServiceAssessment')).toBe(false);
    }
    expect(loadGates('true').isEnabled('callUnclearServiceAssessment')).toBe(true);
  });

  test('no gate-specific decision version exists: the write chokepoint refreshes instead (codex r5 P1)', () => {
    expect(V2_DECISION_VERSION).toBe('v2-1.50.0');
    expect(V2_DECISION_VERSIONS.some((v) => v.includes('+'))).toBe(false);
    expect(V2_DECISION_VERSIONS[V2_DECISION_VERSIONS.length - 1]).toBe(V2_DECISION_VERSION);
    expect(buildRouteDecision({ callLogId: 'c1', extraction: extraction(), routingResult: { allowed: true }, action: 'auto_route' }).decision_version).toBe('v2-1.50.0');
  });
});

describe('ambiguous demotion forces the Waves Assessment row (codex r1 P1)', () => {
  test('canAutoRoute marks the ambiguous demotion and names the flags it waived', () => {
    const r = canAutoRoute(extraction({ flags: ['ambiguous_pest_or_service'] }), GATE_ON);
    expect(r).toMatchObject({ allowed: true, forceAssessmentService: true, unclearServiceDemotedFlags: ['ambiguous_pest_or_service'] });
  });

  test('a low-confidence-only demotion waives the flag but does not force the Assessment', () => {
    const r = canAutoRoute(extraction({
      confidence: { overall: 0.3, service_address: 0.2, primary_service_category: 0.9 },
    }), GATE_ON);
    expect(r.allowed).toBe(true);
    expect(r.unclearServiceDemotedFlags).toEqual(['low_extraction_confidence']);
    expect(r.forceAssessmentService).toBe(false);
  });

  test('gate off: no marker at all', () => {
    const r = canAutoRoute(extraction(), GATE_OFF);
    expect(r.allowed).toBe(true);
    expect(r.forceAssessmentService).toBeUndefined();
    expect(r.unclearServiceDemotedFlags).toBeUndefined();
  });

  const catalog = [
    { id: 'svc-pest', name: 'General Pest Control', billing_type: 'one_time' },
    { id: 'svc-quarterly', name: 'Quarterly Pest Control Service', billing_type: 'recurring' },
    { id: 'svc-reservice', name: 'Pest Re-Service', service_key: 'pest_re_service' },
    { id: 'svc-assess', name: 'Waves Assessment', billing_type: 'one_time' },
  ];
  const [pestRow, quarterlyRow, , assessRow] = catalog;
  const noIntent = 'Agent: Hi.\nCaller: I saw a bug in the kitchen, not sure what it is, can someone come Tuesday at ten?\n';
  const acceptedPlan = 'Agent: We can put you on quarterly pest control.\nCaller: Yes, that works, sign me up.\n';
  const modelGuess = { is_lead: true, matched_service: 'General Pest Control', quoted_price: 189, follow_up_visit_mentioned: true, follow_up_date_time: '2026-10-16T10:00' };

  test('a model-guessed concrete service is overridden by the Assessment row', () => {
    const out = forcedAssessmentBooking({ serviceResolution: { ok: true, service: 'General Pest Control' }, services: catalog, current: pestRow, extracted: modelGuess, transcription: noIntent });
    expect(out).toMatchObject({ applied: true, row: assessRow });
  });

  test('an unresolved (noMatch) service also lands on the Assessment row', () => {
    const out = forcedAssessmentBooking({ serviceResolution: { ok: false, noMatch: true }, services: catalog, current: null, extracted: modelGuess, transcription: noIntent });
    expect(out.row).toBe(assessRow);
  });

  test('a resolver hard veto is left alone (still un-bookable)', () => {
    const out = forcedAssessmentBooking({ serviceResolution: { ok: false, reason: 'unsupported_service' }, services: catalog, current: null, extracted: modelGuess, transcription: noIntent });
    expect(out.applied).toBe(false);
  });

  test('no Assessment row available: hold, never the flagged concrete service', () => {
    const out = forcedAssessmentBooking({ serviceResolution: { ok: true, service: 'General Pest Control' }, services: [pestRow], current: pestRow, extracted: modelGuess, transcription: noIntent });
    expect(out).toMatchObject({ applied: true, unbookable: true });
    expect(out.extractedPatch).toBeUndefined();
  });

  test('KEEPS a deterministic re-service row (codex r2 P1)', () => {
    const reService = { id: 'svc-rs', name: 'Pest Re-Service', service_key: 'pest_re_service' };
    const isRe = require('../services/call-booking-catalog').isReServiceCatalogRow;
    // guard: the fixture really is a re-service row by the catalog's own predicate
    expect(isRe(reService)).toBe(true);
    const out = forcedAssessmentBooking({ serviceResolution: { ok: true, service: 'General Pest Control' }, services: [...catalog, reService], current: reService, extracted: modelGuess, transcription: noIntent });
    expect(out).toMatchObject({ applied: false, kept: 're_service', row: reService });
  });

  test('KEEPS a recurring program the caller accepted (applyRecurringIntentDefault evidence) (codex r2 P1)', () => {
    const out = forcedAssessmentBooking({ serviceResolution: { ok: true, service: 'General Pest Control' }, services: catalog, current: quarterlyRow, extracted: modelGuess, transcription: acceptedPlan, inbound: true });
    expect(out).toMatchObject({ applied: false, kept: 'recurring_program', row: quarterlyRow });
  });

  test('a recurring program the MODEL guessed (no caller intent) is still forced to the Assessment', () => {
    const out = forcedAssessmentBooking({ serviceResolution: { ok: true, service: 'General Pest Control' }, services: catalog, current: quarterlyRow, extracted: modelGuess, transcription: noIntent });
    expect(out).toMatchObject({ applied: true, row: assessRow });
  });

  test('recurring evidence only counts on a lead (same guard as the default itself)', () => {
    const out = forcedAssessmentBooking({ serviceResolution: { ok: true, service: 'General Pest Control' }, services: catalog, current: quarterlyRow, extracted: { ...modelGuess, is_lead: false }, transcription: acceptedPlan, inbound: true });
    expect(out.applied).toBe(true);
  });

  test('OUTBOUND: the same accepted-plan transcript does NOT keep a model-picked recurring row (untrusted labels) (codex r3 P1)', () => {
    const args = { serviceResolution: { ok: true, service: 'General Pest Control' }, services: catalog, current: quarterlyRow, extracted: modelGuess, transcription: acceptedPlan };
    expect(forcedAssessmentBooking({ ...args, inbound: true })).toMatchObject({ applied: false, kept: 'recurring_program' });
    expect(forcedAssessmentBooking({ ...args, inbound: false })).toMatchObject({ applied: true, row: assessRow });
    // default (no direction handed) is the safe side
    expect(forcedAssessmentBooking(args)).toMatchObject({ applied: true, row: assessRow });
  });

  test('outbound still keeps a deterministic re-service row (lane evidence, not transcript labels)', () => {
    const reService = { id: 'svc-rs', name: 'Pest Re-Service', service_key: 'pest_re_service' };
    const out = forcedAssessmentBooking({ serviceResolution: { ok: true, service: 'General Pest Control' }, services: [...catalog, reService], current: reService, extracted: modelGuess, transcription: noIntent, inbound: false });
    expect(out).toMatchObject({ applied: false, kept: 're_service' });
  });

  test('a forced Assessment carries NO treatment quote and NO follow-up signals (codex r2 P1)', () => {
    const out = forcedAssessmentBooking({ serviceResolution: { ok: true, service: 'General Pest Control' }, services: catalog, current: pestRow, extracted: modelGuess, transcription: noIntent });
    const booking = { ...modelGuess, ...out.extractedPatch };
    expect(booking.quoted_price).toBeNull();
    expect(booking.follow_up_visit_mentioned).toBe(false);
    expect(booking.follow_up_date_time).toBeNull();
    // What the booking then computes from it:
    expect(resolveCallBookingPrice({ quotedPrice: booking.quoted_price, catalogRow: { ...assessRow, base_price: 0, pricing_type: 'variable' } }).price).toBeNull();
    expect(resolveCallFollowUpPlan({ extracted: booking, catalogRow: assessRow, parentDate: '2026-10-02', parentWindowStart: '10:00' })).toBeNull();
    // ...whereas the un-patched extraction would have created both.
    expect(resolveCallFollowUpPlan({ extracted: modelGuess, catalogRow: assessRow, parentDate: '2026-10-02', parentWindowStart: '10:00' })).not.toBeNull();
    expect(resolveCallBookingPrice({ quotedPrice: modelGuess.quoted_price, catalogRow: assessRow }).price).toBe(189);
  });
});

describe('full-transcript unsupported veto (codex r1 P1)', () => {
  // The extracted fields look like a real pest call; only the transcript
  // shows an SEO solicitor.
  const extracted = {
    matched_service: 'General Pest Control',
    requested_service: 'pest control',
    call_summary: 'Caller about pest control.',
  };
  const transcription = 'Agent: Hello. Caller: I can improve your website SEO and Google ranking for your pest control company, organic traffic guaranteed.';

  test('without the option the transcript veto is skipped once a service resolved (today)', () => {
    expect(resolveSchedulableCallService(extracted, { transcription })).toMatchObject({ ok: true, service: 'General Pest Control' });
  });

  test('with the option the transcript vetoes even though a service resolved', () => {
    const r = resolveSchedulableCallService(extracted, { transcription, fullTranscriptVeto: true });
    expect(r).toMatchObject({ ok: false, reason: 'unsupported_service' });
    expect(r.noMatch).toBeUndefined();
  });

  test('with the option an ordinary pest call is unaffected', () => {
    const r = resolveSchedulableCallService(extracted, { transcription: 'Agent: Hi. Caller: I have ants in my kitchen, can someone come Tuesday at ten?', fullTranscriptVeto: true });
    expect(r).toMatchObject({ ok: true, service: 'General Pest Control' });
  });

  test('an admin-only call is vetoed on the transcript with or without the option', () => {
    const r = resolveSchedulableCallService({ matched_service: 'General Pest Control', requested_service: 'pest control' }, {
      transcription: 'Caller: I need a copy of my invoice and a receipt for my last payment, that is all.',
      fullTranscriptVeto: true,
    });
    expect(r.ok).toBe(false);
    expect(r.noMatch).toBeUndefined();
  });
});

describe('an open blocking card is demoted on reprocess, fenced to the owning pass (codex r1 + r2 P1)', () => {
  function fakeConn({ owner = true } = {}) {
    const calls = [];
    const builder = (table) => {
      const chain = {
        where(a, b) { calls.push([table, 'where', b === undefined ? a : [a, b]]); return chain; },
        whereIn(c, v) { calls.push([table, 'whereIn', c, v]); return chain; },
        forUpdate() { calls.push([table, 'forUpdate']); return chain; },
        first() { calls.push([table, 'first']); return Promise.resolve(table === 'call_log' && owner ? { id: 'call-1' } : undefined); },
        update(u) { calls.push([table, 'update', u]); return Promise.resolve(2); },
      };
      return chain;
    };
    builder.fn = { now: () => 'NOW' };
    // lockTriageCall issues a raw advisory lock on the trx.
    builder.raw = (...a) => { calls.push(['raw', ...a]); return Promise.resolve({ rows: [] }); };
    const conn = { transaction: async (fn) => fn(builder) };
    return { conn, calls };
  }

  test('under the triage lock, still owning the processing token: demotes only open/in-progress BLOCKING rows of the waived flags', async () => {
    const { conn, calls } = fakeConn();
    const n = await demoteOpenTriageCards(conn, 'call-1', ['ambiguous_pest_or_service'], 'tok-1');
    expect(n).toBe(2);
    expect(calls.some((c) => c[0] === 'raw')).toBe(true); // the per-call triage lock
    expect(calls).toEqual(expect.arrayContaining([
      ['call_log', 'where', { id: 'call-1' }],
      ['call_log', 'where', ['processing_token', 'tok-1']],
      ['triage_items', 'where', { call_log_id: 'call-1', severity: 'blocking' }],
      ['triage_items', 'whereIn', 'reason_code', ['ambiguous_pest_or_service']],
      ['triage_items', 'whereIn', 'status', ['open', 'in_progress']],
      ['triage_items', 'update', { severity: 'advisory', updated_at: 'NOW' }],
    ]));
  });

  test('a superseded worker (processing token no longer held) demotes nothing', async () => {
    const { conn, calls } = fakeConn({ owner: false });
    expect(await demoteOpenTriageCards(conn, 'call-1', ['ambiguous_pest_or_service'], 'stale-tok')).toBe(0);
    expect(calls.some((c) => c[0] === 'triage_items')).toBe(false);
  });

  test('gate off / nothing waived: no transaction at all', async () => {
    const { conn, calls } = fakeConn();
    conn.transaction = () => { throw new Error('no transaction expected'); };
    expect(await demoteOpenTriageCards(conn, 'call-1', undefined, 'tok')).toBe(0);
    expect(await demoteOpenTriageCards(conn, 'call-1', [], 'tok')).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe('the effective gate needs BOTH switches (codex r2 P1)', () => {
  const on = (...names) => (g) => names.includes(g);
  test('unclear-service alone (fail-open off): not active', () => {
    expect(unclearServiceAssessmentActive(on('callUnclearServiceAssessment'))).toBe(false);
  });
  test('fail-open alone: not active', () => {
    expect(unclearServiceAssessmentActive(on('callFailOpenBooking'))).toBe(false);
  });
  test('both gates on: active', () => {
    expect(unclearServiceAssessmentActive(on('callUnclearServiceAssessment', 'callFailOpenBooking'))).toBe(true);
  });
});

describe('the route_decisions write refreshes on conflict (codex r5 P1)', () => {
  // A recording conn: captures each statement's SQL so the shape is asserted
  // without a database (the PostgreSQL suite proves the behavior).
  const knex = require('knex')({ client: 'pg' });
  const decision = buildRouteDecision({ callLogId: 'c1', extraction: extraction(), routingResult: { allowed: true }, action: 'auto_route', recordingSid: 'RE1' });
  function recordingConn() {
    const sqls = [];
    const conn = (table) => {
      const qb = knex(table);
      qb.then = (res, rej) => { sqls.push(qb.toSQL()); return Promise.resolve([]).then(res, rej); };
      return qb;
    };
    conn.raw = (...a) => knex.raw(...a);
    return { conn, sqls };
  }

  test('a TARGETLESS insert (rolling-deploy safe) then a keyed refresh of decision columns and created_at only', async () => {
    const { conn, sqls } = recordingConn();
    await upsertRouteDecision(conn, decision, { callLogId: 'c1', processingToken: 'tok' });
    expect(sqls).toHaveLength(2);
    expect(sqls[0].sql).toMatch(/insert into "route_decisions"[\s\S]*on conflict do nothing/i);
    expect(sqls[0].sql).not.toMatch(/on conflict \(/i);
    const upd = sqls[1].sql;
    expect(upd).toMatch(/^update "route_decisions" set/i);
    for (const col of ROUTE_DECISION_REFRESH_COLUMNS) expect(upd).toContain(`"${col}" = ?`);
    // outcome linkage is never refreshed
    expect(upd).not.toContain('created_scheduled_service_id');
    expect(upd).not.toContain('sms_enqueued');
    // keyed on call / version / mode / recording
    for (const col of ['call_log_id', 'decision_version', 'mode', 'recording_sid']) expect(upd).toContain(`"${col}" = ?`);
    expect(ROUTE_DECISION_REFRESH_COLUMNS).toContain('created_at');
  });

  test('the refresh is fenced to the pass that owns the processing token', async () => {
    const { conn, sqls } = recordingConn();
    await upsertRouteDecision(conn, decision, { callLogId: 'c1', processingToken: 'tok' });
    expect(sqls[1].sql).toMatch(/EXISTS \(SELECT 1 FROM call_log WHERE call_log\.id = \? AND call_log\.processing_token = \?\)/i);
    expect(sqls[1].bindings.slice(-2)).toEqual(['c1', 'tok']);
  });

  test('a refresh skips a decision that has route_feedback (codex r6 P1)', async () => {
    const { conn, sqls } = recordingConn();
    await upsertRouteDecision(conn, decision, { callLogId: 'c1', processingToken: 'tok' });
    expect(sqls[1].sql).toMatch(/not exists \(select 1 from "route_feedback" where route_feedback\.route_decision_id = route_decisions\.id\)/i);
  });

  test('an incomplete fence (no processing token) fails closed: no refresh runs', async () => {
    const { conn, sqls } = recordingConn();
    expect(await upsertRouteDecision(conn, decision, { callLogId: 'c1', processingToken: undefined })).toBe(0);
    expect(sqls).toHaveLength(1); // only the targetless insert
  });

  test('no fence handed: unfenced refresh (audit/backfill callers)', async () => {
    const { conn, sqls } = recordingConn();
    await upsertRouteDecision(conn, decision);
    expect(sqls[1].sql).not.toMatch(/EXISTS/);
  });

  test('both processor lanes write through it and nothing writes a route decision with a bare ignore', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    expect(src).toMatch(/upsertRouteDecision\(db, routeDecision, \{ callLogId: call\.id, processingToken: procToken \}\)/);
    expect(src).toMatch(/upsertRouteDecision\(db, shadowDecision, \{ callLogId: call\.id, processingToken: procToken \}\)/);
    expect(src).not.toMatch(/db\('route_decisions'\)\.insert\(routeDecision\)/);
  });
});

describe('the offline production-parity audits carry the same effective gate (codex r2 P1)', () => {
  const { buildFailOpenRoutingContext } = CallRecordingProcessor;
  test('both gates on: the audit options carry it and canAutoRoute then lets the flag through', () => {
    const { options } = buildFailOpenRoutingContext({ call: {}, customer: null, contactPhone: '+19415550100', failOpenEnabled: true, unclearServiceAssessmentEnabled: true });
    expect(options.unclearServiceAssessment).toBe(true);
    const r = canAutoRoute(extraction({ flags: ['ambiguous_pest_or_service'] }), { addressValidation: AV_CLEAN, ...options });
    expect(r.allowed).toBe(true);
  });
  test('gate on but fail-open off: NOT carried (the two-gate predicate)', () => {
    const { options } = buildFailOpenRoutingContext({ call: {}, customer: null, contactPhone: '+19415550100', failOpenEnabled: false, unclearServiceAssessmentEnabled: true });
    expect(options).not.toHaveProperty('unclearServiceAssessment');
  });
  test('gate off: the options shape is byte-identical to before', () => {
    const { options } = buildFailOpenRoutingContext({ call: {}, customer: null, contactPhone: '+19415550100', failOpenEnabled: true });
    expect(Object.keys(options).sort()).toEqual(['callerAni', 'failOpen', 'knownCustomer']);
  });
  test('the three audit scripts pass the gate into the context builder', () => {
    const fs = require('fs');
    const path = require('path');
    for (const f of ['v2-promotion-readiness.js', 'replay-call-extraction-variance.js', 'verify-v2-shadow-path.js']) {
      const src = fs.readFileSync(path.join(__dirname, '../scripts', f), 'utf8');
      expect(src).toMatch(/unclearServiceAssessmentEnabled:\s*process\.env\.GATE_CALL_UNCLEAR_SERVICE_ASSESSMENT === 'true'/);
    }
  });
});

describe('the offline audits run the downstream transcript veto (codex r5 P1)', () => {
  const extracted = { matched_service: 'General Pest Control', requested_service: 'pest control', call_summary: 'Caller about pest control.' };
  const seo = 'Agent: Hello.\nCaller: I can improve your website SEO and Google ranking for your pest control company, organic traffic guaranteed.\n';
  const ordinary = 'Agent: Hi.\nCaller: I have ants in my kitchen, can someone come Tuesday at ten?\n';
  const admitted = () => canAutoRoute(extraction({ flags: ['ambiguous_pest_or_service'] }), GATE_ON);

  test('a gate-admitted call the live resolver vetoes is reported HELD', () => {
    const held = applyUnclearServiceTranscriptVeto(admitted(), extracted, seo);
    expect(held).toMatchObject({ allowed: false, reason: 'unsupported_service' });
  });

  test('an ordinary gate-admitted call stays allowed', () => {
    const r = admitted();
    expect(applyUnclearServiceTranscriptVeto(r, extracted, ordinary)).toBe(r);
  });

  test('a noMatch (Assessment fallback) call stays allowed', () => {
    const r = admitted();
    expect(applyUnclearServiceTranscriptVeto(r, { call_summary: 'Something about the yard.' }, 'Agent: Hi.\nCaller: something is off around the yard.\n')).toBe(r);
  });

  test('a call the gate did NOT admit is untouched, whatever the transcript says (gate off = today)', () => {
    const r = canAutoRoute(extraction(), GATE_OFF);
    expect(applyUnclearServiceTranscriptVeto(r, extracted, seo)).toBe(r);
    const blocked = { allowed: false, reason: 'triage_flags' };
    expect(applyUnclearServiceTranscriptVeto(blocked, extracted, seo)).toBe(blocked);
  });

  test('the low-confidence-only admission is vetoed the same way', () => {
    const r = canAutoRoute(extraction({ confidence: { overall: 0.3, service_address: 0.2, primary_service_category: 0.9 } }), GATE_ON);
    expect(r.unclearServiceGateAdmitted).toBe(true);
    expect(applyUnclearServiceTranscriptVeto(r, extracted, seo).allowed).toBe(false);
  });

  test('the in-process SHADOW decision applies the same veto before it is built (codex r6 P1)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    const veto = src.indexOf('routingResult = applyUnclearServiceTranscriptVeto(routingResult, extracted, transcription);');
    const build = src.indexOf('const shadowDecision = buildRouteDecision({');
    expect(veto).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(veto);
    // and it sits after the V1 address demotion it mirrors
    expect(src.lastIndexOf('routingResult = demoteFailOpenOnV1AddressConflict(routingResult, extracted, knownCaller);', veto)).toBeGreaterThan(-1);
    // behavior: a vetoed admitted call is held in the shadow verdict
    const r = applyUnclearServiceTranscriptVeto(admitted(), extracted, seo);
    expect(r.allowed).toBe(false);
  });

  test('all three audit scripts call the ONE shared helper', () => {
    const fs = require('fs');
    const path = require('path');
    for (const f of ['v2-promotion-readiness.js', 'replay-call-extraction-variance.js', 'verify-v2-shadow-path.js']) {
      const src = fs.readFileSync(path.join(__dirname, '../scripts', f), 'utf8');
      expect(src).toMatch(/applyUnclearServiceTranscriptVeto/);
    }
  });
});

describe('a forced Assessment keeps the model summary off the customer-visible note (codex r5 P2)', () => {
  test('the patch drops call_summary and the booking note reads the patched copy', () => {
    const out = forcedAssessmentBooking({
      serviceResolution: { ok: true, service: 'General Pest Control' },
      services: [{ id: 'a', name: 'Waves Assessment' }],
      current: { id: 'p', name: 'General Pest Control' },
      extracted: { is_lead: true, call_summary: 'Agreed to a $189 roach treatment.' },
      transcription: 'Agent: Hi.\nCaller: bug.\n',
    });
    expect({ call_summary: 'Agreed to a $189 roach treatment.', ...out.extractedPatch }.call_summary).toBeNull();
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    expect(src).toMatch(/bookingExtracted\.call_summary \|\| null,\n\s*\]\.filter\(Boolean\)\.join\(' '\)\.trim\(\),/);
  });
});

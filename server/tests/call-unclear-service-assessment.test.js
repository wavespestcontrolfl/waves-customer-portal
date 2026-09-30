// GATE_CALL_UNCLEAR_SERVICE_ASSESSMENT (owner-approved review item, 2026-09-30).
// A call with a CONFIRMED, ON-THE-HOUR time and a TRUSTED address must not be
// held only because the service is unclear (ambiguous_pest_or_service, or
// low_extraction_confidence when service_address is the only low sub-score):
// the existing fail-open "Waves Assessment" catalog fallback books it, the
// office keeps its advisory card. Gate off = today's behavior, every case.
// Synthetic data only.
const { canAutoRoute } = require('../services/call-triage-flags');
const CallRecordingProcessor = require('../services/call-recording-processor');

const { resolveSchedulableCallService } = CallRecordingProcessor._test;

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

  test('the decision version was bumped and is listed', () => {
    const { V2_DECISION_VERSION, V2_DECISION_VERSIONS } = require('../services/call-routing-gates');
    expect(V2_DECISION_VERSION).toBe('v2-1.51.0');
    expect(V2_DECISION_VERSIONS[V2_DECISION_VERSIONS.length - 1]).toBe(V2_DECISION_VERSION);
  });
});

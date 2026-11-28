/**
 * Call estimate auto-send — shadow verdict (owner 2026-11-23 / 2026-11-27).
 * Holds ONLY for { booked_on_call, termite_hold, commercial_hold }.
 * Delivery channel / TCPA / DNC checks live in the send path (step 2).
 */
const { callAutoSendShadowVerdict } = require('../services/estimator-engine/call-auto-send-shadow');

const base = () => ({
  origin: { channel: 'call' },
  intent: {
    decision: 'draft', services: { pest: { frequency: 'quarterly' } }, is_commercial: false,
    category: 'RESIDENTIAL', confidence: 'medium', constraint_flags: [], customer_phone: '+19415550100',
  },
  propertyFacts: { home: { value: 1850, source: 'county_roll' } },
  context: { phone: '+19415550100', extraction: { quote_promised: true } },
  priorQualifyingServices: [],
  draftPhone: '+19415550100',
  homeSizeDrivesPrice: true,
  laneReasons: [],
});
const verdict = (mutate) => { const input = base(); if (mutate) mutate(input); return callAutoSendShadowVerdict(input); };

describe('callAutoSendShadowVerdict', () => {
  test('a residential pest quote would send', () => {
    expect(verdict()).toEqual({ version: 2, verdict: 'would_send', reasons: [], fixes: [] });
  });

  test('returns null for a non-call origin and for a skipped intent', () => {
    expect(verdict((i) => { i.origin = { channel: 'sms_thread' }; })).toBeNull();
    expect(verdict((i) => { i.intent.decision = 'skip'; })).toBeNull();
  });

  test.each([
    ['booked_on_call', (i) => { i.context.extraction.appointment_confirmed = true; }],
    ['booked_on_call', (i) => { i.context.extraction.scheduling = { status: 'confirmed' }; }],
    ['booked_on_call', (i) => { i.context.call = { ai_extraction: { appointment_confirmed: true } }; }],
    ['termite_hold', (i) => { i.intent.services.termite = { system: 'trelona' }; }],
    ['termite_hold', (i) => { i.intent.constraint_flags = [{ flag: 'possible_termite_swarmers', note: 'flying insects' }]; }],
    ['termite_hold', (i) => { i.context.extraction.service_request = { quote_promised: true, primary_service_category: 'wdo' }; }],
    ['termite_hold', (i) => { i.context.extraction.service_request = { quote_promised: true, secondary_categories: ['wdo_inspection'] }; }],
    ['termite_hold', (i) => { i.context.call = { ai_extraction: { quote_promised: true, requested_service: 'pest control and a WDO inspection' } }; }],
    ['commercial_hold', (i) => { i.intent.is_commercial = true; }],
    ['commercial_hold', (i) => { i.intent.category = 'COMMERCIAL'; }],
  ])('holds with %s', (reason, mutate) => {
    const v = verdict(mutate);
    expect(v.verdict).toBe('would_hold');
    expect(v.reasons).toContain(reason);
  });

  test.each([
    ['quote not promised', (i) => { i.context.extraction = { quote_requested: true }; }],
    ['lane review reason', (i) => { i.laneReasons = ['lot sqft from fallback source (subdivision_median)', 'engine low pricing confidence: lawn_care']; }],
    ['fallback home size', (i) => { i.propertyFacts = { home: { value: 2000, source: 'subdivision_median' } }; }],
    ['new construction', (i) => { i.propertyFacts.newConstruction = true; }],
    ['ambiguous phone', (i) => { i.context.customerPhoneAmbiguous = true; }],
    ['existing customer', (i) => { i.context.isExistingCustomer = true; i.priorQualifyingServices = ['pest_control']; }],
    ['low confidence', (i) => { i.intent.confidence = 'low'; }],
    ['yard changed / declining lawn flags', (i) => { i.intent.services = { lawn: {} }; i.intent.constraint_flags = [{ flag: 'pool_build_tore_up_yard', note: '' }, { flag: 'lawn_dying', note: 'new sod dying' }]; }],
    ['third-party payer flag', (i) => { i.intent.constraint_flags = [{ flag: 'landlord_pays', note: 'realty company covers it' }]; }],
    ['invalid v2 extraction', (i) => { i.context.extraction = {}; i.context.call = { v2_extraction_status: 'invalid', ai_extraction_enriched: { service_request: { primary_service_category: 'termite' } } }; }],
  ])('does not hold for dropped rule: %s', (_label, mutate) => {
    expect(verdict(mutate)).toEqual({ version: 2, verdict: 'would_send', reasons: [], fixes: [] });
  });

  test('termite in the treatment history alone is not a termite request', () => {
    expect(verdict((i) => { i.context.extraction.service_request = { quote_promised: true, primary_category: 'ants', prior_treatment_attempts: ['termite tenting in 2019'] }; }).verdict).toBe('would_send');
  });

  test('a one-time pest ask with no plan line names the fix and still sends', () => {
    const v = verdict((i) => { i.intent.services = { oneTimePest: {} }; });
    expect(v).toMatchObject({ verdict: 'would_send', fixes: ['add_recurring_pest'] });
    expect(verdict((i) => { i.intent.services = { oneTimePest: {}, pest: {} }; }).fixes).toEqual([]);
  });
});

/**
 * Call estimate auto-send — shadow verdict (owner 2026-11-25 *build*, step 1).
 * Behavior: the watch-only stamp says "would send" only when every owner
 * hold rule passes. Regression it guards: a termite, commercial, booked or
 * no-home-size call reading as sendable once step 2 reuses this rule.
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
  pricedLineNeedsReview: false,
});
const verdict = (mutate) => { const input = base(); if (mutate) mutate(input); return callAutoSendShadowVerdict(input); };

describe('callAutoSendShadowVerdict', () => {
  test('a promised residential pest quote with a real home size would send', () => {
    expect(verdict()).toEqual({ version: 1, verdict: 'would_send', reasons: [], fixes: [] });
  });

  test('returns null for a non-call origin and for a skipped intent', () => {
    expect(verdict((i) => { i.origin = { channel: 'sms_thread' }; })).toBeNull();
    expect(verdict((i) => { i.intent.decision = 'skip'; })).toBeNull();
  });

  test.each([
    ['booked_on_call', (i) => { i.context.extraction.appointment_confirmed = true; }],
    ['booked_on_call', (i) => { i.context.extraction.scheduling = { status: 'confirmed' }; }],
    ['quote_not_promised', (i) => { i.context.extraction = { quote_requested: true }; }],
    ['quote_not_promised', (i) => { i.context.extraction = null; }],
    ['priced_line_needs_review', (i) => { i.pricedLineNeedsReview = true; }],
    ['current_customer_reprice_pending', (i) => { i.context.isExistingCustomer = true; }],
    ['termite_hold', (i) => { i.intent.services.termite = { system: 'trelona' }; }],
    ['termite_hold', (i) => { i.intent.constraint_flags = [{ flag: 'possible_termite_swarmers', note: 'flying insects' }]; }],
    ['commercial_hold', (i) => { i.intent.is_commercial = true; }],
    ['commercial_hold', (i) => { i.intent.category = 'COMMERCIAL'; }],
    ['home_size_not_found', (i) => { i.propertyFacts = { home: { value: null, source: null } }; }],
    ['home_size_not_found', (i) => { i.propertyFacts = { home: { value: 2000, source: 'subdivision_median' } }; }],
    ['new_construction', (i) => { i.propertyFacts.newConstruction = true; }],
    ['ambiguous_phone', (i) => { i.context.customerPhoneAmbiguous = true; }],
    ['current_customer_reprice_pending', (i) => { i.priorQualifyingServices = ['pest_control']; }],
    ['low_confidence', (i) => { i.intent.confidence = 'low'; }],
    ['third_party_payer', (i) => { i.intent.constraint_flags = [{ flag: 'landlord_pays', note: 'realty company covers it' }]; }],
    ['third_party_payer', (i) => { i.context.extraction.secondary_contacts = [{ role: 'landlord', is_billing_party: true }]; }],
    ['no_contact', (i) => { i.context.extraction.caller = { ani_cannot_text: true }; }],
    ['no_contact', (i) => { i.context.extraction.consent = { sms_declined: true }; }],
    ['no_contact', (i) => { i.context.customer = { email: 'a@example.com' }; i.context.extraction.consent = { do_not_contact_request: true }; }],
    ['termite_hold', (i) => { i.context.call = { ai_extraction: { quote_promised: true, requested_service: 'pest control and a WDO inspection' } }; }],
    ['booked_on_call', (i) => { i.context.call = { ai_extraction: { appointment_confirmed: true } }; }],
    ['termite_hold', (i) => { i.context.extraction.service_request = { quote_promised: true, secondary_categories: ['wdo_inspection'] }; }],
    // A caller ID exists, but the draft resolved no storable phone.
    ['no_contact', (i) => { i.draftPhone = null; }],
  ])('holds with %s', (reason, mutate) => {
    const v = verdict(mutate);
    expect(v.verdict).toBe('would_hold');
    expect(v.reasons).toContain(reason);
  });

  test('lawn holds for a changed yard or a declining lawn only when lawn is quoted', () => {
    const flags = [{ flag: 'pool_build_tore_up_yard', note: '' }, { flag: 'lawn_dying', note: 'new sod dying' }];
    const lawn = verdict((i) => { i.intent.services = { lawn: {} }; i.intent.constraint_flags = flags; });
    expect(lawn.reasons).toEqual(expect.arrayContaining(['yard_changed_book_assessment', 'lawn_declining_book_assessment']));
    const pestOnly = verdict((i) => { i.intent.constraint_flags = flags; });
    expect(pestOnly.verdict).toBe('would_send');
  });

  test('a v2 extraction promise counts, and an email alone is a contact', () => {
    expect(verdict((i) => { i.context.extraction = { service_request: { quote_promised: true } }; }).verdict).toBe('would_send');
    expect(verdict((i) => { i.draftPhone = null; i.context.customer = { email: 'a@example.com' }; }).verdict).toBe('would_send');
  });

  test('a promise in either original extraction counts, and only a valid v2 speaks', () => {
    const v1Only = (i) => { i.context.extraction = { service_request: {} }; i.context.call = { ai_extraction: JSON.stringify({ quote_promised: true }) }; };
    expect(verdict(v1Only).verdict).toBe('would_send');
    const invalidV2 = (i) => { i.context.extraction = {}; i.context.call = { v2_extraction_status: 'invalid', ai_extraction_enriched: { service_request: { quote_promised: true } } }; };
    expect(verdict(invalidV2).reasons).toContain('quote_not_promised');
  });

  test('a landlord named for access only is not a payer', () => {
    expect(verdict((i) => { i.intent.constraint_flags = [{ flag: 'landlord_approval_needed', note: 'landlord must OK access' }]; }).verdict).toBe('would_send');
  });

  test('a draft priced only by the bedroom band is not a home size miss', () => {
    // The unit-scope model clears whole-building area to source "unresolved".
    const unit = (i) => { i.propertyFacts = { home: { value: null, source: 'unresolved' } }; };
    expect(verdict((i) => { unit(i); i.homeSizeDrivesPrice = false; }).verdict).toBe('would_send');
    expect(verdict(unit).reasons).toContain('home_size_not_found');
  });

  test('a one-time pest ask with no plan line names the fix and still sends', () => {
    const v = verdict((i) => { i.intent.services = { oneTimePest: {} }; });
    expect(v).toMatchObject({ verdict: 'would_send', fixes: ['add_recurring_pest'] });
    expect(verdict((i) => { i.intent.services = { oneTimePest: {}, pest: {} }; }).fixes).toEqual([]);
  });
});

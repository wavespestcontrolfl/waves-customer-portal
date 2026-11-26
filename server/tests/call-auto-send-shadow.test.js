/**
 * Call estimate auto-send — shadow verdict (owner 2026-11-25 *build*, step 1).
 * Behavior: the watch-only stamp says "would send" only when every owner
 * hold rule passes. Regression it guards: a termite, commercial, booked or
 * no-home-size call reading as sendable once step 2 reuses this rule.
 */
const { callAutoSendShadowVerdict } = require('../services/estimator-engine/call-auto-send-shadow');

const base = () => ({
  origin: { channel: 'call' },
  quotePromised: true,
  intent: {
    decision: 'draft', services: { pest: { frequency: 'quarterly' } }, is_commercial: false,
    category: 'RESIDENTIAL', confidence: 'medium', constraint_flags: [], customer_phone: '+19415550100',
  },
  propertyFacts: { home: { value: 1850, source: 'county_roll' } },
  context: { phone: '+19415550100', extraction: {} },
  priorQualifyingServices: [],
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
    ['booked_on_call', (i) => { i.context.extraction = { appointment_confirmed: true }; }],
    ['booked_on_call', (i) => { i.context.extraction = { scheduling: { status: 'confirmed' } }; }],
    ['quote_not_promised', (i) => { i.quotePromised = false; }],
    ['quote_not_promised', (i) => { i.quotePromised = null; }],
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
    ['no_contact', (i) => { i.context.phone = null; i.intent.customer_phone = null; }],
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

  test('a unit scope with no individual home size is not a size miss', () => {
    expect(verdict((i) => { i.propertyFacts = { home: { value: null, source: 'not_applicable:unit' } }; }).verdict).toBe('would_send');
  });

  test('a one-time pest ask with no plan line names the fix and still sends', () => {
    const v = verdict((i) => { i.intent.services = { oneTimePest: {} }; });
    expect(v).toMatchObject({ verdict: 'would_send', fixes: ['add_recurring_pest'] });
    expect(verdict((i) => { i.intent.services = { oneTimePest: {}, pest: {} }; }).fixes).toEqual([]);
  });
});

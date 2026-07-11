/**
 * Recurring-intent default for matched_service (owner rule 2026-07-11, the
 * Detwiler call): a new-lead caller who voices recurring interest gets the
 * recurring pest program, not the single pest that prompted the call. Pins
 * the deterministic backstop: caller-words-only trigger, cadence selection
 * with the quarterly default, the decline guard, and the narrow scope.
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
const { applyRecurringIntentDefault } = _test;

const lead = (over = {}) => ({ is_lead: true, matched_service: 'Bee / Wasp Nest Removal Service', ...over });

describe('applyRecurringIntentDefault', () => {
  test('the Detwiler call: wasp nest + caller floats quarterly/six-months → Quarterly (the default)', () => {
    const t = [
      'Agent: You\'re looking for a one time, correct?',
      'Caller: Um, no, I wouldn\'t mind doing definitely now, but also like a package maybe every six months or I always get bugs.',
      'Caller: Did it quarterly or maybe every six months? I don\'t know what you usually do financially also.',
    ].join('\n');
    expect(applyRecurringIntentDefault(lead(), t).matched_service).toBe('Quarterly Pest Control Service');
  });

  test('an explicitly chosen cadence wins: "every six months" alone → Semiannual, "monthly" alone → Monthly', () => {
    expect(applyRecurringIntentDefault(lead(), 'Caller: I want you out every six months.').matched_service)
      .toBe('Semiannual Pest Control Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: can we set up monthly service?').matched_service)
      .toBe('Monthly Pest Control Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: I\'d like a recurring package.').matched_service)
      .toBe('Quarterly Pest Control Service');
  });

  test('only the CALLER\'s words trigger it — an agent upsell the caller ignores does not', () => {
    const t = [
      'Agent: We also offer a quarterly package if you\'re interested.',
      'Caller: I just have the one wasp nest by the garage.',
    ].join('\n');
    expect(applyRecurringIntentDefault(lead(), t).matched_service).toBe('Bee / Wasp Nest Removal Service');
  });

  test('an explicit decline keeps the single service', () => {
    expect(applyRecurringIntentDefault(lead(), 'Caller: I don\'t want a recurring plan, just the wasp nest.').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: just a one-time treatment please.').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
  });

  test('scope: non-leads and non-general-pest services are untouched', () => {
    expect(applyRecurringIntentDefault(lead({ is_lead: false }), 'Caller: quarterly please').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
    expect(applyRecurringIntentDefault(lead({ matched_service: 'Termite Inspection Service' }), 'Caller: quarterly please').matched_service)
      .toBe('Termite Inspection Service');
    expect(applyRecurringIntentDefault(lead({ matched_service: 'Rodent Trapping Service' }), 'Caller: ongoing service please').matched_service)
      .toBe('Rodent Trapping Service');
    expect(applyRecurringIntentDefault(null, 'Caller: quarterly')).toBeNull();
  });

  test('explicit bi-monthly cadence is honored, not defaulted to quarterly', () => {
    expect(applyRecurringIntentDefault(lead(), 'Caller: could you come out every other month?').matched_service)
      .toBe('Bi-Monthly Pest Control Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: I want the bi-monthly plan.').matched_service)
      .toBe('Bi-Monthly Pest Control Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: maybe every two months?').matched_service)
      .toBe('Bi-Monthly Pest Control Service');
  });

  test('negated one-time wording is a recurring REQUEST, not a decline', () => {
    expect(applyRecurringIntentDefault(lead(), 'Caller: not just a one-time treatment, I want a package.').matched_service)
      .toBe('Quarterly Pest Control Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: more than just a one-time thing, something recurring.').matched_service)
      .toBe('Quarterly Pest Control Service');
  });

  test('unsuffixed catalog aliases still trigger the rule', () => {
    expect(applyRecurringIntentDefault(lead({ matched_service: 'Bee / Wasp Nest Removal' }), 'Caller: a quarterly package please').matched_service)
      .toBe('Quarterly Pest Control Service');
    expect(applyRecurringIntentDefault(lead({ matched_service: 'Fire Ant Treatment' }), 'Caller: recurring please').matched_service)
      .toBe('Quarterly Pest Control Service');
  });

  test('a singular specific_service_name is corrected too (it outranks matched_service in booking)', () => {
    const out = applyRecurringIntentDefault(
      lead({ matched_service: 'Quarterly Pest Control Service', specific_service_name: 'Bee / Wasp Nest Removal Service' }),
      'Caller: I want the quarterly package.'
    );
    expect(out.specific_service_name).toBe('Quarterly Pest Control Service');
    expect(out.matched_service).toBe('Quarterly Pest Control Service');
  });

  test('unlabelled transcripts fail open (whole text scanned) and already-recurring stays put', () => {
    expect(applyRecurringIntentDefault(lead(), 'I want a quarterly package for the ants').matched_service)
      .toBe('Quarterly Pest Control Service');
    const already = lead({ matched_service: 'Quarterly Pest Control Service' });
    expect(applyRecurringIntentDefault(already, 'Caller: quarterly package please')).toBe(already);
  });
});

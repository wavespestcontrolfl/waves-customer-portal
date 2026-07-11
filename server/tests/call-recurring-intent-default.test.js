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

  test('pest-frequency observations are not plan interest', () => {
    expect(applyRecurringIntentDefault(
      lead({ matched_service: 'Fire Ant Treatment Service' }),
      'Caller: we get fire ants every month in that corner of the yard.'
    ).matched_service).toBe('Fire Ant Treatment Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: I keep seeing them every few weeks.').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
    // ...but a service-framed cadence still counts, and picks its family.
    expect(applyRecurringIntentDefault(lead(), 'Caller: could you come out every month?').matched_service)
      .toBe('Monthly Pest Control Service');
  });

  test('bare opt-outs decline ("no package"), but "no contract" is month-to-month language, not a decline', () => {
    expect(applyRecurringIntentDefault(lead(), 'Caller: no package, only the wasp nest please.').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: no recurring, just this nest.').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: can I do quarterly with no contract?').matched_service)
      .toBe('Quarterly Pest Control Service');
  });

  test('caller continuation lines in a diarized turn are scanned', () => {
    const t = [
      'Agent: what are you looking for?',
      'Caller: I have a wasp nest by the garage',
      'and I would also want a quarterly package for the ants.',
      'Agent: sure, we can do that.',
    ].join('\n');
    expect(applyRecurringIntentDefault(lead(), t).matched_service).toBe('Quarterly Pest Control Service');
    // Agent continuation lines still don't leak into the caller text.
    const t2 = [
      'Caller: I just have the one wasp nest.',
      'Agent: we do offer a plan,',
      'a quarterly package many customers like.',
      'Caller: okay.',
    ].join('\n');
    expect(applyRecurringIntentDefault(lead(), t2).matched_service).toBe('Bee / Wasp Nest Removal Service');
  });

  test('generic one-time pest catalog names are covered (knockdown protocols deliberately not)', () => {
    expect(applyRecurringIntentDefault(lead({ matched_service: 'Cockroach Control Service' }), 'Caller: I want a recurring package.').matched_service)
      .toBe('Quarterly Pest Control Service');
    expect(applyRecurringIntentDefault(lead({ matched_service: 'Initial Pest Cleanout' }), 'Caller: sign me up for the quarterly plan.').matched_service)
      .toBe('Quarterly Pest Control Service');
    expect(applyRecurringIntentDefault(lead({ matched_service: 'Initial German Roach Knockdown Service' }), 'Caller: I want a recurring package.').matched_service)
      .toBe('Initial German Roach Knockdown Service');
  });

  test('a request verb after the pest mention preserves the cadence ask', () => {
    expect(applyRecurringIntentDefault(lead(), 'Caller: I have ants and want monthly service.').matched_service)
      .toBe('Monthly Pest Control Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: we have roaches and I need you out every six months.').matched_service)
      .toBe('Semiannual Pest Control Service');
  });

  test('"I don\'t want just a one-time" is a recurring request, not a decline', () => {
    expect(applyRecurringIntentDefault(lead(), "Caller: I don't want just a one-time treatment; I want a package.").matched_service)
      .toBe('Quarterly Pest Control Service');
    // The plain form still declines.
    expect(applyRecurringIntentDefault(lead(), 'Caller: I want just a one-time treatment.').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
  });

  test('an ACCEPTED agent plan offer counts as intent, with the cadence from the offer', () => {
    const accepted = [
      'Caller: I have a wasp nest by the garage.',
      'Agent: we could put you on our quarterly service, most folks do that.',
      'Caller: yes, that works.',
    ].join('\n');
    expect(applyRecurringIntentDefault(lead(), accepted).matched_service).toBe('Quarterly Pest Control Service');
    // The same offer with no affirmative reply stays an ignored upsell.
    const ignored = [
      'Caller: I have a wasp nest by the garage.',
      'Agent: we could put you on our quarterly service, most folks do that.',
      'Caller: no, let me think about it.',
    ].join('\n');
    expect(applyRecurringIntentDefault(lead(), ignored).matched_service).toBe('Bee / Wasp Nest Removal Service');
  });

  test('"ongoing"/"year-round" as pest descriptions are not plan interest; as service asks they are', () => {
    expect(applyRecurringIntentDefault(lead(), 'Caller: I have an ongoing ant problem.').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: this has been ongoing for months.').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: I want ongoing service.').matched_service)
      .toBe('Quarterly Pest Control Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: something to keep the bugs away year-round.').matched_service)
      .toBe('Quarterly Pest Control Service');
  });

  test('a model-picked recurring cadence is retargeted when the caller chose ONE other cadence', () => {
    expect(applyRecurringIntentDefault(
      lead({ matched_service: 'Quarterly Pest Control Service' }),
      'Caller: could you come every other month?'
    ).matched_service).toBe('Bi-Monthly Pest Control Service');
    // Ambiguous cadence keeps the model's pick.
    expect(applyRecurringIntentDefault(
      lead({ matched_service: 'Quarterly Pest Control Service' }),
      'Caller: quarterly or every six months, whatever you recommend.'
    ).matched_service).toBe('Quarterly Pest Control Service');
  });

  test('the bare "Pest Control Service" scheduler fallback label is covered', () => {
    expect(applyRecurringIntentDefault(lead({ matched_service: 'Pest Control Service' }), 'Caller: I want a quarterly package.').matched_service)
      .toBe('Quarterly Pest Control Service');
  });

  test('declining one option then choosing another is a recurring request', () => {
    expect(applyRecurringIntentDefault(lead(), "Caller: I don't want the monthly plan. Can we do quarterly instead?").matched_service)
      .toBe('Quarterly Pest Control Service');
    // A decline with nothing recurring after it still declines.
    expect(applyRecurringIntentDefault(lead(), "Caller: I don't want a plan. Just the nest please.").matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
  });

  test('negated cadence words are not the chosen cadence', () => {
    expect(applyRecurringIntentDefault(lead(), 'Caller: I want a package, but not monthly.').matched_service)
      .toBe('Quarterly Pest Control Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: instead of monthly, could you do every other month?').matched_service)
      .toBe('Bi-Monthly Pest Control Service');
  });

  test('unlabelled transcripts fail open (whole text scanned) and already-recurring stays put', () => {
    expect(applyRecurringIntentDefault(lead(), 'I want a quarterly package for the ants').matched_service)
      .toBe('Quarterly Pest Control Service');
    const already = lead({ matched_service: 'Quarterly Pest Control Service' });
    expect(applyRecurringIntentDefault(already, 'Caller: quarterly package please')).toBe(already);
  });
});

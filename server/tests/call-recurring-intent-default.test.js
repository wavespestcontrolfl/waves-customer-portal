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

  test('curly apostrophes: "don’t want a recurring plan" still declines', () => {
    expect(applyRecurringIntentDefault(lead(), 'Caller: I don’t want a recurring plan, just the nest.').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
  });

  test('raw "Speaker N:" diarization fails CLOSED — an agent upsell there cannot trigger the override', () => {
    const raw = [
      'Speaker 1: we could put you on our quarterly package.',
      'Speaker 2: I just have the one wasp nest.',
    ].join('\n');
    expect(applyRecurringIntentDefault(lead(), raw).matched_service).toBe('Bee / Wasp Nest Removal Service');
  });

  test('"definitely not" after a plan offer is a rejection, not acceptance', () => {
    const t = [
      'Caller: I have a wasp nest.',
      'Agent: we could put you on our quarterly service.',
      'Caller: definitely not, just the nest.',
    ].join('\n');
    expect(applyRecurringIntentDefault(lead(), t).matched_service).toBe('Bee / Wasp Nest Removal Service');
  });

  test('program names resolve from the live catalog when provided (seeded-DB naming)', () => {
    const seededCatalog = [
      'One-Time Pest Control Service',
      'General Pest Control Service (Bi-Monthly)',
      'General Pest Control Service (Semiannual)',
      'Quarterly Pest Control Service',
    ];
    expect(applyRecurringIntentDefault(lead(), 'Caller: could you come every other month?', seededCatalog).matched_service)
      .toBe('General Pest Control Service (Bi-Monthly)');
    // Prod-shaped catalog resolves the prod names; no catalog falls back to them.
    expect(applyRecurringIntentDefault(lead(), 'Caller: could you come every other month?', ['Bi-Monthly Pest Control Service']).matched_service)
      .toBe('Bi-Monthly Pest Control Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: could you come every other month?').matched_service)
      .toBe('Bi-Monthly Pest Control Service');
  });

  test('a negated cadence is a decline: "I don\'t want quarterly, just the wasp nest" stays', () => {
    expect(applyRecurringIntentDefault(lead(), "Caller: I don't want quarterly, just the wasp nest.").matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: no monthly for me, one visit please.').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
  });

  test('a NEGATIVE agent confirmation is not a plan offer', () => {
    const t = [
      'Caller: I have a wasp nest.',
      'Agent: so just the nest, not quarterly service?',
      'Caller: yes.',
    ].join('\n');
    expect(applyRecurringIntentDefault(lead(), t).matched_service).toBe('Bee / Wasp Nest Removal Service');
  });

  test('an accepted COUNTEROFFER after a decline converts, with the counteroffer cadence', () => {
    const t = [
      "Caller: I don't want a monthly plan.",
      'Agent: understood — we can do quarterly instead.',
      'Caller: yes, that works.',
    ].join('\n');
    expect(applyRecurringIntentDefault(lead(), t).matched_service).toBe('Quarterly Pest Control Service');
  });

  test('seeded-DB recurring alias names are recognized for cadence retargeting', () => {
    expect(applyRecurringIntentDefault(
      lead({ matched_service: 'General Pest Control Service (Semiannual)' }),
      'Caller: could you come every other month?'
    ).matched_service).toBe('Bi-Monthly Pest Control Service');
  });

  test('historical cadence mentions are not new plan interest', () => {
    expect(applyRecurringIntentDefault(
      lead(),
      'Caller: I used to have quarterly service, but now I just need the wasp nest removed.'
    ).matched_service).toBe('Bee / Wasp Nest Removal Service');
    // A present-tense quarterly ask still converts.
    expect(applyRecurringIntentDefault(lead(), 'Caller: can you set me up on quarterly?').matched_service)
      .toBe('Quarterly Pest Control Service');
  });

  test('request idioms with "have" are asks, not pressure', () => {
    expect(applyRecurringIntentDefault(lead(), 'Caller: can I have quarterly service?').matched_service)
      .toBe('Quarterly Pest Control Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: I want to have monthly service.').matched_service)
      .toBe('Monthly Pest Control Service');
  });

  test('bare and plural plan/package requests trigger', () => {
    expect(applyRecurringIntentDefault(lead(), 'Caller: I want a plan.').matched_service)
      .toBe('Quarterly Pest Control Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: what packages do you offer?').matched_service)
      .toBe('Quarterly Pest Control Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: do you have plans?').matched_service)
      .toBe('Quarterly Pest Control Service');
    // "plan to" (intention, not program) does not.
    expect(applyRecurringIntentDefault(lead(), 'Caller: I have a plan to seal the garage myself.').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
  });

  test('bare ongoing/year-round problem DESCRIPTIONS never convert', () => {
    expect(applyRecurringIntentDefault(lead(), 'Caller: it is an ongoing ant problem.').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: year-round bugs are the issue here.').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
  });

  test('an explicitly negated veto cadence does not erase the chosen one', () => {
    expect(applyRecurringIntentDefault(lead(), 'Caller: I want monthly, not bi-monthly.').matched_service)
      .toBe('Monthly Pest Control Service');
  });

  test('a cadence-only opt-out does not erase a package request', () => {
    expect(applyRecurringIntentDefault(lead(), 'Caller: I want a package, no monthly though.').matched_service)
      .toBe('Quarterly Pest Control Service');
  });

  test('"was on / used to be on" cadences are history, not intent', () => {
    expect(applyRecurringIntentDefault(lead(), 'Caller: I was on quarterly service years ago, just need the nest gone.').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: we used to be on monthly with another company.').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
  });

  test('"not interested in monthly" is a negated cadence, not intent', () => {
    expect(applyRecurringIntentDefault(lead(), "Caller: I'm not interested in monthly, just remove the wasp nest.").matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
  });

  test('calendar "plans" are not program interest; offer-inquiry "plans" still are', () => {
    expect(applyRecurringIntentDefault(lead(), 'Caller: I have plans this afternoon, but I need the wasp nest removed.').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: do you have plans?').matched_service)
      .toBe('Quarterly Pest Control Service');
  });

  test('filler before an affirmation still accepts the offer', () => {
    const t = [
      'Caller: I have a wasp nest.',
      'Agent: we could put you on our quarterly service.',
      'Caller: um, yes, that works.',
    ].join('\n');
    expect(applyRecurringIntentDefault(lead(), t).matched_service).toBe('Quarterly Pest Control Service');
  });

  test('modified bare opt-outs decline: "no service plan", "without a maintenance plan"', () => {
    expect(applyRecurringIntentDefault(lead(), 'Caller: no service plan, just the nest.').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: without a maintenance plan please.').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
  });

  test('calendar plans in more shapes stay non-intent', () => {
    for (const t of ['Caller: I have plans Saturday.', 'Caller: plans next week, so come Monday.', 'Caller: my plans changed.']) {
      expect(applyRecurringIntentDefault(lead(), t).matched_service).toBe('Bee / Wasp Nest Removal Service');
    }
  });

  test('billing cadence is not service cadence', () => {
    expect(applyRecurringIntentDefault(lead(), 'Caller: can I pay monthly for the one-time wasp treatment?').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: is this billed monthly?').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
  });

  test('coordinated opt-outs negate BOTH cadences; positive floats still default quarterly', () => {
    expect(applyRecurringIntentDefault(lead(), "Caller: I don't want monthly or quarterly, just the nest.").matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: I want a package — monthly or quarterly, whichever you recommend.').matched_service)
      .toBe('Quarterly Pest Control Service');
  });

  test('an active plan with ANOTHER company is context, not intent', () => {
    expect(applyRecurringIntentDefault(
      lead(),
      "Caller: I'm on quarterly service with another company, but I just need this wasp nest removed."
    ).matched_service).toBe('Bee / Wasp Nest Removal Service');
  });

  test('an agent NEGATIVE plan statement plus "yes" is not an accepted offer', () => {
    const t = [
      'Caller: I have a wasp nest.',
      "Agent: we do not offer quarterly service for a nest removal; it's one-time. Sound good?",
      'Caller: yes.',
    ].join('\n');
    expect(applyRecurringIntentDefault(lead(), t).matched_service).toBe('Bee / Wasp Nest Removal Service');
  });

  test('unlabelled transcripts fail open (whole text scanned) and already-recurring stays put', () => {
    expect(applyRecurringIntentDefault(lead(), 'I want a quarterly package for the ants').matched_service)
      .toBe('Quarterly Pest Control Service');
    const already = lead({ matched_service: 'Quarterly Pest Control Service' });
    expect(applyRecurringIntentDefault(already, 'Caller: quarterly package please')).toBe(already);
  });
});

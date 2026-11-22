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

// The agreed-one-time-job hold is part of V2-primary adoption, so the processor loads in that mode (the two
// flags are read once, at load). The older cases pass no hold, and the mode does not touch them. The hold's own
// gate is read at call time; its describe block turns it on.
const ENV_BEFORE = {
  CALL_EXTRACTION_V2_ENABLED: process.env.CALL_EXTRACTION_V2_ENABLED,
  CALL_EXTRACTION_V2_DRIVES_ROUTING: process.env.CALL_EXTRACTION_V2_DRIVES_ROUTING,
  CALL_EXTRACTION_V2_PRIMARY: process.env.CALL_EXTRACTION_V2_PRIMARY,
  GATE_CALL_AGREED_ONE_TIME_JOB: process.env.GATE_CALL_AGREED_ONE_TIME_JOB,
};
process.env.CALL_EXTRACTION_V2_ENABLED = 'true';
process.env.CALL_EXTRACTION_V2_DRIVES_ROUTING = 'true';
delete process.env.CALL_EXTRACTION_V2_PRIMARY;
afterAll(() => {
  for (const [key, value] of Object.entries(ENV_BEFORE)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

const fs = require('fs');
const { _test } = require('../services/call-recording-processor');
const { applyRecurringIntentDefault, callAgreedOneTimeJob, agreedJobHoldChangesService, adoptAgreedOneTimeService } = _test;

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
    // The renamed catalog row (migration 20260730160000) — new extractions
    // emit this name, so it must override exactly like the legacy one
    // (codex #3108 P1: the extractor's example cites the new name, and a
    // missing entry booked the one-time roach service over the asked-for
    // recurring program).
    expect(applyRecurringIntentDefault(lead({ matched_service: 'Cockroach Treatment' }), 'Caller: I want a recurring package.').matched_service)
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

  test('repeated and standalone negated opt-outs never read as intent', () => {
    expect(applyRecurringIntentDefault(lead(), "Caller: I don't want a recurring plan. I don't want a package either, just the nest.").matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: not a package deal, just the nest please.').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
  });

  test('payment plans are billing, not program interest', () => {
    expect(applyRecurringIntentDefault(lead(), 'Caller: do you have payment plans?').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: can I do installment plans for the wasp job?').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
  });

  test('current stinging-insect one-time labels are covered', () => {
    expect(applyRecurringIntentDefault(lead({ matched_service: 'Wasp Control Service' }), 'Caller: I want the quarterly package.').matched_service)
      .toBe('Quarterly Pest Control Service');
    expect(applyRecurringIntentDefault(lead({ matched_service: 'Yellow Jacket Control Service' }), 'Caller: sign me up for a recurring plan.').matched_service)
      .toBe('Quarterly Pest Control Service');
  });

  test('matched_service is filled when only specific_service_name carried the program', () => {
    const out = applyRecurringIntentDefault(
      lead({ matched_service: null, specific_service_name: 'Bee / Wasp Nest Removal Service' }),
      'Caller: I want the quarterly package.'
    );
    expect(out.specific_service_name).toBe('Quarterly Pest Control Service');
    expect(out.matched_service).toBe('Quarterly Pest Control Service');
  });

  test('the default is never a cadence the caller excluded', () => {
    expect(applyRecurringIntentDefault(lead(), 'Caller: I want a plan, but no quarterly.').matched_service)
      .toBe('Bi-Monthly Pest Control Service');
    expect(applyRecurringIntentDefault(lead(), "Caller: I want a package, but not monthly or quarterly.").matched_service)
      .toBe('Bi-Monthly Pest Control Service');
  });

  test('"do you have <cadence> service?" is an inquiry, not possession', () => {
    expect(applyRecurringIntentDefault(lead(), 'Caller: do you have quarterly service?').matched_service)
      .toBe('Quarterly Pest Control Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: I need to have monthly service.').matched_service)
      .toBe('Monthly Pest Control Service');
  });

  test('third-person opt-outs decline', () => {
    expect(applyRecurringIntentDefault(lead(), "Caller: my wife doesn't want a plan, just the nest.").matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
    expect(applyRecurringIntentDefault(lead(), "Caller: she isn't interested in recurring, one visit only.").matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
  });

  test('post-cadence billing nouns stay billing', () => {
    expect(applyRecurringIntentDefault(lead(), 'Caller: do you offer monthly payments for the wasp treatment?').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
    expect(applyRecurringIntentDefault(lead(), 'Caller: what is the quarterly price if I just do the one-time?').matched_service)
      .toBe('Bee / Wasp Nest Removal Service');
  });

  test('unlabelled transcripts fail open (whole text scanned) and already-recurring stays put', () => {
    expect(applyRecurringIntentDefault(lead(), 'I want a quarterly package for the ants').matched_service)
      .toBe('Quarterly Pest Control Service');
    const already = lead({ matched_service: 'Quarterly Pest Control Service' });
    expect(applyRecurringIntentDefault(already, 'Caller: quarterly package please')).toBe(already);
  });
});

// Owner 2026-11-22 ("fix", then "yes" to the service-only cut): the rule keeps the AI's one-time
// service when staff priced ONE one-time job on the call. 2026-11-21: a same-day one-time ant job
// booked as Monthly Pest Control, because the caller's only cadence word named the plan another
// company had sold her. The AI books no visit for a job the hold changed (owner 2026-11-22, "card"): the
// booking's hold is pinned in call-agreed-price-gate.test.js.
describe('an agreed one-time job keeps its one-time service (owner 2026-11-22, GATE_CALL_AGREED_ONE_TIME_JOB)', () => {
  const TRANSCRIPT = [
    'Caller: Do you have anyone that could come out and spray today?',
    'Agent: One-time service is $250, but it varies.',
    'Caller: Okay. I just signed up for a monthly service with another company that I do not even need.',
  ].join('\n');
  const price = (over = {}) => ({ amount_usd: 250, amount_max_usd: null, unit: 'one_time', accepted: true, stated_by: 'agent', tier_mentioned: null, prepay_term: null, ...over });
  // The validated V2 extraction: the service it named, what the call was about, and the prices of the call.
  // `over` changes service_request; `top` changes the extraction's own fields.
  const v2 = (over = {}, top = {}) => ({
    meta: { schema_version: '1.13.0' },
    triage_flags: ['no_sms_consent_captured'],
    property: { additional_properties: [] },
    ...top,
    service_request: {
      specific_service_name: 'One-Time Pest Control Service', service_intent: 'active_infestation_treatment',
      primary_service_category: 'pest_general', secondary_categories: [], waveguard_tier_mentioned: null, billing_choice: null,
      price_discussed: true, quoted_price_usd: null, price: price(), prices: [price()], ...over,
    },
  });
  const onePrice = (over) => ({ price: price(over), prices: [price(over)] });
  const oneTime = () => lead({ matched_service: 'One-Time Pest Control Service', specific_service_name: 'One-Time Pest Control Service' });
  // The bookable catalog rows, as loadBookableCallServices reads them.
  const row = (name, key, billing = 'one_time', base = null) => ({ id: key, service_key: key, name, billing_type: billing, pricing_type: 'variable', base_price: base });
  const ONE_TIME_ROW = row('One-Time Pest Control Service', 'pest_one_time', 'one_time', 250);
  const SERVICES = [
    ONE_TIME_ROW,
    row('Bee / Wasp Nest Removal Service', 'bee_wasp_nest_removal'),
    row('Monthly Pest Control Service', 'pest_general_monthly', 'recurring'),
    row('Quarterly Pest Control Service', 'pest_general_quarterly', 'recurring'),
  ];
  const agreed = (extraction, services = SERVICES) => callAgreedOneTimeJob(extraction, services);
  const booked = (view, extraction, services) => applyRecurringIntentDefault(view, TRANSCRIPT, [], agreed(extraction, services)).specific_service_name;

  beforeEach(() => { process.env.GATE_CALL_AGREED_ONE_TIME_JOB = 'true'; });
  afterEach(() => { delete process.env.GATE_CALL_AGREED_ONE_TIME_JOB; });

  test('with no hold the rule reads the cadence word, as before', () => {
    expect(applyRecurringIntentDefault(oneTime(), TRANSCRIPT).specific_service_name).toBe('Monthly Pest Control Service');
    expect(applyRecurringIntentDefault(oneTime(), TRANSCRIPT, [], false).specific_service_name).toBe('Monthly Pest Control Service');
    // Only `true` holds: an extraction handed over by mistake is not a hold.
    expect(applyRecurringIntentDefault(oneTime(), TRANSCRIPT, [], v2()).specific_service_name).toBe('Monthly Pest Control Service');
  });

  test('V2 named a one-time service and staff priced one one-time job on the call: the service stays', () => {
    expect(agreed(v2())).toBe(true);
    expect(booked(oneTime(), v2())).toBe('One-Time Pest Control Service');
    const view = oneTime();
    expect(applyRecurringIntentDefault(view, TRANSCRIPT, [], true)).toBe(view);
    // Any singular service in the view is kept, not only the one V2 named.
    const nest = lead({ specific_service_name: 'Bee / Wasp Nest Removal Service' });
    expect(applyRecurringIntentDefault(nest, TRANSCRIPT, [], true)).toBe(nest);
    // The strict agreed total with its one-time entry reads the same.
    expect(agreed(v2({ quoted_price_usd: 250 }))).toBe(true);
    // A one-time preventative job is a one-time job too.
    expect(agreed(v2({ service_intent: 'preventative_one_time' }))).toBe(true);
    // A reading with no word on whether a price was discussed still holds its accepted price.
    expect(agreed(v2({ price_discussed: null }))).toBe(true);
  });

  test('each part of the hold is needed: without it the rule applies', () => {
    const noHold = [
      v2({ specific_service_name: 'Quarterly Pest Control Service' }), // V2 named a program
      v2({ specific_service_name: null }),
      { service_request: v2().service_request }, // not a validated V2 extraction
      // Staff did not price ONE one-time job.
      v2({ price: null, prices: [] }), // no price on the call
      v2({ price_discussed: false }), // the reading says no price was discussed
      v2(onePrice({ accepted: false })), // a price nobody accepted
      v2(onePrice({ accepted: null })),
      v2(onePrice({ unit: 'per_month' })), // an agreed plan rate
      v2(onePrice({ unit: 'unknown' })), // an agreed price with no unit
      v2({ prices: [price(), price({ amount_usd: 31, unit: 'per_month' })] }), // a one-time price and a plan rate
      v2({ quoted_price_usd: 250, price: null, prices: [] }), // a strict total with no unit
      v2(onePrice({ amount_max_usd: 300 })), // a range
      v2({ prices: [price(), price({ amount_usd: 99 })] }), // two agreed one-time prices
      v2(onePrice({ stated_by: 'caller' })), // the caller's own number, no strict total
      v2(onePrice({ amount_usd: 3 })), // under the booking's price bounds
      v2(onePrice({ amount_max_usd: 200 })), // a malformed range (high end under the low end) is not exact
      v2({ quoted_price_usd: 0 }), // a strict $0 total: the booking is free
      v2({ quoted_price_usd: 200 }), // a strict total that is not the accepted price
      v2({ prices: [price(), price({ amount_usd: 0, accepted: false })] }), // a second staff term: a waived fee
      v2({ prices: [price(), price({ amount_usd: 0 })] }), // the waived fee was accepted too
      v2({ prices: [price(), price({ amount_usd: null })] }), // a second accepted term with no number
      // The reading does not say the call was about a one-time job.
      ...['recurring_membership_inquiry', 'inspection_only', 'quote_only', 'follow_up_existing_service', 'complaint_or_callback', 'cancellation_request', null, undefined]
        .map((intent) => v2({ service_intent: intent })),
      // A plan on the call.
      v2({ billing_choice: 'per_application' }), // a plan billed per application, with a one-time start fee
      v2({ billing_choice: 'annual_prepay' }),
      v2({ primary_service_category: 'bundled_waveguard' }),
      v2({ waveguard_tier_mentioned: 'silver' }),
      v2(onePrice({ tier_mentioned: 'silver' })), // the price is a plan's
      v2(onePrice({ prepay_term: 'annual' })),
      v2({ prices: [price(), price({ amount_usd: 99, accepted: false, stated_by: 'caller', tier_mentioned: 'gold' })] }), // a tier on another entry
      // A second job, a second property, or a job the reading could not settle.
      v2({ secondary_categories: ['lawn'] }),
      v2({}, { property: { additional_properties: [{ label: 'rental' }] } }),
      v2({}, { triage_flags: ['multi_property_call'] }),
      v2({}, { triage_flags: ['no_sms_consent_captured', 'ambiguous_pest_or_service'] }),
    ];
    for (const extraction of noHold) {
      expect(agreed(extraction)).toBe(false);
      expect(booked(oneTime(), extraction)).toBe('Monthly Pest Control Service');
    }
    // Other flags and an absent property block do not stop the hold.
    expect(agreed(v2({}, { triage_flags: ['quote_promised'], property: null }))).toBe(true);
  });

  test('the hold needs a one-time catalog row that a call booking can price', () => {
    const without = SERVICES.filter((s) => s !== ONE_TIME_ROW);
    const noRow = [
      null, [], without, // no catalog, or no row with that name
      [...without, { ...ONE_TIME_ROW, billing_type: 'recurring' }], // a plan row never takes a visit price
    ];
    for (const services of noRow) {
      expect(agreed(v2(), services)).toBe(false);
      expect(booked(oneTime(), v2(), services)).toBe('Monthly Pest Control Service');
    }
    expect(callAgreedOneTimeJob(v2())).toBe(false); // a caller that hands over no catalog
    // A singular name the catalog does not sell (an older label) has no row to price.
    expect(agreed(v2({ specific_service_name: 'General Pest Control' }))).toBe(false);
  });

  test('the gate is off by default: no hold at any site', () => {
    delete process.env.GATE_CALL_AGREED_ONE_TIME_JOB;
    expect(agreed(v2())).toBe(false);
    expect(booked(oneTime(), v2())).toBe('Monthly Pest Control Service');
    const program = lead({ matched_service: 'Monthly Pest Control Service', specific_service_name: 'Monthly Pest Control Service' });
    expect(adoptAgreedOneTimeService(program, v2(), agreed(v2()))).toBe(program);
    // Strict opt-in: only the exact word turns it on.
    process.env.GATE_CALL_AGREED_ONE_TIME_JOB = '1';
    expect(agreed(v2())).toBe(false);
  });

  test('the hold never changes a view that already names a program', () => {
    const program = lead({ matched_service: 'Quarterly Pest Control Service', specific_service_name: 'Quarterly Pest Control Service' });
    expect(applyRecurringIntentDefault(program, 'Caller: I want the monthly plan.', [], true).specific_service_name)
      .toBe('Monthly Pest Control Service');
  });

  test('a mixed view: the singular field stays and the program field takes the caller\'s cadence', () => {
    const mixed = () => lead({ matched_service: 'Pest Control Service', specific_service_name: 'Quarterly Pest Control Service' });
    const t = 'Caller: I want the monthly plan.';
    // The specific label wins in booking, so the cadence the caller chose must reach it.
    expect(applyRecurringIntentDefault(mixed(), t, [], true))
      .toMatchObject({ matched_service: 'Pest Control Service', specific_service_name: 'Monthly Pest Control Service' });
    expect(applyRecurringIntentDefault(mixed(), t))
      .toMatchObject({ matched_service: 'Monthly Pest Control Service', specific_service_name: 'Monthly Pest Control Service' });
  });

  test('a caller with no recurring words is untouched either way', () => {
    const view = oneTime();
    expect(applyRecurringIntentDefault(view, 'Caller: Can someone spray for ants today?', [], true)).toBe(view);
  });

  test('the hold is part of V2-primary adoption: the kill switch turns it off at every site', () => {
    process.env.CALL_EXTRACTION_V2_PRIMARY = 'false';
    try {
      expect(agreed(v2())).toBe(false);
      expect(booked(oneTime(), v2())).toBe('Monthly Pest Control Service');
      const program = lead({ matched_service: 'Monthly Pest Control Service', specific_service_name: 'Monthly Pest Control Service' });
      expect(adoptAgreedOneTimeService(program, v2(), agreed(v2()))).toBe(program);
    } finally {
      delete process.env.CALL_EXTRACTION_V2_PRIMARY;
    }
  });

  // The booking asks this of its own view: a booking the hold changed is held for the office.
  describe('agreedJobHoldChangesService: whether the hold changed the view', () => {
    test('a singular service the caller\'s cadence word would turn into a program: changed', () => {
      expect(agreedJobHoldChangesService(oneTime(), TRANSCRIPT)).toBe(true);
      expect(agreedJobHoldChangesService(lead({ matched_service: 'Pest Control Service', specific_service_name: 'One-Time Pest Control Service' }), TRANSCRIPT)).toBe(true);
    });

    test('no cadence word, a view that already names a program, or no lead: unchanged', () => {
      expect(agreedJobHoldChangesService(oneTime(), 'Caller: Can someone spray for ants today?')).toBe(false);
      // The program field takes the caller's cadence with or without the hold.
      expect(agreedJobHoldChangesService(lead({ matched_service: 'Quarterly Pest Control Service', specific_service_name: 'Quarterly Pest Control Service' }), 'Caller: I want the monthly plan.')).toBe(false);
      expect(agreedJobHoldChangesService({ ...oneTime(), is_lead: false }, TRANSCRIPT)).toBe(false);
    });

    test('it changes nothing itself', () => {
      const view = oneTime();
      const before = { ...view };
      agreedJobHoldChangesService(view, TRANSCRIPT);
      expect(view).toEqual(before);
    });
  });

  describe('before adoption, an agreed one-time job never carries a program label', () => {
    const SERVICE = 'One-Time Pest Control Service';
    // `hold`: callAgreedOneTimeJob for the extraction.
    const adopt = (view, extraction, hold = agreed(extraction)) => adoptAgreedOneTimeService(view, extraction, hold);

    test('the first pass wrote the program: both labels take the service the extraction named, every other field stays', () => {
      const after = { ...applyRecurringIntentDefault(oneTime(), TRANSCRIPT), phone: '+19415550101' };
      expect(after).toMatchObject({ matched_service: 'Monthly Pest Control Service', specific_service_name: 'Monthly Pest Control Service' });
      expect(adopt(after, v2())).toEqual({ ...after, matched_service: SERVICE, specific_service_name: SERVICE });
    });

    test('the V1 model wrote the program itself: the same, field by field', () => {
      // Only the label that names a program changes; an empty label or another service stays.
      expect(adopt(lead({ matched_service: 'Quarterly Pest Control Service', specific_service_name: null }), v2()))
        .toMatchObject({ matched_service: SERVICE, specific_service_name: null });
      expect(adopt(lead({ matched_service: 'Monthly Pest Control Service', specific_service_name: 'Bee / Wasp Nest Removal Service' }), v2({ specific_service_name: 'Bee / Wasp Nest Removal Service' })))
        .toMatchObject({ matched_service: 'Bee / Wasp Nest Removal Service', specific_service_name: 'Bee / Wasp Nest Removal Service' });
    });

    test('nothing to change returns the same object', () => {
      const program = () => lead({ matched_service: 'Monthly Pest Control Service', specific_service_name: 'Monthly Pest Control Service' });
      // No program label on the view.
      const untouched = oneTime();
      expect(adopt(untouched, v2())).toBe(untouched);
      // No agreed one-time job: no extraction, an agreed plan rate, a program named by V2, a plan choice.
      for (const extraction of [null, v2(onePrice({ unit: 'per_month' })), v2({ specific_service_name: 'Quarterly Pest Control Service' }), v2({ billing_choice: 'per_application' })]) {
        const view = program();
        expect(adopt(view, extraction)).toBe(view);
      }
      // No hold: the labels stay. Only `true` is a hold.
      for (const hold of [false, undefined, null, 1]) {
        const view = program();
        expect(adoptAgreedOneTimeService(view, v2(), hold)).toBe(view);
      }
    });

    test('after it, no later pass of the rule moves the service', () => {
      const adopted = adopt(applyRecurringIntentDefault(oneTime(), TRANSCRIPT), v2());
      expect(applyRecurringIntentDefault(adopted, TRANSCRIPT, [], agreed(v2()))).toBe(adopted);
    });
  });

  // The processor is too large to run here; these pin where it asks for the hold and hands it to the rule.
  describe('processRecording wiring', () => {
    const src = fs.readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    const count = (text) => src.split(text).length - 1;

    test('the first pass and both commercial judges run the rule with no hold; the three later passes hand it the hold', () => {
      expect(count('applyRecurringIntentDefault(extracted, transcription, bookableServiceNames);')).toBe(1);
      // After adoption, and at the approved booking.
      expect(count('applyRecurringIntentDefault(extracted, transcription, bookableServiceNames, agreedJobAtAdoption);')).toBe(2);
      // The voicemail lead promotion: the hold only when adoption ran for this pass.
      expect(count('applyRecurringIntentDefault(extracted, transcription, bookableServiceNames, adoptedV2Extraction ? agreedJobAtAdoption : false);')).toBe(1);
      // The commercial judges read as before: they run before the customer is resolved.
      expect(count('views.map((view) => applyRecurringIntentDefault(view, transcription, serviceNames)).every(')).toBe(2);
      expect(count('applyRecurringIntentDefault(')).toBe(7); // the six calls and the definition
    });

    test('the hold is asked once, inbound, at adoption, of the reading alone', () => {
      expect(src).toContain("const agreedJobAtAdoption = !isOutboundCall(call) && v2Result?.status === 'valid'\n      && callAgreedOneTimeJob(v2Result.extraction, bookableCallServices);");
      expect(count('callAgreedOneTimeJob(')).toBe(2); // this call and the definition
      expect(count('agreedJobHoldChangesService(')).toBe(2); // the booking's call and the definition
    });

    test('the hold and the price bell of the call booking check read one rule for "one one-time job"', () => {
      expect(count("require('./call-one-time-job').readsAsOneOneTimeJob(v2Extraction)")).toBe(1);
      const check = fs.readFileSync(require.resolve('../services/call-booking-check'), 'utf8');
      expect(check).toContain("const { readsAsOneOneTimeJob, serviceNameKey: nameKey } = require('./call-one-time-job');");
      // The same name key too: the hold keeps a service only under the name the bell would tie a price to.
      expect(check).not.toContain('const nameKey = (name)');
      const catalog = fs.readFileSync(require.resolve('../services/call-booking-catalog'), 'utf8');
      expect(catalog).toContain('if (!row || serviceNameKey(row.name) !== serviceNameKey(serviceName)) return false;');
      expect(check).not.toContain('function readsAsOneOneTimeJob');
    });

    test('the canonical view is put right once: after the pre-adoption snapshot, before adoption reads or anything stores it', () => {
      const firstPass = src.indexOf('applyRecurringIntentDefault(extracted, transcription, bookableServiceNames);');
      const snapshot = src.indexOf('const preAdoptionExtracted = { ...extracted };');
      const put = '    if (agreedJobAtAdoption) {\n      const agreedService = adoptAgreedOneTimeService(extracted, v2Result.extraction, agreedJobAtAdoption);';
      const adoption = src.indexOf('adoptV2PrimaryFields(extracted, v2Result.extraction, {');
      expect(count(put)).toBe(1);
      expect(count('adoptAgreedOneTimeService(')).toBe(2); // this call and the definition
      // The pre-adoption view is V1's own: the checks that need both extractors to agree read it.
      expect(snapshot).toBeGreaterThan(firstPass);
      expect(src.indexOf(put)).toBeGreaterThan(snapshot);
      expect(adoption).toBeGreaterThan(src.indexOf(put));
      // The labels replaced here are recorded with the fields adoption replaces, for the offline audits.
      expect(src.slice(src.indexOf(put), adoption))
        .toContain("agreedServiceFields = ['matched_service', 'specific_service_name'].filter((key) => agreedService[key] !== extracted[key]);");
      expect(count('serviceFieldsAdopted = [...new Set([...adoption.adoptedFields, ...agreedServiceFields])];')).toBe(1);
      // Nothing stores the V1 view between the first pass and adoption.
      expect(src.slice(firstPass, adoption)).not.toContain('ai_extraction: JSON.stringify(extracted)');
    });
  });
});

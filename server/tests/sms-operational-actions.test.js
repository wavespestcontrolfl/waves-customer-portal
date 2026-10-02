'use strict';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../utils/pan-scrub', () => {
  const actual = jest.requireActual('../utils/pan-scrub');
  return { ...actual, scrubPans: jest.fn(actual.scrubPans) };
});
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn((name, work) => work()) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));

const { groundExtraction, extractSmsOperations, buildPrompt, stringifySmsEvidence, statesClock } = require('../services/sms-operational-extractor');
const { eligibleMessage, factVerdict, runSmsOperationalActions, resolveDueDeadline, DEFAULT_DEADLINE_HOURS, PROMISE_DEFAULT_DEADLINE_HOURS } = require('../services/sms-operational-actions');
const { groundFulfillment, admissibleWitness, verifySmsFulfillment, fulfillmentFingerprint } = require('../services/sms-commitment-fulfillment');
const { dispatchWithFallback } = require('../services/llm/call');
const numbers = require('../config/twilio-numbers');
const { parseETDateTime } = require('../utils/datetime-et');
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000101';
const PROPERTY_ID = '00000000-0000-4000-8000-000000000102';
const properties = [{ id: PROPERTY_ID }];
const source = (message_body, direction = 'inbound') => ({
  id: '00000000-0000-4000-8000-000000000103', customer_id: CUSTOMER_ID, message_body, direction,
  created_at: '2040-03-10T15:00:00Z', from_phone: '+12025550101', to_phone: numbers.locations.parrish.number,
});
const obligation = (quote, extra = {}) => ({
  party: 'waves', kind: 'send_estimate', description: quote, quote,
  basis: 'request', property_id: PROPERTY_ID, due_text: null, due_at: null, due_date: null, promise_firm: false, answered_by_payment: false, ...extra,
});
const fact = (extra = {}) => ({ field: 'irrigation_controller_location', value: 'The controller is on the side of the house',
  quote: 'The controller is on the side of the house', property_id: PROPERTY_ID, duration: 'durable', ...extra });
const extracted = (obligations = [], facts = []) => ({ obligations, facts, additional_properties: [] });

describe('SMS operational evidence and ownership', () => {
  test('keeps an inbound request before staff promises anything', () => {
    const message = source('Please send the lawn estimate');
    const result = groundExtraction(extracted([obligation(message.message_body)]), { message, properties });
    expect(result.obligations).toHaveLength(1);
    expect(result.obligations[0]).toMatchObject({ party: 'waves', basis: 'request', due_at: null });
  });

  test.each([
    'Please send the estimate only if I approve the price.',
    'Please call when the gate is repaired.',
    'Schedule a visit after I return.',
    'Please send the report once I confirm the recipient.',
  ])('conditional work becomes an exception: %s', (body) => {
    const message = source(body);
    const result = groundExtraction(extracted([obligation(body, { description: body.split(/ only | when | after | once /)[0] })]),
      { message, properties });
    expect(result).toMatchObject({ obligations: [], dropped: 1 });
  });

  test.each(["can't", 'cannot', "won't", "shouldn't", 'unable to', 'can’t', 'won’t'])('negated %s action requires review', (negation) => {
    const message = source(`I ${negation} schedule a visit`);
    const result = groundExtraction(extracted([obligation(message.message_body, {
      kind: 'schedule_visit', description: 'schedule a visit',
    })]), { message, properties });
    expect(result).toMatchObject({ obligations: [], dropped: 1 });
  });

  test('customer promises stay customer-owned, with no staff callback invented', () => {
    const message = source("I'll send photos tomorrow");
    const result = groundExtraction(extracted([
      obligation(message.message_body, { party: 'customer', kind: 'send_photos', basis: 'promise' }),
      obligation(message.message_body, { kind: 'callback', basis: 'promise' }),
    ]), { message, properties });
    expect(result.obligations).toHaveLength(1);
    expect(result.obligations[0].party).toBe('customer');
  });

  test('outbound staff promise is tracked; outgoing profile guesses are not facts', () => {
    const message = source("I'll send the estimate. The controller is on the side of the house", 'outbound');
    const result = groundExtraction(extracted([
      obligation("I'll send the estimate", { basis: 'promise', promise_firm: true }),
    ], [fact()]), { message, properties });
    expect(result.obligations).toHaveLength(1);
    expect(result.facts).toEqual([]);
  });

  test('a subjectless "Will …" staff declaration is a promise, not a question', () => {
    const message = source('Will call you tomorrow at 9am', 'outbound');
    const result = groundExtraction(extracted([obligation('call you tomorrow at 9am', {
      basis: 'promise', promise_firm: true, kind: 'callback', due_text: 'tomorrow at 9am', due_at: '2040-03-11T09:00:00-04:00',
    })]), { message, properties });
    expect(result.obligations).toHaveLength(1);
    expect(result.obligations[0]).toMatchObject({ due_at: '2040-03-11T13:00:00.000Z', timing_unverified: false });
  });

  test.each(['Should I call you tomorrow at 9am?', 'Should I call you tomorrow at 9am', 'Want me to call you tomorrow at 9am',
    'Need us to call you tomorrow at 9am', 'Will we call you tomorrow at 9am'])('an outbound question the extraction marks as no firm promise is not recorded: %s', (body) => {
    // Staff-promise plan (2026-09-28): the extraction judges a staff text's
    // firmness (promise_firm); a question or offer is never a firm promise.
    const message = source(body, 'outbound');
    const result = groundExtraction(extracted([obligation('call you tomorrow at 9am', {
      basis: 'promise', promise_firm: false, kind: 'callback', due_text: 'tomorrow at 9am', due_at: '2040-03-11T09:00:00-04:00',
    })]), { message, properties });
    expect(result).toMatchObject({ obligations: [], dropped: 1 });
  });

  test('an inbound question still creates a customer request for staff', () => {
    const message = source('Could you call me tomorrow at 9am?');
    const result = groundExtraction(extracted([obligation(message.message_body, {
      kind: 'callback', due_text: 'tomorrow at 9am', due_at: '2040-03-11T09:00:00-04:00',
    })]), { message, properties });
    expect(result.obligations).toHaveLength(1);
    expect(result.obligations[0]).toMatchObject({ party: 'waves', basis: 'request', due_at: '2040-03-11T13:00:00.000Z' });
  });

  test.each(['Please send the estimate for 100 Example Lane', 'Please send estimates for all properties'])(
    'multiple-property requests remain visible without accepting a guessed property: %s', (body) => {
      const multiple = [...properties, { id: '00000000-0000-4000-8000-000000000104' }];
      const result = groundExtraction(extracted([obligation(body)]), { message: source(body), properties: multiple });
      expect(result.obligations).toHaveLength(1);
      expect(result.obligations[0]).toMatchObject({ property_id: null, quote: body });
      expect(admissibleWitness({ ...result.obligations[0], sms_context: { property_id: null } },
        { type: 'estimate', property_id: PROPERTY_ID, status: 'sent', sent_at: '2040-03-11T14:00:00Z' })).toBe(false);
    },
  );

  test('drops hallucinated evidence and foreign property ids', () => {
    const message = source('Please send the lawn estimate');
    const result = groundExtraction(extracted([
      obligation('Schedule tomorrow at ten'),
      obligation(message.message_body, { property_id: 'not-a-property-on-this-account' }),
    ]), { message, properties });
    expect(result.obligations).toEqual([]);
    expect(result.dropped).toBe(2);
  });

  test('does not repeat an older promise just because it appears in history', () => {
    const message = source('Thanks');
    const result = groundExtraction(extracted([obligation("I'll send the estimate", { basis: 'promise' })]), {
      message, properties, history: [source("I'll send the estimate", 'outbound')],
    });
    expect(result.obligations).toEqual([]);
  });

  test('keeps two distinct deliverables from a single message', () => {
    const message = source('Please send the report to the realtor and send me a payment link');
    const result = groundExtraction(extracted([
      obligation('send the report to the realtor', { kind: 'send_report', description: 'Send the report to the realtor' }),
      obligation('send me a payment link', { kind: 'other', description: 'send me a payment link' }),
    ]), { message, properties });
    expect(result.obligations).toHaveLength(2);
  });

  test('a staff promise to send the reschedule link is grounded', () => {
    // KIND_EVIDENCE had no entry for send_reschedule_link at all: adding the
    // kind to the shared COMMITMENT_KINDS enum exposed it to this extractor's
    // schema without ever telling its grounding filter how to recognize one,
    // so `undefined?.test(...)` silently dropped every SMS obligation the
    // model classified with the new kind (codex #4293 P1, sms-operational-extractor).
    const quote = "I'll send the reschedule link shortly";
    const message = source(quote, 'outbound');
    const result = groundExtraction(extracted([obligation(quote, {
      kind: 'send_reschedule_link', basis: 'promise', promise_firm: true, description: quote,
    })]), { message, properties });
    expect(result.obligations).toHaveLength(1);
    expect(result.obligations[0]).toMatchObject({ kind: 'send_reschedule_link', basis: 'promise' });
  });

  test('a bare "link" or a bare "reschedule" alone does not ground the reschedule-link kind', () => {
    // Neither half alone establishes the specific deliverable — "reschedule"
    // could just mean the visit already moved, and "link" is too generic on
    // its own (mirrors why every other kind here needs its own typed noun).
    const bareLink = "I'll text you a link";
    const linkMessage = source(bareLink, 'outbound');
    expect(groundExtraction(extracted([obligation(bareLink, {
      kind: 'send_reschedule_link', basis: 'promise', description: bareLink,
    })]), { message: linkMessage, properties }).obligations).toEqual([]);

    const bareReschedule = "I'll reschedule that for you";
    const rescheduleMessage = source(bareReschedule, 'outbound');
    expect(groundExtraction(extracted([obligation(bareReschedule, {
      kind: 'send_reschedule_link', basis: 'promise', description: bareReschedule,
    })]), { message: rescheduleMessage, properties }).obligations).toEqual([]);
  });

  test('ungrounded due wording cannot establish a deadline', () => {
    const message = source('Please send the report');
    const result = groundExtraction(extracted([obligation(message.message_body, {
      kind: 'send_report', due_text: 'tomorrow at 9am', due_at: '2040-03-11T09:00:00-04:00',
    })]), { message, properties });
    expect(result.obligations[0]).toMatchObject({ due_text: null, due_at: null });
  });

  test('tomorrow without a clock time does not acquire a model-invented time', () => {
    const message = source("I'll call tomorrow", 'outbound');
    const result = groundExtraction(extracted([obligation(message.message_body, {
      basis: 'promise', promise_firm: true, kind: 'callback', due_text: 'tomorrow', due_at: '2040-03-11T09:00:00-04:00',
    })]), { message, properties });
    expect(result.obligations[0]).toMatchObject({ due_text: 'tomorrow', due_at: null });
  });

  test.each(['9am', '09:00', 'noon', 'midnight'])('omitted timing fields still flag source clock %s for review', (clock) => {
    const message = source(`Please call tomorrow at ${clock}`);
    const result = groundExtraction(extracted([obligation(message.message_body, { kind: 'callback' })]), { message, properties });
    expect(result.obligations[0]).toMatchObject({ due_at: null, timing_unverified: true });
    expect(result.dropped).toBe(1);
  });

  test.each(["9 o'clock", '9 o’clock', "nine o'clock", '9', 'nine', '3p', '9a', '9A'])("unsupported clock %s requires review without inventing AM/PM", (clock) => {
    const message = source(`Please call tomorrow at ${clock}`);
    for (const due_text of [null, `tomorrow at ${clock}`]) {
      const result = groundExtraction(extracted([obligation(message.message_body, {
        kind: 'callback', due_text,
      })]), { message, properties });
      expect(result.obligations[0]).toMatchObject({ due_at: null, timing_unverified: true });
      expect(result.dropped).toBe(1);
    }
  });

  test.each([['noon', '16:00:00.000Z'], ['midnight', '05:00:00.000Z']])(
    'a grounded named clock resolves without an invented reminder hour: %s', (clock, utcTime) => {
      const message = source(`Please call tomorrow at ${clock}`);
      const result = groundExtraction(extracted([obligation(message.message_body, {
        kind: 'callback', due_text: `tomorrow at ${clock}`,
      })]), { message, properties });
      expect(result.obligations[0]).toMatchObject({ due_at: `2040-03-11T${utcTime}`, timing_unverified: false });
      expect(result.dropped).toBe(0);
    },
  );

  test('a shortened quote or invalid model timestamp cannot hide explicit timing', () => {
    const message = source('Please call tomorrow at 9am');
    for (const item of [obligation('Please call', { kind: 'callback' }),
      obligation(message.message_body, { kind: 'callback', due_text: 'tomorrow at 9am', due_at: 'invalid' })]) {
      const result = groundExtraction(extracted([item]), { message, properties });
      expect(result.obligations[0]).toMatchObject({ due_at: null, timing_unverified: true });
      expect(result.dropped).toBe(1);
    }
  });

  test('profile-only capture ignores proposed obligations and their exceptions', () => {
    const message = source('Please call tomorrow at 9am');
    expect(groundExtraction(extracted([obligation(message.message_body, { kind: 'callback' })]), {
      message, properties, captureCommitments: false,
    })).toMatchObject({ obligations: [], dropped: 0 });
  });

  test.each([
    ['Lockbox code is #1234?', 'Lockbox code is #1234', 'lockbox_code', '#1234'],
    ['Text only please?', 'Text only please', 'contact_preference', 'text'],
    ['Keep the pets inside?', 'Keep the pets inside?', 'pet_details', 'Keep the pets inside?'],
  ])('questions cannot become durable facts: %s', (body, quote, field, value) => {
    expect(groundExtraction(extracted([], [fact({ quote, field, value })]), {
      message: source(body), properties,
    })).toMatchObject({ facts: [], dropped: 1 });
  });

  test.each([
    'Are the dogs kept inside', 'Are the dogs kept inside？',
    'The dogs stay inside. However, could they escape',
    'Where is the irrigation controller', 'Do we leave the gate open',
    'The controller is outside\nIs it beside the garage',
    'May we park in the driveway', 'Please can we park in the driveway',
    'Ok to park in the driveway', 'Mind if we park in the driveway',
    'I was wondering if you could leave the side gate open', 'Just wondering if we can park in the driveway',
    'We wanted to ask whether the dogs can stay out', 'Any chance you could use the side door',
    'Just checking if you can leave the side gate open', 'Wanted to see if you could use the side door',
    'Curious whether the gate can stay open', 'Trying to find out when you arrive',
  ])('unpunctuated and Unicode questions require review: %s', (quote) => {
    expect(groundExtraction(extracted([], [fact({ field: 'pet_details', quote, value: quote })]), {
      message: source(quote), properties,
    })).toEqual({ obligations: [], facts: [], additional_properties: [], dropped: 1 });
  });

  test.each([
    'I was wondering if you could leave the side gate open',
    'I wonder if you could leave the side gate open',
    'I wanted to ask whether you could leave the side gate open',
    'We were just wondering whether the gate should stay open',
    'I am asking if you can park in the driveway',
    'I would like to know if the gate can stay open',
    'Please confirm whether we should leave the gate open',
    'The side gate is unlocked. I wanted to ask how you enter',
    'The controller is outside; wondering where we should leave the key',
  ])('indirect questions cannot become durable access instructions: %s', (quote) => {
    expect(groundExtraction(extracted([], [fact({ field: 'access_notes', quote, value: quote })]), {
      message: source(quote), properties,
    })).toEqual({ obligations: [], facts: [], additional_properties: [], dropped: 1 });
  });

  test.each([
    'Leave the side gate closed.',
    'Please ask before entering the yard.',
    'The controller is beside the garage.',
  ])('explicit instructions and reported facts remain grounded: %s', (quote) => {
    const item = fact({ field: 'access_notes', quote, value: quote });
    expect(groundExtraction(extracted([], [item]), { message: source(quote), properties }))
      .toEqual({ obligations: [], facts: [item], additional_properties: [], dropped: 0 });
  });

  test.each(['unknown', 'none', 'not known', 'not available', 'unsure', 'N A', 'same as last time', 'the usual',
    'on the fridge'])('missing or relational access code remains empty: %s', (value) => {
    const quote = `Lockbox code is ${value}`;
    const item = fact({ field: 'lockbox_code', quote, value });
    expect(groundExtraction(extracted([], [item]), { message: source(quote), properties }))
      .toEqual({ obligations: [], facts: [], additional_properties: [], dropped: 1 });
    expect(factVerdict(item, { properties, senderIsPrimary: true })).toBe('code_uncertain');
  });

  test('overlong sources create review exceptions without a provider call', async () => {
    dispatchWithFallback.mockClear();
    expect(await extractSmsOperations({ message: source('Keep the pets inside. '.repeat(30)), properties }))
      .toMatchObject({ facts: [], dropped: 1 });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('a single alphabetic token is still a code', () => {
    const message = source('Lockbox code is ABCD');
    expect(groundExtraction(extracted([], [fact({ field: 'lockbox_code', quote: message.message_body, value: 'ABCD' })]),
      { message, properties }).facts.map((f) => f.value)).toEqual(['ABCD']);
  });

  test('preserves access-code symbols and case exactly as supplied', () => {
    const message = source('Lockbox code is #aB12*');
    const result = groundExtraction(extracted([], [
      fact({ field: 'lockbox_code', quote: message.message_body, value: '#aB12*' }),
      fact({ field: 'lockbox_code', quote: message.message_body, value: '#AB12*' }),
    ]), { message, properties });
    expect(result.facts.map((f) => f.value)).toEqual(['#aB12*']);
  });

  test.each([
    ['Garage code is #1234', 'garage_code'], ['Lockbox code: #1234', 'lockbox_code'],
    ['Our property gate code is #1234', 'property_gate_code'],
    ['The community gate code is #1234', 'neighborhood_gate_code'],
    ['Gate code is #1234', null], ['Code is #1234', null],
  ])('binds %s only to its explicit access field', (quote, field) => {
    const facts = ['garage_code', 'lockbox_code', 'property_gate_code', 'neighborhood_gate_code']
      .map((candidate) => fact({ field: candidate, quote, value: '#1234' }));
    const result = groundExtraction(extracted([], facts), { message: source(quote), properties });
    expect(result.facts.map((item) => item.field)).toEqual(field ? [field] : []);
    for (const item of facts) expect(factVerdict(item, { properties, senderIsPrimary: true }))
      .toBe(item.field === field ? 'apply' : 'code_uncertain');
  });

  test('a code quote cannot drop a preceding negation', () => {
    const result = groundExtraction(extracted([], [fact({ field: 'garage_code',
      quote: 'Garage code is #1234', value: '#1234' })]), {
      message: source('Do not assume Garage code is #1234'), properties,
    });
    expect(result.facts).toEqual([]);
  });

  test('generic report wording cannot create invented report subtypes or a callback', () => {
    const message = source('Please send the report');
    const result = groundExtraction(extracted([
      obligation(message.message_body, { kind: 'send_report', description: 'the inspection report' }),
      obligation(message.message_body, { kind: 'send_report', description: 'the treatment report' }),
      obligation(message.message_body, { kind: 'callback' }),
      obligation(message.message_body, { kind: 'send_paperwork' }),
      obligation(message.message_body, { kind: 'send_report', description: 'send the report' }),
    ]), { message, properties });
    expect(result.obligations.map((item) => [item.kind, item.description])).toEqual([['send_report', 'send the report']]);
    expect(result.dropped).toBe(4);
  });

  test('two explicitly named reports retain their separate grounded descriptions', () => {
    const message = source('Please send the inspection report and the treatment report');
    const result = groundExtraction(extracted([
      obligation(message.message_body, { kind: 'send_report', description: 'the inspection report' }),
      obligation(message.message_body, { kind: 'send_report', description: 'the treatment report' }),
    ]), { message, properties });
    expect(result.obligations).toHaveLength(2);
    expect(result.dropped).toBe(0);
  });

  test.each([['Text only please', 'text'], ['I prefer a call.', 'call'], ['Email only', 'email']])(
    'binds %s to its expressed channel', (quote, value) => {
      const facts = ['call', 'text', 'email'].map((channel) => fact({
        field: 'contact_preference', quote, value: channel,
      }));
      const result = groundExtraction(extracted([], facts), { message: source(quote), properties });
      expect(result.facts.map((item) => item.value)).toEqual([value]);
      expect(result.dropped).toBe(2);
    },
  );

  test('a preference quote cannot drop a preceding negation', () => {
    const result = groundExtraction(extracted([], [fact({ field: 'contact_preference',
      quote: 'only text', value: 'text' })]), { message: source('Do not only text'), properties });
    expect(result.facts).toEqual([]);
  });

  test.each([['Please send the estimate by September 10 at 3', 'send_estimate'], ['Please call before 5 tomorrow', 'callback'],
    ['Please call before five tomorrow', 'callback'], ['Please call at nine', 'callback'], ['Please call around ten or eleven', 'callback']])(
    'a bare hour after a clock preposition is stated timing that needs review: %s', (body, kind) => {
      const message = source(body);
      const result = groundExtraction(extracted([obligation(message.message_body, { kind })]), { message, properties });
      expect(result.obligations[0]).toMatchObject({ due_at: null, timing_unverified: true });
      expect(result.dropped).toBe(1);
    });

  test.each(['Please call tomorrow at 9am or 10am', 'Please call tomorrow 9-10am', 'Please call tomorrow between 9am and 11am',
    'Please call tomorrow at 9am-ish', 'Please call tomorrow at 9am or later', 'Please call tomorrow at 9am, I think',
    'Please call tomorrow at 9am probably', 'Please call tomorrow at 9am give or take'])(
    'ambiguous source timing cannot become a firm deadline from a shortened due_text: %s', (body) => {
      const message = source(body);
      const result = groundExtraction(extracted([obligation(message.message_body, {
        kind: 'callback', due_text: 'tomorrow at 9am', due_at: '2040-03-11T09:00:00-04:00',
      })]), { message, properties });
      expect(result.obligations[0]).toMatchObject({ due_at: null, timing_unverified: true });
      expect(result.dropped).toBe(1);
    });

  test.each(['Please finish this and call tomorrow at 9am', 'Please call me on 2040-03-11 at 9am', 'Please call me in Parrish tomorrow at 9am'])(
    'hedge and range detection is anchored to clock tokens, not words or calendar dates: %s', (body) => {
      const message = source(body);
      const result = groundExtraction(extracted([obligation(message.message_body, {
        kind: 'callback', due_text: body.includes('2040') ? '2040-03-11 at 9am' : 'tomorrow at 9am', due_at: '2040-03-11T09:00:00-04:00',
      })]), { message, properties });
      expect(result.obligations[0]).toMatchObject({ due_at: '2040-03-11T13:00:00.000Z', timing_unverified: false });
      expect(result.dropped).toBe(0);
    });

  test.each([['Please call me at 941-555-0100', 'callback'], ['Please send 2 estimates', 'send_estimate'], ['Please send 2 a month of the estimates', 'send_estimate'],
    ['Please call me at one of these numbers', 'callback'], ['Please call me at 3 different numbers', 'callback'],
    ['Please send the estimate to me at 2 addresses', 'send_estimate']])(
    'a number that is not a clock hour stays undated without review: %s', (body, kind) => {
      const message = source(body);
      const result = groundExtraction(extracted([obligation(message.message_body, { kind })]), { message, properties });
      expect(result.obligations[0]).toMatchObject({ due_at: null, timing_unverified: false });
      expect(result.dropped).toBe(0);
    });

  test.each([
    ['2040-09-10T15:00:00-04:00', '2040-09-10T19:00:00.000Z', false],
    ['2040-09-11T15:00:00-04:00', null, true],
    ['2040-09-10T15:00:00Z', null, true],
    ['2040-09-10T15:00:00-05:00', null, true],
  ])('checks model deadline %s against the quoted ET day and time', (proposed, expected, unverified) => {
    const message = source('Please send the estimate by September 10 at 3 PM');
    const result = groundExtraction(extracted([obligation(message.message_body, {
      due_text: 'by September 10 at 3 PM', due_at: proposed,
    })]), { message, properties });
    expect(result.obligations[0]).toMatchObject({ due_at: expected, timing_unverified: unverified });
    expect(result.dropped).toBe(Number(unverified));
  });

  test.each(['The controller is not in the garage.', 'The controller is in the garage only until tomorrow.'])(
    'controller locations preserve the complete instruction: %s', (body) => {
      const result = groundExtraction(extracted([], [
        fact({ quote: 'garage', value: 'garage' }),
        fact({ quote: body, value: 'garage' }),
        fact({ quote: body, value: body }),
      ]), { message: source(body), properties });
      expect(result.facts.map((item) => item.value)).toEqual([body]);
      expect(result.dropped).toBe(2);
    },
  );

  test.each(["Don't forget to", 'Don’t forget to', 'Please do not forget to'])(
    'captures affirmative reminders: %s', (opening) => {
      const body = `${opening} call me tomorrow at 9am`;
      const result = groundExtraction(extracted([obligation(body, {
        kind: 'callback', description: 'call me', due_text: 'tomorrow at 9am',
      })]), { message: source(body), properties });
      expect(result.obligations).toHaveLength(1);
      expect(result.obligations[0]).toMatchObject({ due_at: '2040-03-11T13:00:00.000Z', timing_unverified: false });
      expect(result.dropped).toBe(0);
    },
  );

  test.each(["Please don't call me tomorrow at 9am", 'Do not call me tomorrow at 9am',
    "Don't forget to not call me", "Don't forget to call me only after I confirm",
    "I didn't say don't forget to call me",
    'Never call me', 'Please text instead of call me', 'Call me, but only after I confirm'])(
    'negated or conditional scope needs review: %s', (body) => {
      const result = groundExtraction(extracted([obligation(body, { kind: 'callback', description: 'call me' })]), {
        message: source(body), properties,
      });
      expect(result.obligations).toEqual([]);
      expect(result.dropped).toBe(1);
    },
  );

  test('prompts scrub current, historical, and split payment readbacks before serialization', () => {
    const prompt = buildPrompt({ message: source('CVV is 123. Please send the estimate'),
      history: [source('My card is 4242 4242'), source('4242 4242')] });
    expect(prompt).not.toContain('4242 4242');
    expect(prompt).not.toContain('CVV is 123');
    expect(prompt).toContain('[card ending 4242]');
    expect(prompt).toContain('[code removed]');
    expect(prompt).toContain('Please send the estimate');
  });

  test('a split readback spanning the current SMS becomes an explicit review exception', async () => {
    dispatchWithFallback.mockClear();
    const result = await extractSmsOperations({
      history: [source('My card is 4242 4242')],
      message: source('4242 4242. The controller is beside the garage.'), properties,
    });
    expect(result).toMatchObject({ facts: [], dropped: 1 });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('raw payment data echoed by the model cannot become operational facts', () => {
    const quote = 'The code is 4242424242424242';
    expect(() => groundExtraction(extracted([], [fact({ field: 'access_notes', quote, value: quote })]), {
      message: source(quote), properties,
    })).toThrow('sensitive_output');
  });

  test('an unavailable scrubber stops extraction before any provider call', async () => {
    dispatchWithFallback.mockClear();
    require('../utils/pan-scrub').scrubPans.mockImplementationOnce(() => { throw new Error('scrubber unavailable'); });
    await expect(extractSmsOperations({ message: source('Please send the estimate'), properties })).rejects.toThrow('scrubber unavailable');
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('notes cannot omit a negation or a condition from the source sentence', () => {
    const message = source('Do not treat the barn. Treat the yard only when the pets are inside.');
    const result = groundExtraction(extracted([], [
      fact({ field: 'special_instructions', quote: 'treat the barn', value: 'treat the barn' }),
      fact({ field: 'special_instructions', quote: 'Treat the yard', value: 'Treat the yard' }),
      fact({ field: 'special_instructions', quote: 'Do not treat the barn', value: 'Do not treat the barn' }),
    ]), { message, properties });
    expect(result.facts).toEqual([]);
    expect(result.dropped).toBe(3);
  });

  test.each([';', '\n'])(
    'a quote cannot drop a condition or negation across a continuation boundary: %s', (separator) => {
      const quote = `Treat the yard${separator}`;
      const body = `${quote} only when the pets are inside.`;
      const result = groundExtraction(extracted([], [
        fact({ field: 'special_instructions', quote, value: quote }),
        fact({ field: 'special_instructions', quote: body, value: body }),
      ]), { message: source(body), properties });
      expect(result.facts.map((item) => item.value)).toEqual([body]);
      expect(result.dropped).toBe(1);
      const negated = `Do not${separator} treat the yard.`;
      const tail = 'treat the yard.';
      expect(groundExtraction(extracted([], [fact({ field: 'special_instructions', quote: tail, value: tail })]), {
        message: source(negated), properties,
      }).facts).toEqual([]);
    },
  );

  test.each(['Only when the pets are inside.', 'Unless the gate is locked.', 'But avoid the barn.',
    'And only when the pets are inside.', 'However, only when the pets are inside.',
    'Also, please make sure the pets are inside first.'])(
    'a full stop cannot hide the following qualifier: %s', (condition) => {
      const quote = 'Treat the yard.';
      const body = `${quote} ${condition}`;
      const result = groundExtraction(extracted([], [
        fact({ field: 'special_instructions', quote, value: quote }),
        fact({ field: 'special_instructions', quote: body, value: body }),
      ]), { message: source(body), properties });
      expect(result.facts.map((item) => item.value)).toEqual([body]);
    },
  );

  test('a multi-sentence fact retains every statement in the current message', () => {
    const message = source('Do not treat the barn. The dog stays inside.');
    const note = message.message_body;
    const result = groundExtraction(extracted([], [
      fact({ field: 'special_instructions', quote: note, value: note }),
    ]), { message, properties });
    expect(result.facts.map((f) => f.value)).toEqual([note]);
    expect(result.dropped).toBe(0);
  });

  test('a shortened code or contact preference cannot discard a later condition', () => {
    for (const [field, value, quote] of [
      ['garage_code', '#1234', 'Garage code is #1234.'],
      ['contact_preference', 'text', 'Text only please.'],
    ]) {
      const body = `${quote} And only when I ask first.`;
      const result = groundExtraction(extracted([], [fact({ field, value, quote })]), {
        message: source(body), properties,
      });
      expect(result).toMatchObject({ facts: [], dropped: 1 });
    }
  });

  test('unknown fields fail schema validation and provider failures are retryable', async () => {
    expect(() => groundExtraction(extracted([], [fact({ field: 'payment_method' })]), {
      message: source(fact().quote), properties,
    })).toThrow('invalid_schema');
    dispatchWithFallback.mockResolvedValueOnce({ ok: false, reason: 'timeout' });
    await expect(extractSmsOperations({ message: source('Please send the estimate'), properties }))
      .rejects.toThrow('provider_failed');
  });

  test('outbound statements cannot fill a customer profile', () => {
    const message = source(fact().quote, 'outbound');
    expect(groundExtraction(extracted([], [fact()]), { message, properties }).facts).toEqual([]);
  });

  test.each(['unknown', 'none', 'not known', 'not available', 'unsure', 'N A', 'same as last time', 'the usual',
    'on the fridge', '1234 or 5678', '1234 I think', '1234 probably', '1234 for the side gate', '#', '*', '-',
    '#-*', 'broken', 'disabled', 'reset', 'expired'])('missing, relational or ambiguous access code remains empty: %s', (value) => {
    const quote = `Lockbox code is ${value}`;
    const item = fact({ field: 'lockbox_code', quote, value });
    expect(groundExtraction(extracted([], [item]), { message: source(quote), properties }))
      .toEqual({ obligations: [], facts: [], additional_properties: [], dropped: 1 });
    expect(factVerdict(item, { properties, senderIsPrimary: true })).toBe('code_uncertain');
  });

  test.each(['ABCD', '1234 5678', '12-34', '#1234 then press 5', '*9'])('a bounded credential is still a code: %s', (value) => {
    const message = source(`Lockbox code is ${value}`);
    expect(groundExtraction(extracted([], [fact({ field: 'lockbox_code', quote: message.message_body, value })]),
      { message, properties }).facts.map((f) => f.value)).toEqual([value]);
  });

  test('the prompt carries text, direction, time and opaque property ids only', () => {
    const prompt = buildPrompt({ message: source('The controller is beside the garage.'), history: [source('Hi there', 'outbound')],
      properties: [{ id: PROPERTY_ID, address_line1: '100 Example Lane', city: 'Sarasota', zip: '34236' }] });
    expect(prompt).toContain(PROPERTY_ID);
    expect(prompt).toContain('"direction":"outbound"');
    for (const leak of [CUSTOMER_ID, '+12025550101', numbers.locations.parrish.number, '100 Example Lane', 'Sarasota', '34236', '"id":"00000000-0000-4000-8000-000000000103"']) {
      expect(prompt).not.toContain(leak);
    }
  });
});

describe('profile safeguards independent of model labels', () => {
  test.each([
    'For tomorrow only, leave the side gate open.',
    'The controller is in the garage until Monday.',
    'Temporarily use the side entrance.',
    'For this visit please park outside.',
    'While on vacation, leave the package outside.',
    "While we're away, leave the side gate unlocked.",
    'We’re out of town until the 12th.',
    'Leave the gate open on March 12.',
    'On 3/12 the gate will be open.',
    'Back on Friday, keep the dog inside till then.',
    'Please park on the street this weekend.',
    'For the next two weeks use the side entrance.',
    'We will be back in a couple of weeks.',
    'Gate is broken right now, use the front door.',
    'Use the side door during our renovation.',
    'Leave the package by the pool through Sept 3rd.',
    'For our upcoming service, park on the street.',
    'Before your visit, please close the gate.',
  ])('holds a durable-labelled temporary instruction: %s', (quote) => {
    expect(factVerdict(fact({ field: 'access_notes', quote, value: quote }), {
      properties, senderIsPrimary: true,
    })).toBe('temporary_instruction');
  });

  test.each([
    'Come through the side gate and use the 2nd door on the left.',
    'The controller is in the sun room beside the garage.',
    'Keep the dog away from the pool.',
    'Two friendly dogs in the yard, gate on the right.',
    'Park on the street, our driveway is too narrow for the truck.',
    'Text me when you are on the way.',
  ])('applies a durable instruction without a time window: %s', (quote) => {
    expect(factVerdict(fact({ field: 'access_notes', quote, value: quote }), {
      properties, senderIsPrimary: true, messageBody: quote,
    })).toBe('apply');
  });

  test('retains qualifiers from another sentence in the current SMS', () => {
    expect(factVerdict(fact(), { properties, senderIsPrimary: true,
      messageBody: `For tomorrow only. ${fact().quote}.`,
    })).toBe('temporary_instruction');
  });

  test('uses the central cross-provider policy with a budget reserved for fallback', async () => {
    dispatchWithFallback.mockReset().mockResolvedValue({ ok: true, json: extracted([], []) });
    await extractSmsOperations({ message: source('The controller is outside.'), properties });
    expect(dispatchWithFallback.mock.calls[0][0]).toBe(require('../config/models').TEXT_POLICIES.highStakes);
    expect(dispatchWithFallback.mock.calls[0][1]).not.toHaveProperty('timeoutMs');
  });
});

describe('private profile writes', () => {
  const context = { properties, current: {}, senderIsPrimary: true };

  test('allows a clear empty-field update but preserves conflicts and temporary instructions', () => {
    expect(factVerdict(fact(), context)).toBe('apply');
    expect(factVerdict(fact(), { ...context, current: { irrigation_controller_location: 'garage' } }))
      .toBe('existing_value_conflict');
    expect(factVerdict(fact({ duration: 'visit_only' }), context)).toBe('temporary_instruction');
  });

  test('never guesses a property or a service contact’s authority', () => {
    expect(factVerdict(fact(), { ...context, properties: [...properties, { id: 'second' }] })).toBe('property_ambiguous');
    expect(factVerdict(fact({ property_id: null }), context)).toBe('property_ambiguous');
    expect(factVerdict(fact(), { ...context, senderIsPrimary: false })).toBe('contact_authority');
  });

  test('an edit made while extraction ran is preserved, including clearing an old value', () => {
    expect(factVerdict(fact(), { ...context, current: {}, expectedCurrent: { irrigation_controller_location: 'garage' } }))
      .toBe('changed_during_extraction');
  });

  test('does not turn a one-off request to text into a permanent preference', () => {
    expect(factVerdict(fact({ field: 'contact_preference', value: 'text', quote: 'Text me when you get here' }), context))
      .toBe('preference_uncertain');
    expect(factVerdict(fact({ field: 'contact_preference', value: 'text', quote: 'Text only please' }), context)).toBe('apply');
    expect(factVerdict(fact({ field: 'contact_preference', value: 'email', quote: 'Text only please' }), context))
      .toBe('preference_uncertain');
  });
});

describe('Owner-approved staff-promise plan (2026-09-28): a promise staff texted is read by the extraction, kept whatever its wording, and due at the end of the day it names', () => {
  // 2040-03-10 is a Saturday (EST); DST starts Sunday 2040-03-11.
  const staff = (body) => source(body, 'outbound');
  const promise = (quote, extra = {}) => obligation(quote, { basis: 'promise', promise_firm: true, kind: 'other', ...extra });

  test('a firm promise in a conversational staff text is kept: the customer-instruction word and question checks do not apply', () => {
    const message = staff("Not a problem, we'll adjust. How have the mosquitoes been?");
    expect(groundExtraction(extracted([promise("we'll adjust")]), { message, properties }).obligations).toHaveLength(1);
    // An offer or a question is not a promise: the extraction says so, and it is dropped.
    expect(groundExtraction(extracted([promise("we'll adjust", { promise_firm: false })]), { message, properties }).obligations).toEqual([]);
    const offer = staff('Are you around today? You want me to swing by?');
    expect(groundExtraction(extracted([promise('You want me to swing by', { promise_firm: false })]), { message: offer, properties }).obligations).toEqual([]);
    // A customer's text keeps every existing check: negated wording still drops its ask.
    const customer = source('Not today, but please send the estimate');
    expect(groundExtraction(extracted([obligation('please send the estimate')]), { message: customer, properties }).obligations).toEqual([]);
  });

  test('a staff promise whose words do not name its type is kept as a general promise; a customer ask is still dropped', () => {
    const message = staff("Hey, I'll stop by today");
    const kept = groundExtraction(extracted([promise("I'll stop by today", { kind: 'technician_follow_up' })]), { message, properties }).obligations;
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ kind: 'other', basis: 'promise' });
    // A named type stays: "the estimate" is an estimate.
    const named = staff("I'll send the estimate today");
    expect(groundExtraction(extracted([promise("I'll send the estimate today", { kind: 'send_estimate' })]), { message: named, properties })
      .obligations[0]).toMatchObject({ kind: 'send_estimate' });
    const ask = source('Can you stop by today');
    expect(groundExtraction(extracted([obligation('Can you stop by today', { kind: 'technician_follow_up' })]), { message: ask, properties })
      .obligations).toEqual([]);
  });

  test.each([
    ['the day it names, quoted', 'gonna knock out your spray tomorrow', 'tomorrow', '2040-03-11', '2040-03-11'],
    ["the text's own day", "I'll stop by today", 'today', '2040-03-10', '2040-03-10'],
    ['a span it names', 'gonna peel back this weekend', 'this weekend', '2040-03-11', '2040-03-11'],
    ['fourteen days out', "we'll be back March 24", 'March 24', '2040-03-24', '2040-03-24'],
    ['a day before the text', "I'll stop by tomorrow", 'tomorrow', '2040-03-09', null],
    ['a day its quoted words do not name (Codex #5248 r1 P1)', "I'll stop by tomorrow", 'tomorrow', '2040-03-12', null],
    ['wording the code cannot place on one day', "we'll be back in two weeks", 'in two weeks', '2040-03-24', null],
    ['more than fourteen days out', "we'll be back March 25", 'March 25', '2040-03-25', null],
    ['a date that does not exist', "I'll stop by tomorrow", 'tomorrow', '2040-02-30', null],
    ['timing that is not quoted', "I'll stop by soon", 'Wednesday', '2040-03-14', null],
    ['no timing words at all', "I'll stop by", null, '2040-03-11', null],
  ])('due_date: %s', (_label, body, dueText, dueDate, expected) => {
    const message = staff(body);
    const [kept] = groundExtraction(extracted([promise(body, { due_text: dueText, due_date: dueDate })]), { message, properties }).obligations;
    expect(kept.due_date).toBe(expected);
  });

  test('Codex #5248 r2: a customer-side kind on a staff promise makes it general, never dropped', () => {
    const message = staff("I'll send you photos tomorrow");
    const [kept] = groundExtraction(extracted([promise("I'll send you photos tomorrow", { kind: 'send_photos' })]), { message, properties }).obligations;
    expect(kept).toMatchObject({ kind: 'other', basis: 'promise' });
  });

  test.each([
    ['"before" a day is the day before it', "I'll send it before Wednesday", 'before Wednesday', '2040-03-13', '2040-03-13'],
    ['"before" read as the day itself is refused', "I'll send it before Wednesday", 'before Wednesday', '2040-03-14', null],
    ['a weekday abbreviation', "I'll call you Wed", 'Wed', '2040-03-14', '2040-03-14'],
    ['a second day in the promise', "I'll stop by Wednesday or Thursday", 'Wednesday', '2040-03-14', null],
    ['a hedge in the text', "I'll probably stop by Wednesday", 'Wednesday', '2040-03-14', null],
    ['one day named twice', 'Wednesday works, see you Wednesday', 'Wednesday', '2040-03-14', '2040-03-14'],
    // Codex #5248 r3: a subject date is no alternative; a range or a second day is.
    ['a dated subject beside its deadline', "I'll send the September 10 report tomorrow", 'tomorrow', '2040-03-11', '2040-03-11'],
    ['a range of days', "I'll be there Wed-Fri", 'Wed', '2040-03-14', null],
    ['two days joined by and', "I'll come tomorrow and Friday", 'tomorrow', '2040-03-11', null],
  ])('Codex #5248 r2 due_date: %s', (_label, body, dueText, dueDate, expected) => {
    const [kept] = groundExtraction(extracted([promise(body, { due_text: dueText, due_date: dueDate })]), { message: staff(body), properties }).obligations;
    expect(kept.due_date).toBe(expected);
  });

  test('Codex #5248 r3: "Wed at 3pm" resolves its clock; a yearless date near year-end is next year\'s', () => {
    const clocked = staff("I'll call Wed at 3pm");
    expect(groundExtraction(extracted([promise("I'll call Wed at 3pm", { due_text: 'Wed at 3pm', due_at: '2040-03-14T15:00:00-04:00' })]),
      { message: clocked, properties }).obligations[0]).toMatchObject({ due_at: '2040-03-14T19:00:00.000Z', timing_unverified: false });
    const yearEnd = { ...staff("I'll send it Jan 2"), created_at: '2040-12-28T15:00:00Z' };
    expect(groundExtraction(extracted([promise("I'll send it Jan 2", { due_text: 'Jan 2', due_date: '2041-01-02' })]),
      { message: yearEnd, properties }).obligations[0].due_date).toBe('2041-01-02');
  });

  test('Codex #5248 r3: a text stamped for another property never witnesses a scoped staff promise, whatever its type', () => {
    const scoped = { kind: 'other', sms_context: { source_at: '2040-03-10T15:00:00Z', basis: 'promise', property_id: 'home' } };
    const manual = { type: 'sms', status: 'delivered', message_type: 'manual', operator_sent: true };
    expect(admissibleWitness({ ...manual, linked_property_id: 'rental' }, scoped)).toBe(false);
    expect(admissibleWitness({ ...manual, operator_sent: false, linked_property_id: 'rental' }, scoped)).toBe(false);
    expect(admissibleWitness({ ...manual, linked_property_id: 'home' }, scoped)).toBe(true);
    expect(admissibleWitness(manual, scoped)).toBe(true);
    // A customer's ask keeps the human-type exemption unchanged.
    expect(admissibleWitness({ ...manual, linked_property_id: 'rental' }, { ...scoped, sms_context: { ...scoped.sms_context, basis: 'request' } })).toBe(true);
  });

  test('Codex #5248 r2: a general staff promise admits any delivered text written after it and an email to the customer; an ask does not', () => {
    const sms_context = { source_at: '2040-03-10T15:00:00Z', customer_id: CUSTOMER_ID };
    const staffPromise = { kind: 'other', sms_context: { ...sms_context, basis: 'promise' } };
    const ask = { kind: 'other', sms_context: { ...sms_context, basis: 'request' } };
    const guide = { type: 'sms', status: 'delivered', message_type: 'prep_guide', operator_sent: false };
    expect(admissibleWitness(guide, staffPromise)).toBe(true);
    expect(admissibleWitness(guide, ask)).toBe(false);
    // Queued before the promise: not written after it.
    expect(admissibleWitness({ ...guide, scheduled_at: '2040-03-10T14:00:00Z' }, staffPromise)).toBe(false);
    // Property-scoped: an unstamped text may carry the item; one stamped with another property never does.
    const scoped = { kind: 'other', sms_context: { ...sms_context, basis: 'promise', property_id: 'home' } };
    expect(admissibleWitness(guide, scoped)).toBe(true);
    expect(admissibleWitness({ ...guide, linked_property_id: 'rental' }, scoped)).toBe(false);
    expect(admissibleWitness({ ...guide, linked_property_id: 'home' }, scoped)).toBe(true);
    // A scoped promise of a typed kind keeps the stamp rule (Codex #4816 r39).
    expect(admissibleWitness({ ...guide, message_type: 'confirmation' },
      { kind: 'send_appointment_confirmation', sms_context: { ...sms_context, basis: 'promise', property_id: 'home' } })).toBe(false);
    const email = { type: 'email_delivery', status: 'delivered', sent_at: '2040-03-10T16:00:00Z', recipient_type: 'customer', recipient_id: CUSTOMER_ID };
    expect(admissibleWitness(email, staffPromise)).toBe(true);
    expect(admissibleWitness({ ...email, recipient_id: '00000000-0000-4000-8000-000000000999' }, staffPromise)).toBe(false);
    expect(admissibleWitness({ ...email, recipient_type: 'lead' }, staffPromise)).toBe(false);
    expect(admissibleWitness({ ...email, bounced_at: '2040-03-10T16:01:00Z' }, staffPromise)).toBe(false);
    expect(admissibleWitness(email, ask)).toBe(false);
  });

  test('due_date is never taken with a clock in the text, nor for a customer ask', () => {
    const clocked = staff("I'll be there tomorrow at 3pm");
    expect(groundExtraction(extracted([promise("I'll be there tomorrow at 3pm", { due_text: 'tomorrow at 3pm', due_date: '2040-03-11' })]),
      { message: clocked, properties }).obligations[0].due_date).toBeNull();
    const ask = source('Please send the estimate tomorrow');
    expect(groundExtraction(extracted([obligation('Please send the estimate tomorrow', { due_text: 'tomorrow', due_date: '2040-03-11' })]),
      { message: ask, properties }).obligations[0].due_date).toBeNull();
  });

  test('a promise naming a day is due 8 PM ET that day (DST-correct); within an hour of the text, 9 AM ET the next day', () => {
    const item = (extra) => ({ party: 'waves', basis: 'promise', kind: 'other', quote: "I'll stop by tomorrow", due_text: 'tomorrow', ...extra });
    // Sent Saturday 10 AM EST, due Sunday 8 PM EDT (00:00Z Monday).
    expect(resolveDueDeadline(item({ due_date: '2040-03-11' }), '2040-03-10T15:00:00Z'))
      .toEqual({ due_at: '2040-03-12T00:00:00.000Z', due_basis: 'default_kind' });
    // "Tonight", sent 7:30 PM EST: under an hour to 8 PM, so 9 AM EDT Sunday.
    expect(resolveDueDeadline(item({ quote: "I'll stop by tonight", due_text: 'tonight', due_date: '2040-03-10' }), '2040-03-11T00:30:00Z'))
      .toEqual({ due_at: '2040-03-11T13:00:00.000Z', due_basis: 'default_kind' });
    // A stated clock still wins.
    expect(resolveDueDeadline(item({ due_date: '2040-03-11', due_at: '2040-03-11T19:00:00.000Z' }), '2040-03-10T15:00:00Z'))
      .toEqual({ due_at: '2040-03-11T19:00:00.000Z', due_basis: 'stated' });
    // A customer ask never takes due_date: its stated timing keeps the existing rules (undated here).
    expect(resolveDueDeadline({ ...item({ due_date: '2040-03-11' }), basis: 'request', quote: 'Can you stop by tomorrow' }, '2040-03-10T15:00:00Z'))
      .toEqual({ due_at: null, due_basis: null });
  });

  test("the extraction is told the text's ET day and the staff-promise rules", () => {
    const prompt = buildPrompt({ message: staff("I'll stop by tomorrow") });
    expect(prompt).toContain('The CURRENT message was sent on Saturday, 2040-03-10 (America/New_York).');
    for (const phrase of ['promise_firm is true only for a promise (basis promise) its sender committed to outright',
      'Never extract a status update or arrival estimate', 'due_date, for a promise only, is the calendar day',
      '"This weekend" is that weekend\'s Sunday; "next week" is next week\'s Friday']) {
      expect(prompt).toContain(phrase);
    }
  });
});

describe('R5 owner ruling 2026-09-24: per-kind default deadlines', () => {
  const at = new Date('2040-03-10T15:00:00Z');
  test.each(Object.entries(DEFAULT_DEADLINE_HOURS))('a %s request with no stated due_at defaults to +%ih (due_basis default_kind)', (kind, hours) => {
    const item = { party: 'waves', kind, basis: 'request', due_at: null };
    expect(resolveDueDeadline(item, at)).toEqual({
      due_at: new Date(at.getTime() + hours * 3600000).toISOString(), due_basis: 'default_kind',
    });
  });

  test('any Waves basis=promise obligation defaults to +48h regardless of kind', () => {
    for (const kind of [...Object.keys(DEFAULT_DEADLINE_HOURS), 'send_reschedule_link']) {
      expect(resolveDueDeadline({ party: 'waves', kind, basis: 'promise', due_at: null }, at)).toEqual({
        due_at: new Date(at.getTime() + PROMISE_DEFAULT_DEADLINE_HOURS * 3600000).toISOString(), due_basis: 'default_kind',
      });
    }
  });

  test('Codex #4816 r2: a customer-owned obligation never gets a default deadline', () => {
    for (const kind of ['send_photos', 'call_back', 'make_payment', 'other']) {
      expect(resolveDueDeadline({ party: 'customer', kind, basis: 'promise', due_at: null }, at)).toEqual({ due_at: null, due_basis: null });
    }
    expect(resolveDueDeadline({ party: 'customer', kind: 'other', basis: 'request', due_at: null }, at)).toEqual({ due_at: null, due_basis: null });
  });

  test.each(['Can you call me tomorrow?', 'Can someone come out Friday?', 'Schedule me mid Oct',
    'Call me back in 2 hours', 'Can you come on 10/14?', 'Need someone out by the 15th', 'Send it by end of the week',
    'Call me Fri', 'Can you come next Tues', 'Can someone come on Sat?', 'Send it by Wed',
    'Call me on 2027-01-15', 'Hold off until the 20th', 'Starting the 3rd please call',
    'Please call me in the morning', 'Can you call in the afternoon?', 'Call after work', 'Evenings are best to call', 'Call around lunchtime',
    'Call me in 30 minutes', 'call me in 15 min', 'Give me 20 mins then call', 'Call within 2 hrs', 'Call me in half an hour',
    'Call in 1-2 hours', 'Call me in a bit', 'Call in a few', 'Call me in about 2 hours', 'Give me like 20 mins then call',
    'Call me over the weekend', 'Anytime through the week', 'Sometime in the next few days', 'At the next visit please call',
    'Call me in a year', 'Contact me within 2 yrs', 'Check back next year', 'Follow up in 6 mos', 'Over the next 2 years please check in',
    'Call early next year', 'Reach out by end of the year', 'Call me this month', 'Call me tomorrow, about the invoice',
    'Call me about the invoice. Tomorrow works', 'At the next visit please call about the bait',
    'Please call before my next appointment', 'Have it ready by the next service', 'Call me next time you are out',
    'Please call me about the invoice 10/14', 'Call me about the bill on 2040-10-14', 'Call about the estimate Oct 14',
    'Call me regarding the invoice by the 15th',
    'Please call me from Friday onward', 'Call me from tomorrow on', 'Available from Monday through Wednesday, call me',
    'Please call me about the report from last week tomorrow', 'Send the photos from Monday through Wednesday by Friday',
    'Please call me about my invoice tomorrow', 'Call about the invoice on Friday',
    'Call me regarding the estimate next week'])(
    'Codex #4816 r20: timing stated in the quote keeps the row undated even when due_text is empty (%s)', (quote) => {
      expect(resolveDueDeadline({ party: 'waves', kind: 'callback', basis: 'request', due_at: null, due_text: null, quote }, at))
        .toEqual({ due_at: null, due_basis: null });
    },
  );

  test.each(['Please call me at 3:00pm', 'Call at 3:00 p.m.', 'Call at 9:30am', 'Call at 9:30'])(
    'Codex #4816 r46: a minute clock with or without a meridiem is a stated clock (%s)', (quote) => {
      expect(statesClock(quote)).toBe(true);
      const item = { party: 'waves', kind: 'callback', basis: 'request', due_at: null, due_text: null, timing_unverified: true, quote };
      expect(resolveDueDeadline(item, at)).toEqual({ due_at: null, due_basis: null });
    });

  test('Codex #4816 r31: an unresolved clock suppresses the default only for the obligation whose quote states it', () => {
    const item = (quote) => ({ party: 'waves', kind: 'callback', basis: 'request', due_at: null, due_text: null, timing_unverified: true, quote });
    // "Call me at 3 and send the estimate": the flag covers the whole SMS.
    expect(resolveDueDeadline(item('Call me at 3'), at)).toEqual({ due_at: null, due_basis: null });
    expect(resolveDueDeadline({ ...item('send the estimate'), kind: 'send_estimate' }, at).due_basis).toBe('default_kind');
  });

  test('Codex #4816 r28 (reverses r22): only the obligation\'s own quote can suppress the default deadline', () => {
    const item = (quote) => ({ party: 'waves', kind: 'callback', basis: 'request', due_at: null, due_text: null, quote });
    // Timing in the quote itself: undated.
    expect(resolveDueDeadline(item('please call me tomorrow'), at)).toEqual({ due_at: null, due_basis: null });
    // An unrelated date elsewhere in the message ("The treatment on
    // 2026-08-01 failed; please call me") must not drop the follow-up bell:
    // resolveDueDeadline no longer reads the message body at all.
    expect(resolveDueDeadline(item('please call me'), at, 'The treatment on 2026-08-01 failed; please call me').due_basis)
      .toBe('default_kind');
  });

  test.each(['Please call me back', 'Can you send the estimate?', 'Call me back ASAP', 'Are you still coming?',
    'The sun is burning the lawn, can someone call me?', 'The dog sat on the bait station, please call',
    'Good morning, can someone call me back?', 'Can you call me later?', 'The treatment shortly after failed, please call',
    'The tech spent 2 hours here and it still failed, call me', 'Had ants all this year, please call',
    'Please call me about 2 years of invoices', 'The tech was here for like 2 hours and it failed; call me',
    "Please call me about this month's invoice", "Call me about tomorrow's appointment", "Can someone call about Friday's visit?",
    "Call me about next week's service", 'Please call me about my next visit', 'Can you call regarding the next appointment?',
    'Call me about tomorrow and the treatment plan', 'Please send me the report from this morning',
    "Send the photos from Friday's visit", 'Can you call to discuss the next appointment?', 'Please call, the next visit needs a gate code',
    'Please send me the report from the service that happened on Friday', 'Call me about the treatment that was done on Monday',
    'Please send me the report from Friday through Sunday', 'Send the photos from Monday until Wednesday'])(
    'Codex #4816 r20: a quote with no stated timing still gets the per-kind default (%s)', (quote) => {
      expect(resolveDueDeadline({ party: 'waves', kind: 'callback', basis: 'request', due_at: null, due_text: null, quote }, at).due_basis)
        .toBe('default_kind');
    },
  );

  test('a stated due_at is kept verbatim with due_basis "stated", never replaced by a default', () => {
    const stated = '2040-03-11T09:00:00.000Z';
    expect(resolveDueDeadline({ party: 'waves', kind: 'callback', basis: 'promise', due_at: stated }, at))
      .toEqual({ due_at: stated, due_basis: 'stated' });
  });

  test('a kind outside the table with no stated due_at falls back to the legacy null-due behavior', () => {
    expect(resolveDueDeadline({ party: 'waves', kind: 'not_a_kind', basis: 'request', due_at: null }, at))
      .toEqual({ due_at: null, due_basis: null });
  });

  test('Codex #4816 r1: a stated-but-unresolved time never gets a manufactured default deadline', () => {
    expect(resolveDueDeadline({ party: 'waves', kind: 'callback', basis: 'request', due_at: null, due_text: 'tomorrow at 9 or 10', timing_unverified: true }, at))
      .toEqual({ due_at: null, due_basis: null });
    expect(resolveDueDeadline({ party: 'waves', kind: 'schedule_visit', basis: 'request', due_at: null, due_text: 'mid Oct' }, at))
      .toEqual({ due_at: null, due_basis: null });
    expect(resolveDueDeadline({ party: 'waves', kind: 'callback', basis: 'promise', due_at: null, due_text: 'tomorrow' }, at))
      .toEqual({ due_at: null, due_basis: null });
  });

  test('send_reschedule_link shares the 24h scheduling window', () => {
    expect(DEFAULT_DEADLINE_HOURS.send_reschedule_link).toBe(24);
  });
});

describe('Owner ruling 2026-09-28: a same-day-only ask about TODAY gets an end-of-day deadline instead of staying undated', () => {
  const wavesItem = (quote, overrides = {}) => ({ party: 'waves', kind: 'other', basis: 'request', due_at: null, due_text: null, quote, ...overrides });

  test.each(["Can you call about tonight's visit?", "Confirm this afternoon's appointment please"])(
    // Codex #5170 r3 P2: a possessive same-day form names the topic, never the deadline.
    '"%s" names the visit, not the timing, so it never takes the same-day path', (quote) => {
      const at = parseETDateTime('2040-03-12T10:00');
      const item = { ...wavesItem(quote), due_text: quote.match(/(tonight|this afternoon)'s/)[0] };
      expect(resolveDueDeadline(item, at).due_at).not.toBe(parseETDateTime('2040-03-12T20:00').toISOString());
    });

  test.each(['Did you come today or not?', 'Can you call or text me today?', 'Can you come this afternoon or tonight?',
    // Codex #5170 r3 P2: a qualifier bound to the same-day form stays same-day.
    'Can you call later tonight?', 'Can you come any time today?', 'Stop by sometime this afternoon', 'Can you come later today?'])(
    // Codex #5170 r2 P2: a bare "or" with only same-day timing is still same-day.
    '"%s" offers no later option, so it gets the 8 PM ET same-day deadline', (quote) => {
      const at = parseETDateTime('2040-03-12T10:00');
      expect(resolveDueDeadline(wavesItem(quote), at)).toEqual({ due_at: parseETDateTime('2040-03-12T20:00').toISOString(), due_basis: 'default_kind' });
    });

  test('"Did you come to my house today?" at 10:00 ET gets an 8 PM ET same-day deadline', () => {
    const at = parseETDateTime('2040-03-12T10:00');
    expect(resolveDueDeadline(wavesItem('Did you come to my house today?'), at))
      .toEqual({ due_at: parseETDateTime('2040-03-12T20:00').toISOString(), due_basis: 'default_kind' });
  });

  test('"Should we skip today?" at 19:30 ET is less than an hour from 8 PM, so it rolls to 9 AM ET the next day', () => {
    const at = parseETDateTime('2040-03-12T19:30');
    expect(resolveDueDeadline(wavesItem('Should we skip today?'), at))
      .toEqual({ due_at: parseETDateTime('2040-03-13T09:00').toISOString(), due_basis: 'default_kind' });
  });

  test('exactly 1 hour before 8 PM ET still keeps the 8 PM deadline (the rollover is strictly "less than" an hour)', () => {
    const at = parseETDateTime('2040-03-12T19:00');
    expect(resolveDueDeadline(wavesItem('Did you come today?'), at))
      .toEqual({ due_at: parseETDateTime('2040-03-12T20:00').toISOString(), due_basis: 'default_kind' });
  });

  test.each(['tonight', 'this morning', 'this afternoon', 'this evening', 'later today', 'EOD', 'end of the day', 'end of day'])(
    'same-day token "%s" alone still gets the 8 PM ET deadline', (token) => {
      const at = parseETDateTime('2040-03-12T10:00');
      expect(resolveDueDeadline(wavesItem(`Can you take care of that ${token}?`), at))
        .toEqual({ due_at: parseETDateTime('2040-03-12T20:00').toISOString(), due_basis: 'default_kind' });
    });

  test.each(['Can you come today or tomorrow?', 'Come today, else Friday', 'Can you stop by today and Friday?',
    // Codex #5170 r1 P2: a bare later alternative STATED_TIMING alone would miss.
    'Can you come today or next visit?', 'Come today, otherwise whenever works', 'Skip today or next time is fine'])(
    '"%s" states more than same-day timing, so it keeps the legacy undated behavior', (quote) => {
      const at = parseETDateTime('2040-03-12T10:00');
      expect(resolveDueDeadline(wavesItem(quote), at)).toEqual({ due_at: null, due_basis: null });
    });

  test('"Please send it this afternoon" and "Call about the termite quote this afternoon" now bell at end of day — this ruling supersedes their prior Codex #4816 r20 undated case', () => {
    const at = parseETDateTime('2040-03-12T10:00');
    for (const quote of ['Please send it this afternoon', 'Call about the termite quote this afternoon']) {
      expect(resolveDueDeadline({ party: 'waves', kind: 'callback', basis: 'request', due_at: null, due_text: null, quote }, at))
        .toEqual({ due_at: parseETDateTime('2040-03-12T20:00').toISOString(), due_basis: 'default_kind' });
    }
  });

  test('"today at 3" still resolves through the existing stated path — an explicit due_at is never overridden by the same-day rule', () => {
    const at = parseETDateTime('2040-03-12T10:00');
    const stated = parseETDateTime('2040-03-12T15:00').toISOString();
    expect(resolveDueDeadline({ party: 'waves', kind: 'callback', basis: 'request', due_at: stated, quote: 'Come by today at 3' }, at))
      .toEqual({ due_at: stated, due_basis: 'stated' });
  });

  test('a customer-owned promise mentioning "today" stays undated — the same-day rule only applies to Waves obligations', () => {
    const at = parseETDateTime('2040-03-12T10:00');
    expect(resolveDueDeadline({ party: 'customer', kind: 'other', basis: 'promise', due_at: null, quote: "I'll be home today" }, at))
      .toEqual({ due_at: null, due_basis: null });
  });

  test('an unresolved clock ("by 3pm today") always keeps the row undated, even though "today" alone would otherwise qualify', () => {
    const at = parseETDateTime('2040-03-12T10:00');
    const item = { party: 'waves', kind: 'other', basis: 'request', due_at: null, due_text: null,
      quote: 'Can you come by 3pm today?', timing_unverified: true };
    expect(statesClock(item.quote)).toBe(true);
    expect(resolveDueDeadline(item, at)).toEqual({ due_at: null, due_basis: null });
  });

  test('a due_text naming only a same-day token still qualifies even if the surrounding quote has extra words', () => {
    const at = parseETDateTime('2040-03-12T10:00');
    const item = { party: 'waves', kind: 'other', basis: 'request', due_at: null, due_text: 'today',
      quote: 'Any chance you can swing by today, the yard looks rough?' };
    expect(resolveDueDeadline(item, at))
      .toEqual({ due_at: parseETDateTime('2040-03-12T20:00').toISOString(), due_basis: 'default_kind' });
  });

  test('a due_text naming more than the same day keeps the row undated', () => {
    const at = parseETDateTime('2040-03-12T10:00');
    const item = { party: 'waves', kind: 'other', basis: 'request', due_at: null, due_text: 'today or tomorrow',
      quote: 'Come by today or tomorrow' };
    expect(resolveDueDeadline(item, at)).toEqual({ due_at: null, due_basis: null });
  });

  test('"today\'s appointment" (possessive) is a topic reference, not same-day timing — falls through to the ordinary per-kind default like today', () => {
    const at = parseETDateTime('2040-03-12T10:00');
    const result = resolveDueDeadline(wavesItem("Can we reschedule today's appointment?", { kind: 'schedule_visit' }), at);
    // STATED_TIMING's own NOT_POSSESSIVE already keeps "today's" out of stated
    // timing entirely (unrelated to this ruling), so the row gets the
    // ordinary R5 per-kind default rather than the same-day 8 PM deadline —
    // still a real deadline either way, never left undated.
    expect(result.due_basis).toBe('default_kind');
    expect(result.due_at).toBe(new Date(at.getTime() + DEFAULT_DEADLINE_HOURS.schedule_visit * 3600000).toISOString());
  });

  test('DST boundary: a same-day deadline that rolls to the next ET day across the fall-back transition lands on the correct wall-clock instant', () => {
    // 2040-11-04 is the fall-back Sunday (America/New_York: 2 AM EDT -> 1 AM
    // EST). A message late Saturday the 3rd (still EDT, UTC-4) whose
    // rollover lands on the 4th (already EST, UTC-5) must read as 9 AM EST
    // — parseETDateTime resolves this from the calendar day + wall clock,
    // never a hand-rolled +23h/+24h offset.
    const at = parseETDateTime('2040-11-03T19:45'); // Saturday, EDT, 15 min to 8 PM
    const result = resolveDueDeadline(wavesItem('Should we skip today?'), at);
    const expected = parseETDateTime('2040-11-04T09:00'); // Sunday, after fall-back, EST
    expect(result).toEqual({ due_at: expected.toISOString(), due_basis: 'default_kind' });
    // Sanity: the instant actually crossed the DST seam — EDT is UTC-4 and
    // EST is UTC-5, so a naive same-offset +13h15m from 19:45 EDT would have
    // landed one hour off of the real 9 AM EST instant.
    expect(expected.getTime() - at.getTime()).toBe((13 * 60 + 15) * 60000 + 3600000);
  });
});

describe('fulfillment proof', () => {
  const commitment = { kind: 'send_estimate', sms_context: { property_id: PROPERTY_ID, source_at: '2040-03-10T15:00:00Z' } };
  const record = { id: 'estimate-id', ref: 'estimate:estimate-id', type: 'estimate', property_id: PROPERTY_ID,
    text: 'Quarterly lawn estimate', sent_at: '2040-03-11T15:00:00Z', handed_off_at: '2040-03-11T15:00:00Z', status: 'sent' };
  const verdict = { verdict: 'fulfilled', record_ref: record.ref, quote: record.text };

  test('accepts a grounded relevant sent estimate and refuses an invented witness', () => {
    expect(groundFulfillment(verdict, { records: [record], failures: [] }, commitment)).toMatchObject({ verdict: 'fulfilled' });
    expect(groundFulfillment({ ...verdict, record_ref: 'estimate:invented' }, { records: [record], failures: [] }, commitment))
      .toMatchObject({ verdict: 'uncertain' });
    expect(groundFulfillment(verdict, { records: [{ ...record, property_id: 'another-property' }], failures: [] }, commitment))
      .toMatchObject({ verdict: 'uncertain' });
  });

  test('an invoice record or an automatic reminder cannot clear the question', () => {
    expect(admissibleWitness({ ...record, type: 'invoice' }, { kind: 'other' })).toBe(false);
    expect(admissibleWitness({ type: 'sms', status: 'delivered', message_type: 'appointment_reminder' }, commitment)).toBe(false);
    expect(admissibleWitness({ type: 'sms', status: 'queued', message_type: 'manual' }, commitment)).toBe(false);
  });

  test('a sent timestamp without a post-request delivery cannot fulfill an estimate promise', () => {
    expect(admissibleWitness({ ...record, handed_off_at: null }, commitment)).toBe(false);
    expect(admissibleWitness({ ...record, handed_off_at: '2040-03-09T15:00:00Z' }, commitment)).toBe(false);
    expect(admissibleWitness({ ...record, sent_at: null }, commitment)).toBe(true);
  });

  test('a text cannot fulfill a promised phone call', () => {
    expect(admissibleWitness({ type: 'sms', status: 'delivered', message_type: 'manual' }, { kind: 'callback' })).toBe(false);
    expect(admissibleWitness({ type: 'call', status: 'completed', duration_seconds: 0 }, { kind: 'callback' })).toBe(false);
  });

  test('delivered confirmations satisfy only the appointment-confirmation kind', () => {
    const record = { type: 'sms', status: 'delivered', message_type: 'confirmation' };
    expect(admissibleWitness(record, { kind: 'send_appointment_confirmation' })).toBe(true);
    for (const kind of ['callback', 'send_report', 'send_paperwork', 'other']) {
      expect(admissibleWitness(record, { kind })).toBe(false);
    }
    for (const status of ['sent', 'failed', 'undelivered']) {
      expect(admissibleWitness({ ...record, status }, { kind: 'send_appointment_confirmation' })).toBe(false);
    }
  });

  test('Codex #4816 r39: a push-only confirmation the provider accepted answers the promise; an SMS left at sent does not', () => {
    const push = { type: 'sms', status: 'sent', message_type: 'confirmation', from_phone: 'push', provider_accepted: true };
    expect(admissibleWitness(push, { kind: 'send_appointment_confirmation' })).toBe(true);
    expect(admissibleWitness({ ...push, provider_accepted: false }, { kind: 'send_appointment_confirmation' })).toBe(false);
    expect(admissibleWitness({ ...push, from_phone: '+19415550100' }, { kind: 'send_appointment_confirmation' })).toBe(false);
  });

  test('Codex #4816 r40: the scheduled-push fallback row (SMS from_phone, push channel stamped) is delivery proof', () => {
    const settled = { type: 'sms', status: 'sent', message_type: 'confirmation', from_phone: '+19415550100', provider_accepted: true, push_channel: true };
    expect(admissibleWitness(settled, { kind: 'send_appointment_confirmation' })).toBe(true);
    expect(admissibleWitness({ ...settled, push_channel: false }, { kind: 'send_appointment_confirmation' })).toBe(false);
    expect(admissibleWitness({ ...settled, provider_accepted: false }, { kind: 'send_appointment_confirmation' })).toBe(false);
  });

  test('Codex #4816 r39: on a property-scoped promise an automated notice counts only for a visit at that property', () => {
    const scoped = { kind: 'send_appointment_confirmation', sms_context: { property_id: 'home' } };
    const notice = { type: 'sms', status: 'delivered', message_type: 'appointment_rescheduled', linked_property_id: 'home' };
    expect(admissibleWitness(notice, scoped)).toBe(true);
    expect(admissibleWitness({ ...notice, linked_property_id: 'rental' }, scoped)).toBe(false);
    // Unlinked: cannot vouch for the scoped property.
    expect(admissibleWitness({ ...notice, linked_property_id: null }, scoped)).toBe(false);
    // Unscoped promise, or a human-typed text (the model reads its words): unchanged.
    expect(admissibleWitness({ ...notice, linked_property_id: null }, { kind: 'send_appointment_confirmation' })).toBe(true);
    expect(admissibleWitness({ ...notice, message_type: 'manual', linked_property_id: null }, scoped)).toBe(true);
  });

  test('provider acceptance or a SENT label cannot close an answer before delivery succeeds', () => {
    // R3 (owner ruling 2026-09-24) drops sms/email_delivery from `other`'s
    // witness types entirely; this test's own subject is generic
    // delivery-status gating, so it runs against a kind that still has them.
    const answer = { kind: 'send_appointment_confirmation' };
    const sms = { type: 'sms', message_type: 'manual' };
    const email = { type: 'email_delivery', recipient_email_snapshot: 'synthetic@example.invalid', sent_at: '2040-03-11T15:00:00Z' };
    const emailAnswer = { ...answer, evidence: [{ quote: 'Email the answer to synthetic@example.invalid' }] };
    expect(admissibleWitness({ ...sms, status: 'sent' }, answer)).toBe(false);
    expect(admissibleWitness({ ...sms, status: 'undelivered' }, answer)).toBe(false);
    expect(admissibleWitness({ ...sms, status: 'delivered' }, answer)).toBe(true);
    expect(admissibleWitness({ ...email, status: 'sent' }, emailAnswer)).toBe(false);
    expect(admissibleWitness({ ...email, status: 'bounced', bounced_at: '2040-03-11T15:01:00Z' }, emailAnswer)).toBe(false);
    expect(admissibleWitness({ ...email, status: 'delivered' }, emailAnswer)).toBe(true);
    expect(admissibleWitness({ type: 'email', label_ids: ['SENT'] }, answer)).toBe(false);
  });

  test('email completion requires the exact single recipient in the grounded request', () => {
    // R3: `other` no longer admits email_delivery at all — this test's own
    // subject is the recipient-matching gate, so it runs against a kind
    // that still has email_delivery in its witness types.
    const request = { kind: 'send_appointment_confirmation', evidence: [{ quote: 'Send the answer to desired@example.invalid' }] };
    const email = { type: 'email_delivery', status: 'delivered', sent_at: '2040-03-11T15:00:00Z',
      recipient_email_snapshot: 'old@example.invalid' };
    expect(admissibleWitness(email, request)).toBe(false);
    expect(admissibleWitness({ ...email, recipient_email_snapshot: 'DESIRED@example.invalid' }, request)).toBe(true);
    expect(admissibleWitness(email, { kind: 'send_appointment_confirmation', evidence: [{ quote: 'Send the answer to my manager' }] })).toBe(false);
    expect(admissibleWitness(email, { ...request, evidence: [{ quote: 'Send to old@example.invalid and desired@example.invalid' }] })).toBe(false);
    expect(admissibleWitness({ type: 'sms', status: 'delivered', message_type: 'manual' }, request)).toBe(false);
  });

  test('owner ruling 2026-09-28 (reverses R3): an "other" ask admits any text a person sent and a call back a person placed, never an automated text or call', () => {
    const other = { kind: 'other' };
    const personSms = { type: 'sms', status: 'delivered', message_type: 'manual', operator_sent: true };
    const staffCall = { type: 'call', status: 'completed', duration_seconds: 90, source: 'admin-click',
      v2_extraction_status: 'valid', is_voicemail: 'false' };
    // The R3 "separate the charges" case: a person's "Done" now answers it.
    expect(admissibleWitness(personSms, other)).toBe(true);
    // Staff draft-approval sends carry their own provenance type.
    expect(admissibleWitness({ ...personSms, operator_sent: false, message_type: 'ai_approved' }, other)).toBe(true);
    // Codex #5169 r1 P1: automated senders reuse the bare 'manual' type.
    expect(admissibleWitness({ ...personSms, operator_sent: false }, other)).toBe(false);
    expect(admissibleWitness({ ...personSms, message_type: 'confirmation' }, other)).toBe(false);
    expect(admissibleWitness({ ...personSms, status: 'queued' }, other)).toBe(false);
    // A text a person queued before the ask and that went out after it was not written in reply to it.
    const asked = { kind: 'other', sms_context: { source_at: '2040-03-10T15:00:00Z' } };
    expect(admissibleWitness({ ...personSms, scheduled_at: '2040-03-10T14:00:00Z' }, asked)).toBe(false);
    expect(admissibleWitness({ ...personSms, scheduled_at: '2040-03-10T15:30:00Z' }, asked)).toBe(true);
    // A call back counts only through the staff bridge, never a robocall or an unsourced row,
    // and only once it reached the customer (Codex #5220 r1 P1): the recording's reviewed
    // extraction heard a live conversation, and a card call's own customer leg completed.
    for (const source of ['admin-click', 'admin-callback', 'tech-click']) expect(admissibleWitness({ ...staffCall, source }, other)).toBe(true);
    for (const source of ['collections_voice', 'status_callback', null]) expect(admissibleWitness({ ...staffCall, source }, other)).toBe(false);
    expect(admissibleWitness({ ...staffCall, duration_seconds: 30 }, other)).toBe(false);
    expect(admissibleWitness({ ...staffCall, is_voicemail: 'true' }, other)).toBe(false);
    expect(admissibleWitness({ ...staffCall, is_voicemail: null }, other)).toBe(false);
    expect(admissibleWitness({ ...staffCall, v2_extraction_status: 'schema_failed' }, other)).toBe(false);
    expect(admissibleWitness({ ...staffCall, customer_leg_status: 'no-answer', customer_leg_seconds: '0' }, other)).toBe(false);
    expect(admissibleWitness({ ...staffCall, customer_leg_status: 'completed', customer_leg_seconds: '45' }, other)).toBe(false);
    expect(admissibleWitness({ ...staffCall, customer_leg_status: 'completed', customer_leg_seconds: '75' }, other)).toBe(true);
    // An ask naming an address still takes a person's reply (Codex #5169 r1
    // P2); an email delivery is still no `other` witness.
    const emailOther = { kind: 'other', evidence: [{ quote: 'Email the answer to synthetic@example.invalid' }], sms_context: { basis: 'request' } };
    expect(admissibleWitness(personSms, emailOther)).toBe(true);
    expect(admissibleWitness(staffCall, emailOther)).toBe(true);
    // A promise staff made to email an address is proved by that delivery, never a text or call.
    expect(admissibleWitness(personSms, { ...emailOther, sms_context: { basis: 'promise' } })).toBe(false);
    expect(admissibleWitness({ type: 'email_delivery', status: 'delivered', sent_at: '2040-03-11T15:00:00Z',
      recipient_email_snapshot: 'synthetic@example.invalid' }, emailOther)).toBe(false);
    // `callback` keeps its existing call/visit mix, whoever placed the call.
    expect(admissibleWitness({ type: 'call', status: 'completed', duration_seconds: 90 }, { kind: 'callback' })).toBe(true);
    // Payment admissibility is untouched: gated by money_answerable alone.
    const paid = { type: 'payment', payment_source: 'ledger' };
    expect(admissibleWitness(paid, { kind: 'other', sms_context: { money_answerable: false } })).toBe(false);
    expect(admissibleWitness(paid, { kind: 'other', sms_context: { money_answerable: true } })).toBe(true);
  });

  test('Codex #4816 r1: a visit never system-closes a schedule_visit or technician_follow_up (service match stays with the model)', () => {
    const visitWitness = { id: 'visit-1', ref: 'visit:visit-1', type: 'visit', status: 'completed', property_id: PROPERTY_ID,
      created_at: '2040-03-11T15:00:00Z', booked_at: '2040-03-11T15:00:00Z', completed_at: '2040-03-12T15:00:00Z', transitioned_at: '2040-03-12T15:00:00Z',
      text: 'Quarterly Lawn on 2040-03-12 at 09:00:00; status completed' };
    for (const kind of ['schedule_visit', 'technician_follow_up']) {
      const commitment = { kind, sms_context: { property_id: PROPERTY_ID, source_at: '2040-03-10T15:00:00Z' } };
      expect(admissibleWitness(visitWitness, commitment)).toBe(true);
    }
  });

  test('Codex #4816 r46 pre-push: the provider sees whether an SMS row is an accepted App push, never its phone number', async () => {
    const commitment = { kind: 'send_appointment_confirmation', description: 'Confirm my appointment',
      sms_context: { property_id: null, source_at: '2040-03-10T15:00:00Z' } };
    const push = { id: 'sms-1', ref: 'sms:sms-1', type: 'sms', status: 'sent', message_type: 'confirmation', from_phone: '+19415559876',
      provider_accepted: true, push_channel: true, created_at: '2040-03-10T16:00:00Z', text: 'Your appointment is confirmed.' };
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { verdict: 'open', record_ref: null, quote: null } });
    await verifySmsFulfillment(commitment, { records: [push], failures: [] });
    const prompt = dispatchWithFallback.mock.calls.at(-1)[1].text;
    expect(prompt).not.toContain('9415559876');
    expect(prompt).not.toContain('from_phone');
    expect(prompt).toContain('"app_push_accepted":true');
  });

  test('Codex #4816 r7: a cancellation after the text answers a cancel ask for the model only; it never closes "still coming?"', () => {
    const ctx = { property_id: 'home', source_at: '2040-03-10T15:00:00Z' };
    const cancelled = { id: 'visit-1', ref: 'visit:visit-1', type: 'visit', status: 'cancelled', created_at: '2040-03-01T15:00:00Z',
      property_id: 'home',
      cancelled_at: '2040-03-11T15:00:00Z', text: 'Quarterly Lawn on 2040-03-12 at 09:00:00; status cancelled; cancelled after the request' };
    const cancelAsk = { kind: 'other', description: 'Please cancel my appointment on Thursday', sms_context: ctx };
    expect(admissibleWitness(cancelled, cancelAsk)).toBe(true);
    // Cancelled before the text: no witness.
    expect(admissibleWitness({ ...cancelled, cancelled_at: '2040-03-09T15:00:00Z' }, cancelAsk)).toBe(false);
    // A callback is answered by a call or field progress, never a cancellation.
    expect(admissibleWitness(cancelled, { kind: 'callback', sms_context: ctx })).toBe(false);
  });

  test('Codex #4816 r17: inside an open window only an event record can ground a fulfilled verdict', async () => {
    const ctx = { property_id: null, source_at: '2040-03-10T15:00:00Z' };
    const callback = { kind: 'callback', description: 'Please call me back', sms_context: ctx };
    const call = { id: 'call-1', ref: 'call:call-1', type: 'call', status: 'completed', duration_seconds: 120,
      created_at: '2040-03-11T15:00:00Z', text: 'Returned the customer call about the visit' };
    const visit = { id: 'v-1', ref: 'visit:v-1', type: 'visit', status: 'en_route', property_id: 'home',
      created_at: '2040-03-09T15:00:00Z', progressed_at: '2040-03-11T15:00:00Z',
      text: 'Quarterly Lawn on 2040-03-11 at 09:00:00; status en_route; en route/on site/completed after the request' };
    const evidence = { records: [call, visit], failures: [] };
    const citeCall = { verdict: 'fulfilled', record_ref: 'call:call-1', quote: 'Returned the customer call' };
    expect(groundFulfillment(citeCall, evidence, callback).verdict).toBe('fulfilled');
    expect(groundFulfillment(citeCall, evidence, callback, { eventOnly: true })).toMatchObject({ verdict: 'uncertain', reason: 'invalid_witness' });
    expect(groundFulfillment({ verdict: 'fulfilled', record_ref: 'visit:v-1', quote: 'en route' }, evidence, callback, { eventOnly: true }).verdict)
      .toBe('fulfilled');
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { verdict: 'open', record_ref: null, quote: null } });
    const verdict = await verifySmsFulfillment(callback, evidence, { eventOnly: true });
    expect(dispatchWithFallback.mock.calls.at(-1)[1].text).toContain('"witness_refs":["visit:v-1"]');
    expect(verdict.event_only).toBe(true);
    // The instructions admit the same accepted-push proof admissibleWitness does (#4816 r41 pre-push).
    expect(dispatchWithFallback.mock.calls.at(-1)[1].text).toContain('except an App push the provider accepted');
    // The window check and the after-deadline check never share a cached verdict.
    expect(fulfillmentFingerprint(callback, evidence, { eventOnly: true }).evidenceHash)
      .not.toBe(fulfillmentFingerprint(callback, evidence).evidenceHash);
    // The event page's watermark is not obligation content.
    expect(fulfillmentFingerprint({ ...callback, sms_context: { ...ctx, event_seen_at: '2040-03-11T16:00:00Z' } }, evidence).evidenceHash)
      .toBe(fulfillmentFingerprint(callback, evidence).evidenceHash);
  });

  test('Codex #4816 r34: progress recorded before a later cancellation still answers "still coming?" or a callback', () => {
    const ask = (kind, sms_context = {}) => ({ kind, description: 'You still coming?',
      sms_context: { property_id: null, source_at: '2040-03-10T15:00:00Z', ...sms_context } });
    const progressedThenCancelled = { id: 'visit-c', ref: 'visit:visit-c', type: 'visit', status: 'cancelled', property_id: 'home',
      created_at: '2040-03-01T15:00:00Z', progressed_at: '2040-03-10T16:00:00Z', cancelled_at: '2040-03-10T18:00:00Z',
      text: 'Quarterly Lawn on 2040-03-10 at 09:00:00; status cancelled; en route/on site/completed after the request; cancelled after the request' };
    // Unscoped: the progress stamp answers; the cancellation never does.
    expect(admissibleWitness(progressedThenCancelled, ask('other'))).toBe(true);
    expect(admissibleWitness(progressedThenCancelled, ask('callback'))).toBe(true);
    const grounded = groundFulfillment({ verdict: 'fulfilled', record_ref: 'visit:visit-c', quote: 'en route' },
      { records: [progressedThenCancelled], failures: [] }, ask('other'));
    expect(grounded).toMatchObject({ verdict: 'fulfilled', matched_at: new Date('2040-03-10T16:00:00Z') });
    // No progress: an unscoped ask or a callback has no witness in a cancellation.
    const cancelledOnly = { ...progressedThenCancelled, progressed_at: null };
    expect(admissibleWitness(cancelledOnly, ask('other'))).toBe(false);
    expect(admissibleWitness(cancelledOnly, ask('callback'))).toBe(false);
    // Scoped cancel ask: the cancellation answers; the earliest qualifying stamp is the witness time.
    expect(admissibleWitness(cancelledOnly, ask('other', { property_id: 'home' }))).toBe(true);
  });

  test('Codex #4816 r35: recorded progress still answers after a move resets the visit to confirmed', () => {
    const ask = (kind) => ({ kind, description: 'You still coming?',
      sms_context: { property_id: null, source_at: '2040-03-10T15:00:00Z' } });
    const progressedThenMoved = { id: 'visit-m', ref: 'visit:visit-m', type: 'visit', status: 'confirmed', property_id: 'home',
      created_at: '2040-03-01T15:00:00Z', progressed_at: '2040-03-10T16:00:00Z', moved_at: '2040-03-10T17:00:00Z',
      text: 'Quarterly Lawn on 2040-03-12 at 09:00:00; status confirmed; moved after the request; en route/on site/completed after the request' };
    for (const status of ['confirmed', 'rescheduled']) {
      expect(admissibleWitness({ ...progressedThenMoved, status }, ask('other'))).toBe(true);
      expect(admissibleWitness({ ...progressedThenMoved, status }, ask('callback'))).toBe(true);
    }
    // A move alone is not progress.
    expect(admissibleWitness({ ...progressedThenMoved, progressed_at: null }, ask('other'))).toBe(false);
    expect(admissibleWitness({ ...progressedThenMoved, progressed_at: null }, ask('callback'))).toBe(false);
    // Back at confirmed with no logged move: an undone En Route tap, not progress.
    expect(admissibleWitness({ ...progressedThenMoved, moved_at: null }, ask('other'))).toBe(false);
    expect(admissibleWitness({ ...progressedThenMoved, moved_at: null }, ask('callback'))).toBe(false);
  });

  test('Codex #4816 r43: progress recorded before a later no_show still answers; a no_show alone does not', () => {
    const ask = (kind) => ({ kind, description: 'You still coming?', sms_context: { property_id: null, source_at: '2040-03-10T15:00:00Z' } });
    const noShow = { id: 'visit-n', ref: 'visit:visit-n', type: 'visit', status: 'no_show', property_id: 'home',
      created_at: '2040-03-01T15:00:00Z', progressed_at: '2040-03-10T16:00:00Z', text: 'Quarterly Lawn; status no_show' };
    expect(admissibleWitness(noShow, ask('other'))).toBe(true);
    expect(admissibleWitness(noShow, ask('callback'))).toBe(true);
    expect(admissibleWitness({ ...noShow, progressed_at: null }, ask('other'))).toBe(false);
    expect(admissibleWitness({ ...noShow, progressed_at: null }, ask('callback'))).toBe(false);
  });

  test('Codex #4816 r48: recorded progress still answers after a later skip; a pre-field reset without a move does not', () => {
    const ask = (kind) => ({ kind, description: 'You still coming?', sms_context: { property_id: null, source_at: '2040-03-10T15:00:00Z' } });
    const base = { id: 'visit-s', ref: 'visit:visit-s', type: 'visit', property_id: 'home', created_at: '2040-03-01T15:00:00Z',
      progressed_at: '2040-03-10T16:00:00Z', text: 'Quarterly Lawn' };
    for (const status of ['skipped', 'no_show', 'cancelled', 'completed', 'en_route']) {
      expect(admissibleWitness({ ...base, status }, ask('other'))).toBe(true);
      expect(admissibleWitness({ ...base, status }, ask('callback'))).toBe(true);
    }
    for (const status of ['pending', 'scheduled', 'confirmed']) {
      expect(admissibleWitness({ ...base, status }, ask('other'))).toBe(false);
    }
    expect(admissibleWitness({ ...base, status: 'skipped', progressed_at: null }, ask('callback'))).toBe(false);
  });

  test('Codex #4816 r14–r27: a cancellation answers only a cancel ask whose property was resolved', () => {
    const ask = (sms_context) => ({ kind: 'other', description: 'Please cancel Thursday\'s appointment',
      sms_context: { property_id: null, source_at: '2040-03-10T15:00:00Z', ...sms_context } });
    const cancelled = { id: 'visit-b', ref: 'visit:visit-b', type: 'visit', status: 'cancelled', created_at: '2040-03-01T15:00:00Z',
      property_id: 'property-b', cancelled_at: '2040-03-11T15:00:00Z', text: 'Quarterly Lawn on 2040-03-12 at 09:00:00; status cancelled' };
    // Unscoped: nothing records the customer's properties when the text
    // arrived, so a cancellation anywhere cannot vouch for the asked-about visit.
    expect(admissibleWitness(cancelled, ask({}))).toBe(false);
    expect(admissibleWitness(cancelled, ask({ sole_property_id: 'property-b' }))).toBe(false);
    // Scoped to a resolved property: the cancellation there answers it.
    expect(admissibleWitness(cancelled, ask({ property_id: 'property-b' }))).toBe(true);
    expect(admissibleWitness(cancelled, ask({ property_id: 'property-a' }))).toBe(false);
    // Field progress still answers an unscoped "still coming?" (owner ruling 2026-09-24).
    const progressed = { ...cancelled, status: 'en_route', cancelled_at: null, progressed_at: '2040-03-11T15:00:00Z' };
    expect(admissibleWitness(progressed, ask({}))).toBe(true);
  });

  test('Codex #4816 r1: production confirmation/reschedule-link sends are admissible for their kinds', () => {
    const delivered = (message_type) => ({ type: 'sms', status: 'delivered', message_type, created_at: '2040-03-11T15:00:00Z' });
    expect(admissibleWitness(delivered('appointment_rescheduled'), { kind: 'send_appointment_confirmation' })).toBe(true);
    // Estimate-acceptance bookings stamp this one (routes/estimate-public.js → send-customer-message).
    expect(admissibleWitness(delivered('appointment_confirmation'), { kind: 'send_appointment_confirmation' })).toBe(true);
    expect(admissibleWitness(delivered('reschedule_series_confirmation'), { kind: 'send_appointment_confirmation' })).toBe(true);
    // Codex #4816 r9: admin-dispatch.js recurring-placement notice.
    expect(admissibleWitness(delivered('appointment_recurring_placement_confirmed'), { kind: 'send_appointment_confirmation' })).toBe(true);
    expect(admissibleWitness(delivered('reschedule_link_promise'), { kind: 'send_reschedule_link' })).toBe(true);
    expect(admissibleWitness(delivered('reschedule_link_promise'), { kind: 'send_appointment_confirmation' })).toBe(false);
    expect(admissibleWitness(delivered('receipt'), { kind: 'send_reschedule_link' })).toBe(false);
  });

  test('R1 owner ruling 2026-09-24 (settled r10): visit progress is admissible for other/callback asks; the model decides', () => {
    const other = { kind: 'other', sms_context: { property_id: null, source_at: '2040-03-10T15:00:00Z' } };
    const visitWitness = { id: 'visit-1', ref: 'visit:visit-1', type: 'visit', status: 'completed',
      created_at: '2040-03-09T15:00:00Z', progressed_at: '2040-03-11T15:00:00Z',
      text: 'Quarterly Lawn on 2040-03-11 at 09:00:00; status completed' };
    expect(admissibleWitness(visitWitness, other)).toBe(true);
    expect(admissibleWitness(visitWitness, { ...other, kind: 'callback' })).toBe(true);
    expect(admissibleWitness({ ...visitWitness, progressed_at: null }, other)).toBe(false);
    // Codex #4816 r10: the no-model close is gone — "please cancel Thursday"
    // is also `other`, and a tech going en route does not answer it.
    expect(require('../services/sms-commitment-fulfillment').systemEventFulfillment).toBeUndefined();
  });

  test('a visit needs post-request scheduling or completion activity', () => {
    const before = '2040-03-09T15:00:00Z';
    const after = '2040-03-11T15:00:00Z';
    const visit = { type: 'visit', property_id: PROPERTY_ID, status: 'confirmed', created_at: before };
    const scheduled = { ...commitment, kind: 'schedule_visit' };
    const completed = { ...commitment, kind: 'technician_follow_up' };
    expect(admissibleWitness(visit, scheduled)).toBe(false);
    expect(admissibleWitness({ ...visit, created_at: after }, scheduled)).toBe(true);
    expect(admissibleWitness({ ...visit, status: 'rescheduled', booked_at: after }, scheduled)).toBe(true);
    expect(admissibleWitness({ ...visit, status: 'completed', completed_at: before }, completed)).toBe(false);
    expect(admissibleWitness({ ...visit, status: 'completed', completed_at: after }, completed)).toBe(true);
    expect(admissibleWitness({ ...visit, status: 'completed', created_at: after, completed_at: before }, completed)).toBe(false);
  });
  test.each(['en_route', 'on_site', 'completed', 'cancelled', 'skipped'])(
    'schedule fulfillment uses post-request booking evidence when a visit is %s', (status) => {
      const scheduled = { ...commitment, kind: 'schedule_visit' };
      const before = '2040-03-09T15:00:00Z';
      const after = '2040-03-11T15:00:00Z';
      const visit = { type: 'visit', property_id: PROPERTY_ID, status, created_at: before, transitioned_at: after };
      const active = ['en_route', 'on_site', 'completed'].includes(status);
      expect(admissibleWitness(visit, scheduled)).toBe(false);
      expect(admissibleWitness({ ...visit, created_at: after }, scheduled)).toBe(active);
      expect(admissibleWitness({ ...visit, booked_at: after }, scheduled)).toBe(active);
    },
  );

  test.each([['other', 'en_route'], ['callback', 'on_site']])(
    'owner ruling 2026-09-24: a %s ask is nullified by visible field progress after the request, not before it, and not by a mere booking',
    (kind, status) => {
      const before = '2040-03-09T15:00:00Z';
      const after = '2040-03-11T15:00:00Z';
      const commitment = { kind, sms_context: { property_id: PROPERTY_ID, source_at: '2040-03-10T15:00:00Z' } };
      const progressedAfter = { type: 'visit', property_id: PROPERTY_ID, status, created_at: before, progressed_at: after };
      // The same transition, but it happened before the request was ever made.
      const progressedBefore = { ...progressedAfter, progressed_at: before };
      // A visit that was merely (re)booked after the request, with no progress
      // recorded, does not answer "are you still coming" / "will you call".
      const bookedOnly = { type: 'visit', property_id: PROPERTY_ID, status: 'confirmed', created_at: after, booked_at: after };
      expect(admissibleWitness(progressedAfter, commitment)).toBe(true);
      expect(admissibleWitness(progressedBefore, commitment)).toBe(false);
      expect(admissibleWitness(bookedOnly, commitment)).toBe(false);
      expect(admissibleWitness({ ...progressedAfter, status: 'confirmed' }, commitment)).toBe(false);
    },
  );

  test('owner ruling 2026-09-24: an "other" ask with no stated property accepts any of the customer\'s own visits', () => {
    const after = '2040-03-11T15:00:00Z';
    const commitment = { kind: 'other', sms_context: { property_id: null, source_at: '2040-03-10T15:00:00Z' } };
    const progressed = { type: 'visit', property_id: 'some-other-property', status: 'completed', created_at: '2040-03-09T15:00:00Z', progressed_at: after };
    expect(admissibleWitness(progressed, commitment)).toBe(true);
    // technician_follow_up still requires an exact, stated property match.
    expect(admissibleWitness(progressed, { ...commitment, kind: 'technician_follow_up' })).toBe(false);
  });

  test('a staff claim of sending or completing work is not the deliverable itself', () => {
    const reply = { type: 'sms', status: 'delivered', message_type: 'manual', text: 'I sent the estimate' };
    expect(admissibleWitness(reply, { kind: 'send_estimate' })).toBe(false);
    expect(admissibleWitness({ type: 'call', status: 'completed', duration_seconds: 90 }, { kind: 'technician_follow_up' })).toBe(false);
    expect(admissibleWitness({ type: 'visit', status: 'confirmed', property_id: PROPERTY_ID }, {
      kind: 'technician_follow_up', sms_context: { property_id: PROPERTY_ID },
    })).toBe(false);
  });

  test.each(['open', 'uncertain'])('unchanged evidence reuses %s while content and ownership changes recheck it', async (status) => {
    dispatchWithFallback.mockReset().mockResolvedValue({ ok: true, json: { verdict: status, record_ref: null, quote: null } });
    const evidence = { records: [{ ref: 'sms:1', type: 'sms', text: 'Still checking', status: 'sent' }], failures: [] };
    const first = await verifySmsFulfillment(commitment, evidence);
    const cached = { ...commitment, sms_context: { ...commitment.sms_context, fulfillment_check: first } };
    expect(await verifySmsFulfillment(cached, evidence)).toEqual(first);
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    await verifySmsFulfillment(cached, { ...evidence, records: [{ ...evidence.records[0], status: 'delivered' }] });
    await verifySmsFulfillment({ ...cached, sms_context: { ...cached.sms_context, customer_id: 'new-owner' } }, evidence);
    await verifySmsFulfillment({ ...cached, evidence: [{ quote: 'Only the revised confirmation' }] }, evidence);
    expect(dispatchWithFallback).toHaveBeenCalledTimes(4);
    expect(dispatchWithFallback.mock.calls[3][1].text).toContain('Only the revised confirmation');
  });

  test('fulfillment scrubs raw cross-channel text and rejects payment-data witness quotes', async () => {
    dispatchWithFallback.mockReset().mockResolvedValue({ ok: true, json: { verdict: 'open', record_ref: null, quote: null } });
    const text = 'My card is 4242 4242 4242 4242. CVV is 123';
    const evidence = { records: [{ ref: 'sms:1', type: 'sms', text, message_body: text }], failures: [] };
    await verifySmsFulfillment(commitment, evidence);
    expect(dispatchWithFallback.mock.calls[0][1].text).not.toContain('4242 4242 4242 4242');
    expect(dispatchWithFallback.mock.calls[0][1].text).not.toContain('CVV is 123');
    expect(groundFulfillment({ verdict: 'fulfilled', record_ref: 'sms:1', quote: text }, evidence, { kind: 'other' }))
      .toMatchObject({ verdict: 'uncertain', reason: 'sensitive_model_output' });
  });

  test('only admissible records are offered to the model as witness_refs (R2: a payment can be; a text with no person\'s mark never is)', async () => {
    dispatchWithFallback.mockReset().mockResolvedValue({ ok: true, json: { verdict: 'open', record_ref: null, quote: null } });
    const ctx = { property_id: null, source_at: '2040-03-10T15:00:00Z' };
    const visit = { ref: 'visit:v-1', type: 'visit', id: 'v-1', status: 'en_route', progressed_at: '2040-03-11T15:00:00Z',
      text: 'Quarterly Lawn on 2040-03-11 at 09:00:00; status en_route; en route/on site/completed after the request' };
    const staffSms = { ref: 'sms:1', type: 'sms', status: 'delivered', message_type: 'manual', created_at: '2040-03-11T15:00:00Z', text: 'On our way' };
    const paid = { ref: 'payment:i-1', type: 'payment', payment_source: 'invoice', id: 'i-1', paid_at: '2040-03-11T15:00:00Z', text: 'Invoice paid 2040-03-11' };
    // An ask the extraction marked answerable by a payment (answered_by_payment, stamped at intake).
    const ask = { kind: 'other', description: 'Did my payment go through?', sms_context: { ...ctx, money_answerable: true } };
    expect(admissibleWitness(staffSms, ask)).toBe(false);
    expect(admissibleWitness(paid, ask)).toBe(true);
    await verifySmsFulfillment(ask, { records: [visit, staffSms, paid], failures: [] });
    const witnessRefs = JSON.parse(dispatchWithFallback.mock.calls[0][1].text.match(/"witness_refs":(\[[^\]]*\])/)[1]);
    expect(witnessRefs.sort()).toEqual(['payment:i-1', 'visit:v-1']);
  });

  test('a PAN-lookalike record id survives the prompt and the sensitive-output guard', async () => {
    dispatchWithFallback.mockReset().mockResolvedValue({ ok: true, json: { verdict: 'open', record_ref: null, quote: null } });
    // Roughly one UUID in 500 hides a Luhn-valid 13-19 digit run. This one
    // does, so the scrubber would rewrite the id it is asked to cite.
    const id = '35037702-7555-4718-8aa9-183d7088f227';
    expect(require('../utils/pan-scrub').scrubPans(id)).not.toBe(id);
    const witness = { ...record, id, ref: `estimate:${id}` };
    const evidence = { records: [witness], failures: [] };
    await verifySmsFulfillment(commitment, evidence);
    expect(dispatchWithFallback.mock.calls[0][1].text).toContain(`estimate:${id}`);
    expect(groundFulfillment({ ...verdict, record_ref: witness.ref }, evidence, commitment))
      .toMatchObject({ verdict: 'fulfilled', record_id: id });
    // The exemption is keyed on an id-shaped key AND an id-shaped value, so a
    // card number in free text is still scrubbed wherever it appears.
    const carded = { ...witness, text: 'Card 4242 4242 4242 4242', id: 'Card 4242 4242 4242 4242' };
    expect(stringifySmsEvidence(carded)).not.toContain('4242 4242 4242 4242');
  });

  test('fulfillment holds split SMS readbacks before exposing any body copy to the provider', async () => {
    dispatchWithFallback.mockClear();
    const records = [
      { id: 'second', ref: 'sms:second', type: 'sms', created_at: '2040-03-11T15:01:00Z',
        text: '4242 4242. Here is the answer.', message_body: '4242 4242. Here is the answer.' },
      { id: 'first', ref: 'sms:first', type: 'sms', created_at: '2040-03-11T15:00:00Z',
        text: 'My card is 4242 4242', message_body: 'My card is 4242 4242' },
    ];
    expect(await verifySmsFulfillment({ kind: 'other' }, { records, failures: [] }))
      .toMatchObject({ verdict: 'uncertain', reason: 'split_message_payment_data' });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('provider failures pause retries without permanently caching the outage', async () => {
    dispatchWithFallback.mockReset().mockResolvedValue({ ok: false });
    const now = new Date('2040-03-12T15:00:00Z');
    const evidence = { records: [{ ref: 'sms:1', type: 'sms', text: 'Still checking' }], failures: [] };
    const first = await verifySmsFulfillment(commitment, evidence, { now });
    const cached = { ...commitment, sms_context: { ...commitment.sms_context, fulfillment_check: first } };
    await verifySmsFulfillment(cached, evidence, { now: new Date(now.getTime() + 300000) });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    await verifySmsFulfillment(cached, evidence, { now: new Date(now.getTime() + 3600000) });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(2);
  });

  test('missing sources and unsupported quotes remain unverified', async () => {
    expect(groundFulfillment(verdict, { records: [record], failures: ['email'] }, commitment))
      .toMatchObject({ verdict: 'uncertain', reason: 'incomplete_sources' });
    expect(groundFulfillment({ ...verdict, quote: 'I answered the invoice dispute' }, { records: [record], failures: [] }, commitment))
      .toMatchObject({ verdict: 'uncertain', reason: 'ungrounded_witness' });
    await expect(verifySmsFulfillment(commitment, { records: [], failures: [] })).resolves.toMatchObject({ verdict: 'open' });
  });
});

describe('R2 payment evidence (owner ruling 2026-09-25): money landing (a paid invoice/payments row, a deposit) closes a settlement question', () => {
  // A payment question the extraction marked answerable by a payment (stamped at intake).
  const ctx = { property_id: null, source_at: '2040-03-10T15:00:00Z', money_answerable: true };
  const invoicePaid = { id: 'invoice-1', ref: 'payment:invoice-1', type: 'payment', payment_source: 'invoice',
    paid_at: '2040-03-11T15:00:00Z', text: 'Invoice Quarterly paid 2040-03-11' };
  const ledgerPaid = { id: 'pay-1', ref: 'payment:pay-1', type: 'payment', payment_source: 'ledger',
    created_at: '2040-03-11T15:00:00Z', text: 'Payment of $200.00 recorded 2040-03-11' };

  test('rule 2: whether a payment can answer an ask is the extraction\'s judgement, stamped at intake — never the ask\'s wording', () => {
    // Marked answerable: admissible whatever the wording, a refund mentioned beside the question included.
    for (const description of ['Did my payment go through?', "Don't refund it, did my payment go through?", 'What is the Zelle number?']) {
      expect(admissibleWitness(invoicePaid, { kind: 'other', description, sms_context: ctx })).toBe(true);
      expect(admissibleWitness(ledgerPaid, { kind: 'other', description, sms_context: ctx })).toBe(true);
    }
    // Not marked — money going back however it is worded, a card change, or no judgement recorded at all
    // (a row from before the stamp): never answered by a payment, even when it reads like a payment question.
    for (const [description, sms_context] of [['Can you reverse that charge?', { ...ctx, money_answerable: false }],
      ['Please update my card', { ...ctx, money_answerable: false }], ['Did my payment go through?', { ...ctx, money_answerable: false }],
      ['Did my payment go through?', { property_id: null, source_at: ctx.source_at }]]) {
      expect(admissibleWitness(invoicePaid, { kind: 'other', description, sms_context })).toBe(false);
    }
    // Payment evidence is `other`-only — a payment ask of another kind never admits it.
    expect(admissibleWitness(invoicePaid, { kind: 'callback', description: 'Call me about my payment', sms_context: ctx })).toBe(false);
    expect(admissibleWitness(invoicePaid, { kind: 'schedule_visit', description: 'Did my payment go through?', sms_context: ctx })).toBe(false);
  });

  test('rule 2: the extraction is asked to judge money going back, however worded, as never answered by a payment', () => {
    const { buildPrompt, SCHEMA } = require('../services/sms-operational-extractor');
    const obligationSchema = SCHEMA.properties.obligations.items;
    expect(obligationSchema.required).toContain('answered_by_payment');
    expect(obligationSchema.properties.answered_by_payment).toEqual({ type: 'boolean' });
    const prompt = buildPrompt({ message: source('Did my payment go through?') });
    expect(prompt).toContain('answered_by_payment is true only when the customer\'s own payment arriving');
    for (const phrase of ['a refund, reversal, void, reimbursement, chargeback', 'a change of how the customer pays', 'a receipt or other document']) {
      expect(prompt).toContain(phrase);
    }
  });

  test('rule 2: the completion check repeats the rule — a payment never answers money going back, however worded', async () => {
    dispatchWithFallback.mockReset().mockResolvedValue({ ok: true, json: { verdict: 'open', record_ref: null, quote: null } });
    await verifySmsFulfillment({ kind: 'other', description: 'Did my payment go through?', sms_context: ctx }, { records: [invoicePaid], failures: [] });
    expect(dispatchWithFallback.mock.calls.at(-1)[1].text)
      .toContain('it never answers money going back to the customer (a refund, reversal, reimbursement or chargeback, however worded)');
  });

  test('owner ruling 2026-09-28: the extraction no longer judges whether a reply could answer an ask', () => {
    const { buildPrompt, SCHEMA } = require('../services/sms-operational-extractor');
    const obligationSchema = SCHEMA.properties.obligations.items;
    expect(obligationSchema.required).not.toContain('answered_by_reply');
    expect(obligationSchema.properties).not.toHaveProperty('answered_by_reply');
    expect(buildPrompt({ message: source("What's the Zelle number?") })).not.toContain('answered_by_reply');
  });

  test('owner ruling 2026-09-28: a person\'s reply or call back closes a general ask without the model, whatever it says', async () => {
    dispatchWithFallback.mockReset().mockResolvedValue({ ok: true, json: { verdict: 'open', record_ref: null, quote: null } });
    const ask = { kind: 'other', description: 'I thought it was 125 a quarter', sms_context: { ...ctx, basis: 'request', money_answerable: false } };
    const reply = (id, created_at, text, extra = {}) => ({ id, ref: `sms:${id}`, type: 'sms', status: 'delivered',
      message_type: 'manual', operator_sent: true, created_at, text, ...extra });
    const first = reply('first', '2040-03-11T15:00:00Z', 'You got it');
    const later = reply('later', '2040-03-11T16:00:00Z', 'Following up');
    // The earliest response is the witness, with no quote to find in it.
    expect(await verifySmsFulfillment(ask, { records: [later, first], failures: [] })).toMatchObject({ verdict: 'fulfilled',
      record_type: 'sms', record_id: 'first', matched_at: '2040-03-11T15:00:00Z', quote: null, basis: 'person_reply' });
    expect(await verifySmsFulfillment(ask, { records: [reply('ok', '2040-03-11T15:00:00Z', 'Ok')], failures: [] }))
      .toMatchObject({ verdict: 'fulfilled', record_id: 'ok' });
    // A call back through the staff bridge, earlier than any text.
    const call = { id: 'call-1', ref: 'call:call-1', type: 'call', status: 'completed', duration_seconds: 300, source: 'tech-click',
      v2_extraction_status: 'valid', is_voicemail: 'false', created_at: '2040-03-11T14:00:00Z', text: '' };
    expect(await verifySmsFulfillment(ask, { records: [first, call], failures: [] }))
      .toMatchObject({ verdict: 'fulfilled', record_type: 'call', record_id: 'call-1' });
    // A failed or truncated channel cannot hide a response that was loaded.
    expect(await verifySmsFulfillment(ask, { records: [first], failures: ['visit', 'sms_truncated'] }))
      .toMatchObject({ verdict: 'fulfilled', record_id: 'first' });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    // Inside an open window a message waits for the deadline (R1).
    expect(await verifySmsFulfillment(ask, { records: [first], failures: [] }, { eventOnly: true })).toMatchObject({ verdict: 'open' });
    // A text with no person's mark is never the shortcut; the model sees it as context.
    await verifySmsFulfillment(ask, { records: [reply('bare', '2040-03-11T15:00:00Z', 'You got it', { operator_sent: false })], failures: [] });
    // Only a general ask takes the shortcut: a callback's call stays the model's to judge.
    await verifySmsFulfillment({ ...ask, kind: 'callback' }, { records: [call], failures: [] });
    // A promise Waves made: a text a PERSON wrote after it closes it without the
    // model (owner 2026-10-01; a call back or an automated notice stays the
    // model's to judge), and a text with no person's mark is the model's.
    const promise = { ...ask, description: "we'll get the prep guide today", sms_context: { ...ask.sms_context, basis: 'promise' } };
    expect(await verifySmsFulfillment(promise, { records: [reply('thanks', '2040-03-11T15:00:00Z', 'Thanks!')], failures: [] }))
      .toMatchObject({ verdict: 'fulfilled', record_id: 'thanks', basis: 'person_text_after_promise' });
    expect(await verifySmsFulfillment(promise, { records: [call], failures: [] })).toMatchObject({ verdict: 'open' });
    expect(await verifySmsFulfillment(promise, { records: [reply('bare2', '2040-03-11T15:00:00Z', 'Thanks!', { operator_sent: false })], failures: [] }))
      .toMatchObject({ verdict: 'open' });
    // The check is told a promise is kept only by doing it, on the day it named.
    expect(dispatchWithFallback.mock.calls.at(-1)[1].text).toContain('A promise Waves made (sms_context.basis promise) is fulfilled only by a record of Waves doing what it promised');
    // No basis recorded (intake always stamps one): it fails toward the model, never the shortcut.
    const { basis: _basis, ...noBasis } = ask.sms_context;
    await verifySmsFulfillment({ ...ask, sms_context: noBasis }, { records: [first], failures: [] });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(6);
  });

  test('rule 6: a property-scoped ask refuses only a payment tied to another property; an unscoped ask admits any of the customer\'s own payments', () => {
    const scopedAsk = { kind: 'other', description: 'Did you receive my payment?', sms_context: { ...ctx, property_id: 'home' } };
    const unscopedAsk = { kind: 'other', description: 'Did you receive my payment?', sms_context: ctx };
    const invoiceAtHome = { ...invoicePaid, property_id: 'home' };
    const invoiceElsewhere = { ...invoicePaid, property_id: 'rental' };
    const invoiceUnlinked = { ...invoicePaid, property_id: null };
    expect(admissibleWitness(invoiceAtHome, scopedAsk)).toBe(true);
    expect(admissibleWitness(invoiceElsewhere, scopedAsk)).toBe(false);
    // A payment nothing ties to any property still counts for a scoped ask
    // (owner ruling 2026-09-27): only another property's payment is refused.
    expect(admissibleWitness(invoiceUnlinked, scopedAsk)).toBe(true);
    expect(admissibleWitness(ledgerPaid, scopedAsk)).toBe(true);
    // Unscoped: every leg, linked or not, is admitted.
    expect(admissibleWitness(invoiceUnlinked, unscopedAsk)).toBe(true);
    expect(admissibleWitness(ledgerPaid, unscopedAsk)).toBe(true);
  });

  test('rule 9 / Codex round 1 P1-B: a ledger record carries only amount, date and the structured method — never a free-text key', async () => {
    dispatchWithFallback.mockReset().mockResolvedValue({ ok: true, json: { verdict: 'open', record_ref: null, quote: null } });
    // The real query (loadSmsFulfillmentEvidence) never selects
    // payments.description at all any more; this is the shape it actually
    // produces — a controlled `method` enum, no free-text field whatsoever.
    const ledger = { ...ledgerPaid, method: 'zelle', text: 'Payment of $200.00 recorded 2040-03-11 (zelle)' };
    const ask = { kind: 'other', description: 'What is the Zelle number?', sms_context: ctx };
    await verifySmsFulfillment(ask, { records: [ledger], failures: [] });
    const prompt = dispatchWithFallback.mock.calls.at(-1)[1].text;
    expect(prompt).toContain('(zelle)');
    const record = JSON.parse(prompt.slice(prompt.indexOf('{"obligation"'))).records[0];
    expect(record).not.toHaveProperty('description');
    expect(prompt).toContain('"witness_refs":["payment:pay-1"]');
  });

  test('rule 1: admissibility alone never closes the row — grounding still requires the model to cite and quote the payment witness', () => {
    const paymentOther = { kind: 'other', description: 'What is the Zelle number?', sms_context: ctx };
    const evidence = { records: [invoicePaid], failures: [] };
    // The model said open: no auto-fulfill even though a payment witness exists.
    expect(groundFulfillment({ verdict: 'open', record_ref: null, quote: null }, evidence, paymentOther)).toEqual({ verdict: 'open' });
    // The model cited it with a grounded quote: fulfilled, carrying which table to lock (rule 8).
    expect(groundFulfillment({ verdict: 'fulfilled', record_ref: 'payment:invoice-1', quote: 'Invoice Quarterly paid' }, evidence, paymentOther))
      .toMatchObject({ verdict: 'fulfilled', record_type: 'payment', record_id: 'invoice-1', payment_source: 'invoice' });
  });
});

describe('activation and intake', () => {
  afterEach(() => {
    delete process.env.GATE_SMS_OPERATIONAL_ACTIONS;
    delete process.env.GATE_SMS_OPERATIONAL_ACTIONS_SINCE;
    delete process.env.GATE_SMS_COMMITMENT_FOLLOWUP;
  });

  test('gate off and missing activation epoch perform no database work', async () => {
    const conn = jest.fn();
    expect(await runSmsOperationalActions({ conn })).toEqual({ skipped: 'gate_off' });
    process.env.GATE_SMS_OPERATIONAL_ACTIONS = 'true';
    expect(await runSmsOperationalActions({ conn })).toEqual({ skipped: 'activation_time_required' });
    expect(conn).not.toHaveBeenCalled();
  });

  test('keeps mixed-content reschedule replies eligible for profile capture', () => {
    expect(eligibleMessage({ ...source('Yes. The controller is outside.'), message_type: 'reschedule_reply' })).toBe(true);
  });

  test('profile-only intake skips even human outbound messages before extraction', () => {
    delete process.env.GATE_SMS_COMMITMENT_FOLLOWUP;
    expect(eligibleMessage({ ...source('The controller is outside.', 'outbound'),
      from_phone: numbers.locations.parrish.number, message_type: 'manual', status: 'delivered' })).toBe(false);
  });

  test.each(['manual', 'ai_approved', 'ai_revised'])('outbound %s needs persisted staff attribution', (message_type) => {
    process.env.GATE_SMS_OPERATIONAL_ACTIONS = 'true';
    process.env.GATE_SMS_COMMITMENT_FOLLOWUP = 'true';
    const message = { ...source("We'll give you a call shortly.", 'outbound'),
      from_phone: numbers.locations.parrish.number, message_type, status: 'delivered' };
    expect(eligibleMessage(message)).toBe(false);
    expect(eligibleMessage({ ...message, admin_user_id: '00000000-0000-4000-8000-000000000104' })).toBe(true);
  });

  test.each(['failed', 'undelivered'])('only captured promises retain eligibility after %s', (status) => {
    process.env.GATE_SMS_OPERATIONAL_ACTIONS = 'true';
    process.env.GATE_SMS_COMMITMENT_FOLLOWUP = 'true';
    const message = { ...source("I'll send the estimate", 'outbound'),
      from_phone: numbers.locations.parrish.number, to_phone: '+12025550101', message_type: 'manual', status, admin_user_id: '00000000-0000-4000-8000-000000000104' };
    expect(eligibleMessage(message)).toBe(false);
    expect(eligibleMessage(message, { captured: true })).toBe(true);
    expect(eligibleMessage({ ...message, message_type: 'confirmation' }, { captured: true })).toBe(false);
  });

  test('loud tapbacks stored as ordinary inbound rows never reach extraction', () => {
    expect(eligibleMessage({ ...source('Disliked “Park in the driveway”'), message_type: 'inbound' })).toBe(false);
    expect(eligibleMessage({ ...source('Reacted ❤️ to “Park in the driveway”'), message_type: 'inbound' })).toBe(false);
    expect(eligibleMessage({ ...source('Park in the driveway'), message_type: 'inbound' })).toBe(true);
  });

  test('excludes automated outbound messages, reactions and the AI number', () => {
    expect(eligibleMessage(source('Please send the estimate'))).toBe(true);
    expect(eligibleMessage({ ...source('Reminder', 'outbound'), from_phone: numbers.locations.parrish.number,
      message_type: 'appointment_reminder', status: 'delivered' })).toBe(false);
    expect(eligibleMessage({ ...source('Liked a message'), message_type: 'sms_reaction' })).toBe(false);
    expect(eligibleMessage({ ...source('Please send the estimate'), to_phone: numbers.tollFree.number })).toBe(false);
  });
});

// PR #5499: lane (additive) narrows BOTH channel subqueries before the bounded
// union, so one rendered population cannot crowd the other out of the page.
describe('listSmsCommitments lane option', () => {
  const { listSmsCommitments } = require('../services/sms-operational-actions');
  const fakeConn = () => {
    const parts = [];
    const builder = () => {
      const ops = [];
      const b = new Proxy({}, { get: (_t, prop) => (...args) => { ops.push([prop, args]); if (prop === 'modify') args[0](b); return b; } });
      parts.push(ops);
      return b;
    };
    const conn = (table) => builder(table);
    conn.raw = (sql) => ({ raw: sql });
    const tail = { orderByRaw: () => tail, limit: () => tail, offset: async () => [] };
    conn.unionAll = (list) => { conn.unioned = list.length; return tail; };
    conn.parts = parts;
    return conn;
  };
  const rawsOf = (ops) => ops.filter(([p]) => p === 'whereRaw').map(([, a]) => a[0]);

  test("'request' and 'promise' filter both the sms and the email subquery; no lane leaves them unfiltered", async () => {
    const req = fakeConn();
    await listSmsCommitments(req, { customerId: 'c1', lane: 'request' });
    expect(req.parts).toHaveLength(2);
    for (const ops of req.parts) expect(rawsOf(ops)).toContain("cc.sms_context->>'basis' = 'request'");

    const pro = fakeConn();
    await listSmsCommitments(pro, { customerId: 'c1', lane: 'promise' });
    for (const ops of pro.parts) {
      expect(ops).toContainEqual(['where', ['cc.party', 'waves']]);
      expect(rawsOf(ops)).toContain("COALESCE(cc.sms_context->>'basis', '') <> 'request'");
    }

    const none = fakeConn();
    await listSmsCommitments(none, { customerId: 'c1' });
    for (const ops of none.parts) expect(rawsOf(ops).some((sql) => /basis/.test(sql))).toBe(false);
  });
});

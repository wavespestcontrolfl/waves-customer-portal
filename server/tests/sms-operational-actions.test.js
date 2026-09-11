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

const { groundExtraction, extractSmsOperations, buildPrompt, stringifySmsEvidence } = require('../services/sms-operational-extractor');
const { eligibleMessage, factVerdict, runSmsOperationalActions } = require('../services/sms-operational-actions');
const { groundFulfillment, admissibleWitness, verifySmsFulfillment } = require('../services/sms-commitment-fulfillment');
const { dispatchWithFallback } = require('../services/llm/call');
const numbers = require('../config/twilio-numbers');
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000101';
const PROPERTY_ID = '00000000-0000-4000-8000-000000000102';
const properties = [{ id: PROPERTY_ID }];
const source = (message_body, direction = 'inbound') => ({
  id: '00000000-0000-4000-8000-000000000103', customer_id: CUSTOMER_ID, message_body, direction,
  created_at: '2040-03-10T15:00:00Z', from_phone: '+12025550101', to_phone: numbers.locations.parrish.number,
});
const obligation = (quote, extra = {}) => ({
  party: 'waves', kind: 'send_estimate', description: quote, quote,
  basis: 'request', property_id: PROPERTY_ID, due_text: null, due_at: null, ...extra,
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
      obligation("I'll send the estimate", { basis: 'promise' }),
    ], [fact()]), { message, properties });
    expect(result.obligations).toHaveLength(1);
    expect(result.facts).toEqual([]);
  });

  test('a subjectless "Will …" staff declaration is a promise, not a question', () => {
    const message = source('Will call you tomorrow at 9am', 'outbound');
    const result = groundExtraction(extracted([obligation('call you tomorrow at 9am', {
      basis: 'promise', kind: 'callback', due_text: 'tomorrow at 9am', due_at: '2040-03-11T09:00:00-04:00',
    })]), { message, properties });
    expect(result.obligations).toHaveLength(1);
    expect(result.obligations[0]).toMatchObject({ due_at: '2040-03-11T13:00:00.000Z', timing_unverified: false });
  });

  test.each(['Should I call you tomorrow at 9am?', 'Should I call you tomorrow at 9am', 'Want me to call you tomorrow at 9am',
    'Need us to call you tomorrow at 9am', 'Will we call you tomorrow at 9am'])('an outbound question cannot be recorded as a promise: %s', (body) => {
    const message = source(body, 'outbound');
    const result = groundExtraction(extracted([obligation('call you tomorrow at 9am', {
      basis: 'promise', kind: 'callback', due_text: 'tomorrow at 9am', due_at: '2040-03-11T09:00:00-04:00',
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
      basis: 'promise', kind: 'callback', due_text: 'tomorrow', due_at: '2040-03-11T09:00:00-04:00',
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

  test.each([['Please send the estimate by September 10 at 3', 'send_estimate'], ['Please call before 5 tomorrow', 'callback']])(
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

  test.each([['Please call me at 941-555-0100', 'callback'], ['Please send 2 estimates', 'send_estimate'], ['Please send 2 a month of the estimates', 'send_estimate']])(
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

  test('provider acceptance or a SENT label cannot close an answer before delivery succeeds', () => {
    const answer = { kind: 'other' };
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
    const request = { kind: 'other', evidence: [{ quote: 'Send the answer to desired@example.invalid' }] };
    const email = { type: 'email_delivery', status: 'delivered', sent_at: '2040-03-11T15:00:00Z',
      recipient_email_snapshot: 'old@example.invalid' };
    expect(admissibleWitness(email, request)).toBe(false);
    expect(admissibleWitness({ ...email, recipient_email_snapshot: 'DESIRED@example.invalid' }, request)).toBe(true);
    expect(admissibleWitness(email, { kind: 'other', evidence: [{ quote: 'Send the answer to my manager' }] })).toBe(false);
    expect(admissibleWitness(email, { ...request, evidence: [{ quote: 'Send to old@example.invalid and desired@example.invalid' }] })).toBe(false);
    expect(admissibleWitness({ type: 'sms', status: 'delivered', message_type: 'manual' }, request)).toBe(false);
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

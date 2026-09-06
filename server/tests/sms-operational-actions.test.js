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

const { groundExtraction, extractSmsOperations, buildPrompt } = require('../services/sms-operational-extractor');
const { eligibleMessage, factVerdict, runSmsOperationalActions } = require('../services/sms-operational-actions');
const { dispatchWithFallback } = require('../services/llm/call');
const numbers = require('../config/twilio-numbers');
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000101';
const PROPERTY_ID = '00000000-0000-4000-8000-000000000102';
const properties = [{ id: PROPERTY_ID }];
const source = (message_body, direction = 'inbound') => ({
  id: '00000000-0000-4000-8000-000000000103', customer_id: CUSTOMER_ID, message_body, direction,
  created_at: '2040-03-10T15:00:00Z', from_phone: '+12025550101', to_phone: numbers.locations.parrish.number,
});
const fact = (extra = {}) => ({ field: 'irrigation_controller_location', value: 'The controller is on the side of the house',
  quote: 'The controller is on the side of the house', property_id: PROPERTY_ID, duration: 'durable', ...extra });
const extracted = (unused = [], facts = []) => ({ facts });

describe('SMS operational evidence and ownership', () => {
  test('outbound statements cannot fill a customer profile', () => {
    const message = source(fact().quote, 'outbound');
    expect(groundExtraction(extracted([], [fact()]), { message, properties }).facts).toEqual([]);
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

  test('overlong sources create review exceptions without a provider call', async () => {
    dispatchWithFallback.mockClear();
    expect(await extractSmsOperations({ message: source('Keep the pets inside. '.repeat(30)), properties }))
      .toMatchObject({ facts: [], dropped: 1 });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
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
});

describe('profile safeguards independent of model labels', () => {
  test.each([
    'For tomorrow only, leave the side gate open.',
    'The controller is in the garage until Monday.',
    'Temporarily use the side entrance.',
    'For this visit please park outside.',
    'While on vacation, leave the package outside.',
  ])('holds a durable-labelled temporary instruction: %s', (quote) => {
    expect(factVerdict(fact({ field: 'access_notes', quote, value: quote }), {
      properties, senderIsPrimary: true,
    })).toBe('temporary_instruction');
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

describe('activation and intake', () => {
  afterEach(() => { delete process.env.GATE_SMS_OPERATIONAL_ACTIONS; delete process.env.GATE_SMS_OPERATIONAL_ACTIONS_SINCE; });
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
  test('excludes automated outbound messages, reactions and the AI number', () => {
    expect(eligibleMessage(source('Please send the estimate'))).toBe(true);
    expect(eligibleMessage({ ...source('Reminder', 'outbound'), from_phone: numbers.locations.parrish.number,
      message_type: 'appointment_reminder', status: 'delivered' })).toBe(false);
    expect(eligibleMessage({ ...source('Liked a message'), message_type: 'sms_reaction' })).toBe(false);
    expect(eligibleMessage({ ...source('Please send the estimate'), to_phone: numbers.tollFree.number })).toBe(false);
  });
});

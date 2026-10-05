'use strict';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn((name, work) => work()) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));

const { groundExtraction, buildPrompt } = require('../services/sms-operational-extractor');
const { factVerdict } = require('../services/sms-operational-actions');

const PROPERTY_ID = '00000000-0000-4000-8000-000000000102';
const properties = [{ id: PROPERTY_ID, address_line1: '4821 Example Palm Way', zip: '34219' }];
const source = (message_body) => ({
  id: '00000000-0000-4000-8000-000000000103', customer_id: '00000000-0000-4000-8000-000000000101', message_body,
  direction: 'inbound', created_at: '2040-03-10T15:00:00Z', from_phone: '+12025550101', to_phone: '+12025550102',
});
const codeFact = (field, quote, value) => ({ field, value, quote, property_id: PROPERTY_ID, duration: 'durable' });
const ground = (item) => groundExtraction({ obligations: [], facts: [item], additional_properties: [] },
  { message: source(item.quote), properties });
const verdict = (item) => factVerdict(item, { properties, senderIsPrimary: true, messageBody: item.quote });

describe('access codes in the client\'s own wording (GATE_ACCESS_CODE_CAPTURE)', () => {
  const saved = process.env.GATE_ACCESS_CODE_CAPTURE;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_ACCESS_CODE_CAPTURE; else process.env.GATE_ACCESS_CODE_CAPTURE = saved;
  });

  const natural = [
    ['neighborhood_gate_code', 'Gate code is 5550', '5550'],
    ['neighborhood_gate_code', 'Gate code for Example Creek is below.\n\n#55501', '#55501'],
    ['neighborhood_gate_code', 'Hello our gate code for the example is #5550.  I forgot to mention that.', '#5550'],
    ['property_gate_code', 'I have a gate code for the left gate to get to the backyard: 5550', '5550'],
    ['lockbox_code', 'The key box on the door opens with 5550', '5550'],
    ['garage_code', 'Garage keypad 5550#', '5550#'],
  ];

  test.each(natural)('gate off keeps the strict sentence form: %s "%s"', (field, quote, value) => {
    delete process.env.GATE_ACCESS_CODE_CAPTURE;
    const item = codeFact(field, quote, value);
    expect(ground(item).facts).toEqual([]);
    expect(verdict(item)).toBe('code_uncertain');
  });

  test.each(natural)('gate on saves %s from "%s"', (field, quote, value) => {
    process.env.GATE_ACCESS_CODE_CAPTURE = 'true';
    const item = codeFact(field, quote, value);
    expect(ground(item)).toEqual({ obligations: [], facts: [item], additional_properties: [], dropped: 0 });
    expect(verdict(item)).toBe('apply');
  });

  test.each([
    ['a kind the message does not name', 'property_gate_code', 'Gate code is 5550', '5550'],
    ['a plain gate filed as the lockbox', 'lockbox_code', 'Gate code is 5550', '5550'],
    ['two kinds in one message', 'neighborhood_gate_code', 'Gate and garage code is 5550', '5550'],
    ['a community gate and a side gate together', 'property_gate_code', 'Community gate and side gate code is 5550', '5550'],
    ['no kind word at all', 'neighborhood_gate_code', 'Code to get inside is 55501', '55501'],
    ['a second number in the message', 'neighborhood_gate_code', 'Gate code 5550, call 202-555-0101 if it fails', '5550'],
    ['the house number', 'neighborhood_gate_code', 'Gate code is 4821', '4821'],
    ['the ZIP', 'neighborhood_gate_code', 'Gate code is 34219', '34219'],
    ['a hedge', 'neighborhood_gate_code', 'I think the gate code is 5550', '5550'],
    ['two alternatives', 'neighborhood_gate_code', 'Gate code is 5550 or 5551', '5550'],
    ['digits the client did not write', 'neighborhood_gate_code', 'Gate code is 5550', '5551'],
    ['a value with words', 'neighborhood_gate_code', 'Gate code is 5550 then star', '5550 then star'],
    ['a question', 'neighborhood_gate_code', 'Is the gate code 5550?', '5550'],
    ['a negated code', 'neighborhood_gate_code', 'Gate code is not 5550', '5550'],
    ['a code that stopped working', 'neighborhood_gate_code', 'Gate code 5550 no longer works', '5550'],
    ['a code reported broken in a later sentence', 'neighborhood_gate_code', 'Gate code is 5550. It doesn\'t work on Sundays.', '5550'],
    ['a value without the symbol the client wrote', 'neighborhood_gate_code', 'Gate code is #5550', '5550'],
    ['a value without the trailing symbol', 'garage_code', 'Garage keypad 5550#', '5550'],
    ['part of a lettered credential', 'neighborhood_gate_code', 'Gate code is A5550', '5550'],
    ['part of a hyphenated credential', 'neighborhood_gate_code', 'Gate code is 5550-12', '5550'],
    ['part of a spaced credential', 'neighborhood_gate_code', 'Gate code is 5550 12', '5550'],
    ['a code with a key step after it', 'neighborhood_gate_code', 'Gate code is 5550 then press 2', '5550'],
    ['a code with a spelled key after it', 'neighborhood_gate_code', 'Gate code is 5550 followed by pound', '5550'],
    ['a code with a spelled key before it', 'neighborhood_gate_code', 'Gate code is star 5550', '5550'],
    ['a code with more words in its sentence', 'neighborhood_gate_code', 'Gate code is 5550 at the second keypad', '5550'],
    ['a negation on the line before the code', 'neighborhood_gate_code', 'Gate code is not\n5550', '5550'],
    ['a negation in another sentence', 'neighborhood_gate_code', 'Sorry I did not answer. Gate code is 5550', '5550'],
    ['a short number on the next line', 'neighborhood_gate_code', 'Gate code is 5550\n12', '5550'],
    ['a short number anywhere else', 'neighborhood_gate_code', 'Gate code for Example Creek is 5 digits.\n\n#55501', '#55501'],
    ['a continuation on the next line', 'neighborhood_gate_code', 'Gate code is 5550\nthen the bell', '5550'],
    ['a key symbol standing before the code', 'neighborhood_gate_code', 'Gate code is # 5550', '5550'],
    ['a key symbol standing after the code', 'neighborhood_gate_code', 'Gate code is 5550\n#', '5550'],
    ['a star standing before the code', 'neighborhood_gate_code', 'Gate code is * 5550', '5550'],
    ['a modal hedge (may)', 'neighborhood_gate_code', 'Gate code may be 5550', '5550'],
    ['a modal hedge (could)', 'neighborhood_gate_code', 'Gate code could be 5550', '5550'],
    ['a past code', 'neighborhood_gate_code', 'Gate code was 5550', '5550'],
  ])('gate on still refuses %s', (_name, field, quote, value) => {
    process.env.GATE_ACCESS_CODE_CAPTURE = 'true';
    const item = codeFact(field, quote, value);
    expect(ground(item).facts).toEqual([]);
    expect(verdict(item)).not.toBe('apply');
  });

  test('the strict sentence form still saves with the gate on', () => {
    process.env.GATE_ACCESS_CODE_CAPTURE = 'true';
    const item = codeFact('lockbox_code', 'Lockbox code is A5-B', 'A5-B');
    expect(ground(item).facts).toEqual([item]);
  });

  test('the prompt names the plain gate rule only with the gate on', () => {
    const context = { message: source('Gate code is 5550'), properties };
    delete process.env.GATE_ACCESS_CODE_CAPTURE;
    expect(buildPrompt(context)).not.toContain('A plain "gate code"');
    process.env.GATE_ACCESS_CODE_CAPTURE = 'true';
    expect(buildPrompt(context)).toContain('A plain "gate code" with no side, back or yard word is the neighborhood gate');
  });
});

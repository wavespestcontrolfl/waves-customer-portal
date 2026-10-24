'use strict';

// Pure checks (no database) for the calls half of the access codes net: the
// spoken-number normalizer, the call keyword net, the deterministic verifier
// (customer's own words only; card, sign-in and address digits refused) and the
// call prompt. All names, addresses, phones and codes are synthetic.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn((name, work) => work()) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));

const access = require('../services/access-code-capture');
const { dispatchWithFallback } = require('../services/llm/call');

const { spokenNormalize, verifyCallItems, callFlagsAccess, buildCallPrompt, readCallAccessCodes, callAsMessage, CALL_VERSION } = access;
const OUR = '+19412972817';
const CUSTOMER = '+19415550142';

const call = (transcript, { direction = 'outbound', customerId = null } = {}) => callAsMessage({
  id: 'c1', customer_id: customerId, direction, from_phone: direction === 'outbound' ? OUR : CUSTOMER,
  to_phone: direction === 'outbound' ? CUSTOMER : OUR, transcription: transcript, created_at: new Date('2040-03-10T15:00:00Z'),
}, customerId);
const item = (extra = {}) => ({ kind: 'neighborhood_gate', code: '#3394', instructions: null, life: 'standing', quote: '', ...extra });
const verify = (transcript, items, opts = {}, ctx = {}) => verifyCallItems(items, call(transcript, opts), ctx);

// The owner's real case (2026-10-23), with synthetic names: a 19-second outbound call.
const BOBBY_LABELS = [
  ["Agent: Hey, Bobby, it's Adam with Waves. I'm at your gate.\nCaller: Hi, yeah, it's pound, three three nine four.\nAgent: Three three nine four. Awesome"],
  // outbound labels can be swapped: the technician is "Caller"
  ["Caller: Hey, Bobby, it's Adam with Waves. I'm at your gate.\nAgent: Hi, yeah, it's pound, three three nine four.\nCaller: Three three nine four. Awesome"],
];

describe('spokenNormalize', () => {
  test.each([
    ["it's pound, three three nine four.", "it's #3394."],
    ['three-three-nine-four pound', '3394#'],
    ['three three nine four pound sign', '3394#'],
    ['pound sign three three nine four, thanks', '#3394, thanks'],
    ['star 7 7 1 2', '*7712'],
    ['hash four five six', '#456'],
    ['double five three nine', '5539'],
    ['triple seven four', '7774'],
    ['two oh four five', '2045'],
    ['it is four four five oh.', 'it is 4450.'],
    ['one two three four', '1234'],
    ['3 3 9 4', '3394'],
    ['niner niner seven', '997'],
  ])('%s -> %s', (spoken, digits) => {
    expect(spokenNormalize(spoken).text).toBe(digits);
  });

  test('"oh" is zero only inside a digit run; elsewhere it is a word', () => {
    expect(spokenNormalize('oh, three three nine four').text).toBe('oh, 3394');
    expect(spokenNormalize('oh I see, it is 3394').text).toBe('oh I see, it is 3394');
    expect(spokenNormalize('three three oh nine').text).toBe('3309');
  });

  test('a run never crosses the end of a clause or a turn', () => {
    expect(spokenNormalize('it is 3394. 12 people').runs).toEqual(['3394', '12']);
    expect(spokenNormalize('one two\nthree four').runs).toEqual(['12', '34']);
    expect(spokenNormalize('I have 2 dogs and 3 cats').text).toBe('I have 2 dogs and 3 cats');
  });

  test('a symbol word alone is a word; a dashed number stays whole', () => {
    expect(spokenNormalize('five star service, pound the cake').text).toContain('service');
    expect(spokenNormalize('call 941-555-0100 please').text).toBe('call 941-555-0100 please');
    expect(spokenNormalize('Waves Pest Control').runs).toEqual([]);
  });
});

describe('callFlagsAccess', () => {
  test.each(BOBBY_LABELS)('the owner case flags', (text) => {
    expect(callFlagsAccess(text)).toBe(true);
  });
  test('a technician at the entrance and spoken digits flag; a call about nothing does not', () => {
    expect(callFlagsAccess("Agent: We're outside the community.\nCaller: Sure, one two three four.")).toBe(true);
    expect(callFlagsAccess("Agent: We're outside the community.\nCaller: Sure, hold on.")).toBe(false);
    expect(callFlagsAccess('Agent: Thanks for calling.\nCaller: Can you come Tuesday at four?')).toBe(false);
    expect(callFlagsAccess('')).toBe(false);
  });
});

describe('verifyCallItems', () => {
  describe.each(BOBBY_LABELS)('the owner case', (transcript) => {
    test('a code spoken as "pound, three three nine four" verifies against #3394', () => {
      const out = verify(transcript, [item({ quote: "Hi, yeah, it's pound, three three nine four." })]);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ kind: 'neighborhood_gate', code: '#3394', life: 'standing' });
      expect(out[0].value_hash).toBe(access.valueHash('#3394', null));
    });
    test('a shorter quote of the customer words verifies; the staff read-back does not', () => {
      expect(verify(transcript, [item({ quote: "it's pound, three three nine four." })])).toHaveLength(1);
      expect(verify(transcript, [item({ quote: 'Three three nine four. Awesome' })])).toEqual([]);
    });
    test('the code is judged against the customer\'s whole turn: the bare digits of a "pound" code are refused, even from a cropped quote', () => {
      // staff reads back the bare digits, but a staff word never satisfies the check
      expect(verify(transcript, [item({ code: '3394', quote: 'three three nine four' })])).toEqual([]);
      expect(verify(transcript, [item({ code: '3394', quote: "Hi, yeah, it's pound, three three nine four." })])).toEqual([]);
      // the complete code, #3394, is kept from the same cropped quote
      expect(verify(transcript, [item({ code: '#3394', quote: 'three three nine four' })])).toHaveLength(1);
      expect(verify(transcript, [item({ code: '#3394', quote: 'three three nine four' })])[0].code).toBe('#3394');
    });
    test('the code without its symbol, or a different code, is refused', () => {
      expect(verify(transcript, [item({ code: '3394', quote: "it's pound, three three nine four." })])).toEqual([]);
      expect(verify(transcript, [item({ code: '#3395', quote: "it's pound, three three nine four." })])).toEqual([]);
    });
  });

  describe('a spoken symbol beside written digits', () => {
    test.each([
      ['Caller: The gate code is pound 3394.', 'The gate code is pound 3394.', '#3394'],
      ['Caller: Gate code 3394 pound.', 'Gate code 3394 pound.', '3394#'],
      ['Caller: The gate code is star 1234.', 'The gate code is star 1234.', '*1234'],
    ])('%s keeps the symbol: the bare digits are refused', (transcript, quote, full) => {
      expect(verify(transcript, [item({ code: full.replace(/[#*]/g, ''), quote })])).toEqual([]);
      expect(verify(transcript, [item({ code: full, quote })])).toHaveLength(1);
    });
    test('written digits with no symbol still verify', () => {
      expect(verify('Caller: The gate code is 3394.', [item({ code: '3394', quote: 'The gate code is 3394.' })])).toHaveLength(1);
    });
  });

  describe('who is staff on an outbound call', () => {
    const TRANSCRIPT = "Agent: Hi, I'm at the gate.\nCaller: Are you from Waves? The gate code is four eight two one.\nAgent: Four eight two one, thanks.";
    test('a customer who asks "Are you from Waves?" is still the customer', () => {
      const out = verify(TRANSCRIPT, [item({ code: '4821', quote: 'The gate code is four eight two one.' })]);
      expect(out).toHaveLength(1);
      expect(out[0].code).toBe('4821');
    });
    test.each([
      ["Caller: Hello, it's Adam with Waves.\nAgent: Pound, four eight two one."],
      ['Caller: This is Adam from Waves.\nAgent: Pound, four eight two one.'],
      ["Caller: Hi, I'm from Waves, at your gate.\nAgent: Pound, four eight two one."],
      ['Caller: Adam from Waves here.\nAgent: Pound, four eight two one.'],
      ['Caller: Waves Pest Control, this is Adam.\nAgent: Pound, four eight two one.'],
    ])('a real self-introduction names the staff turn: %s', (transcript) => {
      expect(verify(transcript, [item({ code: '#4821', quote: 'Pound, four eight two one.' })])).toHaveLength(1);
      // and the introducer's own turn is never the source
      const staffSays = transcript.replace('Pound, four eight two one.', 'Thanks.') + '\nCaller: The gate code is pound four eight two one.';
      expect(verify(staffSays, [item({ code: '#4821', quote: 'The gate code is pound four eight two one.' })])).toEqual([]);
    });
    test('a mention of Waves is not an introduction', () => {
      for (const line of ['Are you from Waves?', 'Is this with Waves?', 'I called Waves Pest Control yesterday.', 'You are from Waves, right?']) {
        const transcript = `Agent: Hi, I'm at the gate.\nCaller: ${line} The gate code is four eight two one.`;
        expect(verify(transcript, [item({ code: '4821', quote: 'The gate code is four eight two one.' })])).toHaveLength(1);
      }
    });
  });

  test('a quote that is not in the call, or runs across two turns, is refused', () => {
    const [transcript] = BOBBY_LABELS[0];
    expect(verify(transcript, [item({ quote: "it's pound, three three nine five" })])).toEqual([]);
    expect(verify(transcript, [item({ quote: "I'm at your gate. Caller: Hi, yeah, it's pound, three three nine four." })])).toEqual([]);
  });

  test('a code only staff says is refused, and a customer echo of staff words is a read-back', () => {
    const inbound = "Agent: I have your gate code as four eight two one.\nCaller: Yes, that's right.";
    expect(verify(inbound, [item({ code: '4821', quote: 'I have your gate code as four eight two one.' })], { direction: 'inbound' })).toEqual([]);
    const echo = 'Agent: Is your gate code four eight two one?\nCaller: Yes, four eight two one.';
    expect(verify(echo, [item({ code: '4821', quote: 'Yes, four eight two one.' })], { direction: 'inbound' })).toEqual([]);
    // the customer says it first: kept
    const first = 'Caller: The gate code is four eight two one.\nAgent: Four eight two one, got it.';
    expect(verify(first, [item({ code: '4821', quote: 'The gate code is four eight two one.' })], { direction: 'inbound' })).toHaveLength(1);
  });

  test('labels that do not name staff: a "right?" read-back answered "yes" is staff', () => {
    const transcript = 'Speaker 1: So the gate code is four eight two one, right?\nSpeaker 2: Yes.';
    expect(verify(transcript, [item({ code: '4821', quote: 'So the gate code is four eight two one, right?' })], { direction: 'inbound' })).toEqual([]);
    const stated = 'Speaker 1: What is the gate code?\nSpeaker 2: It is four eight two one.';
    expect(verify(stated, [item({ code: '4821', quote: 'It is four eight two one.' })], { direction: 'inbound' })).toHaveLength(1);
  });

  test('an unlabeled voicemail is one customer turn', () => {
    const voicemail = 'Hi, this is Sample Owner, the gate code for the neighborhood is star five five one two. Thanks.';
    const out = verify(voicemail, [item({ code: '*5512', quote: 'the gate code for the neighborhood is star five five one two.' })], { direction: 'inbound' });
    expect(out).toHaveLength(1);
  });

  describe('card, security and sign-in codes', () => {
    test('a card number read on the call refuses everything on it', () => {
      const transcript = "Agent: What's the card number?\nCaller: four one one one, one one one one, one one one one, one one one one.\n"
        + 'Caller: And the gate code is pound three three nine four.';
      expect(verify(transcript, [item({ quote: 'And the gate code is pound three three nine four.' })], { direction: 'inbound' })).toEqual([]);
    });
    test('card and CVV context near the code refuses it', () => {
      expect(verify('Agent: Your security code?\nCaller: It is three three nine four.', [item({ code: '3394', quote: 'It is three three nine four.' })], { direction: 'inbound' })).toEqual([]);
      expect(verify('Agent: Expiration date?\nCaller: The code on the back is three three nine.', [item({ code: '339', quote: 'The code on the back is three three nine.' })], { direction: 'inbound' })).toEqual([]);
      expect(verify('Caller: The CVV is 3394 for the card.', [item({ code: '3394', quote: 'The CVV is 3394 for the card.' })], { direction: 'inbound' })).toEqual([]);
    });
    test('a Google, Bing or bank verification code is refused', () => {
      expect(verify('Caller: Google just texted me a verification code, it is four eight one two one five.',
        [item({ kind: 'other', code: '481215', quote: 'it is four eight one two one five.' })], { direction: 'inbound' })).toEqual([]);
      expect(verify('Caller: My bank sent a code, hold on, 481215.', [item({ kind: 'other', code: '481215', quote: 'hold on, 481215.' })], { direction: 'inbound' })).toEqual([]);
    });
    test('a key card or gate card is not card context', () => {
      const transcript = 'Caller: You need the gate card too. The gate code is pound four eight two one.';
      expect(verify(transcript, [item({ code: '#4821', quote: 'The gate code is pound four eight two one.' })], { direction: 'inbound' })).toHaveLength(1);
    });
  });

  describe('addresses and phones', () => {
    const properties = [{ id: 'p1', address_line1: '4455 Example Lane', zip: '34202' }];
    test('a ZIP or house number read aloud is never a code', () => {
      const zip = 'Caller: The zip is three four two zero two.';
      expect(verify(zip, [item({ kind: 'other', code: '34202', quote: 'The zip is three four two zero two.' })], { direction: 'inbound', customerId: 'cust' }, { properties })).toEqual([]);
      const house = 'Agent: What is the gate code?\nCaller: I am at four four five five Example Lane.';
      expect(verify(house, [item({ code: '4455', quote: 'I am at four four five five Example Lane.' })], { direction: 'inbound', customerId: 'cust' }, { properties })).toEqual([]);
    });
    test('with no customer, the ZIP the call itself states is refused', () => {
      const transcript = 'Caller: I live in Lakewood Ranch, Florida, three four two zero two. The gate code is five five one two.';
      expect(verify(transcript, [item({ kind: 'other', code: '34202', quote: 'Florida, three four two zero two.' })], { direction: 'inbound' })).toEqual([]);
      expect(verify(transcript, [item({ code: '5512', quote: 'The gate code is five five one two.' })], { direction: 'inbound' })).toHaveLength(1);
    });
    test('a spoken phone number is refused, and a numeric code needs three digits', () => {
      const phone = 'Caller: Call my wife, nine four one five five five zero one four two.';
      expect(verify(phone, [item({ kind: 'other', code: '9415550142', quote: 'Call my wife, nine four one five five five zero one four two.' })], { direction: 'inbound' })).toEqual([]);
      const press = 'Caller: At the gate, press two for the guard. The gate code is four eight two one.';
      expect(verify(press, [item({ kind: 'call_box', code: '2', quote: 'At the gate, press two for the guard.' })], { direction: 'inbound' })).toEqual([]);
    });
  });

  describe('kind and life', () => {
    const during = 'Agent: I am at your gate.\nCaller: It is pound, four eight two one.';
    const quote = 'It is pound, four eight two one.';
    test('a gate code given at the gate during a visit stays standing', () => {
      const out = verify(during, [item({ code: '#4821', life: 'visit', quote })]);
      expect(out[0].life).toBe('standing');
    });
    test('a customer who calls the code temporary keeps a visit-life row', () => {
      const out = verify('Agent: I am at your gate.\nCaller: It is pound, four eight two one, just for today.', [item({ code: '#4821', life: 'visit', quote: 'It is pound, four eight two one, just for today.' })]);
      expect(out[0].life).toBe('visit');
    });
    test('a plain "gate" is the neighborhood gate; front, main or side gate is the property gate', () => {
      expect(verify(during, [item({ kind: 'property_gate', code: '#4821', quote })])[0].kind).toBe('neighborhood_gate');
      const front = 'Agent: Which code?\nCaller: The front gate is pound, four eight two one.';
      expect(verify(front, [item({ kind: 'property_gate', code: '#4821', quote: 'The front gate is pound, four eight two one.' })])[0].kind).toBe('property_gate');
    });
    test('a visit-life door code stays as the model said', () => {
      const door = 'Caller: The door code for the job is four eight two one, for today.';
      expect(verify(door, [item({ kind: 'door', code: '4821', life: 'visit', quote: 'The door code for the job is four eight two one, for today.' })])[0].life).toBe('visit');
    });
  });

  test('a pass keeps directions with no code; any other item with no code is dropped', () => {
    const transcript = 'Caller: Show the guard the QR code from the email. It has your name.';
    expect(verify(transcript, [item({ kind: 'pass', code: null, instructions: 'Show the guard the QR code from the email.', quote: 'Show the guard the QR code from the email.' })], { direction: 'inbound' })).toHaveLength(1);
    expect(verify(transcript, [item({ kind: 'door', code: null, instructions: 'Show the guard the QR code from the email.', quote: 'Show the guard the QR code from the email.' })], { direction: 'inbound' })).toEqual([]);
    expect(verify(transcript, [item({ kind: 'pass', code: null, instructions: 'Wave at the guard.', quote: 'Show the guard the QR code from the email.' })], { direction: 'inbound' })).toEqual([]);
  });

  test('empty or over-long transcripts, and a non-array answer, keep nothing', () => {
    expect(verify('', [item({ quote: 'x' })])).toEqual([]);
    expect(verify(`Caller: ${'word '.repeat(9000)}`, [item({ quote: 'word' })])).toEqual([]);
    expect(verify('Caller: pound three three nine four', null, { direction: 'inbound' })).toEqual([]);
  });
});

describe('call prompt and read', () => {
  const [transcript] = BOBBY_LABELS[0];
  test('the prompt names the labels, the staff rule and the spoken numbers, and carries the transcript as data', () => {
    const prompt = buildCallPrompt({ message: call(transcript) });
    expect(prompt).toContain('"Agent:" and "Caller:"');
    expect(prompt).toContain('The labels may be swapped on outbound calls.');
    expect(prompt).toMatch(/Only a code the CUSTOMER states counts/);
    expect(prompt).toMatch(/read-back, never a source/);
    expect(prompt).toContain('#3394');
    expect(prompt).toContain('untrusted conversation data');
    expect(prompt).toContain("I'm at your gate");
    // the scrubber leaves a spoken gate code alone
    expect(prompt).toContain("it's pound, three three nine four.");
  });

  test('a card number in the transcript never reaches the prompt', () => {
    const prompt = buildCallPrompt({ message: call('Caller: my card is 4242 4242 4242 4242 and the gate code is 5512.') });
    expect(prompt).not.toContain('4242 4242 4242 4242');
    expect(prompt).not.toContain('4242424242424242');
  });

  test('the read dispatches once with the call version and refuses a bad answer', async () => {
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { items: [] } });
    expect(await readCallAccessCodes({ message: call(transcript) })).toEqual({ items: [] });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    expect(dispatchWithFallback.mock.calls[0][1]).toMatchObject({ promptVersion: CALL_VERSION, laneId: 'sms-operational-actions' });
    dispatchWithFallback.mockResolvedValueOnce({ ok: false });
    await expect(readCallAccessCodes({ message: call(transcript) })).rejects.toThrow('access_net_provider_failed');
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { items: 'nope' } });
    await expect(readCallAccessCodes({ message: call(transcript) })).rejects.toThrow('access_net_invalid_schema');
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { items: [{ kind: 'door', code: '4242 4242 4242 4242', instructions: null, life: 'standing', quote: 'x' }] } });
    await expect(readCallAccessCodes({ message: call(transcript) })).rejects.toThrow('access_net_sensitive_output');
  });
});

describe('callsEnabled', () => {
  const OLD = { section: process.env.GATE_ACCESS_CODES_SECTION, calls: process.env.GATE_ACCESS_CODES_CALLS };
  afterEach(() => {
    for (const [key, value] of [['GATE_ACCESS_CODES_SECTION', OLD.section], ['GATE_ACCESS_CODES_CALLS', OLD.calls]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  test('needs the calls gate and the section gate, read at call time', () => {
    process.env.GATE_ACCESS_CODES_SECTION = 'true';
    delete process.env.GATE_ACCESS_CODES_CALLS;
    expect(access.callsEnabled()).toBe(false);
    process.env.GATE_ACCESS_CODES_CALLS = 'true';
    expect(access.callsEnabled()).toBe(true);
    process.env.GATE_ACCESS_CODES_SECTION = 'false';
    expect(access.callsEnabled()).toBe(false);
  });
});

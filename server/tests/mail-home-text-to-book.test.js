/**
 * Text to book, the answer to a new-home postcard (services/mail/home-text-to-book.js, mailer step 2d-3): the body shapes
 * it takes, the exact live-slug rule, the ZIP form, both gates, the office-line rule, the once-per-24-hours rule and the
 * one send (entry point, audience, from line, link). The two table reads and the send are mocked; the webhook hook is in
 * twilio-webhook-mail-home-text-to-book.test.js.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockGates = { mailHomePageLive: jest.fn(() => true), mailHomeTextBookLive: jest.fn(() => true) };
jest.mock('../config/feature-gates', () => mockGates);

const mockState = { homes: [], recent: false, prospectQueries: 0, logQueries: 0 };
jest.mock('../models/db', () => jest.fn((table) => {
  const q = {};
  for (const m of ['where', 'whereIn', 'whereRaw']) q[m] = () => q;
  if (table === 'mail_prospects') {
    q.select = async () => { mockState.prospectQueries += 1; return mockState.homes; };
  } else if (table === 'sms_log') {
    q.first = async () => { mockState.logQueries += 1; return mockState.recent ? { id: 'log-1' } : null; };
  }
  return q;
}));
const mockSend = jest.fn();
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: (...a) => mockSend(...a) }));

const TWILIO_NUMBERS = require('../config/twilio-numbers');
const logger = require('../services/logger');
const { handleHomeTextToBook, _test } = require('../services/mail/home-text-to-book');

const PARRISH = TWILIO_NUMBERS.locations.parrish.number; // the line the card prints
const SENDER = '+12025550101';
const HOME = { page_slug: '101-example', address_line1: '101 EXAMPLE TRL', zip: '34219' };
const SENT = { sent: true, sid: 'SM123', provider: 'twilio', deliveryOutcome: 'sent' };

const text = (body, to = PARRISH) => handleHomeTextToBook({ from: SENDER, to, body });

beforeEach(() => {
  jest.clearAllMocks();
  mockGates.mailHomePageLive.mockReturnValue(true);
  mockGates.mailHomeTextBookLive.mockReturnValue(true);
  Object.assign(mockState, { homes: [{ ...HOME }], recent: false, prospectQueries: 0, logQueries: 0 });
  mockSend.mockResolvedValue({ ...SENT });
});

describe('parseAddressText', () => {
  test.each([
    ['101 EXAMPLE', ['101-example'], null],
    ['101 example', ['101-example'], null],
    ['  101   Example  ', ['101-example'], null],
    ['101 Example Trl', ['101-example'], null],
    ['101 Example Trl.', ['101-example'], null],
    ['101 EXAMPLE 34211', ['101-example-34211', '101-example'], '34211'],
    ['101 Example Trl 34211', ['101-example-34211', '101-example'], '34211'],
    ['4512 N River Oaks Dr', ['4512-n-river-oaks'], null],
  ])('%s', (body, candidates, zip) => {
    expect(_test.parseAddressText(body)).toEqual({ candidates, zip });
  });

  test.each([
    'hello', 'STOP', 'YES', 'Can you come at 9?', '101', 'EXAMPLE 101', '',
    '   ', 'https://x.com/101-example', '12A Example', '5', null, undefined,
    '101 Example Trl please call me back when you get a chance today',
  ])('not an address: %j', (body) => {
    expect(_test.parseAddressText(body)).toBeNull();
  });
});

describe('handleHomeTextToBook', () => {
  test('a live home: one send from the office line the text came to, with the short link', async () => {
    expect(await text('101 EXAMPLE')).toEqual({ handled: true, slug: '101-example' });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const input = mockSend.mock.calls[0][0];
    expect(input).toMatchObject({
      to: SENDER,
      channel: 'sms',
      audience: 'lead',
      purpose: 'conversational',
      identityTrustLevel: 'phone_provided_unverified',
      entryPoint: 'mail_home_text_to_book',
      metadata: { original_message_type: 'mail_home_text_to_book', fromNumber: PARRISH },
    });
    expect(input.body).toBe("Here's your Waves page for 101 Example Trl: https://portal.wavespestcontrol.com/nh/101-example\n\nPick a time and you're booked. Reply STOP to opt out.");
  });

  test('every office location line answers from itself', async () => {
    for (const loc of Object.values(TWILIO_NUMBERS.locations)) {
      mockSend.mockClear();
      expect((await text('101 example trl', loc.number)).handled).toBe(true);
      expect(mockSend.mock.calls[0][0].metadata.fromNumber).toBe(loc.number);
    }
  });

  test('the ZIP form: a typed ZIP finds "101-example-34211"', async () => {
    mockState.homes = [{ page_slug: '101-example-34211', address_line1: '101 EXAMPLE TRL', zip: '34211' }];
    expect(await text('101 Example 34211')).toEqual({ handled: true, slug: '101-example-34211' });
    expect(mockSend.mock.calls[0][0].body).toContain('/nh/101-example-34211\n');
  });

  test('only the ZIP form exists and no ZIP is typed: no guess, no reply, no send', async () => {
    mockState.homes = [{ page_slug: '101-example-34211', address_line1: '101 EXAMPLE TRL', zip: '34211' }];
    expect(await text('101 Example')).toEqual({ handled: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('a typed ZIP that is not the plain-slug home\'s own ZIP does not match that home', async () => {
    expect(await text('101 Example 34211')).toEqual({ handled: false }); // HOME.zip is 34219
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('a typed ZIP that is the plain-slug home\'s ZIP matches it', async () => {
    expect(await text('101 Example 34219')).toEqual({ handled: true, slug: '101-example' });
  });

  test('an unknown slug falls through', async () => {
    mockState.homes = [];
    expect(await text('999 NOWHERE')).toEqual({ handled: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  test.each([
    ['GATE_MAIL_HOME_TEXT_BOOK off', 'mailHomeTextBookLive'],
    ['GATE_MAIL_HOME_PAGE off', 'mailHomePageLive'],
  ])('%s: nothing read, nothing sent', async (_label, gate) => {
    mockGates[gate].mockReturnValue(false);
    expect(await text('101 EXAMPLE')).toEqual({ handled: false });
    expect(mockState.prospectQueries).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test.each([
    ['the AI line', '+18559260203'],
    ['the main line', TWILIO_NUMBERS.mainLine.number],
    ['a GBP tracking line', TWILIO_NUMBERS.gbpTracking.parrish.number],
    ['an unmanaged number', '+19415550000'],
  ])('%s is not an office line: no reply', async (_label, to) => {
    expect(await text('101 EXAMPLE', to)).toEqual({ handled: false });
    expect(mockState.prospectQueries).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('a text that is not an address shape reads no table', async () => {
    for (const body of ['Thanks!', 'STOP', 'Is someone coming Tuesday?', '']) {
      expect(await text(body)).toEqual({ handled: false });
    }
    expect(mockState.prospectQueries).toBe(0);
    expect(mockState.logQueries).toBe(0);
  });

  test('the same sender and home inside 24 hours: no second reply', async () => {
    mockState.recent = true;
    expect(await text('101 EXAMPLE')).toEqual({ handled: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('a refused send (opt-out, landline, cap) is not handled: the text goes on as any other', async () => {
    mockSend.mockResolvedValue({ sent: false, blocked: true, code: 'SUPPRESSED' });
    expect(await text('101 EXAMPLE')).toEqual({ handled: false });
  });

  test('a send that threw with no outcome is not handled and not retried', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('boom 101 Example Trl +12025550101'), { code: 'ECONNRESET' }));
    expect(await text('101 EXAMPLE')).toEqual({ handled: false });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('a thrown provider outcome that may have reached the provider is handled and never retried', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('late'), { providerOutcome: { sent: false, deliveryOutcome: 'uncertain', uncertain: true } }));
    const out = await text('101 EXAMPLE');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(typeof out.handled).toBe('boolean');
  });

  test('logs carry the slug only: no address, no phone', async () => {
    await text('101 EXAMPLE');
    mockSend.mockRejectedValue(Object.assign(new Error('boom 101 Example Trl +12025550101'), { code: 'X' }));
    await text('101 EXAMPLE');
    const logged = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]);
    expect(logged).not.toMatch(/Trl|TRL|2025550101/);
  });
});

describe('displayAddress', () => {
  test.each([
    ['101 EXAMPLE TRL', '101 Example Trl'],
    ['123 MAIN ST NW', '123 Main St NW'],
    ['5 O\'BRIEN CT', "5 O'Brien Ct"],
    ['88 LAKE VIEW BLVD UNIT 3', '88 Lake View Blvd Unit 3'],
    ['123 SW 5TH AVE', '123 SW 5th Ave'],
  ])('%s', (input, expected) => {
    expect(_test.displayAddress(input)).toBe(expected);
  });
});

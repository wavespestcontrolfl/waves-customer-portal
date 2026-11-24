/**
 * Text to book, the answer to a new-home postcard (services/mail/home-text-to-book.js, mailer step 2d-3): the body shapes
 * it takes, the exact live-slug rule (printed name before the type-stripped form, the typed ZIP on every plain match), both
 * gates, the office-line rule, the atomic once-per-24-hours claim (taken before the provider call, kept for sent and
 * uncertain, released on a provable non-send), the copy (a time is promised only where the page offers one) and the one
 * send (entry point, audience, from line, link). The table reads and the send are mocked; the webhook hook is in
 * twilio-webhook-mail-home-text-to-book.test.js.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockGates = {
  mailHomePageLive: jest.fn(() => true),
  mailHomeTextBookLive: jest.fn(() => true),
  isEnabled: jest.fn((key) => key === 'selfBooking'),
};
jest.mock('../config/feature-gates', () => mockGates);

// The claim table: a transaction holds the (simulated) advisory lock until it settles, so two texts at the same moment
// run one after the other, as pg_advisory_xact_lock makes them.
const mockState = { homes: [], claims: [], deleted: [], prospectQueries: 0, claimTxns: 0, lock: Promise.resolve() };
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const q = {};
    for (const m of ['where', 'whereIn', 'whereRaw']) q[m] = () => q;
    if (table === 'mail_prospects') {
      q.select = async () => { mockState.prospectQueries += 1; return mockState.homes; };
    } else if (table === 'mail_home_text_replies') {
      q.del = async () => { mockState.deleted.push(table); mockState.claims.pop(); return 1; };
    }
    return q;
  });
  db.transaction = (fn) => {
    const run = mockState.lock.then(async () => {
      mockState.claimTxns += 1;
      const trx = () => {
        const q = {};
        q.where = () => q;
        q.whereRaw = () => q;
        q.first = async () => (mockState.claims.length ? { id: mockState.claims[0].id } : null);
        q.insert = (row) => ({
          returning: async () => {
            const claim = { id: `claim-${mockState.claims.length + 1}`, ...row };
            mockState.claims.push(claim);
            return [{ id: claim.id }];
          },
        });
        return q;
      };
      trx.raw = async () => ({});
      return fn(trx);
    });
    mockState.lock = run.catch(() => {});
    return run;
  };
  return db;
});
const mockSend = jest.fn();
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: (...a) => mockSend(...a) }));

const TWILIO_NUMBERS = require('../config/twilio-numbers');
const logger = require('../services/logger');
const { handleHomeTextToBook, _test } = require('../services/mail/home-text-to-book');

const PARRISH = TWILIO_NUMBERS.locations.parrish.number; // the line the card prints
const SENDER = '+12025550101';
const HOME = { id: 'prospect-1', page_slug: '101-example', address_line1: '101 EXAMPLE TRL', zip: '34219', status: 'eligible', price_status: 'priced', price_annual: 480 };
const SENT = { sent: true, sid: 'SM123', provider: 'twilio', deliveryOutcome: 'sent' };
const BOOK_LINE = "Pick a time and you're booked.";
const NEUTRAL_LINE = 'See your page, and call us with any questions.';

const text = (body, to = PARRISH) => handleHomeTextToBook({ from: SENDER, to, body });

beforeEach(() => {
  jest.clearAllMocks();
  mockGates.mailHomePageLive.mockReturnValue(true);
  mockGates.mailHomeTextBookLive.mockReturnValue(true);
  Object.assign(mockState, { homes: [{ ...HOME }], claims: [], deleted: [], prospectQueries: 0, claimTxns: 0, lock: Promise.resolve() });
  mockGates.isEnabled.mockImplementation((key) => key === 'selfBooking');
  mockSend.mockResolvedValue({ ...SENT });
});

describe('parseAddressText', () => {
  test.each([
    ['101 EXAMPLE', ['101-example'], [], null],
    ['101 example', ['101-example'], [], null],
    ['  101   Example  ', ['101-example'], [], null],
    ['101 Example Trl', ['101-example-trl', '101-example'], ['101-example'], null],
    ['101 Example Trl.', ['101-example-trl', '101-example'], ['101-example'], null],
    ['88 Lake View', ['88-lake-view', '88-lake'], ['88-lake'], null],
    ['101 EXAMPLE 34211', ['101-example-34211', '101-example'], [], '34211'],
    ['101 Example Trl 34211', ['101-example-trl-34211', '101-example-trl', '101-example-34211', '101-example'], ['101-example-34211', '101-example'], '34211'],
  ])('%s', (body, candidates, fallback, zip) => {
    const parsed = _test.parseAddressText(body);
    expect(parsed.candidates).toEqual(candidates);
    expect([...parsed.fallback]).toEqual(fallback);
    expect(parsed.zip).toBe(zip);
  });

  test.each([
    'hello', 'STOP', 'YES', 'Can you come at 9?', '101', 'EXAMPLE 101', '',
    '   ', 'https://x.com/101-example', '12A Example', '5', null, undefined,
    '101 Example Trl please call me back when you get a chance today',
  ])('not an address: %j', (body) => {
    expect(_test.parseAddressText(body)).toBeNull();
  });
});

describe('streetTypeAgrees', () => {
  test.each([
    ['101 EXAMPLE TRL', '101 EXAMPLE TRL', true],
    ['101 EXAMPLE TRAIL', '101 EXAMPLE TRL', true], // any USPS spelling of the same type
    ['101 EXAMPLE TRL', '101 EXAMPLE', true], // the county line has no street type
    ['88 LAKE VIEW', '88 LAKE ST', false], // VIEW is not ST: another street
    ['101 EXAMPLE DR', '101 EXAMPLE TRL', false], // another street type: another street
    ['88 LAKE VIEW BLVD', '88 LAKE VIEW BLVD UNIT 3', true], // the unit part is not typed
    ['123 MAIN ST NW', '123 MAIN ST NW', true],
  ])('%s vs %s', (typed, line, expected) => {
    expect(_test.streetTypeAgrees(typed, line)).toBe(expected);
  });
});

describe('handleHomeTextToBook', () => {
  test('a live priced home: one send from the office line the text came to, with the short link', async () => {
    expect(await text('101 EXAMPLE')).toEqual({ handled: true, prospectId: 'prospect-1' });
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
    expect(input.body).toBe(`Here's your Waves page for 101 Example Trl: https://portal.wavespestcontrol.com/nh/101-example\n\n${BOOK_LINE} Reply STOP to opt out.`);
  });

  test.each([
    ['a held-back home', { status: 'held_back' }, false],
    ['a home with no price', { price_status: 'unpriced', price_annual: null }, false],
    ['a priced home when self-booking is off', {}, true],
  ])('%s: the reply does not promise a time', async (_label, patch, selfBookingOff) => {
    mockState.homes = [{ ...HOME, ...patch }];
    if (selfBookingOff) mockGates.isEnabled.mockReturnValue(false);
    expect((await text('101 EXAMPLE')).handled).toBe(true);
    const sent = mockSend.mock.calls[0][0].body;
    expect(sent).toBe(`Here's your Waves page for 101 Example Trl: https://portal.wavespestcontrol.com/nh/101-example\n\n${NEUTRAL_LINE} Reply STOP to opt out.`);
    expect(sent).not.toMatch(/pick a time|booked/i);
  });

  test('every office location line answers from itself', async () => {
    for (const loc of Object.values(TWILIO_NUMBERS.locations)) {
      mockState.claims = [];
      mockSend.mockClear();
      expect((await text('101 example trl', loc.number)).handled).toBe(true);
      expect(mockSend.mock.calls[0][0].metadata.fromNumber).toBe(loc.number);
    }
  });

  test('the printed name wins over the type-stripped form: "88 LAKE VIEW" finds "88 LAKE VIEW BLVD", not "88 LAKE ST"', async () => {
    mockState.homes = [
      { ...HOME, id: 'p-street', page_slug: '88-lake', address_line1: '88 LAKE ST' },
      { ...HOME, id: 'p-view', page_slug: '88-lake-view', address_line1: '88 LAKE VIEW BLVD' },
    ];
    expect(await text('88 LAKE VIEW')).toEqual({ handled: true, prospectId: 'p-view' });
    expect(mockSend.mock.calls[0][0].body).toContain('/nh/88-lake-view\n');
  });

  test('"88 LAKE VIEW" with only "88 LAKE ST" live: no reply (another street)', async () => {
    mockState.homes = [{ ...HOME, id: 'p-street', page_slug: '88-lake', address_line1: '88 LAKE ST' }];
    expect(await text('88 LAKE VIEW')).toEqual({ handled: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('the ZIP form: a typed ZIP finds "101-example-34211"', async () => {
    mockState.homes = [{ ...HOME, page_slug: '101-example-34211', zip: '34211' }];
    expect(await text('101 Example 34211')).toEqual({ handled: true, prospectId: 'prospect-1' });
    expect(mockSend.mock.calls[0][0].body).toContain('/nh/101-example-34211\n');
  });

  test('only the ZIP form exists and no ZIP is typed: no guess, no reply, no send', async () => {
    mockState.homes = [{ ...HOME, page_slug: '101-example-34211', zip: '34211' }];
    expect(await text('101 Example')).toEqual({ handled: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('a typed ZIP that is not the plain-slug home\'s own ZIP does not match that home', async () => {
    expect(await text('101 Example 34211')).toEqual({ handled: false }); // HOME.zip is 34219
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('a typed ZIP that is the plain-slug home\'s ZIP matches it', async () => {
    expect(await text('101 Example 34219')).toEqual({ handled: true, prospectId: 'prospect-1' });
  });

  test('a base slug too long to take a ZIP still checks the typed ZIP against the home', async () => {
    // "1-" + 53 letters = 55 characters: with "-34211" it is over the 60 limit, so the ZIP form is never a candidate.
    const name = 'abcdefghijklmnopqrstuvwxyz'.repeat(3).slice(0, 53);
    const slug = `1-${name}`;
    expect(slug.length + 6).toBeGreaterThan(60);
    mockState.homes = [{ ...HOME, page_slug: slug, address_line1: `1 ${name.toUpperCase()}`, zip: '34219' }];
    expect(await text(`1 ${name} 34211`)).toEqual({ handled: false }); // another ZIP
    expect(mockSend).not.toHaveBeenCalled();
    expect((await text(`1 ${name} 34219`)).handled).toBe(true);
  });

  test('an unknown slug falls through', async () => {
    mockState.homes = [];
    expect(await text('999 NOWHERE')).toEqual({ handled: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  test.each([
    ['GATE_MAIL_HOME_TEXT_BOOK off', 'mailHomeTextBookLive'],
    ['GATE_MAIL_HOME_PAGE off', 'mailHomePageLive'],
  ])('%s: nothing read, nothing claimed, nothing sent', async (_label, gate) => {
    mockGates[gate].mockReturnValue(false);
    expect(await text('101 EXAMPLE')).toEqual({ handled: false });
    expect(mockState.prospectQueries).toBe(0);
    expect(mockState.claimTxns).toBe(0);
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
    expect(mockState.claimTxns).toBe(0);
  });

  test('the same sender and home inside 24 hours: the claim is held, no second reply', async () => {
    expect((await text('101 EXAMPLE')).handled).toBe(true);
    expect(await text('101 Example Trl')).toEqual({ handled: false });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('two texts at the same moment send once (the claim is taken before the provider call)', async () => {
    let release;
    mockSend.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ ...SENT }); }));
    const first = text('101 EXAMPLE');
    const second = text('101 example');
    await new Promise((r) => { setTimeout(r, 20); });
    release();
    const results = await Promise.all([first, second]);
    expect(results.map((r) => r.handled).sort()).toEqual([false, true]);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('a refused send (opt-out, landline, cap) releases the claim and is not handled', async () => {
    mockSend.mockResolvedValue({ sent: false, blocked: true, code: 'SUPPRESSED' });
    expect(await text('101 EXAMPLE')).toEqual({ handled: false });
    expect(mockState.claims).toHaveLength(0);
    expect(mockState.deleted).toHaveLength(1);
  });

  test('a send that threw with no outcome keeps the claim, is not handled and is not retried', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('boom 101 Example Trl +12025550101'), { code: 'ECONNRESET' }));
    expect(await text('101 EXAMPLE')).toEqual({ handled: false });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockState.claims).toHaveLength(1);
    expect(await text('101 EXAMPLE')).toEqual({ handled: false });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('an uncertain provider outcome is handled, keeps the claim and is never retried', async () => {
    mockSend.mockResolvedValue({ sent: false, deliveryOutcome: 'uncertain', uncertain: true });
    const out = await text('101 EXAMPLE');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockState.claims).toHaveLength(1);
    expect(typeof out.handled).toBe('boolean');
  });

  test('logs carry the prospect id and codes only: no address, no slug, no phone', async () => {
    await text('101 EXAMPLE');
    await text('101 EXAMPLE'); // the repeat line
    mockState.claims = [];
    mockSend.mockRejectedValue(Object.assign(new Error('boom 101 Example Trl +12025550101'), { code: 'X' }));
    await text('101 EXAMPLE');
    const logged = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]);
    expect(logged).toMatch(/prospect-1/);
    expect(logged).not.toMatch(/Trl|TRL|101-example|101 EXAMPLE|2025550101/i);
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

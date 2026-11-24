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
        const filters = [];
        const matching = () => mockState.claims.filter((c) => filters.every((f) => Object.entries(f).every(([k, v]) => c[k] === v)));
        const q = {};
        q.where = (o) => { filters.push(o); return q; };
        q.whereRaw = () => q; // every claim in the store is inside the 24 h window
        q.count = async () => [{ n: String(matching().length) }];
        q.first = async () => (matching()[0] ? { id: matching()[0].id } : null);
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
const mockFindOnly = jest.fn();
jest.mock('../utils/known-caller-phone', () => ({
  findOnlyKnownCallerCustomer: (...a) => mockFindOnly(...a),
  KNOWN_CALLER_PHONE_COLS: ['phone', 'service_contact_phone', 'service_contact2_phone', 'service_contact3_phone', 'secondary_phone'],
}));
const mockSend = jest.fn();
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: (...a) => mockSend(...a) }));

const TWILIO_NUMBERS = require('../config/twilio-numbers');
const logger = require('../services/logger');
const { handleHomeTextToBook, _test } = require('../services/mail/home-text-to-book');
const { buildBaseSlug } = require('../services/mail/home-slug');

const PARRISH = TWILIO_NUMBERS.locations.parrish.number; // the line the card prints
const SENDER = '+12025550101';
const HOME = { id: 'prospect-1', page_slug: '101-example', address_line1: '101 EXAMPLE TRL', zip: '34219' };
// The canonical accepted result (sms-auto-send.js isRealProviderSend): sent, accepted, a real provider message id.
const SENT = { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM123' };

const text = (body, to = PARRISH) => handleHomeTextToBook({ from: SENDER, to, body });

beforeEach(() => {
  jest.clearAllMocks();
  mockGates.mailHomePageLive.mockReturnValue(true);
  mockGates.mailHomeTextBookLive.mockReturnValue(true);
  Object.assign(mockState, { homes: [{ ...HOME }], claims: [], deleted: [], prospectQueries: 0, claimTxns: 0, lock: Promise.resolve() });
  // The one live customer that owns the sender's number, as its primary phone (read only when the webhook matched a customer).
  mockFindOnly.mockResolvedValue({ id: 'cust-1', phone: SENDER });
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
    '101 Example Apt 9', '101 Example Unit 4',
  ])('not an address: %j', (body) => {
    expect(_test.parseAddressText(body)).toBeNull();
  });
});

describe('every address the slug builder accepts is accepted by the text parser', () => {
  // A county line with no unit part. The card prints the house number and street name; a sender may add the street type.
  const LINES = [
    '101 EXAMPLE TRL',
    '88 LAKE VIEW BLVD',
    '5 ST. JAMES CT',
    "12 O'NEIL WAY",
    '9 MARTIN LUTHER KING JR BLVD',
    '1 A B C D E F G H I J K L M DR', // many short words
    '3 CAF\u00c9 DEL MAR DR',
    '4512 N RIVER OAKS DR',
    '123 SW 5TH AVE',
    '123 MAIN ST NW',
    '7 SMITH & JONES RD',
    '10 HIGHWAY 41 N',
    '55 SOUTH TAMIAMI TRL',
    '200 THE VILLAGE AT THE LAKES OF SARASOTA PARK DR',
    '12 COUNTY ROAD 12345',
  ];
  test.each(LINES)('%s', (line) => {
    const slug = buildBaseSlug(line);
    expect(slug).toBeTruthy();
    // The printed text (house number and street name, as the slug reads) and the full line both find the slug.
    for (const typed of [line, slug.replace(/-/g, ' ')]) {
      const parsed = _test.parseAddressText(typed);
      expect(parsed && parsed.candidates).toContain(slug);
    }
  });

  test('a longest allowed slug (60 characters) with its street type and a ZIP still parses', () => {
    const name = 'abcdefghi '.repeat(5).trim(); // 5 words, 49 characters
    const line = `101 ${name} DR`;
    const slug = buildBaseSlug(line);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(_test.parseAddressText(`${line} 34211`).candidates).toContain(slug);
  });
});

describe('streetTypeAgrees', () => {
  test.each([
    ['101 EXAMPLE TRL', '101 EXAMPLE TRL', true],
    ['101 EXAMPLE TRAIL', '101 EXAMPLE TRL', true], // any USPS spelling of the same type
    ['101 EXAMPLE TRL', '101 EXAMPLE', true], // the county line has no street type
    ['3 CAFE DEL MAR DR', '3 CAF\u00c9 DEL MAR DR', true], // the slug builder's accent folding
    ['88 LAKE VIEW', '88 LAKE ST', false], // VIEW is not ST: another street
    ['101 EXAMPLE DR', '101 EXAMPLE TRL', false], // another street type: another street
    ['88 LAKE VIEW BLVD', '88 LAKE VIEW BLVD UNIT 3', true], // the unit part is not typed
    ['123 MAIN ST NW', '123 MAIN ST NW', true],
  ])('%s vs %s', (typed, line, expected) => {
    expect(_test.streetTypeAgrees(typed, line)).toBe(expected);
  });
});

describe('handleHomeTextToBook', () => {
  test('a live home: one send from the office line the text came to, with the short link', async () => {
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
    expect(input.body).toBe("Here's your Waves page for 101 Example Trl: https://portal.wavespestcontrol.com/nh/101-example\n\nReply STOP to opt out.");
  });

  test('one copy for every home: no promise of a time or a price', async () => {
    for (const patch of [{}, { status: 'held_back' }, { price_status: 'unpriced', price_annual: null }]) {
      mockState.claims = [];
      mockSend.mockClear();
      mockState.homes = [{ ...HOME, ...patch }];
      expect((await text('101 EXAMPLE')).handled).toBe(true);
      const sent = mockSend.mock.calls[0][0].body;
      expect(sent).toBe("Here's your Waves page for 101 Example Trl: https://portal.wavespestcontrol.com/nh/101-example\n\nReply STOP to opt out.");
      expect(sent).not.toMatch(/pick a time|booked|\$/i);
    }
  });

  test.each([
    '101 Example Apt 9', '101 EXAMPLE TRL APT 3', '101 Example Unit 4', '101 Example Ste 2', '101 Example Trl Lot 5',
  ])('a unit in the text is never dropped and matched: %s gets no reply', async (body) => {
    expect(await text(body)).toEqual({ handled: false });
    expect(mockState.prospectQueries).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('no matched customer: a lead with an unverified phone, no customerId', async () => {
    await text('101 EXAMPLE');
    const input = mockSend.mock.calls[0][0];
    expect(input.identityTrustLevel).toBe('phone_provided_unverified');
    expect(input).not.toHaveProperty('customerId');
  });

  test('the webhook\'s matched customer is passed as customerId so their SMS opt-out and consent are checked', async () => {
    expect((await handleHomeTextToBook({ from: SENDER, to: PARRISH, body: '101 EXAMPLE', customer: { id: 'cust-1', phone: SENDER } })).handled).toBe(true);
    expect(mockSend.mock.calls[0][0]).toMatchObject({ customerId: 'cust-1', identityTrustLevel: 'phone_matches_customer', audience: 'lead', purpose: 'conversational' });
  });

  test('a customer who opted out (sendCustomerMessage refuses) gets nothing and the claim is released', async () => {
    mockSend.mockResolvedValue({ sent: false, blocked: true, code: 'CONSENT_REVOKED' });
    expect(await handleHomeTextToBook({ from: SENDER, to: PARRISH, body: '101 EXAMPLE', customer: { id: 'cust-1', phone: SENDER } })).toEqual({ handled: false });
    expect(mockState.claims).toHaveLength(0);
  });

  test('standAside: a waiting estimate question means no claim and no send, and an ordinary text never runs the check', async () => {
    const standAside = jest.fn(async () => true);
    expect(await handleHomeTextToBook({ from: SENDER, to: PARRISH, body: '101 EXAMPLE', standAside })).toEqual({ handled: false });
    expect(standAside).toHaveBeenCalledTimes(1);
    expect(mockState.claimTxns).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
    const notCalled = jest.fn(async () => true);
    await handleHomeTextToBook({ from: SENDER, to: PARRISH, body: 'thanks!', standAside: notCalled });
    expect(notCalled).not.toHaveBeenCalled();
  });

  test('a customer texting from its PRIMARY phone: its opt-out is checked as the holder', async () => {
    const customer = { id: 'cust-1', phone: '(202) 555-0101' };
    expect((await handleHomeTextToBook({ from: SENDER, to: PARRISH, body: '101 EXAMPLE', customer, knownContact: true })).handled).toBe(true);
    expect(mockSend.mock.calls[0][0]).toMatchObject({ customerId: 'cust-1', identityTrustLevel: 'phone_matches_customer' });
  });

  test('a number held only by a secondary or service-contact slot (no primary match) gets no claim and no reply', async () => {
    mockFindOnly.mockResolvedValue({ id: 'cust-9', phone: '(941) 555-0000', service_contact_phone: '(202) 555-0101' });
    expect(await handleHomeTextToBook({ from: SENDER, to: PARRISH, body: '101 EXAMPLE', knownContact: true })).toEqual({ handled: false });
    expect(mockFindOnly).not.toHaveBeenCalled();
    expect(mockState.claimTxns).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test.each([
    ['the webhook matched a customer whose primary phone is a different number', { id: 'cust-1', phone: '(941) 555-0000' }, { id: 'cust-1', phone: '(941) 555-0000' }],
    ['the one-owner read finds nobody (two owners, or the record is gone)', { id: 'cust-1', phone: SENDER }, null],
    ['the one-owner read finds a different customer than the webhook\'s', { id: 'cust-1', phone: SENDER }, { id: 'cust-2', phone: SENDER }],
    ['the one-owner read has the number only as a service contact', { id: 'cust-1', phone: SENDER }, { id: 'cust-1', phone: '(941) 555-0000', service_contact_phone: SENDER }],
  ])('%s: no claim, no reply', async (_label, customer, owner) => {
    mockFindOnly.mockResolvedValue(owner);
    expect(await handleHomeTextToBook({ from: SENDER, to: PARRISH, body: '101 EXAMPLE', customer, knownContact: true })).toEqual({ handled: false });
    expect(mockState.claimTxns).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('an unreadable lookup (the webhook\'s own failed, or the one-owner read throws): no claim, no reply', async () => {
    expect(await handleHomeTextToBook({ from: SENDER, to: PARRISH, body: '101 EXAMPLE', knownContact: true })).toEqual({ handled: false });
    mockFindOnly.mockRejectedValue(new Error('db down'));
    expect(await handleHomeTextToBook({ from: SENDER, to: PARRISH, body: '101 EXAMPLE', customer: { id: 'cust-1', phone: SENDER }, knownContact: true })).toEqual({ handled: false });
    expect(mockState.claimTxns).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test.each([
    ['an international secondary', { secondary_phone: '+442025550101' }],
    ['an international service contact', { service_contact2_phone: '+442025550101' }],
  ])('country-code collision, %s sharing the sender\'s last ten digits: no claim, no reply', async (_label, extra) => {
    const owner = { id: 'cust-1', phone: '(202) 555-0101', ...extra };
    mockFindOnly.mockResolvedValue(owner);
    expect(await handleHomeTextToBook({ from: SENDER, to: PARRISH, body: '101 EXAMPLE', customer: { id: 'cust-1', phone: SENDER }, knownContact: true })).toEqual({ handled: false });
    expect(mockState.claimTxns).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('an international primary phone that shares the sender\'s last ten digits is not the sender: no reply', async () => {
    const stored = '+442025550101';
    mockFindOnly.mockResolvedValue({ id: 'cust-1', phone: stored });
    expect(await handleHomeTextToBook({ from: SENDER, to: PARRISH, body: '101 EXAMPLE', customer: { id: 'cust-1', phone: stored }, knownContact: true })).toEqual({ handled: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  test.each([
    ['a CSR or office-manager cell', '+19415551234'],
    ['one of our own lines', null],
  ])('%s is never answered', async (_label, number) => {
    const internal = number || TWILIO_NUMBERS.mainLine.number;
    jest.spyOn(TWILIO_NUMBERS, 'isInternalNumber').mockImplementation((n) => n === internal);
    expect(await handleHomeTextToBook({ from: internal, to: PARRISH, body: '101 EXAMPLE' })).toEqual({ handled: false });
    expect(mockState.prospectQueries).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
    TWILIO_NUMBERS.isInternalNumber.mockRestore();
  });

  test.each([
    ['an international number', '+442025550101'],
    ['a ten-digit international number (+45 and eight digits), which a +1 normalizer would misread', '+4512345678'],
    ['a +1 number with an impossible area code', '+10005550101'],
    ['a +1 number with an impossible exchange', '+12020550101'],
    ['a number with no plus', '2025550101'],
    ['a number that is too short', '+1202555010'],
    ['no number', ''],
    ['no number at all', undefined],
  ])('%s: no reply, no table read, no claim', async (_label, from) => {
    expect(await handleHomeTextToBook({ from, to: PARRISH, body: '101 EXAMPLE' })).toEqual({ handled: false });
    expect(mockState.prospectQueries).toBe(0);
    expect(mockState.claimTxns).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('a US sender is keyed on its ten digits (sender and office line)', async () => {
    await handleHomeTextToBook({ from: '+12025550999', to: PARRISH, body: '101 EXAMPLE' });
    expect(mockState.claims[0]).toMatchObject({ phone_digits: '2025550999', line_digits: '9412972817' });
  });

  test('a lead (no customer, no known contact) is sent as phone_provided_unverified and costs no customer read', async () => {
    await text('101 EXAMPLE');
    expect(mockFindOnly).not.toHaveBeenCalled();
    expect(mockSend.mock.calls[0][0]).toMatchObject({ identityTrustLevel: 'phone_provided_unverified' });
    expect(mockSend.mock.calls[0][0].customerId).toBeUndefined();
  });

  test('the full lookup: "3 CAFE DEL MAR DR" finds a stored "3 CAF\u00c9 DEL MAR DR" (accents folded like the slug)', async () => {
    mockState.homes = [{ ...HOME, id: 'p-cafe', page_slug: '3-cafe-del-mar', address_line1: '3 CAF\u00c9 DEL MAR DR' }];
    for (const typed of ['3 CAFE DEL MAR DR', '3 Cafe del Mar Dr.', '3 CAF\u00c9 DEL MAR', '3 cafe del mar']) {
      mockState.claims = [];
      mockSend.mockClear();
      expect(await text(typed)).toEqual({ handled: true, prospectId: 'p-cafe' });
    }
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

  test(`a sender gets at most ${_test.MAX_REPLIES_PER_SENDER} replies in 24 hours across homes and office lines`, async () => {
    const homes = [1, 2, 3, 4].map((n) => ({ ...HOME, id: `p-${n}`, page_slug: `${n}-example`, address_line1: `${n} EXAMPLE TRL` }));
    mockState.homes = homes;
    const lines = Object.values(TWILIO_NUMBERS.locations).map((l) => l.number);
    const results = [];
    for (let n = 1; n <= 4; n += 1) results.push(await text(`${n} example`, lines[n - 1]));
    expect(results.map((r) => r.handled)).toEqual([true, true, true, false]);
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  test('another sender is not held by this sender\'s cap', async () => {
    mockState.homes = [1, 2, 3, 4].map((n) => ({ ...HOME, id: `p-${n}`, page_slug: `${n}-example`, address_line1: `${n} EXAMPLE TRL` }));
    for (let n = 1; n <= 3; n += 1) await text(`${n} example`);
    expect((await handleHomeTextToBook({ from: '+12025550999', to: PARRISH, body: '1 example' })).handled).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  test('simultaneous texts for different homes still stop at the cap (one lock per sender)', async () => {
    mockState.homes = [1, 2, 3, 4, 5].map((n) => ({ ...HOME, id: `p-${n}`, page_slug: `${n}-example`, address_line1: `${n} EXAMPLE TRL` }));
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => text(`${n} example`)));
    expect(results.filter((r) => r.handled)).toHaveLength(_test.MAX_REPLIES_PER_SENDER);
    expect(mockSend).toHaveBeenCalledTimes(_test.MAX_REPLIES_PER_SENDER);
  });

  test('a released claim (a refused send) does not count toward the cap', async () => {
    mockState.homes = [1, 2, 3, 4].map((n) => ({ ...HOME, id: `p-${n}`, page_slug: `${n}-example`, address_line1: `${n} EXAMPLE TRL` }));
    mockSend.mockResolvedValueOnce({ sent: false, blocked: true, code: 'SUPPRESSED' });
    expect((await text('1 example')).handled).toBe(false);
    for (let n = 2; n <= 4; n += 1) expect((await text(`${n} example`)).handled).toBe(true);
  });

  test('a refused send (opt-out, landline, cap) releases the claim and is not handled', async () => {
    mockSend.mockResolvedValue({ sent: false, blocked: true, code: 'SUPPRESSED' });
    expect(await text('101 EXAMPLE')).toEqual({ handled: false });
    expect(mockState.claims).toHaveLength(0);
    expect(mockState.deleted).toHaveLength(1);
  });

  test('a suppression sentinel (sent:true with a placeholder id) is not a real send: the claim is released', async () => {
    mockSend.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted', providerMessageId: 'gate-blocked' });
    expect(await text('101 EXAMPLE')).toEqual({ handled: false });
    expect(mockState.claims).toHaveLength(0);
  });

  test('a send that threw with no outcome may have gone: the claim stays, the text is handled, nothing is retried', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('boom 101 Example Trl +12025550101'), { code: 'ECONNRESET' }));
    expect(await text('101 EXAMPLE')).toEqual({ handled: true, uncertain: true, prospectId: 'prospect-1' });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockState.claims).toHaveLength(1);
    expect(await text('101 EXAMPLE')).toEqual({ handled: false }); // the claim holds the repeat
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('an uncertain provider outcome is handled, keeps the claim and is never retried', async () => {
    mockSend.mockResolvedValue({ sent: false, deliveryOutcome: 'uncertain', uncertain: true });
    expect(await text('101 EXAMPLE')).toEqual({ handled: true, uncertain: true, prospectId: 'prospect-1' });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockState.claims).toHaveLength(1);
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

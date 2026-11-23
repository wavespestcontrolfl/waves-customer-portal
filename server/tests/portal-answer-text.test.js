/**
 * GATE_PORTAL_ANSWER_TEXT (owner 2026-11-22, "ok do your rec"): the text that carries an office answer from the
 * portal. Pins the owner's words, the whole answer when it fits 3 segments, a long answer's first part cut at a space
 * plus the portal link inside 3 segments and as long as fits, the count in the characters the send step sends (GSM
 * punctuation, a link with no scheme), a name outside the GSM set, the night rule (the staff press is the office's own
 * send), the outcome mapping, the number check, and the link check (an answer with a Waves link is not texted). No database (the notice flow itself is portal-messages-postgres.test.js).
 */
process.env.GATE_SMS_SEND_WINDOW = 'true';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { countSegments } = require('../services/messaging/segment-counter');
const { checkSendWindow } = require('../services/messaging/validators/send-window');
const { __private: { answerTextBody, answerLead, textOutcome, sameDestination, answerCarriesLink } } = require('../services/portal-messages');
const { classifyDeliveryCertainty, normalizeRecipient } = require('../services/messaging/send-customer-message');

const LEAD = "Hi Sam, here's our answer from Waves: ";
// A synthetic customer id: the link names the customer's profile, as the reply email's does.
const ID = '00000000-0000-4000-8000-000000000001';
const words = (n, from = 0) => Array.from({ length: n }, (_, i) => `word${from + i}`).join(' ');

describe('the text that carries a portal answer', () => {
  test('a short answer goes whole, in the owner\'s words', () => {
    expect(answerTextBody('Sam', 'Yes, your tech can treat the lanai at your next visit on Tuesday, Dec 1.', ID))
      .toBe(`${LEAD}Yes, your tech can treat the lanai at your next visit on Tuesday, Dec 1.`);
  });

  test('no first name reads "Hi there"; a name outside the GSM set is folded, not sent as UCS-2', () => {
    expect(answerTextBody(null, 'Yes.', ID)).toBe("Hi there, here's our answer from Waves: Yes.");
    const text = answerTextBody('Zoë', 'Yes.', ID);
    expect(text).toBe("Hi Zoe, here's our answer from Waves: Yes.");
    expect(countSegments(text).encoding).toBe('GSM_7');
  });

  test('typographic punctuation is sent, and counted, as GSM', () => {
    const text = answerTextBody('Sam', 'We’ll be there “early”.', ID);
    expect(text).toBe(`${LEAD}We'll be there "early".`);
    expect(countSegments(text).encoding).toBe('GSM_7');
  });

  test('a long answer sends its first part, cut at a space, then the portal link, as long as fits in 3 segments', () => {
    const text = answerTextBody('Sam', words(150), ID);
    const match = text.match(/^Hi Sam, here's our answer from Waves: (word0 .* word(\d+))\.\.\. Read the rest in your portal: (\S+)$/);
    expect(match).not.toBeNull();
    // The link is the reply email's: the Messages tab for this customer's profile, with no scheme (the send step
    // drops it, and the count must match).
    expect(match[3]).toMatch(new RegExp(`/\\?tab=messages&notificationProperty=${ID}$`));
    expect(match[3]).not.toMatch(/^https?:/);
    const counted = countSegments(text);
    expect(counted.encoding).toBe('GSM_7');
    expect(counted.segmentCount).toBeLessThanOrEqual(3);
    // One more word would not fit.
    const last = Number(match[2]);
    const longer = text.replace(`word${last}...`, `word${last} word${last + 1}...`);
    expect(countSegments(longer).segmentCount).toBeGreaterThan(3);
  });

  test('a cut never ends inside a word; one long word with no space is cut where it stands', () => {
    // 20 short words, then one word too long to fit: the cut falls inside it, so that word is dropped.
    const text = answerTextBody('Sam', `${words(20)} ${'x'.repeat(400)}`, ID);
    expect(text).toMatch(/ word19\.\.\. Read the rest in your portal: /);
    const one = answerTextBody('Sam', 'x'.repeat(1000), ID);
    expect(one).toMatch(/^Hi Sam, here's our answer from Waves: x+\.\.\. Read the rest in your portal: /);
    expect(countSegments(one).segmentCount).toBe(3);
  });

  test('an answer with a character outside GSM is counted as UCS-2, so its first part is shorter', () => {
    const text = answerTextBody('Sam', `🙂 ${words(150)}`, ID);
    const counted = countSegments(text);
    expect(counted.encoding).toBe('UCS_2');
    expect(counted.segmentCount).toBeLessThanOrEqual(3);
    expect(text).toMatch(new RegExp(` Read the rest in your portal: \\S+/\\?tab=messages&notificationProperty=${ID}$`));
  });
});

describe('the night rule for the answer text (only the staff press texts)', () => {
  // 10 PM Eastern on 2026-11-22.
  const night = new Date('2026-11-23T03:00:00Z');
  const send = (entryPoint) => checkSendWindow({
    to: '+19415550100', channel: 'sms', audience: 'customer', purpose: 'support_resolution', customerId: 'c-1',
    identityTrustLevel: 'phone_matches_customer', entryPoint,
  }, {}, {}, night);

  test('the staff press is the office\'s own send: a night answer goes at once (owner 2026-11-05)', () => {
    expect(send('admin_portal_answer')).toEqual({ ok: true });
  });

});

describe('the text outcome, by the shared delivery derivation', () => {
  test.each([
    [{ sent: true, blocked: false, deliveryOutcome: 'accepted' }, { text: 'sent' }],
    // The Twilio adapter's suppressed owner number: sent: true, but nothing went. The email goes.
    [{ sent: true, deliveryOutcome: 'not_sent', code: 'OWNER_SMS_SUPPRESSED' }, { text: 'not_sent', textCode: 'OWNER_SMS_SUPPRESSED' }],
    // sent: true with no outcome tag is not proof: it may have gone out, so no email and no second text.
    [{ sent: true }, { text: 'uncertain' }],
    [{ sent: false, blocked: true, code: 'SUPPRESSED', deliveryOutcome: 'not_sent' }, { text: 'not_sent', textCode: 'SUPPRESSED' }],
    // A refusal with no outcome tag is still a refusal: the email goes.
    [{ sent: false, blocked: true, deferred: true, code: 'QUIET_HOURS_HOLD' }, { text: 'not_sent', textCode: 'QUIET_HOURS_HOLD' }],
    [{ sent: false, deliveryOutcome: 'not_sent' }, { text: 'not_sent', textCode: 'NOT_SENT' }],
    // It may have gone out: no email, no second text.
    [{ sent: false, blocked: true, deliveryOutcome: 'uncertain', mayHaveSent: true }, { text: 'uncertain' }],
    [{}, { text: 'uncertain' }],
    [null, { text: 'uncertain' }],
  ])('%j reads as %j', (outcome, read) => {
    expect(textOutcome(outcome, classifyDeliveryCertainty, 'NOT_SENT')).toEqual(read);
  });
});

describe('the number the text goes to', () => {
  // The send step's own form of each stored number is what it texts.
  test.each([
    ['(941) 555-0142', true],
    ['+1 941 555 0142', true],
    ['19415550142', true],
    ['+19415550142', true],
    // A +45 number of eight national digits: the send step reads ten digits as +1 and ten digits, another number.
    ['+4512345678', false],
    // 44 and ten digits stored without a plus: toE164 keeps the last ten digits (a US number); the send step does not.
    ['449415550142', false],
    // A short or broken number is no text number.
    ['5550142', false],
    ['', false],
    [null, false],
  ])('stored %p: texted as stored = %p', (stored, same) => {
    expect(sameDestination(stored, normalizeRecipient(stored))).toBe(same);
  });

  test('a stored number that changed is not the destination', () => {
    expect(sameDestination('+19415550142', '+19415550143')).toBe(false);
    // A correction that adds a country code but keeps the ten digits: still another number.
    expect(sameDestination('449415550142', '+19415550142')).toBe(false);
    expect(sameDestination(null, '+19415550142')).toBe(false);
  });
});

describe('an answer with a Waves link is not texted (the email goes)', () => {
  const portal = new URL(require('../utils/portal-url').publicPortalUrl()).host;
  const short = new URL(require('../services/short-url').shortLinkBaseUrl()).host;
  test.each([
    [`Sign here: https://${portal}/contract/abc123`, true],
    [`Pay at ${portal}/pay/abc123.`, true],
    [`Here it is: ${short}/l/abc123`, true],
    // Nested in another URL and percent-encoded: still a portal link.
    [`https://example.com/?next=https%3A%2F%2F${portal}%2Fpay%2Fabc123`, true],
    // On the next line, after a tab, or after an invisible character: the phone shows a tappable link.
    [`Sign at\n${portal}/contract/abc123`, true],
    [`Sign at\r\n${portal}/contract/abc123`, true],
    [`Sign at\t${portal}/contract/abc123`, true],
    [`Sign at\u200B${portal}/contract/abc123`, true],
    // A soft hyphen or a line break inside the host, an encoded line break, a full-width host: a browser opens it.
    [`${portal.slice(0, 3)}\u00AD${portal.slice(3)}/pay/abc123`, true],
    [`${portal.slice(0, 3)}%0A${portal.slice(3)}/pay/abc123`, true],
    [`${[...portal].map((c) => (c === '.' ? '\u3002' : String.fromCharCode(c.charCodeAt(0) + 0xFEE0))).join('')}/pay/abc123`, true],
    // Still decoding after every pass: no scan can vouch for it.
    [`x${'%25'.repeat(1)}${'25'.repeat(20)}`, true],
    // Every other host that serves Waves pages: a Waves subdomain, the Railway app domain.
    ['Pay at https://www.wavespestcontrol.com/pay/abc123', true],
    ['Sign at waves-customer-portal-production.up.railway.app/contract/abc123', true],
    ['Yes, Tuesday works. Your tech will call first.', false],
    ['Directions: https://www.google.com/maps/place/Bradenton', false],
  ])('%p carries a Waves link: %p', (body, carries) => {
    expect(answerCarriesLink(body)).toBe(carries);
  });

  test("a host the app builds links with (the deployment's own host) is a Waves host too, read at call time", () => {
    const body = 'Pay here: answers-alias.example.test/pay/abc123';
    expect(answerCarriesLink(body)).toBe(false);
    process.env.RAILWAY_PUBLIC_DOMAIN = 'answers-alias.example.test';
    try {
      expect(answerCarriesLink(body)).toBe(true);
    } finally {
      delete process.env.RAILWAY_PUBLIC_DOMAIN;
    }
  });

  test("the send step's scheme strip can join two parts into a Waves host: the check reads that form too", () => {
    const dot = portal.indexOf('.');
    const joined = `Sign: ${portal.slice(0, dot)}https://${portal.slice(dot)}/contract/abc123`;
    expect(joined.includes(portal)).toBe(false);
    expect(require('../services/messaging/sms-link-policy').stripSmsUrlScheme(joined)).toContain(`${portal}/contract/abc123`);
    expect(answerCarriesLink(joined)).toBe(true);
  });

  test('the greeting carries the stored name as the text sends it: an accent folded away can make a Waves host', () => {
    const { OWN_DOMAIN } = require('../utils/signed-link-redaction');
    // The stored name carries no Waves host ("ŵavespestcontrol.com"); the send step folds the mark away.
    const name = `${OWN_DOMAIN[0]}\u0302${OWN_DOMAIN.slice(1)}/c`;
    expect(answerCarriesLink(name)).toBe(false);
    expect(answerLead(name)).toContain(OWN_DOMAIN);
    expect(answerCarriesLink(`${answerLead(name)}See you Tuesday.`)).toBe(true);
    expect(answerCarriesLink(`${answerLead('Pat')}See you Tuesday.`)).toBe(false);
  });
});

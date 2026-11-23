/**
 * GATE_PORTAL_ANSWER_TEXT (owner 2026-11-22, "ok do your rec"): the text that carries an office answer from the
 * portal. Pins the owner's words, the whole answer when it fits 3 segments, a long answer's first part cut at a space
 * plus the portal link inside 3 segments and as long as fits, the count in the characters the send step sends (GSM
 * punctuation, a link with no scheme), a name outside the GSM set, the night rule (the staff press is the office's own
 * send), the outcome mapping, and the bell's record of an earlier push. No database (the notice flow itself is
 * portal-messages-postgres.test.js).
 */
process.env.GATE_SMS_SEND_WINDOW = 'true';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { countSegments } = require('../services/messaging/segment-counter');
const { checkSendWindow } = require('../services/messaging/validators/send-window');
const { __private: { answerTextBody, textOutcome, earlierPush, sameDestination } } = require('../services/portal-messages');
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

describe("the bell's record of an earlier push", () => {
  const now = Date.parse('2026-11-22T20:00:00Z');
  const at = (minutes) => new Date(now + minutes * 60 * 1000).toISOString();
  test.each([
    [{ pushState: 'accepted' }, 'accepted'],
    [{ pushState: 'sending', pushLeaseUntil: at(2) }, 'sending'],
    [{ pushState: 'sending', pushLeaseUntil: at(-1) }, null],
    // No lease written: the attempt time plus 10 minutes, as push-notifications.js reads it.
    [{ pushState: 'sending', pushAttemptedAt: at(-5) }, 'sending'],
    [{ pushState: 'sending', pushAttemptedAt: at(-11) }, null],
    [{ pushState: 'failed' }, null],
    [{}, null],
  ])('%j reads as %s', (metadata, read) => {
    expect(earlierPush({ id: 'n-1', metadata }, now)).toBe(read);
    // A row whose metadata comes back as text reads the same.
    expect(earlierPush({ id: 'n-1', metadata: JSON.stringify(metadata) }, now)).toBe(read);
  });

  test('no bell reads as no push', () => {
    expect(earlierPush(null, now)).toBeNull();
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
    // A short or broken number is no text number.
    ['5550142', false],
    ['', false],
    [null, false],
  ])('stored %p: texted as stored = %p', (stored, same) => {
    expect(sameDestination(stored, normalizeRecipient(stored))).toBe(same);
  });

  test('a stored number that changed is not the destination', () => {
    expect(sameDestination('+19415550142', '+19415550143')).toBe(false);
    expect(sameDestination(null, '+19415550142')).toBe(false);
  });
});

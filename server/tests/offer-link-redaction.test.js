/**
 * utils/offer-link-redaction.js + the write points that use it: the audit preview and the deferred replay body.
 * (The sms_log / messages rows are covered in twilio-offer-link-redaction.test.js; the email ledger and comms history
 * in recruiting-comms.test.js; the reply-holding reservation row below.)
 */

jest.mock('../models/db', () => {
  const insert = jest.fn(() => ({ returning: async () => [{ id: 'audit-1' }] }));
  const db = jest.fn(() => ({ insert }));
  db.__insert = insert;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { redactOfferLinks, OFFER_LINK_HIDDEN } = require('../utils/offer-link-redaction');

const TOKEN = 'cd'.repeat(32);

describe('redactOfferLinks', () => {
  test('hides the token and keeps the rest of the path, with or without a scheme', () => {
    expect(redactOfferLinks(`read it: https://portal.wavespestcontrol.com/careers/offer/${TOKEN} now`)).toBe(`read it: https://portal.wavespestcontrol.com/careers/offer/${OFFER_LINK_HIDDEN} now`);
    expect(redactOfferLinks(`portal.wavespestcontrol.com/careers/offer/${TOKEN}`)).toBe(`portal.wavespestcontrol.com/careers/offer/${OFFER_LINK_HIDDEN}`);
    expect(redactOfferLinks(`<a href="https://x.test/careers/offer/${TOKEN}">a</a> and https://x.test/careers/offer/${TOKEN.toUpperCase()}`)).not.toMatch(/[0-9a-f]{64}/i);
  });

  test('leaves every other text, link and non-string alone', () => {
    const interview = `https://x.test/careers/interview/${TOKEN}`;
    expect(redactOfferLinks(interview)).toBe(interview);
    expect(redactOfferLinks('Your visit is tomorrow.')).toBe('Your visit is tomorrow.');
    expect(redactOfferLinks('/careers/offer/short')).toBe('/careers/offer/short');
    expect(redactOfferLinks(null)).toBeNull();
    expect(redactOfferLinks(undefined)).toBeUndefined();
    expect(redactOfferLinks('')).toBe('');
  });
});

describe('the audit preview', () => {
  test('never stores the offer link', async () => {
    const db = require('../models/db');
    const { persistAudit } = require('../services/messaging/audit');
    await persistAudit({
      input: { to: '+19415550123', audience: 'applicant', purpose: 'offer_sent', channel: 'sms', body: `Your job offer: https://x.test/careers/offer/${TOKEN} Reply STOP to opt out.` },
      segmentMeta: { segmentCount: 2, encoding: 'GSM-7' }, validatorsPassed: [], validatorsFailed: [],
    });
    const stored = JSON.stringify(db.__insert.mock.calls);
    expect(stored).toContain('/careers/offer/[link hidden]');
    expect(stored).not.toContain(TOKEN);
  });
});

describe('the deferred replay body', () => {
  const { replayBodyFor } = require('../services/messaging/deferred-replay-registry');
  const stored = `Hi Jordan, your job offer: portal.wavespestcontrol.com/careers/offer/${OFFER_LINK_HIDDEN} It stays open until Fri, Dec 18.`;

  test('a held offer text is rebuilt with the token the recheck just read from the offer row', () => {
    expect(replayBodyFor('recruiting_comms_deferred', { eligible: true, offerToken: TOKEN }, stored))
      .toBe(`Hi Jordan, your job offer: portal.wavespestcontrol.com/careers/offer/${TOKEN} It stays open until Fri, Dec 18.`);
  });

  test('without a live offer token it refuses (null) rather than send a text with no link', () => {
    expect(replayBodyFor('recruiting_comms_deferred', { eligible: true }, stored)).toBeNull();
    expect(replayBodyFor('recruiting_comms_deferred', null, stored)).toBeNull();
    expect(replayBodyFor('recruiting_comms_deferred', { eligible: true, offerToken: 'short' }, stored)).toBeNull();
  });

  test('every other body and entry point is returned unchanged', () => {
    expect(replayBodyFor('recruiting_comms_deferred', { eligible: true }, 'Pick a time: portal.x/careers/interview/abc')).toBe('Pick a time: portal.x/careers/interview/abc');
    expect(replayBodyFor('invoice_followup_deferred', { eligible: true, offerToken: TOKEN }, stored)).toBe(stored);
  });

  test('a held owner reply gets each pasted link back in order; a missing or extra link refuses it', () => {
    const other = 'f'.repeat(64);
    const reply = `Old: x/careers/offer/${OFFER_LINK_HIDDEN} New: x/careers/offer/${OFFER_LINK_HIDDEN} Thanks.`;
    expect(replayBodyFor('recruiting_comms_deferred', { eligible: true, offerTokens: [TOKEN, other] }, reply))
      .toBe(`Old: x/careers/offer/${TOKEN} New: x/careers/offer/${other} Thanks.`);
    expect(replayBodyFor('recruiting_comms_deferred', { eligible: true, offerTokens: [TOKEN] }, reply)).toBeNull();
    expect(replayBodyFor('recruiting_comms_deferred', { eligible: true, offerTokens: [TOKEN, 'short'] }, reply)).toBeNull();
    expect(replayBodyFor('recruiting_comms_deferred', { eligible: true }, reply)).toBeNull();
  });
});

describe('offerLinkTokens', () => {
  const { offerLinkTokens } = require('../utils/offer-link-redaction');
  test('lists every link token in order, in lowercase, and nothing for other text', () => {
    const upper = 'A'.repeat(64);
    expect(offerLinkTokens(`a https://p.x/careers/offer/${TOKEN} b p.x/careers/offer/${upper}`)).toEqual([TOKEN, 'a'.repeat(64)]);
    expect(offerLinkTokens('Pick a time: p.x/careers/interview/abc')).toEqual([]);
    expect(offerLinkTokens(null)).toEqual([]);
  });
});

describe('every writer of a stored message body redacts the offer link (source guard)', () => {
  const fs = require('fs');
  const path = require('path');
  const count = (file) => (fs.readFileSync(path.join(__dirname, '..', file), 'utf8').match(/redactOfferLinks\(/g) || []).length;

  test.each([
    ['services/twilio.js', 2], // the sms_log row and the unified messages row
    ['services/messaging/audit.js', 1], // the audit preview
    ['services/sms-suggest-mode.js', 2], // the reply-holding reservation row, written and renewed
    ['services/recruiting-comms.js', 4], // history masking, the email ledger html + text, the deferred queue row
  ])('%s calls redactOfferLinks at least %i time(s)', (file, minimum) => {
    expect(count(file)).toBeGreaterThanOrEqual(minimum);
  });
});

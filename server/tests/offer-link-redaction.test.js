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

const { redactOfferLinks, offerLinkTokens, OFFER_LINK_HIDDEN } = require('../utils/offer-link-redaction');
const { portalUrl } = require('../utils/portal-url');

const TOKEN = 'cd'.repeat(32);
const HIDDEN_LINK = portalUrl(`/careers/offer/${OFFER_LINK_HIDDEN}`);

// Spellings a browser cleans into the link (dot segments, backslashes, letter case), or a reader decodes into it
// (percent-encoding, double encoding, full-width forms, an invisible character in the token). Each is stored as the
// standard link with the token hidden, and pinned to the same token.
const OTHER_SPELLINGS = [
  `https://portal.wavespestcontrol.com/careers/offer/./${TOKEN}`,
  `https://portal.wavespestcontrol.com/careers/x/../offer/${TOKEN}`,
  `https://portal.wavespestcontrol.com/careers/offer/%2e/${TOKEN}`,
  `https://portal.wavespestcontrol.com\\careers\\offer\\${TOKEN}`,
  `portal.wavespestcontrol.com/CAREERS//Offer/${TOKEN}?x=1#top`,
  `https://portal.wavespestcontrol.com/careers/%6Fffer/${TOKEN}`,
  `https://portal.wavespestcontrol.com/%63areers/offer/${TOKEN}`,
  `https://portal.wavespestcontrol.com/careers/%256Fffer/${TOKEN}`,
  `https://portal.wavespestcontrol.com/careers/offer/%63${TOKEN.slice(1)}`,
  `https://portal.wavespestcontrol.com/\uff43\uff41\uff52\uff45\uff45\uff52\uff53/\uff4f\uff46\uff46\uff45\uff52/${TOKEN}`,
  `https://portal.wavespestcontrol.com/careers/offer/${TOKEN.slice(0, 32)}\u200b${TOKEN.slice(32)}`,
];

describe('redactOfferLinks', () => {
  test('hides the token and keeps the rest of the path, with or without a scheme', () => {
    expect(redactOfferLinks(`read it: https://portal.wavespestcontrol.com/careers/offer/${TOKEN} now`)).toBe(`read it: https://portal.wavespestcontrol.com/careers/offer/${OFFER_LINK_HIDDEN} now`);
    expect(redactOfferLinks(`portal.wavespestcontrol.com/careers/offer/${TOKEN}`)).toBe(`portal.wavespestcontrol.com/careers/offer/${OFFER_LINK_HIDDEN}`);
    expect(redactOfferLinks(`<a href="https://x.test/careers/offer/${TOKEN}">a</a> and https://x.test/careers/offer/${TOKEN.toUpperCase()}`)).not.toMatch(/[0-9a-f]{64}/i);
  });


  test.each(OTHER_SPELLINGS)('stores another spelling as the standard hidden link, pinned to its token: %s', (link) => {
    const text = `Here it is: ${link} thanks`;
    expect(redactOfferLinks(text)).toBe(`Here it is: ${HIDDEN_LINK} thanks`);
    expect(offerLinkTokens(text)).toEqual([TOKEN]);
  });

  // A browser drops tabs and line breaks inside the URL an HTML attribute holds, and decodes its character references.
  test.each([
    ['a line break before the token', `https://portal.wavespestcontrol.com/careers/offer/\n${TOKEN}`],
    ['a tab and a line break inside the token', `https://portal.wavespestcontrol.com/careers/offer/${TOKEN.slice(0, 20)}\t\r\n${TOKEN.slice(20)}`],
    ['an encoded letter', `https://x.test/careers/&#111;ffer/${TOKEN}`],
    ['an encoded line break', `https://portal.wavespestcontrol.com/careers/offer/&#10;${TOKEN}`],
    ['named tab and line break references inside the route words', `https://x.test/car&Tab;eers/o&NewLine;ffer/${TOKEN}`],
    ['named slash references', `https://x.test/careers&sol;offer&sol;${TOKEN}`],
  ])('an HTML link with %s keeps its quotes, stores the standard hidden link and replays as a working link', (label, href) => {
    const { replayBodyFor } = require('../services/messaging/deferred-replay-registry');
    for (const q of ['"', "'"]) {
      const html = `<a href=${q}${href}${q}>Read your offer</a>`;
      expect(redactOfferLinks(html)).toBe(`<a href=${q}${HIDDEN_LINK}${q}>Read your offer</a>`);
      expect(offerLinkTokens(html)).toEqual([TOKEN]);
      expect(replayBodyFor('recruiting_comms_deferred', { eligible: true, offerTokens: offerLinkTokens(html) }, redactOfferLinks(html)))
        .toBe(`<a href=${q}${portalUrl(`/careers/offer/${TOKEN}`)}${q}>Read your offer</a>`);
    }
  });

  test('keeps the host and the words around the link as it is sent; a capital token is still that token', () => {
    expect(redactOfferLinks(`x.test/careers/offer/${TOKEN}`)).toBe(`x.test/careers/offer/${OFFER_LINK_HIDDEN}`);
    expect(redactOfferLinks(`<a href="https://x.test/careers/offer/${TOKEN}">Read</a>`)).toBe(`<a href="https://x.test/careers/offer/${OFFER_LINK_HIDDEN}">Read</a>`);
    expect(redactOfferLinks(`x.test/careers/offer/${TOKEN.toUpperCase()}.`)).toBe(`x.test/careers/offer/${OFFER_LINK_HIDDEN}.`);
    expect(offerLinkTokens(`x.test/careers/offer/${TOKEN.toUpperCase()}.`)).toEqual([TOKEN]);
  });

  // A browser resolves dot segments in the path only, so one in a query or fragment never removes the token.
  test.each([
    ['a query', `https://portal.wavespestcontrol.com/Careers/Offer/${TOKEN}?a=/..`],
    ['a fragment', `https://portal.wavespestcontrol.com/Careers/Offer/${TOKEN}#/../..`],
    ['a query after a dot segment in the path', `https://x.test/careers/x/../OFFER/${TOKEN}?next=/../../`],
  ])('a dot segment in %s cannot hide the token on the path: stored as the standard hidden link, pinned, replayed', (label, link) => {
    const { replayBodyFor } = require('../services/messaging/deferred-replay-registry');
    const text = `Here it is: ${link} thanks`;
    expect(redactOfferLinks(text)).toBe(`Here it is: ${HIDDEN_LINK} thanks`);
    expect(offerLinkTokens(text)).toEqual([TOKEN]);
    expect(replayBodyFor('recruiting_comms_deferred', { eligible: true, offerTokens: offerLinkTokens(text) }, redactOfferLinks(text)))
      .toBe(`Here it is: ${portalUrl(`/careers/offer/${TOKEN}`)} thanks`);
  });

  test('pins only the token on the offer path: a 64-hex query value beside it stays and is not pinned', () => {
    const ref = 'f'.repeat(64);
    const sent = `https://portal.wavespestcontrol.com/careers/offer/${TOKEN}?ref=${ref}`;
    expect(redactOfferLinks(sent)).toBe(`https://portal.wavespestcontrol.com/careers/offer/${OFFER_LINK_HIDDEN}?ref=${ref}`);
    expect(offerLinkTokens(sent)).toEqual([TOKEN]);
    const other = `https://portal.wavespestcontrol.com/careers/./offer/${TOKEN}?ref=${ref}`;
    expect(redactOfferLinks(other)).toBe(HIDDEN_LINK);
    expect(offerLinkTokens(other)).toEqual([TOKEN]);
  });

  test('leaves other 64-hex links alone: the interview page (also encoded), a visit link, a token with no offer route', () => {
    const others = [
      `https://x.test/careers/interview/${TOKEN}`, `https://x.test/careers/%69nterview/${TOKEN}`, `https://x.test/visit/${TOKEN}`,
      `ref ${TOKEN}`, `offer ${TOKEN} careers`,
    ];
    for (const other of others) {
      expect(redactOfferLinks(other)).toBe(other);
      expect(offerLinkTokens(other)).toEqual([]);
    }
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

// The browser decides. Node's URL is the WHATWG parser browsers use: every link it resolves to the signing page (the
// path /careers/offer/<token> in any letter case, with no percent-encoding left, which the page alone opens) must be
// stored without its token, as plain text and inside an href (whose character references a browser decodes first).
describe('every link a browser opens as the signing page is stored without its token', () => {
  const { decodeHTML } = require('entities');
  const SIGNING_PATH = new RegExp(`^/careers/offer/${TOKEN}/*$`, 'i');
  const opensSigningPage = (href) => {
    try {
      const { pathname } = new URL(href);
      return !pathname.includes('%') && SIGNING_PATH.test(pathname);
    } catch {
      return false;
    }
  };
  // Inserted between the parts of the path: dot segments (also encoded), a segment a ".." removes (one that carries an
  // encoded or entity "?" or "/", or is empty), a repeated slash, backslashes (a browser reads them as slashes), and a
  // real "?".
  const STEPS = ['', '/.', '/%2e', '/x/..', '/x/%2e%2E', '/x%3F/..', '/x&quest;/..', '/x%2F/..', '//..', '/', '\\x\\..', '\\\\..', '/x?'];

  test('in every mix of dot segments, empty segments, encoded delimiters and tails', () => {
    let opened = 0;
    for (const route of ['careers', 'CAREERS']) {
      for (const a of STEPS) for (const b of STEPS) for (const c of STEPS) {
        for (const tail of ['', '?a=/..', '/..']) {
          const link = `https://x.test${a}/${route}${b}/Offer${c}/${TOKEN}${tail}`;
          if (opensSigningPage(link)) {
            opened += 1;
            expect([link, redactOfferLinks(`Hi ${link} bye`).includes(TOKEN)]).toEqual([link, false]);
            expect([link, offerLinkTokens(`Hi ${link} bye`)]).toEqual([link, [TOKEN]]);
          }
          if (opensSigningPage(decodeHTML(link))) {
            opened += 1;
            const html = `<a href="${link}">Read your offer</a>`;
            expect([link, redactOfferLinks(html).includes(TOKEN)]).toEqual([link, false]);
            expect([link, offerLinkTokens(html)]).toEqual([link, [TOKEN]]);
          }
        }
      }
    }
    expect(opened).toBeGreaterThan(1000); // the parser opens most of them, so the check is not empty
  }, 60000);
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

  // The queue stores redactOfferLinks(body) and pins offerLinkTokens(body); the replay puts the pinned tokens back.
  test.each([`https://portal.wavespestcontrol.com/careers/offer/${TOKEN}`, ...OTHER_SPELLINGS])('a held owner reply round-trips to a working link: %s', (link) => {
    const body = `Here is your offer again: ${link} Thanks.`;
    const sent = replayBodyFor('recruiting_comms_deferred', { eligible: true, offerTokens: offerLinkTokens(body) }, redactOfferLinks(body));
    const rebuilt = link.includes('/careers/offer/' + TOKEN) ? link : portalUrl(`/careers/offer/${TOKEN}`);
    expect(sent).toBe(`Here is your offer again: ${rebuilt} Thanks.`);
  });

  test('two links in one reply keep their order through the queue and the replay', () => {
    const other = 'f'.repeat(64);
    const body = `Old: x.test/careers/offer/${TOKEN} New: x.test/careers/./offer/${other} Thanks.`;
    expect(offerLinkTokens(body)).toEqual([TOKEN, other]);
    expect(redactOfferLinks(body)).toBe(`Old: x.test/careers/offer/${OFFER_LINK_HIDDEN} New: ${HIDDEN_LINK} Thanks.`);
    expect(replayBodyFor('recruiting_comms_deferred', { eligible: true, offerTokens: offerLinkTokens(body) }, redactOfferLinks(body)))
      .toBe(`Old: x.test/careers/offer/${TOKEN} New: ${portalUrl(`/careers/offer/${other}`)} Thanks.`);
  });

  test('two links in one run keep their order when the other spelling comes first', () => {
    const other = 'f'.repeat(64);
    const body = `Links: x.test/careers/./offer/${other},x.test/careers/offer/${TOKEN} Thanks.`;
    expect(offerLinkTokens(body)).toEqual([other, TOKEN]);
    expect(redactOfferLinks(body)).toBe(`Links: ${HIDDEN_LINK} ${HIDDEN_LINK} Thanks.`);
    expect(replayBodyFor('recruiting_comms_deferred', { eligible: true, offerTokens: offerLinkTokens(body) }, redactOfferLinks(body)))
      .toBe(`Links: ${portalUrl(`/careers/offer/${other}`)} ${portalUrl(`/careers/offer/${TOKEN}`)} Thanks.`);
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

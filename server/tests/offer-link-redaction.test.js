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

const { createHash } = require('crypto');
const { decodeHTML } = require('entities');
const { redactOfferLinks, redactOfferLinksTogether, offerLinkTokens, OFFER_LINK_HIDDEN } = require('../utils/offer-link-redaction');
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

  // A run of text ends at a tag, so an email keeps the markup around a link stored as the standard hidden link.
  test('keeps the tags around a link it replaces as a whole', () => {
    const link = `HTTPS://PORTAL.WAVESPESTCONTROL.COM/CAREERS/OFFER/${TOKEN}`;
    const html = `<p style="margin:0 0 12px">${link}</p><p>Questions? Reply here.</p>`;
    expect(redactOfferLinks(html)).toBe(`<p style="margin:0 0 12px">${HIDDEN_LINK}</p><p>Questions? Reply here.</p>`);
    expect(offerLinkTokens(html)).toEqual([TOKEN]);
    expect(redactOfferLinks(`<td><b>${link}</b>.</td>`)).toBe(`<td><b>${HIDDEN_LINK}</b>.</td>`);
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

  // The token is the credential wherever it appears: a copy in the link's own query or fragment, or anywhere else in
  // the text, is hidden too. An unrelated 64-hex value stays.
  test('hides every other copy of a token it found on an offer path, and only those', () => {
    const { replayBodyFor } = require('../services/messaging/deferred-replay-registry');
    const ref = 'f'.repeat(64);
    const link = `https://portal.wavespestcontrol.com/careers/offer/${TOKEN}`;
    for (const tail of [`?ref=${TOKEN}`, `#${TOKEN}`, `?ref=${TOKEN.toUpperCase()}&x=${ref}`, `?r=%63%64${TOKEN.slice(2)}`]) {
      const text = `Your offer: ${link}${tail} thanks`;
      expect(redactOfferLinks(text)).toBe(`Your offer: ${HIDDEN_LINK} thanks`);
      expect(offerLinkTokens(text)).toEqual([TOKEN]);
    }
    const text = `Your offer: ${link} (code ${TOKEN}, ref ${ref}) <a href="https://x.test/?t=${TOKEN}">x</a>`;
    const stored = redactOfferLinks(text);
    expect(stored).toBe(`Your offer: https://portal.wavespestcontrol.com/careers/offer/${OFFER_LINK_HIDDEN} (code ${OFFER_LINK_HIDDEN} ref ${ref}) <a href="${OFFER_LINK_HIDDEN}">x</a>`);
    expect(offerLinkTokens(text)).toEqual([TOKEN]);
    expect(replayBodyFor('recruiting_comms_deferred', { eligible: true, offerTokens: offerLinkTokens(text) }, stored))
      .toBe(`Your offer: ${link} (code ${OFFER_LINK_HIDDEN} ref ${ref}) <a href="${OFFER_LINK_HIDDEN}">x</a>`);
  });

  // A reader sees a shown or copied link run together: a <wbr> or a <span> inside it, or a quoted reply that wraps it,
  // drops out. Each piece of a found token is hidden (the marker in the first unit, nothing in the rest) and the tags
  // stay. A link found only that way is not pinned, and its marker never forms the link the replay rebuilds.
  test('hides a link or a copy split by markup, spaces or line breaks, and keeps the markup', () => {
    const token = createHash('sha256').update('split').digest('hex');
    const link = `https://portal.wavespestcontrol.com/careers/offer/${token}`;
    const sent = `https://portal.wavespestcontrol.com/careers/offer/${OFFER_LINK_HIDDEN}`;
    const cases = [
      [`<p><a href="${link}">Read your offer</a></p><p>${link.slice(0, 80)}<wbr>${link.slice(80)}</p>`,
        `<p><a href="${sent}">Read your offer</a></p><p>${OFFER_LINK_HIDDEN}<wbr></p>`, [token]],
      [`<td><a href="${link}">${link.slice(0, 90)}<span style="color:#123">${link.slice(90)}</span></a></td>`,
        `<td><a href="${sent}">${OFFER_LINK_HIDDEN}<span style="color:#123"></span></a></td>`, [token]],
      [`<p>Your link: ${link.slice(0, 75)}<wbr>${link.slice(75)}</p>`, `<p>Your link: ${OFFER_LINK_HIDDEN}<wbr></p>`, []],
      [`Thanks!\n\n> Your offer:\n> ${link.slice(0, 70)}\n> ${link.slice(70)}\n> See you`,
        `Thanks!\n\n> Your offer:\n> ${OFFER_LINK_HIDDEN}\n> \n> See you`, []],
      [`Your offer: ${link} code ${token.slice(0, 32)} ${token.slice(32)} ok`, `Your offer: ${sent} code ${OFFER_LINK_HIDDEN}  ok`, [token]],
    ];
    for (const [text, stored, pinned] of cases) {
      expect(redactOfferLinks(text)).toBe(stored);
      expect(offerLinkTokens(text)).toEqual(pinned);
      expect(redactOfferLinks(stored)).toBe(stored);
    }
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

// What a reader can see in stored text, run together: once as plain text, once with the tags an email does not show
// dropped. Both decoded, quote markers (also decoded from &gt;), angle brackets and white space dropped, lowercase.
function readerViews(text) {
  const read = (value) => {
    let out = value.replace(/^>+ ?/gm, '');
    for (let pass = 0; pass < 4; pass += 1) {
      const next = decodeHTML(out).replace(/(?:%[0-9a-f]{2})+/gi, (m) => {
        try { return decodeURIComponent(m); } catch { return m; }
      });
      if (next === out) break;
      out = next;
    }
    return out.normalize('NFKC').replace(/[\s\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2800<>]/gu, '').toLowerCase();
  };
  return [read(text), read(text.replace(/<!--[\s\S]*?-->|<[^>]*>/g, ''))];
}

describe('a found token split anywhere is hidden in every piece', () => {
  // A token that does not repeat, as a real one does not. Every split point inside it, with each separator a reader
  // skips: markup an email shows nothing for, a space (also written &nbsp;, %C2%A0 or as a figure space), a line break,
  // a quoted reply's wrap (also as html writes it: "&gt; " after a line break or a <br>), an invisible character (a
  // zero-width space, a soft hyphen, a blank braille pattern).
  // The link split alone, beside the whole link in an href, and as a plain copy.
  const token = createHash('sha256').update('split grid').digest('hex');
  const link = `https://portal.wavespestcontrol.com/careers/offer/${token}`;
  const at = link.length - 64;
  const SEPARATORS = [
    '<wbr>', '<span>', '</span><span style="x">', '<!-- -->', ' ', '\n', '\n> ', '\n&gt; ', '<br>&gt;&gt; ', '&#8203;', '%E2%80%8B',
    '&nbsp;', '%C2%A0', '&#x2007;', '&shy;', '&#10240;',
  ];

  test('in every split, the stored text shows no piece run together into the token', () => {
    let checked = 0;
    for (let cut = 1; cut < 64; cut += 1) {
      for (const sep of SEPARATORS) {
        const split = `${link.slice(0, at + cut)}${sep}${link.slice(at + cut)}`;
        const copy = `${token.slice(0, cut)}${sep}${token.slice(cut)}`;
        const texts = [`<p>Your offer: ${split}</p>`, `<p><a href="${link}">Read it</a> or copy ${split}</p>`, `Open ${link} (code ${copy})`];
        for (const text of texts) {
          const stored = redactOfferLinks(text);
          for (const view of readerViews(stored)) expect(view).not.toContain(token);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(63 * SEPARATORS.length * 3);
  });
});

describe('past the decoding budget the text fails closed', () => {
  // Decoding stops after four passes. A unit that would still decode further may hide a route word, so that unit is
  // hidden whole, and every run of 64 hex in the text counts as a found token. A text that reads fully is unchanged.
  const token = createHash('sha256').update('decode budget').digest('hex');
  const layered = (k) => `https://portal.wavespestcontrol.com/careers/%${'25'.repeat(k - 1)}6Fffer/${token}`;

  test('a route word encoded four times is still read; five times hides the unit and every copy of the token', () => {
    expect(redactOfferLinks(`Open ${layered(4)} today`)).toBe(`Open ${portalUrl('/careers/offer/[link hidden]')} today`);
    expect(redactOfferLinks(`Open ${layered(5)} today`)).toBe('Open [link hidden] today');
    const stored = redactOfferLinks(`Open ${layered(5)} or copy ${token} today`);
    expect(stored).not.toContain(token.slice(0, 20));
    expect(stored).not.toContain(token.slice(-20));
    expect(redactOfferLinks(`<a href="${layered(6)}">Read your offer</a>`)).toBe('<a href="[link hidden]">Read your offer</a>');
    expect(offerLinkTokens(`Open ${layered(5)} today`)).toEqual([]); // nothing to pin: a held text with it is not queued
  });

  test('a text that reads fully keeps its 64 hex and its encodings', () => {
    for (const text of [`Build ${token} shipped`, 'Save 50% off &amp; more', 'Tracking: https://example.com/?u=https%253A%252F%252Fwaves.example']) {
      expect(redactOfferLinks(text)).toBe(text);
    }
  });
});

// Codex P0 (round 28): the email ledger redacted its subject, html and text one by one, so a copy of a token in a
// custom subject stayed readable when the link was only in the body.
describe('texts stored together are read as one record', () => {
  const token = createHash('sha256').update('stored together').digest('hex');
  const link = `https://portal.wavespestcontrol.com/careers/offer/${token}`;
  const hiddenLink = portalUrl('/careers/offer/[link hidden]');

  test('a copy of a token in one part is hidden when its link is only in another part', () => {
    const parts = [`Your offer code ${token}`, `<p>Hi Jane,</p><a href="${link}">Read your offer</a>`, 'Read it on your phone.'];
    expect(redactOfferLinks(parts[0])).toBe(parts[0]); // alone, a bare 64-hex word is not a link
    expect(redactOfferLinksTogether(parts)).toEqual([
      'Your offer code [link hidden]',
      `<p>Hi Jane,</p><a href="${hiddenLink}">Read your offer</a>`,
      'Read it on your phone.',
    ]);
  });

  test('a part past the decoding budget makes every part fail closed', () => {
    const layered5 = `https://portal.wavespestcontrol.com/careers/%${'25'.repeat(4)}6Fffer/${token}`;
    expect(redactOfferLinks(`Or copy ${token} into the page`)).toBe(`Or copy ${token} into the page`);
    expect(redactOfferLinksTogether([`Your offer ${layered5}`, `Or copy ${token} into the page`]))
      .toEqual(['Your offer [link hidden]', 'Or copy [link hidden] into the page']);
  });

  test('parts with no offer link come back unchanged, and a part that is not a string comes back as it is', () => {
    const parts = [`Build ${token} shipped`, '<p>See you Monday</p>', '', null, undefined];
    expect(redactOfferLinksTogether(parts)).toEqual(parts);
  });
});

// Codex P0 (round 29): the copy check read only the end of decoding, but the stored text is the unit as typed. A "%"
// right before a copy used up two of its hex digits in the decoded reading, so all 64 stayed in the stored text.
describe('a copy is looked for at every stage of decoding', () => {
  // Starts with a letter, so "%63" (a "c") cannot show it as typed in the middle case.
  const token = `c${createHash('sha256').update('every stage').digest('hex').slice(1)}`;
  const link = `https://portal.wavespestcontrol.com/careers/offer/${token}`;
  const hiddenLink = portalUrl('/careers/offer/[link hidden]');

  test.each([
    ['as typed, with a "%" before the copy', `%${token}`],
    ['as typed, with a "&#x" before the copy', `&#x${token}`],
    ['only between two passes ("%25%63" turns into "%c", which the next pass uses up)', `%25%63${token.slice(1)}`],
  ])('a copy readable %s is hidden, alone and in a record', (label, copy) => {
    expect(redactOfferLinks(`Read ${link} or code ${copy}`)).toBe(`Read ${hiddenLink} or code [link hidden]`);
    expect(redactOfferLinksTogether([`Your code ${copy}`, `<a href="${link}">Read</a>`])[0]).toBe('Your code [link hidden]');
  });

  test('a copy split by a tag after a "%" is hidden in every piece', () => {
    expect(redactOfferLinks(`<p>Code %${token.slice(0, 30)}<wbr>${token.slice(30)}</p><a href="${link}">Read</a>`))
      .toBe(`<p>Code [link hidden]<wbr></p><a href="${hiddenLink}">Read</a>`);
  });
});

describe('the joined text is decoded as a whole', () => {
  // An escape split by a tag or a line break decodes only once a reader puts the pieces together. Each case keeps the
  // token on the round 29 code, which decoded each unit alone.
  const token = createHash('sha256').update('joined escape').digest('hex');
  const link = `https://portal.wavespestcontrol.com/careers/offer/${token}`;
  const hiddenLink = portalUrl('/careers/offer/[link hidden]');
  const escaped = `%${token.charCodeAt(20).toString(16)}`; // the token's 21st character as a percent escape
  const head = `${token.slice(0, 20)}${escaped.slice(0, 2)}`;
  const tail = `${escaped.slice(2)}${token.slice(21)}`;

  test.each([
    ['the route word split inside an escape by a tag', `<p>Open https://portal.wavespestcontrol.com/careers/off%6<wbr>5r/${token}</p>`,
      '<p>Open https://portal.wavespestcontrol.com/careers/off%6<wbr>[link hidden]</p>'],
    ['the route word split inside an escape by a line break', `Open https://portal.wavespestcontrol.com/careers/off%6\n5r/${token} today`,
      'Open https://portal.wavespestcontrol.com/careers/off%6\n[link hidden] today'],
    ['the route word split inside a named reference by a tag (decoded with its case kept)', `<p>/care&Zero<wbr>WidthSpace;ers/offer/${token}</p>`,
      '<p>/care&Zero<wbr>[link hidden]</p>'],
    ['the token split inside an escape by a tag', `<p>Code: /careers/offer/${head}<b></b>${tail}</p>`, '<p>Code: [link hidden]<b></b></p>'],
  ])('%s: the token is hidden', (label, text, stored) => {
    expect(redactOfferLinks(text)).toBe(stored);
  });

  test.each([
    ['a line break', `${head}\n${tail}`, '[link hidden]\n'],
    ['a blank braille pattern', `${head}⠀${tail}`, '[link hidden]'],
  ])('a copy split inside an escape by %s is hidden, alone and in a record', (label, copy, hidden) => {
    expect(redactOfferLinks(`Read ${link} or code ${copy}`)).toBe(`Read ${hiddenLink} or code ${hidden}`);
    expect(redactOfferLinksTogether([`Your code ${copy}`, `<a href="${link}">Read</a>`])[0]).toBe(`Your code ${hidden}`);
  });

  test("a copy split inside an escape by a space in the link's own quoted value is hidden", () => {
    expect(redactOfferLinks(`<a href="${link}?c=${head} ${tail}">Read</a>`)).toBe(`<a href="${hiddenLink}">Read</a>`);
  });

  test('joined text still encoded after four passes fails closed', () => {
    // Every character of the path escaped, then each "%" escaped four more times (five levels), and each escape split
    // by a tag after "%2", so no unit alone holds a whole escape.
    let deep = [...`/careers/offer/${token}`].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
    for (let level = 0; level < 4; level += 1) deep = deep.replace(/%/g, '%25');
    const stored = redactOfferLinks(`<p>Code ${deep.replace(/%2/g, '%2<wbr>')}</p>`);
    let read = stored.replace(/<[^>]*>/g, '').replace(/\s/g, '');
    for (let pass = 0; pass < 8; pass += 1) {
      read = decodeHTML(read).replace(/(?:%[0-9a-f]{2})+/gi, (m) => { try { return decodeURIComponent(m); } catch { return m; } });
    }
    expect(read.toLowerCase()).not.toContain(token);
    expect(stored.startsWith('<p>Code [link hidden]<wbr>')).toBe(true);
  });

  test('a text with split escapes and no offer link comes back unchanged', () => {
    const text = '<p>Fees: 5%&nbsp;off &amp; more, %41 &Tab; x, a%2<wbr>Fb and /care&Zero<wbr>WidthSpace;ers/jobs</p>';
    expect(redactOfferLinks(text)).toBe(text);
  });

  // Codex P1 (round 34): a match of "&" and the letters and digits after it decodes only as far as the name decodeHTML
  // knows ("&amp" of "&ampnotes"). The round 34 code mapped the whole match back as one piece, so a token found in it
  // hid every unit of the run with it: the words around the token, and on the past-budget path part of a tag too.
  test('a named reference decodes only as far as its name: only the token is hidden, the words around it stay', () => {
    const token = createHash('sha256').update('amp run').digest('hex');
    const text = `<p>Read ${portalUrl(`/careers/offer/${token}`)}</p>`
      + `<p>&amp<b></b>notes<b></b>${token.slice(0, 32)}<b></b>${token.slice(32)}<b></b>more<b></b>words</p>`;
    const stored = redactOfferLinks(text);
    expect(stored).toContain('<p>&amp<b></b>notes<b></b>[link hidden]<b></b><b></b>more<b></b>words</p>');
    for (const view of readerViews(stored)) expect(view).not.toContain(token);
  });

  test('past the budget, only the units of the reference still encoded are hidden, never the words or tags after it', () => {
    const text = `<p>Notes: &${'amp;'.repeat(4)}amp<b></b>notes<b></b>more words</p>`;
    expect(redactOfferLinks(text)).toBe('<p>Notes: [link hidden]<b></b>notes<b></b>more words</p>');
  });
});

describe('malformed markup', () => {
  const token = createHash('sha256').update('malformed markup').digest('hex');
  test.each([
    ['unfinished tag starts', '<a '],
    ['tag starts inside a tag', '<<a'],
    ['unclosed quotes', '<a "x '],
    ['unclosed comments', '<!-- '],
  ])('%s: a link after them is still hidden, and the rest is kept', (name, piece) => {
    const filler = piece.repeat(400);
    expect(redactOfferLinks(`${filler} Open ${portalUrl(`/careers/offer/${token}`)} today`))
      .toBe(`${filler} Open ${portalUrl('/careers/offer/[link hidden]')} today`);
  });

});

describe('a large text costs work in proportion to its length', () => {
  // Every stored text is redacted on the request, inbound ones with no offer link included, so the work must grow with
  // the length of the text only. Measured in CPU time, which a busy machine does not stretch as it does wall time.
  // On the code before round 25: 100 KB of "<a " took about 6 s of CPU (the tag pattern rescanned the rest of the body
  // from each "<"), and 6,000 distinct links about 7 s (one search of the whole text per found token). On the round 26
  // code, 6,000 links run together in one unit took about 4 s (a search of the unit for each sort comparison). All now
  // take under 1 s.
  const cpuMs = (run) => {
    const start = process.cpuUsage();
    run();
    const { user, system } = process.cpuUsage(start);
    return (user + system) / 1000;
  };

  test('200 KB of unfinished tag starts comes back unchanged', () => {
    for (const piece of ['<a ', '<<a']) {
      const body = piece.repeat(Math.ceil(200000 / piece.length));
      let stored;
      expect(cpuMs(() => { stored = redactOfferLinks(body); })).toBeLessThan(3000);
      expect(stored).toBe(body);
    }
  }, 120000);

  test('6,000 distinct links, each also copied split by markup, are all hidden', () => {
    const tokens = Array.from({ length: 6000 }, (_, i) => createHash('sha256').update(`many links ${i}`).digest('hex'));
    const text = tokens.map((t, i) => `Link ${i}: ${portalUrl(`/careers/offer/${t}`)} and copy ${t.slice(0, 32)}<wbr>${t.slice(32)}`).join('\n');
    let stored;
    expect(cpuMs(() => { stored = redactOfferLinks(text); })).toBeLessThan(3000);
    expect(stored).not.toMatch(/[0-9a-f]{32}/);
    expect(stored.split(portalUrl('/careers/offer/[link hidden]')).length - 1).toBe(6000);
  }, 120000);

  test('1,000 tokens in one run of escapes that spans a unit per escape are all hidden', () => {
    // About 1 s of CPU here. On the round 33 code it took about 8 s, growing with the square of the count: each token
    // found in the decoded run mapped back to the whole run, and so to every unit in it.
    const tokens = Array.from({ length: 1000 }, (_, i) => createHash('sha256').update(`escape run ${i}`).digest('hex'));
    const links = tokens.map((t) => portalUrl(`/careers/offer/${t}`)).join(' ');
    const run = tokens.join('').split('').map((c) => `%${c.charCodeAt(0).toString(16)}`).join('<b></b>');
    let stored;
    expect(cpuMs(() => { stored = redactOfferLinks(`<p>${links}</p><p>${run}</p>`); })).toBeLessThan(4000);
    for (const view of readerViews(stored)) expect(view).not.toMatch(/[0-9a-f]{64}/);
  }, 120000);

  test('16,000 distinct links in one unit with an escape (so the text is also decoded as a whole) are all hidden', () => {
    // About 1.3 s of CPU here. On the round 30 code it took about 8.7 s, growing with the square of the count (each
    // token was looked up in a scan of its whole unit).
    const tokens = Array.from({ length: 16000 }, (_, i) => createHash('sha256').update(`decoded unit ${i}`).digest('hex'));
    const body = `${tokens.map((t) => portalUrl(`/careers/offer/${t}`)).join(',')},%41`;
    let stored;
    expect(cpuMs(() => { stored = redactOfferLinks(body); })).toBeLessThan(4000);
    expect(stored).not.toMatch(/[0-9a-f]{64}/);
    expect(stored.split(portalUrl('/careers/offer/[link hidden]')).length - 1).toBe(16000);
  }, 120000);

  test('8,000 distinct links run together in one unit are all hidden and pinned in order', () => {
    const tokens = Array.from({ length: 8000 }, (_, i) => createHash('sha256').update(`one unit ${i}`).digest('hex'));
    // Not the sent spelling, so the unit is hidden whole: one standard hidden link per token, in source order.
    const text = tokens.map((t) => portalUrl(`/Careers/Offer/${t}`)).join(',');
    let stored;
    expect(cpuMs(() => { stored = redactOfferLinks(text); })).toBeLessThan(2500);
    expect(stored).not.toMatch(/[0-9a-f]{32}/);
    expect(stored.split(portalUrl('/careers/offer/[link hidden]')).length - 1).toBe(8000);
    expect(offerLinkTokens(text)).toEqual(tokens);
  }, 120000);
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
  const count = (file) => (fs.readFileSync(path.join(__dirname, '..', file), 'utf8').match(/redactOfferLinks(?:Together)?\(/g) || []).length;

  test.each([
    ['services/twilio.js', 2], // the sms_log row and the unified messages row
    ['services/messaging/audit.js', 1], // the audit preview
    ['services/sms-suggest-mode.js', 2], // the reply-holding reservation row, written and renewed
    // history masking, the email history and the email ledger (each email's parts together), the deferred queue row
    ['services/recruiting-comms.js', 4],
  ])('%s calls redactOfferLinks (or its together form) at least %i time(s)', (file, minimum) => {
    expect(count(file)).toBeGreaterThanOrEqual(minimum);
  });
});

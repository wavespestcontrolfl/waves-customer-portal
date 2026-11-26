/**
 * Short weekly format (owner approved 2026-11-26; supersedes the 2026-07-28
 * "Beehiiv comedic format" reversal for the Waves Newsletter): 3 "This
 * weekend" points, a subscribe line, events under day headers in start-time
 * order, each event = bold "Name · Town", one fixed fact line, ONE sentence,
 * the tracked details link. Code renders the structure; the model supplies
 * only the sentence per event, the points, the subject and the opening line.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const {
  assembleWeeklyNewsletter,
  buildFlagshipTextBody,
  lockEventFactsFromDb,
  sanitizeProseFields,
} = require('../services/newsletter-draft');
const { findHallucinatedClaims, validateNewsletterDraft } = require('../services/newsletter-validator');
const { validateVoice } = require('../config/voice-profiles');
const { resolveEvclickDirect } = require('../services/newsletter-event-clicks');

const ID = (n) => `a000000${n}-0000-4000-8000-00000000000${n}`;
// 2026-11-26 is a Thursday. 22:00Z = 5:00 PM Eastern (EST, UTC-5).
const FRI_5PM = '2026-11-27T22:00:00Z';

const mk = (n, over = {}) => ({
  eventId: ID(n),
  sourceTitle: `Official Event ${n}`,
  town: 'Sarasota',
  venue: `Venue ${n}`,
  startAt: FRI_5PM,
  eventUrl: `https://example.com/ev${n}`,
  labels: [],
  priceText: null,
  why: `A good reason to go to number ${n}.`,
  ...over,
});

const issue = (events, over = {}) => ({
  selectedSubject: 'Test',
  greeting: 'Hey there!',
  introText: 'Short week, long list.',
  weekendPoints: ['Point one', 'Point two', 'Point three'],
  events,
  signoff: '— The Waves Team',
  ...over,
});

describe('short weekly format: one event', () => {
  test('bold "Name · Town", the fixed fact line, one sentence, the tracked details link, nothing else', async () => {
    const html = await assembleWeeklyNewsletter(issue([mk(1, { labels: ['Free'] })], { weekendPoints: [] }));
    expect(html).toContain('<strong>Official Event 1 · Sarasota</strong>');
    expect(html).toContain('Fri, Nov 27 • 5:00 PM • Free · Venue 1');
    expect(html).toContain('A good reason to go to number 1.');
    expect(html).toContain('<a href="{{evclick:a0000001-0000-4000-8000-000000000001}}"');
    expect(html).toContain('Details →');
    // The retired comedic devices are gone.
    expect(html).not.toMatch(/Pro tip|scoop|<img|giphy|P\.S\.|✔️|<details|Homeowner Minute|Forward them this email/);
    // No bullet list under an event (the weekend points are the only list).
    expect(html).not.toContain('<li');
    // The details link is the one link in the event, and it is the tracked token.
    expect(html).not.toContain('href="https://example.com/ev1"');
  });

  test('the time has an ordinary space before PM (no narrow no-break space from newer ICU)', async () => {
    const html = await assembleWeeklyNewsletter(issue([mk(1)]));
    expect(html).not.toMatch(/[  ]/);
    expect(html).toContain('5:00 PM');
  });

  test('price: the locked price text in its pair-verified span when the event is not strictly free; "Free" only on the strict label', async () => {
    const priced = await assembleWeeklyNewsletter(issue([mk(1, { priceText: 'From $25' })]));
    expect(priced).toContain('Fri, Nov 27 • 5:00 PM • <span data-db-price="a0000001-0000-4000-8000-000000000001">From $25</span> · Venue 1');
    expect(priced).not.toMatch(/\bFree\b/);
    expect(findHallucinatedClaims(priced, [{ eventId: ID(1), price: 'From $25' }], 'html')).toEqual([]);
    // Free wins over a price text; no price known = no price on the line.
    const free = await assembleWeeklyNewsletter(issue([mk(1, { labels: ['Free'], priceText: '$0' })]));
    expect(free).toContain('5:00 PM • Free · Venue 1');
    expect(free).not.toContain('data-db-price');
    // A qualified free ("Free for members") keeps its price text even though
    // the strict Free label fires; only a plain free / $0 reads "Free".
    const members = await assembleWeeklyNewsletter(issue([mk(1, { labels: ['Free'], priceText: 'Free for members' })]));
    expect(members).toContain('<span data-db-price="a0000001-0000-4000-8000-000000000001">Free for members</span>');
    expect(members).not.toMatch(/• Free ·/);
    for (const plain of ['Free', 'free admission', '$0', '$0.00', 'Free!']) {
      const h = await assembleWeeklyNewsletter(issue([mk(1, { labels: ['Free'], priceText: plain })]));
      expect(h).toContain('5:00 PM • Free · Venue 1');
    }
    const unknown = await assembleWeeklyNewsletter(issue([mk(1)]));
    expect(unknown).toContain('Fri, Nov 27 • 5:00 PM · Venue 1');
  });

  test('no venue: the line ends at the price or time; no town: the heading is the bare name', async () => {
    const html = await assembleWeeklyNewsletter(issue([mk(1, { venue: null, town: null })]));
    expect(html).toContain('<strong>Official Event 1</strong>');
    expect(html).toContain('>Fri, Nov 27 • 5:00 PM</p>');
  });

  test('no event url: no details link, but the event still renders; no eventId: the link is the direct url', async () => {
    const noUrl = await assembleWeeklyNewsletter(issue([mk(1, { eventUrl: null })]));
    expect(noUrl).toContain('Official Event 1');
    expect(noUrl).not.toContain('Details →');
    const noId = await assembleWeeklyNewsletter(issue([mk(1, { eventId: null })]));
    expect(noId).toContain('<a href="https://example.com/ev1"');
    expect(noId).not.toContain('{{evclick:');
  });

  test('event copy is escaped: markup in the name, venue or sentence stays inert text', async () => {
    const html = await assembleWeeklyNewsletter(issue([mk(1, {
      sourceTitle: 'Show <img src=x onerror=alert(1)>',
      venue: 'Hall <script>x</script>',
      why: 'Go <a href="https://evil.example">here</a>.',
    })]));
    expect(html).not.toMatch(/<img|<script|href="https:\/\/evil/);
    expect(html).toContain('&lt;img');
  });
});

describe('short weekly format: day grouping and order', () => {
  test('Thursday, Friday, Saturday, Sunday, then a later day under its own name; start-time order inside a day', async () => {
    const html = await assembleWeeklyNewsletter(issue([
      mk(1, { startAt: '2026-11-30T23:00:00Z' }), // Monday 6 PM
      mk(2, { startAt: '2026-11-28T14:00:00Z' }), // Saturday 9 AM
      mk(3, { startAt: '2026-11-26T23:00:00Z' }), // Thursday 6 PM
      mk(4, { startAt: '2026-11-28T01:00:00Z' }), // Friday 8 PM (Nov 27, ET)
      mk(5, { startAt: '2026-11-28T22:00:00Z' }), // Saturday 5 PM
      mk(6, { startAt: '2026-11-29T20:00:00Z' }), // Sunday 3 PM
    ]));
    const headers = [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1]);
    expect(headers).toEqual(['Thursday', 'Friday', 'Saturday', 'Sunday', 'Monday']);
    const order = [...html.matchAll(/<strong>Official Event (\d) · Sarasota<\/strong>/g)].map((m) => m[1]);
    expect(order).toEqual(['3', '4', '2', '5', '6', '1']);
  });

  test('two dates that share a weekday get the date in their headers; undated events go last', async () => {
    const html = await assembleWeeklyNewsletter(issue([
      mk(1, { startAt: '2026-12-03T23:00:00Z' }),
      mk(2, { startAt: '2026-11-26T23:00:00Z' }),
      mk(3, { startAt: null }),
    ]));
    const headers = [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1]);
    expect(headers).toEqual(['Thursday, Nov 26', 'Thursday, Dec 3', 'Date to be confirmed']);
  });

  test('the day is the Eastern day, not the UTC day (9 PM Friday ET is Saturday in UTC)', async () => {
    const html = await assembleWeeklyNewsletter(issue([mk(1, { startAt: '2026-11-28T02:00:00Z' })]));
    expect(html).toContain('<h2');
    expect(html).toMatch(/>Friday<\/h2>/);
    expect(html).toContain('Fri, Nov 27 • 9:00 PM');
  });
});

describe('short weekly format: top and end of the issue', () => {
  test('greeting, opening line, exactly 3 "This weekend" points, then the subscribe line, then the first day', async () => {
    const html = await assembleWeeklyNewsletter(issue([mk(1)], {
      weekendPoints: ['One', 'Two', 'Three', 'Four'],
    }));
    expect(html.match(/<li/g)).toHaveLength(3);
    expect(html).not.toContain('Four');
    expect(html).toContain('<strong>This weekend</strong>');
    expect(html).toMatch(/Forwarded this\? <a href="https:\/\/www\.wavespestcontrol\.com\/newsletter\/"[^>]*>Subscribe free<\/a>/);
    // The site's sign-up page reads no source parameter, so the link has none.
    expect(html).not.toContain('?src=');
    const at = (s) => html.indexOf(s);
    expect(at('Hey there{{greeting-name}}!')).toBeLessThan(at('Short week, long list.'));
    expect(at('Short week, long list.')).toBeLessThan(at('This weekend'));
    expect(at('This weekend')).toBeLessThan(at('Forwarded this?'));
    expect(at('Forwarded this?')).toBeLessThan(at('>Friday<'));
  });

  test('end: poll, then "Dates can change", then the sign-off, then the feedback token; retired closing fields never render', async () => {
    const html = await assembleWeeklyNewsletter(issue([mk(1)], {
      closingHeading: 'That is the scoop',
      closingText: 'Callback joke triad.',
      closingChecklist: ['Hydrate like it is your job'],
      ps: 'P.S. forward to a friend. 🤡',
      transitionLine: 'Let us get into it',
      introGifTerm: 'dance',
    }));
    expect(html).not.toMatch(/scoop|Callback joke|Hydrate|forward to a friend|Let us get into it/);
    const withPoll = await assembleWeeklyNewsletter(issue([mk(1)]), { pollQuizId: 'nl-poll-weekend-v1' });
    const at = (s) => withPoll.indexOf(s);
    expect(at('Official Event 1')).toBeLessThan(at('Dates can change. Check before you go.'));
    expect(at('Dates can change. Check before you go.')).toBeLessThan(at('— The Waves Team'));
    expect(at('— The Waves Team')).toBeLessThan(at('{{feedback'));
  });

  test('no weekend points: no empty "This weekend" block', async () => {
    const html = await assembleWeeklyNewsletter(issue([mk(1)], { weekendPoints: undefined }));
    expect(html).not.toContain('This weekend');
    expect(html).toContain('Forwarded this?');
  });
});

describe('short weekly format: plain-text part', () => {
  const text = (events, over, opts) => buildFlagshipTextBody(issue(events, over), opts);

  test('same pieces, same order: heading, fact line, sentence, details token; subscribe line with the full url', () => {
    const body = text([mk(1, { labels: ['Free'] })]);
    expect(body).toContain('Hey there{{greeting-name}}!');
    expect(body).toContain('This weekend\n- Point one\n- Point two\n- Point three');
    expect(body).toContain('Forwarded this? Subscribe free: https://www.wavespestcontrol.com/newsletter/');
    expect(body).toContain('== Friday ==');
    expect(body).toContain('Official Event 1 · Sarasota\nFri, Nov 27 • 5:00 PM • Free · Venue 1\nA good reason to go to number 1.\nDetails: {{evclick:a0000001-0000-4000-8000-000000000001}}');
    expect(body).toContain('Dates can change. Check before you go.');
    expect(body).toContain('{{feedback-text}}');
    expect(body).not.toMatch(/Pro tip|\[ \]|P\.S\.|\*\*/);
  });

  test('the locked price rides as "Tickets: <price>" right before its own details token, and the claim scan passes it by the event/price pair', () => {
    const body = text([mk(1, { priceText: 'From $25' })]);
    expect(body).toContain('Fri, Nov 27 • 5:00 PM · Venue 1\nA good reason to go to number 1.\nTickets: From $25 · Details: {{evclick:a0000001-0000-4000-8000-000000000001}}');
    expect(findHallucinatedClaims(body, [{ eventId: ID(1), price: 'From $25' }], 'text')).toEqual([]);
    // Event A's line wearing Event B's real price still blocks.
    expect(findHallucinatedClaims(body, [{ eventId: ID(2), price: 'From $25' }], 'text')).not.toEqual([]);
  });

  test('sentence and venue length cannot remove a price: it sits next to its token, so the claim scan still passes it', () => {
    const longWhy = 'A very long sentence about why this one is worth the whole drive, the parking and the wait, twice over, with a lot of extra words. '.repeat(4).trim();
    const longVenue = 'The Extremely Long Named Municipal Waterfront Park and Amphitheater Complex at the Old Bay Pier';
    const body = text([mk(1, { priceText: 'From $25', why: longWhy, venue: longVenue })]);
    expect(body).toContain('Tickets: From $25 · Details: {{evclick:a0000001');
    expect(findHallucinatedClaims(body, [{ eventId: ID(1), price: 'From $25' }], 'text')).toEqual([]);
  });

  test('an event with no details link has no token to verify its price against: the text part omits it, the HTML keeps it', async () => {
    const noLink = text([mk(1, { priceText: 'From $25', eventUrl: null })]);
    expect(noLink).not.toContain('$25');
    const noId = text([mk(1, { priceText: 'From $25', eventId: null })]);
    expect(noId).not.toContain('$25');
    expect(findHallucinatedClaims(noId, [{ eventId: ID(1), price: 'From $25' }], 'text')).toEqual([]);
    const html = await assembleWeeklyNewsletter(issue([mk(1, { priceText: 'From $25', eventUrl: null })]));
    expect(html).toContain('From $25');
  });

  test('a qualified free ("Free for members") is carried in the text part too, never shortened to "Free"', () => {
    const body = text([mk(1, { labels: ['Free'], priceText: 'Free for members' })]);
    expect(body).toContain('Tickets: Free for members · Details: {{evclick:a0000001');
    expect(body).not.toMatch(/• Free/);
  });

  test('events follow the same day order as the HTML', () => {
    const body = text([
      mk(1, { startAt: '2026-11-29T20:00:00Z' }),
      mk(2, { startAt: '2026-11-26T23:00:00Z' }),
    ]);
    expect(body.indexOf('== Thursday ==')).toBeLessThan(body.indexOf('Official Event 2'));
    expect(body.indexOf('Official Event 2')).toBeLessThan(body.indexOf('== Sunday =='));
    expect(body.indexOf('== Sunday ==')).toBeLessThan(body.indexOf('Official Event 1'));
  });

  test('proof, preview and archive resolve the token to the direct event url', () => {
    const body = resolveEvclickDirect(text([mk(1)]), new Map([[ID(1), 'https://example.com/ev1']]));
    expect(body).not.toContain('{{evclick:');
  });
});

describe('short weekly format: every send gate still passes', () => {
  const lineup = () => [
    mk(1, { labels: ['Free'], startAt: '2026-11-26T23:00:00Z' }),
    mk(2, { priceText: 'From $25', startAt: '2026-11-28T22:00:00Z' }),
    mk(3, { startAt: '2026-11-29T20:00:00Z' }),
  ];

  test('claim scan, voice check and the send gate see a clean issue in both parts', async () => {
    const draft = issue(lineup());
    const html = await assembleWeeklyNewsletter(draft, { pollQuizId: null });
    const textBody = buildFlagshipTextBody(draft);
    const lockedPrices = [{ eventId: ID(2), price: 'From $25' }];
    const { errors } = validateNewsletterDraft({
      subject: '🎄 Boat parade in Venice, tree lighting in Sarasota',
      preview_text: 'Three weekend picks from Sarasota to Venice.',
      html_body: html,
      text_body: textBody,
      newsletter_type: 'local-weekly-fresh-events',
    }, { recipientCount: 10, lockedPrices });
    expect(errors).toEqual([]);
    expect(validateVoice({ subject: 'Weekend picks', htmlBody: html, textBody }, 'waves_phase_3_local').warnings).toEqual([]);
    // The subscribe line counts as the issue's CTA, so the advisory warning stays quiet.
    const warned = validateNewsletterDraft({
      subject: 'Weekend picks', preview_text: 'p', html_body: html, text_body: textBody, newsletter_type: 'local-weekly-fresh-events',
    }, { recipientCount: 10, lockedPrices });
    expect(warned.warnings).not.toContain('No Waves CTA detected');
  });

  test('a model sentence that invents a price still hard-blocks the send', async () => {
    const draft = issue([mk(1, { why: 'Tickets are $15 at the door.' })]);
    const { errors } = validateNewsletterDraft({
      subject: 'Weekend picks',
      preview_text: 'p',
      html_body: await assembleWeeklyNewsletter(draft),
      text_body: buildFlagshipTextBody(draft),
      newsletter_type: 'local-weekly-fresh-events',
    }, { recipientCount: 10, lockedPrices: [] });
    expect(errors.join('\n')).toMatch(/dollar amount/);
  });
});

describe('short weekly format: what the writer may supply', () => {
  test('lockEventFactsFromDb carries the DB town and venue and strips URLs from the sentence', () => {
    const row = {
      id: ID(1), title: 'Harbor Art Walk', city: 'anna-maria', venue_name: ' City Pier ', venue_address: '1 Pier Way',
      start_at: FRI_5PM, event_url: 'https://example.com/ev1',
    };
    const { locked } = lockEventFactsFromDb([
      { eventId: ID(1), why: 'See it at https://spam.example/x today.', town: 'Fake Town', venue: 'Fake Venue' },
    ], [row]);
    expect(locked).toHaveLength(1);
    expect(locked[0]).toMatchObject({ town: 'Anna Maria', venue: 'City Pier', sourceTitle: 'Harbor Art Walk' });
    expect(locked[0].why).not.toContain('spam.example');
  });

  test('sanitizeProseFields keeps at most three points, strips URLs, drops blanks', () => {
    const draft = sanitizeProseFields({
      weekendPoints: ['Go to https://x.example now', '  ', 'Two', 'Three', 'Four'],
    });
    expect(draft.weekendPoints).toEqual(['Go to now', 'Two', 'Three']);
    expect(sanitizeProseFields({}).weekendPoints).toEqual([]);
  });
});

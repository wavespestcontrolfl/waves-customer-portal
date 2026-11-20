/**
 * siteone-deal-end-date — the AI end-date read for the Monday SiteOne deals bell
 * (GATE_SITEONE_DEAL_AI_END_DATE, owner 2026-11-19 "B").
 *
 * Pins: what the model reads (whole email, links and quoted reply history removed, entities
 * decoded, HTML tags out with line breaks kept, subject and text capped, with a flag when a cap
 * cut it) and that the HTML scan stays linear on a hostile body; an answer is kept only with a
 * real calendar day from the received ET day to a year on and with whole words of the email
 * (spaces, case, curly quotes, dashes and edge marks aside; a year written right after them
 * joins them) that name that day as the last day of their sentence (a date in them, else a
 * weekday within a week, "tonight" or "tomorrow"); null = no
 * end only beside a null quote and only on an email no cap cut; the request (Haiku pin, lane,
 * prompt, one call per deal up to the cap, bodies re-read in one query); and every miss (no
 * key, body read failure, API error, refusal, cut reply, bad JSON, words not found, words for
 * another day, half-null, words at a cap's cut, "no end" on a cut email) leaves no entry, so the bell keeps its
 * date-pattern line. Fakes only: no network, no database.
 * All names and text are synthetic.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockCreate = jest.fn();
const mockSdk = jest.fn(() => ({ messages: { create: (...args) => mockCreate(...args) } }));
// A plain function, so `new Anthropic(...)` works and hands back the fake client.
jest.mock('@anthropic-ai/sdk', () => function MockAnthropic(...args) { return mockSdk(...args); });

const mockLedger = jest.fn((provider, model, fn) => fn());
const mockRejected = jest.fn();
jest.mock('../services/llm-dispatch-metrics', () => ({
  ledgerCall: (...args) => mockLedger(...args),
  ledgerCallRejected: (...args) => mockRejected(...args),
}));

const logger = require('../services/logger');
const MODELS = require('../config/models');
const {
  readDealEndDates, MAX_READS, BODY_TEXT_CHARS, BODY_HTML_CHARS, MODEL_TEXT_CHARS, SUBJECT_CHARS,
  _test: { readableEmail, checkAnswer, parseAnswer, SYSTEM_PROMPT },
} = require('../services/procurement/siteone-deal-end-date');

// The text the model reads.
const endDateText = (email) => readableEmail(email).text;

const PROMO = 'Last chance for 10% off select items. View online: https://click.example.com/abc?u=1\n*Offers valid March 1 &ndash; April 30, 2026. Bid projects are not eligible.';

describe('readableEmail', () => {
  test('body_text: links out, entities decoded, spaces and blank lines collapsed', () => {
    const text = endDateText({ body_text: `${PROMO}\r\n\r\n \r\n\tSee you &#8211; Sam &#x2014; &bogus; &#99999999;` });
    expect(text).toBe('Last chance for 10% off select items. View online:\n*Offers valid March 1 – April 30, 2026. Bid projects are not eligible.\nSee you – Sam — &bogus; &#99999999;');
  });

  test('body_html when there is no text part: scripts and styles out, line breaks kept, tags out', () => {
    const html = '<style>p{color:red}</style><p>Fall <b>rebate</b> on Demand CS</p><script>var x = "<p>ends May 1</p>";</script>Ends Oct 31<br/>Thanks';
    expect(endDateText({ body_text: '  ', body_html: html })).toBe('Fall rebate on Demand CS\nEnds Oct 31\nThanks');
  });

  test('an unclosed script, or a "<" with no ">", ends the text', () => {
    expect(endDateText({ body_html: 'Ends Nov 30 <script>junk ends Dec 1' })).toBe('Ends Nov 30');
    expect(endDateText({ body_html: 'Ends Nov 30 < and more' })).toBe('Ends Nov 30');
  });

  test('caps what the model reads', () => {
    expect(endDateText({ body_text: 'x '.repeat(MODEL_TEXT_CHARS) }).length).toBe(MODEL_TEXT_CHARS);
  });

  test('flags an email a cap cut short: the body re-read cap or the model text cap', () => {
    expect(readableEmail({ body_text: PROMO }).cut).toBe(false);
    expect(readableEmail({ body_text: 'Deal on Demand CS.'.padEnd(BODY_TEXT_CHARS - 1) })).toEqual({ subject: '', text: 'Deal on Demand CS.', cut: false, partial: false });
    expect(readableEmail({ body_text: 'Deal on Demand CS.'.padEnd(BODY_TEXT_CHARS) })).toEqual({ subject: '', text: 'Deal on Demand CS.', cut: true, partial: true });
    expect(readableEmail({ body_text: null, body_html: '<p>Deal on Demand CS.</p>'.padEnd(BODY_HTML_CHARS) })).toEqual({ subject: '', text: 'Deal on Demand CS.', cut: true, partial: true });
    const long = readableEmail({ body_text: 'Spring savings. '.repeat(1500) }); // 24,000 characters: under the re-read cap, over the model's
    expect(long.cut).toBe(true);
    expect(long.text.length).toBe(MODEL_TEXT_CHARS);
  });

  // Pre-push audit on 5d207d2410 (P1): an old "ends tomorrow" in quoted history was read against the reply's date.
  test('drops quoted reply history, as the date patterns do; a re-read cap that cut only history does not count', () => {
    const thread = 'Ends Friday.\nOn Mon, Apr 13, 2026 at 9:00 AM Sam Rep <sam@example.com> wrote:\n> Flash sale ends tomorrow.';
    expect(readableEmail({ body_text: thread })).toEqual({ subject: '', text: 'Ends Friday.', cut: false, partial: false });
    expect(endDateText({ body_text: 'Thanks!\nFrom: Sam Rep\nSent: Monday\nOffer ends tomorrow.' })).toBe('Thanks!');
    expect(endDateText({ body_text: 'Thanks!\n-----Original Message-----\nOffer ends tomorrow.' })).toBe('Thanks!');
    const longThread = `${thread}\n${'> older text\n'.repeat(3000)}`.slice(0, BODY_TEXT_CHARS);
    expect(readableEmail({ body_text: longThread })).toEqual({ subject: '', text: 'Ends Friday.', cut: false, partial: false });
  });

  // Pre-push audit on be6684f834 (P1): a ">" line with no "On ... wrote:" line above it was read.
  test('drops each line that starts with ">", and the email counts as partly read', () => {
    expect(readableEmail({ body_text: 'Thanks for the update.\n> Flash sale ends tomorrow.\n>> Older: ends Friday\nSam' }))
      .toEqual({ subject: '', text: 'Thanks for the update.\nSam', cut: false, partial: true });
    expect(readableEmail({ body_text: '> Flash sale ends tomorrow.' })).toEqual({ subject: '', text: '', cut: false, partial: true });
    // A ">" inside a line is no quote mark.
    expect(readableEmail({ body_text: 'Spend > $500, get 5% back. Ends May 1.' }).partial).toBe(false);
  });

  // Pre-push audit on 8cdbc9728d (P1): an HTML reply kept its <blockquote> when no "On ... wrote:" line marked it.
  test('HTML: every <blockquote> is dropped whole, nested ones too, and the email counts as partly read', () => {
    const html = '<div>Thanks, ordering now.</div><blockquote type="cite"><div>Flash sale ends tomorrow.</div>'
      + '<BLOCKQUOTE>Older: ends Friday</BLOCKQUOTE>still quoted</blockquote><div>Sam</div>';
    // Partly read: the block may be a styled part of this email, so "no end" there is a miss.
    expect(readableEmail({ body_html: html })).toEqual({ subject: '', text: 'Thanks, ordering now.\nSam', cut: false, partial: true });
    expect(endDateText({ body_html: '<p>Hi</p><blockquote>quoted, never closed' })).toBe('Hi');
    expect(readableEmail({ body_html: '<p>Ends May 1.</p>' }).partial).toBe(false);
    // body_text is read when there is one, so the HTML's blocks do not count.
    expect(readableEmail({ body_text: 'Ends May 1.', body_html: html }).partial).toBe(false);
  });

  // Pre-push audit on 5d207d2410 (P1): the subject went to the model whole, links and all.
  test('the subject: links out, one line, at most SUBJECT_CHARS; the text gets what is left of the model cap', () => {
    expect(readableEmail({ subject: 'Spring  deals https://click.example.com/x?u=1 inside', body_text: 'Ends May 1.' }))
      .toEqual({ subject: 'Spring deals inside', text: 'Ends May 1.', cut: false, partial: false });
    const atCap = readableEmail({ subject: 'S'.repeat(SUBJECT_CHARS), body_text: 'x '.repeat(MODEL_TEXT_CHARS) });
    expect(atCap.subject.length).toBe(SUBJECT_CHARS);
    expect(atCap.text.length).toBe(MODEL_TEXT_CHARS - SUBJECT_CHARS);
    expect(atCap.cut).toBe(true);
    // Pre-push audit on 8cdbc9728d: a cut subject could end mid-date ("Ends May 3" of "May 30"), so a longer one is not read.
    expect(readableEmail({ subject: 'S'.repeat(SUBJECT_CHARS + 1), body_text: 'Ends May 1.' })).toBeNull();
  });

  // Pre-push audit on b461113351 (P1): reply history written inline in one paragraph was kept.
  test('reply history written inline is dropped too, and the read is partial', () => {
    const inline = 'Thanks. On Mon, Apr 13, 2026 at 9:00 AM Sam Rep wrote: Flash sale ends tomorrow.';
    expect(readableEmail({ subject: 'Deal', body_text: inline })).toEqual({ subject: 'Deal', text: 'Thanks.', cut: false, partial: true });
    // Pre-push audit on 34ab1e253a (P1): a header wrapped onto a second line kept the old offer.
    const wrapped = 'Thanks. On Mon, Apr 13, 2026 at 9:00 AM,\nSam Rep wrote: Flash sale ends tomorrow.';
    expect(readableEmail({ subject: 'Deal', body_text: wrapped })).toEqual({ subject: 'Deal', text: 'Thanks.', cut: false, partial: true });
    // Pre-push audit on 76e2aab5e7 (P1): the cut started at the sender's own "on" and dropped the deadline.
    const ownOn = 'The sale ends on April 30. On Apr 13, 2026 at 9:00 AM Sam Rep wrote: Flash sale ends tomorrow.';
    expect(readableEmail({ subject: 'Deal', body_text: ownOn })).toEqual({ subject: 'Deal', text: 'The sale ends on April 30.', cut: false, partial: true });
    const ownCapitalOn = 'Hi. On April 30 prices go up. On Apr 13, 2026 at 9:00 AM Sam Rep wrote: Flash sale ends tomorrow.';
    expect(readableEmail({ subject: 'Deal', body_text: ownCapitalOn }).text).toBe('Hi. On April 30 prices go up.');
    // Pre-push audit on 1e7d63d07c (P1): a lowercase header, and a header inside a quoted line, cut the sender's words.
    const lowerOn = 'Sale ends on April 30. on Apr 13, 2026 Sam wrote: Flash sale ends tomorrow.';
    expect(readableEmail({ subject: 'Deal', body_text: lowerOn }).text).toBe('Sale ends on April 30.');
    const quotedHeader = '> Earlier note: On Apr 13, 2026 Sam wrote: old offer\nOur new offer ends tomorrow.';
    expect(readableEmail({ subject: 'Deal', body_text: quotedHeader })).toEqual({ subject: 'Deal', text: 'Our new offer ends tomorrow.', cut: false, partial: true });
    // Prose is no header: with no date, time or address before "wrote:", the text stays whole.
    const prose = 'Big savings. On sale now: our rep wrote: ends Friday.';
    expect(readableEmail({ subject: 'Deal', body_text: prose })).toEqual({ subject: 'Deal', text: prose, cut: false, partial: false });
  });

  // Pre-push audit on 75797b78e6 (P1): "Re: Flash sale ends tomorrow" put the old "tomorrow" on the reply's day.
  test("a reply's or forward's subject is the old email's: left out, so the read is partial", () => {
    for (const subject of ['Re: Flash sale ends tomorrow', 'FW: Flash sale ends tomorrow', 'fwd:Flash sale ends tomorrow']) {
      expect(readableEmail({ subject, body_text: 'Thanks' })).toEqual({ subject: '', text: 'Thanks', cut: false, partial: true });
    }
    expect(readableEmail({ subject: 'Repeat order sale', body_text: 'Thanks' }).subject).toBe('Repeat order sale');
  });

  test('stays linear on a hostile HTML body the size of the re-read', () => {
    const started = Date.now();
    endDateText({ body_html: '<'.repeat(BODY_HTML_CHARS) });
    endDateText({ body_html: '<script'.repeat(BODY_HTML_CHARS / 7) });
    endDateText({ body_html: `${'<p'.repeat(BODY_HTML_CHARS / 4)}>` });
    endDateText({ body_html: `${'<blockquote>'.repeat(BODY_HTML_CHARS / 25)}${'</blockquote>'.repeat(BODY_HTML_CHARS / 25)}` });
    endDateText({ body_html: '<blockquote'.repeat(BODY_HTML_CHARS / 11) });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('checkAnswer', () => {
  const email = 'Subject line\nLast chance for 10% off. *Offers valid March 1 – April 30, 2026. Early Order Program ending on Thursday. '
    + 'Rebate forms due 5/15/26. Flash sale ends tonight. Free hat ends tomorrow. Points double through April 16, 2027. Spring marketing 15 percent promo. Offer on 1/2 gal bottles.';
  const received = new Date('2026-04-15T14:00:00Z'); // Wednesday Apr 15, 10 AM ET

  test.each([
    ['exact words', 'Offers valid March 1 – April 30, 2026.', '2026-04-30'],
    ['case, spaces and a plain hyphen for the en dash', 'offers  valid MARCH 1 - April 30, 2026', '2026-04-30'],
    ['curly quotes and edge marks', '“*Offers valid March 1 – April 30, 2026.”', '2026-04-30'],
    ['a weekday: the Thursday after a Wednesday email', 'Early Order Program ending on Thursday', '2026-04-16'],
    ['a numeric date with a two-digit year', 'Rebate forms due 5/15/26', '2026-05-15'],
    ['"tonight" is the day the email came', 'Flash sale ends tonight', '2026-04-15'],
    ['"tomorrow" is the next day', 'Free hat ends tomorrow', '2026-04-16'],
    ['a year on is still in range', 'Points double through April 16, 2027', '2027-04-16'],
    ['a year the email writes right after the words', 'Points double through April 16', '2027-04-16'],
    ['a numeric year the email writes right after the words', 'Rebate forms due 5/15', '2026-05-15'],
  ])('kept: %s', (_label, quote, endDate) => {
    expect(checkAnswer({ end_date: endDate, quote, price_increase: false }, email, received)).toEqual({ ok: true, endDate, quote: quote.replace(/\s+/g, ' ').trim(), priceIncrease: false });
  });

  test('null = the email states no end', () => {
    expect(checkAnswer({ end_date: null, quote: null, price_increase: false }, email, received)).toEqual({ ok: true, endDate: null, quote: null, priceIncrease: false });
    // Pre-push audit on 0ab3d820d4 (P1): "no end" with no flag replaced a pattern date. Like any answer, it needs the flag.
    expect(checkAnswer({ end_date: null, quote: null }, email, received)).toEqual({ ok: false, reason: 'bad_price_flag' });
  });

  // Pre-push audit on be6684f834 (P1): "Prices increase effective May 1" read as the last day at the old price.
  test('a price increase: the date is the day the new price starts, and the answer says so', () => {
    const notice = 'Subject\nPrices increase effective May 1. Order now.';
    const answer = { end_date: '2026-05-01', quote: 'Prices increase effective May 1', price_increase: true };
    expect(checkAnswer(answer, notice, received)).toEqual({ ok: true, endDate: '2026-05-01', quote: 'Prices increase effective May 1', priceIncrease: true });
    expect(checkAnswer({ ...answer, price_increase: false }, notice, received).priceIncrease).toBe(false);
    // Pre-push audit on 32723022ad (P1): the flag picks the label, so a missing or quoted one is a miss.
    expect(checkAnswer({ ...answer, price_increase: 'true' }, notice, received)).toEqual({ ok: false, reason: 'bad_price_flag' });
    expect(checkAnswer({ end_date: answer.end_date, quote: answer.quote }, notice, received)).toEqual({ ok: false, reason: 'bad_price_flag' });
  });

  test.each([
    ['no answer', null, 'invalid_json'],
    ['no end_date key', { quote: 'Offers valid March 1' }, 'invalid_json'],
    ['a null date beside words', { end_date: null, quote: 'Offers valid March 1 – April 30, 2026' }, 'half_null'],
    ['a null date with no quote key', { end_date: null }, 'half_null'],
    ['not a calendar day', { end_date: '2026-02-30', quote: 'Offers valid March 1 – April 30, 2026' }, 'bad_date'],
    ['words for a date', { end_date: 'April 30', quote: 'Offers valid March 1 – April 30, 2026' }, 'bad_date'],
    ['before the email came', { end_date: '2026-04-14', quote: 'Offers valid March 1 – April 30, 2026' }, 'date_out_of_range'],
    ['more than a year on', { end_date: '2027-04-17', quote: 'Offers valid March 1 – April 30, 2026' }, 'date_out_of_range'],
    ['no quote', { end_date: '2026-04-30', quote: null }, 'no_quote'],
    ['a stray number', { end_date: '2026-04-30', quote: '30, 2026' }, 'no_quote'],
    ['a whole paragraph', { end_date: '2026-04-30', quote: 'x'.repeat(301) }, 'no_quote'],
    // Pre-push audit on 0ab3d820d4 (P1): the line cut words past 140 characters, and the date with them.
    ['longer than the bell line shows (140)', { end_date: '2026-04-30', quote: `Offers valid ${'x'.repeat(128)}` }, 'no_quote'],
    ['words not in the email', { end_date: '2026-04-30', quote: 'Offer ends April 30, 2026' }, 'quote_not_found'],
    ['part of a date ("April 1" of "April 16")', { end_date: '2027-04-01', quote: 'Points double through April 1' }, 'quote_not_found'],
    ['a year after the words that is not the date\'s', { end_date: '2026-04-16', quote: 'Points double through April 16' }, 'quote_date_mismatch'],
    ['words for another day', { end_date: '2026-05-30', quote: 'Offers valid March 1 – April 30, 2026' }, 'quote_date_mismatch'],
    ['a numeric date for another day', { end_date: '2026-05-16', quote: 'Rebate forms due 5/15/26' }, 'quote_date_mismatch'],
    ['the weekday more than a week on', { end_date: '2026-04-23', quote: 'Early Order Program ending on Thursday' }, 'quote_date_mismatch'],
    ['another weekday', { end_date: '2026-04-17', quote: 'Early Order Program ending on Thursday' }, 'quote_date_mismatch'],
    ['"tonight" is not the next day', { end_date: '2026-04-16', quote: 'Flash sale ends tonight' }, 'quote_date_mismatch'],
    ['no day in the words ("marketing 15" is not March 15)', { end_date: '2027-03-15', quote: 'Spring marketing 15 percent promo' }, 'quote_date_mismatch'],
    // Pre-push audit on 8cdbc9728d (P1): a unit fraction passed as a date. The digest's own numeric-date rule now decides.
    ['a fraction of a unit ("1/2 gal" is not January 2)', { end_date: '2027-01-02', quote: 'Offer on 1/2 gal bottles' }, 'quote_date_mismatch'],
  ])('dropped: %s', (_label, answer, reason) => {
    expect(checkAnswer(answer, email, received)).toEqual({ ok: false, reason });
  });

  test('days count from the ET day the email came', () => {
    const lateNight = new Date('2026-04-15T03:00:00Z'); // Apr 14, 11 PM ET
    expect(checkAnswer({ end_date: '2026-04-14', quote: 'Flash sale ends tonight', price_increase: false }, email, lateNight).ok).toBe(true);
    expect(checkAnswer({ end_date: '2026-04-15', quote: 'Flash sale ends tonight' }, email, lateNight)).toEqual({ ok: false, reason: 'quote_date_mismatch' });
  });

  test('a year in the words must be the year of the date', () => {
    const winter = 'Subject\nWinter rebate: offer ends January 15, 2026. Bonus points end January 15.';
    const december = new Date('2026-12-20T15:00:00Z');
    expect(checkAnswer({ end_date: '2027-01-15', quote: 'offer ends January 15, 2026' }, winter, december)).toEqual({ ok: false, reason: 'quote_date_mismatch' });
    expect(checkAnswer({ end_date: '2027-01-15', quote: 'Bonus points end January 15', price_increase: false }, winter, december).ok).toBe(true);
  });

  // Pre-push audit on be6684f834 (P1): "ends today, April 15" passed as April 15 a year on.
  test('a date with no year is its next time on or after the day the email came', () => {
    const today = 'Subject\nDiscount ends today, April 15. Rebate forms due 4/15.';
    const refused = { ok: false, reason: 'quote_date_mismatch' };
    expect(checkAnswer({ end_date: '2027-04-15', quote: 'Discount ends today, April 15' }, today, received)).toEqual(refused);
    expect(checkAnswer({ end_date: '2027-04-15', quote: 'Rebate forms due 4/15' }, today, received)).toEqual(refused);
    expect(checkAnswer({ end_date: '2026-04-15', quote: 'Discount ends today, April 15', price_increase: false }, today, received).ok).toBe(true);
    expect(checkAnswer({ end_date: '2026-04-15', quote: 'Rebate forms due 4/15', price_increase: false }, today, received).ok).toBe(true);
  });

  // Pre-push audit on b21fc449c9 (P1): the first day of a quoted range passed as its end.
  test('a range ends on its last day: its first day is refused, also when the quote stops short of the rest', () => {
    const february = new Date('2026-02-16T15:00:00Z');
    const promo = 'Subject\n*Offers valid March 1 – April 30, 2026. Spring rebates run 3/1-3/31. Bonus points March 1 through 15. Pickup Mar 2 - 12/31. Flash sale ends Mar 3 - 11:59 PM.';
    const read = (endDate, quote) => checkAnswer({ end_date: endDate, quote, price_increase: false }, promo, february);
    const refused = { ok: false, reason: 'quote_date_mismatch' };
    expect(read('2026-03-01', 'Offers valid March 1 – April 30, 2026')).toEqual(refused);
    expect(read('2026-03-01', 'Offers valid March 1')).toEqual(refused);
    expect(read('2026-04-30', 'Offers valid March 1 – April 30, 2026').ok).toBe(true);
    expect(read('2026-03-01', 'Spring rebates run 3/1-3/31')).toEqual(refused);
    expect(read('2026-03-31', 'Spring rebates run 3/1-3/31').ok).toBe(true);
    expect(read('2026-03-01', 'Bonus points March 1 through 15')).toEqual(refused);
    expect(read('2026-03-15', 'Bonus points March 1 through 15').ok).toBe(true);
    // "Mar 2 - 12/31" is March 2 to December 31, never March 12.
    expect(read('2026-03-12', 'Pickup Mar 2 - 12/31')).toEqual(refused);
    expect(read('2026-12-31', 'Pickup Mar 2 - 12/31').ok).toBe(true);
    // "Mar 3 - 11:59 PM" is a day and a time, not March 3 to 11.
    expect(read('2026-03-03', 'Flash sale ends Mar 3 - 11:59 PM').ok).toBe(true);
    expect(read('2026-03-11', 'Flash sale ends Mar 3 - 11:59 PM')).toEqual(refused);
  });

  // Pre-push audit on c9a07148db (P1): the same for days named without a date.
  test('a range of weekdays, or from today, ends on its last day too', () => {
    const sunday = new Date('2026-04-19T14:00:00Z'); // Sunday Apr 19, 10 AM ET
    const promo = 'Subject\nOffer valid Monday through Friday. Flash deal today through Wednesday. Hat sale ends Friday.';
    const read = (endDate, quote) => checkAnswer({ end_date: endDate, quote, price_increase: false }, promo, sunday);
    const refused = { ok: false, reason: 'quote_date_mismatch' };
    expect(read('2026-04-20', 'Offer valid Monday through Friday')).toEqual(refused);
    expect(read('2026-04-20', 'Offer valid Monday')).toEqual(refused);
    expect(read('2026-04-24', 'Offer valid Monday through Friday').ok).toBe(true);
    expect(read('2026-04-19', 'Flash deal today through Wednesday')).toEqual(refused);
    expect(read('2026-04-22', 'Flash deal today through Wednesday').ok).toBe(true);
    expect(read('2026-04-24', 'Hat sale ends Friday').ok).toBe(true);
  });

  // Pre-push audits on 69adaa08d8 and 5d207d2410 (P1): a weekday beside the first day hid the
  // range, and so did "between ... and". Each round found a new phrase, so the rule now reads no
  // range words: another day later in the same sentence means this day is not the end.
  test('the end is the last day its sentence names, however the range is written', () => {
    const february = new Date('2026-02-16T15:00:00Z');
    const promo = 'Subject\nOffers valid March 1 (Sunday) – April 30, 2026. Rebates run 3/2/2026 12:00 a.m. ET through Thu., 4/30/2026. '
      + 'Valid between March 3 and April 29. Points from March 4 until close of business on April 28. '
      + 'Order ends March 31 - pick up by April 5. Spring sale ends March 20. Monday through Friday only. Sale ends April 30 (Thursday).';
    const read = (endDate, quote) => checkAnswer({ end_date: endDate, quote, price_increase: false }, promo, february);
    const refused = { ok: false, reason: 'quote_date_mismatch' };
    expect(read('2026-03-01', 'Offers valid March 1 (Sunday) – April 30, 2026')).toEqual(refused);
    expect(read('2026-03-01', 'Offers valid March 1')).toEqual(refused);
    expect(read('2026-04-30', 'Offers valid March 1 (Sunday) – April 30, 2026').ok).toBe(true);
    expect(read('2026-03-02', 'Rebates run 3/2/2026 12:00 a.m. ET')).toEqual(refused);
    expect(read('2026-04-30', 'Rebates run 3/2/2026 12:00 a.m. ET through Thu., 4/30/2026').ok).toBe(true);
    expect(read('2026-03-03', 'Valid between March 3 and April 29')).toEqual(refused);
    expect(read('2026-03-03', 'Valid between March 3')).toEqual(refused);
    expect(read('2026-04-29', 'Valid between March 3 and April 29').ok).toBe(true);
    expect(read('2026-03-04', 'Points from March 4')).toEqual(refused);
    expect(read('2026-04-28', 'Points from March 4 until close of business on April 28').ok).toBe(true);
    // A weekday that labels the day is the same day; a day in the next sentence is not this one's.
    expect(read('2026-04-30', 'Sale ends April 30 (Thursday)').ok).toBe(true);
    expect(read('2026-03-20', 'Spring sale ends March 20').ok).toBe(true);
    // The cost: another day in the sentence refuses an answer that was right. The line keeps its date pattern.
    expect(read('2026-03-31', 'Order ends March 31')).toEqual(refused);
  });

  // Pre-push audit on 32723022ad (P1): "4/20-24" passed April 20 and refused April 24.
  test('a numeric date closes on the day after its dash, as a named one does', () => {
    const sale = 'Subject\nSale valid 4/20–24 on Demand CS. Pickup 4/20-4/24. Final call 4/20 - 11:59 PM.';
    const read = (endDate, quote) => checkAnswer({ end_date: endDate, quote, price_increase: false }, sale, received);
    const refused = { ok: false, reason: 'quote_date_mismatch' };
    expect(read('2026-04-20', 'Sale valid 4/20–24')).toEqual(refused);
    expect(read('2026-04-20', 'Sale valid 4/20')).toEqual(refused);
    expect(read('2026-04-24', 'Sale valid 4/20–24').ok).toBe(true);
    // "4/20-4/24" is two dates, and "4/20 - 11:59 PM" a date and a time.
    expect(read('2026-04-20', 'Pickup 4/20-4/24')).toEqual(refused);
    expect(read('2026-04-24', 'Pickup 4/20-4/24').ok).toBe(true);
    expect(read('2026-04-20', 'Final call 4/20 - 11:59 PM').ok).toBe(true);
  });

  // Pre-push audit on 0ab3d820d4 (P1): "4/24, 2025" and "4/20-24, 2025" passed as 2026.
  test('a year written after a numeric date or its closing day is its year', () => {
    const sunday = new Date('2026-04-19T15:00:00Z'); // Sunday Apr 19
    const old = 'Subject\nOrder by 4/24, 2025. Offer valid 4/20–24, 2025. Pickup by 4/24, 2026.';
    const read = (endDate, quote) => checkAnswer({ end_date: endDate, quote, price_increase: false }, old, sunday);
    const refused = { ok: false, reason: 'quote_date_mismatch' };
    expect(read('2026-04-24', 'Order by 4/24, 2025')).toEqual(refused);
    expect(read('2026-04-24', 'Order by 4/24')).toEqual(refused);
    expect(read('2026-04-24', 'Offer valid 4/20–24, 2025')).toEqual(refused);
    expect(read('2026-04-24', 'Pickup by 4/24, 2026').ok).toBe(true);
  });

  // Pre-push audit on 0ab3d820d4 (P1): "Monday through Fri." passed Monday, as "Fri." was no day.
  test('a weekday cut short closes a range and labels a date, but never names the end alone', () => {
    const sunday = new Date('2026-04-19T15:00:00Z'); // Sunday Apr 19
    const promo = 'Subject\nOffer valid Monday through Fri. Rebate runs Tues - Thurs only. Order by April 30 (Thu). Sun & Shade mix 20% off.';
    const read = (endDate, quote) => checkAnswer({ end_date: endDate, quote, price_increase: false }, promo, sunday);
    const refused = { ok: false, reason: 'quote_date_mismatch' };
    expect(read('2026-04-20', 'Offer valid Monday through Fri')).toEqual(refused);
    expect(read('2026-04-21', 'Rebate runs Tues - Thurs only')).toEqual(refused);
    expect(read('2026-04-30', 'Order by April 30 (Thu)').ok).toBe(true);
    // "sun" may be the word, so a cut-short weekday never names the end alone. This leans to a miss.
    expect(read('2026-04-26', 'Sun & Shade mix 20% off')).toEqual(refused);
    expect(read('2026-04-24', 'Offer valid Monday through Fri')).toEqual(refused);
  });

  // Pre-push audit on 32723022ad (P1): "April 20 through Friday" refused Friday, its last day.
  test('beside a date, a day word names the end only when it falls after every date there', () => {
    const sunday = new Date('2026-04-19T15:00:00Z'); // Sunday Apr 19
    const sale = 'Subject\nSale valid April 20 through Friday. Ends May 1 (Friday). Deals April 13 through Thursday.';
    const read = (endDate, quote) => checkAnswer({ end_date: endDate, quote, price_increase: false }, sale, sunday);
    const refused = { ok: false, reason: 'quote_date_mismatch' };
    expect(read('2026-04-24', 'Sale valid April 20 through Friday').ok).toBe(true);
    expect(read('2026-04-20', 'Sale valid April 20 through Friday')).toEqual(refused);
    // A weekday that labels its date is that date: "(Friday)" here is May 1, never the Friday before it.
    expect(read('2026-05-01', 'Ends May 1 (Friday)').ok).toBe(true);
    expect(read('2026-04-24', 'Ends May 1 (Friday)')).toEqual(refused);
    // A start before the email came is still before its end.
    expect(read('2026-04-23', 'Deals April 13 through Thursday').ok).toBe(true);
  });

  // Pre-push audit on b461113351 (P1): "Wednesday" quoted alone from "Sale ends April 15 (Wednesday)" passed April 22.
  test('a day word right after a date labels it, also when the date sits just before the quote', () => {
    const wednesday = new Date('2026-04-15T14:00:00Z'); // Wednesday Apr 15
    const promo = 'Subject\nSale ends April 15 (Wednesday). Flash sale through Wednesday.';
    const read = (endDate, quote) => checkAnswer({ end_date: endDate, quote, price_increase: false }, promo, wednesday);
    const refused = { ok: false, reason: 'quote_date_mismatch' };
    expect(read('2026-04-22', 'Wednesday')).toEqual(refused);
    expect(read('2026-04-22', '15 (Wednesday)')).toEqual(refused);
    expect(read('2026-04-22', 'Flash sale through Wednesday').ok).toBe(true);
  });

  // Pre-push audit on 75797b78e6 (P1): "Offer ends April 15 (Wednesday)" passed the Wednesday after.
  test('beside dates, a day word names a day only as a range close; a weekday beside a date labels it', () => {
    const wednesday = new Date('2026-04-15T14:00:00Z'); // Wednesday Apr 15
    const promo = 'Subject\nOffer ends April 15 (Wednesday). Order by April 15. Ships Wednesday. Valid April 14 until Friday.';
    const read = (endDate, quote) => checkAnswer({ end_date: endDate, quote, price_increase: false }, promo, wednesday);
    const refused = { ok: false, reason: 'quote_date_mismatch' };
    expect(read('2026-04-22', 'Offer ends April 15 (Wednesday)')).toEqual(refused);
    expect(read('2026-04-15', 'Offer ends April 15 (Wednesday)').ok).toBe(true);
    expect(read('2026-04-22', 'Order by April 15. Ships Wednesday')).toEqual(refused);
    expect(read('2026-04-17', 'Valid April 14 until Friday').ok).toBe(true);
  });

  // Pre-push audit on 8cdbc9728d (P1): a cap that cut "May 30" after the 3 left "Offer ends May 3" looking whole.
  test("words that run to a cap's cut cannot be checked whole: a miss on a cut email", () => {
    const cutAt3 = 'Subject\nSpring sale on Demand CS. Offer ends May 3';
    const answer = { end_date: '2026-05-03', quote: 'Offer ends May 3', price_increase: false };
    expect(checkAnswer(answer, cutAt3, received, true)).toEqual({ ok: false, reason: 'quote_at_cut' });
    // On an email no cap cut, or with the rest of the email after the words, they are checked as usual.
    expect(checkAnswer(answer, cutAt3, received).ok).toBe(true);
    expect(checkAnswer(answer, `${cutAt3}. ${'Terms apply to select items. '.repeat(3)}`, received, true).ok).toBe(true);
  });

  test('a long run of marks in the quote is refused fast', () => {
    const started = Date.now();
    expect(checkAnswer({ end_date: '2026-04-30', quote: `a${'.'.repeat(8000)}a` }, email, received)).toEqual({ ok: false, reason: 'no_quote' });
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('parseAnswer', () => {
  test('reads a reply that is one JSON object, with or without a code fence', () => {
    expect(parseAnswer('```json\n{"end_date": null, "quote": null}\n```')).toEqual({ end_date: null, quote: null });
    expect(parseAnswer('```\n{"end_date": "2026-04-30", "quote": "x"}\n```')).toEqual({ end_date: '2026-04-30', quote: 'x' });
    expect(parseAnswer(' {"end_date": "2026-04-30", "quote": "x"}\n')).toEqual({ end_date: '2026-04-30', quote: 'x' });
    expect(parseAnswer('no json')).toBeNull();
    expect(parseAnswer('{not json}')).toBeNull();
    expect(parseAnswer('[1, 2]')).toBeNull();
    expect(parseAnswer('```')).toBeNull();
  });

  // Pre-push audit on 69adaa08d8 (P1): a slice from the first "{" to the last "}" made an object of other replies.
  test('text around the object, an array or two objects is not the JSON asked for', () => {
    expect(parseAnswer('Here: {"end_date": "2026-04-30", "quote": "x"}')).toBeNull();
    expect(parseAnswer('[{"end_date": null, "quote": null}]')).toBeNull();
    expect(parseAnswer('{"end_date": null, "quote": null} {"end_date": "2026-04-30", "quote": "x"}')).toBeNull();
  });
});

describe('readDealEndDates', () => {
  const OLD_KEY = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockCreate.mockReset();
    mockSdk.mockClear();
    mockLedger.mockClear();
    mockRejected.mockClear();
    logger.info.mockClear();
    logger.warn.mockClear();
  });
  afterAll(() => {
    if (OLD_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = OLD_KEY;
  });

  // The candidate query's rows carry 6,000-character excerpts; the whole bodies come from one re-read.
  function fakeConn(rows, { fail = false } = {}) {
    const calls = { tables: [], selects: [], whereIn: null, raws: [] };
    const conn = (table) => {
      calls.tables.push(table);
      const chain = {
        select(...cols) { calls.selects.push(...cols); return chain; },
        whereIn(col, ids) { calls.whereIn = [col, ids]; return chain; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            if (fail) throw new Error('db down');
            return rows.filter((r) => calls.whereIn[1].includes(r.id));
          }).then(resolve, reject);
        },
      };
      return chain;
    };
    conn.raw = (sql, bindings) => { calls.raws.push({ sql, bindings }); return { sql, bindings }; };
    return { conn, calls };
  }

  const deal = (id, over = {}) => ({ id, subject: `Deal ${id}`, received_at: new Date('2026-04-15T14:00:00Z'), body_text: 'excerpt', ...over });
  const reply = (text, stop = 'end_turn') => ({ stop_reason: stop, content: [{ type: 'thinking', thinking: 'reading' }, { type: 'text', text }] });

  test('one Haiku call per deal under the lane, with the whole email links removed; kept answers by email id', async () => {
    const { conn, calls } = fakeConn([
      { id: 1, body_text: PROMO, body_html: null },
      { id: 2, body_text: 'Partners Program members are a step ahead. Earn points all year.', body_html: null },
    ]);
    mockCreate
      .mockResolvedValueOnce(reply('{"end_date": "2026-04-30", "quote": "Offers valid March 1 – April 30, 2026.", "price_increase": false}'))
      .mockResolvedValueOnce(reply('{"end_date": null, "quote": null, "price_increase": false}'));

    const found = await readDealEndDates(conn, [deal(1, { subject: 'Last Chance  for 10% Off' }), deal(2)]);

    expect([...found.entries()]).toEqual([
      [1, { endDate: '2026-04-30', quote: 'Offers valid March 1 – April 30, 2026.', priceIncrease: false }],
      [2, { endDate: null, quote: null, priceIncrease: false }],
    ]);
    // Bodies: one query, by id, under their own column names and widths.
    expect(calls.tables).toEqual(['emails']);
    expect(calls.whereIn).toEqual(['id', [1, 2]]);
    expect(calls.raws).toEqual([
      { sql: 'left(body_text, ?) as body_text', bindings: [BODY_TEXT_CHARS] },
      { sql: 'left(body_html, ?) as body_html', bindings: [BODY_HTML_CHARS] },
    ]);
    // The request: the registry pin, its lane, the fixed prompt, the email as read.
    expect(mockSdk).toHaveBeenCalledTimes(1);
    expect(mockSdk).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'test-key', maxRetries: 0 }));
    expect(mockLedger).toHaveBeenCalledWith('anthropic', MODELS.DEAL_END_DATE, expect.any(Function), { laneId: 'siteone_deal_end_date' });
    const request = mockCreate.mock.calls[0][0];
    expect(request).toMatchObject({ model: MODELS.DEAL_END_DATE, system: SYSTEM_PROMPT });
    expect(request).not.toHaveProperty('temperature');
    expect(request.messages).toEqual([{
      role: 'user',
      content: `Received: 2026-04-15 (US Eastern)\nSubject: Last Chance for 10% Off\n\n${endDateText({ body_text: PROMO })}`,
    }]);
    expect(request.messages[0].content).not.toContain('https://');
    expect(mockRejected).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('[siteone-deals] end dates: 2 of 2 deals read by AI');
  });

  test('every miss leaves no entry, and a reply the code refuses is marked failed in the ledger', async () => {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const { conn } = fakeConn(ids.filter((id) => id !== 9).map((id) => ({ id, body_text: PROMO, body_html: null })));
    const refusal = reply('', 'refusal');
    const notJson = reply('The offer ends April 30.');
    const wrongWords = reply('{"end_date": "2026-04-30", "quote": "Sale ends April 30"}');
    const wrongDay = reply('{"end_date": "2026-05-30", "quote": "Offers valid March 1 – April 30, 2026."}');
    const halfNull = reply('{"end_date": null, "quote": "Offers valid March 1 – April 30, 2026."}');
    mockCreate
      .mockRejectedValueOnce(Object.assign(new Error('overloaded'), { status: 529 }))
      .mockResolvedValueOnce(refusal)
      .mockResolvedValueOnce(reply('{"end_date": "2026-04-30"', 'max_tokens'))
      .mockResolvedValueOnce(notJson)
      .mockResolvedValueOnce(wrongWords)
      .mockResolvedValueOnce(wrongDay)
      .mockResolvedValueOnce(halfNull)
      .mockResolvedValueOnce(reply('{"end_date": "2026-04-30", "quote": "Offers valid March 1 – April 30, 2026.", "price_increase": false}'));

    const found = await readDealEndDates(conn, ids.map((id) => deal(id)));

    expect([...found.keys()]).toEqual([8]);
    expect(mockCreate).toHaveBeenCalledTimes(8); // no body row for 9, so no call
    expect(mockRejected.mock.calls).toEqual([
      [notJson, 'invalid_json'], [wrongWords, 'schema_invalid'], [wrongDay, 'schema_invalid'], [halfNull, 'schema_invalid'],
    ]);
    expect(logger.info).toHaveBeenCalledWith('[siteone-deals] end dates: 1 of 9 deals read by AI; date patterns kept for 1 api_529, 1 refusal, 1 max_tokens, 1 invalid_json, 1 quote_not_found, 1 quote_date_mismatch, 1 half_null, 1 no_body');
  });

  // Pre-push audit on b21fc449c9 (P1): "no end" on part of an email beat a pattern date in the part cut off.
  test('"no end" on an email the model did not read whole is a miss, so the date-pattern line stays', async () => {
    const { conn } = fakeConn([
      { id: 1, body_text: 'Spring savings. '.repeat(1500), body_html: null },
      { id: 2, body_text: 'Deal on Demand CS.'.padEnd(BODY_TEXT_CHARS), body_html: null },
      { id: 3, body_text: null, body_html: '<p>Deal on Demand CS.</p>'.padEnd(BODY_HTML_CHARS) },
      { id: 4, body_text: 'Deal on Demand CS. Thanks.', body_html: null },
      // A dropped <blockquote> may have held this email's own end.
      { id: 5, body_text: null, body_html: '<p>Deal on Demand CS.</p><blockquote>Offer ends April 30.</blockquote>' },
    ]);
    mockCreate.mockResolvedValue(reply('{"end_date": null, "quote": null, "price_increase": false}'));
    const found = await readDealEndDates(conn, [deal(1), deal(2), deal(3), deal(4), deal(5)]);
    expect([...found.entries()]).toEqual([[4, { endDate: null, quote: null, priceIncrease: false }]]);
    expect(mockRejected).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('[siteone-deals] end dates: 1 of 5 deals read by AI; date patterns kept for 4 no_end_in_cut_text');
  });

  // Pre-push audit on 8cdbc9728d: a cut subject could end mid-date, so a subject past SUBJECT_CHARS is not read.
  test('a subject past SUBJECT_CHARS is a miss with no call', async () => {
    const { conn } = fakeConn([{ id: 1, body_text: 'Offer ends May 1, 2026.', body_html: null }]);
    const found = await readDealEndDates(conn, [deal(1, { subject: 'S'.repeat(SUBJECT_CHARS + 1) })]);
    expect(found.size).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('[siteone-deals] end dates: 0 of 1 deals read by AI; date patterns kept for 1 long_subject');
  });

  // Pre-push audit on 5d207d2410 (P1): an old "ends tomorrow" in quoted history was read against the reply's date.
  test('quoted reply history is not sent and is no proof', async () => {
    const thread = 'Thanks for the order.\nOn Mon, Apr 13, 2026 at 9:00 AM Sam Rep <sam@example.com> wrote:\n> Flash sale ends tomorrow.';
    const { conn } = fakeConn([{ id: 1, body_text: thread, body_html: null }]);
    mockCreate.mockResolvedValue(reply('{"end_date": "2026-04-16", "quote": "Flash sale ends tomorrow"}'));

    const found = await readDealEndDates(conn, [deal(1)]);

    expect(found.size).toBe(0);
    expect(mockCreate.mock.calls[0][0].messages[0].content).toBe('Received: 2026-04-15 (US Eastern)\nSubject: Deal 1\n\nThanks for the order.');
    expect(logger.info).toHaveBeenCalledWith('[siteone-deals] end dates: 0 of 1 deals read by AI; date patterns kept for 1 quote_not_found');
  });

  // Pre-push audit on be6684f834 (P1): a ">" line with no attribution line went to the model and counted as proof.
  test('a line that starts with ">" is not sent and is no proof', async () => {
    const { conn } = fakeConn([{ id: 1, body_text: 'Thanks for the update.\n> Flash sale ends tomorrow.', body_html: null }]);
    mockCreate.mockResolvedValue(reply('{"end_date": "2026-04-16", "quote": "Flash sale ends tomorrow"}'));

    const found = await readDealEndDates(conn, [deal(1)]);

    expect(found.size).toBe(0);
    expect(mockCreate.mock.calls[0][0].messages[0].content).toBe('Received: 2026-04-15 (US Eastern)\nSubject: Deal 1\n\nThanks for the update.');
    expect(logger.info).toHaveBeenCalledWith('[siteone-deals] end dates: 0 of 1 deals read by AI; date patterns kept for 1 quote_not_found');
  });

  // Pre-push audit on 34ab1e253a (P1): a date that ends the subject labelled the body's first word.
  test('the subject and the body are two sentences to the check', async () => {
    const { conn } = fakeConn([{ id: 1, body_text: 'Tomorrow only! Save on mulch.', body_html: null }]);
    mockCreate.mockResolvedValue(reply('{"end_date": "2026-04-16", "quote": "Tomorrow only", "price_increase": false}'));

    const found = await readDealEndDates(conn, [deal(1, { subject: 'April 15' })]);

    expect(found.get(1)).toEqual({ endDate: '2026-04-16', quote: 'Tomorrow only', priceIncrease: false });
  });

  // Pre-push audit on 76e2aab5e7 (P1): a date that starts the body was a later day in the subject's sentence.
  test('a date that starts the body is no later day for the subject', async () => {
    const { conn } = fakeConn([{ id: 1, body_text: '4/15 was the launch date.', body_html: null }]);
    mockCreate.mockResolvedValue(reply('{"end_date": "2026-04-30", "quote": "Sale ends April 30", "price_increase": false}'));

    const found = await readDealEndDates(conn, [deal(1, { subject: 'Sale ends April 30' })]);

    expect(found.get(1)).toEqual({ endDate: '2026-04-30', quote: 'Sale ends April 30', priceIncrease: false });
  });

  // Pre-push audit on 75797b78e6 (P1): a reply's old subject "ends tomorrow" counted from the reply's day.
  test("a reply's subject is not sent and is no proof; \"no end\" on a reply is a miss", async () => {
    const { conn } = fakeConn([{ id: 1, body_text: 'Thanks', body_html: null }, { id: 2, body_text: 'Thanks', body_html: null }]);
    mockCreate
      .mockResolvedValueOnce(reply('{"end_date": "2026-04-16", "quote": "Flash sale ends tomorrow", "price_increase": false}'))
      .mockResolvedValueOnce(reply('{"end_date": null, "quote": null, "price_increase": false}'));

    const found = await readDealEndDates(conn, [deal(1, { subject: 'Re: Flash sale ends tomorrow' }), deal(2, { subject: 'Fwd: Flash sale' })]);

    expect(found.size).toBe(0);
    expect(mockCreate.mock.calls[0][0].messages[0].content).toBe('Received: 2026-04-15 (US Eastern)\nSubject: \n\nThanks');
    expect(logger.info).toHaveBeenCalledWith('[siteone-deals] end dates: 0 of 2 deals read by AI; date patterns kept for 1 quote_not_found, 1 no_end_in_cut_text');
  });

  // Pre-push audit on 8cdbc9728d (P1): the model cap cut "Ends May 30" to "Ends May 3".
  test("words that run to the model cap's cut are a miss, not a date", async () => {
    const body = `${'Spring savings. '.repeat(1249)}Ends May 30 and more`; // the cut falls after "May 3"
    const { conn } = fakeConn([{ id: 1, body_text: body, body_html: null }]);
    mockCreate.mockResolvedValue(reply('{"end_date": "2026-05-03", "quote": "Ends May 3"}'));

    const found = await readDealEndDates(conn, [deal(1)]);

    expect(mockCreate.mock.calls[0][0].messages[0].content.endsWith('Ends May 3')).toBe(true);
    expect(found.size).toBe(0);
    expect(logger.info).toHaveBeenCalledWith('[siteone-deals] end dates: 0 of 1 deals read by AI; date patterns kept for 1 quote_at_cut');
  });

  test(`reads at most ${MAX_READS} deals, newest first as given`, async () => {
    const ids = Array.from({ length: MAX_READS + 3 }, (_, i) => i + 1);
    const { conn, calls } = fakeConn(ids.map((id) => ({ id, body_text: PROMO, body_html: null })));
    mockCreate.mockResolvedValue(reply('{"end_date": null, "quote": null, "price_increase": false}'));
    const found = await readDealEndDates(conn, ids.map((id) => deal(id)));
    expect(calls.whereIn[1]).toEqual(ids.slice(0, MAX_READS));
    expect(mockCreate).toHaveBeenCalledTimes(MAX_READS);
    expect(found.size).toBe(MAX_READS);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('date patterns kept for 3 over_cap'));
  });

  test('no API key, or the body read fails: no call, no entries, one warning', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const first = fakeConn([{ id: 1, body_text: PROMO }]);
    expect((await readDealEndDates(first.conn, [deal(1)])).size).toBe(0);
    expect(first.calls.tables).toEqual([]);

    process.env.ANTHROPIC_API_KEY = 'test-key';
    const second = fakeConn([], { fail: true });
    expect((await readDealEndDates(second.conn, [deal(1)])).size).toBe(0);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(logger.warn.mock.calls.map(([line]) => line)).toEqual([
      '[siteone-deals] end dates not read by AI: no Anthropic API key',
      '[siteone-deals] end dates not read by AI: email bodies not read: db down',
    ]);
  });

  test('no deals: nothing read', async () => {
    const { conn, calls } = fakeConn([]);
    expect((await readDealEndDates(conn, [])).size).toBe(0);
    expect(calls.tables).toEqual([]);
    expect(mockSdk).not.toHaveBeenCalled();
  });
});

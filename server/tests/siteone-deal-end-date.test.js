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
 * another day, half-null, "no end" on a cut email) leaves no entry, so the bell keeps its
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
    expect(readableEmail({ body_text: 'Deal on Demand CS.'.padEnd(BODY_TEXT_CHARS - 1) })).toEqual({ subject: '', text: 'Deal on Demand CS.', cut: false });
    expect(readableEmail({ body_text: 'Deal on Demand CS.'.padEnd(BODY_TEXT_CHARS) })).toEqual({ subject: '', text: 'Deal on Demand CS.', cut: true });
    expect(readableEmail({ body_text: null, body_html: '<p>Deal on Demand CS.</p>'.padEnd(BODY_HTML_CHARS) })).toEqual({ subject: '', text: 'Deal on Demand CS.', cut: true });
    const long = readableEmail({ body_text: 'Spring savings. '.repeat(1500) }); // 24,000 characters: under the re-read cap, over the model's
    expect(long.cut).toBe(true);
    expect(long.text.length).toBe(MODEL_TEXT_CHARS);
  });

  // Pre-push audit on 5d207d2410 (P1): an old "ends tomorrow" in quoted history was read against the reply's date.
  test('drops quoted reply history, as the date patterns do; a re-read cap that cut only history does not count', () => {
    const thread = 'Ends Friday.\nOn Mon, Apr 13, 2026 at 9:00 AM Sam Rep <sam@example.com> wrote:\n> Flash sale ends tomorrow.';
    expect(readableEmail({ body_text: thread })).toEqual({ subject: '', text: 'Ends Friday.', cut: false });
    expect(endDateText({ body_text: 'Thanks!\nFrom: Sam Rep\nSent: Monday\nOffer ends tomorrow.' })).toBe('Thanks!');
    expect(endDateText({ body_text: 'Thanks!\n-----Original Message-----\nOffer ends tomorrow.' })).toBe('Thanks!');
    const longThread = `${thread}\n${'> older text\n'.repeat(3000)}`.slice(0, BODY_TEXT_CHARS);
    expect(readableEmail({ body_text: longThread })).toEqual({ subject: '', text: 'Ends Friday.', cut: false });
  });

  // Pre-push audit on 5d207d2410 (P1): the subject went to the model whole, links and all.
  test('the subject: links out, one line, at most SUBJECT_CHARS; the text gets what is left of the model cap', () => {
    expect(readableEmail({ subject: 'Spring  deals https://click.example.com/x?u=1 inside', body_text: 'Ends May 1.' }))
      .toEqual({ subject: 'Spring deals inside', text: 'Ends May 1.', cut: false });
    const long = readableEmail({ subject: 'S'.repeat(SUBJECT_CHARS + 1), body_text: 'x '.repeat(MODEL_TEXT_CHARS) });
    expect(long.subject.length).toBe(SUBJECT_CHARS);
    expect(long.text.length).toBe(MODEL_TEXT_CHARS - SUBJECT_CHARS);
    expect(long.cut).toBe(true);
    expect(readableEmail({ subject: 'S'.repeat(SUBJECT_CHARS + 1), body_text: 'Ends May 1.' }).cut).toBe(true);
  });

  test('stays linear on a hostile HTML body the size of the re-read', () => {
    const started = Date.now();
    endDateText({ body_html: '<'.repeat(BODY_HTML_CHARS) });
    endDateText({ body_html: '<script'.repeat(BODY_HTML_CHARS / 7) });
    endDateText({ body_html: `${'<p'.repeat(BODY_HTML_CHARS / 4)}>` });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('checkAnswer', () => {
  const email = 'Subject line\nLast chance for 10% off. *Offers valid March 1 – April 30, 2026. Early Order Program ending on Thursday. '
    + 'Rebate forms due 5/15/26. Flash sale ends tonight. Free hat ends tomorrow. Points double through April 16, 2027. Spring marketing 15 percent promo.';
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
    expect(checkAnswer({ end_date: endDate, quote }, email, received)).toEqual({ ok: true, endDate, quote: quote.replace(/\s+/g, ' ').trim() });
  });

  test('null = the email states no end', () => {
    expect(checkAnswer({ end_date: null, quote: null }, email, received)).toEqual({ ok: true, endDate: null, quote: null });
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
    ['words not in the email', { end_date: '2026-04-30', quote: 'Offer ends April 30, 2026' }, 'quote_not_found'],
    ['part of a date ("April 1" of "April 16")', { end_date: '2027-04-01', quote: 'Points double through April 1' }, 'quote_not_found'],
    ['a year after the words that is not the date\'s', { end_date: '2026-04-16', quote: 'Points double through April 16' }, 'quote_date_mismatch'],
    ['words for another day', { end_date: '2026-05-30', quote: 'Offers valid March 1 – April 30, 2026' }, 'quote_date_mismatch'],
    ['a numeric date for another day', { end_date: '2026-05-16', quote: 'Rebate forms due 5/15/26' }, 'quote_date_mismatch'],
    ['the weekday more than a week on', { end_date: '2026-04-23', quote: 'Early Order Program ending on Thursday' }, 'quote_date_mismatch'],
    ['another weekday', { end_date: '2026-04-17', quote: 'Early Order Program ending on Thursday' }, 'quote_date_mismatch'],
    ['"tonight" is not the next day', { end_date: '2026-04-16', quote: 'Flash sale ends tonight' }, 'quote_date_mismatch'],
    ['no day in the words ("marketing 15" is not March 15)', { end_date: '2027-03-15', quote: 'Spring marketing 15 percent promo' }, 'quote_date_mismatch'],
  ])('dropped: %s', (_label, answer, reason) => {
    expect(checkAnswer(answer, email, received)).toEqual({ ok: false, reason });
  });

  test('days count from the ET day the email came', () => {
    const lateNight = new Date('2026-04-15T03:00:00Z'); // Apr 14, 11 PM ET
    expect(checkAnswer({ end_date: '2026-04-14', quote: 'Flash sale ends tonight' }, email, lateNight).ok).toBe(true);
    expect(checkAnswer({ end_date: '2026-04-15', quote: 'Flash sale ends tonight' }, email, lateNight)).toEqual({ ok: false, reason: 'quote_date_mismatch' });
  });

  test('a year in the words must be the year of the date', () => {
    const winter = 'Subject\nWinter rebate: offer ends January 15, 2026. Bonus points end January 15.';
    const december = new Date('2026-12-20T15:00:00Z');
    expect(checkAnswer({ end_date: '2027-01-15', quote: 'offer ends January 15, 2026' }, winter, december)).toEqual({ ok: false, reason: 'quote_date_mismatch' });
    expect(checkAnswer({ end_date: '2027-01-15', quote: 'Bonus points end January 15' }, winter, december).ok).toBe(true);
  });

  // Pre-push audit on b21fc449c9 (P1): the first day of a quoted range passed as its end.
  test('a range ends on its last day: its first day is refused, also when the quote stops short of the rest', () => {
    const february = new Date('2026-02-16T15:00:00Z');
    const promo = 'Subject\n*Offers valid March 1 – April 30, 2026. Spring rebates run 3/1-3/31. Bonus points March 1 through 15. Pickup Mar 2 - 12/31. Flash sale ends Mar 3 - 11:59 PM.';
    const read = (endDate, quote) => checkAnswer({ end_date: endDate, quote }, promo, february);
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
    const read = (endDate, quote) => checkAnswer({ end_date: endDate, quote }, promo, sunday);
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
    const read = (endDate, quote) => checkAnswer({ end_date: endDate, quote }, promo, february);
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
      .mockResolvedValueOnce(reply('{"end_date": "2026-04-30", "quote": "Offers valid March 1 – April 30, 2026."}'))
      .mockResolvedValueOnce(reply('{"end_date": null, "quote": null}'));

    const found = await readDealEndDates(conn, [deal(1, { subject: 'Last Chance  for 10% Off' }), deal(2)]);

    expect([...found.entries()]).toEqual([
      [1, { endDate: '2026-04-30', quote: 'Offers valid March 1 – April 30, 2026.' }],
      [2, { endDate: null, quote: null }],
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
      .mockResolvedValueOnce(reply('{"end_date": "2026-04-30", "quote": "Offers valid March 1 – April 30, 2026."}'));

    const found = await readDealEndDates(conn, ids.map((id) => deal(id)));

    expect([...found.keys()]).toEqual([8]);
    expect(mockCreate).toHaveBeenCalledTimes(8); // no body row for 9, so no call
    expect(mockRejected.mock.calls).toEqual([
      [notJson, 'invalid_json'], [wrongWords, 'schema_invalid'], [wrongDay, 'schema_invalid'], [halfNull, 'schema_invalid'],
    ]);
    expect(logger.info).toHaveBeenCalledWith('[siteone-deals] end dates: 1 of 9 deals read by AI; date patterns kept for 1 api_529, 1 refusal, 1 max_tokens, 1 invalid_json, 1 quote_not_found, 1 quote_date_mismatch, 1 half_null, 1 no_body');
  });

  // Pre-push audit on b21fc449c9 (P1): "no end" on part of an email beat a pattern date in the part cut off.
  test('"no end" on an email a cap cut short is a miss, so the date-pattern line stays', async () => {
    const { conn } = fakeConn([
      { id: 1, body_text: 'Spring savings. '.repeat(1500), body_html: null },
      { id: 2, body_text: 'Deal on Demand CS.'.padEnd(BODY_TEXT_CHARS), body_html: null },
      { id: 3, body_text: null, body_html: '<p>Deal on Demand CS.</p>'.padEnd(BODY_HTML_CHARS) },
      { id: 4, body_text: 'Deal on Demand CS. Thanks.', body_html: null },
    ]);
    mockCreate.mockResolvedValue(reply('{"end_date": null, "quote": null}'));
    const found = await readDealEndDates(conn, [deal(1), deal(2), deal(3), deal(4)]);
    expect([...found.entries()]).toEqual([[4, { endDate: null, quote: null }]]);
    expect(mockRejected).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('[siteone-deals] end dates: 1 of 4 deals read by AI; date patterns kept for 3 no_end_in_cut_text');
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

  test(`reads at most ${MAX_READS} deals, newest first as given`, async () => {
    const ids = Array.from({ length: MAX_READS + 3 }, (_, i) => i + 1);
    const { conn, calls } = fakeConn(ids.map((id) => ({ id, body_text: PROMO, body_html: null })));
    mockCreate.mockResolvedValue(reply('{"end_date": null, "quote": null}'));
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

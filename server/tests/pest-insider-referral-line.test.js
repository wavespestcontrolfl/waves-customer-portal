/**
 * The Waves Pest Insider's referral line (services/pest-insider/referral-line.js):
 * an issue's stored body holds the line as one token in each part and never
 * an amount. A surface with no reader shows the first approved form. The
 * sender reads the referral program once per batch: an amount to state gives
 * the second form, an active program with no amount the first form, and a
 * paused or unreadable program no line. The owner's copy is filled by the
 * same rule. Only an issue of the Pest Insider's own type follows the
 * program.
 */
// The engine's amount for a live row the caller read (step2FriendCreditCentsOf): 0 with the gate off or no amount.
const mockFriendCents = jest.fn();
const mockLiveSettings = jest.fn();
const mockWarn = jest.fn();
jest.mock('../services/referral-engine', () => ({
  step2FriendCreditCentsOf: (...args) => mockFriendCents(...args),
  getLiveSettings: (...args) => mockLiveSettings(...args),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: (...args) => mockWarn(...args), debug: jest.fn() }));

const {
  REFERRAL_TAIL, REFERRAL_TOKEN, REFERRAL_TEXT_TOKEN, NO_LINE, hasReferralToken, neutralizeIssueTokens,
  referralTail, referralLine, referralLineFor, referralLineForBatch, referralLineAsOfNow,
} = require('../services/pest-insider/referral-line');
const { renderIssue, HOME_TOKEN, HOME_TEXT_TOKEN } = require('../services/pest-insider/render');
const { POST_URLS } = require('../services/pest-insider/posts');

const ISSUE = renderIssue({
  subject: 'Synthetic subject',
  preview: 'Synthetic preview',
  lead: { headline: 'Dry eggs, wet future', sentences: [{ text: 'The CDC says eggs survive 8 months.' }], postUrl: [...POST_URLS][0] },
  idItem: { text: 'It raises a generation in about a week.', species: { slug: 'aedes-mosquito', name: 'Aedes Mosquito' } },
});
const BODY = { html: ISSUE.html_body, text: ISSUE.text_body };
const MAILED = `${BODY.html}\n${BODY.text}`;
const PEST_INSIDER = { id: 'send-1', newsletter_type: 'pest-insider-monthly' };
const ACTIVE = { program_active: true, referee_discount_cents: 2500 };
const OTHERS = [{ newsletter_type: 'local-weekly-fresh-events' }, { newsletter_type: 'free-form' }, { newsletter_type: null }, {}, null];
const FIRST = referralLine(REFERRAL_TAIL);
const PAID = (cents) => referralLine(referralTail(cents));
const filled = (part, line) => part.split(REFERRAL_TOKEN).join(line.html).split(REFERRAL_TEXT_TOKEN).join(line.text);

beforeEach(() => {
  mockFriendCents.mockReset();
  mockFriendCents.mockReturnValue(0);
  mockLiveSettings.mockReset();
  mockLiveSettings.mockResolvedValue(ACTIVE);
  mockWarn.mockReset();
});

describe('the tokens in an issue', () => {
  test('a rendered issue holds one in each part; only the exact spellings are the tokens', () => {
    expect(hasReferralToken(BODY.html)).toBe(true);
    expect(hasReferralToken(BODY.text)).toBe(true);
    expect(hasReferralToken(REFERRAL_TOKEN)).toBe(true);
    expect(hasReferralToken(REFERRAL_TEXT_TOKEN)).toBe(true);
    for (const not of ['{{ pi-referral }}', '{{PI-REFERRAL}}', '{{pi-referral-tail}}', '{{pi-referral-html}}', '', null, undefined]) expect(hasReferralToken(not)).toBe(false);
  });

  test('neutralizeIssueTokens gives the first form and removes the "Your home" tokens, in one call, with no read', () => {
    expect(neutralizeIssueTokens(`a${HOME_TOKEN}b${REFERRAL_TOKEN}c`)).toBe(`ab${FIRST.html}c`);
    expect(neutralizeIssueTokens(`a${HOME_TEXT_TOKEN}b${REFERRAL_TEXT_TOKEN}c`)).toBe(`ab${FIRST.text}c`);
    expect(neutralizeIssueTokens(BODY.text)).toBe(filled(BODY.text, FIRST).split(HOME_TEXT_TOKEN).join(''));
    expect(neutralizeIssueTokens(null)).toBe('');
    expect(mockFriendCents).not.toHaveBeenCalled();
    expect(mockLiveSettings).not.toHaveBeenCalled();
  });
});

describe('referralLineFor: the line as of now, by the state of the referral program', () => {
  test('an active program with an amount to state gives the second form: one read, and the amount comes from that same row', async () => {
    mockFriendCents.mockReturnValue(5000);
    expect(await referralLineFor(PEST_INSIDER)).toEqual(PAID(5000));
    expect(PAID(5000).text).toContain('Send them our way. They get a $50 credit after their first plan service.\n');
    expect(mockLiveSettings).toHaveBeenCalledTimes(1);
    expect(mockFriendCents).toHaveBeenCalledTimes(1);
    expect(mockFriendCents.mock.calls[0][0]).toBe(await mockLiveSettings.mock.results[0].value);
    mockFriendCents.mockReturnValue(2500);
    expect((await referralLineFor(PEST_INSIDER)).text).toContain('They get a $25 credit after their first plan service.');
  });

  test('an active program with no amount to state gives the first form, from one read', async () => {
    expect(await referralLineFor(PEST_INSIDER)).toEqual(FIRST);
    expect(mockLiveSettings).toHaveBeenCalledTimes(1);
    expect(mockFriendCents).toHaveBeenCalledWith(ACTIVE);
  });

  test('a paused program gives no line, whatever amount the row holds; only an affirmative active value keeps it', async () => {
    mockFriendCents.mockReturnValue(5000);
    for (const row of [{ program_active: false, referee_discount_cents: 5000 }, { program_active: null }, {}, null, undefined]) {
      mockLiveSettings.mockResolvedValue(row);
      expect(await referralLineFor(PEST_INSIDER)).toEqual(NO_LINE);
    }
    expect(mockFriendCents).not.toHaveBeenCalled();
    // A pause is no fault: nothing is logged.
    expect(mockWarn).not.toHaveBeenCalled();
  });

  test('a read that throws gives no line and one warning: it never stops a batch or the owner\'s copy', async () => {
    // A failed read never leaves a line from an earlier guess: there is one read, and no line without it.
    mockFriendCents.mockReturnValue(5000);
    mockLiveSettings.mockRejectedValue(new Error('settings table gone'));
    expect(await referralLineFor(PEST_INSIDER)).toEqual(NO_LINE);
    expect(mockFriendCents).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0][0]).toMatch(/referral line.*settings table gone/);
    mockWarn.mockReset();
    mockLiveSettings.mockResolvedValue(ACTIVE);
    mockFriendCents.mockImplementation(() => { throw new Error('gate read failed'); });
    expect(await referralLineFor(PEST_INSIDER)).toEqual(NO_LINE);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  test('an amount that is no whole, positive number of cents is no amount: the program\'s state decides', async () => {
    for (const cents of [-5000, 50.5, NaN, '5000', null]) {
      mockFriendCents.mockReturnValue(cents);
      expect(await referralLineFor(PEST_INSIDER)).toEqual(FIRST);
    }
    mockLiveSettings.mockResolvedValue({ program_active: false });
    mockFriendCents.mockReturnValue('5000');
    expect(await referralLineFor(PEST_INSIDER)).toEqual(NO_LINE);
  });

  test('any other newsletter gets the first form and reads nothing, whatever the program\'s state', async () => {
    mockFriendCents.mockReturnValue(5000);
    mockLiveSettings.mockResolvedValue({ program_active: false });
    for (const send of OTHERS) expect(await referralLineFor(send)).toEqual(FIRST);
    expect(mockFriendCents).not.toHaveBeenCalled();
    expect(mockLiveSettings).not.toHaveBeenCalled();
  });
});

describe('referralLineForBatch: one batch\'s keys and its touchpoint text', () => {
  test('a body that holds a token gives both keys, from one read of the program for the batch', async () => {
    mockFriendCents.mockReturnValue(5000);
    const batch = await referralLineForBatch(PEST_INSIDER, MAILED);
    expect(batch.substitutions).toEqual({ [REFERRAL_TOKEN]: PAID(5000).html, [REFERRAL_TEXT_TOKEN]: PAID(5000).text });
    expect(mockLiveSettings).toHaveBeenCalledTimes(1);
    expect(mockFriendCents).toHaveBeenCalledTimes(1);
    // fill gives a stored part the same values.
    expect(batch.fill(BODY.text)).toBe(filled(BODY.text, PAID(5000)));
    expect(batch.fill(BODY.html)).toBe(filled(BODY.html, PAID(5000)));
  });

  test('with no amount the keys are still there: a reader gets the first form, never a raw token', async () => {
    const batch = await referralLineForBatch(PEST_INSIDER, MAILED);
    expect(batch.substitutions).toEqual({ [REFERRAL_TOKEN]: FIRST.html, [REFERRAL_TEXT_TOKEN]: FIRST.text });
    // What the reader reads is what the archive shows.
    expect(batch.fill(BODY.text).split(HOME_TEXT_TOKEN).join('')).toBe(neutralizeIssueTokens(BODY.text));
  });

  test('a paused program gives both keys with an empty value: the tokens leave the mail, and the line with them', async () => {
    mockLiveSettings.mockResolvedValue({ program_active: false });
    const batch = await referralLineForBatch(PEST_INSIDER, MAILED);
    expect(batch.substitutions).toEqual({ [REFERRAL_TOKEN]: '', [REFERRAL_TEXT_TOKEN]: '' });
    const text = batch.fill(BODY.text);
    expect(text).not.toContain('{{pi-referral');
    expect(text).not.toContain('Know a neighbor');
    expect(text).not.toContain('/referral/');
    expect(text.endsWith(`${HOME_TEXT_TOKEN}Catch you next time.\n— The Waves Team\n`)).toBe(true);
  });

  test('a token in one part only still gives both keys', async () => {
    const batch = await referralLineForBatch(PEST_INSIDER, `<p>no token</p>\n${BODY.text}`);
    expect(Object.keys(batch.substitutions)).toEqual([REFERRAL_TOKEN, REFERRAL_TEXT_TOKEN]);
  });

  test('another newsletter that holds the tokens gets the keys with the first form, and no read', async () => {
    mockFriendCents.mockReturnValue(5000);
    for (const send of OTHERS) {
      expect((await referralLineForBatch(send, MAILED)).substitutions).toEqual({ [REFERRAL_TOKEN]: FIRST.html, [REFERRAL_TEXT_TOKEN]: FIRST.text });
    }
    expect(mockFriendCents).not.toHaveBeenCalled();
    expect(mockLiveSettings).not.toHaveBeenCalled();
  });

  test('a body with no token gives no key, reads nothing, and fill gives a part back as it is', async () => {
    mockFriendCents.mockReturnValue(5000);
    for (const content of [neutralizeIssueTokens(MAILED), 'a {{ pi-referral }} variant', '']) {
      const batch = await referralLineForBatch(PEST_INSIDER, content);
      expect(batch.substitutions).toEqual({});
      expect(batch.fill('a part')).toBe('a part');
      expect(batch.fill(null)).toBeNull();
    }
    expect(mockFriendCents).not.toHaveBeenCalled();
    expect(mockLiveSettings).not.toHaveBeenCalled();
  });
});

describe('referralLineAsOfNow: the owner\'s copy and a test send', () => {
  test('a Waves Pest Insider issue shows the same line a batch mailed now would get, in both parts', async () => {
    mockFriendCents.mockReturnValue(5000);
    const now = await referralLineAsOfNow(PEST_INSIDER, BODY);
    const batch = await referralLineForBatch(PEST_INSIDER, MAILED);
    expect(now).toEqual({ html: batch.fill(BODY.html), text: batch.fill(BODY.text) });
    expect(now.html).toContain('>Send them our way</a>. They get a $50 credit after their first plan service.</p>');
    expect(now.text).toContain('Send them our way. They get a $50 credit after their first plan service.\n');
    for (const part of [now.html, now.text]) expect(part).not.toContain('{{pi-referral');
    // The stored body is not changed.
    expect(BODY).toEqual({ html: ISSUE.html_body, text: ISSUE.text_body });
  });

  test('with no amount it shows the first form; with the program paused it shows no line', async () => {
    expect(await referralLineAsOfNow(PEST_INSIDER, BODY)).toEqual({ html: filled(BODY.html, FIRST), text: filled(BODY.text, FIRST) });
    mockLiveSettings.mockResolvedValue({ program_active: false });
    const paused = await referralLineAsOfNow(PEST_INSIDER, BODY);
    expect(paused).toEqual({ html: filled(BODY.html, NO_LINE), text: filled(BODY.text, NO_LINE) });
    for (const part of [paused.html, paused.text]) {
      expect(part).not.toContain('{{pi-referral');
      expect(part).not.toContain('Know a neighbor');
    }
  });

  test('each part is filled on its own: a copy whose text part is another text (a banner) still gets its HTML line', async () => {
    mockFriendCents.mockReturnValue(5000);
    const now = await referralLineAsOfNow(PEST_INSIDER, { html: BODY.html, text: 'FYI: this issue goes out Thursday.' });
    expect(now.html).toBe(filled(BODY.html, PAID(5000)));
    expect(now.text).toBe('FYI: this issue goes out Thursday.');
    const htmlOnly = await referralLineAsOfNow(PEST_INSIDER, { html: BODY.html, text: null });
    expect(htmlOnly).toEqual({ html: filled(BODY.html, PAID(5000)), text: null });
  });

  test('another newsletter that holds the tokens shows the first form and reads nothing', async () => {
    mockFriendCents.mockReturnValue(5000);
    expect(await referralLineAsOfNow({ newsletter_type: 'free-form' }, BODY)).toEqual({ html: filled(BODY.html, FIRST), text: filled(BODY.text, FIRST) });
    expect(mockFriendCents).not.toHaveBeenCalled();
  });

  test('bodies with no token come back as given, the same object, with no read', async () => {
    mockFriendCents.mockReturnValue(5000);
    const plain = { html: '<p>Hello</p>', text: 'Hello' };
    expect(await referralLineAsOfNow(PEST_INSIDER, plain)).toBe(plain);
    expect(mockFriendCents).not.toHaveBeenCalled();
  });
});

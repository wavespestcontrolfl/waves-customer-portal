/**
 * The Waves Pest Insider's referral line (services/pest-insider/referral-line.js):
 * an issue's stored body holds a token for the line's end and never an
 * amount. A surface with no reader shows the first approved form. The sender
 * fills the token once per batch from the referral program's live setting,
 * and the owner's copy is filled by the same rule. Only an issue of the Pest
 * Insider's own type gets an amount.
 */
const mockFriendCents = jest.fn();
const mockWarn = jest.fn();
jest.mock('../services/referral-engine', () => ({ step2FriendCreditCents: (...args) => mockFriendCents(...args) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: (...args) => mockWarn(...args), debug: jest.fn() }));

const {
  REFERRAL_TAIL_TOKEN, hasReferralToken, neutralizeIssueTokens,
  referralTailFor, referralTailSubstitution, referralLineAsOfNow,
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
const OTHERS = [{ newsletter_type: 'local-weekly-fresh-events' }, { newsletter_type: 'free-form' }, { newsletter_type: null }, {}, null];
const FIRST_END = ' — referrals are the nicest compliment we get.';
const AMOUNT_END = (amount) => `. They get a ${amount} credit after their first plan service.`;
const filled = (part, end) => part.split(REFERRAL_TAIL_TOKEN).join(end);

beforeEach(() => {
  mockFriendCents.mockReset();
  mockFriendCents.mockResolvedValue(0);
  mockWarn.mockReset();
});

describe('the token in an issue', () => {
  test('a rendered issue holds it in both parts; only the exact spelling is the token', () => {
    expect(hasReferralToken(BODY.html)).toBe(true);
    expect(hasReferralToken(BODY.text)).toBe(true);
    for (const not of ['{{ pi-referral-tail }}', '{{PI-REFERRAL-TAIL}}', '{{pi-referral-tail-text}}', '', null, undefined]) expect(hasReferralToken(not)).toBe(false);
  });

  test('neutralizeIssueTokens gives the first form\'s end and removes the "Your home" tokens, in one call', () => {
    expect(neutralizeIssueTokens(`a${HOME_TOKEN}b${HOME_TEXT_TOKEN}c${REFERRAL_TAIL_TOKEN}`)).toBe(`abc${FIRST_END}`);
    expect(neutralizeIssueTokens(BODY.text)).toBe(filled(BODY.text, FIRST_END).split(HOME_TEXT_TOKEN).join(''));
    expect(neutralizeIssueTokens(null)).toBe('');
    expect(mockFriendCents).not.toHaveBeenCalled();
  });
});

describe('referralTailFor: the token\'s value as of now', () => {
  test('a Waves Pest Insider issue gets the amount end for the live setting', async () => {
    mockFriendCents.mockResolvedValue(5000);
    expect(await referralTailFor(PEST_INSIDER)).toBe(AMOUNT_END('$50'));
    mockFriendCents.mockResolvedValue(2500);
    expect(await referralTailFor(PEST_INSIDER)).toBe(AMOUNT_END('$25'));
  });

  test('with no amount (gate off, program paused or setting unreadable: 0) it gets the first form\'s end', async () => {
    expect(await referralTailFor(PEST_INSIDER)).toBe(FIRST_END);
    expect(mockFriendCents).toHaveBeenCalledTimes(1);
  });

  test('a read that throws gives the first form\'s end and one warning: it never stops a batch or the owner\'s copy', async () => {
    mockFriendCents.mockRejectedValue(new Error('settings table gone'));
    expect(await referralTailFor(PEST_INSIDER)).toBe(FIRST_END);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0][0]).toMatch(/referral line.*settings table gone/);
  });

  test('any other newsletter gets the first form\'s end and reads no setting, whatever the setting holds', async () => {
    mockFriendCents.mockResolvedValue(5000);
    for (const send of OTHERS) expect(await referralTailFor(send)).toBe(FIRST_END);
    expect(mockFriendCents).not.toHaveBeenCalled();
  });
});

describe('referralTailSubstitution: one batch\'s key', () => {
  test('a body that holds the token gives the key, with one read for the batch', async () => {
    mockFriendCents.mockResolvedValue(5000);
    expect(await referralTailSubstitution(PEST_INSIDER, MAILED)).toEqual({ [REFERRAL_TAIL_TOKEN]: AMOUNT_END('$50') });
    expect(mockFriendCents).toHaveBeenCalledTimes(1);
  });

  test('with no amount the key is still there: a reader gets the first form, never the raw token', async () => {
    const subs = await referralTailSubstitution(PEST_INSIDER, MAILED);
    expect(subs).toEqual({ [REFERRAL_TAIL_TOKEN]: FIRST_END });
    // What the reader reads is what the archive shows.
    expect(filled(BODY.text, subs[REFERRAL_TAIL_TOKEN]).split(HOME_TEXT_TOKEN).join('')).toBe(neutralizeIssueTokens(BODY.text));
  });

  test('the token in one part only still gives the key', async () => {
    expect(await referralTailSubstitution(PEST_INSIDER, `<p>no token</p>\n${BODY.text}`)).toEqual({ [REFERRAL_TAIL_TOKEN]: FIRST_END });
  });

  test('another newsletter that holds the token gets the key with the first form\'s end, and no read', async () => {
    mockFriendCents.mockResolvedValue(5000);
    for (const send of OTHERS) expect(await referralTailSubstitution(send, MAILED)).toEqual({ [REFERRAL_TAIL_TOKEN]: FIRST_END });
    expect(mockFriendCents).not.toHaveBeenCalled();
  });

  test('a body with no token gives no key and reads no setting', async () => {
    mockFriendCents.mockResolvedValue(5000);
    expect(await referralTailSubstitution(PEST_INSIDER, neutralizeIssueTokens(MAILED))).toEqual({});
    expect(await referralTailSubstitution(PEST_INSIDER, 'a {{ pi-referral-tail }} variant')).toEqual({});
    expect(await referralTailSubstitution(PEST_INSIDER, '')).toEqual({});
    expect(mockFriendCents).not.toHaveBeenCalled();
  });
});

describe('referralLineAsOfNow: the owner\'s copy and a test send', () => {
  test('a Waves Pest Insider issue shows the same words a batch mailed now would get, in both parts', async () => {
    mockFriendCents.mockResolvedValue(5000);
    const now = await referralLineAsOfNow(PEST_INSIDER, BODY);
    const subs = await referralTailSubstitution(PEST_INSIDER, MAILED);
    expect(now).toEqual({ html: filled(BODY.html, subs[REFERRAL_TAIL_TOKEN]), text: filled(BODY.text, subs[REFERRAL_TAIL_TOKEN]) });
    expect(now.html).toContain(`>Send them our way</a>${AMOUNT_END('$50')}</p>`);
    expect(now.text).toContain(`Send them our way${AMOUNT_END('$50')}\n`);
    for (const part of [now.html, now.text]) expect(part).not.toContain(REFERRAL_TAIL_TOKEN);
    // The stored body is not changed.
    expect(BODY).toEqual({ html: ISSUE.html_body, text: ISSUE.text_body });
  });

  test('with no amount it shows the first form', async () => {
    expect(await referralLineAsOfNow(PEST_INSIDER, BODY)).toEqual({ html: filled(BODY.html, FIRST_END), text: filled(BODY.text, FIRST_END) });
  });

  test('each part is filled on its own: a copy whose text part is another text (a banner) still gets its HTML line', async () => {
    mockFriendCents.mockResolvedValue(5000);
    const now = await referralLineAsOfNow(PEST_INSIDER, { html: BODY.html, text: 'FYI: this issue goes out Thursday.' });
    expect(now.html).toBe(filled(BODY.html, AMOUNT_END('$50')));
    expect(now.text).toBe('FYI: this issue goes out Thursday.');
    const htmlOnly = await referralLineAsOfNow(PEST_INSIDER, { html: BODY.html, text: null });
    expect(htmlOnly).toEqual({ html: filled(BODY.html, AMOUNT_END('$50')), text: null });
  });

  test('another newsletter that holds the token shows the first form and reads no setting', async () => {
    mockFriendCents.mockResolvedValue(5000);
    expect(await referralLineAsOfNow({ newsletter_type: 'free-form' }, BODY)).toEqual({ html: filled(BODY.html, FIRST_END), text: filled(BODY.text, FIRST_END) });
    expect(mockFriendCents).not.toHaveBeenCalled();
  });

  test('bodies with no token come back as given, the same object, with no read', async () => {
    mockFriendCents.mockResolvedValue(5000);
    const plain = { html: '<p>Hello</p>', text: 'Hello' };
    expect(await referralLineAsOfNow(PEST_INSIDER, plain)).toBe(plain);
    expect(mockFriendCents).not.toHaveBeenCalled();
  });
});

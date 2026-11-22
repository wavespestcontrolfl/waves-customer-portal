/**
 * The Waves Pest Insider's referral line at the time of use
 * (services/pest-insider/referral-line.js): the stored body never names the
 * friend's credit; the sender's copy holds a token that each batch fills from
 * the referral program's live setting, and the owner's copy shows the line as
 * a reader would get it now. Only an issue of the Pest Insider's own type is
 * touched.
 */
const mockFriendCents = jest.fn();
const mockWarn = jest.fn();
jest.mock('../services/referral-engine', () => ({ step2FriendCreditCents: (...args) => mockFriendCents(...args) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: (...args) => mockWarn(...args), debug: jest.fn() }));

const { referralTokenCopy, referralTailSubstitution, referralLineAsOfNow, REFERRAL_TAIL_TOKEN } = require('../services/pest-insider/referral-line');
const { renderIssue } = require('../services/pest-insider/render');
const { POST_URLS } = require('../services/pest-insider/posts');

const ISSUE = renderIssue({
  subject: 'Synthetic subject',
  preview: 'Synthetic preview',
  lead: { headline: 'Dry eggs, wet future', sentences: [{ text: 'The CDC says eggs survive 8 months.' }], postUrl: [...POST_URLS][0] },
  idItem: { text: 'It raises a generation in about a week.', species: { slug: 'aedes-mosquito', name: 'Aedes Mosquito' } },
});
const BODY = { html: ISSUE.html_body, text: ISSUE.text_body };
const PEST_INSIDER = { id: 'send-1', newsletter_type: 'pest-insider-monthly' };
const STORED_END = ' — referrals are the nicest compliment we get.';
const AMOUNT_END = (amount) => `. They get a ${amount} credit after their first plan service.`;

beforeEach(() => {
  mockFriendCents.mockReset();
  mockFriendCents.mockResolvedValue(0);
  mockWarn.mockReset();
});

describe('referralTokenCopy: the sender\'s copy', () => {
  test('a Waves Pest Insider issue gets the token in the place of the line\'s end, in both parts, and reads no setting', () => {
    const { body, token } = referralTokenCopy(PEST_INSIDER, BODY);
    expect(token).toBe(REFERRAL_TAIL_TOKEN);
    expect(body.html.split(REFERRAL_TAIL_TOKEN)).toHaveLength(2);
    expect(body.text.split(REFERRAL_TAIL_TOKEN)).toHaveLength(2);
    expect(body.html).not.toContain(STORED_END);
    expect(body.text).not.toContain(STORED_END);
    // The stored body is not changed, and the copy is the same each time (a resumed send builds the same one).
    expect(BODY).toEqual({ html: ISSUE.html_body, text: ISSUE.text_body });
    expect(referralTokenCopy(PEST_INSIDER, BODY)).toEqual({ body, token });
    expect(mockFriendCents).not.toHaveBeenCalled();
  });

  test('an issue with no text part still gets its token; an issue whose line was edited by hand gets none', () => {
    expect(referralTokenCopy(PEST_INSIDER, { html: BODY.html, text: null })).toEqual({
      body: { html: referralTokenCopy(PEST_INSIDER, BODY).body.html, text: null }, token: REFERRAL_TAIL_TOKEN,
    });
    const edited = { html: BODY.html.replace('nicest compliment', 'best compliment'), text: BODY.text.replace('nicest compliment', 'best compliment') };
    expect(referralTokenCopy(PEST_INSIDER, edited)).toEqual({ body: edited, token: null });
  });

  test('another newsletter keeps its body, the same object, even when it holds the very same line', () => {
    for (const send of [{ newsletter_type: 'local-weekly-fresh-events' }, { newsletter_type: 'free-form' }, { newsletter_type: null }, {}, null]) {
      const out = referralTokenCopy(send, BODY);
      expect(out.token).toBeNull();
      expect(out.body).toBe(BODY);
    }
  });
});

describe('referralTailSubstitution: one batch\'s value', () => {
  test('the value is the amount sentence for the live setting, read once for the batch', async () => {
    mockFriendCents.mockResolvedValue(5000);
    expect(await referralTailSubstitution(REFERRAL_TAIL_TOKEN)).toEqual({ [REFERRAL_TAIL_TOKEN]: AMOUNT_END('$50') });
    expect(mockFriendCents).toHaveBeenCalledTimes(1);
    mockFriendCents.mockResolvedValue(2500);
    expect(await referralTailSubstitution(REFERRAL_TAIL_TOKEN)).toEqual({ [REFERRAL_TAIL_TOKEN]: AMOUNT_END('$25') });
  });

  test('with no amount (gate off, program paused or setting unreadable: 0) the key is still there, with the stored end', async () => {
    expect(await referralTailSubstitution(REFERRAL_TAIL_TOKEN)).toEqual({ [REFERRAL_TAIL_TOKEN]: STORED_END });
  });

  test('a read that throws gives the stored end and one warning: it never stops the batch or the owner\'s copy', async () => {
    mockFriendCents.mockRejectedValue(new Error('settings table gone'));
    expect(await referralTailSubstitution(REFERRAL_TAIL_TOKEN)).toEqual({ [REFERRAL_TAIL_TOKEN]: STORED_END });
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0][0]).toMatch(/referral line.*settings table gone/);
    expect(await referralLineAsOfNow(PEST_INSIDER, BODY)).toEqual(BODY);
  });

  test('no token gives no key and reads no setting', async () => {
    expect(await referralTailSubstitution(null)).toEqual({});
    expect(mockFriendCents).not.toHaveBeenCalled();
  });

  test('a reader of the token copy gets exactly the stored body while there is no amount', async () => {
    const { body, token } = referralTokenCopy(PEST_INSIDER, BODY);
    const subs = await referralTailSubstitution(token);
    expect(body.html.split(token).join(subs[token])).toBe(BODY.html);
    expect(body.text.split(token).join(subs[token])).toBe(BODY.text);
  });
});

describe('referralLineAsOfNow: the owner\'s copy and a test send', () => {
  test('a Waves Pest Insider issue shows the amount sentence while the setting gives an amount', async () => {
    mockFriendCents.mockResolvedValue(5000);
    const now = await referralLineAsOfNow(PEST_INSIDER, BODY);
    expect(now.html).toContain(`>Send them our way</a>${AMOUNT_END('$50')}</p>`);
    expect(now.text).toContain(`Send them our way${AMOUNT_END('$50')}\n`);
    expect(now.html).not.toContain(STORED_END);
    expect(now.text).not.toContain(REFERRAL_TAIL_TOKEN);
    // The same words the batch's readers get.
    const { body, token } = referralTokenCopy(PEST_INSIDER, BODY);
    const subs = await referralTailSubstitution(token);
    expect(now).toEqual({ html: body.html.split(token).join(subs[token]), text: body.text.split(token).join(subs[token]) });
  });

  test('with no amount it shows the stored line', async () => {
    expect(await referralLineAsOfNow(PEST_INSIDER, BODY)).toEqual(BODY);
  });

  test('another newsletter keeps its body, the same object, and reads no setting', async () => {
    mockFriendCents.mockResolvedValue(5000);
    expect(await referralLineAsOfNow({ newsletter_type: 'local-weekly-fresh-events' }, BODY)).toBe(BODY);
    expect(mockFriendCents).not.toHaveBeenCalled();
  });
});

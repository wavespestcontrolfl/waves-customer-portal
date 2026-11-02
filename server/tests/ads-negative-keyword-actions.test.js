/**
 * Negative keyword actions (owner plan A, 2026-11-02, PR 2): Add / Decline on an advisor word, Undo, the owner's word
 * list (add, remove, the sync that makes Google match it) and the Ads page's lists. In-memory rows
 * (tests/helpers/negatives-fake-db.js) and a stubbed Google; the real SQL runs in ad-negative-words-postgres.test.js.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ adsNegativesLive: jest.fn(() => true) }));
let mockDb;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockDb(...args);
  proxy.raw = (...args) => mockDb.raw(...args);
  proxy.transaction = (...args) => mockDb.transaction(...args);
  return proxy;
});
jest.mock('../services/ads/google-ads', () => ({
  addCampaignNegativeKeyword: jest.fn(),
  removeCampaignNegativeKeyword: jest.fn(),
  convertingSearchTerms: jest.fn(),
}));
jest.mock('../services/admin-alert-episodes', () => ({ closeAdminAlertKeys: jest.fn().mockResolvedValue(1) }));

const { createFakeDb } = require('./helpers/negatives-fake-db');
const gates = require('../config/feature-gates');
const google = require('../services/ads/google-ads');
const episodes = require('../services/admin-alert-episodes');
const actions = require('../services/ads/negative-keyword-actions');

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const C_PAUSED = '33333333-3333-4333-8333-333333333333';
const C_UNLINKED = '44444444-4444-4444-8444-444444444444';
const N1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const N2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const W1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const campaigns = () => [
  { id: C1, campaign_name: 'Synthetic Search One', platform: 'google_ads', platform_campaign_id: '9000000001', status: 'active' },
  { id: C2, campaign_name: 'Synthetic Search Two', platform: 'google_ads', platform_campaign_id: '9000000002', status: 'active' },
  { id: C_PAUSED, campaign_name: 'Synthetic Paused', platform: 'google_ads', platform_campaign_id: '9000000003', status: 'paused' },
  { id: C_UNLINKED, campaign_name: 'Synthetic Unlinked', platform: 'google_ads', platform_campaign_id: null, status: 'active' },
];
const advisorRow = (over = {}) => ({
  id: N1, campaign_id: C1, text: 'squirrel', source: 'advisor', state: 'pending', reason: 'Six clicks, no calls.', metrics: { term: 'squirrel removal', clicks: 6, cost: 9.5, conversions: 0 }, ...over,
});
const RESOURCE = (n) => `customers/1/campaignCriteria/${n}~1`;
let seq;
const rows = (name) => mockDb.tables[name];
const rowOf = (id) => rows('ad_negative_keywords').find((r) => r.id === id);
const ownerRows = (text) => rows('ad_negative_keywords').filter((r) => r.text === text);

function setup(seed = {}) {
  mockDb = createFakeDb({ ad_campaigns: campaigns(), ...seed });
}

beforeEach(() => {
  jest.clearAllMocks();
  gates.adsNegativesLive.mockReturnValue(true);
  seq = 0;
  google.convertingSearchTerms.mockResolvedValue([]);
  google.addCampaignNegativeKeyword.mockImplementation(async () => { seq += 1; return { success: true, resourceName: RESOURCE(seq) }; });
  google.removeCampaignNegativeKeyword.mockImplementation(async (resourceName) => ({ success: true, resourceName }));
  setup();
});

describe('gate off', () => {
  test('every function is a no-op: no read, no write, no Google call', async () => {
    gates.adsNegativesLive.mockReturnValue(false);
    setup({ ad_negative_keywords: [advisorRow()], ad_negative_words: [{ id: W1, text: 'snake' }] });
    const before = JSON.stringify(mockDb.tables);
    expect(await actions.decideSuggestion(N1, 'add', { by: 'a' })).toMatchObject({ ok: false, code: 'off' });
    expect(await actions.undoNegative(N1, { by: 'a' })).toMatchObject({ ok: false, code: 'off' });
    expect(await actions.addOwnerWord('squirrel', { by: 'a' })).toMatchObject({ ok: false, code: 'off' });
    expect(await actions.removeOwnerWord(W1, { by: 'a' })).toMatchObject({ ok: false, code: 'off' });
    expect(await actions.syncOwnerWords()).toMatchObject({ pushed: 0, failed: 0, removed: 0, skipped: 'off' });
    expect(await actions.queueAdvisorNegatives({ recommendations: [{ apply_action: 'add_negative', apply_value: 'x', campaign_id: C1 }] })).toMatchObject({ skipped: 'off' });
    expect(await actions.ringNegativeBells()).toBe(0);
    expect(JSON.stringify(mockDb.tables)).toBe(before);
    for (const fn of Object.values(google)) expect(fn).not.toHaveBeenCalled();
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });
});

describe('decideSuggestion', () => {
  beforeEach(() => setup({ ad_negative_keywords: [advisorRow()] }));

  test('Decline records the answer, calls Google never, and closes the bell in the same transaction', async () => {
    const out = await actions.decideSuggestion(N1, 'decline', { by: 'staff-1' });
    expect(out).toEqual({ ok: true, state: 'declined', message: 'Declined "squirrel".' });
    expect(rowOf(N1)).toMatchObject({ state: 'declined', decided_by: 'staff-1', reason: 'Six clicks, no calls.' });
    expect(rowOf(N1).decided_at).toBeInstanceOf(Date);
    expect(google.convertingSearchTerms).not.toHaveBeenCalled();
    expect(google.addCampaignNegativeKeyword).not.toHaveBeenCalled();
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(expect.anything(), [`ads-negative:${N1}`], 'negative_decided', { resolution: 'Declined' });
  });

  test('Add checks conversions, writes the phrase negative to the campaign, stores the resource name and closes the bell', async () => {
    const out = await actions.decideSuggestion(N1, 'add', { by: 'staff-1' });
    expect(out).toEqual({ ok: true, state: 'active', message: 'Blocked "squirrel" in Google Ads.' });
    expect(google.convertingSearchTerms).toHaveBeenCalledWith(90);
    expect(google.addCampaignNegativeKeyword).toHaveBeenCalledWith('9000000001', 'squirrel');
    expect(rowOf(N1)).toMatchObject({ state: 'active', google_resource_name: RESOURCE(1), decided_by: 'staff-1', last_error: null });
    expect(rowOf(N1).pushed_at).toBeInstanceOf(Date);
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(expect.anything(), [`ads-negative:${N1}`], 'negative_decided', { resolution: 'Added' });
  });

  test.each([
    ['gone', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa99'],
    ['gone', 'not-an-id'],
  ])('%s: %s', async (code, id) => {
    expect(await actions.decideSuggestion(id, 'add')).toMatchObject({ ok: false, code });
    expect(google.addCampaignNegativeKeyword).not.toHaveBeenCalled();
  });

  test('invalid decision is refused before anything is read', async () => {
    expect(await actions.decideSuggestion(N1, 'maybe')).toMatchObject({ ok: false, code: 'invalid' });
    expect(rowOf(N1).state).toBe('pending');
  });

  test.each(['active', 'declined', 'removed', 'failed'])('decided: a word already %s cannot be decided again', async (state) => {
    rowOf(N1).state = state;
    const out = await actions.decideSuggestion(N1, 'add');
    expect(out).toMatchObject({ ok: false, code: 'decided' });
    expect(google.addCampaignNegativeKeyword).not.toHaveBeenCalled();
    expect(rowOf(N1).state).toBe(state);
  });

  test('decided: a pending row of the owner\'s list is not an advisor word to decide', async () => {
    rowOf(N1).source = 'owner_list';
    expect(await actions.decideSuggestion(N1, 'add')).toMatchObject({ ok: false, code: 'decided' });
  });

  test.each([['unlinked', C_UNLINKED], ['paused', C_PAUSED]])('not_linked: a %s campaign leaves the row pending and the bell open', async (_n, campaignId) => {
    rowOf(N1).campaign_id = campaignId;
    expect(await actions.decideSuggestion(N1, 'add')).toMatchObject({ ok: false, code: 'not_linked' });
    expect(rowOf(N1).state).toBe('pending');
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
    expect(google.addCampaignNegativeKeyword).not.toHaveBeenCalled();
  });

  test('protected: a brand, service or city word is declined (reason kept), not blocked, and the bell closes', async () => {
    rowOf(N1).text = 'ant control';
    const out = await actions.decideSuggestion(N1, 'add', { by: 'staff-1' });
    expect(out).toMatchObject({ ok: false, code: 'protected' });
    expect(out.message).toContain('"ant control" contains the service word "ant"');
    expect(rowOf(N1)).toMatchObject({ state: 'declined', reason: 'Six clicks, no calls.' });
    expect(google.addCampaignNegativeKeyword).not.toHaveBeenCalled();
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledTimes(1);
  });

  test('converted: a converting search in 90 days that contains the word marks the row failed and closes the bell', async () => {
    google.convertingSearchTerms.mockResolvedValue([{ term: 'Squirrel proof bird feeder', campaignId: '9000000002', conversions: 1 }]);
    const out = await actions.decideSuggestion(N1, 'add', { by: 'staff-1' });
    expect(out).toMatchObject({ ok: false, code: 'converted', message: 'A search with this word brought a conversion in the last 90 days, so it was not blocked.' });
    expect(rowOf(N1)).toMatchObject({ state: 'failed', last_error: 'converted' });
    expect(google.addCampaignNegativeKeyword).not.toHaveBeenCalled();
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledTimes(1);
  });

  test('a converting search with only a plural or close variant does not stop a phrase negative', async () => {
    google.convertingSearchTerms.mockResolvedValue([{ term: 'squirrels in attic', campaignId: '9000000002', conversions: 1 }]);
    expect(await actions.decideSuggestion(N1, 'add')).toMatchObject({ ok: true, state: 'active' });
  });

  test('google_unavailable: the conversion read failed, the row is unchanged and the bell stays', async () => {
    google.convertingSearchTerms.mockResolvedValue(null);
    expect(await actions.decideSuggestion(N1, 'add')).toMatchObject({ ok: false, code: 'google_unavailable', message: 'Google Ads did not answer. Try again later.' });
    expect(rowOf(N1)).toMatchObject({ state: 'pending', last_error: null });
    expect(google.addCampaignNegativeKeyword).not.toHaveBeenCalled();
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('google_error: the write failed, the row stays pending with last_error and the bell stays', async () => {
    google.addCampaignNegativeKeyword.mockResolvedValue(null);
    expect(await actions.decideSuggestion(N1, 'add')).toMatchObject({ ok: false, code: 'google_error' });
    expect(rowOf(N1)).toMatchObject({ state: 'pending', google_resource_name: null });
    expect(rowOf(N1).last_error).toContain('Google Ads');
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('a failure while closing the bell rolls the whole decision back', async () => {
    episodes.closeAdminAlertKeys.mockRejectedValueOnce(new Error('db down'));
    await expect(actions.decideSuggestion(N1, 'decline')).rejects.toThrow('db down');
    expect(rowOf(N1).state).toBe('pending');
  });

  test('the row is read under the transaction lock, so two taps cannot both write', async () => {
    const calls = [];
    const real = mockDb.transaction;
    mockDb.transaction = (fn) => real((trx) => fn(Object.assign((...a) => { const b = trx(...a); const fu = b.forUpdate; b.forUpdate = () => { calls.push(a[0]); return fu(); }; return b; }, trx)));
    await actions.decideSuggestion(N1, 'decline');
    expect(calls).toContain('ad_negative_keywords');
  });
});

describe('undoNegative', () => {
  const active = (over = {}) => advisorRow({ state: 'active', google_resource_name: RESOURCE(7), ...over });

  test('removes an approved advisor word from Google and records it', async () => {
    setup({ ad_negative_keywords: [active()] });
    const out = await actions.undoNegative(N1, { by: 'staff-1' });
    expect(out).toEqual({ ok: true, state: 'removed', message: 'Undone: "squirrel" is no longer blocked in Google Ads.' });
    expect(google.removeCampaignNegativeKeyword).toHaveBeenCalledWith(RESOURCE(7));
    expect(rowOf(N1)).toMatchObject({ state: 'removed', decided_by: 'staff-1' });
    expect(rowOf(N1).removed_at).toBeInstanceOf(Date);
  });

  test('a manual word can be undone the same way', async () => {
    setup({ ad_negative_keywords: [active({ source: 'manual' })] });
    expect(await actions.undoNegative(N1)).toMatchObject({ ok: true, state: 'removed' });
  });

  test.each([
    ['pending', { state: 'pending' }],
    ['removed', { state: 'removed' }],
    ['active with no resource name', { google_resource_name: null }],
  ])('not_active: %s', async (_n, over) => {
    setup({ ad_negative_keywords: [active(over)] });
    expect(await actions.undoNegative(N1)).toMatchObject({ ok: false, code: 'not_active' });
    expect(google.removeCampaignNegativeKeyword).not.toHaveBeenCalled();
  });

  test('owner_list: a list word is removed from the list, not undone', async () => {
    setup({ ad_negative_keywords: [active({ source: 'owner_list' })] });
    expect(await actions.undoNegative(N1)).toMatchObject({ ok: false, code: 'owner_list', message: 'Remove it from your word list.' });
    expect(google.removeCampaignNegativeKeyword).not.toHaveBeenCalled();
  });

  test('gone', async () => {
    expect(await actions.undoNegative(N2)).toMatchObject({ ok: false, code: 'gone' });
    expect(await actions.undoNegative('nope')).toMatchObject({ ok: false, code: 'gone' });
  });

  test('google_error: the row stays active with last_error', async () => {
    setup({ ad_negative_keywords: [active()] });
    google.removeCampaignNegativeKeyword.mockResolvedValue(null);
    expect(await actions.undoNegative(N1)).toMatchObject({ ok: false, code: 'google_error' });
    expect(rowOf(N1)).toMatchObject({ state: 'active', google_resource_name: RESOURCE(7) });
    expect(rowOf(N1).last_error).toContain('Google Ads');
  });
});

describe('addOwnerWord', () => {
  test('saves a normalized word and pushes it to every linked active campaign, with no bell', async () => {
    const out = await actions.addOwnerWord('  Squirrel  Removal ', { by: 'staff-1' });
    expect(out.ok).toBe(true);
    expect(rows('ad_negative_words')).toHaveLength(1);
    expect(rows('ad_negative_words')[0]).toMatchObject({ text: 'squirrel removal', added_by: 'staff-1', removed_at: null });
    expect(google.addCampaignNegativeKeyword.mock.calls.map((c) => c[0]).sort()).toEqual(['9000000001', '9000000002']);
    expect(ownerRows('squirrel removal')).toHaveLength(2);
    for (const r of ownerRows('squirrel removal')) expect(r).toMatchObject({ source: 'owner_list', state: 'active' });
    expect(out.word).toMatchObject({ text: 'squirrel removal' });
    expect(out.word.campaigns.map((c) => [c.campaignName, c.state])).toEqual([['Synthetic Search One', 'active'], ['Synthetic Search Two', 'active']]);
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('invalid text: nothing is saved', async () => {
    for (const text of ['', '   ', 'a_b', 'one two three four five', 'x'.repeat(81), 42]) {
      expect(await actions.addOwnerWord(text)).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(rows('ad_negative_words')).toHaveLength(0);
  });

  test.each([['waves pest', '"waves"'], ['pest', 'service word "pest"'], ['venice', 'city "venice"'], ['near me', '"near me"']])('protected: %s', async (text, part) => {
    const out = await actions.addOwnerWord(text);
    expect(out).toMatchObject({ ok: false, code: 'protected' });
    expect(out.message).toContain(part);
    expect(rows('ad_negative_words')).toHaveLength(0);
    expect(google.addCampaignNegativeKeyword).not.toHaveBeenCalled();
  });

  test('a competitor\'s name is allowed on the owner\'s list (the owner\'s call)', async () => {
    expect(await actions.addOwnerWord('orkin')).toMatchObject({ ok: true });
    expect(google.addCampaignNegativeKeyword).toHaveBeenCalledTimes(2);
  });

  test('adding a word twice keeps one list row and does not push an active word again', async () => {
    await actions.addOwnerWord('squirrel');
    google.addCampaignNegativeKeyword.mockClear();
    await actions.addOwnerWord('squirrel');
    expect(rows('ad_negative_words')).toHaveLength(1);
    expect(google.addCampaignNegativeKeyword).not.toHaveBeenCalled();
  });

  test('a converting word is saved but not sent: each campaign row is failed with "converted"', async () => {
    google.convertingSearchTerms.mockResolvedValue([{ term: 'raccoon proof trash can', campaignId: '9000000001', conversions: 1 }]);
    const out = await actions.addOwnerWord('raccoon');
    expect(out.ok).toBe(true);
    expect(google.addCampaignNegativeKeyword).not.toHaveBeenCalled();
    for (const r of ownerRows('raccoon')) expect(r).toMatchObject({ state: 'failed', last_error: 'converted' });
    expect(out.word.campaigns.every((c) => c.state === 'failed' && c.lastError === 'converted')).toBe(true);
  });

  test('a removed word comes back: removed_at is cleared and it is pushed again', async () => {
    await actions.addOwnerWord('squirrel', { by: 'a' });
    await actions.removeOwnerWord(rows('ad_negative_words')[0].id, { by: 'a' });
    google.addCampaignNegativeKeyword.mockClear();
    const out = await actions.addOwnerWord('squirrel', { by: 'b' });
    expect(rows('ad_negative_words')).toHaveLength(1);
    expect(rows('ad_negative_words')[0]).toMatchObject({ removed_at: null, removed_by: null, added_by: 'b' });
    expect(google.addCampaignNegativeKeyword).toHaveBeenCalledTimes(2);
    expect(out.word.campaigns.every((c) => c.state === 'active')).toBe(true);
  });
});

describe('removeOwnerWord', () => {
  test('sets removed_at, takes active rows out of Google and closes waiting or failed ones', async () => {
    setup({
      ad_negative_words: [{ id: W1, text: 'snake' }],
      ad_negative_keywords: [
        { id: N1, campaign_id: C1, text: 'snake', source: 'owner_list', state: 'active', google_resource_name: RESOURCE(1) },
        { id: N2, campaign_id: C2, text: 'snake', source: 'owner_list', state: 'failed', last_error: 'converted' },
      ],
    });
    const out = await actions.removeOwnerWord(W1, { by: 'staff-1' });
    expect(out).toMatchObject({ ok: true, failed: 0, word: { id: W1, text: 'snake' } });
    expect(out.word.removedAt).toBeInstanceOf(Date);
    expect(rows('ad_negative_words')[0]).toMatchObject({ removed_by: 'staff-1' });
    expect(google.removeCampaignNegativeKeyword).toHaveBeenCalledTimes(1);
    expect(google.removeCampaignNegativeKeyword).toHaveBeenCalledWith(RESOURCE(1));
    expect(rowOf(N1).state).toBe('removed');
    expect(rowOf(N2).state).toBe('removed');
  });

  test('a failed Google remove leaves that row active with last_error and counts it; the other campaign still goes', async () => {
    setup({
      ad_negative_words: [{ id: W1, text: 'snake' }],
      ad_negative_keywords: [
        { id: N1, campaign_id: C1, text: 'snake', source: 'owner_list', state: 'active', google_resource_name: RESOURCE(1) },
        { id: N2, campaign_id: C2, text: 'snake', source: 'owner_list', state: 'active', google_resource_name: RESOURCE(2) },
      ],
    });
    google.removeCampaignNegativeKeyword.mockImplementation(async (name) => (name === RESOURCE(1) ? null : { success: true }));
    const out = await actions.removeOwnerWord(W1);
    expect(out).toMatchObject({ ok: true, failed: 1 });
    expect(rowOf(N1)).toMatchObject({ state: 'active' });
    expect(rowOf(N1).last_error).toContain('Google Ads');
    expect(rowOf(N2).state).toBe('removed');
    // The nightly sync retries the leftover.
    google.removeCampaignNegativeKeyword.mockImplementation(async (name) => ({ success: true, resourceName: name }));
    expect(await actions.syncOwnerWords()).toMatchObject({ removed: 1, failed: 0 });
    expect(rowOf(N1).state).toBe('removed');
  });

  test('never touches advisor or manual rows of the same text', async () => {
    setup({
      ad_negative_words: [{ id: W1, text: 'snake' }],
      ad_negative_keywords: [{ id: N1, campaign_id: C1, text: 'snake', source: 'advisor', state: 'active', google_resource_name: RESOURCE(1) }],
    });
    await actions.removeOwnerWord(W1);
    expect(google.removeCampaignNegativeKeyword).not.toHaveBeenCalled();
    expect(rowOf(N1).state).toBe('active');
  });

  test('gone', async () => {
    expect(await actions.removeOwnerWord(W1)).toMatchObject({ ok: false, code: 'gone' });
    expect(await actions.removeOwnerWord('nope')).toMatchObject({ ok: false, code: 'gone' });
  });

  test('removing a word that is already removed answers the same way and does not move removed_at', async () => {
    const at = new Date('2026-11-01T12:00:00Z');
    setup({ ad_negative_words: [{ id: W1, text: 'snake', removed_at: at }] });
    const out = await actions.removeOwnerWord(W1);
    expect(out).toMatchObject({ ok: true, failed: 0 });
    expect(rows('ad_negative_words')[0].removed_at).toEqual(at);
  });
});

describe('syncOwnerWords', () => {
  test('a new live word is inserted as owner_list on each linked active campaign and pushed; paused and unlinked campaigns get nothing', async () => {
    setup({ ad_negative_words: [{ id: W1, text: 'snake' }] });
    expect(await actions.syncOwnerWords()).toEqual({ pushed: 2, failed: 0, removed: 0 });
    expect(ownerRows('snake').map((r) => r.campaign_id).sort()).toEqual([C1, C2]);
    expect(google.convertingSearchTerms).toHaveBeenCalledTimes(1);
  });

  test('one conversion read per run, however many words and campaigns', async () => {
    setup({ ad_negative_words: [{ id: W1, text: 'snake' }, { id: N2, text: 'jobs' }, { id: N1, text: 'hiring' }] });
    await actions.syncOwnerWords();
    expect(google.convertingSearchTerms).toHaveBeenCalledTimes(1);
    expect(google.addCampaignNegativeKeyword).toHaveBeenCalledTimes(6);
  });

  test('already active rows are left alone', async () => {
    setup({
      ad_negative_words: [{ id: W1, text: 'snake' }],
      ad_negative_keywords: [
        { id: N1, campaign_id: C1, text: 'snake', source: 'owner_list', state: 'active', google_resource_name: RESOURCE(1) },
      ],
    });
    expect(await actions.syncOwnerWords()).toEqual({ pushed: 1, failed: 0, removed: 0 });
    expect(google.addCampaignNegativeKeyword).toHaveBeenCalledTimes(1);
    expect(google.addCampaignNegativeKeyword).toHaveBeenCalledWith('9000000002', 'snake');
    expect(rowOf(N1).google_resource_name).toBe(RESOURCE(1));
  });

  test('pending and failed owner rows are pushed again', async () => {
    setup({
      ad_negative_words: [{ id: W1, text: 'snake' }],
      ad_negative_keywords: [
        { id: N1, campaign_id: C1, text: 'snake', source: 'owner_list', state: 'pending' },
        { id: N2, campaign_id: C2, text: 'snake', source: 'owner_list', state: 'failed', last_error: 'Google Ads did not accept the change. Try again later.' },
      ],
    });
    expect(await actions.syncOwnerWords()).toEqual({ pushed: 2, failed: 0, removed: 0 });
    expect(rowOf(N1)).toMatchObject({ state: 'active', last_error: null });
    expect(rowOf(N2)).toMatchObject({ state: 'active', last_error: null });
  });

  test('the owner\'s list wins over a declined or removed advisor row: it becomes owner_list and is pushed', async () => {
    setup({
      ad_negative_words: [{ id: W1, text: 'snake' }],
      ad_negative_keywords: [
        { id: N1, campaign_id: C1, text: 'snake', source: 'advisor', state: 'declined', decided_by: 'staff-1' },
        { id: N2, campaign_id: C2, text: 'snake', source: 'advisor', state: 'removed', google_resource_name: RESOURCE(9) },
      ],
    });
    expect(await actions.syncOwnerWords()).toEqual({ pushed: 2, failed: 0, removed: 0 });
    expect(rowOf(N1)).toMatchObject({ source: 'owner_list', state: 'active' });
    expect(rowOf(N2)).toMatchObject({ source: 'owner_list', state: 'active' });
    expect(rowOf(N2).google_resource_name).not.toBe(RESOURCE(9));
  });

  test('the owner\'s list wins over a pending advisor row and closes that row\'s bell', async () => {
    setup({ ad_negative_words: [{ id: W1, text: 'snake' }], ad_negative_keywords: [advisorRow({ text: 'snake', notified_at: new Date() })] });
    await actions.syncOwnerWords();
    expect(rowOf(N1)).toMatchObject({ source: 'owner_list', state: 'active' });
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(expect.anything(), [`ads-negative:${N1}`], 'negative_decided', expect.objectContaining({ resolution: expect.any(String) }));
  });

  test('an advisor row that is already active is not touched and not duplicated', async () => {
    setup({
      ad_negative_words: [{ id: W1, text: 'snake' }],
      ad_negative_keywords: [advisorRow({ text: 'snake', state: 'active', google_resource_name: RESOURCE(5) })],
    });
    await actions.syncOwnerWords();
    expect(rowOf(N1)).toMatchObject({ source: 'advisor', state: 'active', google_resource_name: RESOURCE(5) });
    expect(ownerRows('snake')).toHaveLength(2);
    expect(google.addCampaignNegativeKeyword).toHaveBeenCalledTimes(1);
  });

  test('a manual row of the same text is overridden only when it is not active', async () => {
    setup({
      ad_negative_words: [{ id: W1, text: 'snake' }],
      ad_negative_keywords: [advisorRow({ text: 'snake', source: 'manual', state: 'removed' })],
    });
    await actions.syncOwnerWords();
    expect(rowOf(N1)).toMatchObject({ source: 'owner_list', state: 'active' });
  });

  test('a converting word is failed with "converted" and retried the next run; it goes once the conversion has aged out', async () => {
    setup({ ad_negative_words: [{ id: W1, text: 'snake' }] });
    google.convertingSearchTerms.mockResolvedValue([{ term: 'snake tattoo studio', campaignId: '9000000009', conversions: 1 }]);
    expect(await actions.syncOwnerWords()).toEqual({ pushed: 0, failed: 2, removed: 0 });
    for (const r of ownerRows('snake')) expect(r).toMatchObject({ state: 'failed', last_error: 'converted' });
    expect(google.addCampaignNegativeKeyword).not.toHaveBeenCalled();
    google.convertingSearchTerms.mockResolvedValue([]);
    expect(await actions.syncOwnerWords()).toEqual({ pushed: 2, failed: 0, removed: 0 });
    for (const r of ownerRows('snake')) expect(r).toMatchObject({ state: 'active', last_error: null });
  });

  test('the conversion read failing sends nothing and notes it on each waiting row', async () => {
    setup({ ad_negative_words: [{ id: W1, text: 'snake' }] });
    google.convertingSearchTerms.mockResolvedValue(null);
    expect(await actions.syncOwnerWords()).toEqual({ pushed: 0, failed: 2, removed: 0 });
    expect(google.addCampaignNegativeKeyword).not.toHaveBeenCalled();
    for (const r of ownerRows('snake')) expect(r).toMatchObject({ state: 'pending', last_error: 'Google Ads did not answer. Try again later.' });
  });

  test('a Google write that fails marks that row failed and the run continues with the next campaign', async () => {
    setup({ ad_negative_words: [{ id: W1, text: 'snake' }] });
    google.addCampaignNegativeKeyword.mockResolvedValueOnce(null);
    expect(await actions.syncOwnerWords()).toEqual({ pushed: 1, failed: 1, removed: 0 });
    expect(ownerRows('snake').map((r) => r.state).sort()).toEqual(['active', 'failed']);
  });

  test('removed words: owner_list rows still active come out of Google', async () => {
    setup({
      ad_negative_words: [{ id: W1, text: 'snake', removed_at: new Date() }],
      ad_negative_keywords: [{ id: N1, campaign_id: C1, text: 'snake', source: 'owner_list', state: 'active', google_resource_name: RESOURCE(1) }],
    });
    expect(await actions.syncOwnerWords()).toEqual({ pushed: 0, failed: 0, removed: 1 });
    expect(rowOf(N1).state).toBe('removed');
    expect(google.convertingSearchTerms).not.toHaveBeenCalled();
  });

  test('texts limits the run to those words', async () => {
    setup({ ad_negative_words: [{ id: W1, text: 'snake' }, { id: N2, text: 'jobs' }] });
    await actions.syncOwnerWords({ texts: ['jobs'] });
    expect(ownerRows('snake')).toHaveLength(0);
    expect(ownerRows('jobs')).toHaveLength(2);
  });

  test('a word removed while the run was working is not pushed (checked again under the word\'s lock)', async () => {
    setup({ ad_negative_words: [{ id: W1, text: 'snake' }] });
    const real = mockDb.transaction;
    mockDb.transaction = (fn) => real(async (trx) => {
      const raw = trx.raw;
      trx.raw = async (...a) => { const out = await raw(...a); rows('ad_negative_words')[0].removed_at = new Date(); return out; };
      return fn(trx);
    });
    expect(await actions.syncOwnerWords()).toEqual({ pushed: 0, failed: 0, removed: 0 });
    expect(google.addCampaignNegativeKeyword).not.toHaveBeenCalled();
  });

  test('every push for a word runs under that word\'s advisory lock', async () => {
    setup({ ad_negative_words: [{ id: W1, text: 'snake' }] });
    await actions.syncOwnerWords();
    expect(mockDb.calls.locks).toContain('ads-negative:snake');
  });
});

describe('listNegatives', () => {
  test('words with per-campaign states, pending advisor words oldest first, and a log of everything decided', async () => {
    setup({
      ad_negative_words: [{ id: W1, text: 'snake', created_at: new Date('2026-11-02T10:00:00Z') }, { id: N2, text: 'gone word', removed_at: new Date() }],
      ad_negative_keywords: [
        { id: N1, campaign_id: C1, text: 'snake', source: 'owner_list', state: 'failed', last_error: 'converted' },
        advisorRow({ id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', text: 'bat', created_at: new Date('2026-11-02T09:00:00Z') }),
        advisorRow({ id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2', text: 'wasp nest', state: 'active', google_resource_name: RESOURCE(3), updated_at: new Date('2026-11-02T08:00:00Z') }),
        advisorRow({ id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3', text: 'rat poison', state: 'declined', updated_at: new Date('2026-11-02T09:30:00Z') }),
        advisorRow({ id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4', text: 'snake', campaign_id: C2, source: 'owner_list', state: 'active', updated_at: new Date('2026-11-02T07:00:00Z') }),
      ],
    });
    const out = await actions.listNegatives();
    expect(out.words).toHaveLength(1);
    expect(out.words[0]).toMatchObject({ id: W1, text: 'snake', addedAt: '2026-11-02T10:00:00.000Z' });
    expect(out.words[0].campaigns).toEqual([
      { campaignId: C1, campaignName: 'Synthetic Search One', state: 'failed', lastError: 'converted' },
      { campaignId: C2, campaignName: 'Synthetic Search Two', state: 'active', lastError: null },
    ]);
    expect(out.pending).toHaveLength(1);
    expect(out.pending[0]).toMatchObject({
      id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', text: 'bat', campaignId: C1, campaignName: 'Synthetic Search One',
      reason: 'Six clicks, no calls.', metrics: { term: 'squirrel removal', clicks: 6, cost: 9.5, conversions: 0 }, notifiedAt: null,
    });
    expect(out.log.map((l) => `${l.text}:${l.state}`)).toEqual(['snake:failed', 'rat poison:declined', 'wasp nest:active', 'snake:active']);
    expect(out.log.every((l) => l.state !== 'pending')).toBe(true);
    const wasp = out.log.find((l) => l.text === 'wasp nest');
    expect(wasp).toMatchObject({ source: 'advisor', state: 'active', canUndo: true, campaignName: 'Synthetic Search One' });
    expect(out.log.find((l) => l.text === 'rat poison').canUndo).toBe(false);
    expect(out.log.filter((l) => l.source === 'owner_list').every((l) => l.canUndo === false)).toBe(true);
  });

  test('the log is newest-updated first and holds at most 100 rows', async () => {
    const many = Array.from({ length: 105 }, (_v, i) => advisorRow({
      id: `dddddddd-dddd-4ddd-8ddd-${String(i).padStart(12, '0')}`, text: `word ${i}`, state: 'declined', updated_at: new Date(1e12 + i * 1000),
    }));
    setup({ ad_negative_keywords: many });
    const { log } = await actions.listNegatives();
    expect(log).toHaveLength(100);
    expect(log[0].text).toBe('word 104');
  });

  test('a linked campaign with no row yet reads pending (waiting to be sent)', async () => {
    setup({ ad_negative_words: [{ id: W1, text: 'snake' }] });
    const { words } = await actions.listNegatives();
    expect(words[0].campaigns.map((c) => c.state)).toEqual(['pending', 'pending']);
  });
});

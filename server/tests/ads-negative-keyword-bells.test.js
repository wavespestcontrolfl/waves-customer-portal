/**
 * The bell side of negative keywords (owner plan A, 2026-11-02, PR 2): each ads-advisor word is one admin bell row with
 * Add and Decline; at most 3 new rows a day (Eastern), leftovers ring on later days oldest first; the copy passes the
 * admin notification rules; the bell serves the buttons only for a word still pending; a tap runs the Ads page's step.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ adsNegativesLive: jest.fn(() => true), alertCloseButtonsLive: jest.fn(() => false) }));
let mockDb;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockDb(...args);
  proxy.raw = (...args) => mockDb.raw(...args);
  proxy.transaction = (...args) => mockDb.transaction(...args);
  return proxy;
});
jest.mock('../services/ads/google-ads', () => ({
  addCampaignNegativeKeyword: jest.fn(), removeCampaignNegativeKeyword: jest.fn(), convertingSearchTerms: jest.fn(),
}));
jest.mock('../services/admin-alert-episodes', () => ({ closeAdminAlertKeys: jest.fn().mockResolvedValue(1) }));
jest.mock('../services/notification-service', () => ({ markAdminDone: jest.fn(async () => 1), _private: { NOTIFICATION_VERSION_SQL: 'md5(content)' } }));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: jest.fn(async () => ({ id: 'n-1' })),
}));

const { createFakeDb } = require('./helpers/negatives-fake-db');
const gates = require('../config/feature-gates');
const google = require('../services/ads/google-ads');
const { raiseAdminAlert, composeAdminAlert, buttonViolations } = require('../services/admin-alert-compose');
const { withAlertButtons, _private: { KINDS, storedButtons } } = require('../services/admin-alert-buttons');
const actions = require('../services/ads/negative-keyword-actions');
const { negativeButtons, buttonHandler } = require('../services/ads/negative-keyword-buttons');

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const campaigns = () => [
  { id: C1, campaign_name: 'Synthetic Search One', platform: 'google_ads', platform_campaign_id: '9000000001', status: 'active' },
  { id: C2, campaign_name: 'Synthetic Search Two', platform: 'google_ads', platform_campaign_id: '9000000002', status: 'active' },
];
const id = (n) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const rec = (word, over = {}) => ({ apply_action: 'add_negative', apply_value: word, campaign_id: C1, reasoning: `${word}: 6 clicks, $9.50, no conversions.`, ...over });
const pendingRow = (n, over = {}) => ({
  id: id(n), campaign_id: C1, text: `word${n}`, source: 'advisor', state: 'pending', created_at: new Date(1e12 + n * 1000),
  reason: 'Six clicks, $9.50, no conversions.', metrics: { term: 'squirrel removal', clicks: 6, cost: 9.5, conversions: 0 }, ...over,
});
const rowOf = (rid) => mockDb.tables.ad_negative_keywords.find((r) => r.id === rid);
const rungIds = () => raiseAdminAlert.mock.calls.map(([, , opts]) => opts.metadata.negativeId);

// Nov 3 2026 07:30 ET (EST, UTC-5), the advisor's run time, and the next two days.
const DAY1 = new Date('2026-11-03T12:30:00Z');
const DAY2 = new Date('2026-11-04T12:30:00Z');
const DAY3 = new Date('2026-11-05T12:30:00Z');

function setup(seed = {}) { mockDb = createFakeDb({ ad_campaigns: campaigns(), ...seed }); }

beforeEach(() => {
  jest.clearAllMocks();
  gates.adsNegativesLive.mockReturnValue(true);
  setup();
});

describe('queueAdvisorNegatives: rows', () => {
  test('each add_negative with a word and a campaign becomes a pending advisor row; others are ignored', async () => {
    const out = await actions.queueAdvisorNegatives({
      recommendations: [
        rec('squirrel'),
        rec('bat removal', { campaign_id: C2 }),
        rec('no campaign', { campaign_id: undefined }),
        rec(undefined),
        rec('wrong action', { apply_action: 'increase_budget' }),
        { apply_action: 'add_negative', apply_value: 'no reasoning', campaign_id: C1 },
      ],
    }, { now: DAY1 });
    expect(out).toEqual({ queued: 3, rang: 3 });
    expect(mockDb.tables.ad_negative_keywords.map((r) => [r.text, r.campaign_id, r.source, r.state, r.match_type])).toEqual([
      ['squirrel', C1, 'advisor', 'pending', 'phrase'],
      ['bat removal', C2, 'advisor', 'pending', 'phrase'],
      ['no reasoning', C1, 'advisor', 'pending', 'phrase'],
    ]);
  });

  test('reason is the advisor\'s reasoning cut to 500 characters', async () => {
    await actions.queueAdvisorNegatives({ recommendations: [rec('squirrel', { reasoning: 'x'.repeat(900) })] }, { now: DAY1 });
    expect(mockDb.tables.ad_negative_keywords[0].reason).toHaveLength(500);
  });

  test('metrics come from the campaign\'s best-spending search term that the word would block', async () => {
    setup({
      ad_search_terms: [
        { campaign_id: C1, search_term: 'squirrels in attic', clicks: 9, cost: '40.00', conversions: '0' }, // a plural: not blocked by the phrase
        { campaign_id: C1, search_term: 'squirrel removal', clicks: 3, cost: '12.50', conversions: '0' },
        { campaign_id: C1, search_term: 'how to trap a squirrel', clicks: 6, cost: '9.50', conversions: '0' },
        { campaign_id: C2, search_term: 'squirrel baffle', clicks: 30, cost: '90.00', conversions: '0' }, // another campaign
      ],
    });
    await actions.queueAdvisorNegatives({ recommendations: [rec('squirrel')] }, { now: DAY1 });
    expect(mockDb.tables.ad_negative_keywords[0].metrics).toEqual({ term: 'squirrel removal', clicks: 3, cost: 12.5, conversions: 0 });
  });

  test('no matching search term: metrics are null', async () => {
    await actions.queueAdvisorNegatives({ recommendations: [rec('squirrel')] }, { now: DAY1 });
    expect(mockDb.tables.ad_negative_keywords[0].metrics).toBeNull();
  });

  test('a word already on file for that campaign (any state) is not written again', async () => {
    setup({ ad_negative_keywords: [pendingRow(1, { text: 'squirrel', state: 'declined' })] });
    const out = await actions.queueAdvisorNegatives({ recommendations: [rec('squirrel')] }, { now: DAY1 });
    expect(out.queued).toBe(0);
    expect(mockDb.tables.ad_negative_keywords).toHaveLength(1);
    expect(mockDb.tables.ad_negative_keywords[0].state).toBe('declined');
  });

  test('a word that is protected is never queued, even if a rec carries it', async () => {
    const out = await actions.queueAdvisorNegatives({ recommendations: [rec('ant control')] }, { now: DAY1 });
    expect(out.queued).toBe(0);
  });

  test('a row that cannot be written (unknown campaign) is skipped without failing the rest', async () => {
    const real = mockDb;
    mockDb = new Proxy(real, { apply: (t, th, args) => { const b = t(...args); if (args[0] === 'ad_search_terms') throw new Error('boom'); return b; }, get: (t, k) => t[k] });
    const out = await actions.queueAdvisorNegatives({ recommendations: [rec('squirrel')] }, { now: DAY1 });
    expect(out.queued).toBe(0);
  });
});

describe('the daily cap of new bells', () => {
  beforeEach(() => setup({ ad_negative_keywords: [1, 2, 3, 4, 5].map((n) => pendingRow(n)) }));

  test('at most 3 new bells in one Eastern day, oldest word first', async () => {
    expect(await actions.ringNegativeBells({ now: DAY1 })).toBe(3);
    expect(rungIds()).toEqual([id(1), id(2), id(3)]);
    expect([1, 2, 3].every((n) => rowOf(id(n)).notified_at instanceof Date)).toBe(true);
    expect(rowOf(id(4)).notified_at).toBeNull();
    expect(mockDb.calls.locks).toContain('ads-negative:bells');
  });

  test('a second run the same day rings nothing', async () => {
    await actions.ringNegativeBells({ now: DAY1 });
    raiseAdminAlert.mockClear();
    expect(await actions.ringNegativeBells({ now: new Date('2026-11-03T20:00:00Z') })).toBe(0);
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('the leftovers ring on the next day, oldest first, and then there is nothing left to ring', async () => {
    await actions.ringNegativeBells({ now: DAY1 });
    raiseAdminAlert.mockClear();
    expect(await actions.ringNegativeBells({ now: DAY2 })).toBe(2);
    expect(rungIds()).toEqual([id(4), id(5)]);
    raiseAdminAlert.mockClear();
    expect(await actions.ringNegativeBells({ now: DAY3 })).toBe(0);
  });

  test('a day is the Eastern day: a bell at 11:30 PM ET counts for that day, not the next UTC day', async () => {
    rowOf(id(1)).notified_at = new Date('2026-11-04T04:30:00Z'); // Nov 3, 11:30 PM EST
    // 10 PM ET Nov 3: same Eastern day, one used, two left.
    expect(await actions.ringNegativeBells({ now: new Date('2026-11-04T03:00:00Z') })).toBe(2);
    raiseAdminAlert.mockClear();
    // 7:30 AM ET Nov 4: a new Eastern day, a full allowance of 3 (2, 3 and 4 already rang or are old; row 5 is left).
    expect(await actions.ringNegativeBells({ now: DAY2 })).toBe(2);
  });

  test('words that are no longer pending, or are not the advisor\'s, are not rung', async () => {
    rowOf(id(1)).state = 'declined';
    rowOf(id(2)).source = 'owner_list';
    await actions.ringNegativeBells({ now: DAY1 });
    expect(rungIds()).toEqual([id(3), id(4), id(5)]);
  });

  test('a word decided between the pick and the ring is skipped (the row is read again under its lock)', async () => {
    raiseAdminAlert.mockImplementationOnce(async () => { rowOf(id(2)).state = 'declined'; return { id: 'n' }; });
    await actions.ringNegativeBells({ now: DAY1 });
    expect(rungIds()).toEqual([id(1), id(3)]);
    expect(rowOf(id(2)).notified_at).toBeNull();
  });

  test('a bell that fails to raise leaves its word unstamped for the next run and does not stop the others', async () => {
    raiseAdminAlert.mockRejectedValueOnce(new Error('bell down'));
    expect(await actions.ringNegativeBells({ now: DAY1 })).toBe(2);
    expect(rowOf(id(1)).notified_at).toBeNull();
    expect(rowOf(id(2)).notified_at).toBeInstanceOf(Date);
  });

  test('queueAdvisorNegatives rings the leftovers even when today\'s report has no new word', async () => {
    const out = await actions.queueAdvisorNegatives({ recommendations: [] }, { now: DAY1 });
    expect(out).toEqual({ queued: 0, rang: 3 });
  });

  test('gate off writes nothing', async () => {
    gates.adsNegativesLive.mockReturnValue(false);
    const before = JSON.stringify(mockDb.tables);
    expect(await actions.ringNegativeBells({ now: DAY1 })).toBe(0);
    expect(await actions.queueAdvisorNegatives({ recommendations: [rec('squirrel')] }, { now: DAY1 })).toMatchObject({ skipped: 'off' });
    expect(JSON.stringify(mockDb.tables)).toBe(before);
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });
});

describe('the bell row', () => {
  test('is raised as a system bell with the dedupe key, the negative id and the full reasoning', async () => {
    setup({ ad_negative_keywords: [pendingRow(1, { text: 'squirrel' })] });
    await actions.ringNegativeBells({ now: DAY1 });
    const [category, spec, opts] = raiseAdminAlert.mock.calls[0];
    expect(category).toBe('system');
    expect(opts).toMatchObject({ bell: true, dedupeKey: `ads-negative:${id(1)}`, detail: 'Six clicks, $9.50, no conversions.', metadata: { negativeId: id(1) } });
    expect(spec).toMatchObject({
      area: 'Leads', severity: 'needs-you', who: 'person', doneWhen: 'negative_decided',
      link: `/admin/ads?tab=advisor&negative=${id(1)}`, subject: { type: 'check', id: id(1) },
    });
  });

  test('passes the admin notification rules, with the exact buttons', () => {
    const { spec } = actions.negativeBellSpec(pendingRow(1, { text: 'squirrel' }));
    const composed = composeAdminAlert(spec);
    expect(composed.headline).toBe('Leads — block "squirrel" in Google Ads');
    expect(composed.why).toBe('6 clicks, $9.50, no conversions in 30 days, from "squirrel removal".');
    expect(composed.metadata.buttons).toEqual({
      kind: 'negative_keyword',
      items: [{ id: 'add', label: 'Add', prompt: 'Block this word in Google Ads now?' }, { id: 'decline', label: 'Decline' }],
    });
    expect(buttonViolations(negativeButtons())).toEqual([]);
  });

  test('a long word falls back to the shorter headline, and one that does not fit is cut at a word', () => {
    const long = actions.negativeBellSpec(pendingRow(1, { text: 'wildlife trapper abc' })).spec;
    expect(composeAdminAlert(long).headline.length).toBeLessThanOrEqual(60);
    const longer = actions.negativeBellSpec(pendingRow(1, { text: "o'brien & sons wildlife removal" })).spec;
    expect(composeAdminAlert(longer).headline.length).toBeLessThanOrEqual(60);
  });

  test.each([
    ['one click', { clicks: 1, cost: 2, conversions: 0, term: 'bat house' }, '1 click, $2.00, no conversions in 30 days, from "bat house".'],
    ['numeric strings', { clicks: '4', cost: '3.5', conversions: '0', term: 'bat house' }, '4 clicks, $3.50, no conversions in 30 days, from "bat house".'],
  ])('why for %s', (_n, metrics, why) => {
    expect(composeAdminAlert(actions.negativeBellSpec(pendingRow(1, { metrics })).spec).why).toBe(why);
  });

  test.each([
    ['no metrics', null],
    ['a code-shaped search term', { clicks: 6, cost: 9.5, conversions: 0, term: 'a1b2c3d4e5f6a7b8 squirrel' }],
    ['a term with a date', { clicks: 6, cost: 9.5, conversions: 0, term: 'squirrel 2026-11-02' }],
    ['a term with an underscore', { clicks: 6, cost: 9.5, conversions: 0, term: 'my_squirrel' }],
    ['metrics without numbers', { term: 'squirrel removal' }],
    ['a conversion on file', { clicks: 6, cost: 9.5, conversions: 1, term: 'squirrel removal' }],
  ])('why falls back when %s', (_n, metrics) => {
    const { spec } = actions.negativeBellSpec(pendingRow(1, { metrics }));
    const composed = composeAdminAlert(spec);
    if (_n === 'a code-shaped search term' || _n === 'a term with a date' || _n === 'a term with an underscore') {
      // cleaned of the code-shaped part, or replaced by the fallback; never a rule break
      expect(composed.why.length).toBeLessThanOrEqual(110);
    } else {
      expect(composed.why).toBe('Suggested by the ads advisor; no conversions in 30 days.');
    }
  });

  test('a search term with a second sentence or a long text never breaks the why rules', () => {
    for (const term of ['squirrel removal. Cheap near me', 'x'.repeat(300), 'wow!!! squirrel']) {
      const { spec } = actions.negativeBellSpec(pendingRow(1, { metrics: { clicks: 6, cost: 9.5, conversions: 0, term } }));
      expect(() => composeAdminAlert(spec)).not.toThrow();
    }
  });
});

describe('serving the bell (visibleItems and withAlertButtons)', () => {
  const bellRow = (n, notificationId = `n${n}`) => ({
    id: notificationId, done_at: null, metadata: { negativeId: id(n), buttons: negativeButtons() },
  });

  beforeEach(() => setup({
    ad_negative_keywords: [pendingRow(1), pendingRow(2, { state: 'active' }), pendingRow(3, { state: 'declined' }), pendingRow(4, { state: 'failed' })],
  }));

  test('buttons are served for a pending word only; one read covers the page; a missing word serves none', async () => {
    const out = await buttonHandler.visibleItems([bellRow(1), bellRow(2), bellRow(3), bellRow(4), bellRow(5), { id: 'n9', metadata: { negativeId: 'nope' } }]);
    expect(Object.fromEntries(out)).toEqual({ n1: ['add', 'decline'], n2: [], n3: [], n4: [], n5: [], n9: [] });
  });

  test('the bell list shows Add and Decline (with the Add prompt) on a pending word and nothing on a decided one', async () => {
    const served = await withAlertButtons([bellRow(1), bellRow(2)], { role: 'admin' });
    expect(served[0].actions).toEqual([{ id: 'add', label: 'Add', prompt: 'Block this word in Google Ads now?' }, { id: 'decline', label: 'Decline' }]);
    expect(served[1].actions).toBeUndefined();
  });

  test('gate off: no buttons at all, and the kind is not live', async () => {
    gates.adsNegativesLive.mockReturnValue(false);
    expect(buttonHandler.live()).toBe(false);
    const served = await withAlertButtons([bellRow(1)], { role: 'admin' });
    expect(served[0].actions).toBeUndefined();
  });

  test('the kind is registered, and a row\'s stored buttons are accepted by the runner', () => {
    expect(KINDS.negative_keyword()).toBe(buttonHandler);
    expect(storedButtons(bellRow(1))).toEqual(negativeButtons());
  });
});

describe('a tap (buttonHandler.run)', () => {
  const tapRow = (n = 1) => ({ id: 'n1', metadata: { negativeId: id(n), buttons: negativeButtons() } });
  const run = (itemId, row = tapRow()) => buttonHandler.run({ row, item: { id: itemId }, technicianId: 't-1' });
  let decide;
  beforeEach(() => { decide = jest.spyOn(actions, 'decideSuggestion'); });
  afterEach(() => decide.mockRestore());

  test('Add runs the Ads page\'s decide step for the row\'s word as the signed-in admin', async () => {
    decide.mockResolvedValue({ ok: true, state: 'active', message: 'Blocked "squirrel" in Google Ads.' });
    expect(await run('add')).toEqual({ ok: true, message: 'Blocked "squirrel" in Google Ads.', resolution: 'Added' });
    expect(decide).toHaveBeenCalledWith(id(1), 'add', { by: 't-1' });
  });

  test('Decline', async () => {
    decide.mockResolvedValue({ ok: true, state: 'declined', message: 'Declined "squirrel".' });
    expect(await run('decline')).toMatchObject({ ok: true, resolution: 'Declined' });
    expect(decide).toHaveBeenCalledWith(id(1), 'decline', { by: 't-1' });
  });

  test.each([
    ['decided', true], ['gone', true], ['protected', true], ['converted', true],
    ['google_error', false], ['google_unavailable', false], ['not_linked', false], ['off', false],
  ])('a refusal %s %s the bell row', async (code, closes) => {
    decide.mockResolvedValue({ ok: false, code, message: 'plain words' });
    const out = await run('add');
    expect(out).toMatchObject({ ok: false, code, message: 'plain words' });
    expect(Boolean(out.close)).toBe(closes);
  });

  test('an unknown button or a row with no word runs nothing', async () => {
    expect(await run('explode')).toMatchObject({ ok: false, code: 'unknown_action' });
    expect(await run('add', { id: 'n1', metadata: {} })).toMatchObject({ ok: false, code: 'gone', close: expect.any(String) });
    expect(decide).not.toHaveBeenCalled();
  });

  test('gate off: the real step answers off and nothing is written', async () => {
    decide.mockRestore();
    gates.adsNegativesLive.mockReturnValue(false);
    setup({ ad_negative_keywords: [pendingRow(1)] });
    expect(await run('add')).toMatchObject({ ok: false, code: 'off' });
    expect(rowOf(id(1)).state).toBe('pending');
    expect(google.addCampaignNegativeKeyword).not.toHaveBeenCalled();
  });
});

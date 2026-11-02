/**
 * Negative keywords, PR 1 of owner plan A (2026-11-02): the ads advisor reads
 * ad_negative_keywords as memory, never offers already-excluded search terms as
 * candidates, and an add_negative keeps its apply_value only when it is a valid
 * negative that is not protected, not already handled and not already excluded.
 * add_negative never becomes auto-applicable.
 */
process.env.ANTHROPIC_API_KEY = 'test-key';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/ops-digest', () => ({
  ...jest.requireActual('../services/ops-digest'),
  deliverOpsDigest: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../services/seo/search-console-v2', () => ({
  getPerformanceSummary: jest.fn().mockResolvedValue({ current: { clicks: 0 } }),
}));
jest.mock('../services/ads/google-ads', () => ({ isConfigured: () => false }));
jest.mock('../services/ads/budget-manager', () => ({
  getTechCountForArea: jest.fn().mockResolvedValue(1),
  getCapacityForArea: jest.fn().mockResolvedValue({ utilization: 0.4 }),
}));
const mockDispatch = jest.fn();
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...a) => mockDispatch(...a) }));

const mockCampaign = {
  id: '11111111-1111-4111-8111-111111111111', campaign_name: 'Synthetic Search', platform: 'google_ads',
  status: 'active', daily_budget_base: 5, daily_budget_current: 5, budget_mode: 'base', platform_campaign_id: '9000000001',
};
const mockOther = { ...mockCampaign, id: '22222222-2222-4222-8222-222222222222', campaign_name: 'Synthetic Other', platform_campaign_id: '9000000002' };
const term = (search_term, extra = {}) => ({
  search_term, campaign_id: mockCampaign.id, status: 'none', clicks: 6, cost: '9.50',
  conversions: '0', conversion_value: '0', roas: '0', ...extra,
});

let mockTerms = [];
let mockNegativeRows = [];
let mockNegativeError = null;
let mockCampaignRows = null;
jest.mock('../models/db', () => jest.fn((table) => {
  const rowsFor = () => {
    if (table === 'ad_negative_keywords') {
      if (mockNegativeError) return Promise.reject(mockNegativeError);
      return Promise.resolve(mockNegativeRows);
    }
    return Promise.resolve({
      ad_campaigns: mockCampaignRows || [mockCampaign, mockOther],
      ad_search_terms: mockTerms,
    }[table] || []);
  };
  const b = {
    where: () => b, orderBy: () => b, select: () => b, distinct: () => b, limit: () => b,
    first: () => Promise.resolve(table === 'system_settings'
      ? { key: 'ads.search_terms.last_synced_at', value: new Date(Date.now() - 3600 * 1000).toISOString() }
      : null),
    insert: () => Object.assign(Promise.resolve([1]), {
      onConflict: () => ({ ignore: () => ({ returning: () => Promise.resolve([{ date: 'x' }]) }) }),
    }),
    then: (r, j) => rowsFor().then(r, j),
  };
  return b;
}));

const advisor = require('../services/ads/campaign-advisor');

const REPORT = {
  overall_assessment: 'Small account; one junk term.', grade: 'B', waste_alerts: [], scaling_opportunities: [],
  capacity_warnings: [], seo_insights: [], insights: [], recommendations: [],
};
const negRec = (apply_value, extra = {}) => ({
  priority: 'medium', action: 'Add a negative', campaign: mockCampaign.campaign_name, campaign_id: mockCampaign.id,
  reasoning: '6 clicks, $9.50, 0 conversions', apply_action: 'add_negative', apply_value, ...extra,
});

beforeEach(() => {
  mockTerms = [];
  mockNegativeRows = [];
  mockNegativeError = null;
  mockCampaignRows = null;
  mockDispatch.mockReset();
});

async function promptFor(terms) {
  mockTerms = terms;
  mockDispatch.mockResolvedValue({ ok: true, json: { ...REPORT }, provider: 'anthropic', model: 'm' });
  await advisor.generateDailyAdvice();
  return mockDispatch.mock.calls[0][1].text;
}

describe('advisor prompt', () => {
  test('lists each term with its status', async () => {
    const text = await promptFor([term('squirrel removal', { status: 'none' }), term('rat poison', { status: 'added' })]);
    expect(text).toMatch(/"term": "squirrel removal"[\s\S]*?"status": "none"/);
    expect(text).toMatch(/"term": "rat poison"[\s\S]*?"status": "added"/);
  });

  test('excluded terms are not candidates; they are shown apart as already excluded', async () => {
    const text = await promptFor([
      term('squirrel removal'),
      term('free ants', { status: 'excluded' }),
      term('mice jobs', { status: 'added_excluded' }),
    ]);
    const [candidates, excluded] = text.split('ALREADY EXCLUDED IN GOOGLE');
    expect(candidates).toContain('squirrel removal');
    expect(candidates).not.toContain('free ants');
    expect(candidates).not.toContain('mice jobs');
    expect(excluded).toContain('free ants');
    expect(excluded).toContain('mice jobs');
    expect(excluded).toMatch(/NOT candidates/);
  });

  test('the handled block lists pending, active, declined and removed rows and leaves out failed', async () => {
    mockNegativeRows = [
      { campaign_id: mockCampaign.id, text: 'squirrel', match_type: 'phrase', state: 'active' },
      { campaign_id: mockCampaign.id, text: 'diy', match_type: 'phrase', state: 'declined' },
      { campaign_id: mockOther.id, text: 'jobs', match_type: 'phrase', state: 'pending' },
      { campaign_id: mockOther.id, text: 'salary', match_type: 'phrase', state: 'removed' },
      { campaign_id: mockOther.id, text: 'brokenword', match_type: 'phrase', state: 'failed' },
    ];
    const text = await promptFor([term('squirrel removal')]);
    const block = text.split('NEGATIVE KEYWORDS ALREADY HANDLED')[1].split('SERVICE-LINE ATTRIBUTION')[0];
    expect(block).toContain('"text":"squirrel","state":"active"');
    expect(block).toContain('"text":"diy","state":"declined"');
    expect(block).toContain('"text":"jobs","state":"pending"');
    expect(block).toContain('"text":"salary","state":"removed"');
    expect(block).toContain('Synthetic Other');
    expect(block).not.toContain('brokenword');
  });

  test('a failed table read says so and tells the model to recommend no negatives', async () => {
    mockNegativeError = Object.assign(new Error('relation "ad_negative_keywords" does not exist'), { code: '42P01' });
    const text = await promptFor([term('squirrel removal')]);
    expect(text).toMatch(/NEGATIVE KEYWORDS ALREADY HANDLED[\s\S]*UNAVAILABLE[\s\S]*Recommend NO add_negative/);
  });

  test('the system prompt states the rule and the apply_value contract', async () => {
    await promptFor([]);
    const system = mockDispatch.mock.calls[0][1].system;
    expect(system).toMatch(/NEVER recommend add_negative for a word or phrase listed under NEGATIVE KEYWORDS ALREADY HANDLED/);
    expect(system).toMatch(/waves/);
    expect(system).toMatch(/near me/);
    expect(system).toContain('termite');
    expect(system).toContain('north port');
    expect(system).toMatch(/cite that term's clicks, cost and conversions/);
    expect(system).toMatch(/add_negative \(the negative word or short phrase, 1-4 words\)/);
  });
});

describe('add_negative validation after the model answers', () => {
  const run = async (recs, { rows = [], terms = [], error = null } = {}) => {
    mockTerms = terms;
    mockNegativeRows = rows;
    mockNegativeError = error;
    mockDispatch.mockResolvedValue({ ok: true, json: { ...REPORT, recommendations: recs }, provider: 'anthropic', model: 'm' });
    const advice = await advisor.generateDailyAdvice();
    return advice.recommendations;
  };

  test('a valid negative keeps a normalized apply_value and stays manual advice', async () => {
    const [rec] = await run([negRec('  Squirrel ')], { terms: [term('squirrel removal')] });
    expect(rec.apply_value).toBe('squirrel');
    expect(rec.apply_action).toBe('add_negative');
    expect(rec.reasoning).toContain('6 clicks');
  });

  test.each([
    ['a service word', 'termite jobs'],
    ['the brand', 'Waves'],
    ['near me', 'plumber near me'],
    ['a city', 'sarasota'],
    ['too many words', 'one two three four five'],
    ['bad characters', '[squirrel]'],
    ['empty', '   '],
  ])('%s loses apply_value but the rec stays', async (_label, value) => {
    const [rec] = await run([negRec(value)]);
    expect(rec).toBeDefined();
    expect(rec.apply_value).toBeUndefined();
    expect(rec.apply_action).toBe('add_negative');
    expect(rec.action).toBe('Add a negative');
  });

  test.each([
    ['one word', 'orkin'],
    ['two words', 'home team'],
    ['inside a phrase', 'terminix prices'],
  ])('a competitor name (%s) loses apply_value: competitor blocks are the owner\'s call', async (_label, value) => {
    const [rec] = await run([negRec(value)]);
    expect(rec.apply_value).toBeUndefined();
    expect(rec.apply_action).toBe('add_negative');
  });

  test('the kept value is stamped with the resolved campaign id when only the name was given', async () => {
    const [rec] = await run([negRec('squirrel', { campaign_id: undefined })]);
    expect(rec.apply_value).toBe('squirrel');
    expect(rec.campaign_id).toBe(mockCampaign.id);
  });

  test.each([
    ['an unknown campaign', { campaign: 'No Such Campaign', campaign_id: undefined }],
    ['an id naming a different campaign', { campaign_id: mockOther.id }],
  ])('%s loses apply_value', async (_label, extra) => {
    mockCampaignRows = [mockCampaign, mockOther];
    const [rec] = await run([negRec('squirrel', extra)]);
    expect(rec.apply_value).toBeUndefined();
  });

  test.each([
    ['a campaign not linked to Google', { platform_campaign_id: null }],
    ['a campaign on another platform', { platform: 'meta' }],
  ])('%s loses apply_value: a negative runs only on a linked Google Ads campaign', async (_label, change) => {
    mockCampaignRows = [{ ...mockCampaign, ...change }];
    const [rec] = await run([negRec('squirrel')]);
    expect(rec.apply_value).toBeUndefined();
  });

  test('a non-string apply_value loses it', async () => {
    const [rec] = await run([negRec(12)]);
    expect(rec.apply_value).toBeUndefined();
  });

  test('a word already in the table in any state loses apply_value', async () => {
    for (const state of ['pending', 'active', 'declined', 'removed', 'failed']) {
      const [rec] = await run([negRec('squirrel')], { rows: [{ campaign_id: mockCampaign.id, text: 'Squirrel', match_type: 'phrase', state }] });
      expect(rec.apply_value).toBeUndefined();
    }
  });

  test('a word handled on another campaign is still new for this campaign', async () => {
    const [rec] = await run([negRec('squirrel')], { rows: [{ campaign_id: mockOther.id, text: 'squirrel', match_type: 'phrase', state: 'active' }] });
    expect(rec.apply_value).toBe('squirrel');
  });

  test('an excluded search term loses apply_value', async () => {
    const [rec] = await run([negRec('squirrel removal')], { terms: [term('Squirrel Removal', { status: 'excluded' })] });
    expect(rec.apply_value).toBeUndefined();
  });

  test('a term excluded in one campaign is still a candidate for another', async () => {
    const terms = [
      term('Squirrel Removal', { status: 'excluded', campaign_id: mockOther.id }),
      term('squirrel removal', { status: 'none' }),
    ];
    const [forThis, forOther] = await run([
      negRec('squirrel removal'),
      negRec('squirrel removal', { campaign: mockOther.campaign_name, campaign_id: mockOther.id }),
    ], { terms });
    expect(forThis.apply_value).toBe('squirrel removal');
    expect(forOther.apply_value).toBeUndefined();
  });

  test('a failed table read recommends no negatives that run', async () => {
    const [rec] = await run([negRec('squirrel')], { error: new Error('connection lost') });
    expect(rec.apply_value).toBeUndefined();
    expect(rec.apply_action).toBe('add_negative');
  });

  test('without a negatives context (an old caller) no add_negative keeps a value', () => {
    const out = advisor.normalizeRecommendations({ recommendations: [negRec('squirrel')] }, [mockCampaign]);
    expect(out.recommendations[0].apply_value).toBeUndefined();
  });

  test('budget recs are untouched by the negative handling', async () => {
    // Unlinked: the test has no Google client, and a linked campaign's budget rec needs one.
    mockCampaignRows = [{ ...mockCampaign, platform_campaign_id: null }];
    const [rec] = await run([{
      priority: 'high', action: 'Raise the daily budget', campaign: mockCampaign.campaign_name, campaign_id: mockCampaign.id,
      reasoning: 'x', apply_action: 'increase_budget', apply_value: 8,
    }]);
    expect(rec.apply_action).toBe('increase_budget');
    expect(rec.apply_value).toBe(8);
  });
});

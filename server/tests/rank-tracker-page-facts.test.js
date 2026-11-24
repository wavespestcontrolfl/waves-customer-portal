// The rank tracker stores what each result page held (serp_features.page): counts and public result
// domains. From 2026-11-06 no check found Waves or a tracked rival and the stored row could not say why.

const mockInserted = [];
const mockChain = {
  where: jest.fn(() => mockChain),
  orderBy: jest.fn(() => mockChain),
  first: jest.fn(async () => null),
  insert: jest.fn((row) => { mockInserted.push(row); return mockChain; }),
  onConflict: jest.fn(() => mockChain),
  merge: jest.fn(async () => 1),
};
jest.mock('../models/db', () => jest.fn(() => mockChain));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/seo/dataforseo', () => ({ configured: true, serpOrganic: jest.fn() }));

const dataforseo = require('../services/seo/dataforseo');
const tracker = require('../services/seo/rank-tracker');

const { pageFacts } = tracker._private;
const page = (items) => ({ tasks: [{ result: [{ items }] }] });
const keyword = { id: 'kw-1', keyword: 'pest control example town', primary_city: 'Bradenton' };

beforeEach(() => {
  mockInserted.length = 0;
  jest.clearAllMocks();
  mockChain.first.mockResolvedValue(null);
});

describe('pageFacts', () => {
  test('counts item types, organic results and repaired results, and keeps the first five domains', () => {
    const items = [
      { type: 'people_also_ask' },
      { type: 'organic', domain: 'WWW.Example-One.com', url: 'https://WWW.Example-One.com/pest', rank_absolute: 2, checks: ['from_web'] },
      { type: 'organic', domain: 'google.com', url: 'https://www.google.com/url?q=https://example-two.com/a&sa=U', rank_absolute: 3 },
      { type: 'local_pack' },
      { type: 'local_pack' },
      { type: 'organic', domain: 'example-three.com', rank_absolute: 6, checks: { from_web: true } },
      { type: 'organic', domain: 'example-four.com', rank_absolute: 7, checks: { from_web: false } },
      { type: 'organic', domain: 'example-five.com', rank_absolute: 8, checks: ['other_check'] },
      { type: 'organic', domain: 'example-six.com', rank_absolute: 9, checks: 'from_web' },
    ];
    expect(pageFacts(items)).toEqual({
      items: 9,
      types: { people_also_ask: 1, organic: 6, local_pack: 2 },
      organic: 6,
      repaired: 2,
      top_domains: ['www.example-one.com', 'google.com', 'example-three.com', 'example-four.com', 'example-five.com'],
      top_hosts: ['www.example-one.com', 'www.google.com>example-two.com', '', '', ''],
    });
  });

  test('the result host reads the URL, follows a Google redirect link to its target, and never throws', () => {
    const { resultHost } = tracker._private;
    expect(resultHost('https://Example-Rival.com/pests')).toBe('example-rival.com');
    expect(resultHost('https://www.google.com/url?url=https://www.example-site.com/x')).toBe('www.google.com>www.example-site.com');
    expect(resultHost('https://www.google.com/search?q=pest+control')).toBe('www.google.com');
    expect(resultHost('https://www.google.com/search?q=https://example-site.com')).toBe('www.google.com');
    expect(resultHost('https://google.example-site.com/url?q=https://other-site.com')).toBe('google.example-site.com');
    expect(resultHost('https://www.google.co.uk/url?q=https://example-site.com')).toBe('www.google.co.uk>example-site.com');
    expect(resultHost('not a url')).toBe('');
    expect(resultHost(undefined)).toBe('');
  });

  test('a page with no organic result, a missing list and a broken item all give counts, never a throw', () => {
    expect(pageFacts([{ type: 'ai_overview' }, { type: 'people_also_ask' }])).toEqual({
      items: 2, types: { ai_overview: 1, people_also_ask: 1 }, organic: 0, repaired: 0, top_domains: [], top_hosts: [],
    });
    expect(pageFacts(undefined)).toEqual({ items: 0, types: {}, organic: 0, repaired: 0, top_domains: [], top_hosts: [] });
    expect(pageFacts([null, {}, { type: 'organic' }])).toEqual({
      items: 2, types: { unknown: 1, organic: 1 }, organic: 1, repaired: 0, top_domains: [''], top_hosts: [''],
    });
  });
});

describe('checkKeyword', () => {
  test('stores the page facts beside the features, and still finds Waves and a tracked rival', async () => {
    dataforseo.serpOrganic.mockResolvedValue(page([
      { type: 'people_also_ask' },
      { type: 'organic', domain: 'www.orkin.com', rank_absolute: 2 },
      { type: 'organic', domain: 'www.wavespestcontrol.com', rank_absolute: 4, checks: ['from_web'] },
    ]));

    const result = await tracker.checkKeyword(keyword, '2026-11-22');

    expect(result.organicPosition).toBe(4);
    expect(mockInserted).toHaveLength(1);
    expect(mockInserted[0].organic_position).toBe(4);
    expect(JSON.parse(mockInserted[0].competitor_positions)).toEqual([{ domain: 'orkin.com', position: 2 }]);
    const features = JSON.parse(mockInserted[0].serp_features);
    expect(features.paa).toBe(true);
    expect(features.page).toEqual({
      items: 3,
      types: { people_also_ask: 1, organic: 2 },
      organic: 2,
      repaired: 1,
      top_domains: ['www.orkin.com', 'www.wavespestcontrol.com'],
      top_hosts: ['', ''],
    });
  });

  test('a page of unrelated results stores no position and names what it held', async () => {
    dataforseo.serpOrganic.mockResolvedValue(page([
      { type: 'organic', domain: 'unrelated-example.net', rank_absolute: 1 },
      { type: 'organic', domain: 'another-example.org', rank_absolute: 2 },
    ]));

    await tracker.checkKeyword(keyword, '2026-11-22');

    expect(mockInserted[0].organic_position).toBeNull();
    expect(JSON.parse(mockInserted[0].competitor_positions)).toEqual([]);
    expect(JSON.parse(mockInserted[0].serp_features).page).toEqual({
      items: 2, types: { organic: 2 }, organic: 2, repaired: 0, top_domains: ['unrelated-example.net', 'another-example.org'], top_hosts: ['', ''],
    });
  });

  test('no result from DataForSEO stores an empty features object, as before', async () => {
    dataforseo.serpOrganic.mockResolvedValue(null);

    await tracker.checkKeyword(keyword, '2026-11-22');

    expect(mockInserted[0].organic_position).toBeNull();
    expect(JSON.parse(mockInserted[0].serp_features)).toEqual({});
  });
});

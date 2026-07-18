/**
 * Google Ads ops tools — unit tests with a mocked google-ads client.
 * Read-only contract: benign dark state, live serving/status mapping,
 * disapproval mapping with capped policy topics, failures as { error }.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockQuery = jest.fn();
let mockConfigured = false;
jest.mock('../services/ads/google-ads', () => ({
  isConfigured: () => mockConfigured,
  getCustomer: () => ({ query: (...args) => mockQuery(...args) }),
}));

const { executeGoogleAdsOpsTool } = require('../services/intelligence-bar/google-ads-ops-tools');

describe('intelligence bar Google Ads ops tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfigured = false;
  });

  test('unconfigured state is benign — no error field and no query', async () => {
    const result = await executeGoogleAdsOpsTool('get_google_ads_serving_status', {});
    expect(result.error).toBeUndefined();
    expect(result.configured).toBe(false);
    expect(result.message).toMatch(/GOOGLE_ADS_DEVELOPER_TOKEN/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('unknown tool name returns an error result', async () => {
    mockConfigured = true;
    const result = await executeGoogleAdsOpsTool('pause_campaign', {});
    expect(result.error).toMatch(/Unknown tool/);
  });

  test('serving status maps primary status, reasons, and dollar budget', async () => {
    mockConfigured = true;
    mockQuery.mockResolvedValueOnce([
      {
        campaign: {
          id: 111, name: 'Pest Bradenton', status: 'ENABLED',
          primary_status: 'LIMITED', primary_status_reasons: ['CAMPAIGN_BUDGET_LIMITED'],
        },
        campaign_budget: { amount_micros: 45_000_000 },
      },
      {
        campaign: { id: 222, name: 'Lawn Venice', status: 'PAUSED' },
        campaign_budget: {},
      },
    ]);

    const result = await executeGoogleAdsOpsTool('get_google_ads_serving_status', {});
    expect(result.error).toBeUndefined();
    expect(result.campaigns).toEqual([
      {
        id: '111', name: 'Pest Bradenton', status: 'ENABLED',
        primary_status: 'LIMITED', primary_status_reasons: ['CAMPAIGN_BUDGET_LIMITED'],
        daily_budget: 45,
      },
      {
        id: '222', name: 'Lawn Venice', status: 'PAUSED',
        primary_status: null, primary_status_reasons: [],
        daily_budget: null,
      },
    ]);
    expect(result.total).toBe(2);
    expect(String(mockQuery.mock.calls[0][0])).toContain('primary_status');
  });

  test('disapprovals map policy topics and cap the per-ad topic list', async () => {
    mockConfigured = true;
    const manyTopics = Array.from({ length: 15 }, (_, i) => ({ topic: `topic_${i}`, type: 'PROHIBITED' }));
    mockQuery.mockResolvedValueOnce([
      {
        campaign: { name: 'Pest Bradenton' },
        ad_group: { name: 'Ants' },
        ad_group_ad: {
          ad: { id: 999 },
          status: 'ENABLED',
          policy_summary: { approval_status: 'DISAPPROVED', policy_topic_entries: manyTopics },
        },
      },
    ]);

    const result = await executeGoogleAdsOpsTool('get_google_ads_disapprovals', {});
    expect(result.error).toBeUndefined();
    expect(result.ads).toHaveLength(1);
    expect(result.ads[0].approval_status).toBe('DISAPPROVED');
    expect(result.ads[0].policy_topics).toHaveLength(10);
    expect(result.ads[0].policy_topics[0]).toEqual({ topic: 'topic_0', type: 'PROHIBITED' });
    expect(result.total).toBe(1);
    expect(result.truncated).toBe(false);
  });

  test('query failure surfaces as { error }, never a throw', async () => {
    mockConfigured = true;
    mockQuery.mockRejectedValueOnce(new Error('DEVELOPER_TOKEN_NOT_APPROVED'));
    const result = await executeGoogleAdsOpsTool('get_google_ads_serving_status', {});
    expect(result.error).toMatch(/DEVELOPER_TOKEN_NOT_APPROVED/);
  });
});

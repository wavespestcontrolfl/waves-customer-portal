/**
 * Meta Ads ops tools — unit tests with a mocked meta-ads Graph client.
 * Read-only contract: benign dark state, delivery mapping (cent-string
 * budgets → dollars), issue truncation, failures as { error }.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockGraphGet = jest.fn();
let mockConfigured = false;
jest.mock('../services/ads/meta-ads', () => ({
  isConfigured: () => mockConfigured,
  graphGet: (...args) => mockGraphGet(...args),
}));

const { executeMetaAdsOpsTool } = require('../services/intelligence-bar/meta-ads-ops-tools');

describe('intelligence bar Meta Ads ops tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfigured = false;
  });

  test('unconfigured state is benign — no error field and no Graph call', async () => {
    const result = await executeMetaAdsOpsTool('get_meta_ads_delivery_status', {});
    expect(result.error).toBeUndefined();
    expect(result.configured).toBe(false);
    expect(result.message).toMatch(/META_ADS_ACCESS_TOKEN/);
    expect(mockGraphGet).not.toHaveBeenCalled();
  });

  test('unknown tool name returns an error result', async () => {
    mockConfigured = true;
    const result = await executeMetaAdsOpsTool('pause_meta_campaign', {});
    expect(result.error).toMatch(/Unknown tool/);
  });

  test('delivery status maps effective_status and cent-string budgets to dollars', async () => {
    mockConfigured = true;
    mockGraphGet.mockResolvedValueOnce([
      { id: '1', name: 'Pest FB', status: 'ACTIVE', effective_status: 'WITH_ISSUES', daily_budget: '4500' },
      { id: '2', name: 'Lawn IG', status: 'PAUSED', effective_status: 'PAUSED' },
    ]);

    const result = await executeMetaAdsOpsTool('get_meta_ads_delivery_status', {});
    expect(result.error).toBeUndefined();
    expect(result.campaigns).toEqual([
      { id: '1', name: 'Pest FB', status: 'ACTIVE', effective_status: 'WITH_ISSUES', daily_budget: 45 },
      { id: '2', name: 'Lawn IG', status: 'PAUSED', effective_status: 'PAUSED', daily_budget: null },
    ]);
    expect(mockGraphGet).toHaveBeenCalledWith('campaigns', expect.objectContaining({
      fields: expect.stringContaining('effective_status'),
    }));
  });

  test('issues map error summaries with truncation and filter serverside on effective_status', async () => {
    mockConfigured = true;
    const longMessage = 'm'.repeat(500);
    mockGraphGet.mockResolvedValueOnce([
      {
        id: '9', name: 'Bad ad', campaign: { name: 'Pest FB' }, effective_status: 'DISAPPROVED',
        issues_info: [{ level: 'AD', error_summary: 'Policy violation', error_message: longMessage }],
      },
    ]);

    const result = await executeMetaAdsOpsTool('get_meta_ads_issues', {});
    expect(result.error).toBeUndefined();
    expect(result.ads[0].campaign).toBe('Pest FB');
    expect(result.ads[0].issues[0].summary).toBe('Policy violation');
    expect(result.ads[0].issues[0].message).toHaveLength(200);
    const [, opts] = mockGraphGet.mock.calls[0];
    expect(JSON.stringify(opts.params.filtering)).toContain('WITH_ISSUES');
  });

  test('Graph failure surfaces as { error }, never a throw', async () => {
    mockConfigured = true;
    mockGraphGet.mockRejectedValueOnce(new Error('Meta API campaigns: (#190) token expired'));
    const result = await executeMetaAdsOpsTool('get_meta_ads_delivery_status', {});
    expect(result.error).toMatch(/token expired/);
  });
});

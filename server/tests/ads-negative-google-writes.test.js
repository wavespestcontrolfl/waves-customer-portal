/**
 * Google Ads negative keyword functions (owner plan A, 2026-11-02, PR 2): add a phrase negative to a campaign, take
 * one out, and read the search terms that converted. The Customer is a stub, but the library, its enums and its
 * response and failure messages are the REAL google-ads-api (v23), so the resource-name path read from a response and
 * the error codes matched on a failure are the library's own shapes.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const mockCustomer = { query: jest.fn(), mutateResources: jest.fn() };
jest.mock('google-ads-api', () => {
  const actual = jest.requireActual('google-ads-api');
  return { ...actual, GoogleAdsApi: jest.fn(() => ({ Customer: () => mockCustomer })) };
});

const { services, errors } = require('google-ads-api');
const logger = require('../services/logger');
const GoogleAds = require('../services/ads/google-ads');

const RESOURCE = 'customers/1234567890/campaignCriteria/9000000001~555666777';
const mutateResponse = (resourceName = RESOURCE) => services.MutateGoogleAdsResponse.fromObject({
  mutate_operation_responses: [{ campaign_criterion_result: { resource_name: resourceName } }],
});
// A failure as the library throws it: GoogleAdsFailure with the enum NUMBER in error_code.
const failure = (errorCode, message = 'Google said no') => errors.GoogleAdsFailure.fromObject({ errors: [{ error_code: errorCode, message }] });

const env = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  process.env.GOOGLE_ADS_CLIENT_ID = 'id';
  process.env.GOOGLE_ADS_CLIENT_SECRET = 'secret';
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'dev';
  process.env.GOOGLE_ADS_REFRESH_TOKEN = 'refresh';
  process.env.GOOGLE_ADS_CUSTOMER_ID = '1234567890';
});
afterAll(() => { process.env = env; });

describe('addCampaignNegativeKeyword', () => {
  test('creates a negative phrase criterion on the campaign and returns the resource name Google answered with', async () => {
    mockCustomer.mutateResources.mockResolvedValue(mutateResponse());
    const out = await GoogleAds.addCampaignNegativeKeyword('9000000001', 'squirrel');
    expect(out).toEqual({ success: true, resourceName: RESOURCE });
    expect(mockCustomer.mutateResources).toHaveBeenCalledWith([{
      entity: 'campaign_criterion',
      operation: 'create',
      resource: {
        campaign: 'customers/1234567890/campaigns/9000000001',
        negative: true,
        keyword: { text: 'squirrel', match_type: 3 },
      },
    }]);
  });

  test('the match type is the library\'s PHRASE value', () => {
    const { enums } = require('google-ads-api');
    expect(enums.KeywordMatchType.PHRASE).toBe(3);
  });

  test('an answer without a resource name is a failure, not a success with nothing to undo', async () => {
    mockCustomer.mutateResources.mockResolvedValue(services.MutateGoogleAdsResponse.fromObject({ mutate_operation_responses: [] }));
    expect(await GoogleAds.addCampaignNegativeKeyword('9000000001', 'squirrel')).toBeNull();
  });

  test('"already exists" looks the negative up and returns its resource name', async () => {
    mockCustomer.mutateResources.mockRejectedValue(failure({ mutate_error: errors.MutateErrorEnum.MutateError.RESOURCE_ALREADY_EXISTS }));
    mockCustomer.query.mockResolvedValue([{ campaign_criterion: { resource_name: RESOURCE } }]);
    const out = await GoogleAds.addCampaignNegativeKeyword('9000000001', "bob's snake");
    expect(out).toEqual({ success: true, resourceName: RESOURCE, existed: true });
    const gaql = mockCustomer.query.mock.calls[0][0];
    expect(gaql).toContain('FROM campaign_criterion');
    expect(gaql).toContain('campaign.id = 9000000001');
    expect(gaql).toContain('campaign_criterion.negative = TRUE');
    expect(gaql).toContain("campaign_criterion.keyword.text = 'bob\\'s snake'");
    expect(gaql).toContain("campaign_criterion.keyword.match_type = 'PHRASE'");
    expect(gaql).toContain("campaign_criterion.status != 'REMOVED'");
  });

  test('"already exists" with nothing found by the lookup is a failure', async () => {
    mockCustomer.mutateResources.mockRejectedValue(failure({ mutate_error: errors.MutateErrorEnum.MutateError.RESOURCE_ALREADY_EXISTS }));
    mockCustomer.query.mockResolvedValue([]);
    expect(await GoogleAds.addCampaignNegativeKeyword('9000000001', 'squirrel')).toBeNull();
  });

  test('any other refusal: the lookup finds no block, so it returns null and logs', async () => {
    mockCustomer.mutateResources.mockRejectedValue(failure({ campaign_criterion_error: errors.CampaignCriterionErrorEnum.CampaignCriterionError.CANNOT_EXCLUDE_CRITERIA_TYPE }));
    mockCustomer.query.mockResolvedValue([]);
    expect(await GoogleAds.addCampaignNegativeKeyword('9000000001', 'squirrel')).toBeNull();
    expect(logger.error).toHaveBeenCalled();
  });

  test('a refusal under any code is taken as done when the block is already on the campaign', async () => {
    mockCustomer.mutateResources.mockRejectedValue(failure({ campaign_criterion_error: errors.CampaignCriterionErrorEnum.CampaignCriterionError.CANNOT_EXCLUDE_CRITERIA_TYPE }));
    mockCustomer.query.mockResolvedValue([{ campaign_criterion: { resource_name: RESOURCE } }]);
    expect(await GoogleAds.addCampaignNegativeKeyword('9000000001', 'squirrel')).toEqual({ success: true, resourceName: RESOURCE, existed: true });
  });

  test('a refusal whose lookup also fails is a failure', async () => {
    mockCustomer.mutateResources.mockRejectedValue(new Error('UNAVAILABLE'));
    mockCustomer.query.mockRejectedValue(new Error('UNAVAILABLE'));
    expect(await GoogleAds.addCampaignNegativeKeyword('9000000001', 'squirrel')).toBeNull();
  });

  test('a campaign id that is not a number is never put in the lookup query', async () => {
    mockCustomer.mutateResources.mockRejectedValue(new Error('The resource already exists'));
    expect(await GoogleAds.addCampaignNegativeKeyword('9; DROP', 'squirrel')).toBeNull();
    expect(mockCustomer.query).not.toHaveBeenCalled();
  });

  test('Google not configured: every function answers null and makes no call', async () => {
    delete process.env.GOOGLE_ADS_CLIENT_ID;
    // The customer handle is cached after the first configured call; a fresh module sees the env.
    let fresh;
    jest.isolateModules(() => { fresh = require('../services/ads/google-ads'); });
    expect(await fresh.addCampaignNegativeKeyword('9000000001', 'squirrel')).toBeNull();
    expect(await fresh.removeCampaignNegativeKeyword(RESOURCE)).toBeNull();
    expect(await fresh.convertingSearchTerms()).toBeNull();
    expect(mockCustomer.mutateResources).not.toHaveBeenCalled();
    expect(mockCustomer.query).not.toHaveBeenCalled();
  });
});

describe('removeCampaignNegativeKeyword', () => {
  test('removes the criterion by its resource name', async () => {
    mockCustomer.mutateResources.mockResolvedValue(mutateResponse());
    expect(await GoogleAds.removeCampaignNegativeKeyword(RESOURCE)).toEqual({ success: true, resourceName: RESOURCE });
    expect(mockCustomer.mutateResources).toHaveBeenCalledWith([
      { entity: 'campaign_criterion', operation: 'remove', resource: RESOURCE },
    ]);
  });

  test('a refused remove counts as removed when Google no longer has the criterion', async () => {
    mockCustomer.mutateResources.mockRejectedValue(failure({ mutate_error: errors.MutateErrorEnum.MutateError.RESOURCE_NOT_FOUND }));
    mockCustomer.query.mockResolvedValue([]);
    expect(await GoogleAds.removeCampaignNegativeKeyword(RESOURCE)).toEqual({ success: true, resourceName: RESOURCE, alreadyGone: true });
    const gaql = mockCustomer.query.mock.calls[0][0];
    expect(gaql).toContain(`campaign_criterion.resource_name = '${RESOURCE}'`);
    expect(gaql).toContain("campaign_criterion.status != 'REMOVED'");
  });

  test('a refused remove whose criterion is still there returns null', async () => {
    mockCustomer.mutateResources.mockRejectedValue(new Error('PERMISSION_DENIED'));
    mockCustomer.query.mockResolvedValue([{ campaign_criterion: { resource_name: RESOURCE } }]);
    expect(await GoogleAds.removeCampaignNegativeKeyword(RESOURCE)).toBeNull();
  });

  test('a refused remove whose check also fails is a failure, never read as removed', async () => {
    mockCustomer.mutateResources.mockRejectedValue(new Error('UNAVAILABLE'));
    mockCustomer.query.mockRejectedValue(new Error('UNAVAILABLE'));
    expect(await GoogleAds.removeCampaignNegativeKeyword(RESOURCE)).toBeNull();
  });

  test('no resource name, no call', async () => {
    expect(await GoogleAds.removeCampaignNegativeKeyword('')).toBeNull();
    expect(await GoogleAds.removeCampaignNegativeKeyword(null)).toBeNull();
    expect(mockCustomer.mutateResources).not.toHaveBeenCalled();
  });
});

describe('convertingSearchTerms', () => {
  test('reads search terms with conversions over the trailing window, all campaigns', async () => {
    mockCustomer.query.mockResolvedValue([
      { campaign: { id: 9000000001 }, search_term_view: { search_term: 'ant control venice' }, metrics: { conversions: 2 } },
      { campaign: { id: 9000000002 }, search_term_view: { search_term: 'pest help' }, metrics: { conversions: 0.5 } },
    ]);
    const out = await GoogleAds.convertingSearchTerms();
    expect(out).toEqual([
      { term: 'ant control venice', campaignId: '9000000001', conversions: 2 },
      { term: 'pest help', campaignId: '9000000002', conversions: 0.5 },
    ]);
    const gaql = mockCustomer.query.mock.calls[0][0];
    expect(gaql).toContain('FROM search_term_view');
    expect(gaql).toMatch(/segments\.date BETWEEN '\d{4}-\d{2}-\d{2}' AND '\d{4}-\d{2}-\d{2}'/);
    expect(gaql).toContain('metrics.conversions > 0');
    expect(gaql).not.toMatch(/campaign\.(id|status) *(=|!=)/);
  });

  test('the window is the days asked for (default 90)', async () => {
    mockCustomer.query.mockResolvedValue([]);
    await GoogleAds.convertingSearchTerms();
    const [, since, until] = mockCustomer.query.mock.calls[0][0].match(/BETWEEN '(\S+)' AND '(\S+)'/);
    expect(Math.round((new Date(until) - new Date(since)) / 86400000)).toBe(90);
  });

  test('no converting terms is an empty list, not null', async () => {
    mockCustomer.query.mockResolvedValue([]);
    expect(await GoogleAds.convertingSearchTerms()).toEqual([]);
  });

  test('any failure is null, so "no answer" is never read as "no conversions"', async () => {
    mockCustomer.query.mockRejectedValue(new Error('quota'));
    expect(await GoogleAds.convertingSearchTerms()).toBeNull();
  });
});

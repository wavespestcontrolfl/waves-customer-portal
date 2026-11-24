/**
 * Google Ads read functions of the route fill record (services/ads/route-fill.js): read where a campaign shows, and
 * find the Google id of a ZIP code. Neither writes: the stub Customer below has no mutate function, so a write would
 * throw. The library and its enums are the REAL google-ads-api, as in ads-negative-google-writes.test.js.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const mockCustomer = { query: jest.fn() };
jest.mock('google-ads-api', () => {
  const actual = jest.requireActual('google-ads-api');
  return { ...actual, GoogleAdsApi: jest.fn(() => ({ Customer: () => mockCustomer })) };
});

const { enums } = require('google-ads-api');
const logger = require('../services/logger');
const GoogleAds = require('../services/ads/google-ads');

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

const oneLine = (text) => text.replace(/\s+/g, ' ').trim();

describe('readCampaignGeoTargets', () => {
  const SEARCH = enums.AdvertisingChannelType.SEARCH;
  const campaignRow = (option, channel = SEARCH) => [{
    campaign: { id: 9000000001, advertising_channel_type: channel, geo_target_type_setting: { positive_geo_target_type: option } },
  }];
  const criterion = (id, type, geo) => ({ campaign_criterion: { resource_name: `customers/1234567890/campaignCriteria/9000000001~${id}`, type, location: geo ? { geo_target_constant: `geoTargetConstants/${geo}` } : null } });

  test('reads the channel, the location option and every positive place, radius and location group of the campaign', async () => {
    mockCustomer.query
      .mockResolvedValueOnce(campaignRow(enums.PositiveGeoTargetType.PRESENCE))
      .mockResolvedValueOnce([
        criterion(9012001, enums.CriterionType.LOCATION, 9012001),
        criterion(555, enums.CriterionType.PROXIMITY),
        criterion(777, enums.CriterionType.LOCATION_GROUP),
      ]);
    const out = await GoogleAds.readCampaignGeoTargets('9000000001');
    expect(out).toEqual({
      search: true,
      presenceOnly: true,
      targets: [
        { resourceName: 'customers/1234567890/campaignCriteria/9000000001~9012001', type: 'LOCATION', geoId: '9012001' },
        { resourceName: 'customers/1234567890/campaignCriteria/9000000001~555', type: 'PROXIMITY', geoId: null },
        { resourceName: 'customers/1234567890/campaignCriteria/9000000001~777', type: 'LOCATION_GROUP', geoId: null },
      ],
    });
    expect(oneLine(mockCustomer.query.mock.calls[0][0])).toBe(
      'SELECT campaign.id, campaign.advertising_channel_type, campaign.geo_target_type_setting.positive_geo_target_type FROM campaign WHERE campaign.id = 9000000001',
    );
    expect(oneLine(mockCustomer.query.mock.calls[1][0])).toBe(
      'SELECT campaign.id, campaign_criterion.resource_name, campaign_criterion.type, campaign_criterion.location.geo_target_constant FROM campaign_criterion '
      + "WHERE campaign.id = 9000000001 AND campaign_criterion.type IN ('LOCATION', 'PROXIMITY', 'LOCATION_GROUP') AND campaign_criterion.negative = FALSE AND campaign_criterion.status != 'REMOVED'",
    );
  });

  test.each([
    ['PRESENCE_OR_INTEREST (Google\'s default)', enums.PositiveGeoTargetType.PRESENCE_OR_INTEREST],
    ['SEARCH_INTEREST', enums.PositiveGeoTargetType.SEARCH_INTEREST],
    ['a missing option', undefined],
  ])('%s is not presence only', async (_name, option) => {
    mockCustomer.query.mockResolvedValueOnce(campaignRow(option)).mockResolvedValueOnce([]);
    expect(await GoogleAds.readCampaignGeoTargets('9000000001')).toEqual({ search: true, presenceOnly: false, targets: [] });
  });

  test.each([
    ['PERFORMANCE_MAX', enums.AdvertisingChannelType.PERFORMANCE_MAX],
    ['DISPLAY', enums.AdvertisingChannelType.DISPLAY],
    ['a missing channel', null],
  ])('%s is not a Search campaign, whatever the local row says', async (_name, channel) => {
    mockCustomer.query.mockResolvedValueOnce(campaignRow(enums.PositiveGeoTargetType.PRESENCE, channel)).mockResolvedValueOnce([]);
    expect(await GoogleAds.readCampaignGeoTargets('9000000001')).toEqual({ search: false, presenceOnly: true, targets: [] });
  });

  test('the library\'s enum values are the ones this code compares with', () => {
    expect(enums.PositiveGeoTargetType.PRESENCE).toBe(7);
    expect(enums.AdvertisingChannelType.SEARCH).toBe(2);
    expect([enums.CriterionType[7], enums.CriterionType[17], enums.CriterionType[31]]).toEqual(['LOCATION', 'PROXIMITY', 'LOCATION_GROUP']);
  });

  test('no targets is an empty list, not a failure', async () => {
    mockCustomer.query.mockResolvedValueOnce(campaignRow(enums.PositiveGeoTargetType.PRESENCE)).mockResolvedValueOnce([]);
    expect(await GoogleAds.readCampaignGeoTargets('9000000001')).toEqual({ search: true, presenceOnly: true, targets: [] });
  });

  test.each([
    ['no location id', null],
    ['a location id that is not digits', 'geoTargetConstants/abc'],
  ])('a place with %s makes the whole read null: it could not be compared with a wanted ZIP', async (_name, constant) => {
    mockCustomer.query
      .mockResolvedValueOnce(campaignRow(enums.PositiveGeoTargetType.PRESENCE))
      .mockResolvedValueOnce([
        criterion(9012001, enums.CriterionType.LOCATION, 9012001),
        { campaign_criterion: { resource_name: 'customers/1234567890/campaignCriteria/9000000001~9012002', type: enums.CriterionType.LOCATION, location: constant ? { geo_target_constant: constant } : null } },
      ]);
    expect(await GoogleAds.readCampaignGeoTargets('9000000001')).toBeNull();
  });

  test('an unknown campaign, a target with no resource name, and a failed read are all null', async () => {
    mockCustomer.query.mockResolvedValueOnce([]);
    expect(await GoogleAds.readCampaignGeoTargets('9000000001')).toBeNull();

    mockCustomer.query.mockResolvedValueOnce(campaignRow(enums.PositiveGeoTargetType.PRESENCE)).mockResolvedValueOnce([{ campaign_criterion: { type: enums.CriterionType.PROXIMITY } }]);
    expect(await GoogleAds.readCampaignGeoTargets('9000000001')).toBeNull();

    mockCustomer.query.mockRejectedValueOnce(new Error('quota'));
    expect(await GoogleAds.readCampaignGeoTargets('9000000001')).toBeNull();
    expect(logger.error).toHaveBeenCalledWith('[google-ads] readCampaignGeoTargets failed: quota');
  });

  test('a campaign id that is not digits is refused before any query', async () => {
    expect(await GoogleAds.readCampaignGeoTargets('1 OR campaign.id > 0')).toBeNull();
    expect(await GoogleAds.readCampaignGeoTargets(null)).toBeNull();
    expect(mockCustomer.query).not.toHaveBeenCalled();
  });
});

describe('findPostalGeoTargets', () => {
  const row = (name, id, over = {}) => ({ geo_target_constant: { id, name, canonical_name: `${name},Florida,United States`, status: enums.GeoTargetConstantStatus.ENABLED, ...over } });

  test('asks for US postal codes by name and returns ZIP -> id', async () => {
    mockCustomer.query.mockResolvedValue([row('34202', 9012001), row('34211', 9012002)]);
    expect(await GoogleAds.findPostalGeoTargets(['34202', '34211', '34202'])).toEqual({ 34202: '9012001', 34211: '9012002' });
    expect(oneLine(mockCustomer.query.mock.calls[0][0])).toBe(
      'SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.canonical_name, geo_target_constant.status FROM geo_target_constant '
      + "WHERE geo_target_constant.country_code = 'US' AND geo_target_constant.target_type = 'Postal Code' AND geo_target_constant.name IN ('34202', '34211')",
    );
  });

  test('takes only an enabled target whose canonical name starts with the ZIP it was asked for', async () => {
    mockCustomer.query.mockResolvedValue([
      row('34202', 9012001, { status: enums.GeoTargetConstantStatus.REMOVAL_PLANNED }),
      row('34211', 9012002, { canonical_name: 'Elsewhere,Florida,United States' }),
      row('99999', 9099999),
      row('34219', 9012003),
    ]);
    expect(await GoogleAds.findPostalGeoTargets(['34202', '34211', '34219'])).toEqual({ 34219: '9012003' });
  });

  test('a value that is not a 5-digit ZIP never reaches the query; nothing valid asks nothing', async () => {
    mockCustomer.query.mockResolvedValue([]);
    expect(await GoogleAds.findPostalGeoTargets(["34202' OR 1=1", '3420', '34202-1234', null])).toEqual({});
    expect(await GoogleAds.findPostalGeoTargets([])).toEqual({});
    expect(mockCustomer.query).not.toHaveBeenCalled();
  });

  test('a failed lookup is null', async () => {
    mockCustomer.query.mockRejectedValue(new Error('quota'));
    expect(await GoogleAds.findPostalGeoTargets(['34202'])).toBeNull();
  });
});

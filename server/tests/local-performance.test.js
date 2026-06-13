jest.mock('../models/db', () => jest.fn());
jest.mock('../services/analytics/google-analytics', () => ({ getGbpUtmTraffic: jest.fn() }));

const {
  acceptedEstimateRevenue,
  contentFromLead,
  isGbpUtmCampaign,
} = require('../services/analytics/local-performance')._internals;

describe('local performance helpers', () => {
  test('annualizes accepted estimate revenue without double-counting annual total', () => {
    expect(acceptedEstimateRevenue({
      estimate_status: 'accepted',
      estimate_monthly: '125',
      estimate_annual: '1500',
      estimate_onetime: '99',
    })).toBe(1599);
    expect(acceptedEstimateRevenue({
      estimate_status: 'accepted',
      estimate_monthly: null,
      estimate_annual: '900',
      estimate_onetime: '50',
    })).toBe(950);
    expect(acceptedEstimateRevenue({ estimate_status: 'sent', estimate_monthly: '125' })).toBe(0);
  });

  test('resolves profile content from GBP source rows and nested attribution JSON', () => {
    expect(contentFromLead({ gbp_location_id: '2262372053807555721' })).toBe('sarasota-profile');
    expect(contentFromLead({
      extracted_data: JSON.stringify({
        attribution: { utm: { content: 'venice_profile' } },
      }),
    })).toBe('venice_profile');
  });

  test('classifies existing and alternate GBP UTM traffic', () => {
    expect(isGbpUtmCampaign({ source: 'gbp', medium: 'organic', campaign: 'website-link' })).toBe(true);
    expect(isGbpUtmCampaign({ source: 'google', medium: 'organic', campaign: 'gbp' })).toBe(true);
    expect(isGbpUtmCampaign({ source: 'google', medium: 'cpc', campaign: 'gbp' })).toBe(false);
  });
});

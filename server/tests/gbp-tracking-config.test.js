const {
  WAVES_LOCATIONS,
  findGbpLocationByUtmContent,
  gbpTrackingUrlForLocation,
  isGbpUtmCampaign,
} = require('../config/locations');

describe('GBP tracking config', () => {
  test('builds tagged website URLs for all four profiles', () => {
    expect(WAVES_LOCATIONS).toHaveLength(4);
    for (const loc of WAVES_LOCATIONS) {
      const url = new URL(gbpTrackingUrlForLocation(loc));
      expect(url.hostname).toBe('www.wavespestcontrol.com');
      expect(url.searchParams.get('utm_source')).toBe('gbp');
      expect(url.searchParams.get('utm_medium')).toBe('organic');
      expect(url.searchParams.get('utm_campaign')).toBe('website-link');
      expect(url.searchParams.get('utm_content')).toBe(loc.gbpUtmContent);
    }
  });

  test('matches current and legacy profile content aliases', () => {
    expect(findGbpLocationByUtmContent('sarasota')?.id).toBe('sarasota');
    expect(findGbpLocationByUtmContent('sarasota-profile')?.id).toBe('sarasota');
    expect(findGbpLocationByUtmContent('lakewood_ranch')?.id).toBe('bradenton');
    expect(findGbpLocationByUtmContent('lwr')?.id).toBe('bradenton');
  });

  test('recognizes existing and alternate GBP UTM campaigns', () => {
    expect(isGbpUtmCampaign({ source: 'gbp', medium: 'organic', campaign: 'website-link' })).toBe(true);
    expect(isGbpUtmCampaign({ source: 'google', medium: 'organic', campaign: 'gbp' })).toBe(true);
    expect(isGbpUtmCampaign({ source: 'google', medium: 'cpc', campaign: 'gbp' })).toBe(false);
  });
});

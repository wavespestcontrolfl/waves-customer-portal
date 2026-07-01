jest.mock('../models/db', () => jest.fn());
jest.mock('../config/locations', () => ({
  isGbpUtmCampaign: jest.fn(() => false),
  findGbpLocationByUtmContent: jest.fn(() => null),
}));

const db = require('../models/db');
const { isGbpUtmCampaign, findGbpLocationByUtmContent } = require('../config/locations');
const { resolveLeadSource, MAIN_SITE_NAME } = require('../services/lead-source-resolver');

// Mock lead_sources lookups: the resolver hits exactly one of
//   .whereRaw("LOWER(name) LIKE '%facebook%'").first()   (meta)
//   .where({ source_type: 'google_ads' }).first()        (google paid)
//   .where({ name }).first()                              (everything else)
function mockLeadSources({ facebook = null, google = null, byName = {} } = {}) {
  db.mockImplementation(() => ({
    whereRaw: () => ({ first: async () => facebook }),
    where: (clause) => ({
      first: async () => {
        if (clause && clause.source_type === 'google_ads') return google;
        if (clause && clause.name) return byName[clause.name] || null;
        return null;
      },
    }),
  }));
}

describe('resolveLeadSource', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isGbpUtmCampaign.mockReturnValue(false);
    findGbpLocationByUtmContent.mockReturnValue(null);
  });

  test('classifies a Google Ads click (gclid only, no UTMs) as Google Ads — not Main Site', async () => {
    mockLeadSources({
      google: { id: 'ls-google', name: 'Google Ads — Pest (call-extension)', source_type: 'google_ads' },
      byName: { [MAIN_SITE_NAME]: { id: 'ls-main', name: MAIN_SITE_NAME } },
    });

    const res = await resolveLeadSource({
      gclid: 'g-click-1',
      landing_url: 'https://wavespestcontrol.com/book?gclid=g-click-1',
      referrer: 'https://www.google.com/',
    });

    expect(res.leadSourceId).toBe('ls-google');
    expect(res.leadSourceDetail).toBe('Google Ads click (gclid)');
    expect(res.leadSourceId).not.toBe('ls-main'); // the bug being fixed
  });

  test('classifies wbraid/gbraid iOS clicks as Google Ads too', async () => {
    mockLeadSources({ google: { id: 'ls-google', source_type: 'google_ads' } });

    expect((await resolveLeadSource({ wbraid: 'w1' })).leadSourceId).toBe('ls-google');
    expect((await resolveLeadSource({ gbraid: 'b1' })).leadSourceId).toBe('ls-google');
  });

  test('classifies utm_source=google&utm_medium=cpc as Google Ads', async () => {
    mockLeadSources({ google: { id: 'ls-google', source_type: 'google_ads' } });

    const res = await resolveLeadSource({ utm: { source: 'google', medium: 'cpc', campaign: 'pest-brand' } });
    expect(res.leadSourceId).toBe('ls-google');
  });

  test('still classifies a Meta click as Facebook', async () => {
    mockLeadSources({ facebook: { id: 'ls-fb', name: 'Facebook Ads — Pest (call-extension)' } });

    const res = await resolveLeadSource({ fbclid: 'fb-1', landing_url: 'https://wavespestcontrol.com/book?fbclid=fb-1' });
    expect(res.leadSourceId).toBe('ls-fb');
    expect(res.leadSourceDetail).toBe('Meta click (fbclid)');
  });

  test('falls back to Main Site for untracked organic traffic', async () => {
    mockLeadSources({ byName: { [MAIN_SITE_NAME]: { id: 'ls-main', name: MAIN_SITE_NAME } } });

    const res = await resolveLeadSource({ referrer: 'https://duckduckgo.com/' });
    expect(res.leadSourceId).toBe('ls-main');
  });

  test('GBP utm campaign still wins over a stray click id', async () => {
    isGbpUtmCampaign.mockReturnValue(true);
    findGbpLocationByUtmContent.mockReturnValue({ name: 'Parrish', gbpUtmContent: 'parrish-profile' });
    mockLeadSources({
      google: { id: 'ls-google', source_type: 'google_ads' },
      byName: { 'GBP — Parrish': { id: 'ls-gbp-parrish', name: 'GBP — Parrish' } },
    });

    const res = await resolveLeadSource({ gclid: 'g1', utm: { source: 'gbp', content: 'parrish-profile' } });
    expect(res.leadSourceId).toBe('ls-gbp-parrish');
  });
});

// ---------------------------------------------------------------------------
// sourceType — the lead_sources.source_type key the ad-funnel channel map
// (ads/call-attribution attributionForSourceType) is keyed on. public-quote
// stamps its ad_service_attribution row from this, so a wrong/missing value
// means a wizard lead is mis-channeled or silently dropped from the funnel.
// ---------------------------------------------------------------------------
describe('resolveLeadSource sourceType', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isGbpUtmCampaign.mockReturnValue(false);
    findGbpLocationByUtmContent.mockReturnValue(null);
  });

  test('passes through the resolved row source_type (main_site)', async () => {
    mockLeadSources({ byName: { [MAIN_SITE_NAME]: { id: 'ls-main', name: MAIN_SITE_NAME, source_type: 'main_site' } } });
    const res = await resolveLeadSource({ landing_url: 'https://wavespestcontrol.com/quote' });
    expect(res.sourceType).toBe('main_site');
  });

  test('passes through spoke_site for a spoke referrer', async () => {
    mockLeadSources({
      byName: {
        'Spoke Pest — parrishpestcontrol.com': { id: 'ls-spoke', name: 'Spoke Pest — parrishpestcontrol.com', source_type: 'spoke_site' },
      },
    });
    const res = await resolveLeadSource({ referrer: 'https://www.parrishpestcontrol.com/services' });
    expect(res.sourceType).toBe('spoke_site');
  });

  test('paid Google click keeps google_ads even when no lead_sources row exists', async () => {
    mockLeadSources({ google: null });
    const res = await resolveLeadSource({ gclid: 'g-1' });
    expect(res.leadSourceId).toBeNull();
    expect(res.sourceType).toBe('google_ads');
  });

  test('paid Meta click keeps facebook even when no lead_sources row exists', async () => {
    mockLeadSources({ facebook: null });
    const res = await resolveLeadSource({ fbclid: 'fb-1' });
    expect(res.sourceType).toBe('facebook');
  });

  test('no row and no paid signal → null (fail-closed: no funnel row)', async () => {
    mockLeadSources({ byName: {} });
    const res = await resolveLeadSource({ referrer: 'https://duckduckgo.com/' });
    expect(res.sourceType).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isPaidClick — paid evidence for THIS visit (click id or explicit cpc).
// Pre-push P1: metaPaid classifies any utm_source=facebook into the Facebook
// channel, whose funnel-map entry is paid — organic social must not inherit it.
// ---------------------------------------------------------------------------
describe('resolveLeadSource isPaidClick', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isGbpUtmCampaign.mockReturnValue(false);
    findGbpLocationByUtmContent.mockReturnValue(null);
    mockLeadSources({
      google: { id: 'ls-google', source_type: 'google_ads' },
      facebook: { id: 'ls-fb', name: 'Facebook Ads', source_type: 'facebook' },
    });
  });

  test('true for Google click ids and google/cpc', async () => {
    expect((await resolveLeadSource({ gclid: 'g1' })).isPaidClick).toBe(true);
    expect((await resolveLeadSource({ wbraid: 'w1' })).isPaidClick).toBe(true);
    expect((await resolveLeadSource({ utm: { source: 'google', medium: 'cpc' } })).isPaidClick).toBe(true);
  });

  test('true for Meta click ids and facebook/cpc', async () => {
    expect((await resolveLeadSource({ fbclid: 'f1' })).isPaidClick).toBe(true);
    expect((await resolveLeadSource({ fbc: 'fb.1.123.f1' })).isPaidClick).toBe(true);
    expect((await resolveLeadSource({ utm: { source: 'facebook', medium: 'cpc' } })).isPaidClick).toBe(true);
  });

  test('FALSE for organic facebook utm — channel facebook, but not paid', async () => {
    const res = await resolveLeadSource({ utm: { source: 'facebook', medium: 'social' } });
    expect(res.sourceType).toBe('facebook'); // still the Facebook channel
    expect(res.isPaidClick).toBe(false);     // but no paid evidence
  });

  test('FALSE for plain organic traffic', async () => {
    expect((await resolveLeadSource({ referrer: 'https://duckduckgo.com/' })).isPaidClick).toBe(false);
  });
});

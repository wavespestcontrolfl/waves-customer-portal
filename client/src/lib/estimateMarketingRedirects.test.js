import { describe, expect, it } from 'vitest';
import {
  ESTIMATE_MARKETING_REDIRECTS,
  ESTIMATE_QUOTE_URL,
  SERVICE_ESTIMATE_SLUGS,
} from './estimateMarketingRedirects';
import { isPublicFunnelPath, isTokenizedEstimatePath } from './analytics/posthog';

describe('estimate marketing route retirement', () => {
  it('keeps the client fallback destinations aligned with the website estimators', () => {
    expect(ESTIMATE_QUOTE_URL).toBe('https://www.wavespestcontrol.com/quote/');
    expect(ESTIMATE_MARKETING_REDIRECTS).toMatchObject({
      mosquito: 'https://www.wavespestcontrol.com/estimate/mosquito-control/',
      termite: 'https://www.wavespestcontrol.com/estimate/termite-treatment/',
      lawn: 'https://www.wavespestcontrol.com/estimate/lawn-care/',
      overseeding: 'https://www.wavespestcontrol.com/estimate/lawn-care/',
    });
    expect(SERVICE_ESTIMATE_SLUGS).toEqual(new Set(Object.keys(ESTIMATE_MARKETING_REDIRECTS)));
  });

  it('does not boot portal funnel tracking on paths that immediately leave for the website', () => {
    expect(isPublicFunnelPath('/estimate')).toBe(false);
    expect(isPublicFunnelPath('/estimate/mosquito')).toBe(false);
    expect(isPublicFunnelPath('/quote')).toBe(false);
    expect(isPublicFunnelPath('/book')).toBe(true);
  });

  it('preserves the privacy classification of real customer estimate tokens', () => {
    expect(isTokenizedEstimatePath('/estimate/0123456789abcdef0123456789abcdef')).toBe(true);
    expect(isTokenizedEstimatePath('/estimate/jane-doe-9f8e7d6c')).toBe(true);
    expect(isTokenizedEstimatePath('/estimate/mosquito')).toBe(false);
  });
});

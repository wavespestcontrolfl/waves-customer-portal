const {
  ESTIMATE_MARKETING_REDIRECTS,
  SERVICE_ESTIMATE_SLUGS,
  estimateMarketingRedirectTarget,
  preserveOriginalQuery,
} = require('../config/estimate-marketing-redirects');

describe('estimate marketing redirects', () => {
  test('maps every retired portal marketing page to its canonical website page', () => {
    expect(ESTIMATE_MARKETING_REDIRECTS).toEqual({
      '/estimate': 'https://www.wavespestcontrol.com/quote/',
      '/quote': 'https://www.wavespestcontrol.com/quote/',
      '/estimate/mosquito': 'https://www.wavespestcontrol.com/estimate/mosquito-control/',
      '/estimate/termite': 'https://www.wavespestcontrol.com/estimate/termite-treatment/',
      '/estimate/lawn': 'https://www.wavespestcontrol.com/estimate/lawn-care/',
      '/estimate/flea': 'https://www.wavespestcontrol.com/estimate/flea-treatment/',
      '/estimate/cockroach': 'https://www.wavespestcontrol.com/estimate/cockroach-control/',
      '/estimate/bed-bug': 'https://www.wavespestcontrol.com/estimate/bed-bug-treatment/',
      '/estimate/dethatching': 'https://www.wavespestcontrol.com/estimate/lawn-dethatching/',
      '/estimate/dehatching': 'https://www.wavespestcontrol.com/estimate/lawn-dethatching/',
      '/estimate/top-dressing': 'https://www.wavespestcontrol.com/estimate/lawn-top-dressing/',
      '/estimate/overseeding': 'https://www.wavespestcontrol.com/estimate/lawn-care/',
    });
    expect(SERVICE_ESTIMATE_SLUGS).toEqual(new Set([
      'mosquito', 'termite', 'lawn', 'flea', 'cockroach', 'bed-bug',
      'dethatching', 'dehatching', 'top-dressing', 'overseeding',
    ]));
  });

  test('normalizes case and trailing slashes while preserving campaign parameters', () => {
    expect(estimateMarketingRedirectTarget('/ESTIMATE/MOSQUITO/'))
      .toBe('https://www.wavespestcontrol.com/estimate/mosquito-control/');
    expect(preserveOriginalQuery(
      'https://www.wavespestcontrol.com/quote/',
      '/estimate?utm_source=google&gclid=abc',
    )).toBe('https://www.wavespestcontrol.com/quote/?utm_source=google&gclid=abc');
  });

  test('never redirects unknown segments because they may be customer estimate tokens', () => {
    expect(estimateMarketingRedirectTarget('/estimate/0123456789abcdef0123456789abcdef')).toBeNull();
    expect(estimateMarketingRedirectTarget('/estimate/jane-doe-9f8e7d6c')).toBeNull();
  });
});

const UrlIntelligence = require('../services/seo/url-intelligence');

describe('UrlIntelligence.diagnoseUrl HTTP status handling', () => {
  function record(overrides = {}) {
    return {
      in_sitemap: false,
      coverage_state: null,
      canonical_match: true,
      body_similarity_max: null,
      status_code: null,
      technical_qa_score: null,
      gsc_impressions_28d: 0,
      gsc_clicks_28d: 0,
      _has_cannibalization: false,
      _has_decay_alerts: false,
      gsc_avg_position_28d: null,
      gsc_ctr_28d: null,
      word_count: null,
      page_type: null,
      content_hash: 'hash',
      internal_links_in: 3,
      last_audit_at: null,
      ...overrides,
    };
  }

  test('classifies zero-traffic 404 and 410 URLs as low_value', () => {
    expect(UrlIntelligence.diagnoseUrl(record({ status_code: 404 }))).toBe('low_value');
    expect(UrlIntelligence.diagnoseUrl(record({ status_code: 410 }))).toBe('low_value');
  });

  test('keeps 404 and 410 URLs with GSC traffic as technical_performance', () => {
    expect(UrlIntelligence.diagnoseUrl(record({ status_code: 404, gsc_impressions_28d: 1 })))
      .toBe('technical_performance');
    expect(UrlIntelligence.diagnoseUrl(record({ status_code: 410, gsc_clicks_28d: 1 })))
      .toBe('technical_performance');
  });

  test('keeps other HTTP errors as technical_performance even without traffic', () => {
    expect(UrlIntelligence.diagnoseUrl(record({ status_code: 403 }))).toBe('technical_performance');
    expect(UrlIntelligence.diagnoseUrl(record({ status_code: 500 }))).toBe('technical_performance');
    expect(UrlIntelligence.diagnoseUrl(record({ status_code: 503 }))).toBe('technical_performance');
  });
});

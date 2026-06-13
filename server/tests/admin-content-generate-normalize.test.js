jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { normalizeBlogUpdates, normalizeGenerateBody } = require('../routes/admin-content-v2');

describe('admin content generation normalization', () => {
  test('allows Palmetto as a supported target city', () => {
    expect(normalizeGenerateBody({
      topic: 'Palmetto ant pressure',
      targetCity: 'Palmetto',
    })).toEqual({
      topic: 'Palmetto ant pressure',
      contentType: 'blog_post',
      targetCity: 'Palmetto',
    });
  });

  test('pins blog target_sites to the hub and rejects unsupported domains', () => {
    expect(normalizeBlogUpdates({
      target_sites: ['https://www.wavespestcontrol.com/blog/', 'palmettoflpestcontrol.com'],
    })).toEqual({
      target_sites: ['wavespestcontrol.com'],
    });

    expect(normalizeBlogUpdates({
      target_sites: [],
    })).toEqual({
      target_sites: ['wavespestcontrol.com'],
    });

    expect(() => normalizeBlogUpdates({
      target_sites: ['https://example.com/blog/'],
    })).toThrow(/unsupported domains: example\.com/);
  });
});

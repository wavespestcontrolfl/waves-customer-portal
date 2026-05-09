jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { normalizeGenerateBody } = require('../routes/admin-content-v2');

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
});

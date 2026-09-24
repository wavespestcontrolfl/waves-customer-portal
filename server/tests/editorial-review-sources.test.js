'use strict';

const mockFetchPage = jest.fn();
jest.mock('../services/seo/contact-finder', () => ({ fetchPage: (...args) => mockFetchPage(...args) }));
const { LIMITS } = require('../services/content/editorial-review-contracts');
const { fetchSources, normalizeRequestedSources } = require('../services/content/editorial-review-sources');

afterEach(() => mockFetchPage.mockReset());

test('deduplicates fragment variants before fetching source pages', () => {
  expect(normalizeRequestedSources([
    'https://example.gov/article#first',
    'https://example.gov/article#second',
  ])).toEqual({ urls: ['https://example.gov/article'], errors: [] });
});

test('retrieves all short sources within the total evidence budget', async () => {
  mockFetchPage.mockImplementation(async (url) => ({ status: 200, finalUrl: url, contentType: 'text/html', html: '<p>Short evidence.</p>' }));
  const result = await fetchSources(Array.from({ length: 8 }, (_, index) => `https://example.gov/${index}`));
  expect(result).toMatchObject({ errors: [], records: expect.arrayContaining([expect.objectContaining({ excerpt: 'Short evidence.' })]) });
  expect(result.records).toHaveLength(8);
});

test('stops fetching once the total evidence budget is exhausted', async () => {
  mockFetchPage.mockImplementation(async (url) => ({
    status: 200,
    finalUrl: url,
    contentType: 'text/html',
    html: `<p>${'x'.repeat(LIMITS.sourceChars)}</p>`,
  }));

  const result = await fetchSources(Array.from({ length: LIMITS.sourceUrls }, (_, index) => `https://example.gov/${index}`));

  expect(mockFetchPage).toHaveBeenCalledTimes(LIMITS.totalSourceChars / LIMITS.sourceChars);
  expect(result.records).toHaveLength(LIMITS.totalSourceChars / LIMITS.sourceChars);
  expect(result.errors).toContain(`Total source evidence exceeds ${LIMITS.totalSourceChars} characters.`);
});

'use strict';

const mockFetchPage = jest.fn();
jest.mock('../services/seo/contact-finder', () => ({ fetchPage: (...args) => mockFetchPage(...args) }));
const { fetchSources } = require('../services/content/editorial-review-sources');

test('retrieves all short sources within the total evidence budget', async () => {
  mockFetchPage.mockImplementation(async (url) => ({ status: 200, finalUrl: url, contentType: 'text/html', html: '<p>Short evidence.</p>' }));
  const result = await fetchSources(Array.from({ length: 8 }, (_, index) => `https://example.gov/${index}`));
  expect(result).toMatchObject({ errors: [], records: expect.arrayContaining([expect.objectContaining({ excerpt: 'Short evidence.' })]) });
  expect(result.records).toHaveLength(8);
});

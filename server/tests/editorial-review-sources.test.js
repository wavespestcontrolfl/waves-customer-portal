'use strict';

const mockFetchPage = jest.fn();
jest.mock('../services/seo/contact-finder', () => ({ fetchPage: (...args) => mockFetchPage(...args) }));
const { LIMITS } = require('../services/content/editorial-review-contracts');
const {
  fetchSources,
  htmlText,
  normalizeRequestedSources,
  publisherOf,
} = require('../services/content/editorial-review-sources');

afterEach(() => mockFetchPage.mockReset());

test('deduplicates fragment variants before fetching source pages', () => {
  expect(normalizeRequestedSources([
    'https://example.gov/article#first',
    'https://example.gov/article#second',
  ])).toEqual({ urls: ['https://example.gov/article'], errors: [] });
});

test('strips unterminated noise blocks through the end of truncated HTML', () => {
  expect(htmlText('<p>Useful evidence.</p><script>window.__DATA__ = "noise";')).toBe('Useful evidence.');
});

test('falls back to the hostname when publisher metadata cleans to empty', () => {
  expect(publisherOf('<meta property="og:site_name" content="&nbsp;">', 'https://www.example.gov/article')).toBe('example.gov');
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

test('deduplicates records that redirect to the same final page', async () => {
  mockFetchPage.mockImplementation(async (url) => ({
    status: 200,
    finalUrl: url.endsWith('/third') ? 'https://example.gov/distinct' : 'https://example.gov/article#section',
    contentType: 'text/html',
    html: '<p>Evidence.</p>',
  }));

  const result = await fetchSources([
    'https://short.example/first',
    'https://short.example/second',
    'https://short.example/third',
  ]);

  expect(result.records.map(({ url }) => url)).toEqual([
    'https://example.gov/article',
    'https://example.gov/distinct',
  ]);
});

test('rejects non-text media types even when a parameter contains text', async () => {
  mockFetchPage.mockResolvedValue({
    status: 200,
    finalUrl: 'https://example.gov/download',
    contentType: 'application/octet-stream; filename="text.bin"',
    html: 'binary payload',
  });

  const result = await fetchSources(['https://example.gov/download']);

  expect(result.records).toEqual([]);
  expect(result.errors).toEqual(['Source content type is not reviewable text: https://example.gov/download']);
});

test('preserves angle brackets in accepted plain-text evidence', async () => {
  mockFetchPage.mockResolvedValue({
    status: 200,
    finalUrl: 'https://example.gov/range.txt',
    contentType: 'text/plain; charset=utf-8',
    html: 'x < 5 and y > 3',
  });

  const result = await fetchSources(['https://example.gov/range.txt']);

  expect(result.records[0].excerpt).toBe('x < 5 and y > 3');
});

test('rejects HTML challenge interstitials as source evidence', async () => {
  mockFetchPage.mockResolvedValue({
    status: 200,
    finalUrl: 'https://example.gov/article',
    contentType: 'text/html',
    html: '<html><title>Just a moment</title><body><div class="cf-chl">Checking your browser</div></body></html>',
  });

  const result = await fetchSources(['https://example.gov/article']);

  expect(result.records).toEqual([]);
  expect(result.errors).toEqual(['Source returned a challenge page: https://example.gov/article']);
});

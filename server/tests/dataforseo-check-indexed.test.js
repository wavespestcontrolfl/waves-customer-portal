const { DataForSEO, _test } = require('../services/seo/dataforseo');

describe('DataForSEO checkIndexed', () => {
  test('returns unknown when request has no task result', async () => {
    const client = new DataForSEO();
    client.request = jest.fn().mockResolvedValue(null);

    await expect(client.checkIndexed('https://example.com/resource')).resolves.toBe('unknown');
  });

  test('returns not_indexed only when a real result set omits the URL', async () => {
    const client = new DataForSEO();
    client.request = jest.fn().mockResolvedValue({
      tasks: [{ result: [{ items: [{ url: 'https://other.example.com/' }] }] }],
    });

    await expect(client.checkIndexed('https://example.com/resource')).resolves.toBe('not_indexed');
  });

  test('does not treat sibling URL prefixes as the checked indexed URL', async () => {
    const client = new DataForSEO();
    client.request = jest.fn().mockResolvedValue({
      tasks: [{ result: [{ items: [{ url: 'https://example.com/page-2' }] }] }],
    });

    await expect(client.checkIndexed('https://example.com/page')).resolves.toBe('not_indexed');
  });

  test('allows exact matches and true URL boundaries', () => {
    expect(_test.hasUrlBoundary('example.com/page?ref=google', 'example.com/page')).toBe(true);
    expect(_test.hasUrlBoundary('example.com/page#section', 'example.com/page')).toBe(true);
    expect(_test.hasUrlBoundary('example.com/page/child', 'example.com/page')).toBe(true);
    expect(_test.hasUrlBoundary('example.com/page-2', 'example.com/page')).toBe(false);
  });
});

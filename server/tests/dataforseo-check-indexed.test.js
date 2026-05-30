const { DataForSEO } = require('../services/seo/dataforseo');

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
});
